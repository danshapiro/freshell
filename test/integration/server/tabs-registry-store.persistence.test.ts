import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { createTabsRegistryStore } from '../../../server/tabs-registry/store.js'
import type { RegistryTabRecord } from '../../../server/tabs-registry/types.js'

const NOW = 1_740_000_000_000

function makeRecord(overrides: Partial<RegistryTabRecord>): RegistryTabRecord {
  return {
    tabKey: 'device-1:tab-1',
    tabId: 'tab-1',
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

describe('tabs registry store persistence', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tabs-registry-persist-'))
  })

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  it('rehydrates records from append-only JSONL log', async () => {
    const writer = createTabsRegistryStore(tempDir, { now: () => NOW })
    const openRecord = makeRecord({
      tabKey: 'local:open-1',
      tabId: 'open-1',
      deviceId: 'local-device',
      status: 'open',
      revision: 3,
      updatedAt: NOW - 5_000,
    })
    const closedRecord = makeRecord({
      tabKey: 'remote:closed-1',
      tabId: 'closed-1',
      deviceId: 'remote-device',
      status: 'closed',
      revision: 5,
      closedAt: NOW - 5000,
      updatedAt: NOW - 5000,
    })

    await writer.upsert(openRecord)
    await writer.upsert(closedRecord)

    const reader = createTabsRegistryStore(tempDir, { now: () => NOW })
    const result = await reader.query({ deviceId: 'local-device' })
    expect(result.localOpen.some((record) => record.tabKey === openRecord.tabKey)).toBe(true)
    expect(result.closed.some((record) => record.tabKey === closedRecord.tabKey)).toBe(true)
  })
})
