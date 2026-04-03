import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import PaneContainer from '@/components/panes/PaneContainer'
import panesReducer from '@/store/panesSlice'
import tabsReducer from '@/store/tabsSlice'
import settingsReducer from '@/store/settingsSlice'
import connectionReducer from '@/store/connectionSlice'
import extensionsReducer from '@/store/extensionsSlice'
import type { PaneNode } from '@/store/paneTypes'
import type { ClientExtensionEntry } from '@shared/extension-types'
import {
  composeResolvedSettings,
  createDefaultServerSettings,
  mergeServerSettings,
  resolveLocalSettings,
  type LocalSettingsPatch,
  type ServerSettingsPatch,
} from '@shared/settings'

const defaultCliExtensions: ClientExtensionEntry[] = [
  {
    name: 'claude', version: '1.0.0', label: 'Claude CLI', description: '', category: 'cli',
    picker: { shortcut: 'L' },
    cli: { supportsPermissionMode: true, supportsResume: true, resumeCommandTemplate: ['claude', '--resume', '{{sessionId}}'] },
  },
  {
    name: 'codex', version: '1.0.0', label: 'Codex CLI', description: '', category: 'cli',
    picker: { shortcut: 'X' },
    cli: { supportsModel: true, supportsSandbox: true, supportsResume: true, resumeCommandTemplate: ['codex', 'resume', '{{sessionId}}'] },
  },
  {
    name: 'opencode', version: '1.0.0', label: 'OpenCode', description: '', category: 'cli',
    picker: { shortcut: 'O' },
    cli: { supportsModel: true, supportsPermissionMode: true, supportsResume: true, resumeCommandTemplate: ['opencode', '--session', '{{sessionId}}'] },
  },
]

const { mockApiGet, mockApiPost, mockApiPatch, saveServerSettingsPatchSpy } = vi.hoisted(() => ({
  mockApiGet: vi.fn(),
  mockApiPost: vi.fn(),
  mockApiPatch: vi.fn(),
  saveServerSettingsPatchSpy: vi.fn((patch: unknown) => ({
    type: 'settings/saveServerSettingsPatch',
    payload: patch,
  })),
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

vi.mock('@/store/settingsThunks', () => ({
  saveServerSettingsPatch: (patch: unknown) => saveServerSettingsPatchSpy(patch),
}))

const defaultServerSettings = createDefaultServerSettings({
  loggingDebug: false,
})

function createSettingsState(options: {
  server?: ServerSettingsPatch
  local?: LocalSettingsPatch
} = {}) {
  const serverSettings = mergeServerSettings(defaultServerSettings, options.server ?? {})
  const localSettings = resolveLocalSettings(options.local)

  return {
    serverSettings,
    localSettings,
    settings: composeResolvedSettings(serverSettings, localSettings),
    loaded: true,
    lastSavedAt: undefined,
  }
}

function renderPickerFlow(options: {
  availableClis?: Record<string, boolean>
  enabledProviders?: string[]
  providerCwds?: Record<string, { cwd: string }>
} = {}) {
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
      extensions: extensionsReducer,
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
      extensions: {
        entries: defaultCliExtensions,
      },
      connection: {
        status: 'ready' as const,
        platform: 'linux',
        availableClis: options.availableClis ?? { claude: true },
      },
      settings: createSettingsState({
        server: {
          terminal: { scrollback: 5000 },
          safety: { autoKillIdleMinutes: 180 },
          panes: { defaultNewPane: 'ask' },
          codingCli: {
            enabledProviders: options.enabledProviders ?? ['claude'],
            providers: options.providerCwds ?? { claude: { cwd: '/home/user/work' } },
          },
          logging: { debug: false },
        },
        local: {
          theme: 'system',
          uiScale: 1,
          terminal: {
            fontSize: 14,
            fontFamily: 'monospace',
            lineHeight: 1.2,
            cursorBlink: true,
            theme: 'auto',
          },
          sidebar: {
            sortMode: 'activity',
            showProjectBadges: true,
            width: 288,
            collapsed: false,
          },
        },
      }),
    },
  })

  render(
    <Provider store={store}>
      <PaneContainer tabId="tab-1" node={node} />
    </Provider>
  )

  return { store }
}

