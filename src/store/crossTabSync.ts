import { z } from 'zod'
import { mergeLocalSettings, resolveLocalSettings } from '@shared/settings'
import { getSelectedMachineId } from '@/lib/machine-identity'
import { captureLegacyLayoutEnvelope } from '@/lib/session-name-migration'
import { createLogger } from '@/lib/client-logger'
import { paneTitleMetadataEquals } from './hydrate-pane-metadata-merge'
import type { PanesState } from './paneTypes'
import { hydratePanes, hydratePaneTitles } from './panesSlice'
import { setLocalSettings, localSettingsPlatformDefaults } from './settingsSlice'
import { setTabRegistryClosedTabRetentionDays } from './tabRegistrySlice'
import { hydrateTabs } from './tabsSlice'
import { getPendingBrowserPreferencesWriteState } from './browserPreferencesPersistence'
import { parsePersistedLayoutRaw, type ParsedPersistedLayout } from './persistedState'
import { getPersistBroadcastSourceId, onPersistBroadcast, PERSIST_BROADCAST_CHANNEL_NAME } from './persistBroadcast'
import {
  getAuthoritativeLocalLayoutPersistedAt,
  getLocalLayoutBaselinePersistedAt,
  flushPersistedLayoutNow,
  initializeLocalLayoutBaselinePersistedAt,
  isLocalClosePersistencePending,
  observeLocalLayoutWriteTimestamp,
  observeAuthoritativeLocalLayoutPersistedAt,
  setLocalLayoutBaselinePersistedAt,
  shouldPreserveLocalCanonicalResumeSessionId,
} from './persistControl'
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

const log = createLogger('CrossTabSync')

type StoreLike = {
  dispatch: (action: any) => any
  getState: () => any
  subscribe?: (listener: () => void) => () => void
}

