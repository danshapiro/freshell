/**
 * AUTO-RESTORE-WARMING (kata vnpc) acceptance e2e: parked panes restore with
 * ZERO user interaction once the session index publishes, and the warming
 * banner always clears itself. The deterministic cold window comes from
 * FRESHELL_TEST_SESSION_INDEX_STARTUP_HOLD_MS (plan Task 3): the server
 * holds every first-publish entry behind the startup gate for that many ms,
 * so a reconcile landing inside the window answers error{index_warming}
 * (the pane PARKS behind the warming banner) and the readiness broadcast
 * then fires at a known time. No page.click on "Retry now" anywhere in this
 * spec — the automatic recovery IS the assertion.
 *
 * DURABLE-PARK MECHANICS (delta fix, finding 3): the natural pane class
 * whose park SURVIVES the cold window is an OPEN pane whose CLI session
 * EXITED before the restart (the exit fold clears terminalId but RETAINS
 * sessionRef + createRequestId + status 'exited'). A running pane's park
 * is transient — TerminalView's INVALID_TERMINAL_ID reconnect recovery
 * resumes it ~1s after the fold and RE-KEYS the pane (a new
 * createRequestId), so the driver's identity guard clears the park without
 * ever re-driving (tests 2 and 4 exercise that lane). An EXITED pane has no
 * self-recovery lane (the INVALID_TERMINAL_ID gate requires a live attach
 * and a non-exited status), so it STAYS PARKED through the whole hold —
 * and at readiness the ReconcileWarmingRecoveryDriver's re-drive is the
 * ONE thing that moves it:
 *   - test 1 (codex, readable store): the parked pane is resumed by its own
 *     un-anchored create lane mid-park (same createRequestId — the park
 *     survives, the pane becomes usable while the banner honestly waits),
 *     and the readiness re-drive derives `attach` onto the live terminal.
 *   - test 3 (opencode, unreadable store): the resumed CLI dies on the
 *     unreadable store (a directory at opencode.db — the faithful fake
 *     mirrors the real CLI's startup failure), the server's own bounded
 *     crash-retry churn settles, and the readiness re-drive derives the
 *     honest error{session_store_unreadable} — the per-pane restoreError,
 *     the visible in-buffer explanation line, and a cleared banner.
 *
 * The unreadable-store case seeds a DIRECTORY at
 * <isolated data home>/opencode/opencode.db: SQLite open fails on a
 * directory for any euid, so the opencode by-id locator answers Unreadable
 * (cold => Unknown => the pane parks; warm => the honest
 * error{session_store_unreadable}).
 *
 * Like reconcile-client-adoption-rust.spec.ts (the bootAdoption donor), this
 * spec constructs its OWN RustServer({env}) — the hold env must reach the
 * spawned server, so the worker-scoped fixture server (freshellPage /
 * serverInfo) is never used. One graceful server.restart() per test, no
 * restartAbrupt(), no kill storms (the sandbox classification recorded in
 * the plan).
 *
 * Helpers are copied, not imported, per the e2e suite's per-spec-ownership
 * convention (donor: reconcile-client-adoption-rust.spec.ts).
 */
import { test, expect } from '../helpers/fixtures.js'
import { RustServer } from '../helpers/rust-server.js'
import type { E2eServerInfo } from '../helpers/server-fixture-support.js'
import { TestHarness } from '../helpers/test-harness.js'
import { installDualRoleCodexCli } from '../fixtures/codex-dual-role'
import { openPanePicker } from '../helpers/pane-picker.js'
import type { Page } from '@playwright/test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const FAKE_CODEX_CLI_SOURCE = path.resolve(__dirname, '../fixtures/fake-codex-cli.mjs')
const FAKE_OPENCODE_TERMINAL_SOURCE = path.resolve(
  __dirname,
  '../fixtures/fake-opencode-terminal.mjs',
)

// The deterministic cold window. Readiness fires ~HOLD_MS after each boot,
// so a reconnecting client's first reconcile (the server's single 2s
// bounded deferral included) answers warming well inside the window. The
// first boot's own publish is held too, so a seeded sidebar row appears
// only after that first readiness — every wait below is sized for it.
// Tests 1/2/4 use the default; test 3 (the unreadable store) uses a LONGER
// hold so the server's own bounded crash-retry churn (the resumed fake CLI
// dies on the unreadable store; auto-resume retries 2x with backoff)
// settles well before readiness and the re-drive derives the honest error
// against a deterministically dead pane.
const HOLD_MS = 15_000
const UNREADABLE_HOLD_MS = 30_000

// ---------------------------------------------------------------------------
// Shared helpers (per-spec copies -- see file doc comment)
// ---------------------------------------------------------------------------

/** Copy a fixture into <binDir>/<binName> and make it executable. */
async function installFakeCli(source: string, binName: string, binDir: string): Promise<string> {
  await fs.mkdir(binDir, { recursive: true })
  const target = path.join(binDir, binName)
  await fs.copyFile(source, target)
  await fs.chmod(target, 0o755)
  return target
}

/** Read a fake CLI's argv-log JSONL (empty array if not yet written). */
async function readArgvLog(logPath: string): Promise<Array<{ argv: string[] }>> {
  const raw = await fs.readFile(logPath, 'utf8').catch(() => '')
  if (!raw) return []
  return raw.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as { argv: string[] })
}

/** True when argv contains the adjacent pair `<flag> <value>` (codex `resume <id>`). */
function hasFlagPair(argv: string[], flag: string, value: string): boolean {
  const idx = argv.indexOf(flag)
  return idx >= 0 && argv[idx + 1] === value
}

/** Dismiss the initial pane-type picker by choosing the first visible shell. */
async function selectShellIfPickerShowing(page: Page): Promise<void> {
  const picker = page.getByRole('toolbar', { name: /pane type picker/i }).last()
  if (!(await picker.isVisible().catch(() => false))) return
  for (const name of ['Shell', 'WSL', 'CMD', 'PowerShell', 'Bash']) {
    const option = picker.getByRole('button', { name: new RegExp(`^${name}$`, 'i') })
    if (await option.isVisible().catch(() => false)) {
      await option.click({ force: true })
      return
    }
  }
}

/** Poll the in-page harness until the WS transport reports 'ready'. */
async function waitForWsReady(page: Page, timeoutMs = 60_000): Promise<void> {
  await expect(async () => {
    const status = await page.evaluate(
      () => (window as any).__FRESHELL_TEST_HARNESS__?.getWsReadyState(),
    )
    expect(status).toBe('ready')
  }).toPass({ timeout: timeoutMs })
}

