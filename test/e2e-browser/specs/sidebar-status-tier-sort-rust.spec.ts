/**
 * Sidebar status-tier sort (default activity mode) — E2E pin of cross-device
 * tier ordering, the non-grey→grey "touch" jump, and the local-busy top
 * tier, against the REAL Rust server. Sibling of
 * sidebar-remote-status-rings-rust.spec.ts; same raw-WS second-device
 * harness (helpers copied VERBATIM per suite convention), same push
 * discipline (monotonic snapshotRevision, sequential pushes, exact
 * ack-count match), same 30s-query liveness model for REMOTE-driven
 * assertions (poll ≤45s). Local store-driven phases poll on shorter
 * deadlines.
 *
 * Ordering determinism (why fixed UUIDs): opening a session feeds its tab
 * through buildSessionItems' timestamp max with a MINUTE-bucketed tab
 * recency (tab-recency.ts), so two sessions opened seconds apart tie on
 * timestamp; the legacy/tier tiebreak is provider:sessionId ASCENDING.
 * Fixed ids S_GREY < S_BUSY < S_OPEN alphabetically make every tie land on
 * the asserted order, and S_GREY is always opened SECOND so even a crossed
 * minute boundary keeps the same recency order.
 *
 * Local-busy without the keystroke ratchet: typing in a page xterm would
 * ALSO dispatch updateSessionActivity (TerminalView.tsx) — which floats the
 * session under the LEGACY comparator too, and sidebar row clicks do not
 * ratchet (openSessionTab sets lastInputAt: undefined). To isolate the tier
 * effect, Phase 5 injects Enter keys through a raw WS terminal.input from
 * device B (server-side submit; crates/freshell-ws/src/terminal.rs:874ff),
 * producing provisional busy on the page WITHOUT any page-side ratchet.
 * The resumed session's seeded JSONL is a resolvable truth source, so the
 * 2s submit probe (claude.rs, CLAUDE_SUBMIT_GRACE_MS) reverts the busy —
 * three Enters 1.5s apart re-arm the grace (repeat-Enter rule, claude.rs:198)
 * and hold busy ≈5s, long enough for multiple poll attempts.
 *
 * Scenario (single serial test; the page is device A):
 * - Phase 0: three seeded claude sessions, all grey → pure activity recency
 *   newest→oldest (last_activity_at comes from message timestamps,
 *   parse/claude.rs): [S_GREY, S_BUSY, S_OPEN].
 * - Phase 1: device B pushes S_OPEN open + S_BUSY busy → tiers beat raw
 *   recency: [S_BUSY, S_OPEN, S_GREY]. NON-VACUOUS: legacy keeps the P0
 *   order (remote state is invisible to it).
 * - Phase 2: device B drops S_BUSY (remote-busy → grey) → the transition
 *   "touch" ratchets S_BUSY ABOVE pristine-grey S_GREY despite S_GREY's
 *   newer timestamp: [S_OPEN, S_BUSY, S_GREY]. NON-VACUOUS: without the
 *   watcher + tiers the order never leaves [S_GREY, S_BUSY, S_OPEN].
 * - Phase 3: click S_OPEN locally → local-green; ring suppressed;
 *   data-has-tab="true" awaited. Stability step: [S_OPEN, S_BUSY, S_GREY].
 * - Phase 4: ALSO click S_GREY locally → both local-green, no ratchets,
 *   tier-1 tie → fixed-id tiebreak (or crossed-minute recency; both
 *   branches produce [S_GREY, S_OPEN, S_BUSY]). Stability step.
 * - Phase 5: device B sends terminal.input text + CR-only Enter frames
 *   (is_submit_input requires whole-frame CR/LF) x3, grace re-armed to ≈5s
 *   busy, to S_OPEN's pane → tier 0 busy OUTRANKS tier 1 open: [S_OPEN,
 *   S_GREY, S_BUSY], then busy reverts and the order returns to
 *   [S_GREY, S_OPEN, S_BUSY]. NON-VACUOUS flip: legacy keeps
 *   [S_GREY, S_OPEN, S_BUSY] throughout (no page-side input ever ratchets
 *   S_OPEN).
 *
 * Owns a RustServer directly (ephemeral loopback port -- NEVER 3001/3002).
 */
