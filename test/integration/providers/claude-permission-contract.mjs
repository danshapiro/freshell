// Contract harness (client-alerts plan PR-C, D0): what the pinned CLI 2.1.237
// does with permission suggestions and plan approvals, as the REAL Claude
// sidecar (crates/freshell-claude-sidecar/index.mjs) relays it. The sidecar
// runs over the pinned SDK and its bundled native CLI (resolvePinnedClaude) in
// a throwaway fixture (createClaudeFixture), against the local provider
// endpoint (startLocalProvider; the real Anthropic API is never contacted).
//
// The approval card, the plan card and the pane's permission mode rely on
// these facts; each scenario runs in its own fixture and sidecar:
//
//   remember-local    Bash `npm test` in default mode: allowed with the CLI's
//                     own suggestions as updatedPermissions (localSettings);
//                     then `npm test` again, then `ls /`
//   remember-session  the same, with every suggestion's destination rewritten
//                     to `session`
//   shapes            the suggestions offered for a Write in the workspace, a
//                     Read outside it, a compound Bash command and `ls /`
//                     (every request denied)
//   plan-default      plan mode, ExitPlanMode allowed plainly; then a Write
//   plan-accept-edits plan mode, ExitPlanMode allowed with setMode acceptEdits;
//                     then a Write
//   plan-bypass       plan mode, ExitPlanMode allowed with setMode
//                     bypassPermissions; then a Write
//   plan-file         plan mode: the model writes its plan file, then calls
//                     ExitPlanMode with no input
//   plan-empty        plan mode: ExitPlanMode with no input and no plan file
//
// Usage: node claude-permission-contract.mjs <repoRoot>. Prints ONE JSON line
// (the receipt), with every fixture path replaced by `<root>`; structured
// progress and failures go to stderr as JSONL.
import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'
import { createClaudeFixture, FAKE_MODEL, resolvePinnedClaude, startLocalProvider } from './claude-local-provider.mjs'
import { stopFixtureProcess } from '../../support/stop-fixture-process.mjs'

const repoRoot = process.argv[2]
if (!repoRoot) throw new Error('repository root argument is required')

const TURN_TIMEOUT_MS = 45_000
export const PLAN = '# Plan\n\n1. Edit foo.ts\n2. Run the tests'
export const PLAN_FILE_TEXT = '# Real plan\n\n- step A\n- step B'

