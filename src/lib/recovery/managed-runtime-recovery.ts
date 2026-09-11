import type { AppStore, RootState } from '@/store/store'
import { addTab, updateTab } from '@/store/tabsSlice'
import { initLayout, updatePaneContent } from '@/store/panesSlice'
import type { PaneContent, PaneNode, TerminalPaneContent } from '@/store/paneTypes'
import type { Tab, TerminalStatus } from '@/store/types'
import {
  getManagedRuntimeInventory,
  isTransientRequestFailure,
} from '@/lib/api'
import {
  managedRuntimeRefreshFailed,
  managedRuntimeRefreshStarted,
  managedRuntimeSnapshotReceived,
} from '@/store/managedRuntimeSlice'
import type {
  ManagedRuntimeInventorySnapshot,
  ManagedRuntimeProjectionFields,
  ManagedRuntimeSoul,
  ManagedRuntimeViewIntent,
} from '@shared/managed-runtime'

export type ManagedRuntimePaneUpdate = {
  tabId: string
  paneId: string
  content: PaneContent
  tabUpdates: Partial<Tab>
}

export type ManagedRuntimePaneCreate = {
  tabId: string
  paneId: string
  content: TerminalPaneContent
  tab: Parameters<typeof addTab>[0]
}

export type ManagedRuntimeMergePlan = {
  creates: ManagedRuntimePaneCreate[]
  updates: ManagedRuntimePaneUpdate[]
  representedViewCount: number
}

type LayoutState = Pick<RootState, 'tabs' | 'panes'>
type PaneLocation = { tabId: string; paneId: string; content: PaneContent }

function collectPaneLocations(layouts: RootState['panes']['layouts']): PaneLocation[] {
  const out: PaneLocation[] = []
  const walk = (tabId: string, node: PaneNode) => {
    if (node.type === 'leaf') {
      out.push({ tabId, paneId: node.id, content: node.content })
      return
    }
    walk(tabId, node.children[0])
    walk(tabId, node.children[1])
  }
  for (const [tabId, root] of Object.entries(layouts)) walk(tabId, root)
  return out
}

function latestSoulViews(snapshot: ManagedRuntimeInventorySnapshot): Map<string, ManagedRuntimeSoul> {
  const latest = new Map<string, ManagedRuntimeSoul>()
  for (const soul of snapshot.souls) latest.set(soul.soulId, soul)
  return latest
}

function terminalStatus(soul: ManagedRuntimeSoul): TerminalStatus {
  if (soul.desiredState === 'stopped' || soul.recoveryState === 'stopped') return 'exited'
  if (soul.recoveryState === 'recovering' || soul.recoveryState === 'blocked') return 'recovering'
  if (soul.launchState === 'running' && soul.recoveryState === 'live') return 'running'
  if (soul.launchState === 'failed' || soul.recoveryState === 'lost') return 'error'
  return 'creating'
}

export function managedProjectionFields(
  soul: ManagedRuntimeSoul,
  view: ManagedRuntimeViewIntent,
): ManagedRuntimeProjectionFields {
  return {
    soulId: soul.soulId,
    incarnationId: soul.incarnationId,
    runtimeState: soul.launchState,
    viewIntentId: view.viewId,
    viewIntentRevision: view.revision,
    soulIntentRevision: soul.intentRevision,
    incidentId: soul.incidentId,
    placementGroup: view.placementGroup,
    resourceSummary: {
      configured: soul.configuredLimits,
      effective: soul.effectiveLimits,
    },
    recoverySummary: {
      desiredState: soul.desiredState,
      recoveryState: soul.recoveryState,
      reason: soul.recoveryReason,
      attemptId: soul.recoveryAttemptId,
      incidentId: soul.incidentId,
      durabilityState: soul.durabilityState,
      allocationState: soul.allocationState,
    },
  }
}

function sessionRefFor(soul: ManagedRuntimeSoul) {
  return soul.provider && soul.nativeSessionId
    ? { provider: soul.provider, sessionId: soul.nativeSessionId }
    : undefined
}

function managedTerminalContent(
  soul: ManagedRuntimeSoul,
  view: ManagedRuntimeViewIntent,
): TerminalPaneContent {
  const mode = soul.terminalMode || soul.provider || 'shell'
  const sessionRef = mode === 'shell' ? undefined : sessionRefFor(soul)
  return {
    kind: 'terminal',
    terminalId: soul.terminalId,
    streamId: soul.terminalStreamId,
    createRequestId: soul.terminalCreateRequestId || `managed-${view.viewId}`,
    status: terminalStatus(soul),
    mode,
    shell: 'system',
    initialCwd: soul.terminalCwd,
    ...(sessionRef ? { sessionRef } : {}),
    ...managedProjectionFields(soul, view),
  }
}

