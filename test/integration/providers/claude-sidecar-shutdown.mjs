// Contract harness (audit G31): the REAL Claude sidecar (crates/freshell-claude-sidecar/index.mjs)
// over the pinned SDK 0.3.237 and bundled native CLI 2.1.237, against an isolated local
// provider endpoint (the real Anthropic API is never contacted). Mid-turn, the sidecar is
// stopped the way Rust's graceful teardown stops it. The receipt records how long node, the CLI
// process and the provider request took to go away; the grace period the Rust teardown grants
// (2 s) depends on all three being fast.
//
// Modes (argv[3]):
// - `shutdown` (default): the {"type":"shutdown"} line, then stdin EOF.
// - `stdout-closed`: first the sidecar's stdout reader goes away (Rust aborts the session's
//   stdout consumer before its teardown), then, 50 ms later (the teardown's ownership scan),
//   the same shutdown line and stdin EOF. The provider streams a text delta every 25 ms, so
//   the sidecar is writing into the closed pipe before the shutdown line can arrive.
import fs from 'node:fs/promises'
import path from 'node:path'
import http from 'node:http'
import { spawn, execFile, execFileSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'

const repoRoot = process.argv[2]
if (!repoRoot) throw new Error('repository root argument is required')
const mode = process.argv[3] ?? 'shutdown'
if (mode !== 'shutdown' && mode !== 'stdout-closed') throw new Error(`unknown mode ${mode}`)

const sidecarDir = path.join(repoRoot, 'crates/freshell-claude-sidecar')
const sdkDir = path.join(sidecarDir, 'node_modules/@anthropic-ai/claude-agent-sdk')
const sdkPackage = JSON.parse(await fs.readFile(path.join(sdkDir, 'package.json'), 'utf8'))
if (sdkPackage.version !== '0.3.237' || sdkPackage.claudeCodeVersion !== '2.1.237') {
  throw new Error('the Claude sidecar shutdown contract requires SDK 0.3.237 and CLI 2.1.237')
}
const storeRoot = path.join(repoRoot, 'node_modules/.pnpm')
const optionalStore = (await fs.readdir(storeRoot)).find(name =>
  name.startsWith('@anthropic-ai+claude-agent-sdk-linux-x64@0.3.237'))
if (!optionalStore) throw new Error('the pinned Linux x64 Claude CLI package is not installed')
const bundleDir = path.join(storeRoot, optionalStore, 'node_modules/@anthropic-ai/claude-agent-sdk-linux-x64')
const nativeCli = await fs.realpath(path.join(bundleDir, 'claude'))

const fixture = await fs.mkdtemp(path.join(repoRoot, '.tmp-claude-sidecar-shutdown-'))
await fs.chmod(fixture, 0o700)
const home = path.join(fixture, 'home')
const cwd = path.join(fixture, 'workspace')
for (const directory of [home, cwd, path.join(fixture, 'tmp')]) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
}

const alive = pid => {
  try { process.kill(pid, 0); return true } catch (error) { return error.code === 'EPERM' }
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const withTimeout = (promise, ms, what) => {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms) }),
  ]).finally(() => clearTimeout(timer))
}

let server
let sidecar
let cliPid
let failureStage = 'initialization'
let verdict = 'FAIL'
let streamingStarted
const streaming = new Promise(resolve => { streamingStarted = resolve })
let providerRequestClosedAt
let sidecarExitedAt
let sidecarExit
let cliExitedAt
let shutdownSentAt

