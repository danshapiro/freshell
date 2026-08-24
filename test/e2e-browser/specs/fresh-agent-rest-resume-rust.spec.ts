// TASK 6 (the-usual/freshagent-sessionref-regression) — RED-FIRST acceptance
// specs for the two adopted katas:
//
//   Kata 1 (journeys a + b + loud-failure legs): fresh-agent resume support on
//   the Rust REST `create_tab` path (`POST /api/tabs` with
//   `{agent:'opencode', sessionRef:{provider:'opencode', sessionId}}`).
//   - (a) DURABLE-id resume: create → send turn → materialize → read the
//     durable `ses_…` from the audit log → restartAbrupt → resume POST → 200
//     with the durable sessionId + the prior transcript.
//   - (b) PLACEHOLDER-resolution resume: DEFAULT-body create mints the
//     placeholder `freshopencode-<createRequestId>`; after a turn
//     materializes the durable id, a resume POST keyed on the PLACEHOLDER
//     must resolve through the pane-identity ledger and answer the SAME
//     durable id (no seeded fixtures — the binding is written by the natural
//     create→send flow).
//   - Resume failures are LOUD (status codes only in Phase A): provider
//     mismatch → 400, malformed sessionRef → 400, unknown durable → 404,
//     unresolvable placeholder → 404. No silent placeholder substitution.
//
//   Kata 2 (journey c): the persist/tabs.sync pipeline must never regress a
//   materialized sessionRef back to a placeholder. Client-B pushes a
//   fresh-agent pane payload whose sessionRef is a placeholder while a LIVE
//   registry snapshot (client-A, same tabKey+paneId+provider+createRequestId)
//   holds the durable ref → the registry winner keeps the DURABLE sessionRef.
//   A push with a NEW createRequestId (deliberate reset/fork) is explicitly
//   EXEMPT and must pass through unclamped.
//
// RED STATE AT AUTHORING: every journey above FAILS against the unchanged
// implementation — the REST fresh-agent `create_tab` currently ignores
// `sessionRef` entirely (always minting a fresh placeholder), and the tabs
// registry applies no placeholder clamp (the later placeholder push wins the
// per-tabKey merge). Phase B must turn THESE SAME tests green UNMODIFIED.
//
// Harness notes (per this suite's per-spec-ownership convention, helpers are
// copied, not imported):
//   - RustServer boot / `restartAbrupt` / audit-log `readJsonl` /
//     `seedWallConfig` modeled on freshagent-settings-resume-rust.spec.ts
//     (:333-451, the opencode REST-seed + WS-resume donor).
//   - The send→materialize→settle→audit-verify helper PATTERN is borrowed
//     from fresh-agent-control-rust.spec.ts:1674 (`sendOpencodeTurn`),
//     adapted to REST (send-keys blocks to idle; transcript is verified via
//     GET /api/panes/:id/capture instead of the in-browser pane text).
//   - Journeys drive the server directly (REST + raw WS, no browser page),
//     exactly like tests 1-3 of the settings-resume donor.
//   - Journey (c) lives HERE (not sidebar-registry-sync-rust.spec.ts, which
//     boots NO raw-WS clients): the two-WS-client `tabs.sync.push`/
//     `tabs.sync.query` harness is modeled on
//     tabs-registry-persistence-rust.spec.ts.
//
// Rust-only: registered in RUST_ONLY_SPECS + rust-chromium testMatch
// (restartAbrupt exists only on RustServer).
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import { test, expect } from '../helpers/fixtures.js'
import { RustServer } from '../helpers/rust-server.js'
import type { TestServerInfo } from '../helpers/test-server.js'
import { WS_PROTOCOL_VERSION } from '../../../shared/ws-protocol.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const OPENCODE_FIXTURE = path.resolve(__dirname, '../fixtures/fake-opencode.cjs')

// ---------------------------------------------------------------------------
// Copied helpers (donor: freshagent-settings-resume-rust.spec.ts / agent-continuity-matrix.spec.ts)
// ---------------------------------------------------------------------------

/** Parse a JSONL file, tolerating absence (returns []). */
function readJsonl(filePath: string): any[] {
  if (!fs.existsSync(filePath)) return []
  return fs
    .readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
}

/** Idempotent .freshell/config.json seed (setupHome re-runs on every boot).
 * (donor: freshagent-settings-resume-rust.spec.ts :76-98) */
