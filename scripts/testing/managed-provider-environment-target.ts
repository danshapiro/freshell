import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import { ManagedRuntimeBrowserRig, type ManagedRuntimeView } from '../../test/e2e-browser/helpers/managed-runtime.js'
import { authorizeProviderParityRequest, captureProviderParityVolumes, cleanupProviderParityVolumes } from '../../test/helpers/provider-parity-broker.js'
import { fakeOnecliGrants } from '../../test/integration/server/provider-parity-onecli.js'
import type { InitialProviderVolumeAuthorization } from './runtime-test-broker.js'
import { resolvePairedExternalFixture } from './e2e-external-target.js'

const cloudflaredVersion = '2026.10.0'
const cloudflaredSha = 'd33ff2d14475178d2012c2c56beba87389ac5ded27649519f198a7d3134a99db'
const scenarios = ['healthy', 'missing-reference', 'startup-before-identity'] as const
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

async function processIdentity(child: ChildProcess) {
  assert(child.pid)
  const raw = await fs.readFile(`/proc/${child.pid}/stat`, 'utf8')
  const fields = raw.slice(raw.lastIndexOf(')') + 2).trim().split(/\s+/)
  return { pid: child.pid, parentPid: Number(fields[1]), birthTicks: fields[19], cwd: await fs.readlink(`/proc/${child.pid}/cwd`) }
}

function joined(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => code === null ? reject(new Error(`Owned child exited with ${signal}`)) : resolve(code))
  })
}

async function stopExact(child: ChildProcess | undefined, identity: Awaited<ReturnType<typeof processIdentity>> | undefined,
  completion: Promise<number> | undefined) {
  if (!child || !identity || !completion) return
  if (child.exitCode === null && child.signalCode === null) {
    try {
      const current = await processIdentity(child)
      assert.deepEqual(current, identity, 'Owned child identity changed; retain it')
      child.kill('SIGTERM')
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  await completion.catch(error => { if (!child.signalCode) throw error })
}

async function daemonId(socketPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = http.get({ socketPath, path: '/v1.47/info', timeout: 30_000 }, response => {
      const chunks: Buffer[] = []
      let bytes = 0
      response.on('data', chunk => { bytes += chunk.length; if (bytes > 65536) request.destroy(new Error('Daemon metadata exceeded its bound')); else chunks.push(chunk) })
      response.once('end', () => {
        try { assert.equal(response.statusCode, 200); const value = JSON.parse(Buffer.concat(chunks).toString()); assert.equal(typeof value.ID, 'string'); resolve(value.ID) }
        catch (error) { reject(error) }
      })
    })
    request.once('timeout', () => request.destroy(new Error('Daemon metadata timed out')))
    request.once('error', reject)
  })
}

