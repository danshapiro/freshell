import { EventEmitter } from 'events'
import {
  countTrackerTurnCompleteSignals,
  createTurnCompleteSignalParserState,
  extractTurnCompleteSignals,
  isSubmitInput,
  type TurnCompleteSignalParserState,
} from '../../shared/turn-complete-signal.js'
import type { TerminalTurnCompletionSnapshot } from '../../shared/ws-protocol.js'
import type {
  CodexApprovalRequestedEvent,
  CodexApprovalResolvedEvent,
  CodexTurnCompletedEvent,
  CodexTurnStartedEvent,
  SessionBindingReason,
} from '../terminal-stream/registry-events.js'
import type { CodingCliSession, ProjectGroup } from './types.js'
import { TurnCompletionLedger } from './turn-completion-ledger.js'

export const PENDING_SUBMIT_GATE_MS = 6000
export const PENDING_SNAPSHOT_GRACE_MS = 15000
export const BUSY_DEADMAN_MS = 120000
export const ACTIVITY_SWEEP_MS = 5000

export type CodexActivityPhase = 'idle' | 'pending' | 'busy' | 'unknown'

export type CodexActivityRecord = {
  terminalId: string
  sessionId?: string
  phase: CodexActivityPhase
  updatedAt: number
}

export type CodexTerminalActivity = CodexActivityRecord & {
  bindingReason: SessionBindingReason
  lastSubmitAt?: number
  pendingSubmitAt?: number
  pendingFreshnessAt?: number
  pendingUntil?: number
  queuedSubmitAt?: number
  acceptedStartAt?: number
  latentAcceptedStartAt?: number
  lastClearedAt?: number
  lastSeenTaskStartedAt?: number
  lastSeenTaskCompletedAt?: number
  lastSeenTurnAbortedAt?: number
  lastSeenSessionLastActivityAt?: number
  lastObservedAt: number
  lastEmittedTurnKey?: number
  /**
   * kata codex-turn-thread-scope: the bound thread's in-flight app-server
   * turn id (set on turn/started). A turn/completed carrying a DIFFERENT
   * turn id is a stale echo of an already-closed turn -- no-op by
   * construction. Absent ids fall back to phase semantics.
   */
  currentTurnId?: string
  /**
   * Outstanding server->client approval request ids (managed proxy lane,
   * Task 12 / Rust codex.rs pending_approvals).
   */
  pendingApprovals: Set<string>
  /**
   * True when the approval pause demoted a working phase; the resolve
   * restores 'busy'. False when the approval arrived while already idle.
   */
  resumeBusyAfterApproval: boolean
  parserState: TurnCompleteSignalParserState
}

export type CodexTurnCompleteEvent = {
  terminalId: string
  sessionId?: string
  at: number
  completionSeq: number
}

export type CodexActivityChange = {
  upsert: CodexActivityRecord[]
  remove: string[]
  /** Subset of `remove` caused by a spontaneous PTY death (death-bell input). */
  spontaneousExitRemovals?: string[]
  /**
   * Subset of `remove` whose pending-approval set was non-empty at removal
   * time (read BEFORE deletion). A pane blocked on an approval whose process
   * dies spontaneously counts as engaged for the death bell (decision 3 --
   * Node mirror of Rust has_pending_approvals).
   */
  approvalPendingRemovals?: string[]
}

function maxDefined(...values: Array<number | undefined>): number | undefined {
  let result: number | undefined
  for (const value of values) {
    if (value === undefined) continue
    if (result === undefined || value > result) result = value
  }
  return result
}

function latestClearAt(session?: CodingCliSession): number | undefined {
  return maxDefined(
    session?.codexTaskEvents?.latestTaskCompletedAt,
    session?.codexTaskEvents?.latestTurnAbortedAt,
  )
}

// Mirrors Rust abort_reason_is_human: missing reason = legacy/uncertainty ->
// silent; 'interrupted'/'replaced' = human-requested -> silent; anything else
// is not human-attributed and records (rings).
function abortReasonIsHuman(reason: string | undefined): boolean {
  return reason === undefined || reason === 'interrupted' || reason === 'replaced'
}

