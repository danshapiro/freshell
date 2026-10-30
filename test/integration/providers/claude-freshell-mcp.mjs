// Contract harness (audit G19, api-hosted-ops plan §2.4/§3.2): the REAL Claude sidecar
// (crates/freshell-claude-sidecar/index.mjs) over the pinned SDK and its bundled native CLI
// (resolvePinnedClaude), in the shared throwaway fixture (createClaudeFixture), against an
// isolated local provider endpoint (the real Anthropic API is never contacted).
//
// The sidecar is launched the way the Rust server launches it for a freshclaude pane: its
// environment carries FRESHELL=1, FRESHELL_URL and a random FRESHELL_TOKEN, and its create
// line names the ordinary Freshell MCP recipe (`freshellMcp`, a probe stdio MCP server that
// stands in for tools/freshell-mcp) and the pane (`freshellContext`). One turn asks the
// model to call the probe's tool. The receipt records what the CLI and the MCP child got:
//   - the CLI's argv carries the MCP config but never the token;
//   - the MCP child started and received the endpoint, the token and the pane context;
//   - the CLI listed the probe's tool (the server connected) and the tool call returned the
//     probe's report.
import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createClaudeFixture, FAKE_MODEL, resolvePinnedClaude, startLocalProvider } from './claude-local-provider.mjs'
import { stopFixtureProcess } from '../../support/stop-fixture-process.mjs'

const repoRoot = process.argv[2]
if (!repoRoot) throw new Error('repository root argument is required')

const here = path.dirname(fileURLToPath(import.meta.url))
const PROBE_SERVER = path.join(here, 'claude-freshell-mcp-probe-server.mjs')
const PROBE_TOOL = 'mcp__freshell__context'
const PROMPT = 'call the freshell probe'
const sidecarDir = path.join(repoRoot, 'crates/freshell-claude-sidecar')

const pinned = await resolvePinnedClaude(repoRoot)
const fixture = await createClaudeFixture({ prefix: 'freshell-claude-freshell-mcp-' })
const token = `fresh-token-${randomBytes(16).toString('hex')}`
const freshellUrl = 'http://127.0.0.1:9/freshell-probe-endpoint'
const context = { tabId: 'tab-g19', paneId: 'pane-g19' }
const reportFile = path.join(fixture.root, 'probe-report.json')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

let provider
let sidecar
let failureStage = 'initialization'
const receipt = {
  verdict: 'FAIL',
  sdkVersion: pinned.sdkVersion,
  bundledCliVersion: pinned.cliVersion,
  sendRefusals: [],
  cliArgvHasMcpConfig: false,
  cliArgvHasToken: null,
  probe: null,
  probeToolListed: false,
  toolResultReport: null,
  toolNames: null,
}