function seedWallConfig(input: {
  providers: string[]
  freshAgent?: boolean
}): (homeDir: string) => Promise<void> {
  return async (homeDir: string) => {
    const freshellDir = path.join(homeDir, '.freshell')
    await fsp.mkdir(freshellDir, { recursive: true })
    await fsp.writeFile(
      path.join(freshellDir, 'config.json'),
      JSON.stringify(
        {
          version: 1,
          settings: {
            codingCli: { enabledProviders: input.providers },
            ...(input.freshAgent ? { freshAgent: { enabled: true } } : {}),
          },
        },
        null,
        2,
      ),
    )
  }
}

/**
 * Successful REST responses on this surface are enveloped as
 * `{status:'ok', data:{…}, message}` (Rust `ok_json`). Unwrap `data` —
 * falling back to the bare body for resilience.
 * (donor: agent-continuity-matrix.spec.ts :46-48)
 */
function unwrapData(body: any): any {
  return body && typeof body === 'object' && 'data' in body ? body.data : body
}

/**
 * Boot an owned RustServer with the fake opencode installed (executable named
 * `opencode`, PATH + OPENCODE_CMD + the audit-log env) and the fresh-agent /
 * provider config seeded across restarts.
 * (boot/env idiom donor: freshagent-settings-resume-rust.spec.ts :336-357)
 */
async function bootOpencodeServer(): Promise<{
  server: RustServer
  info: TestServerInfo
  sharedRoot: string
  projectDir: string
  auditLogPath: string
}> {
  const sharedRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'fa-rest-resume-'))
  const binDir = path.join(sharedRoot, 'bin')
  const auditLogPath = path.join(sharedRoot, 'opencode-audit.jsonl')
  const projectDir = path.join(sharedRoot, 'proj')
  await fsp.mkdir(projectDir, { recursive: true })
  await fsp.mkdir(binDir, { recursive: true })
  const fakeOpencode = path.join(binDir, 'opencode')
  await fsp.copyFile(OPENCODE_FIXTURE, fakeOpencode)
  await fsp.chmod(fakeOpencode, 0o755)
  const server = new RustServer({
    env: {
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
      OPENCODE_CMD: fakeOpencode,
      FAKE_OPENCODE_AUDIT_LOG: auditLogPath,
    },
    setupHome: seedWallConfig({ providers: ['opencode'], freshAgent: true }),
  })
  try {
    const info = await server.start()
    return { server, info, sharedRoot, projectDir, auditLogPath }
  } catch (error) {
    await server.stop().catch(() => {})
    await fsp.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

function authed(info: TestServerInfo): Record<string, string> {
  return { 'content-type': 'application/json', 'x-auth-token': info.token }
}

/** POST /api/tabs (fresh-agent agent:opencode lane) with an arbitrary body. */
async function postCreateTab(info: TestServerInfo, body: Record<string, unknown>) {
  const res = await fetch(`${info.baseUrl}/api/tabs`, {
    method: 'POST',
    headers: authed(info),
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let parsed: any = null
  try {
    parsed = JSON.parse(text)
  } catch {
    // non-JSON error body — the status assertion carries the failure
  }
  return { status: res.status, ok: res.ok, body: parsed, text }
}

/**
 * Drive one turn through a pane (REST send-keys; the REST handler blocks on
 * the idle edge), then confirm the turn landed by polling the fake's audit
 * log for its `prompt_async` entry — the REST adaptation of the
 * `sendOpencodeTurn` pattern (fresh-agent-control-rust.spec.ts:1674).
 * Returns the durable `ses_…` id recorded by the audit log.
 */
async function sendOpencodeTurnRest(
  info: TestServerInfo,
  paneId: string,
  text: string,
  auditLogPath: string,
): Promise<string> {
  const res = await fetch(`${info.baseUrl}/api/panes/${encodeURIComponent(paneId)}/send-keys`, {
    method: 'POST',
    headers: authed(info),
    body: JSON.stringify({ data: text }),
  })
  const sendText = await res.text()
  expect(res.ok, `send-keys must succeed: ${res.status} ${sendText}`).toBe(true)

  await expect
    .poll(
      () =>
        readJsonl(auditLogPath).find((e) => e.event === 'prompt_async' && e.prompt === text)
          ?.sessionId ?? null,
      { timeout: 30_000 },
    )
    .toMatch(/^ses_/)
  return readJsonl(auditLogPath).find((e) => e.event === 'prompt_async' && e.prompt === text)!
    .sessionId as string
}

/** GET /api/panes/:id/capture → the rendered text/plain transcript. */
async function capturePane(info: TestServerInfo, paneId: string): Promise<{ status: number; text: string }> {
  const res = await fetch(`${info.baseUrl}/api/panes/${encodeURIComponent(paneId)}/capture`, {
    headers: authed(info),
  })
  return { status: res.status, text: await res.text() }
}

// ---------------------------------------------------------------------------
// Raw-WS helpers for the registry clamp journey
// (copied verbatim from tabs-registry-persistence-rust.spec.ts :60-109)
// ---------------------------------------------------------------------------

/** Open a raw WS connection and complete the harness-token `hello` handshake. */
function connectAndHello(wsUrl: string, token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    const timeout = setTimeout(() => {
      ws.removeAllListeners()
      ws.terminate()
      reject(new Error('Timed out waiting for ready after hello'))
    }, 10_000)

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

/** Resolve with the next message matching `predicate`, or reject on timeout. */
function nextMessage(ws: WebSocket, predicate: (message: unknown) => boolean, timeoutMs = 5_000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.removeListener('message', onMessage)
      reject(new Error('Timed out waiting for matching WS message'))
    }, timeoutMs)

    function onMessage(raw: WebSocket.RawData) {
      const message = JSON.parse(String(raw))
      if (predicate(message)) {
        clearTimeout(timeout)
        ws.removeListener('message', onMessage)
        resolve(message)
      }
    }

    ws.on('message', onMessage)
  })
}

