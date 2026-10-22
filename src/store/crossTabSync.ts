import { z } from 'zod'
import { mergeLocalSettings, resolveLocalSettings } from '@shared/settings'
import { getSelectedMachineId } from '@/lib/machine-identity'
import { paneTitleMetadataEquals } from './hydrate-pane-metadata-merge'
import type { PanesState } from './paneTypes'
import { hydratePanes, hydratePaneTitles } from './panesSlice'
import { setLocalSettings, localSettingsPlatformDefaults } from './settingsSlice'
import { setTabRegistryClosedTabRetentionDays } from './tabRegistrySlice'
import { hydrateTabs } from './tabsSlice'
import { getPendingBrowserPreferencesWriteState } from './browserPreferencesPersistence'
import { parsePersistedLayoutRaw, type ParsedPersistedLayout } from './persistedState'
import { getPersistBroadcastSourceId, onPersistBroadcast, PERSIST_BROADCAST_CHANNEL_NAME } from './persistBroadcast'
import { shouldPreserveLocalCanonicalResumeSessionId } from './persistControl'
import { getBootLoadedLayoutRaw } from './persistMiddleware'
import { BROWSER_PREFERENCES_STORAGE_KEY, TAB_RECENCY_STORAGE_KEY } from './storage-keys'
import { getWindowLayoutKey, isDerivedLayoutKey } from './window-layout-keys'
import { collectLiveTerminalPaneIds } from './tabRecencyPruneMiddleware'
import {
  loadPersistedTabRecency,
  mergeHydratedTabRecency,
  prunePaneTabActivityToLiveTerminalPanes,
} from './tabRecencySlice'
import { parseBrowserPreferencesRaw, resolveBrowserPreferenceSettings } from '@/lib/browser-preferences'

type StoreLike = {
  dispatch: (action: any) => any
  getState: () => any
}

const DEFAULT_CLOSED_TAB_RETENTION_DAYS = 30

const zPersistBroadcastMsg = z.object({
  type: z.literal('persist'),
  key: z.string(),
  raw: z.string(),
  sourceId: z.string(),
})

/** Delta round 3, finding 1 + e3r1 finding 4: the layout subscription
 * observes the per-window key PREFIX (freshell.layout.v3.<layoutWindowId>).
 * Events for OTHER windows' keys run the TITLE-ONLY reconciliation; events
 * for THIS window's own key (duplicate tabs before their lease-collision
 * rotation remints the id — e3r2 finding 1 — and pre-change windows
 * during a deploy transition) keep the full incoming-hydrate path. The
 * exact keys below are the layout-independent sidecars. */
function isCrossTabSyncStorageKey(key: string): boolean {
  return key === BROWSER_PREFERENCES_STORAGE_KEY
    || key === TAB_RECENCY_STORAGE_KEY
    || isDerivedLayoutKey(key)
}

function collectPaneIdsSafe(node: unknown): string[] {
  const ids: string[] = []

  const visit = (n: any) => {
    if (!n || typeof n !== 'object') return

    if (n.type === 'leaf') {
      if (typeof n.id === 'string') ids.push(n.id)
      return
    }

    if (n.type === 'split' && Array.isArray(n.children) && n.children.length >= 2) {
      visit(n.children[0])
      visit(n.children[1])
      return
    }
  }

  visit(node)
  return ids
}

function findLeafContentById(node: unknown, paneId: string): any | undefined {
  const visit = (candidate: any): any | undefined => {
    if (!candidate || typeof candidate !== 'object') return undefined
    if (candidate.type === 'leaf') {
      return candidate.id === paneId ? candidate.content : undefined
    }
    if (candidate.type === 'split' && Array.isArray(candidate.children) && candidate.children.length >= 2) {
      return visit(candidate.children[0]) ?? visit(candidate.children[1])
    }
    return undefined
  }

  return visit(node)
}

