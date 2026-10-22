import type { ModelAdapter } from '../types.js'
import type { FactNode } from './types.js'
import { GraphStore } from './graph-store.js'
import { VectorStore, cosineSimilarity } from './vector-store.js'
import { extractJsonObject } from './json-util.js'
import { tokenize } from './filesystem.js'

const FULL_MERGE = 0.95        // = CogMem fact_high_threshold
const CONFLICT_CANDIDATE = 0.80
const isActive = (f: FactNode) => (f.lifecycle ?? 'stable') !== 'archived' && f.is_latest !== false
const normPred = (p: string) => p.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^(is_|has_)/, '')
const rank = (f: FactNode) => [f.lifecycle === 'stable' ? 1 : 0, f.valid_from ?? f.created_at, f.confidence, f.supported_by_event_ids.length] as const

/**
 * = CogMem FactDeduplicator + ClaimReconciler（事实部分）
 *
 * 完全合并（相似度 ≥ 0.95 或三元组相同）：转移 SUPPORTED_BY 和属性边，删除源节点及其向量。
 * 版本链（同主体同谓词、相似度 ≥ 0.80）：新事实 SUPERSEDES 旧事实，旧事实归档、移出向量索引。
 * 冲突判断由 LLM 批量确认，避免靠阈值抓不到的低相似度冲突。
 */
export class FactReconciler {
  constructor(
    private readonly graph: GraphStore,
    private readonly vectors: VectorStore,
    private readonly model: ModelAdapter | null,
  ) {}

  /** 只检查本轮新增或更新的 Fact，与同主体的活跃 Fact 比较，复杂度为 O(新事实数 × 同主体事实数) */
  async reconcile(touchedIds: string[]): Promise<{ merged: number; superseded: number }> {
    let merged = 0
    const pairs: Array<[FactNode, FactNode]> = []
    for (const id of new Set(touchedIds)) {
      const f = this.graph.getNode(id)
      if (f?.node_type !== 'fact' || !isActive(f)) continue
      for (const g of this.activeFactsOf(f)) {
        if (g.node_id === f.node_id) continue
        const sim = this.similarity(f, g)
        const samePred = normPred(f.predicate) === normPred(g.predicate)
        const sameObj = (f.object_id ?? f.object.toLowerCase()) === (g.object_id ?? g.object.toLowerCase())
        if ((samePred && sameObj) || sim >= FULL_MERGE) {
          const [keep, drop] = this.pickCanonical(f, g)
          this.merge(drop, keep); merged++
          if (drop === f) break
        } else if (samePred || sim >= CONFLICT_CANDIDATE) {
          pairs.push((f.valid_from ?? f.created_at) >= (g.valid_from ?? g.created_at) ? [f, g] : [g, f])
        }
      }
    }
    let superseded = 0
    for (const [newer, older] of await this.confirmConflicts(pairs)) { this.supersede(newer, older); superseded++ }
    return { merged, superseded }
  }

  private activeFactsOf(f: FactNode): FactNode[] {
    const key = f.subject_id ?? f.subject.toLowerCase()
    return this.graph.getNodesByType<FactNode>('fact').filter(g => isActive(g) && (g.subject_id ?? g.subject.toLowerCase()) === key)
  }

  private similarity(a: FactNode, b: FactNode): number {
    const va = this.vectors.getVector(a.node_id), vb = this.vectors.getVector(b.node_id)
    if (va && vb) return cosineSimilarity(va, vb)
    const ta = new Set(tokenize(a.embedding_text)), tb = new Set(tokenize(b.embedding_text))
    let inter = 0; for (const t of ta) if (tb.has(t)) inter++
    return inter / Math.max(1, ta.size + tb.size - inter)
  }

  /** = CogMem _select_canonical_fact：stable 优先，其次 valid_from 较新、置信度高、支撑证据多 */
  private pickCanonical(a: FactNode, b: FactNode): [FactNode, FactNode] {
    const ra = rank(a), rb = rank(b)
    for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i] > rb[i] ? [a, b] : [b, a]
    return [a, b]
  }

  /** = CogMem _fully_merge_fact：转移 SUPPORTED_BY 和属性边，删除源节点及其向量 */
  private merge(drop: FactNode, keep: FactNode) {
    const now = new Date().toISOString()
    for (const e of this.graph.getOutEdges(drop.node_id, 'SUPPORTED_BY')) this.graph.addEdge({ ...e, source_id: keep.node_id, created_at: now })
    for (const e of this.graph.getInEdges(drop.node_id, 'HAS_ATTRIBUTE')) this.graph.addEdge({ ...e, target_id: keep.node_id, created_at: now })
    keep.supported_by_event_ids = [...new Set([...keep.supported_by_event_ids, ...drop.supported_by_event_ids])].slice(0, 5)
    keep.derived_from_event_ids = [...new Set([...(keep.derived_from_event_ids ?? []), ...(drop.derived_from_event_ids ?? [])])]
    keep.source_sessions = [...new Set([...(keep.source_sessions ?? []), ...(drop.source_sessions ?? [])])]
    keep.evidence = [...new Set([...(keep.evidence ?? []), ...(drop.evidence ?? [])])].slice(0, 3)
    keep.confidence = Math.max(keep.confidence, drop.confidence)
    keep.updated_at = now
    this.graph.removeNode(drop.node_id)
    this.vectors.remove(drop.node_id)
  }

  /** = CogMem SUPERSEDES 版本链：旧事实保留在图中供追溯，但移出向量索引、不参与默认检索 */
  private supersede(newer: FactNode, older: FactNode) {
    const now = new Date().toISOString()
    this.graph.addEdge({ source_id: newer.node_id, target_id: older.node_id, edge_type: 'SUPERSEDES', weight: 1, created_at: now })
    Object.assign(older, { lifecycle: 'archived', is_latest: false, valid_to: newer.valid_from ?? now.slice(0, 10), updated_at: now })
    newer.is_latest = true
    this.vectors.remove(older.node_id)
  }

  private async confirmConflicts(pairs: Array<[FactNode, FactNode]>): Promise<Array<[FactNode, FactNode]>> {
    if (!this.model || pairs.length === 0) return []
    const list = pairs.slice(0, 10)
    const body = list.map(([n, o], i) => `${i}. NEW: ${n.description}\n   OLD: ${o.description}`).join('\n')
    try {
      const res = await this.model.next([
        { role: 'system', content: 'For each pair, decide whether NEW makes OLD no longer true (an update of the same attribute, e.g. switched tool/version/convention). Compatible or unrelated facts are NOT conflicts. Return JSON only: {"conflicts":[<indices>]}' },
        { role: 'user', content: body },
      ], {})
      if (res.type !== 'assistant') return []
      const d = extractJsonObject(res.content) as { conflicts?: unknown[] } | null
      return (d?.conflicts ?? []).filter((i): i is number => Number.isInteger(i) && !!list[i as number]).map(i => list[i])
    } catch { return [] }
  }
}
