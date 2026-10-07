import {
  QUALIFICATION_PROVIDER_SELECTION_ENV, parseQualificationProviderSelection,
  type QualifiableTerminalProvider,
} from './provider-qualification-selection.js'
import {
  FRESH_AGENT_QUALIFICATION_MODES_ENV, parseFreshAgentQualificationModes,
  type QualifiableFreshAgentMode,
} from './fresh-agent-qualification-selection.js'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import net from 'node:net'
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { RuntimeWebConstructOptions, RuntimeWebFactory, RuntimeWebHandle, RuntimeWebInfo } from './runtime-sandbox.js'
import { RuntimeOwnerOperationQueue, ManagedRuntimeOwner, RuntimeHarness, dockerSocketPath, runtimeWebStripPrefixes } from './runtime-sandbox.js'
import type { Reporter, TestCase, TestResult, FullResult } from '@playwright/test/reporter'
import { z } from 'zod'
import { ManagedRuntimeInventorySnapshotSchema, type ManagedRuntimeInventorySnapshot } from '../../shared/managed-runtime.js'
import type { RuntimeWriterClaimFacts } from './runtime-sandbox.js'
import { pathToFileURL } from 'node:url'
import WebSocket from 'ws'
import { WS_PROTOCOL_VERSION } from '../../shared/ws-protocol.js'
import type { ExactRuntimeHandle, ManagedRuntimeView, FixtureNativeState, RuntimeHostFacts, RuntimeOwnerOperationRequest } from './runtime-sandbox.js'
import type { NativeChallengeKind, NativeToolEvidence, SyntheticOpenCodeChallenge } from './runtime-sandbox.js'
import { RetainedFixtureBrowserSession, runTask2RetainedFixture, Task2RetainedBrowserStageSchema,
  type Task2RetainedBrowserStage } from './task002-retained-fixture.js'

type OwnedProcessIdentity = { pid: number; startTicks: string; executable: string; cwd: string }

function processIdentity(pid: number): OwnedProcessIdentity | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    if (!/^[0-9]+$/.test(fields[19])) throw new Error('owned process start identity is unreadable')
    return {
      pid, startTicks: fields[19], executable: fs.readlinkSync(`/proc/${pid}/exe`),
      cwd: fs.readlinkSync(`/proc/${pid}/cwd`),
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ESRCH') return null
    throw error
  }
}

function sameProcess(expected: OwnedProcessIdentity, current: OwnedProcessIdentity): boolean {
  return expected.pid === current.pid && expected.startTicks === current.startTicks
    && expected.executable === current.executable && expected.cwd === current.cwd
}

function ownedPidPresent(expected: OwnedProcessIdentity): boolean {
  try {
    const stat = fs.readFileSync(`/proc/${expected.pid}/stat`, 'utf8')
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] === expected.startTicks
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}

function processDescendants(parent: OwnedProcessIdentity): OwnedProcessIdentity[] {
  const rows: Array<{ pid: number; parent: number }> = []
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^[0-9]+$/.test(entry)) continue
    try {
      const text = fs.readFileSync(`/proc/${entry}/stat`, 'utf8')
      rows.push({ pid: Number(entry), parent: Number(text.slice(text.lastIndexOf(')') + 2).split(' ')[1]) })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
  }
  const owned = new Set([parent.pid])
  let grew = true
  while (grew) {
    grew = false
    for (const row of rows) if (owned.has(row.parent) && !owned.has(row.pid)) { owned.add(row.pid); grew = true }
  }
  return [...owned].filter((pid) => pid !== parent.pid).flatMap((pid) => {
    const identity = processIdentity(pid)
    return identity ? [identity] : []
  })
}

const delay = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds))

/** Private owner-side process primitive. No executable, argv or PID enters the remote API. */
class OwnedRuntimeChild {
  readonly child: ChildProcess
  private recordedIdentity?: OwnedProcessIdentity
  private stdout = ''
  private stderr = ''
  private exited = false
  private readonly exit: Promise<void>

  private constructor(executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
    const canonical = fs.realpathSync(executable)
    this.child = spawn(canonical, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    this.exit = new Promise((resolve) => {
      const finish = () => { this.exited = true; resolve() }
      this.child.once('exit', finish)
      this.child.once('error', finish)
    })
    this.child.stdout?.on('data', (chunk: Buffer) => { this.stdout = (this.stdout + chunk.toString()).slice(-1024 * 1024) })
    this.child.stderr?.on('data', (chunk: Buffer) => { this.stderr = (this.stderr + chunk.toString()).slice(-1024 * 1024) })
  }

  static async create(executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<OwnedRuntimeChild> {
    const process = new OwnedRuntimeChild(executable, args, cwd, env)
    const deadline = Date.now() + 2000
    while (process.alive() && Date.now() < deadline) {
      const identity = process.child.pid ? processIdentity(process.child.pid) : null
      if (identity && identity.cwd === fs.realpathSync(cwd) && identity.executable === fs.realpathSync(executable)) {
        process.recordedIdentity = identity
        return process
      }
      await delay(10)
    }
    // Before a verified executable handshake, only this exact spawn handle is
    // signal authority. Wait for it to settle before reporting startup failure.
    if (process.alive()) process.child.kill('SIGTERM')
    await Promise.race([process.exit, delay(2000)])
    if (process.alive()) process.child.kill('SIGKILL')
    await Promise.race([process.exit, delay(2000)])
    if (process.alive()) throw new Error('owned process spawn failed and cleanup did not settle')
    throw new Error('owned process did not establish its exact executable/cwd/start identity')
  }

  get identity(): OwnedProcessIdentity {
    if (!this.recordedIdentity) throw new Error('owned process identity handshake is incomplete')
    return this.recordedIdentity
  }

  output(): { stdout: string; stderr: string } { return { stdout: this.stdout, stderr: this.stderr } }
  alive(): boolean { return !this.exited }
  async wait(): Promise<number> {
    await this.exit
    if (typeof this.child.exitCode !== 'number') throw new Error('owned child did not exit with a numeric status')
    return this.child.exitCode
  }
  descendants(): OwnedProcessIdentity[] {
    const current = processIdentity(this.identity.pid)
    if (!current) return []
    if (!sameProcess(this.identity, current)) throw new Error('owned process identity was replaced')
    return processDescendants(this.identity)
  }

  private signal(identity: OwnedProcessIdentity, signal: NodeJS.Signals): void {
    const current = processIdentity(identity.pid)
    if (!current) return
    if (!sameProcess(identity, current)) throw new Error('refused to signal a replaced owned PID')
    process.kill(identity.pid, signal)
  }

  async stop(signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
    const children = this.descendants()
    this.signal(this.identity, signal)
    await Promise.race([this.exit, delay(5000)])
    if (ownedPidPresent(this.identity)) {
      this.signal(this.identity, 'SIGKILL')
      await Promise.race([this.exit, delay(5000)])
    }
    for (const child of children) this.signal(child, 'SIGTERM')
    const deadline = Date.now() + 5000
    while (Date.now() < deadline && children.some((child) => ownedPidPresent(child))) await delay(50)
    for (const child of children) this.signal(child, 'SIGKILL')
    const killDeadline = Date.now() + 5000
    while (Date.now() < killDeadline && [this.identity, ...children].some(ownedPidPresent)) await delay(50)
    const remaining = [this.identity, ...children].filter(ownedPidPresent)
    if (remaining.length) throw new Error('owned process cleanup could not verify absence')
  }
}

async function freeOwnerPort(): Promise<number> {
  const listener = net.createServer()
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject)
    listener.listen(0, '127.0.0.1', resolve)
  })
  const address = listener.address()
  if (!address || typeof address === 'string') throw new Error('owned port reservation failed')
  await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()))
  return address.port
}

export function validateManagedWebProvenance(observed: unknown, candidateSha: string, buildDirty: boolean): void {
  if (!observed || typeof observed !== 'object' || Array.isArray(observed)) throw new Error('owned managed web provenance is missing')
  const body = observed as Record<string, unknown>
  if (body.runtime !== 'rust' || body.commit !== candidateSha || body.buildDirty !== buildDirty) {
    throw new Error('owned managed web provenance differs from the exact artifact candidate and cleanliness')
  }
}

/** The runtime owner supplies the artifact; this class never builds or locates a foreign server. */
export class ManagedRuntimeWebServer implements RuntimeWebHandle {
  private process?: OwnedRuntimeChild
  private current?: RuntimeWebInfo
  private homeDir?: string
  private bootCount = 0
  private homeConfigured = false

  constructor(private readonly options: RuntimeWebConstructOptions) {}

  get info(): RuntimeWebInfo {
    if (!this.current) throw new Error('owned managed web is not started')
    return this.current
  }
  capturedOutput(): { stdout: string; stderr: string } { return this.process?.output() ?? { stdout: '', stderr: '' } }
  processEvidence(): { pid: number; bootAttemptCount: number } {
    return { pid: this.info.pid, bootAttemptCount: this.bootCount }
  }
  ownedChildPids(): number[] { return this.process?.descendants().map((child) => child.pid) ?? [] }

  async start(): Promise<RuntimeWebInfo> {
    if (this.process?.alive()) throw new Error('owned managed web is already started')
    this.homeDir ??= this.options.homeDir ?? await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-managed-web-'))
    return this.boot(await freeOwnerPort(), this.options.token ?? randomUUID())
  }

