import { describe, it, expect } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import tabsReducer, { addTab } from '@/store/tabsSlice'
import panesReducer, { initLayout, updatePaneTitle } from '@/store/panesSlice'
import sessionNamesReducer from '@/store/sessionNamesSlice'
import connectionReducer from '@/store/connectionSlice'
import tabRegistryReducer from '@/store/tabRegistrySlice'
import extensionsReducer from '@/store/extensionsSlice'
import {
  deriveRemoteSessionActivity,
  selectLiveLocalTabRecords,
  selectMergedClosedRecords,
  selectRemoteSessionActivity,
  selectSameDeviceSessionKeys,
  selectTabsRegistryGroups,
} from '@/store/selectors/tabsRegistrySelectors'
import type {
  RegistryPaneSnapshot,
  RegistryTabRecord,
} from '@/store/tabRegistryTypes'
import type { RootState } from '@/store/store'
import { sessionNameRefKey, type SessionNameRef } from '@shared/session-names'

function makeRecord(overrides: Partial<RegistryTabRecord>): RegistryTabRecord {
  return {
    tabKey: 'device-1:tab-1',
    tabId: 'tab-1',
    serverInstanceId: 'srv-test',
    deviceId: 'device-1',
    deviceLabel: 'device-1',
    tabName: 'freshell',
    status: 'open',
    revision: 1,
    createdAt: 1,
    updatedAt: 2,
    paneCount: 1,
    titleSetByUser: false,
    panes: [],
    ...overrides,
  }
}

function makePane(payload: Record<string, unknown>): RegistryPaneSnapshot {
  return { paneId: 'pane-1', kind: 'terminal', payload }
}

function makeState(tabRegistry: Record<string, unknown>): RootState {
  return { tabRegistry } as unknown as RootState
}

describe('deriveRemoteSessionActivity', () => {
  it('maps pane sessionKeys to open', () => {
    const record = makeRecord({
      panes: [makePane({ sessionKeys: ['claude:s1'] })],
    })

    expect(deriveRemoteSessionActivity([record])).toEqual({ 'claude:s1': 'open' })
  })

  it('marks busySessionKeys busy while identity aliases stay open', () => {
    const record = makeRecord({
      panes: [makePane({
        sessionKeys: ['claude:s1', 'claude:s2'],
        busySessionKeys: ['claude:s1'],
      })],
    })

    expect(deriveRemoteSessionActivity([record])).toEqual({
      'claude:s1': 'busy',
      'claude:s2': 'open',
    })
  })

  it('derives open from a legacy sessionRef-only payload', () => {
    const record = makeRecord({
      panes: [makePane({ sessionRef: { provider: 'claude', sessionId: 's1' } })],
    })

    expect(deriveRemoteSessionActivity([record])).toEqual({ 'claude:s1': 'open' })
  })

  it('lets sessionKeys take precedence over a differing legacy sessionRef', () => {
    const record = makeRecord({
      panes: [makePane({
        sessionKeys: ['claude:s1'],
        sessionRef: { provider: 'codex', sessionId: 'x9' },
      })],
    })

    expect(deriveRemoteSessionActivity([record])).toEqual({ 'claude:s1': 'open' })
  })

  it('lets busy win over open across devices referencing the same session', () => {
    const busyDevice = makeRecord({
      tabKey: 'device-2:tab-1',
      deviceId: 'device-2',
      panes: [makePane({ sessionKeys: ['claude:s1'], busySessionKeys: ['claude:s1'] })],
    })
    const openDevice = makeRecord({
      tabKey: 'device-3:tab-1',
      deviceId: 'device-3',
      panes: [makePane({ sessionKeys: ['claude:s1'] })],
    })

    expect(deriveRemoteSessionActivity([openDevice, busyDevice])).toEqual({ 'claude:s1': 'busy' })
    expect(deriveRemoteSessionActivity([busyDevice, openDevice])).toEqual({ 'claude:s1': 'busy' })
  })

  it('ignores panes with missing, empty, or malformed identity', () => {
    const record = makeRecord({
      panes: [
        makePane({}),
        makePane({ sessionKeys: [] }),
        makePane({ busySessionKeys: [] }),
        makePane({ sessionKeys: [''] }),
        makePane({ sessionKeys: ['claude:s1', 42, null] }),
        makePane({ sessionRef: { provider: 'claude' } }),
        makePane({ sessionRef: { provider: '', sessionId: 's1' } }),
        makePane({ sessionRef: { provider: 'claude', sessionId: '' } }),
        makePane({ sessionRef: 'claude:s1' }),
      ],
    })

    expect(deriveRemoteSessionActivity([record])).toEqual({ 'claude:s1': 'open' })
  })

  it('ignores panes without a well-formed payload object', () => {
    const record = makeRecord({
      panes: [
        { paneId: 'pane-1', kind: 'terminal' },
        { paneId: 'pane-2', kind: 'terminal', payload: 'claude:s1' },
      ] as unknown as RegistryPaneSnapshot[],
    })

    expect(deriveRemoteSessionActivity([record])).toEqual({})
  })

  it('returns an empty map for undefined or empty input', () => {
    expect(deriveRemoteSessionActivity(undefined)).toEqual({})
    expect(deriveRemoteSessionActivity([])).toEqual({})
  })

  it('returns an empty map for a record missing panes', () => {
    const { panes: _panes, ...withoutPanes } = makeRecord({})

    expect(deriveRemoteSessionActivity([withoutPanes as RegistryTabRecord])).toEqual({})
  })
})

