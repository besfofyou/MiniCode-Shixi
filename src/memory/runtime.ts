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

  promptExtras(userQuery?: string): MemoryExtras {
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

  async completeTurn(args: {
    outcome: 'final' | 'awaiting_user' | 'aborted' | 'max_steps' | 'failed' | 'controlled_stop'
    messages: ChatMessage[]
    toolNames?: string[]
  }): Promise<void> {
    this.turnIndex++
    if (args.outcome === 'failed' || args.outcome === 'max_steps' || this.turnHadToolError) this.consecutiveErrors++
    else if (args.outcome === 'final') this.consecutiveErrors = 0
    this.lastToolNames = [...this.lastToolNames, ...this.turnToolNames, ...(args.toolNames ?? [])].slice(-8)
    this.turnToolNames = []
    this.turnHadToolError = false
    if (this.pendingDecision && this.pendingDecision.action !== 'noop' && process.env.MINI_CODE_MEMORY_CONTROLLER !== '0') {
      this.controller.update(this.pendingDecision.stateKey, this.pendingDecision.action,
        args.outcome === 'final' && this.pendingFound)
    }
    this.pendingDecision = null
    this.pendingFound = false
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

  private async countEntries(): Promise<number> {
    const tiers = ['episodic', 'semantic', 'procedural'] as const
    const entries = await Promise.all(tiers.map(tier => this.store.listTier(tier)))
    return entries.reduce((sum, tierEntries) => sum + tierEntries.length, 0)
  }
}
