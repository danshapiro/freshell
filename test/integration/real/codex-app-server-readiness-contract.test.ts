// @vitest-environment node
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'
import WebSocket from 'ws'

import { CodexAppServerClient, type CodexThreadLifecycleEvent } from '../../../server/coding-cli/codex-app-server/client.js'
import { CodexAppServerRuntime } from '../../../server/coding-cli/codex-app-server/runtime.js'

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

describe('real Codex app-server durable readiness contract', () => {
  it('emits current-generation lifecycle evidence when a durable thread is resumed', async () => {
    const { codexHome, root } = await seedIsolatedCodexHome()
    const creationRuntime = new CodexAppServerRuntime({
      env: { CODEX_HOME: codexHome },
      startupAttemptLimit: 1,
      startupAttemptTimeoutMs: 10_000,
      requestTimeoutMs: 60_000,
    })
    let creationClient: JsonRpcClient | null = null
    let durableThreadId = ''

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
        input: [{ type: 'text', text: 'Reply with exactly: freshell-readiness-contract' }],
      })
      await creationClient.waitForNotification(
        (notification) => notification.method === 'turn/completed'
          && notification.params?.threadId === durableThreadId,
      )
      await waitForSessionArtifact(codexHome, durableThreadId)
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
      expect(resumed.thread.id).toBe(durableThreadId)

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
      await runtime.shutdown().catch(() => undefined)
      await fsp.rm(root, { force: true, recursive: true }).catch(() => undefined)
    }
  }, 180_000)
})
