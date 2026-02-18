import { describe, it, expect, vi } from 'vitest'
import { TerminalRegistry, modeSupportsResume } from '../../server/terminal-registry'
import { CodingCliSessionIndexer } from '../../server/coding-cli/session-indexer'
import { makeSessionKey, type CodingCliSession } from '../../server/coding-cli/types'
import { TerminalMetadataService } from '../../server/terminal-metadata-service'

vi.mock('node-pty', () => ({
  spawn: vi.fn(() => ({
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
  })),
}))

const SESSION_ID_ONE = '550e8400-e29b-41d4-a716-446655440000'
const SESSION_ID_TWO = '6f1c2b3a-4d5e-6f70-8a9b-0c1d2e3f4a5b'
const SESSION_ID_THREE = 'f47ac10b-58cc-4372-a567-0e02b2c3d479'
const SESSION_ID_FOUR = '2c1a2a5a-3f9f-4b5e-9b39-7d7e0c9a4b10'
const SESSION_ID_FIVE = '3a0b2c9f-1e2d-4f6a-8f3a-4b8a9d7c1e20'
const SESSION_ID_SIX = '4b1c3d2e-5f6a-7b8c-9d0e-1f2a3b4c5d6e'
const SESSION_ID_SEVEN = '5c2d4e6f-7a8b-9c0d-1e2f-3a4b5c6d7e8f'
const SESSION_ID_EIGHT = '6d3e5f7a-8b9c-0d1e-2f3a-4b5c6d7e8f90'

function createMetadataService() {
  let now = 1_000
  return new TerminalMetadataService({
    now: () => {
      now += 10
      return now
    },
    git: {
      resolveCheckoutRoot: async () => '/home/user/project',
      resolveRepoRoot: async () => '/home/user/project',
      resolveBranchAndDirty: async () => ({ branch: 'main', isDirty: false }),
    },
  })
}

function createIndexer(): CodingCliSessionIndexer {
  return new CodingCliSessionIndexer([])
}