function isUnresolvedSession(session?: CodingCliSession): boolean {
  const startedAt = session?.codexTaskEvents?.latestTaskStartedAt
  if (startedAt === undefined) return false
  const clearedAt = latestClearAt(session)
  return clearedAt === undefined || startedAt > clearedAt
}

function buildProjectIndex(projects: ProjectGroup[]): Map<string, CodingCliSession> {
  const sessions = new Map<string, CodingCliSession>()
  for (const project of projects) {
    for (const session of project.sessions) {
      if (session.provider !== 'codex') continue
      sessions.set(session.sessionId, session)
    }
  }
  return sessions
}

export class CodexActivityTracker extends EventEmitter {
  private readonly states = new Map<string, CodexTerminalActivity>()
  private readonly completionLedger = new TurnCompletionLedger()
  private pendingCompletions: CodexTurnCompleteEvent[] = []

  list(): CodexActivityRecord[] {
    return Array.from(this.states.values()).map((state) => this.toRecord(state))
  }

  getActivity(terminalId: string): CodexTerminalActivity | undefined {
    return this.states.get(terminalId)
  }

  listLatestCompletions(): TerminalTurnCompletionSnapshot[] {
    return this.completionLedger.listLatestCompletions()
  }

  isPromptBlocked(terminalId: string, at?: number): boolean {
    const state = this.states.get(terminalId)
    if (!state) return false
    if (at !== undefined) {
      this.expireState(state, at)
    }
    const phase = state.phase
    return phase === 'pending' || phase === 'busy'
  }

  bindTerminal(input: {
    terminalId: string
    sessionId: string
    reason: SessionBindingReason
    session?: CodingCliSession
    at: number
  }): void {
    const previous = this.states.get(input.terminalId)
    if (previous?.sessionId === input.sessionId) {
      const previousRecord = this.toRecord(previous)
      this.refreshExistingBinding(previous, input)
      this.commitState(previous, previousRecord)
      return
    }

    const state: CodexTerminalActivity = {
      terminalId: input.terminalId,
      sessionId: input.sessionId,
      bindingReason: input.reason,
      phase: 'idle',
      updatedAt: input.at,
      lastObservedAt: input.at,
      lastSeenTaskStartedAt: input.session?.codexTaskEvents?.latestTaskStartedAt,
      lastSeenTaskCompletedAt: input.session?.codexTaskEvents?.latestTaskCompletedAt,
      lastSeenTurnAbortedAt: input.session?.codexTaskEvents?.latestTurnAbortedAt,
      lastSeenSessionLastActivityAt: input.session?.lastActivityAt,
      lastClearedAt: latestClearAt(input.session),
      // A rebind moves the pane to a different thread: the old thread's
      // approval pause state must not survive (fresh state ⇒ inherently
      // cleared -- Task 12 mirror of Rust bind_session).
      pendingApprovals: new Set(),
      resumeBusyAfterApproval: false,
      parserState: createTurnCompleteSignalParserState(),
    }

    if (input.reason === 'resume' && isUnresolvedSession(input.session)) {
      state.phase = 'busy'
      state.acceptedStartAt = input.session?.codexTaskEvents?.latestTaskStartedAt
    } else if (input.reason === 'association' && isUnresolvedSession(input.session)) {
      state.latentAcceptedStartAt = input.session?.codexTaskEvents?.latestTaskStartedAt
    }

    this.commitState(state, previous)
  }

  unbindTerminal(input: { terminalId: string; at: number }): void {
    void input.at
    this.removeState(input.terminalId)
  }

  noteExit(input: { terminalId: string; at: number; spontaneous?: boolean }): void {
    void input.at
    this.removeState(input.terminalId, { spontaneousExit: input.spontaneous === true })
  }

