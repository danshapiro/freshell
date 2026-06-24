import { useEffect } from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, waitFor, act } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { useAppDispatch } from '@/store/hooks'
import { useTurnCompletionNotifications } from '@/hooks/useTurnCompletionNotifications'
import tabsReducer from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import connectionReducer from '@/store/connectionSlice'
import turnCompletionReducer from '@/store/turnCompletionSlice'
import freshAgentReducer, { setSessionStatus } from '@/store/freshAgentSlice'
import { handleFreshAgentMessage } from '@/lib/fresh-agent-ws'
import type { PaneNode } from '@/store/paneTypes'
import type { Tab } from '@/store/types'

const playSound = vi.hoisted(() => vi.fn())

const wsMocks = vi.hoisted(() => {
  const messageHandlers = new Set<(msg: any) => void>()
  return {
    onMessage: vi.fn((cb: (msg: any) => void) => {
      messageHandlers.add(cb)
      return () => messageHandlers.delete(cb)
    }),
    resetHandlers: () => messageHandlers.clear(),
    emitMessage: (msg: any) => {
      for (const cb of messageHandlers) cb(msg)
    },
  }
})

vi.mock('@/hooks/useNotificationSound', () => ({
  useNotificationSound: () => ({ play: playSound }),
}))

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    send: vi.fn(),
    connect: vi.fn().mockResolvedValue(undefined),
    onMessage: wsMocks.onMessage,
    onReconnect: vi.fn(() => () => {}),
  }),
}))

const SESSION_ID = 'ses_real_1'

const CLAUDE_SESSION_ID = 'claude-runtime-ses-1'
const CLAUDE_TAB = 'tab-3'
const CLAUDE_PANE = 'pane-3'

function turnComplete(at: number) {
  wsMocks.emitMessage({
    type: 'freshAgent.event',
    sessionId: SESSION_ID,
    sessionType: 'freshopencode',
    provider: 'opencode',
    event: { type: 'freshAgent.turn.complete', sessionId: SESSION_ID, at },
  })
}

function turnWaiting(at: number) {
  wsMocks.emitMessage({
    type: 'freshAgent.event',
    sessionId: CLAUDE_SESSION_ID,
    sessionType: 'freshclaude',
    provider: 'claude',
    event: { type: 'freshAgent.turn.waiting', sessionId: CLAUDE_SESSION_ID, at },
  })
}

function Harness() {
  const dispatch = useAppDispatch()
  useTurnCompletionNotifications()
  useEffect(() => {
    return wsMocks.onMessage((msg: any) => {
      if (typeof msg?.type === 'string' && msg.type.startsWith('freshAgent')) {
        handleFreshAgentMessage(dispatch, msg)
      }
    })
  }, [dispatch])
  return null
}

