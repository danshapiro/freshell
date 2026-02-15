import type { Store } from '@reduxjs/toolkit'
import type { RootState } from './store'
import type { WsClient } from '@/lib/ws-client'
import type { RegistryTabRecord } from './tabRegistryTypes'
import {
  setTabRegistryLoading,
  setTabRegistrySnapshot,
  setTabRegistrySyncError,
} from './tabRegistrySlice'
import { buildOpenTabRegistryRecord } from '@/lib/tab-registry-snapshot'
import type { PaneNode } from './paneTypes'

export const SYNC_INTERVAL_MS = 5000

type AppStore = Store<RootState>
type TabRegistryWsClient = Pick<WsClient, 'state' | 'onMessage'> & {
  sendTabsSyncPush?: WsClient['sendTabsSyncPush']
  sendTabsSyncQuery?: WsClient['sendTabsSyncQuery']
  onReconnect?: WsClient['onReconnect']
}

type RevisionState = Map<string, { fingerprint: string; revision: number }>

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

function buildRecords(state: RootState, now: number, revisions: RevisionState, serverInstanceId: string): RegistryTabRecord[] {
  const records: RegistryTabRecord[] = []
  const { deviceId, deviceLabel } = state.tabRegistry

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
      updatedAt: tab.lastInputAt || tab.createdAt || now,
    })
    records.push({
      ...recordBase,
      revision: nextRevision(recordBase, revisions),
    })
  }

  for (const closed of Object.values(state.tabRegistry.localClosed)) {
    const recordBase: RegistryTabRecord = {
      ...closed,
      updatedAt: closed.updatedAt,
      closedAt: closed.closedAt ?? closed.updatedAt,
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
      terminalId: tab.terminalId,
      titleSetByUser: !!tab.titleSetByUser,
    })),
    panes: Object.entries(state.panes.layouts).map(([tabId, node]) => ({
      tabId,
      sig: paneLayoutSignature(node),
    })),
    closedKeys: Object.keys(state.tabRegistry.localClosed).sort(),
  })
}

export function startTabRegistrySync(store: AppStore, ws: TabRegistryWsClient): () => void {
  const sendTabsSyncPush = ws.sendTabsSyncPush?.bind(ws)
    ?? ((_payload: { deviceId: string; deviceLabel: string; records: RegistryTabRecord[] }) => {})
  const sendTabsSyncQuery = ws.sendTabsSyncQuery?.bind(ws)
    ?? ((_payload: { requestId: string; deviceId: string; rangeDays?: number }) => {})
  const onReconnect = ws.onReconnect?.bind(ws)
    ?? ((_handler: () => void) => () => {})

  const revisions: RevisionState = new Map()
  const pendingRequests = new Set<string>()
  let lastPushFingerprint = ''
  let lastLifecycleFingerprint = lifecycleSignature(store.getState())

  const querySnapshot = (rangeDays?: number) => {
    if (ws.state !== 'ready') return
    const searchRangeDays = store.getState().tabRegistry.searchRangeDays
    const effectiveRangeDays = rangeDays ?? searchRangeDays
    const requestId = `tabs-sync-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    pendingRequests.add(requestId)
    store.dispatch(setTabRegistryLoading(true))
    sendTabsSyncQuery({
      requestId,
      deviceId: store.getState().tabRegistry.deviceId,
      ...(effectiveRangeDays > 30 ? { rangeDays: effectiveRangeDays } : {}),
    })
  }

  const pushNow = (force = false) => {
    if (ws.state !== 'ready') return
    const state = store.getState()
    const serverInstanceId = state.connection.serverInstanceId || ws.serverInstanceId
    if (!serverInstanceId) return
    const records = buildRecords(state, Date.now(), revisions, serverInstanceId)
    const fingerprint = JSON.stringify(records)
    if (!force && fingerprint === lastPushFingerprint) return
    lastPushFingerprint = fingerprint
    sendTabsSyncPush({
      deviceId: state.tabRegistry.deviceId,
      deviceLabel: state.tabRegistry.deviceLabel,
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
      store.dispatch(setTabRegistrySnapshot({
        localOpen: msg?.data?.localOpen || [],
        remoteOpen: msg?.data?.remoteOpen || [],
        closed: msg?.data?.closed || [],
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

  const unsubscribeStore = store.subscribe(() => {
    const state = store.getState()
    const nextFingerprint = lifecycleSignature(state)
    if (nextFingerprint === lastLifecycleFingerprint) return
    lastLifecycleFingerprint = nextFingerprint
    pushNow()
  })

  // Kick off immediately when already connected.
  querySnapshot()
  pushNow(true)

  return () => {
    unsubscribeMessage()
    unsubscribeReconnect()
    unsubscribeStore()
    globalThis.clearInterval(interval)
  }
}
