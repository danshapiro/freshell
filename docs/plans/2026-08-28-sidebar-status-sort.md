# Sidebar Status-Tier Sort Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

**Goal:** In the sidebar's default (activity) sort, coding-agent sessions sort by status tier — local-blue (busy here) first, then local-green (open here), then remote-blue (busy on another device), then remote-green (open on another device), then grey (closed everywhere) — with activity recency ordering ties inside each tier; and any session that transitions from any non-grey state to grey is "touched" (sort-activity ratchet) so it sorts at the top of the grey agents.

**Architecture:** A new memoized selector computes one tier record (`sessionKey → status tier`) by composing the existing local activity collectors (`collectBusySessionKeys`, `collectPaneIdentityActivity`, `collectSessionRefsFromTabs`) with the existing remote ring selector (`deriveRemoteSessionActivity` fields, sameDevice suppression). Default activity sort consumes that tier map: tier rank ascending, then the legacy within-tier comparator (local tiers = pure recency; remote/grey tiers = ratchet-presence-first legacy ordering, which makes grey-touches float to the top of grey). A store-level watcher compares consecutive tier snapshots and dispatches `updateSessionActivity` when a key that was non-grey becomes absent (grey transition). Sidebar rendering is unchanged.

**Tech Stack:** React 18 + Redux Toolkit (client), Vitest unit tests, Playwright e2e against an owned `RustServer` fixture (raw WebSocket device pushes for cross-device state).

## Global Constraints

- Work only in `/home/dan/code/freshell/.worktrees/sidebar-status-sort`, branch `the-usual/sidebar-status-sort`, base_ref `5b8717017db793744f74d192d604d0739f1da2e1`. Never commit to or push `main`. PR creation requires explicit user approval — stop before it.
- Every vitest/playwright command MUST be prefixed `env -u FRESHELL_BIND_HOST`. Agent shells on this machine export `FRESHELL_BIND_HOST=0.0.0.0`, which non-hermetically fails `test/unit/vite-config.test.ts` (pre-existing failure, out of scope, recorded in the run baseline ledger).
- Broad suite entry point is the coordinated `npm test` (via `npm run check`); focused client suites use `npm run test:vitest -- ...`; focused e2e uses `npm run test:e2e:chromium -- <spec-path>`.
- Do NOT change Sidebar render semantics (busy dot, ring visuals). Tiers and the touch watcher only affect SORTING and the sessionActivity ratchet.
- Tier logic applies only when `sortMode === 'activity'` (the default) and `disableTabPinning` is false (no active search). All other sort modes and search keep legacy paths byte-for-byte.
- Follow the a11y and lint rules in AGENTS.md for any touched UI file.

---

## Stage history note

Tasks 1–5 were implemented pre-record (before this run was adopted into the-usual discipline) with red/green TDD cycles; each task below records its as-built state, its failing-red reason, and its green receipt. Task 6 is the remaining executable work. Do not re-do Tasks 1–5.

### Task 1: Status-tier model + sort bucketing in `sortSessionItems` — COMPLETE (as-built)

**Files:**
- Create: `src/store/selectors/sessionStatusTiers.ts` (tier type + ranks helper)
- Modify: `src/store/selectors/sidebarSelectors.ts` (`sortSessionItems` accepts `options.statusTiers`)
- Test: `test/unit/client/store/selectors/sidebarSelectors.test.ts`

**Interfaces:**
- Produces: `SessionStatusTier = 'local-busy' | 'local-open' | 'remote-busy' | 'remote-open'`; `SESSION_STATUS_TIER_RANK: Record<SessionStatusTier, 0|1|2|3>`; `GREY_STATUS_TIER_RANK = 4`; `sessionStatusTierRank(tier: SessionStatusTier | undefined): number` (absent → grey rank); `sortSessionItems(items, opts & { statusTiers?: Record<string, SessionStatusTier> })`.

