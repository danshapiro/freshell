import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, waitFor, fireEvent } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import PaneContainer from '@/components/panes/PaneContainer'
import panesReducer from '@/store/panesSlice'
import tabsReducer from '@/store/tabsSlice'
import settingsReducer from '@/store/settingsSlice'
import connectionReducer from '@/store/connectionSlice'
import extensionsReducer from '@/store/extensionsSlice'
import terminalMetaReducer from '@/store/terminalMetaSlice'
import sessionsReducer from '@/store/sessionsSlice'
import freshAgentReducer from '@/store/freshAgentSlice'
import opencodeActivityReducer from '@/store/opencodeActivitySlice'
import turnCompletionReducer from '@/store/turnCompletionSlice'
import type { PaneNode } from '@/store/paneTypes'
import type { ClientExtensionEntry } from '@shared/extension-types'

// PickerWrapper only routes a CLI provider into the directory step when the
// provider exists in extensions.entries (resolveFreshAgentType /
// isCodingCliProviderName) — preload the minimal entries (shape copied from
// PaneContainer.test.tsx:27-39) or 'claude' falls through and throws.
const defaultCliExtensions: ClientExtensionEntry[] = [
  {
    name: 'claude', version: '1.0.0', label: 'Claude CLI', description: '', category: 'cli',
    picker: { shortcut: 'L' },
    cli: { supportsPermissionMode: true, supportsResume: true, resumeCommandTemplate: ['claude', '--resume', '{{sessionId}}'] },
  },
] as ClientExtensionEntry[]

const captured = vi.hoisted(() => ({
  browser: [] as any[],
  editor: [] as any[],
  picker: [] as any[],
  directory: [] as any[],
  extension: [] as any[],
  terminal: [] as any[],
  freshAgent: [] as any[],
}))

// Drives PickerWrapper from step 'type' into step 'directory' (the DirectoryPicker arm).
const wiringControl = vi.hoisted(() => ({ autoSelectProvider: null as string | null }))

vi.mock('@/components/panes/BrowserPane', () => ({
  default: (props: any) => { captured.browser.push(props); return null },
}))
vi.mock('@/components/panes/EditorPane', () => ({
  default: (props: any) => { captured.editor.push(props); return null },
}))
vi.mock('@/components/panes/PanePicker', () => {
  const React = require('react')
  return {
    default: (props: any) => {
      captured.picker.push(props)
      React.useEffect(() => {
        if (wiringControl.autoSelectProvider) props.onSelect?.(wiringControl.autoSelectProvider)
      }, [])
      return null
    },
  }
})
vi.mock('@/components/panes/DirectoryPicker', () => ({
  default: (props: any) => { captured.directory.push(props); return null },
}))
vi.mock('@/components/panes/ExtensionPane', () => ({
  default: (props: any) => { captured.extension.push(props); return null },
}))
vi.mock('@/components/TerminalView', () => ({
  default: (props: any) => { captured.terminal.push(props); return null },
}))
vi.mock('@/components/fresh-agent/FreshAgentView', () => ({
  default: (props: any) => { captured.freshAgent.push(props); return null },
  FreshAgentView: (props: any) => { captured.freshAgent.push(props); return null },
}))

function makeStore(panesState: any) {
  return configureStore({
    reducer: {
      panes: panesReducer,
      tabs: tabsReducer,
      settings: settingsReducer,
      connection: connectionReducer,
      extensions: extensionsReducer,
      terminalMeta: terminalMetaReducer,
      sessions: sessionsReducer,
      freshAgent: freshAgentReducer,
      opencodeActivity: opencodeActivityReducer,
      turnCompletion: turnCompletionReducer,
    },
    middleware: (getDefaultMiddleware) =>
      getDefaultMiddleware({
        // sessions.expandedProjects is a Set by slice design (same ignore as
        // PaneContainer.test.tsx / FreshAgentView.test.tsx createStore).
        serializableCheck: {
          ignoredPaths: ['sessions.expandedProjects'],
        },
      }),
    preloadedState: {
      tabs: {
        tabs: [{ id: 'tab-1', createRequestId: 'r1', title: 'T1', status: 'running', mode: 'shell', shell: 'system', createdAt: 1 }],
        activeTabId: 'tab-1',
        renameRequestTabId: null,
      },
      extensions: { entries: defaultCliExtensions },
      panes: {
        layouts: {},
        activePane: {},
        paneTitles: {},
        paneTitleSetByUser: {},
        renameRequestTabId: null,
        renameRequestPaneId: null,
        zoomedPane: {},
        refreshRequestsByPane: {},
        ...panesState,
      },
    } as any,
  })
}

