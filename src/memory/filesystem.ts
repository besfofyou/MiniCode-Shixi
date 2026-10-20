import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { MINI_CODE_DIR } from '../config.js'
import { TIER_POLICIES } from './constants.js'
import { validateMemoryWrite } from './safety.js'
import { MEMORY_SCHEMA_VERSION, type MemoryEntry, type MemoryTier } from './types.js'

const DEFAULT_MEMORY_ROOT = path.join(MINI_CODE_DIR, 'memory')
const TIERS: readonly MemoryTier[] = ['episodic', 'semantic', 'procedural']

function isMemoryEntry(value: unknown): value is MemoryEntry {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Partial<MemoryEntry>
  return typeof entry.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(entry.id) &&
    typeof entry.schemaVersion === 'number' && TIERS.includes(entry.tier as MemoryTier) &&
    typeof entry.content === 'string' && typeof entry.createdAt === 'string' &&
    typeof entry.updatedAt === 'string' && typeof entry.lastAccessedAt === 'string' &&
    Number.isInteger(entry.accessCount) && Number.isFinite(entry.confidence) &&
    entry.confidence! >= 0 && entry.confidence! <= 1 && Array.isArray(entry.tags) &&
    entry.tags.every(tag => typeof tag === 'string') && typeof entry.obsolete === 'boolean' &&
    typeof entry.contentHash === 'string' && (entry.origin === 'agent' || entry.origin === 'user') &&
    typeof entry.source === 'object' && entry.source !== null &&
    typeof entry.source.sessionId === 'string'
}

export class MemoryFilesystem {
  private readonly root: string
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(rootOverride?: string) {
    this.root = rootOverride ?? DEFAULT_MEMORY_ROOT
  }

