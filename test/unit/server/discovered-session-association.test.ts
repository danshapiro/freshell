import { describe, expect, it, vi } from 'vitest'
import { DiscoveredSessionAssociation } from '../../../server/discovered-session-association'
import type { CodingCliSession } from '../../../server/coding-cli/types'

function createCodexSession(overrides: Partial<CodingCliSession> = {}): CodingCliSession {
  return {
    provider: 'codex',
    sessionId: 'codex-session-1',
    projectPath: '/repo/project',
    lastActivityAt: 2_000,
    cwd: '/repo/project',
    ...overrides,
  }
}

describe('DiscoveredSessionAssociation', () => {
  it('binds codex sessions by launchOrigin terminalId instead of oldest same-cwd terminal', () => {
    const registry = {
      get: vi.fn((terminalId: string) => {
        if (terminalId === 'term-2') {
          return {
            terminalId: 'term-2',
            mode: 'codex',
            status: 'running',
          }
        }
        if (terminalId === 'term-1') {
          return {
            terminalId: 'term-1',
            mode: 'codex',
            status: 'running',
          }
        }
        return null
      }),
      bindSession: vi.fn(() => ({ ok: true, terminalId: 'term-2', sessionId: 'codex-session-1' })),
      isSessionBound: vi.fn(() => false),
    }
    const association = new DiscoveredSessionAssociation(registry as any)

    const result = association.associateSingleSession(createCodexSession({
      launchOrigin: {
        terminalId: 'term-2',
        tabId: 'tab-2',
        paneId: 'pane-2',
      },
    }))

    expect(result).toEqual({ associated: true, terminalId: 'term-2' })
    expect(registry.bindSession).toHaveBeenCalledWith('term-2', 'codex', 'codex-session-1', 'association')
  })

  it('tracks advanced codex sessions, leaves unproven sessions unbound, and binds once provenance appears', () => {
    const registry = {
      get: vi.fn((terminalId: string) => (
        terminalId === 'term-2'
          ? { terminalId: 'term-2', mode: 'codex', status: 'running' }
          : null
      )),
      bindSession: vi.fn(() => ({ ok: true, terminalId: 'term-2', sessionId: 'codex-session-1' })),
      isSessionBound: vi.fn(() => false),
    }
    const association = new DiscoveredSessionAssociation(registry as any)

    const firstPass = association.collectNewOrAdvanced([{
      projectPath: '/repo/project',
      sessions: [createCodexSession({ lastActivityAt: 10_000 })],
    }])
    expect(firstPass).toHaveLength(1)
    expect(association.associateSingleSession(firstPass[0]!)).toEqual({ associated: false })
    expect(registry.bindSession).not.toHaveBeenCalled()

    const secondPass = association.collectNewOrAdvanced([{
      projectPath: '/repo/project',
      sessions: [createCodexSession({
        lastActivityAt: 10_001,
        launchOrigin: {
          terminalId: 'term-2',
          tabId: 'tab-2',
          paneId: 'pane-2',
        },
      })],
    }])
    expect(secondPass).toHaveLength(1)
    expect(association.associateSingleSession(secondPass[0]!)).toEqual({
      associated: true,
      terminalId: 'term-2',
    })
    expect(registry.bindSession).toHaveBeenCalledTimes(1)
  })

  it('treats newly discovered launch provenance as advanced even when lastActivityAt is unchanged', () => {
    const registry = {
      get: vi.fn((terminalId: string) => (
        terminalId === 'term-2'
          ? { terminalId: 'term-2', mode: 'codex', status: 'running' }
          : null
      )),
      bindSession: vi.fn(() => ({ ok: true, terminalId: 'term-2', sessionId: 'codex-session-1' })),
      isSessionBound: vi.fn(() => false),
    }
    const association = new DiscoveredSessionAssociation(registry as any)

    const firstPass = association.collectNewOrAdvanced([{
      projectPath: '/repo/project',
      sessions: [createCodexSession({ lastActivityAt: 10_000 })],
    }])
    expect(firstPass).toHaveLength(1)
    expect(association.associateSingleSession(firstPass[0]!)).toEqual({ associated: false })

    const secondPass = association.collectNewOrAdvanced([{
      projectPath: '/repo/project',
      sessions: [createCodexSession({
        lastActivityAt: 10_000,
        launchOrigin: {
          terminalId: 'term-2',
          tabId: 'tab-2',
          paneId: 'pane-2',
        },
      })],
    }])
    expect(secondPass).toHaveLength(1)
    expect(association.associateSingleSession(secondPass[0]!)).toEqual({
      associated: true,
      terminalId: 'term-2',
    })
    expect(registry.bindSession).toHaveBeenCalledTimes(1)
  })

  it('does not rebind codex sessions on repeated non-advanced updates after exact binding', () => {
    const registry = {
      get: vi.fn(() => ({ terminalId: 'term-2', mode: 'codex', status: 'running' })),
      bindSession: vi.fn(() => ({ ok: true, terminalId: 'term-2', sessionId: 'codex-session-1' })),
      isSessionBound: vi.fn()
        .mockReturnValueOnce(false)
        .mockReturnValue(true),
    }
    const association = new DiscoveredSessionAssociation(registry as any)
    const projects = [{
      projectPath: '/repo/project',
      sessions: [createCodexSession({
        lastActivityAt: 20_000,
        launchOrigin: {
          terminalId: 'term-2',
          tabId: 'tab-2',
          paneId: 'pane-2',
        },
      })],
    }]

    const initial = association.collectNewOrAdvanced(projects)
    expect(initial).toHaveLength(1)
    expect(association.associateSingleSession(initial[0]!)).toEqual({
      associated: true,
      terminalId: 'term-2',
    })

    const repeated = association.collectNewOrAdvanced(projects)
    expect(repeated).toHaveLength(0)
    expect(registry.bindSession).toHaveBeenCalledTimes(1)
  })
})
