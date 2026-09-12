import { createSlice, PayloadAction } from '@reduxjs/toolkit'
import type { RegistryTabRecord } from './tabRegistryTypes'
import { normalizeRegistryTabRecord } from './tabRegistryTypes'
import type { Tab } from './types'
import type { PaneNode } from './paneTypes'
import { getClosedTabRetentionDaysPreference } from '@/lib/browser-preferences'
import {
  DEVICE_ALIASES_STORAGE_KEY,
  DEVICE_DISMISSED_STORAGE_KEY,
  DEVICE_ID_STORAGE_KEY,
  DEVICE_LABEL_CUSTOM_STORAGE_KEY,
  DEVICE_LABEL_STORAGE_KEY,
} from './storage-keys'

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
    localStorage.getItem(DEVICE_ID_STORAGE_KEY)
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
  const platform = hints.platform
    || (typeof navigator !== 'undefined' ? (navigator.platform || 'device') : 'device')
  return normalizeDeviceLabel(platform.toLowerCase())
}

function loadDeviceAliases(storage: Storage | null): Record<string, string> {
  if (!storage) return {}
  try {
    const raw = storage.getItem(DEVICE_ALIASES_STORAGE_KEY)
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
    storage.setItem(DEVICE_ALIASES_STORAGE_KEY, JSON.stringify(aliases))
  } catch {
    // Ignore storage write failures; aliases remain in-memory for this session.
  }
}

