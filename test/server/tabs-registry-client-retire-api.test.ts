import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import express from 'express'
import cookieParser from 'cookie-parser'
import request from 'supertest'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'

import { httpAuthMiddleware } from '../../server/auth.js'
import {
  createTabsRegistryStore,
  type TabsRegistryStore,
} from '../../server/tabs-registry/store.js'
import type { RegistryTabRecord } from '../../server/tabs-registry/types.js'
import { createTabsSyncRouter } from '../../server/tabs-registry/client-retire-router.js'

const AUTH_TOKEN = 'tabs-sync-retire-token'
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

function createApp(store: TabsRegistryStore) {
  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use('/api', httpAuthMiddleware)
  app.use('/api/tabs-sync', createTabsSyncRouter({ tabsRegistryStore: store }))
  return app
}

describe('tabs registry client retire HTTP API', () => {
  let tempDir: string
  let store: TabsRegistryStore

  beforeEach(async () => {
    process.env.NODE_ENV = 'test'
    process.env.AUTH_TOKEN = AUTH_TOKEN
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tabs-registry-client-retire-api-'))
    store = await createTabsRegistryStore(tempDir, { now: () => NOW })
  })

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true })
    delete process.env.AUTH_TOKEN
  })

  it('rejects unauthenticated retire requests', async () => {
    const app = createApp(store)

    const response = await request(app)
      .post('/api/tabs-sync/client-retire')
      .send({
        deviceId: 'local-device',
        clientInstanceId: 'window-a',
        snapshotRevision: 2,
      })

    expect(response.status).toBe(401)
    expect(response.body).toEqual({ error: 'Unauthorized' })
  })

  it('retires only the matching client snapshot with header auth', async () => {
    const app = createApp(store)
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

    const response = await request(app)
      .post('/api/tabs-sync/client-retire')
      .set('x-auth-token', AUTH_TOKEN)
      .send({
        deviceId: 'local-device',
        clientInstanceId: 'window-a',
        snapshotRevision: 2,
      })

    expect(response.status).toBe(200)
    expect(response.body).toEqual({ ok: true, accepted: true })

    const snapshot = await store.query({
      deviceId: 'local-device',
      clientInstanceId: 'window-b',
      closedTabRetentionDays: 30,
    })
    expect(snapshot.localOpen.map((record) => record.tabKey)).toEqual(['local:b'])
    expect(snapshot.sameDeviceOpen).toEqual([])
  })

  it('accepts cookie auth for sendBeacon unload requests', async () => {
    const app = createApp(store)
    await replace(store, {
      deviceId: 'local-device',
      deviceLabel: 'local',
      clientInstanceId: 'window-a',
      snapshotRevision: 1,
      records: [
        makeRecord({ tabKey: 'local:a', tabId: 'a', deviceId: 'local-device', deviceLabel: 'local', tabName: 'A' }),
      ],
    })

    const response = await request(app)
      .post('/api/tabs-sync/client-retire')
      .set('Cookie', [`freshell-auth=${AUTH_TOKEN}`])
      .send({
        deviceId: 'local-device',
        clientInstanceId: 'window-a',
        snapshotRevision: 2,
      })

    expect(response.status).toBe(200)
    expect(response.body).toEqual({ ok: true, accepted: true })

    const snapshot = await store.query({
      deviceId: 'local-device',
      clientInstanceId: 'window-a',
      closedTabRetentionDays: 30,
    })
    expect(snapshot.localOpen).toEqual([])
  })

  it('returns a clear 400 for invalid retire payloads', async () => {
    const app = createApp(store)

    const response = await request(app)
      .post('/api/tabs-sync/client-retire')
      .set('x-auth-token', AUTH_TOKEN)
      .send({
        deviceId: 'local-device',
        clientInstanceId: 'window-a',
      })

    expect(response.status).toBe(400)
    expect(response.body.error).toBe('Invalid tabs registry retire payload')
    expect(response.body.details).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: ['snapshotRevision'] }),
    ]))
  })

  it('returns accepted false for equal or stale retire revisions and leaves the snapshot', async () => {
    const app = createApp(store)
    await replace(store, {
      deviceId: 'local-device',
      deviceLabel: 'local',
      clientInstanceId: 'window-a',
      snapshotRevision: 3,
      records: [
        makeRecord({ tabKey: 'local:a', tabId: 'a', deviceId: 'local-device', deviceLabel: 'local', tabName: 'A' }),
      ],
    })

    const equalResponse = await request(app)
      .post('/api/tabs-sync/client-retire')
      .set('x-auth-token', AUTH_TOKEN)
      .send({
        deviceId: 'local-device',
        clientInstanceId: 'window-a',
        snapshotRevision: 3,
      })
    const staleResponse = await request(app)
      .post('/api/tabs-sync/client-retire')
      .set('x-auth-token', AUTH_TOKEN)
      .send({
        deviceId: 'local-device',
        clientInstanceId: 'window-a',
        snapshotRevision: 2,
      })

    expect(equalResponse.status).toBe(200)
    expect(equalResponse.body).toEqual({ ok: true, accepted: false })
    expect(staleResponse.status).toBe(200)
    expect(staleResponse.body).toEqual({ ok: true, accepted: false })

    const snapshot = await store.query({
      deviceId: 'local-device',
      clientInstanceId: 'window-a',
      closedTabRetentionDays: 30,
    })
    expect(snapshot.localOpen.map((record) => record.tabKey)).toEqual(['local:a'])
  })
})

describe('main server tabs-sync route mount', () => {
  it('mounts the tabs-sync router after auth and store creation', async () => {
    const source = await fs.readFile(path.join(process.cwd(), 'server/index.ts'), 'utf-8')

    const importIndex = source.indexOf("import { createTabsSyncRouter } from './tabs-registry/client-retire-router.js'")
    const authIndex = source.indexOf("app.use('/api', httpAuthMiddleware)")
    const storeIndex = source.indexOf('const tabsRegistryStore = await createTabsRegistryStore()')
    const mountIndex = source.indexOf("app.use('/api/tabs-sync', createTabsSyncRouter({ tabsRegistryStore }))")

    expect(importIndex).toBeGreaterThanOrEqual(0)
    expect(authIndex).toBeGreaterThanOrEqual(0)
    expect(storeIndex).toBeGreaterThanOrEqual(0)
    expect(mountIndex).toBeGreaterThan(authIndex)
    expect(mountIndex).toBeGreaterThan(storeIndex)
  })
})
