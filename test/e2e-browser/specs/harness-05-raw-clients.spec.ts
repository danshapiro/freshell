/**
 * HARNESS-05 — probe spec for the raw HTTP/WebSocket Playwright clients
 * per-server code paths (hello handling, protocol-error enforcement,
 *
 * Full item text: "Add raw HTTP and WebSocket clients to the Playwright
 * runner. Tests need to send malformed frames, delay reads/hello, create
 * slow consumers, inspect frames/close codes, and call orchestration
 * routes."
 *
 * Acceptance ("Playwright validation"): "Exercise the helper against a
 * deterministic echo/error fixture: delayed receive truly stops socket
 * draining, sent/received bytes and close codes are recorded, abort works,
 * and a second normal socket stays usable. Rust protocol semantics are
 * tested later." — Group A maps one-to-one onto this sentence via the
 * deterministic `EchoWsFixture` (`echo-ws-fixture.ts`); Group B then proves
 * the same capabilities against whichever real server the running project
 * boots, asserting only cross-server INVARIANTS (termination, exact
 * documented pong shape, HTTP statuses) and RECORDING per-leg observations
 * (close codes, terminal-event kinds, reject statuses) for the evidence
 * file. Deeper per-server protocol semantics belong to SAFE-01/03/05,
 * TERM-19, AUTO-12, etc., which consume this helper.
 *
 * The spec never requests the `page` fixture: no browser is launched.
 */
import { test, expect } from '../helpers/fixtures.js'
import { EchoWsFixture } from '../helpers/echo-ws-fixture.js'
import { RawWsClient, WS_OPCODE, rawHttpRequest } from '../helpers/raw-clients.js'
import { externalTargetConfigured, resolveExternalTarget } from '../helpers/external-target.js'

/**
 * Round-4 review: the raw clients are loopback `ws://`/`http://`-only by
 * design — TLS needs a trusted test-certificate fixture, which is
 * HARNESS-06's deliverable ("Include ... trusted HTTPS"), not this item's.
 * When the suite is pointed at a SECURE external target
 * (`FRESHELL_E2E_TARGET_URL=https://...` ⇒ derived `wss://`), Group B would
 * otherwise fail on the protocol guard before exercising anything, so it
 * skips with an explicit, recorded reason. Group A is target-independent
 * (it owns its fixture server) and always runs.
 */
const SECURE_EXTERNAL_TARGET = (() => {
  if (!externalTargetConfigured(process.env)) return false
  try {
    const target = resolveExternalTarget(process.env)
    return target.wsUrl.startsWith('wss:') || target.baseUrl.startsWith('https:')
  } catch {
    return false
  }
})()
const SECURE_EXTERNAL_SKIP_REASON =
  'HARNESS-05 raw clients are loopback ws://http:// only; TLS targets await HARNESS-06 (trusted HTTPS fixture)'

/** Structured per-leg evidence line, harvested from Playwright output into
 *  docs/plans/df1-evidence/HARNESS-05.md. */
function recordLeg(projectName: string, leg: string, observations: Record<string, unknown>): void {
  console.log(`HARNESS-05-LEG project=${projectName} leg=${leg} ${JSON.stringify(observations)}`)
}

