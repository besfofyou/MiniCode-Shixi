import { readFile, rename } from 'node:fs/promises'
import { writeJsonAtomic } from './fs-util.js'
import type {
  AnyGraphNode, GraphEdge, CogMemNodeType, EdgeType,
} from './types.js'

/**
 * 轻量图谱存储 — TypeScript 实现
 *
 * 对应 CogMem 的 GraphStore，但用 JSON 文件持久化。
 * 内存中使用 Map 存储节点和邻接表。
 */
export class GraphStore {
  private nodes = new Map<string, AnyGraphNode>()
  private edges: GraphEdge[] = []
  private adjacency = new Map<string, Set<string>>()  // node_id → neighbor ids
  private edgeKeys = new Set<string>()

  private static key(e: GraphEdge) { return `${e.source_id}|${e.target_id}|${e.edge_type}` }

  // ---- 节点操作 ----

  addNode(node: AnyGraphNode): void {
    this.nodes.set(node.node_id, node)
  }

  getNode(id: string): AnyGraphNode | null {
    return this.nodes.get(id) ?? null
  }

  getNodesByType<T extends AnyGraphNode>(type: CogMemNodeType): T[] {
    const result: T[] = []
    for (const node of this.nodes.values()) {
      if (node.node_type === type) result.push(node as T)
    }
    return result
  }

  getAllNodes(): AnyGraphNode[] {
    return [...this.nodes.values()]
  }

  removeNode(id: string): void {
    this.nodes.delete(id)
    this.edges = this.edges.filter(
      e => e.source_id !== id && e.target_id !== id
    )
    this.adjacency.delete(id)
    for (const neighbors of this.adjacency.values()) {
      neighbors.delete(id)
    }
    this.edgeKeys = new Set(this.edges.map(GraphStore.key))
  }

  // ---- 边操作 ----

  addEdge(edge: GraphEdge): void {
    const k = GraphStore.key(edge)
    if (this.edgeKeys.has(k)) return
    this.edgeKeys.add(k)
    this.edges.push(edge)
    if (!this.adjacency.has(edge.source_id)) {
      this.adjacency.set(edge.source_id, new Set())
    }
    if (!this.adjacency.has(edge.target_id)) {
      this.adjacency.set(edge.target_id, new Set())
    }
    this.adjacency.get(edge.source_id)!.add(edge.target_id)
    this.adjacency.get(edge.target_id)!.add(edge.source_id)
  }

  getOutEdges(id: string, type?: EdgeType): GraphEdge[] {
    return this.edges.filter(e => e.source_id === id && (!type || e.edge_type === type))
  }

  getInEdges(id: string, type?: EdgeType): GraphEdge[] {
    return this.edges.filter(e => e.target_id === id && (!type || e.edge_type === type))
  }

  getNeighbors(nodeId: string, maxDepth = 1, maxResults = 10): AnyGraphNode[] {
    const visited = new Set<string>()
    const queue: { id: string; depth: number }[] = [{ id: nodeId, depth: 0 }]
    const result: AnyGraphNode[] = []
    visited.add(nodeId)
    while (queue.length > 0 && result.length < maxResults) {
      const { id, depth } = queue.shift()!
      if (depth > 0) {
        const node = this.nodes.get(id)
        if (node) result.push(node)
      }
      if (depth < maxDepth) {
        const neighbors = this.adjacency.get(id) ?? new Set<string>()
        for (const neighborId of neighbors) {
          if (!visited.has(neighborId)) {
            visited.add(neighborId)
            queue.push({ id: neighborId, depth: depth + 1 })
          }
        }
      }
    }
    return result
  }

  getEdgesFor(nodeId: string): GraphEdge[] {
    return this.edges.filter(
      e => e.source_id === nodeId || e.target_id === nodeId
    )
  }

  findCommonGround(entityIds: string[], topK = 5): AnyGraphNode[] {
    if (entityIds.length < 2) return []
    const neighborSets = entityIds.map(id => this.adjacency.get(id) ?? new Set<string>())
    let common = new Set(neighborSets[0])
    for (let i = 1; i < neighborSets.length; i++) {
      common = new Set([...common].filter(x => neighborSets[i].has(x)))
    }
    return [...common]
      .slice(0, topK)
      .map(id => this.nodes.get(id))
      .filter((n): n is AnyGraphNode => n !== null)
  }

  // ---- 统计 ----

  nodeCount(): number { return this.nodes.size }
  edgeCount(): number { return this.edges.length }

  stats(): { persons: number; events: number; concepts: number; claims: number; facts: number; edges: number } {
    let persons = 0, events = 0, concepts = 0, claims = 0, facts = 0
    for (const node of this.nodes.values()) {
      switch (node.node_type) {
        case 'person': persons++; break
        case 'event': events++; break
        case 'concept': concepts++; break
        case 'claim': claims++; break
        case 'fact': facts++; break
      }
    }
    return { persons, events, concepts, claims, facts, edges: this.edges.length }
  }

  // ---- 持久化 ----

  async save(filePath: string): Promise<void> {
    await writeJsonAtomic(filePath, {
      schema_version: 2,
      nodes: [...this.nodes.values()],
      edges: this.edges,
    })
  }

  async load(filePath: string): Promise<void> {
    let raw: unknown
    try {
      raw = JSON.parse(await readFile(filePath, 'utf8'))
    } catch (e: any) {
      if (e?.code !== 'ENOENT') await rename(filePath, `${filePath}.corrupt-${Date.now()}`).catch(() => {})
      return
    }
    this.nodes.clear()
    this.edges = []
    this.adjacency.clear()
    this.edgeKeys.clear()
    for (const node of ((raw as { nodes?: AnyGraphNode[] }).nodes ?? [])) {
      this.nodes.set(node.node_id, node)
    }
    for (const edge of ((raw as { edges?: GraphEdge[] }).edges ?? [])) {
      this.addEdge(edge)
    }
  }
}
