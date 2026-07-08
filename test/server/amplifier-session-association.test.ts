/**
 * Amplifier association integration tests (plan 2026-07-08 §5 / §9 Phase 3).
 *
 * 1. Full locator flow: armed amplifier terminal → PTY submit → session dir
 *    written on disk → controller binds → terminal.session.associated broadcast
 *    with lifecycle source 'amplifier_locator' + events tailer attach at start.
 * 2. Fast-path variant: an amplifier session discovered via the indexer's
 *    onNewSession binds a still-unbound terminal (locator-missed simulation)
 *    through the coordinator, broadcast source 'amplifier_new_session'.
 * 3. Fast-path guard widening does not regress the claude path.
 */
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TerminalRegistry,
  registerCodingCliCommands,
  type CodingCliCommandSpec,
} from '../../server/terminal-registry'
import { CodingCliSessionIndexer } from '../../server/coding-cli/session-indexer'
import { SessionAssociationCoordinator } from '../../server/session-association-coordinator'
import { broadcastTerminalSessionAssociation } from '../../server/session-association-broadcast'
import { AmplifierSessionLocator } from '../../server/coding-cli/amplifier-session-locator'
import { AmplifierSessionController } from '../../server/coding-cli/amplifier-session-controller'
import { recordSessionLifecycleEvent } from '../../server/session-observability'

vi.mock('node-pty', () => ({
  spawn: vi.fn(() => ({
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
  })),
}))

vi.mock('../../server/mcp/config-writer.js', () => ({
  generateMcpInjection: vi.fn(() => ({ args: [], env: {} })),
  cleanupMcpConfig: vi.fn(),
}))

vi.mock('../../server/session-observability.js', () => ({
  recordSessionLifecycleEvent: vi.fn(),
}))

const SCHEMA = { name: 'amplifier.log', ver: '1.0.0' }

function eventsJsonl(sessionId: string, cwd: string): string {
  const start = {
    ts: new Date().toISOString(),
    lvl: 'INFO',
    schema: SCHEMA,
    event: 'session:start',
    session_id: sessionId,
    data: { parent_id: null },
  }
  const config = {
    ts: new Date().toISOString(),
    lvl: 'INFO',
    schema: SCHEMA,
    event: 'session:config',
    session_id: sessionId,
    data: { raw: { working_dir: cwd, project_dir: cwd } },
  }
  return `${JSON.stringify(start)}\n${JSON.stringify(config)}\n`
}

async function waitFor(
  predicate: () => boolean,
  { timeoutMs = 8_000, intervalMs = 20, message = 'condition' } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new Error(`Timed out waiting for ${message}`)
}

const COMMAND_SPECS: Array<[string, CodingCliCommandSpec]> = [
  ['claude', {
    label: 'Claude CLI',
    envVar: 'CLAUDE_CMD',
    defaultCommand: 'claude',
    resumeArgs: (sessionId: string) => ['--resume', sessionId],
    createSessionArgs: (sessionId: string) => ['--session-id', sessionId],
  }],
  ['amplifier', {
    label: 'Amplifier',
    envVar: 'AMPLIFIER_CMD',
    defaultCommand: 'amplifier',
    resumeArgs: (sessionId: string) => ['resume', sessionId],
  }],
]

const SESSION_ID = '9e107d9d-3721-4b28-b2f1-aab1c826dcaf'
const CLAUDE_SESSION_ID = '550e8400-e29b-41d4-a716-446655440000'

beforeEach(() => {
  registerCodingCliCommands(new Map(COMMAND_SPECS))
  vi.mocked(recordSessionLifecycleEvent).mockClear()
})

describe('amplifier locator association end-to-end', () => {
  const cleanups: Array<() => Promise<void> | void> = []

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()!()
    }
  })

  it('binds an armed terminal from a fixture-written session dir and broadcasts with source amplifier_locator', async () => {
    const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-amp-assoc-home-'))
    const cwdRaw = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-amp-assoc-cwd-'))
    const cwd = await fsp.realpath(cwdRaw)
    await fsp.mkdir(path.join(home, 'projects'), { recursive: true })
    cleanups.push(() => fsp.rm(home, { recursive: true, force: true }))
    cleanups.push(() => fsp.rm(cwdRaw, { recursive: true, force: true }))

    const registry = new TerminalRegistry()
    cleanups.push(() => registry.shutdown())

    const locator = new AmplifierSessionLocator({
      registry,
      amplifierHome: home,
      log: { warn: vi.fn() },
      windowMs: 400,
      probePollMs: 25,
    })
    cleanups.push(() => locator.dispose())
    const controller = new AmplifierSessionController({ registry, locator })
    cleanups.push(() => controller.dispose())

    const broadcasts: any[] = []
    const wsHandler = { broadcast: (message: unknown) => broadcasts.push(message) }
    const attachCalls: any[] = []
    // Mirrors the index.ts wiring: controller 'associated' → shared broadcast
    // helper + integration.attachTailer at offset 0.
    controller.on('associated', ({ terminalId, sessionId, eventsPath }) => {
      broadcastTerminalSessionAssociation({
        wsHandler,
        terminalMetadata: { associateSession: () => undefined } as any,
        broadcastTerminalMetaUpserts: () => {},
        provider: 'amplifier',
        terminalId,
        sessionId,
        source: 'amplifier_locator',
      })
      attachCalls.push([terminalId, sessionId, eventsPath, 'start'])
    })

    const terminal = registry.create({ mode: 'amplifier', cwd })
    expect(terminal.resumeSessionId).toBeUndefined()
    await locator.whenReady()

    registry.input(terminal.terminalId, '\r')
    const sessionDir = path.join(home, 'projects', 'slug', 'sessions', SESSION_ID)
    await fsp.mkdir(sessionDir, { recursive: true })
    await fsp.writeFile(path.join(sessionDir, 'events.jsonl'), eventsJsonl(SESSION_ID, cwd), 'utf8')

    await waitFor(
      () => broadcasts.some((m) => m.type === 'terminal.session.associated'),
      { message: 'terminal.session.associated broadcast' },
    )

    expect(broadcasts).toContainEqual({
      type: 'terminal.session.associated',
      terminalId: terminal.terminalId,
      sessionRef: { provider: 'amplifier', sessionId: SESSION_ID },
    })
    expect(registry.get(terminal.terminalId)?.resumeSessionId).toBe(SESSION_ID)
    expect(recordSessionLifecycleEvent).toHaveBeenCalledWith({
      kind: 'session_association_broadcast',
      provider: 'amplifier',
      terminalId: terminal.terminalId,
      sessionId: SESSION_ID,
      source: 'amplifier_locator',
    })
    expect(attachCalls).toEqual([[
      terminal.terminalId,
      SESSION_ID,
      path.join(sessionDir, 'events.jsonl'),
      'start',
    ]])
    // The locator unregisters on bind and stops its watcher.
    await waitFor(() => locator.armedCount() === 0, { message: 'locator disarm after bind' })
  })
})

