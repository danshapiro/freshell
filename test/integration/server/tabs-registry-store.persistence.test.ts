import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createReadStream, promises as fs } from 'fs'
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

  it('rejects corrupt compact state with a clear error instead of serving empty data', async () => {
    await fs.mkdir(path.join(tempDir, 'v1'), { recursive: true })
    await fs.writeFile(path.join(tempDir, 'v1', 'manifest.json'), '{"version":1,"openSnapshots":{}}', 'utf-8')

    await expect(createTabsRegistryStore(tempDir, { now: () => now })).rejects.toThrow(/tabs registry compact state.*invalid|manifest/i)
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
