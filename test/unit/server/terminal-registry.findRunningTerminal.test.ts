import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'

// Mock node-pty before importing TerminalRegistry
vi.mock('node-pty', () => ({
  spawn: vi.fn(() => {
    const emitter = new EventEmitter()
    return {
      pid: 12345,
      cols: 120,
      rows: 30,
      process: 'mock-shell',
      handleFlowControl: false,
      onData: vi.fn((handler: (data: string) => void) => {
        emitter.on('data', handler)
        return { dispose: () => emitter.off('data', handler) }
      }),
      onExit: vi.fn((handler: (e: { exitCode: number }) => void) => {
        emitter.on('exit', handler)
        return { dispose: () => emitter.off('exit', handler) }
      }),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
    }
  }),
}))

vi.mock('../../../server/logger', () => {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => logger),
  }
  return { logger }
})

vi.mock('../../../server/perf-logger', () => ({
  getPerfConfig: () => ({ enabled: false }),
  logPerfEvent: vi.fn(),
  shouldLog: () => false,
  startPerfTimer: () => vi.fn(),
}))

import { TerminalRegistry } from '../../../server/terminal-registry'

describe('TerminalRegistry.findRunningTerminalBySession', () => {
  let registry: TerminalRegistry

  beforeEach(() => {
    registry = new TerminalRegistry(undefined, 50, 200)
  })

  afterEach(() => {
    registry.shutdown()
  })

  it('finds a running codex terminal by mode and sessionId', () => {
    const record = registry.create({ mode: 'codex', resumeSessionId: 'codex-session-1' })
    const found = registry.findRunningTerminalBySession('codex', 'codex-session-1')
    expect(found).toBeDefined()
    expect(found!.terminalId).toBe(record.terminalId)
  })

  it('finds a running claude terminal by mode and sessionId', () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440000'
    const record = registry.create({ mode: 'claude', resumeSessionId: sessionId })
    const found = registry.findRunningTerminalBySession('claude', sessionId)
    expect(found).toBeDefined()
    expect(found!.terminalId).toBe(record.terminalId)
  })

  it('returns undefined for wrong mode', () => {
    registry.create({ mode: 'codex', resumeSessionId: 'codex-session-1' })
    const found = registry.findRunningTerminalBySession('claude', 'codex-session-1')
    expect(found).toBeUndefined()
  })

  it('returns undefined for exited terminal', () => {
    const record = registry.create({ mode: 'codex', resumeSessionId: 'codex-session-1' })
    registry.kill(record.terminalId)
    const found = registry.findRunningTerminalBySession('codex', 'codex-session-1')
    expect(found).toBeUndefined()
  })

  it('returns undefined when no match exists', () => {
    const found = registry.findRunningTerminalBySession('codex', 'nonexistent')
    expect(found).toBeUndefined()
  })

  it('findRunningClaudeTerminalBySession still works (backward compat)', () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440000'
    const record = registry.create({ mode: 'claude', resumeSessionId: sessionId })
    const found = registry.findRunningClaudeTerminalBySession(sessionId)
    expect(found).toBeDefined()
    expect(found!.terminalId).toBe(record.terminalId)
  })

  it('getCanonicalRunningTerminalBySession returns the authoritative owner', () => {
    const sessionId = 'codex-session-1'
    const record = registry.create({ mode: 'codex', resumeSessionId: sessionId })
    const found = registry.getCanonicalRunningTerminalBySession('codex', sessionId)
    expect(found).toBeDefined()
    expect(found!.terminalId).toBe(record.terminalId)
  })

  it('repairLegacySessionOwners keeps canonical owner and clears duplicate records', () => {
    const sessionId = 'codex-session-legacy'
    const canonical = registry.create({ mode: 'codex', resumeSessionId: sessionId })
    const duplicate = registry.create({ mode: 'codex' })

    // Simulate legacy duplicate record that bypassed authority.
    const dupRecord = registry.get(duplicate.terminalId)
    if (!dupRecord) throw new Error('Expected duplicate record')
    dupRecord.resumeSessionId = sessionId

    const repair = registry.repairLegacySessionOwners('codex', sessionId)
    expect(repair.repaired).toBe(true)
    expect(repair.canonicalTerminalId).toBe(canonical.terminalId)
    expect(repair.clearedTerminalIds).toEqual([duplicate.terminalId])

    expect(registry.get(canonical.terminalId)?.resumeSessionId).toBe(sessionId)
    expect(registry.get(duplicate.terminalId)?.resumeSessionId).toBeUndefined()
  })
})
