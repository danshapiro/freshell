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

function pushHash(input: {
  deviceId: string
  deviceLabel: string
  clientInstanceId: string
  snapshotRevision: number
  records: unknown[]
}): string {
  return crypto.createHash('sha256').update(stableStringify(input)).digest('hex')
}

function makeClientSnapshotObject(input: {
  deviceId: string
  deviceLabel: string
  clientInstanceId: string
  snapshotRevision: number
  snapshotReceivedAt: number
  records: RegistryTabRecord[]
  lastPushPayloadHash?: string
}) {
  const openSnapshotPayloadHash = pushHash({
    deviceId: input.deviceId,
    deviceLabel: input.deviceLabel,
    clientInstanceId: input.clientInstanceId,
    snapshotRevision: input.snapshotRevision,
    records: input.records,
  })
  return objectFor({
    deviceId: input.deviceId,
    deviceLabel: input.deviceLabel,
    clientInstanceId: input.clientInstanceId,
    snapshotRevision: input.snapshotRevision,
    lastPushPayloadHash: input.lastPushPayloadHash ?? openSnapshotPayloadHash,
    openSnapshotPayloadHash,
    snapshotReceivedAt: input.snapshotReceivedAt,
    records: input.records,
  })
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

    const manifest = JSON.parse(await fs.readFile(path.join(tempDir, 'v1', 'manifest.json'), 'utf-8')) as {
      openSnapshots: Record<string, { path: string }>
      closedTombstones: { path: string }
    }
    const [snapshotRef] = Object.values(manifest.openSnapshots)
    const snapshotObject = JSON.parse(await fs.readFile(path.join(tempDir, 'v1', snapshotRef.path), 'utf-8')) as {
      records: RegistryTabRecord[]
      lastPushRecords?: RegistryTabRecord[]
    }
    expect(snapshotObject.records.map((record) => record.tabKey)).toEqual([openRecord.tabKey])
    expect(snapshotObject).not.toHaveProperty('lastPushRecords')
    const closedObject = JSON.parse(await fs.readFile(path.join(tempDir, 'v1', manifest.closedTombstones.path), 'utf-8')) as Record<string, RegistryTabRecord>
    expect(Object.keys(closedObject)).toEqual([closedRecord.tabKey])

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

  it('ignores orphaned object files on startup and cleans temp files after commit', async () => {
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
    await expect(fs.stat(orphanPath)).resolves.toBeDefined()
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

  it('fails migration when valid retained legacy records exceed the retained-byte budget', async () => {
    const legacyPath = path.join(tempDir, 'tabs-registry.jsonl')
    await fs.mkdir(tempDir, { recursive: true })
    const largePanePayload = 'x'.repeat(40 * 1024)
    const lines = Array.from({ length: 4 }, (_, i) => JSON.stringify(makeRecord({
      tabKey: `remote:large-${i}`,
      tabId: `large-${i}`,
      deviceId: 'remote-device',
      deviceLabel: 'remote',
      panes: [{ paneId: 'pane-1', kind: 'terminal', payload: { largePanePayload } }],
    })))
    await fs.writeFile(legacyPath, `${lines.join('\n')}\n`, 'utf-8')

    await expect(createTabsRegistryStore(tempDir, {
      now: () => now,
      caps: {
        maxLegacyLineBytes: 256 * 1024,
        maxMigrationRetainedBytes: 100 * 1024,
      },
    })).rejects.toThrow(/retained-byte cap/i)
    await expect(fs.stat(path.join(tempDir, 'v1', 'manifest.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await lineCount(legacyPath)).toBe(4)
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

  it('fails legacy migration when one synthetic device snapshot exceeds the open-record cap', async () => {
    const legacyPath = path.join(tempDir, 'tabs-registry.jsonl')
    const lines = Array.from({ length: 3 }, (_, i) => JSON.stringify(makeRecord({
      tabKey: `remote-device:tab-${i}`,
      tabId: `tab-${i}`,
      deviceId: 'remote-device',
      deviceLabel: 'remote',
    })))
    await fs.writeFile(legacyPath, `${lines.join('\n')}\n`, 'utf-8')

    await expect(createTabsRegistryStore(tempDir, {
      now: () => now,
      caps: { maxOpenRecordsPerClientSnapshot: 2 },
    })).rejects.toThrow(/open records|client snapshot|migration/i)
    await expect(fs.stat(path.join(tempDir, 'v1', 'manifest.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('normalizes legacy synthetic snapshot record labels to their snapshot device label', async () => {
    const legacyPath = path.join(tempDir, 'tabs-registry.jsonl')
    await fs.writeFile(legacyPath, [
      JSON.stringify(makeRecord({
        tabKey: 'remote-device:old',
        tabId: 'old',
        deviceId: 'remote-device',
        deviceLabel: 'old-label',
        updatedAt: NOW - 2_000,
      })),
      JSON.stringify(makeRecord({
        tabKey: 'remote-device:new',
        tabId: 'new',
        deviceId: 'remote-device',
        deviceLabel: 'new-label',
        updatedAt: NOW - 1_000,
      })),
      '',
    ].join('\n'), 'utf-8')

    const migrated = await createTabsRegistryStore(tempDir, { now: () => now })
    const result = await migrated.query({
      deviceId: 'local-device',
      clientInstanceId: 'window-a',
      closedTabRetentionDays: 30,
    })
    expect(new Set(result.remoteOpen.map((record) => record.deviceLabel))).toEqual(new Set(['old-label']))
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
      openSnapshotPayloadHash: '0'.repeat(64),
      snapshotReceivedAt: NOW,
      records: [closedRecord],
    }
    const snapshotObject = objectFor(snapshot)
    const closedObject = objectFor({})
    const devicesObject = objectFor({})
    const clientRevisionsObject = objectFor({})
    for (const object of [snapshotObject, closedObject, devicesObject, clientRevisionsObject]) {
      await fs.writeFile(path.join(tempDir, 'v1', object.ref.path), object.raw, 'utf-8')
    }
    const manifest = {
      version: 1,
      manifestRevision: 1,
      committedAt: NOW,
      openSnapshots: { [clientSnapshotKey('local-device', 'window-a')]: snapshotObject.ref },
      clientRevisions: clientRevisionsObject.ref,
      closedTombstones: closedObject.ref,
      devices: devicesObject.ref,
      settings: { openSnapshotTtlMinutes: 30, deviceDisplayTtlDays: 7, maxClosedRetentionDays: 30 },
    }
    await fs.writeFile(path.join(tempDir, 'v1', 'manifest.json'), stableStringify(manifest), 'utf-8')

    await expect(createTabsRegistryStore(tempDir, { now: () => now })).rejects.toThrow(/open snapshot.*open records|compact state/i)
  })

  it('rejects compact closed tombstones that are not closed or whose keys do not match record tab keys', async () => {
    await fs.mkdir(path.join(tempDir, 'v1', 'objects'), { recursive: true })
    const openInClosed = makeRecord({
      tabKey: 'actual:open',
      tabId: 'open',
      deviceId: 'remote-device',
      deviceLabel: 'remote',
      status: 'open',
    })
    const closedKeyMismatch = makeRecord({
      tabKey: 'actual:closed',
      tabId: 'closed',
      deviceId: 'remote-device',
      deviceLabel: 'remote',
      status: 'closed',
      closedAt: NOW,
      updatedAt: NOW,
    })
    const closedObject = objectFor({
      'manifest-open': openInClosed,
      'manifest-closed': closedKeyMismatch,
    })
    const devicesObject = objectFor({})
    const clientRevisionsObject = objectFor({})
    for (const object of [closedObject, devicesObject, clientRevisionsObject]) {
      await fs.writeFile(path.join(tempDir, 'v1', object.ref.path), object.raw, 'utf-8')
    }
    const manifest = {
      version: 1,
      manifestRevision: 1,
      committedAt: NOW,
      openSnapshots: {},
      clientRevisions: clientRevisionsObject.ref,
      closedTombstones: closedObject.ref,
      devices: devicesObject.ref,
      settings: { openSnapshotTtlMinutes: 30, deviceDisplayTtlDays: 7, maxClosedRetentionDays: 30 },
    }
    await fs.writeFile(path.join(tempDir, 'v1', 'manifest.json'), stableStringify(manifest), 'utf-8')

    await expect(createTabsRegistryStore(tempDir, { now: () => now })).rejects.toThrow(/closed tombstone|compact state/i)
  })

  it('rejects compact open snapshots whose records exceed caps or do not belong to the snapshot identity', async () => {
    await fs.mkdir(path.join(tempDir, 'v1', 'objects'), { recursive: true })
    const mismatchedRecord = makeRecord({
      tabKey: 'remote:open',
      tabId: 'open',
      deviceId: 'remote-device',
      deviceLabel: 'remote',
      clientInstanceId: 'remote-window',
    } as Partial<RegistryTabRecord>)
    const tooManyPanes = makeRecord({
      tabKey: 'local:pane-cap',
      tabId: 'pane-cap',
      deviceId: 'local-device',
      deviceLabel: 'local',
      paneCount: 21,
      panes: Array.from({ length: 21 }, (_, i) => ({ paneId: `pane-${i}`, kind: 'terminal', payload: {} })),
    })
    const snapshot = {
      deviceId: 'local-device',
      deviceLabel: 'local',
      clientInstanceId: 'window-a',
      snapshotRevision: 1,
      lastPushPayloadHash: pushHash({
        deviceId: 'local-device',
        deviceLabel: 'local',
        clientInstanceId: 'window-a',
        snapshotRevision: 1,
        records: [mismatchedRecord, tooManyPanes],
      }),
      openSnapshotPayloadHash: pushHash({
        deviceId: 'local-device',
        deviceLabel: 'local',
        clientInstanceId: 'window-a',
        snapshotRevision: 1,
        records: [mismatchedRecord, tooManyPanes],
      }),
      snapshotReceivedAt: NOW,
      records: [mismatchedRecord, tooManyPanes],
    }
    const snapshotObject = objectFor(snapshot)
    const closedObject = objectFor({})
    const devicesObject = objectFor({})
    const clientRevisionsObject = objectFor({})
    for (const object of [snapshotObject, closedObject, devicesObject, clientRevisionsObject]) {
      await fs.writeFile(path.join(tempDir, 'v1', object.ref.path), object.raw, 'utf-8')
    }
    const manifest = {
      version: 1,
      manifestRevision: 1,
      committedAt: NOW,
      openSnapshots: { [clientSnapshotKey('local-device', 'window-a')]: snapshotObject.ref },
      clientRevisions: clientRevisionsObject.ref,
      closedTombstones: closedObject.ref,
      devices: devicesObject.ref,
      settings: { openSnapshotTtlMinutes: 30, deviceDisplayTtlDays: 7, maxClosedRetentionDays: 30 },
    }
    await fs.writeFile(path.join(tempDir, 'v1', 'manifest.json'), stableStringify(manifest), 'utf-8')

    await expect(createTabsRegistryStore(tempDir, { now: () => now })).rejects.toThrow(/snapshot.*record|20 panes|compact state/i)
  })

  it('rejects compact manifests with non-v1 liveness settings', async () => {
    await fs.mkdir(path.join(tempDir, 'v1', 'objects'), { recursive: true })
    const closedObject = objectFor({})
    const devicesObject = objectFor({})
    const clientRevisionsObject = objectFor({})
    for (const object of [closedObject, devicesObject, clientRevisionsObject]) {
      await fs.writeFile(path.join(tempDir, 'v1', object.ref.path), object.raw, 'utf-8')
    }
    const manifest = {
      version: 1,
      manifestRevision: 1,
      committedAt: NOW,
      openSnapshots: {},
      clientRevisions: clientRevisionsObject.ref,
      closedTombstones: closedObject.ref,
      devices: devicesObject.ref,
      settings: { openSnapshotTtlMinutes: 525600, deviceDisplayTtlDays: 7, maxClosedRetentionDays: 30 },
    }
    await fs.writeFile(path.join(tempDir, 'v1', 'manifest.json'), stableStringify(manifest), 'utf-8')

    await expect(createTabsRegistryStore(tempDir, { now: () => now })).rejects.toThrow(/manifest|compact state/i)
  })

  it('rejects compact snapshots whose open snapshot hash does not match their open records', async () => {
    await fs.mkdir(path.join(tempDir, 'v1', 'objects'), { recursive: true })
    const record = makeRecord({
      tabKey: 'local:open',
      tabId: 'open',
      deviceId: 'local-device',
      deviceLabel: 'local',
      clientInstanceId: 'window-a',
    } as Partial<RegistryTabRecord>)
    const openSnapshotPayloadHash = pushHash({
      deviceId: 'local-device',
      deviceLabel: 'local',
      clientInstanceId: 'window-a',
      snapshotRevision: 1,
      records: [record],
    })
    const snapshot = {
      deviceId: 'local-device',
      deviceLabel: 'local',
      clientInstanceId: 'window-a',
      snapshotRevision: 1,
      lastPushPayloadHash: openSnapshotPayloadHash,
      openSnapshotPayloadHash: '1'.repeat(64),
      snapshotReceivedAt: NOW,
      records: [record],
    }
    const snapshotObject = objectFor(snapshot)
    const closedObject = objectFor({})
    const devicesObject = objectFor({})
    const clientRevisionsObject = objectFor({})
    for (const object of [snapshotObject, closedObject, devicesObject, clientRevisionsObject]) {
      await fs.writeFile(path.join(tempDir, 'v1', object.ref.path), object.raw, 'utf-8')
    }
    const manifest = {
      version: 1,
      manifestRevision: 1,
      committedAt: NOW,
      openSnapshots: { [clientSnapshotKey('local-device', 'window-a')]: snapshotObject.ref },
      clientRevisions: clientRevisionsObject.ref,
      closedTombstones: closedObject.ref,
      devices: devicesObject.ref,
      settings: { openSnapshotTtlMinutes: 30, deviceDisplayTtlDays: 7, maxClosedRetentionDays: 30 },
    }
    await fs.writeFile(path.join(tempDir, 'v1', 'manifest.json'), stableStringify(manifest), 'utf-8')

    await expect(createTabsRegistryStore(tempDir, { now: () => now })).rejects.toThrow(/payload hash|compact state/i)
  })

  it('rejects oversized compact manifest files before reading the manifest body', async () => {
    await fs.mkdir(path.join(tempDir, 'v1'), { recursive: true })
    await fs.writeFile(path.join(tempDir, 'v1', 'manifest.json'), 'x'.repeat(1024), 'utf-8')

    const readSpy = vi.spyOn(fs, 'readFile')
    await expect(createTabsRegistryStore(tempDir, {
      now: () => now,
      caps: { maxSerializedManifestBytes: 64 } as any,
    })).rejects.toThrow(/manifest.*64 bytes|compact state/i)
    const manifestReads = readSpy.mock.calls.filter(([file]) => String(file).endsWith(`${path.sep}v1${path.sep}manifest.json`))
    readSpy.mockRestore()
    expect(manifestReads).toHaveLength(0)
  })

  it('rejects compact state when manifest key does not match snapshot identity', async () => {
    await fs.mkdir(path.join(tempDir, 'v1', 'objects'), { recursive: true })
    const record = makeRecord({
      tabKey: 'local:open',
      tabId: 'open',
      deviceId: 'local-device',
      deviceLabel: 'local',
      clientInstanceId: 'window-b',
    } as Partial<RegistryTabRecord>)
    const snapshot = {
      deviceId: 'local-device',
      deviceLabel: 'local',
      clientInstanceId: 'window-b',
      snapshotRevision: 1,
      lastPushPayloadHash: pushHash({
        deviceId: 'local-device',
        deviceLabel: 'local',
        clientInstanceId: 'window-b',
        snapshotRevision: 1,
        records: [record],
      }),
      openSnapshotPayloadHash: pushHash({
        deviceId: 'local-device',
        deviceLabel: 'local',
        clientInstanceId: 'window-b',
        snapshotRevision: 1,
        records: [record],
      }),
      snapshotReceivedAt: NOW,
      records: [record],
    }
    const snapshotObject = objectFor(snapshot)
    const closedObject = objectFor({})
    const devicesObject = objectFor({})
    const clientRevisionsObject = objectFor({})
    for (const object of [snapshotObject, closedObject, devicesObject, clientRevisionsObject]) {
      await fs.writeFile(path.join(tempDir, 'v1', object.ref.path), object.raw, 'utf-8')
    }
    const manifest = {
      version: 1,
      manifestRevision: 1,
      committedAt: NOW,
      openSnapshots: { [clientSnapshotKey('local-device', 'window-a')]: snapshotObject.ref },
      clientRevisions: clientRevisionsObject.ref,
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
    const clientRevisionsObject = objectFor({})
    for (const object of [closedObject, devicesObject, clientRevisionsObject]) {
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
      clientRevisions: clientRevisionsObject.ref,
      closedTombstones: closedObject.ref,
      devices: devicesObject.ref,
      settings: { openSnapshotTtlMinutes: 30, deviceDisplayTtlDays: 7, maxClosedRetentionDays: 30 },
    }
    await fs.writeFile(path.join(tempDir, 'v1', 'manifest.json'), stableStringify(manifest), 'utf-8')

    await expect(createTabsRegistryStore(tempDir, { now: () => now })).rejects.toThrow(/object.*512 KiB|compact state/i)
  })

  it('rejects excessive compact manifest snapshot refs before reading object bodies', async () => {
    await fs.mkdir(path.join(tempDir, 'v1', 'objects'), { recursive: true })
    const closedObject = objectFor({})
    const devicesObject = objectFor({})
    const clientRevisionsObject = objectFor({})
    const openSnapshots: Record<string, ReturnType<typeof objectFor>['ref']> = {}
    for (let i = 0; i < 3; i += 1) {
      const record = makeRecord({
        tabKey: `device-${i}:tab`,
        tabId: `tab-${i}`,
        deviceId: `device-${i}`,
        deviceLabel: `Device ${i}`,
        clientInstanceId: 'window',
      } as Partial<RegistryTabRecord>)
      const snapshotObject = makeClientSnapshotObject({
        deviceId: `device-${i}`,
        deviceLabel: `Device ${i}`,
        clientInstanceId: 'window',
        snapshotRevision: 1,
        snapshotReceivedAt: NOW,
        records: [record],
      })
      openSnapshots[clientSnapshotKey(`device-${i}`, 'window')] = snapshotObject.ref
      await fs.writeFile(path.join(tempDir, 'v1', snapshotObject.ref.path), snapshotObject.raw, 'utf-8')
    }
    for (const object of [closedObject, devicesObject, clientRevisionsObject]) {
      await fs.writeFile(path.join(tempDir, 'v1', object.ref.path), object.raw, 'utf-8')
    }
    await fs.writeFile(path.join(tempDir, 'v1', 'manifest.json'), stableStringify({
      version: 1,
      manifestRevision: 1,
      committedAt: NOW,
      openSnapshots,
      clientRevisions: clientRevisionsObject.ref,
      closedTombstones: closedObject.ref,
      devices: devicesObject.ref,
      settings: { openSnapshotTtlMinutes: 30, deviceDisplayTtlDays: 7, maxClosedRetentionDays: 30 },
    }), 'utf-8')

    const readSpy = vi.spyOn(fs, 'readFile')
    await expect(createTabsRegistryStore(tempDir, {
      now: () => now,
      caps: { maxClientSnapshotRefs: 2 },
    })).rejects.toThrow(/client snapshots|compact state/i)
    const objectReads = readSpy.mock.calls.filter(([file]) => String(file).includes(`${path.sep}v1${path.sep}objects${path.sep}`))
    readSpy.mockRestore()
    expect(objectReads).toHaveLength(0)
  })

  it('rejects excessive compact manifest aggregate bytes before reading object bodies', async () => {
    await fs.mkdir(path.join(tempDir, 'v1', 'objects'), { recursive: true })
    const record = makeRecord({
      tabKey: 'local:large-ref',
      tabId: 'large-ref',
      deviceId: 'local-device',
      deviceLabel: 'local',
      clientInstanceId: 'window-a',
      panes: [{ paneId: 'pane-1', kind: 'terminal', payload: { text: 'x'.repeat(1024) } }],
    } as Partial<RegistryTabRecord>)
    const snapshotObject = makeClientSnapshotObject({
      deviceId: 'local-device',
      deviceLabel: 'local',
      clientInstanceId: 'window-a',
      snapshotRevision: 1,
      snapshotReceivedAt: NOW,
      records: [record],
    })
    const closedObject = objectFor({})
    const devicesObject = objectFor({})
    const clientRevisionsObject = objectFor({})
    for (const object of [snapshotObject, closedObject, devicesObject, clientRevisionsObject]) {
      await fs.writeFile(path.join(tempDir, 'v1', object.ref.path), object.raw, 'utf-8')
    }
    await fs.writeFile(path.join(tempDir, 'v1', 'manifest.json'), stableStringify({
      version: 1,
      manifestRevision: 1,
      committedAt: NOW,
      openSnapshots: { [clientSnapshotKey('local-device', 'window-a')]: snapshotObject.ref },
      clientRevisions: clientRevisionsObject.ref,
      closedTombstones: closedObject.ref,
      devices: devicesObject.ref,
      settings: { openSnapshotTtlMinutes: 30, deviceDisplayTtlDays: 7, maxClosedRetentionDays: 30 },
    }), 'utf-8')

    const readSpy = vi.spyOn(fs, 'readFile')
    await expect(createTabsRegistryStore(tempDir, {
      now: () => now,
      caps: { maxCompactStateBytes: 200 },
    })).rejects.toThrow(/compact state exceeds|compact state/i)
    const objectReads = readSpy.mock.calls.filter(([file]) => String(file).includes(`${path.sep}v1${path.sep}objects${path.sep}`))
    readSpy.mockRestore()
    expect(objectReads).toHaveLength(0)
  })

  it('rejects manifest object refs whose filename is not the content hash', async () => {
    await fs.mkdir(path.join(tempDir, 'v1', 'objects'), { recursive: true })
    const closedObject = objectFor({})
    const devicesObject = objectFor({})
    const clientRevisionsObject = objectFor({})
    const mismatchedPath = `objects/${'1'.repeat(64)}.json`
    await fs.writeFile(path.join(tempDir, 'v1', closedObject.ref.path), closedObject.raw, 'utf-8')
    await fs.writeFile(path.join(tempDir, 'v1', mismatchedPath), closedObject.raw, 'utf-8')
    await fs.writeFile(path.join(tempDir, 'v1', devicesObject.ref.path), devicesObject.raw, 'utf-8')
    await fs.writeFile(path.join(tempDir, 'v1', clientRevisionsObject.ref.path), clientRevisionsObject.raw, 'utf-8')
    const manifest = {
      version: 1,
      manifestRevision: 1,
      committedAt: NOW,
      openSnapshots: {},
      clientRevisions: clientRevisionsObject.ref,
      closedTombstones: { ...closedObject.ref, path: mismatchedPath },
      devices: devicesObject.ref,
      settings: { openSnapshotTtlMinutes: 30, deviceDisplayTtlDays: 7, maxClosedRetentionDays: 30 },
    }
    await fs.writeFile(path.join(tempDir, 'v1', 'manifest.json'), stableStringify(manifest), 'utf-8')

    await expect(createTabsRegistryStore(tempDir, { now: () => now })).rejects.toThrow(/content hash|compact state|manifest/i)
  })

  it('rejects devices metadata whose keys do not match device ids', async () => {
    await fs.mkdir(path.join(tempDir, 'v1', 'objects'), { recursive: true })
    const closedObject = objectFor({})
    const devicesObject = objectFor({
      'manifest-device': { deviceId: 'actual-device', deviceLabel: 'actual', lastSeenAt: NOW },
    })
    const clientRevisionsObject = objectFor({})
    for (const object of [closedObject, devicesObject, clientRevisionsObject]) {
      await fs.writeFile(path.join(tempDir, 'v1', object.ref.path), object.raw, 'utf-8')
    }
    const manifest = {
      version: 1,
      manifestRevision: 1,
      committedAt: NOW,
      openSnapshots: {},
      clientRevisions: clientRevisionsObject.ref,
      closedTombstones: closedObject.ref,
      devices: devicesObject.ref,
      settings: { openSnapshotTtlMinutes: 30, deviceDisplayTtlDays: 7, maxClosedRetentionDays: 30 },
    }
    await fs.writeFile(path.join(tempDir, 'v1', 'manifest.json'), stableStringify(manifest), 'utf-8')

    await expect(createTabsRegistryStore(tempDir, { now: () => now })).rejects.toThrow(/devices.*key|compact state/i)
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
    const expectedSnapshotHash = crypto.createHash('sha256').update(stableStringify({
      deviceId: 'local-device',
      deviceLabel: 'local',
      clientInstanceId: 'window-a',
      snapshotRevision: 1,
      records: [storedRecord],
    })).digest('hex')
    const snapshot = {
      deviceId: 'local-device',
      deviceLabel: 'local',
      clientInstanceId: 'window-a',
      snapshotRevision: 1,
      lastPushPayloadHash: expectedSnapshotHash,
      openSnapshotPayloadHash: expectedSnapshotHash,
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

  it('reuses unchanged object refs without rereading compact objects during heartbeat commits', async () => {
    const writer = await createTabsRegistryStore(tempDir, { now: () => now })
    const localRecord = makeRecord({
      tabKey: 'local:open',
      tabId: 'local',
      deviceId: 'local-device',
      deviceLabel: 'local',
    })
    const remoteRecord = makeRecord({
      tabKey: 'remote:open',
      tabId: 'remote',
      deviceId: 'remote-device',
      deviceLabel: 'remote',
    })
    await writer.replaceClientSnapshot({
      deviceId: 'local-device',
      deviceLabel: 'local',
      clientInstanceId: 'window-a',
      snapshotRevision: 1,
      records: [localRecord],
    })
    await writer.replaceClientSnapshot({
      deviceId: 'remote-device',
      deviceLabel: 'remote',
      clientInstanceId: 'window-b',
      snapshotRevision: 1,
      records: [remoteRecord],
    })

    const readSpy = vi.spyOn(fs, 'readFile')
    now += 1
    await writer.replaceClientSnapshot({
      deviceId: 'local-device',
      deviceLabel: 'local',
      clientInstanceId: 'window-a',
      snapshotRevision: 2,
      records: [localRecord],
    })

    const objectReads = readSpy.mock.calls.filter(([file]) => String(file).includes(`${path.sep}v1${path.sep}objects${path.sep}`))
    readSpy.mockRestore()
    expect(objectReads).toHaveLength(0)
  })

  it('does not reread closed tombstone objects when a heartbeat repeats retained closed records unchanged', async () => {
    const writer = await createTabsRegistryStore(tempDir, { now: () => now })
    const openRecord = makeRecord({
      tabKey: 'local:open',
      tabId: 'open',
      deviceId: 'local-device',
      deviceLabel: 'local',
    })
    const closedRecord = makeRecord({
      tabKey: 'local:closed',
      tabId: 'closed',
      deviceId: 'local-device',
      deviceLabel: 'local',
      status: 'closed',
      updatedAt: NOW - 500,
      closedAt: NOW - 500,
    })
    await writer.replaceClientSnapshot({
      deviceId: 'local-device',
      deviceLabel: 'local',
      clientInstanceId: 'window-a',
      snapshotRevision: 1,
      records: [openRecord, closedRecord],
    })

    const readSpy = vi.spyOn(fs, 'readFile')
    now += 1
    await writer.replaceClientSnapshot({
      deviceId: 'local-device',
      deviceLabel: 'local',
      clientInstanceId: 'window-a',
      snapshotRevision: 2,
      records: [openRecord, closedRecord],
    })

    const objectReads = readSpy.mock.calls.filter(([file]) => String(file).includes(`${path.sep}v1${path.sep}objects${path.sep}`))
    readSpy.mockRestore()
    expect(objectReads).toHaveLength(0)
  })

  it('keeps query pure while ignoring closed tombstones beyond server retention for conflict resolution', async () => {
    await fs.mkdir(path.join(tempDir, 'v1', 'objects'), { recursive: true })
    const openRecord = makeRecord({
      tabKey: 'remote:aged-conflict',
      tabId: 'aged-conflict',
      deviceId: 'remote-device',
      deviceLabel: 'remote',
      clientInstanceId: 'remote-window',
      status: 'open',
      revision: 1,
      updatedAt: NOW,
    } as Partial<RegistryTabRecord>)
    const expiredClosedRecord = makeRecord({
      ...openRecord,
      status: 'closed',
      revision: 5,
      updatedAt: NOW + 1_000,
      closedAt: NOW - 31 * 24 * 60 * 60 * 1000,
      clientInstanceId: 'remote-closer',
    } as Partial<RegistryTabRecord>)
    const snapshotObject = makeClientSnapshotObject({
      deviceId: 'remote-device',
      deviceLabel: 'remote',
      clientInstanceId: 'remote-window',
      snapshotRevision: 1,
      snapshotReceivedAt: NOW,
      records: [openRecord],
    })
    const closedObject = objectFor({ [expiredClosedRecord.tabKey]: expiredClosedRecord })
    const devicesObject = objectFor({
      'remote-device': { deviceId: 'remote-device', deviceLabel: 'remote', lastSeenAt: NOW },
    })
    const clientRevisionsObject = objectFor({
      [clientSnapshotKey('remote-device', 'remote-window')]: {
        deviceId: 'remote-device',
        clientInstanceId: 'remote-window',
        snapshotRevision: 1,
        lastSeenAt: NOW,
      },
    })
    for (const object of [snapshotObject, closedObject, devicesObject, clientRevisionsObject]) {
      await fs.writeFile(path.join(tempDir, 'v1', object.ref.path), object.raw, 'utf-8')
    }
    const manifest = {
      version: 1,
      manifestRevision: 1,
      committedAt: NOW,
      openSnapshots: { [clientSnapshotKey('remote-device', 'remote-window')]: snapshotObject.ref },
      clientRevisions: clientRevisionsObject.ref,
      closedTombstones: closedObject.ref,
      devices: devicesObject.ref,
      settings: { openSnapshotTtlMinutes: 30, deviceDisplayTtlDays: 7, maxClosedRetentionDays: 30 },
    }
    await fs.writeFile(path.join(tempDir, 'v1', 'manifest.json'), stableStringify(manifest), 'utf-8')
    const beforeManifest = await fs.readFile(path.join(tempDir, 'v1', 'manifest.json'), 'utf-8')
    const reader = await createTabsRegistryStore(tempDir, { now: () => now })

    const result = await reader.query({
      deviceId: 'local-device',
      clientInstanceId: 'window-a',
      closedTabRetentionDays: 30,
    })
    const afterManifest = await fs.readFile(path.join(tempDir, 'v1', 'manifest.json'), 'utf-8')

    expect(result.remoteOpen.map((record) => record.tabKey)).toEqual(['remote:aged-conflict'])
    expect(result.closed).toHaveLength(0)
    expect(afterManifest).toBe(beforeManifest)
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

  it('loads committed state and accepts same-revision retry after manifest publish succeeds before ack', async () => {
    const writer = await createTabsRegistryStore(tempDir, { now: () => now })
    const beforeRecord = makeRecord({
      tabKey: 'local:before',
      tabId: 'before',
      deviceId: 'local-device',
      deviceLabel: 'local',
    })
    const afterRecord = makeRecord({
      tabKey: 'local:after',
      tabId: 'after',
      deviceId: 'local-device',
      deviceLabel: 'local',
    })
    const afterClosedRecord = makeRecord({
      tabKey: 'local:closed-after',
      tabId: 'closed-after',
      deviceId: 'local-device',
      deviceLabel: 'local',
      status: 'closed',
      updatedAt: NOW,
      closedAt: NOW,
    })
    await writer.replaceClientSnapshot({
      deviceId: 'local-device',
      deviceLabel: 'local',
      clientInstanceId: 'window-a',
      snapshotRevision: 1,
      records: [beforeRecord],
    })
    ;(writer as any).setTestAfterManifestPublishHook(async () => {
      throw new Error('Injected tabs registry after manifest publish failure')
    })

    await expect(writer.replaceClientSnapshot({
      deviceId: 'local-device',
      deviceLabel: 'local',
      clientInstanceId: 'window-a',
      snapshotRevision: 2,
      records: [afterRecord, afterClosedRecord],
    })).rejects.toThrow(/after manifest publish/i)

    const restarted = await createTabsRegistryStore(tempDir, { now: () => now })
    const rehydrated = await restarted.query({
      deviceId: 'local-device',
      clientInstanceId: 'window-a',
      closedTabRetentionDays: 30,
    })
    expect(rehydrated.localOpen.map((record) => record.tabKey)).toEqual(['local:after'])
    expect(rehydrated.closed.map((record) => record.tabKey)).toEqual(['local:closed-after'])

    await expect(restarted.replaceClientSnapshot({
      deviceId: 'local-device',
      deviceLabel: 'local',
      clientInstanceId: 'window-a',
      snapshotRevision: 2,
      records: [afterRecord, afterClosedRecord],
    })).resolves.toMatchObject({ accepted: true, openRecords: 1, closedRecords: 1 })
  })
})
