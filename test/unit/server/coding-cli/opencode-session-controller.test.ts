import { EventEmitter } from 'events'
import { describe, expect, it, vi } from 'vitest'
import { OpencodeSessionController } from '../../../../server/coding-cli/opencode-session-controller'

class FakeTracker extends EventEmitter {
  confirmSessionAssociation = vi.fn()
  rejectSessionAssociation = vi.fn()
}

describe('OpencodeSessionController', () => {
  it('uses non-stealing bindSession and confirms successful association requests', () => {
    const tracker = new FakeTracker()
    const registry = {
      get: vi.fn(() => ({
        terminalId: 'term-1',
        mode: 'opencode',
        status: 'running',
      })),
      bindSession: vi.fn(() => ({
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

  it('rejects association requests when bindSession detects an ownership conflict', () => {
    const tracker = new FakeTracker()
    const registry = {
      get: vi.fn(() => ({
        terminalId: 'term-1',
        mode: 'opencode',
        status: 'running',
      })),
      bindSession: vi.fn(() => ({
        ok: false as const,
        reason: 'session_already_owned',
        owner: 'other-terminal',
      })),
      on: vi.fn(),
      off: vi.fn(),
    }
    const associated = vi.fn()
    const controller = new OpencodeSessionController({
      tracker: tracker as any,
      registry: registry as any,
      log: { warn: vi.fn() },
    })
    controller.on('associated', associated)

    tracker.emit('association.requested', {
      terminalId: 'term-1',
      sessionId: 'session-1',
    })

    expect(tracker.confirmSessionAssociation).not.toHaveBeenCalled()
    expect(tracker.rejectSessionAssociation).toHaveBeenCalledWith({
      terminalId: 'term-1',
      sessionId: 'session-1',
    })
    expect(associated).not.toHaveBeenCalled()

    controller.dispose()
  })
})
