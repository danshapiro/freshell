/**
 * Unified agent names (Task 5) — the ONLY scoped display rules.
 *
 * A scoped Claude/Codex/OpenCode pane (terminal modes claude/codex/opencode,
 * fresh types freshclaude/freshcodex/freshopencode) displays its session's
 * canonical saved name from the `sessionNames` cache; every legacy field
 * (paneTitles, paneTitleSetByUser, Tab.title, titleSetByUser, terminal
 * inventory strings) is a FALLBACK only and can never override a cached
 * canonical record. A session-owned tab resolves its stable source pane
 * (Tab.nameSource, with the single-scoped-leaf fallback until Task 6's
 * lifecycle plumbing persists the pointer) and reuses that pane's name.
 *
 * Out-of-scope panes/tabs (shell, browser, editor, kilroy, other providers)
 * keep the existing legacy derivations untouched.
 */
import { createSelector } from '@reduxjs/toolkit'
import { getPaneDisplayTitle } from '@/lib/pane-title'
import { getTabDisplayTitle } from '@/lib/tab-title'
import {
  isUnifiedAgentMode,
  sessionNameRefKey,
  type SessionNameRecord,
  type SessionNameRef,
} from '@shared/session-names'
import { getFreshAgentLabel } from '@/lib/fresh-agent-registry'
import type { ClientExtensionEntry } from '@shared/extension-types'
import type { PaneContent, PaneNode } from '@/store/paneTypes'
import type { RootState } from '@/store/store'

type SessionNamesCache = RootState['sessionNames']

/** Follow pending→durable redirects to the final ref key (chain-bounded). */
function resolveRefKey(cache: SessionNamesCache, ref: SessionNameRef): string {
  let key = sessionNameRefKey(ref)
  for (let hops = 0; hops < 8; hops += 1) {
    const redirect = cache.redirects?.[key]
    if (!redirect) break
    key = redirect.toKey
  }
  return key
}

/** The record a name cache holds for a naming ref (redirect-resolved). */
function recordInCache(cache: SessionNamesCache | undefined, ref: SessionNameRef): SessionNameRecord | undefined {
  if (!cache?.records) return undefined
  return cache.records[resolveRefKey(cache, ref)]
}

/** The canonical record currently cached for a naming ref (redirect-resolved).
 * Guarded like its sibling selectors: a hand-built state lacking the slice
 * (or its maps) resolves to undefined instead of throwing. */
export function selectSessionNameRecord(state: RootState, ref: SessionNameRef): SessionNameRecord | undefined {
  return recordInCache(state.sessionNames, ref)
}

/** The native writeback status cached for a naming ref (redirect-resolved). */
export function selectSessionNativeSync(
  state: RootState,
  ref: SessionNameRef,
): { status: string; reason?: string } | undefined {
  return state.sessionNames?.nativeSync?.[resolveRefKey(state.sessionNames, ref)]?.sync
}

function isNamedProvider(provider: string): provider is 'claude' | 'codex' | 'opencode' {
  return provider === 'claude' || provider === 'codex' || provider === 'opencode'
}

/** The pane's naming identity: its explicit nameRef, its pre-durable naming
 * handle, or its durable session ref — in that order. */
export function resolvePaneNameRef(content: PaneContent): SessionNameRef | undefined {
  if (content.kind === 'terminal') {
    if (content.nameRef) return content.nameRef
    if (content.namingHandle) return { kind: 'pending', id: content.namingHandle }
    if (
      content.sessionRef
      && isNamedProvider(content.sessionRef.provider)
      && typeof content.sessionRef.sessionId === 'string'
      && content.sessionRef.sessionId.length > 0
    ) {
      return { kind: 'session', provider: content.sessionRef.provider, sessionId: content.sessionRef.sessionId }
    }
    return undefined
  }
  if (content.kind === 'fresh-agent') {
    if (content.nameRef) return content.nameRef
    if (content.namingHandle) return { kind: 'pending', id: content.namingHandle }
    if (
      content.sessionRef
      && isNamedProvider(content.sessionRef.provider)
      && typeof content.sessionRef.sessionId === 'string'
      && content.sessionRef.sessionId.length > 0
    ) {
      return { kind: 'session', provider: content.sessionRef.provider, sessionId: content.sessionRef.sessionId }
    }
    if (content.sessionId && isUnifiedAgentMode(undefined, content.sessionType) && isNamedProvider(content.provider)) {
      return { kind: 'session', provider: content.provider, sessionId: content.sessionId }
    }
    return undefined
  }
  return undefined
}

