import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, within, act } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import Sidebar from '@/components/Sidebar'
import TabBar from '@/components/TabBar'
import PaneContainer from '@/components/panes/PaneContainer'
import tabsReducer from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import connectionReducer from '@/store/connectionSlice'
import sessionsReducer from '@/store/sessionsSlice'
import sessionActivityReducer from '@/store/sessionActivitySlice'
import extensionsReducer from '@/store/extensionsSlice'
import turnCompletionReducer from '@/store/turnCompletionSlice'
import codexActivityReducer from '@/store/codexActivitySlice'
import agentChatReducer, { removePermission } from '@/store/agentChatSlice'
import terminalDirectoryReducer from '@/store/terminalDirectorySlice'
import type { AgentChatState } from '@/store/agentChatTypes'
import paneRuntimeActivityReducer, {
  clearPaneRuntimeActivity,
  setPaneRuntimeActivity,
  type PaneRuntimeActivityState,
} from '@/store/paneRuntimeActivitySlice'
import type {
  AgentChatPaneContent,
  BrowserPaneContent,
  PaneContent,
  PaneNode,
  TerminalPaneContent,
} from '@/store/paneTypes'
import type { Tab } from '@/store/types'

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    send: vi.fn(),
  }),
}))

vi.mock('@/lib/api', () => ({
  api: {
    get: vi.fn().mockResolvedValue({}),
    post: vi.fn().mockResolvedValue({}),
    patch: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({}),
  },
}))

vi.mock('@/store/sessionsThunks', () => ({
  fetchSessionWindow: () => ({ type: 'sessions/fetchWindow' }),
}))

vi.mock('@/components/NetworkQuickAccess', () => ({
  default: () => null,
}))

vi.mock('@/components/TerminalView', () => ({
  default: ({ paneId }: { paneId: string }) => <div data-testid={`terminal-${paneId}`}>terminal</div>,
}))

vi.mock('@/components/panes/BrowserPane', () => ({
  default: ({ paneId }: { paneId: string }) => <div data-testid={`browser-${paneId}`}>browser</div>,
}))

vi.mock('@/components/agent-chat/AgentChatView', () => ({
  default: ({ paneId }: { paneId: string }) => <div data-testid={`agent-chat-${paneId}`}>agent-chat</div>,
}))

vi.mock('@/components/icons/PaneIcon', () => ({
  default: ({ content, className }: { content: PaneContent; className?: string }) => (
    <svg
      data-testid="pane-icon"
      data-content-kind={content?.kind}
      data-content-mode={'mode' in content ? content.mode : undefined}
      data-provider={'provider' in content ? content.provider : undefined}
      className={className}
    />
  ),
}))

type RenderHarnessOptions = {
  tab?: Partial<Tab>
  pane: TerminalPaneContent | BrowserPaneContent | AgentChatPaneContent
  paneTitle?: string
  paneRuntimeActivity?: PaneRuntimeActivityState
  agentChat?: AgentChatState
}