  noteInput(input: { terminalId: string; data: string; at: number }): void {
    const state = this.states.get(input.terminalId)
    if (!state) return
    if (!isSubmitInput(input.data)) return
    const previous = this.toRecord(state)
    if (state.phase === 'unknown' && state.acceptedStartAt !== undefined) {
      state.latentAcceptedStartAt = maxDefined(state.latentAcceptedStartAt, state.acceptedStartAt)
      state.acceptedStartAt = undefined
      state.queuedSubmitAt = undefined
    }
    state.lastSubmitAt = input.at
    state.pendingUntil = input.at + PENDING_SUBMIT_GATE_MS
    state.pendingFreshnessAt = input.at
    state.lastObservedAt = input.at
    if (state.phase === 'busy') {
      if (state.queuedSubmitAt === undefined) {
        state.queuedSubmitAt = input.at
      }
      state.pendingFreshnessAt = undefined
      this.commitState(state, previous)
      return
    }

    if (state.pendingSubmitAt === undefined) {
      state.pendingSubmitAt = input.at
    } else if (state.queuedSubmitAt === undefined) {
      state.queuedSubmitAt = input.at
    }
    state.phase = 'pending'
    state.updatedAt = input.at
    this.commitState(state, previous)
  }

  noteOutput(input: { terminalId: string; data: string; at: number }): void {
    const state = this.states.get(input.terminalId)
    if (!state) return

    const parserStateAtStart = { ...state.parserState }
    const { count } = extractTurnCompleteSignals(input.data, 'codex', state.parserState)
    if (count <= 0) {
      if (state.phase === 'busy' || state.phase === 'pending') {
        state.lastObservedAt = input.at
      }
      return
    }
    const trackerCount = countTrackerTurnCompleteSignals(input.data, parserStateAtStart)
    const clearCount = Math.min(count, trackerCount)
    if (clearCount <= 0) {
      if (state.phase === 'busy' || state.phase === 'pending') {
        state.lastObservedAt = input.at
      }
      return
    }

    const previous = this.toRecord(state)
    for (let signalIndex = 0; signalIndex < clearCount; signalIndex += 1) {
      if (!this.consumeTurnCompleteSignal(state, input.at)) {
        break
      }
    }
    this.commitState(state, previous)
    this.flushCompletions()
  }

  onTurnStarted(input: CodexTurnStartedEvent): void {
    const state = this.states.get(input.terminalId)
    if (!state) return
    // Thread scope guard (kata codex-turn-thread-scope, spike scenario D):
    // the shared app-server connection relays turn events for EVERY thread
    // (sub-agents, review threads, forks). Only the bound thread's turns
    // drive this terminal. A codex terminal enters the tracker only at bind
    // time, so the unbound window is inherently silent (parity with the
    // Rust tracker's unbound => ignore).
    if (state.sessionId === undefined || state.sessionId !== input.threadId) return

    const previous = this.toRecord(state)
    state.currentTurnId = input.turnId
    state.lastSeenTaskStartedAt = maxDefined(state.lastSeenTaskStartedAt, input.at)
    this.promoteBusy(state, input.at, input.at)
    this.commitState(state, previous)
  }

