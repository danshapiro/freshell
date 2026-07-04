import assert from 'node:assert/strict'

import WebSocket, { WebSocketServer } from 'ws'

import {
  CodexRemoteProxy,
  type CodexRemoteProxyCandidate,
  type CodexRemoteProxyRepairTrigger,
} from '../../../../../server/coding-cli/codex-app-server/remote-proxy.js'

type Mode = 'stateful-fork' | 'non-state' | 'above-cap'

type CliOptions = {
  capBytes: number
  mode: Mode
}

type UpstreamHandle = {
  server: WebSocketServer
  wsUrl: string
  sockets: Set<WebSocket>
}

type RawFrame = {
  raw: Buffer
  isBinary: boolean
}

const BYTE_X = 0x78
const BELOW_CAP_MARGIN_BYTES = 1_024
const ABOVE_CAP_MARGIN_BYTES = 1_024
const FRAME_TIMEOUT_MS = 15_000
const CLOSE_TIMEOUT_MS = 15_000
const FORK_REQUEST_ID = 9_001
const NON_STATE_REQUEST_ID = 9_002
const ABOVE_CAP_REQUEST_ID = 9_003

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  if (options.mode === 'stateful-fork') {
    await runStatefulForkMode(options.capBytes)
    return
  }
  if (options.mode === 'non-state') {
    await runNonStateRawForwardMode(options.capBytes)
    return
  }
  await runAboveCapMode(options.capBytes)
}

async function runStatefulForkMode(activeCap: number): Promise<void> {
  const targetBytes = activeCap - BELOW_CAP_MARGIN_BYTES
  const upstreamResponse = buildStatefulForkResponse(FORK_REQUEST_ID, targetBytes)
  const upstreamRequests: unknown[] = []
  const upstream = await startUpstream(async (socket, raw, isBinary) => {
    assert.equal(isBinary, false, 'stateful fork request should arrive upstream as a text frame')
    const request = JSON.parse(raw.toString()) as {
      id?: unknown
      method?: unknown
      params?: { excludeTurns?: unknown; threadId?: unknown }
    }
    upstreamRequests.push(request)
    if (request.method === 'thread/fork') {
      assert.equal(request.id, FORK_REQUEST_ID)
      assert.equal(request.params?.threadId, 'thread-parent')
      assert.equal(request.params?.excludeTurns, true)
      await sendTextFrame(socket, upstreamResponse)
      return
    }
    if (request.method === 'turn/start') {
      assert.equal(request.params?.threadId, 'thread-large-child')
      socket.send(JSON.stringify({ id: request.id, result: { ok: true } }), { binary: false })
      return
    }
    throw new Error(`Unexpected upstream request in stateful fork mode: ${String(request.method)}`)
  })
  let proxy: CodexRemoteProxy | undefined
  let tui: WebSocket | undefined
  try {
    proxy = await startProxy(upstream.wsUrl, activeCap)
    const candidates: CodexRemoteProxyCandidate[] = []
    proxy.onCandidate((candidate) => {
      candidates.push(candidate)
      proxy?.markCandidatePersisted()
    })

    tui = await connect(proxy.wsUrl)
    tui.send(JSON.stringify({
      id: FORK_REQUEST_ID,
      method: 'thread/fork',
      params: { threadId: 'thread-parent', excludeTurns: false },
    }), { binary: false })

    const forkFrame = await nextRawFrame(tui, FRAME_TIMEOUT_MS, 'stateful fork response')
    assert.equal(forkFrame.isBinary, false, 'stateful fork response should be forwarded as a text frame')
    assert.equal(forkFrame.raw.byteLength, upstreamResponse.byteLength)
    assert.equal(forkFrame.raw.equals(upstreamResponse), true, 'stateful fork response was truncated or corrupted')
    assert.notEqual(forkFrame.raw.indexOf(Buffer.from('"turns":[]')), -1, 'stateful fork response omitted turns: []')
    assert.equal(
      forkFrame.raw.indexOf(Buffer.from(`"id":${FORK_REQUEST_ID}`)) > forkFrame.raw.indexOf(Buffer.from('"turns":[]')),
      true,
      'top-level id should appear after result.thread.turns',
    )
    assert.deepEqual(candidates, [{
      source: 'thread_fork_response',
      thread: {
        id: 'thread-large-child',
        path: '/tmp/codex/large-forward-child.jsonl',
        ephemeral: false,
      },
    }])

    tui.send(JSON.stringify({
      id: FORK_REQUEST_ID + 1,
      method: 'turn/start',
      params: { threadId: 'thread-large-child', input: [{ type: 'text', text: 'gate released' }] },
    }), { binary: false })

    const turnResponse = await nextRawFrame(tui, FRAME_TIMEOUT_MS, 'post-fork turn/start response')
    assert.equal(turnResponse.isBinary, false)
    assert.deepEqual(JSON.parse(turnResponse.raw.toString()), { id: FORK_REQUEST_ID + 1, result: { ok: true } })
    assert.equal(upstreamRequests.length, 2, 'markCandidatePersisted() did not release the fork gate')

    logResult({
      mode: 'stateful-fork',
      activeCap,
      targetBytes,
      forwardedBytes: forkFrame.raw.byteLength,
      isBinary: forkFrame.isBinary,
    })
  } finally {
    await cleanup(proxy, tui, upstream)
  }
}

