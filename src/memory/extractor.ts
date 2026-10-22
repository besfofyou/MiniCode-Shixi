import { randomUUID } from 'node:crypto'
import type { ModelAdapter, ChatMessage } from '../types.js'
import type {
  ExtractionResult, PersonNode, EventNode,
  ConceptNode, ClaimNode, FactNode,
} from './types.js'
import { GraphStore } from './graph-store.js'
import { VectorStore } from './vector-store.js'
import { EXTRACTION_SYSTEM_PROMPT, EXTRACTION_USER_PROMPT } from './cogmem-prompts.js'

function generateId(prefix: string): string {
  return `${prefix}_${randomUUID().slice(0, 12)}`
}

/**
 * 结构化信息抽取器（对应 CogMem 的 Indexer）
 *
 * 从对话历史中抽取 Person/Event/Concept/Claim/Fact 节点，
 * 写入 GraphStore 并索引到 VectorStore。
 */
export class CogMemExtractor {
  constructor(
    private readonly graph: GraphStore,
    private readonly vectorStore: VectorStore,
    private readonly model: ModelAdapter,
  ) {}

  /**
   * 从一组对话消息中抽取结构化记忆
   */
  async extractFromMessages(
    messages: ChatMessage[],
    sessionId: string,
  ): Promise<{ nodesCreated: number }> {
    const text = compressMessages(messages)
    if (text.length < 50) return { nodesCreated: 0 }

    const now = new Date().toISOString()
    const sessionDate = new Date().toLocaleDateString('en-US')

    // 1. 调用 LLM 抽取
    const prompt = EXTRACTION_USER_PROMPT
      .replace('{text}', text)
      .replace('{session_date}', sessionDate)
    let extracted: ExtractionResult
    try {
      const response = await this.model.next([
        { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ], {})
      if (response.type !== 'assistant') return { nodesCreated: 0 }
      extracted = parseExtraction(response.content)
    } catch {
      return { nodesCreated: 0 }
    }

    let count = 0
    const vectorBatch: { id: string; text: string }[] = []

    // 2. 写入 Person 节点
    for (const p of extracted.persons ?? []) {
      if (!p.name) continue
      const existing = this.findPersonByName(p.name)
      if (existing) continue
      const node: PersonNode = {
        node_id: generateId('p'),
        node_type: 'person',
        canonical_name: p.name,
        aliases: p.aliases ?? [],
        description: `Person: ${p.name}`,
        created_at: now, updated_at: now,
        source_session_id: sessionId,
        embedding_text: `Person ${p.name}`,
      }
      this.graph.addNode(node)
      vectorBatch.push({ id: node.node_id, text: node.embedding_text })
      count++
    }

    // 3. 写入 Concept 节点
    for (const c of extracted.concepts ?? []) {
      if (!c.name) continue
      const node: ConceptNode = {
        node_id: generateId('concept'),
        node_type: 'concept',
        name: c.name,
        description: c.description ?? c.name,
        created_at: now, updated_at: now,
        source_session_id: sessionId,
        embedding_text: `Concept: ${c.name}. ${c.description ?? ''}`,
      }
      this.graph.addNode(node)
      vectorBatch.push({ id: node.node_id, text: node.embedding_text })
      count++
    }

    // 4. 写入 Event 节点 + 关系边
    for (const e of extracted.events ?? []) {
      const node: EventNode = {
        node_id: generateId('event'),
        node_type: 'event',
        title: e.title ?? '',
        description: e.description ?? e.title ?? '',
        participants: [],
        time_expression: e.time_expression,
        concepts: [],
        archived: false,
        created_at: now, updated_at: now,
        source_session_id: sessionId,
        embedding_text: `Event: ${e.title}. ${e.description ?? ''}`,
      }
      this.graph.addNode(node)
      vectorBatch.push({ id: node.node_id, text: node.embedding_text })

      // 连接 participants
      for (const pName of e.participants ?? []) {
        const person = this.findPersonByName(pName)
        if (person) {
          node.participants.push(person.node_id)
          this.graph.addEdge({
            source_id: person.node_id, target_id: node.node_id,
            edge_type: 'PARTICIPATED_IN', weight: 1.0, created_at: now,
          })
        }
      }
      count++
    }

    // 5. 写入 Fact 节点
    for (const f of extracted.facts ?? []) {
      const desc = `${f.subject} ${f.predicate} ${f.object}`
      const node: FactNode = {
        node_id: generateId('fact'),
        node_type: 'fact',
        subject: f.subject ?? '',
        predicate: f.predicate ?? '',
        object: f.object ?? '',
        description: desc,
        confidence: 0.7,
        supported_by_event_ids: [],
        created_at: now, updated_at: now,
        source_session_id: sessionId,
        embedding_text: `Fact: ${desc}`,
      }
      this.graph.addNode(node)
      vectorBatch.push({ id: node.node_id, text: node.embedding_text })
      count++
    }

    // 6. 写入 Claim 节点
    for (const c of extracted.claims ?? []) {
      const node: ClaimNode = {
        node_id: generateId('claim'),
        node_type: 'claim',
        source_person_id: '',
        target: c.target,
        content: c.content ?? '',
        confidence: 0.6,
        created_at: now, updated_at: now,
        source_session_id: sessionId,
        embedding_text: `Claim by ${c.source}: ${c.content}`,
      }
      const person = this.findPersonByName(c.source ?? '')
      if (person) {
        node.source_person_id = person.node_id
        this.graph.addEdge({
          source_id: node.node_id, target_id: person.node_id,
          edge_type: 'CLAIMED_BY', weight: 1.0, created_at: now,
        })
      }
      this.graph.addNode(node)
      vectorBatch.push({ id: node.node_id, text: node.embedding_text })
      count++
    }

    // 7. 批量写入向量索引
    if (vectorBatch.length > 0) {
      await this.vectorStore.addBatch(vectorBatch)
    }

    return { nodesCreated: count }
  }

  private findPersonByName(name: string): PersonNode | null {
    const lower = name.toLowerCase().trim()
    for (const node of this.graph.getNodesByType<PersonNode>('person')) {
      if (node.canonical_name.toLowerCase() === lower) return node
      if (node.aliases.some(a => a.toLowerCase() === lower)) return node
    }
    return null
  }
}

// ---- 辅助函数 ----

function compressMessages(messages: ChatMessage[]): string {
  const MAX_CHARS = 8000
  const lines = messages
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => {
      const text = m.content.length > 1500
        ? m.content.slice(0, 1500) + '\n... [truncated]'
        : m.content
      return `[${m.role}]: ${text}`
    })
  return lines.join('\n').slice(0, MAX_CHARS)
}

function parseExtraction(content: string): ExtractionResult {
  const match = content.match(/\{[\s\S]*\}/)
  if (!match) return { events: [], facts: [], claims: [], persons: [], concepts: [] }
  try {
    const parsed = JSON.parse(match[0])
    return {
      events: Array.isArray(parsed.events) ? parsed.events : [],
      facts: Array.isArray(parsed.facts) ? parsed.facts : [],
      claims: Array.isArray(parsed.claims) ? parsed.claims : [],
      persons: Array.isArray(parsed.persons) ? parsed.persons : [],
      concepts: Array.isArray(parsed.concepts) ? parsed.concepts : [],
    }
  } catch {
    return { events: [], facts: [], claims: [], persons: [], concepts: [] }
  }
}
