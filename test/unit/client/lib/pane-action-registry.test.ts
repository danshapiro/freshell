import { describe, expect, it, vi } from 'vitest'
import {
  getTerminalActions,
  registerTerminalActions,
  type TerminalActions,
  getFreshAgentTurnItemsBuilder,
  registerFreshAgentTurnItems,
  type FreshAgentTurnItemsBuilder,
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

  it('registers a per-pane fresh-agent turn-items builder and unregisters by identity', () => {
    const paneId = 'pane-turn-items'
    const staleBuilder: FreshAgentTurnItemsBuilder = () => [{ label: 'Stale', run: vi.fn() }]
    const currentBuilder: FreshAgentTurnItemsBuilder = (articleIndex) =>
      articleIndex === 0 ? [{ label: 'Copy turn text', run: vi.fn() }] : null

    const unregisterStale = registerFreshAgentTurnItems(paneId, staleBuilder)
    const unregisterCurrent = registerFreshAgentTurnItems(paneId, currentBuilder)

    try {
      unregisterStale()
      expect(getFreshAgentTurnItemsBuilder(paneId)).toBe(currentBuilder)
      // The builder maps an article index to turn action items (null off-turn).
      expect(currentBuilder(0)?.map((item) => item.label)).toEqual(['Copy turn text'])
      expect(currentBuilder(7)).toBeNull()
    } finally {
      unregisterCurrent()
    }

    expect(getFreshAgentTurnItemsBuilder(paneId)).toBeUndefined()
  })
})
