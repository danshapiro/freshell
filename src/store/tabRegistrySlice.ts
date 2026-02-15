import { createSlice, PayloadAction } from '@reduxjs/toolkit'
import type { RegistryTabRecord } from './tabRegistryTypes'

const DEVICE_ID_KEY = 'freshell.device-id.v1'
const DEVICE_LABEL_KEY = 'freshell.device-label.v1'

function randomId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID()
    }
  } catch {
    // fall through
  }
  return `device-${Math.random().toString(36).slice(2, 10)}`
}

function loadDeviceMeta(): { deviceId: string; deviceLabel: string } {
  if (typeof localStorage === 'undefined') {
    return { deviceId: 'device-unknown', deviceLabel: 'device-unknown' }
  }

  let deviceId = localStorage.getItem(DEVICE_ID_KEY) || ''
  if (!deviceId) {
    deviceId = randomId()
    localStorage.setItem(DEVICE_ID_KEY, deviceId)
  }

  let deviceLabel = localStorage.getItem(DEVICE_LABEL_KEY) || ''
  if (!deviceLabel) {
    const platform = typeof navigator !== 'undefined' ? (navigator.platform || 'device') : 'device'
    deviceLabel = `${platform.toLowerCase().replace(/\s+/g, '-')}:${deviceId.slice(0, 8)}`
    localStorage.setItem(DEVICE_LABEL_KEY, deviceLabel)
  }

  return { deviceId, deviceLabel }
}

export interface TabRegistryState {
  deviceId: string
  deviceLabel: string
  localOpen: RegistryTabRecord[]
  remoteOpen: RegistryTabRecord[]
  closed: RegistryTabRecord[]
  localClosed: Record<string, RegistryTabRecord>
  searchRangeDays: number
  loading: boolean
  syncError?: string
  lastSnapshotAt?: number
}

const device = loadDeviceMeta()

const initialState: TabRegistryState = {
  deviceId: device.deviceId,
  deviceLabel: device.deviceLabel,
  localOpen: [],
  remoteOpen: [],
  closed: [],
  localClosed: {},
  searchRangeDays: 30,
  loading: false,
}

export const tabRegistrySlice = createSlice({
  name: 'tabRegistry',
  initialState,
  reducers: {
    setTabRegistrySearchRangeDays: (state, action: PayloadAction<number>) => {
      state.searchRangeDays = Math.max(1, action.payload)
    },
    setTabRegistryLoading: (state, action: PayloadAction<boolean>) => {
      state.loading = action.payload
    },
    setTabRegistrySnapshot: (
      state,
      action: PayloadAction<{
        localOpen: RegistryTabRecord[]
        remoteOpen: RegistryTabRecord[]
        closed: RegistryTabRecord[]
      }>,
    ) => {
      state.localOpen = action.payload.localOpen || []
      state.remoteOpen = action.payload.remoteOpen || []
      state.closed = action.payload.closed || []
      state.lastSnapshotAt = Date.now()
      state.syncError = undefined
      state.loading = false
    },
    setTabRegistrySyncError: (state, action: PayloadAction<string | undefined>) => {
      state.syncError = action.payload
    },
    recordClosedTabSnapshot: (state, action: PayloadAction<RegistryTabRecord>) => {
      state.localClosed[action.payload.tabKey] = action.payload
    },
    clearClosedTabSnapshot: (state, action: PayloadAction<string>) => {
      delete state.localClosed[action.payload]
    },
  },
})

export const {
  setTabRegistrySearchRangeDays,
  setTabRegistryLoading,
  setTabRegistrySnapshot,
  setTabRegistrySyncError,
  recordClosedTabSnapshot,
  clearClosedTabSnapshot,
} = tabRegistrySlice.actions

export default tabRegistrySlice.reducer