import { test, expect } from '@playwright/test'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import { RustServer, ensureRustServerBuilt, type TestServerInfo } from '../helpers/rust-server.js'
import { TestHarness } from '../helpers/test-harness.js'
import { WS_PROTOCOL_VERSION } from '../../../shared/ws-protocol.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Copied VERBATIM from sidebar-remote-status-rings-rust.spec.ts (itself from
// pane-ledger-restart-rust.spec.ts:29) per this suite's per-spec-ownership
// convention: helpers are copied, not imported.
async function installFakeCli(binDir: string, name: string, source: string): Promise<string> {
  await fs.mkdir(binDir, { recursive: true })
  const target = path.join(binDir, name)
  await fs.copyFile(path.resolve(__dirname, '../fixtures', source), target)
  await fs.chmod(target, 0o755)
  return target
}

// Copied VERBATIM from sidebar-remote-status-rings-rust.spec.ts (itself from
// remote-tab-linkage-rust.spec.ts:60-74).
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

// Copied VERBATIM from sidebar-remote-status-rings-rust.spec.ts (itself from
// remote-tab-linkage-rust.spec.ts:76-86).
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

// Copied VERBATIM from sidebar-remote-status-rings-rust.spec.ts. Why: earlier
// tests in a serial suite leave panes in server memory; a fresh browser
// context triggers RecoveryOfferPanel, a fixed overlay that intercepts EVERY
// sidebar click. Recovery semantics are not under test here — just decline.
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

// Verbatim body from sidebar-remote-status-rings-rust.spec.ts, extended ONLY
// with caller-controlled timestamps. Why the second turn: a one-turn
// transcript parses as non-interactive (claude.rs user_message_count <= 1)
// and is excluded from the default sidebar window. Timestamps drive the
// indexer's last_activity_at (parse/claude.rs), which the sidebar recency
// order consumes.
function buildClaudeSessionJsonl(
  sessionId: string,
  cwd: string,
  title: string,
  t0: string,
  t1: string,
): string {
  return [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId, uuid: 'u-0', timestamp: t0, cwd }),
    JSON.stringify({ type: 'user', uuid: 'u-1', parentUuid: 'u-0', timestamp: t0, sessionId, cwd, message: { role: 'user', content: title } }),
    JSON.stringify({ type: 'assistant', uuid: 'u-2', parentUuid: 'u-1', timestamp: t0, sessionId, cwd, message: { role: 'assistant', content: [{ type: 'text', text: `${title} reply` }] } }),
    JSON.stringify({ type: 'user', uuid: 'u-3', parentUuid: 'u-2', timestamp: t1, sessionId, cwd, message: { role: 'user', content: `${title} follow-up` } }),
    JSON.stringify({ type: 'assistant', uuid: 'u-4', parentUuid: 'u-3', timestamp: t1, sessionId, cwd, message: { role: 'assistant', content: [{ type: 'text', text: `${title} second reply` }] } }),
  ].join('\n') + '\n'
}

// Copied VERBATIM from sidebar-remote-status-rings-rust.spec.ts.
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

// Copied VERBATIM from sidebar-remote-status-rings-rust.spec.ts, PLUS the
// `sendRaw` escape hatch (used by Phase 5 to inject a ratchet-free
// terminal.input busy edge). Handshake: bare ws:// connect then in-band
// {type:'hello', token, protocolVersion} → ready. pushSnapshot assigns
// monotonically increasing snapshotRevision and awaits the matching ack
// (accepted + open/closed record counts).
async function connectRawDevice(wsUrl: string, token: string): Promise<{
  pushSnapshot: (opts: { deviceId: string; deviceLabel: string; clientInstanceId: string; records: RawSnapshotRecord[] }) => Promise<void>
  sendRaw: (frame: Record<string, unknown>) => void
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
  // worker on an unhandled 'error' event; failures surface through the ack
  // waits and DOM assertions.
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
    sendRaw(frame) {
      ws.send(JSON.stringify(frame))
    },
    close() {
      ws.removeAllListeners()
      ws.close()
    },
  }
}

