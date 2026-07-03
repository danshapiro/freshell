// @vitest-environment node
//
// This file spawns the REAL Codex app-server binary and verifies EXTERNAL
// provider behavior (durable thread lifecycle, resume readiness, display ID
// stability). It does NOT test Freshell code. It is gated by
// FRESHELL_RUN_REAL_PROVIDER_CONTRACTS=1 because it is environment-dependent,
// can flake due to external process behavior, and must not block the
// coordinated suite.
//
// To run it: FRESHELL_RUN_REAL_PROVIDER_CONTRACTS=1 npm run test:vitest -- \
//   run test/integration/real/codex-app-server-readiness-contract.test.ts \
//   --config config/vitest/vitest.server.config.ts
//
import fsp from 'node:fs/promises'
import { execFile } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { describe, expect, it } from 'vitest'
import WebSocket from 'ws'

import { CodexAppServerClient, type CodexThreadLifecycleEvent } from '../../../server/coding-cli/codex-app-server/client.js'
import { CodexAppServerRuntime } from '../../../server/coding-cli/codex-app-server/runtime.js'
import { createCodexFreshAgentAdapter } from '../../../server/fresh-agent/adapters/codex/adapter.js'

type JsonRpcNotification = {
  method: string
  params?: Record<string, unknown>
}

type JsonRpcClient = {
  close: () => Promise<void>
  request: (method: string, params: Record<string, unknown>) => Promise<unknown>
  waitForNotification: (
    predicate: (notification: JsonRpcNotification) => boolean,
    timeoutMs?: number,
  ) => Promise<JsonRpcNotification>
}

type PendingJsonRpcRequest = {
  reject: (error: Error) => void
  resolve: (value: unknown) => void
  timeout: NodeJS.Timeout
}

type ProbeAvailability = {
  ready: boolean
  reason?: string
}

const execFileAsync = promisify(execFile)

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fsp.access(targetPath)
    return true
  } catch {
    return false
  }
}

async function codexAvailability(): Promise<ProbeAvailability> {
  try {
    await execFileAsync('codex', ['--version'])
  } catch {
    return {
      ready: false,
      reason: 'Skipping Codex app-server durable readiness contract: codex is not on PATH.',
    }
  }

  const missing = []
  if (!(await pathExists(path.join(os.homedir(), '.codex', 'auth.json')))) missing.push('~/.codex/auth.json')
  if (!(await pathExists(path.join(os.homedir(), '.codex', 'config.toml')))) missing.push('~/.codex/config.toml')
  if (missing.length > 0) {
    return {
      ready: false,
      reason: `Skipping Codex app-server durable readiness contract: missing ${missing.join(' and ')}.`,
    }
  }

  return { ready: true }
}

async function seedIsolatedCodexHome(): Promise<{ codexHome: string; root: string }> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-codex-readiness-'))
  const codexHome = path.join(root, '.codex')
  await fsp.mkdir(codexHome, { recursive: true })
  await fsp.copyFile(path.join(os.homedir(), '.codex', 'auth.json'), path.join(codexHome, 'auth.json'))
  await fsp.copyFile(path.join(os.homedir(), '.codex', 'config.toml'), path.join(codexHome, 'config.toml'))
  return { codexHome, root }
}

async function connectJsonRpcClient(wsUrl: string, requestTimeoutMs = 60_000): Promise<JsonRpcClient> {
  const socket = new WebSocket(wsUrl)
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      socket.off('error', onError)
      socket.off('open', onOpen)
    }
    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }
    const onOpen = () => {
      cleanup()
      resolve()
    }
    socket.once('error', onError)
    socket.once('open', onOpen)
  })

  let nextId = 1
  const notifications: JsonRpcNotification[] = []
  const pending = new Map<number, PendingJsonRpcRequest>()

  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString()) as {
      error?: { code?: number; message?: string }
      id?: number
      method?: string
      params?: Record<string, unknown>
      result?: unknown
    }

    if (typeof message.id === 'number') {
      const request = pending.get(message.id)
      if (!request) return
      clearTimeout(request.timeout)
      pending.delete(message.id)
      if (message.error) {
        request.reject(new Error(`Codex app-server ${message.error.code ?? 'error'}: ${message.error.message ?? 'unknown error'}`))
        return
      }
      request.resolve(message.result)
      return
    }

    if (typeof message.method === 'string') {
      notifications.push({ method: message.method, params: message.params })
    }
  })

  socket.on('close', () => {
    for (const [id, request] of pending) {
      clearTimeout(request.timeout)
      request.reject(new Error('Codex app-server websocket closed before the request completed.'))
      pending.delete(id)
    }
  })

  return {
    close: async () => {
      await new Promise<void>((resolve) => {
        if (socket.readyState === WebSocket.CLOSED) {
          resolve()
          return
        }
        socket.once('close', () => resolve())
        socket.close()
      })
    },
    request: (method, params) => new Promise((resolve, reject) => {
      const id = nextId
      nextId += 1
      const timeout = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`Codex app-server did not respond to ${method} within ${requestTimeoutMs}ms.`))
      }, requestTimeoutMs)
      pending.set(id, { reject, resolve, timeout })
      socket.send(JSON.stringify({ id, method, params }))
    }),
    waitForNotification: async (predicate, timeoutMs = 120_000) => {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const found = notifications.find(predicate)
        if (found) return found
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      throw new Error('Timed out waiting for Codex app-server notification.')
    },
  }
}

