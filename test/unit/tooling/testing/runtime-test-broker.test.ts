import { createHash, randomBytes } from 'node:crypto'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import os from 'node:os'
import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

import { parseHelperCreateDelay, RestrictedDockerBroker, type ClaudeCandidateAuthorization, type PreparedInputAuthorization } from '../../../../scripts/testing/runtime-test-broker.js'
import { findInitialProviderVolume, type InitialProviderRegistrySource } from '../../../../scripts/testing/initial-provider-volume.js'
import { buildRunOwnedRuntimeImage } from '../../../../scripts/testing/runtime-sandbox.js'
import { authorizeFreshAgentParityRequest, authorizeProviderParityRequest, captureProviderParityVolumes, cleanupProviderParityVolumes } from '../../../helpers/provider-parity-broker.js'
import { makeProviderParityResourcesReadable, providerParityCommands, providerParityFailureDiagnostics, providerParityFailureLogTail, writeProviderParityEnvironment } from '../../../helpers/provider-parity-environment.js'

it('executes file and package TUI entrypoints while observing the selected project settings', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-parity-selection-'))
  try {
    const workspace = path.join(directory, 'workspace')
    const home = path.join(directory, 'home')
    const packageRoot = path.join(home, '.freshell/opencode')
    const entry = path.join(packageRoot, 'freshell-rebind-plugin.ts')
    await fs.mkdir(path.join(workspace, '.opencode'), { recursive: true })
    await fs.mkdir(path.join(home, 'project/.opencode'), { recursive: true })
    await fs.mkdir(packageRoot, { recursive: true })
    await fs.copyFile('extensions/opencode/freshell-rebind-plugin.ts', entry)
    await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ exports: { './tui': './freshell-rebind-plugin.ts' } }))
    const userConfig = { plugin: ['file:///selected/user-plugin.js'], custom: { retained: true },
      mcp: { vendor: { type: 'local', command: ['retained-user-tool'] } } }
    await fs.writeFile(path.join(workspace, '.opencode/opencode.json'), JSON.stringify(userConfig))
    const projected = path.join(home, 'project/.opencode/opencode.json')
    const selectedTui = path.join(directory, 'tui.json')
    const consumer = `import { observeOpenCodeParitySelection } from ${JSON.stringify(pathToFileURL(path.resolve('test/fixtures/providers/parity-provider.mjs')).href)};
process.stdout.write(JSON.stringify(await observeOpenCodeParitySelection(...process.argv.slice(1), { command: 'actual-mcp', args: ['argument'] })));`
    const inspect = () => {
      const child = spawnSync(process.execPath, ['--experimental-transform-types', '--input-type=module', '-e', consumer, home, workspace, selectedTui], { encoding: 'utf8' })
      expect(child.error).toBeUndefined()
      expect(child.status, child.stderr).toBe(0)
      return JSON.parse(child.stdout)
    }
    for (const managed of [false, true]) {
      if (managed) await fs.writeFile(projected, JSON.stringify({ ...userConfig, mcp: { ...userConfig.mcp,
        freshell: { type: 'local', command: ['actual-mcp', 'argument'] } } }))
      else await fs.unlink(projected).catch(() => {})
      const spec = pathToFileURL(managed ? packageRoot : entry).href
      const selectedTuiConfig = `{
  // OpenCode accepts JSONC, including comments and trailing commas.
  "theme": "selected",
  "plugin": ["file:///selected/user-plugin.js", ${JSON.stringify(spec)},],
}`
      await fs.writeFile(selectedTui, selectedTuiConfig)
      const observed = inspect()
      expect(JSON.parse(observed.projectedProjectConfig)).toEqual(userConfig)
      expect(observed.rebindPlugin).toMatchObject({ spec, hello: true, sessionId: 'ses_parity' })
      expect(observed.tuiConfig).toBe(selectedTuiConfig)
      expect(observed.tuiConfigParsed).toEqual({ theme: 'selected', plugin: ['file:///selected/user-plugin.js', spec] })
    }
    const configuredBridge = { ...userConfig, mcp: { ...userConfig.mcp,
      freshell: { type: 'local', command: ['selected-user-bridge'] } } }
    await fs.writeFile(projected, JSON.stringify(configuredBridge))
    expect(JSON.parse(inspect().projectedProjectConfig)).toEqual(configuredBridge)
    await fs.unlink(entry)
    const missing = spawnSync(process.execPath, ['--input-type=module', '-e', consumer, home, workspace, selectedTui], { encoding: 'utf8' })
    expect(missing.status).not.toBe(0)
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})

it('classifies owned provider publication failures without retaining error bodies', () => {
  const secret = 'synthetic-private-error-body'
  const logs = [
    'null', 'false', '[]', 'not-json',
    JSON.stringify({ event: 'provider.projection.transaction.started', stage: 'stage' }),
    JSON.stringify({ event: 'provider.projection.transaction.failed', stage: 'publish', cause: `provider transaction install .config/${secret}: Invalid cross-device link (os error 18)` }),
    JSON.stringify({ event: 'provider.opencode.resource.directory_selected', field: 'OpenCode mcp.cwd',
      resource_leaf: 'workspace', source_config_leaf: 'opencode.json', source_config_parent_leaf: '.opencode',
      source_config_grandparent_leaf: 'project', resource_parent_leaf: 'parent',
      resource_grandparent_leaf: 'grandparent' }),
    JSON.stringify({ event: 'provider.environment.copy.failed', provider: 'opencode', operation: 'plan',
      relative_path: '.freshell/resource-units/root-0/target/debug/deps', resource_source_scope: 'external',
      resource_source_leaf: 'selected-resource', resource_source_origin: 'configured_resource',
      resource_source_lane: 'main', resource_source_config_leaf: 'opencode.jsonc',
      resource_source_config_scope: 'provider_config',
      limit_kind: 'entries', observed: 100_001, permitted: 100_000 }),
    JSON.stringify({ event: 'session_host.fatal', error: `provider refresh control ${secret}` }),
    JSON.stringify({ event: 'session_host.fatal', error: `runtime: HostUnreachable: prepare provider config: /private/${secret}.json: Permission denied (os error 13)` }),
    JSON.stringify({ event: 'session_host.fatal', error: secret }),
  ].join('\n')
  const diagnostic = providerParityFailureDiagnostics(logs)
  expect(diagnostic).toMatchObject({
    transactionFailures: [{ stage: 'publish', operation: 'install', errno: 'cross_device' }],
    workerFailures: [
      { operation: 'control', errno: 'unknown' },
      { operation: 'provider_config', errno: 'permission_denied' },
      { operation: 'unknown', errno: 'unknown' },
    ],
  })
  expect(diagnostic.transactionEvents).toEqual([
    { event: 'provider.projection.transaction.started', stage: 'stage' },
    { event: 'provider.projection.transaction.failed', stage: 'publish' },
  ])
  expect(diagnostic.resourceCopyFailures).toEqual([{
    provider: 'opencode', operation: 'plan',
    relativePath: '.freshell/resource-units/root-0/target/debug/deps',
    sourceScope: 'external', sourceLeaf: 'selected-resource',
    sourceOrigin: 'configured_resource', sourceLane: 'main', sourceConfigLeaf: 'opencode.jsonc',
    sourceConfigScope: 'provider_config',
    limitKind: 'entries', observed: 100_001, permitted: 100_000,
  }])
  expect(diagnostic.directoryResourceSelections).toEqual([
    { field: 'OpenCode mcp.cwd', resourceLeaf: 'workspace', sourceConfigLeaf: 'opencode.json',
      sourceConfigParentLeaf: '.opencode', sourceConfigGrandparentLeaf: 'project', resourceParentLeaf: 'parent',
      resourceGrandparentLeaf: 'grandparent' },
  ])
  expect(JSON.stringify(diagnostic)).not.toContain(secret)
})

it('serializes rejected target paths in managed provider launch broker failures', async () => {
  const root = path.join('/tmp', `fln-${randomBytes(8).toString('hex')}`)
  const imageRef = 'sha256:967627e41734aa903e824e4be22849c7f22ce0e69487ce61bb72004c4817f89c'
  const hostBinaryPath = path.join(root, 'freshell-session-host')
  const authorization = (installationId: string, soulId: string) => ({
    installationId,
    soulId,
    providerVolumeName: `freshell-provider-${createHash('sha256').update(`${installationId}\0${soulId}`).digest('hex').slice(0, 24)}`,
    imageRef,
    hostBinaryPath,
    binarySha256: 'a'.repeat(64),
    daemonId: 'fixture-daemon',
  })
  let child: ReturnType<typeof spawn> | undefined
  try {
    await fs.mkdir(path.join(root, 'handoff'), { recursive: true, mode: 0o700 })
    await fs.mkdir(path.join(root, 'candidate-handoff'), { mode: 0o700 })
    const owner = authorization('install-one', 'soul-one')
    await fs.writeFile(path.join(root, 'broker-configuration.json'), JSON.stringify({
      provider: 'opencode', claudeFlavor: 'freshclaude', imageRef, hostBinaryPath,
      initialVolumes: [owner, authorization('install-two', 'soul-two')], runId: 'launch-diagnostic-test',
    }))
    await fs.writeFile(path.join(root, 'handoff', 'attempt-one.json'), JSON.stringify({
      ...owner, incarnationId: 'incarnation-one', generationId: 'grant-one',
      stageRoot: path.join(root, 'scenarios/scenario/control/provider-roots/grant-one'),
      configurationBinds: [{ sourceRelativePath: '.freshell/templates/source-0', effectiveDestination: '/outside/rejected-target' }],
      resourceMounts: [], indexedSecretSources: [],
    }))

    child = spawn(process.execPath, [
      path.resolve('node_modules/tsx/dist/cli.mjs'), path.resolve('scripts/testing/managed-provider-launch-broker.ts'),
    ], { env: { ...process.env, FRESHELL_PROVIDER_LAUNCH_FIXTURE: root }, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
    const closed = new Promise<number | null>((resolve, reject) => {
      child!.once('error', reject)
      child!.once('close', (code) => resolve(code))
    })
    const failurePath = path.join(root, 'broker-failure')
    const deadline = Date.now() + 10_000
    let failureExists = false
    while (Date.now() < deadline) {
      try { await fs.access(failurePath); failureExists = true; break } catch {}
      if (child.exitCode !== null) break
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    if (!failureExists && child.exitCode === null) {
      child.kill('SIGKILL')
      await closed
      throw new Error(`managed provider launch broker did not write a failure receipt: ${stderr}`)
    }
    const exitCode = await closed
    expect(exitCode, stderr).toBe(1)
    const failure = JSON.parse(await fs.readFile(failurePath, 'utf8'))
    expect(failure).toEqual({
      cause: 'prepared input target is outside selected fixture roots',
      targetPath: '/outside/rejected-target',
      preparationStageRoot: path.join(root, 'scenarios/scenario/control/provider-roots/grant-one'),
    })
  } finally {
    if (child && child.exitCode === null) child.kill('SIGKILL')
    await fs.rm(root, { recursive: true, force: true })
  }
})

import { execFile } from 'node:child_process'

import { TASK007_BATCH_STORE_PROBE } from '../../../../scripts/testing/runtime-sandbox.js'

it.each(['owner-first', 'broker-first'])('initializes the actual ESM owner/broker cycle with %s', async order => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'task008-batch-esm-'))
  const ownerUrl = pathToFileURL(path.join(process.cwd(), 'scripts/testing/runtime-sandbox.ts')).href
  const brokerUrl = pathToFileURL(path.join(process.cwd(), 'scripts/testing/runtime-test-broker.ts')).href
  const imports = order === 'owner-first' ? [ownerUrl, brokerUrl] : [brokerUrl, ownerUrl]
  try {
    const output = await new Promise<string>((resolve, reject) => execFile(process.execPath,
      ['--import', path.join(process.cwd(), 'node_modules/tsx/dist/loader.mjs'), '--input-type=module', '-e',
        `await import(${JSON.stringify(imports[0])});await import(${JSON.stringify(imports[1])});const {RestrictedDockerBroker}=await import(${JSON.stringify(brokerUrl)});const broker=new RestrictedDockerBroker(${JSON.stringify({ realSocketPath: path.join(directory, 'unused.sock'), proxySocketPath: path.join(directory, 'proxy.sock'),
          runtimeRootPrefix: directory, allowedHostBinaryPaths: [], allowedImageRefs: [], testRunId: 'esm-owned', logPath: path.join(directory, 'broker.jsonl') })});await broker.start();await broker.close();process.stdout.write(String(broker.historyHelperNames().length));`],
      { encoding: 'utf8', timeout: 15_000 }, (error, stdout) => error ? reject(error) : resolve(stdout)))
    expect(output).toBe('0')
    await expect(fs.stat(path.join(directory, 'proxy.sock'))).rejects.toHaveProperty('code', 'ENOENT')
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})

it('settles an owner request failure with a structured refusal and closes the exact socket', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task008-broker-rejection-'))
  const socket = path.join(root, 'broker.sock')
  const instance = new RestrictedDockerBroker({
    realSocketPath: path.join(root, 'unused-daemon.sock'), proxySocketPath: socket,
    runtimeRootPrefix: path.join(root, 'r'), allowedHostBinaryPaths: new Set(),
    allowedImageRefs: new Set(), testRunId: 'run-rejection', logPath: path.join(root, 'events.jsonl'),
  })
  const local = instance as unknown as { handle(): Promise<void> }
  local.handle = async () => { throw new Error('private diagnostic must not enter the refusal') }
  try {
    await instance.start()
    const result = await new Promise<string>((resolve) => {
      const request = http.get({ socketPath: socket, path: '/_ping' })
      request.on('response', response => {
        response.resume()
        response.on('end', () => resolve('unexpected response'))
      })
      request.on('error', (error: NodeJS.ErrnoException) => resolve(error.code ?? error.message))
      request.setTimeout(500, () => request.destroy(new Error('probe timeout')))
    })
    expect(result).toBe('ECONNRESET')
    expect(instance.eventsSnapshot()).toMatchObject([{
      severity: 'warn', decision: 'block', reason: 'owner_request_failed', unsafeAttempt: false,
    }])
    expect(await fs.readFile(path.join(root, 'events.jsonl'), 'utf8')).not.toContain('private diagnostic')
  } finally {
    await instance.close()
    await fs.rm(root, { recursive: true, force: true })
  }
})

it('executes selected OpenCode resources after fixture readability preparation', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-parity-readable-'))
  try {
    writeProviderParityEnvironment(directory, '.opencode/plugins/parity')
    makeProviderParityResourcesReadable(path.join(directory, '.opencode'))
    const execution = spawnSync(path.join(directory, '.opencode/plugins/parity/command'), [], { encoding: 'utf8' })
    expect(execution.error).toBeUndefined()
    expect(execution.status, execution.stderr).toBe(0)
    expect(JSON.parse(execution.stdout)).toEqual({ dependency: 'installed-dependency-nonce', resource: 'selected-resource-nonce', entries: 4201 })
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})

it('executes complete selected parity resources inside an ESM workspace', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-parity-module-'))
  try {
    await fs.writeFile(path.join(workspace, 'package.json'), JSON.stringify({ type: 'module' }))
    const home = path.join(workspace, '.codex')
    const selected = 'skills/parity-environment'
    writeProviderParityEnvironment(home, selected)
    const execution = spawnSync(path.join(home, selected, 'command'), [], { encoding: 'utf8' })
    expect(execution.error).toBeUndefined()
    expect(execution.status, execution.stderr).toBe(0)
    expect(JSON.parse(execution.stdout)).toEqual({
      dependency: 'installed-dependency-nonce', resource: 'selected-resource-nonce', entries: 4201,
    })
  } finally {
    await fs.rm(workspace, { recursive: true, force: true })
  }
})

it('executes the isolated parity command from a different controller directory', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-parity-command-'))
  try {
    const workspace = path.join(directory, 'workspace')
    writeProviderParityEnvironment(workspace, '.')
    await fs.rename(path.join(workspace, 'command'), path.join(workspace, 'parity-codex'))
    const execution = spawnSync(providerParityCommands(workspace).CODEX_CMD, [], { cwd: directory, encoding: 'utf8' })
    expect(execution.error).toBeUndefined()
    expect(execution.status, execution.stderr).toBe(0)
    expect(JSON.parse(execution.stdout)).toEqual({ dependency: 'installed-dependency-nonce', resource: 'selected-resource-nonce', entries: 4201 })
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})
it.each(['response', 'disconnect'])('records the actual upstream request and its %s settlement without private data', async settlement => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frs-broker-transport-'))
  const upstreamSocket = path.join(root, 'upstream.sock')
  const proxySocket = path.join(root, 'proxy.sock')
  const logPath = path.join(root, 'broker.jsonl')
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  let accepted!: () => void
  const arrived = new Promise<void>(resolve => { accepted = resolve })
  const upstream = http.createServer(async (request, response) => {
    request.resume()
    accepted()
    await held
    if (settlement === 'disconnect') { request.socket.destroy(); return }
    response.writeHead(503, { 'x-private-diagnostic': 'private-header' })
    response.end('private-response-body')
  })
  const instance = new RestrictedDockerBroker({ realSocketPath: upstreamSocket, proxySocketPath: proxySocket,
    runtimeRootPrefix: path.join(root, 'r'), allowedHostBinaryPaths: new Set(), allowedImageRefs: new Set(),
    testRunId: 'transport-only', logPath })
  const diagnostics = async () => (await fs.readFile(logPath, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return ''
    throw error
  })).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    .filter(event => event.event?.startsWith('runtime.broker.request_'))
  try {
    await new Promise<void>(resolve => upstream.listen(upstreamSocket, resolve))
    await instance.start()
    const response = new Promise<{ status: number; body: string } | { error: string }>(resolve => {
      const request = http.get({ socketPath: proxySocket, path: '/_ping' }, reply => {
        const chunks: Buffer[] = []
        reply.on('data', chunk => chunks.push(Buffer.from(chunk)))
        reply.once('end', () => resolve({ status: reply.statusCode!, body: Buffer.concat(chunks).toString() }))
      })
      request.once('error', (error: NodeJS.ErrnoException) => resolve({ error: error.code! }))
    })
    await arrived
    const started = await diagnostics()
    expect(started).toHaveLength(1)
    expect(started[0]).toMatchObject({ event: 'runtime.broker.request_started', severity: 'info', method: 'GET', route: 'daemon_ping' })
    expect(started[0].requestId).toEqual(expect.any(String))
    expect(instance.eventsSnapshot()).toEqual([])
    const holdStarted = performance.now()
    await new Promise(resolve => setTimeout(resolve, 25))
    const holdDuration = performance.now() - holdStarted
    release()
    const result = await response
    expect(result).toEqual(settlement === 'response' ? { status: 503, body: 'private-response-body' } : { error: 'ECONNRESET' })
    const events = await diagnostics()
    expect(events).toHaveLength(2)
    expect(events[1]).toMatchObject({ event: 'runtime.broker.request_completed', requestId: started[0].requestId,
      severity: settlement === 'response' ? 'info' : 'warn', method: 'GET', route: 'daemon_ping',
      ...(settlement === 'response' ? { statusCode: 503 } : { errorCategory: 'upstream_request_failed' }) })
    expect(events[1].durationMs).toEqual(expect.any(Number))
    expect(events[1].durationMs).toBeGreaterThanOrEqual(holdDuration)
    const phases = events[1].transportPhases
    expect(phases).toMatchObject({ socketAssignedMs: expect.any(Number), requestFinishedMs: expect.any(Number),
      reusedSocket: false, socketConnectingAtAssignment: expect.any(Boolean) })
    expect(phases.requestFinishedMs).toBeGreaterThanOrEqual(phases.socketAssignedMs)
    expect(phases.requestFinishedMs).toBeLessThanOrEqual(events[1].durationMs)
    if (settlement === 'response') {
      expect(phases.responseHeadersMs - phases.requestFinishedMs).toBeGreaterThanOrEqual(holdDuration)
      expect(phases.responseEndMs).toBeGreaterThanOrEqual(phases.responseHeadersMs)
      expect(phases.responseEndMs).toBeLessThanOrEqual(events[1].durationMs)
    } else {
      expect(phases.responseHeadersMs).toBeNull()
      expect(phases.responseEndMs).toBeNull()
    }
    expect((await fs.readFile(logPath, 'utf8'))).not.toMatch(/private-header|private-response-body/)
    expect(instance.unsafeAttempts()).toEqual([])
  } finally {
    release()
    upstream.closeAllConnections()
    await instance.close()
    await new Promise<void>(resolve => upstream.close(() => resolve()))
    await fs.rm(root, { recursive: true, force: true })
  }
})

const runtimeDir = '/tmp/owned/r/scenario/x/incarnation-one'
const actorKey = createHash('sha256').update('installation-one\0soul-one').digest('hex')
const actorDir = `/tmp/owned/r/scenario/x/souls/${actorKey}/actor`
const actorBind = `${actorDir}:/run/freshell-host-actor:rw`

function createBody(
  binds: string[],
  tmpfs: Record<string, string> = { '/tmp': 'rw,noexec,nosuid,nodev,size=128m' },
  extraHosts: string[] = [],
) {
  return Buffer.from(JSON.stringify({
    Image: 'sha256:fixture-image',
    Env: ['FRESHELL_HOSTED_FRESH_AGENT=codex'],
    Labels: {
      project: 'freshell',
      'com.freshell.managed': 'true',
      'com.freshell.installation-id': 'installation-one',
      'com.freshell.incarnation-id': 'incarnation-one',
      'com.freshell.soul-id': 'soul-one',
      'com.freshell.runtime-test-run-id': 'run-one',
    },
    HostConfig: {
      NetworkMode: 'bridge',
      ExtraHosts: extraHosts,
      PidMode: '',
      ReadonlyRootfs: true,
      Privileged: false,
      CapDrop: ['ALL'],
      CapAdd: ['CHOWN', 'KILL', 'SETGID', 'SETUID'],
      SecurityOpt: ['no-new-privileges:true'],
      RestartPolicy: { Name: 'no' },
      NanoCpus: 500_000_000,
      Memory: 128 * 1024 * 1024,
      PidsLimit: 64,
      Tmpfs: tmpfs,
      Binds: binds,
    },
  }))
}

function broker() {
  return new RestrictedDockerBroker({
    realSocketPath: '/tmp/owned/docker.sock',
    proxySocketPath: '/tmp/owned/broker.sock',
    runtimeRootPrefix: '/tmp/owned/r',
    allowedHostBinaryPaths: new Set(['/tmp/owned/freshell-session-host']),
    allowedImageRefs: new Set(['sha256:fixture-image']),
    allowTerminalWorkloads: true,
    allowedWorkspaceRoots: new Set(['/workspace']),
    allowedProviderUserRoots: new Set(['/home/fixture/.claude']),
    testRunId: 'run-one',
    logPath: '/tmp/owned/broker.jsonl',
  })
}

const ordinaryBinds = [
  '/tmp/owned/freshell-session-host:/runtime/freshell-session-host:ro',
  `${runtimeDir}:/run/freshell:rw`,
  'freshell-provider-aaaaaaaaaaaaaaaaaaaaaaaa:/home/freshell/provider:rw',
  '/workspace:/workspace:rw',
]

describe('managed runtime broker actor storage', () => {
  it('accepts only blanked image defaults and fixed HOME for the owned auth helper',async()=>{
    await withHttpBroker(async ({request,forwarded})=>{
      expect((await request('POST','/v1.47/containers/create?name=owned',createBody([...ordinaryBinds,actorBind]))).status).toBe(201);
      expect((await request('GET','/v1.47/images/sha256:fixture-image/json')).status).toBe(200);
      const body=authHelperBody();
      body.Env=['PATH=','DEBIAN_FRONTEND=','HOME=/home/freshell/provider'];
      expect((await request('POST',`/v1.47/containers/create?name=${authName}`,body)).status).toBe(201);
      const before=forwarded.length;
      for (const Env of [['PATH=PRIVATE_VALUE','HOME=/home/freshell/provider'],['HOME=/outside'],['PATH=','PATH=','HOME=/home/freshell/provider'],['PATH=']]) {
        const changed={...body,Env};
        expect((await request('POST',`/v1.47/containers/create?name=${authName.replace('111111111111','222222222222')}`,changed)).status).toBe(403);
        expect(forwarded).toHaveLength(before);
      }
      expect((await request('GET','/v1.47/images/sha256:foreign/json')).status).toBe(403);
      expect(forwarded).toHaveLength(before);
    });
  });
  it('forwards only the exact attempt-owned typed mounts and refuses altered sources and controls', async () => {
    await withHttpBroker(async ({request,forwarded,broker:instance})=>{
      const generationId='grant-prepared';
      const volumeName=`freshell-inputs-${createHash('sha256').update(`soul-one\0${generationId}`).digest('hex').slice(0,24)}`;
      const authorization:PreparedInputAuthorization={
        installationId:'installation-one',soulId:'soul-one',incarnationId:'incarnation-one',generationId,
        imageRef:'sha256:fixture-image',hostBinaryPath:'/tmp/owned/freshell-session-host',providerVolumeName:providerVolume,
        stageRoot:`/tmp/owned/scenarios/scenario/control/provider-roots/${generationId}`,
        configurationBinds:[{sourceRelativePath:'.freshell/templates/source-0',effectiveDestination:'/workspace/opencode.json'}],
        resourceMounts:[{providerRelativePath:'.freshell/provider-roots/plugin-0',effectiveDestination:'/workspace/plugin',kind:'directory'},
          {providerRelativePath:'.freshell/provider-roots/instructions-0/source',effectiveDestination:'/workspace/instructions.md',kind:'file'},
          {providerRelativePath:'.freshell/provider-roots/output-0/source',effectiveDestination:'/workspace/generated.txt',kind:'file',writable:true}],
        indexedFiles:{volumeName,aliases:[{sourceId:0,effectiveDestination:'/workspace/selected-input'}]},
        indexedSecretSources:[{grantIndex:1,sourceId:0}],
      };
      const directoryWrite = structuredClone(authorization);
      directoryWrite.resourceMounts[0].writable = true;
      expect(() => instance.authorizePreparedInputs(directoryWrite)).toThrow('prepared resource source is invalid');
      instance.authorizePreparedInputs(authorization);
      const body=JSON.parse(createBody([...ordinaryBinds,actorBind]).toString());
      body.HostConfig.Mounts=[
        {Type:'bind',Source:`${authorization.stageRoot}/.freshell/templates/source-0`,Target:'/workspace/opencode.json',ReadOnly:true},
        {Type:'volume',Source:providerVolume,Target:'/workspace/plugin',ReadOnly:false,VolumeOptions:{NoCopy:true,Subpath:'.freshell/provider-roots/plugin-0'}},
        {Type:'volume',Source:volumeName,Target:'/workspace/selected-input',ReadOnly:true,VolumeOptions:{NoCopy:true,Subpath:'files/source-0'}},
        {Type:'volume',Source:volumeName,Target:'/run/freshell-secrets/provider-1',ReadOnly:true,VolumeOptions:{NoCopy:true,Subpath:'files/source-0'}},
        {Type:'volume',Source:providerVolume,Target:'/workspace/instructions.md',ReadOnly:true,VolumeOptions:{NoCopy:true,Subpath:'.freshell/provider-roots/instructions-0/source'}},
        {Type:'volume',Source:providerVolume,Target:'/workspace/generated.txt',ReadOnly:false,VolumeOptions:{NoCopy:true,Subpath:'.freshell/provider-roots/output-0/source'}},
      ];
      expect((await request('POST','/v1.47/containers/create?name=owned-prepared',body)).status).toBe(201);
      expect(forwarded).toHaveLength(1);
      for (const mutation of ['source','target','writable','prepared-writable-file-readonly','directory-readonly','ordinary-file-writable','subpath','nocopy','missing','empty','duplicate','owner','image','volume']) {
        const changed=structuredClone(body);
        if (mutation==='source') changed.HostConfig.Mounts[0].Source='/var/run/docker.sock';
        if (mutation==='target') changed.HostConfig.Mounts[0].Target='/run/freshell';
        if (mutation==='writable') changed.HostConfig.Mounts[2].ReadOnly=false;
        if (mutation==='prepared-writable-file-readonly') changed.HostConfig.Mounts[5].ReadOnly=true;
        if (mutation==='directory-readonly') changed.HostConfig.Mounts[1].ReadOnly=true;
        if (mutation==='ordinary-file-writable') changed.HostConfig.Mounts[4].ReadOnly=false;
        if (mutation==='subpath') changed.HostConfig.Mounts[2].VolumeOptions.Subpath='files/source-1';
        if (mutation==='nocopy') changed.HostConfig.Mounts[1].VolumeOptions.NoCopy=false;
        if (mutation==='missing') changed.HostConfig.Mounts.pop();
        if (mutation==='empty') changed.HostConfig.Mounts=[];
        if (mutation==='duplicate') changed.HostConfig.Mounts.push(changed.HostConfig.Mounts[0]);
        if (mutation==='owner') changed.Labels['com.freshell.incarnation-id']='incarnation-other';
        if (mutation==='image') changed.Image='sha256:other-approved-image';
        if (mutation==='volume') changed.HostConfig.Binds=changed.HostConfig.Binds.map((bind:string)=>bind.replace(providerVolume,`freshell-provider-${'c'.repeat(24)}`));
        expect((await request('POST',`/v1.47/containers/create?name=changed-${mutation}`,changed)).status,mutation).toBe(403);
        expect(forwarded).toHaveLength(1);
      }
    });
  });
  it('blocks unapproved typed mounts before any Docker request is forwarded', async () => {
    await withHttpBroker(async ({request,forwarded})=>{
      const body=JSON.parse(createBody([...ordinaryBinds,actorBind]).toString());
      body.HostConfig.Mounts=[{Type:'bind',Source:'/var/run/docker.sock',Target:'/outside/source',ReadOnly:true}];
      const response=await request('POST','/v1.47/containers/create?name=typed-fixture',body);
      expect(response.status).toBe(403);
      expect(forwarded).toEqual([]);
    });
  });
  it('allows only the durable host-owned directory for the labeled soul', () => {
    const validate = (body: Buffer): { ok: boolean } => (
      broker() as unknown as { validateCreate(body: Buffer): { ok: boolean } }
    ).validateCreate(body)

    expect(validate(createBody([...ordinaryBinds, actorBind])).ok).toBe(true)
    expect(validate(createBody(ordinaryBinds)).ok).toBe(false)
    expect(validate(createBody([
      ...ordinaryBinds,
      '/tmp/owned/r/scenario/x/souls/soul-other/actor:/run/freshell-host-actor:rw',
    ])).ok).toBe(false)
  })
})