test.describe.serial('Group A: raw-client acceptance vs deterministic echo/error fixture', () => {
  let fixture: EchoWsFixture
  const clients: RawWsClient[] = []

  async function connect(options?: Parameters<typeof RawWsClient.connect>[1]): Promise<RawWsClient> {
    const client = await RawWsClient.connect(fixture.wsUrl, options)
    clients.push(client)
    return client
  }

  test.beforeAll(async () => {
    fixture = await EchoWsFixture.start()
  })

  test.afterAll(async () => {
    while (clients.length) await clients.pop()!.dispose()
    await fixture.stop()
  })

  test('A1: echo roundtrip records sent/received frames and wire bytes exactly', async ({}, testInfo) => {
    const client = await connect()
    client.sendText('harness-05-echo') // 15-byte payload
    const echo = await client.waitForFrame((f) => f.opcode === WS_OPCODE.TEXT, 5000, 'echo')

    expect(RawWsClient.text(echo)).toBe('harness-05-echo')
    const sent = client.sentFrames.at(-1)!
    expect(sent.wireBytes).toBe(2 + 4 + 15) // masked client frame
    expect(sent.masked).toBe(true)
    expect(echo.wireBytes).toBe(2 + 15) // unmasked server frame
    expect(echo.masked).toBe(false)
    expect(client.bytesSent).toBeGreaterThanOrEqual(sent.wireBytes)
    expect(client.bytesReceived).toBeGreaterThanOrEqual(echo.wireBytes)
    recordLeg(testInfo.project.name, 'A1', {
      sentWireBytes: sent.wireBytes, receivedWireBytes: echo.wireBytes,
      bytesSent: client.bytesSent, bytesReceived: client.bytesReceived,
    })
  })

  test('A2: delayed receive truly stops socket draining; resume is lossless', async ({}, testInfo) => {
    const client = await connect()
    client.pauseReads()
    client.sendText('flood:150:1024')

    const during = await client.collectFramesDuring(900)
    expect(during).toEqual([])
    const frozen = client.bytesReceived
    await new Promise((r) => setTimeout(r, 250))
    expect(client.bytesReceived).toBe(frozen)

    client.resumeReads()
    await client.waitForFrame(() => client.receivedFrames.length === 150, 10_000, 'flood after resume')
    const seqs = client.receivedFrames.map((f) => Number(RawWsClient.text(f).split(':')[1]))
    expect(seqs).toEqual(Array.from({ length: 150 }, (_, i) => i))
    recordLeg(testInfo.project.name, 'A2', { pausedFrames: 0, framesAfterResume: seqs.length, ordered: true })
  })

  test('A3: malformed frames (rsv1, then unmasked) are recorded with the fixture close code', async ({}, testInfo) => {
    const a = await connect()
    a.sendFrame({ rsv1: true, opcode: WS_OPCODE.TEXT, payload: 'x' })
    expect(await a.waitForTerminalEvent(5000)).toBe('peer-close')
    expect(a.peerClose!.code).toBe(1002)

    const b = await connect()
    b.sendFrame({ mask: false, opcode: WS_OPCODE.TEXT, payload: 'x' })
    expect(await b.waitForTerminalEvent(5000)).toBe('peer-close')
    expect(b.peerClose!.code).toBe(1002)
    recordLeg(testInfo.project.name, 'A3', { rsv1CloseCode: a.peerClose!.code, unmaskedCloseCode: b.peerClose!.code })
  })

  test('A4: peer close code/reason (4000, "fixture-bye") is recorded exactly', async ({}, testInfo) => {
    const client = await connect()
    client.sendText('close:4000:fixture-bye')
    await client.waitForTerminalEvent(5000)
    expect(client.peerClose).toMatchObject({ code: 4000, reason: 'fixture-bye' })
    recordLeg(testInfo.project.name, 'A4', { code: client.peerClose!.code, reason: client.peerClose!.reason })
  })

  test('A5: abort works — socket destroyed, zero post-abort frames, fixture sees the close', async ({}, testInfo) => {
    const client = await connect()
    client.sendText('flood:60:256')
    client.abort()
    await expect.poll(() => client.destroyed, { timeout: 5000 }).toBe(true)
    const atAbort = client.receivedFrames.length
    await new Promise((r) => setTimeout(r, 400))
    expect(client.receivedFrames.length).toBe(atAbort)
    const connIndex = fixture.connections.length - 1
    await expect.poll(() => fixture.connections[connIndex]?.closedAt, { timeout: 5000 }).not.toBeNull()
    recordLeg(testInfo.project.name, 'A5', { aborted: true, framesAtAbort: atAbort, postAbortFrames: 0 })
  })

  test('A6: a second normal socket stays usable after the first was sabotaged', async ({}, testInfo) => {
    const a = await connect()
    a.sendFrame({ rsv1: true, opcode: WS_OPCODE.TEXT, payload: 'x' })
    await a.waitForTerminalEvent(5000)
    expect(a.peerClose!.code).toBe(1002)

    const b = await connect()
    b.sendText('second-socket-ok')
    const echo = await b.waitForFrame((f) => f.opcode === WS_OPCODE.TEXT, 5000, 'second socket echo')
    expect(RawWsClient.text(echo)).toBe('second-socket-ok')
    recordLeg(testInfo.project.name, 'A6', { sabotagedCloseCode: a.peerClose!.code, secondSocketUsable: true })
  })
})