**Behavior (as-built):** When `sortMode === 'activity'`, `disableTabPinning` is false, and `statusTiers` is provided: bucket each item by `sessionStatusTierRank(tierMap[item.sessionKey])`; sort tier-rank ascending; within local tiers (0–1) order by pure recency (`ratchetedActivity ?? timestamp` desc, tiebreak `provider:sessionId`); within remote/grey tiers (2–4) keep the legacy **withoutTabs** comparator (ratchet-presence first, then recency). Items absent from the tier map are grey even when `hasTab` — the producing selector owns the hasTab→tier mapping. When `statusTiers` is absent (or pinning/search/non-activity mode), the legacy path runs unchanged.

**Red reason (original):** tiers did not exist — tier-separated ordering tests failed against pure-legacy recency sort.
**Green receipt:** 45/45 in sidebarSelectors.test.ts describe block 'activity mode with status tiers' + full existing block (2026-08-27).

### Task 2: `makeSelectSessionStatusTiers` memoized selector factory — COMPLETE (as-built)

**Files:**
- Modify: `src/store/selectors/sessionStatusTiers.ts` (add factory)
- Test: `test/unit/client/store/selectors/sessionStatusTiers.test.ts` (new)

**Interfaces:**
- Consumes: `collectBusySessionKeys`, `collectPaneIdentityActivity` (from `src/lib/pane-activity.ts`), `collectSessionRefsFromTabs`, `deriveRemoteSessionActivity` (from `src/store/selectors/tabsRegistrySelectors.ts`).
- Produces: `makeSelectSessionStatusTiers(): (state: RootState) => Record<string, SessionStatusTier>`.

**Behavior (as-built):** For every tab identity: tier = local-busy if the key is in `collectBusySessionKeys`, else local-open; key = provider:sessionId per the shared key helper. Remote tier comes from `deriveRemoteSessionActivity(...).remoteActivityBySessionKey` with sameDevice suppression; busy outranks open per key. Local outranks remote. Output is a plain map for cheap structural sharing.

**Red reason (original):** selector did not exist.
**Green receipt:** 7/7 in sessionStatusTiers.test.ts (2026-08-27).

### Task 3: Wire tiers into `makeSelectSortedSessionItems` — COMPLETE (as-built)

**Files:**
- Modify: `src/store/selectors/sidebarSelectors.ts` (`makeSelectSortedSessionItems` gains the tier selector as an input and passes `statusTiers` to `sortSessionItems`; module-scope `selectSessionStatusTiers` instance)
- Test: `test/unit/client/store/selectors/sidebarSelectors.test.ts` (`createSelectorState` extended with `claudeActivityByTerminalId` and `remoteOpen` options; new describe `makeSelectSortedSessionItems status tiers (default activity mode)`)

**Behavior (as-built):** The memoized sidebar sort now produces tier-ordered items in default mode. A fixture bug found during wiring (codex vs claude provider key mismatch) was fixed. Grey-touch ordering pinned at selector level: a touched grey session out-orders a never-touched grey session with a newer raw timestamp.

**Red reason (original):** sorted list ignored tiers. **Green receipt:** selector + Sidebar suites green; 208 tests across 6 files (2026-08-27).

### Task 4: Grey-transition touch watcher — COMPLETE (as-built)

**Files:**
- Create: `src/store/sessionGreyTouch.ts`
- Test: `test/unit/client/store/sessionGreyTouch.test.ts` (new)

**Interfaces:**
- Produces: `startSessionGreyTouchWatcher(store: MinimalStore): () => void` where `MinimalStore = { getState(): RootState; subscribe(cb: () => void): () => void }`. Snapshot of tiers taken at start (no retroactive touches). Returns a stop handle.

**Behavior (as-built):** On every store change, recompute the memoized tier selector; for each key present with a non-grey tier in the previous snapshot and ABSENT in the current snapshot, dispatch `updateSessionActivity({ sessionId: key, lastInputAt: Date.now() })` (existing monotonic-max ratchet). `previousTiers` is assigned BEFORE dispatch so the synchronous redispatch cannot re-fire the same transition (re-entrancy guard). `remoteOpen` persists across WS disconnect, so network blips never produce spurious grey transitions — deliberately no debounce.

