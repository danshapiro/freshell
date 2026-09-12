import { beforeEach, describe, expect, it, vi } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import terminalDirectoryReducer from '@/store/terminalDirectorySlice'
import sessionActivityReducer from '@/store/sessionActivitySlice'
import tabsReducer, { addTab, closeTab } from '@/store/tabsSlice'
import panesReducer, { initLayout } from '@/store/panesSlice'
import { reconcileTerminalSessionAssociation } from '@/lib/terminal-session-association'
import {
  _resetTerminalDirectoryThunkControllers,
  fetchTerminalDirectoryWindow,
  loadTerminalSearch,
} from '@/store/terminalDirectoryThunks'

const getTerminalDirectoryPage = vi.fn()
const searchTerminalView = vi.fn()

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getTerminalDirectoryPage: (...args: any[]) => getTerminalDirectoryPage(...args),
    searchTerminalView: (...args: any[]) => searchTerminalView(...args),
  }
})

const { paneCloseAckHandlers, midWaitAssociation } = vi.hoisted(() => ({
  paneCloseAckHandlers: new Set<(msg: unknown) => void>(),
  midWaitAssociation: { onPanesClosed: null as null | (() => void) },
}))

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    send: (msg: unknown) => {
      const m = msg as { type?: string; requestId?: string }
      if (m?.type === 'panes.closed' && m.requestId) {
        // The mid-ack-wait moment: after closeTab captured its frozen
        // snapshot and sent the batch close, BEFORE the ack answers —
        // exactly when App.tsx would route a terminal.session.associated
        // frame (App.tsx:1278-1296).
        midWaitAssociation.onPanesClosed?.()
        for (const handler of [...paneCloseAckHandlers]) {
          handler({ type: 'panes.closed.result', requestId: m.requestId, success: true })
        }
      }
    },
    onMessage: (handler: (msg: unknown) => void) => {
      paneCloseAckHandlers.add(handler)
      return () => {
        paneCloseAckHandlers.delete(handler)
      }
    },
  }),
  resetWsClientForTests: vi.fn(),
}))

function createStore() {
  return configureStore({
    reducer: {
      terminalDirectory: terminalDirectoryReducer,
    },
  })
}

