import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import { ApiError } from '@/lib/api'
import PaneContainer from '@/components/panes/PaneContainer'
import TabBar from '@/components/TabBar'
import sessionNamesReducer, { receiveSessionNames, sessionNamesIngestMiddleware } from '@/store/sessionNamesSlice'
import tabsReducer from '@/store/tabsSlice'
import panesReducer, {
  reconcileTerminalSessionRefByTerminalId,
  updatePaneTitleByTerminalId,
  updatePaneTitle,
} from '@/store/panesSlice'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import connectionReducer from '@/store/connectionSlice'
import extensionsReducer from '@/store/extensionsSlice'
import terminalMetaReducer from '@/store/terminalMetaSlice'
import sessionsReducer from '@/store/sessionsSlice'
import freshAgentReducer from '@/store/freshAgentSlice'
import turnCompletionReducer from '@/store/turnCompletionSlice'
import { sessionTitleMirrorMiddleware } from '@/store/sessionTitleMirror'
import { terminalInventoryTitleReplayMiddleware } from '@/lib/terminal-inventory-titles'
import {
  selectPaneDisplayName,
  selectTabDisplayName,
  selectSessionDisplayName,
  selectSessionRowRecord,
} from '@/store/selectors/sessionNameSelectors'
import { isUnifiedAgentMode, sessionNameRefKey, type SessionNameRecord, type SessionNameRef, type SessionNameUpdate } from '@shared/session-names'
import type { PaneContent, PaneNode } from '@/store/paneTypes'
import type { ClientExtensionEntry } from '@shared/extension-types'

const {
  mockSend,
  mockApiGet,
  mockApiPatch,
  wsMessageHandlers,
} = vi.hoisted(() => ({
  mockSend: vi.fn(),
  mockApiGet: vi.fn(),
  mockApiPatch: vi.fn(),
  wsMessageHandlers: new Set<(msg: unknown) => void>(),
}))

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    send: mockSend,
    onMessage: (handler: (msg: unknown) => void) => {
      wsMessageHandlers.add(handler)
      return () => { wsMessageHandlers.delete(handler) }
    },
    onReconnect: () => () => {},
    cancelCreate: vi.fn(),
  }),
}))

vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {
    readonly status: number
    readonly details?: unknown
    constructor(status: number, message: string, details?: unknown) {
      super(message)
      this.name = 'ApiError'
      this.status = status
      this.details = details
    }
  },
  // The conflict lane refreshes the rename capture through the naming
  // read, which rides the real retry wrapper; the mock keeps it a
  // passthrough (the fixtures never 429).
  with429Retry: async (attempt: () => Promise<unknown>) => attempt(),
  api: {
    get: (path: string, options?: unknown) => mockApiGet(path, options),
    patch: (path: string, body: unknown, options?: unknown) => mockApiPatch(path, body, options),
    post: vi.fn(),
  },
}))

vi.mock('@/components/TerminalView', () => ({
  default: ({ paneId }: { paneId: string }) => <div data-testid={`terminal-${paneId}`}>Terminal</div>,
}))

vi.mock('@/components/fresh-agent/FreshAgentView', () => ({
  default: ({ paneId }: { paneId: string }) => <div data-testid={`fresh-${paneId}`}>Agent</div>,
}))

const claudeExtension: ClientExtensionEntry = {
  name: 'claude', version: '1.0.0', label: 'Claude CLI', description: '', category: 'cli',
  picker: { shortcut: 'L' },
  cli: { supportsPermissionMode: true, supportsResume: true, resumeCommandTemplate: ['claude', '--resume', '{{sessionId}}'] },
}

const SESSION_ID = '550e8400-e29b-41d4-a716-446655440000'
const claudeSessionRef = { kind: 'session' as const, provider: 'claude' as const, sessionId: SESSION_ID }

function record(name: string, revision: number, source: SessionNameRecord['source'] = 'freshell_ai'): SessionNameRecord {
  return { ref: claudeSessionRef, name, source, revision }
}

