import type { AnyGraphNode } from './types.js'

export function isRetrievable(n: AnyGraphNode): boolean {
  if (n.node_type === 'fact') return (n.lifecycle ?? 'stable') !== 'archived' && n.is_latest !== false
  if (n.node_type === 'claim') return (n.lifecycle ?? 'stable') !== 'archived'
  return true   // Event 保留（CogMem 默认不归档）；Person/Concept 作为锚点
}

/** = CogMem semantic_search 的 importance 重排：score × (0.7 + 0.3 × importance)；候选事实降权 */
export function rerank(n: AnyGraphNode, score: number): number {
  if (n.node_type !== 'fact') return score
  return score * (0.7 + 0.3 * (n.importance ?? 0.5)) * (n.lifecycle === 'candidate' ? 0.85 : 1)
}