**Red reason (original):** watcher did not exist. **Green receipt:** 7/7 in sessionGreyTouch.test.ts (2026-08-27).

### Task 5: App wiring + settings label sync — COMPLETE (as-built)

**Files:**
- Modify: `src/App.tsx` (bootstrap: `stopSessionGreyTouch = startSessionGreyTouchWatcher(appStore)` immediately after `startTabRegistrySync`; called + nulled at BOTH teardown sites where `stopTabRegistrySync?.()` runs)
- Modify: `src/components/settings/WorkspaceSettings.tsx:53` (`Activity (tabs first)` → `Activity (status first)`)
- Modify: `docs/index.html:1102` (mock option label synced)
- Test: `test/unit/client/components/SettingsView.behavior.test.tsx` (label pin updated)

**Red reason (original):** watcher never started; label stale. **Green receipt:** settings behavior + App.ws-bootstrap + watcher suites green (74 tests, 2026-08-27); `npm run typecheck` clean.

---

### Task 6: E2E proof on the Rust server — status tiers ordering + grey-touch jump

**Files:**
- Create: `test/e2e-browser/specs/sidebar-status-tier-sort-rust.spec.ts`

**Interfaces:**
- Verbatim-copied helpers per this suite's per-spec-ownership convention: `installFakeCli`, `selectShellIfPickerShowing`, `bootAndConnect`, `declineRecoveryOfferIfShowing`, `nextMessage`, `connectRawDevice`, `buildClaudeSessionJsonl` (verbatim body, extended ONLY with `t0`/`t1` ISO params), `buildRemoteClaudeTabRecord` (verbatim body, parameterized to `(sessionId, busy)`), `expectRing`/`expectNoRemoteStatusRing` (verbatim, parameterized to an arbitrary row). New helper: `expectSidebarOrder`.
- New spec arrives under the default `chromium` project automatically (not in `RUST_ONLY_SPECS`) — same precedent as the rings spec: it owns its own `RustServer`.

**Red mode (pre-feature):** remote state has no effect on sort and no tier bucketing exists, so every post-phase-0 order assertion fails (untiered sort would keep returning `[S_GREY, S_BUSY, S_OPEN]`), and the phase-2 grey-touch jump fails because no watcher exists.

- [ ] **Step 1: Create the behavioral spec**

Create `test/e2e-browser/specs/sidebar-status-tier-sort-rust.spec.ts` with EXACTLY this content:

