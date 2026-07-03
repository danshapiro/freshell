// @vitest-environment node
//
// This file spawns the REAL Codex app-server binary and verifies EXTERNAL
// provider wire behavior for thread/fork. It does NOT test Freshell code. It
// is gated by FRESHELL_RUN_REAL_PROVIDER_CONTRACTS=1 because it depends on the
// local Codex install and credentials.
//
// To run it: FRESHELL_RUN_REAL_PROVIDER_CONTRACTS=1 npm run test:vitest -- \
//   run test/integration/real/codex-app-server-fork-shape-contract.test.ts \
//   --config vitest.server.config.ts
//
import { execFile } from 'node:child_process'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { describe, expect, it } from 'vitest'
import WebSocket from 'ws'

import { CodexAppServerRuntime } from '../../../server/coding-cli/codex-app-server/runtime.js'

type ProbeAvailability = {
  ready: boolean
  reason?: string
}

type JsonRpcEnvelope = {
  error?: { code?: number; message?: string }
  id?: string | number
  method?: string
  params?: unknown
  result?: unknown
}

type PendingJsonRpcRequest = {
  reject: (error: Error) => void
  resolve: (value: JsonRpcEnvelope) => void
  timeout: NodeJS.Timeout
}

type RawJsonRpcClient = {
  close: () => Promise<void>
  notify: (method: string, params?: Record<string, unknown>) => void
  requestEnvelope: (method: string, params: Record<string, unknown>) => Promise<JsonRpcEnvelope>
  waitForNotification: (
    predicate: (notification: { method: string; params?: Record<string, unknown> }) => boolean,
    timeoutMs?: number,
  ) => Promise<{ method: string; params?: Record<string, unknown> }>
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
      reason: 'Skipping Codex app-server fork-shape contract: codex is not on PATH.',
    }
  }

  const missing = []
  if (!(await pathExists(path.join(os.homedir(), '.codex', 'auth.json')))) missing.push('~/.codex/auth.json')
  if (!(await pathExists(path.join(os.homedir(), '.codex', 'config.toml')))) missing.push('~/.codex/config.toml')
  if (missing.length > 0) {
    return {
      ready: false,
      reason: `Skipping Codex app-server fork-shape contract: missing ${missing.join(' and ')}.`,
    }
  }

  return { ready: true }
}

async function seedIsolatedCodexHome(): Promise<{ codexHome: string; root: string }> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-codex-fork-shape-'))
  const codexHome = path.join(root, '.codex')
  await fsp.mkdir(codexHome, { recursive: true })
  await fsp.copyFile(path.join(os.homedir(), '.codex', 'auth.json'), path.join(codexHome, 'auth.json'))
  await fsp.copyFile(path.join(os.homedir(), '.codex', 'config.toml'), path.join(codexHome, 'config.toml'))
  return { codexHome, root }
}

