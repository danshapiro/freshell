import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AMPLIFIER_BUSY_DEADMAN_MS,
  AMPLIFIER_GRACE_REVERSION_SUSPECT_THRESHOLD,
  AMPLIFIER_IDLE_DEBOUNCE_MS,
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

describe('AmplifierActivityTracker', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts idle on track and goes busy on submit', () => {
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

  it('holds busy while output streams (each output restarts the idle-debounce)', () => {
    const { tracker, completions } = setup()
    tracker.trackTerminal({ terminalId: 't1', at: 1000 })
    tracker.noteInput({ terminalId: 't1', data: '\r', at: 2000 })
    tracker.noteOutput({ terminalId: 't1', data: 'thinking...', at: 2500 })
    expect(tracker.getActivity('t1')?.phase).toBe('busy')
    // Output arriving just before the debounce elapses restarts the timer.
    vi.advanceTimersByTime(AMPLIFIER_IDLE_DEBOUNCE_MS - 1)
    tracker.noteOutput({ terminalId: 't1', data: 'more', at: 4499 })
    vi.advanceTimersByTime(AMPLIFIER_IDLE_DEBOUNCE_MS - 1)
    expect(tracker.getActivity('t1')?.phase).toBe('busy')
    expect(completions).toHaveLength(0)
  })

  it('completes a turn on output-idle and emits exactly one turn.complete', () => {
    const { tracker, completions } = setup()
    tracker.trackTerminal({ terminalId: 't1', at: 1000 })
    tracker.noteInput({ terminalId: 't1', data: '\r', at: 2000 })
    tracker.noteOutput({ terminalId: 't1', data: 'thinking...', at: 2500 })
    expect(tracker.getActivity('t1')?.phase).toBe('busy')
    // AMPLIFIER_IDLE_DEBOUNCE_MS of silence after the last output ends the turn.
    vi.advanceTimersByTime(AMPLIFIER_IDLE_DEBOUNCE_MS)
    expect(tracker.getActivity('t1')?.phase).toBe('idle')
    expect(completions).toHaveLength(1)
    expect(completions[0]).toMatchObject({ terminalId: 't1', completionSeq: 1 })
    expect(tracker.listLatestCompletions()).toHaveLength(1)
    expect(tracker.listLatestCompletions()[0]).toMatchObject({ terminalId: 't1', completionSeq: 1 })
  })

  it('does not go idle before the first output arrives after a submit', () => {
    const { tracker, completions } = setup()
    tracker.trackTerminal({ terminalId: 't1', at: 1000 })
    tracker.noteInput({ terminalId: 't1', data: '\r', at: 2000 })
    // No output yet: the idle-debounce timer is never armed, so pre-first-token
    // latency (even well past the debounce) must NOT end the turn.
    vi.advanceTimersByTime(AMPLIFIER_IDLE_DEBOUNCE_MS * 5)
    expect(tracker.getActivity('t1')?.phase).toBe('busy')
    expect(completions).toHaveLength(0)
  })

  it('self-heals a stuck-busy terminal after the deadman and completes the turn', () => {
    const { tracker, completions } = setup()
    tracker.trackTerminal({ terminalId: 't1', at: 1000 })
    tracker.noteInput({ terminalId: 't1', data: '\r', at: 2000 })
    // No output ever arrives, so the idle-debounce timer is never armed. The deadman
    // sweep is the only failsafe end-of-turn and it also emits a completion.
    tracker.expire(2000 + AMPLIFIER_BUSY_DEADMAN_MS + 1)
    expect(tracker.getActivity('t1')?.phase).toBe('idle')
    expect(completions).toHaveLength(1)
    expect(completions[0]).toMatchObject({ terminalId: 't1', completionSeq: 1 })
  })

  it('output refreshes liveness so the deadman does not fire on an active turn', () => {
    const { tracker } = setup()
    tracker.trackTerminal({ terminalId: 't1', at: 1000 })
    tracker.noteInput({ terminalId: 't1', data: '\r', at: 2000 })
    tracker.noteOutput({ terminalId: 't1', data: 'progress', at: 2000 + AMPLIFIER_BUSY_DEADMAN_MS })
    tracker.expire(2000 + AMPLIFIER_BUSY_DEADMAN_MS + 1)
    expect(tracker.getActivity('t1')?.phase).toBe('busy')
  })

  it('emits sequential completions across turns and carries the bound sessionId', () => {
    const { tracker, completions } = setup()
    tracker.trackTerminal({ terminalId: 't1', at: 1000 })
    tracker.bindSession({ terminalId: 't1', sessionId: 's-1', at: 1000 })
    // Turn 1
    tracker.noteInput({ terminalId: 't1', data: '\r', at: 2000 })
    tracker.noteOutput({ terminalId: 't1', data: 'a', at: 2100 })
    vi.advanceTimersByTime(AMPLIFIER_IDLE_DEBOUNCE_MS)
    expect(tracker.getActivity('t1')?.phase).toBe('idle')
    // Turn 2
    tracker.noteInput({ terminalId: 't1', data: '\r', at: 5000 })
    tracker.noteOutput({ terminalId: 't1', data: 'b', at: 5100 })
    vi.advanceTimersByTime(AMPLIFIER_IDLE_DEBOUNCE_MS)
    expect(completions.map((completion) => completion.completionSeq)).toEqual([1, 2])
    expect(completions.every((completion) => completion.sessionId === 's-1')).toBe(true)
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
})

// ISO timestamp for an epoch-ms value (reducer effects carry ISO `at` strings).
function iso(ms: number): string {
  return new Date(ms).toISOString()
}

describe('AmplifierActivityTracker events lane', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('enableEventsLane/disableEventsLane/applyLifecycle are safe no-ops for unknown terminals', () => {
    const { tracker, changes, completions } = setup()
    tracker.enableEventsLane('missing')
    tracker.disableEventsLane('missing', 'read_error')
    tracker.applyLifecycle('missing', { kind: 'turn.began', at: iso(1000) })
    expect(changes).toHaveLength(0)
    expect(completions).toHaveLength(0)
  })

  it('PTY submit is only provisionally busy: grace expiry force-reads once, then silently reverts', () => {
    const { tracker, changes, completions } = setup()
    const forceReads: AmplifierEventsForceReadRequest[] = []
    tracker.on('events.force-read', (request: AmplifierEventsForceReadRequest) => forceReads.push(request))
    tracker.trackTerminal({ terminalId: 't1', at: 1000 })
    tracker.enableEventsLane('t1')
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
    tracker.enableEventsLane('t1')
    tracker.noteInput({ terminalId: 't1', data: '\r', at: 2000 })

    vi.advanceTimersByTime(AMPLIFIER_SUBMIT_GRACE_MS)
    // Confirmed busy from the drained records: no reversion, ever.
    vi.advanceTimersByTime(AMPLIFIER_SUBMIT_GRACE_MS * 5)
    expect(tracker.getActivity('t1')?.phase).toBe('busy')
    expect(completions).toHaveLength(0)
  })

  it('three consecutive empty-Enter grace reversions log amplifier_events_lane_suspect once, staying in the events lane', () => {
    const warn = vi.fn()
    const tracker = new AmplifierActivityTracker({ log: { warn } })
    const completions: AmplifierTurnCompleteEvent[] = []
    tracker.on('turn.complete', (event: AmplifierTurnCompleteEvent) => completions.push(event))
    tracker.trackTerminal({ terminalId: 't1', at: 1000 })
    tracker.enableEventsLane('t1')

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
    // Still the events lane (no auto-degrade — empty-Enters are legitimate):
    // lifecycle effects keep working.
    tracker.applyLifecycle('t1', { kind: 'turn.began', at: iso(90_000) })
    expect(tracker.getActivity('t1')?.phase).toBe('busy')
  })

  it('turn.began confirms the provisional busy and cancels the grace reversion', () => {
    const { tracker, completions } = setup()
    tracker.trackTerminal({ terminalId: 't1', at: 1000 })
    tracker.enableEventsLane('t1')
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
    tracker.enableEventsLane('t1')

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

  it('never arms the idle-debounce: a 10-minute silent busy stays busy with no fabricated completion', () => {
    const { tracker, completions } = setup()
    tracker.trackTerminal({ terminalId: 't1', at: 1000 })
    tracker.enableEventsLane('t1')
    tracker.applyLifecycle('t1', { kind: 'turn.began', at: iso(2000) })
    tracker.noteOutput({ terminalId: 't1', data: 'spinner', at: 2500 })

    vi.advanceTimersByTime(10 * 60_000)
    expect(tracker.getActivity('t1')?.phase).toBe('busy')
    expect(completions).toHaveLength(0)
  })

  it('PTY submit during busy re-arms nothing (mid-turn steering stays in the same turn)', () => {
    const { tracker, completions } = setup()
    tracker.trackTerminal({ terminalId: 't1', at: 1000 })
    tracker.enableEventsLane('t1')
    tracker.noteInput({ terminalId: 't1', data: '\r', at: 2000 })
    tracker.applyLifecycle('t1', { kind: 'turn.began', at: iso(2100) })

    // Steering Enter mid-turn: no new grace timer, no reversion, no completion.
    tracker.noteInput({ terminalId: 't1', data: '\r', at: 3000 })
    vi.advanceTimersByTime(AMPLIFIER_SUBMIT_GRACE_MS * 2)
    expect(tracker.getActivity('t1')?.phase).toBe('busy')
    expect(completions).toHaveLength(0)
  })

  it('deadman requests a force-read (logged once) and never fabricates a completion', () => {
    const warn = vi.fn()
    const tracker = new AmplifierActivityTracker({ log: { warn } })
    const completions: AmplifierTurnCompleteEvent[] = []
    const forceReads: AmplifierEventsForceReadRequest[] = []
    tracker.on('turn.complete', (event: AmplifierTurnCompleteEvent) => completions.push(event))
    tracker.on('events.force-read', (request: AmplifierEventsForceReadRequest) => forceReads.push(request))

    tracker.trackTerminal({ terminalId: 't1', sessionId: 's-1', at: 1000 })
    tracker.enableEventsLane('t1')
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

  it('PTY exit removes state unconditionally (authoritative end, no completion)', () => {
    const { tracker, changes, completions } = setup()
    tracker.trackTerminal({ terminalId: 't1', at: 1000 })
    tracker.enableEventsLane('t1')
    tracker.applyLifecycle('t1', { kind: 'turn.began', at: iso(2000) })

    tracker.noteExit({ terminalId: 't1' })
    expect(tracker.getActivity('t1')).toBeUndefined()
    expect(changes.at(-1)).toEqual({ upsert: [], remove: ['t1'] })
    expect(completions).toHaveLength(0)
  })

  it('session.identified updates the sessionId carried on later completions', () => {
    const { tracker, completions } = setup()
    tracker.trackTerminal({ terminalId: 't1', at: 1000 })
    tracker.enableEventsLane('t1')
    tracker.applyLifecycle('t1', { kind: 'session.identified', sessionId: 's-9', cwd: '/work' })
    expect(tracker.getActivity('t1')?.sessionId).toBe('s-9')

    tracker.applyLifecycle('t1', { kind: 'turn.began', at: iso(2000) })
    tracker.applyLifecycle('t1', { kind: 'turn.completed', at: iso(3000) })
    expect(completions[0]).toMatchObject({ sessionId: 's-9', completionSeq: 1 })
  })

  it('lane.degrade effect falls back to the degraded lane', () => {
    const { tracker, completions } = setup()
    tracker.trackTerminal({ terminalId: 't1', at: 1000 })
    tracker.enableEventsLane('t1')
    tracker.applyLifecycle('t1', { kind: 'turn.began', at: iso(2000) })
    tracker.applyLifecycle('t1', { kind: 'lane.degrade', reason: 'schema_version_unsupported' })

    // Degraded lane finishes the turn via output-idle timing.
    tracker.noteOutput({ terminalId: 't1', data: 'tail', at: 3000 })
    vi.advanceTimersByTime(AMPLIFIER_IDLE_DEBOUNCE_MS)
    expect(tracker.getActivity('t1')?.phase).toBe('idle')
    expect(completions).toHaveLength(1)
  })

  it('disableEventsLane mid-turn falls back to the timing lane which finishes the turn', () => {
    const { tracker, completions } = setup()
    tracker.trackTerminal({ terminalId: 't1', at: 1000 })
    tracker.enableEventsLane('t1')
    tracker.applyLifecycle('t1', { kind: 'turn.began', at: iso(2000) })
    expect(tracker.getActivity('t1')?.phase).toBe('busy')

    tracker.disableEventsLane('t1', 'read_error')
    // Timing lane semantics resume: first output arms the idle-debounce...
    tracker.noteOutput({ terminalId: 't1', data: 'output', at: 5000 })
    vi.advanceTimersByTime(AMPLIFIER_IDLE_DEBOUNCE_MS)
    expect(tracker.getActivity('t1')?.phase).toBe('idle')
    expect(completions).toHaveLength(1)
    expect(completions[0]).toMatchObject({ terminalId: 't1', completionSeq: 1 })
  })

  it('after disableEventsLane the degraded deadman fabricates the completion (verbatim behavior)', () => {
    const { tracker, completions } = setup()
    tracker.trackTerminal({ terminalId: 't1', at: 1000 })
    tracker.enableEventsLane('t1')
    tracker.applyLifecycle('t1', { kind: 'turn.began', at: iso(2000) })
    tracker.disableEventsLane('t1', 'file_reset')

    // No output ever arrives post-degrade: the degraded deadman is the failsafe
    // end again and it DOES emit the completion.
    tracker.expire(2000 + AMPLIFIER_BUSY_DEADMAN_MS + 1)
    expect(tracker.getActivity('t1')?.phase).toBe('idle')
    expect(completions).toHaveLength(1)
  })

  it('lifecycle effects are ignored while in the degraded lane', () => {
    const { tracker, completions } = setup()
    tracker.trackTerminal({ terminalId: 't1', at: 1000 })
    // Never enabled: still degraded.
    tracker.applyLifecycle('t1', { kind: 'turn.began', at: iso(2000) })
    expect(tracker.getActivity('t1')?.phase).toBe('idle')
    tracker.applyLifecycle('t1', { kind: 'turn.completed', at: iso(3000) })
    expect(completions).toHaveLength(0)
  })

  it('enableEventsLane while degraded-busy makes the busy provisional (grace reverts it silently)', () => {
    const { tracker, completions } = setup()
    tracker.trackTerminal({ terminalId: 't1', at: 1000 })
    vi.setSystemTime(2000)
    tracker.noteInput({ terminalId: 't1', data: '\r', at: 2000 })
    expect(tracker.getActivity('t1')?.phase).toBe('busy')

    tracker.enableEventsLane('t1')
    // One force-read retry, then the silent reversion (finding D backstop).
    vi.advanceTimersByTime(AMPLIFIER_SUBMIT_GRACE_MS * 2)
    expect(tracker.getActivity('t1')?.phase).toBe('idle')
    expect(completions).toHaveLength(0)
  })

  it('disableEventsLane mid-turn still honors a turn.completed already read during the transition (finding G)', () => {
    const { tracker, completions } = setup()
    tracker.trackTerminal({ terminalId: 't1', at: 1000 })
    tracker.enableEventsLane('t1')
    tracker.applyLifecycle('t1', { kind: 'turn.began', at: iso(2000) })
    expect(tracker.getActivity('t1')?.phase).toBe('busy')

    // Lane degrade races an in-flight read: the tailer had already pulled the
    // prompt:complete record off disk when the lane flipped. Honor it once.
    tracker.disableEventsLane('t1', 'read_error')
    tracker.applyLifecycle('t1', { kind: 'turn.completed', at: iso(5000) })
    expect(tracker.getActivity('t1')?.phase).toBe('idle')
    expect(completions).toHaveLength(1)
    expect(completions[0]).toMatchObject({ terminalId: 't1', at: 5000, completionSeq: 1 })

    // Only once: further lifecycle effects are ignored in the degraded lane.
    tracker.applyLifecycle('t1', { kind: 'turn.completed', at: iso(6000) })
    expect(completions).toHaveLength(1)
  })

  it('a new degraded-lane submit clears the transitional completion grant', () => {
    const { tracker, completions } = setup()
    tracker.trackTerminal({ terminalId: 't1', at: 1000 })
    tracker.enableEventsLane('t1')
    tracker.applyLifecycle('t1', { kind: 'turn.began', at: iso(2000) })
    tracker.disableEventsLane('t1', 'read_error')

    // A fresh degraded-lane turn starts: a stale lifecycle completion from the
    // dead events lane must NOT end it.
    tracker.noteInput({ terminalId: 't1', data: '\r', at: 3000 })
    tracker.applyLifecycle('t1', { kind: 'turn.completed', at: iso(3500) })
    expect(tracker.getActivity('t1')?.phase).toBe('busy')
    expect(completions).toHaveLength(0)
  })
})
