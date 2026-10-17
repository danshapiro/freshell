import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { findInitialProviderVolume, type InitialProviderRegistrySource } from '../../../../scripts/testing/initial-provider-volume.js'

const { DatabaseSync }: typeof import('node:sqlite') = createRequire(import.meta.url)('node:sqlite')
let directory: string
let source: InitialProviderRegistrySource
let db: InstanceType<typeof DatabaseSync>
const soul = 'soul-terminal-owned'
const volume = (installation: string) => `freshell-provider-${createHash('sha256').update(`${installation}\0${soul}`).digest('hex').slice(0, 24)}`

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'initial-provider-registry-'))
  source = { registryPath: path.join(directory, 'runtime.sqlite3'), installationId: 'installation-owned',
    imageRef: 'sha256:owned-image', hostBinaryPath: path.join(directory, 'host'), binarySha256: 'a'.repeat(64), daemonId: 'owned-daemon' }
  db = new DatabaseSync(source.registryPath)
  db.exec(`CREATE TABLE provider_input_preparations (
    soul_id TEXT, provider TEXT, image_ref TEXT, host_binary_path TEXT, host_binary_sha256 TEXT,
    intent_revision INTEGER, consumed INTEGER, bound_incarnation_id TEXT)`)
})
afterEach(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }) })

function publish(overrides: Partial<Record<string, string | number | null>> = {}) {
  const row = { soul_id: soul, provider: 'codex', image_ref: source.imageRef, host_binary_path: source.hostBinaryPath,
    host_binary_sha256: source.binarySha256, intent_revision: 1, consumed: 0, bound_incarnation_id: null, ...overrides }
  db.prepare(`INSERT INTO provider_input_preparations VALUES(?,?,?,?,?,?,?,?)`).run(
    row.soul_id, row.provider, row.image_ref, row.host_binary_path, row.host_binary_sha256,
    row.intent_revision, row.consumed, row.bound_incarnation_id,
  )
}

describe('owned initial provider publication', () => {
  it.each(['claude', 'kilroy', 'codex', 'opencode', 'amplifier'])('resolves only the exact %s volume after the native reservation is committed', provider => {
    const name = volume(source.installationId)
    expect(findInitialProviderVolume(name, [source])).toBeUndefined()
    publish({ provider })
    const { registryPath: _registry, ...owner } = source
    expect(findInitialProviderVolume(name, [source])).toEqual({ ...owner, soulId: soul, providerVolumeName: name })
    expect(findInitialProviderVolume(volume('foreign-installation'), [source])).toBeUndefined()
    expect(findInitialProviderVolume(name, [])).toBeUndefined()
  })

  it.each([
    { field: 'image_ref', value: 'sha256:foreign-image' },
    { field: 'host_binary_path', value: '/foreign/host' },
    { field: 'host_binary_sha256', value: 'b'.repeat(64) },
    { field: 'intent_revision', value: 2 },
    { field: 'consumed', value: 1 },
    { field: 'bound_incarnation_id', value: 'incarnation-owned' },
    { field: 'provider', value: 'unknown-provider' },
  ])('does not authorize a reservation with changed $field', ({ field, value }) => {
    publish({ [field]: value })
    expect(findInitialProviderVolume(volume(source.installationId), [source])).toBeUndefined()
  })
})
