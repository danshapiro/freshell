import type { Store } from '@reduxjs/toolkit'
import type { RootState } from './store'
import type { WsClient } from '@/lib/ws-client'
import type { RegistryTabRecord } from './tabRegistryTypes'
import {
  clearTabRegistryLocalClosed,
  setTabRegistryLoading,
  setTabRegistrySnapshot,
  setTabRegistrySyncError,
} from './tabRegistrySlice'
import { buildOpenTabRegistryRecord } from '@/lib/tab-registry-snapshot'
import type { PaneNode } from './paneTypes'
import {
  TAB_REGISTRY_CLIENT_INSTANCE_ID_STORAGE_KEY,
  TAB_REGISTRY_SNAPSHOT_REVISION_STORAGE_KEY,
} from './storage-keys'

export const SYNC_INTERVAL_MS = 5000
export const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000
export const CLIENT_LEASE_GRACE_MS = 50

type AppStore = Store<RootState>
type TabRegistryWsClient = Pick<WsClient, 'state' | 'onMessage' | 'serverInstanceId'> & {
  sendTabsSyncPush?: WsClient['sendTabsSyncPush']
  sendTabsSyncQuery?: WsClient['sendTabsSyncQuery']
  sendTabsSyncClientRetire?: WsClient['sendTabsSyncClientRetire']
  onReconnect?: WsClient['onReconnect']
}

type RevisionState = Map<string, { fingerprint: string; revision: number; updatedAt: number }>
const claimedClientInstanceIds = new Set<string>()
const TAB_REGISTRY_CLIENT_LEASE_CHANNEL = 'freshell-tabs-registry-client-lease'
let inMemoryClientInstanceId = ''
let inMemorySnapshotRevision = 0

function randomClientInstanceId(): string {
  return `client-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`
}

function safeSessionStorage(): Storage | null {
  try {
    return typeof sessionStorage !== 'undefined' ? sessionStorage : null
  } catch {
    return null
  }
}

export function getCurrentTabRegistryClientInstanceId(): string {
  const storage = safeSessionStorage()
  let clientInstanceId = ''
  try {
    clientInstanceId = storage?.getItem(TAB_REGISTRY_CLIENT_INSTANCE_ID_STORAGE_KEY) || ''
  } catch {
    clientInstanceId = inMemoryClientInstanceId
  }
  if (!storage) {
    clientInstanceId = inMemoryClientInstanceId
  }
  if (!clientInstanceId) {
    clientInstanceId = randomClientInstanceId()
    inMemoryClientInstanceId = clientInstanceId
    inMemorySnapshotRevision = 0
    try {
      storage?.setItem(TAB_REGISTRY_CLIENT_INSTANCE_ID_STORAGE_KEY, clientInstanceId)
      storage?.setItem(TAB_REGISTRY_SNAPSHOT_REVISION_STORAGE_KEY, '0')
    } catch {
      // Keep the per-window module fallback stable when sessionStorage is unavailable.
    }
  }
  inMemoryClientInstanceId = clientInstanceId
  return clientInstanceId
}

function claimTabRegistryClientInstanceId(): string {
  const storage = safeSessionStorage()
  let clientInstanceId = getCurrentTabRegistryClientInstanceId()
  if (!clientInstanceId || claimedClientInstanceIds.has(clientInstanceId)) {
    clientInstanceId = randomClientInstanceId()
    inMemoryClientInstanceId = clientInstanceId
    inMemorySnapshotRevision = 0
    try {
      storage?.setItem(TAB_REGISTRY_CLIENT_INSTANCE_ID_STORAGE_KEY, clientInstanceId)
      storage?.setItem(TAB_REGISTRY_SNAPSHOT_REVISION_STORAGE_KEY, '0')
    } catch {
      // Keep the per-window module fallback stable when sessionStorage is unavailable.
    }
  }
  claimedClientInstanceIds.add(clientInstanceId)
  return clientInstanceId
}

