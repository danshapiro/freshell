#!/usr/bin/env node
/**
 * REST surface parity sweep — ORIGINAL Node freshell vs Rust port.
 *
 * Per port/HANDOFF.md §7.C (work-queue item 4): for EVERY §7.C endpoint, run the
 * happy path + auth-missing + auth-bad + the endpoint's documented error cases
 * against BOTH servers with byte-identical requests, and compare
 * status + headers-of-interest + body as normalized deep-equal (§8.1: deep-equal
 * after the DECLARED normalization list only — see NORMALIZED_FIELDS below).
 *
 * The script is self-contained and rerunnable:
 *   node port/oracle/rest-parity/sweep.mjs [--out results.json]
 *
 * It boots the ORIGINAL (dist/server/index.js, §5.1 recipe, port 17871) and the
 * RUST port (target/release/freshell-server, §5.2 recipe, port 17872) in two
 * ISOLATED scratch homes under $HOME (never /tmp), seeded identically; runs the
 * sweep (including a mid-sweep restart for settings persistence); reaps every
 * process it started (ownership-verified via tracked PIDs only — no pkill);
 * removes the scratch homes; and reports an orphan check.
 *
 * PORT DISCIPLINE (HANDOFF §0): only ports 17870-17899 are used.
 * PURITY (HANDOFF §8.3): never touches server/, shared/, src/.
 * Findings are RECORDED, never fixed or normalized away, per the task charter.
 */

import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, '../../..')

// ── constants ────────────────────────────────────────────────────────────────
const NODE_PORT = 17871
const RUST_PORT = 17872
const PROXY_TARGET_PORT = 17876
const PROXY_DEAD_PORT = 17877 // in the sanctioned range; verified unbound before use
const WS_PROTOCOL_VERSION = 7 // shared/ws-version.ts (frozen contract)
const BAD_TOKEN = 'definitely-not-the-token-0000000000000000'
const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const TOKEN = process.env.AUTH_TOKEN || crypto.randomBytes(32).toString('hex')

const RUN_TAG = `${process.pid}`
const HOME_NODE = path.join(os.homedir(), `.freshell-qa-restparity-node-${RUN_TAG}`)
const HOME_RUST = path.join(os.homedir(), `.freshell-qa-restparity-rust-${RUN_TAG}`)
const LOGS_DIR = path.join(os.homedir(), `.freshell-qa-restparity-logs-${RUN_TAG}`)
// Screenshot outputs: both servers run with cwd=REPO (the §5.1/§5.2 recipes run
// from the checkout — the node extension registry + CLI detection specs are
// cwd-derived), so relative screenshot paths land here. .worktrees/ is
// gitignored; the dir is removed at teardown.
const SHOTS_DIR = path.join(REPO, '.worktrees', 'qa-rp-shots')
const SHOTS_REL = '.worktrees/qa-rp-shots/'

/**
 * DECLARED normalization list (HANDOFF §8.1: "deep-equal after the DECLARED
 * normalization list only"). Field-NAME based, applied at any nesting depth,
 * mirroring port/oracle/harness/normalize.ts. A value is masked ONLY when it
 * also matches the family's expected shape — a mis-shaped value is left raw so
 * it surfaces as a divergence instead of being silently canonicalized.
 *
 * Families:
 *   id        — per-boot generated identifiers
 *   timestamp — wall-clock values (ISO string or positive epoch number)
 *   version   — build/version strings (the two artifacts may legitimately differ)
 *   seq       — run-monotonic counters (session-directory revision)
 *   cursor    — opaque pagination cursors
 *   opaque    — live third-party network data, never value-compared
 */
const NORMALIZED_FIELDS = {
  // terminalIds are server-minted uuids — never value-comparable across the
  // two servers; presence + same-key-position still compared.
  terminalId: 'id',
  instanceId: 'id',
  serverInstanceId: 'id',
  bootId: 'id',
  connectionId: 'id',
  requestId: 'id',
  startedAt: 'timestamp',
  timestamp: 'timestamp',
  modifiedAt: 'timestamp',
  generatedAt: 'timestamp',
  lastActivityAt: 'timestamp',
  createdAt: 'timestamp',
  updatedAt: 'timestamp',
  checkedAt: 'timestamp',
  turnCompletedAt: 'timestamp',
  at: 'timestamp',
  version: 'version',
  currentVersion: 'version',
  latestVersion: 'version',
  cliVersion: 'version',
  revision: 'seq',
  cursor: 'cursor',
  nextCursor: 'cursor',
  // Per-boot generated secret material persisted into config.json by the node
  // original (config-store). Never value-comparable; presence still compared.
  codexDisplayIdSecret: 'opaque',
  // The two servers necessarily listen on different ports (17871 vs 17872) —
  // an environment artifact of running both systems side by side, not a
  // behavior difference. Masked only when the value IS one of the two
  // sweep-assigned self-ports; foreign ports (proxy target 17876 etc.) are
  // compared literally.
  port: 'selfport',
  // GET /api/version updateCheck is derived from a LIVE GitHub API call
  // (server/updater/version-checker.ts) — third-party network data that can
  // change between the two requests. Masked as opaque; its PRESENCE/nullness
  // still participates in the comparison.
  updateCheck: 'opaque',
  // The auth credential must never appear in committed artifacts.
  token: 'opaque',
}

/** Host-legit absolute-path scrubbing applied to EVERY string value. */
function buildStringScrubbers() {
  const pairs = [
    [HOME_NODE, '<SCRATCH_HOME>'],
    [HOME_RUST, '<SCRATCH_HOME>'],
    [REPO, '<REPO>'],
    [os.tmpdir(), '<TMP>'],
    [TOKEN, '<TOKEN>'],
    // self-port occurrences inside URLs/strings (accessUrl etc.)
    [`:${NODE_PORT}`, ':<SELF_PORT>'],
    [`:${RUST_PORT}`, ':<SELF_PORT>'],
  ]
  return (s) => {
    let out = s
    for (const [needle, repl] of pairs) out = out.split(needle).join(repl)
    return out
  }
}
const scrubString = buildStringScrubbers()

const ISO_TS_RE = /^\d{4}-\d{2}-\d{2}T/
const ID_RE = /^[A-Za-z0-9_-]{6,}$/
const VERSION_RE = /^v?\d+\.\d+/

function maskLeaf(family, value) {
  switch (family) {
    case 'id':
      return typeof value === 'string' && ID_RE.test(value) ? '<ID>' : value
    case 'timestamp':
      if (typeof value === 'number' && value > 0) return '<TS>'
      if (typeof value === 'string' && ISO_TS_RE.test(value)) return '<TS>'
      return value
    case 'version':
      return typeof value === 'string' && VERSION_RE.test(value) ? '<VERSION>' : value
    case 'seq':
      return typeof value === 'number' && Number.isFinite(value) ? '<SEQ>' : value
    case 'cursor':
      return typeof value === 'string' && value.length > 0 ? '<CURSOR>' : value
    case 'opaque':
      return value === null || value === undefined ? value : '<OPAQUE>'
    case 'selfport':
      return value === NODE_PORT || value === RUST_PORT ? '<SELF_PORT>' : value
    default:
      return value
  }
}

function normalizeJson(value, keyName) {
  const family = keyName ? NORMALIZED_FIELDS[keyName] : undefined
  if (family === 'opaque') return maskLeaf('opaque', value)
  if (Array.isArray(value)) return value.map((el) => normalizeJson(el, keyName))
  if (value && typeof value === 'object') {
    const out = {}
    for (const k of Object.keys(value)) out[k] = normalizeJson(value[k], k)
    return out
  }
  if (typeof value === 'string') {
    const scrubbed = scrubString(value)
    return family ? maskLeaf(family, scrubbed) : scrubbed
  }
  return family ? maskLeaf(family, value) : value
}

function stableStringify(value) {
  const sort = (v) => {
    if (Array.isArray(v)) return v.map(sort)
    if (v && typeof v === 'object') {
      const out = {}
      for (const k of Object.keys(v).sort()) out[k] = sort(v[k])
      return out
    }
    return v
  }
  return JSON.stringify(sort(value))
}

function deepDiff(a, b, p = '$', out = []) {
  if (a === b) return out
  const aArr = Array.isArray(a)
  const bArr = Array.isArray(b)
  if (aArr || bArr) {
    if (!aArr || !bArr) return out.push({ path: p, node: a, rust: b }), out
    const max = Math.max(a.length, b.length)
    for (let i = 0; i < max; i++) {
      if (i >= a.length) out.push({ path: `${p}[${i}]`, node: '<missing>', rust: b[i] })
      else if (i >= b.length) out.push({ path: `${p}[${i}]`, node: a[i], rust: '<missing>' })
      else deepDiff(a[i], b[i], `${p}[${i}]`, out)
    }
    return out
  }
  const aObj = a && typeof a === 'object'
  const bObj = b && typeof b === 'object'
  if (aObj || bObj) {
    if (!aObj || !bObj) return out.push({ path: p, node: a, rust: b }), out
    const keys = new Set([...Object.keys(a), ...Object.keys(b)])
    for (const k of [...keys].sort()) {
      const hasA = Object.prototype.hasOwnProperty.call(a, k)
      const hasB = Object.prototype.hasOwnProperty.call(b, k)
      if (hasA && !hasB) out.push({ path: `${p}.${k}`, node: a[k], rust: '<missing>' })
      else if (!hasA && hasB) out.push({ path: `${p}.${k}`, node: '<missing>', rust: b[k] })
      else deepDiff(a[k], b[k], `${p}.${k}`, out)
    }
    return out
  }
  out.push({ path: p, node: a, rust: b })
  return out
}

// ── seeding ──────────────────────────────────────────────────────────────────
const CLAUDE_SESSION_UUID = '11111111-1111-4111-8111-111111111111'
const CLAUDE_REAL_SESSION_UUID = '22222222-2222-4222-8222-222222222222'
const CLAUDE_PROJECT_DIR = '-home-qa-demo'

/**
 * A minimal but REALISTIC Claude session (real event shapes: message objects,
 * cwd, timestamps). The repair fixtures in test/fixtures/sessions/ are NOT
 * valid coding-cli sessions (plain-string `message` fields, non-UUID
 * session_id) — verified empirically: the node original NEVER surfaces them in
 * /api/session-directory, and the rust port surfaces them only under
 * includeNonInteractive/includeEmpty flags (recorded as a divergence). This
 * synthesized session exercises the seeded entries/filters/revision path on
 * both sides; the fixture seeding is kept to pin that behavior.
 */
