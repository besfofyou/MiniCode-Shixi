import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { MemoryFilesystem } from '../../src/memory/filesystem.js'
import { migrateToGraphStore } from '../../src/memory/migration.js'
import { GraphStore } from '../../src/memory/graph-store.js'
import { VectorStore } from '../../src/memory/vector-store.js'
import { MockEmbeddingClient } from './cogmem-helpers.js'

function oldEntry(overrides: {
  id: string
  tier: 'episodic' | 'semantic'
  content: string
}): Record<string, unknown> {
  const now = new Date().toISOString()
  return {
    id: overrides.id,
    schemaVersion: 1,
    tier: overrides.tier,
    content: overrides.content,
    createdAt: now,
    updatedAt: now,
    lastAccessedAt: now,
    accessCount: 0,
    source: { sessionId: 'legacy', trigger: 'auto_distill' },
    confidence: 0.8,
    supersedes: null,
    supersededAt: null,
    tags: ['legacy'],
    obsolete: false,
    obsoleteReason: null,
    contentHash: 'hash',
    origin: 'agent',
    durability: 'durable',
  }
}

describe('migrateToGraphStore', () => {
  it('converts old episodic entries into Event nodes and semantic entries into Fact nodes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'minicode-migration-'))
    const memoryRoot = path.join(root, 'memory')
    try {
      await mkdir(path.join(memoryRoot, 'episodic'), { recursive: true })
      await mkdir(path.join(memoryRoot, 'semantic'), { recursive: true })
      await writeFile(
        path.join(memoryRoot, 'episodic', 'old_episodic.json'),
        JSON.stringify(oldEntry({ id: 'old_episodic', tier: 'episodic', content: '用户请求列出项目文件树，助手遍历了目录并输出结果。' })),
      )
      await writeFile(
        path.join(memoryRoot, 'semantic', 'old_semantic.json'),
        JSON.stringify(oldEntry({ id: 'old_semantic', tier: 'semantic', content: 'Project uses TypeScript strict mode and NodeNext modules.' })),
      )

      const store = new MemoryFilesystem(memoryRoot)
      await store.ensureStructure()
      const graph = new GraphStore()
      const vectorStore = new VectorStore(new MockEmbeddingClient())

      await migrateToGraphStore(store, graph, vectorStore)

      const stats = graph.stats()
      assert.equal(stats.events, 1)
      assert.equal(stats.facts, 1)
      assert.equal(vectorStore.size(), 2)

      const event = graph.getNodesByType<import('../../src/memory/types.js').EventNode>('event')[0]!
      assert.match(event.description, /项目文件树/)
      assert.equal(event.archived, false)

      const fact = graph.getNodesByType<import('../../src/memory/types.js').FactNode>('fact')[0]!
      assert.match(fact.description, /TypeScript strict mode/)

      // 旧文件保留备份，不删除
      assert.ok(await readFile(path.join(memoryRoot, 'episodic', 'old_episodic.json'), 'utf8'))
      assert.ok(await readFile(path.join(memoryRoot, 'semantic', 'old_semantic.json'), 'utf8'))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('skips obsolete entries and leaves an empty graph when no legacy files exist', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'minicode-migration-empty-'))
    const memoryRoot = path.join(root, 'memory')
    try {
      await mkdir(path.join(memoryRoot, 'episodic'), { recursive: true })
      const obsolete = oldEntry({ id: 'gone', tier: 'episodic', content: 'An obsolete episodic record.' })
      ;(obsolete as { obsolete: boolean }).obsolete = true
      await writeFile(path.join(memoryRoot, 'episodic', 'gone.json'), JSON.stringify(obsolete))

      const store = new MemoryFilesystem(memoryRoot)
      await store.ensureStructure()
      const graph = new GraphStore()
      const vectorStore = new VectorStore(new MockEmbeddingClient())

      await migrateToGraphStore(store, graph, vectorStore)
      assert.equal(graph.nodeCount(), 0)
      assert.equal(vectorStore.size(), 0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
