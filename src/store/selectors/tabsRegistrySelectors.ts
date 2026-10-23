import { createSelector } from '@reduxjs/toolkit'
import type { RootState } from '@/store/store'
import type { RegistryTabRecord } from '@/store/tabRegistryTypes'
import { buildOpenTabRegistryRecord } from '@/lib/tab-registry-snapshot'
import { UNKNOWN_SERVER_INSTANCE_ID } from '@/store/tabRegistryConstants'
import { deriveTabRecencyAt } from '@/lib/tab-recency'
import { selectSessionNameRecord, selectSessionTabSavedNames } from '@/store/selectors/sessionNameSelectors'
import { parsePaneNamingIdentityInput } from '@/lib/tab-name-source'
import type { SessionNameRef } from '@shared/session-names'
import type { SessionNamesState } from '@/store/sessionNamesSlice'

const EMPTY_PANE_LAST_INPUT_AT: Record<string, number | undefined> = {}
const EMPTY_REGISTRY_RECORDS: RegistryTabRecord[] = []

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function nonEmptyStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
}

function legacySessionRefKeys(value: unknown): string[] {
  if (!isRecord(value)) return []
  const { provider, sessionId } = value
  if (typeof provider !== 'string' || provider.length === 0) return []
  if (typeof sessionId !== 'string' || sessionId.length === 0) return []
  return [`${provider}:${sessionId}`]
}

/** Defensive per-pane payload key extraction (unknown shapes read as empty). */
function panePayloadKeys(payload: Record<string, unknown>): { openKeys: string[]; busyKeys: string[] } {
  const sessionKeys = nonEmptyStrings(payload.sessionKeys)
  return {
    // `sessionKeys` is authoritative when present — the producing client
    // already resolved every identity; the legacy `sessionRef` fallback only
    // serves snapshots from older clients (open-only, never busy).
    openKeys: sessionKeys.length > 0 ? sessionKeys : legacySessionRefKeys(payload.sessionRef),
    busyKeys: nonEmptyStrings(payload.busySessionKeys),
  }
}

/**
 * Fold pane payloads into per-session remote activity. 'busy' wins over
 * 'open' across panes and records.
 */
export function deriveRemoteSessionActivity(
  records: RegistryTabRecord[] | undefined,
): Record<string, 'busy' | 'open'> {
  const activity: Record<string, 'busy' | 'open'> = {}
  if (!records) return activity

  for (const record of records) {
    const panes = (record as { panes?: unknown }).panes
    if (!Array.isArray(panes)) continue
    for (const pane of panes) {
      const payload = isRecord(pane) ? (pane as { payload?: unknown }).payload : undefined
      if (!isRecord(payload)) continue

      const { openKeys, busyKeys } = panePayloadKeys(payload)
      for (const key of openKeys) {
        if (!activity[key]) activity[key] = 'open'
      }
      for (const key of busyKeys) {
        activity[key] = 'busy'
      }
    }
  }

  return activity
}

function sortUpdatedDesc(a: RegistryTabRecord, b: RegistryTabRecord): number {
  return b.updatedAt - a.updatedAt
}

/**
 * Unified agent names (Task 6): refresh a snapshot record's CURRENT name —
 * a closed/remote record's stored `tabName` is the last-known projection at
 * capture time; the record's own `nameSource` pane payload carries the
 * naming identity (nameRef/namingHandle/sessionRef), so the live canonical
 * cache can overlay the session's current name and a renamed-after-close
 * session never shows stale in the registry. Legacy/unresolvable records
 * pass through unchanged.
 */
function overlayRecordCanonicalName(
  record: RegistryTabRecord,
  sessionNames: SessionNamesState | undefined,
): RegistryTabRecord {
  if (!sessionNames || record.nameSource?.kind !== 'session') return record
  const sourcePaneId = record.nameSource.paneId
  const payload = record.panes.find((pane) => pane.paneId === sourcePaneId)?.payload
  if (!payload || typeof payload !== 'object') return record
  const ref = parseRecordPaneNamingRef(payload)
  if (!ref) return record
  const name = selectSessionNameRecord(
    { sessionNames } as unknown as RootState,
    ref,
  )?.name
  return name && name !== record.tabName ? { ...record, tabName: name } : record
}

/** The naming ref a record pane payload carries, in resolution order: the
 * shared pane-identity parse (nameRef, then the provisional handle), then
 * the durable session ref fallback. */