async function runNonStateRawForwardMode(activeCap: number): Promise<void> {
  const targetBytes = activeCap - BELOW_CAP_MARGIN_BYTES
  const upstreamResponse = buildNonStateResponse(NON_STATE_REQUEST_ID, targetBytes)
  const upstream = await startUpstream(async (socket, raw, isBinary) => {
    assert.equal(isBinary, false, 'non-state request should arrive upstream as a text frame')
    const request = JSON.parse(raw.toString()) as { id?: unknown; method?: unknown }
    assert.equal(request.id, NON_STATE_REQUEST_ID)
    assert.equal(request.method, 'model/list')
    await sendTextFrame(socket, upstreamResponse)
  })
  let proxy: CodexRemoteProxy | undefined
  let tui: WebSocket | undefined
  try {
    proxy = await startProxy(upstream.wsUrl, activeCap)
    tui = await connect(proxy.wsUrl)
    tui.send(JSON.stringify({ id: NON_STATE_REQUEST_ID, method: 'model/list', params: {} }), { binary: false })

    const frame = await nextRawFrame(tui, FRAME_TIMEOUT_MS, 'non-state response')
    assert.equal(frame.isBinary, false, 'non-state response should be forwarded as a text frame')
    assert.equal(frame.raw.byteLength, targetBytes)
    assert.equal(frame.raw.equals(upstreamResponse), true, 'non-state response was not raw-forwarded intact')
    assert.equal(
      frame.raw.indexOf(Buffer.from(`"id":${NON_STATE_REQUEST_ID}`)) > frame.raw.indexOf(Buffer.from('"result"')),
      true,
      'top-level id should appear after large result',
    )

    logResult({
      mode: 'non-state',
      activeCap,
      targetBytes,
      forwardedBytes: frame.raw.byteLength,
      isBinary: frame.isBinary,
    })
  } finally {
    await cleanup(proxy, tui, upstream)
  }
}