const browserLeaf: PaneNode = {
  type: 'leaf',
  id: 'pane-b',
  content: { kind: 'browser', url: 'https://example.com', devToolsOpen: false, browserInstanceId: 'bi-1' },
} as any
const editorLeaf: PaneNode = {
  type: 'leaf',
  id: 'pane-e',
  content: { kind: 'editor', filePath: '/tmp/a.ts', language: 'typescript', readOnly: false, content: 'x', viewMode: 'source', wordWrap: true },
} as any
const pickerLeaf: PaneNode = { type: 'leaf', id: 'pane-k', content: { kind: 'picker' } } as any
const extensionLeaf: PaneNode = { type: 'leaf', id: 'pane-x', content: { kind: 'extension', extensionName: 'sample', props: {} } } as any
const terminalLeafFixed: PaneNode = { type: 'leaf', id: 'pane-t', content: { kind: 'terminal', mode: 'shell' } } as any
const freshAgentLeaf: PaneNode = { type: 'leaf', id: 'pane-f', content: { kind: 'fresh-agent', sessionType: 'freshcodex', provider: 'codex', createRequestId: 'req-w', status: 'idle' } } as any

function renderNode(node: PaneNode, opts: { hidden?: boolean; activePaneId?: string; panesState?: Record<string, unknown> } = {}) {
  const leafId = (function firstLeaf(n: PaneNode): string { return n.type === 'leaf' ? n.id : firstLeaf(n.children[0]) })(node)
  const store = makeStore({
    layouts: { 'tab-1': node },
    activePane: { 'tab-1': opts.activePaneId ?? leafId },
    ...(opts.panesState ?? {}),
  })
  const utils = render(
    <Provider store={store}>
      <PaneContainer tabId="tab-1" node={node} hidden={opts.hidden} />
    </Provider>,
  )
  return { store, ...utils }
}

