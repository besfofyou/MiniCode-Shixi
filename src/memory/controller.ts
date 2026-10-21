import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

export type Phase = 'early' | 'late'
export type StoreState = 'empty' | 'sparse' | 'moderate' | 'rich'
export type AgentState = 'normal' | 'stuck' | 'repeating'
export type ActionType = 'retrieve' | 'inject_procedural' | 'noop'

type ActionStats = { value: number; count: number }

export interface MemoryDecision {
  action: ActionType
  stateKey: string
  params: { topK: number; tier: 'all' | 'semantic' | 'procedural' }
}

export interface ControllerState {
  phase: Phase
  storeState: StoreState
  agentState: AgentState
}

const ACTIONS: ActionType[] = ['noop', 'retrieve', 'inject_procedural']

export class AdaptiveMemoryController {
  private readonly qTable = new Map<string, Map<ActionType, ActionStats>>()
  private readonly persistPath: string
  private readonly explorationParam = 1.2

  constructor(persistPath: string) {
    this.persistPath = persistPath
    this.warmStartPriors()
  }

  private warmStartPriors(): void {
    const priors: Array<[string, ActionType, number]> = [
      ['early:empty:normal', 'noop', 0.8],
      ['early:empty:stuck', 'noop', 0.7],
      ['early:sparse:normal', 'retrieve', 0.4],
      ['early:moderate:normal', 'retrieve', 0.5],
      ['early:rich:normal', 'retrieve', 0.6],
      ['late:sparse:stuck', 'retrieve', 0.85],
      ['late:moderate:stuck', 'retrieve', 0.9],
      ['late:rich:stuck', 'retrieve', 0.9],
      ['early:rich:repeating', 'inject_procedural', 0.8],
      ['late:rich:repeating', 'inject_procedural', 0.85],
      ['late:moderate:repeating', 'inject_procedural', 0.7],
      ['late:empty:normal', 'noop', 0.6],
      ['late:sparse:normal', 'retrieve', 0.5],
    ]

    for (const [stateKey, action, value] of priors) {
      if (!this.qTable.has(stateKey)) this.qTable.set(stateKey, new Map())
      this.qTable.get(stateKey)!.set(action, { value, count: 0 })
    }
  }

  selectAction(state: ControllerState): MemoryDecision {
    const stateKey = `${state.phase}:${state.storeState}:${state.agentState}`
    const actionMap = this.qTable.get(stateKey) ?? new Map<ActionType, ActionStats>()
    const available = this.getAvailableActions(state)
    const totalCount = [...actionMap.values()].reduce((sum, stats) => sum + stats.count, 0)
    let bestAction = available[0]!
    let bestUcb = -Infinity
    for (const action of available) {
      const stats = actionMap.get(action) ?? { value: 0.05, count: 0 }

      if (stats.count === 0) {
        const ucb = stats.value + this.explorationParam * 2
        if (ucb > bestUcb) {
          bestUcb = ucb
          bestAction = action
        }
        continue
      }

      const exploration = this.explorationParam * Math.sqrt(Math.log(totalCount + 1) / stats.count)
      const ucb = stats.value + exploration
      if (ucb > bestUcb) {
        bestUcb = ucb
        bestAction = action
      }
    }
    return {
      action: bestAction,
      stateKey,
      params: {
        topK: state.agentState === 'stuck' ? 5 : 3,
        tier: bestAction === 'inject_procedural' ? 'procedural' : 'all',
      },
    }
  }

  update(stateKey: string, action: ActionType, success: boolean): void {
    let state = this.qTable.get(stateKey)
    if (!state) this.qTable.set(stateKey, state = new Map())
    const previous = state.get(action) ?? { value: 0.5, count: 0 }
    const count = previous.count + 1
    state.set(action, { value: previous.value + ((success ? 1 : 0) - previous.value) / count, count })
  }

  getTotalUpdates(): number {
    let total = 0
    for (const actions of this.qTable.values()) {
      for (const stats of actions.values()) total += stats.count
    }
    return total
  }

  private getAvailableActions(state: ControllerState): ActionType[] {
    if (state.storeState === 'empty') return ['noop']
    return state.storeState === 'moderate' || state.storeState === 'rich'
      ? ACTIONS
      : ['noop', 'retrieve']
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
          if (ACTIONS.includes(action as ActionType) && Number.isFinite(stats.value) && Number.isInteger(stats.count) && stats.count >= 0) {
            valid.set(action as ActionType, { value: Math.max(0, Math.min(1, stats.value)), count: stats.count })
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
}): ControllerState {
  const phase: Phase = args.turnIndex <= 3 ? 'early' : 'late'
  const storeState: StoreState = args.totalEntries === 0 ? 'empty'
    : args.totalEntries <= 10 ? 'sparse'
      : args.totalEntries <= 50 ? 'moderate' : 'rich'
  let agentState: AgentState = 'normal'
  if (args.consecutiveErrors >= 3) agentState = 'stuck'
  else if (args.lastToolNames.length >= 4 && new Set(args.lastToolNames.slice(-4)).size <= 2) agentState = 'repeating'
  return { phase, storeState, agentState }
}