function buildCanonicalClaudeSessionRef(localContent: any, localResumeSessionId: string): {
  provider: 'claude'
  sessionId: string
} | undefined {
  const explicit = localContent?.sessionRef
  if (
    explicit
    && typeof explicit === 'object'
    && explicit.provider === 'claude'
    && explicit.sessionId === localResumeSessionId
  ) {
    return {
      provider: 'claude',
      sessionId: localResumeSessionId,
    }
  }

  if (
    localContent?.kind === 'fresh-agent'
    || (localContent?.kind === 'terminal' && localContent?.mode === 'claude')
  ) {
    return {
      provider: 'claude',
      sessionId: localResumeSessionId,
    }
  }

  return undefined
}

function protectCanonicalPaneResumeIdentity(remoteNode: unknown, localLayout: unknown): unknown {
  const visit = (candidate: any): any => {
    if (!candidate || typeof candidate !== 'object') return candidate
    if (candidate.type === 'leaf') {
      const localContent = findLeafContentById(localLayout, candidate.id)
      const localResumeSessionId = localContent?.resumeSessionId
      const remoteResumeSessionId = candidate.content?.resumeSessionId
      if (
        (
          candidate.content?.kind === 'terminal'
          || candidate.content?.kind === 'fresh-agent'
        )
        && shouldPreserveLocalCanonicalResumeSessionId(localResumeSessionId, remoteResumeSessionId)
      ) {
        const preservedSessionRef = buildCanonicalClaudeSessionRef(localContent, localResumeSessionId)
        const contentWithoutStaleRestoreError = { ...candidate.content }
        delete contentWithoutStaleRestoreError.restoreError
        return {
          ...candidate,
          content: {
            ...contentWithoutStaleRestoreError,
            resumeSessionId: localResumeSessionId,
            sessionRef: preservedSessionRef,
          },
        }
      }
      return candidate
    }
    if (candidate.type === 'split' && Array.isArray(candidate.children) && candidate.children.length >= 2) {
      return {
        ...candidate,
        children: [
          visit(candidate.children[0]),
          visit(candidate.children[1]),
        ],
      }
    }
    return candidate
  }

  return visit(remoteNode)
}

/** Receiving page's machine id, from the same source the persist stamp uses
 * (persistMiddleware's selectStampMachineId: store slice first, remembered
 * selection fallback). */
function selectReceivingMachineId(store: StoreLike): string | undefined {
  const known = store.getState()?.machineIdentity?.selectedMachine?.id
  if (typeof known === 'string' && known) return known
  return getSelectedMachineId()
}

/** Foreign-layout guard: the layout storage key and broadcast channel are
 * origin-wide, so a window on another machine can hydrate its stamped
 * layout into this page — a later mutation here would then persist a mixed
 * workspace under THIS machine's stamp. A stamped incoming layout is
 * ignored unless its machineId equals the receiving page's machine.
 * Unstamped (legacy) incoming never counts foreign, mirroring the boot
 * classifier's unstamped-never-foreign rule (layout-health.ts). */
function isForeignIncomingLayout(store: StoreLike, raw: string): boolean {
  let parsed: ParsedPersistedLayout | null = null
  try {
    parsed = parsePersistedLayoutRaw(raw)
  } catch {
    parsed = null
  }
  const stamp = parsed?.machineId
  if (typeof stamp !== 'string' || !stamp) return false
  return stamp !== selectReceivingMachineId(store)
}