function renderTabAwarePickerFlow() {
  const layout: PaneNode = {
    type: 'split',
    id: 'split-1',
    direction: 'horizontal',
    children: [
      {
        type: 'leaf',
        id: 'pane-existing',
        content: {
          kind: 'terminal',
          mode: 'claude',
          createRequestId: 'req-existing',
          status: 'running' as const,
          initialCwd: '/code/tab-project',
        },
      },
      {
        type: 'leaf',
        id: 'pane-picker',
        content: { kind: 'picker' },
      },
    ],
    sizes: [50, 50],
  }

  const store = configureStore({
    reducer: {
      panes: panesReducer,
      tabs: tabsReducer,
      settings: settingsReducer,
      connection: connectionReducer,
      extensions: extensionsReducer,
    },
    preloadedState: {
      panes: {
        layouts: { 'tab-1': layout },
        activePane: { 'tab-1': 'pane-picker' },
        paneTitles: {},
      },
      tabs: {
        tabs: [{ id: 'tab-1', createRequestId: 'tab-1', title: 'Tab 1', mode: 'shell' as const, status: 'running' as const, createdAt: 1 }],
        activeTabId: 'tab-1',
      },
      extensions: {
        entries: defaultCliExtensions,
      },
      connection: {
        status: 'ready' as const,
        platform: 'linux',
        availableClis: { claude: true },
      },
      settings: createSettingsState({
        server: {
          terminal: { scrollback: 5000 },
          safety: { autoKillIdleMinutes: 180 },
          panes: { defaultNewPane: 'ask' },
          codingCli: {
            enabledProviders: ['claude'],
            providers: { claude: { cwd: '/code/global-default' } },
          },
          logging: { debug: false },
        },
        local: {
          theme: 'system',
          uiScale: 1,
          terminal: {
            fontSize: 14,
            fontFamily: 'monospace',
            lineHeight: 1.2,
            cursorBlink: true,
            theme: 'auto',
          },
          sidebar: {
            sortMode: 'activity',
            showProjectBadges: true,
            width: 288,
            collapsed: false,
          },
        },
      }),
    },
  })

  render(
    <Provider store={store}>
      <PaneContainer tabId="tab-1" node={layout} />
    </Provider>
  )

  return { store }
}

