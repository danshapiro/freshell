/**
 * Behavioral tests for the hoststats.* ws wiring (Task 4 of
 * docs/plans/2026-08-25-host-pressure-pane.md): subscribe/unsubscribe lifecycle gating
 * the sampling service on/off, immediate + fanned-out snapshot delivery limited to
 * subscribed+authenticated sockets, per-request refresh responses, and the two-layer
 * refresh rate limit (per-connection floor + service-level post-completion cooldown).
 *
 * Scaffolding cloned from test/server/ws-codex-activity.test.ts (FakeRegistry,
 * listen-on-port-0, hello->ready dance, waitForMessage/expectNoMatchingMessage) with a
 * REAL HostStatsService (fastMs 25 / slowMs 50) reading the Task 2 fixture tree under
 * test/fixtures/host-stats/. statfs in the disks section hits the REAL host mounts
 * ('/' and '/dev/shm'), so refresh assertions are shape + numerically sane, never
 * fixture-exact.
 */
import { describe, it, expect, vi } from 'vitest'
import http from 'http'
import path from 'path'
import WebSocket from 'ws'
import {
  WS_PROTOCOL_VERSION,
  HostStatsSnapshotSchema,
  HostStatsRefreshResponseSchema,
} from '../../shared/ws-protocol'
import type { HostStatsService } from '../../server/host-stats/service'
import type { HostStatsServiceDeps } from '../../server/host-stats/service'
import type { WsHandler } from '../../server/ws-handler'

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

const AUTH_TOKEN = 'hoststats-test-token'
const FIXTURES = path.resolve(__dirname, '../fixtures/host-stats')
const PROC = path.join(FIXTURES, 'proc')
const PROMINI = path.join(FIXTURES, 'procmini')
const SYS = path.join(FIXTURES, 'sys')

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

function expectNoMatchingMessage(ws: WebSocket, predicate: (msg: any) => boolean, timeoutMs = 250): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.off('message', onMessage)
      resolve()
    }, timeoutMs)

    const onMessage = (raw: WebSocket.Data) => {
      const msg = JSON.parse(raw.toString())
      if (!predicate(msg)) return
      clearTimeout(timeout)
      ws.off('message', onMessage)
      reject(new Error(`Unexpected websocket message: ${JSON.stringify(msg)}`))
    }

    ws.on('message', onMessage)
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function until(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for condition')
    await sleep(15)
  }
}

class FakeRegistry {
  list() {
    return []
  }
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

type HostStatsTestServer = {
  server: http.Server
  wsHandler: WsHandler
  service: HostStatsService
  port: number
}

async function setupHostStatsServer(serviceDeps: HostStatsServiceDeps = {}): Promise<HostStatsTestServer> {
  process.env.NODE_ENV = 'test'
  process.env.AUTH_TOKEN = AUTH_TOKEN

  const { WsHandler } = await import('../../server/ws-handler')
  const { HostStatsService } = await import('../../server/host-stats/service')

  const server = http.createServer((_req, res) => {
    res.statusCode = 404
    res.end()
  })
  // fast/slow tiers fast enough for tick-window assertions (fastMs 25 / slowMs 50).
  const service = new HostStatsService({ procRoot: PROC, sysRoot: SYS, fastMs: 25, slowMs: 50, ...serviceDeps })
  const wsHandler = new WsHandler(server, new FakeRegistry() as any, { hostStats: service })
  // Same wiring shape as server/index.ts: sources close over the handler, so they are
  // set AFTER it exists. wsClientsMax 50 mirrors the default MAX_CONNECTIONS fallback.
  service.setSources({
    getPtyCounts: () => ({ running: 0, max: 10 }),
    getWsClientCounts: () => ({ clients: wsHandler.connectionCount(), max: 50 }),
  })
  const port = await listen(server)
  return { server, wsHandler, service, port }
}

async function teardownHostStatsServer(ctx: HostStatsTestServer): Promise<void> {
  ctx.wsHandler.close()
  ctx.service.stop()
  await new Promise<void>((resolve) => ctx.server.close(() => resolve()))
}

async function connectAuthenticated(port: number): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
  await new Promise<void>((resolve) => ws.on('open', () => resolve()))
  ws.send(JSON.stringify({ type: 'hello', token: AUTH_TOKEN, protocolVersion: WS_PROTOCOL_VERSION }))
  await waitForMessage(ws, (msg) => msg.type === 'ready')
  return ws
}

