#!/usr/bin/env node
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import { spawn, spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { createHash, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { artifactMetadata, repoRoot, verifyArtifact, ambientCodex, verifySandbox, nativeSandboxPolicy, verifyPolicyClientProbe } from '../../../scripts/testing/prepare-codex-contract.mjs'
import { createCodexLocalProvider, MCP_FORM_CONTENT, MCP_LARGE_TEXT, CODEX_NETWORK_REQUIREMENTS } from './codex-local-provider.mjs'

const scenarios = ['text-history', 'active-input-stop', 'parent-child-read', 'plan-question-controls', 'mcp-form-url', 'model-effort-usage', 'approval-policy-restricted-exec']
export function nativeContractCases() {
  const cases = []
  for (const historyMode of ['legacy', 'paginated']) {
    cases.push(['text-history', { historyMode }], ['text-history', { historyMode, duplicateBodies: true }])
  }
  for (const name of scenarios.filter(name => name !== 'text-history')) cases.push([name, {}])
  for (const sandboxMode of ['read-only', 'workspace-write']) cases.push(['approval-policy-restricted-exec', { sandboxMode, probeApprovalPolicy: 'never', probePolicyEffects: true }])
  cases.push(['approval-policy-restricted-exec', { requirementsGuard: true }])
  for (const approvalControl of ['stdin', 'network']) cases.push(['approval-policy-restricted-exec', { approvalControl }])
  cases.push(['active-input-stop', { startupCancellation: true }], ['parent-child-read', { ephemeralParent: true }], ['parent-child-read', { childApproval: true }])
  for (const historyMode of ['legacy', 'paginated']) {
    cases.push(['mcp-form-url', { historyMode, largeOutput: true }])
    for (const persistenceMode of ['delayed', 'missing']) cases.push(['text-history', { historyMode, persistenceMode }])
  }
  return cases
}
const deadline = (promise, ms, label) => {
  let timer
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`CODEX_CONTRACT_TIMEOUT: ${label}`)), ms) })]).finally(() => clearTimeout(timer))
}
function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}
function sanitizedCapture(value, secrets, key = '') {
  if (typeof value === 'string') {
    if (/^(?:authorization|api_?key|access_?token|password|secret)$/i.test(key)) return '[redacted]'
    let result = value.replace(/data:image\/[a-zA-Z0-9.+-]+;base64,[a-zA-Z0-9+/=]+/g, '[uploaded image omitted]')
    for (const secret of secrets) if (secret) result = result.replaceAll(secret, '[redacted]')
    return result
  }
  if (Array.isArray(value)) return value.map(item => sanitizedCapture(item, secrets))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, sanitizedCapture(item, secrets, name)]))
  return value
}

function exportCloudCapture(capture, json) {
  const id = randomUUID()
  const partSize = 16_000
  const parts = Math.ceil(json.length / partSize)
  for (let part = 0; part < parts; part++) process.stdout.write(`${JSON.stringify({ severity: 'INFO', event: 'codex_native_capture_part', id, scenario: capture.scenario, part, parts, payload: json.slice(part * partSize, (part + 1) * partSize) })}\n`)
  process.stdout.write(`${JSON.stringify({ severity: 'INFO', event: 'codex_native_capture_complete', id, scenario: capture.scenario, parts, bytes: Buffer.byteLength(json), sha256: createHash('sha256').update(json).digest('hex'), passed: capture.passed, version: capture.binary.version, uid: capture.environment.uid, gid: capture.environment.gid, platform: capture.binary.platform, requestCount: capture.requests.length, fixtureRequestCount: capture.fixtureTraffic.length })}\n`)
}

async function roots(options) {
  const metadata = options.probeMetadata ?? artifactMetadata
  let staged
  if (fs.existsSync(path.join(repoRoot, '.runtime-build/codex-contract/staged.json'))) staged = JSON.parse(await fsp.readFile(path.join(repoRoot, '.runtime-build/codex-contract/staged.json'), 'utf8'))
  const managed = process.env.FRESHELL_CODEX_MANAGED_CONTRACT === '1' ? JSON.parse(await fsp.readFile(nativeSandboxPolicy().native.layoutFile, 'utf8')) : undefined
  const artifactRoot = managed?.platformPackageRoot ?? options.artifactRoot ?? process.env.FRESHELL_CODEX_CONTRACT_ROOT ?? (process.env.FRESHELL_SANDBOX_MODE === 'runtime-suite' ? staged?.artifactRoot : undefined)
  if (!artifactRoot) throw new Error('CODEX_CONTRACT_PREREQUISITE: explicit prepared artifact root is missing; no PATH fallback')
  const artifact = await verifyArtifact(artifactRoot, metadata, managed ? '/native-reference.json' : undefined)
  let policyClientProbe
  if (!options.probeMetadata && !options.seccompProbeReceipt) {
    const file = options.policyClientProbe ?? process.env.FRESHELL_CODEX_POLICY_CLIENT_PROBE ?? staged?.policyClientProbe?.path
    assert(file, 'CODEX_CONTRACT_PREREQUISITE: required real-client policy probe is missing')
    policyClientProbe = await verifyPolicyClientProbe(file, staged?.policyClientProbe?.path === file ? staged.policyClientProbe.sha256 : undefined)
  }
  const stateBase = options.stateRoot ?? (process.env.FRESHELL_SANDBOX_MODE === 'runtime-suite' ? staged?.stateRoot : undefined) ?? os.tmpdir()
  const stateRoot = await fsp.mkdtemp(path.join(stateBase, 'codex-contract-'))
  const receiptRoot = path.resolve(options.receiptDir ?? (process.env.FRESHELL_SANDBOX_MODE === 'runtime-suite' ? staged?.receiptRoot : undefined) ?? path.join(stateRoot, 'receipts'))
  await fsp.mkdir(receiptRoot, { recursive: true, mode: 0o700 })
  for (const directory of ['home', 'codex', 'xdg-config', 'xdg-cache', 'xdg-data', 'workspace', 'tmp']) await fsp.mkdir(path.join(stateRoot, directory), { mode: 0o700 })
  const systemConfig = ['/etc/codex/config.toml', '/etc/codex/requirements.toml'].map(file => ({ path: file, present: fs.existsSync(file) }))
  if (systemConfig.some(file => file.present && (file.path !== '/etc/codex/requirements.toml' || fs.readFileSync(file.path, 'utf8') !== CODEX_NETWORK_REQUIREMENTS))) throw new Error('CODEX_CONTRACT_PREREQUISITE: unexpected system Codex configuration in fixture environment')
  const environment = { PATH: process.env.PATH, HOME: path.join(stateRoot, 'home'), CODEX_HOME: await fsp.realpath(path.join(stateRoot, 'codex')), XDG_CONFIG_HOME: path.join(stateRoot, 'xdg-config'), XDG_CACHE_HOME: path.join(stateRoot, 'xdg-cache'), XDG_DATA_HOME: path.join(stateRoot, 'xdg-data'), TMPDIR: path.join(stateRoot, 'tmp'), LANG: 'C.UTF-8', RUST_LOG: 'warn' }
  if (!managed && (!options.probeMetadata || options.preferBundledBwrap)) {
    const bundled = artifact.files.filter(file => file.path.endsWith('/codex-resources/bwrap'))
    assert.equal(bundled.length, 1, 'fixture PATH selection needs the single verified bundled bubblewrap resource')
    environment.PATH = `${path.dirname(path.join(artifact.path, bundled[0].path))}:${environment.PATH}`
  }
  return { artifact, metadata, managed, stateRoot, receiptRoot, environment, workspace: path.join(stateRoot, 'workspace'), systemConfig, staged, policyClientProbe }
}