interface ClientIdentity {
  deviceId: string
  deviceLabel: string
  clientInstanceId: string
}

/** Send `tabs.sync.push` and resolve with the server's reply — either the
 *  `tabs.sync.ack` or the `error` frame (the only two possible responses).
 *  (donor: tabs-registry-persistence-rust.spec.ts :154-170) */
async function pushTabs(
  ws: WebSocket,
  identity: ClientIdentity,
  snapshotRevision: number,
  records: any[],
): Promise<any> {
  const reply = nextMessage(ws, (m: any) => m?.type === 'tabs.sync.ack' || m?.type === 'error')
  ws.send(JSON.stringify({
    type: 'tabs.sync.push',
    deviceId: identity.deviceId,
    deviceLabel: identity.deviceLabel,
    clientInstanceId: identity.clientInstanceId,
    snapshotRevision,
    records,
  }))
  return reply
}

let queryCounter = 0

/** Send `tabs.sync.query` and resolve with the matching `tabs.sync.snapshot`'s
 *  `data` (requestId-correlated, so no other frame can satisfy the wait).
 *  (donor: tabs-registry-persistence-rust.spec.ts :176-188) */
async function queryTabs(ws: WebSocket, identity: ClientIdentity): Promise<any> {
  queryCounter += 1
  const requestId = `task6-registry-query-${queryCounter}`
  const reply = nextMessage(ws, (m: any) => m?.type === 'tabs.sync.snapshot' && m?.requestId === requestId)
  ws.send(JSON.stringify({
    type: 'tabs.sync.query',
    requestId,
    deviceId: identity.deviceId,
    clientInstanceId: identity.clientInstanceId,
    closedTabRetentionDays: 30,
  }))
  return (await reply).data
}

/** Assert an ack frame's exact wire shape (`TabsSyncAck`, camelCase).
 *  (donor: tabs-registry-persistence-rust.spec.ts :191-198) */
function expectAck(frame: any, expected: { openRecords: number; closedRecords: number }): void {
  expect(frame).toEqual({
    type: 'tabs.sync.ack',
    accepted: true,
    openRecords: expected.openRecords,
    closedRecords: expected.closedRecords,
  })
}

function safeClose(ws: WebSocket | undefined): void {
  try {
    ws?.close()
  } catch {
    // Already closed/dead — fine.
  }
}

/**
 * A registry-schema-complete OPEN record for one fresh-agent (opencode) tab —
 * the pane payload mirrors the real client's `stripPanePayload` fresh-agent
 * shape (src/lib/tab-registry-snapshot.ts:45-64): `createRequestId`,
 * `provider`, `sessionType`, `sessionRef`, `initialCwd`. Identity fields match
 * the push envelope so the server's stamping is a no-op.
 */
