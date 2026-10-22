import type { ModelAdapter } from '../types.js'
import type { EventNode, FactNode } from './types.js'
import { GraphStore } from './graph-store.js'
import { VectorStore } from './vector-store.js'
import { CONSOLIDATION_SYSTEM, CONSOLIDATION_USER } from './cogmem-prompts.js'
import { randomUUID } from 'node:crypto'

/**
 * 记忆巩固引擎
 *
 * 定期将情景记忆（Event）合成为语义记忆（Fact），
 * 同时保留从 Event 到 Fact 的 SUPPORTED_BY 证据链。
 */
export class MemoryConsolidator {
  constructor(
    private readonly graph: GraphStore,
    private readonly vectorStore: VectorStore,
    private readonly model: ModelAdapter,
  ) {}

  async consolidate(minEvents = 3): Promise<{
    factsCreated: number
    eventsArchived: number
  }> {
    const events = this.graph
      .getNodesByType<EventNode>('event')
      .filter(e => !e.archived)
    if (events.length < minEvents) {
      return { factsCreated: 0, eventsArchived: 0 }
    }

    const existingFacts = this.graph.getNodesByType<FactNode>('fact')

    const eventsText = events.map(e =>
      `[${e.node_id}] ${e.title}: ${e.description}`
    ).join('\n')
    const factsText = existingFacts.map(f =>
      `${f.subject} ${f.predicate} ${f.object}`
    ).join('\n') || 'None'

    const prompt = CONSOLIDATION_USER
      .replace('{events}', eventsText)
      .replace('{existing_facts}', factsText)

    let llmOutput: string
    try {
      const response = await this.model.next([
        { role: 'system', content: CONSOLIDATION_SYSTEM },
        { role: 'user', content: prompt },
      ], {})
      llmOutput = response.type === 'assistant' ? response.content : ''
    } catch {
      return { factsCreated: 0, eventsArchived: 0 }
    }

    // 解析合成的 Facts
    const match = llmOutput.match(/\[[\s\S]*\]/)
    if (!match) return { factsCreated: 0, eventsArchived: 0 }

    let newFacts: Array<{
      subject: string; predicate: string; object: string
      confidence: number; sources: string[]; temporal_info?: string
    }>
    try {
      const parsed = JSON.parse(match[0])
      newFacts = Array.isArray(parsed) ? parsed
        : Array.isArray(parsed.facts) ? parsed.facts : []
    } catch {
      return { factsCreated: 0, eventsArchived: 0 }
    }

    const now = new Date().toISOString()
    let factsCreated = 0
    const vectorBatch: { id: string; text: string }[] = []

    for (const f of newFacts) {
      if (!f.subject || !f.predicate) continue
      const desc = `${f.subject} ${f.predicate} ${f.object ?? ''}`
      const factNode: FactNode = {
        node_id: `fact_${randomUUID().slice(0, 12)}`,
        node_type: 'fact',
        subject: f.subject,
        predicate: f.predicate,
        object: f.object ?? '',
        description: desc,
        confidence: f.confidence ?? 0.7,
        supported_by_event_ids: f.sources ?? [],
        temporal_info: f.temporal_info,
        created_at: now,
        updated_at: now,
        source_session_id: 'consolidation',
        embedding_text: `Fact: ${desc}`,
      }
      this.graph.addNode(factNode)
      vectorBatch.push({ id: factNode.node_id, text: factNode.embedding_text })

      // 创建 SUPPORTED_BY 边
      for (const sourceId of factNode.supported_by_event_ids) {
        if (this.graph.getNode(sourceId)) {
          this.graph.addEdge({
            source_id: factNode.node_id,
            target_id: sourceId,
            edge_type: 'SUPPORTED_BY',
            weight: 1.0,
            created_at: now,
          })
        }
      }
      factsCreated++
    }

    if (vectorBatch.length > 0) {
      await this.vectorStore.addBatch(vectorBatch)
    }

    // 标记已巩固的 Event 为 archived
    let eventsArchived = 0
    const archivedIds = new Set(
      newFacts.flatMap(f => f.sources ?? [])
    )
    for (const event of events) {
      if (archivedIds.has(event.node_id)) {
        event.archived = true
        event.updated_at = now
        eventsArchived++
      }
    }

    return { factsCreated, eventsArchived }
  }
}