try {
  const { stdout: nativeVersion } = await promisify(execFile)(nativeCli, ['--version'], {
    cwd, env: { HOME: home, PATH: '/usr/bin:/bin' }, timeout: 10_000, maxBuffer: 8192,
  })
  if (!/^2\.1\.237(?:\s|$)/.test(nativeVersion.trim())) throw new Error('native CLI did not report version 2.1.237')

  failureStage = 'local provider'
  // A turn that stays open until the client goes away: one text delta, then pings (or, in
  // `stdout-closed` mode, a text delta every 25 ms).
  server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    for await (const _chunk of request) { /* drain */ }
    if (url.pathname === '/v1/messages/count_tokens') {
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ input_tokens: 1 }))
      return
    }
    if (url.pathname !== '/v1/messages') {
      response.writeHead(404).end()
      return
    }
    response.on('close', () => { providerRequestClosedAt ??= Date.now() })
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'request-id': randomUUID() })
    const send = (type, data) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
    send('message_start', { message: { id: `msg_${randomUUID().replaceAll('-', '')}`, type: 'message', role: 'assistant', model: 'claude-sonnet-4-5-20250929', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } })
    send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
    send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'streaming' } })
    streamingStarted()
    const [interval, keepAlive] = mode === 'stdout-closed'
      ? [25, () => send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: ' more' } })]
      : [250, () => send('ping', {})]
    for (let elapsed = 0; elapsed < 30_000 && !response.destroyed; elapsed += interval) {
      await sleep(interval)
      if (!response.destroyed) keepAlive()
    }
    if (!response.destroyed) response.end()
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })

  failureStage = 'sidecar start'
  sidecar = spawn(process.execPath, [path.join(sidecarDir, 'index.mjs')], {
    cwd: sidecarDir,
    env: {
      HOME: home,
      PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
      TMPDIR: path.join(fixture, 'tmp'),
      XDG_CONFIG_HOME: path.join(home, '.config'),
      XDG_CACHE_HOME: path.join(home, '.cache'),
      XDG_DATA_HOME: path.join(home, '.local/share'),
      CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
      CLAUDE_CMD: nativeCli,
      ANTHROPIC_API_KEY: randomUUID(),
      FRESHELL_CLAUDE_ONECLI_API_KEY: '1',
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_TELEMETRY: '1',
      DISABLE_ERROR_REPORTING: '1',
      DISABLE_AUTOUPDATER: '1',
      CLAUDE_CODE_DISABLE_METRICS: '1',
      CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: '1',
      LANG: 'C.UTF-8',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  sidecar.stderr.on('data', () => {})
  // The shutdown line may reach a sidecar that already stopped on its own (`stdout-closed`
  // mode); that write's EPIPE is expected, as it is for Rust's teardown.
  sidecar.stdin.on('error', () => {})
  sidecar.once('exit', (code, signal) => { sidecarExitedAt = Date.now(); sidecarExit = { code, signal } })
  const frames = []
  const waiters = []
  createInterface({ input: sidecar.stdout }).on('line', (line) => {
    let frame
    try { frame = JSON.parse(line) } catch { return }
    frames.push(frame)
    for (const waiter of [...waiters]) if (waiter.match(frame)) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(frame) }
  })
  const waitFor = (match, ms, what) => new Promise((resolve, reject) => {
    const existing = frames.find(match)
    if (existing) return resolve(existing)
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms)
    waiters.push({ match, resolve: frame => { clearTimeout(timer); resolve(frame) } })
  })
  const write = message => sidecar.stdin.write(`${JSON.stringify(message)}\n`)

  failureStage = 'create'
  const requestId = randomUUID()
  write({ type: 'create', requestId, cwd, model: 'claude-sonnet-4-5-20250929', permissionMode: 'bypassPermissions' })
  const created = await waitFor(frame => frame.requestId === requestId && (frame.type === 'created' || frame.type === 'create.failed'), 30_000, 'created')
  if (created.type !== 'created') throw new Error('the sidecar refused the create')

  failureStage = 'mid-turn'
  write({ type: 'send', sessionId: created.sessionId, text: 'hello' })
  await withTimeout(streaming, 45_000, 'the provider to receive the turn')
  await waitFor(frame => frame.type === 'sdk.stream' && frame.event?.type === 'content_block_delta', 30_000, 'the streamed delta')
  cliPid = Number(execFileSync('pgrep', ['-P', String(sidecar.pid)]).toString().trim().split('\n')[0])
  if (!Number.isInteger(cliPid) || !alive(cliPid)) throw new Error('the native CLI child was not found')

  failureStage = 'shutdown'
  shutdownSentAt = Date.now()
  if (mode === 'stdout-closed') {
    sidecar.stdout.destroy()
    await sleep(50)
  }
  write({ type: 'shutdown' })
  sidecar.stdin.end()
  const deadline = shutdownSentAt + 10_000
  while (Date.now() < deadline && (sidecarExitedAt === undefined || alive(cliPid) || providerRequestClosedAt === undefined)) {
    if (cliExitedAt === undefined && !alive(cliPid)) cliExitedAt = Date.now()
    await sleep(5)
  }
  if (cliExitedAt === undefined && !alive(cliPid)) cliExitedAt = Date.now()
  if (sidecarExitedAt !== undefined && cliExitedAt !== undefined && providerRequestClosedAt !== undefined) verdict = 'PASS'
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    severity: 'error',
    component: 'claude-sidecar-shutdown-contract',
    stage: failureStage,
    name: error?.name ?? 'Error',
    message: String(error?.message ?? 'unknown error').slice(0, 500),
  })}\n`)
} finally {
  if (sidecar && sidecarExitedAt === undefined) sidecar.kill('SIGKILL')
  if (cliPid && alive(cliPid)) { try { process.kill(cliPid, 'SIGKILL') } catch {} }
  if (server) {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
  await fs.rm(fixture, { recursive: true, force: true })
}

const since = at => (at === undefined || shutdownSentAt === undefined ? null : at - shutdownSentAt)
const fixtureRemoved = !(await fs.stat(fixture).catch(() => null))
process.stdout.write(`${JSON.stringify({
  verdict,
  mode,
  sdkVersion: sdkPackage.version,
  bundledCliVersion: sdkPackage.claudeCodeVersion,
  sidecarExit,
  sidecarExitMs: since(sidecarExitedAt),
  nativeCliExitMs: since(cliExitedAt),
  providerRequestClosedMs: since(providerRequestClosedAt),
  fixtureRemoved,
})}\n`)
if (verdict !== 'PASS' || !fixtureRemoved) process.exitCode = 1