/**
 * Drop keys whose value is `undefined`.
 *
 * A supervisor projection is PARTIAL while a soul is still materialising: it
 * legitimately carries no terminal id, stream id, cwd, or native session yet.
 * Spreading those absent fields wholesale would write `undefined` over the
 * pane's own truth — detaching a live pane from its output and preventing its
 * session ref from ever being stamped. An unset field means "the supervisor
 * has nothing to say", never "erase what you know".
 */
function definedOnly<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Partial<T>
}

function updateExistingContent(
  existing: PaneContent,
  soul: ManagedRuntimeSoul,
  view: ManagedRuntimeViewIntent,
): PaneContent {
  const fields = managedProjectionFields(soul, view)
  if (existing.kind === 'terminal') {
    return {
      ...existing,
      ...definedOnly(managedTerminalContent(soul, view)),
      // Preserve a user pane's stable create key when the supervisor record
      // predates that field. Otherwise use the authoritative managed key.
      createRequestId: soul.terminalCreateRequestId || existing.createRequestId,
    }
  }
  if (existing.kind === 'fresh-agent') {
    const sessionRef = sessionRefFor(soul)
    return {
      ...existing,
      ...(sessionRef ? {
        sessionId: sessionRef.sessionId,
        resumeSessionId: sessionRef.sessionId,
        sessionRef,
      } : {}),
      ...definedOnly(fields),
    }
  }
  return existing
}

function paneMatchesView(
  location: PaneLocation,
  soul: ManagedRuntimeSoul,
  view: ManagedRuntimeViewIntent,
  exactOnly: boolean,
): boolean {
  const content = location.content
  if (content.kind !== 'terminal' && content.kind !== 'fresh-agent') return false
  if (content.viewIntentId === view.viewId) return true
  if (exactOnly) return false
  if (content.soulId === soul.soulId) return true
  if (content.kind === 'terminal' && soul.terminalId && content.terminalId === soul.terminalId) {
    return true
  }
  // The originating pane knows its createRequestId long before the server
  // answers with a terminalId. Without this, the whole create round trip is a
  // window in which the pane is invisible to the matcher and the reconciler
  // manufactures a SECOND view of the same soul — a duplicate tab over one
  // writer, and a pane whose output the user never sees.
  if (soul.terminalCreateRequestId && content.createRequestId === soul.terminalCreateRequestId) {
    return true
  }
  const sessionRef = sessionRefFor(soul)
  return Boolean(
    sessionRef
      && content.sessionRef?.provider === sessionRef.provider
      && content.sessionRef.sessionId === sessionRef.sessionId,
  )
}

function collisionFreeTabId(
  state: LayoutState,
  view: ManagedRuntimeViewIntent,
): string {
  const preferred = state.tabs.tabs.find((tab) => tab.id === view.preferredTabId)
  if (!preferred || preferred.viewIntentId === view.viewId) return view.preferredTabId
  return `tab-${view.viewId}`
}

function collisionFreePaneId(
  state: LayoutState,
  tabId: string,
  view: ManagedRuntimeViewIntent,
): string {
  const root = state.panes.layouts[tabId]
  if (!root) return view.preferredPaneId
  return `pane-${view.viewId}`
}

/**
 * Pure supervisor-snapshot × local-layout merge. Local layout is never
 * replaced. Existing panes are updated in place; only missing visible view
 * intents produce deterministic recovered tabs. Explicit views match by their
 * own view id so two views of one soul remain two views over one writer.
 */