describe('PaneContainer focusEligible wiring', () => {
  beforeEach(() => {
    captured.browser.length = captured.editor.length = captured.picker.length = captured.directory.length = captured.extension.length = captured.terminal.length = captured.freshAgent.length = 0
    wiringControl.autoSelectProvider = null
  })
  afterEach(() => cleanup())

  it('browser arm: eligible when visible + active pane', () => {
    renderNode(browserLeaf)
    expect(captured.browser[0].focusEligible).toBe(true)
  })

  it('browser arm: ineligible when the tab is hidden', () => {
    renderNode(browserLeaf, { hidden: true })
    expect(captured.browser[0].focusEligible).toBe(false)
  })

  it('browser arm: ineligible when another pane is active in the visible tab', () => {
    const terminalLeaf: PaneNode = { type: 'leaf', id: 'pane-t', content: { kind: 'terminal', mode: 'shell' } } as any
    const split: PaneNode = { type: 'split', id: 'split-1', direction: 'horizontal', sizes: [50, 50], children: [browserLeaf, terminalLeaf] }
    renderNode(split, { activePaneId: 'pane-t' })
    expect(captured.browser[0].focusEligible).toBe(false)
  })

  // EditorPane mounts through React.lazy (PaneContainer.tsx:72) — the capture
  // is asynchronous; synchronous reads can throw on an empty array even on a
  // GREEN tree.
  it('editor arm: eligible when visible + active pane', async () => {
    renderNode(editorLeaf)
    await waitFor(() => expect(captured.editor.length).toBeGreaterThan(0))
    expect(captured.editor[0].focusEligible).toBe(true)
  })

  it('editor arm: ineligible when the tab is hidden', async () => {
    renderNode(editorLeaf, { hidden: true })
    await waitFor(() => expect(captured.editor.length).toBeGreaterThan(0))
    expect(captured.editor[0].focusEligible).toBe(false)
  })

  it('picker arm: eligible when visible + active pane', () => {
    renderNode(pickerLeaf)
    expect(captured.picker[0].focusEligible).toBe(true)
  })

  it('picker arm: ineligible when the tab is hidden', () => {
    renderNode(pickerLeaf, { hidden: true })
    expect(captured.picker[0].focusEligible).toBe(false)
  })

  it('directory step: PickerWrapper forwards focusEligible=false into DirectoryPicker when hidden', async () => {
    // 'claude' reaches the directory step now that extensions.entries is
    // preloaded (see defaultCliExtensions above).
    wiringControl.autoSelectProvider = 'claude'
    try {
      renderNode(pickerLeaf, { hidden: true })
      await waitFor(() => expect(captured.directory.length).toBeGreaterThan(0))
      expect(captured.directory[0].focusEligible).toBe(false)
    } finally {
      wiringControl.autoSelectProvider = null
    }
  })

  // Pins the extension arm: dropping/misrouting the prop defaults to true and
  // silently disables inert + data-focus-locked protection.
  it('extension arm: eligible when visible + active pane', () => {
    renderNode(extensionLeaf)
    expect(captured.extension[0].focusEligible).toBe(true)
  })

  it('extension arm: ineligible when the tab is hidden', () => {
    renderNode(extensionLeaf, { hidden: true })
    expect(captured.extension[0].focusEligible).toBe(false)
  })

  it('extension arm: ineligible when another pane is active in the visible tab', () => {
    const terminalLeaf: PaneNode = { type: 'leaf', id: 'pane-t', content: { kind: 'terminal', mode: 'shell' } } as any
    const split: PaneNode = { type: 'split', id: 'split-1', direction: 'horizontal', sizes: [50, 50], children: [extensionLeaf, terminalLeaf] }
    renderNode(split, { activePaneId: 'pane-t' })
    expect(captured.extension[0].focusEligible).toBe(false)
  })

  // focusEpoch hand-off: PaneContainer reads the epoch map and forwards the
  // per-pane value into every content arm, so a same-target select re-runs
  // focus effects. A dropped/misrouted prop on any arm silently breaks it.
  it('wires focusEpoch from the panes store into every content arm', async () => {
    const panesState = { focusEpochByPaneId: { 'pane-b': 7, 'pane-x': 3, 'pane-k': 5 } }
    renderNode(browserLeaf, { panesState })
    expect(captured.browser[0].focusEpoch).toBe(7)
    cleanup()
    renderNode(extensionLeaf, { panesState })
    expect(captured.extension[0].focusEpoch).toBe(3)
    cleanup()
    renderNode(pickerLeaf, { panesState })
    expect(captured.picker[0].focusEpoch).toBe(5)
  })

  it('editor arm: forwards focusEpoch', async () => {
    renderNode(editorLeaf, { panesState: { focusEpochByPaneId: { 'pane-e': 11 } } })
    await waitFor(() => expect(captured.editor.length).toBeGreaterThan(0))
    expect(captured.editor[0].focusEpoch).toBe(11)
  })

  it('terminal arm: forwards focusEpoch', () => {
    renderNode(terminalLeafFixed, { panesState: { focusEpochByPaneId: { 'pane-t': 4 } } })
    expect(captured.terminal[0].focusEpoch).toBe(4)
  })

  it('fresh-agent arm: forwards focusEpoch', () => {
    renderNode(freshAgentLeaf, { panesState: { focusEpochByPaneId: { 'pane-f': 9 } } })
    expect(captured.freshAgent[0].focusEpoch).toBe(9)
  })

  it('directory step: forwards focusEpoch into DirectoryPicker', async () => {
    wiringControl.autoSelectProvider = 'claude'
    try {
      renderNode(pickerLeaf, { panesState: { focusEpochByPaneId: { 'pane-k': 5 } } })
      await waitFor(() => expect(captured.directory.length).toBeGreaterThan(0))
      expect(captured.directory[0].focusEpoch).toBe(5)
    } finally {
      wiringControl.autoSelectProvider = null
    }
  })

  // Pointer-versus-explicit separation: a mousedown into the pane (bubbling
  // from in-pane inputs) dispatches plain setActivePane — it must NEVER bump
  // the epoch, or focus effects would steal focus back from rename/search.
  it('pointer activation (Pane mousedown → handleFocus) must NOT bump the focus epoch', () => {
    const { container, store } = renderNode(browserLeaf, { panesState: { focusEpochByPaneId: {} } })
    fireEvent.mouseDown(container.querySelector('[data-pane-shell="true"]')!)
    expect(store.getState().panes.activePane['tab-1']).toBe('pane-b')
    expect(Object.keys(store.getState().panes.focusEpochByPaneId ?? {})).toHaveLength(0)
  })
})
