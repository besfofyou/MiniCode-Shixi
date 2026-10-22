import type { ModelAdapter } from '../types.js'
import type { AnyGraphNode, SearchStepResult, MemoryRetrievalResult } from './types.js'
import { GraphStore } from './graph-store.js'
import { VectorStore } from './vector-store.js'
import { SEARCH_AGENT_SYSTEM, SEARCH_AGENT_STEP } from './cogmem-prompts.js'

const MAX_ITERATIONS = 4

/**
 * CogMem 风格的 SearchAgent — LLM 驱动的图谱检索
 *
 * 替代原有 AdaptiveMemoryController (UCB1 RL)。
 * 每次用户查询时，LLM 自主决定调用哪些检索工具、按什么顺序。
 */
export class MemorySearchAgent {
  constructor(
    private readonly graph: GraphStore,
    private readonly vectorStore: VectorStore,
    private readonly model: ModelAdapter,
  ) {}

  async search(query: string): Promise<MemoryRetrievalResult> {
    if (this.graph.nodeCount() === 0) {
      return { nodes: [], evidence: [], reasoning_path: [], answer_summary: '' }
    }

    const history: SearchStepResult[] = []
    const collectedNodes = new Map<string, AnyGraphNode>()

    for (let step = 0; step < MAX_ITERATIONS; step++) {
      // 构建当前 history 文本
      const historyText = history.length === 0
        ? 'No steps taken yet.'
        : history.map(h =>
            `Step ${h.step}: [${h.action}] → ${h.observation.slice(0, 300)}`
          ).join('\n')

      const stepPrompt = SEARCH_AGENT_STEP
        .replace('{query}', query)
        .replace('{history}', historyText)

      const systemPrompt = SEARCH_AGENT_SYSTEM
        .replace('{max_iterations}', String(MAX_ITERATIONS))

      let llmOutput: string
      try {
        const response = await this.model.next([
          { role: 'system', content: systemPrompt },
          { role: 'user', content: stepPrompt },
        ], {})
        llmOutput = response.type === 'assistant' ? response.content : ''
      } catch {
        break
      }

      // 解析 FINAL_ANSWER
      const finalMatch = llmOutput.match(/FINAL_ANSWER:\s*([\s\S]+)/i)
      if (finalMatch) {
        return {
          nodes: [...collectedNodes.values()],
          evidence: history.map(h => h.observation),
          reasoning_path: history,
          answer_summary: finalMatch[1].trim(),
        }
      }

      // 解析 TOOL: / ARGS:
      const toolMatch = llmOutput.match(/TOOL:\s*(\w+)/i)
      const argsMatch = llmOutput.match(/ARGS:\s*(\{[\s\S]*?\})/i)
      if (!toolMatch) break

      const toolName = toolMatch[1]
      let args: Record<string, unknown> = {}
      try { args = JSON.parse(argsMatch?.[1] ?? '{}') } catch { /* empty */ }

      // 执行工具
      let observation = ''
      try {
        switch (toolName) {
          case 'semantic_search': {
            const q = String(args.query ?? query)
            const topK = Number(args.top_k ?? 10)
            const results = await this.vectorStore.search(q, topK)
            const nodes = results.map(r => this.graph.getNode(r.id)).filter(Boolean) as AnyGraphNode[]
            nodes.forEach(n => collectedNodes.set(n.node_id, n))
            observation = nodes.map(n => nodeToString(n)).join('\n') || 'No results.'
            break
          }
          case 'find_anchors': {
            const q = String(args.query ?? query)
            const topK = Number(args.top_k ?? 5)
            const results = await this.vectorStore.search(q, topK)
            const anchors = results
              .map(r => this.graph.getNode(r.id))
              .filter((n): n is AnyGraphNode =>
                n !== null && (n.node_type === 'person' || n.node_type === 'concept')
              )
            anchors.forEach(n => collectedNodes.set(n.node_id, n))
            observation = anchors.map(n => nodeToString(n)).join('\n') || 'No anchors found.'
            break
          }
          case 'traverse_neighbors': {
            const nodeId = String(args.node_id ?? '')
            const maxDepth = Number(args.max_depth ?? 1)
            const maxResults = Number(args.max_results ?? 10)
            const neighbors = this.graph.getNeighbors(nodeId, maxDepth, maxResults)
            neighbors.forEach(n => collectedNodes.set(n.node_id, n))
            observation = neighbors.map(n => nodeToString(n)).join('\n') || 'No neighbors.'
            break
          }
          case 'find_common_ground': {
            const ids = Array.isArray(args.entity_ids)
              ? args.entity_ids.map(String)
              : []
            const common = this.graph.findCommonGround(ids)
            common.forEach(n => collectedNodes.set(n.node_id, n))
            observation = common.map(n => nodeToString(n)).join('\n') || 'No common ground.'
            break
          }
          case 'get_evidence': {
            const ids = Array.isArray(args.node_ids)
              ? args.node_ids.map(String)
              : []
            const evidence = ids.map(id => {
              const node = this.graph.getNode(id)
              return node ? nodeToString(node) : `Node ${id} not found.`
            })
            observation = evidence.join('\n---\n') || 'No evidence.'
            break
          }
          default:
            observation = `Unknown tool: ${toolName}`
        }
      } catch (err) {
        observation = `Tool error: ${err instanceof Error ? err.message : String(err)}`
      }

      history.push({
        step: step + 1,
        thought: llmOutput.split('TOOL:')[0].trim(),
        action: toolName as SearchStepResult['action'],
        action_input: args,
        observation,
      })
    }

    // 达到最大步数，用收集到的节点做最终汇总
    return {
      nodes: [...collectedNodes.values()],
      evidence: history.map(h => h.observation),
      reasoning_path: history,
      answer_summary: '',
    }
  }
}

function nodeToString(node: AnyGraphNode): string {
  switch (node.node_type) {
    case 'person': return `[Person] ${node.canonical_name}: ${node.description}`
    case 'event': return `[Event:${node.node_id}] ${node.title}: ${node.description}`
    case 'concept': return `[Concept] ${node.name}: ${node.description}`
    case 'claim': return `[Claim:${node.node_id}] ${node.content}`
    case 'fact': return `[Fact:${node.node_id}] ${node.subject} ${node.predicate} ${node.object}`
  }
}
