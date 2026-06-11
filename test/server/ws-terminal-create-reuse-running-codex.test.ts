import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import http from 'http'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import WebSocket from 'ws'
import { WS_PROTOCOL_VERSION } from '../../shared/ws-protocol'
import { WsHandler } from '../../server/ws-handler'
import { FakeCodexLaunchPlanner, DEFAULT_CODEX_REMOTE_WS_URL } from '../helpers/coding-cli/fake-codex-launch-planner.js'

const TEST_TIMEOUT_MS = 60_000
const HOOK_TIMEOUT_MS = 30_000
const MESSAGE_TIMEOUT_MS = 5_000
const PROOF_MESSAGE_TIMEOUT_MS = 15_000
const PROOF_TEST_TIMEOUT_MS = 60_000
const CODEX_SESSION_ID = 'codex-session-abc-123'
const CODEX_REMOTE_WS_URL = DEFAULT_CODEX_REMOTE_WS_URL

vi.setConfig({ testTimeout: TEST_TIMEOUT_MS, hookTimeout: HOOK_TIMEOUT_MS })

let activeSockets: WebSocket[] = []

function trackWebSocket(ws: WebSocket): WebSocket {
  activeSockets.push(ws)
  return ws
}

function waitForOpen(ws: WebSocket, timeoutMs = MESSAGE_TIMEOUT_MS): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout)
      ws.off('open', onOpen)
      ws.off('close', onClose)
      ws.off('error', onError)
    }

    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error('Timeout waiting for WebSocket open'))
    }, timeoutMs)

    const onOpen = () => {
      cleanup()
      resolve()
    }

    const onClose = () => {
      cleanup()
      reject(new Error('Socket closed waiting for open'))
    }

    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }

    if (ws.readyState === WebSocket.OPEN) {
      onOpen()
      return
    }

    if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
      onClose()
      return
    }

    ws.once('open', onOpen)
    ws.once('close', onClose)
    ws.once('error', onError)
  })
}

function listen(server: http.Server, timeoutMs = HOOK_TIMEOUT_MS): Promise<{ port: number }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out')), timeoutMs)
    const onError = (err: Error) => { clearTimeout(timeout); reject(err) }
    server.once('error', onError)
    server.listen(0, '127.0.0.1', () => {
      clearTimeout(timeout)
      server.off('error', onError)
      const addr = server.address()
      if (typeof addr === 'object' && addr) resolve({ port: addr.port })
    })
  })
}

function waitForMessage(ws: WebSocket, predicate: (msg: any) => boolean, timeoutMs = MESSAGE_TIMEOUT_MS): Promise<any> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout)
      ws.off('message', handler)
      ws.off('close', onClose)
      ws.off('error', onError)
    }

    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error('Timeout waiting for message'))
    }, timeoutMs)

    const handler = (data: WebSocket.Data) => {
      try {
        const msg = JSON.parse(data.toString())
        if (predicate(msg)) {
          cleanup()
          resolve(msg)
        }
      } catch {
        // Ignore malformed frames in tests.
      }
    }

    const onClose = () => {
      cleanup()
      reject(new Error('Socket closed waiting for message'))
    }

    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }

    if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
      onClose()
      return
    }

    ws.on('message', handler)
    ws.once('close', onClose)
    ws.once('error', onError)
  })
}

function waitForMessages(
  ws: WebSocket,
  predicates: Array<(msg: any) => boolean>,
  timeoutMs = MESSAGE_TIMEOUT_MS,
): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const matches: any[] = Array(predicates.length).fill(undefined)
    const timeout = setTimeout(() => {
      ws.off('message', handler)
      reject(new Error('Timeout waiting for messages'))
    }, timeoutMs)
    const handler = (data: WebSocket.Data) => {
      const msg = JSON.parse(data.toString())
      for (let i = 0; i < predicates.length; i += 1) {
        if (!matches[i] && predicates[i]?.(msg)) {
          matches[i] = msg
        }
      }
      if (matches.every((m) => m !== undefined)) {
        clearTimeout(timeout)
        ws.off('message', handler)
        resolve(matches)
      }
    }
    ws.on('message', handler)
  })
}

function waitForReady(ws: WebSocket): Promise<any> {
  const readyPromise = waitForMessage(ws, (m) => m.type === 'ready')
  ws.send(JSON.stringify({ type: 'hello', token: 'testtoken-testtoken', protocolVersion: WS_PROTOCOL_VERSION }))
  return readyPromise
}

function collectMessages(ws: WebSocket, durationMs: number): Promise<any[]> {
  return new Promise((resolve) => {
    const messages: any[] = []
    const handler = (data: WebSocket.Data) => {
      try {
        messages.push(JSON.parse(data.toString()))
      } catch {
        // ignore malformed test frames
      }
    }
    ws.on('message', handler)
    setTimeout(() => {
      ws.off('message', handler)
      resolve(messages)
    }, durationMs)
  })
}

function closeWebSocket(ws: WebSocket, timeoutMs = 1_000): Promise<void> {
  return new Promise((resolve) => {
    let settled = false
    if (ws.readyState === WebSocket.CLOSED) {
      resolve()
      return
    }

    const cleanup = () => {
      clearTimeout(timeout)
      ws.off('close', onClose)
      ws.off('error', onClose)
    }

    const finish = () => {
      if (settled) return
      settled = true
      cleanup()
      resolve()
    }

    const onClose = () => finish()

    const timeout = setTimeout(() => {
      if (ws.readyState !== WebSocket.CLOSED) {
        ws.terminate()
      }
      setTimeout(finish, 25)
    }, timeoutMs)

    ws.on('close', onClose)
    ws.on('error', onClose)

    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close()
    }
  })
}

