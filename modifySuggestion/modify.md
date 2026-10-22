我先来阅读两个项目的代码，了解它们的架构和实现方式。

现在让我深入阅读两个项目的核心源代码。

现在让我深入阅读两个项目的核心源代码文件。

现在让我阅读 SkillForge 的核心模块代码。

让我再看看 MiniCode-Shixi 的 memory 子目录核心文件和 prompt.ts。

最后再看几个关键文件来完善理解。

现在我已经完整阅读了两个项目的所有核心代码。下面给出详细的修改方案。

# MiniCode-Shixi × SkillForge 融合修改方案

## 一、两个项目的架构对比

| 维度      | MiniCode-Shixi 现状                                          | SkillForge 核心                                              |
| --------- | ------------------------------------------------------------ | ------------------------------------------------------------ |
| 记忆存储  | 三层文件系统（episodic/semantic/procedural），每条记忆一个 JSON 文件 | SkillBank：单个 JSON 文件存储 `general_skills` + `task_specific_skills` + `common_mistakes` |
| 记忆检索  | BM25 + 时间衰减 + UCB 自适应控制器                           | 关键字匹配 task_type 或 embedding cosine 排序                |
| 记忆写入  | session 结束时 LLM 蒸馏 → 写入三层                           | 外部 trajectory 一次性生成 skill bank                        |
| 生命周期  | 无 — 只有 obsolete 标记和容量淘汰                            | 四状态：trial → active → stable / retired，fitness 驱动      |
| 信用分配  | 无 — 不追踪每条记忆的使用成败                                | `record_episode(skills, success)` 追踪 usage_count/success_count |
| 进化/变异 | 无                                                           | ForgeEngine 周期执行：提升/降级/退休/稳定/变异 + 容量上限    |
| 变异实现  | 无                                                           | SkillMutator 用外部 LLM API 根据失败轨迹改写 skill           |
| 语言      | TypeScript (Node.js)                                         | Python                                                       |

## 二、设计目标与约束

1. 将 SkillForge 的四状态生命周期（trial → active → stable / retired）引入 MiniCode 的 procedural 层
2. 用已有的 `ModelAdapter`（大模型 API）替代 SkillForge 的 GPU 训练和 embedding——检索用关键字，变异用 LLM chat
3. 最小侵入——保留 MiniCode 现有的 episodic/semantic 层不变，只改造 procedural 层 + 新增 skill-bank 模块
4. "回合"即"episode"——每次用户请求 → 工具执行 → 最终回复算一个 episode，用于信用分配

## 三、新增/修改文件清单

```
src/memory/
  types.ts              ← 修改：新增 Skill 类型定义
  skill-bank.ts         ← 新增：SkillBank 核心（存储 + 检索 + 信用分配）
  skill-evolution.ts    ← 新增：ForgeEngine 生命周期管理
  skill-mutator.ts      ← 新增：LLM 驱动的 skill 变异
  runtime.ts            ← 修改：集成 SkillBank 生命周期
  distiller.ts          ← 修改：蒸馏出的 skill 写入 SkillBank
  constants.ts          ← 修改：新增 skill-bank 相关常量
src/prompt.ts           ← 修改：用 SkillBank.retrieve() 注入技能
src/tty-app.ts          ← 修改：新增 /skillbank 命令
```

## 四、逐文件详细方案

### 4.1 `src/memory/types.ts` — 新增类型

在现有 `MemoryEntry` 之后新增：

