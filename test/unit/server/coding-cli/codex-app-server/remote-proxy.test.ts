import WebSocket, { WebSocketServer } from 'ws'
import { afterEach, describe, expect, it } from 'vitest'
import { allocateLocalhostPort } from '../../../../../server/local-port.js'
import { CodexRemoteProxy } from '../../../../../server/coding-cli/codex-app-server/remote-proxy.js'

type UpstreamHandle = {
  server: WebSocketServer
  wsUrl: string
  messages: unknown[]
  sockets: Set<WebSocket>
}

const upstreams = new Set<UpstreamHandle>()
const proxies = new Set<CodexRemoteProxy>()

afterEach(async () => {
  await Promise.all([...proxies].map(async (proxy) => {
    proxies.delete(proxy)
    await proxy.close()
  }))
  await Promise.all([...upstreams].map(async (upstream) => {
    upstreams.delete(upstream)
    for (const socket of upstream.sockets) socket.close()
    await new Promise<void>((resolve) => upstream.server.close(() => resolve()))
  }))
})

async function startUpstream(handler?: (socket: WebSocket, message: any) => void): Promise<UpstreamHandle> {
  const endpoint = await allocateLocalhostPort()
  const sockets = new Set<WebSocket>()
  const messages: unknown[] = []
  const server = await new Promise<WebSocketServer>((resolve) => {
    const wss = new WebSocketServer({ host: endpoint.hostname, port: endpoint.port }, () => resolve(wss))
    wss.on('connection', (socket) => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
      socket.on('message', (raw) => {
        const message = JSON.parse(raw.toString())
        messages.push(message)
        handler?.(socket, message)
      })
    })
  })
  const handle = {
    server,
    wsUrl: `ws://${endpoint.hostname}:${endpoint.port}`,
    messages,
    sockets,
  }
  upstreams.add(handle)
  return handle
}

async function startProxy(upstreamWsUrl: string, options: {
  requestHoldTimeoutMs?: number
  candidateCaptureTimeoutMs?: number
} = {}): Promise<CodexRemoteProxy> {
  const proxy = new CodexRemoteProxy({ upstreamWsUrl, ...options })
  await proxy.start()
  proxies.add(proxy)
  return proxy
}

async function connect(wsUrl: string): Promise<WebSocket> {
  const socket = new WebSocket(wsUrl)
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve())
    socket.once('error', reject)
  })
  return socket
}

function nextMessage(socket: WebSocket): Promise<any> {
  return new Promise((resolve) => {
    socket.once('message', (raw) => resolve(JSON.parse(raw.toString())))
  })
}

function socketClosed(socket: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (socket.readyState === WebSocket.CLOSED) {
      resolve()
      return
    }
    socket.once('close', () => resolve())
  })
}