describe('managed OpenCode transfer stage mount', () => {
  it('allows only the read-only ready bundle owned by the active runtime root', () => {
    const validate = (body: Buffer): { ok: boolean } => (
      broker() as unknown as { validateCreate(body: Buffer): { ok: boolean } }
    ).validateCreate(body)
    const stageRoot = path.join(path.dirname(runtimeDir), 'opencode-transfers')
    const target = '/run/freshell-opencode-transfer'

    expect(validate(createBody([
      ...ordinaryBinds,
      actorBind,
      `${path.join(stageRoot, 'opencode-transfer-123.ready')}:${target}:ro`,
    ])).ok).toBe(true)
    expect(validate(createBody([
      ...ordinaryBinds,
      actorBind,
      `/tmp/owned/r/scenario/other/x/opencode-transfers/opencode-transfer-123.ready:${target}:ro`,
    ])).ok).toBe(false)
    expect(validate(createBody([
      ...ordinaryBinds,
      actorBind,
      `${path.join(stageRoot, 'opencode-transfer-123.ready')}:${target}:rw`,
    ])).ok).toBe(false)
  })
})

describe('managed MCP mount', () => {
  it('accepts the exact private grant and approved provider root mounts', () => {
    const validate = (body: Buffer): { ok: boolean } => (
      broker() as unknown as { validateCreate(body: Buffer): { ok: boolean } }
    ).validateCreate(body)
    expect(validate(createBody([
      ...ordinaryBinds,
      actorBind,
      '/tmp/owned/scenarios/scenario/control/mcp-capabilities/grant-1234.json:/run/freshell/mcp-capability.json:ro',
    ])).ok).toBe(true)
    expect(validate(createBody([
      ...ordinaryBinds,
      actorBind,
      '/etc/passwd:/run/freshell/mcp-capability.json:ro',
    ])).ok).toBe(false)
    expect(validate(createBody([
      ...ordinaryBinds,
      actorBind,
      '/workspace/.claude:/run/freshell-private/user-provider:ro',
    ])).ok).toBe(true)
    expect(validate(createBody([
      ...ordinaryBinds,
      actorBind,
      '/home/fixture/.claude:/run/freshell-private/user-provider:ro',
    ])).ok).toBe(true)
    expect(validate(createBody([
      ...ordinaryBinds,
      actorBind,
      '/home/other/.claude:/run/freshell-private/user-provider:ro',
    ])).ok).toBe(false)
    expect(validate(createBody([
      ...ordinaryBinds,
      actorBind,
      '/tmp/owned/scenarios/scenario/control/provider-roots/grant-1234:/run/freshell-private/user-provider:ro',
    ])).ok).toBe(true)
  })
})

describe('managed provider tmpfs', () => {
  it('dispatches exact 0710 private parents and refuses mode or authority changes before Docker', async () => {
    await withHttpBroker(async ({ request, forwarded }) => {
      const base = { '/tmp': 'rw,noexec,nosuid,nodev,size=128m' }
      const privateParent = 'rw,noexec,nosuid,nodev,size=16m,mode=0710'
      for (const option of [
        privateParent.replace('0710', '0700'),
        privateParent.replace('0710', '0750'),
        `${privateParent},uid=65534`,
        privateParent.replace('noexec', 'exec'),
      ]) {
        const before = forwarded.length
        expect((await request('POST', '/v1.47/containers/create?name=owned-runtime', createBody(
          [...ordinaryBinds, actorBind], { ...base, '/run/freshell-private': option },
        ))).status).toBe(403)
        expect(forwarded).toHaveLength(before)
      }
      expect((await request('POST', '/v1.47/containers/create?name=owned-runtime', createBody(
        [...ordinaryBinds, actorBind], { ...base, '/run/freshell-private': privateParent },
      ))).status).toBe(201)
    })
  })
  it('accepts the bounded private provider mount and the OpenCode exec mount', () => {
    const validate = (body: Buffer): { ok: boolean } => (
      broker() as unknown as { validateCreate(body: Buffer): { ok: boolean } }
    ).validateCreate(body)
    const base = { '/tmp': 'rw,noexec,nosuid,nodev,size=128m' }
    const privateTmp = { '/run/freshell-private': 'rw,noexec,nosuid,nodev,size=16m,mode=0710' }
    const opencodeTmp = { '/run/opencode-tmp': 'rw,exec,nosuid,nodev,size=64m,mode=1777' }

    const binds = [...ordinaryBinds, actorBind]
    expect(validate(createBody(binds, { ...base, ...privateTmp })).ok).toBe(true)
    for (const mode of ['0700', '0750', '0711', '0777']) {
      expect(validate(createBody(binds, { ...base, '/run/freshell-private': `rw,noexec,nosuid,nodev,size=16m,mode=${mode}` })).ok).toBe(false)
    }
    expect(validate(createBody(binds, { ...base, '/run/freshell-private': 'rw,noexec,nosuid,nodev,size=16m,mode=0710,uid=65534' })).ok).toBe(false)
    expect(validate(createBody(binds, { ...base, ...privateTmp, ...opencodeTmp })).ok).toBe(true)
    expect(validate(createBody(binds, { ...base, '/run/freshell-private': 'rw,exec,nosuid,nodev,size=16m,mode=0710' })).ok).toBe(false)
    expect(validate(createBody(binds, { ...base, ...privateTmp, '/run/unapproved': 'rw' })).ok).toBe(false)
  })
})

describe('managed operator home mount', () => {
  const operatorHome = '/tmp/owned/operator-home'
  const operatorBind = `${operatorHome}:${operatorHome}:ro`
  const baseTmpfs = { '/tmp': 'rw,noexec,nosuid,nodev,size=128m' }
  const maskTmpfs = {
    [`${operatorHome}/.freshell`]: '',
    [`${operatorHome}/.amplifier/onecli`]: '',
    [`${operatorHome}/.config/gcloud`]: '',
  }

  function brokerWithOperatorHome() {
    return new RestrictedDockerBroker({
      realSocketPath: '/tmp/owned/docker.sock',
      proxySocketPath: '/tmp/owned/broker.sock',
      runtimeRootPrefix: '/tmp/owned/r',
      allowedHostBinaryPaths: new Set(['/tmp/owned/freshell-session-host']),
      allowedImageRefs: new Set(['sha256:fixture-image']),
      allowTerminalWorkloads: true,
      allowedWorkspaceRoots: new Set(['/workspace']),
      allowedProviderUserRoots: new Set(['/home/fixture/.claude']),
      allowedOperatorHomeRoots: new Set([operatorHome]),
      testRunId: 'run-one',
      logPath: '/tmp/owned/broker.jsonl',
    })
  }

  it('accepts the same-path read-only home bind and its three secret-mask tmpfs destinations', () => {
    const validate = (body: Buffer): { ok: boolean } => (
      brokerWithOperatorHome() as unknown as { validateCreate(body: Buffer): { ok: boolean } }
    ).validateCreate(body)
    const binds = [...ordinaryBinds, actorBind, operatorBind]

    expect(validate(createBody(binds, { ...baseTmpfs, ...maskTmpfs })).ok).toBe(true)
    expect(validate(createBody(binds, { ...baseTmpfs, [`${operatorHome}/.freshell`]: '' })).ok).toBe(true)
  })

  it('refuses the home bind without an admitted root, a writable bind, or a non-root destination', () => {
    const admitted = (body: Buffer): { ok: boolean } => (
      brokerWithOperatorHome() as unknown as { validateCreate(body: Buffer): { ok: boolean } }
    ).validateCreate(body)
    const unadmitted = (body: Buffer): { ok: boolean } => (
      broker() as unknown as { validateCreate(body: Buffer): { ok: boolean } }
    ).validateCreate(body)

    expect(unadmitted(createBody([...ordinaryBinds, actorBind, operatorBind], baseTmpfs)).ok).toBe(false)
    expect(admitted(createBody([...ordinaryBinds, actorBind, `${operatorHome}:${operatorHome}:rw`], baseTmpfs)).ok).toBe(false)
    expect(admitted(createBody([
      ...ordinaryBinds, actorBind, `${operatorHome}:/run/freshell-home:ro`,
    ], baseTmpfs)).ok).toBe(false)
    expect(admitted(createBody([
      ...ordinaryBinds, actorBind, `${operatorHome}/.amplifier:${operatorHome}/.amplifier:ro`,
    ], baseTmpfs)).ok).toBe(false)
  })

  it('refuses secret-mask tmpfs destinations outside the admitted home or with non-empty options', () => {
    const validate = (body: Buffer): { ok: boolean } => (
      brokerWithOperatorHome() as unknown as { validateCreate(body: Buffer): { ok: boolean } }
    ).validateCreate(body)
    const binds = [...ordinaryBinds, actorBind, operatorBind]

    expect(validate(createBody(binds, {
      ...baseTmpfs,
      ...maskTmpfs,
      [`${operatorHome}/.freshell`]: 'rw,mode=0755',
    })).ok).toBe(false)
    expect(validate(createBody(binds, {
      ...baseTmpfs,
      [`${operatorHome}/.ssh/authorized_keys`]: '',
    })).ok).toBe(false)
    expect(validate(createBody(binds, {
      ...baseTmpfs,
      [`${operatorHome}/../other-home/.freshell`]: '',
    })).ok).toBe(false)
  })
})

describe('managed provider host gateway', () => {
  it('allows only the exact owned controller gateway supplied by the closed fixture',async()=>{
    await withHttpBroker(async({request,forwarded})=>{
      const accepted=createBody([...ordinaryBinds,actorBind],undefined,['host.docker.internal:172.17.0.241']);
      expect((await request('POST','/v1.47/containers/create?name=owned-controller',accepted)).status).toBe(201);
      const before=forwarded.length;
      const refused=createBody([...ordinaryBinds,actorBind],undefined,['host.docker.internal:172.17.0.242']);
      expect((await request('POST','/v1.47/containers/create?name=foreign-controller',refused)).status).toBe(403);
      expect(forwarded).toHaveLength(before);
    },new Set(['172.17.0.241']));
  });
  it('accepts the rootless daemon mapping to a local host address', () => {
    const validate = (body: Buffer): { ok: boolean } => (
      broker() as unknown as { validateCreate(body: Buffer): { ok: boolean } }
    ).validateCreate(body)
    const address = '192.0.2.10'
    const interfaces = vi.spyOn(os,'networkInterfaces').mockReturnValue({fixture:[{address,netmask:'255.255.255.0',family:'IPv4',mac:'00:00:00:00:00:00',internal:false,cidr:address+'/24'}]})
    try {

    expect(validate(createBody([...ordinaryBinds, actorBind], undefined, [`host.docker.internal:${address}`])).ok).toBe(true)
    expect(validate(createBody([...ordinaryBinds, actorBind], undefined, ['host.docker.internal:203.0.113.7'])).ok).toBe(false)
    } finally { interfaces.mockRestore() }
  })
})

const ownedId = 'a'.repeat(64)
const helperId = 'b'.repeat(64)
const providerVolume = 'freshell-provider-aaaaaaaaaaaaaaaaaaaaaaaa'
const helperName = 'freshell-history-11111111-1111-4111-8111-111111111111'
function batchStoreHelperBody() {
  const body = historyHelperBody()
  return { ...body, Image: `sha256:${'b'.repeat(64)}`, Tty: false, Entrypoint: ['node'], WorkingDir: '/workspace',
    Cmd: ['--no-warnings', '-e', TASK007_BATCH_STORE_PROBE, '/home/freshell/provider/.local/share/opencode/opencode.db', 'ses_batch'],
    HostConfig: { ...body.HostConfig, Mounts: [body.HostConfig.Mounts[1],
      { Type: 'bind', Source: '/workspace', Target: '/workspace', ReadOnly: true }] } }
}

function semanticBatchStoreHelperBody() {
  const body = batchStoreHelperBody()
  body.Cmd.push('/run/freshell-opencode-reader.frame', '/workspace')
  body.Env.push('XDG_DATA_HOME=/home/freshell/provider/.local/share', 'XDG_CONFIG_HOME=/home/freshell/provider/.config',
    'OPENCODE_DB=/home/freshell/provider/.local/share/opencode/opencode.db')
  body.HostConfig.Mounts.push(
    { Type: 'bind', Source: '/tmp/owned/freshell-session-host', Target: '/runtime/freshell-session-host', ReadOnly: true },
    { Type: 'bind', Source: `${runtimeDir}/task007-reader-descriptor.frame`, Target: '/run/freshell-opencode-reader.frame', ReadOnly: true })
  return body
}
it('routes only the exact owner-bound immutable descriptor reader and refuses wider transport', async () => {
  await withHttpBroker(async ({ request, forwarded }) => {
    const original = { ...JSON.parse(createBody([...ordinaryBinds, actorBind]).toString()), Image: `sha256:${'b'.repeat(64)}` }
    expect((await request('POST', '/v1.47/containers/create?name=owned-runtime', original)).status).toBe(201)
    const mutations = [
      (b: ReturnType<typeof semanticBatchStoreHelperBody>) => { b.Image = 'sha256:other-approved-image' },
      (b: ReturnType<typeof semanticBatchStoreHelperBody>) => { b.User = '0:0' },
      (b: ReturnType<typeof semanticBatchStoreHelperBody>) => { b.User = '65534:1' },
      (b: ReturnType<typeof semanticBatchStoreHelperBody>) => { b.Cmd[4] = '../foreign' },
      (b: ReturnType<typeof semanticBatchStoreHelperBody>) => { b.Cmd[5] = '/foreign.frame' },
      (b: ReturnType<typeof semanticBatchStoreHelperBody>) => { b.Cmd.push('extra') },
      (b: ReturnType<typeof semanticBatchStoreHelperBody>) => { b.Cmd[2] += ';process.exit(0)' },
      (b: ReturnType<typeof semanticBatchStoreHelperBody>) => { b.HostConfig.Mounts[0].Source = 'foreign-volume' },
      (b: ReturnType<typeof semanticBatchStoreHelperBody>) => { b.HostConfig.Mounts[0].ReadOnly = false },
      (b: ReturnType<typeof semanticBatchStoreHelperBody>) => { b.HostConfig.Mounts[2].Source = '/tmp/owned/other-approved-host' },
      (b: ReturnType<typeof semanticBatchStoreHelperBody>) => { b.HostConfig.Mounts[3].Source = '/tmp/owned/r/foreign/task007-reader-descriptor.frame' },
      (b: ReturnType<typeof semanticBatchStoreHelperBody>) => { b.HostConfig.Mounts[3].ReadOnly = false },
      (b: ReturnType<typeof semanticBatchStoreHelperBody>) => { b.HostConfig.Mounts.push({Type:'bind',Source:'/foreign',Target:'/foreign',ReadOnly:true}) },
      (b: ReturnType<typeof semanticBatchStoreHelperBody>) => { b.Env.push('TOKEN=foreign') },
      (b: ReturnType<typeof semanticBatchStoreHelperBody>) => { b.WorkingDir = '/foreign' },
      (b: ReturnType<typeof semanticBatchStoreHelperBody>) => { b.Cmd[6] = '/foreign' },
      (b: ReturnType<typeof semanticBatchStoreHelperBody>) => { Object.assign(b, { Cmd: [...b.Cmd.slice(0, 6), {}] }) },
    ]
    for (const mutate of mutations) {
      const body = semanticBatchStoreHelperBody(); mutate(body)
      const before = forwarded.length
      expect((await request('POST', `/v1.47/containers/create?name=${helperName}`, body)).status).toBe(403)
      expect(forwarded).toHaveLength(before)
    }
    expect((await request('POST', `/v1.47/containers/create?name=${helperName}`, semanticBatchStoreHelperBody())).status).toBe(201)
    expect((await request('POST', `/v1.47/containers/${helperId}/attach?stdin=1&stream=1`)).status).toBe(403)
    expect((await request('POST', `/v1.47/containers/${helperId}/start`)).status).toBe(204)
    expect((await request('POST', `/v1.47/containers/${helperId}/wait?condition=not-running`)).status).toBe(200)
    expect((await request('GET', `/v1.47/containers/${helperId}/logs?stdout=1&stderr=1`)).status).toBe(200)
    expect((await request('DELETE', `/v1.47/containers/${helperName}?force=1`)).status).toBe(204)
  })
})

it('tracks the fixed batch Node reader and refuses every altered capability before forwarding', async () => {
  await withHttpBroker(async ({ request, forwarded, broker }) => {
    const original = { ...JSON.parse(createBody([...ordinaryBinds, actorBind]).toString()), Image: `sha256:${'b'.repeat(64)}` }
    expect((await request('POST', '/v1.47/containers/create?name=owned-runtime', original)).status).toBe(201)
    const mutations = [
      (body: ReturnType<typeof batchStoreHelperBody>) => { body.Cmd[2] += '\nprocess.exit(0)' },
      (body: ReturnType<typeof batchStoreHelperBody>) => { body.Cmd[3] = '/foreign.db' },
      (body: ReturnType<typeof batchStoreHelperBody>) => { body.Cmd[4] = '../foreign' },
      (body: ReturnType<typeof batchStoreHelperBody>) => { body.Cmd.push('foreign') },
      (body: ReturnType<typeof batchStoreHelperBody>) => { body.User = '0:0' },
      (body: ReturnType<typeof batchStoreHelperBody>) => { body.Tty = true },
      (body: ReturnType<typeof batchStoreHelperBody>) => { body.Image = 'sha256:fixture-image' },
      (body: ReturnType<typeof batchStoreHelperBody>) => { body.Image = `sha256:${'f'.repeat(64)}` },
      (body: ReturnType<typeof batchStoreHelperBody>) => { body.Env.push('TOKEN=foreign') },
      (body: ReturnType<typeof batchStoreHelperBody>) => { body.HostConfig.Mounts[0].Source = 'foreign-volume' },
      (body: ReturnType<typeof batchStoreHelperBody>) => { body.HostConfig.Mounts[0].ReadOnly = false },
      (body: ReturnType<typeof batchStoreHelperBody>) => { body.HostConfig.Mounts[1].Source = '/foreign' },
      (body: ReturnType<typeof batchStoreHelperBody>) => { body.WorkingDir = '/foreign' },
      (body: ReturnType<typeof batchStoreHelperBody>) => { body.HostConfig.CapDrop = [] },
      (body: ReturnType<typeof batchStoreHelperBody>) => { Object.assign(body.HostConfig, { CapAdd: ['SYS_ADMIN'] }) },
      (body: ReturnType<typeof batchStoreHelperBody>) => { body.HostConfig.SecurityOpt = [] },
      (body: ReturnType<typeof batchStoreHelperBody>) => { body.HostConfig.Tmpfs['/tmp'] = 'rw,exec,size=16m' },
      (body: ReturnType<typeof batchStoreHelperBody>) => { body.HostConfig.NetworkMode = 'bridge' },
      (body: ReturnType<typeof batchStoreHelperBody>) => { body.HostConfig.ReadonlyRootfs = false },
    ]
    for (const mutate of mutations) {
      const body = batchStoreHelperBody(); mutate(body)
      const before = forwarded.length
      expect((await request('POST', `/v1.47/containers/create?name=${helperName}`, body)).status).toBe(403)
      expect(forwarded).toHaveLength(before)
    }
    expect((await request('POST', `/v1.47/containers/create?name=${helperName}`, batchStoreHelperBody())).status).toBe(201)
    expect(broker.receiptIds()).toContain(helperId)
    expect((await request('POST', `/v1.47/containers/${helperId}/start`)).status).toBe(204)
    expect((await request('POST', `/v1.47/containers/${helperId}/wait?condition=not-running`)).status).toBe(200)
    expect((await request('GET', `/v1.47/containers/${helperId}/logs?stdout=1&stderr=1`)).status).toBe(200)
    expect((await request('DELETE', `/v1.47/containers/${helperName}?force=1`)).status).toBe(204)
  })
})
function historyHelperBody() {
  return {
    Image: 'sha256:fixture-image',
    User: '65534:0',
    Tty: true,
    Entrypoint: ['/runtime/freshell-session-host'],
    Cmd: ['native-history-only', '--provider', 'codex', '--session-id', 'native-owned', '--provider-home', '/home/freshell/provider'],
    Env: ['HOME=/home/freshell/provider'],
    HostConfig: {
      NetworkMode: 'none',
      ReadonlyRootfs: true,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges'],
      Memory: 256 * 1024 * 1024,
      MemorySwap: 256 * 1024 * 1024,
      NanoCpus: 500_000_000,
      PidsLimit: 32,
      Tmpfs: { '/tmp': 'rw,noexec,nosuid,nodev,size=16m' },
      Mounts: [
        { Type: 'bind', Source: '/tmp/owned/freshell-session-host', Target: '/runtime/freshell-session-host', ReadOnly: true },
        { Type: 'volume', Source: providerVolume, Target: '/home/freshell/provider', ReadOnly: true },
      ],
    },
  }
}

const authName = 'freshell-auth-11111111-1111-4111-8111-111111111111'
function authHelperBody(): any {
  const body: any = historyHelperBody()
  body.Tty = false
  body.Cmd = ['native-auth-only']
  delete body.HostConfig.Tmpfs
  body.HostConfig.LogConfig = { Type: 'none', Config: {} }
  body.HostConfig.Mounts[1].VolumeOptions = { NoCopy: true }
  body.HostConfig.Mounts.push({ Type: 'bind', Source: `/tmp/${authName}`, Target: '/run/freshell-auth-exchange', ReadOnly: true })
  return body
}

const sourceName = 'freshell-claude-source-11111111-1111-4111-8111-111111111111'
function sourceAuthorization() {
  const installationId = 'installation-one', soulId = 'soul-initial'
  return {
    installationId, soulId,
    providerVolumeName: `freshell-provider-${createHash('sha256').update(`${installationId}\0${soulId}`).digest('hex').slice(0, 24)}`,
    imageRef: 'sha256:fixture-image', hostBinaryPath: '/tmp/owned/freshell-session-host',
    binarySha256: 'a'.repeat(64), daemonId: 'fixture-daemon',
  }
}
function sourceHelperBody(): any {
  const owner = sourceAuthorization()
  return {
    Image: owner.imageRef, User: '65534:0', Tty: false, WorkingDir: '/workspace/nested',
    Entrypoint: ['/runtime/freshell-session-host'], Cmd: ['observe-claude-sources-private'],
    Env: ['PATH=', 'HOME=/home/freshell/provider'],
    Labels: {
      'com.freshell.installation-id': owner.installationId,
      'com.freshell.soul-id': owner.soulId,
      'com.freshell.runtime-test-run-id': 'run-one',
      'com.freshell.source-request-id': '22222222-2222-4222-8222-222222222222',
      'com.freshell.source-binary-sha256': owner.binarySha256,
    },
    HostConfig: {
      NetworkMode: 'none', ReadonlyRootfs: true, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'],
      Memory: 256 * 1024 * 1024, MemorySwap: 256 * 1024 * 1024, NanoCpus: 500_000_000, PidsLimit: 32,
      LogConfig: { Type: 'none', Config: {} },
      Tmpfs: { '/home/freshell/provider': 'rw,nosuid,nodev,noexec,size=16m,uid=65534,gid=0,mode=0700' },
      Mounts: [
        { Type: 'bind', Source: owner.hostBinaryPath, Target: '/runtime/freshell-session-host', ReadOnly: true },
        { Type: 'bind', Source: '/workspace', Target: '/workspace', ReadOnly: true },
        { Type: 'bind', Source: '/tmp/freshell-inputs-33333333-3333-4333-8333-333333333333', Target: '/run/freshell-source-exchange', ReadOnly: true },
      ],
    },
  }
}

function candidateAuthorization(): ClaudeCandidateAuthorization {
  const generationId = 'grant-44444444-4444-4444-8444-444444444444'
  return { ...sourceAuthorization(), generationId,
    reservationId: '11111111-1111-4111-8111-111111111111',
    requestId: '22222222-2222-4222-8222-222222222222',
    stageRoot: `/tmp/owned/scenarios/claude/control/provider-roots/${generationId}`,
    workspacePath: '/workspace', cwd: '/workspace/nested', manifestRelativePath: '.freshell/input-manifest.json',
    configurationBinds: [{ sourceRelativePath: '.freshell/templates/source-0', effectiveDestination: '/workspace/.claude/settings.json' }],
    resourceMounts: [{ stageRelativePath: '.freshell/resource-units/unit-0', providerRelativePath: '.freshell/provider-roots/unit-0',
      effectiveDestination: '/workspace/.claude/skills', kind: 'directory' }],
  }
}
function candidateLabels(input: ClaudeCandidateAuthorization) {
  return { 'com.freshell.installation-id': input.installationId, 'com.freshell.soul-id': input.soulId,
    'com.freshell.runtime-test-run-id': 'run-one', 'com.freshell.source-request-id': input.requestId,
    'com.freshell.source-binary-sha256': input.binarySha256, 'com.freshell.input-generation': input.generationId,
    ...(input.retained ? { 'com.freshell.source-recovery-attempt-id': input.retained.attemptId } : { 'com.freshell.source-reservation-id': input.reservationId }), 'com.freshell.claude-candidate': 'ordinary' }
}
function candidateHelperBody(input: ClaudeCandidateAuthorization, role: 'mountpoints' | 'reader'): any {
  const volume = `freshell-claude-candidate-${input.requestId}`
  const exchange = '/tmp/freshell-inputs-33333333-3333-4333-8333-333333333333'
  const body = sourceHelperBody()
  body.User = '0:0'; body.Labels = candidateLabels(input)
  body.Cmd = [role === 'reader' ? 'project-claude-candidate-private' : 'prepare-provider-mountpoints']
  body.HostConfig.CapAdd = ['CHOWN', 'SETGID', 'SETUID']
  body.HostConfig.Memory = body.HostConfig.MemorySwap = (role === 'reader' ? 256 : 128) * 1024 * 1024
  body.HostConfig.Mounts = [
    { Type: 'bind', Source: input.hostBinaryPath, Target: '/runtime/freshell-session-host', ReadOnly: true },
    { Type: 'volume', Source: volume, Target: '/home/freshell/provider', ReadOnly: false, VolumeOptions: { NoCopy: true } },
    { Type: 'bind', Source: exchange, Target: role === 'reader' ? '/run/freshell-source-exchange' : '/run/freshell-input-exchange', ReadOnly: true },
  ]
  if (role === 'mountpoints') {
    delete body.WorkingDir; delete body.HostConfig.Tmpfs; body.Env = ['PATH=']
    return body
  }
  body.WorkingDir = input.cwd; body.HostConfig.Tmpfs = {}
  body.HostConfig.Mounts.push(
    { Type: 'bind', Source: input.workspacePath, Target: input.workspacePath, ReadOnly: true },
    { Type: 'bind', Source: `${exchange}/ordinary-stage`, Target: '/run/freshell-candidate-inputs', ReadOnly: true },
  )
  if (input.gitCommonDir && input.gitCommonDir !== input.workspacePath && !input.gitCommonDir.startsWith(`${input.workspacePath}/`)) {
    body.HostConfig.Mounts.push({ Type: 'bind', Source: input.gitCommonDir, Target: input.gitCommonDir, ReadOnly: true })
  }
  const selected = new Set(['.freshell/claude-candidate-binding.json', '.freshell/prepared-context.json', '.freshell/prepared-result.json', input.manifestRelativePath,
    ...input.configurationBinds.map((bind) => bind.sourceRelativePath), ...input.resourceMounts.map((mount) => mount.stageRelativePath)])
  for (const relative of selected) body.HostConfig.Mounts.push({ Type: 'bind', Source: `${input.stageRoot}/${relative}`, Target: `/run/freshell-candidate-inputs/${relative}`, ReadOnly: true })
  for (const bind of input.configurationBinds) body.HostConfig.Mounts.push({ Type: 'bind', Source: `${input.stageRoot}/${bind.sourceRelativePath}`, Target: bind.effectiveDestination, ReadOnly: true })
  for (const mount of input.resourceMounts) body.HostConfig.Mounts.push({ Type: 'volume', Source: volume, Target: mount.effectiveDestination, ReadOnly: mount.kind === 'file', VolumeOptions: { NoCopy: true, Subpath: mount.providerRelativePath } })
  if (input.retained) {
    body.HostConfig.Mounts.push(
      { Type: 'volume', Source: input.providerVolumeName, Target: '/run/freshell-retained-home', ReadOnly: true, VolumeOptions: { NoCopy: true } },
      { Type: 'bind', Source: `${exchange}/retained-stage`, Target: '/run/freshell-retained-inputs', ReadOnly: true },
    )
    const selected = new Set(['.freshell/prepared-context.json',input.manifestRelativePath,
      ...input.retained.configurationBinds.map((bind) => bind.sourceRelativePath), ...input.retained.resourceMounts.map((unit) => unit.stageRelativePath)])
    for (const relative of selected) body.HostConfig.Mounts.push({ Type: 'bind', Source: `${input.retained.stageRoot}/${relative}`, Target: `/run/freshell-retained-inputs/${relative}`, ReadOnly: true })
  }
  return body
}

