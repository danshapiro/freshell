import type { Middleware } from '@reduxjs/toolkit'
import { updatePaneTitleByTerminalId } from '@/store/panesSlice'
import { isUnifiedAgentMode } from '@shared/session-names'
import type { RootState } from '@/store'

type FoldStore = {
  getState: () => Pick<RootState, 'panes'>
  dispatch: (action: any) => unknown
}
type InventoryRow = { terminalId?: string; title?: string }

/** Latest frame's titled rows per terminalId (delta review round 2,
 * finding 2): a recovered terminal pane gets its terminalId only AFTER the
 * boot frame, so the fold alone is one-shot and the pane would keep its
 * derived default until the next reconnect. Module-level because the
 * middleware sees redux's middleware-API object, not the store object the
 * fold receives — only a module singleton is observable from both sides.
 * One browser window is one JS realm, so one cache per window is the
 * correct scope. New frames REPLACE the cache — the frame is the
 * authoritative registry snapshot, so a terminal dropped from a later
 * frame no longer replays. */
let lastInventoryTitles = new Map<string, string>()

/** Does any pane bound to this terminal hold a title that differs?
 * Carries the owning tabId through the walk so the title comparison can
 * read paneTitles[tabId][paneId]. A pane whose user-set flag is true is
 * NEVER a fold target — treat it as NOT differing so the fold count only
 * reports real folds and no no-op dispatch fires for it on every refresh. */
function paneTitleDiffersForTerminal(panes: RootState['panes'], terminalId: string, title: string): boolean {
  for (const [tabId, layout] of Object.entries(panes.layouts ?? {})) {
    if (!layout) continue
    const walk = (node: unknown): boolean => {
      if (!node || typeof node !== 'object') return false
      const n = node as { type?: string; id?: string; content?: { kind?: string; terminalId?: string; mode?: string }; children?: unknown[] }
      if (n.type === 'leaf') {
        if (n.content?.kind === 'terminal' && n.content.terminalId === terminalId) {
          // Unified agent names (Task 5): a scoped coding-agent terminal pane
          // (claude/codex/opencode) displays its canonical session name from
          // the sessionNames cache — the terminal-level title pipeline never
          // folds an unrevisioned registry title into it.
          if (isUnifiedAgentMode(n.content.mode, undefined)) return false
          if (panes.paneTitleSetByUser?.[tabId]?.[n.id ?? '']) return false
          if (((panes.paneTitles?.[tabId]?.[n.id ?? '']) ?? '') !== title) return true
        }
        return false
      }
      return (n.children ?? []).some(walk)
    }
    if (walk(layout)) return true
  }
  return false
}

/** Apply one terminalId→title pair through the guarded fold path.
 * Returns true when a fold dispatched (churn-free: user-set panes and
 * already-equal titles dispatch nothing). */
function applyTerminalTitle(store: FoldStore, terminalId: string, title: string): boolean {
  if (!paneTitleDiffersForTerminal(store.getState().panes, terminalId, title)) return false
  store.dispatch(updatePaneTitleByTerminalId({ terminalId, title, setByUser: false }))
  return true
}

/**
 * Fold terminal.inventory rows' titles into pane titles. The server sends
 * the inventory on EVERY connection, so this closes the refresh hole where
 * the edge-triggered terminal.title.updated push was missed and nothing
 * re-delivered the current registry title. All writes go through
 * updatePaneTitleByTerminalId with setByUser:false — user renames stick.
 * The frame's titled rows are recorded into the store's cache (replacing
 * any previous frame) so replayTerminalInventoryTitles can re-apply them
 * when a binding action later lands a terminalId into pane content.
 * Returns the number of dispatched folds (churn-free: rows whose panes
 * already hold the title dispatch nothing, and user-set panes are skipped
 * entirely so they are never dispatched or counted).
 */
export function foldTerminalInventoryTitles(store: FoldStore, terminals: InventoryRow[] | undefined): number {
  let dispatched = 0
  if (Array.isArray(terminals)) {
    const cache = new Map<string, string>()
    for (const row of terminals) {
      if (row?.terminalId && row?.title) cache.set(row.terminalId, row.title)
    }
    lastInventoryTitles = cache
  }
  for (const row of terminals ?? []) {
    const terminalId = row?.terminalId
    const title = row?.title
    if (!terminalId || !title) continue
    if (applyTerminalTitle(store, terminalId, title)) dispatched += 1
  }
  return dispatched
}

/**
 * Re-apply the cached inventory titles (the latest frame's titled rows)
 * through the same guarded fold path — no new frame required. Closes the
 * recovered-pane hole (delta review round 2, finding 2): recovery builds
 * panes without terminalId, and the binding actions land it later.
 * Returns the number of dispatched folds (churn-free).
 */
export function replayTerminalInventoryTitles(store: FoldStore): number {
  if (lastInventoryTitles.size === 0) return 0
  let dispatched = 0
  for (const [terminalId, title] of lastInventoryTitles) {
    if (applyTerminalTitle(store, terminalId, title)) dispatched += 1
  }
  return dispatched
}