async function waitForLifecycle(
  events: CodexThreadLifecycleEvent[],
  predicate: (event: CodexThreadLifecycleEvent) => boolean,
  timeoutMs = 10_000,
): Promise<CodexThreadLifecycleEvent> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = events.find(predicate)
    if (found) return found
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('Timed out waiting for Codex app-server lifecycle evidence.')
}

function parseThreadId(result: unknown): string {
  if (
    !result
    || typeof result !== 'object'
    || !('thread' in result)
    || !result.thread
    || typeof result.thread !== 'object'
    || !('id' in result.thread)
    || typeof result.thread.id !== 'string'
    || result.thread.id.length === 0
  ) {
    throw new Error('Codex app-server returned a thread payload without a usable id.')
  }
  return result.thread.id
}

function isDurableReadinessEvidence(event: CodexThreadLifecycleEvent, threadId: string): boolean {
  if (event.kind === 'thread_started') {
    return event.thread.id === threadId
  }
  return event.kind === 'thread_status_changed'
    && event.threadId === threadId
    && event.status.type === 'idle'
}

const codexProbe = await codexAvailability()
const realProviderContractsEnabled = process.env.FRESHELL_RUN_REAL_PROVIDER_CONTRACTS === '1'
const describeCodex = (codexProbe.ready && realProviderContractsEnabled) ? describe : describe.skip

function readUserMessageTexts(item: Record<string, unknown>): string[] {
  const contentTexts = Array.isArray(item.content)
    ? item.content.flatMap((part) => {
      if (!part || typeof part !== 'object' || Array.isArray(part)) return []
      return typeof part.text === 'string' ? [part.text] : []
    })
    : []
  if (contentTexts.length > 0) return contentTexts
  if (typeof item.text === 'string') return [item.text]
  if (typeof item.summary === 'string') return [item.summary]
  return []
}

function rawTurnIncludesUserMessageText(rawTurn: Record<string, unknown>, needle: string): boolean {
  const items = Array.isArray(rawTurn.items)
    ? rawTurn.items.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item))
    : []
  return items.some((item) => item.type === 'userMessage' && readUserMessageTexts(item).some((text) => text.includes(needle)))
}

function findRawTurnByUserMessageText(rawTurns: unknown, needle: string): Record<string, unknown> | undefined {
  const turns = Array.isArray(rawTurns)
    ? rawTurns.filter((turn): turn is Record<string, unknown> => !!turn && typeof turn === 'object' && !Array.isArray(turn))
    : []
  return turns.find((turn) => rawTurnIncludesUserMessageText(turn, needle))
}

function displayTurnIncludesText(turn: { items?: Array<Record<string, unknown>> }, needle: string): boolean {
  return (turn.items ?? []).some((item) => item.kind === 'text' && typeof item.text === 'string' && item.text.includes(needle))
}

function comparableDisplayTurn(turn: Record<string, unknown>): Record<string, unknown> {
  const comparableKeys = ['id', 'turnId', 'messageId', 'source', 'role', 'timestamp', 'model', 'summary', 'items'] as const
  return Object.fromEntries(comparableKeys
    .filter((key) => key in turn)
    .map((key) => [key, turn[key]]))
}

async function waitForSessionArtifact(codexHome: string, threadId: string, timeoutMs = 60_000): Promise<string> {
  const sessionsRoot = path.join(codexHome, 'sessions')
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const dayDirs = await fsp.readdir(sessionsRoot, { recursive: true }).catch(() => [])
    const artifact = dayDirs
      .map((entry) => String(entry))
      .find((entry) => entry.endsWith('.jsonl') && entry.includes(threadId))
    if (artifact) return path.join(sessionsRoot, artifact)
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('Timed out waiting for the durable Codex session artifact.')
}