describe('fixed initial Claude candidate broker', () => {
  it('qualifies a linked checkout candidate using only its selected Git common directory', async () => {
    await withHttpBroker(async ({ request, forwarded, broker: instance }) => {
      const input = { ...candidateAuthorization(), gitCommonDir: '/workspace-git' }
      instance.authorizeInitialProviderVolume(sourceAuthorization())
      expect(() => instance.authorizeClaudeCandidate({ ...input, gitCommonDir: '/outside-git' })).toThrow()
      instance.authorizeClaudeCandidate(input)
      const volume = `freshell-claude-candidate-${input.requestId}`
      expect((await request('POST', '/v1.47/volumes/create', { Name: volume, Driver: 'local', DriverOpts: {}, Labels: candidateLabels(input) })).status).toBe(201)
      const name = 'freshell-claude-candidate-reader-11111111-1111-4111-8111-111111111111'
      const body = candidateHelperBody(input, 'reader'), before = forwarded.length
      for (const mutation of ['outside', 'alias', 'writable', 'missing', 'duplicate']) {
        const changed = structuredClone(body)
        const common = changed.HostConfig.Mounts.find((mount: any) => mount.Source === input.gitCommonDir)
        if (mutation === 'outside') common.Source = common.Target = '/outside-git'
        if (mutation === 'alias') common.Target = '/workspace/.git'
        if (mutation === 'writable') common.ReadOnly = false
        if (mutation === 'missing') changed.HostConfig.Mounts = changed.HostConfig.Mounts.filter((mount: any) => mount !== common)
        if (mutation === 'duplicate') changed.HostConfig.Mounts.push(structuredClone(common))
        expect((await request('POST', `/v1.47/containers/create?name=${name}`, changed)).status, mutation).toBe(403)
        expect(forwarded).toHaveLength(before)
      }
      expect((await request('POST', `/v1.47/containers/create?name=${name}`, body)).status).toBe(201)
      expect((await request('POST', `/v1.47/containers/${helperId}/start`)).status).toBe(204)
      expect((await request('POST', `/v1.47/containers/${helperId}/wait?condition=not-running`)).status).toBe(200)
      expect((await request('DELETE', `/v1.47/containers/${helperId}?force=1`)).status).toBe(204)
      expect((await request('GET', `/v1.47/containers/${helperId}/json`)).status).toBe(404)
      expect((await request('DELETE', `/v1.47/volumes/${volume}`)).status).toBe(204)
    }, { gitWorkspace: '/workspace-git' })
  })
  it.each([undefined, '/workspace-git'])('observes retained sources through the exact frozen ordinary aliases and read-only owned HOME (%s)', async (gitCommonDir) => {
    await withHttpBroker(async ({request, forwarded, broker: instance}) => {
      const input = { ...candidateAuthorization(), gitCommonDir }, body = sourceHelperBody()
      instance.authorizeInitialProviderVolume(sourceAuthorization())
      instance.authorizeClaudeCandidate(input)
      body.HostConfig.Tmpfs = {}
      body.HostConfig.Mounts.push(
        {Type:'volume',Source:input.providerVolumeName,Target:'/home/freshell/provider',ReadOnly:true,VolumeOptions:{NoCopy:true}},
        ...input.configurationBinds.map(bind => ({Type:'bind',Source:`${input.stageRoot}/${bind.sourceRelativePath}`,Target:bind.effectiveDestination,ReadOnly:true})),
        ...input.resourceMounts.map(unit => ({Type:'volume',Source:input.providerVolumeName,Target:unit.effectiveDestination,ReadOnly:true,VolumeOptions:{NoCopy:true,Subpath:unit.providerRelativePath}})),
      )
      if (gitCommonDir) body.HostConfig.Mounts.push({Type:'bind',Source:gitCommonDir,Target:gitCommonDir,ReadOnly:true})
      const before = forwarded.length
      for (const mutation of ['home-write','foreign-home','alias-write','alias-subpath','alias-source','missing-alias','native-history',
        ...(gitCommonDir ? ['common-write','common-source','common-alias','missing-common'] : [])]) {
        const changed = structuredClone(body)
        if (mutation === 'home-write') changed.HostConfig.Mounts[3].ReadOnly = false
        if (mutation === 'foreign-home') changed.HostConfig.Mounts[3].Source = 'foreign-home'
        if (mutation === 'alias-write') changed.HostConfig.Mounts[5].ReadOnly = false
        if (mutation === 'alias-subpath') changed.HostConfig.Mounts[5].VolumeOptions.Subpath = '.claude/projects'
        if (mutation === 'alias-source') changed.HostConfig.Mounts[4].Source = `${input.stageRoot}/.freshell/mcp-capability.json`
        if (mutation === 'missing-alias') changed.HostConfig.Mounts.splice(5, 1)
        if (mutation === 'native-history') changed.HostConfig.Mounts.push({Type:'volume',Source:input.providerVolumeName,Target:'/history',ReadOnly:true,VolumeOptions:{NoCopy:true,Subpath:'.claude/projects'}})
        if (mutation === 'common-write') changed.HostConfig.Mounts.at(-1).ReadOnly = false
        if (mutation === 'common-source') changed.HostConfig.Mounts.at(-1).Source = '/outside-git'
        if (mutation === 'common-alias') changed.HostConfig.Mounts.at(-1).Target = '/workspace/.git'
        if (mutation === 'missing-common') changed.HostConfig.Mounts.pop()
        expect((await request('POST',`/v1.47/containers/create?name=${sourceName}`,changed)).status,mutation).toBe(403)
        expect(forwarded).toHaveLength(before)
      }
      expect((await request('POST',`/v1.47/containers/create?name=${sourceName}`,body)).status).toBe(201)
      expect((await request('GET',`/v1.47/containers/${helperId}/json`)).status).toBe(200)
      expect((await request('POST',`/v1.47/containers/${helperId}/start`)).status).toBe(204)
      expect((await request('POST',`/v1.47/containers/${helperId}/wait?condition=not-running`)).status).toBe(200)
      expect((await request('DELETE',`/v1.47/containers/${helperId}?force=1`)).status).toBe(204)
      expect((await request('GET',`/v1.47/containers/${helperId}/json`)).status).toBe(404)
    }, { gitWorkspace: '/workspace-git' })
  })
  it('qualifies retained candidates only through selected frozen inputs and read-only owned HOME', async () => {
    await withHttpBroker(async ({ request, forwarded, broker: instance }) => {
      const input = candidateAuthorization(), generationId = 'grant-55555555-5555-4555-8555-555555555555'
      input.retained = { generationId, stageRoot: `/tmp/owned/scenarios/claude/control/provider-roots/${generationId}`,
        attemptId: 'recovery-66666666-6666-4666-8666-666666666666', configurationBinds: structuredClone(input.configurationBinds), resourceMounts: structuredClone(input.resourceMounts) }
      instance.authorizeInitialProviderVolume(sourceAuthorization())
      for (const mutation of ['generation','stage','credential-source']) {
        const changed = structuredClone(input)
        if (mutation === 'generation') changed.retained!.generationId = input.generationId
        if (mutation === 'stage') changed.retained!.stageRoot = `/outside/${generationId}`
        if (mutation === 'credential-source') changed.retained!.configurationBinds[0].sourceRelativePath = '.freshell/mcp-capability.json'
        expect(() => instance.authorizeClaudeCandidate(changed),mutation).toThrow()
      }
      instance.authorizeClaudeCandidate(input)
      const volume = `freshell-claude-candidate-${input.requestId}`
      expect((await request('POST','/v1.47/volumes/create',{Name:volume,Driver:'local',DriverOpts:{},Labels:candidateLabels(input)})).status).toBe(201)
      const name = 'freshell-claude-candidate-reader-11111111-1111-4111-8111-111111111111'
      const body = candidateHelperBody(input,'reader'), before = forwarded.length
      for (const mutation of ['retained-write','retained-name','retained-stage','retained-credential','attempt','extra-native-alias']) {
        const changed = structuredClone(body)
        if (mutation === 'retained-write') changed.HostConfig.Mounts.find((mount:any) => mount.Target === '/run/freshell-retained-home').ReadOnly = false
        if (mutation === 'retained-name') changed.HostConfig.Mounts.find((mount:any) => mount.Target === '/run/freshell-retained-home').Source = 'foreign-provider-home'
        if (mutation === 'retained-stage') changed.HostConfig.Mounts.find((mount:any) => mount.Target === '/run/freshell-retained-inputs/.freshell/prepared-context.json').Source = `${input.stageRoot}/.freshell/prepared-context.json`
        if (mutation === 'retained-credential') changed.HostConfig.Mounts.push({Type:'bind',Source:`${input.retained.stageRoot}/.freshell/mcp-capability.json`,Target:'/run/freshell-retained-inputs/.freshell/mcp-capability.json',ReadOnly:true})
        if (mutation === 'attempt') changed.Labels['com.freshell.source-recovery-attempt-id'] = 'recovery-77777777-7777-4777-8777-777777777777'
        if (mutation === 'extra-native-alias') changed.HostConfig.Mounts.push({Type:'volume',Source:input.providerVolumeName,Target:'/history',ReadOnly:true,VolumeOptions:{NoCopy:true,Subpath:'.claude/projects'}})
        expect((await request('POST',`/v1.47/containers/create?name=${name}`,changed)).status,mutation).toBe(403)
        expect(forwarded).toHaveLength(before)
      }
      expect((await request('POST',`/v1.47/containers/create?name=${name}`,body)).status).toBe(201)
      expect((await request('POST',`/v1.47/containers/${helperId}/start`)).status).toBe(204)
      expect((await request('POST',`/v1.47/containers/${helperId}/wait?condition=not-running`)).status).toBe(200)
      expect((await request('DELETE',`/v1.47/containers/${helperId}?force=1`)).status).toBe(204)
      expect((await request('GET',`/v1.47/containers/${helperId}/json`)).status).toBe(404)
      expect((await request('DELETE',`/v1.47/volumes/${volume}`)).status).toBe(204)
      expect(forwarded.some((operation) => operation.method === 'DELETE' && operation.url.includes(input.providerVolumeName))).toBe(false)
    })
  })
  it('owns only the exact request disk backing and confirms non-force cleanup', async () => {
    await withHttpBroker(async ({ request, forwarded, broker: instance }) => {
      const input = candidateAuthorization(), name = `freshell-claude-candidate-${input.requestId}`
      const url = `/v1.47/volumes/${name}`
      expect((await request('GET', url)).status).toBe(403)
      expect(forwarded).toEqual([])
      instance.authorizeInitialProviderVolume(sourceAuthorization())
      instance.authorizeClaudeCandidate(input)
      expect((await request('GET', url)).status).toBe(404)
      const body = { Name: name, Driver: 'local', DriverOpts: {}, Labels: candidateLabels(input) }
      const before = forwarded.length
      for (const mutation of ['foreign-name','tmpfs','labels','extra']) {
        const changed: any = structuredClone(body)
        if (mutation === 'foreign-name') changed.Name = 'freshell-claude-candidate-33333333-3333-4333-8333-333333333333'
        if (mutation === 'tmpfs') changed.DriverOpts = { type: 'tmpfs', device: 'tmpfs', o: 'size=64m' }
        if (mutation === 'labels') changed.Labels['com.freshell.soul-id'] = 'foreign'
        if (mutation === 'extra') changed.Privileged = true
        expect((await request('POST', '/v1.47/volumes/create', changed)).status, mutation).toBe(403)
        expect(forwarded).toHaveLength(before)
      }
      expect((await request('POST', '/v1.47/volumes/create', body)).status).toBe(201)
      expect((await request('GET', url)).status).toBe(200)
      const beforeForce = forwarded.length
      expect((await request('DELETE', `${url}?force=1`)).status).toBe(403)
      expect(forwarded).toHaveLength(beforeForce)
      expect((await request('DELETE', url)).status).toBe(204)
      expect((await request('GET', url)).status).toBe(404)
    })
  })
  it('retains attempted disk ownership after a lost acknowledgement and refuses a foreign readback', async () => {
    for (const foreign of [false, true]) {
      await withHttpBroker(async ({ request, forwarded, broker: instance, loseCandidateVolumeAck, replaceCandidateVolumeInspection }) => {
        const input = candidateAuthorization(), name = `freshell-claude-candidate-${input.requestId}`
        const url = `/v1.47/volumes/${name}`
        instance.authorizeInitialProviderVolume(sourceAuthorization())
        instance.authorizeClaudeCandidate(input)
        loseCandidateVolumeAck()
        expect((await request('POST', '/v1.47/volumes/create', { Name: name, Driver: 'local', DriverOpts: {}, Labels: candidateLabels(input) })).status).toBe(503)
        expect((await request('GET', url)).status).toBe(200)
        if (foreign) replaceCandidateVolumeInspection()
        expect((await request('DELETE', url)).status).toBe(foreign ? 403 : 204)
        expect(forwarded.filter((operation) => operation.method === 'DELETE')).toHaveLength(foreign ? 0 : 1)
        if (!foreign) expect((await request('GET', url)).status).toBe(404)
      })
    }
  })
  it('permits only the two fixed candidate helpers with selected ordinary inputs and exact lost-ack cleanup', async () => {
    for (const role of ['mountpoints', 'reader'] as const) {
      for (const lost of [false, true]) {
        await withHttpBroker(async ({ request, forwarded, broker: instance, loseHelperAck }) => {
          const input = candidateAuthorization(), volume = `freshell-claude-candidate-${input.requestId}`
          const name = `${role === 'reader' ? 'freshell-claude-candidate-reader' : 'freshell-mountpoints'}-11111111-1111-4111-8111-111111111111`
          instance.authorizeInitialProviderVolume(sourceAuthorization()); instance.authorizeClaudeCandidate(input)
          expect((await request('POST', '/v1.47/volumes/create', { Name: volume, Driver: 'local', DriverOpts: {}, Labels: candidateLabels(input) })).status).toBe(201)
          const body = candidateHelperBody(input, role), before = forwarded.length
          for (const mutation of ['uid','command','credential','caps','network','memory','logs','reservation','generation','request','mount','readonly','volume']) {
            const changed = structuredClone(body)
            if (mutation === 'uid') changed.User = '65534:0'
            if (mutation === 'command') changed.Cmd.push('PRIVATE_CANDIDATE_SENTINEL')
            if (mutation === 'credential') changed.Env.push('SECRET=PRIVATE_CANDIDATE_SENTINEL')
            if (mutation === 'caps') changed.HostConfig.CapAdd.push('DAC_OVERRIDE')
            if (mutation === 'network') changed.HostConfig.NetworkMode = 'bridge'
            if (mutation === 'memory') changed.HostConfig.Memory *= 2
            if (mutation === 'logs') changed.HostConfig.LogConfig.Type = 'json-file'
            if (mutation === 'reservation') changed.Labels['com.freshell.source-reservation-id'] = '33333333-3333-4333-8333-333333333333'
            if (mutation === 'generation') changed.Labels['com.freshell.input-generation'] = 'grant-33333333-3333-4333-8333-333333333333'
            if (mutation === 'request') changed.Labels['com.freshell.source-request-id'] = '33333333-3333-4333-8333-333333333333'
            if (mutation === 'mount') changed.HostConfig.Mounts.push({ Type: 'bind', Source: `${input.stageRoot}/.freshell/mcp-capability.json`, Target: '/outside', ReadOnly: true })
            if (mutation === 'readonly') changed.HostConfig.Mounts[0].ReadOnly = false
            if (mutation === 'volume') changed.HostConfig.Mounts[1].Source = sourceAuthorization().providerVolumeName
            expect((await request('POST', `/v1.47/containers/create?name=${name}`, changed)).status, `${role}/${mutation}`).toBe(403)
            expect(forwarded).toHaveLength(before)
          }
          if (lost) loseHelperAck()
          expect((await request('POST', `/v1.47/containers/create?name=${name}`, body)).status).toBe(lost ? 503 : 201)
          expect((await request('GET', `/v1.47/containers/${name}/json`)).status).toBe(200)
          expect(instance.receiptIds().has(helperId)).toBe(true)
          if (!lost) {
            expect((await request('POST', `/v1.47/containers/${helperId}/start`)).status).toBe(204)
            expect((await request('POST', `/v1.47/containers/${helperId}/wait?condition=not-running`)).status).toBe(200)
          }
          const beforeControls = forwarded.length
          for (const [method, url] of [
            ['GET', `/v1.47/containers/${helperId}/logs?stdout=1&stderr=1`], ['POST', `/v1.47/containers/${helperId}/exec`],
            ['POST', `/v1.47/containers/${helperId}/stop`], ['POST', `/v1.47/containers/${name}/start`],
          ]) {
            expect((await request(method, url)).status).toBe(403)
            expect(forwarded).toHaveLength(beforeControls)
          }
          expect((await request('DELETE', `/v1.47/containers/${helperId}?force=1`)).status).toBe(204)
          expect((await request('GET', `/v1.47/containers/${helperId}/json`)).status).toBe(404)
          expect((await request('DELETE', `/v1.47/volumes/${volume}`)).status).toBe(204)
          expect((await request('GET', `/v1.47/volumes/${volume}`)).status).toBe(404)
          expect(JSON.stringify(instance.eventsSnapshot())).not.toContain('PRIVATE_CANDIDATE_SENTINEL')
        })
      }
    }
  })
})

describe('scoped Claude source observer broker', () => {
  it('allows the reserved reader selected Git common directory for a linked checkout', async () => {
    await withHttpBroker(async ({ request, forwarded, broker: instance }) => {
      instance.authorizeInitialProviderVolume(sourceAuthorization())
      const body = sourceHelperBody()
      body.HostConfig.Mounts.push({ Type: 'bind', Source: '/workspace-git', Target: '/workspace-git', ReadOnly: true })
      for (const mutation of ['outside', 'alias', 'writable', 'volume-options', 'duplicate', 'extra']) {
        const changed = structuredClone(body)
        const common = changed.HostConfig.Mounts[3]
        if (mutation === 'outside') common.Source = common.Target = '/outside-git'
        if (mutation === 'alias') common.Target = '/workspace/.git'
        if (mutation === 'writable') common.ReadOnly = false
        if (mutation === 'volume-options') common.VolumeOptions = { NoCopy: true }
        if (mutation === 'duplicate') changed.HostConfig.Mounts.push(structuredClone(common))
        if (mutation === 'extra') changed.HostConfig.Mounts.push({ Type: 'bind', Source: '/workspace', Target: '/workspace', ReadOnly: true })
        expect((await request('POST', `/v1.47/containers/create?name=${sourceName}`, changed)).status, mutation).toBe(403)
        expect(forwarded).toHaveLength(0)
      }
      expect((await request('POST', `/v1.47/containers/create?name=${sourceName}`, body)).status).toBe(201)
      expect(forwarded).toHaveLength(1)
    }, { gitWorkspace: '/workspace-git' })
  })

  it.each(['source', 'mountpoints'] as const)('allows the producer %s exchange only directly under the owned shared root', async role => {
    await withHttpBroker(async ({ directory, request, forwarded, broker: instance }) => {
      const owner = { ...sourceAuthorization(), hostBinaryPath: path.join(directory, 'freshell-session-host') }
      instance.authorizeInitialProviderVolume(owner)
      const input = publisherAuthorization()
      input.hostBinaryPath = owner.hostBinaryPath
      input.stageRoot = path.join(directory, 'scenarios/scenario/control/provider-roots', input.generationId)
      instance.authorizePreparedInputs(input)
      const body = role === 'source' ? sourceHelperBody() : publisherBody(input)
      body.HostConfig.Mounts[0].Source = owner.hostBinaryPath
      if (role === 'mountpoints') {
        body.User = '0:0'; body.Cmd = ['prepare-provider-mountpoints']
        body.Labels = { 'com.freshell.installation-id': input.installationId, 'com.freshell.soul-id': input.soulId, 'com.freshell.incarnation-id': input.incarnationId }
        body.HostConfig.CapAdd = ['CHOWN', 'SETGID', 'SETUID']
        body.HostConfig.Mounts[1] = { Type: 'volume', Source: input.providerVolumeName, Target: '/home/freshell/provider', ReadOnly: false, VolumeOptions: { NoCopy: true } }
      }
      const basename = 'freshell-inputs-33333333-3333-4333-8333-333333333333'
      const exchange = path.join(directory, basename)
      await fs.mkdir(exchange, { mode: 0o700 })
      const linked = path.join(directory, 'freshell-inputs-44444444-4444-4444-8444-444444444444')
      await fs.symlink(exchange, linked)
      body.HostConfig.Mounts[2].Source = exchange
      const name = role === 'source' ? sourceName : 'freshell-mountpoints-11111111-1111-4111-8111-111111111111'
      for (const rejected of [directory + '-sibling/' + basename, path.join(directory, 'nested', basename), path.join(directory, 'native'), linked]) {
        const changed = structuredClone(body)
        changed.HostConfig.Mounts[2].Source = rejected
        expect((await request('POST', `/v1.47/containers/create?name=${name}`, changed)).status).toBe(403)
        expect(forwarded).toHaveLength(0)
      }
      const writable = structuredClone(body)
      writable.HostConfig.Mounts[2].ReadOnly = false
      expect((await request('POST', `/v1.47/containers/create?name=${name}`, writable)).status).toBe(403)
      expect(forwarded).toHaveLength(0)
      expect((await request('POST', `/v1.47/containers/create?name=${name}`, body)).status).toBe(201)
    }, undefined, true)
  })
  it('holds a configured slow helper create before Docker sees it, for the configured count only', async () => {
    await withHttpBroker(async ({ request, forwarded, broker: instance, returnHelperId }) => {
      instance.authorizeInitialProviderVolume(sourceAuthorization())
      instance.delayHelperCreates({ prefix: 'freshell-claude-source-', delayMs: 300, count: 1 })
      const started = Date.now()
      const held = request('POST', `/v1.47/containers/create?name=${sourceName}`, sourceHelperBody())
      await new Promise(resolve => setTimeout(resolve, 100))
      expect(forwarded, 'Docker has not been asked to make the helper yet').toHaveLength(0)
      expect((await held).status).toBe(201)
      expect(Date.now() - started).toBeGreaterThanOrEqual(300)
      expect(forwarded.map(operation => operation.url)).toEqual([`/v1.47/containers/create?name=${sourceName}`])
      expect(instance.eventsSnapshot()).toContainEqual(expect.objectContaining({
        decision: 'inject_failure', reason: 'configured slow helper create (300ms)', helperName: sourceName,
      }))
      const next = 'freshell-claude-source-22222222-2222-4222-8222-222222222222'
      returnHelperId('c'.repeat(64))
      const quick = Date.now()
      expect((await request('POST', `/v1.47/containers/create?name=${next}`, sourceHelperBody())).status).toBe(201)
      expect(Date.now() - quick, 'only the configured count is held').toBeLessThan(250)
    })
  })
  it('lets cleanup wait until a helper create Docker answers late is recorded', async () => {
    await withHttpBroker(async ({ request, broker: instance }) => {
      instance.authorizeInitialProviderVolume(sourceAuthorization())
      instance.delayHelperCreates({ prefix: 'freshell-claude-source-', delayMs: 300, count: 1 })
      // The supervisor has stopped waiting; the proxy still owes Docker's answer.
      const owed = request('POST', `/v1.47/containers/create?name=${sourceName}`, sourceHelperBody())
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(instance.receiptIds().has(helperId)).toBe(false)
      expect(await instance.settleForwarded(5_000)).toBe(true)
      expect(instance.receiptIds().has(helperId), 'cleanup now knows the late helper').toBe(true)
      expect((await owed).status).toBe(201)
    })
  })
  it('reports requests that are still unanswered at the settle deadline', async () => {
    await withHttpBroker(async ({ request, broker: instance }) => {
      instance.authorizeInitialProviderVolume(sourceAuthorization())
      instance.delayHelperCreates({ prefix: 'freshell-claude-source-', delayMs: 1_000, count: 1 })
      const owed = request('POST', `/v1.47/containers/create?name=${sourceName}`, sourceHelperBody())
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(await instance.settleForwarded(100)).toBe(false)
      expect((await owed).status).toBe(201)
      expect(await instance.settleForwarded(100)).toBe(true)
    })
  })
  it('parses the slow helper create setting and refuses anything but the fixed helpers', () => {
    expect(parseHelperCreateDelay(undefined)).toBeUndefined()
    expect(parseHelperCreateDelay('')).toBeUndefined()
    expect(parseHelperCreateDelay('freshell-claude-source-:30000')).toEqual({ prefix: 'freshell-claude-source-', delayMs: 30_000, count: 1 })
    expect(parseHelperCreateDelay('freshell-mountpoints-:1500:2')).toEqual({ prefix: 'freshell-mountpoints-', delayMs: 1_500, count: 2 })
    for (const invalid of ['freshell-incarnation-:1000', 'freshell-claude-source-:soon', 'freshell-claude-source-:0',
      'freshell-claude-source-:1000:0', 'freshell-claude-source-:1000:1:extra', 'freshell-mountpoints-:700000']) {
      expect(() => parseHelperCreateDelay(invalid), invalid).toThrow(/invalid helper create delay/)
    }
  })
  it('bounds owner drain while a held helper create has not been forwarded', async () => {
    await withHttpBroker(async ({ request, forwarded, broker: instance }) => {
      instance.authorizeInitialProviderVolume(sourceAuthorization())
      instance.delayHelperCreates({ prefix: 'freshell-claude-source-', delayMs: 10_000, count: 1 })
      const createPath = `/v1.47/containers/create?name=${sourceName}`
      const owed = request('POST', createPath, sourceHelperBody()).catch(() => undefined)
      const observedUntil = Date.now() + 2_000
      while (!instance.eventsSnapshot().some(event => event.decision === 'inject_failure' && event.helperName === sourceName)) {
        if (Date.now() >= observedUntil) throw new Error('the broker did not enter the held create')
        await new Promise(resolve => setTimeout(resolve, 5))
      }
      expect(forwarded).toHaveLength(0)
      const started = Date.now()
      expect(await instance.awaitPendingRequests()).toEqual([
        { method: 'POST', url: createPath, reason: 'cleanup_deadline_before_forward', allocationUnknown: false },
      ])
      expect(Date.now() - started, 'owner cleanup must not wait for the unforwarded artificial delay').toBeLessThan(7_500)
      expect(forwarded, 'an unsent create cannot allocate after owner cleanup').toHaveLength(0)
      expect(await instance.settleForwarded(100), 'cleanup joins the canceled delayed handler').toBe(true)
      await owed
    })
  }, 20_000)
  it('records bounded upstream helper rejection and host exchange absence without daemon payloads', async () => {
    await withHttpBroker(async ({ request, broker: instance, rejectHelperCreate }) => {
      instance.authorizeInitialProviderVolume(sourceAuthorization())
      rejectHelperCreate()
      expect((await request('POST', `/v1.47/containers/create?name=${sourceName}`, sourceHelperBody())).status).toBe(400)
      expect(instance.eventsSnapshot().at(-1)).toMatchObject({
        decision: 'forward',
        reason: 'upstream helper rejected: status=400; cause=missing_bind_source; ownedExchangeHostExists=false',
      })
      expect(JSON.stringify(instance.eventsSnapshot())).not.toContain('PRIVATE_DAEMON_SENTINEL')
    })
  })
  it('allows the reserved fixed reader for an owned nested project and denies outside or writable mounts', async () => {
    await withHttpBroker(async ({ request, forwarded, broker: instance }) => {
      instance.authorizeInitialProviderVolume(sourceAuthorization())
      const body = sourceHelperBody()
      body.WorkingDir = '/workspace/project/nested'
      body.HostConfig.Mounts[1] = { Type: 'bind', Source: '/workspace/project', Target: '/workspace/project', ReadOnly: true }
      for (const outside of ['/workspace-sibling/project', '/outside/project']) {
        const changed = structuredClone(body)
        changed.WorkingDir = outside
        changed.HostConfig.Mounts[1].Source = outside
        changed.HostConfig.Mounts[1].Target = outside
        expect((await request('POST', `/v1.47/containers/create?name=${sourceName}`, changed)).status).toBe(403)
        expect(forwarded).toHaveLength(0)
      }
      const writable = structuredClone(body)
      writable.HostConfig.Mounts[1].ReadOnly = false
      expect((await request('POST', `/v1.47/containers/create?name=${sourceName}`, writable)).status).toBe(403)
      expect(forwarded).toHaveLength(0)
      expect((await request('POST', `/v1.47/containers/create?name=${sourceName}`, body)).status).toBe(201)
      expect(forwarded).toHaveLength(1)
    })
  })
  it('allows the reserved fixed reader and exact private lifecycle without creating initial HOME or exposing logs', async () => {
    await withHttpBroker(async ({ request, forwarded, broker: instance }) => {
      const body = sourceHelperBody()
      expect((await request('POST', `/v1.47/containers/create?name=${sourceName}`, body)).status).toBe(403)
      expect(forwarded).toHaveLength(0)
      instance.authorizeInitialProviderVolume(sourceAuthorization())
      for (const mutate of [
        (value: any) => { value.User = '0:0' },
        (value: any) => { value.Cmd.push('PRIVATE_SOURCE_SENTINEL') },
        (value: any) => { value.Env.push('SECRET=PRIVATE_SOURCE_SENTINEL') },
        (value: any) => { value.WorkingDir = '/outside' },
        (value: any) => { value.Labels['com.freshell.soul-id'] = 'foreign' },
        (value: any) => { value.Labels['com.freshell.source-binary-sha256'] = 'b'.repeat(64) },
        (value: any) => { value.HostConfig.CapAdd = ['SYS_ADMIN'] },
        (value: any) => { value.HostConfig.NetworkMode = 'host' },
        (value: any) => { value.HostConfig.Tmpfs['/home/freshell/provider'] = 'rw,size=128m' },
        (value: any) => { value.HostConfig.Mounts[1].ReadOnly = false },
        (value: any) => { value.HostConfig.Mounts.push({ Type: 'bind', Source: '/operator-home', Target: '/outside', ReadOnly: true }) },
        (value: any) => { value.HostConfig.LogConfig.Type = 'json-file' },
      ]) {
        const changed = structuredClone(body); mutate(changed)
        expect((await request('POST', `/v1.47/containers/create?name=${sourceName}`, changed)).status).toBe(403)
        expect(forwarded).toHaveLength(0)
      }
      expect((await request('POST', `/v1.47/containers/create?name=${sourceName}`, body)).status).toBe(201)
      expect(instance.receiptIds().has(helperId)).toBe(true)
      expect((await request('GET', `/v1.47/containers/${helperId}/json`)).status).toBe(200)
      expect((await request('POST', `/v1.47/containers/${helperId}/start`)).status).toBe(204)
      expect((await request('POST', `/v1.47/containers/${helperId}/wait?condition=not-running`)).status).toBe(200)
      const before = forwarded.length
      for (const [method, url] of [
        ['GET', `/v1.47/containers/${helperId}/logs?stdout=1&stderr=1`],
        ['POST', `/v1.47/containers/${helperId}/stop`],
        ['POST', `/v1.47/containers/${sourceName}/start`],
        ['POST', `/v1.47/containers/${helperId}/exec`],
      ]) {
        expect((await request(method, url)).status).toBe(403)
        expect(forwarded).toHaveLength(before)
      }
      expect((await request('DELETE', `/v1.47/containers/${sourceName}?force=1`)).status).toBe(204)
      expect(forwarded.some((operation) => operation.url === '/v1.47/volumes/create')).toBe(false)
      expect(JSON.stringify(instance.eventsSnapshot())).not.toContain('PRIVATE_SOURCE_SENTINEL')
    })
  })
  it('retains exact-name cleanup after lost acknowledgement and refuses changed source helper ownership', async () => {
    await withHttpBroker(async ({ request, forwarded, broker: instance, loseHelperAck, replaceHelperInspection }) => {
      instance.authorizeInitialProviderVolume(sourceAuthorization())
      loseHelperAck()
      expect((await request('POST', `/v1.47/containers/create?name=${sourceName}`, sourceHelperBody())).status).toBe(503)
      expect((await request('GET', `/v1.47/containers/${sourceName}/json`)).status).toBe(200)
      replaceHelperInspection()
      expect((await request('DELETE', `/v1.47/containers/${sourceName}?force=1`)).status).toBe(403)
      expect(forwarded.filter((operation) => operation.method === 'DELETE')).toEqual([])
    })
  })
  it('adopts the full owned identity after a lost source-helper acknowledgement and confirms absence', async () => {
    await withHttpBroker(async ({ request, forwarded, broker: instance, loseHelperAck }) => {
      instance.authorizeInitialProviderVolume(sourceAuthorization())
      loseHelperAck()
      expect((await request('POST', `/v1.47/containers/create?name=${sourceName}`, sourceHelperBody())).status).toBe(503)
      expect(instance.receiptIds().has(helperId)).toBe(false)
      const inspected = await request('GET', `/v1.47/containers/${sourceName}/json`)
      expect(inspected.status).toBe(200)
      expect(JSON.parse(inspected.body).Id).toBe(helperId)
      expect(instance.receiptIds().has(helperId)).toBe(true)
      expect((await request('DELETE', `/v1.47/containers/${helperId}?force=1`)).status).toBe(204)
      expect((await request('GET', `/v1.47/containers/${helperId}/json`)).status).toBe(404)
      expect(forwarded.filter((operation) => operation.method === 'DELETE')).toEqual([
        { method: 'DELETE', url: `/v1.47/containers/${helperId}?force=1`, body: undefined },
      ])
    })
  })
  it('leaves a foreign inspected helper unowned after a lost acknowledgement', async () => {
    await withHttpBroker(async ({ request, forwarded, broker: instance, loseHelperAck, replaceHelperInspection }) => {
      instance.authorizeInitialProviderVolume(sourceAuthorization())
      loseHelperAck()
      expect((await request('POST', `/v1.47/containers/create?name=${sourceName}`, sourceHelperBody())).status).toBe(503)
      replaceHelperInspection()
      expect((await request('GET', `/v1.47/containers/${sourceName}/json`)).status).toBe(200)
      expect(instance.receiptIds().has(helperId)).toBe(false)
      expect((await request('DELETE', `/v1.47/containers/${helperId}?force=1`)).status).toBe(403)
      expect((await request('DELETE', `/v1.47/containers/${sourceName}?force=1`)).status).toBe(403)
      expect(forwarded.filter((operation) => operation.method === 'DELETE')).toEqual([])
    })
  })
})

