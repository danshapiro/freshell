import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'
import { render, screen, cleanup, within, act } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import TabBar from '@/components/TabBar'
import PaneContainer from '@/components/panes/PaneContainer'
import tabsReducer from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import turnCompletionReducer from '@/store/turnCompletionSlice'
import codexActivityReducer from '@/store/codexActivitySlice'
import claudeActivityReducer, {
  resetClaudeActivity,
  setClaudeActivitySnapshot,
  upsertClaudeActivity,
} from '@/store/claudeActivitySlice'
import opencodeActivityReducer, {
  removeOpencodeActivity,
  upsertOpencodeActivity,
} from '@/store/opencodeActivitySlice'
import freshAgentReducer, { removePermission } from '@/store/freshAgentSlice'
import type { FreshAgentSessionState, FreshAgentState } from '@/store/freshAgentTypes'
import paneRuntimeActivityReducer, {
  clearPaneRuntimeActivity,
  type PaneRuntimeActivityState,
} from '@/store/paneRuntimeActivitySlice'
import { makeFreshAgentSessionKey } from '@shared/fresh-agent'
import type {
  BrowserPaneContent,
  FreshAgentPaneContent,
  PaneContent,
  PaneNode,
  TerminalPaneContent,
} from '@/store/paneTypes'
import type { Tab } from '@/store/types'

const wsSend = vi.hoisted(() => vi.fn())

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    send: wsSend,
    onReconnect: vi.fn(() => () => {}),
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