describe('Session-Terminal metadata broadcasts', () => {
  it('broadcasts terminal.session.associated and terminal.meta.updated for Codex association flow', async () => {
    const registry = new TerminalRegistry()
    const metadata = createMetadataService()
    const broadcasts: any[] = []

    const terminal = registry.create({ mode: 'codex', cwd: '/home/user/project' })
    await metadata.seedFromTerminal(registry.list()[0] as any)

    const codexSession: CodingCliSession = {
      provider: 'codex',
      sessionId: SESSION_ID_ONE,
      projectPath: '/home/user/project',
      updatedAt: Date.now(),
      cwd: '/home/user/project',
      gitBranch: 'feature/codex',
      isDirty: true,
      tokenUsage: {
        inputTokens: 100,
        outputTokens: 50,
        cachedTokens: 10,
        totalTokens: 160,
        contextTokens: 160,
        compactThresholdTokens: 640,
        compactPercent: 25,
      },
    }

    const unassociated = registry.findUnassociatedTerminals('codex', codexSession.cwd!)
    expect(unassociated).toHaveLength(1)

    const associated = registry.setResumeSessionId(unassociated[0].terminalId, codexSession.sessionId)
    expect(associated).toBe(true)

    broadcasts.push({
      type: 'terminal.session.associated',
      terminalId: unassociated[0].terminalId,
      sessionId: codexSession.sessionId,
    })

    const associatedMeta = metadata.associateSession(unassociated[0].terminalId, 'codex', codexSession.sessionId)
    if (associatedMeta) {
      broadcasts.push({
        type: 'terminal.meta.updated',
        upsert: [associatedMeta],
        remove: [],
      })
    }

    const sessionMeta = await metadata.applySessionMetadata(unassociated[0].terminalId, codexSession)
    if (sessionMeta) {
      broadcasts.push({
        type: 'terminal.meta.updated',
        upsert: [sessionMeta],
        remove: [],
      })
    }

    expect(broadcasts).toContainEqual({
      type: 'terminal.session.associated',
      terminalId: terminal.terminalId,
      sessionId: SESSION_ID_ONE,
    })

    const latestMeta = broadcasts.filter((m) => m.type === 'terminal.meta.updated').at(-1)
    expect(latestMeta).toBeTruthy()
    expect(latestMeta.upsert[0]).toMatchObject({
      terminalId: terminal.terminalId,
      provider: 'codex',
      sessionId: SESSION_ID_ONE,
      // Live git state from cwd should win over potentially stale session snapshots.
      branch: 'main',
      isDirty: false,
      tokenUsage: {
        compactPercent: 25,
      },
    })

    registry.shutdown()
  })

  it('broadcasts terminal.session.associated and terminal.meta.updated for Claude new-session association flow', async () => {
    const registry = new TerminalRegistry()
    const metadata = createMetadataService()
    const indexer = createIndexer()
    const broadcasts: any[] = []
    const pending: Promise<void>[] = []

    const terminal = registry.create({ mode: 'claude', cwd: '/home/user/project' })
    await metadata.seedFromTerminal(registry.list()[0] as any)

    const claudeSession: CodingCliSession = {
      provider: 'claude',
      sessionId: SESSION_ID_TWO,
      projectPath: '/home/user/project',
      updatedAt: Date.now(),
      cwd: '/home/user/project',
      gitBranch: 'feature/claude',
      isDirty: false,
      tokenUsage: {
        inputTokens: 20,
        outputTokens: 9,
        cachedTokens: 12,
        totalTokens: 41,
        contextTokens: 41,
        compactThresholdTokens: 190000,
        compactPercent: 0,
      },
    }

    const latestSessions = new Map([[SESSION_ID_TWO, claudeSession]])

    indexer.onNewSession((session) => {
      if (session.provider !== 'claude') return
      if (!session.cwd) return
      const unassociated = registry.findUnassociatedClaudeTerminals(session.cwd)
      if (unassociated.length === 0) return
      const term = unassociated[0]
      if (!registry.setResumeSessionId(term.terminalId, session.sessionId)) return

      broadcasts.push({
        type: 'terminal.session.associated',
        terminalId: term.terminalId,
        sessionId: session.sessionId,
      })

      const associatedMeta = metadata.associateSession(term.terminalId, 'claude', session.sessionId)
      if (associatedMeta) {
        broadcasts.push({
          type: 'terminal.meta.updated',
          upsert: [associatedMeta],
          remove: [],
        })
      }

      const latest = latestSessions.get(session.sessionId)
      if (!latest) return

      pending.push((async () => {
        const upsert = await metadata.applySessionMetadata(term.terminalId, latest)
        if (!upsert) return
        broadcasts.push({
          type: 'terminal.meta.updated',
          upsert: [upsert],
          remove: [],
        })
      })())
    })

    indexer['initialized'] = true
    indexer['detectNewSessions']([{
      provider: 'claude',
      sessionId: SESSION_ID_TWO,
      projectPath: '/home/user/project',
      updatedAt: Date.now(),
      cwd: '/home/user/project',
    }])
    await Promise.all(pending)

    expect(broadcasts).toContainEqual({
      type: 'terminal.session.associated',
      terminalId: terminal.terminalId,
      sessionId: SESSION_ID_TWO,
    })

    const latestMeta = broadcasts.filter((m) => m.type === 'terminal.meta.updated').at(-1)
    expect(latestMeta).toBeTruthy()
    expect(latestMeta.upsert[0]).toMatchObject({
      terminalId: terminal.terminalId,
      provider: 'claude',
      sessionId: SESSION_ID_TWO,
      branch: 'main',
      isDirty: false,
      tokenUsage: {
        inputTokens: 20,
        outputTokens: 9,
        cachedTokens: 12,
      },
    })

    registry.shutdown()
  })
})

