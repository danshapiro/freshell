import { describe, it, expect, beforeEach, vi } from 'vitest'

const { persistedWorkspaceRef } = vi.hoisted(() => ({
  persistedWorkspaceRef: {
    current: null as any,
  },
}))

vi.mock('@/store/workspacePersistence', () => ({
  loadPersistedWorkspaceSnapshot: () => persistedWorkspaceRef.current,
}))

describe('terminal-restore', () => {
  beforeEach(async () => {
    vi.resetModules()
    persistedWorkspaceRef.current = null
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

  it('hasTerminalRestoreRequestId observes restore bookkeeping without consuming it', async () => {
    const {
      addTerminalRestoreRequestId,
      hasTerminalRestoreRequestId,
      consumeTerminalRestoreRequestId,
    } = await import('@/lib/terminal-restore')

    addTerminalRestoreRequestId('live-attach-id')
    expect(hasTerminalRestoreRequestId('live-attach-id')).toBe(true)
    expect(hasTerminalRestoreRequestId('live-attach-id')).toBe(true)
    expect(consumeTerminalRestoreRequestId('live-attach-id')).toBe(true)
    expect(hasTerminalRestoreRequestId('live-attach-id')).toBe(false)
  })

  it('boots restore request ids from the authoritative workspace snapshot', async () => {
    persistedWorkspaceRef.current = {
      panes: {
        layouts: {
          'tab-1': {
            type: 'leaf',
            id: 'pane-1',
            content: {
              kind: 'terminal',
              createRequestId: 'restore-request-1',
            },
          },
        },
      },
    }

    const {
      hasTerminalRestoreRequestId,
      consumeTerminalRestoreRequestId,
    } = await import('@/lib/terminal-restore')

    expect(hasTerminalRestoreRequestId('restore-request-1')).toBe(true)
    expect(consumeTerminalRestoreRequestId('restore-request-1')).toBe(true)
  })
})