function dispatchHydrateLayoutFromPersisted(
  store: StoreLike,
  raw: string,
  localLayoutPersistedAt?: number,
) {
  const parsed = parsePersistedLayoutRaw(raw)
  if (!parsed) return
  const state = store.getState()
  const localLayouts = (state?.panes?.layouts || {}) as Record<string, unknown>
  const protectedLayouts = Object.fromEntries(
    Object.entries(parsed.panes.layouts || {}).map(([tabId, node]) => [
      tabId,
      protectCanonicalPaneResumeIdentity(node, localLayouts[tabId]),
    ]),
  )

  // Hydrate tabs with merge
  store.dispatch({
    ...hydrateTabs({
      tabs: parsed.tabs.tabs,
      activeTabId: parsed.tabs.activeTabId,
      renameRequestTabId: null,
      tombstones: parsed.tombstones,
    } as any),
    meta: {
      skipPersist: true,
      source: 'cross-tab',
      localLayoutPersistedAt,
      remoteLayoutPersistedAt: parsed.persistedAt,
    },
  })

  // Hydrate panes
  const localActiveByTab = (state?.panes?.activePane || {}) as Record<string, string>
  const nextActive: Record<string, string> = {}

  for (const [tabId, node] of Object.entries(protectedLayouts)) {
    const leafIds = collectPaneIdsSafe(node)
    if (leafIds.length === 0) continue
    const leafSet = new Set(leafIds)

    const localDesired = localActiveByTab[tabId]
    if (typeof localDesired === 'string' && leafSet.has(localDesired)) {
      nextActive[tabId] = localDesired
      continue
    }

    const remoteDesired = parsed.panes.activePane?.[tabId]
    if (typeof remoteDesired === 'string' && leafSet.has(remoteDesired)) {
      nextActive[tabId] = remoteDesired
      continue
    }

    nextActive[tabId] = leafIds[leafIds.length - 1]
  }

  store.dispatch({
    ...hydratePanes({
      layouts: protectedLayouts as any,
      activePane: nextActive,
      paneTitles: parsed.panes.paneTitles,
      paneTitleSetByUser: parsed.panes.paneTitleSetByUser,
    } as any),
    meta: {
      skipPersist: true,
      source: 'cross-tab',
      localLayoutPersistedAt,
      remoteLayoutPersistedAt: parsed.persistedAt,
    },
  })
}

function dispatchHydrateBrowserPreferencesFromPersisted(
  store: StoreLike,
  raw: string,
  previousRaw?: string,
) {
  const parsed = parseBrowserPreferencesRaw(raw)
  if (!parsed) return

  const previousParsed = previousRaw ? parseBrowserPreferencesRaw(previousRaw) : null
  const remoteResetSettingsToDefaults = previousParsed?.settings !== undefined && parsed.settings === undefined
  const previousRetention = previousParsed?.tabs?.closedTabRetentionDays ?? previousParsed?.tabs?.searchRangeDays
  const parsedRetention = parsed.tabs?.closedTabRetentionDays ?? parsed.tabs?.searchRangeDays
  const remoteResetRetentionToDefault =
    previousRetention !== undefined && parsedRetention === undefined
  const pendingWriteState = getPendingBrowserPreferencesWriteState(store)
  const remoteSettingsPatch = parsed.settings ?? {}
  let mergedSettingsPatch = remoteSettingsPatch
  if (pendingWriteState.settingsPatch) {
    mergedSettingsPatch = mergeLocalSettings(mergedSettingsPatch, pendingWriteState.settingsPatch)
  }
  const nextSettings = pendingWriteState.settingsPatch
    ? resolveLocalSettings(mergedSettingsPatch, localSettingsPlatformDefaults)
    : resolveBrowserPreferenceSettings(parsed, localSettingsPlatformDefaults)
  const hasPendingRetention = pendingWriteState.hasPendingClosedTabRetentionDays ?? pendingWriteState.hasPendingSearchRangeDays
  const pendingRetention = pendingWriteState.closedTabRetentionDays ?? pendingWriteState.searchRangeDays
  const nextClosedTabRetentionDays = hasPendingRetention
    ? pendingRetention
    : (parsedRetention ?? DEFAULT_CLOSED_TAB_RETENTION_DAYS)

  if (
    parsed.settings
    || remoteResetSettingsToDefaults
    || pendingWriteState.settingsPatch
  ) {
    store.dispatch({
      ...setLocalSettings(nextSettings),
      meta: { skipPersist: true, source: 'cross-tab' },
    })
  }
  if (
    parsedRetention !== undefined
    || remoteResetRetentionToDefault
    || hasPendingRetention
  ) {
    store.dispatch({
      ...setTabRegistryClosedTabRetentionDays(nextClosedTabRetentionDays),
      meta: { skipPersist: true, source: 'cross-tab' },
    })
  }
}

