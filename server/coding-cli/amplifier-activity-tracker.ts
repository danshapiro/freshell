import { EventEmitter } from 'events'
import { isSubmitInput } from '../../shared/turn-complete-signal.js'
import type { TerminalTurnCompletionSnapshot } from '../../shared/ws-protocol.js'
import type { AmplifierReducerEffect } from './amplifier-events-reducer.js'
import { TurnCompletionLedger } from './turn-completion-ledger.js'

// Deadman: a busy terminal silent this long triggers the missed-signal failsafe
// (docs/plans/2026-07-08-amplifier-session-durability-plan.md §6): request a
// force-read of events.jsonl (WSL2 inotify backstop) and STAY busy — never
// fabricate a completion; `prompt:complete` / `session:end` records are the
// only turn ends.
export const AMPLIFIER_BUSY_DEADMAN_MS = 120_000
export const AMPLIFIER_ACTIVITY_SWEEP_MS = 5_000
// A PTY Enter is only PROVISIONALLY busy. Empty-Enter writes zero events
// (plan §2 E5), so if no `prompt:submit` record confirms the turn within this
// window the tracker silently reverts to idle (no turn.complete). Because a
// silently-dead watcher (WSL2 inotify) would also look like "no record", the
// FIRST expiry requests a force-read of the events tail and extends the grace
// once; only the second expiry reverts (adversarial finding D).
export const AMPLIFIER_SUBMIT_GRACE_MS = 2_000
// After this many CONSECUTIVE grace reversions on one terminal a single
// 'amplifier_events_lane_suspect' warn is logged (soak monitoring for dead
// watchers). Empty-Enters are legitimate reversions, so this is a log signal
// only — it never changes behavior.
export const AMPLIFIER_GRACE_REVERSION_SUSPECT_THRESHOLD = 3

export type AmplifierActivityPhase = 'idle' | 'busy'

export type AmplifierActivityRecord = {
  terminalId: string
  sessionId?: string
  phase: AmplifierActivityPhase
  updatedAt: number
}

export type AmplifierTurnCompleteEvent = {
  terminalId: string
  sessionId?: string
  at: number
  completionSeq: number
}

export type AmplifierActivityChange = {
  upsert: AmplifierActivityRecord[]
  remove: string[]
}

/**
 * Emitted (event name 'events.force-read') when a busy terminal has been
 * silent past the deadman: the integration must force-read the events tail
 * (WSL2 inotify backstop). The tracker stays busy — it never fabricates a
 * completion.
 */
export type AmplifierEventsForceReadRequest = {
  terminalId: string
  sessionId?: string
  at: number
}

type TrackerLogger = {
  warn: (payload: object, message?: string) => void
}

type AmplifierTerminalActivity = {
  terminalId: string
  sessionId?: string
  phase: AmplifierActivityPhase
  updatedAt: number
  lastObservedAt: number
  // True once a `prompt:submit` record confirmed the current busy phase;
  // false while busy is provisional (PTY Enter, awaiting the record).
  busyConfirmed: boolean
  submitGraceTimer?: ReturnType<typeof setTimeout>
  // True once the current provisional busy already spent its one force-read
  // retry (finding D): the next grace expiry reverts.
  submitGraceRetried: boolean
  // Consecutive silent grace reversions; reset by any confirmed turn.began.
  graceReversionCount: number
  // Deadman force-read warn is logged once per stuck-busy period.
  forceReadLogged: boolean
}