async function connectRawJsonRpcClient(wsUrl: string, requestTimeoutMs = 60_000): Promise<RawJsonRpcClient> {
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
  const notifications: Array<{ method: string; params?: Record<string, unknown> }> = []
  const pending = new Map<string | number, PendingJsonRpcRequest>()

  socket.on('message', (raw) => {
    const envelope = JSON.parse(raw.toString()) as JsonRpcEnvelope
    if (envelope.id === undefined) {
      if (typeof envelope.method === 'string') {
        notifications.push({
          method: envelope.method,
          ...(envelope.params && typeof envelope.params === 'object' && !Array.isArray(envelope.params)
            ? { params: envelope.params as Record<string, unknown> }
            : {}),
        })
      }
      return
    }
    const request = pending.get(envelope.id)
    if (!request) return
    pending.delete(envelope.id)
    clearTimeout(request.timeout)
    if (envelope.error) {
      request.reject(new Error(`Codex app-server ${envelope.error.code ?? 'error'}: ${envelope.error.message ?? 'unknown error'}`))
      return
    }
    request.resolve(envelope)
  })

  socket.on('close', () => {
    for (const [id, request] of pending) {
      pending.delete(id)
      clearTimeout(request.timeout)
      request.reject(new Error('Codex app-server websocket closed before the request completed.'))
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
    notify: (method, params = {}) => {
      socket.send(JSON.stringify({ method, params }))
    },
    requestEnvelope: (method, params) => new Promise((resolve, reject) => {
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

function threadFromOperation(envelope: JsonRpcEnvelope): Record<string, unknown> {
  const result = envelope.result
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error('Codex app-server operation response did not include an object result.')
  }
  const thread = (result as Record<string, unknown>).thread
  if (!thread || typeof thread !== 'object' || Array.isArray(thread)) {
    throw new Error('Codex app-server operation response did not include result.thread.')
  }
  return thread as Record<string, unknown>
}

function threadId(thread: Record<string, unknown>): string {
  const id = thread.id
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('Codex app-server thread payload did not include a usable id.')
  }
  return id
}

function presentPathLikeFields(thread: Record<string, unknown>): Array<{ field: string; value: string }> {
  return ['path', 'rolloutPath', 'rollout_path']
    .flatMap((field) => {
      const value = thread[field]
      return typeof value === 'string' && value.length > 0 ? [{ field, value }] : []
    })
}

const codexProbe = await codexAvailability()
const realProviderContractsEnabled = process.env.FRESHELL_RUN_REAL_PROVIDER_CONTRACTS === '1'
const describeCodex = (codexProbe.ready && realProviderContractsEnabled) ? describe : describe.skip

describeCodex(`real Codex app-server fork-shape contract${codexProbe.ready ? '' : ` (${codexProbe.reason})`}${realProviderContractsEnabled ? '' : ' (opt-in: FRESHELL_RUN_REAL_PROVIDER_CONTRACTS=1)'}`, () => {
  it('returns result.thread.path for compact thread/fork responses', async () => {
    const { codexHome, root } = await seedIsolatedCodexHome()
    const runtime = new CodexAppServerRuntime({
      env: { CODEX_HOME: codexHome },
      startupAttemptLimit: 1,
      startupAttemptTimeoutMs: 10_000,
      requestTimeoutMs: 60_000,
    })
    let client: RawJsonRpcClient | null = null

    try {
      const ready = await runtime.ensureReady()
      client = await connectRawJsonRpcClient(ready.wsUrl)
      const initialize = await client.requestEnvelope('initialize', {
        clientInfo: { name: 'freshell-fork-shape-contract', version: '1.0.0' },
        capabilities: { experimentalApi: true },
      })
      expect(initialize.id).toBe(1)
      client.notify('initialized')

      const start = await client.requestEnvelope('thread/start', {
        cwd: process.cwd(),
        experimentalRawEvents: false,
        persistExtendedHistory: true,
      })
      expect(start.id).toBe(2)
      const parentThread = threadFromOperation(start)
      const parentThreadId = threadId(parentThread)

      const parentTurnNonce = `freshell-fork-shape-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const turnStart = await client.requestEnvelope('turn/start', {
        threadId: parentThreadId,
        input: [{ type: 'text', text: `Reply with exactly: ${parentTurnNonce}` }],
        cwd: process.cwd(),
      })
      expect(turnStart.id).toBe(3)
      await client.waitForNotification(
        (notification) => notification.method === 'turn/completed'
          && notification.params?.threadId === parentThreadId,
      )

      const fork = await client.requestEnvelope('thread/fork', {
        threadId: parentThreadId,
        cwd: process.cwd(),
        excludeTurns: true,
      })

      expect(fork.id).toBe(4)
      const childThread = threadFromOperation(fork)
      const childThreadId = threadId(childThread)
      expect(childThreadId).not.toBe(parentThreadId)

      // Production fork extraction must use result.thread.path unless this
      // real-provider contract is updated with contrary evidence.
      expect(childThread.path).toEqual(expect.any(String))
      expect(path.isAbsolute(childThread.path as string)).toBe(true)
      expect(childThread.ephemeral).not.toBe(true)
      if ('turns' in childThread) {
        expect(Array.isArray(childThread.turns)).toBe(true)
      }

      const pathFields = presentPathLikeFields(childThread)
      expect(pathFields).toEqual(expect.arrayContaining([{ field: 'path', value: childThread.path as string }]))
      const normalized = new Set(pathFields.map((field) => path.normalize(field.value)))
      expect(normalized.size).toBe(1)
    } finally {
      await client?.close().catch(() => undefined)
      await runtime.shutdown().catch(() => undefined)
      await fsp.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    }
  }, 120_000)
})