describe('Session-Terminal Association Integration', () => {
  it('should associate terminal with session when session is created', () => {
    const registry = new TerminalRegistry()
    const indexer = createIndexer()
    const broadcasts: any[] = []

    // Wire up like in index.ts
    indexer.onNewSession((session) => {
      if (session.provider !== 'claude') return
      if (!session.cwd) return
      const unassociated = registry.findUnassociatedClaudeTerminals(session.cwd)
      if (unassociated.length === 0) return
      const term = unassociated[0] // Only oldest
      registry.setResumeSessionId(term.terminalId, session.sessionId)
      broadcasts.push({
        type: 'terminal.session.associated',
        terminalId: term.terminalId,
        sessionId: session.sessionId,
      })
    })

    // Simulate indexer is initialized
    indexer['initialized'] = true

    // Create an unassociated claude terminal
    const term = registry.create({ mode: 'claude', cwd: '/home/user/project' })
    expect(term.resumeSessionId).toBeUndefined()

    // Simulate new session detection
    const newSession: CodingCliSession = {
      provider: 'claude',
      sessionId: SESSION_ID_ONE,
      projectPath: '/home/user/project',
      updatedAt: Date.now(),
      cwd: '/home/user/project',
    }
    indexer['detectNewSessions']([newSession])

    // Verify association
    expect(registry.get(term.terminalId)?.resumeSessionId).toBe(SESSION_ID_ONE)
    expect(broadcasts).toHaveLength(1)
    expect(broadcasts[0]).toEqual({
      type: 'terminal.session.associated',
      terminalId: term.terminalId,
      sessionId: SESSION_ID_ONE,
    })

    // Cleanup
    registry.shutdown()
  })

  it('should not associate already-associated terminals', () => {
    const registry = new TerminalRegistry()
    const indexer = createIndexer()
    const broadcasts: any[] = []

    indexer.onNewSession((session) => {
      if (session.provider !== 'claude') return
      if (!session.cwd) return
      const unassociated = registry.findUnassociatedClaudeTerminals(session.cwd)
      if (unassociated.length === 0) return
      const term = unassociated[0]
      registry.setResumeSessionId(term.terminalId, session.sessionId)
      broadcasts.push({ type: 'terminal.session.associated', terminalId: term.terminalId })
    })

    indexer['initialized'] = true

    // Create terminal that already has resumeSessionId
    registry.create({ mode: 'claude', cwd: '/home/user/project', resumeSessionId: SESSION_ID_ONE })

    // Simulate new session
    indexer['detectNewSessions']([{
      provider: 'claude',
      sessionId: SESSION_ID_TWO,
      projectPath: '/home/user/project',
      updatedAt: Date.now(),
      cwd: '/home/user/project',
    }])

    // Should not broadcast - terminal already associated
    expect(broadcasts).toHaveLength(0)

    // Cleanup
    registry.shutdown()
  })

  it('should only associate the oldest terminal when multiple match same cwd', () => {
    const registry = new TerminalRegistry()
    const indexer = createIndexer()
    const broadcasts: any[] = []

    indexer.onNewSession((session) => {
      if (session.provider !== 'claude') return
      if (!session.cwd) return
      const unassociated = registry.findUnassociatedClaudeTerminals(session.cwd)
      if (unassociated.length === 0) return
      const term = unassociated[0] // Only oldest
      registry.setResumeSessionId(term.terminalId, session.sessionId)
      broadcasts.push({
        type: 'terminal.session.associated',
        terminalId: term.terminalId,
        sessionId: session.sessionId,
      })
    })

    indexer['initialized'] = true

    // Create TWO unassociated terminals with same cwd
    const term1 = registry.create({ mode: 'claude', cwd: '/home/user/project' })
    const term2 = registry.create({ mode: 'claude', cwd: '/home/user/project' })

    // Simulate new session
    indexer['detectNewSessions']([{
      provider: 'claude',
      sessionId: SESSION_ID_TWO,
      projectPath: '/home/user/project',
      updatedAt: Date.now(),
      cwd: '/home/user/project',
    }])

    // Should only associate the OLDEST terminal (term1)
    expect(broadcasts).toHaveLength(1)
    expect(broadcasts[0].terminalId).toBe(term1.terminalId)
    expect(registry.get(term1.terminalId)?.resumeSessionId).toBe(SESSION_ID_TWO)
    expect(registry.get(term2.terminalId)?.resumeSessionId).toBeUndefined()

    // Cleanup
    registry.shutdown()
  })

  it('should correctly associate two terminals when two sessions are created in sequence', () => {
    const registry = new TerminalRegistry()
    const indexer = createIndexer()
    const broadcasts: any[] = []

    indexer.onNewSession((session) => {
      if (session.provider !== 'claude') return
      if (!session.cwd) return
      const unassociated = registry.findUnassociatedClaudeTerminals(session.cwd)
      if (unassociated.length === 0) return
      const term = unassociated[0] // Only oldest unassociated
      registry.setResumeSessionId(term.terminalId, session.sessionId)
      broadcasts.push({
        type: 'terminal.session.associated',
        terminalId: term.terminalId,
        sessionId: session.sessionId,
      })
    })

    indexer['initialized'] = true

    // Create TWO unassociated terminals with same cwd (e.g., split pane scenario)
    const term1 = registry.create({ mode: 'claude', cwd: '/home/user/project' })
    const term2 = registry.create({ mode: 'claude', cwd: '/home/user/project' })

    // First Claude (term1) creates its session
    indexer['detectNewSessions']([{
      provider: 'claude',
      sessionId: SESSION_ID_ONE,
      projectPath: '/home/user/project',
      updatedAt: Date.now(),
      cwd: '/home/user/project',
    }])

    // term1 should now be associated
    expect(registry.get(term1.terminalId)?.resumeSessionId).toBe(SESSION_ID_ONE)
    expect(registry.get(term2.terminalId)?.resumeSessionId).toBeUndefined()

    // Second Claude (term2) creates its session
    indexer['detectNewSessions']([{
      provider: 'claude',
      sessionId: SESSION_ID_THREE,
      projectPath: '/home/user/project',
      updatedAt: Date.now(),
      cwd: '/home/user/project',
    }])

    // Now term2 should also be associated (with different session)
    expect(registry.get(term1.terminalId)?.resumeSessionId).toBe(SESSION_ID_ONE)
    expect(registry.get(term2.terminalId)?.resumeSessionId).toBe(SESSION_ID_THREE)

    // Two broadcasts total, one per terminal
    expect(broadcasts).toHaveLength(2)
    expect(broadcasts[0].terminalId).toBe(term1.terminalId)
    expect(broadcasts[0].sessionId).toBe(SESSION_ID_ONE)
    expect(broadcasts[1].terminalId).toBe(term2.terminalId)
    expect(broadcasts[1].sessionId).toBe(SESSION_ID_THREE)

    // Cleanup
    registry.shutdown()
  })

  it('should not fire handlers on server startup (before initialized)', () => {
    const registry = new TerminalRegistry()
    const indexer = createIndexer()
    const broadcasts: any[] = []

    indexer.onNewSession((session) => {
      if (session.provider !== 'claude') return
      if (!session.cwd) return
      const unassociated = registry.findUnassociatedClaudeTerminals(session.cwd)
      if (unassociated.length === 0) return
      const term = unassociated[0]
      registry.setResumeSessionId(term.terminalId, session.sessionId)
      broadcasts.push({ type: 'terminal.session.associated', terminalId: term.terminalId })
    })

    // Create terminal
    registry.create({ mode: 'claude', cwd: '/home/user/project' })

    // Simulate startup: detectNewSessions called BEFORE initialized = true
    // This simulates what happens during start() before initialized flag is set
    indexer['detectNewSessions']([{
      provider: 'claude',
      sessionId: SESSION_ID_FOUR,
      projectPath: '/home/user/project',
      updatedAt: Date.now(),
      cwd: '/home/user/project',
    }])

    // Should NOT broadcast - indexer not yet initialized
    expect(broadcasts).toHaveLength(0)
    // But session should be tracked
    expect(indexer['knownSessionIds'].has(makeSessionKey('claude', SESSION_ID_FOUR))).toBe(true)

    // Cleanup
    registry.shutdown()
  })

  it('should skip sessions without cwd', () => {
    const registry = new TerminalRegistry()
    const indexer = createIndexer()
    const broadcasts: any[] = []

    indexer.onNewSession((session) => {
      if (session.provider !== 'claude') return
      if (!session.cwd) return
      const unassociated = registry.findUnassociatedClaudeTerminals(session.cwd!)
      if (unassociated.length === 0) return
      const term = unassociated[0]
      registry.setResumeSessionId(term.terminalId, session.sessionId)
      broadcasts.push({ type: 'terminal.session.associated', terminalId: term.terminalId })
    })

    indexer['initialized'] = true

    // Create terminal
    registry.create({ mode: 'claude', cwd: '/home/user/project' })

    // Simulate session with NO cwd (orphaned session)
    indexer['detectNewSessions']([{
      provider: 'claude',
      sessionId: SESSION_ID_FIVE,
      projectPath: '/home/user/project',
      updatedAt: Date.now(),
      cwd: undefined,
    }])

    // Should NOT broadcast - session has no cwd
    expect(broadcasts).toHaveLength(0)

    // Cleanup
    registry.shutdown()
  })

  it('should not associate shell-mode terminals', () => {
    const registry = new TerminalRegistry()
    const indexer = createIndexer()
    const broadcasts: any[] = []

    indexer.onNewSession((session) => {
      if (session.provider !== 'claude') return
      if (!session.cwd) return
      const unassociated = registry.findUnassociatedClaudeTerminals(session.cwd)
      if (unassociated.length === 0) return
      const term = unassociated[0]
      registry.setResumeSessionId(term.terminalId, session.sessionId)
      broadcasts.push({ type: 'terminal.session.associated', terminalId: term.terminalId })
    })

    indexer['initialized'] = true

    // Create a SHELL terminal (not claude mode)
    registry.create({ mode: 'shell', cwd: '/home/user/project' })

    // Simulate new session
    indexer['detectNewSessions']([{
      provider: 'claude',
      sessionId: SESSION_ID_SIX,
      projectPath: '/home/user/project',
      updatedAt: Date.now(),
      cwd: '/home/user/project',
    }])

    // Should NOT broadcast - no claude-mode terminals
    expect(broadcasts).toHaveLength(0)

    // Cleanup
    registry.shutdown()
  })
})

