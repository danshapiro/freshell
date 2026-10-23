import { configureStore } from '@reduxjs/toolkit'
import { describe, expect, it } from 'vitest'
import {
  foldTerminalInventoryTitles,
  recordTerminalTitleForReplay,
  replayTerminalInventoryTitles,
  terminalInventoryTitleReplayMiddleware,
} from '@/lib/terminal-inventory-titles'
import tabsReducer, { addTab } from '@/store/tabsSlice'
import panesReducer, { initCopiedLayout, initLayout, updatePaneTitle, updatePaneTitleByTerminalId } from '@/store/panesSlice'
import { applyPaneRename } from '@/store/titleSync'

function seedTerminalPane(store: ReturnType<typeof buildStore>, tabId: string, paneId: string, terminalId: string) {
  store.dispatch(addTab({ id: tabId, title: tabId }))
  store.dispatch(initLayout({
    tabId, paneId,
    content: { kind: 'terminal', mode: 'shell', shell: 'wsl', terminalId, createRequestId: `cr-${terminalId}`, status: 'running' },   // 'running' — a real TerminalStatus (src/store/types.ts:1) for an anchored pane, per paneSessionTitleSync.test.ts's terminal fixtures
  }))
}

function buildStore() {
  return configureStore({
    reducer: { tabs: tabsReducer, panes: panesReducer },
    middleware: (gDM) => gDM().concat(terminalInventoryTitleReplayMiddleware),
  })
}

function buildBareStore() {
  return configureStore({ reducer: { tabs: tabsReducer, panes: panesReducer } })
}

function titlesForTerminal(store: ReturnType<typeof buildStore>, terminalId: string): string[] {
  const titles: string[] = []
  for (const [tabId, layout] of Object.entries(store.getState().panes.layouts ?? {})) {
    const walk = (node: unknown): void => {
      const n = node as { type?: string; id?: string; content?: { kind?: string; terminalId?: string }; children?: unknown[] } | null
      if (!n || typeof n !== 'object') return
      if (n.type === 'leaf') {
        if (n.content?.kind === 'terminal' && n.content.terminalId === terminalId) {
          titles.push(store.getState().panes.paneTitles?.[tabId]?.[n.id ?? ''] ?? '')
        }
        return
      }
      for (const child of n.children ?? []) walk(child)
    }
    walk(layout)
  }
  return titles
}

