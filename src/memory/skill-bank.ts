import { readFile, rename } from 'node:fs/promises'
import type { Skill, SkillBankData, SkillLifecycle } from './types.js'
import { tokenize } from './filesystem.js'
import { writeJsonAtomic } from './fs-util.js'

function skillDefaults(lifecycle: SkillLifecycle = 'active'): Partial<Skill> {
  const now = new Date().toISOString()
  return {
    usage_count: 0,
    success_count: 0,
    lifecycle,
    parent_id: null,
    generation: 0,
    children: [],
    recent_failures: [],
    tags: [],
    when_to_apply: '',
    createdAt: now,
    updatedAt: now,
  }
}

export type RetrieveOptions = {
  fitness?: (s: Skill) => number   // 由 ForgeEngine 注入，复用 warmup 逻辑
  exploreSlots?: number            // 留给 trial skill 的探索名额
}

export class SkillBank {
  data: SkillBankData
  private readonly filePath: string

  constructor(filePath: string, data?: Partial<SkillBankData>) {
    this.filePath = filePath
    const raw = data ?? {}
    this.data = {
      general_skills: Array.isArray(raw.general_skills) ? [...raw.general_skills] : [],
      task_specific_skills: Object.fromEntries(
        Object.entries(raw.task_specific_skills ?? {})
          .map(([k, v]) => [k, Array.isArray(v) ? [...v] : []]),
      ),
      common_mistakes: Array.isArray(raw.common_mistakes) ? [...raw.common_mistakes] : [],
    }
    // 确保所有 skill 具备运行时字段
    for (const skill of this.allSkills(true)) {
      this.ensureFields(skill)
    }
  }

  // —— 从 JSON 文件加载 ——
  static async fromJSON(filePath: string): Promise<SkillBank> {
    let content: string
    try { content = await readFile(filePath, 'utf8') }
    catch (e: any) { if (e?.code === 'ENOENT') return new SkillBank(filePath); throw e }
    try { return new SkillBank(filePath, JSON.parse(content)) }
    catch {
      await rename(filePath, `${filePath}.corrupt-${Date.now()}`).catch(() => {})  // 留底，不覆盖
      return new SkillBank(filePath)
    }
  }

  // —— 持久化 ——
  async save(): Promise<void> { await writeJsonAtomic(this.filePath, this.data) }

  // —— 确保字段完整 ——
  ensureFields(skill: Skill, lifecycle?: SkillLifecycle): Skill {
    for (const [key, value] of Object.entries(skillDefaults(lifecycle))) {
      if ((skill as any)[key] === undefined) (skill as any)[key] = value
    }
    return skill
  }

  // —— 遍历所有 skill ——
  allSkills(includeRetired = false): Skill[] {
    const skills = [
      ...this.data.general_skills,
      ...Object.values(this.data.task_specific_skills).flat(),
    ]
    return includeRetired ? skills : skills.filter(s => s.lifecycle !== 'retired')
  }

  get size(): number { return this.allSkills().length }

  getSkill(skillId: string): Skill | null {
    return this.allSkills(true).find(s => s.skill_id === skillId) ?? null
  }

  skillIds(): Set<string> {
    return new Set(this.allSkills(true).map(s => s.skill_id).filter(Boolean))
  }

  // —— 语义去重 ——
  findNearDuplicate(text: string, threshold = 0.6): Skill | null {
    const a = new Set(tokenize(text))
    if (!a.size) return null
    for (const s of this.allSkills(true)) {
      const b = new Set(tokenize(`${s.title} ${s.principle}`))
      if (!b.size) continue
      let inter = 0; for (const t of a) if (b.has(t)) inter++
      if (inter / Math.min(a.size, b.size) > threshold) return s
    }
    return null
  }