  onTurnCompleted(input: CodexTurnCompletedEvent): void {
    const state = this.states.get(input.terminalId)
    if (!state) return
    // Guard order mirrors the Rust tracker (crates/freshell-activity/src/
    // codex.rs::note_proxy_turn_completed): thread scope -> inProgress ->
    // stale turn id -> status.
    if (state.sessionId === undefined || state.sessionId !== input.threadId) return
    // turn/completed fires for ALL statuses; inProgress is not a turn end.
    if (input.status === 'inProgress') return
    if (input.turnId !== undefined && state.currentTurnId !== undefined && input.turnId !== state.currentTurnId) {
      return
    }
    // Task 12: an accepted terminal-status completion retires the turn's
    // approval pause state ONCE, BEFORE the phase transitions -- a turn that
    // completes during an approval pause routes through the idle path (the
    // request itself demoted the phase), so a late resolve of the stale
    // approval must not flip the pane busy again.
    state.pendingApprovals.clear()
    state.resumeBusyAfterApproval = false
    // Attention-bell policy: completed AND failed record (ring); interrupted is
    // the human-requested silent clear. Mirrors Rust codex.rs record predicate.
    const record = input.status === undefined || input.status === 'completed' || input.status === 'failed'

    state.currentTurnId = undefined
    const previous = this.toRecord(state)
    if (input.status === undefined || input.status === 'completed') {
      state.lastSeenTaskCompletedAt = maxDefined(state.lastSeenTaskCompletedAt, input.at)
    }
    if (state.phase === 'pending' && state.pendingSubmitAt !== undefined) {
      this.transitionPendingAfterTurnClear(state, input.at, record)
    } else if (state.phase === 'idle') {
      // Mid-pause turn end / stale echo (mirror of the Rust Idle arm,
      // crates/freshell-activity/src/codex.rs note_proxy_turn_completed):
      // an approval pause demoted the phase, so the pause's turn/completed
      // lands here -- no completion, no event (the approval bell already
      // covers this attention event). But the anchors this turn planted
      // (acceptedStartAt via onTurnStarted's promoteBusy or a mid-pause
      // reconcile fold; pendingSubmitAt via a pause keystroke; a latent
      // anchor on association bindings) would otherwise survive and let a
      // later PTY BEL echo re-mint the same physical turn via
      // consumeTurnCompleteSignal. Claim the turn key with the same
      // derivation the busy/pending paths use and retire the anchors.
      const turnKey = state.acceptedStartAt ?? state.pendingSubmitAt
      state.acceptedStartAt = undefined
      state.pendingSubmitAt = undefined
      state.latentAcceptedStartAt = undefined
      this.claimTurnKeyIfIdle(state, turnKey)
    } else if ((state.phase === 'busy' || state.phase === 'unknown') && state.acceptedStartAt !== undefined) {
      this.transitionAfterTurnClear(state, input.at, record)
    } else if (state.latentAcceptedStartAt !== undefined) {
      this.transitionAfterLatentTurnClear(state, input.at)
    }
    this.commitState(state, previous)
    this.flushCompletions()
  }

  /**
   * Approval-request pause (managed proxy lane, Task 12 -- Node mirror of
   * Rust note_approval_requested). Thread-scoped like turn events; requests
   * without a threadId are accepted (the proxy is per-terminal). The public
   * phase maps to the EXISTING not-busy value -- no new wire phase. Queued
   * input never suppresses approval bells: still blocked on a human.
   */
  onApprovalRequested(input: CodexApprovalRequestedEvent): void {
    const state = this.states.get(input.terminalId)
    if (!state) return
    if (input.threadId !== undefined && state.sessionId !== undefined && input.threadId !== state.sessionId) {
      return
    }
    // Hardening (mirror of Rust note_approval_requested): only a NEWLY
    // inserted request id arms the gate. A duplicate request frame (proxy
    // retry / reconnect replay) for an id already pending must not re-arm --
    // one boundary per approval pause.
    const newlyInserted = !state.pendingApprovals.has(input.requestId)
    state.pendingApprovals.add(input.requestId)
    const previous = this.toRecord(state)
    if (state.phase === 'busy' || state.phase === 'pending' || state.phase === 'unknown') {
      state.resumeBusyAfterApproval = true
      state.phase = 'idle'
    }
    state.updatedAt = input.at
    this.commitState(state, previous)
    // Arms the truly-idle gate WITHOUT minting a turn completion or a
    // terminal.turn.complete frame -- an approval pause is not a turn end.
    // Emitted AFTER the 'changed' demotion so the gate sees not-busy first.
    if (newlyInserted) {
      this.emit('attention.boundary', { terminalId: input.terminalId, at: input.at })
    }
  }

  /**
   * The approval response passed back through the proxy: the turn resumes.
   * Cancels a pending bell within the grace (gate sees busy); un-greens the
   * pane. Stale/unknown request ids are no-ops.
   */
  onApprovalResolved(input: CodexApprovalResolvedEvent): void {
    const state = this.states.get(input.terminalId)
    if (!state) return
    if (!state.pendingApprovals.delete(input.requestId)) return
    if (state.pendingApprovals.size > 0 || !state.resumeBusyAfterApproval) return
    state.resumeBusyAfterApproval = false
    const previous = this.toRecord(state)
    state.phase = 'busy'
    state.updatedAt = input.at
    state.lastObservedAt = input.at
    // Audit A9 hazard 2: a mid-pause Enter (the human answering the approval
    // prompt in the TUI) planted PTY pending-submit state -- normalize it so
    // the next turn clear is not misread as a queued re-arm of the pause
    // keystroke (which would suppress a legitimate later bell).
    state.pendingSubmitAt = undefined
    state.pendingFreshnessAt = undefined
    state.pendingUntil = undefined
    this.commitState(state, previous)
  }