/** Force the persistence middleware to write localStorage NOW. */
async function flushPersistence(page: Page): Promise<void> {
  await page.evaluate(() => {
    ;(window as any).__FRESHELL_TEST_HARNESS__?.dispatch({ type: 'persist/flushNow' })
  })
}

/** The ONE warming banner (role=status, donor text pinned by the banner component). */
function warmingBanner(page: Page) {
  return page.getByRole('status').filter({ hasText: /Waiting for session index/i }).first()
}

function paneKeyOf(tabId: string, paneId: string): string {
  return `${tabId}:${paneId}`
}

/**
 * Install a page-side banner observer BEFORE a restart: sets
 * window.__warmingBannerSeen the moment a "Waiting for session index"
 * role=status element is EVER mounted. The park is transient (see the file
 * doc comment), so a Playwright-side visibility poll could miss a
 * sub-second banner; a MutationObserver samples at DOM-mutation time and
 * can never miss it.
 */
async function observeWarmingBanner(page: Page): Promise<void> {
  await page.evaluate(() => {
    ;(window as any).__warmingBannerSeen = false
    const seen = () => {
      for (const el of Array.from(document.querySelectorAll('[role="status"]'))) {
        if (/Waiting for session index/i.test(el.textContent ?? '')) {
          ;(window as any).__warmingBannerSeen = true
          return
        }
      }
    }
    seen()
    new MutationObserver(seen).observe(document.body, {
      childList: true,
      subtree: true,
      characterData: false,
    })
  })
}

async function warmingBannerWasSeen(page: Page): Promise<boolean> {
  return page.evaluate(() => (window as any).__warmingBannerSeen === true)
}

/**
 * Durable park witness: the pane.reconcile.result the SERVER sent for this
 * pane carries error{index_warming} naming the pane's own key. The
 * harness's received-WS ring retains it regardless of how fast the pane
 * then moved on.
 */
async function witnessedWarmingVerdict(
  harness: TestHarness,
  tabId: string,
  paneId: string,
): Promise<boolean> {
  const received = await harness.getReceivedWsMessages()
  const key = paneKeyOf(tabId, paneId)
  return received.some((m: any) =>
    m?.type === 'pane.reconcile.result'
    && Array.isArray(m?.verdicts)
    && m.verdicts.some(
      (v: any) =>
        v?.verdict === 'error' && v?.reason === 'index_warming' && v?.paneKey === key,
    ))
}

/**
 * The readiness-broadcast witness: the server's once-per-boot
 * sessions.index.ready frame reached this client (the real client
 * negotiated sessionIndexReadyV1, so the frame is capability-gated IN, not
 * synthesized).
 */
async function witnessedReadinessBroadcast(harness: TestHarness): Promise<boolean> {
  const received = await harness.getReceivedWsMessages()
  return received.some((m: any) => m?.type === 'sessions.index.ready')
}

/** Count of pane.reconcile.requests THIS client sent naming the pane's key. */
async function sentReconcileRequestCount(
  harness: TestHarness,
  tabId: string,
  paneId: string,
): Promise<number> {
  const sent = await harness.getSentWsMessages()
  const key = paneKeyOf(tabId, paneId)
  return sent.filter((m: any) =>
    m?.type === 'pane.reconcile.request'
    && Array.isArray(m?.panes)
    && m.panes.some((p: any) => p?.paneKey === key),
  ).length
}

/**
 * The DRIVER's re-drive verdict witness: a received pane.reconcile.result
 * carrying a NON-warming verdict (attach/respawn/…) for the pane's key —
 * the boot reconcile already answered error{index_warming}, so a later
 * result with a resolution verdict is the readiness-driven re-drive's own
 * round-trip.
 */
async function witnessedResolutionVerdict(
  harness: TestHarness,
  tabId: string,
  paneId: string,
): Promise<boolean> {
  const received = await harness.getReceivedWsMessages()
  const key = paneKeyOf(tabId, paneId)
  return received.some((m: any) =>
    m?.type === 'pane.reconcile.result'
    && Array.isArray(m?.verdicts)
    && m.verdicts.some(
      (v: any) => v?.paneKey === key && v?.verdict !== 'error',
    ))
}

/**
 * The DRIVER's re-drive honest-error witness: a received
 * pane.reconcile.result carrying error{session_store_unreadable} for the
 * pane's key (the boot reconcile answered error{index_warming} — the warm
 * index's Unreadable answer is the re-drive's).
 */
async function witnessedUnreadableVerdict(
  harness: TestHarness,
  tabId: string,
  paneId: string,
): Promise<boolean> {
  const received = await harness.getReceivedWsMessages()
  const key = paneKeyOf(tabId, paneId)
  return received.some((m: any) =>
    m?.type === 'pane.reconcile.result'
    && Array.isArray(m?.verdicts)
    && m.verdicts.some(
      (v: any) =>
        v?.verdict === 'error'
        && v?.reason === 'session_store_unreadable'
        && v?.paneKey === key,
    ))
}

/**
 * Codex home seed (donor: reconcile-client-adoption-rust.spec.ts's
 * seedCodexAdoptionHome): wizard-bypass config with codex enabled PLUS
 * ~/.codex/sessions fixture transcripts, PLUS the claude provider ROOT
 * without transcripts (a missing claude root would make the claude cold
 * answer provider_unavailable — the root's presence keeps the provider set
 * honest for the index's five-provider watch). setupHome re-runs on every
 * boot/restart, so the fixtures are written ONLY when the sessions dir is
 * first created — a restart must not resurrect test-deleted state.
 */
function seedCodexWarmingHome(
  sessions: Array<{ id: string; title: string }>,
  projectDir: string,
): (homeDir: string) => Promise<void> {
  return async (homeDir: string) => {
    const freshellDir = path.join(homeDir, '.freshell')
    await fs.mkdir(freshellDir, { recursive: true })
    await fs.writeFile(
      path.join(freshellDir, 'config.json'),
      JSON.stringify(
        {
          version: 1,
          settings: { codingCli: { enabledProviders: ['codex'] } },
        },
        null,
        2,
      ),
    )
    // Provider-root presence for claude (no transcripts — nothing to list).
    await fs.mkdir(path.join(homeDir, '.claude', 'projects', 'auto-restore-warming-proj'), {
      recursive: true,
    })
    const sessionsDir = path.join(homeDir, '.codex', 'sessions')
    const dirExists = await fs.access(sessionsDir).then(
      () => true,
      () => false,
    )
    if (dirExists) return
    await fs.mkdir(sessionsDir, { recursive: true })
    for (const s of sessions) {
      const lines = [
        JSON.stringify({
          timestamp: '2026-11-01T08:00:00.000Z',
          type: 'session_meta',
          payload: { id: s.id, cwd: projectDir },
        }),
        JSON.stringify({
          timestamp: '2026-11-01T08:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: `${s.title} request 1` }],
          },
        }),
        JSON.stringify({
          timestamp: '2026-11-01T08:00:02.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: `${s.title} reply 1` }],
          },
        }),
      ]
      await fs.writeFile(path.join(sessionsDir, `${s.id}.jsonl`), `${lines.join('\n')}\n`)
    }
  }
}

