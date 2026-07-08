import { EventEmitter } from 'events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { wireAmplifierActivityTracker } from '../../../../server/coding-cli/amplifier-activity-wiring'
import { AMPLIFIER_SUBMIT_GRACE_MS } from '../../../../server/coding-cli/amplifier-activity-tracker'

class FakeRegistry extends EventEmitter {
  records = new Map<string, { terminalId: string; mode: string; status: string }>()
  list() { return Array.from(this.records.values()).map((r) => ({ terminalId: r.terminalId })) }
  get(id: string) { return this.records.get(id) }
}

describe('wireAmplifierActivityTracker', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('tracks only amplifier terminals and drives provisional busy via PTY submit', () => {
    const registry = new FakeRegistry()
    const now = vi.fn(() => 1000)
    const { tracker, dispose } = wireAmplifierActivityTracker({
      registry: registry as any,
      now,
      setIntervalFn: (() => 0 as any),
      clearIntervalFn: (() => {}),
    })

    registry.emit('terminal.created', { terminalId: 'shell-1', mode: 'shell', status: 'running' })
    registry.emit('terminal.created', { terminalId: 'claude-1', mode: 'claude', status: 'running' })
    registry.emit('terminal.created', { terminalId: 't1', mode: 'amplifier', status: 'running' })
    // Neither the shell nor the claude terminal is tracked by the amplifier tracker.
    expect(tracker.getActivity('shell-1')).toBeUndefined()
    expect(tracker.getActivity('claude-1')).toBeUndefined()
    expect(tracker.getActivity('t1')?.phase).toBe('idle')

    registry.emit('terminal.input.raw', { terminalId: 't1', data: '\r', at: 2000 })
    expect(tracker.getActivity('t1')?.phase).toBe('busy')

    // Output only refreshes liveness; it never ends a turn.
    registry.emit('terminal.output.raw', { terminalId: 't1', data: 'thinking', at: 2500 })
    expect(tracker.getActivity('t1')?.phase).toBe('busy')

    // No prompt:submit record ever arrives (no events tailer in this test):
    // one force-read retry, then the submit-grace reverts silently to idle.
    vi.advanceTimersByTime(AMPLIFIER_SUBMIT_GRACE_MS * 2)
    expect(tracker.getActivity('t1')?.phase).toBe('idle')

    registry.emit('terminal.exit', { terminalId: 't1' })
    expect(tracker.getActivity('t1')).toBeUndefined()
    dispose()
  })

  it('ignores input/output for untracked (non-amplifier) terminals', () => {
    const registry = new FakeRegistry()
    const { tracker, dispose } = wireAmplifierActivityTracker({
      registry: registry as any,
      now: () => 1000,
      setIntervalFn: (() => 0 as any),
      clearIntervalFn: (() => {}),
    })
    registry.emit('terminal.input.raw', { terminalId: 'shell-1', data: '\r', at: 2000 })
    expect(tracker.getActivity('shell-1')).toBeUndefined()
    dispose()
  })

  it('rehydrates already-running amplifier terminals on startup', () => {
    const registry = new FakeRegistry()
    registry.records.set('t1', { terminalId: 't1', mode: 'amplifier', status: 'running' })
    const { tracker, dispose } = wireAmplifierActivityTracker({
      registry: registry as any,
      now: () => 1000,
      setIntervalFn: (() => 0 as any),
      clearIntervalFn: (() => {}),
    })
    expect(tracker.getActivity('t1')?.phase).toBe('idle')
    dispose()
  })

  it('binds sessionId from an amplifier terminal.session.bound event and ignores non-amplifier providers', () => {
    const registry = new FakeRegistry()
    const { tracker, dispose } = wireAmplifierActivityTracker({
      registry: registry as any,
      now: () => 1000,
      setIntervalFn: (() => 0 as any),
      clearIntervalFn: (() => {}),
    })

    registry.emit('terminal.created', { terminalId: 't1', mode: 'amplifier', status: 'running' })
    registry.emit('terminal.created', { terminalId: 't2', mode: 'amplifier', status: 'running' })

    // An amplifier-provider bound event flows through onBound -> tracker.bindSession.
    registry.emit('terminal.session.bound', { provider: 'amplifier', terminalId: 't1', sessionId: 's-1' })
    expect(tracker.getActivity('t1')?.sessionId).toBe('s-1')

    // A non-amplifier (claude) bound event is filtered out by onBound's provider guard.
    registry.emit('terminal.session.bound', { provider: 'claude', terminalId: 't2', sessionId: 's-2' })
    expect(tracker.getActivity('t2')?.sessionId).toBeUndefined()

    dispose()
  })

  it('records the session when terminal.session.bound fires BEFORE terminal.created (production order)', () => {
    const registry = new FakeRegistry()
    const { tracker, dispose } = wireAmplifierActivityTracker({
      registry: registry as any,
      now: () => 1000,
      setIntervalFn: (() => 0 as any),
      clearIntervalFn: (() => {}),
    })

    // Production emits 'terminal.session.bound' BEFORE 'terminal.created'. The wiring
    // must not lose the binding: the record should exist with its sessionId.
    registry.emit('terminal.session.bound', { provider: 'amplifier', terminalId: 't1', sessionId: 's-1' })
    expect(tracker.getActivity('t1')?.sessionId).toBe('s-1')

    // A later terminal.created for the same terminal does not clobber the binding.
    registry.emit('terminal.created', { terminalId: 't1', mode: 'amplifier', status: 'running' })
    expect(tracker.getActivity('t1')?.sessionId).toBe('s-1')
    expect(tracker.getActivity('t1')?.phase).toBe('idle')

    dispose()
  })
})