function hasPaneCloseInFlight(store: StoreLike): boolean {
  const panes = store.getState()?.panes
  if (!panes) return false
  if (Object.values(panes.closingTabs ?? {}).some((closing) => closing === true)) return true
  return Object.values(panes.closingPanes ?? {}).some((closing) => closing === true)
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
  preserveLocalPaneTitlesAt?: number,
) {
  const parsed = parsePersistedLayoutRaw(raw)
  if (!parsed) return
  const state = store.getState()
  const localLayouts = (state?.panes?.layouts || {}) as Record<string, unknown>
  const localPaneTitles = state?.panes?.paneTitles
  const localPaneTitleSetByUser = state?.panes?.paneTitleSetByUser
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

  if (
    typeof preserveLocalPaneTitlesAt === 'number'
    && typeof parsed.persistedAt === 'number'
    && preserveLocalPaneTitlesAt > parsed.persistedAt
    && localPaneTitles
  ) {
    // A foreign title event has its own recency floor, independent from the
    // same-key topology baseline. Apply the incoming structure while
    // retaining newer local title metadata for panes that remain present.
    store.dispatch({
      ...hydratePaneTitles({
        paneTitles: localPaneTitles,
        paneTitleSetByUser: localPaneTitleSetByUser ?? {},
        layouts: localLayouts,
      }),
      meta: {
        source: 'cross-tab',
        localLayoutPersistedAt: parsed.persistedAt,
        remoteLayoutPersistedAt: preserveLocalPaneTitlesAt,
      },
    })
  }
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
  preserveLocalPaneTitlesAt?: number,
) {
  if (isDerivedLayoutKey(key)) {
    if (key === getWindowLayoutKey()) {
      // The OWN key: a duplicate tab that has not yet reminted its
      // layout-window id (pre-rotation, or a pre-change window during a
      // deploy transition) wrote this envelope — same-window envelope
      // replacement, full hydrate.
      dispatchHydrateLayoutFromPersisted(store, raw, localLayoutPersistedAt, preserveLocalPaneTitlesAt)
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
  const persistControlOwner = store.getState
  const persistBroadcastSourceId = getPersistBroadcastSourceId(persistControlOwner)
  let currentLocalLayoutPersistedAt = getAuthoritativeLocalLayoutPersistedAt(ownLayoutKey, persistControlOwner)
  let deferredOwnLayoutRaw: string | null = null
  for (const key of [ownLayoutKey, BROWSER_PREFERENCES_STORAGE_KEY, TAB_RECENCY_STORAGE_KEY]) {
    const existingRaw = localStorage.getItem(key)
    if (typeof existingRaw === 'string') {
      if (key === ownLayoutKey) {
        const parsed = parsePersistedLayoutRaw(existingRaw)
        observeLocalLayoutWriteTimestamp(key, parsed?.persistedAt, persistControlOwner)
        const knownBaseline = getLocalLayoutBaselinePersistedAt(ownLayoutKey, persistControlOwner)
        if (knownBaseline === undefined) {
          const initialBaseline = parsed?.persistedAt ?? null
          initializeLocalLayoutBaselinePersistedAt(ownLayoutKey, initialBaseline, persistControlOwner)
          lastProcessedRawByKey.set(key, existingRaw)
          if (typeof initialBaseline === 'number') {
            if (
              typeof currentLocalLayoutPersistedAt !== 'number'
              || initialBaseline > currentLocalLayoutPersistedAt
            ) {
              currentLocalLayoutPersistedAt = initialBaseline
            }
            observeAuthoritativeLocalLayoutPersistedAt(ownLayoutKey, initialBaseline, persistControlOwner)
          }
        } else if (currentLocalLayoutPersistedAt === undefined && typeof knownBaseline === 'number') {
          currentLocalLayoutPersistedAt = knownBaseline
          if (parsed?.persistedAt === knownBaseline) lastProcessedRawByKey.set(key, existingRaw)
        } else if (
          (typeof knownBaseline === 'number' && parsed?.persistedAt === knownBaseline)
          || (knownBaseline === null && typeof parsed?.persistedAt !== 'number')
        ) {
          lastProcessedRawByKey.set(key, existingRaw)
        }
      } else {
        lastProcessedRawByKey.set(key, existingRaw)
      }
    }
  }

  const mergeAuthoritativeLayoutPersistedAt = (candidate?: number) => {
    if (typeof candidate !== 'number') return
    if (typeof currentLocalLayoutPersistedAt !== 'number' || candidate > currentLocalLayoutPersistedAt) {
      currentLocalLayoutPersistedAt = candidate
    }
    observeAuthoritativeLocalLayoutPersistedAt(getWindowLayoutKey(), candidate, persistControlOwner)
  }

  const tryDedupeAndMark = (key: string, raw: string): boolean => {
    if (lastProcessedRawByKey.get(key) === raw) return false
    lastProcessedRawByKey.set(key, raw)
    return true
  }

  const deferOwnLayoutRaw = (raw: string) => {
    const incomingAt = parsePersistedLayoutRaw(raw)?.persistedAt
    const pendingAt = deferredOwnLayoutRaw === null
      ? undefined
      : parsePersistedLayoutRaw(deferredOwnLayoutRaw)?.persistedAt
    if (
      deferredOwnLayoutRaw === null
      || (typeof incomingAt === 'number'
        ? typeof pendingAt !== 'number' || incomingAt >= pendingAt
        : typeof pendingAt !== 'number')
    ) {
      deferredOwnLayoutRaw = raw
    }
  }

  const handleIncomingRawDeduped = (key: string, raw: string) => {
    // Ignore a foreign-machine layout entirely: no dispatch, no dedupe
    // mark, no authoritative-persistedAt merge (the event is not ours).
    if (isDerivedLayoutKey(key) && isForeignIncomingLayout(store, raw)) return
    if (isDerivedLayoutKey(key) && key === getWindowLayoutKey()) {
      // Preserve monotonically increasing emitted stamps even when this raw
      // is rejected/deferred. This serialization high-water does not
      // authorize hydration or advance either accepted recency floor.
      observeLocalLayoutWriteTimestamp(key, parsePersistedLayoutRaw(raw)?.persistedAt, persistControlOwner)
    }
    // Do not mark a same-key event processed while the close reducers are
    // freezing a pane tree or its final layout write is pending. Hydration
    // during that window would preserve the stale tree, while a timestamp
    // alone could falsely certify it as applied and flush it over the close.
    if (
      isDerivedLayoutKey(key)
      && key === getWindowLayoutKey()
      && (
        hasPaneCloseInFlight(store)
        || isLocalClosePersistencePending(persistControlOwner)
      )
    ) {
      deferOwnLayoutRaw(raw)
      return
    }
    const previousRaw = lastProcessedRawByKey.get(key)
    if (!tryDedupeAndMark(key, raw)) return
    // Unified agent names (Task 7): an OLD envelope arriving later through
    // crossTabSync (a pre-change window's flush, or a duplicate tab before
    // its rotation remint) is captured as immutable legacy-name evidence
    // BEFORE the sanitized hydrate below runs — its labels are preserved
    // for the consolidation import, never evaporated by sanitization.
    if (isDerivedLayoutKey(key)) {
      try {
        captureLegacyLayoutEnvelope(key, raw)
      } catch {
        // Capture is best-effort here; the next ready edge re-captures.
      }
    }
    if (key === getWindowLayoutKey()) {
      const incomingPersistedAt = parsePersistedLayoutRaw(raw)?.persistedAt
      const acceptedTopologyAt = getLocalLayoutBaselinePersistedAt(key, persistControlOwner)
      if (
        typeof incomingPersistedAt === 'number'
        && typeof acceptedTopologyAt === 'number'
        && incomingPersistedAt < acceptedTopologyAt
      ) {
        // A raw event may have been deferred while a close froze the Redux
        // tree. If that close then persisted a newer topology, replaying the
        // queued raw would resurrect the tree that the close removed. It is
        // now stale against the accepted topology baseline, even if a
        // foreign title event has a still-higher authoritative floor.
        log.debug('Ignored a stale same-key layout after close reconciliation', {
          reason: 'cross_tab_stale_own_layout',
          layoutKey: key,
          incomingPersistedAt,
          acceptedTopologyAt,
        })
        return
      }
    }
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
    const ownTopologyBaseline = key === getWindowLayoutKey()
      ? getLocalLayoutBaselinePersistedAt(key, persistControlOwner)
      : undefined
    handleIncomingRaw(
      store,
      key,
      raw,
      previousRaw,
      key === getWindowLayoutKey() ? ownTopologyBaseline ?? undefined : currentLocalLayoutPersistedAt,
      key === getWindowLayoutKey() ? currentLocalLayoutPersistedAt : undefined,
    )
    if (key === getWindowLayoutKey()) {
      const incomingPersistedAt = parsePersistedLayoutRaw(raw)?.persistedAt
      const ownLayoutWasApplied = typeof incomingPersistedAt === 'number'
        && (
          typeof ownTopologyBaseline !== 'number'
          || incomingPersistedAt >= ownTopologyBaseline
        )
      if (ownLayoutWasApplied) {
        setLocalLayoutBaselinePersistedAt(key, incomingPersistedAt, persistControlOwner)
      }
      // Recency floor (e3r4 finding 3): advance where the incoming
      // envelope actually REPLACED local state — the own-key full-hydrate
      // path (hydrateTabs + hydratePanes), mirroring the tabs winner
      // pattern. Storage and BroadcastChannel deliveries from independent
      // windows have no cross-source total ordering, so a foreign NO-OP
      // (equal titles, or sharing no panes) replaces nothing and must not
      // move the floor — a foreign no-op at a higher stamp would
      // otherwise reject a different window's strictly-newer title
      if (ownLayoutWasApplied) {
        mergeAuthoritativeLayoutPersistedAt(incomingPersistedAt)
        // A stale local flush may have been refused while this same-key
        // event was queued. Hydration makes that dirty state safe to retry.
        store.dispatch(flushPersistedLayoutNow())
      }
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

  const replayDeferredOwnLayoutIfReady = () => {
    if (
      deferredOwnLayoutRaw === null
      || hasPaneCloseInFlight(store)
      || isLocalClosePersistencePending(persistControlOwner)
    ) return
    const raw = deferredOwnLayoutRaw
    deferredOwnLayoutRaw = null
    handleIncomingRawDeduped(getWindowLayoutKey(), raw)
  }

  // Install-time staleness check (delta round 3, finding 2, belt-and-braces):
  // the module-init loaders read the envelope at module load; sync installs
  // only at machine-ready. With per-window keys no OTHER window can replace
  // this envelope, but the migration or a same-window writer still can —
  // if the own-key raw changed since load, process the replacement as an
  // incoming hydrate event (recency-guarded through the hydrate reducers)
  // instead of silently marking it processed. If the loader never ran in
  // this module instance, use the baseline captured by persistence middleware.
  const bootRaw = getBootLoadedLayoutRaw()
  const currentRaw = localStorage.getItem(ownLayoutKey)
  const localBaselinePersistedAt = getLocalLayoutBaselinePersistedAt(ownLayoutKey, persistControlOwner)
  const bootPersistedAt = typeof bootRaw === 'string'
    ? parsePersistedLayoutRaw(bootRaw)?.persistedAt
    : undefined
  const currentPersistedAt = typeof currentRaw === 'string'
    ? parsePersistedLayoutRaw(currentRaw)?.persistedAt
    : undefined
  const bootRawChanged = bootRaw !== undefined && typeof currentRaw === 'string' && currentRaw !== bootRaw
  const sharedEnvelopeIsNewer = typeof currentPersistedAt === 'number'
    && (
      typeof localBaselinePersistedAt !== 'number'
      || currentPersistedAt > localBaselinePersistedAt
    )
  if (
    typeof currentRaw === 'string'
    && (bootRawChanged || sharedEnvelopeIsNewer)
    && !isForeignIncomingLayout(store, currentRaw)
  ) {
    if (hasPaneCloseInFlight(store) || isLocalClosePersistencePending(persistControlOwner)) {
      deferOwnLayoutRaw(currentRaw)
    } else {
      // Same-key structure is compared with the last accepted topology
      // version. The authoritative floor can be higher because of a foreign
      // title event and must not block a newer local-key topology.
      const comparisonPersistedAt = typeof localBaselinePersistedAt === 'number'
        ? localBaselinePersistedAt
        : bootPersistedAt
      handleIncomingRaw(
        store,
        ownLayoutKey,
        currentRaw,
        bootRaw ?? undefined,
        comparisonPersistedAt,
        currentLocalLayoutPersistedAt,
      )
      const currentWasApplied = typeof currentPersistedAt === 'number'
        && (
          typeof comparisonPersistedAt !== 'number'
          || currentPersistedAt >= comparisonPersistedAt
        )
      if (currentWasApplied) {
        setLocalLayoutBaselinePersistedAt(ownLayoutKey, currentPersistedAt, persistControlOwner)
        mergeAuthoritativeLayoutPersistedAt(currentPersistedAt)
        lastProcessedRawByKey.set(ownLayoutKey, currentRaw)
        store.dispatch(flushPersistedLayoutNow())
      }
    }
  }

  const unsubscribeStore = store.subscribe?.(replayDeferredOwnLayoutIfReady) ?? (() => {})

  // Keep dedupe state in sync with local writes too. Otherwise, if we process a remote raw,
  // then diverge locally (persisted raw changes), a later remote event with the original raw
  // could be incorrectly ignored.
  const unsubscribeLocal = onPersistBroadcast((msg) => {
    if (!isCrossTabSyncStorageKey(msg.key)) {
      return
    }
    if (msg.sourceId !== persistBroadcastSourceId) return
    lastProcessedRawByKey.set(msg.key, msg.raw)
    if (isDerivedLayoutKey(msg.key) && msg.key === getWindowLayoutKey()) {
      const persistedAt = parsePersistedLayoutRaw(msg.raw)?.persistedAt
      observeLocalLayoutWriteTimestamp(msg.key, persistedAt, persistControlOwner)
      mergeAuthoritativeLayoutPersistedAt(persistedAt)
      if (typeof persistedAt === 'number') {
        setLocalLayoutBaselinePersistedAt(msg.key, persistedAt, persistControlOwner)
      }
      const deferredAt = deferredOwnLayoutRaw === null
        ? undefined
        : parsePersistedLayoutRaw(deferredOwnLayoutRaw)?.persistedAt
      if (
        deferredOwnLayoutRaw !== null
        && typeof persistedAt === 'number'
        && (typeof deferredAt !== 'number' || persistedAt >= deferredAt)
      ) {
        // A durable local close based on the frozen pre-close tree explicitly
        // supersedes any same-key event deferred during that close. A failed
        // write never reaches this broadcast path, so its deferred event
        // remains available for retry/reconciliation.
        deferredOwnLayoutRaw = null
      }
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
      if (res.data.sourceId === persistBroadcastSourceId) return
      // Defensive own-key filter on the broadcast path: the own key is
      // only ever this window's envelope, and same-window writes already
      // arrived through onPersistBroadcast above.
      if (res.data.key === ownLayoutKey) return
      handleIncomingRawDeduped(res.data.key, res.data.raw)
    }
  }

  return () => {
    unsubscribeLocal()
    unsubscribeStore()
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
