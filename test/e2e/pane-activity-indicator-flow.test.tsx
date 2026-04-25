import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'
import { render, screen, cleanup, within, act, fireEvent, waitFor } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import TabBar from '@/components/TabBar'
import PaneContainer from '@/components/panes/PaneContainer'
import tabsReducer from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import turnCompletionReducer from '@/store/turnCompletionSlice'
import codexActivityReducer from '@/store/codexActivitySlice'
import opencodeActivityReducer, {
  removeOpencodeActivity,
  upsertOpencodeActivity,
} from '@/store/opencodeActivitySlice'
import agentChatReducer, { removePermission } from '@/store/agentChatSlice'
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

const wsSend = vi.hoisted(() => vi.fn())
const getAgentChatCapabilities = vi.hoisted(() => vi.fn())
const refreshAgentChatCapabilities = vi.hoisted(() => vi.fn())
const setSessionMetadata = vi.hoisted(() => vi.fn(() => Promise.resolve(undefined)))
const saveServerSettingsPatchSpy = vi.hoisted(() => vi.fn((patch: unknown) => ({
  type: 'settings/saveServerSettingsPatch',
  payload: patch,
})))

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
  getAgentChatCapabilities: (...args: unknown[]) => getAgentChatCapabilities(...args),
  refreshAgentChatCapabilities: (...args: unknown[]) => refreshAgentChatCapabilities(...args),
  setSessionMetadata: (...args: unknown[]) => setSessionMetadata(...args),
}))

vi.mock('@/store/settingsThunks', () => ({
  saveServerSettingsPatch: (patch: unknown) => saveServerSettingsPatchSpy(patch),
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
  settingsOverrides?: Record<string, unknown>
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
      opencodeActivity: opencodeActivityReducer,
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
        settings: {
          ...defaultSettings,
          ...(options.settingsOverrides ?? {}),
        } as typeof defaultSettings,
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
      opencodeActivity: {
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

describe('pane activity indicator flow (e2e)', () => {
  afterEach(() => {
    cleanup()
    wsSend.mockClear()
    getAgentChatCapabilities.mockReset()
    refreshAgentChatCapabilities.mockReset()
    setSessionMetadata.mockClear()
    saveServerSettingsPatchSpy.mockClear()
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

  it('restores pane and tab activity from timelineSessionId when only the canonical durable id is known', () => {
    const pane: AgentChatPaneContent = {
      kind: 'agent-chat',
      provider: 'freshclaude',
      createRequestId: 'req-agent',
      sessionId: 'sdk-restore-1',
      resumeSessionId: 'stale-resume',
      status: 'running',
    }

    const { store } = renderHarness({
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

    const paneHeader = screen.getByRole('banner', { name: 'Pane: Activity Pane' })
    expect(within(paneHeader).getByTestId('pane-icon').getAttribute('class') ?? '').not.toContain('text-blue-500')
    expect(within(getVisibleSinglePaneTab()).getByTestId('pane-icon').getAttribute('class') ?? '').not.toContain('text-blue-500')

    act(() => {
      store.dispatch(removePermission({ sessionId: 'sdk-restore-1', requestId: 'perm-1' }))
    })

    expect(within(paneHeader).getByTestId('pane-icon').getAttribute('class')).toContain('text-blue-500')
    expect(within(getVisibleSinglePaneTab()).getByTestId('pane-icon').getAttribute('class')).toContain('text-blue-500')
  })

  it('keeps FreshClaude activity blue while mid-session model changes send sdk.set-model without rewriting provider defaults', async () => {
    const ActualAgentChatView = (
      await vi.importActual<typeof import('@/components/agent-chat/AgentChatView')>('@/components/agent-chat/AgentChatView')
    ).default

    const pane: AgentChatPaneContent = {
      kind: 'agent-chat',
      provider: 'freshclaude',
      createRequestId: 'req-agent',
      sessionId: 'sess-1',
      status: 'running',
      modelSelection: { kind: 'tracked', modelId: 'opus[1m]' },
      effort: 'turbo',
    }

    const { store } = renderHarness({
      pane,
      settingsOverrides: {
        agentChat: {
          ...defaultSettings.agentChat,
          providers: {
            freshclaude: {
              modelSelection: { kind: 'tracked', modelId: 'opus[1m]' },
              effort: 'turbo',
            },
          },
        },
      },
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
            pendingPermissions: {},
            pendingQuestions: {},
            totalCostUsd: 0,
            totalInputTokens: 0,
            totalOutputTokens: 0,
          },
        },
        pendingCreates: {},
        pendingCreateFailures: {},
        capabilitiesByProvider: {
          freshclaude: {
            status: 'succeeded',
            capabilities: {
              provider: 'freshclaude',
              fetchedAt: Date.now(),
              models: [
                {
                  id: 'opus[1m]',
                  displayName: 'Opus 1M',
                  description: 'Long context window',
                  supportsEffort: true,
                  supportedEffortLevels: ['turbo'],
                  supportsAdaptiveThinking: true,
                },
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
          },
        },
      } as AgentChatState,
    })

    render(
      <Provider store={store}>
        <div data-testid="actual-agent-chat-harness">
          <ActualAgentChatView tabId="tab-activity" paneId="pane-activity" paneContent={pane} />
        </div>
      </Provider>,
    )

    const paneHeader = screen.getByRole('banner', { name: 'Pane: Activity Pane' })
    expect(within(paneHeader).getByTestId('pane-icon').getAttribute('class')).toContain('text-blue-500')
    expect(within(getVisibleSinglePaneTab()).getByTestId('pane-icon').getAttribute('class')).toContain('text-blue-500')

    const agentChatHarness = screen.getByTestId('actual-agent-chat-harness')
    const modelSelect = await within(agentChatHarness).findByLabelText('Model') as HTMLSelectElement
    const haikuValue = Array.from(modelSelect.options).find((option) => option.text === 'Haiku')?.value
    fireEvent.change(modelSelect, { target: { value: haikuValue } })

    await waitFor(() => {
      expect(wsSend).toHaveBeenCalledWith({
        type: 'sdk.set-model',
        sessionId: 'sess-1',
        model: 'haiku',
      })
    })
    await waitFor(() => {
      expect(saveServerSettingsPatchSpy).toHaveBeenCalledTimes(2)
      expect(saveServerSettingsPatchSpy).toHaveBeenNthCalledWith(1, {
        agentChat: {
          providers: {
            freshclaude: {
              modelSelection: { kind: 'tracked', modelId: 'haiku' },
            },
          },
        },
      })
    })
    expect(saveServerSettingsPatchSpy).toHaveBeenNthCalledWith(2, {
      agentChat: {
        providers: {
          freshclaude: {
            effort: undefined,
          },
        },
      },
    })
    expect(within(paneHeader).getByTestId('pane-icon').getAttribute('class')).toContain('text-blue-500')
    expect(within(getVisibleSinglePaneTab()).getByTestId('pane-icon').getAttribute('class')).toContain('text-blue-500')
  })
})