vi.mock('@/components/fresh-agent/FreshAgentView', () => ({
  default: ({ paneId }: { paneId: string }) => <div data-testid={`fresh-agent-${paneId}`}>fresh-agent</div>,
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
  pane: TerminalPaneContent | BrowserPaneContent | FreshAgentPaneContent
  paneTitle?: string
  paneRuntimeActivity?: PaneRuntimeActivityState
  freshAgent?: FreshAgentState
  settingsOverrides?: Record<string, unknown>
}

function createFreshAgentSession(
  overrides: Partial<FreshAgentSessionState> & {
    sessionId: string
    sessionType?: FreshAgentSessionState['sessionType']
    provider?: FreshAgentSessionState['provider']
  },
): FreshAgentSessionState {
  const sessionType = overrides.sessionType ?? 'freshclaude'
  const provider = overrides.provider ?? 'claude'
  const sessionKey = makeFreshAgentSessionKey({
    sessionType,
    provider,
    sessionId: overrides.sessionId,
  })

  return {
    sessionKey,
    sessionType,
    provider,
    sessionId: overrides.sessionId,
    threadId: overrides.threadId ?? overrides.sessionId,
    status: 'idle',
    turns: [],
    historyItems: [],
    historyBodies: {},
    streamingText: '',
    streamingActive: false,
    pendingPermissions: {},
    pendingQuestions: {},
    totalCostUsd: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    ...overrides,
  }
}

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
  HTMLElement.prototype.scrollIntoView = vi.fn()
})

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
      claudeActivity: claudeActivityReducer,
      opencodeActivity: opencodeActivityReducer,
      freshAgent: freshAgentReducer,
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
        settings: {
          ...defaultSettings,
          ...(options.settingsOverrides ?? {}),
        } as typeof defaultSettings,
        loaded: true,
        lastSavedAt: null,
      },
      turnCompletion: {
        seq: 0,
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
      claudeActivity: {
        byTerminalId: {},
        lastSnapshotSeq: 0,
        liveMutationSeqByTerminalId: {},
        removedMutationSeqByTerminalId: {},
      },
      opencodeActivity: {
        byTerminalId: {},
        lastSnapshotSeq: 0,
        liveMutationSeqByTerminalId: {},
        removedMutationSeqByTerminalId: {},
      },
      freshAgent: options.freshAgent ?? {
        sessions: {},
        pendingCreates: {},
        pendingCreateFailures: {},
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
  const tab = screen
    .getAllByLabelText('Activity Pane')
    .find((element) => element.getAttribute('data-context') === 'tab')
  if (!tab) throw new Error('Activity Pane tab not found')
  return tab
}

function expectFreshAgentHeaderBusy(paneHeader: HTMLElement, expectedBusy: boolean) {
  const identity = within(paneHeader).getByText('freshclaude')
  const className = identity.getAttribute('class') ?? ''
  if (expectedBusy) {
    expect(className).toContain('text-blue-500')
  } else {
    expect(className).not.toContain('text-blue-500')
  }
}

describe('pane activity indicator flow (e2e)', () => {
  afterEach(() => {
    cleanup()
    wsSend.mockClear()
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
    const pane: FreshAgentPaneContent = {
      kind: 'fresh-agent',
      sessionType: 'freshclaude',
      provider: 'claude',
      createRequestId: 'req-agent',
      sessionId: 'sess-1',
      status: 'running',
    }

    const { store } = renderHarness({
      pane,
      freshAgent: {
        sessions: {
          [makeFreshAgentSessionKey({
            sessionType: 'freshclaude',
            provider: 'claude',
            sessionId: 'sess-1',
          })]: createFreshAgentSession({
            sessionId: 'sess-1',
            status: 'running',
            pendingPermissions: {
              'perm-1': {
                requestId: 'perm-1',
                subtype: 'can_use_tool',
              },
            },
            pendingQuestions: {},
          }),
        },
        pendingCreates: {},
        pendingCreateFailures: {},
        availableModels: [],
      },
    })

    const paneHeader = screen.getByRole('banner', { name: 'Pane: Activity Pane' })
    expectFreshAgentHeaderBusy(paneHeader, false)
    expect(within(getVisibleSinglePaneTab()).getByTestId('pane-icon').getAttribute('class') ?? '').not.toContain('text-blue-500')

    act(() => {
      store.dispatch(removePermission({
        sessionId: 'sess-1',
        sessionType: 'freshclaude',
        provider: 'claude',
        requestId: 'perm-1',
      }))
    })

    expectFreshAgentHeaderBusy(paneHeader, true)
    expect(within(getVisibleSinglePaneTab()).getByTestId('pane-icon').getAttribute('class')).toContain('text-blue-500')
  })

  it('keeps claude terminals non-blue when idle and blue while the server marks them busy', () => {
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
    })

    const paneHeader = screen.getByRole('banner', { name: 'Pane: Activity Pane' })
    expect(within(paneHeader).getByTestId('pane-icon').getAttribute('class') ?? '').not.toContain('text-blue-500')
    expect(within(getVisibleSinglePaneTab()).getByTestId('pane-icon').getAttribute('class') ?? '').not.toContain('text-blue-500')

    act(() => {
      store.dispatch(upsertClaudeActivity({
        terminals: [{ terminalId: 'term-claude', phase: 'busy', updatedAt: 1 }],
      }))
    })

    expect(within(paneHeader).getByTestId('pane-icon').getAttribute('class')).toContain('text-blue-500')
    expect(within(getVisibleSinglePaneTab()).getByTestId('pane-icon').getAttribute('class')).toContain('text-blue-500')

    act(() => {
      store.dispatch(upsertClaudeActivity({
        terminals: [{ terminalId: 'term-claude', phase: 'idle', updatedAt: 2 }],
      }))
    })

    expect(within(paneHeader).getByTestId('pane-icon').getAttribute('class') ?? '').not.toContain('text-blue-500')
    expect(within(getVisibleSinglePaneTab()).getByTestId('pane-icon').getAttribute('class') ?? '').not.toContain('text-blue-500')
  })

  it('keeps a claude pane blue across a transport reconnect (rehydrates busy from the server snapshot)', () => {
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
    })

    const paneHeader = screen.getByRole('banner', { name: 'Pane: Activity Pane' })

    // Mid-turn: the server marks the claude terminal busy -> blue.
    act(() => {
      store.dispatch(upsertClaudeActivity({
        terminals: [{ terminalId: 'term-claude', phase: 'busy', updatedAt: 1 }],
      }))
    })

    expect(within(paneHeader).getByTestId('pane-icon').getAttribute('class')).toContain('text-blue-500')
    expect(within(getVisibleSinglePaneTab()).getByTestId('pane-icon').getAttribute('class')).toContain('text-blue-500')

    // Transport reconnect: the App clears the overlay (resetClaudeActivityOverlay ->
    // resetClaudeActivity) then re-requests claude.activity.list and applies the
    // server's snapshot reply. The terminal is still busy server-side, so the pane
    // must rehydrate BLUE rather than getting stuck green.
    act(() => {
      store.dispatch(resetClaudeActivity())
    })
    act(() => {
      store.dispatch(setClaudeActivitySnapshot({
        terminals: [{ terminalId: 'term-claude', phase: 'busy', updatedAt: 1 }],
        requestSeq: 1,
      }))
    })

    expect(within(paneHeader).getByTestId('pane-icon').getAttribute('class')).toContain('text-blue-500')
    expect(within(getVisibleSinglePaneTab()).getByTestId('pane-icon').getAttribute('class')).toContain('text-blue-500')
  })

  it('shows OpenCode terminals blue only for exact terminal busy activity and clears on removal', () => {
    const sessionId = '33333333-3333-4333-8333-333333333333'
    const pane: TerminalPaneContent = {
      kind: 'terminal',
      createRequestId: 'req-opencode',
      status: 'running',
      mode: 'opencode',
      shell: 'system',
      terminalId: 'term-opencode',
      sessionRef: {
        provider: 'opencode',
        sessionId,
      },
    }

    const { store } = renderHarness({
      pane,
      tab: {
        mode: 'opencode',
        terminalId: 'term-opencode',
        sessionRef: {
          provider: 'opencode',
          sessionId,
        },
      },
    })

    const paneHeader = screen.getByRole('banner', { name: 'Pane: Activity Pane' })
    expect(within(paneHeader).getByTestId('pane-icon').getAttribute('class') ?? '').not.toContain('text-blue-500')
    expect(within(getVisibleSinglePaneTab()).getByTestId('pane-icon').getAttribute('class') ?? '').not.toContain('text-blue-500')

    act(() => {
      store.dispatch(upsertOpencodeActivity({
        terminals: [{ terminalId: 'term-foreign', phase: 'busy', updatedAt: 1 }],
        mutationSeq: 1,
      }))
    })

    expect(within(paneHeader).getByTestId('pane-icon').getAttribute('class') ?? '').not.toContain('text-blue-500')
    expect(within(getVisibleSinglePaneTab()).getByTestId('pane-icon').getAttribute('class') ?? '').not.toContain('text-blue-500')

    act(() => {
      store.dispatch(upsertOpencodeActivity({
        terminals: [{ terminalId: 'term-opencode', phase: 'busy', updatedAt: 2 }],
        mutationSeq: 2,
      }))
    })

    expect(within(paneHeader).getByTestId('pane-icon').getAttribute('class')).toContain('text-blue-500')
    expect(within(getVisibleSinglePaneTab()).getByTestId('pane-icon').getAttribute('class')).toContain('text-blue-500')

    act(() => {
      store.dispatch(removeOpencodeActivity({
        terminalIds: ['term-opencode'],
        mutationSeq: 3,
      }))
    })

    expect(within(paneHeader).getByTestId('pane-icon').getAttribute('class') ?? '').not.toContain('text-blue-500')
    expect(within(getVisibleSinglePaneTab()).getByTestId('pane-icon').getAttribute('class') ?? '').not.toContain('text-blue-500')
  })

  it('restores pane and tab activity from historySessionId when only the canonical durable id is known', () => {
    const pane: FreshAgentPaneContent = {
      kind: 'fresh-agent',
      sessionType: 'freshclaude',
      provider: 'claude',
      createRequestId: 'req-agent',
      sessionId: 'sdk-restore-1',
      resumeSessionId: 'stale-resume',
      status: 'running',
    }

    const { store } = renderHarness({
      pane,
      freshAgent: {
        sessions: {
          [makeFreshAgentSessionKey({
            sessionType: 'freshclaude',
            provider: 'claude',
            sessionId: 'sdk-restore-1',
          })]: createFreshAgentSession({
            sessionId: 'sdk-restore-1',
            historySessionId: 'canonical-session-1',
            status: 'running',
            pendingPermissions: {
              'perm-1': {
                requestId: 'perm-1',
                subtype: 'can_use_tool',
              },
            },
            pendingQuestions: {},
          }),
        },
        pendingCreates: {},
        pendingCreateFailures: {},
        availableModels: [],
      },
    })

    const paneHeader = screen.getByRole('banner', { name: 'Pane: Activity Pane' })
    expectFreshAgentHeaderBusy(paneHeader, false)
    expect(within(getVisibleSinglePaneTab()).getByTestId('pane-icon').getAttribute('class') ?? '').not.toContain('text-blue-500')

    act(() => {
      store.dispatch(removePermission({
        sessionId: 'sdk-restore-1',
        sessionType: 'freshclaude',
        provider: 'claude',
        requestId: 'perm-1',
      }))
    })

    expectFreshAgentHeaderBusy(paneHeader, true)
    expect(within(getVisibleSinglePaneTab()).getByTestId('pane-icon').getAttribute('class')).toContain('text-blue-500')
  })

})
