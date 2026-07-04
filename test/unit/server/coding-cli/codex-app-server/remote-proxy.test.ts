import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import WebSocket, { WebSocketServer } from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodexRemoteProxy } from '../../../../../server/coding-cli/codex-app-server/remote-proxy.js'
import {
  MAX_FULL_PARSE_BYTES,
  MAX_RAW_FORWARD_BYTES,
} from '../../../../../server/coding-cli/codex-app-server/json-rpc-envelope.js'

const execFileAsync = promisify(execFile)
const largeForwardChildPath = new URL('./remote-proxy-large-forward-child.ts', import.meta.url)
const SMALL_CONSTRAINED_HEAP_CAP_BYTES = 2 * 1024 * 1024

type LargeForwardStressMode = 'stateful-fork' | 'non-state' | 'above-cap'

type UpstreamHandle = {
  server: WebSocketServer
  wsUrl: string
  messages: unknown[]
  binaryFlags: boolean[]
  frames: Array<{
    raw: Buffer
    text: string
    isBinary: boolean
  }>
  sockets: Set<WebSocket>
}

const upstreams = new Set<UpstreamHandle>()
const proxies = new Set<CodexRemoteProxy>()

afterEach(async () => {
  try {
    await Promise.all([...proxies].map(async (proxy) => {
      proxies.delete(proxy)
      await proxy.close()
    }))
    await Promise.all([...upstreams].map(async (upstream) => {
      upstreams.delete(upstream)
      for (const socket of upstream.sockets) socket.close()
      await new Promise<void>((resolve) => upstream.server.close(() => resolve()))
    }))
  } finally {
    vi.useRealTimers()
  }
})