```ts
/**
 * Sidebar status-tier sort (default activity mode) — E2E pin of cross-device
 * tier ordering + the non-grey→grey "touch" jump against the REAL Rust server.
 * Sibling of sidebar-remote-status-rings-rust.spec.ts; same raw-WS second
 * device harness (helpers copied VERBATIM per suite convention), same push
 * discipline (monotonic snapshotRevision, sequential pushes, exact ack-count
 * match), same 30s-query liveness model (post-push assertions poll ≤45s).
 *
 * Scenario (single serial test; the page is device A):
 * - Phase 0: three seeded claude sessions, all grey → pure activity-recency
 *   order newest→oldest (S_GREY, S_BUSY, S_OPEN — seeded timestamps control it;
 *   the indexer's last_activity_at comes from message timestamps).
 * - Phase 1: device B pushes S_OPEN open (remote-green) + S_BUSY busy
 *   (remote-blue) → tier order beats raw recency: [S_BUSY, S_OPEN, S_GREY].
 * - Phase 2: device B drops S_BUSY's record (remote-busy → grey) → the
 *   grey-transition touch ratchets S_BUSY ABOVE pristine-grey S_GREY despite
 *   S_GREY's newer stored timestamp: [S_OPEN, S_BUSY, S_GREY]. Non-vacuous:
 *   without the watcher, raw recency yields [S_OPEN, S_GREY, S_BUSY].
 * - Phase 3: click S_OPEN locally (fake claude CLI) → local-green tier; ring
 *   suppressed; data-has-tab="true" awaited so the local tier is provably
 *   active before Phase 4.
 * - Phase 4: device B drops S_OPEN's record and starts S_GREY busy →
 *   non-vacuous local > remote > grey separation: [S_OPEN (local-green),
 *   S_GREY (remote-blue), S_BUSY (grey, touched)]. Without the local tier,
 *   S_OPEN would fall to grey (its remote record is gone) and sink below
 *   S_GREY.
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

// Copied VERBATIM from sidebar-remote-status-rings-rust.spec.ts.
// Why: earlier tests in a serial suite leave panes in server memory, and a
// later test's FRESH browser context (no client state) makes
// RecoveryOfferPanel offer to restore them; that overlay intercepts EVERY
// sidebar click. Recovery semantics are not under test here -- just decline.
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
// with caller-controlled timestamps (t0/t1). Why the second turn: a one-turn
// transcript parses as non-interactive (claude.rs user_message_count <= 1)
// and is excluded from the default sidebar window — keep the two-turn shape.
// Timestamps drive the indexer's last_activity_at (parse/claude.rs), which is
// what the default sidebar recency order consumes.
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

// Copied VERBATIM from sidebar-remote-status-rings-rust.spec.ts.
// Handshake: bare ws:// connect then in-band {type:'hello', token,
// protocolVersion} → ready. pushSnapshot assigns monotonically increasing
// snapshotRevision values and awaits the matching ack (accepted + record
// counts) — push discipline per the rings spec's round-3 plan findings.
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

// ---------------------------------------------------------------------------
// Scenario constants: three seeded claude sessions with caller-pinned
// timestamps so the all-grey Phase-0 order is deterministic (S_GREY newest,
// S_BUSY middle, S_OPEN oldest). Anchored to NOW minus fixed offsets so the
// default sidebar window + 30-day retention always include them.
// ---------------------------------------------------------------------------

const PROJECT_DIR = '/tmp/sidebar-status-tier-sort-project'
const DEVICE_B_ID = 'e2e-device-b-status-sort'
const DEVICE_B_CLIENT = 'e2e-device-b-status-sort-window'

const NOW = Date.now()
const T = (hoursAgo: number): string => new Date(NOW - hoursAgo * 3_600_000).toISOString()

const S_OPEN = randomUUID() // oldest activity; device-B open in P1, clicked open locally in P3
const S_BUSY = randomUUID() // middle activity; device-B busy in P1, dropped to grey in P2
const S_GREY = randomUUID() // newest; pristine grey until P4, then remote-busy

const S_OPEN_T0 = T(3.5)
const S_OPEN_T1 = T(3)
const S_BUSY_T0 = T(2.5)
const S_BUSY_T1 = T(2)
const S_GREY_T0 = T(1.5)
const S_GREY_T1 = T(1)

// Verbatim body from sidebar-remote-status-rings-rust.spec.ts's
// buildRemoteClaudeTabRecord, parameterized ONLY to (sessionId, busy):
// tabKey/tabId/paneId get a per-session suffix so distinct simulated tabs do
// not collide inside device B's snapshot.
function buildRemoteTabRecord(sessionId: string, busy: boolean): RawSnapshotRecord {
  const now = Date.now()
  const sessionKey = `claude:${sessionId}`
  const short = sessionId.slice(0, 8)
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

// Row helpers: verbatim extensions of the rings spec's seededRow /
// expectRing / expectNoRemoteStatusRing to an arbitrary session id.
function sessionRow(page: import('@playwright/test').Page, sessionId: string) {
  return page.locator(`[data-session-id="${sessionId}"][data-provider="claude"]`)
}

async function expectNoRemoteStatusRing(row: ReturnType<typeof sessionRow>): Promise<void> {
  await expect(row).toBeVisible({ timeout: 45_000 })
  expect(await row.getAttribute('data-remote-status')).toBeNull()
}

async function expectRing(row: ReturnType<typeof sessionRow>, kind: 'busy' | 'open', timeoutMs = 45_000): Promise<void> {
  await expect(row).toHaveAttribute('data-remote-status', kind, { timeout: timeoutMs })
  // The icon ring span (aria-hidden, carries the ring color class).
  const ringSpan = row.locator(`span[data-remote-status-ring="${kind}"]`)
  await expect(ringSpan).toHaveCount(1)
}

/**
 * Exact sidebar row-order assertion. Scrapes the data-session-id of every
 * item under the session list and compares the full ordered array — full-array
 * equality against three known ids makes the check non-vacuous: it fails on
 * any missing row, any extra row, and any order mismatch. Poll deadline
 * accommodates one full 30s remote reconcile interval after a push, plus
 * margin.
 *
 * Scope note: the query is scoped to [data-testid="sidebar-session-list"] so
 * pinned-terminal items (a separate list) can never pollute it.
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

test.describe.serial('sidebar status-tier sort (rust)', () => {
  test.setTimeout(300_000)
  let server: RustServer
  let info: TestServerInfo
  let deviceB: Awaited<ReturnType<typeof connectRawDevice>>

  test.beforeAll(async () => {
    // Same hook-timeout + prebuild-guard pattern as
    // sidebar-remote-status-rings-rust.spec.ts: the first release build of
    // freshell-server can take minutes (cloud images ship a prebuilt server
    // binary via FRESHELL_E2E_RUST_SERVER_BIN; RustServer.start() resolves it
    // fail-closed).
    test.setTimeout(600_000)
    if (!process.env.FRESHELL_E2E_RUST_SERVER_BIN?.trim()) {
      ensureRustServerBuilt()
    }
    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'status-tier-sort-'))
    const binDir = path.join(sharedRoot, 'bin')
    const fakeClaude = await installFakeCli(binDir, 'claude', 'fake-claude-cli.mjs')
    server = new RustServer({
      env: {
        CLAUDE_CMD: fakeClaude,
        FAKE_CLAUDE_ARGV_LOG: path.join(sharedRoot, 'claude-argv.jsonl'),
      },
      setupHome: async (homeDir: string) => {
        await fs.mkdir(PROJECT_DIR, { recursive: true })
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
        const slug = PROJECT_DIR.replace(/\//g, '-')
        const projDir = path.join(homeDir, '.claude', 'projects', slug)
        await fs.mkdir(projDir, { recursive: true })
        await fs.writeFile(
          path.join(projDir, `${S_OPEN}.jsonl`),
          buildClaudeSessionJsonl(S_OPEN, PROJECT_DIR, 'Status tier: becomes remote-open', S_OPEN_T0, S_OPEN_T1),
        )
        await fs.writeFile(
          path.join(projDir, `${S_BUSY}.jsonl`),
          buildClaudeSessionJsonl(S_BUSY, PROJECT_DIR, 'Status tier: becomes remote-busy', S_BUSY_T0, S_BUSY_T1),
        )
        await fs.writeFile(
          path.join(projDir, `${S_GREY}.jsonl`),
          buildClaudeSessionJsonl(S_GREY, PROJECT_DIR, 'Status tier: pristine grey', S_GREY_T0, S_GREY_T1),
        )
      },
    })
    info = await server.start()
    deviceB = await connectRawDevice(info.wsUrl, info.token)
  })

  test.afterAll(async () => {
    deviceB?.close()
    await server?.stop()
  })

  test('tiers order the default sort; a remote-busy → grey touch jumps the row', async ({ page }) => {
    await bootAndConnect(page, info)
    await declineRecoveryOfferIfShowing(page)

    const rowOpen = sessionRow(page, S_OPEN)
    const rowBusy = sessionRow(page, S_BUSY)
    const rowGrey = sessionRow(page, S_GREY)

    // ---- Phase 0: all grey — pure activity recency, newest seeded first.
    await expectSidebarOrder(page, [S_GREY, S_BUSY, S_OPEN])
    await expectNoRemoteStatusRing(rowOpen)
    await expectNoRemoteStatusRing(rowBusy)
    await expectNoRemoteStatusRing(rowGrey)

    // ---- Phase 1: remote-green S_OPEN (oldest) + remote-blue S_BUSY
    // (middle). Tiers beat raw recency: [remote-busy, remote-open, grey].
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

    // ---- Phase 2: device B drops S_BUSY (remote-busy → grey). The
    // transition is a sort-activity touch: S_BUSY must jump ABOVE the newer
    // pristine-grey S_GREY. Without the watcher the raw-recency order would
    // be [S_OPEN, S_GREY, S_BUSY] and this assertion fails — the touch proof
    // is non-vacuous.
    await deviceB.pushSnapshot({
      deviceId: DEVICE_B_ID,
      deviceLabel: 'E2E Device B',
      clientInstanceId: DEVICE_B_CLIENT,
      records: [buildRemoteTabRecord(S_OPEN, false)],
    })
    await expectSidebarOrder(page, [S_OPEN, S_BUSY, S_GREY])
    await expectNoRemoteStatusRing(rowBusy)
    await expectRing(rowOpen, 'open')

    // ---- Phase 3: open S_OPEN locally (fake claude CLI). Local-green tier;
    // the ring is suppressed (local wins); await data-has-tab="true" so the
    // local tier is provably registered before Phase 4. Order unchanged
    // (local-open and remote-open both outrank the greys; timestamp order
    // within that non-tie region differs by tier rank, which the NEXT phase
    // disambiguates).
    await rowOpen.click()
    await expect(rowOpen).toHaveAttribute('data-has-tab', 'true', { timeout: 30_000 })
    await expectNoRemoteStatusRing(rowOpen)
    await expectSidebarOrder(page, [S_OPEN, S_BUSY, S_GREY])

    // ---- Phase 4: device B drops S_OPEN's record entirely AND makes S_GREY
    // busy. S_OPEN keeps local-green (remote state for it no longer exists);
    // S_GREY becomes remote-blue. Non-vacuous local > remote > grey-touched
    // separation: without the local tier, S_OPEN (remote record gone) would
    // be grey and would sink below busy S_GREY.
    await deviceB.pushSnapshot({
      deviceId: DEVICE_B_ID,
      deviceLabel: 'E2E Device B',
      clientInstanceId: DEVICE_B_CLIENT,
      records: [buildRemoteTabRecord(S_GREY, true)],
    })
    await expectSidebarOrder(page, [S_OPEN, S_GREY, S_BUSY])
    await expectRing(rowGrey, 'busy')
    await expectNoRemoteStatusRing(rowOpen)
    await expectNoRemoteStatusRing(rowBusy)
  })
})
```

