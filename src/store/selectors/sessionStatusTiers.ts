/**
 * Sidebar session status tiers — the single source of truth for the local /
 * remote status ordering used by the default (activity) sidebar sort and by
 * the grey-transition touch watcher.
 *
 * Tier model (mirrors Sidebar rendering exactly):
 *   - 'local-busy'   — solid blue icon: busy on THIS device
 *   - 'local-open'   — solid green icon: open on this device, not busy
 *   - 'remote-busy'  — blue ring: busy on a genuinely remote device
 *   - 'remote-open'  — green ring: open (idle) on a genuinely remote device
 *   - (absent)       — grey: not open anywhere this client can see
 *
 * Local always wins over remote (a session open here never shows a remote
 * ring — the same rule the Sidebar's render gate applies), and same-device
 * records never produce remote tiers (they partition to sameDeviceOpen).
 */

export type SessionStatusTier = 'local-busy' | 'local-open' | 'remote-busy' | 'remote-open'

export const SESSION_STATUS_TIER_RANK: Record<SessionStatusTier, number> = {
  'local-busy': 0,
  'local-open': 1,
  'remote-busy': 2,
  'remote-open': 3,
}

/** Sessions absent from the tier map are grey — always last. */
export const GREY_STATUS_TIER_RANK = 4

export function sessionStatusTierRank(
  tiers: Record<string, SessionStatusTier> | undefined,
  sessionKey: string,
): number {
  const tier = tiers?.[sessionKey]
  return tier ? SESSION_STATUS_TIER_RANK[tier] : GREY_STATUS_TIER_RANK
}

import { createSelector } from '@reduxjs/toolkit'
import type { RootState } from '@/store/store'
import { collectBusySessionKeys, collectPaneIdentityActivity, collectTerminalFallbackRowKeys } from '@/lib/pane-activity'
import { collectSessionRefsFromTabs } from '@/lib/session-utils'
import { deriveRemoteSessionActivity } from '@/store/selectors/tabsRegistrySelectors'

const EMPTY_LAYOUTS: RootState['panes']['layouts'] = {}
const EMPTY_BY_ID: Record<string, never> = {}
const EMPTY_REGISTRY_RECORDS: RootState['tabRegistry']['remoteOpen'] = []

const selectTabs = (state: RootState) => state.tabs.tabs
const selectPanes = (state: RootState) => state.panes
const selectCodexActivityByTerminalId = (state: RootState) => state.codexActivity?.byTerminalId ?? EMPTY_BY_ID
const selectClaudeActivityByTerminalId = (state: RootState) => state.claudeActivity?.byTerminalId ?? EMPTY_BY_ID
const selectAmplifierActivityByTerminalId = (state: RootState) => state.amplifierActivity?.byTerminalId ?? EMPTY_BY_ID
const selectOpencodeActivityByTerminalId = (state: RootState) => state.opencodeActivity?.byTerminalId ?? EMPTY_BY_ID
const selectPaneRuntimeActivityByPaneId = (state: RootState) => state.paneRuntimeActivity?.byPaneId ?? EMPTY_BY_ID
const selectFreshAgentSessions = (state: RootState) => state.freshAgent?.sessions ?? EMPTY_BY_ID
const selectRemoteOpen = (state: RootState) => state.tabRegistry?.remoteOpen ?? EMPTY_REGISTRY_RECORDS
const selectSameDeviceOpen = (state: RootState) => state.tabRegistry?.sameDeviceOpen ?? EMPTY_REGISTRY_RECORDS