function renderHarness(options: RenderHarnessOptions) {
  const tab: Tab = {
    id: 'tab-activity',
    createRequestId: 'req-tab',
    title: 'Activity Tab',
    status: 'running',
    mode: options.pane.kind === 'terminal' ? options.pane.mode : 'shell',
    shell: 'system',
    terminalId: options.pane.kind === 'terminal' ? options.pane.terminalId : undefined,
    createdAt: 1,
    ...options.tab,
  }

  const layout: PaneNode = {
    type: 'leaf',
    id: 'pane-activity',
    content: options.pane,
  }

  const store = configureStore({
    reducer: {
      tabs: tabsReducer,
      panes: panesReducer,
      settings: settingsReducer,
      turnCompletion: turnCompletionReducer,
      codexActivity: codexActivityReducer,
      agentChat: agentChatReducer,
      paneRuntimeActivity: paneRuntimeActivityReducer,
    },
    preloadedState: {
      tabs: {
        tabs: [tab],
        activeTabId: tab.id,
        renameRequestTabId: null,
      },
      panes: {
        layouts: { [tab.id]: layout },
        activePane: { [tab.id]: layout.id },
        paneTitles: { [tab.id]: { [layout.id]: options.paneTitle ?? 'Activity Pane' } },
        paneTitleSetByUser: {},
        renameRequestTabId: null,
        renameRequestPaneId: null,
        zoomedPane: {},
        refreshRequestsByPane: {},
      },
      settings: {
        settings: defaultSettings,
        loaded: true,
        lastSavedAt: null,
      },
      turnCompletion: {
        seq: 0,
        lastEvent: null,
        pendingEvents: [],
        attentionByTab: {},
        attentionByPane: {},
      },
      codexActivity: {
        byTerminalId: {},
        lastSnapshotSeq: 0,
        liveMutationSeqByTerminalId: {},
        removedMutationSeqByTerminalId: {},
      },
      agentChat: options.agentChat ?? {
        sessions: {},
        pendingCreates: {},
        availableModels: [],
      },
      paneRuntimeActivity: options.paneRuntimeActivity ?? {
        byPaneId: {},
      },
    },
  })

  render(
    <Provider store={store}>
      <div>
        <TabBar />
        <PaneContainer tabId={tab.id} node={layout} />
      </div>
    </Provider>,
  )

  return { store }
}

function getVisibleSinglePaneTab() {
  return screen.getByLabelText('Activity Pane')
}

function renderSidebarActivityHarness(options: {
  pane: AgentChatPaneContent
  agentChat: AgentChatState
}) {
  const tab: Tab = {
    id: 'tab-sidebar-activity',
    createRequestId: 'req-sidebar-tab',
    title: 'Sidebar Activity Tab',
    status: 'running',
    mode: 'claude',
    shell: 'system',
    resumeSessionId: options.pane.resumeSessionId,
    createdAt: 1,
  }

  const layout: PaneNode = {
    type: 'leaf',
    id: 'pane-sidebar-activity',
    content: options.pane,
  }

  const projects = [
    {
      projectPath: '/home/user/code/freshell',
      sessions: [
        {
          provider: 'claude',
          sessionType: 'freshclaude',
          sessionId: 'canonical-session-1',
          title: 'Canonical FreshClaude',
          projectPath: '/home/user/code/freshell',
          cwd: '/home/user/code/freshell',
          lastActivityAt: 2,
        },
        {
          provider: 'claude',
          sessionType: 'freshclaude',
          sessionId: 'stale-resume',
          title: 'Stale FreshClaude',
          projectPath: '/home/user/code/freshell',
          cwd: '/home/user/code/freshell/other',
          lastActivityAt: 1,
        },
      ],
    },
  ]

  const store = configureStore({
    reducer: {
      tabs: tabsReducer,
      panes: panesReducer,
      settings: settingsReducer,
      connection: connectionReducer,
      sessions: sessionsReducer,
      sessionActivity: sessionActivityReducer,
      extensions: extensionsReducer,
      turnCompletion: turnCompletionReducer,
      codexActivity: codexActivityReducer,
      terminalDirectory: terminalDirectoryReducer,
      agentChat: agentChatReducer,
      paneRuntimeActivity: paneRuntimeActivityReducer,
    },
    middleware: (getDefaultMiddleware) =>
      getDefaultMiddleware({
        serializableCheck: {
          ignoredPaths: ['sessions.expandedProjects'],
        },
      }),
    preloadedState: {
      tabs: {
        tabs: [tab],
        activeTabId: tab.id,
        renameRequestTabId: null,
      },
      panes: {
        layouts: { [tab.id]: layout },
        activePane: { [tab.id]: layout.id },
        paneTitles: { [tab.id]: { [layout.id]: 'Sidebar Activity Pane' } },
        paneTitleSetByUser: {},
        renameRequestTabId: null,
        renameRequestPaneId: null,
        zoomedPane: {},
        refreshRequestsByPane: {},
      },
      settings: {
        settings: defaultSettings,
        loaded: true,
        lastSavedAt: null,
      },
      connection: {
        status: 'connected',
        platform: null,
        availableClis: {},
      },
      sessions: {
        projects,
        expandedProjects: new Set<string>(),
        wsSnapshotReceived: false,
        windows: {
          sidebar: {
            projects,
            lastLoadedAt: 1,
            totalSessions: 2,
            hasMore: false,
            loading: false,
          },
        },
      },
      sessionActivity: {
        sessions: {},
      },
      extensions: {
        entries: [],
      },
      turnCompletion: {
        seq: 0,
        lastEvent: null,
        pendingEvents: [],
        attentionByTab: {},
        attentionByPane: {},
      },
      codexActivity: {
        byTerminalId: {},
        lastSnapshotSeq: 0,
        liveMutationSeqByTerminalId: {},
        removedMutationSeqByTerminalId: {},
      },
      terminalDirectory: {
        windows: {
          sidebar: {
            items: [],
            nextCursor: null,
            revision: 1,
          },
        },
        searches: {},
      },
      agentChat: options.agentChat,
      paneRuntimeActivity: {
        byPaneId: {},
      },
    },
  })

  render(
    <Provider store={store}>
      <Sidebar view="sessions" onNavigate={vi.fn()} />
    </Provider>,
  )

  return { store }
}