function updateOf(rec: SessionNameRecord, documentGeneration: number, extra: Partial<SessionNameUpdate> = {}): SessionNameUpdate {
  return { record: rec, documentGeneration, redirects: [], changed: true, ...extra }
}

function claudeLeafContent(extraContent: Record<string, unknown> = {}): PaneContent {
  return {
    kind: 'terminal',
    terminalId: 'term-1',
    createRequestId: 'cr-1',
    status: 'running',
    mode: 'claude',
    sessionRef: { provider: 'claude', sessionId: SESSION_ID },
    ...extraContent,
  } as PaneContent
}

function scopedPaneStore(content: PaneContent = claudeLeafContent()) {
  const layout: PaneNode = { type: 'leaf', id: 'pane-1', content }
  const store = configureStore({
    reducer: {
      sessionNames: sessionNamesReducer,
      tabs: tabsReducer,
      panes: panesReducer,
      settings: settingsReducer,
      connection: connectionReducer,
      extensions: extensionsReducer,
      terminalMeta: terminalMetaReducer,
      sessions: sessionsReducer,
      freshAgent: freshAgentReducer,
      turnCompletion: turnCompletionReducer,
    },
    middleware: (getDefault) => getDefault({ serializableCheck: { ignoredPaths: ['sessions.expandedProjects'] } })
      .concat(sessionNamesIngestMiddleware, sessionTitleMirrorMiddleware, terminalInventoryTitleReplayMiddleware),
    preloadedState: {
      tabs: {
        tabs: [{
          id: 'tab-1',
          title: 'old sticky title',
          createRequestId: 'tab-1',
          mode: 'claude',
          status: 'running',
          createdAt: Date.now(),
          titleSetByUser: true,
          sessionRef: { provider: 'claude', sessionId: SESSION_ID },
          nameSource: { kind: 'session', paneId: 'pane-1' },
        }],
        activeTabId: 'tab-1',
        renameRequestTabId: null,
      },
      panes: {
        layouts: { 'tab-1': layout },
        activePane: { 'tab-1': 'pane-1' },
        paneTitles: { 'tab-1': { 'pane-1': 'old sticky label' } },
        paneTitleSetByUser: { 'tab-1': { 'pane-1': true } },
        renameRequestTabId: null,
        renameRequestPaneId: null,
        zoomedPane: {},
        refreshRequestsByPane: {},
      },
      settings: { settings: defaultSettings, loaded: true },
      connection: { status: 'ready', platform: 'linux', availableClis: {}, featureFlags: { aiEnabled: true } },
      extensions: { entries: [claudeExtension] },
      terminalMeta: { byTerminalId: {} },
      sessions: { projects: [], expandedProjects: {}, loading: false, error: null },
      freshAgent: { pendingCreates: {}, sessions: {}, pendingCreateFailures: {}, availableModels: [] },
      turnCompletion: { seq: 0, pendingEvents: [], attentionByTab: {}, attentionByPane: {} },
    },
  })
  return { store, layout }
}

/** Deferred PATCH queue: the test resolves/rejects each rename request. */
type PatchDeferred = { path: string; body: any; resolve: (value: unknown) => void; reject: (error: unknown) => void }
let patchDeferreds: PatchDeferred[] = []

function mirrorListsPane() {
  mockApiGet.mockImplementation((path: string) => {
    if (typeof path === 'string' && path.startsWith('/api/panes?tabId=')) {
      return Promise.resolve({ data: { panes: [{ id: 'pane-1' }] } })
    }
    return Promise.resolve({})
  })
}

function startPaneRename() {
  const header = document.querySelector('[data-context="pane-header"]') as HTMLElement | null
  expect(header).toBeTruthy()
  fireEvent.doubleClick(header as HTMLElement)
  const input = screen.getByLabelText('Rename pane')
  expect(input).toBeTruthy()
  return input as HTMLInputElement
}

function tabElement(renderResult: ReturnType<typeof render>) {
  const el = renderResult.container.querySelector('[data-tab-id="tab-1"]') as HTMLElement | null
  expect(el).toBeTruthy()
  return el as HTMLElement
}

