/**
 * Name reliability (Tasks 9 and 14) — the names a tab rebuilt from a recorded
 * snapshot gets back. One rule set for every rebuild: the new-window /
 * recovery rebuild (`src/lib/recovery/build-recovery-plan.ts`) and the
 * tabs-registry opens of the Tabs view (`src/lib/tab-registry-open.ts`).
 *
 * - The recorded pane titles and "user renamed" flags, remapped to the
 *   rebuilt pane ids through the explicit old→new pane-id map (a pane that is
 *   not rebuilt loses its entry).
 * - A flag only together with its title: alone it would freeze the derived
 *   label.
 * - Never for a scoped agent pane (Claude/Codex/OpenCode): its saved session
 *   record names it, so the recorded label is an old alias
 *   (`stripScopedPaneTitleMetadata`, the one client sanitizer).
 * - The tab's own flag only for a tab that is not session-owned (its owner is
 *   the recorded pointer, or the rebuilt layout's first leaf when the record
 *   carries none).
 */
import type { PaneNode } from '@/store/paneTypes'
import type { TabNameSource } from '@shared/session-names'
import { resolveInitialTabNameSource } from '@/lib/tab-name-source'
import { stripScopedPaneTitleMetadata } from '@/lib/session-name-migration'
import { createLogger } from '@/lib/client-logger'

const log = createLogger('restored-tab-names')

/** What a record says about its tab: the key it is logged by and its flag. */
export type RecordedTabNames = { tabKey: string; titleSetByUser?: boolean }

/** What a record says about one pane's name. */
export type RecordedPaneName = { paneId: string; title?: string; titleSetByUser?: boolean }

export type RestoredTabNames = {
  /** True when the rebuilt tab keeps the record's "user renamed" flag. */
  titleSetByUser?: true
  /** Pane titles keyed by the REBUILT pane ids. */
  paneTitles: Record<string, string>
  /** The renamed panes, keyed like `paneTitles`. */
  paneTitleSetByUser: Record<string, boolean>
}

/** Re-key a pane-id map through the explicit old→new pane-id map; entries
 * whose pane is not rebuilt are dropped. */
export function remapPaneKeyedMap<T>(
  map: Record<string, T>,
  paneIdMap: ReadonlyMap<string, string>,
): Record<string, T> {
  const remapped: Record<string, T> = {}
  for (const [oldPaneId, value] of Object.entries(map)) {
    const newPaneId = paneIdMap.get(oldPaneId)
    if (newPaneId) remapped[newPaneId] = value
  }
  return remapped
}

/**
 * The names the rebuilt tab `tabId` gets back. `layout` is the rebuilt
 * layout (only its leaves and its first leaf matter); `recordedPanes` are the
 * record's panes under their RECORDED ids, mapped to rebuilt ids by
 * `paneIdMap`; `nameSource` is the rebuilt tab's pointer, if any.
 */
export function restoredTabNames(input: {
  tab: RecordedTabNames
  tabId: string
  recordedPanes: readonly RecordedPaneName[]
  layout: PaneNode
  paneIdMap: ReadonlyMap<string, string>
  nameSource: TabNameSource | undefined
}): RestoredTabNames {
  const { tab, tabId, recordedPanes, layout, paneIdMap, nameSource } = input
  const recordedTitles: Record<string, string> = {}
  const recordedFlags: Record<string, boolean> = {}
  let droppedUntitledPaneFlags = 0
  for (const p of recordedPanes) {
    if (typeof p.title !== 'string' || p.title.length === 0) {
      // A flag only protects a title: alone it would freeze the derived label.
      if (p.titleSetByUser === true) droppedUntitledPaneFlags += 1
      continue
    }
    recordedTitles[p.paneId] = p.title
    if (p.titleSetByUser === true) recordedFlags[p.paneId] = true
  }
  if (droppedUntitledPaneFlags > 0) {
    log.debug('rebuild dropped pane rename flags recorded without a title', {
      tabKey: tab.tabKey,
      droppedUntitledPaneFlags,
    })
  }
  const remappedTitles = remapPaneKeyedMap(recordedTitles, paneIdMap)
  const sanitized = stripScopedPaneTitleMetadata(
    { [tabId]: layout },
    { [tabId]: remappedTitles },
    { [tabId]: remapPaneKeyedMap(recordedFlags, paneIdMap) },
  )
  const paneTitles = sanitized.paneTitles[tabId] ?? {}
  const paneTitleSetByUser = sanitized.paneTitleSetByUser[tabId] ?? {}
  const sessionOwned = (nameSource ?? resolveInitialTabNameSource(layout))?.kind === 'session'
  const droppedTabUserFlag = tab.titleSetByUser === true && sessionOwned
  const droppedScopedPaneTitles = Object.keys(remappedTitles).length - Object.keys(paneTitles).length
  if (droppedScopedPaneTitles > 0 || droppedTabUserFlag) {
    log.debug('rebuild dropped names owned by saved session records', {
      tabKey: tab.tabKey,
      droppedScopedPaneTitles,
      droppedTabUserFlag,
    })
  }
  return {
    ...(tab.titleSetByUser === true && !sessionOwned ? { titleSetByUser: true as const } : {}),
    paneTitles,
    paneTitleSetByUser,
  }
}
