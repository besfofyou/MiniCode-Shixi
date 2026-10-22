import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { MemoryRuntime } from '../../src/memory/runtime.js'
import { MemoryFilesystem } from '../../src/memory/filesystem.js'
import { GraphStore } from '../../src/memory/graph-store.js'
import { VectorStore } from '../../src/memory/vector-store.js'
import { CogMemExtractor } from '../../src/memory/extractor.js'
import { MemorySearchAgent } from '../../src/memory/search-agent.js'
import { MemoryConsolidator } from '../../src/memory/consolidator.js'
import type { EventNode, FactNode, PersonNode } from '../../src/memory/types.js'
import { buildSystemPrompt } from '../../src/prompt.js'
import { tryHandleLocalCommand } from '../../src/cli-commands.js'
import { createMemoryTools } from '../../src/tools/memory-tools.js'
import { FixedModel, MockEmbeddingClient } from './cogmem-helpers.js'
import type { ChatMessage } from '../../src/types.js'

const CONVERSATION: ChatMessage[] = [
  { role: 'user', content: 'Alice asked: what language does this project use? Please check the configuration files.' },
  { role: 'assistant', content: 'The project uses TypeScript with strict mode and NodeNext module resolution.' },
  { role: 'user', content: 'Thanks. Also confirm the test command works.' },
  { role: 'assistant', content: 'npm test runs the full unit test suite successfully.' },
]

const EXTRACTION_JSON = JSON.stringify({
  events: [{ type: 'event', title: 'User asked about the tech stack', participants: ['Alice'], time: 'today', concepts: ['TypeScript'] }],
  facts: [{ type: 'fact', subject: 'project', predicate: 'uses', object: 'TypeScript' }],
  claims: [],
  persons: [{ name: 'Alice' }],
  concepts: [{ name: 'TypeScript' }],
})

function makeEventNode(id: string, title: string): EventNode {
  const now = new Date().toISOString()
  return {
    node_id: id,
    node_type: 'event',
    title,
    description: `${title} — during a coding session.`,
    participants: [],
    concepts: [],
    archived: false,
    created_at: now,
    updated_at: now,
    source_session_id: 'session-1',
    embedding_text: `Event: ${title}`,
  }
}

