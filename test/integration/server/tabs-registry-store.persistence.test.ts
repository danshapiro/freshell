import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createReadStream, promises as fs } from 'fs'
import crypto from 'crypto'
import os from 'os'
import path from 'path'
import readline from 'readline'
import { createTabsRegistryStore } from '../../../server/tabs-registry/store.js'
import type { RegistryTabRecord } from '../../../server/tabs-registry/types.js'

const NOW = 1_740_000_000_000

function makeRecord(overrides: Partial<RegistryTabRecord>): RegistryTabRecord {
  return {
    tabKey: 'device-1:tab-1',
    tabId: 'tab-1',
    serverInstanceId: 'srv-test',
    deviceId: 'device-1',
    deviceLabel: 'danlaptop',
    tabName: 'freshell',
    status: 'open',
    revision: 1,
    createdAt: NOW - 10_000,
    updatedAt: NOW - 1_000,
    paneCount: 1,
    titleSetByUser: false,
    panes: [],
    ...overrides,
  }
}

async function lineCount(file: string): Promise<number> {
  const input = createReadStream(file)
  const lines = readline.createInterface({ input, crlfDelay: Infinity })
  let count = 0
  for await (const _line of lines) {
    count += 1
  }
  return count
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
  return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`).join(',')}}`
}

function objectFor(value: unknown) {
  const raw = stableStringify(value)
  const sha256 = crypto.createHash('sha256').update(raw).digest('hex')
  return {
    raw,
    ref: {
      path: `objects/${sha256}.json`,
      sha256,
      bytes: Buffer.byteLength(raw, 'utf-8'),
    },
  }
}

function clientSnapshotKey(deviceId: string, clientInstanceId: string): string {
  return `${Buffer.from(deviceId, 'utf-8').toString('base64url')}:${Buffer.from(clientInstanceId, 'utf-8').toString('base64url')}`
}

