import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'

import type { InitialProviderVolumeAuthorization, RestrictedDockerBroker } from '../../scripts/testing/runtime-test-broker.js'

export function authorizeProviderParityRequest(
  broker: RestrictedDockerBroker,
  source: Omit<InitialProviderVolumeAuthorization, 'soulId' | 'providerVolumeName'>,
  requestId: string,
): InitialProviderVolumeAuthorization {
  const soulId = `soul-terminal-${createHash('sha256').update(requestId).digest('hex').slice(0, 32)}`
  const providerVolumeName = `freshell-provider-${createHash('sha256').update(`${source.installationId}\0${soulId}`).digest('hex').slice(0, 24)}`
  const authorization = { ...source, soulId, providerVolumeName }
  broker.authorizeInitialProviderVolume(authorization)
  return authorization
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
