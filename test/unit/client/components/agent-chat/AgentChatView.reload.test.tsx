import { describe, it, expect, vi, afterEach, beforeAll, beforeEach } from 'vitest'
import { render, screen, cleanup, act, waitFor } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider, useSelector } from 'react-redux'
import AgentChatView from '@/components/agent-chat/AgentChatView'
import { handleSdkMessage } from '@/lib/sdk-message-handler'
import { loadAgentTurnBody } from '@/store/agentChatThunks'
import agentChatReducer, {
  addAssistantMessage,
  addUserMessage,
  registerPendingCreate,
  restoreRetryRequested,
  sessionCreated,
  sessionInit,
  sessionMetadataReceived,
  sessionSnapshotReceived,
  setSessionStatus,
  timelinePageReceived,
  turnBodyReceived,
} from '@/store/agentChatSlice'
import panesReducer, { hydratePanes, initLayout } from '@/store/panesSlice'
import { flushPersistedLayoutNow } from '@/store/persistControl'
import settingsReducer from '@/store/settingsSlice'
import tabsReducer, { addTab } from '@/store/tabsSlice'
import { tabFallbackIdentityMiddleware } from '@/store/tabFallbackIdentityMiddleware'
import type { AgentChatPaneContent } from '@/store/paneTypes'
import type { PaneNode } from '@/store/paneTypes'

// jsdom doesn't implement scrollIntoView
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
})

const DURABLE_SESSION_ID = '00000000-0000-4000-8000-000000000201'
const DURABLE_SESSION_ID_ALT = '00000000-0000-4000-8000-000000000202'
const DURABLE_SHELL_SESSION_ID = '00000000-0000-4000-8000-000000000203'
const DURABLE_RUNNING_SESSION_ID = '00000000-0000-4000-8000-000000000204'
const DURABLE_SESSION_ID_NEXT = '00000000-0000-4000-8000-000000000205'

const wsSend = vi.fn()
const getAgentTimelinePage = vi.fn()
const getAgentTurnBody = vi.fn()
const getAgentChatCapabilities = vi.fn()
const setSessionMetadata = vi.fn(() => Promise.resolve(undefined))
const saveServerSettingsPatchSpy = vi.hoisted(() => vi.fn((patch: unknown) => ({
  type: 'settings/saveServerSettingsPatch',
  payload: patch,
})))

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    send: wsSend,
    onReconnect: vi.fn(() => vi.fn()),
  }),
}))

vi.mock('@/store/settingsThunks', () => ({
  saveServerSettingsPatch: (patch: unknown) => saveServerSettingsPatchSpy(patch),
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getAgentTimelinePage: (...args: unknown[]) => getAgentTimelinePage(...args),
    getAgentTurnBody: (...args: unknown[]) => getAgentTurnBody(...args),
    getAgentChatCapabilities: (...args: unknown[]) => getAgentChatCapabilities(...args),
    setSessionMetadata: (...args: unknown[]) => setSessionMetadata(...args),
  }
})

function makeStore() {
  return configureStore({
    reducer: {
      agentChat: agentChatReducer,
      panes: panesReducer,
      settings: settingsReducer,
    },
  })
}

function makeStoreWithTabs() {
  return configureStore({
    reducer: {
      agentChat: agentChatReducer,
      panes: panesReducer,
      settings: settingsReducer,
      tabs: tabsReducer,
    },
    middleware: (getDefault) => getDefault().concat(tabFallbackIdentityMiddleware),
  })
}

function makeTimelineItem(
  turnId: string,
  role: 'user' | 'assistant',
  summary: string,
  overrides: Partial<{
    sessionId: string
    messageId: string
    ordinal: number
    source: 'durable' | 'live'
    timestamp: string
  }> = {},
) {
  return {
    turnId,
    messageId: overrides.messageId ?? `message:${turnId}`,
    ordinal: overrides.ordinal ?? 0,
    source: overrides.source ?? 'durable',
    sessionId: overrides.sessionId ?? 'sess-reload-1',
    role,
    summary,
    ...(overrides.timestamp ? { timestamp: overrides.timestamp } : {}),
  }
}

function makeTimelineTurn(
  turnId: string,
  role: 'user' | 'assistant',
  text: string,
  overrides: Partial<{
    sessionId: string
    messageId: string
    ordinal: number
    source: 'durable' | 'live'
    timestamp: string
  }> = {},
) {
  return {
    sessionId: overrides.sessionId ?? 'sess-reload-1',
    turnId,
    messageId: overrides.messageId ?? `message:${turnId}`,
    ordinal: overrides.ordinal ?? 0,
    source: overrides.source ?? 'durable',
    message: {
      role,
      content: [{ type: 'text' as const, text }],
      timestamp: overrides.timestamp ?? '2026-01-01T00:00:01Z',
    },
  }
}

const RELOAD_PANE: AgentChatPaneContent = {
  kind: 'agent-chat', provider: 'freshclaude',
  createRequestId: 'req-1',
  sessionId: 'sess-reload-1',
  status: 'idle',
}

const RELOAD_PANE_WITH_CANONICAL_RESUME: AgentChatPaneContent = {
  ...RELOAD_PANE,
  sessionRef: {
    provider: 'claude',
    sessionId: '00000000-0000-4000-8000-000000000321',
  },
}

const RELOAD_PANE_WITH_NAMED_RESUME: AgentChatPaneContent = {
  ...RELOAD_PANE,
  resumeSessionId: 'named-resume-token',
}

