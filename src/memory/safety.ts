const INSTRUCTION_PATTERNS = [
  /\b(?:from now on|always|never|whenever|remember that you must)\b/i,
  /\b(?:ignore previous|disregard|override|bypass|forget your)\b/i,
  /\b(?:you are now|act as|pretend to be|your new role)\b/i,
]

const CREDENTIAL_PATTERNS = [
  /(?:api[_-]?key|secret|password|token)\s*[:=]\s*\S{16,}/i,
  /\bsk-[a-zA-Z0-9]{32,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\beyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{10,}/,
  /\bgh[pousr]_[a-zA-Z0-9]{30,}\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
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
  if (INSTRUCTION_PATTERNS.some(pattern => pattern.test(content))) {
    return {
      allowed: false,
      reason: 'Content contains instruction-like language that could be a prompt injection attempt.',
    }
  }
  return { allowed: true }
}

export function looksLikeCredential(content: string): boolean {
  return CREDENTIAL_PATTERNS.some(pattern => pattern.test(content))
}