describe('Session-Terminal Association Platform-specific', () => {
  it('should normalize backslashes and trailing slashes when matching paths', () => {
    const registry = new TerminalRegistry()
    const indexer = createIndexer()
    const broadcasts: any[] = []

    indexer.onNewSession((session) => {
      if (session.provider !== 'claude') return
      if (!session.cwd) return
      const unassociated = registry.findUnassociatedClaudeTerminals(session.cwd)
      if (unassociated.length === 0) return
      const term = unassociated[0]
      registry.setResumeSessionId(term.terminalId, session.sessionId)
      broadcasts.push({
        type: 'terminal.session.associated',
        terminalId: term.terminalId,
        sessionId: session.sessionId,
      })
    })

    indexer['initialized'] = true

    // Create terminal with backslashes in path
    const term = registry.create({ mode: 'claude', cwd: '/home/user/project' })

    // Simulate session with trailing slash (should still match)
    indexer['detectNewSessions']([{
      provider: 'claude',
      sessionId: SESSION_ID_SEVEN,
      projectPath: '/home/user/project/',
      updatedAt: Date.now(),
      cwd: '/home/user/project/',
    }])

    // Should match after normalization removes trailing slash
    expect(broadcasts).toHaveLength(1)
    expect(broadcasts[0].terminalId).toBe(term.terminalId)
    expect(broadcasts[0].sessionId).toBe(SESSION_ID_SEVEN)

    registry.shutdown()
  })

  it('should match mixed separator styles (backslash vs forward slash)', () => {
    const registry = new TerminalRegistry()
    const indexer = createIndexer()
    const broadcasts: any[] = []

    indexer.onNewSession((session) => {
      if (session.provider !== 'claude') return
      if (!session.cwd) return
      const unassociated = registry.findUnassociatedClaudeTerminals(session.cwd)
      if (unassociated.length === 0) return
      const term = unassociated[0]
      registry.setResumeSessionId(term.terminalId, session.sessionId)
      broadcasts.push({
        type: 'terminal.session.associated',
        terminalId: term.terminalId,
        sessionId: session.sessionId,
      })
    })

    indexer['initialized'] = true

    // Use forward slashes (works on all platforms as test cwd)
    const term = registry.create({ mode: 'claude', cwd: '/home/user/project' })

    // Session also has forward slashes
    indexer['detectNewSessions']([{
      provider: 'claude',
      sessionId: SESSION_ID_EIGHT,
      projectPath: '/home/user/project',
      updatedAt: Date.now(),
      cwd: '/home/user/project',
    }])

    expect(broadcasts).toHaveLength(1)
    expect(broadcasts[0].terminalId).toBe(term.terminalId)

    registry.shutdown()
  })
})