/**
 * Server-authoritative Amplifier turn lifecycle, keyed by terminalId.
 *
 * Single events-driven state machine
 * (docs/plans/2026-07-08-amplifier-session-durability-plan.md §6; the former
 * feature flag and degraded PTY-timing lane were removed 2026-07-08):
 *
 * - PTY Enter (`noteInput` + `isSubmitInput`) is only a PROVISIONAL busy with a
 *   submit-grace reversion (one force-read retry, then a silent revert — no
 *   turn.complete). A `prompt:submit` record (reducer `turn.began` effect via
 *   applyLifecycle()) confirms busy; `prompt:complete` / `session:end`
 *   (`turn.completed`) is the single turn boundary and emits exactly one
 *   turn.complete via the TurnCompletionLedger.
 * - PTY output only refreshes liveness (feeds the deadman). The deadman never
 *   fabricates a completion: it requests a force-read of the events tail and
 *   stays busy. PTY exit (noteExit) removes state unconditionally.
 * - Signal loss (tailer degraded/detached — see noteEventsSignalLost): the
 *   phase reverts to idle silently and the terminal keeps only the
 *   grace-bounded provisional-busy pulses from PTY submits. Sessions that
 *   never produce an events.jsonl behave the same way by construction: no
 *   confirmed busy, no turn.complete — documented, acceptable behavior.
 *
 * The public surface (list/getActivity/listLatestCompletions/trackTerminal/
 * bindSession/noteInput/noteOutput/noteExit/expire/dispose + 'changed'/'turn.complete'/
 * 'events.force-read' events, phase 'idle' | 'busy') is frozen.
 */
export class AmplifierActivityTracker extends EventEmitter {
  private readonly states = new Map<string, AmplifierTerminalActivity>()
  private readonly completionLedger = new TurnCompletionLedger()
  private readonly log?: TrackerLogger

  constructor(input: { log?: TrackerLogger } = {}) {
    super()
    this.log = input.log
  }

  list(): AmplifierActivityRecord[] {
    return Array.from(this.states.values()).map((state) => this.toRecord(state))
  }

  getActivity(terminalId: string): AmplifierActivityRecord | undefined {
    const state = this.states.get(terminalId)
    return state ? this.toRecord(state) : undefined
  }

  listLatestCompletions(): TerminalTurnCompletionSnapshot[] {
    return this.completionLedger.listLatestCompletions()
  }

  trackTerminal(input: { terminalId: string; sessionId?: string; at: number }): void {
    const existing = this.states.get(input.terminalId)
    if (existing) {
      if (input.sessionId && existing.sessionId !== input.sessionId) {
        const previous = this.toRecord(existing)
        existing.sessionId = input.sessionId
        this.commitState(existing, previous)
      }
      return
    }
    const state: AmplifierTerminalActivity = {
      terminalId: input.terminalId,
      sessionId: input.sessionId,
      phase: 'idle',
      updatedAt: input.at,
      lastObservedAt: input.at,
      busyConfirmed: false,
      submitGraceRetried: false,
      graceReversionCount: 0,
      forceReadLogged: false,
    }
    this.commitState(state, undefined)
  }

  bindSession(input: { terminalId: string; sessionId: string; at: number }): void {
    void input.at
    const state = this.states.get(input.terminalId)
    if (!state || state.sessionId === input.sessionId) return
    const previous = this.toRecord(state)
    state.sessionId = input.sessionId
    this.commitState(state, previous)
  }

  /**
   * The events signal for this terminal is gone (tailer degraded: schema
   * mismatch, file reset, persistent read errors, attach failure — or the
   * integration detached without replacement). Policy (plan §6, 2026-07-08):
   * NO fallback to timing heuristics. A busy phase reverts to idle silently —
   * the phase flip is publicly visible via 'changed', but no turn.complete is
   * ever fabricated. From here on the terminal only ever shows the
   * grace-bounded provisional-busy pulses from PTY submits (which always
   * revert, since no `prompt:submit` record can arrive). The single
   * 'amplifier_events_lane_degraded' warn is the integration's responsibility.
   */
  noteEventsSignalLost(terminalId: string): void {
    const state = this.states.get(terminalId)
    if (!state) return
    this.clearSubmitGrace(state)
    state.busyConfirmed = false
    state.forceReadLogged = false
    if (state.phase !== 'busy') return
    const previous = this.toRecord(state)
    const at = Date.now()
    state.phase = 'idle'
    state.updatedAt = at
    state.lastObservedAt = at
    this.commitState(state, previous)
  }

