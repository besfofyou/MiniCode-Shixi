import type { ModelAdapter } from '../types.js'
import type { AnyGraphNode, CogMemNodeType, SearchStepResult, MemoryRetrievalResult } from './types.js'
import { GraphStore } from './graph-store.js'
import { VectorStore } from './vector-store.js'
import { SEARCH_AGENT_SYSTEM, SEARCH_AGENT_STEP } from './cogmem-prompts.js'
import { isRetrievable, rerank } from './retrieval-policy.js'
import { fill } from './json-util.js'

const MAX_ITERATIONS = 3
const FAST_PATH_SCORE = Number(process.env.COGMEM_FAST_PATH_SCORE ?? 0.62)   // bge-m3 的经验值，需按自己的数据调
const NEEDS_REASONING = /为什么|之前|上次|什么时候|哪次|历史|对比|区别|\bwhen\b|\bbefore\b|\bafter\b|\bwhy\b|\bboth\b|\bcompare\b/i
type Scored = { node: AnyGraphNode; score: number }

/**
 * CogMem 风格的 SearchAgent — LLM 驱动的图谱检索
 *
 * 先预取锚点并做一次种子检索；高置信度且不需要时间推理时走快速路径（不调 LLM）；
 * 否则进入 ReAct 循环，按节点类型召回、过滤已归档节点、按 importance 重排。
 */
export class MemorySearchAgent {
  constructor(
    private readonly graph: GraphStore,
    private readonly vectorStore: VectorStore,
    private readonly model: ModelAdapter,
  ) {}

  private async typedSearch(q: string, types: CogMemNodeType[], k: number): Promise<Scored[]> {
    const allow = new Set(types)
    try {
      const hits = await this.vectorStore.search(q, k * 2, id => {
        const n = this.graph.getNode(id)
        return !!n && allow.has(n.node_type) && isRetrievable(n)
      })
      return hits.map(h => { const node = this.graph.getNode(h.id)!; return { node, score: rerank(node, h.score) } })
        .sort((a, b) => b.score - a.score).slice(0, k)
    } catch { return [] }                                                  // embedding 不可用时降级为空，见第 5 点
  }