  reconcileProjects(projects: ProjectGroup[], at: number): void {
    const sessions = buildProjectIndex(projects)

    for (const state of this.states.values()) {
      if (!state.sessionId) continue
      const session = sessions.get(state.sessionId)
      if (!session) continue

      const previous = this.toRecord(state)
      const nextStartedAt = session.codexTaskEvents?.latestTaskStartedAt
      const nextCompletedAt = session.codexTaskEvents?.latestTaskCompletedAt
      const nextTurnAbortedAt = session.codexTaskEvents?.latestTurnAbortedAt
      const clearedAt = maxDefined(nextCompletedAt, nextTurnAbortedAt)
      // The newest terminating event decides the clear's shape: an abort
      // (Esc-interrupt / turn_aborted) still ends the turn but must not ring
      // (shared/ws-protocol.ts terminal.idle: "never emitted after
      // crash/interrupt/exit"). Ties go to task_complete: a real completion
      // at the same instant still rings. Mirror of the Rust tracker's
      // clear_is_abort (crates/freshell-activity/src/codex.rs).
      const clearIsAbort = nextTurnAbortedAt !== undefined
        && (nextCompletedAt === undefined || nextTurnAbortedAt > nextCompletedAt)
      // Abort-shaped clears stay silent only when human-attributed (or the
      // legacy reason-less form); a present non-human reason records (rings).
      const nextTurnAbortedReason = session.codexTaskEvents?.latestTurnAbortedReason
      const record = !clearIsAbort || !abortReasonIsHuman(nextTurnAbortedReason)
      state.lastSeenSessionLastActivityAt = maxDefined(state.lastSeenSessionLastActivityAt, session.lastActivityAt)

      if (nextStartedAt !== undefined) {
        const isNewStart = state.lastSeenTaskStartedAt === undefined || nextStartedAt > state.lastSeenTaskStartedAt
        state.lastSeenTaskStartedAt = maxDefined(state.lastSeenTaskStartedAt, nextStartedAt)
        if (
          isNewStart
          && (state.acceptedStartAt === undefined || nextStartedAt > state.acceptedStartAt)
          && (clearedAt === undefined || nextStartedAt > clearedAt)
          && (
            (state.pendingSubmitAt !== undefined && nextStartedAt >= state.pendingSubmitAt)
            || state.phase === 'busy'
            || state.phase === 'unknown'
            || (state.bindingReason === 'resume' && state.phase === 'idle')
          )
        ) {
          if (state.pendingApprovals.size === 0) {
            this.promoteBusy(state, nextStartedAt, at)
          } else {
            // Lane-interference guard (decision 8 / audit A9): the turn's own
            // task_started folding in MID-PAUSE would flip the phase busy,
            // feed the gate, and silently cancel the armed approval bell.
            // Fold the anchor as usual but defer the busy promotion to the
            // approval resolve.
            state.acceptedStartAt = nextStartedAt
            state.resumeBusyAfterApproval = true
          }
        } else if (
          isNewStart
          && state.bindingReason === 'association'
          && state.phase === 'idle'
          && state.pendingSubmitAt === undefined
        ) {
          state.latentAcceptedStartAt = nextStartedAt
        }
      }

      if (nextCompletedAt !== undefined) {
        state.lastSeenTaskCompletedAt = maxDefined(state.lastSeenTaskCompletedAt, nextCompletedAt)
      }
      if (nextTurnAbortedAt !== undefined) {
        state.lastSeenTurnAbortedAt = maxDefined(state.lastSeenTurnAbortedAt, nextTurnAbortedAt)
      }

      let consumedLatentClear = false
      if (
        clearedAt !== undefined
        && state.latentAcceptedStartAt !== undefined
        && clearedAt >= state.latentAcceptedStartAt
      ) {
        if (state.phase === 'pending' && state.pendingSubmitAt !== undefined) {
          this.transitionPendingAfterLatentTurnClear(state, at)
        } else if (state.acceptedStartAt === undefined) {
          this.transitionAfterLatentTurnClear(state, at)
        }
        consumedLatentClear = true
      }

      if (
        !consumedLatentClear
        && clearedAt !== undefined
        && state.phase === 'pending'
        && state.pendingSubmitAt !== undefined
        && clearedAt >= state.pendingSubmitAt
      ) {
        this.transitionPendingAfterTurnClear(state, at, record)
      }

      if (
        clearedAt !== undefined
        && state.acceptedStartAt !== undefined
        && clearedAt >= state.acceptedStartAt
        && (state.phase === 'busy' || state.phase === 'unknown')
      ) {
        this.transitionAfterTurnClear(state, at, record)
      }

      this.commitState(state, previous)
    }
    this.flushCompletions()
  }

