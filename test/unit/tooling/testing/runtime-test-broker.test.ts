import { createHash } from 'node:crypto'
import os from 'node:os'
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