describe('CodexRemoteProxy', () => {
  it('captures a fresh candidate from the thread/start response and forwards the response', async () => {
    const upstream = await startUpstream((socket, message) => {
      if (message.method === 'thread/start') {
        socket.send(JSON.stringify({
          id: message.id,
          result: {
            thread: {
              id: 'thread-1',
              path: '/tmp/codex/rollout.jsonl',
              ephemeral: false,
            },
          },
        }))
      }
    })
    const proxy = await startProxy(upstream.wsUrl)
    const candidates: unknown[] = []
    proxy.onCandidate((candidate) => {
      candidates.push(candidate)
      proxy.markCandidatePersisted()
    })
    const tui = await connect(proxy.wsUrl)
    const responsePromise = nextMessage(tui)

    tui.send(JSON.stringify({ id: 1, method: 'thread/start', params: {} }))

    await expect(responsePromise).resolves.toMatchObject({
      id: 1,
      result: {
        thread: {
          id: 'thread-1',
          path: '/tmp/codex/rollout.jsonl',
        },
      },
    })
    expect(candidates).toEqual([
      {
        source: 'thread_start_response',
        thread: {
          id: 'thread-1',
          path: '/tmp/codex/rollout.jsonl',
          ephemeral: false,
        },
      },
    ])
  })

  it('captures a candidate from thread/started notification', async () => {
    const upstream = await startUpstream((socket, message) => {
      if (message.method === 'initialize') {
        socket.send(JSON.stringify({ id: message.id, result: {} }))
        socket.send(JSON.stringify({
          method: 'thread/started',
          params: {
            thread: {
              id: 'thread-notified',
              path: '/tmp/codex/notified.jsonl',
            },
          },
        }))
      }
    })
    const proxy = await startProxy(upstream.wsUrl)
    const candidate = new Promise((resolve) => {
      proxy.onCandidate((event) => {
        proxy.markCandidatePersisted()
        resolve(event)
      })
    })
    const tui = await connect(proxy.wsUrl)

    tui.send(JSON.stringify({ id: 1, method: 'initialize', params: {} }))

    await expect(candidate).resolves.toEqual({
      source: 'thread_started_notification',
      thread: {
        id: 'thread-notified',
        path: '/tmp/codex/notified.jsonl',
        ephemeral: false,
      },
    })
  })

  it('holds turn/start until candidate persistence is marked complete', async () => {
    const upstream = await startUpstream((socket, message) => {
      if (message.method === 'turn/start') {
        socket.send(JSON.stringify({ id: message.id, result: { ok: true } }))
      }
    })
    const proxy = await startProxy(upstream.wsUrl, { candidateCaptureTimeoutMs: 1_000 })
    const tui = await connect(proxy.wsUrl)
    const responsePromise = nextMessage(tui)

    tui.send(JSON.stringify({ id: 7, method: 'turn/start', params: { threadId: 'thread-1' } }))
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(upstream.messages).toHaveLength(0)

    proxy.markCandidatePersisted()

    await expect(responsePromise).resolves.toEqual({ id: 7, result: { ok: true } })
    expect(upstream.messages).toEqual([
      { id: 7, method: 'turn/start', params: { threadId: 'thread-1' } },
    ])
  })

  it('fails held turn/start and closes sockets when candidate persistence times out', async () => {
    const upstream = await startUpstream()
    const proxy = await startProxy(upstream.wsUrl, {
      requestHoldTimeoutMs: 20,
      candidateCaptureTimeoutMs: 1_000,
    })
    const repairTriggers: unknown[] = []
    proxy.onRepairTrigger((event) => repairTriggers.push(event))
    const tui = await connect(proxy.wsUrl)
    const responsePromise = nextMessage(tui)

    tui.send(JSON.stringify({ id: 9, method: 'turn/start', params: { threadId: 'thread-1' } }))

    await expect(responsePromise).resolves.toMatchObject({
      id: 9,
      error: {
        code: -32000,
        message: expect.stringContaining('persist Codex restore identity'),
      },
    })
    await socketClosed(tui)
    expect(upstream.messages).toHaveLength(0)
    expect(repairTriggers).toContainEqual({ kind: 'candidate_capture_timeout' })
  })

  it('closes an idle TUI when candidate capture times out before user input', async () => {
    const upstream = await startUpstream()
    const proxy = await startProxy(upstream.wsUrl, {
      candidateCaptureTimeoutMs: 20,
    })
    const repairTriggers: unknown[] = []
    proxy.onRepairTrigger((event) => repairTriggers.push(event))
    const tui = await connect(proxy.wsUrl)

    await socketClosed(tui)
    expect(upstream.messages).toHaveLength(0)
    expect(repairTriggers).toContainEqual({ kind: 'candidate_capture_timeout' })
  })

  it('emits turn/completed notifications', async () => {
    const upstream = await startUpstream((socket, message) => {
      if (message.method === 'initialize') {
        socket.send(JSON.stringify({ id: message.id, result: {} }))
        socket.send(JSON.stringify({
          method: 'turn/completed',
          params: { threadId: 'thread-1', turnId: 'turn-1', status: 'completed' },
        }))
      }
    })
    const proxy = await startProxy(upstream.wsUrl)
    const completed = new Promise((resolve) => {
      proxy.onTurnCompleted((event) => {
        proxy.markCandidatePersisted()
        resolve(event)
      })
    })
    const tui = await connect(proxy.wsUrl)

    tui.send(JSON.stringify({ id: 1, method: 'initialize', params: {} }))

    await expect(completed).resolves.toEqual({
      threadId: 'thread-1',
      turnId: 'turn-1',
      params: { threadId: 'thread-1', turnId: 'turn-1', status: 'completed' },
    })
  })
})