describe('tabs registry compact persistence', () => {
  let tempDir: string
  let now = NOW

  beforeEach(async () => {
    now = NOW
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tabs-registry-persist-'))
  })

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  it('persists manifest-referenced objects and rehydrates without active JSONL growth', async () => {
    const writer = await createTabsRegistryStore(tempDir, { now: () => now })
    const openRecord = makeRecord({
      tabKey: 'local:open-1',
      tabId: 'open-1',
      deviceId: 'local-device',
      deviceLabel: 'local',
      status: 'open',
      revision: 3,
      updatedAt: NOW - 5_000,
    })
    const closedRecord = makeRecord({
      tabKey: 'local:closed-1',
      tabId: 'closed-1',
      deviceId: 'local-device',
      deviceLabel: 'local',
      status: 'closed',
      revision: 5,
      closedAt: NOW - 5000,
      updatedAt: NOW - 5000,
    })

    await writer.replaceClientSnapshot({
      deviceId: 'local-device',
      deviceLabel: 'local',
      clientInstanceId: 'window-a',
      snapshotRevision: 1,
      records: [openRecord, closedRecord],
    })

    await expect(fs.stat(path.join(tempDir, 'tabs-registry.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.stat(path.join(tempDir, 'v1', 'manifest.json'))).resolves.toBeTruthy()

    const reader = await createTabsRegistryStore(tempDir, { now: () => now })
    const result = await reader.query({
      deviceId: 'local-device',
      clientInstanceId: 'window-a',
      closedTabRetentionDays: 30,
    })
    expect(result.localOpen.map((record) => record.tabKey)).toEqual([openRecord.tabKey])
    expect(result.closed.map((record) => record.tabKey)).toEqual([closedRecord.tabKey])
    expect(result.devices.map((device) => device.deviceId)).toContain('local-device')
  })

  it('ignores orphaned object and temp files on startup and garbage-collects them after commit', async () => {
    const writer = await createTabsRegistryStore(tempDir, { now: () => now })
    await writer.replaceClientSnapshot({
      deviceId: 'local-device',
      deviceLabel: 'local',
      clientInstanceId: 'window-a',
      snapshotRevision: 1,
      records: [
        makeRecord({ tabKey: 'local:open-1', tabId: 'open-1', deviceId: 'local-device', deviceLabel: 'local' }),
      ],
    })
    const orphanPath = path.join(tempDir, 'v1', 'objects', '0'.repeat(64) + '.json')
    const tmpPath = path.join(tempDir, 'v1', 'tmp', 'orphan.tmp')
    await fs.mkdir(path.dirname(orphanPath), { recursive: true })
    await fs.mkdir(path.dirname(tmpPath), { recursive: true })
    await fs.writeFile(orphanPath, '{"orphan":true}', 'utf-8')
    await fs.writeFile(tmpPath, '{"temp":true}', 'utf-8')

    const reader = await createTabsRegistryStore(tempDir, { now: () => now })
    const result = await reader.query({
      deviceId: 'local-device',
      clientInstanceId: 'window-a',
      closedTabRetentionDays: 30,
    })
    expect(result.localOpen).toHaveLength(1)

    await reader.replaceClientSnapshot({
      deviceId: 'local-device',
      deviceLabel: 'local',
      clientInstanceId: 'window-a',
      snapshotRevision: 2,
      records: [
        makeRecord({ tabKey: 'local:open-2', tabId: 'open-2', deviceId: 'local-device', deviceLabel: 'local' }),
      ],
    })
    await expect(fs.stat(orphanPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.stat(tmpPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('streams legacy JSONL migration, resolves latest per tab before pruning, and archives only after publish', async () => {
    const legacyPath = path.join(tempDir, 'tabs-registry.jsonl')
    await fs.mkdir(tempDir, { recursive: true })
    const oldOpen = makeRecord({
      tabKey: 'remote:a',
      tabId: 'a',
      deviceId: 'remote-device',
      deviceLabel: 'remote',
      status: 'open',
      revision: 99,
      updatedAt: NOW - 40 * 24 * 60 * 60 * 1000,
    })
    const oldClosedWinner = makeRecord({
      ...oldOpen,
      status: 'closed',
      revision: 1,
      updatedAt: NOW - 35 * 24 * 60 * 60 * 1000,
      closedAt: NOW - 35 * 24 * 60 * 60 * 1000,
    })
    const freshOpen = makeRecord({
      tabKey: 'remote:b',
      tabId: 'b',
      deviceId: 'remote-device',
      deviceLabel: 'remote',
      status: 'open',
      updatedAt: NOW - 365 * 24 * 60 * 60 * 1000,
    })
    await fs.writeFile(legacyPath, `${JSON.stringify(oldOpen)}\n${JSON.stringify(oldClosedWinner)}\n${JSON.stringify(freshOpen)}\n`, 'utf-8')

    const store = await createTabsRegistryStore(tempDir, { now: () => now })
    const result = await store.query({
      deviceId: 'local-device',
      clientInstanceId: 'window-a',
      closedTabRetentionDays: 30,
    })
    expect(result.remoteOpen.map((record) => record.tabKey)).toEqual(['remote:b'])
    expect(result.closed).toHaveLength(0)
    await expect(fs.stat(path.join(tempDir, 'v1', 'manifest.json'))).resolves.toBeTruthy()
    await expect(fs.stat(legacyPath)).rejects.toMatchObject({ code: 'ENOENT' })
    const files = await fs.readdir(tempDir)
    expect(files.some((file) => /^tabs-registry\.jsonl\.migrated-/.test(file))).toBe(true)
  })

  it('fails migration with a clear cap error before unbounded memory growth', async () => {
    const legacyPath = path.join(tempDir, 'tabs-registry.jsonl')
    await fs.mkdir(tempDir, { recursive: true })
    const largePanePayload = 'x'.repeat(300 * 1024)
    await fs.writeFile(legacyPath, `${JSON.stringify(makeRecord({
      tabKey: 'remote:large',
      tabId: 'large',
      deviceId: 'remote-device',
      deviceLabel: 'remote',
      panes: [{ paneId: 'pane-1', kind: 'terminal', payload: { largePanePayload } }],
    }))}\n`, 'utf-8')

    await expect(createTabsRegistryStore(tempDir, {
      now: () => now,
      caps: { maxLegacyLineBytes: 256 * 1024 },
    })).rejects.toThrow(/legacy.*line.*256 kib|migration.*cap/i)
    await expect(fs.stat(path.join(tempDir, 'v1', 'manifest.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await lineCount(legacyPath)).toBe(1)
  })

  it('fails legacy migration on valid records that exceed pane-count caps', async () => {
    const legacyPath = path.join(tempDir, 'tabs-registry.jsonl')
    await fs.writeFile(legacyPath, `${JSON.stringify(makeRecord({
      tabKey: 'remote:pane-cap',
      tabId: 'pane-cap',
      deviceId: 'remote-device',
      deviceLabel: 'remote',
      paneCount: 21,
      panes: Array.from({ length: 21 }, (_, i) => ({ paneId: `pane-${i}`, kind: 'terminal', payload: {} })),
    }))}\n`, 'utf-8')

    await expect(createTabsRegistryStore(tempDir, { now: () => now })).rejects.toThrow(/20 panes|migration/i)
    await expect(fs.stat(path.join(tempDir, 'v1', 'manifest.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await lineCount(legacyPath)).toBe(1)
  })

  it('fails legacy migration when migrated open device snapshots exceed the cap', async () => {
    const legacyPath = path.join(tempDir, 'tabs-registry.jsonl')
    const lines = Array.from({ length: 3 }, (_, i) => JSON.stringify(makeRecord({
      tabKey: `device-${i}:tab`,
      tabId: `tab-${i}`,
      deviceId: `device-${i}`,
      deviceLabel: `Device ${i}`,
    })))
    await fs.writeFile(legacyPath, `${lines.join('\n')}\n`, 'utf-8')

    await expect(createTabsRegistryStore(tempDir, {
      now: () => now,
      caps: { maxClientSnapshotRefs: 2 },
    })).rejects.toThrow(/migrated.*snapshots|client snapshots/i)
    await expect(fs.stat(path.join(tempDir, 'v1', 'manifest.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects corrupt compact state with a clear error instead of serving empty data', async () => {
    await fs.mkdir(path.join(tempDir, 'v1'), { recursive: true })
    await fs.writeFile(path.join(tempDir, 'v1', 'manifest.json'), '{"version":1,"openSnapshots":{}}', 'utf-8')

    await expect(createTabsRegistryStore(tempDir, { now: () => now })).rejects.toThrow(/tabs registry compact state.*invalid|manifest/i)
  })

  it('rejects compact open snapshot objects that contain closed records', async () => {
    await fs.mkdir(path.join(tempDir, 'v1', 'objects'), { recursive: true })
    const closedRecord = makeRecord({
      tabKey: 'local:closed-in-open',
      tabId: 'closed-in-open',
      deviceId: 'local-device',
      deviceLabel: 'local',
      status: 'closed',
      closedAt: NOW,
      updatedAt: NOW,
    })
    const snapshot = {
      deviceId: 'local-device',
      deviceLabel: 'local',
      clientInstanceId: 'window-a',
      snapshotRevision: 1,
      lastPushPayloadHash: '0'.repeat(64),
      snapshotReceivedAt: NOW,
      records: [closedRecord],
    }
    const snapshotObject = objectFor(snapshot)
    const closedObject = objectFor({})
    const devicesObject = objectFor({})
    for (const object of [snapshotObject, closedObject, devicesObject]) {
      await fs.writeFile(path.join(tempDir, 'v1', object.ref.path), object.raw, 'utf-8')
    }
    const manifest = {
      version: 1,
      manifestRevision: 1,
      committedAt: NOW,
      openSnapshots: { [clientSnapshotKey('local-device', 'window-a')]: snapshotObject.ref },
      closedTombstones: closedObject.ref,
      devices: devicesObject.ref,
      settings: { openSnapshotTtlMinutes: 30, deviceDisplayTtlDays: 7, maxClosedRetentionDays: 30 },
    }
    await fs.writeFile(path.join(tempDir, 'v1', 'manifest.json'), stableStringify(manifest), 'utf-8')

    await expect(createTabsRegistryStore(tempDir, { now: () => now })).rejects.toThrow(/open snapshot.*open records|compact state/i)
  })

  it('rejects compact state when manifest key does not match snapshot identity', async () => {
    await fs.mkdir(path.join(tempDir, 'v1', 'objects'), { recursive: true })
    const snapshot = {
      deviceId: 'local-device',
      deviceLabel: 'local',
      clientInstanceId: 'window-b',
      snapshotRevision: 1,
      lastPushPayloadHash: '0'.repeat(64),
      snapshotReceivedAt: NOW,
      records: [
        makeRecord({ tabKey: 'local:open', tabId: 'open', deviceId: 'local-device', deviceLabel: 'local' }),
      ],
    }
    const snapshotObject = objectFor(snapshot)
    const closedObject = objectFor({})
    const devicesObject = objectFor({})
    for (const object of [snapshotObject, closedObject, devicesObject]) {
      await fs.writeFile(path.join(tempDir, 'v1', object.ref.path), object.raw, 'utf-8')
    }
    const manifest = {
      version: 1,
      manifestRevision: 1,
      committedAt: NOW,
      openSnapshots: { [clientSnapshotKey('local-device', 'window-a')]: snapshotObject.ref },
      closedTombstones: closedObject.ref,
      devices: devicesObject.ref,
      settings: { openSnapshotTtlMinutes: 30, deviceDisplayTtlDays: 7, maxClosedRetentionDays: 30 },
    }
    await fs.writeFile(path.join(tempDir, 'v1', 'manifest.json'), stableStringify(manifest), 'utf-8')

    await expect(createTabsRegistryStore(tempDir, { now: () => now })).rejects.toThrow(/snapshot key.*identity|compact state/i)
  })

  it('rejects manifest object refs that exceed per-object caps before reading the object body', async () => {
    await fs.mkdir(path.join(tempDir, 'v1', 'objects'), { recursive: true })
    const oversizedSha = 'a'.repeat(64)
    const closedObject = objectFor({})
    const devicesObject = objectFor({})
    for (const object of [closedObject, devicesObject]) {
      await fs.writeFile(path.join(tempDir, 'v1', object.ref.path), object.raw, 'utf-8')
    }
    await fs.writeFile(path.join(tempDir, 'v1', 'objects', `${oversizedSha}.json`), '{}', 'utf-8')
    const manifest = {
      version: 1,
      manifestRevision: 1,
      committedAt: NOW,
      openSnapshots: {
        [clientSnapshotKey('local-device', 'window-a')]: {
          path: `objects/${oversizedSha}.json`,
          sha256: oversizedSha,
          bytes: 600 * 1024,
        },
      },
      closedTombstones: closedObject.ref,
      devices: devicesObject.ref,
      settings: { openSnapshotTtlMinutes: 30, deviceDisplayTtlDays: 7, maxClosedRetentionDays: 30 },
    }
    await fs.writeFile(path.join(tempDir, 'v1', 'manifest.json'), stableStringify(manifest), 'utf-8')

    await expect(createTabsRegistryStore(tempDir, { now: () => now })).rejects.toThrow(/object.*512 KiB|compact state/i)
  })

  it('validates an existing content-hash object before referencing it in a new manifest', async () => {
    const store = await createTabsRegistryStore(tempDir, { now: () => now })
    const record = makeRecord({
      tabKey: 'local:open-1',
      tabId: 'open-1',
      deviceId: 'local-device',
      deviceLabel: 'local',
    })
    const storedRecord = { ...record, clientInstanceId: 'window-a' }
    const snapshot = {
      deviceId: 'local-device',
      deviceLabel: 'local',
      clientInstanceId: 'window-a',
      snapshotRevision: 1,
      lastPushPayloadHash: crypto.createHash('sha256').update(stableStringify({
        deviceId: 'local-device',
        deviceLabel: 'local',
        clientInstanceId: 'window-a',
        snapshotRevision: 1,
        records: [record],
      })).digest('hex'),
      snapshotReceivedAt: NOW,
      records: [storedRecord],
    }
    const expectedObject = objectFor(snapshot)
    await fs.mkdir(path.join(tempDir, 'v1', 'objects'), { recursive: true })
    await fs.writeFile(path.join(tempDir, 'v1', expectedObject.ref.path), '{"wrong":true}', 'utf-8')

    await expect(store.replaceClientSnapshot({
      deviceId: 'local-device',
      deviceLabel: 'local',
      clientInstanceId: 'window-a',
      snapshotRevision: 1,
      records: [record],
    })).rejects.toThrow(/existing.*object.*hash/i)

    await expect(createTabsRegistryStore(tempDir, { now: () => now })).resolves.toBeTruthy()
  })

  it.each([
    ['object-write'],
    ['object-rename'],
    ['manifest-write'],
    ['manifest-rename'],
  ] as const)('keeps memory and startup-visible disk unchanged after %s failure', async (failAt) => {
    const writer = await createTabsRegistryStore(tempDir, { now: () => now })
    await writer.replaceClientSnapshot({
      deviceId: 'local-device',
      deviceLabel: 'local',
      clientInstanceId: 'window-a',
      snapshotRevision: 1,
      records: [
        makeRecord({ tabKey: 'local:before', tabId: 'before', deviceId: 'local-device', deviceLabel: 'local' }),
      ],
    })
    writer.setTestFailurePoint(failAt)
    await expect(writer.replaceClientSnapshot({
      deviceId: 'local-device',
      deviceLabel: 'local',
      clientInstanceId: 'window-a',
      snapshotRevision: 2,
      records: [
        makeRecord({ tabKey: 'local:after', tabId: 'after', deviceId: 'local-device', deviceLabel: 'local' }),
      ],
    })).rejects.toThrow(/injected/i)

    const live = await writer.query({
      deviceId: 'local-device',
      clientInstanceId: 'window-a',
      closedTabRetentionDays: 30,
    })
    expect(live.localOpen.map((record) => record.tabKey)).toEqual(['local:before'])

    const restarted = await createTabsRegistryStore(tempDir, { now: () => now })
    const rehydrated = await restarted.query({
      deviceId: 'local-device',
      clientInstanceId: 'window-a',
      closedTabRetentionDays: 30,
    })
    expect(rehydrated.localOpen.map((record) => record.tabKey)).toEqual(['local:before'])
  })

  it('allows concurrent queries to see old or new committed state, never a partial mutation', async () => {
    const store = await createTabsRegistryStore(tempDir, { now: () => now })
    await store.replaceClientSnapshot({
      deviceId: 'local-device',
      deviceLabel: 'local',
      clientInstanceId: 'window-a',
      snapshotRevision: 1,
      records: [
        makeRecord({ tabKey: 'local:before', tabId: 'before', deviceId: 'local-device', deviceLabel: 'local' }),
      ],
    })
    let releaseCommit: (() => void) | undefined
    store.setTestBeforeManifestPublishHook(() => new Promise<void>((resolve) => {
      releaseCommit = resolve
    }))

    const writePromise = store.replaceClientSnapshot({
      deviceId: 'local-device',
      deviceLabel: 'local',
      clientInstanceId: 'window-a',
      snapshotRevision: 2,
      records: [
        makeRecord({ tabKey: 'local:after', tabId: 'after', deviceId: 'local-device', deviceLabel: 'local' }),
      ],
    })
    await vi.waitFor(() => {
      expect(releaseCommit).toBeTypeOf('function')
    })

    const during = await store.query({
      deviceId: 'local-device',
      clientInstanceId: 'window-a',
      closedTabRetentionDays: 30,
    })
    expect(during.localOpen.map((record) => record.tabKey)).toEqual(['local:before'])

    releaseCommit?.()
    await writePromise
    const after = await store.query({
      deviceId: 'local-device',
      clientInstanceId: 'window-a',
      closedTabRetentionDays: 30,
    })
    expect(after.localOpen.map((record) => record.tabKey)).toEqual(['local:after'])
  })
})
