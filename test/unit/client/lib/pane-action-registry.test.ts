import { describe, expect, it, vi } from 'vitest'
import {
  getTerminalActions,
  registerTerminalActions,
  type TerminalActions,
} from '@/lib/pane-action-registry'

function createTerminalActions(): TerminalActions {
  return {
    copySelection: vi.fn(),
    paste: vi.fn(),
    selectAll: vi.fn(),
    clearScrollback: vi.fn(),
    reset: vi.fn(),
    scrollToBottom: vi.fn(),
    hasSelection: vi.fn(() => false),
    openSearch: vi.fn(),
  }
}

describe('pane action registry', () => {
  it('does not let an older terminal unregister remove newer pane actions', () => {
    const paneId = 'pane-terminal-actions'
    const staleActions = createTerminalActions()
    const currentActions = createTerminalActions()
    const unregisterStale = registerTerminalActions(paneId, staleActions)
    const unregisterCurrent = registerTerminalActions(paneId, currentActions)

    try {
      unregisterStale()
      expect(getTerminalActions(paneId)).toBe(currentActions)
    } finally {
      unregisterCurrent()
      unregisterStale()
    }

    expect(getTerminalActions(paneId)).toBeUndefined()
  })
})
