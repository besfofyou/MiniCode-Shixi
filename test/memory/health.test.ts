import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { MemoryFilesystem } from '../../src/memory/filesystem.js'
import { generateHealthReport, formatHealthReport } from '../../src/memory/health.js'

describe('memory health report (procedural tier)', () => {
  it('counts active entries, includes obsolete confidence, and uses specified placeholders', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'minicode-health-'))
    try {
      const store = new MemoryFilesystem(root)
      await store.ensureStructure()
      const active = await store.write('procedural', 'A current project workflow.', { confidence: 0.8 })
      const obsolete = await store.write('procedural', 'An obsolete project workflow.', {
        confidence: 0.2,
        tags: ['_integrity_warning'],
      })
      await store.markObsolete(obsolete.id, 'outdated')

      const activePath = path.join(root, 'procedural', `${active.id}.json`)
      const activeEntry = JSON.parse(await readFile(activePath, 'utf8')) as { lastAccessedAt: string }
      activeEntry.lastAccessedAt = new Date(Date.now() - 61 * 86_400_000).toISOString()
      await writeFile(activePath, JSON.stringify(activeEntry), 'utf8')

      const report = await generateHealthReport(store)
      assert.equal(report.totalEntries, 1)
      assert.equal(report.entriesByTier.procedural, 1)
      assert.equal(report.obsoleteCount, 1)
      assert.equal(report.integrityWarnings, 1)
      assert.equal(report.avgConfidence, 1)
      assert.equal(report.staleRatio, 1)
      assert.equal(report.duplicateRatio, 0)
      assert.equal(report.avgEntriesPerSession, 0)
      assert.doesNotMatch(formatHealthReport(report), /Duplicate ratio|Avg entries per session/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
