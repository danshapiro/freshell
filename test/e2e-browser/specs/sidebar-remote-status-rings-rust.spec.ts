/**
 * remote-status-rings Task 5 — E2E pin of cross-device sidebar status rings
 * against the REAL Rust server (docs/plans/2026-08-10-remote-status-rings.md).
 *
 * A second raw-WS device ('e2e-device-b') pushes `tabs.sync.push` snapshots
 * whose terminal pane payload carries `sessionKeys: ['claude:<seeded-id>']`
 * (+ `busySessionKeys` for the busy case). The page (a different device)
 * consumes them via the periodic/event-driven `tabs.sync.query` and renders
 * the ring through the real WS/store/selector/Sidebar chain:
 *
 *   case-reload: baseline no ring → busy push + reload → data-remote-status="busy"
 *     + border-blue-500 ring → open push (no busy field) + reload → "open" +
 *     border-success → push without the session + reload → attribute absent.
 *     Pins R5 (Rust payload passthrough) and both colors (R1/R2) end-to-end.
 *   case-liveness: push busy WITHOUT any reload/reconnect → the row gains
 *     data-remote-status="busy" within one 30s query interval + slack (≤45s).
 *     Pins R4 (no-reload liveness — the consumer's periodic query is the
 *     path under test).
 *   case-suppression: with the remote busy ring showing, opening the seeded
 *     session locally (sidebar click) drops the attribute; closing the tab
 *     restores it; a crafted same-device record (second raw WS client
 *     claiming the page's deviceId with a distinct clientInstanceId, whose
 *     records partition into `sameDeviceOpen`) then produces NO ring. Pins R3.
 *
 * Push discipline (plan round-2/3 findings): pushes assign monotonically
 * increasing `snapshotRevision` values (Rust treats a duplicate revision as
 * idempotent replay) and, since `tabs.sync.ack` carries NO revision field
 * (only `accepted` + record counts — shared/ws-protocol.ts:961-970), each push
 * awaits the NEXT ack whose `accepted` is true and whose record counts match
 * the push before proceeding; pushes are strictly sequential per device.
 *
 * Owns a RustServer directly (ephemeral loopback port -- NEVER 3001/3002).
 */
import { test, expect } from '@playwright/test'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import { RustServer, ensureRustServerBuilt, type E2eServerInfo } from '../helpers/rust-server.js'
import { TestHarness } from '../helpers/test-harness.js'
import { WS_PROTOCOL_VERSION } from '../../../shared/ws-protocol.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const SEEDED_CLAUDE_ID = randomUUID()
const SESSION_KEY = `claude:${SEEDED_CLAUDE_ID}`
const PROJECT_DIR = '/tmp/remote-status-rings-project'
const DEVICE_B_ID = 'e2e-device-b'
const DEVICE_B_CLIENT = 'e2e-device-b-window'

// Copied VERBATIM from pane-ledger-restart-rust.spec.ts:29 (per this
// suite's per-spec-ownership convention: helpers are copied, not imported).
async function installFakeCli(binDir: string, name: string, source: string): Promise<string> {
  await fs.mkdir(binDir, { recursive: true })
  const target = path.join(binDir, name)
  await fs.copyFile(path.resolve(__dirname, '../fixtures', source), target)
  await fs.chmod(target, 0o755)
  return target
}

// Copied VERBATIM from remote-tab-linkage-rust.spec.ts:60-74.
async function selectShellIfPickerShowing(page: import('@playwright/test').Page): Promise<void> {
  await page.waitForTimeout(500)
  const xtermVisible = await page.locator('.xterm').first().isVisible().catch(() => false)
  if (xtermVisible) return
  const shellNames = ['Shell', 'WSL', 'CMD', 'PowerShell', 'Bash']
  for (const name of shellNames) {
    try {
      await page.getByRole('button', { name: new RegExp(`^${name}$`, 'i') }).click({ timeout: 5_000 })
      await page.locator('.xterm').first().waitFor({ state: 'visible', timeout: 15_000 })
      return
    } catch {
      continue
    }
  }
}

// Copied VERBATIM from remote-tab-linkage-rust.spec.ts:76-86.
async function bootAndConnect(
  page: import('@playwright/test').Page,
  info: { baseUrl: string; token: string },
): Promise<TestHarness> {
  await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
  const harness = new TestHarness(page)
  await harness.waitForHarness()
  await harness.waitForConnection()
  await selectShellIfPickerShowing(page)
  return harness
}

