import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  TERMINAL_IDLE_GRACE_MS,
  TrulyIdleEmitter,
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

  it('never emits after a crash/exit (activity remove), even with a grace timer armed', () => {
    emitter.noteActivityChanged({ upsert: [{ terminalId: 't1', phase: 'busy' }], remove: [] })
    emitter.noteActivityChanged({ upsert: [{ terminalId: 't1', phase: 'idle' }], remove: [] })
    emitter.noteTurnComplete({ terminalId: 't1', at: Date.now() })
    // PTY exit lands inside the grace window.
    emitter.noteActivityChanged({ upsert: [], remove: ['t1'] })
    vi.advanceTimersByTime(TERMINAL_IDLE_GRACE_MS * 3)
    expect(events).toHaveLength(0)
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