```
// ====== SkillForge Lifecycle Types ======

export type SkillLifecycle = 'trial' | 'active' | 'stable' | 'retired'

export type Skill = {
  skill_id: string
  title: string
  principle: string
  when_to_apply: string
  tags: string[]

  // SkillForge 运行时字段
  usage_count: number
  success_count: number
  lifecycle: SkillLifecycle
  parent_id: string | null
  generation: number
  children: string[]
  recent_failures: Array<{
    task: string          // 用户原始请求（截断）
    trajectory: string    // 工具调用摘要（截断）
  }>

  createdAt: string
  updatedAt: string
}

export type SkillBankData = {
  general_skills: Skill[]
  task_specific_skills: Record<string, Skill[]>
  common_mistakes: Array<{
    description: string
    how_to_avoid: string
  }>
}

export type EvolutionSummary = {
  validation_count: number
  promoted: string[]
  demoted: string[]
  retired: Array<{ skill_id: string; fitness: number; reason?: string }>
  stabilized: string[]
  mutated: Array<{ parent_id: string; child_id: string; parent_fitness: number }>
}
```

### 4.2 `src/memory/skill-bank.ts` — 新增：SkillBank 核心

这是从 SkillForge 的 `bank.py` 移植为 TypeScript 的轻量版本：

```
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
  ): { general: Skill[]; specific: Skill[]; mistakes: typeof this.data.common_mistakes; taskType: string } {
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
```

### 4.3 `src/memory/skill-evolution.ts` — 新增：ForgeEngine

从 SkillForge 的 `evolution.py` 移植，去掉 RL-specific 部分：

