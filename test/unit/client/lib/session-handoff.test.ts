import { describe, expect, it, vi, beforeEach } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'

// The handoff request seam — mocked so the test drives the CLIENT fold.
const requestSessionHandoffMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    requestSessionHandoff: requestSessionHandoffMock,
  }
})

import { runPaneSessionHandoff, runPaneSessionRecovery } from '@/lib/session-handoff'
import panesReducer, { initLayout } from '@/store/panesSlice'
import freshAgentReducer, { applyRuntimeOwner } from '@/store/freshAgentSlice'
import tabsReducer, { addTab } from '@/store/tabsSlice'
import settingsReducer from '@/store/settingsSlice'
import type { RootState } from '@/store/store'

const OLD_SESSION_ID = '11111111-2222-4333-8444-555555555555'
const NEW_SESSION_ID = '66666666-7777-4888-8999-aaaaaaaaaaaa'

function buildStore(): RootState['panes'] extends never ? never : ReturnType<typeof configureStore> {
  return configureStore({
    reducer: {
      panes: panesReducer,
      settings: settingsReducer,
      freshAgent: freshAgentReducer,
      tabs: tabsReducer,
    },
  })
}

function seedRekeyedPane(
  store: ReturnType<typeof buildStore>,
  status: 'idle' | 'creating' | 'starting' = 'idle',
  checkpointWorkspace?: { path: string; provenance: 'directory-picker' | 'resolved-project' | 'legacy-checkpoint' },
) {
  store.dispatch(addTab({ id: 'tab-1' }))
  store.dispatch(initLayout({
    tabId: 'tab-1',
    paneId: 'pane-1',
    content: {
      kind: 'fresh-agent',
      sessionType: 'freshclaude',
      provider: 'claude',
      createRequestId: 'req-handoff',
      sessionRef: { provider: 'claude', sessionId: OLD_SESSION_ID },
      status,
      ...(checkpointWorkspace ? { checkpointWorkspace } : {}),
    },
  }))
  // The rekey mirror pair: the OLD key's record carries the canonical
  // owner state + aliasOf; the CANONICAL key holds the live record.
  store.dispatch(applyRuntimeOwner({
    type: 'session.runtimeOwner',
    provider: 'claude',
    sessionId: OLD_SESSION_ID,
    epoch: 3,
    generation: 2,
    ownerKind: 'fresh-agent',
    operationId: 'rekey-1',
    transition: 'handoff-committed',
    aliasOf: NEW_SESSION_ID,
  }))
  store.dispatch(applyRuntimeOwner({
    type: 'session.runtimeOwner',
    provider: 'claude',
    sessionId: NEW_SESSION_ID,
    epoch: 3,
    generation: 2,
    ownerKind: 'fresh-agent',
    operationId: 'rekey-1',
    transition: 'handoff-committed',
  }))
}

describe('b8ke ext F1: the direct handoff navigates the rekey alias chain', () => {
  beforeEach(() => {
    requestSessionHandoffMock.mockReset()
  })

  it('requests and records the CANONICAL session id for an old-key pane', async () => {
    const store = buildStore()
    seedRekeyedPane(store)
    requestSessionHandoffMock.mockResolvedValue({
      ok: true,
      operationId: 'ho-1',
      generation: 3,
      owner: { kind: 'terminal', terminalId: 't-canonical', mode: 'claude' },
    })

    const result = await runPaneSessionHandoff(store, { tabId: 'tab-1', paneId: 'pane-1' })
    expect(result).toBe(true)

    // THE REQUEST rides the pane's resolved CANONICAL key (the server
    // typed-refuses the superseded aliased key with REKEYED_ALIAS_KEY —
    // pre-ext the request carried the old id).
    expect(requestSessionHandoffMock).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'claude',
      sessionId: NEW_SESSION_ID,
      targetKind: 'terminal',
    }))

    // THE WRITE records the canonical id — the terminal attach content
    // carries the canonical sessionRef (pre-ext the fold wrote the old
    // key back, re-anchoring the pane on the superseded id).
    const layout = store.getState().panes.layouts['tab-1'] as Extract<
      import('@/store/paneTypes').PaneNode,
      { type: 'leaf' }
    >
    expect(layout.content).toMatchObject({
      kind: 'terminal',
      terminalId: 't-canonical',
    })
    expect((layout.content as { sessionRef?: { sessionId: string } }).sessionRef)
      .toEqual({ provider: 'claude', sessionId: NEW_SESSION_ID })
  })

  it('records the server-answered canonical owner sessionId on the fresh-agent arm', async () => {
    const store = buildStore()
    const checkpointWorkspace = { path: '/projects/explicit', provenance: 'directory-picker' as const }
    seedRekeyedPane(store, 'idle', checkpointWorkspace)
    requestSessionHandoffMock.mockResolvedValue({
      ok: true,
      operationId: 'ho-2',
      generation: 4,
      owner: { kind: 'fresh-agent', sessionId: NEW_SESSION_ID, sessionType: 'freshclaude', provider: 'claude' },
    })

    const result = await runPaneSessionHandoff(store, { tabId: 'tab-1', paneId: 'pane-1' })
    expect(result).toBe(true)
    expect(requestSessionHandoffMock).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: NEW_SESSION_ID,
    }))

    // The fresh-agent resume content records the server's canonical
    // owner sessionId (pre-ext the fold wrote the pane's old target id).
    const layout = store.getState().panes.layouts['tab-1'] as Extract<
      import('@/store/paneTypes').PaneNode,
      { type: 'leaf' }
    >
    expect(layout.content).toMatchObject({ kind: 'fresh-agent' })
    expect((layout.content as { sessionRef?: { sessionId: string } }).sessionRef)
      .toEqual({ provider: 'claude', sessionId: NEW_SESSION_ID })
    expect((layout.content as { checkpointWorkspace?: typeof checkpointWorkspace }).checkpointWorkspace)
      .toEqual(checkpointWorkspace)
  })
})

