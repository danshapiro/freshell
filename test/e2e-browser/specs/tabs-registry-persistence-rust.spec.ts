import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import WebSocket from 'ws'
import { test, expect } from '../helpers/fixtures.js'
import { RustServer } from '../helpers/rust-server.js'
import type { TestServerInfo } from '../helpers/test-server.js'
import { WS_PROTOCOL_VERSION } from '../../../shared/ws-protocol.js'

/**
 * DURABLE TABS REGISTRY (CFG-08 + AUTO-15, Task 22, rust-only).
 *
 * E2e proof of the Rust server's durable tabs registry
 * (`crates/freshell-ws/src/tabs_store.rs` + `tabs.rs`, Node parity with
 * `server/tabs-registry/store.ts`): the content-addressed store under
 * `<home>/.freshell/tabs-registry/v1/` (manifest.json + objects/<sha256>.json)
 * must carry the cross-device registry across a full server restart, enforce
 * the Node revision guards (idempotent retry, content conflict, stale
 * rejection, retire non-resurrection via persisted watermarks), and self-heal
 * a missing referenced object by archiving the manifest as
 * `manifest.json.invalid-*` and booting empty.
 *
 * RAW WS CLIENTS, NOT BROWSER PAGES: the revision-guard journeys need exact
 * control of `snapshotRevision` and record content, which the SPA's own sync
 * loop never exposes. Frames are real `tabs.sync.push`/`tabs.sync.query`/
 * `tabs.sync.client.retire` wire messages over the same `/ws` endpoint +
 * harness-token `hello` handshake the browser uses (the raw-WS option the
 * task brief's Interfaces line allows; handshake helpers copied verbatim
 * from `ws-ping-pong-matrix.spec.ts`). Closing a raw socket without sending
 * retire is EXACTLY "close context A WITHOUT retiring" — the server retires
 * only on an explicit retire frame or the REST unload beacon, never on
 * socket close (see `tabs-client-retire.spec.ts` for the browser-side
 * retire journey this spec deliberately does not duplicate).
 *
 * PER-TEST OWNED SERVERS (auto-title-rust.spec.ts / Task 21 precedent): each
 * test boots its own `RustServer` (isolated HOME, ephemeral port). Tests 1-2
 * use `RustServer.restart()` (same home/port/token). Test 3 needs a stopped
 * server while it deletes an object file, so it passes an explicit `homeDir`
 * and boots a SECOND `RustServer` on the same home afterward.
 *
 * Node-parity note recorded for the checklist (Task 24): ONLY a missing
 * referenced object self-heals. Any OTHER corruption (bad JSON, digest
 * mismatch, schema violation) REFUSES boot (`main.rs:390-398` exits 1) —
 * Node's actual all-or-nothing `open()` behavior supersedes the checklist's
 * "only that record is quarantined" wording.
 */

const ISO_TIMESTAMP_MILLIS_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

// The two wire errors under test — asserted VERBATIM against the server's
// actual messages (`crates/freshell-ws/src/tabs.rs:54-55,618`; both surface
// as `error{code:INVALID_MESSAGE}` frames via `tabs_error_frame`,
// `terminal.rs:2120-2127`).
const STALE_REVISION_MESSAGE = 'Stale snapshot revision rejected for tabs registry client snapshot'
const DUPLICATE_CONTENT_MESSAGE = 'Duplicate snapshot revision has different tabs registry content'

/** Open a raw WS connection and complete the harness-token `hello` handshake.
 *  (Copied verbatim from `ws-ping-pong-matrix.spec.ts`.) */
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

/** Resolve with the next message matching `predicate`, or reject on timeout.
 *  (Copied verbatim from `ws-ping-pong-matrix.spec.ts`.) */
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

/** A registry-schema-complete OPEN record (all fields `validate_registry_record`
 *  requires; identity fields match the push envelope so the server's stamping
 *  is a no-op and verbatim round-trip equality holds). */
function openTabRecord(identity: ClientIdentity, input: { tabId: string; tabName: string; at: number }): any {
  return {
    tabKey: `${identity.deviceId}:${input.tabId}`,
    tabId: input.tabId,
    tabName: input.tabName,
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
      paneId: `${input.tabId}-pane-1`,
      kind: 'terminal',
      payload: { mode: 'shell', shell: 'system' },
    }],
  }
}

