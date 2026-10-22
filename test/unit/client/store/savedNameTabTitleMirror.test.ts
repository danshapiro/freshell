import { afterEach, describe, it, expect, vi } from 'vitest'
import { configureStore, type Middleware } from '@reduxjs/toolkit'
import tabsReducer, { addTab, mirrorSessionTabTitles, setActiveTab } from '@/store/tabsSlice'
import panesReducer, {
  closePane,
  initLayout,
  reconcileTerminalSessionRefByTerminalId,
  resizePanes,
  setActivePane,
  splitPane,
  toggleZoom,
  updatePaneContent,
} from '@/store/panesSlice'
import sessionNamesReducer, { receiveSessionNames } from '@/store/sessionNamesSlice'
import settingsReducer, { updateSettingsLocal } from '@/store/settingsSlice'
import connectionReducer from '@/store/connectionSlice'
import tabRegistryReducer from '@/store/tabRegistrySlice'
import extensionsReducer from '@/store/extensionsSlice'
import { sessionNameLifecycleMiddleware } from '@/store/sessionNameLifecycleMiddleware'
import { savedNameTabTitleMirrorMiddleware } from '@/store/savedNameTabTitleMirror'
import { selectPaneDisplayName, selectTabDisplayName } from '@/store/selectors/sessionNameSelectors'
import { selectLiveLocalTabRecords } from '@/store/selectors/tabsRegistrySelectors'
import type { PaneContent, PaneNode } from '@/store/paneTypes'
import type { Tab } from '@/store/types'
import { sessionNameRefKey, type SessionNameRef, type SessionNameUpdate } from '@shared/session-names'
import type { RootState } from '@/store/store'

// Name reliability (plan Task 7, D2): a session-owned tab's stored title is a
// display MIRROR of its saved name. It is written only from a cached saved
// record (never a fallback label), without bumping updatedAt and without the
// user-rename freeze flag, so reloads, the server layout mirror and the tabs
// registry carry the right name even before names load.

function buildStore(options: { preloadedState?: Record<string, unknown>; spy?: Middleware } = {}) {
  return configureStore({
    reducer: {
      tabs: tabsReducer,
      panes: panesReducer,
      sessionNames: sessionNamesReducer,
      settings: settingsReducer,
      connection: connectionReducer,
      tabRegistry: tabRegistryReducer,
      extensions: extensionsReducer,
    },
    // The production order: the mirror sits outside the lifecycle
    // coordinator, so it reads already-reconciled naming-source pointers.
    middleware: (getDefault) => getDefault().concat(
      ...(options.spy ? [options.spy] : []),
      savedNameTabTitleMirrorMiddleware,
      sessionNameLifecycleMiddleware,
    ),
    ...(options.preloadedState ? { preloadedState: options.preloadedState as never } : {}),
  })
}

type Store = ReturnType<typeof buildStore>

function claudeTerminal(extra: Record<string, unknown> = {}): PaneContent {
  return {
    kind: 'terminal',
    mode: 'claude',
    createRequestId: 'crid-claude',
    status: 'running',
    initialCwd: '/home/dan/code/freshell',
    ...extra,
  } as PaneContent
}

function shellTerminal(createRequestId = 'crid-shell'): PaneContent {
  return { kind: 'terminal', mode: 'shell', createRequestId, status: 'running' } as PaneContent
}

const SESSION_REF: SessionNameRef = { kind: 'session', provider: 'claude', sessionId: 'sess-1' }
const NEXT_SESSION_REF: SessionNameRef = { kind: 'session', provider: 'claude', sessionId: 'sess-2' }

function update(
  ref: SessionNameRef,
  name: string,
  revision: number,
  redirects: SessionNameUpdate['redirects'] = [],
): SessionNameUpdate {
  return {
    record: { ref, name, source: 'manual', revision },
    documentGeneration: revision,
    redirects,
    changed: true,
  }
}

