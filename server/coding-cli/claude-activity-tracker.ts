import { EventEmitter } from 'events'
import {
  countTrackerTurnCompleteSignals,
  createTurnCompleteSignalParserState,
  extractTurnCompleteSignals,
  isSubmitInput,
  type TurnCompleteSignalParserState,
} from '../../shared/turn-complete-signal.js'
import type { TerminalTurnCompletionSnapshot } from '../../shared/ws-protocol.js'
import { TurnCompletionLedger } from './turn-completion-ledger.js'

export const CLAUDE_BUSY_DEADMAN_MS = 120_000
export const CLAUDE_ACTIVITY_SWEEP_MS = 5_000

export type ClaudeActivityPhase = 'idle' | 'busy'

export type ClaudeActivityRecord = {
  terminalId: string
  sessionId?: string
  phase: ClaudeActivityPhase
  updatedAt: number
}

export type ClaudeTurnCompleteEvent = {
  terminalId: string
  sessionId?: string
  at: number
  completionSeq: number
}

export type ClaudeActivityChange = {
  upsert: ClaudeActivityRecord[]
  remove: string[]
}

type TrackerLogger = {
  warn: (payload: object, message?: string) => void
}

type ClaudeTerminalActivity = {
  terminalId: string
  sessionId?: string
  phase: ClaudeActivityPhase
  updatedAt: number
  inFlight: number
  lastObservedAt: number
  lastSubmitAt?: number
  parserState: TurnCompleteSignalParserState
}

/**
 * Server-authoritative Claude turn lifecycle, keyed by terminalId.
 *
 * - A submit (whole-payload newline) increments in-flight turns and marks busy.
 * - A Stop-hook BEL (validated by countTrackerTurnCompleteSignals) decrements
 *   in-flight turns and, while a turn was actually in flight, emits one
 *   turn.complete. A BEL while idle is ignored (false-positive guard).
 * - A busy terminal silent past the deadman self-heals to idle (no completion
 *   event — it is a stuck recovery, not a real turn end).
 */
export class ClaudeActivityTracker extends EventEmitter {
  private readonly states = new Map<string, ClaudeTerminalActivity>()
  private readonly completionLedger = new TurnCompletionLedger()
  private readonly log?: TrackerLogger

  constructor(input: { log?: TrackerLogger } = {}) {
    super()
    this.log = input.log
  }

  list(): ClaudeActivityRecord[] {
    return Array.from(this.states.values()).map((state) => this.toRecord(state))
  }

  getActivity(terminalId: string): ClaudeActivityRecord | undefined {
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
    const state: ClaudeTerminalActivity = {
      terminalId: input.terminalId,
      sessionId: input.sessionId,
      phase: 'idle',
      updatedAt: input.at,
      inFlight: 0,
      lastObservedAt: input.at,
      parserState: createTurnCompleteSignalParserState(),
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

  noteInput(input: { terminalId: string; data: string; at: number }): void {
    const state = this.states.get(input.terminalId)
    if (!state) return
    if (!isSubmitInput(input.data)) return
    const previous = this.toRecord(state)
    state.inFlight += 1
    state.lastSubmitAt = input.at
    state.lastObservedAt = input.at
    if (state.phase !== 'busy') {
      state.phase = 'busy'
      state.updatedAt = input.at
    }
    this.commitState(state, previous)
  }

  noteOutput(input: { terminalId: string; data: string; at: number }): void {
    const state = this.states.get(input.terminalId)
    if (!state) return

    const parserStateAtStart = { ...state.parserState }
    const { count } = extractTurnCompleteSignals(input.data, 'claude', state.parserState)
    if (count <= 0) {
      if (state.phase === 'busy') state.lastObservedAt = input.at
      return
    }
    const trackerCount = countTrackerTurnCompleteSignals(input.data, parserStateAtStart)
    const clearCount = Math.min(count, trackerCount)
    if (clearCount <= 0) {
      if (state.phase === 'busy') state.lastObservedAt = input.at
      return
    }

    const previous = this.toRecord(state)
    const completions: ClaudeTurnCompleteEvent[] = []
    for (let i = 0; i < clearCount; i += 1) {
      if (state.inFlight <= 0) break
      state.inFlight -= 1
      completions.push(this.completionLedger.recordTurnCompletion({
        terminalId: state.terminalId,
        ...(state.sessionId ? { sessionId: state.sessionId } : {}),
        at: input.at,
      }))
    }
    state.lastObservedAt = input.at
    if (completions.length > 0) {
      state.phase = state.inFlight > 0 ? 'busy' : 'idle'
      state.updatedAt = input.at
    }
    this.commitState(state, previous)
    for (const completion of completions) {
      this.emit('turn.complete', completion)
    }
  }

  noteExit(input: { terminalId: string }): void {
    this.removeState(input.terminalId)
  }

  expire(at: number): void {
    for (const state of this.states.values()) {
      if (state.phase !== 'busy') continue
      const idleAgeMs = at - state.lastObservedAt
      if (idleAgeMs <= CLAUDE_BUSY_DEADMAN_MS) continue
      const previous = this.toRecord(state)
      state.phase = 'idle'
      state.inFlight = 0
      state.updatedAt = at
      state.lastObservedAt = at
      this.log?.warn({
        component: 'claude-activity-tracker',
        event: 'claude_activity_deadman',
        terminalId: state.terminalId,
        ageMs: idleAgeMs,
      }, 'Claude terminal stuck busy past deadman; clearing to idle.')
      this.commitState(state, previous)
    }
  }

  private commitState(state: ClaudeTerminalActivity, previous: ClaudeActivityRecord | undefined): void {
    this.states.set(state.terminalId, state)
    const next = this.toRecord(state)
    if (!this.hasPublicChange(previous, next)) return
    this.emit('changed', { upsert: [next], remove: [] } satisfies ClaudeActivityChange)
  }

  private removeState(terminalId: string): void {
    if (!this.states.delete(terminalId)) return
    this.emit('changed', { upsert: [], remove: [terminalId] } satisfies ClaudeActivityChange)
  }

  private toRecord(state: ClaudeTerminalActivity): ClaudeActivityRecord {
    return {
      terminalId: state.terminalId,
      ...(state.sessionId ? { sessionId: state.sessionId } : {}),
      phase: state.phase,
      updatedAt: state.updatedAt,
    }
  }

  private hasPublicChange(previous: ClaudeActivityRecord | undefined, next: ClaudeActivityRecord): boolean {
    if (!previous) return true
    return previous.phase !== next.phase || previous.sessionId !== next.sessionId
  }
}
