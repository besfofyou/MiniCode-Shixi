import { createHash } from 'node:crypto'

/** 内容哈希 ID，对应 CogMem 的 _make_id / _make_fact_id：重复写入同一内容不会产生新节点 */
export function stableId(prefix: string, ...parts: string[]): string {
  const key = parts.map(p => p.trim().toLowerCase().replace(/\s+/g, ' ')).join('|')
  return `${prefix}_${createHash('sha1').update(key).digest('hex').slice(0, 16)}`
}

export function normalizeConceptName(name: string): string {
  return name.trim().replace(/^c_/i, '').replace(/[_\s]+/g, ' ').toLowerCase().slice(0, 80)
}

const USER_ALIASES = new Set(['user', 'the user', 'speaker', 'me', 'i', '用户', '我'])
const ASSISTANT_ALIASES = new Set(['assistant', 'the assistant', 'ai', 'minicode', 'claude', '助手'])

/** CogMem 按会话隔离泛称；编码助手只有一个真实用户，应归一到固定的 Person */
export function canonicalPersonName(name: string): string {
  const l = name.trim().toLowerCase()
  if (USER_ALIASES.has(l)) return 'User'
  if (ASSISTANT_ALIASES.has(l)) return 'Assistant'
  return name.trim()
}

/** 对应 CogMem indexer._resolve_relative_time；模糊时间（recently/最近）返回 undefined，只保留原文 */
export function resolveRelativeTime(raw: string | undefined, sessionDate: string): string | undefined {
  if (!raw) return undefined
  const t = raw.trim().toLowerCase()
  if (/^\d{4}-\d{2}(-\d{2})?$/.test(t)) return t
  const base = new Date(`${sessionDate}T00:00:00Z`)
  if (Number.isNaN(base.getTime())) return undefined
  const ago = (d: number) => new Date(base.getTime() - d * 86_400_000).toISOString().slice(0, 10)
  if (/\btoday\b|今天|刚才/.test(t)) return ago(0)
  if (/yesterday|昨天/.test(t)) return ago(1)
  if (/last week|上周|上星期/.test(t)) return ago(7)
  if (/last month|上个月/.test(t)) return ago(30)
  const d = t.match(/(\d+)\s*(?:days?\s+ago|天前)/); if (d) return ago(Number(d[1]))
  const w = t.match(/(\d+)\s*(?:weeks?\s+ago|周前)/); if (w) return ago(Number(w[1]) * 7)
  return undefined
}