export function buildManagedRuntimeMergePlan(
  snapshot: ManagedRuntimeInventorySnapshot,
  state: LayoutState,
): ManagedRuntimeMergePlan {
  const souls = latestSoulViews(snapshot)
  const locations = collectPaneLocations(state.panes.layouts)
  const claimed = new Set<string>()
  const creates: ManagedRuntimePaneCreate[] = []
  const updates: ManagedRuntimePaneUpdate[] = []
  let representedViewCount = 0

  const views = [...snapshot.viewIntents]
    .sort((left, right) => left.viewId.localeCompare(right.viewId))

  for (const view of views) {
    const soul = souls.get(view.soulId)
    if (!soul || soul.desiredState !== 'running') continue

    const exactOnly = view.kind === 'explicit'
    const location = locations.find((candidate) => {
      const key = `${candidate.tabId}:${candidate.paneId}`
      return !claimed.has(key) && paneMatchesView(candidate, soul, view, exactOnly)
    })
    const fields = managedProjectionFields(soul, view)
    const status = terminalStatus(soul)
    const sessionRef = sessionRefFor(soul)

    if (location) {
      claimed.add(`${location.tabId}:${location.paneId}`)
      if (view.visibility === 'visible') representedViewCount += 1
      const tab = state.tabs.tabs.find((candidate) => candidate.id === location.tabId)
      updates.push({
        tabId: location.tabId,
        paneId: location.paneId,
        content: updateExistingContent(location.content, soul, view),
        tabUpdates: {
          ...(tab?.titleSetByUser ? {} : { title: view.title }),
          status,
          mode: (soul.terminalMode || soul.provider || tab?.mode || 'shell') as Tab['mode'],
          codingCliProvider: soul.provider && soul.provider !== 'shell'
            ? soul.provider as Tab['codingCliProvider']
            : undefined,
          initialCwd: soul.terminalCwd,
          ...(sessionRef ? { sessionRef } : {}),
          ...fields,
        },
      })
      continue
    }

    // Detached/hidden intents update a still-present local view honestly but
    // never manufacture a new one. A later supervisor startup may promote an
    // automatic primary intent back to visible, at which point it is restored.
    if (view.visibility !== 'visible') continue

    const tabId = collisionFreeTabId(state, view)
    const paneId = collisionFreePaneId(state, tabId, view)
    const content = managedTerminalContent(soul, view)
    representedViewCount += 1
    creates.push({
      tabId,
      paneId,
      content,
      tab: {
        id: tabId,
        createRequestId: content.createRequestId,
        title: view.title,
        codingCliProvider: soul.provider && soul.provider !== 'shell'
          ? soul.provider as Tab['codingCliProvider']
          : undefined,
        status,
        mode: content.mode as Tab['mode'],
        shell: 'system',
        initialCwd: soul.terminalCwd,
        ...(sessionRef ? { sessionRef } : {}),
        ...fields,
        activate: false,
      },
    })
  }

  return { creates, updates, representedViewCount }
}

export function applyManagedRuntimeMergePlan(
  store: Pick<AppStore, 'dispatch' | 'getState'>,
  plan: ManagedRuntimeMergePlan,
): void {
  for (const update of plan.updates) {
    store.dispatch(updatePaneContent({
      tabId: update.tabId,
      paneId: update.paneId,
      content: update.content,
    }))
    store.dispatch(updateTab({ id: update.tabId, updates: update.tabUpdates }))
  }
  for (const create of plan.creates) {
    // A concurrent refresh may have created it since the pure plan snapshot.
    if (store.getState().tabs.tabs.some((tab) => tab.id === create.tabId)) continue
    store.dispatch(addTab(create.tab))
    store.dispatch(initLayout({
      tabId: create.tabId,
      paneId: create.paneId,
      content: create.content,
    }))
  }
}

let activeRefresh: Promise<void> | null = null
let queuedReason: string | null = null

async function runManagedRuntimeRefresh(
  store: Pick<AppStore, 'dispatch' | 'getState'>,
  initialReason: string,
): Promise<void> {
  let reason: string | null = initialReason
  while (reason) {
    queuedReason = null
    store.dispatch(managedRuntimeRefreshStarted(reason))
    try {
      const snapshot = await getManagedRuntimeInventory()
      if (snapshot.revision >= store.getState().managedRuntime.revision) {
        const plan = buildManagedRuntimeMergePlan(snapshot, store.getState())
        applyManagedRuntimeMergePlan(store, plan)
        store.dispatch(managedRuntimeSnapshotReceived({
          snapshot,
          reconstructedViewCount: plan.representedViewCount,
        }))
      }
    } catch (error) {
      if (!isTransientRequestFailure(error)) {
        store.dispatch(managedRuntimeRefreshFailed(
          error instanceof Error ? error.message : String(error),
        ))
      }
    }
    reason = queuedReason
  }
}

/** Coalesced refresh used on every ready and every revisioned runtime broadcast. */
export function queueManagedRuntimeRefresh(
  store: Pick<AppStore, 'dispatch' | 'getState'>,
  reason: string,
): Promise<void> {
  if (activeRefresh) {
    queuedReason = reason
    return activeRefresh
  }
  activeRefresh = runManagedRuntimeRefresh(store, reason).finally(() => {
    activeRefresh = null
  })
  return activeRefresh
}

/** Test-only reset for module-global request coalescing. */
export function resetManagedRuntimeRefreshForTest(): void {
  activeRefresh = null
  queuedReason = null
}
