import { describe, it, expect } from 'vitest'

// Mock localStorage BEFORE importing slices (persistMiddleware reads it at import time)
const localStorageMock = (() => {
  let store: Record<string, string> = {}
  return {
    getItem: (key: string) => store[key] || null,
    setItem: (key: string, value: string) => { store[key] = value },
    removeItem: (key: string) => { delete store[key] },
    clear: () => { store = {} },
  }
})()
Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true })

import panesReducer, {
  initLayout,
  reconcileTerminalSessionRefByTerminalId,
} from '../../../../src/store/panesSlice'
import type { PanesState } from '../../../../src/store/panesSlice'
import type { PaneNode, TerminalPaneContent } from '../../../../src/store/paneTypes'
import { resolvePaneNameRef } from '../../../../src/store/selectors/sessionNameSelectors'

// Name reliability (Task 10, G45): a server-authoritative conversation switch
// (the CLI's `/clear`, an OpenCode switch, a new Codex thread) moves a
// terminal pane to a NEW session. The pane's pre-durable naming handle (and
// a naming ref for the superseded session) belonged to the OLD conversation
// — the server bound that handle to it — so the pane's name must resolve
// through the new session from then on, never back to the old session's
// saved name. A handle is released only once the server SPENT it (the
// client's name cache holds its pending→durable redirect): a still-pending
// handle (a zero-turn switch, before any transfer) stays, because the server
// keeps the row on it and transfers it onto the NEW session.

function emptyState(): PanesState {
  return {
    layouts: {},
    activePane: {},
    paneTitles: {},
    paneTitleSetByUser: {},
    renameRequestTabId: null,
    renameRequestPaneId: null,
    zoomedPane: {},
    refreshRequestsByPane: {},
    restoreFallbackAttemptsByPane: {},
  }
}

function stateWithTerminalPane(overrides: Partial<TerminalPaneContent>): PanesState {
  return panesReducer(emptyState(), initLayout({
    tabId: 'tab1',
    paneId: 'p1',
    content: {
      kind: 'terminal',
      mode: 'claude',
      shell: 'system',
      createRequestId: 'cr-1',
      terminalId: 'term-1',
      ...overrides,
    },
  }))
}

function content(state: PanesState): TerminalPaneContent {
  const root = state.layouts.tab1 as PaneNode
  if (root.type !== 'leaf' || root.content.kind !== 'terminal') throw new Error('expected a terminal leaf')
  return root.content
}