describe('AgentChatView reload/restore behavior', () => {
  beforeEach(() => {
    localStorage.clear()
    getAgentTimelinePage.mockReset()
    getAgentTurnBody.mockReset()
    getAgentChatCapabilities.mockReset()
    setSessionMetadata.mockReset()
    setSessionMetadata.mockResolvedValue(undefined)
  })

  afterEach(() => {
    cleanup()
    wsSend.mockClear()
    saveServerSettingsPatchSpy.mockClear()
    localStorage.clear()
    delete window.__FRESHELL_TEST_HARNESS__
  })

  it('sends sdk.attach on mount when paneContent has a persisted sessionId', () => {
    const store = makeStore()
    render(
      <Provider store={store}>
        <AgentChatView tabId="t1" paneId="p1" paneContent={RELOAD_PANE} />
      </Provider>,
    )

    expect(wsSend).toHaveBeenCalledWith({
      type: 'sdk.attach',
      sessionId: 'sess-reload-1',
    })
  })

  it('includes the canonical durable resumeSessionId when attaching a persisted pane on mount', () => {
    const store = makeStore()
    render(
      <Provider store={store}>
        <AgentChatView
          tabId="t1"
          paneId="p1"
          paneContent={RELOAD_PANE_WITH_CANONICAL_RESUME}
        />
      </Provider>,
    )

    expect(wsSend).toHaveBeenCalledWith({
      type: 'sdk.attach',
      sessionId: 'sess-reload-1',
      resumeSessionId: '00000000-0000-4000-8000-000000000321',
    })
  })

  it('does not send a mutable named resume token when attaching a persisted pane', () => {
    const store = makeStore()
    render(
      <Provider store={store}>
        <AgentChatView
          tabId="t1"
          paneId="p1"
          paneContent={RELOAD_PANE_WITH_NAMED_RESUME}
        />
      </Provider>,
    )

    expect(wsSend).toHaveBeenCalledWith({
      type: 'sdk.attach',
      sessionId: 'sess-reload-1',
    })
  })

  it('skips sdk.attach when the e2e harness suppresses agent chat network effects for the pane', () => {
    window.__FRESHELL_TEST_HARNESS__ = {
      getState: vi.fn(),
      dispatch: vi.fn(),
      getWsReadyState: vi.fn(),
      waitForConnection: vi.fn(),
      forceDisconnect: vi.fn(),
      sendWsMessage: vi.fn(),
      setAgentChatNetworkEffectsSuppressed: vi.fn(),
      isAgentChatNetworkEffectsSuppressed: vi.fn((paneId: string) => paneId === 'p1'),
      setTerminalNetworkEffectsSuppressed: vi.fn(),
      isTerminalNetworkEffectsSuppressed: vi.fn(() => false),
      getTerminalBuffer: vi.fn(),
      registerTerminalBuffer: vi.fn(),
      unregisterTerminalBuffer: vi.fn(),
      getPerfAuditSnapshot: vi.fn(),
    }

    const store = makeStore()
    render(
      <Provider store={store}>
        <AgentChatView tabId="t1" paneId="p1" paneContent={RELOAD_PANE} />
      </Provider>,
    )

    const attachCalls = wsSend.mock.calls.filter(
      (c: any[]) => c[0]?.type === 'sdk.attach',
    )
    expect(attachCalls).toHaveLength(0)
  })

  it('does NOT send sdk.attach when paneContent has no sessionId (new session)', () => {
    const store = makeStore()
    const newPane: AgentChatPaneContent = {
      kind: 'agent-chat', provider: 'freshclaude',
      createRequestId: 'req-new',
      status: 'creating',
    }
    render(
      <Provider store={store}>
        <AgentChatView tabId="t1" paneId="p1" paneContent={newPane} />
      </Provider>,
    )

    const attachCalls = wsSend.mock.calls.filter(
      (c: any[]) => c[0]?.type === 'sdk.attach',
    )
    expect(attachCalls).toHaveLength(0)
  })

  it('shows sdk.create.failed retry UI without fabricating a session id and only retries on click', async () => {
    const store = makeStore()
    const pane: AgentChatPaneContent = {
      kind: 'agent-chat',
      provider: 'freshclaude',
      createRequestId: 'req-create-failed',
      status: 'creating',
    }

    store.dispatch(initLayout({ tabId: 't1', content: pane, paneId: 'p1' }))

    function Wrapper() {
      const root = useSelector((s: ReturnType<typeof store.getState>) => s.panes.layouts.t1)
      const content = root?.type === 'leaf' && root.content.kind === 'agent-chat'
        ? root.content
        : undefined
      if (!content) return null
      return <AgentChatView tabId="t1" paneId="p1" paneContent={content} />
    }

    render(
      <Provider store={store}>
        <Wrapper />
      </Provider>,
    )

    await waitFor(() => {
      const createCalls = wsSend.mock.calls.filter((call) => call[0]?.type === 'sdk.create')
      expect(createCalls).toHaveLength(1)
    })

    act(() => {
      handleSdkMessage(store.dispatch, {
        type: 'sdk.create.failed',
        requestId: 'req-create-failed',
        code: 'RESTORE_INTERNAL',
        message: 'Restore bootstrap failed',
        retryable: true,
      })
    })

    expect(await screen.findByText('Session start failed')).toBeInTheDocument()
    expect(screen.getByText('Restore bootstrap failed')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()

    const failedContent = getPaneContent(store, 't1', 'p1')
    expect(failedContent).toBeDefined()
    expect(failedContent!.sessionId).toBeUndefined()
    expect(failedContent!.status).toBe('create-failed')

    const createCallsAfterFailure = wsSend.mock.calls.filter((call) => call[0]?.type === 'sdk.create')
    const attachCallsAfterFailure = wsSend.mock.calls.filter((call) => call[0]?.type === 'sdk.attach')
    expect(createCallsAfterFailure).toHaveLength(1)
    expect(attachCallsAfterFailure).toHaveLength(0)

    act(() => {
      screen.getByRole('button', { name: 'Retry' }).click()
    })

    await waitFor(() => {
      const createCalls = wsSend.mock.calls.filter((call) => call[0]?.type === 'sdk.create')
      expect(createCalls).toHaveLength(2)
    })

    const retriedContent = getPaneContent(store, 't1', 'p1')
    expect(retriedContent).toBeDefined()
    expect(retriedContent!.sessionId).toBeUndefined()
    expect(retriedContent!.status).toBe('starting')
    expect((retriedContent as AgentChatPaneContent).createError).toBeUndefined()
  })

  it('sends provider-default creates as the stable opus track alias', async () => {
    const store = makeStore()
    const pane: AgentChatPaneContent = {
      kind: 'agent-chat',
      provider: 'freshclaude',
      createRequestId: 'req-provider-default',
      status: 'creating',
    }

    store.dispatch(initLayout({ tabId: 't1', content: pane, paneId: 'p1' }))

    function Wrapper() {
      const root = useSelector((s: ReturnType<typeof store.getState>) => s.panes.layouts.t1)
      const content = root?.type === 'leaf' && root.content.kind === 'agent-chat'
        ? root.content
        : undefined
      if (!content) return null
      return <AgentChatView tabId="t1" paneId="p1" paneContent={content} />
    }

    render(
      <Provider store={store}>
        <Wrapper />
      </Provider>,
    )

    await waitFor(() => {
      expect(wsSend).toHaveBeenCalledWith(expect.objectContaining({
        type: 'sdk.create',
        requestId: 'req-provider-default',
        model: 'opus',
      }))
    })
    const createCall = wsSend.mock.calls.find((call) => call[0]?.type === 'sdk.create')?.[0]
    expect(createCall).not.toHaveProperty('effort')
  })

  it('creates tracked live models directly without a capability fetch when no effort validation is needed', async () => {
    const store = makeStore()
    const pane: AgentChatPaneContent = {
      kind: 'agent-chat',
      provider: 'freshclaude',
      createRequestId: 'req-tracked',
      status: 'creating',
      modelSelection: { kind: 'tracked', modelId: 'opus[1m]' },
    }

    store.dispatch(initLayout({ tabId: 't1', content: pane, paneId: 'p1' }))

    function Wrapper() {
      const root = useSelector((s: ReturnType<typeof store.getState>) => s.panes.layouts.t1)
      const content = root?.type === 'leaf' && root.content.kind === 'agent-chat'
        ? root.content
        : undefined
      if (!content) return null
      return <AgentChatView tabId="t1" paneId="p1" paneContent={content} />
    }

    render(
      <Provider store={store}>
        <Wrapper />
      </Provider>,
    )

    await waitFor(() => {
      expect(wsSend).toHaveBeenCalledWith(expect.objectContaining({
        type: 'sdk.create',
        requestId: 'req-tracked',
        model: 'opus[1m]',
      }))
    })
    expect(getAgentChatCapabilities).not.toHaveBeenCalled()
  })

  it('validates explicit effort overrides before create and clears them when unsupported', async () => {
    getAgentChatCapabilities.mockResolvedValue({
      ok: true,
      capabilities: {
        provider: 'freshclaude',
        fetchedAt: Date.now(),
        models: [
          {
            id: 'haiku',
            displayName: 'Haiku',
            description: 'Fast path',
            supportsEffort: false,
            supportedEffortLevels: [],
            supportsAdaptiveThinking: false,
          },
        ],
      },
    })

    const store = makeStore()
    const pane: AgentChatPaneContent = {
      kind: 'agent-chat',
      provider: 'freshclaude',
      createRequestId: 'req-unsupported-effort',
      status: 'creating',
      modelSelection: { kind: 'tracked', modelId: 'haiku' },
      effort: 'turbo',
    }

    store.dispatch(initLayout({ tabId: 't1', content: pane, paneId: 'p1' }))

    function Wrapper() {
      const root = useSelector((s: ReturnType<typeof store.getState>) => s.panes.layouts.t1)
      const content = root?.type === 'leaf' && root.content.kind === 'agent-chat'
        ? root.content
        : undefined
      if (!content) return null
      return <AgentChatView tabId="t1" paneId="p1" paneContent={content} />
    }

    render(
      <Provider store={store}>
        <Wrapper />
      </Provider>,
    )

    await waitFor(() => {
      expect(getAgentChatCapabilities).toHaveBeenCalledWith('freshclaude', {})
      expect(wsSend).toHaveBeenCalledWith(expect.objectContaining({
        type: 'sdk.create',
        requestId: 'req-unsupported-effort',
        model: 'haiku',
      }))
    })
    const createCall = wsSend.mock.calls.find((call) => call[0]?.type === 'sdk.create')?.[0]
    expect(createCall).not.toHaveProperty('effort')
    expect(getPaneContent(store, 't1', 'p1')?.effort).toBeUndefined()
  })

  it('passes named resume tokens through sdk.create and keeps the session in restore mode until it upgrades', async () => {
    const store = makeStore()
    const pane: AgentChatPaneContent = {
      kind: 'agent-chat',
      provider: 'freshclaude',
      createRequestId: 'req-named-resume',
      status: 'creating',
      resumeSessionId: 'named-resume',
    }

    store.dispatch(initLayout({ tabId: 't1', content: pane, paneId: 'p1' }))

    function Wrapper() {
      const root = useSelector((s: ReturnType<typeof store.getState>) => s.panes.layouts.t1)
      const content = root?.type === 'leaf' && root.content.kind === 'agent-chat'
        ? root.content
        : undefined
      if (!content) return null
      return <AgentChatView tabId="t1" paneId="p1" paneContent={content} />
    }

    render(
      <Provider store={store}>
        <Wrapper />
      </Provider>,
    )

    await waitFor(() => {
      expect(wsSend).toHaveBeenCalledWith(expect.objectContaining({
        type: 'sdk.create',
        requestId: 'req-named-resume',
        model: 'opus',
        resumeSessionId: 'named-resume',
      }))
    })

    expect(store.getState().agentChat.pendingCreates['req-named-resume']).toEqual({
      sessionId: undefined,
      expectsHistoryHydration: true,
    })
  })

  it('blocks create when an exact unavailable selection cannot be launched safely', async () => {
    getAgentChatCapabilities.mockResolvedValue({
      ok: true,
      capabilities: {
        provider: 'freshclaude',
        fetchedAt: Date.now(),
        models: [
          {
            id: 'opus',
            displayName: 'Opus',
            description: 'Latest Opus track',
            supportsEffort: true,
            supportedEffortLevels: ['turbo'],
            supportsAdaptiveThinking: true,
          },
        ],
      },
    })

    const store = makeStore()
    const pane: AgentChatPaneContent = {
      kind: 'agent-chat',
      provider: 'freshclaude',
      createRequestId: 'req-unavailable-exact',
      status: 'creating',
      modelSelection: { kind: 'exact', modelId: 'claude-opus-4-6' },
    }

    store.dispatch(initLayout({ tabId: 't1', content: pane, paneId: 'p1' }))

    function Wrapper() {
      const root = useSelector((s: ReturnType<typeof store.getState>) => s.panes.layouts.t1)
      const content = root?.type === 'leaf' && root.content.kind === 'agent-chat'
        ? root.content
        : undefined
      if (!content) return null
      return <AgentChatView tabId="t1" paneId="p1" paneContent={content} />
    }

    render(
      <Provider store={store}>
        <Wrapper />
      </Provider>,
    )

    expect(await screen.findByText('Session start failed')).toBeInTheDocument()
    expect(screen.getByText(/no longer available/i)).toBeInTheDocument()
    expect(wsSend.mock.calls.filter((call) => call[0]?.type === 'sdk.create')).toHaveLength(0)
    expect(getPaneContent(store, 't1', 'p1')).toEqual(expect.objectContaining({
      status: 'create-failed',
      createError: expect.objectContaining({
        code: 'MODEL_UNAVAILABLE',
      }),
    }))
  })

  it('shows loading state instead of welcome screen when sessionId is set but messages have not arrived', () => {
    const store = makeStore()
    render(
      <Provider store={store}>
        <AgentChatView tabId="t1" paneId="p1" paneContent={RELOAD_PANE} />
      </Provider>,
    )

    // Should NOT show the Freshclaude welcome text
    expect(screen.queryByText('Freshclaude')).not.toBeInTheDocument()

    // Should show a restoring/loading indicator
    expect(screen.getByText(/restoring/i)).toBeInTheDocument()
  })

  it('shows welcome screen when no sessionId (brand new session)', () => {
    const store = makeStore()
    const newPane: AgentChatPaneContent = {
      kind: 'agent-chat', provider: 'freshclaude',
      createRequestId: 'req-new',
      status: 'creating',
    }
    render(
      <Provider store={store}>
        <AgentChatView tabId="t1" paneId="p1" paneContent={newPane} />
      </Provider>,
    )

    expect(screen.getByText('Freshclaude')).toBeInTheDocument()
  })

  it('replaces loading state with hydrated timeline content after the initial window arrives', () => {
    const store = makeStore()
    const { rerender } = render(
      <Provider store={store}>
        <AgentChatView tabId="t1" paneId="p1" paneContent={RELOAD_PANE} />
      </Provider>,
    )

    // Initially shows loading
    expect(screen.queryByText('Freshclaude')).not.toBeInTheDocument()
    expect(screen.getByText(/restoring/i)).toBeInTheDocument()

    store.dispatch(timelinePageReceived({
      sessionId: 'sess-reload-1',
      items: [
        makeTimelineItem('turn-1', 'assistant', 'Hello! How can I help?', {
          sessionId: 'sess-reload-1',
          ordinal: 1,
          timestamp: '2026-01-01T00:00:00Z',
        }),
      ],
      nextCursor: null,
      revision: 1,
      replace: true,
    }))
    store.dispatch(turnBodyReceived({
      sessionId: 'sess-reload-1',
      turn: makeTimelineTurn('turn-1', 'assistant', 'Hello! How can I help?', {
        sessionId: 'sess-reload-1',
        ordinal: 1,
        timestamp: '2026-01-01T00:00:01Z',
      }),
    }))

    // Force re-render to pick up store changes
    rerender(
      <Provider store={store}>
        <AgentChatView tabId="t1" paneId="p1" paneContent={RELOAD_PANE} />
      </Provider>,
    )

    // Loading should be gone
    expect(screen.queryByText(/restoring/i)).not.toBeInTheDocument()

    expect(screen.getByText('Hello! How can I help?')).toBeInTheDocument()
  })

  it('shows welcome screen (not restoring) for freshly created session with sessionId', () => {
    const store = makeStore()
    // Simulate sdk.created — Redux now has the session object
    store.dispatch(sessionCreated({ requestId: 'req-1', sessionId: 'sess-fresh' }))

    const freshPane: AgentChatPaneContent = {
      kind: 'agent-chat', provider: 'freshclaude',
      createRequestId: 'req-1',
      sessionId: 'sess-fresh',
      status: 'starting',
    }
    render(
      <Provider store={store}>
        <AgentChatView tabId="t1" paneId="p1" paneContent={freshPane} />
      </Provider>,
    )

    // Should show welcome, NOT "Restoring session..."
    expect(screen.queryByText(/restoring/i)).not.toBeInTheDocument()
    expect(screen.getByText('Freshclaude')).toBeInTheDocument()
  })

  it('does not show restoring for a fresh sdk.created session', () => {
    const store = makeStore()
    store.dispatch(registerPendingCreate({
      requestId: 'req-fresh',
      expectsHistoryHydration: false,
    }))
    store.dispatch(sessionCreated({
      requestId: 'req-fresh',
      sessionId: 'sdk-fresh',
    }))

    render(
      <Provider store={store}>
        <AgentChatView
          tabId="t1"
          paneId="p1"
          paneContent={{
            kind: 'agent-chat',
            provider: 'freshclaude',
            createRequestId: 'req-fresh',
            sessionId: 'sdk-fresh',
            status: 'starting',
          }}
        />
      </Provider>,
    )

    expect(screen.queryByText(/restoring/i)).not.toBeInTheDocument()
    expect(screen.getByText('Freshclaude')).toBeInTheDocument()
  })

  it('shows welcome screen (not stuck restoring) when the initial timeline window arrives empty', () => {
    const store = makeStore()
    const { rerender } = render(
      <Provider store={store}>
        <AgentChatView tabId="t1" paneId="p1" paneContent={RELOAD_PANE} />
      </Provider>,
    )

    // Initially shows restoring
    expect(screen.getByText(/restoring/i)).toBeInTheDocument()

    store.dispatch(timelinePageReceived({
      sessionId: 'sess-reload-1',
      items: [],
      nextCursor: null,
      revision: 1,
      replace: true,
    }))

    rerender(
      <Provider store={store}>
        <AgentChatView tabId="t1" paneId="p1" paneContent={RELOAD_PANE} />
      </Provider>,
    )

    // Should NOT be stuck on restoring
    expect(screen.queryByText(/restoring/i)).not.toBeInTheDocument()

    // Should show the welcome screen since session is empty
    expect(screen.getByText('Freshclaude')).toBeInTheDocument()
  })

  it('restores from sdk.session.snapshot plus HTTP timeline fetch without waiting for sdk.history', async () => {
    let resolveTurnBody: ((value: {
      sessionId: string
      turnId: string
      messageId: string
      ordinal: number
      source: 'durable' | 'live'
      message: {
        role: 'assistant'
        content: Array<{ type: 'text'; text: string }>
        timestamp: string
      }
    }) => void) | null = null
    getAgentTimelinePage.mockResolvedValue({
      sessionId: 'sess-reload-1',
      items: [
        makeTimelineItem('turn-2', 'assistant', 'Recent summary', {
          sessionId: 'sess-reload-1',
          ordinal: 2,
          timestamp: '2026-03-10T10:01:00.000Z',
        }),
      ],
      nextCursor: null,
      revision: 2,
    })
    getAgentTurnBody.mockImplementation(
      (_sessionId: string, _turnId: string, options?: { signal?: AbortSignal }) => (
        new Promise((resolve, reject) => {
          const signal = options?.signal
          const abort = () => {
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
          }
          if (signal?.aborted) {
            abort()
            return
          }
          signal?.addEventListener('abort', abort, { once: true })
          resolveTurnBody = (value) => {
            signal?.removeEventListener('abort', abort)
            resolve(value)
          }
        })
      ),
    )

    const store = makeStore()
    store.dispatch(sessionSnapshotReceived({
      sessionId: 'sess-reload-1',
      latestTurnId: 'turn-2',
      status: 'idle',
      revision: 2,
    }))

    render(
      <Provider store={store}>
        <AgentChatView tabId="t1" paneId="p1" paneContent={RELOAD_PANE} />
      </Provider>,
    )

    await waitFor(() => {
      expect(getAgentTimelinePage).toHaveBeenCalledWith(
        'sess-reload-1',
        expect.objectContaining({ priority: 'visible', revision: 2 }),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      )
    })
    expect(getAgentTurnBody).toHaveBeenCalledWith(
      'sess-reload-1',
      'turn-2',
      expect.objectContaining({ signal: expect.any(AbortSignal), revision: 2 }),
    )
    await act(async () => {
      resolveTurnBody?.({
        sessionId: 'sess-reload-1',
        turnId: 'turn-2',
        messageId: 'message:turn-2',
        ordinal: 2,
        source: 'durable',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Hydrated from HTTP timeline' }],
          timestamp: '2026-03-10T10:01:00.000Z',
        },
      })
      await Promise.resolve()
    })
    expect(await screen.findByText('Hydrated from HTTP timeline')).toBeInTheDocument()
    expect(screen.queryByText(/restoring/i)).not.toBeInTheDocument()
  })

  it('requests one fresh sdk.attach when the first visible timeline read returns RESTORE_STALE_REVISION', async () => {
    getAgentTimelinePage.mockRejectedValue({
      status: 409,
      message: 'Stale restore revision',
      details: {
        code: 'RESTORE_STALE_REVISION',
        currentRevision: 13,
      },
    })

    const store = makeStore()
    store.dispatch(sessionSnapshotReceived({
      sessionId: 'sess-reload-1',
      latestTurnId: 'turn-2',
      status: 'idle',
      timelineSessionId: DURABLE_SESSION_ID,
      revision: 12,
    }))

    render(
      <Provider store={store}>
        <AgentChatView tabId="t1" paneId="p1" paneContent={RELOAD_PANE} />
      </Provider>,
    )

    await waitFor(() => {
      const attachCalls = wsSend.mock.calls.filter((call) => call[0]?.type === 'sdk.attach')
      expect(attachCalls).toHaveLength(2)
      expect(attachCalls[1]?.[0]).toEqual({
        type: 'sdk.attach',
        sessionId: 'sess-reload-1',
        resumeSessionId: DURABLE_SESSION_ID,
      })
    })
  })

  it('clears stale hydrated timeline content and waits for a fresh snapshot before rereading after a stale restore retry', async () => {
    getAgentTimelinePage.mockResolvedValue({
      sessionId: DURABLE_SESSION_ID,
      items: [],
      nextCursor: null,
      revision: 13,
    })

    const store = makeStore()
    store.dispatch(sessionSnapshotReceived({
      sessionId: 'sess-reload-1',
      latestTurnId: 'turn-2',
      status: 'idle',
      timelineSessionId: DURABLE_SESSION_ID,
      revision: 12,
    }))
    store.dispatch(timelinePageReceived({
      sessionId: 'sess-reload-1',
      items: [
        makeTimelineItem('turn-2', 'assistant', 'Old stale summary', {
          sessionId: DURABLE_SESSION_ID,
          ordinal: 2,
          timestamp: '2026-03-10T10:01:00.000Z',
        }),
      ],
      nextCursor: null,
      revision: 12,
      replace: true,
      bodies: {
        'turn-2': makeTimelineTurn('turn-2', 'assistant', 'Old hydrated body', {
          sessionId: DURABLE_SESSION_ID,
          ordinal: 2,
          timestamp: '2026-03-10T10:01:00.000Z',
        }),
      },
    }))

    render(
      <Provider store={store}>
        <AgentChatView tabId="t1" paneId="p1" paneContent={RELOAD_PANE} />
      </Provider>,
    )

    expect(await screen.findByText('Old hydrated body')).toBeInTheDocument()
    expect(getAgentTimelinePage).not.toHaveBeenCalled()

    act(() => {
      store.dispatch(restoreRetryRequested({
        sessionId: 'sess-reload-1',
        code: 'RESTORE_STALE_REVISION',
      }))
    })

    await waitFor(() => {
      const attachCalls = wsSend.mock.calls.filter((call) => call[0]?.type === 'sdk.attach')
      expect(attachCalls).toHaveLength(2)
    })

    expect(screen.getByText('Restoring session...')).toBeInTheDocument()
    expect(screen.queryByText('Old hydrated body')).not.toBeInTheDocument()
    expect(getAgentTimelinePage).not.toHaveBeenCalled()
  })

  it('does not reattach or re-enter restoring when a later stale turn-body read fails after hydration succeeds', async () => {
    getAgentTurnBody.mockRejectedValueOnce({
      status: 409,
      message: 'Stale restore revision',
      details: {
        code: 'RESTORE_STALE_REVISION',
        currentRevision: 13,
      },
    })

    const store = makeStore()
    store.dispatch(sessionSnapshotReceived({
      sessionId: 'sess-reload-1',
      latestTurnId: 'turn-2',
      status: 'idle',
      timelineSessionId: DURABLE_SESSION_ID,
      revision: 12,
    }))

    render(
      <Provider store={store}>
        <AgentChatView tabId="t1" paneId="p1" paneContent={RELOAD_PANE} />
      </Provider>,
    )

    act(() => {
      store.dispatch(timelinePageReceived({
        sessionId: 'sess-reload-1',
        items: [
          makeTimelineItem('turn-2', 'user', 'Hydrated summary', {
            sessionId: DURABLE_SESSION_ID,
            ordinal: 2,
            timestamp: '2026-03-10T10:01:00.000Z',
          }),
        ],
        nextCursor: null,
        revision: 12,
        replace: true,
      }))
      store.dispatch(turnBodyReceived({
        sessionId: 'sess-reload-1',
        turn: makeTimelineTurn('turn-2', 'user', 'Hydrated body', {
          sessionId: DURABLE_SESSION_ID,
          ordinal: 2,
          timestamp: '2026-03-10T10:01:00.000Z',
        }),
      }))
    })

    expect(await screen.findByText('Hydrated body')).toBeInTheDocument()
    expect(screen.queryByText(/restoring/i)).not.toBeInTheDocument()
    expect(wsSend.mock.calls.filter((call) => call[0]?.type === 'sdk.attach')).toHaveLength(1)

    await act(async () => {
      await store.dispatch(loadAgentTurnBody({
        sessionId: 'sess-reload-1',
        timelineSessionId: DURABLE_SESSION_ID,
        turnId: 'turn-7',
      }))
    })

    expect(screen.getByText('Hydrated body')).toBeInTheDocument()
    expect(screen.queryByText(/restoring/i)).not.toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('Stale restore revision')
    expect(wsSend.mock.calls.filter((call) => call[0]?.type === 'sdk.attach')).toHaveLength(1)
  })

  it('defers restored timeline hydration while hidden and fetches exactly once when the pane becomes visible', async () => {
    getAgentTimelinePage.mockResolvedValue({
      sessionId: 'sess-reload-1',
      items: [],
      nextCursor: null,
      revision: 1,
    })
    const store = makeStore()
    store.dispatch(sessionSnapshotReceived({
      sessionId: 'sess-reload-1',
      latestTurnId: 'turn-2',
      status: 'idle',
      revision: 1,
    }))

    const { rerender } = render(
      <Provider store={store}>
        <AgentChatView tabId="t1" paneId="p1" paneContent={RELOAD_PANE} hidden />
      </Provider>,
    )

    await act(async () => {
      await Promise.resolve()
    })

    expect(getAgentTimelinePage).not.toHaveBeenCalled()
    expect(getAgentTurnBody).not.toHaveBeenCalled()
    expect(wsSend).toHaveBeenCalledWith({
      type: 'sdk.attach',
      sessionId: 'sess-reload-1',
    })

    rerender(
      <Provider store={store}>
        <AgentChatView tabId="t1" paneId="p1" paneContent={RELOAD_PANE} />
      </Provider>,
    )

    await waitFor(() => {
      expect(getAgentTimelinePage).toHaveBeenCalledTimes(1)
      expect(getAgentTimelinePage).toHaveBeenCalledWith(
        'sess-reload-1',
        expect.objectContaining({ priority: 'visible', includeBodies: true, revision: 1 }),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      )
    })
    expect(getAgentTurnBody).not.toHaveBeenCalled()
  })

  it('uses the persisted resumeSessionId for visible timeline hydration', async () => {
    const durableSessionId = '11111111-1111-1111-1111-111111111111'
    getAgentTimelinePage.mockResolvedValue({
      sessionId: durableSessionId,
      items: [],
      nextCursor: null,
      revision: 1,
    })

    const store = makeStore()
    store.dispatch(sessionSnapshotReceived({
      sessionId: 'sess-reload-1',
      latestTurnId: 'turn-2',
      status: 'idle',
      revision: 1,
    }))

    render(
      <Provider store={store}>
        <AgentChatView
          tabId="t1"
          paneId="p1"
          paneContent={{ ...RELOAD_PANE, resumeSessionId: durableSessionId }}
        />
      </Provider>,
    )

    await waitFor(() => {
      expect(getAgentTimelinePage).toHaveBeenCalledWith(
        durableSessionId,
        expect.objectContaining({ priority: 'visible', includeBodies: true, revision: 1 }),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      )
    })
  })

  it('uses timelineSessionId from sdk.session.snapshot for visible restore hydration', async () => {
    getAgentTimelinePage.mockResolvedValue({ sessionId: DURABLE_SESSION_ID, items: [], nextCursor: null, revision: 1 })

    const store = makeStore()
    store.dispatch(sessionSnapshotReceived({
      sessionId: 'sess-reload-1',
      latestTurnId: 'turn-2',
      status: 'idle',
      timelineSessionId: DURABLE_SESSION_ID,
      revision: 2,
    }))

    render(
      <Provider store={store}>
        <AgentChatView tabId="t1" paneId="p1" paneContent={{ ...RELOAD_PANE, sessionId: 'sess-reload-1' }} />
      </Provider>,
    )

    await waitFor(() => {
      expect(getAgentTimelinePage).toHaveBeenCalledWith(
        DURABLE_SESSION_ID,
        expect.objectContaining({ includeBodies: true, revision: 2 }),
        expect.anything(),
      )
    })
  })

  it('keeps the live-only restore fallback on the SDK session id until a durable timelineSessionId exists', async () => {
    getAgentTimelinePage.mockResolvedValue({ sessionId: 'sdk-sess-1', items: [], nextCursor: null, revision: 1 })

    const store = makeStore()
    store.dispatch(sessionSnapshotReceived({
      sessionId: 'sdk-sess-1',
      latestTurnId: 'turn-2',
      status: 'idle',
      revision: 1,
    }))

    render(
      <Provider store={store}>
        <AgentChatView tabId="t1" paneId="p1" paneContent={{ ...RELOAD_PANE, sessionId: 'sdk-sess-1' }} />
      </Provider>,
    )

    await waitFor(() => {
      expect(getAgentTimelinePage).toHaveBeenCalledWith(
        'sdk-sess-1',
        expect.objectContaining({ includeBodies: true, revision: 1 }),
        expect.anything(),
      )
    })
  })

  it('persists timelineSessionId into pane content and tab fallback metadata before sdk.session.init arrives', () => {
    const store = makeStoreWithTabs()
    const pane = {
      kind: 'agent-chat',
      provider: 'freshclaude',
      createRequestId: 'req-1',
      sessionId: 'sdk-sess-1',
      status: 'starting',
    } satisfies AgentChatPaneContent
    store.dispatch(addTab({
      id: 't1',
      title: 'FreshClaude Tab',
      mode: 'claude',
      codingCliProvider: 'claude',
      resumeSessionId: 'named-resume',
      sessionMetadataByKey: {
        'claude:named-resume': {
          sessionType: 'freshclaude',
          firstUserMessage: 'Continue from the old tab',
        },
      },
    }))
    store.dispatch(initLayout({ tabId: 't1', paneId: 'p1', content: pane }))

    render(
      <Provider store={store}>
        <AgentChatView tabId="t1" paneId="p1" paneContent={pane} />
      </Provider>,
    )

    act(() => {
      store.dispatch(sessionSnapshotReceived({
        sessionId: 'sdk-sess-1',
        latestTurnId: 'turn-2',
        status: 'idle',
        timelineSessionId: DURABLE_SESSION_ID_ALT,
        revision: 2,
      }))
    })

    expect(getPaneContent(store as unknown as ReturnType<typeof makeStore>, 't1', 'p1')?.sessionRef).toEqual({
      provider: 'claude',
      sessionId: DURABLE_SESSION_ID_ALT,
    })
    const tab = store.getState().tabs.tabs.find((entry) => entry.id === 't1')
    expect(tab?.resumeSessionId).toBeUndefined()
    expect(tab?.sessionRef).toEqual({
      provider: 'claude',
      sessionId: DURABLE_SESSION_ID_ALT,
    })
    expect(tab?.sessionMetadataByKey?.[`claude:${DURABLE_SESSION_ID_ALT}`]).toEqual(expect.objectContaining({
      sessionType: 'freshclaude',
      firstUserMessage: 'Continue from the old tab',
    }))
  })

  it('persists codingCliProvider into shell-tab fallback metadata when timelineSessionId becomes durable', () => {
    const store = makeStoreWithTabs()
    const pane = {
      kind: 'agent-chat',
      provider: 'freshclaude',
      createRequestId: 'req-shell',
      sessionId: 'sdk-shell-1',
      status: 'starting',
    } satisfies AgentChatPaneContent
    store.dispatch(addTab({
      id: 't-shell',
      title: 'Shell Host Tab',
      mode: 'shell',
      resumeSessionId: 'named-resume',
      sessionMetadataByKey: {
        'claude:named-resume': {
          sessionType: 'freshclaude',
          firstUserMessage: 'Continue from shell fallback',
        },
      },
    }))
    store.dispatch(initLayout({ tabId: 't-shell', paneId: 'p1', content: pane }))

    render(
      <Provider store={store}>
        <AgentChatView tabId="t-shell" paneId="p1" paneContent={pane} />
      </Provider>,
    )

    act(() => {
      store.dispatch(sessionSnapshotReceived({
        sessionId: 'sdk-shell-1',
        latestTurnId: 'turn-2',
        status: 'idle',
        timelineSessionId: DURABLE_SHELL_SESSION_ID,
        revision: 2,
      }))
    })

    expect(getPaneContent(store as unknown as ReturnType<typeof makeStore>, 't-shell', 'p1')?.sessionRef).toEqual({
      provider: 'claude',
      sessionId: DURABLE_SHELL_SESSION_ID,
    })
    const tab = store.getState().tabs.tabs.find((entry) => entry.id === 't-shell')
    expect(tab?.resumeSessionId).toBeUndefined()
    expect(tab?.sessionRef).toEqual({
      provider: 'claude',
      sessionId: DURABLE_SHELL_SESSION_ID,
    })
    expect(tab?.codingCliProvider).toBe('claude')
    expect(tab?.sessionMetadataByKey?.[`claude:${DURABLE_SHELL_SESSION_ID}`]).toEqual(expect.objectContaining({
      sessionType: 'freshclaude',
      firstUserMessage: 'Continue from shell fallback',
    }))
  })

  it('does not loop when two agent-chat panes in one split tab promote different durable ids', async () => {
    const firstDurableSessionId = '00000000-0000-4000-8000-000000000411'
    const secondDurableSessionId = '00000000-0000-4000-8000-000000000412'
    const staleSharedSessionId = '00000000-0000-4000-8000-000000000410'
    const store = makeStoreWithTabs()
    const dispatchSpy = vi.spyOn(store, 'dispatch')
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    store.dispatch(addTab({
      id: 't-split',
      title: 'Split Agent Chat Tab',
      mode: 'claude',
      codingCliProvider: 'claude',
      status: 'running',
      sessionRef: {
        provider: 'claude',
        sessionId: staleSharedSessionId,
      },
    }))
    store.dispatch(hydratePanes({
      layouts: {
        't-split': {
          type: 'split',
          id: 'split-root',
          direction: 'horizontal',
          sizes: [50, 50],
          children: [
            {
              type: 'leaf',
              id: 'p1',
              content: {
                kind: 'agent-chat',
                provider: 'freshclaude',
                createRequestId: 'req-split-1',
                sessionId: 'sdk-split-1',
                status: 'idle',
              },
            },
            {
              type: 'leaf',
              id: 'p2',
              content: {
                kind: 'agent-chat',
                provider: 'freshclaude',
                createRequestId: 'req-split-2',
                sessionId: 'sdk-split-2',
                status: 'idle',
              },
            },
          ],
        } as PaneNode,
      },
      activePane: { 't-split': 'p1' },
      paneTitles: {},
    }))

    function findPaneContentInState(state: ReturnType<typeof store.getState>, paneId: string): AgentChatPaneContent | undefined {
      const root = state.panes.layouts['t-split']
      if (!root) return undefined
      function visit(node: PaneNode): AgentChatPaneContent | undefined {
        if (node.type === 'leaf' && node.id === paneId && node.content.kind === 'agent-chat') {
          return node.content
        }
        if (node.type === 'split') {
          return visit(node.children[0]) || visit(node.children[1])
        }
        return undefined
      }
      return visit(root)
    }

    function Wrapper({ paneId }: { paneId: string }) {
      const content = useSelector((s: ReturnType<typeof store.getState>) => findPaneContentInState(s, paneId))
      if (!content) return null
      return <AgentChatView tabId="t-split" paneId={paneId} paneContent={content} />
    }

    render(
      <Provider store={store}>
        <Wrapper paneId="p1" />
        <Wrapper paneId="p2" />
      </Provider>,
    )

    dispatchSpy.mockClear()

    expect(() => {
      act(() => {
        store.dispatch(sessionSnapshotReceived({
          sessionId: 'sdk-split-1',
          latestTurnId: 'turn-1',
          status: 'idle',
          timelineSessionId: firstDurableSessionId,
          revision: 1,
        }))
        store.dispatch(sessionSnapshotReceived({
          sessionId: 'sdk-split-2',
          latestTurnId: 'turn-2',
          status: 'idle',
          timelineSessionId: secondDurableSessionId,
          revision: 1,
        }))
      })
    }).not.toThrow()

    await waitFor(() => {
      expect(getPaneContent(store as unknown as ReturnType<typeof makeStore>, 't-split', 'p1')?.sessionRef).toEqual({
        provider: 'claude',
        sessionId: firstDurableSessionId,
      })
      expect(getPaneContent(store as unknown as ReturnType<typeof makeStore>, 't-split', 'p2')?.sessionRef).toEqual({
        provider: 'claude',
        sessionId: secondDurableSessionId,
      })
    })

    const updateTabCalls = dispatchSpy.mock.calls.filter((call) => call[0]?.type === 'tabs/updateTab')
    const panePromotionCalls = updateTabCalls.filter((call) => {
      const sessionId = call[0]?.payload?.updates?.sessionRef?.sessionId
      return sessionId === firstDurableSessionId || sessionId === secondDurableSessionId
    })
    const tab = store.getState().tabs.tabs.find((entry) => entry.id === 't-split')
    expect(panePromotionCalls).toHaveLength(0)
    expect(tab?.sessionRef).toBeUndefined()

    consoleErrorSpy.mockRestore()
  })

  it('upgrades a named restore to the canonical durable id when sdk.session.metadata arrives after the snapshot', async () => {
    const canonicalSessionId = '00000000-0000-4000-8000-000000000321'
    getAgentTimelinePage
      .mockResolvedValueOnce({
        sessionId: 'sdk-meta-upgrade-1',
        items: [{
          turnId: 'turn-live-1',
          messageId: 'message-live-1',
          ordinal: 0,
          source: 'live',
          sessionId: 'sdk-meta-upgrade-1',
          role: 'assistant',
          summary: 'Live-only summary',
        }],
        bodies: {
          'turn-live-1': {
            turnId: 'turn-live-1',
            messageId: 'message-live-1',
            ordinal: 0,
            source: 'live',
            sessionId: 'sdk-meta-upgrade-1',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'Live-only full body' }],
            },
          },
        },
        nextCursor: null,
        revision: 1,
      })
      .mockResolvedValueOnce({
        sessionId: canonicalSessionId,
        items: [
          {
            turnId: 'turn-durable-1',
            messageId: 'message-durable-1',
            ordinal: 0,
            source: 'durable',
            sessionId: canonicalSessionId,
            role: 'user',
            summary: 'Durable backlog prompt',
          },
          {
            turnId: 'turn-durable-2',
            messageId: 'message-durable-2',
            ordinal: 1,
            source: 'durable',
            sessionId: canonicalSessionId,
            role: 'assistant',
            summary: 'Durable backlog answer',
          },
          {
            turnId: 'turn-live-2',
            messageId: 'message-live-2',
            ordinal: 2,
            source: 'live',
            sessionId: canonicalSessionId,
            role: 'assistant',
            summary: 'Post-watermark live delta',
          },
        ],
        bodies: {
          'turn-durable-1': {
            turnId: 'turn-durable-1',
            messageId: 'message-durable-1',
            ordinal: 0,
            source: 'durable',
            sessionId: canonicalSessionId,
            message: {
              role: 'user',
              content: [{ type: 'text', text: 'Durable backlog prompt body' }],
            },
          },
          'turn-durable-2': {
            turnId: 'turn-durable-2',
            messageId: 'message-durable-2',
            ordinal: 1,
            source: 'durable',
            sessionId: canonicalSessionId,
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'Durable backlog answer body' }],
            },
          },
          'turn-live-2': {
            turnId: 'turn-live-2',
            messageId: 'message-live-2',
            ordinal: 2,
            source: 'live',
            sessionId: canonicalSessionId,
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'Post-watermark live delta' }],
            },
          },
        },
        nextCursor: null,
        revision: 2,
      })

    const store = makeStoreWithTabs()
    const pane = {
      kind: 'agent-chat',
      provider: 'freshclaude',
      createRequestId: 'req-meta-upgrade',
      sessionId: 'sdk-meta-upgrade-1',
      status: 'idle',
      resumeSessionId: 'named-resume',
    } satisfies AgentChatPaneContent
    store.dispatch(addTab({
      id: 't-meta',
      title: 'Metadata Upgrade Tab',
      mode: 'claude',
      codingCliProvider: 'claude',
      resumeSessionId: 'named-resume',
      sessionMetadataByKey: {
        'claude:named-resume': {
          sessionType: 'freshclaude',
          firstUserMessage: 'Continue from metadata upgrade',
        },
      },
    }))
    store.dispatch(initLayout({ tabId: 't-meta', paneId: 'p1', content: pane }))

    render(
      <Provider store={store}>
        <AgentChatView tabId="t-meta" paneId="p1" paneContent={pane} />
      </Provider>,
    )

    act(() => {
      store.dispatch(sessionSnapshotReceived({
        sessionId: 'sdk-meta-upgrade-1',
        latestTurnId: 'turn-2',
        status: 'idle',
        revision: 1,
      }))
    })

    await waitFor(() => {
      expect(getAgentTimelinePage).toHaveBeenCalledWith(
        'sdk-meta-upgrade-1',
        expect.objectContaining({ includeBodies: true, revision: 1 }),
        expect.anything(),
      )
    })

    await waitFor(() => {
      const session = store.getState().agentChat.sessions['sdk-meta-upgrade-1']
      expect(session?.historyLoaded).toBe(true)
      expect(session?.timelineRevision).toBe(1)
      expect(screen.getByText('Live-only full body')).toBeInTheDocument()
    })

    act(() => {
      store.dispatch(addAssistantMessage({
        sessionId: 'sdk-meta-upgrade-1',
        content: [{ type: 'text', text: 'Post-watermark live delta' }],
      }))
    })
    expect(screen.getByText('Post-watermark live delta')).toBeInTheDocument()

    act(() => {
      store.dispatch(sessionMetadataReceived({
        sessionId: 'sdk-meta-upgrade-1',
        cliSessionId: canonicalSessionId,
      }))
    })

    await waitFor(() => {
      const attachCalls = wsSend.mock.calls.filter((call) => call[0]?.type === 'sdk.attach')
      expect(attachCalls).toHaveLength(2)
      expect(attachCalls[1]?.[0]).toEqual({
        type: 'sdk.attach',
        sessionId: 'sdk-meta-upgrade-1',
        resumeSessionId: canonicalSessionId,
      })
    })
    expect(getAgentTimelinePage).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('Live-only full body')).not.toBeInTheDocument()

    act(() => {
      store.dispatch(sessionSnapshotReceived({
        sessionId: 'sdk-meta-upgrade-1',
        latestTurnId: 'turn-live-2',
        status: 'idle',
        timelineSessionId: canonicalSessionId,
        revision: 2,
      }))
    })

    await waitFor(() => {
      expect(getAgentTimelinePage).toHaveBeenCalledTimes(2)
    })
    expect(getAgentTimelinePage).toHaveBeenNthCalledWith(
      2,
      canonicalSessionId,
      expect.objectContaining({ includeBodies: true, revision: 2 }),
      expect.anything(),
    )

    await waitFor(() => {
      const session = store.getState().agentChat.sessions['sdk-meta-upgrade-1']
      expect(session?.historyLoaded).toBe(true)
      expect(session?.timelineRevision).toBe(2)
      expect(screen.getByText('Durable backlog prompt body')).toBeInTheDocument()
      expect(screen.getByText('Durable backlog answer body')).toBeInTheDocument()
      expect(screen.getByText('Post-watermark live delta')).toBeInTheDocument()
    })
    expect(screen.queryByText('Live-only full body')).not.toBeInTheDocument()
    expect(screen.getAllByText('Post-watermark live delta')).toHaveLength(1)

    expect(getPaneContent(store as unknown as ReturnType<typeof makeStore>, 't-meta', 'p1')?.sessionRef).toEqual({
      provider: 'claude',
      sessionId: canonicalSessionId,
    })
    const tab = store.getState().tabs.tabs.find((entry) => entry.id === 't-meta')
    expect(tab?.resumeSessionId).toBeUndefined()
    expect(tab?.sessionRef).toEqual({
      provider: 'claude',
      sessionId: canonicalSessionId,
    })
    expect(tab?.sessionMetadataByKey?.['claude:00000000-0000-4000-8000-000000000321']).toEqual(expect.objectContaining({
      sessionType: 'freshclaude',
      firstUserMessage: 'Continue from metadata upgrade',
    }))
  })

  it('dispatches a targeted flush when a canonical durable id upgrades from named resume', async () => {
    const canonicalSessionId = '00000000-0000-4000-8000-000000000321'
    const store = makeStoreWithTabs()
    const dispatchSpy = vi.spyOn(store, 'dispatch')
    const pane = {
      kind: 'agent-chat',
      provider: 'freshclaude',
      createRequestId: 'req-flush',
      sessionId: 'sdk-flush-1',
      status: 'starting',
      resumeSessionId: 'named-resume',
    } satisfies AgentChatPaneContent
    store.dispatch(addTab({
      id: 't-flush',
      title: 'Flush Tab',
      mode: 'claude',
      codingCliProvider: 'claude',
      resumeSessionId: 'named-resume',
      sessionMetadataByKey: {
        'claude:named-resume': {
          sessionType: 'freshclaude',
        },
      },
    }))
    store.dispatch(initLayout({ tabId: 't-flush', paneId: 'p1', content: pane }))
    dispatchSpy.mockClear()

    render(
      <Provider store={store}>
        <AgentChatView tabId="t-flush" paneId="p1" paneContent={pane} />
      </Provider>,
    )

    act(() => {
      store.dispatch(sessionSnapshotReceived({
        sessionId: 'sdk-flush-1',
        latestTurnId: 'turn-live-4',
        status: 'running',
        timelineSessionId: canonicalSessionId,
        revision: 9,
      }))
    })

    await waitFor(() => {
      expect(dispatchSpy).toHaveBeenCalledWith(flushPersistedLayoutNow())
    })
  })

  it('shows a restored partial assistant stream after reconnect', () => {
    const store = makeStore()
    store.dispatch(sessionSnapshotReceived({
      sessionId: 'sdk-sess-1',
      latestTurnId: 'turn-2',
      status: 'running',
      timelineSessionId: DURABLE_SESSION_ID,
      streamingActive: true,
      streamingText: 'partial reply',
    }))

    render(
      <Provider store={store}>
        <AgentChatView tabId="t1" paneId="p1" paneContent={{ ...RELOAD_PANE, sessionId: 'sdk-sess-1' }} />
      </Provider>,
    )

    expect(screen.getByText('partial reply')).toBeInTheDocument()
  })

  it('keeps restored partial assistant stream visible when sdk.session.init arrives after a running snapshot', () => {
    const store = makeStore()
    store.dispatch(sessionCreated({ requestId: 'req-running', sessionId: 'sdk-sess-running' }))
    store.dispatch(sessionSnapshotReceived({
      sessionId: 'sdk-sess-running',
      latestTurnId: 'turn-2',
      status: 'running',
      timelineSessionId: DURABLE_RUNNING_SESSION_ID,
      streamingActive: true,
      streamingText: 'partial reply',
    }))

    render(
      <Provider store={store}>
        <AgentChatView tabId="t1" paneId="p1" paneContent={{ ...RELOAD_PANE, sessionId: 'sdk-sess-running' }} />
      </Provider>,
    )

    expect(screen.getByText('partial reply')).toBeInTheDocument()

    act(() => {
      store.dispatch(sessionInit({
        sessionId: 'sdk-sess-running',
        cliSessionId: DURABLE_RUNNING_SESSION_ID,
        model: 'claude-opus-4-6',
      }))
    })

    expect(screen.getByText('partial reply')).toBeInTheDocument()
    expect(screen.queryByLabelText('Claude is thinking')).not.toBeInTheDocument()
  })

  it('keeps restored partial assistant output visible after content_block_stop before the final assistant message arrives', () => {
    vi.useFakeTimers()
    const store = makeStore()
    store.dispatch(sessionCreated({ requestId: 'req-1', sessionId: 'sdk-sess-2' }))
    store.dispatch(addUserMessage({ sessionId: 'sdk-sess-2', text: 'continue' }))
    store.dispatch(sessionSnapshotReceived({
      sessionId: 'sdk-sess-2',
      latestTurnId: 'turn-3',
      status: 'running',
      timelineSessionId: DURABLE_SESSION_ID_NEXT,
      streamingActive: false,
      streamingText: 'partial reply',
    }))

    render(
      <Provider store={store}>
        <AgentChatView tabId="t1" paneId="p1" paneContent={{ ...RELOAD_PANE, sessionId: 'sdk-sess-2' }} />
      </Provider>,
    )

    act(() => { vi.advanceTimersByTime(250) })

    expect(screen.getByText('partial reply')).toBeInTheDocument()
    expect(screen.queryByLabelText('Claude is thinking')).not.toBeInTheDocument()

    vi.useRealTimers()
  })

  it('waits for the durable Claude id before hydrating a named-resume session whose pre-init snapshot is empty', async () => {
    const store = makeStore()
    store.dispatch(registerPendingCreate({
      requestId: 'req-empty',
      expectsHistoryHydration: true,
    }))
    store.dispatch(sessionCreated({
      requestId: 'req-empty',
      sessionId: 'sdk-empty',
    }))
    store.dispatch(sessionSnapshotReceived({
      sessionId: 'sdk-empty',
      latestTurnId: null,
      status: 'starting',
      timelineSessionId: 'named-resume',
      revision: 0,
    }))
    getAgentTimelinePage.mockResolvedValue({
      sessionId: '00000000-0000-4000-8000-000000000555',
      items: [],
      nextCursor: null,
      revision: 0,
    })

    render(
      <Provider store={store}>
        <AgentChatView
          tabId="t1"
          paneId="p1"
          paneContent={{
            kind: 'agent-chat',
            provider: 'freshclaude',
            createRequestId: 'req-empty',
            sessionId: 'sdk-empty',
            status: 'starting',
            resumeSessionId: 'named-resume',
          }}
        />
      </Provider>,
    )

    await act(async () => {
      await Promise.resolve()
    })

    expect(getAgentTimelinePage).not.toHaveBeenCalled()
    expect(screen.getByText(/restoring/i)).toBeInTheDocument()

    act(() => {
      store.dispatch(sessionInit({
        sessionId: 'sdk-empty',
        cliSessionId: '00000000-0000-4000-8000-000000000555',
      }))
    })

    await waitFor(() => {
      expect(getAgentTimelinePage).toHaveBeenCalledWith(
        '00000000-0000-4000-8000-000000000555',
        expect.objectContaining({ priority: 'visible', includeBodies: true, revision: 0 }),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      )
    })
    expect(getAgentTimelinePage).not.toHaveBeenCalledWith(
      'sdk-empty',
      expect.anything(),
      expect.anything(),
    )
  })

  it('stays in restoring state when sdk.status arrives before the first timeline window (race condition)', () => {
    const store = makeStore()
    store.dispatch(setSessionStatus({ sessionId: 'sess-reload-1', status: 'idle' }))

    const { rerender } = render(
      <Provider store={store}>
        <AgentChatView tabId="t1" paneId="p1" paneContent={RELOAD_PANE} />
      </Provider>,
    )

    // Session exists in Redux but historyLoaded is not set — should still show restoring
    expect(screen.getByText(/restoring/i)).toBeInTheDocument()
    expect(screen.queryByText('Freshclaude')).not.toBeInTheDocument()

    store.dispatch(timelinePageReceived({
      sessionId: 'sess-reload-1',
      items: [
        makeTimelineItem('turn-1', 'user', 'Hello', {
          sessionId: 'sess-reload-1',
          ordinal: 1,
          timestamp: '2026-01-01T00:00:00Z',
        }),
      ],
      nextCursor: null,
      revision: 1,
      replace: true,
    }))
    store.dispatch(turnBodyReceived({
      sessionId: 'sess-reload-1',
      turn: makeTimelineTurn('turn-1', 'user', 'Hello', {
        sessionId: 'sess-reload-1',
        ordinal: 1,
        timestamp: '2026-01-01T00:00:00Z',
      }),
    }))

    rerender(
      <Provider store={store}>
        <AgentChatView tabId="t1" paneId="p1" paneContent={RELOAD_PANE} />
      </Provider>,
    )

    // Now restoring should be done, messages visible
    expect(screen.queryByText(/restoring/i)).not.toBeInTheDocument()
    expect(screen.getByText('Hello')).toBeInTheDocument()
  })

  it('reactively updates when timeline hydration lands (no manual rerender)', async () => {
    const store = makeStore()
    render(
      <Provider store={store}>
        <AgentChatView tabId="t1" paneId="p1" paneContent={RELOAD_PANE} />
      </Provider>,
    )

    // Initially shows restoring
    expect(screen.getByText(/restoring/i)).toBeInTheDocument()

    act(() => {
      store.dispatch(timelinePageReceived({
        sessionId: 'sess-reload-1',
        items: [
          makeTimelineItem('turn-1', 'user', 'Reactive test message', {
            sessionId: 'sess-reload-1',
            ordinal: 1,
            timestamp: '2026-01-01T00:00:00Z',
          }),
        ],
        nextCursor: null,
        revision: 1,
        replace: true,
      }))
      store.dispatch(turnBodyReceived({
        sessionId: 'sess-reload-1',
        turn: makeTimelineTurn('turn-1', 'user', 'Reactive test message', {
          sessionId: 'sess-reload-1',
          ordinal: 1,
          timestamp: '2026-01-01T00:00:00Z',
        }),
      }))
    })

    expect(screen.queryByText(/restoring/i)).not.toBeInTheDocument()
    expect(screen.getByText('Reactive test message')).toBeInTheDocument()
  })

  it('reactively updates when timeline hydration + sdk.status arrive back-to-back', () => {
    const store = makeStore()
    render(
      <Provider store={store}>
        <AgentChatView tabId="t1" paneId="p1" paneContent={RELOAD_PANE} />
      </Provider>,
    )

    // Initially shows restoring
    expect(screen.getByText(/restoring/i)).toBeInTheDocument()

    act(() => {
      store.dispatch(timelinePageReceived({
        sessionId: 'sess-reload-1',
        items: [
          makeTimelineItem('turn-1', 'user', 'Back-to-back test', {
            sessionId: 'sess-reload-1',
            ordinal: 1,
            timestamp: '2026-01-01T00:00:00Z',
          }),
        ],
        nextCursor: null,
        revision: 1,
        replace: true,
      }))
      store.dispatch(turnBodyReceived({
        sessionId: 'sess-reload-1',
        turn: makeTimelineTurn('turn-1', 'user', 'Back-to-back test', {
          sessionId: 'sess-reload-1',
          ordinal: 1,
          timestamp: '2026-01-01T00:00:00Z',
        }),
      }))
      store.dispatch(setSessionStatus({
        sessionId: 'sess-reload-1',
        status: 'idle',
      }))
    })

    // Messages should be visible — both dispatches should be processed
    expect(screen.queryByText(/restoring/i)).not.toBeInTheDocument()
    expect(screen.getByText('Back-to-back test')).toBeInTheDocument()
  })

  it('reactively updates when timeline hydration and sdk.status arrive in separate event loop ticks', () => {
    const store = makeStore()
    render(
      <Provider store={store}>
        <AgentChatView tabId="t1" paneId="p1" paneContent={RELOAD_PANE} />
      </Provider>,
    )

    // Initially shows restoring
    expect(screen.getByText(/restoring/i)).toBeInTheDocument()

    act(() => {
      store.dispatch(timelinePageReceived({
        sessionId: 'sess-reload-1',
        items: [
          makeTimelineItem('turn-1', 'user', 'Separate tick test', {
            sessionId: 'sess-reload-1',
            ordinal: 1,
            timestamp: '2026-01-01T00:00:00Z',
          }),
        ],
        nextCursor: null,
        revision: 1,
        replace: true,
      }))
      store.dispatch(turnBodyReceived({
        sessionId: 'sess-reload-1',
        turn: makeTimelineTurn('turn-1', 'user', 'Separate tick test', {
          sessionId: 'sess-reload-1',
          ordinal: 1,
          timestamp: '2026-01-01T00:00:00Z',
        }),
      }))
    })

    expect(screen.queryByText(/restoring/i)).not.toBeInTheDocument()
    expect(screen.getByText('Separate tick test')).toBeInTheDocument()

    act(() => {
      store.dispatch(setSessionStatus({
        sessionId: 'sess-reload-1',
        status: 'idle',
      }))
    })

    expect(screen.getByText('Separate tick test')).toBeInTheDocument()
  })

  it('keeps the restore UI visible instead of falling back to welcome when restore is slow', () => {
    vi.useFakeTimers()
    const store = makeStore()
    render(
      <Provider store={store}>
        <AgentChatView tabId="t1" paneId="p1" paneContent={RELOAD_PANE} />
      </Provider>,
    )

    // Initially shows restoring
    expect(screen.getByText(/restoring/i)).toBeInTheDocument()
    expect(screen.queryByText('Freshclaude')).not.toBeInTheDocument()

    // Advance past the legacy 5-second timeout window.
    act(() => { vi.advanceTimersByTime(5_000) })

    expect(screen.getByText(/restoring/i)).toBeInTheDocument()
    expect(screen.queryByText('Freshclaude')).not.toBeInTheDocument()

    vi.useRealTimers()
  })
})

