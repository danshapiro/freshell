/**
 * P1.14 sidebar/tab-registry sync re-verification (Lane C1).
 * Pins the Incident-4 sidebar contract against ledger-backed identity:
 *  case-c: fresh codex duplicate collapse          (Task 5)
 *  case-b: REST-created tabs are green + dedupe   (Task 6)
 *  case-a: joins survive server restart            (Task 7)
 *  case-d: joins correct after recover-my-panes    (Task 8)
 * Owns a RustServer directly (ephemeral loopback port -- NEVER 3001/3002).
 */
import { test, expect } from '@playwright/test'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { RustServer, ensureRustServerBuilt, type TestServerInfo } from '../helpers/rust-server.js'
import { TestHarness } from '../helpers/test-harness.js'
import { installDualRoleCodexCli } from '../fixtures/codex-dual-role'
const __dirname = path.dirname(fileURLToPath(import.meta.url))

// NOTE (RESTORE-01): this spec imports `test` from '@playwright/test'
// directly (not the shared helpers/fixtures.js chain), so the harness
// auto-decline watcher never attaches to its pages — its own decline idiom
// below stays the sole authority over panel interactions. No opt-out needed.

const SEEDED_CLAUDE_ID = randomUUID()
// case-d gets its own seeded claude id: the serial suite already bound
// SEEDED_CLAUDE_ID to a running resume terminal in case-b, and the Rust
// server now rejects REST resume of a still-running session (409
// RESTORE_UNAVAILABLE). A distinct, unbound id keeps case-d's premise valid.
const SEEDED_CLAUDE_ID_D = randomUUID()
const PROJECT_DIR = '/tmp/p114-sidebar-project'

// Copied VERBATIM from pane-ledger-restart-rust.spec.ts:29 (per this
// suite's per-spec-ownership convention: helpers are copied, not imported).
async function installFakeCli(binDir: string, name: string, source: string): Promise<string> {
  await fs.mkdir(binDir, { recursive: true })
  const target = path.join(binDir, name)
  await fs.copyFile(path.resolve(__dirname, '../fixtures', source), target)
  await fs.chmod(target, 0o755)
  return target
}

// Dual-role codex shim: shared helper (test/e2e-browser/fixtures/codex-dual-role.ts),
// terminal target = THIS spec's rollout-writing fake-codex-terminal.mjs, argv log
// threaded via terminalEnv. A terminal-only fake at CODEX_CMD dies instantly on
// the codex app-server sidecar spawn -> every codex create PTY_SPAWN_FAILED.
const FAKE_CODEX_TERMINAL_SOURCE = path.resolve(__dirname, '../fixtures/fake-codex-terminal.mjs')

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

// Copied VERBATIM from remote-tab-linkage-rust.spec.ts:89-93.
/** Read the fake CLI's argv-log JSONL (empty array if not yet written). */
async function readArgvLog(logPath: string): Promise<Array<{ argv: string[] }>> {
  const raw = await fs.readFile(logPath, 'utf8').catch(() => '')
  if (!raw) return []
  return raw.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as { argv: string[] })
}

// Copied VERBATIM from codex-terminal-restore-rust.spec.ts:122.
/** Flatten a pane layout tree into its leaf nodes. */
function collectLeaves(node: any): any[] {
  if (!node) return []
  if (node.type === 'leaf') return [node]
  if (node.type === 'split') return (node.children ?? []).flatMap(collectLeaves)
  return []
}

function buildClaudeSessionJsonl(sessionId: string, cwd: string, title: string): string {
  // Donor shape: session-directory-matrix.spec.ts:36 (buildSessionJsonl).
  // Field names verified against the donor (system/init: session_id, uuid,
  // timestamp, cwd; turns: parentUuid, sessionId, cwd, message, uuid, timestamp).
  const t0 = '2026-07-20T08:00:00.000Z'
  return [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId, uuid: 'u-0', timestamp: t0, cwd }),
    JSON.stringify({ type: 'user', uuid: 'u-1', parentUuid: 'u-0', timestamp: t0, sessionId, cwd, message: { role: 'user', content: title } }),
    JSON.stringify({ type: 'assistant', uuid: 'u-2', parentUuid: 'u-1', timestamp: t0, sessionId, cwd, message: { role: 'assistant', content: [{ type: 'text', text: `${title} reply` }] } }),
  ].join('\n') + '\n'
}

const SEEDED_CODEX_THREAD_ID = randomUUID()