function freshAgentTabRecord(
  identity: ClientIdentity,
  input: {
    tabId: string
    paneId: string
    createRequestId: string
    sessionRefSessionId: string
    at: number
  },
): any {
  return {
    tabKey: `${identity.deviceId}:${input.tabId}`,
    tabId: input.tabId,
    tabName: `Task 6 tab ${input.tabId}`,
    deviceId: identity.deviceId,
    deviceLabel: identity.deviceLabel,
    clientInstanceId: identity.clientInstanceId,
    status: 'open',
    revision: 1,
    createdAt: input.at,
    updatedAt: input.at,
    titleSetByUser: true,
    paneCount: 1,
    panes: [{
      paneId: input.paneId,
      kind: 'fresh-agent',
      payload: {
        createRequestId: input.createRequestId,
        provider: 'opencode',
        sessionType: 'freshopencode',
        sessionRef: { provider: 'opencode', sessionId: input.sessionRefSessionId },
        initialCwd: '/tmp/task6-proj',
      },
    }],
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('REST fresh-agent resume + registry placeholder clamp (Task 6, rust)', () => {
  test.setTimeout(240_000)

  test('(a) durable-id resume: POST /api/tabs with a durable sessionRef restores the pane after restartAbrupt', async ({ e2eServerKind }) => {
    expect(e2eServerKind).toBe('rust')
    const lane = await bootOpencodeServer()
    try {
      const { info, auditLogPath, projectDir } = lane
      const PROMPT = 'task6-rest-resume durable-id first turn'

      const created = await postCreateTab(info, { agent: 'opencode', cwd: projectDir })
      expect(created.ok, `REST create must succeed: ${created.status} ${created.text}`).toBe(true)
      const paneId = unwrapData(created.body)?.paneId as string
      expect(paneId, 'REST create must return a paneId').toBeTruthy()

      // Materialize: first send mints the durable ses_* id (audit-log proof).
      const sesId = await sendOpencodeTurnRest(info, paneId, PROMPT, auditLogPath)

      // Pre-restart control: the transcript is already retrievable (the
      // comparator the post-restart capture must reproduce).
      const before = await capturePane(info, paneId)
      expect(before.status).toBe(200)
      expect(before.text).toContain(`Fake OpenCode response: ${PROMPT}`)

      // ── SIGKILL + reboot on the same home/port/token. The in-memory REST
      // panes map is gone; resume must rebuild from durable state (pane
      // ledger + serve store).
      await lane.server.restartAbrupt()

      const resumed = await postCreateTab(info, {
        agent: 'opencode',
        sessionRef: { provider: 'opencode', sessionId: sesId },
      })
      expect(resumed.status, `resume POST must succeed: ${resumed.status} ${resumed.text}`).toBe(200)
      const data = unwrapData(resumed.body)
      expect(data?.tabId, 'resume must return a tabId').toBeTruthy()
      expect(data?.paneId, 'resume must return a paneId').toBeTruthy()
      // THE CONTRACT: the resume answers the DURABLE id — never a
      // re-derived placeholder. (RED today: sessionRef is silently ignored
      // and this is a fresh `freshopencode-<uuid>`.)
      expect(data?.sessionId, 'resume must answer the durable ses_* id, not a placeholder').toBe(sesId)
      expect(data?.sessionRef).toEqual({ provider: 'opencode', sessionId: sesId })

      // Transcript restored: the new pane's capture shows the prior turn.
      const after = await capturePane(info, data.paneId)
      expect(after.status).toBe(200)
      expect(after.text, 'resumed pane must show the prior turn content').toContain(
        `Fake OpenCode response: ${PROMPT}`,
      )
    } finally {
      await lane.server.stop().catch(() => {})
      await fsp.rm(lane.sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })

  test('(b) placeholder-resolution resume: a placeholder-keyed sessionRef resolves to the materialized durable id after restartAbrupt', async ({ e2eServerKind }) => {
    expect(e2eServerKind).toBe('rust')
    const lane = await bootOpencodeServer()
    try {
      const { info, auditLogPath } = lane
      const PROMPT = 'task6-rest-resume placeholder-resolution first turn'

      // DEFAULT body (no model/effort/cwd): the create mints the placeholder
      // `freshopencode-<createRequestId>` as the pane's sessionId.
      const created = await postCreateTab(info, { agent: 'opencode' })
      expect(created.ok, `REST create must succeed: ${created.status} ${created.text}`).toBe(true)
      const createdData = unwrapData(created.body)
      const paneId = createdData?.paneId as string
      const placeholderId = createdData?.sessionId as string
      expect(paneId, 'REST create must return a paneId').toBeTruthy()
      expect(placeholderId, 'REST create must answer the pane placeholder sessionId').toMatch(
        /^freshopencode-/,
      )

      // Materialize via one turn; the durable id comes from the audit log.
      const sesId = await sendOpencodeTurnRest(info, paneId, PROMPT, auditLogPath)
      expect(sesId).not.toBe(placeholderId)

      await lane.server.restartAbrupt()

      // The resume locator is constructed BY THE TEST from the captured
      // placeholder id (the create response carries sessionId but no
      // sessionRef object — no API change needed for the caller side).
      const resumed = await postCreateTab(info, {
        agent: 'opencode',
        sessionRef: { provider: 'opencode', sessionId: placeholderId },
      })
      expect(resumed.status, `placeholder resume must succeed: ${resumed.status} ${resumed.text}`).toBe(200)
      const data = unwrapData(resumed.body)
      // THE CONTRACT: the placeholder resolves through the pane-identity
      // ledger to the SAME durable id the first turn materialized.
      // (RED today: sessionRef is silently ignored → a FRESH placeholder.)
      expect(data?.sessionId, 'placeholder resume must resolve to the materialized durable id').toBe(sesId)
      expect(data?.sessionRef).toEqual({ provider: 'opencode', sessionId: sesId })

      const after = await capturePane(info, data.paneId)
      expect(after.status).toBe(200)
      expect(after.text, 'resumed pane must show the prior turn content').toContain(
        `Fake OpenCode response: ${PROMPT}`,
      )
    } finally {
      await lane.server.stop().catch(() => {})
      await fsp.rm(lane.sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })

  // ── Loud-failure legs (Phase A asserts STATUS CODES ONLY — no error-string
  // pinning). No silent placeholder substitution on resume: each of these
  // must be a 4xx, never 200-with-a-fresh-placeholder.
  // (RED today: `sessionRef` is ignored entirely, so each returns 200.)
  const loudFailures: Array<{ name: string; body: Record<string, unknown>; status: number }> = [
    {
      name: 'provider mismatch → 400',
      body: { agent: 'opencode', sessionRef: { provider: 'claude', sessionId: 'ses_task6_mismatch' } },
      status: 400,
    },
    {
      name: 'malformed sessionRef (missing sessionId) → 400',
      body: { agent: 'opencode', sessionRef: { provider: 'opencode' } },
      status: 400,
    },
    {
      name: 'unknown durable session → 404',
      body: { agent: 'opencode', sessionRef: { provider: 'opencode', sessionId: 'ses_task6_unknown' } },
      status: 404,
    },
    {
      name: 'unresolvable placeholder → 404',
      body: {
        agent: 'opencode',
        sessionRef: { provider: 'opencode', sessionId: 'freshopencode-ffffffffffffffffffffffffffffffff' },
      },
      status: 404,
    },
  ]

  for (const leg of loudFailures) {
    test(`resume failure is loud: ${leg.name}`, async ({ e2eServerKind }) => {
      expect(e2eServerKind).toBe('rust')
      const lane = await bootOpencodeServer()
      try {
        const res = await postCreateTab(lane.info, leg.body)
        expect(
          res.status,
          `resume with ${leg.name} must be rejected, not silently substituted: ${res.status} ${res.text}`,
        ).toBe(leg.status)
      } finally {
        await lane.server.stop().catch(() => {})
        await fsp.rm(lane.sharedRoot, { recursive: true, force: true }).catch(() => {})
      }
    })
  }

  test('(c) registry placeholder clamp: a placeholder push cannot regress a pane whose live registry record holds a durable sessionRef', async ({ e2eServerKind }) => {
    expect(e2eServerKind).toBe('rust')
    const server = new RustServer()
    let wsA: WebSocket | undefined
    let wsB: WebSocket | undefined
    let wsC: WebSocket | undefined
    try {
      const info = await server.start()
      const now = Date.now()

      // Client-B is a LATER client instance on the SAME device (the
      // page-reload/re-push window where the regression shipped): its
      // snapshot carries the same tabKeys+paneIds, so same-device identity
      // fields must match across both envelopes.
      const identityA: ClientIdentity = {
        deviceId: 'task6-device',
        deviceLabel: 'Task 6 Device',
        clientInstanceId: 'task6-client-a',
      }
      const identityB: ClientIdentity = { ...identityA, clientInstanceId: 'task6-client-b' }
      const identityC: ClientIdentity = {
        deviceId: 'task6-observer',
        deviceLabel: 'Task 6 Observer',
        clientInstanceId: 'task6-client-c',
      }

      const TAB_CLAMP = 'tab-task6-clamp'
      const PANE_CLAMP = 'pane-task6-clamp'
      const CR_STABLE = 'c0ffeec0ffeec0ffeec0ffeec0ffee01'
      const DURABLE_CLAMP = 'ses_task6_durable_clamp'

      const TAB_RESET = 'tab-task6-reset'
      const PANE_RESET = 'pane-task6-reset'
      const CR_ORIG = 'c0ffeec0ffeec0ffeec0ffeec0ffee02'
      const CR_RESET = 'c0ffeec0ffeec0ffeec0ffeec0ffee03'
      const DURABLE_RESET = 'ses_task6_durable_reset'

      // Client-A pushes the DURABLE state: both panes materialized.
      wsA = await connectAndHello(info.wsUrl, info.token)
      expectAck(
        await pushTabs(wsA, identityA, 1, [
          freshAgentTabRecord(identityA, {
            tabId: TAB_CLAMP, paneId: PANE_CLAMP, createRequestId: CR_STABLE,
            sessionRefSessionId: DURABLE_CLAMP, at: now,
          }),
          freshAgentTabRecord(identityA, {
            tabId: TAB_RESET, paneId: PANE_RESET, createRequestId: CR_ORIG,
            sessionRefSessionId: DURABLE_RESET, at: now,
          }),
        ]),
        { openRecords: 2, closedRecords: 0 },
      )

      // Client-B re-pushes with REGRESSED placeholder refs for both panes
      // (later updatedAt → the naive per-tabKey winner). The clamp pane keeps
      // the SAME createRequestId (pane-identity continuity → the clamp must
      // engage); the reset pane carries a NEW createRequestId (deliberate
      // reset/fork → EXEMPT, the placeholder must pass through unclamped).
      // The push itself is still ACCEPTED — the guard clamps the winning
      // record, it does not 4xx the client's sync.
      wsB = await connectAndHello(info.wsUrl, info.token)
      expectAck(
        await pushTabs(wsB, identityB, 1, [
          freshAgentTabRecord(identityB, {
            tabId: TAB_CLAMP, paneId: PANE_CLAMP, createRequestId: CR_STABLE,
            sessionRefSessionId: `freshopencode-${CR_STABLE}`, at: now + 60_000,
          }),
          freshAgentTabRecord(identityB, {
            tabId: TAB_RESET, paneId: PANE_RESET, createRequestId: CR_RESET,
            sessionRefSessionId: `freshopencode-${CR_RESET}`, at: now + 60_000,
          }),
        ]),
        { openRecords: 2, closedRecords: 0 },
      )

      // THE CONTRACT, read from a third observer: the per-tabKey winner for
      // the CLAMP pane keeps the DURABLE sessionRef (RED today: B's
      // placeholder wins the merge outright)…
      wsC = await connectAndHello(info.wsUrl, info.token)
      const data = await queryTabs(wsC, identityC)
      const winners = data.remoteOpen as any[]
      expect(winners).toHaveLength(2)

      const clampWinner = winners.find((r) => r.tabKey === `${identityA.deviceId}:${TAB_CLAMP}`)
      expect(clampWinner, 'clamp tab must have a registry winner').toBeTruthy()
      expect(
        clampWinner.panes[0]?.payload?.sessionRef,
        'the placeholder push must not regress a materialized sessionRef',
      ).toEqual({ provider: 'opencode', sessionId: DURABLE_CLAMP })

      // …while the deliberate-reset pane is NOT clamped: its placeholder ref
      // passes through intact.
      const resetWinner = winners.find((r) => r.tabKey === `${identityA.deviceId}:${TAB_RESET}`)
      expect(resetWinner, 'reset tab must have a registry winner').toBeTruthy()
      expect(
        resetWinner.panes[0]?.payload?.sessionRef,
        'a deliberate reset (new createRequestId) must NOT be clamped',
      ).toEqual({ provider: 'opencode', sessionId: `freshopencode-${CR_RESET}` })
    } finally {
      safeClose(wsA)
      safeClose(wsB)
      safeClose(wsC)
      await server.stop().catch(() => {})
    }
  })
})