  private async boot(port: number, token: string): Promise<RuntimeWebInfo> {
    const home = this.homeDir!
    const configDir = path.join(home, '.freshell')
    if (!this.homeConfigured) {
      await this.options.setupHome(home)
      await fsp.mkdir(configDir, { recursive: true })
      const configFile = path.join(configDir, 'config.json')
      const config = JSON.parse(await fsp.readFile(configFile, 'utf8'))
      config.settings ??= {}
      config.settings.network = { configured: true, host: '127.0.0.1', ...config.settings.network }
      await fsp.writeFile(configFile, JSON.stringify(config), { mode: 0o600 })
      this.homeConfigured = true
    }
    const logsDir = path.join(configDir, 'logs')
    await fsp.mkdir(logsDir, { recursive: true })
    const env: NodeJS.ProcessEnv = {
      ...process.env, ...this.options.env, PORT: String(port), NODE_ENV: 'production', AUTH_TOKEN: token,
      HIDE_STARTUP_TOKEN: 'true', FRESHELL_LOG_DIR: logsDir,
      FRESHELL_CLIENT_DIR: path.join(this.options.repoRoot, 'dist/client'),
      FRESHELL_HOME: home, HOME: home, CLAUDE_HOME: path.join(home, '.claude'), CODEX_HOME: path.join(home, '.codex'),
      XDG_DATA_HOME: path.join(home, '.local/share'), XDG_CONFIG_HOME: path.join(home, '.config'),
      LOCALAPPDATA: path.join(home, 'AppData/Local'), APPDATA: path.join(home, 'AppData/Roaming'),
    }
    const stripPrefixes = runtimeWebStripPrefixes(this.options)
    for (const key of Object.keys(env)) if (stripPrefixes.some(prefix => key.startsWith(prefix))) delete env[key]
    delete env.VITE_PORT
    this.process = await OwnedRuntimeChild.create(this.options.binary, [], this.options.repoRoot, env)
    this.bootCount += 1
    const baseUrl = `http://127.0.0.1:${port}`
    const deadline = Date.now() + 60_000
    try {
      let ready = false
      while (Date.now() < deadline) {
        if (!this.process.alive()) throw new Error('owned managed web exited before readiness')
        let response: Response
        try {
          response = await fetch(`${baseUrl}/api/server-info`, {
            headers: { 'x-auth-token': token }, signal: AbortSignal.timeout(2000),
          })
        } catch { await delay(100); continue }
        if (response.ok) {
          validateManagedWebProvenance(await response.json(), this.options.candidateSha, this.options.buildDirty)
          ready = true
          break
        }
        await delay(100)
      }
      if (!ready) throw new Error('owned managed web authenticated readiness timed out')
      this.current = {
        port, token, baseUrl, wsUrl: `ws://127.0.0.1:${port}/ws`, homeDir: home, configDir: home,
        logsDir, debugLogPath: path.join(logsDir, `freshell-server.rust.${port}.log`),
        pid: this.process.identity.pid, runtimeRoot: this.options.repoRoot,
      }
      return this.current
    } catch (error) {
      await this.process.stop()
      throw error
    }
  }

  async restart(): Promise<RuntimeWebInfo> {
    const { port, token } = this.info
    await this.kill('SIGTERM')
    return this.boot(port, token)
  }
  async restartAbrupt(): Promise<RuntimeWebInfo> {
    const { port, token } = this.info
    await this.kill('SIGKILL')
    return this.boot(port, token)
  }
  async kill(signal: NodeJS.Signals = 'SIGKILL'): Promise<void> {
    if (this.process) await this.process.stop(signal)
    this.process = undefined
  }
  async stop(): Promise<void> {
    await this.kill('SIGTERM')
    this.current = undefined
    if (this.homeDir && !this.options.homeDir && !this.options.preserveHomeOnStop) {
      await fsp.rm(this.homeDir, { recursive: true, force: true })
      this.homeDir = undefined
      this.homeConfigured = false
    }
  }
}

const PINNED_CLOUDFLARED_SHA256 = 'd33ff2d14475178d2012c2c56beba87389ac5ded27649519f198a7d3134a99db'
const PINNED_CLOUDFLARED_PATH = '/home/dan/code/freshell/.worktrees/.the-usual-logs/managed-provider-environment/reports/transport-preflight/cloudflared'

export function parseOwnedTunnelOrigin(output: string): string | null {
  const origins = new Set(output.match(/https:\/\/[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com\b/g) ?? [])
  if (origins.size > 1) throw new Error('owned tunnel published different generated origins')
  return [...origins][0] ?? null
}

export class OwnedManagedRuntimeTunnel {
  private process?: OwnedRuntimeChild
  private home?: string
  private origin?: string

  constructor(private readonly repoRoot: string, private readonly binary = process.env.FRESHELL_RUNTIME_CLOUDFLARED_BINARY ?? PINNED_CLOUDFLARED_PATH) {}

  get baseUrl(): string {
    if (!this.origin) throw new Error('owned tunnel has not published its origin')
    return this.origin
  }
  get wsUrl(): string { return `${this.baseUrl.replace(/^https:/, 'wss:')}/ws` }
  processEvidence(): OwnedProcessIdentity {
    if (!this.process) throw new Error('owned tunnel process is unavailable')
    return { ...this.process.identity }
  }
  assertAlive(): void {
    if (!this.process?.alive()) throw new Error('owned tunnel exited during the browser job')
    const current = processIdentity(this.process.identity.pid)
    if (!current || !sameProcess(this.process.identity, current)) throw new Error('owned tunnel process identity changed')
  }
  async start(relayUrl: string): Promise<void> {
    if (this.process || this.home) throw new Error('owned tunnel already started')
    const relay = new URL(relayUrl)
    if (relay.protocol !== 'http:' || relay.hostname !== '127.0.0.1' || !relay.port || relay.pathname !== '/' || relay.search || relay.hash) {
      throw new Error('owned tunnel requires the exact loopback relay address')
    }
    const binary = fs.realpathSync(this.binary)
    const digest = createHash('sha256').update(await fsp.readFile(binary)).digest('hex')
    if (digest !== PINNED_CLOUDFLARED_SHA256) throw new Error('owned tunnel executable differs from the pinned artifact')
    const version = execFileSync(binary, ['--version'], { encoding: 'utf8', timeout: 5000 }).trim()
    if (!/^cloudflared version 2026\.10\.0(?:\s|$)/.test(version)) throw new Error('owned tunnel executable version differs from its pin')
    this.home = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-owned-tunnel-'))
    await fsp.chmod(this.home, 0o700)
    try {
      this.process = await OwnedRuntimeChild.create(binary, [
        'tunnel', '--no-autoupdate', '--url', relayUrl, '--protocol', 'http2',
      ], this.repoRoot, { PATH: process.env.PATH, HOME: this.home, XDG_CONFIG_HOME: this.home })
      const deadline = Date.now() + 90_000
      while (Date.now() < deadline) {
        this.assertAlive()
        const { stdout, stderr } = this.process.output()
        const origin = parseOwnedTunnelOrigin(`${stdout}\n${stderr}`)
        if (origin) { this.origin = origin; return }
        await delay(100)
      }
      throw new Error('owned tunnel origin readiness timed out')
    } catch (error) {
      try { await this.stop() } catch (cleanup) { throw new AggregateError([error, cleanup], 'owned tunnel startup and cleanup failed') }
      throw error
    }
  }
  async stop(): Promise<void> {
    if (this.process) await this.process.stop()
    this.process = undefined
    if (this.home) await fsp.rm(this.home, { recursive: true })
    this.home = undefined
    this.origin = undefined
  }
}

export class OwnedManagedRuntimeRelay {
  private server?: http.Server
  private address?: string
  private acceptedOrigin?: string
  private readonly sockets = new Set<import('node:stream').Duplex>()
  private authRefusals = 0
  private originRefusals = 0
  private lastOwnerRefusalStatus: number | null = null

  constructor(private readonly options: {
    token: string; backend: () => string; control: (request: unknown) => Promise<unknown>
    retryResponse?: (observed: { soulId: string; requestId: string; response: unknown }) => void
  }) {}

  get localUrl(): string {
    if (!this.address) throw new Error('owned relay is not started')
    return this.address
  }
  setOrigin(origin: string): void {
    const url = new URL(origin)
    if (url.protocol !== 'https:' || url.origin !== origin || (this.acceptedOrigin && this.acceptedOrigin !== origin)) {
      throw new Error('owned relay origin cannot change')
    }
    this.acceptedOrigin = origin
  }
  refusalFacts(): { authRefusals: number; originRefusals: number; lastOwnerRefusalStatus: number | null } {
    return { authRefusals: this.authRefusals, originRefusals: this.originRefusals, lastOwnerRefusalStatus: this.lastOwnerRefusalStatus }
  }

  private admission(request: IncomingMessage): number | null {
    if (request.headers.origin && request.headers.origin !== this.acceptedOrigin) {
      this.originRefusals += 1
      this.lastOwnerRefusalStatus = 403
      return 403
    }
    const url = new URL(request.url ?? '/', 'http://owned-relay')
    const token = request.headers['x-auth-token'] ?? request.headers.authorization?.replace(/^Bearer /, '') ?? url.searchParams.get('token')
    if (url.pathname === '/ws') {
      // Browser websocket authentication happens in the Rust hello frame.
      // The browser's exact admitted Origin and the server's hello validation
      // are retained; Node clients supply the token in their upgrade headers.
      if ((this.acceptedOrigin && request.headers.origin === this.acceptedOrigin) || token === this.options.token) return null
    } else if (!url.pathname.startsWith('/api/') && url.pathname !== '/__managed_runtime') {
      return null
    } else if (url.pathname === '/api/health' || token === this.options.token) return null
    this.authRefusals += 1
    this.lastOwnerRefusalStatus = 401
    return 401
  }

  private admittedPath(pathname: string): boolean {
    return pathname === '/' || pathname === '/index.html' || pathname === '/favicon.ico'
      || pathname === '/__managed_runtime' || pathname === '/ws'
      || ['/assets/', '/icons/', '/fonts/'].some((prefix) => pathname.startsWith(prefix))
      || pathname.startsWith('/api/')
  }

  private proxyHeaders(request: IncomingMessage, target: URL): http.OutgoingHttpHeaders {
    const headers = { ...request.headers, host: target.host }
    if (headers.origin) headers.origin = target.origin
    return headers
  }

  private async readOwnerRequest(request: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = []
    let length = 0
    for await (const chunk of request) {
      length += Buffer.byteLength(chunk)
      if (length > 64 * 1024) throw new Error('owned request exceeds its bound')
      chunks.push(Buffer.from(chunk))
    }
    return Buffer.concat(chunks)
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const refusal = this.admission(request)
    if (refusal) { response.writeHead(refusal); response.end(); return }
    const pathname = new URL(request.url ?? '/', 'http://owned-relay').pathname
    if (!this.admittedPath(pathname)) { response.writeHead(404); response.end(); return }
    if (pathname === '/__managed_runtime') {
      if (request.method !== 'POST') { response.writeHead(405); response.end(); return }
      const body = await this.readOwnerRequest(request)
      let result: unknown
      try { result = await this.options.control(JSON.parse(body.toString('utf8'))) }
      catch {
        response.writeHead(409, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ reason: 'owner_operation_refused' }))
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(result))
      return
    }
    const retryPath = request.method === 'POST' && this.options.retryResponse
      ? /^\/api\/runtime\/souls\/([^/]+)\/retry$/.exec(pathname) : null
    let retryBody: Buffer | undefined
    let requestId: string | undefined
    if (retryPath) {
      retryBody = await this.readOwnerRequest(request)
      const parsed = z.object({ requestId: z.string().min(1) }).passthrough().safeParse(JSON.parse(retryBody.toString('utf8')))
      if (!parsed.success) throw new Error('owned Retry request lacks its exact request ID')
      requestId = parsed.data.requestId
    }
    const target = new URL(this.options.backend())
    await new Promise<void>((resolve, reject) => {
      const upstream = http.request(target, {
        method: request.method, path: request.url, headers: this.proxyHeaders(request, target),
      }, (result) => {
        response.writeHead(result.statusCode ?? 502, result.headers)
        result.once('error', reject)
        if (retryPath && requestId && result.statusCode === 200) {
          const chunks: Buffer[] = []
          let length = 0
          result.on('data', (chunk: Buffer) => {
            length += chunk.length
            if (length > 1024 * 1024) result.destroy(new Error('owned Retry response exceeds its bound'))
            else chunks.push(chunk)
          })
          result.once('end', () => {
            try {
              this.options.retryResponse!({ soulId: decodeURIComponent(retryPath[1]), requestId,
                response: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
              resolve()
            } catch { reject(new Error('owned Retry response observation failed')) }
          })
        } else result.once('end', resolve)
        result.pipe(response)
      })
      upstream.once('error', reject)
      if (retryBody) upstream.end(retryBody)
      else request.pipe(upstream)
    })
  }

  async start(): Promise<void> {
    this.server = http.createServer((request, response) => {
      this.handle(request, response).catch(() => {
        if (!response.headersSent) response.writeHead(502)
        response.end()
      })
    })
    this.server.on('connection', (socket) => {
      this.sockets.add(socket)
      socket.once('close', () => this.sockets.delete(socket))
    })
    this.server.on('upgrade', (request, socket, head) => {
      const refusal = this.admission(request)
      if (refusal || new URL(request.url ?? '/', 'http://owned-relay').pathname !== '/ws') {
        socket.end(`HTTP/1.1 ${refusal ?? 404} Refused\r\nConnection: close\r\n\r\n`)
        return
      }
      const target = new URL(this.options.backend())
      const upstream = http.request(target, {
        method: 'GET', path: '/ws', headers: this.proxyHeaders(request, target),
      })
      upstream.once('error', () => socket.destroy())
      upstream.once('response', (response) => {
        socket.end(`HTTP/1.1 ${response.statusCode ?? 502} Refused\r\nConnection: close\r\n\r\n`)
        response.resume()
      })
      upstream.once('upgrade', (response, backend, backendHead) => {
        this.sockets.add(backend)
        backend.once('close', () => this.sockets.delete(backend))
        socket.write(`HTTP/1.1 ${response.statusCode} Switching Protocols\r\n${Object.entries(response.headers).map(([key, value]) => `${key}: ${String(value)}`).join('\r\n')}\r\n\r\n`)
        if (head.length) backend.write(head)
        if (backendHead.length) socket.write(backendHead)
        backend.on('error', () => socket.destroy())
        socket.on('error', () => backend.destroy())
        backend.pipe(socket)
        socket.pipe(backend)
      })
      upstream.end()
    })
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject)
      this.server!.listen(0, '127.0.0.1', resolve)
    })
    const address = this.server.address()
    if (!address || typeof address === 'string') throw new Error('owned relay did not bind its loopback address')
    this.address = `http://127.0.0.1:${address.port}`
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy()
    if (this.server) await new Promise<void>((resolve, reject) => this.server!.close((error) => error ? reject(error) : resolve()))
    this.server = undefined
    this.address = undefined
  }
}