describe('directory picker flow (e2e)', () => {
  beforeEach(() => {
    mockApiGet.mockReset()
    mockApiPost.mockReset()
    mockApiPatch.mockReset()
    saveServerSettingsPatchSpy.mockReset()
    mockApiGet.mockResolvedValue({ directories: ['/home/user/work', '/home/user/next'] })
    mockApiPost.mockResolvedValue({ valid: true, resolvedPath: '/home/user/next' })
    mockApiPatch.mockResolvedValue({})
  })

  afterEach(() => {
    cleanup()
  })

  it('launches coding CLI terminal with confirmed directory', async () => {
    const { store } = renderPickerFlow()

    const picker = document.querySelector('[data-context="pane-picker"]')
    if (!picker) throw new Error('Pane picker not found')
    fireEvent.keyDown(picker, { key: 'l' })
    fireEvent.transitionEnd(picker)

    const input = screen.getByLabelText('Starting directory for Claude CLI')
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

    expect(saveServerSettingsPatchSpy).toHaveBeenCalledWith({
      codingCli: {
        providers: {
          claude: expect.objectContaining({ cwd: '/home/user/next' }),
        },
      },
    })
  })

  it('launches OpenCode terminal with confirmed directory', async () => {
    const { store } = renderPickerFlow({
      availableClis: { opencode: true },
      enabledProviders: ['opencode'],
      providerCwds: { opencode: { cwd: '/home/user/work' } },
    })

    fireEvent.click(screen.getByRole('button', { name: 'OpenCode' }))
    const picker = document.querySelector('[data-context="pane-picker"]')
    if (!picker) throw new Error('Pane picker not found')
    fireEvent.transitionEnd(picker)

    const input = screen.getByLabelText('Starting directory for OpenCode')
    fireEvent.change(input, { target: { value: '/home/user/next' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => {
      const content = (store.getState().panes.layouts['tab-1'] as Extract<PaneNode, { type: 'leaf' }>).content
      expect(content.kind).toBe('terminal')
      if (content.kind === 'terminal') {
        expect(content.mode).toBe('opencode')
        expect(content.initialCwd).toBe('/home/user/next')
      }
    })

    expect(saveServerSettingsPatchSpy).toHaveBeenCalledWith({
      codingCli: {
        providers: {
          opencode: expect.objectContaining({ cwd: '/home/user/next' }),
        },
      },
    })
  })

  it('enters path mode for quoted Windows drive input and requests directory completions', async () => {
    mockApiGet.mockImplementation(async (requestPath: string) => {
      if (requestPath.startsWith('/api/files/complete')) {
        return {
          suggestions: [{ path: String.raw`D:\users\words with spaces\alpha`, isDirectory: true }],
        }
      }
      return { directories: [] }
    })

    renderPickerFlow()

    const picker = document.querySelector('[data-context="pane-picker"]')
    if (!picker) throw new Error('Pane picker not found')
    fireEvent.keyDown(picker, { key: 'l' })
    fireEvent.transitionEnd(picker)

    const input = screen.getByLabelText('Starting directory for Claude CLI')
    fireEvent.change(input, { target: { value: String.raw`"D:\users\words with spaces\a"` } })

    await waitFor(() => {
      expect(mockApiGet).toHaveBeenCalledWith(
        `/api/files/complete?prefix=${encodeURIComponent(String.raw`"D:\users\words with spaces\a"`)}&dirs=true`
      )
    })

    await waitFor(() => {
      expect(screen.getByRole('option', { name: String.raw`D:\users\words with spaces\alpha` })).toBeInTheDocument()
    })
  })

  describe('tab-aware directory preference (e2e)', () => {
    it('pre-fills picker with tab-preferred directory instead of global default', async () => {
      mockApiGet.mockResolvedValue({
        directories: ['/code/global-default', '/code/other', '/code/tab-project'],
      })

      renderTabAwarePickerFlow()

      // Navigate to directory step: press 'l' for Claude on the picker pane
      const picker = document.querySelector('[data-context="pane-picker"]')
      if (!picker) throw new Error('Pane picker not found')
      fireEvent.keyDown(picker, { key: 'l' })
      fireEvent.transitionEnd(picker)

      // Input should pre-fill with tab-preferred directory, not global default
      const input = screen.getByLabelText('Starting directory for Claude CLI')
      expect(input).toHaveValue('/code/tab-project')
    })

    it('re-ranks candidates with tab directories boosted above API results', async () => {
      mockApiGet.mockResolvedValue({
        directories: ['/code/other', '/code/global-default', '/code/tab-project', '/code/extra'],
      })

      renderTabAwarePickerFlow()

      const picker = document.querySelector('[data-context="pane-picker"]')
      if (!picker) throw new Error('Pane picker not found')
      fireEvent.keyDown(picker, { key: 'l' })
      fireEvent.transitionEnd(picker)

      const input = screen.getByLabelText('Starting directory for Claude CLI')

      // Clear the input to exit path mode and show all fuzzy candidates
      fireEvent.change(input, { target: { value: '' } })

      // Wait for candidates to load and verify ranking:
      // tab dir first, then global default, then the rest
      await waitFor(() => {
        const options = screen.getAllByRole('option')
        expect(options.length).toBeGreaterThanOrEqual(4)
      })

      const options = screen.getAllByRole('option')
      expect(options.map(o => o.textContent)).toEqual([
        '/code/tab-project',
        '/code/global-default',
        '/code/other',
        '/code/extra',
      ])
    })

    it('launches terminal with tab-preferred cwd and persists the choice', async () => {
      mockApiGet.mockResolvedValue({
        directories: ['/code/global-default', '/code/tab-project'],
      })
      mockApiPost.mockResolvedValue({ valid: true, resolvedPath: '/code/tab-project' })
      mockApiPatch.mockResolvedValue({})

      const { store } = renderTabAwarePickerFlow()

      const picker = document.querySelector('[data-context="pane-picker"]')
      if (!picker) throw new Error('Pane picker not found')
      fireEvent.keyDown(picker, { key: 'l' })
      fireEvent.transitionEnd(picker)

      // Input is pre-filled with tab-preferred dir; just press Enter to confirm
      const input = screen.getByLabelText('Starting directory for Claude CLI')
      expect(input).toHaveValue('/code/tab-project')
      fireEvent.keyDown(input, { key: 'Enter' })

      // Verify the picker pane converts to a terminal with the tab-preferred cwd
      await waitFor(() => {
        const layout = store.getState().panes.layouts['tab-1']
        // Layout should still be a split - the picker pane was replaced
        expect(layout.type).toBe('split')
        if (layout.type === 'split') {
          const pickerChild = layout.children[1] as Extract<PaneNode, { type: 'leaf' }>
          expect(pickerChild.content.kind).toBe('terminal')
          if (pickerChild.content.kind === 'terminal') {
            expect(pickerChild.content.mode).toBe('claude')
            expect(pickerChild.content.initialCwd).toBe('/code/tab-project')
          }
        }
      })

      // Global default should be persisted
      expect(saveServerSettingsPatchSpy).toHaveBeenCalledWith({
        codingCli: {
          providers: {
            claude: expect.objectContaining({ cwd: '/code/tab-project' }),
          },
        },
      })
    })
  })
})