/**
 * The one canonical per-session status tier map for the Sidebar: rendering,
 * default-sort tiering, and the grey-transition touch watcher all read from
 * this shape so they can never disagree about what "grey" means.
 *
 * Producing sources mirror the Sidebar's THREE separate render gates:
 *   - solid blue icon (busy): collectBusySessionKeys
 *   - solid green icon (hasTab): collectSessionRefsFromTabs keys plus
 *     fabricated terminal fallback rows (collectTerminalFallbackRowKeys)
 *   - remote-ring suppression: collectSessionRefsFromTabs ∪
 *     collectPaneIdentityActivity sessionKeys/busySessionKeys
 *
 * collectPaneIdentityActivity is ONLY the ring-suppression gate — it also
 * covers grey-rendered rows (e.g. a fresh-agent pane's live-canonical key in
 * the restore gap), so it never grants local-open. deriveRemoteSessionActivity
 * supplies remote tiers only for keys with no local tier and no suppression.
 *
 * Factory (like makeSelectSortedSessionItems): each consumer gets its own
 * memoized instance — the grey-touch watcher runs it on every store change.
 */
export const makeSelectSessionStatusTiers = () =>
  createSelector(
    [
      selectTabs,
      selectPanes,
      selectCodexActivityByTerminalId,
      selectClaudeActivityByTerminalId,
      selectAmplifierActivityByTerminalId,
      selectOpencodeActivityByTerminalId,
      selectPaneRuntimeActivityByPaneId,
      selectFreshAgentSessions,
      selectRemoteOpen,
      selectSameDeviceOpen,
    ],
    (
      tabs,
      panes,
      codexActivityByTerminalId,
      claudeActivityByTerminalId,
      amplifierActivityByTerminalId,
      opencodeActivityByTerminalId,
      paneRuntimeActivityByPaneId,
      freshAgentSessions,
      remoteOpen,
      sameDeviceOpen,
    ): Record<string, SessionStatusTier> => {
      const paneLayouts = panes?.layouts ?? EMPTY_LAYOUTS
      const activityMaps = {
        codexActivityByTerminalId,
        claudeActivityByTerminalId,
        amplifierActivityByTerminalId,
        opencodeActivityByTerminalId,
        paneRuntimeActivityByPaneId,
        freshAgentSessions,
      }

      const busyKeys = collectBusySessionKeys({ tabs, paneLayouts, ...activityMaps })
      const identityByPaneId = collectPaneIdentityActivity({ tabs, paneLayouts, ...activityMaps })

      const refKeys = new Set<string>()
      for (const ref of collectSessionRefsFromTabs(tabs, { ...(panes ?? {}), layouts: paneLayouts })) {
        refKeys.add(`${ref.provider}:${ref.sessionId}`)
      }

      // local-open = the Sidebar's green-icon gate: tab session refs plus
      // fabricated terminal fallback rows. NOT the identity collector (see
      // the ring-suppression comment below).
      const localOpenKeys = new Set<string>(refKeys)
      for (const key of collectTerminalFallbackRowKeys({ tabs, paneLayouts, ...activityMaps })) {
        localOpenKeys.add(key)
      }

      // Ring suppression = exactly the union Sidebar.tsx builds for its
      // remote-ring gate; keys in it render ring-less on this device, so they
      // must not receive remote tiers either.
      const ringSuppressionKeys = new Set<string>(refKeys)
      for (const paneActivity of identityByPaneId.values()) {
        for (const key of paneActivity.sessionKeys) ringSuppressionKeys.add(key)
        for (const key of paneActivity.busySessionKeys) ringSuppressionKeys.add(key)
      }

      const tiers: Record<string, SessionStatusTier> = {}
      for (const key of busyKeys) tiers[key] = 'local-busy'
      for (const key of localOpenKeys) {
        if (!tiers[key]) tiers[key] = 'local-open'
      }

      const sameDeviceKeys = new Set(Object.keys(deriveRemoteSessionActivity(sameDeviceOpen)))
      const remoteActivity = deriveRemoteSessionActivity(remoteOpen)
      for (const [key, status] of Object.entries(remoteActivity)) {
        if (tiers[key]) continue // local wins: a session open here never rings
        if (sameDeviceKeys.has(key)) continue // same-device records never ring
        if (ringSuppressionKeys.has(key)) continue // ring suppressed here: no remote tier
        tiers[key] = status === 'busy' ? 'remote-busy' : 'remote-open'
      }

      return tiers
    },
  )
