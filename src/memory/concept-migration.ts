import { GraphStore } from './graph-store.js'
import type { ClaimNode, ConceptNode, EventNode, FactNode, GraphEdge } from './types.js'
import { isLowValueConceptName, normalizeConceptName, stableId } from './graph-ids.js'

/** 概念层清洗结果；changed=false 表示图已是规范形态，无需落盘 */
export interface ConceptMigrationReport {
  changed: boolean
  removedLowValue: number       // 删除的低价值概念节点数
  merged: number                // 被合并掉的重复概念节点数
  renamed: number               // 迁移到规范 id 的概念节点数
  droppedFacts: number          // 因概念被删/悬空而整条删除的 fact
  unlinkedClaims: number        // 摘除 target 链接的 claim
  dedupedFacts: number          // 合并后 (subject, predicate, object) 碰撞而去重的 fact
  dedupedClaims: number         // 合并后 (source, target, content) 碰撞而去重的 claim
  staleVectorIds: string[]      // 已消失节点的 node_id，调用方应删除对应向量
  refreshedVectors: { id: string; text: string }[]  // id 未变但 embedding_text 变化，需重建向量
}

interface GroupPlan {
  survivor: ConceptNode
  canonicalId: string
  oldIds: string[]              // 组内全部节点的旧 node_id（含改名的 survivor）
}

/**
 * 存量图谱的概念层清洗（幂等，启动时调用）。
 *
 * 早期版本没有低价值概念过滤，且概念名归一化不统一连字符/空格，导致图中沉淀了
 * 测量值/日期/引文式概念，以及 "git-history" 与 "git history" 这类重复节点。
 * 本迁移把存量数据对齐到当前抽取策略：
 * 1. 低价值概念删除；引用它的 fact 整条删除（与 extractor 的跳过策略一致）、
 *    claim 只摘 target 链接、event 从 concepts 中移除；
 * 2. 归一化后同名的概念合并为一个节点（id = stableId('concept', norm)），
 *    aliases/mention_count/证据取并集，描述取第一个非占位符的；
 * 3. 合并/改名后重接全部边与节点字段里的引用，并去重因此碰撞的 fact/claim。
 */
