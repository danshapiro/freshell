#!/usr/bin/env node
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { spawn, spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { artifactMetadata, repoRoot, verifyArtifact, ambientCodex, verifySandbox, nativeSandboxPolicy } from '../../../scripts/testing/prepare-codex-contract.mjs'
import { createCodexLocalProvider, MCP_FORM_CONTENT } from './codex-local-provider.mjs'

const scenarios = ['text-history', 'active-input-stop', 'parent-child-read', 'plan-question-controls', 'mcp-form-url', 'model-effort-usage', 'approval-policy-restricted-exec']
const deadline = (promise, ms, label) => {
  let timer
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`CODEX_CONTRACT_TIMEOUT: ${label}`)), ms) })]).finally(() => clearTimeout(timer))
}
function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

async function roots(options) {
  const metadata = options.probeMetadata ?? artifactMetadata
  let staged
  if (fs.existsSync(path.join(repoRoot, '.runtime-build/codex-contract/staged.json'))) staged = JSON.parse(await fsp.readFile(path.join(repoRoot, '.runtime-build/codex-contract/staged.json'), 'utf8'))
  const artifactRoot = options.artifactRoot ?? process.env.FRESHELL_CODEX_CONTRACT_ROOT ?? (process.env.FRESHELL_SANDBOX_MODE === 'runtime-suite' ? staged?.artifactRoot : undefined)
  if (!artifactRoot) throw new Error('CODEX_CONTRACT_PREREQUISITE: explicit prepared artifact root is missing; no PATH fallback')
  const artifact = await verifyArtifact(artifactRoot, metadata)
  const stateBase = options.stateRoot ?? (process.env.FRESHELL_SANDBOX_MODE === 'runtime-suite' ? staged?.stateRoot : undefined) ?? os.tmpdir()
  const stateRoot = await fsp.mkdtemp(path.join(stateBase, 'codex-contract-'))
  const receiptRoot = path.resolve(options.receiptDir ?? (process.env.FRESHELL_SANDBOX_MODE === 'runtime-suite' ? staged?.receiptRoot : undefined) ?? path.join(stateRoot, 'receipts'))
  await fsp.mkdir(receiptRoot, { recursive: true, mode: 0o700 })
  for (const directory of ['home', 'codex', 'xdg-config', 'xdg-cache', 'xdg-data', 'workspace', 'tmp']) await fsp.mkdir(path.join(stateRoot, directory), { mode: 0o700 })
  const systemConfig = ['/etc/codex/config.toml', '/etc/codex/requirements.toml'].map(file => ({ path: file, present: fs.existsSync(file) }))
  if (systemConfig.some(file => file.present)) throw new Error('CODEX_CONTRACT_PREREQUISITE: unexpected system Codex configuration in fixture environment')
  const environment = { PATH: process.env.PATH, HOME: path.join(stateRoot, 'home'), CODEX_HOME: await fsp.realpath(path.join(stateRoot, 'codex')), XDG_CONFIG_HOME: path.join(stateRoot, 'xdg-config'), XDG_CACHE_HOME: path.join(stateRoot, 'xdg-cache'), XDG_DATA_HOME: path.join(stateRoot, 'xdg-data'), TMPDIR: path.join(stateRoot, 'tmp'), LANG: 'C.UTF-8', RUST_LOG: 'warn' }
  if (!options.probeMetadata || options.preferBundledBwrap) {
    const bundled = artifact.files.filter(file => file.path.endsWith('/codex-resources/bwrap'))
    assert.equal(bundled.length, 1, 'fixture PATH selection needs the single verified bundled bubblewrap resource')
    environment.PATH = `${path.dirname(path.join(artifact.path, bundled[0].path))}:${environment.PATH}`
  }
  return { artifact, metadata, stateRoot, receiptRoot, environment, workspace: path.join(stateRoot, 'workspace'), systemConfig, staged }
}

class NativeClient {
  constructor(binary, context, capture) {
    this.capture = capture
    this.pending = new Map()
    this.waiters = new Set()
    this.nextId = 1
    this.child = spawn(binary, ['app-server'], { cwd: context.workspace, env: context.environment, stdio: ['pipe', 'pipe', 'pipe'] })
    if (capture.environment.seccompProbe || capture.environment.nativeSandboxPolicy) {
      const observed = new Map((capture.observations.executedSandboxHelpers ?? []).map(helper => [helper.pid, helper]))
      this.helperWatcher = setInterval(() => {
        const visit = pid => {
          try {
            const executable = fs.readlinkSync(`/proc/${pid}/exe`)
            if (executable.endsWith('/bwrap')) observed.set(pid, { pid, executable, argv0: fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0')[0] })
          } catch {}
          try {
            const children = new Set()
            for (const task of fs.readdirSync(`/proc/${pid}/task`)) {
              try { for (const child of fs.readFileSync(`/proc/${pid}/task/${task}/children`, 'utf8').trim().split(/\s+/).filter(Boolean)) children.add(Number(child)) } catch {}
            }
            for (const child of children) visit(child)
          } catch {}
        }
        if (this.child.exitCode === null) visit(this.child.pid)
        capture.observations.executedSandboxHelpers = [...observed.values()]
      }, 5)
    }
    this.exit = new Promise(resolve => this.child.once('exit', (code, signal) => {
      capture.processExit = { code, signal }
      clearInterval(this.helperWatcher)
      for (const entry of this.pending.values()) entry.reject(new Error(`owned Codex exited: ${code}/${signal}`))
      resolve({ code, signal })
    }))
    this.child.stderr.on('data', bytes => { capture.stderr = `${capture.stderr ?? ''}${bytes.toString()}`.slice(-64 * 1024) })
    createInterface({ input: this.child.stdout }).on('line', line => {
      let frame
      try { frame = JSON.parse(line) } catch { return }
      capture.frames.push({ index: capture.frames.length, direction: 'native', frame })
      if (frame.id !== undefined && !frame.method) {
        capture.responses.push(frame)
        const entry = this.pending.get(frame.id)
        if (entry) { this.pending.delete(frame.id); if (frame.error) entry.reject(Object.assign(new Error(frame.error.message), { nativeError: frame.error })); else entry.resolve(frame.result) }
      } else if (frame.method && frame.id !== undefined) {
        capture.serverRequests.push(frame)
        this.onServerRequest?.(frame)
      }
      else capture.notifications.push(frame)
      for (const waiter of [...this.waiters]) if (waiter.predicate(frame)) { this.waiters.delete(waiter); waiter.resolve(frame) }
    })
  }
  send(frame) { this.capture.frames.push({ index: this.capture.frames.length, direction: 'client', frame }); this.child.stdin.write(`${JSON.stringify(frame)}\n`) }
  request(method, params = {}, timeoutMs = 30_000) {
    const id = this.nextId++
    const frame = { id, method, params }
    this.capture.requests.push(frame)
    return deadline(new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.send(frame) }), timeoutMs, method)
  }
  wait(predicate, timeoutMs = 30_000) {
    const existing = this.capture.frames.find(entry => entry.direction === 'native' && predicate(entry.frame))
    if (existing) return Promise.resolve(existing.frame)
    let waiter
    return deadline(new Promise(resolve => { waiter = { predicate, resolve }; this.waiters.add(waiter) }), timeoutMs, 'native notification').finally(() => this.waiters.delete(waiter))
  }
  async close() {
    this.child.stdin.end()
    if (this.child.exitCode === null) this.child.kill('SIGTERM')
    try { await deadline(this.exit, 5000, 'owned process exit') } catch { this.child.kill('SIGKILL'); await deadline(this.exit, 5000, 'owned process kill') }
  }
}

