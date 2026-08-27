import { describe, expect, it } from 'vitest'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import { createServer } from 'node:net'
import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { WS_PROTOCOL_VERSION } from '../../../shared/ws-protocol.js'

const PROJECT_ROOT = path.resolve(import.meta.dirname, '../../..')
const AUTHENTICATION_TOKEN = `electron-runtime-${randomUUID()}`

interface JsonRpcMessage {
  jsonrpc?: string
  id?: number
  result?: {
    serverInfo?: { name?: string; version?: string }
  }
}

interface WebSocketMessage {
  type?: string
  requestId?: string
  terminalId?: string
  data?: string
}

function runtimeRoot(): string {
  const configured = process.env.FRESHELL_ELECTRON_RUNTIME_DIR
  return path.resolve(PROJECT_ROOT, configured ?? 'electron-runtime')
}

async function findFreePort(): Promise<number> {
  while (true) {
    const server = createServer()
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    const address = server.address()
    if (!address || typeof address === 'string') {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      throw new Error('Could not determine an ephemeral port')
    }
    const port = address.port
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    if (port !== 3001) return port
  }
}

function waitForExit(child: ChildProcess, timeoutMs = 10_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`child PID ${child.pid ?? 'unknown'} did not exit`)), timeoutMs)
    const finish = () => {
      clearTimeout(timer)
      resolve()
    }
    child.once('close', finish)
    child.once('error', finish)
  })
}

async function stopOwnedChild(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  try {
    await waitForExit(child, 5_000)
  } catch {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await waitForExit(child, 5_000)
  }
}

async function waitForJsonLine(
  child: ChildProcess,
  predicate: (message: JsonRpcMessage | Record<string, unknown>) => boolean,
  timeoutMs = 10_000,
): Promise<JsonRpcMessage | Record<string, unknown>> {
  if (!child.stdout) throw new Error('child stdout is not piped')
  const readline = createInterface({ input: child.stdout })
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      settled = true
      readline.close()
      reject(new Error('timed out waiting for JSON line from child'))
    }, timeoutMs)
    readline.on('line', (line: string) => {
      try {
        const message = JSON.parse(line) as JsonRpcMessage | Record<string, unknown>
        if (!predicate(message)) return
        settled = true
        clearTimeout(timer)
        readline.close()
        resolve(message)
      } catch {
        // A malformed stdout line is intentionally ignored here; the timeout
        // below reports the JSON protocol failure without echoing its contents.
      }
    })
    child.once('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      readline.close()
      reject(error)
    })
    child.once('close', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      readline.close()
      reject(new Error(`child exited before emitting the expected JSON line (code ${child.exitCode ?? 'unknown'}, signal ${child.signalCode ?? 'unknown'})`))
    })
  })
}

function waitForWebSocketMessage(
  ws: WebSocket,
  predicate: (message: WebSocketMessage) => boolean,
  timeoutMs = 10_000,
): Promise<WebSocketMessage> {
  return new Promise((resolve, reject) => {
    let settled = false
    const cleanup = () => {
      clearTimeout(timer)
      ws.off('message', onMessage)
      ws.off('error', onError)
      ws.off('close', onClose)
    }
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      cleanup()
      callback()
    }
    const timer = setTimeout(() => {
      finish(() => reject(new Error('Timed out waiting for WebSocket message')))
    }, timeoutMs)
    const onMessage = (data: WebSocket.RawData) => {
      let message: WebSocketMessage
      try {
        message = JSON.parse(data.toString()) as WebSocketMessage
      } catch {
        return
      }
      if (predicate(message)) finish(() => resolve(message))
    }
    const onError = (error: Error) => {
      finish(() => reject(error))
    }
    const onClose = (code: number, reason: Buffer) => {
      finish(() => reject(new Error(`Socket closed before the expected message arrived (${code}: ${reason.toString()})`)))
    }
    ws.on('message', onMessage)
    ws.on('error', onError)
    ws.on('close', onClose)
  })
}

async function connectAuthenticatedWebSocket(baseUrl: string): Promise<WebSocket> {
  const ws = new WebSocket(`${baseUrl.replace(/^http/, 'ws')}/ws`)
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  const readyPromise = waitForWebSocketMessage(ws, (message) => message.type === 'ready')
  ws.send(JSON.stringify({
    type: 'hello',
    token: AUTHENTICATION_TOKEN,
    protocolVersion: WS_PROTOCOL_VERSION,
  }))
  await readyPromise
  return ws
}

async function closeWebSocket(ws: WebSocket): Promise<void> {
  await new Promise<void>((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) {
      resolve()
      return
    }

    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      ws.off('close', finish)
      ws.off('error', finish)
      resolve()
    }
    const timer = setTimeout(() => {
      ws.terminate()
      finish()
    }, 2_000)
    ws.once('close', finish)
    ws.once('error', finish)
    ws.close()
  })
}