async function runAboveCapMode(activeCap: number): Promise<void> {
  const targetBytes = activeCap + ABOVE_CAP_MARGIN_BYTES
  const upstreamResponse = buildNonStateResponse(ABOVE_CAP_REQUEST_ID, targetBytes)
  const upstream = await startUpstream((socket, raw, isBinary) => {
    assert.equal(isBinary, false, 'above-cap request should arrive upstream as a text frame')
    const request = JSON.parse(raw.toString()) as { id?: unknown; method?: unknown }
    assert.equal(request.id, ABOVE_CAP_REQUEST_ID)
    assert.equal(request.method, 'model/list')
    socket.send(upstreamResponse, { binary: false })
  })
  let proxy: CodexRemoteProxy | undefined
  let tui: WebSocket | undefined
  try {
    proxy = await startProxy(upstream.wsUrl, activeCap)
    const proxyError = waitForProxyError(proxy)
    tui = await connect(proxy.wsUrl)
    const noTuiForward = expectNoFrameUntilClose(tui, CLOSE_TIMEOUT_MS, 'above-cap TUI forwarding')

    tui.send(JSON.stringify({ id: ABOVE_CAP_REQUEST_ID, method: 'model/list', params: {} }), { binary: false })

    await Promise.all([
      withTimeout(proxyError, CLOSE_TIMEOUT_MS, 'proxy_error repair trigger'),
      noTuiForward,
    ])

    logResult({
      mode: 'above-cap',
      activeCap,
      targetBytes,
      forwardedBytes: 0,
      isBinary: false,
    })
  } finally {
    await cleanup(proxy, tui, upstream)
  }
}

async function startProxy(upstreamWsUrl: string, activeCap: number): Promise<CodexRemoteProxy> {
  const proxy = new CodexRemoteProxy({
    upstreamWsUrl,
    maxRawForwardBytes: activeCap,
    requireCandidatePersistence: false,
    requestHoldTimeoutMs: 5_000,
    candidateCaptureTimeoutMs: 5_000,
  })
  await proxy.start()
  return proxy
}

async function startUpstream(
  handler: (socket: WebSocket, raw: Buffer, isBinary: boolean) => void | Promise<void>,
): Promise<UpstreamHandle> {
  const sockets = new Set<WebSocket>()
  const server = await new Promise<WebSocketServer>((resolve, reject) => {
    const wss = new WebSocketServer({
      host: '127.0.0.1',
      maxPayload: 128 * 1024 * 1024,
      port: 0,
    })
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
        Promise.resolve(handler(socket, rawDataToBuffer(raw), isBinary)).catch((error) => {
          socket.close()
          wss.emit('error', error)
        })
      })
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    throw new Error('Upstream WebSocket server did not expose a localhost port.')
  }
  return {
    server,
    sockets,
    wsUrl: `ws://127.0.0.1:${address.port}`,
  }
}

function buildStatefulForkResponse(id: number, targetBytes: number): Buffer {
  return buildSizedJsonBuffer({
    prefix: `{"jsonrpc":"2.0","result":{"thread":{"id":"thread-large-child","path":"/tmp/codex/large-forward-child.jsonl","ephemeral":false,"turns":[],"decoy":{"blob":"`,
    suffix: `"}}},"id":${id}}`,
    targetBytes,
  })
}

function buildNonStateResponse(id: number, targetBytes: number): Buffer {
  return buildSizedJsonBuffer({
    prefix: '{"jsonrpc":"2.0","result":{"models":[{"id":"model-large-forward","name":"large forward"}],"decoy":{"blob":"',
    suffix: `"}},"id":${id}}`,
    targetBytes,
  })
}

function buildSizedJsonBuffer(options: {
  prefix: string
  suffix: string
  targetBytes: number
}): Buffer {
  const prefix = Buffer.from(options.prefix)
  const suffix = Buffer.from(options.suffix)
  const paddingBytes = options.targetBytes - prefix.byteLength - suffix.byteLength
  if (paddingBytes < 0) {
    throw new Error(`Target JSON buffer is too small: ${options.targetBytes}`)
  }
  const padding = Buffer.alloc(paddingBytes, BYTE_X)
  return Buffer.concat([prefix, padding, suffix], options.targetBytes)
}

async function connect(wsUrl: string): Promise<WebSocket> {
  const socket = new WebSocket(wsUrl, {
    maxPayload: 128 * 1024 * 1024,
    perMessageDeflate: false,
  })
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve())
    socket.once('error', reject)
  })
  return socket
}