// ---------------------------------------------------------------------------
// Scenario constants. Fixed canonical v4 UUIDs, ordered S_GREY < S_BUSY <
// S_OPEN alphabetically, make the ascending provider:sessionId tiebreak
// deterministic when minute-bucketed tab recencies tie (see header).
// Timestamps anchored to NOW minus fixed offsets so the default sidebar
// window + 30-day retention always include them, while their spacing pins
// the all-grey Phase-0 order: S_GREY newest, S_BUSY middle, S_OPEN oldest.
// ---------------------------------------------------------------------------

const DEVICE_B_ID = 'e2e-device-b-status-sort'
const DEVICE_B_CLIENT = 'e2e-device-b-status-sort-window'

const NOW = Date.now()
const T = (hoursAgo: number): string => new Date(NOW - hoursAgo * 3_600_000).toISOString()

const S_GREY = '00000000-0000-4000-8000-000000000001' // newest; pristine grey until clicked open in P4
const S_BUSY = '00000000-0000-4000-8000-000000000002' // middle; remote-busy in P1, dropped to grey (touch) in P2
const S_OPEN = '00000000-0000-4000-8000-000000000003' // oldest; remote-open in P1, local-open in P3, local-BUSY in P5

const S_OPEN_T0 = T(3.5)
const S_OPEN_T1 = T(3)
const S_BUSY_T0 = T(2.5)
const S_BUSY_T1 = T(2)
const S_GREY_T0 = T(1.5)
const S_GREY_T1 = T(1)

// Verbatim body from sidebar-remote-status-rings-rust.spec.ts's
// buildRemoteClaudeTabRecord, parameterized ONLY to (sessionId, busy). The
// per-session tab/pane keying uses the LAST 8 chars: the fixed scenario ids
// share their FIRST 8 chars ('00000000'), and the Rust registry rejects a
// push carrying duplicate tabKeys (the whole push then goes unacked).
function buildRemoteTabRecord(sessionId: string, busy: boolean): RawSnapshotRecord {
  const now = Date.now()
  const sessionKey = `claude:${sessionId}`
  const short = sessionId.slice(-8)
  return {
    tabKey: `${DEVICE_B_ID}:claude-tab-${short}`,
    tabId: `claude-tab-${short}`,
    tabName: 'Claude (e2e device b)',
    status: 'open',
    revision: 1,
    createdAt: now - 10_000,
    updatedAt: now,
    paneCount: 1,
    titleSetByUser: false,
    panes: [
      {
        paneId: `pane-claude-${short}`,
        kind: 'terminal',
        payload: {
          mode: 'claude',
          sessionRef: { provider: 'claude', sessionId },
          sessionKeys: [sessionKey],
          ...(busy ? { busySessionKeys: [sessionKey] } : {}),
        },
      },
    ],
  }
}

// Row helpers: verbatim extensions of the rings spec's seededRow / expectRing
// / expectNoRemoteStatusRing to an arbitrary session id.
function sessionRow(page: import('@playwright/test').Page, sessionId: string) {
  return page.locator(`[data-session-id="${sessionId}"][data-provider="claude"]`)
}

async function expectNoRemoteStatusRing(row: ReturnType<typeof sessionRow>, timeoutMs = 45_000): Promise<void> {
  await expect(row).toBeVisible({ timeout: timeoutMs })
  expect(await row.getAttribute('data-remote-status')).toBeNull()
}