function readSnapshotRevision(): number {
  let raw: string | null | undefined
  try {
    raw = safeSessionStorage()?.getItem(TAB_REGISTRY_SNAPSHOT_REVISION_STORAGE_KEY)
  } catch {
    raw = String(inMemorySnapshotRevision)
  }
  if (raw == null && inMemorySnapshotRevision > 0) raw = String(inMemorySnapshotRevision)
  const parsed = raw ? Number(raw) : 0
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0
}

function writeSnapshotRevision(revision: number): void {
  inMemorySnapshotRevision = revision
  try {
    safeSessionStorage()?.setItem(TAB_REGISTRY_SNAPSHOT_REVISION_STORAGE_KEY, String(revision))
  } catch {
    // Keep the per-window module fallback stable when sessionStorage is unavailable.
  }
}

function stableStringifyForFingerprint(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => stableStringifyForFingerprint(item)).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
  return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringifyForFingerprint(entryValue)}`).join(',')}}`
}

function paneLayoutSignature(node: PaneNode | undefined): string {
  if (!node) return 'none'
  if (node.type === 'leaf') return `leaf:${node.id}:${stableStringifyForFingerprint(node.content)}`
  return `split:${node.id}:${node.direction}:${paneLayoutSignature(node.children[0])}|${paneLayoutSignature(node.children[1])}`
}

function recordFingerprint(record: RegistryTabRecord): string {
  return stableStringifyForFingerprint({
    status: record.status,
    tabName: record.tabName,
    paneCount: record.paneCount,
    titleSetByUser: record.titleSetByUser,
    panes: record.panes,
    closedAt: record.closedAt,
  })
}

function nextRecordVersion(record: RegistryTabRecord, revisions: RevisionState, now: number): { revision: number; updatedAt: number } {
  const fingerprint = recordFingerprint(record)
  const current = revisions.get(record.tabKey)
  if (!current) {
    const updatedAt = record.updatedAt || now
    revisions.set(record.tabKey, { fingerprint, revision: 1, updatedAt })
    return { revision: 1, updatedAt }
  }
  if (current.fingerprint === fingerprint) {
    const incomingUpdatedAt = record.updatedAt || 0
    if (incomingUpdatedAt > current.updatedAt) {
      const revision = current.revision + 1
      revisions.set(record.tabKey, { fingerprint, revision, updatedAt: incomingUpdatedAt })
      return { revision, updatedAt: incomingUpdatedAt }
    }
    return { revision: current.revision, updatedAt: current.updatedAt }
  }
  const revision = current.revision + 1
  const updatedAt = Math.max(now, record.updatedAt || 0, current.updatedAt + 1)
  revisions.set(record.tabKey, { fingerprint, revision, updatedAt })
  return { revision, updatedAt }
}

function selectedClosedRetentionDays(state: RootState): number {
  return Math.min(30, Math.max(1, Math.floor(
    state.tabRegistry.closedTabRetentionDays ?? state.tabRegistry.searchRangeDays ?? 30,
  )))
}

function buildRecords(state: RootState, now: number, revisions: RevisionState, serverInstanceId: string): RegistryTabRecord[] {
  const records: RegistryTabRecord[] = []
  const { deviceId, deviceLabel } = state.tabRegistry
  const closedCutoff = now - selectedClosedRetentionDays(state) * 24 * 60 * 60 * 1000
  const retainedClosedRecords = Object.values(state.tabRegistry.localClosed).filter((closed) => {
    if (closed.serverInstanceId !== serverInstanceId) return false
    const closedAt = closed.closedAt ?? closed.updatedAt
    return closedAt >= closedCutoff
  })
  const retainedClosedTabKeys = new Set(retainedClosedRecords.map((closed) => closed.tabKey))

  for (const tab of state.tabs.tabs) {
    const layout = state.panes.layouts[tab.id]
    if (!layout) continue
    const recordBase = buildOpenTabRegistryRecord({
      tab,
      layout,
      serverInstanceId,
      paneTitles: state.panes.paneTitles[tab.id],
      deviceId,
      deviceLabel,
      revision: 0,
      updatedAt: tab.updatedAt || tab.lastInputAt || tab.createdAt || now,
    })
    if (retainedClosedTabKeys.has(recordBase.tabKey)) continue
    const version = nextRecordVersion(recordBase, revisions, now)
    records.push({
      ...recordBase,
      ...version,
    })
  }

  for (const closed of retainedClosedRecords) {
    const closedAt = closed.closedAt ?? closed.updatedAt
    const recordBase: RegistryTabRecord = {
      ...closed,
      deviceId,
      deviceLabel,
      updatedAt: closed.updatedAt,
      closedAt,
    }
    const version = nextRecordVersion(recordBase, revisions, now)
    records.push({
      ...recordBase,
      ...version,
    })
  }

  return records
}