function nextRawFrame(socket: WebSocket, timeoutMs: number, label: string): Promise<RawFrame> {
  return withTimeout(new Promise<RawFrame>((resolve, reject) => {
    const onMessage = (raw: WebSocket.RawData, isBinary: boolean) => {
      cleanupListeners()
      resolve({ raw: rawDataToBuffer(raw), isBinary })
    }
    const onClose = () => {
      cleanupListeners()
      reject(new Error(`Socket closed before ${label}.`))
    }
    const onError = (error: Error) => {
      cleanupListeners()
      reject(error)
    }
    const cleanupListeners = () => {
      socket.off('message', onMessage)
      socket.off('close', onClose)
      socket.off('error', onError)
    }
    socket.once('message', onMessage)
    socket.once('close', onClose)
    socket.once('error', onError)
  }), timeoutMs, label)
}

function waitForProxyError(proxy: CodexRemoteProxy): Promise<CodexRemoteProxyRepairTrigger> {
  return new Promise((resolve) => {
    proxy.onRepairTrigger((event) => {
      if (event.kind === 'proxy_error') resolve(event)
    })
  })
}

function expectNoFrameUntilClose(socket: WebSocket, timeoutMs: number, label: string): Promise<void> {
  return withTimeout(new Promise<void>((resolve, reject) => {
    const onMessage = () => {
      cleanupListeners()
      reject(new Error(`${label} unexpectedly forwarded a TUI frame.`))
    }
    const onClose = () => {
      cleanupListeners()
      resolve()
    }
    const onError = (error: Error) => {
      cleanupListeners()
      reject(error)
    }
    const cleanupListeners = () => {
      socket.off('message', onMessage)
      socket.off('close', onClose)
      socket.off('error', onError)
    }
    socket.once('message', onMessage)
    socket.once('close', onClose)
    socket.once('error', onError)
  }), timeoutMs, label)
}

function sendTextFrame(socket: WebSocket, frame: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.send(frame, { binary: false }, (error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

function rawDataToBuffer(raw: WebSocket.RawData): Buffer {
  if (Buffer.isBuffer(raw)) return raw
  if (Array.isArray(raw)) return Buffer.concat(raw.map((part) => Buffer.from(part)))
  return Buffer.from(raw)
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Timed out after ${timeoutMs}ms waiting for ${label}.`))
    }, timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

async function cleanup(
  proxy: CodexRemoteProxy | undefined,
  tui: WebSocket | undefined,
  upstream: UpstreamHandle,
): Promise<void> {
  tui?.close()
  await proxy?.close()
  for (const socket of upstream.sockets) socket.close()
  await new Promise<void>((resolve) => upstream.server.close(() => resolve()))
}

function parseArgs(args: string[]): CliOptions {
  let capBytes: number | undefined
  let mode: Mode | undefined
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--cap-bytes') {
      capBytes = Number(args[index + 1])
      index += 1
      continue
    }
    if (arg === '--mode') {
      mode = parseMode(args[index + 1])
      index += 1
    }
  }
  if (!Number.isInteger(capBytes) || capBytes <= BELOW_CAP_MARGIN_BYTES) {
    throw new Error(`Invalid --cap-bytes value: ${String(capBytes)}`)
  }
  if (!mode) {
    throw new Error('Missing required --mode argument.')
  }
  return { capBytes, mode }
}

function parseMode(value: string | undefined): Mode | undefined {
  if (value === 'stateful-fork' || value === 'non-state' || value === 'above-cap') return value
  return undefined
}

function logResult(result: {
  mode: Mode
  activeCap: number
  targetBytes: number
  forwardedBytes: number
  isBinary: boolean
}): void {
  const memory = process.memoryUsage()
  console.log(JSON.stringify({
    ...result,
    rss: memory.rss,
    heapUsed: memory.heapUsed,
  }))
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error))
  process.exitCode = 1
})
