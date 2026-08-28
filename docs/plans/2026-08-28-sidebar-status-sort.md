# Sidebar Status-Tier Sort Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

**Goal:** In the sidebar's default (activity) sort, coding-agent sessions sort by status tier — local-blue (busy here) first, then local-green (open here), then remote-blue (busy on another device), then remote-green (open on another device), then grey (closed everywhere) — with activity recency ordering ties inside each tier; and any session that transitions from any non-grey state to grey is "touched" (sort-activity ratchet) so it sorts at the top of the grey agents.

**Architecture:** A new memoized selector computes one tier record (`sessionKey → status tier`) by composing the existing local activity collectors (`collectBusySessionKeys`, `collectPaneIdentityActivity`, `collectSessionRefsFromTabs`) with the existing remote ring selector (`deriveRemoteSessionActivity` fields, sameDevice suppression). Default activity sort consumes that tier map: tier rank ascending, then the legacy within-tier comparator (local tiers = pure recency; remote/grey tiers = ratchet-presence-first legacy ordering, which makes grey-touches float to the top of grey). A store-level watcher compares consecutive tier snapshots and dispatches `updateSessionActivity` when a key that was non-grey becomes absent (grey transition). Sidebar rendering is unchanged.

**Tech Stack:** React 18 + Redux Toolkit (client), Vitest unit tests, Playwright e2e against an owned `RustServer` fixture (raw WebSocket device pushes for cross-device state; `fake-bel-cli.mjs` for a 6s stable local-busy window).

## Global Constraints

- Work only in `/home/dan/code/freshell/.worktrees/sidebar-status-sort`, branch `the-usual/sidebar-status-sort`, base_ref `5b8717017db793744f74d192d604d0739f1da2e1`. Never commit to or push `main`. PR creation requires explicit user approval — stop before it.
- Every vitest/playwright command MUST be prefixed `env -u FRESHELL_BIND_HOST`. Agent shells on this machine export `FRESHELL_BIND_HOST=0.0.0.0`, which non-hermetically fails `test/unit/vite-config.test.ts` (pre-existing failure, out of scope, recorded in the run baseline ledger).
- Broad suite entry point is the coordinated `npm test` (via `npm run check`); focused client suites use `npm run test:vitest -- ...`; focused e2e uses `npm run test:e2e:chromium -- <spec-path>`. `npm run lint` is a CI-required gate — include it.
- Do NOT change Sidebar render semantics (busy dot, ring visuals). Tiers and the touch watcher only affect SORTING and the sessionActivity ratchet.
- Tier logic applies only when `sortMode === 'activity'` (the default) and `disableTabPinning` is false (no active search). All other sort modes and search keep legacy paths byte-for-byte.
- Follow the a11y and lint rules in AGENTS.md for any touched UI file.
- Repo rule (user-level): assertions whose only purpose is pinning exact prose/copy text do not qualify as behavioral tests; when such an assertion blocks a copy change, DELETE that assertion line rather than updating it.

---

## Stage history note

Tasks 1–5 were implemented pre-record (before this run was adopted into the-usual discipline) with red/green TDD cycles; each task below records its as-built state, its failing-red reason, and its green receipt. Task 6 is executable work. Task 7 finishes as-built commits, integration with current origin/main, and the repo gates. Do not re-do Tasks 1–5.

Round-1 fresh-eyes findings are addressed throughout (plan rework commit): the e2e now proves a genuinely locally-discriminating assertion (new Phase 5), covers the local-busy top tier, defines all ledger paths literally, adds lint to the gate, corrects the as-built interface signatures, deletes a prose-text assertion per repo rule, cleans up its temp dirs, and adds the origin/main integration step before the gate.

### Task 1: Status-tier model + sort bucketing in `sortSessionItems` — COMPLETE (as-built)

**Files:**
- Create: `src/store/selectors/sessionStatusTiers.ts` (tier type + ranks helper)
- Modify: `src/store/selectors/sidebarSelectors.ts` (`sortSessionItems` accepts `options.statusTiers`)
- Test: `test/unit/client/store/selectors/sidebarSelectors.test.ts`