function lifecycleSignature(state: RootState): string {
  return JSON.stringify({
    deviceId: state.tabRegistry.deviceId,
    deviceLabel: state.tabRegistry.deviceLabel,
    tabs: state.tabs.tabs.map((tab) => ({
      id: tab.id,
      title: tab.title,
      status: tab.status,
      mode: tab.mode,
      titleSetByUser: !!tab.titleSetByUser,
      updatedAt: tab.updatedAt,
      lastInputAt: tab.lastInputAt,
    })),
    panes: Object.entries(state.panes.layouts).map(([tabId, node]) => ({
      tabId,
      sig: paneLayoutSignature(node),
    })),
    closedKeys: Object.keys(state.tabRegistry.localClosed).sort(),
    closedTabRetentionDays: selectedClosedRetentionDays(state),
  })
}

export function startTabRegistrySync(store: AppStore, ws: TabRegistryWsClient): () => void {
  const storage = safeSessionStorage()
  let hadStoredClientInstanceId = false
  try {
    hadStoredClientInstanceId = !!storage?.getItem(TAB_REGISTRY_CLIENT_INSTANCE_ID_STORAGE_KEY)
  } catch {
    hadStoredClientInstanceId = !!inMemoryClientInstanceId
  }
  let clientInstanceId = claimTabRegistryClientInstanceId()
  const leaseId = randomClientInstanceId()
  const sendTabsSyncPush = ws.sendTabsSyncPush?.bind(ws)
    ?? ((_payload: { deviceId: string; deviceLabel: string; clientInstanceId: string; snapshotRevision: number; records: RegistryTabRecord[] }) => {})
  const sendTabsSyncQuery = ws.sendTabsSyncQuery?.bind(ws)
    ?? ((_payload: { requestId: string; deviceId: string; clientInstanceId: string; closedTabRetentionDays: number }) => {})
  const sendTabsSyncClientRetire = ws.sendTabsSyncClientRetire?.bind(ws)
    ?? ((_payload: { deviceId: string; clientInstanceId: string; snapshotRevision: number }) => {})
  const onReconnect = ws.onReconnect?.bind(ws)
    ?? ((_handler: () => void) => () => {})

  const revisions: RevisionState = new Map()
  const pendingRequests = new Set<string>()
  let lastPushFingerprint = ''
  let lastLifecycleFingerprint = lifecycleSignature(store.getState())
  let lastClosedRetentionDays = selectedClosedRetentionDays(store.getState())
  let snapshotRevision = readSnapshotRevision()
  let lastServerInstanceId = ws.serverInstanceId || store.getState().connection.serverInstanceId
  let retired = false
  let leaseChannel: BroadcastChannel | null = null
  const shouldVerifyClientLease = hadStoredClientInstanceId && typeof BroadcastChannel !== 'undefined'
  let leaseSettled = !shouldVerifyClientLease
  let leaseSettleTimer: ReturnType<typeof globalThis.setTimeout> | undefined
  let queuedQuery = false
  let queuedPush = false
  let queuedForcedPush = false
  let latestQueryRequestId = ''

  const querySnapshot = (closedTabRetentionDays?: number) => {
    if (!leaseSettled) {
      queuedQuery = true
      return
    }
    if (ws.state !== 'ready') return
    const state = store.getState()
    const retentionDays = Math.min(30, Math.max(1, closedTabRetentionDays ?? selectedClosedRetentionDays(state)))
    const requestId = `tabs-sync-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    pendingRequests.add(requestId)
    latestQueryRequestId = requestId
    store.dispatch(setTabRegistryLoading(true))
    sendTabsSyncQuery({
      requestId,
      deviceId: state.tabRegistry.deviceId,
      clientInstanceId,
      closedTabRetentionDays: retentionDays,
    })
  }

  const pushNow = (force = false) => {
    if (!leaseSettled) {
      queuedPush = true
      queuedForcedPush ||= force
      return
    }
    if (ws.state !== 'ready') return
    const state = store.getState()
    const serverInstanceId = ws.serverInstanceId || state.connection.serverInstanceId
    if (!serverInstanceId) return
    if (lastServerInstanceId && serverInstanceId !== lastServerInstanceId && Object.keys(state.tabRegistry.localClosed).length > 0) {
      store.dispatch(clearTabRegistryLocalClosed())
    }
    lastServerInstanceId = serverInstanceId
    const records = buildRecords(store.getState(), Date.now(), revisions, serverInstanceId)
    const fingerprint = JSON.stringify(records)
    if (!force && fingerprint === lastPushFingerprint) return
    lastPushFingerprint = fingerprint
    snapshotRevision += 1
    writeSnapshotRevision(snapshotRevision)
    const nextState = store.getState()
    sendTabsSyncPush({
      deviceId: nextState.tabRegistry.deviceId,
      deviceLabel: nextState.tabRegistry.deviceLabel,
      clientInstanceId,
      snapshotRevision,
      records,
    })
    store.dispatch(setTabRegistrySyncError(undefined))
  }

  const announceLease = () => {
    leaseChannel?.postMessage({
      type: 'tabs-registry-client-claim',
      clientInstanceId,
      leaseId,
    })
  }

  const settleClientLease = () => {
    leaseSettled = true
    if (leaseSettleTimer) {
      globalThis.clearTimeout(leaseSettleTimer)
      leaseSettleTimer = undefined
    }
    const shouldQuery = queuedQuery
    const shouldPush = queuedPush
    const shouldForcePush = queuedForcedPush
    queuedQuery = false
    queuedPush = false
    queuedForcedPush = false
    if (shouldQuery) querySnapshot()
    if (shouldPush) pushNow(shouldForcePush)
  }

  const beginClientLeaseCheck = () => {
    leaseSettled = false
    if (leaseSettleTimer) globalThis.clearTimeout(leaseSettleTimer)
    announceLease()
    leaseSettleTimer = globalThis.setTimeout(settleClientLease, CLIENT_LEASE_GRACE_MS)
  }

  const rotateClientInstanceIdAfterCollision = () => {
    const previousClientInstanceId = clientInstanceId
    claimedClientInstanceIds.delete(previousClientInstanceId)
    clientInstanceId = randomClientInstanceId()
    inMemoryClientInstanceId = clientInstanceId
    claimedClientInstanceIds.add(clientInstanceId)
    try {
      safeSessionStorage()?.setItem(TAB_REGISTRY_CLIENT_INSTANCE_ID_STORAGE_KEY, clientInstanceId)
    } catch {
      // Keep the per-window module fallback stable when sessionStorage is unavailable.
    }
    snapshotRevision = 0
    writeSnapshotRevision(snapshotRevision)
    lastPushFingerprint = ''
    pendingRequests.clear()
    latestQueryRequestId = ''
    retired = false
    beginClientLeaseCheck()
    querySnapshot()
    pushNow(true)
  }

  if (typeof BroadcastChannel !== 'undefined') {
    leaseChannel = new BroadcastChannel(TAB_REGISTRY_CLIENT_LEASE_CHANNEL)
    leaseChannel.onmessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; clientInstanceId?: string; leaseId?: string; claimantLeaseId?: string }
      if (
        data?.type === 'tabs-registry-client-claim'
        && data.clientInstanceId === clientInstanceId
        && data.leaseId
        && data.leaseId !== leaseId
      ) {
        leaseChannel?.postMessage({
          type: 'tabs-registry-client-active',
          clientInstanceId,
          leaseId,
          claimantLeaseId: data.leaseId,
        })
        return
      }
      if (
        data?.type === 'tabs-registry-client-active'
        && data.clientInstanceId === clientInstanceId
        && data.leaseId
        && data.leaseId !== leaseId
        && data.claimantLeaseId === leaseId
      ) {
        rotateClientInstanceIdAfterCollision()
      }
    }
    if (shouldVerifyClientLease) {
      beginClientLeaseCheck()
    } else {
      announceLease()
    }
  }

  const unsubscribeMessage = ws.onMessage((msg) => {
    if (msg?.type === 'ready') {
      querySnapshot()
      pushNow(true)
      return
    }

    if (msg?.type === 'tabs.sync.snapshot') {
      const requestId = typeof msg.requestId === 'string' ? msg.requestId : ''
      if (!requestId || !pendingRequests.has(requestId) || requestId !== latestQueryRequestId) return
      pendingRequests.delete(requestId)
      pendingRequests.clear()
      const data = (msg.data || {}) as {
        localOpen?: RegistryTabRecord[]
        sameDeviceOpen?: RegistryTabRecord[]
        remoteOpen?: RegistryTabRecord[]
        closed?: RegistryTabRecord[]
        devices?: Array<{ deviceId: string; deviceLabel: string; lastSeenAt: number }>
      }
      store.dispatch(setTabRegistrySnapshot({
        localOpen: data.localOpen || [],
        sameDeviceOpen: data.sameDeviceOpen || [],
        remoteOpen: data.remoteOpen || [],
        closed: data.closed || [],
        devices: data.devices || [],
      }))
      return
    }

    if (msg?.type === 'error' && typeof msg.message === 'string' && /tabs/i.test(msg.message)) {
      store.dispatch(setTabRegistrySyncError(msg.message))
    }
  })

  const unsubscribeReconnect = onReconnect(() => {
    querySnapshot()
    pushNow(true)
  })

  const interval = globalThis.setInterval(() => {
    pushNow()
  }, SYNC_INTERVAL_MS)
  const heartbeatInterval = globalThis.setInterval(() => {
    pushNow(true)
  }, HEARTBEAT_INTERVAL_MS)

  const unsubscribeStore = store.subscribe(() => {
    const state = store.getState()
    const nextFingerprint = lifecycleSignature(state)
    if (nextFingerprint === lastLifecycleFingerprint) return
    lastLifecycleFingerprint = nextFingerprint
    const nextRetentionDays = selectedClosedRetentionDays(state)
    if (nextRetentionDays !== lastClosedRetentionDays) {
      lastClosedRetentionDays = nextRetentionDays
      querySnapshot(nextRetentionDays)
    }
    pushNow()
  })

  const retire = () => {
    if (retired) return
    retired = true
    const state = store.getState()
    snapshotRevision += 1
    writeSnapshotRevision(snapshotRevision)
    const payload = {
      deviceId: state.tabRegistry.deviceId,
      clientInstanceId,
      snapshotRevision,
    }
    sendTabsSyncClientRetire({
      ...payload,
    })
    const body = JSON.stringify(payload)
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      const blob = new Blob([body], { type: 'application/json' })
      navigator.sendBeacon('/api/tabs-sync/client-retire', blob)
    } else if (typeof fetch === 'function') {
      void fetch('/api/tabs-sync/client-retire', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: true,
      }).catch(() => {})
    }
  }
  globalThis.addEventListener?.('pagehide', retire)
  globalThis.addEventListener?.('beforeunload', retire)

  querySnapshot()
  pushNow(true)

  return () => {
    unsubscribeMessage()
    unsubscribeReconnect()
    unsubscribeStore()
    globalThis.clearInterval(interval)
    globalThis.clearInterval(heartbeatInterval)
    if (leaseSettleTimer) globalThis.clearTimeout(leaseSettleTimer)
    globalThis.removeEventListener?.('pagehide', retire)
    globalThis.removeEventListener?.('beforeunload', retire)
    leaseChannel?.close()
    claimedClientInstanceIds.delete(clientInstanceId)
    retire()
  }
}