/**
 * Open a seeded codex session from the sidebar history (opens in a NEW tab;
 * the resume create records a durable pane-ledger binding, so 'ever
 * observed' survives a restart). Returns the pane's tab + leaf ids once the
 * pane is live with the expected sessionRef.
 *
 * DONOR: reconcile-client-adoption-rust.spec.ts's openSeededCodexSession
 * (ebp6-hardened), MINUS its manual-retry helper: this spec's whole point
 * is that recovery needs no "Retry now" click, so no poll body here may
 * click anything. The row wait is SESSION-ID-scoped and generous (the
 * first boot's own index publish is held HOLD_MS too, so the row appears
 * only after that first readiness).
 */
async function openSeededCodexSession(
  page: Page,
  harness: TestHarness,
  sessionId: string,
): Promise<{ tabId: string; leafId: string }> {
  const sessionItem = page.locator(
    `[data-context="sidebar-session"][data-session-id="${sessionId}"]`,
  )
  await expect(sessionItem).toBeVisible({ timeout: 45_000 })
  const tabCountBefore = await harness.getTabCount()
  await sessionItem.click()
  await expect(async () => {
    expect(await harness.getTabCount()).toBe(tabCountBefore + 1)
  }).toPass({ timeout: 20_000 })
  const tabId = (await harness.getActiveTabId())!
  const leafId: string = await expect
    .poll(async () => {
      const layout = await harness.getPaneLayout(tabId)
      const leaf = findLeavesByMode(layout, 'codex').find(
        (l) => l?.content?.terminalId && l?.content?.sessionRef?.sessionId === sessionId,
      )
      return leaf?.id ?? null
    }, { timeout: 30_000 })
    .not.toBeNull()
    .then(async () => {
      const layout = await harness.getPaneLayout(tabId)
      return findLeavesByMode(layout, 'codex').find(
        (l) => l?.content?.sessionRef?.sessionId === sessionId,
      )!.id
    })
  return { tabId, leafId }
}

/**
 * Boot an owned RustServer WITH the deterministic hold, navigate the base
 * page fixture, and wait for harness + WS (donor: the adoption spec's
 * bootAdoption — NEVER freshellPage/serverInfo, whose worker-scoped server
 * never sees the hold env).
 */
async function bootWithHold(
  page: Page,
  options: {
    env?: Record<string, string>
    setupHome?: (homeDir: string) => Promise<void>
    holdMs?: number
  } = {},
): Promise<{ server: RustServer; info: E2eServerInfo; harness: TestHarness }> {
  const server = new RustServer({
    env: {
      ...options.env,
      FRESHELL_TEST_SESSION_INDEX_STARTUP_HOLD_MS: String(options.holdMs ?? HOLD_MS),
    },
    setupHome: options.setupHome,
  })
  const info = await server.start()
  await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
  const harness = new TestHarness(page)
  await harness.waitForHarness()
  await harness.waitForConnection()
  return { server, info, harness }
}

// --- layout tree walkers (donor: reconcile-client-adoption-rust.spec.ts) ---

function collectLeaves(node: any): any[] {
  if (!node) return []
  if (node.type === 'leaf') return [node]
  if (node.type === 'split') return (node.children ?? []).flatMap(collectLeaves)
  return []
}

function findLeavesByMode(layout: any, mode: string): any[] {
  return collectLeaves(layout).filter((leaf) => leaf?.content?.mode === mode)
}

/** Every terminal-pane leaf across every tab layout. */
async function allTerminalLeaves(harness: TestHarness): Promise<any[]> {
  const state = await harness.getState()
  const layouts = state?.panes?.layouts ?? {}
  const leaves: any[] = []
  for (const layout of Object.values(layouts)) {
    leaves.push(...collectLeaves(layout).filter((l) => l?.content?.kind === 'terminal'))
  }
  return leaves
}

/** Look up a single leaf by pane id in a tab's current layout. */
async function findLeafById(harness: TestHarness, tabId: string, paneId: string): Promise<any> {
  const layout = await harness.getPaneLayout(tabId)
  return collectLeaves(layout).find((leaf) => leaf.id === paneId) ?? null
}

// --- REST directory helper (donor: reconcile-client-adoption-rust.spec.ts) ---

async function listTerminals(
  info: E2eServerInfo,
): Promise<Array<{ terminalId: string; mode: string; status: string; sessionRef?: { provider: string; sessionId: string } }>> {
  const res = await fetch(`${info.baseUrl}/api/terminals`, {
    headers: { 'x-auth-token': info.token },
  })
  expect(res.ok).toBe(true)
  return (await res.json()) as Array<{
    terminalId: string
    mode: string
    status: string
    sessionRef?: { provider: string; sessionId: string }
  }>
}

/**
 * The client-side session-index readiness flag (Task 5's fold of the ready
 * frame's sessionIndexReady + the sessions.index.ready broadcast). Used to
 * wait out the deterministic hold without any wall-clock sleep.
 */
async function waitForSessionIndexReady(harness: TestHarness, timeoutMs = 60_000): Promise<void> {
  await expect
    .poll(async () => {
      const state = await harness.getState()
      return state?.connection?.sessionIndexReady === true
    }, { timeout: timeoutMs })
    .toBe(true)
}

/**
 * STABLE-COUNT settle (donor: restore-contract-wall-rust.spec.ts /
 * reconcile-completion-rust.spec.ts): sample, wait >=5s, sample again, and
 * accept only when the two samples agree — a tail-latency straggler can
 * never make the final read pass spuriously. Returns the settled count.
 */
async function stableCount(count: () => Promise<number>, settleMs = 5_000): Promise<number> {
  await expect
    .poll(
      async () => {
        const first = await count()
        await new Promise((resolve) => setTimeout(resolve, settleMs))
        const second = await count()
        return second === first ? second : null
      },
      { timeout: 90_000 },
    )
    .not.toBeNull()
  return count()
}

// ---------------------------------------------------------------------------
// The scenarios
// ---------------------------------------------------------------------------

