/**
 * HARNESS-14 — the controllable server clock, proven over the wire against the
 * owned Rust baseline (see `docs/plans/df1/HARNESS-14.md`).
 *
 * What this spec proves (the checklist acceptance, verbatim):
 *   "Advance/freeze/reset the clock from one serial spec, assert fixture
 *    timers fire in deterministic order, and launch a normal build to prove
 *    the control surface is absent."
 *
 *   - advance/freeze/resume/reset round-trip + validation + auth (401/400s)
 *     against an owned server booted with `FRESHELL_TEST_CLOCK=1`;
 *   - DETERMINISTIC ORDER with ZERO wall sleeps: with the clock FROZEN, a
 *     detached terminal created at virtual T reaps exactly when a virtual
 *     step carries it past `safety.autoKillIdleMinutes`, while a terminal
 *     created at a later frozen instant survives — then a further step
 *     reaps it too (fixture timers firing in deterministic order). The idle
 *     sweep cadence under the gate is 250ms, so the poll
 *     budgets here observe virtual crossings in ~1s of real time, not the
 *     30s production cadence and never 15 real minutes.
 *   - ABSENCE: the worker-scoped default fixture (booted WITHOUT the env
 *     var — i.e. a normal build) answers every clock verb with the
 *     catch-all's 404.
 *
 * Serial mode: the clock is process-global inside each booted server, and
 * each test here boots its OWN gated server, so parallelism across tests is
 * safe; serial just keeps the virtual-order assertions per-test scoped.
 */
import WebSocket from 'ws'
import { test, expect } from '../helpers/fixtures.js'
import type { E2eServerInfo } from '../helpers/server-fixture-support.js'
import { createE2eServerHandle, type E2eServerHandle } from '../helpers/external-target.js'
import { WS_PROTOCOL_VERSION } from '../../../shared/ws-protocol.js'

interface ClockState {
  ok: boolean
  enabled: boolean
  mode: 'live' | 'frozen'
  nowMs: number
  offsetMs: number
}

function clockHeaders(info: E2eServerInfo) {
  return { 'x-auth-token': info.token, 'content-type': 'application/json' }
}

async function clockGet(info: E2eServerInfo): Promise<ClockState> {
  const res = await fetch(`${info.baseUrl}/api/test-clock`, { headers: clockHeaders(info) })
  expect(res.status, 'GET /api/test-clock').toBe(200)
  return (await res.json()) as ClockState
}

async function clockPost(info: E2eServerInfo, verb: string, body?: unknown): Promise<ClockState> {
  const res = await fetch(`${info.baseUrl}/api/test-clock/${verb}`, {
    method: 'POST',
    headers: clockHeaders(info),
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  expect(res.status, `POST /api/test-clock/${verb}`).toBe(200)
  return (await res.json()) as ClockState
}

/** Raw WS hello + ready (donor: ws-ping-pong-matrix.spec.ts). */
function connectAndHello(wsUrl: string, token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    const timeout = setTimeout(() => {
      ws.removeAllListeners()
      ws.terminate()
      reject(new Error('Timed out waiting for ready after hello'))
    }, 15_000)
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'hello', token, protocolVersion: WS_PROTOCOL_VERSION }))
    })
    ws.on('message', (raw) => {
      const message = JSON.parse(String(raw))
      if (message?.type === 'ready') {
        clearTimeout(timeout)
        ws.removeAllListeners('message')
        resolve(ws)
      }
    })
    ws.on('error', (err) => {
      clearTimeout(timeout)
      reject(err)
    })
  })
}

/** Send one terminal.create; resolve with the `terminal.created` terminalId
 *  (reject on an explicit error frame / timeout). The terminal is NEVER
 *  attached: a never-referenced terminal starts orphan reap-eligible on
 *  the Rust server (which stamps `released_by_client: true` at create,
 *  `crates/freshell-terminal/src/registry.rs`). */
