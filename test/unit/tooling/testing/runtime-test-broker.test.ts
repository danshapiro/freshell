import { createHash } from 'node:crypto'
import os from 'node:os'
import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { RestrictedDockerBroker, type ClaudeCandidateAuthorization, type PreparedInputAuthorization } from '../../../../scripts/testing/runtime-test-broker.js'

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
  loseCandidateVolumeAck(): void
  replaceCandidateVolumeInspection(): void
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
      expect((await request('POST',`/v1.47/containers/create?name=${name}`,body)).status).toBe(201);
      const before=forwarded.length;
      for (const mutate of [
        (value:any)=>value.HostConfig.CapAdd.push('DAC_OVERRIDE'),
        (value:any)=>value.Cmd.push('/outside'),
        (value:any)=>value.HostConfig.Mounts[1].Source='freshell-provider-ffffffffffffffffffffffff',
        (value:any)=>value.HostConfig.Mounts[1].VolumeOptions.NoCopy=false,
        (value:any)=>value.HostConfig.Mounts.push({Type:'bind',Source:'/operator-home',Target:'/outside',ReadOnly:false}),
        (value:any)=>value.Labels['com.freshell.soul-id']='foreign',
      ]) {
        const changed=structuredClone(body);mutate(changed);
        expect((await request('POST',`/v1.47/containers/create?name=${name.replace('111111111111','222222222222')}`,changed)).status).toBe(403);
        expect(forwarded).toHaveLength(before);
      }
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

async function withHttpBroker(run: (fixture: BrokerHttpFixture) => Promise<void>,gateways?:Set<string>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frs-broker-history-'))
  const socket = path.join(dir, 'docker.sock')
  const proxy = path.join(dir, 'broker.sock')
  const forwarded: ForwardedRequest[] = []
  let loseAck = false
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
      || (req.url===`/v1.47/containers/${helperId}/json` && forwarded.some((operation)=>operation.body?.Cmd?.[0]==='observe-claude-sources-private')))) {
      if (sourceHelperDeleted) { res.statusCode=404;res.end('{}');return }
      const command=req.url?.includes('/freshell-claude-source-') || req.url===`/v1.47/containers/${helperId}/json`?'observe-claude-sources-private':'publish-provider-inputs';
      const config=forwarded.findLast((request)=>request.url.includes('/containers/create?') && request.body?.Cmd?.[0]===command)!.body;
      const inspected=structuredClone(config);
      inspected.Labels['org.opencontainers.image.version']='24.04';
      // Docker reports an empty Tmpfs object as null on the retained reader.
      if (inspected.HostConfig.Tmpfs && Object.keys(inspected.HostConfig.Tmpfs).length === 0) inspected.HostConfig.Tmpfs = null;
      for (const mount of inspected.HostConfig.Mounts) if (mount.ReadOnly===false) delete mount.ReadOnly;
      res.statusCode=200;res.end(JSON.stringify({Id:helperId,Config:foreignHelper?{...inspected,User:'0:0'}:inspected,HostConfig:inspected.HostConfig}));return;
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
    await run({ request, forwarded, broker: instance, loseHelperAck: () => { loseAck = true }, returnHelperId: (id) => { helperAckId = id },replaceHelperInspection:()=>{foreignHelper=true},
      loseCandidateVolumeAck:()=>{candidateVolumeAckUnavailable=true},replaceCandidateVolumeInspection:()=>{candidateVolumeMetadata.Labels['com.freshell.soul-id']='foreign'} })
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