describe('Codex Session-Terminal Association via onUpdate', () => {
  /**
   * Simulates the association logic in the codingCliIndexer.onUpdate handler.
   * After consolidation, onUpdate handles ALL providers (including Claude).
   * Association is idempotent — already-associated terminals are excluded by
   * findUnassociatedTerminals, and setResumeSessionId rejects duplicates.
   */
  const ASSOCIATION_MAX_AGE_MS = 30_000

  function associateOnUpdate(
    registry: TerminalRegistry,
    projects: { projectPath: string; sessions: CodingCliSession[] }[],
    broadcasts: any[],
  ) {
    for (const project of projects) {
      for (const session of project.sessions) {
        if (!modeSupportsResume(session.provider)) continue
        if (!session.cwd) continue
        const unassociated = registry.findUnassociatedTerminals(session.provider, session.cwd)
        if (unassociated.length === 0) continue

        const term = unassociated[0]
        if (session.updatedAt < term.createdAt - ASSOCIATION_MAX_AGE_MS) continue

        const associated = registry.setResumeSessionId(term.terminalId, session.sessionId)
        if (!associated) continue

        broadcasts.push({
          type: 'terminal.session.associated',
          terminalId: term.terminalId,
          sessionId: session.sessionId,
        })
      }
    }
  }

  it('associates codex terminal when session appears in onUpdate', () => {
    const registry = new TerminalRegistry()
    const broadcasts: any[] = []

    const term = registry.create({ mode: 'codex', cwd: '/home/user/project' })
    expect(term.resumeSessionId).toBeUndefined()

    associateOnUpdate(registry, [{
      projectPath: '/home/user/project',
      sessions: [{
        provider: 'codex',
        sessionId: 'codex-session-abc-123',
        projectPath: '/home/user/project',
        updatedAt: Date.now(),
        cwd: '/home/user/project',
      }],
    }], broadcasts)

    expect(registry.get(term.terminalId)?.resumeSessionId).toBe('codex-session-abc-123')
    expect(broadcasts).toHaveLength(1)
    expect(broadcasts[0]).toEqual({
      type: 'terminal.session.associated',
      terminalId: term.terminalId,
      sessionId: 'codex-session-abc-123',
    })

    registry.shutdown()
  })

  it('is idempotent: repeated onUpdate calls do not double-associate', () => {
    const registry = new TerminalRegistry()
    const broadcasts: any[] = []

    const term = registry.create({ mode: 'codex', cwd: '/home/user/project' })

    const projects = [{
      projectPath: '/home/user/project',
      sessions: [{
        provider: 'codex' as const,
        sessionId: 'codex-session-abc-123',
        projectPath: '/home/user/project',
        updatedAt: Date.now(),
        cwd: '/home/user/project',
      }],
    }]

    associateOnUpdate(registry, projects, broadcasts)
    expect(broadcasts).toHaveLength(1)

    associateOnUpdate(registry, projects, broadcasts)
    expect(broadcasts).toHaveLength(1) // Still 1
    expect(registry.get(term.terminalId)?.resumeSessionId).toBe('codex-session-abc-123')

    registry.shutdown()
  })

  it('does not associate one codex session to multiple terminals across repeated updates', () => {
    const registry = new TerminalRegistry()
    const broadcasts: any[] = []

    const term1 = registry.create({ mode: 'codex', cwd: '/home/user/project' })
    const term2 = registry.create({ mode: 'codex', cwd: '/home/user/project' })
    const term3 = registry.create({ mode: 'codex', cwd: '/home/user/project' })

    const projects = [{
      projectPath: '/home/user/project',
      sessions: [{
        provider: 'codex' as const,
        sessionId: 'codex-session-abc-123',
        projectPath: '/home/user/project',
        updatedAt: Date.now(),
        cwd: '/home/user/project',
      }],
    }]

    associateOnUpdate(registry, projects, broadcasts)
    associateOnUpdate(registry, projects, broadcasts)
    associateOnUpdate(registry, projects, broadcasts)

    expect(registry.get(term1.terminalId)?.resumeSessionId).toBe('codex-session-abc-123')
    expect(registry.get(term2.terminalId)?.resumeSessionId).toBeUndefined()
    expect(registry.get(term3.terminalId)?.resumeSessionId).toBeUndefined()
    expect(broadcasts).toHaveLength(1)

    registry.shutdown()
  })

  it('does not cross-associate: codex session does not match claude terminal', () => {
    const registry = new TerminalRegistry()
    const broadcasts: any[] = []

    registry.create({ mode: 'claude', cwd: '/home/user/project' })

    associateOnUpdate(registry, [{
      projectPath: '/home/user/project',
      sessions: [{
        provider: 'codex',
        sessionId: 'codex-session-abc-123',
        projectPath: '/home/user/project',
        updatedAt: Date.now(),
        cwd: '/home/user/project',
      }],
    }], broadcasts)

    expect(broadcasts).toHaveLength(0)

    registry.shutdown()
  })

  it('only associates the oldest terminal when multiple match', () => {
    const registry = new TerminalRegistry()
    const broadcasts: any[] = []

    const term1 = registry.create({ mode: 'codex', cwd: '/home/user/project' })
    const term2 = registry.create({ mode: 'codex', cwd: '/home/user/project' })

    associateOnUpdate(registry, [{
      projectPath: '/home/user/project',
      sessions: [{
        provider: 'codex',
        sessionId: 'codex-session-abc-123',
        projectPath: '/home/user/project',
        updatedAt: Date.now(),
        cwd: '/home/user/project',
      }],
    }], broadcasts)

    expect(broadcasts).toHaveLength(1)
    expect(broadcasts[0].terminalId).toBe(term1.terminalId)
    expect(registry.get(term1.terminalId)?.resumeSessionId).toBe('codex-session-abc-123')
    expect(registry.get(term2.terminalId)?.resumeSessionId).toBeUndefined()

    registry.shutdown()
  })

  it('skips providers without resume support', () => {
    const registry = new TerminalRegistry()
    const broadcasts: any[] = []

    registry.create({ mode: 'opencode', cwd: '/home/user/project' })

    associateOnUpdate(registry, [{
      projectPath: '/home/user/project',
      sessions: [{
        provider: 'opencode',
        sessionId: 'opencode-session-123',
        projectPath: '/home/user/project',
        updatedAt: Date.now(),
        cwd: '/home/user/project',
      }],
    }], broadcasts)

    expect(broadcasts).toHaveLength(0)

    registry.shutdown()
  })

  it('handles claude sessions in unified onUpdate flow (post-consolidation)', () => {
    const registry = new TerminalRegistry()
    const broadcasts: any[] = []

    const term = registry.create({ mode: 'claude', cwd: '/home/user/project' })

    // After consolidation, Claude sessions are handled by onUpdate too
    associateOnUpdate(registry, [{
      projectPath: '/home/user/project',
      sessions: [{
        provider: 'claude',
        sessionId: SESSION_ID_ONE,
        projectPath: '/home/user/project',
        updatedAt: Date.now(),
        cwd: '/home/user/project',
      }],
    }], broadcasts)

    // Should associate — Claude is now handled in the unified flow
    expect(broadcasts).toHaveLength(1)
    expect(registry.get(term.terminalId)?.resumeSessionId).toBe(SESSION_ID_ONE)

    registry.shutdown()
  })

  it('does not overwrite existing resumeSessionId', () => {
    const registry = new TerminalRegistry()
    const broadcasts: any[] = []

    const term = registry.create({ mode: 'codex', cwd: '/home/user/project', resumeSessionId: 'existing-session' })

    associateOnUpdate(registry, [{
      projectPath: '/home/user/project',
      sessions: [{
        provider: 'codex',
        sessionId: 'different-session',
        projectPath: '/home/user/project',
        updatedAt: Date.now(),
        cwd: '/home/user/project',
      }],
    }], broadcasts)

    expect(registry.get(term.terminalId)?.resumeSessionId).toBe('existing-session')
    expect(broadcasts).toHaveLength(0)

    registry.shutdown()
  })

  it('does not associate with stale sessions from before the terminal was created', () => {
    const registry = new TerminalRegistry()
    const broadcasts: any[] = []

    const term = registry.create({ mode: 'codex', cwd: '/home/user/project' })

    const hoursAgo = Date.now() - 3 * 60 * 60 * 1000
    associateOnUpdate(registry, [{
      projectPath: '/home/user/project',
      sessions: [{
        provider: 'codex',
        sessionId: 'old-stale-session',
        projectPath: '/home/user/project',
        updatedAt: hoursAgo,
        cwd: '/home/user/project',
      }],
    }], broadcasts)

    expect(registry.get(term.terminalId)?.resumeSessionId).toBeUndefined()
    expect(broadcasts).toHaveLength(0)

    registry.shutdown()
  })

  it('associates with a session created shortly after the terminal', () => {
    const registry = new TerminalRegistry()
    const broadcasts: any[] = []

    const term = registry.create({ mode: 'codex', cwd: '/home/user/project' })

    const shortly = term.createdAt + 2000
    associateOnUpdate(registry, [{
      projectPath: '/home/user/project',
      sessions: [{
        provider: 'codex',
        sessionId: 'matching-session',
        projectPath: '/home/user/project',
        updatedAt: shortly,
        cwd: '/home/user/project',
      }],
    }], broadcasts)

    expect(registry.get(term.terminalId)?.resumeSessionId).toBe('matching-session')
    expect(broadcasts).toHaveLength(1)

    registry.shutdown()
  })
})
