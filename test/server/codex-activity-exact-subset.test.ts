import { afterEach, describe, expect, it, vi } from 'vitest'
import { TerminalRegistry } from '../../server/terminal-registry'
import { PENDING_SUBMIT_GATE_MS } from '../../server/coding-cli/codex-activity-tracker'
import { wireCodexActivityTracker } from '../../server/coding-cli/codex-activity-wiring'
import type { CodingCliSession, ProjectGroup } from '../../server/coding-cli/types'

vi.mock('node-pty', () => ({
  spawn: vi.fn(() => ({
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
  })),
}))

vi.mock('../../server/logger', () => {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
  }
  logger.child.mockReturnValue(logger)
  return { logger }
})

function createSession(overrides: Partial<CodingCliSession> = {}): CodingCliSession {
  return {
    provider: 'codex',
    sessionId: 'codex-session-1',
    projectPath: '/repo/project',
    lastActivityAt: 1_000,
    cwd: '/repo/project',
    ...overrides,
  }
}

class FakeCodingCliIndexer {
  private projects: ProjectGroup[] = []
  private readonly handlers = new Set<(projects: ProjectGroup[]) => void>()

  getProjects(): ProjectGroup[] {
    return this.projects
  }

  onUpdate(handler: (projects: ProjectGroup[]) => void): () => void {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  emitUpdate(projects: ProjectGroup[]): void {
    this.projects = projects
    for (const handler of this.handlers) {
      handler(projects)
    }
  }
}

describe('Codex activity exact subset wiring', () => {
  const registries: TerminalRegistry[] = []

  afterEach(() => {
    vi.useRealTimers()
    while (registries.length > 0) {
      registries.pop()!.shutdown()
    }
  })

  it('handles bind-before-created resume binding and clears busy from BEL', () => {
    const registry = new TerminalRegistry()
    const indexer = new FakeCodingCliIndexer()
    registries.push(registry)

    indexer.emitUpdate([{
      projectPath: '/repo/project',
      sessions: [
        createSession({
          sessionId: 'codex-session-resume',
          codexTaskEvents: {
            latestTaskStartedAt: 110,
            latestTaskCompletedAt: 100,
          },
        }),
      ],
    }])

    const { tracker, dispose } = wireCodexActivityTracker({
      registry,
      codingCliIndexer: indexer as any,
      now: () => 1_000,
    })

    const term = registry.create({
      mode: 'codex',
      cwd: '/repo/project',
      resumeSessionId: 'codex-session-resume',
    })

    expect(tracker.getActivity(term.terminalId)).toMatchObject({
      sessionId: 'codex-session-resume',
      phase: 'busy',
    })

    registry.emit('terminal.output.raw', { terminalId: term.terminalId, data: '\x07', at: 1_050 })

    expect(tracker.getActivity(term.terminalId)).toMatchObject({
      phase: 'idle',
      lastClearedAt: 1_050,
    })

    dispose()
  })

  it('reconciles startup-bound resume state immediately from the current project snapshot', () => {
    const off = vi.fn()
    const boundEvent = {
      terminalId: 'term-startup',
      provider: 'codex' as const,
      sessionId: 'codex-session-startup',
      reason: 'resume' as const,
    }
    let warmProjects = false

    const registry = {
      on(event: string, handler: (...args: any[]) => void) {
        if (event === 'terminal.session.bound') {
          handler(boundEvent)
        }
      },
      off,
    }
    const codingCliIndexer = {
      getProjects: () => warmProjects
        ? [{
          projectPath: '/repo/project',
          sessions: [
            createSession({
              sessionId: 'codex-session-startup',
              codexTaskEvents: {
                latestTaskStartedAt: 210,
                latestTaskCompletedAt: 200,
              },
            }),
          ],
        }]
        : [],
      onUpdate: () => {
        warmProjects = true
        return () => undefined
      },
    }

    const { tracker, dispose } = wireCodexActivityTracker({
      registry: registry as any,
      codingCliIndexer: codingCliIndexer as any,
      now: () => 2_000,
      setIntervalFn: (() => 0) as any,
      clearIntervalFn: vi.fn() as any,
    })

    expect(tracker.getActivity('term-startup')).toMatchObject({
      sessionId: 'codex-session-startup',
      phase: 'busy',
      acceptedStartAt: 210,
    })

    dispose()
    expect(off).toHaveBeenCalled()
  })

  it('promotes a resumed terminal to busy when the unresolved codex snapshot arrives after bind', () => {
    const registry = new TerminalRegistry()
    const indexer = new FakeCodingCliIndexer()
    registries.push(registry)

    const { tracker, dispose } = wireCodexActivityTracker({
      registry,
      codingCliIndexer: indexer as any,
      now: () => 1_500,
    })

    const term = registry.create({
      mode: 'codex',
      cwd: '/repo/project',
      resumeSessionId: 'codex-session-late',
    })

    expect(tracker.getActivity(term.terminalId)).toMatchObject({
      sessionId: 'codex-session-late',
      phase: 'idle',
    })

    indexer.emitUpdate([{
      projectPath: '/repo/project',
      sessions: [
        createSession({
          sessionId: 'codex-session-late',
          codexTaskEvents: {
            latestTaskStartedAt: 160,
          },
        }),
      ],
    }])

    expect(tracker.getActivity(term.terminalId)).toMatchObject({
      sessionId: 'codex-session-late',
      phase: 'busy',
      acceptedStartAt: 160,
    })

    dispose()
  })

  it('rebinds a repaired canonical resume owner back into busy activity tracking', () => {
    const registry = new TerminalRegistry()
    const indexer = new FakeCodingCliIndexer()
    registries.push(registry)

    indexer.emitUpdate([{
      projectPath: '/repo/project',
      sessions: [
        createSession({
          sessionId: 'codex-session-repaired',
          codexTaskEvents: {
            latestTaskStartedAt: 110,
            latestTaskCompletedAt: 100,
          },
        }),
      ],
    }])

    const { tracker, dispose } = wireCodexActivityTracker({
      registry,
      codingCliIndexer: indexer as any,
      now: () => 1_000,
    })

    const canonical = registry.create({
      mode: 'codex',
      cwd: '/repo/project',
    })
    const duplicate = registry.create({
      mode: 'codex',
      cwd: '/repo/project',
      resumeSessionId: 'codex-session-repaired',
    })

    registry.get(canonical.terminalId)!.resumeSessionId = 'codex-session-repaired'
    registry.repairLegacySessionOwners('codex', 'codex-session-repaired')

    expect(tracker.getActivity(duplicate.terminalId)).toBeUndefined()
    expect(tracker.getActivity(canonical.terminalId)).toMatchObject({
      sessionId: 'codex-session-repaired',
      phase: 'busy',
      acceptedStartAt: 110,
    })

    dispose()
  })

  it('preserves pending state when repair rebinds the same session back onto the canonical terminal', () => {
    vi.useFakeTimers()
    const registry = new TerminalRegistry()
    const indexer = new FakeCodingCliIndexer()
    registries.push(registry)

    indexer.emitUpdate([{
      projectPath: '/repo/project',
      sessions: [
        createSession({
          sessionId: 'codex-session-repair-pending',
          codexTaskEvents: {
            latestTaskStartedAt: 110,
            latestTaskCompletedAt: 100,
          },
        }),
      ],
    }])

    const { tracker, dispose } = wireCodexActivityTracker({
      registry,
      codingCliIndexer: indexer as any,
      now: () => Date.now(),
    })

    vi.setSystemTime(1_000)
    const canonical = registry.create({
      mode: 'codex',
      cwd: '/repo/project',
    })
    registry.get(canonical.terminalId)!.resumeSessionId = 'codex-session-repair-pending'
    registry.emit('terminal.session.bound', {
      terminalId: canonical.terminalId,
      provider: 'codex',
      sessionId: 'codex-session-repair-pending',
      reason: 'association',
    })

    vi.setSystemTime(1_100)
    registry.input(canonical.terminalId, '\r')
    expect(tracker.getActivity(canonical.terminalId)).toMatchObject({
      phase: 'pending',
      pendingSubmitAt: 1_100,
    })

    vi.setSystemTime(1_150)
    const duplicate = registry.create({
      mode: 'codex',
      cwd: '/repo/project',
      resumeSessionId: 'codex-session-repair-pending',
    })

    vi.setSystemTime(1_200)
    const repaired = registry.repairLegacySessionOwners('codex', 'codex-session-repair-pending')

    expect(repaired).toEqual({
      repaired: true,
      canonicalTerminalId: canonical.terminalId,
      clearedTerminalIds: [duplicate.terminalId],
    })
    expect(tracker.getActivity(canonical.terminalId)).toMatchObject({
      sessionId: 'codex-session-repair-pending',
      phase: 'pending',
      pendingSubmitAt: 1_100,
      latentAcceptedStartAt: 110,
    })

    registry.emit('terminal.output.raw', { terminalId: canonical.terminalId, data: '\x07', at: 1_250 })

    expect(tracker.getActivity(canonical.terminalId)).toMatchObject({
      phase: 'pending',
      pendingSubmitAt: 1_100,
      pendingUntil: 1_250 + PENDING_SUBMIT_GATE_MS,
    })

    dispose()
  })

  it('moves bound turns through pending to busy and clears state on exit', () => {
    vi.useFakeTimers()
    const registry = new TerminalRegistry()
    const indexer = new FakeCodingCliIndexer()
    registries.push(registry)

    const { tracker, dispose } = wireCodexActivityTracker({
      registry,
      codingCliIndexer: indexer as any,
      now: () => 2_000,
    })

    const term = registry.create({ mode: 'codex', cwd: '/repo/project' })
    registry.setResumeSessionId(term.terminalId, 'codex-session-2')

    vi.setSystemTime(2_000)
    registry.input(term.terminalId, '\r')
    expect(tracker.getActivity(term.terminalId)).toMatchObject({
      sessionId: 'codex-session-2',
      phase: 'pending',
    })

    indexer.emitUpdate([{
      projectPath: '/repo/project',
      sessions: [
        createSession({
          sessionId: 'codex-session-2',
          codexTaskEvents: {
            latestTaskStartedAt: 2_050,
          },
        }),
      ],
    }])

    expect(tracker.getActivity(term.terminalId)).toMatchObject({
      phase: 'busy',
      acceptedStartAt: 2_050,
    })

    registry.kill(term.terminalId)
    expect(tracker.getActivity(term.terminalId)).toBeUndefined()

    dispose()
  })

  it('does not retroactively pulse after an unbound first turn is later associated', () => {
    const registry = new TerminalRegistry()
    const indexer = new FakeCodingCliIndexer()
    registries.push(registry)

    const { tracker, dispose } = wireCodexActivityTracker({
      registry,
      codingCliIndexer: indexer as any,
      now: () => 3_000,
    })

    const term = registry.create({ mode: 'codex', cwd: '/repo/project' })
    registry.input(term.terminalId, '\r')

    expect(tracker.getActivity(term.terminalId)).toBeUndefined()

    indexer.emitUpdate([{
      projectPath: '/repo/project',
      sessions: [
        createSession({
          sessionId: 'codex-session-3',
          codexTaskEvents: {
            latestTaskStartedAt: 3_050,
          },
        }),
      ],
    }])
    registry.setResumeSessionId(term.terminalId, 'codex-session-3')
    indexer.emitUpdate(indexer.getProjects())

    expect(tracker.getActivity(term.terminalId)).toMatchObject({
      sessionId: 'codex-session-3',
      phase: 'idle',
      lastSeenTaskStartedAt: 3_050,
    })

    dispose()
  })
})