describe('receipt-owned auth exchange HTTP routes', () => {
  it('allows the producer auth exchange only directly under the owned shared root', async () => {
    await withHttpBroker(async ({ directory, request, forwarded }) => {
      const binds = [...ordinaryBinds, actorBind].map(bind => bind.replace('/tmp/owned', directory))
      expect((await request('POST', '/v1.47/containers/create?name=owned-runtime', createBody(binds))).status).toBe(201)
      const body = authHelperBody()
      body.HostConfig.Mounts[0].Source = path.join(directory, 'freshell-session-host')
      const exchange = path.join(directory, authName)
      await fs.mkdir(exchange, { mode: 0o710 })
      const linked = path.join(directory, authName.replace('111111111111', '222222222222'))
      await fs.symlink(exchange, linked)
      body.HostConfig.Mounts[2].Source = exchange
      const before = forwarded.length
      for (const rejected of [directory + '-sibling/' + authName, path.join(directory, 'nested', authName), path.join(directory, 'native'), linked]) {
        const changed = structuredClone(body)
        changed.HostConfig.Mounts[2].Source = rejected
        expect((await request('POST', `/v1.47/containers/create?name=${authName}`, changed)).status).toBe(403)
        expect(forwarded).toHaveLength(before)
      }
      const writable = structuredClone(body)
      writable.HostConfig.Mounts[2].ReadOnly = false
      expect((await request('POST', `/v1.47/containers/create?name=${authName}`, writable)).status).toBe(403)
      expect(forwarded).toHaveLength(before)
      expect((await request('POST', `/v1.47/containers/create?name=${authName}`, body)).status).toBe(201)
    }, undefined, true)
  })
  it('allows only the fixed private helper, lifecycle and ownership inspection with Docker logs disabled', async () => {
    await withHttpBroker(async ({ request, forwarded }) => {
      await request('POST', '/v1.47/containers/create?name=owned-runtime', createBody([...ordinaryBinds, actorBind]))
      const mutations = [
        (body: any) => { body.Cmd.push('PRIVATE_SENTINEL') },
        (body: any) => { body.HostConfig.LogConfig.Type = 'json-file' },
        (body: any) => { body.HostConfig.Mounts[1].ReadOnly = false },
        (body: any) => { body.HostConfig.Mounts[2].Source = '/tmp/unapproved' },
        (body: any) => { body.HostConfig.Mounts[2].ReadOnly = false },
        (body: any) => { body.Env.push('SECRET=PRIVATE_SENTINEL') },
      ]
      for (const mutate of mutations) {
        const body = authHelperBody()
        mutate(body)
        const before = forwarded.length
        expect((await request('POST', `/v1.47/containers/create?name=${authName}`, body)).status).toBe(403)
        expect(forwarded).toHaveLength(before)
      }
      expect((await request('POST', `/v1.47/containers/create?name=${authName}`, authHelperBody())).status).toBe(201)
      expect((await request('POST', `/v1.47/containers/${helperId}/start`)).status).toBe(204)
      expect((await request('POST', `/v1.47/containers/${helperId}/wait?condition=not-running`)).status).toBe(200)
      expect((await request('GET', `/v1.47/containers/${authName}/json`)).status).toBe(200)
      const before = forwarded.length
      expect((await request('GET', `/v1.47/containers/${helperId}/logs?stdout=1&stderr=1`)).status).toBe(403)
      expect((await request('POST', `/v1.47/containers/${helperId}/stop`)).status).toBe(403)
      expect(forwarded).toHaveLength(before)
      expect((await request('DELETE', `/v1.47/containers/${authName}?force=1`)).status).toBe(204)
      expect(forwarded.filter((operation) => operation.method === 'DELETE')).toEqual([
        { method: 'DELETE', url: `/v1.47/containers/${authName}?force=1`, body: undefined },
      ])
    })
  })
})

function retainedStoreHelperBody() {
  const body=historyHelperBody()
  const image=`sha256:${'b'.repeat(64)}`
  const request={providerStoreId:'exact-store',nativeSessionId:'ses_exact',imageRef:image,providerHome:'/home/freshell/provider',workspacePath:'/workspace',cwd:'/workspace',providerUid:65534,providerGid:0}
  return {
    ...body,Image:image,Tty:false,WorkingDir:'/workspace',
    Cmd:['retained-opencode-store-worker',JSON.stringify(request)],
    Env:['HOME=/home/freshell/provider','XDG_DATA_HOME=/home/freshell/provider/.local/share','XDG_CONFIG_HOME=/home/freshell/provider/.config','OPENCODE_DB=/home/freshell/provider/.local/share/opencode/opencode.db'],
    HostConfig:{...body.HostConfig,Tmpfs:{'/tmp':'rw,noexec,nosuid,nodev,size=64m'},Mounts:[
      {...body.HostConfig.Mounts[0],Source:'/tmp/owned/other-approved-host'},body.HostConfig.Mounts[1],
      {Type:'bind',Source:'/workspace',Target:'/workspace',ReadOnly:true},
    ]},
  }
}

function dockerCliRetainedStoreHelperBody() {
  const body = retainedStoreHelperBody()
  // Captured from the actual installed-store producer and Docker 29.7.2
  // create request. This Node HTTP fixture protects admission semantics;
  // the separate private diagnostic exercises Docker serialization.
  body.Env = [body.Env[3], body.Env[0], body.Env[1], body.Env[2]]
  Object.assign(body.HostConfig, { CapAdd: null, Binds: null })
  return body
}

type ForwardedRequest = { method: string; url: string; body: any }
type BrokerHttpFixture = {
  directory: string
  setRuntimeRunning:(running:boolean)=>void
  request(method: string, url: string, body?: unknown, timeoutMs?: number): Promise<{ status: number; body: string }>
  forwarded: ForwardedRequest[]
  logPath: string
  broker: RestrictedDockerBroker
  loseHelperAck(): void
  rejectHelperCreate(): void
  returnHelperId(id: string): void
  replaceHelperInspection():void
  loseCandidateVolumeAck(): void
  replaceCandidateVolumeInspection(): void
  clearCandidateVolumeInspection(): void
}

function publisherAuthorization():PreparedInputAuthorization {
  const generationId='grant-publisher';
  return {installationId:'installation-one',soulId:'soul-one',incarnationId:'incarnation-one',generationId,
    imageRef:'sha256:fixture-image',hostBinaryPath:'/tmp/owned/freshell-session-host',providerVolumeName:providerVolume,
    stageRoot:`/tmp/owned/scenarios/scenario/control/provider-roots/${generationId}`,configurationBinds:[],resourceMounts:[],
    indexedFiles:{volumeName:`freshell-inputs-${createHash('sha256').update(`soul-one\0${generationId}`).digest('hex').slice(0,24)}`,aliases:[{sourceId:0,effectiveDestination:'/workspace/input'}]},
    indexedSecretSources:[{grantIndex:0,sourceId:0}]};
}

const indexedOptions={type:'tmpfs',device:'tmpfs',o:'size=64m,mode=0700,uid=65534,gid=0,nr_inodes=1024,nosuid,nodev,noexec'};
function publisherLabels(input:PreparedInputAuthorization) {
  return {'com.freshell.managed-inputs':'true','com.freshell.installation-id':input.installationId,
    'com.freshell.soul-id':input.soulId,'com.freshell.incarnation-id':input.incarnationId,'com.freshell.input-generation':input.generationId};
}
function publisherBody(input:PreparedInputAuthorization):any {
  return {Image:input.imageRef,User:'65534:0',Tty:false,Labels:publisherLabels(input),Entrypoint:['/runtime/freshell-session-host'],Cmd:['publish-provider-inputs'],Env:['PATH='],
    HostConfig:{NetworkMode:'none',ReadonlyRootfs:true,CapDrop:['ALL'],SecurityOpt:['no-new-privileges'],Memory:128*1024*1024,MemorySwap:128*1024*1024,NanoCpus:500_000_000,PidsLimit:32,LogConfig:{Type:'none',Config:{}},
      Mounts:[{Type:'bind',Source:input.hostBinaryPath,Target:'/runtime/freshell-session-host',ReadOnly:true},
        {Type:'volume',Source:input.indexedFiles!.volumeName,Target:'/run/freshell-input-files',ReadOnly:false,VolumeOptions:{NoCopy:true}},
        {Type:'bind',Source:path.join(os.tmpdir(),'freshell-inputs-11111111-1111-4111-8111-111111111111'),Target:'/run/freshell-input-exchange',ReadOnly:true}]}};
}

async function publishControllerPreparation(directory: string, input: Pick<PreparedInputAuthorization,
  'soulId' | 'generationId' | 'stageRoot' | 'configurationBinds' | 'resourceMounts' | 'indexedFiles'>,
  reservationId: string | null, provider: 'claude' | 'codex') {
  const metadata = path.join(input.stageRoot, '.freshell')
  await fs.mkdir(metadata, { recursive: true })
  const manifest = Buffer.from(JSON.stringify({ version: 1, sources: [], aliases: [], recipes: [] }))
  await fs.writeFile(path.join(metadata, 'input-manifest.json'), manifest)
  const context = {
    preparation: provider === 'claude' ? { claude: { mcp_args: [] } } : { codex: { tui_args: [], sidecar_args: [] } },
    config: [], mcpCapability: { grantId: input.generationId, endpoint: 'http://127.0.0.1:1/api/managed-mcp', providerRelativePath: '.freshell/mcp-capability.json' },
    preparedInputs: { generationId: input.generationId, initialAuthReservation: reservationId,
      manifest: { relativePath: '.freshell/input-manifest.json', sha256: createHash('sha256').update(manifest).digest('hex'), sourceCount: 0, aliasCount: 0, recipeCount: 0 },
      configBinds: input.configurationBinds.map(bind => ({ ...bind, logicalDestination: bind.effectiveDestination })),
      resourceMounts: input.resourceMounts.map(mount => ({ ...mount, logicalDestination: mount.effectiveDestination })),
      ...(input.indexedFiles ? { indexedFiles: input.indexedFiles } : {}),
    },
  }
  const contextBytes = Buffer.from(JSON.stringify(context))
  const resultBytes = Buffer.from(JSON.stringify({ providerLaunchContext: context, providerSecretReferences: [] }))
  await fs.writeFile(path.join(metadata, 'prepared-context.json'), contextBytes)
  await fs.writeFile(path.join(metadata, 'prepared-result.json'), resultBytes)
  const capabilities = path.join(directory, 'scenarios/scenario/control/mcp-capabilities')
  await fs.mkdir(capabilities, { recursive: true })
  await fs.writeFile(path.join(capabilities, `${input.generationId}.json`), JSON.stringify({
    endpoint: context.mcpCapability.endpoint, scope: 'synthetic-controller-scope', soulId: input.soulId,
    incarnationId: null, expiresAt: Date.now() + 60_000, preparation: { phase: 'pending', priorGrantIds: [] },
  }))
  return { metadata, capabilities, context, contextBytes, resultBytes }
}

