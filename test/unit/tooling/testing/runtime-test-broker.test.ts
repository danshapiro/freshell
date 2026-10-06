import { createHash } from 'node:crypto'
import os from 'node:os'
import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { RestrictedDockerBroker, type PreparedInputAuthorization } from '../../../../scripts/testing/runtime-test-broker.js'

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

describe('receipt-owned auth exchange HTTP routes', () => {
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
  request(method: string, url: string, body?: unknown): Promise<{ status: number; body: string }>
  forwarded: ForwardedRequest[]
  broker: RestrictedDockerBroker
  loseHelperAck(): void
  returnHelperId(id: string): void
  replaceHelperInspection():void
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

describe('fixed indexed publisher broker',()=>{
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

async function withHttpBroker(run: (fixture: BrokerHttpFixture) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frs-broker-history-'))
  const socket = path.join(dir, 'docker.sock')
  const proxy = path.join(dir, 'broker.sock')
  const forwarded: ForwardedRequest[] = []
  let loseAck = false
  let helperAckId = helperId
  let indexedVolumeMetadata:unknown
  let foreignHelper=false
  const upstream = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const raw = Buffer.concat(chunks).toString()
    const body = raw ? JSON.parse(raw) : undefined
    forwarded.push({ method: req.method!, url: req.url!, body })
    if (req.url==='/v1.47/volumes/create') {
      indexedVolumeMetadata={Name:body.Name,Driver:body.Driver,Options:body.DriverOpts,Labels:body.Labels};
      res.statusCode=201;res.end(JSON.stringify(indexedVolumeMetadata));return;
    }
    if (req.method==='GET' && req.url?.startsWith('/v1.47/volumes/freshell-inputs-') && indexedVolumeMetadata) {
      res.statusCode=200;res.end(JSON.stringify(indexedVolumeMetadata));return;
    }
    if (req.method==='GET' && req.url?.includes('-publisher/json')) {
      const config=forwarded.findLast((request)=>request.url.includes('/containers/create?') && request.body?.Cmd?.[0]==='publish-provider-inputs')!.body;
      res.statusCode=200;res.end(JSON.stringify({Config:foreignHelper?{...config,User:'0:0'}:config,HostConfig:config.HostConfig}));return;
    }
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
    res.statusCode = 200
    res.end(req.url?.includes('/wait?') ? '{"StatusCode":0}'
      : req.url?.includes('/logs?') ? '{"threadId":"native-owned"}' : JSON.stringify({ Name: providerVolume }))
  })
  const instance = new RestrictedDockerBroker({
    realSocketPath: socket,
    proxySocketPath: proxy,
    runtimeRootPrefix: '/tmp/owned/r',
    allowedHostBinaryPaths: new Set(['/tmp/owned/freshell-session-host', '/tmp/owned/other-approved-host']),
    allowedImageRefs: new Set(['sha256:fixture-image', 'sha256:other-approved-image']),
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
    await run({ request, forwarded, broker: instance, loseHelperAck: () => { loseAck = true }, returnHelperId: (id) => { helperAckId = id },replaceHelperInspection:()=>{foreignHelper=true} })
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
