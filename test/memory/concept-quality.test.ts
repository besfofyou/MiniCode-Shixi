import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { GraphStore } from '../../src/memory/graph-store.js'
import { VectorStore } from '../../src/memory/vector-store.js'
import { CogMemExtractor } from '../../src/memory/extractor.js'
import { isLowValueConceptName, normalizeConceptName, stableId } from '../../src/memory/graph-ids.js'
import { migrateConceptLayer } from '../../src/memory/concept-migration.js'
import type { ClaimNode, ConceptNode, EventNode, FactNode, GraphEdge, PersonNode } from '../../src/memory/types.js'
import type { ChatMessage } from '../../src/types.js'
import { FixedModel, MockEmbeddingClient } from './cogmem-helpers.js'

describe('CogMem concept layer quality', () => {
  it('isLowValueConceptName rejects noise but keeps meaningful concepts', () => {
    const noise = [
      'introduction', 'overview', '12 commits', 'about 17.3k lines',
      '2026-10-13 to 2026-10-22', 'tool.ts → mcp.ts', '陛下，我已经完成，请您批阅',
      '26 files / 9440 lines', 'previous 10-month and 3-month project duration statements',
      'daily work logs from an external ai assistant.',
      // 连字符拼写的复合泛称词不能漏网
      'response-format', 'response style', 'user-preference', 'project-timeline',
      // 英文逗号：罗列或从句片段
      'self-built ansi tui, not ink/react', 'memory/, plan/, goal/, runtime/',
    ]
    for (const n of noise) assert.ok(isLowValueConceptName(n), `should be low value: "${n}"`)
    const good = [
      'vitest', 'test framework', 'Vitest migration', 'src/tty-app.ts', 'context compaction',
      'diff and zod', 'bin/minicode on windows',
      // 带连字符的文件名是合法概念
      'skill-bank.json', 'cogmem-graph.json',
    ]
    for (const n of good) assert.ok(!isLowValueConceptName(n), `should be kept: "${n}"`)
  })

  it('normalizeConceptName unifies separators but protects path-like names', () => {
    assert.equal(normalizeConceptName('git-history'), 'git history')
    assert.equal(normalizeConceptName('Git_History'), 'git history')
    assert.equal(normalizeConceptName('agent-loop'), 'agent loop')
    assert.equal(normalizeConceptName('The Vitest'), 'vitest')
    assert.equal(normalizeConceptName('"quoted concept"'), 'quoted concept')
    // 路径/文件名中的连字符是名称的一部分，必须保留
    assert.equal(normalizeConceptName('src/tty-app.ts'), 'src/tty-app.ts')
    assert.equal(normalizeConceptName('skill-bank.json'), 'skill-bank.json')
  })

  it('extractor filters low-value concepts, backfills descriptions, and tracks aliases/mentions', async () => {
    const extraction = JSON.stringify({
      events: [
        { title: 'User asked to migrate tests to Vitest', participants: ['User'], concepts: ['vitest', 'introduction', '12 commits'], evidence: 'migrate tests to Vitest' },
        { title: 'User reviewed repository statistics', participants: ['User'], concepts: ['2026-10-13 to 2026-10-22'] },
      ],
      facts: [
        { subject: 'project', predicate: 'uses_test_framework', object: 'vitest' },
        { subject: 'repository', predicate: 'has_commit_count', object: '12 commits' },
      ],
      claims: [],
      persons: [{ name: 'User' }],
      concepts: [
        { name: 'Vitest', description: 'Test framework the user wants to migrate the Jest suite to.' },
        { name: '12 commits', description: 'should be filtered' },
      ],
    })
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'Please migrate tests to Vitest. The repository has 12 commits since 2026-10-13 to 2026-10-22.' },
      { role: 'assistant', content: 'OK, migrating the Jest suite to Vitest now.' },
    ]
    const graph = new GraphStore()
    const extractor = new CogMemExtractor(graph, new VectorStore(new MockEmbeddingClient()), new FixedModel([extraction]))
    await extractor.extractFromMessages(msgs, 's1')

    const concepts = graph.getNodesByType<ConceptNode>('concept')
    const names = concepts.map(c => c.name)
    assert.ok(!names.includes('12 commits'), 'measurement concept from events must not be instantiated')
    assert.ok(!names.includes('introduction'), 'generic concept must not be instantiated')
    assert.ok(!names.includes('2026-10-13 to 2026-10-22'), 'date range concept must not be instantiated')
    assert.ok(!names.includes('repository'), 'subject of a skipped fact must not become an orphan concept')
    assert.ok(names.includes('vitest'), 'meaningful concept is created')

    const vitest = concepts.find(c => c.name === 'vitest')!
    assert.equal(vitest.description, 'Test framework the user wants to migrate the Jest suite to.', 'top-level description backfills event-referenced concept')
    assert.ok((vitest.aliases ?? []).includes('Vitest'), 'raw spelling recorded as alias')
    assert.equal(vitest.mention_count, 3, 'mention_count accumulates across event/fact/top-level references')

    const facts = graph.getNodesByType<FactNode>('fact')
    assert.equal(facts.length, 1)
    assert.equal(facts[0]!.object, 'vitest', 'fact with low-value object is skipped, valid fact kept')

    const events = graph.getNodesByType<EventNode>('event').sort((a, b) => a.title.localeCompare(b.title))
    assert.equal(events[0]!.concepts.length, 1, 'low-value concepts are not linked to events')
    assert.equal(events[1]!.concepts.length, 0, 'event with only low-value concepts gets no concept edge')
  })

  it('refreshes placeholder descriptions (description == name) on re-extraction', async () => {
    const graph = new GraphStore()
    const now = new Date().toISOString()
    const legacyId = stableId('concept', 'vitest')
    graph.addNode({
      node_id: legacyId, node_type: 'concept', name: 'vitest', description: 'vitest',
      created_at: now, updated_at: now, source_session_id: 'legacy', embedding_text: 'Concept: vitest. ',
    } as ConceptNode)
    const extraction = JSON.stringify({
      events: [], facts: [], claims: [], persons: [],
      concepts: [{ name: 'vitest', description: 'Fast unit test framework replacing Jest in this repo.' }],
    })
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'Remind me what test framework we picked for this repository migration work, and why we chose it over the previous setup.' },
    ]
    const extractor = new CogMemExtractor(graph, new VectorStore(new MockEmbeddingClient()), new FixedModel([extraction]))
    await extractor.extractFromMessages(msgs, 's2')

    const vitest = graph.getNode(legacyId) as ConceptNode
    assert.equal(vitest.description, 'Fast unit test framework replacing Jest in this repo.', 'placeholder description refreshed')
    assert.equal(graph.stats().concepts, 1)
  })
})

