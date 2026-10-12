import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import WebSocket from 'ws'
import { WS_PROTOCOL_VERSION, type ClientMessage } from '../../shared/ws-protocol.js'
import { ManagedRuntimeBrowserRig, type ManagedRuntimeView } from '../../test/e2e-browser/helpers/managed-runtime.js'
import { authorizeProviderParityRequest, captureProviderParityVolumes, cleanupProviderParityVolumes } from '../../test/helpers/provider-parity-broker.js'
import { managedEnvironmentOpencodeSelection } from '../../test/helpers/provider-parity-environment.js'
import { fakeOnecliGrants } from '../../test/integration/server/provider-parity-onecli.js'
import type { InitialProviderVolumeAuthorization } from './runtime-test-broker.js'
import { resolvePairedExternalFixture } from './e2e-external-target.js'
import { assertManagedTerminalCreated, observeManagedEnvironmentNativeIdentity, readManagedEnvironmentDaemonId, serviceManagedEnvironmentCases } from './managed-environment-create.js'

const cloudflaredVersion = '2026.10.0'
const cloudflaredSha = 'd33ff2d14475178d2012c2c56beba87389ac5ded27649519f198a7d3134a99db'
const scenarios = ['healthy', 'missing-reference', 'startup-before-identity'] as const
const ordinaryFixtureMode = 'managed-fixture-ordinary'
const delay = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds))
const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')

async function poll<T>(description: string, operation: () => Promise<T | undefined>, timeout = 180_000): Promise<T> {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const value = await operation()
    if (value !== undefined) return value
    await delay(250)
  }
  throw new Error(`Managed environment timed out: ${description}`)
}

async function writeJson(selected: string, value: unknown) {
  await fs.writeFile(selected, JSON.stringify(value, null, 2), { mode: 0o600 })
}

