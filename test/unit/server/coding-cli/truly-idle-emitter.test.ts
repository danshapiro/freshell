import { EventEmitter } from 'events'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  TERMINAL_IDLE_GRACE_MS,
  TrulyIdleEmitter,
  wireTrulyIdleEmitter,
  type TrulyIdleEvent,
} from '../../../../server/coding-cli/truly-idle-emitter.js'

describe('TrulyIdleEmitter', () => {
  let emitter: TrulyIdleEmitter
  let events: TrulyIdleEvent[]

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-23T12:00:00Z'))
    emitter = new TrulyIdleEmitter()
    events = []
    emitter.on('idle', (event: TrulyIdleEvent) => events.push(event))
  })

  afterEach(() => {
    emitter.dispose()
    vi.useRealTimers()
  })

  it('pins the shared grace default at 2000ms', () => {
    expect(TERMINAL_IDLE_GRACE_MS).toBe(2000)
  })

  it('emits exactly one terminal.idle (reason grace) after a quiet grace window following a turn end', () => {
    emitter.noteActivityChanged({ upsert: [{ terminalId: 't1', phase: 'busy' }], remove: [] })
    emitter.noteActivityChanged({ upsert: [{ terminalId: 't1', phase: 'idle' }], remove: [] })
    emitter.noteTurnComplete({ terminalId: 't1', at: Date.now() })

    vi.advanceTimersByTime(TERMINAL_IDLE_GRACE_MS - 1)
    expect(events).toHaveLength(0)

    vi.advanceTimersByTime(1)
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({
      terminalId: 't1',
      at: Date.now(),
      reason: 'grace',
    })

    // One-shot: nothing further without a new turn boundary.
    vi.advanceTimersByTime(TERMINAL_IDLE_GRACE_MS * 5)
    expect(events).toHaveLength(1)
  })

  it('suppresses the bell between back-to-back turns and emits once at the very end', () => {
    // Turn 1 ends...
    emitter.noteActivityChanged({ upsert: [{ terminalId: 't1', phase: 'busy' }], remove: [] })
    emitter.noteActivityChanged({ upsert: [{ terminalId: 't1', phase: 'idle' }], remove: [] })
    emitter.noteTurnComplete({ terminalId: 't1', at: Date.now() })

    // ...but a new turn starts inside the grace window (new session-file activity).
    vi.advanceTimersByTime(500)
    emitter.noteActivityChanged({ upsert: [{ terminalId: 't1', phase: 'busy' }], remove: [] })
    vi.advanceTimersByTime(TERMINAL_IDLE_GRACE_MS * 3)
    expect(events).toHaveLength(0)

    // Turn 2 ends and stays quiet.
    emitter.noteActivityChanged({ upsert: [{ terminalId: 't1', phase: 'idle' }], remove: [] })
    emitter.noteTurnComplete({ terminalId: 't1', at: Date.now() })
    vi.advanceTimersByTime(TERMINAL_IDLE_GRACE_MS)
    expect(events).toHaveLength(1)
    expect(events[0].reason).toBe('grace')
  })

  it('holds the bell while a queued prompt keeps the terminal busy, then emits queue-empty after the queue drains', () => {
    // Claude-style: turn 1 completes while phase stays busy (inFlight > 0 -> queued turn pending).
    emitter.noteActivityChanged({ upsert: [{ terminalId: 't1', phase: 'busy' }], remove: [] })
    emitter.noteTurnComplete({ terminalId: 't1', at: Date.now() })
    vi.advanceTimersByTime(TERMINAL_IDLE_GRACE_MS * 3)
    expect(events).toHaveLength(0)

    // Final queued turn drains: phase flips idle, then the completion lands.
    emitter.noteActivityChanged({ upsert: [{ terminalId: 't1', phase: 'idle' }], remove: [] })
    emitter.noteTurnComplete({ terminalId: 't1', at: Date.now() })
    vi.advanceTimersByTime(TERMINAL_IDLE_GRACE_MS)
    expect(events).toHaveLength(1)
    expect(events[0].reason).toBe('queue-empty')
  })

  it('treats a codex busy->pending re-arm as queue evidence', () => {
    emitter.noteActivityChanged({ upsert: [{ terminalId: 't1', phase: 'busy' }], remove: [] })
    // Queued submit consumed at turn clear: tracker re-arms to pending (still busy, no completion).
    emitter.noteActivityChanged({ upsert: [{ terminalId: 't1', phase: 'pending' }], remove: [] })
    emitter.noteActivityChanged({ upsert: [{ terminalId: 't1', phase: 'busy' }], remove: [] })
    vi.advanceTimersByTime(TERMINAL_IDLE_GRACE_MS * 3)
    expect(events).toHaveLength(0)

    emitter.noteActivityChanged({ upsert: [{ terminalId: 't1', phase: 'idle' }], remove: [] })
    emitter.noteTurnComplete({ terminalId: 't1', at: Date.now() })
    vi.advanceTimersByTime(TERMINAL_IDLE_GRACE_MS)
    expect(events).toHaveLength(1)
    expect(events[0].reason).toBe('queue-empty')
  })

  it('does not count an initial idle->pending submit as queue evidence', () => {
    emitter.noteActivityChanged({ upsert: [{ terminalId: 't1', phase: 'pending' }], remove: [] })
    emitter.noteActivityChanged({ upsert: [{ terminalId: 't1', phase: 'busy' }], remove: [] })
    emitter.noteActivityChanged({ upsert: [{ terminalId: 't1', phase: 'idle' }], remove: [] })
    emitter.noteTurnComplete({ terminalId: 't1', at: Date.now() })
    vi.advanceTimersByTime(TERMINAL_IDLE_GRACE_MS)
    expect(events).toHaveLength(1)
    expect(events[0].reason).toBe('grace')
  })

  it('never emits after a REQUESTED close (activity remove without spontaneousExitRemovals), even with a grace timer armed', () => {
    // Scoped to requested removals (tab close / terminal.close / shutdown):
    // spontaneous exits while engaged now ring immediately (see below).
    emitter.noteActivityChanged({ upsert: [{ terminalId: 't1', phase: 'busy' }], remove: [] })
    emitter.noteActivityChanged({ upsert: [{ terminalId: 't1', phase: 'idle' }], remove: [] })
    emitter.noteTurnComplete({ terminalId: 't1', at: Date.now() })
    // Requested close lands inside the grace window.
    emitter.noteActivityChanged({ upsert: [], remove: ['t1'] })
    vi.advanceTimersByTime(TERMINAL_IDLE_GRACE_MS * 3)
    expect(events).toHaveLength(0)
  })

  it('emits terminal.idle immediately when a busy terminal is removed by a spontaneous exit', () => {
    emitter.noteActivityChanged({ upsert: [{ terminalId: 't1', phase: 'busy' }], remove: [] })
    emitter.noteActivityChanged({ upsert: [], remove: ['t1'], spontaneousExitRemovals: ['t1'] })

    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({ terminalId: 't1', at: Date.now(), reason: 'grace' })
    // Immediate edge — no timer left pending, nothing further.
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(TERMINAL_IDLE_GRACE_MS * 3)
    expect(events).toHaveLength(1)
  })

  it('stays silent when a busy terminal is removed by a requested close', () => {
    emitter.noteActivityChanged({ upsert: [{ terminalId: 't1', phase: 'busy' }], remove: [] })
    emitter.noteActivityChanged({ upsert: [], remove: ['t1'] })
    vi.advanceTimersByTime(TERMINAL_IDLE_GRACE_MS * 3)
    expect(events).toHaveLength(0)
  })

  it('stays silent when an idle terminal exits spontaneously', () => {
    emitter.noteActivityChanged({ upsert: [{ terminalId: 't1', phase: 'idle' }], remove: [] })
    emitter.noteActivityChanged({ upsert: [], remove: ['t1'], spontaneousExitRemovals: ['t1'] })
    vi.advanceTimersByTime(TERMINAL_IDLE_GRACE_MS * 3)
    expect(events).toHaveLength(0)
  })

  it('stays silent when an input-pending terminal exits spontaneously (slash-command quit)', () => {
    // decision 3 / audit A6: /quit typed into an idle pane arrives as phase
    // 'pending' (the executing Enter looks like a prompt submit) — input-only
    // pending is never engagement.
    emitter.noteActivityChanged({ upsert: [{ terminalId: 't1', phase: 'pending' }], remove: [] })
    emitter.noteActivityChanged({ upsert: [], remove: ['t1'], spontaneousExitRemovals: ['t1'] })
    vi.advanceTimersByTime(TERMINAL_IDLE_GRACE_MS * 3)
    expect(events).toHaveLength(0)
  })

  it('rings when a spontaneous exit lands during an armed grace window', () => {
    // busy → turn complete (arms grace) → spontaneous removal before expiry:
    // the pending bell survives death.
    emitter.noteActivityChanged({ upsert: [{ terminalId: 't1', phase: 'busy' }], remove: [] })
    emitter.noteActivityChanged({ upsert: [{ terminalId: 't1', phase: 'idle' }], remove: [] })
    emitter.noteTurnComplete({ terminalId: 't1', at: Date.now() })
    vi.advanceTimersByTime(TERMINAL_IDLE_GRACE_MS - 500)
    emitter.noteActivityChanged({ upsert: [], remove: ['t1'], spontaneousExitRemovals: ['t1'] })

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ terminalId: 't1', reason: 'grace' })
    vi.advanceTimersByTime(TERMINAL_IDLE_GRACE_MS * 3)
    expect(events).toHaveLength(1)
  })

  it('queue evidence does not suppress the death bell', () => {
    emitter.noteActivityChanged({ upsert: [{ terminalId: 't1', phase: 'busy' }], remove: [] })
    // Turn boundary while busy = queued turn evidence.
    emitter.noteTurnComplete({ terminalId: 't1', at: Date.now() })
    emitter.noteActivityChanged({ upsert: [], remove: ['t1'], spontaneousExitRemovals: ['t1'] })

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ terminalId: 't1', reason: 'grace' })
  })

  it('never emits on a deadman/signal-loss idle flip (phase idle without a turn boundary)', () => {
    emitter.noteActivityChanged({ upsert: [{ terminalId: 't1', phase: 'busy' }], remove: [] })
    emitter.noteActivityChanged({ upsert: [{ terminalId: 't1', phase: 'idle' }], remove: [] })
    vi.advanceTimersByTime(TERMINAL_IDLE_GRACE_MS * 3)
    expect(events).toHaveLength(0)
  })

  it('never emits on a codex busy->unknown deadman flip', () => {
    emitter.noteActivityChanged({ upsert: [{ terminalId: 't1', phase: 'busy' }], remove: [] })
    emitter.noteActivityChanged({ upsert: [{ terminalId: 't1', phase: 'unknown' }], remove: [] })
    vi.advanceTimersByTime(TERMINAL_IDLE_GRACE_MS * 3)
    expect(events).toHaveLength(0)
  })

  it('arms from a turn.complete that follows an opencode-style activity remove (idle = record removed)', () => {
    emitter.noteActivityChanged({ upsert: [{ terminalId: 't1', phase: 'busy' }], remove: [] })
    // OpenCode reducer emits activityRemove then turnComplete for a genuine turn end.
    emitter.noteActivityChanged({ upsert: [], remove: ['t1'] })
    emitter.noteTurnComplete({ terminalId: 't1', at: Date.now() })
    vi.advanceTimersByTime(TERMINAL_IDLE_GRACE_MS)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ terminalId: 't1', reason: 'grace' })
  })

  it('re-arms (single emit) when a second turn.complete lands while the grace timer is armed', () => {
    emitter.noteActivityChanged({ upsert: [{ terminalId: 't1', phase: 'idle' }], remove: [] })
    emitter.noteTurnComplete({ terminalId: 't1', at: Date.now() })
    vi.advanceTimersByTime(TERMINAL_IDLE_GRACE_MS - 500)
    emitter.noteTurnComplete({ terminalId: 't1', at: Date.now() })

    // The original deadline passes without an emit (timer was re-armed)...
    vi.advanceTimersByTime(500)
    expect(events).toHaveLength(0)

    // ...and the re-armed window emits exactly once.
    vi.advanceTimersByTime(TERMINAL_IDLE_GRACE_MS - 500)
    expect(events).toHaveLength(1)
  })

  it('tracks terminals independently', () => {
    emitter.noteActivityChanged({
      upsert: [
        { terminalId: 't1', phase: 'idle' },
        { terminalId: 't2', phase: 'busy' },
      ],
      remove: [],
    })
    emitter.noteTurnComplete({ terminalId: 't1', at: Date.now() })
    vi.advanceTimersByTime(TERMINAL_IDLE_GRACE_MS)
    expect(events).toHaveLength(1)
    expect(events[0].terminalId).toBe('t1')
  })

  it('stamps at with the server clock at emit time', () => {
    emitter.noteActivityChanged({ upsert: [{ terminalId: 't1', phase: 'idle' }], remove: [] })
    const turnEndAt = Date.now()
    emitter.noteTurnComplete({ terminalId: 't1', at: turnEndAt })
    vi.advanceTimersByTime(TERMINAL_IDLE_GRACE_MS)
    expect(events[0].at).toBe(turnEndAt + TERMINAL_IDLE_GRACE_MS)
  })

  it('resets queue evidence after each emit', () => {
    // Queue evidence in the first busy period...
    emitter.noteActivityChanged({ upsert: [{ terminalId: 't1', phase: 'busy' }], remove: [] })
    emitter.noteTurnComplete({ terminalId: 't1', at: Date.now() })
    emitter.noteActivityChanged({ upsert: [{ terminalId: 't1', phase: 'idle' }], remove: [] })
    emitter.noteTurnComplete({ terminalId: 't1', at: Date.now() })
    vi.advanceTimersByTime(TERMINAL_IDLE_GRACE_MS)
    expect(events).toHaveLength(1)
    expect(events[0].reason).toBe('queue-empty')

    // ...must not leak into the next simple turn.
    emitter.noteActivityChanged({ upsert: [{ terminalId: 't1', phase: 'busy' }], remove: [] })
    emitter.noteActivityChanged({ upsert: [{ terminalId: 't1', phase: 'idle' }], remove: [] })
    emitter.noteTurnComplete({ terminalId: 't1', at: Date.now() })
    vi.advanceTimersByTime(TERMINAL_IDLE_GRACE_MS)
    expect(events).toHaveLength(2)
    expect(events[1].reason).toBe('grace')
  })

  it('dispose cancels every armed timer', () => {
    emitter.noteActivityChanged({ upsert: [{ terminalId: 't1', phase: 'idle' }], remove: [] })
    emitter.noteTurnComplete({ terminalId: 't1', at: Date.now() })
    emitter.dispose()
    vi.advanceTimersByTime(TERMINAL_IDLE_GRACE_MS * 3)
    expect(events).toHaveLength(0)
  })
})

