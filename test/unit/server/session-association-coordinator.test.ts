import { describe, expect, it, vi } from 'vitest'
import { SessionAssociationCoordinator } from '../../../server/session-association-coordinator'
import type { CodingCliSession } from '../../../server/coding-cli/types'

function createSession(overrides: Partial<CodingCliSession> = {}): CodingCliSession {
  return {
    provider: 'claude',
    sessionId: 'session-main',
    projectPath: '/repo/project',
    lastActivityAt: 2_000,
    cwd: '/repo/project',
    ...overrides,
  }
}

describe('SessionAssociationCoordinator', () => {
  it('collectNewOrAdvanced excludes subagent and non-interactive sessions', () => {
    const registry = {
      findUnassociatedTerminals: vi.fn(() => []),
      bindSession: vi.fn(() => ({ ok: false, reason: 'terminal_missing' })),
      isSessionBound: vi.fn(() => false),
    }
    const coordinator = new SessionAssociationCoordinator(registry as any, 30_000)

    const sessions = [
      createSession({ provider: 'opencode', sessionId: 'session-main', lastActivityAt: 1 }),
      createSession({ provider: 'opencode', sessionId: 'session-subagent', lastActivityAt: 2, isSubagent: true }),
      createSession({ provider: 'opencode', sessionId: 'session-exec', lastActivityAt: 3, isNonInteractive: true }),
    ]

    const candidates = coordinator.collectNewOrAdvanced([
      {
        projectPath: '/repo/project',
        sessions,
      },
    ])

    expect(candidates.map((session) => session.sessionId)).toEqual(['session-main'])
  })

  it('does not attempt to associate subagent or non-interactive sessions', () => {
    const registry = {
      findUnassociatedTerminals: vi.fn(() => [{ terminalId: 'term-1', createdAt: 1_000 }]),
      bindSession: vi.fn(() => ({ ok: true, terminalId: 'term-1', sessionId: 'session-main' })),
      isSessionBound: vi.fn(() => false),
    }
    const coordinator = new SessionAssociationCoordinator(registry as any, 30_000)

    const subagentResult = coordinator.associateSingleSession(createSession({
      sessionId: 'session-subagent',
      isSubagent: true,
    }))
    const execResult = coordinator.associateSingleSession(createSession({
      sessionId: 'session-exec',
      isNonInteractive: true,
    }))

    expect(subagentResult).toEqual({ associated: false })
    expect(execResult).toEqual({ associated: false })
    expect(registry.findUnassociatedTerminals).not.toHaveBeenCalled()
    expect(registry.bindSession).not.toHaveBeenCalled()
  })

  it('associates regular sessions with matching unassociated terminals', () => {
    const registry = {
      findUnassociatedTerminals: vi.fn(() => [{ terminalId: 'term-1', createdAt: 1_000, pendingResumeName: '137 tour' }]),
      bindSession: vi.fn(() => ({ ok: true, terminalId: 'term-1', sessionId: 'session-main' })),
      isSessionBound: vi.fn(() => false),
    }
    const coordinator = new SessionAssociationCoordinator(registry as any, 30_000)

    const result = coordinator.associateSingleSession(createSession())

    expect(result).toEqual({ associated: true, terminalId: 'term-1' })
    expect(registry.findUnassociatedTerminals).toHaveBeenCalledWith('claude', '/repo/project')
    expect(registry.bindSession).toHaveBeenCalledWith('term-1', 'claude', 'session-main', 'association')
  })

  it('skips association when session is already bound to another terminal', () => {
    const registry = {
      findUnassociatedTerminals: vi.fn(() => [{ terminalId: 'term-2', createdAt: 1_000 }]),
      bindSession: vi.fn(),
      isSessionBound: vi.fn(() => true),
    }
    const coordinator = new SessionAssociationCoordinator(registry as any, 30_000)

    const result = coordinator.associateSingleSession(createSession({
      provider: 'opencode',
      sessionId: 'opencode-session-bound',
    }))

    expect(result).toEqual({ associated: false })
    expect(registry.isSessionBound).toHaveBeenCalledWith('opencode', 'opencode-session-bound')
    expect(registry.findUnassociatedTerminals).not.toHaveBeenCalled()
    expect(registry.bindSession).not.toHaveBeenCalled()
  })

  it('does not skip association when isSessionBound returns false', () => {
    const registry = {
      findUnassociatedTerminals: vi.fn(() => [{ terminalId: 'term-1', createdAt: 1_000, pendingResumeName: '137 tour' }]),
      bindSession: vi.fn(() => ({ ok: true, terminalId: 'term-1', sessionId: 'session-main' })),
      isSessionBound: vi.fn(() => false),
    }
    const coordinator = new SessionAssociationCoordinator(registry as any, 30_000)

    const result = coordinator.associateSingleSession(createSession())

    expect(result).toEqual({ associated: true, terminalId: 'term-1' })
    expect(registry.isSessionBound).toHaveBeenCalledWith('claude', 'session-main')
    expect(registry.bindSession).toHaveBeenCalled()
  })

  it('skips codex sessions because exact launch provenance should bind them elsewhere', () => {
    const registry = {
      findUnassociatedTerminals: vi.fn(() => [{ terminalId: 'term-1', createdAt: 1_000 }]),
      bindSession: vi.fn(() => ({ ok: true, terminalId: 'term-1', sessionId: 'codex-session' })),
      isSessionBound: vi.fn(() => false),
    }
    const coordinator = new SessionAssociationCoordinator(registry as any, 30_000)

    const result = coordinator.associateSingleSession(createSession({
      provider: 'codex',
      sessionId: 'codex-session',
    }))

    expect(result).toEqual({ associated: false })
    expect(registry.findUnassociatedTerminals).not.toHaveBeenCalled()
    expect(registry.bindSession).not.toHaveBeenCalled()
  })

  it('keeps named claude resumes eligible on the compatibility path', () => {
    const registry = {
      findUnassociatedTerminals: vi.fn(() => [{ terminalId: 'term-1', createdAt: 1_000, pendingResumeName: '137 tour' }]),
      bindSession: vi.fn(() => ({ ok: true, terminalId: 'term-1', sessionId: '550e8400-e29b-41d4-a716-446655440000' })),
      isSessionBound: vi.fn(() => false),
    }
    const coordinator = new SessionAssociationCoordinator(registry as any, 30_000)

    const result = coordinator.associateSingleSession(createSession({
      provider: 'claude',
      sessionId: '550e8400-e29b-41d4-a716-446655440000',
    }))

    expect(result).toEqual({ associated: true, terminalId: 'term-1' })
    expect(registry.findUnassociatedTerminals).toHaveBeenCalledWith('claude', '/repo/project')
  })

  it('collectNewOrAdvanced excludes plain claude sessions unless a named resume terminal is waiting', () => {
    const registry = {
      findUnassociatedTerminals: vi.fn(() => [{ terminalId: 'term-1', createdAt: 1_000 }]),
      bindSession: vi.fn(() => ({ ok: true, terminalId: 'term-1', sessionId: '550e8400-e29b-41d4-a716-446655440000' })),
      isSessionBound: vi.fn(() => false),
    }
    const coordinator = new SessionAssociationCoordinator(registry as any, 30_000)

    const candidates = coordinator.collectNewOrAdvanced([{
      projectPath: '/repo/project',
      sessions: [createSession({
        provider: 'claude',
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
      })],
    }])

    expect(candidates).toEqual([])
    expect(registry.findUnassociatedTerminals).toHaveBeenCalledWith('claude', '/repo/project')
  })

  it('keeps opencode on the compatibility path', () => {
    const registry = {
      findUnassociatedTerminals: vi.fn(() => [{ terminalId: 'term-2', createdAt: 1_000 }]),
      bindSession: vi.fn(() => ({ ok: true, terminalId: 'term-2', sessionId: 'opencode-session-1' })),
      isSessionBound: vi.fn(() => false),
    }
    const coordinator = new SessionAssociationCoordinator(registry as any, 30_000)

    const result = coordinator.associateSingleSession(createSession({
      provider: 'opencode',
      sessionId: 'opencode-session-1',
    }))

    expect(result).toEqual({ associated: true, terminalId: 'term-2' })
    expect(registry.bindSession).toHaveBeenCalledWith('term-2', 'opencode', 'opencode-session-1', 'association')
  })
})
