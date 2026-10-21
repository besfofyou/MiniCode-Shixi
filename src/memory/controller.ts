import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

// ---- 新增：多维复合奖励 ----
export interface RewardSignal {
  /** 任务是否成功完成 (0 或 1) */
  taskSuccess: number
  /** 检索到的条目是否实际出现在后续 assistant 回复中 (0~1) */
  retrievalHitRate: number
  /** 注入记忆后是否触发了 compact/snip (惩罚项, 0 或 1, 1=未触发) */
  noCompactPenalty: number
  /** 工具错误率的反向指标 (1 - errorRate) */
  toolSuccessRate: number
}

export function computeCompositeReward(signal: RewardSignal): number {
  // 加权组合，权重可调
  const w = {
    taskSuccess: 0.35,
    retrievalHitRate: 0.30,
    noCompactPenalty: 0.20,
    toolSuccessRate: 0.15,
  }
  const raw =
    w.taskSuccess * signal.taskSuccess +
    w.retrievalHitRate * signal.retrievalHitRate +
    w.noCompactPenalty * signal.noCompactPenalty +
    w.toolSuccessRate * signal.toolSuccessRate
  return Math.max(0, Math.min(1, raw))
}

export type Phase = 'early' | 'late'
export type StoreState = 'empty' | 'sparse' | 'moderate' | 'rich'
export type AgentState = 'normal' | 'stuck' | 'repeating'
export type ActionType = 'retrieve' | 'inject_procedural' | 'noop'
export type ContextPressure = 'low' | 'medium' | 'high' | 'critical'
export type QueryIntent = 'knowledge' | 'debug' | 'generate' | 'chat' | 'unknown'
export type StoreQuality = 'high' | 'mixed' | 'low'

type ActionStats = {
  value: number
  count: number
  /** 最后更新时间戳 (epoch ms)；不存在时视为"很久以前" */
  lastUpdatedAt?: number
}

export interface MemoryDecision {
  action: ActionType
  stateKey: string
  params: {
    topK: number
    tier: 'all' | 'semantic' | 'procedural'
    /** 新增：最大注入字符数 */
    budgetChars: number
  }
}

export interface ControllerState {
  phase: Phase
  storeState: StoreState
  agentState: AgentState
  /** 新增：context window 压力等级 */
  contextPressure: ContextPressure
  /** 新增：查询意图 */
  queryIntent: QueryIntent
  /** 新增：上一轮是否做了检索 */
  lastTurnRetrieved: boolean
  /** 新增：store 整体质量 */
  storeQuality: StoreQuality
}

const ACTIONS: ActionType[] = ['noop', 'retrieve', 'inject_procedural']

const INTENT_PATTERNS: Array<[QueryIntent, RegExp[]]> = [
  ['debug', [
    /\b(bug|error|fix|debug|issue|broken|fail|crash|报错|修复|错误|异常)\b/i,
    /\bwhy\s+(does|is|did|doesn't|isn't)\b/i,
    /为什么.*(不|报|错|失败)/,
  ]],
  ['knowledge', [
    /\b(explain|understand|what\s+is|how\s+does|architecture|设计|原理|架构|理解|解释)\b/i,
    /\b(overview|summary|describe|概述|总结)\b/i,
  ]],
  ['generate', [
    /\b(create|write|generate|implement|add|build|make|新建|创建|实现|编写|添加)\b/i,
    /\b(refactor|optimize|重构|优化)\b/i,
  ]],
  ['chat', [
    /^(hi|hello|hey|thanks|ok|好的|谢谢|你好)\s*[!.?]?$/i,
    /^\/.+/, // slash commands
  ]],
]

export function classifyQueryIntent(query: string): QueryIntent {
  const trimmed = query.trim()
  if (!trimmed) return 'unknown'
  for (const [intent, patterns] of INTENT_PATTERNS) {
    if (patterns.some(p => p.test(trimmed))) return intent
  }
  return 'unknown'
}

export class AdaptiveMemoryController {
  private readonly qTable = new Map<string, Map<ActionType, ActionStats>>()
  private readonly persistPath: string
  private static readonly DECAY_HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000 // 7 天

  constructor(persistPath: string) {
    this.persistPath = persistPath
    this.warmStartPriors()
  }

