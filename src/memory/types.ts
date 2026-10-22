// ========== 保留原有 ==========
export const MEMORY_SCHEMA_VERSION = 2 // 升级版本号

export type MemoryTier = 'episodic' | 'semantic' | 'procedural'

// 保留原有 MemoryEntry 用于 procedural 层和向后兼容
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

// ========== 新增 PEC²F 图谱类型 ==========

/** CogMem 节点类型枚举 */
export type CogMemNodeType = 'person' | 'event' | 'concept' | 'claim' | 'fact'

/** 基础图谱节点 */
export interface GraphNode {
  node_id: string
  node_type: CogMemNodeType
  created_at: string
  updated_at: string
  source_session_id: string
  source_doc_id?: string
  embedding_text: string  // 用于生成 embedding 的文本
}

/** Person 节点 */
export interface PersonNode extends GraphNode {
  node_type: 'person'
  canonical_name: string
  aliases: string[]
  description: string
}

/** Event 节点（情景记忆核心） */
export interface EventNode extends GraphNode {
  node_type: 'event'
  title: string
  description: string
  participants: string[]   // person node_id 列表
  time_expression?: string // 原始时间表达
  resolved_time?: string   // 解析后的绝对时间
  concepts: string[]       // concept node_id 列表
  archived: boolean
}

/** Concept 节点 */
export interface ConceptNode extends GraphNode {
  node_type: 'concept'
  name: string
  description: string
  parent_concept_id?: string
}

/** Claim 节点（情景记忆：主观陈述） */
export interface ClaimNode extends GraphNode {
  node_type: 'claim'
  source_person_id: string  // 谁说的
  target?: string           // 关于什么/谁
  content: string
  confidence: number
}

/** Fact 节点（语义记忆核心） */
export interface FactNode extends GraphNode {
  node_type: 'fact'
  subject: string
  predicate: string
  object: string
  description: string
  confidence: number
  temporal_info?: string
  supported_by_event_ids: string[]  // 原始证据链
}

/** 所有节点联合类型 */
export type AnyGraphNode = PersonNode | EventNode | ConceptNode | ClaimNode | FactNode

/** 图谱边类型 */
export type EdgeType =
  | 'PARTICIPATED_IN'     // Person → Event
  | 'RELATED_TO'          // Concept ↔ Concept
  | 'ABOUT_CONCEPT'       // Event/Claim/Fact → Concept
  | 'CLAIMED_BY'          // Claim → Person
  | 'SUPPORTED_BY'        // Fact → Event（证据链）
  | 'HAPPENED_BEFORE'     // Event → Event（时间边）
  | 'HAPPENED_DURING'     // Event → Event
  | 'SUPERSEDED_BY'       // Fact → Fact（知识更新）

export interface GraphEdge {
  source_id: string
  target_id: string
  edge_type: EdgeType
  weight: number
  created_at: string
  metadata?: Record<string, unknown>
}

/** 结构化抽取结果 */
export interface ExtractionResult {
  events: Omit<EventNode, 'node_id' | 'created_at' | 'updated_at' | 'embedding_text'>[]
  facts: Omit<FactNode, 'node_id' | 'created_at' | 'updated_at' | 'embedding_text'>[]
  claims: (Omit<ClaimNode, 'node_id' | 'created_at' | 'updated_at' | 'embedding_text'> & { source?: string })[]
  persons: { name: string; aliases?: string[] }[]
  concepts: { name: string; description?: string }[]
}

/** SearchAgent 工具调用类型 */
export type SearchToolName =
  | 'semantic_search'
  | 'find_anchors'
  | 'traverse_neighbors'
  | 'find_common_ground'
  | 'get_evidence'

export interface SearchToolCall {
  tool: SearchToolName
  args: Record<string, unknown>
}

export interface SearchStepResult {
  step: number
  thought: string
  action: SearchToolName
  action_input: Record<string, unknown>
  observation: string
}

/** 记忆检索结果 */
export interface MemoryRetrievalResult {
  nodes: AnyGraphNode[]
  evidence: string[]
  reasoning_path: SearchStepResult[]
  answer_summary: string
}
