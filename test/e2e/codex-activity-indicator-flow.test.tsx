import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, within } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import TabBar from '@/components/TabBar'
import PaneContainer from '@/components/panes/PaneContainer'
import tabsReducer from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import turnCompletionReducer from '@/store/turnCompletionSlice'
import terminalMetaReducer, { type TerminalMetaState } from '@/store/terminalMetaSlice'
import codexActivityReducer, { type CodexActivityState } from '@/store/codexActivitySlice'
import type { PaneNode, TerminalPaneContent } from '@/store/paneTypes'
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
  },
}))

vi.mock('@/components/TerminalView', () => ({
  default: ({ paneId }: { paneId: string }) => <div data-testid={`terminal-${paneId}`}>terminal</div>,
}))

vi.mock('@/components/icons/PaneIcon', () => ({
  default: ({ content, className }: { content: any; className?: string }) => (
    <svg data-testid="pane-icon" data-content-kind={content?.kind} data-content-mode={content?.mode} className={className} />
  ),
}))

type RenderHarnessOptions = {
  tab?: Partial<Tab>
  pane?: Partial<TerminalPaneContent>
  paneTitle?: string
  codexActivity?: CodexActivityState
  terminalMeta?: TerminalMetaState
}

function renderHarness(options: RenderHarnessOptions = {}) {
  const tab: Tab = {
    id: 'tab-codex',
    createRequestId: 'req-tab',
    title: 'Codex Tab',
    status: 'running',
    mode: 'codex',
    shell: 'system',
    terminalId: 'term-live',
    createdAt: 1,
    ...options.tab,
  }

  const pane: TerminalPaneContent = {
    kind: 'terminal',
    createRequestId: 'req-pane',
    status: 'running',
    mode: 'codex',
    shell: 'system',
    terminalId: 'term-live',
    initialCwd: '/repo',
    ...options.pane,
  }

  const layout: PaneNode = {
    type: 'leaf',
    id: 'pane-codex',
    content: pane,
  }

  const store = configureStore({
    reducer: {
      tabs: tabsReducer,
      panes: panesReducer,
      settings: settingsReducer,
      turnCompletion: turnCompletionReducer,
      terminalMeta: terminalMetaReducer,
      codexActivity: codexActivityReducer,
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
        paneTitles: { [tab.id]: { [layout.id]: options.paneTitle ?? 'Codex Pane' } },
        paneTitleSetByUser: {},
        renameRequestTabId: null,
        renameRequestPaneId: null,
        zoomedPane: {},
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
      terminalMeta: options.terminalMeta ?? {
        byTerminalId: {},
      },
      codexActivity: options.codexActivity ?? {
        byTerminalId: {},
        lastSnapshotSeq: 0,
        liveMutationSeqByTerminalId: {},
        removedMutationSeqByTerminalId: {},
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
}

describe('codex activity indicator flow (e2e)', () => {
  afterEach(() => {
    cleanup()
  })

  it('shows blue icon on pane and tab only when the exact live terminal id is busy', () => {
    renderHarness({
      codexActivity: {
        byTerminalId: {
          'term-live': { terminalId: 'term-live', phase: 'busy', updatedAt: 10 },
        },
        lastSnapshotSeq: 0,
        liveMutationSeqByTerminalId: {},
        removedMutationSeqByTerminalId: {},
      },
    })

    const paneHeader = screen.getByRole('banner', { name: 'Pane: Codex Pane' })
    expect(within(paneHeader).getByTestId('pane-icon').getAttribute('class')).toContain('text-blue-500')

    const tabButton = screen.getByLabelText('Codex Tab')
    expect(within(tabButton).getByTestId('pane-icon').getAttribute('class')).toContain('text-blue-500')
  })

  it('falls back to the exact tab terminal id during single-pane rehydrate gaps', () => {
    renderHarness({
      tab: { terminalId: 'term-tab' },
      pane: { terminalId: undefined },
      codexActivity: {
        byTerminalId: {
          'term-tab': { terminalId: 'term-tab', phase: 'busy', updatedAt: 10 },
        },
        lastSnapshotSeq: 0,
        liveMutationSeqByTerminalId: {},
        removedMutationSeqByTerminalId: {},
      },
    })

    const paneHeader = screen.getByRole('banner', { name: 'Pane: Codex Pane' })
    expect(within(paneHeader).getByTestId('pane-icon').getAttribute('class')).toContain('text-blue-500')

    const tabButton = screen.getByLabelText('Codex Tab')
    expect(within(tabButton).getByTestId('pane-icon').getAttribute('class')).toContain('text-blue-500')
  })

  it('never shows blue from resumeSessionId, sessionRef, cwd, or provider-only terminal meta fallbacks', () => {
    renderHarness({
      tab: {
        terminalId: undefined,
        resumeSessionId: 'session-1',
      },
      pane: {
        terminalId: undefined,
        resumeSessionId: 'session-1',
        sessionRef: {
          provider: 'codex',
          sessionId: 'session-1',
        },
        initialCwd: '/repo',
      },
      terminalMeta: {
        byTerminalId: {
          'term-foreign': {
            terminalId: 'term-foreign',
            provider: 'codex',
            sessionId: 'session-1',
            cwd: '/repo',
            checkoutRoot: '/repo',
            repoRoot: '/repo',
            updatedAt: 5,
          },
        },
      },
      codexActivity: {
        byTerminalId: {
          'term-foreign': { terminalId: 'term-foreign', phase: 'busy', updatedAt: 10 },
        },
        lastSnapshotSeq: 0,
        liveMutationSeqByTerminalId: {},
        removedMutationSeqByTerminalId: {},
      },
    })

    const paneHeader = screen.getByRole('banner', { name: 'Pane: Codex Pane' })
    expect(within(paneHeader).getByTestId('pane-icon').getAttribute('class') ?? '').not.toContain('text-blue-500')

    const tabButton = screen.getByLabelText('Codex Tab')
    expect(within(tabButton).getByTestId('pane-icon').getAttribute('class') ?? '').not.toContain('text-blue-500')
  })
})
