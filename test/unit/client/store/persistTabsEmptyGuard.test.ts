// Regression coverage for the destructive persist-of-empty guard.
//
// Incident (v1): a transient failure reading the persisted layout (corrupt
// JSON, a thrown exception, or sanitizeTabsAgainstLayouts pruning every tab
// because its pane layout was missing) causes loadInitialTabsState() to fall
// back to an empty tabs array. If ANY later action then triggers a flush
// (even a panes-only or activeTabId-only change that never touches the tabs
// array), persistMiddleware's combined layout write would overwrite the
// perfectly good, non-empty layout already on disk with an empty one --
// permanently destroying the user's tab layout.
//
// v1 fix: a one-shot `distrustEmptyTabs` latch, armed only for a session that
// booted via recovery, and PERMANENTLY disarmed the moment any non-empty tabs
// state was observed.
//
// Incident (v2): the v1 latch (a) never armed at all for a perfectly normal
// boot, so any LATER emptying of tabs via a non-user path (e.g. a cross-tab
// hydrateTabs merge tombstoning the only tab from another device) sailed
// through the guard with no protection whatsoever, and (b) even when armed,
// disarmed permanently and irreversibly on the first non-empty observation --
// so a genuine recovery-boot session that later, legitimately, filled with
// real tabs and then got emptied by some OTHER unrelated bug lost all
// protection too. Nothing was logged when this happened, so the destructive
// write was unprovable after the fact.
//
// v2 fix: the guard is now a stateless, permanent rule -- flush() checked on
// EVERY write, indefinitely: never overwrite a non-empty persisted layout
// with an empty tabs array unless a genuine user action (closing their last
// tab) was observed for THIS SPECIFIC write (see `userClosedTabsIntent` in
// persistMiddleware.ts, set from the real close-tab action in tabsSlice).
// A rolling backup (LAYOUT_BACKUP_STORAGE_KEY) is written before any
// overwrite that would replace a non-empty layout with an empty one --
// whether the guard refuses or a genuine user close allows it -- so any
// future occurrence (bug or otherwise) is recoverable. Guard refusals now
// log at `error` level with a structured reason.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import { LAYOUT_BACKUP_STORAGE_KEY, LAYOUT_STORAGE_KEY } from '@/store/storage-keys'