function closeServer(serverToClose: http.Server, timeoutMs = 5_000): Promise<void> {
  return new Promise((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(forceClose)
      clearTimeout(timeout)
      resolve()
    }
    const forceClose = setTimeout(() => {
      serverToClose.closeIdleConnections?.()
      serverToClose.closeAllConnections?.()
    }, 50)
    const timeout = setTimeout(() => {
      serverToClose.closeIdleConnections?.()
      serverToClose.closeAllConnections?.()
      finish()
    }, timeoutMs)
    serverToClose.close(() => finish())
  })
}

class FakeBuffer {
  snapshot() { return 'codex session output' }
}

type FakeTerminal = {
  terminalId: string
  createdAt: number
  buffer: FakeBuffer
  title: string
  mode: 'codex'
  shell: 'system'
  status: 'running'
  cols: number
  rows: number
  resumeSessionId?: string
  codexDurability?: any
  clients: Set<WebSocket>
}

class FakeRegistry extends EventEmitter {
  records: FakeTerminal[]
  attachCalls: Array<{ terminalId: string; opts?: any }> = []
  createCalls: any[] = []
  repairCalls: Array<{ mode: string; sessionId: string }> = []
  candidatePersistedAcks: any[] = []
  promoteCalls: Array<{ terminalId: string; durableThreadId: string }> = []
  deletedDurabilityRecords: Array<{ terminalId: string; reason: string }> = []
  durabilityRestoreRecords: Array<{
    terminalId: string
    tabId?: string
    paneId?: string
    serverInstanceId?: string
    durability: any
  }> = []

  constructor(terminalIds: string[]) {
    super()
    const createdAt = Date.now()
    this.records = terminalIds.map((terminalId, idx) => ({
      terminalId,
      createdAt: createdAt + idx,
      buffer: new FakeBuffer(),
      title: 'Codex',
      mode: 'codex' as const,
      shell: 'system' as const,
      status: 'running' as const,
      cols: 80,
      rows: 24,
      resumeSessionId: CODEX_SESSION_ID,
      clients: new Set<WebSocket>(),
    }))
  }

  private findById(terminalId: string): FakeTerminal | undefined {
    return this.records.find((record) => record.terminalId === terminalId)
  }

  get(terminalId: string) {
    return this.findById(terminalId) ?? null
  }

  // Legacy non-canonical lookup returns newest matching record first.
  findRunningTerminalBySession(mode: string, sessionId: string) {
    if (mode !== 'codex' || sessionId !== CODEX_SESSION_ID) return undefined
    return this.records.slice().reverse().find((record) => record.status === 'running')
  }

  getCanonicalRunningTerminalBySession(mode: string, sessionId: string) {
    if (mode !== 'codex' || sessionId !== CODEX_SESSION_ID) return undefined
    return this.records.find((record) => record.status === 'running' && record.resumeSessionId === CODEX_SESSION_ID)
  }

  repairLegacySessionOwners(mode: string, sessionId: string) {
    this.repairCalls.push({ mode, sessionId })
    if (mode !== 'codex' || sessionId !== CODEX_SESSION_ID) return
    const canonical = this.records[0]
    this.records = this.records.map((record) => {
      if (record.terminalId === canonical?.terminalId) {
        return { ...record, resumeSessionId: CODEX_SESSION_ID }
      }
      return { ...record, resumeSessionId: undefined }
    })
  }

  bindSession(terminalId: string, mode: string, sessionId: string) {
    const record = this.findById(terminalId)
    if (!record || mode !== 'codex') return { ok: false, reason: 'terminal_missing' }
    record.resumeSessionId = sessionId
    return { ok: true, terminalId, sessionId }
  }

  async promoteCodexDurabilityFromCreateProof(terminalId: string, durableThreadId: string) {
    this.promoteCalls.push({ terminalId, durableThreadId })
    const bound = this.bindSession(terminalId, 'codex', durableThreadId)
    if (!bound.ok) return bound
    const record = this.findById(terminalId)
    if (record) {
      record.codexDurability = {
        schemaVersion: 1,
        state: 'durable',
        durableThreadId,
      }
      this.emit('terminal.codex.durability.updated', {
        terminalId,
        durability: record.codexDurability,
      })
    }
    return bound
  }

  findRunningClaudeTerminalBySession(sessionId: string) {
    return this.findRunningTerminalBySession('claude', sessionId)
  }

  findRunningCodexTerminalByCandidate(candidateThreadId: string, rolloutPath: string) {
    return this.records.find((record) => (
      record.status === 'running'
      && record.codexDurability?.candidate?.candidateThreadId === candidateThreadId
      && record.codexDurability?.candidate?.rolloutPath === rolloutPath
    ))
  }

  async readCodexDurabilityRecordForRestoreLocator(locator: {
    terminalId?: string
    tabId?: string
    paneId?: string
    serverInstanceId?: string
  }) {
    if (locator.terminalId) {
      const record = this.durabilityRestoreRecords.find((candidate) => candidate.terminalId === locator.terminalId)
      return record ? { terminalId: record.terminalId, durability: record.durability } : undefined
    }
    if (!locator.tabId || !locator.paneId) return undefined
    const matches = this.durabilityRestoreRecords.filter((record) => (
      record.tabId === locator.tabId
      && record.paneId === locator.paneId
      && (!locator.serverInstanceId || record.serverInstanceId === locator.serverInstanceId)
    ))
    if (matches.length > 1) throw new Error('ambiguous restore locator')
    return matches[0] ? { terminalId: matches[0].terminalId, durability: matches[0].durability } : undefined
  }

