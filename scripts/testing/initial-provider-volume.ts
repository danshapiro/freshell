import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'

import type { InitialProviderVolumeAuthorization } from './runtime-test-broker.js'

const { DatabaseSync }: typeof import('node:sqlite') = createRequire(import.meta.url)('node:sqlite')

export type InitialProviderRegistrySource = Omit<InitialProviderVolumeAuthorization, 'soulId' | 'providerVolumeName'> & {
  registryPath: string
}

/** Resolve only an intent already committed by this run's owned supervisor. */
export function findInitialProviderVolume(
  volumeName: string, sources: readonly InitialProviderRegistrySource[],
): InitialProviderVolumeAuthorization | undefined {
  for (const source of sources) {
    const db = new DatabaseSync(source.registryPath, { readOnly: true })
    try {
      const rows = db.prepare(`SELECT soul_id FROM provider_input_preparations
        WHERE image_ref=? AND host_binary_path=? AND host_binary_sha256=?
        AND intent_revision=1 AND consumed=0 AND bound_incarnation_id IS NULL
        AND provider IN ('claude','kilroy','codex','opencode','amplifier') LIMIT 1001`)
        .all(source.imageRef, source.hostBinaryPath, source.binarySha256)
      if (rows.length > 1000) throw new Error('owned provider preparation lookup exceeds its finite bound')
      for (const row of rows) {
        if (typeof row.soul_id !== 'string') throw new Error('owned provider preparation identity is invalid')
        const expected = `freshell-provider-${createHash('sha256')
          .update(`${source.installationId}\0${row.soul_id}`).digest('hex').slice(0, 24)}`
        if (volumeName === expected) {
          const { registryPath: _registry, ...owner } = source
          return { ...owner, soulId: row.soul_id, providerVolumeName: volumeName }
        }
      }
    } finally { db.close() }
  }
  return undefined
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

/** Capture before owner cleanup removes the run-owned binary copies. */
export function captureInitialProviderVolumes(owners: InitialProviderVolumeAuthorization[], run = docker): CapturedProviderVolume[] {
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

/** Called only after the owner joins its workloads; never force or prune. */
export function cleanupInitialProviderVolumes(volumes: CapturedProviderVolume[], run = docker): string[] {
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
