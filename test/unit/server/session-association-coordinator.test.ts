import { describe, expect, it, vi } from 'vitest'
import { SessionAssociationCoordinator } from '../../../server/session-association-coordinator'
import type { CodingCliSession } from '../../../server/coding-cli/types'

function createSession(overrides: Partial<CodingCliSession> = {}): CodingCliSession {
  return {
    provider: 'codex',
    sessionId: 'session-main',
    projectPath: '/repo/project',
    updatedAt: 2_000,
    cwd: '/repo/project',
    ...overrides,
  }
}

describe('SessionAssociationCoordinator', () => {
  it('collectNewOrAdvanced excludes subagent and non-interactive sessions', () => {
    const registry = {
      findUnassociatedTerminals: vi.fn(() => []),
      bindSession: vi.fn(() => ({ ok: false, reason: 'terminal_missing' })),
    }
    const coordinator = new SessionAssociationCoordinator(registry as any, 30_000)

    const sessions = [
      createSession({ sessionId: 'session-main', updatedAt: 1 }),
      createSession({ sessionId: 'session-subagent', updatedAt: 2, isSubagent: true }),
      createSession({ sessionId: 'session-exec', updatedAt: 3, isNonInteractive: true }),
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
      findUnassociatedTerminals: vi.fn(() => [{ terminalId: 'term-1', createdAt: 1_000 }]),
      bindSession: vi.fn(() => ({ ok: true, terminalId: 'term-1', sessionId: 'session-main' })),
    }
    const coordinator = new SessionAssociationCoordinator(registry as any, 30_000)

    const result = coordinator.associateSingleSession(createSession())

    expect(result).toEqual({ associated: true, terminalId: 'term-1' })
    expect(registry.findUnassociatedTerminals).toHaveBeenCalledWith('codex', '/repo/project')
    expect(registry.bindSession).toHaveBeenCalledWith('term-1', 'codex', 'session-main', 'association')
  })
})