try {
  failureStage = 'local provider'
  // The model calls the probe's tool for the scripted prompt, then ends the turn.
  provider = await startLocalProvider({
    respond: ({ promptText, afterTool, tools }) => {
      if (afterTool) return { blocks: [{ type: 'text', text: 'done' }] }
      if (promptText.includes(PROMPT) && tools.includes(PROBE_TOOL)) {
        return { blocks: [{ type: 'tool_use', name: PROBE_TOOL, input: {} }] }
      }
      return undefined
    },
  })

  failureStage = 'sidecar start'
  sidecar = spawn(process.execPath, [path.join(sidecarDir, 'index.mjs')], {
    cwd: sidecarDir,
    env: fixture.env(provider.url, {
      CLAUDE_CMD: pinned.nativeCli,
      FRESHELL_CLAUDE_ONECLI_API_KEY: '1',
      // What the Rust server sets on every sidecar (claude_spawn::with_freshell_endpoint).
      FRESHELL: '1',
      FRESHELL_URL: freshellUrl,
      FRESHELL_TOKEN: token,
    }),
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stderr = ''
  sidecar.stderr.setEncoding('utf8').on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000) })
  sidecar.stdin.on('error', () => {})
  const frames = []
  const waiters = []
  createInterface({ input: sidecar.stdout }).on('line', (line) => {
    let frame
    try { frame = JSON.parse(line) } catch { return }
    frames.push(frame)
    if (frame.type === 'sdk.send.rejected') receipt.sendRefusals.push(frame)
    for (const waiter of [...waiters]) if (waiter.match(frame)) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(frame) }
  })
  const waitFor = (match, ms, what) => new Promise((resolve, reject) => {
    const existing = frames.find(match)
    if (existing) return resolve(existing)
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}; stderr=${stderr.slice(-800)}`)), ms)
    waiters.push({ match, resolve: frame => { clearTimeout(timer); resolve(frame) } })
  })
  const write = message => sidecar.stdin.write(`${JSON.stringify(message)}\n`)

  failureStage = 'create'
  const requestId = randomUUID()
  const nativeSessionId = randomUUID()
  write({
    type: 'create', protocol: 2, boot: { kind: 'fresh' }, requestId, sessionId: nativeSessionId, cwd: fixture.cwd, model: FAKE_MODEL,
    permissionMode: 'bypassPermissions', hostedMcp: false,
    freshellMcp: { command: process.execPath, args: [PROBE_SERVER, reportFile] },
    freshellContext: context,
  })
  const created = await waitFor(frame => frame.requestId === requestId && (frame.type === 'created' || frame.type === 'create.failed'), 45_000, 'created')
  if (created.type !== 'created') throw new Error(`the sidecar refused the create: ${created.message}`)
  if (created.sessionId !== nativeSessionId) throw new Error('the sidecar changed the requested native session identity')

  failureStage = 'cli argv'
  const argv = (await fs.readFile(`/proc/${created.cliPid}/cmdline`, 'utf8')).split('\0')
  const mcpConfigAt = argv.indexOf('--mcp-config')
  receipt.cliArgvHasMcpConfig = mcpConfigAt >= 0 && argv[mcpConfigAt + 1]?.includes(PROBE_SERVER) === true
  receipt.cliArgvHasToken = argv.some(arg => arg.includes(token))

  failureStage = 'turn'
  write({ type: 'send', sessionId: created.sessionId, uuid: randomUUID(), text: PROMPT })
  const init = await waitFor(frame => frame.type === 'sdk.session.init', 45_000, 'the turn init')
  // The sidecar forwards the CLI's tool list as `{ name }` objects.
  receipt.toolNames = (init.tools ?? []).map(tool => (typeof tool === 'string' ? tool : tool?.name)).filter(name => String(name).startsWith('mcp__'))
  receipt.probeToolListed = receipt.toolNames.includes(PROBE_TOOL)
  await waitFor(frame => frame.type === 'sdk.result', 45_000, 'the turn result')
  // The CLI's tool result for the probe call: the user message carrying the
  // tool_result block reaches the sidecar as a transcript announcement only,
  // and the CLI flushes the line about 100 ms after the frame, so poll the
  // transcript for it.
  failureStage = 'tool result'
  const toolResultReport = async () => {
    for (const relative of await fixture.transcripts()) {
      const text = await fs.readFile(path.join(fixture.home, '.claude', relative), 'utf8')
      for (const line of text.split('\n').filter(Boolean)) {
        let row
        try { row = JSON.parse(line) } catch { continue }
        const blocks = Array.isArray(row.message?.content) ? row.message.content : []
        for (const block of blocks) {
          if (block?.type !== 'tool_result') continue
          const body = Array.isArray(block.content) ? block.content.map(part => part?.text ?? '').join('') : String(block.content ?? '')
          try { return JSON.parse(body) } catch { return { unparsed: body.slice(0, 200) } }
        }
      }
    }
    return null
  }
  for (let waited = 0; waited < 10_000 && receipt.toolResultReport === null; waited += 50) {
    receipt.toolResultReport = await toolResultReport()
    if (receipt.toolResultReport === null) await sleep(50)
  }

  failureStage = 'probe report'
  for (let waited = 0; waited < 10_000 && receipt.probe === null; waited += 50) {
    try { receipt.probe = JSON.parse(await fs.readFile(reportFile, 'utf8')) } catch { await sleep(50) }
  }

  const tokenDigest = createHash('sha256').update(token).digest('hex')
  const probeOk = receipt.probe !== null
    && receipt.probe.FRESHELL === '1'
    && receipt.probe.FRESHELL_URL === freshellUrl
    && receipt.probe.FRESHELL_TOKEN_SHA256 === tokenDigest
    && receipt.probe.FRESHELL_TAB_ID === context.tabId
    && receipt.probe.FRESHELL_PANE_ID === context.paneId
  receipt.probeSawContext = probeOk
  receipt.toolCallReturnedReport = receipt.toolResultReport?.FRESHELL_TOKEN_SHA256 === tokenDigest
  if (receipt.probe) receipt.probe = { ...receipt.probe, FRESHELL_TOKEN_SHA256: receipt.probe.FRESHELL_TOKEN_SHA256 === tokenDigest ? 'matches' : 'differs' }
  if (receipt.toolResultReport?.FRESHELL_TOKEN_SHA256) receipt.toolResultReport = { ...receipt.toolResultReport, FRESHELL_TOKEN_SHA256: receipt.toolResultReport.FRESHELL_TOKEN_SHA256 === tokenDigest ? 'matches' : 'differs' }
  if (receipt.cliArgvHasMcpConfig && receipt.cliArgvHasToken === false && probeOk && receipt.probeToolListed && receipt.toolCallReturnedReport) {
    receipt.verdict = 'PASS'
  }

  failureStage = 'shutdown'
  write({ type: 'shutdown' })
  sidecar.stdin.end()
  await new Promise(resolve => {
    if (sidecar.exitCode !== null) return resolve()
    const timer = setTimeout(resolve, 5_000)
    sidecar.once('exit', () => { clearTimeout(timer); resolve() })
  })
} catch (error) {
  receipt.failureStage = failureStage
  process.stderr.write(`${JSON.stringify({
    severity: 'error',
    component: 'claude-freshell-mcp-contract',
    stage: failureStage,
    name: error?.name ?? 'Error',
    message: String(error?.message ?? 'unknown error').replaceAll(token, '<token>').slice(0, 800),
  })}\n`)
} finally {
  await stopFixtureProcess(sidecar)
  if (receipt.probe?.pid) { try { process.kill(receipt.probe.pid, 'SIGKILL') } catch {} }
  await provider?.close()
  await fixture.cleanup()
}

process.stdout.write(`${JSON.stringify(receipt).replaceAll(token, '<token>')}\n`)
if (receipt.verdict !== 'PASS') process.exitCode = 1