async function expectRing(row: ReturnType<typeof sessionRow>, kind: 'busy' | 'open', timeoutMs = 45_000): Promise<void> {
  await expect(row).toHaveAttribute('data-remote-status', kind, { timeout: timeoutMs })
  // The icon ring span (aria-hidden, carries the ring color class).
  const ringSpan = row.locator(`span[data-remote-status-ring="${kind}"]`)
  await expect(ringSpan).toHaveCount(1)
}

/**
 * Exact sidebar row-order assertion over the data-session-id of every item
 * under [data-testid="sidebar-session-list"]. Full-array equality against
 * three known ids is non-vacuous: it fails on a missing row, an extra row,
 * or a wrong order. Remote-driven phases use the 45s default (one 30s query
 * interval + margin); local store-driven phases pass shorter deadlines.
 */
async function expectSidebarOrder(
  page: import('@playwright/test').Page,
  expectedIds: string[],
  timeoutMs = 45_000,
): Promise<void> {
  await expect
    .poll(
      async () =>
        page.evaluate(() =>
          Array.from(
            document.querySelectorAll('[data-testid="sidebar-session-list"] [data-session-id]'),
          ).map((el) => el.getAttribute('data-session-id')),
        ),
      { timeout: timeoutMs },
    )
    .toEqual(expectedIds)
}

/**
 * The terminalId backing the page's own claude tab for sessionId, read from
 * the client pane-layout store (no WS surface needed; same walk the
 * terminal-activity spec performs via harness.getPaneLayout).
 */
async function getSessionTerminalId(
  page: import('@playwright/test').Page,
  sessionId: string,
): Promise<string> {
  const collectLeaves = (node: any): any[] => {
    if (!node) return []
    if (node.type === 'leaf') return [node]
    if (node.type === 'split') return [...collectLeaves(node.children?.[0]), ...collectLeaves(node.children?.[1])]
    return []
  }
  await expect
    .poll(
      async () =>
        page.evaluate((sid) => {
          const state = window.__FRESHELL_TEST_HARNESS__?.getState?.()
          const layouts = state?.panes?.layouts ?? {}
          for (const layout of Object.values(layouts)) {
            const collect = (node: any): any[] => {
              if (!node) return []
              if (node.type === 'leaf') return [node]
              if (node.type === 'split') return [...collect(node.children?.[0]), ...collect(node.children?.[1])]
              return []
            }
            const hit = collect(layout).find(
              (leaf: any) =>
                leaf?.content?.kind === 'terminal' &&
                leaf?.content?.sessionRef?.provider === 'claude' &&
                leaf?.content?.sessionRef?.sessionId === sid &&
                leaf?.content?.terminalId,
            )
            if (hit) return hit.content.terminalId
          }
          return null
        }, sessionId),
      { timeout: 30_000 },
    )
    .not.toBeNull()
  return (await page.evaluate((sid) => {
    const state = window.__FRESHELL_TEST_HARNESS__?.getState?.()
    const layouts = state?.panes?.layouts ?? {}
    for (const layout of Object.values(layouts)) {
      const collect = (node: any): any[] => {
        if (!node) return []
        if (node.type === 'leaf') return [node]
        if (node.type === 'split') return [...collect(node.children?.[0]), ...collect(node.children?.[1])]
        return []
      }
      const hit = collect(layout).find(
        (leaf: any) =>
          leaf?.content?.kind === 'terminal' &&
          leaf?.content?.sessionRef?.provider === 'claude' &&
          leaf?.content?.sessionRef?.sessionId === sid &&
          leaf?.content?.terminalId,
      )
      if (hit) return hit.content.terminalId
    }
    return null
  }, sessionId)) as string
}