describe('ws hoststats protocol', () => {
  it('(a) subscribe starts the service, sends an immediate schema-shaped snapshot, then ticks', async () => {
    const ctx = await setupHostStatsServer()
    try {
      const ws = await connectAuthenticated(ctx.port)
      ws.send(JSON.stringify({ type: 'hoststats.subscribe' }))

      const first = await waitForMessage(ws, (msg) => msg.type === 'hoststats.snapshot')
      const parsed = HostStatsSnapshotSchema.safeParse(first)
      expect(parsed.success).toBe(true)
      expect(first.live.machine.cores).toBeGreaterThan(0)
      expect(ctx.service.isRunning()).toBe(true)

      // fastMs is 25 -> two further snapshots comfortably inside 300ms.
      await waitForMessage(ws, (msg) => msg.type === 'hoststats.snapshot', 300)
      await waitForMessage(ws, (msg) => msg.type === 'hoststats.snapshot', 300)
      ws.close()
    } finally {
      await teardownHostStatsServer(ctx)
    }
  })

  it('(b) snapshot live values are fixture-consistent (load/memory/cpu)', async () => {
    const ctx = await setupHostStatsServer()
    try {
      const ws = await connectAuthenticated(ctx.port)
      ws.send(JSON.stringify({ type: 'hoststats.subscribe' }))
      const first = await waitForMessage(ws, (msg) => msg.type === 'hoststats.snapshot')

      // fixture proc/loadavg: "0.50 1.00 1.20 2/1234 5678"
      expect(first.live.load).toMatchObject({ available: true, load1: 0.5, load5: 1, load15: 1.2 })
      expect(first.live.cpu.available).toBe(true)
      // fixture proc/meminfo: MemTotal 67108864 kB, MemAvailable 33554432 kB, host source
      expect(first.live.memory).toMatchObject({
        available: true,
        source: 'host',
        totalBytes: 67108864 * 1024,
        availableBytes: 33554432 * 1024,
      })
      // freshell internals come from setSources wiring (wsClientsMax 50 as passed above)
      expect(first.live.freshell).toMatchObject({ available: true, ptysMax: 10, wsClientsMax: 50 })
      ws.close()
    } finally {
      await teardownHostStatsServer(ctx)
    }
  })

  it('(c) unsubscribe stops the stream and (1->0) stops the service', async () => {
    const ctx = await setupHostStatsServer()
    try {
      const ws = await connectAuthenticated(ctx.port)
      ws.send(JSON.stringify({ type: 'hoststats.subscribe' }))
      await waitForMessage(ws, (msg) => msg.type === 'hoststats.snapshot')
      expect(ctx.service.isRunning()).toBe(true)

      ws.send(JSON.stringify({ type: 'hoststats.unsubscribe' }))
      await until(() => !ctx.service.isRunning())
      // absorb any rounds already on the wire before opening the quiet window
      await sleep(100)
      await expect(
        expectNoMatchingMessage(ws, (msg) => msg.type === 'hoststats.snapshot', 150),
      ).resolves.toBeUndefined()
      ws.close()
    } finally {
      await teardownHostStatsServer(ctx)
    }
  })

  it('(d) the last subscriber closing its socket stops the service; earlier closes do not', async () => {
    const ctx = await setupHostStatsServer()
    try {
      const ws1 = await connectAuthenticated(ctx.port)
      const ws2 = await connectAuthenticated(ctx.port)
      ws1.send(JSON.stringify({ type: 'hoststats.subscribe' }))
      ws2.send(JSON.stringify({ type: 'hoststats.subscribe' }))
      await waitForMessage(ws1, (msg) => msg.type === 'hoststats.snapshot')
      await waitForMessage(ws2, (msg) => msg.type === 'hoststats.snapshot')
      expect(ctx.service.isRunning()).toBe(true)

      ws1.close()
      await until(() => ctx.wsHandler.connectionCount() === 1)
      // one subscriber still attached -> service keeps sampling
      expect(ctx.service.isRunning()).toBe(true)

      ws2.close()
      await until(() => !ctx.service.isRunning())
    } finally {
      await teardownHostStatsServer(ctx)
    }
  })

  it('(e) refresh answers the requester with its own requestId and real-host disks', async () => {
    const ctx = await setupHostStatsServer()
    try {
      const ws = await connectAuthenticated(ctx.port)
      ws.send(JSON.stringify({ type: 'hoststats.refresh', requestId: 'refresh-e1' }))
      const response = await waitForMessage(
        ws,
        (msg) => msg.type === 'hoststats.refresh.response' && msg.requestId === 'refresh-e1',
        5000,
      )
      expect(HostStatsRefreshResponseSchema.safeParse(response).success).toBe(true)
      expect(response.ok).toBe(true)
      expect(typeof response.at).toBe('number')

      // statfs runs against the REAL host: assert shape + numerically sane, not fixture-exact.
      expect(response.manual.disks.list.length).toBeGreaterThan(0)
      const rootMount = response.manual.disks.list.find((d: any) => d.mount === '/')
      expect(rootMount).toBeDefined()
      expect(rootMount.totalBytes).toBeGreaterThan(0)
      expect(rootMount.freeBytes).toBeGreaterThanOrEqual(0)
      expect(rootMount.usedPct).toBeGreaterThanOrEqual(0)
      expect(rootMount.usedPct).toBeLessThanOrEqual(100)
      ws.close()
    } finally {
      await teardownHostStatsServer(ctx)
    }
  })

  it('(e2) a section blowing its budget degrades to available:false while the response stays ok', async () => {
    // procmini has 7 numeric pids; the 300ms scan dwell always blows a 1ms budget.
    const ctx = await setupHostStatsServer({ procRoot: PROMINI, sectionBudgetMs: 1 })
    try {
      const ws = await connectAuthenticated(ctx.port)
      ws.send(JSON.stringify({ type: 'hoststats.refresh', requestId: 'refresh-e2' }))
      const response = await waitForMessage(
        ws,
        (msg) => msg.type === 'hoststats.refresh.response' && msg.requestId === 'refresh-e2',
        5000,
      )
      expect(HostStatsRefreshResponseSchema.safeParse(response).success).toBe(true)
      expect(response.ok).toBe(true)
      expect(response.manual.topProcesses.available).toBe(false)
      expect(typeof response.manual.sectionErrors.topProcesses).toBe('string')
      ws.close()
    } finally {
      await teardownHostStatsServer(ctx)
    }
  })

  it('(f) a pre-hello subscribe is rejected by the existing NOT_AUTHENTICATED gate', async () => {
    const ctx = await setupHostStatsServer()
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${ctx.port}/ws`)
      await new Promise<void>((resolve) => ws.on('open', () => resolve()))
      ws.send(JSON.stringify({ type: 'hoststats.subscribe' }))
      const error = await waitForMessage(ws, (msg) => msg.type === 'error')
      expect(error.code).toBe('NOT_AUTHENTICATED')
      expect(ctx.service.isRunning()).toBe(false)
      ws.close()
    } finally {
      await teardownHostStatsServer(ctx)
    }
  })

  it('(g) with zero subscribers the service never samples (zero-cost idle)', async () => {
    const ctx = await setupHostStatsServer()
    try {
      expect(ctx.service.isRunning()).toBe(false)
      await sleep(150) // several fastMs (25ms) and slowMs (50ms) windows elapse
      expect(ctx.service.isRunning()).toBe(false)
    } finally {
      await teardownHostStatsServer(ctx)
    }
  })

  it('(h) refresh is rate-limited per-connection AND by the service post-completion cooldown', async () => {
    const ctx = await setupHostStatsServer()
    try {
      const refreshSpy = vi.spyOn(ctx.service, 'refresh')
      const ws1 = await connectAuthenticated(ctx.port)
      const firstResponsePromise = waitForMessage(
        ws1,
        (msg) => msg.type === 'hoststats.refresh.response' && msg.requestId === 'refresh-h1',
        5000,
      )
      ws1.send(JSON.stringify({ type: 'hoststats.refresh', requestId: 'refresh-h1' }))
      await sleep(100) // < the 1000ms per-connection floor
      ws1.send(JSON.stringify({ type: 'hoststats.refresh', requestId: 'refresh-h2' }))

      const second = await waitForMessage(
        ws1,
        (msg) => msg.type === 'hoststats.refresh.response' && msg.requestId === 'refresh-h2',
      )
      expect(second).toMatchObject({ ok: false, error: 'rate_limited' })
      // the per-connection floor rejected WITHOUT invoking the service
      expect(refreshSpy).toHaveBeenCalledTimes(1)

      const first = await firstResponsePromise
      expect(first.ok).toBe(true)

      // Multi-socket bypass (R3M6): a FRESH connection has a clean per-connection floor,
      // but <1000ms after the first refresh COMPLETED the service-level cooldown rejects.
      const ws2 = await connectAuthenticated(ctx.port)
      ws2.send(JSON.stringify({ type: 'hoststats.refresh', requestId: 'refresh-h3' }))
      const third = await waitForMessage(
        ws2,
        (msg) => msg.type === 'hoststats.refresh.response' && msg.requestId === 'refresh-h3',
      )
      expect(third).toMatchObject({ ok: false, error: 'rate_limited' })
      // the service WAS invoked (per-conn floor clean) and rejected from its own cooldown
      expect(refreshSpy).toHaveBeenCalledTimes(2)
      ws1.close()
      ws2.close()
    } finally {
      await teardownHostStatsServer(ctx)
    }
  })
})
