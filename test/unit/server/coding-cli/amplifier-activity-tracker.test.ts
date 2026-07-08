import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AMPLIFIER_BUSY_DEADMAN_MS,
  AMPLIFIER_GRACE_REVERSION_SUSPECT_THRESHOLD,
  AMPLIFIER_SUBMIT_GRACE_MS,
  AmplifierActivityTracker,
  type AmplifierActivityChange,
  type AmplifierEventsForceReadRequest,
  type AmplifierTurnCompleteEvent,
} from '../../../../server/coding-cli/amplifier-activity-tracker'

function setup() {
  const tracker = new AmplifierActivityTracker()
  const changes: AmplifierActivityChange[] = []
  const completions: AmplifierTurnCompleteEvent[] = []
  tracker.on('changed', (c: AmplifierActivityChange) => changes.push(c))
  tracker.on('turn.complete', (e: AmplifierTurnCompleteEvent) => completions.push(e))
  return { tracker, changes, completions }
}

// ISO timestamp for an epoch-ms value (reducer effects carry ISO `at` strings).
function iso(ms: number): string {
  return new Date(ms).toISOString()
}

describe('AmplifierActivityTracker', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  // ---- PTY basics -----------------------------------------------------------

  it('starts idle on track and goes (provisionally) busy on submit', () => {
    const { tracker } = setup()
    tracker.trackTerminal({ terminalId: 't1', at: 1000 })
    expect(tracker.getActivity('t1')?.phase).toBe('idle')
    tracker.noteInput({ terminalId: 't1', data: '\r', at: 2000 })
    expect(tracker.getActivity('t1')?.phase).toBe('busy')
  })

  it('does not start a turn on multiline paste', () => {
    const { tracker } = setup()
    tracker.trackTerminal({ terminalId: 't1', at: 1000 })
    tracker.noteInput({ terminalId: 't1', data: 'line one\nline two', at: 2000 })
    expect(tracker.getActivity('t1')?.phase).toBe('idle')
  })

  it('removes state on exit and emits a removal', () => {
    const { tracker, changes } = setup()
    tracker.trackTerminal({ terminalId: 't1', at: 1000 })
    tracker.noteExit({ terminalId: 't1' })
    expect(tracker.getActivity('t1')).toBeUndefined()
    expect(changes.at(-1)).toEqual({ upsert: [], remove: ['t1'] })
  })

  it('list() reflects current records', () => {
    const { tracker } = setup()
    tracker.trackTerminal({ terminalId: 't1', at: 1000 })
    tracker.noteInput({ terminalId: 't1', data: '\r', at: 2000 })
    expect(tracker.list()).toEqual([{ terminalId: 't1', phase: 'busy', updatedAt: 2000 }])
  })

  it('attaches sessionId via bindSession', () => {
    const { tracker } = setup()
    tracker.trackTerminal({ terminalId: 't1', at: 1000 })
    tracker.bindSession({ terminalId: 't1', sessionId: 's-1', at: 1500 })
    expect(tracker.getActivity('t1')?.sessionId).toBe('s-1')
  })

  it('applyLifecycle/noteEventsSignalLost are safe no-ops for unknown terminals', () => {
    const { tracker, changes, completions } = setup()
    tracker.applyLifecycle('missing', { kind: 'turn.began', at: iso(1000) })
    tracker.noteEventsSignalLost('missing')
    expect(changes).toHaveLength(0)
    expect(completions).toHaveLength(0)
  })

  // ---- submit grace (provisional busy) --------------------------------------

  it('PTY submit is only provisionally busy: grace expiry force-reads once, then silently reverts', () => {
    const { tracker, changes, completions } = setup()
    const forceReads: AmplifierEventsForceReadRequest[] = []
    tracker.on('events.force-read', (request: AmplifierEventsForceReadRequest) => forceReads.push(request))
    tracker.trackTerminal({ terminalId: 't1', at: 1000 })
    tracker.noteInput({ terminalId: 't1', data: '\r', at: 2000 })
    expect(tracker.getActivity('t1')?.phase).toBe('busy')

    // First grace expiry: NOT a reversion yet — a silently-dead watcher (WSL2
    // inotify) may have swallowed the prompt:submit record, so request a
    // force-read and extend the grace once (adversarial finding D).
    vi.advanceTimersByTime(AMPLIFIER_SUBMIT_GRACE_MS)
    expect(tracker.getActivity('t1')?.phase).toBe('busy')
    expect(forceReads).toHaveLength(1)
    expect(forceReads[0]).toMatchObject({ terminalId: 't1' })

    // Second expiry with still no prompt:submit: silent reversion — NO
    // turn.complete (empty-Enter writes zero events, E5) — but the phase flip
    // is publicly visible.
    vi.advanceTimersByTime(AMPLIFIER_SUBMIT_GRACE_MS)
    expect(tracker.getActivity('t1')?.phase).toBe('idle')
    expect(completions).toHaveLength(0)
    expect(changes.at(-1)?.upsert[0]).toMatchObject({ terminalId: 't1', phase: 'idle' })
  })

  it('grace-expiry force-read that drains a prompt:submit confirms busy (watcher-dead backstop)', () => {
    const { tracker, completions } = setup()
    // Simulate the integration: the force-read drain surfaces the prompt:submit
    // record that the dead watcher never announced.
    tracker.on('events.force-read', () => {
      tracker.applyLifecycle('t1', { kind: 'turn.began', at: iso(2100) })
    })
    tracker.trackTerminal({ terminalId: 't1', at: 1000 })
    tracker.noteInput({ terminalId: 't1', data: '\r', at: 2000 })

    vi.advanceTimersByTime(AMPLIFIER_SUBMIT_GRACE_MS)
    // Confirmed busy from the drained records: no reversion, ever.
    vi.advanceTimersByTime(AMPLIFIER_SUBMIT_GRACE_MS * 5)
    expect(tracker.getActivity('t1')?.phase).toBe('busy')
    expect(completions).toHaveLength(0)
  })

  it('a session that never writes events.jsonl only ever shows grace-bounded busy pulses and no completions', () => {
    // Documented behavior for bundles without the hooks-logging module: no
    // events.jsonl ⇒ no confirmed busy, no turn.complete — ever.
    const { tracker, completions } = setup()
    tracker.trackTerminal({ terminalId: 't1', at: 1000 })
    for (let i = 0; i < 3; i += 1) {
      tracker.noteInput({ terminalId: 't1', data: '\r', at: 2000 + i * 10_000 })
      expect(tracker.getActivity('t1')?.phase).toBe('busy')
      tracker.noteOutput({ terminalId: 't1', data: 'echo + spinner', at: 2100 + i * 10_000 })
      // Force-read retry + silent reversion.
      vi.advanceTimersByTime(AMPLIFIER_SUBMIT_GRACE_MS * 2)
      expect(tracker.getActivity('t1')?.phase).toBe('idle')
    }
    expect(completions).toHaveLength(0)
    expect(tracker.listLatestCompletions()).toHaveLength(0)
  })

  it('three consecutive empty-Enter grace reversions log amplifier_events_lane_suspect once', () => {
    const warn = vi.fn()
    const tracker = new AmplifierActivityTracker({ log: { warn } })
    const completions: AmplifierTurnCompleteEvent[] = []
    tracker.on('turn.complete', (event: AmplifierTurnCompleteEvent) => completions.push(event))
    tracker.trackTerminal({ terminalId: 't1', at: 1000 })

    for (let i = 0; i < AMPLIFIER_GRACE_REVERSION_SUSPECT_THRESHOLD + 1; i += 1) {
      tracker.noteInput({ terminalId: 't1', data: '\r', at: 2000 + i * 10_000 })
      // Force-read retry + reversion.
      vi.advanceTimersByTime(AMPLIFIER_SUBMIT_GRACE_MS * 2)
      expect(tracker.getActivity('t1')?.phase).toBe('idle')
    }

    const suspectWarns = warn.mock.calls.filter(
      ([payload]) => (payload as any)?.event === 'amplifier_events_lane_suspect',
    )
    expect(suspectWarns).toHaveLength(1)
    expect(suspectWarns[0][0]).toMatchObject({ terminalId: 't1' })
    expect(completions).toHaveLength(0)
    // Log signal only — lifecycle effects keep working.
    tracker.applyLifecycle('t1', { kind: 'turn.began', at: iso(90_000) })
    expect(tracker.getActivity('t1')?.phase).toBe('busy')
  })

  // ---- events.jsonl lifecycle (the single source of turn boundaries) --------

  it('turn.began confirms the provisional busy and cancels the grace reversion', () => {
    const { tracker, completions } = setup()
    tracker.trackTerminal({ terminalId: 't1', at: 1000 })
    tracker.noteInput({ terminalId: 't1', data: '\r', at: 2000 })
    tracker.applyLifecycle('t1', { kind: 'turn.began', at: iso(2100) })

    vi.advanceTimersByTime(AMPLIFIER_SUBMIT_GRACE_MS * 3)
    expect(tracker.getActivity('t1')?.phase).toBe('busy')
    expect(completions).toHaveLength(0)
  })

  it('turn.completed ends the turn with exactly one completion and sequential completionSeq', () => {
    const { tracker, completions } = setup()
    tracker.trackTerminal({ terminalId: 't1', at: 1000 })
    tracker.bindSession({ terminalId: 't1', sessionId: 's-1', at: 1000 })

    tracker.applyLifecycle('t1', { kind: 'turn.began', at: iso(2000) })
    expect(tracker.getActivity('t1')?.phase).toBe('busy')
    tracker.applyLifecycle('t1', { kind: 'turn.completed', at: iso(5000) })
    expect(tracker.getActivity('t1')?.phase).toBe('idle')
    expect(completions).toHaveLength(1)
    expect(completions[0]).toMatchObject({ terminalId: 't1', sessionId: 's-1', at: 5000, completionSeq: 1 })
    expect(tracker.listLatestCompletions()).toEqual([{ terminalId: 't1', at: 5000, completionSeq: 1 }])

    // A turn.completed at idle is not a turn (reducer already gates this; the
    // tracker must not double-emit either).
    tracker.applyLifecycle('t1', { kind: 'turn.completed', at: iso(5100) })
    expect(completions).toHaveLength(1)

    tracker.applyLifecycle('t1', { kind: 'turn.began', at: iso(6000) })
    tracker.applyLifecycle('t1', { kind: 'turn.completed', at: iso(9000) })
    expect(completions.map((completion) => completion.completionSeq)).toEqual([1, 2])
  })

  it('emits sequential completions across PTY-submitted turns and carries the bound sessionId', () => {
    const { tracker, completions } = setup()
    tracker.trackTerminal({ terminalId: 't1', at: 1000 })
    tracker.bindSession({ terminalId: 't1', sessionId: 's-1', at: 1000 })
    // Turn 1: PTY submit → prompt:submit record confirms → prompt:complete ends.
    tracker.noteInput({ terminalId: 't1', data: '\r', at: 2000 })
    tracker.applyLifecycle('t1', { kind: 'turn.began', at: iso(2100) })
    tracker.applyLifecycle('t1', { kind: 'turn.completed', at: iso(4000) })
    expect(tracker.getActivity('t1')?.phase).toBe('idle')
    // Turn 2
    tracker.noteInput({ terminalId: 't1', data: '\r', at: 5000 })
    tracker.applyLifecycle('t1', { kind: 'turn.began', at: iso(5100) })
    tracker.applyLifecycle('t1', { kind: 'turn.completed', at: iso(7000) })
    expect(completions.map((completion) => completion.completionSeq)).toEqual([1, 2])
    expect(completions.every((completion) => completion.sessionId === 's-1')).toBe(true)
  })

  it('PTY output never ends a turn: a 10-minute silent busy stays busy with no fabricated completion', () => {
    const { tracker, completions } = setup()
    tracker.trackTerminal({ terminalId: 't1', at: 1000 })
    tracker.applyLifecycle('t1', { kind: 'turn.began', at: iso(2000) })
    tracker.noteOutput({ terminalId: 't1', data: 'spinner', at: 2500 })

    vi.advanceTimersByTime(10 * 60_000)
    expect(tracker.getActivity('t1')?.phase).toBe('busy')
    expect(completions).toHaveLength(0)
  })

  it('PTY submit during busy re-arms nothing (mid-turn steering stays in the same turn)', () => {
    const { tracker, completions } = setup()
    tracker.trackTerminal({ terminalId: 't1', at: 1000 })
    tracker.noteInput({ terminalId: 't1', data: '\r', at: 2000 })
    tracker.applyLifecycle('t1', { kind: 'turn.began', at: iso(2100) })

    // Steering Enter mid-turn: no new grace timer, no reversion, no completion.
    tracker.noteInput({ terminalId: 't1', data: '\r', at: 3000 })
    vi.advanceTimersByTime(AMPLIFIER_SUBMIT_GRACE_MS * 2)
    expect(tracker.getActivity('t1')?.phase).toBe('busy')
    expect(completions).toHaveLength(0)
  })

  it('session.identified updates the sessionId carried on later completions', () => {
    const { tracker, completions } = setup()
    tracker.trackTerminal({ terminalId: 't1', at: 1000 })
    tracker.applyLifecycle('t1', { kind: 'session.identified', sessionId: 's-9', cwd: '/work' })
    expect(tracker.getActivity('t1')?.sessionId).toBe('s-9')

    tracker.applyLifecycle('t1', { kind: 'turn.began', at: iso(2000) })
    tracker.applyLifecycle('t1', { kind: 'turn.completed', at: iso(3000) })
    expect(completions[0]).toMatchObject({ sessionId: 's-9', completionSeq: 1 })
  })

  // ---- deadman = force-read failsafe ONLY ------------------------------------

  it('deadman requests a force-read (logged once) and never fabricates a completion', () => {
    const warn = vi.fn()
    const tracker = new AmplifierActivityTracker({ log: { warn } })
    const completions: AmplifierTurnCompleteEvent[] = []
    const forceReads: AmplifierEventsForceReadRequest[] = []
    tracker.on('turn.complete', (event: AmplifierTurnCompleteEvent) => completions.push(event))
    tracker.on('events.force-read', (request: AmplifierEventsForceReadRequest) => forceReads.push(request))

    tracker.trackTerminal({ terminalId: 't1', sessionId: 's-1', at: 1000 })
    tracker.applyLifecycle('t1', { kind: 'turn.began', at: iso(2000) })

    const firstSweepAt = 2000 + AMPLIFIER_BUSY_DEADMAN_MS + 1
    tracker.expire(firstSweepAt)
    expect(forceReads).toEqual([{ terminalId: 't1', sessionId: 's-1', at: firstSweepAt }])
    expect(tracker.getActivity('t1')?.phase).toBe('busy')
    expect(completions).toHaveLength(0)

    // Every sweep past the deadman re-requests a force-read, but the warn is
    // logged only once per stuck-busy period.
    tracker.expire(firstSweepAt + 5000)
    expect(forceReads).toHaveLength(2)
    expect(completions).toHaveLength(0)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toMatchObject({ event: 'amplifier_activity_deadman_force_read', terminalId: 't1' })
  })

  it('output refreshes liveness so the deadman force-read does not fire on an active turn', () => {
    const { tracker } = setup()
    const forceReads: AmplifierEventsForceReadRequest[] = []
    tracker.on('events.force-read', (request: AmplifierEventsForceReadRequest) => forceReads.push(request))
    tracker.trackTerminal({ terminalId: 't1', at: 1000 })
    tracker.applyLifecycle('t1', { kind: 'turn.began', at: iso(2000) })
    tracker.noteOutput({ terminalId: 't1', data: 'progress', at: 2000 + AMPLIFIER_BUSY_DEADMAN_MS })
    tracker.expire(2000 + AMPLIFIER_BUSY_DEADMAN_MS + 1)
    expect(tracker.getActivity('t1')?.phase).toBe('busy')
    expect(forceReads).toHaveLength(0)
  })

  // ---- PTY exit ---------------------------------------------------------------

  it('PTY exit removes state unconditionally (authoritative end, no completion)', () => {
    const { tracker, changes, completions } = setup()
    tracker.trackTerminal({ terminalId: 't1', at: 1000 })
    tracker.applyLifecycle('t1', { kind: 'turn.began', at: iso(2000) })

    tracker.noteExit({ terminalId: 't1' })
    expect(tracker.getActivity('t1')).toBeUndefined()
    expect(changes.at(-1)).toEqual({ upsert: [], remove: ['t1'] })
    expect(completions).toHaveLength(0)
  })

  // ---- signal loss: idle-and-stop, never a timing fallback ---------------------

  it('noteEventsSignalLost mid-turn reverts to idle with NO turn.complete (visible phase change)', () => {
    const { tracker, changes, completions } = setup()
    tracker.trackTerminal({ terminalId: 't1', at: 1000 })
    tracker.noteInput({ terminalId: 't1', data: '\r', at: 2000 })
    tracker.applyLifecycle('t1', { kind: 'turn.began', at: iso(2100) })
    expect(tracker.getActivity('t1')?.phase).toBe('busy')

    tracker.noteEventsSignalLost('t1')
    expect(tracker.getActivity('t1')?.phase).toBe('idle')
    expect(completions).toHaveLength(0)
    expect(changes.at(-1)?.upsert[0]).toMatchObject({ terminalId: 't1', phase: 'idle' })

    // No timing heuristic takes over: output on the idle terminal does nothing,
    // and nothing ever completes the dropped turn.
    tracker.noteOutput({ terminalId: 't1', data: 'tail output', at: 5000 })
    vi.advanceTimersByTime(10 * 60_000)
    tracker.expire(10 * 60_000)
    expect(tracker.getActivity('t1')?.phase).toBe('idle')
    expect(completions).toHaveLength(0)
  })

  it('lane.degrade effect behaves as signal loss: idle silently, no completion', () => {
    const { tracker, completions } = setup()
    tracker.trackTerminal({ terminalId: 't1', at: 1000 })
    tracker.applyLifecycle('t1', { kind: 'turn.began', at: iso(2000) })
    tracker.applyLifecycle('t1', { kind: 'lane.degrade', reason: 'schema_version_unsupported' })

    expect(tracker.getActivity('t1')?.phase).toBe('idle')
    expect(completions).toHaveLength(0)
  })

  it('after signal loss the terminal only shows provisional busy pulses that revert silently', () => {
    const { tracker, completions } = setup()
    tracker.trackTerminal({ terminalId: 't1', at: 1000 })
    tracker.applyLifecycle('t1', { kind: 'turn.began', at: iso(2000) })
    tracker.noteEventsSignalLost('t1')
    expect(tracker.getActivity('t1')?.phase).toBe('idle')

    // Submit-grace pulse: busy, then (force-read retry, no-op) silent reversion.
    tracker.noteInput({ terminalId: 't1', data: '\r', at: 5000 })
    expect(tracker.getActivity('t1')?.phase).toBe('busy')
    vi.advanceTimersByTime(AMPLIFIER_SUBMIT_GRACE_MS * 2)
    expect(tracker.getActivity('t1')?.phase).toBe('idle')
    expect(completions).toHaveLength(0)
  })
})
