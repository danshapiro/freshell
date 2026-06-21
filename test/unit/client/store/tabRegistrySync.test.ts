import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { RootState } from '../../../../src/store/store'
import {
  CLIENT_LEASE_GRACE_MS,
  getCurrentTabRegistryClientInstanceId,
  HEARTBEAT_INTERVAL_MS,
  startTabRegistrySync,
  SYNC_INTERVAL_MS,
} from '../../../../src/store/tabRegistrySync'

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
      tombstones: [],
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
      refreshRequestsByPane: {},
    },
    tabRecency: {
      paneLastInputAt: {},
    },
    tabRegistry: {
      deviceId: 'local-device',
      deviceLabel: 'local-label',
      localOpen: [],
      sameDeviceOpen: [],
      remoteOpen: [],
      closed: [],
      devices: [],
      localClosed: {},
      closedTabRetentionDays: 30,
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
  let broadcastChannels: Array<{
    name: string
    postMessage: ReturnType<typeof vi.fn>
    close: ReturnType<typeof vi.fn>
    onmessage: ((event: { data: any }) => void) | null
  }>

  function createStore() {
    return {
      getState: () => state,
      dispatch,
      subscribe: (listener: Listener) => {
        listeners.push(listener)
        return () => {
          listeners = listeners.filter((item) => item !== listener)
        }
      },
    }
  }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(1_740_000_000_000))
    listeners = []
    wsMessageHandlers = []
    wsReconnectHandlers = []
    broadcastChannels = []
    sessionStorage.clear()
    state = createState()
    dispatch = vi.fn()
    ws = {
      state: 'ready',
      sendTabsSyncPush: vi.fn(),
      sendTabsSyncQuery: vi.fn(),
      sendTabsSyncClientRetire: vi.fn(),
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
    class MockBroadcastChannel {
      name: string
      postMessage = vi.fn()
      close = vi.fn()
      onmessage: ((event: { data: any }) => void) | null = null

      constructor(name: string) {
        this.name = name
        broadcastChannels.push(this)
      }
    }
    vi.stubGlobal('BroadcastChannel', MockBroadcastChannel)
    vi.stubGlobal('navigator', {
      ...globalThis.navigator,
      sendBeacon: vi.fn(() => true),
    })
  })

  function createStore(customDispatch = dispatch) {
    return {
      getState: () => state,
      dispatch: customDispatch,
      subscribe: (listener: Listener) => {
        listeners.push(listener)
        return () => {
          listeners = listeners.filter((item) => item !== listener)
        }
      },
    }
  }

  afterEach(() => {
    vi.unstubAllGlobals()
    try {
      sessionStorage.clear()
    } catch {
      // Tests that intentionally block sessionStorage restore globals above.
    }
    vi.useRealTimers()
  })

  it('pushes tabs.sync only when lifecycle changes', () => {
    const store = createStore()

    const stop = startTabRegistrySync(store as any, ws)
    expect(ws.sendTabsSyncQuery).toHaveBeenCalledTimes(1)
    expect(ws.sendTabsSyncQuery.mock.calls[0][0]).toMatchObject({
      clientInstanceId: expect.any(String),
      closedTabRetentionDays: 30,
    })
    expect(ws.sendTabsSyncPush).toHaveBeenCalledTimes(1)
    expect(ws.sendTabsSyncPush.mock.calls[0][0]).toMatchObject({
      clientInstanceId: expect.any(String),
      snapshotRevision: expect.any(Number),
    })

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

  it('publishes materialized fresh-agent session refs instead of stale placeholders', () => {
    state = {
      ...state,
      panes: {
        ...state.panes,
        layouts: {
          'tab-1': {
            type: 'leaf',
            id: 'pane-1',
            content: {
              kind: 'fresh-agent',
              sessionType: 'freshopencode',
              provider: 'opencode',
              sessionId: 'freshopencode-req-sync',
              createRequestId: 'req-sync',
              status: 'running',
              resumeSessionId: 'freshopencode-req-sync',
              sessionRef: { provider: 'opencode', sessionId: 'freshopencode-req-sync' },
            },
          },
        },
        paneTitles: { 'tab-1': { 'pane-1': 'OpenCode' } },
      },
    }
    const store = createStore()
    const stop = startTabRegistrySync(store as any, ws)

    expect(ws.sendTabsSyncPush.mock.calls[0][0].records[0].panes[0].payload.sessionRef).toEqual({
      provider: 'opencode',
      sessionId: 'freshopencode-req-sync',
    })

    ws.sendTabsSyncPush.mockClear()
    state = {
      ...state,
      panes: {
        ...state.panes,
        layouts: {
          'tab-1': {
            type: 'leaf',
            id: 'pane-1',
            content: {
              kind: 'fresh-agent',
              sessionType: 'freshopencode',
              provider: 'opencode',
              sessionId: 'ses_sync_1',
              createRequestId: 'req-sync',
              status: 'running',
              resumeSessionId: 'ses_sync_1',
              sessionRef: { provider: 'opencode', sessionId: 'ses_sync_1' },
            },
          },
        },
      },
    }
    for (const listener of listeners) listener()

    expect(ws.sendTabsSyncPush).toHaveBeenCalledTimes(1)
    const pushedPane = ws.sendTabsSyncPush.mock.calls[0][0].records[0].panes[0]
    expect(pushedPane.payload.sessionRef).toEqual({
      provider: 'opencode',
      sessionId: 'ses_sync_1',
    })
    expect(pushedPane.payload).not.toHaveProperty('sessionId')
    expect(pushedPane.payload).not.toHaveProperty('resumeSessionId')

    stop()
  })

  it('includes selected closed retention when querying snapshots', () => {
    state = {
      ...state,
      tabRegistry: {
        ...state.tabRegistry,
        closedTabRetentionDays: 14,
        searchRangeDays: 14,
      },
    }

    const store = createStore()

    const stop = startTabRegistrySync(store as any, ws)
    expect(ws.sendTabsSyncQuery).toHaveBeenCalledTimes(1)
    expect(ws.sendTabsSyncQuery.mock.calls[0][0].closedTabRetentionDays).toBe(14)
    stop()
  })

  it('re-queries with the current closed retention after reconnect', () => {
    state = {
      ...state,
      tabRegistry: {
        ...state.tabRegistry,
        closedTabRetentionDays: 7,
        searchRangeDays: 7,
      },
    }

    const store = createStore()

    const stop = startTabRegistrySync(store as any, ws)
    ws.sendTabsSyncQuery.mockClear()

    wsReconnectHandlers.forEach((handler) => handler())

    expect(ws.sendTabsSyncQuery).toHaveBeenCalledTimes(1)
    expect(ws.sendTabsSyncQuery.mock.calls[0][0].closedTabRetentionDays).toBe(7)
    stop()
  })

  it('keeps one in-memory client id for push and direct query helpers when sessionStorage is unavailable', () => {
    vi.unstubAllGlobals()
    vi.stubGlobal('sessionStorage', {
      getItem: vi.fn(() => {
        throw new Error('blocked')
      }),
      setItem: vi.fn(() => {
        throw new Error('blocked')
      }),
      clear: vi.fn(),
    })
    vi.stubGlobal('BroadcastChannel', undefined)
    vi.stubGlobal('navigator', {
      ...globalThis.navigator,
      sendBeacon: vi.fn(() => true),
    })
    const firstClientId = getCurrentTabRegistryClientInstanceId()
    expect(getCurrentTabRegistryClientInstanceId()).toBe(firstClientId)
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
    expect(ws.sendTabsSyncPush.mock.calls[0][0].clientInstanceId).toBe(firstClientId)
    expect(ws.sendTabsSyncQuery.mock.calls[0][0].clientInstanceId).toBe(firstClientId)
    expect(getCurrentTabRegistryClientInstanceId()).toBe(firstClientId)
    stop()
  })

  it('applies tabs.sync.snapshot responses into store dispatch', () => {
    const store = createStore()

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

  it('ignores stale tabs.sync.snapshot responses for older retention queries', () => {
    const mutatingDispatch = vi.fn((action: any) => {
      dispatch(action)
      if (action?.type === 'tabRegistry/setTabRegistrySnapshot') {
        state = {
          ...state,
          tabRegistry: {
            ...state.tabRegistry,
            ...action.payload,
            loading: false,
          },
        }
      }
    })
    const stop = startTabRegistrySync(createStore(mutatingDispatch) as any, ws)
    const firstRequestId = ws.sendTabsSyncQuery.mock.calls[0][0].requestId
    state = {
      ...state,
      tabRegistry: {
        ...state.tabRegistry,
        closedTabRetentionDays: 7,
        searchRangeDays: 7,
      },
    }
    listeners.forEach((listener) => listener())
    const secondRequestId = ws.sendTabsSyncQuery.mock.calls[1][0].requestId

    wsMessageHandlers.forEach((handler) => handler({
      type: 'tabs.sync.snapshot',
      requestId: secondRequestId,
      data: {
        localOpen: [],
        sameDeviceOpen: [],
        remoteOpen: [],
        closed: [],
        devices: [],
      },
    }))
    wsMessageHandlers.forEach((handler) => handler({
      type: 'tabs.sync.snapshot',
      requestId: firstRequestId,
      data: {
        localOpen: [],
        sameDeviceOpen: [],
        remoteOpen: [],
        closed: [{ tabKey: 'closed-10-days' }],
        devices: [],
      },
    }))

    expect(state.tabRegistry.closed.map((record: any) => record.tabKey)).toEqual([])
    stop()
  })

  it('keeps the original lease stable and rotates only the duplicated sessionStorage client id', () => {
    const store = createStore()

    const stop = startTabRegistrySync(store as any, ws)
    const firstClientId = ws.sendTabsSyncPush.mock.calls[0][0].clientInstanceId
    expect(broadcastChannels).toHaveLength(1)
    const initialClaim = broadcastChannels[0].postMessage.mock.calls[0][0]

    broadcastChannels[0].onmessage?.({
      data: {
        type: 'tabs-registry-client-claim',
        clientInstanceId: firstClientId,
        leaseId: 'other-window',
      },
    })

    expect(ws.sendTabsSyncPush.mock.calls.at(-1)?.[0].clientInstanceId).toBe(firstClientId)
    expect(broadcastChannels[0].postMessage.mock.calls.at(-1)?.[0]).toMatchObject({
      type: 'tabs-registry-client-active',
      clientInstanceId: firstClientId,
      claimantLeaseId: 'other-window',
    })

    broadcastChannels[0].onmessage?.({
      data: {
        type: 'tabs-registry-client-active',
        clientInstanceId: firstClientId,
        leaseId: 'other-window',
        claimantLeaseId: initialClaim.leaseId,
      },
    })
    vi.advanceTimersByTime(CLIENT_LEASE_GRACE_MS)

    expect(ws.sendTabsSyncPush.mock.calls.at(-1)?.[0].clientInstanceId).not.toBe(firstClientId)
    expect(sessionStorage.getItem('freshell.tabs.client-instance-id.v1')).not.toBe(firstClientId)
    stop()
  })

  it('does not publish under a copied sessionStorage client id before lease collision resolution', () => {
    const copiedClientId = 'client-copied-window'
    sessionStorage.setItem('freshell.tabs.client-instance-id.v1', copiedClientId)
    sessionStorage.setItem('freshell.tabs.snapshot-revision.v1', '11')
    const stop = startTabRegistrySync(createStore() as any, ws)
    expect(ws.sendTabsSyncQuery).not.toHaveBeenCalled()
    expect(ws.sendTabsSyncPush).not.toHaveBeenCalled()
    const initialClaim = broadcastChannels[0].postMessage.mock.calls[0][0]

    broadcastChannels[0].onmessage?.({
      data: {
        type: 'tabs-registry-client-active',
        clientInstanceId: copiedClientId,
        leaseId: 'original-window',
        claimantLeaseId: initialClaim.leaseId,
      },
    })
    vi.advanceTimersByTime(CLIENT_LEASE_GRACE_MS)

    expect(ws.sendTabsSyncQuery).toHaveBeenCalledTimes(1)
    expect(ws.sendTabsSyncPush).toHaveBeenCalledTimes(1)
    expect(ws.sendTabsSyncQuery.mock.calls[0][0].clientInstanceId).not.toBe(copiedClientId)
    expect(ws.sendTabsSyncPush.mock.calls[0][0].clientInstanceId).not.toBe(copiedClientId)
    stop()
  })

  it('preserves the sessionStorage client id and advances revision across reloads', () => {
    const firstStop = startTabRegistrySync(createStore() as any, ws)
    const firstPush = ws.sendTabsSyncPush.mock.calls[0][0]
    firstStop()

    ws.sendTabsSyncPush.mockClear()
    const secondStop = startTabRegistrySync(createStore() as any, ws)
    vi.advanceTimersByTime(CLIENT_LEASE_GRACE_MS)
    const secondPush = ws.sendTabsSyncPush.mock.calls[0][0]

    expect(secondPush.clientInstanceId).toBe(firstPush.clientInstanceId)
    expect(secondPush.snapshotRevision).toBeGreaterThan(firstPush.snapshotRevision)
    secondStop()
  })

  it('assigns a distinct client id to another active window without shared sessionStorage', () => {
    const firstStop = startTabRegistrySync(createStore() as any, ws)
    const firstClientId = ws.sendTabsSyncPush.mock.calls[0][0].clientInstanceId

    sessionStorage.clear()
    ws.sendTabsSyncPush.mockClear()
    const secondStop = startTabRegistrySync(createStore() as any, ws)
    const secondClientId = ws.sendTabsSyncPush.mock.calls[0][0].clientInstanceId

    expect(secondClientId).not.toBe(firstClientId)
    secondStop()
    firstStop()
  })

  it('does not send stale localClosed records from a previous server instance', () => {
    state = {
      ...state,
      connection: {
        ...state.connection,
        serverInstanceId: 'srv-new',
      },
      tabRegistry: {
        ...state.tabRegistry,
        localClosed: {
          stale: {
            tabKey: 'local:stale',
            tabId: 'stale',
            serverInstanceId: 'srv-old',
            deviceId: 'local-device',
            deviceLabel: 'local-label',
            tabName: 'stale',
            status: 'closed',
            revision: 1,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            closedAt: Date.now(),
            paneCount: 0,
            titleSetByUser: false,
            panes: [],
          },
        },
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
    const records = ws.sendTabsSyncPush.mock.calls[0][0].records
    expect(records.some((record: any) => record.tabKey === 'local:stale')).toBe(false)
    stop()
  })

  it('clears stale localClosed records using the fresh websocket server id during reconnect', () => {
    ws.serverInstanceId = 'srv-old'
    state = {
      ...state,
      connection: {
        ...state.connection,
        serverInstanceId: 'srv-old',
      },
      tabRegistry: {
        ...state.tabRegistry,
        localClosed: {
          stale: {
            tabKey: 'local:stale',
            tabId: 'stale',
            serverInstanceId: 'srv-old',
            deviceId: 'local-device',
            deviceLabel: 'local-label',
            tabName: 'stale',
            status: 'closed',
            revision: 1,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            closedAt: Date.now(),
            paneCount: 0,
            titleSetByUser: false,
            panes: [],
          },
        },
      },
    }
    const mutatingDispatch = vi.fn((action: any) => {
      dispatch(action)
      if (action?.type === 'tabRegistry/clearTabRegistryLocalClosed') {
        state = {
          ...state,
          tabRegistry: {
            ...state.tabRegistry,
            localClosed: {},
          },
        }
      }
    })
    const stop = startTabRegistrySync(createStore(mutatingDispatch) as any, ws)

    ws.serverInstanceId = 'srv-new'
    ws.sendTabsSyncPush.mockClear()
    wsReconnectHandlers.forEach((handler) => handler())

    expect(mutatingDispatch.mock.calls.some((call) => call[0]?.type === 'tabRegistry/clearTabRegistryLocalClosed')).toBe(true)
    const records = ws.sendTabsSyncPush.mock.calls[0][0].records
    expect(records.some((record: any) => record.tabKey === 'local:stale')).toBe(false)
    expect(records.every((record: any) => record.serverInstanceId === 'srv-new')).toBe(true)
    stop()
  })

  it('forces heartbeat pushes without changing record updatedAt when the fingerprint is unchanged', () => {
    const stop = startTabRegistrySync(createStore() as any, ws)
    const initialRecord = ws.sendTabsSyncPush.mock.calls[0][0].records[0]
    ws.sendTabsSyncPush.mockClear()

    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS)

    expect(ws.sendTabsSyncPush).toHaveBeenCalledTimes(1)
    const heartbeatRecord = ws.sendTabsSyncPush.mock.calls[0][0].records[0]
    expect(heartbeatRecord.updatedAt).toBe(initialRecord.updatedAt)
    expect(heartbeatRecord.revision).toBe(initialRecord.revision)
    stop()
  })

  it('does not send local closed records older than the selected retention window', () => {
    state = {
      ...state,
      tabRegistry: {
        ...state.tabRegistry,
        localClosed: {
          old: {
            tabKey: 'local:old',
            tabId: 'old',
            serverInstanceId: 'srv-test',
            deviceId: 'local-device',
            deviceLabel: 'local-label',
            tabName: 'old',
            status: 'closed',
            revision: 1,
            createdAt: Date.now() - 31 * 24 * 60 * 60 * 1000,
            updatedAt: Date.now() - 31 * 24 * 60 * 60 * 1000,
            closedAt: Date.now() - 31 * 24 * 60 * 60 * 1000,
            paneCount: 0,
            titleSetByUser: false,
            panes: [],
          },
        },
      },
    }

    const stop = startTabRegistrySync(createStore() as any, ws)
    const records = ws.sendTabsSyncPush.mock.calls[0][0].records
    expect(records.some((record: any) => record.tabKey === 'local:old')).toBe(false)
    stop()
  })

  it('sends the closed record rather than duplicate open and closed tab keys during close transitions', () => {
    state = {
      ...state,
      tabRegistry: {
        ...state.tabRegistry,
        localClosed: {
          closing: {
            tabKey: 'local-device:tab-1',
            tabId: 'tab-1',
            serverInstanceId: 'srv-test',
            deviceId: 'local-device',
            deviceLabel: 'local-label',
            tabName: 'freshell',
            status: 'closed',
            revision: 1,
            createdAt: Date.now() - 1_000,
            updatedAt: Date.now(),
            closedAt: Date.now(),
            paneCount: 1,
            titleSetByUser: false,
            panes: [],
          },
        },
      },
    }

    const stop = startTabRegistrySync(createStore() as any, ws)
    const matching = ws.sendTabsSyncPush.mock.calls[0][0].records.filter((record: any) => record.tabKey === 'local-device:tab-1')
    expect(matching).toHaveLength(1)
    expect(matching[0].status).toBe('closed')
    stop()
  })

  it('advances record updatedAt when pane snapshot content changes', () => {
    const stop = startTabRegistrySync(createStore() as any, ws)
    const initialRecord = ws.sendTabsSyncPush.mock.calls[0][0].records[0]
    ws.sendTabsSyncPush.mockClear()
    vi.setSystemTime(new Date(1_740_000_010_000))
    state = {
      ...state,
      panes: {
        ...state.panes,
        layouts: {
          ...state.panes.layouts,
          'tab-1': {
            type: 'leaf',
            id: 'pane-1',
            content: {
              kind: 'browser',
              url: 'https://example.test/changed',
              devToolsOpen: false,
            },
          },
        },
      },
    } as RootState

    listeners.forEach((listener) => listener())

    expect(ws.sendTabsSyncPush).toHaveBeenCalledTimes(1)
    const changedRecord = ws.sendTabsSyncPush.mock.calls[0][0].records[0]
    expect(changedRecord.updatedAt).toBeGreaterThan(initialRecord.updatedAt)
    expect(changedRecord.revision).toBeGreaterThan(initialRecord.revision)
    expect(changedRecord.panes[0].payload.url).toBe('https://example.test/changed')
    stop()
  })

  it('advances record updatedAt for timestamp-only tab activity changes', () => {
    const stop = startTabRegistrySync(createStore() as any, ws)
    const initialRecord = ws.sendTabsSyncPush.mock.calls[0][0].records[0]
    ws.sendTabsSyncPush.mockClear()
    vi.setSystemTime(new Date(1_740_000_010_000))
    state = {
      ...state,
      tabs: {
        ...state.tabs,
        tabs: state.tabs.tabs.map((tab) => ({
          ...tab,
          lastInputAt: 1_740_000_010_000,
        })),
      },
    }

    listeners.forEach((listener) => listener())

    expect(ws.sendTabsSyncPush).toHaveBeenCalledTimes(1)
    const changedRecord = ws.sendTabsSyncPush.mock.calls[0][0].records[0]
    expect(changedRecord.updatedAt).toBeGreaterThan(initialRecord.updatedAt)
    expect(changedRecord.revision).toBeGreaterThan(initialRecord.revision)
    expect(changedRecord.panes).toEqual(initialRecord.panes)
    stop()
  })

  it('normalizes retained local closed records to the current device metadata after rename', () => {
    state = {
      ...state,
      tabRegistry: {
        ...state.tabRegistry,
        deviceLabel: 'new-label',
        localClosed: {
          renamed: {
            tabKey: 'local:renamed',
            tabId: 'renamed',
            serverInstanceId: 'srv-test',
            deviceId: 'local-device',
            deviceLabel: 'old-label',
            tabName: 'renamed',
            status: 'closed',
            revision: 1,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            closedAt: Date.now(),
            paneCount: 0,
            titleSetByUser: false,
            panes: [],
          },
        },
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
    const closedRecord = ws.sendTabsSyncPush.mock.calls[0][0].records.find((record: any) => record.tabKey === 'local:renamed')
    expect(closedRecord).toMatchObject({
      deviceId: 'local-device',
      deviceLabel: 'new-label',
    })
    stop()
  })

  it('sends unload retire through a keepalive beacon and advances the persisted retire revision', () => {
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
    const pushedRevision = ws.sendTabsSyncPush.mock.calls[0][0].snapshotRevision
    stop()

    expect(ws.sendTabsSyncClientRetire).toHaveBeenCalledWith(expect.objectContaining({
      snapshotRevision: pushedRevision + 1,
    }))
    expect(sessionStorage.getItem('freshell.tabs.snapshot-revision.v1')).toBe(String(pushedRevision + 1))
    expect(navigator.sendBeacon).toHaveBeenCalledWith(
      '/api/tabs-sync/client-retire',
      expect.any(Blob),
    )
  })

  it('sends at most one activity snapshot for repeated terminal input in the same minute bucket', () => {
    const stop = startTabRegistrySync(createStore() as any, ws)
    ws.sendTabsSyncPush.mockClear()

    state = {
      ...state,
      tabRecency: {
        paneLastInputAt: {
          'pane-1': 1_740_000_010_000,
        },
      },
    } as RootState
    listeners.forEach((listener) => listener())

    expect(ws.sendTabsSyncPush).toHaveBeenCalledTimes(1)
    expect(ws.sendTabsSyncPush.mock.calls[0][0].records[0].updatedAt).toBe(1_740_000_000_000)

    state = {
      ...state,
      tabRecency: {
        paneLastInputAt: {
          'pane-1': 1_740_000_050_000,
        },
      },
    } as RootState
    listeners.forEach((listener) => listener())

    expect(ws.sendTabsSyncPush).toHaveBeenCalledTimes(1)
    stop()
  })

  it('sends a new activity snapshot when terminal input enters the next minute bucket', () => {
    const stop = startTabRegistrySync(createStore() as any, ws)
    ws.sendTabsSyncPush.mockClear()

    state = {
      ...state,
      tabRecency: {
        paneLastInputAt: {
          'pane-1': 1_740_000_010_000,
        },
      },
    } as RootState
    listeners.forEach((listener) => listener())

    state = {
      ...state,
      tabRecency: {
        paneLastInputAt: {
          'pane-1': 1_740_000_060_000,
        },
      },
    } as RootState
    listeners.forEach((listener) => listener())

    expect(ws.sendTabsSyncPush).toHaveBeenCalledTimes(2)
    expect(ws.sendTabsSyncPush.mock.calls[1][0].records[0].updatedAt).toBe(1_740_000_060_000)
    stop()
  })

  it('still pushes real tab changes immediately even when recency bucket does not change', () => {
    const stop = startTabRegistrySync(createStore() as any, ws)
    ws.sendTabsSyncPush.mockClear()

    state = {
      ...state,
      tabs: {
        ...state.tabs,
        tabs: state.tabs.tabs.map((tab) => ({ ...tab, title: 'renamed tab' })),
      },
    }
    listeners.forEach((listener) => listener())

    expect(ws.sendTabsSyncPush).toHaveBeenCalledTimes(1)
    expect(ws.sendTabsSyncPush.mock.calls[0][0].records[0].tabName).toBe('renamed tab')
    stop()
  })

  it('does not push when only tab.updatedAt changes', () => {
    const stop = startTabRegistrySync(createStore() as any, ws)
    ws.sendTabsSyncPush.mockClear()

    state = {
      ...state,
      tabs: {
        ...state.tabs,
        tabs: state.tabs.tabs.map((tab) => ({ ...tab, updatedAt: 1_740_000_999_999 })),
      },
    }
    listeners.forEach((listener) => listener())

    expect(ws.sendTabsSyncPush).toHaveBeenCalledTimes(0)
    stop()
  })

  it('preserves a zero recency bucket without falling back to Date.now', () => {
    vi.setSystemTime(new Date(1_740_000_010_123))
    state = {
      ...state,
      tabs: {
        ...state.tabs,
        tabs: state.tabs.tabs.map((tab) => ({
          ...tab,
          createdAt: 0,
          updatedAt: 0,
          lastInputAt: undefined,
        })),
      },
    } as RootState

    const stop = startTabRegistrySync(createStore() as any, ws)

    expect(ws.sendTabsSyncPush.mock.calls[0][0].records[0].updatedAt).toBe(0)
    stop()
  })
})