async function readJson(selected: string): Promise<any | undefined> {
  try { return JSON.parse(await fs.readFile(selected, 'utf8')) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
}

async function processIdentity(child: { pid?: number }) {
  assert(child.pid)
  const raw = await fs.readFile(`/proc/${child.pid}/stat`, 'utf8')
  const fields = raw.slice(raw.lastIndexOf(')') + 2).trim().split(/\s+/)
  return { pid: child.pid, parentPid: Number(fields[1]), birthTicks: fields[19], cwd: await fs.readlink(`/proc/${child.pid}/cwd`) }
}

type NativeExit = { code: number | null; signal: NodeJS.Signals | null }

function joined(child: ChildProcess): Promise<NativeExit> {
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
}

async function bounded<T>(completion: Promise<T>, milliseconds: number, description: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([completion, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Managed environment timed out: ${description}`)), milliseconds)
    })])
  } finally { clearTimeout(timer) }
}

async function stopExact(child: ChildProcess | undefined, identity: Awaited<ReturnType<typeof processIdentity>> | undefined,
  completion: Promise<NativeExit> | undefined) {
  if (!child || !completion) return
  if (child.exitCode === null && child.signalCode === null) {
    try {
      assert(identity, 'Live owned child has no captured identity; retain its fixture')
      const current = await processIdentity(child)
      assert.deepEqual(current, identity, 'Owned child identity changed; retain it')
      child.kill('SIGTERM')
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    try { return await bounded(completion, 15_000, 'owned child graceful join') }
    catch (error) {
      if (child.exitCode !== null || child.signalCode !== null) throw error
      assert.deepEqual(await processIdentity(child), identity, 'Owned child identity changed before escalation; retain it')
      child.kill('SIGKILL')
    }
  }
  return bounded(completion, 15_000, 'owned child final join')
}

async function terminalDirectory(rig: ManagedRuntimeBrowserRig): Promise<any[]> {
  const response = await fetch(`${rig.info.baseUrl}/api/terminals`, {
    headers: { 'x-auth-token': rig.info.token }, signal: AbortSignal.timeout(30_000) })
  assert(response.ok, 'Owned terminal directory request failed')
  const rows = await response.json()
  assert(Array.isArray(rows), 'Owned terminal directory must return its real rows')
  return rows
}

async function webChildren(rig: ManagedRuntimeBrowserRig): Promise<number[]> {
  const { pid } = rig.web.processEvidence()
  const children = new Set<number>()
  for (const thread of await fs.readdir(`/proc/${pid}/task`)) {
    try {
      const selected = await fs.readFile(`/proc/${pid}/task/${thread}/children`, 'utf8')
      for (const child of selected.trim().split(/\s+/).filter(Boolean)) children.add(Number(child))
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  assert.equal(rig.web.processEvidence().pid, pid, 'Owned scratch web server changed during child observation')
  return [...children].sort((left, right) => left - right)
}

async function configure(root: string, nonce: string, candidateSha: string, runId: string) {
  const home = path.join(root, 'home'), xdg = path.join(home, 'fixture-xdg'), workspace = path.join(root, 'workspace')
  const resources = path.join(workspace, 'selected-resources'), plugin = path.join(resources, 'fixture-plugin')
  await fs.mkdir(path.join(plugin, 'node_modules/managed-fixture-dependency'), { recursive: true, mode: 0o755 })
  await fs.mkdir(path.join(xdg, 'opencode'), { recursive: true, mode: 0o755 })
  await fs.chmod(home, 0o700)
  await fs.chmod(root, 0o751)
  // Register a known CLI without a managed adapter through the normal HOME
  // extension scan. Shell uses the managed facade when a controller is present;
  // this mode reaches the ordinary registry.create refusal instead.
  const ordinaryExtension = path.join(home, '.freshell/extensions', ordinaryFixtureMode)
  await fs.mkdir(ordinaryExtension, { recursive: true, mode: 0o700 })
  await writeJson(path.join(ordinaryExtension, 'freshell.json'), {
    name: ordinaryFixtureMode, version: '1.0.0', label: 'Ordinary terminal fixture',
    description: 'Owned ordinary terminal refusal fixture', category: 'cli', cli: { command: '/bin/false' },
  })
  await fs.writeFile(path.join(plugin, 'node_modules/managed-fixture-dependency/package.json'), '{"type":"module","exports":"./index.mjs"}')
  await fs.writeFile(path.join(plugin, 'node_modules/managed-fixture-dependency/index.mjs'), `export default ${JSON.stringify(nonce)};`)
  await fs.writeFile(path.join(plugin, 'selected-resource'), nonce, { mode: 0o600 })
  const command = path.join(plugin, 'command')
  await fs.writeFile(command, `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify({ resource: nonce })}'\n`, { mode: 0o751 })
  await fs.chmod(command, 0o751)
  await fs.writeFile(path.join(plugin, 'package.json'), '{"type":"module","exports":{"./server":"./server.mjs","./tui":"./tui.mjs"}}')
  await fs.writeFile(path.join(plugin, 'server.mjs'), `export default {id:'managed-environment-server',async server(){return {async config(){if(process.cwd().endsWith('/startup-before-identity'))throw new Error('startup-fixture failed before native identity')}}}};`)
  // Exact pinned API: OpenCode v1.18.21 packages/plugin/src/tui.ts and specs/tui-plugins.md.
  // The SDK creates only an empty local session; no prompt or model call is made.
  await fs.writeFile(path.join(plugin, 'tui.mjs'), `import fs from 'node:fs';import path from 'node:path';import dependency from 'managed-fixture-dependency';
export default {id:'managed-environment-tui',async tui(api,options){
 const command=new URL('./command',import.meta.url), resource=fs.readFileSync(new URL('./selected-resource',import.meta.url),'utf8');
 const child=Bun.spawn([command.pathname],{stdout:'pipe',stderr:'pipe'});const output=JSON.parse(await new Response(child.stdout).text());if(await child.exited!==0)throw new Error('selected executable failed');
 const cwd=process.cwd();const configuration=await api.client.config.get({directory:cwd});if(!configuration.data?.agent)throw new Error('resolved provider configuration was not available');const sessionFlag=process.argv.findIndex(value=>value==='--session'||value==='-s');const resumed=sessionFlag>=0?process.argv[sessionFlag+1]:undefined;const result=resumed?await api.client.session.get({directory:cwd,sessionID:resumed}):await api.client.session.create({directory:cwd,title:'Managed fixture'});if(!result.data?.id||(resumed&&result.data.id!==resumed))throw new Error('native session creation or resume failed');api.route.navigate('session',{sessionID:result.data.id});
 const receipt={...options,terminalId:process.env.FRESHELL_TERMINAL_ID,nativeSessionId:result.data.id,bun:typeof Bun==='object',bunVersion:Bun.version,bunExecutable:process.execPath,opencodeVersion:api.app.version,dependency,resource,absoluteReference:configuration.data.agent.fixtureAbsolute.prompt,relativeReference:configuration.data.agent.fixtureRelative.prompt,executableMode:(fs.statSync(command).mode&511).toString(8).padStart(4,'0'),pid:process.pid,createdAt:new Date().toISOString()};
 fs.writeFileSync(path.join(cwd,'.managed-fixture/child-receipt.json'),JSON.stringify(receipt));const marker='MANAGED_ENV_OUTPUT '+output.resource;process.stdout.write('\\n'+marker+'\\n');api.ui.toast.show({message:marker,duration:180000});
}};`)
  const absoluteRule = path.join(resources, 'absolute-rule.txt')
  await fs.writeFile(absoluteRule, nonce, { mode: 0o600 })
  const options = { expectedNonce: nonce, candidateSha, runId }
  await writeJson(path.join(xdg, 'opencode/opencode.json'), { plugin: [[plugin, options]], agent: { fixtureAbsolute: { prompt: `{file:${absoluteRule}}` } } })
  await writeJson(path.join(xdg, 'opencode/tui.json'), { plugin: [[plugin, options]] })
  for (const scenario of [...scenarios, 'preflight']) {
    const cwd = path.join(workspace, scenario)
    await fs.mkdir(path.join(cwd, '.managed-fixture'), { recursive: true, mode: 0o777 })
    await fs.chmod(cwd, 0o777)
    await fs.chmod(path.join(cwd, '.managed-fixture'), 0o777)
    await fs.writeFile(path.join(cwd, 'rules.txt'), nonce, { mode: 0o600 })
    await writeJson(path.join(cwd, 'opencode.json'), { agent: { fixtureRelative: {
      prompt: `{file:./${scenario === 'missing-reference' ? 'missing-selected.txt' : 'rules.txt'}}` } } })
  }
  return { home, xdg, workspace, command }
}

async function socketCreate(rig: ManagedRuntimeBrowserRig, requestId: string, mode: 'shell' | 'opencode', cwd: string,
  capabilities?: Record<string, true>) {
  const ws = new WebSocket(rig.info.wsUrl)
  const messages: any[] = []
  const closed = new Promise<void>(resolve => ws.once('close', () => resolve()))
  ws.on('message', bytes => messages.push(JSON.parse(bytes.toString())))
  try {
    await bounded(new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) }),
      30_000, 'owned WebSocket open')
    const hello = { type: 'hello', token: rig.info.token, protocolVersion: WS_PROTOCOL_VERSION,
      ...(capabilities ? { capabilities } : {}) } satisfies ClientMessage
    ws.send(JSON.stringify(hello))
    const ready = await poll('authenticated ready', async () => messages.find(message => message.type === 'ready'), 30_000)
    if (capabilities?.managedRuntimeV1) assert.equal(ready.capabilities?.managedRuntimeV1, true)
    const create = { type: 'terminal.create', requestId, mode, shell: 'system', cwd } satisfies ClientMessage
    ws.send(JSON.stringify(create))
    return await poll('terminal create response', async () => messages.find(message =>
      message.requestId === requestId && (message.type === 'terminal.created' || message.type === 'error')), 120_000)
  } finally {
    if (ws.readyState !== WebSocket.CLOSED) ws.close()
    try { await bounded(closed, 5_000, 'owned WebSocket close') }
    catch { ws.terminate(); await bounded(closed, 5_000, 'owned WebSocket terminate join') }
  }
}

