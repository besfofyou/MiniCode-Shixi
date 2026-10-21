import path from 'node:path'
import type { ChatMessage } from '../types.js'
import { MINI_CODE_DIR } from '../config.js'
import type { MemoryExtras } from '../prompt.js'
import { AdaptiveMemoryController, computeCompositeReward, inferControllerState, type ActionType, type MemoryDecision, type RewardSignal, type StoreQuality } from './controller.js'
import { distillSessionEnd } from './distiller.js'
import { MemoryFilesystem } from './filesystem.js'
import { MemoryRetriever } from './retrieval.js'
import { bootstrapFromExisting } from './migration.js'
import type { ModelAdapter } from '../types.js'

export class MemoryRuntime {
  readonly store: MemoryFilesystem
  readonly retriever = new MemoryRetriever()
  readonly controller: AdaptiveMemoryController
  private turnIndex = 0
  private consecutiveErrors = 0
  private lastToolNames: string[] = []
  private turnToolNames: string[] = []
  private turnHadToolError = false
  private pendingDecision: MemoryDecision | null = null
  private pendingFound = false
  private readonly distilledSessions = new Set<string>()
  private turnTriggeredCompact = false
  private turnInjectedIds: string[] = []
  private lastContextUtilization = 0
  /** 最近 N 轮的检索结果 entry IDs */
  private recentRetrievalIds: string[][] = []
  private static readonly MAX_RETRIEVAL_HISTORY = 3

  private constructor(root?: string) {
    this.store = new MemoryFilesystem(root)
    this.controller = new AdaptiveMemoryController(path.join(root ?? path.join(MINI_CODE_DIR, 'memory'), '_controller.json'))
  }

  static async create(cwd: string, root?: string): Promise<MemoryRuntime> {
    const runtime = new MemoryRuntime(root)
    await runtime.store.ensureStructure()
    await runtime.controller.loadFromDisk()
    try {
      await bootstrapFromExisting(runtime.store, cwd)
    } catch {
      // Existing skill import is best-effort and must not block startup.
    }
    return runtime
  }

  async promptExtras(userQuery?: string): Promise<MemoryExtras> {
    const quality = await this.computeStoreQuality()
    return {
      store: this.store,
      retriever: this.retriever,
      controller: this.controller,
      turnIndex: this.turnIndex + 1,
      consecutiveErrors: this.consecutiveErrors,
      lastToolNames: [...this.lastToolNames],
      userQuery,
      onDecision: (decision, found) => {
        this.pendingDecision = decision
        this.pendingFound = found
      },
      onInjectedIds: (ids) => {
        this.recordInjectedEntryIds(ids)
      },
      contextUtilization: this.lastContextUtilization,
      recentRetrievalIds: this.recentRetrievalIds.flat(),
      storeQuality: quality,
    }
  }

  /** 由 agent-loop 的 onAutoCompact / onSnipCompact 调用 */
  recordCompactTriggered(): void {
    this.turnTriggeredCompact = true
  }

  /** 在 prompt.ts 注入记忆后调用，记录本轮注入的 entry id */
  recordInjectedEntryIds(ids: string[]): void {
    this.turnInjectedIds = ids
  }

  /** 供外部（tty-app）更新 */
  setContextUtilization(u: number): void {
    this.lastContextUtilization = u
  }

  recordTurnTool(toolName: string, failed = false): void {
    if (!failed) {
      this.turnToolNames.push(toolName)
      this.turnToolNames = this.turnToolNames.slice(-8)
    }
    this.turnHadToolError ||= failed
  }

  async recordToolOutcome(action: ActionType, success: boolean): Promise<void> {
    if (process.env.MINI_CODE_MEMORY_CONTROLLER === '0') return
    const state = inferControllerState({
      turnIndex: this.turnIndex + 1,
      totalEntries: await this.countEntries(),
      consecutiveErrors: this.consecutiveErrors,
      lastToolNames: this.lastToolNames,
      contextUtilization: this.lastContextUtilization,
    })
    this.controller.update(`${state.phase}:${state.storeState}:${state.agentState}`, action, success)
  }