/** Is this pane content one of the six unified naming modes? (Kilroy — a
 * claude runtime with sessionType `kilroy` — is never scoped.) */
export function isScopedPaneContent(content: PaneContent): boolean {
  if (content.kind === 'terminal') {
    return isUnifiedAgentMode(content.mode, undefined)
  }
  if (content.kind === 'fresh-agent') {
    return isUnifiedAgentMode(content.provider, content.sessionType)
  }
  return false
}

/** A session row is scoped by provider + sessionType (fresh rows carry their
 * fresh sessionType; CLI rows carry the provider as their mode). */
export function isScopedSessionRow(provider: string | undefined, sessionType?: string): boolean {
  if (!provider) return false
  if (sessionType !== undefined && sessionType !== '') {
    return isUnifiedAgentMode(provider, sessionType)
  }
  return isUnifiedAgentMode(provider, undefined)
}

function paneExtensions(state: RootState): ClientExtensionEntry[] | undefined {
  const entries = state.extensions?.entries
  return Array.isArray(entries) && entries.length > 0 ? entries : undefined
}

/** The legacy stored-title rule (pane display): fresh-agent panes never
 * display a stored title equal to their provider label/identity. */
export function resolveStoredTitleForDisplay(
  content: PaneContent,
  storedTitle: string | undefined,
  setByUser: boolean | undefined,
): string | undefined {
  if (content.kind !== 'fresh-agent' || setByUser || !storedTitle) return storedTitle

  const normalizedStoredTitle = storedTitle.trim().toLowerCase()
  const legacyProviderTitle = getFreshAgentLabel(content.sessionType).trim().toLowerCase()
  const providerIdentity = content.sessionType.trim().toLowerCase()
  if (normalizedStoredTitle === legacyProviderTitle || normalizedStoredTitle === providerIdentity) {
    return undefined
  }

  return storedTitle
}

/** The pane's LEGACY display title (out-of-scope panes, and the immediate
 * safe fallback for scoped panes without a cached canonical record). */
export function selectPaneFallbackTitle(
  state: RootState,
  content: PaneContent,
  tabId: string,
  paneId: string,
): string {
  const storedTitle = resolveStoredTitleForDisplay(
    content,
    state.panes?.paneTitles?.[tabId]?.[paneId],
    state.panes?.paneTitleSetByUser?.[tabId]?.[paneId],
  )
  return getPaneDisplayTitle(content, storedTitle, paneExtensions(state))
}

/** The scoped pane display rule: the pane's current canonical session name
 * by its naming binding, then the legacy derived/stored fallback. Old
 * sticky flags and terminal inventory strings can never override a cached
 * canonical record. */
export function selectPaneDisplayName(state: RootState, tabId: string, paneId: string): string {
  const content = findPaneContent(state.panes?.layouts?.[tabId], paneId)
  if (!content) return ''
  if (!isScopedPaneContent(content)) {
    return selectPaneFallbackTitle(state, content, tabId, paneId)
  }
  const ref = resolvePaneNameRef(content)
  if (ref) {
    const record = selectSessionNameRecord(state, ref)
    if (record) return record.name
  }
  return selectPaneFallbackTitle(state, content, tabId, paneId)
}

/** The tab's stable naming source pane (plan "Stable tab ownership"):
 * the persisted `nameSource` pointer while its pane exists, else the
 * single-scoped-leaf fallback (Task 6 persists the pointer at every layout
 * boundary). Returns null for legacy tabs. */
export function selectTabNameSourcePaneId(state: RootState, tabId: string): string | null {
  const tab = state.tabs?.tabs?.find((candidate) => candidate.id === tabId)
  return resolveTabNameSourcePaneId(tab, state.panes?.layouts?.[tabId])
}

