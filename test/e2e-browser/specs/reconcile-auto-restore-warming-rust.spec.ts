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
 * PARKING MECHANICS (as the tree actually behaves, discovered in this
 * task's RED run): only a pane whose provider answers
 * SessionExistence::Unknown while cold parks as warming. Codex is the
 * deterministic park class (AD-4: no cold by-id locator); the shell pane
 * needs no index (folds fresh immediately) and a seeded claude transcript
 * would resolve Present via the EXISTING cold by-id locator. The park is
 * the SERVER's verdict (witnessed durably via the harness's received-WS
 * log: the pane.reconcile.result carrying error{index_warming} for the
 * pane's key) and the CLIENT's banner (witnessed via a page-side
 * MutationObserver flag, because the park is TRANSIENT for terminal
 * panes: the pre-existing INVALID_TERMINAL_ID reconnect recovery
 * (TerminalView's resumeRecoveryCreate — deliberately fail-open for
 * unreadable stores, resume_validation.rs) resumes the pane's OWN saved
 * identity ~1s after the warming fold, long before readiness. That lane is
 * itself zero-interaction automatic recovery (the SAME session identity —
 * never a new conversation, never a dead-session inference), so it
 * satisfies the kata's requested result; the ReconcileWarmingRecoveryDriver
 * (plan Task 6) is what then keeps the banner honest: its identity guard
 * clears the warming state the moment a parked pane moved on, and it
 * re-drives the reconcile at readiness for panes that stay parked. With the
 * driver unmounted (this spec's RED), the pane still self-restores but the
 * warming state NEVER clears — the banner lies forever over a restored
 * pane — which is the deterministic RED door for every test here.
 *
 * The unreadable-store case seeds a DIRECTORY at
 * <isolated data home>/opencode/opencode.db: SQLite open fails on a
 * directory for any euid, so the opencode by-id locator answers Unreadable
 * (cold => Unknown => the pane parks; the recovery lane resumes the
 * identity fail-open). The pane must NEVER fold a false verdict for it
 * (no dead_session / fresh / restoreError) and its identity must survive.
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
const HOLD_MS = 15_000

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
  } = {},
): Promise<{ server: RustServer; info: E2eServerInfo; harness: TestHarness }> {
  const server = new RustServer({
    env: {
      ...options.env,
      FRESHELL_TEST_SESSION_INDEX_STARTUP_HOLD_MS: String(HOLD_MS),
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

  test('slow index: parked codex pane restores automatically with zero interaction', async ({
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

      await flushPersistence(page)
      const leavesBefore = await allTerminalLeaves(harness)
      const tabCountBefore = await harness.getTabCount()
      const argvCountBeforeRestart = (await readArgvLog(argLogPath)).length

      // 2. Graceful restart (the ONE this test uses); the live client's WS
      //    reconnects inside the cold window and reconciles on the new
      //    ready. The shell pane has no index identity (fresh verdict); the
      //    codex pane's provider answers Unknown while cold (AD-4), so the
      //    verdict is error{index_warming} and the pane parks.
      await observeWarmingBanner(page)
      await server.restart()
      await waitForWsReady(page)

      // 3. The park is witnessed durably: the server's reconcile result
      //    carries error{index_warming} for the codex pane's own key, and
      //    the client surfaced the warming banner (page-side observer —
      //    the park is transient, see the file doc comment).
      await expect
        .poll(async () => witnessedWarmingVerdict(harness, codexPane.tabId, codexPane.leafId), {
          timeout: 30_000,
        })
        .toBe(true)
      expect(await warmingBannerWasSeen(page)).toBe(true)

      // 4. The shell pane needs no index — it is live again with a NEW
      //    terminalId (the fresh verdict's respawn).
      await expect
        .poll(async () => {
          const l = await findLeafById(harness, shellTabId, shellLeaf.id)
          const tid = l?.content?.terminalId ?? null
          return tid && tid !== shellTerminalIdBefore && l?.content?.status === 'running' ? tid : null
        }, { timeout: 60_000 })
        .not.toBeNull()

      // 5. ZERO-INTERACTION RESTORE: no click anywhere. The codex pane is
      //    back — a NEW terminalId, running, no restoreError, the SAME
      //    sessionRef — resumed with the plain `codex resume <id>` argv
      //    (two independent proofs: the pane buffer's marker and the fake
      //    CLI's argv log), and the banner has cleared itself.
      const restoredTerminalId: string = await expect
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
      const restoredContent = (await findLeafById(harness, codexPane.tabId, codexPane.leafId))?.content
      expect(restoredContent?.sessionRef?.provider).toBe('codex')
      expect(restoredContent?.sessionRef?.sessionId).toBe(CODEX_SESSION_ID)
      await expect
        .poll(async () => {
          const buffer = await harness.getTerminalBuffer(restoredTerminalId)
          const unwrapped = typeof buffer === 'string' ? buffer.replace(/\n/g, '') : ''
          return unwrapped.includes(`codex: resumed session ${CODEX_SESSION_ID}`)
        }, { timeout: 30_000 })
        .toBe(true)
      await expect
        .poll(async () => {
          const entries = await readArgvLog(argLogPath)
          return entries
            .slice(argvCountBeforeRestart)
            .some((e) => hasFlagPair(e.argv, 'resume', CODEX_SESSION_ID))
        }, { timeout: 30_000 })
        .toBe(true)
      // The warming state and its banner are GONE (the recovery driver's
      // identity guard clears the park the moment the pane moved on) —
      // with the driver unmounted this never happens (the RED door).
      await expect
        .poll(async () => (await harness.getState())?.panes?.reconcileWarming ?? null, {
          timeout: 20_000,
        })
        .toBe(null)
      await expect(warmingBanner(page)).toHaveCount(0)

      // 6. No respawn storm: exactly ONE running codex terminal carries the
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

  test('unreadable store: identity preserved, no false verdict, banner clears automatically', async ({
    page,
  }) => {
    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-warming-unreadable-'))
    const argLogPath = path.join(sharedRoot, 'opencode-argv.jsonl')
    const fakeOpencodePath = await installFakeCli(
      FAKE_OPENCODE_TERMINAL_SOURCE,
      'opencode',
      path.join(sharedRoot, 'bin'),
    )
    const { server, harness, info } = await bootWithHold(page, {
      env: {
        OPENCODE_CMD: fakeOpencodePath,
        FAKE_OPENCODE_TERMINAL_ARGV_LOG: argLogPath,
      },
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
      await page.locator('.xterm').last().click()
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

      await flushPersistence(page)
      const leavesBefore = await allTerminalLeaves(harness)
      const tabCountBefore = await harness.getTabCount()
      const argvCountBeforeRestart = (await readArgvLog(argLogPath)).length

      // 2. Seed the unreadable store: replace <data home>/opencode.db with
      //    a DIRECTORY (SQLite open fails on a directory for any euid), so
      //    the by-id locator answers Unreadable — cold => Unknown => the
      //    pane parks as warming. A claude transcript DIRECTORY would be a
      //    clean miss (Absent — the pane would fold dead/fresh and never
      //    park) — the DB directory is the honest unreadable shape.
      const dbPath = path.join(info.homeDir, '.local', 'share', 'opencode', 'opencode.db')
      await fs.access(dbPath) // fail loud: the fake must have written the db
      await fs.rm(dbPath)
      await fs.mkdir(dbPath)

      // 3. Graceful restart; the pane parks during the hold (the received
      //    verdict + the banner witness it).
      await observeWarmingBanner(page)
      await server.restart()
      await waitForWsReady(page)
      await expect
        .poll(async () => witnessedWarmingVerdict(harness, tabId, opencodeLeaf.id), {
          timeout: 30_000,
        })
        .toBe(true)
      expect(await warmingBannerWasSeen(page)).toBe(true)

      // 4. ZERO INTERACTION, IDENTITY-PRESERVING RECOVERY, NO FALSE
      //    VERDICT: the pane's own reconnect recovery resumes the SAME
      //    ses_* identity (the resume gate deliberately fails open for a
      //    store the probe cannot read — resume_validation.rs — so the
      //    CLI itself owns surfacing the store failure; the fake CLI
      //    resumes fine). The pane must NEVER fold a false verdict for
      //    the unreadable store: no dead_session, no fresh, no
      //    restoreError — the identity is preserved verbatim.
      const restoredTerminalId: string = await expect
        .poll(async () => {
          const l = await findLeafById(harness, tabId, opencodeLeaf.id)
          const tid = l?.content?.terminalId ?? null
          return tid && tid !== opencodeTerminalIdBefore && l?.content?.status === 'running'
            && !l?.content?.restoreError
            ? tid
            : null
        }, { timeout: 90_000 })
        .not.toBeNull()
        .then(async () => {
          const l = await findLeafById(harness, tabId, opencodeLeaf.id)
          return l!.content.terminalId as string
        })
      const restoredContent = (await findLeafById(harness, tabId, opencodeLeaf.id))?.content
      expect(
        restoredContent?.sessionRef?.sessionId ?? restoredContent?.resumeSessionId,
        'the recoverable identity is preserved',
      ).toBe(associatedSessionId)
      expect(restoredContent?.restoreError, 'an unreadable store is never a false death').toBeFalsy()
      await expect
        .poll(async () => {
          const entries = await readArgvLog(argLogPath)
          return entries
            .slice(argvCountBeforeRestart)
            .some((e) => hasFlagPair(e.argv, '--session', associatedSessionId))
        }, { timeout: 30_000 })
        .toBe(true)

      // 5. The banner cleared itself (the driver's identity guard) — the
      //    RED door: without the driver the warming state never clears.
      await expect
        .poll(async () => (await harness.getState())?.panes?.reconcileWarming ?? null, {
          timeout: 20_000,
        })
        .toBe(null)
      await expect(warmingBanner(page)).toHaveCount(0)

      // 6. No respawn storm: exactly ONE running opencode terminal carries
      //    the identity; structure unchanged; zero dialogs. Warming never
      //    returns: after a settle window the warming state stays cleared.
      await expect
        .poll(async () => {
          const terms = await listTerminals(info)
          const running = terms.filter((t) => t.mode === 'opencode' && t.status === 'running')
          return (
            running.length === 1
            && running[0].sessionRef?.provider === 'opencode'
            && running[0].sessionRef?.sessionId === associatedSessionId
          )
        }, { timeout: 30_000 })
        .toBe(true)
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
