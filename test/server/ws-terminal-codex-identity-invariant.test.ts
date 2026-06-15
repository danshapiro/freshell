import { describe, expect, it, vi } from 'vitest'
import http from 'http'
import WebSocket from 'ws'
import { WsHandler } from '../../server/ws-handler.js'
import { CODEX_DURABILITY_SCHEMA_VERSION } from '../../shared/codex-durability.js'
import {
  buildSessionIdentityMismatchDetails,
  terminalMatchesExpectedSession,
} from '../../server/terminal-session-identity.js'

class FakeBuffer {
  snapshot() {
    return 'stale output'
  }
}

function createAuthenticatedState() {
  return {
    authenticated: true,
    supportsUiScreenshotV1: false,
    supportsTerminalOutputBatchV1: false,
    attachedTerminalIds: new Set<string>(),
    createdByRequestId: new Map(),
    claudeFreshSessionIdByRequestId: new Map(),
    terminalCreateTimestamps: [],
    codingCliSessions: new Set<string>(),
    codingCliSubscriptions: new Map(),
    sdkSessions: new Set<string>(),
    sdkSubscriptions: new Map(),
    sdkSessionTargets: new Map(),
    freshAgentSubscriptions: new Map(),
    wsErrorLogs: new Map(),
    interestedSessions: new Set<string>(),
    sidebarOpenSessionKeys: new Set<string>(),
  }
}

function createOpenFakeWs(connectionId: string, sent: any[]) {
  return {
    readyState: WebSocket.OPEN,
    bufferedAmount: 0,
    connectionId,
    send: vi.fn((payload: string, cb?: (err?: Error) => void) => {
      sent.push(JSON.parse(payload))
      cb?.()
    }),
    close: vi.fn(),
  }
}

class FakeRegistry {
  attachCalls: Array<{ terminalId: string }> = []
  inputCalls: Array<{ terminalId: string; data: string }> = []
  resizeCalls: Array<{ terminalId: string; cols: number; rows: number }> = []

  constructor(private record: any) {}

  get(terminalId: string) {
    return terminalId === this.record.terminalId ? this.record : null
  }

  attach(terminalId: string, _ws: any) {
    if (terminalId !== this.record.terminalId) return null
    this.attachCalls.push({ terminalId })
    return this.record
  }

  detach() {
    return true
  }

  inputIfSessionMatches(terminalId: string, data: string, expectedSessionRef?: { provider: string; sessionId: string }) {
    if (terminalId !== this.record.terminalId) return { status: 'no_terminal' as const }
    if (expectedSessionRef && !terminalMatchesExpectedSession(this.record, expectedSessionRef)) {
      return {
        status: 'session_identity_mismatch' as const,
        terminalId,
        ...buildSessionIdentityMismatchDetails(this.record, expectedSessionRef),
      }
    }
    this.inputCalls.push({ terminalId, data })
    return { status: 'written' as const }
  }

  resizeIfSessionMatches(terminalId: string, cols: number, rows: number, expectedSessionRef?: { provider: string; sessionId: string }) {
    if (terminalId !== this.record.terminalId) return { status: 'missing' as const }
    if (expectedSessionRef && !terminalMatchesExpectedSession(this.record, expectedSessionRef)) {
      return {
        status: 'session_identity_mismatch' as const,
        terminalId,
        ...buildSessionIdentityMismatchDetails(this.record, expectedSessionRef),
      }
    }
    this.resizeCalls.push({ terminalId, cols, rows })
    return { status: 'resized' as const }
  }

  resize(terminalId: string, cols: number, rows: number) {
    const result = this.resizeIfSessionMatches(terminalId, cols, rows)
    return result.status === 'resized'
  }

  input(terminalId: string, data: string) {
    return this.inputIfSessionMatches(terminalId, data)
  }

  list() {
    return []
  }
}