/** Closed transport metadata shared by the owner runner and browser selection. */
export const EXTERNAL_MANAGED_SPEC_NAMES = [
  'runtime-provider-resurrection-rust.spec.ts',
  'runtime-managed-provider-qualification-rust.spec.ts',
  'runtime-fresh-agent-qualification-rust.spec.ts',
  'runtime-terminal-continuity-rust.spec.ts',
  'runtime-lost-soul-notice-rust.spec.ts',
  'runtime-opencode-provider-qualification-rust.spec.ts',
  'runtime-tabs-rehydrate-rust.spec.ts',
  'runtime-chaos-rust.spec.ts',
  'runtime-fresh-agent-fixture-rust.spec.ts',
  'runtime-external-target-smoke-rust.spec.ts',
] as const

export const EXTERNAL_DESCRIPTOR_KEYS = [
  'FRESHELL_E2E_TARGET_URL', 'FRESHELL_E2E_TARGET_WS_URL', 'FRESHELL_E2E_TARGET_TOKEN',
  'FRESHELL_RUNTIME_EXTERNAL_RUN_ID', 'FRESHELL_RUNTIME_EXTERNAL_CANDIDATE_SHA',
] as const

export const EXTERNAL_SELECTION_KEYS = [
  'FRESHELL_RUNTIME_SYNTHETIC_RESUME', 'FRESHELL_RUNTIME_FRESH_AGENT_FIXTURE_TEST',
  'FRESHELL_RUNTIME_SYNTHETIC_RESUME_FOLLOWUP',
  'FRESHELL_RUNTIME_MANAGED_PROVIDER_QUALIFICATION_LIVE',
  'FRESHELL_RUNTIME_MANAGED_PROVIDER_QUALIFICATION_PROVIDERS',
  'FRESHELL_RUNTIME_FRESH_AGENT_QUALIFICATION_LIVE',
  'FRESHELL_RUNTIME_FRESH_AGENT_QUALIFICATION_MODES',
  'FRESHELL_RUNTIME_PHASE3_LIVE', 'FRESHELL_RUNTIME_PHASE5_LIVE',
  'FRESHELL_RUNTIME_OPENCODE_QUALIFICATION_LIVE', 'FRESHELL_RUNTIME_PHASE5_CHAOS_LIVE',
] as const

export type ManagedExternalDescriptor = {
  baseUrl: string; wsUrl: string; token: string; runId: string; candidateSha: string
}

export type ManagedBrowserConnectionInfo = Pick<RuntimeWebInfo, 'baseUrl' | 'wsUrl' | 'token'>
export type ExternalOwnerFetch = (url: string, init: RequestInit) => Promise<Response>

const ExternalRuntimeViewSchema: z.ZodType<ManagedRuntimeView> = z.object({
  soulId: z.string().min(1), incarnationId: z.string().min(1), launchState: z.string().min(1),
  intentRevision: z.number().int().nonnegative(),
  containerId: z.string().regex(/^[a-f0-9]{64}$/).optional(), hostBootId: z.string().min(1).optional(),
  nativeSessionId: z.string().min(1).optional(), terminalId: z.string().optional(),
  freshAgentSessionId: z.string().optional(), freshAgentSessionType: z.string().optional(),
  provider: z.string().optional(),
}).passthrough()
const ExternalCleanupSchema = z.object({ ok: z.boolean(), errors: z.array(z.string()) }).strict()
const CompletedOwnerOperationSchema = z.object({ completed: z.literal(true) }).strict()
const ExternalOwnerRegistrationSchema = z.object({ phase: z.number().int().min(2).max(5),
  enabledProviders: z.array(z.string().min(1)), freshAgentModes: z.array(z.string().min(1)),
  fixtureFreshAgentModes: z.array(z.string().min(1)) }).strict()
export type ExternalOwnerRegistration = z.infer<typeof ExternalOwnerRegistrationSchema>

