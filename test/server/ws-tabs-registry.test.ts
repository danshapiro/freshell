import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import http from 'http'
import WebSocket from 'ws'
import os from 'os'
import path from 'path'
import { promises as fs } from 'fs'
import { createTabsRegistryStore } from '../../server/tabs-registry/store.js'

vi.mock('../../server/config-store', () => ({
  configStore: {
    snapshot: vi.fn().mockResolvedValue({
      version: 1,
      settings: {},
      sessionOverrides: {},
      terminalOverrides: {},
      projectColors: {},
    }),
  },
}))

const NOW = 1_740_000_000_000

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to bind test server'))
        return
      }
      resolve(address.port)
    })
  })
}

function waitForMessage(ws: WebSocket, predicate: (msg: any) => boolean, timeoutMs = 3000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.off('message', onMessage)
      reject(new Error('Timed out waiting for websocket message'))
    }, timeoutMs)

    const onMessage = (raw: WebSocket.Data) => {
      const msg = JSON.parse(raw.toString())
      if (!predicate(msg)) return
      clearTimeout(timeout)
      ws.off('message', onMessage)
      resolve(msg)
    }

    ws.on('message', onMessage)
  })
}

function makeRecord(overrides: Record<string, unknown>) {
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

class FakeRegistry {
  list() { return [] }
  get() { return null }
  create() { throw new Error('not used') }
  attach() { return null }
  finishAttachSnapshot() {}
  detach() { return false }
  input() { return false }
  resize() { return false }
  kill() { return false }
  findRunningClaudeTerminalBySession() { return undefined }
}

describe('ws tabs registry protocol', () => {
  let server: http.Server
  let port: number
  let wsHandler: any
  let tempDir: string

  beforeAll(async () => {
    process.env.NODE_ENV = 'test'
    process.env.AUTH_TOKEN = 'tabs-sync-token'

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-tabs-registry-'))
    const tabsStore = createTabsRegistryStore(tempDir, { now: () => NOW })

    const { WsHandler } = await import('../../server/ws-handler')
    server = http.createServer((_req, res) => {
      res.statusCode = 404
      res.end()
    })
    wsHandler = new WsHandler(
      server,
      new FakeRegistry() as any,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      tabsStore,
    )
    port = await listen(server)
  })

  afterAll(async () => {
    wsHandler?.close?.()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  it('accepts tabs.sync.push and returns tabs.sync.snapshot (default 24h)', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    await new Promise<void>((resolve) => ws.on('open', () => resolve()))
    ws.send(JSON.stringify({ type: 'hello', token: 'tabs-sync-token' }))
    await waitForMessage(ws, (msg) => msg.type === 'ready')

    ws.send(JSON.stringify({
      type: 'tabs.sync.push',
      deviceId: 'local-device',
      deviceLabel: 'danlaptop',
      records: [
        makeRecord({
          tabKey: 'local:open-1',
          tabId: 'open-1',
          status: 'open',
        }),
      ],
    }))
    await waitForMessage(ws, (msg) => msg.type === 'tabs.sync.ack')

    ws.send(JSON.stringify({
      type: 'tabs.sync.push',
      deviceId: 'remote-device',
      deviceLabel: 'danshapiromain',
      records: [
        makeRecord({
          tabKey: 'remote:open-1',
          tabId: 'open-2',
          status: 'open',
        }),
        makeRecord({
          tabKey: 'remote:closed-recent',
          tabId: 'closed-recent',
          status: 'closed',
          updatedAt: NOW - 2 * 60 * 60 * 1000,
          closedAt: NOW - 2 * 60 * 60 * 1000,
        }),
        makeRecord({
          tabKey: 'remote:closed-old',
          tabId: 'closed-old',
          status: 'closed',
          updatedAt: NOW - 5 * 24 * 60 * 60 * 1000,
          closedAt: NOW - 5 * 24 * 60 * 60 * 1000,
        }),
      ],
    }))
    await waitForMessage(ws, (msg) => msg.type === 'tabs.sync.ack')

    ws.send(JSON.stringify({
      type: 'tabs.sync.query',
      requestId: 'snapshot-1',
      deviceId: 'local-device',
    }))
    const snapshot = await waitForMessage(
      ws,
      (msg) => msg.type === 'tabs.sync.snapshot' && msg.requestId === 'snapshot-1',
    )

    expect(snapshot.data.localOpen.some((record: any) => record.tabKey === 'local:open-1')).toBe(true)
    expect(snapshot.data.remoteOpen.some((record: any) => record.tabKey === 'remote:open-1')).toBe(true)
    expect(snapshot.data.closed.some((record: any) => record.tabKey === 'remote:closed-recent')).toBe(true)
    expect(snapshot.data.closed.some((record: any) => record.tabKey === 'remote:closed-old')).toBe(false)

    ws.send(JSON.stringify({
      type: 'tabs.sync.query',
      requestId: 'snapshot-2',
      deviceId: 'local-device',
      rangeDays: 30,
    }))
    const longRange = await waitForMessage(
      ws,
      (msg) => msg.type === 'tabs.sync.snapshot' && msg.requestId === 'snapshot-2',
    )
    expect(longRange.data.closed.some((record: any) => record.tabKey === 'remote:closed-old')).toBe(true)
    ws.close()
  })
})