describe('foldTerminalInventoryTitles', () => {
  it('writes the inventory title into the matching pane (auto source, not user-set)', () => {
    const store = buildStore()
    seedTerminalPane(store, 'tab-1', 'pane-1', 't-9')
    const n = foldTerminalInventoryTitles(store, [{ terminalId: 't-9', title: 'Renamed by sweep' }])
    expect(n).toBe(1)
    expect(store.getState().panes.paneTitles['tab-1']['pane-1']).toBe('Renamed by sweep')
    expect(store.getState().panes.paneTitleSetByUser['tab-1']?.['pane-1']).toBeFalsy()
  })

  /**
   * Unified agent names (Task 5): a scoped coding-agent terminal pane never
   * takes the terminal-level title pipeline's fold — its display is the
   * canonical session name from the sessionNames cache, so an unrevisioned
   * inventory string cannot land on it (shell panes keep the fold above).
   */
  it('never folds an inventory title into a scoped coding-agent terminal pane', () => {
    const store = buildStore()
    store.dispatch(addTab({ id: 'tab-scoped', title: 'tab-scoped' }))
    store.dispatch(initLayout({
      tabId: 'tab-scoped',
      paneId: 'pane-scoped',
      content: { kind: 'terminal', mode: 'claude', terminalId: 't-scoped', createRequestId: 'cr-scoped', status: 'running' },
    }))
    const n = foldTerminalInventoryTitles(store, [{ terminalId: 't-scoped', title: 'Stale inventory string' }])
    expect(n).toBe(0)
    expect(store.getState().panes.paneTitles['tab-scoped']?.['pane-scoped']).toBe('Claude')
    expect(store.getState().panes.paneTitleSetByUser['tab-scoped']?.['pane-scoped']).toBeFalsy()
  })

  it('never overwrites a user-set pane title (and does not count it as a fold)', () => {
    const store = buildStore()
    seedTerminalPane(store, 'tab-1', 'pane-1', 't-9')
    store.dispatch(updatePaneTitle({ tabId: 'tab-1', paneId: 'pane-1', title: 'My own name', setByUser: true }))
    expect(foldTerminalInventoryTitles(store, [{ terminalId: 't-9', title: 'Sweep title' }])).toBe(0)
    expect(store.getState().panes.paneTitles['tab-1']['pane-1']).toBe('My own name')
  })

  it('skips rows without a title and terminals with no matching pane', () => {
    const store = buildStore()
    seedTerminalPane(store, 'tab-1', 'pane-1', 't-9')
    expect(foldTerminalInventoryTitles(store, [{ terminalId: 't-9' }, { terminalId: 't-unknown', title: 'X' }])).toBe(0)
  })

  it('does not dispatch when the pane title already equals the inventory title', () => {
    const store = buildStore()
    seedTerminalPane(store, 'tab-1', 'pane-1', 't-9')
    store.dispatch(updatePaneTitle({ tabId: 'tab-1', paneId: 'pane-1', title: 'Same', setByUser: false }))
    const before = store.getState()
    expect(foldTerminalInventoryTitles(store, [{ terminalId: 't-9', title: 'Same' }])).toBe(0)
    expect(store.getState().panes).toBe(before.panes)
  })

  it('folds every differing row in one call', () => {
    const store = buildStore()
    seedTerminalPane(store, 'tab-a', 'pane-a', 't-a-9')
    seedTerminalPane(store, 'tab-b', 'pane-b', 't-b-9')
    store.dispatch(updatePaneTitle({ tabId: 'tab-a', paneId: 'pane-a', title: 'A title', setByUser: false }))
    const n = foldTerminalInventoryTitles(store, [
      { terminalId: 't-a-9', title: 'A title' },
      { terminalId: 't-b-9', title: 'B title' },
    ])
    expect(n).toBe(1)
    expect(store.getState().panes.paneTitles['tab-b']['pane-b']).toBe('B title')
  })
})

