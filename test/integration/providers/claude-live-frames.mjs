// Contract harness (transcript-live plan B6): the REAL Claude sidecar
// (crates/freshell-claude-sidecar/index.mjs) over the pinned SDK and its
// bundled native CLI (resolvePinnedClaude), in the shared throwaway fixture
// (createClaudeFixture), against the local provider endpoint
// (startLocalProvider; the real Anthropic API is never contacted). One
// session runs these turns in order and records every stdout frame:
//
//   text          a thinking block, then text streamed in small pieces
//   edit          Write, then Edit, then a reply (bypassPermissions)
//   agent         a synchronous Agent (subagent) call: the subagent reads the
//                 notes and reports; then a reply
//   retry         the provider answers 529 twice; the CLI retries, then succeeds
//   compact-ok    /compact
//   more          one more model turn (so there is something to compact)
//   compact-fail  /compact whose summary request fails (APIERR:400)
//   plan          configure plan mode, then ExitPlanMode approved through the
//                 sidecar's permission channel; then configure the mode the
//                 CLI says it returned to
//
// Meanwhile it polls the CLI's transcript files and records when each line's
// uuid first appears, so the test can check every announced uuid landed.
//
// Usage: node claude-live-frames.mjs <repoRoot>. Prints ONE JSON line (the
// receipt); structured progress and failures go to stderr as JSONL.
import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'
import { createClaudeFixture, FAKE_MODEL, resolvePinnedClaude, startLocalProvider } from './claude-local-provider.mjs'
import { SUBAGENT_MARKER } from '../../fixtures/claude-cli-sim/prompt-markers.mjs'

const repoRoot = process.argv[2]
if (!repoRoot) throw new Error('repository root argument is required')

const TURN_TIMEOUT_MS = 45_000
/** How long an announced uuid may take to reach the transcript. */
const LANDING_BUDGET_MS = 2_000
const POLL_MS = 25

