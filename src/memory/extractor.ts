import type { ModelAdapter, ChatMessage } from '../types.js'
import type {
  ExtractionResult, PersonNode, EventNode,
  ConceptNode, ClaimNode, FactNode,
  AnyGraphNode, EdgeType,
} from './types.js'
import { GraphStore } from './graph-store.js'
import { VectorStore } from './vector-store.js'
import { EXTRACTION_SYSTEM_PROMPT, EXTRACTION_USER_PROMPT } from './cogmem-prompts.js'
import { stableId, normalizeConceptName, canonicalPersonName, resolveRelativeTime } from './graph-ids.js'
import { extractJsonObject, fill } from './json-util.js'
import { sanitizeMemoryContent, validateMemoryWrite } from './safety.js'
import { tokenize } from './filesystem.js'

type Ctx = { sessionId: string; now: string; sourceText: string; batch: { id: string; text: string }[]; created: { n: number } }

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
  ): Promise<{ nodesCreated: number; newEventIds: string[]; touchedFactIds: string[] }> {
    const sessionDate = new Date().toISOString().slice(0, 10)
    const out = { nodesCreated: 0, newEventIds: [] as string[], touchedFactIds: [] as string[] }
    for (const text of chunkMessages(messages, 6000, 4)) {          // 按窗口切分，保证会话末尾一定被抽取
      if (text.length < 50) continue
      const x = await this.callLLM(text, sessionDate)
      if (!x) continue
      const r = await this.writeExtraction(x, text, sessionId, sessionDate)
      out.nodesCreated += r.nodesCreated; out.newEventIds.push(...r.newEventIds); out.touchedFactIds.push(...r.touchedFactIds)
    }
    return out
  }

  private async callLLM(text: string, sessionDate: string): Promise<ExtractionResult | null> {
    try {
      const res = await this.model.next([
        { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
        { role: 'user', content: fill(EXTRACTION_USER_PROMPT, { text, session_date: sessionDate }) },
      ], {})
      if (res.type !== 'assistant') return null
      const p = extractJsonObject(res.content) as Partial<ExtractionResult> | null
      if (!p) return null
      const arr = <T>(v: unknown) => (Array.isArray(v) ? v : []) as T[]
      return { events: arr(p.events), facts: arr(p.facts), claims: arr(p.claims), persons: arr(p.persons), concepts: arr(p.concepts) }
    } catch { return null }
  }

  private async writeExtraction(x: ExtractionResult, sourceText: string, sessionId: string, sessionDate: string) {
    const ctx: Ctx = { sessionId, now: new Date().toISOString(), sourceText, batch: [], created: { n: 0 } }
    const newEventIds: string[] = [], touchedFactIds: string[] = []

    for (const p of x.persons) if (p?.name) this.ensurePerson(p.name, ctx, p.aliases ?? [])
    for (const c of x.concepts) if (c?.name) this.ensureConcept(c.name, ctx, c.description)

    // ---- Event（情景记忆）----
    for (const e of x.events) {
      const title = clean(e.title ?? e.description)
      if (!title) continue
      const id = stableId('event', sessionId, title)
      if (this.graph.getNode(id)) continue                                       // 幂等
      const people = (e.participants?.length ? e.participants : ['User'])
        .map(n => this.ensurePerson(n, ctx)).filter((p): p is PersonNode => !!p)
      const concepts = (e.concepts ?? []).map(n => this.ensureConcept(n, ctx)).filter((c): c is ConceptNode => !!c)
      const timeRaw = typeof e.time === 'string' && e.time.trim() ? e.time.trim() : undefined
      const desc = clean(e.description) || title
      this.add({
        node_id: id, node_type: 'event', title, description: desc,
        participants: people.map(p => p.node_id), concepts: concepts.map(c => c.node_id),
        time_expression: timeRaw, resolved_time: resolveRelativeTime(timeRaw, sessionDate), session_time: sessionDate,
        archived: false, evidence: pickEvidence(e.evidence, sourceText, `${title} ${desc}`),
        created_at: ctx.now, updated_at: ctx.now, source_session_id: sessionId,
        embedding_text: `Event: ${title}. ${desc}. Concepts: ${concepts.map(c => c.name).join(', ')}`,
      } satisfies EventNode, ctx)
      people.forEach((p, i) => this.edge(p.node_id, id, i === 0 ? 'PARTICIPATED_IN' : 'MENTIONED_IN', i === 0 ? 1 : 0.5, ctx.now))
      concepts.forEach(c => this.edge(id, c.node_id, 'ABOUT_CONCEPT', 1, ctx.now))   // = CogMem INVOLVES
      newEventIds.push(id)
    }

    // ---- Fact（抽取阶段只算候选语义记忆）----
    for (const f of x.facts) {
      const subject = clean(f.subject), object = clean(f.object)
      const predicate = clean(f.predicate).toLowerCase().replace(/\s+/g, '_').slice(0, 60)
      if (!subject || !predicate || !object) continue                            // = CogMem skip_incomplete_facts
      const subj = this.findPersonByName(canonicalPersonName(subject)) ?? this.ensureConcept(subject, ctx)
      const obj = this.ensureConcept(object, ctx)
      if (!subj || !obj) continue
      const id = stableId('fact', subj.node_id, predicate, obj.node_id)
      const existing = this.graph.getNode(id)
      if (existing?.node_type === 'fact') {                                      // 跨会话重复出现：记录次数，供第 2 点晋升
        existing.mention_count = (existing.mention_count ?? 1) + 1
        existing.source_sessions = [...new Set([...(existing.source_sessions ?? []), sessionId])]
        existing.updated_at = ctx.now
        touchedFactIds.push(id)
        continue
      }
      const desc = `${subject} ${predicate.replace(/_/g, ' ')} ${object}`
      this.add({
        node_id: id, node_type: 'fact', subject, predicate, object, description: desc,
        subject_id: subj.node_id, object_id: obj.node_id,
        confidence: 0.6, lifecycle: 'candidate', is_latest: true, valid_from: sessionDate,
        mention_count: 1, source_sessions: [sessionId], supported_by_event_ids: [],
        evidence: pickEvidence(f.evidence, sourceText, desc),
        created_at: ctx.now, updated_at: ctx.now, source_session_id: sessionId,
        embedding_text: `Fact: ${desc}`,
      } satisfies FactNode, ctx)
      this.edge(subj.node_id, id, 'HAS_ATTRIBUTE', 1, ctx.now)
      this.edge(id, obj.node_id, 'ABOUT_CONCEPT', 1, ctx.now)
      touchedFactIds.push(id)
    }

    // ---- Claim（两跳结构：Source -CLAIMS-> Claim -ABOUT-> Target）----
    for (const c of x.claims) {
      const content = clean(c.content)
      if (content.length < 3) continue
      const src = this.ensurePerson(c.source || 'User', ctx)
      if (!src) continue
      const tgt = c.target ? (this.findPersonByName(canonicalPersonName(c.target)) ?? this.ensureConcept(c.target, ctx)) : null
      const id = stableId('claim', src.node_id, tgt?.node_id ?? '', content)
      if (this.graph.getNode(id)) continue
      this.add({
        node_id: id, node_type: 'claim', source_person_id: src.node_id, target: c.target, target_id: tgt?.node_id,
        content, confidence: 0.6, lifecycle: 'stable', evidence: pickEvidence(c.evidence, sourceText, content),
        created_at: ctx.now, updated_at: ctx.now, source_session_id: sessionId,
        embedding_text: `Claim by ${src.canonical_name}${c.target ? ` about ${c.target}` : ''}: ${content}`,
      } satisfies ClaimNode, ctx)
      this.edge(src.node_id, id, 'CLAIMS', 1, ctx.now)
      if (tgt) this.edge(id, tgt.node_id, 'ABOUT', 1, ctx.now)
    }

    if (ctx.batch.length) await this.vectorStore.addBatch(ctx.batch)   // 失败不抛出，见第 5 点
    return { nodesCreated: ctx.created.n, newEventIds, touchedFactIds }
  }

  private add(node: AnyGraphNode, ctx: Ctx) { this.graph.addNode(node); ctx.batch.push({ id: node.node_id, text: node.embedding_text }); ctx.created.n++ }
  private edge(s: string, t: string, edge_type: EdgeType, weight: number, created_at: string) {
    this.graph.addEdge({ source_id: s, target_id: t, edge_type, weight, created_at })
  }

  private ensurePerson(name: string, ctx: Ctx, aliases: string[] = []): PersonNode | null {
    const canonical = canonicalPersonName(clean(name))
    if (!canonical) return null
    const hit = this.findPersonByName(canonical) ?? aliases.map(a => this.findPersonByName(canonicalPersonName(a))).find(Boolean) ?? null
    if (hit) { for (const a of aliases) if (!hit.aliases.includes(a)) hit.aliases.push(a); return hit }
    const node: PersonNode = {
      node_id: stableId('p', canonical), node_type: 'person', canonical_name: canonical, aliases, description: `Person: ${canonical}`,
      created_at: ctx.now, updated_at: ctx.now, source_session_id: ctx.sessionId, embedding_text: [canonical, ...aliases].join(' '),
    }
    this.add(node, ctx); return node
  }

  private ensureConcept(name: string, ctx: Ctx, description?: string): ConceptNode | null {
    const norm = normalizeConceptName(clean(name))
    if (norm.length < 2) return null
    const id = stableId('concept', norm)
    const hit = this.graph.getNode(id)
    if (hit?.node_type === 'concept') return hit
    const node: ConceptNode = {
      node_id: id, node_type: 'concept', name: norm, description: clean(description) || norm,
      created_at: ctx.now, updated_at: ctx.now, source_session_id: ctx.sessionId, embedding_text: `Concept: ${norm}. ${clean(description)}`,
    }
    this.add(node, ctx); return node
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

function clean(v: unknown, max = 300): string {
  if (typeof v !== 'string') return ''
  const s = sanitizeMemoryContent(v.replace(/\s+/g, ' ').trim()).slice(0, max)
  return s && validateMemoryWrite(s).allowed ? s : ''
}

/** LLM 给出的引文必须真的出现在原文中，否则按词重叠找最相关的一行（防止幻觉引文） */
function pickEvidence(quote: unknown, source: string, key: string): string[] {
  if (typeof quote === 'string' && quote.trim().length >= 8 && source.includes(quote.trim())) return [quote.trim().slice(0, 300)]
  const keyTokens = new Set(tokenize(key))
  let best = '', bestScore = 0
  for (const line of source.split('\n')) {
    const score = tokenize(line).filter(t => keyTokens.has(t)).length
    if (score > bestScore) { best = line; bestScore = score }
  }
  return bestScore >= 2 ? [best.slice(0, 300)] : []
}

/** 从最新的消息往回切窗口，最多 maxWindows 个 */
function chunkMessages(messages: ChatMessage[], windowChars = 6000, maxWindows = 4): string[] {
  const lines = messages
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => `[${m.role}]: ${m.content.length > 1500 ? `${m.content.slice(0, 1500)} …[truncated]` : m.content}`)
  const windows: string[] = []
  let cur = ''
  for (let i = lines.length - 1; i >= 0 && windows.length < maxWindows; i--) {
    if (cur && cur.length + lines[i].length > windowChars) { windows.push(cur); cur = '' }
    cur = cur ? `${lines[i]}\n${cur}` : lines[i]
  }
  if (cur && windows.length < maxWindows) windows.push(cur)
  return windows.reverse()
}