// Delta review round 2, finding 2: the fold is a ONE-SHOT scan per frame,
// but a recovered terminal pane gets its terminalId only AFTER the boot
// frame (recovery builds panes without terminalId; live reattachment /
// reconcile adds it later; terminal.attach.ready carries no title) — so
// nothing replays the fold and the pane keeps its derived default until
// the next reconnect. The fold caches the latest frame's titles per
// terminalId, and a replay (manual or middleware-driven on the
// terminalId-binding actions) re-applies them.
describe('terminal inventory title cache + replay', () => {
  function seedUnanchoredPane(store: ReturnType<typeof buildStore>) {
    store.dispatch(addTab({ id: 'tab-1', title: 'tab-1' }))
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: { kind: 'terminal', mode: 'shell', shell: 'wsl', createRequestId: 'cr-t-9', status: 'creating' },
    }))
  }

  function anchorPane(store: ReturnType<typeof buildStore>, terminalId: string) {
    store.dispatch({
      type: 'panes/updatePaneContent',
      payload: {
        tabId: 'tab-1',
        paneId: 'pane-1',
        content: { kind: 'terminal', mode: 'shell', shell: 'wsl', createRequestId: 'cr-t-9', terminalId, status: 'running' },
      },
    })
  }

  it('caches the frame\u2019s titled rows and applies a cached title when the terminalId binds later — with NO new frame (replay entry point, bare store)', () => {
    const store = buildBareStore()
    seedUnanchoredPane(store)
    expect(foldTerminalInventoryTitles(store, [{ terminalId: 't-9', title: 'Recovered title' }])).toBe(0)
    anchorPane(store, 't-9')
    expect(replayTerminalInventoryTitles(store)).toBe(1)
    expect(store.getState().panes.paneTitles['tab-1']['pane-1']).toBe('Recovered title')
    expect(store.getState().panes.paneTitleSetByUser['tab-1']?.['pane-1']).toBeFalsy()
  })

  const SHELL_CONTENT = (terminalId: string, createRequestId: string) => ({
    kind: 'terminal', mode: 'shell', shell: 'wsl', terminalId, createRequestId, status: 'running',
  })

  // The verified terminalId-binding actions (delta review round 2, finding
  // 2): every generated panes action that can write a terminalId into pane
  // content must replay the cached inventory titles.
  const BINDING_ACTION_CASES: Array<{ name: string; seed: (store: ReturnType<typeof buildStore>) => void; dispatch: (store: ReturnType<typeof buildStore>) => void }> = [
    {
      name: 'panes/updatePaneContent',
      seed: (store) => seedUnanchoredPane(store),
      dispatch: (store) => anchorPane(store, 't-9'),
    },
    {
      name: 'panes/applyReconcileAttach',
      seed: (store) => seedUnanchoredPane(store),
      dispatch: (store) => store.dispatch({
        type: 'panes/applyReconcileAttach',
        payload: { tabId: 'tab-1', paneId: 'pane-1', terminalId: 't-9' },
      }),
    },
    {
      name: 'panes/applyReattachToLiveTerminal',
      seed: (store) => seedUnanchoredPane(store),
      dispatch: (store) => store.dispatch({
        type: 'panes/applyReattachToLiveTerminal',
        payload: { tabId: 'tab-1', paneId: 'pane-1', terminalId: 't-9' },
      }),
    },
    {
      name: 'panes/initLayout',
      seed: (store) => store.dispatch(addTab({ id: 'tab-1', title: 'tab-1' })),
      dispatch: (store) => store.dispatch(initLayout({
        tabId: 'tab-1', paneId: 'pane-1', content: SHELL_CONTENT('t-9', 'cr-init'),
      })),
    },
    {
      name: 'panes/hydratePanes',
      seed: () => {},
      dispatch: (store) => store.dispatch({
        type: 'panes/hydratePanes',
        payload: {
          layouts: { 'tab-1': { type: 'leaf', id: 'pane-1', content: SHELL_CONTENT('t-9', 'cr-hydrate') } },
          activePane: { 'tab-1': 'pane-1' },
          paneTitles: {},
          paneTitleSetByUser: {},
        },
      }),
    },
    {
      name: 'panes/initCopiedLayout',
      seed: (store) => store.dispatch(addTab({ id: 'tab-1', title: 'tab-1' })),
      dispatch: (store) => store.dispatch(initCopiedLayout({
        tabId: 'tab-1',
        layout: { type: 'leaf', id: 'pane-1', content: SHELL_CONTENT('t-9', 'cr-copy') as never },
      })),
    },
    {
      name: 'panes/splitPane',
      seed: (store) => {
        store.dispatch(addTab({ id: 'tab-1', title: 'tab-1' }))
        store.dispatch(initLayout({
          tabId: 'tab-1', paneId: 'pane-1',
          content: { kind: 'terminal', mode: 'shell', shell: 'wsl', createRequestId: 'cr-keep', status: 'running' },
        }))
      },
      dispatch: (store) => store.dispatch({
        type: 'panes/splitPane',
        payload: {
          tabId: 'tab-1', paneId: 'pane-1', direction: 'horizontal',
          newContent: SHELL_CONTENT('t-9', 'cr-split'),
        },
      }),
    },
    {
      name: 'panes/addPane',
      seed: (store) => {
        store.dispatch(addTab({ id: 'tab-1', title: 'tab-1' }))
        store.dispatch(initLayout({
          tabId: 'tab-1', paneId: 'pane-1',
          content: { kind: 'terminal', mode: 'shell', shell: 'wsl', createRequestId: 'cr-keep', status: 'running' },
        }))
      },
      dispatch: (store) => store.dispatch({
        type: 'panes/addPane',
        payload: { tabId: 'tab-1', newContent: SHELL_CONTENT('t-9', 'cr-add') },
      }),
    },
  ]

  it.each(BINDING_ACTION_CASES)('replays cached titles when $name binds the terminalId', ({ seed, dispatch }) => {
    const store = buildStore()
    seed(store)
    expect(foldTerminalInventoryTitles(store, [{ terminalId: 't-9', title: 'Bound later' }])).toBe(0)
    dispatch(store)
    const titles = titlesForTerminal(store, 't-9')
    expect(titles.length).toBeGreaterThan(0)
    expect(titles).toContain('Bound later')
    expect(store.getState().panes.paneTitleSetByUser['tab-1']?.['pane-1']).toBeFalsy()
  })

  it('does NOT wire panes/restoreLayout: stripStaleIds strips terminalId from restored content, so restored panes re-anchor fresh (no replay target)', () => {
    const store = buildStore()
    store.dispatch(addTab({ id: 'tab-1', title: 'tab-1' }))
    expect(foldTerminalInventoryTitles(store, [{ terminalId: 't-9', title: 'Not a binding action' }])).toBe(0)
    store.dispatch({
      type: 'panes/restoreLayout',
      payload: {
        tabId: 'tab-1',
        layout: { type: 'leaf', id: 'pane-1', content: SHELL_CONTENT('t-9', 'cr-restore') },
        paneTitles: {},
      },
    })
    expect(titlesForTerminal(store, 't-9')).toEqual([])
    expect(store.getState().panes.paneTitles['tab-1']?.['pane-1']).toBeUndefined()
  })

  it('never overwrites a user-set pane title on replay (and does not count it)', () => {
    const store = buildStore()
    seedUnanchoredPane(store)
    store.dispatch(updatePaneTitle({ tabId: 'tab-1', paneId: 'pane-1', title: 'My own name', setByUser: true }))
    expect(foldTerminalInventoryTitles(store, [{ terminalId: 't-9', title: 'Sweep title' }])).toBe(0)
    anchorPane(store, 't-9')
    expect(replayTerminalInventoryTitles(store)).toBe(0)
    expect(store.getState().panes.paneTitles['tab-1']['pane-1']).toBe('My own name')
  })

  it('a new frame REPLACES the cache (a terminal dropped from the frame no longer replays; the refreshed title re-applies)', () => {
    const store = buildStore()
    seedUnanchoredPane(store)
    foldTerminalInventoryTitles(store, [{ terminalId: 't-9', title: 'First' }, { terminalId: 't-x', title: 'Dropped row' }])
    foldTerminalInventoryTitles(store, [{ terminalId: 't-9', title: 'Second' }])
    anchorPane(store, 't-9')
    expect(store.getState().panes.paneTitles['tab-1']['pane-1']).toBe('Second')
    const before = store.getState()
    expect(replayTerminalInventoryTitles(store)).toBe(0)
    expect(store.getState().panes).toBe(before.panes)
  })

  it('replay churn guard: a pane already holding the cached title dispatches nothing', () => {
    const store = buildStore()
    seedTerminalPane(store, 'tab-1', 'pane-1', 't-9')
    foldTerminalInventoryTitles(store, [{ terminalId: 't-9', title: 'Same' }])
    const before = store.getState()
    expect(replayTerminalInventoryTitles(store)).toBe(0)
    expect(store.getState().panes).toBe(before.panes)
  })
})

