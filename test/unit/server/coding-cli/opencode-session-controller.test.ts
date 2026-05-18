import { EventEmitter } from 'events'
import { describe, expect, it, vi } from 'vitest'
import { OpencodeSessionController } from '../../../../server/coding-cli/opencode-session-controller'

class FakeTracker extends EventEmitter {
  confirmSessionAssociation = vi.fn()
  rejectSessionAssociation = vi.fn()
}

function makeRegistry(input: {
  get?: ReturnType<typeof vi.fn>
  bindSession?: ReturnType<typeof vi.fn>
} = {}) {
  return {
    get: input.get ?? vi.fn(() => ({
      terminalId: 'term-1',
      mode: 'opencode',
      status: 'running',
      resumeSessionId: undefined,
    })),
    bindSession: input.bindSession ?? vi.fn(() => ({
      ok: true as const,
      terminalId: 'term-1',
      sessionId: 'session-1',
    })),
    rebindSession: vi.fn(() => {
      throw new Error('rebindSession must not be used for OpenCode control-plane adoption')
    }),
    on: vi.fn(),
    off: vi.fn(),
  }
}

describe('OpencodeSessionController', () => {
  it('uses non-stealing bindSession and confirms successful association requests', () => {
    const tracker = new FakeTracker()
    const registry = makeRegistry()
    const associated = vi.fn()
    const controller = new OpencodeSessionController({
      tracker: tracker as any,
      registry: registry as any,
    })
    controller.on('associated', associated)

    tracker.emit('association.requested', {
      terminalId: 'term-1',
      sessionId: 'session-1',
    })

    expect(registry.bindSession).toHaveBeenCalledWith('term-1', 'opencode', 'session-1', 'association')
    expect(registry.rebindSession).not.toHaveBeenCalled()
    expect(tracker.confirmSessionAssociation).toHaveBeenCalledWith({
      terminalId: 'term-1',
      sessionId: 'session-1',
    })
    expect(tracker.rejectSessionAssociation).not.toHaveBeenCalled()
    expect(associated).toHaveBeenCalledWith({
      terminalId: 'term-1',
      sessionId: 'session-1',
    })

    controller.dispose()
  })

  it('does not repeat binding or association emission for the same terminal/session pair', () => {
    const tracker = new FakeTracker()
    const registry = makeRegistry()
    const associated = vi.fn()
    const controller = new OpencodeSessionController({
      tracker: tracker as any,
      registry: registry as any,
    })
    controller.on('associated', associated)

    tracker.emit('association.requested', {
      terminalId: 'term-1',
      sessionId: 'session-1',
    })
    tracker.emit('association.requested', {
      terminalId: 'term-1',
      sessionId: 'session-1',
    })

    expect(registry.bindSession).toHaveBeenCalledTimes(1)
    expect(tracker.confirmSessionAssociation).toHaveBeenCalledTimes(2)
    expect(associated).toHaveBeenCalledTimes(1)

    controller.dispose()
  })

  it.each([
    {
      name: 'missing terminal',
      terminal: undefined,
      reason: 'terminal_missing_or_not_running',
      extra: {},
    },
    {
      name: 'non-OpenCode terminal',
      terminal: {
        terminalId: 'term-1',
        mode: 'codex',
        status: 'running',
        resumeSessionId: undefined,
      },
      reason: 'terminal_not_opencode',
      extra: { mode: 'codex' },
    },
    {
      name: 'stopped terminal',
      terminal: {
        terminalId: 'term-1',
        mode: 'opencode',
        status: 'exited',
        resumeSessionId: undefined,
      },
      reason: 'terminal_missing_or_not_running',
      extra: { status: 'exited' },
    },
  ])('logs and rejects association requests for $name', ({ terminal, reason, extra }) => {
    const tracker = new FakeTracker()
    const registry = makeRegistry({
      get: vi.fn(() => terminal),
    })
    const log = { warn: vi.fn() }
    const controller = new OpencodeSessionController({
      tracker: tracker as any,
      registry: registry as any,
      log,
    })

    tracker.emit('association.requested', {
      terminalId: 'term-1',
      sessionId: 'session-1',
    })

    expect(log.warn).toHaveBeenCalledWith({
      terminalId: 'term-1',
      sessionId: 'session-1',
      reason,
      ...extra,
    }, 'Rejected OpenCode association request')
    expect(registry.bindSession).not.toHaveBeenCalled()
    expect(tracker.confirmSessionAssociation).not.toHaveBeenCalled()
    expect(tracker.rejectSessionAssociation).toHaveBeenCalledWith({
      terminalId: 'term-1',
      sessionId: 'session-1',
    })

    controller.dispose()
  })

  it('rejects association requests when bindSession detects an ownership conflict', () => {
    const tracker = new FakeTracker()
    const registry = makeRegistry({
      bindSession: vi.fn(() => ({
        ok: false as const,
        reason: 'session_already_owned',
        owner: 'other-terminal',
      })),
    })
    const log = { warn: vi.fn() }
    const associated = vi.fn()
    const controller = new OpencodeSessionController({
      tracker: tracker as any,
      registry: registry as any,
      log,
    })
    controller.on('associated', associated)

    tracker.emit('association.requested', {
      terminalId: 'term-1',
      sessionId: 'session-1',
    })

    expect(log.warn).toHaveBeenCalledWith({
      terminalId: 'term-1',
      sessionId: 'session-1',
      reason: 'session_already_owned',
      ownerTerminalId: 'other-terminal',
    }, 'Rejected OpenCode association request')
    expect(tracker.confirmSessionAssociation).not.toHaveBeenCalled()
    expect(tracker.rejectSessionAssociation).toHaveBeenCalledWith({
      terminalId: 'term-1',
      sessionId: 'session-1',
    })
    expect(associated).not.toHaveBeenCalled()

    controller.dispose()
  })

  it('logs rejected association requests with previous session context', () => {
    const tracker = new FakeTracker()
    const log = { warn: vi.fn() }
    const registry = makeRegistry({
      get: vi.fn(() => ({
        terminalId: 'term-1',
        mode: 'opencode',
        status: 'running',
        resumeSessionId: 'previous-session',
      })),
      bindSession: vi.fn(() => ({
        ok: false as const,
        reason: 'session_already_owned',
        owner: 'other-terminal',
      })),
    })
    const controller = new OpencodeSessionController({
      tracker: tracker as any,
      registry: registry as any,
      log,
    })

    tracker.emit('association.requested', {
      terminalId: 'term-1',
      sessionId: 'next-session',
    })

    expect(log.warn).toHaveBeenCalledWith({
      terminalId: 'term-1',
      sessionId: 'next-session',
      reason: 'session_already_owned',
      previousSessionId: 'previous-session',
      ownerTerminalId: 'other-terminal',
    }, 'Rejected OpenCode association request')
    expect(tracker.rejectSessionAssociation).toHaveBeenCalledWith({
      terminalId: 'term-1',
      sessionId: 'next-session',
    })

    controller.dispose()
  })
})