/** A Cloud browser has typed fixture operations and no local runtime/process authority. */
export class ExternalManagedRuntimeRig {
  private workspace?: string
  private stopSettlement?: Promise<{ ok: boolean; errors: string[] }>
  constructor(private readonly descriptor: ManagedExternalDescriptor, private readonly transport: ExternalOwnerFetch = fetch,
    private readonly expectedRegistration?: ExternalOwnerRegistration) {}
  get repoRoot(): string {
    if (!this.workspace) throw new Error('external owner description is not loaded')
    return this.workspace
  }
  get info(): ManagedBrowserConnectionInfo {
    return { baseUrl: this.descriptor.baseUrl, wsUrl: this.descriptor.wsUrl, token: this.descriptor.token }
  }
  private infoSchema(): z.ZodType<ManagedBrowserConnectionInfo> {
    return z.object({ baseUrl: z.literal(this.descriptor.baseUrl), wsUrl: z.literal(this.descriptor.wsUrl), token: z.literal(this.descriptor.token) }).strict()
  }
  private async rpc<T>(
    action: RuntimeOwnerOperationRequest['action'], schema: z.ZodType<T>,
    params: Pick<RuntimeOwnerOperationRequest, 'handle' | 'challengeId' | 'expectedControlEpoch' | 'expectedIntentRevision' | 'generation'> = {},
  ): Promise<T> {
    const operationId = randomUUID()
    const request = {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-auth-token': this.descriptor.token },
      body: JSON.stringify({ runId: this.descriptor.runId, candidateSha: this.descriptor.candidateSha,
        scenarioId: 'browser-managed-runtime', operationId, action, ...params }),
    }
    let response: Response | undefined
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        response = await this.transport(`${this.descriptor.baseUrl}/__managed_runtime`, {
          ...request, signal: AbortSignal.timeout(90_000),
        })
        break
      } catch {
        if (attempt === 1) throw new Error(`closed owner ${action} transport did not settle`)
        process.stderr.write(`${JSON.stringify({ severity: 'warn', event: 'managed_external_owner_transport_retry',
          runId: this.descriptor.runId, candidateSha: this.descriptor.candidateSha, operationId, action })}\n`)
      }
    }
    if (!response) throw new Error('closed owner transport produced no response')
    if (!response.ok) throw new Error(`closed owner operation refused: ${response.status}`)
    let body: unknown
    try { body = await response.json() } catch { throw new Error('closed owner reply is not valid JSON') }
    const reply = z.object({ runId: z.literal(this.descriptor.runId), candidateSha: z.literal(this.descriptor.candidateSha),
      operationId: z.literal(operationId), result: z.unknown() }).strict().safeParse(body)
    if (!reply.success) throw new Error('closed owner reply has invalid run, candidate, operation or shape')
    const result = schema.safeParse(reply.data.result)
    if (!result.success) throw new Error(`closed owner ${action} reply result is missing or invalid`)
    return result.data
  }
  async start(): Promise<ManagedBrowserConnectionInfo> {
    const description = await this.rpc('describe', z.object({ workspaceCwd: z.string().min(1), info: this.infoSchema(),
      registration: ExternalOwnerRegistrationSchema }).strict()).catch(() => { throw new Error('external registered owner description is missing or invalid') })
    const expected = this.expectedRegistration
    if (expected && (description.registration.phase !== expected.phase
      || (['enabledProviders', 'freshAgentModes', 'fixtureFreshAgentModes'] as const).some(key => {
        const actual = description.registration[key]
        return actual.length !== expected[key].length || actual.some(value => !expected[key].includes(value))
      }))) throw new Error('external owner registration differs from the requested fixture')
    this.workspace = description.workspaceCwd
    return description.info
  }
  async inventory(): Promise<ManagedRuntimeView[]> { return this.rpc('inventory', z.array(ExternalRuntimeViewSchema)) }
  async inventorySnapshot(): Promise<ManagedRuntimeInventorySnapshot> {
    return this.rpc('inventory-snapshot', ManagedRuntimeInventorySnapshotSchema)
  }
  async controlEpoch(): Promise<number> { return this.rpc('control-epoch', z.number().int().nonnegative()) }
  async writerClaimFacts(handle: ExactRuntimeHandle): Promise<RuntimeWriterClaimFacts> {
    return this.rpc('writer-claim', z.object({ provider: z.string().min(1), providerStoreId: z.string().min(1),
      nativeSessionId: z.literal(handle.nativeSessionId), soulId: z.literal(handle.soulId), incarnationId: z.literal(handle.incarnationId),
      activeClaimCount: z.number().int().nonnegative(), globalConflictingClaimCount: z.number().int().nonnegative() }).strict(), { handle })
  }
  async runningViewForTerminal(terminalId: string): Promise<ManagedRuntimeView | null> {
    return (await this.inventory()).find(row => row.terminalId === terminalId && row.launchState === 'running') ?? null
  }
  async runningViewForFreshSession(sessionId: string): Promise<ManagedRuntimeView | null> {
    return (await this.inventory()).find(row => row.freshAgentSessionId === sessionId && row.launchState === 'running') ?? null
  }
  exactRuntimeHandle(view: Pick<ManagedRuntimeView, 'soulId' | 'incarnationId' | 'containerId' | 'hostBootId' | 'nativeSessionId'>): ExactRuntimeHandle {
    if (!view.containerId || !/^[a-f0-9]{64}$/.test(view.containerId) || !view.hostBootId || !view.nativeSessionId) throw new Error('exact current runtime address required')
    return { runId: this.descriptor.runId, candidateSha: this.descriptor.candidateSha, soulId: view.soulId,
      incarnationId: view.incarnationId, containerId: view.containerId, hostBootId: view.hostBootId, nativeSessionId: view.nativeSessionId }
  }
  async fixtureNativeState(handle: ExactRuntimeHandle): Promise<FixtureNativeState> {
    return this.rpc('fixture-state', z.object({ nativeSessionId: z.literal(handle.nativeSessionId),
      pendingDecisionId: z.string().min(1).nullable(), dispatchCount: z.number().int().nonnegative(),
      completionCount: z.number().int().nonnegative() }).strict(), { handle })
  }
  async fixtureWorkerFacts(handle: ExactRuntimeHandle): Promise<{ provider: string; workerPid: number }> {
    return this.rpc('fixture-worker', z.object({ provider: z.string().min(1), workerPid: z.number().int().min(2) }).strict(), { handle })
  }
  async providerVolumeFacts(handle: ExactRuntimeHandle): Promise<{ providerVolumeName: string }> {
    return this.rpc('provider-volume', z.object({ providerVolumeName: z.string().min(1) }).strict(), { handle })
  }
  async chaosHostFacts(handle: ExactRuntimeHandle): Promise<RuntimeHostFacts> {
    return this.rpc('host-facts', z.object({ workerPid: z.number().int().positive(), workerLaunchCount: z.number().int().nonnegative(),
      limits: z.object({ cpuMax: z.string().regex(/^(?:max|\d+) \d+$/), memoryMax: z.string().regex(/^(?:max|\d+)$/),
        swapMax: z.string().regex(/^(?:max|\d+)$/), pidsMax: z.string().regex(/^(?:max|\d+)$/) }).strict(),
      unsafeBrokerAttempts: z.number().int().nonnegative() }).strict(), { handle })
  }
  async crashRuntimeHost(handle: ExactRuntimeHandle): Promise<void> {
    await this.rpc('crash-host', CompletedOwnerOperationSchema, { handle })
  }
  async holdRuntimeHost(handle: ExactRuntimeHandle): Promise<{ pid: number }> {
    return this.rpc('hold-host', z.object({ pid: z.number().int().positive() }).strict(), { handle })
  }
  async registerNativeChallenge(handle: ExactRuntimeHandle, kind: NativeChallengeKind): Promise<{ challengeId: string }> {
    return this.rpc('native-challenge-register', z.object({ challengeId: z.string().uuid() }).strict(), { handle, challengeId: kind })
  }
  async createSyntheticOpenCodeChallenge(handle: ExactRuntimeHandle): Promise<SyntheticOpenCodeChallenge> {
    return this.rpc('synthetic-history-challenge', z.object({ challengeId: z.string().uuid(),
      nativeSessionId: z.literal(handle.nativeSessionId), messageId: z.string().min(1), toolPartId: z.string().min(1) }).strict(), { handle })
  }
  async nativeToolEvidence(handle: ExactRuntimeHandle, challengeId: string): Promise<NativeToolEvidence> {
    return this.rpc('native-tool-evidence', z.object({ requestIds: z.array(z.string().min(1)), resultIds: z.array(z.string().min(1)),
      replayCount: z.number().int().nonnegative() }).strict(), { handle, challengeId })
  }
  async nativeFollowUpMessageIds(handle: ExactRuntimeHandle, challengeId: string): Promise<string[]> {
    return this.rpc('native-follow-up-ids', z.array(z.string().min(1)), { handle, challengeId })
  }
  async releaseRuntimeHost(handle: ExactRuntimeHandle): Promise<void> {
    await this.rpc('release-host', CompletedOwnerOperationSchema, { handle })
  }
  async crashFixtureWorker(handle: ExactRuntimeHandle): Promise<void> {
    await this.rpc('crash-provider', CompletedOwnerOperationSchema, { handle })
  }
  async allowFixtureDecision(handle: ExactRuntimeHandle, decisionId: string): Promise<void> {
    await this.rpc('fixture-decision-allow', CompletedOwnerOperationSchema, { handle, challengeId: decisionId })
  }
  async crashAndRestartWeb(): Promise<ManagedBrowserConnectionInfo> { return this.rpc('replace-web', this.infoSchema()) }
  async restartSupervisor(): Promise<void> { await this.rpc('replace-supervisor', CompletedOwnerOperationSchema) }
  async startRetainedFixture(fixtureId: 'config' | 'legacy'): Promise<Task2RetainedBrowserStage> {
    return this.rpc('retained-start', Task2RetainedBrowserStageSchema, { challengeId: fixtureId })
  }
  async retainedFixtureStage(): Promise<Task2RetainedBrowserStage> {
    return this.rpc('retained-status', Task2RetainedBrowserStageSchema)
  }
  async observeRetainedFixture(sequence: number): Promise<Task2RetainedBrowserStage> {
    return this.rpc('retained-observed', Task2RetainedBrowserStageSchema, { generation: sequence })
  }
  async finishRetainedFixture(): Promise<{ ok: boolean; errors: string[] }> {
    return this.rpc('retained-finish', ExternalCleanupSchema)
  }
  async stop(): Promise<{ ok: boolean; errors: string[] }> {
    this.stopSettlement ??= this.rpc('finish', ExternalCleanupSchema)
    try {
      const result = await this.stopSettlement
      if (!result.ok) this.stopSettlement = undefined
      return result
    } catch (error) { this.stopSettlement = undefined; throw error }
  }
}

export interface ExternalRetainedFixtureControl {
  start(fixtureId: 'config' | 'legacy'): void
  status(): Task2RetainedBrowserStage
  advance(sequence: number): void
  cancel(): Promise<void>
}