describe('fixed indexed publisher broker',()=>{
  it.each(['mountpoints', 'publisher'] as const)('keeps run-owned image provenance compatible with exact %s helper cleanup', async role => {
    const imageLabels: Record<string, string> = {}
    await withHttpBroker(async ({ directory, request, broker: instance }) => {
      const project = path.join(directory, 'project')
      await fs.mkdir(project)
      execFileSync('git', ['init', '--quiet'], { cwd: project })
      execFileSync('git', ['-c', 'user.name=Dan Shapiro', '-c', 'user.email=3732858+danshapiro@users.noreply.github.com',
        '-c', 'commit.gpgsign=false', 'commit', '--quiet', '--allow-empty', '-m', 'Synthetic image source'], { cwd: project })
      const candidate = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: project, encoding: 'utf8' }).trim()
      const digest = `sha256:${'b'.repeat(64)}`
      const execute = vi.fn<typeof execFileSync>().mockImplementation((_command, args) => {
        if (args?.[0] === 'build') {
          for (let index = 0; index < args.length; index++) {
            if (args[index] !== '--label') continue
            const label = String(args[index + 1])
            const separator = label.indexOf('=')
            imageLabels[label.slice(0, separator)] = label.slice(separator + 1)
          }
          return ''
        }
        return digest
      })
      const image = buildRunOwnedRuntimeImage(project, '11111111-1111-4111-8111-111111111111', candidate, execute)
      const input = { ...publisherAuthorization(), imageRef: image.digest }
      instance.authorizePreparedInputs(input)
      const body = publisherBody(input)
      let name = `${input.indexedFiles!.volumeName}-publisher`
      if (role === 'mountpoints') {
        name = 'freshell-mountpoints-11111111-1111-4111-8111-111111111111'
        body.User = '0:0'
        body.Cmd = ['prepare-provider-mountpoints']
        body.Labels = { 'com.freshell.installation-id': input.installationId,
          'com.freshell.soul-id': input.soulId, 'com.freshell.incarnation-id': input.incarnationId }
        body.HostConfig.CapAdd = ['CHOWN', 'SETGID', 'SETUID']
        body.HostConfig.Mounts[1] = { Type: 'volume', Source: input.providerVolumeName,
          Target: '/home/freshell/provider', ReadOnly: false, VolumeOptions: { NoCopy: true } }
      } else {
        expect((await request('POST', '/v1.47/volumes/create', { Name: input.indexedFiles!.volumeName,
          Driver: 'local', DriverOpts: indexedOptions, Labels: publisherLabels(input) })).status).toBe(201)
      }
      expect((await request('POST', `/v1.47/containers/create?name=${name}`, body)).status).toBe(201)
      const inspected = await request('GET', `/v1.47/containers/${helperId}/json`)
      expect(inspected.status).toBe(200)
      expect(JSON.parse(inspected.body).Config.Labels).toMatchObject(imageLabels)
      expect((await request('POST', `/v1.47/containers/${helperId}/start`)).status).toBe(204)
      if (role === 'mountpoints') {
        expect((await request('POST', `/v1.47/containers/${helperId}/wait?condition=not-running`)).status).toBe(200)
      }
      expect((await request('DELETE', `/v1.47/containers/${name}?force=1`)).status).toBe(204)
      expect((await request('GET', `/v1.47/containers/${helperId}/json`)).status).toBe(404)
      if (role === 'publisher') {
        expect((await request('DELETE', `/v1.47/volumes/${input.indexedFiles!.volumeName}`)).status).toBe(204)
      }
      expect(instance.unsafeAttempts()).toEqual([])
    }, { imageLabels })
  })

  it('settles an indexed publisher without a runtime receipt after draining while refusing new work', async () => {
    await withHttpBroker(async ({ directory, request, broker: instance }) => {
      const input = publisherAuthorization()
      instance.authorizePreparedInputs(input)
      const volume = input.indexedFiles!.volumeName
      expect((await request('POST', '/v1.47/volumes/create', {
        Name: volume, Driver: 'local', DriverOpts: indexedOptions, Labels: publisherLabels(input),
      })).status).toBe(201)
      expect((await request('POST', `/v1.47/containers/create?name=${volume}-publisher`, publisherBody(input))).status).toBe(201)
      expect(instance.receipts()).toEqual([])
      expect(instance.receiptIds()).toContain(helperId)
      expect(await instance.awaitPendingRequests()).toEqual([])
      // The owner removes the exact acknowledged helper through its Docker
      // transport after drain; only indexed-volume settlement uses the broker.
      await new Promise<void>((resolve, reject) => {
        const removal = http.request({ socketPath: path.join(directory, 'docker.sock'),
          method: 'DELETE', path: `/v1.47/containers/${helperId}?force=1` }, response => {
          response.resume()
          response.on('end', () => response.statusCode === 204 ? resolve() : reject(new Error('owned helper removal failed')))
        })
        removal.on('error', reject)
        removal.end()
      })
      expect((await request('DELETE', `/v1.47/volumes/${volume}`)).status).toBe(204)
      expect((await request('GET', `/v1.47/volumes/${volume}`)).status).toBe(404)
      expect((await request('POST', '/v1.47/volumes/create', {})).status).toBe(503)
    })
  })
  it.each(['/outside/selected-plugin', '/home/freshell/provider-sibling/config', '/home/freshell/provider/.codex/sessions'])(
    'retains the actual rejected preparation destination without widening authority (%s)', async destination => {
      await withHttpBroker(async ({ request, forwarded, broker: instance, directory }) => {
        const binary = Buffer.from('owned publication artifact')
        const owner = { ...sourceAuthorization(), hostBinaryPath: path.join(directory, 'freshell-session-host'),
          binarySha256: createHash('sha256').update(binary).digest('hex') }
        await fs.writeFile(owner.hostBinaryPath, binary)
        instance.authorizeInitialProviderVolume(owner)
        const generationId = 'grant-66666666-6666-4666-8666-666666666666'
        const input = { ...publisherAuthorization(), soulId: owner.soulId, generationId,
          hostBinaryPath: owner.hostBinaryPath, providerVolumeName: owner.providerVolumeName,
          stageRoot: path.join(directory, 'scenarios/scenario/control/provider-roots', generationId),
          configurationBinds: [{ sourceRelativePath: '.freshell/templates/codex-0', effectiveDestination: destination }],
          resourceMounts: [], indexedSecretSources: [],
          indexedFiles: { volumeName: `freshell-inputs-${createHash('sha256').update(`${owner.soulId}\0${generationId}`).digest('hex').slice(0, 24)}`, aliases: [] } }
        const publication = await publishControllerPreparation(directory, input, '11111111-1111-4111-8111-111111111111', 'codex')
        const capabilityPath = path.join(publication.capabilities, `${generationId}.json`)
        const capability = JSON.parse(await fs.readFile(capabilityPath, 'utf8'))
        capability.scope = 'PRIVATE_SCOPE_CONTENT_SENTINEL'
        await fs.writeFile(capabilityPath, JSON.stringify(capability))
        await fs.mkdir(path.join(publication.metadata, 'templates'))
        await fs.writeFile(path.join(publication.metadata, 'templates/codex-0'), 'PRIVATE_CONFIG_CONTENT_SENTINEL')
        const initial = { Name: owner.providerVolumeName, Driver: 'local', Labels: {
          'com.freshell.installation-id': owner.installationId, 'com.freshell.soul-id': owner.soulId,
          'freshell.input.reservation': publication.context.preparedInputs.initialAuthReservation,
          'freshell.input.incarnation': input.incarnationId, 'freshell.input.intent': '1',
          'freshell.input.daemon': owner.daemonId, 'freshell.input.image': owner.imageRef,
          'freshell.input.binary-sha256': owner.binarySha256,
        } }
        expect((await request('POST', '/v1.47/volumes/create', initial)).status).toBe(201)
        const before = forwarded.length
        const denied = await request('POST', '/v1.47/volumes/create', {
          Name: input.indexedFiles.volumeName, Driver: 'local', DriverOpts: indexedOptions, Labels: publisherLabels(input),
        })
        expect(denied.status).toBe(403)
        expect(forwarded).toHaveLength(before)
        const diagnostic = instance.eventsSnapshot().find(event => event.reason === 'fixture publication unavailable at prepared_authorization: target_root')
        expect(diagnostic).toMatchObject({ targetPath: destination, preparationStageRoot: input.stageRoot,
          selectedWorkspaceRoots: ['/workspace'], selectedProviderInputRoots: ['/selected-provider-inputs'] })
        const events = JSON.stringify(instance.eventsSnapshot())
        expect(events).not.toContain('PRIVATE_SCOPE_CONTENT_SENTINEL')
        expect(events).not.toContain('PRIVATE_CONFIG_CONTENT_SENTINEL')
        expect(instance.receipts()).toEqual([])
      }, undefined, true, new Set(['/selected-provider-inputs']))
    },
  )
  it('authorizes selected external provider input targets without authorizing them as workspaces', async () => {
    await withHttpBroker(async ({ request, broker: instance }) => {
      const selectedRoot = '/selected-provider-inputs'
      const input = { ...publisherAuthorization(), resourceMounts: [{
        providerRelativePath: '.freshell/provider-roots/fixture-mcp',
        effectiveDestination: path.join(selectedRoot, 'fixture-mcp'),
        kind: 'directory' as const,
      }] }
      const selectedAsWorkspace = createBody([
        ...ordinaryBinds.slice(0, 3),
        `${selectedRoot}:${selectedRoot}:rw`,
      ])
      const result = await request('POST', '/v1.47/containers/create?name=external-input-as-workspace', JSON.parse(selectedAsWorkspace.toString()))
      expect(result.status).toBe(403)
      expect(() => instance.authorizePreparedInputs(input)).not.toThrow()
    }, undefined, false, new Set(['/selected-provider-inputs']))
  })
  it.each(['exited', 'running', 'foreign-owner', 'changed-image', 'changed-host', 'foreign-capability'] as const)(
    'qualifies a replacement publication against its retained owner (%s)', async (state) => {
      await withHttpBroker(async ({ directory, request, forwarded, broker: instance, setRuntimeRunning }) => {
        const artifact = Buffer.from('replacement owned host artifact')
        const owner = { ...sourceAuthorization(), hostBinaryPath: path.join(directory, 'freshell-session-host'),
          binarySha256: createHash('sha256').update(artifact).digest('hex') }
        await fs.writeFile(owner.hostBinaryPath, artifact)
        instance.authorizeInitialProviderVolume(owner)
        const priorRuntime = path.join(directory, 'r/scenario/incarnation-one')
        const actor = path.join(path.dirname(priorRuntime), 'souls',
          createHash('sha256').update(`${owner.installationId}\0${owner.soulId}`).digest('hex'), 'actor')
        const prior = JSON.parse(createBody([
          `${owner.hostBinaryPath}:/runtime/freshell-session-host:ro`,
          `${priorRuntime}:/run/freshell:rw`, `${owner.providerVolumeName}:/home/freshell/provider:rw`,
          '/workspace:/workspace:rw', `${actor}:/run/freshell-host-actor:rw`,
        ]).toString())
        prior.Labels['com.freshell.soul-id'] = owner.soulId
        expect((await request('POST', '/v1.47/containers/create?name=retained-runtime', prior)).status).toBe(201)
        expect(instance.receipts()).toMatchObject([{ containerId: ownedId, soulId: owner.soulId,
          incarnationId: 'incarnation-one', providerVolumeName: owner.providerVolumeName }])

        const generationId = 'grant-55555555-5555-4555-8555-555555555555'
        const input = { ...publisherAuthorization(), soulId: owner.soulId, incarnationId: 'incarnation-two',
          generationId, hostBinaryPath: owner.hostBinaryPath, providerVolumeName: owner.providerVolumeName,
          stageRoot: path.join(directory, 'scenarios/scenario/control/provider-roots', generationId),
          configurationBinds: [], resourceMounts: [], indexedSecretSources: [],
          indexedFiles: { volumeName: `freshell-inputs-${createHash('sha256').update(`${owner.soulId}\0${generationId}`).digest('hex').slice(0, 24)}`, aliases: [] } }
        const publication = await publishControllerPreparation(directory, input, '', 'codex')
        // Replacement producer publications have no initial reservation; their
        // authority is the exact quiescent retained runtime, not the old tuple.
        const context = publication.context as Record<string, any>
        delete context.preparedInputs.initialAuthReservation
        await fs.writeFile(path.join(publication.metadata, 'prepared-context.json'), JSON.stringify(context))
        await fs.writeFile(path.join(publication.metadata, 'prepared-result.json'), JSON.stringify({
          providerLaunchContext: context, providerSecretReferences: [],
        }))
        const capabilityPath = path.join(publication.capabilities, `${generationId}.json`)
        const capability = JSON.parse(await fs.readFile(capabilityPath, 'utf8'))
        capability.incarnationId = state === 'foreign-capability' ? 'foreign-incarnation' : input.incarnationId
        await fs.writeFile(capabilityPath, JSON.stringify(capability))
        setRuntimeRunning(state === 'running')
        const upstreamPrior = forwarded.find(operation => operation.url.includes('name=retained-runtime'))!.body
        if (state === 'foreign-owner') upstreamPrior.Labels['com.freshell.soul-id'] = 'foreign'
        if (state === 'changed-image') upstreamPrior.Image = 'sha256:other-approved-image'
        if (state === 'changed-host') await fs.writeFile(owner.hostBinaryPath, 'changed artifact')
        const result = await request('POST', '/v1.47/volumes/create', {
          Name: input.indexedFiles.volumeName, Driver: 'local', DriverOpts: indexedOptions, Labels: publisherLabels(input),
        })
        expect(result.status, JSON.stringify(instance.eventsSnapshot().slice(-3))).toBe(state === 'exited' ? 201 : 403)
        const published = forwarded.filter(operation => operation.url === '/v1.47/volumes/create')
        expect(published).toHaveLength(state === 'exited' ? 1 : 0)
      }, undefined, true)
    },
  )
  it('publishes a controller-authorized retained Claude candidate from both frozen generations', async () => {
    await withHttpBroker(async ({ directory, request, forwarded, broker: instance, setRuntimeRunning,
      clearCandidateVolumeInspection, replaceCandidateVolumeInspection }) => {
      const input = candidateAuthorization()
      const artifact = Buffer.from('retained candidate owned host')
      input.hostBinaryPath = path.join(directory, 'freshell-session-host')
      await fs.writeFile(input.hostBinaryPath, artifact)
      input.binarySha256 = createHash('sha256').update(artifact).digest('hex')
      input.stageRoot = path.join(directory, 'scenarios/scenario/control/provider-roots', input.generationId)
      instance.authorizeInitialProviderVolume({ ...sourceAuthorization(), hostBinaryPath: input.hostBinaryPath,
        binarySha256: input.binarySha256 })
      expect((await request('POST', '/v1.47/volumes/create', { Name: input.providerVolumeName, Driver: 'local', Labels: {
        'com.freshell.installation-id': input.installationId, 'com.freshell.soul-id': input.soulId,
        'freshell.input.reservation': input.reservationId, 'freshell.input.incarnation': 'incarnation-one',
        'freshell.input.intent': '1', 'freshell.input.daemon': input.daemonId,
        'freshell.input.image': input.imageRef, 'freshell.input.binary-sha256': input.binarySha256,
      } })).status).toBe(201)
      const priorRuntime = path.join(directory, 'r/scenario/incarnation-one')
      const actor = path.join(path.dirname(priorRuntime), 'souls',
        createHash('sha256').update(`${input.installationId}\0${input.soulId}`).digest('hex'), 'actor')
      const prior = JSON.parse(createBody([
        `${input.hostBinaryPath}:/runtime/freshell-session-host:ro`, `${priorRuntime}:/run/freshell:rw`,
        `${input.providerVolumeName}:/home/freshell/provider:rw`, '/workspace:/workspace:rw',
        `${actor}:/run/freshell-host-actor:rw`,
      ]).toString())
      prior.Labels['com.freshell.soul-id'] = input.soulId
      expect((await request('POST', '/v1.47/containers/create?name=retained-candidate-owner', prior)).status).toBe(201)
      const generationId = 'grant-55555555-5555-4555-8555-555555555555'
      input.retained = { generationId, stageRoot: path.join(path.dirname(input.stageRoot), generationId),
        configurationBinds: structuredClone(input.configurationBinds), resourceMounts: structuredClone(input.resourceMounts),
        attemptId: 'recovery-66666666-6666-4666-8666-666666666666' }
      const priorPublication = await publishControllerPreparation(directory, { ...input, ...input.retained }, input.reservationId, 'claude')
      instance.authorizePreparedInputs({ ...input, ...input.retained, incarnationId: 'incarnation-one', indexedSecretSources: [] })
      const published = await publishControllerPreparation(directory, input, '', 'claude')
      const capabilityPath = path.join(published.capabilities, `${input.generationId}.json`)
      const capability = JSON.parse(await fs.readFile(capabilityPath, 'utf8'))
      await fs.writeFile(capabilityPath, JSON.stringify({ ...capability,
        preparation: { phase: 'pending', priorGrantIds: [generationId] },
      }))
      delete (published.context.preparedInputs as any).initialAuthReservation
      const contextBytes = Buffer.from(JSON.stringify(published.context))
      const resultBytes = Buffer.from(JSON.stringify({ providerLaunchContext: published.context, providerSecretReferences: [] }))
      await fs.writeFile(path.join(published.metadata, 'prepared-context.json'), contextBytes)
      await fs.writeFile(path.join(published.metadata, 'prepared-result.json'), resultBytes)
      const binding = { version: 1, provider: 'claude', soulId: input.soulId, generationId: input.generationId,
        initialReservationId: null, registryAttemptId: input.retained.attemptId, priorGenerationId: generationId,
        intentRevision: 1, authoritySha256: 'a'.repeat(64), workspacePath: input.workspacePath, cwd: input.cwd,
        gitCommonDir: null, manifestSha256: published.context.preparedInputs.manifest.sha256,
        preparedContextSha256: createHash('sha256').update(contextBytes).digest('hex'),
        preparedResultSha256: createHash('sha256').update(resultBytes).digest('hex') }
      const bindingPath = path.join(published.metadata, 'claude-candidate-binding.json')
      await fs.writeFile(bindingPath, JSON.stringify(binding))
      const url = `/v1.47/volumes/freshell-claude-candidate-${input.requestId}`
      clearCandidateVolumeInspection()
      setRuntimeRunning(false)
      expect((await request('GET', url)).status, JSON.stringify(instance.eventsSnapshot().slice(-2))).toBe(404)
      // An absence probe grants no mutation ownership. The exact published
      // recovery attempt and both immutable stages still qualify creation.
      const volume = { Name: url.split('/').at(-1), Driver: 'local', DriverOpts: {}, Labels: candidateLabels(input) }
      const changedAttempt = structuredClone(volume)
      changedAttempt.Labels['com.freshell.source-recovery-attempt-id'] = 'recovery-77777777-7777-4777-8777-777777777777'
      expect((await request('POST', '/v1.47/volumes/create', changedAttempt)).status).toBe(403)
      setRuntimeRunning(true)
      const beforeRead = forwarded.length
      const candidateVolumes = instance.candidateVolumeNames()
      expect((await request('GET', url)).status).toBe(404)
      expect(forwarded.slice(beforeRead)).toMatchObject([{ method: 'GET', url }])
      expect(instance.candidateVolumeNames(), 'a read-only absence probe creates no candidate volume').toEqual(candidateVolumes)
      setRuntimeRunning(false)
      for (const changed of [
        { ...binding, soulId: 'foreign-soul' },
        { ...binding, priorGenerationId: input.generationId },
        { ...binding, preparedContextSha256: 'f'.repeat(64) },
      ]) {
        await fs.writeFile(bindingPath, JSON.stringify(changed))
        expect((await request('GET', url)).status).toBe(403)
        expect((await request('POST', '/v1.47/volumes/create', volume)).status).toBe(403)
      }
      await fs.writeFile(bindingPath, JSON.stringify(binding))
      const priorContext = path.join(priorPublication.metadata, 'prepared-context.json')
      await fs.writeFile(priorContext, JSON.stringify({ ...priorPublication.context,
        preparedInputs: { ...priorPublication.context.preparedInputs, generationId: input.generationId } }))
      expect((await request('GET', url)).status).toBe(403)
      await fs.writeFile(priorContext, priorPublication.contextBytes)
      replaceCandidateVolumeInspection()
      const foreign = await request('GET', url)
      expect(foreign.status).toBe(403)
      expect(foreign.body).not.toContain('PRIVATE_FOREIGN_CANDIDATE')
      clearCandidateVolumeInspection()
      expect((await request('GET', url)).status).toBe(404)
      expect((await request('POST', '/v1.47/volumes/create', volume)).status,
        JSON.stringify(instance.eventsSnapshot().slice(-2))).toBe(201)
      const name = 'freshell-claude-candidate-reader-11111111-1111-4111-8111-111111111111'
      expect((await request('POST', `/v1.47/containers/create?name=${name}`, candidateHelperBody(input, 'reader'))).status).toBe(201)
      expect((await request('POST', `/v1.47/containers/${helperId}/start`)).status).toBe(204)
      expect((await request('POST', `/v1.47/containers/${helperId}/wait?condition=not-running`)).status).toBe(200)
      expect((await request('DELETE', `/v1.47/containers/${helperId}?force=1`)).status).toBe(204)
      expect(forwarded.some(operation => operation.url.includes(name))).toBe(true)
    }, undefined, true)
  })
  it.each(['claude', 'kilroy'])('probes actual %s candidate absence before creation only with a qualified owned publication', async provider => {
    await withHttpBroker(async ({ directory, request, forwarded, broker: instance, replaceCandidateVolumeInspection, clearCandidateVolumeInspection }) => {
      const input = candidateAuthorization()
      const binary = Buffer.from('candidate absence host artifact')
      input.hostBinaryPath = path.join(directory, 'freshell-session-host')
      await fs.writeFile(input.hostBinaryPath, binary)
      input.binarySha256 = createHash('sha256').update(binary).digest('hex')
      input.stageRoot = path.join(directory, 'scenarios/scenario/control/provider-roots', input.generationId)
      const { metadata, context, contextBytes, resultBytes } = await publishControllerPreparation(directory, input, input.reservationId, 'claude')
      const binding = { version: 1, provider, soulId: input.soulId, generationId: input.generationId,
        initialReservationId: input.reservationId, intentRevision: 1, registryAttemptId: null,
        authoritySha256: createHash('sha256').update(JSON.stringify({ kind: 'initial_reservation', reservationId: input.reservationId })).digest('hex'), workspacePath: input.workspacePath, cwd: input.cwd,
        gitCommonDir: null,
        manifestSha256: context.preparedInputs.manifest.sha256,
        preparedContextSha256: createHash('sha256').update(contextBytes).digest('hex'),
        preparedResultSha256: createHash('sha256').update(resultBytes).digest('hex') }
      const publication = path.join(metadata, 'claude-candidate-binding.json')
      await fs.writeFile(publication, JSON.stringify(binding))
      const url = `/v1.47/volumes/freshell-claude-candidate-${input.requestId}`
      expect((await request('GET', url)).status).toBe(403)
      expect(instance.eventsSnapshot().at(-1)).toMatchObject({
        reason: 'candidate absence qualification unavailable at owner_capability',
      })
      instance.authorizeInitialProviderVolume({ ...sourceAuthorization(), hostBinaryPath: input.hostBinaryPath, binarySha256: input.binarySha256 })
      await fs.writeFile(publication, JSON.stringify({ ...binding, preparedResultSha256: 'f'.repeat(64) }))
      expect((await request('GET', url)).status).toBe(403)
      expect(instance.eventsSnapshot().at(-1)).toMatchObject({
        reason: 'candidate absence qualification unavailable at prepared_metadata',
      })
      expect(forwarded).toHaveLength(0)
      await fs.writeFile(publication, JSON.stringify(binding))
      await fs.writeFile(publication, JSON.stringify({ ...binding, authoritySha256: 'e'.repeat(64) }))
      expect((await request('GET', url)).status).toBe(403)
      expect(instance.eventsSnapshot().at(-1)).toMatchObject({
        reason: 'candidate absence qualification unavailable at authority_binding',
      })
      await fs.writeFile(publication, JSON.stringify({ ...binding, gitCommonDir: '../foreign' }))
      expect((await request('GET', url)).status).toBe(403)
      expect(instance.eventsSnapshot().at(-1)).toMatchObject({
        reason: 'candidate absence qualification unavailable at selected_target',
      })
      expect(forwarded).toHaveLength(0)
      await fs.writeFile(publication, JSON.stringify(binding))
      replaceCandidateVolumeInspection()
      const foreign = await request('GET', url)
      expect(foreign.status).toBe(403)
      expect(foreign.body).not.toContain('PRIVATE_FOREIGN_CANDIDATE')
      clearCandidateVolumeInspection()
      expect((await request('GET', url)).status).toBe(404)
      expect((await request('DELETE', url)).status).toBe(403)
      const malformed = url.replace(input.requestId, '11111111-1111-1111-1111-111111111111')
      expect((await request('GET', malformed)).status).toBe(403)
      expect(forwarded.every(operation => operation.method === 'GET')).toBe(true)
      const changed = { Name: url.split('/').at(-1), Driver: 'local', DriverOpts: {}, Labels: { foreign: 'owner' } }
      expect((await request('POST', '/v1.47/volumes/create', changed)).status).toBe(403)
      expect(forwarded.every(operation => operation.method === 'GET')).toBe(true)
    }, undefined, true)
  })
  it('probes candidate absence for a recovery publication only against its frozen retained generation', async () => {
    await withHttpBroker(async ({ directory, request, forwarded, broker: instance }) => {
      const prior = candidateAuthorization()
      const binary = Buffer.from('recovery candidate host artifact')
      prior.hostBinaryPath = path.join(directory, 'freshell-session-host')
      await fs.writeFile(prior.hostBinaryPath, binary)
      prior.binarySha256 = createHash('sha256').update(binary).digest('hex')
      prior.stageRoot = path.join(directory, 'scenarios/scenario/control/provider-roots', prior.generationId)
      instance.authorizeInitialProviderVolume({ ...sourceAuthorization(), hostBinaryPath: prior.hostBinaryPath, binarySha256: prior.binarySha256 })
      await publishControllerPreparation(directory, prior, prior.reservationId, 'claude')
      const capabilities = path.join(directory, 'scenarios/scenario/control/mcp-capabilities')
      await fs.writeFile(path.join(capabilities, `${prior.generationId}.json`), JSON.stringify({
        endpoint: 'http://127.0.0.1:1/api/managed-mcp', scope: 'synthetic-controller-scope', soulId: prior.soulId,
        incarnationId: 'incarnation-initial', expiresAt: Date.now() + 60_000, preparation: { phase: 'committed', priorGrantIds: [] },
      }))
      const attemptId = 'recovery-77777777-7777-4777-8777-777777777777'
      const candidate: ClaudeCandidateAuthorization = { ...prior,
        generationId: 'grant-55555555-5555-4555-8555-555555555555',
        requestId: '66666666-6666-4666-8666-666666666666',
        retained: { attemptId, generationId: prior.generationId, stageRoot: prior.stageRoot,
          configurationBinds: prior.configurationBinds, resourceMounts: prior.resourceMounts } }
      candidate.stageRoot = path.join(directory, 'scenarios/scenario/control/provider-roots', candidate.generationId)
      const { metadata, context, contextBytes, resultBytes } = await publishControllerPreparation(directory, candidate, null, 'claude')
      const pending = { endpoint: 'http://127.0.0.1:1/api/managed-mcp', scope: 'synthetic-controller-scope', soulId: candidate.soulId,
        incarnationId: null, expiresAt: Date.now() + 60_000, preparation: { phase: 'pending', priorGrantIds: [prior.generationId] } }
      const capability = path.join(capabilities, `${candidate.generationId}.json`)
      await fs.writeFile(capability, JSON.stringify(pending))
      const binding = { version: 1, provider: 'claude', soulId: candidate.soulId, generationId: candidate.generationId,
        initialReservationId: null, intentRevision: 1, registryAttemptId: attemptId, priorGenerationId: prior.generationId,
        authoritySha256: 'b'.repeat(64), workspacePath: candidate.workspacePath, cwd: candidate.cwd, gitCommonDir: null,
        manifestSha256: context.preparedInputs.manifest.sha256,
        preparedContextSha256: createHash('sha256').update(contextBytes).digest('hex'),
        preparedResultSha256: createHash('sha256').update(resultBytes).digest('hex') }
      const publication = path.join(metadata, 'claude-candidate-binding.json')
      const url = `/v1.47/volumes/freshell-claude-candidate-${candidate.requestId}`
      const refused = async (mutated: Record<string, unknown>, phase: string) => {
        await fs.writeFile(publication, JSON.stringify(mutated))
        expect((await request('GET', url)).status).toBe(403)
        expect(instance.eventsSnapshot().at(-1)).toMatchObject({
          reason: `candidate absence qualification unavailable at ${phase}`,
        })
      }
      await refused({ ...binding, registryAttemptId: 'recovery-not-a-uuid' }, 'owner_capability')
      await refused({ ...binding, priorGenerationId: candidate.generationId }, 'owner_capability')
      await refused({ ...binding, initialReservationId: prior.reservationId }, 'owner_capability')
      await fs.writeFile(capability, JSON.stringify({ ...pending, preparation: { phase: 'pending', priorGrantIds: [] } }))
      await refused(binding, 'owner_capability')
      await fs.writeFile(capability, JSON.stringify({ ...pending, incarnationId: 'incarnation-replacement' }))
      await refused(binding, 'owner_capability')
      await fs.writeFile(capability, JSON.stringify(pending))
      await refused({ ...binding, preparedResultSha256: 'f'.repeat(64) }, 'prepared_metadata')
      await refused({ ...binding, authoritySha256: 'not-a-digest' }, 'authority_binding')
      const priorContext = path.join(prior.stageRoot, '.freshell/prepared-context.json')
      const priorBytes = await fs.readFile(priorContext)
      const unrecorded = JSON.parse(priorBytes.toString())
      unrecorded.preparedInputs.initialAuthReservation = null
      await fs.writeFile(priorContext, JSON.stringify(unrecorded))
      await refused(binding, 'retained_generation')
      await fs.writeFile(priorContext, priorBytes)
      expect(forwarded).toHaveLength(0)

      await fs.writeFile(publication, JSON.stringify(binding))
      expect((await request('GET', url)).status).toBe(404)
      const create = { Name: `freshell-claude-candidate-${candidate.requestId}`, Driver: 'local', DriverOpts: {},
        Labels: candidateLabels(candidate) }
      expect((await request('POST', '/v1.47/volumes/create', create)).status).toBe(201)
      expect(forwarded.map(operation => `${operation.method} ${operation.url}`)).toEqual([
        `GET ${url}`, 'POST /v1.47/volumes/create',
      ])
    }, undefined, true)
  })
  it('cleans the exact registered failed-launch volume and retains changed or attached ownership', async () => {
    await withHttpBroker(async ({ directory }) => {
      const binary = Buffer.from('registered failed-launch artifact')
      const owner = { ...sourceAuthorization(), hostBinaryPath: path.join(directory, 'freshell-session-host'),
        binarySha256: createHash('sha256').update(binary).digest('hex') }
      await fs.writeFile(owner.hostBinaryPath, binary)
      const labels = {
        'com.freshell.installation-id': owner.installationId, 'com.freshell.soul-id': owner.soulId,
        'freshell.input.daemon': owner.daemonId, 'freshell.input.image': owner.imageRef,
        'freshell.input.binary-sha256': owner.binarySha256, 'freshell.input.intent': '1',
        'freshell.input.reservation': '11111111-1111-4111-8111-111111111111',
        'freshell.input.incarnation': 'incarnation-one',
      }
      let currentLabels = { ...labels }, daemon = owner.daemonId, attached = false, exists = true
      const removals: string[][] = []
      const run = (args: string[]): string => {
        if (args[0] === 'info') return daemon
        if (args[0] === 'container') return attached ? 'e'.repeat(64) : ''
        if (args[1] === 'ls') return exists ? owner.providerVolumeName : ''
        if (args[1] === 'inspect') return JSON.stringify({ Name: owner.providerVolumeName, Driver: 'local', Options: null, Labels: currentLabels })
        if (args[1] === 'rm') { removals.push(args); exists = false; return owner.providerVolumeName }
        throw new Error('unexpected cleanup command')
      }
      const captured = captureProviderParityVolumes([owner], run)
      currentLabels['freshell.input.incarnation'] = 'foreign'
      expect(() => cleanupProviderParityVolumes(captured, run)).toThrow()
      currentLabels = { ...labels }
      attached = true
      expect(() => cleanupProviderParityVolumes(captured, run)).toThrow()
      attached = false
      daemon = 'foreign'
      expect(() => cleanupProviderParityVolumes(captured, run)).toThrow()
      daemon = owner.daemonId
      expect(removals).toEqual([])
      expect(cleanupProviderParityVolumes(captured, run)).toEqual([owner.providerVolumeName])
      expect(removals).toEqual([['volume', 'rm', owner.providerVolumeName]])
      expect(exists).toBe(false)
    }, undefined, true)
  })
  it.each(['claude', 'kilroy'])('registers the exact owned published %s candidate before its ordinary volume request', async provider => {
    await withHttpBroker(async ({ request, forwarded, broker: instance, directory }) => {
      const input = candidateAuthorization()
      input.workspacePath = '/workspace/project'
      input.cwd = '/workspace/project/nested'
      input.configurationBinds[0].effectiveDestination = '/home/freshell/provider/.claude/settings.json'
      input.resourceMounts[0].effectiveDestination = '/home/freshell/provider/.claude/skills'
      input.hostBinaryPath = path.join(directory, 'freshell-session-host')
      const binary = Buffer.from('owned candidate host artifact')
      await fs.writeFile(input.hostBinaryPath, binary)
      input.binarySha256 = createHash('sha256').update(binary).digest('hex')
      input.stageRoot = path.join(directory, 'scenarios/scenario/control/provider-roots', input.generationId)
      instance.authorizeInitialProviderVolume({ ...sourceAuthorization(), hostBinaryPath: input.hostBinaryPath, binarySha256: input.binarySha256 })
      const { metadata, context, contextBytes, resultBytes } = await publishControllerPreparation(directory, input, input.reservationId, 'claude')
      await fs.writeFile(path.join(metadata, 'claude-candidate-binding.json'), JSON.stringify({
        version: 1, provider, soulId: input.soulId, generationId: input.generationId,
        initialReservationId: input.reservationId, intentRevision: 1, registryAttemptId: null,
        authoritySha256: createHash('sha256').update(JSON.stringify({ kind: 'initial_reservation', reservationId: input.reservationId })).digest('hex'),
        workspacePath: input.workspacePath, cwd: input.cwd, gitCommonDir: null,
        manifestSha256: context.preparedInputs.manifest.sha256,
        preparedContextSha256: createHash('sha256').update(contextBytes).digest('hex'),
        preparedResultSha256: createHash('sha256').update(resultBytes).digest('hex'),
      }))
      const volume = { Name: `freshell-claude-candidate-${input.requestId}`, Driver: 'local', DriverOpts: {}, Labels: candidateLabels(input) }
      const bindingPath = path.join(metadata, 'claude-candidate-binding.json')
      const originalBinding = await fs.readFile(bindingPath)
      for (const field of ['provider', 'soulId', 'generationId', 'initialReservationId', 'gitCommonDir', 'preparedContextSha256', 'preparedResultSha256', 'manifestSha256']) {
        const changed = JSON.parse(originalBinding.toString())
        changed[field] = 'foreign'
        await fs.writeFile(bindingPath, JSON.stringify(changed))
        expect((await request('POST', '/v1.47/volumes/create', volume)).status, field).toBe(403)
        expect(forwarded).toHaveLength(0)
      }
      await fs.writeFile(bindingPath, originalBinding)
      for (const destination of ['/home/freshell/provider-sibling/.claude/skills', '/outside/skills', '/home/freshell/provider/.claude/projects']) {
        const changed = structuredClone(input)
        changed.resourceMounts[0].effectiveDestination = destination
        expect(() => instance.authorizeClaudeCandidate(changed), destination).toThrow()
      }
      expect((await request('POST', '/v1.47/volumes/create', volume)).status, JSON.stringify(instance.eventsSnapshot())).toBe(201)
      const before = forwarded.length
      const changed = structuredClone(volume)
      changed.Labels['com.freshell.soul-id'] = 'foreign'
      expect((await request('POST', '/v1.47/volumes/create', changed)).status).toBe(403)
      expect(forwarded).toHaveLength(before)
    }, undefined, true)
  })
  it.each(['claude', 'kilroy'].flatMap(provider => ['candidate', 'retained', 'workload'].map(consumer => ({ provider, consumer }))))('carries published $provider ancestor policy and imported files into the $consumer reader', async ({ provider, consumer }) => {
    await withHttpBroker(async ({ request, forwarded, broker: instance, directory }) => {
      const input = { ...candidateAuthorization(), gitCommonDir: '/workspace-git' }
      input.configurationBinds[0].effectiveDestination = '/workspace/.claude/settings.json'
      input.resourceMounts = ['/home/operator/.claude/CLAUDE.md', '/home/operator/.codex/AGENTS.md'].map((effectiveDestination, index) => ({
        stageRelativePath: `.freshell/resource-units/root-${index}/source`,
        providerRelativePath: `.freshell/provider-roots/root-${index}/source`, effectiveDestination, kind: 'file',
      }))
      input.hostBinaryPath = path.join(directory, 'freshell-session-host')
      const binary = Buffer.from('published ancestor policy reader')
      await fs.writeFile(input.hostBinaryPath, binary)
      input.binarySha256 = createHash('sha256').update(binary).digest('hex')
      input.stageRoot = path.join(directory, 'scenarios/scenario/control/provider-roots', input.generationId)
      instance.authorizeInitialProviderVolume({ ...sourceAuthorization(), hostBinaryPath: input.hostBinaryPath, binarySha256: input.binarySha256 })
      const { metadata, context, contextBytes, resultBytes } = await publishControllerPreparation(directory, input, input.reservationId, 'claude')
      await fs.writeFile(path.join(metadata, 'claude-candidate-binding.json'), JSON.stringify({
        version: 1, provider, soulId: input.soulId, generationId: input.generationId,
        initialReservationId: input.reservationId, intentRevision: 1, registryAttemptId: null,
        authoritySha256: createHash('sha256').update(JSON.stringify({ kind: 'initial_reservation', reservationId: input.reservationId })).digest('hex'),
        workspacePath: input.workspacePath, cwd: input.cwd, gitCommonDir: input.gitCommonDir,
        manifestSha256: context.preparedInputs.manifest.sha256,
        preparedContextSha256: createHash('sha256').update(contextBytes).digest('hex'),
        preparedResultSha256: createHash('sha256').update(resultBytes).digest('hex'),
      }))
      const volumeName = `freshell-claude-candidate-${input.requestId}`
      expect((await request('GET', `/v1.47/volumes/${volumeName}`)).status).toBe(404)
      expect((await request('POST', '/v1.47/volumes/create', { Name: volumeName, Driver: 'local', DriverOpts: {}, Labels: candidateLabels(input) })).status).toBe(201)
      let body: any, name: string
      if (consumer === 'candidate') {
        body = candidateHelperBody(input, 'reader')
        name = 'freshell-claude-candidate-reader-11111111-1111-4111-8111-111111111111'
      } else if (consumer === 'retained') {
        body = sourceHelperBody()
        body.HostConfig.Mounts[0].Source = input.hostBinaryPath
        body.Labels['com.freshell.source-binary-sha256'] = input.binarySha256
        body.HostConfig.Tmpfs = {}
        body.HostConfig.Mounts.push(
          { Type: 'bind', Source: input.gitCommonDir, Target: input.gitCommonDir, ReadOnly: true },
          { Type: 'volume', Source: input.providerVolumeName, Target: '/home/freshell/provider', ReadOnly: true, VolumeOptions: { NoCopy: true } },
          ...input.configurationBinds.map(bind => ({ Type: 'bind', Source: path.join(input.stageRoot, bind.sourceRelativePath), Target: bind.effectiveDestination, ReadOnly: true })),
          ...input.resourceMounts.map(mount => ({ Type: 'volume', Source: input.providerVolumeName, Target: mount.effectiveDestination, ReadOnly: true, VolumeOptions: { NoCopy: true, Subpath: mount.providerRelativePath } })),
        )
        name = sourceName
      } else {
        const prepared = { ...input, incarnationId: 'incarnation-one', indexedSecretSources: [] }
        for (const mutation of ['unit', 'writable', 'generation', 'owner']) {
          const changed = structuredClone(prepared)
          if (mutation === 'unit') changed.resourceMounts[0].providerRelativePath = '.freshell/provider-roots/foreign/source'
          if (mutation === 'writable') (changed.resourceMounts[0] as { writable?: boolean }).writable = true
          if (mutation === 'generation') changed.generationId = 'grant-55555555-5555-4555-8555-555555555555'
          if (mutation === 'owner') changed.soulId = 'foreign-soul'
          expect(() => instance.authorizePreparedInputs(changed), mutation).toThrow()
        }
        expect((await request('POST', '/v1.47/volumes/create', { Name: input.providerVolumeName, Driver: 'local', Labels: {
          'com.freshell.installation-id': input.installationId, 'com.freshell.soul-id': input.soulId,
          'freshell.input.reservation': input.reservationId, 'freshell.input.incarnation': 'incarnation-one', 'freshell.input.intent': '1',
          'freshell.input.daemon': input.daemonId, 'freshell.input.image': input.imageRef, 'freshell.input.binary-sha256': input.binarySha256,
        } })).status).toBe(201)
        const runtimeBinds = ordinaryBinds.map(bind => bind.replace('/tmp/owned/freshell-session-host', input.hostBinaryPath)
          .replace('/tmp/owned/r/scenario/x/incarnation-one', path.join(directory, 'r/scenario/x/incarnation-one'))
          .replace(providerVolume, input.providerVolumeName))
        const actor = path.join(directory, 'r/scenario/x/souls', createHash('sha256').update(`${input.installationId}\0${input.soulId}`).digest('hex'), 'actor')
        body = JSON.parse(createBody([...runtimeBinds, `${actor}:/run/freshell-host-actor:rw`]).toString())
        body.Labels['com.freshell.soul-id'] = input.soulId
        body.HostConfig.Mounts = [
          ...input.configurationBinds.map(bind => ({ Type: 'bind', Source: path.join(input.stageRoot, bind.sourceRelativePath), Target: bind.effectiveDestination, ReadOnly: true })),
          ...input.resourceMounts.map(mount => ({ Type: 'volume', Source: input.providerVolumeName, Target: mount.effectiveDestination, ReadOnly: true, VolumeOptions: { NoCopy: true, Subpath: mount.providerRelativePath } })),
        ]
        name = 'selected-ancestor-runtime'
      }
      const before = forwarded.length
      for (const mutation of ['source', 'target', 'writable']) {
        const changed = structuredClone(body)
        const policy = changed.HostConfig.Mounts.find((mount: any) => mount.Target === '/home/operator/.claude/CLAUDE.md')
        if (mutation === 'source') policy.Source = 'foreign-volume'
        if (mutation === 'target') policy.Target = '/outside/unselected-policy'
        if (mutation === 'writable') policy.ReadOnly = false
        expect((await request('POST', `/v1.47/containers/create?name=${name}`, changed)).status, `${consumer}/${mutation}`).toBe(403)
        expect(forwarded).toHaveLength(before)
      }
      expect((await request('POST', `/v1.47/containers/create?name=${name}`, body)).status, JSON.stringify(instance.eventsSnapshot().slice(-3))).toBe(201)
      const id = consumer === 'workload' ? ownedId : helperId
      expect((await request('POST', `/v1.47/containers/${id}/start`)).status).toBe(204)
      if (consumer !== 'workload') {
        expect((await request('POST', `/v1.47/containers/${id}/wait?condition=not-running`)).status).toBe(200)
        expect((await request('DELETE', `/v1.47/containers/${id}?force=1`)).status).toBe(204)
        expect((await request('GET', `/v1.47/containers/${id}/json`)).status).toBe(404)
      }
    }, { gitWorkspace: '/workspace-git' }, true)
  })
  it('registers the exact owned published preparation before its indexed volume request', async () => {
    await withHttpBroker(async ({ request, forwarded, broker: instance, directory }) => {
      const source = sourceAuthorization()
      const hostBinaryPath = path.join(directory, 'freshell-session-host')
      const binary = Buffer.from('owned fixture host artifact')
      await fs.writeFile(hostBinaryPath, binary)
      const owner = { ...source, hostBinaryPath, binarySha256: createHash('sha256').update(binary).digest('hex') }
      instance.authorizeInitialProviderVolume(owner)
      const generationId = 'grant-44444444-4444-4444-8444-444444444444'
      const input = { ...publisherAuthorization(), soulId: owner.soulId, generationId, hostBinaryPath, providerVolumeName: owner.providerVolumeName,
        stageRoot: path.join(directory, 'scenarios/scenario/control/provider-roots', generationId),
        configurationBinds: [{ sourceRelativePath: '.freshell/templates/codex-0', effectiveDestination: '/home/freshell/provider/.codex/config.toml' }],
        resourceMounts: [
          { providerRelativePath: '.freshell/provider-roots/root-0', effectiveDestination: '/home/freshell/provider/.codex/skills', kind: 'directory' as const },
          { providerRelativePath: '.freshell/provider-roots/root-1/source', effectiveDestination: '/home/freshell/provider/.codex/README.md', kind: 'file' as const },
          { providerRelativePath: '.freshell/provider-roots/root-2/source', effectiveDestination: '/home/freshell/provider/.codex/generated.txt', kind: 'file' as const, writable: true },
        ],
        indexedFiles: { volumeName: `freshell-inputs-${createHash('sha256').update(`${owner.soulId}\0${generationId}`).digest('hex').slice(0, 24)}`, aliases: [] },
        indexedSecretSources: [] }
      const { metadata, capabilities, context } = await publishControllerPreparation(directory, input, '11111111-1111-4111-8111-111111111111', 'codex')
      const initial = { Name: owner.providerVolumeName, Driver: 'local', Labels: {
        'com.freshell.installation-id': owner.installationId, 'com.freshell.soul-id': owner.soulId,
        'freshell.input.reservation': context.preparedInputs.initialAuthReservation,
        'freshell.input.incarnation': input.incarnationId, 'freshell.input.intent': '1',
        'freshell.input.daemon': owner.daemonId, 'freshell.input.image': owner.imageRef,
        'freshell.input.binary-sha256': owner.binarySha256,
      } }
      expect((await request('POST', '/v1.47/volumes/create', initial)).status).toBe(201)
      const volume = { Name: input.indexedFiles.volumeName, Driver: 'local', DriverOpts: indexedOptions, Labels: publisherLabels(input) }
      const capabilityPath = path.join(capabilities, `${generationId}.json`)
      const capabilityBytes = await fs.readFile(capabilityPath)
      for (const field of ['soulId', 'incarnationId']) {
        const changed = JSON.parse(capabilityBytes.toString())
        changed[field] = 'foreign'
        await fs.writeFile(capabilityPath, JSON.stringify(changed))
        expect((await request('POST', '/v1.47/volumes/create', volume)).status, field).toBe(403)
        expect(forwarded).toHaveLength(1)
      }
      await fs.writeFile(capabilityPath, capabilityBytes)
      const resultPath = path.join(metadata, 'prepared-result.json')
      const resultBytes = await fs.readFile(resultPath)
      for (const field of ['generationId', 'initialAuthReservation', 'manifest']) {
        const changed = JSON.parse(resultBytes.toString())
        changed.providerLaunchContext.preparedInputs[field] = 'foreign'
        await fs.writeFile(resultPath, JSON.stringify(changed))
        expect((await request('POST', '/v1.47/volumes/create', volume)).status, field).toBe(403)
        expect(forwarded).toHaveLength(1)
      }
      await fs.writeFile(resultPath, Buffer.alloc(1024 * 1024 + 1, 32))
      expect((await request('POST', '/v1.47/volumes/create', volume)).status).toBe(403)
      await fs.rm(resultPath)
      await fs.symlink(path.join(metadata, 'prepared-context.json'), resultPath)
      expect((await request('POST', '/v1.47/volumes/create', volume)).status).toBe(403)
      await fs.rm(resultPath)
      await fs.writeFile(resultPath, resultBytes)
      await fs.writeFile(hostBinaryPath, 'changed owned artifact')
      expect((await request('POST', '/v1.47/volumes/create', volume)).status).toBe(403)
      await fs.writeFile(hostBinaryPath, binary)
      expect(forwarded).toHaveLength(1)
      const invalidContext = structuredClone(context)
      invalidContext.preparedInputs.configBinds[0].sourceRelativePath = '.freshell/PRIVATE_TEMPLATE_SENTINEL'
      await fs.writeFile(path.join(metadata, 'prepared-context.json'), JSON.stringify(invalidContext))
      await fs.writeFile(resultPath, JSON.stringify({ providerLaunchContext: invalidContext, providerSecretReferences: [] }))
      expect((await request('POST', '/v1.47/volumes/create', volume)).status).toBe(403)
      expect(instance.eventsSnapshot().slice(-2)[0]).toMatchObject({
        reason: 'fixture publication unavailable at prepared_authorization: invalid_template_source',
      })
      expect(JSON.stringify(instance.eventsSnapshot())).not.toContain('PRIVATE_TEMPLATE_SENTINEL')
      await fs.writeFile(path.join(metadata, 'prepared-context.json'), JSON.stringify(context))
      await fs.writeFile(resultPath, resultBytes)
      for (const destination of ['/home/freshell/provider-sibling/.codex/skills', '/outside/skills', '/home/freshell/provider/.codex/sessions']) {
        const changed = structuredClone(input)
        changed.resourceMounts[0].effectiveDestination = destination
        expect(() => instance.authorizePreparedInputs(changed), destination).toThrow()
      }
      expect((await request('POST', '/v1.47/volumes/create', volume)).status, JSON.stringify(instance.eventsSnapshot().slice(-4))).toBe(201)
      const registered = [...(instance as unknown as { preparedInputs: Map<string, PreparedInputAuthorization> }).preparedInputs.values()]
        .find(prepared => prepared.generationId === generationId)
      expect(registered?.resourceMounts).toEqual(input.resourceMounts)
      const runtimeDir = path.join(directory, 'r/scenario/x/incarnation-one')
      const runtimeBinds = ordinaryBinds.map(bind => bind.replace('/tmp/owned/freshell-session-host', owner.hostBinaryPath)
        .replace('/tmp/owned/r/scenario/x/incarnation-one', runtimeDir).replace(providerVolume, owner.providerVolumeName))
      const runtimeActorKey = createHash('sha256').update(`${owner.installationId}\0${owner.soulId}`).digest('hex')
      const runtimeActorBind = `${path.join(directory, 'r/scenario/x/souls', runtimeActorKey, 'actor')}:/run/freshell-host-actor:rw`
      const runtime = JSON.parse(createBody([...runtimeBinds, runtimeActorBind]).toString())
      runtime.Labels['com.freshell.soul-id'] = owner.soulId
      runtime.HostConfig.Mounts = [
        ...registered!.configurationBinds.map(bind => ({ Type: 'bind', Source: path.join(input.stageRoot, bind.sourceRelativePath),
          Target: bind.effectiveDestination, ReadOnly: true })),
        ...registered!.resourceMounts.map(mount => ({ Type: 'volume', Source: owner.providerVolumeName,
          Target: mount.effectiveDestination, ReadOnly: mount.kind === 'file' && mount.writable !== true,
          VolumeOptions: { NoCopy: true, Subpath: mount.providerRelativePath } })),
      ]
      const writableIndex = runtime.HostConfig.Mounts.findIndex((mount: any) => mount.Target === '/home/freshell/provider/.codex/generated.txt')
      const directoryIndex = runtime.HostConfig.Mounts.findIndex((mount: any) => mount.Target === '/home/freshell/provider/.codex/skills')
      const ordinaryFileIndex = runtime.HostConfig.Mounts.findIndex((mount: any) => mount.Target === '/home/freshell/provider/.codex/README.md')
      expect([writableIndex, directoryIndex, ordinaryFileIndex].every((index: number) => index >= 0)).toBe(true)
      expect((await request('POST', '/v1.47/containers/create?name=registered-writable-resource', runtime)).status,
        JSON.stringify(instance.eventsSnapshot().slice(-4))).toBe(201)
      for (const [name, index, readOnly] of [
        ['writable-file-made-readonly', writableIndex, true],
        ['directory-made-readonly', directoryIndex, true],
        ['ordinary-file-made-writable', ordinaryFileIndex, false],
      ] as const) {
        const changed = structuredClone(runtime)
        changed.HostConfig.Mounts[index].ReadOnly = readOnly
        const before = forwarded.length
        expect((await request('POST', `/v1.47/containers/create?name=${name}`, changed)).status, name).toBe(403)
        expect(forwarded).toHaveLength(before)
      }
      const before = forwarded.length
      for (const mutation of ['owner', 'generation', 'permissions', 'volume']) {
        const changed = structuredClone(volume)
        if (mutation === 'owner') changed.Labels['com.freshell.soul-id'] = 'foreign'
        if (mutation === 'generation') changed.Labels['com.freshell.input-generation'] = 'grant-foreign'
        if (mutation === 'permissions') changed.DriverOpts.o = 'size=64m,mode=0755'
        if (mutation === 'volume') changed.Name = `freshell-inputs-${'f'.repeat(24)}`
        expect((await request('POST', '/v1.47/volumes/create', changed)).status, mutation).toBe(403)
        expect(forwarded).toHaveLength(before)
      }
    }, undefined, true)
  })
  it('registers each parity request before its first volume observation while retaining foreign denials', async () => {
    await withHttpBroker(async ({ request, forwarded, broker: instance }) => {
      const { soulId: _soulId, providerVolumeName: _volume, ...source } = sourceAuthorization()
      const owner = authorizeProviderParityRequest(instance, source, 'provider-parity-codex-exact-request')
      expect(instance.receipts()).toEqual([])
      expect((await request('GET', `/v1.47/volumes/${owner.providerVolumeName}`)).status).toBe(200)
      expect(forwarded).toHaveLength(1)
      const denied = [
        ['GET', `/v1.47/volumes/freshell-provider-${'f'.repeat(24)}`],
        ['GET', `/v1.47/volumes/${owner.providerVolumeName}?foreign=1`],
        ['DELETE', `/v1.47/volumes/${owner.providerVolumeName}`],
        ['POST', '/v1.47/volumes/create'],
      ]
      for (const [method, url] of denied) {
        expect((await request(method, url)).status).toBe(403)
        expect(forwarded).toHaveLength(1)
      }
      expect(() => instance.authorizeInitialProviderVolume({ ...owner, soulId: 'foreign' })).toThrow()
      expect(() => instance.authorizeInitialProviderVolume({ ...owner, daemonId: 'foreign' })).toThrow()
      expect(() => instance.authorizeInitialProviderVolume({ ...owner, binarySha256: 'b'.repeat(64) })).toThrow()
    })
  })
  it('registers a fresh-agent parity request under its fresh soul, distinct from a terminal soul for the same request', async () => {
    await withHttpBroker(async ({ request, forwarded, broker: instance }) => {
      const { soulId: _soulId, providerVolumeName: _volume, ...source } = sourceAuthorization()
      const requestId = 'fresh-parity-claude-exact-request'
      const fresh = authorizeFreshAgentParityRequest(instance, source, 'claude', requestId)
      const terminal = authorizeProviderParityRequest(instance, source, requestId)
      expect(fresh.soulId).toMatch(/^soul-fresh-claude-[a-f0-9]{32}$/)
      expect(fresh.soulId.slice(-32)).toBe(terminal.soulId.slice(-32))
      expect(fresh.providerVolumeName).not.toBe(terminal.providerVolumeName)
      expect(instance.receipts()).toEqual([])
      expect((await request('GET', `/v1.47/volumes/${fresh.providerVolumeName}`)).status).toBe(200)
      expect((await request('GET', `/v1.47/volumes/${terminal.providerVolumeName}`)).status).toBe(200)
      expect(forwarded).toHaveLength(2)
    })
  })
  it('observes and creates only the explicitly reserved initial soul volume before any workload receipt',async()=>{
    await withHttpBroker(async ({request,forwarded,broker:instance})=>{
      const installationId='installation-one',soulId='soul-initial';
      const providerVolumeName=`freshell-provider-${createHash('sha256').update(`${installationId}\0${soulId}`).digest('hex').slice(0,24)}`;
      const authorization={installationId,soulId,providerVolumeName,imageRef:'sha256:fixture-image',hostBinaryPath:'/tmp/owned/freshell-session-host',binarySha256:'a'.repeat(64),daemonId:'fixture-daemon'};
      instance.authorizeInitialProviderVolume(authorization);
      expect((await request('GET',`/v1.47/volumes/${providerVolumeName}`)).status).toBe(200);
      const body={Name:providerVolumeName,Driver:'local',Labels:{
        'com.freshell.installation-id':installationId,'com.freshell.soul-id':soulId,
        'freshell.input.reservation':'11111111-1111-4111-8111-111111111111',
        'freshell.input.incarnation':'incarnation-initial','freshell.input.intent':'1',
        'freshell.input.daemon':authorization.daemonId,'freshell.input.image':authorization.imageRef,
        'freshell.input.binary-sha256':authorization.binarySha256,
      }};
      expect((await request('POST','/v1.47/volumes/create',body)).status).toBe(201);
      const before=forwarded.length;
      for (const mutate of [
        (value:any)=>value.Name='freshell-provider-'+ 'f'.repeat(24),
        (value:any)=>value.DriverOpts={type:'tmpfs'},
        (value:any)=>value.Labels['freshell.input.daemon']='changed',
        (value:any)=>value.Labels['freshell.input.binary-sha256']='b'.repeat(64),
        (value:any)=>value.Labels['freshell.input.reservation']='arbitrary',
      ]) {
        const changed=structuredClone(body);mutate(changed);
        expect((await request('POST','/v1.47/volumes/create',changed)).status).toBe(403);
        expect(forwarded).toHaveLength(before);
      }
    });
  });
  it('allows the fixed owned mountpoint helper before workload creation and refuses extra authority',async()=>{
    await withHttpBroker(async ({request,forwarded,broker:instance})=>{
      const input=publisherAuthorization();instance.authorizePreparedInputs(input);
      const name='freshell-mountpoints-11111111-1111-4111-8111-111111111111';
      const body=publisherBody(input);
      body.User='0:0';body.Cmd=['prepare-provider-mountpoints'];
      body.Labels={'com.freshell.installation-id':input.installationId,'com.freshell.soul-id':input.soulId,'com.freshell.incarnation-id':input.incarnationId};
      body.HostConfig.CapAdd=['CHOWN','SETGID','SETUID'];
      body.HostConfig.Mounts[1]={Type:'volume',Source:input.providerVolumeName,Target:'/home/freshell/provider',ReadOnly:false,VolumeOptions:{NoCopy:true}};
      const wrongEnvironment=structuredClone(body);
      wrongEnvironment.Env=['PATH=PRIVATE_MOUNTPOINT_SENTINEL'];
      expect((await request('POST',`/v1.47/containers/create?name=${name}`,wrongEnvironment)).status).toBe(403);
      expect(instance.eventsSnapshot().at(-1)?.reason).toBe('mountpoint helper unavailable at environment');
      expect(JSON.stringify(instance.eventsSnapshot())).not.toContain('PRIVATE_MOUNTPOINT_SENTINEL');
      expect(forwarded).toHaveLength(0);
      expect((await request('POST',`/v1.47/containers/create?name=${name}`,body)).status).toBe(201);
      const before=forwarded.length;
      for (const [phase, mutate] of [
        ['limits_authority', (value:any)=>value.HostConfig.CapAdd.push('DAC_OVERRIDE')],
        ['identity_argv', (value:any)=>value.Cmd.push('/outside')],
        ['mounts', (value:any)=>value.HostConfig.Mounts[1].Source='freshell-provider-ffffffffffffffffffffffff'],
        ['mounts', (value:any)=>value.HostConfig.Mounts[1].VolumeOptions.NoCopy=false],
        ['mount_count', (value:any)=>value.HostConfig.Mounts.push({Type:'bind',Source:'/operator-home',Target:'/outside',ReadOnly:false})],
        ['owner', (value:any)=>value.Labels['com.freshell.soul-id']='foreign'],
        ['image', (value:any)=>value.Image='foreign-image'],
        ['labels', (value:any)=>value.Labels['extra']='PRIVATE_LABEL_SENTINEL'],
      ] as const) {
        const changed=structuredClone(body);mutate(changed);
        expect((await request('POST',`/v1.47/containers/create?name=${name.replace('111111111111','222222222222')}`,changed)).status).toBe(403);
        expect(instance.eventsSnapshot().at(-1)?.reason).toBe(`mountpoint helper unavailable at ${phase}`);
        expect(forwarded).toHaveLength(before);
      }
      expect(JSON.stringify(instance.eventsSnapshot())).not.toContain('PRIVATE_LABEL_SENTINEL');
      expect((await request('POST',`/v1.47/containers/${helperId}/start`)).status).toBe(204);
      expect((await request('POST',`/v1.47/containers/${helperId}/wait?condition=not-running`)).status).toBe(200);
      expect((await request('DELETE',`/v1.47/containers/${helperId}?force=1`)).status).toBe(204);
    });
  });
  it('preserves exact name ownership on lost publisher acknowledgement and refuses replacement-helper cleanup',async()=>{
    await withHttpBroker(async({request,forwarded,broker:instance,loseHelperAck,replaceHelperInspection})=>{
      const input=publisherAuthorization();instance.authorizePreparedInputs(input);
      const volume={Name:input.indexedFiles!.volumeName,Driver:'local',DriverOpts:indexedOptions,Labels:publisherLabels(input)};
      expect((await request('POST','/v1.47/volumes/create',volume)).status).toBe(201);
      const name=`${volume.Name}-publisher`;
      loseHelperAck();
      expect((await request('POST',`/v1.47/containers/create?name=${name}`,publisherBody(input))).status).toBe(503);
      expect((await request('GET',`/v1.47/containers/${name}/json`)).status).toBe(200);
      replaceHelperInspection();
      expect((await request('DELETE',`/v1.47/containers/${name}?force=1`)).status).toBe(403);
      expect(forwarded.filter((request)=>request.method==='DELETE')).toEqual([]);
    });
  });
  it('retires only the exact stopped receipt and never forces a live or foreign workload',async()=>{
    await withHttpBroker(async({request,forwarded,setRuntimeRunning})=>{
      expect((await request('POST','/v1.47/containers/create?name=owned-runtime',createBody([...ordinaryBinds,actorBind]))).status).toBe(201);
      const before=forwarded.length;
      expect((await request('DELETE',`/v1.47/containers/${ownedId}?force=1`)).status).toBe(403);
      expect((await request('DELETE',`/v1.47/containers/${'f'.repeat(64)}?force=0`)).status).toBe(403);
      expect(forwarded).toHaveLength(before);
      setRuntimeRunning(true);
      expect((await request('DELETE',`/v1.47/containers/${ownedId}?force=0`)).status).toBe(403);
      expect(forwarded.filter(value=>value.method==='DELETE')).toEqual([]);
      setRuntimeRunning(false);
      expect((await request('DELETE',`/v1.47/containers/${ownedId}?force=0`)).status).toBe(204);
      expect(forwarded.filter(value=>value.method==='DELETE').map(value=>value.url)).toEqual([`/v1.47/containers/${ownedId}?force=0`]);
    });
  });
  it('fails once at the indexed population boundary before forwarding any workload creation',async()=>{
    await withHttpBroker(async({request,forwarded,broker:instance})=>{
      const input=publisherAuthorization();instance.authorizePreparedInputs(input);
      expect((await request('POST','/v1.47/volumes/create',{Name:input.indexedFiles!.volumeName,Driver:'local',DriverOpts:indexedOptions,Labels:publisherLabels(input)})).status).toBe(201);
      expect((await request('POST',`/v1.47/containers/create?name=${input.indexedFiles!.volumeName}-publisher`,publisherBody(input))).status).toBe(201);
      const body=JSON.parse(createBody([...ordinaryBinds,actorBind]).toString());
      body.HostConfig.Mounts=[{Type:'volume',Source:input.indexedFiles!.volumeName,Target:'/workspace/input',ReadOnly:true,VolumeOptions:{NoCopy:true,Subpath:'files/source-0'}},{Type:'volume',Source:input.indexedFiles!.volumeName,Target:'/run/freshell-secrets/provider-0',ReadOnly:true,VolumeOptions:{NoCopy:true,Subpath:'files/source-0'}}];
      instance.failNextInputPublicationBeforeCreate();const before=forwarded.length;
      expect((await request('POST','/v1.47/containers/create?name=owned-runtime',body)).status).toBe(503);expect(forwarded).toHaveLength(before);
      expect((await request('POST','/v1.47/containers/create?name=owned-runtime-retry',body)).status).toBe(201);
      expect((await request('DELETE',`/v1.47/containers/${helperId}?force=1`)).status).toBe(204);
      expect((await request('GET',`/v1.47/containers/${helperId}/json`)).status).toBe(404);
      expect((await request('POST',`/v1.47/containers/create?name=${input.indexedFiles!.volumeName}-publisher`,publisherBody(input))).status).toBe(201);
      expect(instance.eventsSnapshot().filter(value=>value.decision==='inject_failure')).toHaveLength(1);
    });
  });
  it('allows only exact generation users and soul-scoped indexed inventories for cold reconciliation',async()=>{
    await withHttpBroker(async({request,forwarded,broker:instance})=>{
      const input=publisherAuthorization();instance.authorizePreparedInputs(input);
      const users=(volume:string)=>`/v1.47/containers/json?all=1&filters=${encodeURIComponent(JSON.stringify({volume:[volume]}))}`;
      const inventory=(soul:string)=>`/v1.47/volumes?filters=${encodeURIComponent(JSON.stringify({label:['com.freshell.managed-inputs=true',`com.freshell.installation-id=${input.installationId}`,`com.freshell.soul-id=${soul}`]}))}`;
      const before=forwarded.length;
      for(const url of ['/v1.47/containers/json?all=1','/v1.47/volumes',users('freshell-inputs-ffffffffffffffffffffffff'),inventory('foreign'),users(input.indexedFiles!.volumeName)+'&limit=100',inventory(input.soulId)+'&filters=%7B%7D']) {
        expect((await request('GET',url)).status).toBe(403);expect(forwarded).toHaveLength(before);
      }
      expect((await request('GET',users(input.indexedFiles!.volumeName))).status).toBe(200);
      expect((await request('GET',inventory(input.soulId))).status).toBe(200);
      expect(forwarded.slice(before).map(value=>value.url)).toEqual([users(input.indexedFiles!.volumeName),inventory(input.soulId)]);
    });
  });
  it('limits tmpfs and publisher operations to the exact preparation and refuses extra host access',async()=>{
    await withHttpBroker(async({request,forwarded,broker:instance})=>{
      const input=publisherAuthorization();
      instance.authorizePreparedInputs(input);
      const volume={Name:input.indexedFiles!.volumeName,Driver:'local',DriverOpts:indexedOptions,Labels:publisherLabels(input)};
      const invalid=structuredClone(volume);invalid.DriverOpts.o='size=128m';
      expect((await request('POST','/v1.47/volumes/create',invalid)).status).toBe(403);
      expect(forwarded).toHaveLength(0);
      expect((await request('POST','/v1.47/volumes/create',volume)).status).toBe(201);
      const name=`${volume.Name}-publisher`;
      const body=publisherBody(input);
      const before=forwarded.length;
      for (const mutation of ['devices','socket','volume','uid','network','credentials','argv','capabilities','labels']) {
        const changed=structuredClone(body);
        if (mutation==='devices') changed.HostConfig.Devices=[{PathOnHost:'/dev/foreign',PathInContainer:'/dev/foreign',CgroupPermissions:'rwm'}];
        if (mutation==='socket') changed.HostConfig.Mounts[2].Source='/var/run/docker.sock';
        if (mutation==='volume') changed.HostConfig.Mounts[1].Source=providerVolume;
        if (mutation==='uid') changed.User='0:0';
        if (mutation==='network') changed.HostConfig.NetworkMode='host';
        if (mutation==='credentials') changed.Env=['API_KEY=PRIVATE_VALUE'];
        if (mutation==='argv') changed.Cmd.push('arbitrary-command');
        if (mutation==='capabilities') changed.HostConfig.CapAdd=['SYS_ADMIN'];
        if (mutation==='labels') changed.Labels['com.freshell.incarnation-id']='foreign';
        expect((await request('POST',`/v1.47/containers/create?name=${name}`,changed)).status,mutation).toBe(403);
        expect(forwarded).toHaveLength(before);
      }
      expect((await request('POST',`/v1.47/containers/create?name=${name}`,body)).status).toBe(201);
      expect((await request('POST',`/v1.47/containers/${helperId}/start`)).status).toBe(204);
      const afterStart=forwarded.length;
      for (const url of [`/v1.47/containers/${helperId}/logs?stdout=1`, `/v1.47/containers/${helperId}/exec`, `/v1.47/containers/${ownedId}/start`, '/v1.47/volumes/freshell-inputs-ffffffffffffffffffffffff']) {
        expect((await request('GET',url)).status).toBe(403);
        expect(forwarded).toHaveLength(afterStart);
      }
      expect((await request('GET',`/v1.47/containers/${name}/json`)).status).toBe(200);
      expect((await request('DELETE',`/v1.47/containers/${helperId}?force=1`)).status).toBe(204);
      expect((await request('DELETE',`/v1.47/volumes/${volume.Name}`)).status).toBe(204);
    });
  });
});