  expire(at: number): void {
    for (const state of this.states.values()) {
      this.expireState(state, at)
    }
  }

  private promoteBusy(state: CodexTerminalActivity, startedAt: number, at: number): void {
    if (state.lastSubmitAt !== undefined && state.lastSubmitAt > startedAt) {
      state.queuedSubmitAt = state.lastSubmitAt
    } else {
      state.queuedSubmitAt = undefined
    }
    state.phase = 'busy'
    state.acceptedStartAt = startedAt
    state.latentAcceptedStartAt = undefined
    state.pendingSubmitAt = undefined
    state.pendingFreshnessAt = undefined
    state.pendingUntil = undefined
    state.updatedAt = at
    state.lastObservedAt = at
  }

  private transitionAfterTurnClear(state: CodexTerminalActivity, at: number, record = true): void {
    const turnKey = state.acceptedStartAt
    const hasQueuedSubmit = this.hasQueuedSubmit(state)
    state.lastClearedAt = at
    state.acceptedStartAt = undefined
    state.latentAcceptedStartAt = undefined
    state.updatedAt = at
    state.lastObservedAt = at
    if (hasQueuedSubmit) {
      state.phase = 'pending'
      state.pendingSubmitAt = state.queuedSubmitAt
      state.pendingFreshnessAt = at
      state.pendingUntil = at + PENDING_SUBMIT_GATE_MS
      state.queuedSubmitAt = undefined
    } else {
      state.phase = 'idle'
      state.pendingSubmitAt = undefined
      state.pendingFreshnessAt = undefined
      state.queuedSubmitAt = undefined
      state.pendingUntil = undefined
    }
    if (record) {
      this.recordCompletionIfIdle(state, turnKey, at)
    } else {
      this.claimTurnKeyIfIdle(state, turnKey)
    }
  }

  private transitionAfterLatentTurnClear(state: CodexTerminalActivity, at: number): void {
    state.latentAcceptedStartAt = undefined
    state.lastClearedAt = at
    state.updatedAt = at
    state.lastObservedAt = at
  }

  private transitionPendingAfterLatentTurnClear(state: CodexTerminalActivity, at: number): void {
    state.latentAcceptedStartAt = undefined
    state.pendingFreshnessAt = at
    state.pendingUntil = at + PENDING_SUBMIT_GATE_MS
    state.lastClearedAt = at
    state.updatedAt = at
    state.lastObservedAt = at
  }

  private transitionPendingAfterTurnClear(state: CodexTerminalActivity, at: number, record = true): void {
    const turnKey = state.pendingSubmitAt
    state.latentAcceptedStartAt = undefined
    state.lastClearedAt = at
    state.updatedAt = at
    state.lastObservedAt = at
    if (this.hasQueuedSubmit(state)) {
      state.phase = 'pending'
      state.pendingSubmitAt = state.queuedSubmitAt
      state.pendingFreshnessAt = at
      state.pendingUntil = at + PENDING_SUBMIT_GATE_MS
      state.queuedSubmitAt = undefined
    } else {
      state.phase = 'idle'
      state.pendingSubmitAt = undefined
      state.pendingFreshnessAt = undefined
      state.pendingUntil = undefined
      state.queuedSubmitAt = undefined
    }
    if (record) {
      this.recordCompletionIfIdle(state, turnKey, at)
    } else {
      this.claimTurnKeyIfIdle(state, turnKey)
    }
  }

