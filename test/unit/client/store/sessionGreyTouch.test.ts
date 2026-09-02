import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import tabsReducer, { removeTab } from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'
import claudeActivityReducer, { setClaudeActivitySnapshot } from '@/store/claudeActivitySlice'
import sessionActivityReducer, { selectAllSessionActivity } from '@/store/sessionActivitySlice'
import tabRegistryReducer, { setTabRegistrySnapshot } from '@/store/tabRegistrySlice'
import { startSessionGreyTouchWatcher } from '@/store/sessionGreyTouch'
import type { RootState } from '@/store/store'

function makeTab(sessionId: string, terminalId = `term-${sessionId}`) {
  return {
    id: `tab-${sessionId}`,
    title: sessionId,
    mode: 'claude',
    resumeSessionId: sessionId,
    sessionRef: { provider: 'claude', sessionId },
    createdAt: 1_000,
  }
}

function makeLayout(sessionId: string, terminalId = `term-${sessionId}`) {
  return {
    [`tab-${sessionId}`]: {
      type: 'leaf',
      id: `pane-${sessionId}`,
      content: {
        kind: 'terminal',
        mode: 'claude',
        status: 'running',
        terminalId,
        createRequestId: `req-${sessionId}`,
        sessionRef: { provider: 'claude', sessionId },
      },
    },
  }
}

function makeRemoteRecord(sessionId: string, busy: boolean) {
  const key = `claude:${sessionId}`
  return {
    tabKey: `device-b:tab-${sessionId}`,
    tabId: `tab-${sessionId}`,
    serverInstanceId: 'srv-test',
    deviceId: 'device-b',
    deviceLabel: 'device-b',
    tabName: 'freshell',
    status: 'open',
    revision: 1,
    createdAt: 1,
    updatedAt: 2,
    paneCount: 1,
    titleSetByUser: false,
    panes: [{
      paneId: `pane-remote-${sessionId}`,
      kind: 'terminal',
      payload: {
        sessionKeys: [key],
        ...(busy ? { busySessionKeys: [key] } : {}),
      },
    }],
  }
}

function snapshotPayload(remoteOpen: any[]) {
  return { localOpen: [], sameDeviceOpen: [], remoteOpen, closed: [], devices: [] }
}

function createTouchStore(preloaded: {
  tabs?: any[]
  paneLayouts?: Record<string, any>
  claudeActivityByTerminalId?: Record<string, any>
  remoteOpen?: any[]
}) {
  return configureStore({
    reducer: {
      tabs: tabsReducer,
      panes: panesReducer,
      claudeActivity: claudeActivityReducer,
      sessionActivity: sessionActivityReducer,
      tabRegistry: tabRegistryReducer,
    },
    preloadedState: {
      tabs: preloaded.tabs
        ? { tabs: preloaded.tabs, activeTabId: preloaded.tabs[0]?.id ?? '' }
        : undefined,
      panes: preloaded.paneLayouts
        ? { layouts: preloaded.paneLayouts, activePane: {}, paneTitles: {} }
        : undefined,
      claudeActivity: preloaded.claudeActivityByTerminalId
        ? {
            byTerminalId: preloaded.claudeActivityByTerminalId,
            lastSnapshotSeq: 0,
            liveMutationSeqByTerminalId: {},
            removedMutationSeqByTerminalId: {},
          }
        : undefined,
      tabRegistry: preloaded.remoteOpen
        ? {
            deviceId: 'device-a',
            deviceLabel: 'device-a',
            remoteOpen: preloaded.remoteOpen,
          }
        : undefined,
    } as any,
  })
}

