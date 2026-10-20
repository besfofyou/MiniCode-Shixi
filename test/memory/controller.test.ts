import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { AdaptiveMemoryController, inferControllerState } from '../../src/memory/controller.js'

describe('AdaptiveMemoryController', () => {
  it('selects useful actions by state and persists learned outcomes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'minicode-controller-'))
    try {
      const file = path.join(root, '_controller.json')
      const controller = new AdaptiveMemoryController(file)
      assert.equal(controller.selectAction({ phase: 'early', storeState: 'empty', agentState: 'normal' }).action, 'noop')
      assert.equal(controller.selectAction({ phase: 'early', storeState: 'empty', agentState: 'stuck' }).action, 'noop')
      assert.equal(controller.selectAction({ phase: 'late', storeState: 'rich', agentState: 'stuck' }).action, 'retrieve')
      const procedural = controller.selectAction({ phase: 'late', storeState: 'rich', agentState: 'repeating' })
      assert.equal(procedural.action, 'inject_procedural')
      assert.equal(procedural.params.tier, 'procedural')
      for (let i = 0; i < 20; i++) controller.update('late:moderate:repeating', 'inject_procedural', true)
      await controller.saveToDisk()
      const restored = new AdaptiveMemoryController(file)
      await restored.loadFromDisk()
      assert.equal(restored.getTotalUpdates(), controller.getTotalUpdates())
      assert.ok(['retrieve', 'inject_procedural', 'noop'].includes(restored.selectAction({ phase: 'late', storeState: 'moderate', agentState: 'repeating' }).action))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('infers phase, store-size, stuck, and repeating boundaries', () => {
    assert.equal(inferControllerState({ turnIndex: 3, totalEntries: 0, consecutiveErrors: 0, lastToolNames: [] }).phase, 'early')
    assert.equal(inferControllerState({ turnIndex: 4, totalEntries: 0, consecutiveErrors: 0, lastToolNames: [] }).phase, 'late')
    assert.equal(inferControllerState({ turnIndex: 5, totalEntries: 10, consecutiveErrors: 0, lastToolNames: [] }).storeState, 'sparse')
    assert.equal(inferControllerState({ turnIndex: 5, totalEntries: 11, consecutiveErrors: 0, lastToolNames: [] }).storeState, 'moderate')
    assert.equal(inferControllerState({ turnIndex: 5, totalEntries: 50, consecutiveErrors: 0, lastToolNames: [] }).storeState, 'moderate')
    assert.equal(inferControllerState({ turnIndex: 5, totalEntries: 51, consecutiveErrors: 0, lastToolNames: [] }).storeState, 'rich')
    assert.equal(inferControllerState({ turnIndex: 5, totalEntries: 12, consecutiveErrors: 3, lastToolNames: [] }).agentState, 'stuck')
    assert.equal(inferControllerState({ turnIndex: 5, totalEntries: 60, consecutiveErrors: 0, lastToolNames: ['read', 'grep', 'read', 'grep'] }).agentState, 'repeating')
  })
})
