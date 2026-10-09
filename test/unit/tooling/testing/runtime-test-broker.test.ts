import { createHash } from 'node:crypto'
import os from 'node:os'
import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { describe, expect, it } from 'vitest'

import { RestrictedDockerBroker } from '../../../../scripts/testing/runtime-test-broker.js'
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
  it('accepts the bounded private provider mount and the OpenCode exec mount', () => {
    const validate = (body: Buffer): { ok: boolean } => (
      broker() as unknown as { validateCreate(body: Buffer): { ok: boolean } }
    ).validateCreate(body)
    const base = { '/tmp': 'rw,noexec,nosuid,nodev,size=128m' }
    const privateTmp = { '/run/freshell-private': 'rw,noexec,nosuid,nodev,size=16m,mode=0700' }
    const opencodeTmp = { '/run/opencode-tmp': 'rw,exec,nosuid,nodev,size=64m,mode=1777' }

    const binds = [...ordinaryBinds, actorBind]
    expect(validate(createBody(binds, { ...base, ...privateTmp })).ok).toBe(true)
    expect(validate(createBody(binds, { ...base, ...privateTmp, ...opencodeTmp })).ok).toBe(true)
    expect(validate(createBody(binds, { ...base, '/run/freshell-private': 'rw,exec,nosuid,nodev,size=16m,mode=0700' })).ok).toBe(false)
    expect(validate(createBody(binds, { ...base, ...privateTmp, '/run/unapproved': 'rw' })).ok).toBe(false)
  })
})

describe('managed provider host gateway', () => {
  it('accepts the rootless daemon mapping to a local host address', () => {
    const validate = (body: Buffer): { ok: boolean } => (
      broker() as unknown as { validateCreate(body: Buffer): { ok: boolean } }
    ).validateCreate(body)
    const address = Object.values(os.networkInterfaces()).flatMap((interfaces) => interfaces ?? [])
      .find((network) => network.family === 'IPv4' && !network.internal)?.address
    expect(address).toBeDefined()

    expect(validate(createBody([...ordinaryBinds, actorBind], undefined, [`host.docker.internal:${address}`])).ok).toBe(true)
    expect(validate(createBody([...ordinaryBinds, actorBind], undefined, ['host.docker.internal:203.0.113.7'])).ok).toBe(false)
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

type ForwardedRequest = { method: string; url: string; body: any }
type BrokerHttpFixture = {
  request(method: string, url: string, body?: unknown, timeoutMs?: number): Promise<{ status: number; body: string }>
  forwarded: ForwardedRequest[]
  broker: RestrictedDockerBroker
  loseHelperAck(): void
  returnHelperId(id: string): void
}

async function withHttpBroker(run: (fixture: BrokerHttpFixture) => Promise<void>,
  options: { allowTask2LegacyNegativeFixtures?: boolean; delayHelperWait?: boolean; gitWorkspace?: string } = {},
) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frs-broker-history-'))
  const socket = path.join(dir, 'docker.sock')
  const proxy = path.join(dir, 'broker.sock')
  const forwarded: ForwardedRequest[] = []
  let loseAck = false
  let helperAckId = helperId
  let waitingResponse: http.ServerResponse | undefined
  const upstream = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const raw = Buffer.concat(chunks).toString()
    const body = raw ? JSON.parse(raw) : undefined
    forwarded.push({ method: req.method!, url: req.url!, body })
    if (req.url?.startsWith('/v1.47/containers/create?')) {
      if (body.Entrypoint?.[0] === '/runtime/freshell-session-host' && loseAck) {
        req.socket.destroy()
        return
      }
      res.statusCode = 201
      res.end(JSON.stringify({ Id: body.Entrypoint ? helperAckId : ownedId }))
      return
    }
    if (options.delayHelperWait && req.url?.includes('/wait?')) {
      waitingResponse = res
      return
    }
    if (req.method === 'DELETE' || req.url?.endsWith('/start') || req.url?.endsWith('/update')) {
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
    res.end(req.url?.includes('/wait?') ? '{"StatusCode":0}'
      : req.url?.includes('/logs?') ? '{"threadId":"native-owned"}' : JSON.stringify({ Name: providerVolume }))
  })
  const instance = new RestrictedDockerBroker({
    realSocketPath: socket,
    proxySocketPath: proxy,
    allowTask2LegacyNegativeFixtures: options.allowTask2LegacyNegativeFixtures,
    runtimeRootPrefix: '/tmp/owned/r',
    allowedHostBinaryPaths: new Set(['/tmp/owned/freshell-session-host', '/tmp/owned/other-approved-host']),
    allowedImageRefs: new Set(['sha256:fixture-image', 'sha256:other-approved-image', `sha256:${'b'.repeat(64)}`]),
    allowTerminalWorkloads: true,
    allowedWorkspaceRoots: new Set(['/workspace', ...(options.gitWorkspace ? [options.gitWorkspace] : [])]),
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
    await run({ request, forwarded, broker: instance, loseHelperAck: () => { loseAck = true }, returnHelperId: (id) => { helperAckId = id } })
  } finally {
    upstream.closeAllConnections()
    await instance.close()
    await new Promise<void>((resolve) => upstream.close(() => resolve()))
    await fs.rm(dir, { recursive: true, force: true })
  }
}

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
  it('admits only the fixed Node native reader on the exact receipt workspace and read-only provider source', async () => {
    await withHttpBroker(async ({ request, forwarded, broker }) => {
      await request('POST', '/v1.47/containers/create?name=owned-runtime', createBody([...ordinaryBinds, actorBind]))
      const body = () => {
        const original = historyHelperBody()
        return { ...original, Entrypoint: ['node'], WorkingDir: '/workspace',
          Cmd: ['--no-warnings', '--import', '/workspace/node_modules/tsx/dist/loader.mjs',
            '/workspace/test/e2e-browser/helpers/provider-native-history/probe-cli.ts', 'codex', '/home/freshell/provider/.codex/sessions', 'native-owned'],
          HostConfig: { ...original.HostConfig, Mounts: [original.HostConfig.Mounts[1],
            { Type: 'bind', Source: '/workspace', Target: '/workspace', ReadOnly: true }] } }
      }
      const mutations: ((input: ReturnType<typeof body>) => void)[] = [
        input => { input.Entrypoint = ['/bin/sh'] },
        input => { input.Cmd[0] = '-e' },
        input => { input.Cmd[2] = '/workspace/other-loader.js' },
        input => { input.Cmd[3] = '/workspace/other-probe.ts' },
        input => { input.Cmd[4] = 'foreign-provider' },
        input => { input.Cmd[5] = '/home/freshell/provider/foreign-source' },
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