async function startTabRename(renderResult: ReturnType<typeof render>) {
  const tab = tabElement(renderResult)
  fireEvent.doubleClick(tab)
  // The rename editor remounts the tab content (the tooltip wrapper drops),
  // so re-query from the container rather than the captured node.
  const input = renderResult.container.querySelector('[data-tab-id="tab-1"] input') as HTMLInputElement | null
  expect(input).toBeTruthy()
  return input as HTMLInputElement
}

function renderScoped(store: ReturnType<typeof scopedPaneStore>['store'], layout: PaneNode) {
  return render(
    <Provider store={store}>
      <>
        <TabBar />
        <PaneContainer tabId="tab-1" node={layout} />
      </>
    </Provider>,
  )
}

/** The server's 409 body: the other writer's accepted update rides along. */
function revisionConflictError(winner: SessionNameUpdate): Error {
  // The REAL wire shape since the conflict-lane repair: the scoped routes
  // answer the accepted CURRENT record in the 409 body, and the client's
  // `toRenameError` reads it from the ApiError's `details` (the parsed
  // response body) — the legacy raw-Error-with-`data` twin is exactly the
  // masking bug that repair fixed, so this fixture must be an ApiError
  // carrying `details` like production.
  return new ApiError(409, 'another rename won', {
    error: 'NAME_REVISION_CONFLICT',
    message: 'another rename won',
    sessionName: winner,
    nameRef: claudeSessionRef,
  })
}