async function startUpstream(handler?: (socket: WebSocket, message: any) => void): Promise<UpstreamHandle> {
  const sockets = new Set<WebSocket>()
  const messages: unknown[] = []
  const binaryFlags: boolean[] = []
  const frames: UpstreamHandle['frames'] = []
  const server = await new Promise<WebSocketServer>((resolve, reject) => {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    const onListening = () => {
      wss.off('error', onError)
      resolve(wss)
    }
    const onError = (error: Error) => {
      wss.off('listening', onListening)
      reject(error)
    }
    wss.once('listening', onListening)
    wss.once('error', onError)
    wss.on('connection', (socket) => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
      socket.on('message', (raw, isBinary) => {
        const rawBuffer = rawDataToBuffer(raw)
        frames.push({
          raw: rawBuffer,
          text: rawBuffer.toString(),
          isBinary,
        })
        binaryFlags.push(isBinary)
        let message: unknown
        try {
          message = JSON.parse(rawBuffer.toString())
        } catch {
          message = undefined
        }
        messages.push(message)
        if (message !== undefined) handler?.(socket, message)
      })
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    throw new Error('Upstream WebSocket server did not expose a localhost port.')
  }
  const handle = {
    server,
    wsUrl: `ws://127.0.0.1:${address.port}`,
    messages,
    binaryFlags,
    frames,
    sockets,
  }
  upstreams.add(handle)
  return handle
}

async function startProxy(upstreamWsUrl: string, options: {
  requestHoldTimeoutMs?: number
  candidateCaptureTimeoutMs?: number
  requireCandidatePersistence?: boolean
  maxRawForwardBytes?: number
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

function nextMessageWithin(socket: WebSocket, ms: number): Promise<any> {
  return Promise.race([
    nextMessage(socket),
    delay(ms).then(() => {
      throw new Error(`Timed out waiting ${ms}ms for websocket message.`)
    }),
  ])
}

async function nextResponseWithIdWithin(socket: WebSocket, id: number, ms: number): Promise<any> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const remainingMs = Math.max(1, deadline - Date.now())
    const message = await nextMessageWithin(socket, remainingMs)
    if (message?.id === id) return message
  }
  throw new Error(`Timed out waiting ${ms}ms for websocket response ${id}.`)
}

function nextMessageFrame(socket: WebSocket): Promise<{ message: any; isBinary: boolean }> {
  return new Promise((resolve) => {
    socket.once('message', (raw, isBinary) => resolve({
      message: JSON.parse(raw.toString()),
      isBinary,
    }))
  })
}

function collectRawFrames(socket: WebSocket, count: number): Promise<Array<{ raw: Buffer; isBinary: boolean }>> {
  return new Promise((resolve) => {
    const frames: Array<{ raw: Buffer; isBinary: boolean }> = []
    const onMessage = (raw: WebSocket.RawData, isBinary: boolean) => {
      frames.push({
        raw: rawDataToBuffer(raw),
        isBinary,
      })
      if (frames.length === count) {
        socket.off('message', onMessage)
        resolve(frames)
      }
    }
    socket.on('message', onMessage)
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

async function expectSocketClosedWithin(socket: WebSocket, ms: number): Promise<void> {
  await expect(Promise.race([
    socketClosed(socket).then(() => 'closed'),
    delay(ms).then(() => 'timeout'),
  ])).resolves.toBe('closed')
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function rawDataToBuffer(raw: WebSocket.RawData): Buffer {
  if (Buffer.isBuffer(raw)) return raw
  if (Array.isArray(raw)) return Buffer.concat(raw.map((part) => Buffer.from(part)))
  return Buffer.from(raw)
}

async function expectNoMessage(socket: WebSocket, ms: number): Promise<void> {
  let received = false
  const onMessage = () => {
    received = true
  }
  socket.once('message', onMessage)
  await delay(ms)
  socket.off('message', onMessage)
  expect(received).toBe(false)
}

function largePadding(extraBytes = 1_024): string {
  return 'x'.repeat(MAX_FULL_PARSE_BYTES + extraBytes)
}

async function runLargeForwardStressChild(options: {
  capBytes: number
  heapMb: number
  mode: LargeForwardStressMode
  timeoutMs: number
}): Promise<void> {
  try {
    const result = await execFileAsync(process.execPath, [
      `--max-old-space-size=${options.heapMb}`,
      '--import',
      'tsx',
      largeForwardChildPath.pathname,
      '--cap-bytes',
      String(options.capBytes),
      '--mode',
      options.mode,
    ], {
      timeout: options.timeoutMs,
      maxBuffer: 1024 * 1024,
    })
    const stdout = result.stdout.trim()
    if (stdout.length > 0) {
      console.info(stdout)
    }
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string }
    throw new Error([
      `constrained heap large-forward child failed in ${options.mode} mode`,
      failure.message,
      failure.stdout ? `stdout:\n${failure.stdout}` : undefined,
      failure.stderr ? `stderr:\n${failure.stderr}` : undefined,
    ].filter(Boolean).join('\n'))
  }
}

describe('CodexRemoteProxy constrained heap large response forwarding', () => {
  it('constrained heap forwards a large stateful thread/fork response below a small active cap', async () => {
    await runLargeForwardStressChild({
      capBytes: SMALL_CONSTRAINED_HEAP_CAP_BYTES,
      heapMb: 96,
      mode: 'stateful-fork',
      timeoutMs: 30_000,
    })
  }, 35_000)

  it('constrained heap raw-forwards a large non-state response below a small active cap', async () => {
    await runLargeForwardStressChild({
      capBytes: SMALL_CONSTRAINED_HEAP_CAP_BYTES,
      heapMb: 96,
      mode: 'non-state',
      timeoutMs: 30_000,
    })
  }, 35_000)

  it('constrained heap rejects an above-cap upstream response at a small active cap', async () => {
    await runLargeForwardStressChild({
      capBytes: SMALL_CONSTRAINED_HEAP_CAP_BYTES,
      heapMb: 96,
      mode: 'above-cap',
      timeoutMs: 30_000,
    })
  }, 35_000)
})

const describeFullBoundaryStress = process.env.FRESHELL_RUN_LARGE_PROXY_STRESS === '1'
  ? describe
  : describe.skip

describeFullBoundaryStress('CodexRemoteProxy constrained heap full-boundary large response forwarding', () => {
  it('constrained heap forwards a large stateful thread/fork response at the raw-forward cap', async () => {
    await runLargeForwardStressChild({
      capBytes: MAX_RAW_FORWARD_BYTES,
      heapMb: 128,
      mode: 'stateful-fork',
      timeoutMs: 60_000,
    })
  }, 65_000)

  it('constrained heap raw-forwards a large non-state response at the raw-forward cap', async () => {
    await runLargeForwardStressChild({
      capBytes: MAX_RAW_FORWARD_BYTES,
      heapMb: 128,
      mode: 'non-state',
      timeoutMs: 60_000,
    })
  }, 65_000)

  it('constrained heap rejects an above-cap upstream response at the raw-forward cap', async () => {
    await runLargeForwardStressChild({
      capBytes: MAX_RAW_FORWARD_BYTES,
      heapMb: 128,
      mode: 'above-cap',
      timeoutMs: 60_000,
    })
  }, 65_000)
})

describe('CodexRemoteProxy', () => {
  it('preserves text and binary frames across client and upstream forwarding', async () => {
    const upstream = await startUpstream((socket, message) => {
      if (message.method === 'initialize') {
        socket.send('{ "jsonrpc" : "2.0" , "id" : 1 , "result" : { "text" : true } }', { binary: false })
      } else if (message.method === 'custom/binary') {
        socket.send(Buffer.from('{"jsonrpc":"2.0","id":2,"result":{"binary":true}}'), { binary: true })
      }
    })
    const proxy = await startProxy(upstream.wsUrl, {
      requireCandidatePersistence: false,
    })
    const tui = await connect(proxy.wsUrl)
    const responseFrames = collectRawFrames(tui, 2)

    const textRequest = '{ "id" : 1 , "method" : "initialize" , "params" : { "keep" : "spacing" } }'
    const binaryRequest = Buffer.from('{"id":2,"method":"custom/binary","params":{"raw":true}}')
    tui.send(textRequest, { binary: false })
    tui.send(binaryRequest, { binary: true })

    await vi.waitFor(() => expect(upstream.frames).toHaveLength(2))
    expect(upstream.frames[0]).toMatchObject({ text: textRequest, isBinary: false })
    expect(upstream.frames[1]).toMatchObject({ text: binaryRequest.toString(), isBinary: true })

    await expect(responseFrames).resolves.toEqual([
      {
        raw: Buffer.from('{ "jsonrpc" : "2.0" , "id" : 1 , "result" : { "text" : true } }'),
        isBinary: false,
      },
      {
        raw: Buffer.from('{"jsonrpc":"2.0","id":2,"result":{"binary":true}}'),
        isBinary: true,
      },
    ])
  })

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
    const responsePromise = nextMessageFrame(tui)

    tui.send(JSON.stringify({ id: 1, method: 'thread/start', params: {} }))

    await expect(responsePromise).resolves.toMatchObject({
      isBinary: false,
      message: {
        id: 1,
        result: {
          thread: {
            id: 'thread-1',
            path: '/tmp/codex/rollout.jsonl',
          },
        },
      },
    })
    expect(upstream.binaryFlags).toEqual([false])
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

  it('holds thread/fork behind initial_capture without orphaning already-held initial frames', async () => {
    const upstream = await startUpstream((socket, message) => {
      if (message.method === 'turn/start') {
        socket.send(JSON.stringify({ id: message.id, result: { ok: true } }))
      } else if (message.method === 'thread/fork') {
        socket.send(JSON.stringify({
          id: message.id,
          result: {
            thread: {
              id: 'thread-child-after-initial',
              path: '/tmp/codex/thread-child-after-initial.jsonl',
              ephemeral: false,
            },
          },
        }))
      }
    })
    const proxy = await startProxy(upstream.wsUrl, {
      candidateCaptureTimeoutMs: 1_000,
    })
    const candidates: unknown[] = []
    proxy.onCandidate((candidate) => candidates.push(candidate))
    const tui = await connect(proxy.wsUrl)
    const initialResponses = collectRawFrames(tui, 2)

    tui.send(JSON.stringify({
      id: 701,
      method: 'turn/start',
      params: { threadId: 'thread-original', input: [{ type: 'text', text: 'held first' }] },
    }))
    tui.send(JSON.stringify({
      id: 702,
      method: 'thread/fork',
      params: { threadId: 'thread-original', excludeTurns: false },
    }))

    await delay(50)
    expect(upstream.messages).toEqual([])
    expect(candidates).toEqual([])

    proxy.markCandidatePersisted()

    await vi.waitFor(() => expect(upstream.messages).toHaveLength(2))
    expect(upstream.messages[0]).toMatchObject({
      id: 701,
      method: 'turn/start',
      params: { threadId: 'thread-original' },
    })
    expect(upstream.messages[1]).toMatchObject({
      id: 702,
      method: 'thread/fork',
      params: { threadId: 'thread-original', excludeTurns: true },
    })

    const responseMessages = (await initialResponses).map((frame) => JSON.parse(frame.raw.toString()))
    expect(responseMessages).toEqual(expect.arrayContaining([
      { id: 701, result: { ok: true } },
      expect.objectContaining({
        id: 702,
        result: {
          thread: expect.objectContaining({
            id: 'thread-child-after-initial',
            turns: [],
          }),
        },
      }),
    ]))
    expect(candidates).toEqual([
      {
        source: 'thread_fork_response',
        thread: {
          id: 'thread-child-after-initial',
          path: '/tmp/codex/thread-child-after-initial.jsonl',
          ephemeral: false,
        },
      },
    ])

    tui.send(JSON.stringify({
      id: 703,
      method: 'turn/start',
      params: { threadId: 'thread-child-after-initial' },
    }))
    await delay(50)
    expect(upstream.messages).toHaveLength(2)

    proxy.markCandidatePersisted()

    await vi.waitFor(() => expect(upstream.messages).toHaveLength(3))
    expect(upstream.messages[2]).toMatchObject({
      id: 703,
      method: 'turn/start',
      params: { threadId: 'thread-child-after-initial' },
    })
  })

  it('holds turn/start text frames and releases them with text framing intact', async () => {
    const upstream = await startUpstream((socket, message) => {
      if (message.method === 'turn/start') {
        socket.send(JSON.stringify({ id: message.id, result: { ok: true } }))
      }
    })
    const proxy = await startProxy(upstream.wsUrl, {
      candidateCaptureTimeoutMs: 1_000,
    })
    const tui = await connect(proxy.wsUrl)

    const rawTurnStart = '{ "id" : 70 , "method" : "turn/start" , "params" : { "threadId" : "thread-1" } }'
    tui.send(rawTurnStart, { binary: false })
    await delay(25)
    expect(upstream.messages).toHaveLength(0)

    proxy.markCandidatePersisted()

    await vi.waitFor(() => expect(upstream.frames).toHaveLength(1))
    expect(upstream.frames[0]).toMatchObject({
      text: rawTurnStart,
      isBinary: false,
    })
  })

  it('holds malformed huge-param turn/start frames without parsing params while initial_capture is pending', async () => {
    const upstream = await startUpstream()
    const proxy = await startProxy(upstream.wsUrl, {
      candidateCaptureTimeoutMs: 1_000,
    })
    const tui = await connect(proxy.wsUrl)
    const rawTurnStart = JSON.stringify({
      id: 78,
      method: 'turn/start',
      params: {
        threadId: 42,
        padding: 'x'.repeat(64 * 1024),
      },
    })
    const originalParse: typeof JSON.parse = JSON.parse
    const parseSpy = vi.spyOn(JSON, 'parse').mockImplementation(((text, reviver) => {
      if (text === rawTurnStart) {
        throw new Error('turn/start params should not be parsed while initial_capture is pending')
      }
      return originalParse(text, reviver)
    }) as typeof JSON.parse)

    tui.send(rawTurnStart)
    await delay(25)

    expect(parseSpy.mock.calls.some(([text]) => text === rawTurnStart)).toBe(false)
    expect(upstream.messages).toEqual([])

    parseSpy.mockRestore()
    proxy.markCandidatePersisted()

    await vi.waitFor(() => expect(upstream.frames).toHaveLength(1))
    expect(upstream.frames[0]).toMatchObject({
      text: rawTurnStart,
      isBinary: false,
    })
  })

  it('raw-forwards a large valid non-fork request below the active cap', async () => {
    const upstream = await startUpstream()
    const proxy = await startProxy(upstream.wsUrl, {
      requireCandidatePersistence: false,
    })
    const tui = await connect(proxy.wsUrl)
    const payload = 'x'.repeat(MAX_FULL_PARSE_BYTES + 1_024)
    const raw = JSON.stringify({
      id: 71,
      method: 'initialize',
      params: { payload },
    })

    tui.send(raw)

    await vi.waitFor(() => expect(upstream.frames).toHaveLength(1))
    expect(upstream.frames[0]).toMatchObject({
      text: raw,
      isBinary: false,
    })
  })

  it('returns proxy_error and does not forward above-cap client requests', async () => {
    const upstream = await startUpstream()
    const proxy = await startProxy(upstream.wsUrl, {
      maxRawForwardBytes: 256,
      requireCandidatePersistence: false,
    })
    const repairTriggers: unknown[] = []
    proxy.onRepairTrigger((event) => repairTriggers.push(event))
    const tui = await connect(proxy.wsUrl)

    tui.send(JSON.stringify({
      id: 72,
      method: 'initialize',
      params: { payload: 'x'.repeat(512) },
    }))

    const outcome = await Promise.race([
      nextMessageWithin(tui, 100).then((message) => ({ kind: 'message' as const, message })),
      socketClosed(tui).then(() => ({ kind: 'closed' as const })),
    ])
    if (outcome.kind === 'message') {
      expect(outcome.message).toMatchObject({
        id: 72,
        error: { message: expect.stringContaining('too large') },
      })
    }
    await socketClosed(tui)
    expect(upstream.messages).toEqual([])
    expect(repairTriggers).toContainEqual(expect.objectContaining({ kind: 'proxy_error' }))
  })

  it('holds large turn/start requests and raw-forwards them after candidate persistence', async () => {
    const upstream = await startUpstream()
    const proxy = await startProxy(upstream.wsUrl, {
      candidateCaptureTimeoutMs: 1_000,
    })
    const tui = await connect(proxy.wsUrl)
    const raw = JSON.stringify({
      id: 73,
      method: 'turn/start',
      params: {
        threadId: 'thread-1',
        input: [{ type: 'text', text: 'x'.repeat(MAX_FULL_PARSE_BYTES + 1_024) }],
      },
    })

    tui.send(raw)
    await delay(25)
    expect(upstream.messages).toEqual([])

    proxy.markCandidatePersisted()

    await vi.waitFor(() => expect(upstream.frames).toHaveLength(1))
    expect(upstream.frames[0]).toMatchObject({
      text: raw,
      isBinary: false,
    })
  })

  it('fails initial_capture when held turn/start frames overflow the held-byte cap', async () => {
    const upstream = await startUpstream()
    const proxy = await startProxy(upstream.wsUrl, {
      candidateCaptureTimeoutMs: 1_000,
      maxRawForwardBytes: 512,
    })
    const repairTriggers: unknown[] = []
    proxy.onRepairTrigger((event) => repairTriggers.push(event))
    const tui = await connect(proxy.wsUrl)

    tui.send(JSON.stringify({
      id: 74,
      method: 'turn/start',
      params: { threadId: 'thread-1', input: 'x'.repeat(260) },
    }))
    tui.send(JSON.stringify({
      id: 75,
      method: 'turn/start',
      params: { threadId: 'thread-1', input: 'x'.repeat(260) },
    }))

    await expect(Promise.race([
      socketClosed(tui).then(() => 'closed'),
      delay(100).then(() => 'timeout'),
    ])).resolves.toBe('closed')
    expect(upstream.messages).toEqual([])
    expect(repairTriggers).toContainEqual(expect.objectContaining({ kind: 'candidate_capture_timeout' }))
  })

  it('fails initial_capture when held turn/start frame count overflows', async () => {
    const upstream = await startUpstream()
    const proxy = await startProxy(upstream.wsUrl, {
      candidateCaptureTimeoutMs: 1_000,
    })
    const tui = await connect(proxy.wsUrl)

    for (let index = 0; index < 40; index += 1) {
      tui.send(JSON.stringify({
        id: 760 + index,
        method: 'turn/start',
        params: { threadId: 'thread-1', input: String(index) },
      }))
    }

    await expect(Promise.race([
      socketClosed(tui).then(() => 'closed'),
      delay(100).then(() => 'timeout'),
    ])).resolves.toBe('closed')
    expect(upstream.messages).toEqual([])
  })

  it('holds fork_handoff turn/start frames and releases them through candidate persistence', async () => {
    const upstream = await startUpstream()
    const proxy = await startProxy(upstream.wsUrl, {
      requireCandidatePersistence: false,
    })
    ;(proxy as any).identityGate = {
      reason: 'fork_handoff',
      heldFrames: [],
      heldBytes: 0,
    }
    const tui = await connect(proxy.wsUrl)
    const rawTurnStart = JSON.stringify({
      id: 77,
      method: 'turn/start',
      params: { threadId: 'thread-child' },
    })

    tui.send(rawTurnStart)
    await delay(25)
    expect(upstream.messages).toEqual([])

    proxy.markCandidatePersisted()

    await vi.waitFor(() => expect(upstream.frames).toHaveLength(1))
    expect(upstream.frames[0]).toMatchObject({
      text: rawTurnStart,
      isBinary: false,
    })
  })

  it('fails the overflow-causing fork_handoff turn/start request with an error and closes that client', async () => {
    const upstream = await startUpstream()
    const proxy = await startProxy(upstream.wsUrl, {
      maxRawForwardBytes: 512,
      requireCandidatePersistence: false,
    })
    ;(proxy as any).identityGate = {
      reason: 'fork_handoff',
      heldFrames: [],
      heldBytes: 0,
    }
    const firstTui = await connect(proxy.wsUrl)
    const overflowTui = await connect(proxy.wsUrl)
    const overflowResponse = nextMessage(overflowTui)
    const overflowClosed = socketClosed(overflowTui)

    firstTui.send(JSON.stringify({
      id: 79,
      method: 'turn/start',
      params: { threadId: 'thread-child', input: 'x'.repeat(260) },
    }))
    await delay(25)
    expect(upstream.messages).toEqual([])

    overflowTui.send(JSON.stringify({
      id: 80,
      method: 'turn/start',
      params: { threadId: 'thread-child', input: 'x'.repeat(260) },
    }))

    await expect(overflowResponse).resolves.toMatchObject({
      id: 80,
      error: { message: expect.stringContaining('fork handoff') },
    })
    await expect(overflowClosed).resolves.toBeUndefined()
    expect(upstream.messages).toEqual([])
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

  it('does not hold turn/start or arm candidate-capture timeout when candidate persistence is not required', async () => {
    const upstream = await startUpstream((socket, message) => {
      if (message.method === 'turn/start') {
        socket.send(JSON.stringify({ id: message.id, result: { ok: true } }))
      }
    })
    const proxy = await startProxy(upstream.wsUrl, {
      requestHoldTimeoutMs: 20,
      candidateCaptureTimeoutMs: 20,
      requireCandidatePersistence: false,
    })
    const repairTriggers: unknown[] = []
    proxy.onRepairTrigger((event) => repairTriggers.push(event))
    const tui = await connect(proxy.wsUrl)
    const responsePromise = nextMessage(tui)

    tui.send(JSON.stringify({ id: 11, method: 'turn/start', params: { threadId: 'durable-thread-1' } }))

    await expect(responsePromise).resolves.toEqual({ id: 11, result: { ok: true } })
    expect(upstream.messages).toEqual([
      { id: 11, method: 'turn/start', params: { threadId: 'durable-thread-1' } },
    ])
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(tui.readyState).toBe(WebSocket.OPEN)
    expect(repairTriggers).toEqual([])
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

  it('times out candidate capture even when the TUI never connects to the proxy', async () => {
    const upstream = await startUpstream()
    const proxy = await startProxy(upstream.wsUrl, {
      candidateCaptureTimeoutMs: 20,
    })
    const repairTriggers: unknown[] = []
    proxy.onRepairTrigger((event) => repairTriggers.push(event))

    await delay(50)

    expect(upstream.messages).toHaveLength(0)
    expect(repairTriggers).toContainEqual({ kind: 'candidate_capture_timeout' })
  })

  it('keeps candidate capture paused when a real client connection would otherwise rearm the timer', async () => {
    const upstream = await startUpstream()
    const proxy = await startProxy(upstream.wsUrl, {
      candidateCaptureTimeoutMs: 20,
    })
    const repairTriggers: unknown[] = []
    proxy.onRepairTrigger((event) => repairTriggers.push(event))

    proxy.pauseCandidateCapture('startup_update_prompt')
    const tui = await connect(proxy.wsUrl)

    await delay(50)

    expect(tui.readyState).toBe(WebSocket.OPEN)
    expect(upstream.sockets.size).toBe(1)
    expect(upstream.messages).toEqual([])
    expect(repairTriggers).toEqual([])

    tui.close()
    await socketClosed(tui)
  })

  it('resumes candidate capture timeout so a later timeout still fires', async () => {
    const upstream = await startUpstream()
    const proxy = await startProxy(upstream.wsUrl, {
      candidateCaptureTimeoutMs: 20,
    })
    const repairTriggers: unknown[] = []
    proxy.onRepairTrigger((event) => repairTriggers.push(event))

    proxy.pauseCandidateCapture('startup_update_prompt')
    await delay(50)
    expect(repairTriggers).toEqual([])

    proxy.resumeCandidateCapture('startup_update_prompt_skipped')
    await delay(50)

    expect(repairTriggers).toContainEqual({ kind: 'candidate_capture_timeout' })
  })

  it('leaves pause and resume as no-ops after candidate persistence', () => {
    vi.useFakeTimers()
    const proxy = new CodexRemoteProxy({
      upstreamWsUrl: 'ws://127.0.0.1:1',
      candidateCaptureTimeoutMs: 1_000,
    })
    proxies.add(proxy)
    const repairTriggers: unknown[] = []
    proxy.onRepairTrigger((event) => repairTriggers.push(event))

    proxy.markCandidatePersisted()
    proxy.pauseCandidateCapture('after_persistence')
    proxy.resumeCandidateCapture('after_persistence')
    vi.advanceTimersByTime(5_000)

    expect(repairTriggers).toEqual([])
  })

  it('leaves pause and resume as no-ops after candidate timeout failure', () => {
    vi.useFakeTimers()
    const proxy = new CodexRemoteProxy({
      upstreamWsUrl: 'ws://127.0.0.1:1',
      candidateCaptureTimeoutMs: 1_000,
    })
    proxies.add(proxy)
    const repairTriggers: unknown[] = []
    proxy.onRepairTrigger((event) => repairTriggers.push(event))

    proxy.failCandidateCapture()
    proxy.pauseCandidateCapture('after_timeout_failure')
    proxy.resumeCandidateCapture('after_timeout_failure')
    vi.advanceTimersByTime(5_000)

    expect(repairTriggers).toEqual([{ kind: 'candidate_capture_timeout' }])
  })

  it('leaves pause and resume as no-ops when candidate persistence is not required', () => {
    vi.useFakeTimers()
    const proxy = new CodexRemoteProxy({
      upstreamWsUrl: 'ws://127.0.0.1:1',
      candidateCaptureTimeoutMs: 1_000,
      requireCandidatePersistence: false,
    })
    proxies.add(proxy)
    const repairTriggers: unknown[] = []
    proxy.onRepairTrigger((event) => repairTriggers.push(event))

    proxy.pauseCandidateCapture('durable_resume')
    proxy.resumeCandidateCapture('durable_resume')
    vi.advanceTimersByTime(5_000)

    expect(repairTriggers).toEqual([])
  })

  it('does not arm the no-client candidate-capture timeout for durable resumes', async () => {
    const upstream = await startUpstream()
    const proxy = await startProxy(upstream.wsUrl, {
      candidateCaptureTimeoutMs: 20,
      requireCandidatePersistence: false,
    })
    const repairTriggers: unknown[] = []
    proxy.onRepairTrigger((event) => repairTriggers.push(event))

    await delay(50)

    expect(upstream.messages).toHaveLength(0)
    expect(repairTriggers).toEqual([])
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

  it('acks duplicate turn/interrupt after the turn already completed', async () => {
    const interruptRequests: unknown[] = []
    const upstream = await startUpstream((socket, message) => {
      if (message.method !== 'turn/interrupt') return
      interruptRequests.push(message)
      if (interruptRequests.length !== 1) return

      socket.send(JSON.stringify({ id: message.id, result: {} }))
      socket.send(JSON.stringify({
        method: 'thread/status/changed',
        params: { threadId: 'thread-1', status: { type: 'idle' } },
      }))
      socket.send(JSON.stringify({
        method: 'turn/completed',
        params: { threadId: 'thread-1', turnId: 'turn-1' },
      }))
    })
    const proxy = await startProxy(upstream.wsUrl, {
      requireCandidatePersistence: false,
    })
    const completed = new Promise((resolve) => {
      proxy.onTurnCompleted((event) => resolve(event))
    })
    const tui = await connect(proxy.wsUrl)

    tui.send(JSON.stringify({
      id: 1,
      method: 'turn/interrupt',
      params: { threadId: 'thread-1', turnId: 'turn-1' },
    }))
    await expect(nextMessageWithin(tui, 100)).resolves.toEqual({ id: 1, result: {} })
    await expect(completed).resolves.toMatchObject({ threadId: 'thread-1', turnId: 'turn-1' })

    tui.send(JSON.stringify({
      id: 2,
      method: 'turn/interrupt',
      params: { threadId: 'thread-1', turnId: 'turn-1' },
    }))

    await expect(nextResponseWithIdWithin(tui, 2, 50)).resolves.toEqual({ id: 2, result: {} })
    await delay(25)
    expect(interruptRequests).toHaveLength(1)
  })

  it('forwards large turn/interrupt frames instead of parsing params for duplicate ack', async () => {
    const interruptRequests: unknown[] = []
    const upstream = await startUpstream((socket, message) => {
      if (message.method !== 'turn/interrupt') return
      interruptRequests.push(message)
      if (interruptRequests.length !== 1) return

      socket.send(JSON.stringify({ id: message.id, result: {} }))
      socket.send(JSON.stringify({
        method: 'turn/completed',
        params: { threadId: 'thread-1', turnId: 'turn-1' },
      }))
    })
    const proxy = await startProxy(upstream.wsUrl, {
      requireCandidatePersistence: false,
    })
    const completed = new Promise((resolve) => {
      proxy.onTurnCompleted((event) => resolve(event))
    })
    const tui = await connect(proxy.wsUrl)

    tui.send(JSON.stringify({
      id: 81,
      method: 'turn/interrupt',
      params: { threadId: 'thread-1', turnId: 'turn-1' },
    }))
    await expect(nextMessageWithin(tui, 100)).resolves.toEqual({ id: 81, result: {} })
    await expect(completed).resolves.toMatchObject({ threadId: 'thread-1', turnId: 'turn-1' })

    const largeDuplicateInterrupt = JSON.stringify({
      id: 82,
      method: 'turn/interrupt',
      params: { threadId: 'thread-1', turnId: 'turn-1' },
      padding: 'x'.repeat(MAX_FULL_PARSE_BYTES + 1_024),
    })
    tui.send(largeDuplicateInterrupt)

    await vi.waitFor(() => expect(interruptRequests).toHaveLength(2))
    expect(upstream.frames[1]).toMatchObject({
      text: largeDuplicateInterrupt,
      isBinary: false,
    })
  })

  it('forces terminal thread/fork requests to exclude turns before forwarding upstream', async () => {
    const upstream = await startUpstream()
    const proxy = await startProxy(upstream.wsUrl, {
      requireCandidatePersistence: false,
    })
    const tui = await connect(proxy.wsUrl)

    tui.send(JSON.stringify({
      id: 21,
      method: 'thread/fork',
      params: {
        threadId: 'thread-parent',
        cwd: '/repo',
        excludeTurns: false,
        nested: { excludeTurns: false },
      },
    }))

    await vi.waitFor(() => expect(upstream.messages).toHaveLength(1))
    expect(upstream.messages[0]).toEqual({
      id: 21,
      method: 'thread/fork',
      params: {
        threadId: 'thread-parent',
        cwd: '/repo',
        excludeTurns: true,
        nested: { excludeTurns: false },
      },
    })
  })

  it('forces large terminal thread/fork requests to exclude turns before forwarding upstream', async () => {
    const upstream = await startUpstream()
    const proxy = await startProxy(upstream.wsUrl, {
      requireCandidatePersistence: false,
    })
    const tui = await connect(proxy.wsUrl)

    tui.send(JSON.stringify({
      id: 83,
      method: 'thread/fork',
      params: {
        threadId: 'thread-parent',
        cwd: '/repo',
        excludeTurns: false,
        metadata: 'x'.repeat(MAX_FULL_PARSE_BYTES + 1_024),
      },
    }))

    await vi.waitFor(() => expect(upstream.messages).toHaveLength(1))
    expect(upstream.messages[0]).toMatchObject({
      id: 83,
      method: 'thread/fork',
      params: {
        threadId: 'thread-parent',
        cwd: '/repo',
        excludeTurns: true,
      },
    })
  })

  it('returns an error for unrewriteable thread/fork requests without forwarding upstream', async () => {
    const upstream = await startUpstream()
    const proxy = await startProxy(upstream.wsUrl, {
      requireCandidatePersistence: false,
    })
    const tui = await connect(proxy.wsUrl)

    tui.send(JSON.stringify({
      id: 84,
      method: 'thread/fork',
      params: {
        threadId: 'thread-parent',
        excludeTurns: 'nope',
      },
    }))

    await expect(nextMessageWithin(tui, 100)).resolves.toMatchObject({
      id: 84,
      error: { message: expect.stringContaining('thread/fork') },
    })
    await delay(25)
    expect(upstream.messages).toEqual([])
  })

  it('returns an error for malformed thread/fork requests without forwarding upstream', async () => {
    const upstream = await startUpstream()
    const proxy = await startProxy(upstream.wsUrl, {
      requireCandidatePersistence: false,
    })
    const tui = await connect(proxy.wsUrl)

    tui.send('{"id":85,"method":"thread/fork","params":{"threadId":"thread-parent","excludeTurns":false}')

    await expect(nextMessageWithin(tui, 100)).resolves.toMatchObject({
      error: { message: expect.stringContaining('malformed_json') },
    })
    await delay(25)
    expect(upstream.messages).toEqual([])
  })

  it('rejects nested thread/fork requests while a fork_handoff gate is active', async () => {
    const upstream = await startUpstream()
    const proxy = await startProxy(upstream.wsUrl, {
      requireCandidatePersistence: false,
    })
    ;(proxy as any).identityGate = {
      reason: 'fork_handoff',
      heldFrames: [],
      heldBytes: 0,
    }
    const tui = await connect(proxy.wsUrl)

    tui.send(JSON.stringify({
      id: 86,
      method: 'thread/fork',
      params: { threadId: 'thread-child' },
    }))

    await expect(nextMessageWithin(tui, 100)).resolves.toMatchObject({
      id: 86,
      error: { message: expect.stringContaining('fork handoff') },
    })
    await delay(25)
    expect(upstream.messages).toEqual([])
  })

  it('treats root array batches as unsafe instead of forwarding possible fork traffic', async () => {
    const upstream = await startUpstream()
    const proxy = await startProxy(upstream.wsUrl, {
      requireCandidatePersistence: false,
    })
    const tui = await connect(proxy.wsUrl)

    tui.send(JSON.stringify([
      { id: 31, method: 'thread/fork', params: { threadId: 'thread-parent' } },
    ]))

    await expect(nextMessageWithin(tui, 100)).resolves.toMatchObject({
      error: { message: expect.stringContaining('batch') },
    })
    await socketClosed(tui)
    expect(upstream.messages).toEqual([])
  })

  it('recovers large thread/start response candidates before forwarding', async () => {
    const upstream = await startUpstream((socket, message) => {
      if (message.method !== 'thread/start') return
      socket.send(JSON.stringify({
        id: message.id,
        result: {
          thread: {
            id: 'thread-large-start',
            path: '/tmp/codex/large-start.jsonl',
            ephemeral: false,
          },
        },
        padding: largePadding(),
      }))
    })
    const proxy = await startProxy(upstream.wsUrl)
    const candidates: unknown[] = []
    proxy.onCandidate((candidate) => {
      candidates.push(candidate)
      proxy.markCandidatePersisted()
    })
    const tui = await connect(proxy.wsUrl)
    const response = nextMessageFrame(tui)

    tui.send(JSON.stringify({ id: 101, method: 'thread/start', params: {} }))

    await expect(response).resolves.toMatchObject({
      message: {
        id: 101,
        result: {
          thread: {
            id: 'thread-large-start',
            path: '/tmp/codex/large-start.jsonl',
          },
        },
      },
    })
    expect(candidates).toEqual([
      {
        source: 'thread_start_response',
        thread: {
          id: 'thread-large-start',
          path: '/tmp/codex/large-start.jsonl',
          ephemeral: false,
        },
      },
    ])
  })

  it('recovers large thread/started notification candidate and lifecycle side effects before forwarding', async () => {
    const upstream = await startUpstream((socket, message) => {
      if (message.method !== 'initialize') return
      socket.send(JSON.stringify({ id: message.id, result: {} }))
      socket.send(JSON.stringify({
        method: 'thread/started',
        params: {
          thread: {
            id: 'thread-large-notified',
            path: '/tmp/codex/large-notified.jsonl',
            ephemeral: false,
          },
        },
        padding: largePadding(),
      }))
    })
    const proxy = await startProxy(upstream.wsUrl)
    const candidates: unknown[] = []
    const lifecycleEvents: unknown[] = []
    proxy.onCandidate((candidate) => {
      candidates.push(candidate)
      proxy.markCandidatePersisted()
    })
    proxy.onThreadLifecycle((event) => lifecycleEvents.push(event))
    const tui = await connect(proxy.wsUrl)

    tui.send(JSON.stringify({ id: 102, method: 'initialize', params: {} }))

    await vi.waitFor(() => expect(candidates).toHaveLength(1))
    expect(candidates[0]).toEqual({
      source: 'thread_started_notification',
      thread: {
        id: 'thread-large-notified',
        path: '/tmp/codex/large-notified.jsonl',
        ephemeral: false,
      },
    })
    expect(lifecycleEvents).toEqual([
      {
        kind: 'thread_started',
        thread: {
          id: 'thread-large-notified',
          path: '/tmp/codex/large-notified.jsonl',
          ephemeral: false,
        },
      },
    ])
  })

  it('recovers large turn started and completed side effects before forwarding', async () => {
    const upstream = await startUpstream((socket, message) => {
      if (message.method !== 'initialize') return
      socket.send(JSON.stringify({ id: message.id, result: {} }))
      socket.send(JSON.stringify({
        method: 'turn/started',
        params: { threadId: 'thread-large-turn', turnId: 'turn-1' },
        padding: largePadding(),
      }))
      socket.send(JSON.stringify({
        method: 'turn/completed',
        params: {
          threadId: 'thread-large-turn',
          turnId: 'turn-1',
          turn: { id: 'turn-1', status: 'completed' },
        },
        padding: largePadding(),
      }))
    })
    const proxy = await startProxy(upstream.wsUrl, {
      requireCandidatePersistence: false,
    })
    const started: unknown[] = []
    const completed: unknown[] = []
    proxy.onTurnStarted((event) => started.push(event))
    proxy.onTurnCompleted((event) => completed.push(event))
    const tui = await connect(proxy.wsUrl)

    tui.send(JSON.stringify({ id: 103, method: 'initialize', params: {} }))

    await vi.waitFor(() => expect(started).toHaveLength(1))
    await vi.waitFor(() => expect(completed).toHaveLength(1))
    expect(started[0]).toMatchObject({ threadId: 'thread-large-turn', turnId: 'turn-1' })
    expect(completed[0]).toMatchObject({ threadId: 'thread-large-turn', turnId: 'turn-1' })
  })

  it('recovers large fs changed side effects with empty paths when the path list is too large', async () => {
    const upstream = await startUpstream((socket, message) => {
      if (message.method !== 'initialize') return
      socket.send(JSON.stringify({ id: message.id, result: {} }))
      socket.send(JSON.stringify({
        method: 'fs/changed',
        params: {
          watchId: 'watch-large',
          changedPaths: [`/tmp/${largePadding()}`],
        },
      }))
    })
    const proxy = await startProxy(upstream.wsUrl, {
      requireCandidatePersistence: false,
    })
    const repairTriggers: unknown[] = []
    proxy.onRepairTrigger((event) => repairTriggers.push(event))
    const tui = await connect(proxy.wsUrl)

    tui.send(JSON.stringify({ id: 104, method: 'initialize', params: {} }))

    await vi.waitFor(() => {
      expect(repairTriggers).toContainEqual({
        kind: 'fs_changed',
        watchId: 'watch-large',
        changedPaths: [],
      })
    })
  })

  it('recovers large thread/status and thread/closed lifecycle side effects before forwarding', async () => {
    const upstream = await startUpstream((socket, message) => {
      if (message.method !== 'initialize') return
      socket.send(JSON.stringify({ id: message.id, result: {} }))
      socket.send(JSON.stringify({
        method: 'thread/closed',
        params: { threadId: 'thread-large-lifecycle' },
        padding: largePadding(),
      }))
      socket.send(JSON.stringify({
        method: 'thread/status/changed',
        params: {
          threadId: 'thread-large-lifecycle',
          status: { type: 'systemError', details: largePadding() },
        },
      }))
    })
    const proxy = await startProxy(upstream.wsUrl, {
      requireCandidatePersistence: false,
    })
    const lifecycleEvents: unknown[] = []
    const lifecycleLosses: unknown[] = []
    proxy.onThreadLifecycle((event) => lifecycleEvents.push(event))
    proxy.onLifecycleLoss((event) => lifecycleLosses.push(event))
    const tui = await connect(proxy.wsUrl)

    tui.send(JSON.stringify({ id: 105, method: 'initialize', params: {} }))

    await vi.waitFor(() => expect(lifecycleEvents).toHaveLength(2))
    expect(lifecycleEvents).toEqual([
      { kind: 'thread_closed', threadId: 'thread-large-lifecycle' },
      {
        kind: 'thread_status_changed',
        threadId: 'thread-large-lifecycle',
        status: { type: 'systemError' },
      },
    ])
    expect(lifecycleLosses).toEqual([
      { method: 'thread/closed', threadId: 'thread-large-lifecycle' },
      {
        method: 'thread/status/changed',
        threadId: 'thread-large-lifecycle',
        status: 'systemError',
      },
    ])
  })

  it('recovers large thread/fork responses with id after result, forwards the raw response, and clears pending state', async () => {
    let duplicateForkResponse = ''
    const upstream = await startUpstream((socket, message) => {
      if (message.method !== 'thread/fork') return
      const forkResponse = `{"result":{"thread":{"id":"thread-large-child","path":"/tmp/codex/large-fork.jsonl","ephemeral":false,"turns":[]}},"id":${message.id},"padding":"${largePadding()}"}`
      duplicateForkResponse = `{"result":{"thread":{"id":"thread-large-child-duplicate","path":"/tmp/codex/large-fork-duplicate.jsonl","ephemeral":false,"turns":[]}},"id":${message.id}}`
      socket.send(forkResponse)
      socket.send(duplicateForkResponse)
    })
    const proxy = await startProxy(upstream.wsUrl, {
      requireCandidatePersistence: false,
    })
    const candidates: unknown[] = []
    proxy.onCandidate((candidate) => candidates.push(candidate))
    const tui = await connect(proxy.wsUrl)
    const frames = collectRawFrames(tui, 2)

    tui.send(JSON.stringify({
      id: 106,
      method: 'thread/fork',
      params: { threadId: 'thread-parent', excludeTurns: false },
    }))

    const [firstFrame, secondFrame] = await frames
    expect(firstFrame.raw.toString()).toContain('"result":{"thread":{"id":"thread-large-child"')
    expect(firstFrame.raw.toString()).toContain('"id":106')
    expect(secondFrame.raw.toString()).toBe(duplicateForkResponse)
    expect(candidates).toEqual([
      {
        source: 'thread_fork_response',
        thread: {
          id: 'thread-large-child',
          path: '/tmp/codex/large-fork.jsonl',
          ephemeral: false,
        },
      },
    ])
  })

  it('normalizes large thread/fork responses and holds post-fork stateful client requests until persistence', async () => {
    const upstream = await startUpstream((socket, message) => {
      if (message.method !== 'thread/fork') return
      socket.send(JSON.stringify({
        id: message.id,
        result: {
          thread: {
            id: 'thread-large-child',
            path: '/tmp/codex/large-fork-normalized.jsonl',
            ephemeral: false,
          },
        },
        padding: largePadding(),
      }))
    })
    const proxy = await startProxy(upstream.wsUrl, {
      requireCandidatePersistence: false,
    })
    const tui = await connect(proxy.wsUrl)
    const forkResponse = nextMessageFrame(tui)

    tui.send(JSON.stringify({
      id: 107,
      method: 'thread/fork',
      params: { threadId: 'thread-parent', excludeTurns: false },
    }))

    await expect(forkResponse).resolves.toMatchObject({
      message: {
        id: 107,
        result: {
          thread: {
            id: 'thread-large-child',
            turns: [],
          },
        },
      },
    })

    tui.send(JSON.stringify({ id: 108, method: 'turn/start', params: { threadId: 'thread-large-child' } }))
    tui.send(JSON.stringify({ id: 109, method: 'turn/steer', params: { threadId: 'thread-large-child' } }))
    tui.send(JSON.stringify({ id: 110, method: 'turn/interrupt', params: { threadId: 'thread-large-child', turnId: 'turn-1' } }))

    await delay(50)
    expect(upstream.messages).toHaveLength(1)

    proxy.markCandidatePersisted()

    await vi.waitFor(() => expect(upstream.messages).toHaveLength(4))
    expect(upstream.messages.slice(1).map((message) => (message as { method: string }).method)).toEqual([
      'turn/start',
      'turn/steer',
      'turn/interrupt',
    ])
  })

  it('queues large thread/fork handoff upstream stateful notifications until persistence', async () => {
    const upstream = await startUpstream((socket, message) => {
      if (message.method !== 'thread/fork') return
      socket.send(JSON.stringify({
        id: message.id,
        result: {
          thread: {
            id: 'thread-large-child',
            path: '/tmp/codex/large-fork-queued.jsonl',
            ephemeral: false,
          },
        },
        padding: largePadding(),
      }))
      socket.send(JSON.stringify({
        method: 'turn/started',
        params: { threadId: 'thread-large-child', turnId: 'turn-queued' },
        padding: largePadding(),
      }))
    })
    const proxy = await startProxy(upstream.wsUrl, {
      requireCandidatePersistence: false,
    })
    const started: unknown[] = []
    proxy.onTurnStarted((event) => started.push(event))
    const tui = await connect(proxy.wsUrl)
    const forkResponse = nextMessageFrame(tui)

    tui.send(JSON.stringify({
      id: 111,
      method: 'thread/fork',
      params: { threadId: 'thread-parent', excludeTurns: false },
    }))

    await expect(forkResponse).resolves.toMatchObject({
      message: {
        id: 111,
        result: { thread: { id: 'thread-large-child', turns: [] } },
      },
    })
    await expectNoMessage(tui, 50)
    expect(started).toEqual([])

    proxy.markCandidatePersisted()

    await expect(nextMessageFrame(tui)).resolves.toMatchObject({
      message: {
        method: 'turn/started',
        params: { threadId: 'thread-large-child', turnId: 'turn-queued' },
      },
    })
    expect(started).toHaveLength(1)
  })

  it('fails large thread/fork handoff timeout with proxy_error and no candidate_capture_timeout', async () => {
    const upstream = await startUpstream((socket, message) => {
      if (message.method !== 'thread/fork') return
      socket.send(JSON.stringify({
        id: message.id,
        result: {
          thread: {
            id: 'thread-large-child',
            path: '/tmp/codex/large-fork-timeout.jsonl',
            ephemeral: false,
          },
        },
        padding: largePadding(),
      }))
    })
    const proxy = await startProxy(upstream.wsUrl, {
      requestHoldTimeoutMs: 20,
      requireCandidatePersistence: false,
    })
    const repairTriggers: unknown[] = []
    proxy.onRepairTrigger((event) => repairTriggers.push(event))
    const tui = await connect(proxy.wsUrl)

    tui.send(JSON.stringify({
      id: 112,
      method: 'thread/fork',
      params: { threadId: 'thread-parent', excludeTurns: false },
    }))
    await expect(nextMessageFrame(tui)).resolves.toMatchObject({
      message: {
        id: 112,
        result: { thread: { id: 'thread-large-child', turns: [] } },
      },
    })

    tui.send(JSON.stringify({ id: 113, method: 'turn/start', params: { threadId: 'thread-large-child' } }))

    await expect(nextMessageWithin(tui, 100)).resolves.toMatchObject({
      id: 113,
      error: { message: expect.stringContaining('fork handoff identity') },
    })
    await socketClosed(tui)
    expect(upstream.messages).toHaveLength(1)
    expect(repairTriggers).toContainEqual(expect.objectContaining({ kind: 'proxy_error' }))
    expect(repairTriggers).not.toContainEqual({ kind: 'candidate_capture_timeout' })
  })

  it('rejects large thread/fork responses with missing parent attribution, same-as-parent child ids, or ids matching only pending methods', async () => {
    async function expectRejectedForkResponse(params: {
      requestId: number
      requestParams: Record<string, unknown>
      responseThreadId: string
      mutateProxy?: (proxy: CodexRemoteProxy) => void
    }): Promise<void> {
      const upstream = await startUpstream()
      const proxy = await startProxy(upstream.wsUrl, {
        requireCandidatePersistence: false,
      })
      const repairTriggers: unknown[] = []
      const candidates: unknown[] = []
      proxy.onRepairTrigger((event) => repairTriggers.push(event))
      proxy.onCandidate((candidate) => candidates.push(candidate))
      const tui = await connect(proxy.wsUrl)

      tui.send(JSON.stringify({
        id: params.requestId,
        method: 'thread/fork',
        params: params.requestParams,
      }))
      await vi.waitFor(() => expect(upstream.messages).toHaveLength(1))
      params.mutateProxy?.(proxy)
      const upstreamSocket = [...upstream.sockets][0]
      expect(upstreamSocket).toBeDefined()
      upstreamSocket?.send(JSON.stringify({
        id: params.requestId,
        result: {
          thread: {
            id: params.responseThreadId,
            path: `/tmp/codex/rejected-${params.requestId}.jsonl`,
            ephemeral: false,
          },
        },
        padding: largePadding(),
      }))

      await expectSocketClosedWithin(tui, 100)
      expect(candidates).toEqual([])
      expect(repairTriggers).toContainEqual(expect.objectContaining({ kind: 'proxy_error' }))
    }

    await expectRejectedForkResponse({
      requestId: 114,
      requestParams: { cwd: '/repo' },
      responseThreadId: 'thread-child',
    })
    await expectRejectedForkResponse({
      requestId: 115,
      requestParams: { threadId: 'thread-parent' },
      responseThreadId: 'thread-parent',
    })
    await expectRejectedForkResponse({
      requestId: 116,
      requestParams: { threadId: 'thread-parent' },
      responseThreadId: 'thread-child',
      mutateProxy: (proxy) => {
        for (const connection of (proxy as any).connections as Set<{ pendingForkRequests: Map<unknown, unknown> }>) {
          connection.pendingForkRequests.clear()
        }
      },
    })
  })

  it('keeps large thread/start pending when only nested result.id matches the request id', async () => {
    const upstream = await startUpstream((socket, message) => {
      if (message.method !== 'thread/start') return
      socket.send(JSON.stringify({
        result: { id: message.id },
        padding: largePadding(),
      }))
      socket.send(JSON.stringify({
        id: message.id,
        result: {
          thread: {
            id: 'thread-nested-id-survivor',
            path: '/tmp/codex/nested-id-survivor.jsonl',
            ephemeral: false,
          },
        },
      }))
    })
    const proxy = await startProxy(upstream.wsUrl)
    const candidates: unknown[] = []
    proxy.onCandidate((candidate) => {
      candidates.push(candidate)
      proxy.markCandidatePersisted()
    })
    const tui = await connect(proxy.wsUrl)
    const frames = collectRawFrames(tui, 2)

    tui.send(JSON.stringify({ id: 117, method: 'thread/start', params: {} }))

    await frames
    expect(candidates).toEqual([
      {
        source: 'thread_start_response',
        thread: {
          id: 'thread-nested-id-survivor',
          path: '/tmp/codex/nested-id-survivor.jsonl',
          ephemeral: false,
        },
      },
    ])
  })

  it('fails closed for large thread/start root-array upstream batches before forwarding', async () => {
    const upstream = await startUpstream((socket, message) => {
      if (message.method !== 'thread/start') return
      socket.send(JSON.stringify([
        {
          id: message.id,
          result: {
            thread: {
              id: 'thread-batch',
              path: '/tmp/codex/batch.jsonl',
              ephemeral: false,
            },
          },
          padding: largePadding(),
        },
      ]))
    })
    const proxy = await startProxy(upstream.wsUrl, {
      requireCandidatePersistence: false,
    })
    const repairTriggers: unknown[] = []
    const candidates: unknown[] = []
    proxy.onRepairTrigger((event) => repairTriggers.push(event))
    proxy.onCandidate((candidate) => candidates.push(candidate))
    const tui = await connect(proxy.wsUrl)

    tui.send(JSON.stringify({ id: 118, method: 'thread/start', params: {} }))

    await expectSocketClosedWithin(tui, 100)
    expect(candidates).toEqual([])
    expect(repairTriggers).toContainEqual(expect.objectContaining({ kind: 'proxy_error' }))
  })

  it('enforces raw forward cap for above-cap upstream non-state frames', async () => {
    const upstream = await startUpstream((socket, message) => {
      if (message.method !== 'initialize') return
      socket.send(JSON.stringify({
        id: message.id,
        result: { ok: true, payload: 'x'.repeat(512) },
      }))
    })
    const proxy = await startProxy(upstream.wsUrl, {
      maxRawForwardBytes: 256,
      requireCandidatePersistence: false,
    })
    const repairTriggers: unknown[] = []
    proxy.onRepairTrigger((event) => repairTriggers.push(event))
    const tui = await connect(proxy.wsUrl)

    tui.send(JSON.stringify({ id: 119, method: 'initialize', params: {} }))

    await expectSocketClosedWithin(tui, 100)
    expect(repairTriggers).toContainEqual(expect.objectContaining({ kind: 'proxy_error' }))
  })

  it('closes on unrecoverable large turn notifications with proxy_error', async () => {
    const upstream = await startUpstream((socket, message) => {
      if (message.method !== 'initialize') return
      socket.send(JSON.stringify({ id: message.id, result: {} }))
      socket.send(JSON.stringify({
        method: 'turn/started',
        params: { turnId: 'turn-missing-thread' },
        padding: largePadding(),
      }))
    })
    const proxy = await startProxy(upstream.wsUrl, {
      requireCandidatePersistence: false,
    })
    const repairTriggers: unknown[] = []
    proxy.onRepairTrigger((event) => repairTriggers.push(event))
    const tui = await connect(proxy.wsUrl)

    tui.send(JSON.stringify({ id: 120, method: 'initialize', params: {} }))

    await expectSocketClosedWithin(tui, 100)
    expect(repairTriggers).toContainEqual(expect.objectContaining({ kind: 'proxy_error' }))
  })

  it('fails candidate capture for unrecoverable large thread/start responses before identity persistence', async () => {
    const upstream = await startUpstream((socket, message) => {
      if (message.method !== 'thread/start') return
      socket.send(JSON.stringify({
        id: message.id,
        result: {},
        padding: largePadding(),
      }))
    })
    const proxy = await startProxy(upstream.wsUrl, {
      candidateCaptureTimeoutMs: 1_000,
    })
    const repairTriggers: unknown[] = []
    proxy.onRepairTrigger((event) => repairTriggers.push(event))
    const tui = await connect(proxy.wsUrl)

    tui.send(JSON.stringify({ id: 121, method: 'thread/start', params: {} }))

    await expectSocketClosedWithin(tui, 100)
    expect(repairTriggers).toContainEqual({ kind: 'candidate_capture_timeout' })
  })

  it('emits thread_fork_response candidates and holds post-fork stateful traffic until persistence is acknowledged', async () => {
    const upstream = await startUpstream((socket, message) => {
      if (message.method === 'thread/fork') {
        socket.send(JSON.stringify({
          id: message.id,
          result: {
            thread: {
              id: 'thread-child',
              path: '/tmp/codex/fork-child-rollout.jsonl',
              ephemeral: false,
            },
          },
        }))
      }
    })
    const proxy = await startProxy(upstream.wsUrl, {
      requireCandidatePersistence: false,
    })
    const candidates: unknown[] = []
    proxy.onCandidate((candidate) => candidates.push(candidate))
    const tui = await connect(proxy.wsUrl)
    const forkResponse = nextMessageFrame(tui)

    tui.send(JSON.stringify({
      id: 41,
      method: 'thread/fork',
      params: { threadId: 'thread-parent', excludeTurns: false },
    }))

    await expect(forkResponse).resolves.toMatchObject({
      isBinary: false,
      message: {
        id: 41,
        result: {
          thread: {
            id: 'thread-child',
            path: '/tmp/codex/fork-child-rollout.jsonl',
            turns: [],
          },
        },
      },
    })
    expect(candidates).toEqual([
      {
        source: 'thread_fork_response',
        thread: {
          id: 'thread-child',
          path: '/tmp/codex/fork-child-rollout.jsonl',
          ephemeral: false,
        },
      },
    ])

    tui.send(JSON.stringify({
      id: 42,
      method: 'turn/start',
      params: {
        threadId: 'thread-child',
        input: [{ type: 'text', text: 'held until staged' }],
      },
    }))

    await delay(50)
    expect(upstream.messages).toHaveLength(1)
    proxy.markCandidatePersisted()
    await vi.waitFor(() => expect(upstream.messages).toHaveLength(2))
    expect(upstream.messages[1]).toMatchObject({
      id: 42,
      method: 'turn/start',
      params: { threadId: 'thread-child' },
    })
  })

  it('emits fork handoff proxy_error when invalid thread_fork_response is rejected before candidate emission', async () => {
    const upstream = await startUpstream((socket, message) => {
      if (message.method !== 'thread/fork') return
      socket.send(JSON.stringify({
        id: message.id,
        result: {
          thread: {
            id: 'thread-parent',
            path: '/tmp/codex/invalid-fork-same-parent.jsonl',
            ephemeral: false,
          },
        },
      }))
    })
    const proxy = await startProxy(upstream.wsUrl, {
      requireCandidatePersistence: false,
    })
    const repairTriggers: unknown[] = []
    const candidates: unknown[] = []
    proxy.onRepairTrigger((event) => repairTriggers.push(event))
    proxy.onCandidate((candidate) => candidates.push(candidate))
    const tui = await connect(proxy.wsUrl)

    tui.send(JSON.stringify({
      id: 43,
      method: 'thread/fork',
      params: { threadId: 'thread-parent', excludeTurns: false },
    }))

    await expectSocketClosedWithin(tui, 100)
    expect(candidates).toEqual([])
    expect(repairTriggers).toContainEqual(expect.objectContaining({
      kind: 'proxy_error',
      scope: 'fork_handoff',
    }))
  })
})
