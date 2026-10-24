import type { Skill } from './types.js'

const INJECTION_PATTERNS = [
  /\b(?:ignore|disregard|forget)\s+(?:all\s+)?(?:previous|prior|above|your)\s+(?:instructions?|rules?|prompts?)\b/i,
  /\b(?:override|bypass)\s+(?:the\s+)?(?:system|safety|instructions?|rules?)\b/i,
  /\b(?:you are now|pretend to be|your new role)\b/i,
  /\bfrom now on,?\s+you\s+(?:must|will|are)\b/i,
  /忽略(?:之前|以上|所有)的?(?:指令|规则|提示)/,
  /你现在是|假装你是/,
]

const CREDENTIAL_PATTERNS = [
  /(?:api[_-]?key|secret|password|token)\s*[:=]\s*\S{16,}/i,
  /\bsk-[a-zA-Z0-9]{32,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\beyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{10,}/,
  /\bgh[pousr]_[a-zA-Z0-9]{30,}\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
]

const VOLATILE_STATE_PATTERNS = [
  /\b(?:currently|当前|目前|现在)\s+(?:为空|is empty|未初始化|not initialized|on branch)\b/i,
  /\b(?:暂时|临时|temporarily)\b/i,
]

const ABSOLUTE_PATH_PATTERNS = [
  /[A-Z]:\\[\\/]/,
  /\/(?:home|Users|root|tmp|var)\/\S+/,
]

export type ValidationResult = {
  allowed: boolean
  reason?: string
}

export function validateMemoryWrite(content: string): ValidationResult {
  if (!content.trim()) {
    return { allowed: false, reason: 'Content cannot be empty.' }
  }
  if (content.length > 4_000) {
    return { allowed: false, reason: 'Content exceeds 4000 character limit.' }
  }
  if (looksLikeCredential(content)) {
    return { allowed: false, reason: 'Content appears to contain credentials or secrets.' }
  }
  if (INJECTION_PATTERNS.some(p => p.test(content))) {
    return { allowed: false, reason: 'Content looks like a prompt-injection attempt.' }
  }
  return { allowed: true }
}

export function looksLikeCredential(content: string): boolean {
  return CREDENTIAL_PATTERNS.some(pattern => pattern.test(content))
}

export function looksLikeVolatileState(content: string): boolean {
  return VOLATILE_STATE_PATTERNS.some(pattern => pattern.test(content))
}

/**
 * 写入前对内容做清洗，移除绝对路径但不阻止写入。
 * 在 writeValidated 中调用。
 */
export function sanitizeMemoryContent(content: string): string {
  let sanitized = content
  for (const pattern of ABSOLUTE_PATH_PATTERNS) {
    sanitized = sanitized.replace(new RegExp(pattern.source, 'g'), '<local-path>')
  }
  return sanitized
}

/** 所有写入技能库的内容都经过这一个出口 */
export function sanitizeSkill(s: Skill): Skill | null {
  const title = sanitizeMemoryContent(String(s.title ?? '').trim().slice(0, 120))
  const principle = sanitizeMemoryContent(String(s.principle ?? '').trim().slice(0, 500))
  const when = sanitizeMemoryContent(String(s.when_to_apply ?? '').trim().slice(0, 300))
  if (title.length < 3 || principle.length < 10) return null
  if (!validateMemoryWrite(`${title}\n${principle}\n${when}`).allowed) return null
  return { ...s, title, principle, when_to_apply: when }
}