test.describe.serial('Group B: raw-client capability legs against the real server', () => {
  test.skip(SECURE_EXTERNAL_TARGET, SECURE_EXTERNAL_SKIP_REASON)

  const clients: RawWsClient[] = []

  async function connect(wsUrl: string): Promise<RawWsClient> {
    const client = await RawWsClient.connect(wsUrl)
    clients.push(client)
    return client
  }

  test.afterEach(async () => {
    while (clients.length) await clients.pop()!.dispose()
  })

  test('B1: delayed hello — 1200ms of silence, then hello still reaches ready', async ({ serverInfo }, testInfo) => {
    const client = await connect(serverInfo.wsUrl)
    // Both servers send nothing and never close before the ~5s hello
    // freshell-server hello_timeout_ms default 5000) — a 1200ms delay must
    // be a healthy, silent, still-connected window.
    const silentFrames = await client.collectFramesDuring(1200)
    expect(silentFrames).toEqual([])
    expect(client.peerClose).toBeNull()
    expect(client.destroyed).toBe(false)

    client.hello(serverInfo.token)
    const ready = await client.nextJsonMessage('ready', 5000)
    expect(ready.type).toBe('ready')
    recordLeg(testInfo.project.name, 'B1', { silentMs: 1200, framesDuringDelay: 0, readyAfterDelayedHello: true })
  })

  test('B2: malformed frame on an authenticated socket terminates it; a second normal socket stays usable', async ({ serverInfo }, testInfo) => {
    const bad = await connect(serverInfo.wsUrl)
    bad.hello(serverInfo.token)
    await bad.nextJsonMessage('ready', 5000)

    bad.sendFrame({ rsv1: true, opcode: WS_OPCODE.TEXT, payload: 'x' })
    const terminal = await bad.waitForTerminalEvent(5000)
    expect(['peer-close', 'tcp-end']).toContain(terminal)
    if (bad.peerClose) {
      // RFC 6455 protocol violation; both stacks (ws / tokio-tungstenite)
      // RFC-fail with 1002. Recorded per leg either way.
      expect(bad.peerClose.code).toBe(1002)
    }

    const good = await connect(serverInfo.wsUrl)
    good.hello(serverInfo.token)
    const ready = await good.nextJsonMessage('ready', 5000)
    expect(ready.type).toBe('ready')
    recordLeg(testInfo.project.name, 'B2', {
      terminal,
      closeCode: bad.peerClose?.code ?? null,
      closeReason: bad.peerClose?.reason ?? null,
      secondSocketUsable: true,
    })
  })

  test('B3: slow consumer — pausing reads truly stops draining; ping/pong resumes intact', async ({ serverInfo }, testInfo) => {
    const client = await connect(serverInfo.wsUrl)
    client.hello(serverInfo.token)
    await client.nextJsonMessage('ready', 5000)

    client.pauseReads()
    client.sendJson({ type: 'ping' })
    const during = await client.collectFramesDuring(800)
    expect(during).toEqual([])

    client.resumeReads()
    const pong = await client.nextJsonMessage<{ type: string; timestamp: string }>('pong', 5000)
    // SAFE-05's exact correlated shape, byte-parity between the servers
    // (rooted here because the pong flows through the SLOW-CONSUMER path).
    expect(Object.keys(pong).sort()).toEqual(['timestamp', 'type'])
    expect(pong.type).toBe('pong')
    expect(pong.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    recordLeg(testInfo.project.name, 'B3', { framesWhilePaused: 0, pongReceived: true })
  })

  test('B4: orchestration routes via the raw HTTP client', async ({ serverInfo }, testInfo) => {
    const health = await rawHttpRequest(serverInfo.baseUrl, { path: '/api/health' })
    expect(health.status).toBe(200)
    expect((health.json() as { ok?: boolean }).ok).toBe(true)
    expect(health.bytesSent).toBeGreaterThan(0)
    expect(health.bytesReceived).toBeGreaterThan(0)

    const tabName = `harness-05-${Date.now()}`
    let tabId: string | undefined
    let deleteStatus: number | null = null
    let createdStatus: number | null = null
    let noTokenStatus: number | null = null
    try {
      const created = await rawHttpRequest(serverInfo.baseUrl, {
        method: 'POST',
        path: '/api/tabs',
        headers: { 'x-auth-token': serverInfo.token, 'content-type': 'application/json' },
        body: JSON.stringify({ name: tabName, browser: 'https://example.com' }),
      })
      createdStatus = created.status
      expect(created.status).toBe(200)
      const createdBody = created.json() as { status?: string; data?: { tabId?: string } }
      expect(createdBody.status).toBe('ok')
      tabId = createdBody.data?.tabId
      expect(typeof tabId).toBe('string')

      const list = await rawHttpRequest(serverInfo.baseUrl, {
        path: '/api/tabs',
        headers: { 'x-auth-token': serverInfo.token },
      })
      expect(list.status).toBe(200)
      expect(list.body.toString('utf8')).toContain(tabId!)

      const rejected = await rawHttpRequest(serverInfo.baseUrl, {
        method: 'POST',
        path: '/api/tabs',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'should-be-rejected' }),
      })
      noTokenStatus = rejected.status
      expect([401, 403]).toContain(rejected.status)
    } finally {
      // R5 (review round 1): the testServer fixture is worker-scoped and a
      // browser tab persists in its layout store until deleted; a retry of
      // this test must not inherit the previous attempt's tab. Both servers
      // expose DELETE /api/tabs/:id. Cleanup is best-effort so it never
      // masks an assertion failure in the try block.
      if (tabId) {
        const deleted = await rawHttpRequest(serverInfo.baseUrl, {
          method: 'DELETE',
          path: `/api/tabs/${tabId}`,
          headers: { 'x-auth-token': serverInfo.token },
        }).catch(() => null)
        deleteStatus = deleted?.status ?? null
        if (deleted) {
          const remaining = await rawHttpRequest(serverInfo.baseUrl, {
            path: '/api/tabs',
            headers: { 'x-auth-token': serverInfo.token },
          }).catch(() => null)
          expect(remaining?.body.toString('utf8') ?? '').not.toContain(tabId)
        }
      }
    }

    recordLeg(testInfo.project.name, 'B4', {
      healthStatus: health.status,
      createStatus: createdStatus,
      tabId,
      listContainsTab: true,
      noTokenStatus,
      healthBytesSent: health.bytesSent,
      healthBytesReceived: health.bytesReceived,
      deleteStatus,
    })
  })
})
