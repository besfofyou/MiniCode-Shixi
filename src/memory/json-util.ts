/** 按括号配对提取第一个 JSON 对象，替代贪婪正则 */
export function extractJsonObject(text: string): unknown | null {
  const s = text.replace(/```(?:json)?/gi, '')
  const start = s.indexOf('{'); if (start < 0) return null
  let depth = 0, inStr = false, esc = false
  for (let i = start; i < s.length; i++) {
    const ch = s[i]
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue }
    if (ch === '"') inStr = true
    else if (ch === '{') depth++
    else if (ch === '}' && --depth === 0) { try { return JSON.parse(s.slice(start, i + 1)) } catch { return null } }
  }
  return null
}

/** 安全的模板替换：用函数作为替换参数，避免 $&、$' 被 JS 特殊解释 */
export function fill(tpl: string, vars: Record<string, string>): string {
  return Object.entries(vars).reduce((acc, [k, v]) => acc.split(`{${k}}`).join(v), tpl)
}