```
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import type { Skill, EvolutionSummary } from './types.js'
import type { SkillBank } from './skill-bank.js'

export type EvolutionConfig = {
  fitnessWarmup: number        // 使用次数不到此值时用默认 fitness
  defaultFitness: number       // warmup 期间的默认值
  retireFitnessThreshold: number
  demoteFitnessThreshold: number
  stabilizeFitnessThreshold: number
  retireMinUsage: number
  promoteMinUsage: number
  stabilizeMinUsage: number
  mutateFitnessLow: number
  mutateFitnessHigh: number
  mutateMinUsage: number
  maxMutationsPerCycle: number
  maxRetirementsPerCycle: number
  maxTotalSkills: number
  evolveEveryNTurns: number    // 每 N 个回合触发一次进化
  originalSkillProtectionUsage: number
}

export const DEFAULT_EVOLUTION_CONFIG: EvolutionConfig = {
  fitnessWarmup: 5,
  defaultFitness: 0.5,
  retireFitnessThreshold: 0.4,
  demoteFitnessThreshold: 0.6,
  stabilizeFitnessThreshold: 0.7,
  retireMinUsage: 20,
  promoteMinUsage: 10,
  stabilizeMinUsage: 30,
  mutateFitnessLow: 0.3,
  mutateFitnessHigh: 0.6,
  mutateMinUsage: 10,
  maxMutationsPerCycle: 2,
  maxRetirementsPerCycle: 3,
  maxTotalSkills: 80,
  evolveEveryNTurns: 10,          // 编码场景比 RL 慢，10 回合一次
  originalSkillProtectionUsage: 50,
}

export type MutateFn = (parent: Skill, bank: SkillBank) => Promise<Skill | null>

export class ForgeEngine {
  private config: EvolutionConfig
  private turnCount = 0
  private history: EvolutionSummary[] = []
  private readonly trackerPath: string | null

  constructor(config?: Partial<EvolutionConfig>, trackerDir?: string) {
    this.config = { ...DEFAULT_EVOLUTION_CONFIG, ...config }
    this.trackerPath = trackerDir
      ? path.join(trackerDir, 'evolution.json')
      : null
  }

  fitness(skill: Skill): number {
    const usage = skill.usage_count ?? 0
    if (usage < this.config.fitnessWarmup) return this.config.defaultFitness
    return (skill.success_count ?? 0) / Math.max(usage, 1)
  }

  // —— 核心：一次进化周期 ——
  async maybeEvolve(
    bank: SkillBank,
    mutateFn?: MutateFn,
  ): Promise<EvolutionSummary | null> {
    this.turnCount++
    if (this.turnCount % this.config.evolveEveryNTurns !== 0) return null

    const summary: EvolutionSummary = {
      validation_count: this.turnCount,
      promoted: [],
      demoted: [],
      retired: [],
      stabilized: [],
      mutated: [],
    }

    // 确保所有 skill 字段完整
    for (const skill of bank.allSkills()) {
      bank.ensureFields(skill)
    }

    // 1. Promotion: trial → active
    for (const skill of bank.allSkills()) {
      if (skill.lifecycle === 'trial' && skill.usage_count >= this.config.promoteMinUsage) {
        skill.lifecycle = 'active'
        summary.promoted.push(skill.skill_id)
      }
    }

    // 2. Demotion: stable → active (fitness 下降)
    for (const skill of bank.allSkills()) {
      if (skill.lifecycle === 'stable' && this.fitness(skill) < this.config.demoteFitnessThreshold) {
        skill.lifecycle = 'active'
        summary.demoted.push(skill.skill_id)
      }
    }

    // 3. Retirement: active → 移除
    const retireCandidates: Array<[number, Skill]> = []
    for (const skill of bank.allSkills()) {
      const minUsage = skill.generation === 0
        ? Math.max(this.config.retireMinUsage, this.config.originalSkillProtectionUsage)
        : this.config.retireMinUsage

      if (
        skill.lifecycle === 'active' &&
        this.fitness(skill) < this.config.retireFitnessThreshold &&
        skill.usage_count >= minUsage
      ) {
        retireCandidates.push([this.fitness(skill), skill])
      }
    }
    retireCandidates.sort((a, b) => a[0] - b[0])
    for (const [score, skill] of retireCandidates.slice(0, this.config.maxRetirementsPerCycle)) {
      if (bank.remove(skill.skill_id)) {
        summary.retired.push({
          skill_id: skill.skill_id,
          fitness: Math.round(score * 10000) / 10000,
        })
      }
    }

    // 4. Stabilization: active → stable
    for (const skill of bank.allSkills()) {
      if (
        skill.lifecycle === 'active' &&
        this.fitness(skill) >= this.config.stabilizeFitnessThreshold &&
        skill.usage_count >= this.config.stabilizeMinUsage
      ) {
        skill.lifecycle = 'stable'
        summary.stabilized.push(skill.skill_id)
      }
    }

    // 5. Mutation: 选取中等 fitness 的 active skill 进行变异
    if (mutateFn) {
      const mutateCandidates = bank.allSkills().filter(s =>
        s.lifecycle === 'active' &&
        this.fitness(s) >= this.config.mutateFitnessLow &&
        this.fitness(s) <= this.config.mutateFitnessHigh &&
        s.usage_count >= this.config.mutateMinUsage
      )
      const available = Math.max(0, this.config.maxTotalSkills - bank.size)
      const nMutations = Math.min(this.config.maxMutationsPerCycle, mutateCandidates.length, available)
      const remaining = [...mutateCandidates]

      for (let i = 0; i < nMutations; i++) {
        if (!remaining.length) break
        // 反向 fitness 加权采样
        const weights = remaining.map(s => Math.max(1e-6, 1.0 - this.fitness(s)))
        const totalWeight = weights.reduce((a, b) => a + b, 0)
        let r = Math.random() * totalWeight
        let parentIdx = 0
        for (let j = 0; j < weights.length; j++) {
          r -= weights[j]
          if (r <= 0) { parentIdx = j; break }
        }
        const parent = remaining.splice(parentIdx, 1)[0]
        const child = await mutateFn(parent, bank)
        if (!child) continue
        child.parent_id = parent.skill_id
        child.generation = (parent.generation ?? 0) + 1
        child.lifecycle = 'trial'
        child.usage_count = 0
        child.success_count = 0
        child.children = []
        if (bank.add(child)) {
          parent.children.push(child.skill_id)
          summary.mutated.push({
            parent_id: parent.skill_id,
            child_id: child.skill_id,
            parent_fitness: Math.round(this.fitness(parent) * 10000) / 10000,
          })
        }
      }
    }

    // 6. 容量限制
    this.enforceCap(bank, summary)

    this.history.push(summary)
    await this.saveTracker()
    await bank.save()
    return summary
  }

  private enforceCap(bank: SkillBank, summary: EvolutionSummary): void {
    while (bank.size > this.config.maxTotalSkills) {
      const candidates = bank.allSkills().filter(s =>
        s.lifecycle === 'active' || s.lifecycle === 'trial'
      )
      if (!candidates.length) break
      const victim = candidates.reduce((min, s) =>
        this.fitness(s) < this.fitness(min) ? s : min
      )
      const score = this.fitness(victim)
      if (bank.remove(victim.skill_id)) {
        summary.retired.push({
          skill_id: victim.skill_id,
          fitness: Math.round(score * 10000) / 10000,
          reason: 'capacity',
        })
      }
    }
  }

  private async saveTracker(): Promise<void> {
    if (!this.trackerPath) return
    await mkdir(path.dirname(this.trackerPath), { recursive: true })
    await writeFile(this.trackerPath, JSON.stringify(this.history, null, 2), 'utf8')
  }
}
```