describe('startSessionGreyTouchWatcher', () => {
  let touched: Record<string, number>

  beforeEach(() => {
    touched = {}
  })

  afterEach(() => {
    touched = {}
  })

  it('touches a session when its local tab closes (local-open → grey)', () => {
    const store = createTouchStore({ tabs: [makeTab('s1')], paneLayouts: makeLayout('s1') })
    const stop = startSessionGreyTouchWatcher(store as any)

    const before = Date.now()
    store.dispatch(removeTab('tab-s1'))
    const after = Date.now()

    touched = selectAllSessionActivity(store.getState() as RootState)
    expect(touched['claude:s1']).toBeGreaterThanOrEqual(before)
    expect(touched['claude:s1']).toBeLessThanOrEqual(after)
    stop()
  })

  it('does not touch on non-grey → non-grey transitions (busy → idle)', () => {
    const terminalId = 'term-s1'
    const store = createTouchStore({
      tabs: [makeTab('s1')],
      paneLayouts: makeLayout('s1'),
      claudeActivityByTerminalId: {
        [terminalId]: { terminalId, phase: 'busy', updatedAt: 1 },
      },
    })
    const stop = startSessionGreyTouchWatcher(store as any)

    store.dispatch(setClaudeActivitySnapshot({ terminals: [] }))

    touched = selectAllSessionActivity(store.getState() as RootState)
    expect(touched['claude:s1']).toBeUndefined()
    stop()
  })

  it('touches when a remote-busy session vanishes from the registry (remote-busy → grey)', () => {
    const store = createTouchStore({ remoteOpen: [makeRemoteRecord('r1', true)] })
    store.dispatch(setTabRegistrySnapshot(snapshotPayload([makeRemoteRecord('r1', true)])))
    const stop = startSessionGreyTouchWatcher(store as any)

    store.dispatch(setTabRegistrySnapshot(snapshotPayload([])))

    touched = selectAllSessionActivity(store.getState() as RootState)
    expect(touched['claude:r1']).toBeGreaterThan(0)
    stop()
  })

  it('touches when a remote-open session vanishes (remote-open → grey)', () => {
    const store = createTouchStore({ remoteOpen: [makeRemoteRecord('r2', false)] })
    store.dispatch(setTabRegistrySnapshot(snapshotPayload([makeRemoteRecord('r2', false)])))
    const stop = startSessionGreyTouchWatcher(store as any)

    store.dispatch(setTabRegistrySnapshot(snapshotPayload([])))

    touched = selectAllSessionActivity(store.getState() as RootState)
    expect(touched['claude:r2']).toBeGreaterThan(0)
    stop()
  })

  it('does not touch sessions already grey when the watcher starts (no retroactive touches)', () => {
    const store = createTouchStore({ remoteOpen: [makeRemoteRecord('never-grey-was-remote', false)] })
    store.dispatch(setTabRegistrySnapshot(snapshotPayload([])))
    const stop = startSessionGreyTouchWatcher(store as any)

    store.dispatch(setTabRegistrySnapshot(snapshotPayload([])))

    touched = selectAllSessionActivity(store.getState() as RootState)
    expect(touched).toEqual({})
    stop()
  })

  it('ratchets monotonically: a later transition never moves the touch backwards', () => {
    const store = createTouchStore({ remoteOpen: [] })
    const stop = startSessionGreyTouchWatcher(store as any)

    store.dispatch(setTabRegistrySnapshot(snapshotPayload([makeRemoteRecord('rx', true)])))
    store.dispatch(setTabRegistrySnapshot(snapshotPayload([])))
    const first = selectAllSessionActivity(store.getState() as RootState)['claude:rx']

    store.dispatch(setTabRegistrySnapshot(snapshotPayload([makeRemoteRecord('rx', false)])))
    store.dispatch(setTabRegistrySnapshot(snapshotPayload([])))
    const second = selectAllSessionActivity(store.getState() as RootState)['claude:rx']

    expect(first).toBeGreaterThan(0)
    expect(second).toBeGreaterThanOrEqual(first)
    stop()
  })

  it('stops observing after the stop handle runs', () => {
    const store = createTouchStore({ tabs: [makeTab('s1')], paneLayouts: makeLayout('s1') })
    const stop = startSessionGreyTouchWatcher(store as any)
    stop()

    store.dispatch(removeTab('tab-s1'))

    touched = selectAllSessionActivity(store.getState() as RootState)
    expect(touched['claude:s1']).toBeUndefined()
  })
})