async function withHttpBroker(run: (fixture: BrokerHttpFixture) => Promise<void>,gatewaysOrOptions?:Set<string> | { allowTask2LegacyNegativeFixtures?: boolean; delayHelperWait?: boolean; gitWorkspace?: string; imageLabels?: Record<string, string>; initialProviderVolumeLookup?: (volume: string) => ReturnType<typeof sourceAuthorization> | undefined }, physicalStage = false,
  allowedProviderInputRoots = new Set<string>()) {
  const gateways = gatewaysOrOptions instanceof Set ? gatewaysOrOptions : undefined
  const options = gatewaysOrOptions instanceof Set ? {} : (gatewaysOrOptions ?? {})
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frs-broker-history-'))
  const socket = path.join(dir, 'docker.sock')
  const proxy = path.join(dir, 'broker.sock')
  const forwarded: ForwardedRequest[] = []
  let loseAck = false
  let rejectHelper = false
  let runtimeRunning=false
  let helperAckId = helperId
  let indexedVolumeMetadata:unknown
  let foreignHelper=false
  let sourceHelperDeleted = false
  let candidateVolumeMetadata: any
  let candidateVolumeAckUnavailable = false
  let candidateHelperDeleted = false
  let waitingResponse: http.ServerResponse | undefined
  const privateHelperCommands = ['observe-claude-sources-private', 'publish-provider-inputs', 'prepare-provider-mountpoints']
  const upstream = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const raw = Buffer.concat(chunks).toString()
    const body = raw ? JSON.parse(raw) : undefined
    forwarded.push({ method: req.method!, url: req.url!, body })
    if (req.url==='/v1.47/volumes/create') {
      if (body.Name.startsWith('freshell-claude-candidate-')) {
        candidateVolumeMetadata={Name:body.Name,Driver:body.Driver,Options:body.DriverOpts,Labels:body.Labels}
        res.statusCode=candidateVolumeAckUnavailable?503:201;res.end(JSON.stringify(candidateVolumeMetadata));return
      }
      indexedVolumeMetadata={Name:body.Name,Driver:body.Driver,Options:body.DriverOpts,Labels:body.Labels};
      res.statusCode=201;res.end(JSON.stringify(indexedVolumeMetadata));return;
    }
    if (req.url?.startsWith('/v1.47/volumes/freshell-claude-candidate-')) {
      if (req.method==='DELETE') {candidateVolumeMetadata=undefined;res.statusCode=204;res.end();return}
      res.statusCode=candidateVolumeMetadata?200:404;res.end(JSON.stringify(candidateVolumeMetadata ?? {}));return
    }
    if (req.method==='GET' && req.url?.startsWith('/v1.47/volumes/freshell-inputs-')) {
      res.statusCode=indexedVolumeMetadata?200:404;res.end(JSON.stringify(indexedVolumeMetadata ?? {}));return;
    }
    if (req.method==='GET' && req.url===`/v1.47/containers/${ownedId}/json`) {
      const creation=forwarded.findLast(value=>value.url.includes('/containers/create?') && !value.body?.Entrypoint)!;
      res.statusCode=200;res.end(JSON.stringify({Id:ownedId,Config:creation.body,HostConfig:creation.body.HostConfig,State:{Running:runtimeRunning,Status:runtimeRunning?'running':'exited',Paused:false,Restarting:false}}));return;
    }
    const candidateCreation = forwarded.findLast((operation) => operation.url.includes('/containers/create?') && operation.body?.Labels?.['com.freshell.claude-candidate']==='ordinary')
    if (req.method==='GET' && candidateCreation && (req.url===`/v1.47/containers/${helperId}/json`
      || req.url===`${candidateCreation.url.replace('/containers/create?name=', '/containers/')}/json`)) {
      if (candidateHelperDeleted) {res.statusCode=404;res.end('{}');return}
      const inspected=structuredClone(candidateCreation.body)
      inspected.Labels['org.opencontainers.image.version']='24.04'
      for (const mount of inspected.HostConfig.Mounts) if (mount.ReadOnly===false) delete mount.ReadOnly
      res.statusCode=200;res.end(JSON.stringify({Id:helperId,Config:foreignHelper?{...inspected,User:'foreign'}:inspected,HostConfig:inspected.HostConfig}));return
    }
    const privateHelper = forwarded.findLast(operation => privateHelperCommands.includes(operation.body?.Cmd?.[0])
      && (req.url === `/v1.47/containers/${helperId}/json`
        || req.url === `${operation.url.replace('/containers/create?name=', '/containers/')}/json`))
    if (req.method==='GET' && privateHelper) {
      if (sourceHelperDeleted) { res.statusCode=404;res.end('{}');return }
      const inspected=structuredClone(privateHelper.body);
      inspected.Labels['org.opencontainers.image.version']='24.04';
      inspected.Labels = { ...options.imageLabels, ...inspected.Labels };
      // Docker reports an empty Tmpfs object as null on the retained reader.
      if (inspected.HostConfig.Tmpfs && Object.keys(inspected.HostConfig.Tmpfs).length === 0) inspected.HostConfig.Tmpfs = null;
      for (const mount of inspected.HostConfig.Mounts) if (mount.ReadOnly===false) delete mount.ReadOnly;
      res.statusCode=200;res.end(JSON.stringify({Id:helperId,Config:foreignHelper?{...inspected,User:'0:0'}:inspected,HostConfig:inspected.HostConfig}));return;
    }
    if (req.url?.startsWith('/v1.47/containers/create?')) {
      if (body.Entrypoint && rejectHelper) {
        res.statusCode = 400
        res.end(JSON.stringify({ message: 'invalid mount config for type "bind": bind source path does not exist: PRIVATE_DAEMON_SENTINEL' }))
        return
      }
      if(body.Cmd?.[0]==='publish-provider-inputs') sourceHelperDeleted=false
      if (body.Entrypoint?.[0] === '/runtime/freshell-session-host' && loseAck) {
        req.socket.destroy()
        return
      }
      res.statusCode = 201
      res.end(JSON.stringify({ Id: body.Entrypoint ? helperAckId : ownedId }))
      return
    }
    const isHelperWait = /\/wait(?:\?|$)/.test(req.url ?? '')
    if (options.delayHelperWait && isHelperWait) {
      waitingResponse = res
      return
    }
    if (req.method === 'DELETE' || req.url?.endsWith('/start') || req.url?.endsWith('/update')) {
      if (req.method === 'DELETE' && req.url?.startsWith('/v1.47/volumes/freshell-inputs-')) indexedVolumeMetadata = undefined
      if (req.method==='DELETE' && candidateCreation && req.url===`/v1.47/containers/${helperId}?force=1`) candidateHelperDeleted=true
      if (req.method==='DELETE' && (req.url===`/v1.47/containers/${helperId}?force=1` || req.url===`/v1.47/containers/${sourceName}?force=1`
        || forwarded.some(operation => privateHelperCommands.includes(operation.body?.Cmd?.[0])
          && req.url === `${operation.url.replace('/containers/create?name=', '/containers/')}?force=1`))) sourceHelperDeleted=true
      if (req.method === 'DELETE') waitingResponse?.destroy()
      res.statusCode = 204
      res.end()
      return
    }
    if (req.method === 'GET' && req.url === `/v1.47/containers/${negativeLegacyId}/json`) {
      res.statusCode = 200
      res.end(JSON.stringify(negativeLegacyInspection()))
      return
    }
    res.statusCode = 200
    res.end(isHelperWait ? '{"StatusCode":0}'
      : req.url?.includes('/logs?') ? '{"threadId":"native-owned"}' : JSON.stringify({ Name: providerVolume }))
  })
  const instance = new RestrictedDockerBroker({
    allowedHostGatewayAddresses:gateways,
    realSocketPath: socket,
    proxySocketPath: proxy,
    allowTask2LegacyNegativeFixtures: options.allowTask2LegacyNegativeFixtures,
    runtimeRootPrefix: physicalStage ? path.join(dir, 'r') : '/tmp/owned/r',
    allowedHostBinaryPaths: new Set(physicalStage ? [path.join(dir, 'freshell-session-host')] : ['/tmp/owned/freshell-session-host', '/tmp/owned/other-approved-host']),
    allowedImageRefs: new Set(['sha256:fixture-image', 'sha256:other-approved-image', `sha256:${'b'.repeat(64)}`]),
    allowTerminalWorkloads: true,
    allowedWorkspaceRoots: new Set(['/workspace', ...(options.gitWorkspace ? [options.gitWorkspace] : [])]),
    allowedProviderInputRoots,
    initialProviderVolumeLookup: options.initialProviderVolumeLookup,
    testRunId: 'run-one',
    logPath: path.join(dir, 'broker.jsonl'),
  })
  const request: BrokerHttpFixture['request'] = (method, url, body, timeoutMs) => new Promise((resolve, reject) => {
    const req = http.request({ socketPath: proxy, path: url, method }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
      res.on('end', () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks).toString() }))
    })
    req.on('error', reject)
    if (timeoutMs !== undefined) req.setTimeout(timeoutMs, () => req.destroy(new Error('owned helper wait timed out')))
    req.end(body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body))
  })
  try {
    await new Promise<void>((resolve) => upstream.listen(socket, resolve))
    await instance.start()
    await run({ directory: dir, logPath: path.join(dir, 'broker.jsonl'), request, forwarded, broker: instance, setRuntimeRunning:(running)=>{runtimeRunning=running}, loseHelperAck: () => { loseAck = true }, rejectHelperCreate: () => { rejectHelper = true }, returnHelperId: (id) => { helperAckId = id },replaceHelperInspection:()=>{foreignHelper=true},
      loseCandidateVolumeAck:()=>{candidateVolumeAckUnavailable=true},replaceCandidateVolumeInspection:()=>{candidateVolumeMetadata ??= { Name: 'PRIVATE_FOREIGN_CANDIDATE', Driver: 'local', Labels: {} }; candidateVolumeMetadata.Labels['com.freshell.soul-id']='foreign'}, clearCandidateVolumeInspection:()=>{candidateVolumeMetadata=undefined} })
  } finally {
    upstream.closeAllConnections()
    await instance.close()
    await new Promise<void>((resolve) => upstream.close(() => resolve()))
    await fs.rm(dir, { recursive: true, force: true })
  }
}