**Interfaces (verified against source):**
- `SessionStatusTier = 'local-busy' | 'local-open' | 'remote-busy' | 'remote-open'`
- `SESSION_STATUS_TIER_RANK: Record<SessionStatusTier, number>` (0..3); `GREY_STATUS_TIER_RANK = 4`
- `sessionStatusTierRank(tiers: Record<string, SessionStatusTier> | undefined, sessionKey: string): number` (absent → grey rank)
- `sortSessionItems(items: SidebarSessionItem[], sortMode: string, options?: { disableTabPinning?: boolean; statusTiers?: Record<string, SessionStatusTier> }): SidebarSessionItem[]`

**Behavior (as-built):** When `sortMode === 'activity'`, `disableTabPinning` is false, and `statusTiers` is provided: bucket each item by `sessionStatusTierRank(tierMap, `${provider}:${sessionId}`)`; tier-rank ascending; within local tiers (0–1) order by pure recency (`ratchetedActivity ?? timestamp` desc, tiebreak `provider:sessionId`); within remote/grey tiers (2–4) keep the legacy **withoutTabs** comparator (ratchet-presence first, then recency). Items absent from the tier map are grey even when `hasTab` — the producing selector owns the hasTab→tier mapping. When `statusTiers` is absent (or pinning/search/non-activity mode), the legacy path runs unchanged.

**Red reason (original):** tiers did not exist. **Green receipt:** 45/45 in the tiers describe block + full existing suite (2026-08-27).

### Task 2: `makeSelectSessionStatusTiers` memoized selector factory — COMPLETE (as-built)

**Files:** `src/store/selectors/sessionStatusTiers.ts` (factory added), `test/unit/client/store/selectors/sessionStatusTiers.test.ts` (new).

**Interfaces:** Consumes `collectBusySessionKeys`, `collectPaneIdentityActivity` (src/lib/pane-activity.ts), `collectSessionRefsFromTabs` (src/lib/session-utils.ts), `deriveRemoteSessionActivity` (tabsRegistrySelectors.ts). Produces `makeSelectSessionStatusTiers(): (state: RootState) => Record<string, SessionStatusTier>`.

**Behavior (as-built):** local-busy if key in busy set, else local-open for every local identity; remote tier from `remoteActivityBySessionKey` with sameDevice suppression (busy outranks open); local outranks remote; plain-map output for structural sharing.

**Red reason:** selector did not exist. **Green receipt:** 7/7 (2026-08-27).

### Task 3: Wire tiers into `makeSelectSortedSessionItems` — COMPLETE (as-built)

**Files:** `src/store/selectors/sidebarSelectors.ts`, `test/unit/client/store/selectors/sidebarSelectors.test.ts` (`createSelectorState` extended with `claudeActivityByTerminalId` + `remoteOpen`; new describe `makeSelectSortedSessionItems status tiers (default activity mode)`).

**Behavior (as-built):** module-scope `selectSessionStatusTiers` instance feeds `sortSessionItems` in default mode; grey-touch ordering pinned at selector level (touched grey out-orders newer pristine grey inside the grey tier).

**Red reason:** map existed but was not wired. **Green receipt:** 208 tests across 6 files (2026-08-27).

### Task 4: Grey-transition touch watcher — COMPLETE (as-built)

**Files:**
- Create: `src/store/sessionGreyTouch.ts`
- Test: `test/unit/client/store/sessionGreyTouch.test.ts` (new, 7 tests)

**Interfaces (verified against source):**
- `type MinimalStore = Pick<Store<RootState>, 'getState' | 'subscribe' | 'dispatch'>`
- `startSessionGreyTouchWatcher(store: MinimalStore): () => void` — initial tier snapshot taken at start (no retroactive touches); returns a stop handle.

**Behavior (as-built):** key present non-grey in the previous snapshot + absent in the current snapshot → `store.dispatch(updateSessionActivity({ sessionId: key, lastInputAt: Date.now() }))`. `previousTiers` assigned BEFORE dispatch (re-entrancy guard for the synchronous redispatch). `remoteOpen` persists across WS disconnect → blips never touch.

**Red reason:** watcher did not exist. **Green receipt:** 7/7 (2026-08-27).

### Task 5: App wiring + settings label sync — COMPLETE (as-built)

