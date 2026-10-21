export const TIER_POLICIES = {
  episodic: {
    maxEntries: 50,
    maxTotalChars: 100_000,
    decayDays: 90,
    hardDeleteDays: 180,
  },
  semantic: {
    maxEntries: 100,
    maxTotalChars: 50_000,
    decayDays: 365,
    hardDeleteDays: null,
  },
  procedural: {
    maxEntries: 30,
    maxTotalChars: 60_000,
    decayDays: 180,
    hardDeleteDays: null,
  },
} as const

export const MEMORY_CONTEXT_BUDGET = {
  /** 默认最大注入字符数（当 controller 无明确 budget 时的 fallback） */
  maxInjectionChars: 4_000,
  reservedUtilization: 0.05,
} as const
