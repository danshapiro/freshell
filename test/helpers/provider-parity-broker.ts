import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'

import type { InitialProviderVolumeAuthorization, RestrictedDockerBroker } from '../../scripts/testing/runtime-test-broker.js'
import type { RuntimeHarness } from '../../scripts/testing/runtime-sandbox.js'

/** The run-owned installation, session-host artifact, and daemon behind every initial provider volume. */
export type ProviderParitySource = Omit<InitialProviderVolumeAuthorization, 'soulId' | 'providerVolumeName'>

/** `FreshProvider::as_str()` in crates/freshell-runtime-protocol. */
export type FreshAgentRuntimeProvider = 'claude' | 'kilroy' | 'codex' | 'opencode'

/** `stable_hex` in crates/freshell-server (managed_runtime.rs and fresh_agent_proxy.rs). */
function stableHex(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32)
}

/** `stable_soul_id` in crates/freshell-server/src/managed_runtime.rs, keyed by the create request id. */
function managedTerminalSoulId(requestId: string): string {
  return `soul-terminal-${stableHex(requestId)}`
}

/** `stable_soul_id` in crates/freshell-server/src/fresh_agent_proxy.rs, keyed by the create request id. */
function freshAgentSoulId(provider: FreshAgentRuntimeProvider, requestId: string): string {
  return `soul-fresh-${provider}-${stableHex(requestId)}`
}

/** `stable_provider_volume_name` in crates/freshell-supervisor/src/registry.rs. */
function providerVolumeName(installationId: string, soulId: string): string {
  return `freshell-provider-${createHash('sha256').update(`${installationId}\0${soulId}`).digest('hex').slice(0, 24)}`
}

function authorizeProviderParitySoul(
  broker: RestrictedDockerBroker,
  source: ProviderParitySource,
  soulId: string,
): InitialProviderVolumeAuthorization {
  const authorization = { ...source, soulId, providerVolumeName: providerVolumeName(source.installationId, soulId) }
  broker.authorizeInitialProviderVolume(authorization)
  return authorization
}

/** Register a managed terminal create before its first initial-volume observation. */
export function authorizeProviderParityRequest(
  broker: RestrictedDockerBroker,
  source: ProviderParitySource,
  requestId: string,
): InitialProviderVolumeAuthorization {
  return authorizeProviderParitySoul(broker, source, managedTerminalSoulId(requestId))
}

/** Register a hosted fresh-agent create before its first initial-volume observation. */
export function authorizeFreshAgentParityRequest(
  broker: RestrictedDockerBroker,
  source: ProviderParitySource,
  provider: FreshAgentRuntimeProvider,
  requestId: string,
): InitialProviderVolumeAuthorization {
  return authorizeProviderParitySoul(broker, source, freshAgentSoulId(provider, requestId))
}

/** Read this run's provider source through its own broker after the supervisor reports its installation. */
export async function readProviderParitySource(
  runtime: Pick<RuntimeHarness, 'broker' | 'imageRef' | 'testHostBinary'>,
  installationId: string,
): Promise<ProviderParitySource> {
  const daemon = await new Promise<{ ID: string }>((resolve, reject) => {
    const request = http.get({ socketPath: runtime.broker.proxySocketPath, path: '/v1.47/info' }, response => {
      const chunks: Buffer[] = []
      let size = 0
      response.on('data', chunk => {
        size += chunk.length
        if (size > 64 * 1024) request.destroy(new Error('owned daemon metadata exceeds fixture bound'))
        else chunks.push(Buffer.from(chunk))
      })
      response.once('error', reject)
      response.once('end', () => {
        try {
          if (response.statusCode !== 200) throw new Error('owned daemon metadata unavailable')
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        } catch (error) { reject(error) }
      })
    })
    request.once('error', reject)
  })
  return {
    installationId,
    imageRef: runtime.imageRef,
    hostBinaryPath: runtime.testHostBinary,
    binarySha256: createHash('sha256').update(fs.readFileSync(runtime.testHostBinary)).digest('hex'),
    daemonId: daemon.ID,
  }
}

type DockerCommand = (args: string[]) => string
type CapturedProviderVolume = { owner: InitialProviderVolumeAuthorization; labels: Record<string, string> }
const docker: DockerCommand = args => execFileSync('docker', args, {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1024 * 1024, timeout: 120_000,
})

function volumeExists(name: string, run: DockerCommand): boolean {
  return run(['volume', 'ls', '--filter', `name=^${name}$`, '--format', '{{.Name}}']).trim() === name
}

function ownedVolume(owner: InitialProviderVolumeAuthorization, run: DockerCommand): Record<string, string> {
  const value = JSON.parse(run(['volume', 'inspect', owner.providerVolumeName, '--format', '{{json .}}']))
  const labels = value.Labels ?? {}
  const expected = {
    'com.freshell.installation-id': owner.installationId, 'com.freshell.soul-id': owner.soulId,
    'freshell.input.daemon': owner.daemonId, 'freshell.input.image': owner.imageRef,
    'freshell.input.binary-sha256': owner.binarySha256, 'freshell.input.intent': '1',
    'freshell.input.reservation': labels['freshell.input.reservation'],
    'freshell.input.incarnation': labels['freshell.input.incarnation'],
  }
  if (value.Name !== owner.providerVolumeName || value.Driver !== 'local'
    || (value.Options && Object.keys(value.Options).length)
    || Object.keys(labels).length !== Object.keys(expected).length
    || !Object.entries(expected).every(([key, value]) => labels[key] === value)
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(labels['freshell.input.reservation'])
    || !/^[a-zA-Z0-9_-]{1,128}$/.test(labels['freshell.input.incarnation'])) {
    throw new Error('registered provider volume ownership changed; retain it')
  }
  return labels
}

/** Capture before rig.stop removes the run-owned binary copies. */
export function captureProviderParityVolumes(owners: InitialProviderVolumeAuthorization[], run = docker): CapturedProviderVolume[] {
  return owners.flatMap(owner => {
    if (!volumeExists(owner.providerVolumeName, run)) return []
    const binary = fs.lstatSync(owner.hostBinaryPath)
    if (!binary.isFile() || binary.isSymbolicLink() || binary.size > 128 * 1024 * 1024
      || createHash('sha256').update(fs.readFileSync(owner.hostBinaryPath)).digest('hex') !== owner.binarySha256
      || run(['info', '--format', '{{.ID}}']).trim() !== owner.daemonId) {
      throw new Error('registered provider volume artifact or daemon changed; retain it')
    }
    return [{ owner, labels: ownedVolume(owner, run) }]
  })
}

/** Called only after rig.stop joins its workloads; never force or prune. */
export function cleanupProviderParityVolumes(volumes: CapturedProviderVolume[], run = docker): string[] {
  const removed: string[] = []
  for (const { owner, labels } of volumes) {
    if (!volumeExists(owner.providerVolumeName, run)) continue
    const current = ownedVolume(owner, run)
    if (!Object.entries(labels).every(([key, value]) => current[key] === value)
      || run(['info', '--format', '{{.ID}}']).trim() !== owner.daemonId
      || run(['container', 'ls', '-a', '--filter', `volume=${owner.providerVolumeName}`, '--format', '{{.ID}}']).trim()) {
      throw new Error('registered provider volume remains attached or changed; retain it')
    }
    run(['volume', 'rm', owner.providerVolumeName])
    if (volumeExists(owner.providerVolumeName, run)) throw new Error('registered provider volume cleanup not confirmed')
    removed.push(owner.providerVolumeName)
  }
  return removed
}