async function configure(root: string, nonce: string, candidateSha: string, runId: string) {
  const home = path.join(root, 'home'), xdg = path.join(home, 'fixture-xdg'), workspace = path.join(root, 'workspace')
  const resources = path.join(workspace, 'selected-resources'), plugin = path.join(resources, 'fixture-plugin')
  await fs.mkdir(path.join(plugin, 'node_modules/managed-fixture-dependency'), { recursive: true, mode: 0o755 })
  await fs.mkdir(path.join(xdg, 'opencode'), { recursive: true, mode: 0o755 })
  await fs.chmod(home, 0o700)
  await fs.chmod(root, 0o751)
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
 const cwd=api.state.path.directory;const sessionFlag=process.argv.findIndex(value=>value==='--session'||value==='-s');const resumed=sessionFlag>=0?process.argv[sessionFlag+1]:undefined;const result=resumed?await api.client.session.get({directory:cwd,sessionID:resumed}):await api.client.session.create({directory:cwd,title:'Managed fixture'});if(!result.data?.id||(resumed&&result.data.id!==resumed))throw new Error('native session creation or resume failed');api.route.navigate('session',{sessionID:result.data.id});
 const receipt={...options,terminalId:process.env.FRESHELL_TERMINAL_ID,nativeSessionId:result.data.id,bun:typeof Bun==='object',bunVersion:Bun.version,bunExecutable:process.execPath,opencodeVersion:api.app.version,dependency,resource,absoluteReference:api.state.config.agent.fixtureAbsolute.prompt,relativeReference:api.state.config.agent.fixtureRelative.prompt,executableMode:(fs.statSync(command).mode&511).toString(8).padStart(4,'0'),pid:process.pid,createdAt:new Date().toISOString()};
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
    await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
    ws.send(JSON.stringify({ type: 'hello', token: rig.info.token, ...(capabilities ? { capabilities } : {}) }))
    await poll('authenticated ready', async () => messages.find(message => message.type === 'ready'), 30_000)
    ws.send(JSON.stringify({ type: 'terminal.create', requestId, mode, cwd, cols: 100, rows: 30 }))
    return await poll('terminal create response', async () => messages.find(message =>
      message.type === 'terminal.created' || message.type === 'terminal.error'), 120_000)
  } finally { ws.close(); await closed }
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
    async function walk(directory: string) {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name)
        if (entry.isDirectory()) await walk(file)
        else if (entry.isFile() && entry.name === 'command' && (await fs.readFile(file, 'utf8')).includes(nonce)) selected.push(file)
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
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frs-managed-environment-'))
  const grants = fakeOnecliGrants(['opencode'])
  const nonce = randomUUID()
  let rig: ManagedRuntimeBrowserRig | undefined
  let tunnel: ChildProcess | undefined, tunnelIdentity: Awaited<ReturnType<typeof processIdentity>> | undefined, tunnelJoin: Promise<number> | undefined
  let browser: ChildProcess | undefined, browserIdentity: Awaited<ReturnType<typeof processIdentity>> | undefined, browserJoin: Promise<number> | undefined
  const owners: InitialProviderVolumeAuthorization[] = []
  let capturedVolumes: ReturnType<typeof captureProviderParityVolumes> = []
  const proof: Record<string, unknown> = { expectedNonce: nonce }
  try {
    const home = path.join(root, 'home'), xdg = path.join(home, 'fixture-xdg'), workspace = path.join(root, 'workspace')
    const environment = { ...grants.serverEnv, HOME: home, XDG_CONFIG_HOME: xdg }
    rig = new ManagedRuntimeBrowserRig(repoRoot, 2, { ...environment, FRESHELL_MANAGED_ENVIRONMENT_FIXTURE_ONLY: '1' },
      environment, 'release', { enabledProviders: ['opencode'] }, home,
      { workspaceRoots: [workspace], bootstrapFiles: [grants.grants.opencode], defaultCwd: workspace })
    const selected = await configure(root, nonce, rig.runtime.candidateSha, rig.runtime.runId)
    await rig.start()
    const health = await rig.runtime.adminOk(rig.supervisor, { method: 'health' })
    const dockerHost = process.env.DOCKER_HOST
    assert(!dockerHost || dockerHost.startsWith('unix://'), 'Managed target requires the existing local Unix Docker endpoint')
    const source = { installationId: health.data.installation_id, imageRef: rig.runtime.imageRef,
      hostBinaryPath: rig.runtime.releaseHostBinary, binarySha256: digest(await fs.readFile(rig.runtime.releaseHostBinary)),
      daemonId: await daemonId(dockerHost?.slice(7) || '/var/run/docker.sock') }
    const authorize = (requestId: string) => owners.push(authorizeProviderParityRequest(rig!.runtime.broker, source, requestId))
    const before = await rig.inventory()
    for (const capabilities of [undefined, { paneReconcileV1: true }] as (Record<string, true> | undefined)[]) {
      const refused = await socketCreate(rig, randomUUID(), 'shell', selected.workspace, capabilities)
      assert.equal(refused.type, 'terminal.error')
      assert(JSON.stringify(refused).includes('managed environment fixture denies host PTY'))
    }
    const fallback = await fetch(`${rig.info.baseUrl}/api/tabs`, { method: 'POST', headers: { 'x-auth-token': rig.info.token,
      'content-type': 'application/json' }, body: JSON.stringify({ mode: 'shell', cwd: selected.workspace }), signal: AbortSignal.timeout(30_000) })
    assert.equal(fallback.status, 400)
    assert((await fallback.text()).includes('managed environment fixture denies host PTY'))
    assert.deepEqual(await rig.inventory(), before)
    proof.hostPtyDenials = { legacy: true, nonNegotiated: true, httpCliMcpFallback: true, ordinaryRows: 0 }
    const preflightRequest = `managed-preflight-${randomUUID()}`
    authorize(preflightRequest)
    const created = await socketCreate(rig, preflightRequest, 'opencode', path.join(selected.workspace, 'preflight'), { managedRuntimeV1: true })
    assert.equal(created.type, 'terminal.created')
    assert.equal(created.managed, true)
    assert.equal(created.pid, null)
    await poll('genuine managed preflight configuration', async () => readJson(path.join(selected.workspace, 'preflight/.managed-fixture/child-receipt.json')))
    const toolHome = path.join(root, 'tools')
    await fs.mkdir(toolHome, { mode: 0o700 })
    const tool = path.join(toolHome, 'cloudflared')
    const download = await fetch(`https://github.com/cloudflare/cloudflared/releases/download/${cloudflaredVersion}/cloudflared-linux-amd64`, { signal: AbortSignal.timeout(120_000) })
    assert(download.ok)
    const bytes = Buffer.from(await download.arrayBuffer())
    assert.equal(digest(bytes), cloudflaredSha, 'Pinned cloudflared checksum mismatch')
    await fs.writeFile(tool, bytes, { mode: 0o700 })
    const version = spawn(tool, ['--version'], { cwd: root, env: { ...process.env, HOME: toolHome } })
    const versionJoin = joined(version), versionIdentity = await processIdentity(version)
    let versionText = ''; version.stdout.on('data', bytes => { versionText += bytes })
    assert.equal(await versionJoin, 0)
    assert.match(versionText, /^cloudflared version 2026\.10\.0(?:\s|$)/)
    proof.cloudflared = { version: cloudflaredVersion, sha256: cloudflaredSha, versionIdentity }
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
    for (const scenario of scenarios) {
      const cwd = path.join(selected.workspace, scenario)
      const request = await poll(`Cloud ${scenario} picker request`, async () => {
        assert.equal(browser!.exitCode, null, 'Cloud browser exited before completing its three cases')
        return readJson(path.join(cwd, '.managed-fixture/request.json'))
      }, 600_000)
      for (const key of ['candidateSha', 'runId', 'remoteWorkspacePath', 'expectedNonce'] as const) assert.equal(request[key], fixture[key])
      assert.equal(request.scenario, scenario)
      assert.equal(typeof request.createRequestId, 'string')
      assert(request.createRequestId.length > 0)
      authorize(request.createRequestId)
      await writeJson(path.join(cwd, '.managed-fixture/authorized.json'), request)
      if (scenario === 'healthy') {
        const child = await poll('actual selected Bun child', async () => readJson(path.join(cwd, '.managed-fixture/child-receipt.json')))
        assert.equal(child.expectedNonce, nonce); assert.equal(child.candidateSha, fixture.candidateSha); assert.equal(child.runId, fixture.runId)
        assert.equal(child.bun, true); assert.equal(child.opencodeVersion, '1.18.21'); assert.match(child.bunExecutable, /opencode/)
        assert.equal(child.executableMode, '0711')
        const view = await poll('created managed native identity', async () => (await rig!.inventory()).find(row => row.terminalId === child.terminalId && row.nativeSessionId === child.nativeSessionId && row.launchState === 'running'))
        const stage = await stageProof(rig, view, nonce)
        const receipt = { ...fixture, terminalId: view.terminalId, soulId: view.soulId, incarnationId: view.incarnationId,
          nativeSessionId: view.nativeSessionId, stage, child }
        await writeJson(path.join(cwd, '.managed-fixture/target-receipt.json'), receipt)
        proof.healthy = receipt
      }
    }
    assert.equal(await browserJoin, 0, 'Configured Cloud browser acceptance failed')
    proof.cloudBrowser = { exit: 0, identity: browserIdentity, expectedCases: 3 }
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
    proof.nativeReplacement = { priorIncarnationId: original.incarnationId, incarnationId: replacement.incarnationId,
      soulId: replacement.soulId, nativeSessionId: replacement.nativeSessionId, stage: replacementStage, child: replacementChild }
    await writeJson(path.join(rig.runtime.evidenceDir, 'managed-environment-acceptance.json'), proof)
    console.log(JSON.stringify({ severity: 'info', event: 'managed_environment.acceptance_passed', candidateSha: fixture.candidateSha,
      runId: fixture.runId, browserCases: 3, receipt: path.join(rig.runtime.evidenceDir, 'managed-environment-acceptance.json') }))
  } finally {
    await stopExact(browser, browserIdentity, browserJoin)
    await stopExact(tunnel, tunnelIdentity, tunnelJoin)
    if (rig) {
      capturedVolumes = captureProviderParityVolumes(owners)
      await rig.stop()
      cleanupProviderParityVolumes(capturedVolumes)
    }
    await fs.rm(grants.directory, { recursive: true, force: true })
    await fs.rm(root, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) {
  runManagedEnvironmentTarget().catch(error => {
    console.error(JSON.stringify({ severity: 'error', event: 'managed_environment.acceptance_failed', error: error instanceof Error ? error.message : 'Unknown fixture failure' }))
    process.exitCode = 1
  })
}