describe('unified agent rename — one shared session name', () => {
  beforeEach(() => {
    localStorage.clear()
    mockApiGet.mockReset()
    mockApiPatch.mockReset()
    mockSend.mockReset()
    patchDeferreds = []
    mirrorListsPane()
    mockApiPatch.mockImplementation((path: string, body: unknown) => new Promise((resolve, reject) => {
      patchDeferreds.push({ path, body, resolve, reject })
    }))
  })

  afterEach(() => cleanup())

  it('renames a scoped pane through the canonical target and every surface shows the accepted name', async () => {
    const { store, layout } = scopedPaneStore()
    act(() => {
      store.dispatch(receiveSessionNames([updateOf(record('First AI name', 4), 40)]))
    })
    const renderResult = renderScoped(store, layout)

    const input = startPaneRename()
    expect((input as HTMLInputElement).value).toBe('First AI name')
    fireEvent.change(input, { target: { value: 'My chosen name' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => { expect(patchDeferreds.length).toBe(1) })
    expect(patchDeferreds[0].path).toBe('/api/panes/pane-1')
    expect(patchDeferreds[0].body).toEqual({
      name: 'My chosen name',
      nameIntent: 'user',
      ifRevision: 4,
      expectedNameRef: claudeSessionRef,
    })

    const accepted = updateOf(record('My chosen name', 5, 'manual'), 41)
    await act(async () => {
      patchDeferreds[0].resolve({ data: { paneId: 'pane-1', tabId: 'tab-1', sessionName: accepted } })
    })
    // The push arrives AFTER the response (reversed order) — idempotent.
    act(() => {
      store.dispatch(receiveSessionNames([accepted]))
    })

    const state = store.getState()
    expect(selectPaneDisplayName(state, 'tab-1', 'pane-1')).toBe('My chosen name')
    expect(selectTabDisplayName(state, 'tab-1')).toBe('My chosen name')
    await waitFor(() => {
      expect(screen.getAllByText('My chosen name').length).toBeGreaterThanOrEqual(2)
    })
    // No local alias was minted: the legacy sticky flags remain untouched and
    // only the canonical cache drives the scoped display.
    expect(state.panes.paneTitleSetByUser['tab-1']['pane-1']).toBe(true)
    expect(state.panes.paneTitles['tab-1']['pane-1']).toBe('old sticky label')
    expect(state.tabs.tabs[0].title).toBe('old sticky title')
  })

  it('a stale push delivered before the rename response never wins over the newer accepted name', async () => {
    const { store, layout } = scopedPaneStore()
    act(() => {
      store.dispatch(receiveSessionNames([updateOf(record('Current name', 6), 50)]))
    })
    renderScoped(store, layout)

    const input = startPaneRename()
    fireEvent.change(input, { target: { value: 'User wins' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => { expect(patchDeferreds.length).toBe(1) })

    // A LATE, STALE automatic push (lower revision) arrives before the response.
    act(() => {
      store.dispatch(receiveSessionNames([updateOf(record('Stale pipeline name', 3), 51)]))
    })

    const accepted = updateOf(record('User wins', 7, 'manual'), 52)
    await act(async () => {
      patchDeferreds[0].resolve({ data: { paneId: 'pane-1', tabId: 'tab-1', sessionName: accepted } })
    })

    expect(selectPaneDisplayName(store.getState(), 'tab-1', 'pane-1')).toBe('User wins')
    expect(selectTabDisplayName(store.getState(), 'tab-1')).toBe('User wins')
    expect(screen.queryByText('Stale pipeline name')).not.toBeInTheDocument()
  })

  it('shows the conflict and converges on the other browser\'s accepted name from the push', async () => {
    const { store, layout } = scopedPaneStore()
    act(() => {
      store.dispatch(receiveSessionNames([updateOf(record('My edit base', 8), 60)]))
    })
    renderScoped(store, layout)

    const input = startPaneRename()
    fireEvent.change(input, { target: { value: 'My losing rename' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => { expect(patchDeferreds.length).toBe(1) })
    const winner = updateOf(record('Other browser name', 9, 'manual'), 61)
    await act(async () => {
      patchDeferreds[0].reject(revisionConflictError(winner))
    })

    await waitFor(() => {
      expect(screen.getByText(/another rename won/i)).toBeVisible()
    })
    // The server push then delivers the winner — every surface converges.
    act(() => {
      store.dispatch(receiveSessionNames([winner]))
    })
    expect(selectPaneDisplayName(store.getState(), 'tab-1', 'pane-1')).toBe('Other browser name')
    await waitFor(() => {
      expect(screen.getByText('Other browser name')).toBeVisible()
    })
  })

  it('refreshes the pane rename capture after a conflict so a resubmit from the still-open editor succeeds', async () => {
    const { store, layout } = scopedPaneStore()
    act(() => {
      store.dispatch(receiveSessionNames([updateOf(record('Conflict base', 8), 60)]))
    })
    renderScoped(store, layout)

    const input = startPaneRename()
    fireEvent.change(input, { target: { value: 'My losing rename' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => { expect(patchDeferreds.length).toBe(1) })
    const winner = updateOf(record('Other browser name', 9, 'manual'), 61)
    await act(async () => {
      patchDeferreds[0].reject(revisionConflictError(winner))
    })

    await waitFor(() => {
      expect(screen.getByText(/another rename won/i)).toBeVisible()
    })
    // The still-open editor is seeded with the accepted text…
    await waitFor(() => {
      expect((screen.getByLabelText('Rename pane') as HTMLInputElement).value).toBe('Other browser name')
    })

    // …and a resubmit carries the ACCEPTED record's new revision, so it can
    // actually succeed (the stale edit-start revision would 409 forever).
    const retryInput = screen.getByLabelText('Rename pane')
    retryInput.focus()
    fireEvent.change(retryInput, { target: { value: 'Retry after conflict' } })
    fireEvent.keyDown(retryInput, { key: 'Enter' })

    await waitFor(() => { expect(patchDeferreds.length).toBe(2) })
    expect(patchDeferreds[1].path).toBe('/api/panes/pane-1')
    expect(patchDeferreds[1].body).toEqual({
      name: 'Retry after conflict',
      nameIntent: 'user',
      ifRevision: 9,
      expectedNameRef: claudeSessionRef,
    })

    const accepted = updateOf(record('Retry after conflict', 10, 'manual'), 62)
    await act(async () => {
      patchDeferreds[1].resolve({ data: { paneId: 'pane-1', tabId: 'tab-1', sessionName: accepted } })
    })

    expect(selectPaneDisplayName(store.getState(), 'tab-1', 'pane-1')).toBe('Retry after conflict')
    expect(selectTabDisplayName(store.getState(), 'tab-1')).toBe('Retry after conflict')
    await waitFor(() => {
      expect(screen.getAllByText('Retry after conflict').length).toBeGreaterThanOrEqual(2)
    })
  })

  it('a rename captured before a conversation switch refuses to retitle the new conversation', async () => {
    const { store, layout } = scopedPaneStore()
    act(() => {
      store.dispatch(receiveSessionNames([updateOf(record('Old conversation', 4), 70)]))
    })
    renderScoped(store, layout)

    const input = startPaneRename()
    fireEvent.change(input, { target: { value: 'Rename for old conversation' } })

    // The pane switches conversations BEFORE the commit (server rebind).
    act(() => {
      store.dispatch(reconcileTerminalSessionRefByTerminalId({
        terminalId: 'term-1',
        sessionRef: { provider: 'claude', sessionId: 'second-session-id' },
      }))
    })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => { expect(patchDeferreds.length).toBe(1) })
    // The editor captured the OLD conversation's target at edit start.
    expect((patchDeferreds[0].body as { expectedNameRef: SessionNameRef }).expectedNameRef).toEqual(claudeSessionRef)

    await act(async () => {
      const error = new Error('the pane\'s naming binding changed since the edit started') as Error & { status: number; data: unknown }
      error.status = 409
      error.data = {
        error: 'NAME_TARGET_MOVED',
        message: 'the pane\'s naming binding changed since the edit started',
        nameRef: { kind: 'session', provider: 'claude', sessionId: 'second-session-id' },
      }
      patchDeferreds[0].reject(error)
    })

    await waitFor(() => {
      expect(screen.getByText(/binding changed/i)).toBeVisible()
    })
    // The new conversation was never renamed.
    expect(store.getState().sessionNames.records[sessionNameRefKey({ kind: 'session', provider: 'claude', sessionId: 'second-session-id' })]).toBeUndefined()
  })

  it('a session-owned tab rename targets the stable source pane\'s session, not the tab label', async () => {
    const { store, layout } = scopedPaneStore()
    act(() => {
      store.dispatch(receiveSessionNames([updateOf(record('Tab source name', 2), 80)]))
    })
    const renderResult = renderScoped(store, layout)

    const input = await startTabRename(renderResult)
    fireEvent.change(input, { target: { value: 'Renamed from tab' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => { expect(patchDeferreds.length).toBe(1) })
    expect(patchDeferreds[0].path).toBe('/api/panes/pane-1')
    expect(patchDeferreds[0].body).toEqual({
      name: 'Renamed from tab',
      nameIntent: 'user',
      ifRevision: 2,
      expectedNameRef: claudeSessionRef,
    })

    const accepted = updateOf(record('Renamed from tab', 3, 'manual'), 81)
    await act(async () => {
      patchDeferreds[0].resolve({ data: { paneId: 'pane-1', tabId: 'tab-1', sessionName: accepted } })
    })

    const state = store.getState()
    expect(selectTabDisplayName(state, 'tab-1')).toBe('Renamed from tab')
    // The tab keeps NO independently stored name from this flow: the write
    // went to the canonical session, and titleSetByUser was not re-armed.
    expect(state.panes.paneTitles['tab-1']['pane-1']).toBe('old sticky label')
    await waitFor(() => {
      expect(screen.getAllByText('Renamed from tab').length).toBeGreaterThanOrEqual(2)
    })
  })

  it('refreshes the tab rename capture after a conflict so a resubmit from the still-open editor succeeds', async () => {
    const { store, layout } = scopedPaneStore()
    act(() => {
      store.dispatch(receiveSessionNames([updateOf(record('Tab conflict base', 2), 80)]))
    })
    const renderResult = renderScoped(store, layout)

    const input = await startTabRename(renderResult)
    fireEvent.change(input, { target: { value: 'Tab losing rename' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => { expect(patchDeferreds.length).toBe(1) })
    const winner = updateOf(record('Other tab name', 3, 'manual'), 81)
    await act(async () => {
      patchDeferreds[0].reject(revisionConflictError(winner))
    })

    await waitFor(() => {
      expect(screen.getByText(/another rename won/i)).toBeVisible()
    })
    // The still-open tab editor is seeded with the accepted text…
    const editor = renderResult.container.querySelector('[data-tab-id="tab-1"] input') as HTMLInputElement | null
    expect(editor).toBeTruthy()
    await waitFor(() => {
      expect((editor as HTMLInputElement).value).toBe('Other tab name')
    })

    // …and a resubmit carries the ACCEPTED record's new revision.
    const retryEditor = editor as HTMLInputElement
    retryEditor.focus()
    fireEvent.change(retryEditor, { target: { value: 'Tab retry' } })
    fireEvent.keyDown(retryEditor, { key: 'Enter' })

    await waitFor(() => { expect(patchDeferreds.length).toBe(2) })
    expect(patchDeferreds[1].path).toBe('/api/panes/pane-1')
    expect(patchDeferreds[1].body).toEqual({
      name: 'Tab retry',
      nameIntent: 'user',
      ifRevision: 3,
      expectedNameRef: claudeSessionRef,
    })

    const accepted = updateOf(record('Tab retry', 4, 'manual'), 82)
    await act(async () => {
      patchDeferreds[1].resolve({ data: { paneId: 'pane-1', tabId: 'tab-1', sessionName: accepted } })
    })

    expect(selectTabDisplayName(store.getState(), 'tab-1')).toBe('Tab retry')
    await waitFor(() => {
      expect(screen.getAllByText('Tab retry').length).toBeGreaterThanOrEqual(1)
    })
  })

  it('old pane/tab sticky flags and terminal inventory strings cannot override a newer canonical name', async () => {
    const { store, layout } = scopedPaneStore()
    act(() => {
      store.dispatch(receiveSessionNames([updateOf(record('Canonical winner', 5), 90)]))
    })
    renderScoped(store, layout)

    // The legacy cascade paths fire (a terminal title push and a plain pane
    // title write). For a scoped pane they must be excluded.
    act(() => {
      store.dispatch(updatePaneTitleByTerminalId({ terminalId: 'term-1', title: 'Inventory string', setByUser: false }))
    })
    act(() => {
      store.dispatch(updatePaneTitle({ tabId: 'tab-1', paneId: 'pane-1', title: 'Directory mirror title', setByUser: false }))
    })

    const state = store.getState()
    expect(selectPaneDisplayName(state, 'tab-1', 'pane-1')).toBe('Canonical winner')
    expect(selectTabDisplayName(state, 'tab-1')).toBe('Canonical winner')
    expect(screen.getAllByText('Canonical winner').length).toBeGreaterThanOrEqual(2)
    expect(screen.queryByText('old sticky label')).not.toBeInTheDocument()
    expect(screen.queryByText('Inventory string')).not.toBeInTheDocument()
  })

  it('a status-only nativeSync update never retitles, and the pane shows a nonblocking sync status', async () => {
    const { store, layout } = scopedPaneStore()
    act(() => {
      store.dispatch(receiveSessionNames([updateOf(record('Saved name', 4), 100)]))
    })
    renderScoped(store, layout)

    const input = startPaneRename()
    fireEvent.change(input, { target: { value: 'Fresh manual name' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => { expect(patchDeferreds.length).toBe(1) })
    const accepted = updateOf(record('Fresh manual name', 5, 'manual'), 101, {
      nativeSync: { status: 'unsynced', desiredRevision: 5, locationRevision: 1, reason: 'provider writeback timed out' },
    })
    await act(async () => {
      patchDeferreds[0].resolve({ data: { paneId: 'pane-1', tabId: 'tab-1', sessionName: accepted } })
    })

    await waitFor(() => {
      expect(screen.getByText(/provider writeback timed out/i)).toBeVisible()
    })
    expect(screen.getAllByText('Fresh manual name').length).toBeGreaterThanOrEqual(1)

    // A status-only update (same record revision, changed:false) moves the
    // sync state without touching the name.
    act(() => {
      store.dispatch(receiveSessionNames([updateOf(record('Fresh manual name', 5, 'manual'), 102, {
        changed: false,
        nativeSync: { status: 'pending', desiredRevision: 5, locationRevision: 1 },
      })]))
    })
    expect(selectPaneDisplayName(store.getState(), 'tab-1', 'pane-1')).toBe('Fresh manual name')
    await waitFor(() => {
      expect(screen.getByText(/native sync: pending/i)).toBeVisible()
    })
  })

  it('a shell pane keeps the legacy local rename (non-agent non-regression)', async () => {
    const shellContent: PaneContent = {
      kind: 'terminal', terminalId: 'term-1', createRequestId: 'cr-1', status: 'running', mode: 'shell',
    } as PaneContent
    const { store, layout } = scopedPaneStore(shellContent)
    renderScoped(store, layout)

    const input = startPaneRename()
    fireEvent.change(input, { target: { value: 'My shell label' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => { expect(patchDeferreds.length).toBe(1) })
    // The legacy path PATCHes the plain pane name with no naming intent.
    expect(patchDeferreds[0].body).toEqual({ name: 'My shell label' })
    await act(async () => {
      patchDeferreds[0].resolve({ data: { paneId: 'pane-1', tabId: 'tab-1' } })
    })
    const state = store.getState()
    expect(state.panes.paneTitles['tab-1']['pane-1']).toBe('My shell label')
    expect(selectPaneDisplayName(state, 'tab-1', 'pane-1')).toBe('My shell label')
  })

  it('covers all seven scoped modes through the real selectors, excluding kilroy and shells', () => {
    const { store } = scopedPaneStore()
    act(() => {
      store.dispatch(receiveSessionNames([
        updateOf({ ref: { kind: 'session', provider: 'claude', sessionId: 'six-claude' }, name: 'Claude CLI name', source: 'freshell_ai', revision: 1 }, 1),
        updateOf({ ref: { kind: 'session', provider: 'codex', sessionId: 'six-codex' }, name: 'Codex CLI name', source: 'freshell_ai', revision: 1 }, 1),
        updateOf({ ref: { kind: 'session', provider: 'opencode', sessionId: 'six-opencode' }, name: 'OpenCode CLI name', source: 'freshell_ai', revision: 1 }, 1),
        updateOf({ ref: { kind: 'session', provider: 'antigravity', sessionId: 'six-antigravity' }, name: 'Antigravity CLI name', source: 'freshell_ai', revision: 1 }, 1),
        updateOf({ ref: { kind: 'pending', id: 'fresh-handle' }, name: 'Fresh handle name', source: 'directory', revision: 1 }, 1),
      ]))
    })

    const cases: Array<{ kind: 'terminal' | 'fresh-agent'; mode?: string; sessionType?: string; expected: string }> = [
      { kind: 'terminal', mode: 'claude', expected: 'Claude CLI name' },
      { kind: 'terminal', mode: 'codex', expected: 'Codex CLI name' },
      { kind: 'terminal', mode: 'opencode', expected: 'OpenCode CLI name' },
      { kind: 'terminal', mode: 'antigravity', expected: 'Antigravity CLI name' },
      { kind: 'fresh-agent', sessionType: 'freshclaude', expected: 'Claude CLI name' },
      { kind: 'fresh-agent', sessionType: 'freshcodex', expected: 'Codex CLI name' },
      { kind: 'fresh-agent', sessionType: 'freshopencode', expected: 'OpenCode CLI name' },
    ]
    for (const [index, testCase] of cases.entries()) {
      const provider = testCase.mode ?? testCase.sessionType!.replace('fresh', '')
      const content = testCase.kind === 'terminal'
        ? {
          kind: 'terminal',
          terminalId: `t-${index}`,
          createRequestId: `cr-${index}`,
          status: 'running',
          mode: testCase.mode!,
          sessionRef: { provider: testCase.mode, sessionId: `six-${testCase.mode}` },
        }
        : {
          kind: 'fresh-agent',
          sessionType: testCase.sessionType!,
          provider,
          sessionId: `six-${provider}`,
          sessionRef: { provider, sessionId: `six-${provider}` },
          createRequestId: `cr-${index}`,
          status: 'idle',
        }
      const tabId = `tab-six-${index}`
      act(() => {
        store.dispatch({ type: 'tabs/addTab', payload: { id: tabId, title: 'derived', mode: 'shell', status: 'running', createdAt: 1, createRequestId: tabId } })
        store.dispatch({ type: 'panes/initLayout', payload: { tabId, paneId: `pane-six-${index}`, content } })
      })
      const state = store.getState()
      expect(selectPaneDisplayName(state, tabId, `pane-six-${index}`), `${testCase.kind}/${testCase.mode ?? testCase.sessionType}`).toBe(testCase.expected)
      expect(selectTabDisplayName(state, tabId)).toBe(testCase.expected)
    }

    // A pending-handle pane (pre-durable) resolves its record through the
    // pending naming handle. Pane-content normalization (panesSlice) does
    // not carry naming fields until Task 6's lifecycle plumbing, so the
    // selector is exercised against a hand-built layout state here.
    const pendingPaneState = {
      tabs: { tabs: [{ id: 'tab-p', title: 'derived', createRequestId: 'tab-p', mode: 'shell', status: 'running', createdAt: 1 }] },
      panes: {
        layouts: {
          'tab-p': {
            type: 'leaf' as const,
            id: 'pane-pending',
            content: {
              kind: 'fresh-agent', sessionType: 'freshclaude', provider: 'claude',
              createRequestId: 'cr-p', status: 'creating', namingHandle: 'fresh-handle',
            },
          },
        },
        paneTitles: {},
        paneTitleSetByUser: {},
      },
      sessionNames: store.getState().sessionNames,
      extensions: { entries: [] },
    } as never
    expect(selectPaneDisplayName(pendingPaneState, 'tab-p', 'pane-pending')).toBe('Fresh handle name')

    // Exclusion: kilroy (claude runtime, kilroy sessionType) stays on the
    // legacy derivation.
    act(() => {
      store.dispatch({ type: 'tabs/addTab', payload: { id: 'tab-k', title: 'derived', mode: 'shell', status: 'running', createdAt: 1, createRequestId: 'tab-k' } })
      store.dispatch({
        type: 'panes/initLayout',
        payload: {
          tabId: 'tab-k', paneId: 'pane-k',
          content: { kind: 'fresh-agent', sessionType: 'kilroy', provider: 'claude', createRequestId: 'cr-k', status: 'idle' },
        },
      })
    })
    expect(isUnifiedAgentMode('claude', 'kilroy')).toBe(false)
    expect(selectPaneDisplayName(store.getState(), 'tab-k', 'pane-k')).toBe('Kilroy')

    // Session display name: canonical record by ref, fallback otherwise.
    expect(selectSessionDisplayName(store.getState(), { kind: 'session', provider: 'claude', sessionId: 'six-claude' }, 'fallback')).toBe('Claude CLI name')
    expect(selectSessionDisplayName(store.getState(), { kind: 'session', provider: 'gemini', sessionId: 'nope' }, 'Gemini fallback')).toBe('Gemini fallback')

    // The durable-key row projection (sidebar/history rows, T5-N5): the
    // antigravity saved name resolves — the projection no longer drops the
    // provider — while an out-of-scope provider row still resolves nothing.
    const cache = store.getState().sessionNames
    expect(selectSessionRowRecord(cache, 'antigravity', 'six-antigravity')?.name).toBe('Antigravity CLI name')
    expect(selectSessionRowRecord(cache, 'gemini', 'nope')).toBeUndefined()
    expect(selectSessionRowRecord(cache, 'kimi', 'nope')).toBeUndefined()
  })
})
