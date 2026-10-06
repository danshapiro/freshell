import { createHash } from 'node:crypto'
import os from 'node:os'
import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { RestrictedDockerBroker } from '../../../../scripts/testing/runtime-test-broker.js'

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
  request(method: string, url: string, body?: unknown): Promise<{ status: number; body: string }>
  forwarded: ForwardedRequest[]
  broker: RestrictedDockerBroker
  loseHelperAck(): void
  returnHelperId(id: string): void
}

async function withHttpBroker(run: (fixture: BrokerHttpFixture) => Promise<void>,
  options: { allowTask2LegacyNegativeFixtures?: boolean } = {},
) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frs-broker-history-'))
  const socket = path.join(dir, 'docker.sock')
  const proxy = path.join(dir, 'broker.sock')
  const forwarded: ForwardedRequest[] = []
  let loseAck = false
  let helperAckId = helperId
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
    if (req.method === 'DELETE' || req.url?.endsWith('/start') || req.url?.endsWith('/update')) {
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
    allowedWorkspaceRoots: new Set(['/workspace']),
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
    await run({ request, forwarded, broker: instance, loseHelperAck: () => { loseAck = true }, returnHelperId: (id) => { helperAckId = id } })
  } finally {
    await instance.close()
    await new Promise<void>((resolve) => upstream.close(() => resolve()))
    await fs.rm(dir, { recursive: true, force: true })
  }
}

describe('receipt-owned read-only history HTTP routes', () => {
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
