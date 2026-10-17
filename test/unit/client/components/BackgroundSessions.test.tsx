import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import BackgroundSessions from '../../../../src/components/BackgroundSessions'
import tabsReducer from '../../../../src/store/tabsSlice'
import panesReducer from '../../../../src/store/panesSlice'
import settingsReducer from '../../../../src/store/settingsSlice'
import terminalDirectoryReducer from '../../../../src/store/terminalDirectorySlice'
import freshAgentReducer, { applyRuntimeOwner } from '../../../../src/store/freshAgentSlice'
import type { ManagedRuntimeRecoverySummary } from '@shared/managed-runtime'

const sentMessages: any[] = []
const mockGetTerminalDirectoryPage = vi.fn()
const wsMessageHandlers = vi.hoisted(() => new Set<(msg: unknown) => void>())

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    connect: () => Promise.resolve(),
    send: (msg: any) => {
      sentMessages.push(msg)
    },
    onMessage: (handler: (msg: unknown) => void) => {
      wsMessageHandlers.add(handler)
      return () => {
        wsMessageHandlers.delete(handler)
      }
    },
  }),
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getTerminalDirectoryPage: (...args: any[]) => mockGetTerminalDirectoryPage(...args),
  }
})

function makeStore() {
  return configureStore({
    reducer: {
      tabs: tabsReducer,
      panes: panesReducer,
      settings: settingsReducer,
      terminalDirectory: terminalDirectoryReducer,
      freshAgent: freshAgentReducer,
    },
  })
}

const retainedCases = [
  { recoveryState: 'blocked', runtimeStatus: 'blocked', paneStatus: 'error', label: 'Blocked' },
  { recoveryState: 'lost', runtimeStatus: 'exited', paneStatus: 'error', label: 'Lost' },
  { recoveryState: 'stopped', runtimeStatus: 'exited', paneStatus: 'exited', label: 'Stopped' },
] as const

const retainedRecoverySummary: ManagedRuntimeRecoverySummary = {
  desiredState: 'running', recoveryState: 'blocked', reason: 'STORE_UNREADABLE',
  attemptId: 'attempt-retained', incidentId: 'incident-retained',
  durabilityState: 'resume_captured', allocationState: 'verified_durable',
}

function retainedDirectoryPage({ recoveryState, runtimeStatus }: typeof retainedCases[number]) {
  return {
    items: [{
      terminalId: 'retained-managed', title: 'Retained managed', mode: 'codex',
      status: runtimeStatus, runtimeStatus, soulId: 'soul-retained', hasClients: false,
      createdAt: 1, lastActivityAt: 2,
      recoverySummary: { ...retainedRecoverySummary, recoveryState },
      sessionRef: { provider: 'codex', sessionId: 'native-retained' },
    }],
    nextCursor: null,
    revision: 1,
  }
}

