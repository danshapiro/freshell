import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock loadPersistedPanes before importing terminal-restore
vi.mock('@/store/persistMiddleware', () => ({
  loadPersistedPanes: () => null,
}))

describe('terminal-restore', () => {
  beforeEach(async () => {
    vi.resetModules()
  })

  it('consumeTerminalRestoreRequestId returns false for unknown IDs', async () => {
    const { consumeTerminalRestoreRequestId } = await import('@/lib/terminal-restore')
    expect(consumeTerminalRestoreRequestId('unknown-id')).toBe(false)
  })

  it('addTerminalRestoreRequestId makes ID consumable', async () => {
    const { consumeTerminalRestoreRequestId, addTerminalRestoreRequestId } = await import('@/lib/terminal-restore')
    addTerminalRestoreRequestId('new-reconnect-id')
    expect(consumeTerminalRestoreRequestId('new-reconnect-id')).toBe(true)
    // Consumed — second call returns false
    expect(consumeTerminalRestoreRequestId('new-reconnect-id')).toBe(false)
  })

  it('registering new IDs after clearDeadTerminals enables restore bypass', async () => {
    const { consumeTerminalRestoreRequestId, addTerminalRestoreRequestId } = await import('@/lib/terminal-restore')
    // Simulate the flow: clearDeadTerminals generates new IDs,
    // then App.tsx registers them with addTerminalRestoreRequestId
    const newIds = ['new-id-1', 'new-id-2', 'new-id-3']
    for (const id of newIds) {
      addTerminalRestoreRequestId(id)
    }
    // All new IDs should be consumable (enabling restore: true)
    for (const id of newIds) {
      expect(consumeTerminalRestoreRequestId(id)).toBe(true)
    }
    // Already consumed
    for (const id of newIds) {
      expect(consumeTerminalRestoreRequestId(id)).toBe(false)
    }
  })

  it('fresh recovery request ids are one-shot and separate from restore ids', async () => {
    const {
      addTerminalFreshRecoveryRequestId,
      consumeTerminalFreshRecoveryRequest,
      consumeTerminalRestoreRequestId,
    } = await import('@/lib/terminal-restore')

    addTerminalFreshRecoveryRequestId('fresh-id-1', 'fresh_after_restore_unavailable')

    expect(consumeTerminalRestoreRequestId('fresh-id-1')).toBe(false)
    expect(consumeTerminalFreshRecoveryRequest('fresh-id-1')).toBe('fresh_after_restore_unavailable')
    expect(consumeTerminalFreshRecoveryRequest('fresh-id-1')).toBeUndefined()
  })

  it('prefers explicit fresh recovery when a request id is mistakenly registered for both paths', async () => {
    const {
      addTerminalFreshRecoveryRequestId,
      addTerminalRestoreRequestId,
      consumeTerminalFreshRecoveryRequest,
      consumeTerminalRestoreRequestId,
    } = await import('@/lib/terminal-restore')

    addTerminalRestoreRequestId('dual-id')
    addTerminalFreshRecoveryRequestId('dual-id', 'fresh_after_restore_unavailable')

    expect(consumeTerminalFreshRecoveryRequest('dual-id')).toBe('fresh_after_restore_unavailable')
    expect(consumeTerminalRestoreRequestId('dual-id')).toBe(false)
  })
})
