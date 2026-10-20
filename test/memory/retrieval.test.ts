import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryRetriever } from '../../src/memory/retrieval.js'
import type { MemoryEntry } from '../../src/memory/types.js'

function entry(overrides: Partial<MemoryEntry> & { id: string; content: string }): MemoryEntry {
  const now = new Date().toISOString()
  return {
    schemaVersion: 1,
    tier: 'semantic',
    createdAt: now,
    updatedAt: now,
    lastAccessedAt: now,
    accessCount: 0,
    source: { sessionId: 'test', trigger: 'manual_tool' },
    confidence: 0.7,
    supersedes: null,
    supersededAt: null,
    tags: [],
    obsolete: false,
    obsoleteReason: null,
    contentHash: 'hash',
    origin: 'agent',
    ...overrides,
  }
}

describe('MemoryRetriever', () => {
  const retriever = new MemoryRetriever()
  it('ranks relevant memories, boosts user memories, and omits unrelated entries', () => {
    const results = retriever.search('TypeScript setup', [
      entry({ id: 'agent', content: 'TypeScript setup uses strict mode.' }),
      entry({ id: 'user', content: 'TypeScript setup uses strict mode.', origin: 'user' }),
      entry({ id: 'other', content: 'Database runs on PostgreSQL.' }),
    ], { limit: 5 })
    assert.deepEqual(results.map(result => result.entry.id), ['user', 'agent', 'other'])
  })

  it('filters obsolete and superseded entries unless explicitly requested', () => {
    const entries = [
      entry({ id: 'old', content: 'React 16 application', supersededAt: new Date().toISOString() }),
      entry({ id: 'obsolete', content: 'React 17 project', obsolete: true }),
      entry({ id: 'new', content: 'React 18 application' }),
    ]
    assert.deepEqual(retriever.search('React application', entries, { limit: 5 }).map(result => result.entry.id), ['new'])
    assert.equal(retriever.search('React application', entries, { limit: 5, includeSuperseded: true }).length, 2)
  })

  it('scores unmatched candidates and handles empty and CJK queries', () => {
    const entries = [entry({ id: '1', content: '项目使用 TypeScript 严格模式' })]
    assert.equal(retriever.search('', entries, { limit: 5 }).length, 0)
    assert.equal(retriever.search('unrelated', entries, { limit: 5 }).length, 1)
    assert.equal(retriever.search('严格模式', entries, { limit: 5 }).length, 1)
  })

  it('applies exponential recency decay independently of memory tier', () => {
    const recent = entry({ id: 'recent', content: 'same matching memory', tier: 'semantic' })
    const old = entry({
      id: 'old',
      content: 'same matching memory',
      tier: 'semantic',
      lastAccessedAt: new Date(Date.now() - 60 * 86_400_000).toISOString(),
    })
    const results = retriever.search('matching memory', [old, recent], { limit: 2 })
    assert.equal(results[0]?.entry.id, 'recent')
    assert.ok(results[0]!.score > results[1]!.score)
  })
})