describeCodex(`real Codex app-server durable readiness contract${codexProbe.ready ? '' : ` (${codexProbe.reason})`}${realProviderContractsEnabled ? '' : ` (opt-in: FRESHELL_RUN_REAL_PROVIDER_CONTRACTS=1)`}`, () => {
  it('emits current-generation lifecycle evidence when a durable thread is resumed', async () => {
    const { codexHome, root } = await seedIsolatedCodexHome()
    const promptNonce = `freshell-readiness-contract-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const displayIdSecret = 'task-7-real-provider-contract-guard'
    const creationRuntime = new CodexAppServerRuntime({
      env: { CODEX_HOME: codexHome },
      startupAttemptLimit: 1,
      startupAttemptTimeoutMs: 10_000,
      requestTimeoutMs: 60_000,
    })
    let creationClient: JsonRpcClient | null = null
    let durableThreadId = ''
    let providerUserTurnId = ''
    let providerRevision = 0
    let displayUserTurnIdBeforeResume = ''

    try {
      const ready = await creationRuntime.ensureReady()
      creationClient = await connectJsonRpcClient(ready.wsUrl)
      await creationClient.request('initialize', {
        clientInfo: { name: 'freshell-readiness-contract', version: '1.0.0' },
        capabilities: { experimentalApi: true },
      })
      const started = await creationClient.request('thread/start', {
        cwd: process.cwd(),
        experimentalRawEvents: false,
        persistExtendedHistory: true,
      })
      durableThreadId = parseThreadId(started)
      await creationClient.request('turn/start', {
        threadId: durableThreadId,
        input: [{ type: 'text', text: `Reply with exactly: ${promptNonce}` }],
      })
      await creationClient.waitForNotification(
        (notification) => notification.method === 'turn/completed'
        && notification.params?.threadId === durableThreadId,
      )
      await creationClient.request('turn/start', {
        threadId: durableThreadId,
        input: [{ type: 'text', text: 'Reply with exactly: freshell-readiness-contract-page-two' }],
      })
      await creationClient.waitForNotification(
        (notification) => notification.method === 'turn/completed'
        && notification.params?.threadId === durableThreadId,
      )
      await waitForSessionArtifact(codexHome, durableThreadId)

      const creationClientApi = new CodexAppServerClient({ wsUrl: ready.wsUrl }, { requestTimeoutMs: 10_000 })
      const creationAdapter = createCodexFreshAgentAdapter({
        runtime: creationRuntime,
        displayIdSecret,
      })
      try {
        await creationClientApi.initialize()
        const creationSnapshot = await creationClientApi.readThread({
          threadId: durableThreadId,
          includeTurns: true,
        })
        providerRevision = Number(creationSnapshot.thread.updatedAt ?? 0)
        const providerUserTurn = findRawTurnByUserMessageText(creationSnapshot.thread.turns, promptNonce)
        expect(providerUserTurn).toBeDefined()
        expect(providerUserTurn && typeof providerUserTurn.id === 'string' ? providerUserTurn.id : '').not.toBe('')
        providerUserTurnId = String(providerUserTurn?.id ?? '')

        const creationPage = await creationAdapter.getTurnPage?.({
          sessionType: 'freshcodex',
          provider: 'codex',
          threadId: durableThreadId,
        }, {
          revision: providerRevision,
          limit: 100,
        })
        const creationDisplayTurn = creationPage?.turns.find((turn) => turn.role === 'user' && displayTurnIncludesText(turn, promptNonce))
        expect(creationDisplayTurn).toBeDefined()
        displayUserTurnIdBeforeResume = creationDisplayTurn?.turnId ?? ''
      } finally {
        await creationClientApi.close().catch(() => undefined)
        await creationAdapter.shutdown?.().catch(() => undefined)
      }
    } finally {
      await creationClient?.close().catch(() => undefined)
      await creationRuntime.shutdown().catch(() => undefined)
    }

    const runtime = new CodexAppServerRuntime({
      env: { CODEX_HOME: codexHome },
      startupAttemptLimit: 1,
      startupAttemptTimeoutMs: 10_000,
      requestTimeoutMs: 60_000,
    })
    const clients: CodexAppServerClient[] = []
    const adapter = createCodexFreshAgentAdapter({
      runtime,
      displayIdSecret,
    })

    try {
      const ready = await runtime.ensureReady()
      const observer = new CodexAppServerClient({ wsUrl: ready.wsUrl }, { requestTimeoutMs: 10_000 })
      const actor = new CodexAppServerClient({ wsUrl: ready.wsUrl }, { requestTimeoutMs: 10_000 })
      clients.push(observer, actor)

      const lifecycle: CodexThreadLifecycleEvent[] = []
      observer.onThreadLifecycle((event) => lifecycle.push(event))
      actor.onThreadLifecycle((event) => lifecycle.push(event))
      await observer.initialize()
      await actor.initialize()

      const resumed = await actor.resumeThread({ threadId: durableThreadId, cwd: process.cwd() })
      expect(resumed.threadId).toBe(durableThreadId)
      const newestTurnPage = await actor.listThreadTurns({
        threadId: durableThreadId,
        limit: 1,
        sortDirection: 'desc',
        itemsView: 'full',
      })
      expect(newestTurnPage.turns).toEqual([expect.objectContaining({
        id: expect.any(String),
        itemsView: 'full',
      })])
      expect(newestTurnPage.nextCursor).toEqual(expect.any(String))
      const newestMetadataPage = await actor.listThreadTurns({
        threadId: durableThreadId,
        limit: 1,
        sortDirection: 'desc',
        itemsView: 'notLoaded',
      })
      expect(newestMetadataPage.turns).toEqual([expect.objectContaining({
        id: newestTurnPage.turns[0]!.id,
        itemsView: 'notLoaded',
        items: [],
      })])
      const olderTurnPage = await actor.listThreadTurns({
        threadId: durableThreadId,
        limit: 1,
        sortDirection: 'desc',
        cursor: newestTurnPage.nextCursor ?? undefined,
        itemsView: 'full',
      })
      expect(olderTurnPage.turns).toEqual([expect.objectContaining({
        id: expect.any(String),
        itemsView: 'full',
      })])
      expect(olderTurnPage.turns[0]!.id).not.toBe(newestTurnPage.turns[0]!.id)
      await expect(actor.readThreadTurn({
        threadId: durableThreadId,
        turnId: olderTurnPage.turns[0]!.id,
      })).resolves.toMatchObject({
        id: olderTurnPage.turns[0]!.id,
        itemsView: 'full',
      })
      const resumedSnapshot = await actor.readThread({
        threadId: durableThreadId,
        includeTurns: true,
      })
      const resumedRevision = Number(resumedSnapshot.thread.updatedAt ?? providerRevision)
      const providerUserTurn = findRawTurnByUserMessageText(resumedSnapshot.thread.turns, promptNonce)
      expect(providerUserTurn).toBeDefined()
      expect(providerUserTurn).toMatchObject({
        id: providerUserTurnId,
      })
      expect(providerUserTurn && rawTurnIncludesUserMessageText(providerUserTurn, promptNonce)).toBe(true)

      const displayPage = await adapter.getTurnPage?.({
        sessionType: 'freshcodex',
        provider: 'codex',
        threadId: durableThreadId,
      }, {
        revision: resumedRevision,
        limit: 100,
      })
      const displayUserTurn = displayPage?.turns.find((turn) => turn.role === 'user' && displayTurnIncludesText(turn, promptNonce))
      expect(displayUserTurn).toBeDefined()
      expect(displayUserTurn?.turnId).toBe(displayUserTurnIdBeforeResume)
      expect(displayUserTurn?.turnId).toMatch(/^codex-display:/)
      expect(displayUserTurn?.turnId).not.toContain(providerUserTurnId)

      const displayBody = await adapter.getTurnBody?.({
        sessionType: 'freshcodex',
        provider: 'codex',
        threadId: durableThreadId,
        turnId: displayUserTurn!.turnId,
      }, resumedRevision)
      expect(displayBody).toBeDefined()
      expect(comparableDisplayTurn(displayBody!)).toEqual(comparableDisplayTurn(displayUserTurn!))

      const readiness = await waitForLifecycle(
        lifecycle,
        (event) => isDurableReadinessEvidence(event, durableThreadId),
      )
      if (readiness.kind === 'thread_started') {
        expect(readiness.thread.id).toBe(durableThreadId)
      } else {
        expect(readiness).toEqual(expect.objectContaining({
          kind: 'thread_status_changed',
          threadId: durableThreadId,
          status: expect.objectContaining({ type: 'idle' }),
        }))
      }
    } finally {
      await Promise.all(clients.map((client) => client.close().catch(() => undefined)))
      await adapter.shutdown?.().catch(() => undefined)
      await runtime.shutdown().catch(() => undefined)
      await fsp.rm(root, { force: true, recursive: true }).catch(() => undefined)
    }
  }, 180_000)
})
