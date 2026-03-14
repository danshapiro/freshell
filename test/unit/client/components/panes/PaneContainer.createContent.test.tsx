import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, fireEvent, cleanup, screen, waitFor } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import PaneContainer from '@/components/panes/PaneContainer'
import panesReducer from '@/store/panesSlice'
import tabsReducer from '@/store/tabsSlice'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import connectionReducer from '@/store/connectionSlice'
import terminalMetaReducer from '@/store/terminalMetaSlice'
import turnCompletionReducer from '@/store/turnCompletionSlice'
import extensionsReducer from '@/store/extensionsSlice'
import type { PanesState } from '@/store/panesSlice'
import type { PaneNode } from '@/store/paneTypes'
import type { ClientExtensionEntry } from '@shared/extension-types'
import {
  composeResolvedSettings,
  createDefaultServerSettings,
  mergeServerSettings,
  resolveLocalSettings,
  type ServerSettingsPatch,
} from '@shared/settings'

// Hoist mock functions so vi.mock can reference them
const { mockSend, mockTerminalView, saveServerSettingsPatchSpy } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  mockTerminalView: vi.fn(({ tabId, paneId }: { tabId: string; paneId: string }) => (
    <div data-testid={`terminal-${paneId}`}>Terminal for {tabId}/{paneId}</div>
  )),
  saveServerSettingsPatchSpy: vi.fn((patch: unknown) => ({
    type: 'settings/saveServerSettingsPatch',
    payload: patch,
  })),
}))

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({ send: mockSend }),
}))

vi.mock('@/lib/api', () => ({
  api: {
    get: vi.fn().mockResolvedValue({ directories: [] }),
    post: vi.fn().mockResolvedValue({ valid: true, resolvedPath: '/resolved/path' }),
    patch: vi.fn().mockResolvedValue({}),
  },
}))

vi.mock('@/store/settingsThunks', () => ({
  saveServerSettingsPatch: (patch: unknown) => saveServerSettingsPatchSpy(patch),
}))

vi.mock('lucide-react', () => ({
  X: ({ className }: { className?: string }) => <svg data-testid="x-icon" className={className} />,
  Plus: ({ className }: { className?: string }) => <svg data-testid="plus-icon" className={className} />,
  Globe: ({ className }: { className?: string }) => <svg data-testid="globe-icon" className={className} />,
  Terminal: ({ className }: { className?: string }) => <svg data-testid="terminal-icon" className={className} />,
  PanelLeftClose: ({ className }: { className?: string }) => <svg data-testid="panel-left-close-icon" className={className} />,
  PanelLeftOpen: ({ className }: { className?: string }) => <svg data-testid="panel-left-open-icon" className={className} />,
  Circle: ({ className }: { className?: string }) => <svg data-testid="circle-icon" className={className} />,
  FolderOpen: ({ className }: { className?: string }) => <svg data-testid="folder-open-icon" className={className} />,
  Eye: ({ className }: { className?: string }) => <svg data-testid="eye-icon" className={className} />,
  Code: ({ className }: { className?: string }) => <svg data-testid="code-icon" className={className} />,
  FileText: ({ className }: { className?: string }) => <svg data-testid="file-text-icon" className={className} />,
  LayoutGrid: ({ className }: { className?: string }) => <svg data-testid="layout-grid-icon" className={className} />,
  Maximize2: ({ className }: { className?: string }) => <svg data-testid="maximize-icon" className={className} />,
  Minimize2: ({ className }: { className?: string }) => <svg data-testid="minimize-icon" className={className} />,
  Pencil: ({ className }: { className?: string }) => <svg data-testid="pencil-icon" className={className} />,
  ChevronRight: ({ className }: { className?: string }) => <svg data-testid="chevron-right-icon" className={className} />,
  Loader2: ({ className }: { className?: string }) => <svg data-testid="loader-icon" className={className} />,
  Check: ({ className }: { className?: string }) => <svg data-testid="check-icon" className={className} />,
  ShieldAlert: ({ className }: { className?: string }) => <svg data-testid="shield-alert-icon" className={className} />,
  Send: ({ className }: { className?: string }) => <svg data-testid="send-icon" className={className} />,
  Square: ({ className }: { className?: string }) => <svg data-testid="square-icon" className={className} />,
  Search: ({ className }: { className?: string }) => <svg data-testid="search-icon" className={className} />,
}))

