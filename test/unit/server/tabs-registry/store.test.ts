import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import {
  createTabsRegistryStore,
  type TabsRegistryStore,
} from '../../../../server/tabs-registry/store.js'
import type { RegistryTabRecord } from '../../../../server/tabs-registry/types.js'

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

describe('TabsRegistryStore', () => {
  let tempDir: string
  let store: TabsRegistryStore

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tabs-registry-store-'))
    store = createTabsRegistryStore(tempDir, { now: () => NOW })
  })

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  it('returns only live + closed within 24h for default snapshot', async () => {
    const recordOpen = makeRecord({
      tabKey: 'local:open-1',
      tabId: 'open-1',
      deviceId: 'local-device',
      status: 'open',
    })
    const recordClosedRecent = makeRecord({
      tabKey: 'remote:closed-recent',
      tabId: 'closed-recent',
      deviceId: 'remote-device',
      status: 'closed',
      closedAt: NOW - 2 * 60 * 60 * 1000,
      updatedAt: NOW - 2 * 60 * 60 * 1000,
    })
    const recordClosedOld = makeRecord({
      tabKey: 'remote:closed-old',
      tabId: 'closed-old',
      deviceId: 'remote-device',
      status: 'closed',
      closedAt: NOW - 3 * 24 * 60 * 60 * 1000,
      updatedAt: NOW - 3 * 24 * 60 * 60 * 1000,
    })

    await store.upsert(recordOpen)
    await store.upsert(recordClosedRecent)
    await store.upsert(recordClosedOld)

    const result = await store.query({ deviceId: 'local-device' })
    expect(result.localOpen.some((record) => record.tabKey === recordOpen.tabKey)).toBe(true)
    expect(result.closed.some((record) => record.tabKey === recordClosedRecent.tabKey)).toBe(true)
    expect(result.closed.some((record) => record.tabKey === recordClosedOld.tabKey)).toBe(false)
  })

  it('groups remote open tabs separately', async () => {
    await store.upsert(makeRecord({
      tabKey: 'local:open-1',
      tabId: 'open-1',
      deviceId: 'local-device',
      status: 'open',
    }))
    await store.upsert(makeRecord({
      tabKey: 'remote:open-1',
      tabId: 'open-2',
      deviceId: 'remote-device',
      status: 'open',
    }))

    const result = await store.query({ deviceId: 'local-device' })
    expect(result.localOpen).toHaveLength(1)
    expect(result.remoteOpen).toHaveLength(1)
    expect(result.remoteOpen[0]?.deviceId).toBe('remote-device')
  })

  it('uses last-write-wins by revision and updatedAt', async () => {
    const base = makeRecord({
      tabKey: 'local:open-1',
      deviceId: 'local-device',
      tabName: 'older',
      revision: 2,
      updatedAt: NOW - 4_000,
    })
    const stale = makeRecord({
      ...base,
      tabName: 'stale',
      revision: 1,
      updatedAt: NOW - 1_000,
    })
    const newer = makeRecord({
      ...base,
      tabName: 'newer',
      revision: 2,
      updatedAt: NOW,
    })

    await store.upsert(base)
    await store.upsert(stale)
    await store.upsert(newer)

    const result = await store.query({ deviceId: 'local-device' })
    expect(result.localOpen[0]?.tabName).toBe('newer')
  })
})