describe('clear-only recovery remains callable while a pane is starting', () => {
  beforeEach(() => {
    requestSessionHandoffMock.mockReset()
  })

  it('sends exactly the clear action and leaves pane identity unchanged', async () => {
    const store = buildStore()
    seedRekeyedPane(store, 'starting')
    requestSessionHandoffMock.mockResolvedValue({
      ok: true,
      cleared: 'platform-limited-fence',
      operationId: 'clear-starting',
      generation: 5,
      shutdownConfirmed: false,
    })

    await runPaneSessionRecovery(store, {
      tabId: 'tab-1',
      paneId: 'pane-1',
      action: 'clear-stale-bookkeeping',
    })

    expect(requestSessionHandoffMock).toHaveBeenCalledTimes(1)
    expect(requestSessionHandoffMock).toHaveBeenCalledWith(expect.objectContaining({
      action: 'clear-stale-bookkeeping',
      sessionId: NEW_SESSION_ID,
    }))
    const leaf = store.getState().panes.layouts['tab-1'] as Extract<
      import('@/store/paneTypes').PaneNode,
      { type: 'leaf' }
    >
    expect(leaf.content).toMatchObject({
      kind: 'fresh-agent',
      status: 'starting',
      sessionRef: { provider: 'claude', sessionId: OLD_SESSION_ID },
    })
  })
})

describe('b8ke ext r12 F1: the acknowledged force-clear STOPS at the clear', () => {
  beforeEach(() => {
    requestSessionHandoffMock.mockReset()
  })

  it('performs NO handoff request after the clear and surfaces the cleared state', async () => {
    const store = buildStore()
    seedRekeyedPane(store)
    // The first call answers the acknowledged clear; a SECOND call (the
    // pre-fix auto-retry) would answer a committed handoff — the call
    // count is the red/green observable.
    requestSessionHandoffMock
      .mockResolvedValueOnce({
        ok: true,
        cleared: 'platform-limited-fence',
        operationId: 'clear-1',
        generation: 5,
      })
      .mockResolvedValueOnce({
        ok: true,
        operationId: 'ho-auto-retry',
        generation: 6,
        owner: { kind: 'terminal', terminalId: 't-auto', mode: 'claude' },
      })

    const result = await runPaneSessionRecovery(store, {
      tabId: 'tab-1',
      paneId: 'pane-1',
      action: 'clear-stale-bookkeeping',
    })
    expect(result).toBe(false)

    // THE CLEAR-THEN-STOP CONTRACT: exactly ONE request (the clear
    // itself) — pre-fix the client auto-retried the handoff after the
    // clear, starting a writer over the acknowledged-risk tree.
    expect(requestSessionHandoffMock).toHaveBeenCalledTimes(1)
    expect(requestSessionHandoffMock).toHaveBeenCalledWith(expect.objectContaining({
      action: 'clear-stale-bookkeeping',
    }))

    // The cleared state is SURFACED (the banner's explicit user action
    // re-initiates the handoff; no automatic retry ever runs).
    const leaf = store.getState().panes.layouts['tab-1'] as Extract<
      import('@/store/paneTypes').PaneNode,
      { type: 'leaf' }
    >
    expect(leaf.content).toMatchObject({
      kind: 'fresh-agent',
      handoffError: {
        code: 'HANDOFF_FORCE_CLEARED',
        retryable: true,
        generation: 5,
      },
    })
  })
})
