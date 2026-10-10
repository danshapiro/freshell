#!/usr/bin/env node
// native-session-names.mjs — the required native session-names contract runner
// (unified-agent-names plan, Task 8).
//
// Runs INSIDE the disposable freshell-sandbox container (never on the host,
// never against a live target) and proves the three REAL provider metadata
// contracts against the prepared Freshell runtime:
//
//   1. Claude  — the staged production `session-names.mjs` helper with the
//      locked SDK 0.3.237 (read / rename / read, a fresh helper-process
//      readback), plus the Rust rename route's canonical manual name and
//      own-echo protection, selected-root targeting with a non-target copy
//      untouched, and the short generated-title value accepted without
//      changing the transcript metadata shape.
//   2. Codex   — the real `codex app-server` JSON-RPC surface: root-matched
//      initialize, `thread/read` includeTurns:false, production
//      `thread/name/set` and read; a fresh management process readback; a
//      held loaded execution handle that metadata work never steals;
//      wrong-root isolation; a zero-turn prospective start/restart with
//      a pending Freshell rename (no model turn anywhere); and the
//      canonical record's source protection (an externally renamed thread
//      never acquires manual permanence; the writeback's own echo never
//      disturbs the manual record).
//   3. OpenCode — the real `opencode serve` HTTP surface with isolated
//      scratch storage: zero-message POST /session `{}`, production
//      GET/PATCH/GET, the writer event stream's `info.id`, SQLite
//      read-only readback, an owned serve restart, a second same-database
//      management connection, a deliberate database mismatch diagnosed
//      without losing the Freshell name, and the hydrated record's source
//      protection (the serve-observed title ingests as an automatic rank).
//
// Exit codes: 0 only when ALL THREE provider contracts ran and passed;
// 1 for a contract failure (including a missing/skipped provider result —
// there is no skip/opt-in success state); 2 for a missing prerequisite
// (input/runtime/image), reported before any provider work.
//
// Containment: every child process this runner spawns is recorded and
// stopped by exactly that PID; the receipt's `processOwnership` field
// records the owned PIDs per provider leg so the kill scope is auditable
// from the run's own evidence. No broad kill patterns; no npm install,
// package discovery, or dependency upgrade ever happens here; no corpus,
// credentials, or operator home is read. All writes stay under the
// explicit scratch and receipt directories the wrapper mounts.

import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import readline from 'node:readline'

const RUNNER_VERSION = 1

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function argValue(name) {
  const argv = process.argv.slice(2)
  const index = argv.indexOf(name)
  if (index === -1 || index === argv.length - 1) return undefined
  return argv[index + 1]
}

function parseArgs() {
  const args = {
    claudeRoot: argValue('--claude-root'),
    codexRoot: argValue('--codex-root'),
    opencodeRoot: argValue('--opencode-root'),
    runtimeRoot: argValue('--runtime-root'),
    scratch: argValue('--scratch'),
    receipt: argValue('--receipt'),
  }
  const missing = Object.entries(args).filter(([, value]) => !value).map(([key]) => key)
  if (missing.length > 0) {
    throw new Error(`missing required arguments: ${missing.join(', ')}`)
  }
  for (const key of ['claudeRoot', 'codexRoot', 'opencodeRoot', 'runtimeRoot', 'scratch']) {
    args[key] = path.resolve(args[key])
  }
  return args
}

// ---------------------------------------------------------------------------
// Receipt plumbing (structured, mandatory fields per provider)
// ---------------------------------------------------------------------------

class Receipt {
  constructor(receiptPath) {
    this.receiptPath = receiptPath
    this.startedAt = new Date().toISOString()
    this.operations = []
    this.providers = {}
    this.overall = 'pending'
  }

  operation(provider, name, detail) {
    this.operations.push({ provider, name, ...detail })
  }

  fail(provider, message) {
    if (!this.providers[provider]) this.providers[provider] = {}
    this.providers[provider].outcome = 'fail'
    this.providers[provider].failure = message
    this.overall = 'fail'
  }

  write(extra = {}) {
    const document = {
      version: 1,
      runnerVersion: RUNNER_VERSION,
      startedAt: this.startedAt,
      finishedAt: new Date().toISOString(),
      overall: this.overall,
      processOwnership: ownershipSnapshot(),
      operations: this.operations,
      providers: this.providers,
      ...extra,
    }
    fs.mkdirSync(path.dirname(this.receiptPath), { recursive: true })
    fs.writeFileSync(this.receiptPath, `${JSON.stringify(document, null, 2)}\n`)
    return document
  }
}

function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

// ---------------------------------------------------------------------------
// Owned-process plumbing
// ---------------------------------------------------------------------------

/** Every child PID this runner spawned, for owned cleanup. */
const ownedPids = new Set()

/** The same PIDs, attributed per owner leg — the receipt's
 * `processOwnership` field. Ownership is ENFORCED by
 * `stopOwnedProcesses` (exact-PID kills of exactly these children, never a
 * broad pattern); the receipt records WHAT was owned per provider so the
 * kill scope is auditable from the run's own evidence. */
const ownedPidsByOwner = new Map()

function recordOwnedProcess(child, owner = 'unlabeled') {
  if (child.pid) {
    ownedPids.add(child.pid)
    const list = ownedPidsByOwner.get(owner) ?? []
    list.push(child.pid)
    ownedPidsByOwner.set(owner, list)
  }
  return child
}

function ownershipSnapshot() {
  return Object.fromEntries([...ownedPidsByOwner].map(([owner, pids]) => [owner, [...pids]]))
}

/** Automatic-rank name sources (the protocol's `NameSource`:
 * crates/freshell-protocol/src/session_names.rs — rank order `manual >
 * legacy_protected > freshell_ai > provider_ai > first_message >
 * directory`). A native-side name observation must NEVER fold as human
 * intent: `manual` is reachable only through an explicit user rename and
 * `legacy_protected` only through the migration. Both source-protection
 * gates below fail closed on anything outside this set. */
const AUTOMATIC_SOURCE_RANKS = new Set(['freshell_ai', 'provider_ai', 'first_message', 'directory'])

function assertAutomaticNameSource(provider, record, context) {
  if (!AUTOMATIC_SOURCE_RANKS.has(record?.source)) {
    throw new Error(
      `${provider} source protection violated (${context}): the canonical record's source is ${JSON.stringify(record?.source)} — a native-side name must never acquire the permanence of a human rename (record: ${JSON.stringify(record)})`,
    )
  }
}

function stopOwnedProcesses() {
  for (const pid of ownedPids) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      // already gone
    }
  }
  const deadline = Date.now() + 5000
  for (const pid of ownedPids) {
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0)
      } catch {
        break
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
    }
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // already gone
    }
  }
  ownedPids.clear()
}

process.once('SIGTERM', () => {
  stopOwnedProcesses()
  process.exit(1)
})
process.once('SIGINT', () => {
  stopOwnedProcesses()
  process.exit(1)
})
process.once('exit', () => {
  for (const pid of ownedPids) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // already gone
    }
  }
})

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

async function pickFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      server.close(() => resolve(port))
    })
    server.on('error', reject)
  })
}

function withTimeout(promise, ms, what) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms)),
  ])
}

async function pollUntil(describe, fn, timeoutMs, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await fn()
    if (last) return last
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${describe}; last value: ${JSON.stringify(last) ?? 'none'}`)
}

async function fetchJson(url, options = {}, timeoutMs = 20_000) {
  const response = await withTimeout(fetch(url, { signal: AbortSignal.timeout(timeoutMs), ...options }), timeoutMs + 1_000, `fetch ${url}`)
  const body = await response.json().catch(() => null)
  return { status: response.status, ok: response.ok, body }
}

/** Read a package.json version, or null. */
function readPackageVersion(dir, filename = 'package.json') {
  try {
    const raw = fs.readFileSync(path.join(dir, filename), 'utf8')
    return JSON.parse(raw).version ?? null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// The JSON-RPC app-server client (codex, over stdio)
// ---------------------------------------------------------------------------

class CodexAppServer {
  constructor(binary, env, label) {
    this.binary = binary
    this.env = env
    this.label = label
    this.nextId = 1
    this.pending = new Map()
    this.notifications = []
    this.buffer = ''
  }

  async start() {
    this.child = recordOwnedProcess(spawn(this.binary, ['app-server'], {
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    }), 'codex')
    this.child.stdout.on('data', (chunk) => this.onData(chunk))
    // The real CLI's stderr is the only honest diagnostic for a boot
    // failure (its existence checks, auth/config bootstrap errors), and a
    // timeout against a dead process is otherwise unattributable.
    const stderrTail = []
    this.child.stderr.on('data', (chunk) => {
      if (stderrTail.length < 40) stderrTail.push(String(chunk))
      if (process.env.FRESHELL_NATIVE_SMOKE_VERBOSE) {
        process.stderr.write(`[native-session-names] ${this.label} stderr: ${String(chunk).slice(0, 400)}`)
      }
    })
    this.stderrTail = stderrTail
    this.exited = new Promise((resolve) => this.child.once('exit', resolve))
    // The initialize window must cover the REAL CLI's cold boot inside
    // the no-network container (config/telemetry attempts stall to their
    // own timeouts before the handshake answers — observed >20s on the
    // first spawn; warm processes answer in well under a second).
    try {
      this.initializeResult = await this.request(
        'initialize',
        {
          clientInfo: { name: 'freshell-native-contract', version: String(RUNNER_VERSION) },
          capabilities: { experimentalApi: true },
        },
        90_000,
      )
    } catch (error) {
      const tail = (this.stderrTail ?? []).join('').slice(-1_200)
      const exit = await Promise.race([
        this.exited.then((code) => `exit ${code}`),
        new Promise((resolve) => setTimeout(() => resolve('still running'), 2_000)),
      ])
      throw new Error(`${error.message}${tail ? ` (CLI stderr: ${tail})` : ''} (CLI process: ${exit})`)
    }
    this.notify('initialized')
    return this.initializeResult
  }

  onData(chunk) {
    this.buffer += String(chunk)
    let index
    while ((index = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      if (!line) continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      if (message.id !== undefined && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id)
        this.pending.delete(message.id)
        if (message.error) {
          reject(new Error(`JSON-RPC error ${message.error.code}: ${message.error.message}`))
        } else {
          resolve(message.result)
        }
      } else if (message.method !== undefined) {
        this.notifications.push(message)
      }
    }
  }

  request(method, params, timeoutMs = 20_000) {
    const id = this.nextId++
    return withTimeout(new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    }), timeoutMs, `${this.label} ${method}`)
  }

  notify(method) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`)
  }

  /** Best-effort graceful stop of this OWNED process (never a broad kill). */
  stop() {
    try {
      this.child.stdin.end()
    } catch {
      // already closed
    }
    try {
      this.child.kill('SIGTERM')
    } catch {
      // already gone
    }
  }
}

// ---------------------------------------------------------------------------
// The staged Freshell Rust server
// ---------------------------------------------------------------------------

class RustServer {
  constructor(runtimeRoot, scratch, receipt) {
    this.binary = path.join(runtimeRoot, 'bin', 'freshell-server')
    this.scratch = scratch
    this.receipt = receipt
  }