async function requestJson(url: string, init?: RequestInit): Promise<Response> {
  const deadline = Date.now() + 30_000
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      return await fetch(url, init)
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  throw new Error(`Timed out requesting ${url}: ${String(lastError)}`)
}

async function writeFakeClaudeSdk(root: string): Promise<string> {
  const modulePath = path.join(root, 'fake-claude-sdk.mjs')
  await writeFile(modulePath, `
export function query() {
  let emitted = false
  return {
    async next() {
      if (emitted) return { done: true, value: undefined }
      emitted = true
      return {
        done: false,
        value: { type: 'system', subtype: 'init', session_id: 'checkout-free-fake-claude', model: 'fake', cwd: process.cwd(), tools: [] },
      }
    },
    [Symbol.asyncIterator]() { return this },
  }
}
`)
  return modulePath
}

describe('checkout-free Electron runtime acceptance', () => {
  it('serves Rust/client, runs fake Claude, and speaks MCP JSON-RPC outside the checkout', async () => {
    const staged = runtimeRoot()
    expect(existsSync(staged), 'run npm run prepare:electron-runtime before this lane').toBe(true)
    const outsideRoot = await mkdtemp(path.join(tmpdir(), 'freshell-electron-runtime-'))
    const runtime = path.join(outsideRoot, 'runtime')
    const emptyCwd = path.join(outsideRoot, 'cwd')
    const fakeRoot = path.join(outsideRoot, 'fixtures')
    await cp(staged, runtime, { recursive: true })
    await writeFile(path.join(outsideRoot, 'root-marker'), 'outside checkout')
    await mkdir(emptyCwd, { recursive: true })
    await mkdir(fakeRoot, { recursive: true })
    const fakeSdk = await writeFakeClaudeSdk(fakeRoot)
    expect(existsSync(path.join(outsideRoot, 'node_modules'))).toBe(false)
    expect(path.resolve(outsideRoot)).not.toBe(path.resolve(PROJECT_ROOT))

    const serverPort = await findFreePort()
    const home = path.join(outsideRoot, 'home')
    await mkdir(home, { recursive: true })
    const serverBinary = path.join(runtime, 'bin', process.platform === 'win32' ? 'freshell-server.exe' : 'freshell-server')
    const nodeBinary = path.join(runtime, 'node', 'bin', process.platform === 'win32' ? 'node.exe' : 'node')
    const sidecarEntry = path.join(runtime, 'claude-sidecar', 'index.mjs')
    const mcpEntry = path.join(runtime, 'mcp', 'server.js')
    const server = spawn(serverBinary, [], {
      cwd: emptyCwd,
      env: {
        ...process.env,
        AUTH_TOKEN: AUTHENTICATION_TOKEN,
        PORT: String(serverPort),
        FRESHELL_HOME: home,
        FRESHELL_CLIENT_DIR: path.join(runtime, 'client'),
        FRESHELL_CLAUDE_NODE: nodeBinary,
        FRESHELL_CLAUDE_SIDECAR: sidecarEntry,
        FRESHELL_MCP_NODE: nodeBinary,
        FRESHELL_MCP_ENTRY: mcpEntry,
        NODE_PATH: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let ws: WebSocket | undefined
    let terminalId: string | undefined
    let mcp: ChildProcess | undefined
    let claude: ChildProcess | undefined
    try {
      const baseUrl = `http://127.0.0.1:${serverPort}`
      const infoResponse = await requestJson(`${baseUrl}/api/server-info`, { headers: { 'x-auth-token': AUTHENTICATION_TOKEN } })
      expect(infoResponse.status).toBe(200)
      const info = await infoResponse.json() as Record<string, unknown>
      expect(info.runtime).toBe('rust')
      expect(info.commit).toEqual(expect.any(String))

      const spa = await requestJson(`${baseUrl}/`)
      expect(spa.status).toBe(200)
      const html = await spa.text()
      expect(html).toContain('<script')
      const assetPath = html.match(/(?:src|href)="(\/assets\/[^"]+\.(?:js|css))"/)?.[1]
      expect(assetPath, 'SPA must reference a hashed asset').toMatch(/^\/assets\/.+\.(?:js|css)$/)
      const asset = await requestJson(`${baseUrl}${assetPath}`)
      expect(asset.status).toBe(200)
      expect((await asset.text()).length).toBeGreaterThan(0)

      ws = await connectAuthenticatedWebSocket(baseUrl)
      if (!ws) throw new Error('WebSocket connection was not established')
      const createRequestId = `checkout-free-terminal-${randomUUID()}`
      const createdPromise = waitForWebSocketMessage(ws, (message) => (
        message.type === 'terminal.created' && message.requestId === createRequestId
      ))
      ws.send(JSON.stringify({
        type: 'terminal.create',
        requestId: createRequestId,
        mode: 'shell',
        shell: 'system',
        cwd: emptyCwd,
      }))
      const terminalCreated = await createdPromise
      terminalId = terminalCreated.terminalId
      expect(terminalId).toEqual(expect.any(String))

      const attachRequestId = `checkout-free-attach-${randomUUID()}`
      const attachedPromise = waitForWebSocketMessage(ws, (message) => (
        message.type === 'terminal.attach.ready' && message.terminalId === terminalId
      ))
      ws.send(JSON.stringify({
        type: 'terminal.attach',
        terminalId,
        attachRequestId,
        intent: 'viewport_hydrate',
        priority: 'foreground',
        cols: 80,
        rows: 24,
      }))
      await attachedPromise

      const ptyMarker = 'FRESHELL_ELECTRON_PTY_ROUNDTRIP_MARKER'
      const shellCommand = process.platform === 'win32'
        ? `echo ${ptyMarker}`
        : `printf '%s\\n' ${ptyMarker}`
      const outputPromise = waitForWebSocketMessage(ws, (message) => (
        message.type === 'terminal.output'
        && message.terminalId === terminalId
        && typeof message.data === 'string'
        && message.data.includes(ptyMarker)
      ))
      ws.send(JSON.stringify({
        type: 'terminal.input',
        terminalId,
        data: `${shellCommand}\n`,
      }))
      const output = await outputPromise
      expect(output.data).toContain(ptyMarker)

      const detachedPromise = waitForWebSocketMessage(ws, (message) => (
        message.type === 'terminal.detached' && message.terminalId === terminalId
      ))
      ws.send(JSON.stringify({ type: 'terminal.detach', terminalId }))
      await detachedPromise
      await closeWebSocket(ws)
      ws = undefined

      claude = spawn(nodeBinary, [sidecarEntry], {
        cwd: emptyCwd,
        env: {
          ...process.env,
          NODE_PATH: '',
          FRESHELL_CLAUDE_SDK_QUERY_MODULE: fakeSdk,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      claude.stdin?.write(`${JSON.stringify({ type: 'create', requestId: 'checkout-free-create' })}\n`)
      const created = await waitForJsonLine(claude, (message) => message.type === 'created')
      expect(created).toMatchObject({ type: 'created', requestId: 'checkout-free-create' })
      const sessionId = (created as { sessionId?: string }).sessionId
      expect(sessionId).toEqual(expect.any(String))
      const idle = await waitForJsonLine(claude, (message) => message.type === 'sdk.status')
      expect(idle).toMatchObject({ type: 'sdk.status', sessionId, status: 'idle' })
      claude.stdin?.write('{"type":"shutdown"}\n')
      await waitForExit(claude)

      const mcpPackage = JSON.parse(await readFile(path.join(runtime, 'mcp', 'package.json'), 'utf8')) as { version: string }
      mcp = spawn(nodeBinary, [mcpEntry], {
        cwd: emptyCwd,
        env: {
          ...process.env,
          FRESHELL_URL: baseUrl,
          FRESHELL_TOKEN: AUTHENTICATION_TOKEN,
          NODE_PATH: '',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      mcp.stdin?.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'checkout-free-test', version: '1' },
        },
      })}\n`)
      const initialize = await waitForJsonLine(mcp, (message) => message.id === 1) as JsonRpcMessage
      expect(initialize.jsonrpc).toBe('2.0')
      expect(initialize.result?.serverInfo).toMatchObject({ name: 'freshell', version: mcpPackage.version })
      let listeners = ''
      try {
        listeners = execFileSync('ss', ['-ltnp'], { encoding: 'utf8' }) as string
      } catch {
        // Some minimal CI images do not ship ss; JSON-RPC still proves the
        // stdio transport, while the native lane covers process startup.
      }
      expect(listeners).not.toContain(`pid=${mcp.pid}`)
    } finally {
      if (ws) {
        if (terminalId && ws.readyState === WebSocket.OPEN) {
          try {
            const detachedPromise = waitForWebSocketMessage(ws, (message) => (
              message.type === 'terminal.detached' && message.terminalId === terminalId
            ))
            ws.send(JSON.stringify({ type: 'terminal.detach', terminalId }))
            await detachedPromise
          } catch {
            // The server shutdown below still reaps the owned PTY if the
            // connection failed before the detach acknowledgement arrived.
          }
        }
        await closeWebSocket(ws)
      }
      await stopOwnedChild(claude)
      await stopOwnedChild(mcp)
      await stopOwnedChild(server)
      await rm(outsideRoot, { recursive: true, force: true })
    }
  })
})