describe('amplifier fast path via indexer onNewSession', () => {
  function setupFastPath() {
    const registry = new TerminalRegistry()
    const indexer = new CodingCliSessionIndexer([])
    const coordinator = new SessionAssociationCoordinator(registry, 30_000)
    const broadcasts: any[] = []
    const wsHandler = { broadcast: (message: unknown) => broadcasts.push(message) }

    // Replicates the widened index.ts onNewSession fast path (claude + amplifier).
    indexer.onNewSession((session) => {
      if (session.provider !== 'claude' && session.provider !== 'amplifier') return
      if (!session.cwd) return
      const provider = session.provider
      const shouldAssociate = coordinator.noteSession({
        provider,
        sessionId: session.sessionId,
        projectPath: session.projectPath,
        lastActivityAt: session.lastActivityAt,
        cwd: session.cwd,
      })
      if (!shouldAssociate) return
      const result = coordinator.associateSingleSession({
        provider,
        sessionId: session.sessionId,
        projectPath: session.projectPath,
        lastActivityAt: session.lastActivityAt,
        cwd: session.cwd,
      })
      if (!result.associated || !result.terminalId) return
      broadcastTerminalSessionAssociation({
        wsHandler,
        terminalMetadata: { associateSession: () => undefined } as any,
        broadcastTerminalMetaUpserts: () => {},
        provider,
        terminalId: result.terminalId,
        sessionId: session.sessionId,
        source: provider === 'claude' ? 'claude_new_session' : 'amplifier_new_session',
      })
    })
    ;(indexer as any)['initialized'] = true
    return { registry, indexer, broadcasts }
  }

  it('binds a still-unbound amplifier terminal with source amplifier_new_session', () => {
    const { registry, indexer, broadcasts } = setupFastPath()
    const terminal = registry.create({ mode: 'amplifier', cwd: '/home/user/project' })

    ;(indexer as any)['detectNewSessions']([{
      provider: 'amplifier',
      sessionId: SESSION_ID,
      projectPath: '/home/user/project',
      lastActivityAt: Date.now(),
      cwd: '/home/user/project',
    }])

    expect(registry.get(terminal.terminalId)?.resumeSessionId).toBe(SESSION_ID)
    expect(broadcasts).toContainEqual({
      type: 'terminal.session.associated',
      terminalId: terminal.terminalId,
      sessionRef: { provider: 'amplifier', sessionId: SESSION_ID },
    })
    expect(recordSessionLifecycleEvent).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'session_association_broadcast',
      provider: 'amplifier',
      source: 'amplifier_new_session',
    }))

    registry.shutdown()
  })

  it('does not regress the claude fast path (source claude_new_session)', () => {
    const { registry, indexer, broadcasts } = setupFastPath()
    const terminal = registry.create({ mode: 'claude', cwd: '/home/user/project' })

    ;(indexer as any)['detectNewSessions']([{
      provider: 'claude',
      sessionId: CLAUDE_SESSION_ID,
      projectPath: '/home/user/project',
      lastActivityAt: Date.now(),
      cwd: '/home/user/project',
    }])

    expect(registry.get(terminal.terminalId)?.resumeSessionId).toBe(CLAUDE_SESSION_ID)
    expect(broadcasts).toContainEqual({
      type: 'terminal.session.associated',
      terminalId: terminal.terminalId,
      sessionRef: { provider: 'claude', sessionId: CLAUDE_SESSION_ID },
    })
    expect(recordSessionLifecycleEvent).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'session_association_broadcast',
      provider: 'claude',
      source: 'claude_new_session',
    }))

    registry.shutdown()
  })

  it('ignores other providers in the widened guard', () => {
    const { registry, indexer, broadcasts } = setupFastPath()
    registry.create({ mode: 'claude', cwd: '/home/user/project' })

    ;(indexer as any)['detectNewSessions']([{
      provider: 'codex',
      sessionId: 'codex-session-1',
      projectPath: '/home/user/project',
      lastActivityAt: Date.now(),
      cwd: '/home/user/project',
    }])

    expect(broadcasts).toHaveLength(0)
    registry.shutdown()
  })
})