function createDetachedTerminal(ws: WebSocket, requestId: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.removeListener('message', onMessage)
      reject(new Error(`Timed out waiting for terminal.created (${requestId})`))
    }, 15_000)
    function onMessage(raw: WebSocket.RawData) {
      const message = JSON.parse(String(raw))
      if (message?.type === 'terminal.created' && message.requestId === requestId) {
        clearTimeout(timeout)
        ws.removeListener('message', onMessage)
        resolve(message.terminalId as string)
      }
      if (message?.type === 'error' && message.requestId === requestId) {
        clearTimeout(timeout)
        ws.removeListener('message', onMessage)
        reject(new Error(`terminal.create rejected: ${message.code} ${message.message}`))
      }
    }
    ws.on('message', onMessage)
    ws.send(JSON.stringify({ type: 'terminal.create', requestId, mode: 'shell', shell: 'system' }))
  })
}

/** Live-terminal inventory from `GET /api/terminals` (a plain array on both
 *  servers), as `{ terminalId → status }`. */
async function terminalRecords(
  info: E2eServerInfo,
): Promise<Map<string, { status?: string; lastLine?: string }>> {
  const res = await fetch(`${info.baseUrl}/api/terminals`, { headers: clockHeaders(info) })
  expect(res.status, 'GET /api/terminals').toBe(200)
  const items = (await res.json()) as Array<{ terminalId: string; status?: string; lastLine?: string }>
  return new Map(items.map((t) => [t.terminalId, { status: t.status, lastLine: t.lastLine }]))
}

function lastLineOf(
  records: Map<string, { status?: string; lastLine?: string }>,
  terminalId: string,
): string {
  const rec = records.get(terminalId)
  return rec?.lastLine ?? ''
}

/**
 * Wait until the newly spawned shell has printed something AND stopped
 * printing (its `lastLine` stable across a real 600ms window). Creating the
 * fixture BEFORE the clock is frozen would leave the spawn output capable
 * of landing after an advance — refreshing the activity stamp at the
 * ADVANCED virtual instant (fresh output at a virtual time genuinely is
 * activity and defeating the idle math. A shell sitting
 * at a prompt with no input is truly silent, so post-freeze nothing
 * re-stamps and virtual age is exact.
 */
async function waitForShellQuiet(info: E2eServerInfo, terminalId: string): Promise<void> {
  await expect
    .poll(async () => lastLineOf(await terminalRecords(info), terminalId).length > 0, {
      timeout: 15_000,
    })
    .toBe(true)
  await expect
    .poll(
      async () => {
        const a = lastLineOf(await terminalRecords(info), terminalId)
        await new Promise((r) => setTimeout(r, 600))
        const b = lastLineOf(await terminalRecords(info), terminalId)
        return a === b
      },
      { timeout: 15_000 },
    )
    .toBe(true)
}

/** Live-terminal inventory from `GET /api/terminals` (a plain array on both
 *  servers), as `{ terminalId → status }`. */
async function terminalStatuses(info: E2eServerInfo): Promise<Map<string, string>> {
  const res = await fetch(`${info.baseUrl}/api/terminals`, { headers: clockHeaders(info) })
  expect(res.status, 'GET /api/terminals').toBe(200)
  const items = (await res.json()) as Array<{ terminalId: string; status?: string }>
  return new Map(items.map((t) => [t.terminalId, t.status ?? 'running']))
}

async function patchIdleMinutes(info: E2eServerInfo, minutes: number): Promise<void> {
  const res = await fetch(`${info.baseUrl}/api/settings`, {
    method: 'PATCH',
    headers: clockHeaders(info),
    body: JSON.stringify({ safety: { autoKillIdleMinutes: minutes } }),
  })
  expect(res.status, 'PATCH /api/settings').toBe(200)
}