### 4.4 `src/memory/skill-mutator.ts` — 新增：LLM 驱动变异

复用 MiniCode 现有的 `ModelAdapter`，不需要额外的 Python 依赖：

```
import type { ModelAdapter } from '../types.js'
import type { Skill } from './types.js'
import type { SkillBank } from './skill-bank.js'

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

    const failureText = parent.recent_failures.slice(0, 8).map(f =>
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
      const response = await this.model.next(
        [{ role: 'user', content: prompt }],
        {}
      )
      if (response.type !== 'assistant') return null
      const parsed = this.extractJSON(response.content, false) as Record<string, any> | null
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
      const response = await this.model.next(
        [{ role: 'user', content: prompt }],
        {}
      )
      if (response.type !== 'assistant') return []
      const parsed = this.extractJSON(response.content, true) as any[] | null
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
```

### 4.5 `src/memory/runtime.ts` — 修改：集成 SkillBank 生命周期

在现有 `MemoryRuntime` 类中新增以下成员和方法：

```
// —— 新增 import ——
import { SkillBank } from './skill-bank.js'
import { ForgeEngine, DEFAULT_EVOLUTION_CONFIG } from './skill-evolution.js'
import { SkillMutator } from './skill-mutator.js'

export class MemoryRuntime {
  // ... 保留现有字段 ...

  // ====== 新增字段 ======
  readonly skillBank: SkillBank
  readonly forgeEngine: ForgeEngine
  private skillMutator: SkillMutator | null = null
  private turnRetrievedSkills: Skill[] = []   // 本回合检索到的 skill

  private constructor(root?: string) {
    // ... 保留现有初始化 ...
    const bankPath = path.join(
      root ?? path.join(MINI_CODE_DIR, 'memory'),
      'skill-bank.json'
    )
    this.skillBank = new SkillBank(bankPath) // placeholder，实际在 create() 里异步加载
    this.forgeEngine = new ForgeEngine(
      undefined,
      root ?? path.join(MINI_CODE_DIR, 'memory')
    )
  }

  static async create(cwd: string, root?: string): Promise<MemoryRuntime> {
    const runtime = new MemoryRuntime(root)
    await runtime.store.ensureStructure()
    await runtime.controller.loadFromDisk()

    // 加载 SkillBank
    const bankPath = path.join(
      root ?? path.join(MINI_CODE_DIR, 'memory'),
      'skill-bank.json'
    )
    ;(runtime as any).skillBank = await SkillBank.fromJSON(bankPath)

    try {
      await bootstrapFromExisting(runtime.store, cwd)
    } catch { }

    return runtime
  }

  // —— 初始化 Mutator（需要 model，延迟注入）——
  initMutator(model: ModelAdapter): void {
    this.skillMutator = new SkillMutator(model)
  }

  // —— 在 prompt 构建前调用：检索 skill ——
  retrieveSkills(userQuery: string): ReturnType<SkillBank['retrieve']> {
    const retrieved = this.skillBank.retrieve(userQuery)
    this.turnRetrievedSkills = [...retrieved.general, ...retrieved.specific]
    return retrieved
  }

  // —— 回合结束时：信用分配 + 触发进化 ——
  async completeTurn(args: {
    outcome: 'final' | 'awaiting_user' | 'aborted' | 'max_steps' | 'failed' | 'controlled_stop'
    messages: ChatMessage[]
    toolNames?: string[]
    userQuery?: string
  }): Promise<void> {
    // ... 保留现有 completeTurn 逻辑 ...

    // ====== 新增：SkillForge 信用分配 ======
    const success = args.outcome === 'final'
    if (this.turnRetrievedSkills.length > 0) {
      const trajectory = (args.toolNames ?? []).join(' → ')
      this.skillBank.recordEpisode(
        this.turnRetrievedSkills,
        success,
        { task: args.userQuery?.slice(0, 500), trajectory }
      )
    }
    this.turnRetrievedSkills = []

    // ====== 新增：定期触发进化 ======
    const mutateFn = this.skillMutator
      ? (parent: Skill, bank: SkillBank) => this.skillMutator!.mutate(parent, bank)
      : undefined
    const evoResult = await this.forgeEngine.maybeEvolve(this.skillBank, mutateFn)
    if (evoResult) {
      // 可选：通知 TUI
      process.stderr.write(
        `[SkillForge] Evolution cycle: +${evoResult.promoted.length} promoted, ` +
        `-${evoResult.retired.length} retired, ` +
        `~${evoResult.mutated.length} mutated\n`
      )
    }

    await this.skillBank.save()
  }

  // —— 会话结束时：除了蒸馏，还分析失败生成新 skill ——
  async distill(
    messages: ChatMessage[],
    model: ModelAdapter,
    sessionId: string
  ): Promise<void> {
    // ... 保留现有 distill 逻辑 ...

    // ====== 新增：从本次会话的失败中提取新 skill ======
    if (!this.skillMutator) this.initMutator(model)
    const failures = this.collectSessionFailures(messages)
    if (failures.length > 0) {
      const newSkills = await this.skillMutator!.analyzeFailures(
        failures, this.skillBank, 2
      )
      for (const skill of newSkills) {
        this.skillBank.add(skill, 'general')
      }
      if (newSkills.length > 0) {
        await this.skillBank.save()
      }
    }
  }

  // —— 从消息中提取失败轨迹 ——
  private collectSessionFailures(
    messages: ChatMessage[]
  ): Array<{ task: string; trajectory: string }> {
    const failures: Array<{ task: string; trajectory: string }> = []
    let currentTask = ''
    const toolTrace: string[] = []
    let hadError = false

    for (const msg of messages) {
      if (msg.role === 'user' && !('internal' in msg && msg.internal)) {
        if (hadError && currentTask) {
          failures.push({ task: currentTask, trajectory: toolTrace.join(' → ') })
        }
        currentTask = msg.content.slice(0, 500)
        toolTrace.length = 0
        hadError = false
      }
      if (msg.role === 'assistant_tool_call') {
        toolTrace.push((msg as any).toolName ?? 'unknown')
      }
      if (msg.role === 'tool_result' && (msg as any).isError) {
        hadError = true
      }
    }
    if (hadError && currentTask) {
      failures.push({ task: currentTask, trajectory: toolTrace.join(' → ') })
    }
    return failures.slice(0, 8)
  }
}
```

