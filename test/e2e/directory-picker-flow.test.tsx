import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import PaneContainer from '@/components/panes/PaneContainer'
import panesReducer from '@/store/panesSlice'
import tabsReducer from '@/store/tabsSlice'
import settingsReducer from '@/store/settingsSlice'
import connectionReducer from '@/store/connectionSlice'
import type { PaneNode } from '@/store/paneTypes'

const { mockApiGet, mockApiPost, mockApiPatch } = vi.hoisted(() => ({
  mockApiGet: vi.fn(),
  mockApiPost: vi.fn(),
  mockApiPatch: vi.fn(),
}))

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    send: vi.fn(),
  }),
}))

vi.mock('@/components/TerminalView', () => ({
  default: ({ paneId }: { paneId: string }) => <div data-testid={`terminal-${paneId}`}>terminal</div>,
}))

vi.mock('@/lib/api', () => ({
  api: {
    get: (path: string) => mockApiGet(path),
    post: (path: string, body: unknown) => mockApiPost(path, body),
    patch: (path: string, body: unknown) => mockApiPatch(path, body),
  },
}))

function renderPickerFlow() {
  const node: PaneNode = {
    type: 'leaf',
    id: 'pane-1',
    content: { kind: 'picker' },
  }

  const store = configureStore({
    reducer: {
      panes: panesReducer,
      tabs: tabsReducer,
      settings: settingsReducer,
      connection: connectionReducer,
    },
    preloadedState: {
      panes: {
        layouts: { 'tab-1': node },
        activePane: { 'tab-1': 'pane-1' },
        paneTitles: {},
      },
      tabs: {
        tabs: [{ id: 'tab-1', createRequestId: 'tab-1', title: 'Tab 1', mode: 'shell' as const, status: 'running' as const, createdAt: 1 }],
        activeTabId: 'tab-1',
      },
      connection: {
        status: 'ready' as const,
        platform: 'linux',
        availableClis: { claude: true },
      },
      settings: {
        settings: {
          theme: 'system' as const,
          uiScale: 1,
          terminal: {
            fontSize: 14,
            fontFamily: 'monospace',
            lineHeight: 1.2,
            cursorBlink: true,
            scrollback: 5000,
            theme: 'auto' as const,
          },
          safety: { autoKillIdleMinutes: 180, warnBeforeKillMinutes: 5 },
          sidebar: { sortMode: 'activity' as const, showProjectBadges: true, width: 288, collapsed: false },
          panes: { defaultNewPane: 'ask' as const },
          codingCli: {
            enabledProviders: ['claude'] as any[],
            providers: { claude: { cwd: '/home/user/work' } },
          },
          logging: { debug: false },
        },
        loaded: true,
        lastSavedAt: null,
      },
    },
  })

  render(
    <Provider store={store}>
      <PaneContainer tabId="tab-1" node={node} />
    </Provider>
  )

  return { store }
}

describe('directory picker flow (e2e)', () => {
  beforeEach(() => {
    mockApiGet.mockReset()
    mockApiPost.mockReset()
    mockApiPatch.mockReset()
    mockApiGet.mockResolvedValue({ directories: ['/home/user/work', '/home/user/next'] })
    mockApiPost.mockResolvedValue({ valid: true, resolvedPath: '/home/user/next' })
    mockApiPatch.mockResolvedValue({})
  })

  it('launches coding CLI terminal with confirmed directory', async () => {
    const { store } = renderPickerFlow()

    const picker = document.querySelector('[data-context="pane-picker"]')
    if (!picker) throw new Error('Pane picker not found')
    fireEvent.keyDown(picker, { key: 'l' })
    fireEvent.transitionEnd(picker)

    const input = screen.getByLabelText('Starting directory for Claude')
    fireEvent.change(input, { target: { value: '/home/user/next' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => {
      const content = (store.getState().panes.layouts['tab-1'] as Extract<PaneNode, { type: 'leaf' }>).content
      expect(content.kind).toBe('terminal')
      if (content.kind === 'terminal') {
        expect(content.mode).toBe('claude')
        expect(content.initialCwd).toBe('/home/user/next')
      }
    })

    expect(mockApiPatch).toHaveBeenCalledWith('/api/settings', {
      codingCli: { providers: { claude: { cwd: '/home/user/next' } } },
    })
  })
})
