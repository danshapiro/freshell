import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import http from 'http'
import WebSocket from 'ws'
import os from 'os'
import path from 'path'
import { promises as fs } from 'fs'
import { createTabsRegistryStore } from '../../server/tabs-registry/store.js'
import { WS_PROTOCOL_VERSION } from '../../shared/ws-protocol'

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

  async function startServer(options: { tabsRegistryStore?: any } = {}) {
    const { WsHandler } = await import('../../server/ws-handler')
    server = http.createServer((_req, res) => {
      res.statusCode = 404
      res.end()
    })
    wsHandler = new WsHandler(
      server,
      new FakeRegistry() as any,
      options,
    )
    port = await listen(server)
  }

  async function connect(): Promise<WebSocket> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    await new Promise<void>((resolve) => ws.on('open', () => resolve()))
    ws.send(JSON.stringify({ type: 'hello', token: 'tabs-sync-token', protocolVersion: WS_PROTOCOL_VERSION }))
    await waitForMessage(ws, (msg) => msg.type === 'ready')
    return ws
  }

  beforeEach(async () => {
    process.env.NODE_ENV = 'test'
    process.env.AUTH_TOKEN = 'tabs-sync-token'
    delete process.env.MAX_REGULAR_WS_MESSAGE_BYTES
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-tabs-registry-'))
  })

  afterEach(async () => {
    wsHandler?.close?.()
    if (server?.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
    await fs.rm(tempDir, { recursive: true, force: true })
    delete process.env.MAX_REGULAR_WS_MESSAGE_BYTES
  })

  it('uses protocol version 6 and rejects version 5 clients with reload-required mismatch', async () => {
    expect(WS_PROTOCOL_VERSION).toBe(6)
    await startServer({ tabsRegistryStore: await createTabsRegistryStore(tempDir, { now: () => NOW }) })
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    await new Promise<void>((resolve) => ws.on('open', () => resolve()))
    ws.send(JSON.stringify({ type: 'hello', token: 'tabs-sync-token', protocolVersion: 5 }))
    const error = await waitForMessage(ws, (msg) => msg.type === 'error' && msg.code === 'PROTOCOL_MISMATCH')
    expect(error.message).toMatch(/expected protocol version 6/i)
    expect(error.message).toMatch(/reload/i)
    ws.close()
  })

  it('accepts v6 push/query, returns same-device/devices, and rejects invalid retention', async () => {
    await startServer({ tabsRegistryStore: await createTabsRegistryStore(tempDir, { now: () => NOW }) })
    const ws = await connect()

    ws.send(JSON.stringify({
      type: 'tabs.sync.push',
      deviceId: 'local-device',
      deviceLabel: 'local',
      clientInstanceId: 'window-a',
      snapshotRevision: 1,
      records: [
        makeRecord({
          tabKey: 'local:open-1',
          tabId: 'open-1',
          status: 'open',
        }),
      ],
    }))
    const localAck = await waitForMessage(ws, (msg) => msg.type === 'tabs.sync.ack')
    expect(localAck).toMatchObject({ accepted: true, openRecords: 1, closedRecords: 0 })

    ws.send(JSON.stringify({
      type: 'tabs.sync.push',
      deviceId: 'local-device',
      deviceLabel: 'local',
      clientInstanceId: 'window-b',
      snapshotRevision: 1,
      records: [
        makeRecord({
          tabKey: 'local:open-2',
          tabId: 'open-2',
          status: 'open',
        }),
      ],
    }))
    await waitForMessage(ws, (msg) => msg.type === 'tabs.sync.ack')

    ws.send(JSON.stringify({
      type: 'tabs.sync.push',
      deviceId: 'remote-device',
      deviceLabel: 'remote',
      clientInstanceId: 'remote-window',
      snapshotRevision: 1,
      records: [
        makeRecord({
          tabKey: 'remote:open-1',
          tabId: 'open-3',
          status: 'open',
        }),
        makeRecord({
          tabKey: 'remote:closed-recent',
          tabId: 'closed-recent',
          status: 'closed',
          updatedAt: NOW - 2 * 60 * 60 * 1000,
          closedAt: NOW - 2 * 60 * 60 * 1000,
        }),
      ],
    }))
    const remoteAck = await waitForMessage(ws, (msg) => msg.type === 'tabs.sync.ack')
    expect(remoteAck).toMatchObject({ accepted: true, openRecords: 1, closedRecords: 1 })

    ws.send(JSON.stringify({
      type: 'tabs.sync.query',
      requestId: 'snapshot-1',
      deviceId: 'local-device',
      clientInstanceId: 'window-a',
      closedTabRetentionDays: 30,
    }))
    const snapshot = await waitForMessage(
      ws,
      (msg) => msg.type === 'tabs.sync.snapshot' && msg.requestId === 'snapshot-1',
    )

    expect(snapshot.data.localOpen.map((record: any) => record.tabKey)).toEqual(['local:open-1'])
    expect(snapshot.data.sameDeviceOpen.map((record: any) => record.tabKey)).toEqual(['local:open-2'])
    expect(snapshot.data.sameDeviceOpen[0].clientInstanceId).toBe('window-b')
    expect(snapshot.data.remoteOpen.map((record: any) => record.tabKey)).toEqual(['remote:open-1'])
    expect(snapshot.data.remoteOpen[0].clientInstanceId).toBe('remote-window')
    expect(snapshot.data.closed.map((record: any) => record.tabKey)).toEqual(['remote:closed-recent'])
    expect(snapshot.data.devices.map((device: any) => device.deviceId).sort()).toEqual(['local-device', 'remote-device'])

    ws.send(JSON.stringify({
      type: 'tabs.sync.query',
      requestId: 'bad-retention',
      deviceId: 'local-device',
      clientInstanceId: 'window-a',
      closedTabRetentionDays: 31,
    }))
    const error = await waitForMessage(ws, (msg) => msg.type === 'error' && msg.requestId === 'bad-retention')
    expect(error.message).toMatch(/closedTabRetentionDays/i)

    ws.send(JSON.stringify({
      type: 'tabs.sync.query',
      requestId: 'missing-client-instance',
      deviceId: 'local-device',
      closedTabRetentionDays: 30,
    }))
    const missingClientError = await waitForMessage(
      ws,
      (msg) => msg.type === 'error' && msg.requestId === 'missing-client-instance',
    )
    expect(missingClientError.message).toMatch(/clientInstanceId/i)
    ws.close()
  })

  it('requires clientInstanceId/snapshotRevision and retires only that client snapshot', async () => {
    await startServer({ tabsRegistryStore: await createTabsRegistryStore(tempDir, { now: () => NOW }) })
    const ws = await connect()

    ws.send(JSON.stringify({
      type: 'tabs.sync.push',
      deviceId: 'local-device',
      deviceLabel: 'local',
      records: [],
    }))
    const invalid = await waitForMessage(ws, (msg) => msg.type === 'error' && msg.code === 'INVALID_MESSAGE')
    expect(invalid.message).toMatch(/clientInstanceId|snapshotRevision/)

    for (const clientInstanceId of ['window-a', 'window-b']) {
      ws.send(JSON.stringify({
        type: 'tabs.sync.push',
        deviceId: 'local-device',
        deviceLabel: 'local',
        clientInstanceId,
        snapshotRevision: 1,
        records: [
          makeRecord({
            tabKey: `local:${clientInstanceId}`,
            tabId: clientInstanceId,
            status: 'open',
          }),
        ],
      }))
      await waitForMessage(ws, (msg) => msg.type === 'tabs.sync.ack')
    }

    ws.send(JSON.stringify({
      type: 'tabs.sync.client.retire',
      deviceId: 'local-device',
      clientInstanceId: 'window-a',
      snapshotRevision: 2,
    }))

    let snapshot: any
    await vi.waitFor(async () => {
      const requestId = `snapshot-after-retire-${Date.now()}-${Math.random()}`
      ws.send(JSON.stringify({
        type: 'tabs.sync.query',
        requestId,
        deviceId: 'local-device',
        clientInstanceId: 'window-b',
        closedTabRetentionDays: 30,
      }))
      snapshot = await waitForMessage(
        ws,
        (msg) => msg.type === 'tabs.sync.snapshot' && msg.requestId === requestId,
      )
      expect(snapshot.data.sameDeviceOpen).toHaveLength(0)
    })
    expect(snapshot.data.localOpen.map((record: any) => record.tabKey)).toEqual(['local:window-b'])
    expect(snapshot.data.sameDeviceOpen).toHaveLength(0)
    ws.close()
  })

  it('returns a clear query error when the registry is unavailable', async () => {
    await startServer()
    const ws = await connect()

    ws.send(JSON.stringify({
      type: 'tabs.sync.query',
      requestId: 'missing-store',
      deviceId: 'local-device',
      clientInstanceId: 'window-a',
      closedTabRetentionDays: 30,
    }))
    const error = await waitForMessage(ws, (msg) => msg.type === 'error' && msg.requestId === 'missing-store')
    expect(error.message).toMatch(/tabs registry unavailable/i)
    ws.close()
  })

  it('returns clear tabs sync errors for store validation failures instead of crashing', async () => {
    await startServer({ tabsRegistryStore: await createTabsRegistryStore(tempDir, { now: () => NOW }) })
    const ws = await connect()

    ws.send(JSON.stringify({
      type: 'tabs.sync.push',
      deviceId: 'local-device',
      deviceLabel: 'local',
      clientInstanceId: 'window-a',
      snapshotRevision: 1,
      records: Array.from({ length: 501 }, (_, i) => makeRecord({
        tabKey: `local:${i}`,
        tabId: `tab-${i}`,
        status: 'open',
      })),
    }))

    const error = await waitForMessage(ws, (msg) => msg.type === 'error')
    expect(error).toMatchObject({ code: 'INVALID_MESSAGE' })
    expect(error.message).toMatch(/at most 500 records/i)
    expect(ws.readyState).not.toBe(WebSocket.CLOSED)
    ws.close()
  })

  it('serves migrated legacy tabs once websocket startup accepts queries', async () => {
    const legacyPath = path.join(tempDir, 'tabs-registry.jsonl')
    await fs.writeFile(legacyPath, `${JSON.stringify(makeRecord({
      tabKey: 'remote:legacy-open',
      tabId: 'legacy-open',
      serverInstanceId: 'legacy-srv',
      deviceId: 'remote-device',
      deviceLabel: 'remote',
      status: 'open',
    }))}\n`, 'utf-8')
    const migratedStore = await createTabsRegistryStore(tempDir, { now: () => NOW })
    await startServer({ tabsRegistryStore: migratedStore })
    const ws = await connect()

    ws.send(JSON.stringify({
      type: 'tabs.sync.query',
      requestId: 'legacy-after-startup',
      deviceId: 'local-device',
      clientInstanceId: 'window-a',
      closedTabRetentionDays: 30,
    }))
    const snapshot = await waitForMessage(
      ws,
      (msg) => msg.type === 'tabs.sync.snapshot' && msg.requestId === 'legacy-after-startup',
    )

    expect(snapshot.data.remoteOpen.map((record: any) => record.tabKey)).toEqual(['remote:legacy-open'])
    await expect(fs.stat(legacyPath)).rejects.toMatchObject({ code: 'ENOENT' })
    ws.close()
  })

  it('rejects oversized regular websocket messages before normal parsing with a clear error', async () => {
    process.env.MAX_REGULAR_WS_MESSAGE_BYTES = '256'
    await startServer({ tabsRegistryStore: await createTabsRegistryStore(tempDir, { now: () => NOW }) })
    const ws = await connect()

    ws.send(JSON.stringify({
      type: 'tabs.sync.push',
      deviceId: 'local-device',
      deviceLabel: 'local',
      clientInstanceId: 'window-a',
      snapshotRevision: 1,
      records: [
        makeRecord({
          tabKey: 'local:large',
          tabId: 'large',
          panes: [{ paneId: 'pane-1', kind: 'terminal', payload: { text: 'x'.repeat(512) } }],
        }),
      ],
    }))

    const error = await waitForMessage(ws, (msg) => msg.type === 'error')
    expect(error.message).toMatch(/message.*256 bytes/i)
    ws.close()
    delete process.env.MAX_REGULAR_WS_MESSAGE_BYTES
  })

  it('does not allow oversized regular websocket messages to bypass the cap with screenshot text in another field', async () => {
    process.env.MAX_REGULAR_WS_MESSAGE_BYTES = '256'
    await startServer({ tabsRegistryStore: await createTabsRegistryStore(tempDir, { now: () => NOW }) })
    const ws = await connect()

    ws.send(JSON.stringify({
      type: 'tabs.sync.push',
      junk: '"type":"ui.screenshot.result"' + 'x'.repeat(512),
      deviceId: 'local-device',
      deviceLabel: 'local',
      clientInstanceId: 'window-a',
      snapshotRevision: 1,
      records: [],
    }))

    const error = await waitForMessage(ws, (msg) => msg.type === 'error')
    expect(error.message).toMatch(/message.*256 bytes/i)
    ws.close()
    delete process.env.MAX_REGULAR_WS_MESSAGE_BYTES
  })

  it('does not allow screenshot-shaped websocket envelopes to carry oversized unknown fields', async () => {
    process.env.MAX_REGULAR_WS_MESSAGE_BYTES = '256'
    await startServer({ tabsRegistryStore: await createTabsRegistryStore(tempDir, { now: () => NOW }) })
    const ws = await connect()

    ws.send(JSON.stringify({
      type: 'ui.screenshot.result',
      requestId: 'unknown-junk',
      ok: false,
      junk: 'x'.repeat(512),
    }))

    const error = await waitForMessage(ws, (msg) => msg.type === 'error')
    expect(error.message).toMatch(/message.*256 bytes|unknown.*field/i)
    ws.close()
    delete process.env.MAX_REGULAR_WS_MESSAGE_BYTES
  })
})