/** TITLE-ONLY reconciliation for ANOTHER window's layout event (e3r1
 * finding 4): another window's arrangement is that window's business —
 * the approved divergence tradeoff says arrangements may stay divergent
 * indefinitely — so its flush may only deliver pane TITLES to panes that
 * exist in BOTH envelopes, under the Task-7 merge rules (recency via the
 * layout persistedAt meta, user-set precedence). No hydrateTabs, no
 * hydratePanes: tab set, order, trees, content, active panes, and
 * ephemeral pane state (zoom, refresh requests, …) are never adopted.
 *
 * DURABLE by design (e3r3 finding 1): the title apply is deliberately
 * NOT skipPersist — the receiving window's own envelope must carry the
 * received title (and its user-set flag), or a refresh before any
 * unrelated mutation causes a flush would lose it. The write converges
 * instead of echoing: hydratePaneTitles is a reducer-level no-op when
 * the merge produces exactly the titles the state already holds
 * (paneTitleMetadataEquals), so a receiver that already has the title
 * neither changes state nor re-flushes, and the per-key raw dedupe drops
 * repeat deliveries of the same envelope bytes. One flush per real title
 * change, zero for equal ones. */
function dispatchHydratePaneTitlesFromPersisted(
  store: StoreLike,
  raw: string,
  localLayoutPersistedAt?: number,
) {
  let parsed: ParsedPersistedLayout | null = null
  try {
    parsed = parsePersistedLayoutRaw(raw)
  } catch {
    parsed = null
  }
  if (!parsed) return
  store.dispatch({
    ...hydratePaneTitles({
      paneTitles: parsed.panes.paneTitles,
      paneTitleSetByUser: parsed.panes.paneTitleSetByUser,
      layouts: parsed.panes.layouts,
    }),
    meta: {
      source: 'cross-tab',
      localLayoutPersistedAt,
      remoteLayoutPersistedAt: parsed.persistedAt,
    },
  })
}

/** Snapshot of exactly the pane-title metadata a title-only merge may
 * change (hydratePaneTitles writes paneTitles and paneTitleSetByUser,
 * nothing else) — the applied-vs-no-op discriminator for the foreign-key
 * floor advance in handleIncomingRawDeduped. */
function paneTitleMetadataOf(store: StoreLike): Pick<PanesState, 'paneTitles' | 'paneTitleSetByUser'> | undefined {
  const panes = store.getState()?.panes
  if (!panes) return undefined
  return { paneTitles: panes.paneTitles, paneTitleSetByUser: panes.paneTitleSetByUser }
}

function handleIncomingRaw(
  store: StoreLike,
  key: string,
  raw: string,
  previousRaw?: string,
  localLayoutPersistedAt?: number,
) {
  if (isDerivedLayoutKey(key)) {
    if (key === getWindowLayoutKey()) {
      // The OWN key: a duplicate tab that has not yet reminted its
      // layout-window id (pre-rotation, or a pre-change window during a
      // deploy transition) wrote this envelope — same-window envelope
      // replacement, full hydrate.
      dispatchHydrateLayoutFromPersisted(store, raw, localLayoutPersistedAt)
    } else {
      // ANOTHER window's key: title-only.
      dispatchHydratePaneTitlesFromPersisted(store, raw, localLayoutPersistedAt)
    }
  } else if (key === BROWSER_PREFERENCES_STORAGE_KEY) {
    dispatchHydrateBrowserPreferencesFromPersisted(store, raw, previousRaw)
  } else if (key === TAB_RECENCY_STORAGE_KEY) {
    store.dispatch({
      ...mergeHydratedTabRecency(loadPersistedTabRecency(raw)),
      meta: { skipPersist: true, source: 'cross-tab' },
    })
    store.dispatch({
      ...prunePaneTabActivityToLiveTerminalPanes({
        paneIds: collectLiveTerminalPaneIds(store.getState()),
      }),
      meta: { source: 'cross-tab' },
    })
  }
}

