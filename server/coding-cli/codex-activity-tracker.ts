import { EventEmitter } from 'events'
import {
  TURN_COMPLETE_SIGNAL,
  createTurnCompleteSignalParserState,
  extractTurnCompleteSignals,
  type TurnCompleteSignalParserState,
} from '../../shared/turn-complete-signal.js'
import type { SessionBindingReason } from '../terminal-stream/registry-events.js'
import type { CodingCliSession, ProjectGroup } from './types.js'

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
  parserState: TurnCompleteSignalParserState
}

export type CodexActivityChange = {
  upsert: CodexActivityRecord[]
  remove: string[]
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

const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f-\u009f]/
const ESC = '\x1b'
const C1_ST = '\x9c'
const C1_CSI = '\x9b'
const C1_DCS = '\x90'
const C1_OSC = '\x9d'

function isIgnorableLeadingTurnCompleteChar(ch: string): boolean {
  return ch !== TURN_COMPLETE_SIGNAL && (
    /\s/.test(ch)
    || CONTROL_CHAR_RE.test(ch)
  )
}

function countTrackerTurnCompleteSignals(
  data: string,
  state: TurnCompleteSignalParserState,
): number {
  let inOsc = state.inOsc
  let pendingEsc = state.pendingEsc
  let inCsi = state.inCsi
  let inDcs = state.inDcs
  let sawVisibleOutput = false
  const candidates: Array<{ leadingEligible: boolean; hasVisibleAfter: boolean }> = []

  const markVisibleOutput = () => {
    sawVisibleOutput = true
    for (const candidate of candidates) {
      candidate.hasVisibleAfter = true
    }
  }

  for (const ch of data) {
    if (pendingEsc) {
      if (inOsc && ch === '\\') {
        inOsc = false
      } else if (inDcs && ch === '\\') {
        inDcs = false
      } else if (!inOsc && !inDcs && ch === ']') {
        inOsc = true
      } else if (!inOsc && !inDcs && ch === '[') {
        inCsi = true
      } else if (!inOsc && !inDcs && ch === 'P') {
        inDcs = true
      }
      pendingEsc = false
      continue
    }

    if (ch === ESC) {
      pendingEsc = true
      continue
    }

    if (inOsc) {
      if (ch === TURN_COMPLETE_SIGNAL || ch === C1_ST) {
        inOsc = false
      }
      continue
    }

    if (inDcs) {
      if (ch === C1_ST) {
        inDcs = false
      }
      continue
    }

    if (inCsi) {
      if (ch >= '@' && ch <= '~') {
        inCsi = false
      }
      continue
    }

    if (ch === C1_CSI) {
      inCsi = true
      continue
    }
    if (ch === C1_DCS) {
      inDcs = true
      continue
    }
    if (ch === C1_OSC) {
      inOsc = true
      continue
    }
    if (ch === TURN_COMPLETE_SIGNAL) {
      candidates.push({
        leadingEligible: !sawVisibleOutput,
        hasVisibleAfter: false,
      })
      continue
    }
    if (isIgnorableLeadingTurnCompleteChar(ch)) {
      continue
    }
    markVisibleOutput()
  }

  return candidates.filter((candidate) => candidate.leadingEligible || !candidate.hasVisibleAfter).length
}

function isSubmitInput(data: string): boolean {
  return /^(?:\r\n|\r|\n)+$/.test(data)
}

export class CodexActivityTracker extends EventEmitter {
  private readonly states = new Map<string, CodexTerminalActivity>()

  list(): CodexActivityRecord[] {
    return Array.from(this.states.values()).map((state) => this.toRecord(state))
  }

  getActivity(terminalId: string): CodexTerminalActivity | undefined {
    return this.states.get(terminalId)
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

  noteExit(input: { terminalId: string; at: number }): void {
    void input.at
    this.removeState(input.terminalId)
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
          this.promoteBusy(state, nextStartedAt, at)
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
        this.transitionPendingAfterTurnClear(state, at)
      }

      if (
        clearedAt !== undefined
        && state.acceptedStartAt !== undefined
        && clearedAt >= state.acceptedStartAt
        && (state.phase === 'busy' || state.phase === 'unknown')
      ) {
        this.transitionAfterTurnClear(state, at)
      }

      this.commitState(state, previous)
    }
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

  private transitionAfterTurnClear(state: CodexTerminalActivity, at: number): void {
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
      return
    }
    state.phase = 'idle'
    state.pendingSubmitAt = undefined
    state.pendingFreshnessAt = undefined
    state.queuedSubmitAt = undefined
    state.pendingUntil = undefined
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

  private transitionPendingAfterTurnClear(state: CodexTerminalActivity, at: number): void {
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
      return
    }
    state.phase = 'idle'
    state.pendingSubmitAt = undefined
    state.pendingFreshnessAt = undefined
    state.pendingUntil = undefined
    state.queuedSubmitAt = undefined
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
        state.phase = 'busy'
        state.acceptedStartAt = maxDefined(state.acceptedStartAt, startedAt)
        state.latentAcceptedStartAt = undefined
        state.updatedAt = input.at
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

  private removeState(terminalId: string): void {
    const existing = this.states.get(terminalId)
    if (!existing) return
    this.states.delete(terminalId)
    this.emit('changed', { upsert: [], remove: [terminalId] } satisfies CodexActivityChange)
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
