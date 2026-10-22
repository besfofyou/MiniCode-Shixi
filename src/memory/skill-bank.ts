import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Skill, SkillBankData, SkillLifecycle } from './types.js'

const SKILL_DEFAULTS: Partial<Skill> = {
  usage_count: 0,
  success_count: 0,
  lifecycle: 'active' as SkillLifecycle,
  parent_id: null,
  generation: 0,
  children: [],
  recent_failures: [],
}

export class SkillBank {
  data: SkillBankData
  private readonly filePath: string

  constructor(filePath: string, data?: SkillBankData) {
    this.filePath = filePath
    this.data = data ?? {
      general_skills: [],
      task_specific_skills: {},
      common_mistakes: [],
    }
    // 确保所有 skill 具备运行时字段
    for (const skill of this.allSkills(true)) {
      this.ensureFields(skill)
    }
  }

  // —— 从 JSON 文件加载 ——
  static async fromJSON(filePath: string): Promise<SkillBank> {
    try {
      const content = await readFile(filePath, 'utf8')
      return new SkillBank(filePath, JSON.parse(content))
    } catch {
      return new SkillBank(filePath)
    }
  }

  // —— 持久化 ——
  async save(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true })
    await writeFile(this.filePath, JSON.stringify(this.data, null, 2), 'utf8')
  }

  // —— 确保字段完整 ——
  ensureFields(skill: Skill, lifecycle?: SkillLifecycle): Skill {
    for (const [key, value] of Object.entries(SKILL_DEFAULTS)) {
      if ((skill as any)[key] === undefined) {
        (skill as any)[key] = lifecycle && key === 'lifecycle' ? lifecycle : value
      }
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

  // —— 检索 —— (对应 SkillForge bank.retrieve)
  retrieve(
    userRequest: string,
    topK = 6,
    taskSpecificTopK?: number,
  ): { general: Skill[]; specific: Skill[]; mistakes: SkillBankData['common_mistakes']; taskType: string } {
    const taskType = this.detectTaskType(userRequest)
    const general = this.data.general_skills
      .filter(s => s.lifecycle !== 'retired')
      .slice(0, topK)
    let specific = (this.data.task_specific_skills[taskType] ?? [])
      .filter(s => s.lifecycle !== 'retired')
    if (taskSpecificTopK !== undefined) {
      specific = specific.slice(0, taskSpecificTopK)
    }
    return {
      general,
      specific,
      mistakes: this.data.common_mistakes.slice(0, 5),
      taskType,
    }
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