function assistantText(read, nativeTurnId) {
  return read.thread.turns.filter(turn => !nativeTurnId || turn.id === nativeTurnId).flatMap(turn => turn.items.filter(item => item.type === 'agentMessage').map(item => item.text)).join('\n')
}

async function nativeRefusal(client, method, params) {
  try { await client.request(method, params) } catch (error) { assert(error.nativeError, 'refusal must come from the native provider'); return error.nativeError }
  assert.fail(`native ${method} unexpectedly accepted invalid input`)
}

async function configure(context, baseUrl, extra = '') {
  await fsp.writeFile(path.join(context.environment.CODEX_HOME, 'config.toml'), `model = "contract-model"\nmodel_provider = "contract-loopback"\nmodel_reasoning_effort = "low"\n${extra}\n[model_providers.contract-loopback]\nname = "Codex contract loopback"\nbase_url = ${JSON.stringify(baseUrl)}\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\nrequest_max_retries = 0\nstream_max_retries = 0\n`)
}

function advertisedCall(record, name, args, id) {
  let namespace
  let tool = record.body.tools.find(tool => tool.type === 'function' && tool.name === name)
  if (!tool) {
    const group = record.body.tools.find(tool => tool.type === 'namespace' && tool.tools?.some(member => member.name === name))
    tool = group?.tools.find(member => member.name === name)
    namespace = group?.name
  }
  assert(tool, `actual native model request did not advertise ${name}`)
  return { items: [{ id: `fc_${id}`, type: 'function_call', call_id: `call_${id}`, ...(namespace ? { namespace } : {}), name, arguments: JSON.stringify(args), status: 'completed' }] }
}

async function questionResponse(record, flow, capture) {
  const current = flow.current
  assert(current, 'question model work must belong to the selected native case')
  const step = current.step++
  if (current.kind === 'contextual-reply') {
    capture.observations.contextualAnswerModelInput = record.body.input
    return { text: 'First fragment and final fragment' }
  }
  if (step === 0) {
    if (current.kind === 'async') return advertisedCall(record, 'request_user_input_async', { questions: [{ title: 'Which fixture environment should be used?', options: ['Staging', 'Production'] }, { title: 'What deadline should be used?' }] }, `async_${current.id}`)
    return advertisedCall(record, 'request_user_input', { questions: [{ id: 'fixture_choice', header: 'Choice', question: 'Which fixture result should be used?', options: [{ label: 'Alpha (Recommended)', description: 'Use the first result.' }, { label: 'Beta', description: 'Use the second result.' }] }] }, `question_${current.id}`)
  }
  assert(record.body.input.some(item => item.type === 'function_call_output' && item.call_id === `call_${current.kind === 'async' ? 'async' : 'question'}_${current.id}`), 'continued model work must receive the real native question result')
  if (current.kind === 'async') {
    capture.observations.asyncContinuedBeforeAnswer = true
    return { text: 'Work continued after the asynchronous question.' }
  }
  return { text: current.mode === 'plan' ? 'Preface\n<proposed_plan>\n# Fixture plan\n- Inspect the fixture.\n- Return the result.\n</proposed_plan>\nPostscript' : 'First fragment and final fragment' }
}

async function driveQuestions(client, capture, flow) {
  capture.observations.questionCases = []
  for (const mode of ['plan', 'default']) {
    for (const cancelled of [false, true]) {
      const current = { id: `${mode}_${cancelled ? 'cancelled' : 'answered'}`, kind: 'awaited', mode, cancelled, step: 0 }
      flow.current = current
      const turn = await client.request('turn/start', { threadId: capture.threadId, input: [{ type: 'text', text: `Ask the controlled ${mode} question.` }], collaborationMode: { mode, settings: { model: 'contract-model', reasoning_effort: 'low', developer_instructions: null } } })
      const request = await client.wait(frame => frame.method === 'item/tool/requestUserInput' && frame.params?.turnId === turn.turn.id)
      assert.equal(request.params.isBlocking, mode === 'plan')
      assert.equal(request.params.questions[0].id, 'fixture_choice')
      const responsesBeforeAnswer = current.step
      if (cancelled) await client.request('turn/interrupt', { threadId: capture.threadId, turnId: turn.turn.id })
      else client.send({ id: request.id, result: { answers: { fixture_choice: { answers: ['Alpha (Recommended)'] } } } })
      const terminal = await client.wait(frame => frame.method === 'turn/completed' && frame.params?.turn?.id === turn.turn.id)
      assert.equal(terminal.params.turn.status, cancelled ? 'interrupted' : 'completed')
      assert.equal(responsesBeforeAnswer, 1, 'both true and false isBlocking requests await their actual reply')
      const read = await client.request('thread/read', { threadId: capture.threadId, includeTurns: true })
      capture.reads.push({ label: current.id, body: read })
      if (mode === 'plan' && !cancelled) {
        assert(capture.notifications.some(frame => frame.method === 'item/plan/delta' && frame.params?.turnId === turn.turn.id), 'Plan mode must emit actual native plan deltas')
        assert(read.thread.turns.some(nativeTurn => nativeTurn.id === turn.turn.id && nativeTurn.items.some(item => item.type === 'plan')))
      }
      capture.observations.questionCases.push({ id: current.id, turnId: turn.turn.id, requestId: request.id, isBlocking: request.params.isBlocking, cancelled })
    }
  }
  flow.current = { id: 'async', kind: 'async', mode: 'default', step: 0 }
  const asynchronous = await client.request('turn/start', { threadId: capture.threadId, input: [{ type: 'text', text: 'Ask the true asynchronous fixture questions and continue work.' }], collaborationMode: { mode: 'default', settings: { model: 'contract-model', reasoning_effort: 'low', developer_instructions: null } } })
  const asyncItem = await client.wait(frame => frame.params?.turnId === asynchronous.turn.id && frame.params.item?.type === 'agentMessage' && frame.params.item.delivery === 'async')
  capture.observations.asyncQuestionItem = asyncItem.params.item
  await client.wait(frame => frame.method === 'turn/completed' && frame.params?.turn?.id === asynchronous.turn.id)
  assert.equal(capture.observations.asyncContinuedBeforeAnswer, true)
  assert(!capture.serverRequests.some(frame => frame.method === 'item/tool/requestUserInput' && frame.params?.turnId === asynchronous.turn.id), 'true async questions must not create a pending reply RPC')
  flow.current = { id: 'contextual-reply', kind: 'contextual-reply', step: 0 }
  const answer = 'Question: Which fixture environment should be used? Answer: Staging. Question: What deadline should be used? Answer: Friday.'
  const reply = await client.request('turn/start', { threadId: capture.threadId, input: [{ type: 'text', text: answer }] })
  await client.wait(frame => frame.method === 'turn/completed' && frame.params?.turn?.id === reply.turn.id)
  assert(JSON.stringify(capture.observations.contextualAnswerModelInput).includes(answer), 'ordinary contextual answer must reach the real next model request')
  return reply
}

