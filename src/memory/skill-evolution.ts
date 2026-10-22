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
