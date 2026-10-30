import { fileURLToPath } from 'node:url'
import { stripVTControlCharacters } from 'node:util'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createConnection } from 'node:net'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { createHash, randomUUID } from 'node:crypto'
import { RuntimeHarness } from './runtime-sandbox.js'
import { nativeExecutionDetails, redactNativeDiagnostic } from './opencode-restoration-rehearsal.js'
import { seedManagedOpenCodeSource } from '../../test/e2e-browser/fixtures/managed-opencode-source.js'
import { ManagedRuntimeSoulSchema } from '../../shared/managed-runtime.js'
import { readCodexNativeHistory, readCodexNativeObservation } from '../../test/e2e-browser/helpers/provider-native-history/codex.js'
import { readOpenCodeNativeHistory, readOpenCodeNativeObservation } from '../../test/e2e-browser/helpers/provider-native-history/opencode.js'
import { deriveNativeRecoveryOriginals, nativeNamespaceAccessMatches, type NativeOriginalReference } from './qualification-observations.js'
import type { NativeHistory } from '../../test/e2e-browser/helpers/provider-native-history/types.js'

const { DatabaseSync }: typeof import('node:sqlite') = createRequire(import.meta.url)('node:sqlite')

export type NativeProvider = 'claude' | 'codex' | 'opencode' | 'amplifier'
export type NativeMode = 'freshclaude' | 'kilroy' | 'freshcodex' | 'freshopencode'
export type NativeExperimentCase = 'startup' | 'native-turn' | 'approval-checkpoint'
export type NativeSelection = { provider?: NativeProvider; mode?: NativeMode; case: NativeExperimentCase }
export type NativeExperimentOriginal = {
  caseId: string
  ownerId: string
  imageDigest: string
  candidateSha: string
  nativeVersion: string
  executableSha256: string
  profileSha256: string
  artifactReferences: string[]
  nativeOriginals?: { evidenceDir: string; reference: NativeOriginalReference }
  assertions: { name: string; pass: boolean }[]
}

// A finite experiment image can retain the pinned ELF behind this wrapper.
// Only exact owned resume-fault workspaces get supported native fault flags;
// ordinary modes and argv remain unchanged. This never fabricates native IDs.
// A finite negative image can redirect the requested native load to a real
// native creation. Responses still come from the pinned provider unchanged;
// this never creates a provider acknowledgement or an identity value.
export const nativeReceiverLoadFaultWrapper = String.raw`
let nativeFaultStage = 'entry'
export function receiverLoadFaultFailure(error, stage) {
  const stages = ['entry', 'verify_uid', 'read_launch_control', 'verify_native_pin', 'validate_native_route',
    'spawn_native_child', 'wait_native_listener', 'capture_native_response', 'await_owned_release', 'bind_native_proxy',
    'create_native_session', 'load_native_session', 'observe_native_load', 'forward_native_request']
  return { stage: stages.includes(stage) ? stage : 'unknown',
    errorKind: ['Error', 'TypeError', 'SyntaxError', 'RangeError'].includes(error?.name) ? error.name : 'OtherError',
    code: ['ENOENT', 'EACCES', 'EROFS', 'EADDRINUSE', 'ECONNREFUSED'].includes(error?.code) ? error.code : null }
}
export function receiverLoadFaultWorkspace(cwd, control, stat) {
  if (control.workspace === undefined) return cwd
  if (typeof control.workspace !== 'string' || !control.workspace) throw new Error('owned native workspace mount alias differs')
  const actual = stat(cwd), declared = stat(control.workspace)
  if (!actual.isDirectory() || !declared.isDirectory() || actual.dev !== declared.dev || actual.ino !== declared.ino) {
    throw new Error('owned native workspace mount alias differs')
  }
  return control.workspace
}
export function receiverLoadFaultBinding(cwd, provider, launch, control) {
  const owned = /^\/tmp\/f[a-z0-9]+\/[a-f0-9]{8}-[a-f0-9]{3}\/(freshcodex|freshopencode)-(wrong-root|cancellation)-workspace$/.exec(cwd)
  if (!owned || provider !== (owned[1] === 'freshcodex' ? 'codex' : 'opencode')
    || control?.schemaVersion !== 1 || control.mode !== owned[1] || control.caseId !== owned[2]
    || typeof control.expectedRoot !== 'string' || !control.expectedRoot
    || launch?.requestedNativeSessionId !== control.expectedRoot
    || typeof launch.launchNonce !== 'string' || !launch.launchNonce
    || typeof launch.incarnationId !== 'string' || !launch.incarnationId) {
    throw new Error('owned native receiver load fault binding differs')
  }
  return { provider, mode: owned[1], caseId: owned[2], expectedRoot: control.expectedRoot,
    incarnationId: launch.incarnationId, launchNonce: launch.launchNonce }
}
export function rewriteCodexNativeResume(raw, expectedRoot) {
  let request
  try { request = JSON.parse(raw.toString('utf8')) } catch { return raw }
  if (!expectedRoot || request?.method !== 'thread/resume'
    || request.params?.threadId !== expectedRoot || request.id === undefined) return raw
  const { threadId, ...profile } = request.params
  return Buffer.from(JSON.stringify({ ...request, method: 'thread/start', params: profile }))
}
export function selectedOpenCodeLoadRoot(requestedRoot, returnedNativeRoot) {
  if (typeof returnedNativeRoot !== 'string' || !/^ses_[A-Za-z0-9]+$/.test(returnedNativeRoot)
    || returnedNativeRoot === requestedRoot) throw new Error('actual native creation did not select a different root')
  return returnedNativeRoot
}
export async function createCodexLoadProxy(options) {
  const { WebSocket, WebSocketServer, upstreamUrl, port, expectedRoot, observe } = options
  const server = new WebSocketServer({ host: '127.0.0.1', port, maxPayload: 1048576 })
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject) })
  const peers = new Set()
  server.on('connection', client => {
    const upstream = new WebSocket(upstreamUrl, { maxPayload: 1048576 })
    peers.add(upstream)
    let pendingId, selected = false, used = false, nativeInputDispatches = 0
    const queue = []
    const send = (bytes, binary) => {
      let request
      try { request = JSON.parse(bytes.toString('utf8')) } catch { /* Unselected frames remain unchanged. */ }
      if (request?.method === 'turn/start') nativeInputDispatches++
      upstream.send(bytes, { binary })
    }
    const close = () => { upstream.terminate(); client.terminate(); peers.delete(upstream) }
    client.on('error', close); upstream.on('error', close)
    client.on('close', close); upstream.on('close', close)
    upstream.on('open', () => { for (const [bytes, binary] of queue) send(bytes, binary); queue.length = 0 })
    client.on('message', (raw, binary) => {
      const bytes = Buffer.from(raw), rewritten = rewriteCodexNativeResume(bytes, expectedRoot)
      if (rewritten !== bytes) {
        if (used) return close()
        used = true; selected = true; pendingId = JSON.parse(bytes.toString('utf8')).id
      }
      if (upstream.readyState === WebSocket.OPEN) send(rewritten, binary)
      else if (queue.length < 16) queue.push([rewritten, binary])
      else close()
    })
    upstream.on('message', async (raw, binary) => {
      const bytes = Buffer.from(raw)
      try {
        let response
        try { response = JSON.parse(bytes.toString('utf8')) } catch { /* Forward ordinary unselected bytes unchanged. */ }
        if (selected && response?.id === pendingId && !response.error && response.result?.thread) {
          const root = response.result.thread.id
          if (typeof root !== 'string' || !root || root === expectedRoot || response.result.thread.ephemeral === true) {
            throw new Error('actual native creation did not select a different durable root')
          }
          selected = false
          await observe(root, bytes, nativeInputDispatches)
        }
        if (client.readyState === WebSocket.OPEN) client.send(bytes, { binary })
      } catch { close() }
    })
  })
  return { url: 'ws://127.0.0.1:' + server.address().port,
    close: async () => { for (const client of server.clients) client.terminate(); for (const peer of peers) peer.terminate()
      await new Promise(resolve => server.close(() => resolve())) } }
}
export async function createOpenCodeLoadProxy(options) {
  const { createServer, request } = await import('node:http')
  const { upstreamUrl, port, expectedRoot, observe } = options
  let selectedRoot, nativeInputDispatches = 0
  const server = createServer(async (incoming, outgoing) => {
    let stage = 'forward_native_request', status = null
    try {
      const selected = new URL(incoming.url, upstreamUrl)
      const headers = { ...incoming.headers }; delete headers.host; delete headers['content-length']
      const exact = selected.pathname === '/session/' + encodeURIComponent(expectedRoot)
      if (incoming.method === 'GET' && exact) {
        if (!selectedRoot) {
          stage = 'create_native_session'
          const created = await fetch(new URL('/session' + selected.search, upstreamUrl),
            { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(5000) })
          status = created.status
          if (!created.ok) throw new Error('actual native session creation refused')
          const bytes = Buffer.from(await created.arrayBuffer())
          if (bytes.length > 1048576) throw new Error('actual native creation result exceeds bound')
          selectedRoot = selectedOpenCodeLoadRoot(expectedRoot, JSON.parse(bytes.toString('utf8')).id)
        }
        selected.pathname = '/session/' + encodeURIComponent(selectedRoot)
        stage = 'load_native_session'; status = null
        const loaded = await fetch(selected, { headers, signal: AbortSignal.timeout(5000) })
        status = loaded.status
        const bytes = Buffer.from(await loaded.arrayBuffer())
        if (!loaded.ok || bytes.length > 1048576 || JSON.parse(bytes.toString('utf8')).id !== selectedRoot) {
          throw new Error('actual native loaded root differs')
        }
        stage = 'observe_native_load'
        await observe(selectedRoot, bytes, nativeInputDispatches)
        outgoing.writeHead(loaded.status, { 'content-type': loaded.headers.get('content-type') ?? 'application/json' })
        outgoing.end(bytes)
        return
      }
      if (selectedRoot && selected.pathname.startsWith('/session/' + encodeURIComponent(expectedRoot) + '/')) {
        selected.pathname = selected.pathname.replace('/session/' + encodeURIComponent(expectedRoot) + '/',
          '/session/' + encodeURIComponent(selectedRoot) + '/')
      }
      if (incoming.method === 'POST' && /^\/session\/[^/]+\/(message|prompt_async)$/.test(selected.pathname)) nativeInputDispatches++
      const upstream = request(selected, { method: incoming.method, headers }, reply => {
        outgoing.writeHead(reply.statusCode ?? 502, reply.headers); reply.pipe(outgoing)
      })
      upstream.on('error', () => outgoing.destroy())
      incoming.on('error', () => upstream.destroy()); incoming.pipe(upstream)
    } catch (error) {
      options.onFailure?.({ schemaVersion: 1, severity: 'error', event: 'runtime.native_receiver_fault.http_failed',
        ...receiverLoadFaultFailure(error, stage), status })
      outgoing.writeHead(502); outgoing.end('owned native load fault refused')
    }
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve) })
  return { url: 'http://127.0.0.1:' + server.address().port,
    close: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) } }
}
async function runOwnedReceiverLoadFault() {
  const fs = await import('node:fs'), path = await import('node:path')
  const { createHash } = await import('node:crypto'), { spawn } = await import('node:child_process')
  const { createServer, createConnection } = await import('node:net')
  const [provider, ...argv] = process.argv.slice(2)
  nativeFaultStage = 'verify_uid'
  if (process.getuid() !== 65534 || process.getgid() !== 0) throw new Error('owned native fault UID/GID differs')
  const cwd = process.env.FRESHELL_OWNED_RECEIVER_LOAD_FAULT_WORKSPACE ?? process.cwd()
  nativeFaultStage = 'read_launch_control'
  const control = JSON.parse(fs.readFileSync(path.join(cwd, 'native-receiver-load-fault-control.json'), 'utf8'))
  const workspace = receiverLoadFaultWorkspace(cwd, control, fs.statSync)
  const binding = receiverLoadFaultBinding(workspace, provider,
    JSON.parse(process.env.FRESHELL_NATIVE_IDENTITY_LAUNCH ?? '{}'), control)
  const executable = provider === 'codex'
    ? '/usr/local/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex'
    : '/usr/local/lib/node_modules/opencode-ai/bin/opencode.exe'
  const expectedPin = provider === 'codex' ? 'cb0a15567e9a60a5820d54b0f6ae86d504dc3805c1eab21a47f70e3eb7b73a40'
    : 'c9485f62576606dbde6404647405df2401fada964b7f669f799dc125dbbeff99'
  nativeFaultStage = 'verify_native_pin'
  if (!fs.statSync(executable).isFile() || createHash('sha256').update(fs.readFileSync(executable)).digest('hex') !== expectedPin) {
    throw new Error('selected original native executable differs')
  }
  const free = createServer()
  await new Promise(resolve => free.listen(0, '127.0.0.1', resolve))
  const backendPort = free.address().port
  await new Promise(resolve => free.close(resolve))
  const args = [...argv]
  nativeFaultStage = 'validate_native_route'
  let outerPort
  if (provider === 'codex') {
    const index = args.indexOf('--listen')
    if (args.filter(arg => arg === '--listen').length !== 1 || index < 0 || !args.includes('app-server')) throw new Error('owned Codex native route differs')
    const address = new URL(args[index + 1])
    if (address.protocol !== 'ws:' || address.hostname !== '127.0.0.1' || !address.port) throw new Error('owned Codex listen differs')
    outerPort = Number(address.port); args[index + 1] = 'ws://127.0.0.1:' + backendPort
  } else {
    const index = args.indexOf('--port'), host = args.indexOf('--hostname')
    if (args[0] !== 'serve' || index < 0 || host < 0 || args[host + 1] !== '127.0.0.1') throw new Error('owned OpenCode native route differs')
    outerPort = Number(args[index + 1]); args[index + 1] = String(backendPort)
  }
  if (!Number.isInteger(outerPort) || outerPort < 1 || outerPort > 65535) throw new Error('owned native outer port differs')
  nativeFaultStage = 'spawn_native_child'
  const child = spawn('/usr/local/bin/' + provider + '.native', args, { stdio: 'inherit' })
  let exited = false, proxy
  child.once('exit', () => { exited = true; proxy?.close().then(() => { process.exitCode = 1 }) })
  child.once('error', () => { exited = true })
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => child.kill(signal))
  try {
    nativeFaultStage = 'wait_native_listener'
    const readyDeadline = Date.now() + 5000
    while (true) {
      if (exited) throw new Error('owned native child exited before listener')
      const ready = await new Promise(resolve => {
        const socket = createConnection({ host: '127.0.0.1', port: backendPort })
        socket.once('connect', () => { socket.destroy(); resolve(true) })
        socket.once('error', () => resolve(false))
      })
      if (ready) break
      if (Date.now() >= readyDeadline) throw new Error('owned native listener timeout')
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    let observed = false
    const observe = async (root, bytes, nativeInputDispatches) => {
      nativeFaultStage = 'capture_native_response'
      if (observed) throw new Error('owned native load fault repeated')
      observed = true
      const receipt = { schemaVersion: 1, ...binding, nativeSessionId: root,
        nativeEvidenceSha256: createHash('sha256').update(bytes).digest('hex'), executableSha256: expectedPin,
        wrapperChildPid: child.pid, observedAt: Date.now(), nativeInputDispatches }
      fs.writeFileSync(path.join(workspace, 'native-receiver-load-fault-observation.json'), JSON.stringify(receipt), { flag: 'wx', mode: 0o664 })
      nativeFaultStage = 'await_owned_release'
      const deadline = Date.now() + 4000
      while (!exited && Date.now() < deadline) {
        try {
          const release = JSON.parse(fs.readFileSync(path.join(workspace, 'native-receiver-load-fault-release.json'), 'utf8'))
          if (release.incarnationId !== binding.incarnationId || release.launchNonce !== binding.launchNonce
            || release.nativeSessionId !== root || release.expectedRoot !== binding.expectedRoot) throw new Error('owned native release binding differs')
          return
        } catch (error) { if (error.code !== 'ENOENT') throw error }
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      throw new Error('owned native response release timed out or child exited')
    }
    nativeFaultStage = 'bind_native_proxy'
    if (provider === 'codex') {
      const { default: WebSocket, WebSocketServer } = await import(new URL('./ws/wrapper.mjs', import.meta.url))
      proxy = await createCodexLoadProxy({ WebSocket, WebSocketServer, port: outerPort,
        upstreamUrl: 'ws://127.0.0.1:' + backendPort, expectedRoot: binding.expectedRoot, observe })
    } else proxy = await createOpenCodeLoadProxy({ port: outerPort, upstreamUrl: 'http://127.0.0.1:' + backendPort,
      expectedRoot: binding.expectedRoot, observe, onFailure: value => {
        fs.writeFileSync(path.join(workspace, 'native-receiver-load-fault-failure.json'), JSON.stringify(value), { mode: 0o664, flag: 'wx' })
      } })
  } catch (error) { child.kill('SIGTERM'); throw error }
}
const { fileURLToPath: nativeWrapperFile } = await import('node:url')
if (process.argv[1] && nativeWrapperFile(import.meta.url) === process.argv[1]) {
  try { await runOwnedReceiverLoadFault() }
  catch (error) {
    const workspace = process.env.FRESHELL_OWNED_RECEIVER_LOAD_FAULT_WORKSPACE ?? process.cwd()
    if (/^\/tmp\/f[a-z0-9]+\/[a-f0-9]{8}-[a-f0-9]{3}\/(freshcodex|freshopencode)-(wrong-root|cancellation)-workspace$/.test(workspace)) {
      const fs = await import('node:fs'), path = await import('node:path')
      fs.writeFileSync(path.join(workspace, 'native-receiver-load-fault-failure.json'),
        JSON.stringify({ schemaVersion: 1, severity: 'error', event: 'runtime.native_receiver_fault.failed',
          ...receiverLoadFaultFailure(error, nativeFaultStage) }), { mode: 0o664, flag: 'wx' })
    }
    throw error
  }
}
`

export const nativeReceiverLoadFaultEntry = String.raw`#!/usr/bin/python3
import os,re,sys,json,pathlib
provider=os.path.basename(sys.argv[0])
if provider not in ('codex','opencode'):raise RuntimeError('native receiver entry differs')
args=sys.argv[1:]
workspace=os.getcwd()
owned_pattern=r'/tmp/f[a-z0-9]+/[a-f0-9]{8}-[a-f0-9]{3}/(freshcodex|freshopencode)-(wrong-root|cancellation)-workspace'
if workspace=='/workspace':
 candidates=[]
 for row in pathlib.Path('/proc/self/mountinfo').read_text().splitlines():
  fields=row.split();mounted=fields[4] if len(fields)>4 else ''
  if re.fullmatch(owned_pattern,mounted) and (pathlib.Path(mounted)/'native-receiver-load-fault-control.json').is_file():candidates.append(mounted)
 if len(candidates)>1:raise RuntimeError('owned native workspace mount ambiguous')
 if candidates:
  selected=candidates[0];control=json.loads((pathlib.Path(selected)/'native-receiver-load-fault-control.json').read_text())
  launch=json.loads(os.environ.get('FRESHELL_NATIVE_IDENTITY_LAUNCH','{}'));bound=re.fullmatch(owned_pattern,selected)
  current=(control.get('workspace')==selected and control.get('mode')==bound[1] and control.get('caseId')==bound[2]
   and provider==bound[1].removeprefix('fresh') and bool(control.get('expectedRoot'))
   and launch.get('requestedNativeSessionId')==control['expectedRoot'] and bool(launch.get('launchNonce')) and bool(launch.get('incarnationId')))
  if not current:raise RuntimeError('owned native workspace launch binding differs')
  workspace=selected;os.environ['FRESHELL_OWNED_RECEIVER_LOAD_FAULT_WORKSPACE']=selected
owned=re.fullmatch(owned_pattern,workspace)
native='/usr/local/bin/'+provider+'.native'
if owned and ((provider=='codex' and 'app-server' in args) or (provider=='opencode' and args and args[0]=='serve')):
 os.execv('/usr/local/bin/node',['node','/opt/freshell-native-receiver-load-fault/native-load-fault.mjs',provider,*args])
os.execv(native,[native,*args])
`

export function writeOwnedNativeReceiverControl(workspace: string, fileName: 'native-receiver-load-fault-control.json' | 'native-receiver-load-fault-release.json', value: unknown): void {
  const target = path.join(workspace, fileName), temporary = target + '.tmp'
  const descriptor = fs.openSync(temporary, 'wx', 0o600)
  try {
    fs.writeFileSync(descriptor, JSON.stringify(value))
    fs.fchmodSync(descriptor, 0o644)
    // Publish the complete readable binding without replacing an old control.
    fs.linkSync(temporary, target)
  } finally { fs.closeSync(descriptor); fs.unlinkSync(temporary) }
}

export const nativeSdkResumeForkWrapper = String.raw`#!/usr/bin/python3
import hashlib,json,os,pathlib,re,sys,uuid
native=pathlib.Path('/opt/freshell-claude-sidecar/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude.native')
if not native.is_file() or native.is_symlink() or hashlib.sha256(native.read_bytes()).hexdigest()!='73975167f0108693cf6fd6614994781657ebb8456ebef5d247458734abfb3916':
 raise RuntimeError('pinned original SDK child differs')
args=sys.argv[1:]
owned=re.fullmatch(r'/tmp/f[a-z0-9]+/[a-f0-9]{8}-[a-f0-9]{3}/(freshclaude|kilroy)-(wrong-id|restoration-failure-after-hook)-workspace',os.getcwd())
roots=[]
if owned:
 for index,arg in enumerate(args):
  if arg=='--resume':
   if index+1>=len(args):raise RuntimeError('native resume argument missing')
   roots.append(args[index+1])
  elif arg.startswith('--resume='):roots.append(arg.split('=',1)[1])
if owned and roots:
 launch=json.loads(os.environ.get('FRESHELL_NATIVE_IDENTITY_LAUNCH','{}'))
 if len(roots)!=1 or not launch.get('launchNonce') or not launch.get('incarnationId'):
  raise RuntimeError('current owned SDK resume binding missing or ambiguous')
 root=roots[0];uuid.UUID(root)
 if launch.get('requestedNativeSessionId')!=root:raise RuntimeError('owned SDK requested resume root differs')
 if owned.group(2)=='wrong-id':
  if '--fork-session' not in args:args.append('--fork-session')
 else:
  control=json.loads(pathlib.Path('native-restoration-fault-control.json').read_text())
  anchor=control.get('missingAnchor');uuid.UUID(anchor)
  if control.get('root')!=root or anchor==root or not isinstance(control.get('seedBytes'),int) or control['seedBytes']<1 or not re.fullmatch(r'[a-f0-9]{64}',control.get('seedSha256','')):
   raise RuntimeError('owned SDK native restoration control differs')
  if any(arg=='--resume-session-at' or arg.startswith('--resume-session-at=') for arg in args):
   raise RuntimeError('selected native resume anchor already exists')
  args.append('--resume-session-at='+anchor)
os.execv(str(native),[str(native),*args])
`

// Finite negative image only: use the real observed native acknowledgement,
// then fault exactly its projected ID before the existing Rust normalizer and
// native receiver. Never substitute these frames for positive identity proof.
export function nativeResumeRootInArgv(argv: readonly string[], root: string): boolean {
  const roots = argv.flatMap((arg, index) => arg === '--resume' ? [argv[index + 1]]
    : arg.startsWith('--resume=') ? [arg.slice('--resume='.length)] : [])
  return roots.length === 1 && roots[0] === root
}

export function stageSdkInitFieldFault(source: string): string {
  const original = String.raw`if (state.nativeIdentityEvidence) emit({ type: 'sdk.session.init', sessionId, cliSessionId: state.cliSessionId,
    cwd: state.nativeObservation.native.cwd, model: req.model, nativeIdentityEvidence: state.nativeIdentityEvidence,
    ...(Array.isArray(state.pendingNativeInit?.capabilities) ? { capabilities: state.pendingNativeInit.capabilities } : {}) })`
  if (source.split(original).length !== 2) throw new Error('pinned native SDK init publisher differs')
  return source.replace(original, String.raw`if (state.nativeIdentityEvidence) {
      const launch = state.launch
      const observation = state.nativeObservation
      const nativeInit = { type: 'sdk.session.init', sessionId, cliSessionId: state.cliSessionId,
        cwd: observation.native.cwd, model: req.model, nativeIdentityEvidence: state.nativeIdentityEvidence,
        ...(Array.isArray(state.pendingNativeInit?.capabilities) ? { capabilities: state.pendingNativeInit.capabilities } : {}) }
      const fieldFault = /^\/tmp\/f[a-z0-9]+\/[a-f0-9]{8}-[a-f0-9]{3}\/(freshclaude|kilroy)-(missing-native-id|placeholder-id)-workspace$/.exec(req.cwd || '')
      if (fieldFault) {
        const { readFile } = await import('node:fs/promises')
        const control = JSON.parse(await readFile(join(req.cwd, 'native-init-field-fault-control.json'), 'utf8'))
        if (req.resumeSessionId || launch?.requestedNativeSessionId !== null || !launch?.launchNonce || !launch?.incarnationId
          || control.mode !== fieldFault[1] || control.caseId !== fieldFault[2]
          || !observation.nativeSessionId || observation.nativeSessionId === sessionId) {
          throw new Error('owned native init field fault binding differs')
        }
        const actualNativeSessionId = nativeInit.cliSessionId
        if (fieldFault[2] === 'missing-native-id') delete nativeInit.cliSessionId
        else nativeInit.cliSessionId = sessionId
        const { writeFile } = await import('node:fs/promises')
        await writeFile(join(req.cwd, 'native-init-field-fault-observation.json'),
          JSON.stringify({ caseId: fieldFault[2], mode: fieldFault[1], actualNativeSessionId, frame: nativeInit }), { mode: 0o660 })
      }
      emit(nativeInit)
    }`)
}

export function nativeSdkInitFieldFaultMatches(mode: NativeMode, caseId: string, receipt: any, namespace: any, refusals: any): boolean {
  if (!['freshclaude', 'kilroy'].includes(mode) || !['missing-native-id', 'placeholder-id'].includes(caseId)
    || receipt?.mode !== mode || receipt.caseId !== caseId || !namespace?.hook || !Array.isArray(refusals)) return false
  const launch = namespace.nativeLaunch, frame = receipt.frame
  const sameLaunch = (actual: any) => !!actual && !!launch
    && ['incarnationId', 'launchNonce', 'evidenceRevision', 'executionGeneration', 'requestedNativeSessionId']
      .every(key => actual[key] === launch[key])
  const root = receipt.actualNativeSessionId
  if (typeof root !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(root)
    || namespace.nativeRoot !== root || namespace.hook.native?.session_id !== root
    || namespace.hook.native?.source !== 'startup' || !sameLaunch(namespace.hook.launch)
    || !launch?.incarnationId || !launch.launchNonce || launch.requestedNativeSessionId !== null
    || !Number.isSafeInteger(launch.evidenceRevision) || launch.evidenceRevision < 0
    || !Number.isSafeInteger(launch.executionGeneration) || launch.executionGeneration < 1
    || frame?.type !== 'sdk.session.init' || typeof frame.sessionId !== 'string' || !frame.sessionId
    || frame.sessionId === root || namespace.hook.native.cwd !== frame.cwd) return false
  const evidenceMatches = (event: any) => sameLaunch(event?.nativeIdentityEvidence?.launch)
    && /^[a-f0-9]{64}$/i.test(namespace.hookSha256 ?? '')
    && event.nativeIdentityEvidence.digest === namespace.hookSha256
    && event.nativeIdentityEvidence.source === namespace.hook.native.source
    && Number.isSafeInteger(event.nativeIdentityEvidence.queryGeneration) && event.nativeIdentityEvidence.queryGeneration > 0
  const fieldMatches = (event: any) => caseId === 'missing-native-id'
    ? !Object.prototype.hasOwnProperty.call(event, 'cliSessionId')
    : event.cliSessionId === frame.sessionId && !/^[a-f0-9-]{36}$/i.test(event.cliSessionId)
  if (!evidenceMatches(frame) || !fieldMatches(frame)) return false
  const current = refusals.filter((record: any) => record?.event === 'host.native_identity.refused' && sameLaunch(record.launch))
  return current.length === 1 && current.every((record: any) => record.severity === 'warn'
    && record.reason === (caseId === 'missing-native-id' ? 'missing_cli_session_id' : 'local_placeholder_id')
    && record.provider === (mode === 'kilroy' ? 'kilroy' : 'claude')
    && record.normalizedEventType === 'freshAgent.session.init'
    && record.nativeEvidenceDigest === namespace.hookSha256
    && record.nativeEvidenceSource === namespace.hook.native.source
    && record.queryGeneration === frame.nativeIdentityEvidence.queryGeneration
    && record.nativeReceiverPublished === false && record.nativeReceiverContainsIdentity === false)
}

export function staleNativeSignalBindingMatches(captured: any, priorLaunch: any, currentLaunch: any, root: string): boolean {
  return captured.hooksDisabled === true && captured.hook?.native.session_id === root
    && captured.loaded?.native.session_id === root
    && JSON.stringify(captured.hook.launch) === JSON.stringify(priorLaunch)
    && JSON.stringify(captured.loaded.launch) === JSON.stringify(priorLaunch)
    && JSON.stringify(captured.nativeLaunch) === JSON.stringify(currentLaunch)
    && !!priorLaunch?.launchNonce && !!priorLaunch?.incarnationId
    && !!currentLaunch?.launchNonce && !!currentLaunch?.incarnationId
    && currentLaunch.launchNonce !== priorLaunch?.launchNonce
    && currentLaunch.incarnationId !== priorLaunch?.incarnationId
}

export function parseNativeFeasibilityArguments(args: readonly string[]): NativeSelection {
  if (args.length !== 4 || !['--provider', '--mode'].includes(args[0] ?? '') || args[2] !== '--case') {
    throw new Error('usage: runtime-native-feasibility --provider claude|codex|opencode|amplifier OR --mode freshclaude|kilroy|freshcodex|freshopencode --case startup|native-turn|approval-checkpoint')
  }
  const cases = ['startup', 'native-turn', 'approval-checkpoint']
  if (!cases.includes(args[3]!)) throw new Error('unknown finite native case')
  const selected = args[1]!
  if (args[0] === '--provider') {
    if (!['claude', 'codex', 'opencode', 'amplifier'].includes(selected) || args[3] === 'approval-checkpoint') {
      throw new Error('unsupported native provider/case')
    }
    return { provider: selected as NativeProvider, case: args[3] as NativeExperimentCase }
  }
  if (!['freshclaude', 'kilroy', 'freshcodex', 'freshopencode'].includes(selected)
    || (args[3] === 'approval-checkpoint' && !['freshclaude', 'kilroy'].includes(selected))) {
    throw new Error('unsupported native mode/case')
  }
  return { mode: selected as NativeMode, case: args[3] as NativeExperimentCase }
}

export function nativeFeasibilityCases(selection: NativeSelection): readonly string[] {
  if (selection.case === 'native-turn') return ['current-native-turn']
  if (selection.case === 'approval-checkpoint') return [
    'allow', 'deny', 'crash-before-checkpoint', 'changed-tool', 'missing-tool', 'changed-input',
    'changed-profile', 'changed-root', 'multiple-tools', 'stale-callback', 'effect-before-observation',
  ]
  if (selection.provider === 'claude') return [
    'create', 'exact-resume', 'fork-root', 'wrong-root', 'stale-shared-signal', 'disabled-hooks',
    'trust-refusal', 'unwritable-signal', 'timeout', 'provider-exit', 'stop-cancellation', 'restoration-failure-after-hook',
  ]
  if (selection.provider === 'amplifier') return [
    'create', 'exact-resume', 'wrong-root', 'missing-history', 'missing-context-restore', 'load-failure',
    'timeout', 'provider-exit', 'stop-cancellation', 'file-replacement', 'file-truncation', 'old-writer',
    'malformed-ack', 'parent-root', 'native-followup',
  ]
  if (selection.mode === 'freshclaude' || selection.mode === 'kilroy') return [
    'create', 'exact-resume', 'wrong-id', 'missing-native-id', 'placeholder-id', 'disabled-hooks',
    'restoration-failure-after-hook', 'timeout-50s', 'provider-exit', 'stop-cancellation',
  ]
  if (selection.provider === 'opencode') return [
    'null-slot', 'disposal', 'root-load-error', 'history-load-error', 'v1-empty', 'v2-empty-is-not-v1-empty',
    'full-revert', 'part-revert', 'baseline-only-resume', 'stale-observation', 'cancellation',
  ]
  return ['create', 'exact-resume', 'wrong-root', 'cancellation']
}

/** Prepare only a new qualification source, before the unchanged exporter.
 * The canonical seeder, imported destination and adoption baseline are never
 * altered by this finite native experiment.
 */
export function prepareOwnedOpenCodeTuiSource(repoRoot: string, ownedRoot: string, caseId: string, nonce: string) {
  if (!/^\/tmp\/f[a-z0-9]+\/[a-f0-9]{8}-[a-f0-9]{3}$/.test(ownedRoot)
    || fs.realpathSync(ownedRoot) !== ownedRoot || !nonce
    || !(caseId === 'current-native-turn' || nativeFeasibilityCases({ provider: 'opencode', case: 'startup' }).includes(caseId))) {
    throw new Error('finite owned OpenCode source preparation required')
  }
  const workspace = path.join(ownedRoot, `opencode-${caseId}-workspace`)
  const databasePath = path.join(ownedRoot, `opencode-${caseId}-source.db`)
  if (fs.existsSync(workspace) || fs.existsSync(databasePath)) throw new Error('OpenCode source already exists')
  fs.mkdirSync(workspace, { mode: 0o770 })
  fs.chmodSync(workspace, 0o770)
  const options = { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }, stdio: 'ignore' as const }
  const nativeGit = (args: string[]): void => {
    // A child-local umask makes the new fixture readable by the native UID
    // without changing the caller's process-wide mask (or operator files).
    execFileSync('python3', ['-c', "import os,sys; os.umask(0o022); os.execvp('git',['git',*sys.argv[1:]])", '-C', workspace, ...args], options)
  }
  nativeGit(['init', '--quiet'])
  nativeGit(['remote', 'add', 'origin', 'https://fixture.invalid/freshell/managed-opencode.git'])
  nativeGit(['-c', 'user.name=Owned Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--allow-empty', '--no-verify', '--quiet', '-m', 'owned native qualification workspace'])
  const source = seedManagedOpenCodeSource({ repoRoot, databasePath, workspace, nonce, messageCount: 2 })
  const database = new DatabaseSync(databasePath)
  try {
    const changed = database.prepare("UPDATE project SET vcs='git' WHERE worktree=?").run(workspace)
    if (changed.changes !== 1) throw new Error('owned source native Git project count differs')
    if (caseId === 'v1-empty') {
      database.prepare('DELETE FROM part WHERE session_id=?').run(source.rootId)
      database.prepare('DELETE FROM message WHERE session_id=?').run(source.rootId)
    } else if (caseId === 'full-revert' || caseId === 'part-revert') {
      const part = caseId === 'part-revert'
        ? database.prepare("SELECT id FROM part WHERE message_id=? AND json_extract(data,'$.type')='text'").get(source.lastMessageId)
        : undefined
      if (caseId === 'part-revert' && typeof part?.id !== 'string') throw new Error('owned source native revert part missing')
      database.prepare('UPDATE session SET revert=? WHERE id=?').run(JSON.stringify({
        messageID: source.lastMessageId, ...(part ? { partID: part.id } : {}),
      }), source.rootId)
    }
  } finally { database.close() }
  const selected = new DatabaseSync(databasePath, { readOnly: true })
  try {
    const ids = selected.prepare('SELECT id FROM message WHERE session_id=? ORDER BY id').all(source.rootId).map(row => String(row.id))
    const expectedActiveMessageIds = caseId === 'full-revert' ? ids.slice(0, -1) : ids
    return { ...source, workspace, expectedActiveMessageIds }
  } finally { selected.close() }
}

type NativeCheckpointSnapshot = { nativeRoot: string; transcript: {
  identity: string[]; sha256: string; bytesBase64: string; completeEof: boolean
} }
export function nativeCheckpointTranscriptRetained(before: NativeCheckpointSnapshot,
  after: NativeCheckpointSnapshot, toolUseID: string): boolean {
  try {
    if (!before.nativeRoot || before.nativeRoot !== after.nativeRoot || !toolUseID.startsWith('toolu_')
      || !before.transcript.completeEof || !after.transcript.completeEof
      || before.transcript.identity.length < 2 || after.transcript.identity.length < 2
      || before.transcript.identity[0] !== after.transcript.identity[0]
      || before.transcript.identity[1] !== after.transcript.identity[1]) return false
    const original = Buffer.from(before.transcript.bytesBase64, 'base64')
    const current = Buffer.from(after.transcript.bytesBase64, 'base64')
    const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
    if (!original.length || original.at(-1) !== 10 || current.at(-1) !== 10
      || digest(original) !== before.transcript.sha256 || digest(current) !== after.transcript.sha256
      || !current.subarray(0, original.length).equals(original)) return false
    const tail = current.subarray(original.length).toString('utf8')
    if (tail.includes('"tool_use_id":"' + toolUseID + '"')) return false
    // A current resumed hook may append its lifecycle rows. Neither a new
    // operation/checkpoint nor any tool outcome can precede the user decision.
    return tail.split('\n').filter(Boolean).every((line) => {
      const row = JSON.parse(line)
      return (!row.sessionId || row.sessionId === before.nativeRoot)
        && ((row.type === 'queue-operation' && ['enqueue', 'dequeue'].includes(row.operation))
          || (row.type === 'attachment' && row.attachment?.type === 'hook_success'))
    })
  } catch { return false }
}

export function nativeTwoToolBatchMatches(snapshot: NativeCheckpointSnapshot, commands: readonly string[]): boolean {
  try {
    const distinctCommands = new Set(commands)
    if (!snapshot.nativeRoot || !snapshot.transcript.completeEof || commands.length !== 2 || distinctCommands.size !== 2) return false
    const bytes = Buffer.from(snapshot.transcript.bytesBase64, 'base64')
    if (bytes.at(-1) !== 10 || createHash('sha256').update(bytes).digest('hex') !== snapshot.transcript.sha256) return false
    const batches = new Map<string, any[]>()
    for (const row of bytes.toString('utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))) {
      if (row.type !== 'assistant') continue
      const tools = (Array.isArray(row.message?.content) ? row.message.content : []).filter((part: any) => part.type === 'tool_use')
      if (!tools.length) continue
      if (row.sessionId !== snapshot.nativeRoot || typeof row.message.id !== 'string' || !row.message.id
        || tools.some((tool: any) => typeof tool.id !== 'string' || !tool.id)) return false
      batches.set(row.message.id, [...(batches.get(row.message.id) ?? []), ...tools])
    }
    return [...batches.values()].some((tools) => tools.length === 2 && new Set(tools.map((tool) => tool.id)).size === 2
      && tools.every((tool) => tool.name === 'Bash' && distinctCommands.has(tool.input?.command))
      && new Set(tools.map((tool) => tool.input.command)).size === 2)
  } catch { return false }
}

type AmplifierProfileSnapshot = { nativeCwd: string; nativeSettingsSha256: string;
  profileFiles: { relative: string; sha256: string | null; bytesBase64?: string | null }[] }
export function amplifierNativeProfileRetained(before: AmplifierProfileSnapshot,
  after: AmplifierProfileSnapshot, workspace: string): boolean {
  const names = ['.amplifier/settings.yaml', '.amplifier/bundles/default.yaml', '.amplifier/keys.env']
  const valid = (snapshot: AmplifierProfileSnapshot) => snapshot.nativeCwd === workspace
    && /^[a-f0-9]{64}$/.test(snapshot.nativeSettingsSha256)
    && snapshot.profileFiles.length === names.length && names.every((relative) =>
      snapshot.profileFiles.filter((file) => file.relative === relative && /^[a-f0-9]{64}$/.test(file.sha256 ?? '')).length === 1)
  if (!valid(before) || !valid(after) || before.nativeSettingsSha256 !== after.nativeSettingsSha256) return false
  const bundle = (snapshot: AmplifierProfileSnapshot) => snapshot.profileFiles.find((file) => file.relative === names[1])!.sha256
  return bundle(before) === bundle(after)
}

/** Finite process dispatcher only; fixture children never establish native qualification. */
export async function dispatchNativeFeasibility(input: {
  selection: NativeSelection
  imageDigest: string
  candidateSha: string
  ownerId: string
  execute: (caseId: string) => Promise<NativeExperimentOriginal>
  cleanup: () => Promise<void>
}): Promise<NativeExperimentOriginal[]> {
  if (!/^sha256:[a-f0-9]{64}$/.test(input.imageDigest) || !/^[a-f0-9]{40}$/.test(input.candidateSha)
    || !input.ownerId || !!input.selection.mode === !!input.selection.provider) {
    throw new Error('exact candidate, image, owner and one finite selector required')
  }
  parseNativeFeasibilityArguments([input.selection.mode ? '--mode' : '--provider',
    input.selection.mode ?? input.selection.provider!, '--case', input.selection.case])
  const originals: NativeExperimentOriginal[] = []
  const failures: string[] = []
  const causes: unknown[] = []
  const requiredAssertions = input.selection.case === 'native-turn' ? [
    'readable-completed-native-store-before-death', 'replacement-new-incarnation-same-native-root',
    'original-owned-volume-transcript-continuity', 'same-workspace-selected-native-profile',
    'actual-restored-context-private-marker-recall', 'native-turns-requested-no-tools',
  ] : []
  try {
    for (const caseId of nativeFeasibilityCases(input.selection)) {
      try {
        const original = await input.execute(caseId)
        originals.push(original)
        if (original.caseId !== caseId || original.ownerId !== input.ownerId
          || original.imageDigest !== input.imageDigest || original.candidateSha !== input.candidateSha
          || !original.nativeVersion || !/^[a-f0-9]{64}$/.test(original.executableSha256)
          || !/^[a-f0-9]{64}$/.test(original.profileSha256) || original.artifactReferences.length === 0
          || original.assertions.length === 0 || original.assertions.some((assertion) => !assertion.pass)
          || requiredAssertions.some((name) => !original.assertions.some((assertion) => assertion.name === name && assertion.pass))) {
          failures.push(caseId)
        }
        if (input.selection.case === 'native-turn') {
          if (!original.nativeOriginals) throw new Error('native-turn original references missing')
          deriveNativeRecoveryOriginals({ evidenceDir: original.nativeOriginals.evidenceDir, originalReference: original.nativeOriginals.reference, candidateSha: input.candidateSha, runId: input.ownerId, runtimeImage: input.imageDigest, selected: [input.selection.mode ?? input.selection.provider!], requiredStages: ['initial', 'after_provider_process_crash'] })
        }
      } catch (error) {
        failures.push(caseId)
        causes.push(error)
      }
    }
  } finally {
    await input.cleanup()
  }
  if (failures.length > 0 || originals.length !== nativeFeasibilityCases(input.selection).length) {
    throw new AggregateError(causes, `native experiment cases failed: ${failures.join(',')}`)
  }
  return originals
}

/** Ordinary preferences for newly owned terminal homes; no permission or model policy. */
export function ownedClaudeStartupPreferences(workspaces: readonly string[]): string {
  const projects = Object.fromEntries(workspaces.map(workspace => [workspace, { hasTrustDialogAccepted: true }]))
  return JSON.stringify({ theme: 'dark', hasCompletedOnboarding: true, projects })
}

export async function runNativeFeasibility(args = process.argv.slice(2)): Promise<void> {
  const selection = parseNativeFeasibilityArguments(args)
  const manifestPath = process.env.FRESHELL_NATIVE_FEASIBILITY_ARTIFACTS_FILE
  if (!manifestPath || !path.isAbsolute(manifestPath) || fs.realpathSync(manifestPath) !== manifestPath
    || !fs.lstatSync(manifestPath).isFile()) throw new Error('exact private native artifact manifest required')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
    candidateSha: string; imageDigest: string
    artifacts: { supervisor: { path: string; sha256: string }; host: { path: string; sha256: string }; server?: { path: string; sha256: string } }
    sourceFiles: { name: string; path: string; sha256: string }[]
  }
  const harness = new RuntimeHarness(process.cwd(), undefined, 1)
  if (selection.provider === 'claude'
    && !manifest.sourceFiles.some((file) => file.name === 'claude/profile/native-startup-user.json')) {
    // Newly owned native UI preferences remove onboarding interaction only.
    // Permission/model policy stays in its ordinary native settings sources.
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'task004-terminal-native-profile-'))
    fs.chmodSync(directory, 0o700)
    const profilePath = path.join(directory, 'native-startup-user.json')
    fs.writeFileSync(profilePath, ownedClaudeStartupPreferences(nativeFeasibilityCases(selection).map(caseId =>
      path.join(harness.testRoot, `claude-${caseId}-workspace`))), { mode: 0o600 })
    manifest.sourceFiles.push({ name: 'claude/profile/native-startup-user.json', path: profilePath,
      sha256: createHash('sha256').update(fs.readFileSync(profilePath)).digest('hex') })
  }
  let paidPrerequisiteFailed = false
  const servers: { server: import('../../test/e2e-browser/helpers/rust-server.js').RustServer; scope: string; pid?: number }[] = []
  const failures: unknown[] = []
  try {
    const prepared = await harness.prepareNativeArtifacts({ candidateSha: manifest.candidateSha,
      imageDigest: manifest.imageDigest, supervisor: manifest.artifacts.supervisor, host: manifest.artifacts.host,
      ...(manifest.artifacts.server ? { server: manifest.artifacts.server } : {}),
      sourceFiles: manifest.sourceFiles })
    harness.writeArtifact('native-selection.json', selection)
    const originals = await dispatchNativeFeasibility({ selection, imageDigest: manifest.imageDigest,
      candidateSha: manifest.candidateSha, ownerId: harness.runId,
      execute: async (caseId) => {
        const amplifierSeed = selection.provider === 'amplifier' && ['exact-resume', 'old-writer', 'native-followup', 'current-native-turn'].includes(caseId)
        const receiverMode = ['freshcodex', 'freshopencode'].includes(selection.mode ?? '') || selection.provider === 'codex'
        const receiverSeed = receiverMode && ['exact-resume', 'wrong-root', 'current-native-turn'].includes(caseId)
        const paidCase = selection.case === 'approval-checkpoint'
          || (selection.provider === 'claude' && ['exact-resume', 'fork-root', 'restoration-failure-after-hook'].includes(caseId))
          || amplifierSeed || receiverSeed
        if (paidPrerequisiteFailed && paidCase) {
          throw new Error('prior native prerequisite failed; no further paid operation started')
        }
        if (paidPrerequisiteFailed && receiverMode && caseId === 'cancellation') {
          throw new Error('prior native create failed; dependent receiver cancellation not started')
        }
        try { return await executeManagedNativeCase(harness, prepared.files, selection, caseId, prepared.serverPath, servers) }
        catch (error) {
          if (selection.case === 'approval-checkpoint'
            || (selection.provider === 'claude' && caseId === 'create')
            || (selection.provider === 'amplifier' && caseId === 'create') || amplifierSeed
            || (receiverMode && caseId === 'create') || receiverSeed) paidPrerequisiteFailed = true
          const reason = error instanceof Error ? error.message : 'unknown native case failure'
          try {
            harness.writeArtifact(`native-case-${caseId}-failure.json`, { severity: 'error',
              event: 'runtime.native_feasibility.case_failed', caseId, reason })
          } catch (diagnosticError) {
            throw new AggregateError([error, diagnosticError], 'native case and diagnostic capture failed')
          }
          throw error
        }
      },
      cleanup: async () => {},
    })
    harness.writeArtifact('native-originals.json', originals)
  } catch (error) {
    failures.push(error)
  } finally {
    // Diagnostics and resource ownership are independent: a full evidence disk
    // must never prevent any server or the enclosing harness from settling.
    const attempt = async (operation: () => unknown | Promise<unknown>) => {
      try { await operation() } catch (error) { failures.push(error) }
    }
    try {
      for (const owned of servers) {
        await attempt(() => harness.writeArtifact(`${owned.scope}-server-output-private.json`, owned.server.capturedOutput()))
        if (owned.pid === undefined) {
          try { owned.pid = owned.server.processEvidence().pid } catch { /* Failed startup may have already joined its child. */ }
        }
        await attempt(() => owned.server.stop())
        await attempt(() => {
          const absent = owned.pid === undefined ? null : !fs.existsSync(`/proc/${owned.pid}`)
          if (absent === false) failures.push(new Error('owned native server did not stop'))
          harness.writeArtifact(`${owned.scope}-server-cleanup.json`, { pid: owned.pid, absent })
        })
      }
      await attempt(async () => {
        const containers = new Set([...harness.transferOwnedIds().containers,
          ...(harness.broker?.receipts() ?? []).map((receipt) => receipt.containerId)])
        for (const containerId of containers) {
          await attempt(async () => fs.writeFileSync(path.join(harness.evidenceDir, `native-container-${containerId}.log`),
            await harness.containerLogs(containerId), { mode: 0o600 }))
        }
      })
    } finally {
      await attempt(async () => {
        const cleanup = await harness.cleanup()
        if (!cleanup.ok) throw new Error(`native owned cleanup failed: ${cleanup.errors.join('; ')}`)
      })
    }
  }
  if (failures.length === 1) throw failures[0]
  if (failures.length) throw new AggregateError(failures, 'native feasibility execution or cleanup failed')
}

export async function executeManagedNativeCase(harness: RuntimeHarness,
  sources: { name: string; path: string; sha256: string }[], selection: NativeSelection,
  caseId: string, serverPath?: string,
  servers: { server: import('../../test/e2e-browser/helpers/rust-server.js').RustServer; scope: string; pid?: number }[] = []): Promise<NativeExperimentOriginal> {
  if (selection.provider === 'opencode' && (selection.case === 'startup' || caseId === 'current-native-turn')) {
    return executeManagedOpenCodeTui(harness, sources, caseId, serverPath, servers)
  }
  if (selection.provider === 'codex' && ['create', 'exact-resume', 'wrong-root', 'cancellation', 'current-native-turn'].includes(caseId)) {
    return executeManagedReceiverNative(harness, sources, 'codex', caseId, serverPath, servers)
  }
  if (['freshcodex', 'freshopencode'].includes(selection.mode ?? '') && ['create', 'exact-resume', 'wrong-root', 'cancellation', 'current-native-turn'].includes(caseId)) {
    return executeManagedReceiverNative(harness, sources, selection.mode as 'freshcodex' | 'freshopencode', caseId)
  }
  if (selection.provider === 'claude' && ['create', 'wrong-root', 'fork-root', 'stale-shared-signal', 'disabled-hooks', 'trust-refusal', 'unwritable-signal', 'timeout', 'provider-exit', 'stop-cancellation', 'exact-resume', 'restoration-failure-after-hook', 'current-native-turn'].includes(caseId)) {
    return executeManagedTerminalClaude(harness, sources, caseId, serverPath, servers)
  }
  if (selection.provider === 'amplifier' && ['create', 'wrong-root', 'missing-history', 'load-failure', 'missing-context-restore', 'timeout', 'provider-exit', 'stop-cancellation', 'file-replacement', 'file-truncation', 'malformed-ack', 'parent-root', 'old-writer', 'exact-resume', 'native-followup', 'current-native-turn'].includes(caseId)) {
    return executeManagedAmplifier(harness, sources, caseId, serverPath, servers)
  }
  if (!['freshclaude', 'kilroy'].includes(selection.mode ?? '')
    || !['create', 'exact-resume', 'current-native-turn', 'allow', 'deny', 'changed-tool', 'missing-tool',
      'changed-input', 'changed-profile', 'changed-root', 'stale-callback', 'crash-before-checkpoint',
      'multiple-tools', 'effect-before-observation', 'wrong-id', 'missing-native-id', 'placeholder-id', 'disabled-hooks',
      'timeout-50s', 'provider-exit', 'stop-cancellation', 'restoration-failure-after-hook'].includes(caseId)) {
    throw new Error(`actual native case has no qualified execution path: ${selection.mode ?? selection.provider}/${caseId}`)
  }
  const wrongId = caseId === 'wrong-id'
  const restorationFailure = caseId === 'restoration-failure-after-hook'
  const forkSource = sources.find(file => file.name === 'claude/native-fault/sdk-resume-fork.json')
  let sdkForkImage: any
  if (forkSource) {
    sdkForkImage = JSON.parse(fs.readFileSync(forkSource.path, 'utf8'))
    if (sdkForkImage.kind !== 'owned-sdk-resume-fork-fault-image' || sdkForkImage.imageDigest !== harness.imageRef
      || sdkForkImage.originalExecutableSha256 !== '73975167f0108693cf6fd6614994781657ebb8456ebef5d247458734abfb3916'
      || sdkForkImage.wrapperSha256 !== createHash('sha256').update(nativeSdkResumeForkWrapper).digest('hex')) {
      throw new Error('owned SDK native resume-fork fault image binding differs')
    }
  }
  if ((wrongId || restorationFailure) && !sdkForkImage) throw new Error('owned SDK native resume-fork fault image required')
  const fieldFault = ['missing-native-id', 'placeholder-id'].includes(caseId)
  const fieldSource = sources.find(file => file.name === 'claude/native-fault/sdk-init-fields.json')
  let sdkFieldImage: any
  if (fieldSource) {
    sdkFieldImage = JSON.parse(fs.readFileSync(fieldSource.path, 'utf8'))
    const publisher = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../crates/freshell-claude-sidecar/index.mjs'), 'utf8')
    if (sdkFieldImage.kind !== 'owned-sdk-native-init-field-fault-image' || sdkFieldImage.imageDigest !== harness.imageRef
      || sdkFieldImage.originalExecutableSha256 !== '73975167f0108693cf6fd6614994781657ebb8456ebef5d247458734abfb3916'
      || sdkFieldImage.sdkVersion !== '0.3.237'
      || sdkFieldImage.originalPublisherSha256 !== createHash('sha256').update(publisher).digest('hex')
      || sdkFieldImage.patchedPublisherSha256 !== createHash('sha256').update(stageSdkInitFieldFault(publisher)).digest('hex')) {
      throw new Error('owned SDK native init-field fault image binding differs')
    }
  }
  if (fieldFault && !sdkFieldImage) throw new Error('owned SDK native init-field fault image required')
  const mode = selection.mode!
  const logicalProvider = mode === 'kilroy' ? 'kilroy' : 'claude'
  const family = 'claude'
  const references = (['env_file', 'ca_file'] as const).map((suffix) => {
    const source = sources.find((file) => file.name === `${family}/grants/${suffix}`)
    if (!source) throw new Error(`selected ${family} ${suffix} reference missing`)
    return { sourcePath: source.path, profile: suffix === 'env_file' ? 'claude_onecli_environment' : 'claude_onecli_ca_file' }
  })
  const scenario = `${mode}-${caseId}`
  const supervisor = await harness.startSupervisor({ scenarioId: scenario, binaryKind: 'release' })
  if (sdkForkImage) {
    const actual = JSON.parse(await harness.execOwnedContainerExact(supervisor.containerId, ['python3', '-c', String.raw`
import pathlib,hashlib,json
base=pathlib.Path('/opt/freshell-claude-sidecar/node_modules/@anthropic-ai')
file=base/'claude-agent-sdk-linux-x64/claude'
print(json.dumps({'wrapperSha256':hashlib.sha256(file.read_bytes()).hexdigest(),'originalExecutableSha256':hashlib.sha256(pathlib.Path(str(file)+'.native').read_bytes()).hexdigest(),'sdkVersion':json.loads((base/'claude-agent-sdk/package.json').read_text())['version']}))
`]))
    harness.writeArtifact(`${scenario}-sdk-fault-image-private.json`, actual)
    if (actual.wrapperSha256 !== sdkForkImage.wrapperSha256 || actual.originalExecutableSha256 !== sdkForkImage.originalExecutableSha256
      || actual.sdkVersion !== '0.3.237') throw new Error('actual SDK native fault image differs before input')
  }
  if (sdkFieldImage) {
    const actual = JSON.parse(await harness.execOwnedContainerExact(supervisor.containerId, ['python3', '-c', String.raw`
import pathlib,hashlib,json
base=pathlib.Path('/opt/freshell-claude-sidecar')
print(json.dumps({'patchedPublisherSha256':hashlib.sha256((base/'index.mjs').read_bytes()).hexdigest(),'sdkVersion':json.loads((base/'node_modules/@anthropic-ai/claude-agent-sdk/package.json').read_text())['version']}))
`]))
    harness.writeArtifact(`${scenario}-sdk-init-field-image-private.json`, actual)
    if (actual.patchedPublisherSha256 !== sdkFieldImage.patchedPublisherSha256 || actual.sdkVersion !== '0.3.237') {
      throw new Error('actual SDK native init-field fault image differs before input')
    }
  }
  const workspace = path.join(harness.testRoot, scenario + '-workspace')
  fs.mkdirSync(workspace, { mode: 0o770 }); fs.chmodSync(workspace, 0o770)
  if (caseId === 'crash-before-checkpoint' || caseId === 'effect-before-observation') {
    const directory = path.join(workspace, '.claude'); fs.mkdirSync(directory, { mode: 0o770 }); fs.chmodSync(directory, 0o770)
    const afterEffect = caseId === 'effect-before-observation'
    const hook = path.join(directory, afterEffect ? 'pause-after-effect.py' : 'pause-before-checkpoint.py')
    const signal = path.join(workspace, afterEffect ? 'native-after-effect-before-observation.json' : 'native-before-checkpoint.json')
    const settings = { hooks: { [afterEffect ? 'PostToolUse' : 'PreToolUse']: [{ matcher: 'Bash', hooks: [{ type: 'command',
      command: `python3 '${hook}' '${signal}'`, timeout: 60 }] }] } }
    fs.writeFileSync(hook, "import sys,json,pathlib,time\nvalue=json.load(sys.stdin)\np=pathlib.Path(sys.argv[1])\np.write_text(json.dumps(value))\ntime.sleep(45)\nprint('{}')\n", { mode: 0o660 })
    fs.chmodSync(hook, 0o660)
    fs.writeFileSync(path.join(directory, 'settings.json'), JSON.stringify(settings), { mode: 0o660 })
    fs.chmodSync(path.join(directory, 'settings.json'), 0o660)
  }
  const startupFault = ['missing-native-id', 'placeholder-id', 'disabled-hooks', 'timeout-50s', 'provider-exit', 'stop-cancellation'].includes(caseId)
  if (startupFault && !fieldFault) {
    const local = path.join(workspace, '.claude'); fs.mkdirSync(local, { mode: 0o770 }); fs.chmodSync(local, 0o770)
    const file = path.join(local, 'settings.json')
    fs.writeFileSync(file, JSON.stringify({ disableAllHooks: true }), { mode: 0o660 }); fs.chmodSync(file, 0o660)
  }
  if (fieldFault) {
    const control = path.join(workspace, 'native-init-field-fault-control.json')
    fs.writeFileSync(control, JSON.stringify({ mode, caseId }), { mode: 0o660 }); fs.chmodSync(control, 0o660)
  }
  if (wrongId || restorationFailure) {
    const local = path.join(workspace, '.claude'); fs.mkdirSync(local, { mode: 0o770 }); fs.chmodSync(local, 0o770)
    const file = path.join(workspace, wrongId ? 'native-sdk-fork-observer.mjs' : 'native-sdk-restoration-observer.mjs')
    const hook = (wrongId ? terminalForkFaultHook : sdkRestorationFaultHook)
      .replace('/usr/local/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe',
        '/opt/freshell-claude-sidecar/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude' + (sdkForkImage ? '.native' : ''))
    fs.writeFileSync(file, hook, { mode: 0o660 }); fs.chmodSync(file, 0o660)
    const selected = path.join(local, 'settings.json')
    fs.writeFileSync(selected, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command',
      command: "node '" + file.replaceAll("'", "'\\''") + "'" }] }] } }), { mode: 0o660 }); fs.chmodSync(selected, 0o660)
  }
  const soulId = 'soul-' + randomUUID()
  const storeId = 'store-' + randomUUID()
  const settings = { model: 'claude-haiku-4-5-20251001', effort: 'low', permissionMode: 'default' }
  const request = { method: 'launch', params: { soulId, provider: logicalProvider, providerStoreId: storeId,
    creationSeedRef: 'native-create-' + randomUUID(), profile: 'custom', projectKey: scenario,
    limits: { cpuMilli: 2000, memoryBytes: 2 * 1024 ** 3, swapBytes: 0, pidsMax: 256 },
    freshAgent: { sessionId: 'native-fresh-' + randomUUID(), provider: logicalProvider,
      sessionType: mode, runtimeVariant: 'claude-sdk-sidecar', providerStoreId: storeId,
      cwd: workspace, workspacePath: workspace, runAsUid: 65534, runAsGid: 0, ...settings,
      providerSecretReferences: references, providerLaunchContext: { preparation: { claude: { mcp_args: [] } }, config: [] } } } }
  harness.writeArtifact(`${scenario}-request.json`, request)
  if (startupFault) return executeManagedFreshStartupFault(harness, supervisor, request, caseId, scenario, settings, !!sdkForkImage)
  const launch = await harness.adminOk(supervisor, request)
  harness.writeArtifact(`${scenario}-launch.json`, launch)
  const view = launch.data.view
  const observation = view.nativeIdentityObservation
  const assertions: { name: string; pass: boolean }[] = [{ name: 'actual-current-native-observation-before-input',
    pass: view.recoveryState === 'live' && !!observation && observation.nativeSessionId === view.nativeSessionId
      && observation.incarnationId === view.incarnationId && observation.source === 'fresh_provider_handshake' }]
  if (view.recoveryState !== 'live' || !observation || observation.nativeSessionId !== view.nativeSessionId
    || observation.incarnationId !== view.incarnationId || observation.source !== 'fresh_provider_handshake') {
    throw new Error('current managed native startup observation missing')
  }
  const inspect = async (containerId: string, label: string, requireTranscript: boolean) => {
    const metadata = JSON.parse(await harness.execOwnedContainerAsExact(containerId, '65534:0',
      ['python3', '-c', claudeNativeInspection, view.nativeSessionId, String(requireTranscript), 'fresh', 'ordinary', ...(sdkForkImage ? ['sdk-fork-image'] : [])]))
    if (caseId === 'current-native-turn') retainOwnedNativeProbe(metadata, containerId)
    harness.writeArtifact(`${scenario}-${label}-native-private.json`, metadata)
    if (metadata.uid !== 65534 || metadata.gid !== 0 || metadata.caps !== '0000000000000000'
      || !metadata.readOnlyRoot || metadata.httpsStatus !== 200 || metadata.tlsVerifyMode !== 2
      || !metadata.tlsCheckHostname || metadata.nativeRoot !== view.nativeSessionId) {
      throw new Error('actual native namespace/TLS/root differs')
    }
    return metadata
  }
  const namespace = await inspect(view.containerId, 'startup', false)
  harness.writeArtifact(`${scenario}-namespace.json`, namespace)
  if (namespace.uid !== 65534 || namespace.gid !== 0 || !namespace.version.includes('2.1.237')) {
    throw new Error('actual selected native child/UID differs')
  }
  let nativeOriginals: NativeExperimentOriginal['nativeOriginals']
  if (caseId === 'current-native-turn' || caseId === 'exact-resume' || wrongId || restorationFailure) {
    const marker = 'owned-memory-' + randomUUID(), initialObservedAt = Date.now()
    const nativeRequests = new Map<string, NativeOriginalReference>()
    let cursor = 0
    const nativeTurn = async (text: string, label: string): Promise<any[]> => {
      const requestId = 'request-' + randomUUID(), sentAt = Date.now(), body = { method: 'fresh_agent_send', params: { soulId, text } }
      const receipt = await harness.adminOk(supervisor, body, { requestId })
      if (caseId === 'current-native-turn') nativeRequests.set(label, writeNativeOriginal(harness, `${scenario}-${label}-request-original.json`, { requestId, sentAt, request: body, reply: receipt }))
      harness.writeArtifact(`${scenario}-${label}-dispatch.json`, receipt)
      const events: any[] = []
      const batches: unknown[] = []
      const deadline = Date.now() + 90_000
      while (Date.now() < deadline) {
        const batch = await harness.adminOk(supervisor, { method: 'fresh_agent_read_events',
          params: { soulId, afterSequence: cursor, maxEvents: 100 } })
        batches.push(batch)
        harness.writeArtifact(`${scenario}-${label}-events-private.json`, batches)
        for (const row of batch.data.events) {
          cursor = Math.max(cursor, row.sequence)
          const event = row.event?.data?.payload?.event
          if (event) events.push(event)
          if (event?.type === 'freshAgent.result') {
            if (event.isError || event.nativeSessionId !== view.nativeSessionId) throw new Error('native turn did not finish on the observed root')
            return events
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      throw new Error('bounded native turn deadline exceeded')
    }
    const seedEvents = await nativeTurn(`Remember this private marker: ${marker}. Reply stored. Do not use tools.`, 'seed')
    if (seedEvents.some((event) => (event.content ?? []).some((part: any) => part.type === 'tool_use'))) throw new Error('native seed unexpectedly requested a tool')
    const before = await inspect(view.containerId, 'before-death', true)
    const probe = await harness.adminOk(supervisor, harness.probeRecoveryBody(soulId))
    harness.writeArtifact(`${scenario}-store-probe.json`, probe)
    if (probe.data.kind !== 'reattach_ready') throw new Error('completed native store not readable before death')
    if (wrongId || restorationFailure) {
      const bytes = Buffer.from(before.transcript.bytesBase64, 'base64')
      const missingAnchor = restorationFailure ? randomUUID() : undefined
      if (missingAnchor && bytes.toString().trim().split('\n').some(line => JSON.parse(line).uuid === missingAnchor)) {
        throw new Error('owned native resume anchor unexpectedly exists')
      }
      const control = path.join(workspace, wrongId ? 'native-fork-fault-control.json' : 'native-restoration-fault-control.json')
      fs.writeFileSync(control, JSON.stringify({ root: view.nativeSessionId, missingAnchor, seedBytes: bytes.length,
        seedSha256: before.transcript.sha256, ...(restorationFailure ? { identity: before.transcript.identity.slice(0, 2) } : {}) }), { mode: 0o660 })
      fs.chmodSync(control, 0o660)
    }
    const requestedAt = Date.now()
    await harness.killOwnedRuntimeExact(view.containerId)
    await harness.waitForContainerExit(view.containerId)
    const exitedAt = Date.now()
    const recovery = wrongId || restorationFailure ? await harness.adminRaw(supervisor, harness.recoverBody(soulId, 'host_unreachable'))
      : await harness.adminOk(supervisor, harness.recoverBody(soulId, 'host_unreachable'))
    const replacementObservedAt = Date.now()
    harness.writeArtifact(`${scenario}-recovery.json`, recovery)
    if (wrongId) {
      const observedPath = path.join(workspace, 'native-fork-fault-observation.json')
      const fault = JSON.parse(fs.readFileSync(observedPath, 'utf8'))
      harness.writeArtifact(`${scenario}-fork-current-native-event-private.json`, fault)
      const inventory = await harness.adminOk(supervisor, harness.inventoryBody())
      harness.writeArtifact(`${scenario}-fork-current-inventory.json`, inventory)
      const current = inventory.data.filter((row: any) => row.soulId === soulId)
      const nativeFork = fault.native.source === 'fork' && fault.native.session_id !== view.nativeSessionId
        && fault.launch.requestedNativeSessionId === view.nativeSessionId
        && fault.launch.incarnationId !== view.incarnationId && fault.launch.launchNonce !== namespace.hook.launch.launchNonce
        && fault.uid === 65534 && fault.gid === 0 && fault.nativeExecutableSha256 === namespace.executableSha256
        && fault.nativeArgv.includes('--fork-session') && nativeResumeRootInArgv(fault.nativeArgv, view.nativeSessionId)
      const retained = fault.originalPrefixSha256 === before.transcript.sha256
        && JSON.stringify(fault.identity) === JSON.stringify(before.transcript.identity.slice(0, 2))
      const blocked = recovery.result?.Ok?.data?.outcome === 'blocked' && current.length > 0
        && current.every((row: any) => row.launchState !== 'running' && row.nativeIdentityObservation?.incarnationId !== fault.launch.incarnationId)
      if (!nativeFork || !retained || !blocked) throw new Error('genuine SDK native wrong root was not contained before input')
      const input = await harness.adminRaw(supervisor, { method: 'fresh_agent_send', params: { soulId, text: 'Owned refused native fork probe. Do not use tools.' } })
      harness.writeArtifact(`${scenario}-fork-input-refusal.json`, input)
      if (!input.result?.Err) throw new Error('genuine SDK native wrong root admitted input')
      assertions.push({ name: 'actual-sdk-exact-resume-selected-different-native-root', pass: nativeFork },
        { name: 'original-native-root-volume-file-and-eof-retained', pass: retained },
        { name: 'different-native-root-blocked-running-observation-and-input', pass: blocked && !!input.result.Err })
    } else if (restorationFailure) {
      const file = path.join(workspace, 'native-restoration-fault-observation.json'), deadline = Date.now() + 6_000
      while (!fs.existsSync(file) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50))
      const fault = JSON.parse(fs.readFileSync(file, 'utf8'))
      harness.writeArtifact(`${scenario}-restoration-fault-private.json`, fault)
      const inventory = await harness.adminOk(supervisor, harness.inventoryBody())
      harness.writeArtifact(`${scenario}-after-restoration-failure-inventory.json`, inventory)
      const current = inventory.data.filter((row: any) => row.soulId === soulId)
      const contained = recovery.result?.Ok?.data?.outcome === 'blocked' && current.length > 0
        && current.every((row: any) => row.launchState !== 'running'
          && row.nativeIdentityObservation?.incarnationId !== fault.hook.launch.incarnationId)
      const currentHook = fault.hook.native.source === 'resume' && fault.hook.native.session_id === view.nativeSessionId
        && fault.hook.launch.requestedNativeSessionId === view.nativeSessionId
        && fault.hook.launch.launchNonce !== namespace.hook.launch.launchNonce && fault.hook.launch.incarnationId !== view.incarnationId
      const control = JSON.parse(fs.readFileSync(path.join(workspace, 'native-restoration-fault-control.json'), 'utf8'))
      const ownedFault = fault.originalPrefixSha256 === before.transcript.sha256
        && JSON.stringify(fault.identity) === JSON.stringify(before.transcript.identity.slice(0, 2))
        && fault.missingAnchor === control.missingAnchor && fault.nativeArgv.includes('--resume-session-at=' + control.missingAnchor)
        && nativeResumeRootInArgv(fault.nativeArgv, view.nativeSessionId)
        && fault.uid === 65534 && fault.gid === 0 && fault.nativeExecutableSha256 === namespace.executableSha256
      if (!contained || !currentHook || !ownedFault || fault.nativeExited !== true) {
        throw new Error('actual SDK native hook/restoration failure was not contained before input')
      }
      const input = await harness.adminRaw(supervisor, { method: 'fresh_agent_send', params: { soulId, text: 'Owned failed restoration probe. Do not use tools.' } })
      harness.writeArtifact(`${scenario}-after-restoration-failure-input-refusal.json`, input)
      if (!input.result?.Err) throw new Error('actual SDK native restoration failure admitted input')
      assertions.push({ name: 'genuine-current-sdk-resume-hook-before-native-restoration-failure', pass: currentHook && ownedFault },
        { name: 'native-restoration-exit-without-running-or-observed-identity', pass: contained && fault.nativeExited === true },
        { name: 'failed-sdk-native-restoration-refuses-ordinary-input', pass: !!input.result.Err })
    } else {
      if (recovery.data.outcome !== 'replaced' || recovery.data.view.nativeSessionId !== view.nativeSessionId
        || recovery.data.view.incarnationId === view.incarnationId || !recovery.data.view.nativeIdentityObservation
        || recovery.data.view.recoveryState !== 'live') throw new Error('native exact-root replacement failed')
      const after = await inspect(recovery.data.view.containerId, 'after-death', true)
      if (before.transcript.sha256 !== after.transcript.sha256 || before.transcript.identity[0] !== after.transcript.identity[0]
        || before.transcript.identity[1] !== after.transcript.identity[1]) throw new Error('native transcript lost original owned volume/file continuity')
      assertions.push({ name: 'readable-completed-native-store-before-death', pass: probe.data.kind === 'reattach_ready' },
        { name: 'replacement-new-incarnation-same-native-root', pass: recovery.data.outcome === 'replaced'
          && recovery.data.view.incarnationId !== view.incarnationId && recovery.data.view.nativeSessionId === view.nativeSessionId
          && recovery.data.view.nativeIdentityObservation.nativeSessionId === view.nativeSessionId },
        { name: 'original-owned-volume-transcript-continuity', pass: before.transcript.sha256 === after.transcript.sha256
          && before.transcript.identity[0] === after.transcript.identity[0] && before.transcript.identity[1] === after.transcript.identity[1] },
        { name: 'same-workspace-selected-native-profile', pass: JSON.stringify(before.profileFiles) === JSON.stringify(after.profileFiles) })
      if (caseId === 'current-native-turn') {
        const recalled = await nativeTurn('Reply with only the private marker from before. Do not use tools.', 'recall')
        const text = recalled.flatMap((event) => event.content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('').trim()
        if (text !== marker) throw new Error('native restored context did not recall the private marker')
        if (recalled.some((event) => (event.content ?? []).some((part: any) => part.type === 'tool_use'))) throw new Error('native recall unexpectedly requested a tool')
        const recalledStore = await inspect(recovery.data.view.containerId, 'recall-completed', true)
        nativeOriginals = retainFamilyNativeTurnOriginals(harness, { scenario, mode: mode as 'freshclaude' | 'kilroy', provider: 'claude', launchRequest: request, nonce: marker, requestedAt, exitedAt, initial: { view, namespace, capture: before, observedAt: initialObservedAt, request: nativeRequests.get('seed')!, snapshotPath: before.hook.native.transcript_path }, replacement: { view: recovery.data.view, namespace: recalledStore, capture: recalledStore, observedAt: replacementObservedAt, request: nativeRequests.get('recall')!, snapshotPath: recalledStore.hook.native.transcript_path } })
        assertions.push({ name: 'actual-restored-context-private-marker-recall', pass: text === marker },
          { name: 'native-turns-requested-no-tools', pass: ![...seedEvents, ...recalled].some((event) =>
            (event.content ?? []).some((part: any) => part.type === 'tool_use')) })
      } else {
        assertions.push({ name: 'current-native-resume-observation-before-replacement-input', pass:
          after.hook.native.source === 'resume' && after.hook.native.session_id === view.nativeSessionId
          && recovery.data.view.nativeIdentityObservation.incarnationId === recovery.data.view.incarnationId })
      }
    }
  }
  if (selection.case === 'approval-checkpoint') {
    assertions.push(...await executeManagedNativeApproval({ harness, supervisor, soulId, workspace,
      view, scenario, decision: caseId, inspect }))
  }
  const profileSha256 = createHash('sha256').update(JSON.stringify({ settings, nativeProfile: namespace.profileFiles })).digest('hex')
  const original = { caseId, ownerId: harness.runId, candidateSha: harness.candidateSha,
    imageDigest: harness.imageRef, nativeVersion: namespace.version, executableSha256: namespace.executableSha256,
    profileSha256, artifactReferences: [`${scenario}-launch.json`, `${scenario}-namespace.json`, ...(nativeOriginals ? [nativeOriginals.reference.path] : [])], nativeOriginals,
    assertions }
  harness.writeArtifact(`${scenario}-original.json`, original)
  return original
}

function openCodeTuiHostStatusScript(): string {
  return amplifierNativeHostStatus
    .replace('amplif-[a-f0-9]{8}', 'openco-[a-f0-9]{8}')
    .replace("'nativeSessionId':data.get('native_session_id'),", "'opencodeAdoption':data.get('opencode_adoption'),'nativeSessionId':data.get('native_session_id'),")
}

async function executeManagedOpenCodeTui(harness: RuntimeHarness,
  sources: { name: string; path: string; sha256: string }[], caseId: string, serverPath?: string,
  servers: { server: import('../../test/e2e-browser/helpers/rust-server.js').RustServer; scope: string; pid?: number }[] = []): Promise<NativeExperimentOriginal> {
  const replacementFault = caseId === 'baseline-only-resume' || caseId === 'stale-observation'
  const requiresController = replacementFault || caseId === 'current-native-turn'
  if (requiresController && !serverPath) throw new Error('actual native OpenCode replacement requires the owned real server artifact')
  const stageSource = sources.find(file => file.name === 'opencode/native-preparation/transfer-stage.bin')
  if (!stageSource) throw new Error('selected OpenCode native transfer stage required')
  if (!['null-slot', 'v1-empty', 'v2-empty-is-not-v1-empty', 'full-revert', 'part-revert', 'disposal', 'cancellation', 'root-load-error', 'history-load-error', 'baseline-only-resume', 'stale-observation', 'current-native-turn'].includes(caseId)) {
    throw new Error(`actual native OpenCode TUI case has no qualified execution path: ${caseId}`)
  }
  const scenario = `opencode-${caseId}`
  const tuiObserver = ['disposal', 'root-load-error', 'history-load-error', 'baseline-only-resume', 'stale-observation'].includes(caseId)
  const source = prepareOwnedOpenCodeTuiSource(harness.repoRoot, harness.testRoot, caseId, harness.runId + '-' + caseId)
  const digest = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex')
  const stage = path.join(harness.testRoot, scenario + '-transfer-stage')
  fs.copyFileSync(stageSource.path, stage)
  fs.chmodSync(stage, 0o555)
  const schema = path.join(harness.repoRoot, 'crates/freshell-sessions/src/opencode_schema_v1_18_21.sql')
  const migrationSource = fs.readFileSync(path.join(harness.repoRoot, 'crates/freshell-sessions/src/opencode_transfer.rs'), 'utf8')
  const migrationRegistry = migrationSource.match(/const PINNED_MIGRATIONS: &\[&str\] = &\[([\s\S]*?)\];/)
  if (!migrationRegistry) throw new Error('actual pinned native migration registry unavailable')
  const migrations = path.join(harness.testRoot, scenario + '-migrations.json')
  fs.writeFileSync(migrations, JSON.stringify([...migrationRegistry[1]!.matchAll(/"([^"]+)"/g)].map(row => row[1])), { mode: 0o644 })
  fs.chmodSync(migrations, 0o644)
  const soulId = 'soul-' + randomUUID()
  harness.writeArtifact(`${scenario}-source-metadata.json`, { rootSessionId: source.rootId,
    sourceBytes: fs.statSync(source.databasePath).size, sourceSha256: digest(fs.readFileSync(source.databasePath)),
    synthetic: true, modelInputs: 0, sourceOnly: true, beforeExport: true })
  const provider = harness.startTransferProvider(stage, schema, migrations, [source.workspace])
  await harness.copyTransferFileExact(provider.containerId, source.databasePath, '/scratch/source.bin')
  harness.writeTransferRequest(provider.containerId, 'native-export-request.json', {
    candidateSha: harness.candidateSha, imageDigest: harness.imageRef, sourceDatabase: '/scratch/source.bin',
    rootSessionId: source.rootId, extractionRoot: '/scratch/extractions', workspacePath: source.workspace,
    descriptorFile: '/scratch/native-descriptor.json', payloadFile: '/scratch/native-payload.json',
    destinationStoreId: soulId, destinationDatabase: '/scratch/destination.db', providerHome: '/scratch/provider',
    providerUid: 65534, providerGid: 0, receiptFile: '/scratch/native-export-receipt.json',
  })
  const exported = JSON.parse(harness.execTransferProviderExact(provider.containerId,
    ['/opt/transfer-stage', '--stage', 'export', '--request-file', '/scratch/native-export-request.json']))
  harness.writeArtifact(`${scenario}-export.json`, exported)
  const descriptorFile = path.join(harness.evidenceDir, scenario + '-descriptor-original.json')
  const payloadFile = path.join(harness.evidenceDir, scenario + '-payload-original.json')
  await harness.captureTransferFileExact(provider.containerId, '/scratch/native-descriptor.json', descriptorFile)
  await harness.captureTransferFileExact(provider.containerId, '/scratch/native-payload.json', payloadFile)
  const descriptor = JSON.parse(fs.readFileSync(descriptorFile, 'utf8'))
  descriptor.transferId = 'opencode-transfer-' + randomUUID()
  descriptor.incarnationId = 'incarnation-' + randomUUID()
  const sourceHome = path.join(harness.testRoot, 'native-source', 'opencode', scenario)
  fs.mkdirSync(path.join(sourceHome, '.config/opencode'), { recursive: true, mode: 0o700 })
  const terminalId = 'terminal-' + randomUUID()
  if (tuiObserver) {
    const observer = path.join(source.workspace, 'native-tui-disposal-observer.mjs')
    fs.writeFileSync(observer, openCodeTuiDisposalObserver, { mode: 0o644 }); fs.chmodSync(observer, 0o644)
    const control = path.join(source.workspace, 'native-tui-fault-control.json')
    fs.writeFileSync(control, JSON.stringify({ schemaVersion: 1, caseId, terminalId, rootSessionId: source.rootId }), { mode: 0o644 })
    fs.chmodSync(control, 0o644)
    const config = path.join(sourceHome, '.config/opencode/tui.json')
    fs.writeFileSync(config, JSON.stringify({ plugin: ['file://' + observer] }), { mode: 0o600 })
  }
  const supervisor = await harness.startSupervisor({ scenarioId: scenario, binaryKind: 'release', env: { HOME: sourceHome } })
  const transfer = (action: any) => harness.adminOk(supervisor, { method: 'open_code_transfer', params: action })
  const attempt = randomUUID().replaceAll('-', '')
  await transfer({ action: 'begin', data: { descriptor, attempt_id: attempt } })
  const payload = fs.readFileSync(payloadFile)
  let sequence = 0
  for (let offset = 0; offset < payload.length; offset += 262144) {
    const bytes = payload.subarray(offset, Math.min(offset + 262144, payload.length))
    await transfer({ action: 'chunk', data: { transferId: descriptor.transferId, attemptId: attempt,
      sequence: sequence++, fileIndex: 0, offset, data: bytes.toString('base64'), sha256: digest(bytes) } })
  }
  harness.writeArtifact(`${scenario}-staged.json`, await transfer({ action: 'finalize', data: { transfer_id: descriptor.transferId, attempt_id: attempt } }))
  const references = ['env_file', 'auth_file', 'ca_file'].map(suffix => {
    const selected = sources.find(file => file.name === 'opencode/grants/' + suffix)
    if (!selected) throw new Error('selected OpenCode native grant reference missing')
    return { sourcePath: selected.path, profile: 'opencode_onecli_' + (suffix === 'env_file' ? 'environment' : suffix) }
  })
  let managedPreparation: any
  if (requiresController && serverPath) {
    const { RustServer } = await import('../../test/e2e-browser/helpers/rust-server.js')
    const server = new RustServer({ homeDir: sourceHome, preserveHomeOnStop: true,
      env: { FRESHELL_BIND_HOST: '0.0.0.0', FRESHELL_MANAGED_RUNTIME_V1: '1',
        FRESHELL_RUNTIME_CONTROL_SOCKET: supervisor.controlSocket,
        FRESHELL_RUNTIME_CONTROL_SECRET_FILE: supervisor.controlSecretFile,
        FRESHELL_MANAGED_OPENCODE_ONECLI_ENV_FILE: references[0]!.sourcePath,
        FRESHELL_MANAGED_OPENCODE_ONECLI_AUTH_FILE: references[1]!.sourcePath,
        FRESHELL_MANAGED_OPENCODE_ONECLI_CA_FILE: references[2]!.sourcePath },
      stripEnvPrefixes: ['GEMINI_', 'GOOGLE_API_KEY', 'ANTHROPIC_', 'CLAUDE_', 'OPENAI_', 'LUNAROUTE_'],
      setupHome: async selectedHome => {
        const config = path.join(selectedHome, '.freshell'); fs.mkdirSync(config, { recursive: true, mode: 0o700 })
        fs.writeFileSync(path.join(config, 'config.json'), JSON.stringify({ version: 1, settings: {
          defaultCwd: source.workspace, codingCli: { enabledProviders: ['opencode'], providers: { opencode: { model: 'openai/gpt-5.6-luna' } } },
        } }), { mode: 0o600 })
      } })
    const owned = { server, scope: scenario, pid: undefined as number | undefined }; servers.push(owned)
    const previous = process.env.FRESHELL_E2E_RUST_SERVER_BIN
    process.env.FRESHELL_E2E_RUST_SERVER_BIN = serverPath
    try {
      const info = await server.start(); owned.pid = info.pid
      harness.writeArtifact(`${scenario}-server-private.json`, { ...info, ...server.processEvidence(),
        executableSha256: digest(fs.readFileSync(serverPath)) })
    } finally {
      if (previous === undefined) delete process.env.FRESHELL_E2E_RUST_SERVER_BIN
      else process.env.FRESHELL_E2E_RUST_SERVER_BIN = previous
    }
    managedPreparation = await new Promise((resolve, reject) => {
      const socket = createConnection(path.join(path.dirname(supervisor.controlSocket), 'mcp.sock')), chunks: Buffer[] = []
      socket.setTimeout(5000, () => socket.destroy(new Error('actual OpenCode native capability issue timed out')))
      socket.once('connect', () => socket.end(JSON.stringify({ action: 'issue', controlSecret: supervisor.controlSecret,
        soulId, incarnationId: null, grantId: null, provider: 'opencode', tuiSource: null, workspace: source.workspace, cwd: source.workspace })))
      socket.on('data', (chunk: Buffer) => chunks.push(chunk)); socket.once('error', reject)
      socket.once('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { reject(new Error('actual OpenCode native capability issue failed')) }
      })
    })
    harness.writeArtifact(`${scenario}-managed-preparation-private.json`, managedPreparation)
    if (!managedPreparation.context?.mcpCapability || !managedPreparation.secretReferences?.length) {
      throw new Error('actual OpenCode native managed capability/preparation missing')
    }
  }
  const request = harness.launchBody({ soulId, provider: 'opencode', providerStoreId: soulId,
    nativeSessionId: source.rootId, creationSeedRef: 'owned-native-' + harness.runId,
    projectKey: scenario, profile: 'custom', limits: { cpuMilli: 2000, memoryBytes: 2 * 1024 ** 3, swapBytes: 0, pidsMax: 256 },
    terminal: { env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/home/freshell/provider',
      XDG_DATA_HOME: '/home/freshell/provider/.local/share', XDG_CONFIG_HOME: '/home/freshell/provider/.config',
      OPENCODE_DB: '/home/freshell/provider/.local/share/opencode/opencode.db', TMPDIR: '/run/opencode-tmp',
      ...(tuiObserver ? { OPENCODE_TUI_CONFIG: '/home/freshell/provider/.config/opencode/tui.json' } : {}) },
      terminalId, streamId: 'stream-' + randomUUID(), mode: 'opencode', program: 'opencode',
      args: ['--session', source.rootId, '--model', 'openai/gpt-5.6-luna'], cwd: source.workspace,
      workspacePath: source.workspace, projectKey: scenario, runAsUid: 65534, runAsGid: 0, cols: 100, rows: 30,
      resumeSessionId: source.rootId, opencodeTransfer: descriptor, opencodeTransferAttemptId: attempt,
      providerSecretReferences: managedPreparation?.secretReferences ?? references, providerLaunchContext: managedPreparation?.context ?? {
        preparation: { opencode: { project_config: [], tui_config: null, inline_config: false } },
        config: tuiObserver ? [{ root: 'user_provider', relativePath: 'tui.json',
          providerRelativePath: '.config/opencode/tui.json', format: 'json' }] : [],
      } },
  })
  harness.writeArtifact(`${scenario}-request.json`, request)
  if (caseId === 'disposal' || caseId === 'cancellation' || caseId === 'root-load-error' || caseId === 'history-load-error') {
    return executeManagedOpenCodeTuiPending(harness, supervisor, request, source, scenario, caseId)
  }
  const launch = await harness.adminRaw(supervisor, request)
  harness.writeArtifact(`${scenario}-launch.json`, launch)
  const inventory = await harness.adminOk(supervisor, harness.inventoryBody())
  harness.writeArtifact(`${scenario}-inventory.json`, inventory)
  const view = ManagedRuntimeSoulSchema.parse(inventory.data.find((row: any) => row.soulId === soulId))
  const observation = view.nativeIdentityObservation
  if (launch.result?.Err || view.launchState !== 'running' || view.recoveryState !== 'live' || view.desiredState !== 'running'
    || !view.containerId || !observation || observation.source !== 'opencode_tui'
    || observation.nativeSessionId !== source.rootId || view.nativeSessionId !== source.rootId
    || observation.incarnationId !== view.incarnationId) {
    throw new Error('actual imported native TUI has no current admitted observation')
  }
  const namespace = JSON.parse(await harness.execOwnedContainerAsExact(view.containerId, '65534:0',
    ['python3', '-c', openCodeTuiNativeNamespace, 'opencode', source.rootId, source.workspace]))
  if (caseId === 'current-native-turn') retainOwnedNativeProbe(namespace, view.containerId)
  harness.writeArtifact(`${scenario}-namespace-native-private.json`, namespace)
  if (!receiverNativeNamespaceMatches(namespace, 'opencode', source.workspace, source.rootId)
    || namespace.nativeVersion !== '1.18.21'
    || namespace.executableSha256 !== 'c9485f62576606dbde6404647405df2401fada964b7f669f799dc125dbbeff99'
    || namespace.nativeProcessCwd !== source.workspace || namespace.nativeLaunch.incarnationId !== view.incarnationId
    // The registry's evidence counter can advance on publication. Identity
    // binds the immutable current native launch revision, captured from the
    // actual child, rather than that independent ledger counter.
    || namespace.nativeLaunch.launchNonce !== observation.launchNonce || namespace.nativeLaunch.evidenceRevision !== observation.evidenceRevision
    || namespace.nativeLaunch.executionGeneration !== view.executionGeneration) {
    throw new Error('actual native TUI current namespace/profile/pin/TLS differs')
  }
  const signals = JSON.parse(await harness.execOwnedContainerAsExact(view.containerId, '65534:0', ['python3', '-c', String.raw`
import pathlib,json
directory=pathlib.Path('/home/freshell/provider/.freshell/session-signals/opencode-adoption-diagnostics')
records={}
for file in directory.glob('*.json'):
 if file.is_file() and not file.is_symlink() and file.stat().st_size<=65536:records[file.name]=json.loads(file.read_text())
print(json.dumps(records))
`]))
  harness.writeArtifact(`${scenario}-producer-phases.json`, signals)
  const statusScript = openCodeTuiHostStatusScript()
  const host = JSON.parse(execFileSync('python3', ['-c', statusScript, supervisor.runtimeRoot, view.incarnationId],
    { encoding: 'utf8', timeout: 6000, stdio: ['ignore', 'pipe', 'pipe'] }))
  harness.writeArtifact(`${scenario}-authenticated-host.json`, host)
  const adoption = host.opencodeAdoption?.state === 'observed' ? host.opencodeAdoption.data.observation : null
  if (!adoption || adoption.rootSessionId !== source.rootId || adoption.incarnationId !== view.incarnationId
    || !adoption.hydrated || JSON.stringify(namespace.activeMessageIds) !== JSON.stringify(source.expectedActiveMessageIds)
    || adoption.tailMessageId !== (source.expectedActiveMessageIds.at(-1) ?? null)
    || adoption.messagesRead !== (source.expectedActiveMessageIds.length ? 'success' : 'empty_confirmed')) {
    throw new Error('actual pinned TUI active V1/revert hydration differs from current host evidence')
  }
  if (caseId === 'baseline-only-resume' || caseId === 'stale-observation') {
    return executeManagedOpenCodeTuiReplacementFault(harness, supervisor, request, source, view, namespace, caseId)
  }
  if (caseId === 'current-native-turn') {
    return executeReceiverNativeTurn(harness, supervisor, { mode: 'opencode', provider: 'opencode', terminal: true, scenario, soulId, storeId: soulId, workspace: source.workspace, view, namespace, launchRequest: request, namespaceScript: openCodeTuiNativeNamespace })
  }
  const publication: any = Object.values(signals).find((row: any) => row.stage === 'publication_succeeded')
  const assertion = (name: string, pass: boolean) => ({ name, pass })
  const assertions = [assertion('current-native-tui-observation-before-any-input', observation.incarnationId === view.incarnationId),
    assertion('actual-public-slot-wrapper-registered', publication?.registeredSlotCount === 2),
    assertion('selected-pinned-native-uid-profile-and-normal-tls', receiverNativeNamespaceMatches(namespace, 'opencode', source.workspace, source.rootId))]
  if (caseId === 'v1-empty') assertions.push(assertion('actual-qualified-empty-v1-root', namespace.nativeMessageCount === 0))
  if (caseId === 'null-slot') assertions.push(assertion('actual-native-null-slot-render-wake', Object.values(signals).some((row: any) =>
    row.incarnationId === view.incarnationId && row.registeredSlotCount === 2
      && row.sessionPromptRenderCount + row.sidebarTitleRenderCount > 0)))
  if (caseId === 'v2-empty-is-not-v1-empty') assertions.push(assertion('empty-v2-does-not-replace-loaded-nonempty-v1',
    namespace.nativeMessageCount === 2 && namespace.v2MessageCount === 0 && publication !== undefined))
  if (caseId === 'full-revert' || caseId === 'part-revert') assertions.push(assertion('saved-native-revert-active-tail-hydrated',
    adoption.tailMessageId === source.expectedActiveMessageIds.at(-1)
      && namespace.activeMessageIds.length === (caseId === 'full-revert' ? 1 : 2)))
  const original = { caseId, ownerId: harness.runId, candidateSha: harness.candidateSha, imageDigest: harness.imageRef,
    nativeVersion: namespace.nativeVersion, executableSha256: namespace.executableSha256,
    profileSha256: namespace.profileSha256, artifactReferences: [`${scenario}-launch.json`, `${scenario}-namespace-native-private.json`, `${scenario}-producer-phases.json`], assertions }
  harness.writeArtifact(`${scenario}-original.json`, original)
  return original
}

// Read only the actual managed TUI signal envelopes. The baseline-only
// fault removes these already captured owned receipts; stale keeps their
// original bytes. Neither path writes a provider acknowledgement.
export const openCodeTuiSignalMetadata = String.raw`
import os,pathlib,json,hashlib,re
assert os.getuid()==65534 and os.getgid()==0
home=pathlib.Path('/home/freshell/provider')
def native_signal_metadata(terminal,native_root):
 assert re.fullmatch(r'[A-Za-z0-9_-]+',terminal) and re.fullmatch(r'ses_[A-Za-z0-9]+',native_root)
 directory=home/'.freshell/session-signals/opencode-adoption';records=[]
 for file in sorted(directory.glob(terminal+'__*.json')):
  assert file.is_file() and not file.is_symlink() and file.stat().st_size<=65536
  raw=file.read_bytes();frame=json.loads(raw);observation=frame.get('adoption_observation')
  if not isinstance(observation,dict) or frame.get('source')!='opencode-tui-plugin':continue
  assert frame.get('session_id')==native_root and observation.get('root_session_id')==native_root
  records.append({'name':file.name,'sha256':hashlib.sha256(raw).hexdigest(),'nativeSessionId':native_root,
   'incarnationId':observation.get('incarnation_id'),'launchNonce':observation.get('launch_nonce'),
   'evidenceGeneration':observation.get('evidence_generation'),'hydrated':observation.get('hydrated'),
   'messagesRead':observation.get('messages_read')})
 return records
`

export async function executeManagedOpenCodeTuiReplacementFault(harness: RuntimeHarness,
  supervisor: Awaited<ReturnType<RuntimeHarness['startSupervisor']>>, request: any,
  source: ReturnType<typeof prepareOwnedOpenCodeTuiSource>, view: any, namespace: any,
  caseId: 'baseline-only-resume' | 'stale-observation'): Promise<NativeExperimentOriginal> {
  const scenario = `opencode-${caseId}`, observation = view.nativeIdentityObservation
  const prior = harness.broker.receipts().find(row => row.soulId === request.params.soulId && row.containerId === view.containerId)
  if (!prior?.providerVolumeName || view.launchState !== 'running' || !observation
    || observation.source !== 'opencode_tui' || observation.nativeSessionId !== source.rootId
    || observation.incarnationId !== view.incarnationId || namespace.nativeLaunch.incarnationId !== view.incarnationId
    || observation.launchNonce !== namespace.nativeLaunch.launchNonce || observation.evidenceRevision !== namespace.nativeLaunch.evidenceRevision
    || namespace.nativeLaunch.executionGeneration !== view.executionGeneration
    || namespace.executableSha256 !== 'c9485f62576606dbde6404647405df2401fada964b7f669f799dc125dbbeff99'
    || !receiverNativeNamespaceMatches(namespace, 'opencode', source.workspace, source.rootId)) {
    throw new Error('genuine initial native TUI observation/owned volume required before replacement fault')
  }
  const captured = JSON.parse(await harness.execOwnedContainerAsExact(view.containerId, '65534:0', ['python3', '-c',
    openCodeTuiSignalMetadata + String.raw`
import sys
terminal,root,incarnation,case,workspace=sys.argv[1:];assert case in ['baseline-only-resume','stale-observation']
workspace=pathlib.Path(workspace).resolve();assert re.fullmatch(r'/tmp/f[a-z0-9]+/[a-f0-9-]{12}/opencode-'+case+r'-workspace',str(workspace))
raw_file=workspace/'native-tui-captured-signal.json';metadata_file=workspace/'native-tui-captured-signal-metadata.json'
for file in [raw_file,metadata_file]:assert file.is_file() and not file.is_symlink() and file.stat().st_size<=65536
raw=raw_file.read_bytes();meta=json.loads(metadata_file.read_text());frame=json.loads(raw);observation=frame['adoption_observation']
assert meta['schemaVersion']==1 and meta['terminalId']==terminal and meta['rootSessionId']==root and meta['incarnationId']==incarnation
assert meta['sourceSha256']==hashlib.sha256(raw).hexdigest() and meta['sourceFile'].startswith(terminal+'__')
assert frame['source']=='opencode-tui-plugin' and frame['session_id']==root and observation['root_session_id']==root
assert observation['terminal_id']==terminal and observation['incarnation_id']==incarnation and observation['hydrated'] is True and observation['messages_read']=='success'
records=[{'name':meta['sourceFile'],'sha256':meta['sourceSha256'],'nativeSessionId':root,'incarnationId':incarnation,
 'launchNonce':observation['launch_nonce'],'evidenceGeneration':observation['evidence_generation'],'hydrated':True,'messagesRead':observation['messages_read']}]
removed=0
if case=='baseline-only-resume':
 for row in native_signal_metadata(terminal,root):
  assert row['incarnationId']==incarnation
  (home/'.freshell/session-signals/opencode-adoption'/row['name']).unlink();removed+=1
print(json.dumps({'signals':records,'cleared':case=='baseline-only-resume','removedSignalFiles':removed,'launchNonce':meta['launchNonce'],'nativePid':meta['nativePid']}))
`, request.params.terminal.terminalId, source.rootId, view.incarnationId, caseId, source.workspace]))
  harness.writeArtifact(`${scenario}-original-native-signals.json`, captured)
  if (captured.launchNonce !== namespace.nativeLaunch.launchNonce || captured.nativePid !== namespace.nativePid
    || !Array.isArray(captured.signals) || !captured.signals.length || captured.cleared !== (caseId === 'baseline-only-resume')
    || captured.signals.some((row: any) => row.incarnationId !== view.incarnationId || row.nativeSessionId !== source.rootId
      || row.hydrated !== true || row.messagesRead !== 'success' || !/^[a-f0-9]{64}$/.test(row.sha256 ?? ''))) {
    throw new Error('genuine original native TUI signal capture differs')
  }
  fs.writeFileSync(path.join(source.workspace, 'native-tui-fault-control.json'), JSON.stringify({ schemaVersion: 1,
    caseId, rootSessionId: source.rootId, terminalId: request.params.terminal.terminalId,
    previousIncarnationId: view.incarnationId }), { mode: 0o644 })
  fs.chmodSync(path.join(source.workspace, 'native-tui-fault-control.json'), 0o644)
  await harness.killOwnedRuntimeExact(view.containerId)
  await harness.waitForContainerExit(view.containerId)
  const probe = await harness.adminOk(supervisor, harness.probeRecoveryBody(request.params.soulId))
  harness.writeArtifact(`${scenario}-original-volume-resume-probe.json`, probe)
  const spec = probe.data?.kind === 'resume_ready' ? probe.data.data?.resume_spec : null
  if (spec?.providerSession?.nativeSessionId !== source.rootId
    || spec.opencodeAdoptionBaseline?.descriptor?.rootSessionId !== source.rootId
    || !/^[a-f0-9]{64}$/.test(spec.opencodeAdoptionBaseline.manifestSha256 ?? '')) {
    throw new Error('actual original native store has no verified exact adoption baseline for replacement')
  }
  return executeManagedOpenCodeTuiPending(harness, supervisor, harness.recoverBody(request.params.soulId, 'host_unreachable'),
    source, scenario, caseId, { priorView: view, priorNamespace: namespace, priorVolume: prior.providerVolumeName,
      priorSignals: captured.signals, terminalId: request.params.terminal.terminalId })
}

async function executeManagedOpenCodeTuiPending(harness: RuntimeHarness,
  supervisor: Awaited<ReturnType<RuntimeHarness['startSupervisor']>>, request: any,
  source: ReturnType<typeof prepareOwnedOpenCodeTuiSource>, scenario: string,
  caseId: 'disposal' | 'cancellation' | 'root-load-error' | 'history-load-error' | 'baseline-only-resume' | 'stale-observation',
  replacement?: { priorView: any; priorNamespace: any; priorVolume: string; priorSignals: any[]; terminalId: string }): Promise<NativeExperimentOriginal> {
  const disposal = caseId === 'disposal'
  const loadFault = caseId === 'root-load-error' || caseId === 'history-load-error'
  const observer = disposal || loadFault || !!replacement
  const pendingOutcome = loadFault ? 'disposed_before_store_fault' : 'disposed_before_publication'
  const readObserver = "import pathlib,json,sys;p=pathlib.Path(sys.argv[1])/'native-tui-fault-result.json';assert p.is_file() and not p.is_symlink() and p.stat().st_size<=65536;print(p.read_text())"
  let finished = false, reply: any, failure: unknown, stopped: any
  const pending = harness.adminRaw(supervisor, request).then(value => { reply = value; finished = true },
    error => { failure = error; finished = true })
  const diagnostics: string[] = []
  let namespace: any, report: any, view: any
  let capturedCandidate: { containerId: string; incarnationId: string; executionGeneration: number } | undefined
  try {
    const deadline = Date.now() + 30000
    while (!finished && Date.now() < deadline) {
      const owned = [...harness.broker.receipts()].reverse().find(row => row.soulId === request.params.soulId)
      if (owned) {
        try {
          const inventory = await harness.adminOk(supervisor, harness.inventoryBody())
          view = ManagedRuntimeSoulSchema.parse(inventory.data.find((row: any) => row.soulId === request.params.soulId))
          const publicUnadmitted = replacement
            ? view.incarnationId === replacement.priorView.incarnationId && view.containerId === replacement.priorView.containerId
              && view.launchState === 'stopped' && view.recoveryState === 'recovering'
              && JSON.stringify(view.nativeIdentityObservation) === JSON.stringify(replacement.priorView.nativeIdentityObservation)
              && owned.incarnationId !== replacement.priorView.incarnationId
            : view.launchState === 'starting' && view.containerId === owned.containerId && !view.nativeIdentityObservation
          if (!publicUnadmitted || view.desiredState !== 'running') {
            throw new Error('pending native TUI public projection or owned candidate differs')
          }
          if (observer) {
            report = JSON.parse(await harness.execOwnedContainerAsExact(owned.containerId, '65534:0', ['python3', '-c',
              readObserver, source.workspace]))
            if (report.outcome !== pendingOutcome) throw new Error('supported native TUI disposal was not observed before publication')
          }
          namespace = JSON.parse(await harness.execOwnedContainerAsExact(owned.containerId, '65534:0',
            ['python3', '-c', openCodeTuiNativeNamespace, 'opencode', source.rootId, source.workspace]))
          // Inventory retains the prior incarnation while this candidate waits
          // for native proof. Its receipt and current native launch bind it;
          // the prior public observation never certifies the replacement.
          capturedCandidate = { containerId: owned.containerId, incarnationId: replacement ? owned.incarnationId : view.incarnationId,
            executionGeneration: replacement ? namespace.nativeLaunch.executionGeneration : view.executionGeneration }
          break
        } catch (error) {
          diagnostics.push(error instanceof Error ? error.message : 'owned current disposal capture unavailable')
          if (report && report.outcome !== pendingOutcome) {
            harness.writeArtifact(`${scenario}-supported-disposal.json`, report)
            throw error
          }
        }
      }
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    harness.writeArtifact(`${scenario}-capture-diagnostics-private.json`, diagnostics)
    if (observer) harness.writeArtifact(`${scenario}-supported-disposal.json`, report ?? null)
    harness.writeArtifact(`${scenario}-namespace-native-private.json`, namespace ?? null)
    const candidate = capturedCandidate
    if (!namespace || !view || !candidate || finished || !receiverNativeNamespaceMatches(namespace, 'opencode', source.workspace, source.rootId)
      || namespace.nativeVersion !== '1.18.21'
      || namespace.executableSha256 !== 'c9485f62576606dbde6404647405df2401fada964b7f669f799dc125dbbeff99'
      || namespace.nativeMessageCount !== 2 || namespace.nativeLaunch.incarnationId !== candidate.incarnationId
      || namespace.nativeLaunch.requestedNativeSessionId !== source.rootId
      || !Number.isSafeInteger(candidate.executionGeneration) || candidate.executionGeneration < 1
      || namespace.nativeLaunch.executionGeneration !== candidate.executionGeneration
      || (observer && (report.incarnationId !== candidate.incarnationId || report.launchNonce !== namespace.nativeLaunch.launchNonce
        || report.nativePid !== namespace.nativePid || report.nativeSessionId !== source.rootId
        || report.nativeMessageCount !== 2 || report.producerActive !== false))) {
      throw new Error('actual pending TUI native namespace/current binding differs')
    }
    // Capture the unadmitted native store before Stop. Input serializes with
    // the launch, so first cancel that wait through the ordinary Stop intent.
    harness.writeArtifact(`${scenario}-unadmitted-view-before-stop.json`, view)
    harness.writeArtifact(`${scenario}-owned-candidate-before-stop.json`, candidate)
    let replacementStatus: any
    if (replacement) {
      const currentReceipt = harness.broker.receipts().find(row => row.containerId === candidate.containerId && row.soulId === request.params.soulId)
      if (candidate.incarnationId === replacement.priorView.incarnationId
        || currentReceipt?.providerVolumeName !== replacement.priorVolume
        || JSON.stringify(namespace.activeMessageIds) !== JSON.stringify(replacement.priorNamespace.activeMessageIds)) {
        throw new Error('native TUI replacement changed original volume/root/history or reused incarnation')
      }
      // Keep native volume inspection under the provider UID. Authenticate
      // the host from its existing owner-side private runtime directory.
      const statusScript = openCodeTuiHostStatusScript()
      const staleReplay = caseId === 'stale-observation' ? openCodeTuiSignalMetadata + String.raw`
import sys,time
terminal,native_root,workspace,current_incarnation=sys.argv[1:];workspace=pathlib.Path(workspace).resolve()
assert re.fullmatch(r'/tmp/f[a-z0-9]+/[a-f0-9-]{12}/opencode-stale-observation-workspace',str(workspace))
control=json.loads((workspace/'native-tui-fault-control.json').read_text());assert control['caseId']=='stale-observation'
assert control['terminalId']==terminal and control['rootSessionId']==native_root and control['previousIncarnationId']!=current_incarnation
raw_file=workspace/'native-tui-captured-signal.json';meta_file=workspace/'native-tui-captured-signal-metadata.json'
for file in [raw_file,meta_file]:assert file.is_file() and not file.is_symlink() and file.stat().st_size<=65536
raw=raw_file.read_bytes();meta=json.loads(meta_file.read_text());frame=json.loads(raw);observation=frame['adoption_observation']
assert hashlib.sha256(raw).hexdigest()==meta['sourceSha256'] and meta['incarnationId']==control['previousIncarnationId']
assert frame['source']=='opencode-tui-plugin' and frame['session_id']==native_root and observation['root_session_id']==native_root
assert observation['incarnation_id']==control['previousIncarnationId'] and observation['hydrated'] is True and observation['messages_read']=='success'
assert re.fullmatch(re.escape(terminal)+r'__[A-Za-z0-9_-]+\.json',meta['sourceFile'])
directory=home/'.freshell/session-signals/opencode-adoption';assert directory.is_dir() and not directory.is_symlink()
file=directory/meta['sourceFile'];temporary=directory/(meta['sourceFile']+'.task004-stale.tmp')
assert not file.exists() and not temporary.exists();temporary.write_bytes(raw);temporary.chmod(0o600);temporary.replace(file)
deadline=time.monotonic()+2
while file.exists() and time.monotonic()<deadline:time.sleep(0.01)
replayed={'sha256':hashlib.sha256(raw).hexdigest(),'incarnationId':observation['incarnation_id'],
 'launchNonce':observation['launch_nonce'],'hostConsumed':not file.exists()}
` : ''
      const nativeVolume = JSON.parse(await harness.execOwnedContainerAsExact(candidate.containerId, '65534:0', ['python3', '-c',
        staleReplay + openCodeTuiSignalMetadata + String.raw`
import sys
terminal,native_root,workspace,current_incarnation=sys.argv[1:];projection={'signals':native_signal_metadata(terminal,native_root)}
projection['replayedNativeReceipt']=replayed if 'replayed' in globals() else None
expected_file=home/'.freshell/session-signals/opencode-adoption'/(terminal+'.expected.json')
assert expected_file.is_file() and not expected_file.is_symlink() and expected_file.stat().st_size<=65536
projection['expected']=json.loads(expected_file.read_text());print(json.dumps(projection))
`, replacement.terminalId, source.rootId, source.workspace, candidate.incarnationId]))
      const host = JSON.parse(execFileSync('python3', ['-c', statusScript, supervisor.runtimeRoot, candidate.incarnationId],
        { encoding: 'utf8', timeout: 6000, stdio: ['ignore', 'pipe', 'pipe'] }))
      replacementStatus = { ...nativeVolume, ...host }
      harness.writeArtifact(`${scenario}-authenticated-current-baseline-gate.json`, replacementStatus)
      const expected = replacementStatus.expected
      if (replacementStatus.incarnationId !== candidate.incarnationId || replacementStatus.executionGeneration !== candidate.executionGeneration
        || replacementStatus.exited !== false || replacementStatus.nativeSessionId || replacementStatus.nativeIdentityObservation
        || replacementStatus.opencodeAdoption?.state !== 'awaiting_observation'
        || expected?.root_session_id !== source.rootId || expected.incarnation_id !== candidate.incarnationId
        || expected.launch_nonce !== report.adoptionLaunchNonce || expected.evidence_generation !== report.evidenceGeneration
        || (caseId === 'baseline-only-resume' ? replacementStatus.signals?.length !== 0
          : replacementStatus.signals?.length !== 0 || replacementStatus.replayedNativeReceipt?.hostConsumed !== true
            || replacementStatus.replayedNativeReceipt.sha256 !== replacement.priorSignals[0]?.sha256
            || replacementStatus.replayedNativeReceipt.incarnationId !== replacement.priorView.incarnationId
            || replacementStatus.replayedNativeReceipt.launchNonce !== replacement.priorSignals[0]?.launchNonce
            || replacementStatus.replayedNativeReceipt.launchNonce === expected.launch_nonce)) {
        throw new Error('actual current baseline/native gate accepted missing or stale producer evidence')
      }
    }
    let nativeFault: any
    if (loadFault) {
      fs.writeFileSync(path.join(source.workspace, 'native-tui-fault-release.json'), JSON.stringify({ schemaVersion: 1,
        caseId, rootSessionId: source.rootId, incarnationId: namespace.nativeLaunch.incarnationId,
        launchNonce: namespace.nativeLaunch.launchNonce, evidenceRevision: namespace.nativeLaunch.evidenceRevision,
        executionGeneration: namespace.nativeLaunch.executionGeneration }), { mode: 0o644 })
      fs.chmodSync(path.join(source.workspace, 'native-tui-fault-release.json'), 0o644)
      const deadline = Date.now() + 20000
      while (Date.now() < deadline) {
        nativeFault = JSON.parse(await harness.execOwnedContainerAsExact(view.containerId, '65534:0',
          ['python3', '-c', readObserver, source.workspace]))
        if (nativeFault.outcome !== pendingOutcome) break
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      harness.writeArtifact(`${scenario}-native-read-refusal.json`, nativeFault ?? null)
      const store = nativeFault?.storeFault, refusal = nativeFault?.refusal
      if (nativeFault?.outcome !== 'native_load_error_observed' || nativeFault.caseId !== caseId
        || nativeFault.nativePid !== namespace.nativePid || nativeFault.incarnationId !== view.incarnationId
        || nativeFault.launchNonce !== namespace.nativeLaunch.launchNonce || nativeFault.nativeSessionId !== source.rootId
        || nativeFault.producerActive !== true || store?.caseId !== caseId || store.rootSessionId !== source.rootId
        || store.rootRowsBefore !== 1 || store.messageRowsBefore !== 2 || store.changedRows !== 1 || store.sameDatabaseIdentity !== true
        || (caseId === 'root-load-error' ? store.rootRowsAfter !== 0
          : store.rootRowsAfter !== 1 || store.messageRowsAfter !== 2 || store.malformedMessagesAfter !== 1)
        || refusal?.reason !== (caseId === 'root-load-error' ? 'native_root_load_failed' : 'native_history_load_failed')
        || refusal.nativeSessionId !== source.rootId || refusal.incarnationId !== view.incarnationId
        || typeof report.adoptionLaunchNonce !== 'string' || !report.adoptionLaunchNonce
        || refusal.launchNonce !== report.adoptionLaunchNonce || refusal.evidenceGeneration !== report.evidenceGeneration
        || !/^[a-f0-9]{64}$/.test(refusal.evidenceGeneration ?? '')) {
        throw new Error('actual current pinned native root/history refusal was not established')
      }
      const inventory = await harness.adminOk(supervisor, harness.inventoryBody())
      const refused = ManagedRuntimeSoulSchema.parse(inventory.data.find((row: any) => row.soulId === request.params.soulId))
      harness.writeArtifact(`${scenario}-unadmitted-view-after-fault.json`, refused)
      if (refused.launchState === 'running' || refused.nativeIdentityObservation || refused.incarnationId !== view.incarnationId) {
        throw new Error('actual native load error admitted Running or observed identity')
      }
    }
    stopped = await harness.adminOk(supervisor, harness.stopBody(request.params.soulId))
    await pending
    if (failure) throw failure
    harness.writeArtifact(`${scenario}-launch.json`, reply)
    harness.writeArtifact(`${scenario}-ordinary-stop.json`, stopped)
    const inventory = await harness.adminOk(supervisor, harness.inventoryBody())
    const current = ManagedRuntimeSoulSchema.parse(inventory.data.find((row: any) => row.soulId === request.params.soulId))
    harness.writeArtifact(`${scenario}-current-view.json`, current)
    const canceledCandidate = replacement ? ManagedRuntimeSoulSchema.parse(reply.result?.Ok?.data?.view) : undefined
    const replacementStopped = reply.result?.Ok?.data?.outcome === 'stopped'
      && (reply.result.Ok.data.observedNativeSessionId === undefined || reply.result.Ok.data.observedNativeSessionId === null)
      && canceledCandidate?.incarnationId === candidate.incarnationId && canceledCandidate.containerId === candidate.containerId
      && canceledCandidate.executionGeneration === candidate.executionGeneration && !canceledCandidate.nativeIdentityObservation
      && canceledCandidate.launchState === 'stopped' && canceledCandidate.desiredState === 'stopped'
      && canceledCandidate.recoveryState === 'stopped' && canceledCandidate.cleanupState === 'verified_empty'
      && canceledCandidate.intentRevision === current.intentRevision
    const stoppedPublicBinding = (current.incarnationId === candidate.incarnationId
      && current.executionGeneration === candidate.executionGeneration && !current.nativeIdentityObservation)
      || (!!replacement && current.incarnationId === replacement.priorView.incarnationId
        && current.containerId === replacement.priorView.containerId && current.executionGeneration === replacement.priorView.executionGeneration
        && JSON.stringify(current.nativeIdentityObservation) === JSON.stringify(replacement.priorView.nativeIdentityObservation))
    if (!(replacement ? replacementStopped : loadFault ? ['STALE_INTENT_REVISION', 'RECOVERY_BLOCKED'].includes(reply.result?.Err?.code) : reply.result?.Err?.code === 'STALE_INTENT_REVISION')
      || stopped.data?.outcome !== 'verified_empty'
      || current.launchState !== 'stopped' || current.desiredState !== 'stopped' || current.recoveryState !== 'stopped'
      || current.cleanupState !== 'verified_empty' || !stoppedPublicBinding
      || current.intentRevision <= view.intentRevision) {
      throw new Error('ordinary Stop did not cancel the current unobserved native launch')
    }
    const input = await harness.adminRaw(supervisor, harness.terminalInputBody(request.params.soulId, 'Owned disposed native input probe.\r'))
    harness.writeArtifact(`${scenario}-input-refusal.json`, input)
    if (input.result?.Err?.code !== 'UNKNOWN_SOUL') throw new Error('disposed native TUI admitted ordinary input')
    const original = { caseId, ownerId: harness.runId, candidateSha: harness.candidateSha, imageDigest: harness.imageRef,
      nativeVersion: namespace.nativeVersion, executableSha256: namespace.executableSha256, profileSha256: namespace.profileSha256,
      artifactReferences: [...(replacement ? [`${scenario}-original-native-signals.json`, `${scenario}-original-volume-resume-probe.json`,
        `${scenario}-authenticated-current-baseline-gate.json`] : []), ...(observer ? [`${scenario}-supported-disposal.json`] : []),
        ...(loadFault ? [`${scenario}-native-read-refusal.json`, `${scenario}-unadmitted-view-after-fault.json`] : []), `${scenario}-namespace-native-private.json`,
        `${scenario}-unadmitted-view-before-stop.json`, `${scenario}-owned-candidate-before-stop.json`,
        `${scenario}-input-refusal.json`, `${scenario}-ordinary-stop.json`],
      assertions: [...(replacement ? [{ name: 'actual-new-incarnation-original-volume-and-verified-baseline',
          pass: candidate.incarnationId !== replacement.priorView.incarnationId },
        { name: caseId === 'stale-observation' ? 'genuine-original-native-receipts-refused-in-current-host' : 'verified-baseline-without-native-receipt-remains-unobserved',
          pass: replacementStatus.opencodeAdoption.state === 'awaiting_observation' && !replacementStatus.nativeIdentityObservation }] : []), ...(disposal ? [{ name: 'supported-real-plugin-scope-disposed-before-publication', pass: report.outcome === 'disposed_before_publication' }] : []),
        ...(loadFault ? [{ name: 'actual-pinned-native-current-root-history-read-refusal', pass: nativeFault.outcome === 'native_load_error_observed'
          && nativeFault.refusal.reason === (caseId === 'root-load-error' ? 'native_root_load_failed' : 'native_history_load_failed') }] : []),
        { name: 'actual-native-pinned-current-root-store-and-normal-uid-tls', pass: namespace.nativeMessageCount === 2 },
        { name: 'unobserved-native-startup-never-admits-running-or-input', pass: (replacement
          ? view.launchState === 'stopped' && view.recoveryState === 'recovering' && view.incarnationId === replacement.priorView.incarnationId
          : view.launchState === 'starting' && !view.nativeIdentityObservation)
          && stoppedPublicBinding && input.result.Err.code === 'UNKNOWN_SOUL' },
        { name: loadFault ? 'ordinary-stop-cleans-native-read-refused-startup' : 'ordinary-stop-cancels-current-unobserved-native-startup',
          pass: stopped.data.outcome === 'verified_empty' && (replacement ? replacementStopped : loadFault || reply.result.Err.code === 'STALE_INTENT_REVISION')
            && current.intentRevision > view.intentRevision }] }
    harness.writeArtifact(`${scenario}-original.json`, original)
    return original
  } finally {
    // Every path joins the original owned launch; an inspection failure never
    // abandons a live startup writer or waits out the adoption budget.
    if (!finished) await harness.adminRaw(supervisor, harness.stopBody(request.params.soulId))
    await pending
    harness.writeArtifact(`${scenario}-launch.json`, reply ?? null)
    harness.writeArtifact(`${scenario}-last-view.json`, view ?? null)
    harness.writeArtifact(`${scenario}-capture-diagnostics-private.json`, diagnostics)
  }
}

async function executeManagedReceiverNative(harness: RuntimeHarness,
  sources: { name: string; path: string; sha256: string }[], mode: 'freshcodex' | 'freshopencode' | 'codex', caseId: string, serverPath?: string,
  servers: { server: import('../../test/e2e-browser/helpers/rust-server.js').RustServer; scope: string; pid?: number }[] = []): Promise<NativeExperimentOriginal> {
  const terminal = mode === 'codex'
  if (!terminal && ['wrong-root', 'cancellation'].includes(caseId)) {
    const source = sources.find(file => file.name === `${mode === 'freshcodex' ? 'codex' : 'opencode'}/native-fault/receiver-load.json`)
    if (!source) throw new Error('owned native receiver load-fault image required')
    const image = JSON.parse(fs.readFileSync(source.path, 'utf8'))
    if (image.kind !== 'owned-native-receiver-load-fault-image' || image.imageDigest !== harness.imageRef
      || image.wrapperSha256 !== createHash('sha256').update(nativeReceiverLoadFaultWrapper).digest('hex')
      || image.entrySha256 !== createHash('sha256').update(nativeReceiverLoadFaultEntry).digest('hex')) {
      throw new Error('owned native receiver load-fault image binding differs')
    }
  }
  const requiresController = terminal && ['exact-resume', 'current-native-turn'].includes(caseId)
  if (requiresController && !serverPath) throw new Error('actual terminal recovery requires the owned real server artifact')
  const provider = mode === 'freshcodex' || terminal ? 'codex' : 'opencode', scenario = `${mode}-${caseId}`
  const observationSource = terminal ? 'codex_app_server' : 'fresh_provider_handshake'
  const references = (mode === 'freshopencode' ? [] : ['env_file', 'auth_file', 'ca_file']).map(suffix => {
    const source = sources.find(file => file.name === `${provider}/grants/${suffix}`)
    if (!source) throw new Error(`selected ${provider} ${suffix} reference missing`)
    return { sourcePath: source.path, profile: `${provider}_onecli_${suffix === 'env_file' ? 'environment' : suffix}` }
  })
  const workspace = path.join(harness.testRoot, `${scenario}-workspace`)
  fs.mkdirSync(workspace, { mode: 0o770 }); fs.chmodSync(workspace, 0o770)
  const sourceHome = path.join(harness.testRoot, 'native-source', provider, scenario)
  fs.mkdirSync(path.join(sourceHome, provider === 'codex' ? '.codex' : '.config/opencode'), { recursive: true, mode: 0o700 })
  const supervisor = await harness.startSupervisor({ scenarioId: scenario, binaryKind: 'release', env: { HOME: sourceHome, ...(terminal ? { FRESHELL_MANAGED_PROVIDER_QUALIFICATION: 'codex' } : {}) } })
  const storeId = 'store-' + randomUUID(), soulId = 'soul-' + randomUUID()
  const settings = provider === 'codex'
    ? { model: 'gpt-5.6-luna', effort: 'low', permissionMode: 'on-request', sandbox: 'workspace-write' }
    : { model: 'opencode/big-pickle' }
  const request = { method: 'launch', params: { soulId, provider, providerStoreId: storeId,
    creationSeedRef: 'native-create-' + randomUUID(), profile: 'custom', projectKey: scenario,
    limits: { cpuMilli: 2000, memoryBytes: 2 * 1024 ** 3, swapBytes: 0, pidsMax: 256 },
    freshAgent: { sessionId: 'native-fresh-' + randomUUID(), provider, sessionType: mode,
      runtimeVariant: provider === 'codex' ? 'codex-app-server' : 'opencode-serve', providerStoreId: storeId,
      cwd: workspace, workspacePath: workspace, runAsUid: 65534, runAsGid: 0,
      ...settings,
      providerSecretReferences: references, providerLaunchContext: { preparation: provider === 'codex'
        ? { codex: { tui_args: [], sidecar_args: [] } }
        : { opencode: { project_config: [], tui_config: null, inline_config: false } }, config: [] } } } }
  let managedPreparation: any
  if (requiresController && serverPath) {
    const { RustServer } = await import('../../test/e2e-browser/helpers/rust-server.js')
    const server = new RustServer({ homeDir: sourceHome, preserveHomeOnStop: true,
      env: { FRESHELL_BIND_HOST: '0.0.0.0', FRESHELL_MANAGED_RUNTIME_V1: '1',
        FRESHELL_RUNTIME_CONTROL_SOCKET: supervisor.controlSocket,
        FRESHELL_RUNTIME_CONTROL_SECRET_FILE: supervisor.controlSecretFile,
        FRESHELL_MANAGED_PROVIDER_QUALIFICATION: 'codex',
        FRESHELL_MANAGED_CODEX_ONECLI_ENV_FILE: references[0]!.sourcePath,
        FRESHELL_MANAGED_CODEX_ONECLI_AUTH_FILE: references[1]!.sourcePath,
        FRESHELL_MANAGED_CODEX_ONECLI_CA_FILE: references[2]!.sourcePath },
      stripEnvPrefixes: ['GEMINI_', 'GOOGLE_API_KEY', 'ANTHROPIC_', 'CLAUDE_', 'OPENAI_', 'LUNAROUTE_'],
      setupHome: async selectedHome => {
        const config = path.join(selectedHome, '.freshell'); fs.mkdirSync(config, { recursive: true, mode: 0o700 })
        fs.writeFileSync(path.join(config, 'config.json'), JSON.stringify({ version: 1, settings: {
          defaultCwd: workspace, codingCli: { enabledProviders: ['codex'], providers: { codex: { model: 'gpt-5.6-luna', reasoningEffort: 'low' } } },
        } }), { mode: 0o600 })
      } })
    const owned = { server, scope: scenario, pid: undefined as number | undefined }; servers.push(owned)
    const previous = process.env.FRESHELL_E2E_RUST_SERVER_BIN
    process.env.FRESHELL_E2E_RUST_SERVER_BIN = serverPath
    try {
      const info = await server.start(); owned.pid = info.pid
      harness.writeArtifact(`${scenario}-server-private.json`, { ...info, ...server.processEvidence(),
        executableSha256: createHash('sha256').update(fs.readFileSync(serverPath)).digest('hex') })
    } finally {
      if (previous === undefined) delete process.env.FRESHELL_E2E_RUST_SERVER_BIN
      else process.env.FRESHELL_E2E_RUST_SERVER_BIN = previous
    }
    managedPreparation = await new Promise((resolve, reject) => {
      const socket = createConnection(path.join(path.dirname(supervisor.controlSocket), 'mcp.sock')), chunks: Buffer[] = []
      socket.setTimeout(5_000, () => socket.destroy(new Error('actual native capability issue timed out')))
      socket.once('connect', () => socket.end(JSON.stringify({ action: 'issue', controlSecret: supervisor.controlSecret,
        soulId, incarnationId: null, grantId: null, provider: 'codex', tuiSource: null, workspace, cwd: workspace })))
      socket.on('data', (chunk: Buffer) => chunks.push(chunk)); socket.once('error', reject)
      socket.once('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { reject(new Error('actual native capability issue failed')) }
      })
    })
    harness.writeArtifact(`${scenario}-managed-preparation-private.json`, managedPreparation)
    if (!managedPreparation.context?.mcpCapability || !managedPreparation.secretReferences?.length) {
      throw new Error('actual native managed capability/preparation missing')
    }
  }
  const { freshAgent, ...commonParameters } = request.params
  // The managed host supplies its native pin policy; the ordinary caller
  // selects only the existing model/effort profile.
  const terminalProfileArgs = ['-c', 'model_reasoning_effort="low"']
  const selectedRequest = terminal ? { method: 'launch', params: { ...commonParameters,
    terminal: { terminalId: 'native-terminal-' + randomUUID(), streamId: 'native-stream-' + randomUUID(),
      mode: 'codex', program: 'codex', args: ['--model', settings.model, ...terminalProfileArgs],
      env: { HOME: '/home/freshell/provider', TERM: 'xterm-256color' }, cwd: workspace, workspacePath: workspace,
      runAsUid: 65534, runAsGid: 0, cols: 100, rows: 30, projectKey: scenario,
      providerModel: settings.model, providerReasoningEffort: 'low', providerPermissionMode: 'on-request', providerSandbox: 'workspace-write',
      providerSecretReferences: managedPreparation?.secretReferences ?? references, providerLaunchContext: managedPreparation?.context ?? freshAgent.providerLaunchContext } } } : request
  if (terminal && caseId === 'cancellation') {
    const expectedRoot = randomUUID()
    const faultRequest = { ...selectedRequest, params: { ...selectedRequest.params, nativeSessionId: expectedRoot } }
    harness.writeArtifact(`${scenario}-request.json`, faultRequest)
    let finished = false, reply: any, failure: unknown
    const pending = harness.adminRaw(supervisor, faultRequest).then(value => { reply = value; finished = true },
      error => { failure = error; finished = true })
    const deadline = Date.now() + 6_000, diagnostics: string[] = []
    let view: any, namespace: any, receipt: any
    while (!finished && Date.now() < deadline) {
      try {
        const inventory = await harness.adminOk(supervisor, harness.inventoryBody())
        view = inventory.data.find((row: any) => row.soulId === soulId)
        const owned = harness.broker.receipts().find(row => row.soulId === soulId && row.containerId === view?.containerId)
        if (!view?.incarnationId || !owned) throw new Error('current owned native enclosure not yet allocated')
        const file = path.join(harness.runtimeDir(supervisor, view.incarnationId), 'provider-identity.json')
        receipt = JSON.parse(readCurrentCodexReceipt(file).toString('utf8'))
        if (receipt.schemaVersion !== 1 || receipt.provider !== 'codex' || receipt.ephemeral !== false
          || typeof receipt.nativeSessionId !== 'string' || !receipt.nativeSessionId || receipt.nativeSessionId === expectedRoot) {
          throw new Error('current native root mismatch not observed')
        }
        namespace = JSON.parse(await harness.execOwnedContainerAsExact(view.containerId, '65534:0',
          ['python3', '-c', receiverNativeNamespace, 'codex', receipt.nativeSessionId, workspace]))
        break
      } catch (error) { diagnostics.push(error instanceof Error ? error.message : 'owned native capture unavailable') }
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    harness.writeArtifact(`${scenario}-pre-fault-capture-diagnostics.json`, diagnostics)
    if (!namespace || !view || view.launchState !== 'starting' || view.nativeIdentityObservation
      || !receiverNativeNamespaceMatches(namespace, 'codex', workspace, receipt?.nativeSessionId)) {
      await pending
      if (failure) throw failure
      throw new Error('actual pending native receiver cancellation namespace differs')
    }
    harness.writeArtifact(`${scenario}-pre-stop-native.json`, { namespace, receipt, incarnationId: view.incarnationId })
    // Join already-arrived launch replies before dispatching the fault.
    await new Promise<void>(resolve => setImmediate(resolve))
    if (finished) throw new Error('native receiver startup settled before ordinary Stop')
    const stop = await harness.adminOk(supervisor, harness.stopBody(soulId))
    harness.writeArtifact(`${scenario}-ordinary-stop.json`, stop)
    await pending
    if (failure) throw failure
    harness.writeArtifact(`${scenario}-launch-refusal.json`, reply)
    const inventory = await harness.adminOk(supervisor, harness.inventoryBody())
    const current = inventory.data.find((row: any) => row.soulId === soulId)
    harness.writeArtifact(`${scenario}-current-view.json`, current ?? null)
    if (reply.result?.Err?.code !== 'STALE_INTENT_REVISION' || stop.data?.outcome !== 'verified_empty'
      || current?.launchState !== 'stopped' || current.desiredState !== 'stopped' || current.recoveryState !== 'stopped'
      || current.nativeIdentityObservation) throw new Error('ordinary Stop did not confirm empty stopped native receiver')
    const input = await harness.adminRaw(supervisor, harness.terminalInputBody(soulId, 'Owned stopped input refusal probe. Do not use tools.\r'))
    harness.writeArtifact(`${scenario}-input-refusal.json`, input)
    if (input.result?.Err?.code !== 'UNKNOWN_SOUL') throw new Error('stopped native receiver admitted ordinary input')
    const original: NativeExperimentOriginal = { caseId, ownerId: harness.runId, imageDigest: harness.imageRef,
      candidateSha: harness.candidateSha, nativeVersion: namespace.nativeVersion, executableSha256: namespace.executableSha256,
      profileSha256: createHash('sha256').update(JSON.stringify({ settings, nativeProfileSha256: namespace.profileSha256 })).digest('hex'),
      artifactReferences: [`${scenario}-pre-stop-native.json`, `${scenario}-ordinary-stop.json`, `${scenario}-launch-refusal.json`, `${scenario}-input-refusal.json`],
      assertions: [{ name: 'actual-native-current-root-pending-before-stop', pass: true },
        { name: 'actual-selected-native-process-profile-uid-and-tls', pass: true },
        { name: 'ordinary-stop-cancels-pending-launch-and-confirms-empty-stopped', pass: true },
        { name: 'stopped-native-receiver-refuses-input', pass: true }] }
    harness.writeArtifact(`${scenario}-original.json`, original)
    return original
  }
  if (!terminal && ['wrong-root', 'cancellation'].includes(caseId)) {
    const expectedRoot = provider === 'opencode' ? 'ses_' + randomUUID().replaceAll('-', '') : randomUUID()
    const faultRequest = { ...request, params: { ...request.params, nativeSessionId: expectedRoot,
      freshAgent: { ...freshAgent, nativeSessionId: expectedRoot } } }
    writeOwnedNativeReceiverControl(workspace, 'native-receiver-load-fault-control.json',
      { schemaVersion: 1, mode, caseId, expectedRoot, workspace })
    harness.writeArtifact(`${scenario}-request.json`, faultRequest)
    let finished = false, reply: any, failure: unknown
    const pending = harness.adminRaw(supervisor, faultRequest).then(value => { reply = value; finished = true },
      error => { failure = error; finished = true })
    let stopPending: Promise<void> | undefined, stopReply: any, stopFailure: unknown
    try {
      let receipt: any, namespace: any, view: any
      const diagnostics: string[] = [], allocationStartedAt = Date.now(), allocationDeadline = allocationStartedAt + 6_000
      let nativeCaptureStartedAt: number | undefined
      while (!finished && Date.now() < (nativeCaptureStartedAt === undefined ? allocationDeadline : nativeCaptureStartedAt + 6_000)) {
        const owned = harness.broker.receipts().find(row => row.soulId === soulId)
        if (owned) {
          try {
            const inventory = await harness.adminOk(supervisor, harness.inventoryBody())
            view = inventory.data.find((row: any) => row.soulId === soulId)
            if (!view || view.containerId !== owned.containerId || !view.incarnationId
              || view.launchState !== 'starting' || view.nativeIdentityObservation) throw new Error('actual initial fresh wrong-root publication was not contained')
            nativeCaptureStartedAt ??= Date.now()
            receipt = JSON.parse(await harness.execOwnedContainerAsExact(owned.containerId, '65534:0',
              ['python3', '-c', receiverLoadFaultReceipt, workspace]))
            if (view.incarnationId !== receipt.incarnationId) throw new Error('actual initial fresh wrong-root publication was not contained')
            namespace = JSON.parse(await harness.execOwnedContainerAsExact(owned.containerId, '65534:0',
              ['python3', '-c', receiverNativeNamespace, provider, receipt.nativeSessionId, workspace, mode]))
            break
          } catch (error) { diagnostics.push(error instanceof Error ? error.message : 'current native fault capture unavailable') }
        }
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      harness.writeArtifact(`${scenario}-capture-diagnostics.json`, diagnostics)
      harness.writeArtifact(`${scenario}-capture-phase.json`, { allocationStartedAt, nativeCaptureStartedAt: nativeCaptureStartedAt ?? null,
        captureFinishedAt: Date.now(), phaseBudgetMs: 6_000 })
      harness.writeArtifact(`${scenario}-current-native-receiver.json`, receipt ?? null)
      harness.writeArtifact(`${scenario}-namespace-private.json`, namespace ?? null)
      if (!view || view.launchState !== 'starting' || view.nativeIdentityObservation) {
        await pending
        if (failure) throw failure
        harness.writeArtifact(`${scenario}-launch-refusal.json`, reply)
        throw new Error('actual initial fresh wrong-root publication was not contained')
      }
      if (receipt?.schemaVersion !== 1 || receipt.provider !== provider || receipt.mode !== mode || receipt.caseId !== caseId
        || receipt.expectedRoot !== expectedRoot || receipt.incarnationId !== view.incarnationId
        || typeof receipt.nativeSessionId !== 'string' || !receipt.nativeSessionId || receipt.nativeSessionId === expectedRoot
        || typeof receipt.launchNonce !== 'string' || !receipt.launchNonce
        || receipt.nativeInputDispatches !== 0 || !/^[a-f0-9]{64}$/.test(receipt.nativeEvidenceSha256 ?? '')
        || namespace?.nativeLaunch?.launchNonce !== receipt.launchNonce
        || namespace.nativeLaunch.incarnationId !== receipt.incarnationId
        || namespace.nativeLaunch.requestedNativeSessionId !== expectedRoot) {
        throw new Error('actual current fresh receiver does not prove a different native root')
      }
      if (!receiverNativeNamespaceMatches(namespace, provider, workspace, receipt.nativeSessionId, mode)
        || namespace.executableSha256 !== receipt.executableSha256
        || (provider === 'opencode' && namespace.nativeMessageCount !== 0)) throw new Error('actual native receiver namespace/profile/pin/TLS differs')
      if (caseId === 'cancellation') {
        await new Promise<void>(resolve => setImmediate(resolve))
        if (finished) throw new Error('native receiver startup settled before ordinary Stop')
        stopPending = harness.adminOk(supervisor, harness.stopBody(soulId)).then(value => { stopReply = value }, error => { stopFailure = error })
        const intentDeadline = Date.now() + 1_000
        let stoppedIntent: any
        while (!finished && Date.now() < intentDeadline) {
          const inventory = await harness.adminOk(supervisor, harness.inventoryBody())
          const current = inventory.data.find((row: any) => row.soulId === soulId)
          if (current?.desiredState === 'stopped' && current.launchState === 'stopping'
            && current.cleanupState === 'requested' && current.recoveryState === 'stopped'
            && current.incarnationId === receipt.incarnationId && !current.nativeIdentityObservation) { stoppedIntent = current; break }
          await new Promise(resolve => setTimeout(resolve, 25))
        }
        harness.writeArtifact(`${scenario}-stop-intent-before-response.json`, stoppedIntent ?? null)
        if (!stoppedIntent || finished) throw new Error('ordinary fresh receiver Stop did not commit intent before native response')
      }
      writeOwnedNativeReceiverControl(workspace, 'native-receiver-load-fault-release.json', {
        incarnationId: receipt.incarnationId, launchNonce: receipt.launchNonce,
        nativeSessionId: receipt.nativeSessionId, expectedRoot })
      await pending
      if (failure) throw failure
      if (stopPending) {
        await stopPending
        if (stopFailure) throw stopFailure
        harness.writeArtifact(`${scenario}-ordinary-stop.json`, stopReply)
      }
      harness.writeArtifact(`${scenario}-launch-refusal.json`, reply)
      const inventory = await harness.adminOk(supervisor, harness.inventoryBody())
      const current = inventory.data.find((row: any) => row.soulId === soulId)
      harness.writeArtifact(`${scenario}-current-view.json`, current ?? null)
      const reason = reply.result?.Err?.message
      const nativeRefusal = provider === 'codex'
        ? typeof reason === 'string' && reason.includes('codex thread/resume returned wrong thread id ' + receipt.nativeSessionId)
          && reason.includes('(requested ' + expectedRoot + ')') && reason.includes('refusing to adopt the wrong thread')
        : typeof reason === 'string' && reason.includes('native OpenCode loaded a different or parent-bearing root')
      if (reply.result?.Err?.code !== 'HOST_UNREACHABLE' || !nativeRefusal || !current || current.launchState === 'running'
        || current.nativeIdentityObservation) throw new Error('actual native wrong-root guard did not refuse provider startup')
      if (caseId === 'cancellation' && (stopReply?.data?.outcome !== 'verified_empty' || current.launchState !== 'stopped'
        || current.desiredState !== 'stopped' || current.recoveryState !== 'stopped' || current.cleanupState !== 'verified_empty')) {
        throw new Error('ordinary fresh receiver Stop did not confirm empty stopped intent')
      }
      const input = await harness.adminRaw(supervisor, { method: 'fresh_agent_send', params: { soulId, text: 'Owned wrong-root input refusal probe. Do not use tools.' } })
      harness.writeArtifact(`${scenario}-input-refusal.json`, input)
      if (input.result?.Err?.code !== 'UNKNOWN_SOUL') throw new Error('actual fresh wrong-root admitted input')
      const original: NativeExperimentOriginal = { caseId, ownerId: harness.runId, imageDigest: harness.imageRef,
        candidateSha: harness.candidateSha, nativeVersion: namespace.nativeVersion, executableSha256: namespace.executableSha256,
        profileSha256: createHash('sha256').update(JSON.stringify({ settings, nativeProfileSha256: namespace.profileSha256 })).digest('hex'),
        artifactReferences: [`${scenario}-launch-refusal.json`, `${scenario}-current-native-receiver.json`, `${scenario}-namespace-private.json`, `${scenario}-input-refusal.json`,
          ...(caseId === 'cancellation' ? [`${scenario}-stop-intent-before-response.json`, `${scenario}-ordinary-stop.json`] : [])],
        assertions: [...(caseId === 'cancellation' ? [
          { name: 'ordinary-stop-committed-before-native-response', pass: true },
          { name: 'ordinary-stop-confirms-empty-stopped', pass: true }] : []),
          { name: 'actual-current-native-selected-different-root', pass: true },
          { name: 'actual-native-wrong-root-guard-refused-before-running-and-input', pass: true },
          { name: 'actual-selected-native-process-profile-uid-and-tls-before-refusal', pass: true }] }
      harness.writeArtifact(`${scenario}-original.json`, original)
      return original
    } finally {
      await pending; await stopPending
      if (reply) harness.writeArtifact(`${scenario}-final-launch-reply.json`, reply)
      if (stopReply) harness.writeArtifact(`${scenario}-final-stop-reply.json`, stopReply)
    }
  }
  if (terminal && caseId === 'wrong-root') {
    // A requested root is an expectation only: the native app-server creates
    // its own different thread with no resume selector and no model input.
    const expectedRoot = randomUUID()
    const faultRequest = { ...selectedRequest, params: { ...selectedRequest.params, nativeSessionId: expectedRoot } }
    harness.writeArtifact(`${scenario}-request.json`, faultRequest)
    const launch = await harness.adminRaw(supervisor, faultRequest)
    harness.writeArtifact(`${scenario}-launch-refusal.json`, launch)
    const inventory = await harness.adminOk(supervisor, harness.inventoryBody())
    const view = inventory.data.find((row: any) => row.soulId === soulId)
    harness.writeArtifact(`${scenario}-current-view.json`, view)
    // The legacy root reference is not an observation. Starting and absence
    // of current provider evidence must fence publication and ordinary input.
    if (launch.result?.Err?.code !== 'RECOVERY_BLOCKED' || !view || view.launchState !== 'starting'
      || (view.nativeSessionId && view.nativeSessionId !== expectedRoot) || view.nativeIdentityObservation || !view.incarnationId || !view.containerId) {
      throw new Error('actual initial Codex wrong-root publication was not contained')
    }
    const receiptPath = path.join(harness.runtimeDir(supervisor, view.incarnationId), 'provider-identity.json')
    let raw: Buffer
    try {
      raw = readCurrentCodexReceipt(receiptPath)
    } catch { throw new Error('actual current Codex native receipt unavailable') }
    const receipt = JSON.parse(raw.toString('utf8'))
    if (receipt.schemaVersion !== 1 || receipt.provider !== 'codex' || receipt.ephemeral !== false
      || typeof receipt.nativeSessionId !== 'string' || !receipt.nativeSessionId || receipt.nativeSessionId === expectedRoot
      || !Number.isSafeInteger(receipt.observedAt) || receipt.observedAt < 0) {
      throw new Error('actual current Codex receipt does not prove a different native root')
    }
    harness.writeArtifact(`${scenario}-current-native-receipt.json`, { ...receipt, incarnationId: view.incarnationId,
      sha256: createHash('sha256').update(raw).digest('hex') })
    const namespace = JSON.parse(await harness.execOwnedContainerAsExact(view.containerId, '65534:0',
      ['python3', '-c', receiverNativeNamespace, 'codex', receipt.nativeSessionId, workspace]))
    harness.writeArtifact(`${scenario}-namespace-private.json`, namespace)
    if (!receiverNativeNamespaceMatches(namespace, 'codex', workspace, receipt.nativeSessionId)) {
      throw new Error('actual native receiver namespace/profile/pin/TLS differs')
    }
    const input = await harness.adminRaw(supervisor, harness.terminalInputBody(soulId, 'Owned wrong-root input refusal probe. Do not use tools.\r'))
    harness.writeArtifact(`${scenario}-input-refusal.json`, input)
    if (input.result?.Err?.code !== 'UNKNOWN_SOUL') throw new Error('actual Codex wrong-root admitted input')
    if (!fs.readFileSync(receiptPath).equals(raw)) throw new Error('current native receipt changed after refused input')
    const original: NativeExperimentOriginal = { caseId, ownerId: harness.runId, imageDigest: harness.imageRef,
      candidateSha: harness.candidateSha, nativeVersion: namespace.nativeVersion, executableSha256: namespace.executableSha256,
      profileSha256: createHash('sha256').update(JSON.stringify({ settings, nativeProfileSha256: namespace.profileSha256 })).digest('hex'),
      artifactReferences: [`${scenario}-launch-refusal.json`, `${scenario}-current-native-receipt.json`, `${scenario}-namespace-private.json`, `${scenario}-input-refusal.json`],
      assertions: [{ name: 'actual-current-native-selected-different-root', pass: true },
        { name: 'wrong-current-native-root-refused-before-running-and-input', pass: true },
        { name: 'actual-selected-native-process-profile-uid-and-tls', pass: true }] }
    harness.writeArtifact(`${scenario}-original.json`, original)
    return original
  }
  harness.writeArtifact(`${scenario}-request.json`, selectedRequest)
  const launch = await harness.adminOk(supervisor, selectedRequest)
  harness.writeArtifact(`${scenario}-launch.json`, launch)
  const view = launch.data.view, observation = view.nativeIdentityObservation
  if (view.launchState !== 'running' || view.recoveryState !== 'live' || !view.nativeSessionId
    || observation?.nativeSessionId !== view.nativeSessionId || observation.incarnationId !== view.incarnationId
    || observation.source !== observationSource || !observation.launchNonce
    || !Number.isSafeInteger(observation.evidenceRevision) || observation.evidenceRevision < 0
    || !/^[a-f0-9]{64}$/.test(observation.evidenceDigest ?? '')) {
    throw new Error('current managed native receiver observation missing or misbound before input')
  }
  const namespace = JSON.parse(await harness.execOwnedContainerAsExact(view.containerId, '65534:0',
    ['python3', '-c', receiverNativeNamespace, provider, view.nativeSessionId, workspace, mode]))
  if (caseId === 'current-native-turn') retainOwnedNativeProbe(namespace, view.containerId)
  harness.writeArtifact(`${scenario}-namespace-private.json`, namespace)
  if (!receiverNativeNamespaceMatches(namespace, provider, workspace, view.nativeSessionId, mode)
    || (provider === 'opencode' && namespace.nativeMessageCount !== 0)) {
    throw new Error('actual native receiver namespace/profile/pin/TLS differs')
  }
  if (caseId === 'current-native-turn') {
    return executeReceiverNativeTurn(harness, supervisor, { mode, provider, terminal, scenario, soulId, storeId, workspace, view, namespace, launchRequest: selectedRequest, namespaceScript: receiverNativeNamespace })
  }
  const assertions = [{ name: 'actual-native-receiver-current-observation-before-input', pass: true },
    { name: 'actual-selected-native-process-profile-uid-and-tls', pass: true }]
  if (caseId === 'exact-resume') {
    const seedText = 'Reply stored. Do not use any tools.'
    if (terminal) {
      // Read ordinary current output before dispatch, then use separate paste
      // and submit gestures through the real managed terminal controller.
      harness.writeArtifact(`${scenario}-before-seed-terminal-private.json`, await harness.adminOk(supervisor, harness.terminalReadOutputBody(soulId)))
      harness.writeArtifact(`${scenario}-seed-paste-dispatch.json`, await harness.adminOk(supervisor,
        harness.terminalInputBody(soulId, '\x1b[200~' + seedText + '\x1b[201~')))
      await new Promise(resolve => setTimeout(resolve, 100))
      harness.writeArtifact(`${scenario}-seed-dispatch.json`, await harness.adminOk(supervisor, harness.terminalInputBody(soulId, '\r')))
    } else {
      harness.writeArtifact(`${scenario}-seed-dispatch.json`, await harness.adminOk(supervisor,
        { method: 'fresh_agent_send', params: { soulId, text: seedText } }))
    }
    const deadline = Date.now() + 90_000
    let before: Awaited<ReturnType<typeof captureReceiverStore>> | undefined, attempt = 0
    while (Date.now() < deadline) {
      try {
        const captured = await captureReceiverStore(harness, view.containerId, provider, view.nativeSessionId, scenario, `seed-${++attempt}`)
        if (captured.history.turns.length === 1 && captured.history.turns[0]!.text) { before = captured; break }
      } catch (error) {
        harness.writeArtifact(`${scenario}-seed-inspection-${attempt}-diagnostic.json`, { reason: error instanceof Error ? error.message : 'native store not yet complete' })
      }
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    if (!before || before.history.turns.some(turn => turn.toolCalls.length || !receiverNativeTurnProfileMatches(turn, mode)
      || (provider === 'codex' && turn.resolvedReasoningEffort !== 'low'))) {
      throw new Error('bounded native receiver seed did not complete with selected native profile and zero tools')
    }
    const probe = await harness.adminOk(supervisor, harness.probeRecoveryBody(soulId))
    harness.writeArtifact(`${scenario}-before-death-store-probe.json`, probe)
    if (probe.data.kind !== 'reattach_ready') throw new Error('completed native receiver store was not readable before death')
    const originalVolume = harness.broker.receipts().find(row => row.containerId === view.containerId)?.providerVolumeName
    if (!originalVolume) throw new Error('original owned native provider volume missing')
    await harness.killOwnedRuntimeExact(view.containerId)
    await harness.waitForContainerExit(view.containerId)
    const recovery = await harness.adminOk(supervisor, harness.recoverBody(soulId, 'host_unreachable'))
    harness.writeArtifact(`${scenario}-recovery.json`, recovery)
    const current = recovery.data.view, observed = current?.nativeIdentityObservation
    if (recovery.data.outcome !== 'replaced' || current.launchState !== 'running' || current.recoveryState !== 'live'
      || current.incarnationId === view.incarnationId || current.containerId === view.containerId
      || current.nativeSessionId !== view.nativeSessionId || observed?.nativeSessionId !== view.nativeSessionId
      || observed.incarnationId !== current.incarnationId || observed.source !== observationSource
      || !observed.launchNonce || observed.launchNonce === observation.launchNonce
      || !Number.isSafeInteger(observed.evidenceRevision) || observed.evidenceRevision <= observation.evidenceRevision
      || harness.broker.receipts().find(row => row.containerId === current.containerId)?.providerVolumeName !== originalVolume) {
      throw new Error('native receiver replacement did not bind current identity to the original owned volume')
    }
    const afterNamespace = JSON.parse(await harness.execOwnedContainerAsExact(current.containerId, '65534:0',
      ['python3', '-c', receiverNativeNamespace, provider, view.nativeSessionId, workspace, mode]))
    harness.writeArtifact(`${scenario}-replacement-namespace-private.json`, afterNamespace)
    if (afterNamespace.uid !== 65534 || afterNamespace.gid !== 0 || afterNamespace.caps !== namespace.caps
      || !afterNamespace.readOnlyRoot || !nativeNamespaceAccessMatches(afterNamespace, mode) || afterNamespace.tlsVerifyMode !== 2
      || !afterNamespace.tlsCheckHostname || afterNamespace.nativeCwd !== workspace || afterNamespace.nativeVersion !== namespace.nativeVersion
      || afterNamespace.executableSha256 !== namespace.executableSha256 || afterNamespace.profileSha256 !== namespace.profileSha256
      || afterNamespace.activeNativeProcesses !== 1 || (provider === 'opencode' && afterNamespace.nativeRoot !== view.nativeSessionId)) {
      throw new Error('native receiver replacement selected a different namespace or profile')
    }
    const after = await captureReceiverStore(harness, current.containerId, provider, view.nativeSessionId, scenario, 'after-recovery')
    const sameFile = before.snapshot.path === after.snapshot.path
      && before.snapshot.identity.slice(0, 2).every((value: string, index: number) => value === after.snapshot.identity[index])
    // SQLite recovery can checkpoint its WAL into the same physical database.
    // Its query-consistent native history must remain identical; JSONL also
    // retains the original complete byte prefix on that same file.
    const originalPrefix = provider === 'opencode' || Buffer.from(after.snapshot.bytesBase64, 'base64')
      .subarray(0, Buffer.from(before.snapshot.bytesBase64, 'base64').length).equals(Buffer.from(before.snapshot.bytesBase64, 'base64'))
    if (!sameFile || !originalPrefix || JSON.stringify(after.history) !== JSON.stringify(before.history)) {
      throw new Error('original native receiver completed history changed before replacement input')
    }
    assertions.push({ name: 'readable-completed-native-store-before-death', pass: true },
      { name: 'replacement-new-incarnation-same-native-root', pass: true },
      { name: 'original-owned-volume-transcript-continuity', pass: true },
      { name: 'same-workspace-selected-native-profile', pass: true })
  }
  const original: NativeExperimentOriginal = { caseId, ownerId: harness.runId, imageDigest: harness.imageRef,
    candidateSha: harness.candidateSha, nativeVersion: namespace.nativeVersion, executableSha256: namespace.executableSha256,
    profileSha256: createHash('sha256').update(JSON.stringify({ settings, nativeProfileSha256: namespace.profileSha256 })).digest('hex'),
    artifactReferences: [`${scenario}-launch.json`, `${scenario}-namespace-private.json`],
    assertions }
  harness.writeArtifact(`${scenario}-original.json`, original)
  return original
}

function nativeOriginalReference(evidenceDir: string, filename: string): NativeOriginalReference {
  return { path: path.relative(evidenceDir, filename), sha256: createHash('sha256').update(fs.readFileSync(filename)).digest('hex') }
}

function writeNativeOriginal(harness: RuntimeHarness, name: string, value: unknown): NativeOriginalReference {
  harness.writeArtifact(name, { ...value as Record<string, unknown>, execution: { candidateSha: harness.candidateSha, runId: harness.runId, runtimeImage: harness.imageRef } })
  return nativeOriginalReference(harness.evidenceDir, path.join(harness.evidenceDir, name))
}

/** Capture association comes from the exact owned invocation and its actual process probe. */
function retainOwnedNativeProbe(namespace: any, containerId: string): void {
  if (!containerId || !Number.isSafeInteger(namespace.nativePid) || namespace.nativePid < 1) throw new Error('owned native namespace probe lacks its actual container/process')
  namespace.ownedProbe = { containerId, nativePid: namespace.nativePid, capturedAt: Date.now() }
}

type FamilyNativeStage = { view: any; namespace: any; capture: any; observedAt: number; request: NativeOriginalReference; snapshotPath: string }

function retainFamilyNativeTurnOriginals(harness: RuntimeHarness, input: {
  scenario: string; mode: 'claude' | 'amplifier' | 'freshclaude' | 'kilroy'; provider: 'claude' | 'amplifier'
  launchRequest: any; nonce: string; initial: FamilyNativeStage; replacement: FamilyNativeStage; requestedAt: number; exitedAt: number
}): NonNullable<NativeExperimentOriginal['nativeOriginals']> {
  const { scenario, provider, mode, nonce } = input, root = input.initial.view.nativeSessionId
  const materialize = (label: string, stage: FamilyNativeStage) => {
    const directory = provider === 'amplifier' ? path.join(harness.evidenceDir, `${scenario}-${label}-native-originals`, 'sessions', root) : path.join(harness.evidenceDir, `${scenario}-${label}-native-originals`)
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    const filename = path.join(directory, provider === 'claude' ? `${root}.jsonl` : 'transcript.jsonl')
    const bytes = Buffer.from(stage.capture.transcript.bytesBase64, 'base64')
    if (!bytes.length || bytes.at(-1) !== 10 || createHash('sha256').update(bytes).digest('hex') !== stage.capture.transcript.sha256) throw new Error('native family transcript capture digest/EOF differs')
    fs.writeFileSync(filename, bytes, { mode: 0o600, flag: 'wx' })
    const nativeFile = nativeOriginalReference(harness.evidenceDir, filename)
    let nativeEvents: NativeOriginalReference | undefined
    if (provider === 'amplifier') {
      const events = Buffer.from(stage.capture.eventsBytesBase64, 'base64'), eventsPath = path.join(directory, 'events.jsonl')
      if (!events.length || events.at(-1) !== 10) throw new Error('native Amplifier events capture lacks complete originals')
      fs.writeFileSync(eventsPath, events, { mode: 0o600, flag: 'wx' }); nativeEvents = nativeOriginalReference(harness.evidenceDir, eventsPath)
    }
    // Amplifier's version/UID and TLS probes are separate actual calls in the
    // same current container/process. Preserve the checked TLS response when
    // the transcript-only poll did not issue another models request.
    const namespaceProbe = stage.namespace.ownedProbe
    if (provider === 'amplifier' && (!namespaceProbe || namespaceProbe.containerId !== stage.view.containerId || namespaceProbe.nativePid !== stage.capture.nativePid)) throw new Error('native family namespace probe belongs to a different current process')
    const namespace = { ...stage.namespace, ...stage.capture, httpsStatus: stage.capture.httpsStatus ?? stage.namespace.httpsStatus,
      profileSha256: stage.capture.nativeSettingsSha256 ?? createHash('sha256').update(JSON.stringify(stage.capture.profileFiles.slice(0, 3))).digest('hex') }
    // Completion/tool authority comes exclusively from this stage's captured
    // store events, never an older namespace object's embedded event bytes.
    delete namespace.eventsBytesBase64
    const volume = harness.broker.receipts().find(receipt => receipt.containerId === stage.view.containerId)?.providerVolumeName
    if (!volume) throw new Error('native family original owned volume is missing')
    return { stage: label === 'initial' ? 'initial' : 'after_provider_process_crash', nativeFile, ...(nativeEvents ? { nativeEvents } : {}), request: stage.request,
      launch: writeNativeOriginal(harness, `${scenario}-${label}-launch-original.json`, { capturedAt: stage.observedAt, request: input.launchRequest, response: { data: { view: stage.view } } }),
      namespace: writeNativeOriginal(harness, `${scenario}-${label}-namespace-original.json`, namespace),
      store: writeNativeOriginal(harness, `${scenario}-${label}-store-original.json`, { containerId: stage.view.containerId, providerVolumeName: volume, snapshot: { ...stage.capture.transcript, path: stage.snapshotPath }, ...(provider === 'amplifier' ? { eventsSnapshot: { bytesBase64: stage.capture.eventsBytesBase64, sha256: createHash('sha256').update(Buffer.from(stage.capture.eventsBytesBase64, 'base64')).digest('hex') } } : {}) }),
      ...(label === 'initial' ? {} : { crash: writeNativeOriginal(harness, `${scenario}-owned-crash-original.json`, { kind: 'provider_process_exit', containerId: input.initial.view.containerId, incarnationId: input.initial.view.incarnationId, requestedAt: input.requestedAt, exitedAt: input.exitedAt }) }) }
  }
  const reference = writeNativeOriginal(harness, `${scenario}-native-recovery-originals.json`, { schemaVersion: 1, candidateSha: harness.candidateSha, runId: harness.runId, runtimeImage: harness.imageRef, selected: [mode], conversations: [{ mode, provider, soulId: input.launchRequest.params.soulId, providerStoreId: input.launchRequest.params.providerStoreId, nativeSessionId: root, nonce, stages: [materialize('initial', input.initial), materialize('replacement', input.replacement)] }] })
  deriveNativeRecoveryOriginals({ evidenceDir: harness.evidenceDir, originalReference: reference, candidateSha: harness.candidateSha, runId: harness.runId, runtimeImage: harness.imageRef, selected: [mode], requiredStages: ['initial', 'after_provider_process_crash'] })
  return { evidenceDir: harness.evidenceDir, reference }
}

/** One serialized native seed and one actual recall after the owned enclosure exits. */
async function executeReceiverNativeTurn(harness: RuntimeHarness, supervisor: any, input: {
  mode: 'codex' | 'opencode' | 'freshcodex' | 'freshopencode'; provider: 'codex' | 'opencode'; terminal: boolean
  scenario: string; soulId: string; storeId: string; workspace: string; view: any; namespace: any; launchRequest: any; namespaceScript: string
}): Promise<NativeExperimentOriginal> {
  const { mode, provider, terminal, scenario, soulId, storeId, workspace, view, namespace, namespaceScript } = input
  const root = view.nativeSessionId, nonce = 'owned-memory-' + randomUUID()
  const initialObservedAt = Date.now()
  const before = await captureReceiverStore(harness, view.containerId, provider, root, scenario, 'before-seed', true)
  const send = async (text: string, label: string) => {
    const requests: any[] = []
    const gesture = async (request: any) => {
      const requestId = 'request-' + randomUUID(), sentAt = Date.now()
      const reply = await harness.adminOk(supervisor, request, { requestId })
      requests.push({ requestId, sentAt, request, reply })
    }
    if (terminal) {
      await harness.adminOk(supervisor, harness.terminalReadOutputBody(soulId))
      await gesture(harness.terminalInputBody(soulId, '\x1b[200~' + text + '\x1b[201~'))
      await new Promise(resolve => setTimeout(resolve, 100))
      await gesture(harness.terminalInputBody(soulId, '\r'))
    } else await gesture({ method: 'fresh_agent_send', params: { soulId, text } })
    return writeNativeOriginal(harness, `${scenario}-${label}-request-private.json`, { requests })
  }
  const complete = async (container: string, boundary: Awaited<ReturnType<typeof captureReceiverStore>>, label: string, expectedText?: string) => {
    const prior = new Set(boundary.history.turns.map(turn => JSON.stringify(turn.nativeEvidence))), deadline = Date.now() + 90_000
    let attempt = 0
    while (Date.now() < deadline) {
      let captured: Awaited<ReturnType<typeof captureReceiverStore>> | undefined
      try { captured = await captureReceiverStore(harness, container, provider, root, scenario, `${label}-${++attempt}`) }
      catch (error) { harness.writeArtifact(`${scenario}-${label}-${attempt}-diagnostic.json`, { severity: 'debug', event: 'runtime.native_feasibility.native_completion_pending', reason: error instanceof Error ? error.message : 'native store incomplete' }) }
      if (captured) {
        const turns = captured.history.turns.filter(turn => !prior.has(JSON.stringify(turn.nativeEvidence)))
        if (turns.length > 1) throw new Error('native serialized prompt produced duplicate completions')
        if (turns.length === 1) {
          const turn = turns[0]!
          if (turn.toolCalls.length || !receiverNativeTurnProfileMatches(turn, mode) || (expectedText && !turn.text.includes(expectedText))) throw new Error('native no-tool completion/profile/recall differs')
          return captured
        }
      }
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    throw new Error('bounded current native turn did not complete')
  }
  const seedRequest = await send(`Remember this private marker: ${nonce}. Reply stored. Do not use tools.`, 'seed')
  const seed = await complete(view.containerId, before, 'seed')
  const probe = await harness.adminOk(supervisor, harness.probeRecoveryBody(soulId))
  harness.writeArtifact(`${scenario}-before-death-store-probe.json`, probe)
  if (probe.data.kind !== 'reattach_ready') throw new Error('completed native store is not readable before owned death')
  const originalVolume = harness.broker.receipts().find(receipt => receipt.containerId === view.containerId)?.providerVolumeName
  if (!originalVolume) throw new Error('original owned native volume missing')
  const requestedAt = Date.now()
  await harness.killOwnedRuntimeExact(view.containerId)
  await harness.waitForContainerExit(view.containerId)
  const exitedAt = Date.now()
  const recovery = await harness.adminOk(supervisor, harness.recoverBody(soulId, 'host_unreachable')), observedAt = Date.now()
  harness.writeArtifact(`${scenario}-recovery.json`, recovery)
  const current = recovery.data.view, observed = current?.nativeIdentityObservation
  if (recovery.data.outcome !== 'replaced' || current.launchState !== 'running' || current.recoveryState !== 'live' || current.containerId === view.containerId || current.incarnationId === view.incarnationId || current.nativeSessionId !== root || observed?.nativeSessionId !== root || observed.incarnationId !== current.incarnationId || observed.source !== view.nativeIdentityObservation.source || !observed.launchNonce || observed.launchNonce === view.nativeIdentityObservation.launchNonce || observed.evidenceRevision <= view.nativeIdentityObservation.evidenceRevision || harness.broker.receipts().find(receipt => receipt.containerId === current.containerId)?.providerVolumeName !== originalVolume) throw new Error('native replacement differs from current root/incarnation/original volume')
  const currentNamespace = JSON.parse(await harness.execOwnedContainerAsExact(current.containerId, '65534:0', ['python3', '-c', namespaceScript, provider, root, workspace, mode]))
  retainOwnedNativeProbe(currentNamespace, current.containerId)
  harness.writeArtifact(`${scenario}-replacement-namespace-private.json`, currentNamespace)
  if (!receiverNativeNamespaceMatches(currentNamespace, provider, workspace, root, mode) || currentNamespace.executableSha256 !== namespace.executableSha256 || currentNamespace.profileSha256 !== namespace.profileSha256) throw new Error('native replacement namespace/profile differs')
  const restored = await captureReceiverStore(harness, current.containerId, provider, root, scenario, 'restored-before-input')
  if (seed.snapshot.path !== restored.snapshot.path || JSON.stringify(seed.snapshot.identity.slice(0, 2)) !== JSON.stringify(restored.snapshot.identity.slice(0, 2)) || JSON.stringify(seed.history) !== JSON.stringify(restored.history) || (provider === 'codex' && !Buffer.from(restored.snapshot.bytesBase64, 'base64').subarray(0, Buffer.from(seed.snapshot.bytesBase64, 'base64').length).equals(Buffer.from(seed.snapshot.bytesBase64, 'base64')))) throw new Error('native original completed store changed before replacement input')
  const recallRequest = await send('Reply with only the private marker from before. Do not use tools.', 'recall')
  const recall = await complete(current.containerId, restored, 'recall', nonce)
  const launch = (label: string, capturedAt: number, actualView: any) => writeNativeOriginal(harness, `${scenario}-${label}-current-launch-private.json`, { capturedAt, request: input.launchRequest, response: { data: { view: actualView } } })
  const reference = writeNativeOriginal(harness, `${scenario}-native-recovery-originals.json`, { schemaVersion: 1, candidateSha: harness.candidateSha, runId: harness.runId, runtimeImage: harness.imageRef, selected: [mode], conversations: [{ mode, provider, soulId, providerStoreId: storeId, nativeSessionId: root, nonce, stages: [
    { stage: 'initial', launch: launch('initial', initialObservedAt, view), request: seedRequest, nativeFile: seed.nativeFile, boundaryFile: before.nativeFile, namespace: writeNativeOriginal(harness, `${scenario}-initial-namespace-original.json`, namespace), store: writeNativeOriginal(harness, `${scenario}-initial-store-original.json`, { containerId: view.containerId, providerVolumeName: originalVolume, snapshot: seed.snapshot }) },
    { stage: 'after_provider_process_crash', launch: launch('replacement', observedAt, current), request: recallRequest, nativeFile: recall.nativeFile, boundaryFile: restored.nativeFile, namespace: writeNativeOriginal(harness, `${scenario}-replacement-namespace-original.json`, currentNamespace), store: writeNativeOriginal(harness, `${scenario}-replacement-store-original.json`, { containerId: current.containerId, providerVolumeName: originalVolume, snapshot: recall.snapshot }), crash: writeNativeOriginal(harness, `${scenario}-owned-crash-private.json`, { kind: 'provider_process_exit', containerId: view.containerId, incarnationId: view.incarnationId, requestedAt, exitedAt }) },
  ] }] })
  deriveNativeRecoveryOriginals({ evidenceDir: harness.evidenceDir, originalReference: reference, candidateSha: harness.candidateSha, runId: harness.runId, runtimeImage: harness.imageRef, selected: [mode], requiredStages: ['initial', 'after_provider_process_crash'] })
  const original: NativeExperimentOriginal = { caseId: 'current-native-turn', ownerId: harness.runId, candidateSha: harness.candidateSha, imageDigest: harness.imageRef, nativeVersion: namespace.nativeVersion, executableSha256: namespace.executableSha256, profileSha256: namespace.profileSha256, artifactReferences: [reference.path], nativeOriginals: { evidenceDir: harness.evidenceDir, reference }, assertions: ['readable-completed-native-store-before-death', 'replacement-new-incarnation-same-native-root', 'original-owned-volume-transcript-continuity', 'same-workspace-selected-native-profile', 'actual-restored-context-private-marker-recall', 'native-turns-requested-no-tools'].map(name => ({ name, pass: true })) }
  harness.writeArtifact(`${scenario}-original.json`, original)
  return original
}

function readCurrentCodexReceipt(file: string): Buffer {
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65_536 || fs.realpathSync(file) !== file) {
    throw new Error('current Codex receipt is not a bounded canonical regular file')
  }
  return fs.readFileSync(file)
}

function receiverNativeTurnProfileMatches(turn: NativeHistory['turns'][number], mode: string): boolean {
  return turn.resolvedProvider === (mode === 'freshopencode' ? 'opencode' : 'openai')
    && turn.resolvedModel === (mode === 'freshopencode' ? 'big-pickle' : 'gpt-5.6-luna')
}

function receiverNativeNamespaceMatches(namespace: any, provider: 'codex' | 'opencode', workspace: string, root: string, mode: string = provider): boolean {
  return namespace.uid === 65534 && namespace.gid === 0 && namespace.caps === '0000000000000000'
    && namespace.readOnlyRoot === true && nativeNamespaceAccessMatches(namespace, mode) && namespace.tlsVerifyMode === 2
    && namespace.tlsCheckHostname === true && namespace.nativeCwd === workspace
    && namespace.nativeVersion === (provider === 'codex' ? 'codex-cli 0.147.0' : '1.18.21')
    && namespace.activeNativeProcesses === 1 && (provider !== 'opencode' || namespace.nativeRoot === root)
    && /^[a-f0-9]{64}$/.test(namespace.executableSha256 ?? '') && /^[a-f0-9]{64}$/.test(namespace.profileSha256 ?? '')
}

async function captureReceiverStore(harness: RuntimeHarness, containerId: string, provider: 'codex' | 'opencode',
  root: string, scenario: string, label: string, allowEmpty = false): Promise<{ snapshot: any; history: NativeHistory; nativeFile: NativeOriginalReference }> {
  const snapshot = JSON.parse(await harness.execOwnedContainerAsExact(containerId, '65534:0',
    ['python3', '-c', receiverStoreSnapshot, provider, root]))
  harness.writeArtifact(`${scenario}-${label}-store-private.json`, snapshot)
  if ((provider === 'codex' && snapshot.nativeRoot !== root) || !Array.isArray(snapshot.identity) || snapshot.identity.length < 2
    || !snapshot.completeEof || !/^[a-f0-9]{64}$/.test(snapshot.sha256 ?? '')) throw new Error('actual native store capture invalid')
  let history: NativeHistory
  let copy: string
  if (provider === 'codex') {
    const bytes = Buffer.from(snapshot.bytesBase64, 'base64')
    if (createHash('sha256').update(bytes).digest('hex') !== snapshot.sha256 || bytes.at(-1) !== 10) throw new Error('native rollout capture digest/EOF differs')
    const directory = path.join(harness.evidenceDir, `${scenario}-${label}-native-copy`)
    fs.mkdirSync(directory, { mode: 0o700 })
    copy = path.join(directory, `rollout-${root}.jsonl`)
    fs.writeFileSync(copy, bytes, { mode: 0o600 })
    history = allowEmpty ? readCodexNativeObservation(directory, root).history : readCodexNativeHistory(directory, root)
  } else {
    const bytes = Buffer.from(snapshot.querySnapshotBase64, 'base64')
    if (createHash('sha256').update(bytes).digest('hex') !== snapshot.querySnapshotSha256) throw new Error('actual native SQLite snapshot digest differs')
    copy = path.join(harness.evidenceDir, `${scenario}-${label}-native-copy.db`)
    fs.writeFileSync(copy, bytes, { mode: 0o600, flag: 'wx' })
    history = allowEmpty ? readOpenCodeNativeObservation(copy, root).history : readOpenCodeNativeHistory(copy, root)
  }
  if (history.schemaVersion !== 1 || history.provider !== provider || history.nativeSessionId !== root
    || !Array.isArray(history.turns) || history.turns.some(turn => !turn.nativeEvidence || !Array.isArray(turn.toolCalls))) {
    throw new Error('actual native history reader returned a different root or schema')
  }
  harness.writeArtifact(`${scenario}-${label}-history-private.json`, history)
  return { snapshot, history, nativeFile: nativeOriginalReference(harness.evidenceDir, copy) }
}

export const receiverStoreSnapshot = String.raw`
import os,sys,pathlib,json,hashlib,base64,re,sqlite3
provider,root=sys.argv[1:];assert provider in ['codex','opencode'] and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,127}',root)
assert os.getuid()==65534 and os.getgid()==0
home=pathlib.Path('/home/freshell/provider');files=[]
if provider=='codex':
 directory=home/'.codex/sessions'
 for file in directory.glob('**/*.jsonl'):
  if root not in file.name:continue
  assert file.is_file() and not file.is_symlink() and file.resolve()==file
  with file.open('rb') as source:
   first=source.readline(1024*1024+1);assert len(first)<=1024*1024
  row=json.loads(first)
  if row.get('type')=='session_meta' and root in [row.get('payload',{}).get('id'),row.get('payload',{}).get('session_id')]:files.append(file)
 assert len(files)==1
 file=files[0]
else:file=home/'.local/share/opencode/opencode.db'
assert file.is_file() and not file.is_symlink() and file.resolve()==file
identity=lambda stat:[str(stat.st_dev),str(stat.st_ino),str(stat.st_size),str(stat.st_mtime_ns),str(stat.st_ctime_ns)]
with file.open('rb') as source:
 before=os.fstat(source.fileno());raw=source.read(8*1024*1024+1);after=os.fstat(source.fileno())
assert len(raw)<=8*1024*1024 and identity(before)==identity(after)==identity(file.stat()) and raw
assert provider!='codex' or raw.endswith(b'\n')
query_snapshot=None
if provider=='opencode':
 for suffix in ['-wal','-shm']:
  companion=pathlib.Path(str(file)+suffix)
  assert not companion.exists() or companion.is_file() and not companion.is_symlink() and companion.resolve()==companion
 with sqlite3.connect(file.as_uri()+'?mode=ro',uri=True) as source,sqlite3.connect(':memory:') as memory:
  source.execute('PRAGMA query_only=ON');source.execute('PRAGMA trusted_schema=OFF');source.backup(memory)
  query_snapshot=memory.serialize();assert len(query_snapshot)<=8*1024*1024
 assert identity(after)==identity(file.stat())
print(json.dumps({'nativeRoot':root if provider=='codex' else None,'path':str(file),'identity':identity(after),'sha256':hashlib.sha256(raw).hexdigest(),'bytesBase64':base64.b64encode(raw).decode() if provider=='codex' else None,'querySnapshotBase64':base64.b64encode(query_snapshot).decode() if query_snapshot is not None else None,'querySnapshotSha256':hashlib.sha256(query_snapshot).hexdigest() if query_snapshot is not None else None,'completeEof':True}))
`

export const receiverLoadFaultReceipt = String.raw`
import pathlib,json,os,sys
assert os.getuid()==65534 and os.getgid()==0
file=pathlib.Path(sys.argv[1])/'native-receiver-load-fault-observation.json'
assert file.is_file() and not file.is_symlink() and file.resolve()==file
with file.open('rb') as source:
 before=os.fstat(source.fileno());raw=source.read(65537);after=os.fstat(source.fileno())
assert 0<len(raw)<=65536 and (before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns)==(after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns)
value=json.loads(raw);assert isinstance(value,dict)
print(json.dumps(value))
`

export const receiverWrongRootEvidence = String.raw`
import pathlib,json,hashlib
file=pathlib.Path('/run/freshell-host-actor/fresh-agent-state.json')
assert file.is_file() and not file.is_symlink() and file.resolve()==file
raw=file.read_bytes();assert len(raw)<=32*1024*1024
state=json.loads(raw);profile=state['profile'];events=state['events']
assert isinstance(events,list) and isinstance(state['commands'],dict) and isinstance(state['decisions'],dict)
roots=[item['event']['data']['native_session_id'] for item in events if item['event']['kind']=='started']
print(json.dumps({'schemaVersion':state['schemaVersion'],'provider':profile['provider'],'cwd':profile['cwd'],'nativeSessionId':profile.get('nativeSessionId'),'startedRoots':roots,'commandCount':len(state['commands']),'decisionCount':len(state['decisions']),'sha256':hashlib.sha256(raw).hexdigest()}))
`

/** Free access names come from this exact native process, never a fixed upstream alias.
 * A verified TLS peer is access evidence only; the native store must still prove completion. */
export function openCodeFreeAccessScript(): string {
  return String.raw`
def probe_free_opencode_access(local,port,workspace,environment):
 import socket,hashlib
 forbidden=('OPENAI_','ANTHROPIC_','ONECLI_','LUNAROUTE_','OPENCODE_API_KEY','FRESHELL_MANAGED_CLAUDE_ONECLI_','FRESHELL_MANAGED_CODEX_ONECLI_','FRESHELL_MANAGED_OPENCODE_ONECLI_','FRESHELL_MANAGED_AMPLIFIER_ONECLI_')
 assert not any(key.startswith(forbidden) for key in environment),'free native credential reference leaked'
 assert not any(environment.get(key) for key in ['SSL_CERT_FILE','SSL_CERT_DIR','NODE_EXTRA_CA_CERTS','HTTPS_PROXY','HTTP_PROXY','ALL_PROXY','https_proxy','http_proxy','all_proxy']),'free native paid CA/proxy leaked'
 with local.open('http://127.0.0.1:'+str(port)+'/config/providers?directory='+urllib.parse.quote(workspace,safe=''),timeout=10) as response:
  assert response.status==200;raw=response.read(1024*1024+1);assert len(raw)<=1024*1024
  catalog=json.loads(raw)
 providers=catalog['providers'];providers=list(providers.values()) if isinstance(providers,dict) else providers
 selected=[provider for provider in providers if provider.get('id')=='opencode'];assert len(selected)==1
 model=selected[0]['models']['big-pickle'];assert model['id']=='big-pickle' and model['providerID']=='opencode'
 endpoint=model['api']['url'];url=urllib.parse.urlsplit(endpoint)
 assert url.scheme=='https' and url.hostname and not url.username and not url.password and not url.query and not url.fragment,'unsupported native free endpoint'
 context=ssl.create_default_context(cafile='/etc/ssl/certs/ca-certificates.crt')
 with socket.create_connection((url.hostname,url.port or 443),timeout=20) as connection:
  with context.wrap_socket(connection,server_hostname=url.hostname) as peer:
   certificate=peer.getpeercert(binary_form=True);assert certificate
 access=dict(source='native-config-providers',providerId=model['providerID'],modelId=model['id'],endpoint=endpoint,ca='system-default',peerCertificateSha256=hashlib.sha256(certificate).hexdigest())
 return context,access
`
}

export const receiverNativeNamespace = String.raw`
import os,sys,json,pathlib,hashlib,subprocess,ssl,urllib.request,urllib.parse
${openCodeFreeAccessScript()}
provider,root,workspace=sys.argv[1:4];mode=sys.argv[4] if len(sys.argv)>4 else provider;assert provider in ['codex','opencode'] and root and pathlib.Path(workspace).is_absolute()
matches=[]
for process in pathlib.Path('/proc').iterdir():
 if not process.name.isdigit():continue
 try:
  argv=[item.decode() for item in (process/'cmdline').read_bytes().split(b'\0') if item]
  executable=(process/'exe').resolve()
  if (provider=='codex' and executable.name=='codex' and 'app-server' in argv) or (provider=='opencode' and str(executable)=='/usr/local/lib/node_modules/opencode-ai/bin/opencode.exe' and 'serve' in argv):
   environment=dict(item.decode().split('=',1) for item in (process/'environ').read_bytes().split(b'\0') if b'=' in item)
   if process.stat().st_uid!=65534:raise RuntimeError('native child UID differs')
   if provider=='opencode' and not environment.get('FRESHELL_OPENCODE_SIDECAR_ID'):raise RuntimeError('native sidecar ownership tag missing')
   matches.append((process,executable,environment,argv))
 except (OSError,ValueError):continue
assert len(matches)==1
process,executable,environment,argv=matches[0]
native_cwd=str((process/'cwd').resolve());native_info=None;message_count=None
if provider=='opencode':
 assert argv.count('--port')==1 and argv.count('--hostname')==1
 port=int(argv[argv.index('--port')+1]);assert 1<=port<=65535 and argv[argv.index('--hostname')+1]=='127.0.0.1'
 local=urllib.request.build_opener(urllib.request.ProxyHandler({}))
 def native_get(suffix):
  url='http://127.0.0.1:'+str(port)+'/session/'+urllib.parse.quote(root,safe='')+suffix+'?directory='+urllib.parse.quote(workspace,safe='')
  with local.open(url,timeout=10) as response:
   assert response.status==200
   raw=response.read(1024*1024+1);assert len(raw)<=1024*1024
   return json.loads(raw)
 native_info=native_get('');messages=native_get('/message')
 assert native_info['id']==root and native_info.get('parentID') is None and native_info['directory']==workspace and isinstance(messages,list)
 assert all(isinstance(row,dict) and isinstance(row.get('info'),dict) and row['info']['sessionID']==root for row in messages)
 native_cwd=native_info['directory'];message_count=len(messages)
ca=pathlib.Path(environment.get('SSL_CERT_FILE') or environment['NODE_EXTRA_CA_CERTS']) if mode!='freshopencode' else None
free_access=None
if mode=='freshopencode':
 assert provider=='opencode'
 context,free_access=probe_free_opencode_access(local,port,workspace,environment);status=None
else:
 context=ssl.create_default_context(cafile=str(ca))
 proxy=environment.get('HTTPS_PROXY') or environment.get('https_proxy')
 opener=urllib.request.build_opener(urllib.request.ProxyHandler({'https':proxy}),urllib.request.HTTPSHandler(context=context))
 with opener.open(urllib.request.Request('https://chatgpt.com/backend-api/codex/models?client_version=0.147.0',headers={'Authorization':'Bearer onecli-managed'}),timeout=20) as response:status=response.status;response.read()
home=pathlib.Path(environment['HOME']);profiles=[]
for name in (['.codex/config.toml'] if provider=='codex' else ['.config/opencode/opencode.json','.config/opencode/opencode.jsonc']):
 file=home/name;profiles.append({'path':name,'sha256':hashlib.sha256(file.read_bytes()).hexdigest() if file.exists() else None})
profile_hash=hashlib.sha256(json.dumps(profiles,sort_keys=True).encode()).hexdigest()
print(json.dumps({'uid':os.getuid(),'gid':os.getgid(),'caps':next(row.split()[1] for row in pathlib.Path('/proc/self/status').read_text().splitlines() if row.startswith('CapEff:')),'readOnlyRoot':bool(os.statvfs('/').f_flag&os.ST_RDONLY),'nativeCwd':native_cwd,'nativeProcessCwd':str((process/'cwd').resolve()),'nativeLaunch':json.loads(environment['FRESHELL_NATIVE_IDENTITY_LAUNCH']) if environment.get('FRESHELL_NATIVE_IDENTITY_LAUNCH') else None,'nativeRoot':native_info['id'] if native_info else None,'nativeMessageCount':message_count,'nativeVersion':subprocess.check_output([str(executable),'--version'],env=environment,text=True,timeout=15).strip(),'executableSha256':hashlib.sha256(executable.read_bytes()).hexdigest(),'profileSha256':profile_hash,'profileFiles':profiles,'activeNativeProcesses':len(matches),'nativePid':int(process.name),'tlsVerifyMode':context.verify_mode.value,'tlsCheckHostname':context.check_hostname,'httpsStatus':status,'caSha256':hashlib.sha256(ca.read_bytes()).hexdigest() if ca else None,'freeModelAccess':free_access}))
`

// The terminal TUI uses an embedded native server rather than the fresh
// transport's serve port. Keep the process/profile/TLS inspection identical;
// inspect only the exact selected owned V1 root through a query-only read.
export const openCodeTuiNativeNamespace = (() => {
  const selected = receiverNativeNamespace
    .replace(" and 'serve' in argv", '')
    .replace("   if provider=='opencode' and not environment.get('FRESHELL_OPENCODE_SIDECAR_ID'):raise RuntimeError('native sidecar ownership tag missing')",
      "   assert environment.get('FRESHELL_NATIVE_IDENTITY_LAUNCH') and environment.get('FRESHELL_OPENCODE_ADOPTION_ROOT_SESSION_ID')==root")
  const begin = selected.indexOf("if provider=='opencode':\n assert argv.count")
  const end = selected.indexOf('ca=pathlib.Path', begin)
  if (begin < 0 || end < begin) throw new Error('finite native TUI namespace selection differs')
  return (selected.slice(0, begin) + String.raw`
import sqlite3
assert argv.count('--session')==1 and argv[argv.index('--session')+1]==root
assert argv.count('--model')==1 and argv[argv.index('--model')+1]=='openai/gpt-5.6-luna'
assert environment.get('OPENCODE_DISABLE_AUTOUPDATE')=='true'
database=sqlite3.connect('file:/home/freshell/provider/.local/share/opencode/opencode.db?mode=ro',uri=True)
database.execute('PRAGMA query_only=ON');database.execute('BEGIN')
row=database.execute('SELECT id,parent_id,directory,revert FROM session WHERE id=?',(root,)).fetchone()
assert row and row[0]==root and row[1] is None and row[2]==workspace
native_info={'id':row[0]}
message_ids=[row[0] for row in database.execute('SELECT id FROM message WHERE session_id=? ORDER BY id',(root,))]
message_count=len(message_ids)
v2_message_count=database.execute('SELECT count(*) FROM session_message WHERE session_id=?',(root,)).fetchone()[0]
saved_revert=json.loads(row[3]) if row[3] else None
active_ids=message_ids
if saved_revert:
 boundary=message_ids.index(saved_revert['messageID'])
 active_ids=message_ids[:boundary+(1 if saved_revert.get('partID') else 0)]
database.rollback();database.close()
` + selected.slice(end)).replace("'nativeMessageCount':message_count,", "'nativeMessageCount':message_count,'v2MessageCount':v2_message_count,'savedRevert':saved_revert,'activeMessageIds':active_ids,")
})()

// A qualification-only module, selected through the ordinary owned TUI
// config. It must use the pinned public plugin lifecycle, never publish a
// native identity or synthesize a loader acknowledgement.
export const openCodeTuiOwnedStoreFault = String.raw`
import os,sys,pathlib,re,sqlite3,json
case,root,workspace=sys.argv[1:]
assert os.getuid()==65534 and os.getgid()==0
assert case in ['root-load-error','history-load-error'] and re.fullmatch(r'ses_[A-Za-z0-9]+',root)
home=pathlib.Path(os.environ['HOME'])
assert str(home)=='/home/freshell/provider' or re.fullmatch(r'/tmp/f[a-z0-9]+/[a-f0-9-]{12}/provider',str(home))
assert re.fullmatch(r'/tmp/f[a-z0-9]+/[a-f0-9-]{12}/opencode-'+case+r'-workspace',workspace)
file=home/'.local/share/opencode/opencode.db'
assert file.is_file() and not file.is_symlink() and file.resolve()==file
before=file.stat()
database=sqlite3.connect('file:'+str(file)+'?mode=rw',uri=True)
try:
 database.execute('PRAGMA foreign_keys=ON');database.execute('BEGIN IMMEDIATE')
 row=database.execute('SELECT id,parent_id,directory FROM session WHERE id=?',(root,)).fetchone()
 assert row and row==(root,None,workspace)
 roots_before=database.execute('SELECT count(*) FROM session WHERE id=?',(root,)).fetchone()[0]
 count=database.execute('SELECT count(*) FROM message WHERE session_id=?',(root,)).fetchone()[0]
 assert count==2
 if case=='root-load-error':
  changed=database.execute('DELETE FROM session WHERE id=?',(root,)).rowcount
 else:
  selected=database.execute('SELECT id FROM message WHERE session_id=? ORDER BY id LIMIT 1',(root,)).fetchone()
  assert selected
  changed=database.execute('UPDATE message SET data=? WHERE id=? AND session_id=?',('{"owned_native_fault":',selected[0],root)).rowcount
 assert changed==1
 database.commit()
 roots_after=database.execute('SELECT count(*) FROM session WHERE id=?',(root,)).fetchone()[0]
 messages_after=database.execute('SELECT count(*) FROM message WHERE session_id=?',(root,)).fetchone()[0]
 malformed_after=database.execute('SELECT count(*) FROM message WHERE session_id=? AND NOT json_valid(data)',(root,)).fetchone()[0]
 assert (roots_after==0 if case=='root-load-error' else roots_after==1 and messages_after==2 and malformed_after==1)
finally:database.close()
after=file.stat()
same_identity=(before.st_dev,before.st_ino)==(after.st_dev,after.st_ino)
assert same_identity
print(json.dumps({'schemaVersion':1,'caseId':case,'rootSessionId':root,'changedRows':changed,'sameDatabaseIdentity':same_identity,
 'rootRowsBefore':roots_before,'rootRowsAfter':roots_after,'messageRowsBefore':count,'messageRowsAfter':messages_after,'malformedMessagesAfter':malformed_after}))
`

export const openCodeTuiDisposalObserver = String.raw`
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
const storeFaultScript = ${JSON.stringify(openCodeTuiOwnedStoreFault)}
export default { id: 'freshell-native-qualification', tui(api) {
  const cwd = fs.realpathSync(process.cwd()), home = process.env.HOME
  if (!/^\/tmp\/f[a-z0-9]+\/[a-f0-9-]{12}\/opencode-(disposal|baseline-only-resume|stale-observation|root-load-error|history-load-error)-workspace$/.test(cwd)
    || process.getuid() !== 65534 || process.getgid() !== 0 || !home) return
  const control = JSON.parse(fs.readFileSync(path.join(cwd, 'native-tui-fault-control.json'), 'utf8'))
  const launch = JSON.parse(process.env.FRESHELL_NATIVE_IDENTITY_LAUNCH || 'null')
  const terminal = process.env.FRESHELL_TERMINAL_ID
  if (control.schemaVersion !== 1 || !['disposal', 'baseline-only-resume', 'stale-observation', 'root-load-error', 'history-load-error'].includes(control.caseId)
    || !cwd.endsWith('/opencode-' + control.caseId + '-workspace') || control.terminalId !== terminal
    || !/^[a-zA-Z0-9_-]+$/.test(terminal || '') || launch?.requestedNativeSessionId !== control.rootSessionId
    || typeof launch.incarnationId !== 'string' || typeof launch.launchNonce !== 'string') return
  const replacementOnly = ['baseline-only-resume', 'stale-observation'].includes(control.caseId)
  if (replacementOnly && control.previousIncarnationId === launch.incarnationId) return
  const directory = path.join(home, '.freshell/session-signals')
  const progress = path.join(directory, 'opencode-adoption-diagnostics', terminal)
  const expected = path.join(directory, 'opencode-adoption', terminal + '.expected.json')
  const loadFault = ['root-load-error', 'history-load-error'].includes(control.caseId)
  const read = file => {
    try { const stat = fs.lstatSync(file); return stat.isFile() && !stat.isSymbolicLink() && stat.size <= 65536
      ? JSON.parse(fs.readFileSync(file, 'utf8')) : null } catch { return null }
  }
  if (replacementOnly && (typeof control.previousIncarnationId !== 'string' || !control.previousIncarnationId)) {
    // Keep the genuine initial producer enabled. Copy its exact output before
    // the authenticated host consumes it; these owner artifacts never enter
    // a native identity channel or release input themselves.
    let captured = false, timer, watcher
    const start = Date.now(), directory = path.dirname(expected)
    const close = () => { clearInterval(timer); watcher?.close() }
    const capture = () => {
      if (captured || api.lifecycle.signal.aborted) { close(); return }
      try {
        const binding = read(expected)
        if (binding?.root_session_id !== control.rootSessionId || binding.incarnation_id !== launch.incarnationId) return
        for (const name of fs.readdirSync(directory)) {
          if (!name.startsWith(terminal + '__') || !name.endsWith('.json')) continue
          const file = path.join(directory, name), stat = fs.lstatSync(file)
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) continue
          const raw = fs.readFileSync(file), frame = JSON.parse(raw.toString('utf8')), observation = frame.adoption_observation
          if (frame.source !== 'opencode-tui-plugin' || frame.session_id !== control.rootSessionId
            || observation?.terminal_id !== terminal || observation.root_session_id !== control.rootSessionId
            || observation.incarnation_id !== launch.incarnationId || observation.launch_nonce !== binding.launch_nonce
            || observation.evidence_generation !== binding.evidence_generation || observation.hydrated !== true
            || observation.messages_read !== 'success') continue
          fs.writeFileSync(path.join(cwd, 'native-tui-captured-signal.json'), raw, { mode: 0o600 })
          fs.writeFileSync(path.join(cwd, 'native-tui-captured-signal-metadata.json'), JSON.stringify({schemaVersion:1,
            terminalId:terminal, rootSessionId:control.rootSessionId, incarnationId:launch.incarnationId,
            launchNonce:launch.launchNonce, nativePid:process.pid, sourceFile:name,
            sourceSha256:createHash('sha256').update(raw).digest('hex')}), { mode: 0o600 })
          captured = true; close(); return
        }
      } catch { /* A consumed/incomplete file is not evidence; wait boundedly. */ }
      finally { if (Date.now() - start >= 10000) close() }
    }
    try { watcher = fs.watch(directory, () => capture()) } catch { /* Finite polling still reads only this owned namespace. */ }
    timer = setInterval(capture, 5)
    api.lifecycle.signal.addEventListener('abort', close, { once: true }); api.lifecycle.onDispose(close)
    capture(); return
  }
  const publishedForCurrentLaunch = () => {
    const publication = read(progress + '.publication_succeeded.json')
    return publication && (!publication.incarnationId || publication.incarnationId === launch.incarnationId)
  }
  let busy = false, settled = false, timer, disposed, storeFault, released = false
  const started = Date.now()
  const report = value => {
    fs.writeFileSync(path.join(cwd, 'native-tui-fault-result.json'), JSON.stringify({
      schemaVersion: 1, caseId: control.caseId, terminalId: terminal, incarnationId: launch.incarnationId,
      launchNonce: launch.launchNonce, nativePid: process.pid, elapsedMs: Date.now() - started, ...value }), { mode: 0o600 })
  }
  const finish = value => {
    settled = true; clearInterval(timer); report(value)
  }
  const tick = async () => {
    if (busy || settled || api.lifecycle.signal.aborted) return
    busy = true
    try {
      if (!released && publishedForCurrentLaunch()) {
        finish({ outcome: 'already_published' }); return
      }
      const pending = read(progress + '.native_read_pending.json')
      const binding = read(expected) || { root_session_id: process.env.FRESHELL_OPENCODE_ADOPTION_ROOT_SESSION_ID,
        incarnation_id: process.env.FRESHELL_OPENCODE_ADOPTION_INCARNATION_ID,
        launch_nonce: process.env.FRESHELL_OPENCODE_ADOPTION_LAUNCH_NONCE,
        evidence_generation: process.env.FRESHELL_OPENCODE_ADOPTION_EVIDENCE_GENERATION }
      if (loadFault && disposed) {
        if (!released) {
          const release = read(path.join(cwd, 'native-tui-fault-release.json'))
          if (release?.schemaVersion !== 1 || release.caseId !== control.caseId || release.rootSessionId !== control.rootSessionId
            || release.incarnationId !== launch.incarnationId || release.launchNonce !== launch.launchNonce
            || release.evidenceRevision !== launch.evidenceRevision || release.executionGeneration !== launch.executionGeneration) {
            if (Date.now() - started >= 20000) finish({ outcome: 'current_owned_fault_release_not_observed' })
            return
          }
          storeFault = JSON.parse(execFileSync('python3', ['-c', storeFaultScript, control.caseId, control.rootSessionId, cwd],
            { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }))
          released = true
          await api.plugins.activate('freshell-rebind')
          if (!api.plugins.list().some(row => row.id === 'freshell-rebind' && row.active)) {
            finish({ outcome: 'native_producer_reactivation_failed' }); return
          }
        }
        const refusal = read(progress + '.json')
        const reason = control.caseId === 'root-load-error' ? 'native_root_load_failed' : 'native_history_load_failed'
        if (refusal?.reason === reason && refusal.nativeSessionId === control.rootSessionId
          && refusal.incarnationId === launch.incarnationId && refusal.launchNonce === binding.launch_nonce
          && refusal.evidenceGeneration === binding.evidence_generation) {
          finish({ outcome: 'native_load_error_observed', ...disposed, storeFault, refusal,
            producerActive: api.plugins.list().some(row => row.id === 'freshell-rebind' && row.active) }); return
        }
        if (Date.now() - started >= 20000) finish({ outcome: 'current_native_read_refusal_not_observed', storeFault })
        return
      }
      if (pending?.stage !== 'native_read_pending' || pending.nativeSessionId !== control.rootSessionId
        || pending.incarnationId !== launch.incarnationId || binding.root_session_id !== control.rootSessionId
        || binding.incarnation_id !== launch.incarnationId || pending.launchNonce !== binding.launch_nonce
        || pending.evidenceGeneration !== binding.evidence_generation) {
        if (Date.now() - started >= 10000) finish({ outcome: 'pending_current_read_not_observed' })
        return
      }
      const before = api.plugins.list().find(row => row.id === 'freshell-rebind')
      if (!before?.active) { finish({ outcome: 'producer_not_active' }); return }
      // Invoke the supported manager before any await that could let the
      // pending producer publish. Its real scope aborts native observation.
      await api.plugins.deactivate('freshell-rebind')
      const after = api.plugins.list().find(row => row.id === 'freshell-rebind')
      if (after?.active || publishedForCurrentLaunch()) {
        finish({ outcome: 'disposal_did_not_precede_publication' }); return
      }
      const session = await api.client.session.get({ sessionID: control.rootSessionId })
      const messages = await api.client.session.messages({ sessionID: control.rootSessionId })
      if (session?.error || messages?.error || session?.data?.id !== control.rootSessionId
        || session.data.directory !== cwd || !Array.isArray(messages.data)
        || messages.data.some(row => row?.info?.sessionID !== control.rootSessionId)) {
        finish({ outcome: 'native_root_read_failed' }); return
      }
      disposed = { nativeSessionId: session.data.id,
        nativeMessageCount: messages.data.length, producerActive: after?.active === true,
        adoptionLaunchNonce: pending.launchNonce, evidenceGeneration: pending.evidenceGeneration }
      if (loadFault) report({ outcome: 'disposed_before_store_fault', ...disposed })
      else finish({ outcome: 'disposed_before_publication', ...disposed })
    } catch { finish({ outcome: 'supported_disposal_failed' }) }
    finally { busy = false }
  }
  timer = setInterval(() => { void tick() }, 5)
  api.lifecycle.signal.addEventListener('abort', () => clearInterval(timer), { once: true })
  api.lifecycle.onDispose(() => clearInterval(timer))
  void tick()
} }
`

async function executeManagedFreshStartupFault(harness: RuntimeHarness, supervisor: Awaited<ReturnType<RuntimeHarness['startSupervisor']>>,
  request: any, caseId: string, scenario: string, settings: unknown, sdkForkImage = false): Promise<NativeExperimentOriginal> {
  const soulId = request.params.soulId
  const began = Date.now()
  let finished = false, reply: any, error: unknown, namespace: any, receipt: any, fieldReceipt: any, refusals: any
  const fieldFault = ['missing-native-id', 'placeholder-id'].includes(caseId)
  const pending = harness.adminRaw(supervisor, request).then(
    (value) => { reply = value; finished = true },
    (failure) => { error = failure; finished = true },
  )
  await Promise.resolve()
  if (finished && error) throw error
  const attempts: string[] = []
  // Observe the actual selected child before its existing identity deadline.
  // A requested root and the sidecar create key never fill observed identity.
  const deadline = Date.now() + 6_000
  while (!finished && Date.now() < deadline) {
    receipt = harness.broker.receipts().find((owned) => owned.soulId === soulId)
    if (receipt) {
      try {
        if (fieldFault) {
          const file = path.join(request.params.freshAgent.cwd, 'native-init-field-fault-observation.json')
          if (fs.lstatSync(file).isSymbolicLink() || fs.statSync(file).size > 64 * 1024) throw new Error('owned native field receipt differs')
          fieldReceipt = JSON.parse(fs.readFileSync(file, 'utf8'))
        }
        namespace = JSON.parse(await harness.execOwnedContainerAsExact(receipt.containerId,'65534:0',
          ['python3','-c',claudeNativeInspection,fieldFault ? fieldReceipt.actualNativeSessionId : request.params.nativeSessionId??'', 'false','fresh', fieldFault?'ordinary':caseId==='wrong-id'?'wrong-id':'disabled-hooks', ...(sdkForkImage ? ['sdk-fork-image'] : [])]))
        if (fieldFault) {
          const logs = harness.containerLogs(receipt.containerId)
          refusals = logs.split('\n').flatMap(line => {
            try { const record = JSON.parse(line); return record.event === 'host.native_identity.refused' ? [record] : [] }
            catch { return [] }
          })
          if (!nativeSdkInitFieldFaultMatches(request.params.freshAgent.sessionType, caseId, fieldReceipt, namespace, refusals)) {
            throw new Error('actual normalized SDK native field refusal unavailable')
          }
        }
        break
      } catch (failure) {attempts.push(String(failure))}
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  harness.writeArtifact(`${scenario}-pre-fault-capture-errors-private.json`,attempts)
  if (!namespace || !receipt) {
    await pending
    if (error) throw error
    harness.writeArtifact(`${scenario}-failed-launch.json`,reply)
    throw new Error('genuine current unobserved SDK child unavailable before startup fault')
  }
  harness.writeArtifact(`${scenario}-pre-fault-native-private.json`,namespace)
  if (fieldFault) harness.writeArtifact(`${scenario}-native-field-normalized-private.json`, { fieldReceipt, refusals })
  const hookSetting=caseId==='wrong-id'||fieldFault ? {} : JSON.parse(fs.readFileSync(path.join(request.params.freshAgent.cwd,'.claude/settings.json'),'utf8'))
  const actualNamespace=namespace.uid===65534 && namespace.gid===0 && namespace.caps==='0000000000000000'
    && namespace.readOnlyRoot && namespace.httpsStatus===200 && namespace.tlsVerifyMode===2 && namespace.tlsCheckHostname
    && namespace.version.startsWith('2.1.237') && namespace.nativeCwd===request.params.freshAgent.cwd
    && namespace.completedTurns===0 && namespace.toolEvents===0
  const nativeFault=fieldFault ? nativeSdkInitFieldFaultMatches(request.params.freshAgent.sessionType,caseId,fieldReceipt,namespace,refusals) : caseId==='wrong-id' ? !!namespace.hook && namespace.hook.native.session_id!==request.params.nativeSessionId
    && JSON.stringify(namespace.hook.launch)===JSON.stringify(namespace.nativeLaunch)
    : namespace.hook===null && namespace.nativeRoot===null && hookSetting.disableAllHooks===true
  if (!actualNamespace || !nativeFault) {await pending;throw new Error('genuine native SDK pin/profile/identity fault differs')}
  let fault: any
  if (caseId==='provider-exit') {
    if (finished)throw new Error('native startup settled before owned provider exit')
    await harness.killOwnedRuntimePidExact(receipt.containerId,namespace.nativePid,'TERM')
  } else if (caseId==='stop-cancellation') {
    if (finished)throw new Error('native startup settled before ordinary Stop')
    fault=await harness.adminOk(supervisor,harness.stopBody(soulId))
    harness.writeArtifact(`${scenario}-ordinary-stop.json`,fault)
  }
  await pending
  if (error)throw error
  const elapsedMs=Date.now() - began
  harness.writeArtifact(`${scenario}-launch.json`,reply)
  harness.writeArtifact(`${scenario}-timing.json`,{elapsedMs})
  const inventory=await harness.adminOk(supervisor,harness.inventoryBody())
  harness.writeArtifact(`${scenario}-current-inventory.json`,inventory)
  const current=inventory.data.filter((row:any)=>row.soulId===soulId)
  if (!reply.result?.Err || !current.length || current.some((row:any)=>row.launchState==='running'||row.nativeIdentityObservation)) {
    throw new Error('unobserved native fresh startup published Running or identity')
  }
  if (caseId==='timeout-50s' && (elapsedMs<50_000||elapsedMs>=60_000))throw new Error('actual SDK native timeout did not respect its existing50s bound')
  if (caseId==='provider-exit') {
    fault=JSON.parse(await harness.execOwnedContainerAsExact(receipt.containerId,'65534:0',
      ['python3','-c',"import pathlib,json,sys;print(json.dumps({'nativeExited':not (pathlib.Path('/proc')/sys.argv[1]/'exe').exists()}))",String(namespace.nativePid)]))
    harness.writeArtifact(`${scenario}-native-exit.json`,fault)
    if (!fault.nativeExited)throw new Error('owned native SDK writer remains after exit fault')
  }
  if (caseId==='stop-cancellation' && (fault.data?.outcome!=='verified_empty'||current.some((row:any)=>row.launchState!=='stopped'||row.desiredState!=='stopped'||row.recoveryState!=='stopped'))) {
    throw new Error('ordinary Stop did not confirm empty stopped native fresh runtime')
  }
  const input=await harness.adminRaw(supervisor,{method:'fresh_agent_send',params:{soulId,text:'Owned blocked startup probe. Do not use tools.'}})
  harness.writeArtifact(`${scenario}-input-refusal.json`,input)
  if (!input.result?.Err)throw new Error('unobserved native fresh startup admitted ordinary input')
  const original={caseId,ownerId:harness.runId,candidateSha:harness.candidateSha,imageDigest:harness.imageRef,
    nativeVersion:namespace.version,executableSha256:namespace.executableSha256,
    profileSha256:createHash('sha256').update(JSON.stringify({settings,nativeProfile:namespace.profileFiles})).digest('hex'),
    artifactReferences:[`${scenario}-pre-fault-native-private.json`,`${scenario}-launch.json`,`${scenario}-current-inventory.json`,`${scenario}-input-refusal.json`,
      ...(fieldFault ? [`${scenario}-native-field-normalized-private.json`, `${scenario}-sdk-init-field-image-private.json`] : [])],
    assertions:[{name:'actual-default-sdk-child-normal-uid-tls-current-launch',pass:actualNamespace},
      {name:'actual-native-startup-fault-remains-unobserved',pass:nativeFault},
      {name:'native-fault-refuses-running-current-observation-and-input',pass:!!input.result.Err},
      ...(caseId==='provider-exit'?[{name:'owned-native-writer-exited',pass:fault.nativeExited}]:[]),
      ...(caseId==='stop-cancellation'?[{name:'ordinary-stop-confirmed-empty-stopped-runtime',pass:fault.data?.outcome==='verified_empty' && current.every((row:any)=>row.launchState==='stopped'&&row.desiredState==='stopped'&&row.recoveryState==='stopped')}]:[]),
      ...(caseId==='timeout-50s'?[{name:'actual-existing50s-native-startup-bound',pass:elapsedMs>=50_000&&elapsedMs<60_000}]:[])]}
  harness.writeArtifact(`${scenario}-original.json`,original)
  return original
}

async function executeManagedTerminalClaude(harness: RuntimeHarness,
  sources: { name: string; path: string; sha256: string }[], caseId: string, serverPath?: string,
  servers: { server: import('../../test/e2e-browser/helpers/rust-server.js').RustServer; scope: string; pid?: number }[] = []): Promise<NativeExperimentOriginal> {
  const restorationFailure = caseId === 'restoration-failure-after-hook'
  const forkRoot = caseId === 'fork-root'
  const resumes = ['exact-resume', 'current-native-turn', 'fork-root', 'restoration-failure-after-hook'].includes(caseId)
  const nativeTimeout = caseId === 'timeout'
  const trustRefusal = caseId === 'trust-refusal'
  const unwritableSignal = caseId === 'unwritable-signal'
  const providerExit = caseId === 'provider-exit'
  const stopCancellation = caseId === 'stop-cancellation'
  const staleSignal = caseId === 'stale-shared-signal'
  const startupFault = providerExit || stopCancellation
  const pendingFault = startupFault || staleSignal
  let priorSignals: any
  if (staleSignal) {
    // Obtain genuine current native bytes in this owned rig, then close their
    // sole writer before presenting them to a different launch as a fault.
    const originalPath = path.join(harness.evidenceDir, 'claude-create-original.json')
    if (!fs.existsSync(originalPath)) await executeManagedTerminalClaude(harness, sources, 'create', serverPath, servers)
    const read = (name: string) => JSON.parse(fs.readFileSync(path.join(harness.evidenceDir, name), 'utf8'))
    const priorOriginal = read('claude-create-original.json')
    const priorView = read('claude-create-current-view.json')
    const priorObservation = priorView.nativeIdentityObservation
    priorSignals = read('claude-create-signal-native-private.json').processes.find((row: any) =>
      row.launch?.incarnationId === priorView.incarnationId)
    if (priorOriginal.ownerId !== harness.runId || priorOriginal.candidateSha !== harness.candidateSha
      || priorOriginal.imageDigest !== harness.imageRef || !priorOriginal.assertions?.length
      || !priorOriginal.assertions.every((row: any) => row.pass === true)
      || priorView.launchState !== 'running' || priorView.recoveryState !== 'live'
      || priorObservation?.source !== 'claude_native_event' || !priorView.nativeSessionId
      || priorObservation.nativeSessionId !== priorView.nativeSessionId
      || priorObservation.incarnationId !== priorView.incarnationId || !priorObservation.launchNonce
      || !priorSignals || priorSignals.launch.launchNonce !== priorObservation.launchNonce
      || priorSignals.signals.length !== 2 || !['session-start.json', 'statusline-loaded.json'].every((name) =>
        priorSignals.signals.some((row: any) => {
          if (row.name !== name || !row.bytesBase64 || !row.sha256) return false
          const bytes = Buffer.from(row.bytesBase64, 'base64')
          if (createHash('sha256').update(bytes).digest('hex') !== row.sha256) return false
          const signal = JSON.parse(bytes.toString('utf8'))
          return signal.native?.session_id === priorView.nativeSessionId
            && JSON.stringify(signal.launch) === JSON.stringify(priorSignals.launch)
        }))) {
      throw new Error('current owned native create evidence required before stale-signal reuse')
    }
    harness.killOwnedRuntimeExact(priorView.containerId)
    await harness.waitForContainerExit(priorView.containerId)
  }
  const hooksDisabled = caseId === 'disabled-hooks' || nativeTimeout || pendingFault
  if (resumes && !serverPath) throw new Error('actual terminal recovery requires the owned real server artifact')
  const grants = (['env_file', 'ca_file'] as const).map((suffix) => {
    const file = sources.find((source) => source.name === `claude/grants/${suffix}`)
    if (!file) throw new Error(`selected terminal Claude ${suffix} reference missing`)
    return { sourcePath: file.path, profile: suffix === 'env_file' ? 'claude_onecli_environment' : 'claude_onecli_ca_file' }
  })
  const preferences = sources.find((source) => source.name === 'claude/profile/native-startup-user.json')
  if (!preferences) throw new Error('owned native terminal startup preferences missing')
  const scenario = `claude-${caseId}`
  const workspace = path.join(harness.testRoot, `${scenario}-workspace`)
  fs.mkdirSync(workspace, { mode: 0o770 }); fs.chmodSync(workspace, 0o770)
  // Select the same ordinary user file on create and controller reissue.
  // The supported config directory keeps preferences in that selected root.
  const home = path.join(harness.testRoot, 'native-source/claude', scenario)
  const userRoot = path.join(home, '.claude')
  const preferencePath = path.join(userRoot, '.claude.json')
  fs.mkdirSync(userRoot, { recursive: true, mode: 0o700 })
  fs.copyFileSync(preferences.path, preferencePath)
  fs.chmodSync(preferencePath, 0o600)
  if (restorationFailure || forkRoot) {
    const local = path.join(workspace, '.claude'); fs.mkdirSync(local, { mode: 0o770 }); fs.chmodSync(local, 0o770)
    const hookPath = path.join(workspace, forkRoot ? 'native-fork-fault.mjs' : 'native-restoration-fault.mjs')
    fs.writeFileSync(hookPath, forkRoot ? terminalForkFaultHook : terminalRestorationFaultHook, { mode: 0o660 }); fs.chmodSync(hookPath, 0o660)
    fs.writeFileSync(path.join(local, 'settings.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{
      type: 'command', command: "node '" + hookPath.replaceAll("'", "'\\''") + "'",
    }] }] } }), { mode: 0o660 })
    fs.chmodSync(path.join(local, 'settings.json'), 0o660)
  }
  if (trustRefusal) {
    const profile = JSON.parse(fs.readFileSync(preferencePath, 'utf8'))
    profile.projects ??= {}; profile.projects[workspace] ??= {}
    profile.projects[workspace].hasTrustDialogAccepted = false
    fs.writeFileSync(preferencePath, JSON.stringify(profile), { mode: 0o600 })
  }
  if (hooksDisabled) fs.writeFileSync(path.join(userRoot, 'settings.json'), JSON.stringify({ disableAllHooks: true }), { mode: 0o600 })
  if (unwritableSignal) {
    const hookPath = path.join(workspace, 'native-unwritable-signal.sh')
    fs.writeFileSync(hookPath, 'set -eu\nmkdir -p -- "$FRESHELL_NATIVE_IDENTITY_SIGNAL_DIR"\nchmod 500 -- "$FRESHELL_NATIVE_IDENTITY_SIGNAL_DIR"\nprintf \'%s\\n\' \'{}\'\n', { mode: 0o660 })
    fs.chmodSync(hookPath, 0o660)
    const command = "sh '" + hookPath.replaceAll("'", "'\\''") + "'"
    fs.writeFileSync(path.join(userRoot, 'settings.json'), JSON.stringify({ hooks: {
      SessionStart: [{ hooks: [{ type: 'command', command }] }],
    } }), { mode: 0o600 })
  }
  const supervisor = await harness.startSupervisor({ scenarioId: scenario, binaryKind: 'release',
    env: { HOME: home, FRESHELL_MANAGED_PROVIDER_QUALIFICATION: 'claude' } })
  const soulId = 'soul-' + randomUUID()
  const nativeRoot = staleSignal ? JSON.parse(Buffer.from(priorSignals.signals.find((row: any) => row.name === 'session-start.json').bytesBase64, 'base64').toString('utf8')).native.session_id : randomUUID()
  const actualRoot = caseId === 'wrong-root' ? randomUUID() : nativeRoot
  let managedPreparation: any
  if (resumes) {
    const { RustServer } = await import('../../test/e2e-browser/helpers/rust-server.js')
    const server = new RustServer({ homeDir: home, preserveHomeOnStop: true,
      env: { FRESHELL_BIND_HOST: '0.0.0.0', FRESHELL_MANAGED_RUNTIME_V1: '1',
        FRESHELL_RUNTIME_CONTROL_SOCKET: supervisor.controlSocket,
        FRESHELL_RUNTIME_CONTROL_SECRET_FILE: supervisor.controlSecretFile,
        FRESHELL_MANAGED_PROVIDER_QUALIFICATION: 'claude',
        FRESHELL_MANAGED_CLAUDE_ONECLI_ENV_FILE: grants[0]!.sourcePath,
        FRESHELL_MANAGED_CLAUDE_ONECLI_CA_FILE: grants[1]!.sourcePath },
      stripEnvPrefixes: ['GEMINI_', 'GOOGLE_API_KEY', 'ANTHROPIC_', 'CLAUDE_', 'OPENAI_', 'LUNAROUTE_'],
      setupHome: async (selectedHome) => {
        const config = path.join(selectedHome, '.freshell'); fs.mkdirSync(config, { recursive: true, mode: 0o700 })
        fs.writeFileSync(path.join(config, 'config.json'), JSON.stringify({ version: 1, settings: {
          defaultCwd: workspace, codingCli: { enabledProviders: ['claude'], providers: { claude: { model: 'claude-haiku-4-5-20251001', reasoningEffort: 'low' } } },
        } }), { mode: 0o600 })
      } })
    const owned = { server, scope: scenario, pid: undefined as number | undefined }; servers.push(owned)
    const previous = process.env.FRESHELL_E2E_RUST_SERVER_BIN
    process.env.FRESHELL_E2E_RUST_SERVER_BIN = serverPath
    try {
      const info = await server.start(); owned.pid = info.pid
      harness.writeArtifact(`${scenario}-server-private.json`, { ...info, ...server.processEvidence(),
        executableSha256: createHash('sha256').update(fs.readFileSync(serverPath!)).digest('hex') })
    } finally {
      if (previous === undefined) delete process.env.FRESHELL_E2E_RUST_SERVER_BIN
      else process.env.FRESHELL_E2E_RUST_SERVER_BIN = previous
    }
    managedPreparation = await new Promise((resolve, reject) => {
      const socket = createConnection(path.join(path.dirname(supervisor.controlSocket), 'mcp.sock'))
      const chunks: Buffer[] = []
      socket.setTimeout(5_000, () => socket.destroy(new Error('actual native capability issue timed out')))
      socket.once('connect', () => socket.end(JSON.stringify({ action: 'issue', controlSecret: supervisor.controlSecret,
        soulId, incarnationId: null, grantId: null, provider: 'claude', tuiSource: null, workspace, cwd: workspace })))
      socket.on('data', (chunk: Buffer) => chunks.push(chunk))
      socket.once('error', reject)
      socket.once('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { reject(new Error('actual native capability issue failed')) }
      })
    })
    harness.writeArtifact(`${scenario}-managed-preparation-private.json`, managedPreparation)
    if (!managedPreparation.context?.mcpCapability || !managedPreparation.secretReferences?.length) {
      throw new Error('actual native managed capability/preparation missing')
    }
  }
  const settings = JSON.stringify({ hooks: {
    SessionStart: [{ hooks: [{ type: 'command', command: 'sh -lc \'d="$HOME/.freshell/session-signals/claude"; n=$(date +%s%N 2>/dev/null); case "$n" in *[!0-9]*|"") n="$(date +%s)000000000";; esac; f="$d/${FRESHELL_TERMINAL_ID:-unknown}__$n-$$"; mkdir -p "$d" && cat > "$f.tmp" && mv "$f.tmp" "$f.json"\' 2>/dev/null || true' }] }],
    Stop: [{ hooks: [{ type: 'command', command: "printf '%s\\n' '{\"terminalSequence\":\"\\u0007\"}'" }] }],
  } })
  const request = { method: 'launch', params: { soulId, provider: 'claude', providerStoreId: 'store-' + randomUUID(),
    nativeSessionId: nativeRoot, creationSeedRef: 'native-create-' + randomUUID(), profile: 'custom', projectKey: scenario,
    limits: { cpuMilli: 2000, memoryBytes: 2 * 1024 ** 3, swapBytes: 0, pidsMax: 256 },
    terminal: { terminalId: 'native-terminal-' + randomUUID(), streamId: 'native-stream-' + randomUUID(),
      mode: 'claude', program: 'claude', args: ['--settings', settings, '--session-id', actualRoot,
        '--model', 'claude-haiku-4-5-20251001', '--effort', 'low', ...(forkRoot ? ['--fork-session'] : [])],
      env: { HOME: '/home/freshell/provider', CLAUDE_CONFIG_DIR: '/home/freshell/provider/.claude', TERM: 'xterm-256color' },
      cwd: workspace, workspacePath: workspace, runAsUid: 65534, runAsGid: 0, cols: 100, rows: 30, projectKey: scenario,
      providerModel: 'claude-haiku-4-5-20251001', providerReasoningEffort: 'low', providerSecretReferences: managedPreparation?.secretReferences ?? grants,
      providerLaunchContext: managedPreparation?.context ?? { preparation: { claude: { mcp_args: [] } }, config: [{ root: 'user_provider',
        relativePath: '.claude.json', providerRelativePath: '.claude/.claude.json', format: 'json' },
        ...(hooksDisabled || unwritableSignal ? [{ root: 'user_provider', relativePath: 'settings.json', providerRelativePath: '.claude/settings.json', format: 'json' }] : [])] } } } }
  harness.writeArtifact(`${scenario}-request.json`, request)
  const inspectTerminalNative = async (containerId: string) => JSON.parse(await harness.execOwnedContainerAsExact(containerId, '65534:0',
    ['python3', '-c', claudeNativeInspection, actualRoot, 'false', 'terminal', ...(hooksDisabled ? ['disabled-hooks'] : trustRefusal ? ['trust-refusal'] : unwritableSignal ? ['unwritable-signal'] : [])]))
  const wrongRoot = caseId === 'wrong-root'
  const startupRefusal = wrongRoot || hooksDisabled || trustRefusal || unwritableSignal
  const refusalReason = staleSignal ? 'stale shared native signals' : unwritableSignal ? 'unwritable current native signal directory' : trustRefusal ? 'unaccepted native trust' : nativeTimeout ? 'native startup timeout'
    : providerExit ? 'exited native provider' : stopCancellation ? 'cancelled native startup'
      : hooksDisabled ? 'disabled native hooks' : 'wrong current native root'
  const launchStartedAt = Date.now()
  let beforeFault: any
  let faultResult: any
  let result: any
  if (pendingFault) {
    let finished = false
    let launchError: unknown
    const launch = harness.adminRaw(supervisor, request).then(
      (reply) => { result = reply; finished = true },
      (error) => { launchError = error; finished = true },
    )
    await Promise.resolve()
    if (finished && launchError) throw launchError
    const deadline = Date.now() + 6_000
    let receipt: ReturnType<typeof harness.broker.receipts>[number] | undefined
    const captureErrors: string[] = []
    while (!finished && Date.now() < deadline) {
      receipt = harness.broker.receipts().find((owned) => owned.soulId === soulId)
      if (receipt) {
        try {
          beforeFault = await inspectTerminalNative(receipt.containerId)
          break
        } catch (error) { captureErrors.push(String(error)) }
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    harness.writeArtifact(`${scenario}-before-fault-attempts-private.json`, captureErrors)
    if (!beforeFault || !receipt || finished || beforeFault.hook || beforeFault.loaded
      || !Number.isSafeInteger(beforeFault.nativePid) || beforeFault.nativePid <= 1
      || beforeFault.uid !== 65534 || beforeFault.gid !== 0 || beforeFault.caps !== '0000000000000000'
      || !beforeFault.readOnlyRoot || beforeFault.httpsStatus !== 200 || beforeFault.tlsVerifyMode !== 2 || !beforeFault.tlsCheckHostname
      || beforeFault.hooksDisabled !== true || !beforeFault.version.startsWith('2.1.263')
      || beforeFault.nativeCwd !== workspace || beforeFault.nativeArgv?.[beforeFault.nativeArgv.indexOf('--model') + 1] !== 'claude-haiku-4-5-20251001') {
      await launch
      harness.writeArtifact(`${scenario}-unexpected-launch-private.json`, { result, error: String(launchError ?? '') })
      throw new Error('actual unobserved native child unavailable before startup fault')
    }
    harness.writeArtifact(`${scenario}-before-fault-native-private.json`, beforeFault)
    if (staleSignal) {
      faultResult = JSON.parse(await harness.execOwnedContainerAsExact(receipt.containerId, '65534:0', ['python3', '-c', String.raw`
import pathlib,os,json,hashlib,base64,sys
pid=sys.argv[1];prior=json.loads(sys.argv[2]);p=pathlib.Path('/proc')/pid
env=dict(v.decode().split('=',1) for v in (p/'environ').read_bytes().split(b'\0') if b'=' in v)
current=json.loads(env['FRESHELL_NATIVE_IDENTITY_LAUNCH']);directory=pathlib.Path(env['FRESHELL_NATIVE_IDENTITY_SIGNAL_DIR'])
assert current['launchNonce']!=prior['launch']['launchNonce'] and current['incarnationId']!=prior['launch']['incarnationId']
assert directory.parent==pathlib.Path('/home/freshell/provider/.freshell/native-identity') and directory.name==current['launchNonce']
directory.mkdir(parents=True,exist_ok=True)
for row in prior['signals']:
 assert row['name'] in ['session-start.json','statusline-loaded.json']
 raw=base64.b64decode(row['bytesBase64']);assert len(raw)<=65536 and hashlib.sha256(raw).hexdigest()==row['sha256']
 parsed=json.loads(raw);assert parsed['launch']==prior['launch']
 target=directory/row['name'];assert not target.exists();target.write_bytes(raw)
print(json.dumps({'priorLaunch':prior['launch'],'currentLaunch':current,'signalSha256':[hashlib.sha256((directory/row['name']).read_bytes()).hexdigest() for row in prior['signals']]}))
`, String(beforeFault.nativePid), JSON.stringify(priorSignals)]))
      harness.writeArtifact(`${scenario}-stale-signal-injection-private.json`, faultResult)
    } else if (providerExit) harness.killOwnedRuntimePidExact(receipt.containerId, beforeFault.nativePid, 'TERM')
    else {
      faultResult = await harness.adminOk(supervisor, harness.stopBody(soulId))
      harness.writeArtifact(`${scenario}-ordinary-stop.json`, faultResult)
    }
    await launch
    if (launchError) throw launchError
    if (providerExit) {
      const deadline = Date.now() + 3_000
      do {
        faultResult = JSON.parse(await harness.execOwnedContainerAsExact(receipt.containerId, '65534:0',
          ['python3', '-c', "import pathlib,json,sys;print(json.dumps({'nativeExited':not (pathlib.Path('/proc')/sys.argv[1]/'exe').exists()}))", String(beforeFault.nativePid)]))
        if (faultResult.nativeExited) break
        await new Promise((resolve) => setTimeout(resolve, 100))
      } while (Date.now() < deadline)
      harness.writeArtifact(`${scenario}-native-exit.json`, faultResult)
    }
  } else {
    try { result = startupRefusal ? await harness.adminRaw(supervisor, request) : await harness.adminOk(supervisor, request) }
    catch (error) {
      if (restorationFailure) {
        const receipt = harness.broker.receipts().find((owned) => owned.soulId === soulId)
        if (receipt) {
          try {
            harness.writeArtifact(`${scenario}-failed-startup-terminal-private.json`, await harness.adminRaw(supervisor,
              harness.terminalReadOutputBody(soulId)))
            harness.writeArtifact(`${scenario}-failed-startup-native-private.json`, JSON.parse(await harness.execOwnedContainerAsExact(receipt.containerId,
              '65534:0', ['python3', '-c', String.raw`
import pathlib,hashlib,json,os
selected=pathlib.Path('/usr/local/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe');expected=hashlib.sha256(selected.read_bytes()).hexdigest();rows=[]
for p in pathlib.Path('/proc').iterdir():
 if not p.name.isdigit():continue
 try:
  if hashlib.sha256((p/'exe').read_bytes()).hexdigest()!=expected:continue
  env=dict(v.decode().split('=',1) for v in (p/'environ').read_bytes().split(b'\0') if b'=' in v)
  directory=pathlib.Path(env['FRESHELL_NATIVE_IDENTITY_SIGNAL_DIR'])
  rows.append({'nativePid':int(p.name),'executableSha256':expected,'nativeCwd':str((p/'cwd').resolve()),'launch':json.loads(env['FRESHELL_NATIVE_IDENTITY_LAUNCH']),
   'hook':json.loads((directory/'session-start.json').read_text()) if (directory/'session-start.json').exists() else None,
   'loaded':json.loads((directory/'statusline-loaded.json').read_text()) if (directory/'statusline-loaded.json').exists() else None})
 except (OSError,ValueError):continue
print(json.dumps({'uid':os.getuid(),'gid':os.getgid(),'processes':rows}))
`])))
          } catch (captureError) { harness.writeArtifact(`${scenario}-failed-startup-capture-error.json`, { reason: String(captureError) }) }
        }
      }
      throw error
    }
  }
  const launchElapsedMs = Date.now() - launchStartedAt
  harness.writeArtifact(`${scenario}-launch.json`, result)
  harness.writeArtifact(`${scenario}-launch-timing.json`, { elapsedMs: launchElapsedMs })
  let view: any
  if (startupRefusal) {
    const failure = `${refusalReason} published a running launch`
    if (result.result?.Err?.code !== (stopCancellation ? 'STALE_INTENT_REVISION' : 'RECOVERY_BLOCKED')) throw new Error(failure)
    const inventory = await harness.adminOk(supervisor, harness.inventoryBody())
    harness.writeArtifact(`${scenario}-inventory.json`, inventory)
    view = inventory.data.find((row: any) => row.soulId === soulId)
    if (view?.launchState !== (stopCancellation ? 'stopped' : 'starting') || view.nativeIdentityObservation) throw new Error(failure)
  } else view = result.data.view
  const deadline = Date.now() + 50_000
  while (!startupRefusal && !view.nativeIdentityObservation && Date.now() < deadline) {
    harness.writeArtifact(`${scenario}-terminal-output-private.json`, await harness.adminOk(supervisor, harness.terminalReadOutputBody(soulId)))
    // Refresh asynchronous PTY evidence through the existing host snapshot
    // probe before reading the registry's stored observation.
    harness.writeArtifact(`${scenario}-store-probe.json`, await harness.adminOk(supervisor, harness.probeRecoveryBody(soulId)))
    const inventory = await harness.adminOk(supervisor, harness.inventoryBody())
    harness.writeArtifact(`${scenario}-inventory.json`, inventory)
    view = inventory.data.find((row: any) => row.soulId === soulId)
    if (!view) throw new Error('owned terminal Claude view disappeared')
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  harness.writeArtifact(`${scenario}-current-view.json`, view)
  const nativeSignals = startupFault ? { beforeFault, faultResult } : JSON.parse(await harness.execOwnedContainerAsExact(view.containerId,
    '65534:0', ['python3', '-c', String.raw`
import pathlib,json,os,hashlib,base64
selected=pathlib.Path('/usr/local/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe')
expected=hashlib.sha256(selected.read_bytes()).hexdigest();processes=[]
for p in pathlib.Path('/proc').iterdir():
 if not p.name.isdigit():continue
 try:
  if hashlib.sha256((p/'exe').read_bytes()).hexdigest()!=expected:continue
  env=dict(v.decode().split('=',1) for v in (p/'environ').read_bytes().split(b'\0') if b'=' in v)
  directory=env.get('FRESHELL_NATIVE_IDENTITY_SIGNAL_DIR');signals=[]
  for name in ['session-start.json','statusline-loaded.json']:
   try:
    f=pathlib.Path(directory)/name if directory else None
    raw=f.read_bytes() if f else None
    if raw is not None and len(raw)>65536:signals.append({'name':name,'error':'oversized'});continue
    signals.append({'name':name,'bytesBase64':base64.b64encode(raw).decode() if raw is not None else None,'sha256':hashlib.sha256(raw).hexdigest() if raw is not None else None})
   except OSError as e:signals.append({'name':name,'errno':e.errno})
  processes.append({'pid':int(p.name),'executableSha256':expected,'launch':json.loads(env['FRESHELL_NATIVE_IDENTITY_LAUNCH']) if env.get('FRESHELL_NATIVE_IDENTITY_LAUNCH') else None,'signalDir':directory,'signals':signals})
 except (OSError,ValueError):continue
print(json.dumps({'readerUid':os.getuid(),'readerGid':os.getgid(),'processes':processes}))
`]))
  harness.writeArtifact(`${scenario}-signal-native-private.json`, nativeSignals)
  const observation = view.nativeIdentityObservation
  const currentObservation = !!observation && view.recoveryState === 'live' && observation.source === 'claude_native_event'
    && observation.nativeSessionId === nativeRoot && view.nativeSessionId === nativeRoot
    && observation.incarnationId === view.incarnationId
  if (startupRefusal ? !!observation : !currentObservation) throw new Error('terminal Claude current post-load observation missing')
  const namespace = staleSignal ? await inspectTerminalNative(view.containerId) : beforeFault ?? await inspectTerminalNative(view.containerId)
  harness.writeArtifact(`${scenario}-namespace-native-private.json`, namespace)
  const noCallbacks = hooksDisabled || trustRefusal || unwritableSignal
  const selectedModel = noCallbacks ? namespace.nativeArgv?.[namespace.nativeArgv.indexOf('--model') + 1] : namespace.loaded?.native?.model?.id
  const selectedCwd = noCallbacks ? namespace.nativeCwd : namespace.loaded?.native?.workspace?.current_dir
  const staleMatches = (captured: any) => staleNativeSignalBindingMatches(captured, priorSignals.launch, faultResult.currentLaunch, nativeRoot)
  const loaderMatches = staleSignal ? staleMatches(namespace) : noCallbacks
    ? namespace.hook === null && namespace.loaded === null
      && (trustRefusal ? namespace.nativePreferences?.workspaceTrust === false : unwritableSignal
        ? namespace.signalWritable === false && namespace.signalMode === '0o500' && namespace.hooksDisabled !== true
        : namespace.hooksDisabled === true)
    : namespace.loaded?.native?.version === '2.1.263' && namespace.loaded.native.session_id === actualRoot
      && JSON.stringify(namespace.loaded.launch) === JSON.stringify(namespace.hook.launch)
  if (namespace.uid !== 65534 || namespace.gid !== 0 || namespace.caps !== '0000000000000000'
    || !namespace.readOnlyRoot || namespace.httpsStatus !== 200 || namespace.tlsVerifyMode !== 2 || !namespace.tlsCheckHostname
    || !namespace.version.startsWith('2.1.263') || !loaderMatches
    || selectedModel !== 'claude-haiku-4-5-20251001' || selectedCwd !== workspace) {
    throw new Error('actual terminal Claude pin/profile/namespace/TLS differs')
  }
  if (nativeTimeout && (launchElapsedMs < 8_000 || launchElapsedMs >= 50_000)) throw new Error('native startup timeout did not respect its bounded wait')
  if (!startupRefusal) {
    // Exercise the ordinary output/store path before starting a paid seed.
    // Input ACKs cannot hide a dispatcher or store failure at this boundary.
    harness.writeArtifact(`${scenario}-pre-input-terminal-private.json`, await harness.adminOk(supervisor,
      harness.terminalReadOutputBody(soulId)))
    harness.writeArtifact(`${scenario}-pre-input-store-probe.json`, await harness.adminOk(supervisor,
      harness.probeRecoveryBody(soulId)))
  }
  const assertions = startupRefusal ? [{ name: staleSignal ? 'genuine-prior-launch-shared-signals-refused-before-running-and-input' : unwritableSignal ? 'actual-native-signal-write-refused-before-running-and-input' : trustRefusal ? 'actual-native-trust-refused-before-running-and-input'
    : nativeTimeout ? 'bounded-actual-native-startup-timeout-before-running-and-input'
      : providerExit ? 'actual-native-provider-exit-refused-before-running-and-input'
        : stopCancellation ? 'ordinary-stop-cancels-native-startup-before-running-and-input'
          : hooksDisabled ? 'actual-disabled-native-hooks-refused-before-running-and-input' : 'wrong-current-native-root-refused-before-running-and-input', pass: false }]
    : [{ name: 'actual-terminal-current-native-post-load-observation-before-input', pass:
      observation.nativeSessionId === namespace.loaded.native.session_id && observation.incarnationId === view.incarnationId }]
  if (startupRefusal) {
    if (trustRefusal) {
      const output = await harness.adminOk(supervisor, harness.terminalReadOutputBody(soulId))
      harness.writeArtifact(`${scenario}-native-trust-terminal-private.json`, output)
      if (!/trust/i.test(output.data.frames.map((frame: any) => frame.data).join(''))) throw new Error('actual native trust prompt unavailable')
    }
    const rejected = await harness.adminRaw(supervisor, harness.terminalInputBody(soulId, 'Owned blocked startup probe. Do not use tools.\r'))
    harness.writeArtifact(`${scenario}-input-refusal.json`, rejected)
    const after = startupFault ? namespace : await inspectTerminalNative(view.containerId)
    harness.writeArtifact(`${scenario}-after-refused-input-native-private.json`, after)
    // No Running incarnation exists, so the ordinary input route has no
    // admissible target. Inspect actual provider state separately.
    const nativeStateSafe = startupFault ? namespace.completedTurns === 0 && namespace.toolEvents === 0
      : JSON.stringify(namespace.transcript) === JSON.stringify(after.transcript)
        && (staleSignal ? staleMatches(after) && after.completedTurns === 0 && after.toolEvents === 0
          : noCallbacks ? (!after.hook && !after.loaded && (trustRefusal ? after.nativePreferences?.workspaceTrust === false
          : unwritableSignal ? after.signalWritable === false && after.signalMode === '0o500' && after.hooksDisabled !== true : after.hooksDisabled === true)
          && after.completedTurns === 0 && after.toolEvents === 0)
          : (actualRoot !== nativeRoot && namespace.hook.native.session_id === actualRoot
            && after.loaded.native.context_window.total_input_tokens === 0 && after.loaded.native.context_window.total_output_tokens === 0))
    assertions[0]!.pass = !observation
      && view.launchState === (stopCancellation ? 'stopped' : 'starting') && rejected.result?.Err?.code === 'UNKNOWN_SOUL'
      && nativeStateSafe
    if (!assertions[0]!.pass) throw new Error(`${refusalReason} released ordinary input or changed native state`)
    if (startupFault) {
      const closed = providerExit ? faultResult.nativeExited === true
        : faultResult.data.outcome === 'verified_empty' && view.recoveryState === 'stopped' && view.desiredState === 'stopped'
      if (!closed) throw new Error('owned native startup fault did not close its process or Stop transaction')
      assertions.push({ name: providerExit ? 'exact-owned-native-pid-exited' : 'ordinary-stop-verified-empty-and-stopped-intent', pass: closed })
    }
  }
  let nativeOriginals: NativeExperimentOriginal['nativeOriginals']
  if (resumes) {
    const nativeRequests = new Map<string, NativeOriginalReference>(), initialObservedAt = Date.now()
    const inspect = async (containerId: string, label: string) => {
      const current = JSON.parse(await harness.execOwnedContainerAsExact(containerId, '65534:0',
        ['python3', '-c', claudeNativeInspection, actualRoot, 'false', 'terminal']))
      if (caseId === 'current-native-turn') retainOwnedNativeProbe(current, containerId)
      harness.writeArtifact(`${scenario}-${label}-native-private.json`, current)
      return current
    }
    // Count completed native model IDs, never the transport's input ACK.
    const turn = async (containerId: string, text: string, label: string) => {
      const before = await inspect(containerId, label + '-before-input')
      // Keep paste content and the submit key as distinct ordinary gestures;
      // a bulk text/CR packet can remain in the native TUI's paste buffer.
      const requests: any[] = []
      const gesture = async (body: any, name: string) => {
        const requestId = 'request-' + randomUUID(), sentAt = Date.now()
        const reply = await harness.adminOk(supervisor, body, { requestId })
        requests.push({ requestId, sentAt, request: body, reply }); harness.writeArtifact(name, reply)
      }
      await gesture(harness.terminalInputBody(soulId, '\x1b[200~' + text + '\x1b[201~'), `${scenario}-${label}-paste-dispatch.json`)
      await new Promise((resolve) => setTimeout(resolve, 100))
      await gesture(harness.terminalInputBody(soulId, '\r'), `${scenario}-${label}-dispatch.json`)
      if (caseId === 'current-native-turn') nativeRequests.set(label, writeNativeOriginal(harness, `${scenario}-${label}-request-original.json`, { requests }))
      const deadline = Date.now() + 90_000
      while (Date.now() < deadline) {
        const current = await inspect(containerId, label)
        harness.writeArtifact(`${scenario}-${label}-terminal-private.json`, await harness.adminOk(supervisor, harness.terminalReadOutputBody(soulId)))
        if (current.toolEvents > before.toolEvents) throw new Error('ordinary terminal Claude seed unexpectedly requested a tool')
        if (current.completedTurns > before.completedTurns && current.transcript?.completeEof) return current
        await new Promise((resolve) => setTimeout(resolve, 200))
      }
      throw new Error('bounded ordinary terminal Claude turn deadline exceeded')
    }
    const marker = 'owned-memory-' + randomUUID()
    const seed = await turn(view.containerId, `Remember this private marker: ${marker}. Reply stored. Do not use tools.`, 'seed')
    const probe = await harness.adminOk(supervisor, harness.probeRecoveryBody(soulId))
    harness.writeArtifact(`${scenario}-completed-store-probe.json`, probe)
    if (probe.data.kind !== 'reattach_ready') throw new Error('completed terminal Claude store not readable before death')
    if (forkRoot) {
      const controlPath = path.join(workspace, 'native-fork-fault-control.json')
      fs.writeFileSync(controlPath, JSON.stringify({ root: nativeRoot, seedSha256: seed.transcript.sha256,
        seedBytes: Buffer.from(seed.transcript.bytesBase64, 'base64').length, identity: seed.transcript.identity.slice(0, 2) }), { mode: 0o660 })
      fs.chmodSync(controlPath, 0o660)
    }
    if (restorationFailure) {
      const mutation = JSON.parse(await harness.execOwnedContainerAsExact(view.containerId, '65534:0', ['python3', '-c', claudeNativeRestorationFault, nativeRoot, seed.transcript.sha256, JSON.stringify(seed.transcript.identity)]))
      harness.writeArtifact(`${scenario}-owned-before-load-mutation-private.json`, mutation)
      const malformedProbe = await harness.adminOk(supervisor, harness.probeRecoveryBody(soulId))
      harness.writeArtifact(`${scenario}-malformed-before-load-store-probe.json`, malformedProbe)
      if (malformedProbe.data.kind !== 'reattach_ready' || mutation.uid !== 65534 || mutation.gid !== 0
        || mutation.beforeSha256 !== seed.transcript.sha256 || mutation.changedAssistantRows < 1) {
        throw new Error('bounded native loader fault did not retain the owned current store route')
      }
      const controlPath = path.join(workspace, 'native-restoration-fault-control.json')
      fs.writeFileSync(controlPath, JSON.stringify(mutation), { mode: 0o660 }); fs.chmodSync(controlPath, 0o660)
    }
    const requestedAt = Date.now()
    await harness.killOwnedRuntimeExact(view.containerId)
    await harness.waitForContainerExit(view.containerId)
    const exitedAt = Date.now()
    const recovery = restorationFailure || forkRoot ? await harness.adminRaw(supervisor, harness.recoverBody(soulId, 'host_unreachable'))
      : await harness.adminOk(supervisor, harness.recoverBody(soulId, 'host_unreachable'))
    const replacementObservedAt = Date.now()
    harness.writeArtifact(`${scenario}-recovery.json`, recovery)
    if (forkRoot) {
      const faultPath = path.join(workspace, 'native-fork-fault-observation.json')
      const deadline = Date.now() + 3_000
      while (!fs.existsSync(faultPath) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50))
      const fault = JSON.parse(fs.readFileSync(faultPath, 'utf8'))
      harness.writeArtifact(`${scenario}-fork-native-event-private.json`, fault)
      const inventory = await harness.adminOk(supervisor, harness.inventoryBody())
      harness.writeArtifact(`${scenario}-fork-current-inventory.json`, inventory)
      const current = inventory.data.filter((row: any) => row.soulId === soulId)
      const contained = recovery.result?.Ok?.data?.outcome === 'blocked' && current.every((row: any) =>
        row.launchState !== 'running' && row.nativeIdentityObservation?.incarnationId !== fault.launch.incarnationId)
      const currentNativeFork = fault.native.source === 'fork' && fault.native.session_id !== nativeRoot
        && fault.launch.requestedNativeSessionId === nativeRoot
        && fault.launch.incarnationId !== view.incarnationId && fault.launch.launchNonce !== namespace.hook.launch.launchNonce
        && fault.uid === 65534 && fault.gid === 0 && fault.nativeExecutableSha256 === namespace.executableSha256
        && fault.nativeArgv.includes('--fork-session') && fault.nativeArgv.includes('--resume')
      const originalRetained = fault.originalPrefixSha256 === seed.transcript.sha256
        && JSON.stringify(fault.identity) === JSON.stringify(seed.transcript.identity.slice(0, 2))
      if (!contained || !currentNativeFork || !originalRetained) throw new Error('actual native fork root was not contained before input')
      const input = await harness.adminRaw(supervisor, harness.terminalInputBody(soulId, 'Owned blocked native fork probe. Do not use tools.\r'))
      harness.writeArtifact(`${scenario}-fork-input-refusal.json`, input)
      if (!input.result?.Err) throw new Error('actual native fork admitted ordinary input')
      assertions.push({ name: 'readable-completed-native-store-before-death', pass: probe.data.kind === 'reattach_ready' },
        { name: 'genuine-native-exact-resume-fork-selected-a-different-root', pass: currentNativeFork },
        { name: 'original-owned-root-file-retained-across-refused-fork', pass: originalRetained },
        { name: 'native-fork-refused-running-and-current-observation', pass: contained },
        { name: 'native-fork-refused-ordinary-input', pass: !!input.result?.Err })
    } else if (restorationFailure) {
      const faultPath = path.join(workspace, 'native-restoration-fault-observation.json')
      const deadline = Date.now() + 6_000
      while (!fs.existsSync(faultPath) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50))
      const fault = JSON.parse(fs.readFileSync(faultPath, 'utf8'))
      harness.writeArtifact(`${scenario}-restoration-fault-private.json`, fault)
      const inventory = await harness.adminOk(supervisor, harness.inventoryBody())
      harness.writeArtifact(`${scenario}-after-restoration-failure-inventory.json`, inventory)
      const current = inventory.data.filter((row: any) => row.soulId === soulId)
      const contained = recovery.result?.Ok?.data?.outcome === 'blocked'
        && current.every((row: any) => row.launchState !== 'running'
          && row.nativeIdentityObservation?.incarnationId !== fault.hook.launch.incarnationId)
      if (!contained) throw new Error('native restoration fault published Running; no input probe dispatched')
      const input = await harness.adminRaw(supervisor, harness.terminalInputBody(soulId, 'Owned failed restoration input probe. Do not use tools.\r'))
      harness.writeArtifact(`${scenario}-after-restoration-failure-input-refusal.json`, input)
      const inputRefused = !!input.result?.Err
      const nativeExitedUnloaded = fault.nativeExited === true && fault.loadedSha256 === null
      const currentHook = fault.hook.native.source === 'resume' && fault.hook.native.session_id === nativeRoot
        && fault.hook.launch.requestedNativeSessionId === nativeRoot
        && fault.hook.launch.launchNonce !== namespace.hook.launch.launchNonce
        && fault.hook.launch.incarnationId !== view.incarnationId
      const ownedFault = fault.beforeSha256 === seed.transcript.sha256 && fault.beforeSha256 !== fault.afterSha256
        && fault.observedFaultPrefixSha256 === fault.afterSha256
        && fault.changedAssistantRows >= 1 && fault.uid === 65534 && fault.gid === 0
        && fault.nativeExecutableSha256 === namespace.executableSha256
      if (!contained || !inputRefused || !nativeExitedUnloaded || !currentHook || !ownedFault) {
        throw new Error('actual native hook/restoration failure was not contained before input')
      }
      assertions.push({ name: 'readable-completed-native-store-before-death', pass: probe.data.kind === 'reattach_ready' },
        { name: 'genuine-current-resume-hook-before-native-restoration-failure', pass: currentHook && ownedFault },
        { name: 'native-restoration-exit-without-loaded-context-or-running-publication', pass: nativeExitedUnloaded && contained },
        { name: 'failed-native-restoration-refuses-ordinary-input', pass: inputRefused })
    } else {
    const replacement = recovery.data.view
    if (recovery.data.outcome !== 'replaced' || replacement.incarnationId === view.incarnationId
      || replacement.nativeSessionId !== nativeRoot || replacement.recoveryState !== 'live'
      || replacement.nativeIdentityObservation?.source !== 'claude_native_event'
      || replacement.nativeIdentityObservation?.nativeSessionId !== nativeRoot) throw new Error('terminal Claude exact-root replacement failed')
    const restored = await inspect(replacement.containerId, 'after-death')
    const retainedTranscript = seed.transcript.sha256 === restored.transcript?.sha256
      && seed.transcript.identity[0] === restored.transcript?.identity[0]
      && seed.transcript.identity[1] === restored.transcript?.identity[1]
    if (!retainedTranscript) throw new Error('terminal Claude original owned transcript continuity lost')
    const retainedProfile = JSON.stringify(seed.profileFiles.slice(0, 3)) === JSON.stringify(restored.profileFiles.slice(0, 3))
      && JSON.stringify(seed.nativePreferences) === JSON.stringify(restored.nativePreferences)
      && restored.loaded.native.model.id === 'claude-haiku-4-5-20251001' && restored.loaded.native.workspace.current_dir === workspace
    if (!retainedProfile || restored.hook.native.source !== 'resume' || restored.hook.native.session_id !== nativeRoot
      || restored.loaded.launch.incarnationId !== replacement.incarnationId || restored.hook.launch.launchNonce === namespace.hook.launch.launchNonce) {
      throw new Error('terminal Claude current exact-resume profile/loader differs')
    }
    assertions.push({ name: 'readable-completed-native-store-before-death', pass: probe.data.kind === 'reattach_ready' },
      { name: 'replacement-new-incarnation-same-native-root', pass: replacement.incarnationId !== view.incarnationId && replacement.nativeSessionId === nativeRoot },
      { name: 'original-owned-volume-transcript-continuity', pass: retainedTranscript },
      { name: 'same-workspace-selected-native-profile', pass: retainedProfile },
      { name: 'current-native-resume-observation-before-replacement-input', pass: restored.hook.native.source === 'resume' && restored.hook.native.session_id === nativeRoot })
    if (caseId === 'current-native-turn') {
      const recalled = await turn(replacement.containerId, 'Reply with only the private marker from before. Do not use tools.', 'recall')
      if (recalled.lastAssistantText.trim() !== marker || recalled.toolEvents !== 0) throw new Error('terminal Claude native restored context/tool-free recall differs')
      nativeOriginals = retainFamilyNativeTurnOriginals(harness, { scenario, mode: 'claude', provider: 'claude', launchRequest: request, nonce: marker, requestedAt, exitedAt, initial: { view, namespace, capture: seed, observedAt: initialObservedAt, request: nativeRequests.get('seed')!, snapshotPath: seed.hook.native.transcript_path }, replacement: { view: replacement, namespace: recalled, capture: recalled, observedAt: replacementObservedAt, request: nativeRequests.get('recall')!, snapshotPath: recalled.hook.native.transcript_path } })
      assertions.push({ name: 'actual-restored-context-private-marker-recall', pass: recalled.lastAssistantText.trim() === marker },
        { name: 'native-turns-requested-no-tools', pass: seed.toolEvents === 0 && recalled.toolEvents === 0 })
    }
    }
  }
  const original = { caseId, ownerId: harness.runId, candidateSha: harness.candidateSha, imageDigest: harness.imageRef,
    nativeVersion: namespace.version, executableSha256: namespace.executableSha256,
    profileSha256: createHash('sha256').update(JSON.stringify({ preferences: preferences.sha256, profileFiles: namespace.profileFiles,
      model: selectedModel, workspace })).digest('hex'),
    artifactReferences: [`${scenario}-launch.json`, `${scenario}-namespace-native-private.json`, ...(nativeOriginals ? [nativeOriginals.reference.path] : [])], nativeOriginals,
    assertions: [...assertions,
    { name: 'actual-terminal-global-pin-distinct-from-sdk-child', pass: namespace.version.startsWith('2.1.263')
      && (noCallbacks || namespace.loaded.native.version === '2.1.263') },
    { name: 'actual-terminal-selected-model-workspace-profile', pass: selectedModel === 'claude-haiku-4-5-20251001' && selectedCwd === workspace }] }
  harness.writeArtifact(`${scenario}-original.json`, original)
  return original
}

// Finite owned native fault image adapter. It retains the pinned ordinary CLI.
export const nativeAmplifierStartupFaultWrapper = String.raw`#!/opt/amplifier-src/.venv/bin/python
import hashlib,json,os,pathlib,re,runpy,sys
native=pathlib.Path('/opt/amplifier-src/.venv/bin/amplifier.native')
producer=pathlib.Path('/opt/amplifier-src/amplifier_app_cli/freshell_native_resume.py')
expected='b46da0c1095accbb6daf4fffc5936a26e172671713cba6688df4dc5c93c210e4'
producer_pin='1682141140822739c4cd88b7314c3b0daff7ccae1ffb55b7b72f235759123690'
if not native.is_file() or native.is_symlink() or hashlib.sha256(native.read_bytes()).hexdigest()!=expected:
 raise RuntimeError('pinned ordinary Amplifier CLI differs')
if not producer.is_file() or hashlib.sha256(producer.read_bytes()).hexdigest()!=producer_pin:
 raise RuntimeError('pinned native Amplifier producer differs')
workspace=pathlib.Path.cwd().resolve()
owned=re.fullmatch(r'/tmp/frs/[a-f0-9]{8}-[a-f0-9]{3}/amplifier-(missing-history|load-failure|missing-context-restore|timeout|provider-exit|stop-cancellation|parent-root|old-writer)-workspace',str(workspace))
if owned:
 fault=owned[1]
 from amplifier_app_cli.freshell_native_resume import managed_launch,load_native
 binding=managed_launch()
 if binding is None:raise RuntimeError('current native fault launch missing')
 launch,_=binding;root=launch['requestedNativeSessionId']
 if not root or sys.argv[1:]!=['session','resume','--full-history',root]:
  raise RuntimeError('exact owned native resume argv/root differs')
 slug=str(workspace).replace('/', '-').replace(chr(92), '-').replace(':', '')
 if not slug.startswith('-'):slug='-'+slug
 expected_store=pathlib.Path(os.environ['HOME'])/'.amplifier/projects'/slug/'sessions'
 def record(phase,**facts):
  value={'severity':'warning','event':'test.amplifier.native_startup_fault.applied','fault':fault,'phase':phase,
   'launch':launch,'nativePid':os.getpid(),'uid':os.getuid(),'gid':os.getgid(),
   'caps':next(x.split()[1] for x in pathlib.Path('/proc/self/status').read_text().splitlines() if x.startswith('CapEff:')),
   'readOnlyRoot':bool(os.statvfs('/').f_flag&os.ST_RDONLY),'nativeCwd':str(workspace),
   'originalCliSha256':expected,'producerSha256':producer_pin,**facts}
  file=workspace/'native-startup-fault.json'
  with file.open('x',encoding='utf8') as out:json.dump(value,out);out.write('\n')
  file.chmod(0o660)
 def native_context(session):
  context=session.coordinator.get('context')
  if context is None or not callable(getattr(context,'set_messages',None)):
   raise RuntimeError('native original context restore method missing before fault')
  return context
 if fault in ['missing-history','load-failure','parent-root']:
  from amplifier_app_cli.session_store import SessionStore
  original_load=SessionStore.load
  def fault_load(store,session_id):
   if store.base_dir.resolve()!=expected_store.resolve() or session_id!=root:
    raise RuntimeError('native fault store ownership differs')
   directory=store.base_dir/session_id
   if not directory.is_dir() or directory.is_symlink():raise RuntimeError('native owned source missing')
   original,_=load_native(store,session_id)
   if fault=='parent-root':
    import uuid
    parent=str(uuid.uuid4())
    for name in ['metadata.json','metadata.json.backup']:
     file=directory/name
     if file.exists():
      if not file.is_file() or file.is_symlink():raise RuntimeError('unowned native root metadata refused')
      metadata=json.loads(file.read_bytes())
      if metadata.get('session_id')!=root or metadata.get('parent_id') is not None:
       raise RuntimeError('native parent fault original root differs')
      metadata['parent_id']=parent
      with file.open('w',encoding='utf8') as out:json.dump(metadata,out);out.write('\n');out.flush();os.fsync(out.fileno())
    record('before-native-load',originalLoad=original.native_load_witness,nativeParent=parent)
    return original_load(store,session_id)
   for name in ['transcript.jsonl','transcript.jsonl.backup']:
    file=directory/name
    if file.exists():
     if not file.is_file() or file.is_symlink():raise RuntimeError('unowned native history source refused')
     if fault=='missing-history':file.unlink()
     else:
      with file.open('wb') as out:out.write(b'owned invalid native transcript\n');out.flush();os.fsync(out.fileno())
   record('before-native-load',originalLoad=original.native_load_witness,
    transcriptAbsent=not any((directory/name).exists() for name in ['transcript.jsonl','transcript.jsonl.backup']),
    malformedSha256=hashlib.sha256((directory/'transcript.jsonl').read_bytes()).hexdigest() if (directory/'transcript.jsonl').exists() else None)
   return original_load(store,session_id)
  SessionStore.load=fault_load
 elif fault=='missing-context-restore':
  from amplifier_app_cli import session_runner
  original_create=session_runner._create_bundle_session
  async def fault_create(*args,**kwargs):
   session=await original_create(*args,**kwargs)
   original_get=session.coordinator.get;context=native_context(session)
   class ContextWithoutRestore:
    def __getattr__(self,name):
     if name=='set_messages':raise AttributeError(name)
     return getattr(context,name)
   missing=ContextWithoutRestore()
   def fault_get(name,*args,**kwargs):
    return missing if name=='context' else original_get(name,*args,**kwargs)
   session.coordinator.get=fault_get
   record('before-native-context-restore',originalContextType=type(context).__module__+'.'+type(context).__name__,
    hasRestoreBefore=True,hasRestoreAfter=hasattr(session.coordinator.get('context'),'set_messages'))
   return session
  session_runner._create_bundle_session=fault_create
 elif fault=='old-writer':
  from amplifier_app_cli import freshell_native_resume
  original_publish=freshell_native_resume.publish_initialized
  async def stale_publish(session,config):
   prior=workspace/'prior-native-signal.json'
   if not prior.exists():return await original_publish(session,config)
   if prior.is_symlink() or not prior.is_file() or prior.stat().st_size>65536:
    raise RuntimeError('owned previous native signal differs')
   previous_raw=prior.read_bytes();previous=json.loads(previous_raw);old=previous['launch'];native_previous=previous['native']
   if set(old)!=set(launch) or old['requestedNativeSessionId']!=root or native_previous['session_id']!=root or native_previous['parent_id'] is not None:
    raise RuntimeError('previous native root differs')
   if old['incarnationId']==launch['incarnationId'] or old['launchNonce']==launch['launchNonce'] or old['evidenceRevision']>=launch['evidenceRevision']:
    raise RuntimeError('previous native launch is not stale')
   if native_previous['producer_sha256']!=producer_pin or native_previous['load']['sessionId']!=root:
    raise RuntimeError('previous native producer/load differs')
   witness=getattr(config.initial_transcript,'native_load_witness',None)
   if session.session_id!=root or session.parent_id is not None or not config.is_resume or witness is None or witness['sessionId']!=root:
    raise RuntimeError('current native stale-writer root differs')
   freshell_native_resume._revalidate(witness)
   record('before-stale-native-publication',previousLaunch=old,originalLoad=witness,
    previousSignalSha256=hashlib.sha256(previous_raw).hexdigest())
   await freshell_native_resume._publish_initialized(session,config,(old,binding[1]))
   raw=(binding[1]/'amplifier-loaded-context.json').read_bytes()
   with (workspace/'native-stale-publication.json').open('x',encoding='utf8') as out:
    json.dump({'currentLaunch':launch,'nativeSignal':json.loads(raw),'signalText':raw.decode('utf8'),'signalSha256':hashlib.sha256(raw).hexdigest()},out);out.write('\n')
   (workspace/'native-stale-publication.json').chmod(0o660)
  freshell_native_resume.publish_initialized=stale_publish
 else:
  import time
  from amplifier_app_cli import freshell_native_resume
  async def fault_publish(session,config):
   if session.session_id!=root or session.parent_id is not None or not config.is_resume:
    raise RuntimeError('native paused selected root differs')
   witness=getattr(config.initial_transcript,'native_load_witness',None)
   if witness is None or witness['sessionId']!=root or witness['parentId'] is not None:
    raise RuntimeError('native paused load witness missing')
   context=native_context(session)
   accepted=await context.get_messages();original=list(config.initial_transcript)
   if accepted!=original and not (accepted and accepted[0].get('role')=='system' and accepted[1:]==original):
    raise RuntimeError('native paused context restore differs')
   freshell_native_resume._revalidate(witness)
   record('before-native-publication',nativeRoot=session.session_id,nativeParent=session.parent_id,
    originalLoad=witness,acceptedMessageCount=len(accepted))
   # A finite observation fault. No input or fabricated loader event is used,
   # and expiration cannot later publish an acknowledgement.
   time.sleep(12)
   await session.cleanup()
   raise RuntimeError('owned native startup publication withheld')
  freshell_native_resume.publish_initialized=fault_publish
runpy.run_path(str(native),run_name='__main__')
`

export const amplifierWrongRootInspection = String.raw`
import os,json,pathlib,hashlib,importlib.metadata as m,sys
os.chdir(sys.argv[1]);actual_root,nonce=sys.argv[2:]
from types import SimpleNamespace
from amplifier_app_cli.freshell_native_resume import load_native
slug=str(pathlib.Path.cwd().resolve()).replace('/', '-').replace(chr(92), '-').replace(':', '')
if not slug.startswith('-'):slug='-'+slug
directory=pathlib.Path('/home/freshell/provider/.amplifier/projects')/slug/'sessions'/actual_root
assert directory.is_dir() and not directory.is_symlink()
for name in ['transcript.jsonl','metadata.json']:
 assert (directory/name).is_file() and not (directory/name).is_symlink()
loaded,metadata=load_native(SimpleNamespace(base_dir=directory.parent),actual_root)
p=pathlib.Path('/opt/amplifier-src/.venv/bin/amplifier');producer=pathlib.Path('/opt/amplifier-src/amplifier_app_cli/freshell_native_resume.py')
signal=pathlib.Path('/home/freshell/provider/.freshell/native-identity')/nonce/'amplifier-loaded-context.json'
print(json.dumps({'uid':os.getuid(),'gid':os.getgid(),'caps':next(x.split()[1] for x in pathlib.Path('/proc/self/status').read_text().splitlines() if x.startswith('CapEff:')),'readOnlyRoot':bool(os.statvfs('/').f_flag&os.ST_RDONLY),'executableSha256':hashlib.sha256(p.read_bytes()).hexdigest(),'producerSha256':hashlib.sha256(producer.read_bytes()).hexdigest(),'cliVersion':m.version('amplifier-app-cli'),'coreVersion':m.version('amplifier-core'),'signalAbsent':not signal.exists(),'nativeRoot':metadata['session_id'],'parentId':metadata.get('parent_id'),'messageCount':len(loaded),'load':loaded.native_load_witness}))
`

export const amplifierNativeAckFileFault = String.raw`
import os,pathlib,json,hashlib,sys,re
fault=sys.argv[1];expected=json.loads(sys.argv[2]);launch=expected['launch'];nonce=launch['launchNonce']
assert fault in ['file-replacement','file-truncation','malformed-ack'] and re.fullmatch(r'[a-zA-Z0-9_-]+',nonce)
assert os.getuid()==65534 and os.getgid()==0
file=pathlib.Path('/home/freshell/provider/.freshell/native-identity')/nonce/'amplifier-loaded-context.json'
assert file.is_file() and not file.is_symlink()
before=file.stat();raw=file.read_bytes();check=file.stat()
identity=lambda s:[str(s.st_dev),str(s.st_ino),str(s.st_size)]
assert identity(before)==identity(check) and raw.endswith(b'\n') and json.loads(raw)==expected
if fault=='file-replacement':
 temporary=file.with_name('owned-native-ack-replacement.tmp')
 with temporary.open('xb') as out:out.write(raw);out.flush();os.fsync(out.fileno())
 temporary.chmod(before.st_mode&0o777);temporary.replace(file)
else:
 with file.open('r+b') as out:
  if fault=='file-truncation':out.truncate(len(raw)-1)
  else:out.write(b'owned malformed native acknowledgement\n');out.truncate()
  out.flush();os.fsync(out.fileno())
after=file.stat();changed=file.read_bytes()
try:json.loads(changed);valid_after=True
except ValueError:valid_after=False
print(json.dumps({'fault':fault,'launch':launch,'nativeRoot':expected['native']['session_id'],
 'uid':os.getuid(),'gid':os.getgid(),'beforeIdentity':identity(before),'afterIdentity':identity(after),
 'originalSha256':hashlib.sha256(raw).hexdigest(),'changedSha256':hashlib.sha256(changed).hexdigest(),
 'validBefore':json.loads(raw)==expected,'validAfter':valid_after}))
`

// Fixed, read-only native host Status on the current receipt-owned runtime.
// Use the existing Hello proof and command-auth contract, never a fixture socket.
export const amplifierNativeHostStatus = String.raw`
import pathlib,sys,re,json,socket,struct,uuid,hmac,hashlib
root=pathlib.Path(sys.argv[1]);incarnation=sys.argv[2]
assert re.fullmatch(r'/tmp/frs/[a-f0-9]{8}-[a-f0-9]{3}/r/amplif-[a-f0-9]{8}/x',str(root))
assert re.fullmatch(r'incarnation-[a-f0-9-]{36}',incarnation)
directory=root/incarnation;secret=(directory/'secret').read_bytes();endpoint=str(directory/'host.sock')
def exchange(body,auth=None):
 request_id='request-'+str(uuid.uuid4())
 envelope={'protocolVersion':2,'requestId':request_id,'role':'supervisor','body':body}
 if auth is not None:envelope['auth']=auth
 raw=json.dumps(envelope).encode()
 with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as connection:
  connection.settimeout(5);connection.connect(endpoint);connection.sendall(struct.pack('!I',len(raw))+raw)
  def receive(size):
   chunks=b''
   while len(chunks)<size:
    part=connection.recv(size-len(chunks))
    if not part:raise RuntimeError('owned native host frame closed early')
    chunks+=part
   return chunks
  size=struct.unpack('!I',receive(4))[0];assert 0<size<=65536
  reply=json.loads(receive(size));assert reply['requestId']==request_id
  result=reply['result'];assert 'Ok' in result
  return result['Ok']
challenge=str(uuid.uuid4())
hello=exchange({'method':'hello','params':{'incarnation_id':incarnation,'challenge':challenge}})
assert hello['kind']=='hello';boot=hello['data']['host_boot_id']
def proof(challenge):return hmac.new(secret,(challenge+'\0'+boot+'\0'+incarnation).encode(),hashlib.sha256).hexdigest()
assert hmac.compare_digest(hello['data']['proof'],proof(challenge))
status=exchange({'method':'status','params':{'incarnation_id':incarnation}},proof('command-auth'))
assert status['kind']=='status';data=status['data'];assert data['host_boot_id']==boot
print(json.dumps({'incarnationId':incarnation,'hostBootId':boot,'workerPid':data['worker_pid'],
 'executionGeneration':data['max_execution_generation'],'exited':data['exited'],
 'nativeSessionId':data.get('native_session_id'),'nativeIdentityObservation':data.get('native_identity_observation')}))
`

export async function completeAmplifierStaleWriter(harness: RuntimeHarness, supervisor: any,
  context: { scenario: string; workspace: string; nativeRoot: string; previousView: any; previousSignal: any; seed: any; recovery: any; faultImage: any }): Promise<{ name: string; pass: boolean }[]> {
  const { scenario, workspace, nativeRoot, previousView, previousSignal, seed, recovery, faultImage } = context
  const fault = JSON.parse(fs.readFileSync(path.join(workspace, 'native-startup-fault.json'), 'utf8'))
  const publication = JSON.parse(fs.readFileSync(path.join(workspace, 'native-stale-publication.json'), 'utf8'))
  const previousRaw = fs.readFileSync(path.join(workspace, 'prior-native-signal.json'))
  harness.writeArtifact(`${scenario}-current-native-fault-private.json`, fault)
  harness.writeArtifact(`${scenario}-stale-native-publication-private.json`, publication)
  const launch = JSON.parse(await harness.execOwnedContainerAsExact(supervisor.containerId, '0:0',
    ['python3', '-c', "import sqlite3,sys; c=sqlite3.connect('file:/var/lib/freshell-supervisor/runtime.sqlite3?mode=ro',uri=True); c.execute('PRAGMA query_only=ON'); row=c.execute('SELECT native_identity_launch FROM incarnations WHERE incarnation_id=?',(sys.argv[1],)).fetchone(); assert row and row[0]; print(row[0])", fault.launch.incarnationId]))
  harness.writeArtifact(`${scenario}-current-persisted-native-launch.json`, launch)
  const sameLaunch = (actual: any, expected: any) => actual?.incarnationId === expected.incarnationId && actual.launchNonce === expected.launchNonce
    && actual.evidenceRevision === expected.evidenceRevision && actual.executionGeneration === expected.executionGeneration
    && actual.requestedNativeSessionId === expected.requestedNativeSessionId
  const prior = previousSignal.launch, native = publication.nativeSignal?.native
  let parsedSignal: unknown
  try { parsedSignal = JSON.parse(publication.signalText) } catch { /* Invalid native bytes cannot qualify. */ }
  const currentNative = fault.event === 'test.amplifier.native_startup_fault.applied' && fault.severity === 'warning'
    && fault.fault === 'old-writer' && fault.phase === 'before-stale-native-publication'
    && sameLaunch(fault.launch, launch) && sameLaunch(publication.currentLaunch, launch)
    && launch.requestedNativeSessionId === nativeRoot && launch.incarnationId !== previousView.incarnationId && launch.launchNonce !== prior.launchNonce
    && prior.incarnationId === previousView.incarnationId && prior.requestedNativeSessionId === nativeRoot
    && previousSignal.native.session_id === nativeRoot && previousSignal.native.parent_id === null
    && launch.evidenceRevision > prior.evidenceRevision && sameLaunch(fault.previousLaunch, prior) && sameLaunch(publication.nativeSignal?.launch, prior)
    && fault.previousSignalSha256 === createHash('sha256').update(previousRaw).digest('hex')
    && sameLaunch(JSON.parse(previousRaw.toString('utf8')).launch, prior)
    && native?.session_id === nativeRoot && native.parent_id === null && native.source === 'resume'
    && native.producer_sha256 === faultImage.producerSha256
    && Number.isSafeInteger(native.load?.messageCount) && native.load.messageCount > 0 && Number.isSafeInteger(native.acceptedMessageCount)
    && native.acceptedMessageCount >= native.load.messageCount && native.acceptedMessageCount - native.load.messageCount <= 1
    && typeof publication.signalText === 'string' && createHash('sha256').update(publication.signalText).digest('hex') === publication.signalSha256
    && JSON.stringify(parsedSignal) === JSON.stringify(publication.nativeSignal)
    && fault.uid === 65534 && fault.gid === 0 && fault.caps === '0000000000000000' && fault.readOnlyRoot
    && fault.nativeCwd === workspace && Number.isSafeInteger(fault.nativePid) && fault.nativePid > 1
    && fault.originalCliSha256 === faultImage.originalCliSha256 && fault.producerSha256 === faultImage.producerSha256
  const source = fault.originalLoad?.transcript
  const retained = Boolean(source && fault.originalLoad?.sessionId === nativeRoot && fault.originalLoad.parentId === null
    && JSON.stringify(native?.load) === JSON.stringify(fault.originalLoad)
    && [source.device, source.inode, source.size].every(Number.isSafeInteger)
    && JSON.stringify([source.device, source.inode, source.size].map(String)) === JSON.stringify(seed.transcript.identity.slice(0, 3))
    && source.eofSha256 === seed.transcript.sha256)
  const inventory = await harness.adminOk(supervisor, harness.inventoryBody())
  harness.writeArtifact(`${scenario}-stale-writer-current-inventory.json`, inventory)
  const current = inventory.data.filter((row: any) => row.soulId === previousView.soulId)
  const contained = recovery.result?.Ok?.data?.outcome === 'blocked' && current.length > 0
    && current.every((row: any) => row.launchState !== 'running' && row.nativeIdentityObservation?.incarnationId !== launch.incarnationId)
  if (!currentNative || !retained || !contained) throw new Error('actual Amplifier stale writer native binding, source or containment differs')
  const input = await harness.adminRaw(supervisor, harness.terminalInputBody(previousView.soulId, 'Owned stale native writer input probe. Do not use tools.\r'))
  harness.writeArtifact(`${scenario}-stale-writer-input-refusal.json`, input)
  if (!input.result?.Err) throw new Error('actual Amplifier stale writer admitted ordinary input')
  return [{ name: 'real-current-native-publisher-retains-actual-prior-launch', pass: currentNative },
    { name: 'original-native-root-source-inode-full-eof-retained', pass: retained },
    { name: 'stale-native-launch-blocks-running-observation-and-input', pass: contained && !!input.result.Err }]
}

async function executeManagedAmplifier(harness: RuntimeHarness,
  sources: { name: string; path: string; sha256: string }[], caseId: string, serverPath: string | undefined,
  servers: { server: import('../../test/e2e-browser/helpers/rust-server.js').RustServer; scope: string; pid?: number }[]): Promise<NativeExperimentOriginal> {
  const scenario = `amplifier-${caseId}`
  const wrongRoot = caseId === 'wrong-root'
  const sourceFault = ['missing-history', 'load-failure', 'missing-context-restore', 'parent-root'].includes(caseId)
  const pendingFault = ['timeout', 'provider-exit', 'stop-cancellation'].includes(caseId)
  const ackFault = ['file-replacement', 'file-truncation', 'malformed-ack'].includes(caseId)
  const staleWriter = caseId === 'old-writer'
  const resumes = ['exact-resume', 'native-followup', 'current-native-turn', 'old-writer'].includes(caseId)
  const followup = caseId === 'native-followup' || caseId === 'current-native-turn'
  if (resumes && !serverPath) throw new Error('actual terminal recovery requires the owned real server artifact')
  let faultImage: any
  if (sourceFault || pendingFault || staleWriter) {
    const descriptor = sources.find(source => source.name === 'amplifier/native-fault/startup.json')
    if (!descriptor) throw new Error('actual owned Amplifier fault image descriptor missing')
    const raw = fs.readFileSync(descriptor.path)
    if (createHash('sha256').update(raw).digest('hex') !== descriptor.sha256) throw new Error('Amplifier fault image descriptor changed')
    faultImage = JSON.parse(raw.toString('utf8'))
    const cases = ['missing-history', 'load-failure', 'missing-context-restore', 'timeout', 'provider-exit', 'stop-cancellation', 'parent-root', 'old-writer']
    const admittedLengths = staleWriter ? [8] : caseId === 'parent-root' ? [7, 8] : pendingFault ? [6, 7, 8] : [3, 6, 7, 8]
    if (faultImage.schemaVersion !== 1 || faultImage.imageDigest !== harness.imageRef
      || !/^[a-f0-9]{40}$/.test(faultImage.wrapperSourceSha)
      || !['wrapperSha256', 'originalCliSha256', 'producerSha256'].every(key => /^[a-f0-9]{64}$/.test(faultImage[key]))
      || !admittedLengths.some(length => JSON.stringify(cases.slice(0, length)) === JSON.stringify(faultImage.cases))) {
      throw new Error('actual owned Amplifier fault image binding differs')
    }
  }
  const grants = (['env_file', 'ca_file'] as const).map((suffix) => {
    const file = sources.find((source) => source.name === `amplifier/grants/${suffix}`)
    if (!file) throw new Error(`selected Amplifier ${suffix} reference missing`)
    return { sourcePath: file.path, profile: suffix === 'env_file' ? 'amplifier_onecli_environment' : 'amplifier_onecli_ca_file' }
  })
  const profile = ['settings.yaml', 'bundles/default.yaml'].map((relative) => {
    const file = sources.find((source) => source.name === `amplifier/.amplifier/${relative}`)
    if (!file) throw new Error('selected ordinary Amplifier profile missing')
    return { relative, ...file }
  })
  const home = path.dirname(path.dirname(profile[0]!.path))
  const workspace = path.join(harness.testRoot, scenario + '-workspace')
  fs.mkdirSync(workspace, { mode: 0o770 }); fs.chmodSync(workspace, 0o770)
  const supervisor = await harness.startSupervisor({ scenarioId: scenario, binaryKind: 'release',
    env: { HOME: home, FRESHELL_MANAGED_PROVIDER_QUALIFICATION: 'amplifier' } })
  const soulId = 'soul-' + randomUUID()
  const nativeRoot = randomUUID()
  const actualRoot = wrongRoot ? randomUUID() : nativeRoot
  let managedPreparation: any
  if (resumes && serverPath) {
    const { RustServer } = await import('../../test/e2e-browser/helpers/rust-server.js')
    const server = new RustServer({ homeDir: home, preserveHomeOnStop: true,
      env: { FRESHELL_BIND_HOST: '0.0.0.0', FRESHELL_MANAGED_RUNTIME_V1: '1',
        FRESHELL_RUNTIME_CONTROL_SOCKET: supervisor.controlSocket,
        FRESHELL_RUNTIME_CONTROL_SECRET_FILE: supervisor.controlSecretFile,
        FRESHELL_MANAGED_PROVIDER_QUALIFICATION: 'amplifier',
        FRESHELL_MANAGED_AMPLIFIER_ONECLI_ENV_FILE: grants[0]!.sourcePath,
        FRESHELL_MANAGED_AMPLIFIER_ONECLI_CA_FILE: grants[1]!.sourcePath },
      stripEnvPrefixes: ['GEMINI_', 'GOOGLE_API_KEY', 'ANTHROPIC_', 'CLAUDE_', 'OPENAI_', 'LUNAROUTE_'],
      setupHome: async (selectedHome) => {
        const config = path.join(selectedHome, '.freshell'); fs.mkdirSync(config, { recursive: true, mode: 0o700 })
        fs.writeFileSync(path.join(config, 'config.json'), JSON.stringify({ version: 1, settings: {
          defaultCwd: workspace, codingCli: { enabledProviders: ['amplifier'], providers: { amplifier: { model: 'glm-5.3', reasoningEffort: 'low' } } },
        } }), { mode: 0o600 })
      } })
    const owned = { server, scope: `${scenario}-native`, pid: undefined as number | undefined }; servers.push(owned)
    const previous = process.env.FRESHELL_E2E_RUST_SERVER_BIN
    process.env.FRESHELL_E2E_RUST_SERVER_BIN = serverPath
    try {
      const info = await server.start(); owned.pid = info.pid
      harness.writeArtifact(`${scenario}-native-server-private.json`, { ...info, ...server.processEvidence(),
        executableSha256: createHash('sha256').update(fs.readFileSync(serverPath)).digest('hex') })
    } finally {
      if (previous === undefined) delete process.env.FRESHELL_E2E_RUST_SERVER_BIN
      else process.env.FRESHELL_E2E_RUST_SERVER_BIN = previous
    }
    managedPreparation = await new Promise((resolve, reject) => {
      const socket = createConnection(path.join(path.dirname(supervisor.controlSocket), 'mcp.sock'))
      const chunks: Buffer[] = []
      socket.setTimeout(5_000, () => socket.destroy(new Error('actual native capability issue timed out')))
      socket.once('connect', () => socket.end(JSON.stringify({ action: 'issue', controlSecret: supervisor.controlSecret,
        soulId, incarnationId: null, grantId: null, provider: 'amplifier', tuiSource: null, workspace, cwd: workspace })))
      socket.on('data', (chunk: Buffer) => chunks.push(chunk))
      socket.once('error', reject)
      socket.once('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { reject(new Error('actual native capability issue failed')) }
      })
    })
    harness.writeArtifact(`${scenario}-native-managed-preparation-private.json`, managedPreparation)
    if (!managedPreparation.context?.mcpCapability || !managedPreparation.secretReferences?.length) {
      throw new Error('actual native managed capability/preparation missing')
    }
  }
  const request = { method: 'launch', params: { soulId, provider: 'amplifier', providerStoreId: 'store-' + randomUUID(),
    nativeSessionId: nativeRoot,
    creationSeedRef: 'native-create-' + randomUUID(), profile: 'custom', projectKey: `${scenario}-native-create`,
    limits: { cpuMilli: 2000, memoryBytes: 2 * 1024 ** 3, swapBytes: 0, pidsMax: 256 },
    terminal: { terminalId: 'native-terminal-' + randomUUID(), streamId: 'native-stream-' + randomUUID(),
      mode: 'amplifier', program: 'amplifier', args: ['session', 'resume', '--full-history', actualRoot],
      resumeSessionId: actualRoot, env: { HOME: '/home/freshell/provider', PROMPT_TOOLKIT_NO_CPR: '1' },
      cwd: workspace, workspacePath: workspace, runAsUid: 65534, runAsGid: 0, cols: 100, rows: 30,
      projectKey: `${scenario}-native-create`, providerModel: 'glm-5.3', providerReasoningEffort: 'low',
      providerSecretReferences: managedPreparation?.secretReferences ?? grants,
      providerLaunchContext: managedPreparation?.context ?? { preparation: { amplifier: { bundle: 'default', resume_args: [] } },
        config: profile.map((file) => ({ root: 'user_provider', relativePath: file.relative,
          providerRelativePath: '.amplifier/' + file.relative, format: 'yaml' })) } } } }
  harness.writeArtifact(`${scenario}-request.json`, request)
  let nativeOriginals: NativeExperimentOriginal['nativeOriginals']
  const finish = (namespace: any, artifactReferences: string[], assertions: { name: string; pass: boolean }[]) => {
    const original = { caseId, ownerId: harness.runId, candidateSha: harness.candidateSha, imageDigest: harness.imageRef,
      nativeVersion: `amplifier-app-cli ${namespace.cliVersion}; amplifier-core ${namespace.coreVersion}`,
      executableSha256: namespace.executableSha256,
      profileSha256: createHash('sha256').update(JSON.stringify(profile.map(file => ({ relative: file.relative, sha256: file.sha256 })))).digest('hex'),
      artifactReferences: [...artifactReferences, ...(nativeOriginals ? [nativeOriginals.reference.path] : [])], nativeOriginals, assertions }
    harness.writeArtifact(`${scenario}-original.json`, original)
    return original
  }
  if (pendingFault) {
    const startedAt = Date.now()
    let finished = false, result: any, launchError: unknown
    const pending = harness.adminRaw(supervisor, request).then(reply => { result = reply; finished = true },
      error => { launchError = error; finished = true })
    const faultPath = path.join(workspace, 'native-startup-fault.json')
    const captureDeadline = Date.now() + 6_000
    let receipt: ReturnType<typeof harness.broker.receipts>[number] | undefined
    while (!finished && Date.now() < captureDeadline) {
      receipt = harness.broker.receipts().find(row => row.soulId === soulId)
      if (receipt && fs.existsSync(faultPath)) break
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    if (!receipt || !fs.existsSync(faultPath) || finished) {
      await pending
      harness.writeArtifact(`${scenario}-unexpected-launch.json`, { result, error: String(launchError ?? '') })
      throw new Error('actual native Amplifier pause unavailable before startup fault')
    }
    const fault = JSON.parse(fs.readFileSync(faultPath, 'utf8'))
    harness.writeArtifact(`${scenario}-before-fault-native-private.json`, fault)
    const launch = JSON.parse(await harness.execOwnedContainerAsExact(supervisor.containerId, '0:0',
      ['python3', '-c', String.raw`import sqlite3,sys
c=sqlite3.connect('file:/var/lib/freshell-supervisor/runtime.sqlite3?mode=ro',uri=True)
c.execute('PRAGMA query_only=ON')
row=c.execute('SELECT native_identity_launch FROM incarnations WHERE soul_id=? AND launch_state=?',(sys.argv[1],'starting')).fetchone()
assert row and row[0]
print(row[0])`, soulId]))
    harness.writeArtifact(`${scenario}-before-fault-current-binding.json`, launch)
    const currentFault = fault.event === 'test.amplifier.native_startup_fault.applied' && fault.severity === 'warning'
      && fault.fault === caseId && fault.phase === 'before-native-publication'
      && fault.launch?.incarnationId === launch.incarnationId && fault.launch.launchNonce === launch.launchNonce
      && fault.launch.evidenceRevision === launch.evidenceRevision && fault.launch.executionGeneration === launch.executionGeneration
      && fault.launch.requestedNativeSessionId === nativeRoot && launch.requestedNativeSessionId === nativeRoot
      && fault.nativeRoot === nativeRoot && fault.nativeParent === null
      && fault.originalLoad?.sessionId === nativeRoot && fault.originalLoad?.parentId === null
      && Number.isSafeInteger(fault.originalLoad?.messageCount) && Number.isSafeInteger(fault.acceptedMessageCount)
      && fault.acceptedMessageCount >= fault.originalLoad.messageCount && fault.acceptedMessageCount - fault.originalLoad.messageCount <= 1
      && Number.isSafeInteger(fault.nativePid) && fault.nativePid > 1 && fault.uid === 65534 && fault.gid === 0
      && fault.caps === '0000000000000000' && fault.readOnlyRoot && fault.nativeCwd === workspace
      && fault.originalCliSha256 === faultImage.originalCliSha256 && fault.producerSha256 === faultImage.producerSha256
    if (!currentFault) { await pending; throw new Error('actual current Amplifier pre-publication fault binding differs') }
    const before = JSON.parse(await harness.execOwnedContainerAsExact(receipt.containerId, '65534:0',
      ['/opt/amplifier-src/.venv/bin/python', '-c', amplifierNativeInspection, fault.originalLoad.transcript.path, nativeRoot, 'true']))
    harness.writeArtifact(`${scenario}-before-fault-profile-private.json`, before)
    const source = fault.originalLoad.transcript
    const sameLoadedSource = [source.device, source.inode, source.size].every(Number.isSafeInteger)
      && JSON.stringify(before.transcript?.identity?.slice(0, 3)) === JSON.stringify([source.device, source.inode, source.size].map(String))
      && /^[a-f0-9]{64}$/.test(source.eofSha256) && before.transcript?.sha256 === source.eofSha256
    if (finished || before.nativePid !== fault.nativePid || before.nativeRoot !== nativeRoot || before.nativeCwd !== workspace
      || before.httpsStatus !== 200 || before.tlsVerifyMode !== 2 || before.tlsCheckHostname !== true
      || before.cliVersion !== '0.1.1' || before.coreVersion !== '1.6.0'
      || before.executableSha256 !== faultImage.wrapperSha256 || before.originalCliSha256 !== faultImage.originalCliSha256
      || before.producerSha256 !== faultImage.producerSha256
      || !sameLoadedSource || before.transcript?.completeEof !== true || before.completedTurns !== 0 || before.toolEvents !== 0) {
      await pending
      throw new Error('actual unobserved Amplifier UID/TLS/profile unavailable before fault')
    }
    let stopped: any, exited: any
    if (caseId === 'provider-exit') harness.killOwnedRuntimePidExact(receipt.containerId, fault.nativePid, 'TERM')
    else if (caseId === 'stop-cancellation') {
      stopped = await harness.adminOk(supervisor, harness.stopBody(soulId))
      harness.writeArtifact(`${scenario}-ordinary-stop.json`, stopped)
    }
    await pending
    if (launchError) throw launchError
    const elapsedMs = Date.now() - startedAt
    harness.writeArtifact(`${scenario}-launch.json`, result)
    harness.writeArtifact(`${scenario}-launch-timing.json`, { elapsedMs })
    if (result.result?.Err?.code !== (caseId === 'stop-cancellation' ? 'STALE_INTENT_REVISION' : 'RECOVERY_BLOCKED')) {
      throw new Error('Amplifier pending startup fault published launch success')
    }
    const inventory = await harness.adminOk(supervisor, harness.inventoryBody())
    harness.writeArtifact(`${scenario}-inventory.json`, inventory)
    const view = inventory.data.find((row: any) => row.soulId === soulId)
    harness.writeArtifact(`${scenario}-current-view.json`, view)
    if (!view || view.incarnationId !== launch.incarnationId || view.nativeIdentityObservation
      || view.launchState !== (caseId === 'stop-cancellation' ? 'stopped' : 'starting')) {
      throw new Error('Amplifier pending fault published Running or native observation')
    }
    if (caseId === 'provider-exit') {
      const deadline = Date.now() + 3_000
      do {
        exited = JSON.parse(await harness.execOwnedContainerAsExact(receipt.containerId, '65534:0',
          ['python3', '-c', "import pathlib,json,sys;print(json.dumps({'nativeExited':not (pathlib.Path('/proc')/sys.argv[1]/'exe').exists()}))", String(fault.nativePid)]))
        if (exited.nativeExited) break
        await new Promise(resolve => setTimeout(resolve, 50))
      } while (Date.now() < deadline)
      harness.writeArtifact(`${scenario}-native-exit.json`, exited)
      if (exited.nativeExited !== true) throw new Error('owned Amplifier native PID remained alive after exit fault')
    } else if (caseId === 'stop-cancellation') {
      if (stopped?.data?.outcome !== 'verified_empty' || view.desiredState !== 'stopped' || view.recoveryState !== 'stopped') {
        throw new Error('ordinary Amplifier Stop did not confirm empty stopped intent')
      }
    } else if (elapsedMs < 8_000 || elapsedMs >= 50_000) {
      throw new Error('actual Amplifier native startup wait was not bounded by the existing deadline')
    }
    const input = await harness.adminRaw(supervisor, harness.terminalInputBody(soulId, 'Owned failed startup input probe. Do not use tools.\r'))
    harness.writeArtifact(`${scenario}-input-refusal.json`, input)
    if (input.result?.Err?.code !== 'UNKNOWN_SOUL') throw new Error('Amplifier pending startup fault admitted input')
    return finish(before,
      [`${scenario}-launch.json`, `${scenario}-before-fault-native-private.json`, `${scenario}-before-fault-current-binding.json`, `${scenario}-before-fault-profile-private.json`, `${scenario}-current-view.json`, `${scenario}-input-refusal.json`],
      [{ name: 'actual-native-load-and-context-before-owned-startup-fault', pass: currentFault && before.nativeRoot === nativeRoot },
        { name: 'actual-current-native-selected-profile-uid-tls-before-fault', pass: before.httpsStatus === 200 && before.tlsVerifyMode === 2 && before.tlsCheckHostname },
        { name: caseId === 'provider-exit' ? 'exact-owned-native-provider-pid-exited' : caseId === 'stop-cancellation' ? 'ordinary-stop-confirmed-empty-stopped-intent' : 'existing-native-startup-wait-bounded-without-input',
          pass: caseId === 'provider-exit' ? exited.nativeExited : caseId === 'stop-cancellation' ? stopped.data.outcome === 'verified_empty' && view.desiredState === 'stopped' : elapsedMs >= 8_000 && elapsedMs < 50_000 },
        { name: 'pending-native-startup-fault-blocks-running-observation-and-input', pass: !view.nativeIdentityObservation && view.launchState !== 'running' && input.result.Err.code === 'UNKNOWN_SOUL' }])
  }
  if (wrongRoot || sourceFault) {
    const result = await harness.adminRaw(supervisor, request)
    harness.writeArtifact(`${scenario}-launch.json`, result)
    if (result.result?.Err?.code !== 'RECOVERY_BLOCKED') throw new Error('Amplifier native fault launch was not blocked')
    const inventory = await harness.adminOk(supervisor, harness.inventoryBody())
    harness.writeArtifact(`${scenario}-inventory.json`, inventory)
    const view = inventory.data.find((row: any) => row.soulId === soulId)
    harness.writeArtifact(`${scenario}-current-view.json`, view)
    if (view?.launchState !== 'starting' || view.nativeIdentityObservation) {
      throw new Error('Amplifier native fault published Running or an observation')
    }
    // Read only the already-owned registry's persisted launch binding. The
    // native event cannot choose its own nonce, revision or generation.
    const launch = JSON.parse(await harness.execOwnedContainerAsExact(supervisor.containerId, '0:0',
      ['python3', '-c', "import sqlite3,json,sys; c=sqlite3.connect('file:/var/lib/freshell-supervisor/runtime.sqlite3?mode=ro',uri=True); c.execute('PRAGMA query_only=ON'); row=c.execute('SELECT native_identity_launch FROM incarnations WHERE incarnation_id=?',(sys.argv[1],)).fetchone(); assert row and row[0]; print(row[0])", view.incarnationId]))
    harness.writeArtifact(`${scenario}-current-launch-binding.json`, launch)
    const output = await harness.adminOk(supervisor, harness.terminalReadOutputBody(soulId))
    harness.writeArtifact(`${scenario}-terminal-private.json`, output)
    const nativeEvents = stripVTControlCharacters(output.data.frames.map((frame: any) => frame.data).join(''))
      .split(/\r?\n/).flatMap(line => {
        try { return [JSON.parse(line)] } catch { return [] }
      })
    if (sourceFault) {
      const fault = JSON.parse(fs.readFileSync(path.join(workspace, 'native-startup-fault.json'), 'utf8'))
      harness.writeArtifact(`${scenario}-native-fault-private.json`, fault)
      const bindingMatches = (value: any) => value?.incarnationId === launch.incarnationId
        && value.launchNonce === launch.launchNonce && value.evidenceRevision === launch.evidenceRevision
        && value.executionGeneration === launch.executionGeneration
      if (fault.event !== 'test.amplifier.native_startup_fault.applied' || fault.severity !== 'warning' || fault.fault !== caseId
        || !bindingMatches(fault.launch) || fault.launch.requestedNativeSessionId !== nativeRoot
        || launch.incarnationId !== view.incarnationId || launch.executionGeneration !== view.executionGeneration
        || fault.nativeCwd !== workspace || !Number.isSafeInteger(fault.nativePid) || fault.nativePid <= 1
        || fault.uid !== 65534 || fault.gid !== 0 || fault.caps !== '0000000000000000' || !fault.readOnlyRoot
        || fault.originalCliSha256 !== faultImage.originalCliSha256 || fault.producerSha256 !== faultImage.producerSha256) {
        throw new Error('current actual Amplifier startup fault binding missing or stale')
      }
      if (caseId === 'missing-context-restore') {
        if (fault.phase !== 'before-native-context-restore' || fault.hasRestoreBefore !== true || fault.hasRestoreAfter !== false
          || typeof fault.originalContextType !== 'string' || !fault.originalContextType) {
          throw new Error('actual native Amplifier context restore method fault missing')
        }
      } else {
        const loadEvents = nativeEvents.filter(event => event.event === 'amplifier.native_load.refused')
        if (fault.phase !== 'before-native-load' || fault.originalLoad?.sessionId !== nativeRoot || fault.originalLoad?.parentId !== null
          || fault.originalLoad?.messageCount !== 0 || !loadEvents.some(event => bindingMatches(event)
            && event.reason === 'no_complete_native_load' && event.severity === 'error')
          || (caseId === 'parent-root' ? typeof fault.nativeParent !== 'string' || !/^[a-f0-9-]{36}$/.test(fault.nativeParent)
            : caseId === 'missing-history' ? fault.transcriptAbsent !== true || fault.malformedSha256 !== null
              : fault.transcriptAbsent !== false || !/^[a-f0-9]{64}$/.test(fault.malformedSha256))) {
          throw new Error('actual native Amplifier unloaded history fault missing')
        }
      }
      const namespace = JSON.parse(await harness.execOwnedContainerAsExact(view.containerId, '65534:0',
        ['/opt/amplifier-src/.venv/bin/python', '-c', String.raw`
import os,json,pathlib,hashlib,importlib.metadata as m,sys
p=pathlib.Path('/opt/amplifier-src/.venv/bin/amplifier');producer=pathlib.Path('/opt/amplifier-src/amplifier_app_cli/freshell_native_resume.py')
signal=pathlib.Path('/home/freshell/provider/.freshell/native-identity')/sys.argv[1]/'amplifier-loaded-context.json'
print(json.dumps({'uid':os.getuid(),'gid':os.getgid(),'caps':next(x.split()[1] for x in pathlib.Path('/proc/self/status').read_text().splitlines() if x.startswith('CapEff:')),'readOnlyRoot':bool(os.statvfs('/').f_flag&os.ST_RDONLY),'executableSha256':hashlib.sha256(p.read_bytes()).hexdigest(),'producerSha256':hashlib.sha256(producer.read_bytes()).hexdigest(),'cliVersion':m.version('amplifier-app-cli'),'coreVersion':m.version('amplifier-core'),'signalAbsent':not signal.exists()}))
`, launch.launchNonce]))
      harness.writeArtifact(`${scenario}-namespace-native-private.json`, namespace)
      if (namespace.uid !== 65534 || namespace.gid !== 0 || namespace.caps !== '0000000000000000' || !namespace.readOnlyRoot
        || namespace.cliVersion !== '0.1.1' || namespace.coreVersion !== '1.6.0'
        || namespace.executableSha256 !== faultImage.wrapperSha256 || namespace.producerSha256 !== faultImage.producerSha256
        || namespace.signalAbsent !== true) throw new Error('actual Amplifier fault image or native signal differs')
      const input = await harness.adminRaw(supervisor, harness.terminalInputBody(soulId, 'Owned refused startup input probe. Do not use tools.\r'))
      harness.writeArtifact(`${scenario}-input-refusal.json`, input)
      if (input.result?.Err?.code !== 'UNKNOWN_SOUL') throw new Error('Amplifier startup fault admitted ordinary input')
      return finish(namespace,
        [`${scenario}-launch.json`, `${scenario}-current-view.json`, `${scenario}-current-launch-binding.json`, `${scenario}-terminal-private.json`, `${scenario}-native-fault-private.json`, `${scenario}-namespace-native-private.json`, `${scenario}-input-refusal.json`],
        [{ name: 'actual-native-startup-fault-bound-to-current-launch', pass: bindingMatches(fault.launch) },
          { name: caseId === 'missing-context-restore' ? 'native-context-missing-supported-restore-method' : caseId === 'parent-root' ? 'native-loader-refuses-parent-bearing-owned-root' : 'native-loader-refuses-unloadable-owned-history',
            pass: caseId === 'missing-context-restore' ? fault.hasRestoreBefore && !fault.hasRestoreAfter : fault.phase === 'before-native-load' },
          { name: 'native-startup-fault-refuses-current-ack-running-and-input', pass: namespace.signalAbsent && view.launchState === 'starting' && !view.nativeIdentityObservation && input.result.Err.code === 'UNKNOWN_SOUL' }])
    }
    const events = nativeEvents.filter(event => event.event === 'amplifier.native_root.refused')
    const event = events.length === 1 ? events[0] : undefined
    if (!event || event.severity !== 'error' || event.reason !== 'native_root_mismatch'
      || event.nativeSessionId !== actualRoot || actualRoot === nativeRoot
      || event.incarnationId !== view.incarnationId || event.incarnationId !== launch.incarnationId
      || !launch.launchNonce || event.launchNonce !== launch.launchNonce
      || event.evidenceRevision !== launch.evidenceRevision || event.executionGeneration !== launch.executionGeneration
      || event.executionGeneration !== view.executionGeneration || launch.requestedNativeSessionId !== nativeRoot) {
      throw new Error('current actual Amplifier wrong native root evidence missing or stale')
    }
    const namespace = JSON.parse(await harness.execOwnedContainerAsExact(view.containerId, '65534:0',
      ['/opt/amplifier-src/.venv/bin/python', '-c', amplifierWrongRootInspection, workspace, actualRoot, launch.launchNonce]))
    harness.writeArtifact(`${scenario}-namespace-native-private.json`, namespace)
    if (namespace.uid !== 65534 || namespace.gid !== 0 || namespace.caps !== '0000000000000000'
      || !namespace.readOnlyRoot || namespace.cliVersion !== '0.1.1' || namespace.coreVersion !== '1.6.0'
      || namespace.nativeRoot !== actualRoot || namespace.parentId !== null || namespace.messageCount !== 0
      || namespace.signalAbsent !== true) throw new Error('owned Amplifier wrong-root source or namespace differs')
    const input = await harness.adminRaw(supervisor, harness.terminalInputBody(soulId, 'Owned refused root input probe. Do not use tools.\r'))
    harness.writeArtifact(`${scenario}-input-refusal.json`, input)
    if (input.result?.Err?.code !== 'UNKNOWN_SOUL') throw new Error('Amplifier wrong-root admitted ordinary input')
    return finish(namespace,
      [`${scenario}-launch.json`, `${scenario}-current-view.json`, `${scenario}-current-launch-binding.json`, `${scenario}-terminal-private.json`, `${scenario}-namespace-native-private.json`, `${scenario}-input-refusal.json`],
      [{ name: 'actual-current-native-selected-different-root', pass: event.nativeSessionId === actualRoot && actualRoot !== nativeRoot },
        { name: 'owned-empty-native-root-readable-without-loader-acknowledgement', pass: namespace.signalAbsent && namespace.messageCount === 0 },
        { name: 'wrong-native-root-blocks-running-and-input', pass: view.launchState === 'starting' && !view.nativeIdentityObservation && input.result.Err.code === 'UNKNOWN_SOUL' }])
  }
  const result = await harness.adminOk(supervisor, request)
  harness.writeArtifact(`${scenario}-launch.json`, result)
  let view = result.data.view
  const nativeSignalFile = path.join(harness.evidenceDir, `${scenario}-native-signal-original.json`)
  const captureNativeSignal = async () => {
    const signal = await harness.execOwnedContainerAsExact(view.containerId, '65534:0', ['python3', '-c',
      "import pathlib,json; signals=[]\nfor p in pathlib.Path('/proc').iterdir():\n if not p.name.isdigit():continue\n try:\n  env=dict(v.decode().split('=',1) for v in (p/'environ').read_bytes().split(bytes([0])) if b'=' in v)\n  if 'FRESHELL_NATIVE_IDENTITY_SIGNAL_DIR' in env:signals.append(pathlib.Path(env['FRESHELL_NATIVE_IDENTITY_SIGNAL_DIR'])/'amplifier-loaded-context.json')\n except (OSError,ValueError):continue\nassert len(set(signals))==1\nprint(next(iter(set(signals))).read_text())"])
    fs.writeFileSync(nativeSignalFile, signal, { mode: 0o600 })
  }
  const deadline = Date.now() + 50_000
  while (!view.nativeIdentityObservation && Date.now() < deadline) {
    harness.writeArtifact(`${scenario}-terminal-private.json`,
      await harness.adminOk(supervisor, harness.terminalReadOutputBody(soulId)))
    harness.writeArtifact(`${scenario}-store-probe.json`,
      await harness.adminOk(supervisor, harness.probeRecoveryBody(soulId)))
    try {
      await captureNativeSignal()
    } catch { /* The producer may not yet have completed load/context restore. */ }
    const inventory = await harness.adminOk(supervisor, harness.inventoryBody())
    harness.writeArtifact(`${scenario}-inventory.json`, inventory)
    view = inventory.data.find((row: any) => row.soulId === soulId)
    if (!view) throw new Error('owned Amplifier view disappeared')
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  const observation = view.nativeIdentityObservation
  harness.writeArtifact(`${scenario}-current-view.json`, view)
  if (!observation || !view.nativeSessionId || view.recoveryState !== 'live'
    || observation.nativeSessionId !== view.nativeSessionId || observation.incarnationId !== view.incarnationId
    || observation.source !== 'amplifier_native_loaded_context') throw new Error('current managed Amplifier no-input acknowledgement missing')
  await captureNativeSignal()
  const namespaceScript = "import os,json,pathlib,hashlib,importlib.metadata as m; p=pathlib.Path('/opt/amplifier-src/.venv/bin/amplifier'); producer=pathlib.Path('/opt/amplifier-src/amplifier_app_cli/freshell_native_resume.py'); print(json.dumps({'uid':os.getuid(),'gid':os.getgid(),'caps':next(x.split()[1] for x in pathlib.Path('/proc/self/status').read_text().splitlines() if x.startswith('CapEff:')),'readOnlyRoot':bool(os.statvfs('/').f_flag&os.ST_RDONLY),'executableSha256':hashlib.sha256(p.read_bytes()).hexdigest(),'producerSha256':hashlib.sha256(producer.read_bytes()).hexdigest(),'cliVersion':m.version('amplifier-app-cli'),'coreVersion':m.version('amplifier-core')}))"
  const captureNamespace = async (containerId: string) => JSON.parse(await harness.execOwnedContainerAsExact(containerId, '65534:0', ['/opt/amplifier-src/.venv/bin/python', '-c', namespaceScript]))
  const namespace = await captureNamespace(view.containerId)
  harness.writeArtifact(`${scenario}-namespace.json`, namespace)
  if (namespace.uid !== 65534 || namespace.gid !== 0 || namespace.caps !== '0000000000000000'
    || !namespace.readOnlyRoot || namespace.cliVersion !== '0.1.1' || namespace.coreVersion !== '1.6.0') {
    throw new Error('actual managed Amplifier namespace/package differs')
  }
  const assertions = [{ name: 'actual-native-loaded-context-before-zero-input', pass: observation.source === 'amplifier_native_loaded_context'
    && observation.nativeSessionId === view.nativeSessionId && observation.incarnationId === view.incarnationId }]
  const inspectNative = async (transcriptPath: string, containerId: string, label: string, checkTls: boolean) => {
    const snapshot = JSON.parse(await harness.execOwnedContainerAsExact(containerId, '65534:0',
      ['/opt/amplifier-src/.venv/bin/python', '-c', amplifierNativeInspection, transcriptPath, nativeRoot, String(checkTls)]))
    if (caseId === 'current-native-turn') retainOwnedNativeProbe(snapshot, containerId)
    harness.writeArtifact(`${scenario}-${label}-native-private.json`, snapshot)
    return snapshot
  }
  if (ackFault) {
    const signalText = fs.readFileSync(nativeSignalFile, 'utf8')
    const signal = JSON.parse(signalText)
    if (signal.launch.incarnationId !== view.incarnationId || signal.launch.launchNonce !== observation.launchNonce
      || signal.launch.evidenceRevision !== observation.evidenceRevision || signal.native.session_id !== nativeRoot) {
      throw new Error('actual Amplifier ACK before file fault differs from current observation')
    }
    const inspect = (label: string) => inspectNative(signal.native.load.transcript.path, view.containerId, label, label === 'before-fault')
    const before = await inspect('before-fault')
    if (before.nativeRoot !== nativeRoot || before.nativeCwd !== workspace || before.httpsStatus !== 200
      || before.tlsVerifyMode !== 2 || before.tlsCheckHostname !== true || before.completedTurns !== 0 || before.toolEvents !== 0) {
      throw new Error('actual Amplifier native UID/TLS/profile before ACK fault differs')
    }
    const status = async (label: string) => {
      const value = JSON.parse(await harness.execOwnedContainerAsExact(supervisor.containerId, '0:0',
        ['python3', '-c', amplifierNativeHostStatus, supervisor.runtimeRoot, view.incarnationId]))
      harness.writeArtifact(`${scenario}-${label}-host-status.json`, value)
      return value
    }
    const current = await status('before-fault')
    if (current.exited || current.nativeIdentityObservation?.nativeSessionId !== nativeRoot
      || current.nativeIdentityObservation.launchNonce !== signal.launch.launchNonce) {
      throw new Error('authenticated Amplifier host lacks current observation before file fault')
    }
    const fault = JSON.parse(await harness.execOwnedContainerAsExact(view.containerId, '65534:0',
      ['python3', '-c', amplifierNativeAckFileFault, caseId, signalText]))
    harness.writeArtifact(`${scenario}-native-ack-fault.json`, fault)
    const changed = fault.fault === caseId && fault.uid === 65534 && fault.gid === 0 && fault.nativeRoot === nativeRoot
      && JSON.stringify(fault.launch) === JSON.stringify(signal.launch) && fault.validBefore
      && (caseId === 'file-replacement'
        ? fault.beforeIdentity[0] === fault.afterIdentity[0] && fault.beforeIdentity[1] !== fault.afterIdentity[1] && fault.originalSha256 === fault.changedSha256 && fault.validAfter
        : fault.beforeIdentity[0] === fault.afterIdentity[0] && fault.beforeIdentity[1] === fault.afterIdentity[1] && fault.originalSha256 !== fault.changedSha256
          && (caseId === 'file-truncation' ? Number(fault.afterIdentity[2]) < Number(fault.beforeIdentity[2]) && fault.validAfter : fault.validAfter === false))
    if (!changed) throw new Error('actual owned Amplifier ACK file fault condition missing')
    const after = await status('after-fault')
    if (after.exited || after.nativeSessionId || after.nativeIdentityObservation) {
      throw new Error('authenticated native Amplifier host retained observation after ACK fault')
    }
    const input = await harness.adminRaw(supervisor, harness.terminalInputBody(soulId, 'Owned failed ACK input probe. Do not use tools.\r'))
    harness.writeArtifact(`${scenario}-input-refusal.json`, input)
    if (input.result?.Err?.code !== 'RECOVERY_BLOCKED') throw new Error('native Amplifier ACK fault admitted ordinary input')
    const conserved = await inspect('after-fault')
    if (conserved.nativeRoot !== nativeRoot || conserved.completedTurns !== 0 || conserved.toolEvents !== 0
      || JSON.stringify(conserved.transcript) !== JSON.stringify(before.transcript)) {
      throw new Error('native Amplifier ACK fault changed original history or dispatched a turn')
    }
    assertions.push({ name: 'actual-current-native-tls-before-ack-file-fault', pass: before.httpsStatus === 200 && before.tlsVerifyMode === 2 && before.tlsCheckHostname },
      { name: 'actual-owned-native-ack-file-fault-executed', pass: changed },
      { name: 'authenticated-host-revokes-mutated-native-ack', pass: !after.nativeSessionId && !after.nativeIdentityObservation && !after.exited },
      { name: 'ordinary-input-refused-original-history-preserved', pass: input.result.Err.code === 'RECOVERY_BLOCKED' && conserved.completedTurns === 0 })
  }
  if (resumes) {
    const signal = JSON.parse(fs.readFileSync(nativeSignalFile, 'utf8'))
    const transcriptPath = signal.native.load.transcript.path
    const inspect = (containerId: string, label: string) => inspectNative(transcriptPath, containerId, label, label === 'startup')
    const startup = await inspect(view.containerId, 'startup')
    if (startup.httpsStatus !== 200 || startup.tlsVerifyMode !== 2 || !startup.tlsCheckHostname) {
      throw new Error('current native Amplifier selected grant/TLS check failed')
    }
    const marker = 'owned-memory-' + randomUUID(), initialObservedAt = Date.now()
    const nativeRequests = new Map<string, NativeOriginalReference>()
    const turn = async (containerId: string, text: string, label: string) => {
      let before = await inspect(containerId, label + '-before-input')
      const readyDeadline = Date.now() + 15_000
      const inputReady = () => harness.execOwnedContainerAsExact(containerId, '0:0', ['python3', '-c',
        "import pathlib,os,sys,termios; p=pathlib.Path('/proc')/sys.argv[1]; fields=(p/'stat').read_text().rsplit(')',1)[1].split(); device=int(fields[4]); assert os.major(device)==136; fd=os.open('/dev/pts/'+str(os.minor(device)),os.O_RDONLY|os.O_NONBLOCK)\ntry:print(str(not bool(termios.tcgetattr(fd)[3]&termios.ICANON)).lower())\nfinally:os.close(fd)", String(before.nativePid)]).trim() === 'true'
      while (!inputReady() && Date.now() < readyDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 100))
        before = await inspect(containerId, label + '-before-input')
      }
      if (!inputReady()) throw new Error('ordinary Amplifier REPL not ready after native gate')
      const requestId = 'request-' + randomUUID(), sentAt = Date.now(), body = harness.terminalInputBody(soulId, text + '\r')
      const receipt = await harness.adminOk(supervisor, body, { requestId })
      if (caseId === 'current-native-turn') nativeRequests.set(label, writeNativeOriginal(harness, `${scenario}-${label}-request-original.json`, { requestId, sentAt, request: body, reply: receipt }))
      harness.writeArtifact(`${scenario}-${label}-dispatch.json`, receipt)
      const deadline = Date.now() + 90_000
      while (Date.now() < deadline) {
        const current = await inspect(containerId, label)
        harness.writeArtifact(`${scenario}-${label}-terminal-private.json`,
          await harness.adminOk(supervisor, harness.terminalReadOutputBody(soulId)))
        if (current.completedTurns > before.completedTurns) {
          if (current.nativeRoot !== nativeRoot || current.toolEvents !== before.toolEvents
            || current.responses.length <= before.responses.length) throw new Error('native Amplifier completed turn/root/tools differ')
          return current
        }
        await new Promise((resolve) => setTimeout(resolve, 200))
      }
      throw new Error('bounded ordinary Amplifier native turn deadline exceeded')
    }
    const seed = await turn(view.containerId,
      `Remember this private marker: ${marker}. Reply stored. Do not use tools.`, 'seed')
    const probe = await harness.adminOk(supervisor, harness.probeRecoveryBody(soulId))
    harness.writeArtifact(`${scenario}-turn-store-probe.json`, probe)
    if (probe.data.kind !== 'reattach_ready') throw new Error('completed Amplifier native store not readable before death')
    if (staleWriter) {
      const file = path.join(workspace, 'prior-native-signal.json')
      fs.writeFileSync(file, fs.readFileSync(nativeSignalFile), { flag: 'wx', mode: 0o660 }); fs.chmodSync(file, 0o660)
    }
    const requestedAt = Date.now()
    await harness.killOwnedRuntimeExact(view.containerId)
    await harness.waitForContainerExit(view.containerId)
    const exitedAt = Date.now()
    const recovery = staleWriter ? await harness.adminRaw(supervisor, harness.recoverBody(soulId, 'host_unreachable'))
      : await harness.adminOk(supervisor, harness.recoverBody(soulId, 'host_unreachable'))
    const replacementObservedAt = Date.now()
    harness.writeArtifact(`${scenario}-turn-recovery.json`, recovery)
    if (staleWriter) {
      assertions.push({ name: 'readable-completed-native-store-before-death', pass: probe.data.kind === 'reattach_ready' },
        ...await completeAmplifierStaleWriter(harness, supervisor, { scenario, workspace, nativeRoot, previousView: view,
          previousSignal: signal, seed, recovery, faultImage }))
      return finish(namespace, [`${scenario}-current-view.json`, `${scenario}-native-signal-original.json`, `${scenario}-turn-recovery.json`,
        `${scenario}-current-native-fault-private.json`, `${scenario}-stale-native-publication-private.json`, `${scenario}-stale-writer-input-refusal.json`], assertions)
    }
    const replacement = recovery.data.view
    if (recovery.data.outcome !== 'replaced' || replacement.incarnationId === view.incarnationId
      || replacement.nativeSessionId !== nativeRoot || replacement.recoveryState !== 'live'
      || replacement.nativeIdentityObservation?.source !== 'amplifier_native_loaded_context'
      || replacement.nativeIdentityObservation?.nativeSessionId !== nativeRoot) throw new Error('Amplifier exact-root replacement failed')
    const restored = await inspect(replacement.containerId, 'after-death')
    if (seed.transcript.sha256 !== restored.transcript.sha256
      || seed.transcript.identity[0] !== restored.transcript.identity[0]
      || seed.transcript.identity[1] !== restored.transcript.identity[1]) throw new Error('original Amplifier owned transcript continuity lost')
    assertions.push({ name: 'readable-completed-native-store-before-death', pass: probe.data.kind === 'reattach_ready' },
      { name: 'replacement-new-incarnation-same-native-root', pass: replacement.incarnationId !== view.incarnationId && replacement.nativeSessionId === nativeRoot },
      { name: 'original-owned-volume-transcript-continuity', pass: seed.transcript.sha256 === restored.transcript.sha256
        && seed.transcript.identity[0] === restored.transcript.identity[0] && seed.transcript.identity[1] === restored.transcript.identity[1] },
      { name: 'same-workspace-selected-native-profile', pass: amplifierNativeProfileRetained(seed, restored, workspace) },
      { name: 'current-native-resume-before-replacement-input', pass: replacement.nativeIdentityObservation.incarnationId === replacement.incarnationId
        && replacement.nativeIdentityObservation.source === 'amplifier_native_loaded_context' })
    if (followup) {
      const recalled = await turn(replacement.containerId,
        'Reply with only the private marker from before. Do not use tools.', 'recall')
      if (recalled.lastAssistantText.trim() !== marker || recalled.metadata.model !== 'glm-5.3') {
        throw new Error('native Amplifier restored context or selected model differs')
      }
      if (caseId === 'current-native-turn') {
        const currentNamespace = await captureNamespace(replacement.containerId)
        const qualified = await inspectNative(transcriptPath, replacement.containerId, 'recall-qualified', true)
        nativeOriginals = retainFamilyNativeTurnOriginals(harness, { scenario, mode: 'amplifier', provider: 'amplifier', launchRequest: request, nonce: marker, requestedAt, exitedAt, initial: { view, namespace: { ...namespace, ...startup }, capture: seed, observedAt: initialObservedAt, request: nativeRequests.get('seed')!, snapshotPath: transcriptPath }, replacement: { view: replacement, namespace: { ...currentNamespace, ...qualified }, capture: qualified, observedAt: replacementObservedAt, request: nativeRequests.get('recall')!, snapshotPath: transcriptPath } })
      }
      assertions.push({ name: 'actual-restored-context-private-marker-recall', pass: recalled.lastAssistantText.trim() === marker },
        { name: 'native-turns-requested-no-tools', pass: seed.toolEvents === 0 && recalled.toolEvents === 0 })
    }
  }
  return finish(namespace, [`${scenario}-current-view.json`, `${scenario}-native-signal-original.json`, `${scenario}-namespace.json`], assertions)
}

export function observeNativeSoloBashOutcome(input: {
  nativeRoot: string; toolUseID: string; allowed: boolean; observed: any[]; effectCount: number
}): { nativeSessionId: string; toolUseID: string; nativeToolResultIsError: boolean; nativeResultIsError: boolean; effectCount: number; completionCount: number } {
  const providerEvents = input.observed.filter(event => event.kind === 'provider').map(event => event.data.payload.event)
  const results = providerEvents.filter(event => event?.type === 'freshAgent.result')
  const toolResults = providerEvents.filter(event => event?.type === 'freshAgent.tool.result')
    .flatMap(event => event.content ?? []).filter(part => part.tool_use_id === input.toolUseID)
  if (results.length !== 1 || toolResults.length !== 1 || results[0].nativeSessionId !== input.nativeRoot
    || toolResults[0].is_error !== !input.allowed || input.effectCount !== (input.allowed ? 1 : 0)) {
    throw new Error('correlated original native outcome/effect differs from decision')
  }
  return { nativeSessionId: results[0].nativeSessionId, toolUseID: input.toolUseID,
    nativeToolResultIsError: toolResults[0].is_error, nativeResultIsError: results[0].isError,
    effectCount: input.effectCount, completionCount: results.length }
}

export async function executeManagedNativeApproval(input: {
  harness: RuntimeHarness; supervisor: any; soulId: string; workspace: string; view: any; scenario: string
  decision: string; inspect: (containerId: string, label: string, requireTranscript: boolean) => Promise<any>
}): Promise<{ name: string; pass: boolean }[]> {
  const { harness, supervisor, soulId, workspace, view, scenario, inspect } = input
  const effectPath = path.join(workspace, 'owned-native-effect.jsonl')
  const effectPaths = input.decision === 'multiple-tools' ? [effectPath, path.join(workspace, 'second-owned-native-effect.jsonl')] : [effectPath]
  if (effectPaths.some((file) => fs.existsSync(file))) throw new Error('native effect oracle must be new')
  const command = `printf 'effect\\n' >> '${effectPath}'`
  const commands = effectPaths.map((file) => `printf 'effect\\n' >> '${file}'`)
  const effectCount = () => effectPaths.reduce((count, file) => {
    if (!fs.existsSync(file)) return count
    const bytes = fs.readFileSync(file, 'utf8')
    if (!/^(effect\n)+$/.test(bytes)) throw new Error('native effect oracle contains unexpected bytes')
    return count + bytes.split('\n').length - 1
  }, 0)
  let cursor = 0
  const batches: unknown[] = []
  const observed: any[] = []
  const readPage = async () => {
    const batch = await harness.adminOk(supervisor, { method: 'fresh_agent_read_events',
      params: { soulId, afterSequence: cursor, maxEvents: 128 } })
    batches.push(batch)
    harness.writeArtifact(`${scenario}-approval-events-private.json`, batches)
    if (batch.data.resetRequired) throw new Error(`native approval event retention reset (retained from ${batch.data.retainedFrom})`)
    for (const row of batch.data.events) cursor = Math.max(cursor, row.sequence)
    return batch
  }
  const readAvailable = async () => {
    let batch = await readPage()
    // Bound a snapshot to the journal head seen at its start, while consuming
    // every delivered page. New producer activity cannot extend this forever.
    const target = batch.data.head, events = [...batch.data.events]
    while (cursor < target) {
      const previous = cursor
      batch = await readPage()
      if (cursor <= previous) throw new Error('native approval event journal made no progress')
      events.push(...batch.data.events)
    }
    return { ...batch, data: { ...batch.data, events } }
  }
  const wait = async (select: (event: any) => boolean, label: string) => {
    const deadline = Date.now() + 90_000
    while (Date.now() < deadline) {
      const batch = await readPage()
      const events = batch.data.events.map((row: any) => row.event)
      observed.push(...events)
      const found = events.find(select)
      if (found) return found
      if (events.some((event: any) => event.kind === 'provider' && event.data.payload.event?.type === 'freshAgent.result')) {
        throw new Error(`native turn completed without required ${label}`)
      }
      if (cursor < batch.data.head && batch.data.events.length) continue
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error(`bounded native ${label} deadline exceeded`)
  }
  const isCard = (event: any) => event.kind === 'permission_requested' && !!event.data.payload.nativeCheckpoint
  harness.writeArtifact(`${scenario}-operation.json`, { command, effectPath })
  await harness.adminOk(supervisor, { method: 'fresh_agent_send', params: { soulId,
    text: input.decision === 'multiple-tools'
      ? `Run these two independent harmless Bash commands in parallel, using one Bash tool call for each command: ${commands[0]} and ${commands[1]}. Send both tool calls together in the same assistant message. Do not combine commands, ask questions, or use other tools. After both results, reply done.`
      : `Use the Bash tool exactly once with this exact command: ${command}. Do not use other tools or another command. After its result, reply done.` } })
  if (['crash-before-checkpoint', 'multiple-tools', 'effect-before-observation'].includes(input.decision)) {
    let originalOperation: any
    let effectDecision: any
    if (input.decision === 'crash-before-checkpoint') {
      const paused = path.join(workspace, 'native-before-checkpoint.json')
      await harness.waitForFile(paused, 90_000)
      originalOperation = JSON.parse(fs.readFileSync(paused, 'utf8'))
      if (originalOperation.session_id !== view.nativeSessionId || originalOperation.tool_name !== 'Bash'
        || originalOperation.tool_input?.command !== command || !originalOperation.tool_use_id?.startsWith('toolu_')) {
        throw new Error('real native pre-checkpoint hook did not park the intended operation')
      }
    } else if (input.decision === 'multiple-tools') {
      originalOperation = await wait((event) => event.kind === 'permission_requested'
        && !event.data.payload.nativeCheckpoint, 'ordinary native multi-tool permission')
      const deadline = Date.now() + 3_000
      let native = await inspect(view.containerId, 'actual-two-tool-batch', true)
      while (!nativeTwoToolBatchMatches(native, commands) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100))
        native = await inspect(view.containerId, 'actual-two-tool-batch', true)
      }
      if (!nativeTwoToolBatchMatches(native, commands)) throw new Error('actual native multi-tool batch differs')
    } else {
      const current = (await wait(isCard, 'current native ask before effect')).data
      effectDecision = current
      const payload = current.payload
      if (payload.tool?.name !== 'Bash' || payload.tool.input?.command !== command
        || payload.nativeCheckpoint.nativeSessionId !== view.nativeSessionId
        || payload.nativeCheckpoint.toolUseID !== payload.toolUseID || effectCount() !== 0) {
        throw new Error('original current native operation differs before effect')
      }
      // Resolve the actual current native ask, then deliberately stop reading
      // normalized outcomes. The supported PostToolUse hook parks only after
      // the native command has executed, before its result is observed.
      const receipt = await harness.adminOk(supervisor, harness.freshAgentResolveBody(soulId, current.decision_id,
        { behavior: 'allow', updatedInput: payload.tool.input }))
      harness.writeArtifact(`${scenario}-current-allow-dispatch.json`, receipt)
      const paused = path.join(workspace, 'native-after-effect-before-observation.json')
      await harness.waitForFile(paused, 90_000)
      originalOperation = JSON.parse(fs.readFileSync(paused, 'utf8'))
      if (originalOperation.hook_event_name !== 'PostToolUse' || originalOperation.session_id !== view.nativeSessionId
        || originalOperation.tool_name !== 'Bash' || originalOperation.tool_use_id !== payload.toolUseID
        || originalOperation.tool_input?.command !== command || effectCount() !== 1) {
        throw new Error('actual native post-effect hook did not park the original completed effect')
      }
    }
    const before = await inspect(view.containerId, 'native-edge-before-death', true)
    harness.writeArtifact(`${scenario}-original-native-operation-private.json`, originalOperation)
    const rows = Buffer.from(before.transcript.bytesBase64, 'base64').toString('utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    if (input.decision !== 'effect-before-observation' && (effectCount() !== 0
      || rows.some((row) => row.type === 'attachment' && row.attachment?.type === 'hook_deferred_tool'))) {
      throw new Error('actual crash/batch operation already produced an effect or deferred checkpoint')
    }
    if (input.decision === 'effect-before-observation') {
      if (rows.some((row) => row.type === 'user' && Array.isArray(row.message?.content)
        && row.message.content.some((block: any) => block.type === 'tool_result' && block.tool_use_id === originalOperation.tool_use_id))) {
        throw new Error('post-effect native outcome was already published')
      }
      const files = await captureCheckpointState(view.containerId, 'effect-before-observation')
      const record = JSON.parse(Buffer.from(files.find((file) => file.readerUid === 65534).bytesBase64, 'base64').toString('utf8'))
      if (record.phase !== 'dispatching' || record.nativeSessionId !== view.nativeSessionId
        || record.toolUseID !== originalOperation.tool_use_id) throw new Error('native effect has no durable ambiguous dispatch fence')
      const actor = JSON.parse(Buffer.from(files.find((file) => file.readerUid === 0).bytesBase64, 'base64').toString('utf8'))
      const resolved = actor.decisions[effectDecision.decision_id]
      const responseDigest = createHash('sha256').update(JSON.stringify({ behavior: 'allow',
        updatedInput: effectDecision.payload.tool.input })).digest('hex')
      if (resolved?.state !== 'resolved' || resolved.responseDigest !== responseDigest) {
        throw new Error('native effect lacks its original durably acknowledged decision')
      }
    }
    const probe = await harness.adminOk(supervisor, harness.probeRecoveryBody(soulId))
    harness.writeArtifact(`${scenario}-native-edge-store-probe.json`, probe)
    if (probe.data.kind !== 'reattach_ready') throw new Error('actual native edge store is unreadable before death')
    await harness.killOwnedRuntimeExact(view.containerId); await harness.waitForContainerExit(view.containerId)
    const recovery = await harness.adminOk(supervisor, harness.recoverBody(soulId, 'host_unreachable'))
    harness.writeArtifact(`${scenario}-native-edge-recovery.json`, recovery)
    if (recovery.data.outcome !== 'replaced' || recovery.data.view.incarnationId === view.incarnationId
      || recovery.data.view.nativeSessionId !== view.nativeSessionId || recovery.data.view.recoveryState !== 'live'
      || !recovery.data.view.nativeIdentityObservation) throw new Error('actual native edge replacement did not preserve its root/current gate')
    let refused
    if (input.decision === 'effect-before-observation') {
      await inspect(recovery.data.view.containerId, 'native-edge-after-effect-recovery', true)
      // Original dispatch acknowledgements precede this new event cursor.
      // An identical resolved decision may return its durable cached success;
      // only an actual new native dispatch would constitute replay.
      const baseline = await readAvailable()
      harness.writeArtifact(`${scenario}-effect-recovery-event-baseline-private.json`, baseline)
      if (baseline.data.events.some((row: any) => row.event.kind === 'permission_requested')) {
        throw new Error('ambiguous effect revived a native permission callback')
      }
      refused = await harness.adminRaw(supervisor, harness.freshAgentResolveBody(soulId, effectDecision.decision_id,
        { behavior: 'allow', updatedInput: effectDecision.payload.tool.input }))
      harness.writeArtifact(`${scenario}-ambiguous-decision-refused.json`, refused)
      const completedCacheReply = refused.result?.Ok?.kind === 'fresh_agent_command'
        && refused.result.Ok.data?.state === 'completed'
      if (!refused.result?.Err && !completedCacheReply) throw new Error('old native decision has no refusal or identical completed cache reply')
    } else {
      await inspect(recovery.data.view.containerId, 'native-edge-after-death-before-input', true)
      refused = await harness.adminRaw(supervisor, { method: 'fresh_agent_send', params: { soulId,
        text: 'Do not perform any tools. Report whether the unfinished original operation is blocked.' } })
      harness.writeArtifact(`${scenario}-native-edge-input-dispatch.json`, refused)
      if (!refused.result?.Err) {
        // The Admin reply acknowledges a sidecar write. Its actual native
        // admission refusal arrives on the normalized provider event stream.
        await wait((event) => event.kind === 'provider' && event.data.payload.event?.type === 'freshAgent.error'
          && event.data.payload.event.message?.includes('ordinary input is blocked'), 'actual unfinished-operation input refusal')
      }
      await inspect(recovery.data.view.containerId, 'native-edge-after-refused-input', true)
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    const current = await readAvailable()
    const cards = current.data.events.filter((row: any) => row.event.kind === 'permission_requested')
    if (input.decision === 'effect-before-observation' && current.data.events.some((row: any) =>
      row.event.kind === 'provider' && row.event.data.payload.event?.type === 'freshAgent.permission.dispatch')) {
      throw new Error('native decision dispatched again after its effect')
    }
    const expected = input.decision === 'effect-before-observation' ? 1 : 0
    harness.writeArtifact(`${scenario}-native-edge-outcome-private.json`, { recovery, refused, current, effectCount: effectCount() })
    if (cards.length || effectCount() !== expected) throw new Error('uncheckpointed or completed native operation revived a callback or repeated an effect')
    return [{ name: 'actual-native-operation-before-exact-enclosure-death', pass: !!originalOperation },
      { name: 'replacement-current-native-root-new-incarnation', pass: recovery.data.view.incarnationId !== view.incarnationId
        && recovery.data.view.nativeIdentityObservation.nativeSessionId === view.nativeSessionId },
      { name: 'no-resurrected-native-permission-callback', pass: cards.length === 0 },
      { name: 'independent-native-effect-count', pass: effectCount() === expected }]
  }
  const old = (await wait(isCard, 'durable checkpoint/current ask')).data
  harness.writeArtifact(`${scenario}-old-card-private.json`, old)
  const oldPayload = old.payload
  if (oldPayload.tool?.name !== 'Bash' || oldPayload.tool.input?.command !== command
    || oldPayload.nativeCheckpoint.nativeSessionId !== view.nativeSessionId
    || oldPayload.nativeCheckpoint.toolUseID !== oldPayload.toolUseID || effectCount() !== 0) {
    throw new Error('original native solo checkpoint/effect oracle differs')
  }
  async function captureCheckpointState(containerId: string, label: string) {
    const files = []
    for (const [uid, file] of [['0:0', '/run/freshell-host-actor/fresh-agent-state.json'],
      ['65534:0', `/home/freshell/provider/.freshell/native-checkpoints/claude/${view.nativeSessionId}.json`]]) {
      const source = await harness.execOwnedContainerAsExact(containerId, uid!, ['python3', '-c',
        "import pathlib,json,base64,hashlib,sys;file=pathlib.Path(sys.argv[1]);raw=file.read_bytes();assert len(raw)<=32*1024*1024;json.loads(raw);print(json.dumps({'path':str(file),'sha256':hashlib.sha256(raw).hexdigest(),'bytesBase64':base64.b64encode(raw).decode(),'readerUid':__import__('os').getuid()}))", file!])
      files.push(JSON.parse(source))
    }
    harness.writeArtifact(`${scenario}-${label}-checkpoint-state-private.json`, { nativeRoot: view.nativeSessionId, files })
    return files
  }
  const before = await inspect(view.containerId, 'checkpoint-before-death', true)
  await captureCheckpointState(view.containerId, 'before-death')
  const probe = await harness.adminOk(supervisor, harness.probeRecoveryBody(soulId))
  harness.writeArtifact(`${scenario}-approval-store-probe.json`, probe)
  if (probe.data.kind !== 'reattach_ready') throw new Error('native checkpoint store not readable before death')
  const sourceFault = ['changed-tool', 'missing-tool', 'changed-profile', 'changed-root'].includes(input.decision)
  if (sourceFault) {
    if (input.decision === 'changed-profile') {
      const directory = path.join(workspace, '.claude'); fs.mkdirSync(directory, { recursive: true, mode: 0o770 })
      fs.chmodSync(directory, 0o770)
      fs.writeFileSync(path.join(directory, 'settings.json'), JSON.stringify({ permissions: { deny: ['Bash'] } }), { mode: 0o660 })
      fs.chmodSync(path.join(directory, 'settings.json'), 0o660)
    } else {
      const mutation = JSON.parse(await harness.execOwnedContainerAsExact(view.containerId, '65534:0',
        ['python3', '-c', claudeCheckpointSourceFault, before.hook.native.transcript_path,
          view.nativeSessionId, oldPayload.toolUseID, input.decision]))
      harness.writeArtifact(`${scenario}-source-fault-private.json`, mutation)
    }
  }
  await harness.killOwnedRuntimeExact(view.containerId)
  await harness.waitForContainerExit(view.containerId)
  const recovery = await harness.adminOk(supervisor, harness.recoverBody(soulId, 'host_unreachable'))
  harness.writeArtifact(`${scenario}-approval-recovery.json`, recovery)
  const currentView = recovery.data.view
  if (sourceFault) {
    const replies = []
    if (currentView?.recoveryState === 'live') {
      replies.push(await harness.adminRaw(supervisor, harness.freshAgentResolveBody(soulId, old.decision_id,
        { behavior: 'allow', updatedInput: oldPayload.tool.input })))
      replies.push(await harness.adminRaw(supervisor, { method: 'fresh_agent_send', params: {
        soulId, text: 'Do not perform any tools. Report whether the interrupted original operation is blocked.' } }))
      if (!replies[0]?.result?.Err) throw new Error('changed native source/profile accepted an orphan decision')
      if (!replies[1]?.result?.Err) await wait((event) => event.kind === 'provider'
        && event.data.payload.event?.type === 'freshAgent.error'
        && event.data.payload.event.message?.includes('ordinary input is blocked'), 'actual changed-source input refusal')
    } else if (currentView?.recoveryState !== 'blocked') {
      throw new Error('changed native source/profile has no explicit recovery disposition')
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    const batch = currentView?.recoveryState === 'live' ? await readAvailable() : null
    harness.writeArtifact(`${scenario}-negative-native-disposition-private.json`, { recovery, replies, batch, effectCount: effectCount() })
    if (effectCount() !== 0 || batch?.data.events.some((row: any) => isCard(row.event))) {
      throw new Error('changed native source/profile replayed or revived the original operation')
    }
    return [{ name: 'actual-native-checkpoint-before-source-fault', pass: oldPayload.nativeCheckpoint.toolUseID === oldPayload.toolUseID },
      { name: 'changed-native-source-or-profile-refuses-original-operation', pass: currentView?.recoveryState === 'blocked'
        || (!!replies[0]?.result?.Err && (!!replies[1]?.result?.Err || observed.some((event) => event.kind === 'provider'
          && event.data.payload.event?.type === 'freshAgent.error' && event.data.payload.event.message?.includes('ordinary input is blocked')))) },
      { name: 'no-resurrected-native-permission-callback', pass: currentView?.recoveryState !== 'live'
        || !batch?.data.events.some((row: any) => isCard(row.event)) },
      { name: 'independent-native-effect-count', pass: effectCount() === 0 }]
  }
  if (recovery.data.outcome !== 'replaced' || currentView.incarnationId === view.incarnationId
    || currentView.nativeSessionId !== view.nativeSessionId || currentView.recoveryState !== 'live'
    || currentView.nativeIdentityObservation?.nativeSessionId !== view.nativeSessionId) throw new Error('native approval replacement not currently live on same root')
  await captureCheckpointState(currentView.containerId, 'after-replacement')
  const current = (await wait(isCard, 'rebound current native ask')).data
  harness.writeArtifact(`${scenario}-current-card-private.json`, current)
  const currentPayload = current.payload
  if (current.decision_id !== old.decision_id || currentPayload.nativeRequestId === oldPayload.nativeRequestId
    || JSON.stringify(currentPayload.nativeCheckpoint) !== JSON.stringify(oldPayload.nativeCheckpoint)
    || currentPayload.nativeBinding?.launch.incarnationId !== currentView.incarnationId
    || effectCount() !== 0) throw new Error('same native operation did not rebind to a fresh current request')
  const after = await inspect(currentView.containerId, 'checkpoint-after-death', true)
  if (!nativeCheckpointTranscriptRetained(before, after, oldPayload.toolUseID)) {
    throw new Error('original native checkpoint changed across owned enclosure death')
  }
  const refusalAssertions = []
  if (input.decision === 'changed-input' || input.decision === 'stale-callback') {
    const invalid = input.decision === 'changed-input'
      ? harness.freshAgentResolveBody(soulId, current.decision_id, { behavior: 'allow',
        updatedInput: { ...currentPayload.tool.input, command: command + '; true' } })
      : harness.freshAgentResolveBody(soulId, oldPayload.nativeRequestId, { behavior: 'allow', updatedInput: oldPayload.tool.input })
    const rejected = await harness.adminRaw(supervisor, invalid)
    harness.writeArtifact(`${scenario}-invalid-current-decision.json`, rejected)
    if (!rejected.result?.Err || effectCount() !== 0) throw new Error('changed input or old native callback was accepted')
    const retained = await inspect(currentView.containerId, 'after-invalid-decision', true)
    if (!nativeCheckpointTranscriptRetained(before, retained, oldPayload.toolUseID)) throw new Error('refused decision consumed the native checkpoint')
    refusalAssertions.push({ name: 'invalid-current-native-decision-refused-before-effect', pass: !!rejected.result.Err && effectCount() === 0 })
  }
  const allowed = input.decision === 'allow'
  const expectedEffectCount = allowed ? 1 : 0
  const decision = allowed ? { behavior: 'allow', updatedInput: currentPayload.tool.input }
    : { behavior: 'deny', message: 'The user declined this operation. Do not retry it or use any other tools. End this turn now with a short acknowledgment.' }
  const receipt = await harness.adminOk(supervisor, harness.freshAgentResolveBody(soulId, current.decision_id, decision))
  harness.writeArtifact(`${scenario}-approval-dispatch.json`, receipt)
  const terminal = await wait((event) => event.kind === 'permission_requested'
    || (event.kind === 'provider' && event.data.payload.event?.type === 'freshAgent.result'), 'native completion')
  if (terminal.kind === 'permission_requested') {
    await inspect(currentView.containerId, 'unexpected-next-operation', true)
    await captureCheckpointState(currentView.containerId, 'unexpected-next-operation')
    harness.writeArtifact(`${scenario}-unexpected-next-operation-private.json`, { originalToolUseID: oldPayload.toolUseID,
      nextOperation: terminal.data, effectCount: effectCount() })
    throw new Error('native model requested another operation after the bounded original decision')
  }
  const result = terminal.data.payload.event
  const toolResults = observed.filter((event) => event.kind === 'provider'
    && event.data.payload.event?.type === 'freshAgent.tool.result').flatMap((event) => event.data.payload.event.content ?? [])
  const toolResult = toolResults.find((part: any) => part.tool_use_id === oldPayload.toolUseID)
  const count = effectCount()
  harness.writeArtifact(`${scenario}-approval-outcome.json`, { nativeRoot: result.nativeSessionId,
    originalToolUseId: oldPayload.toolUseID, inputDigest: oldPayload.nativeCheckpoint.inputDigest,
    oldNativeRequestId: oldPayload.nativeRequestId, currentNativeRequestId: currentPayload.nativeRequestId,
    nativeToolResultIsError: toolResult?.is_error, nativeResultIsError: result.isError, effectCount: count })
  observeNativeSoloBashOutcome({ nativeRoot: view.nativeSessionId, toolUseID: oldPayload.toolUseID, allowed, observed, effectCount: count })
  return [...refusalAssertions, { name: 'same-native-operation-new-current-request-after-death',
    pass: currentPayload.nativeRequestId !== oldPayload.nativeRequestId && current.decision_id === old.decision_id },
    { name: 'native-checkpoint-original-volume-continuity',
      pass: nativeCheckpointTranscriptRetained(before, after, oldPayload.toolUseID) },
    { name: 'correlated-native-tool-result', pass: toolResult.tool_use_id === oldPayload.toolUseID
      && toolResult.is_error === !allowed },
    { name: 'independent-native-effect-count', pass: count === expectedEffectCount }]
}

// Intentional corruption of the already genuine, privately captured operation
// in this run's synthetic native store. No checkpoint row or effect is created.
const claudeCheckpointSourceFault = String.raw`
import pathlib,json,sys,hashlib,os
p=pathlib.Path(sys.argv[1]);root,tool,fault=sys.argv[2:];raw=p.read_bytes();rows=[json.loads(line) for line in raw.splitlines()]
assert raw.endswith(b'\n') and fault in ['changed-tool','missing-tool','changed-root']
matches=[r for r in rows if r.get('type')=='assistant' and any(b.get('type')=='tool_use' and b.get('id')==tool for b in r.get('message',{}).get('content',[]))]
assert len(matches)==1 and matches[0]['sessionId']==root
row=matches[0];blocks=row['message']['content'];operation=next(b for b in blocks if b.get('type')=='tool_use' and b.get('id')==tool)
if fault=='changed-tool':operation['name']='Read'
elif fault=='missing-tool':row['message']['content']=[b for b in blocks if b is not operation]
else:row['sessionId']='00000000-0000-4000-8000-000000000004'
changed=b''.join(json.dumps(r,separators=(',',':')).encode()+b'\n' for r in rows)
with p.open('wb') as f:f.write(changed);f.flush();os.fsync(f.fileno())
print(json.dumps({'fault':fault,'originalSha256':hashlib.sha256(raw).hexdigest(),'currentSha256':hashlib.sha256(changed).hexdigest(),'originalBytes':len(raw),'currentBytes':len(changed),'nativeRoot':root,'originalToolUseID':tool}))
`

const amplifierNativeInspection = String.raw`
import pathlib,os,json,hashlib,sys,base64,ssl,urllib.request,importlib.metadata as native_metadata
file=pathlib.Path(sys.argv[1]);root=sys.argv[2];check_tls=sys.argv[3]=='true';assert file.name=='transcript.jsonl' and file.parent.name==root
with file.open('rb') as f:
 before=os.fstat(f.fileno());raw=f.read();after=os.fstat(f.fileno())
identity=lambda s:[str(s.st_dev),str(s.st_ino),str(s.st_size),str(s.st_mtime_ns),str(s.st_ctime_ns)]
assert identity(before)==identity(after)==identity(file.stat()) and (not raw or raw.endswith(b'\n'))
messages=[json.loads(line) for line in raw.splitlines() if line.strip()]
meta=json.loads((file.parent/'metadata.json').read_text());assert meta['session_id']==root and meta.get('parent_id') is None
events_file=file.parent/'events.jsonl';event_raw=events_file.read_bytes() if events_file.exists() else b''
events=[json.loads(line) for line in event_raw.split(b'\n')[:-1] if line.strip()]
matches=[]
for p in pathlib.Path('/proc').iterdir():
 if not p.name.isdigit():continue
 try:
  env=dict(v.decode().split('=',1) for v in (p/'environ').read_bytes().split(b'\0') if b'=' in v)
  cmd=(p/'cmdline').read_bytes().split(b'\0')
  if 'FRESHELL_NATIVE_IDENTITY_SIGNAL_DIR' in env and any(x.endswith(b'/amplifier') or x==b'amplifier' for x in cmd):matches.append((p,env))
 except (OSError,ValueError):continue
assert len(matches)==1
p,env=matches[0]
status=None;context=ssl.create_default_context(cafile=env['SSL_CERT_FILE'])
if check_tls:
 proxy=env.get('HTTPS_PROXY') or env.get('https_proxy');opener=urllib.request.build_opener(urllib.request.ProxyHandler({'https':proxy}),urllib.request.HTTPSHandler(context=context))
 request=urllib.request.Request(env['LUNAROUTE_BASE_URL'].rstrip('/')+'/models',headers={'Authorization':'Bearer '+env['LUNAROUTE_API_KEY']})
 with opener.open(request,timeout=20) as response:status=response.status;response.read()
profile=[]
for relative in ['.amplifier/settings.yaml','.amplifier/bundles/default.yaml','.amplifier/keys.env']:
 source=pathlib.Path(env['HOME'])/relative;body=source.read_bytes() if source.exists() else None;profile.append({'relative':relative,'sha256':hashlib.sha256(body).hexdigest() if body is not None else None,'bytesBase64':base64.b64encode(body).decode() if body is not None else None})
native_cwd=os.readlink(p/'cwd');os.environ.clear();os.environ.update(env);os.chdir(native_cwd)
from amplifier_app_cli.key_manager import KeyManager
from amplifier_app_cli.lib.settings import AppSettings
from amplifier_app_cli.runtime.config import expand_env_vars
import yaml
KeyManager();settings=AppSettings();settings_files=[]
for source in [settings.paths.global_settings,settings.paths.project_settings,settings.paths.local_settings]:
 body=source.read_bytes() if source.exists() else None
 if body is not None:assert isinstance(yaml.safe_load(body) or {},dict)
 settings_files.append({'path':str(source),'bytesBase64':base64.b64encode(body).decode() if body is not None else None})
native_settings_sha=hashlib.sha256(json.dumps(expand_env_vars(settings.get_merged_settings()),sort_keys=True,separators=(',',':')).encode()).hexdigest()
cli=pathlib.Path('/opt/amplifier-src/.venv/bin/amplifier');original_cli=cli.with_name('amplifier.native')
producer=pathlib.Path('/opt/amplifier-src/amplifier_app_cli/freshell_native_resume.py')
native_versions={'cliVersion':native_metadata.version('amplifier-app-cli'),'coreVersion':native_metadata.version('amplifier-core'),
 'executableSha256':hashlib.sha256(cli.read_bytes()).hexdigest(),
 'originalCliSha256':hashlib.sha256((original_cli if original_cli.exists() else cli).read_bytes()).hexdigest(),
 'producerSha256':hashlib.sha256(producer.read_bytes()).hexdigest()}
assistants=[m for m in messages if m.get('role')=='assistant']
def text(m):
 c=m.get('content');return c if isinstance(c,str) else ''.join(p.get('text','') for p in (c or []) if isinstance(p,dict) and p.get('type')=='text')
print(json.dumps({**native_versions,'nativeRoot':root,'nativePid':int(p.name),'transcript':{'identity':identity(after),'sha256':hashlib.sha256(raw).hexdigest(),'completeEof':not raw or raw.endswith(b'\n'),'bytesBase64':base64.b64encode(raw).decode()},'eventsBytesBase64':base64.b64encode(event_raw).decode(),'metadata':meta,'completedTurns':sum(e.get('event')=='cleanup:store_end' for e in events),'toolEvents':sum(str(e.get('event','')).startswith('tool:') for e in events),'responses':[e.get('data') for e in events if e.get('event')=='llm:response'],'lastAssistantText':text(assistants[-1]) if assistants else '', 'profileFiles':profile,'nativeCwd':native_cwd,'nativeSettingsSha256':native_settings_sha,'nativeSettingsFiles':settings_files,'httpsStatus':status,'tlsVerifyMode':context.verify_mode.value,'tlsCheckHostname':context.check_hostname}))
`

// Reads the currently owned native child and its exact hook-selected transcript.
// Raw bytes are saved only in the run's private artifact; reports use metadata.
export const terminalForkFaultHook = String.raw`
import fs from 'node:fs'
import path from 'node:path'
import {createHash} from 'node:crypto'
const digest=bytes=>createHash('sha256').update(bytes).digest('hex')
let input='';for await(const chunk of process.stdin)input+=chunk
const native=JSON.parse(input)
if(native.source==='fork') {
 const workspace=process.cwd(),control=JSON.parse(fs.readFileSync(path.join(workspace,'native-fork-fault-control.json'),'utf8'))
 const launch=JSON.parse(process.env.FRESHELL_NATIVE_IDENTITY_LAUNCH)
 if(launch.requestedNativeSessionId!==control.root || native.cwd!==workspace) throw new Error('owned native fork binding mismatch')
 if(!native.session_id || native.session_id===control.root) throw new Error('actual native fork root missing')
 const selected='/usr/local/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe',nativeExecutableSha256=digest(fs.readFileSync(selected))
 const pids=fs.readdirSync('/proc').filter(id=>/^\d+$/.test(id)).filter(id=>{try{return digest(fs.readFileSync('/proc/'+id+'/exe'))===nativeExecutableSha256}catch{return false}})
 if(pids.length!==1)throw new Error('current native fork writer ambiguous')
 const pid=pids[0],nativeArgv=fs.readFileSync('/proc/'+pid+'/cmdline').toString().split('\0').filter(Boolean)
 const file=path.resolve(path.dirname(native.transcript_path),control.root+'.jsonl'),store=path.resolve(process.env.CLAUDE_CONFIG_DIR ?? path.join(process.env.HOME,'.claude'),'projects')+path.sep
 if(!file.startsWith(store) || !fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink())throw new Error('unowned original fork store refused')
 const before=fs.statSync(file),original=fs.readFileSync(file),after=fs.statSync(file)
 if(before.dev!==after.dev || before.ino!==after.ino || original.at(-1)!==10)throw new Error('native original fork store changed during capture')
 fs.writeFileSync(path.join(workspace,'native-fork-fault-observation.json'),JSON.stringify({native,launch,nativePid:Number(pid),nativeExecutableSha256,nativeArgv,
  uid:process.getuid(),gid:process.getgid(),originalPrefixSha256:digest(original.subarray(0,control.seedBytes)),identity:[String(after.dev),String(after.ino)]}),{mode:0o664})
}
process.stdout.write('{}\n')
`

export const claudeNativeRestorationFault = String.raw`
import pathlib,json,hashlib,os,sys
root=sys.argv[1];expected=sys.argv[2];identity=json.loads(sys.argv[3]);home=pathlib.Path('/home/freshell/provider/.claude/projects')
files=list(home.glob('*/'+root+'.jsonl'));assert len(files)==1 and files[0].is_file() and not files[0].is_symlink()
file=files[0];before=file.stat();raw=file.read_bytes();assert raw.endswith(b'\n') and hashlib.sha256(raw).hexdigest()==expected
assert [str(before.st_dev),str(before.st_ino)]==identity[:2]
rows=[json.loads(line) for line in raw.splitlines()];changed=0
for row in rows:
 if row.get('type')=='assistant':
  assert row.get('sessionId')==root and isinstance(row.get('message',{}).get('content'),list)
  assert not any(part.get('type')=='tool_use' for part in row['message']['content'])
  row['message']['content']='owned malformed native assistant';changed+=1
assert changed>0
modified=b''.join((json.dumps(row,separators=(',',':'))+'\n').encode() for row in rows)
with file.open('r+b') as handle:handle.write(modified);handle.truncate();handle.flush();os.fsync(handle.fileno())
after=file.stat();assert before.st_dev==after.st_dev and before.st_ino==after.st_ino
print(json.dumps({'root':root,'beforeSha256':hashlib.sha256(raw).hexdigest(),'afterSha256':hashlib.sha256(file.read_bytes()).hexdigest(),
 'afterBytes':after.st_size,'changedAssistantRows':changed,'identity':[str(after.st_dev),str(after.st_ino)],'uid':os.getuid(),'gid':os.getgid()}))
`

export const terminalRestorationFaultHook = String.raw`
import fs from 'node:fs'
import path from 'node:path'
import {createHash} from 'node:crypto'
import {spawn} from 'node:child_process'
import {fileURLToPath} from 'node:url'
const digest=bytes=>createHash('sha256').update(bytes).digest('hex')
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms))
if(process.argv[2]==='--observe') {
 const config=JSON.parse(process.argv[3]);const deadline=Date.now()+5000
 while(Date.now()<deadline) {
  const present=fs.existsSync('/proc/'+config.nativePid+'/exe')
  const loaded=path.join(config.signalDirectory,'statusline-loaded.json')
  if(!present || fs.existsSync(loaded)) {
   const observation={...config, nativeExited:!present, loadedSha256:fs.existsSync(loaded)?digest(fs.readFileSync(loaded)):null}
   fs.writeFileSync(config.observationPath,JSON.stringify(observation),{mode:0o664});break
  }
  await pause(10)
 }
} else {
 let input='';for await(const chunk of process.stdin)input+=chunk
 const native=JSON.parse(input)
 if(native.source==='resume') {
  const workspace=process.cwd(), control=JSON.parse(fs.readFileSync(path.join(workspace,'native-restoration-fault-control.json'),'utf8'))
  const launch=JSON.parse(process.env.FRESHELL_NATIVE_IDENTITY_LAUNCH)
  if(native.session_id!==control.root || launch.requestedNativeSessionId!==control.root || native.cwd!==workspace) throw new Error('owned native resume binding mismatch')
  const signalDirectory=process.env.FRESHELL_NATIVE_IDENTITY_SIGNAL_DIR
  const signal=path.join(signalDirectory,'session-start.json'),deadline=Date.now()+3000
  while(!fs.existsSync(signal) && Date.now()<deadline) await pause(10)
  const hook=JSON.parse(fs.readFileSync(signal,'utf8'))
  if(JSON.stringify(hook.launch)!==JSON.stringify(launch) || hook.native.session_id!==control.root || hook.native.source!=='resume') throw new Error('current genuine native hook missing')
  const transcript=path.resolve(native.transcript_path),store=path.resolve(process.env.CLAUDE_CONFIG_DIR ?? path.join(process.env.HOME,'.claude'),'projects')+path.sep
  if(!transcript.startsWith(store) || path.basename(transcript)!==control.root+'.jsonl' || !fs.lstatSync(transcript).isFile()) throw new Error('unowned transcript fault refused')
  const original=fs.readFileSync(transcript)
  if(original.at(-1)!==10 || digest(original.subarray(0,control.afterBytes))!==control.afterSha256) throw new Error('owned malformed native source changed')
  const selected='/usr/local/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe'
  const nativeExecutableSha256=digest(fs.readFileSync(selected))
  const pids=fs.readdirSync('/proc').filter(id=>/^\d+$/.test(id)).filter(id=>{try{return digest(fs.readFileSync('/proc/'+id+'/exe'))===nativeExecutableSha256}catch{return false}})
  if(pids.length!==1)throw new Error('current native writer ambiguous')
  const config={hook,signalDirectory,nativePid:Number(pids[0]),nativeExecutableSha256,uid:process.getuid(),gid:process.getgid(),
   beforeSha256:control.beforeSha256,afterSha256:control.afterSha256,observedFaultPrefixSha256:digest(original.subarray(0,control.afterBytes)),changedAssistantRows:control.changedAssistantRows,
   observationPath:path.join(workspace,'native-restoration-fault-observation.json')}
  const observer=spawn(process.execPath,[fileURLToPath(import.meta.url),'--observe',JSON.stringify(config)],{stdio:'ignore'})
  observer.unref()
 }
 process.stdout.write('{}\n')
}
`

export const sdkRestorationFaultHook = String.raw`
import fs from 'node:fs'
import path from 'node:path'
import {createHash} from 'node:crypto'
import {spawn} from 'node:child_process'
import {fileURLToPath} from 'node:url'
const digest=bytes=>createHash('sha256').update(bytes).digest('hex')
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms))
if(process.argv[2]==='--observe') {
 const config=JSON.parse(process.argv[3]),deadline=Date.now()+5000
 while(Date.now()<deadline) {
  if(!fs.existsSync('/proc/'+config.nativePid+'/exe')) {
   fs.writeFileSync(config.observationPath,JSON.stringify({...config,nativeExited:true}),{mode:0o664});break
  }
  await pause(10)
 }
} else {
 let input='';for await(const chunk of process.stdin)input+=chunk
 const native=JSON.parse(input)
 if(native.source==='resume') {
  const workspace=process.cwd(),control=JSON.parse(fs.readFileSync(path.join(workspace,'native-restoration-fault-control.json'),'utf8'))
  const launch=JSON.parse(process.env.FRESHELL_NATIVE_IDENTITY_LAUNCH)
  if(native.session_id!==control.root || launch.requestedNativeSessionId!==control.root || native.cwd!==workspace
   || !launch.incarnationId || !launch.launchNonce)throw new Error('owned SDK resume binding mismatch')
  const signal=path.join(process.env.FRESHELL_NATIVE_IDENTITY_SIGNAL_DIR,'session-start.json'),deadline=Date.now()+3000
  while(!fs.existsSync(signal) && Date.now()<deadline)await pause(10)
  const hook=JSON.parse(fs.readFileSync(signal,'utf8'))
  if(JSON.stringify(hook.launch)!==JSON.stringify(launch) || hook.native.session_id!==control.root || hook.native.source!=='resume')throw new Error('current genuine SDK native hook missing')
  const transcript=path.resolve(native.transcript_path),store=path.resolve(process.env.CLAUDE_CONFIG_DIR ?? path.join(process.env.HOME,'.claude'),'projects')+path.sep
  if(!transcript.startsWith(store) || path.basename(transcript)!==control.root+'.jsonl'
   || !fs.lstatSync(transcript).isFile() || fs.lstatSync(transcript).isSymbolicLink())throw new Error('unowned SDK restoration source refused')
  const before=fs.statSync(transcript),raw=fs.readFileSync(transcript),after=fs.statSync(transcript)
  const identity=[String(after.dev),String(after.ino)]
  if(before.dev!==after.dev || before.ino!==after.ino || JSON.stringify(identity)!==JSON.stringify(control.identity.slice(0,2))
   || raw.at(-1)!==10 || digest(raw.subarray(0,control.seedBytes))!==control.seedSha256)throw new Error('owned SDK native source changed')
  const rows=raw.toString().trim().split('\n').map(line=>JSON.parse(line))
  if(rows.some(row=>row.uuid===control.missingAnchor || row.sessionId && row.sessionId!==control.root)
   || !rows.some(row=>row.type==='assistant' && row.message?.stop_reason==='end_turn'))throw new Error('native missing-anchor restoration fault differs')
  const selected='/opt/freshell-claude-sidecar/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude.native'
  const nativeExecutableSha256=digest(fs.readFileSync(selected))
  const pids=fs.readdirSync('/proc').filter(id=>/^\d+$/.test(id)).filter(id=>{try{return digest(fs.readFileSync('/proc/'+id+'/exe'))===nativeExecutableSha256}catch{return false}})
  if(pids.length!==1)throw new Error('current SDK native writer ambiguous')
  const nativeArgv=fs.readFileSync('/proc/'+pids[0]+'/cmdline').toString().split('\0').filter(Boolean)
  const roots=nativeArgv.flatMap((arg,index)=>arg==='--resume'?[nativeArgv[index+1]]:arg.startsWith('--resume=')?[arg.slice(9)]:[])
  const anchors=nativeArgv.flatMap((arg,index)=>arg==='--resume-session-at'?[nativeArgv[index+1]]:arg.startsWith('--resume-session-at=')?[arg.slice(20)]:[])
  if(roots.length!==1 || roots[0]!==control.root || anchors.length!==1 || anchors[0]!==control.missingAnchor)throw new Error('actual SDK native resume anchor differs')
  const config={hook,nativePid:Number(pids[0]),nativeExecutableSha256,nativeArgv,uid:process.getuid(),gid:process.getgid(),
   missingAnchor:control.missingAnchor,originalPrefixSha256:digest(raw.subarray(0,control.seedBytes)),identity,
   observationPath:path.join(workspace,'native-restoration-fault-observation.json')}
  const observer=spawn(process.execPath,[fileURLToPath(import.meta.url),'--observe',JSON.stringify(config)],{stdio:'ignore'});observer.unref()
 }
 process.stdout.write('{}\n')
}
`

export const claudeNativeInspection = String.raw`
import pathlib,os,json,hashlib,ssl,urllib.parse,urllib.request,subprocess,sys,base64
root=sys.argv[1];required=sys.argv[2]=='true';terminal=len(sys.argv)>3 and sys.argv[3]=='terminal'
missing_callbacks=len(sys.argv)>4 and sys.argv[4] in (['disabled-hooks','trust-refusal','unwritable-signal'] if terminal else ['disabled-hooks'])
wrong_root=not terminal and len(sys.argv)>4 and sys.argv[4]=='wrong-id'
sdk_fork_image=not terminal and len(sys.argv)>5 and sys.argv[5]=='sdk-fork-image'
selected=pathlib.Path('/usr/local/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe' if terminal else '/opt/freshell-claude-sidecar/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude'+('.native' if sdk_fork_image else ''))
expected=hashlib.sha256(selected.read_bytes()).hexdigest();matches=[]
for p in pathlib.Path('/proc').iterdir():
 if not p.name.isdigit():continue
 try:
  env=dict(v.decode().split('=',1) for v in (p/'environ').read_bytes().split(b'\0') if b'=' in v)
  if 'FRESHELL_NATIVE_IDENTITY_SIGNAL_DIR' in env and (terminal or 'FRESHELL_CLAUDE_SIDECAR_ID' in env) and hashlib.sha256((p/'exe').read_bytes()).hexdigest()==expected:matches.append((p,env))
 except (OSError,ValueError):continue
assert len(matches)==1
p,env=matches[0];signal_dir=pathlib.Path(env['FRESHELL_NATIVE_IDENTITY_SIGNAL_DIR']);hook_file=signal_dir/'session-start.json';loaded_file=signal_dir/'statusline-loaded.json'
hook=None if missing_callbacks and not hook_file.exists() else json.loads(hook_file.read_text())
assert hook is None and missing_callbacks or hook is not None and (wrong_root or hook['native']['session_id']==root)
loaded=None if not terminal or missing_callbacks and not loaded_file.exists() else json.loads(loaded_file.read_text())
ca=pathlib.Path(env.get('SSL_CERT_FILE') or env['NODE_EXTRA_CA_CERTS']);context=ssl.create_default_context(cafile=str(ca));proxy=env.get('HTTPS_PROXY') or env.get('https_proxy')
opener=urllib.request.build_opener(urllib.request.ProxyHandler({'https':proxy}),urllib.request.HTTPSHandler(context=context))
with opener.open(urllib.request.Request('https://api.anthropic.com/v1/models',headers={'anthropic-version':'2023-06-01','authorization':'Bearer '+env['CLAUDE_CODE_OAUTH_TOKEN']}),timeout=20) as r:status=r.status;r.read()
home=pathlib.Path(env.get('CLAUDE_CONFIG_DIR') or str(pathlib.Path(env['HOME'])/'.claude'));cwd=pathlib.Path(hook['native']['cwd']) if hook else (p/'cwd').resolve();profile=[]
native_argv=[v.decode() for v in (p/'cmdline').read_bytes().split(b'\0') if v]
settings=json.loads((home/'settings.json').read_text()) if (home/'settings.json').exists() else {}
files=[home/'settings.json',cwd/'.claude/settings.json',cwd/'.claude/settings.local.json']
if terminal:files.append(home/'.claude.json')
for file in files:
 profile.append({'path':str(file),'sha256':hashlib.sha256(file.read_bytes()).hexdigest() if file.exists() else None})
transcript=None;rows=[];candidates=list(home.glob('projects/**/'+root+'.jsonl')) if not hook else []
assert len(candidates)<=1
file=pathlib.Path(hook['native']['transcript_path']) if hook else (candidates[0] if candidates else None)
if file is not None and file.exists():
 with file.open('rb') as f:
  before=os.fstat(f.fileno());raw=f.read();after=os.fstat(f.fileno())
 identity=lambda s:[str(s.st_dev),str(s.st_ino),str(s.st_size),str(s.st_mtime_ns),str(s.st_ctime_ns)]
 assert identity(before)==identity(after)==identity(file.stat()) and (not raw or raw.endswith(b'\n'))
 rows=[json.loads(line) for line in raw.splitlines() if line.strip()];assert all(row.get('sessionId',root)==root for row in rows)
 transcript={'identity':identity(after),'sha256':hashlib.sha256(raw).hexdigest(),'completeEof':True,'bytesBase64':base64.b64encode(raw).decode(),'rowCount':len(rows)}
assert not required or transcript is not None
assistants=[row for row in rows if row.get('type')=='assistant'];tool_events=sum(part.get('type')=='tool_use' for row in assistants for part in row.get('message',{}).get('content',[]) if isinstance(part,dict))
completed_ids={row['message']['id'] for row in assistants if row.get('message',{}).get('stop_reason')=='end_turn' and row['message'].get('id')}
last_text=''.join(part.get('text','') for part in (assistants[-1].get('message',{}).get('content',[]) if assistants else []) if isinstance(part,dict) and part.get('type')=='text')
preferences=json.loads((home/'.claude.json').read_text()) if terminal else None
native_preferences={key:preferences.get(key) for key in ['theme','hasCompletedOnboarding']} if preferences else None
if native_preferences is not None:native_preferences['workspaceTrust']=preferences.get('projects',{}).get(str(cwd),{}).get('hasTrustDialogAccepted')
print(json.dumps({'uid':os.getuid(),'gid':os.getgid(),'caps':next(x.split()[1] for x in pathlib.Path('/proc/self/status').read_text().splitlines() if x.startswith('CapEff:')),'readOnlyRoot':bool(os.statvfs('/').f_flag&os.ST_RDONLY),'nativePid':int(p.name),'nativeRoot':hook['native']['session_id'] if hook else None,'hook':hook,'hookSha256':hashlib.sha256(hook_file.read_bytes()).hexdigest() if hook else None,'loaded':loaded,'hooksDisabled':settings.get('disableAllHooks'),'nativeLaunch':json.loads(env['FRESHELL_NATIVE_IDENTITY_LAUNCH']),'signalDirectory':str(signal_dir),'signalWritable':os.access(signal_dir,os.W_OK),'signalMode':oct(signal_dir.stat().st_mode&0o777) if signal_dir.exists() else None,'nativeArgv':native_argv,'nativeCwd':str((p/'cwd').resolve()),'executableSha256':expected,'version':subprocess.check_output([str(selected),'--version'],text=True).strip(),'profileFiles':profile,'nativePreferences':native_preferences,'completedTurns':len(completed_ids),'toolEvents':tool_events,'lastAssistantText':last_text,'caSha256':hashlib.sha256(ca.read_bytes()).hexdigest(),'tlsVerifyMode':context.verify_mode.value,'tlsCheckHostname':context.check_hostname,'httpsStatus':status,'transcript':transcript}))
`

export async function runNativeFeasibilityCli(args = process.argv.slice(2)): Promise<void> {
  try {
    await runNativeFeasibility(args)
  } catch (error) {
    const secrets = Object.entries(process.env).filter(([key]) => /TOKEN|PASSWORD|SECRET|API_KEY|AUTHORIZATION/i.test(key))
      .map(([, value]) => value ?? '')
    const failure = { severity: 'error', event: 'runtime.native_feasibility.failed',
      reason: error instanceof Error ? error.message : 'unknown failure', execution: nativeExecutionDetails(error) }
    process.stderr.write(`${redactNativeDiagnostic(JSON.stringify(failure), secrets)}\n`)
    process.exitCode = 1
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void runNativeFeasibilityCli()
}