- [ ] **Step 2: Run the spec**

Run: `env -u FRESHELL_BIND_HOST npm run test:e2e:chromium -- specs/sidebar-status-tier-sort-rust.spec.ts`

Expected: PASS (1 test). First run on this worktree may build the Rust release binary inside `beforeAll` (600s hook budget; `ensureRustServerBuilt()` handles it when `FRESHELL_E2E_RUST_SERVER_BIN` is unset).

If it fails, diagnose before touching assertions: (a) does Phase 0 hold (seeding/recency)? (b) does the rings spec still pass (harness sanity)? (c) only then investigate tier/watcher code. Never weaken assertions or widen deadlines beyond the 30s-query-plus-margin model, and never drop phases to make it pass.

- [ ] **Step 3: Impacted-test verification**

Impact: one NEW spec file; no production or shared helper changes (helpers are per-file copies by suite convention). Impacted set = the new spec plus its sibling to prove no harness/config interference:

Run: `env -u FRESHELL_BIND_HOST npm run test:e2e:chromium -- specs/sidebar-status-tier-sort-rust.spec.ts specs/sidebar-remote-status-rings-rust.spec.ts`

Expected: PASS (both files green). The repo-wide gate is Task 7, not this step.

- [ ] **Step 4: Commit the task**

```bash
git add test/e2e-browser/specs/sidebar-status-tier-sort-rust.spec.ts
git commit -m "test(e2e): prove sidebar status tiers + grey-touch jump against rust server"
```