/** Read pane content from the store for a given tab/pane ID. */
function getPaneContent(store: ReturnType<typeof makeStore>, tabId: string, paneId: string): AgentChatPaneContent | undefined {
  const root = store.getState().panes.layouts[tabId]
  if (!root) return undefined
  function find(node: PaneNode): AgentChatPaneContent | undefined {
    if (node.type === 'leaf' && node.id === paneId && node.content.kind === 'agent-chat') {
      return node.content
    }
    if (node.type === 'split') {
      return find(node.children[0]) || find(node.children[1])
    }
    return undefined
  }
  return find(root)
}

describe('AgentChatView server-restart recovery', () => {
  afterEach(() => {
    cleanup()
    wsSend.mockClear()
    vi.useRealTimers()
  })

  it('persists cliSessionId as resumeSessionId in pane content when sessionInit arrives', () => {
    const store = makeStore()
    const pane: AgentChatPaneContent = {
      kind: 'agent-chat', provider: 'freshclaude',
      createRequestId: 'req-1',
      sessionId: 'sdk-sess-1',
      status: 'starting',
    }

    // Initialize the pane layout so updatePaneContent can find it
    store.dispatch(initLayout({ tabId: 't1', content: pane, paneId: 'p1' }))

    render(
      <Provider store={store}>
        <AgentChatView tabId="t1" paneId="p1" paneContent={pane} />
      </Provider>,
    )

    // Simulate sdk.session.init arriving with the Claude Code CLI session ID
    act(() => {
      store.dispatch(sessionCreated({ requestId: 'req-1', sessionId: 'sdk-sess-1' }))
      store.dispatch(sessionInit({
        sessionId: 'sdk-sess-1',
        cliSessionId: DURABLE_SESSION_ID_ALT,
        model: 'claude-opus-4-6',
      }))
    })

    // Pane content should now have canonical sessionRef persisted
    const content = getPaneContent(store, 't1', 'p1')
    expect(content?.sessionRef).toEqual({
      provider: 'claude',
      sessionId: DURABLE_SESSION_ID_ALT,
    })
  })

  it('does not reset the pane or send sdk.create when restore remains pending past the legacy timeout window', () => {
    vi.useFakeTimers()
    const store = makeStore()
    const pane: AgentChatPaneContent = {
      kind: 'agent-chat', provider: 'freshclaude',
      createRequestId: 'req-stale',
      sessionId: 'dead-session-id',
      status: 'idle',
      resumeSessionId: 'cli-session-to-resume',
    }

    // Initialize pane layout
    store.dispatch(initLayout({ tabId: 't1', content: pane, paneId: 'p1' }))

    render(
      <Provider store={store}>
        <AgentChatView tabId="t1" paneId="p1" paneContent={pane} />
      </Provider>,
    )

    // Initially shows restoring
    expect(screen.getByText(/restoring/i)).toBeInTheDocument()

    wsSend.mockClear()

    // Advance past the legacy 5-second timeout window.
    act(() => { vi.advanceTimersByTime(5_000) })

    const content = getPaneContent(store, 't1', 'p1')
    expect(content).toBeDefined()
    expect(content!.sessionId).toBe('dead-session-id')
    expect(content!.status).toBe('idle')
    expect(content!.createRequestId).toBe('req-stale')
    expect(content!.resumeSessionId).toBe('cli-session-to-resume')
    const createCalls = wsSend.mock.calls.filter(
      (c: any[]) => c[0]?.type === 'sdk.create',
    )
    expect(createCalls).toHaveLength(0)
    expect(screen.getByText(/restoring/i)).toBeInTheDocument()
    expect(screen.queryByText('Freshclaude')).not.toBeInTheDocument()
  })

  it('surfaces a visible stale restore failure after the second stale response without resetting the pane', async () => {
    const makeStaleRevisionError = (currentRevision: number) => ({
      status: 409,
      message: 'Stale restore revision',
      details: {
        code: 'RESTORE_STALE_REVISION',
        currentRevision,
      },
    })
    getAgentTimelinePage
      .mockRejectedValueOnce(makeStaleRevisionError(13))
      .mockRejectedValueOnce(makeStaleRevisionError(14))

    const store = makeStore()
    const pane: AgentChatPaneContent = {
      kind: 'agent-chat',
      provider: 'freshclaude',
      createRequestId: 'req-stale',
      sessionId: 'sdk-stale-1',
      status: 'idle',
      resumeSessionId: '00000000-0000-4000-8000-000000000888',
    }

    store.dispatch(initLayout({ tabId: 't1', content: pane, paneId: 'p1' }))

    function Wrapper() {
      const root = useSelector((s: ReturnType<typeof store.getState>) => s.panes.layouts.t1)
      const content = root?.type === 'leaf' && root.content.kind === 'agent-chat'
        ? root.content
        : undefined
      if (!content) return null
      return <AgentChatView tabId="t1" paneId="p1" paneContent={content} />
    }

    render(
      <Provider store={store}>
        <Wrapper />
      </Provider>,
    )

    act(() => {
      store.dispatch(sessionSnapshotReceived({
        sessionId: 'sdk-stale-1',
        latestTurnId: 'turn-2',
        status: 'idle',
        timelineSessionId: '00000000-0000-4000-8000-000000000888',
        revision: 12,
      }))
    })

    await waitFor(() => {
      const attachCalls = wsSend.mock.calls.filter((call) => call[0]?.type === 'sdk.attach')
      expect(attachCalls).toHaveLength(2)
    })

    act(() => {
      store.dispatch(sessionSnapshotReceived({
        sessionId: 'sdk-stale-1',
        latestTurnId: 'turn-2',
        status: 'idle',
        timelineSessionId: '00000000-0000-4000-8000-000000000888',
        revision: 13,
      }))
    })

    expect(await screen.findByText('Session restore failed')).toBeInTheDocument()
    expect(screen.getByText('Stale restore revision')).toBeInTheDocument()
    expect(screen.queryByText('Restoring session...')).not.toBeInTheDocument()
    expect(screen.queryByText('Freshclaude')).not.toBeInTheDocument()

    const content = getPaneContent(store, 't1', 'p1')
    expect(content).toBeDefined()
    expect(content!.sessionId).toBe('sdk-stale-1')
    expect(content!.status).toBe('idle')

    const createCalls = wsSend.mock.calls.filter((call) => call[0]?.type === 'sdk.create')
    expect(createCalls).toHaveLength(0)
  })

  it('surfaces attach-time restore failures as a terminal restore state instead of staying in restore mode', async () => {
    const store = makeStore()
    const pane: AgentChatPaneContent = {
      kind: 'agent-chat',
      provider: 'freshclaude',
      createRequestId: 'req-attach-failure',
      sessionId: 'sdk-missing-history',
      status: 'idle',
      resumeSessionId: 'named-resume',
    }

    store.dispatch(initLayout({ tabId: 't1', content: pane, paneId: 'p1' }))

    function Wrapper() {
      const root = useSelector((s: ReturnType<typeof store.getState>) => s.panes.layouts.t1)
      const content = root?.type === 'leaf' && root.content.kind === 'agent-chat'
        ? root.content
        : undefined
      if (!content) return null
      return <AgentChatView tabId="t1" paneId="p1" paneContent={content} />
    }

    render(
      <Provider store={store}>
        <Wrapper />
      </Provider>,
    )

    expect(screen.getByText('Restoring session...')).toBeInTheDocument()

    act(() => {
      handleSdkMessage(store.dispatch, {
        type: 'sdk.error',
        sessionId: 'sdk-missing-history',
        code: 'RESTORE_NOT_FOUND',
        message: 'SDK session history not found',
      })
    })

    expect(await screen.findByText('Session restore failed')).toBeInTheDocument()
    expect(screen.getByText('SDK session history not found')).toBeInTheDocument()
    expect(screen.queryByText('Restoring session...')).not.toBeInTheDocument()
    expect(screen.queryByText('Freshclaude')).not.toBeInTheDocument()
  })

  it('restarts hydration when a newer snapshot revision arrives with the same latestTurnId', async () => {
    getAgentTimelinePage
      .mockResolvedValueOnce({
        sessionId: '00000000-0000-4000-8000-000000000654',
        items: [
          makeTimelineItem('turn-2', 'assistant', 'Revision 12 summary', {
            sessionId: '00000000-0000-4000-8000-000000000654',
            ordinal: 0,
            source: 'durable',
          }),
        ],
        bodies: {
          'turn-2': makeTimelineTurn('turn-2', 'assistant', 'Revision 12 body', {
            sessionId: '00000000-0000-4000-8000-000000000654',
            ordinal: 0,
            source: 'durable',
          }),
        },
        nextCursor: null,
        revision: 12,
      })
      .mockResolvedValueOnce({
        sessionId: '00000000-0000-4000-8000-000000000654',
        items: [
          makeTimelineItem('turn-2', 'assistant', 'Revision 13 summary', {
            sessionId: '00000000-0000-4000-8000-000000000654',
            ordinal: 0,
            source: 'durable',
          }),
        ],
        bodies: {
          'turn-2': makeTimelineTurn('turn-2', 'assistant', 'Revision 13 body', {
            sessionId: '00000000-0000-4000-8000-000000000654',
            ordinal: 0,
            source: 'durable',
          }),
        },
        nextCursor: null,
        revision: 13,
      })

    const store = makeStore()
    const pane: AgentChatPaneContent = {
      kind: 'agent-chat',
      provider: 'freshclaude',
      createRequestId: 'req-revision-refresh',
      sessionId: 'sdk-revision-refresh-1',
      status: 'idle',
      resumeSessionId: '00000000-0000-4000-8000-000000000654',
    }

    render(
      <Provider store={store}>
        <AgentChatView tabId="t1" paneId="p1" paneContent={pane} />
      </Provider>,
    )

    act(() => {
      store.dispatch(sessionSnapshotReceived({
        sessionId: 'sdk-revision-refresh-1',
        latestTurnId: 'turn-2',
        status: 'idle',
        timelineSessionId: '00000000-0000-4000-8000-000000000654',
        revision: 12,
      }))
    })

    await waitFor(() => {
      expect(getAgentTimelinePage).toHaveBeenCalled()
    })
    expect(getAgentTimelinePage).toHaveBeenLastCalledWith(
      '00000000-0000-4000-8000-000000000654',
      expect.objectContaining({ includeBodies: true, revision: 12 }),
      expect.anything(),
    )
    expect(await screen.findByText('Revision 12 body')).toBeInTheDocument()
    const initialCallCount = getAgentTimelinePage.mock.calls.length

    act(() => {
      store.dispatch(sessionSnapshotReceived({
        sessionId: 'sdk-revision-refresh-1',
        latestTurnId: 'turn-2',
        status: 'idle',
        timelineSessionId: '00000000-0000-4000-8000-000000000654',
        revision: 13,
      }))
    })

    await waitFor(() => {
      expect(getAgentTimelinePage.mock.calls.length).toBeGreaterThan(initialCallCount)
    })
    expect(getAgentTimelinePage).toHaveBeenLastCalledWith(
      '00000000-0000-4000-8000-000000000654',
      expect.objectContaining({ includeBodies: true, revision: 13 }),
      expect.anything(),
    )
    expect(await screen.findByText('Revision 13 body')).toBeInTheDocument()
    expect(screen.queryByText('Revision 12 body')).not.toBeInTheDocument()

    const session = store.getState().agentChat.sessions['sdk-revision-refresh-1']
    expect(session?.historyLoaded).toBe(true)
    expect(session?.timelineRevision).toBe(13)
  })
})