const log = (severity, event, fields = {}) => {
  process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), severity, component: 'claude-permission-contract', event, ...fields })}\n`)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const pinned = await resolvePinnedClaude(repoRoot)

const bash = (command) => ({ name: 'Bash', input: { command, description: 'contract command' } })
const write = (filePath) => ({ name: 'Write', input: { file_path: filePath, content: 'written\n' } })
const allowWith = (updatedPermissions) => (updatedPermissions ? { behavior: 'allow', updatedPermissions } : { behavior: 'allow' })
const DENY = { behavior: 'deny', message: 'denied by the contract', interrupt: false }

/**
 * Each scenario: the boot mode, whether it switches to plan mode first, its
 * turns (the model's tool calls for each prompt; `ctx` has the fixture paths
 * and the plan file path the CLI named) and the answer to each permission
 * request.
 */
const SCENARIOS = {
  'remember-local': {
    turns: [() => [bash('npm test')], () => [bash('npm test')], () => [bash('ls /')]],
    decide: (request) => (request.tool.input.command === 'npm test' ? allowWith(request.suggestions) : DENY),
  },
  'remember-session': {
    turns: [() => [bash('npm test')], () => [bash('npm test')], () => [bash('ls /')]],
    decide: (request) => (request.tool.input.command === 'npm test'
      ? allowWith(request.suggestions.map((update) => ({ ...update, destination: 'session' })))
      : DENY),
  },
  shapes: {
    turns: [
      (ctx) => [write(path.join(ctx.cwd, 'foo.txt'))],
      (ctx) => [{ name: 'Read', input: { file_path: ctx.outsideFile } }],
      (ctx) => [bash(`cat ${ctx.outsideFile} && git status`)],
      () => [bash('ls /')],
    ],
    decide: () => DENY,
  },
  'plan-default': {
    plan: true,
    turns: [() => [{ name: 'ExitPlanMode', input: { plan: PLAN } }], (ctx) => [write(path.join(ctx.cwd, 'after.txt'))]],
    decide: (request) => (request.tool.name === 'ExitPlanMode' ? allowWith() : DENY),
  },
  'plan-accept-edits': {
    plan: true,
    turns: [() => [{ name: 'ExitPlanMode', input: { plan: PLAN } }], (ctx) => [write(path.join(ctx.cwd, 'after.txt'))]],
    decide: (request) => (request.tool.name === 'ExitPlanMode'
      ? allowWith([{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }])
      : DENY),
  },
  'plan-bypass': {
    plan: true,
    turns: [() => [{ name: 'ExitPlanMode', input: { plan: PLAN } }], (ctx) => [write(path.join(ctx.cwd, 'after.txt'))]],
    decide: (request) => (request.tool.name === 'ExitPlanMode'
      ? allowWith([{ type: 'setMode', mode: 'bypassPermissions', destination: 'session' }])
      : DENY),
  },
  'plan-file': {
    plan: true,
    turns: [(ctx) => [{ name: 'Write', input: { file_path: ctx.planPath, content: PLAN_FILE_TEXT } }, { name: 'ExitPlanMode', input: {} }]],
    decide: () => DENY,
  },
  'plan-empty': {
    plan: true,
    turns: [() => [{ name: 'ExitPlanMode', input: {} }]],
    decide: () => DENY,
  },
}

/** A frame as the receipt keeps it: the big catalogs (commands, tools) by size only. */
function slim(frame) {
  const out = { ...frame }
  if (Array.isArray(out.commands)) out.commands = out.commands.length
  if (Array.isArray(out.tools)) out.tools = out.tools.length
  return out
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

async function runScenario(name, spec) {
  const fixture = await createClaudeFixture({ prefix: `freshell-claude-perm-${name}-` })
  const outside = path.join(fixture.root, 'outside')
  await fs.mkdir(outside, { recursive: true })
  const ctx = { cwd: fixture.cwd, outsideFile: path.join(outside, 'notes.txt'), planPath: null }
  await fs.writeFile(ctx.outsideFile, 'notes\n')

  // The model: the current turn's tool calls in order, then a short reply.
  const state = { turn: -1, step: 0 }
  const respond = ({ messages, tools }) => {
    // A side request with no tools (a title, a summary): the markers answer it.
    if (tools.length === 0 || state.turn < 0) return undefined
    const named = JSON.stringify(messages).match(/\/[^\s"\\]*\/plans\/[^\s"\\]+\.md/)
    if (named && !ctx.planPath) ctx.planPath = named[0]
    const calls = spec.turns[state.turn](ctx)
    if (state.step < calls.length) {
      const call = calls[state.step]
      state.step += 1
      return { blocks: [{ type: 'tool_use', name: call.name, input: call.input }] }
    }
    return { blocks: [{ type: 'text', text: 'done' }] }
  }

  const frames = []
  const answered = []
  let provider
  let sidecar
  let sidecarExit
  let failure
  let settingsLocal = null
  const written = {}
  try {
    provider = await startLocalProvider({ respond })
    sidecar = spawn(process.execPath, [path.join(repoRoot, 'crates/freshell-claude-sidecar/index.mjs')], {
      cwd: path.join(repoRoot, 'crates/freshell-claude-sidecar'),
      env: fixture.env(provider.url, { CLAUDE_CMD: pinned.nativeCli, FRESHELL_CLAUDE_ONECLI_API_KEY: '1', npm_config_update_notifier: 'false' }),
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    sidecar.stdin.on('error', () => {})
    const exited = new Promise((resolve) => sidecar.once('exit', (code, signal) => { sidecarExit = { code, signal }; resolve() }))
    createInterface({ input: sidecar.stderr }).on('line', () => {})
    const send = (message) => sidecar.stdin.write(`${JSON.stringify(message)}\n`)
    const waiters = []
    let sessionId
    createInterface({ input: sidecar.stdout }).on('line', (line) => {
      let frame
      try { frame = JSON.parse(line) } catch { frame = { type: '<non-json stdout>', line } }
      frames.push(frame)
      if (frame.type === 'sdk.permission.request') {
        const decision = spec.decide(frame)
        answered.push({ tool: frame.tool.name, decision })
        send({ type: 'permission.respond', sessionId, requestId: frame.requestId, decision })
      }
      for (const waiter of [...waiters]) if (waiter.match(frame)) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(frame) }
    })
    const waitFor = (match, what) => new Promise((resolve, reject) => {
      const hit = frames.find(match)
      if (hit) return resolve(hit)
      const timer = setTimeout(() => reject(new Error(`${name}: timed out waiting for ${what}`)), TURN_TIMEOUT_MS)
      waiters.push({ match, resolve: (frame) => { clearTimeout(timer); resolve(frame) } })
    })

    const requestId = randomUUID()
    const nativeSessionId = randomUUID()
    send({ type: 'create', protocol: 2, boot: { kind: 'fresh' }, requestId, sessionId: nativeSessionId, cwd: fixture.cwd, model: FAKE_MODEL, permissionMode: 'default' })
    const created = await waitFor((frame) => frame.requestId === requestId && (frame.type === 'created' || frame.type === 'create.failed'), 'created')
    if (created.type !== 'created') throw new Error(`the sidecar refused the create: ${created.message}`)
    if (created.sessionId !== nativeSessionId) throw new Error('the sidecar changed the requested native session identity')
    sessionId = created.sessionId
    if (spec.plan) {
      send({ type: 'configure', sessionId, requestId: 'to-plan', settings: { permissionMode: 'plan' } })
      const answer = await waitFor((frame) => frame.type === 'sdk.configured' && frame.requestId === 'to-plan', 'the plan-mode configure')
      if (answer.ok !== true) throw new Error(`configure to plan failed: ${answer.message}`)
    }
    for (let turn = 0; turn < spec.turns.length; turn += 1) {
      state.turn = turn
      state.step = 0
      const results = frames.filter((frame) => frame.type === 'sdk.result').length
      log('info', 'turn.start', { scenario: name, turn })
      send({ type: 'send', sessionId, uuid: randomUUID(), text: `contract turn ${turn + 1}` })
      await waitFor(() => frames.filter((frame) => frame.type === 'sdk.result').length > results, `the result of turn ${turn + 1}`)
    }
    // A status the CLI reports after a result still reaches the sidecar.
    await sleep(300)
    settingsLocal = await readJson(path.join(fixture.cwd, '.claude', 'settings.local.json'))
    for (const file of ['foo.txt', 'after.txt']) {
      written[file] = (await fs.stat(path.join(fixture.cwd, file)).catch(() => null)) !== null
    }
    send({ type: 'shutdown' })
    sidecar.stdin.end()
    await Promise.race([exited, sleep(10_000)])
  } catch (error) {
    failure = String(error?.message ?? error).slice(0, 1000)
    log('error', 'scenario.failed', { scenario: name, error: failure })
  } finally {
    await stopFixtureProcess(sidecar)
    if (provider) await provider.close()
    await fixture.cleanup()
  }
  const fixtureRemoved = !(await fs.stat(fixture.root).catch(() => null))
  const relabel = (value) => JSON.parse(JSON.stringify(value).replaceAll(fixture.root, '<root>'))
  return relabel({ failure, fixtureRemoved, sidecarExit, frames: frames.map(slim), answered, settingsLocal, written })
}

const entries = await Promise.all(Object.entries(SCENARIOS).map(async ([name, spec]) => [name, await runScenario(name, spec)]))
const scenarios = Object.fromEntries(entries)
const failed = entries.some(([, result]) => result.failure || !result.fixtureRemoved)
const receipt = { sdkVersion: pinned.sdkVersion, bundledCliVersion: pinned.cliVersion, plan: PLAN, planFileText: PLAN_FILE_TEXT, scenarios }
process.stdout.write(`${JSON.stringify(receipt)}\n`, () => process.exit(failed ? 1 : 0))