  /**
   * Record a turn completion when (and only when) a real turn-end transition
   * lands the terminal in `idle`. Re-arms to `pending` (a queued submit) are NOT
   * turn ends, so they record nothing. Dedupe per turn via `lastEmittedTurnKey`
   * so the live BEL, JSONL reconcile, and the app-server onTurnCompleted cannot
   * double-fire for the same turn. Flushed (emitted) after commitState by the
   * caller.
   */
  private recordCompletionIfIdle(state: CodexTerminalActivity, turnKey: number | undefined, at: number): void {
    if (turnKey === undefined) return
    if (state.phase !== 'idle') return
    if (state.lastEmittedTurnKey === turnKey) return
    state.lastEmittedTurnKey = turnKey
    this.pendingCompletions.push(this.completionLedger.recordTurnCompletion({
      terminalId: state.terminalId,
      ...(state.sessionId ? { sessionId: state.sessionId } : {}),
      at,
    }))
  }

  /**
   * Abort-shaped clears (turn_aborted / status interrupted|failed): claim
   * the turn key exactly like recordCompletionIfIdle does, but WITHOUT
   * recording, so a later echo of the same physical turn (BEL, JSONL
   * reconcile, app-server duplicate -- all share this key space) cannot
   * mint a completion. shared/ws-protocol.ts terminal.idle: "Never emitted
   * after crash/interrupt/exit".
   */
  private claimTurnKeyIfIdle(state: CodexTerminalActivity, turnKey: number | undefined): void {
    if (turnKey === undefined) return
    if (state.phase !== 'idle') return
    state.lastEmittedTurnKey = turnKey
  }

  private flushCompletions(): void {
    if (this.pendingCompletions.length === 0) return
    const out = this.pendingCompletions
    this.pendingCompletions = []
    for (const completion of out) {
      this.emit('turn.complete', completion)
    }
  }

  private refreshExistingBinding(
    state: CodexTerminalActivity,
    input: {
      terminalId: string
      sessionId: string
      reason: SessionBindingReason
      session?: CodingCliSession
      at: number
    },
  ): void {
    const startedAt = input.session?.codexTaskEvents?.latestTaskStartedAt
    const clearedAt = latestClearAt(input.session)
    state.bindingReason = input.reason
    state.lastSeenTaskStartedAt = maxDefined(state.lastSeenTaskStartedAt, startedAt)
    state.lastSeenTaskCompletedAt = maxDefined(state.lastSeenTaskCompletedAt, input.session?.codexTaskEvents?.latestTaskCompletedAt)
    state.lastSeenTurnAbortedAt = maxDefined(state.lastSeenTurnAbortedAt, input.session?.codexTaskEvents?.latestTurnAbortedAt)
    state.lastSeenSessionLastActivityAt = maxDefined(
      state.lastSeenSessionLastActivityAt,
      input.session?.lastActivityAt,
    )
    state.lastClearedAt = maxDefined(state.lastClearedAt, clearedAt)

    if (!isUnresolvedSession(input.session) || startedAt === undefined) {
      return
    }

    if (input.reason === 'resume') {
      if (state.phase === 'idle') {
        if (state.pendingApprovals.size > 0) {
          // Lane-interference guard (decision 8 / audit A9): a resume
          // re-announce landing during a pending approval must not promote
          // idle -> busy (it would silently cancel the armed approval bell).
          // Fold the anchor; the resolve restores busy.
          state.acceptedStartAt = maxDefined(state.acceptedStartAt, startedAt)
          state.latentAcceptedStartAt = undefined
          state.resumeBusyAfterApproval = true
        } else {
          state.phase = 'busy'
          state.acceptedStartAt = maxDefined(state.acceptedStartAt, startedAt)
          state.latentAcceptedStartAt = undefined
          state.updatedAt = input.at
        }
      } else if (state.phase === 'pending') {
        state.latentAcceptedStartAt = maxDefined(state.latentAcceptedStartAt, startedAt)
      } else {
        state.acceptedStartAt = maxDefined(state.acceptedStartAt, startedAt)
      }
      state.lastObservedAt = input.at
      return
    }

    if (state.phase !== 'busy' && state.phase !== 'unknown') {
      state.latentAcceptedStartAt = maxDefined(state.latentAcceptedStartAt, startedAt)
    }
  }

