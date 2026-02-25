import { describe, expect, it } from 'vitest'
import reducer, {
  setTabRegistryLoading,
  setTabRegistrySnapshot,
  setTabRegistrySyncError,
  recordClosedTabSnapshot,
} from '../../../../src/store/tabRegistrySlice'
import {
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
})