function parseRecordPaneNamingRef(payload: Record<string, unknown>): SessionNameRef | undefined {
  const identity = parsePaneNamingIdentityInput(payload)
  if (identity.nameRef) return identity.nameRef
  if (identity.namingHandle) return { kind: 'pending', id: identity.namingHandle }
  const sessionRef = payload.sessionRef
  if (
    sessionRef && typeof sessionRef === 'object'
    && typeof (sessionRef as { provider?: unknown }).provider === 'string'
    && ((sessionRef as { provider: string }).provider === 'claude'
      || (sessionRef as { provider: string }).provider === 'codex'
      || (sessionRef as { provider: string }).provider === 'opencode')
    && typeof (sessionRef as { sessionId?: unknown }).sessionId === 'string'
    && (sessionRef as { sessionId: string }).sessionId.length > 0
  ) {
    return {
      kind: 'session',
      provider: (sessionRef as { provider: 'claude' | 'codex' | 'opencode' }).provider,
      sessionId: (sessionRef as { sessionId: string }).sessionId,
    }
  }
  return undefined
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
const selectPaneTitleSetByUser = (state: RootState) => state.panes.paneTitleSetByUser
const selectPaneLastInputAt = (state: RootState) => state.tabRecency?.paneLastInputAt ?? EMPTY_PANE_LAST_INPUT_AT
const selectDeviceId = (state: RootState) => state.tabRegistry.deviceId
const selectDeviceLabel = (state: RootState) => state.tabRegistry.deviceLabel
const selectServerInstanceId = (state: RootState) => state.connection.serverInstanceId || UNKNOWN_SERVER_INSTANCE_ID
const selectExtensionEntries = (state: RootState) => state.extensions?.entries
const selectSameDeviceOpen = (state: RootState) => state.tabRegistry?.sameDeviceOpen ?? EMPTY_REGISTRY_RECORDS
const selectRemoteOpen = (state: RootState) => state.tabRegistry?.remoteOpen ?? EMPTY_REGISTRY_RECORDS
const selectClosed = (state: RootState) => state.tabRegistry.closed
const selectLocalClosed = (state: RootState) => state.tabRegistry.localClosed
const selectClosedRetentionDays = (state: RootState) => Math.min(30, Math.max(1, Math.floor(
  state.tabRegistry.closedTabRetentionDays ?? state.tabRegistry.searchRangeDays ?? 30,
)))

export const selectLiveLocalTabRecords = createSelector(
  [selectTabs, selectLayouts, selectPaneTitles, selectPaneTitleSetByUser, selectPaneLastInputAt, selectDeviceId, selectDeviceLabel, selectServerInstanceId, selectExtensionEntries, selectSessionTabSavedNames],
  (tabs, layouts, paneTitles, paneTitleSetByUser, paneLastInputAt, deviceId, deviceLabel, serverInstanceId, extensions, savedTabNames): RegistryTabRecord[] => {
    const records: RegistryTabRecord[] = []
    for (const tab of tabs) {
      const layout = layouts[tab.id]
      if (!layout) continue
      const updatedAt = deriveTabRecencyAt({
        tab,
        layout,
        paneLastInputAt,
      })
      const record = buildOpenTabRegistryRecord({
        tab,
        layout,
        serverInstanceId,
        paneTitles: paneTitles[tab.id],
        paneTitleSetByUser: paneTitleSetByUser?.[tab.id],
        extensions,
        deviceId,
        deviceLabel,
        revision: 0,
        updatedAt,
      })
      // A session-owned local tab's registry summary shows its saved name
      // when the record is cached. Without one it keeps the built title (the
      // tab bar's legacy display): the mirrored last-known saved name when
      // the tab has one (name reliability, Task 7), never the overlay's
      // fallback label; a tab with no mirrored title shows the legacy
      // display. Legacy tabs keep the built title.
      const savedName = savedTabNames?.[tab.id]
      if (savedName) {
        record.tabName = savedName
      }
      records.push(record)
    }
    return records.sort(sortUpdatedDesc)
  },
)

export const selectMergedClosedRecords = createSelector(
  [selectClosed, selectLocalClosed, selectClosedRetentionDays, (state: RootState) => state.sessionNames],
  (closed, localClosed, closedRetentionDays, sessionNames): RegistryTabRecord[] => {
    const closedCutoff = Date.now() - closedRetentionDays * 24 * 60 * 60 * 1000
    const merged = dedupeByTabKey([
      ...(closed || []),
      ...Object.values(localClosed || {}).filter((record) => (record.closedAt ?? record.updatedAt) >= closedCutoff),
    ])
    return merged
      .map((record) => overlayRecordCanonicalName(record, sessionNames))
      .sort(sortClosedDesc)
  },
)

export const selectTabsRegistryGroups = createSelector(
  [
    selectLiveLocalTabRecords,
    selectSameDeviceOpen,
    selectRemoteOpen,
    selectMergedClosedRecords,
    (state: RootState) => state.sessionNames,
  ],
  (localOpen, sameDeviceOpen, remoteOpen, closed, sessionNames) => ({
    localOpen,
    // Registry snapshot overlays (Task 6): remote and same-device OPEN
    // records refresh their current names from the canonical cache, exactly
    // like closed records — a session renamed elsewhere never shows stale.
    sameDeviceOpen: [...(sameDeviceOpen || [])]
      .map((record) => overlayRecordCanonicalName(record, sessionNames))
      .sort(sortUpdatedDesc),
    remoteOpen: [...(remoteOpen || [])]
      .map((record) => overlayRecordCanonicalName(record, sessionNames))
      .sort(sortUpdatedDesc),
    closed,
  }),
)

/**
 * Per-session activity across genuinely remote devices only: fed from
 * `remoteOpen`, which the server partitions by device (see
 * server/tabs-registry/store.ts), so the same device never produces rings.
 */
export const selectRemoteSessionActivity = createSelector(
  [selectRemoteOpen],
  (remoteOpen): Record<string, 'busy' | 'open'> => deriveRemoteSessionActivity(remoteOpen),
)

/**
 * R3 suppression set: sessions open in other windows of THIS device.
 * Suppresses rings; never produces them — color is ignored.
 */
export const selectSameDeviceSessionKeys = createSelector(
  [selectSameDeviceOpen],
  (sameDeviceOpen): Set<string> => new Set(Object.keys(deriveRemoteSessionActivity(sameDeviceOpen))),
)