describe('selectRemoteSessionActivity', () => {
  it('derives activity from state.tabRegistry.remoteOpen', () => {
    const record = makeRecord({
      panes: [makePane({ sessionKeys: ['claude:s1'], busySessionKeys: ['claude:s1'] })],
    })
    const state = makeState({ remoteOpen: [record] })

    expect(selectRemoteSessionActivity(state)).toEqual({ 'claude:s1': 'busy' })
  })

  it('ignores sameDeviceOpen records (same-device never produces rings)', () => {
    const record = makeRecord({
      panes: [makePane({ sessionKeys: ['claude:s1'], busySessionKeys: ['claude:s1'] })],
    })
    const state = makeState({ sameDeviceOpen: [record] })

    expect(selectRemoteSessionActivity(state)).toEqual({})
  })

  it('returns an empty map without the tabRegistry slice', () => {
    expect(() => selectRemoteSessionActivity({} as RootState)).not.toThrow()
    expect(selectRemoteSessionActivity({} as RootState)).toEqual({})
  })
})

describe('selectSameDeviceSessionKeys', () => {
  it('collects the key set ignoring color (busy keys included)', () => {
    const record = makeRecord({
      panes: [
        makePane({ sessionKeys: ['claude:s1'], busySessionKeys: ['claude:s2'] }),
        {
          paneId: 'pane-2',
          kind: 'terminal',
          payload: { sessionRef: { provider: 'codex', sessionId: 'c1' } },
        },
      ],
    })
    const state = makeState({ sameDeviceOpen: [record] })

    expect(selectSameDeviceSessionKeys(state)).toEqual(new Set(['claude:s1', 'claude:s2', 'codex:c1']))
  })

  it('returns an empty set without the tabRegistry slice', () => {
    let keys: Set<string> | undefined
    expect(() => {
      keys = selectSameDeviceSessionKeys({} as RootState)
    }).not.toThrow()
    expect(keys).toBeInstanceOf(Set)
    expect(keys?.size).toBe(0)
  })
})