  /**
   * Consume a reducer effect (plan §6 transition table). `lane.degrade`
   * (schema-gate failure surfaced by the reducer) is treated as signal loss.
   */
  applyLifecycle(terminalId: string, effect: AmplifierReducerEffect): void {
    const state = this.states.get(terminalId)
    if (!state) return
    switch (effect.kind) {
      case 'lane.degrade': {
        this.noteEventsSignalLost(terminalId)
        return
      }
      case 'turn.began': {
        // The only input that (re)enters busy (E2/E5). Confirms a provisional busy.
        const at = parseEffectAt(effect.at)
        this.clearSubmitGrace(state)
        state.busyConfirmed = true
        state.forceReadLogged = false
        state.graceReversionCount = 0
        state.lastObservedAt = at
        if (state.phase !== 'busy') {
          const previous = this.toRecord(state)
          state.phase = 'busy'
          state.updatedAt = at
          this.commitState(state, previous)
        }
        return
      }
      case 'turn.completed': {
        // The single turn boundary (E2/E3): exactly one turn.complete per turn.
        this.completeTurn(state, parseEffectAt(effect.at))
        return
      }
      case 'session.identified': {
        if (!effect.sessionId || state.sessionId === effect.sessionId) return
        const previous = this.toRecord(state)
        state.sessionId = effect.sessionId
        this.commitState(state, previous)
        return
      }
      default:
        return
    }
  }

  noteInput(input: { terminalId: string; data: string; at: number }): void {
    const state = this.states.get(input.terminalId)
    if (!state) return
    if (!isSubmitInput(input.data)) return
    // Idle + PTY submit → provisional busy with a grace timer (empty-Enter
    // writes zero events, E5). Submit during busy re-arms NOTHING — mid-turn
    // typing is queued steering within the same turn (E5).
    state.lastObservedAt = input.at
    if (state.phase === 'busy') return
    const previous = this.toRecord(state)
    state.phase = 'busy'
    state.busyConfirmed = false
    state.submitGraceRetried = false
    state.updatedAt = input.at
    this.armSubmitGrace(state, input.at)
    this.commitState(state, previous)
  }

  noteOutput(input: { terminalId: string; data: string; at: number }): void {
    const state = this.states.get(input.terminalId)
    if (!state) return
    if (state.phase !== 'busy') return
    // Output only refreshes liveness (feeds the deadman). It never ends a
    // turn — `prompt:complete` is the only turn boundary.
    state.lastObservedAt = input.at
    state.forceReadLogged = false
  }

  private armSubmitGrace(state: AmplifierTerminalActivity, at: number): void {
    this.clearSubmitGrace(state)
    const terminalId = state.terminalId
    const expiryAt = at + AMPLIFIER_SUBMIT_GRACE_MS
    const timer = setTimeout(() => {
      this.handleSubmitGraceTimeout(terminalId, expiryAt)
    }, AMPLIFIER_SUBMIT_GRACE_MS)
    // Do not keep the event loop alive solely for a grace timer.
    ;(timer as unknown as { unref?: () => void }).unref?.()
    state.submitGraceTimer = timer
  }

  private clearSubmitGrace(state: AmplifierTerminalActivity): void {
    if (state.submitGraceTimer !== undefined) {
      clearTimeout(state.submitGraceTimer)
      state.submitGraceTimer = undefined
    }
  }

  private handleSubmitGraceTimeout(terminalId: string, at: number): void {
    const state = this.states.get(terminalId)
    if (!state) return
    state.submitGraceTimer = undefined
    if (state.phase !== 'busy' || state.busyConfirmed) return
    if (!state.submitGraceRetried) {
      // Backstop for silently-dead watchers (WSL2 inotify; adversarial finding
      // D): "no prompt:submit seen" may just mean "no change event delivered".
      // Request a force-read of the events tail and extend the grace ONCE — a
      // drained prompt:submit confirms busy via the normal turn.began path.
      // Never reverts-then-corrects, so clients see no idle→busy flap.
      state.submitGraceRetried = true
      this.emit('events.force-read', {
        terminalId: state.terminalId,
        ...(state.sessionId ? { sessionId: state.sessionId } : {}),
        at,
      } satisfies AmplifierEventsForceReadRequest)
      this.armSubmitGrace(state, at)
      return
    }
    // Silent reversion (plan §6, validated by E5): no `prompt:submit` record
    // followed the Enter (nor the force-read), so the turn never started.
    // NO turn.complete.
    const previous = this.toRecord(state)
    state.phase = 'idle'
    state.updatedAt = at
    state.lastObservedAt = at
    state.graceReversionCount += 1
    if (state.graceReversionCount === AMPLIFIER_GRACE_REVERSION_SUSPECT_THRESHOLD) {
      // Soak signal only (Phase 5): repeated reversions can mean a dead watcher
      // OR repeated legitimate empty-Enters — never changes behavior.
      this.log?.warn({
        component: 'amplifier-activity-tracker',
        event: 'amplifier_events_lane_suspect',
        terminalId: state.terminalId,
        reversions: state.graceReversionCount,
      }, 'Amplifier tracker saw repeated submit-grace reversions; the events watcher may be dead.')
    }
    this.commitState(state, previous)
  }

