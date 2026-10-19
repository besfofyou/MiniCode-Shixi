import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import type { MemoryFilesystem } from './filesystem.js'
import { validateMemoryWrite } from './safety.js'

export async function bootstrapFromExisting(
  store: MemoryFilesystem,
  cwd: string,
): Promise<{ imported: number }> {
  const existingEntries = await store.listTierAll('semantic')
  if (existingEntries.some(entry => entry.tags.includes('_bootstrap'))) return { imported: 0 }

  let imported = 0
  const skillsDir = path.join(cwd, '.mini-code', 'skills')
  try {
    const directories = await readdir(skillsDir, { withFileTypes: true })
    for (const directory of directories) {
      if (!directory.isDirectory()) continue
      try {
        const content = (await readFile(path.join(skillsDir, directory.name, 'SKILL.md'), 'utf8')).trim().slice(0, 4_000)
        if (!validateMemoryWrite(content).allowed) continue
        await store.write('procedural', content, {
          tags: ['_bootstrap', `skill:${directory.name}`],
          source: { sessionId: 'bootstrap', trigger: 'migration' },
          confidence: 0.9,
          origin: 'user',
        })
        imported++
      } catch {
        // A single unavailable or unsafe skill must not block startup.
      }
    }
  } catch {
    // Project skill migration is optional.
  }

  if (imported > 0) {
    await store.write('semantic', `Memory bootstrap completed (${imported} skills imported).`, {
      tags: ['_bootstrap'],
      source: { sessionId: 'bootstrap', trigger: 'migration' },
      confidence: 1,
      origin: 'agent',
    })
  }
  return { imported }
}
