import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { RootState } from '../../../../src/store/store'
import { startTabRegistrySync, SYNC_INTERVAL_MS } from '../../../../src/store/tabRegistrySync'

type Listener = () => void

function createState(): RootState {
  return {
    tabs: {
      tabs: [{
        id: 'tab-1',
        createRequestId: 'req-1',
        title: 'freshell',
        status: 'running',
        mode: 'shell',
        shell: 'system',
        createdAt: 1,
      }],
      activeTabId: 'tab-1',
      renameRequestTabId: null,
    },
    panes: {
      layouts: {
        'tab-1': {
          type: 'leaf',
          id: 'pane-1',
          content: {
            kind: 'terminal',
            createRequestId: 'req-pane-1',
            status: 'running',
            mode: 'shell',
            shell: 'system',
          },
        },
      },
      activePane: { 'tab-1': 'pane-1' },
      paneTitles: { 'tab-1': { 'pane-1': 'Shell' } },
      paneTitleSetByUser: {},
      renameRequestTabId: null,
      renameRequestPaneId: null,
      zoomedPane: {},
    },
    tabRegistry: {
      deviceId: 'local-device',
      deviceLabel: 'local-label',
      localOpen: [],
      remoteOpen: [],
      closed: [],
      localClosed: {},
      searchRangeDays: 30,
      loading: false,
    },
    connection: {
      status: 'ready',
      platform: 'linux',
      availableClis: {},
      serverInstanceId: 'srv-test',
    },
  } as unknown as RootState
}

describe('tabRegistrySync', () => {
  let listeners: Listener[]
  let wsMessageHandlers: Array<(msg: any) => void>
  let wsReconnectHandlers: Array<() => void>
  let state: RootState
  let dispatch: ReturnType<typeof vi.fn>
  let ws: any

  beforeEach(() => {
    vi.useFakeTimers()
    listeners = []
    wsMessageHandlers = []
    wsReconnectHandlers = []
    state = createState()
    dispatch = vi.fn()
    ws = {
      state: 'ready',
      sendTabsSyncPush: vi.fn(),
      sendTabsSyncQuery: vi.fn(),
      onMessage: (handler: (msg: any) => void) => {
        wsMessageHandlers.push(handler)
        return () => {
          wsMessageHandlers = wsMessageHandlers.filter((item) => item !== handler)
        }
      },
      onReconnect: (handler: () => void) => {
        wsReconnectHandlers.push(handler)
        return () => {
          wsReconnectHandlers = wsReconnectHandlers.filter((item) => item !== handler)
        }
      },
    }
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('pushes tabs.sync only when lifecycle changes', () => {
    const store = {
      getState: () => state,
      dispatch,
      subscribe: (listener: Listener) => {
        listeners.push(listener)
        return () => {
          listeners = listeners.filter((item) => item !== listener)
        }
      },
    }

    const stop = startTabRegistrySync(store as any, ws)
    expect(ws.sendTabsSyncQuery).toHaveBeenCalledTimes(1)
    expect(ws.sendTabsSyncQuery.mock.calls[0][0].rangeDays).toBeUndefined()
    expect(ws.sendTabsSyncPush).toHaveBeenCalledTimes(1)

    ws.sendTabsSyncPush.mockClear()
    vi.advanceTimersByTime(SYNC_INTERVAL_MS)
    expect(ws.sendTabsSyncPush).toHaveBeenCalledTimes(0)

    state = {
      ...state,
      tabs: {
        ...state.tabs,
        tabs: state.tabs.tabs.map((tab) => ({ ...tab, title: 'renamed' })),
      },
    }
    for (const listener of listeners) listener()
    expect(ws.sendTabsSyncPush).toHaveBeenCalledTimes(1)

    stop()
  })

  it('includes expanded search range when querying snapshots', () => {
    state = {
      ...state,
      tabRegistry: {
        ...state.tabRegistry,
        searchRangeDays: 90,
      },
    }

    const store = {
      getState: () => state,
      dispatch,
      subscribe: (listener: Listener) => {
        listeners.push(listener)
        return () => {
          listeners = listeners.filter((item) => item !== listener)
        }
      },
    }

    const stop = startTabRegistrySync(store as any, ws)
    expect(ws.sendTabsSyncQuery).toHaveBeenCalledTimes(1)
    expect(ws.sendTabsSyncQuery.mock.calls[0][0].rangeDays).toBe(90)
    stop()
  })

  it('applies tabs.sync.snapshot responses into store dispatch', () => {
    const store = {
      getState: () => state,
      dispatch,
      subscribe: (listener: Listener) => {
        listeners.push(listener)
        return () => {
          listeners = listeners.filter((item) => item !== listener)
        }
      },
    }

    const stop = startTabRegistrySync(store as any, ws)
    const queryCall = ws.sendTabsSyncQuery.mock.calls[0][0]
    const requestId = queryCall.requestId

    wsMessageHandlers.forEach((handler) => handler({
      type: 'tabs.sync.snapshot',
      requestId,
      data: {
        localOpen: [],
        remoteOpen: [],
        closed: [],
      },
    }))

    expect(dispatch.mock.calls.some((call) => call[0]?.type === 'tabRegistry/setTabRegistrySnapshot')).toBe(true)
    stop()
  })
})
