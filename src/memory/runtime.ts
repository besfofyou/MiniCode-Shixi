import path from 'node:path'
import type { ChatMessage } from '../types.js'
import { MINI_CODE_DIR } from '../config.js'
import type { MemoryExtras } from '../prompt.js'
import { AdaptiveMemoryController, inferControllerState, type ActionType, type MemoryDecision } from './controller.js'
import { distillSessionEnd } from './distiller.js'
import { MemoryFilesystem } from './filesystem.js'
import { MemoryRetriever } from './retrieval.js'
import { bootstrapFromExisting } from './migration.js'
import type { ModelAdapter } from '../types.js'
import { SkillBank } from './skill-bank.js'
import { ForgeEngine, DEFAULT_EVOLUTION_CONFIG } from './skill-evolution.js'
import { SkillMutator } from './skill-mutator.js'
import type { Skill } from './types.js'

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

  // ====== 新增字段 ======
  readonly skillBank: SkillBank
  readonly forgeEngine: ForgeEngine
  private skillMutator: SkillMutator | null = null
  private turnRetrievedSkills: Skill[] = []   // 本回合检索到的 skill

  private constructor(root?: string) {
    this.store = new MemoryFilesystem(root)
    this.controller = new AdaptiveMemoryController(path.join(root ?? path.join(MINI_CODE_DIR, 'memory'), '_controller.json'))
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
    } catch {
      // Existing skill import is best-effort and must not block startup.
    }
    return runtime
  }

  promptExtras(userQuery?: string): MemoryExtras {
    // 在 prompt 构建前调用：检索 skill（用于本回合信用分配）
    if (userQuery) this.retrieveSkills(userQuery)
    return {
      store: this.store,
      retriever: this.retriever,
      controller: this.controller,
      skillBank: this.skillBank,
      turnIndex: this.turnIndex + 1,
      consecutiveErrors: this.consecutiveErrors,
      lastToolNames: [...this.lastToolNames],
      userQuery,
      onDecision: (decision, found) => {
        this.pendingDecision = decision
        this.pendingFound = found
      },
    }
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
    })
    this.controller.update(`${state.phase}:${state.storeState}:${state.agentState}`, action, success)
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

  async completeTurn(args: {
    outcome: 'final' | 'awaiting_user' | 'aborted' | 'max_steps' | 'failed' | 'controlled_stop'
    messages: ChatMessage[]
    toolNames?: string[]
    userQuery?: string
  }): Promise<void> {
    this.turnIndex++
    if (args.outcome === 'failed' || args.outcome === 'max_steps' || this.turnHadToolError) this.consecutiveErrors++
    else if (args.outcome === 'final') this.consecutiveErrors = 0
    this.lastToolNames = [...this.lastToolNames, ...this.turnToolNames, ...(args.toolNames ?? [])].slice(-8)
    this.turnToolNames = []
    this.turnHadToolError = false
    if (process.env.MINI_CODE_MEMORY_CONTROLLER !== '0') {
      if (this.pendingDecision) {
        const success = this.pendingDecision.action === 'noop'
          ? (args.outcome === 'final')
          : (args.outcome === 'final' && this.pendingFound)
        this.controller.update(
          this.pendingDecision.stateKey,
          this.pendingDecision.action,
          success,
        )
      } else {
        const implicitState = inferControllerState({
          turnIndex: this.turnIndex,
          totalEntries: await this.countEntries(),
          consecutiveErrors: this.consecutiveErrors,
          lastToolNames: this.lastToolNames,
        })
        const stateKey = `${implicitState.phase}:${implicitState.storeState}:${implicitState.agentState}`
        this.controller.update(stateKey, 'noop', args.outcome === 'final')
      }
    }
    this.pendingDecision = null
    this.pendingFound = false
    await this.controller.saveToDisk().catch(() => {})

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

  async distill(messages: ChatMessage[], model: ModelAdapter, sessionId: string): Promise<void> {
    if (process.env.MINI_CODE_MEMORY_DISTILL === '0' || this.distilledSessions.has(sessionId)) return
    this.distilledSessions.add(sessionId)
    try {
      await distillSessionEnd(messages, model, this.store, sessionId, { skillBank: this.skillBank })
    } finally {
      await this.controller.saveToDisk().catch(() => {})
    }

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
        toolTrace.push(msg.toolName ?? 'unknown')
      }
      if (msg.role === 'tool_result' && msg.isError) {
        hadError = true
      }
    }
    if (hadError && currentTask) {
      failures.push({ task: currentTask, trajectory: toolTrace.join(' → ') })
    }
    return failures.slice(0, 8)
  }

  private async countEntries(): Promise<number> {
    const tiers = ['episodic', 'semantic', 'procedural'] as const
    const entries = await Promise.all(tiers.map(tier => this.store.listTier(tier)))
    return entries.reduce((sum, tierEntries) => sum + tierEntries.length, 0)
  }
}