/** A session-owned Claude tab whose stored title is `title`. */
function createSessionTab(store: Store, opts: { title: string; content?: PaneContent; tabId?: string; paneId?: string }) {
  const tabId = opts.tabId ?? 'tab-1'
  const paneId = opts.paneId ?? 'pane-1'
  store.dispatch(addTab({ id: tabId, title: opts.title, mode: 'claude' }))
  store.dispatch(initLayout({
    tabId,
    paneId,
    content: opts.content ?? claudeTerminal({ sessionRef: { provider: 'claude', sessionId: 'sess-1' } }),
  }))
  return { tabId, paneId }
}

function tabOf(store: Store, tabId: string): Tab {
  const tab = store.getState().tabs.tabs.find((candidate) => candidate.id === tabId)
  if (!tab) throw new Error(`no tab ${tabId}`)
  return tab
}

describe('savedNameTabTitleMirrorMiddleware', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('writes the saved name into a session-owned tab title on session.name.updated', () => {
    vi.useFakeTimers({ now: 1_000 })
    const store = buildStore()
    const { tabId } = createSessionTab(store, { title: 'freshell' })
    expect(tabOf(store, tabId).nameSource).toEqual({ kind: 'session', paneId: 'pane-1' })
    expect(tabOf(store, tabId).updatedAt).toBe(1_000)
    // Time moves on: a title write that touched recency would stamp 9_000.
    vi.setSystemTime(9_000)

    store.dispatch(receiveSessionNames([update(SESSION_REF, 'LotL', 1)]))

    const tab = tabOf(store, tabId)
    expect(tab.title).toBe('LotL')
    expect(tab.updatedAt).toBe(1_000)
    expect(tab.titleSetByUser).toBeUndefined()
  })

  it('never writes a fallback label when no saved record is cached', () => {
    const store = buildStore()
    const { tabId, paneId } = createSessionTab(store, { title: 'LotL' })
    store.dispatch(addTab({ id: 'tab-2', title: 'other', mode: 'shell', activate: false }))
    store.dispatch(initLayout({ tabId: 'tab-2', paneId: 'pane-other', content: shellTerminal('crid-other') }))
    store.dispatch(splitPane({
      tabId,
      paneId,
      direction: 'horizontal',
      newContent: shellTerminal('crid-split'),
      newPaneId: 'pane-split',
    }))
    const splitId = (store.getState().panes.layouts[tabId] as Extract<PaneNode, { type: 'split' }>).id

    // Twenty unrelated actions: pane focus, tab focus, layout changes,
    // settings updates.
    const unrelated = [
      () => store.dispatch(setActivePane({ tabId, paneId: 'pane-split' })),
      () => store.dispatch(setActivePane({ tabId, paneId })),
      () => store.dispatch(setActiveTab('tab-2')),
      () => store.dispatch(setActiveTab(tabId)),
      () => store.dispatch(resizePanes({ tabId, splitId, sizes: [30, 70] })),
      () => store.dispatch(resizePanes({ tabId, splitId, sizes: [60, 40] })),
      () => store.dispatch(toggleZoom({ tabId, paneId })),
      () => store.dispatch(toggleZoom({ tabId, paneId })),
      () => store.dispatch(updateSettingsLocal({ sidebar: { showSubagents: true } })),
      () => store.dispatch(updateSettingsLocal({ sidebar: { showSubagents: false } })),
    ]
    for (let round = 0; round < 2; round += 1) {
      for (const dispatchOne of unrelated) dispatchOne()
    }

    // With a display-name selector the title would have become the pane's
    // fallback label (the provider label or the folder name).
    expect(tabOf(store, tabId).title).toBe('LotL')
  })

  it('the registry overlay never advertises a fallback label', () => {
    const store = buildStore()
    const { tabId } = createSessionTab(store, { title: 'LotL' })

    const recordBefore = selectLiveLocalTabRecords(store.getState() as unknown as RootState)
      .find((record) => record.tabId === tabId)
    expect(recordBefore?.tabName).toBe('LotL')

    // Once the saved record is cached the registry carries it.
    store.dispatch(receiveSessionNames([update(SESSION_REF, 'Billing bug', 1)]))
    const recordAfter = selectLiveLocalTabRecords(store.getState() as unknown as RootState)
      .find((record) => record.tabId === tabId)
    expect(recordAfter?.tabName).toBe('Billing bug')
  })

  it('follows a rename and a pending→session redirect', () => {
    const store = buildStore()
    const pending: SessionNameRef = { kind: 'pending', id: 'handle-1' }
    const { tabId } = createSessionTab(store, {
      title: 'freshell',
      content: claudeTerminal({ namingHandle: 'handle-1' }),
    })

    store.dispatch(receiveSessionNames([update(pending, 'First name', 1)]))
    expect(tabOf(store, tabId).title).toBe('First name')

    store.dispatch(receiveSessionNames([update(pending, 'Renamed', 2)]))
    expect(tabOf(store, tabId).title).toBe('Renamed')

    // The pending handle binds to the durable session: the record moves to
    // the session key and the pane's pending ref resolves through the
    // redirect.
    store.dispatch(receiveSessionNames([
      update(SESSION_REF, 'Durable name', 3, [{ from: pending, to: SESSION_REF, revision: 3 }]),
    ]))
    expect(tabOf(store, tabId).title).toBe('Durable name')
  })

  it('never writes legacy tabs', () => {
    const store = buildStore()
    // A shell tab, and a legacy split tab (shell first, so its naming source
    // resolves legacy) that also holds a named Claude pane.
    store.dispatch(addTab({ id: 'shell-tab', title: 'my shell', mode: 'shell' }))
    store.dispatch(initLayout({ tabId: 'shell-tab', paneId: 'shell-pane', content: shellTerminal('crid-s') }))
    store.dispatch(addTab({ id: 'mixed-tab', title: 'mixed work', mode: 'shell' }))
    store.dispatch(initLayout({ tabId: 'mixed-tab', paneId: 'mixed-shell', content: shellTerminal('crid-m') }))
    store.dispatch(splitPane({
      tabId: 'mixed-tab',
      paneId: 'mixed-shell',
      direction: 'horizontal',
      newContent: claudeTerminal({ sessionRef: { provider: 'claude', sessionId: 'sess-1' } }),
      newPaneId: 'mixed-claude',
    }))
    expect(tabOf(store, 'mixed-tab').nameSource).toEqual({ kind: 'legacy' })

    store.dispatch(receiveSessionNames([update(SESSION_REF, 'LotL', 1)]))

    expect(tabOf(store, 'shell-tab').title).toBe('my shell')
    expect(tabOf(store, 'mixed-tab').title).toBe('mixed work')
  })

  it('display falls back to the mirrored saved name when the name cache is empty', () => {
    const store = buildStore()
    const { tabId } = createSessionTab(store, { title: 'LotL' })

    expect(store.getState().sessionNames.records).toEqual({})
    expect(selectTabDisplayName(store.getState() as unknown as RootState, tabId)).toBe('LotL')
  })
  it('a conversation switch to a session without a saved record stops showing the old name', () => {
    vi.useFakeTimers({ now: 1_000 })
    const store = buildStore()
    const { tabId, paneId } = createSessionTab(store, {
      title: 'freshell',
      content: claudeTerminal({ terminalId: 'term-1', sessionRef: { provider: 'claude', sessionId: 'sess-1' } }),
    })
    store.dispatch(receiveSessionNames([update(SESSION_REF, 'LotL', 1)]))
    expect(tabOf(store, tabId).title).toBe('LotL')
    vi.setSystemTime(9_000)

    // The CLI switched conversations (for example /clear): the pane now
    // holds sess-2, which has no saved name yet.
    store.dispatch(reconcileTerminalSessionRefByTerminalId({
      terminalId: 'term-1',
      sessionRef: { provider: 'claude', sessionId: 'sess-2' },
    }))

    const state = store.getState() as unknown as RootState
    // The tab bar shows what the pane header shows: the new conversation's
    // fallback, never the old conversation's name.
    expect(selectPaneDisplayName(state, tabId, paneId)).not.toBe('LotL')
    expect(selectTabDisplayName(state, tabId)).not.toBe('LotL')
    expect(selectTabDisplayName(state, tabId)).toBe(selectPaneDisplayName(state, tabId, paneId))
    // The stored title (copied by the persisted layout and the server layout
    // mirror) and the tabs registry drop it too, without touching recency.
    expect(tabOf(store, tabId).title).not.toBe('LotL')
    expect(tabOf(store, tabId).updatedAt).toBe(1_000)
    const record = selectLiveLocalTabRecords(state).find((candidate) => candidate.tabId === tabId)
    expect(record?.tabName).not.toBe('LotL')

    // The new conversation's first saved name is mirrored as usual; the old
    // conversation keeps its own name.
    store.dispatch(receiveSessionNames([update(NEXT_SESSION_REF, 'Billing bug', 1)]))
    expect(tabOf(store, tabId).title).toBe('Billing bug')
    expect(store.getState().sessionNames.records[sessionNameRefKey(SESSION_REF)]?.name).toBe('LotL')
  })

  it('the naming source moving to a pane without a saved record stops showing the old name', () => {
    const store = buildStore()
    const { tabId, paneId } = createSessionTab(store, { title: 'freshell' })
    store.dispatch(splitPane({
      tabId,
      paneId,
      direction: 'horizontal',
      newContent: claudeTerminal({ createRequestId: 'crid-claude-2', sessionRef: { provider: 'claude', sessionId: 'sess-2' } }),
      newPaneId: 'pane-2',
    }))
    expect(tabOf(store, tabId).nameSource).toEqual({ kind: 'session', paneId })
    store.dispatch(receiveSessionNames([update(SESSION_REF, 'LotL', 1)]))
    expect(tabOf(store, tabId).title).toBe('LotL')

    // Closing the source pane hands the tab's name to the other Claude pane,
    // whose session has no saved name yet.
    store.dispatch(closePane({ tabId, paneId }))
    expect(tabOf(store, tabId).nameSource).toEqual({ kind: 'session', paneId: 'pane-2' })

    const state = store.getState() as unknown as RootState
    expect(selectTabDisplayName(state, tabId)).not.toBe('LotL')
    expect(tabOf(store, tabId).title).not.toBe('LotL')
  })

  it('a new tab keeps its create-time title while its pane gains a naming identity', () => {
    const store = buildStore()
    // A tab created with a caller name and a Claude pane that has no naming
    // identity yet (its terminal is still being created).
    const { tabId, paneId } = createSessionTab(store, { title: 'Fix login', content: claudeTerminal() })
    expect(tabOf(store, tabId).nameSource).toEqual({ kind: 'session', paneId })

    store.dispatch(updatePaneContent({ tabId, paneId, content: claudeTerminal({ namingHandle: 'handle-new' }) }))
    expect(tabOf(store, tabId).title).toBe('Fix login')

    store.dispatch(updatePaneContent({
      tabId,
      paneId,
      content: claudeTerminal({ namingHandle: 'handle-new', terminalId: 'term-9', sessionRef: { provider: 'claude', sessionId: 'sess-9' } }),
    }))
    expect(tabOf(store, tabId).title).toBe('Fix login')
  })

  it('an empty cached name never dispatches a mirror write', () => {
    const mirrorWrites: unknown[] = []
    const spy: Middleware = () => (next) => (action) => {
      if (mirrorSessionTabTitles.match(action)) mirrorWrites.push(action)
      return next(action)
    }
    // A hand-built cache holding an empty name (the wire schema refuses
    // one, so only a corrupt or hand-built state can hold it).
    const store = buildStore({
      spy,
      preloadedState: {
        sessionNames: {
          records: {
            [sessionNameRefKey(SESSION_REF)]: { ref: SESSION_REF, name: '', source: 'manual', revision: 1 },
          },
          redirects: {},
          nativeSync: {},
        },
      },
    })
    const { tabId, paneId } = createSessionTab(store, { title: 'LotL' })
    store.dispatch(splitPane({
      tabId,
      paneId,
      direction: 'horizontal',
      newContent: shellTerminal('crid-split'),
      newPaneId: 'pane-split',
    }))
    store.dispatch(setActivePane({ tabId, paneId: 'pane-split' }))
    store.dispatch(setActivePane({ tabId, paneId }))

    expect(mirrorWrites).toEqual([])
    expect(tabOf(store, tabId).title).toBe('LotL')
  })
})
