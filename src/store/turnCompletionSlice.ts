import { createSlice, PayloadAction } from '@reduxjs/toolkit'

type TurnCompletePayload = {
  tabId: string
  paneId: string
  terminalId: string
  at: number
  outcome?: 'completed' | 'failed'
  /**
   * DR5-3 (delta round 5): the RECEIPT-time witness bit — stamped
   * synchronously at the dispatch that queues the event by
   * `turnCompletionReceiptMiddleware` (window focused + this tab active at
   * receipt), so the notification hook consumes the classification the
   * user's attention ACTUALLY had when the ending happened. A focus or
   * active-tab change between receipt and the hook's passive-effect drain
   * must never re-classify an ending that already happened. Optional on the
   * wire shape: absent means no receipt middleware stamped it (a bare store
   * without the middleware) and the event queues as UNWITNESSED — the
   * fail-loud direction for a notification system.
   */
  watched?: boolean
}

/** Who recorded a pending event — partitions the notification hook. */
export type TurnCompletionEventSource = 'freshAgent' | 'terminal'

export type TurnCompleteEvent = TurnCompletePayload & {
  seq: number
  source: TurnCompletionEventSource
  /** The receipt-time witness bit (required on the queued event — see `TurnCompletePayload.watched`). */
  watched: boolean
}

export type TerminalIdlePayload = {
  tabId: string
  paneId: string
  terminalId: string
  at: number
  reason: 'grace' | 'queue-empty'
  /** The receipt-time witness bit (see `TurnCompletePayload.watched`). */
  watched?: boolean
}

export interface TurnCompletionState {
  seq: number
  lastAtByTerminalId: Record<string, number>
  /** Truly-idle (terminal.idle) dedupe baseline — separate namespace from turn-complete `at`s. */
  lastIdleAtByTerminalId: Record<string, number>
  pendingEvents: TurnCompleteEvent[]
  attentionByTab: Record<string, boolean>
  attentionByPane: Record<string, boolean>
  /**
   * Watched fresh-agent turn endings (window focused + tab active): a
   * tab-strip-ONLY mark. Deliberately separate from attentionByTab (which
   * also drives the sidebar row highlight and would light sibling sessions
   * of a split tab). Never persisted and cleared on any later re-activation
   * of the tab.
   */
  watchedCompletionByTab: Record<string, boolean>
}

// Attention is NEVER rehydrated: a page reload witnesses nothing ("never
// replay history" — no highlights or bells for turn ends that happened before
// the page loaded). Nothing else from the persisted payload is restored
// either, so the slice simply does not read localStorage.

const initialState: TurnCompletionState = {
  seq: 0,
  lastAtByTerminalId: {},
  lastIdleAtByTerminalId: {},
  pendingEvents: [],
  attentionByTab: {},
  attentionByPane: {},
  watchedCompletionByTab: {},
}

const turnCompletionSlice = createSlice({
  name: 'turnCompletion',
  initialState,
  reducers: {
    // Observe an attention mark without recording an event. First-ready seeding
    // and live edges for sessions without a local pane use the same high-water mark.
    advanceCompletionBaseline(state, action: PayloadAction<{ terminalId: string; at: number }>) {
      const { terminalId, at } = action.payload
      if (!Number.isFinite(at)) return
      const last = state.lastAtByTerminalId[terminalId]
      if (last === undefined || at > last) state.lastAtByTerminalId[terminalId] = at
    },
    // Fresh-agent completion edge (and custom-CLI client BEL path). Terminal CLI
    // panes (claude/codex/opencode/amplifier) no longer flow through here — their
    // bell/shade edge is the server-authoritative terminal.idle (recordTerminalIdle).
    recordTurnComplete(state, action: PayloadAction<TurnCompletePayload>) {
      const { terminalId, at } = action.payload
      // Monotonic, replay-safe dedupe: only record a completion strictly newer
      // than the last seen for this terminal. A replayed/stale completion with
      // an older-or-equal `at` is ignored so scrollback replay cannot re-green.
      const last = state.lastAtByTerminalId[terminalId]
      if (last !== undefined && at <= last) return
      state.lastAtByTerminalId[terminalId] = at
      state.seq += 1
      state.pendingEvents.push({
        ...action.payload,
        seq: state.seq,
        source: 'freshAgent',
        watched: action.payload.watched ?? false,
      })
    },
    // Truly-idle edge (terminal.idle) for terminal CLI panes: the ONLY event that
    // rings the bell / shades the tab for claude/codex/opencode/amplifier terminal
    // panes. Deduped per terminal by monotonic `at` in its own namespace so it can
    // never poison (or be poisoned by) the turn-complete baselines.
    recordTerminalIdle(state, action: PayloadAction<TerminalIdlePayload>) {
      const { tabId, paneId, terminalId, at } = action.payload
      const baselines = state.lastIdleAtByTerminalId ??= {}
      const last = baselines[terminalId]
      if (last !== undefined && at <= last) return
      baselines[terminalId] = at
      state.seq += 1
      state.pendingEvents.push({
        tabId,
        paneId,
        terminalId,
        at,
        seq: state.seq,
        source: 'terminal',
        watched: action.payload.watched ?? false,
      })
    },
    // Cleared on a real server restart (not a plain reconnect). The new process has no
    // buffered events to replay, and its wall clock may be behind a clamp-inflated
    // pre-restart `at`, so dropping the per-terminal `at` baseline lets the first genuine
    // post-restart completion through instead of swallowing it as a stale replay.
    resetCompletionDedupeBaselines(state) {
      state.lastAtByTerminalId = {}
      state.lastIdleAtByTerminalId = {}
    },
    consumeTurnCompleteEvents(state, action: PayloadAction<{ throughSeq: number }>) {
      const { throughSeq } = action.payload
      if (throughSeq <= 0) return
      state.pendingEvents = state.pendingEvents.filter((event) => event.seq > throughSeq)
    },
    markTabAttention(state, action: PayloadAction<{ tabId: string }>) {
      if (state.attentionByTab[action.payload.tabId]) return
      state.attentionByTab[action.payload.tabId] = true
    },
    clearTabAttention(state, action: PayloadAction<{ tabId: string }>) {
      if (!state.attentionByTab[action.payload.tabId]) return
      delete state.attentionByTab[action.payload.tabId]
    },
    markPaneAttention(state, action: PayloadAction<{ paneId: string }>) {
      if (state.attentionByPane[action.payload.paneId]) return
      state.attentionByPane[action.payload.paneId] = true
    },
    clearPaneAttention(state, action: PayloadAction<{ paneId: string }>) {
      if (!state.attentionByPane[action.payload.paneId]) return
      delete state.attentionByPane[action.payload.paneId]
    },
    markTabWatchedCompletion(state, action: PayloadAction<{ tabId: string }>) {
      const marks = state.watchedCompletionByTab ??= {}
      if (marks[action.payload.tabId]) return
      marks[action.payload.tabId] = true
    },
    clearTabWatchedCompletion(state, action: PayloadAction<{ tabId: string }>) {
      if (!state.watchedCompletionByTab?.[action.payload.tabId]) return
      delete state.watchedCompletionByTab[action.payload.tabId]
    },
  },
})

export const {
  advanceCompletionBaseline,
  recordTurnComplete,
  recordTerminalIdle,
  resetCompletionDedupeBaselines,
  consumeTurnCompleteEvents,
  markTabAttention,
  clearTabAttention,
  markPaneAttention,
  clearPaneAttention,
  markTabWatchedCompletion,
  clearTabWatchedCompletion,
} = turnCompletionSlice.actions

export default turnCompletionSlice.reducer