export class NativeClient {
  constructor(binary, context, capture, args = ['app-server']) {
    this.capture = capture
    this.pending = new Map()
    this.waiters = new Set()
    this.nextId = 1
    this.secretControls = new Map()
    this.child = spawn(binary, args, { cwd: context.workspace, env: context.environment, stdio: ['pipe', 'pipe', 'pipe'] })
    this.connectionId = (capture.connections ??= []).length
    capture.connections.push({ id: this.connectionId, pid: this.child.pid, binary, args })
    if (!capture.probeOnly || capture.environment.seccompProbe || capture.environment.nativeSandboxPolicy) {
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
      ;(capture.processExits ??= []).push({ connectionId: this.connectionId, pid: this.child.pid, code, signal })
      clearInterval(this.helperWatcher)
      for (const entry of this.pending.values()) entry.reject(new Error(`owned Codex exited: ${code}/${signal}`))
      resolve({ code, signal })
    }))
    this.closed = new Promise(resolve => this.child.once('close', (code, signal) => {
      ;(capture.processCloses ??= []).push({ connectionId: this.connectionId, pid: this.child.pid, code, signal })
      resolve({ code, signal })
    }))
    this.child.stderr.on('data', bytes => { capture.stderr = `${capture.stderr ?? ''}${bytes.toString()}`.slice(-64 * 1024) })
    createInterface({ input: this.child.stdout }).on('line', line => {
      let frame
      try { frame = JSON.parse(line) } catch { return }
      capture.frames.push({ index: capture.frames.length, connectionId: this.connectionId, direction: 'native', frame })
      if (frame.id !== undefined && !frame.method) {
        capture.responses.push(frame)
        const entry = this.pending.get(frame.id)
        if (entry?.delayDelivery) { entry.nativeReply = frame; entry.receivedIndex = capture.frames.length - 1 }
        else if (entry) { this.pending.delete(frame.id); if (frame.error) entry.reject(Object.assign(new Error(frame.error.message), { nativeError: frame.error })); else entry.resolve(frame.result) }
      } else if (frame.method && frame.id !== undefined) {
        capture.serverRequests.push(frame)
        if (frame.method === 'item/tool/requestUserInput') this.secretControls.set(frame.id, { questions: new Set((frame.params.questions ?? []).filter(question => question.isSecret).map(question => question.id)) })
        if (frame.method === 'mcpServer/elicitation/request') this.secretControls.set(frame.id, { fields: new Set(Object.entries(frame.params.requestedSchema?.properties ?? {}).filter(([, schema]) => schema.format === 'password' || schema.writeOnly === true).map(([name]) => name)) })
        this.onServerRequest?.(frame)
      }
      else capture.notifications.push(frame)
      for (const waiter of [...this.waiters]) if (waiter.predicate(frame)) { this.waiters.delete(waiter); waiter.resolve(frame) }
    })
  }
  send(frame) {
    const secret = this.secretControls.get(frame.id)
    for (const question of secret?.questions ?? []) for (const value of frame.result?.answers?.[question]?.answers ?? []) if (typeof value === 'string' && value) this.capture.secretValues.add(value)
    for (const field of secret?.fields ?? []) { const value = frame.result?.content?.[field]; if (typeof value === 'string' && value) this.capture.secretValues.add(value) }
    if (frame.id !== undefined && frame.result !== undefined) this.secretControls.delete(frame.id)
    this.capture.frames.push({ index: this.capture.frames.length, connectionId: this.connectionId, direction: 'client', frame })
    this.child.stdin.write(`${JSON.stringify(frame)}\n`)
  }
  request(method, params = {}, timeoutMs = 30_000, delayDelivery = false) {
    const id = this.nextId++
    const frame = { id, method, params }
    this.capture.requests.push(frame)
    return deadline(new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject, delayDelivery }); this.send(frame) }), timeoutMs, method)
  }
  releaseReply(id) {
    const entry = this.pending.get(id)
    assert(entry?.nativeReply, 'only an actually received native response can be delivered')
    this.pending.delete(id)
    ;(this.capture.observations.delayedControllerReplies ??= []).push({ connectionId: this.connectionId, requestId: id, nativeReceiptIndex: entry.receivedIndex, controllerReleaseIndex: this.capture.frames.length })
    if (entry.nativeReply.error) entry.reject(Object.assign(new Error(entry.nativeReply.error.message), { nativeError: entry.nativeReply.error }))
    else entry.resolve(entry.nativeReply.result)
  }
  wait(predicate, timeoutMs = 30_000, minimumIndex = 0) {
    const existing = this.capture.frames.find(entry => entry.connectionId === this.connectionId && entry.index >= minimumIndex && entry.direction === 'native' && predicate(entry.frame))
    if (existing) return Promise.resolve(existing.frame)
    let waiter
    return deadline(new Promise(resolve => { waiter = { predicate, resolve }; this.waiters.add(waiter) }), timeoutMs, 'native notification').finally(() => this.waiters.delete(waiter))
  }
  async close() {
    this.child.stdin.end()
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGTERM')
    try { await deadline(this.exit, 5000, 'owned process exit') } catch { this.child.kill('SIGKILL'); await deadline(this.exit, 5000, 'owned process kill') }
    // The bubblewrap launcher can exit before its PID namespace finishes
    // teardown. Its descendants inherit these pipes; join their closure too.
    await deadline(this.closed, 5000, `owned process stdio close pid=${this.child.pid} exit=${this.child.exitCode} signal=${this.child.signalCode}`)
  }
}

async function nativeRequirementsGuard(context, capture) {
  const { path: file } = context.policyClientProbe
  capture.observations.policyClientProbe = context.policyClientProbe
  const requirementFile = path.join(context.stateRoot, 'strict-requirements.toml')
  await fsp.writeFile(requirementFile, `allowed_approval_policies = ["never"]\n${CODEX_NETWORK_REQUIREMENTS}`, { mode: 0o600 })
  const reservation = http.createServer()
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve))
  const port = reservation.address().port
  await new Promise(resolve => reservation.close(resolve))
  const readiness = () => new Promise(resolve => {
    const request = http.get(`http://127.0.0.1:${port}/readyz`, response => { response.resume(); resolve(response.statusCode === 200) })
    request.on('error', () => resolve(false)); request.setTimeout(1000, () => request.destroy())
  })
  const helper = path.join(context.artifact.path, 'vendor/x86_64-unknown-linux-musl/codex-resources/bwrap')
  // This matches native's proc-preflight fallback: retain the fresh user/PID/
  // IPC namespaces and inherited recursive root procfs, omit only --proc.
  const args = ['--unshare-user', '--unshare-pid', '--unshare-ipc', '--die-with-parent', '--new-session',
    '--ro-bind', '/', '/', '--bind', context.stateRoot, context.stateRoot,
    '--ro-bind', requirementFile, '/etc/codex/requirements.toml', '--dev', '/dev',
    '--chdir', context.workspace, '--cap-drop', 'ALL', '--uid', String(process.getuid()), '--gid', String(process.getgid()),
    '--', capture.binary.path, 'app-server', '--listen', `ws://127.0.0.1:${port}`]
  const native = new NativeClient(helper, context, capture, args)
  try {
    await deadline((async () => {
      while (!await readiness()) {
        assert.equal(native.child.exitCode, null, capture.stderr)
        await new Promise(resolve => setTimeout(resolve, 50))
      }
    })(), 15_000, 'isolated native requirements listener')
    const receipt = path.join(context.stateRoot, 'policy-client-proof.json')
    const probe = spawn(file, ['--exact', 'app_server::tests::native_requirements_refuse_untrusted_before_work', '--nocapture'], {
      cwd: context.workspace, env: { ...context.environment, FRESHELL_CODEX_POLICY_PROBE_URL: `ws://127.0.0.1:${port}`, FRESHELL_CODEX_POLICY_PROBE_RECEIPT: receipt }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = '', stderr = ''
    probe.stdout.on('data', bytes => { stdout += bytes }); probe.stderr.on('data', bytes => { stderr += bytes })
    const exited = new Promise((resolve, reject) => { probe.once('exit', (code, signal) => resolve({ code, signal })); probe.once('error', reject) })
    let result
    try { result = await deadline(exited, 30_000, 'real production policy client') }
    finally { if (probe.exitCode === null && probe.signalCode === null) { probe.kill('SIGKILL'); await exited } }
    assert.equal(result.code, 0, `${stdout}\n${stderr}`)
    assert.match(stdout, /1 passed; 0 failed/)
    const proof = JSON.parse(await fsp.readFile(receipt, 'utf8'))
    assert.deepEqual(proof.refusedRoutes, ['create', 'resume', 'fork', 'send'])
    assert.equal(proof.workRequests, 0)
    for (const entry of proof.frames) {
      const direction = entry.direction === 'controller' ? 'client' : 'native'
      const frame = entry.frame
      capture.frames.push({ index: capture.frames.length, connectionId: native.connectionId, direction, frame })
      if (direction === 'client' && frame.method && frame.id !== undefined) capture.requests.push(frame)
      else if (direction === 'native' && frame.id !== undefined) capture.responses.push(frame)
      else if (direction === 'native' && frame.method) capture.notifications.push(frame)
    }
    capture.observations.requirementsGuard = { ...proof, frames: undefined, result, stdout, stderr, requirementsSha256: createHash('sha256').update(await fsp.readFile(requirementFile)).digest('hex') }
    assert(capture.requests.every(frame => ['initialize', 'configRequirements/read'].includes(frame.method)))
    assert.equal(capture.requests.filter(frame => frame.method === 'configRequirements/read').length, 4)
  } finally { await native.close() }
  assert.equal(await readiness(), false, 'owned PID namespace and native listener must settle after launcher exit')
  capture.observations.requirementsGuard.ownedListenerSettled = true
}

async function nativeCatalogProbe(context,capture,fixture) {
  const trafficStart=fixture.traffic.length
  const reservation=http.createServer()
  await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve))
  const port=reservation.address().port
  await new Promise(resolve=>reservation.close(resolve))
  const native=new NativeClient(capture.binary.path,context,capture,['app-server','--listen',`ws://127.0.0.1:${port}`])
  const ready=()=>new Promise(resolve=>{
    const request=http.get(`http://127.0.0.1:${port}/readyz`,response=>{response.resume();resolve(response.statusCode===200)})
    request.on('error',()=>resolve(false));request.setTimeout(1000,()=>request.destroy())
  })
  try {
    await deadline((async()=>{
      while (!await ready()) {
        assert.equal(native.child.exitCode,null,capture.stderr)
        await new Promise(resolve=>setTimeout(resolve,50))
      }
    })(),15_000,'owned model-catalog native listener')
    const receipt=path.join(context.stateRoot,'catalog-client-proof.json')
    const probe=spawn(context.policyClientProbe.path,['--exact','catalog::native_tests::native_catalog_and_opaque_effort_use_initialized_client','--nocapture'],{
      cwd:context.workspace,env:{...context.environment,FRESHELL_CODEX_CATALOG_PROBE_URL:`ws://127.0.0.1:${port}`,FRESHELL_CODEX_CATALOG_PROBE_RECEIPT:receipt},stdio:['ignore','pipe','pipe'],
    })
    let stdout='',stderr=''
    probe.stdout.on('data',bytes=>{stdout+=bytes});probe.stderr.on('data',bytes=>{stderr+=bytes})
    const exited=new Promise((resolve,reject)=>{probe.once('exit',(code,signal)=>resolve({code,signal}));probe.once('error',reject)})
    let result
    try { result=await deadline(exited,120_000,'real production catalog client') }
    finally { if (probe.exitCode===null && probe.signalCode===null) {probe.kill('SIGKILL');await exited} }
    assert.equal(result.code,0,`${stdout}\n${stderr}`)
    assert.match(stdout,/1 passed; 0 failed/)
    const proof=JSON.parse(await fsp.readFile(receipt,'utf8'))
    assert(proof.models.length>0)
    assert.equal(proof.nativeAcceptedFutureEffort,true)
    assert(proof.futureEffortCompletedTurn)
    assert.equal(proof.nativeExactLifecycleAccepted,true)
    assert.equal(proof.completedTurns.length,4)
    const traffic=fixture.traffic.slice(trafficStart)
    assert.equal(traffic.length,7,'four lifecycle turns, one future-effort turn and two advertised-setting turns must each reach the controlled provider once')
    assert(traffic.slice(0,5).every(request=>request.body.model==='provider-current'),'custom native model work must use the exact model omitted from the catalog')
    // Record both boundaries: native receives exact public effort strings,
    // and its downstream HTTP reasoning can depend on the selected model.
    const nativeTurns=proof.frames.filter(entry=>entry.direction==='controller' && entry.frame.method==='turn/start')
    assert.equal(nativeTurns.length,7)
    assert(nativeTurns.slice(0,4).every(entry=>entry.frame.params.effort==='ultra'))
    assert.equal(nativeTurns[4].frame.params.effort,'future-unadvertised-native-effort')
    assert.equal(traffic[4].body.reasoning.effort,'future-unadvertised-native-effort')
    const advertised=proof.advertisedSelection
    assert(proof.models.some(model=>model.id===advertised.model.id))
    assert.equal(advertised.turns.length,2)
    const matchedAdvertisedSettings=advertised.turns.map((turn,index)=>{
      const nativeRequest=nativeTurns[index+5].frame.params
      const http=traffic[index+5].body
      assert(advertised.model.supportedEffortLevels.includes(turn.effort))
      assert.equal(nativeRequest.model,advertised.model.id)
      assert.equal(nativeRequest.effort,turn.effort)
      assert.equal(nativeRequest.approvalPolicy,'never')
      assert.equal(http.model,advertised.model.id)
      assert(turn.turnId)
      return {...turn,nativeRequest,http}
    })
    const methods=proof.frames.filter(entry=>entry.direction==='controller' && entry.frame.id!==undefined).map(entry=>entry.frame.method)
    assert.equal(methods.filter(method=>method==='initialize').length,1)
    const firstWork=methods.indexOf('thread/start')
    assert(firstWork>0 && methods.slice(0,firstWork).every(method=>['initialize','model/list'].includes(method)))
    capture.observations.productionCatalogClient={...proof,result,stdout,stderr,fixtureRequestCount:traffic.length,nativeHttpEfforts:traffic.map(request=>request.body.reasoning.effort),matchedAdvertisedSettings}
  } finally {await native.close()}
  assert.equal(await ready(),false,'owned native catalog listener must close')
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