test.describe('reconcile auto-restore warming (rust server, zero interaction)', () => {
  test.setTimeout(240_000)

  test('slow index: an exited codex pane stays parked, then restores at readiness through the driver re-drive — zero interaction', async ({
    page,
  }) => {
    const CODEX_SESSION_ID = 'bbbbbbbb-cccc-4ddd-8eee-000000000001'
    const CODEX_SESSION_TITLE = 'auto-restore warming codex session'
    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-warming-park-'))
    const projectDir = path.join(sharedRoot, 'project')
    await fs.mkdir(projectDir, { recursive: true })
    const argLogPath = path.join(sharedRoot, 'codex-argv.jsonl')
    // Dual-role shim: the codex lane may boot a `codex app-server` sidecar
    // from the same CODEX_CMD; terminal argv execs the fake terminal CLI,
    // which mirrors its argv to FAKE_CODEX_ARGV_LOG (forced through
    // terminalEnv so the log always reaches the terminal role).
    const fakeCodexPath = await installDualRoleCodexCli(
      path.join(sharedRoot, 'bin'),
      FAKE_CODEX_CLI_SOURCE,
      { FAKE_CODEX_ARGV_LOG: argLogPath },
    )
    const { server, harness, info } = await bootWithHold(page, {
      env: {
        CODEX_CMD: fakeCodexPath,
        FAKE_CODEX_ARGV_LOG: argLogPath,
        // Plain-CLI codex launches (kata cnwc precedent,
        // codex-terminal-restore-rust.spec.ts:181): under the managed
        // app-server plan the resumed TUI argv never carries the plain
        // `resume <id>` pair this spec asserts; the plain-CLI contract is
        // what fake-codex-cli.mjs speaks.
        FRESHELL_CODEX_MANAGED_LAUNCH: '0',
      },
      setupHome: seedCodexWarmingHome(
        [{ id: CODEX_SESSION_ID, title: CODEX_SESSION_TITLE }],
        projectDir,
      ),
    })
    try {
      // 1. Boot SPA: a shell pane (the boot picker) plus the seeded codex
      //    session opened from the sidebar (a resume create: the pane
      //    carries sessionRef codex:<id> and a durable ledger binding).
      await selectShellIfPickerShowing(page)
      const shellTabId = (await harness.getActiveTabId())!
      await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })
      const shellLeaf = collectLeaves(await harness.getPaneLayout(shellTabId)).find(
        (l) => l?.content?.mode === 'shell',
      )!
      expect(shellLeaf).toBeTruthy()
      const shellTerminalIdBefore: string = await expect
        .poll(
          async () => (await findLeafById(harness, shellTabId, shellLeaf.id))?.content?.terminalId ?? null,
          { timeout: 20_000 },
        )
        .not.toBeNull()
        .then(async () => (await findLeafById(harness, shellTabId, shellLeaf.id))!.content.terminalId)

      const codexPane = await openSeededCodexSession(page, harness, CODEX_SESSION_ID)
      const codexTerminalIdBefore: string = await expect
        .poll(
          async () => (await findLeafById(harness, codexPane.tabId, codexPane.leafId))?.content?.terminalId ?? null,
          { timeout: 20_000 },
        )
        .not.toBeNull()
        .then(async () => (await findLeafById(harness, codexPane.tabId, codexPane.leafId))!.content.terminalId)

      // 2. EXIT the CLI session (the fake's exit affordance): the exit
      //    fold clears the terminalId but RETAINS the session identity —
      //    the OPEN-pane-with-no-process shape whose park survives a
      //    restart (see the file doc comment). A clean exit never
      //    auto-resumes.
      await page.locator(`[data-context="pane"][data-pane-id="${codexPane.leafId}"]`).click()
      await page.keyboard.type('exit')
      await page.keyboard.press('Enter')
      await expect
        .poll(async () => {
          const l = await findLeafById(harness, codexPane.tabId, codexPane.leafId)
          return l?.content?.status === 'exited' && !l?.content?.terminalId ? 'exited' : null
        }, { timeout: 20_000 })
        .toBe('exited')

      await flushPersistence(page)
      const leavesBefore = await allTerminalLeaves(harness)
      const tabCountBefore = await harness.getTabCount()
      const argvCountBeforeRestart = (await readArgvLog(argLogPath)).length

      // 3. Graceful restart (the ONE this test uses); the live client's WS
      //    reconnects inside the cold window and reconciles on the new
      //    ready. The shell pane has no index identity (fresh verdict, live
      //    again immediately); the exited codex pane's provider answers
      //    Unknown while cold (AD-4: codex has no cold by-id locator), so
      //    the verdict is error{index_warming} and the pane PARKS —
      //    durably: no self-recovery lane exists for an exited pane.
      await server.restart()
      await waitForWsReady(page)

      // 4. The park is witnessed BOTH ways — the server's warming verdict
      //    (durable in the received-WS ring) and the client's VISIBLE
      //    banner (the park is durable now, so a visibility poll cannot
      //    miss it).
      await expect
        .poll(async () => witnessedWarmingVerdict(harness, codexPane.tabId, codexPane.leafId), {
          timeout: 30_000,
        })
        .toBe(true)
      await expect(warmingBanner(page)).toBeVisible({ timeout: 20_000 })

      // 5. The shell pane needs no index — it is live again with a NEW
      //    terminalId (the fresh verdict's respawn).
      await expect
        .poll(async () => {
          const l = await findLeafById(harness, shellTabId, shellLeaf.id)
          const tid = l?.content?.terminalId ?? null
          return tid && tid !== shellTerminalIdBefore && l?.content?.status === 'running' ? tid : null
        }, { timeout: 60_000 })
        .not.toBeNull()

      // 6. MID-PARK USABILITY ("existing live agents remain attached and
      //    usable during indexing"): the parked pane's own un-anchored
      //    create lane resumes the session with the SAME createRequestId
      //    (council rule 2 — never re-minted), so the park SURVIVES the
      //    recovery and the pane is alive while the banner honestly waits.
      //    The resumed CLI carries the plain `codex resume <id>` argv.
      const resumedTerminalId: string = await expect
        .poll(async () => {
          const l = await findLeafById(harness, codexPane.tabId, codexPane.leafId)
          const tid = l?.content?.terminalId ?? null
          return tid && tid !== codexTerminalIdBefore && l?.content?.status === 'running'
            ? tid
            : null
        }, { timeout: 30_000 })
        .not.toBeNull()
        .then(async () => {
          const l = await findLeafById(harness, codexPane.tabId, codexPane.leafId)
          return l!.content.terminalId as string
        })
      // While the index is STILL not ready, the park must hold over the
      // live pane (the banner honestly waits). Conditional on readiness
      // not having fired yet: on a slow machine readiness may land mid-step,
      // and the hard chain witnesses below (re-drive + resolution) carry
      // the contract either way.
      {
        const state = (await harness.getState())
        if (state?.connection?.sessionIndexReady !== true) {
          expect(state?.panes?.reconcileWarming).not.toBeNull()
          await expect(warmingBanner(page)).toBeVisible()
        }
      }
      await expect
        .poll(async () => {
          const entries = await readArgvLog(argLogPath)
          return entries
            .slice(argvCountBeforeRestart)
            .some((e) => hasFlagPair(e.argv, 'resume', CODEX_SESSION_ID))
        }, { timeout: 30_000 })
        .toBe(true)
      // The parked identity is the SAME session, never a new conversation.
      const parkedContent = (await findLeafById(harness, codexPane.tabId, codexPane.leafId))?.content
      expect(parkedContent?.sessionRef).toMatchObject({
        provider: 'codex',
        sessionId: CODEX_SESSION_ID,
      })
      expect(parkedContent?.restoreError).toBeFalsy()

      // 7. READINESS: the once-per-boot broadcast reaches this client (the
      //    real SPA negotiated sessionIndexReadyV1), the flag folds, and
      //    the DRIVER re-drives the reconcile for the parked pane — a NEW
      //    pane.reconcile.request naming the pane's key, beyond the boot
      //    reconcile's own.
      const requestCountBeforeReadiness = await sentReconcileRequestCount(
        harness,
        codexPane.tabId,
        codexPane.leafId,
      )
      expect(requestCountBeforeReadiness).toBeGreaterThanOrEqual(1)
      await waitForSessionIndexReady(harness)
      expect(await witnessedReadinessBroadcast(harness)).toBe(true)
      await expect
        .poll(
          async () => sentReconcileRequestCount(harness, codexPane.tabId, codexPane.leafId),
          { timeout: 30_000 },
        )
        .toBeGreaterThan(requestCountBeforeReadiness)

      // 8. The re-drive's OWN result resolves the pane: a non-warming
      //    verdict (attach onto the live resumed terminal) folds, and the
      //    warming state + banner clear — ZERO interaction. With the
      //    driver unmounted (the RED door) the re-drive never fires and
      //    the park never clears.
      await expect
        .poll(async () => witnessedResolutionVerdict(harness, codexPane.tabId, codexPane.leafId), {
          timeout: 30_000,
        })
        .toBe(true)
      await expect
        .poll(async () => (await harness.getState())?.panes?.reconcileWarming ?? null, {
          timeout: 20_000,
        })
        .toBe(null)
      await expect(warmingBanner(page)).toHaveCount(0)
      const restoredContent = (await findLeafById(harness, codexPane.tabId, codexPane.leafId))?.content
      expect(restoredContent?.terminalId).toBe(resumedTerminalId)
      expect(restoredContent?.status).toBe('running')
      expect(restoredContent?.sessionRef).toMatchObject({
        provider: 'codex',
        sessionId: CODEX_SESSION_ID,
      })
      expect(restoredContent?.restoreError).toBeFalsy()

      // 9. No respawn storm: exactly ONE running codex terminal carries the
      //    session identity server-side, and pane/tab counts are unchanged.
      await expect
        .poll(async () => {
          const terms = await listTerminals(info)
          const running = terms.filter((t) => t.mode === 'codex' && t.status === 'running')
          return (
            running.length === 1
            && running[0].sessionRef?.provider === 'codex'
            && running[0].sessionRef?.sessionId === CODEX_SESSION_ID
          )
        }, { timeout: 30_000 })
        .toBe(true)
      expect((await allTerminalLeaves(harness)).length).toBe(leavesBefore.length)
      expect(await harness.getTabCount()).toBe(tabCountBefore)
      await expect(page.getByRole('dialog', { name: 'Dead sessions' })).toHaveCount(0)
    } finally {
      await server.stop()
      await fs.rm(sharedRoot, { recursive: true, force: true })
    }
  })

  test('closing a pane during the warming window cancels its recovery', async ({ page }) => {
    const CODEX_SESSION_ID = 'bbbbbbbb-cccc-4ddd-8eee-000000000002'
    const CODEX_SESSION_TITLE = 'warming close-cancel codex session'
    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-warming-close-'))
    const projectDir = path.join(sharedRoot, 'project')
    await fs.mkdir(projectDir, { recursive: true })
    const argLogPath = path.join(sharedRoot, 'codex-argv.jsonl')
    const fakeCodexPath = await installDualRoleCodexCli(
      path.join(sharedRoot, 'bin'),
      FAKE_CODEX_CLI_SOURCE,
      { FAKE_CODEX_ARGV_LOG: argLogPath },
    )
    const { server, harness, info } = await bootWithHold(page, {
      env: {
        CODEX_CMD: fakeCodexPath,
        FAKE_CODEX_ARGV_LOG: argLogPath,
        FRESHELL_CODEX_MANAGED_LAUNCH: '0',
      },
      setupHome: seedCodexWarmingHome(
        [{ id: CODEX_SESSION_ID, title: CODEX_SESSION_TITLE }],
        projectDir,
      ),
    })
    try {
      // 1. Shell pane + one seeded codex pane (its own tab), then restart.
      await selectShellIfPickerShowing(page)
      await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })
      const codexPane = await openSeededCodexSession(page, harness, CODEX_SESSION_ID)
      const codexTerminalIdBefore: string = await expect
        .poll(
          async () => (await findLeafById(harness, codexPane.tabId, codexPane.leafId))?.content?.terminalId ?? null,
          { timeout: 20_000 },
        )
        .not.toBeNull()
        .then(async () => (await findLeafById(harness, codexPane.tabId, codexPane.leafId))!.content.terminalId)
      await flushPersistence(page)
      const tabCountBefore = await harness.getTabCount()

      // 2. Graceful restart; the client reconnects inside the cold window
      //    and the codex pane PARKS (the warming verdict + the banner
      //    witness it below).
      await observeWarmingBanner(page)
      await server.restart()
      await waitForWsReady(page)
      await expect
        .poll(async () => witnessedWarmingVerdict(harness, codexPane.tabId, codexPane.leafId), {
          timeout: 30_000,
        })
        .toBe(true)
      expect(await warmingBannerWasSeen(page)).toBe(true)

      // 3. The parked pane's own reconnect recovery resumes it with ZERO
      //    interaction (the same automatic-recovery contract test 1 pins);
      //    wait for that recovered state so the close below has a
      //    deterministic kill target.
      const recoveredTerminalId: string = await expect
        .poll(async () => {
          const l = await findLeafById(harness, codexPane.tabId, codexPane.leafId)
          const tid = l?.content?.terminalId ?? null
          return tid && tid !== codexTerminalIdBefore && l?.content?.status === 'running'
            ? tid
            : null
        }, { timeout: 90_000 })
        .not.toBeNull()
        .then(async () => {
          const l = await findLeafById(harness, codexPane.tabId, codexPane.leafId)
          return l!.content.terminalId as string
        })
      expect(recoveredTerminalId).toBeTruthy()

      // The driver's identity guard has cleared the warming state for the
      // pane that moved on (the RED door — without the driver the state
      // never clears and the banner lies over the tab strip forever).
      await expect
        .poll(async () => (await harness.getState())?.panes?.reconcileWarming ?? null, {
          timeout: 20_000,
        })
        .toBe(null)

      // 4. Close the recovered pane's tab WITH KILL while the warming
      //    window is still up (the hold has not elapsed). The stale warming
      //    state the fold minted is then cleared by the driver's identity
      //    guard ("closing a pane cancels its pending recovery"). With the
      //    driver unmounted the state never clears and the banner lies
      //    forever (the RED door).
      const codexTab = page.locator(`[data-context="tab"][data-tab-id="${codexPane.tabId}"]`)
      await codexTab
        .getByRole('button', { name: /Close \(Shift\+Click to kill\)/i })
        .click({ modifiers: ['Shift'] })
      await expect(codexTab).toHaveCount(0, { timeout: 20_000 })
      expect(await harness.getTabCount()).toBe(tabCountBefore - 1)
      await expect
        .poll(async () => (await harness.getState())?.panes?.reconcileWarming ?? null, {
          timeout: 20_000,
        })
        .toBe(null)
      await expect(warmingBanner(page)).toHaveCount(0)

      // 5. Wait out the hold (readiness folds the flag), then settle: NO
      //    codex terminal for the closed pane's identity survives or
      //    appears — two samples >=5s apart agree on zero. Nothing
      //    re-opened the closed pane's session through the readiness
      //    window (the driver cleared the warming state without driving
      //    for the closed pane, and no pane-level lane outlives the
      //    pane).
      await waitForSessionIndexReady(harness)
      const codexTerminalsForIdentity = async () =>
        (await listTerminals(info)).filter(
          (t) => t.sessionRef?.sessionId === CODEX_SESSION_ID || t.mode === 'codex',
        ).length
      expect(await stableCount(codexTerminalsForIdentity)).toBe(0)

      // 6. No collateral damage: no pane carries a restoreError, no dialog
      //    ever appeared (a closed pane's cancellation is silent).
      for (const leaf of await allTerminalLeaves(harness)) {
        expect(leaf?.content?.restoreError, 'no pane may carry a restoreError').toBeFalsy()
      }
      await expect(page.getByRole('dialog', { name: 'Dead sessions' })).toHaveCount(0)
    } finally {
      await server.stop()
      await fs.rm(sharedRoot, { recursive: true, force: true })
    }
  })

  test('unreadable store: parked pane resolves to the honest per-pane error with a visible explanation — zero interaction', async ({
    page,
  }) => {
    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-warming-unreadable-'))
    const argLogPath = path.join(sharedRoot, 'opencode-argv.jsonl')
    const fakeOpencodePath = await installFakeCli(
      FAKE_OPENCODE_TERMINAL_SOURCE,
      'opencode',
      path.join(sharedRoot, 'bin'),
    )
    // The hold is LONGER than the default: the resumed fake CLI dies on the
    // unreadable store and the server's bounded crash-retry churn (2
    // auto-resumes with 2s/10s backoff) must SETTLE before readiness, so
    // the re-drive derives the honest error against a deterministically
    // dead pane.
    const { server, harness, info } = await bootWithHold(page, {
      env: {
        OPENCODE_CMD: fakeOpencodePath,
        FAKE_OPENCODE_TERMINAL_ARGV_LOG: argLogPath,
      },
      holdMs: UNREADABLE_HOLD_MS,
      setupHome: async (homeDir) => {
        const freshellDir = path.join(homeDir, '.freshell')
        await fs.mkdir(freshellDir, { recursive: true })
        await fs.writeFile(
          path.join(freshellDir, 'config.json'),
          JSON.stringify(
            {
              version: 1,
              settings: { codingCli: { enabledProviders: ['opencode'] } },
            },
            null,
            2,
          ),
        )
      },
    })
    try {
      // 1. Shell pane + a fresh opencode pane (picker split); the fake
      //    opencode terminal writes a real `session` row into
      //    <data home>/opencode.db on its first stdin line, and the
      //    locator associates the pane with that ses_* identity.
      await selectShellIfPickerShowing(page)
      const tabId = (await harness.getActiveTabId())!
      await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })
      const beforeIds = new Set(
        findLeavesByMode(await harness.getPaneLayout(tabId), 'opencode').map((l) => l.id),
      )
      const picker = await openPanePicker(page)
      await picker.getByRole('button', { name: /^OpenCode$/i }).click({ force: true })
      await page.getByRole('combobox', { name: /Starting directory for OpenCode/i }).press('Enter')
      const opencodeLeaf = await expect
        .poll(async () => {
          const layout = await harness.getPaneLayout(tabId)
          const leaf = findLeavesByMode(layout, 'opencode').find((l) => !beforeIds.has(l.id))
          return leaf?.content?.terminalId ? leaf : null
        }, { timeout: 20_000 })
        .not.toBeNull()
        .then(async () => {
          const layout = await harness.getPaneLayout(tabId)
          return findLeavesByMode(layout, 'opencode').find((l) => !beforeIds.has(l.id))!
        })
      const opencodeTerminalIdBefore: string = opencodeLeaf.content.terminalId
      expect(opencodeTerminalIdBefore).toBeTruthy()

      // Mint the session: click the pane, type, press Enter (the fake
      // writes the opencode.db row on its first stdin data event).
      await page.locator(`[data-context="pane"][data-pane-id="${opencodeLeaf.id}"]`).click()
      await page.keyboard.type('hello warming unreadable')
      await page.keyboard.press('Enter')
      const associatedSessionId: string = await expect
        .poll(async () => {
          const l = await findLeafById(harness, tabId, opencodeLeaf.id)
          return l?.content?.sessionRef?.sessionId ?? l?.content?.resumeSessionId ?? null
        }, { timeout: 30_000 })
        .not.toBeNull()
        .then(async () => {
          const l = await findLeafById(harness, tabId, opencodeLeaf.id)
          return l!.content.sessionRef?.sessionId ?? l!.content.resumeSessionId!
        })
      expect(associatedSessionId).toMatch(/^ses_e2e_/)

      // 2. EXIT the CLI session cleanly (the fake's exit affordance): the
      //    pane keeps its identity with no live process — the durable-park
      //    shape. A clean exit never auto-resumes.
      await page.keyboard.type('exit')
      await page.keyboard.press('Enter')
      await expect
        .poll(async () => {
          const l = await findLeafById(harness, tabId, opencodeLeaf.id)
          return l?.content?.status === 'exited' && !l?.content?.terminalId ? 'exited' : null
        }, { timeout: 20_000 })
        .toBe('exited')

      // 3. Seed the unreadable store: replace <data home>/opencode.db with
      //    a DIRECTORY (SQLite open fails on a directory for any euid), so
      //    the by-id locator answers Unreadable — cold => Unknown => the
      //    pane parks as warming; warm => the honest
      //    error{session_store_unreadable}. A claude transcript DIRECTORY
      //    would be a clean miss (Absent — the pane would fold dead/fresh
      //    and never park) — the DB directory is the honest unreadable
      //    shape.
      const dbPath = path.join(info.homeDir, '.local', 'share', 'opencode', 'opencode.db')
      await fs.access(dbPath) // fail loud: the fake must have written the db
      await fs.rm(dbPath)
      await fs.mkdir(dbPath)

      await flushPersistence(page)
      const leavesBefore = await allTerminalLeaves(harness)
      const tabCountBefore = await harness.getTabCount()

      // 4. Graceful restart; the exited pane PARKS during the hold (the
      //    received warming verdict + the VISIBLE banner witness it — the
      //    park is durable for an exited pane).
      await server.restart()
      await waitForWsReady(page)
      await expect
        .poll(async () => witnessedWarmingVerdict(harness, tabId, opencodeLeaf.id), {
          timeout: 30_000,
        })
        .toBe(true)
      await expect(warmingBanner(page)).toBeVisible({ timeout: 20_000 })

      // 5. The resumed CLI dies on the unreadable store and the server's
      //    own BOUNDED crash-retry churn settles: by the readiness window
      //    the pane is deterministically exited again (no live terminal,
      //    identity retained) — the park SURVIVES the whole churn because
      //    every retry keeps the pane's createRequestId.
      await expect
        .poll(async () => {
          const l = await findLeafById(harness, tabId, opencodeLeaf.id)
          return l?.content?.status === 'exited' && !l?.content?.terminalId ? 'exited' : null
        }, { timeout: 30_000 })
        .toBe('exited')

      // 6. READINESS: the broadcast reaches the client, the flag folds,
      //    and the DRIVER re-drives the reconcile for the parked pane —
      //    which now derives the HONEST error{session_store_unreadable}
      //    (the index published; the by-id locator cannot read the
      //    directory store). NEVER a lying warming banner over a dead
      //    pane, and never a false death (no dead_session/fresh).
      await waitForSessionIndexReady(harness, 90_000)
      expect(await witnessedReadinessBroadcast(harness)).toBe(true)
      await expect
        .poll(async () => witnessedUnreadableVerdict(harness, tabId, opencodeLeaf.id), {
          timeout: 60_000,
        })
        .toBe(true)

      // 7. The honest error FOLDS: a per-pane restoreError with the exact
      //    reason, the identity PRESERVED verbatim, and the VISIBLE
      //    in-buffer explanation line (finding 1's notice machinery) on
      //    the pane's own surface — no user interaction anywhere. The
      //    witness is the pane's rendered DOM text: the line is written
      //    into the pane's xterm buffer, so it is what the user sees
      //    (row-wrapping is irrelevant to textContent concatenation).
      await expect
        .poll(async () => {
          const l = await findLeafById(harness, tabId, opencodeLeaf.id)
          return l?.content?.restoreError?.reason === 'session_store_unreadable' ? l : null
        }, { timeout: 30_000 })
        .not.toBeNull()
      const erroredContent = (await findLeafById(harness, tabId, opencodeLeaf.id))?.content
      expect(
        erroredContent?.sessionRef?.sessionId ?? erroredContent?.resumeSessionId,
        'the recoverable identity is preserved',
      ).toBe(associatedSessionId)
      expect(erroredContent?.reconcileNotice, 'the durable visible-explanation mint').toBeTruthy()
      await expect(
        page.locator(`[data-context="pane"][data-pane-id="${opencodeLeaf.id}"]`),
      ).toContainText('saved session store could not be read', { timeout: 30_000 })

      // 8. The banner cleared itself at the fold (warming === 0 — the
      //    pane resolved, honestly to an error) — the RED door: without
      //    the driver the re-drive never fires and neither the honest
      //    error nor the clear happens.
      await expect
        .poll(async () => (await harness.getState())?.panes?.reconcileWarming ?? null, {
          timeout: 20_000,
        })
        .toBe(null)
      await expect(warmingBanner(page)).toHaveCount(0)

      // 9. No storm, no dialogs, warming never returns: after a settle
      //    window no opencode terminal runs for the identity, the
      //    structure is unchanged, and the warming state stays cleared.
      const opencodeTerminalsForIdentity = async () =>
        (await listTerminals(info)).filter(
          (t) => t.mode === 'opencode' && t.status === 'running',
        ).length
      expect(await stableCount(opencodeTerminalsForIdentity)).toBe(0)
      expect((await allTerminalLeaves(harness)).length).toBe(leavesBefore.length)
      expect(await harness.getTabCount()).toBe(tabCountBefore)
      await new Promise((resolve) => setTimeout(resolve, 5_000))
      expect((await harness.getState())?.panes?.reconcileWarming ?? null).toBe(null)
      await expect(warmingBanner(page)).toHaveCount(0)
      await expect(page.getByRole('dialog', { name: 'Dead sessions' })).toHaveCount(0)
    } finally {
      await server.stop()
      await fs.rm(sharedRoot, { recursive: true, force: true })
    }
  })

  test('two clients parked on one codex identity auto-restore with exactly one live PTY', async ({
    page,
  }) => {
    const CODEX_SESSION_ID = 'bbbbbbbb-cccc-4ddd-8eee-000000004'
    const CODEX_SESSION_TITLE = 'warming two-client codex session'
    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-warming-twoclient-'))
    const projectDir = path.join(sharedRoot, 'project')
    await fs.mkdir(projectDir, { recursive: true })
    const argLogPath = path.join(sharedRoot, 'codex-argv.jsonl')
    const fakeCodexPath = await installDualRoleCodexCli(
      path.join(sharedRoot, 'bin'),
      FAKE_CODEX_CLI_SOURCE,
      { FAKE_CODEX_ARGV_LOG: argLogPath },
    )
    const { server, harness, info } = await bootWithHold(page, {
      env: {
        CODEX_CMD: fakeCodexPath,
        FAKE_CODEX_ARGV_LOG: argLogPath,
        FRESHELL_CODEX_MANAGED_LAUNCH: '0',
      },
      setupHome: seedCodexWarmingHome(
        [{ id: CODEX_SESSION_ID, title: CODEX_SESSION_TITLE }],
        projectDir,
      ),
    })
    let pageB: Page | null = null
    try {
      // 1. Page A: shell pane + the seeded codex pane, then flush so the
      //    shared-context page B hydrates the SAME pane tree.
      await selectShellIfPickerShowing(page)
      await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })
      const codexPane = await openSeededCodexSession(page, harness, CODEX_SESSION_ID)
      const codexTerminalIdBefore: string = await expect
        .poll(
          async () => (await findLeafById(harness, codexPane.tabId, codexPane.leafId))?.content?.terminalId ?? null,
          { timeout: 20_000 },
        )
        .not.toBeNull()
        .then(async () => (await findLeafById(harness, codexPane.tabId, codexPane.leafId))!.content.terminalId)
      await flushPersistence(page)

      // Second client in the SAME context (shared localStorage, donor:
      // reconcile-completion-rust.spec.ts test 2): both pages hydrate the
      // SAME pane, so both fold verdicts for the same sessionRef.
      pageB = await page.context().newPage()
      await pageB.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
      const harnessB = new TestHarness(pageB)
      await harnessB.waitForHarness()
      await harnessB.waitForConnection()
      await expect
        .poll(async () => {
          const l = await findLeafById(harnessB, codexPane.tabId, codexPane.leafId)
          return l?.content?.sessionRef?.sessionId ?? null
        }, { timeout: 30_000 })
        .toBe(CODEX_SESSION_ID)

      const tabCountBefore = await harness.getTabCount()
      const leavesBefore = await allTerminalLeaves(harness)
      const argvCountBeforeRestart = (await readArgvLog(argLogPath)).length

      // 2. Graceful restart; both pages reconnect inside the cold window
      //    and both park the codex pane (codex cold => Unknown).
      await observeWarmingBanner(page)
      await observeWarmingBanner(pageB)
      await server.restart()
      await waitForWsReady(page)
      await waitForWsReady(pageB)
      await expect
        .poll(async () => witnessedWarmingVerdict(harness, codexPane.tabId, codexPane.leafId), {
          timeout: 30_000,
        })
        .toBe(true)
      await expect
        .poll(async () => witnessedWarmingVerdict(harnessB, codexPane.tabId, codexPane.leafId), {
          timeout: 30_000,
        })
        .toBe(true)
      expect(await warmingBannerWasSeen(page)).toBe(true)
      expect(await warmingBannerWasSeen(pageB)).toBe(true)

      // 3. ZERO-INTERACTION RESTORE ON BOTH PAGES, EXACTLY ONE LIVE PTY:
      //    each page's own reconnect recovery races a resume create; the
      //    server's per-sessionRef single-flight (D8) keeps exactly one
      //    writer, and the loser converges onto the winner's terminal
      //    (the committed same-kind owner broadcast / reconcile attach).
      //    Both panes end attached to the SAME terminalId.
      const restoredA: string = await expect
        .poll(async () => {
          const l = await findLeafById(harness, codexPane.tabId, codexPane.leafId)
          const tid = l?.content?.terminalId ?? null
          return tid && tid !== codexTerminalIdBefore && l?.content?.status === 'running'
            && !l?.content?.restoreError
            ? tid
            : null
        }, { timeout: 90_000 })
        .not.toBeNull()
        .then(async () => {
          const l = await findLeafById(harness, codexPane.tabId, codexPane.leafId)
          return l!.content.terminalId as string
        })
      await expect
        .poll(async () => {
          const l = await findLeafById(harnessB, codexPane.tabId, codexPane.leafId)
          const tid = l?.content?.terminalId ?? null
          return tid && tid === restoredA && l?.content?.status === 'running'
            && !l?.content?.restoreError
            ? tid
            : null
        }, { timeout: 90_000 })
        .not.toBeNull()
      const restoredContent = (await findLeafById(harness, codexPane.tabId, codexPane.leafId))?.content
      expect(restoredContent?.sessionRef?.sessionId).toBe(CODEX_SESSION_ID)

      // 4. D8 single-writer: STABLE-COUNT settle on /api/terminals —
      //    exactly one running codex terminal carries the sessionRef — and
      //    exactly one post-restart resume spawn reached the fake CLI.
      const runningCodexForIdentity = async () =>
        (await listTerminals(info)).filter(
          (t) =>
            t.mode === 'codex'
            && t.status === 'running'
            && t.sessionRef?.sessionId === CODEX_SESSION_ID,
        ).length
      expect(await stableCount(runningCodexForIdentity)).toBe(1)
      await expect
        .poll(async () => {
          const entries = await readArgvLog(argLogPath)
          return entries
            .slice(argvCountBeforeRestart)
            .filter((e) => hasFlagPair(e.argv, 'resume', CODEX_SESSION_ID)).length
        }, { timeout: 30_000 })
        .toBe(1)

      // 5. Both banners cleared themselves (the RED door: without the
      //    driver neither page's warming state ever clears). Structure
      //    unchanged on both pages; zero dialogs.
      await expect
        .poll(async () => (await harness.getState())?.panes?.reconcileWarming ?? null, {
          timeout: 20_000,
        })
        .toBe(null)
      await expect
        .poll(async () => (await harnessB.getState())?.panes?.reconcileWarming ?? null, {
          timeout: 20_000,
        })
        .toBe(null)
      await expect(warmingBanner(page)).toHaveCount(0)
      await expect(warmingBanner(pageB)).toHaveCount(0)
      expect(await harness.getTabCount()).toBe(tabCountBefore)
      expect((await allTerminalLeaves(harness)).length).toBe(leavesBefore.length)
      await expect(page.getByRole('dialog', { name: 'Dead sessions' })).toHaveCount(0)
      await expect(pageB.getByRole('dialog', { name: 'Dead sessions' })).toHaveCount(0)
    } finally {
      await pageB?.close().catch(() => {})
      await server.stop()
      await fs.rm(sharedRoot, { recursive: true, force: true })
    }
  })
})
