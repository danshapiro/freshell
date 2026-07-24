import { EventEmitter } from 'events'

/**
 * Truly-idle grace window (pinned wire contract, shared with the Rust server
 * port — do not change unilaterally): after a turn boundary the terminal must
 * stay quiet (no new session-file activity, no queued user prompt) this long
 * before a single `terminal.idle` edge is emitted.
 */
export const TERMINAL_IDLE_GRACE_MS = 2_000

export type TrulyIdleReason = 'grace' | 'queue-empty'

export type TrulyIdleEvent = {
  terminalId: string
  /** Server epoch ms at emit time. */
  at: number
  reason: TrulyIdleReason
}

export type TrulyIdleActivityUpsert = {
  terminalId: string
  /** Provider tracker phase. 'busy' and 'pending' count as busy; anything else is not. */
  phase: string
}

export type TrulyIdleActivityChange = {
  upsert?: TrulyIdleActivityUpsert[]
  remove?: string[]
}

type TerminalIdleState = {
  busy: boolean
  /** True while the tracker phase is 'pending' (codex submit gate). */
  pending: boolean
  /** Queue evidence observed since the last emit (queued turn / re-armed submit). */
  sawQueueEvidence: boolean
  graceTimer?: ReturnType<typeof setTimeout>
}

function isBusyPhase(phase: string): boolean {
  return phase === 'busy' || phase === 'pending'
}

/**
 * Provider-agnostic truly-idle state machine, keyed by terminalId.
 *
 * Consumes the two event streams every activity tracker already emits —
 * 'changed' (phase upserts / removals) and 'turn.complete' (turn boundaries) —
 * and emits a single 'idle' edge per busy→truly-idle transition:
 *
 * - A turn boundary while the tracker still reports busy is a queued turn
 *   (claude inFlight ledger keeps phase busy until the queue drains): record
 *   queue evidence, never arm.
 * - A turn boundary landing idle arms a ONE-SHOT grace timer. Any busy flip
 *   inside the window (new prompt:submit record, task_started, PTY submit
 *   provisional busy) cancels it — no per-terminal intervals, no polling.
 * - A codex busy→pending re-arm (queued submit consumed at turn clear) counts
 *   as queue evidence; codex emits its completion only when the queue drained.
 * - Deadman/signal-loss idle flips arrive WITHOUT a turn boundary and never
 *   arm; PTY exit / crash removals cancel any armed timer and never emit.
 * - OpenCode's genuine turn end arrives as activityRemove followed by
 *   turnComplete: the removal clears state, the boundary then arms grace-only.
 *
 * Emits 'idle' with TrulyIdleEvent payloads.
 */
export class TrulyIdleEmitter extends EventEmitter {
  private readonly states = new Map<string, TerminalIdleState>()
  private readonly graceMs: number
  private readonly now: () => number
  private readonly setTimeoutFn: typeof setTimeout
  private readonly clearTimeoutFn: typeof clearTimeout

  constructor(input: {
    graceMs?: number
    now?: () => number
    setTimeoutFn?: typeof setTimeout
    clearTimeoutFn?: typeof clearTimeout
  } = {}) {
    super()
    this.graceMs = input.graceMs ?? TERMINAL_IDLE_GRACE_MS
    this.now = input.now ?? (() => Date.now())
    this.setTimeoutFn = input.setTimeoutFn ?? setTimeout
    this.clearTimeoutFn = input.clearTimeoutFn ?? clearTimeout
  }

  noteActivityChanged(change: TrulyIdleActivityChange): void {
    for (const record of change.upsert ?? []) {
      const state = this.getOrCreate(record.terminalId)
      const nextBusy = isBusyPhase(record.phase)
      const nextPending = record.phase === 'pending'
      if (nextBusy) {
        // Direct busy→pending is a queued submit consumed at a turn clear
        // (codex re-arm) — the busy chain continues with a queued prompt.
        if (state.busy && !state.pending && nextPending) {
          state.sawQueueEvidence = true
        }
        this.cancelGrace(state)
      }
      state.busy = nextBusy
      state.pending = nextPending
    }
    for (const terminalId of change.remove ?? []) {
      const state = this.states.get(terminalId)
      if (!state) continue
      // Exit/crash (or an opencode idle removal): never emit from here — only
      // a subsequent turn boundary may re-arm.
      this.cancelGrace(state)
      this.states.delete(terminalId)
    }
  }

  noteTurnComplete(event: { terminalId: string; at: number }): void {
    const state = this.getOrCreate(event.terminalId)
    if (state.busy) {
      // Queued turn still pending (claude inFlight > 0): hold the bell until
      // the queue drains to a boundary that lands idle.
      state.sawQueueEvidence = true
      return
    }
    this.armGrace(event.terminalId, state)
  }

  /** Clear every armed grace timer (wiring dispose). */
  dispose(): void {
    for (const state of this.states.values()) {
      this.cancelGrace(state)
    }
    this.states.clear()
  }

  private getOrCreate(terminalId: string): TerminalIdleState {
    let state = this.states.get(terminalId)
    if (!state) {
      state = { busy: false, pending: false, sawQueueEvidence: false }
      this.states.set(terminalId, state)
    }
    return state
  }

  private armGrace(terminalId: string, state: TerminalIdleState): void {
    this.cancelGrace(state)
    const timer = this.setTimeoutFn(() => {
      this.handleGraceExpiry(terminalId)
    }, this.graceMs)
    // Never keep the event loop alive solely for a grace timer.
    ;(timer as unknown as { unref?: () => void }).unref?.()
    state.graceTimer = timer
  }

  private cancelGrace(state: TerminalIdleState): void {
    if (state.graceTimer !== undefined) {
      this.clearTimeoutFn(state.graceTimer)
      state.graceTimer = undefined
    }
  }

  private handleGraceExpiry(terminalId: string): void {
    const state = this.states.get(terminalId)
    if (!state) return
    state.graceTimer = undefined
    if (state.busy) return
    const reason: TrulyIdleReason = state.sawQueueEvidence ? 'queue-empty' : 'grace'
    state.sawQueueEvidence = false
    this.emit('idle', {
      terminalId,
      at: this.now(),
      reason,
    } satisfies TrulyIdleEvent)
  }
}

type TrulyIdleTrackerLike = {
  on(event: string, handler: (...args: any[]) => void): unknown
  off(event: string, handler: (...args: any[]) => void): unknown
}

/**
 * Wire a provider activity tracker's 'changed' + 'turn.complete' streams into
 * a TrulyIdleEmitter. Returns a dispose that detaches the listeners and clears
 * the emitter's timers.
 */
export function wireTrulyIdleEmitter(input: {
  tracker: TrulyIdleTrackerLike
  emitter: TrulyIdleEmitter
}): { dispose(): void } {
  const { tracker, emitter } = input
  const onChanged = (change: TrulyIdleActivityChange) => {
    emitter.noteActivityChanged(change)
  }
  const onTurnComplete = (event: { terminalId: string; at: number }) => {
    emitter.noteTurnComplete(event)
  }
  tracker.on('changed', onChanged)
  tracker.on('turn.complete', onTurnComplete)
  return {
    dispose(): void {
      tracker.off('changed', onChanged)
      tracker.off('turn.complete', onTurnComplete)
      emitter.dispose()
    },
  }
}