**Files:**
- Modify: `src/App.tsx` (watcher start after `startTabRegistrySync`; stop at both `stopTabRegistrySync?.()` sites)
- Modify: `src/components/settings/WorkspaceSettings.tsx:53` (`Activity (tabs first)` → `Activity (status first)`)
- Modify: `docs/index.html:1102` (mock synced)
- Test: `test/unit/client/components/SettingsView.behavior.test.tsx` — NOTE (round-1 finding M8): the change originally UPDATED the prose-text pin (`option[value="activity"]` textContent). Per the repo rule, that assertion must be DELETED, keeping the behavioral remainder (option presence, dispatch on change). This deletion is folded into Task 7's wiring/label commit and is part of that commit's verification.

**Green receipt (pre-deletion):** 74 tests across settings/App/watcher suites; typecheck clean.

---

### Task 6: E2E proof on the Rust server — tier ordering, local-busy top tier, grey-touch jump

**Files:**
- Create: `test/e2e-browser/specs/sidebar-status-tier-sort-rust.spec.ts`

**Interfaces:**
- Verbatim-copied helpers per suite convention from `sidebar-remote-status-rings-rust.spec.ts`: `installFakeCli`, `selectShellIfPickerShowing`, `bootAndConnect`, `declineRecoveryOfferIfShowing`, `nextMessage`, `connectRawDevice`, `buildClaudeSessionJsonl` (verbatim body, extended ONLY with `t0`/`t1` ISO params), `buildRemoteClaudeTabRecord` (verbatim body, parameterized to `(sessionId, busy)`), row/ring helpers (verbatim, parameterized to an arbitrary id). New helpers: `expectSidebarOrder`, `focusOpenSessionRow` (documented below).
- Local busy induction: type a prompt containing `slow` into the claude pane's xterm and press Enter. With `fake-bel-cli.mjs` the Rust activity engine emits provisional busy on submit and holds it ~6s (the fixture's slow-turn window) until the BEL turn-complete; proven pattern from `terminal-activity-rust.spec.ts`. The busy phase collapses again after the BEL — the order assertion polls and must observe the flipped order INSIDE that window.

**Red mode (pre-feature), per phase:**
- Phase 1 fails: legacy sort ignores remote state; order stays `[S_GREY, S_BUSY, S_OPEN]`.
- Phase 2 fails: no watcher + no tiers → order stays recency `[S_GREY, S_BUSY, S_OPEN]`.
- Phase 5 fails: legacy hasTab-first-with-recency keeps `[S_GREY, S_OPEN, S_BUSY]` for the two open tabs; only the tier-0 vs tier-1 rank flips busy S_OPEN above newer S_GREY.
- Phases 3/4 are stability guards (both orders agree) — they exist so Phase 5's discriminator is reached in a controlled state.

- [ ] **Step 1: Create the behavioral spec**

Create the file with EXACTLY this content:

```ts
/**
 * Sidebar status-tier sort (default activity mode) — E2E pin of cross-device
 * tier ordering, local-busy top tier, and the non-grey→grey "touch" jump,
 * against the REAL Rust server. Sibling of
 * sidebar-remote-status-rings-rust.spec.ts; same raw-WS second-device harness
 * (helpers copied VERBATIM per suite convention), same push discipline
 * (monotonic snapshotRevision, sequential pushes, exact ack-count match),
 * same 30s-query liveness model for REMOTE-driven assertions (poll ≤45s).
 * LOCAL assertions (row clicks, busy induction) are store-driven and far
 * faster; their polls use shorter deadlines accordingly.
 *
 * Scenario (single serial test; the page is device A):
 * - Phase 0: three seeded claude sessions, all grey → pure activity recency
 *   newest→oldest (S_GREY, S_BUSY, S_OPEN; seeded timestamps control it —
 *   the indexer's last_activity_at comes from message timestamps,
 *   parse/claude.rs).
 * - Phase 1: device B pushes S_OPEN open (remote-green) + S_BUSY busy
 *   (remote-blue) → tier order beats raw recency: [S_BUSY, S_OPEN, S_GREY].
 *   NON-VACUOUS: legacy would stay [S_GREY, S_BUSY, S_OPEN].
 * - Phase 2: device B drops S_BUSY (remote-busy → grey) → the transition
 *   "touch" ratchets S_BUSY ABOVE pristine-grey S_GREY despite S_GREY's
 *   newer timestamp: [S_OPEN, S_BUSY, S_GREY]. NON-VACUOUS: without the
 *   watcher (and without tiers), recency keeps [S_GREY, S_BUSY, S_OPEN].
 * - Phase 3: click S_OPEN locally → local-green; ring suppressed;
 *   data-has-tab="true" awaited. Stability step: order stays
 *   [S_OPEN, S_BUSY, S_GREY].
 * - Phase 4: click S_GREY locally → local-green for both. Pure recency
 *   inside tier 1 puts the newer S_GREY first: [S_GREY, S_OPEN, S_BUSY].
 *   Stability step (legacy agrees).
 * - Phase 5: focus S_OPEN's tab (its sidebar row click focuses the existing
 *   tab — Sidebar.tsx handleTabSessionClick existing-branch), type a `slow`
 *   prompt + Enter into its xterm → provisional local-busy for ~6s
 *   (fake-bel-cli.mjs slow-turn). Tier 0 outranks tier 1 despite S_GREY's
 *   NEWER timestamp: [S_OPEN, S_GREY, S_BUSY]. NON-VACUOUS: legacy
 *   hasTab-first-recency keeps [S_GREY, S_OPEN, S_BUSY]. The order poll is
 *   allowed only 20s and MUST catch the flip inside the ~6s busy window.
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

// Copied VERBATIM from sidebar-remote-status-rings-rust.spec.ts. Handshake:
// bare ws:// connect then in-band {type:'hello', token, protocolVersion} →
// ready. pushSnapshot assigns monotonically increasing snapshotRevision and
// awaits the matching ack (accepted + open/closed record counts).
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

const S_OPEN = randomUUID() // oldest; remote-open in P1, clicked open locally in P3, made locally-BUSY in P5
const S_BUSY = randomUUID() // middle; remote-busy in P1, dropped to grey (touch) in P2
const S_GREY = randomUUID() // newest; pristine grey until clicked open locally in P4

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
 * interval + margin); local store-driven phases pass ~15s.
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
  let sharedRoot = ''
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
    const binDir = path.join(sharedRoot, 'bin')
    // fake-bel-cli (same fixture terminal-activity-rust.spec.ts uses): prints
    // a prompt, stays running, rings BEL after each stdin "turn" — a `slow`
    // prompt holds busy ~6s (stable flip window for the Phase-5 poll); a
    // plain fake-claude-cli gives no controlled busy window.
    const fakeClaude = await installFakeCli(binDir, 'claude', 'fake-bel-cli.mjs')
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
          buildClaudeSessionJsonl(S_OPEN, PROJECT_DIR, 'Status tier: local busy flip', S_OPEN_T0, S_OPEN_T1),
        )
        await fs.writeFile(
          path.join(projDir, `${S_BUSY}.jsonl`),
          buildClaudeSessionJsonl(S_BUSY, PROJECT_DIR, 'Status tier: grey touch jump', S_BUSY_T0, S_BUSY_T1),
        )
        await fs.writeFile(
          path.join(projDir, `${S_GREY}.jsonl`),
          buildClaudeSessionJsonl(S_GREY, PROJECT_DIR, 'Status tier: local open control', S_GREY_T0, S_GREY_T1),
        )
      },
    })
    info = await server.start()
    deviceB = await connectRawDevice(info.wsUrl, info.token)
  })

  test.afterAll(async () => {
    deviceB?.close()
    await server?.stop()
    // The RustServer fixture removes only its isolated HOME; the shared fake
    // root and the fixed PROJECT_DIR are this spec's own litter (round-1
    // fresh-eyes finding). recursive+force: prior partial runs must not fail
    // the suite.
    await fs.rm(sharedRoot, { recursive: true, force: true })
    await fs.rm(PROJECT_DIR, { recursive: true, force: true })
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
    // recency: [remote-busy, remote-open, grey].
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

    // Phase 3 — open S_OPEN locally (fake bel CLI runs it). Local-green;
    // ring suppressed (local wins); data-has-tab awaited so the local tier
    // is registered before Phase 4. Stability: order unchanged.
    await rowOpen.click()
    await expect(rowOpen).toHaveAttribute('data-has-tab', 'true', { timeout: 30_000 })
    await expectNoRemoteStatusRing(rowOpen)
    await expectSidebarOrder(page, [S_OPEN, S_BUSY, S_GREY])

    // Phase 4 — ALSO open S_GREY locally. Both local-green; pure recency
    // inside tier 1 puts the newer S_GREY first. Stability guard before the
    // discriminating Phase 5 (legacy hasTab-first agrees here).
    await rowGrey.click()
    await expect(rowGrey).toHaveAttribute('data-has-tab', 'true', { timeout: 30_000 })
    await expectNoRemoteStatusRing(rowGrey)
    await expectSidebarOrder(page, [S_GREY, S_OPEN, S_BUSY])

    // Phase 5 — focus S_OPEN's existing tab via its sidebar row (clicking an
    // OPEN session row focuses the tab; it does not duplicate). Type a
    // `slow` prompt + Enter into its xterm: provisional local-busy holds
    // ~6s before the BEL turn completes. Tier 0 must beat tier 1 despite
    // S_GREY's NEWER timestamp — legacy recency would keep
    // [S_GREY, S_OPEN, S_BUSY], so catching [S_OPEN, S_GREY, S_BUSY] inside
    // the busy window is the local-busy discriminator. Poll deadline 20s
    // covers many polling attempts inside the 6s window; a miss means the
    // flip never rendered (a REAL failure), not a slow query.
    await rowOpen.click() // focuses the existing S_OPEN tab
    const xterm = page.locator('.xterm:visible').first()
    await xterm.click()
    await page.keyboard.type('slow: local-busy tier flip')
    await page.keyboard.press('Enter')
    await expectSidebarOrder(page, [S_OPEN, S_GREY, S_BUSY], 20_000)
  })
})
```