describe('conversation switch moves the pane naming identity', () => {
  it.each([
    [{ kind: 'session', provider: 'claude', sessionId: 'session-b' }, undefined],
    [{ kind: 'pending', id: 'nh-bound-to-a' }, 'nh-bound-to-a'],
  ] as const)('adopts the server naming binding %j without a cached redirect', (nameRef, namingHandle) => {
    const state = stateWithTerminalPane({
      sessionRef: { provider: 'claude', sessionId: 'session-a' },
      namingHandle: 'nh-bound-to-a',
      nameRef: { kind: 'pending', id: 'nh-bound-to-a' },
    })

    const next = panesReducer(state, reconcileTerminalSessionRefByTerminalId({
      terminalId: 'term-1',
      sessionRef: { provider: 'claude', sessionId: 'session-b' },
      previousSessionId: 'session-a',
      nameRef,
    }))

    expect(resolvePaneNameRef(content(next))).toEqual(nameRef)
    expect(content(next).namingHandle).toBe(namingHandle)
  })

  it('a rebind from the previous session releases the old conversation handle', () => {
    const state = stateWithTerminalPane({
      sessionRef: { provider: 'claude', sessionId: 'session-a' },
      namingHandle: 'nh-bound-to-a',
      nameRef: { kind: 'pending', id: 'nh-bound-to-a' },
    })

    const next = panesReducer(state, reconcileTerminalSessionRefByTerminalId({
      terminalId: 'term-1',
      sessionRef: { provider: 'claude', sessionId: 'session-b' },
      previousSessionId: 'session-a',
      spentNamingHandles: ['nh-bound-to-a'],
    }))

    expect(content(next).sessionRef).toEqual({ provider: 'claude', sessionId: 'session-b' })
    expect(content(next).namingHandle).toBeUndefined()
    expect(content(next).nameRef).toBeUndefined()
    expect(resolvePaneNameRef(content(next))).toEqual({
      kind: 'session', provider: 'claude', sessionId: 'session-b',
    })
  })

  it('a rebind also drops a naming ref that named the superseded session', () => {
    const state = stateWithTerminalPane({
      sessionRef: { provider: 'claude', sessionId: 'session-a' },
      nameRef: { kind: 'session', provider: 'claude', sessionId: 'session-a' },
    })

    const next = panesReducer(state, reconcileTerminalSessionRefByTerminalId({
      terminalId: 'term-1',
      sessionRef: { provider: 'claude', sessionId: 'session-b' },
      previousSessionId: 'session-a',
    }))

    expect(resolvePaneNameRef(content(next))).toEqual({
      kind: 'session', provider: 'claude', sessionId: 'session-b',
    })
  })

  it('a zero-turn switch keeps the still-pending handle (the server transfers it onto the new session)', () => {
    const state = stateWithTerminalPane({
      sessionRef: { provider: 'claude', sessionId: 'session-a' },
      namingHandle: 'nh-never-transferred',
      nameRef: { kind: 'pending', id: 'nh-never-transferred' },
    })

    const next = panesReducer(state, reconcileTerminalSessionRefByTerminalId({
      terminalId: 'term-1',
      sessionRef: { provider: 'claude', sessionId: 'session-b' },
      previousSessionId: 'session-a',
    }))

    expect(content(next).sessionRef).toEqual({ provider: 'claude', sessionId: 'session-b' })
    expect(content(next).namingHandle).toBe('nh-never-transferred')
    expect(resolvePaneNameRef(content(next))).toEqual({ kind: 'pending', id: 'nh-never-transferred' })
  })

  it('a first association keeps the pending handle (it binds to that first session)', () => {
    const state = stateWithTerminalPane({
      mode: 'opencode',
      namingHandle: 'nh-fresh',
    })

    const next = panesReducer(state, reconcileTerminalSessionRefByTerminalId({
      terminalId: 'term-1',
      sessionRef: { provider: 'opencode', sessionId: 'ses_first' },
    }))

    expect(content(next).sessionRef).toEqual({ provider: 'opencode', sessionId: 'ses_first' })
    expect(content(next).namingHandle).toBe('nh-fresh')
    expect(resolvePaneNameRef(content(next))).toEqual({ kind: 'pending', id: 'nh-fresh' })
  })

  it('a same-session association keeps the naming identity', () => {
    const state = stateWithTerminalPane({
      sessionRef: { provider: 'claude', sessionId: 'session-a' },
      namingHandle: 'nh-a',
    })

    const next = panesReducer(state, reconcileTerminalSessionRefByTerminalId({
      terminalId: 'term-1',
      sessionRef: { provider: 'claude', sessionId: 'session-a' },
      previousSessionId: 'session-a',
    }))

    expect(content(next).namingHandle).toBe('nh-a')
  })

  it('a repeated association can correct a spent handle without changing session identity', () => {
    const state = stateWithTerminalPane({
      sessionRef: { provider: 'claude', sessionId: 'session-b' },
      namingHandle: 'nh-spent-on-a',
    })

    const next = panesReducer(state, reconcileTerminalSessionRefByTerminalId({
      terminalId: 'term-1',
      sessionRef: { provider: 'claude', sessionId: 'session-b' },
      nameRef: { kind: 'session', provider: 'claude', sessionId: 'session-b' },
    }))

    expect(resolvePaneNameRef(content(next))).toEqual({
      kind: 'session', provider: 'claude', sessionId: 'session-b',
    })
    expect(content(next).namingHandle).toBeUndefined()
  })
})
