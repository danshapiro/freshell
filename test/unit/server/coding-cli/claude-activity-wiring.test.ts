import { EventEmitter } from 'events'
import { describe, expect, it, vi } from 'vitest'
import { wireClaudeActivityTracker } from '../../../../server/coding-cli/claude-activity-wiring'

class FakeRegistry extends EventEmitter {
  records = new Map<string, { terminalId: string; mode: string; status: string }>()
  list() { return Array.from(this.records.values()).map((r) => ({ terminalId: r.terminalId })) }
  get(id: string) { return this.records.get(id) }
}

describe('wireClaudeActivityTracker', () => {
  it('tracks only claude terminals and updates phase on submit + BEL', () => {
    const registry = new FakeRegistry()
    const now = vi.fn(() => 1000)
    const { tracker, dispose } = wireClaudeActivityTracker({
      registry: registry as any,
      now,
      setIntervalFn: (() => 0 as any),
      clearIntervalFn: (() => {}),
    })

    registry.emit('terminal.created', { terminalId: 'shell-1', mode: 'shell', status: 'running' })
    registry.emit('terminal.created', { terminalId: 't1', mode: 'claude', status: 'running' })
    expect(tracker.getActivity('shell-1')).toBeUndefined()
    expect(tracker.getActivity('t1')?.phase).toBe('idle')

    registry.emit('terminal.input.raw', { terminalId: 't1', data: '\r', at: 2000 })
    expect(tracker.getActivity('t1')?.phase).toBe('busy')

    registry.emit('terminal.output.raw', { terminalId: 't1', data: '\x07', at: 3000 })
    expect(tracker.getActivity('t1')?.phase).toBe('idle')

    registry.emit('terminal.exit', { terminalId: 't1' })
    expect(tracker.getActivity('t1')).toBeUndefined()
    dispose()
  })

  it('ignores input/output for untracked (non-claude) terminals', () => {
    const registry = new FakeRegistry()
    const { tracker, dispose } = wireClaudeActivityTracker({
      registry: registry as any,
      now: () => 1000,
      setIntervalFn: (() => 0 as any),
      clearIntervalFn: (() => {}),
    })
    registry.emit('terminal.input.raw', { terminalId: 'shell-1', data: '\r', at: 2000 })
    expect(tracker.getActivity('shell-1')).toBeUndefined()
    dispose()
  })

  it('rehydrates already-running claude terminals on startup', () => {
    const registry = new FakeRegistry()
    registry.records.set('t1', { terminalId: 't1', mode: 'claude', status: 'running' })
    const { tracker, dispose } = wireClaudeActivityTracker({
      registry: registry as any,
      now: () => 1000,
      setIntervalFn: (() => 0 as any),
      clearIntervalFn: (() => {}),
    })
    expect(tracker.getActivity('t1')?.phase).toBe('idle')
    dispose()
  })

  it('binds sessionId from a claude terminal.session.bound event and ignores non-claude providers', () => {
    const registry = new FakeRegistry()
    const { tracker, dispose } = wireClaudeActivityTracker({
      registry: registry as any,
      now: () => 1000,
      setIntervalFn: (() => 0 as any),
      clearIntervalFn: (() => {}),
    })

    registry.emit('terminal.created', { terminalId: 't1', mode: 'claude', status: 'running' })
    registry.emit('terminal.created', { terminalId: 't2', mode: 'claude', status: 'running' })

    // A claude-provider bound event flows through onBound -> tracker.bindSession.
    registry.emit('terminal.session.bound', { provider: 'claude', terminalId: 't1', sessionId: 's-1' })
    expect(tracker.getActivity('t1')?.sessionId).toBe('s-1')

    // A non-claude (codex) bound event is filtered out by onBound's provider guard.
    registry.emit('terminal.session.bound', { provider: 'codex', terminalId: 't2', sessionId: 's-2' })
    expect(tracker.getActivity('t2')?.sessionId).toBeUndefined()

    dispose()
  })
})
