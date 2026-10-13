import { createHash, randomBytes } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import os from 'node:os'
import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

import { RestrictedDockerBroker, type ClaudeCandidateAuthorization, type PreparedInputAuthorization } from '../../../../scripts/testing/runtime-test-broker.js'
import { authorizeProviderParityRequest, captureProviderParityVolumes, cleanupProviderParityVolumes } from '../../../helpers/provider-parity-broker.js'
import { makeProviderParityResourcesReadable, providerParityCommands, providerParityFailureDiagnostics, writeProviderParityEnvironment } from '../../../helpers/provider-parity-environment.js'

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
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', consumer, home, workspace, selectedTui], { encoding: 'utf8' })
      expect(child.error).toBeUndefined()
      expect(child.status, child.stderr).toBe(0)
      return JSON.parse(child.stdout)
    }
    for (const managed of [false, true]) {
      if (managed) await fs.writeFile(projected, JSON.stringify({ ...userConfig, mcp: { ...userConfig.mcp,
        freshell: { type: 'local', command: ['actual-mcp', 'argument'] } } }))
      else await fs.unlink(projected).catch(() => {})
      const spec = pathToFileURL(managed ? packageRoot : entry).href
      await fs.writeFile(selectedTui, JSON.stringify({ theme: 'selected', plugin: ['file:///selected/user-plugin.js', spec] }))
      const observed = inspect()
      expect(JSON.parse(observed.projectedProjectConfig)).toEqual(userConfig)
      expect(observed.rebindPlugin).toMatchObject({ spec, hello: true, sessionId: 'ses_parity' })
      expect(JSON.parse(observed.tuiConfig)).toEqual({ theme: 'selected', plugin: ['file:///selected/user-plugin.js', spec] })
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
    JSON.stringify({ event: 'session_host.fatal', error: `provider refresh control ${secret}` }),
    JSON.stringify({ event: 'session_host.fatal', error: secret }),
  ].join('\n')
  const diagnostic = providerParityFailureDiagnostics(logs)
  expect(diagnostic).toMatchObject({
    transactionFailures: [{ stage: 'publish', operation: 'install', errno: 'cross_device' }],
    workerFailures: [{ operation: 'control', errno: 'unknown' }, { operation: 'unknown', errno: 'unknown' }],
  })
  expect(diagnostic.transactionEvents).toEqual([
    { event: 'provider.projection.transaction.started', stage: 'stage' },
    { event: 'provider.projection.transaction.failed', stage: 'publish' },
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
      CapAdd: ['CHOWN', 'SETGID', 'SETUID'],
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
          {providerRelativePath:'.freshell/provider-roots/instructions-0/source',effectiveDestination:'/workspace/instructions.md',kind:'file'}],
        indexedFiles:{volumeName,aliases:[{sourceId:0,effectiveDestination:'/workspace/selected-input'}]},
        indexedSecretSources:[{grantIndex:1,sourceId:0}],
      };
      instance.authorizePreparedInputs(authorization);
      const body=JSON.parse(createBody([...ordinaryBinds,actorBind]).toString());
      body.HostConfig.Mounts=[
        {Type:'bind',Source:`${authorization.stageRoot}/.freshell/templates/source-0`,Target:'/workspace/opencode.json',ReadOnly:true},
        {Type:'volume',Source:providerVolume,Target:'/workspace/plugin',ReadOnly:false,VolumeOptions:{NoCopy:true,Subpath:'.freshell/provider-roots/plugin-0'}},
        {Type:'volume',Source:volumeName,Target:'/workspace/selected-input',ReadOnly:true,VolumeOptions:{NoCopy:true,Subpath:'files/source-0'}},
        {Type:'volume',Source:volumeName,Target:'/run/freshell-secrets/provider-1',ReadOnly:true,VolumeOptions:{NoCopy:true,Subpath:'files/source-0'}},
        {Type:'volume',Source:providerVolume,Target:'/workspace/instructions.md',ReadOnly:true,VolumeOptions:{NoCopy:true,Subpath:'.freshell/provider-roots/instructions-0/source'}},
      ];
      expect((await request('POST','/v1.47/containers/create?name=owned-prepared',body)).status).toBe(201);
      expect(forwarded).toHaveLength(1);
      for (const mutation of ['source','target','writable','subpath','nocopy','missing','empty','duplicate','owner','image','volume']) {
        const changed=structuredClone(body);
        if (mutation==='source') changed.HostConfig.Mounts[0].Source='/var/run/docker.sock';
        if (mutation==='target') changed.HostConfig.Mounts[0].Target='/run/freshell';
        if (mutation==='writable') changed.HostConfig.Mounts[2].ReadOnly=false;
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
  it('observes retained sources through the exact frozen ordinary aliases and read-only owned HOME', async () => {
    await withHttpBroker(async ({request, forwarded, broker: instance}) => {
      const input = candidateAuthorization(), body = sourceHelperBody()
      instance.authorizeInitialProviderVolume(sourceAuthorization())
      instance.authorizeClaudeCandidate(input)
      body.HostConfig.Tmpfs = {}
      body.HostConfig.Mounts.push(
        {Type:'volume',Source:input.providerVolumeName,Target:'/home/freshell/provider',ReadOnly:true,VolumeOptions:{NoCopy:true}},
        ...input.configurationBinds.map(bind => ({Type:'bind',Source:`${input.stageRoot}/${bind.sourceRelativePath}`,Target:bind.effectiveDestination,ReadOnly:true})),
        ...input.resourceMounts.map(unit => ({Type:'volume',Source:input.providerVolumeName,Target:unit.effectiveDestination,ReadOnly:true,VolumeOptions:{NoCopy:true,Subpath:unit.providerRelativePath}})),
      )
      const before = forwarded.length
      for (const mutation of ['home-write','foreign-home','alias-write','alias-subpath','alias-source','missing-alias','native-history']) {
        const changed = structuredClone(body)
        if (mutation === 'home-write') changed.HostConfig.Mounts[3].ReadOnly = false
        if (mutation === 'foreign-home') changed.HostConfig.Mounts[3].Source = 'foreign-home'
        if (mutation === 'alias-write') changed.HostConfig.Mounts.at(-1).ReadOnly = false
        if (mutation === 'alias-subpath') changed.HostConfig.Mounts.at(-1).VolumeOptions.Subpath = '.claude/projects'
        if (mutation === 'alias-source') changed.HostConfig.Mounts[4].Source = `${input.stageRoot}/.freshell/mcp-capability.json`
        if (mutation === 'missing-alias') changed.HostConfig.Mounts.pop()
        if (mutation === 'native-history') changed.HostConfig.Mounts.push({Type:'volume',Source:input.providerVolumeName,Target:'/history',ReadOnly:true,VolumeOptions:{NoCopy:true,Subpath:'.claude/projects'}})
        expect((await request('POST',`/v1.47/containers/create?name=${sourceName}`,changed)).status,mutation).toBe(403)
        expect(forwarded).toHaveLength(before)
      }
      expect((await request('POST',`/v1.47/containers/create?name=${sourceName}`,body)).status).toBe(201)
      expect((await request('GET',`/v1.47/containers/${helperId}/json`)).status).toBe(200)
      expect((await request('POST',`/v1.47/containers/${helperId}/start`)).status).toBe(204)
      expect((await request('POST',`/v1.47/containers/${helperId}/wait?condition=not-running`)).status).toBe(200)
      expect((await request('DELETE',`/v1.47/containers/${helperId}?force=1`)).status).toBe(204)
      expect((await request('GET',`/v1.47/containers/${helperId}/json`)).status).toBe(404)
    })
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

type ForwardedRequest = { method: string; url: string; body: any }
type BrokerHttpFixture = {
  directory: string
  setRuntimeRunning:(running:boolean)=>void
  request(method: string, url: string, body?: unknown): Promise<{ status: number; body: string }>
  forwarded: ForwardedRequest[]
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
  reservationId: string, provider: 'claude' | 'codex') {
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
  it('probes actual candidate absence before creation only with a qualified owned publication', async () => {
    await withHttpBroker(async ({ directory, request, forwarded, broker: instance, replaceCandidateVolumeInspection, clearCandidateVolumeInspection }) => {
      const input = candidateAuthorization()
      const binary = Buffer.from('candidate absence host artifact')
      input.hostBinaryPath = path.join(directory, 'freshell-session-host')
      await fs.writeFile(input.hostBinaryPath, binary)
      input.binarySha256 = createHash('sha256').update(binary).digest('hex')
      input.stageRoot = path.join(directory, 'scenarios/scenario/control/provider-roots', input.generationId)
      const { metadata, context, contextBytes, resultBytes } = await publishControllerPreparation(directory, input, input.reservationId, 'claude')
      const binding = { version: 1, provider: 'claude', soulId: input.soulId, generationId: input.generationId,
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
  it('registers the exact owned published Claude candidate before its ordinary volume request', async () => {
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
        version: 1, provider: 'claude', soulId: input.soulId, generationId: input.generationId,
        initialReservationId: input.reservationId, intentRevision: 1,
        workspacePath: input.workspacePath, cwd: input.cwd, gitCommonDir: null,
        manifestSha256: context.preparedInputs.manifest.sha256,
        preparedContextSha256: createHash('sha256').update(contextBytes).digest('hex'),
        preparedResultSha256: createHash('sha256').update(resultBytes).digest('hex'),
      }))
      const volume = { Name: `freshell-claude-candidate-${input.requestId}`, Driver: 'local', DriverOpts: {}, Labels: candidateLabels(input) }
      const bindingPath = path.join(metadata, 'claude-candidate-binding.json')
      const originalBinding = await fs.readFile(bindingPath)
      for (const field of ['soulId', 'generationId', 'initialReservationId', 'gitCommonDir', 'preparedContextSha256', 'preparedResultSha256', 'manifestSha256']) {
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
        resourceMounts: [{ providerRelativePath: '.freshell/provider-roots/root-0', effectiveDestination: '/home/freshell/provider/.codex/skills', kind: 'directory' as const }],
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

async function withHttpBroker(run: (fixture: BrokerHttpFixture) => Promise<void>,gateways?:Set<string>, physicalStage = false,
  allowedProviderInputRoots = new Set<string>()) {
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
    if (req.method==='GET' && req.url?.startsWith('/v1.47/volumes/freshell-inputs-') && indexedVolumeMetadata) {
      res.statusCode=200;res.end(JSON.stringify(indexedVolumeMetadata));return;
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
    if (req.method==='GET' && (req.url?.includes('-publisher/json') || req.url?.includes('/freshell-claude-source-')
      || (req.url===`/v1.47/containers/${helperId}/json` && forwarded.some((operation)=>['observe-claude-sources-private','publish-provider-inputs'].includes(operation.body?.Cmd?.[0]))))) {
      if (sourceHelperDeleted) { res.statusCode=404;res.end('{}');return }
      const command=req.url?.includes('-publisher/json') || (req.url===`/v1.47/containers/${helperId}/json` && forwarded.some(operation=>operation.body?.Cmd?.[0]==='publish-provider-inputs'))?'publish-provider-inputs':'observe-claude-sources-private';
      const config=forwarded.findLast((request)=>request.url.includes('/containers/create?') && request.body?.Cmd?.[0]===command)!.body;
      const inspected=structuredClone(config);
      inspected.Labels['org.opencontainers.image.version']='24.04';
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
    if (req.method === 'DELETE' || req.url?.endsWith('/start') || req.url?.endsWith('/update')) {
      if (req.method==='DELETE' && candidateCreation && req.url===`/v1.47/containers/${helperId}?force=1`) candidateHelperDeleted=true
      if (req.method==='DELETE' && (req.url===`/v1.47/containers/${helperId}?force=1` || req.url===`/v1.47/containers/${sourceName}?force=1`)) sourceHelperDeleted=true
      res.statusCode = 204
      res.end()
      return
    }
    res.statusCode = 200
    res.end(req.url?.includes('/wait?') ? '{"StatusCode":0}'
      : req.url?.includes('/logs?') ? '{"threadId":"native-owned"}' : JSON.stringify({ Name: providerVolume }))
  })
  const instance = new RestrictedDockerBroker({
    allowedHostGatewayAddresses:gateways,
    realSocketPath: socket,
    proxySocketPath: proxy,
    runtimeRootPrefix: physicalStage ? path.join(dir, 'r') : '/tmp/owned/r',
    allowedHostBinaryPaths: new Set(physicalStage ? [path.join(dir, 'freshell-session-host')] : ['/tmp/owned/freshell-session-host', '/tmp/owned/other-approved-host']),
    allowedImageRefs: new Set(['sha256:fixture-image', 'sha256:other-approved-image']),
    allowTerminalWorkloads: true,
    allowedWorkspaceRoots: new Set(['/workspace']),
    allowedProviderInputRoots,
    testRunId: 'run-one',
    logPath: path.join(dir, 'broker.jsonl'),
  })
  const request: BrokerHttpFixture['request'] = (method, url, body) => new Promise((resolve, reject) => {
    const req = http.request({ socketPath: proxy, path: url, method }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
      res.on('end', () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks).toString() }))
    })
    req.on('error', reject)
    req.end(body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body))
  })
  try {
    await new Promise<void>((resolve) => upstream.listen(socket, resolve))
    await instance.start()
    await run({ directory: dir, request, forwarded, broker: instance, setRuntimeRunning:(running)=>{runtimeRunning=running}, loseHelperAck: () => { loseAck = true }, rejectHelperCreate: () => { rejectHelper = true }, returnHelperId: (id) => { helperAckId = id },replaceHelperInspection:()=>{foreignHelper=true},
      loseCandidateVolumeAck:()=>{candidateVolumeAckUnavailable=true},replaceCandidateVolumeInspection:()=>{candidateVolumeMetadata ??= { Name: 'PRIVATE_FOREIGN_CANDIDATE', Driver: 'local', Labels: {} }; candidateVolumeMetadata.Labels['com.freshell.soul-id']='foreign'}, clearCandidateVolumeInspection:()=>{candidateVolumeMetadata=undefined} })
  } finally {
    await instance.close()
    await new Promise<void>((resolve) => upstream.close(() => resolve()))
    await fs.rm(dir, { recursive: true, force: true })
  }
}

describe('receipt-owned read-only history HTTP routes', () => {
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
      const before = forwarded.length
      expect((await request('DELETE', '/v1.47/containers/freshell-history-22222222-2222-4222-8222-222222222222?force=1')).status).toBe(403)
      expect((await request('POST', `/v1.47/containers/${helperId}/start`)).status).toBe(403)
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
      expect(forwarded).toHaveLength(before)
      expect((await request('DELETE', `/v1.47/containers/${helperName}?force=1`)).status).toBe(204)
    })
  })

})