describe('persist middleware — destructive empty-tabs guard', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.useFakeTimers()
    vi.resetModules()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('does not overwrite a non-empty persisted layout with empty tabs after a transient parse failure', async () => {
    // Simulate a transient failure: the raw layout key exists (something WAS
    // persisted) but is corrupt JSON, so parsePersistedLayoutRaw fails and
    // loadInitialTabsState() falls back to an empty tabs array. The bytes on
    // disk are still whatever they were -- that's the thing we must protect.
    const corruptRaw = '{not valid json, but not empty either'
    localStorage.setItem(LAYOUT_STORAGE_KEY, corruptRaw)

    const { configureStore: freshConfigureStore } = await import('@reduxjs/toolkit')
    const { default: tabsReducer, setActiveTab } = await import('@/store/tabsSlice')
    const { persistMiddleware, PERSIST_DEBOUNCE_MS, resetPersistFlushListenersForTests } = await import(
      '@/store/persistMiddleware'
    )
    resetPersistFlushListenersForTests()

    const store = freshConfigureStore({
      reducer: { tabs: tabsReducer },
      middleware: (getDefault) => getDefault().concat(persistMiddleware as any),
    })

    // Loaded state should indeed be empty (the failure fell back to default).
    expect(store.getState().tabs.tabs).toEqual([])

    // An unrelated tabs-slice action fires (does not touch the tabs array,
    // e.g. activeTabId bookkeeping) — this is exactly the kind of action
    // that must NOT be treated as "the user emptied their tabs".
    // The guard refusal below logs at `error` level by design (v2 requirement
    // #3: refusals must be provable) — expect it rather than let the global
    // "unexpected console.error" test guard fail the test.
    ;(globalThis as any).__ALLOW_CONSOLE_ERROR__ = true
    store.dispatch(setActiveTab('some-tab-id'))
    vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS)

    // The original (corrupt) persisted value must be untouched — the guard
    // must refuse to destroy it with a freshly-serialized empty-tabs layout.
    expect(localStorage.getItem(LAYOUT_STORAGE_KEY)).toBe(corruptRaw)
    // v2: a rolling backup is written whenever an overwrite that would
    // replace a non-empty (or unparseable, hence unprovably-empty) layout
    // with an empty one is contemplated — whether refused (as here) or
    // allowed. This is the last line of defense for future occurrences.
    expect(localStorage.getItem(LAYOUT_BACKUP_STORAGE_KEY)).toBe(corruptRaw)
  })

  it('still persists a genuine close-all-tabs to an empty layout (no regression)', async () => {
    // A real, valid, non-empty persisted layout — the normal, successful load path.
    localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify({
      version: 4,
      tabs: {
        activeTabId: 'tab-1',
        tabs: [{
          id: 'tab-1',
          title: 'Real Tab',
          status: 'running',
          mode: 'shell',
          createdAt: 1,
        }],
      },
      panes: {
        version: 7,
        layouts: {
          'tab-1': { type: 'leaf', id: 'pane-1', content: { kind: 'terminal', mode: 'shell', createRequestId: 'req-1', status: 'running' } },
        },
        activePane: { 'tab-1': 'pane-1' },
        paneTitles: {},
        paneTitleSetByUser: {},
      },
      tombstones: [],
    }))

    const { configureStore: freshConfigureStore } = await import('@reduxjs/toolkit')
    const { default: tabsReducer, removeTab } = await import('@/store/tabsSlice')
    const { persistMiddleware, PERSIST_DEBOUNCE_MS, resetPersistFlushListenersForTests } = await import(
      '@/store/persistMiddleware'
    )
    resetPersistFlushListenersForTests()

    const store = freshConfigureStore({
      reducer: { tabs: tabsReducer },
      middleware: (getDefault) => getDefault().concat(persistMiddleware as any),
    })

    expect(store.getState().tabs.tabs).toHaveLength(1)

    const originalRaw = localStorage.getItem(LAYOUT_STORAGE_KEY)

    // The user genuinely closes their only tab.
    store.dispatch(removeTab('tab-1'))
    expect(store.getState().tabs.tabs).toEqual([])

    vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS)

    const raw = localStorage.getItem(LAYOUT_STORAGE_KEY)
    expect(raw).not.toBeNull()
    const parsed = JSON.parse(raw!)
    expect(parsed.tabs.tabs).toEqual([])
    // v2: even a genuine, authorized empty write still backs up the prior
    // non-empty layout first -- the backup mechanism protects against ANY
    // overwrite of a non-empty layout with an empty one, not just refused
    // ones, so it's available if the "genuine user close" determination
    // itself is ever wrong.
    expect(localStorage.getItem(LAYOUT_BACKUP_STORAGE_KEY)).toBe(originalRaw)
  })

  it('normal flush path is unaffected when tabs are non-empty throughout', async () => {
    localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify({
      version: 4,
      tabs: {
        activeTabId: 'tab-1',
        tabs: [{
          id: 'tab-1',
          title: 'Real Tab',
          status: 'running',
          mode: 'shell',
          createdAt: 1,
        }],
      },
      panes: {
        version: 7,
        layouts: {
          'tab-1': { type: 'leaf', id: 'pane-1', content: { kind: 'terminal', mode: 'shell', createRequestId: 'req-1', status: 'running' } },
        },
        activePane: { 'tab-1': 'pane-1' },
        paneTitles: {},
        paneTitleSetByUser: {},
      },
      tombstones: [],
    }))

    const { configureStore: freshConfigureStore } = await import('@reduxjs/toolkit')
    const { default: tabsReducer, updateTab } = await import('@/store/tabsSlice')
    const { persistMiddleware, PERSIST_DEBOUNCE_MS, resetPersistFlushListenersForTests } = await import(
      '@/store/persistMiddleware'
    )
    resetPersistFlushListenersForTests()

    const store = freshConfigureStore({
      reducer: { tabs: tabsReducer },
      middleware: (getDefault) => getDefault().concat(persistMiddleware as any),
    })

    store.dispatch(updateTab({ id: 'tab-1', updates: { title: 'Renamed' } }))
    vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS)

    const raw = localStorage.getItem(LAYOUT_STORAGE_KEY)
    expect(raw).not.toBeNull()
    const parsed = JSON.parse(raw!)
    expect(parsed.tabs.tabs).toHaveLength(1)
    expect(parsed.tabs.tabs[0].title).toBe('Renamed')
    // The empty-tabs backup path is never entered when tabs stay non-empty.
    expect(localStorage.getItem(LAYOUT_BACKUP_STORAGE_KEY)).toBeNull()
  })

  it('does not overwrite a non-empty persisted layout when tabs are emptied via a non-user hydrateTabs merge', async () => {
    // This is the load-bearing v2 regression test. It reproduces the actual
    // incident gap: a PERFECTLY NORMAL boot (not a recovery boot at all --
    // the persisted layout parses fine and tabs.length > 0 from the very
    // first render) followed by tabs becoming empty through a NON-user path.
    //
    // Under v1, `distrustEmptyTabs = wasTabsLoadRecovery()` starts (and
    // stays) FALSE for a normal boot like this one -- it never armed in the
    // first place, so this destructive overwrite sailed through with zero
    // protection. There is no "later disarm" step to even observe; the
    // guard simply never applied here. Fails today: the layout gets
    // overwritten with empty tabs.
    localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify({
      version: 4,
      tabs: {
        activeTabId: 'tab-1',
        tabs: [{
          id: 'tab-1',
          title: 'Real Tab',
          status: 'running',
          mode: 'shell',
          createdAt: 1,
        }],
      },
      panes: {
        version: 7,
        layouts: {
          'tab-1': { type: 'leaf', id: 'pane-1', content: { kind: 'terminal', mode: 'shell', createRequestId: 'req-1', status: 'running' } },
        },
        activePane: { 'tab-1': 'pane-1' },
        paneTitles: {},
        paneTitleSetByUser: {},
      },
      tombstones: [],
    }))

    const { configureStore: freshConfigureStore } = await import('@reduxjs/toolkit')
    const { default: tabsReducer, hydrateTabs } = await import('@/store/tabsSlice')
    const { persistMiddleware, PERSIST_DEBOUNCE_MS, resetPersistFlushListenersForTests } = await import(
      '@/store/persistMiddleware'
    )
    resetPersistFlushListenersForTests()

    const store = freshConfigureStore({
      reducer: { tabs: tabsReducer },
      middleware: (getDefault) => getDefault().concat(persistMiddleware as any),
    })

    // Normal boot: the persisted tab loaded successfully, non-empty.
    expect(store.getState().tabs.tabs).toHaveLength(1)
    const originalRaw = localStorage.getItem(LAYOUT_STORAGE_KEY)

    // A NON-user path empties the tabs: a cross-tab hydrateTabs merge that
    // tombstones the only tab (e.g. another device closed it, or a stale
    // sync race) -- nothing the user did IN THIS SESSION.
    // The guard refusal below logs at `error` level by design; expect it.
    ;(globalThis as any).__ALLOW_CONSOLE_ERROR__ = true
    store.dispatch(hydrateTabs({
      tabs: [],
      activeTabId: null,
      tombstones: [{ id: 'tab-1', deletedAt: Date.now() }],
    } as any))
    expect(store.getState().tabs.tabs).toEqual([])

    vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS)

    // The guard must refuse this write regardless of how "trusted" the
    // session's boot was -- it's a permanent, stateless rule now, not a
    // one-shot latch that only ever covered recovery boots.
    expect(localStorage.getItem(LAYOUT_STORAGE_KEY)).toBe(originalRaw)
    // And the prior layout is backed up regardless.
    expect(localStorage.getItem(LAYOUT_BACKUP_STORAGE_KEY)).toBe(originalRaw)
  })
})