const REALISTIC_CLAUDE_SESSION = [
  { type: 'user', sessionId: CLAUDE_REAL_SESSION_UUID, cwd: '/home/qa/demo', gitBranch: 'main', uuid: 'qa-u-1', timestamp: '2025-06-01T10:00:00.000Z', message: { role: 'user', content: 'hello parity sweep session' } },
  { type: 'assistant', sessionId: CLAUDE_REAL_SESSION_UUID, cwd: '/home/qa/demo', uuid: 'qa-a-1', parentUuid: 'qa-u-1', timestamp: '2025-06-01T10:00:05.000Z', message: { role: 'assistant', model: 'claude-3-5-haiku-20241022', content: [{ type: 'text', text: 'Hi from the parity fixture.' }], usage: { input_tokens: 10, output_tokens: 5 } } },
  { type: 'user', sessionId: CLAUDE_REAL_SESSION_UUID, cwd: '/home/qa/demo', uuid: 'qa-u-2', parentUuid: 'qa-a-1', timestamp: '2025-06-01T10:01:00.000Z', message: { role: 'user', content: 'second message for the query filter' } },
]
  .map((e) => JSON.stringify(e))
  .join('\n') + '\n'

async function seedHome(home) {
  await fsp.rm(home, { recursive: true, force: true })
  await fsp.mkdir(path.join(home, '.freshell'), { recursive: true })
  // Setup-wizard bypass pre-seed (same shape the E2E TestServer writes).
  await fsp.writeFile(
    path.join(home, '.freshell', 'config.json'),
    JSON.stringify(
      { version: 1, settings: { network: { configured: true, host: '127.0.0.1' } } },
      null,
      2,
    ),
  )
  // Empty claude projects root so the "empty home" session-directory case is a
  // watched-but-empty directory (watcher can then pick up the later seed).
  await fsp.mkdir(path.join(home, '.claude', 'projects'), { recursive: true })
  // /api/files sandbox playground
  await fsp.mkdir(path.join(home, 'qa-files', 'subdir'), { recursive: true })
  await fsp.writeFile(path.join(home, 'qa-files', 'hello.txt'), 'hello parity\n')
  await fsp.writeFile(path.join(home, 'qa-files', 'hemlock.txt'), 'a second he* match\n')
  await fsp.writeFile(path.join(home, 'outside.txt'), 'outside the sandbox\n')
}

async function seedClaudeSessions(home) {
  const projDir = path.join(home, '.claude', 'projects', CLAUDE_PROJECT_DIR)
  await fsp.mkdir(projDir, { recursive: true })
  // Repair fixture (per task charter: seed from test/fixtures/sessions/) —
  // empirically ignored by BOTH implementations (not a valid coding-cli
  // session); its absence from the page is itself a parity assertion.
  await fsp.copyFile(
    path.join(REPO, 'test', 'fixtures', 'sessions', 'healthy.jsonl'),
    path.join(projDir, `${CLAUDE_SESSION_UUID}.jsonl`),
  )
  // Realistic session — must surface on both sides.
  await fsp.writeFile(path.join(projDir, `${CLAUDE_REAL_SESSION_UUID}.jsonl`), REALISTIC_CLAUDE_SESSION)
}

// ── server lifecycle (ownership-tracked; no pattern kills, ever) ─────────────
const ownedChildren = new Set()