### 4.6 `src/prompt.ts` — 修改：注入 SkillBank 技能

在 `buildSystemPrompt` 中，替换/增强现有 memory 注入部分：

```
// 在 memory extras 处理块之后，新增 SkillBank 注入：
if (memory?.store) {
  // 获取 MemoryRuntime 的 skillBank（通过 extras 传入）
  const skillBankExtras = extras?.skillBank as SkillBank | undefined
  if (skillBankExtras && memory.userQuery) {
    const retrieved = skillBankExtras.retrieve(memory.userQuery)
    const skillPrompt = skillBankExtras.formatPrompt(retrieved)
    if (skillPrompt && skillPrompt !== 'No relevant skills found.') {
      parts.push(`# Learned Skills (dynamic)\n\n${skillPrompt}`)
    }
  }
}
```

同时修改 `MemoryExtras` 类型以传递 `skillBank` 引用。

### 4.7 `src/memory/distiller.ts` — 修改：蒸馏出的 skill 写入 SkillBank

在 `DISTILL_PROMPT` 中的 skills 部分规则增加字段要求：

```
// 在 distillSessionEnd 函数末尾，return 之前增加：
// 将蒸馏出的 skills 同步写入 SkillBank（如果提供了引用）
if (extracted.skills.length > 0 && options?.skillBank) {
  const now = new Date().toISOString()
  for (const skill of extracted.skills.slice(0, maxSkills)) {
    if (typeof skill.content !== 'string' || skill.content.trim().length < 10) continue
    options.skillBank.add({
      skill_id: `distill_${randomUUID().slice(0, 8)}`,
      title: skill.content.split(/[。.!？\n]/)[0]?.slice(0, 80) ?? 'Untitled',
      principle: skill.content,
      when_to_apply: '',
      tags: safeTags(skill.tags),
      usage_count: 0,
      success_count: 0,
      lifecycle: 'trial',
      parent_id: null,
      generation: 0,
      children: [],
      recent_failures: [],
      createdAt: now,
      updatedAt: now,
    }, 'general')
  }
}
```

### 4.8 `src/memory/constants.ts` — 新增 SkillBank 相关常量

```
export const SKILL_BANK_CONFIG = {
  defaultBankFileName: 'skill-bank.json',
  maxGeneralSkills: 30,
  maxTaskSpecificPerGroup: 20,
  maxCommonMistakes: 10,
  retrieveTopK: 6,
} as const
```

### 4.9 新增 `/skillbank` 命令（`src/tty-app.ts` 中注册）

```
// 在 slash commands 处新增：
case '/skillbank': {
  const bank = memoryRuntime?.skillBank
  if (!bank) {
    appendTranscript('assistant', 'SkillBank not initialized.')
    break
  }
  const counts = bank.counts()
  const skills = bank.allSkills()
  const lines = [
    `SkillBank: ${counts.total} skills (${counts.general} general, ${counts.taskSpecific} task-specific)`,
    '',
    ...skills.map(s => {
      const fitness = s.usage_count >= 5
        ? (s.success_count / Math.max(s.usage_count, 1)).toFixed(2)
        : 'warmup'
      return `  [${s.lifecycle}] ${s.title} (fitness: ${fitness}, used: ${s.usage_count})`
    })
  ]
  appendTranscript('assistant', lines.join('\n'))
  break
}
```

## 五、数据流总结

```
用户输入
    │
    ▼