- [ ] **Step 2: Run the spec**

Run: `env -u FRESHELL_BIND_HOST npm run test:e2e:chromium -- specs/sidebar-status-tier-sort-rust.spec.ts`

Expected: PASS (1 test). First run in this worktree may compile the Rust release server inside `beforeAll` (600s hook budget). If it fails, diagnose per phase (the plan's phase comments explain each expected state); never weaken assertions, widen deadlines, or drop phases.

- [ ] **Step 3: Impacted-test verification**

Impacted set = the new spec plus its sibling (proves no harness/config interference):

Run: `env -u FRESHELL_BIND_HOST npm run test:e2e:chromium -- specs/sidebar-status-tier-sort-rust.spec.ts specs/sidebar-remote-status-rings-rust.spec.ts`

Expected: PASS (both files green). The repo-wide gate is Task 7, not this step.

- [ ] **Step 4: Commit the task**

```bash
git add test/e2e-browser/specs/sidebar-status-tier-sort-rust.spec.ts
git commit -m "test(e2e): prove sidebar status tiers, grey-touch jump, and local-busy top tier against rust server"
```

### Task 7: As-built commits, prose-pin deletion, origin/main integration, gates

**Files:** commit splits + one 1-line test deletion; no new code.

- [ ] **Step 1: Delete the prose-text label assertion (round-1 finding M8)**

In `test/unit/client/components/SettingsView.behavior.test.tsx` (the sortMode test around line 221–225), DELETE this line:

```ts
      expect(sortModeSelect.querySelector('option[value="activity"]')?.textContent).toBe('Activity (status first)')
```

and keep the behavioral remainder (option presence, change dispatch). Verify: `env -u FRESHELL_BIND_HOST npm run test:vitest -- run test/unit/client/components/SettingsView.behavior.test.tsx` → PASS.

- [ ] **Step 2: Focused commits for the as-built work**

```bash
git add src/store/selectors/sessionStatusTiers.ts src/store/selectors/sidebarSelectors.ts test/unit/client/store/selectors/sessionStatusTiers.test.ts test/unit/client/store/selectors/sidebarSelectors.test.ts
git commit -m "feat(sidebar): status-tier sort for default activity mode (local busy/open > remote busy/open > grey)"
git add src/store/sessionGreyTouch.ts test/unit/client/store/sessionGreyTouch.test.ts
git commit -m "feat(sidebar): touch session activity when a non-grey session goes grey"
git add src/App.tsx src/components/settings/WorkspaceSettings.tsx docs/index.html test/unit/client/components/SettingsView.behavior.test.tsx
git commit -m "feat(sidebar): wire grey-touch watcher; rename activity sort label to status-first"
```

Verify `git status` clean afterwards. (Task 6's spec file may already be committed if Task 6 executed first — either order is valid; do not interleave files between these commits.)

- [ ] **Step 3: Integrate current origin/main before the gate**

origin/main has advanced beyond base_ref (it was `6c541bec6` at plan-rework time, ~35 commits ahead of `5b8717017`, touching src/App.tsx and the playwright config this work relies on). Merge it into the branch (merge commit — keeps base_ref semantics and the review trail), resolve conflicts conservatively (always prefer the union of behaviors: my watcher wiring + upstream App.tsx changes; never drop upstream work), then re-verify focused suites touched by the conflict surface:

Run: `git fetch origin && git merge origin/main --no-edit` then
Run: `env -u FRESHELL_BIND_HOST npm run test:vitest -- run test/unit/client/components/App.ws-bootstrap.test.tsx test/unit/client/store/selectors/sidebarSelectors.test.ts test/unit/client/store/selectors/sessionStatusTiers.test.ts test/unit/client/store/sessionGreyTouch.test.ts`

Expected: merge completes; suites PASS. If a conflict resolution changes behavior, re-run the coordinating focused suites plus `npm run typecheck` before the gate.

- [ ] **Step 4: Lint + coordinated suite gate**

Run: `env -u FRESHELL_BIND_HOST npm run lint`
Expected: 0 errors (warnings acceptable only if pre-existing at base_ref — check with `git stash`-free comparison via base worktree receipts only if a new warning appears).

Run: `env -u FRESHELL_BIND_HOST npm run check`
Expected: PASS — typecheck + coordinated client/server/electron suites, green excluding pre-existing failures enumerated in the run baseline ledger (currently none; a failure must reproduce at base_ref before it may be excused).

- [ ] **Step 5: Record gate results**

Append exact commands, exit codes, and outcome summaries to the progress ledger at `/home/dan/code/freshell/.git/worktrees/sidebar-status-sort/usual-sdd/progress.md` (resolve via `git rev-parse --git-dir` if moved), plus reports under `/home/dan/code/freshell/.worktrees/.the-usual-logs/sidebar-status-sort/reports/`, and update `/home/dan/code/freshell/.worktrees/.the-usual-logs/sidebar-status-sort/run-state.md`.

## Self-review result

- Spec coverage: both user requirements (tier ordering; non-grey→grey touch) map to production behavior (Tasks 1–5) and user-level e2e proof (Task 6, phases 1, 2, 5 discriminating; 3/4 stability). Task 7 includes origin/main integration + lint + coordinated gate, matching repo requirements.
- No silent deferrals: no stubs/seams in production; e2e uses real client bundle + real Rust server; only fakery = fake CLI fixture + raw-WS device (suite-standard).
- File/interface consistency: interfaces re-verified against source (round-1 corrections applied: `sortSessionItems(items, sortMode, options)`, `sessionStatusTierRank(tiers, key)`, `MinimalStore` includes `dispatch`); e2e helpers verified verbatim against the rings spec donor; Sidebar.tsx existing-tab focus branch (handleTabSessionClick existing-dispatch) verified for the Phase-5 focus step; `fake-bel-cli.mjs` slow-turn semantics verified from the fixture source; claude activity provisional-busy window verified from crates/freshell-activity/src/claude.rs + terminal-activity-rust precedent.
- Executable tests: per-phase red modes documented; the plan-embedded code block is intended verbatim (no corrections needed at materialization).
- Placeholder scan: after rework, no TBD/TODO/"later"; `<logs_dir>`-style placeholders replaced with literal absolute paths.
- Operational completeness: e2e cleans its temp dirs (sharedRoot + PROJECT_DIR); docs mock synced (Task 5); prose-pin deletion folded into Task 7.
