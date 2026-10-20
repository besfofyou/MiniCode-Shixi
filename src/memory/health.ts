import type { MemoryFilesystem } from './filesystem.js'
import type { MemoryTier } from './types.js'

export type StoreHealthReport = {
  timestamp: string
  totalEntries: number
  entriesByTier: Record<string, number>
  obsoleteCount: number
  supersededCount: number
  avgConfidence: number
  integrityWarnings: number
  duplicateRatio: number
  staleRatio: number
  avgEntriesPerSession: number
}

export async function generateHealthReport(store: MemoryFilesystem): Promise<StoreHealthReport> {
  const tiers: MemoryTier[] = ['episodic', 'semantic', 'procedural']
  let totalEntries = 0
  let obsoleteCount = 0
  let supersededCount = 0
  let integrityWarnings = 0
  let confidenceSum = 0
  let staleCount = 0
  const entriesByTier: Record<string, number> = {}
  const now = Date.now()

  for (const tier of tiers) {
    const entries = await store.listTierAll(tier)
    const active = entries.filter(entry => !entry.obsolete)
    entriesByTier[tier] = active.length
    totalEntries += active.length
    for (const entry of entries) {
      if (entry.obsolete) obsoleteCount++
      if (entry.supersededAt) supersededCount++
      if (entry.tags.includes('_integrity_warning')) integrityWarnings++
      confidenceSum += entry.confidence
      if (!entry.obsolete && (now - Date.parse(entry.lastAccessedAt)) / 86_400_000 > 60) staleCount++
    }
  }

  return {
    timestamp: new Date().toISOString(),
    totalEntries,
    entriesByTier,
    obsoleteCount,
    supersededCount,
    avgConfidence: totalEntries > 0 ? confidenceSum / totalEntries : 0,
    integrityWarnings,
    duplicateRatio: 0,
    staleRatio: totalEntries > 0 ? staleCount / totalEntries : 0,
    avgEntriesPerSession: 0,
  }
}

export function formatHealthReport(report: StoreHealthReport): string {
  const stalePercent = Math.round(report.staleRatio * 100)
  const staleAbsolute = Math.round(report.staleRatio * report.totalEntries)
  return [
    'Dynamic Memory Store:',
    `  Total entries: ${report.totalEntries} (episodic: ${report.entriesByTier.episodic ?? 0}, semantic: ${report.entriesByTier.semantic ?? 0}, procedural: ${report.entriesByTier.procedural ?? 0})`,
    `  Avg confidence: ${report.avgConfidence.toFixed(2)}`,
    `  Stale ratio: ${stalePercent}% (${staleAbsolute} entries not accessed in 60+ days)`,
    `  Integrity warnings: ${report.integrityWarnings}`,
    `  Obsolete (soft-deleted): ${report.obsoleteCount}`,
    `  Superseded (ghost): ${report.supersededCount}`,
  ].join('\n')
}