  private enqueueWrite<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.writeQueue.then(fn, fn)
    this.writeQueue = result.then(() => {}, () => {})
    return result
  }

  private entryPath(tier: MemoryTier, id: string): string {
    if (!TIERS.includes(tier) || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
      throw new Error('Invalid memory tier or entry ID.')
    }
    return path.join(this.root, tier, `${id}.json`)
  }

  private async atomicWrite(filePath: string, content: string): Promise<void> {
    const tempPath = `${filePath}.${randomUUID()}.tmp`
    try {
      await writeFile(tempPath, content, 'utf8')
      await rename(tempPath, filePath)
    } catch (error) {
      await unlink(tempPath).catch(() => {})
      throw error
    }
  }

  private async appendIndex(entry: MemoryEntry): Promise<void> {
    await appendFile(path.join(this.root, '_index.jsonl'), `${JSON.stringify({
      id: entry.id,
      tier: entry.tier,
      tags: entry.tags,
      tokens: tokenize(entry.content),
      updatedAt: entry.updatedAt,
    })}\n`, 'utf8')
  }

  async ensureStructure(): Promise<void> {
    await Promise.all(TIERS.map(tier => mkdir(path.join(this.root, tier), { recursive: true })))
    const schemaPath = path.join(this.root, '_schema.json')
    try {
      await readFile(schemaPath, 'utf8')
    } catch {
      await this.atomicWrite(schemaPath, `${JSON.stringify({
        version: MEMORY_SCHEMA_VERSION,
        createdAt: new Date().toISOString(),
      }, null, 2)}\n`)
    }
    await this.pruneExpiredEpisodic()
  }

  async write(
    tier: MemoryTier,
    content: string,
    metadata: Partial<Pick<MemoryEntry, 'tags' | 'supersedes' | 'source' | 'confidence' | 'origin'>> = {},
  ): Promise<MemoryEntry> {
    const validation = validateMemoryWrite(content)
    if (!validation.allowed) throw new Error(validation.reason)
    if (!TIERS.includes(tier)) throw new Error('Invalid memory tier.')

    return this.enqueueWrite(async () => {
      const normalizedContent = content.trim()
      const now = new Date().toISOString()
      const entry: MemoryEntry = {
        id: randomUUID().slice(0, 12),
        schemaVersion: MEMORY_SCHEMA_VERSION,
        tier,
        content: normalizedContent,
        createdAt: now,
        updatedAt: now,
        lastAccessedAt: now,
        accessCount: 0,
        source: metadata.source ?? { sessionId: 'unknown', trigger: 'manual_tool' },
        confidence: Math.max(0, Math.min(1, metadata.confidence ?? 0.7)),
        supersedes: metadata.supersedes ?? null,
        supersededAt: null,
        tags: [...new Set((metadata.tags ?? []).filter(tag => typeof tag === 'string').map(tag => tag.slice(0, 100)))],
        obsolete: false,
        obsoleteReason: null,
        contentHash: createHash('sha256').update(normalizedContent).digest('hex'),
        origin: metadata.origin ?? 'agent',
      }

      if (entry.supersedes) await this.markSupersededInternal(entry.supersedes, now)
      await this.enforceCapacity(tier, normalizedContent.length)

      const filePath = this.entryPath(tier, entry.id)
      await this.atomicWrite(filePath, `${JSON.stringify(entry, null, 2)}\n`)
      await this.appendIndex(entry)
      return entry
    })
  }

  async read(tier: MemoryTier, id: string): Promise<MemoryEntry | null> {
    let filePath: string
    try {
      filePath = this.entryPath(tier, id)
    } catch {
      return null
    }
    return this.enqueueWrite(async () => {
      let entry: MemoryEntry
      try {
        const parsed: unknown = JSON.parse(await readFile(filePath, 'utf8'))
        if (!isMemoryEntry(parsed) || parsed.tier !== tier || parsed.id !== id) return null
        entry = parsed
      } catch {
        return null
      }

      const expectedHash = createHash('sha256').update(entry.content.trim()).digest('hex')
      if (entry.contentHash !== expectedHash) {
        entry.confidence = Math.min(entry.confidence, 0.1)
        entry.tags = [...new Set([...entry.tags, '_integrity_warning'])]
      }
      entry.lastAccessedAt = new Date().toISOString()
      entry.accessCount += 1
      await this.atomicWrite(filePath, `${JSON.stringify(entry, null, 2)}\n`)
      return entry
    })
  }

  async listTier(tier: MemoryTier): Promise<MemoryEntry[]> {
    return (await this.listTierAll(tier)).filter(entry => !entry.obsolete)
  }

  async listTierAll(tier: MemoryTier): Promise<MemoryEntry[]> {
    if (!TIERS.includes(tier)) return []
    let files: string[]
    try {
      files = (await readdir(path.join(this.root, tier))).filter(file => /^[A-Za-z0-9_-]{1,64}\.json$/.test(file))
    } catch {
      return []
    }
    const entries: MemoryEntry[] = []
    for (const file of files) {
      try {
        const parsed: unknown = JSON.parse(await readFile(path.join(this.root, tier, file), 'utf8'))
        if (isMemoryEntry(parsed) && parsed.tier === tier) entries.push(parsed)
      } catch {
        // Ignore corrupt entries so one file cannot break retrieval.
      }
    }
    return entries.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  async markObsolete(id: string, reason: string): Promise<boolean> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return false
    return this.enqueueWrite(async () => {
      for (const tier of TIERS) {
        const filePath = this.entryPath(tier, id)
        try {
          const entry = JSON.parse(await readFile(filePath, 'utf8')) as MemoryEntry
          entry.obsolete = true
          entry.obsoleteReason = reason.slice(0, 500)
          entry.updatedAt = new Date().toISOString()
          await this.atomicWrite(filePath, `${JSON.stringify(entry, null, 2)}\n`)
          return true
        } catch {
          // Continue searching the other tiers.
        }
      }
      return false
    })
  }

  private async markSupersededInternal(id: string, at: string): Promise<void> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return
    for (const tier of TIERS) {
      const filePath = this.entryPath(tier, id)
      try {
        const entry = JSON.parse(await readFile(filePath, 'utf8')) as MemoryEntry
        entry.supersededAt = at
        entry.updatedAt = at
        await this.atomicWrite(filePath, `${JSON.stringify(entry, null, 2)}\n`)
        return
      } catch {
        // Continue searching the other tiers.
      }
    }
  }

  private async enforceCapacity(tier: MemoryTier, incomingChars: number): Promise<void> {
    const policy = TIER_POLICIES[tier]
    if (incomingChars > policy.maxTotalChars) throw new Error(`Memory exceeds ${tier} tier capacity.`)
    for (const entry of await this.listTierAll(tier)) {
      if (entry.obsolete) await unlink(this.entryPath(tier, entry.id)).catch(() => {})
    }
    const active = await this.listTier(tier)
    let chars = active.reduce((sum, entry) => sum + entry.content.length, 0)
    const sorted = active.sort((a, b) => a.lastAccessedAt.localeCompare(b.lastAccessedAt))
    let removeCount = 0
    while (sorted.length - removeCount >= policy.maxEntries || chars + incomingChars > policy.maxTotalChars) {
      const oldest = sorted[removeCount]
      if (!oldest) break
      chars -= oldest.content.length
      removeCount++
    }
    for (const entry of sorted.slice(0, removeCount)) {
      const filePath = this.entryPath(tier, entry.id)
      entry.obsolete = true
      entry.obsoleteReason = 'capacity_overflow'
      entry.updatedAt = new Date().toISOString()
      await this.atomicWrite(filePath, `${JSON.stringify(entry, null, 2)}\n`)
    }
  }

  private async pruneExpiredEpisodic(): Promise<void> {
    const policy = TIER_POLICIES.episodic
    const now = Date.now()
    const all = await this.listTierAll('episodic')
    for (const entry of all) {
      const ageDays = (now - Date.parse(entry.lastAccessedAt)) / 86_400_000
      const obsoleteAge = (now - Date.parse(entry.updatedAt)) / 86_400_000
      if (!entry.obsolete && ageDays > policy.decayDays) {
        entry.obsolete = true
        entry.obsoleteReason = 'episodic_decay'
        entry.updatedAt = new Date(now).toISOString()
        await this.atomicWrite(this.entryPath('episodic', entry.id), `${JSON.stringify(entry, null, 2)}\n`)
      } else if (entry.obsolete && obsoleteAge > policy.hardDeleteDays) {
        await unlink(this.entryPath('episodic', entry.id)).catch(() => {})
      }
    }
  }

  getRoot(): string {
    return this.root
  }
}

export function tokenize(text: string): string[] {
  const normalized = text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]/g, ' ')
    .toLowerCase()
  const latin = normalized.match(/[a-z0-9]+/g) ?? []
  const cjkRuns = normalized.match(/[\u3400-\u9fff]+/g) ?? []
  const cjk = cjkRuns.flatMap(run => run.length === 1
    ? [run]
    : Array.from({ length: run.length - 1 }, (_, index) => run.slice(index, index + 2)))
  return [...latin, ...cjk].filter(token => token.length > 1)
}
