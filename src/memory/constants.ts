// ---- 保留原有 ----
export const TIER_POLICIES = {
  // episodic 和 semantic 的策略现在由 GraphStore 管理
  procedural: {
    maxEntries: 30,
    maxTotalChars: 60_000,
    decayDays: 180,
    hardDeleteDays: null,
  },
} as const

export const MEMORY_CONTEXT_BUDGET = {
  maxInjectionChars: 4_000,
  reservedUtilization: 0.05,
} as const

export const SKILL_BANK_CONFIG = {
  defaultBankFileName: 'skill-bank.json',
  maxGeneralSkills: 30,
  maxTaskSpecificPerGroup: 20,
  maxCommonMistakes: 10,
  retrieveTopK: 6,
} as const

// ---- 新增 ----
export const COGMEM_CONFIG = {
  /** SearchAgent 最大迭代次数 */
  searchMaxIterations: 4,
  /** 向量检索默认 topK */
  semanticSearchTopK: 10,
  /** 锚点检索默认 topK */
  findAnchorsTopK: 5,
  /** 图遍历默认深度 */
  traverseMaxDepth: 1,
  /** 图遍历默认最大结果数 */
  traverseMaxResults: 10,
  /** 记忆巩固最小 Event 数阈值 */
  consolidationMinEvents: 3,
  /** 注入 prompt 的最大节点数 */
  maxInjectedNodes: 8,
} as const
