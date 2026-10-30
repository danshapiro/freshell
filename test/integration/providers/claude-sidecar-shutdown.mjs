// Contract harness (audit G31): the REAL Claude sidecar (crates/freshell-claude-sidecar/index.mjs)
// over the pinned SDK and its bundled native CLI (resolvePinnedClaude), in the shared throwaway
// fixture (createClaudeFixture), against an isolated local provider endpoint (the real Anthropic
// API is never contacted). Mid-turn, the sidecar is
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
import { execFileSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'
import { createClaudeFixture, FAKE_MODEL, resolvePinnedClaude } from './claude-local-provider.mjs'
import { stopFixtureProcess } from '../../support/stop-fixture-process.mjs'

const repoRoot = process.argv[2]
if (!repoRoot) throw new Error('repository root argument is required')
const mode = process.argv[3] ?? 'shutdown'
if (mode !== 'shutdown' && mode !== 'stdout-closed') throw new Error(`unknown mode ${mode}`)

const sidecarDir = path.join(repoRoot, 'crates/freshell-claude-sidecar')
// Checks the pinned SDK and CLI versions (and runs the CLI once) for this platform.
const pinned = await resolvePinnedClaude(repoRoot)
const fixture = await createClaudeFixture({ prefix: 'freshell-claude-sidecar-shutdown-' })
const { cwd } = fixture

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
    send('message_start', { message: { id: `msg_${randomUUID().replaceAll('-', '')}`, type: 'message', role: 'assistant', model: FAKE_MODEL, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } })
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
  sidecar = fixture.spawn(process.execPath, [path.join(sidecarDir, 'index.mjs')], {
    cwd: sidecarDir,
    // The shared fixture's complete environment (a dead proxy for any egress but the
    // loopback provider), plus the CLI to run and the managed-key flag that lets the
    // sidecar pass the dummy key on to it.
    env: fixture.env(`http://127.0.0.1:${server.address().port}`, {
      CLAUDE_CMD: pinned.nativeCli,
      FRESHELL_CLAUDE_ONECLI_API_KEY: '1',
    }),
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
  write({ type: 'create', protocol: 2, boot: { kind: 'fresh' }, requestId, cwd, model: FAKE_MODEL, permissionMode: 'bypassPermissions' })
  const created = await waitFor(frame => frame.requestId === requestId && (frame.type === 'created' || frame.type === 'create.failed'), 30_000, 'created')
  if (created.type !== 'created') throw new Error('the sidecar refused the create')

  failureStage = 'mid-turn'
  write({ type: 'send', sessionId: created.sessionId, uuid: randomUUID(), text: 'hello' })
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
  await stopFixtureProcess(sidecar)
  if (server) {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
  await fixture.cleanup()
}

const since = at => (at === undefined || shutdownSentAt === undefined ? null : at - shutdownSentAt)
const fixtureRemoved = !(await fs.stat(fixture.root).catch(() => null))
process.stdout.write(`${JSON.stringify({
  verdict,
  mode,
  sdkVersion: pinned.sdkVersion,
  bundledCliVersion: pinned.cliVersion,
  sidecarExit,
  sidecarExitMs: since(sidecarExitedAt),
  nativeCliExitMs: since(cliExitedAt),
  providerRequestClosedMs: since(providerRequestClosedAt),
  fixtureRemoved,
})}\n`)
if (verdict !== 'PASS' || !fixtureRemoved) process.exitCode = 1