async function stageProof(rig: ManagedRuntimeBrowserRig, view: ManagedRuntimeView, nonce: string) {
  const base = path.join(rig.runtime.scenarioPath(rig.supervisor.scenarioId), 'control')
  for (const generation of await fs.readdir(path.join(base, 'provider-roots'))) {
    const capability = await readJson(path.join(base, 'mcp-capabilities', `${generation}.json`))
    if (capability?.soulId !== view.soulId || (capability.incarnationId && capability.incarnationId !== view.incarnationId)) continue
    const stageRoot = path.join(base, 'provider-roots', generation)
    const context = await readJson(path.join(stageRoot, '.freshell/prepared-context.json'))
    if (context?.preparedInputs?.generationId !== generation) continue
    const manifest = await fs.readFile(path.join(stageRoot, '.freshell/input-manifest.json'))
    assert.equal(digest(manifest), context.preparedInputs.manifest.sha256)
    const selected: string[] = []
    let entries = 0
    async function walk(directory: string, depth = 0) {
      assert(depth <= 64, 'Owned controller-stage observation exceeded its depth bound')
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        assert(++entries <= 100_000, 'Owned controller-stage observation exceeded its entry bound')
        const file = path.join(directory, entry.name)
        if (entry.isDirectory()) await walk(file, depth + 1)
        else if (entry.isFile() && entry.name === 'command') {
          assert((await fs.stat(file)).size <= 4096, 'Synthetic selected command changed beyond its finite fixture size')
          if ((await fs.readFile(file, 'utf8')).includes(nonce)) selected.push(file)
        }
      }
    }
    await walk(stageRoot)
    if (!selected.length) continue
    for (const file of selected) assert.equal(requireMode(await fs.stat(file)), '0751')
    return { observed: true, generation, manifestSha256: digest(manifest), executableMode: '0751', terminalId: view.terminalId,
      soulId: view.soulId, incarnationId: view.incarnationId }
  }
  throw new Error('No current owned controller stage contains the selected executable')
}