type RetainedArtifacts = Parameters<RuntimeHarness['prepareTask2FixtureArtifacts']>[0]
const RetainedArtifactSchema = z.object({ path: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
const RetainedArtifactsSchema: z.ZodType<RetainedArtifacts> = z.object({
  candidateSha: z.string().regex(/^[a-f0-9]{40}$/), imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  currentSupervisor: RetainedArtifactSchema, currentHost: RetainedArtifactSchema, currentServer: RetainedArtifactSchema,
  legacySupervisor: RetainedArtifactSchema, legacyHost: RetainedArtifactSchema,
  legacyCreatorCommit: z.literal('7dbc7ef6b0b87e47ec8386e19115f5e440399898'),
}).strict()

function readRetainedArtifacts(file: string | undefined, repoRoot: string, candidateSha: string): RetainedArtifacts {
  if (!file || !path.isAbsolute(file) || fs.realpathSync(file) !== file) throw new Error('exact owner Task2 artifact manifest required')
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) throw new Error('Task2 artifact manifest must be private and owned')
  const { repoRoot: manifestRoot, runId, ...artifacts } = JSON.parse(fs.readFileSync(file, 'utf8'))
  const parsed = RetainedArtifactsSchema.parse(artifacts)
  if (manifestRoot !== repoRoot || !z.string().uuid().safeParse(runId).success || parsed.candidateSha !== candidateSha) {
    throw new Error('Task2 artifacts differ from the current exact candidate and worktree')
  }
  return parsed
}

/** Each browser case owns a separate actual retained driver, broker and registry. */
export class OwnedRetainedBrowserFixtures implements ExternalRetainedFixtureControl {
  private session?: RetainedFixtureBrowserSession
  private activeWeb?: RuntimeWebHandle
  private readonly webs = new Set<RuntimeWebHandle>()
  private facts?: Extract<Task2RetainedBrowserStage, { kind: 'finished' }>['facts']
  private readonly cleanupErrors: string[] = []
  constructor(private readonly owner: ManagedRuntimeOwner, private readonly artifacts: RetainedArtifacts,
    private readonly allowed: readonly ('config' | 'legacy')[],
    private readonly webFactory: RuntimeWebFactory = options => new ManagedRuntimeWebServer(options)) {}

  get backend(): string { return this.activeWeb?.info.baseUrl ?? this.owner.info.baseUrl }
  start(fixtureId: 'config' | 'legacy'): void {
    if (!this.allowed.includes(fixtureId) || (this.session && this.session.status().kind !== 'finished')) {
      throw new Error('retained fixture is not registered or its previous run is unsettled')
    }
    const h: RuntimeHarness = new RuntimeHarness(this.owner.repoRoot, randomUUID(), 3)
    if (h.candidateSha !== this.owner.runtime.candidateSha) throw new Error('retained fixture source candidate changed')
    this.session = new RetainedFixtureBrowserSession()
    this.facts = undefined
    const factory: RuntimeWebFactory = options => {
      const web = this.webFactory({ ...options, token: this.owner.info.token })
      this.webs.add(web)
      const start = web.start.bind(web), stop = web.stop.bind(web)
      web.start = async () => { const info = await start(); this.activeWeb = web; return info }
      web.stop = async () => { await stop(); if (this.activeWeb === web) this.activeWeb = undefined }
      return web
    }
    this.session.start(async hooks => {
      let original: unknown
      try {
        await h.prepareTask2FixtureArtifacts(this.artifacts)
        h.recordLifecycle('external.retained_fixture_registered', { severity: 'info',
          parentRunId: this.owner.runtime.runId, candidateSha: h.candidateSha, fixtureId })
        await runTask2RetainedFixture(h, fixtureId === 'legacy', factory, hooks)
        h.assert(fixtureId, h.broker.unsafeAttempts().length === 0, 'retained browser fixture performs no unsafe broker operation')
      } catch (error) { original = error }
      let cleanupFailure: unknown
      try {
        const webErrors: unknown[] = []
        for (const web of this.webs) {
          try { await web.stop() } catch (error) { webErrors.push(error) }
        }
        const receipts = h.broker?.receipts() ?? [], ids = h.transferOwnedIds()
        const cleanup = await h.cleanup()
        h.verifyTransferCleanup({ containers: [...new Set([...ids.containers, ...receipts.map(row => row.containerId)])],
          volumes: [...new Set([...ids.volumes, ...receipts.flatMap(row => row.providerVolumeName ? [row.providerVolumeName] : [])])] })
        if (!cleanup.ok) throw new Error('actual retained resources did not clean up')
        if (webErrors.length) throw new AggregateError(webErrors, 'retained owned web cleanup failed')
        this.facts = { fixtureRunId: h.runId, candidateSha: h.candidateSha, imageDigest: h.imageRef,
          unsafeBrokerAttempts: h.broker?.unsafeAttempts().length ?? 0 }
        h.writeArtifact(fixtureId === 'legacy' ? 'task002-legacy-browser.json' : 'task002-config-browser.json', {
          kind: 'synthetic-task2-browser', nativeQualified: false, ...this.facts,
          parentRunId: this.owner.runtime.runId,
        })
      } catch (error) { cleanupFailure = error; this.cleanupErrors.push('retained fixture cleanup failed') }
      if (original && cleanupFailure) throw new AggregateError([original, cleanupFailure], 'retained fixture and cleanup failed')
      if (original) throw original
      if (cleanupFailure) throw cleanupFailure
    })
  }
  status(): Task2RetainedBrowserStage {
    if (!this.session) throw new Error('owned retained fixture has not started')
    const stage = this.session.status()
    return stage.kind === 'finished' ? { ...stage, facts: this.facts } : stage
  }
  advance(sequence: number): void {
    if (!this.session) throw new Error('owned retained fixture has not started')
    this.session.advance(sequence)
  }
  captureRetry(observed: { soulId: string; requestId: string; response: unknown }): void {
    if (!this.session) throw new Error('owned retained fixture has not started')
    this.session.captureRetry(observed.soulId, observed.requestId, observed.response)
  }
  async cancel(): Promise<void> {
    await this.session?.cancel()
    for (const web of this.webs) await web.stop()
    if (this.cleanupErrors.length) throw new Error(this.cleanupErrors.join('; '))
  }
}

export function createExternalRuntimeControl(
  owner: ManagedRuntimeOwner, descriptor: ManagedExternalDescriptor,
  retained?: ExternalRetainedFixtureControl,
): (input: unknown) => Promise<unknown> {
  if (owner.runtime.runId !== descriptor.runId || owner.runtime.candidateSha !== descriptor.candidateSha) {
    throw new Error('external controller differs from its exact owned run and candidate')
  }
  let finished = false
  const retainedStage = () => {
    if (!retained) throw new Error('registered retained fixture required')
    const stage = retained.status()
    return stage.kind === 'observe' || stage.kind === 'retry'
      ? { ...stage, context: { ...stage.context, info: {
        baseUrl: descriptor.baseUrl, wsUrl: descriptor.wsUrl, token: descriptor.token,
      } } } : stage
  }
  const queue = new RuntimeOwnerOperationQueue(descriptor.runId, descriptor.candidateSha, 'browser-managed-runtime', async request => {
    if (finished && request.action !== 'finish' && request.action !== 'abort') throw new Error('external owned runtime is finished')
    const handle = () => {
      if (!request.handle) throw new Error('exact current owner handle required')
      return request.handle
    }
    let result: unknown
    switch (request.action) {
      case 'describe':
        result = { workspaceCwd: owner.repoRoot, info: { baseUrl: descriptor.baseUrl, wsUrl: descriptor.wsUrl, token: descriptor.token },
          registration: owner.fixtureRegistrationFacts() }
        break
      case 'inventory': result = await owner.inventory(); break
      case 'inventory-snapshot': result = await owner.inventorySnapshot(); break
      case 'control-epoch': result = await owner.controlEpoch(); break
      case 'writer-claim': result = await owner.writerClaimFacts(handle()); break
      case 'retained-start':
        if (!retained || (request.challengeId !== 'config' && request.challengeId !== 'legacy')) throw new Error('registered retained fixture required')
        retained.start(request.challengeId)
        result = retainedStage()
        break
      case 'retained-status':
        if (!retained) throw new Error('registered retained fixture required')
        result = retainedStage()
        break
      case 'retained-observed':
        if (!retained || request.generation === undefined) throw new Error('exact retained stage sequence required')
        retained.advance(request.generation)
        result = retainedStage()
        break
      case 'retained-finish':
        if (!retained) throw new Error('registered retained fixture required')
        try { await retained.cancel(); result = { ok: true, errors: [] } }
        catch { result = { ok: false, errors: ['retained fixture cleanup failed'] } }
        break
      case 'host-facts': result = await owner.chaosHostFacts(handle()); break
      case 'fixture-state': result = await owner.fixtureNativeState(handle()); break
      case 'fixture-worker': result = await owner.fixtureWorkerFacts(handle()); break
      case 'provider-volume': result = await owner.providerVolumeFacts(handle()); break
      case 'fixture-decision-allow':
        if (!request.challengeId) throw new Error('actual pending fixture decision required')
        await owner.allowFixtureDecision(handle(), request.challengeId)
        result = { completed: true }
        break
      case 'crash-host': await owner.crashRuntimeHost(handle()); result = { completed: true }; break
      case 'hold-host': result = await owner.holdRuntimeHost(handle()); break
      case 'native-challenge-register':
        if (request.challengeId !== 'chaos-approval' && request.challengeId !== 'chaos-long-tool' && request.challengeId !== 'chaos-follow-up') throw new Error('registered native challenge kind required')
        result = await owner.registerNativeChallenge(handle(), request.challengeId)
        break
      case 'synthetic-history-challenge': result = await owner.createSyntheticOpenCodeChallenge(handle()); break
      case 'native-tool-evidence':
        if (!request.challengeId) throw new Error('registered native challenge required')
        result = await owner.nativeToolEvidence(handle(), request.challengeId)
        break
      case 'native-follow-up-ids':
        if (!request.challengeId) throw new Error('registered native challenge required')
        result = await owner.nativeFollowUpMessageIds(handle(), request.challengeId)
        break
      case 'release-host': await owner.releaseRuntimeHost(handle()); result = { completed: true }; break
      case 'crash-provider': await owner.crashFixtureWorker(handle()); result = { completed: true }; break
      case 'replace-web':
        await owner.crashAndRestartWeb()
        result = { baseUrl: descriptor.baseUrl, wsUrl: descriptor.wsUrl, token: descriptor.token }
        break
      case 'replace-supervisor': await owner.restartSupervisor(); result = { completed: true }; break
      case 'finish':
      case 'abort': {
        const errors: string[] = []
        try { await retained?.cancel() } catch { errors.push('retained fixture cleanup failed') }
        const cleanup = await owner.stop()
        errors.push(...cleanup.errors)
        finished = cleanup.ok && errors.length === 0
        result = { ok: finished, errors }
        break
      }
      default: throw new Error('owner operation is not admitted by this external fixture controller')
    }
    return { runId: descriptor.runId, candidateSha: descriptor.candidateSha, operationId: request.operationId, result }
  })
  return input => queue.perform(input)
}

export type ExternalBrowserSelection = {
  spec: string
  grep?: string
  provider?: QualifiableTerminalProvider
  mode?: QualifiableFreshAgentMode
}

export type ExternalBrowserCase = { id: string; title: string; file: string }
export type ExternalBrowserCaseResult = ExternalBrowserCase & {
  status: 'passed' | 'failed' | 'skipped' | 'timedOut' | 'interrupted'
}
export type ExternalBrowserCounts = {
  selected: number; executed: number; passed: number; failed: number; skipped: number; timedOut: number
}

export function parseExternalCloudExecutionEvents(
  events: readonly unknown[], context: Pick<ManagedExternalDescriptor, 'runId' | 'candidateSha'>,
): ExternalBrowserCaseResult[] {
  const cases: ExternalBrowserCaseResult[] = []
  let completion: Record<string, unknown> | undefined
  for (const input of events) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid Cloud execution event')
    const event = input as Record<string, unknown>
    if (!['managed_external_case', 'managed_external_complete'].includes(String(event.event))) continue
    if (event.runId !== context.runId || event.candidateSha !== context.candidateSha) {
      throw new Error('Cloud execution event differs from the owned run or candidate')
    }
    if (event.event === 'managed_external_complete') {
      if (completion) throw new Error('duplicate Cloud execution completion')
      completion = event
      continue
    }
    if (typeof event.id !== 'string' || !event.id || typeof event.title !== 'string' || !event.title
      || typeof event.file !== 'string' || !['passed', 'failed', 'skipped', 'timedOut', 'interrupted'].includes(String(event.status))) {
      throw new Error('invalid Cloud execution case observation')
    }
    specName(event.file)
    if (cases.some(row => row.id === event.id)) throw new Error('duplicate Cloud execution case')
    cases.push({ id: event.id, title: event.title, file: event.file, status: event.status as ExternalBrowserCaseResult['status'] })
  }
  if (!completion || completion.status !== 'passed' || !cases.length || completion.cases !== cases.length) {
    throw new Error('Cloud execution completion is missing, failed or incomplete')
  }
  return cases
}

/** Body-free execution observations travel through the exact Cloud execution log. */
export default class ManagedExternalExecutionReporter implements Reporter {
  private cases = 0
  private readonly descriptor = resolveManagedExternalDescriptor(process.env)

  printsToStdio(): boolean { return true }
  private emit(event: Record<string, unknown>): void {
    if (!this.descriptor) throw new Error('external execution reporter requires its owned descriptor')
    process.stdout.write(`${JSON.stringify({ severity: 'info', runId: this.descriptor.runId,
      candidateSha: this.descriptor.candidateSha, ...event })}\n`)
  }
  onTestEnd(test: TestCase, result: TestResult): void {
    const file = path.basename(test.location.file)
    const titles = test.titlePath()
    const fileIndex = titles.findIndex(title => path.basename(title) === file)
    if (fileIndex < 0) throw new Error('external executed title lacks its source file')
    const source = `test/e2e-browser/specs/${file}`
    specName(source)
    this.cases += 1
    this.emit({ event: 'managed_external_case', id: test.id, file: source,
      title: titles.slice(fileIndex + 1).join(' › '), status: result.status })
  }
  onEnd(result: FullResult): void {
    this.emit({ event: 'managed_external_complete', status: result.status, cases: this.cases })
  }
}

function reportObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid Playwright machine listing')
  return value as Record<string, unknown>
}

export function parseExternalPlaywrightList(value: unknown): ExternalBrowserCase[] {
  const report = reportObject(value)
  if (!Array.isArray(report.errors) || report.errors.length || !Array.isArray(report.suites)) {
    throw new Error('Playwright machine listing is missing or failed')
  }
  const cases: ExternalBrowserCase[] = []
  const visit = (input: unknown, parents: string[]) => {
    const suite = reportObject(input)
    if (typeof suite.title !== 'string' || typeof suite.file !== 'string') throw new Error('invalid Playwright listing suite')
    const title = suite.title === suite.file ? parents : [...parents, suite.title]
    if (suite.specs !== undefined && !Array.isArray(suite.specs)) throw new Error('invalid Playwright listing specs')
    for (const inputSpec of (suite.specs ?? []) as unknown[]) {
      const spec = reportObject(inputSpec)
      if (typeof spec.id !== 'string' || !spec.id || typeof spec.title !== 'string' || !spec.title
        || typeof spec.file !== 'string' || !(EXTERNAL_MANAGED_SPEC_NAMES as readonly string[]).includes(spec.file)
        || !Array.isArray(spec.tests) || spec.tests.length !== 1) throw new Error('invalid Playwright external listing case')
      const test = reportObject(spec.tests[0])
      if (test.projectName !== 'chromium-external-target' || test.expectedStatus !== 'passed') {
        throw new Error('Playwright listing selected an unsupported project or skipped case')
      }
      cases.push({ id: spec.id, title: [...title, spec.title].join(' › '), file: `test/e2e-browser/specs/${spec.file}` })
    }
    if (suite.suites !== undefined && !Array.isArray(suite.suites)) throw new Error('invalid Playwright listing child suites')
    for (const child of (suite.suites ?? []) as unknown[]) visit(child, title)
  }
  for (const suite of report.suites) visit(suite, [])
  return cases
}

export function listExternalBrowserCases(
  selection: ExternalBrowserSelection, environment: NodeJS.ProcessEnv, execute: typeof execFileSync = execFileSync,
): ExternalBrowserCase[] {
  const env = validateSelection(selection, environment)
  if (!resolveManagedExternalDescriptor(env)) throw new Error('complete external descriptor required before Playwright listing')
  const output = execute('pnpm', [
    'exec', 'playwright', 'test', '--config', 'test/e2e-browser/playwright.cloud.config.ts',
    '--list', '--reporter=json', '--project=chromium-external-target', selection.spec,
    ...(selection.grep ? ['--grep', selection.grep] : []),
  ], {
    cwd: process.cwd(), env: {
      ...env, FRESHELL_RUNTIME_EXTERNAL_SPEC: selection.spec,
      ...(selection.grep ? { FRESHELL_RUNTIME_EXTERNAL_GREP: selection.grep } : {}),
    }, encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024,
  })
  return parseExternalPlaywrightList(JSON.parse(output))
}

export interface ExternalBrowserLifecycle {
  start(selection: ExternalBrowserSelection): Promise<NodeJS.ProcessEnv>
  list(selection: ExternalBrowserSelection, environment: NodeJS.ProcessEnv): Promise<ExternalBrowserCase[]>
  child(command: string, args: string[], environment: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<{
    exitCode: number; cases: ExternalBrowserCaseResult[]
  }>
  finish(): Promise<{ ok: boolean; errors: string[] }>
  abort(): Promise<{ ok: boolean; errors: string[] }>
}

export function resolveManagedExternalDescriptor(env: NodeJS.ProcessEnv): ManagedExternalDescriptor | null {
  if (!EXTERNAL_DESCRIPTOR_KEYS.some((key) => env[key] !== undefined)) return null
  if (EXTERNAL_DESCRIPTOR_KEYS.some((key) => !env[key]?.trim())) throw new Error('complete owned external descriptor required')
  let http: URL
  let websocket: URL
  try {
    http = new URL(env.FRESHELL_E2E_TARGET_URL!)
    websocket = new URL(env.FRESHELL_E2E_TARGET_WS_URL!)
  } catch { throw new Error('invalid external transport descriptor') }
  if (http.protocol !== 'https:' || websocket.protocol !== 'wss:' || http.host !== websocket.host
    || http.pathname !== '/' || websocket.pathname !== '/ws'
    || [http, websocket].some((url) => url.username || url.password || url.search || url.hash)
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(env.FRESHELL_RUNTIME_EXTERNAL_RUN_ID!)
    || !/^[a-f0-9]{40}$/.test(env.FRESHELL_RUNTIME_EXTERNAL_CANDIDATE_SHA!)) {
    throw new Error('invalid external origin, run or candidate descriptor')
  }
  return {
    baseUrl: http.origin, wsUrl: websocket.href, token: env.FRESHELL_E2E_TARGET_TOKEN!,
    runId: env.FRESHELL_RUNTIME_EXTERNAL_RUN_ID!, candidateSha: env.FRESHELL_RUNTIME_EXTERNAL_CANDIDATE_SHA!,
  }
}

function specName(spec: string): string {
  const prefix = 'test/e2e-browser/specs/'
  if (!spec.startsWith(prefix) || !(EXTERNAL_MANAGED_SPEC_NAMES as readonly string[]).includes(spec.slice(prefix.length))) {
    throw new Error('external browser requires an allowlisted exact spec path')
  }
  return spec.slice(prefix.length)
}

function requireOptIn(env: NodeJS.ProcessEnv, name: string): void {
  if (env[name] !== '1') throw new Error(`external browser requires ${name}=1 for this selection`)
}

function validateSelection(selection: ExternalBrowserSelection, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const name = specName(selection.spec)
  const environment = { ...env }
  if (selection.grep !== undefined) {
    if (!selection.grep) throw new Error('external grep must not be empty')
    try { new RegExp(selection.grep) } catch { throw new Error('invalid external grep selector') }
  }
  if (selection.provider !== undefined) {
    if (name !== 'runtime-managed-provider-qualification-rust.spec.ts') throw new Error('provider selector requires the managed-provider qualification spec')
    const providers = parseQualificationProviderSelection(selection.provider)
    if (providers.length !== 1) throw new Error('external provider selector must name exactly one provider')
    environment[QUALIFICATION_PROVIDER_SELECTION_ENV] = selection.provider
  }
  if (selection.mode !== undefined) {
    if (name !== 'runtime-fresh-agent-qualification-rust.spec.ts') throw new Error('mode selector requires the fresh-agent qualification spec')
    const modes = parseFreshAgentQualificationModes(selection.mode)
    if (modes.length !== 1) throw new Error('external mode selector must name exactly one mode')
    environment[FRESH_AGENT_QUALIFICATION_MODES_ENV] = selection.mode
  }
  if (selection.provider && selection.mode) throw new Error('external provider and mode selectors are mutually exclusive')
  const synthetic = selection.grep?.includes('synthetic') || selection.grep?.includes('source-to-soul') || selection.grep?.includes('restoration runbook')
  if (synthetic && (selection.provider || selection.mode)) throw new Error('native provider or mode selection cannot select a synthetic case')
  if (synthetic) requireOptIn(environment, 'FRESHELL_RUNTIME_SYNTHETIC_RESUME')
  if (name === 'runtime-fresh-agent-fixture-rust.spec.ts') requireOptIn(environment, 'FRESHELL_RUNTIME_FRESH_AGENT_FIXTURE_TEST')
  if (name === 'runtime-managed-provider-qualification-rust.spec.ts' && !synthetic) {
    requireOptIn(environment, 'FRESHELL_RUNTIME_MANAGED_PROVIDER_QUALIFICATION_LIVE')
    parseQualificationProviderSelection(environment[QUALIFICATION_PROVIDER_SELECTION_ENV] ?? '')
  }
  if (name === 'runtime-fresh-agent-qualification-rust.spec.ts') {
    requireOptIn(environment, 'FRESHELL_RUNTIME_FRESH_AGENT_QUALIFICATION_LIVE')
    parseFreshAgentQualificationModes(environment[FRESH_AGENT_QUALIFICATION_MODES_ENV] ?? '')
  }
  if (name === 'runtime-provider-resurrection-rust.spec.ts' && !synthetic) requireOptIn(environment, 'FRESHELL_RUNTIME_PHASE3_LIVE')
  if (name === 'runtime-lost-soul-notice-rust.spec.ts') requireOptIn(environment, 'FRESHELL_RUNTIME_PHASE5_LIVE')
  if (name === 'runtime-opencode-provider-qualification-rust.spec.ts') requireOptIn(environment, 'FRESHELL_RUNTIME_OPENCODE_QUALIFICATION_LIVE')
  if (name === 'runtime-chaos-rust.spec.ts') requireOptIn(environment, 'FRESHELL_RUNTIME_PHASE5_CHAOS_LIVE')
  return environment
}

export function parseExternalBrowserArguments(args: readonly string[], env: NodeJS.ProcessEnv = process.env): ExternalBrowserSelection {
  const values = new Map<string, string>()
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]
    if (!['--spec', '--grep', '--provider', '--mode'].includes(flag)
      || values.has(flag) || !args[index + 1] || args[index + 1].startsWith('--')) {
      throw new Error('usage: pnpm exec tsx scripts/testing/runtime-external-browser.ts --spec <managed-spec> [--grep <selector>] [--provider <provider> | --mode <mode>]')
    }
    values.set(flag, args[index + 1])
  }
  const selection: ExternalBrowserSelection = {
    spec: values.get('--spec') ?? '', grep: values.get('--grep'),
    provider: values.get('--provider') as QualifiableTerminalProvider | undefined,
    mode: values.get('--mode') as QualifiableFreshAgentMode | undefined,
  }
  validateSelection(selection, env)
  return selection
}

/** Only this closed public target and selection crosses the Cloud job boundary. */
export function externalCloudMetadata(environment: NodeJS.ProcessEnv): Record<string, string> {
  if (!resolveManagedExternalDescriptor(environment)) return {}
  const selection: ExternalBrowserSelection = {
    spec: environment.FRESHELL_RUNTIME_EXTERNAL_SPEC ?? '', grep: environment.FRESHELL_RUNTIME_EXTERNAL_GREP,
  }
  const admitted = validateSelection(selection, environment)
  const metadata: Record<string, string> = {}
  for (const key of [...EXTERNAL_DESCRIPTOR_KEYS, ...EXTERNAL_SELECTION_KEYS,
    'FRESHELL_RUNTIME_EXTERNAL_SPEC', 'FRESHELL_RUNTIME_EXTERNAL_GREP']) {
    const value = admitted[key]
    if (value !== undefined) metadata[key] = value
  }
  return metadata
}