it('admits only an exact owned published initial provider volume before its first workload receipt', async () => {
  const owner = sourceAuthorization()
  const lookup = vi.fn((volume: string) => volume === owner.providerVolumeName ? owner : undefined)
  await withHttpBroker(async ({ request, forwarded, broker }) => {
    expect(broker.receipts()).toEqual([])
    expect((await request('GET', `/v1.47/volumes/${owner.providerVolumeName}`)).status).toBe(200)
    expect(lookup).toHaveBeenCalledExactlyOnceWith(owner.providerVolumeName)
    expect(broker.initialProviderVolumeCreations()).toEqual([])
    expect((await request('POST', '/v1.47/volumes/create', {
      Name: owner.providerVolumeName, Driver: 'local', Labels: {
        'com.freshell.installation-id': owner.installationId, 'com.freshell.soul-id': owner.soulId,
        'freshell.input.reservation': '11111111-1111-4111-8111-111111111111',
        'freshell.input.incarnation': 'incarnation-owned', 'freshell.input.intent': '1',
        'freshell.input.daemon': owner.daemonId, 'freshell.input.image': owner.imageRef,
        'freshell.input.binary-sha256': owner.binarySha256,
      },
    })).status).toBe(201)
    expect(broker.initialProviderVolumeCreations()).toEqual([owner])
    expect((await request('GET', `/v1.47/volumes/freshell-provider-${'f'.repeat(24)}`)).status).toBe(403)
    expect(forwarded.map(operation => operation.url)).toEqual([`/v1.47/volumes/${owner.providerVolumeName}`, '/v1.47/volumes/create'])
  }, { initialProviderVolumeLookup: lookup })
})

it('authorizes Kilroy initial source observation from its actual committed registry row', async () => {
  const { DatabaseSync }: typeof import('node:sqlite') = createRequire(import.meta.url)('node:sqlite')
  let source: InitialProviderRegistrySource | undefined
  await withHttpBroker(async ({ directory, request, forwarded }) => {
    const owner = sourceAuthorization()
    source = { ...owner, registryPath: path.join(directory, 'runtime.sqlite3') }
    const db = new DatabaseSync(source.registryPath)
    try {
      db.exec(`CREATE TABLE provider_input_preparations (
        soul_id TEXT, provider TEXT, image_ref TEXT, host_binary_path TEXT, host_binary_sha256 TEXT,
        intent_revision INTEGER, consumed INTEGER, bound_incarnation_id TEXT)`)
      const url = `/v1.47/volumes/${owner.providerVolumeName}`
      expect((await request('GET', url)).status).toBe(403)
      expect(forwarded).toHaveLength(0)
      db.prepare('INSERT INTO provider_input_preparations VALUES(?,?,?,?,?,?,?,?)').run(
        owner.soulId, 'kilroy', owner.imageRef, owner.hostBinaryPath, owner.binarySha256, 1, 0, null)
      expect((await request('GET', url)).status).toBe(200)
      const before = forwarded.length
      expect((await request('GET', `/v1.47/volumes/freshell-provider-${'f'.repeat(24)}`)).status).toBe(403)
      expect(forwarded).toHaveLength(before)
      expect((await request('POST', `/v1.47/containers/create?name=${sourceName}`, sourceHelperBody())).status).toBe(201)
      expect((await request('POST', `/v1.47/containers/${helperId}/start`)).status).toBe(204)
      expect((await request('POST', `/v1.47/containers/${helperId}/wait?condition=not-running`)).status).toBe(200)
      expect((await request('DELETE', `/v1.47/containers/${helperId}?force=1`)).status).toBe(204)
      expect((await request('GET', `/v1.47/containers/${helperId}/json`)).status).toBe(404)
    } finally { db.close() }
  }, { initialProviderVolumeLookup: name => source && findInitialProviderVolume(name, [source]) })
})

it('refuses a changed owner returned by initial provider volume discovery', async () => {
  const owner = sourceAuthorization()
  await withHttpBroker(async ({ request, forwarded }) => {
    expect((await request('GET', `/v1.47/volumes/freshell-provider-${'f'.repeat(24)}`)).status).toBe(403)
    expect(forwarded).toEqual([])
  }, { initialProviderVolumeLookup: () => owner })
})

it('requires signal authority for new provider runtimes and retains exact Stop ownership', async () => {
  await withHttpBroker(async ({ request, forwarded, broker }) => {
    for (const capabilities of [
      ['CHOWN', 'SETGID', 'SETUID', 'SYS_ADMIN'],
      ['CHOWN', 'KILL', 'SETGID', 'SETUID', 'SYS_ADMIN'],
    ]) {
      const body = JSON.parse(createBody([...ordinaryBinds, actorBind]).toString())
      body.HostConfig.CapAdd = capabilities
      expect((await request('POST', '/v1.47/containers/create?name=refused-runtime', body)).status).toBe(403)
    }
    expect(forwarded).toEqual([])
    expect(broker.receipts()).toEqual([])
    const legacyProfile = JSON.parse(createBody([...ordinaryBinds, actorBind]).toString())
    legacyProfile.HostConfig.CapAdd = ['CHOWN', 'SETGID', 'SETUID']
    expect((await request('POST', '/v1.47/containers/create?name=owned-runtime', legacyProfile)).status).toBe(201)
    expect(broker.receipts()).toHaveLength(1)
    expect((await request('POST', `/v1.47/containers/${ownedId}/stop?t=2`)).status).toBe(200)
    expect(forwarded.map(row => row.url)).toEqual(['/v1.47/containers/create?name=owned-runtime', `/v1.47/containers/${ownedId}/stop?t=2`])
    expect(broker.destructiveRequestsFor(ownedId)).toHaveLength(1)
    expect(broker.unsafeAttempts()).toMatchObject([
      { decision: 'block', url: '/v1.47/containers/create?name=refused-runtime' },
      { decision: 'block', url: '/v1.47/containers/create?name=refused-runtime' },
    ])
  })
})