### Task 7: As-built commits for Tasks 1–5 + coordinated repo gate

**Files:**
- Commit splits only; no code changes.

- [ ] **Step 1: Focused commits for the as-built work**

```bash
git add src/store/selectors/sessionStatusTiers.ts src/store/selectors/sidebarSelectors.ts test/unit/client/store/selectors/sessionStatusTiers.test.ts test/unit/client/store/selectors/sidebarSelectors.test.ts
git commit -m "feat(sidebar): status-tier sort for default activity mode (local busy/open > remote busy/open > grey)"
git add src/store/sessionGreyTouch.ts test/unit/client/store/sessionGreyTouch.test.ts
git commit -m "feat(sidebar): touch session activity when a non-grey session goes grey"
git add src/App.tsx src/components/settings/WorkspaceSettings.tsx docs/index.html test/unit/client/components/SettingsView.behavior.test.tsx
git commit -m "feat(sidebar): wire grey-touch watcher; rename activity sort label to status-first"
```

Note: Task order per plan is commits AFTER Task 6 in git history only if executed that way; executing Task 7's commit-splitting BEFORE Task 6 is equally valid (the e2e commit is independent). Choose execution order by least risk: commit the as-built work FIRST so Task 6's file stays the only uncommitted change.

- [ ] **Step 2: Run the coordinated suite hermetically**

