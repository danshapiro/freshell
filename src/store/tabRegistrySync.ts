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

type AppStore = Store<RootState>
type TabRegistryWsClient = Pick<WsClient, 'state' | 'onMessage' | 'serverInstanceId'> & {
  sendTabsSyncPush?: WsClient['sendTabsSyncPush']
  sendTabsSyncQuery?: WsClient['sendTabsSyncQuery']
  sendTabsSyncClientRetire?: WsClient['sendTabsSyncClientRetire']
  onReconnect?: WsClient['onReconnect']
}

type RevisionState = Map<string, { fingerprint: string; revision: number }>
const claimedClientInstanceIds = new Set<string>()
const TAB_REGISTRY_CLIENT_LEASE_CHANNEL = 'freshell-tabs-registry-client-lease'

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
  let clientInstanceId = storage?.getItem(TAB_REGISTRY_CLIENT_INSTANCE_ID_STORAGE_KEY) || ''
  if (!clientInstanceId) {
    clientInstanceId = randomClientInstanceId()
    storage?.setItem(TAB_REGISTRY_CLIENT_INSTANCE_ID_STORAGE_KEY, clientInstanceId)
    storage?.setItem(TAB_REGISTRY_SNAPSHOT_REVISION_STORAGE_KEY, '0')
  }
  return clientInstanceId
}

function claimTabRegistryClientInstanceId(): string {
  const storage = safeSessionStorage()
  let clientInstanceId = getCurrentTabRegistryClientInstanceId()
  if (!clientInstanceId || claimedClientInstanceIds.has(clientInstanceId)) {
    clientInstanceId = randomClientInstanceId()
    storage?.setItem(TAB_REGISTRY_CLIENT_INSTANCE_ID_STORAGE_KEY, clientInstanceId)
    storage?.setItem(TAB_REGISTRY_SNAPSHOT_REVISION_STORAGE_KEY, '0')
  }
  claimedClientInstanceIds.add(clientInstanceId)
  return clientInstanceId
}

function readSnapshotRevision(): number {
  const raw = safeSessionStorage()?.getItem(TAB_REGISTRY_SNAPSHOT_REVISION_STORAGE_KEY)
  const parsed = raw ? Number(raw) : 0
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0
}

function writeSnapshotRevision(revision: number): void {
  safeSessionStorage()?.setItem(TAB_REGISTRY_SNAPSHOT_REVISION_STORAGE_KEY, String(revision))
}

function paneLayoutSignature(node: PaneNode | undefined): string {
  if (!node) return 'none'
  if (node.type === 'leaf') return `leaf:${node.id}:${node.content.kind}`
  return `split:${node.id}:${node.direction}:${paneLayoutSignature(node.children[0])}|${paneLayoutSignature(node.children[1])}`
}

function nextRevision(record: RegistryTabRecord, revisions: RevisionState): number {
  const fingerprint = JSON.stringify({
    status: record.status,
    tabName: record.tabName,
    paneCount: record.paneCount,
    titleSetByUser: record.titleSetByUser,
    panes: record.panes,
    closedAt: record.closedAt,
  })
  const current = revisions.get(record.tabKey)
  if (!current) {
    revisions.set(record.tabKey, { fingerprint, revision: 1 })
    return 1
  }
  if (current.fingerprint === fingerprint) {
    return current.revision
  }
  const revision = current.revision + 1
  revisions.set(record.tabKey, { fingerprint, revision })
  return revision
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
    records.push({
      ...recordBase,
      revision: nextRevision(recordBase, revisions),
    })
  }

  for (const closed of Object.values(state.tabRegistry.localClosed)) {
    if (closed.serverInstanceId !== serverInstanceId) continue
    const closedAt = closed.closedAt ?? closed.updatedAt
    if (closedAt < closedCutoff) continue
    const recordBase: RegistryTabRecord = {
      ...closed,
      updatedAt: closed.updatedAt,
      closedAt,
    }
    records.push({
      ...recordBase,
      revision: nextRevision(recordBase, revisions),
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
  let snapshotRevision = readSnapshotRevision()
  let lastServerInstanceId = store.getState().connection.serverInstanceId || ws.serverInstanceId
  let retired = false
  let leaseChannel: BroadcastChannel | null = null

  const announceLease = () => {
    leaseChannel?.postMessage({
      type: 'tabs-registry-client-claim',
      clientInstanceId,
      leaseId,
    })
  }

  const rotateClientInstanceIdAfterCollision = () => {
    const previousClientInstanceId = clientInstanceId
    claimedClientInstanceIds.delete(previousClientInstanceId)
    clientInstanceId = randomClientInstanceId()
    claimedClientInstanceIds.add(clientInstanceId)
    safeSessionStorage()?.setItem(TAB_REGISTRY_CLIENT_INSTANCE_ID_STORAGE_KEY, clientInstanceId)
    snapshotRevision = 0
    writeSnapshotRevision(snapshotRevision)
    lastPushFingerprint = ''
    retired = false
    announceLease()
    querySnapshot()
    pushNow(true)
  }

  if (typeof BroadcastChannel !== 'undefined') {
    leaseChannel = new BroadcastChannel(TAB_REGISTRY_CLIENT_LEASE_CHANNEL)
    leaseChannel.onmessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; clientInstanceId?: string; leaseId?: string }
      if (
        data?.type === 'tabs-registry-client-claim'
        && data.clientInstanceId === clientInstanceId
        && data.leaseId
        && data.leaseId !== leaseId
      ) {
        rotateClientInstanceIdAfterCollision()
      }
    }
    announceLease()
  }

  const querySnapshot = (closedTabRetentionDays?: number) => {
    if (ws.state !== 'ready') return
    const state = store.getState()
    const requestId = `tabs-sync-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    pendingRequests.add(requestId)
    store.dispatch(setTabRegistryLoading(true))
    sendTabsSyncQuery({
      requestId,
      deviceId: state.tabRegistry.deviceId,
      clientInstanceId,
      closedTabRetentionDays: Math.min(30, Math.max(1, closedTabRetentionDays ?? selectedClosedRetentionDays(state))),
    })
  }

  const pushNow = (force = false) => {
    if (ws.state !== 'ready') return
    const state = store.getState()
    const serverInstanceId = state.connection.serverInstanceId || ws.serverInstanceId
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

  const unsubscribeMessage = ws.onMessage((msg) => {
    if (msg?.type === 'ready') {
      querySnapshot()
      pushNow(true)
      return
    }

    if (msg?.type === 'tabs.sync.snapshot') {
      const requestId = typeof msg.requestId === 'string' ? msg.requestId : ''
      if (requestId && pendingRequests.has(requestId)) {
        pendingRequests.delete(requestId)
      }
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
    globalThis.removeEventListener?.('pagehide', retire)
    globalThis.removeEventListener?.('beforeunload', retire)
    leaseChannel?.close()
    claimedClientInstanceIds.delete(clientInstanceId)
    retire()
  }
}