  async start(opts = {}) {
    const port = await pickFreePort()
    const token = `native-contract-${randomUUID()}`
    const home = opts.home ?? serverHomePath()
    fs.mkdirSync(home, { recursive: true })
    fs.mkdirSync(path.join(home, '.freshell'), { recursive: true })
    // Pre-seed the user config exactly like the e2e helper
    // (test/e2e-browser/helpers/unified-agent-names.ts): the
    // `settings.freshAgent.enabled` gate DEFAULTS TO FALSE, and while it is
    // disabled the WS create lane SILENTLY swallows `freshAgent.create`
    // frames (the dispatch gate in terminal.rs checks
    // `state.fresh_codex.is_enabled()` and never answers) — the server-side
    // contracts need the fresh-agent runtime on. Seeding the config file
    // (not POSTing settings after boot) matches the real onboarding path.
    const configPath = path.join(home, '.freshell', 'config.json')
    if (!fs.existsSync(configPath)) {
      fs.writeFileSync(configPath, JSON.stringify({
        version: 1,
        settings: {
          freshAgent: { enabled: true },
        },
      }, null, 2))
    }
    // Register the codex coding-CLI extension in the server home
    // (`<home>/.freshell/extensions/codex/freshell.json` — the real
    // user-level extension discovery path, `extensions.rs`'s
    // `resolve_extension_dirs`): the codex contract's step (7) REST tab
    // create uses `mode: "codex"` (a TERMINAL pane), which requires a
    // registered launch-target manifest. The manifest's
    // `cli.envVar: "CODEX_CMD"` resolves the binary to the container's
    // read-only provider mount (the server env already carries CODEX_CMD) —
    // verbatim copy of the repo's bundled `extensions/codex-cli/freshell.json`
    // (the schema is differential-oracle-proven; do not edit shape).
    const codexExtDir = path.join(home, '.freshell', 'extensions', 'codex')
    fs.mkdirSync(codexExtDir, { recursive: true })
    fs.writeFileSync(path.join(codexExtDir, 'freshell.json'), JSON.stringify({
      name: 'codex',
      version: '1.0.0',
      label: 'Codex CLI',
      description: "OpenAI's Codex CLI agent",
      category: 'cli',
      cli: {
        command: 'codex',
        envVar: 'CODEX_CMD',
        resumeArgs: ['resume', '{{sessionId}}'],
        modelArgs: ['--model', '{{model}}'],
        sandboxArgs: ['--sandbox', '{{sandbox}}'],
        supportsModel: true,
        supportsSandbox: true,
      },
      picker: {
        shortcut: 'X',
        group: 'agents',
      },
    }, null, 2))
    const logsDir = path.join(home, '.freshell', 'logs')
    fs.mkdirSync(logsDir, { recursive: true })
    this.home = home
    this.port = port
    this.token = token
    this.baseUrl = `http://127.0.0.1:${port}`
    // The provider-child environment is built from an ALLOWLIST — scratch
    // HOME/config/data roots and the fixed tool paths; no inherited model
    // credentials or operator config ever reach the server or its children.
    this.env = {
      PATH: '/usr/local/bin:/usr/bin:/bin',
      HOME: home,
      FRESHELL_HOME: home,
      PORT: String(port),
      FRESHELL_BIND_HOST: '127.0.0.1',
      AUTH_TOKEN: token,
      FRESHELL_CLIENT_DIR: path.join(this.runtimeRoot ?? '/opt/freshell-runtime', 'client'),
      FRESHELL_LOG_DIR: logsDir,
      HIDE_STARTUP_TOKEN: 'true',
      NODE_ENV: 'production',
      CLAUDE_CONFIG_DIR: claudeConfigRootPath(this.scratch),
      // The session INDEX resolves the claude root as CLAUDE_HOME else
      // <HOME>/.claude and deliberately NEVER searches CLAUDE_CONFIG_DIR
      // (Node-parity, documented on resolve_claude_exact_id_fallback).
      // Point CLAUDE_HOME at the same config root so the synthetic
      // transcript is both SDK-addressable AND index-visible.
      CLAUDE_HOME: claudeConfigRootPath(this.scratch),
      CODEX_HOME: codexHomePath(),
      CODEX_CMD: this.scratchCodexCmd ?? '/opt/freshell-native/codex/bin/codex',
      ...Object.fromEntries([
        ['XDG_DATA_HOME', opencodeXdgRoots().data],
        ['XDG_CONFIG_HOME', opencodeXdgRoots().configGlobal],
        ['XDG_CACHE_HOME', opencodeXdgRoots().cache],
        ['XDG_STATE_HOME', opencodeXdgRoots().state],
        ['TMPDIR', opencodeXdgRoots().tmp],
      ]),
      OPENCODE_CMD: '/opt/freshell-native/opencode/bin/opencode',
      OPENCODE_LOG_LEVEL: 'WARN',
      FRESHELL_CLAUDE_NODE: path.join(this.runtimeRoot ?? '/opt/freshell-runtime', 'node', 'bin', 'node'),
      FRESHELL_CLAUDE_SIDECAR: path.join(this.runtimeRoot ?? '/opt/freshell-runtime', 'claude-sidecar', 'index.mjs'),
      // The app-bound production env pair (the retire-node-server-v2 plan's
      // spawn-env contract): terminal-mode CLI panes inject Freshell's MCP
      // client (mcp_inject.rs), which resolves this EXPLICIT pair first and
      // falls back to a repo checkout (dist/tools/... or node_modules/tsx)
      // that does not exist in the container — without the pair, the codex
      // TERMINAL create fails with the tsx-resolution error.
      FRESHELL_MCP_NODE: path.join(this.runtimeRoot ?? '/opt/freshell-runtime', 'node', 'bin', 'node'),
      FRESHELL_MCP_ENTRY: path.join(this.runtimeRoot ?? '/opt/freshell-runtime', 'mcp', 'server.js'),
      ...opts.env,
    }
    this.logFile = path.join(logsDir, `native-contract-${port}.log`)
    const logStream = fs.openSync(this.logFile, 'a')
    this.child = recordOwnedProcess(spawn(this.binary, [], {
      env: this.env,
      stdio: ['ignore', logStream, logStream],
      detached: false,
    }), 'server')
    await withTimeout(pollUntil(
      'server health',
      async () => {
        try {
          const { ok, body } = await fetchJson(`${this.baseUrl}/api/health`, {}, 3_000)
          return ok && body?.ok === true
        } catch {
          return false
        }
      },
      60_000,
      200,
    ), 70_000, 'server health')
    return this
  }

  /** Owned stop: exactly this process (its own children are reaped by its
   * graceful shutdown, backstopped by the runner's owned-PID sweep). */
  stop() {
    if (!this.child) return
    try {
      this.child.kill('SIGTERM')
    } catch {
      // already gone
    }
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      try {
        process.kill(this.child.pid, 0)
      } catch {
        break
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
    }
    try {
      this.child.kill('SIGKILL')
    } catch {
      // already gone
    }
  }

  authHeaders() {
    return { 'x-auth-token': this.token, 'content-type': 'application/json' }
  }

  async renameCanonical(target, name, nameIntent) {
    return fetchJson(`${this.baseUrl}/api/session-names`, {
      method: 'PATCH',
      headers: this.authHeaders(),
      body: JSON.stringify({ target, name, ...(nameIntent ? { nameIntent } : {}) }),
    })
  }

  async readNames(refs) {
    const result = await fetchJson(`${this.baseUrl}/api/session-names/read`, {
      method: 'POST',
      headers: this.authHeaders(),
      body: JSON.stringify({ refs }),
    })
    if (!result.ok) throw new Error(`session-names read failed: ${result.status} ${JSON.stringify(result.body)}`)
    return result.body.names ?? []
  }

  async readOne(target) {
    const names = await this.readNames([target])
    return names.find((update) => sameRef(update.record.ref, target) || redirectsTo(update, target)) ?? null
  }

  /** The pane content's naming identity from the server's layout snapshot
   * (the authoritative `nameRef`, falling back to the pre-durable
   * `namingHandle`). */
  async paneNamingRef(tabId, paneId) {
    const content = await this.paneContent(tabId, paneId)
    if (!content) return null
    if (content.nameRef && typeof content.nameRef === 'object') return content.nameRef
    if (typeof content.namingHandle === 'string') return { kind: 'pending', id: content.namingHandle }
    return null
  }

  /** The pane's full content object from the layout snapshot (the naming
   * identity, the createRequestId, the sessionType — everything the real
   * client's pane mount reads to drive the pane's session creation). */
  async paneContent(tabId, paneId) {
    const { ok, body } = await fetchJson(`${this.baseUrl}/api/layout/snapshot?tabId=${encodeURIComponent(tabId)}`, { headers: this.authHeaders() })
    if (!ok) return null
    const findContent = (node) => {
      if (!node || typeof node !== 'object') return null
      if (node.id === paneId && node.content && typeof node.content === 'object') return node.content
      for (const child of node.children ?? []) {
        const found = findContent(child)
        if (found) return found
      }
      return null
    }
    for (const layout of Object.values(body?.data?.layouts ?? {})) {
      const content = findContent(layout)
      if (content) return content
    }
    return null
  }

  /** Wait until the record for `target` reports the wanted nativeSync status. */
  async waitForNativeSync(target, statuses, timeoutMs = 60_000) {
    return pollUntil(
      `nativeSync ${statuses.join('|')} for ${JSON.stringify(target)}`,
      async () => {
        const update = await this.readOne(target)
        if (!update) return null
        if (statuses.includes(update.nativeSync?.status)) return update
        return null
      },
      timeoutMs,
      250,
    )
  }

  /** A raw WS client for the freshAgent.create lane (Node 22's global WebSocket). */
  async wsHello() {
    const ws = new WebSocket(`ws://127.0.0.1:${this.port}/ws`)
    await withTimeout(new Promise((resolve, reject) => {
      ws.once?.('open', resolve)
      ws.addEventListener('open', resolve)
      ws.addEventListener('error', reject)
    }), 15_000, 'ws open')
    const frames = []
    ws.addEventListener('message', (event) => {
      try {
        frames.push(JSON.parse(String(event.data)))
      } catch {
        // ignore non-JSON frames
      }
    })
    // Connection deaths must be visible in the frame dump: a closed or
    // errored socket otherwise looks exactly like "the server never
    // answered" (an unattributable timeout).
    ws.addEventListener('close', (event) => {
      frames.push({ type: '__ws_close', code: event.code, reason: String(event.reason ?? '').slice(0, 200) })
    })
    ws.addEventListener('error', () => {
      frames.push({ type: '__ws_error' })
    })
    ws.send(JSON.stringify({ type: 'hello', token: this.token, protocolVersion: 11 }))
    await withTimeout(new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error('ready frame timeout')), 15_000)
      const check = () => {
        if (frames.some((frame) => frame.type === 'ready')) {
          clearTimeout(deadline)
          resolve()
        } else {
          setTimeout(check, 100)
        }
      }
      check()
    }), 20_000, 'ws ready')
    return { ws, frames }
  }

  async waitForFrame(frames, type, timeoutMs = 30_000) {
    return withTimeout(new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error(`frame ${type} timeout`)), timeoutMs)
      const check = () => {
        const match = frames.find((frame) => frame.type === type)
        if (match) {
          clearTimeout(deadline)
          resolve(match)
        } else {
          setTimeout(check, 100)
        }
      }
      check()
    }), timeoutMs + 1_000, `frame ${type}`)
  }

  /** Wait for the FIRST of several frame types — a create can answer with
   * the success frame OR the refusal envelope (`freshAgent.create.failed`
   * carries the requestId), and waiting for success alone turns a clear
   * server-side refusal into an unattributable 60s timeout. */
  async waitForFrameAny(frames, types, timeoutMs = 30_000) {
    return withTimeout(new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error(`frame ${types.join('|')} timeout`)), timeoutMs)
      const check = () => {
        const match = frames.find((frame) => types.includes(frame.type))
        if (match) {
          clearTimeout(deadline)
          resolve(match)
        } else {
          setTimeout(check, 100)
        }
      }
      check()
    }), timeoutMs + 1_000, `frame ${types.join('|')}`)
  }
}

function sameRef(a, b) {
  return JSON.stringify(refKeyParts(a)) === JSON.stringify(refKeyParts(b))
}

function refKeyParts(ref) {
  if (!ref || typeof ref !== 'object') return null
  if (ref.kind === 'pending') return ['pending', ref.id]
  if (ref.kind === 'session') return ['session', ref.provider, ref.sessionId]
  return null
}

