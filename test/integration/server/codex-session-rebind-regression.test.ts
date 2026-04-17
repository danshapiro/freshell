import { describe, it, expect, vi } from 'vitest'
import { TerminalRegistry } from '../../../server/terminal-registry.js'
import { SessionAssociationCoordinator } from '../../../server/session-association-coordinator.js'
import type { CodingCliSession, ProjectGroup } from '../../../server/coding-cli/types.js'

vi.mock('node-pty', () => ({
  spawn: vi.fn(() => ({
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
  })),
}))

const ASSOCIATION_MAX_AGE_MS = 30_000
const SHARED_CWD = '/home/user/project'

function applyIndexerUpdate(
  coordinator: SessionAssociationCoordinator,
  projects: ProjectGroup[],
) {
  for (const session of coordinator.collectNewOrAdvanced(projects)) {
    coordinator.associateSingleSession(session)
  }
}

describe('codex session rebind regression', () => {
  it('leaves codex ownership untouched across repeated index updates', () => {
    const registry = new TerminalRegistry()
    const coordinator = new SessionAssociationCoordinator(registry, ASSOCIATION_MAX_AGE_MS)

    const terminals = [
      registry.create({ mode: 'codex', cwd: SHARED_CWD }),
      registry.create({ mode: 'codex', cwd: SHARED_CWD }),
      registry.create({ mode: 'codex', cwd: SHARED_CWD }),
    ]

    const projects: ProjectGroup[] = [{
      projectPath: SHARED_CWD,
      sessions: [
        {
          provider: 'codex',
          sessionId: 'codex-session-a',
          projectPath: SHARED_CWD,
          lastActivityAt: Date.now(),
          cwd: SHARED_CWD,
        },
        {
          provider: 'codex',
          sessionId: 'codex-session-b',
          projectPath: SHARED_CWD,
          lastActivityAt: Date.now() + 1,
          cwd: SHARED_CWD,
        },
      ],
    }]

    applyIndexerUpdate(coordinator, projects)
    applyIndexerUpdate(coordinator, projects)

    for (const terminal of terminals) {
      expect(registry.get(terminal.terminalId)?.resumeSessionId).toBeUndefined()
    }

    expect(registry.findTerminalsBySession('codex', 'codex-session-a')).toHaveLength(0)
    expect(registry.findTerminalsBySession('codex', 'codex-session-b')).toHaveLength(0)

    registry.shutdown()
  })

  it('never rebinds a newly discovered shared-path session onto a dead terminal record', () => {
    const registry = new TerminalRegistry()
    const coordinator = new SessionAssociationCoordinator(registry, ASSOCIATION_MAX_AGE_MS)

    const dead = registry.create({ mode: 'claude', cwd: SHARED_CWD })
    const live = registry.create({ mode: 'claude', cwd: SHARED_CWD })
    registry.kill(dead.terminalId)

    const session: CodingCliSession = {
      provider: 'claude',
      sessionId: '550e8400-e29b-41d4-a716-446655440000',
      projectPath: SHARED_CWD,
      lastActivityAt: live.createdAt + 1_000,
      cwd: SHARED_CWD,
    }

    expect(registry.findUnassociatedTerminals('claude', SHARED_CWD).map((term) => term.terminalId)).toEqual([
      live.terminalId,
    ])
    expect(registry.bindSession(dead.terminalId, 'claude', session.sessionId, 'association')).toEqual({
      ok: false,
      reason: 'terminal_not_running',
    })

    const result = coordinator.associateSingleSession(session)

    expect(result).toEqual({ associated: true, terminalId: live.terminalId })
    expect(registry.get(dead.terminalId)?.resumeSessionId).toBeUndefined()
    expect(registry.get(live.terminalId)?.resumeSessionId).toBe(session.sessionId)

    registry.shutdown()
  })
})