  async completeTurn(args: {
    outcome: 'final' | 'awaiting_user' | 'aborted' | 'max_steps' | 'failed' | 'controlled_stop'
    messages: ChatMessage[]
    toolNames?: string[]
    /** 后续 assistant 回复文本，用于计算 retrievalHitRate */
    assistantReply?: string
  }): Promise<void> {
    this.turnIndex++
    if (args.outcome === 'failed' || args.outcome === 'max_steps' || this.turnHadToolError)
      this.consecutiveErrors++
    else if (args.outcome === 'final') this.consecutiveErrors = 0
    this.lastToolNames = [
      ...this.lastToolNames,
      ...this.turnToolNames,
      ...(args.toolNames ?? []),
    ].slice(-8)
    // ---- 计算 toolSuccessRate ----
    const toolTotal = this.turnToolNames.length
    const toolErrors = this.turnHadToolError ? 1 : 0 // 简化；精确版本可累计
    const toolSuccessRate = toolTotal > 0 ? 1 - toolErrors / toolTotal : 1
    // ---- 计算 retrievalHitRate ----
    let retrievalHitRate = 0
    if (this.turnInjectedIds.length > 0 && args.assistantReply) {
      const reply = args.assistantReply.toLowerCase()
      const tiers = ['episodic', 'semantic', 'procedural'] as const
      let hits = 0
      for (const id of this.turnInjectedIds) {
        for (const tier of tiers) {
          const entry = await this.store.read(tier, id)
          if (entry) {
            // 简单文本包含检测
            const keywords = entry.content.toLowerCase().split(/\s+/).filter(w => w.length > 3)
            const matched = keywords.filter(k => reply.includes(k)).length
            if (keywords.length > 0 && matched / keywords.length > 0.3) {
              hits++
              break
            }
          }
        }
      }
      retrievalHitRate = this.turnInjectedIds.length > 0
        ? hits / this.turnInjectedIds.length
        : 0
    }
    this.turnToolNames = []
    this.turnHadToolError = false
    if (process.env.MINI_CODE_MEMORY_CONTROLLER !== '0') {
      const rewardSignal: RewardSignal = {
        taskSuccess: args.outcome === 'final' ? 1 : 0,
        retrievalHitRate,
        noCompactPenalty: this.turnTriggeredCompact ? 0 : 1,
        toolSuccessRate,
      }
      const compositeReward = computeCompositeReward(rewardSignal)
      if (this.pendingDecision) {
        this.controller.update(
          this.pendingDecision.stateKey,
          this.pendingDecision.action,
          compositeReward,
        )
      } else {
        const didRetrieveLastTurn = this.recentRetrievalIds.length > 0
          && this.recentRetrievalIds[this.recentRetrievalIds.length - 1]!.length > 0
        const implicitState = inferControllerState({
          turnIndex: this.turnIndex,
          totalEntries: await this.countEntries(),
          consecutiveErrors: this.consecutiveErrors,
          lastToolNames: this.lastToolNames,
          contextUtilization: this.lastContextUtilization,
          lastTurnRetrieved: didRetrieveLastTurn,
        })
        const stateKey = `${implicitState.phase}:${implicitState.storeState}:${implicitState.agentState}`
        this.controller.update(stateKey, 'noop', compositeReward)
      }
    }
    this.recentRetrievalIds.push([...this.turnInjectedIds])
    if (this.recentRetrievalIds.length > MemoryRuntime.MAX_RETRIEVAL_HISTORY) {
      this.recentRetrievalIds.shift()
    }
    this.pendingDecision = null
    this.pendingFound = false
    this.turnTriggeredCompact = false
    this.turnInjectedIds = []
    await this.controller.saveToDisk().catch(() => {})
  }

  async distill(messages: ChatMessage[], model: ModelAdapter, sessionId: string): Promise<void> {
    if (process.env.MINI_CODE_MEMORY_DISTILL === '0' || this.distilledSessions.has(sessionId)) return
    this.distilledSessions.add(sessionId)
    try {
      await distillSessionEnd(messages, model, this.store, sessionId)
    } finally {
      await this.controller.saveToDisk().catch(() => {})
    }
  }

  private async computeStoreQuality(): Promise<StoreQuality> {
    const tiers = ['episodic', 'semantic', 'procedural'] as const
    const entries = (await Promise.all(tiers.map(t => this.store.listTier(t)))).flat()
    if (entries.length === 0) return 'low'
    const avgConfidence = entries.reduce((s, e) => s + e.confidence, 0) / entries.length
    const volatileRatio = entries.filter(e => e.durability === 'volatile').length / entries.length
    const now = Date.now()
    const staleRatio = entries.filter(
      e => (now - Date.parse(e.lastAccessedAt)) / 86_400_000 > 30
    ).length / entries.length
    // 综合评判
    const score = avgConfidence * 0.5 + (1 - volatileRatio) * 0.3 + (1 - staleRatio) * 0.2
    if (score >= 0.6) return 'high'
    if (score >= 0.35) return 'mixed'
    return 'low'
  }

  private async countEntries(): Promise<number> {
    const tiers = ['episodic', 'semantic', 'procedural'] as const
    const entries = await Promise.all(tiers.map(tier => this.store.listTier(tier)))
    return entries.reduce((sum, tierEntries) => sum + tierEntries.length, 0)
  }
}