/** 构造一份"旧版抽取器"产出的遗留图谱：分隔符重复、低价值概念、垃圾 fact */
function legacyGraph(): GraphStore {
  const graph = new GraphStore()
  const now = '2026-10-23T00:00:00.000Z'
  const cid = (n: string) => stableId('concept', n)

  const person: PersonNode = {
    node_id: stableId('p', 'User'), node_type: 'person', canonical_name: 'User', aliases: [],
    description: 'Person: User', created_at: now, updated_at: now, source_session_id: 'legacy',
    embedding_text: 'User',
  }
  const mkConcept = (name: string, extra: Partial<ConceptNode> = {}): ConceptNode => ({
    node_id: cid(name), node_type: 'concept', name, description: name,            // 旧节点描述 = 名称（占位符）
    created_at: now, updated_at: now, source_session_id: 'legacy',
    embedding_text: `Concept: ${name}.`, ...extra,
  })
  const edge = (source_id: string, target_id: string): GraphEdge => ({
    source_id, target_id, edge_type: 'ABOUT_CONCEPT', weight: 1, created_at: now,
  })

  // 重复对（连字符 vs 空格）+ 单节点改名 + 低价值 + 应保留的概念
  const cGitHyphen = mkConcept('git-history')
  const cGitSpace = mkConcept('git history', {
    description: 'Commit history of the project repository', aliases: ['Git History'], mention_count: 3,
  })
  const cResponseFormat = mkConcept('response-format')      // 泛称词连字符形式
  const cTwelveCommits = mkConcept('12 commits')            // 测量值
  const cVitest = mkConcept('vitest')
  const cTtyApp = mkConcept('src/tty-app.ts')
  const cAgentLoop = mkConcept('agent-loop')                // 归一化变化 → 改名

  const event: EventNode = {
    node_id: 'event_1', node_type: 'event', title: 'User discussed the git history',
    description: 'User discussed the git history', participants: [person.node_id],
    concepts: [cGitHyphen.node_id, cResponseFormat.node_id, cVitest.node_id],
    archived: false, created_at: now, updated_at: now, source_session_id: 'legacy',
    embedding_text: 'Event: git history',
  }
  // object 是测量值 → 整条删除
  const factJunk: FactNode = {
    node_id: 'fact_junk', node_type: 'fact', subject: 'project', predicate: 'has_commit_count',
    object: '12 commits', description: 'project has_commit_count 12 commits', confidence: 0.6,
    subject_id: person.node_id, object_id: cTwelveCommits.node_id, mention_count: 1,
    source_sessions: ['s1'], created_at: now, updated_at: now, source_session_id: 'legacy',
    embedding_text: 'Fact: junk',
  }
  // subject 分别指向重复对两侧 → 合并后 (subject, predicate, object) 碰撞，需去重
  const mkAdoptedFact = (id: string, subject: ConceptNode, mentions: number, session: string): FactNode => ({
    node_id: id, node_type: 'fact', subject: subject.name, predicate: 'adopted', object: 'vitest',
    description: `${subject.name} adopted vitest`, confidence: 0.6,
    subject_id: subject.node_id, object_id: cVitest.node_id, mention_count: mentions,
    source_sessions: [session], created_at: now, updated_at: now, source_session_id: 'legacy',
    embedding_text: `Fact: ${id}`,
  })
  const factA = mkAdoptedFact('fact_a', cGitHyphen, 1, 's1')
  const factB = mkAdoptedFact('fact_b', cGitSpace, 2, 's2')
  // target 是被删的低价值概念 → 摘链保留
  const claim: ClaimNode = {
    node_id: 'claim_1', node_type: 'claim', source_person_id: person.node_id,
    target: 'response-format', target_id: cResponseFormat.node_id,
    content: 'is too noisy to be useful', confidence: 0.6,
    created_at: now, updated_at: now, source_session_id: 'legacy', embedding_text: 'Claim: 1',
  }

  for (const n of [person, cGitHyphen, cGitSpace, cResponseFormat, cTwelveCommits, cVitest, cTtyApp, cAgentLoop, event, factJunk, factA, factB, claim]) {
    graph.addNode(n)
  }
  graph.addEdge(edge(event.node_id, cGitHyphen.node_id))
  graph.addEdge(edge(event.node_id, cResponseFormat.node_id))
  graph.addEdge(edge(event.node_id, cVitest.node_id))
  graph.addEdge({ source_id: person.node_id, target_id: factJunk.node_id, edge_type: 'HAS_ATTRIBUTE', weight: 1, created_at: now })
  graph.addEdge({ source_id: cGitHyphen.node_id, target_id: factA.node_id, edge_type: 'HAS_ATTRIBUTE', weight: 1, created_at: now })
  graph.addEdge({ source_id: factA.node_id, target_id: cVitest.node_id, edge_type: 'ABOUT_CONCEPT', weight: 1, created_at: now })
  graph.addEdge({ source_id: cGitSpace.node_id, target_id: factB.node_id, edge_type: 'HAS_ATTRIBUTE', weight: 1, created_at: now })
  graph.addEdge({ source_id: factB.node_id, target_id: cVitest.node_id, edge_type: 'ABOUT_CONCEPT', weight: 1, created_at: now })
  graph.addEdge({ source_id: person.node_id, target_id: claim.node_id, edge_type: 'CLAIMS', weight: 1, created_at: now })
  graph.addEdge({ source_id: claim.node_id, target_id: cResponseFormat.node_id, edge_type: 'ABOUT', weight: 1, created_at: now })
  return graph
}