test.describe.serial('sidebar status-tier sort (rust)', () => {
  test.setTimeout(300_000)
  let server: RustServer
  let info: TestServerInfo
  let sharedRoot = ''
  let projectDir = ''
  let deviceB: Awaited<ReturnType<typeof connectRawDevice>>

  test.beforeAll(async () => {
    // Hook-timeout + prebuild-guard pattern copied from the rings spec: the
    // first release build can take minutes (cloud images ship a prebuilt
    // binary via FRESHELL_E2E_RUST_SERVER_BIN; RustServer.start() resolves it
    // fail-closed).
    test.setTimeout(600_000)
    if (!process.env.FRESHELL_E2E_RUST_SERVER_BIN?.trim()) {
      ensureRustServerBuilt()
    }
    sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'status-tier-sort-'))
    projectDir = path.join(sharedRoot, 'project')
    const binDir = path.join(sharedRoot, 'bin')
    const fakeClaude = await installFakeCli(binDir, 'claude', 'fake-claude-cli.mjs')
    server = new RustServer({
      env: {
        CLAUDE_CMD: fakeClaude,
        FAKE_CLAUDE_ARGV_LOG: path.join(sharedRoot, 'claude-argv.jsonl'),
      },
      setupHome: async (homeDir: string) => {
        await fs.mkdir(projectDir, { recursive: true })
        // enable the provider the scenario uses
        const freshellDir = path.join(homeDir, '.freshell')
        await fs.mkdir(freshellDir, { recursive: true })
        await fs.writeFile(
          path.join(freshellDir, 'config.json'),
          JSON.stringify({
            version: 1,
            settings: { codingCli: { enabledProviders: ['claude'] } },
          }, null, 2),
        )
        // seed three claude sessions so the sidebar has three grey rows
        const slug = projectDir.replace(/\//g, '-')
        const projDir = path.join(homeDir, '.claude', 'projects', slug)
        await fs.mkdir(projDir, { recursive: true })
        await fs.writeFile(
          path.join(projDir, `${S_OPEN}.jsonl`),
          buildClaudeSessionJsonl(S_OPEN, projectDir, 'Status tier: local busy flip', S_OPEN_T0, S_OPEN_T1),
        )
        await fs.writeFile(
          path.join(projDir, `${S_BUSY}.jsonl`),
          buildClaudeSessionJsonl(S_BUSY, projectDir, 'Status tier: grey touch jump', S_BUSY_T0, S_BUSY_T1),
        )
        await fs.writeFile(
          path.join(projDir, `${S_GREY}.jsonl`),
          buildClaudeSessionJsonl(S_GREY, projectDir, 'Status tier: local open control', S_GREY_T0, S_GREY_T1),
        )
      },
    })
    info = await server.start()
    deviceB = await connectRawDevice(info.wsUrl, info.token)
  })

  test.afterAll(async () => {
    deviceB?.close()
    await server?.stop()
    // The RustServer fixture removes only its isolated HOME; sharedRoot (the
    // fake binary dir + the scenario project dir) is this spec's own litter.
    await fs.rm(sharedRoot, { recursive: true, force: true })
  })

  test('tiers order default sort; grey-touch jumps; local-busy beats newer local-open', async ({ page }) => {
    await bootAndConnect(page, info)
    await declineRecoveryOfferIfShowing(page)

    const rowOpen = sessionRow(page, S_OPEN)
    const rowBusy = sessionRow(page, S_BUSY)
    const rowGrey = sessionRow(page, S_GREY)

    // Phase 0 — all grey: pure activity recency, newest seeded first.
    await expectSidebarOrder(page, [S_GREY, S_BUSY, S_OPEN])
    await expectNoRemoteStatusRing(rowOpen)
    await expectNoRemoteStatusRing(rowBusy)
    await expectNoRemoteStatusRing(rowGrey)

    // Phase 1 — remote-green S_OPEN + remote-blue S_BUSY. Tiers beat raw
    // recency: [remote-busy, remote-open, grey]. Rings confirm the remote
    // state is live before the sort assertion's poll completes.
    await deviceB.pushSnapshot({
      deviceId: DEVICE_B_ID,
      deviceLabel: 'E2E Device B',
      clientInstanceId: DEVICE_B_CLIENT,
      records: [buildRemoteTabRecord(S_OPEN, false), buildRemoteTabRecord(S_BUSY, true)],
    })
    await expectSidebarOrder(page, [S_BUSY, S_OPEN, S_GREY])
    await expectRing(rowBusy, 'busy')
    await expectRing(rowOpen, 'open')
    await expectNoRemoteStatusRing(rowGrey)

    // Phase 2 — device B drops S_BUSY (remote-busy → grey): the touch
    // ratchets S_BUSY above the NEWER pristine-grey S_GREY. Without the
    // watcher recency would yield [S_OPEN, S_GREY, S_BUSY] — non-vacuous
    // touch proof.
    await deviceB.pushSnapshot({
      deviceId: DEVICE_B_ID,
      deviceLabel: 'E2E Device B',
      clientInstanceId: DEVICE_B_CLIENT,
      records: [buildRemoteTabRecord(S_OPEN, false)],
    })
    await expectSidebarOrder(page, [S_OPEN, S_BUSY, S_GREY])
    await expectNoRemoteStatusRing(rowBusy)
    await expectRing(rowOpen, 'open')

    // Phase 3 — open S_OPEN locally (fake claude CLI runs it). Local-green;
    // ring suppressed (local wins); data-has-tab awaited so the local tier
    // is registered before Phase 4. Stability: order unchanged.
    await rowOpen.click()
    await expect(rowOpen).toHaveAttribute('data-has-tab', 'true', { timeout: 30_000 })
    await expectNoRemoteStatusRing(rowOpen)
    await expectSidebarOrder(page, [S_OPEN, S_BUSY, S_GREY])

    // Phase 4 — ALSO open S_GREY locally. Both local-green; tier 1 pure
    // recency. Opening feeds tab-derived minute-bucketed recency into the
    // item timestamp: S_GREY opened SECOND so a crossed boundary puts it
    // first, and a same-minute tie falls to the provider:sessionId
    // tiebreak where S_GREY ('…0001') < S_OPEN ('…0003'). Both branches
    // deterministically yield [S_GREY, S_OPEN, S_BUSY]. Row clicks do not
    // ratchet (openSessionTab sets lastInputAt: undefined), so neither
    // model can change this — stability only.
    await rowGrey.click()
    await expect(rowGrey).toHaveAttribute('data-has-tab', 'true', { timeout: 30_000 })
    await expectNoRemoteStatusRing(rowGrey)
    await expectSidebarOrder(page, [S_GREY, S_OPEN, S_BUSY])

    // Phase 5 — local-busy WITHOUT the page-side keystroke ratchet: device
    // B injects terminal.input Enter frames into S_OPEN's pane. The page
    // never saw a keystroke, so the legacy comparator CANNOT float S_OPEN;
    // only the local-busy tier (rank 0) can move it above S_GREY.
    // The resumed session's JSONL is resolvable, so the 2s submit probe
    // reverts the provisional busy — three Enters 1.5s apart re-arm the
    // grace and hold busy ≈5s (see header).
    // The server's submit detector (is_submit_input, freshell-activity
    // signal.rs:36) only counts a frame consisting ENTIRELY of CR/LF bytes —
    // matching how xterm really sends Enter (text and Enter are separate
    // data events). Text first, then a CR-only frame. CR-only repeats
    // re-arm the provisional-busy grace (claude.rs:198) — three rounds
    // 1.5s apart hold busy ≈5s.
    const sOpenTerminalId = await getSessionTerminalId(page, S_OPEN)
    for (const text of ['busy one', 'busy two', 'busy three']) {
      deviceB.sendRaw({ type: 'terminal.input', terminalId: sOpenTerminalId, data: text })
      deviceB.sendRaw({ type: 'terminal.input', terminalId: sOpenTerminalId, data: '\r' })
      await page.waitForTimeout(1_500)
    }
    await expectSidebarOrder(page, [S_OPEN, S_GREY, S_BUSY], 15_000)
    // After the grace lapses, busy reverts and tier 1 recency returns.
    await expectSidebarOrder(page, [S_GREY, S_OPEN, S_BUSY], 30_000)
  })
})
