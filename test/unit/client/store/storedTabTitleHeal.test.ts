import { afterEach, describe, it, expect, vi } from 'vitest'
import { configureStore, type Middleware } from '@reduxjs/toolkit'
import tabsReducer, { addTab, setActiveTab, updateTab } from '@/store/tabsSlice'
import panesReducer, { initLayout, setActivePane, splitPane, updatePaneTitle } from '@/store/panesSlice'
import sessionNamesReducer, { receiveSessionNames } from '@/store/sessionNamesSlice'
import settingsReducer from '@/store/settingsSlice'
import connectionReducer from '@/store/connectionSlice'
import tabRegistryReducer from '@/store/tabRegistrySlice'
import extensionsReducer from '@/store/extensionsSlice'
import { sessionNameLifecycleMiddleware } from '@/store/sessionNameLifecycleMiddleware'
import { savedNameTabTitleMirrorMiddleware } from '@/store/savedNameTabTitleMirror'
import { healStoredTabTitlesOnLoad, storedTabTitleHealMiddleware } from '@/store/storedTabTitleHeal'
import { selectTabDisplayName } from '@/store/selectors/sessionNameSelectors'
import { selectLiveLocalTabRecords } from '@/store/selectors/tabsRegistrySelectors'
import { openRecordAsUnlinkedCopy } from '@/lib/tab-registry-open'
import { applyRecoveryTabPlan } from '@/lib/recovery/apply-recovery-plan'
import { installCrossTabSync } from '@/store/crossTabSync'
import { getWindowLayoutKey } from '@/store/window-layout-keys'
import type { PaneContent } from '@/store/paneTypes'
import type { Tab } from '@/store/types'
import type { RegistryTabRecord } from '@/store/tabRegistryTypes'
import type { SessionNameRef, SessionNameUpdate } from '@shared/session-names'
import type { RootState } from '@/store/store'

// Name reliability (plan Task 14, Residual 23): an earlier managed-runtime
// merge stored provider labels ("Shell agent", "OpenCode agent", "Recovered
// Shell agent") as tab titles. Such a stored title is not a name: it heals to
// the unnamed placeholder ("Tab N", which every display treats as no title),
// at one point — the store — so the display, the persisted layout, the
// server's layout mirror and the tabs registry agree. A renamed tab, a real
// title and a session-owned tab whose saved name is known are never touched.

const reducer = {
  tabs: tabsReducer,
  panes: panesReducer,
  sessionNames: sessionNamesReducer,
  settings: settingsReducer,
  connection: connectionReducer,
  tabRegistry: tabRegistryReducer,
  extensions: extensionsReducer,
}

function buildStore(options: { preloadedState?: Record<string, unknown>; spy?: Middleware } = {}) {
  return configureStore({
    reducer,
    // The production order (src/store/store.ts): the heal sits next to the
    // saved-name mirror, outside the naming-source lifecycle coordinator.
    middleware: (getDefault) => getDefault().concat(
      ...(options.spy ? [options.spy] : []),
      savedNameTabTitleMirrorMiddleware,
      storedTabTitleHealMiddleware,
      sessionNameLifecycleMiddleware,
    ),
    ...(options.preloadedState ? { preloadedState: options.preloadedState as never } : {}),
  })
}

type Store = ReturnType<typeof buildStore>

/** A store state that already holds the given tabs, as a load from the
 * persisted layout produces it: built without the heal, so nothing has
 * healed it yet. */
function loadedState(tabs: Array<{ tab: Parameters<typeof addTab>[0]; paneId: string; content: PaneContent }>) {
  const scratch = configureStore({ reducer })
  for (const { tab, paneId, content } of tabs) {
    scratch.dispatch(addTab(tab))
    scratch.dispatch(initLayout({ tabId: tab!.id!, paneId, content }))
  }
  return scratch.getState() as unknown as Record<string, unknown>
}

function shellTerminal(extra: Record<string, unknown> = {}): PaneContent {
  return { kind: 'terminal', mode: 'shell', shell: 'system', createRequestId: 'crid-shell', status: 'running', ...extra } as PaneContent
}