  private consumeTurnCompleteSignal(state: CodexTerminalActivity, at: number): boolean {
    if (state.phase === 'pending') {
      if (state.latentAcceptedStartAt !== undefined) {
        this.transitionPendingAfterLatentTurnClear(state, at)
        return true
      }
      if (state.pendingSubmitAt !== undefined) {
        this.transitionPendingAfterTurnClear(state, at)
        return true
      }
      return false
    }

    if (state.acceptedStartAt !== undefined) {
      this.transitionAfterTurnClear(state, at)
      return true
    }
    if (state.latentAcceptedStartAt !== undefined) {
      this.transitionAfterLatentTurnClear(state, at)
      return true
    }
    return false
  }

  private hasQueuedSubmit(state: CodexTerminalActivity): boolean {
    return state.queuedSubmitAt !== undefined
      && (state.acceptedStartAt === undefined || state.queuedSubmitAt > state.acceptedStartAt)
  }

  private awaitingFreshSnapshot(state: CodexTerminalActivity, at: number): boolean {
    const freshnessBoundaryAt = state.pendingFreshnessAt
    if (freshnessBoundaryAt === undefined) return false
    return state.pendingSubmitAt !== undefined
      && at <= freshnessBoundaryAt + PENDING_SNAPSHOT_GRACE_MS
  }

  private hasPendingOutputLiveness(state: CodexTerminalActivity, at: number): boolean {
    return state.pendingSubmitAt !== undefined
      && state.lastObservedAt > state.pendingSubmitAt
      && at - state.lastObservedAt <= BUSY_DEADMAN_MS
  }

  private expireState(state: CodexTerminalActivity, at: number): void {
    const previous = this.toRecord(state)

    if (state.pendingUntil !== undefined && at > state.pendingUntil) {
      state.pendingUntil = undefined
    }

    if (state.phase === 'pending' && state.pendingUntil === undefined) {
      if (!this.awaitingFreshSnapshot(state, at) && !this.hasPendingOutputLiveness(state, at)) {
        state.phase = 'idle'
        state.updatedAt = at
        state.lastObservedAt = at
        state.pendingSubmitAt = undefined
        state.pendingFreshnessAt = undefined
      }
    } else if (state.phase === 'busy' && at - state.lastObservedAt > BUSY_DEADMAN_MS) {
      state.phase = 'unknown'
      state.updatedAt = at
      state.lastObservedAt = at
    }

    this.commitState(state, previous)
  }

  private commitState(state: CodexTerminalActivity, previous?: CodexActivityRecord): void {
    this.states.set(state.terminalId, state)
    const next = this.toRecord(state)
    if (!this.hasPublicChange(previous, next)) return
    this.emit('changed', { upsert: [next], remove: [] } satisfies CodexActivityChange)
  }

  private removeState(terminalId: string, opts?: { spontaneousExit?: boolean }): void {
    const existing = this.states.get(terminalId)
    if (!existing) return
    // Death-bell engagement (decision 3): read BEFORE deleting the state -- a
    // pane blocked on an approval when it dies must still ring.
    const approvalPending = existing.pendingApprovals.size > 0
    this.states.delete(terminalId)
    this.emit('changed', {
      upsert: [],
      remove: [terminalId],
      ...(opts?.spontaneousExit ? { spontaneousExitRemovals: [terminalId] } : {}),
      ...(approvalPending ? { approvalPendingRemovals: [terminalId] } : {}),
    } satisfies CodexActivityChange)
  }

  private toRecord(state: CodexTerminalActivity): CodexActivityRecord {
    return {
      terminalId: state.terminalId,
      sessionId: state.sessionId,
      phase: state.phase,
      updatedAt: state.updatedAt,
    }
  }

  private hasPublicChange(previous: CodexActivityRecord | undefined, next: CodexActivityRecord): boolean {
    if (!previous) return true
    return previous.phase !== next.phase || previous.sessionId !== next.sessionId
  }
}