export function assertExternalCloudJobOwned(
  observed: unknown, context: { jobName: string; runId: string; candidateSha: string },
): void {
  const parsed = z.object({ metadata: z.object({ name: z.literal(context.jobName), labels: z.object({
    'freshell-managed-run': z.literal(context.runId), 'freshell-managed-candidate': z.literal(context.candidateSha),
  }).passthrough() }).passthrough() }).passthrough().safeParse(observed)
  if (!parsed.success) throw new Error('exact owned Cloud job identity is missing or differs from this run and candidate')
}

export function assertExternalCloudJobAbsent(observed: unknown, jobName: string): void {
  const parsed = ExternalCloudJobInventorySchema.safeParse(observed)
  if (!parsed.success) throw new Error('Cloud job inventory is missing or incomplete')
  if (parsed.data.some(job => job.metadata.name === jobName)) throw new Error('exact owned Cloud job remains after cleanup')
}

const ExternalCloudJobInventorySchema = z.array(z.object({ metadata: z.object({ name: z.string().min(1) }).passthrough() }).passthrough())

type OwnedExternalCloudJob = {
  jobName: string; runId: string; candidateSha: string; project: string; region: string; account: string
}

/** The launcher may vanish before its EXIT trap; cleanup remains with the owner. */
export function cleanupOwnedExternalCloudJob(context: OwnedExternalCloudJob, execute: typeof execFileSync = execFileSync): void {
  const flags = [`--project=${context.project}`, `--region=${context.region}`, `--account=${context.account}`]
  const call = (args: string[]) => execute('gcloud', ['--quiet', 'run', 'jobs', ...args, ...flags],
    { encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CLOUDSDK_CORE_DISABLE_PROMPTS: '1' } })
  const inventory = (): unknown => JSON.parse(String(call(['list', '--format=json'])))
  const before = ExternalCloudJobInventorySchema.safeParse(inventory())
  if (!before.success) throw new Error('Cloud job inventory is missing or incomplete')
  if (!before.data.some(job => job.metadata.name === context.jobName)) return
  assertExternalCloudJobOwned(JSON.parse(String(call(['describe', context.jobName, '--format=json']))), context)
  const executions = z.array(z.object({ metadata: z.object({ name: z.string().min(1), labels: z.object({
    'run.googleapis.com/job': z.literal(context.jobName),
  }).passthrough() }).passthrough(), status: z.object({ completionTime: z.string().min(1).optional() }).passthrough() }).passthrough())
    .safeParse(JSON.parse(String(call(['executions', 'list', `--job=${context.jobName}`, '--format=json']))))
  if (!executions.success) throw new Error('exact owned Cloud execution inventory is missing or invalid')
  for (const execution of executions.data) {
    if (!execution.status.completionTime) call(['executions', 'cancel', execution.metadata.name])
  }
  call(['delete', context.jobName])
  assertExternalCloudJobAbsent(inventory(), context.jobName)
}

function requiredCases(selection: ExternalBrowserSelection, listed: ExternalBrowserCase[], environment: NodeJS.ProcessEnv): ExternalBrowserCase[] {
  const matched = listed.filter((row) => {
    if (row.file !== selection.spec || (selection.grep && !new RegExp(selection.grep).test(row.title))) return false
    if (!selection.grep && path.basename(selection.spec) === 'runtime-managed-provider-qualification-rust.spec.ts'
      && (selection.provider || environment.FRESHELL_RUNTIME_SYNTHETIC_RESUME !== '1')
      && /(?:^| › )synthetic (?:config-blocked exact retry|legacy retained-runtime exact retry)$/.test(row.title)) return false
    if (!selection.grep && path.basename(selection.spec) === 'runtime-provider-resurrection-rust.spec.ts'
      && environment.FRESHELL_RUNTIME_SYNTHETIC_RESUME !== '1'
      && row.title.startsWith('managed OpenCode source-to-soul resume › ')) return false
    return true
  })
  if (!matched.length) throw new Error('external browser selected zero requested cases')
  if (new Set(matched.map((row) => row.id)).size !== matched.length || matched.some((row) => !row.id || !row.title)) {
    throw new Error('invalid or duplicate selected external case identities')
  }
  if (selection.grep) {
    // Simple explicit title alternatives each require a positive match.
    // Grouped regexes remain one selector and use Playwright's exact listing.
    const patterns = /[()\\]/.test(selection.grep) ? [selection.grep] : selection.grep.split('|')
    if (patterns.some((pattern) => !matched.some((row) => new RegExp(pattern).test(row.title)))) {
      throw new Error('external browser selected zero cases for a requested title')
    }
  }
  return matched
}

export async function dispatchOwnedExternalBrowser(
  selection: ExternalBrowserSelection, environment: NodeJS.ProcessEnv, owner: ExternalBrowserLifecycle,
  signal?: AbortSignal,
): Promise<ExternalBrowserCounts> {
  const selectedEnv = validateSelection(selection, environment)
  if (selectedEnv.FRESHELL_E2E_BACKEND !== 'cloud') throw new Error('managed external browser requires its configured cloud backend')
  try {
    signal?.throwIfAborted()
    const ownedEnvironment = await owner.start(selection)
    signal?.throwIfAborted()
    const descriptor = resolveManagedExternalDescriptor(ownedEnvironment)
    if (!descriptor) throw new Error('owner did not publish its complete external descriptor')
    const env = {
      ...selectedEnv, ...ownedEnvironment,
      FRESHELL_RUNTIME_EXTERNAL_SPEC: selection.spec,
      ...(selection.grep ? { FRESHELL_RUNTIME_EXTERNAL_GREP: selection.grep } : {}),
    }
    const selected = requiredCases(selection, await owner.list(selection, env), env)
    signal?.throwIfAborted()
    const child = await owner.child('pnpm', [
      'run', 'test:e2e', '--project=chromium-external-target', '--shards=1', '--workers=1', '--retries=0',
      selection.spec, ...(selection.grep ? ['--grep', selection.grep] : []),
    ], env, ...(signal ? [signal] : []))
    signal?.throwIfAborted()
    if (child.exitCode !== 0) throw new Error('configured cloud dispatch failed')
    const results = selected.map((row) => {
      const matches = child.cases.filter((result) => result.id === row.id && result.file === row.file && result.title === row.title)
      if (matches.length !== 1) throw new Error('selected/executed external case identities differ')
      return matches[0]
    })
    const selectedIds = new Set(selected.map((row) => row.id))
    if (child.cases.some((row) => !selectedIds.has(row.id) && row.status !== 'skipped')
      || results.some((row) => row.status !== 'passed')) throw new Error('selected external cases did not all execute and pass')
    const counts: ExternalBrowserCounts = {
      selected: selected.length, executed: results.length, passed: results.length,
      failed: 0, skipped: 0, timedOut: 0,
    }
    const cleanup = await owner.finish()
    if (!cleanup.ok || cleanup.errors.length) throw new Error('owned external cleanup failed')
    return counts
  } catch (error) {
    let cleanup: { ok: boolean; errors: string[] }
    try { cleanup = await owner.abort() }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'external browser and owned abort failed') }
    if (!cleanup.ok || cleanup.errors.length) throw new AggregateError([error], 'external browser failed and owned cleanup failed')
    throw error
  }
}

async function probeExternalManagedWebsocket(descriptor: ManagedExternalDescriptor): Promise<void> {
  const socket = new WebSocket(descriptor.wsUrl, { headers: { Origin: descriptor.baseUrl, 'x-auth-token': descriptor.token } })
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('owned external websocket readiness timed out')), 10_000)
      const settle = (error?: Error) => { clearTimeout(timer); error ? reject(error) : resolve() }
      socket.once('error', () => settle(new Error('owned external websocket transport failed')))
      socket.once('close', () => settle(new Error('owned external websocket closed before readiness')))
      socket.once('open', () => socket.send(JSON.stringify({ type: 'hello', token: descriptor.token,
        protocolVersion: WS_PROTOCOL_VERSION, capabilities: { managedRuntimeV1: true, paneReconcileV1: true } })))
      socket.on('message', input => {
        let value: unknown
        try { value = JSON.parse(String(input)) } catch { return }
        const frame = z.object({ type: z.literal('ready'), buildId: z.literal(descriptor.candidateSha),
          capabilities: z.object({ managedRuntimeV1: z.literal(true) }).passthrough() }).passthrough().safeParse(value)
        if (frame.success) settle()
      })
    })
  } finally { socket.terminate() }
}

async function verifyExternalManagedTransport(descriptor: ManagedExternalDescriptor): Promise<void> {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    try {
      const server = await fetch(`${descriptor.baseUrl}/api/server-info`, {
        headers: { 'x-auth-token': descriptor.token, Origin: descriptor.baseUrl }, signal: AbortSignal.timeout(5000),
      })
      if (!server.ok) throw new Error('owned external authenticated HTTP refused')
      validateManagedWebProvenance(await server.json(), descriptor.candidateSha, false)
      const unauthenticated = await fetch(`${descriptor.baseUrl}/api/server-info`, { signal: AbortSignal.timeout(5000) })
      if (unauthenticated.status !== 401) throw new Error('owned external unauthenticated HTTP was not refused')
      const foreign = await fetch(`${descriptor.baseUrl}/api/server-info`, { headers: {
        'x-auth-token': descriptor.token, Origin: 'https://unowned.invalid',
      }, signal: AbortSignal.timeout(5000) })
      if (foreign.status !== 403) throw new Error('owned external foreign Origin was not refused')
      await probeExternalManagedWebsocket(descriptor)
      return
    } catch { await delay(500) }
  }
  throw new Error('owned HTTPS/WSS provenance and admission readiness failed')
}

/** Production lifecycle; its callbacks own only this run's local resources. */
export class ManagedExternalBrowserLifecycle implements ExternalBrowserLifecycle {
  private owner?: ManagedRuntimeOwner
  private relay?: OwnedManagedRuntimeRelay
  private tunnel?: OwnedManagedRuntimeTunnel
  private cloud?: OwnedRuntimeChild
  private descriptor?: ManagedExternalDescriptor
  private retained?: OwnedRetainedBrowserFixtures
  private readonly cloudJobs = new Map<string, OwnedExternalCloudJob>()
  constructor(private readonly repoRoot = process.cwd(), private readonly environment: NodeJS.ProcessEnv = process.env) {}