// e2r1 review finding 2 installed cache EVICTION on newer title writes;
// e2r2 review finding 3 corrected it to REPLACEMENT via middleware
// action-watching; e2r3 review finding 3 removes the action-watching
// ENTIRELY: a setByUser:false pane-addressed title write is not provably
// terminal-level — Sidebar.tsx:492 dispatches exactly that action with a
// SESSION-DIRECTORY title when an existing session pane is selected, and
// the watching let that wrong-scope title replace the cache entry, so a
// later binding action replayed it into sibling/recovered panes. The
// cache is now written ONLY by authoritative terminal-level sources: the
// inventory frame fold (frames replace the whole cache) and explicit
// recordTerminalTitleForReplay calls — the two live TerminalView handlers
// (terminal.title.updated, :4780; OSC onTitleChange, :2595) now make the
// call. The record REPLACES the entry, never deletes it. User or
// pane-local renames never touch the cache (no title action writes the
// cache at all). The module-level cache is shared across the whole file,
// so every test here owns a UNIQUE terminalId — a previous test's leaked
// cache entry then matches no pane in this test's store (vitest shuffles
// order).
describe('record-driven cache replacement + wrong-scope protection (e2r3 finding 3)', () => {
  function shellContentFor(tid: string, createRequestId: string) {
    return { kind: 'terminal', mode: 'shell', shell: 'wsl', terminalId: tid, createRequestId, status: 'running' } as const
  }

  function splitSecondPaneBound(store: ReturnType<typeof buildStore>, tid: string) {
    store.dispatch({
      type: 'panes/splitPane',
      payload: {
        tabId: 'tab-1', paneId: 'pane-1', direction: 'horizontal', newPaneId: 'pane-2',
        newContent: shellContentFor(tid, 'cr-split-2'),
      },
    })
  }

  it('a SESSION-DIRECTORY title write (Sidebar.tsx:492: updatePaneTitle setByUser:false to a bound session pane) does NOT touch the cache — a later replay serves the last TERMINAL title, not the session title', () => {
    const store = buildStore()
    seedTerminalPane(store, 'tab-1', 'pane-1', 't-ev-scope')
    expect(foldTerminalInventoryTitles(store, [{ terminalId: 't-ev-scope', title: 'Terminal title' }])).toBe(1)
    store.dispatch(updatePaneTitle({ tabId: 'tab-1', paneId: 'pane-1', title: 'Session directory title', setByUser: false }))
    expect(store.getState().panes.paneTitles['tab-1']['pane-1']).toBe('Session directory title')
    splitSecondPaneBound(store, 't-ev-scope')
    expect(store.getState().panes.paneTitles['tab-1']['pane-2']).toBe('Terminal title')
  })

  it('a live terminal-level title (the real handler flow: updatePaneTitle dispatch + the recordTerminalTitleForReplay call) REPLACES the entry: a late-bound pane receives the NEW title', () => {
    const store = buildStore()
    seedTerminalPane(store, 'tab-1', 'pane-1', 't-ev-live')
    expect(foldTerminalInventoryTitles(store, [{ terminalId: 't-ev-live', title: 'Boot snapshot' }])).toBe(1)
    store.dispatch(updatePaneTitle({ tabId: 'tab-1', paneId: 'pane-1', title: 'Live newer title', setByUser: false }))
    recordTerminalTitleForReplay('t-ev-live', 'Live newer title')
    expect(store.getState().panes.paneTitles['tab-1']['pane-1']).toBe('Live newer title')
    splitSecondPaneBound(store, 't-ev-live')
    expect(store.getState().panes.paneTitles['tab-1']['pane-2']).toBe('Live newer title')
  })

  it('a setByUser:false updatePaneTitleByTerminalId outside the fold (open-tab-with-title, tabsSlice.ts:1098) no longer replaces the cache — late-bound panes keep the last authoritative title', () => {
    const store = buildStore()
    seedTerminalPane(store, 'tab-1', 'pane-1', 't-ev-open')
    expect(foldTerminalInventoryTitles(store, [{ terminalId: 't-ev-open', title: 'Boot snapshot' }])).toBe(1)
    store.dispatch(updatePaneTitleByTerminalId({ terminalId: 't-ev-open', title: 'Open-tab title', setByUser: false }))
    splitSecondPaneBound(store, 't-ev-open')
    expect(store.getState().panes.paneTitles['tab-1']['pane-2']).toBe('Boot snapshot')
  })

  it('an EQUAL recorded title keeps the entry: a late-bound pane still replays', () => {
    const store = buildStore()
    seedTerminalPane(store, 'tab-1', 'pane-1', 't-ev-equal')
    expect(foldTerminalInventoryTitles(store, [{ terminalId: 't-ev-equal', title: 'Same title' }])).toBe(1)
    recordTerminalTitleForReplay('t-ev-equal', 'Same title')
    splitSecondPaneBound(store, 't-ev-equal')
    expect(store.getState().panes.paneTitles['tab-1']['pane-2']).toBe('Same title')
  })

  it('a record with no terminalId (an unbound pane\u2019s live title) is a no-op — the cache keeps the last authoritative title', () => {
    const store = buildStore()
    seedTerminalPane(store, 'tab-1', 'pane-1', 't-ev-unbound')
    foldTerminalInventoryTitles(store, [{ terminalId: 't-ev-unbound', title: 'Boot snapshot' }])
    recordTerminalTitleForReplay(undefined, 'Live newer title')
    splitSecondPaneBound(store, 't-ev-unbound')
    expect(store.getState().panes.paneTitles['tab-1']['pane-2']).toBe('Boot snapshot')
  })

  it('a user pane rename (setByUser:true) leaves the cache intact: sibling panes still receive the terminal title', () => {
    const store = buildStore()
    seedTerminalPane(store, 'tab-1', 'pane-1', 't-ev-user')
    expect(foldTerminalInventoryTitles(store, [{ terminalId: 't-ev-user', title: 'Boot snapshot' }])).toBe(1)
    store.dispatch(updatePaneTitleByTerminalId({ terminalId: 't-ev-user', title: 'My own name', setByUser: true }))
    splitSecondPaneBound(store, 't-ev-user')
    expect(store.getState().panes.paneTitles['tab-1']['pane-1']).toBe('My own name')
    expect(store.getState().panes.paneTitles['tab-1']['pane-2']).toBe('Boot snapshot')
  })

  it('a layout-local applyPaneRename never touches the cache: a late-bound sibling still receives the terminal title', () => {
    const store = buildStore()
    seedTerminalPane(store, 'tab-1', 'pane-1', 't-ev-rename')
    expect(foldTerminalInventoryTitles(store, [{ terminalId: 't-ev-rename', title: 'Boot snapshot' }])).toBe(1)
    store.dispatch(applyPaneRename({ tabId: 'tab-1', paneId: 'pane-1', title: 'Pane-local name' }))
    expect(store.getState().panes.paneTitles['tab-1']['pane-1']).toBe('Pane-local name')
    splitSecondPaneBound(store, 't-ev-rename')
    expect(store.getState().panes.paneTitles['tab-1']['pane-2']).toBe('Boot snapshot')
  })

  it('a new inventory frame re-populates the cache over a replaced entry (reconnect recovers)', () => {
    const store = buildStore()
    seedTerminalPane(store, 'tab-1', 'pane-1', 't-ev-refold')
    expect(foldTerminalInventoryTitles(store, [{ terminalId: 't-ev-refold', title: 'Boot snapshot' }])).toBe(1)
    recordTerminalTitleForReplay('t-ev-refold', 'Live newer title')
    expect(foldTerminalInventoryTitles(store, [{ terminalId: 't-ev-refold', title: 'Newest snapshot' }])).toBe(1)
    splitSecondPaneBound(store, 't-ev-refold')
    expect(store.getState().panes.paneTitles['tab-1']['pane-2']).toBe('Newest snapshot')
    expect(store.getState().panes.paneTitles['tab-1']['pane-1']).toBe('Newest snapshot')
  })
})
