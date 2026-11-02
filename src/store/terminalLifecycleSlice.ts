// Ephemeral crash/auto-resume presentation state (Lane D1). Deliberately a
// separate slice: pane persistence shapes are owned by Lane D4 and the
// persistMiddleware strip is a denylist — a new pane field would persist by
// default. (Two layers, both true: store.ts allowlists which SLICES persist;
// within an allowlisted slice, the strip deny-removes pane FIELDS.) This
// slice is never added to that allowlist, so it is never persisted.
import { createSlice, type PayloadAction } from '@reduxjs/toolkit'

export interface TerminalExitRecord { exitCode: number; at: number }
export interface AutoResumeNotice {
  kind: 'recovering' | 'resumed'
  attempt: number
  maxAttempts: number
  exitCode: number
  at: number
}

export interface PaneLifecycleEntry {
  lastTerminalId?: string
  exit?: TerminalExitRecord
  notice?: AutoResumeNotice
  /** Authoritative end of auto-resume for this terminal. The exit code also
   * covers a process that died before the browser attached for terminal.exit. */
  settle?: { terminalId: string; exitCode?: number; resumeCycles?: number }
}

/** Wedge-backstop (LB-8): the per-pane wedged-agent flag folded from
 * `terminal.stuck`. The flagged terminalId is stored WITH the entry —
 * terminalId churn happens exactly on kill/respawn/replacement, which is
 * when a prior flag is stale. */
export interface TerminalStuckEntry {
  at: number
  terminalId: string
}

export interface TerminalLifecycleState {
  byPaneId: Record<string, PaneLifecycleEntry>
  /** Wedge-backstop: keyed by paneId (the exit handler clears
   * paneContent.terminalId, so an exited pane has no terminal id to key
   * by — same reasoning as byPaneId). NOT persisted (this slice is never
   * in the persist allowlist). */
  stuckAtByPaneId: Record<string, TerminalStuckEntry>
}

const initialState: TerminalLifecycleState = { byPaneId: {}, stuckAtByPaneId: {} }

const entry = (state: TerminalLifecycleState, paneId: string) =>
  (state.byPaneId[paneId] ??= {})

const slice = createSlice({
  name: 'terminalLifecycle',
  initialState,
  reducers: {
    // Dispatched by the pane's own terminal.exit handler BEFORE it clears
    // paneContent.terminalId (TerminalView.tsx:4141-4148) — this is the only
    // moment both paneId and the dying terminalId are simultaneously known.
    recordTerminalExit(state, a: PayloadAction<{ paneId: string; terminalId: string; exitCode: number; at: number }>) {
      const e = entry(state, a.payload.paneId)
      e.lastTerminalId = a.payload.terminalId
      e.exit = { exitCode: a.payload.exitCode, at: a.payload.at }
      // Fresh-eyes fix: an exit is always NEWER truth than any notice. Without
      // this, the exhaustion path (last crash -> settle, which emits no frame)
      // leaves the previous 'resumed' notice masking the role=alert error bar
      // — a success-toned banner on a dead pane. Clearing here makes the alert
      // show immediately on the final crash; a genuine in-flight resume
      // re-sets the notice when its `recovering` frame lands (which always
      // follows the exit, per Task 5's emit order).
      delete e.notice
      // Stale-settle leak fix (validated A15): a new crash must never inherit
      // an earlier breaker settle's resumeCycles, or the alert would read
      // "crashed N times — auto-resume paused" on a non-breaker crash.
      delete e.settle
      // Wedge-backstop belt (LB-8): the process died — its stuck flag
      // cannot outlive it.
      delete state.stuckAtByPaneId?.[a.payload.paneId]
    },
    recordAutoResumeRecovering(state, a: PayloadAction<{ paneId: string; attempt: number; maxAttempts: number; exitCode: number; at: number }>) {
      const { paneId, ...n } = a.payload
      entry(state, paneId).notice = { kind: 'recovering', ...n }
    },
    foldTerminalReplacement(state, a: PayloadAction<{ paneId: string; newTerminalId: string; exitCode: number; attempt: number; maxAttempts: number; at: number }>) {
      const { paneId, newTerminalId } = a.payload
      const e = entry(state, paneId)
      delete e.exit // pane is alive again — no error bar
      // znhn item 1: the ephemeral 'resumed' strip is retired — the
      // persistent crash trace on pane content is the post-resume indicator.
      delete e.notice
      // Stale-settle leak fix (validated A15, pairs with recordTerminalExit).
      delete e.settle
      e.lastTerminalId = newTerminalId
      // Wedge-backstop belt (LB-8), keyed on newTerminalId: a replacement
      // terminal supersedes the pane's runtime, so a stuck entry for the OLD
      // terminal cannot survive it. A (defensive) replacement naming the
      // flagged terminal itself keeps the flag — never flag-swallowing.
      const stuck = state.stuckAtByPaneId?.[paneId]
      if (stuck !== undefined && stuck.terminalId !== newTerminalId) {
        delete state.stuckAtByPaneId?.[paneId]
      }
    },
    // Settle frame (terminal.status status:'exited') — the deterministic
    // replacement for the old 30s TTL guess (znhn item 3).
    recordAutoResumeSettled(
      state,
      action: PayloadAction<{ paneId: string; terminalId: string; exitCode?: number; resumeCycles?: number; at: number }>
    ) {
      const { paneId, terminalId, exitCode, resumeCycles, at } = action.payload
      // A delayed settle for an older generation cannot overwrite a newer
      // replacement's lifecycle after terminal.replaced advanced the ID.
      const existing = state.byPaneId[paneId]
      if (existing?.lastTerminalId && existing.lastTerminalId !== terminalId) return
      // Settle frames are redelivered by design (the cancel handler's
      // immediate frame + the hub's post-sleep re-emit). Bail before
      // touching the draft (entry() materializes missing entries — itself
      // a state change) so a redelivery keeps the same state reference and
      // subscribers see no change — not merely value-idempotent.
      if (
        existing !== undefined
        && existing.notice === undefined
        && existing.settle !== undefined
        && existing.settle.terminalId === terminalId
        && existing.settle.exitCode === exitCode
        && existing.settle.resumeCycles === resumeCycles
      ) return
      const e = entry(state, paneId)
      delete e.notice
      e.lastTerminalId = terminalId
      if (typeof exitCode === 'number') e.exit = { exitCode, at }
      e.settle = {
        terminalId,
        ...(typeof exitCode === 'number' ? { exitCode } : {}),
        ...(resumeCycles !== undefined ? { resumeCycles } : {}),
      }
    },
    // D-3 backstop (validated): the settle/replaced frames are fire-and-forget
    // on a bounded broadcast (no replay; lagged receivers are force-closed),
    // so every missed-frame path necessarily passes through a WS reconnect.
    // Clearing stale recovering notices on reconnect makes a lying notice
    // impossible; frames stay the primary mechanism. No TTL returns.
    clearRecoveringNotices(state) {
      for (const e of Object.values(state.byPaneId)) {
        if (e?.notice?.kind === 'recovering') delete e.notice
      }
    },
    clearTerminalLifecycle(state, a: PayloadAction<{ paneId: string }>) {
      delete state.byPaneId[a.payload.paneId]
      // Wedge-backstop belt (LB-8): relaunch/respawn discards the pane's
      // stale presentation state — the stuck flag included.
      delete state.stuckAtByPaneId?.[a.payload.paneId]
    },
    // ── Wedge-backstop stuck entries (LB-8) ──
    // Folded from the server-authoritative `terminal.stuck` broadcast via
    // applyTerminalStuck (turnCompletionThunks.ts). Surface-only state: it
    // renders the "Agent appears stuck" card and NEVER feeds the
    // turn-completion pipeline.
    recordTerminalStuck(state, a: PayloadAction<{ paneId: string; terminalId: string; at: number }>) {
      // `??=` defends the pre-existing partial test stores that materialize
      // this slice WITHOUT the newer stuck key (the selector-tolerance
      // convention documented below).
      const stuck = (state.stuckAtByPaneId ??= {})
      stuck[a.payload.paneId] = { at: a.payload.at, terminalId: a.payload.terminalId }
    },
    clearTerminalStuck(state, a: PayloadAction<{ paneId: string }>) {
      delete state.stuckAtByPaneId?.[a.payload.paneId]
    },
    clearTerminalStuckIfOtherTerminal(state, a: PayloadAction<{ paneId: string; terminalId: string }>) {
      const stuck = state.stuckAtByPaneId?.[a.payload.paneId]
      if (stuck !== undefined && stuck.terminalId !== a.payload.terminalId) {
        delete state.stuckAtByPaneId?.[a.payload.paneId]
      }
    },
  },
})