vi.mock('@/components/TerminalView', () => ({ default: mockTerminalView }))

vi.mock('@/components/panes/BrowserPane', () => ({
  default: ({ paneId, url }: { paneId: string; url: string }) => (
    <div data-testid={`browser-${paneId}`}>Browser: {url}</div>
  ),
}))

vi.mock('@monaco-editor/react', () => {
  const MockEditor = ({ value, onChange }: any) => {
    const React = require('react')
    return React.createElement('textarea', {
      'data-testid': 'monaco-mock',
      value,
      onChange: (e: any) => onChange?.(e.target.value),
    })
  }
  return { default: MockEditor, Editor: MockEditor }
})

function createPickerNode(paneId: string): PaneNode {
  return {
    type: 'leaf',
    id: paneId,
    content: { kind: 'picker' },
  }
}

const defaultServerSettings = createDefaultServerSettings({
  loggingDebug: defaultSettings.logging.debug,
})

function createSettingsState(settingsOverrides: ServerSettingsPatch = {}) {
  const serverSettings = mergeServerSettings(defaultServerSettings, settingsOverrides)
  const localSettings = resolveLocalSettings()

  return {
    serverSettings,
    localSettings,
    settings: composeResolvedSettings(serverSettings, localSettings),
    loaded: true,
    lastSavedAt: undefined,
  }
}

function createStore(
  initialPanesState: Partial<PanesState> = {},
  extensions: ClientExtensionEntry[] = [],
  settingsOverrides: ServerSettingsPatch = {},
  connectionOverrides: Record<string, unknown> = {},
) {
  return configureStore({
    reducer: {
      panes: panesReducer,
      tabs: tabsReducer,
      settings: settingsReducer,
      connection: connectionReducer,
      terminalMeta: terminalMetaReducer,
      turnCompletion: turnCompletionReducer,
      extensions: extensionsReducer,
    },
    preloadedState: {
      panes: {
        layouts: {},
        activePane: {},
        paneTitles: {},
        paneTitleSetByUser: {},
        renameRequestTabId: null,
        renameRequestPaneId: null,
        zoomedPane: {},
        ...initialPanesState,
      },
      tabs: {
        tabs: [{ id: 'tab-1', createRequestId: 'tab-1', title: 'Tab 1', mode: 'shell' as const, status: 'running' as const, createdAt: 1 }],
        activeTabId: 'tab-1',
      },
      connection: {
        status: 'disconnected',
        platform: null,
        availableClis: {},
        featureFlags: {},
        ...connectionOverrides,
      },
      settings: createSettingsState(settingsOverrides),
      terminalMeta: {
        byTerminalId: {},
      },
      extensions: {
        entries: extensions,
      },
    },
  })
}

function getPickerContainer() {
  const container = document.querySelector('[data-context="pane-picker"]')
  if (!container) throw new Error('Picker container not found')
  return container
}

