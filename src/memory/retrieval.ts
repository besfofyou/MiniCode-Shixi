import { TIER_POLICIES } from './constants.js'
import { tokenize } from './filesystem.js'
import type { MemoryEntry, ScoredEntry } from './types.js'

export type SearchOptions = {
  limit: number
  recencyWeight?: number
  includeSuperseded?: boolean
}

export class MemoryRetriever {
  private readonly k1 = 1.5
  private readonly b = 0.75

  search(query: string, entries: MemoryEntry[], options: SearchOptions): ScoredEntry[] {
    const candidates = entries.filter(entry =>
      !entry.obsolete && (options.includeSuperseded || entry.supersededAt === null))
    const queryTokens = [...new Set(tokenize(query))]
    if (candidates.length === 0 || queryTokens.length === 0 || options.limit <= 0) return []

    const tokenized = candidates.map(entry => tokenize(entry.content))
    const lengths = tokenized.map(tokens => tokens.length)
    const avgDocLen = lengths.reduce((sum, length) => sum + length, 0) / lengths.length || 1
    const documentFrequency = new Map<string, number>()
    for (const tokens of tokenized) {
      for (const token of new Set(tokens)) {
        documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1)
      }
    }

    const recencyWeight = Math.max(0, Math.min(1, options.recencyWeight ?? 0.25))
    const now = Date.now()
    const scored: ScoredEntry[] = []
    candidates.forEach((entry, index) => {
      const tokens = tokenized[index]!
      const frequencies = new Map<string, number>()
      for (const token of tokens) frequencies.set(token, (frequencies.get(token) ?? 0) + 1)
      let bm25 = 0
      for (const token of queryTokens) {
        const frequency = frequencies.get(token) ?? 0
        if (frequency === 0) continue
        const df = documentFrequency.get(token) ?? 0
        const idf = Math.log(1 + (candidates.length - df + 0.5) / (df + 0.5))
        bm25 += idf * (frequency * (this.k1 + 1)) /
          (frequency + this.k1 * (1 - this.b + this.b * tokens.length / avgDocLen))
      }
      if (bm25 === 0) return

      const days = Math.max(0, (now - Date.parse(entry.lastAccessedAt)) / 86_400_000)
      const decayDays = TIER_POLICIES[entry.tier].decayDays
      const recency = decayDays ? Math.exp(-Math.LN2 * days / decayDays) : 1
      const access = Math.log1p(Math.max(0, entry.accessCount)) / 10
      const originBonus = entry.origin === 'user' ? 0.15 : 0
      const score = (1 - recencyWeight) * sigmoid(bm25) + recencyWeight * recency +
        0.05 * access + 0.1 * entry.confidence + originBonus
      scored.push({ entry, score })
    })
    return scored.sort((a, b) => b.score - a.score).slice(0, Math.floor(options.limit))
  }
}

function sigmoid(score: number): number {
  return 1 / (1 + Math.exp(-score))
}
