import { createHash } from 'node:crypto'

/** 内容哈希 ID，对应 CogMem 的 _make_id / _make_fact_id：重复写入同一内容不会产生新节点 */
export function stableId(prefix: string, ...parts: string[]): string {
  const key = parts.map(p => p.trim().toLowerCase().replace(/\s+/g, ' ')).join('|')
  return `${prefix}_${createHash('sha1').update(key).digest('hex').slice(0, 16)}`
}

export function normalizeConceptName(name: string): string {
  const stripped = name
    .trim()
    .replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, '')          // 去掉包裹引号
    .replace(/[.!?;:，。！？；、]+$/g, '')               // 去掉尾随句读
    .replace(/^the\s+/i, '')                            // 去掉前导 the
    .replace(/^c_/i, '')
  // 路径/文件名（含 . / \）中的连字符是名称的一部分，必须保留；
  // 普通短语的连字符与空格等价，统一成空格，避免 "git-history" 与 "git history" 分裂成两个节点
  const unified = /[./\\]/.test(stripped)
    ? stripped.replace(/[_\s]+/g, ' ').replace(/-{2,}/g, '-')
    : stripped.replace(/[-_\s]+/g, ' ')
  return unified.trim().toLowerCase().slice(0, 80)
}

/**
 * 泛称词：单独出现时几乎不携带信息，不能作为图概念（CogMem 依赖 prompt 的
 * "salient topic phrases" 约束；这里再加一道确定性安全网）。
 * 注意：不含 "project"/"user"——它们是 Fact 的合法 subject。
 */
const GENERIC_CONCEPT_WORDS = new Set([
  'introduction', 'overview', 'identity', 'greeting', 'summary', 'conclusion',
  'question', 'answer', 'discussion', 'conversation', 'chat', 'help', 'request',
  'response', 'task', 'update', 'change', 'other', 'misc', 'thing', 'stuff',
  'timeline', 'structure', 'code', 'testing', 'architecture',
  'response format', 'response style', 'user preference', 'project timeline',
])

/** 数字 + 单位的测量短语，如 "12 commits" / "17.3k lines" / "10-month" */
const MEASUREMENT_RE = /\d+(?:\.\d+)?\s*k?\s*(?:files?|lines?|commits?|tests?|modules?|declarations?|months?|days?|weeks?|years?|hours?|minutes?)\b/i

/** 低价值概念判定：泛称词、纯数字/测量值、日期区间、箭头链、引文式片段 */
export function isLowValueConceptName(name: string): boolean {
  const s = name.trim()
  if (!s) return true
  // 连字符与空格等价后再查表，"response-format" 也能命中 "response format"
  const norm = s.toLowerCase().replace(/[-_\s]+/g, ' ').replace(/^the\s+/i, '').trim()
  if (GENERIC_CONCEPT_WORDS.has(norm)) return true
  if (s.length > 45) return true                                     // 概念应是短语而非句子
  if (norm.split(' ').filter(Boolean).length > 6) return true        // 超过 6 个词按句子处理
  if (/^[0-9]/.test(norm)) return true                               // 数字开头："12 commits"、"2026-10-13 to ..."
  if (MEASUREMENT_RE.test(norm)) return true                         // 内嵌测量值："x has 174 lines"
  if (/\d{4}-\d{2}-\d{2}/.test(norm)) return true                    // 日期
  if (/→|->/.test(s)) return true                                    // 箭头链："tool.ts → mcp.ts"
  if (/[，。！？；、“”]/.test(s)) return true                          // 中文句读 → 引文/句子
  if (/[,]/.test(s)) return true                                     // 英文逗号 → 罗列（"a.ts, b.ts"）或从句片段
  if (/[.!?;]$/.test(s)) return true                                 // 句末标点 → 句子片段
  return false
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
