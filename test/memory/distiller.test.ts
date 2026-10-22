import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { ModelAdapter, AgentStep, ChatMessage, ModelRequestOptions } from '../../src/types.js'
import { MemoryFilesystem } from '../../src/memory/filesystem.js'
import { distillSessionEnd } from '../../src/memory/distiller.js'
import { SkillBank } from '../../src/memory/skill-bank.js'

class FixedModel implements ModelAdapter {
  constructor(private readonly response: AgentStep) {}
  async next(_messages: ChatMessage[], _options?: ModelRequestOptions): Promise<AgentStep> {
    return this.response
  }
}

describe('distillSessionEnd (procedural + SkillBank only)', () => {
  it('stores validated skills only; facts and summary are handled by the CogMem extractor', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'minicode-distiller-'))
    try {
      const store = new MemoryFilesystem(root)
      await store.ensureStructure()
      const model = new FixedModel({
        type: 'assistant',
        content: JSON.stringify({
          facts: [
            { content: 'Project uses TypeScript strict mode.', tags: ['stack'] },
            { content: 'api_key: abcdefghijklmnopqrstuvwxyz012345', tags: [] },
          ],
          skills: [{ content: 'Run npm test after changing memory modules to verify all cases.', tags: ['workflow'] }],
          summary: 'Implemented and tested the persistent memory integration.',
        }),
      })
      const messages: ChatMessage[] = [
        { role: 'user', content: 'Please inspect the project settings.' },
        { role: 'assistant', content: 'The project uses strict TypeScript.' },
        { role: 'user', content: 'What else was accomplished?' },
      ]
      const skillBank = new SkillBank(path.join(root, 'skill-bank.json'))
      const result = await distillSessionEnd(messages, model, store, 'session', { skillBank })
      assert.deepEqual(result, { factsCount: 0, skillsCount: 1 })
      assert.equal((await store.listTier('procedural')).length, 1)
      assert.equal(skillBank.size, 1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('applies the documented minimum length for skills', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'minicode-distiller-boundaries-'))
    try {
      const store = new MemoryFilesystem(root)
      await store.ensureStructure()
      const model = new FixedModel({
        type: 'assistant',
        content: JSON.stringify({
          facts: [{ content: '1234567890' }],
          skills: [
            { content: 'x'.repeat(19) },
            { content: 'x'.repeat(20) },
          ],
          summary: '1234567890',
        }),
      })
      const messages: ChatMessage[] = [
        { role: 'user', content: 'First user turn.' },
        { role: 'assistant', content: 'Assistant response.' },
        { role: 'user', content: 'Second user turn.' },
      ]
      assert.deepEqual(await distillSessionEnd(messages, model, store, 'boundary'), {
        factsCount: 0,
        skillsCount: 1,
      })
      assert.equal((await store.listTier('procedural')).length, 1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