  async readCodexDurabilityForRestoreLocator(locator: {
    terminalId?: string
    tabId?: string
    paneId?: string
    serverInstanceId?: string
  }) {
    return (await this.readCodexDurabilityRecordForRestoreLocator(locator))?.durability
  }

  async deleteCodexDurabilityStoreRecord(terminalId: string, reason: string) {
    this.deletedDurabilityRecords.push({ terminalId, reason })
    this.durabilityRestoreRecords = this.durabilityRestoreRecords.filter((record) => record.terminalId !== terminalId)
  }

  attach(terminalId: string, ws: WebSocket, opts?: any) {
    this.attachCalls.push({ terminalId, opts })
    const record = this.findById(terminalId)
    if (!record) return null
    record.clients.add(ws)
    return record
  }

  detach(terminalId: string, ws: WebSocket) {
    const record = this.findById(terminalId)
    if (!record) return false
    record.clients.delete(ws)
    return true
  }

  create(opts: any) {
    this.createCalls.push(opts)
    return this.records[0]
  }

  resize(terminalId: string, cols: number, rows: number) {
    const record = this.findById(terminalId)
    if (!record) return false
    record.cols = cols
    record.rows = rows
    return true
  }

  list() { return [] }

  acknowledgeCodexCandidatePersisted(input: any) {
    this.candidatePersistedAcks.push(input)
    return 'accepted'
  }
}