const log = (severity, event, fields = {}) => {
  process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), severity, component: 'claude-live-frames', event, ...fields })}\n`)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const pinned = await resolvePinnedClaude(repoRoot)
const fixture = await createClaudeFixture({ prefix: 'freshell-claude-live-frames-' })
const { cwd } = fixture
const notes = path.join(cwd, 'notes.txt')

// ── the model ────────────────────────────────────────────────────────────────
//
// The scripted model answers by the scenario running now and by the tool
// result it is shown (the CLI merges prompts, reminders and command records
// into user messages, so prompt text is no key). A compaction's summary
// request is left to the prompt markers: the args of `/compact APIERR:400`
// reach it (T15).

/** The scenario whose turn the provider is answering. */
let current = 'boot'
let retryAttempts = 0
const PLAN = '# Plan\n\n1. Edit the notes'

function respond({ isSubagent, toolResult, tools }) {
  if (isSubagent) {
    // The subagent reads the notes, then reports.
    if (!toolResult) return { blocks: [{ type: 'tool_use', id: 'toolu_live_sub_read', name: 'Read', input: { file_path: notes } }] }
    return { blocks: [{ type: 'text', text: 'The notes say two.' }] }
  }
  switch (current) {
    case 'text':
      return { blocks: [{ type: 'thinking', thinking: 'Planning a short answer.' }, { type: 'text', text: 'Streaming this reply in small pieces.' }] }
    case 'edit':
      if (!toolResult) return { blocks: [{ type: 'text', text: 'Writing the notes.' }, { type: 'tool_use', id: 'toolu_live_write', name: 'Write', input: { file_path: notes, content: 'one\n' } }] }
      if (toolResult.tool_use_id === 'toolu_live_write') return { blocks: [{ type: 'tool_use', id: 'toolu_live_edit', name: 'Edit', input: { file_path: notes, old_string: 'one', new_string: 'two' } }] }
      return { blocks: [{ type: 'text', text: 'Edited the notes.' }] }
    case 'agent': {
      if (toolResult) return { blocks: [{ type: 'text', text: 'The subagent checked the notes.' }] }
      const agentTool = tools.find((name) => name === 'Agent' || name === 'Task') ?? 'Agent'
      return { blocks: [{ type: 'tool_use', id: 'toolu_live_agent', name: agentTool, input: { description: 'check the notes', prompt: `${SUBAGENT_MARKER} check the notes`, subagent_type: 'general-purpose', run_in_background: false } }] }
    }
    case 'retry':
      retryAttempts += 1
      if (retryAttempts <= 2) return { status: 529, errorType: 'overloaded_error', message: 'Overloaded' }
      return { blocks: [{ type: 'text', text: 'Answered after two retries.' }] }
    case 'more':
      return { blocks: [{ type: 'text', text: 'More to compact later.' }] }
    case 'plan':
      if (!toolResult) return { blocks: [{ type: 'tool_use', id: 'toolu_live_plan', name: 'ExitPlanMode', input: { plan: PLAN } }] }
      return { blocks: [{ type: 'text', text: 'Leaving plan mode.' }] }
    default:
      return undefined
  }
}

// ── the run ──────────────────────────────────────────────────────────────────

let provider
let sidecar
let sidecarExit
let failure
const frames = []
const scenarios = {}
/** uuid -> { at, file: 'main' | 'subagent' }: when the uuid first appeared in a transcript file. */
const seen = new Map()
const stderrLines = []
let polling = true
const t0 = Date.now()

async function pollTranscripts() {
  while (polling) {
    for (const file of await fixture.transcripts()) {
      let text
      try { text = await fs.readFile(path.join(fixture.claudeConfigDir, file), 'utf8') } catch { continue }
      const where = file.includes(`${path.sep}subagents${path.sep}`) ? 'subagent' : 'main'
      for (const line of text.slice(0, text.lastIndexOf('\n') + 1).split('\n')) {
        if (!line) continue
        let row
        try { row = JSON.parse(line) } catch { continue }
        if (typeof row.uuid === 'string' && !seen.has(row.uuid)) seen.set(row.uuid, { at: Date.now() - t0, file: where })
      }
    }
    await sleep(POLL_MS)
  }
}

/** A frame as the receipt keeps it: the big catalogs (commands, tools) by size only. */
function slim(frame) {
  const out = { ...frame }
  if (Array.isArray(out.commands)) out.commands = out.commands.length
  if (Array.isArray(out.tools)) out.tools = out.tools.length
  return out
}

let poller
try {
  provider = await startLocalProvider({ respond })
  sidecar = spawn(process.execPath, [path.join(repoRoot, 'crates/freshell-claude-sidecar/index.mjs')], {
    cwd: path.join(repoRoot, 'crates/freshell-claude-sidecar'),
    env: fixture.env(provider.url, { CLAUDE_CMD: pinned.nativeCli, FRESHELL_CLAUDE_ONECLI_API_KEY: '1' }),
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  sidecar.stdin.on('error', () => {})
  const exited = new Promise((resolve) => sidecar.once('exit', (code, signal) => { sidecarExit = { code, signal }; resolve() }))
  createInterface({ input: sidecar.stderr }).on('line', (line) => stderrLines.push(line))
  const waiters = []
  createInterface({ input: sidecar.stdout }).on('line', (line) => {
    let frame
    try { frame = JSON.parse(line) } catch { frame = { type: '<non-json stdout>', line } }
    frames.push({ t: Date.now() - t0, ...frame })
    for (const waiter of [...waiters]) if (waiter.match(frame)) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(frame) }
  })
  const waitFor = (match, what, ms = TURN_TIMEOUT_MS) => new Promise((resolve, reject) => {
    const hit = frames.find(match)
    if (hit) return resolve(hit)
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms)
    waiters.push({ match, resolve: (frame) => { clearTimeout(timer); resolve(frame) } })
  })
  const write = (message) => sidecar.stdin.write(`${JSON.stringify(message)}\n`)
  const resultCount = () => frames.filter((frame) => frame.type === 'sdk.result').length

  const requestId = randomUUID()
  const nativeSessionId = randomUUID()
  write({ type: 'create', protocol: 2, boot: { kind: 'fresh' }, requestId, sessionId: nativeSessionId, cwd, model: FAKE_MODEL, permissionMode: 'bypassPermissions' })
  const created = await waitFor((frame) => frame.requestId === requestId && (frame.type === 'created' || frame.type === 'create.failed'), 'created')
  if (created.type !== 'created') throw new Error(`the sidecar refused the create: ${created.message}`)
  if (created.sessionId !== nativeSessionId) throw new Error('the sidecar changed the requested native session identity')
  const sessionId = created.sessionId
  poller = pollTranscripts()

  /** Run one scenario: `act` starts it; it ends at the next result. */
  const scenario = async (name, act) => {
    const results = resultCount()
    // An unfinished scenario keeps every frame after its start (a failure's evidence).
    scenarios[name] = { start: frames.length }
    current = name
    log('info', 'scenario.start', { name })
    await act()
    await waitFor(() => resultCount() > results, `the ${name} result`)
    scenarios[name].end = frames.length
  }
  const send = (text) => write({ type: 'send', sessionId, uuid: randomUUID(), text })
  const configure = async (requestId, settings) => {
    write({ type: 'configure', sessionId, requestId, settings })
    const answer = await waitFor((frame) => frame.type === 'sdk.configured' && frame.requestId === requestId, `configure ${requestId}`)
    if (answer.ok !== true) throw new Error(`configure ${requestId} failed: ${answer.message}`)
  }

  await scenario('text', () => send('say something'))
  await scenario('edit', () => send('edit the notes'))
  await scenario('agent', () => send('delegate a check'))
  await scenario('retry', () => send('answer once the API recovers'))
  await scenario('compact-ok', () => send('/compact'))
  // Right after a compaction the CLI has "Not enough messages to compact" and
  // never asks the model: one more turn first (T15's order).
  await scenario('more', () => send('one more turn'))
  await scenario('compact-fail', () => send('/compact APIERR:400'))
  await scenario('plan', async () => {
    await configure('to-plan', { permissionMode: 'plan' })
    send('make a plan, then leave plan mode')
    const request = await waitFor((frame) => frame.type === 'sdk.permission.request', 'the ExitPlanMode approval request')
    write({ type: 'permission.respond', sessionId, requestId: request.requestId, decision: { behavior: 'allow', updatedInput: request.tool.input } })
  })
  // The server then asks for the mode the CLI said it is in: accepted as is.
  const stated = frames.filter((frame) => frame.type === 'sdk.session.metadata').at(-1)?.permissionMode
  const beforeConfigure = frames.length
  await configure('to-stated', { permissionMode: stated ?? 'default' })
  scenarios['configure-stated'] = { start: beforeConfigure, end: frames.length }

  // Let the last announced lines land (or not) within their budget.
  const lastAnnouncement = frames.filter((frame) => frame.type === 'sdk.session.changed' && frame.reason === 'transcript').at(-1)
  await sleep(Math.max(0, (lastAnnouncement?.t ?? 0) + LANDING_BUDGET_MS + 200 - (Date.now() - t0)))
  polling = false
  await poller
  write({ type: 'shutdown' })
  sidecar.stdin.end()
  await Promise.race([exited, sleep(10_000)])
} catch (error) {
  failure = String(error?.message ?? error).slice(0, 1000)
  log('error', 'run.failed', { error: failure })
} finally {
  polling = false
  await poller?.catch(() => {})
  if (sidecar && !sidecarExit) sidecar.kill('SIGKILL')
  if (provider) await provider.close()
  await fixture.cleanup()
}

const fixtureRemoved = !(await fs.stat(fixture.root).catch(() => null))
const announcements = frames.filter((frame) => frame.type === 'sdk.session.changed' && frame.reason === 'transcript')
const receipt = {
  sdkVersion: pinned.sdkVersion,
  bundledCliVersion: pinned.cliVersion,
  failure,
  sidecarExit,
  fixtureRemoved,
  scenarios: Object.fromEntries(Object.entries(scenarios).map(([name, { start, end }]) => [name, frames.slice(start, end).map(slim)])),
  landing: announcements.map((frame) => ({
    uuid: frame.uuid,
    parentToolUseId: frame.parentToolUseId,
    lagMs: seen.has(frame.uuid) ? seen.get(frame.uuid).at - frame.t : null,
    file: seen.get(frame.uuid)?.file ?? null,
  })),
  logRecords: stderrLines.flatMap((line) => { try { return [JSON.parse(line)] } catch { return [] } })
    .filter((record) => ['api.retry', 'notice', 'permission_mode.changed'].includes(record.event)),
  providerRequests: provider?.requests ?? [],
}
process.stdout.write(`${JSON.stringify(receipt)}\n`, () => process.exit(failure || !fixtureRemoved ? 1 : 0))