it('omits private query fields from diagnostics for admitted owned requests', async () => {
  await withHttpBroker(async ({ request, forwarded, broker, logPath }) => {
    const privateValue = 'private encoded query/value'
    const encoded = encodeURIComponent(privateValue)
    const createUrl = `/v1.47/containers/create?name=owned-runtime&private=${encoded}`
    expect((await request('POST', createUrl, createBody([...ordinaryBinds, actorBind]))).status).toBe(201)
    const inspectUrl = `/v1.47/containers/${ownedId}/json?private=${encoded}`
    expect((await request('GET', inspectUrl)).status).toBe(200)
    expect(forwarded.map(row => row.url)).toEqual([createUrl, inspectUrl])
    expect(broker.receipts()).toHaveLength(1)
    expect(broker.receipts()[0].containerId).toBe(ownedId)
    expect(broker.eventsSnapshot().map(row => row.url)).toEqual([createUrl, inspectUrl])
    expect(broker.unsafeAttempts()).toEqual([])
    const rows = (await fs.readFile(logPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line)).filter(row => row.event)
    expect(rows).toHaveLength(4)
    const diagnostics = JSON.stringify(rows)
    expect(diagnostics).not.toContain(encoded)
    expect(diagnostics).not.toContain(privateValue)
    expect(rows[0]).toMatchObject({ route: 'container_create' })
    expect(rows[2]).toMatchObject({ route: 'container_json', containerId: ownedId })
    expect(rows[0].requestId).toBe(rows[1].requestId)
    expect(rows[2].requestId).toBe(rows[3].requestId)
    const stopUrl = `/v1.47/containers/${ownedId}/stop?t=2&private=${encoded}`
    expect((await request('POST', stopUrl)).status).toBe(200)
    const stopRows = (await fs.readFile(logPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
      .filter(row => row.event && row.route === 'container_stop')
    expect(stopRows).toHaveLength(2)
    expect(stopRows[0]).toMatchObject({ containerId: ownedId, stopGraceSeconds: 2 })
    expect(stopRows[1]).toMatchObject({ containerId: ownedId, stopGraceSeconds: 2, statusCode: 200 })
    expect(JSON.stringify(stopRows)).not.toContain(encoded)
    expect(broker.destructiveRequestsFor(ownedId)).toMatchObject([{ url: stopUrl, decision: 'forward', unsafeAttempt: false }])
  })
})

const repairName = 'freshell-opencode-repair-11111111-1111-4111-8111-111111111111'
const repairStageRoot = '/tmp/owned/r/scenario/x/opencode-transfers'
const repairStageBasename = `stopped-repair-${'0123456789abcdef'.repeat(3)}.ready`
const repairStage = path.join(repairStageRoot, repairStageBasename)
const repairEnv = [
  'HOME=/home/freshell/provider',
  'OPENCODE_DB=/home/freshell/provider/.local/share/opencode/opencode.db',
  'PATH=/usr/local/bin:/usr/bin:/bin',
  'XDG_CONFIG_HOME=/home/freshell/provider/.config',
  'XDG_DATA_HOME=/home/freshell/provider/.local/share',
  'TERM=xterm-256color',
  'OPENCODE_MODEL=fixture-configured',
].sort()

function stoppedRepairBody(stageSource = repairStage) {
  return {
    Image: 'sha256:fixture-image', User: '0:0', WorkingDir: '/workspace', Tty: false,
    Entrypoint: ['/runtime/freshell-session-host'],
    Cmd: ['opencode-stopped-repair-worker', '--stage-dir', '/run/freshell-opencode-transfer',
      '--workspace-root', '/workspace', '--expected-cwd', '/workspace', '--provider-uid', '65534', '--provider-gid', '0'],
    Env: [...repairEnv],
    HostConfig: {
      NetworkMode: 'none', ReadonlyRootfs: true, CapDrop: ['ALL'], CapAdd: ['SETUID', 'SETGID'],
      SecurityOpt: ['no-new-privileges'], Memory: 256 * 1024 * 1024, MemorySwap: 256 * 1024 * 1024,
      NanoCpus: 500_000_000, PidsLimit: 32, Tmpfs: { '/tmp': 'rw,noexec,nosuid,nodev,size=16m' },
      Mounts: [
        { Type: 'bind', Source: '/tmp/owned/freshell-session-host', Target: '/runtime/freshell-session-host', ReadOnly: true },
        { Type: 'volume', Source: providerVolume, Target: '/home/freshell/provider', ReadOnly: false },
        { Type: 'bind', Source: stageSource, Target: '/run/freshell-opencode-transfer', ReadOnly: true },
        { Type: 'bind', Source: '/workspace', Target: '/workspace', ReadOnly: true },
      ],
    },
  }
}

async function registerRepairOwner(request: BrokerHttpFixture['request']) {
  const body = JSON.parse(createBody(ordinaryBinds).toString())
  // OpenCode's ordinary host environment does not copy terminal.env; the repair helper does.
  body.Env = []
  expect((await request('POST', '/v1.47/containers/create?name=owned-runtime', body)).status).toBe(201)
}

describe('receipt-owned stopped OpenCode repair HTTP routes', () => {
  it.each([
    ['stopped-repair', repairStage],
    ['opencode-transfer', path.join(repairStageRoot, 'opencode-transfer-one.ready')],
  ])('admits the %s repair worker body and binds its lifecycle and cleanup to the original receipt', async (_family, stageSource) => {
    await withHttpBroker(async ({ request, forwarded, broker }) => {
      await registerRepairOwner(request)
      expect((await request('GET', `/v1.47/volumes/${providerVolume}`)).status).toBe(200)
      expect((await request('POST', `/v1.47/containers/create?name=${repairName}`, stoppedRepairBody(stageSource))).status).toBe(201)
      expect(forwarded.at(-1)).toEqual({ method: 'POST', url: `/v1.47/containers/create?name=${repairName}`, body: stoppedRepairBody(stageSource) })
      expect(forwarded.at(-1)?.body.Env).toEqual(repairEnv)
      expect(forwarded[0].body.Env).toEqual([])
      expect(broker.historyHelperNames()).toContain(repairName)
      expect(broker.receiptIds().has(helperId)).toBe(true)
      expect(broker.receipts()).toHaveLength(1)
      expect(broker.eventsSnapshot().at(-1)).toMatchObject({ helperName: repairName, ownerContainerId: ownedId, providerVolumeName: providerVolume })
      expect((await request('POST', `/v1.47/containers/${helperId}/start`)).status).toBe(204)
      expect((await request('POST', `/v1.47/containers/${helperId}/wait?condition=not-running`)).body).toBe('{"StatusCode":0}')
      expect((await request('GET', `/v1.47/containers/${helperId}/logs?stdout=1&stderr=0`)).status).toBe(200)
      for (const [method, url] of [
        ['POST', `/v1.47/containers/${helperId}/kill`],
        ['POST', `/v1.47/containers/${helperId}/update`],
        ['POST', `/v1.47/containers/${repairName}/start`],
        ['DELETE', `/v1.47/containers/${helperId}?force=0`],
        ['DELETE', '/v1.47/containers/freshell-opencode-repair-foreign?force=1'],
      ]) {
        const count = forwarded.length
        expect((await request(method, url)).status).toBe(403)
        expect(forwarded).toHaveLength(count)
      }
      const count = forwarded.length
      expect((await request('POST', `/v1.47/containers/create?name=${repairName}`, stoppedRepairBody(stageSource))).status).toBe(403)
      expect(forwarded).toHaveLength(count)
      expect((await request('DELETE', `/v1.47/containers/${repairName}?force=1`)).status).toBe(204)
      expect(forwarded.at(-1)?.url).toBe(`/v1.47/containers/${repairName}?force=1`)
    })
  })

  it.each([
    ['47 hex characters', `stopped-repair-${'a'.repeat(47)}.ready`],
    ['49 hex characters', `stopped-repair-${'a'.repeat(49)}.ready`],
    ['nonhex character', `stopped-repair-${'a'.repeat(47)}g.ready`],
    ['uppercase hex', `stopped-repair-${'A'.repeat(48)}.ready`],
    ['wrong prefix', `stopped-transfer-${'a'.repeat(48)}.ready`],
    ['wrong suffix', `stopped-repair-${'a'.repeat(48)}.partial`],
    ['trailing suffix', `stopped-repair-${'a'.repeat(48)}.ready.extra`],
  ])('rejects a stopped-repair stage with %s without forwarding or granting cleanup authority', async (_reason, basename) => {
    await withHttpBroker(async ({ request, forwarded, broker }) => {
      await registerRepairOwner(request)
      const before = forwarded.length
      const body = stoppedRepairBody(path.join(repairStageRoot, basename))
      expect((await request('POST', `/v1.47/containers/create?name=${repairName}`, body)).status).toBe(403)
      expect(forwarded).toHaveLength(before)
      expect(broker.historyHelperNames()).toEqual([])
      expect([...broker.receiptIds()]).toEqual([ownedId])
      expect((await request('DELETE', `/v1.47/containers/${repairName}?force=1`)).status).toBe(403)
      expect(forwarded).toHaveLength(before)
    })
  })

  it('keeps stopped-repair stages out of ordinary host transfer admission', async () => {
    await withHttpBroker(async ({ request, forwarded, broker }) => {
      const body = createBody([...ordinaryBinds, actorBind, `${repairStage}:/run/freshell-opencode-transfer:ro`])
      expect((await request('POST', '/v1.47/containers/create?name=owned-runtime', body)).status).toBe(403)
      expect(forwarded).toHaveLength(0)
      expect(broker.receipts()).toHaveLength(0)
    })
  })

  it('rejects changed repair sources, identity, command and privileges before contacting Docker', async () => {
    await withHttpBroker(async ({ request, forwarded }) => {
      const create = (body: ReturnType<typeof stoppedRepairBody>) => request('POST', `/v1.47/containers/create?name=${repairName}`, body)
      expect((await create(stoppedRepairBody())).status).toBe(403)
      expect(forwarded).toHaveLength(0)
      await registerRepairOwner(request)
      const mutations: ((body: ReturnType<typeof stoppedRepairBody>) => void)[] = [
        body => { body.Image = 'sha256:other-approved-image' },
        body => { body.HostConfig.Mounts[0].Source = '/tmp/owned/other-approved-host' },
        body => { body.HostConfig.Mounts[1].Source = 'freshell-provider-ffffffffffffffffffffffff' },
        body => { body.HostConfig.Mounts[1].ReadOnly = true },
        body => { body.HostConfig.Mounts[2].Source = `/tmp/owned/r/foreign/x/opencode-transfers/${repairStageBasename}` },
        body => { body.HostConfig.Mounts[2].ReadOnly = false },
        body => { body.HostConfig.Mounts[2].Source = `${repairStageRoot}/../opencode-transfers/${repairStageBasename}` },
        body => { body.HostConfig.Mounts[2].Source = `tmp/owned/r/scenario/x/opencode-transfers/${repairStageBasename}` },
        body => { body.HostConfig.Mounts[3].Source = '/foreign' },
        body => { body.HostConfig.Mounts[3].ReadOnly = false },
        body => { body.HostConfig.Mounts.push({ Type: 'bind', Source: '/etc', Target: '/etc', ReadOnly: true }) },
        body => { body.Cmd[0] = 'serve' },
        body => { body.Entrypoint = ['/bin/sh'] },
        body => { body.Cmd[6] = '/foreign' },
        body => { body.Cmd[8] = '0' },
        body => { body.Cmd[10] = '65534' },
        body => { body.Cmd.push('--extra') },
        body => { body.WorkingDir = '/foreign' },
        body => { body.Tty = true },
        body => { body.User = '65534:0' },
        body => { Object.assign(body, { Labels: { 'com.freshell.managed': 'true' } }) },
        ...['HOME', 'OPENCODE_DB', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME'].map(key => (body: ReturnType<typeof stoppedRepairBody>) => {
          body.Env[body.Env.findIndex(value => value.startsWith(`${key}=`))] = `${key}=/foreign`
        }),
        body => { body.Env = [] },
        body => { body.Env.push('malformed') },
        body => { body.Env.push('TERM=xterm\0foreign') },
        body => { body.Env.push(body.Env[0]) },
        body => { body.HostConfig.NetworkMode = 'bridge' },
        body => { body.HostConfig.ReadonlyRootfs = false },
        body => { body.HostConfig.CapAdd.push('CHOWN') },
        body => { Object.assign(body.HostConfig, { Privileged: true }) },
        body => { Object.assign(body.HostConfig, { Binds: ['/etc:/etc:rw'] }) },
        body => { Object.assign(body.HostConfig, { PortBindings: { '80/tcp': [{ HostPort: '80' }] } }) },
        body => { Object.assign(body.HostConfig, { ExtraHosts: ['foreign:127.0.0.1'] }) },
        body => { body.HostConfig.SecurityOpt = [] },
        body => { body.HostConfig.MemorySwap = 0 },
        body => { body.HostConfig.PidsLimit = 0 },
        body => { body.HostConfig.Tmpfs['/tmp'] = 'rw,size=1g' },
      ]
      for (const mutate of mutations) {
        const body = stoppedRepairBody()
        mutate(body)
        const count = forwarded.length
        expect((await create(body)).status).toBe(403)
        expect(forwarded).toHaveLength(count)
      }
    })
  })

  it('admits the production optional read-only Git common directory with a workspace-local cwd', async () => {
    await withHttpBroker(async ({ request, forwarded }) => {
      await registerRepairOwner(request)
      const body = stoppedRepairBody()
      body.WorkingDir = '/workspace/nested'
      body.Cmd[6] = body.WorkingDir
      body.HostConfig.Mounts.push({ Type: 'bind', Source: '/workspace-git', Target: '/workspace-git', ReadOnly: true })
      try {
        expect((await request('POST', `/v1.47/containers/create?name=${repairName}`, body)).status).toBe(201)
        expect(forwarded.at(-1)?.body).toEqual(body)
      } finally {
        expect((await request('DELETE', `/v1.47/containers/${repairName}?force=1`)).status).toBe(204)
      }
    }, { gitWorkspace: '/workspace-git' })
  })

  it('retains exact-name cleanup authority when the repair create acknowledgement is lost', async () => {
    await withHttpBroker(async ({ request, forwarded, broker, loseHelperAck }) => {
      await registerRepairOwner(request)
      loseHelperAck()
      try {
        expect((await request('POST', `/v1.47/containers/create?name=${repairName}`, stoppedRepairBody())).status).toBe(503)
        expect(broker.historyHelperNames()).toContain(repairName)
        expect(broker.receiptIds().has(helperId)).toBe(false)
      } finally {
        expect((await request('DELETE', `/v1.47/containers/${repairName}?force=1`)).status).toBe(204)
      }
      expect(forwarded.at(-1)?.url).toBe(`/v1.47/containers/${repairName}?force=1`)
    })
  })

  it('permits exact-name cleanup after the owned repair wait times out', async () => {
    await withHttpBroker(async ({ request, forwarded, broker }) => {
      await registerRepairOwner(request)
      expect((await request('POST', `/v1.47/containers/create?name=${repairName}`, stoppedRepairBody())).status).toBe(201)
      try {
        expect((await request('POST', `/v1.47/containers/${helperId}/start`)).status).toBe(204)
        await expect(request('POST', `/v1.47/containers/${helperId}/wait?condition=not-running`, undefined, 100)).rejects.toThrow('owned helper wait timed out')
        expect(forwarded.some(entry => entry.url.endsWith('/wait?condition=not-running'))).toBe(true)
        expect(broker.historyHelperNames()).toContain(repairName)
      } finally {
        expect((await request('DELETE', `/v1.47/containers/${repairName}?force=1`)).status).toBe(204)
      }
    }, { delayHelperWait: true })
  })
})

describe('receipt-owned read-only history HTTP routes', () => {
  it.each([
    ['retained reader', helperName, dockerCliRetainedStoreHelperBody],
    ['Node graph reader', helperName, batchStoreHelperBody],
    ['native history reader', helperName, historyHelperBody],
    ['stopped repair', repairName, stoppedRepairBody],
    ['stopped transfer', repairName, () => stoppedRepairBody(path.join(repairStageRoot, 'opencode-transfer-one.ready'))],
  ] as const)('forwards the captured CLI lifecycle for the already admitted %s', async (_family, name, helperBody) => {
    await withHttpBroker(async ({ request, forwarded }) => {
      const body = helperBody()
      const owner = JSON.parse(createBody(ordinaryBinds).toString())
      owner.Image = body.Image
      owner.Env = []
      expect((await request('POST', '/v1.47/containers/create?name=owned-runtime', owner)).status).toBe(201)
      expect((await request('POST', `/v1.47/containers/create?name=${name}`, body)).status).toBe(201)
      expect(forwarded.at(-1)?.body).toEqual(body)
      const before = forwarded.length
      for (const [method, url, status] of [
        ['POST', `/v1.47/containers/${helperId}/start`, 204],
        ['POST', `/v1.47/containers/${helperId}/wait`, 200],
        ['GET', `/v1.47/containers/${helperId}/json`, 200],
        ['GET', `/v1.47/containers/${helperId}/logs?stderr=1&stdout=1`, 200],
        ['DELETE', `/v1.47/containers/${name}?force=1`, 204],
      ] as const) {
        expect((await request(method, url)).status).toBe(status)
        expect(forwarded.at(-1)).toEqual({ method, url, body: undefined })
      }
      expect(forwarded).toHaveLength(before + 5)
    })
  })

  it('admits the captured Docker CLI logs query order without accepting extra log controls', async () => {
    await withHttpBroker(async ({ request, forwarded, broker }) => {
      await registerRepairOwner(request)
      expect((await request('POST', `/v1.47/containers/create?name=${helperName}`, dockerCliRetainedStoreHelperBody())).status).toBe(201)
      expect((await request('GET', `/v1.47/containers/${helperId}/logs?stderr=1&stdout=1`)).status).toBe(200)
      expect(forwarded.at(-1)?.url).toBe(`/v1.47/containers/${helperId}/logs?stderr=1&stdout=1`)
      expect(broker.eventsSnapshot().at(-1)).toMatchObject({
        decision: 'forward', destructive: false, helperName, ownerContainerId: ownedId, providerVolumeName: providerVolume,
      })
      const before = forwarded.length
      for (const [method, url] of [
        ['POST', `/v1.47/containers/${helperId}/logs?stderr=1&stdout=1`],
        ['GET', `/v1.47/containers/${helperName}/logs?stderr=1&stdout=1`],
        ['GET', `/v1.47/containers/${'f'.repeat(64)}/logs?stderr=1&stdout=1`],
        ['GET', `/v1.47/containers/${helperId.slice(0, 12)}/logs?stderr=1&stdout=1`],
        ...['follow=1', 'tail=all', 'extra=1', 'stdout=1', 'stderr=1'].map(query =>
          ['GET', `/v1.47/containers/${helperId}/logs?stderr=1&stdout=1&${query}`]),
        ['GET', `/v1.47/containers/${helperId}/logs?stderr=1&stdout=0`],
        ['DELETE', `/v1.47/containers/${helperName}?force=1&v=1`],
        ['DELETE', `/v1.47/containers/${helperName}`],
      ]) expect((await request(method, url)).status).toBe(403)
      expect(forwarded).toHaveLength(before)
      expect((await request('DELETE', `/v1.47/containers/${helperName}?force=1`)).status).toBe(204)
    })
  })

  it('admits the captured Docker CLI log inspection only for an acknowledged exact helper ID', async () => {
    await withHttpBroker(async ({ request, forwarded, broker }) => {
      await registerRepairOwner(request)
      expect((await request('POST', `/v1.47/containers/create?name=${helperName}`, dockerCliRetainedStoreHelperBody())).status).toBe(201)
      expect((await request('GET', `/v1.47/containers/${helperId}/json`)).status).toBe(200)
      expect(forwarded.at(-1)?.url).toBe(`/v1.47/containers/${helperId}/json`)
      expect(broker.eventsSnapshot().at(-1)).toMatchObject({
        decision: 'forward', destructive: false, helperName, ownerContainerId: ownedId, providerVolumeName: providerVolume,
      })
      const before = forwarded.length
      for (const [method, url] of [
        ['POST', `/v1.47/containers/${helperId}/json`],
        ['GET', `/v1.47/containers/${helperName}/json`],
        ['GET', `/v1.47/containers/${'f'.repeat(64)}/json`],
        ['GET', `/v1.47/containers/${helperId.slice(0, 12)}/json`],
        ['GET', `/v1.47/containers/${helperId}/json?size=1`],
        ['GET', `/v1.47/containers/${helperId}/json?extra=1`],
      ]) expect((await request(method, url)).status).toBe(403)
      expect(forwarded).toHaveLength(before)
      expect((await request('DELETE', `/v1.47/containers/${helperName}?force=1`)).status).toBe(204)
    })
  })

  it('admits the captured Docker CLI default wait only for an acknowledged exact helper ID', async () => {
    await withHttpBroker(async ({ request, forwarded, broker }) => {
      await registerRepairOwner(request)
      expect((await request('POST', `/v1.47/containers/create?name=${helperName}`, dockerCliRetainedStoreHelperBody())).status).toBe(201)
      expect((await request('POST', `/v1.47/containers/${helperId}/start`)).status).toBe(204)
      expect(await request('POST', `/v1.47/containers/${helperId}/wait`)).toEqual({ status: 200, body: '{"StatusCode":0}' })
      expect(forwarded.at(-1)?.url).toBe(`/v1.47/containers/${helperId}/wait`)
      expect(broker.eventsSnapshot().at(-1)).toMatchObject({
        decision: 'forward', helperName, ownerContainerId: ownedId, providerVolumeName: providerVolume,
      })
      expect((await request('POST', `/v1.47/containers/${helperId}/wait?condition=not-running`)).status).toBe(200)
      const before = forwarded.length
      for (const [method, url] of [
        ['GET', `/v1.47/containers/${helperId}/wait`],
        ['POST', `/v1.47/containers/${helperName}/wait`],
        ['POST', `/v1.47/containers/${'f'.repeat(64)}/wait`],
        ['POST', `/v1.47/containers/${helperId.slice(0, 12)}/wait`],
        ...['condition=', 'condition=next-exit', 'condition=removed', 'condition=not-running&condition=not-running',
          'condition=not-running&extra=1', 'extra=1'].map(query => ['POST', `/v1.47/containers/${helperId}/wait?${query}`]),
        ['POST', `/v1.47/containers/${helperId}/wait/`],
      ]) expect((await request(method, url)).status).toBe(403)
      expect(forwarded).toHaveLength(before)
      expect((await request('DELETE', `/v1.47/containers/${helperName}?force=1`)).status).toBe(204)
    })
  })

  it('admits the captured Docker CLI retained-reader environment order without changing its authority', async () => {
    await withHttpBroker(async ({ request, forwarded, broker }) => {
      await registerRepairOwner(request)
      const body = dockerCliRetainedStoreHelperBody()
      expect((await request('POST', `/v1.47/containers/create?name=${helperName}`, body)).status).toBe(201)
      expect(forwarded.at(-1)?.body).toEqual(body)
      expect(broker.eventsSnapshot().at(-1)).toMatchObject({
        decision: 'forward', helperName, ownerContainerId: ownedId, providerVolumeName: providerVolume,
      })
      expect((await request('DELETE', `/v1.47/containers/${helperName}?force=1`)).status).toBe(204)
    })
  })

  it('refuses changed retained-reader environment entries and ownership before forwarding or reserving a name', async () => {
    await withHttpBroker(async ({ request, forwarded, broker }) => {
      await registerRepairOwner(request)
      const mutations = [
        (body: ReturnType<typeof retainedStoreHelperBody>) => { body.Env.splice(0, 1) },
        (body: ReturnType<typeof retainedStoreHelperBody>) => { body.Env[3] = body.Env[0] },
        (body: ReturnType<typeof retainedStoreHelperBody>) => { body.Env.push('EXTRA=unexpected') },
        (body: ReturnType<typeof retainedStoreHelperBody>) => { body.Env[1] = 'HOME=/foreign' },
        (body: ReturnType<typeof retainedStoreHelperBody>) => { body.Env[0] = 'OPENCODE_DB=/foreign.db' },
        (body: ReturnType<typeof retainedStoreHelperBody>) => { body.Env[2] = 'XDG_DATA_HOME=/foreign' },
        (body: ReturnType<typeof retainedStoreHelperBody>) => { body.Env[3] = 'XDG_CONFIG_HOME=/foreign' },
        (body: ReturnType<typeof retainedStoreHelperBody>) => { Object.assign(body, { Env: null }) },
        (body: ReturnType<typeof retainedStoreHelperBody>) => { body.User = '0:0' },
        (body: ReturnType<typeof retainedStoreHelperBody>) => { body.User = '65534:1' },
        (body: ReturnType<typeof retainedStoreHelperBody>) => { Object.assign(body.HostConfig, { CapAdd: ['CHOWN'] }) },
        (body: ReturnType<typeof retainedStoreHelperBody>) => { body.HostConfig.Mounts[1].Source = 'foreign-volume' },
        (body: ReturnType<typeof retainedStoreHelperBody>) => { body.HostConfig.Mounts[1].ReadOnly = false },
        (body: ReturnType<typeof retainedStoreHelperBody>) => { body.HostConfig.Mounts[0].Source = '/foreign-host' },
        (body: ReturnType<typeof retainedStoreHelperBody>) => { body.HostConfig.Mounts[2].ReadOnly = false },
        (body: ReturnType<typeof retainedStoreHelperBody>) => { body.WorkingDir = '/foreign' },
        (body: ReturnType<typeof retainedStoreHelperBody>) => { body.HostConfig.Memory++ },
        (body: ReturnType<typeof retainedStoreHelperBody>) => { body.HostConfig.NetworkMode = 'bridge' },
        (body: ReturnType<typeof retainedStoreHelperBody>) => { body.Cmd[0] = 'foreign-worker' },
        (body: ReturnType<typeof retainedStoreHelperBody>) => { const selected = JSON.parse(body.Cmd[1]); selected.providerUid = 0; body.Cmd[1] = JSON.stringify(selected) },
        (body: ReturnType<typeof retainedStoreHelperBody>) => { const selected = JSON.parse(body.Cmd[1]); selected.providerGid = 1; body.Cmd[1] = JSON.stringify(selected) },
      ]
      for (const mutate of mutations) {
        const body = dockerCliRetainedStoreHelperBody()
        mutate(body)
        const count = forwarded.length
        expect((await request('POST', `/v1.47/containers/create?name=${helperName}`, body)).status).toBe(403)
        expect(forwarded).toHaveLength(count)
        expect(broker.historyHelperNames()).not.toContain(helperName)
      }
    })
  })

  it('admits only the fixed Node native reader on the exact receipt workspace and read-only provider source', async () => {
    await withHttpBroker(async ({ request, forwarded, broker }) => {
      await request('POST', '/v1.47/containers/create?name=owned-runtime', createBody([...ordinaryBinds, actorBind]))
      const body = () => {
        const original = historyHelperBody()
        return { ...original, Entrypoint: ['node'], WorkingDir: '/workspace',
          Cmd: ['--no-warnings', '/workspace/dist/native-history-run-one/probe-cli.mjs',
            'codex', '/home/freshell/provider/.codex/sessions', 'native-owned'],
          HostConfig: { ...original.HostConfig, Mounts: [original.HostConfig.Mounts[1],
            { Type: 'bind', Source: '/workspace', Target: '/workspace', ReadOnly: true }] } }
      }
      const mutations: ((input: ReturnType<typeof body>) => void)[] = [
        input => { input.Entrypoint = ['/bin/sh'] },
        input => { input.Cmd[0] = '-e' },
        input => { input.Cmd[1] = '/workspace/dist/native-history-foreign-run/probe-cli.mjs' },
        input => { input.Cmd[1] = '/workspace/dist/native-history-run-one/other-probe.mjs' },
        input => { input.Cmd[2] = 'foreign-provider' },
        input => { input.Cmd[3] = '/home/freshell/provider/foreign-source' },
        input => { input.Cmd[4] = '' },
        input => { input.Cmd.push('unexpected-argument') },
        input => { input.HostConfig.Mounts[0].Source = 'foreign-volume' },
        input => { input.HostConfig.Mounts[1].ReadOnly = false },
        input => { input.HostConfig.Mounts[1].Target = '/other-workspace' },
        input => { input.Image = 'sha256:other-approved-image' },
        input => { input.HostConfig.NetworkMode = 'bridge' },
      ]
      for (const mutate of mutations) {
        const input = body()
        mutate(input)
        const before = forwarded.length
        expect((await request('POST', `/v1.47/containers/create?name=${helperName}`, input)).status).toBe(403)
        expect(forwarded).toHaveLength(before)
      }
      expect((await request('POST', `/v1.47/containers/create?name=${helperName}`, body())).status).toBe(201)
      expect(broker.historyHelperNames()).toContain(helperName)
      expect(broker.eventsSnapshot().at(-1)).toMatchObject({ ownerContainerId: ownedId, providerVolumeName: providerVolume })
      expect((await request('POST', `/v1.47/containers/${helperId}/start`)).status).toBe(204)
      expect((await request('POST', `/v1.47/containers/${helperId}/wait?condition=not-running`)).status).toBe(200)
      expect((await request('GET', `/v1.47/containers/${helperId}/logs?stdout=1&stderr=0`)).body).toContain('native-owned')
      expect((await request('POST', `/v1.47/containers/${helperId}/wait`)).status).toBe(200)
      expect((await request('GET', `/v1.47/containers/${helperId}/json`)).status).toBe(200)
      expect((await request('GET', `/v1.47/containers/${helperId}/logs?stderr=1&stdout=1`)).body).toContain('native-owned')
      expect((await request('POST', `/v1.47/containers/${helperId}/kill`)).status).toBe(403)
      expect((await request('DELETE', `/v1.47/containers/${helperName}?force=1`)).status).toBe(204)
    })
  })
  it('admits current-image exact retained-store reads with no writer or provider control authority', async () => {
    await withHttpBroker(async ({request,forwarded,broker})=>{
      expect((await request('POST','/v1.47/containers/create?name=owned-runtime',createBody([...ordinaryBinds,actorBind]))).status).toBe(201)
      const invalid=[
        (body:any)=>{body.HostConfig.Mounts[1].ReadOnly=false},
        (body:any)=>{body.HostConfig.Mounts[1].Source='foreign-volume'},
        (body:any)=>{body.HostConfig.Mounts.push({...body.HostConfig.Mounts[2]})},
        (body:any)=>{body.HostConfig.CapAdd=['CHOWN']},
        (body:any)=>{body.Tty=true},
        (body:any)=>{body.Cmd[1]='{}'},
        (body:any)=>{const decoded=JSON.parse(body.Cmd[1]);decoded.imageRef='sha256:fixture-image';body.Cmd[1]=JSON.stringify(decoded)},
        (body:any)=>{body.WorkingDir='/foreign'},
      ]
      for(const mutate of invalid){
        const body=retainedStoreHelperBody();mutate(body)
        const before=forwarded.length
        expect((await request('POST',`/v1.47/containers/create?name=${helperName}`,body)).status).toBe(403)
        expect(forwarded).toHaveLength(before)
      }
      expect((await request('POST',`/v1.47/containers/create?name=${helperName}`,retainedStoreHelperBody())).status).toBe(201)
      expect(broker.receipts()).toHaveLength(1)
      expect(broker.eventsSnapshot().at(-1)).toMatchObject({ownerContainerId:ownedId,providerVolumeName:providerVolume})
      expect((await request('POST',`/v1.47/containers/${helperId}/start`)).status).toBe(204)
      expect((await request('POST',`/v1.47/containers/${helperId}/wait?condition=not-running`)).status).toBe(200)
      expect((await request('POST',`/v1.47/containers/${helperId}/kill`)).status).toBe(403)
      expect((await request('DELETE',`/v1.47/containers/${helperName}?force=1`)).status).toBe(204)
    })
  })
  it('forwards the owned volume and exact helper lifecycle while refusing foreign sources and controls', async () => {
    await withHttpBroker(async ({ request, forwarded, broker }) => {
      expect((await request('POST', '/v1.47/containers/create?name=owned-runtime', createBody([...ordinaryBinds, actorBind]))).status).toBe(201)
      expect((await request('GET', `/v1.47/volumes/${providerVolume}`)).status).toBe(200)
      const beforeForeign = forwarded.length
      expect((await request('GET', '/v1.47/volumes/freshell-provider-ffffffffffffffffffffffff')).status).toBe(403)
      expect(forwarded).toHaveLength(beforeForeign)
      expect((await request('POST', `/v1.47/containers/create?name=${helperName}`, historyHelperBody())).status).toBe(201)
      expect(broker.receiptIds().has(helperId)).toBe(true)
      expect(broker.receipts()).toHaveLength(1)
      expect(broker.eventsSnapshot().at(-1)).toMatchObject({ helperName, containerId: helperId, ownerContainerId: ownedId, providerVolumeName: providerVolume })
      const beforeDuplicate = forwarded.length
      expect((await request('POST', `/v1.47/containers/create?name=${helperName}`, historyHelperBody())).status).toBe(403)
      expect(forwarded).toHaveLength(beforeDuplicate)
      expect((await request('POST', `/v1.47/containers/${helperId}/start`)).status).toBe(204)
      expect((await request('POST', `/v1.47/containers/${helperId}/wait?condition=not-running`)).status).toBe(200)
      for (const stderr of ['0', '1']) {
        expect((await request('GET', `/v1.47/containers/${helperId}/logs?stdout=1&stderr=${stderr}`)).body).toContain('native-owned')
      }
      for (const [method, url] of [
        ['POST', `/v1.47/containers/${helperId}/update`],
        ['POST', `/v1.47/containers/${helperId}/kill`],
        ['POST', `/v1.47/containers/${'f'.repeat(64)}/wait?condition=not-running`],
        ['DELETE', '/v1.47/containers/freshell-history-foreign?force=1'],
        ['POST', `/v1.47/containers/${ownedId}/wait?condition=not-running`],
        ['DELETE', `/v1.47/containers/${helperId}?force=0`],
        ['POST', `/v1.47/containers/${helperName}/start`],
      ]) {
        const before = forwarded.length
        expect((await request(method, url)).status).toBe(403)
        expect(forwarded).toHaveLength(before)
      }
      expect((await request('POST', `/v1.47/containers/${ownedId}/update`, {})).status).toBe(204)
      expect((await request('DELETE', `/v1.47/containers/${helperName}?force=1`)).status).toBe(204)
      expect(forwarded.at(-1)?.url).toBe(`/v1.47/containers/${helperName}?force=1`)
      expect((await request('DELETE', `/v1.47/containers/${helperId}?force=1`)).status).toBe(204)
    })
  })
  it('refuses foreign and modified helper topology before forwarding', async () => {
    await withHttpBroker(async ({ request, forwarded }) => {
      await request('POST', '/v1.47/containers/create?name=owned-runtime', createBody([...ordinaryBinds, actorBind]))
      const variants = [
        (body: any) => { body.Image = 'sha256:other' },
        (body: any) => { body.Image = 'sha256:other-approved-image' },
        (body: any) => { body.HostConfig.Mounts[0].Source = '/tmp/owned/other-approved-host' },
        (body: any) => { body.Labels = { 'com.freshell.managed': 'true' } },
        (body: any) => { body.HostConfig.Mounts[1].Source = 'freshell-provider-ffffffffffffffffffffffff' },
        (body: any) => { body.HostConfig.Mounts[0].Source = '/etc/passwd' },
        (body: any) => { body.HostConfig.Mounts[1].ReadOnly = false },
        (body: any) => { body.HostConfig.Mounts.push({ Type: 'bind', Source: '/tmp/owned/control', Target: '/run/freshell', ReadOnly: false }) },
        (body: any) => { body.Cmd[0] = 'serve' },
        (body: any) => { body.Entrypoint = ['/bin/sh'] },
        (body: any) => { body.Cmd[6] = '/other/home' },
        (body: any) => { body.HostConfig.NetworkMode = 'bridge' },
      ]
      for (const mutate of variants) {
        const body = historyHelperBody()
        mutate(body)
        const before = forwarded.length
        expect((await request('POST', `/v1.47/containers/create?name=${helperName}`, body)).status).toBe(403)
        expect(forwarded).toHaveLength(before)
      }
      const before = forwarded.length
      expect((await request('POST', '/v1.47/containers/create?name=arbitrary', historyHelperBody())).status).toBe(403)
      expect((await request('POST', `/v1.47/containers/${'f'.repeat(64)}/stop`)).status).toBe(403)
      expect(forwarded).toHaveLength(before)
    })
  })
  it('cleans only the reserved owned helper name after a lost create acknowledgement', async () => {
    await withHttpBroker(async ({ request, forwarded, broker, loseHelperAck }) => {
      await request('POST', '/v1.47/containers/create?name=owned-runtime', createBody([...ordinaryBinds, actorBind]))
      loseHelperAck()
      expect((await request('POST', `/v1.47/containers/create?name=${helperName}`, historyHelperBody())).status).toBe(503)
      expect(broker.receiptIds().has(helperId)).toBe(false)
      expect(broker.historyHelperNames()).toEqual([helperName])
      const before = forwarded.length
      expect((await request('DELETE', '/v1.47/containers/freshell-history-22222222-2222-4222-8222-222222222222?force=1')).status).toBe(403)
      expect((await request('POST', `/v1.47/containers/${helperId}/start`)).status).toBe(403)
      expect((await request('POST', `/v1.47/containers/${helperId}/wait`)).status).toBe(403)
      expect((await request('GET', `/v1.47/containers/${helperId}/json`)).status).toBe(403)
      expect((await request('GET', `/v1.47/containers/${helperId}/logs?stderr=1&stdout=1`)).status).toBe(403)
      expect(forwarded).toHaveLength(before)
      expect((await request('DELETE', `/v1.47/containers/${helperName}?force=1`)).status).toBe(204)
      expect(forwarded.at(-1)?.url).toBe(`/v1.47/containers/${helperName}?force=1`)
    })
  })
  it('refuses a non-full helper acknowledgement while retaining exact reserved-name cleanup', async () => {
    await withHttpBroker(async ({ request, forwarded, broker, returnHelperId }) => {
      await request('POST', '/v1.47/containers/create?name=owned-runtime', createBody([...ordinaryBinds, actorBind]))
      returnHelperId('short-id')
      expect((await request('POST', `/v1.47/containers/create?name=${helperName}`, historyHelperBody())).status).toBe(503)
      expect([...broker.receiptIds()]).toEqual([ownedId])
      const before = forwarded.length
      expect((await request('POST', '/v1.47/containers/short-id/start')).status).toBe(403)
      expect((await request('POST', '/v1.47/containers/short-id/wait')).status).toBe(403)
      expect((await request('GET', '/v1.47/containers/short-id/json')).status).toBe(403)
      expect((await request('GET', '/v1.47/containers/short-id/logs?stderr=1&stdout=1')).status).toBe(403)
      expect(forwarded).toHaveLength(before)
      expect((await request('DELETE', `/v1.47/containers/${helperName}?force=1`)).status).toBe(204)
    })
  })

})

const negativeLegacyId = 'c'.repeat(64)
function originalLegacyInspection() {
  return { Id: ownedId, Image: 'sha256:fixture-image',
    Config: { Labels: JSON.parse(createBody([...ordinaryBinds, actorBind]).toString()).Labels } }
}
function negativeLegacyInspection() {
  const original = originalLegacyInspection()
  return { ...original, Id: negativeLegacyId, State: { Status: 'created', Running: false, Pid: 0 },
    Config: { Labels: { ...original.Config.Labels, 'com.freshell.task2-negative': 'foreign_binary' } } }
}

describe('finite Task2 legacy negative inspector admission', () => {
  it('forwards only exact bound inspection without granting start, controls, discovery or writer receipts', async () => {
    await withHttpBroker(async ({ request, forwarded, broker }) => {
      expect((await request('POST', '/v1.47/containers/create?name=owned-runtime', createBody([...ordinaryBinds, actorBind]))).status).toBe(201)
      const beforeUnbound = forwarded.length
      expect((await request('GET', `/v1.47/containers/${negativeLegacyId}/json`)).status).toBe(403)
      expect(forwarded).toHaveLength(beforeUnbound)
      broker.admitTask2LegacyNegativeInspection(negativeLegacyInspection(), originalLegacyInspection())
      expect((await request('GET', `/v1.47/containers/${negativeLegacyId}/json`))).toMatchObject({
        status: 200, body: JSON.stringify(negativeLegacyInspection()),
      })
      expect(forwarded.at(-1)).toMatchObject({ method: 'GET', url: `/v1.47/containers/${negativeLegacyId}/json` })
      expect(broker.eventsSnapshot().at(-1)).toMatchObject({ severity: 'info', decision: 'forward', destructive: false,
        containerId: negativeLegacyId, ownerContainerId: ownedId })
      expect(broker.receipts()).toHaveLength(1)
      expect([...broker.receiptIds()]).toEqual([ownedId])
      for (const [method, url] of [
        ...['start', 'stop', 'kill', 'unpause', 'update'].map(action => ['POST', `/v1.47/containers/${negativeLegacyId}/${action}`]),
        ['DELETE', `/v1.47/containers/${negativeLegacyId}?force=1`],
        ['GET', `/v1.47/containers/${negativeLegacyId}/logs?stdout=1`],
        ['GET', `/v1.47/containers/${'f'.repeat(64)}/json`],
        ['GET', '/v1.47/containers/json'],
        ['POST', `/v1.47/containers/${negativeLegacyId}/create`],
      ] as [string, string][]) {
        const before = forwarded.length
        expect((await request(method, url)).status).toBe(403)
        expect(forwarded).toHaveLength(before)
      }
      broker.forgetTask2LegacyNegativeInspection(negativeLegacyId)
      const beforeRevoke = forwarded.length
      expect((await request('GET', `/v1.47/containers/${negativeLegacyId}/json`)).status).toBe(403)
      expect(forwarded).toHaveLength(beforeRevoke)
    }, { allowTask2LegacyNegativeFixtures: true })
  })

  it('requires an opted-in finite rig, existing receipt owner, exact labels/image/full ID and never-started state', async () => {
    await withHttpBroker(async ({ request, broker }) => {
      await request('POST', '/v1.47/containers/create?name=owned-runtime', createBody([...ordinaryBinds, actorBind]))
      expect(() => broker.admitTask2LegacyNegativeInspection(negativeLegacyInspection(), originalLegacyInspection())).toThrow()
    })
    await withHttpBroker(async ({ request, broker }) => {
      expect(() => broker.admitTask2LegacyNegativeInspection(negativeLegacyInspection(), originalLegacyInspection())).toThrow()
      await request('POST', '/v1.47/containers/create?name=owned-runtime', createBody([...ordinaryBinds, actorBind]))
      const modifications = [
        (body: any) => { body.Id = 'short-id' },
        (body: any) => { body.Id = ownedId },
        (body: any) => { body.Image = 'sha256:foreign' },
        (body: any) => { body.State.Status = 'exited' },
        (body: any) => { body.State.Running = true },
        (body: any) => { body.State.Pid = 1234 },
        ...['runtime-test-run-id', 'soul-id', 'incarnation-id', 'installation-id', 'task2-negative'].map(key =>
          (body: any) => { body.Config.Labels[`com.freshell.${key}`] = 'foreign' }),
      ]
      for (const modify of modifications) {
        const candidate = negativeLegacyInspection()
        modify(candidate)
        expect(() => broker.admitTask2LegacyNegativeInspection(candidate, originalLegacyInspection())).toThrow()
      }
      expect(() => broker.admitTask2LegacyNegativeInspection(negativeLegacyInspection(), {
        ...originalLegacyInspection(), Id: 'f'.repeat(64),
      })).toThrow()
      expect([...broker.receiptIds()]).toEqual([ownedId])
      broker.admitTask2LegacyNegativeInspection(negativeLegacyInspection(), originalLegacyInspection())
      expect(() => broker.admitTask2LegacyNegativeInspection(negativeLegacyInspection(), originalLegacyInspection())).toThrow()
    }, { allowTask2LegacyNegativeFixtures: true })
  })
})

it('retains bounded redacted structured callback diagnostics for failed provider cases', () => {
  const secret = 'owned-callback-control-value'
  const logs = [
    'not structured',
    JSON.stringify({ level: 'INFO', fields: { message: 'ordinary startup' } }),
    ...Array.from({ length: 70 }, (_, n) => JSON.stringify({ level: 'WARN', target: 'freshell_server',
      fields: { message: 'managed_mcp.callback_failed', error: `candidate reader failed ${n}; ${secret}; Bearer hidden-token`, payload: 'private provider bytes' } })),
    JSON.stringify({ severity: 'error', event: 'session_host.fatal', error: 'native startup failure' }),
  ].join('\n')
  const retained = providerParityFailureLogTail(logs, [secret])
  expect(retained).toHaveLength(32)
  expect(retained.at(-2)).toMatchObject({ severity: 'warn', event: 'managed_mcp.callback_failed',
    error: 'candidate reader failed 69; [redacted]; Bearer [redacted]' })
  expect(retained.at(-1)).toMatchObject({ severity: 'error', event: 'session_host.fatal', error: 'native startup failure' })
  expect(JSON.stringify(retained)).not.toContain(secret)
  expect(JSON.stringify(retained)).not.toContain('private provider bytes')
  expect(JSON.stringify(retained)).not.toContain('hidden-token')
  const boundary = providerParityFailureLogTail(JSON.stringify({ severity: 'error', event: 'callback_failed',
    error: 'x'.repeat(4080) + secret }), [secret])
  expect(JSON.stringify(boundary)).not.toContain(secret.slice(0, 12))
})