// Decline idiom from recover-my-panes-rust.spec.ts:377 (recovery-decline),
// via sidebar-registry-sync-rust.spec.ts:118-132. Why: earlier tests in this
// serial suite leave panes in server memory, and a later test's FRESH browser
// context (no client state) makes RecoveryOfferPanel offer to restore them
// ("Restore N panes from server memory?"). That dialog is a fixed inset-0
// z-[60] overlay that intercepts EVERY sidebar click, so the seeded-row click
// in case-suppression would retry forever and the test would time out.
// Recovery semantics are not under test here -- just decline.
async function declineRecoveryOfferIfShowing(page: import('@playwright/test').Page): Promise<void> {
  const panel = page.getByTestId('recovery-offer-panel')
  const appeared = await panel.waitFor({ state: 'visible', timeout: 30_000 }).then(
    () => true,
    () => false, // standalone run: no panes in server memory, no offer
  )
  if (!appeared) return
  await page.getByTestId('recovery-decline').click()
  await panel.waitFor({ state: 'hidden', timeout: 5_000 })
}

// Donor: sidebar-registry-sync-rust.spec.ts:81-91 (buildClaudeSessionJsonl),
// to ONE user turn. This spec needs the seed visible in the DEFAULT sidebar
// window (priority=visible&limit=50, no includeNonInteractive): a one-turn
// transcript parses as isNonInteractive (claude.rs: user_message_count <= 1 →
// non-interactive) and is excluded there (the donor spec never noticed — its
// rows surface via LIVE terminal directory entries). So this copy keeps the
// donor (system/init: session_id, uuid, timestamp, cwd; turns: parentUuid,
// sessionId, cwd, message, uuid, timestamp).
function buildClaudeSessionJsonl(sessionId: string, cwd: string, title: string): string {
  const t0 = '2026-07-20T08:00:00.000Z'
  const t1 = '2026-07-20T08:01:00.000Z'
  return [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId, uuid: 'u-0', timestamp: t0, cwd }),
    JSON.stringify({ type: 'user', uuid: 'u-1', parentUuid: 'u-0', timestamp: t0, sessionId, cwd, message: { role: 'user', content: title } }),
    JSON.stringify({ type: 'assistant', uuid: 'u-2', parentUuid: 'u-1', timestamp: t0, sessionId, cwd, message: { role: 'assistant', content: [{ type: 'text', text: `${title} reply` }] } }),
    JSON.stringify({ type: 'user', uuid: 'u-3', parentUuid: 'u-2', timestamp: t1, sessionId, cwd, message: { role: 'user', content: `${title} follow-up` } }),
    JSON.stringify({ type: 'assistant', uuid: 'u-4', parentUuid: 'u-3', timestamp: t1, sessionId, cwd, message: { role: 'assistant', content: [{ type: 'text', text: `${title} second reply` }] } }),
  ].join('\n') + '\n'
}

function nextMessage(ws: WebSocket, predicate: (msg: any) => boolean, timeoutMs = 15_000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.off('message', onMessage)
      reject(new Error(`Timed out waiting for websocket message after ${timeoutMs}ms`))
    }, timeoutMs)
    const onMessage = (raw: WebSocket.Data) => {
      let msg: any
      try {
        msg = JSON.parse(String(raw))
      } catch {
        return
      }
      if (!predicate(msg)) return
      clearTimeout(timeout)
      ws.off('message', onMessage)
      resolve(msg)
    }
    ws.on('message', onMessage)
  })
}

type RawSnapshotRecord = Record<string, unknown> & { status?: string }

/**
 * A raw second WS device (not a browser). Handshake: bare `ws://` connect then
 * in-band `{type:'hello', token, protocolVersion}` → `ready` (Stage-2
 * assigns monotonically increasing `snapshotRevision` values and awaits the
 * matching ack per the file's header push discipline.
 */
