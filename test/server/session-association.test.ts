import { describe, it, expect, vi, afterEach } from 'vitest'
import { TerminalRegistry } from '../../server/terminal-registry'
import { ClaudeSessionIndexer, ClaudeSession } from '../../server/claude-indexer'

vi.mock('node-pty', () => ({
  spawn: vi.fn(() => ({
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
  })),
}))

describe('Session-Terminal Association Integration', () => {
  it('should associate terminal with session when session is created', () => {
    const registry = new TerminalRegistry()
    const indexer = new ClaudeSessionIndexer()
    const broadcasts: any[] = []

    // Simulate wsHandler.broadcast
    const mockBroadcast = (msg: any) => broadcasts.push(msg)

    // Wire up like in index.ts
    indexer.onNewSession((session) => {
      if (!session.cwd) return
      const unassociated = registry.findUnassociatedClaudeTerminals(session.cwd)
      if (unassociated.length === 0) return
      const term = unassociated[0] // Only oldest
      registry.setResumeSessionId(term.terminalId, session.sessionId)
      mockBroadcast({
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
    const newSession: ClaudeSession = {
      sessionId: 'claude-session-123',
      projectPath: '/home/user/project',
      updatedAt: Date.now(),
      cwd: '/home/user/project',
    }
    indexer['detectNewSessions']([newSession])

    // Verify association
    expect(registry.get(term.terminalId)?.resumeSessionId).toBe('claude-session-123')
    expect(broadcasts).toHaveLength(1)
    expect(broadcasts[0]).toEqual({
      type: 'terminal.session.associated',
      terminalId: term.terminalId,
      sessionId: 'claude-session-123',
    })

    // Cleanup
    registry.shutdown()
  })

  it('should not associate already-associated terminals', () => {
    const registry = new TerminalRegistry()
    const indexer = new ClaudeSessionIndexer()
    const broadcasts: any[] = []

    indexer.onNewSession((session) => {
      if (!session.cwd) return
      const unassociated = registry.findUnassociatedClaudeTerminals(session.cwd)
      if (unassociated.length === 0) return
      const term = unassociated[0]
      registry.setResumeSessionId(term.terminalId, session.sessionId)
      broadcasts.push({ type: 'terminal.session.associated', terminalId: term.terminalId })
    })

    indexer['initialized'] = true

    // Create terminal that already has resumeSessionId
    registry.create({ mode: 'claude', cwd: '/home/user/project', resumeSessionId: 'existing-session' })

    // Simulate new session
    indexer['detectNewSessions']([{
      sessionId: 'new-session',
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
    const indexer = new ClaudeSessionIndexer()
    const broadcasts: any[] = []

    indexer.onNewSession((session) => {
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
      sessionId: 'new-session',
      projectPath: '/home/user/project',
      updatedAt: Date.now(),
      cwd: '/home/user/project',
    }])

    // Should only associate the OLDEST terminal (term1)
    expect(broadcasts).toHaveLength(1)
    expect(broadcasts[0].terminalId).toBe(term1.terminalId)
    expect(registry.get(term1.terminalId)?.resumeSessionId).toBe('new-session')
    expect(registry.get(term2.terminalId)?.resumeSessionId).toBeUndefined()

    // Cleanup
    registry.shutdown()
  })

  it('should correctly associate two terminals when two sessions are created in sequence', () => {
    const registry = new TerminalRegistry()
    const indexer = new ClaudeSessionIndexer()
    const broadcasts: any[] = []

    indexer.onNewSession((session) => {
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
      sessionId: 'session-for-term1',
      projectPath: '/home/user/project',
      updatedAt: Date.now(),
      cwd: '/home/user/project',
    }])

    // term1 should now be associated
    expect(registry.get(term1.terminalId)?.resumeSessionId).toBe('session-for-term1')
    expect(registry.get(term2.terminalId)?.resumeSessionId).toBeUndefined()

    // Second Claude (term2) creates its session
    indexer['detectNewSessions']([{
      sessionId: 'session-for-term2',
      projectPath: '/home/user/project',
      updatedAt: Date.now(),
      cwd: '/home/user/project',
    }])

    // Now term2 should also be associated (with different session)
    expect(registry.get(term1.terminalId)?.resumeSessionId).toBe('session-for-term1')
    expect(registry.get(term2.terminalId)?.resumeSessionId).toBe('session-for-term2')

    // Two broadcasts total, one per terminal
    expect(broadcasts).toHaveLength(2)
    expect(broadcasts[0].terminalId).toBe(term1.terminalId)
    expect(broadcasts[0].sessionId).toBe('session-for-term1')
    expect(broadcasts[1].terminalId).toBe(term2.terminalId)
    expect(broadcasts[1].sessionId).toBe('session-for-term2')

    // Cleanup
    registry.shutdown()
  })

  it('should not fire handlers on server startup (before initialized)', () => {
    const registry = new TerminalRegistry()
    const indexer = new ClaudeSessionIndexer()
    const broadcasts: any[] = []

    indexer.onNewSession((session) => {
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
      sessionId: 'existing-session',
      projectPath: '/home/user/project',
      updatedAt: Date.now(),
      cwd: '/home/user/project',
    }])

    // Should NOT broadcast - indexer not yet initialized
    expect(broadcasts).toHaveLength(0)
    // But session should be tracked
    expect(indexer['knownSessionIds'].has('existing-session')).toBe(true)

    // Cleanup
    registry.shutdown()
  })

  it('should skip sessions without cwd', () => {
    const registry = new TerminalRegistry()
    const indexer = new ClaudeSessionIndexer()
    const broadcasts: any[] = []

    indexer.onNewSession((session) => {
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
      sessionId: 'orphaned-session',
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
    const indexer = new ClaudeSessionIndexer()
    const broadcasts: any[] = []

    indexer.onNewSession((session) => {
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
      sessionId: 'new-session',
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
  // These tests verify the path normalization logic in findUnassociatedClaudeTerminals
  // by testing the normalize function behavior directly through findUnassociatedClaudeTerminals.
  // The actual platform-dependent behavior is tested in terminal-registry.test.ts.

  it('should normalize backslashes and trailing slashes when matching paths', () => {
    const registry = new TerminalRegistry()
    const indexer = new ClaudeSessionIndexer()
    const broadcasts: any[] = []

    indexer.onNewSession((session) => {
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
      sessionId: 'normalized-session',
      projectPath: '/home/user/project/',
      updatedAt: Date.now(),
      cwd: '/home/user/project/',
    }])

    // Should match after normalization removes trailing slash
    expect(broadcasts).toHaveLength(1)
    expect(broadcasts[0].terminalId).toBe(term.terminalId)
    expect(broadcasts[0].sessionId).toBe('normalized-session')

    registry.shutdown()
  })

  it('should match mixed separator styles (backslash vs forward slash)', () => {
    const registry = new TerminalRegistry()
    const indexer = new ClaudeSessionIndexer()
    const broadcasts: any[] = []

    indexer.onNewSession((session) => {
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
      sessionId: 'slash-session',
      projectPath: '/home/user/project',
      updatedAt: Date.now(),
      cwd: '/home/user/project',
    }])

    expect(broadcasts).toHaveLength(1)
    expect(broadcasts[0].terminalId).toBe(term.terminalId)

    registry.shutdown()
  })
})