function baseEnv(home) {
  return {
    PATH: process.env.PATH,
    TERM: 'xterm-256color',
    LANG: process.env.LANG || 'C.UTF-8',
    HOME: home,
    USERPROFILE: home,
    FRESHELL_HOME: home,
    CLAUDE_HOME: path.join(home, '.claude'),
    CODEX_HOME: path.join(home, '.codex'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    AUTH_TOKEN: TOKEN,
    FRESHELL_BIND_HOST: '127.0.0.1',
    NODE_ENV: 'production',
    // Neutralize the checkout's .env (dotenv/config reads $CWD/.env; explicit
    // env always wins, but stray keys like GEMINI_API_KEY would asymmetrically
    // flip featureFlags on the node side only). Points at a nonexistent file.
    DOTENV_CONFIG_PATH: path.join(LOGS_DIR, 'nonexistent.env'),
    // Deterministic feature flags on both sides regardless of ambient env.
    KILROY_ENABLED: '0',
  }
}

function spawnServer(kind) {
  const home = kind === 'node' ? HOME_NODE : HOME_RUST
  const port = kind === 'node' ? NODE_PORT : RUST_PORT
  const env = { ...baseEnv(home), PORT: String(port) }
  let cmd, args
  if (kind === 'node') {
    cmd = process.execPath
    args = [path.join(REPO, 'dist', 'server', 'index.js')]
  } else {
    cmd = path.join(REPO, 'target', 'release', 'freshell-server')
    args = []
    env.FRESHELL_CLIENT_DIR = path.join(REPO, 'dist', 'client')
  }
  const logPath = path.join(LOGS_DIR, `server-${kind}.log`)
  const logFd = fs.openSync(logPath, 'a')
  const child = spawn(cmd, args, {
    // The §5.1/§5.2 recipes run from the checkout. This matters for the node
    // original: its extension registry scans $CWD/extensions (the 5-entry
    // registry) and the CLI detection specs derive from those manifests.
    // Relative screenshot paths also resolve against cwd — identical for both.
    cwd: REPO,
    env,
    stdio: ['ignore', logFd, logFd],
  })
  fs.closeSync(logFd)
  ownedChildren.add(child)
  child.on('exit', () => ownedChildren.delete(child))
  return { kind, port, home, child, baseUrl: `http://127.0.0.1:${port}`, logPath }
}

async function healthGate(server, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${server.baseUrl}/api/health`)
      const text = await res.text()
      if (res.status === 200 && text.includes('"app":"freshell"')) return
    } catch {
      /* not up yet */
    }
    await sleep(250)
  }
  throw new Error(`health gate failed for ${server.kind} on :${server.port} (see ${server.logPath})`)
}

async function stopServer(server) {
  const { child } = server
  if (!child || child.exitCode !== null || child.signalCode) return
  await new Promise((resolve) => {
    const t = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
    }, 8000)
    child.once('exit', () => {
      clearTimeout(t)
      resolve()
    })
    try {
      child.kill('SIGTERM')
    } catch {
      clearTimeout(t)
      resolve()
    }
  })
}

// ── proxy target (script-owned tiny HTTP server) ─────────────────────────────
function startProxyTarget() {
  const srv = http.createServer((req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/x-qa-demo',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "frame-ancestors 'none'",
      'Content-Security-Policy-Report-Only': "default-src 'self'",
      'X-Qa-Marker': 'yes',
    })
    res.end(`qa-target ${req.method} ${req.url}`)
  })
  return new Promise((resolve, reject) => {
    srv.once('error', reject)
    srv.listen(PROXY_TARGET_PORT, '127.0.0.1', () => resolve(srv))
  })
}

function assertPortUnbound(port) {
  return new Promise((resolve, reject) => {
    const sock = new net.Socket()
    sock.setTimeout(500)
    sock.once('connect', () => {
      sock.destroy()
      reject(new Error(`port ${port} unexpectedly has a listener; refusing to use it as the dead port`))
    })
    sock.once('error', () => resolve())
    sock.once('timeout', () => {
      sock.destroy()
      resolve()
    })
    sock.connect(port, '127.0.0.1')
  })
}

// ── HTTP case runner ─────────────────────────────────────────────────────────
const HEADERS_OF_INTEREST = [
  'content-type',
  'cache-control',
  'x-frame-options',
  'content-security-policy',
  'content-security-policy-report-only',
  'x-qa-marker',
]

async function doRequest(baseUrl, spec) {
  const headers = { ...(spec.headers || {}) }
  if (spec.auth === 'header') headers['x-auth-token'] = TOKEN
  else if (spec.auth === 'cookie') headers['cookie'] = `freshell-auth=${TOKEN}`
  else if (spec.auth === 'bad') headers['x-auth-token'] = BAD_TOKEN
  else if (spec.auth === 'bad-cookie') headers['cookie'] = `freshell-auth=${BAD_TOKEN}`
  let body
  if (spec.json !== undefined) {
    headers['content-type'] = 'application/json'
    body = JSON.stringify(spec.json)
  }
  const url = baseUrl + spec.path.replace('<TOKEN>', TOKEN)
  const res = await fetch(url, {
    method: spec.method || 'GET',
    headers,
    body,
    redirect: 'manual',
  })
  const buf = Buffer.from(await res.arrayBuffer())
  const outHeaders = {}
  for (const h of HEADERS_OF_INTEREST) {
    const v = res.headers.get(h)
    if (v !== null) outHeaders[h] = scrubString(v)
  }
  // Body representation is INDEPENDENT of the content-type header (the two
  // implementations disagree on charset suffixes; that divergence is captured
  // via the header comparison, not by skewing the body comparison):
  //   1. parses as JSON  -> normalized JSON tree
  //   2. small utf-8 text -> scrubbed text
  //   3. anything else    -> sha256 of the raw bytes
  let bodyRepr
  const utf8 = buf.toString('utf8')
  let parsed
  try {
    parsed = JSON.parse(utf8)
    bodyRepr = { kind: 'json', json: normalizeJson(parsed) }
  } catch {
    if (buf.length <= 2000 && !utf8.includes('\uFFFD')) {
      bodyRepr = { kind: 'text', text: scrubString(utf8) }
    } else {
      bodyRepr = {
        kind: 'sha256',
        sha256: crypto.createHash('sha256').update(buf).digest('hex'),
        bytes: buf.length,
      }
    }
  }
  return { status: res.status, headers: outHeaders, body: bodyRepr }
}

const results = []
let servers = {}

async function runCase(spec) {
  // Optional per-side hooks isolate filesystem side effects when both servers
  // share a working directory (screenshot outputs) while keeping the REQUESTS
  // byte-identical.
  if (spec.beforeSide) await spec.beforeSide('node')
  const nodeRes = await doRequest(servers.node.baseUrl, spec)
  if (spec.afterSide) await spec.afterSide('node', nodeRes)
  if (spec.beforeSide) await spec.beforeSide('rust')
  const rustRes = await doRequest(servers.rust.baseUrl, spec)
  if (spec.afterSide) await spec.afterSide('rust', rustRes)
  return recordCase(spec, nodeRes, rustRes)
}

function recordCase(spec, nodeRes, rustRes) {
  const diffs = deepDiff(
    { status: nodeRes.status, headers: nodeRes.headers, body: nodeRes.body },
    { status: rustRes.status, headers: rustRes.headers, body: rustRes.body },
  )
  const verdict = spec.deferred ? 'DEFERRED' : diffs.length === 0 ? 'PASS' : 'DIVERGENCE'
  const entry = {
    id: spec.id,
    group: spec.group,
    description: spec.description,
    request: {
      method: spec.method || 'GET',
      path: spec.path,
      auth: spec.auth || 'none',
      ...(spec.json !== undefined ? { json: spec.json } : {}),
    },
    node: nodeRes,
    rust: rustRes,
    verdict,
    diffs,
    ...(spec.note ? { note: spec.note } : {}),
  }
  results.push(entry)
  const mark = verdict === 'PASS' ? 'PASS       ' : verdict === 'DEFERRED' ? 'DEFERRED   ' : 'DIVERGENCE '
  console.log(`${mark} ${spec.id}`)
  if (verdict === 'DIVERGENCE') {
    for (const d of diffs.slice(0, 8)) {
      console.log(`    ${d.path}: node=${JSON.stringify(d.node)} rust=${JSON.stringify(d.rust)}`)
    }
    if (diffs.length > 8) console.log(`    ... ${diffs.length - 8} more diffs`)
  }
  return entry
}

function recordManual(spec, nodeObs, rustObs) {
  return recordCase(spec, nodeObs, rustObs)
}

function recordDeferred(spec, reason) {
  results.push({
    id: spec.id,
    group: spec.group,
    description: spec.description,
    request: spec.request || {},
    verdict: 'DEFERRED',
    reason,
    diffs: [],
  })
  console.log(`DEFERRED    ${spec.id} — ${reason}`)
}

// ── WS helpers ───────────────────────────────────────────────────────────────
function wsProbe(baseUrl, hello, { waitMs = 6000 } = {}) {
  // Connect, send the given hello frame, capture inbound frames + close event.
  const wsUrl = baseUrl.replace('http://', 'ws://') + '/ws'
  return new Promise((resolve) => {
    const frames = []
    let closed = null
    const ws = new WebSocket(wsUrl)
    const finish = () => resolve({ frames, close: closed })
    const timer = setTimeout(() => {
      try {
        ws.close()
      } catch {
        /* noop */
      }
      setTimeout(finish, 200)
    }, waitMs)
    ws.on('message', (data) => {
      try {
        frames.push(JSON.parse(data.toString()))
      } catch {
        frames.push({ __unparseable: data.toString() })
      }
    })
    ws.on('close', (code, reason) => {
      closed = { code, reason: reason.toString() }
      clearTimeout(timer)
      finish()
    })
    ws.on('error', () => {
      /* close handler still fires */
    })
    ws.on('open', () => ws.send(JSON.stringify(hello)))
  })
}

class UiScreenshotClient {
  constructor(baseUrl) {
    this.baseUrl = baseUrl
    this.mode = 'ok'
    this.commands = []
    this.ws = null
  }
  connect() {
    const wsUrl = this.baseUrl.replace('http://', 'ws://') + '/ws'
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl)
      this.ws = ws
      const timer = setTimeout(() => reject(new Error('ws open/ready timeout')), 10_000)
      ws.on('message', (data) => {
        let msg
        try {
          msg = JSON.parse(data.toString())
        } catch {
          return
        }
        if (msg.type === 'ready') {
          clearTimeout(timer)
          resolve()
        }
        if (msg.type === 'ui.command' && msg.command === 'screenshot.capture') {
          this.commands.push(msg)
          const requestId = msg.payload?.requestId
          const reply =
            this.mode === 'ok'
              ? {
                  type: 'ui.screenshot.result',
                  requestId,
                  ok: true,
                  mimeType: 'image/png',
                  imageBase64: PNG_1X1,
                  width: 1,
                  height: 1,
                  changedFocus: false,
                  restoredFocus: false,
                }
              : { type: 'ui.screenshot.result', requestId, ok: false, error: 'qa-forced-failure' }
          ws.send(JSON.stringify(reply))
        }
      })
      ws.on('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
      ws.on('open', () => {
        ws.send(
          JSON.stringify({
            type: 'hello',
            token: TOKEN,
            protocolVersion: WS_PROTOCOL_VERSION,
            capabilities: { uiScreenshotV1: true },
          }),
        )
      })
    })
  }
  close() {
    try {
      this.ws?.close()
    } catch {
      /* noop */
    }
  }
}

/**
 * Create a shell terminal over WS (`terminal.create` → `terminal.created`),
 * optionally driving one input line, then close the socket (the terminal keeps
 * running detached — hasClients:false on both sides). Returns the terminalId.
 */
function createTerminalWs(baseUrl, { input } = {}) {
  const wsUrl = baseUrl.replace('http://', 'ws://') + '/ws'
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    const requestId = crypto.randomUUID()
    const timer = setTimeout(() => {
      try {
        ws.close()
      } catch {
        /* noop */
      }
      reject(new Error('terminal.create timeout'))
    }, 15_000)
    ws.on('message', (data) => {
      let msg
      try {
        msg = JSON.parse(data.toString())
      } catch {
        return
      }
      if (msg.type === 'ready') {
        ws.send(JSON.stringify({ type: 'terminal.create', requestId, mode: 'shell', shell: 'system' }))
      }
      if (msg.type === 'terminal.created' && msg.requestId === requestId) {
        const terminalId = msg.terminalId
        if (input) ws.send(JSON.stringify({ type: 'terminal.input', terminalId, data: input }))
        // give the input a beat to reach the PTY before dropping the socket
        setTimeout(() => {
          clearTimeout(timer)
          try {
            ws.close()
          } catch {
            /* noop */
          }
          resolve(terminalId)
        }, 300)
      }
    })
    ws.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    ws.on('open', () =>
      ws.send(JSON.stringify({ type: 'hello', token: TOKEN, protocolVersion: WS_PROTOCOL_VERSION })),
    )
  })
}

/** Poll GET /api/terminals until the terminal's lastLine equals `marker`. */
async function waitForLastLine(baseUrl, terminalId, marker, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(baseUrl + '/api/terminals', { headers: { 'x-auth-token': TOKEN } })
      if (res.ok) {
        const arr = await res.json()
        const item = Array.isArray(arr) ? arr.find((t) => t.terminalId === terminalId) : null
        if (item && item.lastLine === marker) return true
      }
    } catch {
      /* retry */
    }
    await sleep(200)
  }
  return false
}

class BroadcastObserver {
  constructor(baseUrl) {
    this.baseUrl = baseUrl
    this.frames = []
    this.ws = null
  }
  connect() {
    const wsUrl = this.baseUrl.replace('http://', 'ws://') + '/ws'
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl)
      this.ws = ws
      const timer = setTimeout(() => reject(new Error('observer open/ready timeout')), 10_000)
      ws.on('message', (data) => {
        let msg
        try {
          msg = JSON.parse(data.toString())
        } catch {
          return
        }
        this.frames.push(msg)
        if (msg.type === 'ready') {
          clearTimeout(timer)
          resolve()
        }
      })
      ws.on('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
      ws.on('open', () =>
        ws.send(JSON.stringify({ type: 'hello', token: TOKEN, protocolVersion: WS_PROTOCOL_VERSION })),
      )
    })
  }
  async waitForType(type, timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const found = this.frames.find((f) => f.type === type)
      if (found) return found
      await sleep(100)
    }
    return null
  }
  clear() {
    this.frames.length = 0
  }
  close() {
    try {
      this.ws?.close()
    } catch {
      /* noop */
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── orphan check ─────────────────────────────────────────────────────────────
async function orphanReport() {
  const { execFile } = await import('node:child_process')
  const run = (cmd, args) =>
    new Promise((resolve) => execFile(cmd, args, (err, stdout) => resolve(stdout || '')))
  const rust = await run('pgrep', ['-x', 'freshell-server'])
  const node = await run('pgrep', ['-f', 'dist/server/index[.]js'])
  const ss = await run('bash', ['-c', 'ss -ltnp 2>/dev/null | grep 1787 || true'])
  return { pgrepRust: rust.trim(), pgrepNodeDist: node.trim(), ssListeners: ss.trim() }
}

// ── the sweep ────────────────────────────────────────────────────────────────
async function main() {
  const outPath =
    process.argv.includes('--out')
      ? process.argv[process.argv.indexOf('--out') + 1]
      : path.join(__dirname, `results-${new Date().toISOString().slice(0, 10)}.json`)

  console.log(`REST parity sweep — node :${NODE_PORT} vs rust :${RUST_PORT}`)
  console.log(`scratch homes: ${HOME_NODE} | ${HOME_RUST}`)

  await assertPortUnbound(PROXY_DEAD_PORT)
  await fsp.mkdir(LOGS_DIR, { recursive: true })
  await fsp.rm(SHOTS_DIR, { recursive: true, force: true })
  await fsp.mkdir(SHOTS_DIR, { recursive: true })
  // Pre-existing screenshot output for the 409 case (shared cwd; per-side hooks
  // keep other screenshot outputs isolated between the two servers).
  await fsp.writeFile(path.join(SHOTS_DIR, 'dup.png'), Buffer.from(PNG_1X1, 'base64'))
  await seedHome(HOME_NODE)
  await seedHome(HOME_RUST)

  const proxyTarget = await startProxyTarget()
  servers = { node: spawnServer('node'), rust: spawnServer('rust') }

  try {
    await Promise.all([healthGate(servers.node), healthGate(servers.rust)])
    console.log('both servers healthy\n')

    // 1. /api/health (unauthenticated; shape+value parity — T0 owns instanceId==ready.serverInstanceId)
    await runCase({ id: 'health.happy', group: 'health', description: 'GET /api/health unauthenticated', path: '/api/health' })
    await runCase({ id: 'health.bad-auth', group: 'health', description: 'health ignores a bad token (mounted before auth)', path: '/api/health', auth: 'bad' })

    // 2. /api/version
    await runCase({ id: 'version.happy', group: 'version', description: 'GET /api/version with header auth', path: '/api/version', auth: 'header' })
    await runCase({ id: 'version.cookie-auth', group: 'version', description: 'GET /api/version with cookie auth', path: '/api/version', auth: 'cookie' })
    await runCase({ id: 'version.no-auth', group: 'version', description: '401 shape without credentials', path: '/api/version' })
    await runCase({ id: 'version.bad-auth', group: 'version', description: '401 with a wrong header token', path: '/api/version', auth: 'bad' })
    await runCase({ id: 'version.bad-cookie', group: 'version', description: '401 with a wrong cookie token', path: '/api/version', auth: 'bad-cookie' })

    // 4. /api/platform (same host → availableClis must be equal)
    await runCase({ id: 'platform.happy', group: 'platform', description: 'GET /api/platform', path: '/api/platform', auth: 'header' })
    await runCase({ id: 'platform.no-auth', group: 'platform', description: '401 without credentials', path: '/api/platform' })
    await runCase({ id: 'platform.bad-auth', group: 'platform', description: '401 with bad token', path: '/api/platform', auth: 'bad' })

    // 4b. /api/bootstrap (task-005e: found untested by the win spot-sweep —
    // the shell-critical first-paint payload incl. `shell.ready`/`shell.tasks`
    // (`startupState.snapshot().tasks`) and `perf.logging`)
    await runCase({ id: 'bootstrap.happy', group: 'bootstrap', description: 'GET /api/bootstrap: settings+platform+shell{ready,tasks}+perf', path: '/api/bootstrap', auth: 'header' })
    await runCase({ id: 'bootstrap.no-auth', group: 'bootstrap', description: '401 without credentials', path: '/api/bootstrap' })

    // 4c. POST /api/logs/client (task-005e: found untested — strict zod
    // ClientLogsPayloadSchema; 204 on success, 400 {error,details} on failure)
    await runCase({ id: 'logsclient.valid', group: 'logsclient', description: '204 on a valid payload', method: 'POST', path: '/api/logs/client', auth: 'header', json: { entries: [{ timestamp: '2026-01-01T00:00:00.000Z', severity: 'info', message: 'sweep parity probe' }] } })
    await runCase({ id: 'logsclient.valid.client', group: 'logsclient', description: '204 with client info object', method: 'POST', path: '/api/logs/client', auth: 'header', json: { client: { id: 'sweep', userAgent: 'ua' }, entries: [{ timestamp: 't', severity: 'debug', event: 'e' }] } })
    await runCase({ id: 'logsclient.entry-unknown-key', group: 'logsclient', description: 'entry unknown keys are stripped (204)', method: 'POST', path: '/api/logs/client', auth: 'header', json: { entries: [{ timestamp: 't', severity: 'warn', bogus: 1 }] } })
    await runCase({ id: 'logsclient.missing-entries', group: 'logsclient', description: '400 invalid_type entries undefined', method: 'POST', path: '/api/logs/client', auth: 'header', json: {} })
    await runCase({ id: 'logsclient.entries-empty', group: 'logsclient', description: '400 too_small (min 1)', method: 'POST', path: '/api/logs/client', auth: 'header', json: { entries: [] } })
    await runCase({ id: 'logsclient.entries-too-big', group: 'logsclient', description: '400 too_big (max 200)', method: 'POST', path: '/api/logs/client', auth: 'header', json: { entries: Array.from({ length: 201 }, () => ({ timestamp: 't', severity: 'info' })) } })
    await runCase({ id: 'logsclient.bad-severity', group: 'logsclient', description: '400 invalid_value enum', method: 'POST', path: '/api/logs/client', auth: 'header', json: { entries: [{ timestamp: 't', severity: 'fatal' }] } })
    await runCase({ id: 'logsclient.bad-types', group: 'logsclient', description: '400 per-field invalid_type battery in schema order', method: 'POST', path: '/api/logs/client', auth: 'header', json: { entries: [{ timestamp: 5, severity: 'info', message: 7, event: 8, consoleMethod: 9, args: 'no', stack: 10, context: 'no' }] } })
    await runCase({ id: 'logsclient.combined-order', group: 'logsclient', description: '400 issue ordering: client → entry fields → unrecognized_keys', method: 'POST', path: '/api/logs/client', auth: 'header', json: { entries: [{ timestamp: 5, severity: 'bad' }], zzz: 1, client: 5 } })
    await runCase({ id: 'logsclient.unknown-top', group: 'logsclient', description: '400 strict unrecognized_keys (plural message)', method: 'POST', path: '/api/logs/client', auth: 'header', json: { entries: [{ timestamp: 't', severity: 'info' }], extra: 1, logs: 2 } })
    await runCase({ id: 'logsclient.top-array', group: 'logsclient', description: '400 invalid_type: array passes express, fails zod', method: 'POST', path: '/api/logs/client', auth: 'header', json: [1, 2] })
    await runCase({ id: 'logsclient.no-auth', group: 'logsclient', description: '401 without credentials', method: 'POST', path: '/api/logs/client', json: { entries: [{ timestamp: 't', severity: 'info' }] } })

    // 5. /api/extensions
    const extList = await runCase({ id: 'extensions.list', group: 'extensions', description: '5-entry registry, exact shape', path: '/api/extensions', auth: 'header' })
    await runCase({ id: 'extensions.no-auth', group: 'extensions', description: '401 without credentials', path: '/api/extensions' })
    const firstExt =
      extList.node.body.kind === 'json' && Array.isArray(extList.node.body.json) && extList.node.body.json[0]?.name
    if (firstExt) {
      await runCase({ id: 'extensions.single', group: 'extensions', description: 'GET /api/extensions/:name happy', path: `/api/extensions/${extList.node.body.json[0].name}`, auth: 'header' })
    } else {
      recordDeferred({ id: 'extensions.single', group: 'extensions', description: 'GET /api/extensions/:name happy' }, 'could not derive an extension name from the node registry response')
    }
    await runCase({ id: 'extensions.single.missing', group: 'extensions', description: '404 for unknown extension', path: '/api/extensions/does-not-exist', auth: 'header' })

    // 6. /api/files/*
    await runCase({ id: 'files.read.happy', group: 'files', description: 'read seeded file via ~', path: '/api/files/read?path=' + encodeURIComponent('~/qa-files/hello.txt'), auth: 'header' })
    await runCase({ id: 'files.read.missing', group: 'files', description: '404 for missing file', path: '/api/files/read?path=' + encodeURIComponent('~/qa-files/nope.txt'), auth: 'header' })
    await runCase({ id: 'files.read.directory', group: 'files', description: '400 directory-vs-file', path: '/api/files/read?path=' + encodeURIComponent('~/qa-files'), auth: 'header' })
    await runCase({ id: 'files.read.nopath', group: 'files', description: '400 when path param missing', path: '/api/files/read', auth: 'header' })
    await runCase({ id: 'files.read.no-auth', group: 'files', description: '401 without credentials', path: '/api/files/read?path=' + encodeURIComponent('~/qa-files/hello.txt') })
    await runCase({ id: 'files.stat.happy', group: 'files', description: 'stat existing file', path: '/api/files/stat?path=' + encodeURIComponent('~/qa-files/hello.txt'), auth: 'header' })
    await runCase({ id: 'files.stat.missing', group: 'files', description: 'stat missing → exists:false (200)', path: '/api/files/stat?path=' + encodeURIComponent('~/qa-files/nope.txt'), auth: 'header' })
    await runCase({ id: 'files.stat.directory', group: 'files', description: 'stat dir → exists:false (200)', path: '/api/files/stat?path=' + encodeURIComponent('~/qa-files'), auth: 'header' })
    await runCase({ id: 'files.stat.nopath', group: 'files', description: '400 when path param missing', path: '/api/files/stat', auth: 'header' })
    await runCase({ id: 'files.write.happy', group: 'files', description: 'atomic write', method: 'POST', path: '/api/files/write', auth: 'header', json: { path: '~/qa-files/written.txt', content: 'atomic write parity check\nline2\n' } })
    await runCase({ id: 'files.write.readback', group: 'files', description: 'read-back of written file (write-then-read both sides)', path: '/api/files/read?path=' + encodeURIComponent('~/qa-files/written.txt'), auth: 'header' })
    await runCase({ id: 'files.write.nopath', group: 'files', description: '400 when path missing', method: 'POST', path: '/api/files/write', auth: 'header', json: { content: 'x' } })
    await runCase({ id: 'files.write.nocontent', group: 'files', description: '400 when content missing', method: 'POST', path: '/api/files/write', auth: 'header', json: { path: '~/qa-files/x.txt' } })
    await runCase({ id: 'files.complete.dir', group: 'files', description: 'complete on a directory prefix', path: '/api/files/complete?prefix=' + encodeURIComponent('~/qa-files/'), auth: 'header' })
    await runCase({ id: 'files.complete.partial', group: 'files', description: 'complete on partial basename', path: '/api/files/complete?prefix=' + encodeURIComponent('~/qa-files/he'), auth: 'header' })
    await runCase({ id: 'files.complete.dirsonly', group: 'files', description: 'complete dirs=true filter', path: '/api/files/complete?prefix=' + encodeURIComponent('~/qa-files/') + '&dirs=true', auth: 'header' })
    await runCase({ id: 'files.complete.noprefix', group: 'files', description: '400 when prefix missing', path: '/api/files/complete', auth: 'header' })
    await runCase({ id: 'files.complete.missingdir', group: 'files', description: 'ENOENT dir → empty suggestions (200)', path: '/api/files/complete?prefix=' + encodeURIComponent('~/no-such-dir/x'), auth: 'header' })
    await runCase({ id: 'files.mkdir.happy', group: 'files', description: 'mkdir new directory', method: 'POST', path: '/api/files/mkdir', auth: 'header', json: { path: '~/qa-files/newdir' } })
    await runCase({ id: 'files.mkdir.again', group: 'files', description: 'mkdir same directory again (recursive semantics)', method: 'POST', path: '/api/files/mkdir', auth: 'header', json: { path: '~/qa-files/newdir' } })
    await runCase({ id: 'files.mkdir.overfile', group: 'files', description: '409 when path exists as a file', method: 'POST', path: '/api/files/mkdir', auth: 'header', json: { path: '~/qa-files/hello.txt' } })
    await runCase({ id: 'files.mkdir.nopath', group: 'files', description: '400 when path missing', method: 'POST', path: '/api/files/mkdir', auth: 'header', json: {} })
    await runCase({ id: 'files.validate-dir.happy', group: 'files', description: 'validate existing dir', method: 'POST', path: '/api/files/validate-dir', auth: 'header', json: { path: '~/qa-files' } })
    await runCase({ id: 'files.validate-dir.missing', group: 'files', description: 'validate missing dir → valid:false', method: 'POST', path: '/api/files/validate-dir', auth: 'header', json: { path: '~/qa-definitely-missing' } })
    await runCase({ id: 'files.validate-dir.file', group: 'files', description: 'validate a file → valid:false', method: 'POST', path: '/api/files/validate-dir', auth: 'header', json: { path: '~/qa-files/hello.txt' } })
    await runCase({ id: 'files.validate-dir.blank', group: 'files', description: '400 for whitespace-only path', method: 'POST', path: '/api/files/validate-dir', auth: 'header', json: { path: '   ' } })
    await runCase({ id: 'files.validate-dir.nopath', group: 'files', description: '400 when path missing', method: 'POST', path: '/api/files/validate-dir', auth: 'header', json: {} })
    await runCase({ id: 'files.candidate-dirs', group: 'files', description: 'candidate directories (pre-session-seed)', path: '/api/files/candidate-dirs', auth: 'header' })

    // 7. /api/session-directory — empty home first
    // NOTE: the node original REQUIRES ?priority (visible|background). The
    // happy path is priority=visible; the priority-omitted request is a
    // documented-error case (and a known behavioral probe).
    await runCase({ id: 'sd.empty.happy', group: 'session-directory', description: 'empty home page shape (priority=visible)', path: '/api/session-directory?priority=visible', auth: 'header' })
    await runCase({ id: 'sd.empty.background', group: 'session-directory', description: 'priority=background lane', path: '/api/session-directory?priority=background', auth: 'header' })
    await runCase({ id: 'sd.nopriority', group: 'session-directory', description: 'priority omitted (node: 400 required-param)', path: '/api/session-directory', auth: 'header' })
    await runCase({ id: 'sd.badlimit', group: 'session-directory', description: '400 for non-numeric limit', path: '/api/session-directory?priority=visible&limit=abc', auth: 'header' })
    await runCase({ id: 'sd.badpriority', group: 'session-directory', description: '400 for unknown priority', path: '/api/session-directory?priority=bogus', auth: 'header' })
    await runCase({ id: 'sd.badcursor', group: 'session-directory', description: '400 for malformed cursor', path: '/api/session-directory?priority=visible&cursor=garbage', auth: 'header' })
    await runCase({ id: 'sd.no-auth', group: 'session-directory', description: '401 without credentials', path: '/api/session-directory?priority=visible' })

    // seed fixtures + realistic session, wait for both indexers to pick them up
    await seedClaudeSessions(HOME_NODE)
    await seedClaudeSessions(HOME_RUST)
    let seededOk = await waitForSessionCount(1, 30_000)
    let seededVia = 'watcher'
    if (!(seededOk.node && seededOk.rust)) {
      // Watcher did not surface the seed on at least one side — fall back to a
      // boot-time scan (restart both) so the seeded REST comparisons can still
      // run. The watcher gap itself is recorded honestly.
      recordDeferred(
        { id: 'sd.seeded.watcher-pickup', group: 'session-directory', description: 'live watcher pickup of newly seeded session files' },
        `watcher did not surface the seeded realistic session within 30s (node=${seededOk.node}, rust=${seededOk.rust}); falling back to restart/boot-scan for the seeded page comparisons`,
      )
      await stopServer(servers.node)
      await stopServer(servers.rust)
      servers = { node: spawnServer('node'), rust: spawnServer('rust') }
      await Promise.all([healthGate(servers.node), healthGate(servers.rust)])
      seededOk = await waitForSessionCount(1, 30_000)
      seededVia = 'boot-scan'
    }
    console.log(`seeded session surfaced via ${seededVia}: node=${seededOk.node} rust=${seededOk.rust}`)
    if (seededOk.node && seededOk.rust) {
      await runCase({ id: 'sd.seeded.happy', group: 'session-directory', description: 'seeded fixtures page (filters/cursor/revision fields)', path: '/api/session-directory?priority=visible', auth: 'header' })
      await runCase({ id: 'sd.seeded.query', group: 'session-directory', description: 'text query filter', path: '/api/session-directory?priority=visible&query=hello', auth: 'header' })
      await runCase({ id: 'sd.seeded.query-nomatch', group: 'session-directory', description: 'query with no matches', path: '/api/session-directory?priority=visible&query=zzzznomatch', auth: 'header' })
      await runCase({ id: 'sd.seeded.include-flags', group: 'session-directory', description: 'includeSubagents/includeNonInteractive/includeEmpty flags', path: '/api/session-directory?priority=visible&includeSubagents=true&includeNonInteractive=true&includeEmpty=true', auth: 'header' })
      await runCase({ id: 'sd.seeded.limit', group: 'session-directory', description: 'limit=1 slice', path: '/api/session-directory?priority=visible&limit=1', auth: 'header' })
    } else {
      recordDeferred(
        { id: 'sd.seeded.*', group: 'session-directory', description: 'seeded-fixtures cases' },
        `indexer did not surface the seeded session within 30s (node=${seededOk.node}, rust=${seededOk.rust}) — recorded honestly rather than comparing unsettled state`,
      )
    }

    // 8. /api/network/status (READ-ONLY)
    await runCase({ id: 'network.status.happy', group: 'network', description: 'full NetworkStatus shape (read-only)', path: '/api/network/status', auth: 'header' })
    await runCase({ id: 'network.status.no-auth', group: 'network', description: '401 without credentials', path: '/api/network/status' })

    // 9. /api/proxy/http/{port}/*
    await runCase({ id: 'proxy.happy', group: 'proxy', description: 'headers stripped, content-type preserved', path: `/api/proxy/http/${PROXY_TARGET_PORT}/hello?x=1`, auth: 'header' })
    await runCase({ id: 'proxy.cookie-auth', group: 'proxy', description: 'cookie-vs-header auth (cookie works)', path: `/api/proxy/http/${PROXY_TARGET_PORT}/cookie-path`, auth: 'cookie' })
    await runCase({ id: 'proxy.no-auth', group: 'proxy', description: '401 without credentials', path: `/api/proxy/http/${PROXY_TARGET_PORT}/hello` })
    await runCase({ id: 'proxy.badport.oversize', group: 'proxy', description: '400 for port 99999', path: '/api/proxy/http/99999/', auth: 'header' })
    await runCase({ id: 'proxy.badport.nan', group: 'proxy', description: '400 for non-numeric port', path: '/api/proxy/http/abc/', auth: 'header' })
    await runCase({ id: 'proxy.deadport', group: 'proxy', description: `502 for dead port ${PROXY_DEAD_PORT}`, path: `/api/proxy/http/${PROXY_DEAD_PORT}/`, auth: 'header' })

    // 10. /api/screenshots — validation + 409/503 without a UI client
    await runCase({ id: 'shots.badscope', group: 'screenshots', description: '400 invalid scope', method: 'POST', path: '/api/screenshots', auth: 'header', json: { scope: 'bogus', name: 'x' } })
    await runCase({ id: 'shots.pane-no-paneid', group: 'screenshots', description: '400 pane scope without paneId', method: 'POST', path: '/api/screenshots', auth: 'header', json: { scope: 'pane', name: 'x' } })
    await runCase({ id: 'shots.tab-no-tabid', group: 'screenshots', description: '400 tab scope without tabId', method: 'POST', path: '/api/screenshots', auth: 'header', json: { scope: 'tab', name: 'x' } })
    await runCase({ id: 'shots.emptyname', group: 'screenshots', description: '400 empty name', method: 'POST', path: '/api/screenshots', auth: 'header', json: { scope: 'view', name: '' } })
    await runCase({ id: 'shots.sep-in-name', group: 'screenshots', description: '400 name with path separator', method: 'POST', path: '/api/screenshots', auth: 'header', json: { scope: 'view', name: 'a/b' } })
    await runCase({ id: 'shots.dup409', group: 'screenshots', description: '409 pre-existing output without overwrite', method: 'POST', path: '/api/screenshots', auth: 'header', json: { scope: 'view', name: 'dup', path: SHOTS_REL } })
    await runCase({ id: 'shots.noclient503', group: 'screenshots', description: '503 with no screenshot-capable client', method: 'POST', path: '/api/screenshots', auth: 'header', json: { scope: 'view', name: 'noclient', path: SHOTS_REL } })
    await runCase({ id: 'shots.no-auth', group: 'screenshots', description: '401 without credentials', method: 'POST', path: '/api/screenshots', json: { scope: 'view', name: 'x' } })

    // 10b. ui.command / ui.screenshot.result WS round-trip via a participating client
    const uiNode = new UiScreenshotClient(servers.node.baseUrl)
    const uiRust = new UiScreenshotClient(servers.rust.baseUrl)
    try {
      await uiNode.connect()
      await uiRust.connect()
      // Both servers share cwd=REPO, so the output file must be cleared
      // between the two byte-identical requests; the node-side bytes are
      // captured by the afterSide hook before removal.
      const shotBytes = {}
      const rtOkPath = path.join(SHOTS_DIR, 'rt-ok.png')
      await runCase({
        id: 'shots.roundtrip.ok',
        group: 'screenshots',
        description: 'ok envelope through the ui.command/ui.screenshot.result round-trip',
        method: 'POST',
        path: '/api/screenshots',
        auth: 'header',
        json: { scope: 'view', name: 'rt-ok', path: SHOTS_REL },
        beforeSide: async () => fsp.rm(rtOkPath, { force: true }),
        afterSide: async (kind) => {
          shotBytes[kind] = await fsp.readFile(rtOkPath).catch(() => null)
        },
      })
      // compare the captured ui.command frames themselves
      recordManual(
        { id: 'shots.roundtrip.ui-command-frame', group: 'screenshots', description: 'ui.command frame sent to the participating client' },
        { status: 0, headers: {}, body: { kind: 'json', json: normalizeJson(uiNode.commands[0] ?? null) } },
        { status: 0, headers: {}, body: { kind: 'json', json: normalizeJson(uiRust.commands[0] ?? null) } },
      )
      // written PNG bytes identical on both sides
      recordManual(
        { id: 'shots.roundtrip.file-bytes', group: 'screenshots', description: 'screenshot written to disk; bytes sha256-equal' },
        { status: 0, headers: {}, body: { kind: 'sha256', sha256: shotBytes.node ? sha256(shotBytes.node) : 'MISSING', bytes: shotBytes.node?.length ?? 0 } },
        { status: 0, headers: {}, body: { kind: 'sha256', sha256: shotBytes.rust ? sha256(shotBytes.rust) : 'MISSING', bytes: shotBytes.rust?.length ?? 0 } },
      )
      await runCase({
        id: 'shots.roundtrip.overwrite',
        group: 'screenshots',
        description: 'overwrite:true replaces the pre-existing dup.png',
        method: 'POST',
        path: '/api/screenshots',
        auth: 'header',
        json: { scope: 'view', name: 'dup', path: SHOTS_REL, overwrite: true },
        beforeSide: async () => fsp.writeFile(path.join(SHOTS_DIR, 'dup.png'), Buffer.from(PNG_1X1, 'base64')),
      })
      uiNode.mode = 'fail'
      uiRust.mode = 'fail'
      await runCase({ id: 'shots.roundtrip.422', group: 'screenshots', description: '422 when the UI client reports failure', method: 'POST', path: '/api/screenshots', auth: 'header', json: { scope: 'view', name: 'rt-fail', path: SHOTS_REL } })
    } catch (err) {
      recordDeferred(
        { id: 'shots.roundtrip.*', group: 'screenshots', description: 'ui.command/ui.screenshot.result round-trip' },
        `participating WS client failed to connect/handshake: ${err.message}`,
      )
    } finally {
      uiNode.close()
      uiRust.close()
    }

    // 3. /api/settings — GET/PUT, enum failures, broadcast, sandbox, persistence
    await runCase({ id: 'settings.get.default', group: 'settings', description: 'default settings shape', path: '/api/settings', auth: 'header' })
    await runCase({ id: 'settings.no-auth', group: 'settings', description: '401 without credentials', path: '/api/settings' })

    const obsNode = new BroadcastObserver(servers.node.baseUrl)
    const obsRust = new BroadcastObserver(servers.rust.baseUrl)
    let broadcastReady = false
    try {
      await obsNode.connect()
      await obsRust.connect()
      // RULING 3(a) — antagonist adjudication
      // `0000000000000000-dc849de1bd584a39_self-driving-reviewer` (2026-07-11):
      // `connect()` resolves as soon as the `ready` frame lands, but each side's
      // OWN post-hello handshake snapshot still emits a `settings.updated` frame
      // shortly after — asynchronously, not yet guaranteed to have arrived. A
      // `clear()` issued immediately after `connect()` therefore raced that
      // still-in-flight snapshot: if it landed in the buffer AFTER the clear
      // (and before/alongside the PUT-triggered broadcast), the `.put` row's
      // `waitForType('settings.updated')` could return the stale handshake
      // snapshot instead of the PUT-triggered one — a handshake-vs-broadcast
      // lottery. Fix (mirrors the `.patch` row's protocol, which only clears
      // AFTER the prior expected frame has been explicitly consumed): wait for
      // and consume each side's handshake `settings.updated` HERE, so the
      // `clear()` below is draining a frame we know already arrived, not
      // racing one still in flight. This makes the `.put` row's broadcast
      // capture deterministic.
      await Promise.all([obsNode.waitForType('settings.updated'), obsRust.waitForType('settings.updated')])
      broadcastReady = true
    } catch (err) {
      recordDeferred(
        { id: 'settings.updated-broadcast', group: 'settings', description: 'settings.updated WS broadcast on PUT' },
        `broadcast observer failed to connect: ${err.message}`,
      )
    }
    obsNode.clear()
    obsRust.clear()
    await runCase({ id: 'settings.put.happy', group: 'settings', description: 'PUT safety.autoKillIdleMinutes=20', method: 'PUT', path: '/api/settings', auth: 'header', json: { safety: { autoKillIdleMinutes: 20 } } })
    if (broadcastReady) {
      const [bNode, bRust] = await Promise.all([
        obsNode.waitForType('settings.updated'),
        obsRust.waitForType('settings.updated'),
      ])
      recordManual(
        { id: 'settings.updated-broadcast.put', group: 'settings', description: 'settings.updated WS broadcast observed on PUT' },
        { status: 0, headers: {}, body: { kind: 'json', json: normalizeJson(bNode) } },
        { status: 0, headers: {}, body: { kind: 'json', json: normalizeJson(bRust) } },
      )
      obsNode.clear()
      obsRust.clear()
    }
    await runCase({ id: 'settings.patch.happy', group: 'settings', description: 'PATCH safety.autoKillIdleMinutes=25 (same handler as PUT on the original)', method: 'PATCH', path: '/api/settings', auth: 'header', json: { safety: { autoKillIdleMinutes: 25 } } })
    if (broadcastReady) {
      const [bNode, bRust] = await Promise.all([
        obsNode.waitForType('settings.updated'),
        obsRust.waitForType('settings.updated'),
      ])
      recordManual(
        { id: 'settings.updated-broadcast.patch', group: 'settings', description: 'settings.updated WS broadcast observed on PATCH' },
        { status: 0, headers: {}, body: { kind: 'json', json: normalizeJson(bNode) } },
        { status: 0, headers: {}, body: { kind: 'json', json: normalizeJson(bRust) } },
      )
    }
    await runCase({ id: 'settings.get.after-put', group: 'settings', description: 'GET reflects the patches', path: '/api/settings', auth: 'header' })
    await runCase({ id: 'settings.put.enum-invalid', group: 'settings', description: '400 enum validation failure (editor.externalEditor=bogus)', method: 'PUT', path: '/api/settings', auth: 'header', json: { editor: { externalEditor: 'bogus' } } })
    await runCase({ id: 'settings.put.type-invalid', group: 'settings', description: '400 type failure (allowedFilePaths not an array)', method: 'PUT', path: '/api/settings', auth: 'header', json: { allowedFilePaths: 'not-an-array' } })
    await runCase({ id: 'settings.put.agentchat-migrated', group: 'settings', description: '400 for migrated agentChat key', method: 'PUT', path: '/api/settings', auth: 'header', json: { agentChat: {} } })
    await runCase({ id: 'settings.put.nested-enum-invalid', group: 'settings', description: '400 nested enum failure (panes.defaultNewPane=bogus)', method: 'PUT', path: '/api/settings', auth: 'header', json: { panes: { defaultNewPane: 'bogus' } } })
    await runCase({ id: 'settings.put.client-key-rejected', group: 'settings', description: '400 client-only key (theme) rejected by strict server schema', method: 'PUT', path: '/api/settings', auth: 'header', json: { theme: 'dark' } })
    await runCase({ id: 'settings.put.unknown-key', group: 'settings', description: '400 unknown top-level key (strict schema)', method: 'PUT', path: '/api/settings', auth: 'header', json: { totallyUnknownKey: true } })

    // allowedFilePaths sandbox behavior (toggled via PATCH — same handler as
    // PUT on the original; keeps the sandbox probes decoupled from any
    // PUT-method divergence)
    await runCase({ id: 'settings.patch.sandbox-on', group: 'settings', description: 'enable allowedFilePaths sandbox', method: 'PATCH', path: '/api/settings', auth: 'header', json: { allowedFilePaths: ['~/qa-files'] } })
    await runCase({ id: 'files.sandbox.allowed', group: 'files', description: 'read inside sandbox → 200', path: '/api/files/read?path=' + encodeURIComponent('~/qa-files/hello.txt'), auth: 'header' })
    await runCase({ id: 'files.sandbox.denied-read', group: 'files', description: 'read outside sandbox → 403', path: '/api/files/read?path=' + encodeURIComponent('~/outside.txt'), auth: 'header' })
    await runCase({ id: 'files.sandbox.denied-complete', group: 'files', description: 'complete outside sandbox → 403', path: '/api/files/complete?prefix=' + encodeURIComponent('~/'), auth: 'header' })
    await runCase({ id: 'files.sandbox.denied-write', group: 'files', description: 'write outside sandbox → 403', method: 'POST', path: '/api/files/write', auth: 'header', json: { path: '~/outside2.txt', content: 'nope' } })
    await runCase({ id: 'files.sandbox.denied-mkdir', group: 'files', description: 'mkdir outside sandbox → 403', method: 'POST', path: '/api/files/mkdir', auth: 'header', json: { path: '~/qa-outside-dir' } })
    await runCase({ id: 'settings.patch.sandbox-off', group: 'settings', description: 'clear allowedFilePaths sandbox', method: 'PATCH', path: '/api/settings', auth: 'header', json: { allowedFilePaths: [] } })
    await runCase({ id: 'files.sandbox.cleared', group: 'files', description: 'outside path readable again', path: '/api/files/read?path=' + encodeURIComponent('~/outside.txt'), auth: 'header' })

    // codingCli provider-name validation (allowlist = boot-discovered CLI
    // extension names — the sweep boots both servers with cwd=repo, so the 5
    // bundled extensions are the allowlist on BOTH sides) + knownProviders
    // patch-wins semantics. Shapes/order pinned live 2026-07-12 (M/E battery,
    // task-005e part 2).
    await runCase({ id: 'settings.patch.provider-bogus', group: 'settings', description: '400 unknown CLI provider in enabledProviders (custom zod issue)', method: 'PATCH', path: '/api/settings', auth: 'header', json: { codingCli: { enabledProviders: ['claude', 'bogus'] } } })
    await runCase({ id: 'settings.patch.provider-multi-issue', group: 'settings', description: '400 aggregated issues: enabledProviders → knownProviders → providers record key', method: 'PATCH', path: '/api/settings', auth: 'header', json: { codingCli: { enabledProviders: ['bogusA'], knownProviders: ['bogusB'], providers: { bogusC: {} } } } })
    await runCase({ id: 'settings.patch.provider-mixed-types', group: 'settings', description: '400 per-item invalid_type + custom issues in item order', method: 'PATCH', path: '/api/settings', auth: 'header', json: { codingCli: { knownProviders: [42, 'bogus', 'claude'] } } })
    await runCase({ id: 'settings.patch.provider-empty-string', group: 'settings', description: "400 '' yields too_small AND the custom allowlist issue", method: 'PATCH', path: '/api/settings', auth: 'header', json: { codingCli: { enabledProviders: [''] } } })
    await runCase({ id: 'settings.patch.codingcli-strict', group: 'settings', description: '400 codingCli nested unrecognized key (strict sub-object)', method: 'PATCH', path: '/api/settings', auth: 'header', json: { codingCli: { zzz: 1 } } })
    await runCase({ id: 'settings.patch.unknown-key-last', group: 'settings', description: '400 nested field issue first, top-level unrecognized_keys LAST', method: 'PATCH', path: '/api/settings', auth: 'header', json: { zzz: 1, codingCli: { enabledProviders: ['bogusA'] } } })
    await runCase({ id: 'settings.patch.knownproviders-wins', group: 'settings', description: 'valid knownProviders PATCH replaces the persisted list (patch-wins, live-pinned)', method: 'PATCH', path: '/api/settings', auth: 'header', json: { codingCli: { knownProviders: ['claude'] } } })
    await runCase({ id: 'settings.get.knownproviders-patched', group: 'settings', description: 'GET reflects the patched knownProviders', path: '/api/settings', auth: 'header' })
    await runCase({ id: 'settings.patch.knownproviders-restore', group: 'settings', description: 'restore the full discovered knownProviders list', method: 'PATCH', path: '/api/settings', auth: 'header', json: { codingCli: { knownProviders: ['claude', 'codex', 'gemini', 'kimi', 'opencode'] } } })

    // config.json persisted shape (direct scratch-home read, normalized)
    const cfgNode = JSON.parse(await fsp.readFile(path.join(HOME_NODE, '.freshell', 'config.json'), 'utf8'))
    const cfgRust = JSON.parse(await fsp.readFile(path.join(HOME_RUST, '.freshell', 'config.json'), 'utf8'))
    recordManual(
      { id: 'settings.configjson-shape', group: 'settings', description: 'config.json shape in each scratch home after PUTs' },
      { status: 0, headers: {}, body: { kind: 'json', json: normalizeJson(cfgNode) } },
      { status: 0, headers: {}, body: { kind: 'json', json: normalizeJson(cfgRust) } },
    )

    obsNode.close()
    obsRust.close()

    // 10c. /api/terminals — directory GET (list + read-model page), PATCH/DELETE
    // overrides (server/terminals-router.ts). Terminals are created live over WS
    // (terminal.create) per side; ids are server-minted so real-id PATCH/DELETE
    // requests are per-side (recordManual) while every fixed-path case stays
    // byte-identical. The viewport/scrollback/search read-model subroutes are
    // NOT ported (TerminalViewMirror) — recorded as a deferred deviation, not
    // swept (see port/oracle/DEVIATIONS.md).
    await runCase({ id: 'terminals.empty', group: 'terminals', description: 'empty directory on a boot with no terminals', path: '/api/terminals', auth: 'header' })
    await runCase({ id: 'terminals.page.empty', group: 'terminals', description: 'empty read-model page (priority=visible)', path: '/api/terminals?priority=visible', auth: 'header' })
    await runCase({ id: 'terminals.no-auth', group: 'terminals', description: '401 without credentials', path: '/api/terminals' })
    await runCase({ id: 'terminals.bad-auth', group: 'terminals', description: '401 with bad token', path: '/api/terminals', auth: 'bad' })
    // read-model query validation (exact zod issue objects)
    await runCase({ id: 'terminals.page.nopriority', group: 'terminals', description: 'priority omitted with cursor present → 400 (priority is required)', path: '/api/terminals?cursor=abc', auth: 'header' })
    await runCase({ id: 'terminals.page.badpriority', group: 'terminals', description: '400 unknown priority', path: '/api/terminals?priority=critical', auth: 'header' })
    await runCase({ id: 'terminals.page.cursor-empty', group: 'terminals', description: 'empty cursor → 400 (cursor too_small + priority required)', path: '/api/terminals?cursor=', auth: 'header' })
    await runCase({ id: 'terminals.page.revision-nan', group: 'terminals', description: '400 non-numeric revision', path: '/api/terminals?priority=visible&revision=abc', auth: 'header' })
    await runCase({ id: 'terminals.page.revision-neg', group: 'terminals', description: '400 negative revision', path: '/api/terminals?priority=visible&revision=-1', auth: 'header' })
    await runCase({ id: 'terminals.page.limit-zero', group: 'terminals', description: '400 limit=0 (positive())', path: '/api/terminals?priority=visible&limit=0', auth: 'header' })
    await runCase({ id: 'terminals.page.limit-51', group: 'terminals', description: '400 limit over MAX_DIRECTORY_PAGE_ITEMS', path: '/api/terminals?priority=visible&limit=51', auth: 'header' })
    await runCase({ id: 'terminals.page.limit-float', group: 'terminals', description: '400 non-integer limit (safeint)', path: '/api/terminals?priority=visible&limit=1.5', auth: 'header' })
    await runCase({ id: 'terminals.page.bad-cursor', group: 'terminals', description: '400 undecodable cursor', path: '/api/terminals?cursor=@@@@&priority=visible', auth: 'header' })
    await runCase({ id: 'terminals.page.cursor-wrong-shape', group: 'terminals', description: '400 cursor decodes to wrong JSON shape', path: '/api/terminals?cursor=eyJ4IjoxfQ&priority=visible', auth: 'header' })
    await runCase({ id: 'terminals.page.revision-ok', group: 'terminals', description: 'valid revision param is accepted (and unused)', path: '/api/terminals?priority=visible&revision=5', auth: 'header' })
    // override PATCH/DELETE on a FIXED (nonexistent) id — byte-identical paths;
    // the original keeps overrides for unknown terminals (no 404 anywhere here).
    await runCase({ id: 'terminals.patch.unknown-id', group: 'terminals', description: 'PATCH unknown id → 200 merged override; cleanString trims', method: 'PATCH', path: '/api/terminals/qa-fixed-id', auth: 'header', json: { titleOverride: '  QA Title  ' } })
    await runCase({ id: 'terminals.patch.spread-overwrite', group: 'terminals', description: 'second PATCH drops keys absent from the body (JS-spread undefined overwrite)', method: 'PATCH', path: '/api/terminals/qa-fixed-id', auth: 'header', json: { descriptionOverride: 'D2' } })
    await runCase({ id: 'terminals.patch.empty-body', group: 'terminals', description: 'PATCH {} → 200 {} (all override keys cleared)', method: 'PATCH', path: '/api/terminals/qa-fixed-id', auth: 'header', json: {} })
    await runCase({ id: 'terminals.patch.null-clears', group: 'terminals', description: 'explicit nulls validate and clear (cleanString(null) → undefined)', method: 'PATCH', path: '/api/terminals/qa-fixed-id', auth: 'header', json: { titleOverride: null, descriptionOverride: null } })
    await runCase({ id: 'terminals.patch.whitespace-title', group: 'terminals', description: 'whitespace-only title clears rather than sets', method: 'PATCH', path: '/api/terminals/qa-fixed-id', auth: 'header', json: { titleOverride: '   ', descriptionOverride: 'kept' } })
    await runCase({ id: 'terminals.patch.title-toolong', group: 'terminals', description: '400 titleOverride > 500 chars', method: 'PATCH', path: '/api/terminals/qa-fixed-id', auth: 'header', json: { titleOverride: 'x'.repeat(501) } })
    await runCase({ id: 'terminals.patch.desc-toolong', group: 'terminals', description: '400 descriptionOverride > 2000 chars', method: 'PATCH', path: '/api/terminals/qa-fixed-id', auth: 'header', json: { descriptionOverride: 'y'.repeat(2001) } })
    await runCase({ id: 'terminals.patch.title-number', group: 'terminals', description: '400 titleOverride wrong type', method: 'PATCH', path: '/api/terminals/qa-fixed-id', auth: 'header', json: { titleOverride: 5 } })
    await runCase({ id: 'terminals.patch.deleted-string', group: 'terminals', description: '400 deleted wrong type', method: 'PATCH', path: '/api/terminals/qa-fixed-id', auth: 'header', json: { deleted: 'yes' } })
    await runCase({ id: 'terminals.patch.nonobject', group: 'terminals', description: '400 non-object body', method: 'PATCH', path: '/api/terminals/qa-fixed-id', auth: 'header', json: 5 })
    await runCase({ id: 'terminals.patch.unknown-keys-stripped', group: 'terminals', description: 'unknown body keys stripped (schema not strict)', method: 'PATCH', path: '/api/terminals/qa-fixed-id', auth: 'header', json: { bogus: 1, titleOverride: 'T' } })
    await runCase({ id: 'terminals.patch.no-auth', group: 'terminals', description: '401 without credentials', method: 'PATCH', path: '/api/terminals/qa-fixed-id', json: { titleOverride: 'x' } })
    await runCase({ id: 'terminals.delete.unknown', group: 'terminals', description: 'DELETE unknown id → {ok:true} (no 404)', method: 'DELETE', path: '/api/terminals/qa-fixed-id-2', auth: 'header' })
    await runCase({ id: 'terminals.delete.no-auth', group: 'terminals', description: '401 without credentials', method: 'DELETE', path: '/api/terminals/qa-fixed-id-2' })

    // live terminals: create per side over WS, drive deterministic output, then
    // compare the populated directory + page + override write-throughs.
    const T1_MARKER = 'qa-last-line-parity-one'
    const T2_MARKER = 'qa-last-line-parity-two'
    let liveIds = null
    try {
      const t1node = await createTerminalWs(servers.node.baseUrl, { input: `printf '${T1_MARKER}\\n'\n` })
      const t1rust = await createTerminalWs(servers.rust.baseUrl, { input: `printf '${T1_MARKER}\\n'\n` })
      const ok1 = await Promise.all([
        waitForLastLine(servers.node.baseUrl, t1node, T1_MARKER),
        waitForLastLine(servers.rust.baseUrl, t1rust, T1_MARKER),
      ])
      if (!ok1.every(Boolean)) throw new Error(`t1 lastLine did not settle (node=${ok1[0]} rust=${ok1[1]})`)
      liveIds = { t1node, t1rust }
    } catch (err) {
      recordDeferred(
        { id: 'terminals.live.*', group: 'terminals', description: 'live-terminal directory cases' },
        `terminal.create/lastLine settle failed: ${err.message}`,
      )
    }
    if (liveIds) {
      await runCase({ id: 'terminals.list.one', group: 'terminals', description: 'one live shell terminal — full item shape incl. lastLine/last_line', path: '/api/terminals', auth: 'header' })
      // second terminal → deterministic 2-item ordering + keyset pagination
      const t2node = await createTerminalWs(servers.node.baseUrl, { input: `printf '${T2_MARKER}\\n'\n` })
      const t2rust = await createTerminalWs(servers.rust.baseUrl, { input: `printf '${T2_MARKER}\\n'\n` })
      const ok2 = await Promise.all([
        waitForLastLine(servers.node.baseUrl, t2node, T2_MARKER),
        waitForLastLine(servers.rust.baseUrl, t2rust, T2_MARKER),
      ])
      if (ok2.every(Boolean)) {
        await runCase({ id: 'terminals.list.two', group: 'terminals', description: 'two terminals sorted lastActivityAt desc', path: '/api/terminals', auth: 'header' })
        await runCase({ id: 'terminals.page.limit1', group: 'terminals', description: 'page limit=1 → newest item + non-null nextCursor', path: '/api/terminals?priority=visible&limit=1', auth: 'header' })
        // follow each side's OWN nextCursor (server-minted → per-side requests)
        const follow = async (baseUrl) => {
          // fetch the RAW page (doRequest normalizes cursors) to get the real nextCursor
          const res = await fetch(baseUrl + '/api/terminals?priority=visible&limit=1', { headers: { 'x-auth-token': TOKEN } })
          const raw = await res.json()
          return doRequest(baseUrl, { path: `/api/terminals?priority=visible&limit=1&cursor=${encodeURIComponent(raw.nextCursor)}`, auth: 'header' })
        }
        recordManual(
          { id: 'terminals.page.follow-cursor', group: 'terminals', description: 'second page via each side\'s own nextCursor → older item, null nextCursor', method: 'GET', path: '/api/terminals?priority=visible&limit=1&cursor=<own>', auth: 'header' },
          await follow(servers.node.baseUrl),
          await follow(servers.rust.baseUrl),
        )
        // PATCH the REAL t1 per side (ids differ) + broadcast observation
        const obsNode = new BroadcastObserver(servers.node.baseUrl)
        const obsRust = new BroadcastObserver(servers.rust.baseUrl)
        await obsNode.connect()
        await obsRust.connect()
        recordManual(
          { id: 'terminals.patch.real-title', group: 'terminals', description: 'PATCH real terminal: override response + registry write-through', method: 'PATCH', path: '/api/terminals/<own-t1>', auth: 'header', json: { titleOverride: 'QA Renamed', descriptionOverride: 'QA Desc' } },
          await doRequest(servers.node.baseUrl, { method: 'PATCH', path: `/api/terminals/${liveIds.t1node}`, auth: 'header', json: { titleOverride: 'QA Renamed', descriptionOverride: 'QA Desc' } }),
          await doRequest(servers.rust.baseUrl, { method: 'PATCH', path: `/api/terminals/${liveIds.t1rust}`, auth: 'header', json: { titleOverride: 'QA Renamed', descriptionOverride: 'QA Desc' } }),
        )
        const bcNode = await obsNode.waitForType('terminals.changed')
        const bcRust = await obsRust.waitForType('terminals.changed')
        recordManual(
          { id: 'terminals.changed.broadcast', group: 'terminals', description: 'PATCH broadcasts terminals.changed {type, revision} to WS clients', method: 'WS', path: '(broadcast frame after PATCH)', auth: 'header' },
          { status: bcNode ? 200 : 0, headers: {}, body: { kind: 'json', json: normalizeJson(bcNode) } },
          { status: bcRust ? 200 : 0, headers: {}, body: { kind: 'json', json: normalizeJson(bcRust) } },
        )
        obsNode.close()
        obsRust.close()
        await runCase({ id: 'terminals.list.renamed', group: 'terminals', description: 'directory reflects title/description overrides', path: '/api/terminals', auth: 'header' })
        // spread semantics on a LIVE terminal: PATCH {deleted:false} clears the
        // title/description overrides; the list falls back to the registry title
        // (which the earlier write-through renamed on BOTH sides).
        recordManual(
          { id: 'terminals.patch.real-spread', group: 'terminals', description: 'PATCH {deleted:false} on real terminal → response only {deleted:false}', method: 'PATCH', path: '/api/terminals/<own-t1>', auth: 'header', json: { deleted: false } },
          await doRequest(servers.node.baseUrl, { method: 'PATCH', path: `/api/terminals/${liveIds.t1node}`, auth: 'header', json: { deleted: false } }),
          await doRequest(servers.rust.baseUrl, { method: 'PATCH', path: `/api/terminals/${liveIds.t1rust}`, auth: 'header', json: { deleted: false } }),
        )
        await runCase({ id: 'terminals.list.after-spread', group: 'terminals', description: 'overrides cleared; title falls back to registry (write-through) title', path: '/api/terminals', auth: 'header' })
        // DELETE the REAL t2 per side → {ok:true}; directory filters it out
        recordManual(
          { id: 'terminals.delete.real', group: 'terminals', description: 'DELETE real terminal → {ok:true}', method: 'DELETE', path: '/api/terminals/<own-t2>', auth: 'header' },
          await doRequest(servers.node.baseUrl, { method: 'DELETE', path: `/api/terminals/${t2node}`, auth: 'header' }),
          await doRequest(servers.rust.baseUrl, { method: 'DELETE', path: `/api/terminals/${t2rust}`, auth: 'header' }),
        )
        await runCase({ id: 'terminals.list.after-delete', group: 'terminals', description: 'deleted-override terminal filtered from the directory', path: '/api/terminals', auth: 'header' })
        // PINNING (council-adjudicated PORT-GAP-002 condition 3, NOT an
        // original-parity case): the viewport/scrollback/search read-model
        // subroutes are deliberately unported on the Rust server (TerminalViewMirror
        // subsystem — deferred, gated before task-009). Pin the interim contract:
        // clean JSON 404 for live AND unknown ids — never 500/hang/SPA-shell.
        // The "node" column below is the DECLARED contract, not the original server.
        {
          const routes = []
          for (const id of [liveIds.t1rust, 'qa-missing-id']) {
            for (const sub of ['viewport', 'scrollback', 'search']) {
              const res = await fetch(`${servers.rust.baseUrl}/api/terminals/${id}/${sub}`, { headers: { 'x-auth-token': TOKEN } })
              const text = await res.text()
              let isJson = false
              try {
                isJson = typeof JSON.parse(text) === 'object'
              } catch {
                isJson = false
              }
              routes.push({ route: `${id === 'qa-missing-id' ? 'unknown-id' : 'live-id'}/${sub}`, status: res.status, json: isJson, html: text.includes('<!DOCTYPE html>') })
            }
          }
          const expected = routes.map((r) => ({ route: r.route, status: 404, json: true, html: false }))
          recordManual(
            { id: 'terminals.subroutes.rust-interim-404-pin', group: 'terminals', description: 'PORT-GAP-002 pinning: unported viewport/scrollback/search answer clean JSON 404 (rust interim contract, declared — not original parity)', method: 'GET', path: '/api/terminals/:id/{viewport,scrollback,search}', auth: 'header' },
            { status: 200, headers: {}, body: { kind: 'json', json: expected } },
            { status: 200, headers: {}, body: { kind: 'json', json: routes } },
          )
        }
      } else {
        recordDeferred(
          { id: 'terminals.live.second', group: 'terminals', description: 'two-terminal ordering/pagination/override cases' },
          `t2 lastLine did not settle (node=${ok2[0]} rust=${ok2[1]})`,
        )
      }
    }

    // 11. SPA serving + /ws upgrade auth
    await runCase({ id: 'spa.root', group: 'spa', description: 'GET / serves index.html no-store', path: '/' })
    await runCase({ id: 'spa.root.token-query', group: 'spa', description: 'GET /?token=… serves the same SPA (token consumed client-side)', path: '/?token=<TOKEN>' })
    await runCase({ id: 'spa.deeplink', group: 'spa', description: 'deep link falls back to index.html', path: '/some/deep/route' })
    const assetsDir = path.join(REPO, 'dist', 'client', 'assets')
    const assetName = (await fsp.readdir(assetsDir)).find((f) => f.endsWith('.js'))
    if (assetName) {
      await runCase({ id: 'spa.asset.real', group: 'spa', description: `real hashed asset 200 (${assetName})`, path: `/assets/${assetName}` })
    } else {
      recordDeferred({ id: 'spa.asset.real', group: 'spa', description: 'real hashed asset' }, 'no .js asset found in dist/client/assets')
    }
    await runCase({ id: 'spa.asset.missing', group: 'spa', description: 'missing asset → 404 (no SPA fallback under /assets)', path: '/assets/nope-000000.js' })
    await runCase({ id: 'spa.nonasset.missing', group: 'spa', description: 'missing non-asset path → SPA fallback', path: '/definitely-missing.png' })
    await runCase({ id: 'spa.favicon', group: 'spa', description: 'real static file with binary content-type', path: '/favicon.ico' })

    // /ws upgrade + hello auth probes (§7.A.5 overlap is intentional)
    const wsCases = [
      ['ws.badtoken', 'hello with a wrong token → NOT_AUTHENTICATED error + close 4001', { type: 'hello', token: BAD_TOKEN, protocolVersion: WS_PROTOCOL_VERSION }],
      ['ws.notoken', 'hello without token → NOT_AUTHENTICATED error + close 4001', { type: 'hello', protocolVersion: WS_PROTOCOL_VERSION }],
      ['ws.protomismatch', 'hello with wrong protocolVersion → PROTOCOL_MISMATCH + close 4010', { type: 'hello', token: TOKEN, protocolVersion: 1 }],
    ]
    for (const [id, description, hello] of wsCases) {
      const [nodeObs, rustObs] = await Promise.all([
        wsProbe(servers.node.baseUrl, hello),
        wsProbe(servers.rust.baseUrl, hello),
      ])
      recordManual(
        { id, group: 'ws-auth', description },
        { status: 0, headers: {}, body: { kind: 'json', json: normalizeJson(nodeObs) } },
        { status: 0, headers: {}, body: { kind: 'json', json: normalizeJson(rustObs) } },
      )
    }

    // API 404 fallthrough parity
    await runCase({ id: 'api.unknown-route', group: 'api-404', description: 'unmatched /api route → JSON 404 (not SPA)', path: '/api/definitely-not-a-route', auth: 'header' })
    await runCase({ id: 'api.unknown-route.no-auth', group: 'api-404', description: 'unmatched /api route without auth → 401', path: '/api/definitely-not-a-route' })

    // Persistence across restart
    console.log('\nrestarting both servers for persistence check...')
    await stopServer(servers.node)
    await stopServer(servers.rust)
    servers = { node: spawnServer('node'), rust: spawnServer('rust') }
    await Promise.all([healthGate(servers.node), healthGate(servers.rust)])
    await runCase({ id: 'settings.persist.restart', group: 'settings', description: 'patched settings persist across restart (config.json round-trip)', path: '/api/settings', auth: 'header' })
    await runCase({ id: 'health.after-restart', group: 'health', description: 'health parity after restart (fresh instanceId)', path: '/api/health' })
  } finally {
    // ── teardown (ownership-verified: only PIDs this script spawned) ─────────
    console.log('\ntearing down...')
    try {
      await stopServer(servers.node)
    } catch {
      /* noop */
    }
    try {
      await stopServer(servers.rust)
    } catch {
      /* noop */
    }
    await new Promise((r) => proxyTarget.close(r))
    await fsp.rm(HOME_NODE, { recursive: true, force: true })
    await fsp.rm(HOME_RUST, { recursive: true, force: true })
    await fsp.rm(SHOTS_DIR, { recursive: true, force: true })
    await fsp.rm(LOGS_DIR, { recursive: true, force: true })
  }

  const orphans = await orphanReport()
  const summary = {
    total: results.length,
    pass: results.filter((r) => r.verdict === 'PASS').length,
    divergence: results.filter((r) => r.verdict === 'DIVERGENCE').length,
    deferred: results.filter((r) => r.verdict === 'DEFERRED').length,
  }
  const payload = {
    generatedAt: new Date().toISOString(),
    task: 'HANDOFF §7.C REST surface parity sweep (node original :17871 vs rust port :17872)',
    normalizedFields: NORMALIZED_FIELDS,
    stringScrubbers: ['<SCRATCH_HOME>', '<REPO>', '<TMP>', '<TOKEN>'],
    summary,
    orphanCheck: orphans,
    results,
  }
  await fsp.writeFile(outPath, JSON.stringify(payload, null, 2))
  console.log(`\nsummary: ${summary.total} cases — ${summary.pass} pass, ${summary.divergence} diverge, ${summary.deferred} deferred`)
  console.log(`orphan check: rust='${orphans.pgrepRust}' nodeDist='${orphans.pgrepNodeDist}' ss='${orphans.ssListeners}'`)
  console.log(`results written to ${outPath}`)
  process.exitCode = summary.divergence > 0 ? 2 : 0
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

async function waitForSessionCount(min, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  const state = { node: false, rust: false }
  while (Date.now() < deadline && !(state.node && state.rust)) {
    for (const kind of ['node', 'rust']) {
      if (state[kind]) continue
      try {
        const res = await fetch(`${servers[kind].baseUrl}/api/session-directory?priority=visible`, {
          headers: { 'x-auth-token': TOKEN },
        })
        if (res.status === 200) {
          const page = await res.json()
          if (Array.isArray(page.items) && page.items.length >= min) state[kind] = true
        }
      } catch {
        /* retry */
      }
    }
    if (!(state.node && state.rust)) await sleep(500)
  }
  return state
}

process.on('SIGINT', async () => {
  for (const child of ownedChildren) {
    try {
      child.kill('SIGKILL')
    } catch {
      /* noop */
    }
  }
  process.exit(130)
})

main().catch(async (err) => {
  console.error('SWEEP FAILED:', err)
  for (const child of ownedChildren) {
    try {
      child.kill('SIGKILL')
    } catch {
      /* noop */
    }
  }
  await fsp.rm(HOME_NODE, { recursive: true, force: true }).catch(() => {})
  await fsp.rm(HOME_RUST, { recursive: true, force: true }).catch(() => {})
  process.exit(1)
})