export function migrateConceptLayer(graph: GraphStore, now = new Date().toISOString()): ConceptMigrationReport {
  const report: ConceptMigrationReport = {
    changed: false, removedLowValue: 0, merged: 0, renamed: 0, droppedFacts: 0,
    unlinkedClaims: 0, dedupedFacts: 0, dedupedClaims: 0,
    staleVectorIds: [], refreshedVectors: [],
  }

  // ---- 1. 按新规则重新归一化，低价值概念直接删除 ----
  const removed = new Set<string>()
  const groups = new Map<string, ConceptNode[]>()
  for (const c of graph.getNodesByType<ConceptNode>('concept')) {
    const norm = normalizeConceptName(c.name)
    if (norm.length < 2 || isLowValueConceptName(norm)) { removed.add(c.node_id); continue }
    const list = groups.get(norm)
    if (list) list.push(c); else groups.set(norm, [c])
  }

  if (removed.size > 0) {
    for (const id of removed) { graph.removeNode(id); report.staleVectorIds.push(id); report.removedLowValue++ }
    for (const f of graph.getNodesByType<FactNode>('fact')) {
      if ((f.subject_id !== undefined && removed.has(f.subject_id)) || (f.object_id !== undefined && removed.has(f.object_id))) {
        graph.removeNode(f.node_id); report.staleVectorIds.push(f.node_id); report.droppedFacts++
      }
    }
    for (const c of graph.getNodesByType<ClaimNode>('claim')) {
      if (c.target_id !== undefined && removed.has(c.target_id)) { delete c.target_id; c.updated_at = now; report.unlinkedClaims++ }
    }
  }

  // ---- 2. 同名组合并：先规划（合并内容 + 记录 id 映射），后做图手术 ----
  const isPlaceholder = (n: ConceptNode) => !n.description || n.description === n.name
  const remap = new Map<string, string>()   // 旧 node_id → 存活 node_id
  const plans: GroupPlan[] = []

  for (const [norm, nodes] of groups) {
    const canonicalId = stableId('concept', norm)
    if (nodes.length === 1 && nodes[0]!.node_id === canonicalId) continue          // 已是规范形态

    const survivor = [...nodes].sort((a, b) => {
      const byCanonical = (a.node_id === canonicalId ? 1 : 0) - (b.node_id === canonicalId ? 1 : 0)
      if (byCanonical !== 0) return -byCanonical
      const byDesc = (isPlaceholder(a) ? 0 : 1) - (isPlaceholder(b) ? 0 : 1)
      if (byDesc !== 0) return -byDesc
      return (b.mention_count ?? 0) - (a.mention_count ?? 0)
    })[0]!
    const losers = nodes.filter(n => n !== survivor)
    const idChanged = survivor.node_id !== canonicalId
    // 必须在改写 survivor.node_id 之前捕获旧 id，否则旧 id 的注册项永远无法删除
    const oldIds = nodes.map(n => n.node_id)
    if (idChanged) report.renamed++
    report.merged += losers.length

    // 内容合并：aliases 去重并集（保留大小写等原始写法，与 extractor 行为一致）、
    // mention_count 求和、描述取非占位符、证据/会话取并集
    const aliasLower = new Set<string>()
    const aliases: string[] = []
    const addAlias = (a?: string) => {
      if (!a) return
      const low = a.toLowerCase()
      if (aliasLower.has(low)) return
      aliasLower.add(low); aliases.push(a)
    }
    const evidence: string[] = [], sessions: string[] = []
    let mentions = 0
    for (const n of [survivor, ...losers]) {
      if (n.name !== norm) addAlias(n.name)
      for (const a of n.aliases ?? []) addAlias(a)
      mentions += n.mention_count ?? 0
      for (const ev of n.evidence ?? []) if (ev && !evidence.includes(ev) && evidence.length < 3) evidence.push(ev)
      for (const s of n.source_sessions ?? []) if (!sessions.includes(s)) sessions.push(s)
    }
    const desc = !isPlaceholder(survivor)
      ? survivor.description
      : losers.find(n => !isPlaceholder(n))?.description ?? survivor.description

    const oldText = survivor.embedding_text
    survivor.node_id = canonicalId
    survivor.name = norm
    survivor.aliases = aliases
    survivor.mention_count = mentions
    if (desc) survivor.description = desc
    survivor.embedding_text = `Concept: ${norm}. ${survivor.description}`
    survivor.updated_at = now
    if (evidence.length) survivor.evidence = evidence
    if (sessions.length) survivor.source_sessions = sessions
    if (!idChanged && survivor.embedding_text !== oldText) {
      report.refreshedVectors.push({ id: canonicalId, text: survivor.embedding_text })
    }

    for (const id of oldIds) {
      if (id !== canonicalId) { report.staleVectorIds.push(id); remap.set(id, canonicalId) }
    }
    plans.push({ survivor, canonicalId, oldIds })
  }

  // 图手术：先收集组内全部旧节点的边，统一删除后以规范 id 重新加入并按映射重接
  for (const plan of plans) {
    const captured: GraphEdge[] = []
    for (const id of plan.oldIds) captured.push(...graph.getEdgesFor(id))
    for (const id of plan.oldIds) graph.removeNode(id)
    graph.addNode(plan.survivor)
    for (const e of captured) {
      const source = remap.get(e.source_id) ?? e.source_id
      const target = remap.get(e.target_id) ?? e.target_id
      if (source === target) continue                          // 合并产生的自环无意义
      graph.addEdge({ ...e, source_id: source, target_id: target })
    }
  }

  // ---- 3. 节点字段里的引用重接 + 悬空引用清理 ----
  const alive = (id: string) => graph.getNode(id) !== null
  if (remap.size > 0 || removed.size > 0) {
    for (const e of graph.getNodesByType<EventNode>('event')) {
      const mapped = (e.concepts ?? [])
        .map(id => remap.get(id) ?? id)
        .filter(alive)
      if (mapped.join('\u0000') !== (e.concepts ?? []).join('\u0000')) { e.concepts = mapped; e.updated_at = now }
    }
    for (const f of graph.getNodesByType<FactNode>('fact')) {
      let changed = false
      if (f.subject_id !== undefined) {
        const mapped = remap.get(f.subject_id) ?? f.subject_id
        if (mapped !== f.subject_id) { f.subject_id = mapped; changed = true }
        if (!alive(f.subject_id)) { graph.removeNode(f.node_id); report.staleVectorIds.push(f.node_id); report.droppedFacts++; continue }
      }
      if (f.object_id !== undefined) {
        const mapped = remap.get(f.object_id) ?? f.object_id
        if (mapped !== f.object_id) { f.object_id = mapped; changed = true }
        if (!alive(f.object_id)) { graph.removeNode(f.node_id); report.staleVectorIds.push(f.node_id); report.droppedFacts++; continue }
      }
      if (changed) f.updated_at = now
    }
    for (const c of graph.getNodesByType<ClaimNode>('claim')) {
      if (c.target_id !== undefined) {
        const mapped = remap.get(c.target_id) ?? c.target_id
        if (mapped !== c.target_id) { c.target_id = mapped; c.updated_at = now }
        if (!alive(c.target_id)) { delete c.target_id; c.updated_at = now; report.unlinkedClaims++ }
      }
    }
    for (const c of graph.getNodesByType<ConceptNode>('concept')) {
      if (c.parent_concept_id !== undefined) {
        const mapped = remap.get(c.parent_concept_id) ?? c.parent_concept_id
        if (mapped !== c.parent_concept_id) { c.parent_concept_id = mapped; c.updated_at = now }
        if (!alive(c.parent_concept_id)) { delete c.parent_concept_id; c.updated_at = now }
      }
    }
  }

  // ---- 4. 合并导致的 (subject, predicate, object) / (source, target, content) 碰撞去重 ----
  const factKey = (f: FactNode) => `${f.subject_id ?? ''}|${f.predicate}|${f.object_id ?? ''}`
  const factsByKey = new Map<string, FactNode[]>()
  for (const f of graph.getNodesByType<FactNode>('fact')) {
    const list = factsByKey.get(factKey(f))
    if (list) list.push(f); else factsByKey.set(factKey(f), [f])
  }
  for (const list of factsByKey.values()) {
    if (list.length < 2) continue
    list.sort((a, b) => (b.mention_count ?? 0) - (a.mention_count ?? 0))
    const [keep, ...dupes] = list
    for (const d of dupes) {
      keep!.mention_count = (keep!.mention_count ?? 1) + (d.mention_count ?? 1)
      keep!.source_sessions = [...new Set([...(keep!.source_sessions ?? []), ...(d.source_sessions ?? [])])]
      for (const ev of d.evidence ?? []) {
        if (ev && !(keep!.evidence ?? []).includes(ev) && (keep!.evidence ?? []).length < 3) {
          keep!.evidence = [...(keep!.evidence ?? []), ev]
        }
      }
      keep!.updated_at = now
      graph.removeNode(d.node_id)
      report.staleVectorIds.push(d.node_id)
      report.dedupedFacts++
    }
  }

  const claimKey = (c: ClaimNode) => `${c.source_person_id}|${c.target_id ?? ''}|${c.content}`
  const claimsByKey = new Map<string, ClaimNode[]>()
  for (const c of graph.getNodesByType<ClaimNode>('claim')) {
    const list = claimsByKey.get(claimKey(c))
    if (list) list.push(c); else claimsByKey.set(claimKey(c), [c])
  }
  for (const list of claimsByKey.values()) {
    if (list.length < 2) continue
    const [, ...dupes] = list
    for (const d of dupes) {
      graph.removeNode(d.node_id)
      report.staleVectorIds.push(d.node_id)
      report.dedupedClaims++
    }
  }

  report.changed = report.removedLowValue + report.merged + report.renamed + report.droppedFacts
    + report.unlinkedClaims + report.dedupedFacts + report.dedupedClaims + report.refreshedVectors.length > 0
  return report
}