describe('createContentForType with ext: prefix', () => {
  beforeEach(() => {
    mockSend.mockClear()
    mockTerminalView.mockClear()
    saveServerSettingsPatchSpy.mockClear()
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => {
      if (url === '/api/terminals') return { ok: true, text: async () => '[]' }
      if (url.startsWith('/api/files/complete')) return { ok: true, text: async () => '{"suggestions":[]}' }
      return { ok: false, text: async () => '{}' }
    }))
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('creates ExtensionPaneContent when ext:my-extension is selected', () => {
    const extension: ClientExtensionEntry = {
      name: 'my-extension',
      version: '1.0.0',
      label: 'My Extension',
      description: 'A test extension',
      category: 'client',
      url: '/index.html',
    }

    const node = createPickerNode('pane-1')
    const store = createStore(
      { layouts: { 'tab-1': node }, activePane: { 'tab-1': 'pane-1' } },
      [extension],
    )

    render(
      <Provider store={store}>
        <PaneContainer tabId="tab-1" node={node} />
      </Provider>,
    )

    // Click the extension option
    const extButton = document.querySelector('[aria-label="My Extension"]') as HTMLElement
    expect(extButton).not.toBeNull()
    fireEvent.click(extButton)

    // Complete the fade animation
    fireEvent.transitionEnd(getPickerContainer())

    // Verify the pane content was updated with extension content
    const state = store.getState().panes
    const paneContent = (state.layouts['tab-1'] as Extract<PaneNode, { type: 'leaf' }>).content
    expect(paneContent).toEqual({
      kind: 'extension',
      extensionName: 'my-extension',
      props: {},
    })
  })

  it('correctly slices the ext: prefix to extract the extension name', () => {
    const extension: ClientExtensionEntry = {
      name: 'dashboard-widget',
      version: '2.0.0',
      label: 'Dashboard Widget',
      description: 'Another extension',
      category: 'server',
      url: '/app',
      serverRunning: true,
      serverPort: 5000,
    }

    const node = createPickerNode('pane-1')
    const store = createStore(
      { layouts: { 'tab-1': node }, activePane: { 'tab-1': 'pane-1' } },
      [extension],
    )

    render(
      <Provider store={store}>
        <PaneContainer tabId="tab-1" node={node} />
      </Provider>,
    )

    const extButton = document.querySelector('[aria-label="Dashboard Widget"]') as HTMLElement
    expect(extButton).not.toBeNull()
    fireEvent.click(extButton)
    fireEvent.transitionEnd(getPickerContainer())

    const state = store.getState().panes
    const paneContent = (state.layouts['tab-1'] as Extract<PaneNode, { type: 'leaf' }>).content
    expect(paneContent.kind).toBe('extension')
    if (paneContent.kind === 'extension') {
      expect(paneContent.extensionName).toBe('dashboard-widget')
      expect(paneContent.props).toEqual({})
    }
  })

  it('does not include cwd or createRequestId in extension content', () => {
    const extension: ClientExtensionEntry = {
      name: 'simple-ext',
      version: '1.0.0',
      label: 'Simple Ext',
      description: 'Simple extension',
      category: 'client',
      url: '/app.html',
    }

    const node = createPickerNode('pane-1')
    const store = createStore(
      { layouts: { 'tab-1': node }, activePane: { 'tab-1': 'pane-1' } },
      [extension],
    )

    render(
      <Provider store={store}>
        <PaneContainer tabId="tab-1" node={node} />
      </Provider>,
    )

    const extButton = document.querySelector('[aria-label="Simple Ext"]') as HTMLElement
    fireEvent.click(extButton)
    fireEvent.transitionEnd(getPickerContainer())

    const state = store.getState().panes
    const paneContent = (state.layouts['tab-1'] as Extract<PaneNode, { type: 'leaf' }>).content
    // Extension content should only have kind, extensionName, and props
    expect(Object.keys(paneContent).sort()).toEqual(['extensionName', 'kind', 'props'])
  })

  it('creates agent chat content with default plugins from resolved settings', async () => {
    const node = createPickerNode('pane-1')
    const store = createStore(
      { layouts: { 'tab-1': node }, activePane: { 'tab-1': 'pane-1' } },
      [],
      {
        codingCli: {
          enabledProviders: ['claude'],
          providers: { claude: { cwd: '/workspace/default' } },
        },
        agentChat: {
          defaultPlugins: ['planner', 'sandbox'],
          providers: {
            freshclaude: {
              defaultModel: 'claude-sonnet-4-6',
              defaultPermissionMode: 'default',
              defaultEffort: 'medium',
            },
          },
        },
      },
      {
        status: 'ready',
        platform: 'linux',
        availableClis: { claude: true },
      },
    )

    expect(store.getState().settings.settings.agentChat.defaultPlugins).toEqual(['planner', 'sandbox'])

    render(
      <Provider store={store}>
        <PaneContainer tabId="tab-1" node={node} />
      </Provider>,
    )

    const container = getPickerContainer()
    fireEvent.keyDown(container, { key: 'a' })
    fireEvent.transitionEnd(container)

    const input = await screen.findByLabelText('Starting directory for Freshclaude')
    fireEvent.change(input, { target: { value: '/workspace/project' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => {
      const state = store.getState().panes
      const paneContent = (state.layouts['tab-1'] as Extract<PaneNode, { type: 'leaf' }>).content
      expect(paneContent.kind).toBe('agent-chat')
      if (paneContent.kind === 'agent-chat') {
        expect(paneContent.provider).toBe('freshclaude')
        expect(paneContent.plugins).toEqual(['planner', 'sandbox'])
        expect(paneContent.model).toBe('claude-sonnet-4-6')
        expect(paneContent.permissionMode).toBe('default')
        expect(paneContent.effort).toBe('medium')
      }
    })
  })
})
