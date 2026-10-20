import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { MemoryFilesystem } from '../../src/memory/filesystem.js'
import { bootstrapFromExisting } from '../../src/memory/migration.js'

describe('bootstrapFromExisting', () => {
  it('imports trimmed skills up to 3000 characters and writes a bootstrap marker', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'minicode-migration-'))
    const skillsDir = path.join(root, '.mini-code', 'skills', 'build')
    try {
      await mkdir(skillsDir, { recursive: true })
      await writeFile(path.join(skillsDir, 'SKILL.md'), 'x'.repeat(3_200), 'utf8')
      const store = new MemoryFilesystem(path.join(root, 'memory'))
      await store.ensureStructure()

      assert.deepEqual(await bootstrapFromExisting(store, root), { imported: 1 })
      const skill = (await store.listTier('procedural'))[0]
      assert.equal(skill?.content.length, 3_000)
      assert.equal(skill?.tags.includes('_bootstrap'), true)
      const marker = (await store.listTier('semantic'))[0]
      assert.equal(marker?.content, 'Bootstrapped 1 skills from .mini-code/skills/')
      assert.deepEqual(await bootstrapFromExisting(store, root), { imported: 0 })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('skips empty skill files and leaves the store unchanged when no skills import', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'minicode-migration-empty-'))
    const skillsDir = path.join(root, '.mini-code', 'skills', 'empty')
    try {
      await mkdir(skillsDir, { recursive: true })
      await writeFile(path.join(skillsDir, 'SKILL.md'), '  \n  ', 'utf8')
      const store = new MemoryFilesystem(path.join(root, 'memory'))
      await store.ensureStructure()

      assert.deepEqual(await bootstrapFromExisting(store, root), { imported: 0 })
      assert.equal((await store.listTier('semantic')).length, 0)
      assert.equal((await store.listTier('procedural')).length, 0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