async function seedCodexRollout(homeDir: string, threadId: string, cwd: string): Promise<void> {
  // Donor shape: sidebar-click-resume.spec.ts ~:175-185 -- verify field
  // names (session_meta payload.id/payload.cwd + a message record) there.
  // VALIDATED: the cwd field is mandatory -- a rollout that does not parse
  // with a cwd is excluded from the index (R10b) and will NEVER appear.
  const day = '2026/07/20'
  const dir = path.join(homeDir, '.codex', 'sessions', day)
  await fs.mkdir(dir, { recursive: true })
  const lines = [
    JSON.stringify({ timestamp: '2026-07-20T08:00:00.000Z', type: 'session_meta', payload: { id: threadId, cwd } }),
    JSON.stringify({ timestamp: '2026-07-20T08:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'P114 seeded codex session' }] } }),
  ]
  await fs.writeFile(path.join(dir, `rollout-2026-07-20T08-00-00-${threadId}.jsonl`), lines.join('\n') + '\n')
}

// Decline idiom from recover-my-panes-rust.spec.ts:377 (recovery-decline).
// Why: case-c leaves its panes in server memory, and case-b's FRESH browser
// context (no client state) makes RecoveryOfferPanel offer to restore them
// ("Restore N panes from server memory?"). That dialog is a fixed inset-0
// z-[60] overlay that intercepts EVERY sidebar click, so case-b's row.click()
// retries forever and the test times out (observed on full-suite runs; the
// scenario passes standalone where server memory is empty at boot). Recovery
// semantics themselves are case-d territory (Task 8) -- here we just decline.
async function declineRecoveryOfferIfShowing(page: import('@playwright/test').Page): Promise<void> {
  const panel = page.getByTestId('recovery-offer-panel')
  // DEFLAKE (f3wp): under load the recovery overlay can render >10 s after
  // reload; a swallowed miss leaves an inset-0 z-[60] overlay intercepting
  // every later click, failing case-a far from the cause. 30 s bounds the
  // worst case; tests where no offer appears pay the wait inside a 240 s
  // per-test budget.
  const appeared = await panel.waitFor({ state: 'visible', timeout: 30_000 }).then(
    () => true,
    () => false, // standalone run: no panes in server memory, no offer
  )
  if (!appeared) return
  await page.getByTestId('recovery-decline').click()
  await panel.waitFor({ state: 'hidden', timeout: 5_000 })
}

// Copied VERBATIM from recover-my-panes-rust.spec.ts:125-131 (its `connect`).
// NOT bootAndConnect: the fresh recovery context boots UNDER the offer
// overlay, so shell-picker clicking must not run before the accept.
async function connectWithoutShellPick(
  page: import('@playwright/test').Page,
  info: { baseUrl: string; token: string },
): Promise<TestHarness> {
  await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
  const harness = new TestHarness(page)
  await harness.waitForHarness()
  await harness.waitForConnection()
  return harness
}

// Copied VERBATIM from recover-my-panes-rust.spec.ts:134-143.
/** Triage aid: log inventory request failures/non-200s (kept quiet on success). */
function traceInventoryFailures(page: import('@playwright/test').Page, label: string): void {
  page.on('response', (r) => {
    if (!r.url().includes('/api/recovery/inventory') || r.status() === 200) return
    console.log(`[${label}] inventory response ${r.status()} ${r.url()}`)
  })
  page.on('requestfailed', (req) => {
    if (!req.url().includes('/api/recovery/inventory')) return
    console.log(`[${label}] inventory request FAILED: ${req.failure()?.errorText}`)
  })
}

test.describe.serial('P1.14 sidebar registry sync (rust)', () => {
  test.setTimeout(240_000)
  let server: RustServer
  let info: TestServerInfo
  let sharedRoot: string

  test.beforeAll(async () => {
    // Same hook-timeout + prebuild pattern as recover-my-panes-rust.spec.ts:194-195:
    // the first release build of freshell-server can take minutes, and the
    // default 60s hook timeout would kill server.start() mid-build.
    test.setTimeout(600_000)
    ensureRustServerBuilt()
    sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'p114-sidebar-'))
    const binDir = path.join(sharedRoot, 'bin')
    const fakeClaude = await installFakeCli(binDir, 'claude', 'fake-claude-cli.mjs')
    // Dual-role: the codex terminal lane boots a `codex app-server` sidecar
    // first; a terminal-only fake dies on it (PTY_SPAWN_FAILED).
    const fakeCodex = await installDualRoleCodexCli(
      binDir,
      FAKE_CODEX_TERMINAL_SOURCE,
      { FAKE_CODEX_TERMINAL_ARGV_LOG: path.join(sharedRoot, 'codex-argv.jsonl') },
    )
    server = new RustServer({
      env: {
        CLAUDE_CMD: fakeClaude,
        CODEX_CMD: fakeCodex,
        FAKE_CLAUDE_ARGV_LOG: path.join(sharedRoot, 'claude-argv.jsonl'),
        FAKE_CODEX_TERMINAL_ARGV_LOG: path.join(sharedRoot, 'codex-argv.jsonl'),
        // Codex managed-launch opt-out (kata cnwc): 6a8733a3a flipped
        // FRESHELL_CODEX_MANAGED_LAUNCH's default ON (only exact "0" disables,
        // launch_plan.rs), but fake-codex-terminal.mjs only speaks the
        // plain-CLI contract (prompt + Enter-gated rollout) -- under the
        // managed app-server plan every codex create 500s
        // ("creating Codex terminal: app-server error 500"). Same pin the
        // flag-flip commit set in the Rust plain-CLI unit/integration suites
        // (set_var(FRESHELL_CODEX_MANAGED_LAUNCH, "0")).
        FRESHELL_CODEX_MANAGED_LAUNCH: '0',
      },
      setupHome: async (homeDir: string) => {
        await fs.mkdir(PROJECT_DIR, { recursive: true })
        // enable the providers the scenarios use
        const freshellDir = path.join(homeDir, '.freshell')
        await fs.mkdir(freshellDir, { recursive: true })
        await fs.writeFile(path.join(freshellDir, 'config.json'), JSON.stringify({
          version: 1,
          settings: { codingCli: { enabledProviders: ['claude', 'codex'] } },
        }, null, 2))
        // seed a claude session file for case-b (Task 6)
        const slug = PROJECT_DIR.replace(/\//g, '-')
        const projDir = path.join(homeDir, '.claude', 'projects', slug)
        await fs.mkdir(projDir, { recursive: true })
        await fs.writeFile(
          path.join(projDir, `${SEEDED_CLAUDE_ID}.jsonl`),
          buildClaudeSessionJsonl(SEEDED_CLAUDE_ID, PROJECT_DIR, 'P114 seeded claude session'))
        await fs.writeFile(
          path.join(projDir, `${SEEDED_CLAUDE_ID_D}.jsonl`),
          buildClaudeSessionJsonl(SEEDED_CLAUDE_ID_D, PROJECT_DIR, 'P114 case-d claude session'))
      },
    })
    info = await server.start()
  })

  test.afterAll(async () => {
    await server?.stop()
  })

  // Copied VERBATIM from recover-my-panes-rust.spec.ts:175-191 (capturedHome
  // -> info.homeDir; this suite's RustServer exposes the isolated HOME there).
  /**
   * Wait until SOME persisted snapshot generation contains every needle.
   * Stronger than a bare "a device dir with >=1 .json" check: pushes fire on
   * ready + every 5s, so an early generation may predate the panes under
   * test -- matching CONTENT guarantees the recoverable state actually
   * includes them before we kill the process.
   */
  async function waitForSnapshotContaining(needles: string[], timeoutMs = 30_000): Promise<void> {
    const snapshotsDir = path.join(info.homeDir, '.freshell', 'tabs-snapshots')
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const devices = await fs.readdir(snapshotsDir).catch(() => [] as string[])
      for (const device of devices) {
        const deviceDir = path.join(snapshotsDir, device)
        const files = await fs.readdir(deviceDir).catch(() => [] as string[])
        for (const f of files.filter((f) => f.endsWith('.json'))) {
          const body = await fs.readFile(path.join(deviceDir, f), 'utf8').catch(() => '')
          if (needles.every((n) => body.includes(n))) return
        }
      }
      await new Promise((r) => setTimeout(r, 500))
    }
    throw new Error(`No tabs-snapshot generation contained [${needles.join(', ')}] within ${timeoutMs}ms`)
  }

  // Copied VERBATIM from recover-my-panes-rust.spec.ts:215-226.
  /**
   * SERVICE WORKERS ARE BLOCKED in the fresh recovery context: the production
   * client registers /sw.js and RELOADS on `controllerchange` (pwa.ts). On a
   * FRESH context that reload races App mount, aborting in-flight boot fetches
   * (observed in the donor: the recovery-inventory fetch dying with
   * net::ERR_ABORTED) -- and the panel's fetch is deliberately one-shot
   * best-effort, so a lost race means no offer for that boot. Blocking the SW
   * removes the reload entirely; recovery behavior never depends on the SW.
   */
  const FRESH_CONTEXT_OPTIONS = { serviceWorkers: 'block' as const }

  // Copied VERBATIM from recover-my-panes-rust.spec.ts:228-246 (its
  // openFreshContextWithOffer; connect -> connectWithoutShellPick).
  /**
   * Open a FRESH context (empty storage) and REQUIRE the recovery offer --
   * one context, one hard `toBeVisible` assertion. No retry loop: with
   * service workers blocked (above) the only known cause of transient offer
   * suppression is gone, and a retry here would quietly absorb exactly the
   * flaky-offer regression class this feature already exhibited once.
   */
  async function openFreshContextWithOffer(
    browser: import('@playwright/test').Browser,
    label: string,
  ): Promise<{ ctx: import('@playwright/test').BrowserContext; page: import('@playwright/test').Page; harness: TestHarness }> {
    const ctx = await browser.newContext(FRESH_CONTEXT_OPTIONS)
    const page = await ctx.newPage()
    traceInventoryFailures(page, label)
    const harness = await connectWithoutShellPick(page, info)
    await expect(page.getByTestId('recovery-offer-panel')).toBeVisible({ timeout: 15_000 })
    return { ctx, page, harness }
  }

  test('case-c: fresh codex terminal collapses to a single green row', async ({ page }) => {
    const harness = await bootAndConnect(page, info)

    // REST-create a fresh codex terminal tab (no resume id) --
    // request shape: donor remote-tab-linkage-rust.spec.ts:197.
    const res = await page.request.post(`${info.baseUrl}/api/tabs`, {
      headers: { 'x-auth-token': info.token, 'content-type': 'application/json' },
      data: { mode: 'codex', cwd: PROJECT_DIR },
    })
    expect(res.ok()).toBe(true)
    const body = await res.json()
    const restTabId: string = body?.data?.tabId
    expect(restTabId).toBeTruthy()

    // Wait for the codex PTY to attach and print its prompt BEFORE typing --
    // same gate as donor codex-terminal-restore-rust.spec.ts:226-229. An
    // Enter typed before the PTY attaches is dropped, and the fixture only
    // writes its rollout on the FIRST Enter, so an early keypress would
    // strand the pane without an identity artifact (observed flake).
    let codexTerminalId: string | null = null
    await expect.poll(async () => {
      const layout = await harness.getPaneLayout(restTabId)
      const leaf = collectLeaves(layout).find((l) => l?.content?.mode === 'codex')
      codexTerminalId = leaf?.content?.terminalId ?? null
      return codexTerminalId
    }, { timeout: 20_000 }).toBeTruthy()
    await expect.poll(async () => {
      const buffer = await harness.getTerminalBuffer(codexTerminalId!)
      return typeof buffer === 'string' && buffer.includes('codex> ')
    }, { timeout: 15_000 }).toBe(true)

    // The driven client shows the pane; type Enter so the fake codex
    // terminal materializes its rollout (Enter-gated, fixture contract).
    // NOTE: multiple .xterm elements stay mounted (every tab's TabContent is
    // kept alive, App.tsx:1611) -- always scope with .last()/.first() or
    // Playwright strict mode throws (donor: remote-tab-linkage-rust.spec.ts:179).
    await expect(page.locator('.xterm').last()).toBeVisible({ timeout: 20_000 })
    await page.locator('.xterm').last().click()
    await page.keyboard.press('Enter')

    // THE CONTRACT: eventually exactly ONE codex sidebar row, green, and
    // no provisional `terminal:<id>` row left behind -- WITHOUT a reload
    // (proves arming+adoption (Task 4), the stamped feed (Task 2), the
    //  verified client fold, and the no-reload push (Task 3)).
    await expect(async () => {
      const rows = page.locator('[data-provider="codex"][data-session-id]')
      const count = await rows.count()
      expect(count).toBe(1)
      await expect(rows.first()).toHaveAttribute('data-has-tab', 'true')
      const sessionId = await rows.first().getAttribute('data-session-id')
      expect(sessionId?.startsWith('terminal:')).toBe(false)
    }).toPass({ timeout: 45_000 })
  })

  test('case-b: REST-created resume tabs are green and dedupe on click', async ({ page }) => {
    const harness = await bootAndConnect(page, info) // keep the TestHarness -- the dedupe gate below needs it
    await declineRecoveryOfferIfShowing(page) // case-c's server-memory panes trigger the offer overlay
    await seedCodexRollout(info.homeDir, SEEDED_CODEX_THREAD_ID, PROJECT_DIR)

    for (const [mode, sessionId] of [
      ['claude', SEEDED_CLAUDE_ID],
      ['codex', SEEDED_CODEX_THREAD_ID],
    ] as const) {
      const res = await page.request.post(`${info.baseUrl}/api/tabs`, {
        headers: { 'x-auth-token': info.token, 'content-type': 'application/json' },
        // VALIDATED: raw codex resumeSessionId is deliberately 400-rejected at
        // HEAD (terminal_tabs.rs:124-131, pinned by
        // create_codex_tab_rejects_raw_resume_session_id_without_session_ref);
        // the canonical sessionRef shape IS accepted (pinned by
        // create_codex_tab_accepts_session_ref_and_derives_resume_args). Do NOT
        // "fix" the rejection -- use the canonical shape. kata ejh6: claude
        // rides sessionRef too -- sessionRef is the canonical resume carrier
        // for EVERY mode.
        data: { mode, cwd: PROJECT_DIR, sessionRef: { provider: mode, sessionId } },
      })
      expect(res.ok(), `POST /api/tabs ${mode} resume: ${res.status()} ${await res.text()}`).toBe(true)

      const row = page.locator(`[data-session-id="${sessionId}"][data-provider="${mode}"]`)
      // Incident-4 contract: the row exists and is GREEN, not grey.
      await expect(row).toHaveAttribute('data-has-tab', 'true', { timeout: 30_000 })
      await expect(row).toHaveCount(1)

      // Dedupe contract: clicking the green row focuses the existing pane
      // instead of opening a second tab (donor: remote-tab-linkage:252-255).
      // getTabCount() is a NODE-SIDE TestHarness method
      // (helpers/test-harness.ts:150-155) that reads
      // window.__FRESHELL_TEST_HARNESS__?.getState() inside the page. The
      // window global itself has NO getTabCount method (src/lib/test-harness.ts
      // exposes getState/dispatch/getWsReadyState/...), so never call
      // getTabCount via page.evaluate -- that throws on every run.
      // Fail-loud guard: getTabCount() returns 0 when the harness is missing,
      // so pin tabsBefore > 0 (this loop just created tabs) to make a vacuous
      // 0 === 0 pass impossible.
      const tabsBefore = await harness.getTabCount()
      expect(tabsBefore).toBeGreaterThan(0)
      await row.click()
      await page.waitForTimeout(500)
      const tabsAfter = await harness.getTabCount()
      expect(tabsAfter).toBe(tabsBefore)
    }
  })

  test('case-a: sidebar joins survive a graceful server restart', async ({ page }) => {
    await bootAndConnect(page, info)
    // Server memory still holds panes from case-b/case-c on this shared
    // serial server, so the fresh browser context gets the recovery offer
    // overlay -- decline it (same reasoning as case-b; recovery semantics
    // are case-d territory).
    await declineRecoveryOfferIfShowing(page)

    // Panes from case-b/case-c are still open in this serial suite's page state?
    // No -- each test gets a fresh page. Re-establish: open both resume tabs.
    // NOTE (#540, ks38): re-POSTing a resume tab for a session whose earlier
    // terminal is still alive is now 409-REJECTED by the D7 live-session guard
    // on the REST resume path (one-JSONL-writer doctrine) -- the pre-#540
    // "spawns unconditionally + ERROR-log" behavior this test originally
    // leaned on is gone. Kill the earlier cases' live owners first (WS
    // terminal.kill through the harness socket), then resume cleanly.
    // Kill EVERY running terminal, not just those whose directory item carries
    // a sessionRef: a pre-adoption codex terminal hides its resume id from the
    // REST directory JSON (sessionRef omitted until the B2 locator adopts),
    // yet the D7 guard's row arm still sees it as the live owner.
    const liveOwners = async (): Promise<string[]> => {
      const res = await page.request.get(`${info.baseUrl}/api/terminals`, {
        headers: { 'x-auth-token': info.token },
      })
      expect(res.ok()).toBe(true)
      const items: Array<{ terminalId: string; status: string }> = await res.json()
      return items.filter((i) => i.status === 'running').map((i) => i.terminalId)
    }
    for (const terminalId of await liveOwners()) {
      await page.evaluate((tid) => {
        (window as any).__FRESHELL_TEST_HARNESS__?.sendWsMessage({ type: 'terminal.kill', terminalId: tid })
      }, terminalId)
    }
    await expect(async () => {
      expect(await liveOwners()).toHaveLength(0)
    }).toPass({ timeout: 15_000 })

    for (const [mode, sessionId] of [
      ['claude', SEEDED_CLAUDE_ID],
      ['codex', SEEDED_CODEX_THREAD_ID],
    ] as const) {
      const res = await page.request.post(`${info.baseUrl}/api/tabs`, {
        headers: { 'x-auth-token': info.token, 'content-type': 'application/json' },
        // VALIDATED: raw codex resumeSessionId is deliberately 400-rejected at
        // HEAD (terminal_tabs.rs:124-131, pinned by
        // create_codex_tab_rejects_raw_resume_session_id_without_session_ref);
        // the canonical sessionRef shape IS accepted (pinned by
        // create_codex_tab_accepts_session_ref_and_derives_resume_args). Do NOT
        // "fix" the rejection -- use the canonical shape. kata ejh6: claude
        // rides sessionRef too -- sessionRef is the canonical resume carrier
        // for EVERY mode.
        data: { mode, cwd: PROJECT_DIR, sessionRef: { provider: mode, sessionId } },
      })
      expect(res.ok(), `POST /api/tabs ${mode} resume: ${res.status()} ${await res.text()}`).toBe(true)
      await expect(page.locator(`[data-session-id="${sessionId}"][data-provider="${mode}"]`))
        .toHaveAttribute('data-has-tab', 'true', { timeout: 30_000 })
    }

    // Persist the layout before the restart (donor VERBATIM:
    // remote-tab-linkage-rust.spec.ts:277-281). The dispatch goes through the
    // window harness global __FRESHELL_TEST_HARNESS__ -- there is NO
    // __freshellStore global anywhere in src/ or test/. The layout assertion
    // immediately after makes the flush observable: if the harness were
    // missing and the dispatch silently no-opped, persistedLayout would be
    // null and this fails loudly instead of riding on debounced persist timing.
    await page.evaluate(() => {
      (window as any).__FRESHELL_TEST_HARNESS__?.dispatch({ type: 'persist/flushNow' })
    })
    const persistedLayout = await page.evaluate(() => localStorage.getItem('freshell.layout.v3'))
    expect(persistedLayout, 'persisted layout must exist after flush').toBeTruthy()

    // Snapshot the --resume count BEFORE the restart. The argv log is shared
    // across the whole serial suite (case-b already resumed SEEDED_CLAUDE_ID
    // once, and this test's own pre-restart create adds another), so any
    // absolute threshold is satisfied before the restart even happens and
    // would pass vacuously. Only a before/after increase proves the respawn.
    const countResumes = (entries: Array<{ argv: string[] }>) =>
      entries.filter((e) => {
        const i = e.argv.indexOf('--resume')
        return i !== -1 && e.argv[i + 1] === SEEDED_CLAUDE_ID
      }).length
    const resumesBefore = countResumes(await readArgvLog(path.join(sharedRoot, 'claude-argv.jsonl')))

    await server.restart()
    await page.reload({ waitUntil: 'domcontentloaded' })

    // Wait for WS to reconnect and reach 'ready' state
    // (copied VERBATIM from server-restart-recovery.spec.ts:106-111).
    await expect(async () => {
      const status = await page.evaluate(() =>
        window.__FRESHELL_TEST_HARNESS__?.getWsReadyState()
      )
      expect(status).toBe('ready')
    }).toPass({ timeout: 30_000 })

    // THE CONTRACT: every session is green again, exactly once.
    for (const [mode, sessionId] of [
      ['claude', SEEDED_CLAUDE_ID],
      ['codex', SEEDED_CODEX_THREAD_ID],
    ] as const) {
      const row = page.locator(`[data-session-id="${sessionId}"][data-provider="${mode}"]`)
      try {
        await expect(row).toHaveAttribute('data-has-tab', 'true', { timeout: 45_000 })
        await expect(row).toHaveCount(1, { timeout: 45_000 })
      } catch (error) {
        // DEFLAKE-DIAG (f3wp refresh): a bare "element not found" here is
        // undiagnosable -- it cannot distinguish (a) the server's directory
        // index not listing the seeded session, from (b) the respawned
        // terminal's identity never being adopted (row stuck provisional),
        // from (c) the client's one-shot sessions fetch having missed/lost
        // the data with no sessions.changed repair. Dump all three layers
        // before rethrowing so a recurrence pins the layer that lost it.
        const dumpDirectory = async (label: string, params: string) =>
          page.request
            .get(`${info.baseUrl}/api/session-directory?${params}`, { headers: { 'x-auth-token': info.token } })
            .then(async (r) => {
              const body: any = await r.json().catch(() => null)
              const items = Array.isArray(body?.items) ? body.items : []
              return `${label}: status=${r.status()} items=${JSON.stringify(items.map((it: any) => ({
                sessionId: it.sessionId, provider: it.provider, liveTerminalOnly: it.liveTerminalOnly,
                isRunning: it.isRunning, runningTerminalId: it.runningTerminalId, title: it.title,
              })))}`
            })
            .catch((e) => `${label}: <fetch failed: ${e}>`)
        // Same query shape the client sends (sessionsThunks -> getSessionDirectoryPage).
        const dirDump = await dumpDirectory('client-shaped', 'priority=visible&limit=50')
        // Unfiltered variant: distinguishes "not indexed" from "indexed but filtered".
        const dirDumpAll = await dumpDirectory(
          'permissive',
          'priority=visible&limit=50&includeEmpty=1&includeNonInteractive=1&includeSubagents=1',
        )
        // Disk truth: what transcript files exist in the isolated HOME right now.
        const listDisk = async (root: string): Promise<string[]> => {
          const out: string[] = []
          const walk = async (dir: string): Promise<void> => {
            const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
            for (const e of entries) {
              const p = path.join(dir, e.name)
              if (e.isDirectory()) await walk(p)
              else out.push(p)
            }
          }
          await walk(root)
          return out
        }
        const diskDump = JSON.stringify({
          codex: await listDisk(path.join(info.homeDir, '.codex', 'sessions')),
          claude: await listDisk(path.join(info.homeDir, '.claude', 'projects')),
        })
        const termDump = await page.request
          .get(`${info.baseUrl}/api/terminals`, { headers: { 'x-auth-token': info.token } })
          .then(async (r) => {
            const body: any = await r.json().catch(() => null)
            const items = Array.isArray(body) ? body : []
            return `status=${r.status()} terminals=${JSON.stringify(items.map((t: any) => ({
              terminalId: t.terminalId, mode: t.mode, status: t.status, sessionRef: t.sessionRef,
            })))}`
          })
          .catch((e) => `<fetch failed: ${e}>`)
        const reduxDump = await page
          .evaluate(() => {
            const state = (window as any).__FRESHELL_TEST_HARNESS__?.getState()
            const summarize = (projects: any[]) => (projects ?? []).map((p: any) => ({
              projectPath: p.projectPath,
              sessions: (p.sessions ?? []).map((s: any) => ({
                sessionId: s.sessionId, provider: s.provider, liveTerminalOnly: s.liveTerminalOnly,
              })),
            }))
            return JSON.stringify({
              projects: summarize(state?.sessions?.projects),
              sidebarWindow: summarize(state?.sessions?.windows?.sidebar?.projects),
              sidebarWindowError: state?.sessions?.windows?.sidebar?.error ?? null,
            })
          })
          .catch((e) => `<eval failed: ${e}>`)
        const domDump = await page
          .evaluate(() =>
            JSON.stringify(Array.from(document.querySelectorAll('[data-session-id]')).map((el) => ({
              sessionId: el.getAttribute('data-session-id'),
              provider: el.getAttribute('data-provider'),
              hasTab: el.getAttribute('data-has-tab'),
              isRunning: el.getAttribute('data-is-running'),
            }))))
          .catch((e) => `<eval failed: ${e}>`)
        // Server-side truth: the restarted process's own log (index warm
        // count, request lines) -- read directly from the isolated HOME.
        const serverLogDump = await fs
          .readFile(path.join(info.homeDir, '.freshell', 'logs', 'rust-server.jsonl'), 'utf8')
          .then((raw) => {
            const lines = raw.trim().split('\n')
            const warm = lines.filter((l) => l.includes('session_index_warm'))
            return `warm=[${warm.join(', ')}] tail=[${lines.slice(-8).join(', ')}]`
          })
          .catch((e) => `<read failed: ${e}>`)
        throw new Error(
          `case-a post-restart ${mode} row assertion failed -- diagnostics:\n` +
            `  server /api/session-directory (${dirDump})\n` +
            `  server /api/session-directory (${dirDumpAll})\n` +
            `  disk transcripts: ${diskDump}\n` +
            `  server /api/terminals: ${termDump}\n` +
            `  redux sessions: ${reduxDump}\n` +
            `  DOM [data-session-id] rows: ${domDump}\n` +
            `  server log: ${serverLogDump}\n` +
            `Original error: ${error}`,
        )
      }
    }
    // No provisional ghosts left over from respawned terminals.
    await expect(page.locator('[data-provider="codex"][data-session-id^="terminal:"]')).toHaveCount(0, { timeout: 45_000 })

    // Respawn proof: the fake claude CLI was relaunched with --resume AFTER the
    // restart -- assert the count INCREASED relative to the pre-restart
    // snapshot (an absolute >=N threshold would already be met pre-restart and
    // prove nothing about the respawn).
    // DEFLAKE (f3wp): sidebar rows go green from the ledger/registry join
    // BEFORE the respawned `claude --resume` has necessarily exec'd and
    // flushed its argv line -- a one-shot read raced that flush under load.
    // Same assertion strength (before/after delta), now polled.
    await expect
      .poll(
        async () =>
          countResumes(await readArgvLog(path.join(sharedRoot, 'claude-argv.jsonl'))),
        { timeout: 30_000 },
      )
      .toBeGreaterThan(resumesBefore)
  })

  // KEEP THIS SCENARIO LAST in the serial suite: it destroys the local
  // client layout (the "lost client" is simulated by abandoning the boot
  // context entirely) and SIGKILLs the server.
  test('case-d: recovered panes join green in the sidebar', async ({ page, browser }) => {
    await bootAndConnect(page, info)
    // Pre-restart boot offer: earlier cases' panes are still in server memory,
    // so THIS boot gets a recovery offer too. Decline it -- it is suite-order
    // noise, NOT the offer under test. The offer case-d ACCEPTS is the
    // post-abrupt-restart one, which appears in the FRESH context below; the
    // decline dismissal lives only in this page's storage, which that fresh
    // context never sees (donor scenario 3 relies on the same isolation).
    await declineRecoveryOfferIfShowing(page)

    // #540's D7 live-session guard (70c43c656) 409-rejects this test's resume
    // create while case-a's respawned claude terminal still owns
    // SEEDED_CLAUDE_ID -- kill the earlier serial cases' live owners first,
    // VERBATIM case-a's #540 reconciliation above (WS terminal.kill through
    // the harness socket, EVERY running terminal: a pre-adoption codex
    // terminal hides its resume id from the REST directory JSON, yet the D7
    // guard's row arm still sees it as the live owner). Latent since #540 --
    // only reachable once case-a passes again, which the cnwc managed-launch
    // pin restores.
    const liveOwners = async (): Promise<string[]> => {
      const res = await page.request.get(`${info.baseUrl}/api/terminals`, {
        headers: { 'x-auth-token': info.token },
      })
      expect(res.ok()).toBe(true)
      const items: Array<{ terminalId: string; status: string }> = await res.json()
      return items.filter((i) => i.status === 'running').map((i) => i.terminalId)
    }
    for (const terminalId of await liveOwners()) {
      await page.evaluate((tid) => {
        (window as any).__FRESHELL_TEST_HARNESS__?.sendWsMessage({ type: 'terminal.kill', terminalId: tid })
      }, terminalId)
    }
    await expect(async () => {
      expect(await liveOwners()).toHaveLength(0)
    }).toPass({ timeout: 15_000 })

    // Open a claude resume pane so there is something to lose + recover.
    const res = await page.request.post(`${info.baseUrl}/api/tabs`, {
      headers: { 'x-auth-token': info.token, 'content-type': 'application/json' },
      data: { mode: 'claude', cwd: PROJECT_DIR, sessionRef: { provider: 'claude', sessionId: SEEDED_CLAUDE_ID_D } },
    })
    expect(res.ok(), `POST /api/tabs claude resume: ${res.status()} ${await res.text()}`).toBe(true)
    const restTabId: string = (await res.json())?.data?.tabId
    expect(restTabId).toBeTruthy()
    await expect(page.locator(`[data-session-id="${SEEDED_CLAUDE_ID_D}"][data-provider="claude"]`))
      .toHaveAttribute('data-has-tab', 'true', { timeout: 30_000 })

    // Disk-settle before the kill (donor: recover-my-panes-rust.spec.ts:275-287):
    // the ledger binding row for the session, then a snapshot generation whose
    // CONTENT includes THIS test's pane. Needle on restTabId too: earlier
    // cases' generations already contain SEEDED_CLAUDE_ID_D, so the sessionId
    // alone would match a stale generation and the wait would be vacuous.
    await expect(async () => {
      const dir = path.join(info.homeDir, '.freshell', 'pane-ledger', 'bindings', 'claude')
      const rows = await fs.readdir(dir, { recursive: true }).catch(() => [] as string[])
      expect(rows.map(String).some((f) => f.includes(SEEDED_CLAUDE_ID_D))).toBe(true)
    }).toPass({ timeout: 15_000 })
    await waitForSnapshotContaining([SEEDED_CLAUDE_ID_D, restTabId])

    // Lost client + abrupt server death. Closing the WHOLE context (donor
    // :290) is the validated lost-client simulation: the fresh context below
    // starts with empty localStorage (no freshell.layout.*) AND empty
    // sessionStorage -- the clientInstanceId persists in sessionStorage
    // (tabRegistrySync.ts:42-92), and if it survived, the server's
    // self-pollution filter (recovery_inventory.rs:30-33) would drop this
    // client's own generations and NO recovery offer would ever appear.
    await page.context().close()
    await server.restartAbrupt()

    // Fresh context = new machine; the offer is REQUIRED. ACCEPT it.
    const { ctx, page: page2 } = await openFreshContextWithOffer(browser, 'case-d')
    const panel = page2.getByTestId('recovery-offer-panel')
    await expect(panel.getByRole('heading')).toHaveText(/restore \d+ pane/i)
    await page2.getByTestId('recovery-accept').click()
    await expect(panel).toHaveCount(0)

    // Panes recreated: a recovered terminal pane MOUNTS. The donor (:305)
    // asserts visibility, but there the recovered tab is the active one; on
    // this shared serial server the recovery set includes earlier cases'
    // picker-bearing "New Tab" generations, and the active tab after accept
    // can be one of those pickers while the recovered claude terminal mounts
    // in a background tab. Every tab's TabContent stays alive (App.tsx:1611),
    // so ATTACHMENT is the recreate signal here -- visibility would fail on a
    // mounted-but-backgrounded terminal (observed on the first full-suite run).
    await expect(page2.locator('.xterm').first()).toBeAttached({ timeout: 30_000 })

    // THE CONTRACT: the recovered session is green again, exactly once.
    const row = page2.locator(`[data-session-id="${SEEDED_CLAUDE_ID_D}"][data-provider="claude"]`)
    await expect(row).toHaveAttribute('data-has-tab', 'true', { timeout: 45_000 })
    await expect(row).toHaveCount(1)

    await ctx.close()
  })
})