describe('BackgroundSessions', () => {
  beforeEach(() => {
    sentMessages.length = 0
    wsMessageHandlers.clear()
    mockGetTerminalDirectoryPage.mockReset()
    mockGetTerminalDirectoryPage.mockResolvedValue({
      items: [
        {
          terminalId: 'term-codex-1',
          title: 'Codex',
          mode: 'codex',
          sessionRef: {
            provider: 'codex',
            sessionId: 'codex-sess-abc',
          },
          createdAt: Date.now() - 60000,
          lastActivityAt: Date.now() - 30000,
          status: 'running',
          hasClients: false,
        },
      ],
      nextCursor: null,
      revision: 1,
    })
  })

  afterEach(() => {
    cleanup()
  })

  it.each(retainedCases)('shows the retained $recoveryState row reason and final status', async (row) => {
    mockGetTerminalDirectoryPage.mockResolvedValue(retainedDirectoryPage(row))
    render(<Provider store={makeStore()}><BackgroundSessions /></Provider>)
    await screen.findByRole('button', { name: 'Attach' })
    expect(screen.getByText('STORE_UNREADABLE')).toBeVisible()
    expect(screen.getByText(row.label)).toBeVisible()
  })

  it.each(retainedCases)('attaches the retained $recoveryState row with its exact status and existing identity', async (row) => {
    mockGetTerminalDirectoryPage.mockResolvedValue(retainedDirectoryPage(row))
    const store = makeStore()
    const user = userEvent.setup()
    render(<Provider store={store}><BackgroundSessions /></Provider>)
    const attach = await screen.findByRole('button', { name: 'Attach' })
    await user.click(attach)
    const [tab] = store.getState().tabs.tabs
    const layout = store.getState().panes.layouts[tab.id]
    expect(layout.type).toBe('leaf')
    if (layout.type !== 'leaf') throw new Error('expected leaf')
    expect(layout.content).toMatchObject({
      terminalId: 'retained-managed', mode: 'codex', soulId: 'soul-retained', runtimeStatus: row.runtimeStatus,
      sessionRef: { provider: 'codex', sessionId: 'native-retained' },
    })
    expect(layout.content.status).toBe(row.paneStatus)
    expect(tab.status).toBe(layout.content.status)
    expect(layout.content).toMatchObject({ recoverySummary: { reason: 'STORE_UNREADABLE',
      attemptId: 'attempt-retained', incidentId: 'incident-retained' } })
  })

  it('attaches with the real terminal mode, not hardcoded shell', async () => {
    const store = makeStore()
    const user = userEvent.setup()

    render(
      <Provider store={store}>
        <BackgroundSessions />
      </Provider>
    )

    // Wait for the list to load and render.
    const attachBtn = await screen.findByRole('button', { name: 'Attach' })
    await user.click(attachBtn)

    const tabs = store.getState().tabs.tabs
    expect(tabs).toHaveLength(1)
    expect(tabs[0].mode).toBe('codex')
    expect(tabs[0].sessionRef).toEqual({
      provider: 'codex',
      sessionId: 'codex-sess-abc',
    })
    // terminalId is in pane content, not on the tab
    const layout = store.getState().panes.layouts[tabs[0].id]
    expect(layout).toBeDefined()
    expect(layout.type).toBe('leaf')
    if (layout.type === 'leaf') {
      expect(layout.content.kind).toBe('terminal')
      if (layout.content.kind === 'terminal') {
        expect(layout.content.terminalId).toBe('term-codex-1')
        expect(layout.content.sessionRef).toEqual({
          provider: 'codex',
          sessionId: 'codex-sess-abc',
        })
      }
    }
  })

  it('preserves the provider cwd when opening a running Claude background session', async () => {
    mockGetTerminalDirectoryPage.mockResolvedValue({
      items: [
        {
          terminalId: 'term-live-claude',
          title: 'Claude',
          mode: 'claude',
          cwd: '/home/user/live-project',
          sessionRef: {
            provider: 'claude',
            sessionId: '550e8400-e29b-41d4-a716-446655440000',
          },
          createdAt: Date.now() - 60000,
          lastActivityAt: Date.now() - 30000,
          status: 'running',
          hasClients: false,
        },
      ],
      nextCursor: null,
      revision: 2,
    })
    const store = makeStore()
    const user = userEvent.setup()

    render(
      <Provider store={store}>
        <BackgroundSessions />
      </Provider>
    )

    const attachBtn = await screen.findByRole('button', { name: 'Attach' })
    await user.click(attachBtn)

    const [tab] = store.getState().tabs.tabs
    expect(tab.initialCwd).toBe('/home/user/live-project')
    const layout = store.getState().panes.layouts[tab.id]
    expect(layout).toBeDefined()
    expect(layout.type).toBe('leaf')
    if (layout.type === 'leaf') {
      expect(layout.content.kind).toBe('terminal')
      if (layout.content.kind === 'terminal') {
        expect(layout.content).toMatchObject({
          kind: 'terminal',
          mode: 'claude',
          initialCwd: '/home/user/live-project',
          sessionRef: {
            provider: 'claude',
            sessionId: '550e8400-e29b-41d4-a716-446655440000',
          },
        })
      }
    }
  })

  // ── b8ke ext r20 F2: the Kill button carries the observed fence ─────────

  it('the Kill button sends the kill with the session-owner fence on the wire (b8ke ext r20 F2)', async () => {
    const store = makeStore()
    // The runtimeOwners record for the background terminal's session:
    // (epoch 12, generation 34) — the observed pair the kill must carry
    // so a reconnect-queued stale kill is typed-refused instead of
    // killing a newer owner.
    store.dispatch(applyRuntimeOwner({
      type: 'session.runtimeOwner',
      provider: 'codex',
      sessionId: 'codex-sess-abc',
      epoch: 12,
      generation: 34,
      ownerKind: 'terminal',
      operationId: 'handoff-1',
      transition: 'handoff-committed',
    }))
    const user = userEvent.setup()
    render(
      <Provider store={store}>
        <BackgroundSessions />
      </Provider>,
    )
    const kill = await screen.findByRole('button', { name: /kill/i })
    await user.click(kill)
    expect(sentMessages).toContainEqual({
      type: 'terminal.kill',
      terminalId: 'term-codex-1',
      observedEpoch: 12,
      observedGeneration: 34,
    })
  })

  it('a Kill with NO session-owner record sends no pair (the legit no-fence shape)', async () => {
    const store = makeStore()
    const user = userEvent.setup()
    render(
      <Provider store={store}>
        <BackgroundSessions />
      </Provider>,
    )
    const kill = await screen.findByRole('button', { name: /kill/i })
    await user.click(kill)
    // No owner record for the session → no pair on the wire.
    expect(sentMessages).toContainEqual({ type: 'terminal.kill', terminalId: 'term-codex-1' })
  })

  // b8ke fence-heal (fix b): detached terminals have NO mounted
  // TerminalView to consume their typed kill refusal — the component's own
  // ws subscription folds the refusal's CURRENT pair onto the row's session
  // record, so the NEXT Kill click (send-time fence read) carries the fresh
  // pair instead of looping on the refused stale one.
  it('a typed kill refusal for a background row folds the fresh pair — the NEXT Kill click sends it (fix b)', async () => {
    const store = makeStore()
    store.dispatch(applyRuntimeOwner({
      type: 'session.runtimeOwner',
      provider: 'codex',
      sessionId: 'codex-sess-abc',
      epoch: 12,
      generation: 34,
      ownerKind: 'terminal',
      operationId: 'handoff-1',
      transition: 'handoff-committed',
    }))
    const user = userEvent.setup()
    render(
      <Provider store={store}>
        <BackgroundSessions />
      </Provider>,
    )
    const kill = await screen.findByRole('button', { name: /kill/i })

    // The first Kill carries the observed (stale) pair.
    await user.click(kill)
    expect(sentMessages).toContainEqual({
      type: 'terminal.kill',
      terminalId: 'term-codex-1',
      observedEpoch: 12,
      observedGeneration: 34,
    })

    // The typed refusal (no requestId; the row's own terminalId) lands on
    // the component's message subscription.
    const refusal = {
      type: 'error',
      code: 'SESSION_RESERVED',
      terminalId: 'term-codex-1',
      ownerKind: 'terminal',
      ownerEpoch: 12,
      ownerGeneration: 40,
      message: 'ownership moved to a newer runtime; refresh and retry',
      timestamp: new Date().toISOString(),
    }
    for (const handler of [...wsMessageHandlers]) handler(refusal)

    // The fold landed on the row's session record (merge-only).
    const folded = store.getState().freshAgent.runtimeOwners['codex:codex-sess-abc']
    expect(folded.generation).toBe(40)
    expect(folded.ownerKind).toBe('terminal')

    // The NEXT Kill click sends the fresh pair.
    sentMessages.length = 0
    await user.click(kill)
    expect(sentMessages).toContainEqual({
      type: 'terminal.kill',
      terminalId: 'term-codex-1',
      observedEpoch: 12,
      observedGeneration: 40,
    })
  })
})