/** A registry-schema-complete CLOSED tombstone (`closedAt` is required when
 *  status is closed). */
function closedTabRecord(identity: ClientIdentity, input: { tabId: string; tabName: string; at: number }): any {
  return {
    ...openTabRecord(identity, input),
    status: 'closed',
    closedAt: input.at,
  }
}

/** Send `tabs.sync.push` and resolve with the server's reply — either the
 *  `tabs.sync.ack` or the `error` frame (the only two possible responses). */
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
 *  `data` (requestId-correlated, so no other frame can satisfy the wait). */
async function queryTabs(ws: WebSocket, identity: ClientIdentity): Promise<any> {
  queryCounter += 1
  const requestId = `tabs-registry-e2e-query-${queryCounter}`
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

/** Assert an ack frame's exact wire shape (`TabsSyncAck`, camelCase). */
function expectAck(frame: any, expected: { openRecords: number; closedRecords: number }): void {
  expect(frame).toEqual({
    type: 'tabs.sync.ack',
    accepted: true,
    openRecords: expected.openRecords,
    closedRecords: expected.closedRecords,
  })
}

/** Assert an error frame's exact wire shape (`tabs_error_frame`). */
function expectInvalidMessage(frame: any, message: string): void {
  expect(frame.type).toBe('error')
  expect(frame.code).toBe('INVALID_MESSAGE')
  expect(frame.message).toBe(message)
  expect(frame.timestamp).toMatch(ISO_TIMESTAMP_MILLIS_Z)
}

/** The server stamps `serverInstanceId` onto every record; it is the ONLY
 *  field of a pushed record this spec cannot know ahead of time. */
function withoutServerInstanceId(record: any): any {
  const { serverInstanceId, ...rest } = record
  expect(typeof serverInstanceId).toBe('string')
  expect(serverInstanceId.length).toBeGreaterThan(0)
  return rest
}

function sortByTabKey(records: any[]): any[] {
  return [...records].sort((a, b) => String(a.tabKey).localeCompare(String(b.tabKey)))
}

function safeClose(ws: WebSocket | undefined): void {
  try {
    ws?.close()
  } catch {
    // Already closed/dead — fine.
  }
}

test.describe('Durable tabs registry across restart (rust)', () => {
  test.setTimeout(180_000)

  test('cross-device tab registry survives a server restart', async () => {
    const server = new RustServer()
    let wsA: WebSocket | undefined
    let wsB: WebSocket | undefined
    let wsC: WebSocket | undefined
    try {
      const info: TestServerInfo = await server.start()
      const now = Date.now()

      // Context A: deviceId dev-A, revision 1, ONE open record.
      const identityA: ClientIdentity = {
        deviceId: 'dev-A',
        deviceLabel: 'Device A (e2e)',
        clientInstanceId: 'client-A',
      }
      const openA = openTabRecord(identityA, { tabId: 'tab-a1', tabName: 'A open tab', at: now })
      wsA = await connectAndHello(info.wsUrl, info.token)
      expectAck(await pushTabs(wsA, identityA, 1, [openA]), { openRecords: 1, closedRecords: 0 })

      // Context B: deviceId dev-B, revision 1, open + closed records.
      const identityB: ClientIdentity = {
        deviceId: 'dev-B',
        deviceLabel: 'Device B (e2e)',
        clientInstanceId: 'client-B',
      }
      const openB = openTabRecord(identityB, { tabId: 'tab-b1', tabName: 'B open tab', at: now + 1 })
      const closedB = closedTabRecord(identityB, { tabId: 'tab-b2', tabName: 'B closed tab', at: now + 2 })
      wsB = await connectAndHello(info.wsUrl, info.token)
      expectAck(await pushTabs(wsB, identityB, 1, [openB, closedB]), { openRecords: 1, closedRecords: 1 })

      // Close context A WITHOUT retiring: no retire frame, no unload beacon —
      // just drop the socket. The registry must keep A's snapshot.
      safeClose(wsA)

      // RESTART the rust server (fixture restart(): same home/port/token).
      await server.restart()

      // From a NEW context C (deviceId dev-C), query BEFORE A or B republish
      // (raw sockets never republish; B's socket died with the old process).
      const identityC: ClientIdentity = {
        deviceId: 'dev-C',
        deviceLabel: 'Device C (e2e)',
        clientInstanceId: 'client-C',
      }
      wsC = await connectAndHello(info.wsUrl, info.token)
      const data = await queryTabs(wsC, identityC)

      // remoteOpen contains BOTH devices' open records VERBATIM (every pushed
      // field byte-identical; only the server-stamped serverInstanceId is
      // unknowable here) ...
      expect(sortByTabKey(data.remoteOpen).map(withoutServerInstanceId))
        .toEqual(sortByTabKey([openA, openB]))
      // ... and closed contains B's tombstone.
      expect(data.closed.map(withoutServerInstanceId)).toEqual([closedB])
      // Nothing leaks into dev-C's own partitions.
      expect(data.localOpen).toEqual([])
      expect(data.sameDeviceOpen).toEqual([])
    } finally {
      safeClose(wsA)
      safeClose(wsB)
      safeClose(wsC)
      await server.stop().catch(() => {})
    }
  })

  test('idempotent retry, content conflict, stale rejection, retire non-resurrection', async () => {
    const server = new RustServer()
    let ws: WebSocket | undefined
    let wsAfterRestart: WebSocket | undefined
    try {
      const info = await server.start()
      const now = Date.now()
      const identity: ClientIdentity = {
        deviceId: 'dev-D',
        deviceLabel: 'Device D (e2e)',
        clientInstanceId: 'client-D',
      }
      const record = openTabRecord(identity, { tabId: 'tab-d1', tabName: 'D open tab', at: now })
      ws = await connectAndHello(info.wsUrl, info.token)

      // Push rev 2 twice IDENTICALLY -> both acks accepted (the second is the
      // idempotent-retry accept: same revision, same payload hash, no error).
      expectAck(await pushTabs(ws, identity, 2, [record]), { openRecords: 1, closedRecords: 0 })
      expectAck(await pushTabs(ws, identity, 2, [record]), { openRecords: 1, closedRecords: 0 })

      // Push rev 2 with DIFFERENT records -> content-conflict error frame.
      const differentRecord = { ...record, tabName: 'D open tab RENAMED' }
      expectInvalidMessage(
        await pushTabs(ws, identity, 2, [differentRecord]),
        DUPLICATE_CONTENT_MESSAGE,
      )

      // Push rev 1 -> stale rejection (below the rev-2 high water mark).
      expectInvalidMessage(await pushTabs(ws, identity, 1, [record]), STALE_REVISION_MESSAGE)

      // Retire rev 3 (fire-and-forget frame — no reply), then wait for the
      // observable effect: this client's live snapshot is gone.
      ws.send(JSON.stringify({
        type: 'tabs.sync.client.retire',
        deviceId: identity.deviceId,
        clientInstanceId: identity.clientInstanceId,
        snapshotRevision: 3,
      }))
      const retiredWs = ws
      await expect.poll(
        async () => (await queryTabs(retiredWs, identity)).localOpen.length,
        { timeout: 10_000 },
      ).toBe(0)

      // Push rev 3 -> rejected: a retired client cannot re-push at or below
      // its watermark (non-resurrection).
      expectInvalidMessage(await pushTabs(ws, identity, 3, [record]), STALE_REVISION_MESSAGE)

      // RESTART; push rev 3 again -> STILL rejected: the revision watermark
      // was durably persisted, not just held in memory.
      await server.restart()
      wsAfterRestart = await connectAndHello(info.wsUrl, info.token)
      expectInvalidMessage(await pushTabs(wsAfterRestart, identity, 3, [record]), STALE_REVISION_MESSAGE)

      // Positive control: rev 4 (ABOVE the persisted watermark) is accepted,
      // proving the rejections above were the watermark guard — not a broken
      // store after restart.
      expectAck(await pushTabs(wsAfterRestart, identity, 4, [record]), { openRecords: 1, closedRecords: 0 })
    } finally {
      safeClose(ws)
      safeClose(wsAfterRestart)
      await server.stop().catch(() => {})
    }
  })

  test('corruption recovery matches Node semantics', async () => {
    // Explicit homeDir (RustServer never deletes a caller-provided home), so
    // a SECOND server can boot on the same home after the first stops.
    const homeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-tabs-registry-e2e-'))
    const registryRoot = path.join(homeRoot, '.freshell', 'tabs-registry')
    const v1Dir = path.join(registryRoot, 'v1')
    // The legacy log the open() fall-through would rehydrate from lives at
    // `<store root>/tabs-registry.jsonl` (tabs_store.rs:215, Node
    // store.ts:692). The sibling `<home>/.freshell/tabs-registry.jsonl` is
    // asserted too, so the accounting holds even against a path regression.
    const legacyJsonlCandidates = [
      path.join(registryRoot, 'tabs-registry.jsonl'),
      path.join(homeRoot, '.freshell', 'tabs-registry.jsonl'),
    ]
    const token = randomUUID()
    const serverBefore = new RustServer({ homeDir: homeRoot, token })
    const serverAfter = new RustServer({ homeDir: homeRoot, token })
    let ws: WebSocket | undefined
    let wsAfter: WebSocket | undefined
    try {
      const info = await serverBefore.start()
      const now = Date.now()
      const identity: ClientIdentity = {
        deviceId: 'dev-E',
        deviceLabel: 'Device E (e2e)',
        clientInstanceId: 'client-E',
      }
      ws = await connectAndHello(info.wsUrl, info.token)
      expectAck(
        await pushTabs(ws, identity, 1, [
          openTabRecord(identity, { tabId: 'tab-e1', tabName: 'E open tab', at: now }),
          closedTabRecord(identity, { tabId: 'tab-e2', tabName: 'E closed tab', at: now + 1 }),
        ]),
        { openRecords: 1, closedRecords: 1 },
      )
      safeClose(ws)

      // Stop the server (process only — the caller-provided home survives).
      await serverBefore.stop()

      // validator-A8-A9 legacy-file accounting: after the missing-object
      // archive, `open()` falls through to the LEGACY branch BEFORE empty
      // (store.ts:692-709 / tabs_store.rs:215-242). The isolated home must
      // hold NO stray legacy `tabs-registry.jsonl`, so the fall-through is
      // GUARANTEED to land on the empty branch — making "archive => empty" a
      // sound assertion below.
      for (const candidate of legacyJsonlCandidates) {
        await expect(fs.access(candidate)).rejects.toThrow()
      }

      // Delete ONE referenced content-addressed object: the committed
      // manifest names its component objects; remove dev-E's open-snapshot
      // object (objects/<sha256>.json). `fs.unlink` throws if the store
      // layout were not what this spec claims.
      const manifest = JSON.parse(await fs.readFile(path.join(v1Dir, 'manifest.json'), 'utf8'))
      const openSnapshotRefs = Object.values(manifest.openSnapshots) as Array<{ path: string; sha256: string }>
      expect(openSnapshotRefs).toHaveLength(1)
      expect(openSnapshotRefs[0].path).toBe(`objects/${openSnapshotRefs[0].sha256}.json`)
      await fs.unlink(path.join(v1Dir, openSnapshotRefs[0].path))

      // Start a fresh server process on the SAME home -> it BOOTS (start()
      // waits for /api/health; any non-missing-object corruption would exit
      // 1 here instead — Node's all-or-nothing open() parity)...
      const infoAfter = await serverAfter.start()

      // ...the tabs query returns EMPTY (missing-object self-heal discarded
      // the whole registry; no legacy file existed to rehydrate from)...
      wsAfter = await connectAndHello(infoAfter.wsUrl, infoAfter.token)
      expect(await queryTabs(wsAfter, identity)).toEqual({
        localOpen: [],
        sameDeviceOpen: [],
        remoteOpen: [],
        closed: [],
        devices: [],
      })

      // ...and the manifest was archived aside as manifest.json.invalid-*
      // (the ONE self-heal), leaving no live manifest until the next commit.
      const v1Entries = await fs.readdir(v1Dir)
      expect(v1Entries.filter((name) => name.startsWith('manifest.json.invalid-'))).toHaveLength(1)
      expect(v1Entries).not.toContain('manifest.json')
      // Self-heal must not fabricate a legacy file either.
      for (const candidate of legacyJsonlCandidates) {
        await expect(fs.access(candidate)).rejects.toThrow()
      }
    } finally {
      safeClose(ws)
      safeClose(wsAfter)
      await serverBefore.stop().catch(() => {})
      await serverAfter.stop().catch(() => {})
      await fs.rm(homeRoot, { recursive: true, force: true }).catch(() => {})
    }
  })
})