Run: `env -u FRESHELL_BIND_HOST npm run check`

Expected: PASS — typecheck plus the coordinated client/server/electron suites, green excluding pre-existing failures enumerated in the run baseline ledger (currently: none; a failure appearing here must reproduce at base_ref before it may be excused).

- [ ] **Step 3: Record gate result in the progress ledger**

Append the exact command, exit code, and outcome summary to the run's progress ledger under `<logs_dir>/reports/`, and update `run-state.md`.

## Self-review result

- Spec coverage: both user requirements map to production behavior — tier ordering (Tasks 1–3) and the non-grey→grey touch (Tasks 4–5). E2E proof of both in one user-level scenario: Task 6 Phases 1–4.
- No silent deferrals: no stubs/mocks/test-only seams in production code; e2e uses the real client bundle + real Rust server; only fakery is the fake `claude` CLI binary and the raw-WS device (suite-standard production-topology harness; the server cannot distinguish device B from a real second browser).
- File/interface consistency: every copied helper was verified verbatim against sidebar-remote-status-rings-rust.spec.ts in THIS worktree (imports from `../helpers/rust-server.js` incl. `.js` extension, `WS_PROTOCOL_VERSION` hello, `tabs.sync.push` + ack-count discipline, record field shape incl. `status`/`revision`/`paneCount`/`panes[].payload`, TestHarness boot via `?e2e=1`, recovery-decline overlay handling, installFakeCli local copy). Selector-side interfaces were verified against the as-built code (Tasks 1–4).
- Executable tests: phase-1/2/4 order assertions fail without the feature (documented red mode above); every poll deadline is justified against the 30s reconcile interval.
- Placeholder scan: no TBD/TODO/"later"; every command runnable as written.
- Operational completeness: `docs/index.html` mock synced (Task 5). AGENTS.md does not document sort modes — no sync required. The `FRESHELL_BIND_HOST` non-hermetic test issue is recorded as a known environment defect in the run baseline ledger, out of scope here (candidate separate change).
