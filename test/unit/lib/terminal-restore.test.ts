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
    // v2 semantics: this is a non-destructive PEEK, not a one-shot consume.
    // An interrupted restore round (dropped reconnect, server restart before
    // terminal.created lands) must be able to retry terminal.create with
    // restore:true as many times as it takes to anchor -- so repeated reads
    // keep returning true until the caller explicitly resolves the id.
    expect(consumeTerminalRestoreRequestId('new-reconnect-id')).toBe(true)
    expect(consumeTerminalRestoreRequestId('new-reconnect-id')).toBe(true)
  })

  it('clearTerminalRestoreRequestId resolves the flag so it no longer peeks true', async () => {
    const {
      consumeTerminalRestoreRequestId,
      addTerminalRestoreRequestId,
      clearTerminalRestoreRequestId,
    } = await import('@/lib/terminal-restore')
    addTerminalRestoreRequestId('anchored-id')
    // Interrupted rounds keep peeking true...
    expect(consumeTerminalRestoreRequestId('anchored-id')).toBe(true)
    expect(consumeTerminalRestoreRequestId('anchored-id')).toBe(true)
    // ...until the caller confirms the requestId's fate is settled (e.g. the
    // pane anchored via terminal.created), at which point it's gone for good.
    clearTerminalRestoreRequestId('anchored-id')
    expect(consumeTerminalRestoreRequestId('anchored-id')).toBe(false)
    expect(consumeTerminalRestoreRequestId('anchored-id')).toBe(false)
  })

  it('clearTerminalRestoreRequestId is a no-op for an id that was never armed', async () => {
    const { clearTerminalRestoreRequestId, consumeTerminalRestoreRequestId } = await import('@/lib/terminal-restore')
    expect(() => clearTerminalRestoreRequestId('never-armed-id')).not.toThrow()
    expect(consumeTerminalRestoreRequestId('never-armed-id')).toBe(false)
  })

  it('registering new IDs after clearDeadTerminals enables restore bypass across repeated peeks', async () => {
    const { consumeTerminalRestoreRequestId, addTerminalRestoreRequestId } = await import('@/lib/terminal-restore')
    // Simulate the flow: clearDeadTerminals generates new IDs,
    // then App.tsx registers them with addTerminalRestoreRequestId
    const newIds = ['new-id-1', 'new-id-2', 'new-id-3']
    for (const id of newIds) {
      addTerminalRestoreRequestId(id)
    }
    // All new IDs should be consumable (enabling restore: true) across any
    // number of peeks -- interrupted restore rounds must not lose the flag.
    for (const id of newIds) {
      expect(consumeTerminalRestoreRequestId(id)).toBe(true)
    }
    for (const id of newIds) {
      expect(consumeTerminalRestoreRequestId(id)).toBe(true)
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
