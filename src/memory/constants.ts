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
