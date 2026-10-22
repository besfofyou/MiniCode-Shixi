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

// ====== SkillForge Lifecycle Types ======

export type SkillLifecycle = 'trial' | 'active' | 'stable' | 'retired'

export type Skill = {
  skill_id: string
  title: string
  principle: string
  when_to_apply: string
  tags: string[]

  // SkillForge 运行时字段
  usage_count: number
  success_count: number
  lifecycle: SkillLifecycle
  parent_id: string | null
  generation: number
  children: string[]
  recent_failures: Array<{
    task: string          // 用户原始请求（截断）
    trajectory: string    // 工具调用摘要（截断）
  }>

  createdAt: string
  updatedAt: string
}

export type SkillBankData = {
  general_skills: Skill[]
  task_specific_skills: Record<string, Skill[]>
  common_mistakes: Array<{
    description: string
    how_to_avoid: string
  }>
}

export type EvolutionSummary = {
  validation_count: number
  promoted: string[]
  demoted: string[]
  retired: Array<{ skill_id: string; fitness: number; reason?: string }>
  stabilized: string[]
  mutated: Array<{ parent_id: string; child_id: string; parent_fitness: number }>
}

export type ScoredEntry = {
  entry: MemoryEntry
  score: number
}