  private warmStartPriors(): void {
    const priors: Array<[string, ActionType, number]> = [
      // low pressure (原有 priors 默认对应 low)
      ['early:empty:normal:low', 'noop', 0.8],
      ['early:sparse:normal:low', 'retrieve', 0.4],
      ['early:moderate:normal:low', 'retrieve', 0.5],
      ['early:rich:normal:low', 'retrieve', 0.6],
      ['late:sparse:stuck:low', 'retrieve', 0.85],
      ['late:moderate:stuck:low', 'retrieve', 0.9],
      ['late:rich:stuck:low', 'retrieve', 0.9],
      ['early:rich:repeating:low', 'inject_procedural', 0.8],
      ['late:rich:repeating:low', 'inject_procedural', 0.85],
      ['late:moderate:repeating:low', 'inject_procedural', 0.7],
      ['late:empty:normal:low', 'noop', 0.6],
      ['late:sparse:normal:low', 'retrieve', 0.5],
      // medium pressure — 降低注入收益
      ['late:moderate:stuck:medium', 'retrieve', 0.6],
      ['late:rich:stuck:medium', 'retrieve', 0.65],
      ['late:rich:repeating:medium', 'inject_procedural', 0.5],
      // high pressure — 极保守
      ['late:moderate:stuck:high', 'retrieve', 0.3],
      ['late:rich:stuck:high', 'noop', 0.5],
      // critical — 全部 noop
      ['late:rich:stuck:critical', 'noop', 0.9],
      ['late:moderate:stuck:critical', 'noop', 0.9],
    ]

    for (const [stateKey, action, value] of priors) {
      if (!this.qTable.has(stateKey)) this.qTable.set(stateKey, new Map())
      this.qTable.get(stateKey)!.set(action, { value, count: 0, lastUpdatedAt: Date.now() })
    }
  }

  selectAction(state: ControllerState): MemoryDecision {
    const stateKey = `${state.phase}:${state.storeState}:${state.agentState}:${state.contextPressure}:${state.queryIntent}:${state.lastTurnRetrieved ? 'r' : 'n'}:${state.storeQuality}`
    const actionMap = this.qTable.get(stateKey) ?? new Map()
    const available = this.getAvailableActions(state)
    let bestAction = available[0]!
    let bestSample = -Infinity
    for (const action of available) {
      const rawStats = actionMap.get(action) ?? { value: 0.5, count: 0 }
      const stats = this.applyDecay(rawStats)
      // 将 Q-value 统计映射为 Beta 分布参数
      const successes = stats.value * stats.count
      const failures = (1 - stats.value) * stats.count
      const alpha = successes + 1 // prior: Beta(1, 1) = uniform
      const beta = failures + 1
      const sample = this.sampleBeta(alpha, beta)
      if (sample > bestSample) {
        bestSample = sample
        bestAction = action
      }
    }
    const topKTable: Record<ContextPressure, Record<AgentState, number>> = {
      low: { normal: 3, stuck: 5, repeating: 3 },
      medium: { normal: 2, stuck: 4, repeating: 2 },
      high: { normal: 1, stuck: 2, repeating: 1 },
      critical: { normal: 0, stuck: 1, repeating: 0 },
    }
    const budgetTable: Record<ContextPressure, number> = {
      low: 4000,
      medium: 2500,
      high: 1500,
      critical: 500,
    }
    const tierByIntent: Record<QueryIntent, 'all' | 'semantic' | 'procedural'> = {
      knowledge: 'semantic',
      debug: 'procedural',
      generate: 'all',
      chat: 'all',
      unknown: 'all',
    }
    const topK = topKTable[state.contextPressure]?.[state.agentState] ?? 3
    const budgetChars = budgetTable[state.contextPressure] ?? 4000
    return {
      action: bestAction,
      stateKey,
      params: {
        topK,
        tier: bestAction === 'inject_procedural'
          ? 'procedural'
          : tierByIntent[state.queryIntent] ?? 'all',
        budgetChars,
      },
    }
  }

  /**
   * 接受 boolean（向后兼容）或连续 reward 值 [0, 1]
   */
  update(stateKey: string, action: ActionType, reward: number | boolean): void {
    const r = typeof reward === 'boolean' ? (reward ? 1 : 0) : Math.max(0, Math.min(1, reward))
    let state = this.qTable.get(stateKey)
    if (!state) this.qTable.set(stateKey, state = new Map())
    const raw = state.get(action) ?? { value: 0.5, count: 0 }
    // 先衰减旧统计量
    const decayed = this.applyDecay(raw)
    const count = decayed.count + 1
    state.set(action, {
      value: decayed.value + (r - decayed.value) / count,
      count,
      lastUpdatedAt: Date.now(),
    })
  }

  getTotalUpdates(): number {
    let total = 0
    for (const actions of this.qTable.values()) {
      for (const stats of actions.values()) total += stats.count
    }
    return total
  }

  private applyDecay(stats: ActionStats): ActionStats {
    if (!stats.lastUpdatedAt || stats.count === 0) return stats
    const elapsed = Date.now() - stats.lastUpdatedAt
    const decayFactor = Math.pow(0.5, elapsed / AdaptiveMemoryController.DECAY_HALF_LIFE_MS)
    return {
      value: stats.value,
      count: Math.max(1, Math.round(stats.count * decayFactor)),
      lastUpdatedAt: stats.lastUpdatedAt,
    }
  }

