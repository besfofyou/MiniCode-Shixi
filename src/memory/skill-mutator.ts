import type { ModelAdapter } from '../types.js'
import type { Skill } from './types.js'
import type { SkillBank } from './skill-bank.js'
import { memoryModelText } from './model-call.js'

export class SkillMutator {
  private model: ModelAdapter

  constructor(model: ModelAdapter) {
    this.model = model
  }

  private nextId(bank: SkillBank, prefix: string): string {
    const pattern = new RegExp(`^${prefix}_(\\d+)$`)
    let maxIndex = 0
    for (const skill of bank.allSkills(true)) {
      const match = skill.skill_id.match(pattern)
      if (match) maxIndex = Math.max(maxIndex, parseInt(match[1], 10))
    }
    return `${prefix}_${String(maxIndex + 1).padStart(3, '0')}`
  }

  private extractJSON(text: string, array: boolean): unknown {
    const startChar = array ? '[' : '{'
    const endChar = array ? ']' : '}'
    const start = text.indexOf(startChar)
    const end = text.lastIndexOf(endChar)
    if (start < 0 || end <= start) return null
    try { return JSON.parse(text.slice(start, end + 1)) }
    catch { return null }
  }

  // —— 变异：根据父 skill + 失败记录生成改进版 ——
  async mutate(parent: Skill, bank: SkillBank): Promise<Skill | null> {
    const childId = this.nextId(bank, 'evo')
    const fitness = parent.usage_count > 0
      ? parent.success_count / parent.usage_count
      : 0

    const failureText = parent.recent_failures.slice(-8).map(f =>
      `- Task: ${f.task.slice(0, 300)}\n  Trajectory: ${f.trajectory.slice(0, 500)}`
    ).join('\n') || 'No failure trace was recorded.'

    const prompt = `Improve the following reusable coding-assistant skill.
Return only one JSON object with title, principle, and when_to_apply.

Parent skill:
- title: ${parent.title}
- principle: ${parent.principle}
- when to apply: ${parent.when_to_apply}
- fitness: ${fitness.toFixed(3)}
- usage: ${parent.usage_count}
- successes: ${parent.success_count}

Recent failures where this skill was active but the task failed:
${failureText}`

    try {
      const text = await memoryModelText(this.model, [{ role: 'user', content: prompt }])
      if (!text) return null
      const parsed = this.extractJSON(text, false) as Record<string, any> | null
      if (!parsed || !parsed.title || !parsed.principle) return null

      return {
        skill_id: childId,
        title: parsed.title,
        principle: parsed.principle,
        when_to_apply: parsed.when_to_apply ?? '',
        tags: parent.tags ?? [],
        usage_count: 0,
        success_count: 0,
        lifecycle: 'trial',
        parent_id: parent.skill_id,
        generation: (parent.generation ?? 0) + 1,
        children: [],
        recent_failures: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
    } catch {
      return null
    }
  }

  // —— 从失败轨迹生成全新 skill ——
  async analyzeFailures(
    failures: Array<{ task: string; trajectory: string }>,
    bank: SkillBank,
    maxNew = 3,
  ): Promise<Skill[]> {
    if (!failures.length) return []
    const existingTitles = bank.allSkills(true).map(s => s.title).slice(0, 100)
    const examples = failures.slice(0, 8).map(f =>
      `- Task: ${f.task.slice(0, 300)}\n  Trajectory: ${f.trajectory.slice(0, 600)}`
    ).join('\n')

    const prompt = `Suggest up to ${maxNew} reusable skills for a terminal coding assistant.
Return only a JSON array. Every item must contain title, principle, and when_to_apply.
Do not repeat an existing title.

Existing titles:
${JSON.stringify(existingTitles)}

Failed episodes:
${examples}`

    try {
      const text = await memoryModelText(this.model, [{ role: 'user', content: prompt }])
      if (!text) return []
      const parsed = this.extractJSON(text, true) as any[] | null
      if (!Array.isArray(parsed)) return []

      const startId = this.nextId(bank, 'dyn')
      const startIndex = parseInt(startId.split('_')[1], 10)
      const now = new Date().toISOString()

      return parsed.slice(0, maxNew)
        .filter(item => item?.title && item?.principle)
        .map((item, offset) => ({
          skill_id: `dyn_${String(startIndex + offset).padStart(3, '0')}`,
          title: item.title,
          principle: item.principle,
          when_to_apply: item.when_to_apply ?? '',
          tags: [],
          usage_count: 0,
          success_count: 0,
          lifecycle: 'trial' as const,
          parent_id: null,
          generation: 0,
          children: [],
          recent_failures: [],
          createdAt: now,
          updatedAt: now,
        }))
    } catch {
      return []
    }
  }
}