describe('terminal.create reuse running codex terminal', () => {
  let server: http.Server | undefined
  let port: number
  let registry: FakeRegistry
  let codexLaunchPlanner: FakeCodexLaunchPlanner
  let originalNodeEnv: string | undefined
  let originalAuthToken: string | undefined
  let originalHelloTimeoutMs: string | undefined

  beforeEach(async () => {
    vi.useRealTimers()
    originalNodeEnv = process.env.NODE_ENV
    originalAuthToken = process.env.AUTH_TOKEN
    originalHelloTimeoutMs = process.env.HELLO_TIMEOUT_MS
    process.env.NODE_ENV = 'test'
    process.env.AUTH_TOKEN = 'testtoken-testtoken'
    process.env.HELLO_TIMEOUT_MS = '5000'
    activeSockets = []

    server = http.createServer((_req, res) => { res.statusCode = 404; res.end() })
    registry = new FakeRegistry(['term-codex-existing'])
    codexLaunchPlanner = new FakeCodexLaunchPlanner()
    new WsHandler(server, registry as any, { codexLaunchPlanner })
    const info = await listen(server)
    port = info.port
    registry.attachCalls = []
    registry.createCalls = []
    registry.repairCalls = []
    registry.candidatePersistedAcks = []
    registry.promoteCalls = []
    registry.deletedDurabilityRecords = []
    registry.durabilityRestoreRecords = []
  }, HOOK_TIMEOUT_MS)

  afterEach(async () => {
    const sockets = activeSockets
    activeSockets = []
    await Promise.all(sockets.map(async (ws) => {
      await closeWebSocket(ws, 250).catch(() => undefined)
      if (ws.readyState !== WebSocket.CLOSED) {
        ws.terminate()
      }
    }))
    if (server) {
      await closeServer(server)
      server = undefined
    }
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV
    } else {
      process.env.NODE_ENV = originalNodeEnv
    }
    if (originalAuthToken === undefined) {
      delete process.env.AUTH_TOKEN
    } else {
      process.env.AUTH_TOKEN = originalAuthToken
    }
    if (originalHelloTimeoutMs === undefined) {
      delete process.env.HELLO_TIMEOUT_MS
    } else {
      process.env.HELLO_TIMEOUT_MS = originalHelloTimeoutMs
    }
    vi.useRealTimers()
  }, HOOK_TIMEOUT_MS)

  it('reuses existing codex terminal and requires an explicit attach', async () => {
    const ws = trackWebSocket(new WebSocket(`ws://127.0.0.1:${port}/ws`))
    try {
      await waitForOpen(ws)
      const helloReady = await waitForReady(ws)

      const requestId = 'codex-reuse-1'
      const createdPromise = waitForMessage(ws, (m) => m.type === 'terminal.created' && m.requestId === requestId)
      ws.send(JSON.stringify({
        type: 'terminal.create',
        requestId,
        mode: 'codex',
        liveTerminal: {
          terminalId: 'term-codex-existing',
          serverInstanceId: helloReady.serverInstanceId,
        },
      }))

      const created = await createdPromise
      const preAttachMsgs = await collectMessages(ws, 150)

      expect(created.terminalId).toBe('term-codex-existing')
      expect(preAttachMsgs.some((m) => m.type === 'terminal.attach.ready' && m.terminalId === created.terminalId)).toBe(false)
      expect(registry.attachCalls).toHaveLength(0)
      expect(registry.createCalls).toHaveLength(0)

      const attachReadyPromise = waitForMessage(ws,
        (m) => m.type === 'terminal.attach.ready' && m.attachRequestId === 'reuse-existing-codex-attach',
      )
      ws.send(JSON.stringify({
        type: 'terminal.attach',
        terminalId: created.terminalId,
        intent: 'viewport_hydrate',
        sinceSeq: 0,
        cols: 120,
        rows: 40,
        attachRequestId: 'reuse-existing-codex-attach',
      }))
      const attachReady = await attachReadyPromise
      expect(attachReady.headSeq).toBeGreaterThanOrEqual(0)
      expect(registry.attachCalls).toHaveLength(1)
      expect(registry.attachCalls[0]?.terminalId).toBe('term-codex-existing')
    } finally {
      await closeWebSocket(ws)
    }
  })

  it('canonical reuse branch returns created only until explicit attach', async () => {
    const ws = trackWebSocket(new WebSocket(`ws://127.0.0.1:${port}/ws`))
    try {
      await waitForOpen(ws)
      await waitForReady(ws)

      const createdPromise = waitForMessage(
        ws,
        (m) => m.type === 'terminal.created' && m.requestId === 'reuse-canonical-split',
      )
      ws.send(JSON.stringify({
        type: 'terminal.create',
        requestId: 'reuse-canonical-split',
        mode: 'codex',
        sessionRef: { provider: 'codex', sessionId: CODEX_SESSION_ID },
      }))
      const created = await createdPromise
      const preAttachMsgs = await collectMessages(ws, 150)
      expect(preAttachMsgs.some((m) => m.type === 'terminal.attach.ready' && m.terminalId === created.terminalId)).toBe(false)

      const attachReadyPromise = waitForMessage(
        ws,
        (m) => m.type === 'terminal.attach.ready' && m.attachRequestId === 'reuse-canonical-split-attach',
      )
      ws.send(JSON.stringify({
        type: 'terminal.attach',
        terminalId: created.terminalId,
        intent: 'viewport_hydrate',
        sinceSeq: 0,
        cols: 120,
        rows: 40,
        attachRequestId: 'reuse-canonical-split-attach',
      }))
      const ready = await attachReadyPromise
      expect(ready.terminalId).toBe(created.terminalId)
    } finally {
      await closeWebSocket(ws)
    }
  })

  it('rejects raw Codex resume ids on restore instead of creating a fresh terminal', async () => {
    const ws = trackWebSocket(new WebSocket(`ws://127.0.0.1:${port}/ws`))
    try {
      await waitForOpen(ws)
      await waitForReady(ws)

      const requestId = 'codex-raw-resume-restore'
      const errorPromise = waitForMessage(ws, (m) => m.type === 'error' && m.requestId === requestId)
      ws.send(JSON.stringify({
        type: 'terminal.create',
        requestId,
        mode: 'codex',
        restore: true,
        resumeSessionId: 'thread-raw-restore',
      }))

      const error = await errorPromise
      expect(error).toMatchObject({
        type: 'error',
        code: 'INVALID_MESSAGE',
        message: 'Restore requires sessionRef; resumeSessionId is a legacy field and cannot be used as restore identity.',
        requestId,
      })
      expect(codexLaunchPlanner.planCreateCalls).toHaveLength(0)
      expect(registry.createCalls).toHaveLength(0)
    } finally {
      await closeWebSocket(ws)
    }
  })

  it.each([
    ['omitted', undefined],
    ['false', false],
  ] as const)('rejects raw Codex resume ids when restore is %s', async (_label, restore) => {
    const ws = trackWebSocket(new WebSocket(`ws://127.0.0.1:${port}/ws`))
    try {
      await waitForOpen(ws)
      await waitForReady(ws)

      const requestId = `codex-raw-resume-create-${_label}`
      const errorPromise = waitForMessage(ws, (m) => m.type === 'error' && m.requestId === requestId)
      ws.send(JSON.stringify({
        type: 'terminal.create',
        requestId,
        mode: 'codex',
        ...(restore === undefined ? {} : { restore }),
        resumeSessionId: 'thread-raw-create',
      }))

      const error = await errorPromise
      expect(error).toMatchObject({
        type: 'error',
        code: 'INVALID_MESSAGE',
        message: 'Restore requires sessionRef; resumeSessionId is a legacy field and cannot be used as restore identity.',
        requestId,
      })
      expect(codexLaunchPlanner.planCreateCalls).toHaveLength(0)
      expect(registry.createCalls).toHaveLength(0)
    } finally {
      await closeWebSocket(ws)
    }
  })

  it('existingId branch returns created only and requires explicit attach', async () => {
    const ws = trackWebSocket(new WebSocket(`ws://127.0.0.1:${port}/ws`))
    try {
      await waitForOpen(ws)
      const helloReady = await waitForReady(ws)

      const firstCreatedPromise = waitForMessage(
        ws,
        (m) => m.type === 'terminal.created' && m.requestId === 'reuse-existingId-split',
      )
      ws.send(JSON.stringify({
        type: 'terminal.create',
        requestId: 'reuse-existingId-split',
        mode: 'codex',
        sessionRef: { provider: 'codex', sessionId: CODEX_SESSION_ID },
      }))
      const firstCreated = await firstCreatedPromise
      const firstMsgs = await collectMessages(ws, 150)
      expect(firstMsgs.some((m) => m.type === 'terminal.attach.ready' && m.terminalId === firstCreated.terminalId)).toBe(false)

      const secondCreatedPromise = waitForMessage(
        ws,
        (m) => m.type === 'terminal.created' && m.requestId === 'reuse-existingId-split',
      )
      ws.send(JSON.stringify({
        type: 'terminal.create',
        requestId: 'reuse-existingId-split',
        mode: 'codex',
        sessionRef: { provider: 'codex', sessionId: CODEX_SESSION_ID },
      }))
      const secondCreated = await secondCreatedPromise
      expect(secondCreated.terminalId).toBe(firstCreated.terminalId)

      const secondMsgs = await collectMessages(ws, 150)
      expect(secondMsgs.some((m) => m.type === 'terminal.attach.ready' && m.terminalId === firstCreated.terminalId)).toBe(false)

      const attachReadyPromise = waitForMessage(
        ws,
        (m) => m.type === 'terminal.attach.ready' && m.attachRequestId === 'reuse-existingId-split-attach',
      )
      ws.send(JSON.stringify({
        type: 'terminal.attach',
        terminalId: firstCreated.terminalId,
        intent: 'viewport_hydrate',
        sinceSeq: 0,
        cols: 120,
        rows: 40,
        attachRequestId: 'reuse-existingId-split-attach',
      }))
      const ready = await attachReadyPromise
      expect(ready.terminalId).toBe(firstCreated.terminalId)
    } finally {
      await closeWebSocket(ws)
    }
  })

  it('does not echo durable session ids from reused codex terminals via terminal.created', async () => {
    const ws = trackWebSocket(new WebSocket(`ws://127.0.0.1:${port}/ws`))
    try {
      await waitForOpen(ws)
      await waitForReady(ws)

      const requestId = 'codex-reuse-2'
      const createdPromise = waitForMessage(ws, (m) => m.type === 'terminal.created' && m.requestId === requestId)
      ws.send(JSON.stringify({
        type: 'terminal.create',
        requestId,
        mode: 'codex',
        sessionRef: { provider: 'codex', sessionId: CODEX_SESSION_ID },
      }))
      const created = await createdPromise
      expect(created).not.toHaveProperty('effectiveResumeSessionId')
    } finally {
      await closeWebSocket(ws)
    }
  })

  it('creates a fresh codex terminal without persisting a provisional session id', async () => {
    const ws = trackWebSocket(new WebSocket(`ws://127.0.0.1:${port}/ws`))
    try {
      await waitForOpen(ws)
      await waitForReady(ws)

      const requestId = 'codex-fresh-1'
      const createdPromise = waitForMessage(ws, (m) => m.type === 'terminal.created' && m.requestId === requestId)
      ws.send(JSON.stringify({
        type: 'terminal.create',
        requestId,
        mode: 'codex',
        cwd: '/repo/worktree',
      }))

      const created = await createdPromise

      expect(created.terminalId).toBe('term-codex-existing')
      expect(created).not.toHaveProperty('effectiveResumeSessionId')
      expect(codexLaunchPlanner.planCreateCalls).toHaveLength(1)
      const planCreate = codexLaunchPlanner.planCreateCalls[0]
      expect(planCreate).toEqual(expect.objectContaining({
        cwd: '/repo/worktree',
        resumeSessionId: undefined,
        model: undefined,
        sandbox: undefined,
        approvalPolicy: undefined,
      }))
      expect(registry.createCalls).toHaveLength(1)
      expect(registry.createCalls[0]).toMatchObject({
        mode: 'codex',
        cwd: '/repo/worktree',
        resumeSessionId: undefined,
        providerSettings: {
          codexAppServer: {
            wsUrl: CODEX_REMOTE_WS_URL,
          },
        },
      })
    } finally {
      await closeWebSocket(ws)
    }
  })

  it('proof-reads captured Codex durability and resumes only after proof succeeds', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-ws-codex-proof-'))
    const ws = trackWebSocket(new WebSocket(`ws://127.0.0.1:${port}/ws`))
    try {
      const rolloutPath = path.join(tempDir, 'rollout.jsonl')
      await fsp.writeFile(
        rolloutPath,
        '{"type":"session_meta","payload":{"id":"thread-proved"}}\n',
        'utf8',
      )
      await waitForOpen(ws, PROOF_MESSAGE_TIMEOUT_MS)
      await waitForReady(ws)

      const requestId = 'codex-proved-reopen'
      const createdPromise = waitForMessage(
        ws,
        (m) => m.type === 'terminal.created' && m.requestId === requestId,
        PROOF_MESSAGE_TIMEOUT_MS,
      )
      const associatedPromise = waitForMessage(ws, (m) => (
        m.type === 'terminal.session.associated'
        && m.sessionRef?.provider === 'codex'
        && m.sessionRef?.sessionId === 'thread-proved'
      ), PROOF_MESSAGE_TIMEOUT_MS)
      ws.send(JSON.stringify({
        type: 'terminal.create',
        requestId,
        mode: 'codex',
        restore: true,
        codexDurability: {
          schemaVersion: 1,
          state: 'captured_pre_turn',
          candidate: {
            provider: 'codex',
            candidateThreadId: 'thread-proved',
            rolloutPath,
            source: 'thread_started_notification',
            capturedAt: Date.now(),
          },
        },
      }))

      const created = await createdPromise
      const associated = await associatedPromise
      expect(created).not.toHaveProperty('effectiveResumeSessionId')
      expect(associated.terminalId).toBe(created.terminalId)
      expect(codexLaunchPlanner.planCreateCalls[0]).toMatchObject({
        resumeSessionId: 'thread-proved',
      })
      expect(registry.createCalls[0]).toMatchObject({
        mode: 'codex',
        resumeSessionId: 'thread-proved',
      })
    } finally {
      await closeWebSocket(ws)
      await fsp.rm(tempDir, { recursive: true, force: true })
    }
  }, PROOF_TEST_TIMEOUT_MS)

  it('proof-reads server-stored Codex durability when the client has not persisted candidate state', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-ws-codex-store-proof-'))
    const ws = trackWebSocket(new WebSocket(`ws://127.0.0.1:${port}/ws`))
    try {
      const rolloutPath = path.join(tempDir, 'rollout.jsonl')
      await fsp.writeFile(
        rolloutPath,
        '{"type":"session_meta","payload":{"id":"thread-store-proved"}}\n',
        'utf8',
      )
      registry.durabilityRestoreRecords.push({
        terminalId: 'old-store-terminal',
        tabId: 'tab-bridge',
        paneId: 'pane-bridge',
        durability: {
          schemaVersion: 1,
          state: 'captured_pre_turn',
          candidate: {
            provider: 'codex',
            candidateThreadId: 'thread-store-proved',
            rolloutPath,
            source: 'thread_started_notification',
            capturedAt: Date.now(),
          },
        },
      })
      await waitForOpen(ws, PROOF_MESSAGE_TIMEOUT_MS)
      await waitForReady(ws)

      const requestId = 'codex-store-proved-reopen'
      const createdPromise = waitForMessage(
        ws,
        (m) => m.type === 'terminal.created' && m.requestId === requestId,
        PROOF_MESSAGE_TIMEOUT_MS,
      )
      ws.send(JSON.stringify({
        type: 'terminal.create',
        requestId,
        mode: 'codex',
        restore: true,
        tabId: 'tab-bridge',
        paneId: 'pane-bridge',
      }))

      await createdPromise
      expect(codexLaunchPlanner.planCreateCalls[0]).toMatchObject({
        resumeSessionId: 'thread-store-proved',
      })
      expect(registry.createCalls[0]).toMatchObject({
        mode: 'codex',
        resumeSessionId: 'thread-store-proved',
      })
      expect(registry.deletedDurabilityRecords).toEqual([{
        terminalId: 'old-store-terminal',
        reason: 'restore_proof_succeeded_created_replacement',
      }])
    } finally {
      await closeWebSocket(ws)
      await fsp.rm(tempDir, { recursive: true, force: true })
    }
  }, PROOF_TEST_TIMEOUT_MS)

  it('does not use server-stored Codex durability for non-restore fresh creates', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-ws-codex-store-fresh-'))
    const ws = trackWebSocket(new WebSocket(`ws://127.0.0.1:${port}/ws`))
    try {
      const rolloutPath = path.join(tempDir, 'rollout.jsonl')
      await fsp.writeFile(
        rolloutPath,
        '{"type":"session_meta","payload":{"id":"thread-store-stale"}}\n',
        'utf8',
      )
      registry.durabilityRestoreRecords.push({
        terminalId: 'old-store-terminal',
        tabId: 'tab-fresh',
        paneId: 'pane-fresh',
        durability: {
          schemaVersion: 1,
          state: 'captured_pre_turn',
          candidate: {
            provider: 'codex',
            candidateThreadId: 'thread-store-stale',
            rolloutPath,
            source: 'thread_started_notification',
            capturedAt: Date.now(),
          },
        },
      })
      await waitForOpen(ws)
      await waitForReady(ws)

      const requestId = 'codex-fresh-ignores-store-record'
      const createdPromise = waitForMessage(ws, (m) => m.type === 'terminal.created' && m.requestId === requestId)
      ws.send(JSON.stringify({
        type: 'terminal.create',
        requestId,
        mode: 'codex',
        tabId: 'tab-fresh',
        paneId: 'pane-fresh',
      }))

      await createdPromise
      expect(codexLaunchPlanner.planCreateCalls[0]).toMatchObject({
        resumeSessionId: undefined,
      })
      expect(registry.createCalls[0]).toMatchObject({
        mode: 'codex',
        resumeSessionId: undefined,
      })
      expect(registry.deletedDurabilityRecords).toEqual([])
      expect(registry.durabilityRestoreRecords).toHaveLength(1)
    } finally {
      await closeWebSocket(ws)
      await fsp.rm(tempDir, { recursive: true, force: true })
    }
  })

  it('fresh-creates with restore failure when server-stored Codex durability cannot be proved', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-ws-codex-store-proof-missing-'))
    const ws = trackWebSocket(new WebSocket(`ws://127.0.0.1:${port}/ws`))
    try {
      const rolloutPath = path.join(tempDir, 'missing.jsonl')
      registry.durabilityRestoreRecords.push({
        terminalId: 'old-store-terminal',
        tabId: 'tab-bridge',
        paneId: 'pane-bridge',
        durability: {
          schemaVersion: 1,
          state: 'captured_pre_turn',
          candidate: {
            provider: 'codex',
            candidateThreadId: 'thread-store-missing',
            rolloutPath,
            source: 'thread_started_notification',
            capturedAt: Date.now(),
          },
        },
      })
      await waitForOpen(ws)
      await waitForReady(ws)

      const requestId = 'codex-store-unproved-reopen'
      const createdPromise = waitForMessage(ws, (m) => m.type === 'terminal.created' && m.requestId === requestId)
      ws.send(JSON.stringify({
        type: 'terminal.create',
        requestId,
        mode: 'codex',
        restore: true,
        tabId: 'tab-bridge',
        paneId: 'pane-bridge',
      }))

      const created = await createdPromise
      expect(created).toMatchObject({
        type: 'terminal.created',
        requestId,
        clearCodexDurability: true,
        restoreError: {
          code: 'RESTORE_UNAVAILABLE',
          reason: 'durable_artifact_missing',
        },
      })
      expect(codexLaunchPlanner.planCreateCalls[0]).toMatchObject({
        resumeSessionId: undefined,
      })
      expect(registry.createCalls[0]).toMatchObject({
        mode: 'codex',
        resumeSessionId: undefined,
      })
      expect(registry.deletedDurabilityRecords).toEqual([{
        terminalId: 'old-store-terminal',
        reason: 'restore_proof_failed_fresh_create',
      }])
      expect(registry.durabilityRestoreRecords).toHaveLength(0)
    } finally {
      await closeWebSocket(ws)
      await fsp.rm(tempDir, { recursive: true, force: true })
    }
  })

  it('proof-reads a same-server live Codex candidate before reattaching it', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-ws-codex-proof-live-'))
    const ws = trackWebSocket(new WebSocket(`ws://127.0.0.1:${port}/ws`))
    try {
      const rolloutPath = path.join(tempDir, 'rollout.jsonl')
      await fsp.writeFile(
        rolloutPath,
        '{"type":"session_meta","payload":{"id":"thread-live-proved"}}\n',
        'utf8',
      )
      registry.records[0].resumeSessionId = undefined
      registry.records[0].codexDurability = {
        schemaVersion: 1,
        state: 'durability_unproven_after_completion',
        candidate: {
          provider: 'codex',
          candidateThreadId: 'thread-live-proved',
          rolloutPath,
          source: 'thread_started_notification',
          capturedAt: Date.now(),
        },
        turnCompletedAt: Date.now(),
      }
      await waitForOpen(ws)
      const helloReady = await waitForReady(ws)

      const requestId = 'codex-proved-live-reopen'
      const createdPromise = waitForMessage(ws, (m) => m.type === 'terminal.created' && m.requestId === requestId)
      const associatedPromise = waitForMessage(ws, (m) => (
        m.type === 'terminal.session.associated'
        && m.terminalId === 'term-codex-existing'
        && m.sessionRef?.sessionId === 'thread-live-proved'
      ))
      const durabilityPromise = waitForMessage(ws, (m) => (
        m.type === 'terminal.codex.durability.updated'
        && m.terminalId === 'term-codex-existing'
        && m.durability?.state === 'durable'
        && m.durability?.durableThreadId === 'thread-live-proved'
      ))
      const terminalsChangedPromise = waitForMessage(ws, (m) => m.type === 'terminals.changed')
      ws.send(JSON.stringify({
        type: 'terminal.create',
        requestId,
        mode: 'codex',
        restore: true,
        liveTerminal: {
          terminalId: 'term-codex-existing',
          serverInstanceId: helloReady.serverInstanceId,
        },
        codexDurability: registry.records[0].codexDurability,
      }))

      const created = await createdPromise
      await associatedPromise
      await durabilityPromise
      await terminalsChangedPromise
      expect(created.terminalId).toBe('term-codex-existing')
      expect(registry.records[0].resumeSessionId).toBe('thread-live-proved')
      expect(registry.records[0].codexDurability).toMatchObject({
        state: 'durable',
        durableThreadId: 'thread-live-proved',
      })
      expect(registry.promoteCalls).toEqual([{
        terminalId: 'term-codex-existing',
        durableThreadId: 'thread-live-proved',
      }])
      expect(codexLaunchPlanner.planCreateCalls).toHaveLength(0)
      expect(registry.createCalls).toHaveLength(0)
    } finally {
      await closeWebSocket(ws)
      await fsp.rm(tempDir, { recursive: true, force: true })
    }
  })

  it('does not promote a stale same-server live Codex handle when its candidate differs', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-ws-codex-proof-live-mismatch-'))
    const ws = trackWebSocket(new WebSocket(`ws://127.0.0.1:${port}/ws`))
    try {
      const rolloutPath = path.join(tempDir, 'rollout.jsonl')
      await fsp.writeFile(
        rolloutPath,
        '{"type":"session_meta","payload":{"id":"thread-proved-mismatch"}}\n',
        'utf8',
      )
      registry.records[0].resumeSessionId = undefined
      registry.records[0].codexDurability = {
        schemaVersion: 1,
        state: 'durability_unproven_after_completion',
        candidate: {
          provider: 'codex',
          candidateThreadId: 'different-live-thread',
          rolloutPath,
          source: 'thread_started_notification',
          capturedAt: Date.now(),
        },
        turnCompletedAt: Date.now(),
      }
      await waitForOpen(ws, PROOF_MESSAGE_TIMEOUT_MS)
      const helloReady = await waitForReady(ws)

      const requestId = 'codex-proved-live-mismatch-reopen'
      const createdPromise = waitForMessage(
        ws,
        (m) => m.type === 'terminal.created' && m.requestId === requestId,
        PROOF_MESSAGE_TIMEOUT_MS,
      )
      ws.send(JSON.stringify({
        type: 'terminal.create',
        requestId,
        mode: 'codex',
        restore: true,
        liveTerminal: {
          terminalId: 'term-codex-existing',
          serverInstanceId: helloReady.serverInstanceId,
        },
        codexDurability: {
          schemaVersion: 1,
          state: 'durability_unproven_after_completion',
          candidate: {
            provider: 'codex',
            candidateThreadId: 'thread-proved-mismatch',
            rolloutPath,
            source: 'thread_started_notification',
            capturedAt: Date.now(),
          },
          turnCompletedAt: Date.now(),
        },
      }))

      await createdPromise
      expect(registry.promoteCalls).toEqual([])
      expect(codexLaunchPlanner.planCreateCalls[0]).toMatchObject({
        resumeSessionId: 'thread-proved-mismatch',
      })
      expect(registry.createCalls[0]).toMatchObject({
        mode: 'codex',
        resumeSessionId: 'thread-proved-mismatch',
      })
    } finally {
      await closeWebSocket(ws)
      await fsp.rm(tempDir, { recursive: true, force: true })
    }
  }, PROOF_TEST_TIMEOUT_MS)

  it('does not resume a captured Codex candidate when proof fails', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-ws-codex-proof-'))
    const ws = trackWebSocket(new WebSocket(`ws://127.0.0.1:${port}/ws`))
    try {
      const rolloutPath = path.join(tempDir, 'missing.jsonl')
      await waitForOpen(ws)
      await waitForReady(ws)

      const requestId = 'codex-unproved-reopen'
      const createdPromise = waitForMessage(ws, (m) => m.type === 'terminal.created' && m.requestId === requestId)
      ws.send(JSON.stringify({
        type: 'terminal.create',
        requestId,
        mode: 'codex',
        restore: true,
        codexDurability: {
          schemaVersion: 1,
          state: 'durability_unproven_after_completion',
          candidate: {
            provider: 'codex',
            candidateThreadId: 'thread-missing',
            rolloutPath,
            source: 'thread_started_notification',
            capturedAt: Date.now(),
          },
          turnCompletedAt: Date.now(),
        },
      }))

      const created = await createdPromise
      expect(created).toMatchObject({
        type: 'terminal.created',
        requestId,
        clearCodexDurability: true,
        restoreError: {
          code: 'RESTORE_UNAVAILABLE',
          reason: 'durable_artifact_missing',
        },
      })
      expect(codexLaunchPlanner.planCreateCalls[0]).toMatchObject({
        resumeSessionId: undefined,
      })
      expect(registry.createCalls[0]).toMatchObject({
        mode: 'codex',
        resumeSessionId: undefined,
      })
    } finally {
      await closeWebSocket(ws)
      await fsp.rm(tempDir, { recursive: true, force: true })
    }
  })

  it('attaches exact live Codex candidate when captured proof fails and live terminal exists', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-ws-codex-proof-'))
    const ws = trackWebSocket(new WebSocket(`ws://127.0.0.1:${port}/ws`))
    try {
      const rolloutPath = path.join(tempDir, 'missing-live.jsonl')
      registry.records[0].codexDurability = {
        schemaVersion: 1,
        state: 'durability_unproven_after_completion',
        candidate: {
          provider: 'codex',
          candidateThreadId: 'thread-live-unproved',
          rolloutPath,
          source: 'thread_started_notification',
          capturedAt: Date.now(),
        },
        turnCompletedAt: Date.now(),
      }
      await waitForOpen(ws)
      await waitForReady(ws)

      const requestId = 'codex-unproved-live-reopen'
      const createdPromise = waitForMessage(ws, (m) => m.type === 'terminal.created' && m.requestId === requestId)
      ws.send(JSON.stringify({
        type: 'terminal.create',
        requestId,
        mode: 'codex',
        restore: true,
        codexDurability: registry.records[0].codexDurability,
      }))

      const created = await createdPromise
      expect(created.terminalId).toBe('term-codex-existing')
      expect(codexLaunchPlanner.planCreateCalls).toHaveLength(0)
      expect(registry.createCalls).toHaveLength(0)
    } finally {
      await closeWebSocket(ws)
      await fsp.rm(tempDir, { recursive: true, force: true })
    }
  })

  it('accepts Codex candidate persisted acknowledgements through the dynamic websocket schema', async () => {
    const ws = trackWebSocket(new WebSocket(`ws://127.0.0.1:${port}/ws`))
    try {
      await waitForOpen(ws)
      await waitForReady(ws)

      const messagesPromise = collectMessages(ws, 75)
      ws.send(JSON.stringify({
        type: 'terminal.codex.candidate.persisted',
        terminalId: 'term-codex-existing',
        candidateThreadId: 'thread-ack',
        rolloutPath: '/tmp/codex/thread-ack.jsonl',
        capturedAt: Date.now(),
      }))

      const messages = await messagesPromise
      expect(registry.candidatePersistedAcks).toHaveLength(1)
      expect(registry.candidatePersistedAcks[0]).toMatchObject({
        terminalId: 'term-codex-existing',
        candidateThreadId: 'thread-ack',
        rolloutPath: '/tmp/codex/thread-ack.jsonl',
      })
      expect(messages.some((message) => message.type === 'error' && message.code === 'INVALID_MESSAGE')).toBe(false)
    } finally {
      await closeWebSocket(ws)
    }
  })

  it('reuses canonical owner and repairs duplicate session records before reuse', async () => {
    const dupeServer = http.createServer((_req, res) => { res.statusCode = 404; res.end() })
    const dupeRegistry = new FakeRegistry(['term-canonical', 'term-duplicate'])
    new WsHandler(dupeServer, dupeRegistry as any, { codexLaunchPlanner: new FakeCodexLaunchPlanner() })
    const info = await listen(dupeServer)

    const ws = trackWebSocket(new WebSocket(`ws://127.0.0.1:${info.port}/ws`))
    try {
      await waitForOpen(ws)
      await waitForReady(ws)

      // Make canonical lookup fail initially so handler must invoke repair and retry.
      const originalGetCanonical = dupeRegistry.getCanonicalRunningTerminalBySession.bind(dupeRegistry)
      let firstLookup = true
      dupeRegistry.getCanonicalRunningTerminalBySession = ((mode: string, sessionId: string) => {
        if (firstLookup) {
          firstLookup = false
          return undefined
        }
        return originalGetCanonical(mode, sessionId)
      }) as any

      const requestId = 'codex-reuse-repair'
      const createdPromise = waitForMessage(ws, (m) => m.type === 'terminal.created' && m.requestId === requestId)
      ws.send(JSON.stringify({
        type: 'terminal.create',
        requestId,
        mode: 'codex',
        sessionRef: { provider: 'codex', sessionId: CODEX_SESSION_ID },
      }))
      const created = await createdPromise

      expect(created.terminalId).toBe('term-canonical')
      expect(dupeRegistry.createCalls).toHaveLength(0)
      expect(dupeRegistry.repairCalls).toHaveLength(1)
      expect(dupeRegistry.repairCalls[0]).toEqual({ mode: 'codex', sessionId: CODEX_SESSION_ID })

      ws.send(JSON.stringify({
        type: 'terminal.attach',
        terminalId: created.terminalId,
        intent: 'viewport_hydrate',
        sinceSeq: 0,
        cols: 120,
        rows: 40,
        attachRequestId: 'codex-reuse-repair-attach',
      }))
      await waitForMessage(
        ws,
        (m) => m.type === 'terminal.attach.ready' && m.attachRequestId === 'codex-reuse-repair-attach',
      )
      expect(dupeRegistry.attachCalls[0]?.terminalId).toBe('term-canonical')
    } finally {
      await closeWebSocket(ws)
      await new Promise<void>((resolve) => dupeServer.close(() => resolve()))
    }
  })
})
