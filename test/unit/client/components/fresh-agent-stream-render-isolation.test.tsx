import { Profiler, type ProfilerOnRenderCallback, type ReactNode } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { appReducers } from '@/store/appReducers'
import { initLayout } from '@/store/panesSlice'
import { addTab } from '@/store/tabsSlice'
import { sessionInit, setSessionStatus } from '@/store/freshAgentSlice'
import { handleFreshAgentMessage } from '@/lib/fresh-agent-ws'
import TabBar from '@/components/TabBar'
import Sidebar from '@/components/Sidebar'
import PaneContainer from '@/components/panes/PaneContainer'
import { MobileTabStrip } from '@/components/MobileTabStrip'
import { TabSwitcher } from '@/components/TabSwitcher'
import { ContextMenuProvider } from '@/components/context-menu/ContextMenuProvider'

// Transcript-live plan D2 (acceptance 10): a streamed token reaches only the
// pane that renders it. The app-wide chrome (tab bar, pane container, sidebar,
// mobile strip, tab switcher, context-menu provider) must not commit once per
// token. Each is rendered against the app's real reducer map and fed real
// `freshAgent.stream` frames through the real websocket handler.

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    send: vi.fn(),
    close: vi.fn(),
    connect: vi.fn().mockResolvedValue(undefined),
    onMessage: vi.fn(() => () => {}),
    onReconnect: vi.fn(() => () => {}),
  }),
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    api: {
      get: vi.fn().mockRejectedValue(new Error('no server in tests')),
      post: vi.fn().mockRejectedValue(new Error('no server in tests')),
      patch: vi.fn().mockRejectedValue(new Error('no server in tests')),
      put: vi.fn().mockRejectedValue(new Error('no server in tests')),
      delete: vi.fn().mockRejectedValue(new Error('no server in tests')),
    },
    searchSessions: vi.fn().mockResolvedValue({ results: [] }),
    getTerminalDirectoryPage: vi.fn().mockResolvedValue({ items: [], nextCursor: null, revision: 1 }),
    updateManagedRuntimeViewVisibility: vi.fn().mockResolvedValue(undefined),
  }
})

// The pane's own view is the one surface that should follow the stream; it
// is measured by its own test. Stubbing it here leaves every commit inside
// the PaneContainer profiler attributable to the container and its chrome.
vi.mock('@/components/fresh-agent/FreshAgentView', () => ({
  default: () => <div data-testid="fresh-agent-view-stub" />,
}))

const SESSION_ID = 'claude-render-isolation-1'
const locator = { sessionId: SESSION_ID, sessionType: 'freshclaude' as const, provider: 'claude' as const }

function createAppStore() {
  const store = configureStore({
    reducer: appReducers,
    middleware: (getDefault) => getDefault({
      serializableCheck: false,
      immutableCheck: false,
    }),
  })
  store.dispatch(addTab({ id: 'tab-1', title: 'Claude', mode: 'shell' }))
  store.dispatch(initLayout({
    tabId: 'tab-1',
    paneId: 'pane-1',
    content: {
      kind: 'fresh-agent',
      sessionType: 'freshclaude',
      provider: 'claude',
      sessionId: SESSION_ID,
      createRequestId: 'req-render-isolation',
      status: 'running',
    },
  }))
  store.dispatch(sessionInit({ ...locator, cliSessionId: SESSION_ID, model: 'claude-sonnet-4-6' }))
  store.dispatch(setSessionStatus({ ...locator, status: 'running' }))
  return store
}

function streamFrame(event: Record<string, unknown>) {
  return {
    type: 'freshAgent.event',
    ...locator,
    event: {
      type: 'freshAgent.stream',
      sessionId: SESSION_ID,
      messageId: 'msg_render_isolation',
      parentToolUseId: null,
      event,
    },
  }
}

async function settle(ms: number) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms))
  })
}

describe('stream deltas and app-wide chrome (transcript-live D2)', () => {
  afterEach(() => {
    cleanup()
  })

  it('commits none of the app-wide components across a burst of 200 text deltas', async () => {
    const store = createAppStore()
    const commits: Record<string, number> = {}
    const onRender: ProfilerOnRenderCallback = (id) => {
      commits[id] = (commits[id] ?? 0) + 1
    }
    const measured = (id: string, node: ReactNode) => (
      <Profiler id={id} onRender={onRender}>{node}</Profiler>
    )
    const layout = store.getState().panes.layouts['tab-1']
    expect(layout).toBeDefined()

    render(
      <Provider store={store}>
        {measured('ContextMenuProvider', (
          <ContextMenuProvider view="terminal" onViewChange={() => {}} onToggleSidebar={() => {}} sidebarCollapsed={false}>
            <div />
          </ContextMenuProvider>
        ))}
        {measured('TabBar', <TabBar />)}
        {measured('MobileTabStrip', <MobileTabStrip onOpenSwitcher={() => {}} />)}
        {measured('TabSwitcher', <TabSwitcher onClose={() => {}} />)}
        {measured('Sidebar', <Sidebar view="terminal" onNavigate={() => {}} />)}
        {measured('PaneContainer', <PaneContainer tabId="tab-1" node={layout!} />)}
      </Provider>,
    )
    // Let mount-time effects and their follow-up commits finish.
    await settle(50)

    // The turn's first block opens the stream: one write that marks the
    // session as streaming is allowed (busy indicators follow it).
    act(() => {
      handleFreshAgentMessage(store.dispatch, streamFrame({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      }))
    })
    await settle(200)
    const sessionsAfterStart = store.getState().freshAgent.sessions
    for (const id of Object.keys(commits)) commits[id] = 0

    // One act per frame: each token arrives as its own websocket message, so
    // React gets the chance to commit after every one of them.
    for (let i = 0; i < 200; i += 1) {
      act(() => {
        handleFreshAgentMessage(store.dispatch, streamFrame({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: `token-${i} ` },
        }))
      })
    }
    // Long enough for any batching of the deltas to flush.
    await settle(300)

    expect(commits).toEqual({
      ContextMenuProvider: 0,
      TabBar: 0,
      MobileTabStrip: 0,
      TabSwitcher: 0,
      Sidebar: 0,
      PaneContainer: 0,
    })
    expect(store.getState().freshAgent.sessions).toBe(sessionsAfterStart)
  })
})