type NamedTab = Pick<RootState['tabs']['tabs'][number], 'id' | 'nameSource'>

/** `selectTabNameSourcePaneId` for one tab and its layout. */
function resolveTabNameSourcePaneId(tab: NamedTab | undefined, layout: PaneNode | undefined): string | null {
  if (!tab || !layout) return null
  if (tab.nameSource?.kind === 'session') {
    const sourceId = tab.nameSource.paneId
    return layoutContainsPaneId(layout, sourceId) ? sourceId : null
  }
  if (tab.nameSource?.kind === 'legacy') return null
  // No persisted pointer yet: a single scoped leaf IS the original owner.
  if (layout.type === 'leaf' && isScopedPaneContent(layout.content)) {
    return layout.id
  }
  return null
}

/** Membership check for a pane id anywhere in the layout tree. */
function layoutContainsPaneId(node: PaneNode | undefined, paneId: string): boolean {
  return findPaneContent(node, paneId) !== undefined
}

/** Find a pane's content anywhere in the tab's layout tree (by pane id). */
function findPaneContent(node: PaneNode | undefined, paneId: string): PaneContent | undefined {
  if (!node) return undefined
  if (node.type === 'leaf') {
    return node.id === paneId ? node.content : undefined
  }
  return findPaneContent(node.children[0], paneId) ?? findPaneContent(node.children[1], paneId)
}

/** The scoped tab display rule: a session-owned tab displays its source
 * pane's canonical session name when one is cached; without a record it
 * keeps the legacy tab display (mirrored tab.title / derived title) as the
 * immediate safe fallback. Legacy tabs keep the existing derivation. */
export function selectTabDisplayName(state: RootState, tabId: string): string {
  const tab = state.tabs?.tabs?.find((candidate) => candidate.id === tabId)
  if (!tab) return ''
  const layout = state.panes?.layouts?.[tabId]
  const savedName = savedNameOfTab(tab, layout, state.sessionNames)
  if (savedName !== undefined) return savedName
  return getTabDisplayTitle(tab, layout, state.panes?.paneTitles?.[tabId], paneExtensions(state))
}

/**
 * A session-owned tab's naming binding (name reliability, Task 7): which
 * naming ref its source pane holds and the saved name cached for it.
 * - `refKey`: the source pane's naming ref key as the pane holds it (before
 *   pending→durable redirects, so a redirect is the same binding); null
 *   while the pane has no naming identity yet.
 * - `savedName`: the cached record's name; undefined when none is cached.
 */
export type SessionTabNameBinding = {
  refKey: string | null
  savedName: string | undefined
}

/** The tab's naming binding; undefined for legacy tabs (and for a source
 * pane that is not a scoped Claude/Codex/OpenCode pane). */
function nameBindingOfTab(
  tab: NamedTab,
  layout: PaneNode | undefined,
  cache: SessionNamesCache | undefined,
): SessionTabNameBinding | undefined {
  const sourcePaneId = resolveTabNameSourcePaneId(tab, layout)
  if (!sourcePaneId) return undefined
  const content = findPaneContent(layout, sourcePaneId)
  if (!content || !isScopedPaneContent(content)) return undefined
  const ref = resolvePaneNameRef(content)
  if (!ref) return { refKey: null, savedName: undefined }
  return { refKey: sessionNameRefKey(ref), savedName: recordInCache(cache, ref)?.name }
}

/** A session-owned tab's SAVED name: the record cached for its source
 * pane's naming ref. Undefined for legacy tabs and whenever no record is
 * cached — never a fallback label. */
function savedNameOfTab(
  tab: NamedTab,
  layout: PaneNode | undefined,
  cache: SessionNamesCache | undefined,
): string | undefined {
  return nameBindingOfTab(tab, layout, cache)?.savedName
}

/** The session display rule for directory/history/sidebar surfaces. */
export function selectSessionDisplayName(state: RootState, ref: SessionNameRef, fallback: string): string {
  const record = selectSessionNameRecord(state, ref)
  return record?.name ?? fallback
}