describe('migrateConceptLayer (legacy graph cleanup)', () => {
  it('removes low-value concepts, merges separator duplicates, rewires references, and dedupes collisions', () => {
    const graph = legacyGraph()
    const mergedId = stableId('concept', 'git history')

    const report = migrateConceptLayer(graph, '2026-10-24T00:00:00.000Z')
    assert.equal(report.changed, true)
    assert.equal(report.removedLowValue, 2, 'response-format and 12 commits removed')
    assert.equal(report.merged, 1, 'git-history merged into git history')
    assert.equal(report.renamed, 1, 'agent-loop renamed to agent space loop')
    assert.equal(report.droppedFacts, 1, 'fact with measurement object dropped')
    assert.equal(report.unlinkedClaims, 1, 'claim unlinked from removed concept')
    assert.equal(report.dedupedFacts, 1, 'facts colliding after merge deduped')

    // 低价值概念已消失
    assert.equal(graph.getNode(stableId('concept', 'response-format')), null)
    assert.equal(graph.getNode(stableId('concept', '12 commits')), null)

    // 合并后的规范节点：别名并集、mention 求和、非占位符描述胜出
    const merged = graph.getNode(mergedId) as ConceptNode
    assert.equal(merged.name, 'git history')
    assert.ok((merged.aliases ?? []).includes('git-history'), 'hyphen spelling kept as alias')
    assert.ok((merged.aliases ?? []).includes('Git History'), 'old alias preserved')
    assert.equal(merged.mention_count, 3)
    assert.equal(merged.description, 'Commit history of the project repository')
    const sameName = graph.getNodesByType<ConceptNode>('concept').filter(c => c.name === 'git history')
    assert.equal(sameName.length, 1, 'no duplicate git history nodes remain')

    // 单节点改名：agent-loop → agent loop，旧写法进别名
    const renamed = graph.getNode(stableId('concept', 'agent loop')) as ConceptNode
    assert.equal(renamed.name, 'agent loop')
    assert.ok((renamed.aliases ?? []).includes('agent-loop'))
    assert.equal(graph.getNode(stableId('concept', 'agent-loop')), null)

    // 保留概念原样：vitest 与路径概念
    const vitest = graph.getNode(stableId('concept', 'vitest')) as ConceptNode
    assert.equal(vitest.description, 'vitest', 'untouched single canonical node keeps placeholder')
    assert.notEqual(graph.getNode(stableId('concept', 'src/tty-app.ts')), null, 'path concept untouched')

    // fact：垃圾 fact 删除；碰撞对保留 mention 高的一条并累加
    assert.equal(graph.getNode('fact_junk'), null)
    const keptFact = graph.getNode('fact_b') as FactNode
    assert.equal(keptFact.subject_id, mergedId, 'fact subject rewired to merged node')
    assert.equal(keptFact.object_id, stableId('concept', 'vitest'))
    assert.equal(keptFact.mention_count, 3, 'mention_count summed across deduped facts')
    assert.deepEqual([...keptFact.source_sessions ?? []].sort(), ['s1', 's2'])

    // claim 保留但摘除 target 链接；event 的 concepts 引用重接
    const claim = graph.getNode('claim_1') as ClaimNode
    assert.notEqual(claim, null)
    assert.equal(claim.target_id, undefined)
    const event = graph.getNode('event_1') as EventNode
    assert.deepEqual(event.concepts, [mergedId, stableId('concept', 'vitest')])

    // 边重接：事件到合并节点的 ABOUT_CONCEPT 存在，旧 id 无边
    const mergedEdges = graph.getEdgesFor(mergedId)
    assert.ok(mergedEdges.some(e => e.source_id === 'event_1' && e.edge_type === 'ABOUT_CONCEPT'))
    assert.equal(graph.getEdgesFor(stableId('concept', 'git-history')).length, 0)

    // 向量清理提示
    assert.ok(report.staleVectorIds.includes(stableId('concept', 'git-history')))
    assert.ok(report.refreshedVectors.some(r => r.id === mergedId), 'kept-id node with new text queued for re-embed')
  })

  it('is idempotent: a second run changes nothing', () => {
    const graph = legacyGraph()
    const first = migrateConceptLayer(graph, '2026-10-24T00:00:00.000Z')
    assert.equal(first.changed, true)
    const statsAfterFirst = graph.stats()
    const second = migrateConceptLayer(graph, '2026-10-24T01:00:00.000Z')
    assert.equal(second.changed, false)
    assert.deepEqual(graph.stats(), statsAfterFirst)
  })
})