describe('ws terminal codex identity invariant', () => {
  it('rejects attach, input, and resize when canonical Codex identity mismatches', async () => {
    process.env.AUTH_TOKEN = 'testtoken-testtoken'
    const record = {
      terminalId: 'term-old',
      createdAt: Date.now(),
      title: 'Codex',
      mode: 'codex',
      shell: 'system',
      status: 'running',
      cols: 80,
      rows: 24,
      resumeSessionId: 'thread-old',
      codexDurability: {
        schemaVersion: CODEX_DURABILITY_SCHEMA_VERSION,
        state: 'durable',
        durableThreadId: 'thread-old',
      },
      buffer: new FakeBuffer(),
      clients: new Set(),
    }
    const registry = new FakeRegistry(record)
    const handler = new WsHandler(http.createServer(), registry as any)
    const sent: any[] = []
    const ws = createOpenFakeWs('conn-1', sent)
    const state = createAuthenticatedState()

    await (handler as any).onMessage(ws, state, Buffer.from(JSON.stringify({
      type: 'terminal.attach',
      terminalId: 'term-old',
      expectedSessionRef: { provider: 'codex', sessionId: 'thread-new' },
      intent: 'viewport_hydrate',
      cols: 120,
      rows: 40,
      attachRequestId: 'attach-1',
      sinceSeq: 0,
    })))
    await (handler as any).onMessage(ws, state, Buffer.from(JSON.stringify({
      type: 'terminal.input',
      terminalId: 'term-old',
      expectedSessionRef: { provider: 'codex', sessionId: 'thread-new' },
      data: 'echo wrong thread',
    })))
    await (handler as any).onMessage(ws, state, Buffer.from(JSON.stringify({
      type: 'terminal.resize',
      terminalId: 'term-old',
      expectedSessionRef: { provider: 'codex', sessionId: 'thread-new' },
      cols: 100,
      rows: 30,
    })))

    expect(sent).toEqual([
      expect.objectContaining({
        type: 'error',
        code: 'SESSION_IDENTITY_MISMATCH',
        requestId: 'attach-1',
        terminalId: 'term-old',
        expectedSessionRef: { provider: 'codex', sessionId: 'thread-new' },
        actualSessionRef: { provider: 'codex', sessionId: 'thread-old' },
      }),
      expect.objectContaining({
        type: 'error',
        code: 'SESSION_IDENTITY_MISMATCH',
        terminalId: 'term-old',
        expectedSessionRef: { provider: 'codex', sessionId: 'thread-new' },
        actualSessionRef: { provider: 'codex', sessionId: 'thread-old' },
      }),
      expect.objectContaining({
        type: 'error',
        code: 'SESSION_IDENTITY_MISMATCH',
        terminalId: 'term-old',
        expectedSessionRef: { provider: 'codex', sessionId: 'thread-new' },
        actualSessionRef: { provider: 'codex', sessionId: 'thread-old' },
      }),
    ])
    expect(sent.some((msg) => msg.type === 'terminal.attach.ready')).toBe(false)
    expect(registry.attachCalls).toHaveLength(0)
    expect(registry.inputCalls).toHaveLength(0)
    expect(registry.resizeCalls).toHaveLength(0)
  })

  it('does not treat candidate-only Codex durability as side-effect authority', async () => {
    process.env.AUTH_TOKEN = 'testtoken-testtoken'
    const record = {
      terminalId: 'term-candidate',
      createdAt: Date.now(),
      title: 'Codex',
      mode: 'codex',
      shell: 'system',
      status: 'running',
      cols: 80,
      rows: 24,
      resumeSessionId: 'thread-candidate',
      codexDurability: {
        schemaVersion: CODEX_DURABILITY_SCHEMA_VERSION,
        state: 'proof_checking',
        candidate: {
          provider: 'codex',
          candidateThreadId: 'thread-candidate',
          rolloutPath: '/tmp/freshell-rollout.jsonl',
          source: 'restored_client_state',
          capturedAt: 1,
        },
      },
      buffer: new FakeBuffer(),
      clients: new Set(),
    }
    const registry = new FakeRegistry(record)
    const handler = new WsHandler(http.createServer(), registry as any)
    const sent: any[] = []
    const ws = createOpenFakeWs('conn-2', sent)
    const state = createAuthenticatedState()

    await (handler as any).onMessage(ws, state, Buffer.from(JSON.stringify({
      type: 'terminal.input',
      terminalId: 'term-candidate',
      expectedSessionRef: { provider: 'codex', sessionId: 'thread-candidate' },
      data: 'echo still blocked',
    })))

    expect(sent).toEqual([
      expect.objectContaining({
        type: 'error',
        code: 'SESSION_IDENTITY_MISMATCH',
        terminalId: 'term-candidate',
        expectedSessionRef: { provider: 'codex', sessionId: 'thread-candidate' },
      }),
    ])
    expect(registry.inputCalls).toHaveLength(0)
  })
})