const requireMode = (metadata: { mode: number }) => (metadata.mode & 0o777).toString(8).padStart(4, '0')

export async function runManagedEnvironmentTarget() {
  assert.equal(process.env.FRESHELL_E2E_BACKEND, 'cloud', 'Managed acceptance requires configured Cloud')
  assert.equal(process.env.GCLOUD_ROBOT_REQUIRE, '1', 'Managed acceptance requires the robot identity')
  assert.equal(process.env.GCLOUD_ROBOT_ACCOUNT, 'gcloud-robot@misc-puttering-project.iam.gserviceaccount.com')
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frs-managed-environment-'))
  const grants = fakeOnecliGrants(['opencode'])
  const nonce = randomUUID()
  let rig: ManagedRuntimeBrowserRig | undefined
  let webIdentity: Awaited<ReturnType<typeof processIdentity>> | undefined
  let version: ChildProcess | undefined, versionIdentity: Awaited<ReturnType<typeof processIdentity>> | undefined,
    versionJoin: Promise<NativeExit> | undefined
  let tunnel: ChildProcess | undefined, tunnelIdentity: Awaited<ReturnType<typeof processIdentity>> | undefined, tunnelJoin: Promise<NativeExit> | undefined
  let browser: ChildProcess | undefined, browserIdentity: Awaited<ReturnType<typeof processIdentity>> | undefined, browserJoin: Promise<NativeExit> | undefined
  const owners: InitialProviderVolumeAuthorization[] = []
  let capturedVolumes: ReturnType<typeof captureProviderParityVolumes> = []
  const proof: Record<string, unknown> = { expectedNonce: nonce }
  try {
    const home = path.join(root, 'home'), xdg = path.join(home, 'fixture-xdg'), workspace = path.join(root, 'workspace')
    // The synthetic grant is the only selected OneCLI input. RustServer merges
    // ambient env, so explicitly close optional host auth/CA references too.
    const environment = { ...grants.serverEnv, ...managedEnvironmentOpencodeSelection(), HOME: home, XDG_CONFIG_HOME: xdg,
      FRESHELL_MANAGED_OPENCODE_ONECLI_AUTH_FILE: '', FRESHELL_MANAGED_OPENCODE_ONECLI_CA_FILE: '' }
    rig = new ManagedRuntimeBrowserRig(repoRoot, 2, { ...environment, FRESHELL_MANAGED_ENVIRONMENT_FIXTURE_ONLY: '1' },
      environment, 'release', { enabledProviders: ['opencode'] }, home,
      { workspaceRoots: [workspace], bootstrapFiles: [grants.grants.opencode], defaultCwd: workspace })
    const selected = await configure(root, nonce, rig.runtime.candidateSha, rig.runtime.runId)
    await rig.start()
    webIdentity = await processIdentity(rig.web.processEvidence())
    proof.scratchWeb = webIdentity
    const health = await rig.runtime.adminOk(rig.supervisor, { method: 'health' })
    const source = { installationId: health.data.installation_id, imageRef: rig.runtime.imageRef,
      hostBinaryPath: rig.runtime.releaseHostBinary, binarySha256: digest(await fs.readFile(rig.runtime.releaseHostBinary)),
      daemonId: await readManagedEnvironmentDaemonId() }
    const authorize = (requestId: string) => owners.push(authorizeProviderParityRequest(rig!.runtime.broker, source, requestId))
    const before = await rig.inventory()
    assert.deepEqual(before, [])
    assert.deepEqual(await terminalDirectory(rig), [])
    for (const capabilities of [undefined, { paneReconcileV1: true }] as (Record<string, true> | undefined)[]) {
      const refused = await socketCreate(rig, randomUUID(), 'shell', selected.workspace, capabilities)
      assert.equal(refused.type, 'error')
      assert(JSON.stringify(refused).includes('managed environment fixture denies host PTY'))
    }
    const fallback = await fetch(`${rig.info.baseUrl}/api/tabs`, { method: 'POST', headers: { 'x-auth-token': rig.info.token,
      'content-type': 'application/json' }, body: JSON.stringify({ mode: ordinaryFixtureMode, cwd: selected.workspace }), signal: AbortSignal.timeout(30_000) })
    assert.equal(fallback.status, 400)
    assert((await fallback.text()).includes('managed environment fixture denies host PTY'))
    assert.deepEqual(await rig.inventory(), before)
    const ordinaryRows = await terminalDirectory(rig)
    assert.deepEqual(ordinaryRows, [])
    const childPids = await poll('absence of owned ordinary PTY child PIDs', async () => {
      const children = await webChildren(rig!)
      return children.length === 0 ? children : undefined
    }, 15_000)
    proof.hostPtyDenials = { legacy: true, nonNegotiated: true, httpCliMcpFallback: true, httpMode: ordinaryFixtureMode,
      observedRegistryRows: ordinaryRows, observedChildPids: childPids, scratchWeb: rig.web.processEvidence() }
    const preflightRequest = `managed-preflight-${randomUUID()}`
    authorize(preflightRequest)
    const created = await socketCreate(rig, preflightRequest, 'opencode', path.join(selected.workspace, 'preflight'),
      { paneReconcileV1: true, managedRuntimeV1: true })
    assertManagedTerminalCreated(rig, created)
    const preflightChild = await poll('genuine managed preflight configuration', async () => readJson(path.join(selected.workspace, 'preflight/.managed-fixture/child-receipt.json')))
    assert.equal(preflightChild.terminalId, created.terminalId)
    assert.equal(preflightChild.candidateSha, rig.runtime.candidateSha)
    assert.equal(preflightChild.runId, rig.runtime.runId)
    assert.equal(preflightChild.expectedNonce, nonce)
    assert.equal(preflightChild.bun, true)
    const preflightView = await poll('genuine managed preflight native identity', () =>
      observeManagedEnvironmentNativeIdentity(rig!, created.terminalId, preflightChild.nativeSessionId))
    assert((await terminalDirectory(rig)).some(row => row.terminalId === created.terminalId))
    assert.deepEqual(await webChildren(rig), [], 'Managed child must belong to the disposable session host, not the host web process')
    proof.preflight = { terminalId: created.terminalId, soulId: preflightView.soulId, incarnationId: preflightView.incarnationId,
      stage: await stageProof(rig, preflightView, nonce), child: preflightChild }
    const toolHome = path.join(root, 'tools')
    await fs.mkdir(toolHome, { mode: 0o700 })
    const tool = path.join(toolHome, 'cloudflared')
    const download = await fetch(`https://github.com/cloudflare/cloudflared/releases/download/${cloudflaredVersion}/cloudflared-linux-amd64`, { signal: AbortSignal.timeout(120_000) })
    assert(download.ok)
    const bytes = Buffer.from(await download.arrayBuffer())
    assert.equal(digest(bytes), cloudflaredSha, 'Pinned cloudflared checksum mismatch')
    await fs.writeFile(tool, bytes, { mode: 0o700 })
    version = spawn(tool, ['--version'], { cwd: root, env: { ...process.env, HOME: toolHome } })
    versionJoin = joined(version); versionJoin.catch(() => {})
    versionIdentity = await processIdentity(version).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return undefined
    })
    let versionText = ''; version.stdout!.on('data', bytes => { versionText += bytes })
    const versionExit = await bounded(versionJoin, 30_000, 'pinned cloudflared version join')
    assert.equal(versionExit.code, 0)
    assert.match(versionText, /^cloudflared version 2026\.10\.0(?:\s|$)/)
    proof.cloudflared = { version: cloudflaredVersion, sha256: cloudflaredSha, versionIdentity: versionIdentity ?? 'UNKNOWN', versionExit }
    tunnel = spawn(tool, ['tunnel', '--url', `http://127.0.0.1:${rig.info.port}`],
      { cwd: root, env: { ...process.env, HOME: toolHome, XDG_CONFIG_HOME: toolHome }, stdio: ['ignore', 'pipe', 'pipe'] })
    tunnelJoin = joined(tunnel); tunnelJoin.catch(() => {})
    tunnelIdentity = await processIdentity(tunnel)
    let tunnelLog = ''; const tunnelOutput = (bytes: Buffer) => { tunnelLog += bytes.toString(); if (tunnelLog.length > 65536) tunnelLog = tunnelLog.slice(-65536) }
    tunnel.stdout!.on('data', tunnelOutput); tunnel.stderr!.on('data', tunnelOutput)
    const origin = await poll('pinned Quick Tunnel hostname', async () => {
      assert.equal(tunnel!.exitCode, null, 'Owned tunnel exited before publication')
      return tunnelLog.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0]
    }, 120_000)
    await poll('tunnel health', async () => {
      const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(15_000) }).catch(() => undefined)
      return response?.ok ? true : undefined
    }, 120_000)
    const fixture = { candidateSha: rig.runtime.candidateSha, runId: rig.runtime.runId,
      remoteWorkspacePath: selected.workspace, expectedNonce: nonce }
    const cloudEnvironment: NodeJS.ProcessEnv = { ...process.env, FRESHELL_E2E_EXTERNAL_FIXTURE_KIND: 'managed-environment',
      FRESHELL_MANAGED_ENVIRONMENT_FIXTURE: JSON.stringify(fixture), FRESHELL_E2E_TARGET_URL: origin,
      FRESHELL_E2E_TARGET_WS_URL: origin.replace('https:', 'wss:') + '/ws', FRESHELL_E2E_TARGET_TOKEN: rig.info.token }
    delete cloudEnvironment.FRESHELL_CODE_CHECKPOINT_FIXTURE
    delete cloudEnvironment.FRESHELL_E2E_TARGET_HOME
    resolvePairedExternalFixture(cloudEnvironment, true)
    await writeJson(path.join(root, 'handoff.json'), { fixture, origin, token: rig.info.token, tunnelIdentity })
    browser = spawn('pnpm', ['run', 'test:e2e', '--shards=1', '--project=chromium-external-target',
      'test/e2e-browser/specs/managed-provider-environment-external.spec.ts'], { cwd: repoRoot, env: cloudEnvironment, stdio: ['ignore', 'inherit', 'inherit'] })
    browserJoin = joined(browser); browserJoin.catch(() => {})
    browserIdentity = await processIdentity(browser)
    await serviceManagedEnvironmentCases(fixture, scenario => {
      const cwd = path.join(selected.workspace, scenario)
      return {
        nextAttempt: attempt => poll(`Cloud ${scenario} attempt ${attempt} picker or completion`, async () => {
          const request = await readJson(path.join(cwd, '.managed-fixture/request.json'))
          if (request?.attempt === attempt) return { request }
          const completion = await readJson(path.join(cwd, '.managed-fixture/completion.json'))
          if (completion?.attempt === attempt) return { completion }
          assert.equal(browser!.exitCode, null, 'Cloud browser exited before completing its three cases')
          assert.equal(browser!.signalCode, null, 'Cloud browser was signaled before completing its three cases')
          return undefined
        }, attempt === 0 ? 600_000 : scenario === 'healthy' ? 360_000 : 300_000),
        authorize,
        publishAuthorization: request => writeJson(path.join(cwd, '.managed-fixture/authorized.json'), request),
        waitForCompletion: request => poll(`Cloud ${scenario} attempt ${request.attempt} completion`, async () => {
          const completion = await readJson(path.join(cwd, '.managed-fixture/completion.json'))
          if (completion?.attempt === request.attempt) return completion
          assert.equal(browser!.exitCode, null, 'Cloud browser exited without its attempt completion')
          return undefined
        }, scenario === 'healthy' ? 360_000 : 300_000),
        onAuthorized: async request => { if (scenario === 'healthy') {
        const { child, view } = await poll('actual selected Bun child and current request', async () => {
          const child = await readJson(path.join(cwd, '.managed-fixture/child-receipt.json'))
          if (!child) return undefined
          const view = (await rig!.inventory()).find(row => row.terminalId === child.terminalId
            && row.terminalCreateRequestId === request.createRequestId && row.nativeSessionId === child.nativeSessionId && row.launchState === 'running')
          return view ? { child, view } : undefined
        })
        assert.equal(child.expectedNonce, nonce); assert.equal(child.candidateSha, fixture.candidateSha); assert.equal(child.runId, fixture.runId)
        assert.equal(child.bun, true); assert.equal(child.opencodeVersion, '1.18.21'); assert.match(child.bunExecutable, /opencode/)
        assert.equal(child.executableMode, '0711')
        const stage = await stageProof(rig!, view, nonce)
        const receipt = { ...fixture, terminalId: view.terminalId, soulId: view.soulId, incarnationId: view.incarnationId,
          nativeSessionId: view.nativeSessionId, stage, child }
        await writeJson(path.join(cwd, '.managed-fixture/target-receipt.json'), receipt)
        proof.healthy = receipt
        } },
      }
    }, async () => {
      const browserExit = await bounded(browserJoin!, 120_000, 'configured Cloud browser final join')
      assert.equal(browserExit.code, 0, 'Configured Cloud browser acceptance failed')
      proof.cloudBrowser = { actualNativeExit: browserExit, identity: browserIdentity, expectedCases: 3, printedFooter: 'UNKNOWN' }
    })
    const healthy = proof.healthy as any
    const original = (await rig.inventory()).find(row => row.soulId === healthy.soulId)
    assert(original?.containerId)
    await fs.rename(path.join(selected.workspace, 'healthy/.managed-fixture/child-receipt.json'), path.join(root, 'initial-child-receipt.json'))
    rig.runtime.stopOwnedRuntimeExact(original.containerId)
    const replacement = await poll('current-owner replacement incarnation', async () => (await rig!.inventory()).find(row =>
      row.soulId === original.soulId && row.incarnationId !== original.incarnationId && row.launchState === 'running'), 300_000)
    const replacementChild = await poll('replacement Bun child', async () => readJson(path.join(selected.workspace, 'healthy/.managed-fixture/child-receipt.json')))
    const replacementStage = await stageProof(rig, replacement, nonce)
    assert.equal(replacement.nativeSessionId, original.nativeSessionId)
    assert.equal(replacementChild.bun, true)
    assert.equal(replacementChild.terminalId, replacement.terminalId)
    assert.equal(replacementChild.nativeSessionId, replacement.nativeSessionId)
    assert.equal(replacementChild.candidateSha, rig.runtime.candidateSha)
    assert.equal(replacementChild.runId, rig.runtime.runId)
    assert.equal(replacementChild.expectedNonce, nonce)
    assert.equal(replacementChild.executableMode, '0711')
    proof.nativeReplacement = { priorIncarnationId: original.incarnationId, incarnationId: replacement.incarnationId,
      soulId: replacement.soulId, nativeSessionId: replacement.nativeSessionId, stage: replacementStage, child: replacementChild }
    await writeJson(path.join(rig.runtime.evidenceDir, 'managed-environment-acceptance.json'), proof)
    console.log(JSON.stringify({ severity: 'info', event: 'managed_environment.acceptance_passed', candidateSha: fixture.candidateSha,
      runId: fixture.runId, expectedBrowserCases: 3, receipt: path.join(rig.runtime.evidenceDir, 'managed-environment-acceptance.json') }))
  } finally {
    const errors: Error[] = []
    const cleanup: Record<string, unknown> = {}
    const attempt = async (operation: string, action: () => unknown | Promise<unknown>) => {
      try { cleanup[operation] = await action() }
      catch (error) { errors.push(new Error(`Owned fixture cleanup failed: ${operation}`, { cause: error })); cleanup[operation] = 'FAILED; retain owned fixture' }
    }
    await attempt('browserJoin', () => stopExact(browser, browserIdentity, browserJoin))
    await attempt('tunnelJoin', () => stopExact(tunnel, tunnelIdentity, tunnelJoin))
    await attempt('versionJoin', () => stopExact(version, versionIdentity, versionJoin))
    if (rig) {
      if (!webIdentity && rig.web) await attempt('scratchWebIdentity', async () => {
        try { webIdentity = await processIdentity(rig!.web.processEvidence()) }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT'
            && (!(error instanceof Error) || error.message !== 'RustServer has no live owned process evidence')) throw error
          return 'Already absent according to the owning helper'
        }
      })
      for (const owner of owners) await attempt(`capture:${owner.providerVolumeName}`, () => {
        capturedVolumes.push(...captureProviderParityVolumes([owner]))
      })
      let rigSettled = false
      await attempt('rigStop', async () => {
        const result = await rig!.stop()
        assert(result.ok, 'Owned rig cleanup did not settle all workloads')
        if (webIdentity) {
          try {
            const current = await processIdentity({ pid: webIdentity.pid })
            assert.notEqual(current.birthTicks, webIdentity.birthTicks, 'Owned scratch web process remains live')
          } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
        }
        rigSettled = true
        return result
      })
      if (rigSettled) for (const volume of capturedVolumes) await attempt(`remove:${volume.owner.providerVolumeName}`,
        () => cleanupProviderParityVolumes([volume]))
    }
    if (errors.length === 0) {
      await attempt('grantDirectory', () => fs.rm(grants.directory, { recursive: true, force: true }))
      await attempt('fixtureDirectory', () => fs.rm(root, { recursive: true, force: true }))
    }
    if (rig) await attempt('cleanupReceipt', () => writeJson(path.join(rig!.runtime.evidenceDir, 'managed-environment-cleanup.json'),
      { cleanup, knownOwnedSettled: errors.length === 0, retainedFixture: errors.length ? root : undefined }))
    if (errors.length) throw new AggregateError(errors, 'Managed environment owned cleanup remains unsettled')
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runManagedEnvironmentTarget().catch(error => {
    console.error(JSON.stringify({ severity: 'error', event: 'managed_environment.acceptance_failed', error: error instanceof Error ? error.message : 'Unknown fixture failure' }))
    process.exitCode = 1
  })
}
