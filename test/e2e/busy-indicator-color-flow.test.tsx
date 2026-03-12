import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import TabBar from '@/components/TabBar'
import PaneHeader from '@/components/panes/PaneHeader'
import tabsReducer from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import turnCompletionReducer from '@/store/turnCompletionSlice'

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    send: vi.fn(),
  }),
}))

vi.mock('@/components/icons/PaneIcon', () => ({
  default: ({ content, className }: { content: { kind: string; mode?: string }; className?: string }) => (
    <svg data-testid="pane-icon" data-content-kind={content.kind} data-content-mode={content.mode} className={className} />
  ),
}))

function createStore() {
  return configureStore({
    reducer: {
      tabs: tabsReducer,
      panes: panesReducer,
      settings: settingsReducer,
      turnCompletion: turnCompletionReducer,
    },
    preloadedState: {
      tabs: {
        tabs: [
          {
            id: 'tab-creating',
            createRequestId: 'req-creating',
            title: 'Creating Tab',
            status: 'creating' as const,
            mode: 'shell' as const,
            shell: 'system' as const,
            createdAt: Date.now(),
          },
        ],
        activeTabId: 'tab-creating',
        renameRequestTabId: null,
      },
      panes: {
        layouts: {},
        activePane: {},
        paneTitles: {},
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
    },
  })
}

describe('busy indicator color flow (e2e)', () => {
  afterEach(() => {
    cleanup()
  })

  it('renders creating busy icons as static blue in both tab and pane chrome', () => {
    const store = createStore()

    render(
      <Provider store={store}>
        <div>
          <TabBar />
          <PaneHeader
            title="Creating Pane"
            status="creating"
            isActive={true}
            onClose={vi.fn()}
            content={{
              kind: 'terminal',
              mode: 'shell',
              shell: 'system',
              createRequestId: 'req-pane',
              status: 'creating',
            }}
          />
        </div>
      </Provider>
    )

    const busyIcons = screen.getAllByTestId('pane-icon')
    expect(busyIcons).toHaveLength(2)

    for (const icon of busyIcons) {
      expect(icon.getAttribute('class')).toContain('text-blue-500')
      expect(icon.getAttribute('class')).not.toContain('animate-pulse')
    }
  })
})