function loadDismissedDeviceIds(storage: Storage | null): string[] {
  if (!storage) return []
  try {
    const raw = storage.getItem(DEVICE_DISMISSED_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return [...new Set(parsed.filter((value): value is string => typeof value === 'string' && value.trim().length > 0))]
  } catch {
    return []
  }
}

function persistDismissedDeviceIds(storage: Storage | null, deviceIds: string[]): void {
  if (!storage) return
  try {
    storage.setItem(DEVICE_DISMISSED_STORAGE_KEY, JSON.stringify(deviceIds))
  } catch {
    // Ignore storage write failures; dismissed IDs remain in-memory for this session.
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

  let deviceId = storage.getItem(DEVICE_ID_STORAGE_KEY) || ''
  if (!deviceId || deviceId === 'device-unknown') {
    deviceId = randomId()
    storage.setItem(DEVICE_ID_STORAGE_KEY, deviceId)
  }

  let deviceLabel = storage.getItem(DEVICE_LABEL_STORAGE_KEY) || ''
  const isCustomLabel = storage.getItem(DEVICE_LABEL_CUSTOM_STORAGE_KEY) === '1'
  const defaultLabel = buildDefaultDeviceLabel(hints)
  if (!deviceLabel) {
    deviceLabel = defaultLabel
    storage.setItem(DEVICE_LABEL_STORAGE_KEY, deviceLabel)
    storage.setItem(DEVICE_LABEL_CUSTOM_STORAGE_KEY, '0')
  } else if (!isCustomLabel) {
    // Device labels and IDs once rotated when the browser fingerprint or the
    // *server's* hostname changed. A server-owned machine selection now owns
    // that decision. Preserve a legacy value exactly enough for the server to
    // recognize and migrate it; never use hostName as a client identity hint.
    deviceLabel = normalizeDeviceLabel(deviceLabel)
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
    storage.setItem(DEVICE_LABEL_STORAGE_KEY, normalized)
    storage.setItem(DEVICE_LABEL_CUSTOM_STORAGE_KEY, '1')
  } catch {
    // no-op
  }
  return normalized
}

export function persistDeviceAlias(deviceId: string, label: string | undefined): Record<string, string> {
  return persistDeviceAliasesForDevices([deviceId], label)
}

export function persistDeviceAliasesForDevices(deviceIds: string[], label: string | undefined): Record<string, string> {
  const storage = safeStorage()
  const aliases = loadDeviceAliases(storage)
  const normalizedLabel = label?.trim() ? normalizeDeviceLabel(label) : ''
  for (const deviceId of [...new Set(deviceIds.filter((value) => typeof value === 'string' && value.trim().length > 0))]) {
    if (!normalizedLabel) {
      delete aliases[deviceId]
    } else {
      aliases[deviceId] = normalizedLabel
    }
  }
  persistDeviceAliases(storage, aliases)
  return aliases
}

export function dismissDeviceIds(deviceIds: string[]): string[] {
  const storage = safeStorage()
  const current = loadDismissedDeviceIds(storage)
  const next = [
    ...new Set([
      ...current,
      ...deviceIds.filter((value) => typeof value === 'string' && value.trim().length > 0),
    ]),
  ]
  persistDismissedDeviceIds(storage, next)
  return next
}

export interface ClosedTabEntry {
  tab: Tab
  layout: PaneNode
  paneTitles: Record<string, string>
  paneTitleSetByUser: Record<string, boolean>
  closedAt: number
}

const REOPEN_STACK_MAX = 20

function normalizeRegistryRecords(records: RegistryTabRecord[] | undefined): RegistryTabRecord[] {
  return (records || [])
    .map((record) => normalizeRegistryTabRecord(record))
    .filter((record): record is RegistryTabRecord => !!record)
}

export interface TabRegistryState {
  deviceId: string
  deviceLabel: string
  deviceAliases: Record<string, string>
  dismissedDeviceIds: string[]
  localOpen: RegistryTabRecord[]
  sameDeviceOpen: RegistryTabRecord[]
  remoteOpen: RegistryTabRecord[]
  closed: RegistryTabRecord[]
  devices: Array<{ deviceId: string; deviceLabel: string; lastSeenAt: number }>
  localClosed: Record<string, RegistryTabRecord>
  reopenStack: ClosedTabEntry[]
  closedTabRetentionDays: number
  searchRangeDays: number
  loading: boolean
  syncError?: string
  lastSnapshotAt?: number
}

const device = loadDeviceMeta()
const aliases = loadDeviceAliases(safeStorage())
const dismissedDeviceIds = loadDismissedDeviceIds(safeStorage())
const initialClosedTabRetentionDays = getClosedTabRetentionDaysPreference()

const initialState: TabRegistryState = {
  deviceId: device.deviceId,
  deviceLabel: device.deviceLabel,
  deviceAliases: aliases,
  dismissedDeviceIds,
  localOpen: [],
  sameDeviceOpen: [],
  remoteOpen: [],
  devices: [],
  closed: [],
  localClosed: {},
  reopenStack: [],
  closedTabRetentionDays: initialClosedTabRetentionDays,
  searchRangeDays: initialClosedTabRetentionDays,
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
      state.deviceLabel = action.payload.trim() || 'device'
    },
    setTabRegistryDeviceAliases: (state, action: PayloadAction<Record<string, string>>) => {
      state.deviceAliases = action.payload
    },
    setTabRegistryDismissedDeviceIds: (state, action: PayloadAction<string[]>) => {
      state.dismissedDeviceIds = action.payload
    },
    setTabRegistrySearchRangeDays: (state, action: PayloadAction<number>) => {
      const closedTabRetentionDays = Math.min(30, Math.max(1, Math.floor(action.payload)))
      state.closedTabRetentionDays = closedTabRetentionDays
      state.searchRangeDays = closedTabRetentionDays
    },
    setTabRegistryClosedTabRetentionDays: (state, action: PayloadAction<number>) => {
      const closedTabRetentionDays = Math.min(30, Math.max(1, Math.floor(action.payload)))
      state.closedTabRetentionDays = closedTabRetentionDays
      state.searchRangeDays = closedTabRetentionDays
    },
    setTabRegistryLoading: (state, action: PayloadAction<boolean>) => {
      state.loading = action.payload
    },
    setTabRegistrySnapshot: (
      state,
      action: PayloadAction<{
        localOpen: RegistryTabRecord[]
        sameDeviceOpen?: RegistryTabRecord[]
        remoteOpen: RegistryTabRecord[]
        closed: RegistryTabRecord[]
        devices?: Array<{ deviceId: string; deviceLabel: string; lastSeenAt: number }>
      }>,
    ) => {
      state.localOpen = normalizeRegistryRecords(action.payload.localOpen)
      state.sameDeviceOpen = normalizeRegistryRecords(action.payload.sameDeviceOpen)
      state.remoteOpen = normalizeRegistryRecords(action.payload.remoteOpen)
      state.closed = normalizeRegistryRecords(action.payload.closed)
      state.devices = action.payload.devices || []
      state.lastSnapshotAt = Date.now()
      state.syncError = undefined
      state.loading = false
    },
    setTabRegistrySyncError: (state, action: PayloadAction<string | undefined>) => {
      state.syncError = action.payload
    },
    recordClosedTabSnapshot: (state, action: PayloadAction<RegistryTabRecord>) => {
      const normalized = normalizeRegistryTabRecord(action.payload)
      if (normalized) {
        state.localClosed[normalized.tabKey] = normalized
      }
    },
    clearTabRegistryLocalClosed: (state) => {
      state.localClosed = {}
    },
    pushReopenEntry: (state, action: PayloadAction<ClosedTabEntry>) => {
      state.reopenStack.push(action.payload)
      if (state.reopenStack.length > REOPEN_STACK_MAX) {
        state.reopenStack = state.reopenStack.slice(state.reopenStack.length - REOPEN_STACK_MAX)
      }
    },
    popReopenEntry: (state) => {
      state.reopenStack.pop()
    },
  },
})

export const {
  setTabRegistryDeviceMeta,
  setTabRegistryDeviceLabel,
  setTabRegistryDeviceAliases,
  setTabRegistryDismissedDeviceIds,
  setTabRegistrySearchRangeDays,
  setTabRegistryClosedTabRetentionDays,
  setTabRegistryLoading,
  setTabRegistrySnapshot,
  setTabRegistrySyncError,
  recordClosedTabSnapshot,
  clearTabRegistryLocalClosed,
  pushReopenEntry,
  popReopenEntry,
} = tabRegistrySlice.actions

export default tabRegistrySlice.reducer