  /** Turn-completion path (reducer `turn.completed` effect). */
  private completeTurn(state: AmplifierTerminalActivity, at: number): void {
    if (state.phase !== 'busy') return
    const previous = this.toRecord(state)
    this.clearSubmitGrace(state)
    state.phase = 'idle'
    state.busyConfirmed = false
    state.forceReadLogged = false
    state.updatedAt = at
    state.lastObservedAt = at
    const completion = this.completionLedger.recordTurnCompletion({
      terminalId: state.terminalId,
      ...(state.sessionId ? { sessionId: state.sessionId } : {}),
      at,
    })
    this.commitState(state, previous)
    this.emit('turn.complete', completion)
  }

  noteExit(input: { terminalId: string }): void {
    // PTY exit is the authoritative end — unconditional (plan §6).
    this.removeState(input.terminalId)
  }

  expire(at: number): void {
    for (const state of this.states.values()) {
      if (state.phase !== 'busy') continue
      const idleAgeMs = at - state.lastObservedAt
      if (idleAgeMs <= AMPLIFIER_BUSY_DEADMAN_MS) continue
      // Missed-signal failsafe ONLY (plan §6): never fabricate a completion.
      // Request a force-read of the tail (WSL2 inotify backstop); if nothing
      // surfaces the terminal stays busy (genuine long turn).
      if (!state.forceReadLogged) {
        state.forceReadLogged = true
        this.log?.warn({
          component: 'amplifier-activity-tracker',
          event: 'amplifier_activity_deadman_force_read',
          terminalId: state.terminalId,
          ageMs: idleAgeMs,
        }, 'Amplifier terminal silent past deadman; requesting force-read (staying busy).')
      }
      this.emit('events.force-read', {
        terminalId: state.terminalId,
        ...(state.sessionId ? { sessionId: state.sessionId } : {}),
        at,
      } satisfies AmplifierEventsForceReadRequest)
    }
  }

  /** Clear every per-terminal grace timer (called on wiring dispose). */
  dispose(): void {
    for (const state of this.states.values()) {
      this.clearSubmitGrace(state)
    }
  }

  private commitState(state: AmplifierTerminalActivity, previous: AmplifierActivityRecord | undefined): void {
    this.states.set(state.terminalId, state)
    const next = this.toRecord(state)
    if (!this.hasPublicChange(previous, next)) return
    this.emit('changed', { upsert: [next], remove: [] } satisfies AmplifierActivityChange)
  }

  private removeState(terminalId: string): void {
    const state = this.states.get(terminalId)
    if (!state) return
    this.clearSubmitGrace(state)
    this.states.delete(terminalId)
    this.emit('changed', { upsert: [], remove: [terminalId] } satisfies AmplifierActivityChange)
  }

  private toRecord(state: AmplifierTerminalActivity): AmplifierActivityRecord {
    return {
      terminalId: state.terminalId,
      ...(state.sessionId ? { sessionId: state.sessionId } : {}),
      phase: state.phase,
      updatedAt: state.updatedAt,
    }
  }

  private hasPublicChange(previous: AmplifierActivityRecord | undefined, next: AmplifierActivityRecord): boolean {
    if (!previous) return true
    return previous.phase !== next.phase || previous.sessionId !== next.sessionId
  }
}

/** Effect timestamps are ISO strings carried through from the log (plan §6:
 *  never used to gate transitions, only for `updatedAt`/`at` fields). */
function parseEffectAt(at: string | undefined): number {
  if (at) {
    const parsed = Date.parse(at)
    if (Number.isFinite(parsed)) return parsed
  }
  return Date.now()
}