  async start(selection: ExternalBrowserSelection): Promise<NodeJS.ProcessEnv> {
    const root = fs.realpathSync(this.repoRoot)
    if (!fs.statSync(path.join(root, '.git')).isFile()
      || execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()) {
      throw new Error('owned external candidate requires an exact clean isolated worktree')
    }
    const socket = dockerSocketPath()
    if (socket !== `/run/user/${process.getuid?.() ?? 1000}/docker.sock` || !fs.statSync(socket).isSocket()) {
      throw new Error('owned external target requires the admitted local rootless Docker socket')
    }
    process.env.DOCKER_HOST = `unix://${socket}`
    const security = JSON.parse(execFileSync('docker', ['info', '--format', '{{json .SecurityOptions}}'], { encoding: 'utf8' }))
    if (!Array.isArray(security) || !security.includes('name=rootless')) throw new Error('owned runtime Docker daemon is not rootless')
    const fixture = path.basename(selection.spec) === 'runtime-fresh-agent-fixture-rust.spec.ts'
    const smoke = path.basename(selection.spec) === 'runtime-external-target-smoke-rust.spec.ts'
    const deterministic = fixture || smoke
    const retainedSelection = path.basename(selection.spec) === 'runtime-managed-provider-qualification-rust.spec.ts'
      && this.environment.FRESHELL_RUNTIME_SYNTHETIC_RESUME === '1'
    const retainedArtifacts = retainedSelection ? readRetainedArtifacts(this.environment.FRESHELL_TASK002_FIXTURE_ARTIFACT_MANIFEST,
      root, execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()) : undefined
    const modes = fixture ? ['freshclaude', 'kilroy', 'freshcodex', 'freshopencode'] : smoke ? ['freshopencode'] : selection.mode ? [selection.mode] : []
    const providers = deterministic || selection.mode ? [] : selection.provider ? [selection.provider] : ['opencode']
    const phase = deterministic ? 3 : selection.provider || selection.mode ? 5
      : path.basename(selection.spec).includes('resurrection') ? 3
        : path.basename(selection.spec).includes('rehydrate') ? 4
          : /chaos|lost-soul/.test(selection.spec) ? 5 : 2
    this.owner = new ManagedRuntimeOwner(options => new ManagedRuntimeWebServer({ ...options, preserveHomeOnStop: false }), root, phase,
      {}, {}, deterministic ? 'test' : 'release', { enabledProviders: providers, freshAgentModes: modes,
        fixtureFreshAgentModes: deterministic ? modes : [] }, undefined, {
        bootstrapProviders: deterministic || retainedArtifacts ? [] : selection.provider ? [selection.provider] : ['claude', 'codex', 'opencode', 'amplifier'],
      })
    execFileSync('pnpm', ['run', 'build:client'], { cwd: root, stdio: 'inherit' })
    execFileSync('pnpm', ['run', 'build:tools'], { cwd: root, stdio: 'inherit' })
    await this.owner.start()
    if (retainedArtifacts) {
      const titles = { config: 'synthetic config-blocked exact retry', legacy: 'synthetic legacy retained-runtime exact retry' }
      const allowed = (['config', 'legacy'] as const).filter(id => !selection.grep || new RegExp(selection.grep).test(titles[id]))
      this.retained = new OwnedRetainedBrowserFixtures(this.owner, retainedArtifacts, allowed)
    }
    let control: ((request: unknown) => Promise<unknown>) | undefined
    this.relay = new OwnedManagedRuntimeRelay({ token: this.owner.info.token, backend: () => this.retained?.backend ?? this.owner!.info.baseUrl,
      control: async request => {
        if (!control) throw new Error('owned external controller is not admitted yet')
        return control(request)
      },
      retryResponse: this.retained ? observed => this.retained!.captureRetry(observed) : undefined,
    })
    await this.relay.start()
    this.tunnel = new OwnedManagedRuntimeTunnel(root, this.environment.FRESHELL_RUNTIME_CLOUDFLARED_BINARY)
    await this.tunnel.start(this.relay.localUrl)
    this.relay.setOrigin(this.tunnel.baseUrl)
    this.descriptor = { baseUrl: this.tunnel.baseUrl, wsUrl: this.tunnel.wsUrl,
      token: this.owner.info.token, runId: this.owner.runtime.runId, candidateSha: this.owner.runtime.candidateSha }
    control = createExternalRuntimeControl(this.owner, this.descriptor, this.retained)
    await verifyExternalManagedTransport(this.descriptor)
    this.owner.runtime.recordLifecycle('external.transport_ready', { runId: this.descriptor.runId,
      candidateSha: this.descriptor.candidateSha, tunnel: this.tunnel.processEvidence(), web: this.owner.web.processEvidence() })
    return { FRESHELL_E2E_TARGET_URL: this.descriptor.baseUrl, FRESHELL_E2E_TARGET_WS_URL: this.descriptor.wsUrl,
      FRESHELL_E2E_TARGET_TOKEN: this.descriptor.token, FRESHELL_RUNTIME_EXTERNAL_RUN_ID: this.descriptor.runId,
      FRESHELL_RUNTIME_EXTERNAL_CANDIDATE_SHA: this.descriptor.candidateSha }
  }
  async list(selection: ExternalBrowserSelection, environment: NodeJS.ProcessEnv): Promise<ExternalBrowserCase[]> {
    this.tunnel?.assertAlive()
    return listExternalBrowserCases(selection, environment)
  }
  async child(command: string, args: string[], environment: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<{ exitCode: number; cases: ExternalBrowserCaseResult[] }> {
    if (command !== 'pnpm' || !this.owner || !this.descriptor || !this.tunnel) throw new Error('owned Cloud dispatch is not ready')
    const manager = (this.environment.PATH ?? '').split(path.delimiter).map(directory => path.join(directory, 'pnpm')).find(file => fs.existsSync(file))
    if (!manager || execFileSync(manager, ['--version'], { encoding: 'utf8' }).trim() !== '10.34.5') throw new Error('owned dispatch requires pinned pnpm')
    this.cloud = await OwnedRuntimeChild.create(process.execPath, [fs.realpathSync(manager), ...args], this.repoRoot, environment)
    const deadline = Date.now() + 2 * 60 * 60_000
    const events = new Map<string, Record<string, unknown>>()
    while (this.cloud.alive()) {
      signal?.throwIfAborted()
      this.tunnel.assertAlive()
      if (Date.now() > deadline) throw new Error('owned Cloud browser lifetime expired')
      this.captureCloudEvents(events)
      await delay(200)
    }
    const exitCode = await this.cloud.wait()
    this.captureCloudEvents(events)
    const records = [...events.values()]
    const cases = records.filter(record => record.event === 'managed_external_cloud_cases')
    const cleanup = records.filter(record => record.event === 'managed_external_job_cleanup')
    if (cases.length !== 1 || cleanup.length !== 1 || cleanup[0].ok !== true || !Array.isArray(cases[0].cases)) {
      throw new Error('exact Cloud execution cases or verified job cleanup are missing')
    }
    return { exitCode, cases: z.array(z.object({ id: z.string().min(1), file: z.string().min(1), title: z.string().min(1),
      status: z.enum(['passed', 'failed', 'skipped', 'timedOut', 'interrupted']) }).strict()).parse(cases[0].cases) }
  }
  private captureCloudEvents(events: Map<string, Record<string, unknown>>): void {
    if (!this.cloud || !this.descriptor || !this.owner) return
    for (const line of this.cloud.output().stdout.split('\n')) {
      let value: unknown
      try { value = JSON.parse(line) } catch { continue }
      const parsed = z.object({ event: z.enum(['managed_external_job_reserved', 'managed_external_job_created', 'managed_external_job_execution',
        'managed_external_cloud_cases', 'managed_external_job_cleanup']), runId: z.literal(this.descriptor.runId),
        candidateSha: z.literal(this.descriptor.candidateSha) }).passthrough().safeParse(value)
      if (!parsed.success) continue
      if (parsed.data.event === 'managed_external_job_reserved') {
        const job = z.object({ jobName: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
          runId: z.literal(this.descriptor.runId), candidateSha: z.literal(this.descriptor.candidateSha),
          project: z.string().min(1), region: z.string().min(1), account: z.string().min(1) }).safeParse(parsed.data)
        if (!job.success) throw new Error('owned Cloud job reservation has invalid resource or identity context')
        this.cloudJobs.set(job.data.jobName, job.data)
      }
      const fingerprint = createHash('sha256').update(JSON.stringify(parsed.data)).digest('hex')
      if (events.has(fingerprint)) continue
      events.set(fingerprint, parsed.data)
      this.owner.runtime.recordLifecycle(parsed.data.event, parsed.data)
    }
  }
  async finish(): Promise<{ ok: boolean; errors: string[] }> {
    const errors: string[] = []
    for (const [name, cleanup] of [
      ['cloud child', async () => {
        if (this.cloud) {
          this.captureCloudEvents(new Map())
          await this.cloud.stop()
          this.captureCloudEvents(new Map())
        }
      }],
      ['Cloud jobs', async () => { for (const job of this.cloudJobs.values()) cleanupOwnedExternalCloudJob(job) }],
      ['retained fixtures', async () => { await this.retained?.cancel() }],
      ['runtime', async () => { if (this.owner) { const result = await this.owner.stop(); errors.push(...result.errors) } }],
      ['tunnel', async () => { await this.tunnel?.stop() }],
      ['relay', async () => { await this.relay?.stop() }],
    ] as const) {
      try { await cleanup() } catch { errors.push(`${name} cleanup failed`) }
    }
    return { ok: errors.length === 0, errors }
  }
  async abort(): Promise<{ ok: boolean; errors: string[] }> { return this.finish() }
}

export async function runExternalBrowserCli(args: readonly string[], environment: NodeJS.ProcessEnv = process.env,
  owner: ExternalBrowserLifecycle = new ManagedExternalBrowserLifecycle(process.cwd(), environment), signal?: AbortSignal): Promise<ExternalBrowserCounts> {
  return dispatchOwnedExternalBrowser(parseExternalBrowserArguments(args, environment), environment, owner, signal)
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const cancellation = new AbortController()
  const cancel = () => cancellation.abort(new Error('owned external run cancelled'))
  process.once('SIGTERM', cancel)
  process.once('SIGINT', cancel)
  runExternalBrowserCli(process.argv.slice(2), process.env, undefined, cancellation.signal).then(counts => {
    process.stdout.write(`${JSON.stringify({ severity: 'info', event: 'managed_external_browser_passed', counts })}\n`)
  }).catch(() => {
    process.stderr.write(`${JSON.stringify({ severity: 'error', event: 'managed_external_admission_or_run_failed' })}\n`)
    process.exitCode = 1
  }).finally(() => {
    process.removeListener('SIGTERM', cancel)
    process.removeListener('SIGINT', cancel)
  })
}