export function installCrossTabSync(store: StoreLike): () => void {
  if (typeof window === 'undefined') return () => {}

  const ownLayoutKey = getWindowLayoutKey()

  // Storage events and BroadcastChannel can both deliver the same persisted payload.
  // Dedupe by exact raw value so we don't hydrate twice.
  const lastProcessedRawByKey = new Map<string, string>()
  let currentLocalLayoutPersistedAt: number | undefined
  for (const key of [ownLayoutKey, BROWSER_PREFERENCES_STORAGE_KEY, TAB_RECENCY_STORAGE_KEY]) {
    const existingRaw = localStorage.getItem(key)
    if (typeof existingRaw === 'string') {
      lastProcessedRawByKey.set(key, existingRaw)
      if (key === ownLayoutKey) {
        const parsed = parsePersistedLayoutRaw(existingRaw)
        currentLocalLayoutPersistedAt = parsed?.persistedAt
      }
    }
  }

  const mergeAuthoritativeLayoutPersistedAt = (candidate?: number) => {
    if (typeof candidate !== 'number') return
    if (typeof currentLocalLayoutPersistedAt !== 'number' || candidate > currentLocalLayoutPersistedAt) {
      currentLocalLayoutPersistedAt = candidate
    }
  }

  const tryDedupeAndMark = (key: string, raw: string): boolean => {
    if (lastProcessedRawByKey.get(key) === raw) return false
    lastProcessedRawByKey.set(key, raw)
    return true
  }

  const handleIncomingRawDeduped = (key: string, raw: string) => {
    // Ignore a foreign-machine layout entirely: no dispatch, no dedupe
    // mark, no authoritative-persistedAt merge (the event is not ours).
    if (isDerivedLayoutKey(key) && isForeignIncomingLayout(store, raw)) return
    const previousRaw = lastProcessedRawByKey.get(key)
    if (!tryDedupeAndMark(key, raw)) return
    // Resolve the own key DYNAMICALLY at every classification/floor point
    // (delta r5 finding 2): the registry lease-collision rotation can
    // remint the layout-window id mid-session
    // (tabRegistrySync.rotateClientInstanceIdAfterCollision →
    // remintLayoutWindowId), so the key captured at install can name an id
    // this window no longer holds. An OLD-key event after a remint is a
    // FOREIGN window's event — handleIncomingRaw already routes it
    // title-only through the dynamic getter, and the floor lines must
    // classify it the same way instead of treating it as the receiver's
    // own key (a no-op then advanced the recency floor and let it reject
    // another window's strictly-newer title).
    const foreignLayoutKey = isDerivedLayoutKey(key) && key !== getWindowLayoutKey()
    const paneTitleMetadataBefore = foreignLayoutKey ? paneTitleMetadataOf(store) : undefined
    handleIncomingRaw(store, key, raw, previousRaw, currentLocalLayoutPersistedAt)
    if (key === getWindowLayoutKey()) {
      // Recency floor (e3r4 finding 3): advance where the incoming
      // envelope actually REPLACED local state — the own-key full-hydrate
      // path (hydrateTabs + hydratePanes), mirroring the tabs winner
      // pattern. Storage and BroadcastChannel deliveries from independent
      // windows have no cross-source total ordering, so a foreign NO-OP
      // (equal titles, or sharing no panes) replaces nothing and must not
      // move the floor — a foreign no-op at a higher stamp would
      // otherwise reject a different window's strictly-newer title
      // delivery.
      mergeAuthoritativeLayoutPersistedAt(parsePersistedLayoutRaw(raw)?.persistedAt)
    } else if (foreignLayoutKey && paneTitleMetadataBefore !== undefined) {
      // Delta r4 finding 2: an APPLIED foreign title-only event advances
      // the floor IMMEDIATELY (to the applied event's persistedAt), not
      // at the receiver's debounced (~500ms) durable reconciliation
      // flush: until that flush lands the floor still names the OLD
      // local envelope, so a second window's OLDER title — still newer
      // than the stale floor — would apply pre-flush, overwrite the
      // just-applied one, and the flush would make the regression
      // durable. The applied titles ARE local state now, so their stamp
      // is the recency truth; a foreign no-op changed nothing and still
      // never touches the floor.
      const paneTitleMetadataAfter = paneTitleMetadataOf(store)
      if (paneTitleMetadataAfter !== undefined
        && !paneTitleMetadataEquals(paneTitleMetadataBefore, paneTitleMetadataAfter)) {
        mergeAuthoritativeLayoutPersistedAt(parsePersistedLayoutRaw(raw)?.persistedAt)
      }
    }
  }

  // Install-time staleness check (delta round 3, finding 2, belt-and-braces):
  // the module-init loaders read the envelope at module load; sync installs
  // only at machine-ready. With per-window keys no OTHER window can replace
  // this envelope, but the migration or a same-window writer still can —
  // if the own-key raw changed since load, process the replacement as an
  // incoming hydrate event (recency-guarded through the hydrate reducers)
  // instead of silently marking it processed. `undefined` (loaders never
  // ran in this module instance) keeps the previous silent-mark behavior.
  const bootRaw = getBootLoadedLayoutRaw()
  if (bootRaw !== undefined) {
    const currentRaw = localStorage.getItem(ownLayoutKey)
    if (typeof currentRaw === 'string' && currentRaw !== bootRaw && !isForeignIncomingLayout(store, currentRaw)) {
      // The local side of the recency comparison is what Redux actually
      // holds: the loaded raw's persistedAt (undefined when the loaders
      // found nothing — the replacement then applies wholesale).
      const bootPersistedAt = typeof bootRaw === 'string'
        ? parsePersistedLayoutRaw(bootRaw)?.persistedAt
        : undefined
      handleIncomingRaw(store, ownLayoutKey, currentRaw, bootRaw ?? undefined, bootPersistedAt)
      mergeAuthoritativeLayoutPersistedAt(parsePersistedLayoutRaw(currentRaw)?.persistedAt)
    }
  }

  // Keep dedupe state in sync with local writes too. Otherwise, if we process a remote raw,
  // then diverge locally (persisted raw changes), a later remote event with the original raw
  // could be incorrectly ignored.
  const unsubscribeLocal = onPersistBroadcast((msg) => {
    if (!isCrossTabSyncStorageKey(msg.key)) {
      return
    }
    lastProcessedRawByKey.set(msg.key, msg.raw)
    if (isDerivedLayoutKey(msg.key)) {
      currentLocalLayoutPersistedAt = parsePersistedLayoutRaw(msg.raw)?.persistedAt
    }
  })

  // Storage events fire ONLY for cross-document writes (a window never
  // receives its own localStorage writes as events — browser semantics),
  // so an event carrying THIS window's own key is still a legitimate
  // incoming event: another document wrote our key (e.g. the e2e recency
  // staging, or a pre-change window during a deploy transition).
  const onStorage = (e: StorageEvent) => {
    if (e.storageArea && e.storageArea !== localStorage) return
    const key = e.key
    if (typeof key !== 'string' || !isCrossTabSyncStorageKey(key)) {
      return
    }
    if (e.newValue === null) {
      // A removal (e3r2 finding 3): the stale-envelope prune sweep deletes
      // derived keys cross-document, and lastProcessedRawByKey would
      // otherwise retain one complete serialized layout per observed
      // window forever — a removed-then-recreated key replaying identical
      // bytes would be deduped as already-processed.
      lastProcessedRawByKey.delete(key)
      return
    }
    if (typeof e.newValue !== 'string') return
    handleIncomingRawDeduped(key, e.newValue)
  }

  window.addEventListener('storage', onStorage)

  let channel: BroadcastChannel | null = null
  if (typeof BroadcastChannel !== 'undefined') {
    channel = new BroadcastChannel(PERSIST_BROADCAST_CHANNEL_NAME)
    channel.onmessage = (event) => {
      const res = zPersistBroadcastMsg.safeParse((event as any)?.data)
      if (!res.success) return
      if (res.data.sourceId === getPersistBroadcastSourceId()) return
      // Defensive own-key filter on the broadcast path: the own key is
      // only ever this window's envelope, and same-window writes already
      // arrived through onPersistBroadcast above.
      if (res.data.key === ownLayoutKey) return
      handleIncomingRawDeduped(res.data.key, res.data.raw)
    }
  }

  return () => {
    unsubscribeLocal()
    window.removeEventListener('storage', onStorage)
    if (channel) {
      try {
        channel.close()
      } catch {
        // ignore
      }
    }
  }
}
