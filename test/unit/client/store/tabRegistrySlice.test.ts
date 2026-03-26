import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import reducer, {
  setTabRegistryLoading,
  setTabRegistrySnapshot,
  setTabRegistrySyncError,
  recordClosedTabSnapshot,
  pushReopenEntry,
  popReopenEntry,
} from '../../../../src/store/tabRegistrySlice'
import type { ClosedTabEntry } from '../../../../src/store/tabRegistrySlice'
import {
  BROWSER_PREFERENCES_STORAGE_KEY,
  STORAGE_KEYS,
  DEVICE_ALIASES_STORAGE_KEY,
  DEVICE_FINGERPRINT_STORAGE_KEY,
  DEVICE_ID_STORAGE_KEY,
  DEVICE_LABEL_CUSTOM_STORAGE_KEY,
  DEVICE_LABEL_STORAGE_KEY,
} from '../../../../src/store/storage-keys'
import type { RegistryTabRecord } from '../../../../src/store/tabRegistryTypes'

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

describe('tabRegistrySlice', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    localStorage.clear()
  })

  it('uses v2 namespaced device storage keys', () => {
    expect(STORAGE_KEYS.deviceId).toBe('freshell.device-id.v2')
    expect(STORAGE_KEYS.deviceLabel).toBe('freshell.device-label.v2')
    expect(STORAGE_KEYS.deviceLabelCustom).toBe('freshell.device-label-custom.v2')
    expect(STORAGE_KEYS.deviceFingerprint).toBe('freshell.device-fingerprint.v2')
    expect(STORAGE_KEYS.deviceAliases).toBe('freshell.device-aliases.v2')

    expect(DEVICE_ID_STORAGE_KEY).toBe('freshell.device-id.v2')
    expect(DEVICE_LABEL_STORAGE_KEY).toBe('freshell.device-label.v2')
    expect(DEVICE_LABEL_CUSTOM_STORAGE_KEY).toBe('freshell.device-label-custom.v2')
    expect(DEVICE_FINGERPRINT_STORAGE_KEY).toBe('freshell.device-fingerprint.v2')
    expect(DEVICE_ALIASES_STORAGE_KEY).toBe('freshell.device-aliases.v2')
  })

  it('stores snapshot groups and clears loading/error', () => {
    let state = reducer(undefined, setTabRegistryLoading(true))
    state = reducer(state, setTabRegistrySyncError('boom'))
    state = reducer(state, setTabRegistrySnapshot({
      localOpen: [makeRecord({ tabKey: 'local:1' })],
      remoteOpen: [makeRecord({ tabKey: 'remote:1', deviceId: 'remote' })],
      closed: [makeRecord({ tabKey: 'remote:closed', status: 'closed', closedAt: 3 })],
    }))

    expect(state.loading).toBe(false)
    expect(state.syncError).toBeUndefined()
    expect(state.localOpen).toHaveLength(1)
    expect(state.remoteOpen).toHaveLength(1)
    expect(state.closed).toHaveLength(1)
  })

  it('records local closed snapshots for sync payloads', () => {
    const state = reducer(undefined, recordClosedTabSnapshot(
      makeRecord({
        tabKey: 'local:closed',
        status: 'closed',
        closedAt: 10,
      }),
    ))
    expect(Object.keys(state.localClosed)).toEqual(['local:closed'])
  })

  describe('reopenStack', () => {
    function makeClosedTabEntry(overrides: Partial<ClosedTabEntry> = {}): ClosedTabEntry {
      return {
        tab: {
          id: 'tab-1',
          createRequestId: 'req-1',
          title: 'Tab 1',
          status: 'running',
          mode: 'shell',
          createdAt: Date.now(),
        },
        layout: { type: 'leaf', id: 'pane-1', content: { kind: 'terminal', createRequestId: 'cr-1', status: 'running', mode: 'shell' } },
        paneTitles: { 'pane-1': 'Shell' },
        closedAt: Date.now(),
        ...overrides,
      }
    }

    it('starts with an empty reopenStack', () => {
      const state = reducer(undefined, { type: 'unknown' })
      expect(state.reopenStack).toEqual([])
    })

    it('pushReopenEntry adds to the stack', () => {
      const entry = makeClosedTabEntry()
      const state = reducer(undefined, pushReopenEntry(entry))
      expect(state.reopenStack).toHaveLength(1)
      expect(state.reopenStack[0]).toEqual(entry)
    })

    it('popReopenEntry removes the last entry', () => {
      const entry1 = makeClosedTabEntry({ closedAt: 1 })
      const entry2 = makeClosedTabEntry({ closedAt: 2 })
      let state = reducer(undefined, pushReopenEntry(entry1))
      state = reducer(state, pushReopenEntry(entry2))
      expect(state.reopenStack).toHaveLength(2)

      state = reducer(state, popReopenEntry())
      expect(state.reopenStack).toHaveLength(1)
      expect(state.reopenStack[0].closedAt).toBe(1)
    })

    it('popReopenEntry on empty stack is a no-op', () => {
      const state = reducer(undefined, popReopenEntry())
      expect(state.reopenStack).toEqual([])
    })

    it('caps stack at 20 entries', () => {
      let state = reducer(undefined, { type: 'unknown' })
      for (let i = 0; i < 25; i++) {
        state = reducer(state, pushReopenEntry(makeClosedTabEntry({ closedAt: i })))
      }
      expect(state.reopenStack).toHaveLength(20)
      // Oldest entries should be dropped — first entry should be closedAt: 5
      expect(state.reopenStack[0].closedAt).toBe(5)
      expect(state.reopenStack[19].closedAt).toBe(24)
    })
  })

  it('initializes searchRangeDays from browser preferences instead of always resetting to 30', async () => {
    localStorage.setItem(BROWSER_PREFERENCES_STORAGE_KEY, JSON.stringify({
      tabs: {
        searchRangeDays: 365,
      },
    }))

    vi.resetModules()
    const freshModule = await import('../../../../src/store/tabRegistrySlice')
    const freshReducer = freshModule.default

    expect(freshReducer(undefined, { type: 'unknown' }).searchRangeDays).toBe(365)
  })
})