┌─────────────────────────────────────────────┐
│  buildSystemPrompt()                        │
│    ├── loadMemory()          ← 静态 MINI.md │
│    ├── controller → BM25     ← 动态三层记忆 │
│    └── skillBank.retrieve()  ← ★新增 skills │
└─────────────────────────────────────────────┘
    │ 组装 system prompt
    ▼
  agent-loop (模型 → 工具 → 模型)
    │
    ▼ 回合结束
┌─────────────────────────────────────────────┐
│  runtime.completeTurn()                     │
│    ├── skillBank.recordEpisode()  ★信用分配 │
│    ├── forgeEngine.maybeEvolve()  ★生命周期 │
│    │     ├── promote (trial→active)         │
│    │     ├── demote  (stable→active)        │
│    │     ├── retire  (active→removed)       │
│    │     ├── stabilize (active→stable)      │
│    │     └── mutate via LLM API  ★变异      │
│    └── skillBank.save()                     │
└─────────────────────────────────────────────┘
    │
    ▼ 会话结束
┌─────────────────────────────────────────────┐
│  runtime.distill()                          │
│    ├── distillSessionEnd() → 三层记忆       │
│    └── analyzeFailures()   → ★新 skill 写入 │
└─────────────────────────────────────────────┘
```

## 六、Seed Skill Bank 示例

首次运行时需要一个初始的 `skill-bank.json`，可以用 `/init` 命令或手动创建：

```
{
  "general_skills": [
    {
      "skill_id": "gen_001",
      "title": "Read Before Edit",
      "principle": "Always read the target file before making edits to understand context and avoid breaking existing code.",
      "when_to_apply": "Before any write_file or edit_file call",
      "tags": ["editing", "safety"],
      "usage_count": 0, "success_count": 0,
      "lifecycle": "active", "parent_id": null,
      "generation": 0, "children": [], "recent_failures": [],
      "createdAt": "2026-10-22T00:00:00Z", "updatedAt": "2026-10-22T00:00:00Z"
    },
    {
      "skill_id": "gen_002",
      "title": "Verify After Change",
      "principle": "After code changes, run the project's test or lint command to verify nothing is broken.",
      "when_to_apply": "After editing source files",
      "tags": ["testing", "verification"],
      "usage_count": 0, "success_count": 0,
      "lifecycle": "active", "parent_id": null,
      "generation": 0, "children": [], "recent_failures": [],
      "createdAt": "2026-10-22T00:00:00Z", "updatedAt": "2026-10-22T00:00:00Z"
    }
  ],
  "task_specific_skills": {
    "debugging": [
      {
        "skill_id": "debug_001",
        "title": "Reproduce First",
        "principle": "Before attempting a fix, reproduce the error to confirm the symptom and understand the root cause.",
        "when_to_apply": "When the user reports a bug or error",
        "tags": ["debugging"],
        "usage_count": 0, "success_count": 0,
        "lifecycle": "active", "parent_id": null,
        "generation": 0, "children": [], "recent_failures": [],
        "createdAt": "2026-10-22T00:00:00Z", "updatedAt": "2026-10-22T00:00:00Z"
      }
    ],
    "refactoring": [],
    "feature_development": []
  },
  "common_mistakes": [
    {
      "description": "Editing a file without reading it first, leading to context loss or duplicate code.",
      "how_to_avoid": "Always use read_file before write_file or edit_file."
    }
  ]
}
```

## 七、关键设计决策说明

| 决策                                                         | 理由                                                         |
| ------------------------------------------------------------ | ------------------------------------------------------------ |
| 只改造 procedural 层 + 新增 skill-bank，保留 episodic/semantic | 最小侵入；SkillForge 的 skill 概念正好对应 MiniCode 的 procedural 技能 |
| 检索用关键字匹配，不用 embedding                             | 用户说没有 GPU；SkillForge 本身的 template 模式就是零延迟纯关键字 |
| 变异用已有 ModelAdapter 走 API                               | 复用 MiniCode 配好的 API endpoint，不引入 Python 依赖        |
| 每 10 回合触发一次进化（可配置）                             | 编码场景比 RL 每步慢得多，避免过于频繁                       |
| 回合 = episode                                               | 一次用户请求到最终回复对应 SkillForge 的一个 episode         |
| 蒸馏的 skill 自动写入 SkillBank 为 trial                     | 让 distiller 产出的 skill 也进入生命周期管理                 |
| 失败分析在 session 结束时触发                                | 集中处理，避免每个回合都调 LLM                               |

这个方案把 SkillForge 的核心（SkillBank + ForgeEngine + SkillMutator）用 ~600 行 TypeScript 移植进 MiniCode，保留了四状态生命周期、fitness 驱动的进化、LLM 变异三大核心特性，同时完全不需要 GPU。