// Unified agent names (Task 6): the registry name-refresh overlay. A closed
// or remote/same-device record's stored `tabName` is the last-known
// projection at capture time; the record's own `nameSource` pane payload
// carries the naming identity, so the live canonical cache overlays the
// session's CURRENT name — a session renamed after close never shows stale.
describe('registry name-refresh overlay', () => {
  const REF: SessionNameRef = { kind: 'session', provider: 'claude', sessionId: 's1' }

  function sessionNamesWith(
    records: Array<{ ref: SessionNameRef; name: string; revision: number }>,
    redirects: Record<string, { toKey: string; revision: number }> = {},
  ) {
    const byKey: Record<string, unknown> = {}
    for (const { ref, name, revision } of records) {
      byKey[sessionNameRefKey(ref)] = { ref, name, source: 'manual', revision }
    }
    return { records: byKey, redirects, nativeSync: {} }
  }

  it('overlays a CLOSED record with the canonical current name of its source session', () => {
    const record = makeRecord({
      tabName: 'Stale captured name',
      status: 'closed',
      closedAt: 5,
      nameSource: { kind: 'session', paneId: 'pane-1' },
      panes: [makePane({ nameRef: REF })],
    })
    const state = {
      tabRegistry: { closed: [record], localClosed: {} },
      sessionNames: sessionNamesWith([{ ref: REF, name: 'Renamed after close', revision: 7 }]),
    } as unknown as RootState

    expect(selectMergedClosedRecords(state)[0].tabName).toBe('Renamed after close')
  })

  it('refreshes remote-open and same-device-open records through the same overlay (sessionRef fallback identity)', () => {
    const record = makeRecord({
      tabName: 'Stale captured name',
      nameSource: { kind: 'session', paneId: 'pane-1' },
      panes: [makePane({ sessionRef: { provider: 'claude', sessionId: 's1' } })],
    })
    const state = {
      tabs: { tabs: [] },
      panes: { layouts: {}, paneTitles: {} },
      connection: {},
      tabRegistry: {
        closed: [],
        localClosed: {},
        remoteOpen: [record],
        sameDeviceOpen: [record],
      },
      sessionNames: sessionNamesWith([{ ref: REF, name: 'Renamed elsewhere', revision: 4 }]),
    } as unknown as RootState

    const groups = selectTabsRegistryGroups(state)
    expect(groups.remoteOpen[0].tabName).toBe('Renamed elsewhere')
    expect(groups.sameDeviceOpen[0].tabName).toBe('Renamed elsewhere')
  })

  it('keeps a pre-Task-6 record without nameSource untouched (no invented ownership)', () => {
    const record = makeRecord({
      tabName: 'Stored name',
      status: 'closed',
      closedAt: 5,
      panes: [makePane({ sessionRef: { provider: 'claude', sessionId: 's1' } })],
    })
    const state = {
      tabRegistry: { closed: [record], localClosed: {} },
      sessionNames: sessionNamesWith([{ ref: REF, name: 'Renamed after close', revision: 7 }]),
    } as unknown as RootState

    expect(selectMergedClosedRecords(state)[0].tabName).toBe('Stored name')
  })

  it('resolves a stale pending identity through its pending→durable redirect', () => {
    const durable: SessionNameRef = { kind: 'session', provider: 'codex', sessionId: 'd1' }
    const pending: SessionNameRef = { kind: 'pending', id: 'nh-1' }
    const record = makeRecord({
      tabName: 'Stale captured name',
      status: 'closed',
      closedAt: 5,
      nameSource: { kind: 'session', paneId: 'pane-1' },
      panes: [makePane({ namingHandle: 'nh-1' })],
    })
    const state = {
      tabRegistry: { closed: [record], localClosed: {} },
      sessionNames: sessionNamesWith(
        [{ ref: durable, name: 'Durable current name', revision: 9 }],
        { [sessionNameRefKey(pending)]: { toKey: sessionNameRefKey(durable), revision: 2 } },
      ),
    } as unknown as RootState

    expect(selectMergedClosedRecords(state)[0].tabName).toBe('Durable current name')
  })
})

// Name reliability (Task 9): a local live record carries the same pane user
// flags the tabs.sync push sends, so the registry describes the renamed pane.
describe('live local registry records', () => {
  it('carry the pane user flag of a renamed pane', () => {
    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        sessionNames: sessionNamesReducer,
        connection: connectionReducer,
        tabRegistry: tabRegistryReducer,
        extensions: extensionsReducer,
      },
    })
    store.dispatch(addTab({ id: 'tab-shell', title: 'MyShellTab', titleSetByUser: true }))
    store.dispatch(initLayout({
      tabId: 'tab-shell',
      paneId: 'pane-shell',
      content: { kind: 'terminal', mode: 'shell' },
    }))
    store.dispatch(updatePaneTitle({ tabId: 'tab-shell', paneId: 'pane-shell', title: 'KeepMePane', setByUser: true }))

    const record = selectLiveLocalTabRecords(store.getState() as unknown as RootState)
      .find((candidate) => candidate.tabId === 'tab-shell')
    expect(record?.titleSetByUser).toBe(true)
    expect(record?.panes[0]).toMatchObject({ paneId: 'pane-shell', title: 'KeepMePane', titleSetByUser: true })
  })
})
