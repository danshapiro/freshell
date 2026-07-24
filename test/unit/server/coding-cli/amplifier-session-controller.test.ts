/**
 * AmplifierSessionController tests (plan 2026-07-08 §5 step 5 / §9 Phase 3).
 * Pattern mirrors opencode-session-controller.test.ts: fake locator emitting
 * 'session.located', fake registry with injectable get/bindSession.
 */
import { EventEmitter } from 'events'
import { describe, expect, it, vi } from 'vitest'
import { AmplifierSessionController } from '../../../../server/coding-cli/amplifier-session-controller.js'

class FakeLocator extends EventEmitter {}

const EVENTS_PATH = '/home/user/.amplifier/projects/-p/sessions/session-1/events.jsonl'

function locatedRequest(overrides: Record<string, unknown> = {}) {
  return {
    terminalId: 'term-1',
    sessionId: 'session-1',
    eventsPath: EVENTS_PATH,
    ...overrides,
  }
}

function makeRegistry(input: {
  get?: ReturnType<typeof vi.fn>
  bindSession?: ReturnType<typeof vi.fn>
} = {}) {
  return {
    get: input.get ?? vi.fn(() => ({
      terminalId: 'term-1',
      mode: 'amplifier',
      status: 'running',
      resumeSessionId: undefined,
    })),
    bindSession: input.bindSession ?? vi.fn(() => ({
      ok: true as const,
      terminalId: 'term-1',
      sessionId: 'session-1',
    })),
  }
}

describe('AmplifierSessionController', () => {
  it('binds via registry.bindSession and emits associated with the events path', () => {
    const locator = new FakeLocator()
    const registry = makeRegistry()
    const associated = vi.fn()
    const controller = new AmplifierSessionController({
      locator: locator as any,
      registry: registry as any,
    })
    controller.on('associated', associated)

    locator.emit('session.located', locatedRequest())

    expect(registry.bindSession).toHaveBeenCalledWith('term-1', 'amplifier', 'session-1', 'association')
    expect(associated).toHaveBeenCalledWith({
      terminalId: 'term-1',
      sessionId: 'session-1',
      eventsPath: EVENTS_PATH,
    })

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
      name: 'non-amplifier terminal',
      terminal: { terminalId: 'term-1', mode: 'claude', status: 'running', resumeSessionId: undefined },
      reason: 'terminal_not_amplifier',
      extra: { mode: 'claude' },
    },
    {
      name: 'exited terminal',
      terminal: { terminalId: 'term-1', mode: 'amplifier', status: 'exited', resumeSessionId: undefined },
      reason: 'terminal_missing_or_not_running',
      extra: { status: 'exited' },
    },
    {
      name: 'already-bound terminal',
      terminal: { terminalId: 'term-1', mode: 'amplifier', status: 'running', resumeSessionId: 'other-session' },
      reason: 'terminal_already_bound',
      extra: { previousSessionId: 'other-session' },
    },
  ])('logs and rejects for $name without binding', ({ terminal, reason, extra }) => {
    const locator = new FakeLocator()
    const registry = makeRegistry({ get: vi.fn(() => terminal) })
    const log = { warn: vi.fn() }
    const associated = vi.fn()
    const controller = new AmplifierSessionController({
      locator: locator as any,
      registry: registry as any,
      log,
    })
    controller.on('associated', associated)

    locator.emit('session.located', locatedRequest())

    expect(registry.bindSession).not.toHaveBeenCalled()
    expect(associated).not.toHaveBeenCalled()
    expect(log.warn).toHaveBeenCalledWith({
      terminalId: 'term-1',
      sessionId: 'session-1',
      reason,
      ...extra,
    }, 'Rejected Amplifier session association')

    controller.dispose()
  })

  it('rejects when bindSession reports an ownership conflict', () => {
    const locator = new FakeLocator()
    const registry = makeRegistry({
      bindSession: vi.fn(() => ({
        ok: false as const,
        reason: 'session_already_owned',
        owner: 'other-terminal',
      })),
    })
    const log = { warn: vi.fn() }
    const associated = vi.fn()
    const controller = new AmplifierSessionController({
      locator: locator as any,
      registry: registry as any,
      log,
    })
    controller.on('associated', associated)

    locator.emit('session.located', locatedRequest())

    expect(associated).not.toHaveBeenCalled()
    expect(log.warn).toHaveBeenCalledWith({
      terminalId: 'term-1',
      sessionId: 'session-1',
      reason: 'session_already_owned',
      ownerTerminalId: 'other-terminal',
    }, 'Rejected Amplifier session association')

    controller.dispose()
  })

  it('dispose unsubscribes from the locator', () => {
    const locator = new FakeLocator()
    const registry = makeRegistry()
    const associated = vi.fn()
    const controller = new AmplifierSessionController({
      locator: locator as any,
      registry: registry as any,
    })
    controller.on('associated', associated)
    controller.dispose()

    locator.emit('session.located', locatedRequest())

    expect(registry.bindSession).not.toHaveBeenCalled()
    expect(associated).not.toHaveBeenCalled()
  })
})