describe('terminalDirectoryThunks', () => {
  beforeEach(() => {
    getTerminalDirectoryPage.mockReset()
    searchTerminalView.mockReset()
    _resetTerminalDirectoryThunkControllers()
  })

  it('loads a visible terminal directory window into the requested surface', async () => {
    getTerminalDirectoryPage.mockResolvedValue({
      items: [
        {
          terminalId: 'term-1',
          title: 'Codex',
          createdAt: 1,
          lastActivityAt: 10,
          status: 'running',
          hasClients: false,
          mode: 'codex',
          resumeSessionId: 'sess-1',
        },
      ],
      nextCursor: 'cursor-1',
      revision: 10,
    })

    const store = createStore()
    await store.dispatch(fetchTerminalDirectoryWindow({
      surface: 'sidebar',
      priority: 'visible',
    }) as any)

    expect(getTerminalDirectoryPage).toHaveBeenCalledWith(
      { priority: 'visible' },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    expect(store.getState().terminalDirectory.windows.sidebar.items[0]?.terminalId).toBe('term-1')
    expect(store.getState().terminalDirectory.windows.sidebar.nextCursor).toBe('cursor-1')
  })

  it('appends using the stored nextCursor when loading more', async () => {
    getTerminalDirectoryPage
      .mockResolvedValueOnce({
        items: [
          {
            terminalId: 'term-1',
            title: 'Codex',
            createdAt: 1,
            lastActivityAt: 10,
            status: 'running',
            hasClients: false,
          },
        ],
        nextCursor: 'cursor-1',
        revision: 10,
      })
      .mockResolvedValueOnce({
        items: [
          {
            terminalId: 'term-2',
            title: 'Shell',
            createdAt: 2,
            lastActivityAt: 9,
            status: 'running',
            hasClients: false,
          },
        ],
        nextCursor: null,
        revision: 10,
      })

    const store = createStore()
    await store.dispatch(fetchTerminalDirectoryWindow({
      surface: 'background',
      priority: 'visible',
    }) as any)
    await store.dispatch(fetchTerminalDirectoryWindow({
      surface: 'background',
      priority: 'visible',
      append: true,
    }) as any)

    expect(getTerminalDirectoryPage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        priority: 'visible',
        cursor: 'cursor-1',
        revision: 10,
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    expect(store.getState().terminalDirectory.windows.background.items.map((item) => item.terminalId)).toEqual([
      'term-1',
      'term-2',
    ])
  })

  it('loads server-owned search results for a terminal', async () => {
    searchTerminalView.mockResolvedValue({
      matches: [
        { line: 3, column: 2, text: 'needle one' },
        { line: 7, column: 0, text: 'needle two' },
      ],
      nextCursor: null,
    })

    const store = createStore()
    await store.dispatch(loadTerminalSearch({
      terminalId: 'term-9',
      query: 'needle',
    }) as any)

    expect(searchTerminalView).toHaveBeenCalledWith(
      'term-9',
      { query: 'needle' },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    expect(store.getState().terminalDirectory.searches['term-9']).toEqual(expect.objectContaining({
      query: 'needle',
      activeIndex: 0,
    }))
  })

  it('aborts an in-flight search when a new query replaces it', async () => {
    const signals: AbortSignal[] = []

    searchTerminalView
      .mockImplementationOnce((_terminalId: string, _query: { query: string }, options: { signal?: AbortSignal }) => {
        if (options.signal) signals.push(options.signal)
        return new Promise((resolve) => {
          options.signal?.addEventListener('abort', () => resolve(undefined), { once: true })
        })
      })
      .mockImplementationOnce((_terminalId: string, _query: { query: string }, options: { signal?: AbortSignal }) => {
        if (options.signal) signals.push(options.signal)
        return Promise.resolve({
          matches: [{ line: 4, column: 0, text: 'needle two' }],
          nextCursor: null,
        })
      })

    const store = createStore()
    const firstDispatch = store.dispatch(loadTerminalSearch({
      terminalId: 'term-9',
      query: 'need',
    }) as any)

    await Promise.resolve()

    await store.dispatch(loadTerminalSearch({
      terminalId: 'term-9',
      query: 'needle',
    }) as any)

    expect(signals).toHaveLength(2)
    expect(signals[0].aborted).toBe(true)
    expect(signals[1].aborted).toBe(false)
    await expect(firstDispatch).resolves.toBeUndefined()
  })
})

describe('directory alias fold on application (all providers)', () => {
  // A terminal closed while identity-less had its close-tab touch recorded
  // under <provider>:terminal:<terminalId> (liveTerminalRowIdentity's
  // identity-less live-terminal row key). When the still-running terminal
  // later gains canonical identity — a sessionRef for ANY provider, or codex
  // durability for codex terminals — the sidebar rekeys the row to the
  // canonical key (mirroring directoryItemCanonicalIdentity /
  // buildSessionItems' runningSessionMap in selectors/sidebarSelectors.ts),
  // so the applied page must fold the alias across. Refreshes reach the
  // thunk on every terminals.changed / terminal.meta.updated broadcast and
  // on (re)connect, regardless of whether any pane is still mounted — the
  // applied directory page is the store-level binding point. The all-provider
  // pass is also the ONLY heal for a binding that arrived during closeTab's
  // ack wait (see the mid-ack-wait stranding describe below): its
  // association-reconcile fold ran before the ratchet wrote the alias, and
  // the once-per-binding broadcast never re-fires.

  beforeEach(() => {
    getTerminalDirectoryPage.mockReset()
    _resetTerminalDirectoryThunkControllers()
  })

  const CANDIDATE = {
    provider: 'codex',
    candidateThreadId: 'cand-1',
    rolloutPath: '/tmp/rollout-cand-1.jsonl',
    source: 'thread_start_response',
    capturedAt: 1,
  } as const

  function codexItem(codexDurability: Record<string, unknown>) {
    return {
      terminalId: 'term-cx-1',
      title: 'Codex',
      createdAt: 1,
      lastActivityAt: 10,
      status: 'running',
      hasClients: false,
      mode: 'codex',
      codexDurability,
    }
  }

  function createStoreWithActivity(sessions: Record<string, number>) {
    return configureStore({
      reducer: {
        terminalDirectory: terminalDirectoryReducer,
        sessionActivity: sessionActivityReducer,
      },
      preloadedState: {
        sessionActivity: { sessions },
      },
    })
  }

  it('folds the alias timestamp into codex:<durabilitySessionId> when the applied page carries durable identity', async () => {
    getTerminalDirectoryPage.mockResolvedValue({
      items: [codexItem({ schemaVersion: 1, state: 'durable', durableThreadId: 'durable-1' })],
      nextCursor: null,
      revision: 11,
    })

    const store = createStoreWithActivity({ 'codex:terminal:term-cx-1': 1111 })
    await store.dispatch(fetchTerminalDirectoryWindow({
      surface: 'sidebar',
      priority: 'visible',
    }) as any)

    expect(store.getState().sessionActivity.sessions['codex:durable-1']).toBe(1111)
  })

  it('folds candidate-only durability identity the same way (identity_pending rekeys the row too)', async () => {
    getTerminalDirectoryPage.mockResolvedValue({
      items: [codexItem({ schemaVersion: 1, state: 'identity_pending', candidate: CANDIDATE })],
      nextCursor: null,
      revision: 12,
    })

    const store = createStoreWithActivity({ 'codex:terminal:term-cx-1': 2222 })
    await store.dispatch(fetchTerminalDirectoryWindow({
      surface: 'sidebar',
      priority: 'visible',
    }) as any)

    expect(store.getState().sessionActivity.sessions['codex:cand-1']).toBe(2222)
  })

  it('never lowers an already-newer canonical timestamp (ratchet non-regression)', async () => {
    getTerminalDirectoryPage.mockResolvedValue({
      items: [codexItem({ schemaVersion: 1, state: 'durable', durableThreadId: 'durable-1' })],
      nextCursor: null,
      revision: 13,
    })

    const store = createStoreWithActivity({
      'codex:terminal:term-cx-1': 1111,
      'codex:durable-1': 9999,
    })
    await store.dispatch(fetchTerminalDirectoryWindow({
      surface: 'sidebar',
      priority: 'visible',
    }) as any)

    expect(store.getState().sessionActivity.sessions['codex:durable-1']).toBe(9999)
  })

  it('writes nothing when no alias activity exists for the terminal', async () => {
    getTerminalDirectoryPage.mockResolvedValue({
      items: [codexItem({ schemaVersion: 1, state: 'durable', durableThreadId: 'durable-1' })],
      nextCursor: null,
      revision: 14,
    })

    const store = createStoreWithActivity({})
    await store.dispatch(fetchTerminalDirectoryWindow({
      surface: 'sidebar',
      priority: 'visible',
    }) as any)

    expect(store.getState().sessionActivity.sessions['codex:durable-1']).toBeUndefined()
    expect(Object.keys(store.getState().sessionActivity.sessions)).toHaveLength(0)
  })

  it('writes nothing when the applied item carries no durability identity', async () => {
    getTerminalDirectoryPage.mockResolvedValue({
      items: [codexItem({ schemaVersion: 1, state: 'identity_pending' })],
      nextCursor: null,
      revision: 15,
    })

    const store = createStoreWithActivity({ 'codex:terminal:term-cx-1': 3333 })
    await store.dispatch(fetchTerminalDirectoryWindow({
      surface: 'sidebar',
      priority: 'visible',
    }) as any)

    // The identity-less fallback row is still the one shown; the alias must
    // not be folded onto a session that does not exist.
    expect(store.getState().sessionActivity.sessions['codex:terminal:term-cx-1']).toBe(3333)
    expect(Object.keys(store.getState().sessionActivity.sessions)).toHaveLength(1)
  })

  it('folds the alias timestamp into <provider>:<sessionId> for non-codex sessionRef identity (all providers)', async () => {
    // The mid-ack-wait stranding class for non-codex providers: a claude/
    // opencode binding that lands after the close wrote the alias has no
    // codex durability lane — the sessionRef-keyed applied page is the only
    // fold this alias ever gets.
    getTerminalDirectoryPage.mockResolvedValue({
      items: [{
        terminalId: 'term-op-9',
        title: 'OpenCode',
        createdAt: 1,
        lastActivityAt: 10,
        status: 'running',
        hasClients: false,
        mode: 'opencode',
        sessionRef: { provider: 'opencode', sessionId: 's-op-9' },
      }],
      nextCursor: null,
      revision: 16,
    })

    const store = createStoreWithActivity({ 'opencode:terminal:term-op-9': 5555 })
    await store.dispatch(fetchTerminalDirectoryWindow({
      surface: 'sidebar',
      priority: 'visible',
    }) as any)

    expect(store.getState().sessionActivity.sessions['opencode:s-op-9']).toBe(5555)
  })

  it('writes nothing for a non-codex item with no alias activity entry (the common case)', async () => {
    getTerminalDirectoryPage.mockResolvedValue({
      items: [{
        terminalId: 'term-cl-4',
        title: 'Claude',
        createdAt: 1,
        lastActivityAt: 10,
        status: 'running',
        hasClients: false,
        mode: 'claude',
        sessionRef: { provider: 'claude', sessionId: 's-cl-4' },
      }],
      nextCursor: null,
      revision: 17,
    })

    const store = createStoreWithActivity({})
    await store.dispatch(fetchTerminalDirectoryWindow({
      surface: 'sidebar',
      priority: 'visible',
    }) as any)

    expect(store.getState().sessionActivity.sessions['claude:s-cl-4']).toBeUndefined()
    expect(Object.keys(store.getState().sessionActivity.sessions)).toHaveLength(0)
  })
})

describe('canonical rebind fold on directory refresh (snapshot swap)', () => {
  // The sidebar rows a running terminal under the directory item's own
  // sessionRef (buildSessionItems' runningSessionMap reads
  // state.terminalDirectory.windows.sidebar.items directly — the directory is
  // applied here and never passes through reconcileTerminalSessionAssociation).
  // The terminal.session.associated frame carrying previousSessionId is a
  // single transient broadcast: a client disconnected at rebind time (fresh
  // page load, second device) only ever sees the parent->child swap as two
  // consecutive directory snapshots for the same terminalId. The previous
  // window is the client's only record of the superseded identity, so the
  // canonical previous->new fold must run here too, ratchet-only.

  beforeEach(() => {
    getTerminalDirectoryPage.mockReset()
    _resetTerminalDirectoryThunkControllers()
  })

  function codexSessionItem(terminalId: string, sessionId: string) {
    return {
      terminalId,
      title: 'Codex',
      createdAt: 1,
      lastActivityAt: 10,
      status: 'running',
      hasClients: false,
      mode: 'codex',
      sessionRef: { provider: 'codex', sessionId },
    }
  }

  function createStoreWithActivity(sessions: Record<string, number>) {
    return configureStore({
      reducer: {
        terminalDirectory: terminalDirectoryReducer,
        sessionActivity: sessionActivityReducer,
      },
      preloadedState: {
        sessionActivity: { sessions },
      },
    })
  }

  async function fetchSidebarPage(store: ReturnType<typeof createStoreWithActivity>) {
    await store.dispatch(fetchTerminalDirectoryWindow({
      surface: 'sidebar',
      priority: 'visible',
    }) as any)
  }

  it('folds the superseded canonical timestamp onto the new identity when a refresh swaps the same terminal\'s sessionRef', async () => {
    getTerminalDirectoryPage
      .mockResolvedValueOnce({
        items: [codexSessionItem('term-cx-9', 'parent-1')],
        nextCursor: null,
        revision: 20,
      })
      .mockResolvedValueOnce({
        items: [codexSessionItem('term-cx-9', 'child-1')],
        nextCursor: null,
        revision: 21,
      })

    const store = createStoreWithActivity({ 'codex:parent-1': 4444 })
    await fetchSidebarPage(store)
    expect(store.getState().sessionActivity.sessions['codex:child-1']).toBeUndefined()

    await fetchSidebarPage(store)
    expect(store.getState().sessionActivity.sessions['codex:child-1']).toBe(4444)
    // The old key stays (ratchet-only, pruned by existing retention).
    expect(store.getState().sessionActivity.sessions['codex:parent-1']).toBe(4444)
  })

  it('never lowers an already-newer new-identity timestamp (ratchet non-regression)', async () => {
    getTerminalDirectoryPage
      .mockResolvedValueOnce({
        items: [codexSessionItem('term-cx-9', 'parent-1')],
        nextCursor: null,
        revision: 20,
      })
      .mockResolvedValueOnce({
        items: [codexSessionItem('term-cx-9', 'child-1')],
        nextCursor: null,
        revision: 21,
      })

    const store = createStoreWithActivity({ 'codex:parent-1': 4444, 'codex:child-1': 9999 })
    await fetchSidebarPage(store)
    await fetchSidebarPage(store)

    expect(store.getState().sessionActivity.sessions['codex:child-1']).toBe(9999)
  })

  it('writes nothing when the refreshed identity is unchanged', async () => {
    getTerminalDirectoryPage.mockResolvedValue({
      items: [codexSessionItem('term-cx-9', 'parent-1')],
      nextCursor: null,
      revision: 20,
    })

    const store = createStoreWithActivity({ 'codex:parent-1': 4444 })
    await fetchSidebarPage(store)
    await fetchSidebarPage(store)

    // No canonical->canonical fold happened: the map is untouched.
    expect(store.getState().sessionActivity.sessions).toEqual({ 'codex:parent-1': 4444 })
  })

  it('writes nothing when the previous window never carried the terminal (first sighting)', async () => {
    getTerminalDirectoryPage.mockResolvedValue({
      items: [codexSessionItem('term-cx-9', 'child-1')],
      nextCursor: null,
      revision: 20,
    })

    const store = createStoreWithActivity({ 'codex:parent-1': 4444 })
    await fetchSidebarPage(store)

    // There is no evidence the terminal ever stood for parent-1 on this
    // client, so nothing may move.
    expect(store.getState().sessionActivity.sessions).toEqual({ 'codex:parent-1': 4444 })
  })

  it('does not fold across providers (a provider change is not a rebind)', async () => {
    getTerminalDirectoryPage
      .mockResolvedValueOnce({
        items: [{
          terminalId: 'term-x-1',
          title: 'Claude',
          createdAt: 1,
          lastActivityAt: 10,
          status: 'running',
          hasClients: false,
          mode: 'claude',
          sessionRef: { provider: 'claude', sessionId: 'claude-1' },
        }],
        nextCursor: null,
        revision: 20,
      })
      .mockResolvedValueOnce({
        items: [codexSessionItem('term-x-1', 'child-1')],
        nextCursor: null,
        revision: 21,
      })

    const store = createStoreWithActivity({ 'claude:claude-1': 4444 })
    await fetchSidebarPage(store)
    await fetchSidebarPage(store)

    expect(store.getState().sessionActivity.sessions).toEqual({ 'claude:claude-1': 4444 })
  })
})

describe('mid-ack-wait identity binding stranding (composition)', () => {
  // LB-1 composition, end to end through the real thunks: an identity
  // binding delivered during closeTab's <=5s ack wait is routed through
  // reconcileTerminalSessionAssociation BEFORE the close-commit ratchet
  // writes the alias key, so Task 3's fold is a no-op on an empty source,
  // and the once-per-binding broadcast never re-fires. The ratchet then
  // reads the FROZEN identity-less directory snapshot and writes the alias
  // key — stranded. The next applied directory page carries the bound
  // identity, and the all-provider directory alias fold is the heal.

  beforeEach(() => {
    getTerminalDirectoryPage.mockReset()
    _resetTerminalDirectoryThunkControllers()
    midWaitAssociation.onPanesClosed = null
  })

  function identityLessOpencodeItem() {
    return {
      terminalId: 't-strand',
      title: 'OpenCode pane',
      createdAt: 1,
      lastActivityAt: 1,
      status: 'running',
      hasClients: true,
      mode: 'opencode',
    }
  }

  function boundOpencodeItem() {
    return {
      ...identityLessOpencodeItem(),
      sessionRef: { provider: 'opencode', sessionId: 's-strand' },
    }
  }

  it('heals a mid-ack-wait binding: the alias written by the close ratchet folds to canonical on the next applied page', async () => {
    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        sessionActivity: sessionActivityReducer,
        terminalDirectory: terminalDirectoryReducer,
      },
      preloadedState: {
        // The frozen directory window the ratchet reads at close-commit:
        // the terminal is identity-less here.
        terminalDirectory: {
          windows: { sidebar: { items: [identityLessOpencodeItem()] } },
          searches: {},
        },
      },
    })
    store.dispatch(addTab({ mode: 'opencode' }))
    const tabId = store.getState().tabs.tabs[0].id
    store.dispatch(initLayout({
      tabId,
      content: { kind: 'terminal', mode: 'opencode', terminalId: 't-strand' },
    }))

    // The binding lands mid-wait: the ws mock routes it through the real
    // reconcile the moment the batch close is sent (before the ack
    // answers), exactly as App.tsx routes a terminal.session.associated
    // frame. Task 3's fold no-ops — the alias does not exist yet.
    midWaitAssociation.onPanesClosed = () => {
      reconcileTerminalSessionAssociation({
        dispatch: store.dispatch,
        getState: store.getState,
        terminalId: 't-strand',
        sessionRef: { provider: 'opencode', sessionId: 's-strand' },
      })
    }
    const beforeClose = Date.now()
    await store.dispatch(closeTab(tabId))

    // The stranding (characterization): the ratchet wrote the alias under
    // the frozen identity-less directory item, and the association's one
    // fold opportunity already passed — the canonical key is untouched.
    const sessions = store.getState().sessionActivity.sessions
    expect(sessions['opencode:terminal:t-strand']).toBeGreaterThanOrEqual(beforeClose)
    expect(sessions['opencode:s-strand']).toBeUndefined()

    // The next applied page carries the bound identity — the directory
    // alias fold must land the alias's value on the canonical key.
    getTerminalDirectoryPage.mockResolvedValue({
      items: [boundOpencodeItem()],
      nextCursor: null,
      revision: 31,
    })
    await store.dispatch(fetchTerminalDirectoryWindow({
      surface: 'sidebar',
      priority: 'visible',
    }) as any)

    const folded = store.getState().sessionActivity.sessions
    expect(folded['opencode:s-strand']).toBe(sessions['opencode:terminal:t-strand'])
    // Ratchet-only: the source entry stays (pruned by existing retention).
    expect(folded['opencode:terminal:t-strand']).toBe(sessions['opencode:terminal:t-strand'])
  })
})