test.describe('HARNESS-14 controllable server clock', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(180_000)

  /** Boot an owned Rust server with the clock gate on. */
  async function startGatedServer(): Promise<E2eServerHandle> {
    const server = await createE2eServerHandle(process.env, {
      construct: { env: { FRESHELL_TEST_CLOCK: '1' } },
    })
    await server.start()
    return server
  }

  test('advance/freeze/resume/reset round-trip + validation + auth', async () => {
    const server = await startGatedServer()
    try {
      const info = server.info

      // Auth first (same x-auth-token gate as every /api route).
      const unauth = await fetch(`${info.baseUrl}/api/test-clock`)
      expect(unauth.status, 'no token must 401').toBe(401)

      // Initial state: enabled, live, zero offset, near wall clock.
      const s0 = await clockGet(info)
      expect(s0.enabled).toBe(true)
      expect(s0.mode).toBe('live')
      expect(s0.offsetMs).toBe(0)
      expect(Math.abs(s0.nowMs - Date.now())).toBeLessThan(5_000)

      // Advance (live): offset moves by exactly the delta.
      const advanced = await clockPost(info, 'advance', { ms: 90_000 })
      expect(advanced.offsetMs).toBe(90_000)
      expect(advanced.nowMs - s0.nowMs).toBeGreaterThanOrEqual(90_000)
      expect(advanced.nowMs - s0.nowMs).toBeLessThan(95_000)

      // Freeze: time stops dead across real elapsed time.
      const frozen = await clockPost(info, 'freeze')
      expect(frozen.mode).toBe('frozen')
      const held = frozen.nowMs
      await new Promise((r) => setTimeout(r, 300)) // real time passes...
      const still = await clockGet(info)
      expect(still.nowMs, 'frozen nowMs must not move on real time').toBe(held)

      // Advance while frozen: steps the held value exactly.
      const stepped = await clockPost(info, 'advance', { ms: 42_000 })
      expect(stepped.nowMs).toBe(held + 42_000)
      expect(stepped.mode).toBe('frozen')

      // Resume: live again, continuing FROM the held value (no jump).
      const resumed = await clockPost(info, 'resume')
      expect(resumed.mode).toBe('live')
      expect(Math.abs(resumed.nowMs - (held + 42_000))).toBeLessThan(1_000)
      await new Promise((r) => setTimeout(r, 300))
      const afterResume = await clockGet(info)
      expect(afterResume.nowMs).toBeGreaterThan(resumed.nowMs)

      // Reset: pure wall clock again.
      const resetted = await clockPost(info, 'reset')
      expect(resetted.mode).toBe('live')
      expect(resetted.offsetMs).toBe(0)
      expect(Math.abs(resetted.nowMs - Date.now())).toBeLessThan(5_000)

      // Validation: every invalid advance shape → 400 invalid_advance.
      for (const bad of [{ ms: -1 }, { ms: 1.5 }, { ms: '60000' }, {}, { ms: 1e12 }]) {
        const res = await fetch(`${info.baseUrl}/api/test-clock/advance`, {
          method: 'POST',
          headers: clockHeaders(info),
          body: JSON.stringify(bad),
        })
        expect(res.status, JSON.stringify(bad)).toBe(400)
        const body = (await res.json()) as { ok: boolean; error: string }
        expect(body.error).toBe('invalid_advance')
      }
      await clockPost(info, 'reset')
    } finally {
      await server.stop().catch(() => {})
    }
  })

  test('fixture timers fire in deterministic virtual order (idle cleanup, zero wall sleeps)', async () => {
    const server = await startGatedServer()
    try {
      const info = server.info

      // Deterministic threshold: 15 virtual minutes (the default), made
      // explicit so the spec never depends on shipped defaults.
      await patchIdleMinutes(info, 15)

      const ws = await connectAndHello(info.wsUrl, info.token)
      let termA = ''
      let termB = ''
      let termC = ''
      try {
        // Create A on the LIVE clock, then wait for its spawn output to
        // settle (see waitForShellQuiet: output landing after an advance
        // would be real activity at that virtual instant).
        termA = await createDetachedTerminal(ws, `clock-a-${Date.now()}`)
        await waitForShellQuiet(info, termA)

        // Now freeze. Step +5min: create B — its spawn stamps land EXACTLY
        // on the frozen T0+5m instant (deterministic fixture age).
        await clockPost(info, 'freeze')
        await clockPost(info, 'advance', { ms: 5 * 60_000 })
        termB = await createDetachedTerminal(ws, `clock-b-${Date.now()}`)
        await waitForShellQuiet(info, termB)

        // Step +11min → A idle 16min ≥ 15 (reap), B idle 11min < 15 (keep).
        // The gated 250ms sweep makes this land in ~1 REAL second.
        await clockPost(info, 'advance', { ms: 11 * 60_000 })
        await expect
          .poll(async () => {
            const statuses = await terminalStatuses(info)
            const a = statuses.get(termA)
            const b = statuses.get(termB)
            return {
              aGone: a === undefined || a === 'exited',
              bAlive: b === 'running',
            }
          }, { timeout: 15_000 })
          .toEqual({ aGone: true, bAlive: true })

        // Frozen means frozen: REAL sweeps ticking with no virtual motion
        // must never age B (≈3s real ≈ 12 gated sweeps).
        await new Promise((r) => setTimeout(r, 3_000))
        const mid = await terminalStatuses(info)
        expect(mid.get(termB), 'B cannot age while the clock is frozen').toBe('running')

        // B created now (at the frozen instant), then one
        // more +2min step: B idle 13min... create C first, then confirm
        // order again on the C/B boundary.
        termC = await createDetachedTerminal(ws, `clock-c-${Date.now()}`)
        await waitForShellQuiet(info, termC)
        await clockPost(info, 'advance', { ms: 2 * 60_000 }) // B 13min, C 0min
        let statuses = await terminalStatuses(info)
        expect(statuses.get(termB)).toBe('running')
        expect(statuses.get(termC)).toBe('running')

        // +3min: B hits 16min (reap), C at 3min (keep) — order: B before C.
        await clockPost(info, 'advance', { ms: 3 * 60_000 })
        await expect
          .poll(async () => {
            const s = await terminalStatuses(info)
            const b = s.get(termB)
            const c = s.get(termC)
            return { bGone: b === undefined || b === 'exited', cAlive: c === 'running' }
          }, { timeout: 15_000 })
          .toEqual({ bGone: true, cAlive: true })

        // +13min: C hits 16min → reaps too.
        await clockPost(info, 'advance', { ms: 13 * 60_000 })
        await expect
          .poll(async () => {
            const s = await terminalStatuses(info)
            const c = s.get(termC)
            return c === undefined || c === 'exited'
          }, { timeout: 15_000 })
          .toBe(true)

        // Virtual total crossed: 34 minutes. Real elapsed: seconds.
      } finally {
        ws.close()
        if (termA) await clockPost(info, 'reset') // leave the gated server clean
      }
    } finally {
      await server.stop().catch(() => {})
    }
  })

  test('the control surface is absent in a normal build (ungated fixture)', async ({ serverInfo }) => {
    // The worker-scoped default fixture boots WITHOUT FRESHELL_TEST_CLOCK on
    // verb must answer the catch-all's indistinguishable 404.
    expect(typeof serverInfo.token).toBe('string')
    for (const [method, path] of [
      ['GET', '/api/test-clock'],
      ['POST', '/api/test-clock/advance'],
      ['POST', '/api/test-clock/freeze'],
      ['POST', '/api/test-clock/resume'],
      ['POST', '/api/test-clock/reset'],
    ] as const) {
      const res = await fetch(`${serverInfo.baseUrl}${path}`, {
        method,
        headers: clockHeaders(serverInfo),
        body: method === 'POST' && path.endsWith('advance') ? JSON.stringify({ ms: 1000 }) : undefined,
      })
      expect(res.status, `${method} ${path}`).toBe(404)
    }
    // Sanity: the normal build is otherwise fully serving.
    const health = await fetch(`${serverInfo.baseUrl}/api/health`)
    expect(health.status).toBe(200)
  })
})
