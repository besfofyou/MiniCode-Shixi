export const MEMORY_SCHEMA_VERSION = 1

export type MemoryTier = 'episodic' | 'semantic' | 'procedural'

export type MemoryEntry = {
  id: string
  schemaVersion: number
  tier: MemoryTier
  content: string
  createdAt: string
  updatedAt: string
  lastAccessedAt: string
  accessCount: number
  source: {
    sessionId: string
    trigger: 'auto_distill' | 'manual_tool' | 'session_end' | 'migration'
  }
  confidence: number
  supersedes: string | null
  supersededAt: string | null
  tags: string[]
  obsolete: boolean
  obsoleteReason: string | null
  contentHash: string
  origin: 'agent' | 'user'

  /** 预期持久性：durable=长期有效, session=仅本次会话上下文, volatile=很快过时 */
  durability: 'durable' | 'session' | 'volatile'
}

export type ScoredEntry = {
  entry: MemoryEntry
  score: number
}
