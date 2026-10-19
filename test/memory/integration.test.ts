import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { MemoryRuntime } from '../../src/memory/runtime.js'
import { buildSystemPrompt } from '../../src/prompt.js'
import { tryHandleLocalCommand } from '../../src/cli-commands.js'
import { createMemoryTools } from '../../src/tools/memory-tools.js'

describe('ASFM integration', () => {
  it('registers tools, recalls matching facts, reports health, and tracks decisions', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'minicode-asfm-'))
    try {
      const runtime = await MemoryRuntime.create(root, path.join(root, 'memory'))
      const saved = await runtime.store.write('semantic', 'Project uses TypeScript strict mode and NodeNext modules.', { origin: 'user' })
      const tools = createMemoryTools(runtime.store, runtime.retriever, (action, success) => { void runtime.recordToolOutcome(action, success) })
      assert.deepEqual(tools.map(tool => tool.name), ['memory_read', 'memory_write', 'memory_forget'])
      for (let turn = 0; turn < 4; turn++) await runtime.completeTurn({ outcome: 'final', messages: [] })
      const prompt = await buildSystemPrompt(root, [], { memory: runtime.promptExtras('What TypeScript build settings does this project use?') })
      assert.match(prompt, /Recalled Memories/)
      assert.match(prompt, /NodeNext/)
      await runtime.completeTurn({ outcome: 'final', messages: [], toolNames: ['read_file'] })
      const report = await tryHandleLocalCommand('/memory', { cwd: root, memoryStore: runtime.store })
      assert.match(report ?? '', /Dynamic Memory Store/)
      const forget = tools[2]!
      const result = await forget.run({ id: saved.id, reason: 'test cleanup' }, { cwd: root })
      assert.equal(result.ok, true)
      assert.ok((await runtime.store.listTierAll('semantic')).find(entry => entry.id === saved.id)?.obsolete)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps unrelated content out of prompt and respects memory disable flag', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'minicode-asfm-'))
    try {
      const runtime = await MemoryRuntime.create(root, path.join(root, 'memory'))
      await runtime.store.write('semantic', 'Project uses PostgreSQL for the database.')
      const prompt = await buildSystemPrompt(root, [], { memory: runtime.promptExtras('How are files named?') })
      assert.doesNotMatch(prompt, /Recalled Memories/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