function agentTerminal(mode: string, extra: Record<string, unknown> = {}): PaneContent {
  return { kind: 'terminal', mode, createRequestId: `crid-${mode}`, status: 'running', ...extra } as PaneContent
}

function tabOf(store: Store, tabId: string): Tab {
  const tab = store.getState().tabs.tabs.find((candidate) => candidate.id === tabId)
  if (!tab) throw new Error(`no tab ${tabId}`)
  return tab
}

function displayOf(store: Store, tabId: string): string {
  return selectTabDisplayName(store.getState() as unknown as RootState, tabId)
}

/** A few actions that change nothing about any title. */
function unrelatedActions(store: Store, tabId: string, paneId: string) {
  store.dispatch(setActivePane({ tabId, paneId }))
  store.dispatch(setActiveTab(tabId))
  store.dispatch(updateTab({ id: tabId, updates: { status: 'running' }, touchUpdatedAt: false }))
}

function update(ref: SessionNameRef, name: string, revision: number): SessionNameUpdate {
  return {
    record: { ref, name, source: 'provider_ai', revision },
    documentGeneration: revision,
    redirects: [],
    changed: true,
  }
}

describe('storedTabTitleHealMiddleware', () => {
  const cleanups: Array<() => void> = []

  afterEach(() => {
    vi.useRealTimers()
    for (const cleanup of cleanups.splice(0)) cleanup()
    localStorage.clear()
  })

  it('heals a stored "Shell agent" title when the store loads, without touching recency or the rename flag', () => {
    vi.useFakeTimers({ now: 1_000 })
    const store = buildStore({
      preloadedState: loadedState([
        { tab: { id: 'tab-1', title: 'Shell agent', mode: 'shell' }, paneId: 'pane-1', content: shellTerminal() },
      ]),
    })
    vi.setSystemTime(9_000)
    expect(tabOf(store, 'tab-1').title).toBe('Shell agent')

    healStoredTabTitlesOnLoad(store)

    const tab = tabOf(store, 'tab-1')
    expect(tab.title).toBe('Tab 1')
    expect(tab.updatedAt).toBe(1_000)
    expect(tab.titleSetByUser).toBeUndefined()
    // The display shows the derived label, never the provider label.
    expect(displayOf(store, 'tab-1')).toBe('Shell')
  })

  it.each([
    ['Shell agent', 'shell', shellTerminal()],
    ['shell agent', 'shell', shellTerminal()],
    ['Recovered Shell agent', 'shell', shellTerminal()],
    ['Recovered shell agent', 'shell', shellTerminal({ initialCwd: '/home/dan/code/freshell' })],
    ['Recovered', 'shell', shellTerminal()],
    ['OpenCode agent', 'opencode', agentTerminal('opencode', { initialCwd: '/work/billing' })],
    ['opencode agent', 'opencode', agentTerminal('opencode', { initialCwd: '/work/billing' })],
    ['Recovered OpenCode agent', 'opencode', agentTerminal('opencode', { initialCwd: '/work/billing' })],
    ['New session - 2026-10-20T00:09:25.350Z', 'opencode', agentTerminal('opencode', { initialCwd: '/work/billing' })],
    ['claude agent', 'claude', agentTerminal('claude', { initialCwd: '/work/billing' })],
    ['Recovered amplifier agent', 'amplifier', agentTerminal('amplifier', { initialCwd: '/work/billing' })],
    ['<recommended_plugins>\n- github: review pull requests', 'claude', agentTerminal('claude', { initialCwd: '/work/billing' })],
  ] as const)('heals the stored label %j on an unrenamed %s tab', (title, mode, content) => {
    const store = buildStore()
    store.dispatch(addTab({ id: 'tab-1', title, mode }))
    store.dispatch(initLayout({ tabId: 'tab-1', paneId: 'pane-1', content }))

    expect(tabOf(store, 'tab-1').title).toBe('Tab 1')
    expect(tabOf(store, 'tab-1').titleSetByUser).toBeUndefined()
    expect(displayOf(store, 'tab-1')).not.toBe(title)
  })

  it('heals each tab to its own position', () => {
    const store = buildStore({
      preloadedState: loadedState([
        { tab: { id: 'tab-a', title: 'Build watcher', mode: 'shell' }, paneId: 'pane-a', content: shellTerminal() },
        { tab: { id: 'tab-b', title: 'Shell agent', mode: 'shell' }, paneId: 'pane-b', content: shellTerminal() },
      ]),
    })

    healStoredTabTitlesOnLoad(store)

    expect(tabOf(store, 'tab-a').title).toBe('Build watcher')
    expect(tabOf(store, 'tab-b').title).toBe('Tab 2')
  })

  it('never touches a renamed tab', () => {
    const store = buildStore({
      preloadedState: loadedState([
        { tab: { id: 'tab-1', title: 'Shell agent', titleSetByUser: true, mode: 'shell' }, paneId: 'pane-1', content: shellTerminal() },
      ]),
    })

    healStoredTabTitlesOnLoad(store)
    unrelatedActions(store, 'tab-1', 'pane-1')

    expect(tabOf(store, 'tab-1').title).toBe('Shell agent')
    expect(tabOf(store, 'tab-1').titleSetByUser).toBe(true)
    expect(displayOf(store, 'tab-1')).toBe('Shell agent')
  })

  it.each([
    ['a real title', 'Build watcher', 'shell', shellTerminal()],
    ['a shell window title', 'dan@garageserver: ~/code', 'shell', shellTerminal()],
    ['the unnamed placeholder of another position', 'Tab 7', 'shell', shellTerminal()],
    ['a create-time folder label equal to the derived label', 'freshell', 'claude', agentTerminal('claude', { initialCwd: '/home/dan/code/freshell' })],
    ['a create-time provider label equal to the derived label', 'Claude', 'claude', agentTerminal('claude')],
  ] as const)('leaves %s alone', (_label, title, mode, content) => {
    const store = buildStore()
    store.dispatch(addTab({ id: 'tab-1', title, mode }))
    store.dispatch(initLayout({ tabId: 'tab-1', paneId: 'pane-1', content }))
    healStoredTabTitlesOnLoad(store)
    unrelatedActions(store, 'tab-1', 'pane-1')

    expect(tabOf(store, 'tab-1').title).toBe(title)
  })

  // The tab's folder (its own, else its first pane's) need not be the folder
  // its derived label comes from: deriveTabName prefers a coding CLI pane, a
  // fresh agent or a browser over the first shell. A shell prompt that titles
  // the window with its folder name ('alpha') is then a live title, not a
  // stored default, and keeps naming the tab.
  it.each([
    ['a coding CLI pane in another folder', 'beta', agentTerminal('claude', { initialCwd: '/x/beta' })],
    ['a browser pane', 'example.com', { kind: 'browser', url: 'https://example.com/docs', devToolsOpen: false } as PaneContent],
  ] as const)('keeps a shell window title equal to its folder name on a split tab named from %s', (_label, derived, otherContent) => {
    const store = buildStore()
    store.dispatch(addTab({ id: 'tab-1', mode: 'shell' }))
    store.dispatch(initLayout({ tabId: 'tab-1', paneId: 'pane-shell', content: shellTerminal({ initialCwd: '/x/alpha' }) }))
    store.dispatch(splitPane({ tabId: 'tab-1', paneId: 'pane-shell', direction: 'horizontal', newContent: otherContent, newPaneId: 'pane-other' }))
    expect(displayOf(store, 'tab-1')).toBe(derived)

    // TerminalView's OSC title handler writes the tab and the pane title.
    store.dispatch(updateTab({ id: 'tab-1', updates: { title: 'alpha' } }))
    store.dispatch(updatePaneTitle({ tabId: 'tab-1', paneId: 'pane-shell', title: 'alpha', setByUser: false }))
    unrelatedActions(store, 'tab-1', 'pane-shell')
    healStoredTabTitlesOnLoad(store)

    expect(tabOf(store, 'tab-1').title).toBe('alpha')
    expect(displayOf(store, 'tab-1')).toBe('alpha')
  })

  // A title's writer is not recorded, so a window title that is itself a
  // provider label heals like a stored one; a single-pane tab still shows it
  // through the pane title the same OSC write stored.
  it('a single-pane shell tab keeps showing a window title that is a provider label', () => {
    const store = buildStore()
    store.dispatch(addTab({ id: 'tab-1', mode: 'shell' }))
    store.dispatch(initLayout({ tabId: 'tab-1', paneId: 'pane-1', content: shellTerminal({ initialCwd: '/x/alpha' }) }))

    store.dispatch(updateTab({ id: 'tab-1', updates: { title: 'opencode' } }))
    store.dispatch(updatePaneTitle({ tabId: 'tab-1', paneId: 'pane-1', title: 'opencode', setByUser: false }))
    unrelatedActions(store, 'tab-1', 'pane-1')

    expect(displayOf(store, 'tab-1')).toBe('opencode')
  })

  it('heals a tab that arrives later from stored state: a registry open and a rebuilt tab', () => {
    const store = buildStore()
    const record: RegistryTabRecord = {
      tabKey: 'device-a:tab-9',
      tabId: 'tab-9',
      serverInstanceId: 'srv-1',
      deviceId: 'device-a',
      deviceLabel: 'Device A',
      tabName: 'Recovered Shell agent',
      status: 'closed',
      closedAt: 3,
      revision: 1,
      createdAt: 1,
      updatedAt: 2,
      paneCount: 1,
      titleSetByUser: false,
      panes: [{ paneId: 'p1', kind: 'terminal', payload: { mode: 'shell' } }],
    }
    openRecordAsUnlinkedCopy(record, { dispatch: store.dispatch })
    applyRecoveryTabPlan(store.dispatch, {
      tabId: 'tab-rebuilt',
      title: 'Shell agent',
      layout: { type: 'leaf', id: 'pane-rebuilt', content: shellTerminal({ createRequestId: 'crid-rebuilt' }) },
      paneTitles: {},
      paneTitleSetByUser: {},
    })

    const [copied, rebuilt] = store.getState().tabs.tabs
    expect(copied.title).toBe('Tab 1')
    expect(rebuilt.id).toBe('tab-rebuilt')
    expect(rebuilt.title).toBe('Tab 2')
  })

  it('heals a tab that arrives through cross-window sync and keeps a renamed one from the same envelope', () => {
    const store = buildStore()
    cleanups.push(installCrossTabSync(store as never))
    const shellLeaf = (paneId: string) => ({ type: 'leaf', id: paneId, content: shellTerminal({ createRequestId: `crid-${paneId}` }) })
    // Another copy of this window (a duplicated browser tab before its
    // window id rotates) flushes the layout an old client stored. The tabs
    // carry their naming source, so nothing but the hydrate itself can
    // trigger the heal.
    const envelope = {
      version: 3,
      tabs: {
        activeTabId: 'tab-a',
        tabs: [
          { id: 'tab-a', title: 'Shell agent', mode: 'shell', nameSource: { kind: 'legacy' }, createdAt: 1 },
          { id: 'tab-b', title: 'Shell agent', titleSetByUser: true, mode: 'shell', nameSource: { kind: 'legacy' }, createdAt: 2 },
        ],
      },
      panes: {
        version: 6,
        layouts: { 'tab-a': shellLeaf('pane-a'), 'tab-b': shellLeaf('pane-b') },
        activePane: { 'tab-a': 'pane-a', 'tab-b': 'pane-b' },
        paneTitles: {},
        paneTitleSetByUser: {},
      },
      tombstones: [],
    }

    window.dispatchEvent(new StorageEvent('storage', { key: getWindowLayoutKey(), newValue: JSON.stringify(envelope) }))

    expect(store.getState().tabs.tabs.map((tab) => tab.id)).toEqual(['tab-a', 'tab-b'])
    expect(tabOf(store, 'tab-a').title).toBe('Tab 1')
    expect(tabOf(store, 'tab-a').titleSetByUser).toBeUndefined()
    expect(displayOf(store, 'tab-a')).toBe('Shell')
    expect(tabOf(store, 'tab-b').title).toBe('Shell agent')
    expect(tabOf(store, 'tab-b').titleSetByUser).toBe(true)
  })

  it('a real OSC title still wins after a heal', () => {
    const store = buildStore()
    store.dispatch(addTab({ id: 'tab-1', title: 'Shell agent', mode: 'shell' }))
    store.dispatch(initLayout({ tabId: 'tab-1', paneId: 'pane-1', content: shellTerminal() }))
    expect(tabOf(store, 'tab-1').title).toBe('Tab 1')

    // TerminalView's OSC title handler writes the tab and the pane title.
    store.dispatch(updateTab({ id: 'tab-1', updates: { title: 'vim notes.md' } }))
    store.dispatch(updatePaneTitle({ tabId: 'tab-1', paneId: 'pane-1', title: 'vim notes.md', setByUser: false }))
    unrelatedActions(store, 'tab-1', 'pane-1')

    expect(tabOf(store, 'tab-1').title).toBe('vim notes.md')
    expect(displayOf(store, 'tab-1')).toBe('vim notes.md')
  })

  it('a session-owned tab without a cached saved name heals; once the name is known the mirror owns the title', () => {
    const store = buildStore()
    store.dispatch(addTab({ id: 'tab-1', title: 'OpenCode agent', mode: 'opencode' }))
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: agentTerminal('opencode', {
        initialCwd: '/work/billing',
        sessionRef: { provider: 'opencode', sessionId: 'ses-1' },
      }),
    }))
    expect(tabOf(store, 'tab-1').nameSource).toEqual({ kind: 'session', paneId: 'pane-1' })
    expect(tabOf(store, 'tab-1').title).toBe('Tab 1')

    store.dispatch(receiveSessionNames([
      update({ kind: 'session', provider: 'opencode', sessionId: 'ses-1' }, 'Billing bug', 1),
    ]))
    expect(tabOf(store, 'tab-1').title).toBe('Billing bug')
  })

  it('never fights the mirror over a saved name that looks like a default label', () => {
    const titleWrites: string[] = []
    const spy: Middleware = () => (next) => (action) => {
      const type = (action as { type?: string }).type
      if (type === 'tabs/mirrorSessionTabTitles' || type === 'tabs/healStoredTabTitles') titleWrites.push(type)
      return next(action)
    }
    const store = buildStore({ spy })
    store.dispatch(addTab({ id: 'tab-1', title: 'Billing bug', mode: 'opencode' }))
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: agentTerminal('opencode', {
        initialCwd: '/work/billing',
        sessionRef: { provider: 'opencode', sessionId: 'ses-1' },
      }),
    }))
    // An old import left the session's saved name as the provider label.
    store.dispatch(receiveSessionNames([
      update({ kind: 'session', provider: 'opencode', sessionId: 'ses-1' }, 'OpenCode agent', 1),
    ]))
    titleWrites.length = 0
    for (let round = 0; round < 5; round += 1) unrelatedActions(store, 'tab-1', 'pane-1')

    expect(tabOf(store, 'tab-1').title).toBe('OpenCode agent')
    expect(titleWrites).toEqual([])
  })

  it('the tabs registry and the stored title agree after a heal', () => {
    const store = buildStore({
      preloadedState: loadedState([
        { tab: { id: 'tab-1', title: 'Shell agent', mode: 'shell' }, paneId: 'pane-1', content: shellTerminal() },
        { tab: { id: 'tab-2', title: 'Shell agent', titleSetByUser: true, mode: 'shell' }, paneId: 'pane-2', content: shellTerminal({ createRequestId: 'crid-2' }) },
      ]),
    })
    healStoredTabTitlesOnLoad(store)

    const records = selectLiveLocalTabRecords(store.getState() as unknown as RootState)
    expect(records.find((record) => record.tabId === 'tab-1')?.tabName).toBe('Shell')
    expect(records.find((record) => record.tabId === 'tab-2')?.tabName).toBe('Shell agent')
    expect(records.find((record) => record.tabId === 'tab-2')?.titleSetByUser).toBe(true)
  })
})