export const {
  recordTerminalExit, recordAutoResumeRecovering, foldTerminalReplacement,
  recordAutoResumeSettled, clearRecoveringNotices, clearTerminalLifecycle,
  recordTerminalStuck, clearTerminalStuck, clearTerminalStuckIfOtherTerminal,
} = slice.actions
export default slice.reducer

// Selectors tolerate an absent slice state (`s?.`): many pre-existing client
// tests build partial Redux stores without this reducer and render
// TerminalView, which calls these on every render. Mirrors the defensive
// access convention of paneRuntimeActivity consumers
// (`s.paneRuntimeActivity?.byPaneId ?? EMPTY`). Production stores always
// include the reducer (store.ts), so this never changes runtime behavior.
export const selectExitRecordFrom = (s: TerminalLifecycleState | undefined, paneId: string) => s?.byPaneId[paneId]?.exit
export const selectLastTerminalIdFrom = (s: TerminalLifecycleState | undefined, paneId: string) => s?.byPaneId[paneId]?.lastTerminalId
// No TTL (znhn item 3): notices are frame-driven — cleared by settle frames,
// terminal.replaced folds, terminal.exit, or the reconnect backstop.
export const selectActiveNoticeFrom = (s: TerminalLifecycleState | undefined, paneId: string) =>
  s?.byPaneId[paneId]?.notice
// Root-state wrappers — match the RootState typing convention of the sibling
// selectors in this directory (see turnCompletionSlice.ts for the pattern):
export const selectExitRecord = (root: { terminalLifecycle?: TerminalLifecycleState }, paneId: string) =>
  selectExitRecordFrom(root.terminalLifecycle, paneId)
export const selectActiveNotice = (root: { terminalLifecycle?: TerminalLifecycleState }, paneId: string) =>
  selectActiveNoticeFrom(root.terminalLifecycle, paneId)
export const selectResumeCycles = (root: { terminalLifecycle?: TerminalLifecycleState }, paneId: string) =>
  root.terminalLifecycle?.byPaneId[paneId]?.settle?.resumeCycles
export const selectAutoResumeSettle = (root: { terminalLifecycle?: TerminalLifecycleState }, paneId: string) =>
  root.terminalLifecycle?.byPaneId[paneId]?.settle
// Wedge-backstop: the pane's wedged-agent flag (undefined = not flagged).
// `?.` on the stuck map mirrors the slice-level tolerance for partial test
// stores materialized before the key existed.
export const selectStuckEntryFrom = (s: TerminalLifecycleState | undefined, paneId: string) =>
  s?.stuckAtByPaneId?.[paneId]
export const selectStuckEntry = (root: { terminalLifecycle?: TerminalLifecycleState }, paneId: string) =>
  selectStuckEntryFrom(root.terminalLifecycle, paneId)