async function connectRawDevice(wsUrl: string, token: string): Promise<{
  pushSnapshot: (opts: { deviceId: string; deviceLabel: string; clientInstanceId: string; records: RawSnapshotRecord[] }) => Promise<void>
  close: () => void
}> {
  const ws = new WebSocket(wsUrl)
  let revision = 0
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.removeAllListeners()
      ws.terminate()
      reject(new Error('Timed out waiting for raw device hello to reach ready'))
    }, 10_000)
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'hello', token, protocolVersion: WS_PROTOCOL_VERSION }))
    })
    ws.on('message', (raw) => {
      let msg: any
      try {
        msg = JSON.parse(String(raw))
      } catch {
        return
      }
      if (msg?.type !== 'ready') return
      clearTimeout(timeout)
      ws.removeAllListeners('message')
      resolve()
    })
    ws.on('error', (err) => {
      clearTimeout(timeout)
      reject(err)
    })
  })
  // A connected raw device that faults later must not crash the Playwright
  // worker on an unhandled 'error' event; failures surface loudly through the
  // ack waits and DOM assertions.
  ws.on('error', () => {})
  return {
    async pushSnapshot(opts) {
      revision += 1
      const openRecords = opts.records.filter((record) => record.status === 'open').length
      const closedRecords = opts.records.filter((record) => record.status === 'closed').length
      const ackPromise = nextMessage(ws, (msg) => msg?.type === 'tabs.sync.ack')
      ws.send(JSON.stringify({
        type: 'tabs.sync.push',
        deviceId: opts.deviceId,
        deviceLabel: opts.deviceLabel,
        clientInstanceId: opts.clientInstanceId,
        snapshotRevision: revision,
        records: opts.records,
      }))
      const ack = await ackPromise
      if (ack.accepted !== true || ack.openRecords !== openRecords || ack.closedRecords !== closedRecords) {
        throw new Error(
          `tabs.sync.ack did not match the push (expected accepted=true open=${openRecords} closed=${closedRecords}): ${JSON.stringify(ack)}`,
        )
      }
    },
    close() {
      ws.removeAllListeners()
      ws.close()
    },
  }
}

/**
 * The record a real second device WOULD push for a tab whose terminal pane is
 * this seeded claude session (the Task 1 producer stamps exactly these payload
 * fields; the wire shape is exercised byte-for-byte here). Pane `kind` and
 * payload `mode` satisfy the Rust push validation
 * (crates/freshell-ws/src/tabs_persist_validation.rs `validate_terminal`).
 */
function buildRemoteClaudeTabRecord(busy: boolean): RawSnapshotRecord {
  const now = Date.now()
  return {
    tabKey: `${DEVICE_B_ID}:claude-tab-1`,
    tabId: 'claude-tab-1',
    tabName: 'Claude (e2e device b)',
    status: 'open',
    revision: 1,
    createdAt: now - 10_000,
    updatedAt: now,
    paneCount: 1,
    titleSetByUser: false,
    panes: [
      {
        paneId: 'pane-claude-1',
        kind: 'terminal',
        payload: {
          mode: 'claude',
          sessionRef: { provider: 'claude', sessionId: SEEDED_CLAUDE_ID },
          sessionKeys: [SESSION_KEY],
          ...(busy ? { busySessionKeys: [SESSION_KEY] } : {}),
        },
      },
    ],
  }
}

function seededRow(page: import('@playwright/test').Page) {
  return page.locator(`[data-session-id="${SEEDED_CLAUDE_ID}"][data-provider="claude"]`)
}

/** The row exists (visible) and carries NO remote-status attribute. */
async function expectNoRemoteStatusRing(row: ReturnType<typeof seededRow>): Promise<void> {
  await expect(row).toBeVisible({ timeout: 30_000 })
  expect(await row.getAttribute('data-remote-status')).toBeNull()
}

async function expectRing(row: ReturnType<typeof seededRow>, kind: 'busy' | 'open', timeoutMs = 30_000): Promise<void> {
  await expect(row).toHaveAttribute('data-remote-status', kind, { timeout: timeoutMs })
  // The icon ring span (aria-hidden, carries the ring color class).
  const ringSpan = row.locator(`span[data-remote-status-ring="${kind}"]`)
  await expect(ringSpan).toHaveCount(1)
}

/**
 * Reload and wait for the WS to reconnect and reach 'ready' state
 * (copied VERBATIM from sidebar-registry-sync-rust.spec.ts:457-464, itself
 * copied VERBATIM from server-restart-recovery.spec.ts:106-111). The ready
 * edge triggers an immediate `tabs.sync.query`, so remote-state assertions
 * after this helper reflect a fresh server-side answer.
 */
async function reloadAndReconnect(page: import('@playwright/test').Page): Promise<void> {
  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(async () => {
    const status = await page.evaluate(() =>
      window.__FRESHELL_TEST_HARNESS__?.getWsReadyState()
    )
    expect(status).toBe('ready')
  }).toPass({ timeout: 30_000 })
}

