import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import {
  createTabsRegistryStore,
  type TabsRegistryStore,
} from '../../../../server/tabs-registry/store.js'
import type { RegistryTabRecord } from '../../../../server/tabs-registry/types.js'

const NOW = 1_740_000_000_000
const MINUTE_MS = 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

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

async function replace(
  store: TabsRegistryStore,
  input: {
    deviceId: string
    deviceLabel?: string
    clientInstanceId: string
    snapshotRevision: number
    records: RegistryTabRecord[]
  },
) {
  return store.replaceClientSnapshot({
    deviceId: input.deviceId,
    deviceLabel: input.deviceLabel ?? input.deviceId,
    clientInstanceId: input.clientInstanceId,
    snapshotRevision: input.snapshotRevision,
    records: input.records,
  })
}

describe('TabsRegistryStore compact state', () => {
  let tempDir: string
  let now = NOW
  let store: TabsRegistryStore

  beforeEach(async () => {
    now = NOW
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tabs-registry-store-'))
    store = await createTabsRegistryStore(tempDir, { now: () => now })
  })

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  it('scopes open replacement to one client instance and splits same-device open tabs', async () => {
    await replace(store, {
      deviceId: 'local-device',
      deviceLabel: 'local',
      clientInstanceId: 'window-a',
      snapshotRevision: 1,
      records: [
        makeRecord({ tabKey: 'local:a', tabId: 'a', deviceId: 'local-device', deviceLabel: 'local', tabName: 'A' }),
      ],
    })
    await replace(store, {
      deviceId: 'local-device',
      deviceLabel: 'local',
      clientInstanceId: 'window-b',
      snapshotRevision: 1,
      records: [
        makeRecord({ tabKey: 'local:b', tabId: 'b', deviceId: 'local-device', deviceLabel: 'local', tabName: 'B' }),
      ],
    })
    await replace(store, {
      deviceId: 'remote-device',
      deviceLabel: 'remote',
      clientInstanceId: 'remote-window',
      snapshotRevision: 1,
      records: [
        makeRecord({ tabKey: 'remote:r', tabId: 'r', deviceId: 'remote-device', deviceLabel: 'remote', tabName: 'R' }),
      ],
    })
    await replace(store, {
      deviceId: 'local-device',
      deviceLabel: 'local',
      clientInstanceId: 'window-a',
      snapshotRevision: 2,
      records: [
        makeRecord({ tabKey: 'local:a2', tabId: 'a2', deviceId: 'local-device', deviceLabel: 'local', tabName: 'A2' }),
      ],
    })

    const result = await store.query({
      deviceId: 'local-device',
      clientInstanceId: 'window-a',
      closedTabRetentionDays: 30,
    })
    expect(result.localOpen.map((record) => record.tabKey)).toEqual(['local:a2'])
    expect(result.sameDeviceOpen.map((record) => record.tabKey)).toEqual(['local:b'])
    expect(result.remoteOpen.map((record) => record.tabKey)).toEqual(['remote:r'])
  })

  it('rejects stale revisions but accepts same-revision idempotent retries only with matching content', async () => {
    const record = makeRecord({ tabKey: 'local:a', tabId: 'a', deviceId: 'local-device', deviceLabel: 'local' })
    await expect(replace(store, {
      deviceId: 'local-device',
      deviceLabel: 'local',
      clientInstanceId: 'window-a',
      snapshotRevision: 2,
      records: [record],
    })).resolves.toMatchObject({ accepted: true, openRecords: 1, closedRecords: 0 })

    await expect(replace(store, {
      deviceId: 'local-device',
      deviceLabel: 'local',
      clientInstanceId: 'window-a',
      snapshotRevision: 1,
      records: [record],
    })).rejects.toThrow(/stale snapshot revision/i)

    await expect(replace(store, {
      deviceId: 'local-device',
      deviceLabel: 'local',
      clientInstanceId: 'window-a',
      snapshotRevision: 2,
      records: [record],
    })).resolves.toMatchObject({ accepted: true, openRecords: 1, closedRecords: 0 })

    await expect(replace(store, {
      deviceId: 'local-device',
      deviceLabel: 'local',
      clientInstanceId: 'window-a',
      snapshotRevision: 2,
      records: [{ ...record, tabName: 'different' }],
    })).rejects.toThrow(/duplicate snapshot revision/i)
  })

  it('archives a compact manifest that references a missing object and starts empty', async () => {
    await replace(store, {
      deviceId: 'local-device',
      deviceLabel: 'local',
      clientInstanceId: 'window-a',
      snapshotRevision: 1,
      records: [
        makeRecord({ tabKey: 'local:a', tabId: 'a', deviceId: 'local-device', deviceLabel: 'local', tabName: 'A' }),
      ],
    })
    const manifestPath = path.join(tempDir, 'v1', 'manifest.json')
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as {
      openSnapshots: Record<string, { path: string }>
    }
    const missingRef = Object.values(manifest.openSnapshots)[0]
    expect(missingRef).toBeDefined()
    await fs.rm(path.join(tempDir, 'v1', missingRef!.path))

    const restarted = await createTabsRegistryStore(tempDir, { now: () => now })
    expect(restarted.count()).toBe(0)

    const entries = await fs.readdir(path.join(tempDir, 'v1'))
    expect(entries.some((entry) => entry.startsWith('manifest.json.invalid-'))).toBe(true)
    await expect(fs.stat(manifestPath)).rejects.toThrow(/ENOENT/)
  })

  it('keeps superseded compact objects so overlapping restart processes cannot publish missing refs', async () => {
    const recordA = makeRecord({ tabKey: 'local:a', tabId: 'a', deviceId: 'local-device', deviceLabel: 'local', tabName: 'A' })
    await replace(store, {
      deviceId: 'local-device',
      deviceLabel: 'local',
      clientInstanceId: 'window-a',
      snapshotRevision: 1,
      records: [recordA],
    })
    const firstManifest = JSON.parse(await fs.readFile(path.join(tempDir, 'v1', 'manifest.json'), 'utf8')) as {
      openSnapshots: Record<string, { path: string }>
    }
    const originalSnapshotRef = Object.values(firstManifest.openSnapshots)[0]
    expect(originalSnapshotRef).toBeDefined()

    const overlappingRestart = await createTabsRegistryStore(tempDir, { now: () => now })
    await replace(store, {
      deviceId: 'local-device',
      deviceLabel: 'local',
      clientInstanceId: 'window-a',
      snapshotRevision: 2,
      records: [makeRecord({
        tabKey: 'local:b',
        tabId: 'b',
        deviceId: 'local-device',
        deviceLabel: 'local',
        tabName: 'B',
        revision: 2,
        updatedAt: NOW,
      })],
    })

    await expect(fs.stat(path.join(tempDir, 'v1', originalSnapshotRef!.path))).resolves.toBeDefined()
    await replace(overlappingRestart, {
      deviceId: 'other-device',
      deviceLabel: 'other',
      clientInstanceId: 'window-b',
      snapshotRevision: 1,
      records: [makeRecord({
        tabKey: 'other:c',
        tabId: 'c',
        deviceId: 'other-device',
        deviceLabel: 'other',
        tabName: 'C',
      })],
    })

    await expect(createTabsRegistryStore(tempDir, { now: () => now })).resolves.toBeDefined()
  })

  it('does not archive compact state for operational object read failures', async () => {
    await replace(store, {
      deviceId: 'local-device',
      deviceLabel: 'local',
      clientInstanceId: 'window-a',
      snapshotRevision: 1,
      records: [
        makeRecord({ tabKey: 'local:a', tabId: 'a', deviceId: 'local-device', deviceLabel: 'local', tabName: 'A' }),
      ],
    })
    const manifestPath = path.join(tempDir, 'v1', 'manifest.json')
    const originalReadFile = fs.readFile.bind(fs)
    const readFileSpy = vi.spyOn(fs, 'readFile').mockImplementation(async (file, ...args) => {
      if (String(file).includes(`${path.sep}v1${path.sep}objects${path.sep}`)) {
        const error = new Error('temporary permission failure') as NodeJS.ErrnoException
        error.code = 'EACCES'
        throw error
      }
      return await originalReadFile(file, ...args)
    })

    try {
      await expect(createTabsRegistryStore(tempDir, { now: () => now })).rejects.toThrow(/temporary permission failure/)
    } finally {
      readFileSpy.mockRestore()
    }

    const entries = await fs.readdir(path.join(tempDir, 'v1'))
    expect(entries.some((entry) => entry.startsWith('manifest.json.invalid-'))).toBe(false)
    await expect(fs.stat(manifestPath)).resolves.toBeDefined()
  })

  it('rejects same-revision retries whose closed tombstones differ from the committed push', async () => {
    const open = makeRecord({ tabKey: 'local:open', tabId: 'open', deviceId: 'local-device', deviceLabel: 'local' })
    const closed = makeRecord({
      tabKey: 'local:closed',
      tabId: 'closed',
      deviceId: 'local-device',
      deviceLabel: 'local',
      status: 'closed',
      updatedAt: NOW,
      closedAt: NOW,
    })

    await replace(store, {
      deviceId: 'local-device',
      deviceLabel: 'local',
      clientInstanceId: 'window-a',
      snapshotRevision: 1,
      records: [open],
    })

    await expect(replace(store, {
      deviceId: 'local-device',
      deviceLabel: 'local',
      clientInstanceId: 'window-a',
      snapshotRevision: 1,
      records: [open, closed],
    })).rejects.toThrow(/duplicate snapshot revision/i)

    const result = await store.query({
      deviceId: 'local-device',
      clientInstanceId: 'window-a',
      closedTabRetentionDays: 30,
    })
    expect(result.closed).toHaveLength(0)
  })

  it('retire removes only the matching client snapshot and ignores stale retires', async () => {
    await replace(store, {
      deviceId: 'local-device',
      deviceLabel: 'local',
      clientInstanceId: 'window-a',
      snapshotRevision: 3,
      records: [
        makeRecord({ tabKey: 'local:a', tabId: 'a', deviceId: 'local-device', deviceLabel: 'local' }),
      ],
    })
    await replace(store, {
      deviceId: 'local-device',
      deviceLabel: 'local',
      clientInstanceId: 'window-b',
      snapshotRevision: 1,
      records: [
        makeRecord({ tabKey: 'local:b', tabId: 'b', deviceId: 'local-device', deviceLabel: 'local' }),
      ],
    })

    await expect(store.retireClientSnapshot({
      deviceId: 'local-device',
      clientInstanceId: 'window-a',
      snapshotRevision: 2,
    })).resolves.toEqual({ accepted: false })
    await expect(store.retireClientSnapshot({
      deviceId: 'local-device',
      clientInstanceId: 'window-a',
      snapshotRevision: 4,
    })).resolves.toEqual({ accepted: true })

    const result = await store.query({
      deviceId: 'local-device',
      clientInstanceId: 'window-b',
      closedTabRetentionDays: 30,
    })
    expect(result.localOpen.map((record) => record.tabKey)).toEqual(['local:b'])
    expect(result.sameDeviceOpen).toHaveLength(0)
  })

  it('does not let an equal-revision old retire delete a newer reload snapshot', async () => {
    await replace(store, {
      deviceId: 'local-device',
      deviceLabel: 'local',
      clientInstanceId: 'window-a',
      snapshotRevision: 5,
      records: [
        makeRecord({ tabKey: 'local:old', tabId: 'old', deviceId: 'local-device', deviceLabel: 'local' }),
      ],
    })
    await replace(store, {
      deviceId: 'local-device',
      deviceLabel: 'local',
      clientInstanceId: 'window-a',
      snapshotRevision: 6,
      records: [
        makeRecord({ tabKey: 'local:new', tabId: 'new', deviceId: 'local-device', deviceLabel: 'local' }),
      ],
    })

    await expect(store.retireClientSnapshot({
      deviceId: 'local-device',
      clientInstanceId: 'window-a',
      snapshotRevision: 6,
    })).resolves.toEqual({ accepted: false })

    const result = await store.query({
      deviceId: 'local-device',
      clientInstanceId: 'window-a',
      closedTabRetentionDays: 30,
    })
    expect(result.localOpen.map((record) => record.tabKey)).toEqual(['local:new'])
  })

  it('does not let a late stale push recreate a client snapshot after a newer retire', async () => {
    const record = makeRecord({ tabKey: 'local:rev2', tabId: 'rev2', deviceId: 'local-device', deviceLabel: 'local' })
    await replace(store, {
      deviceId: 'local-device',
      deviceLabel: 'local',
      clientInstanceId: 'window-a',
      snapshotRevision: 2,
      records: [record],
    })

    await expect(store.retireClientSnapshot({
      deviceId: 'local-device',
      clientInstanceId: 'window-a',
      snapshotRevision: 3,
    })).resolves.toEqual({ accepted: true })

    await expect(replace(store, {
      deviceId: 'local-device',
      deviceLabel: 'local',
      clientInstanceId: 'window-a',
      snapshotRevision: 2,
      records: [record],
    })).rejects.toThrow(/stale snapshot revision/i)

    const result = await store.query({
      deviceId: 'local-device',
      clientInstanceId: 'window-a',
      closedTabRetentionDays: 30,
    })
    expect(result.localOpen).toHaveLength(0)
  })

  it('does not let a no-current retire lose its revision watermark before delayed stale pushes', async () => {
    const record = makeRecord({ tabKey: 'local:rev2', tabId: 'rev2', deviceId: 'local-device', deviceLabel: 'local' })
    await expect(store.retireClientSnapshot({
      deviceId: 'local-device',
      clientInstanceId: 'window-a',
      snapshotRevision: 3,
    })).resolves.toEqual({ accepted: true })

    await expect(replace(store, {
      deviceId: 'local-device',
      deviceLabel: 'local',
      clientInstanceId: 'window-a',
      snapshotRevision: 2,
      records: [record],
    })).rejects.toThrow(/stale snapshot revision/i)
  })

  it('keeps retired revision watermarks past the open snapshot TTL so stale pushes stay rejected', async () => {
    const record = makeRecord({ tabKey: 'local:rev2', tabId: 'rev2', deviceId: 'local-device', deviceLabel: 'local' })
    await replace(store, {
      deviceId: 'local-device',
      deviceLabel: 'local',
      clientInstanceId: 'window-a',
      snapshotRevision: 2,
      records: [record],
    })
    await store.retireClientSnapshot({
      deviceId: 'local-device',
      clientInstanceId: 'window-a',
      snapshotRevision: 3,
    })

    now = NOW + 31 * MINUTE_MS
    await replace(store, {
      deviceId: 'other-device',
      deviceLabel: 'other',
      clientInstanceId: 'window-b',
      snapshotRevision: 1,
      records: [],
    })

    await expect(replace(store, {
      deviceId: 'local-device',
      deviceLabel: 'local',
      clientInstanceId: 'window-a',
      snapshotRevision: 2,
      records: [record],
    })).rejects.toThrow(/stale snapshot revision/i)
  })

  it('does not count retired revision watermarks against active client snapshot refs', async () => {
    const capped = await createTabsRegistryStore(tempDir, {
      now: () => now,
      caps: { maxClientSnapshotRefs: 2 },
    })
    for (let i = 0; i < 2; i += 1) {
      await replace(capped, {
        deviceId: `retired-${i}`,
        deviceLabel: `Retired ${i}`,
        clientInstanceId: 'window',
        snapshotRevision: 1,
        records: [
          makeRecord({
            tabKey: `retired-${i}:tab`,
            tabId: `retired-${i}`,
            deviceId: `retired-${i}`,
            deviceLabel: `Retired ${i}`,
          }),
        ],
      })
      await capped.retireClientSnapshot({
        deviceId: `retired-${i}`,
        clientInstanceId: 'window',
        snapshotRevision: 2,
      })
    }

    await expect(replace(capped, {
      deviceId: 'live-device',
      deviceLabel: 'Live',
      clientInstanceId: 'window',
      snapshotRevision: 1,
      records: [
        makeRecord({
          tabKey: 'live-device:tab',
          tabId: 'live',
          deviceId: 'live-device',
          deviceLabel: 'Live',
        }),
      ],
    })).resolves.toMatchObject({ accepted: true, openRecords: 1 })
  })

  it('rejects fresh client snapshots beyond the snapshot ref cap instead of truncating live state', async () => {
    const capped = await createTabsRegistryStore(tempDir, {
      now: () => now,
      caps: { maxClientSnapshotRefs: 2 },
    })
    for (let i = 0; i < 2; i += 1) {
      now += 1
      await replace(capped, {
        deviceId: `device-${i}`,
        deviceLabel: `Device ${i}`,
        clientInstanceId: 'window',
        snapshotRevision: 1,
        records: [
          makeRecord({
            tabKey: `device-${i}:tab`,
            tabId: `tab-${i}`,
            deviceId: `device-${i}`,
            deviceLabel: `Device ${i}`,
          }),
        ],
      })
    }

    await expect(replace(capped, {
      deviceId: 'device-2',
      deviceLabel: 'Device 2',
      clientInstanceId: 'window',
      snapshotRevision: 1,
      records: [
        makeRecord({
          tabKey: 'device-2:tab',
          tabId: 'tab-2',
          deviceId: 'device-2',
          deviceLabel: 'Device 2',
        }),
      ],
    })).rejects.toThrow(/client snapshots/i)

    const result = await capped.query({
      deviceId: 'device-0',
      clientInstanceId: 'window',
      closedTabRetentionDays: 30,
    })
    expect(result.localOpen.map((record) => record.tabKey)).toEqual(['device-0:tab'])
    expect(result.remoteOpen.map((record) => record.tabKey)).toEqual(['device-1:tab'])
  })

  it('uses safe snapshot keys so device and client ids cannot collide', async () => {
    await replace(store, {
      deviceId: 'a:b',
      deviceLabel: 'First',
      clientInstanceId: 'c',
      snapshotRevision: 1,
      records: [
        makeRecord({ tabKey: 'first', tabId: 'first', deviceId: 'a:b', deviceLabel: 'First' }),
      ],
    })
    await replace(store, {
      deviceId: 'a',
      deviceLabel: 'Second',
      clientInstanceId: 'b:c',
      snapshotRevision: 1,
      records: [
        makeRecord({ tabKey: 'second', tabId: 'second', deviceId: 'a', deviceLabel: 'Second' }),
      ],
    })

    const first = await store.query({ deviceId: 'a:b', clientInstanceId: 'c', closedTabRetentionDays: 30 })
    const second = await store.query({ deviceId: 'a', clientInstanceId: 'b:c', closedTabRetentionDays: 30 })
    expect(first.localOpen.map((record) => record.tabKey)).toEqual(['first'])
    expect(second.localOpen.map((record) => record.tabKey)).toEqual(['second'])
    expect(store.count()).toBe(2)
  })

  it('resolves same-event open ties deterministically using client source metadata', async () => {
    const makeTie = (clientInstanceId: string) => makeRecord({
      tabKey: 'local:tie',
      tabId: 'tie',
      deviceId: 'local-device',
      deviceLabel: 'local',
      tabName: clientInstanceId,
      revision: 1,
      updatedAt: NOW,
    })

    async function run(order: string[]) {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tabs-registry-tie-'))
      const tieStore = await createTabsRegistryStore(dir, { now: () => now })
      try {
        for (const clientInstanceId of order) {
          await replace(tieStore, {
            deviceId: 'local-device',
            deviceLabel: 'local',
            clientInstanceId,
            snapshotRevision: 1,
            records: [makeTie(clientInstanceId)],
          })
        }
        const result = await tieStore.query({
          deviceId: 'other-device',
          clientInstanceId: 'other-window',
          closedTabRetentionDays: 30,
        })
        return result.remoteOpen.map((record) => record.tabName)
      } finally {
        await fs.rm(dir, { recursive: true, force: true })
      }
    }

    await expect(run(['a', 'b'])).resolves.toEqual(await run(['b', 'a']))
  })

  it('keeps closed tombstones across later omissions and uses updatedAt before revision for LWW', async () => {
    const staleOpen = makeRecord({
      tabKey: 'local:a',
      tabId: 'a',
      deviceId: 'local-device',
      deviceLabel: 'local',
      status: 'open',
      revision: 50,
      updatedAt: NOW - 10_000,
    })
    const newerClosedLowerRevision = makeRecord({
      ...staleOpen,
      status: 'closed',
      revision: 1,
      updatedAt: NOW - 1_000,
      closedAt: NOW - 1_000,
    })
    await replace(store, {
      deviceId: 'local-device',
      deviceLabel: 'local',
      clientInstanceId: 'window-a',
      snapshotRevision: 1,
      records: [staleOpen],
    })
    await replace(store, {
      deviceId: 'local-device',
      deviceLabel: 'local',
      clientInstanceId: 'window-b',
      snapshotRevision: 1,
      records: [newerClosedLowerRevision],
    })
    await replace(store, {
      deviceId: 'local-device',
      deviceLabel: 'local',
      clientInstanceId: 'window-a',
      snapshotRevision: 2,
      records: [],
    })

    const result = await store.query({
      deviceId: 'local-device',
      clientInstanceId: 'window-a',
      closedTabRetentionDays: 30,
    })
    expect(result.localOpen).toHaveLength(0)
    expect(result.closed.map((record) => record.tabKey)).toEqual(['local:a'])
  })

  it('chooses closed over open when open and closed records tie on updatedAt and revision', async () => {
    const open = makeRecord({
      tabKey: 'local:exact-tie',
      tabId: 'open-tie',
      deviceId: 'local-device',
      deviceLabel: 'local',
      status: 'open',
      revision: 4,
      updatedAt: NOW,
    })
    const closed = makeRecord({
      ...open,
      tabId: 'closed-tie',
      status: 'closed',
      closedAt: NOW,
    })

    await replace(store, {
      deviceId: 'local-device',
      deviceLabel: 'local',
      clientInstanceId: 'window-open',
      snapshotRevision: 1,
      records: [open],
    })
    await replace(store, {
      deviceId: 'local-device',
      deviceLabel: 'local',
      clientInstanceId: 'window-closed',
      snapshotRevision: 1,
      records: [closed],
    })

    const result = await store.query({
      deviceId: 'local-device',
      clientInstanceId: 'window-open',
      closedTabRetentionDays: 30,
    })
    expect(result.localOpen).toHaveLength(0)
    expect(result.sameDeviceOpen).toHaveLength(0)
    expect(result.closed.map((record) => record.tabKey)).toEqual(['local:exact-tie'])
  })

  it('lets a newer open delete an older closed tombstone so it cannot return after TTL or restart', async () => {
    const closed = makeRecord({
      tabKey: 'local:a',
      tabId: 'a',
      deviceId: 'local-device',
      deviceLabel: 'local',
      status: 'closed',
      revision: 1,
      updatedAt: NOW - 10_000,
      closedAt: NOW - 10_000,
    })
    const reopened = makeRecord({
      ...closed,
      status: 'open',
      revision: 2,
      updatedAt: NOW - 1_000,
      closedAt: undefined,
    })

    await replace(store, {
      deviceId: 'local-device',
      deviceLabel: 'local',
      clientInstanceId: 'window-a',
      snapshotRevision: 1,
      records: [closed],
    })
    await replace(store, {
      deviceId: 'local-device',
      deviceLabel: 'local',
      clientInstanceId: 'window-a',
      snapshotRevision: 2,
      records: [reopened],
    })

    now = NOW + 31 * MINUTE_MS
    const restarted = await createTabsRegistryStore(tempDir, { now: () => now })
    const result = await restarted.query({
      deviceId: 'local-device',
      clientInstanceId: 'window-a',
      closedTabRetentionDays: 30,
    })
    expect(result.localOpen).toHaveLength(0)
    expect(result.closed).toHaveLength(0)
  })

  it('does not retain an older closed tombstone when a newer open winner already exists', async () => {
    const newerOpen = makeRecord({
      tabKey: 'local:a',
      tabId: 'a',
      deviceId: 'local-device',
      deviceLabel: 'local',
      status: 'open',
      revision: 2,
      updatedAt: NOW - 1_000,
    })
    const staleClosed = makeRecord({
      ...newerOpen,
      status: 'closed',
      revision: 1,
      updatedAt: NOW - 10_000,
      closedAt: NOW - 10_000,
    })

    await replace(store, {
      deviceId: 'local-device',
      deviceLabel: 'local',
      clientInstanceId: 'window-a',
      snapshotRevision: 1,
      records: [newerOpen],
    })
    await replace(store, {
      deviceId: 'local-device',
      deviceLabel: 'local',
      clientInstanceId: 'window-b',
      snapshotRevision: 1,
      records: [staleClosed],
    })

    now = NOW + 31 * MINUTE_MS
    const result = await store.query({
      deviceId: 'local-device',
      clientInstanceId: 'window-a',
      closedTabRetentionDays: 30,
    })
    expect(result.localOpen).toHaveLength(0)
    expect(result.closed).toHaveLength(0)
  })

  it('uses retained closed winners for conflict resolution before requested retention filtering', async () => {
    const oldOpen = makeRecord({
      tabKey: 'remote:a',
      tabId: 'a',
      deviceId: 'remote-device',
      deviceLabel: 'remote',
      status: 'open',
      revision: 3,
      updatedAt: NOW - 12 * DAY_MS,
    })
    const closedTenDaysAgo = makeRecord({
      ...oldOpen,
      status: 'closed',
      revision: 1,
      updatedAt: NOW - 10 * DAY_MS,
      closedAt: NOW - 10 * DAY_MS,
    })
    await replace(store, {
      deviceId: 'remote-device',
      deviceLabel: 'remote',
      clientInstanceId: 'remote-window',
      snapshotRevision: 1,
      records: [oldOpen],
    })
    await replace(store, {
      deviceId: 'remote-device',
      deviceLabel: 'remote',
      clientInstanceId: 'remote-closer',
      snapshotRevision: 1,
      records: [closedTenDaysAgo],
    })

    const result = await store.query({
      deviceId: 'local-device',
      clientInstanceId: 'window-a',
      closedTabRetentionDays: 7,
    })
    expect(result.remoteOpen).toHaveLength(0)
    expect(result.closed).toHaveLength(0)
  })

  it('does not let tombstones older than server retention suppress fresh opens during pure query', async () => {
    const ancientClosed = makeRecord({
      tabKey: 'remote:a',
      tabId: 'a',
      deviceId: 'remote-device',
      deviceLabel: 'remote',
      status: 'closed',
      revision: 5,
      updatedAt: NOW + 1_000,
      closedAt: NOW - 31 * DAY_MS,
    })
    const freshOpen = makeRecord({
      ...ancientClosed,
      status: 'open',
      revision: 1,
      updatedAt: NOW,
      closedAt: undefined,
    })
    await replace(store, {
      deviceId: 'remote-device',
      deviceLabel: 'remote',
      clientInstanceId: 'window-a',
      snapshotRevision: 1,
      records: [ancientClosed],
    })
    await replace(store, {
      deviceId: 'remote-device',
      deviceLabel: 'remote',
      clientInstanceId: 'window-b',
      snapshotRevision: 1,
      records: [freshOpen],
    })

    const result = await store.query({
      deviceId: 'local-device',
      clientInstanceId: 'window-a',
      closedTabRetentionDays: 30,
    })
    expect(result.remoteOpen.map((record) => record.tabKey)).toEqual(['remote:a'])
    expect(result.closed).toHaveLength(0)
  })

  it('resolves same-event closed ties deterministically using client source metadata', async () => {
    const makeClosedTie = (clientInstanceId: string) => makeRecord({
      tabKey: 'local:closed-tie',
      tabId: 'closed-tie',
      deviceId: 'local-device',
      deviceLabel: 'local',
      tabName: clientInstanceId,
      status: 'closed',
      revision: 1,
      updatedAt: NOW,
      closedAt: NOW,
    })

    async function run(order: string[]) {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tabs-registry-closed-tie-'))
      const tieStore = await createTabsRegistryStore(dir, { now: () => now })
      try {
        for (const clientInstanceId of order) {
          await replace(tieStore, {
            deviceId: 'local-device',
            deviceLabel: 'local',
            clientInstanceId,
            snapshotRevision: 1,
            records: [makeClosedTie(clientInstanceId)],
          })
        }
        const result = await tieStore.query({
          deviceId: 'other-device',
          clientInstanceId: 'other-window',
          closedTabRetentionDays: 30,
        })
        return result.closed.map((record) => ({
          tabName: record.tabName,
          clientInstanceId: record.clientInstanceId,
        }))
      } finally {
        await fs.rm(dir, { recursive: true, force: true })
      }
    }

    await expect(run(['a', 'b'])).resolves.toEqual(await run(['b', 'a']))
  })

  it('uses server receipt time for open snapshot freshness and keeps devices for seven days', async () => {
    await replace(store, {
      deviceId: 'remote-device',
      deviceLabel: 'remote',
      clientInstanceId: 'remote-window',
      snapshotRevision: 1,
      records: [
        makeRecord({
          tabKey: 'remote:a',
          tabId: 'a',
          deviceId: 'remote-device',
          deviceLabel: 'remote',
          updatedAt: NOW - 30 * DAY_MS,
        }),
      ],
    })

    now = NOW + 31 * MINUTE_MS
    const afterOpenTtl = await store.query({
      deviceId: 'local-device',
      clientInstanceId: 'window-a',
      closedTabRetentionDays: 30,
    })
    expect(afterOpenTtl.remoteOpen).toHaveLength(0)
    expect(store.listDevices().map((device) => device.deviceId)).toContain('remote-device')

    now = NOW + 8 * DAY_MS
    expect(store.listDevices().map((device) => device.deviceId)).not.toContain('remote-device')
  })

  it('bounds recent device metadata by count during maintenance', async () => {
    const capped = await createTabsRegistryStore(tempDir, {
      now: () => now,
      caps: { maxDevices: 2 },
    })
    for (let i = 0; i < 3; i += 1) {
      now += 1
      await replace(capped, {
        deviceId: `device-${i}`,
        deviceLabel: `Device ${i}`,
        clientInstanceId: 'window',
        snapshotRevision: 1,
        records: [],
      })
      await capped.retireClientSnapshot({
        deviceId: `device-${i}`,
        clientInstanceId: 'window',
        snapshotRevision: 2,
      })
    }

    expect(capped.listDevices().map((device) => device.deviceId)).toEqual(['device-2', 'device-1'])
  })

  it('does not create device rows from closed tombstones alone', async () => {
    await replace(store, {
      deviceId: 'remote-device',
      deviceLabel: 'remote',
      clientInstanceId: 'remote-window',
      snapshotRevision: 1,
      records: [
        makeRecord({
          tabKey: 'remote:closed',
          tabId: 'closed',
          deviceId: 'remote-device',
          deviceLabel: 'remote',
          status: 'closed',
          updatedAt: NOW - 1_000,
          closedAt: NOW - 1_000,
        }),
      ],
    })
    await store.retireClientSnapshot({
      deviceId: 'remote-device',
      clientInstanceId: 'remote-window',
      snapshotRevision: 2,
    })

    expect(store.listDevices().map((device) => device.deviceId)).toContain('remote-device')
    now = NOW + 8 * DAY_MS
    expect(store.listDevices().map((device) => device.deviceId)).not.toContain('remote-device')
  })

  it('rejects invalid retention, oversized pushes, oversized panes, and duplicate tab keys clearly', async () => {
    await expect(store.query({
      deviceId: 'local-device',
      clientInstanceId: 'window-a',
      closedTabRetentionDays: 31,
    })).rejects.toThrow(/closed tab retention.*1.*30/i)

    const tooManyRecords = Array.from({ length: 501 }, (_, index) => makeRecord({
      tabKey: `local:${index}`,
      tabId: `tab-${index}`,
      deviceId: 'local-device',
      deviceLabel: 'local',
    }))
    await expect(replace(store, {
      deviceId: 'local-device',
      deviceLabel: 'local',
      clientInstanceId: 'window-a',
      snapshotRevision: 1,
      records: tooManyRecords,
    })).rejects.toThrow(/at most 500 records/i)

    const largePayload = 'x'.repeat(1024 * 1024)
    await expect(replace(store, {
      deviceId: 'local-device',
      deviceLabel: 'local',
      clientInstanceId: 'window-a',
      snapshotRevision: 1,
      records: [
        makeRecord({
          tabKey: 'local:huge',
          tabId: 'huge',
          deviceId: 'local-device',
          deviceLabel: 'local',
          paneCount: 1,
          panes: [{ paneId: 'pane-1', kind: 'terminal', payload: { largePayload } }],
        }),
      ],
    })).rejects.toThrow(/push payload.*1 mib|client snapshot.*512 kib/i)

    await expect(replace(store, {
      deviceId: 'local-device',
      deviceLabel: 'local',
      clientInstanceId: 'window-a',
      snapshotRevision: 1,
      records: [
        makeRecord({ tabKey: 'local:dup', tabId: 'a', deviceId: 'local-device', deviceLabel: 'local' }),
        makeRecord({ tabKey: 'local:dup', tabId: 'b', deviceId: 'local-device', deviceLabel: 'local' }),
      ],
    })).rejects.toThrow(/duplicate tab key/i)
  })
})