/**
 * The shared durable-key row projection (T5-N5): the canonical cache record
 * for a directory/history/sidebar session ROW, keyed by the row's durable
 * provider/session identity. One helper — HistoryView and the sidebar
 * selectors consume THIS, never a second inline `sessionNameRefKey` build.
 * Not redirect-resolved by design: durable-keyed directory rows address the
 * final identity already; pending-handle resolution belongs to pane content
 * (`resolvePaneNameRef`), never to rows.
 */
export function selectSessionRowRecord(
  sessionNames: SessionNamesCache | undefined,
  provider: string,
  sessionId: string,
): SessionNameRecord | undefined {
  if (!sessionNames || !isNamedProvider(provider)) return undefined
  return sessionNames.records?.[sessionNameRefKey({ kind: 'session', provider, sessionId })]
}

/** The rename capture (stale-input protection): the pane's naming target and
 * its last-known revision at edit start. `ref` is undefined when nothing
 * resolves — callers then send no capture guards and the server's own
 * resolution decides. */
export function resolvePaneRenameCapture(
  state: RootState,
  tabId: string,
  paneId: string,
): { ref: SessionNameRef | undefined; revision: number | undefined } {
  const content = findPaneContent(state.panes?.layouts?.[tabId], paneId)
  if (!content || !isScopedPaneContent(content)) {
    return { ref: undefined, revision: undefined }
  }
  const ref = resolvePaneNameRef(content)
  if (!ref) return { ref: undefined, revision: undefined }
  return { ref, revision: selectSessionNameRecord(state, ref)?.revision }
}

/** The pane's native writeback status (display/status only). */
export function selectPaneNativeSync(
  state: RootState,
  tabId: string,
  paneId: string,
): { status: string; reason?: string } | undefined {
  const content = findPaneContent(state.panes?.layouts?.[tabId], paneId)
  if (!content || !isScopedPaneContent(content)) return undefined
  const ref = resolvePaneNameRef(content)
  if (!ref) return undefined
  return selectSessionNativeSync(state, ref)
}

/**
 * Memoized per-tab display-name map for tab-strip consumers (TabBar and the
 * registry summaries): recomputes only when one of its stable slice
 * references changes, never per render.
 */
export const selectTabDisplayTitles = createSelector(
  (state: RootState) => state.tabs?.tabs,
  (state: RootState) => state.panes,
  (state: RootState) => state.sessionNames,
  (state: RootState) => state.extensions?.entries,
  (tabs, panes, sessionNames, extensions) => {
    const state = {
      tabs: { tabs: tabs ?? [] },
      panes,
      sessionNames,
      extensions: { entries: extensions },
    } as unknown as RootState
    const out: Record<string, string> = {}
    for (const tab of tabs ?? []) {
      out[tab.id] = selectTabDisplayName(state, tab.id)
    }
    return out
  },
)

/**
 * Every session-owned tab's naming binding (name reliability, Task 7):
 * `{tabId: binding}`; legacy tabs are absent. Memoized on the tabs, the
 * layouts and the name cache, so the same reference means none of them
 * changed. The saved-name tab title mirror reads it.
 */
export const selectSessionTabNameBindings = createSelector(
  (state: RootState) => state.tabs?.tabs,
  (state: RootState) => state.panes?.layouts,
  (state: RootState) => state.sessionNames,
  (tabs, layouts, sessionNames) => {
    const out: Record<string, SessionTabNameBinding> = {}
    for (const tab of tabs ?? []) {
      const binding = nameBindingOfTab(tab, layouts?.[tab.id], sessionNames)
      if (binding) out[tab.id] = binding
    }
    return out
  },
)

/**
 * The session-owned tabs' SAVED names only (name reliability, Task 7):
 * `{tabId: name}` for every session-owned tab whose source pane's saved
 * record is cached. A tab with no cached record is absent — this selector
 * never answers a fallback label (the provider label or folder name a
 * display selector shows while names load), so its consumer (the registry
 * overlay) can never advertise one. Legacy tabs are always absent.
 */
export const selectSessionTabSavedNames = createSelector(
  selectSessionTabNameBindings,
  (bindings) => {
    const out: Record<string, string> = {}
    for (const [tabId, binding] of Object.entries(bindings)) {
      if (binding.savedName !== undefined) out[tabId] = binding.savedName
    }
    return out
  },
)