function redirectsTo(update, target) {
  return (update.redirects ?? []).some((redirect) => sameRef(redirect.from, target))
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

function preflight(args) {
  const problems = []
  const required = [
    ['claude distribution', path.join(args.claudeRoot, 'bin'), (p) => fs.existsSync(p)],
    ['codex metadata core', path.join(args.codexRoot, 'bin', 'codex'), (p) => fs.existsSync(p)],
    ['codex layout manifest', path.join(args.codexRoot, 'codex-package.json'), (p) => fs.existsSync(p)],
    ['opencode distribution', path.join(args.opencodeRoot, 'bin', 'opencode'), (p) => fs.existsSync(p)],
    ['staged rust server', path.join(args.runtimeRoot, 'bin', 'freshell-server'), (p) => fs.existsSync(p)],
    ['staged client', path.join(args.runtimeRoot, 'client', 'index.html'), (p) => fs.existsSync(p)],
    ['staged node', path.join(args.runtimeRoot, 'node', 'bin', 'node'), (p) => fs.existsSync(p)],
    ['staged claude helper', path.join(args.runtimeRoot, 'claude-sidecar', 'session-names.mjs'), (p) => fs.existsSync(p)],
    ['staged claude SDK', path.join(args.runtimeRoot, 'claude-sidecar', 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json'), (p) => fs.existsSync(p)],
  ]
  const observed = {}
  for (const [name, target, exists] of required) {
    if (!exists(target)) {
      problems.push(`missing ${name}: ${target}`)
    }
  }
  const versions = {
    installedClaudeCli: readPackageVersion(args.claudeRoot),
    // The staged codex input carries its version in the vendor tree's
    // `codex-package.json` (the wrapper's declared versionFile) — the
    // vendored musl dir ships no `package.json`.
    codex: readPackageVersion(args.codexRoot, 'codex-package.json'),
    opencode: readPackageVersion(args.opencodeRoot),
    stagedClaudeSdk: (() => {
      try {
        return JSON.parse(fs.readFileSync(path.join(args.runtimeRoot, 'claude-sidecar', 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json'), 'utf8')).version ?? null
      } catch {
        return null
      }
    })(),
  }
  for (const [key, value] of Object.entries(versions)) {
    if (value === null) problems.push(`could not read version: ${key}`)
  }
  observed.versions = versions
  const hashes = {}
  for (const [name, file] of [
    ['codexBinary', path.join(args.codexRoot, 'bin', 'codex')],
    ['opencodeBinary', path.join(args.opencodeRoot, 'bin', 'opencode')],
    ['stagedServer', path.join(args.runtimeRoot, 'bin', 'freshell-server')],
  ]) {
    try {
      hashes[name] = sha256File(file)
    } catch {
      problems.push(`could not hash ${name}`)
    }
  }
  observed.hashes = hashes
  return { problems, observed }
}

// ---------------------------------------------------------------------------
// Claude contract
// ---------------------------------------------------------------------------

function mangleClaudeProject(cwd) {
  return String(cwd).replace(/[^A-Za-z0-9]/g, '-')
}

/** The claude config root, on the CONTAINER's own filesystem (never the
 * 9p scratch bind): the server's session watcher indexes new transcripts
 * through inotify, and inotify does not fire across the bind — a root on
 * the bind means the 'claude session indexed' poll can never succeed. */
function claudeConfigRootPath(scratch) {
  return path.join('/tmp', 'native-claude-config-root')
}

/** The codex CODEX_HOME, on the CONTAINER's own filesystem: the real CLI
 * is a static musl binary whose filesystem probes against the 9p scratch
 * bind fail (its boot check answers "path does not exist" even when the
 * node-spawned runner just created it), so its home — and the server's
 * matching CODEX_HOME — must live on overlayfs. */
function codexHomePath() {
  // Under the CONTAINER USER's home (overlayfs — the static-musl CLI's
  // probes can see it) and NOT under /tmp: the CLI refuses to create its
  // helper binaries under a temporary dir ("Refusing to create helper
  // binaries under temporary dir /tmp"), so /tmp homes are rejected by
  // its own policy.
  return path.join('/home/sandbox', '.native-smoke', 'codex-home')
}

/** The opencode XDG roots, same rationale as [`codexHomePath`]. */
function opencodeXdgRoots() {
  const base = path.join('/home/sandbox', '.native-smoke', 'opencode')
  return {
    data: path.join(base, 'data'),
    configGlobal: path.join(base, 'config-global'),
    cache: path.join(base, 'cache'),
    state: path.join(base, 'state'),
    tmp: path.join(base, 'tmp'),
  }
}

/** The staged server's HOME, on the CONTAINER's own filesystem: the
 * server's codex sidecar inherits HOME from the server env and does
 * HOME-scoped I/O at boot, and on the 9p scratch bind the inode cache
 * serves stale bytes — an incoherent HOME is a silent-boot-hang candidate
 * (the CLI's own boot probes there). Container-local ALSO moves the
 * server's JSONL logs (`<home>/.freshell/logs`) onto coherent overlayfs
 * so failure diagnostics read what the server actually wrote. */
function serverHomePath() {
  return path.join('/home/sandbox', '.native-smoke', 'server-home')
}

/** The codex contract's project directory, same rationale as
 * [`codexHomePath`]: the freshcodex sidecar process STARTS with this as
 * its cwd (`Command::current_dir`), and the static-musl CLI's probes
 * against the 9p bind are unreliable. The A–F CLI connections boot
 * without an explicit cwd (container-local) — the sidecar must not be the
 * only codex process whose cwd sits on the bind. */
function codexProjectPath() {
  return path.join('/home/sandbox', '.native-smoke', 'codex-proj')
}

async function runClaudeHelper(args, request, claudeConfigRoot) {
  const helper = path.join(args.runtimeRoot, 'claude-sidecar', 'session-names.mjs')
  const node = path.join(args.runtimeRoot, 'node', 'bin', 'node')
  const child = recordOwnedProcess(spawn(node, [helper], {
    env: {
      PATH: '/usr/local/bin:/usr/bin:/bin',
      HOME: path.join(args.scratch, 'claude', 'home'),
      CLAUDE_CONFIG_DIR: claudeConfigRoot,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  }), 'claude')
  // A wedged helper is diagnosable from its kernel wait channel: a silent
  // timeout with zero stdout AND zero stderr must still answer WHERE the
  // process sits (uninterruptible 9p I/O, a lock wait, a stopped state),
  // or the failure is unattributable.
  const procStateOf = () => {
    if (!child.pid) return '(no pid)'
    try {
      const state = fs.readFileSync(`/proc/${child.pid}/status`, 'utf8')
      const wchan = fs.readFileSync(`/proc/${child.pid}/wchan`, 'utf8').trim()
      const stateLine = state.split('\n').find((l) => l.startsWith('State:')) ?? ''
      const threads = state.split('\n').find((l) => l.startsWith('Threads:')) ?? ''
      return `state=${stateLine} wchan=${wchan} ${threads}`
    } catch (error) {
      return `(unreadable: ${error.code ?? error.message})`
    }
  }
  const stdout = []
  const stderrTail = []
  child.stdout.on('data', (chunk) => stdout.push(String(chunk)))
  child.stderr.on('data', (chunk) => {
    if (stderrTail.length < 40) stderrTail.push(String(chunk))
    if (process.env.FRESHELL_NATIVE_SMOKE_VERBOSE) {
      process.stderr.write(`[native-session-names] helper stderr: ${String(chunk).slice(0, 400)}`)
    }
  })
  // The answer window must cover the container's COLD first-import of the
  // staged node binary + the Claude SDK tree over the read-only 9p mount
  // (observed >25s under host load on the first-ever exec; warm runs answer
  // in milliseconds). 90s leaves real headroom without masking a genuine
  // helper wedge (the ops that follow still fail loudly on their own).
  // Register the answer listeners FIRST, WRITE THE REQUEST, and only then
  // await: awaiting before the write is a self-deadlock (the helper idles
  // in ep_poll waiting for stdin while the runner waits for stdout — the
  // request would only be written after the answer window expired). This
  // path was never exercised end-to-end until the container prerequisites
  // passed (the glibc-2.38 image rebase), and the first real run exposed
  // the inversion (state=S wchan=ep_poll at the 90s timeout).
  const answerPromise = new Promise((resolve, reject) => {
    let buffer = ''
    child.stdout.on('data', (chunk) => {
      buffer += String(chunk)
      const newline = buffer.indexOf('\n')
      if (newline !== -1) {
        resolve(buffer.slice(0, newline))
      }
    })
    child.once('exit', () => reject(new Error(`helper exited before answering: ${buffer}`)))
    child.once('error', reject)
  })
  try {
    child.stdin.write(`${JSON.stringify(request)}\n`)
  } catch (error) {
    throw new Error(`helper stdin write failed: ${error.message}`)
  }
  const answer = await withTimeout(answerPromise, 90_000, 'claude helper answer')
    .catch((error) => {
      // An answer failure must carry the helper's own stderr + its
      // kernel wait state — the only honest way to distinguish a wedged
      // import (uninterruptible 9p I/O, a lock wait, a stopped state)
      // from an environment failure inside the staged sidecar. This
      // outer catch sees BOTH the timeout rejection and the inner
      // failure path.
      const tail = stderrTail.join('').slice(-1_200)
      throw new Error(`${error.message}${tail ? ` (helper stderr: ${tail})` : ''} (helper proc: ${procStateOf()})`)
    })
  const parsed = JSON.parse(answer)
  try {
    child.stdin.end()
    child.kill('SIGTERM')
  } catch {
    // already gone
  }
  return parsed
}

async function claudeContract(args, server, receipt, observed) {
  const provider = 'claude'
  const result = {
    persistence: 'fail',
    freshReadback: 'fail',
    sourceProtection: 'fail',
    liveRedraw: 'not_measured',
    outcome: 'fail',
    versions: {},
    route: null,
    operations: [],
  }
  receipt.providers[provider] = result
  try {
    const claudeScratch = path.join(args.scratch, 'claude')
    const configRoot = claudeConfigRootPath(args.scratch)
    const projectDir = path.join(claudeScratch, 'proj')
    fs.mkdirSync(projectDir, { recursive: true })
    const sessionId = randomUUID()
    const messageUuid = randomUUID()
    const transcriptRel = path.join('projects', mangleClaudeProject(projectDir), `${sessionId}.jsonl`)
    const transcriptPath = path.join(configRoot, transcriptRel)
    fs.mkdirSync(path.dirname(transcriptPath), { recursive: true })
    const firstMessage = 'Probe the sardine factory'
    // TWO user-authored records: the session directory's parity filter
    // hides a single-turn transcript (`user_message_count <= 1` is
    // non-interactive) — the same rule the e2e journeys model with a
    // second turn. Without the second record the 'indexed' poll below
    // can never see the session.
    fs.writeFileSync(transcriptPath, `${JSON.stringify({
      parentUuid: null,
      isSidechain: false,
      type: 'user',
      uuid: messageUuid,
      sessionId,
      timestamp: '2026-09-18T07:00:00.000Z',
      cwd: projectDir,
      message: { role: 'user', content: firstMessage },
    })}\n${JSON.stringify({
      parentUuid: messageUuid,
      isSidechain: false,
      type: 'user',
      uuid: randomUUID(),
      sessionId,
      timestamp: '2026-09-18T07:00:01.000Z',
      cwd: projectDir,
      message: { role: 'user', content: 'The sardine factory ran all night' },
    })}\n`)
    result.route = {
      configRoot,
      project: projectDir,
      transcript: `${configRoot}/${transcriptRel.split(path.sep).join('/')}`,
      sessionId,
    }
    result.versions = {
      installedClaudeCli: observed.versions.installedClaudeCli,
      stagedClaudeSdk: observed.versions.stagedClaudeSdk,
    }

    // (1) Direct helper read: the synthetic ordinary user record is readable
    // by the real SDK, with no custom title yet.
    const read1 = await runClaudeHelper(args, { op: 'read', sessionId, dir: projectDir }, configRoot)
    if (!read1.ok) throw new Error(`helper read failed: ${JSON.stringify(read1)}`)
    if (read1.customTitle !== null) throw new Error(`expected no customTitle, got ${read1.customTitle}`)
    if (read1.firstPrompt !== firstMessage) throw new Error(`firstPrompt mismatch: ${read1.firstPrompt}`)
    result.operations.push('helper:read')

    // (2) Direct helper rename + fresh-process readback (real SDK).
    const rename1 = await runClaudeHelper(args, { op: 'rename', sessionId, title: 'Claude native probe name', dir: projectDir }, configRoot)
    if (!rename1.ok) throw new Error(`helper rename failed: ${JSON.stringify(rename1)}`)
    result.operations.push('helper:rename')
    const read2 = await runClaudeHelper(args, { op: 'read', sessionId, dir: projectDir }, configRoot)
    if (!read2.ok || read2.customTitle !== 'Claude native probe name') {
      throw new Error(`fresh helper readback mismatch: ${JSON.stringify(read2)}`)
    }
    result.freshReadback = 'pass'
    result.persistence = 'pass'
    result.operations.push('helper:freshReadback')

    // (3) Non-target session under a second project: a byte-identical
    // duplicate of the PRE-rename content carrying a DIFFERENT session id
    // (a genuinely other session). Selected-root targeting must leave it
    // untouched. A same-id copy here would trip the native lane's own
    // ambiguity guard (correctly, by step (9)'s own standard) and make
    // the writeback in (4) permanently `unsupported` — the original
    // same-id design was self-contradictory.
    const otherProject = path.join(claudeScratch, 'other-proj')
    fs.mkdirSync(otherProject, { recursive: true })
    const nonTargetSessionId = randomUUID()
    const nonTargetPath = path.join(configRoot, 'projects', mangleClaudeProject(otherProject), `${nonTargetSessionId}.jsonl`)
    fs.mkdirSync(path.dirname(nonTargetPath), { recursive: true })
    fs.writeFileSync(nonTargetPath, fs.readFileSync(transcriptPath, 'utf8').replaceAll(sessionId, nonTargetSessionId))
    const nonTargetBefore = sha256File(nonTargetPath)

    // (4) Through the Rust rename route: the server's index adopts the
    // transcript, the canonical rename lands with user intent, and the
    // native worker writes back through the same staged helper.
    const target = { kind: 'session', provider: 'claude', sessionId }
    try {
      await pollUntil(
        'claude session indexed',
        async () => {
          const { body } = await fetchJson(`${server.baseUrl}/api/session-directory?priority=visible&limit=50`, { headers: server.authHeaders() })
          return (body?.items ?? []).some((item) => item.provider === 'claude' && item.sessionId === sessionId)
        },
        // The scratch is a 9p bind — inotify does not fire on it, so the
        // ONLY discovery path is the watcher's 60s rearm tick (its
        // watch-set replan scans the disk). The window must span at least
        // two ticks (a first tick can race the transcript's debounce).
        150_000,
      )
    } catch (error) {
      // Diagnose whether the server sees the transcript AT ALL (the raw
      // sessions list) versus only the directory's parity/priority filters
      // hiding it — the fix differs entirely between the two.
      let rawSees = 'unknown'
      let directoryUnfilteredSees = 'unknown'
      try {
        const { body } = await fetchJson(`${server.baseUrl}/api/sessions`, { headers: server.authHeaders() })
        rawSees = JSON.stringify(body).includes(sessionId)
      } catch { /* the raw list may be unavailable */ }
      try {
        const { body } = await fetchJson(`${server.baseUrl}/api/session-directory?limit=200`, { headers: server.authHeaders() })
        directoryUnfilteredSees = (body?.items ?? []).some((item) => item.provider === 'claude' && item.sessionId === sessionId)
      } catch { /* the unfiltered directory may be unavailable */ }
      throw new Error(`${error.message}; raw /api/sessions contains the session: ${rawSees}; unfiltered session-directory contains it: ${directoryUnfilteredSees}`)
    }
    result.operations.push('server:indexAdopted')
    // The canonical rename needs the naming RECORD, and the record is
    // created by the auto-title sweep's hydration of the just-indexed
    // transcript (the authority never creates records from a rename) —
    // poll for the hydrated record first, or the rename 404s the race.
    await pollUntil(
      'claude naming record hydrated',
      async () => (await server.readOne(target)) !== null,
      150_000,
    )
    result.operations.push('server:namingRecordHydrated')
    const manualName = 'Native manual name'
    const renameRoute = await server.renameCanonical(target, manualName, 'user')
    if (!renameRoute.ok) throw new Error(`canonical rename failed: ${renameRoute.status} ${JSON.stringify(renameRoute.body)}`)
    if (renameRoute.body?.record?.name !== manualName || renameRoute.body?.record?.source !== 'manual') {
      throw new Error(`canonical rename answer mismatch: ${JSON.stringify(renameRoute.body)}`)
    }
    result.operations.push('server:rename:user')
    const synced = await server.waitForNativeSync(target, ['synced'], 90_000)
    result.operations.push('server:nativeWriteback:synced')
    if (synced.record.name !== manualName || synced.record.source !== 'manual') {
      throw new Error(`post-writeback canonical record mismatch: ${JSON.stringify(synced.record)}`)
    }
    result.sourceProtection = 'pass'
    result.nativeValue = synced.nativeSync

    // (5) Own-echo protection: the writeback appended a custom-title record;
    // the ingestion lane folds it as an automatic own-write echo and the
    // canonical record keeps the manual source and name. Give the ingestion
    // lane a bounded window, then assert.
    await new Promise((resolve) => setTimeout(resolve, 2_000))
    const echoRecord = await server.readOne(target)
    if (echoRecord.record.name !== manualName || echoRecord.record.source !== 'manual') {
      throw new Error(`own-echo protection failed: ${JSON.stringify(echoRecord.record)}`)
    }
    result.operations.push('server:ownEchoProtection')

    // (6) Fresh helper readback of the SERVER-written name.
    const read3 = await runClaudeHelper(args, { op: 'read', sessionId, dir: projectDir }, configRoot)
    if (!read3.ok || read3.customTitle !== manualName) {
      throw new Error(`server writeback helper readback mismatch: ${JSON.stringify(read3)}`)
    }
    result.operations.push('helper:serverWritebackReadback')

    // (7) The short generated-title value (Freshell AI style) is accepted
    // without changing the metadata shape: every transcript line still
    // parses as JSON, and the original records are intact.
    const shortName = 'Sardine fix'
    const renameRoute2 = await server.renameCanonical(target, shortName, 'automatic')
    if (!renameRoute2.ok) throw new Error(`automatic rename failed: ${renameRoute2.status}`)
    await server.waitForNativeSync(target, ['synced'], 90_000)
    const lines = fs.readFileSync(transcriptPath, 'utf8').split('\n').filter((line) => line.trim().length > 0)
    for (const [index, line] of lines.entries()) {
      try {
        JSON.parse(line)
      } catch (error) {
        throw new Error(`transcript line ${index + 1} is no longer JSON after the short-name writeback: ${error.message}`)
      }
    }
    const firstLine = JSON.parse(lines[0])
    if (firstLine.type !== 'user' || firstLine.uuid !== messageUuid) {
      throw new Error(`the original user record was rewritten: ${lines[0]}`)
    }
    result.operations.push('server:shortNameWriteback:shapePreserved')

    // (8) Selected-root targeting: the non-target copy is untouched and no
    // duplicate canonical session was admitted.
    if (sha256File(nonTargetPath) !== nonTargetBefore) {
      throw new Error('the non-target duplicate copy was modified by a selected-root rename')
    }
    const directory = await fetchJson(`${server.baseUrl}/api/session-directory?priority=visible&limit=50`, { headers: server.authHeaders() })
    const matching = (directory.body?.items ?? []).filter((item) => item.provider === 'claude' && item.sessionId === sessionId)
    if (matching.length > 1) {
      throw new Error(`duplicate canonical sessions admitted: ${matching.length} rows for ${sessionId}`)
    }
    result.operations.push('server:nonTargetUntouched')

    // (9) Ambiguous copies are not writable: a same-id copy with a
    // different signature must make the helper refuse the rename. The
    // copy must live at a FILENAME matching the session id (the SDK
    // resolves by file name, never by content) — its own path, never the
    // step-(3) non-target session's file.
    const ambiguousCopy = fs.readFileSync(transcriptPath, 'utf8') + `${JSON.stringify({ type: 'user', uuid: randomUUID(), parentUuid: messageUuid, sessionId, timestamp: '2026-09-18T07:05:00.000Z', cwd: otherProject, message: { role: 'user', content: 'divergent copy' } })}\n`
    const ambiguousPath = path.join(configRoot, 'projects', mangleClaudeProject(otherProject), `${sessionId}.jsonl`)
    fs.writeFileSync(ambiguousPath, ambiguousCopy)
    const ambiguous = await runClaudeHelper(args, { op: 'rename', sessionId, title: 'Must refuse', dir: projectDir }, configRoot)
    if (ambiguous.ok || ambiguous.class !== 'ambiguous') {
      throw new Error(`ambiguous copies must not be writable: ${JSON.stringify(ambiguous)}`)
    }
    result.operations.push('helper:ambiguousCopyRefused')

    result.outcome = 'pass'
    receipt.operation(provider, 'contract', { outcome: 'pass', nativeValue: result.nativeValue })
  } catch (error) {
    result.outcome = 'fail'
    result.failure = error.message
    receipt.operation(provider, 'contract', { outcome: 'fail', failure: error.message })
    throw error
  }
}

// ---------------------------------------------------------------------------
// Codex contract
// ---------------------------------------------------------------------------

function codexRolloutLines(input) {
  const { threadId, cwd, preview, timestamp, paginated } = input
  const meta = {
    session_id: threadId,
    id: threadId,
    timestamp,
    cwd,
    originator: 'codex',
    cli_version: '0.0.0',
    source: 'cli',
  }
  if (paginated) meta.history_mode = 'paginated'
  const lines = [
    { timestamp, type: 'session_meta', payload: meta },
    { timestamp, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: preview }] } },
    { timestamp, type: 'event_msg', payload: { type: 'user_message', message: preview, kind: 'plain' } },
  ]
  return lines.map((line, ordinal) => (input.paginated ? JSON.stringify({ ...line, ordinal }) : JSON.stringify(line))).join('\n') + '\n'
}

function rolloutPath(codexHome, threadId) {
  return path.join(codexHome, 'sessions', '2026', '09', '18', `rollout-2026-09-18T08-00-00-${threadId}.jsonl`)
}

function codexChildEnv(codexHome, extra = {}) {
  return {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    HOME: path.join(codexHome, '..'),
    CODEX_HOME: codexHome,
    ...extra,
  }
}

async function codexContract(args, server, receipt, observed) {
  const provider = 'codex'
  const result = {
    persistence: 'fail',
    freshReadback: 'fail',
    sourceProtection: 'fail',
    leaseSafety: 'fail',
    liveRedraw: 'not_measured',
    outcome: 'fail',
    versions: { codex: observed.versions.codex },
    route: null,
    operations: [],
  }
  receipt.providers[provider] = result
  let connectionA = null
  let connectionE = null
  let initE = null
  try {
    const home = codexHomePath()
    // The wrong-root twin lives under its OWN parent: codexChildEnv derives
    // HOME from the codex home's parent, and a shared parent means both
    // CLI instances collide on the same HOME-scoped state (the CLI's PATH
    // aliases/config bootstrap) — the second instance's initialize hangs
    // silently against the first's state.
    const homeB = path.join(path.dirname(codexHomePath()), 'b', path.basename(codexHomePath()))
    // Container-local (see [`codexProjectPath`]): the freshcodex sidecar
    // process STARTS here (`Command::current_dir`), and the rollout
    // records seeded below carry it as their cwd field — one source of
    // truth for the CLI boots, the sidecar, and the index.
    const projectDir = codexProjectPath()
    // The real CLI REFUSES to boot when CODEX_HOME does not exist, and its
    // static-musl filesystem probes cannot see the 9p scratch bind anyway
    // — the container-local root is pre-created before the server boots
    // (main), and the wrong-root twin here for the lease-safety leg.
    fs.mkdirSync(home, { recursive: true })
    fs.mkdirSync(homeB, { recursive: true })
    fs.mkdirSync(projectDir, { recursive: true })
    const binary = path.join(args.codexRoot, 'bin', 'codex')

    const legacyId = '44444444-5555-4666-8777-888888888888'
    const paginatedId = '44444444-5555-4666-8777-999999999999'
    fs.mkdirSync(path.dirname(rolloutPath(home, legacyId)), { recursive: true })
    fs.writeFileSync(rolloutPath(home, legacyId), codexRolloutLines({ threadId: legacyId, cwd: projectDir, preview: 'Legacy layout probe', timestamp: '2026-09-18T08:00:00.000Z', paginated: false }))
    fs.writeFileSync(rolloutPath(home, paginatedId), codexRolloutLines({ threadId: paginatedId, cwd: projectDir, preview: 'Paginated layout probe', timestamp: '2026-09-18T08:00:00.000Z', paginated: true }))
    // Wrong-root isolation: the SAME thread id exists in a second scratch root.
    fs.mkdirSync(path.dirname(rolloutPath(homeB, legacyId)), { recursive: true })
    fs.writeFileSync(rolloutPath(homeB, legacyId), codexRolloutLines({ threadId: legacyId, cwd: projectDir, preview: 'Other root copy', timestamp: '2026-09-18T08:00:00.000Z', paginated: false }))
    const wrongRootBefore = sha256File(rolloutPath(homeB, legacyId))
    result.route = {
      codexHome: home,
      wrongRoot: homeB,
      legacyThread: legacyId,
      paginatedThread: paginatedId,
    }

    // (1) Root-matched initialize + thread/read + production name/set + read.
    connectionA = new CodexAppServer(binary, codexChildEnv(home), 'codex-A')
    const initialize = await connectionA.start()
    if (initialize.codexHome !== home) {
      throw new Error(`root-mismatch: initialize answered ${initialize.codexHome}, expected ${home}`)
    }
    result.initialize = { codexHome: initialize.codexHome, userAgent: initialize.userAgent }
    result.operations.push('appServer:initialize:rootMatched')

    // (5) The wrong-root connection BOOTS EARLY (right after the first):
    // booting it late — as the fifth live instance, after the lease legs —
    // reproducibly hangs its initialize in the no-network container
    // (observed: silent, process alive, >90s; the same CLI answers in
    // ~230ms when booted early or in isolation). The OBSERVATION still
    // happens at step (5), after A's renames.
    connectionE = new CodexAppServer(binary, codexChildEnv(homeB), 'codex-E')
    initE = await connectionE.start()
    if (initE.codexHome !== homeB) {
      throw new Error(`wrong-root connection initialized elsewhere: ${initE.codexHome}`)
    }

    const legacyRead1 = await connectionA.request('thread/read', { threadId: legacyId, includeTurns: false })
    if (legacyRead1?.thread?.id !== legacyId || legacyRead1?.thread?.status?.type !== 'notLoaded') {
      throw new Error(`legacy thread/read mismatch: ${JSON.stringify(legacyRead1)}`)
    }
    if (legacyRead1?.thread?.preview !== 'Legacy layout probe') {
      throw new Error(`legacy preview mismatch: ${JSON.stringify(legacyRead1?.thread)}`)
    }
    result.operations.push('appServer:threadRead:legacy')

    const paginatedRead1 = await connectionA.request('thread/read', { threadId: paginatedId, includeTurns: false })
    if (paginatedRead1?.thread?.historyMode !== 'paginated') {
      throw new Error(`paginated thread/read mismatch: ${JSON.stringify(paginatedRead1?.thread)}`)
    }
    result.operations.push('appServer:threadRead:paginated')

    const nativeName = 'Native codex name'
    await connectionA.request('thread/name/set', { threadId: legacyId, name: nativeName })
    const legacyRead2 = await connectionA.request('thread/read', { threadId: legacyId, includeTurns: false })
    if (legacyRead2?.thread?.name !== nativeName) {
      throw new Error(`name/set did not persist: ${JSON.stringify(legacyRead2?.thread)}`)
    }
    result.persistence = 'pass'
    result.operations.push('appServer:nameSet:persisted')
    await connectionA.request('thread/name/set', { threadId: paginatedId, name: 'Paginated native name' })
    const paginatedRead2 = await connectionA.request('thread/read', { threadId: paginatedId, includeTurns: false })
    if (paginatedRead2?.thread?.name !== 'Paginated native name') {
      throw new Error(`paginated name/set did not persist: ${JSON.stringify(paginatedRead2?.thread)}`)
    }
    result.operations.push('appServer:nameSet:paginated')

    // (2) Prospective start: thread/start's returned path must NOT exist on
    // disk (never treat a prospective start as closed persistence proof).
    const started = await connectionA.request('thread/start', { cwd: projectDir })
    const prospectiveId = started?.thread?.id
    const prospectivePath = started?.thread?.path
    if (!prospectiveId || !prospectivePath) {
      throw new Error(`thread/start did not return id/path: ${JSON.stringify(started)}`)
    }
    if (fs.existsSync(prospectivePath)) {
      throw new Error(`thread/start returned a path that already exists: ${prospectivePath}`)
    }
    result.prospectiveStart = { threadId: prospectiveId, path: prospectivePath, persistedAtStart: false }
    result.operations.push('appServer:threadStart:prospective')

    // (3) Close the management process; a FRESH process reads the name back.
    connectionA.stop()
    await connectionA.exited
    const connectionB = new CodexAppServer(binary, codexChildEnv(home), 'codex-B')
    const initB = await connectionB.start()
    if (initB.codexHome !== home) throw new Error('fresh process root mismatch')
    const freshRead = await connectionB.request('thread/read', { threadId: legacyId, includeTurns: false })
    if (freshRead?.thread?.name !== nativeName) {
      throw new Error(`fresh management process lost the name: ${JSON.stringify(freshRead?.thread)}`)
    }
    result.freshReadback = 'pass'
    result.operations.push('appServer:freshProcessReadback')
    // B's role is done: stop it so the live-instance count stays low — a
    // fifth live CLI boot reproducibly hangs its initialize in the
    // no-network container (each stopped instance frees the budget).
    connectionB.stop()
    await connectionB.exited

    // (4) Execution-handle lease: resume the thread on connection C (owned
    // test setup, no turn); metadata work through connection D must never
    // steal or claim it.
    const connectionC = new CodexAppServer(binary, codexChildEnv(home), 'codex-C')
    await connectionC.start()
    await connectionC.request('thread/resume', { threadId: legacyId })
    const loadedOnC = await connectionC.request('thread/loaded/list', {})
    if (!(loadedOnC?.data ?? []).includes(legacyId)) {
      throw new Error(`thread/resume did not load the thread on connection C: ${JSON.stringify(loadedOnC)}`)
    }
    result.operations.push('appServer:resume:loadedHandle')
    const connectionD = new CodexAppServer(binary, codexChildEnv(home), 'codex-D')
    await connectionD.start()
    const leaseSafeName = 'Lease-safe rename'
    await connectionD.request('thread/name/set', { threadId: legacyId, name: leaseSafeName })
    const viaD = await connectionD.request('thread/read', { threadId: legacyId, includeTurns: false })
    if (viaD?.thread?.name !== leaseSafeName) throw new Error('management rename via D did not persist')
    const loadedOnD = await connectionD.request('thread/loaded/list', {})
    if ((loadedOnD?.data ?? []).includes(legacyId)) {
      throw new Error(`management connection D loaded/resumed the thread: ${JSON.stringify(loadedOnD)}`)
    }
    const stillLoadedOnC = await connectionC.request('thread/loaded/list', {})
    if (!(stillLoadedOnC?.data ?? []).includes(legacyId)) {
      throw new Error('the original execution owner lost the loaded handle')
    }
    const readViaC = await connectionC.request('thread/read', { threadId: legacyId, includeTurns: false })
    if (readViaC?.thread?.name !== leaseSafeName) throw new Error('the loaded handle did not observe the rename')
    result.leaseSafety = 'pass'
    result.operations.push('appServer:leaseSafety')

    // (5) Wrong-root isolation: renaming via root A leaves root B untouched.
    // (The connection booted early — see step (1); this is the observation.)
    const viaE = await connectionE.request('thread/read', { threadId: legacyId, includeTurns: false })
    if (viaE?.thread?.name === leaseSafeName) {
      throw new Error('the wrong-root connection observed root A\'s name — roots are not isolated')
    }
    connectionE.stop()
    await connectionE.exited
    if (sha256File(rolloutPath(homeB, legacyId)) !== wrongRootBefore) {
      throw new Error('wrong-root rollout file was modified by root A\'s rename')
    }
    result.operations.push('appServer:wrongRootIsolation')

    // (6) Server-side writeback through a live root-matched freshcodex
    // connection: the runner speaks the real WS protocol to create a
    // freshcodex session, whose sidecar is a live app-server connection with
    // the matching initialized root. Stop the remaining CLI connections
    // FIRST: the server's own freshcodex sidecar is another live CLI
    // instance, and the container's fifth-live-boot hang (see step (1))
    // would otherwise hit the SERVER's created frame.
    connectionC.stop()
    await connectionC.exited
    connectionD.stop()
    await connectionD.exited
    const { ws, frames } = await server.wsHello()
    const requestId = randomUUID()
    // The REAL client's frame shape (FreshAgentView.tsx:1246): the pane's
    // pre-durable `namingHandle` is always present, and resuming an existing
    // thread rides the provider-matched `sessionRef` (the raw-layer
    // `resumeSessionId` is refused). The resume + handle are also what make
    // the native writeback POSSIBLE: the pending→durable bind
    // (`try_bind_pending_naming`) transfers the VERIFIED codex location
    // (codexHome + thread id) onto the legacy record — the codex adapter is
    // live-connection-only BY DESIGN (never the cold snapshot, never a
    // lease), so a plain create of a NEW thread leaves the legacy record
    // with NO location (locationRevision 0) and its writeback stays
    // pending forever (observed end-to-end in this container).
    const namingHandle = `pane-${randomUUID()}`
    ws.send(JSON.stringify({
      type: 'freshAgent.create',
      requestId,
      sessionType: 'freshcodex',
      provider: 'codex',
      cwd: projectDir,
      sessionRef: { provider: 'codex', sessionId: legacyId },
      namingHandle,
    }))
    // A refusal is a first-class answer: `freshAgent.create.failed`
    // (spawn budget exceeded, root mismatch, validation) carries the
    // reason, and a bare success-only wait would mask it behind a timeout.
    // Every frame seen so far rides the error message — the silent-drop
    // (typed-parse rejection) case is distinguishable from a hang by the
    // empty frame list. 75s covers the sidecar's 45s startup budget plus
    // retry/teardown overhead with margin.
    const summarizeFrames = () => JSON.stringify(frames.map((frame) => {
      const summary = { type: frame.type }
      if (frame.code) summary.code = frame.code
      const message = frame.message ?? frame.error?.message
      if (message) summary.message = String(message).slice(0, 300)
      if (frame.requestId) summary.requestId = frame.requestId
      if (frame.reason) summary.reason = frame.reason
      return summary
    }))
    let createdFrame
    try {
      createdFrame = await server.waitForFrameAny(frames, ['freshAgent.created', 'freshAgent.create.failed', 'freshAgent.error', 'error'], 75_000)
      if (createdFrame.type !== 'freshAgent.created') {
        throw new Error(`freshAgent.create refused: ${summarizeFrames()}`)
      }
      if (createdFrame.sessionId !== legacyId) {
        throw new Error(`the resume-create must preserve the thread id verbatim: got ${createdFrame.sessionId}, requested ${legacyId}`)
      }
    } catch (error) {
      throw new Error(`${error.message}${frames.length > 0 ? `; frames so far: ${summarizeFrames()}` : '; NO frames received (silent drop or dead socket)'}`)
    }
    result.freshCodexSession = createdFrame.sessionId
    const codexTarget = { kind: 'session', provider: 'codex', sessionId: legacyId }
    await pollUntil(
      'codex rollout indexed',
      async () => {
        const { body } = await fetchJson(`${server.baseUrl}/api/session-directory?priority=visible&limit=50`, { headers: server.authHeaders() })
        return (body?.items ?? []).some((item) => item.provider === 'codex' && item.sessionId === legacyId)
      },
      45_000,
    )
    // (6b) SOURCE PROTECTION — the receipt's `sourceProtection` field is
    // set ONLY by this gate, never pre-seeded. The external
    // `thread/name/set` operations above (steps 1 and 4) renamed the thread
    // on the NATIVE side with no Freshell intent anywhere; the canonical
    // record for the legacy thread (bound by the resume-create) must carry
    // an AUTOMATIC source. A native-side rename can never acquire the
    // permanence of a human rename (no native-manual inference; the
    // deterministic Task 3 lanes pin the extraction — this gate proves the
    // end-to-end fold on the real CLI).
    const preRename = await withTimeout(pollUntil(
      'codex naming record present before the canonical rename',
      async () => await server.readOne(codexTarget),
      60_000,
      250,
    ), 70_000, 'codex naming record present before the canonical rename')
    result.preRenameObservation = { source: preRename.record.source, name: preRename.record.name }
    assertAutomaticNameSource('codex', preRename.record, 'after the external thread/name/set operations')
    result.sourceProtection = 'pass'
    result.operations.push('server:sourceProtection:automaticPreserved')
    const serverName = 'Server-written codex name'
    const renameRoute = await server.renameCanonical(codexTarget, serverName, 'user')
    if (!renameRoute.ok) throw new Error(`server canonical rename failed: ${renameRoute.status} ${JSON.stringify(renameRoute.body)}`)
    result.serverRenameResponse = renameRoute.body
    let synced
    try {
      synced = await server.waitForNativeSync(codexTarget, ['synced'], 120_000)
    } catch (error) {
      // A sync-wait timeout is unattributable without the raw evidence:
      // the accepted rename's own projection, the raw read body (the read
      // OMITS unknown refs — an empty list means the store lost the record,
      // not that it merely never synced), and the durable store document
      // itself (records + keys + redirects, container-local + coherent).
      const rawRead = await server.readNames([codexTarget]).catch((e) => `read error: ${e.message}`)
      let storeDocument = '(unreadable)'
      try {
        storeDocument = fs.readFileSync(path.join(server.home, '.freshell', 'session-names.json'), 'utf8')
      } catch { /* absent */ }
      throw new Error(`${error.message}; raw read: ${JSON.stringify(rawRead)}; store document: ${storeDocument.slice(0, 8_000)}`)
    }
    result.serverWriteback = synced.nativeSync
    const connectionF = new CodexAppServer(binary, codexChildEnv(home), 'codex-F')
    await connectionF.start()
    const serverWritten = await connectionF.request('thread/read', { threadId: legacyId, includeTurns: false })
    if (serverWritten?.thread?.name !== serverName) {
      throw new Error(`server writeback not visible to a fresh native read: ${JSON.stringify(serverWritten?.thread)}`)
    }
    connectionF.stop()
    result.operations.push('server:nativeWriteback:synced')
    // The writeback's own echo must not disturb the manual record: the
    // live sidecar observes the native name change and the ingestion lane
    // folds it as an own-write echo — the canonical record keeps the
    // user-written name and its manual source (the claude contract's
    // own-echo protection, proven on the codex lane; a misclassified echo
    // that flipped or reset the record fails this leg).
    await new Promise((resolve) => setTimeout(resolve, 2_000))
    const afterWriteback = await server.readOne(codexTarget)
    if (afterWriteback?.record?.name !== serverName || afterWriteback.record.source !== 'manual') {
      throw new Error(`codex own-echo protection failed: the record after the writeback is ${JSON.stringify(afterWriteback?.record)}`)
    }
    result.operations.push('server:sourceProtection:ownEchoPreserved')
    try {
      ws.close()
    } catch {
      // already closed
    }

    // (7) Zero-turn prospective start/restart with a pending Freshell
    // rename (Task 2 exercise, no forced turn). The create response carries
    // tabId/paneId/terminalId only, so the pending naming identity is read
    // from the pane content in the layout snapshot (the server-side
    // authoritative `nameRef`/`namingHandle`).
    const createResponse = await fetchJson(`${server.baseUrl}/api/tabs`, {
      method: 'POST',
      headers: server.authHeaders(),
      body: JSON.stringify({ mode: 'codex', cwd: projectDir, name: 'Prospective zero-turn name' }),
    })
    if (!createResponse.ok) throw new Error(`codex REST create failed: ${createResponse.status} ${JSON.stringify(createResponse.body)}`)
    const paneData = createResponse.body?.data ?? {}
    const pendingTarget = await server.paneNamingRef(paneData.tabId, paneData.paneId)
    if (!pendingTarget) throw new Error(`codex REST create produced no pending naming identity: ${JSON.stringify(paneData)}`)
    const pendingName = 'Pending rename survives restart'
    const pendingRename = await server.renameCanonical(pendingTarget, pendingName, 'user')
    if (!pendingRename.ok) throw new Error(`pending rename failed: ${pendingRename.status}`)
    result.pendingHandle = pendingTarget
    result.pendingName = pendingName
    const pendingAfter = await server.readOne(pendingTarget)
    if (pendingAfter?.record?.name !== pendingName) throw new Error('pending rename did not land')
    result.operations.push('server:pendingRename')
    connectionC.stop()
    connectionD.stop()
    connectionB.stop()

    // Restart the OWNED server while the conversation is still zero-turn.
    const preRestartRevision = pendingAfter.record.revision
    server.stop()
    await server.start({ home: server.home })
    const pendingAfterRestart = await server.readOne(pendingTarget)
    if (pendingAfterRestart?.record?.name !== pendingName || pendingAfterRestart.record.revision < preRestartRevision) {
      throw new Error(`pending name did not survive the restart: ${JSON.stringify(pendingAfterRestart)}`)
    }
    result.pendingSurvivesRestart = true
    result.operations.push('server:zeroTurnRestart:pendingRetained')

    result.outcome = 'pass'
    receipt.operation(provider, 'contract', { outcome: 'pass' })
  } catch (error) {
    result.outcome = 'fail'
    result.failure = error.message
    receipt.operation(provider, 'contract', { outcome: 'fail', failure: error.message })
    throw error
  } finally {
    try {
      connectionA?.stop()
    } catch {
      // already stopped
    }
  }
}

// ---------------------------------------------------------------------------
// OpenCode contract
// ---------------------------------------------------------------------------

/** The opencode contract's container-local base (the contract HOME,
 * managed-config dir, project dir, mismatch database, serve logs) — same
 * rationale as [`codexHomePath`]. The serves' XDG roots themselves come
 * from [`opencodeXdgRoots`] — the SAME roots the Rust server env uses —
 * so the server's index adopts the contract's sessions and its managed
 * serve writes back to the SAME effective database (step 8's
 * same-database writeback requirement). */
function opencodeContractBase() {
  return path.join('/home/sandbox', '.native-smoke', 'opencode-contract')
}

function opencodeChildEnv(extra = {}) {
  const roots = opencodeXdgRoots()
  return {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    HOME: path.join(opencodeContractBase(), 'home'),
    XDG_DATA_HOME: roots.data,
    XDG_CACHE_HOME: roots.cache,
    XDG_STATE_HOME: roots.state,
    XDG_CONFIG_HOME: roots.configGlobal,
    TMPDIR: roots.tmp,
    OPENCODE_TEST_MANAGED_CONFIG_DIR: path.join(opencodeContractBase(), 'managed-config'),
    OPENCODE_DISABLE_PROJECT_CONFIG: '1',
    OPENCODE_PURE: '1',
    OPENCODE_DISABLE_DEFAULT_PLUGINS: '1',
    OPENCODE_DISABLE_MODELS_FETCH: '1',
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_LOG_LEVEL: 'WARN',
    OPENCODE_CONFIG_CONTENT: '{"snapshot":false}',
    ...extra,
  }
}

class OpencodeServe {
  constructor(opencodeBinary, label, extraEnv = {}) {
    this.binary = opencodeBinary
    this.label = label
    this.extraEnv = extraEnv
    this.logChunks = []
  }

  async start() {
    this.port = await pickFreePort()
    const logStream = fs.openSync(path.join(opencodeContractBase(), `${this.label}.log`), 'a')
    this.child = recordOwnedProcess(spawn(this.binary, ['serve', '--hostname', '127.0.0.1', '--port', String(this.port)], {
      env: opencodeChildEnv(this.extraEnv),
      stdio: ['ignore', logStream, logStream],
    }), 'opencode')
    await withTimeout(pollUntil(
      `opencode serve ${this.label} health`,
      async () => {
        try {
          const { status } = await fetchJson(`http://127.0.0.1:${this.port}/global/health`, {}, 2_000)
          return status === 200
        } catch {
          return false
        }
      },
      60_000,
      200,
    ), 70_000, `opencode serve ${this.label} health`)
    return this
  }

  baseUrl() {
    return `http://127.0.0.1:${this.port}`
  }

  stop() {
    if (!this.child) return
    try {
      this.child.kill('SIGTERM')
    } catch {
      // already gone
    }
  }
}

// Materialize a freshopencode pane through the REAL wire, the way the
// product's own client does. The REST create mints a PLACEHOLDER pane
// (sessionId = freshopencode-<createRequestId>) with a pending naming
// handle (FreshAgentView.tsx:1246 — makePlaceholderSessionId(requestId));
// the durable ses_* session is created only when the FIRST message is sent
// (`bind_naming_handle_at_materialization` — opencode_ws.rs: "the binding
// row is written at materialization (first send), well after this create
// returns"). The model turn itself may fail (no provider in the sandbox) —
// the serve's session creation and the naming bind PRECEDE the turn, so
// the send's frame is observed but not asserted. This is ALSO the only
// lane that creates the server's shared opencode serve: the native naming
// adapter resolves the shared manager PER OPERATION (a boot-time snapshot
// would freeze its None), so a server with native-writeback work needs a
// materialized pane before its series can run at all.
async function materializeOpencodePane(server, projectDir) {
  const agentCreate = await fetchJson(`${server.baseUrl}/api/tabs`, {
    method: 'POST',
    headers: server.authHeaders(),
    body: JSON.stringify({ agent: 'opencode', cwd: projectDir }),
  })
  if (!agentCreate.ok) throw new Error(`opencode REST agent create failed: ${agentCreate.status} ${JSON.stringify(agentCreate.body)}`)
  const agentPane = agentCreate.body?.data ?? {}
  const agentTabId = agentPane.tabId
  const agentPaneId = agentPane.paneId
  if (!agentTabId || !agentPaneId) throw new Error(`opencode REST agent create produced no pane: ${JSON.stringify(agentPane)}`)
  const content = await withTimeout(pollUntil(
    'agent pane content carries its naming handle',
    async () => {
      const paneNow = await server.paneContent(agentTabId, agentPaneId)
      if (!paneNow?.createRequestId || typeof paneNow.namingHandle !== 'string') return null
      return paneNow
    },
    30_000,
    500,
  ), 40_000, 'agent pane content carries its naming handle')
  const { ws: createWs, frames: createFrames } = await server.wsHello()
  createWs.send(JSON.stringify({
    type: 'freshAgent.create',
    requestId: content.createRequestId,
    sessionType: 'freshopencode',
    provider: 'opencode',
    cwd: projectDir,
    namingHandle: content.namingHandle,
  }))
  let createdFrame
  try {
    createdFrame = await server.waitForFrameAny(createFrames, ['freshAgent.created', 'freshAgent.create.failed', 'freshAgent.error', 'error'], 75_000)
    if (createdFrame.type !== 'freshAgent.created') {
      throw new Error(`the agent pane's freshAgent.create refused: ${JSON.stringify(createdFrame)}`)
    }
  } catch (error) {
    throw new Error(`${error.message}; frames so far: ${JSON.stringify(createFrames.map((frame) => ({ type: frame.type, code: frame.code, message: (frame.message ?? '').slice(0, 200) })))}`)
  }
  try {
    createWs.close()
  } catch {
    // already closed
  }
  const { ws: sendWs, frames: sendFrames } = await server.wsHello()
  sendWs.send(JSON.stringify({
    type: 'freshAgent.send',
    requestId: `materialize-${randomUUID()}`,
    sessionType: 'freshopencode',
    provider: 'opencode',
    sessionId: createdFrame.sessionId,
    cwd: projectDir,
    text: 'Materialize the session for the naming writeback contract',
  }))
  // The send's own outcome (accepted or errored on the provider call) is
  // not asserted — only the materialization it triggers is. Bound the
  // wait so a wedged lane cannot hang the contract.
  await server.waitForFrameAny(sendFrames, ['freshAgent.send.accepted', 'freshAgent.error', 'error'], 90_000).catch(() => null)
  try {
    sendWs.close()
  } catch {
    // already closed
  }
  return { tabId: agentTabId, paneId: agentPaneId, content, createdFrame }
}

async function opencodeContract(args, server, receipt, observed) {
  const provider = 'opencode'
  const result = {
    persistence: 'fail',
    freshReadback: 'fail',
    sourceProtection: 'fail',
    databaseMismatchDiagnosed: 'fail',
    liveRedraw: 'not_measured',
    outcome: 'fail',
    versions: { opencode: observed.versions.opencode },
    route: null,
    operations: [],
  }
  receipt.providers[provider] = result
  let serve1 = null
  let serve2 = null
  let serve3 = null
  let mismatchServer = null
  try {
    const contractBase = opencodeContractBase()
    const roots = opencodeXdgRoots()
    for (const dir of [roots.data, roots.cache, roots.state, roots.tmp, path.join(roots.configGlobal, 'opencode'),
      path.join(contractBase, 'home'), path.join(contractBase, 'managed-config'), path.join(contractBase, 'proj'), path.join(contractBase, 'mismatch')]) {
      fs.mkdirSync(dir, { recursive: true })
    }
    // The source-proven no-install path: preseed the global config's
    // .gitignore, then make the config tree READ-ONLY for the provider
    // child so opencode's npm-install early-return fires (a failed
    // background install would be a gate failure, not harmless noise).
    fs.writeFileSync(path.join(roots.configGlobal, 'opencode', '.gitignore'), 'node_modules/\n')
    fs.rmSync(path.join(contractBase, 'home', '.opencode'), { force: true, recursive: true })
    const binary = path.join(args.opencodeRoot, 'bin', 'opencode')
    const projectDir = path.join(contractBase, 'proj')
    result.route = {
      dataHome: roots.data,
      database: path.join(roots.data, 'opencode', 'opencode.db'),
      project: projectDir,
    }

    // (1) Zero-message POST /session {} on an owned scratch serve.
    serve1 = await new OpencodeServe(binary, "serve1").start()
    const createResponse = await fetchJson(`${serve1.baseUrl()}/session?directory=${encodeURIComponent(projectDir)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    if (!createResponse.ok) throw new Error(`POST /session failed: ${createResponse.status}`)
    const session = createResponse.body
    if (typeof session?.id !== 'string' || !session.id.startsWith('ses_')) {
      throw new Error(`unexpected session row: ${JSON.stringify(session)}`)
    }
    if ((session?.cost ?? 0) !== 0 || (session?.tokens?.input ?? 0) !== 0) {
      throw new Error(`zero-message session must not cost tokens: ${JSON.stringify(session)}`)
    }
    result.sessionId = session.id
    result.createdTitle = session.title
    result.operations.push('serve:postSession:zeroMessage')

    // (2) Writer event streams: connect BEFORE the title write and record
    // the session.updated frame (properties.info.id must parse). BOTH the
    // per-serve `/event` stream (the product lane's busy/status consumer)
    // AND the `/global/event` stream (the product naming lane's
    // TITLE-observation consumer, `freshell-opencode/src/serve.rs:769`)
    // are subscribed — the installed serve (1.18.31) was observed NOT to
    // carry `session.updated` for a title PATCH on `/event` alone (the
    // stream connected and delivered `server.connected`, then nothing),
    // and `/global/event` wraps frames under `payload` (the product's
    // `event_payload` normalizes both shapes; so does the matcher below).
    const events = []
    const eventStreamDiagnostics = { streams: {} }
    const eventController = new AbortController()
    const consumeEventStream = async (streamPath) => {
      const diagnostics = { status: null, contentType: null, chunks: 0, error: null, rawHead: [] }
      eventStreamDiagnostics.streams[streamPath] = diagnostics
      try {
        const response = await fetch(`${serve1.baseUrl()}${streamPath}`, { signal: eventController.signal })
        diagnostics.status = response.status
        diagnostics.contentType = response.headers.get('content-type')
        if (!response.ok) {
          diagnostics.rawHead.push((await response.text().catch(() => '')).slice(0, 400))
          return
        }
        const reader = response.body.getReader()
        let buffer = ''
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          diagnostics.chunks += 1
          if (diagnostics.rawHead.length < 8) {
            diagnostics.rawHead.push(new TextDecoder().decode(value).slice(0, 300))
          }
          buffer += new TextDecoder().decode(value)
          let index
          while ((index = buffer.indexOf('\n\n')) !== -1) {
            const frame = buffer.slice(0, index)
            buffer = buffer.slice(index + 2)
            const dataLine = frame.split('\n').find((line) => line.startsWith('data: '))
            if (dataLine) {
              try {
                events.push(JSON.parse(dataLine.slice(6)))
              } catch {
                // ignore non-JSON frames
              }
            }
          }
        }
      } catch (error) {
        diagnostics.error = String(error)
        // stream ended
      }
    }
    const eventReaders = Promise.all([
      consumeEventStream('/event'),
      consumeEventStream('/global/event'),
    ])
    result.eventStreamDiagnostics = eventStreamDiagnostics

    // (3) Production GET/PATCH/GET through the runner-owned serve.
    const nativeTitle = 'Native opencode title'
    const patchResponse = await fetchJson(`${serve1.baseUrl()}/session/${session.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: nativeTitle }),
    })
    if (!patchResponse.ok || patchResponse.body?.title !== nativeTitle) {
      throw new Error(`PATCH /session/:id failed: ${patchResponse.status} ${JSON.stringify(patchResponse.body)}`)
    }
    result.operations.push('serve:patchTitle')
    const getResponse = await fetchJson(`${serve1.baseUrl()}/session/${session.id}`)
    if (getResponse.body?.title !== nativeTitle) {
      throw new Error(`GET after PATCH lost the title: ${JSON.stringify(getResponse.body)}`)
    }
    result.persistence = 'pass'
    result.operations.push('serve:getTitle')

    // (4) The writer event streams are LIVE and parseable, and a
    // session.updated frame for the session is recorded when the installed
    // serve emits one. HARD asserts: both streams connected and delivered
    // the frames the product's own consumers parse (the lane's busy/status
    // consumer on `/event`; the naming lane's title-observation consumer on
    // `/global/event` — `freshell-opencode/src/serve.rs:769`). OBSERVATIONAL:
    // `session.updated` for the title PATCH — opencode 1.18.31 does NOT
    // emit one for a metadata-only PATCH on a zero-message session (both
    // streams verified healthy, `server.connected` + heartbeats only), and
    // no Freshell consumer depends on a self-writeback event (the naming
    // lane observes NATIVE-side title changes; steps 3/5/6 prove the
    // writeback persists). The eventShape receipt records what came.
    const eventOf = (event) => ({
      type: event.type ?? event.payload?.type ?? null,
      properties: event.properties ?? event.payload?.properties ?? null,
    })
    const streamsLive = await withTimeout(pollUntil(
      'writer event streams live (server.connected on both /event and /global/event)',
      async () => (['/event', '/global/event'].every((streamPath) => {
        const rawHead = eventStreamDiagnostics.streams[streamPath]?.rawHead ?? []
        return rawHead.some((line) => line.includes('"server.connected"'))
      }) ? { ok: true } : null),
      10_000,
      100,
    ), 12_000, 'writer event streams live')
    if (!streamsLive.ok) {
      throw new Error(`writer event streams not live/parseable: ${JSON.stringify(eventStreamDiagnostics)}`)
    }
    const updatedEvent = await withTimeout(pollUntil(
      'session.updated event',
      async () => {
        for (const raw of events) {
          const event = eventOf(raw)
          if (event.type === 'session.updated' && (event.properties?.sessionID === session.id || event.properties?.info?.id === session.id)) {
            return { raw, event }
          }
        }
        return null
      },
      10_000,
      100,
    ), 12_000, 'session.updated event').catch(() => null)
    result.eventShape = updatedEvent
      ? {
          type: updatedEvent.event.type,
          sessionID: updatedEvent.event.properties?.sessionID ?? null,
          infoId: updatedEvent.event.properties?.info?.id ?? null,
        }
      : { observed: false, note: 'opencode 1.18.31 emits no session.updated for a metadata-only PATCH on a zero-message session' }
    result.operations.push('serve:writerEventStream')

    // (5) SQLite stays read-only to Freshell and carries the row.
    const dbPath = path.join(opencodeXdgRoots().data, 'opencode', 'opencode.db')
    const { execFile } = await import('node:child_process')
    const sqliteProbe = await new Promise((resolve) => {
      execFile('python3', ['-c', `
import sqlite3
conn = sqlite3.connect('file:${dbPath}?mode=ro', uri=True)
row = conn.execute('select id, title, directory from session where id = ?', ('${session.id}',)).fetchall()
messages = conn.execute("select count(*) from message where session_id = ?", ('${session.id}',)).fetchall()
print(row, messages[0][0])
`], (error, stdout) => resolve({ error, stdout: String(stdout) }))
    })
    if (sqliteProbe.error || !sqliteProbe.stdout.includes(nativeTitle)) {
      throw new Error(`SQLite readback mismatch: ${sqliteProbe.error?.message ?? sqliteProbe.stdout}`)
    }
    if (!/\[\], 0/.test(sqliteProbe.stdout) && !/\(\), 0\)/.test(sqliteProbe.stdout) && !sqliteProbe.stdout.includes(' 0')) {
      throw new Error(`message history must stay empty: ${sqliteProbe.stdout}`)
    }
    result.sqliteReadback = 'pass'
    result.operations.push('sqlite:readOnlyReadback:emptyHistory')

    // (6) Restart ONLY the owned scratch serve; the title persists.
    serve1.stop()
    serve2 = await new OpencodeServe(binary, "serve2").start()
    const restartRead = await fetchJson(`${serve2.baseUrl()}/session/${session.id}`)
    if (restartRead.body?.title !== nativeTitle) {
      throw new Error(`serve restart lost the title: ${JSON.stringify(restartRead.body)}`)
    }
    result.freshReadback = 'pass'
    result.operations.push('serve:restartReadback')

    // (7) A second same-database management connection sees the row without
    // taking execution ownership.
    serve3 = await new OpencodeServe(binary, "serve3").start()
    const secondConnectionRead = await fetchJson(`${serve3.baseUrl()}/session/${session.id}`)
    if (secondConnectionRead.body?.title !== nativeTitle) {
      throw new Error(`second management connection lost the title: ${JSON.stringify(secondConnectionRead.body)}`)
    }
    result.operations.push('serve:secondManagementConnection')

    // (8a) Hydration gate + the indexed-session observation. The serve-
    // created zero-message session IS indexed (the poll) and its canonical
    // naming record hydrates from a periodic sweep — the hydration races the
    // index by up to ~2 min (observed both ways: a rename in the gap 404s
    // NAME_NOT_FOUND, a later rename finds revision 13). GATE on the record
    // (the claude contract's own pattern), then rename it: the record has NO
    // verified native location (locationRevision 0 — only a live lane-owned
    // session gets one), so its nativeSync honestly stays `pending` (native
    // writes are deferred by design until a live connection can carry them —
    // the codex leg proved the same rule). The receipt RECORDS that state;
    // the writeback proof is (8b), through the server's own agent lane.
    const target = { kind: 'session', provider: 'opencode', sessionId: session.id }
    await pollUntil(
      'opencode session indexed',
      async () => {
        const { body } = await fetchJson(`${server.baseUrl}/api/session-directory?priority=visible&limit=50`, { headers: server.authHeaders() })
        return (body?.items ?? []).some((item) => item.provider === 'opencode' && item.sessionId === session.id)
      },
      60_000,
    )
    const hydrated = await withTimeout(pollUntil(
      'serve-created session naming record hydrated',
      async () => await server.readOne(target),
      150_000,
      1_000,
    ), 160_000, 'serve-created session naming record hydrated')
    result.indexedSessionObservation = {
      source: hydrated.record.source,
      nativeSync: hydrated.nativeSync,
    }
    // SOURCE PROTECTION — the receipt's `sourceProtection` field is set
    // ONLY by this gate, never pre-seeded. The serve-observed native title
    // was ingested by the naming lane as an AUTOMATIC observation: a
    // native-side name must never fold as human intent (no native-manual
    // inference). Before this gate the field was absent from the opencode
    // receipt entirely, so the recorded `source: provider_ai` carried no
    // proof.
    assertAutomaticNameSource('opencode', hydrated.record, 'the hydrated serve-observed record')
    result.sourceProtection = 'pass'
    const indexedRename = await server.renameCanonical(target, 'Indexed-session canonical name', 'user')
    if (!indexedRename.ok) throw new Error(`indexed-session canonical rename failed: ${indexedRename.status} ${JSON.stringify(indexedRename.body)}`)
    result.operations.push('server:indexedSessionRename:accepted')

    // (8b) The REAL server-side writeback proof, through the product's own
    // agent lane (the e2e pending-journey machinery): a freshopencode pane
    // created by the SERVER carries a pending naming handle that binds
    // durable against the persisted (zero-turn) DB row, so the canonical
    // rename HAS a record — and its native writeback runs through the
    // server's managed serve, the SAME effective database the contract's
    // serves read (shared XDG_DATA_HOME). The materialization helper drives
    // the REST create, the WS create lane, and the first send — the same
    // wire the real client speaks.
    const { tabId: agentTabId, paneId: agentPaneId, content: agentContent, createdFrame: agentCreatedFrame } = await materializeOpencodePane(server, projectDir)
    result.agentPane = { tabId: agentTabId, paneId: agentPaneId, createdPlaceholder: agentCreatedFrame.sessionId }
    // The bind's DURABLE target: the pane CONTENT's nameRef only advances
    // when a real CLIENT syncs its layout (the raw-WS pane has no
    // layout-syncing client — observed end-to-end: the first send
    // materialized the session, the store redirected the pending handle
    // onto the durable ses_* id with a VERIFIED database location, while
    // the pane content kept the placeholder). Derive the target from the
    // naming state itself: read the PENDING ref — the store's redirect
    // resolution answers the DURABLE record it bound to.
    const agentTarget = await withTimeout(pollUntil(
      'the pane handle binds onto its durable session record',
      async () => {
        const update = await server.readOne({ kind: 'pending', id: agentContent.namingHandle })
        if (!update || update.record.ref.kind !== 'session') return null
        return update.record.ref
      },
      90_000,
      500,
    ), 100_000, 'the pane handle binds onto its durable session record')
    const agentSessionId = agentTarget.sessionId
    result.agentSession = { tabId: agentTabId, paneId: agentPaneId, sessionId: agentSessionId }
    const serverName = 'Server-written opencode name'
    const renameRoute = await server.renameCanonical(agentTarget, serverName, 'user')
    if (!renameRoute.ok) throw new Error(`server canonical rename failed: ${renameRoute.status} ${JSON.stringify(renameRoute.body)}`)
    result.serverRenameResponse = renameRoute.body
    let synced
    try {
      synced = await server.waitForNativeSync(agentTarget, ['synced'], 180_000)
    } catch (error) {
      const rawRead = await server.readNames([agentTarget]).catch((e) => `read error: ${e.message}`)
      let storeDocument = '(unreadable)'
      try {
        storeDocument = fs.readFileSync(path.join(server.home, '.freshell', 'session-names.json'), 'utf8')
      } catch { /* absent */ }
      throw new Error(`${error.message}; raw read: ${JSON.stringify(rawRead)}; store document: ${storeDocument.slice(0, 8_000)}`)
    }
    result.serverWriteback = synced.nativeSync
    const viaServe2 = await fetchJson(`${serve2.baseUrl()}/session/${agentSessionId}`)
    if (viaServe2.body?.title !== serverName) {
      throw new Error(`server writeback not visible to the native serve: ${JSON.stringify(viaServe2.body)}`)
    }
    result.operations.push('server:nativeWriteback:synced')

    // (9) Deliberate database mismatch: a second short-lived Rust server
    // whose OPENCODE_DB override points at a DIFFERENT scratch database must
    // diagnose the mismatch (native never syncs) without losing the Freshell
    // name in ITS canonical store. Its store is seeded by COPYING the main
    // server's canonical document before boot (a fresh store would have NO
    // record for the target and its rename would 404 the same way (8a)
    // proved) — the copied record's verified location points at the REAL
    // database while the override points elsewhere: the mismatch diagnosis.
    const mismatchDb = path.join(opencodeContractBase(), 'mismatch', 'other.db')
    const mismatchHome = path.join('/home/sandbox', '.native-smoke', 'server-home-mismatch')
    const mismatchStoreDir = path.join(mismatchHome, '.freshell')
    fs.mkdirSync(mismatchStoreDir, { recursive: true })
    fs.copyFileSync(path.join(server.home, '.freshell', 'session-names.json'), path.join(mismatchStoreDir, 'session-names.json'))
    mismatchServer = new RustServer(args.runtimeRoot, args.scratch, receipt)
    mismatchServer.runtimeRoot = args.runtimeRoot
    mismatchServer.scratchCodexCmd = path.join(args.codexRoot, 'bin', 'codex')
    await mismatchServer.start({
      home: mismatchHome,
      env: { OPENCODE_DB: mismatchDb },
    })
    // The mismatch server's shared opencode serve must EXIST for its
    // native writeback to reach the diagnosis: the naming adapter resolves
    // the shared manager PER OPERATION, and a server with no materialized
    // pane has no serve — its armed series would PAUSE (capability absent,
    // zero cycles) instead of being diagnosed. Materializing a pane spawns
    // the serve under THIS server's env, so the manager's evaluated
    // effective database is the MISMATCHED pin while the copied record's
    // verified location points at the REAL database: the pre-dispatch
    // context gate must reject every operation.
    await materializeOpencodePane(mismatchServer, projectDir)
    const mismatchName = 'Mismatch-server name'
    const mismatchRename = await mismatchServer.renameCanonical(agentTarget, mismatchName, 'user')
    if (!mismatchRename.ok) throw new Error(`mismatch-server rename failed: ${mismatchRename.status} ${JSON.stringify(mismatchRename.body)}`)
    await pollUntil(
      'mismatch-server nativeSync unsynced',
      async () => {
        const update = await mismatchServer.readOne(agentTarget)
        if (!update?.nativeSync) return null
        if (['unsynced', 'unsupported'].includes(update.nativeSync.status)) return update
        return null
      },
      120_000,
    )
    const mismatchRecord = await mismatchServer.readOne(agentTarget)
    if (mismatchRecord.record.name !== mismatchName) {
      throw new Error(`mismatch server lost the Freshell name: ${JSON.stringify(mismatchRecord.record)}`)
    }
    result.databaseMismatchDiagnosed = 'pass'
    result.mismatchNativeSync = mismatchRecord.nativeSync
    result.operations.push('server:databaseMismatch:diagnosed')
    mismatchServer.stop()
    mismatchServer = null

    // The REAL database row was never corrupted by the mismatch server.
    const realRead = await fetchJson(`${serve2.baseUrl()}/session/${agentSessionId}`)
    if (realRead.body?.title !== serverName) {
      throw new Error(`mismatch server corrupted the real database row: ${JSON.stringify(realRead.body)}`)
    }
    result.operations.push('serve:realDatabaseUntouched')

    eventController.abort()
    result.outcome = 'pass'
    receipt.operation(provider, 'contract', { outcome: 'pass' })
  } catch (error) {
    result.outcome = 'fail'
    result.failure = error.message
    receipt.operation(provider, 'contract', { outcome: 'fail', failure: error.message })
    throw error
  } finally {
    for (const serve of [serve1, serve2, serve3]) {
      try {
        serve?.stop()
      } catch {
        // already stopped
      }
    }
    if (mismatchServer) mismatchServer.stop()
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs()
  fs.mkdirSync(args.scratch, { recursive: true })
  const receiptPath = args.receipt ?? path.join(args.scratch, 'receipt.json')
  const receipt = new Receipt(receiptPath)

  const { problems, observed } = preflight(args)
  const container = {
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
  }
  if (problems.length > 0) {
    receipt.overall = 'prerequisite-missing'
    receipt.write({ prerequisites: { problems }, inputs: observed, container })
    process.stderr.write(`[native-session-names] missing prerequisites:\n${problems.map((problem) => `  - ${problem}`).join('\n')}\n`)
    stopOwnedProcesses()
    process.exit(2)
  }

  let server = null
  let failure = null
  try {
    // The claude config root must EXIST before the server boots: the
    // session watcher's late-root arming is bounded AT the provider home,
    // so an absent CLAUDE_HOME leaves nothing armed and the transcript's
    // later creation is never observed (observed end-to-end: the
    // 'indexed' poll never converged with a boot-time-absent root).
    fs.mkdirSync(path.join(claudeConfigRootPath(args.scratch), 'projects'), { recursive: true })
    fs.mkdirSync(codexHomePath(), { recursive: true })
    for (const root of Object.values(opencodeXdgRoots())) {
      fs.mkdirSync(root, { recursive: true })
    }
    server = new RustServer(args.runtimeRoot, args.scratch, receipt)
    server.runtimeRoot = args.runtimeRoot
    server.scratchCodexCmd = path.join(args.codexRoot, 'bin', 'codex')
    await server.start()

    receipt.operation('server', 'start', { port: server.port, home: server.home })
    await claudeContract(args, server, receipt, observed)
    await codexContract(args, server, receipt, observed)
    await opencodeContract(args, server, receipt, observed)
  } catch (error) {
    failure = error.message
    // The staged server's own log is the primary diagnostic for native
    // writeback/wedge failures, and the scratch bind is cleaned per-run —
    // carry its tail into the failure so the receipt answers WHY.
    try {
      const tail = fs.readFileSync(server?.logFile, 'utf8')
      failure += `\nserver log tail:\n${tail.slice(-4_000)}`
    } catch { /* the log may be absent */ }
    // The server's STRUCTURED logs are the JSONL files under its home
    // (its stdout stays near-silent) — carry the newest entries so a
    // sidecar/wedge failure is attributable.
    try {
      const logsDir = path.join(server?.home ?? '', '.freshell', 'logs')
      const files = fs.readdirSync(logsDir).filter((name) => name.endsWith('.jsonl')).sort()
      const newest = files.at(-1)
      if (newest) {
        const lines = fs.readFileSync(path.join(logsDir, newest), 'utf8').trim().split('\n')
        // `session_names` (underscore) is the naming STORE's target/event
        // vocabulary; `naming` alone missed every bind/rename/store error
        // line (observed: the opencode durable-bind failure's evidence was
        // filtered out of the tail while claude collision lines — which
        // match via the "native" in the transcript PATH — scrolled the
        // window). Keep both spellings plus the provider/freshagent
        // vocabulary, and cap per-msg dedupe so one noisy family cannot
        // crowd the rest out.
        const interesting = lines.filter((line) => /codex|freshAgent|freshagent|opencode|sidecar|naming|session_names|session\.name|native/i.test(line)).slice(-60)
        failure += `\nserver jsonl log tail (${newest}):\n${interesting.join('\n').slice(-6_000)}\n(last 8 raw):\n${lines.slice(-8).join('\n')}`
      }
    } catch { /* the logs dir may be absent */ }
    receipt.overall = 'fail'
  } finally {
    try {
      server?.stop()
    } catch {
      // already stopped
    }
    stopOwnedProcesses()
  }

  const providersPresent = ['claude', 'codex', 'opencode'].map((provider) => ({
    provider,
    ran: Boolean(receipt.providers[provider]),
    outcome: receipt.providers[provider]?.outcome ?? 'missing',
  }))
  const allPassed = providersPresent.every((entry) => entry.outcome === 'pass')
  // The persisted receipt's `overall` must state the run's own outcome: it
  // previously stayed 'pending' on a fully passing run (stdout said pass,
  // the wrapper classified pass, the FILE said pending — the receipt
  // understated the run). The failure paths set 'fail'/'prerequisite-missing'
  // before this point; this line is the only success write.
  receipt.overall = allPassed ? 'pass' : receipt.overall
  const document = receipt.write({
    prerequisites: { problems: [] },
    inputs: observed,
    container,
    providersPresent,
    ...(failure ? { failure } : {}),
  })
  process.stdout.write(`${JSON.stringify({ overall: allPassed ? 'pass' : 'fail', providers: providersPresent }, null, 2)}\n`)
  process.stdout.write(`[native-session-names] receipt: ${receiptPath}\n`)
  process.exit(allPassed ? 0 : 1)
}

main().catch((error) => {
  process.stderr.write(`[native-session-names] unhandled failure: ${error?.stack ?? error}\n`)
  stopOwnedProcesses()
  process.exit(1)
})
