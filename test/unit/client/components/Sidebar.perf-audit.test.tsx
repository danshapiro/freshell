import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import Sidebar from '@/components/Sidebar'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import tabsReducer from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'
import sessionsReducer from '@/store/sessionsSlice'
import { createPerfAuditBridge, installPerfAuditBridge } from '@/lib/perf-audit-bridge'

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    send: vi.fn(),
    connect: vi.fn().mockResolvedValue(undefined),
    onMessage: vi.fn(() => vi.fn()),
  }),
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    searchSessions: vi.fn().mockResolvedValue({ results: [] }),
  }
})

describe('Sidebar perf audit milestone', () => {
  afterEach(() => {
    cleanup()
    installPerfAuditBridge(null)
  })

  it('marks sidebar.search_results_visible when visible results render for the active query', async () => {
    const bridge = createPerfAuditBridge()
    installPerfAuditBridge(bridge)

    const store = configureStore({
      reducer: {
        settings: settingsReducer,
        tabs: tabsReducer,
        panes: panesReducer,
        sessions: sessionsReducer,
      },
      preloadedState: {
        settings: {
          settings: defaultSettings,
          loaded: true,
          lastSavedAt: undefined,
        },
        tabs: {
          tabs: [{ id: 'tab-1', title: 'Tab 1', mode: 'shell', createRequestId: 'tab-1', status: 'running' }],
          activeTabId: 'tab-1',
        },
        panes: {
          layouts: {},
          activePane: {},
          paneTitles: {},
        },
        sessions: {
          projects: [
            {
              projectPath: '/tmp/project-alpha',
              sessions: [
                {
                  provider: 'claude',
                  sessionId: '00000000-0000-4000-8000-000000000999',
                  title: 'alpha project session',
                  projectPath: '/tmp/project-alpha',
                  updatedAt: 1_000,
                  cwd: '/tmp/project-alpha',
                },
              ],
            },
          ],
          expandedProjects: new Set<string>(),
          wsSnapshotReceived: false,
          isLoading: false,
          error: null,
        },
      },
    })

    render(
      <Provider store={store}>
        <Sidebar view="terminal" onNavigate={() => undefined} width={288} />
      </Provider>,
    )

    const user = userEvent.setup()
    await user.type(screen.getByPlaceholderText('Search...'), 'alpha')

    expect(await screen.findByText(/alpha project session/i)).toBeVisible()
    expect(bridge.snapshot().milestones['sidebar.search_results_visible']).toBeTypeOf('number')
  })
})