  // —— 任务类型检测（面向编码场景） ——
  detectTaskType(userRequest: string): string {
    const text = userRequest.toLowerCase()
    const groups = this.data.task_specific_skills
    if (!Object.keys(groups).length) return 'general'

    const scores: Record<string, number> = {}
    for (const group of Object.keys(groups)) {
      // 将 group 名拆分为关键词
      const keywords = group.replace(/[_-]/g, ' ').split(/\s+/)
      scores[group] = keywords.reduce(
        (sum, kw) => sum + (text.includes(kw) ? 1 : 0), 0
      )
    }
    const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0]
    return best && best[1] > 0 ? best[0] : Object.keys(groups)[0] ?? 'general'
  }

  private relevance(queryTokens: Set<string>, s: Skill): number {
    const toks = new Set(tokenize(`${s.title} ${s.when_to_apply ?? ''} ${(s.tags ?? []).join(' ')} ${s.principle}`))
    if (!toks.size || !queryTokens.size) return 0
    let hit = 0
    for (const t of toks) if (queryTokens.has(t)) hit++
    return hit / Math.sqrt(toks.size)
  }

  private rank(pool: Skill[], query: Set<string>, k: number, opts: RetrieveOptions): Skill[] {
    const fit = opts.fitness ?? (() => 0.5)
    const live = pool.filter(s => s.lifecycle !== 'retired')
    const score = (s: Skill) =>
      0.6 * this.relevance(query, s) + 0.4 * fit(s) + (s.lifecycle === 'stable' ? 0.1 : 0)
    const established = live.filter(s => s.lifecycle !== 'trial').sort((a, b) => score(b) - score(a))
    const trials = live.filter(s => s.lifecycle === 'trial')
      .sort((a, b) => (a.usage_count - b.usage_count) || (this.relevance(query, b) - this.relevance(query, a)))
    const slots = Math.min(opts.exploreSlots ?? 2, trials.length, k)
    const picked = [...established.slice(0, k - slots), ...trials.slice(0, slots)]
    // established 不够时用剩余 trial 补齐
    for (const s of trials.slice(slots)) { if (picked.length >= k) break; picked.push(s) }
    return picked
  }

  // —— 检索 —— (对应 SkillForge bank.retrieve)
  retrieve(
    userRequest: string,
    topK = 6,
    taskSpecificTopK?: number,
    opts: RetrieveOptions = {},
  ): { general: Skill[]; specific: Skill[]; mistakes: SkillBankData['common_mistakes']; taskType: string } {
    const taskType = this.detectTaskType(userRequest)
    const q = new Set(tokenize(userRequest))
    const general = this.rank(this.data.general_skills, q, topK, opts)
    const specificPool = this.data.task_specific_skills[taskType] ?? []
    const specific = this.rank(specificPool, q, taskSpecificTopK ?? specificPool.length, opts)
    return { general, specific, mistakes: this.data.common_mistakes.slice(0, 5), taskType }
  }

  // —— Prompt 渲染 ——
  formatPrompt(retrieved: ReturnType<SkillBank['retrieve']>): string {
    const sections: string[] = []
    if (retrieved.general.length) {
      sections.push(
        '### General Principles\n' +
        retrieved.general.map(s =>
          `- **${s.title}**: ${s.principle}`
        ).join('\n')
      )
    }
    if (retrieved.specific.length) {
      const title = retrieved.taskType.replace(/_/g, ' ')
      sections.push(
        `### ${title} Skills\n` +
        retrieved.specific.map(s => {
          let line = `- **${s.title}**: ${s.principle}`
          if (s.when_to_apply) line += `\n  _Apply when: ${s.when_to_apply}_`
          return line
        }).join('\n')
      )
    }
    if (retrieved.mistakes.length) {
      sections.push(
        '### Mistakes to Avoid\n' +
        retrieved.mistakes.map(m =>
          `- **Don't**: ${m.description}\n  **Instead**: ${m.how_to_avoid}`
        ).join('\n')
      )
    }
    return sections.join('\n\n') || 'No relevant skills found.'
  }

  // —— 信用分配（对应 SkillForge bank.record_episode）——
  recordEpisode(
    skills: Skill[],
    success: boolean,
    context?: { task?: string; trajectory?: string },
  ): void {
    for (const skill of skills) {
      this.ensureFields(skill)
      skill.usage_count += 1
      if (success) skill.success_count += 1
      if (!success && context?.task) {
        skill.recent_failures.push({
          task: (context.task ?? '').slice(0, 500),
          trajectory: (context.trajectory ?? '').slice(0, 1000),
        })
        // 只保留最近 15 条
        if (skill.recent_failures.length > 15) {
          skill.recent_failures = skill.recent_failures.slice(-15)
        }
      }
      skill.updatedAt = new Date().toISOString()
    }
  }

  // —— 添加新 skill ——
  add(skill: Skill, category = 'general'): boolean {
    if (!skill.skill_id || this.skillIds().has(skill.skill_id)) return false
    this.ensureFields(skill, 'trial')
    skill.lifecycle = 'trial'
    if (category === 'general') {
      this.data.general_skills.push(skill)
    } else {
      if (!this.data.task_specific_skills[category]) {
        this.data.task_specific_skills[category] = []
      }
      this.data.task_specific_skills[category].push(skill)
    }
    return true
  }

  // —— 移除 skill ——
  remove(skillId: string): boolean {
    let removed = false
    const origLen = this.data.general_skills.length
    this.data.general_skills = this.data.general_skills.filter(s => s.skill_id !== skillId)
    if (this.data.general_skills.length < origLen) removed = true

    for (const [group, skills] of Object.entries(this.data.task_specific_skills)) {
      const before = skills.length
      this.data.task_specific_skills[group] = skills.filter(s => s.skill_id !== skillId)
      if (this.data.task_specific_skills[group].length < before) removed = true
    }
    return removed
  }

  // —— 统计 ——
  counts(): { general: number; taskSpecific: number; total: number } {
    const taskSpecific = Object.values(this.data.task_specific_skills)
      .reduce((sum, arr) => sum + arr.length, 0)
    return {
      general: this.data.general_skills.length,
      taskSpecific,
      total: this.size,
    }
  }
}