  async search(query: string): Promise<MemoryRetrievalResult> {
    if (this.graph.nodeCount() === 0) return { nodes: [], evidence: [], reasoning_path: [], answer_summary: '' }
    const collected = new Map<string, Scored>()
    const keep = (s: Scored) => { const old = collected.get(s.node.node_id); if (!old || old.score < s.score) collected.set(s.node.node_id, s) }

    // Step 0：种子检索（对应 CogMem 的锚点预取 + seed semantic_search）
    const seeds = await this.typedSearch(query, ['fact', 'claim', 'event'], 10)
    const anchors = await this.typedSearch(query, ['person', 'concept'], 5)
    seeds.forEach(keep)

    // 快速路径：命中足够强、问题也不需要时间推理或多跳 → 不调用 LLM
    if ((seeds[0]?.score ?? 0) >= FAST_PATH_SCORE && !NEEDS_REASONING.test(query)) return this.finalize(collected, [], '')

    const history: SearchStepResult[] = [{
      step: 0, thought: 'seed retrieval', action: 'semantic_search', action_input: { query },
      observation: [...anchors, ...seeds].map(s => `(${s.score.toFixed(2)}) ${nodeToString(s.node)}`).join('\n') || 'No results.',
    }]

    for (let step = 1; step <= MAX_ITERATIONS; step++) {
      const historyText = history.map(h => `Step ${h.step}: [${h.action}] → ${h.observation.slice(0, 600)}`).join('\n')
      let out = ''
      try {
        const res = await this.model.next([
          { role: 'system', content: fill(SEARCH_AGENT_SYSTEM, { max_iterations: String(MAX_ITERATIONS) }) },
          { role: 'user', content: fill(SEARCH_AGENT_STEP, { query, history: historyText }) },
        ], {})
        out = res.type === 'assistant' ? res.content : ''
      } catch { break }

      const fin = out.match(/FINAL_ANSWER:\s*([\s\S]+)/i)
      if (fin) return this.finalize(collected, history, fin[1].trim())
      const tool = out.match(/TOOL:\s*(\w+)/i)?.[1]
      if (!tool) break
      let args: Record<string, unknown> = {}
      try { args = JSON.parse(out.match(/ARGS:\s*(\{[\s\S]*?\})/i)?.[1] ?? '{}') } catch { /* empty */ }

      let found: Scored[] = []
      switch (tool) {
        case 'semantic_search': {
          const types = (Array.isArray(args.node_types) ? args.node_types : ['fact', 'claim', 'event']) as CogMemNodeType[]
          found = await this.typedSearch(String(args.query ?? query), types, Math.min(Number(args.top_k ?? 8), 12)); break
        }
        case 'find_anchors':
          found = await this.typedSearch(String(args.query ?? query), ['person', 'concept'], Math.min(Number(args.top_k ?? 5), 8)); break
        case 'traverse_neighbors': {
          const parent = collected.get(String(args.node_id ?? ''))?.score ?? 0.5
          found = this.graph.getNeighbors(String(args.node_id ?? ''), Math.min(Number(args.max_depth ?? 1), 2), Math.min(Number(args.max_results ?? 10), 15))
            .filter(isRetrievable).map(node => ({ node, score: rerank(node, parent * 0.8) })); break
        }
        case 'find_common_ground': {
          const ids = Array.isArray(args.entity_ids) ? args.entity_ids.map(String) : []
          found = this.graph.findCommonGround(ids).filter(isRetrievable).map(node => ({ node, score: 0.5 })); break
        }
        case 'get_evidence': {
          const ids = Array.isArray(args.node_ids) ? args.node_ids.map(String) : []
          history.push({ step, thought: '', action: 'get_evidence', action_input: args, observation: ids.map(id => this.evidenceFor(id)).join('\n---\n') || 'No evidence.' })
          continue
        }
        default:
          history.push({ step, thought: '', action: tool as SearchStepResult['action'], action_input: args, observation: `Unknown tool: ${tool}` }); continue
      }
      found.forEach(keep)
      history.push({ step, thought: out.split('TOOL:')[0].trim(), action: tool as SearchStepResult['action'], action_input: args,
        observation: found.map(s => `(${s.score.toFixed(2)}) ${nodeToString(s.node)}`).join('\n') || 'No results.' })
    }
    return this.finalize(collected, history, '')
  }

  /** = CogMem _tool_get_evidence：节点自身的原文片段 + SUPPORTED_BY 事件的原文片段（回退） */
  private evidenceFor(id: string): string {
    const n = this.graph.getNode(id)
    if (!n) return `Node ${id} not found.`
    const own = n.evidence ?? []
    const viaEvents = n.node_type === 'fact'
      ? this.graph.getOutEdges(id, 'SUPPORTED_BY').flatMap(e => this.graph.getNode(e.target_id)?.evidence ?? [])
      : []
    const chunks = [...new Set([...own, ...viaEvents])].slice(0, 3)
    return `${nodeToString(n)}\n${chunks.map((c, i) => `  [Evidence ${i + 1}] ${c}`).join('\n') || '  (no original text recorded)'}`
  }

  private finalize(collected: Map<string, Scored>, history: SearchStepResult[], summary: string): MemoryRetrievalResult {
    const ranked = [...collected.values()].sort((a, b) => b.score - a.score)
    const content = ranked.filter(s => s.node.node_type !== 'person' && s.node.node_type !== 'concept')
    return { nodes: (content.length ? content : ranked).map(s => s.node), evidence: history.map(h => h.observation), reasoning_path: history, answer_summary: summary }
  }
}

function nodeToString(n: AnyGraphNode): string {          // 所有类型都带 ID，LLM 才能继续遍历
  switch (n.node_type) {
    case 'person':  return `[Person:${n.node_id}] ${n.canonical_name}`
    case 'concept': return `[Concept:${n.node_id}] ${n.name}`
    case 'event':   return `[Event:${n.node_id}] ${n.title}${(n.resolved_time ?? n.session_time) ? ` (${n.resolved_time ?? n.session_time})` : ''}: ${n.description}`
    case 'claim':   return `[Claim:${n.node_id}] ${n.content}`
    case 'fact':    return `[Fact:${n.node_id}${n.lifecycle === 'candidate' ? ',candidate' : ''}] ${n.description || `${n.subject} ${n.predicate} ${n.object}`}`
  }
}
