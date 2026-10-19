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
    decayDays: null,
    hardDeleteDays: null,
  },
  procedural: {
    maxEntries: 30,
    maxTotalChars: 60_000,
    decayDays: null,
    hardDeleteDays: null,
  },
} as const

export const MEMORY_CONTEXT_BUDGET = {
  maxInjectionChars: 4_000,
  reservedUtilization: 0.05,
} as const