test.describe.serial('sidebar remote status rings (rust)', () => {
  test.setTimeout(240_000)
  let server: RustServer
  let info: E2eServerInfo
  let sharedRoot: string
  let deviceB: Awaited<ReturnType<typeof connectRawDevice>>

  test.beforeAll(async () => {
    // Same hook-timeout + prebuild pattern as
    // sidebar-registry-sync-rust.spec.ts:168-172: the first release build of
    // freshell-server can take minutes, and the default 60s hook timeout would
    // chromium project, so it ALSO runs in cloud images that ship a prebuilt
    // server binary but no Cargo toolchain: skip the prebuild when the
    // override is configured; RustServer.start() resolves it fail-closed via
    // resolveRustServerBin (rust-server.ts:455).
    test.setTimeout(600_000)
    if (!process.env.FRESHELL_E2E_RUST_SERVER_BIN?.trim()) {
      ensureRustServerBuilt()
    }
    sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-status-rings-'))
    const binDir = path.join(sharedRoot, 'bin')
    const fakeClaude = await installFakeCli(binDir, 'claude', 'fake-claude-cli.mjs')
    server = new RustServer({
      env: {
        CLAUDE_CMD: fakeClaude,
        FAKE_CLAUDE_ARGV_LOG: path.join(sharedRoot, 'claude-argv.jsonl'),
      },
      setupHome: async (homeDir: string) => {
        await fs.mkdir(PROJECT_DIR, { recursive: true })
        // enable the providers the scenarios use
        const freshellDir = path.join(homeDir, '.freshell')
        await fs.mkdir(freshellDir, { recursive: true })
        await fs.writeFile(path.join(freshellDir, 'config.json'), JSON.stringify({
          version: 1,
          settings: { codingCli: { enabledProviders: ['claude'] } },
        }, null, 2))
        // seed a claude session file so the sidebar has a row to ring
        const slug = PROJECT_DIR.replace(/\//g, '-')
        const projDir = path.join(homeDir, '.claude', 'projects', slug)
        await fs.mkdir(projDir, { recursive: true })
        await fs.writeFile(
          path.join(projDir, `${SEEDED_CLAUDE_ID}.jsonl`),
          buildClaudeSessionJsonl(SEEDED_CLAUDE_ID, PROJECT_DIR, 'Remote status ring seeded session'))
      },
    })
    info = await server.start()
    deviceB = await connectRawDevice(info.wsUrl, info.token)
  })

  test.afterAll(async () => {
    deviceB?.close()
    await server?.stop()
  })

  test('case-reload: baseline → busy → open → absent across reloads (R5 passthrough + R1/R2 colors)', async ({ page }) => {
    await bootAndConnect(page, info)
    const row = seededRow(page)

    // Baseline: no device has pushed anything about the seeded session yet.
    await expectNoRemoteStatusRing(row)

    // Busy on another device → reload → blue ring.
    await deviceB.pushSnapshot({
      deviceId: DEVICE_B_ID,
      deviceLabel: 'E2E Device B',
      clientInstanceId: DEVICE_B_CLIENT,
      records: [buildRemoteClaudeTabRecord(true)],
    })
    await reloadAndReconnect(page)
    await expectRing(row, 'busy')

    // Open (not busy) on another device → reload → green ring.
    await deviceB.pushSnapshot({
      deviceId: DEVICE_B_ID,
      deviceLabel: 'E2E Device B',
      clientInstanceId: DEVICE_B_CLIENT,
      records: [buildRemoteClaudeTabRecord(false)],
    })
    await reloadAndReconnect(page)
    await expectRing(row, 'open')

    // The other device no longer has the session open → reload → no ring.
    await deviceB.pushSnapshot({
      deviceId: DEVICE_B_ID,
      deviceLabel: 'E2E Device B',
      clientInstanceId: DEVICE_B_CLIENT,
      records: [],
    })
    await reloadAndReconnect(page)
    await expectNoRemoteStatusRing(row)
  })

  test('case-liveness: ring appears with NO reload through the 30s periodic query (R4)', async ({ page }) => {
    // Clean baseline BEFORE boot: an empty snapshot from device-b so the boot
    // query sees no remote record for the seeded session. (Self-sufficient
    // even if case-reload did not run first.)
    await deviceB.pushSnapshot({
      deviceId: DEVICE_B_ID,
      deviceLabel: 'E2E Device B',
      clientInstanceId: DEVICE_B_CLIENT,
      records: [],
    })

    await bootAndConnect(page, info)
    const row = seededRow(page)
    await expectNoRemoteStatusRing(row)

    // Push busy + await the matching ack, then assert the row gains the busy
    // ring WITHOUT reloading or reconnecting the page: the consumer's 30s
    // periodic `tabs.sync.query` (the path under test for R4) must deliver
    // it. Window = one interval + slack (45s); per-test budget is 240s.
    await deviceB.pushSnapshot({
      deviceId: DEVICE_B_ID,
      deviceLabel: 'E2E Device B',
      clientInstanceId: DEVICE_B_CLIENT,
      records: [buildRemoteClaudeTabRecord(true)],
    })
    await expectRing(row, 'busy', 45_000)
  })

  test('case-suppression: locally-open session and same-device records never ring (R3)', async ({ page }) => {
    // Install the remote busy ring BEFORE boot so the boot query delivers it.
    await deviceB.pushSnapshot({
      deviceId: DEVICE_B_ID,
      deviceLabel: 'E2E Device B',
      clientInstanceId: DEVICE_B_CLIENT,
      records: [buildRemoteClaudeTabRecord(true)],
    })

    await bootAndConnect(page, info)
    // Earlier serial tests leave panes in server memory, so this fresh
    // context gets the recovery-offer overlay; decline it before clicking.
    await declineRecoveryOfferIfShowing(page)
    const row = seededRow(page)
    await expectRing(row, 'busy')

    // R3 (local wins): open the seeded session on THIS device via the sidebar
    // row click → the ring attribute disappears (suppression is computed from
    // live local state; no reload/query needed). data-has-tab proves the
    // session really is open locally, so the attribute absence is meaningful.
    await row.click()
    await expect(row).toHaveAttribute('data-has-tab', 'true', { timeout: 30_000 })
    await expect.poll(async () => row.getAttribute('data-remote-status'), { timeout: 15_000 }).toBeNull()

    // Closing the local tab lifts the local suppression: device-b's busy
    // record is still in the store, so the busy ring returns (no reload).
    const tabLocation = await page.evaluate(() => {
      const state = window.__FRESHELL_TEST_HARNESS__?.getState()
      const ids: string[] = state?.tabs?.tabs?.map((tab: any) => tab.id) ?? []
      return { ids, activeTabId: state?.tabs?.activeTabId ?? '' }
    })
    const closeIndex = tabLocation.ids.indexOf(tabLocation.activeTabId)
    expect(closeIndex, 'active (seeded session) tab must exist in the tab strip').toBeGreaterThanOrEqual(0)
    await page.locator('[data-context="tab"]').nth(closeIndex).getByRole('button', { name: /close/i }).click()
    await expect(row).toHaveAttribute('data-has-tab', 'false', { timeout: 30_000 })
    await expectRing(row, 'busy')

    // Isolate the same-device phase: clear device-b's record, reload → the
    // ring is really gone before the impostor acts.
    await deviceB.pushSnapshot({
      deviceId: DEVICE_B_ID,
      deviceLabel: 'E2E Device B',
      clientInstanceId: DEVICE_B_CLIENT,
      records: [],
    })
    await reloadAndReconnect(page)
    await expectNoRemoteStatusRing(row)

    // R3 (same device): a raw client claiming THIS page's deviceId with a
    // distinct clientInstanceId partitions into `sameDeviceOpen`, which must
    // never produce a ring. The page deviceId is the canonical localStorage one.
    const pageDeviceId = await page.evaluate(() => window.localStorage.getItem('freshell.device-id.v2'))
    expect(pageDeviceId, 'page deviceId must be persisted in localStorage').toBeTruthy()
    const impostor = await connectRawDevice(info.wsUrl, info.token)
    await impostor.pushSnapshot({
      deviceId: pageDeviceId!,
      deviceLabel: 'E2E same-device impostor',
      clientInstanceId: 'e2e-same-device-impostor',
      records: [buildRemoteClaudeTabRecord(true)],
    })

    // Reload → the ready-edge query partitions the impostor record into
    // sameDeviceOpen. Prove the delivery happened (store contents make the
    // absence assertion non-vacuous), then assert NO ring.
    await reloadAndReconnect(page)
    await expect(seededRow(page)).toBeVisible({ timeout: 30_000 })
    await expect.poll(async () => page.evaluate((key) => {
      const state = window.__FRESHELL_TEST_HARNESS__?.getState()
      const scan = (records: any[] | undefined) => (records ?? []).some(
        (record) => (record?.panes ?? []).some(
          (pane: any) => (pane?.payload?.sessionKeys ?? []).includes(key),
        ),
      )
      return {
        sameDevice: scan(state?.tabRegistry?.sameDeviceOpen),
        remote: scan(state?.tabRegistry?.remoteOpen),
      }
    }, SESSION_KEY), { timeout: 30_000 }).toEqual({ sameDevice: true, remote: false })
    // Same-device records only ever suppress; the attribute must stay absent.
    await page.waitForTimeout(1_000)
    expect(await seededRow(page).getAttribute('data-remote-status')).toBeNull()

    impostor.close()
  })
})