describe('CogMem integration', () => {
  it('MemoryRuntime.create() creates an empty graph and loads the SkillBank', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'minicode-cogmem-'))
    try {
      const runtime = await MemoryRuntime.create(root, path.join(root, 'memory'))
      assert.equal(runtime.graph.nodeCount(), 0)
      assert.equal(runtime.vectorStore.size(), 0)
      assert.equal(runtime.skillBank.size, 0)
      assert.deepEqual(runtime.getStats(), { persons: 0, events: 0, concepts: 0, claims: 0, facts: 0, edges: 0 })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('extractor.extractFromMessages() creates Person/Event/Concept/Fact nodes and indexes them', async () => {
    const graph = new GraphStore()
    const vectorStore = new VectorStore(new MockEmbeddingClient())
    const extractor = new CogMemExtractor(graph, vectorStore, new FixedModel([EXTRACTION_JSON]))

    const { nodesCreated } = await extractor.extractFromMessages(CONVERSATION, 'session-1')
    assert.equal(nodesCreated, 4)

    const stats = graph.stats()
    assert.equal(stats.persons, 1)
    assert.equal(stats.events, 1)
    assert.equal(stats.concepts, 1)
    assert.equal(stats.facts, 1)
    assert.equal(stats.edges, 1) // Alice PARTICIPATED_IN the event
    assert.equal(vectorStore.size(), 4)

    const person = graph.getNodesByType<PersonNode>('person')[0]!
    assert.equal(person.canonical_name, 'Alice')
    const event = graph.getNodesByType<EventNode>('event')[0]!
    assert.deepEqual(event.participants, [person.node_id])
    const fact = graph.getNodesByType<FactNode>('fact')[0]!
    assert.equal(`${fact.subject} ${fact.predicate} ${fact.object}`, 'project uses TypeScript')
  })

  it('searchAgent.search() returns relevant Fact nodes via LLM-driven tool calls', async () => {
    const graph = new GraphStore()
    const vectorStore = new VectorStore(new MockEmbeddingClient())
    const extractor = new CogMemExtractor(graph, vectorStore, new FixedModel([EXTRACTION_JSON]))
    await extractor.extractFromMessages(CONVERSATION, 'session-1')

    const agent = new MemorySearchAgent(
      graph,
      vectorStore,
      new FixedModel([
        'TOOL: semantic_search\nARGS: {"query":"project language typescript"}',
        'FINAL_ANSWER: The project uses TypeScript.',
      ]),
    )
    const result = await agent.search('What language does the project use')
    assert.ok(result.nodes.some(n => n.node_type === 'fact' && n.object === 'TypeScript'))
    assert.equal(result.answer_summary, 'The project uses TypeScript.')
    assert.ok(result.reasoning_path.length >= 1)
    assert.equal(result.reasoning_path[0]!.action, 'semantic_search')
  })

  it('consolidator.consolidate() synthesizes Facts from 3+ Events with SUPPORTED_BY edges', async () => {
    const graph = new GraphStore()
    const vectorStore = new VectorStore(new MockEmbeddingClient())
    const events = [
      makeEventNode('event_aaa1', 'User asked about the tech stack'),
      makeEventNode('event_aaa2', 'User asked about the test command'),
      makeEventNode('event_aaa3', 'User asked about the build command'),
    ]
    for (const event of events) {
      graph.addNode(event)
      await vectorStore.add(event.node_id, event.embedding_text)
    }

    const consolidator = new MemoryConsolidator(graph, vectorStore, new FixedModel([
      JSON.stringify({
        facts: [{
          subject: 'project',
          predicate: 'uses',
          object: 'TypeScript with npm workflows',
          confidence: 0.9,
          sources: events.map(e => e.node_id),
        }],
      }),
    ]))
    const result = await consolidator.consolidate()
    assert.equal(result.factsCreated, 1)
    assert.equal(result.eventsArchived, 3)

    const fact = graph.getNodesByType<FactNode>('fact')[0]!
    assert.deepEqual(fact.supported_by_event_ids, events.map(e => e.node_id))
    assert.equal(graph.stats().edges, 3) // SUPPORTED_BY evidence chain
    assert.ok(graph.getNodesByType<EventNode>('event').every(e => e.archived))
  })

  it('graph.save() → load() persists and restores nodes and edges', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'minicode-cogmem-graph-'))
    try {
      const graph = new GraphStore()
      const now = new Date().toISOString()
      const person: PersonNode = {
        node_id: 'p_test1', node_type: 'person', canonical_name: 'Alice',
        aliases: [], description: 'Person: Alice',
        created_at: now, updated_at: now, source_session_id: 's', embedding_text: 'Person Alice',
      }
      const event = makeEventNode('event_test1', 'User asked about the stack')
      graph.addNode(person)
      graph.addNode(event)
      graph.addEdge({ source_id: person.node_id, target_id: event.node_id, edge_type: 'PARTICIPATED_IN', weight: 1, created_at: now })

      const filePath = path.join(root, 'cogmem-graph.json')
      await graph.save(filePath)

      const restored = new GraphStore()
      await restored.load(filePath)
      assert.deepEqual(restored.getNode('p_test1'), person)
      assert.deepEqual(restored.getNode('event_test1'), event)
      assert.equal(restored.edgeCount(), 1)
      assert.deepEqual(restored.getNeighbors('p_test1').map(n => n.node_id), ['event_test1'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('vectorStore.search(query) returns semantically related nodes first', async () => {
    const vectorStore = new VectorStore(new MockEmbeddingClient())
    await vectorStore.add('fact_1', 'Fact: project uses TypeScript strict mode')
    await vectorStore.add('fact_2', 'Fact: deployment pipeline runs on Friday nights')

    const results = await vectorStore.search('project typescript setup', 2)
    assert.equal(results[0]!.id, 'fact_1')
    assert.ok(results[0]!.score > 0)
  })

  it('runtime.getMemoryContext() returns formatted skill text and /memory reports graph stats', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'minicode-cogmem-runtime-'))
    const memoryRoot = path.join(root, 'memory')
    try {
      const now = '2026-01-01T00:00:00.000Z'
      await mkdir(memoryRoot, { recursive: true })
      await writeFile(path.join(memoryRoot, 'skill-bank.json'), JSON.stringify({
        general_skills: [{
          skill_id: 'skill_1',
          title: 'Run checks',
          principle: 'Always run npm run check after edits.',
          when_to_apply: '',
          tags: [],
          usage_count: 0,
          success_count: 0,
          lifecycle: 'active',
          parent_id: null,
          generation: 0,
          children: [],
          recent_failures: [],
          createdAt: now,
          updatedAt: now,
        }],
        task_specific_skills: {},
        common_mistakes: [],
      }))

      const runtime = await MemoryRuntime.create(root, memoryRoot)
      runtime.initModel(new FixedModel([]))

      // 空图谱时仅返回 SkillBank 检索结果
      const context = await runtime.getMemoryContext('npm check workflow')
      assert.match(context, /# Learned Skills \(dynamic\)/)
      assert.match(context, /Always run npm run check after edits\./)
      assert.equal(context.includes('# Recalled Memories'), false)

      // buildSystemPrompt 注入动态记忆
      const prompt = await buildSystemPrompt(root, [], {
        memory: { runtime, userQuery: 'npm check workflow' },
      })
      assert.match(prompt, /# Learned Skills \(dynamic\)/)

      // SkillForge 信用分配不受影响
      await runtime.completeTurn({ outcome: 'final', messages: [], toolNames: ['run_command'] })
      assert.equal(runtime.skillBank.data.general_skills[0]!.usage_count, 1)

      // /memory 命令包含图谱统计
      const report = await tryHandleLocalCommand('/memory', { cwd: root, memoryRuntime: runtime })
      assert.match(report ?? '', /Dynamic Memory Store/)
      assert.match(report ?? '', /CogMem Knowledge Graph/)
      assert.match(report ?? '', /persons: 0/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('memory_read tool searches the knowledge graph via the vector store', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'minicode-cogmem-tools-'))
    try {
      const graph = new GraphStore()
      const vectorStore = new VectorStore(new MockEmbeddingClient())
      const extractor = new CogMemExtractor(graph, vectorStore, new FixedModel([EXTRACTION_JSON]))
      await extractor.extractFromMessages(CONVERSATION, 'session-1')

      const store = new MemoryFilesystem(path.join(root, 'memory'))
      await store.ensureStructure()
      const tools = createMemoryTools({ store, graph, vectorStore })
      assert.deepEqual(tools.map(tool => tool.name), ['memory_read', 'memory_write', 'memory_forget'])

      const read = tools[0]!
      const result = await read.run({ query: 'project language typescript', limit: 5 }, { cwd: root })
      assert.equal(result.ok, true)
      assert.match(result.output, /project uses TypeScript/)

      const write = tools[1]!
      const written = await write.run({ tier: 'procedural', content: 'Run npm test after changing memory modules.', tags: [] }, { cwd: root })
      assert.equal(written.ok, true)

      const forget = tools[2]!
      const forgotten = await forget.run({ id: 'unknown_id', reason: 'cleanup' }, { cwd: root })
      assert.equal(forgotten.ok, true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps the instruction report available when dynamic memory health fails', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'minicode-cogmem-health-error-'))
    try {
      const expected = await tryHandleLocalCommand('/memory', { cwd: root })
      const failingRuntime = {
        proceduralStore: {
          listTierAll: async () => { throw new Error('simulated memory read failure') },
        },
        getStats: () => { throw new Error('simulated graph failure') },
      } as unknown as import('../../src/memory/runtime.js').MemoryRuntime
      const actual = await tryHandleLocalCommand('/memory', { cwd: root, memoryRuntime: failingRuntime })
      assert.equal(actual, expected)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