function mcpResponse(record, flow) {
  const current = flow.current
  assert(current, 'MCP model work must belong to the selected native case')
  if (current.step++ === 0) return advertisedCall(record, 'elicit', { route: current.route, sequence: current.hold ? 'hold' : 'matrix' }, `mcp_${current.id}`)
  assert(record.body.input.some(item => item.type === 'function_call_output' && item.call_id === `call_mcp_${current.id}` && JSON.stringify(item.output).includes('Fixture sequence completed')), 'MCP result must traverse native tools/call and return to the real model request')
  return { text: 'First fragment and final fragment' }
}

async function driveMcp(client, capture, flow, context) {
  capture.observations.elicitationCases = []
  let last
  for (const route of ['form', 'openai/form', 'openaiForm', 'url']) {
    const current = { id: route.replaceAll('/', '_'), route, step: 0 }
    flow.current = current
    last = await client.request('turn/start', { threadId: capture.threadId, input: [{ type: 'text', text: `Run the controlled ${route} MCP matrix.` }] })
    for (const action of ['accept', 'decline', 'cancel']) {
      const already = new Set(capture.observations.elicitationCases.filter(record => record.turnId === last.turn.id).map(record => record.requestId))
      const request = await client.wait(frame => frame.method === 'mcpServer/elicitation/request' && frame.params?.turnId === last.turn.id && !already.has(frame.id))
      assert.equal(request.params.mode, route)
      const result = { action, ...(action === 'accept' && route !== 'url' ? { content: MCP_FORM_CONTENT, _meta: { 'fixture/response': 'accepted' } } : {}) }
      client.send({ id: request.id, result })
      capture.observations.elicitationCases.push({ route, action, requestId: request.id, turnId: last.turn.id, elicitationId: request.params.elicitationId ?? null })
    }
    const terminal = await client.wait(frame => frame.method === 'turn/completed' && frame.params?.turn?.id === last.turn.id)
    assert.equal(terminal.params.turn.status, 'completed')
    capture.reads.push({ label: `mcp-${route}`, body: await client.request('thread/read', { threadId: capture.threadId, includeTurns: true }) })
  }
  const trace = (await fsp.readFile(context.mcpTrace, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  capture.observations.mcpTraffic = trace
  assert.equal(trace.filter(record => record.event === 'elicitation_result').length, 12)
  assert(!trace.some(record => record.event === 'fixture_error'), 'ordinary MCP route must return actual native responses without fixture errors')
  const initialized = trace.find(record => record.direction === 'native' && record.frame?.method === 'initialize')
  assert(initialized, 'configured MCP server must actually initialize')
  capture.observations.mcpInitialize = initialized.frame.params
  assert.equal(capture.observations.elicitationCases.length, 12)
  return last
}

export async function captureNativeScenario(name, options = {}) {
  assert(scenarios.includes(name), `unknown native scenario ${name}`)
  const context = await roots(options)
  const capture = { scenario: name, probeOnly: options.probeMetadata?.probeOnly === true, binary: { path: path.join(context.artifact.path, context.metadata.executable), version: null, platform: `${process.platform}-${process.arch}`, integrity: context.artifact.integrity }, threadId: null, requests: [], responses: [], serverRequests: [], notifications: [], reads: [], fixtureTraffic: [], observations: {}, frames: [], environment: { uid: process.getuid?.(), gid: process.getgid?.(), groups: process.getgroups?.(), artifact: context.artifact, systemConfig: context.systemConfig, writableRoots: { state: context.stateRoot, receipts: context.receiptRoot }, prerequisites: context.staged ?? null, context: context.environment, ambientBefore: ambientCodex() } }
  if (options.seccompProbeReceipt) capture.environment.seccompProbe = JSON.parse(await fsp.readFile(options.seccompProbeReceipt, 'utf8'))
  if (process.env.FRESHELL_CODEX_CONTRACT_POLICY === 'prepared') {
    const declared = nativeSandboxPolicy()
    assert.equal(context.staged?.nativeSandboxPolicy?.id, declared.id)
    assert.equal(context.staged.nativeSandboxPolicy.profileSha256, declared.profileSha256)
    capture.environment.nativeSandboxPolicy = context.staged.nativeSandboxPolicy
  }
  capture.environment.bwrapCandidates = []
  for (const directory of context.environment.PATH.split(path.delimiter)) {
    const candidate = path.join(directory, 'bwrap')
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      const absolute = fs.realpathSync(candidate)
      const version = spawnSync(absolute, ['--version'], { env: context.environment, encoding: 'utf8', timeout: 5000 })
      capture.environment.bwrapCandidates.push({ path: absolute, status: version.status, stdout: version.stdout, stderr: version.stderr })
    } catch {}
  }
  const readable = file => { try { return fs.readFileSync(file, 'utf8').trim() } catch (error) { return { unavailable: error.code } } }
  const status = readable('/proc/self/status')
  capture.environment.kernelBoundary = {
    appArmorProfile: readable('/proc/self/attr/current'),
    status: typeof status === 'string' ? status.split('\n').filter(line => /^(Uid|Gid|Groups|CapInh|CapPrm|CapEff|CapBnd|NoNewPrivs|Seccomp|Seccomp_filters):/.test(line)) : status,
    sysctls: Object.fromEntries(['kernel/unprivileged_userns_clone', 'kernel/apparmor_restrict_unprivileged_userns', 'kernel/apparmor_restrict_unprivileged_unconfined', 'user/max_user_namespaces'].map(key => [key, readable(`/proc/sys/${key}`)])),
  }
  let client
  let fixture
  let modelStep = 0
  let releaseStream
  const childRequested = deferred()
  const childStream = deferred()
  const parentStream = deferred()
  const controlFlow = { current: null }
  try {
    assert.equal(process.platform, 'linux'); assert.equal(process.arch, 'x64')
    const version = spawnSync(capture.binary.path, ['--version'], { env: context.environment, encoding: 'utf8', timeout: 15_000 })
    assert.equal(version.status, 0, version.stderr)
    capture.binary.version = version.stdout.trim().replace(/^codex-cli /, '')
    assert.equal(capture.binary.version, context.metadata.version)
    fixture = await createCodexLocalProvider(async record => {
      const step = modelStep++
      if (name === 'plan-question-controls') return questionResponse(record, controlFlow, capture)
      if (name === 'mcp-form-url') return mcpResponse(record, controlFlow)
      if (name === 'parent-child-read') {
        const childInput = record.body.input.some(item => item.role === 'user' && JSON.stringify(item.content).includes('freshell-child-native-probe'))
        if (childInput) {
          childRequested.resolve()
          return { text: 'Exact child final answer.', pauseAfterDelta: () => childStream.promise }
        }
        if (step === 0) {
          const namespace = record.body.tools.find(tool => tool.type === 'namespace' && tool.tools?.some(member => member.name === 'spawn_agent'))
          assert(namespace, 'native parent must actually advertise spawn_agent')
          capture.observations.advertisedSpawn = namespace.tools.find(member => member.name === 'spawn_agent')
          return { items: [{ id: 'fc_native_child', type: 'function_call', call_id: 'call_native_child', namespace: namespace.name, name: 'spawn_agent', arguments: JSON.stringify({ message: 'freshell-child-native-probe: return the controlled child answer.', fork_context: false }), status: 'completed' }] }
        }
        await parentStream.promise
        return { text: 'First fragment and final fragment' }
      }
      if (name === 'active-input-stop' && step === 0) return { text: 'Interrupted native fragment', pauseAfterDelta: () => new Promise(resolve => { releaseStream = resolve }) }
      if (name === 'text-history' && options.duplicateBodies) return { items: [0, 1].map(index => ({ id: `msg_duplicate_${index}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'First fragment and final fragment', annotations: [] }] })) }
      const commands = [options.sandboxMode === 'workspace-write' ? 'cat contract-input.txt && printf codex-workspace-write > contract-output.txt' : 'cat contract-input.txt']
      if (options.seccompProbeReceipt) commands[0] += '; sleep 0.3'
      if (options.probeNetworkEnabled) {
        const script = `import socket; s=socket.create_connection(('127.0.0.1', ${new URL(fixture.baseUrl).port}), timeout=2); s.sendall(b'GET /native-permitted-network-canary HTTP/1.0\\r\\n\\r\\n'); print(s.recv(128))`
        commands[0] += `; python3 -c '${script.replaceAll("'", "'\\''")}'`
      }
      if (options.probePolicyEffects) {
        const quote = value => `'${value.replaceAll("'", "'\\''")}'`
        const networkScript = `import socket; s=socket.create_connection(('127.0.0.1', ${new URL(fixture.baseUrl).port}), timeout=2); s.sendall(b'GET /native-network-canary HTTP/1.0\\r\\n\\r\\n'); print(s.recv(128))`
        commands.push(`printf forbidden-outside > ${quote(path.join(context.stateRoot, 'outside/forbidden.txt'))}`, 'printf forbidden-git > .git/freshell-contract-denied', 'printf forbidden-codex > .codex/freshell-contract-denied', `python3 -c ${quote(networkScript)}`)
        if (options.seccompProbeReceipt) commands.push('printf forbidden-agents > .agents/freshell-contract-denied', `printf forbidden-home > ${quote(path.join(context.environment.HOME, 'forbidden.txt'))}`, `printf forbidden-state > ${quote(path.join(context.environment.CODEX_HOME, 'forbidden.txt'))}`, `printf forbidden-tmpdir > ${quote(path.join(context.environment.TMPDIR, 'forbidden.txt'))}`, 'printf forbidden-global-temp > /tmp/freshell-codex-excluded-temp', ...(options.sandboxMode === 'read-only' ? ['printf forbidden-workspace > contract-readonly-forbidden.txt'] : []))
      }
      const deniedStep = options.probePolicyEffects && step === commands.length + 1
      if (name === 'approval-policy-restricted-exec' && (step < commands.length || deniedStep)) {
        const tools = record.body.tools ?? []
        const tool = tools.find(tool => tool.name === 'exec_command') ?? tools.find(tool => tool.name === 'shell') ?? tools.find(tool => tool.name === 'shell_command')
        assert(tool, `native command tool not advertised: ${tools.map(tool => tool.name).join(',')}`)
        capture.observations.advertisedCommandTool = tool
        const command = deniedStep ? 'printf denied-by-user > denied-by-user.txt' : commands[step]
        const args = tool.name === 'exec_command' ? { cmd: command, max_output_tokens: 1000, shell: '/bin/sh', login: false } : tool.name === 'shell' ? { command: ['sh', '-c', command] } : { command }
        const callId = step === 0 ? 'call_contract_command' : `call_contract_${step}`
        return { items: [{ id: `fc_contract_${step}`, type: 'function_call', call_id: callId, name: tool.name, arguments: JSON.stringify(args), status: 'completed' }] }
      }
      if (name === 'approval-policy-restricted-exec') assert(record.body.input.some(item => item.type === 'function_call_output' && item.call_id === 'call_contract_command'), 'follow-up model response requires the actual native command result')
      return { text: 'First fragment and final fragment' }
    })
    let extraConfig = options.legacyLandlock ? '[features]\nuse_legacy_landlock = true\n' : ''
    if (['plan-question-controls', 'mcp-form-url'].includes(name)) {
      const catalogPath = path.join(context.stateRoot, 'models.json')
      await fsp.writeFile(catalogPath, JSON.stringify({ models: [{ slug: 'contract-model', display_name: 'Contract model', description: 'Owned loopback native contract', default_reasoning_level: 'low', supported_reasoning_levels: [{ effort: 'low', description: 'Contract effort' }], shell_type: 'disabled', visibility: 'list', supported_in_api: true, priority: 0, support_verbosity: false, truncation_policy: { mode: 'tokens', limit: 10000 }, context_window: 128000, experimental_supported_tools: ['request_user_input_async'], supports_search_tool: false, tool_mode: 'direct', use_responses_lite: false, model_messages: { instructions_template: "Follow the user's request using the available tools." } }] }))
      extraConfig = `model_catalog_json = ${JSON.stringify(catalogPath)}\nweb_search = "disabled"\n[features]\napps = false\ndefault_mode_request_user_input = true\nauth_elicitation = true\nnon_prefixed_mcp_tool_names = false\n[tools.experimental_request_user_input]\nenabled = true\n`
      if (name === 'mcp-form-url') {
        context.mcpTrace = path.join(context.stateRoot, 'mcp-traffic.jsonl')
        await fsp.writeFile(context.mcpTrace, '', { mode: 0o600 })
        extraConfig += `\n[mcp_servers.contract]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ${JSON.stringify([path.join(repoRoot, 'test/integration/providers/codex-local-provider.mjs'), '--mcp-fixture', context.mcpTrace, fixture.baseUrl.replace(/\/v1$/, '')])}\nenabled = true\nrequired = true\nstartup_readiness = "connection"\nstartup_timeout_sec = 15\ntool_timeout_sec = 120\n`
      }
    }
    await configure(context, fixture.baseUrl, extraConfig)
    const restricted = name === 'approval-policy-restricted-exec'
    if (restricted) {
      await fsp.writeFile(path.join(context.workspace, 'contract-input.txt'), 'codex-restricted-command-ran\n')
      if (options.probePolicyEffects) {
        const initialized = spawnSync('git', ['init', '--quiet'], { cwd: context.workspace, env: context.environment, encoding: 'utf8', timeout: 15_000 })
        assert.equal(initialized.status, 0, initialized.stderr)
        await fsp.mkdir(path.join(context.workspace, '.codex'))
        await fsp.mkdir(path.join(context.workspace, '.agents'))
        await fsp.mkdir(path.join(context.stateRoot, 'outside'), { mode: 0o700 })
        capture.observations.gitCommonDir = spawnSync('git', ['rev-parse', '--git-common-dir'], { cwd: context.workspace, env: context.environment, encoding: 'utf8', timeout: 15_000 }).stdout.trim()
        if (options.seccompProbeReceipt) {
          const mountRoot = path.join(context.stateRoot, 'raw-mount-attempt')
          await fsp.mkdir(mountRoot)
          const mounted = spawnSync('mount', ['-t', 'tmpfs', 'tmpfs', mountRoot], { env: context.environment, encoding: 'utf8', timeout: 15_000 })
          capture.observations.outerMountAttempt = { status: mounted.status, stderr: mounted.stderr, stdout: mounted.stdout, error: mounted.error?.message }
          assert.notEqual(mounted.status, 0, 'outer mount without a user namespace must remain denied')
        }
      }
      if (!options.probeMetadata) {
        await configure(context, fixture.baseUrl, `approval_policy = "untrusted"\n${extraConfig}`)
        const rejection = spawnSync(capture.binary.path, ['exec', '--skip-git-repo-check', '--json', 'Do not perform work; public config rejection probe.'], { env: context.environment, cwd: context.workspace, encoding: 'utf8', timeout: 15_000 })
        capture.observations.publicUntrustedRejection = { status: rejection.status, stdout: rejection.stdout, stderr: rejection.stderr, fixtureRequests: fixture.traffic.length }
        assert.notEqual(rejection.status, 0)
        assert.match(rejection.stderr, /approval_policy\s*=\s*"untrusted" is no longer supported/)
        assert.equal(fixture.traffic.length, 0, 'public config rejection must precede model work')
      }
      // Only this owned fixture configuration is rewritten. Production source
      // projection is a later gate, and is never claimed by this native probe.
      await configure(context, fixture.baseUrl, extraConfig)
    }
    client = new NativeClient(capture.binary.path, context, capture)
    client.onServerRequest = frame => {
      if (frame.method === 'item/commandExecution/requestApproval') {
        const decision = frame.params.command?.includes('denied-by-user') ? 'cancel' : 'accept'
        const approval = { id: frame.id, params: frame.params, decision }
        capture.observations.commandApproval ??= approval
        ;(capture.observations.commandApprovals ??= []).push(approval)
        client.send({ id: frame.id, result: { decision } })
      }
    }
    const capabilities = { experimentalApi: true, ...(name === 'mcp-form-url' ? { extensions: { 'openai/form': {}, 'openai/elicitation': { form: {} }, 'openai/standard-form-input': {} } } : {}) }
    capture.observations.initialize = await client.request('initialize', { clientInfo: { name: 'freshell_codex_contract', title: 'Freshell isolated native contract', version: '1.0.0' }, capabilities })
    client.send({ method: 'initialized', params: {} })
    capture.observations.effectiveConfig = await client.request('config/read', { includeLayers: true })
    if (name === 'model-effort-usage') {
      capture.observations.models = await client.request('model/list', { includeHidden: false, limit: 100 })
      assert(capture.observations.models.data.length > 0, 'release model discovery must return actual metadata')
    }
    const policy = options.probeApprovalPolicy ?? (restricted ? 'untrusted' : name === 'mcp-form-url' ? 'on-request' : 'never')
    const sandboxMode = options.sandboxMode ?? 'read-only'
    const started = await client.request('thread/start', { cwd: context.workspace, model: 'contract-model', modelProvider: 'contract-loopback', approvalPolicy: policy, sandbox: sandboxMode, experimentalRawEvents: false, persistExtendedHistory: true, ephemeral: options.ephemeralParent ?? false, ...(options.historyMode ? { historyMode: options.historyMode } : {}) })
    capture.threadId = started.thread.id
    capture.observations.threadStart = started
    assert.equal(started.approvalPolicy, policy, 'typed native policy must remain effective')
    const sandboxPolicy = sandboxMode === 'workspace-write' ? { type: 'workspaceWrite', writableRoots: [context.workspace], networkAccess: options.probeNetworkEnabled ?? false, excludeTmpdirEnvVar: true, excludeSlashTmp: true } : { type: 'readOnly', networkAccess: options.probeNetworkEnabled ?? false }
    let turn = name === 'plan-question-controls' ? await driveQuestions(client, capture, controlFlow) : name === 'mcp-form-url' ? await driveMcp(client, capture, controlFlow, context) : await client.request('turn/start', { threadId: capture.threadId, approvalPolicy: policy, ...(restricted && !options.probeDefaultPolicy ? { sandboxPolicy } : {}), input: [{ type: 'text', text: 'Run the controlled contract scenario.' }] })
    capture.observations.startedTurnId = turn.turn.id
    if (name === 'parent-child-read') {
      const spawned = await client.wait(frame => frame.method === 'item/completed' && frame.params?.item?.type === 'collabAgentToolCall' && frame.params.item.receiverThreadIds?.length > 0)
      const childId = spawned.params.item.receiverThreadIds[0]
      capture.observations.childId = childId
      await deadline(childRequested.promise, 30_000, 'actual child model request')
      const activeMetadata = await client.request('thread/read', { threadId: childId, includeTurns: false })
      capture.reads.push({ label: 'child-active-metadata', body: activeMetadata })
      assert.equal(activeMetadata.thread.parentThreadId, capture.threadId, 'read child must carry the exact native parent relationship')
      assert.equal(activeMetadata.thread.ephemeral, options.ephemeralParent ?? false)
      if (options.ephemeralParent) {
        capture.observations.ephemeralChildReadRefusal = await nativeRefusal(client, 'thread/read', { threadId: childId, includeTurns: true })
        assert.match(capture.observations.ephemeralChildReadRefusal.message, /ephemeral/i)
        capture.observations.childAvailability = 'ephemeral_history_unavailable'
      } else {
        const activeRead = await client.request('thread/read', { threadId: childId, includeTurns: true })
        capture.reads.push({ label: 'child-active-history', body: activeRead })
      }
      childStream.resolve()
      const childSettled = await deadline((async () => {
        for (;;) {
          const body = await client.request('thread/read', { threadId: childId, includeTurns: !options.ephemeralParent })
          if (options.ephemeralParent ? body.thread.status.type === 'idle' : assistantText(body) === 'Exact child final answer.') return body
          await new Promise(resolve => setTimeout(resolve, 25))
        }
      })(), 30_000, 'child native completion/saving')
      capture.reads.push({ label: 'child-settled', body: childSettled })
      capture.observations.childFinalText = options.ephemeralParent ? null : assistantText(childSettled)
      parentStream.resolve()
    }
    if (name === 'active-input-stop') {
      const firstTurnId = turn.turn.id
      const delta = await client.wait(frame => frame.method === 'item/agentMessage/delta' && frame.params?.turnId === firstTurnId)
      assert(delta.params.delta.length > 0, 'interruption must follow actual nonempty native output')
      capture.observations.mismatchedSteer = await nativeRefusal(client, 'turn/steer', { threadId: capture.threadId, expectedTurnId: 'not-the-active-turn', input: [{ type: 'text', text: 'Must be refused.' }] })
      const steered = await client.request('turn/steer', { threadId: capture.threadId, expectedTurnId: firstTurnId, input: [{ type: 'text', text: 'Controlled same-turn steering input.' }] })
      assert.equal(steered.turnId, firstTurnId)
      capture.observations.acceptedSteer = steered
      capture.observations.stopAcknowledgement = await client.request('turn/interrupt', { threadId: capture.threadId, turnId: firstTurnId })
      const terminal = await client.wait(frame => frame.method === 'turn/completed' && frame.params?.turn?.id === firstTurnId)
      capture.observations.interruptedTurn = terminal.params.turn
      assert.equal(terminal.params.turn.status, 'interrupted')
      capture.observations.retainedPartial = capture.notifications.filter(frame => frame.method === 'item/agentMessage/delta' && frame.params?.turnId === firstTurnId).map(frame => frame.params.delta).join('')
      assert.equal(capture.observations.retainedPartial, 'Interrupted native fragment')
      const interruptedRead = await client.request('thread/read', { threadId: capture.threadId, includeTurns: true })
      capture.reads.push({ label: 'interrupted-warm-native-read', body: interruptedRead })
      capture.observations.idleSteer = await nativeRefusal(client, 'turn/steer', { threadId: capture.threadId, expectedTurnId: firstTurnId, input: [{ type: 'text', text: 'No active native turn; must be refused.' }] })
      releaseStream?.()
      turn = await client.request('turn/start', { threadId: capture.threadId, input: [{ type: 'text', text: 'New work after resolved Stop.' }] })
      assert.notEqual(turn.turn.id, firstTurnId)
      capture.observations.followingTurnId = turn.turn.id
    }
    const completed = await client.wait(frame => frame.method === 'turn/completed' && frame.params?.turn?.id === turn.turn.id, options.timeoutMs ?? 120_000)
    capture.observations.completedTurn = completed.params.turn
    if (name === 'parent-child-read' && options.ephemeralParent) {
      capture.observations.ephemeralParentReadRefusal = await nativeRefusal(client, 'thread/read', { threadId: capture.threadId, includeTurns: true })
      capture.observations.childObserverMethods = capture.requests.filter(frame => frame.params.threadId === capture.observations.childId).map(frame => frame.method)
      assert(capture.observations.childObserverMethods.every(method => method === 'thread/read'))
      capture.passed = true
      return capture
    }
    const read = await client.request('thread/read', { threadId: capture.threadId, includeTurns: true })
    capture.reads.push({ label: 'completed', body: read })
    capture.observations.finalAssistantText = assistantText(read, turn.turn.id)
    const parentCompletedMessages = name === 'parent-child-read' ? capture.notifications.filter(frame => frame.method === 'item/completed' && frame.params?.turnId === turn.turn.id && frame.params.item?.type === 'agentMessage').map(frame => frame.params.item.text) : null
    if (parentCompletedMessages) {
      assert(parentCompletedMessages.length > 0)
      assert(parentCompletedMessages.every(text => text === 'First fragment and final fragment'))
      capture.observations.parentCompletedMessages = parentCompletedMessages
    }
    const expectedAssistantText = parentCompletedMessages?.join('\n') ?? Array(options.duplicateBodies ? 2 : 1).fill('First fragment and final fragment').join('\n')
    assert.equal(capture.observations.finalAssistantText, expectedAssistantText)
    capture.observations.finalItems = read.thread.turns.filter(nativeTurn => nativeTurn.id === turn.turn.id).flatMap(nativeTurn => nativeTurn.items)
    if (name === 'model-effort-usage') {
      const usage = capture.notifications.filter(frame => frame.method === 'thread/tokenUsage/updated' && frame.params?.turnId === turn.turn.id).at(-1)?.params.tokenUsage
      assert.equal(usage?.last?.totalTokens, 15, 'usage must come from the actual model completion')
      capture.observations.latestUsage = usage.last
      capture.observations.usageLabel = 'Latest usage'
      assert.equal(fixture.traffic[0].body.model, 'contract-model')
      assert.equal(fixture.traffic[0].body.reasoning.effort, 'low')
    }
    if (name === 'approval-policy-restricted-exec') {
      const commandItems = capture.notifications.filter(frame => frame.method === 'item/completed' && frame.params?.item?.type === 'commandExecution').map(frame => frame.params.item)
      capture.observations.commandItems = commandItems
      capture.observations.workspaceWritePresent = fs.existsSync(path.join(context.workspace, 'contract-output.txt'))
      if (policy === 'untrusted') assert(capture.observations.commandApproval, 'untrusted command must produce an actual approval request')
      capture.observations.restrictedCommandExecuted = commandItems.some(item => item.exitCode === 0 && item.aggregatedOutput?.includes('codex-restricted-command-ran'))
      if (options.probeNetworkEnabled) {
        capture.observations.permittedNetworkRequests = fixture.traffic.filter(request => request.path === '/native-permitted-network-canary').length
        assert.equal(capture.observations.permittedNetworkRequests, 1, 'native network-enabled policy must actually reach the parent loopback canary')
      }
      if (options.probePolicyEffects) {
        capture.observations.policyEffects = {
          outsideWrite: fs.existsSync(path.join(context.stateRoot, 'outside/forbidden.txt')),
          gitWrite: fs.existsSync(path.join(context.workspace, '.git/freshell-contract-denied')),
          codexWrite: fs.existsSync(path.join(context.workspace, '.codex/freshell-contract-denied')),
          networkRequests: fixture.traffic.filter(request => request.path === '/native-network-canary').length,
        }
        if (options.seccompProbeReceipt) Object.assign(capture.observations.policyEffects, {
          agentsWrite: fs.existsSync(path.join(context.workspace, '.agents/freshell-contract-denied')),
          homeWrite: fs.existsSync(path.join(context.environment.HOME, 'forbidden.txt')),
          stateWrite: fs.existsSync(path.join(context.environment.CODEX_HOME, 'forbidden.txt')),
          excludedTmpdirWrite: fs.existsSync(path.join(context.environment.TMPDIR, 'forbidden.txt')),
          excludedGlobalTempWrite: fs.existsSync('/tmp/freshell-codex-excluded-temp'),
          ...(sandboxMode === 'read-only' ? { workspaceWrite: fs.existsSync(path.join(context.workspace, 'contract-readonly-forbidden.txt')) } : {}),
        })
        if (policy === 'untrusted') {
          const denial = await client.request('turn/start', { threadId: capture.threadId, approvalPolicy: policy, ...(!options.probeDefaultPolicy ? { sandboxPolicy } : {}), input: [{ type: 'text', text: 'Run the separate user-denied command probe.' }] })
          capture.observations.deniedTurn = (await client.wait(frame => frame.method === 'turn/completed' && frame.params?.turn?.id === denial.turn.id, options.timeoutMs ?? 120_000)).params.turn
          capture.observations.policyEffects.userDeniedWrite = fs.existsSync(path.join(context.workspace, 'denied-by-user.txt'))
        }
      }
    } else if (!['text-history', 'active-input-stop', 'model-effort-usage', 'parent-child-read', 'plan-question-controls', 'mcp-form-url'].includes(name)) {
      throw new Error(`CODEX_CONTRACT_UNIMPLEMENTED: ${name}; text-only execution does not establish this scenario`)
    }
    await client.close()
    client = new NativeClient(capture.binary.path, context, capture)
    await client.request('initialize', { clientInfo: { name: 'freshell_codex_contract_resume', version: '1.0.0' }, capabilities })
    client.send({ method: 'initialized', params: {} })
    const resumedThread = await client.request('thread/resume', { threadId: capture.threadId, cwd: context.workspace, approvalPolicy: policy, sandbox: sandboxMode, persistExtendedHistory: true })
    capture.observations.resumeApprovalPolicy = resumedThread.approvalPolicy
    assert.equal(resumedThread.approvalPolicy, policy)
    const resumed = await client.request('thread/read', { threadId: capture.threadId, includeTurns: true })
    capture.reads.push({ label: 'cold-resume', body: resumed })
    capture.observations.resumedAssistantText = assistantText(resumed, turn.turn.id)
    assert.equal(capture.observations.resumedAssistantText, capture.observations.finalAssistantText)
    if (name === 'parent-child-read') {
      const savedChild = await client.request('thread/read', { threadId: capture.observations.childId, includeTurns: true })
      capture.reads.push({ label: 'child-cold-saved-history', body: savedChild })
      assert.equal(savedChild.thread.parentThreadId, capture.threadId)
      assert.equal(assistantText(savedChild), 'Exact child final answer.')
      capture.observations.childObserverMethods = capture.requests.filter(frame => frame.params.threadId === capture.observations.childId).map(frame => frame.method)
      assert(capture.observations.childObserverMethods.every(method => method === 'thread/read'), 'observer must not create/resume/send/stop/configure the child')
      const pending = await client.request('thread/start', { cwd: context.workspace, model: 'contract-model', modelProvider: 'contract-loopback', approvalPolicy: 'never', sandbox: 'read-only', ephemeral: false })
      capture.observations.unmaterializedRead = await nativeRefusal(client, 'thread/read', { threadId: pending.thread.id, includeTurns: true })
    }
    if (restricted) {
      const fork = await client.request('thread/fork', { threadId: capture.threadId, cwd: context.workspace, approvalPolicy: policy, sandbox: sandboxMode, ephemeral: false, persistExtendedHistory: true })
      capture.observations.fork = { threadId: fork.thread.id, approvalPolicy: fork.approvalPolicy, sandbox: fork.sandbox }
      assert.equal(fork.approvalPolicy, policy)
      assert(capture.observations.restrictedCommandExecuted, `restricted command did not execute: ${JSON.stringify(capture.observations.commandItems)}`)
      if (sandboxMode === 'workspace-write') assert(capture.observations.workspaceWritePresent, 'permitted workspace write must actually exist')
      if (options.probePolicyEffects) {
        // Native untrusted acceptance can authorize retry without sandboxing.
        // Only never-policy isolates filesystem/network enforcement; a real
        // user cancellation remains an absence-of-effect check for untrusted.
        if (policy === 'never') for (const [effect, value] of Object.entries(capture.observations.policyEffects)) assert.equal(value, effect === 'networkRequests' ? 0 : false, `restricted policy allowed forbidden effect: ${effect}`)
        if (policy === 'untrusted') assert.equal(capture.observations.policyEffects.userDeniedWrite, false, 'native-cancelled command must have no effect')
        if (policy === 'untrusted') assert(capture.observations.commandApprovals.some(approval => approval.decision === 'cancel'), 'denied command must receive an actual native cancellation')
      }
    }
    capture.passed = true
  } catch (error) {
    capture.passed = false
    capture.failure = { message: error.message, nativeError: error.nativeError }
    error.capture = capture
    throw error
  } finally {
    if (client) await client.close()
    releaseStream?.()
    childStream.resolve()
    parentStream.resolve()
    if (fixture) { capture.fixtureTraffic = fixture.traffic; await fixture.close() }
    if (context.mcpTrace && fs.existsSync(context.mcpTrace)) capture.observations.mcpTraffic = (await fsp.readFile(context.mcpTrace, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    capture.environment.ambientAfter = ambientCodex()
    assert.equal(capture.environment.ambientAfter, capture.environment.ambientBefore)
    await fsp.writeFile(path.join(context.receiptRoot, `${name}-${randomUUID()}.json`), `${JSON.stringify(capture, null, 2)}\n`, { mode: 0o600 })
    if (options.emitReceipt) process.stdout.write(`${JSON.stringify({ nativeCapture: true, capture })}\n`)
  }
  return capture
}

async function managedVersion(options) {
  const { register } = await import('tsx/esm/api')
  const unregister = register()
  const { RuntimeHarness } = await import('../../../scripts/testing/runtime-sandbox.ts')
  const harness = new RuntimeHarness(repoRoot, `codex-contract-${randomUUID()}`, 3)
  const receiptDir = path.resolve(options.receiptDir ?? path.join(repoRoot, '.runtime-build/codex-contract/managed'))
  await fsp.mkdir(receiptDir, { recursive: true, mode: 0o700 })
  await fsp.mkdir(harness.evidenceDir, { recursive: true, mode: 0o700 })
  try {
    // Existing exact run-owned image seam; no supervisor or broker needed for
    // this initial version gate, and no global tag is adopted or overwritten.
    if (options.probeSeccomp && options.probeUid === '1000:1000') {
      const prerequisite = await verifySandbox()
      harness.imageRef = prerequisite.manifest.image
    } else harness.ensureRuntimeImage()
    let output
    if (options.probeUid !== '1000:1000') {
      output = spawnSync('docker', ['run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', '65534:0', '--tmpfs', '/tmp:rw,nosuid,nodev,size=64m', harness.imageRef, '/usr/local/bin/codex', '--version'], { encoding: 'utf8', timeout: 30_000 })
      const receipt = { imageDigest: harness.imageRef, architecture: process.arch, uid: 65534, gid: 0, command: '/usr/local/bin/codex --version', status: output.status, stdout: output.stdout, stderr: output.stderr, requiredVersion: artifactMetadata.version }
      await fsp.writeFile(path.join(receiptDir, 'binary.json'), `${JSON.stringify(receipt, null, 2)}\n`)
      assert.equal(output.status, 0, output.stderr)
    }
    if (options.providerIdentityProbe) {
      const artifactRoot = options.probeArtifactRoot ?? path.join(repoRoot, '.runtime-build/codex-contract/artifact')
      await verifyArtifact(artifactRoot, options.probeMetadata ?? artifactMetadata)
      const name = `freshcodex-provider-probe-${randomUUID()}`
      const command = ['node', '/contract/test/integration/providers/codex-cli-contract.mjs', '--scenario', 'approval-policy-restricted-exec', '--receipt-dir', '/tmp/native-receipts', '--sandbox-mode', options.sandboxMode ?? 'read-only', '--emit-receipt']
      if (options.probeMetadataPath) command.push('--probe-metadata', `/contract/${path.relative(repoRoot, options.probeMetadataPath)}`)
      if (options.legacyLandlock) command.push('--legacy-landlock')
      if (options.probePolicyEffects) command.push('--probe-policy-effects')
      if (options.probeApprovalPolicy) command.push('--probe-approval-policy', options.probeApprovalPolicy)
      if (options.probeDefaultPolicy) command.push('--probe-default-policy')
      if (options.probePolicyEffects) command.push('--state-root', '/probe-state')
      if (options.probeNetworkEnabled) command.push('--probe-network-enabled', '--state-root', '/probe-state')
      if (options.probeSeccomp) command.push('--probe-seccomp-receipt', `/contract/${path.relative(repoRoot, path.join(path.dirname(options.probeSeccomp), 'receipt.json'))}`)
      if (options.preferBundledBwrap) command.push('--probe-bundled-bwrap')
      const identity = options.probeUid ?? '65534:0'
      assert(['1000:1000', '65534:0'].includes(identity), 'only the two declared native probe identities are allowed')
      const [uid, gid] = identity.split(':')
      const createArgs = ['create', '--name', name, '--label', `org.freshell.codex-contract=${name}`, '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', ...(options.probeSeccomp ? ['--security-opt', `seccomp=${options.probeSeccomp}`] : []), '--user', identity, '--pids-limit', '512', '--memory', '1g', '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m,mode=1777', '--tmpfs', `/probe-state:rw,nosuid,nodev,size=128m,mode=700,uid=${uid},gid=${gid}`, '--mount', `type=bind,source=${repoRoot},target=/contract,readonly`, '--mount', `type=bind,source=${artifactRoot},target=/opt/freshell-codex-contract,readonly`, '--env', 'FRESHELL_CODEX_CONTRACT_ROOT=/opt/freshell-codex-contract', '--entrypoint', '/usr/local/bin/node', harness.imageRef, ...command.slice(1)]
      const created = spawnSync('docker', createArgs, { encoding: 'utf8', timeout: 30_000 })
      assert.equal(created.status, 0, created.stderr)
      const id = created.stdout.trim()
      assert.match(id, /^[a-f0-9]{64}$/)
      try {
        const inspection = spawnSync('docker', ['inspect', id], { encoding: 'utf8', timeout: 15_000 })
        assert.equal(inspection.status, 0, inspection.stderr)
        const observed = JSON.parse(inspection.stdout)[0]
        assert.equal(observed.Config.Labels['org.freshell.codex-contract'], name)
        await fsp.writeFile(path.join(receiptDir, 'container.json'), JSON.stringify({ id, image: observed.Image, appArmorProfile: observed.AppArmorProfile, config: observed.Config, hostConfig: observed.HostConfig }, null, 2))
        const result = spawnSync('docker', ['start', '--attach', id], { encoding: 'utf8', timeout: 180_000, maxBuffer: 32 * 1024 * 1024 })
        await fsp.writeFile(path.join(receiptDir, 'execution.json'), JSON.stringify({ status: result.status, stderr: result.stderr, error: result.error?.message }, null, 2))
        const captured = result.stdout.split('\n').filter(Boolean).map(line => JSON.parse(line)).find(frame => frame.nativeCapture === true)?.capture
        assert(captured, 'provider-identity probe must preserve an actual native receipt')
        await fsp.writeFile(path.join(receiptDir, 'native.json'), JSON.stringify(captured, null, 2), { mode: 0o600 })
        assert.equal(result.status, 0, result.stderr)
      } finally {
        const removal = spawnSync('docker', ['rm', '--force', id], { encoding: 'utf8', timeout: 30_000 })
        assert.equal(removal.status, 0, removal.stderr)
      }
      return
    }
    assert.equal(output.stdout.trim(), `codex-cli ${artifactMetadata.version}`, 'managed runtime must execute the required Codex release')
    throw new Error('CODEX_CONTRACT_UNIMPLEMENTED: managed native scenarios have not run; a version receipt is insufficient')
  } finally { const cleanup = await harness.cleanup(); unregister(); assert.equal(cleanup.ok, true, JSON.stringify(cleanup.errors)) }
}

async function main(args) {
  let scenario = 'all'
  const options = {}
  let managed = false
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--scenario') scenario = args[++index]
    else if (args[index] === '--receipt-dir') options.receiptDir = path.resolve(args[++index])
    else if (args[index] === '--managed-runtime') managed = true
    else if (args[index] === '--sandbox-mode') options.sandboxMode = args[++index]
    else if (args[index] === '--provider-identity-probe') { managed = true; options.providerIdentityProbe = true }
    else if (args[index] === '--emit-receipt') options.emitReceipt = true
    else if (args[index] === '--probe-metadata') { options.probeMetadataPath = path.resolve(args[++index]); options.probeMetadata = JSON.parse(await fsp.readFile(options.probeMetadataPath, 'utf8')); assert.equal(options.probeMetadata.probeOnly, true) }
    else if (args[index] === '--probe-artifact-root') options.probeArtifactRoot = path.resolve(args[++index])
    else if (args[index] === '--legacy-landlock') options.legacyLandlock = true
    else if (args[index] === '--probe-policy-effects') options.probePolicyEffects = true
    else if (args[index] === '--probe-approval-policy') options.probeApprovalPolicy = args[++index]
    else if (args[index] === '--probe-default-policy') options.probeDefaultPolicy = true
    else if (args[index] === '--state-root') options.stateRoot = path.resolve(args[++index])
    else if (args[index] === '--probe-seccomp') options.probeSeccomp = path.resolve(args[++index])
    else if (args[index] === '--probe-seccomp-receipt') options.seccompProbeReceipt = path.resolve(args[++index])
    else if (args[index] === '--probe-uid') options.probeUid = args[++index]
    else if (args[index] === '--probe-bundled-bwrap') options.preferBundledBwrap = true
    else if (args[index] === '--history-mode') { options.historyMode = args[++index]; assert(['legacy', 'paginated'].includes(options.historyMode)) }
    else if (args[index] === '--duplicate-bodies') options.duplicateBodies = true
    else if (args[index] === '--ephemeral-parent') options.ephemeralParent = true
    else if (args[index] === '--probe-network-enabled') options.probeNetworkEnabled = true
    else throw new Error(`unknown argument ${args[index]}`)
  }
  if (options.probePolicyEffects || options.probeApprovalPolicy || options.probeDefaultPolicy || options.legacyLandlock) assert(options.probeMetadata || options.probeSeccomp || options.seccompProbeReceipt, 'probe options require an explicit candidate manifest or declared seccomp probe')
  if (managed) return managedVersion(options)
  for (const name of scenario === 'all' ? scenarios : [scenario]) {
    const capture = await captureNativeScenario(name, options)
    console.log(JSON.stringify({ severity: 'info', event: 'codex_native_scenario_passed', scenario: name, version: capture.binary.version, threadId: capture.threadId }))
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).catch(error => { console.error(JSON.stringify({ severity: 'error', event: 'codex_native_contract_failed', message: error.message })); process.exitCode = 1 })