function largeOutputResponse(record, flow, context) {
  const current = flow.current
  const step = current.step++
  if (step === 0) return advertisedCall(record, 'exec_command', { cmd: `python3 '${context.largeCommand}'`, shell: '/bin/sh', login: false, max_output_tokens: 100000, yield_time_ms: 1000 }, 'large_command')
  if (!current.commandDone) {
    const output = toolOutput(record, current.polls ? `call_large_poll_${current.polls}` : 'call_large_command')
    const running = output.match(/Process running with session ID (\d+)/)
    if (running) {
      current.polls = (current.polls ?? 0) + 1
      return advertisedCall(record, 'write_stdin', { session_id: Number(running[1]), chars: '', max_output_tokens: 100000, yield_time_ms: 1000 }, `large_poll_${current.polls}`)
    }
    assert.match(output, /Process exited with code 0/)
    current.commandDone = true
    return advertisedCall(record, 'large_result', {}, 'large_mcp')
  }
  assert.match(toolOutput(record, 'call_large_mcp'), /F1_MCP_STRUCTURED/)
  return { text: 'First fragment and final fragment' }
}

function largeSavedItems(read, turnId) {
  return read.thread.turns.filter(turn => turn.id === turnId).flatMap(turn => turn.items)
}
async function verifyLargeOutput(capture, read, context, turnId, label, historyMode) {
  const live = capture.notifications.filter(frame => frame.method === 'item/completed' && frame.params?.turnId === turnId).map(frame => frame.params.item)
  const command = live.find(item => item.type === 'commandExecution' && item.id === 'call_large_command')
  assert.equal(command?.exitCode, 0)
  assert.equal(Buffer.byteLength(command.aggregatedOutput), 128 * 1024)
  assert(command.aggregatedOutput.startsWith('F1_COMMAND_HEAD\n'))
  assert(command.aggregatedOutput.endsWith('\nF1_COMMAND_TAIL\n'))
  const mcp = live.find(item => item.type === 'mcpToolCall')
  assert.equal(mcp?.status, 'completed')
  assert.equal(mcp.result.content[0].text, MCP_LARGE_TEXT)
  assert.equal(mcp.result.structuredContent.fixture, 'F1_MCP_STRUCTURED')
  assert.equal(mcp.result._meta['fixture/result'], 'F1_MCP_META')
  const items = largeSavedItems(read, turnId)
  const savedCommand = items.find(item => item.type === 'commandExecution')
  const savedMcp = items.find(item => item.type === 'mcpToolCall')
  assert(savedMcp, 'native history must preserve its actual ordinary MCP result')
  const order = items.map(item => ({ id: item.id, type: item.type }))
  assert.equal(order[0].type, 'userMessage')
  if (savedCommand) assert(order.findIndex(item => item.type === 'commandExecution') < order.findIndex(item => item.type === 'mcpToolCall'))
  assert(order.findIndex(item => item.type === 'mcpToolCall') < order.findIndex(item => item.type === 'agentMessage'))
  if (historyMode === 'paginated') {
    assert(savedCommand, 'paginated canonical command history must be present')
    assert.equal(savedCommand.id, command.id)
    assert(Buffer.byteLength(savedCommand.aggregatedOutput) <= 65536)
    assert(savedCommand.aggregatedOutput.includes('\n... command output truncated for persistence ...\n'))
    assert(savedCommand.aggregatedOutput.startsWith('F1_COMMAND_HEAD\n'))
    assert(savedCommand.aggregatedOutput.endsWith('\nF1_COMMAND_TAIL\n'))
    assert.match(savedMcp.result.content[0].text, /…\d+ chars truncated…/u)
    assert.equal(savedMcp.result.structuredContent, null)
    assert.equal(savedMcp.result._meta, null)
    assert.notDeepEqual(savedMcp.result, mcp.result)
    const rollout = read.thread.path
    assert(rollout.startsWith(context.environment.CODEX_HOME + '/sessions/'), 'read only the actual owned native rollout')
    const records = (await fsp.readFile(rollout, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    const core = records.filter(record => record.type === 'event_msg' && record.payload?.type === 'item_completed').map(record => record.payload.item)
    const coreCommand = core.find(item => item.id === command.id && item.type === 'CommandExecution')
    const coreMcp = core.find(item => item.id === mcp.id && item.type === 'McpToolCall')
    assert(coreCommand && coreMcp, 'actual paginated canonical tool records are required')
    assert(Buffer.byteLength(coreCommand.aggregated_output) <= 65536)
    assert(Buffer.byteLength(JSON.stringify(coreMcp.result)) <= 65536)
    assert.equal(coreMcp.result.isError, false)
    assert(!('structuredContent' in coreMcp.result))
    assert(!('_meta' in coreMcp.result))
    capture.observations.canonicalSavedTools = { command: coreCommand, mcp: coreMcp }
  } else {
    assert.deepEqual(savedMcp.result, mcp.result, 'Legacy ordinary MCP result retains its actual full native form')
    const rollout = read.thread.path
    assert(rollout.startsWith(context.environment.CODEX_HOME + '/sessions/'))
    const records = (await fsp.readFile(rollout, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    capture.observations.legacySavedToolRecords = records.filter(record => record.type === 'event_msg' && /exec|mcp/i.test(record.payload?.type ?? ''))
    capture.observations.legacyCommandHistoryAvailability = savedCommand ? 'present' : 'native-history-item-unavailable-with-live-output-retained'
  }
  ;(capture.observations.largeOutputReads ??= []).push({ label, historyMode, order, retained: { command, mcp }, saved: { command: savedCommand, mcp: savedMcp }, state: historyMode === 'paginated' ? 'saved-provider-truncated-with-richer-retained-output' : 'actual-legacy-saved-representation' })
}

async function driveMcp(client, capture, flow, context) {
  capture.observations.elicitationCases = []
  capture.observations.urlOpenCases = []
  let last
  for (const route of ['form', 'openai/form', 'openaiForm', 'url']) {
    const current = { id: route.replaceAll('/', '_'), route, step: 0 }
    flow.current = current
    last = await client.request('turn/start', { threadId: capture.threadId, input: [{ type: 'text', text: `Run the controlled ${route} MCP matrix.` }] })
    for (const action of ['accept', 'decline', 'cancel']) {
      const already = new Set(capture.observations.elicitationCases.filter(record => record.turnId === last.turn.id).map(record => record.requestId))
      const request = await client.wait(frame => frame.method === 'mcpServer/elicitation/request' && frame.params?.turnId === last.turn.id && !already.has(frame.id))
      assert.equal(request.params.mode, route)
      if (route === 'url') {
        const opened = await fetch(request.params.url)
        assert.equal(opened.status, 200, 'the owned URL must actually open before a separate native decision')
        await opened.text()
        const pending = await client.request('thread/read', { threadId: capture.threadId, includeTurns: true })
        capture.reads.push({ label: `url-opened-awaiting-${action}`, body: pending })
        const turn = pending.thread.turns.find(turn => turn.id === last.turn.id)
        assert.equal(turn.status, 'inProgress', 'opening the URL must not complete the native pending control')
        assert(!capture.notifications.some(frame => frame.method === 'serverRequest/resolved' && frame.params?.requestId === request.id && frame.params.threadId === capture.threadId))
        capture.observations.urlOpenCases.push({ requestId: request.id, elicitationId: request.params.elicitationId, turnId: last.turn.id, openedStatus: opened.status, pendingTurnStatus: turn.status, explicitActionStillRequired: action })
      }
      const result = { action, ...(action === 'accept' && route !== 'url' ? { content: MCP_FORM_CONTENT, _meta: { 'fixture/response': 'accepted' } } : {}) }
      client.send({ id: request.id, result })
      capture.observations.elicitationCases.push({ route, action, requestId: request.id, turnId: last.turn.id, elicitationId: request.params.elicitationId ?? null })
    }
    const terminal = await client.wait(frame => frame.method === 'turn/completed' && frame.params?.turn?.id === last.turn.id)
    assert.equal(terminal.params.turn.status, 'completed')
    capture.reads.push({ label: `mcp-${route}`, body: await client.request('thread/read', { threadId: capture.threadId, includeTurns: true }) })
  }
  flow.current = { id: 'held', route: 'form', hold: true, step: 0 }
  const held = await client.request('turn/start', { threadId: capture.threadId, input: [{ type: 'text', text: 'Leave the owned MCP form pending for a controlled Stop.' }] })
  const pending = await client.wait(frame => frame.method === 'mcpServer/elicitation/request' && frame.params?.turnId === held.turn.id)
  await client.request('turn/interrupt', { threadId: capture.threadId, turnId: held.turn.id })
  const cancelled = await client.wait(frame => frame.method === 'turn/completed' && frame.params?.turn?.id === held.turn.id)
  assert.equal(cancelled.params.turn.status, 'interrupted')
  const resolved = await client.wait(frame => frame.method === 'serverRequest/resolved' && frame.params?.requestId === pending.id && frame.params.threadId === capture.threadId)
  capture.observations.cancelledMcpControl = { requestId: pending.id, turnId: held.turn.id, resolved: resolved.params }
  const trace = (await fsp.readFile(context.mcpTrace, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  capture.observations.mcpTraffic = trace
  assert.equal(trace.filter(record => record.event === 'elicitation_result' && record.sequence === 'matrix').length, 12)
  assert(!trace.some(record => record.event === 'fixture_error'), 'ordinary MCP route must return actual native responses without fixture errors')
  const initialized = trace.find(record => record.direction === 'native' && record.frame?.method === 'initialize')
  assert(initialized, 'configured MCP server must actually initialize')
  capture.observations.mcpInitialize = initialized.frame.params
  assert.equal(capture.observations.elicitationCases.length, 12)
  return last
}

function toolOutput(record, callId) {
  const output = record.body.input.findLast(item => item.type === 'function_call_output' && item.call_id === callId)?.output
  assert(output !== undefined, `actual native tool result missing for ${callId}`)
  return typeof output === 'string' ? output : output.filter(item => item.type === 'input_text').map(item => item.text).join('\n')
}

function stdinResponse(record, flow, capture, context) {
  const current = flow.current
  assert(current, 'stdin model exchange must belong to an actual selected turn')
  const step = current.step++
  if (current.kind === 'stdin-open') {
    if (step === 0) return advertisedCall(record, 'request_permissions', { reason: 'Allow writes only to the fixture terminal result directory.', permissions: { file_system: { write: [path.join(context.workspace, 'allowed')] } } }, `permissions_${current.id}`)
    if (step === 1) {
      toolOutput(record, `call_permissions_${current.id}`)
      return advertisedCall(record, 'exec_command', { cmd: '/bin/bash --noprofile --norc', shell: '/bin/sh', login: false, tty: true, yield_time_ms: 250 }, `open_${current.id}`)
    }
    const output = toolOutput(record, `call_open_${current.id}`)
    const match = output.match(/Process running with session ID (\d+)/)
    assert(match, 'PTY session handle must come from actual native execution')
    flow.sessionId = Number(match[1])
    return { text: 'First fragment and final fragment' }
  }
  if (current.kind === 'stdin-cancel') return advertisedCall(record, 'write_stdin', { session_id: flow.sessionId, chars: 'printf cancelled > allowed/cancelled-marker\n', yield_time_ms: 1000 }, 'stdin_cancel')
  if (step === 0) return advertisedCall(record, 'write_stdin', { session_id: flow.sessionId, chars: '', yield_time_ms: 1000 }, 'stdin_empty')
  if (step === 1) {
    toolOutput(record, 'call_stdin_empty')
    current.emptyPollReturned = true
    return advertisedCall(record, 'write_stdin', { session_id: flow.sessionId, chars: 'REJECTED=1; printf denied > allowed/denied-marker\n', yield_time_ms: 1000 }, 'stdin_denied')
  }
  if (step === 2) {
    capture.observations.deniedStdinResult = toolOutput(record, 'call_stdin_denied')
    return advertisedCall(record, 'write_stdin', { session_id: flow.sessionId, chars: "if test -v REJECTED || test -e allowed/denied-marker; then exit 19; fi; printf accepted > allowed/accepted-marker; printf 'STDIN_ACCEPTED\\n'; exit\n", yield_time_ms: 1000 }, 'stdin_accepted')
  }
  const output = toolOutput(record, 'call_stdin_accepted')
  assert.match(output, /Process exited with code 0/)
  capture.observations.acceptedStdinResult = output
  return { text: 'First fragment and final fragment' }
}

async function driveStdin(client, capture, flow, context) {
  capture.observations.stdinCases = []
  const open = async id => {
    flow.current = { id, kind: 'stdin-open', step: 0 }
    const turn = await client.request('turn/start', { threadId: capture.threadId, approvalPolicy: 'on-request', input: [{ type: 'text', text: 'Grant the narrow owned directory and open a real sandboxed PTY.' }] })
    const permission = await client.wait(frame => frame.method === 'item/permissions/requestApproval' && frame.params?.turnId === turn.turn.id)
    const requested = permission.params.permissions
    assert(JSON.stringify(requested).includes(path.join(context.workspace, 'allowed')))
    client.send({ id: permission.id, result: { permissions: requested, scope: 'turn', strictAutoReview: false } })
    await client.wait(frame => frame.method === 'turn/completed' && frame.params?.turn?.id === turn.turn.id)
    assert(Number.isSafeInteger(flow.sessionId))
    const item = capture.notifications.find(frame => frame.method === 'item/started' && frame.params?.turnId === turn.turn.id && frame.params.item?.type === 'commandExecution')?.params.item
    assert(item, 'actual PTY command item identity is required')
    capture.observations.stdinCases.push({ kind: 'open', turnId: turn.turn.id, sessionId: flow.sessionId, itemId: item.id, permissionRequestId: permission.id })
    return { turn, item }
  }
  const first = await open('first')
  flow.current = { id: 'write', kind: 'stdin-write', step: 0 }
  const write = await client.request('turn/start', { threadId: capture.threadId, approvalPolicy: 'on-request', input: [{ type: 'text', text: 'Poll the terminal, deny one input, then approve a separate input.' }] })
  const denied = await client.wait(frame => frame.method === 'item/commandExecution/requestApproval' && frame.params?.kind === 'writeStdin' && frame.params.turnId === write.turn.id)
  assert.equal(flow.current.emptyPollReturned, true, 'empty polling must finish without stdin review')
  assert.equal(denied.params.itemId, first.item.id)
  assert(!fs.existsSync(path.join(context.workspace, 'allowed/denied-marker')))
  client.send({ id: denied.id, result: { decision: 'decline' } })
  const accepted = await client.wait(frame => frame.method === 'item/commandExecution/requestApproval' && frame.params?.kind === 'writeStdin' && frame.params.turnId === write.turn.id && frame.id !== denied.id)
  assert.equal(accepted.params.itemId, first.item.id)
  assert.notEqual(accepted.params.approvalId, denied.params.approvalId)
  assert(!fs.existsSync(path.join(context.workspace, 'allowed/accepted-marker')))
  assert(!fs.existsSync(path.join(context.workspace, 'allowed/denied-marker')))
  client.send({ id: accepted.id, result: { decision: 'accept' } })
  const terminal = await client.wait(frame => frame.method === 'turn/completed' && frame.params?.turn?.id === write.turn.id)
  assert.equal(terminal.params.turn.status, 'completed')
  assert.equal(await fsp.readFile(path.join(context.workspace, 'allowed/accepted-marker'), 'utf8'), 'accepted')
  assert(!fs.existsSync(path.join(context.workspace, 'allowed/denied-marker')))
  capture.observations.stdinCases.push({ kind: 'write', turnId: write.turn.id, itemId: first.item.id, deniedRequestId: denied.id, acceptedRequestId: accepted.id, deniedApprovalId: denied.params.approvalId, acceptedApprovalId: accepted.params.approvalId, acceptedFile: 'accepted', deniedFilePresent: false })
  const second = await open('cancel')
  flow.current = { id: 'cancel', kind: 'stdin-cancel', step: 0 }
  const cancelling = await client.request('turn/start', { threadId: capture.threadId, approvalPolicy: 'on-request', input: [{ type: 'text', text: 'Cancel the separate pending stdin write without changing the owned terminal.' }] })
  const pending = await client.wait(frame => frame.method === 'item/commandExecution/requestApproval' && frame.params?.kind === 'writeStdin' && frame.params.turnId === cancelling.turn.id)
  client.send({ id: pending.id, result: { decision: 'cancel' } })
  const cancelled = await client.wait(frame => frame.method === 'turn/completed' && frame.params?.turn?.id === cancelling.turn.id)
  assert.equal(cancelled.params.turn.status, 'interrupted')
  assert(!fs.existsSync(path.join(context.workspace, 'allowed/cancelled-marker')))
  capture.observations.stdinCases.push({ kind: 'cancel', turnId: cancelling.turn.id, requestId: pending.id, sessionId: flow.sessionId, filePresent: false, terminalExitInferred: false })
  return second.turn
}

async function driveNativeRaces(client, capture, flow) {
  const cases = capture.observations.stopRaceCases = []
  const terminalFor = id => client.wait(frame => frame.method === 'turn/completed' && frame.params?.turn?.id === id)
  const input = text => ({ threadId: capture.threadId, input: [{ type: 'text', text }] })
  const outcome = promise => promise.then(result => ({ result }), error => { assert(error.nativeError); return { nativeError: error.nativeError } })
  const hold = () => { const release = deferred(); flow.current = { kind: 'race', release }; return release }
  const frameIndex = (id, direction) => capture.frames.find(entry => entry.connectionId === client.connectionId && entry.direction === direction && entry.frame.id === id && !entry.frame.method)?.index
  let release = hold()
  const pendingRequest = client.nextId
  const start = client.request('turn/start', input('Pending-start Stop native race.'))
  const startupStopId = client.nextId
  const emptyStop = outcome(client.request('turn/interrupt', { threadId: capture.threadId, turnId: '' }))
  const accepted = await start
  const startupStop = await emptyStop
  // Empty-ID success is submission only. Bind the actual admitted ID and
  // obtain its own terminal; a second explicit cancellation is attributed.
  const knownTerminal = capture.notifications.find(frame => frame.method === 'turn/completed' && frame.params?.turn?.id === accepted.turn.id)
  const followupStop = knownTerminal ? null : await outcome(client.request('turn/interrupt', { threadId: capture.threadId, turnId: accepted.turn.id }))
  const pendingTerminal = knownTerminal ?? await terminalFor(accepted.turn.id)
  release.resolve()
  cases.push({ kind: 'start-outstanding-at-stop-issuance', startRequestId: pendingRequest, emptyStopRequestId: startupStopId, startReplyIndex: frameIndex(pendingRequest, 'native'), stopReplyIndex: frameIndex(startupStopId, 'native'), turnId: accepted.turn.id, startupStop, followupStop, terminal: pendingTerminal.params.turn })
  let previous = accepted.turn.id
  for (const ordering of ['release-then-stop', 'stop-then-release']) {
    release = hold()
    const turn = await client.request('turn/start', input(`Natural completion/Stop race: ${ordering}.`))
    await client.wait(frame => frame.method === 'item/agentMessage/delta' && frame.params?.turnId === turn.turn.id)
    let stopping
    if (ordering === 'release-then-stop') { release.resolve(); stopping = outcome(client.request('turn/interrupt', { threadId: capture.threadId, turnId: turn.turn.id })) }
    else { stopping = outcome(client.request('turn/interrupt', { threadId: capture.threadId, turnId: turn.turn.id })); release.resolve() }
    const stop = await stopping
    const terminal = await terminalFor(turn.turn.id)
    assert(['completed', 'interrupted'].includes(terminal.params.turn.status))
    cases.push({ kind: 'native-natural-completion-race', ordering, turnId: turn.turn.id, stop, terminal: terminal.params.turn })
    previous = turn.turn.id
  }
  release = hold()
  const current = await client.request('turn/start', input('A stale Stop must not affect this distinct active native turn.'))
  await client.wait(frame => frame.method === 'item/agentMessage/delta' && frame.params?.turnId === current.turn.id)
  assert.notEqual(current.turn.id, previous)
  const stale = await nativeRefusal(client, 'turn/interrupt', { threadId: capture.threadId, turnId: previous })
  const steer = await client.request('turn/steer', { threadId: capture.threadId, expectedTurnId: current.turn.id, input: [{ type: 'text', text: 'Keep the actual new native turn active.' }] })
  assert.equal(steer.turnId, current.turn.id)
  await client.request('turn/interrupt', { threadId: capture.threadId, turnId: current.turn.id })
  const currentTerminal = await terminalFor(current.turn.id)
  release.resolve()
  cases.push({ kind: 'stale-stop-after-turnover', staleTurnId: previous, currentTurnId: current.turn.id, nativeRefusal: stale, steer, terminal: currentTerminal.params.turn })
  release = hold()
  const since = capture.frames.length
  const delayedStartId = client.nextId
  const delayedStart = client.request('turn/start', input('Real native output before delayed controller acceptance delivery.'), 30_000, true)
  const started = await client.wait(frame => frame.method === 'turn/started', 30_000, since)
  const delta = await client.wait(frame => frame.method === 'item/agentMessage/delta' && frame.params?.turnId === started.params.turn.id, 30_000, since)
  assert(delta.params.delta.length > 0)
  client.releaseReply(delayedStartId)
  const delayedAccepted = await delayedStart
  assert.equal(delayedAccepted.turn.id, started.params.turn.id)
  const stopId = client.nextId
  const ambiguous = client.request('turn/interrupt', { threadId: capture.threadId, turnId: delayedAccepted.turn.id }, 50, true).then(() => assert.fail('controller response is deliberately withheld'), error => ({ message: error.message }))
  const terminal = await terminalFor(delayedAccepted.turn.id)
  const timeout = await ambiguous
  assert.match(timeout.message, /TIMEOUT/)
  assert.equal(capture.requests.at(-1).method, 'turn/interrupt', 'a local deadline must not replay or issue successor input')
  client.releaseReply(stopId)
  release.resolve()
  cases.push({ kind: 'controller-delivery-loss-with-progressing-native-consumer', turnId: delayedAccepted.turn.id, startRequestId: delayedStartId, stopRequestId: stopId, timeout, terminal: terminal.params.turn, promptReplayCount: 0, nativeReceiptOrderPreserved: true })
  flow.current = null
  const final = await client.request('turn/start', input('New work only after exact native terminal resolution.'))
  const completed = await terminalFor(final.turn.id)
  assert.equal(completed.params.turn.status, 'completed')
  const lateStop = await nativeRefusal(client, 'turn/interrupt', { threadId: capture.threadId, turnId: final.turn.id })
  cases.push({ kind: 'completed-then-late-stop', turnId: final.turn.id, nativeRefusal: lateStop, terminal: completed.params.turn })
  capture.observations.nativeStartResponseOrder = capture.requests.filter(frame => frame.method === 'turn/start').map(request => {
    const reply = capture.frames.find(entry => entry.connectionId === client.connectionId && entry.direction === 'native' && entry.frame.id === request.id && entry.frame.result?.turn)
    const turnId = reply?.frame.result.turn.id
    const firstEvent = capture.frames.find(entry => entry.connectionId === client.connectionId && entry.direction === 'native' && entry.frame.method && (entry.frame.params?.turnId === turnId || entry.frame.params?.turn?.id === turnId))
    return { requestId: request.id, turnId, rawReplyIndex: reply?.index, firstNativeEventIndex: firstEvent?.index, nativeEventBeforeReply: firstEvent?.index < reply?.index }
  })
  return final
}

async function networkFixture(context) {
  const hits = []
  const listeners = []
  for (let index = 0; index < 3; index++) {
    const server = http.createServer((request, response) => {
      hits.push({ listener: index, path: request.url, peer: request.socket.remoteAddress })
      response.end('NATIVE_NETWORK_ALLOWED')
    })
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    listeners.push(server)
  }
  const reservation = http.createServer()
  await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve) })
  const proxyPort = reservation.address().port
  await new Promise(resolve => reservation.close(resolve))
  const helper = path.join(context.workspace, 'network-canary.py')
  await fsp.writeFile(helper, `import os, socket, sys, urllib.parse
proxy = urllib.parse.urlparse(os.environ['HTTP_PROXY'])
target = sys.argv[1]
s = socket.create_connection((proxy.hostname, proxy.port), timeout=20)
s.settimeout(20)
s.sendall(('GET ' + target + ' HTTP/1.1\\r\\nHost: ' + urllib.parse.urlparse(target).netloc + '\\r\\nConnection: close\\r\\n\\r\\n').encode())
chunks = []
while True:
    data = s.recv(65536)
    if not data: break
    chunks.append(data)
body = b''.join(chunks)
print(body.decode(errors='replace'))
sys.exit(0 if b'NATIVE_NETWORK_ALLOWED' in body else 23)
`)
  return { hits, helper, proxyPort, urls: listeners.map(server => `http://127.0.0.1:${server.address().port}/canary/${randomUUID()}`), close: () => Promise.all(listeners.map(server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))) }
}

function networkResponse(record, flow, capture, context) {
  const current = flow.current
  assert(current, 'network command must belong to the actual selected turn')
  const step = current.step++
  if (step === 0) return advertisedCall(record, 'exec_command', { cmd: `python3 '${context.network.helper}' '${current.url}'`, shell: '/bin/sh', login: false, yield_time_ms: 1000, max_output_tokens: 2000 }, `network_${current.id}`)
  const callId = current.polls ? `call_network_poll_${current.id}_${current.polls}` : `call_network_${current.id}`
  const output = toolOutput(record, callId)
  const running = output.match(/Process running with session ID (\d+)/)
  if (running) {
    current.polls = (current.polls ?? 0) + 1
    return advertisedCall(record, 'write_stdin', { session_id: Number(running[1]), chars: '', yield_time_ms: 1000, max_output_tokens: 2000 }, `network_poll_${current.id}_${current.polls}`)
  }
  current.output = output
  if (['once', 'session', 'cached'].includes(current.id)) { assert.match(output, /Process exited with code 0/); assert.match(output, /NATIVE_NETWORK_ALLOWED/) }
  return { text: 'First fragment and final fragment' }
}

async function driveNetwork(client, capture, flow, context) {
  capture.observations.networkCases = []
  let last
  for (const [index, id, decision] of [[0, 'once', 'accept'], [0, 'session', 'acceptForSession'], [0, 'cached', null], [1, 'declined', 'decline'], [2, 'cancelled', 'cancel']]) {
    const beforeHits = context.network.hits.length
    const target = new URL(context.network.urls[index])
    target.pathname = `/canary/${id}/${randomUUID()}`
    const current = { id, step: 0, url: target.href }
    flow.current = current
    const turn = await client.request('turn/start', { threadId: capture.threadId, approvalPolicy: 'on-request', permissions: 'fixture_network', input: [{ type: 'text', text: `Run the controlled ${id} native network decision.` }] })
    let approval
    if (decision) {
      approval = await client.wait(frame => frame.method === 'item/commandExecution/requestApproval' && frame.params?.turnId === turn.turn.id && frame.params.networkApprovalContext)
      assert.equal(approval.params.kind, 'command')
      assert.equal(approval.params.networkApprovalContext.host, '127.0.0.1')
      assert.equal(approval.params.networkApprovalContext.protocol, 'http')
      assert.equal(context.network.hits.length, beforeHits, 'network traffic must wait for the actual native decision')
      if (decision !== 'decline') assert(approval.params.availableDecisions.includes(decision), 'decision must be offered by native Codex')
      // Native supports Decline as a controller response while its network UI
      // list intentionally omits it. Preserve both facts without inventing a UI choice.
      client.send({ id: approval.id, result: { decision } })
    }
    const terminal = await client.wait(frame => frame.method === 'turn/completed' && frame.params?.turn?.id === turn.turn.id)
    assert.equal(terminal.params.turn.status, decision === 'cancel' ? 'interrupted' : 'completed')
    if (decision === 'decline') assert.match(current.output, /rejected by user/i)
    const requests = capture.serverRequests.filter(frame => frame.method === 'item/commandExecution/requestApproval' && frame.params?.turnId === turn.turn.id)
    assert.equal(requests.length, decision ? 1 : 0, 'session grant must prevent only the matching repeated native request')
    assert.equal(context.network.hits.length - beforeHits, ['decline', 'cancel'].includes(decision) ? 0 : 1)
    capture.observations.networkCases.push({ id, turnId: turn.turn.id, requestId: approval?.id ?? null, approvalId: approval?.params.approvalId ?? null, listener: index, decision, decisionSource: decision === 'decline' ? 'supported-controller-response-not-advertised' : 'offered-native-decision', availableDecisions: approval?.params.availableDecisions ?? [], hits: context.network.hits.length - beforeHits, output: current.output ?? null, terminal: terminal.params.turn.status })
    if (decision !== 'cancel') last = turn
  }
  capture.observations.networkCanaryHits = context.network.hits
  return last
}

export async function captureNativeScenario(name, options = {}) {
  assert(scenarios.includes(name), `unknown native scenario ${name}`)
  const context = await roots(options)
  const capture = { scenario: name, parameters: Object.fromEntries(['historyMode', 'duplicateBodies', 'persistenceMode', 'largeOutput', 'startupCancellation', 'ephemeralParent', 'childApproval', 'approvalControl', 'probeApprovalPolicy', 'probePolicyEffects', 'sandboxMode', 'requirementsGuard'].filter(key => options[key] !== undefined).map(key => [key, options[key]])), probeOnly: options.probeMetadata?.probeOnly === true, binary: { path: context.managed?.launchWrapper ?? path.join(context.artifact.path, context.metadata.executable), version: null, platform: `${process.platform}-${process.arch}`, integrity: context.artifact.integrity }, threadId: null, requests: [], responses: [], serverRequests: [], notifications: [], reads: [], fixtureTraffic: [], observations: {}, frames: [], environment: { uid: process.getuid?.(), gid: process.getgid?.(), groups: process.getgroups?.(), artifact: context.artifact, systemConfig: context.systemConfig, policyClientProbe: context.policyClientProbe, writableRoots: { state: context.stateRoot, receipts: context.receiptRoot }, prerequisites: context.staged ?? null, context: context.environment, ambientBefore: ambientCodex() } }
  Object.defineProperty(capture, 'secretValues', { value: new Set(), enumerable: false })
  capture.environment.cloud = Object.fromEntries(['CLOUD_RUN_JOB', 'CLOUD_RUN_EXECUTION', 'CLOUD_RUN_TASK_INDEX', 'CLOUD_RUN_TASK_ATTEMPT'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]))
  if (options.seccompProbeReceipt) capture.environment.seccompProbe = JSON.parse(await fsp.readFile(options.seccompProbeReceipt, 'utf8'))
  if (context.managed) {
    capture.environment.managedLayout = context.managed
    capture.environment.nativeSandboxPolicy = nativeSandboxPolicy()
    delete capture.environment.nativeSandboxPolicy.profile
    delete capture.environment.nativeSandboxPolicy.json
  }
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
  let childModelStep = 0
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
      if (name === 'mcp-form-url') return options.largeOutput ? largeOutputResponse(record, controlFlow, context) : mcpResponse(record, controlFlow)
      if (options.approvalControl === 'stdin') return stdinResponse(record, controlFlow, capture, context)
      if (options.approvalControl === 'network') return networkResponse(record, controlFlow, capture, context)
      if (name === 'parent-child-read') {
        const childInput = record.body.input.some(item => item.role === 'user' && JSON.stringify(item.content).includes('freshell-child-native-probe'))
        if (childInput) {
          childRequested.resolve()
          if (options.childApproval) {
            if (childModelStep++ === 0) {
              const names = record.body.tools.flatMap(tool => tool.type === 'namespace' ? tool.tools.map(member => member.name) : [tool.name])
              const name = ['exec_command', 'shell_command', 'shell'].find(name => names.includes(name))
              assert(name, 'actual native child must advertise an execution tool')
              const args = name === 'exec_command' ? { cmd: 'cat contract-input.txt', shell: '/bin/sh', login: false, max_output_tokens: 1000 } : name === 'shell' ? { command: ['sh', '-c', 'cat contract-input.txt'] } : { command: 'cat contract-input.txt' }
              return advertisedCall(record, name, args, 'child_contract_command')
            }
            const output = toolOutput(record, 'call_child_contract_command')
            assert.match(output, /codex-child-untrusted-command-ran/)
            capture.observations.childCommandOutput = output
          }
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
      if (name === 'active-input-stop' && controlFlow.current?.kind === 'race') { const current = controlFlow.current; return { text: 'First fragment and final fragment', pauseAfterDelta: () => current.release.promise } }
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
        commands.push('printf forbidden-agents > .agents/freshell-contract-denied', `printf forbidden-home > ${quote(path.join(context.environment.HOME, 'forbidden.txt'))}`, `printf forbidden-state > ${quote(path.join(context.environment.CODEX_HOME, 'forbidden.txt'))}`, `printf forbidden-tmpdir > ${quote(path.join(context.environment.TMPDIR, 'forbidden.txt'))}`, 'printf forbidden-global-temp > /tmp/freshell-codex-excluded-temp', ...(options.sandboxMode === 'read-only' ? ['printf forbidden-workspace > contract-readonly-forbidden.txt'] : []))
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
    if (['plan-question-controls', 'mcp-form-url'].includes(name) || options.approvalControl || options.startupCancellation) {
      const catalogPath = path.join(context.stateRoot, 'models.json')
      await fsp.writeFile(catalogPath, JSON.stringify({ models: [{ slug: 'contract-model', display_name: 'Contract model', description: 'Owned loopback native contract', default_reasoning_level: 'low', supported_reasoning_levels: [{ effort: 'low', description: 'Contract effort' }], shell_type: options.approvalControl || options.largeOutput ? 'unified_exec' : 'disabled', visibility: 'list', supported_in_api: true, priority: 0, support_verbosity: false, truncation_policy: { mode: 'tokens', limit: 10000 }, context_window: 128000, experimental_supported_tools: ['request_user_input_async'], supports_search_tool: false, tool_mode: 'direct', use_responses_lite: false, model_messages: { instructions_template: "Follow the user's request using the available tools." } }] }))
      extraConfig = `model_catalog_json = ${JSON.stringify(catalogPath)}\nweb_search = "disabled"\n[features]\napps = false\ndefault_mode_request_user_input = true\nauth_elicitation = true\nnon_prefixed_mcp_tool_names = false\n[tools.experimental_request_user_input]\nenabled = true\n`
      if (options.approvalControl || options.largeOutput) extraConfig = extraConfig.replace('[tools.experimental_request_user_input]', 'unified_exec = true\nunified_exec_tty = true\nwrite_stdin_approval = true\nexec_permission_approvals = true\nrequest_permissions_tool = true\n[tools.experimental_request_user_input]')
      if (name === 'mcp-form-url' || options.startupCancellation) {
        context.mcpTrace = path.join(context.stateRoot, 'mcp-traffic.jsonl')
        await fsp.writeFile(context.mcpTrace, '', { mode: 0o600 })
        extraConfig += `\n[mcp_servers.contract]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ${JSON.stringify([path.join(repoRoot, 'test/integration/providers/codex-local-provider.mjs'), options.startupCancellation ? '--mcp-startup-fixture' : '--mcp-fixture', context.mcpTrace, fixture.baseUrl.replace(/\/v1$/, '')])}\nenabled = true\nrequired = ${!options.startupCancellation}\nstartup_readiness = "connection"\nstartup_timeout_sec = ${options.startupCancellation ? 90 : 15}\ntool_timeout_sec = 120\n`
      }
    }
    if (options.approvalControl === 'network') {
      context.network = await networkFixture(context)
      extraConfig = `default_permissions = "fixture_network"\napproval_policy = "on-request"\napprovals_reviewer = "user"\n${extraConfig}\n[permissions.fixture_network.filesystem]\n":minimal" = "read"\n${JSON.stringify(context.workspace)} = "read"\n${JSON.stringify(context.artifact.path)} = "read"\n[permissions.fixture_network.network]\nenabled = true\nmode = "limited"\nallow_local_binding = true\n[features.network_proxy]\nenabled = true\nproxy_url = "http://127.0.0.1:${context.network.proxyPort}"\nenable_socks5 = false\nenable_socks5_udp = false\nallow_upstream_proxy = false\nallow_local_binding = true\nmode = "limited"\ncredential_broker = false\n`
    }
    await configure(context, fixture.baseUrl, extraConfig)
    if (options.childApproval) await fsp.writeFile(path.join(context.workspace, 'contract-input.txt'), 'codex-child-untrusted-command-ran\n')
    const restricted = name === 'approval-policy-restricted-exec' && !options.approvalControl
    if (options.largeOutput) {
      context.largeCommand = path.join(context.workspace, 'large-output.py')
      await fsp.writeFile(context.largeCommand, "import sys\nhead=b'F1_COMMAND_HEAD\\n'\ntail=b'\\nF1_COMMAND_TAIL\\n'\nsys.stdout.buffer.write(head+b'x'*(128*1024-len(head)-len(tail))+tail)\nsys.stdout.buffer.flush()\n")
      controlFlow.current = { kind: 'large-output', step: 0 }
    }
    if (options.approvalControl === 'stdin') await fsp.mkdir(path.join(context.workspace, 'allowed'))
    if (restricted) {
      await fsp.writeFile(path.join(context.workspace, 'contract-input.txt'), 'codex-restricted-command-ran\n')
      if (options.probePolicyEffects) {
        const initialized = spawnSync('git', ['init', '--quiet'], { cwd: context.workspace, env: context.environment, encoding: 'utf8', timeout: 15_000 })
        assert.equal(initialized.status, 0, initialized.stderr)
        await fsp.mkdir(path.join(context.workspace, '.codex'))
        await fsp.mkdir(path.join(context.workspace, '.agents'))
        await fsp.mkdir(path.join(context.stateRoot, 'outside'), { mode: 0o700 })
        capture.observations.gitCommonDir = spawnSync('git', ['rev-parse', '--git-common-dir'], { cwd: context.workspace, env: context.environment, encoding: 'utf8', timeout: 15_000 }).stdout.trim()
        {
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
      // copying is qualified separately through the production source-precedence path.
      await configure(context, fixture.baseUrl, extraConfig)
    }
    if (options.requirementsGuard) {
      await nativeRequirementsGuard(context, capture)
      assert.equal(fixture.traffic.length, 0, 'a refused policy cannot reach model work')
      capture.passed = true
      return capture
    }
    if (name === 'model-effort-usage') await nativeCatalogProbe(context,capture,fixture)
    client = new NativeClient(capture.binary.path, context, capture)
    client.onServerRequest = frame => {
      if (frame.method === 'item/commandExecution/requestApproval' && !options.approvalControl) {
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
    const policy = options.probeApprovalPolicy ?? (restricted || options.childApproval ? 'untrusted' : name === 'mcp-form-url' || options.approvalControl ? 'on-request' : 'never')
    const sandboxMode = options.sandboxMode ?? 'read-only'
    const started = await client.request('thread/start', { cwd: context.workspace, model: 'contract-model', modelProvider: 'contract-loopback', approvalPolicy: policy, ...(options.approvalControl === 'network' ? { permissions: 'fixture_network' } : { sandbox: sandboxMode }), experimentalRawEvents: false, persistExtendedHistory: true, ephemeral: options.ephemeralParent ?? false, ...(options.historyMode ? { historyMode: options.historyMode } : {}) })
    capture.threadId = started.thread.id
    capture.observations.threadStart = started
    if (options.persistenceMode) {
      assert.equal(name, 'text-history')
      context.persistenceBlocker = path.join(context.environment.CODEX_HOME, 'sessions')
      assert(!fs.existsSync(context.persistenceBlocker), 'persistence fault requires the native first-materialization parent to be absent')
      await fsp.writeFile(context.persistenceBlocker, 'owned native recorder materialization blocker', { flag: 'wx', mode: 0o600 })
      capture.observations.persistenceFault = { kind: 'owned-file-blocks-native-directory', path: context.persistenceBlocker, mode: options.persistenceMode }
    }
    assert.equal(started.approvalPolicy, policy, 'typed native policy must remain effective')
    if (options.startupCancellation) {
      const starting = await client.wait(frame => frame.method === 'mcpServer/startupStatus/updated' && frame.params?.threadId === capture.threadId && frame.params.name === 'contract' && frame.params.status === 'starting')
      const initialized = await deadline((async () => {
        for (;;) {
          const records = (await fsp.readFile(context.mcpTrace, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
          const held = records.find(record => record.event === 'startup_initialize_held')
          if (held) return held
          await new Promise(resolve => setTimeout(resolve, 10))
        }
      })(), 15_000, 'actual held MCP initialize')
      const ack = await client.request('turn/interrupt', { threadId: capture.threadId, turnId: '' })
      const settled = await client.wait(frame => frame.method === 'mcpServer/startupStatus/updated' && frame.params?.threadId === capture.threadId && frame.params.name === 'contract' && frame.params.status === 'cancelled')
      assert.equal(fixture.traffic.length, 0, 'startup cancellation must precede any model work')
      assert(!capture.requests.some(frame => frame.method === 'turn/start'))
      assert(!capture.notifications.some(frame => frame.method === 'turn/completed'), 'startup has its own native result, never an invented turn terminal')
      capture.observations.startupCancellation = { starting: starting.params, actualInitialize: initialized, acknowledgement: ack, nativeStartupResult: settled.params, modelRequestCount: fixture.traffic.length }
      capture.passed = true
      return capture
    }
    const sandboxPolicy = sandboxMode === 'workspace-write' ? { type: 'workspaceWrite', writableRoots: [context.workspace], networkAccess: options.probeNetworkEnabled ?? false, excludeTmpdirEnvVar: true, excludeSlashTmp: true } : { type: 'readOnly', networkAccess: options.probeNetworkEnabled ?? false }
    let turn = options.approvalControl === 'network' ? await driveNetwork(client, capture, controlFlow, context) : options.approvalControl === 'stdin' ? await driveStdin(client, capture, controlFlow, context) : name === 'plan-question-controls' ? await driveQuestions(client, capture, controlFlow) : name === 'mcp-form-url' && !options.largeOutput ? await driveMcp(client, capture, controlFlow, context) : await client.request('turn/start', { threadId: capture.threadId, approvalPolicy: policy, ...(restricted && !options.probeDefaultPolicy ? { sandboxPolicy } : {}), input: [{ type: 'text', text: 'Run the controlled contract scenario.' }] })
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
      if (options.childApproval) {
        const request = capture.serverRequests.find(frame => frame.method === 'item/commandExecution/requestApproval' && frame.params?.itemId === 'call_child_contract_command')
        assert(request, 'spawned child must actually retain the parent untrusted approval policy')
        assert.equal(request.params.threadId, childId, 'approval must identify the actual native child')
        capture.observations.childApprovalPolicyProof = { parentPolicy: policy, childId, requestId: request.id, approvalId: request.params.approvalId ?? null, request: request.params, actualToolOutput: capture.observations.childCommandOutput }
      }
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
    if (name === 'active-input-stop') turn = await driveNativeRaces(client, capture, controlFlow)
    if (name === 'parent-child-read' && options.ephemeralParent) {
      capture.observations.ephemeralParentReadRefusal = await nativeRefusal(client, 'thread/read', { threadId: capture.threadId, includeTurns: true })
      capture.observations.childObserverMethods = capture.requests.filter(frame => frame.params.threadId === capture.observations.childId).map(frame => frame.method)
      assert(capture.observations.childObserverMethods.every(method => method === 'thread/read'))
      capture.passed = true
      return capture
    }
    if (options.persistenceMode) {
      const event = await client.wait(frame => frame.method === 'item/completed' && frame.params?.turnId === turn.turn.id && frame.params.item?.type === 'agentMessage')
      assert.equal(event.params.item.text, 'First fragment and final fragment')
      capture.observations.retainedCompletedText = event.params.item.text
      capture.observations.boundedRefresh = []
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const body = await client.request('thread/read', { threadId: capture.threadId, includeTurns: true }, 5000)
          capture.reads.push({ label: `blocked-refresh-${attempt}`, body })
          capture.observations.boundedRefresh.push({ attempt, status: 'read', savedText: assistantText(body, turn.turn.id) })
        } catch (error) {
          capture.observations.boundedRefresh.push({ attempt, status: error.nativeError ? 'native-error' : 'timeout-or-exit', error: error.nativeError ?? error.message })
        }
      }
      assert((await fsp.stat(context.persistenceBlocker)).isFile(), 'native recorder must still be unable to create its rollout directory')
      capture.observations.persistenceState = 'retained-unsaved-refresh-stopped'
      if (options.persistenceMode === 'missing') {
        await client.close()
        capture.observations.persistenceOwnedExit = capture.processExit
        await fsp.unlink(context.persistenceBlocker)
        capture.observations.coldMissingFaultRemoved = true
        client = new NativeClient(capture.binary.path, context, capture)
        await client.request('initialize', { clientInfo: { name: 'freshell_codex_missing_persistence', version: '1.0.0' }, capabilities })
        client.send({ method: 'initialized', params: {} })
        capture.observations.coldMissingRead = await nativeRefusal(client, 'thread/read', { threadId: capture.threadId, includeTurns: true })
        capture.observations.coldRecoveryState = 'saved-history-unavailable-no-invented-fragments'
        capture.passed = true
        return capture
      }
      await fsp.unlink(context.persistenceBlocker)
      {
        const flush = await client.request('turn/start', { threadId: capture.threadId, input: [{ type: 'text', text: 'Flush the actual pending native recorder after its owned parent becomes available.' }] })
        await client.wait(frame => frame.method === 'turn/completed' && frame.params?.turn?.id === flush.turn.id)
        capture.observations.persistenceFlushTurnId = flush.turn.id
      }
      try {
        const recovered = await client.request('thread/read', { threadId: capture.threadId, includeTurns: true })
        capture.reads.push({ label: 'released-blocker-warm-read', body: recovered })
        capture.observations.releasedWarmText = assistantText(recovered, turn.turn.id)
      } catch (error) {
        assert(error.nativeError, 'recovery availability failure must come from native')
        capture.observations.releasedWarmReadError = error.nativeError
      }
      capture.observations.persistenceState = 'owned-blocker-released-native-recovery-pending'
      await client.close()
      client = new NativeClient(capture.binary.path, context, capture)
      await client.request('initialize', { clientInfo: { name: 'freshell_codex_delayed_persistence', version: '1.0.0' }, capabilities })
      client.send({ method: 'initialized', params: {} })
      try {
        await client.request('thread/resume', { threadId: capture.threadId, cwd: context.workspace, approvalPolicy: policy, sandbox: sandboxMode, persistExtendedHistory: true })
        const recovered = await client.request('thread/read', { threadId: capture.threadId, includeTurns: true })
        capture.reads.push({ label: 'released-blocker-cold-read', body: recovered })
        assert.equal(assistantText(recovered, turn.turn.id), event.params.item.text)
        capture.observations.persistenceState = 'saved-after-owned-blocker-release-and-cold-recovery'
      } catch (error) {
        assert(error.nativeError, 'recovery must either supply the exact native body or an actual native availability error')
        capture.observations.releasedColdReadError = error.nativeError
        capture.observations.persistenceState = 'retained-unsaved-provider-unavailable-refresh-stopped'
      }
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
    if (options.largeOutput) await verifyLargeOutput(capture, read, context, turn.turn.id, 'warm', options.historyMode)
    capture.observations.finalItems = read.thread.turns.filter(nativeTurn => nativeTurn.id === turn.turn.id).flatMap(nativeTurn => nativeTurn.items)
    if (name === 'model-effort-usage') {
      const usage = capture.notifications.filter(frame => frame.method === 'thread/tokenUsage/updated' && frame.params?.turnId === turn.turn.id).at(-1)?.params.tokenUsage
      assert.equal(usage?.last?.totalTokens, 15, 'usage must come from the actual model completion')
      capture.observations.latestUsage = usage.last
      capture.observations.usageLabel = 'Latest usage'
      const primaryFirst=fixture.traffic[capture.observations.productionCatalogClient.fixtureRequestCount]
      assert.equal(primaryFirst.body.model, 'contract-model')
      assert.equal(primaryFirst.body.reasoning.effort, 'low')
      // Default clears Freshell's override. Record Codex's actual later
      // behavior instead of assuming omission resets its native effort.
      const observations = []
      for (const [label, selection] of [
        ['explicit', { effort: 'xhigh' }],
        ['native-default', { collaborationMode: { mode: 'default', settings: { model: 'contract-model', reasoning_effort: null, developer_instructions: null } } }],
      ]) {
        const before = fixture.traffic.length
        const params = { threadId: capture.threadId, input: [{ type: 'text', text: `Observe the ${label} effort.` }], ...selection }
        const submitted = await client.request('turn/start', params)
        const completed = await client.wait(frame => frame.method === 'turn/completed' && frame.params?.turn?.id === submitted.turn.id)
        assert.equal(completed.params.turn.status, 'completed')
        const current = await client.request('thread/read', { threadId: capture.threadId, includeTurns: true })
        assert.equal(assistantText(current, submitted.turn.id), 'First fragment and final fragment')
        const traffic = fixture.traffic.slice(before)
        assert(traffic.length > 0, `${label} must reach the actual native model wire`)
        observations.push({ label, params, turnId: submitted.turn.id, completed, traffic, current })
      }
      assert.equal(observations[0].traffic[0].body.reasoning.effort, 'xhigh')
      assert.equal(Object.hasOwn(observations[1].params, 'effort'), false)
      assert.equal(observations[1].params.collaborationMode.settings.reasoning_effort, null)
      capture.observations.sameThreadNativeDefault = observations
    }
    if (restricted) {
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
        Object.assign(capture.observations.policyEffects, {
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
    } else if (!['text-history', 'active-input-stop', 'model-effort-usage', 'parent-child-read', 'plan-question-controls', 'mcp-form-url'].includes(name) && !options.approvalControl) {
      throw new Error(`CODEX_CONTRACT_UNIMPLEMENTED: ${name}; text-only execution does not establish this scenario`)
    }
    await client.close()
    client = new NativeClient(capture.binary.path, context, capture)
    await client.request('initialize', { clientInfo: { name: 'freshell_codex_contract_resume', version: '1.0.0' }, capabilities })
    client.send({ method: 'initialized', params: {} })
    const resumedThread = await client.request('thread/resume', { threadId: capture.threadId, cwd: context.workspace, approvalPolicy: policy, ...(options.approvalControl === 'network' ? { permissions: 'fixture_network' } : { sandbox: sandboxMode }), persistExtendedHistory: true })
    capture.observations.resumeApprovalPolicy = resumedThread.approvalPolicy
    assert.equal(resumedThread.approvalPolicy, policy)
    const resumed = await client.request('thread/read', { threadId: capture.threadId, includeTurns: true })
    capture.reads.push({ label: 'cold-resume', body: resumed })
    if (options.largeOutput) await verifyLargeOutput(capture, resumed, context, turn.turn.id, 'cold-resume', options.historyMode)
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
    if (options.approvalControl === 'network') assert.equal(capture.observations.networkCases?.length, 5, 'native network once/session/no-repeat/decline/cancel evidence is required')
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
    if (context.network) await context.network.close()
    if (fixture) { capture.fixtureTraffic = fixture.traffic; await fixture.close() }
    if (context.mcpTrace && fs.existsSync(context.mcpTrace)) capture.observations.mcpTraffic = (await fsp.readFile(context.mcpTrace, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    capture.environment.ambientAfter = ambientCodex()
    assert.equal(capture.environment.ambientAfter, capture.environment.ambientBefore)
    const persisted = sanitizedCapture(capture, capture.secretValues)
    const json = JSON.stringify(persisted)
    await fsp.writeFile(path.join(context.receiptRoot, `${name}-${randomUUID()}.json`), `${json}\n`, { mode: 0o600 })
    if (options.emitReceipt) process.stdout.write(`${JSON.stringify({ nativeCapture: true, capture: persisted })}\n`)
    if (process.env.FRESHELL_CODEX_CONTRACT_CAPTURE_STDOUT === '1') exportCloudCapture(persisted, json)
  }
  return capture
}

async function managedVersion(options) {
  const { register } = await import('tsx/esm/api')
  const unregister = register()
  const { RuntimeHarness } = await import('../../../scripts/testing/runtime-sandbox.ts')
  const harness = new RuntimeHarness(repoRoot, `codex-contract-${randomUUID()}`, 3)
  const receiptDir = path.join(path.resolve(options.receiptDir ?? path.join(repoRoot, '.runtime-build/codex-contract/managed')), `run-${randomUUID()}`)
  console.log(JSON.stringify({ severity: 'info', event: 'codex_managed_receipt_root', path: receiptDir }))
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
    const { runManagedContract } = await import('./codex-managed-contract.mjs')
    await runManagedContract(harness, receiptDir, options)
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
    else if (args[index] === '--persistence-mode') { options.persistenceMode = args[++index]; assert(['delayed', 'missing'].includes(options.persistenceMode)) }
    else if (args[index] === '--duplicate-bodies') options.duplicateBodies = true
    else if (args[index] === '--large-output') options.largeOutput = true
    else if (args[index] === '--startup-cancellation') options.startupCancellation = true
    else if (args[index] === '--missing-policy-client-probe') options.policyClientProbe = '/freshell-missing-policy-client-probe'
    else if (args[index] === '--requirements-guard') options.requirementsGuard = true
    else if (args[index] === '--child-approval') options.childApproval = true
    else if (args[index] === '--ephemeral-parent') options.ephemeralParent = true
    else if (args[index] === '--probe-network-enabled') options.probeNetworkEnabled = true
    else if (args[index] === '--approval-control') { options.approvalControl = args[++index]; assert(['stdin', 'network'].includes(options.approvalControl)) }
    else throw new Error(`unknown argument ${args[index]}`)
  }
  if (options.probePolicyEffects || options.probeApprovalPolicy || options.probeDefaultPolicy || options.legacyLandlock) assert(managed || process.env.FRESHELL_CODEX_MANAGED_CONTRACT === '1' || options.probeMetadata || options.probeSeccomp || options.seccompProbeReceipt, 'probe options require an explicit candidate manifest or declared seccomp probe')
  if (managed) return managedVersion({ ...options, scenario })
  for (const [name, selected] of scenario === 'all' ? nativeContractCases() : [[scenario, {}]]) {
    const capture = await captureNativeScenario(name, { ...options, ...selected })
    console.log(JSON.stringify({ severity: 'info', event: 'codex_native_scenario_passed', scenario: name, parameters: capture.parameters, version: capture.binary.version, threadId: capture.threadId }))
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).catch(error => { console.error(JSON.stringify({ severity: 'error', event: 'codex_native_contract_failed', message: error.message })); process.exitCode = 1 })