describe('pane activity indicator flow (e2e)', () => {
  afterEach(() => {
    cleanup()
  })

  it('shows browser loading activity as blue and clears when the pane returns to idle', () => {
    const pane: BrowserPaneContent = {
      kind: 'browser',
      browserInstanceId: 'browser-1',
      url: 'https://example.com',
      devToolsOpen: false,
    }

    const { store } = renderHarness({
      pane,
      paneRuntimeActivity: {
        byPaneId: {
          'pane-activity': {
            source: 'browser',
            phase: 'loading',
            updatedAt: 10,
          },
        },
      },
    })

    const paneHeader = screen.getByRole('banner', { name: 'Pane: Activity Pane' })
    expect(within(paneHeader).getByTestId('pane-icon').getAttribute('class')).toContain('text-blue-500')
    expect(within(getVisibleSinglePaneTab()).getByTestId('pane-icon').getAttribute('class')).toContain('text-blue-500')

    act(() => {
      store.dispatch(clearPaneRuntimeActivity({ paneId: 'pane-activity' }))
    })

    expect(within(paneHeader).getByTestId('pane-icon').getAttribute('class') ?? '').not.toContain('text-blue-500')
    expect(within(getVisibleSinglePaneTab()).getByTestId('pane-icon').getAttribute('class') ?? '').not.toContain('text-blue-500')
  })

  it('treats freshclaude waits as non-blue but running work as blue', () => {
    const pane: AgentChatPaneContent = {
      kind: 'agent-chat',
      provider: 'freshclaude',
      createRequestId: 'req-agent',
      sessionId: 'sess-1',
      status: 'running',
    }

    const { store } = renderHarness({
      pane,
      agentChat: {
        sessions: {
          'sess-1': {
            sessionId: 'sess-1',
            status: 'running',
            messages: [],
            timelineItems: [],
            timelineBodies: {},
            streamingText: '',
            streamingActive: false,
            pendingPermissions: {
              'perm-1': {
                requestId: 'perm-1',
                subtype: 'can_use_tool',
              },
            },
            pendingQuestions: {},
            totalCostUsd: 0,
            totalInputTokens: 0,
            totalOutputTokens: 0,
          },
        },
        pendingCreates: {},
        availableModels: [],
      },
    })

    const paneHeader = screen.getByRole('banner', { name: 'Pane: Activity Pane' })
    expect(within(paneHeader).getByTestId('pane-icon').getAttribute('class') ?? '').not.toContain('text-blue-500')
    expect(within(getVisibleSinglePaneTab()).getByTestId('pane-icon').getAttribute('class') ?? '').not.toContain('text-blue-500')

    act(() => {
      store.dispatch(removePermission({ sessionId: 'sess-1', requestId: 'perm-1' }))
    })

    expect(within(paneHeader).getByTestId('pane-icon').getAttribute('class')).toContain('text-blue-500')
    expect(within(getVisibleSinglePaneTab()).getByTestId('pane-icon').getAttribute('class')).toContain('text-blue-500')
  })

  it('keeps claude terminals non-blue while pending, blue while working, and clears on idle', () => {
    const pane: TerminalPaneContent = {
      kind: 'terminal',
      createRequestId: 'req-claude',
      status: 'running',
      mode: 'claude',
      shell: 'system',
      terminalId: 'term-claude',
      resumeSessionId: '11111111-1111-4111-8111-111111111111',
    }

    const { store } = renderHarness({
      pane,
      tab: {
        mode: 'claude',
        terminalId: 'term-claude',
        resumeSessionId: '11111111-1111-4111-8111-111111111111',
      },
      paneRuntimeActivity: {
        byPaneId: {
          'pane-activity': {
            source: 'terminal',
            phase: 'pending',
            updatedAt: 1,
          },
        },
      },
    })

    const paneHeader = screen.getByRole('banner', { name: 'Pane: Activity Pane' })
    expect(within(paneHeader).getByTestId('pane-icon').getAttribute('class') ?? '').not.toContain('text-blue-500')
    expect(within(getVisibleSinglePaneTab()).getByTestId('pane-icon').getAttribute('class') ?? '').not.toContain('text-blue-500')

    act(() => {
      store.dispatch(setPaneRuntimeActivity({
        paneId: 'pane-activity',
        source: 'terminal',
        phase: 'working',
        updatedAt: 2,
      }))
    })

    expect(within(paneHeader).getByTestId('pane-icon').getAttribute('class')).toContain('text-blue-500')
    expect(within(getVisibleSinglePaneTab()).getByTestId('pane-icon').getAttribute('class')).toContain('text-blue-500')

    act(() => {
      store.dispatch(clearPaneRuntimeActivity({ paneId: 'pane-activity' }))
    })

    expect(within(paneHeader).getByTestId('pane-icon').getAttribute('class') ?? '').not.toContain('text-blue-500')
    expect(within(getVisibleSinglePaneTab()).getByTestId('pane-icon').getAttribute('class') ?? '').not.toContain('text-blue-500')
  })

  it('restores the sidebar activity indicator from timelineSessionId when only the canonical durable id is known', () => {
    const pane: AgentChatPaneContent = {
      kind: 'agent-chat',
      provider: 'freshclaude',
      createRequestId: 'req-agent',
      sessionId: 'sdk-restore-1',
      resumeSessionId: 'stale-resume',
      status: 'running',
    }

    const { store } = renderSidebarActivityHarness({
      pane,
      agentChat: {
        sessions: {
          'sdk-restore-1': {
            sessionId: 'sdk-restore-1',
            timelineSessionId: 'canonical-session-1',
            status: 'running',
            messages: [],
            timelineItems: [],
            timelineBodies: {},
            streamingText: '',
            streamingActive: false,
            pendingPermissions: {
              'perm-1': {
                requestId: 'perm-1',
                subtype: 'can_use_tool',
              },
            },
            pendingQuestions: {},
            totalCostUsd: 0,
            totalInputTokens: 0,
            totalOutputTokens: 0,
          },
        },
        pendingCreates: {},
        availableModels: [],
      },
    })

    const canonicalButton = screen.getByRole('button', { name: /Canonical FreshClaude/i })
    const staleButton = screen.getByRole('button', { name: /Stale FreshClaude/i })

    expect(canonicalButton.querySelector('.text-blue-500')).toBeFalsy()
    expect(staleButton.querySelector('.text-blue-500')).toBeFalsy()

    act(() => {
      store.dispatch(removePermission({ sessionId: 'sdk-restore-1', requestId: 'perm-1' }))
    })

    expect(canonicalButton.querySelector('.text-blue-500')).toBeTruthy()
    expect(staleButton.querySelector('.text-blue-500')).toBeFalsy()
  })
})
