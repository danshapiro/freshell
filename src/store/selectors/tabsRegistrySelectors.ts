import { createSelector } from '@reduxjs/toolkit'
import type { RootState } from '@/store/store'
import type { RegistryTabRecord } from '@/store/tabRegistryTypes'
import { buildOpenTabRegistryRecord } from '@/lib/tab-registry-snapshot'
import { UNKNOWN_SERVER_INSTANCE_ID } from '@/store/tabRegistryConstants'

function sortUpdatedDesc(a: RegistryTabRecord, b: RegistryTabRecord): number {
  return b.updatedAt - a.updatedAt
}

function sortClosedDesc(a: RegistryTabRecord, b: RegistryTabRecord): number {
  const aClosedAt = a.closedAt ?? a.updatedAt
  const bClosedAt = b.closedAt ?? b.updatedAt
  return bClosedAt - aClosedAt
}

function dedupeByTabKey(records: RegistryTabRecord[]): RegistryTabRecord[] {
  const map = new Map<string, RegistryTabRecord>()
  for (const record of records) {
    const existing = map.get(record.tabKey)
    if (!existing || record.updatedAt >= existing.updatedAt) {
      map.set(record.tabKey, record)
    }
  }
  return [...map.values()]
}

const selectTabs = (state: RootState) => state.tabs.tabs
const selectLayouts = (state: RootState) => state.panes.layouts
const selectPaneTitles = (state: RootState) => state.panes.paneTitles
const selectDeviceId = (state: RootState) => state.tabRegistry.deviceId
const selectDeviceLabel = (state: RootState) => state.tabRegistry.deviceLabel
const selectServerInstanceId = (state: RootState) => state.connection.serverInstanceId || UNKNOWN_SERVER_INSTANCE_ID
const selectRemoteOpen = (state: RootState) => state.tabRegistry.remoteOpen
const selectClosed = (state: RootState) => state.tabRegistry.closed
const selectLocalClosed = (state: RootState) => state.tabRegistry.localClosed

export const selectLiveLocalTabRecords = createSelector(
  [selectTabs, selectLayouts, selectPaneTitles, selectDeviceId, selectDeviceLabel, selectServerInstanceId],
  (tabs, layouts, paneTitles, deviceId, deviceLabel, serverInstanceId): RegistryTabRecord[] => {
    const records: RegistryTabRecord[] = []
    for (const tab of tabs) {
      const layout = layouts[tab.id]
      if (!layout) continue
      const updatedAt = tab.lastInputAt || tab.createdAt || 0
      records.push(buildOpenTabRegistryRecord({
        tab,
        layout,
        serverInstanceId,
        paneTitles: paneTitles[tab.id],
        deviceId,
        deviceLabel,
        revision: 0,
        updatedAt,
      }))
    }
    return records.sort(sortUpdatedDesc)
  },
)

export const selectMergedClosedRecords = createSelector(
  [selectClosed, selectLocalClosed],
  (closed, localClosed): RegistryTabRecord[] => {
    const merged = dedupeByTabKey([
      ...(closed || []),
      ...Object.values(localClosed || {}),
    ])
    return merged.sort(sortClosedDesc)
  },
)

export const selectTabsRegistryGroups = createSelector(
  [selectLiveLocalTabRecords, selectRemoteOpen, selectMergedClosedRecords],
  (localOpen, remoteOpen, closed) => ({
    localOpen,
    remoteOpen: [...(remoteOpen || [])].sort(sortUpdatedDesc),
    closed,
  }),
)