  private getAvailableActions(state: ControllerState): ActionType[] {
    // 高压时强制 noop，避免恶性循环
    if (state.contextPressure === 'critical') return ['noop']
    if (state.queryIntent === 'chat') return ['noop'] // 聊天类不检索
    if (state.storeQuality === 'low' && state.agentState === 'normal') return ['noop']
    if (state.contextPressure === 'high') return ['noop', 'retrieve'] // 不注入 procedural
    if (state.storeState === 'empty') return ['noop']
    return state.storeState === 'moderate' || state.storeState === 'rich'
      ? ACTIONS
      : ['noop', 'retrieve']
  }

  /**
   * 从 Beta(alpha, beta) 中采样（Box-Muller 近似法，无需外部依赖）
   */
  private sampleBeta(alpha: number, beta: number): number {
    // 使用 Jöhnk 算法 for small alpha+beta
    // 大值时用正态近似
    if (alpha <= 0) alpha = 0.001
    if (beta <= 0) beta = 0.001
    const gammaA = this.sampleGamma(alpha)
    const gammaB = this.sampleGamma(beta)
    return gammaA / (gammaA + gammaB)
  }

  /**
   * 从 Gamma(shape, 1) 采样（Marsaglia & Tsang 方法）
   */
  private sampleGamma(shape: number): number {
    if (shape < 1) {
      // Boost
      return this.sampleGamma(shape + 1) * Math.pow(Math.random(), 1 / shape)
    }
    const d = shape - 1 / 3
    const c = 1 / Math.sqrt(9 * d)
    while (true) {
      let x: number
      let v: number
      do {
        x = this.randomNormal()
        v = 1 + c * x
      } while (v <= 0)
      v = v * v * v
      const u = Math.random()
      if (u < 1 - 0.0331 * (x * x) * (x * x)) return d * v
      if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v
    }
  }

  private randomNormal(): number {
    const u1 = Math.random()
    const u2 = Math.random()
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
  }

  async saveToDisk(): Promise<void> {
    const data = Object.fromEntries([...this.qTable].map(([key, actions]) => [key, Object.fromEntries(actions)]))
    await mkdir(path.dirname(this.persistPath), { recursive: true })
    await writeFile(this.persistPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  }

  async loadFromDisk(): Promise<void> {
    try {
      const data = JSON.parse(await readFile(this.persistPath, 'utf8')) as Record<string, Record<string, ActionStats>>
      for (const [key, actions] of Object.entries(data)) {
        const valid = new Map<ActionType, ActionStats>()
        for (const [action, stats] of Object.entries(actions)) {
          if (
            ACTIONS.includes(action as ActionType) &&
            Number.isFinite(stats.value) &&
            Number.isInteger(stats.count) &&
            stats.count >= 0
          ) {
            valid.set(action as ActionType, {
              value: Math.max(0, Math.min(1, stats.value)),
              count: stats.count,
              lastUpdatedAt: Number.isFinite(stats.lastUpdatedAt) ? stats.lastUpdatedAt : undefined,
            })
          }
        }
        if (valid.size > 0) this.qTable.set(key, valid)
      }
    } catch {
      // Missing or invalid persisted state leaves the warm-start defaults intact.
    }
  }
}

export function inferControllerState(args: {
  turnIndex: number
  totalEntries: number
  consecutiveErrors: number
  lastToolNames: string[]
  /** 新增：context 利用率 0~1 */
  contextUtilization?: number
  queryIntent?: QueryIntent
  lastTurnRetrieved?: boolean
  storeQuality?: StoreQuality
}): ControllerState {
  const phase: Phase = args.turnIndex <= 3 ? 'early' : 'late'
  const storeState: StoreState = args.totalEntries === 0 ? 'empty'
    : args.totalEntries <= 10 ? 'sparse'
      : args.totalEntries <= 50 ? 'moderate' : 'rich'
  let agentState: AgentState = 'normal'
  if (args.consecutiveErrors >= 3) agentState = 'stuck'
  else if (args.lastToolNames.length >= 4 && new Set(args.lastToolNames.slice(-4)).size <= 2) agentState = 'repeating'
  // 新增：context pressure
  const u = args.contextUtilization ?? 0
  const contextPressure: ContextPressure = u >= 0.85 ? 'critical'
    : u >= 0.70 ? 'high'
      : u >= 0.50 ? 'medium' : 'low'
  return {
    phase,
    storeState,
    agentState,
    contextPressure,
    queryIntent: args.queryIntent ?? 'unknown',
    lastTurnRetrieved: args.lastTurnRetrieved ?? false,
    storeQuality: args.storeQuality ?? 'mixed',
  }
}
