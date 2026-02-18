import { createSlice, PayloadAction } from '@reduxjs/toolkit'
import type { RegistryTabRecord } from './tabRegistryTypes'

const DEVICE_ID_KEY = 'freshell.device-id.v1'
const DEVICE_LABEL_KEY = 'freshell.device-label.v1'
const DEVICE_LABEL_CUSTOM_KEY = 'freshell.device-label-custom.v1'
const DEVICE_FINGERPRINT_KEY = 'freshell.device-fingerprint.v1'
const DEVICE_ALIASES_KEY = 'freshell.device-aliases.v1'

type DeviceMetaHints = {
  platform?: string
  hostName?: string
}

let ephemeralDeviceMeta: { deviceId: string; deviceLabel: string } | null = null

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

function safeStorage(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') return null
    // Probe access in browsers that expose the object but block usage.
    localStorage.getItem(DEVICE_ID_KEY)
    return localStorage
  } catch {
    return null
  }
}

function normalizeDeviceLabel(input: string): string {
  const normalized = input.trim().replace(/\s+/g, '-').replace(/[^a-zA-Z0-9._-]+/g, '-')
  return normalized || 'device'
}

function buildDefaultDeviceLabel(hints: DeviceMetaHints = {}): string {
  const hostName = hints.hostName?.trim()
  if (hostName) return normalizeDeviceLabel(hostName)
  const platform = hints.platform
    || (typeof navigator !== 'undefined' ? (navigator.platform || 'device') : 'device')
  return normalizeDeviceLabel(platform.toLowerCase())
}

function buildDeviceFingerprint(hints: DeviceMetaHints = {}): string {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown'
  const platform = typeof navigator !== 'undefined'
    ? (navigator.platform || 'device')
    : (hints.platform || 'device')
  return `${platform}|${ua}`
}

function loadDeviceAliases(storage: Storage | null): Record<string, string> {
  if (!storage) return {}
  try {
    const raw = storage.getItem(DEVICE_ALIASES_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return {}
    const aliases = Object.fromEntries(
      Object.entries(parsed).filter(([key, value]) => key && typeof value === 'string' && value.trim()),
    ) as Record<string, string>
    return aliases
  } catch {
    return {}
  }
}

function persistDeviceAliases(storage: Storage | null, aliases: Record<string, string>): void {
  if (!storage) return
  try {
    storage.setItem(DEVICE_ALIASES_KEY, JSON.stringify(aliases))
  } catch {
    // Ignore storage write failures; aliases remain in-memory for this session.
  }
}

function loadDeviceMeta(hints: DeviceMetaHints = {}): { deviceId: string; deviceLabel: string } {
  const storage = safeStorage()
  if (!storage) {
    if (ephemeralDeviceMeta) return ephemeralDeviceMeta
    ephemeralDeviceMeta = {
      deviceId: randomId(),
      deviceLabel: buildDefaultDeviceLabel(hints),
    }
    return ephemeralDeviceMeta
  }

  let deviceId = storage.getItem(DEVICE_ID_KEY) || ''
  const fingerprint = buildDeviceFingerprint(hints)
  const storedFingerprint = storage.getItem(DEVICE_FINGERPRINT_KEY) || ''
  const shouldRotateDeviceId =
    !deviceId ||
    deviceId === 'device-unknown' ||
    (storedFingerprint && storedFingerprint !== fingerprint)
  if (!deviceId) {
    deviceId = randomId()
  }
  if (shouldRotateDeviceId) {
    deviceId = randomId()
    storage.setItem(DEVICE_ID_KEY, deviceId)
    storage.setItem(DEVICE_FINGERPRINT_KEY, fingerprint)
  } else if (!storedFingerprint) {
    storage.setItem(DEVICE_FINGERPRINT_KEY, fingerprint)
  }

  let deviceLabel = storage.getItem(DEVICE_LABEL_KEY) || ''
  const isCustomLabel = storage.getItem(DEVICE_LABEL_CUSTOM_KEY) === '1'
  const defaultLabel = buildDefaultDeviceLabel(hints)
  if (!deviceLabel) {
    deviceLabel = defaultLabel
    storage.setItem(DEVICE_LABEL_KEY, deviceLabel)
    storage.setItem(DEVICE_LABEL_CUSTOM_KEY, '0')
  } else if (!isCustomLabel) {
    const normalizedCurrent = normalizeDeviceLabel(deviceLabel)
    if (normalizedCurrent !== defaultLabel) {
      deviceLabel = defaultLabel
      storage.setItem(DEVICE_LABEL_KEY, deviceLabel)
    } else {
      deviceLabel = normalizedCurrent
    }
  } else {
    deviceLabel = normalizeDeviceLabel(deviceLabel)
  }

  return { deviceId, deviceLabel }
}

export function resolveAndPersistDeviceMeta(hints: DeviceMetaHints = {}): {
  deviceId: string
  deviceLabel: string
} {
  return loadDeviceMeta(hints)
}

export function persistOwnDeviceLabel(deviceLabel: string): string {
  const normalized = normalizeDeviceLabel(deviceLabel)
  const storage = safeStorage()
  if (!storage) return normalized
  try {
    storage.setItem(DEVICE_LABEL_KEY, normalized)
    storage.setItem(DEVICE_LABEL_CUSTOM_KEY, '1')
  } catch {
    // no-op
  }
  return normalized
}

export function persistDeviceAlias(deviceId: string, label: string | undefined): Record<string, string> {
  const storage = safeStorage()
  const aliases = loadDeviceAliases(storage)
  const normalizedLabel = label?.trim() ? normalizeDeviceLabel(label) : ''
  if (!normalizedLabel) {
    delete aliases[deviceId]
  } else {
    aliases[deviceId] = normalizedLabel
  }
  persistDeviceAliases(storage, aliases)
  return aliases
}

export interface TabRegistryState {
  deviceId: string
  deviceLabel: string
  deviceAliases: Record<string, string>
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
const aliases = loadDeviceAliases(safeStorage())

const initialState: TabRegistryState = {
  deviceId: device.deviceId,
  deviceLabel: device.deviceLabel,
  deviceAliases: aliases,
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
    setTabRegistryDeviceMeta: (
      state,
      action: PayloadAction<{ deviceId: string; deviceLabel: string }>,
    ) => {
      state.deviceId = action.payload.deviceId
      state.deviceLabel = action.payload.deviceLabel
    },
    setTabRegistryDeviceLabel: (state, action: PayloadAction<string>) => {
      state.deviceLabel = normalizeDeviceLabel(action.payload)
    },
    setTabRegistryDeviceAliases: (state, action: PayloadAction<Record<string, string>>) => {
      state.deviceAliases = action.payload
    },
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
  setTabRegistryDeviceMeta,
  setTabRegistryDeviceLabel,
  setTabRegistryDeviceAliases,
  setTabRegistrySearchRangeDays,
  setTabRegistryLoading,
  setTabRegistrySnapshot,
  setTabRegistrySyncError,
  recordClosedTabSnapshot,
  clearClosedTabSnapshot,
} = tabRegistrySlice.actions

export default tabRegistrySlice.reducer