function createStore() {
  const foregroundTab: Tab = {
    id: 'tab-1', createRequestId: 'req-1', title: 'Foreground', status: 'running',
    mode: 'shell', shell: 'system', terminalId: 'term-1', createdAt: 1,
  }
  const agentTab: Tab = {
    id: 'tab-2', createRequestId: 'req-2', title: 'Agent', status: 'running',
    mode: 'shell', shell: 'system', createdAt: 1,
  }
  const claudeTab: Tab = {
    id: CLAUDE_TAB, createRequestId: 'req-3', title: 'Claude', status: 'running',
    mode: 'shell', shell: 'system', createdAt: 1,
  }
  const agentLeaf: PaneNode = {
    type: 'leaf',
    id: 'pane-2',
    content: {
      kind: 'fresh-agent',
      createRequestId: 'req-2',
      sessionType: 'freshopencode',
      provider: 'opencode',
      sessionId: SESSION_ID,
      sessionRef: { provider: 'opencode', sessionId: SESSION_ID },
    } as never,
  }
  const claudeLeaf: PaneNode = {
    type: 'leaf',
    id: CLAUDE_PANE,
    content: {
      kind: 'fresh-agent',
      createRequestId: 'req-3',
      sessionType: 'freshclaude',
      provider: 'claude',
      sessionId: CLAUDE_SESSION_ID,
      sessionRef: { provider: 'claude', sessionId: CLAUDE_SESSION_ID },
    } as never,
  }
  const layouts: Record<string, PaneNode> = {
    'tab-1': { type: 'leaf', id: 'pane-1', content: { kind: 'terminal', createRequestId: 'req-1', status: 'running', mode: 'shell', shell: 'system', terminalId: 'term-1', initialCwd: '/tmp' } as never },
    'tab-2': agentLeaf,
    [CLAUDE_TAB]: claudeLeaf,
  }
  return configureStore({
    reducer: {
      tabs: tabsReducer,
      panes: panesReducer,
      settings: settingsReducer,
      connection: connectionReducer,
      turnCompletion: turnCompletionReducer,
      freshAgent: freshAgentReducer,
    },
    preloadedState: {
      tabs: { tabs: [foregroundTab, agentTab, claudeTab], activeTabId: 'tab-1', renameRequestTabId: null },
      panes: { layouts, activePane: { 'tab-1': 'pane-1', 'tab-2': 'pane-2', [CLAUDE_TAB]: CLAUDE_PANE }, paneTitles: {} },
      settings: { settings: { ...defaultSettings }, loaded: true },
      connection: { status: 'ready' as const, error: null },
      turnCompletion: { seq: 0, lastAtByTerminalId: {}, pendingEvents: [], attentionByTab: {}, attentionByPane: {} },
    },
  })
}

describe('fresh-agent server-authoritative turn completion (e2e notification flow)', () => {
  const originalHidden = Object.getOwnPropertyDescriptor(document, 'hidden')
  const originalHasFocus = Object.getOwnPropertyDescriptor(document, 'hasFocus')

  beforeEach(() => {
    playSound.mockClear()
    wsMocks.resetHandlers()
    // Window focused, but the agent tab (tab-2) is in the background, so a completion
    // there should both chime and highlight.
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true })
  })

  afterEach(() => {
    cleanup()
    if (originalHidden) Object.defineProperty(document, 'hidden', originalHidden)
    if (originalHasFocus) Object.defineProperty(document, 'hasFocus', originalHasFocus)
  })

  it('chimes once and highlights the agent tab on a server-pushed completion, and ignores replays', async () => {
    const store = createStore()
    store.dispatch(setSessionStatus({ sessionId: SESSION_ID, sessionType: 'freshopencode', provider: 'opencode', status: 'idle' }))

    render(<Provider store={store}><Harness /></Provider>)
    await waitFor(() => expect(wsMocks.onMessage).toHaveBeenCalled())

    act(() => { turnComplete(1000) })

    await waitFor(() => expect(playSound).toHaveBeenCalledTimes(1))
    expect(store.getState().turnCompletion.attentionByTab['tab-2']).toBe(true)
    expect(store.getState().turnCompletion.attentionByPane['pane-2']).toBe(true)

    // A replayed/stale completion (reconnect, same or older timestamp) must not re-chime.
    act(() => { turnComplete(1000) })
    act(() => { turnComplete(500) })
    expect(playSound).toHaveBeenCalledTimes(1)

    // The next real turn (strictly newer) chimes again.
    act(() => { turnComplete(2000) })
    await waitFor(() => expect(playSound).toHaveBeenCalledTimes(2))
  })

  it('greens + chimes exactly once when the server pushes freshAgent.turn.waiting', async () => {
    const store = createStore()

    render(<Provider store={store}><Harness /></Provider>)
    await waitFor(() => expect(wsMocks.onMessage).toHaveBeenCalled())

    act(() => { turnWaiting(1000) })

    await waitFor(() => {
      expect(store.getState().turnCompletion.attentionByPane[CLAUDE_PANE]).toBe(true)
      expect(store.getState().turnCompletion.attentionByTab[CLAUDE_TAB]).toBe(true)
    })
    expect(playSound).toHaveBeenCalledTimes(1)

    // A replayed/same-at waiting edge must NOT re-chime (at-monotonic #waiting dedupe).
    act(() => { turnWaiting(1000) })
    expect(playSound).toHaveBeenCalledTimes(1)
  })
})