/**
 * Generated panes actions verified to write a terminalId into pane content
 * — each must replay the cached inventory titles for panes that just
 * gained their terminal binding:
 * - panes/updatePaneContent — the terminal.created fold
 *   (TerminalView.tsx:4502 updateContent → :1679 dispatch) and the
 *   pane.attach ui command (ui-commands.ts:143)
 * - panes/applyReconcileAttach — foldLiveTerminalAttach
 *   (panesSlice.ts:2271): the pane.reconcile attach verdict, the recovered
 *   pane's reattach path
 * - panes/applyReattachToLiveTerminal — foldLiveTerminalAttach
 *   (panesSlice.ts:2299): the close→reopen revival reattach
 * - panes/hydratePanes — cross-window hydrate (crossTabSync.ts:206-219);
 *   the merge can land an incoming terminalId (mergeTerminalState
 *   fall-through, panesSlice.ts:753-795) and normalizePaneContent preserves
 *   it (panesSlice.ts:78)
 * - panes/initLayout — OverviewView background-terminal open carries the
 *   terminalId (OverviewView.tsx:189, :243); tab.create ui command
 *   (ui-commands.ts:91-107)
 * - panes/splitPane — server-mirrored split newContent (ui-commands.ts:119-127)
 * - panes/addPane — tab-registry reconstruction's live-terminal handle
 *   (tab-registry-open.ts:280 via sanitizePaneSnapshot:108)
 * NOT wired (verified): mergePaneContent (fresh-agent status/model/settings
 * merges only — no terminalId writers), materializeFreshAgentSession
 * (fresh-agent sessionId), reconcileTerminalSessionRefByTerminalId
 * (sessionRef only), restoreLayout (stripStaleIds STRIPS terminalId from
 * restored content by design — panesSlice.ts:911-915 — so it never binds).
 */
const TERMINAL_BINDING_PANE_ACTIONS = new Set([
  'panes/updatePaneContent',
  'panes/applyReconcileAttach',
  'panes/applyReattachToLiveTerminal',
  'panes/hydratePanes',
  'panes/initLayout',
  'panes/initCopiedLayout',
  'panes/splitPane',
  'panes/addPane',
])

/** Replace a terminal's cached snapshot title when a NEWER authoritative
 * TERMINAL-LEVEL title lands a DIFFERENT title (e2r2 review finding 3,
 * corrected e2r3 review finding 3): the cache is a FALLBACK for late-bound
 * panes, and a newer write makes the boot snapshot stale — REPLACE the
 * entry, never delete it. Eviction left a live terminal.title.updated/OSC
 * title arriving before another pane binds that terminal titleless until
 * reconnect (the exact missed-delivery failure the replay was built to
 * fix). An EQUAL write is a no-op, so the fold's own dispatches never
 * churn the entry. Replacement is independent of the replay churn guard:
 * the guard protects one pane's title, but a sibling pane sharing the same
 * terminalId must also replay the NEW title, not the stale snapshot. */
function replaceStaleInventoryTitle(terminalId: string | undefined, title: unknown): void {
  if (!terminalId || typeof title !== 'string') return
  if (lastInventoryTitles.get(terminalId) === title) return
  lastInventoryTitles.set(terminalId, title)
}

/**
 * The cached terminal-level title this window holds for the terminal —
 * undefined when NO terminal-level title source has delivered one (e.g. a
 * terminal another client created after this window's last inventory
 * frame). The session-title mirror uses this to decide whether the
 * registry-title pipeline can address a terminal pane (e2r5 review finding
 * 3): a truthy terminalId alone does not prove a title source exists.
 */
export function getCachedTerminalTitle(terminalId: string | undefined): string | undefined {
  if (!terminalId) return undefined
  return lastInventoryTitles.get(terminalId)
}

/** Record a live TERMINAL-LEVEL title write into the replay cache (e2r3
 * review finding 3). Called ONLY by the two authoritative live handlers
 * in TerminalView — the terminal.title.updated fold (~:4780) and the OSC
 * onTitleChange fold (~:2595) — because a redux title action alone cannot
 * prove terminal-level scope: Sidebar.tsx:492 dispatches
 * panes/updatePaneTitle with setByUser:false carrying a SESSION-DIRECTORY
 * title when an existing session pane is selected, and the old middleware
 * watching let that wrong-scope title replace the cache entry and replay
 * into sibling/recovered panes. The record REPLACES the cached entry,
 * never deletes it. */
export function recordTerminalTitleForReplay(terminalId: string | undefined, title: string): void {
  replaceStaleInventoryTitle(terminalId, title)
}

/**
 * Replay cached inventory titles whenever a binding action may have just
 * landed a terminalId into pane content (delta review round 2, finding 2).
 * Churn-free by the same guard as the fold: an already-titled pane and a
 * user-set pane dispatch nothing, and an empty cache (before the first
 * terminal.inventory frame) is a no-op. The middleware watches NO title
 * actions (e2r3 review finding 3): a setByUser:false title action cannot
 * prove terminal-level scope — Sidebar.tsx:492 dispatches
 * panes/updatePaneTitle with setByUser:false carrying a SESSION-DIRECTORY
 * title when an existing session pane is selected, and the old title
 * watching let that wrong-scope title replace the cache entry, so a later
 * binding action replayed it into sibling/recovered panes. The cache is
 * written ONLY by authoritative terminal-level sources: the inventory
 * frame fold (foldTerminalInventoryTitles replaces the whole cache per
 * frame) and the recordTerminalTitleForReplay calls the two live
 * TerminalView handlers (terminal.title.updated ~:4780, OSC
 * onTitleChange ~:2595) now make.
 */
export const terminalInventoryTitleReplayMiddleware: Middleware = (store) => (next) => (action: any) => {
  const result = next(action)
  const type = action?.type
  if (typeof type === 'string' && TERMINAL_BINDING_PANE_ACTIONS.has(type)) {
    replayTerminalInventoryTitles(store as FoldStore)
  }
  return result
}