describe('approval pause bell (Task 12)', () => {
  let emitter: TrulyIdleEmitter
  let events: TrulyIdleEvent[]

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-23T12:00:00Z'))
    emitter = new TrulyIdleEmitter()
    events = []
    emitter.on('idle', (event: TrulyIdleEvent) => events.push(event))
  })

  afterEach(() => {
    emitter.dispose()
    vi.useRealTimers()
  })

  it('an attention.boundary bridged through the wiring arms the grace window and rings once', () => {
    const tracker = new EventEmitter()
    const wiring = wireTrulyIdleEmitter({ tracker, emitter })
    tracker.emit('changed', { upsert: [{ terminalId: 't1', phase: 'busy' }], remove: [] })
    // Approval pause: the tracker demotes to idle, then arms the boundary.
    tracker.emit('changed', { upsert: [{ terminalId: 't1', phase: 'idle' }], remove: [] })
    tracker.emit('attention.boundary', { terminalId: 't1', at: Date.now() })

    vi.advanceTimersByTime(TERMINAL_IDLE_GRACE_MS)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ terminalId: 't1', reason: 'grace' })
    wiring.dispose()
  })

  it('a busy upsert within the grace (the resolve path) cancels the approval bell', () => {
    const tracker = new EventEmitter()
    const wiring = wireTrulyIdleEmitter({ tracker, emitter })
    tracker.emit('changed', { upsert: [{ terminalId: 't1', phase: 'busy' }], remove: [] })
    tracker.emit('changed', { upsert: [{ terminalId: 't1', phase: 'idle' }], remove: [] })
    tracker.emit('attention.boundary', { terminalId: 't1', at: Date.now() })

    vi.advanceTimersByTime(500)
    tracker.emit('changed', { upsert: [{ terminalId: 't1', phase: 'busy' }], remove: [] })
    vi.advanceTimersByTime(TERMINAL_IDLE_GRACE_MS * 3)
    expect(events).toHaveLength(0)
    wiring.dispose()
  })

  it('dispose detaches the attention.boundary bridge', () => {
    const tracker = new EventEmitter()
    const wiring = wireTrulyIdleEmitter({ tracker, emitter })
    wiring.dispose()
    expect(tracker.listenerCount('attention.boundary')).toBe(0)
    tracker.emit('attention.boundary', { terminalId: 't1', at: Date.now() })
    vi.advanceTimersByTime(TERMINAL_IDLE_GRACE_MS * 3)
    expect(events).toHaveLength(0)
  })

  it('a spontaneous removal carrying approvalPendingRemovals rings even when not busy and no timer is armed', () => {
    // The approval bell already rang (busy=false, grace spent) -- the pane was
    // still blocked on a human when its process died.
    emitter.noteActivityChanged({ upsert: [{ terminalId: 't1', phase: 'idle' }], remove: [] })
    emitter.noteActivityChanged({
      upsert: [],
      remove: ['t1'],
      spontaneousExitRemovals: ['t1'],
      approvalPendingRemovals: ['t1'],
    })

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ terminalId: 't1', reason: 'grace' })
    vi.advanceTimersByTime(TERMINAL_IDLE_GRACE_MS * 3)
    expect(events).toHaveLength(1)
  })

  it('a REQUESTED close of an approval-blocked pane stays silent (no spontaneous exit)', () => {
    emitter.noteActivityChanged({ upsert: [{ terminalId: 't1', phase: 'idle' }], remove: [] })
    emitter.noteActivityChanged({
      upsert: [],
      remove: ['t1'],
      approvalPendingRemovals: ['t1'],
    })
    vi.advanceTimersByTime(TERMINAL_IDLE_GRACE_MS * 3)
    expect(events).toHaveLength(0)
  })
})
