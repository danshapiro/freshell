/**
 * B3/P1.9 recover-my-panes — the campaign's first browser-loss recovery e2e
 * (docs/plans/2026-07-26-recover-my-panes.md, Task 8).
 *
 * Scenario 1 (accept path): a browser with a claude CLI pane + a browser pane
 * is LOST (context closed), the server restarts, and a fresh browser context
 * (empty storage = new machine) is OFFERED recovery — accepting recreates the
 * panes, resumes the dead claude session (`--resume <sessionId>` argv proof +
 * the fake CLI's scrollback marker), recreates the mixed-kind browser pane,
 * and a same-browser reload never re-offers (localStorage now has a layout).
 *
 * Scenario 2 (decline path): a fresh context declines — the panel closes and
 * no recovered tabs are added.
 *
 * Scenario 3 (no-restart browser loss, live exclusion): the browser is lost
 * WITHOUT a server restart, so D's claude PTY stays Running (registry-owned)
 * and its pane verdicts LIVE. Live panes are excluded from restore for EVERY
 * kind (delta-r6-r3): the offer lists only D's UNIDENTIFIED shell pane under
 * the not-restored live note, accepting recreates the shell — and NEVER a
 * second claude on top of the still-running session (argv-log proof: no
 * fresh spawn past the watermark, never `--resume <sessionIdD>`). The live
 * session stays available as a background session.
 *
 * Scenario 4 (phone containment, R1/R3): a populating context records a
 * 40-shell-tab layout and is lost WITHOUT a server restart; a fresh
 * 390x844-viewport context is then offered the layout — the dialog must fit
 * the viewport (bounding box), the records list must scroll internally
 * (`scrollHeight > clientHeight`), and the decline control must be tappable
 * (Playwright actionability IS the user-level phone proof). The inventory
 * must OVERFLOW the dialog's 80vh-capped list budget (~525px at 844px tall,
 * ~24px/record) to exercise containment at all — 20 records measure ~500px
 * and fit under the cap, making every scroll/bounding assertion vacuous
 * (identical metrics with and without the containment classes). Every
 * close→required-offer transition without a restart is preceded by the
 * file-local `waitForRecoverable` probe-poll guard (R2a) so WS-teardown lag
 * can never starve a later boot's required offer.
 *
 * Scenario 5 (stale never-open ledger row pin, D8): a freshclaude pane is
 * created, proven snapshot-open, then closed OUTSIDE the judgment's grace
 * window (a 15s gate) via the PLAIN pane-X — the pane row is left
 * unreferenced by the newest-per-client union (and, since the retire-on-kill
 * repair, additionally retired Closed at the kill). After a server restart
 * the recovery inventory's ledgerOnly bucket (and the offer built from it)
 * must NOT offer that row. First pinned RED against the pre-judgment blanket
 * bucket; the parent-relative judgment
 * (docs/plans/2026-09-02-restore-open-sessions-only.md, Task 3) turned it
 * GREEN.
 *
 * Kill-window pin (delta-review round 5, "retire-on-kill"): a freshclaude
 * pane is created and closed PROMPTLY (inside the 7s creation-race grace
 * window — the immediate post-close evidence cannot distinguish "never
 * snapshotted" from "just closed"), the browser is lost and the server is
 * SIGKILLed. The explicit freshAgent.kill retires the pane's ledger row
 * Closed, so the inventory never offers it and accepting the offer never
 * recreates it. Pinned RED pre-repair: the kill left the row Bound, and
 * inside the grace window the parent-relative judgment kept it.
 *
 * Fixture shapes (fake CLI, config seeding, shell-picker choreography) are
 * COPIED from pane-ledger-restart-rust.spec.ts per this suite's
 * per-spec-ownership convention. The freshclaude helpers
 * (findFreshAgentLeaf, createFreshclaudePane) are COPIED from
 * hidden-pane-rebind-rust.spec.ts under the same convention.
 *
 * Rust-only: drives `GET /api/recovery/inventory` (no legacy equivalent) and
 * owns a RustServer directly (ephemeral loopback port — NEVER 3001/3002).
 * Registered ONLY under `rust-chromium` and testIgnore'd on every match-all
 * project (see playwright.config.ts's RUST_ONLY_SPECS).
 */
import { test, expect } from '../helpers/fixtures.js'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { fileURLToPath } from 'node:url'
import { request, type BrowserContext, type Page } from '@playwright/test'
import { RustServer, ensureRustServerBuilt } from '../helpers/rust-server.js'
import type { TestServerInfo } from '../helpers/test-server.js'
import { TestHarness } from '../helpers/test-harness.js'
import { openPanePicker } from '../helpers/pane-picker.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** Donor: pane-ledger-restart-rust.spec.ts:29 */
async function installFakeCli(binDir: string, name: string, source: string): Promise<string> {
  await fs.mkdir(binDir, { recursive: true })
  const target = path.join(binDir, name)
  await fs.copyFile(path.resolve(__dirname, '../fixtures', source), target)
  await fs.chmod(target, 0o755)
  return target
}

/** Donor: pane-ledger-restart-rust.spec.ts:37 */
function seedConfig() {
  return async (homeDir: string): Promise<void> => {
    const freshellDir = path.join(homeDir, '.freshell')
    await fs.mkdir(freshellDir, { recursive: true })
    await fs.writeFile(
      path.join(freshellDir, 'config.json'),
      JSON.stringify(
        {
          version: 1,
          settings: {
            codingCli: { enabledProviders: ['claude', 'codex', 'opencode'] },
            // freshAgent.enabled gates the WS freshAgent.create dispatch
            // (scenario 5's freshclaude pane). Inert for scenarios 1-4 —
            // nothing in them issues a fresh-agent create.
            freshAgent: { enabled: true },
          },
        },
        null,
        2,
      ),
    )
  }
}

/**
 * Donor: pane-ledger-restart-rust.spec.ts:65 (load-bearing comment there):
 * a live shell terminal's cwd pre-fills the Starting-directory combobox the
 * CLI-pane creates below depend on.
 */
async function selectShellIfPickerShowing(page: Page): Promise<void> {
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

/** Donor: pane-ledger-restart-rust.spec.ts:81 */
async function openCliPane(page: Page, buttonName: RegExp): Promise<void> {
  const picker = await openPanePicker(page)
  await picker.getByRole('button', { name: buttonName }).click({ force: true })
  await page.getByRole('combobox', { name: /Starting directory/i }).press('Enter')
}

/** Read the fake CLI's argv-log JSONL (empty array if not yet written). */
async function readArgvLog(logPath: string): Promise<Array<{ argv: string[] }>> {
  const raw = await fs.readFile(logPath, 'utf8').catch(() => '')
  if (!raw) return []
  return raw.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as { argv: string[] })
}

/**
 * Claude-adapted adjacent-pair matcher (per the task brief's Interfaces): the
 * fake claude CLI receives the `--resume <id>` FLAG (fake-claude-cli.mjs:26-30)
 * — NOT codex's bare `resume` subcommand token, so a codex-style
 * `resume <id>` adjacent-pair matcher would never match here.
 */
const hasClaudeResumePair = (argv: string[], sessionId: string) => {
  const i = argv.indexOf('--resume')
  return i !== -1 && argv[i + 1] === sessionId
}

/** `--session-id <id>` values, in order, from a slice of argv-log entries. */
function sessionIdsOf(entries: Array<{ argv: string[] }>): string[] {
  return entries.flatMap((e) => {
    const i = e.argv.indexOf('--session-id')
    return i >= 0 ? [e.argv[i + 1]] : []
  })
}

/** Boot a page against the server (donor: the retired snapshot-restore-rust spec). */
async function connect(page: Page, info: { baseUrl: string; token: string }): Promise<TestHarness> {
  await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
  const harness = new TestHarness(page)
  await harness.waitForHarness()
  await harness.waitForConnection()
  return harness
}

/** Triage aid: log inventory request failures/non-200s (kept quiet on success). */
function traceInventoryFailures(page: Page, label: string): void {
  page.on('response', (r) => {
    if (!r.url().includes('/api/recovery/inventory') || r.status() === 200) return
    console.log(`[${label}] inventory response ${r.status()} ${r.url()}`)
  })
  page.on('requestfailed', (req) => {
    if (!req.url().includes('/api/recovery/inventory')) return
    console.log(`[${label}] inventory request FAILED: ${req.failure()?.errorText}`)
  })
}

/** Create the browser pane the way a user would (browser-pane.spec.ts:8). */
async function createBrowserPane(page: Page, url: string): Promise<void> {
  const picker = await openPanePicker(page)
  await picker.getByRole('button', { name: /^Browser$/i }).click({ force: true })
  const urlInput = page.getByPlaceholder('Enter URL...')
  await expect(urlInput).toBeVisible({ timeout: 10_000 })
  await urlInput.fill(url)
  await urlInput.press('Enter')
  const iframe = page.locator('iframe[title="Browser content"]')
  await iframe.waitFor({ state: 'attached', timeout: 10_000 })
}

/** Donor: hidden-pane-rebind-rust.spec.ts:118 — layout tree walker. */
function findFreshAgentLeaf(node: any): any {
  if (!node) return null
  if (node.type === 'leaf' && node.content?.kind === 'fresh-agent') return node
  if (node.type === 'split') {
    for (const child of node.children ?? []) {
      const found = findFreshAgentLeaf(child)
      if (found) return found
    }
  }
  return null
}

/**
 * Donor: hidden-pane-rebind-rust.spec.ts:153 (fixture: fake-claude-sidecar.mjs
 * via the production env seam FRESHELL_CLAUDE_SIDECAR).
 */
async function createFreshclaudePane(page: Page, harness: TestHarness, cwd: string): Promise<void> {
  // setAvailableClis is client-only AND gets overwritten by the app
  // bootstrap + /api/platform fetch (App.tsx:572,609). Callers reach this
  // helper only after harness.waitForConnection(), which is what makes the
  // dispatch land AFTER those overwrites (donor ordering:
  // freshopencode-restart-recovery.spec.ts:100-115). Keep it that way.
  await page.evaluate(() => {
    ;(window as any).__FRESHELL_TEST_HARNESS__?.dispatch({
      type: 'connection/setAvailableClis',
      payload: { claude: true, codex: false },
    })
  })
  const picker = await openPanePicker(page)
  await picker.getByRole('button', { name: /^Freshclaude$/i }).click({ force: true })
  // /api/files/candidate-dirs returns [] on a clean isolated HOME (no $HOME
  // fallback, crates/freshell-server/src/files.rs:15-26), so a "first
  // option" may not exist — TYPE the cwd and press Enter instead (donor:
  // freshopencode-restart-recovery.spec.ts:117-124).
  const directoryInput = page.getByLabel(/^Starting directory for Freshclaude$/i)
  await expect(directoryInput).toBeVisible({ timeout: 15_000 })
  await directoryInput.fill(cwd)
  await directoryInput.press('Enter')
  await expect(page.locator('[data-context="fresh-agent"]').last()).toBeVisible({
    timeout: 15_000,
  })
  // NOTE: the thread-snapshot fetch can 503 on a healthy fresh pane (no
  // claude adapter in the Rust snapshot router) and surface a history-load
  // banner. Assert pane state via the harness (Redux), tolerate the banner —
  // never assert error-free UI chrome for freshclaude.
}

/**
 * Close→required-offer guard (teardown-lag pin): poll
 * `GET /api/recovery/inventory` with a PROBE clientInstanceId until the last
 * closed context's records resolve as recoverable, so a later boot that
 * REQUIRES the offer can never race WS-teardown lag. Uses a STANDALONE
 * APIRequestContext — NOT `page.request` (its handle dies with the page's
 * browser context) and NOT a navigated page (a booted page would register as
 * a tracked tabs.sync client and entangle the very inventory it polls); the
 * probe is a plain auth'd GET that never opens a WS socket, so it leaves no
 * connected-state of its own. Disposed after use.
 */
async function waitForRecoverable(
  info: TestServerInfo,
  { timeoutMs = 30_000 }: { timeoutMs?: number } = {},
): Promise<void> {
  const req = await request.newContext({
    baseURL: info.baseUrl,
    extraHTTPHeaders: { 'x-auth-token': info.token },
  })
  try {
    const deadline = Date.now() + timeoutMs
    let lastPayload: unknown
    while (Date.now() < deadline) {
      const res = await req
        .get('/api/recovery/inventory?clientInstanceId=freshell-test-probe&bootAgoMs=0')
        .catch(() => null)
      if (res?.ok()) {
        const body = (await res.json().catch(() => null)) as { recoverable?: unknown } | null
        lastPayload = body
        if (body?.recoverable === true) return
      }
      await new Promise((r) => setTimeout(r, 500))
    }
    throw new Error(
      `waitForRecoverable: inventory never reported recoverable=true within ${timeoutMs}ms; `
      + `last payload: ${JSON.stringify(lastPayload)}`,
    )
  } finally {
    await req.dispose()
  }
}

test.describe('recover-my-panes browser-loss recovery (rust only)', () => {
  // Scenarios share ONE owned server and build on each other's durable state
  // (snapshots, ledger rows, a still-running PTY) — strict ordering required.
  test.describe.configure({ mode: 'serial' })

  let sharedRoot = ''
  let capturedHome = ''
  let argLog = ''
  let server: RustServer
  let info: TestServerInfo

  /**
   * Wait until SOME persisted snapshot generation contains every needle.
   * Stronger than the brief's minimum (a device dir with >=1 .json): pushes
   * fire on ready + every 5s, so an early generation may predate the panes
   * under test — matching CONTENT guarantees the recoverable state actually
   * includes them before we kill the context.
   */
  async function waitForSnapshotContaining(needles: string[], timeoutMs = 30_000): Promise<void> {
    const snapshotsDir = path.join(capturedHome, '.freshell', 'tabs-snapshots')
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

  /**
   * Wait until the NEWEST persisted tabs-snapshot generation FOR THE GIVEN
   * CLIENT carries >= minRecords records — the scenario-4 size pin. Same
   * fs-poll idiom as waitForSnapshotContaining (snapshot pushes fire on ready
   * + every 5s, so the registry's JSON generation files lag the UI by
   * seconds): read every generation file, keep only the given
   * clientInstanceId's, rank newest by (snapshotRevision, capturedAt) — the
   * server's own per-client monotonic ordering (tabs_persist.rs
   * `generation_rank`) — and insist the newest generation has the full tab
   * set on disk.
   */
  async function waitForNewestGenerationRecordCount(
    clientInstanceId: string,
    minRecords: number,
    timeoutMs = 30_000,
  ): Promise<void> {
    const snapshotsDir = path.join(capturedHome, '.freshell', 'tabs-snapshots')
    const deadline = Date.now() + timeoutMs
    let lastObserved = 0
    while (Date.now() < deadline) {
      const devices = await fs.readdir(snapshotsDir).catch(() => [] as string[])
      for (const device of devices) {
        const deviceDir = path.join(snapshotsDir, device)
        const files = (await fs.readdir(deviceDir).catch(() => [] as string[]))
          .filter((f) => f.endsWith('.json'))
        let newest: { revision: number; capturedAt: number; count: number } | null = null
        for (const f of files) {
          const raw = await fs.readFile(path.join(deviceDir, f), 'utf8').catch(() => '')
          let doc: any = null
          try {
            doc = JSON.parse(raw)
          } catch {
            continue
          }
          if (doc?.clientInstanceId !== clientInstanceId) continue
          const revision = Number(doc?.snapshotRevision ?? 0)
          const capturedAt = Number(doc?.capturedAt ?? 0)
          const count = Array.isArray(doc?.records) ? doc.records.length : 0
          if (!newest || revision > newest.revision || (revision === newest.revision && capturedAt > newest.capturedAt)) {
            newest = { revision, capturedAt, count }
          }
        }
        if (newest) {
          lastObserved = Math.max(lastObserved, newest.count)
          if (newest.count >= minRecords) return
        }
      }
      await new Promise((r) => setTimeout(r, 500))
    }
    throw new Error(
      `No persisted generation for client ${clientInstanceId} reached ${minRecords} records `
      + `within ${timeoutMs}ms (last observed: ${lastObserved})`,
    )
  }

  test.beforeAll(async () => {
    test.setTimeout(600_000) // first release build of freshell-server can take minutes
    ensureRustServerBuilt()
    sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'recover-my-panes-e2e-'))
    argLog = path.join(sharedRoot, 'claude-argv.jsonl')
    const fakeClaude = await installFakeCli(path.join(sharedRoot, 'bin'), 'claude', 'fake-claude-cli.mjs')
    const seed = seedConfig()
    server = new RustServer({
      env: {
        CLAUDE_CMD: fakeClaude,
        FAKE_CLAUDE_ARGV_LOG: argLog,
        // Scenario 5's freshclaude lane: the fake SDK-bridge sidecar via the
        // production env seam (read only at freshclaude sidecar spawn — inert
        // for scenarios 1-4). restart() re-merges this env on every boot.
        FRESHELL_CLAUDE_SIDECAR: path.resolve(__dirname, '../fixtures/fake-claude-sidecar.mjs'),
        FAKE_CLAUDE_SIDECAR_LOG: path.join(sharedRoot, 'claude-sidecar-requests.jsonl'),
      },
      setupHome: async (homeDir: string) => {
        capturedHome = homeDir
        await seed(homeDir)
      },
    })
    info = await server.start()
  })

  test.afterAll(async () => {
    await server?.stop().catch(() => {})
    if (sharedRoot) await fs.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
  })

  /**
   * SERVICE WORKERS ARE BLOCKED in every context this spec opens (the
   * perf harness precedent, perf/create-audit-context.ts:18): the production
   * client registers /sw.js and RELOADS on `controllerchange` (pwa.ts:24-34).
   * On a FRESH context that reload races App mount, aborting in-flight boot
   * fetches (observed: the recovery-inventory fetch dying with
   * net::ERR_ABORTED) — and the panel's fetch is deliberately one-shot
   * best-effort (RecoveryOfferPanel.tsx: on fetch failure, stay quiet), so a
   * lost race means no offer for that boot. Blocking the SW removes the
   * reload entirely; recovery behavior itself never depends on the SW.
   */
  const FRESH_CONTEXT_OPTIONS = { serviceWorkers: 'block' as const }

  /**
   * Open a FRESH context (empty storage) and REQUIRE the recovery offer —
   * one context, one hard `toBeVisible` assertion (the brief's contract).
   * No retry loop: with service workers blocked (above) the only known cause
   * of transient offer suppression is gone, and a retry here would quietly
   * absorb exactly the flaky-offer regression class this feature already
   * exhibited once. If the offer ever goes flaky again, this MUST fail loud.
   */
  async function openFreshContextWithOffer(
    browser: import('@playwright/test').Browser,
    label: string,
  ): Promise<{ ctx: BrowserContext; page: Page; harness: TestHarness }> {
    const ctx = await browser.newContext(FRESH_CONTEXT_OPTIONS)
    const page = await ctx.newPage()
    traceInventoryFailures(page, label)
    const harness = await connect(page, info)
    await expect(page.getByTestId('recovery-offer-panel')).toBeVisible({ timeout: 15_000 })
    return { ctx, page, harness }
  }

  // Scenario 1's claude session — scenario 2/3 reason about the same log.
  let sessionIdA = ''

  test('scenario 1: lose the browser, restart the server, accept — panes recreated, claude resumed, reload never re-offers', async ({ browser, e2eServerKind }) => {
    expect(e2eServerKind).toBe('rust')
    test.setTimeout(240_000)

    // ---- Context A: populate a tab with a claude CLI pane + a browser pane ----
    const ctxA: BrowserContext = await browser.newContext(FRESH_CONTEXT_OPTIONS)
    const pageA = await ctxA.newPage()
    await connect(pageA, info)
    await selectShellIfPickerShowing(pageA)
    await expect(pageA.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })

    // Claude pane (button label is the extension manifest's "Claude CLI").
    await openCliPane(pageA, /^Claude CLI$/i)

    // Record the pre-allocated sessionId from the argv log's --session-id pair
    // (pane-ledger-restart-rust.spec.ts:162-168 extraction).
    await expect(async () => {
      const sid = sessionIdsOf(await readArgvLog(argLog))[0]
      expect(sid, 'fake claude received a pre-allocated --session-id').toBeTruthy()
      sessionIdA = sid!
    }).toPass({ timeout: 30_000 })

    // Let it BIND: the ledger binding row for that sessionId hits disk (the
    // donor spec's readiness wait) — the inventory's D4 resolve needs it.
    await expect(async () => {
      const dir = path.join(capturedHome, '.freshell', 'pane-ledger', 'bindings', 'claude')
      const rows = await fs.readdir(dir, { recursive: true }).catch(() => [] as string[])
      expect(rows.map(String).some((f) => f.includes(sessionIdA))).toBe(true)
    }).toPass({ timeout: 15_000 })

    // Mixed-kind coverage (A12): a browser pane at https://example.com in the
    // SAME tab, created the way a user would (split + picker "Browser").
    await createBrowserPane(pageA, 'https://example.com')

    // A snapshot generation containing BOTH panes exists on disk (pushes fire
    // on ready + every 5s).
    await waitForSnapshotContaining([sessionIdA, 'example.com'])

    // ---- The "lost browser" + server restart ----
    await ctxA.close()
    await server.restart()

    // ---- Context B: fresh storage = new machine; the offer is REQUIRED ----
    const { ctx: ctxB, page: pageB } = await openFreshContextWithOffer(browser, 'contextB')

    const panelB = pageB.getByTestId('recovery-offer-panel')
    await expect(panelB).toBeVisible()
    await expect(panelB.getByRole('heading')).toHaveText(/restore \d+ pane/i)

    const argvCountBeforeAccept = (await readArgvLog(argLog)).length
    await pageB.getByTestId('recovery-accept').click()
    await expect(panelB).toHaveCount(0)

    // A recreated terminal pane renders.
    await expect(pageB.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })

    // PRIMARY resume proof: the accept re-spawned claude with the adjacent
    // pair `--resume <sessionIdA>` (delta past the pre-accept log).
    await expect(async () => {
      const entries = await readArgvLog(argLog)
      expect(
        entries.slice(argvCountBeforeAccept).some((e) => hasClaudeResumePair(e.argv, sessionIdA)),
        'accept must exec `claude --resume <sessionId>`',
      ).toBe(true)
    }).toPass({ timeout: 30_000 })

    // SECONDARY resume proof: the recreated pane's xterm text shows the fake
    // CLI's startup marker (fake-claude-cli.mjs:26-30; scrollback replay
    // delivers it to the late-attaching context). Buffers are read via the
    // renderer-agnostic harness API across ALL registered terminals. The
    // recovered claude pane is NARROW (third pane in a horizontal chain), so
    // the ~60-char marker line WRAPS across buffer rows — compare with all
    // whitespace stripped so wrapping (and trimmed wrap points) cannot hide it.
    await pageB.waitForFunction(
      (marker) => {
        const harness = (window as any).__FRESHELL_TEST_HARNESS__
        if (!harness) return false
        const state = harness.getState()
        const ids: string[] = []
        for (const tab of state?.tabs?.tabs ?? []) {
          const walk = (node: any) => {
            if (!node) return
            if (node.type === 'leaf') {
              if (node.content?.kind === 'terminal' && node.content?.terminalId) ids.push(node.content.terminalId)
              return
            }
            for (const child of node.children ?? []) walk(child)
          }
          walk(state?.panes?.layouts?.[tab.id])
        }
        const squash = (s: string) => s.replace(/\s+/g, '')
        return ids.some((id) => squash(harness.getTerminalBuffer(id) ?? '').includes(squash(marker)))
      },
      `claude: resumed session ${sessionIdA}`,
      { timeout: 30_000 },
    )

    // The browser pane was recreated too (mixed-kind restore, A12).
    const iframeB = pageB.locator('iframe[title="Browser content"]')
    await iframeB.waitFor({ state: 'attached', timeout: 15_000 })
    expect(await iframeB.getAttribute('src')).toContain('example.com')

    // ---- Same-browser reload guard: localStorage now has a layout ----
    await pageB.reload()
    const harnessB2 = new TestHarness(pageB)
    await harnessB2.waitForHarness()
    await harnessB2.waitForConnection()
    // Eligibility is boot-captured and synchronous (hadPersistedLayoutAtBoot
    // short-circuits BEFORE any fetch); the settle covers the async fetch path
    // that would have to complete for a wrongful offer to appear.
    await pageB.waitForTimeout(2_000)
    await expect(pageB.getByTestId('recovery-offer-panel')).toHaveCount(0)

    await ctxB.close()
    // Guard (R2a): scenario 2's ctxC boot REQUIRES the offer — wait until B's
    // closed records resolve as recoverable so teardown lag cannot starve it.
    await waitForRecoverable(info)
  })

  test('scenario 2: decline path — panel closes, no recovered tabs added', async ({ browser, e2eServerKind }) => {
    expect(e2eServerKind).toBe('rust')
    test.setTimeout(120_000)

    // Fresh context C against the same server (recoverable state still exists
    // from scenario 1 — context B's accepted layout also pushed snapshots).
    const { ctx: ctxC, page: pageC, harness: harnessC } = await openFreshContextWithOffer(browser, 'contextC')

    const panelC = pageC.getByTestId('recovery-offer-panel')
    await expect(panelC).toBeVisible()
    await pageC.getByTestId('recovery-decline').click()
    await expect(panelC).toHaveCount(0)

    // No recovered tabs: only the auto-created default tab remains — settle
    // first so a straggling (wrongful) recovery could have landed.
    await expect(async () => {
      expect(await harnessC.getTabCount()).toBe(1)
    }).toPass({ timeout: 10_000 })
    await pageC.waitForTimeout(1_500)
    expect(await harnessC.getTabCount()).toBe(1)

    await ctxC.close()
    // Guard (R2a): scenario 3's ctxD boot REQUIRES the offer.
    await waitForRecoverable(info)
  })

  test('scenario 3: no-restart browser loss — live sessions are NEVER recreated on top of the still-running ones (delta-r6-r3 live exclusion)', async ({ browser, e2eServerKind }) => {
    expect(e2eServerKind).toBe('rust')
    test.setTimeout(240_000)

    // ---- Context D against the SAME still-running server (no restart) ----
    // The offer MODAL (role="dialog" + overlay) appears first — D's storage is
    // empty and recoverable state exists — and would intercept all pointer
    // events. Clear it BEFORE any pane interaction (this dismissal lives only
    // in D's localStorage; context E below is a different fresh context).
    const { ctx: ctxD, page: pageD } = await openFreshContextWithOffer(browser, 'contextD')
    const panelD = pageD.getByTestId('recovery-offer-panel')
    await pageD.getByTestId('recovery-decline').click()
    await expect(panelD).toHaveCount(0)

    await selectShellIfPickerShowing(pageD)
    await expect(pageD.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })

    const argvCountBeforeCreate = (await readArgvLog(argLog)).length
    await openCliPane(pageD, /^Claude CLI$/i)

    // The NEW pane's sessionId = the --session-id pair past the pre-create count.
    let sessionIdD = ''
    await expect(async () => {
      const entries = await readArgvLog(argLog)
      const sid = sessionIdsOf(entries.slice(argvCountBeforeCreate))[0]
      expect(sid, 'context D fake claude received a pre-allocated --session-id').toBeTruthy()
      sessionIdD = sid!
    }).toPass({ timeout: 30_000 })

    // Ledger binding for D's session (inventory needs the bound row to
    // resolve + join liveness), then a snapshot generation that includes it.
    await expect(async () => {
      const dir = path.join(capturedHome, '.freshell', 'pane-ledger', 'bindings', 'claude')
      const rows = await fs.readdir(dir, { recursive: true }).catch(() => [] as string[])
      expect(rows.map(String).some((f) => f.includes(sessionIdD))).toBe(true)
    }).toPass({ timeout: 15_000 })
    await waitForSnapshotContaining([sessionIdD])

    // The argv-log watermark for the never-recreate assertions below.
    const argvCountAtD = (await readArgvLog(argLog)).length

    // ---- Lose the browser WITHOUT restarting the server: BOTH D's shell
    // PTY and D's claude CLI keep running (registry-owned, not
    // connection-owned), so every recoverable candidate verdicts LIVE. ----
    await ctxD.close()
    // Guard (R2a): the server's inventory still sees the recoverable
    // substance (the exclusion lives in the plan layer — the poller is the
    // transition guard, not an assertion).
    await waitForRecoverable(info)

    // ---- Context E (fresh storage): the offer lists ONLY the unidentified
    // shell pane — the claude pane verdicts LIVE (its session still runs),
    // and live panes are excluded for EVERY kind (focused-episode-6 round 2
    // Finding F1: the pre-repair build recreated the live terminal pane as a
    // SECOND claude spawn on top of the still-running session). ----
    const ctxE: BrowserContext = await browser.newContext(FRESH_CONTEXT_OPTIONS)
    const pageE = await ctxE.newPage()
    traceInventoryFailures(pageE, 'contextE')
    await connect(pageE, info)

    const panelE = pageE.getByTestId('recovery-offer-panel')
    await expect(panelE).toBeVisible({ timeout: 15_000 })
    await expect(
      pageE.getByRole('heading', { name: /restore 1 pane from server memory/i }),
    ).toBeVisible()
    await expect(pageE.getByTestId('recovery-live-note')).toBeVisible()
    await expect(pageE.getByTestId('recovery-live-note')).toHaveText(/not restored/)

    await pageE.getByTestId('recovery-accept').click()
    await expect(panelE).toHaveCount(0)

    // The accept DID run: the unidentified shell pane is recreated.
    await expect(pageE.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })

    // And the live claude pane was NOT recreated on top of the still-running
    // session — no fresh claude spawn past the watermark, and never
    // `--resume <sessionIdD>`. The positive window: the recreated shell is
    // already visible above, so any wrongly-recreated claude spawn would be
    // in flight now.
    const entriesAfterAccept = (await readArgvLog(argLog)).slice(argvCountAtD)
    expect(
      entriesAfterAccept,
      'the live claude pane was never recreated (a second claude spawn past the watermark)',
    ).toHaveLength(0)
    expect(
      entriesAfterAccept.some((e) => hasClaudeResumePair(e.argv, sessionIdD)),
      'the live session is never resumed onto a recreated pane',
    ).toBe(false)

    // Deliberately UNGUARDED close (R2a): scenario 4's populating boot never
    // branches on offer visibility timing — it captures the boot inventory
    // response payload and declines only when the payload says recoverable,
    // so it is correct whether or not E's teardown has settled.
    await ctxE.close()
  })

  test('scenario 4: small-viewport boots offer the full dialog and the decline control is tappable', async ({ browser, e2eServerKind }) => {
    expect(e2eServerKind).toBe('rust')
    test.setTimeout(240_000)

    // ---- Populating context: record a 40-shell-tab layout ----
    // 40 records overflow the dialog's 80vh-capped list budget on an 844px
    // viewport (measured ~24px/record ⇒ ~950px of content vs a ~525px list
    // budget); the plan's 20 records measure ~500px and fit UNDER the cap,
    // which made scrollHeight === clientHeight with AND without the
    // containment classes — a non-discriminating assertion.
    // A boot offer MODALLY intercepts the "New shell tab" clicks below — the
    // canonical full serial run has recoverable state from scenarios 1–3,
    // while an isolated `-g "scenario 4"` run against a fresh server/home has
    // none. Branch on the boot inventory RESPONSE PAYLOAD (captured BEFORE
    // navigation), never on visibility timing: offer render latency of >10s
    // has been observed, so a short visibility probe would race a delayed
    // modal into a false "no offer" read.
    const ctxP = await browser.newContext(FRESH_CONTEXT_OPTIONS)
    const pageP = await ctxP.newPage()
    traceInventoryFailures(pageP, 'scenario4-populating')
    const inventoryResponsePromise = pageP.waitForResponse((r) => r.url().includes('/api/recovery/inventory'))
    const harnessP = await connect(pageP, info)
    const inventoryBody = (await (await inventoryResponsePromise).json().catch(() => null)) as { recoverable?: unknown } | null
    if (inventoryBody?.recoverable === true) {
      const bootPanel = pageP.getByTestId('recovery-offer-panel')
      await expect(bootPanel).toBeVisible({ timeout: 30_000 })
      await pageP.getByTestId('recovery-decline').click()
      await expect(bootPanel).toHaveCount(0)
    }

    // 40 shell tabs via the tab strip (idiom donor: automation-layout-rust.spec.ts:143
    // — TabBar.tsx:535 `addTab({mode:'shell'})`; multirow-tabs.spec.ts's
    // click-loop + waitForTabCount same shape).
    const newShellTab = pageP.getByRole('button', { name: 'New shell tab' })
    for (let i = 0; i < 40; i++) {
      await newShellTab.click()
    }
    await harnessP.waitForTabCount(41, 30_000) // 1 boot tab + 40 shell tabs

    // The populating client's claimed tabs-registry clientInstanceId (the
    // TAB_REGISTRY_CLIENT_INSTANCE_ID_STORAGE_KEY value,
    // src/store/storage-keys.ts:17) selects its generations out of every
    // device dir in the poll below.
    const populatingClientId = await pageP.evaluate(() =>
      window.sessionStorage.getItem('freshell.tabs.client-instance-id.v1'),
    )
    expect(populatingClientId, 'populating context claimed a tabs-registry clientInstanceId').toBeTruthy()

    // The 40-tab layout must be IN DISK before the context dies: newest
    // generation for this client carries >= 40 records (the boot picker tab
    // may contribute a 41st).
    await waitForNewestGenerationRecordCount(populatingClientId!, 40)

    // ---- Lose the populating browser WITHOUT a server restart ----
    await ctxP.close()
    // Guard (R2a): the phone boot below REQUIRES the 40-tab offer.
    await waitForRecoverable(info)

    // ---- Phone-viewport context: the offer must contain itself + scroll ----
    const ctxPhone = await browser.newContext({
      serviceWorkers: 'block',
      viewport: { width: 390, height: 844 },
    })
    const pagePhone = await ctxPhone.newPage()
    traceInventoryFailures(pagePhone, 'scenario4-phone')
    await connect(pagePhone, info)

    const panel = pagePhone.getByTestId('recovery-offer-panel')
    await expect(panel).toBeVisible({ timeout: 30_000 })

    // R1 containment: the dialog's rendered box never escapes the 390x844
    // viewport (the phone incident: the dialog filled the screen and cropped
    // the decline button off-viewport).
    const box = await panel.boundingBox()
    expect(box, 'recovery dialog must have a layout box').not.toBeNull()
    expect(box!.x).toBeGreaterThanOrEqual(0)
    expect(box!.y).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width).toBeLessThanOrEqual(390)
    expect(box!.y + box!.height).toBeLessThanOrEqual(844)

    // R1 internal scroll: the records list is the sole scroll region
    // (RecoveryOfferPanel's <ul>) and provably overflows its own box with a
    // 40-record inventory.
    const recordsList = panel.locator('ul').first()
    const listMetrics = await recordsList.evaluate((el) => ({
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    }))
    expect(
      listMetrics.scrollHeight,
      'records list must scroll internally with a 40-record inventory',
    ).toBeGreaterThan(listMetrics.clientHeight)

    // R1/R3 phone proof: Playwright's click does the full actionability sweep
    // (attached, visible, stable, receives events) — "Not now" really is one
    // tap away on the phone-sized screen.
    await pagePhone.getByTestId('recovery-decline').click()
    await expect(panel).toHaveCount(0)

    await ctxPhone.close()
  })

  /**
   * Retire-on-kill contract pin (delta-review round 5): a fresh-agent pane
   * closed INSIDE the 7-second creation-race grace window must never be
   * offered after a browser loss + server SIGKILL. The window cannot tell
   * "created, not yet snapshotted" (keep, per the SIGKILL-within-5s
   * contract) from "created and just closed" — the boundary is exactly the
   * explicit freshAgent.kill, which now retires the row Closed (the
   * inventory's ledgerOnly pipeline pre-filters to Bound rows). Pre-repair
   * the kill left the row Bound with an in-window `lastAttributedAt`, so the
   * judgment kept it and the accept path rebuilt a pane the user had just
   * closed — the finding's verbatim failure shape.
   *
   * Producer: freshclaude pane split beside the boot shell pane (same donor
   * shape as the stale-row scenario), closed via the PLAIN pane-X as soon as
   * its binding row is on disk (well inside the window), then the COMPOUND
   * loss: browser to about:blank, server SIGKILL+revive. Post-kill evidence
   * shaping (donor: restore-contract-wall-rust.spec.ts's SIGKILL-within-5s
   * leg) deletes every retained generation referencing the session — the
   * within-cadence loss shape, made deterministic — so the row is
   * unreferenced by construction and reaches the offer pipeline only through
   * ledgerOnly. Assertions: the row's file records Retired/Closed (soft
   * precondition — pre-repair this times out and the later offer-side
   * assertions carry the RED), the probe inventory's ledgerOnly lacks the
   * session, the offer panel lists no line for its marker cwd, and accepting
   * restores the surviving shell while NEVER recreating the killed pane.
   * Placement: second-to-last — the LAST test wipes the evidence base, and
   * this scenario's own wipe depends on no later state.
   */
  test('kill inside the grace window: a just-closed fresh-agent pane is never offered or restored', async ({ browser, e2eServerKind }) => {
    expect(e2eServerKind).toBe('rust')
    test.setTimeout(240_000) // create + push poll + abrupt restart + two boots

    // 1. Re-base the evidence base (same justification as the stale-row
    //    scenario: no client is connected at this serial boundary, so wiping
    //    the generation store is safe; this scenario's own context rebuilds
    //    the evidence and keeps the offer recoverable via the surviving
    //    shell tab).
    await fs.rm(path.join(capturedHome, '.freshell', 'tabs-snapshots'), { recursive: true, force: true })

    // 2. Context A: boot shell pane, then SPLIT a freshclaude pane beside it.
    const ctxA: BrowserContext = await browser.newContext(FRESH_CONTEXT_OPTIONS)
    const pageA = await ctxA.newPage()
    const harnessA = await connect(pageA, info)
    await selectShellIfPickerShowing(pageA)
    await expect(pageA.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })
    const tabAId = (await harnessA.getActiveTabId())!
    const markerDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kill-window-freshclaude-'))
    await createFreshclaudePane(pageA, harnessA, markerDir)

    // 3. Durable id + binding row on disk (same idioms as the stale-row
    //    scenario); `attributedAt` is the row's browser-asserted attribution
    //    time — the judgment's row_time — for the in-window premise read
    //    below.
    let killedSessionId = ''
    await expect
      .poll(
        async () => {
          const c = findFreshAgentLeaf(await harnessA.getPaneLayout(tabAId))?.content
          killedSessionId = c?.sessionRef?.sessionId ?? c?.resumeSessionId ?? ''
          return killedSessionId
        },
        { timeout: 30_000 },
      )
      .toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
    const rowPath = path.join(
      capturedHome,
      '.freshell',
      'pane-ledger',
      'bindings',
      'claude',
      `${killedSessionId}.json`,
    )
    let attributedAt = 0
    await expect(async () => {
      const raw = await fs.readFile(rowPath, 'utf8').catch(() => '')
      expect(raw, 'the freshclaude binding row must land on disk').not.toBe('')
      const row = JSON.parse(raw) as { lastAttributedAt?: unknown }
      expect(typeof row.lastAttributedAt, 'row JSON lastAttributedAt (the judgment row_time)').toBe('number')
      attributedAt = row.lastAttributedAt as number
    }).toPass({ timeout: 15_000 })

    // 4. Close VIA THE PLAIN pane-X immediately — inside the grace window —
    //    never shift+close, never the BackgroundSessions Stop button (the
    //    terminal.kill shape is the other provider family). The shell sibling
    //    keeps the tab alive, so closePane (not closeTab) fires.
    await pageA
      .locator("[data-pane-id][data-context='pane']:has([data-context='fresh-agent']) button[title='Close pane']")
      .click()

    // 5. SOFT retire-on-kill precondition: the row's file records
    //    Retired/Closed once the kill is processed. Short-budgeted and
    //    tolerated on timeout so a pre-repair run still proceeds to the
    //    offer-side assertions (THE red of the finding); on the repaired
    //    build this polls true in well under a second.
    const readRowState = async () => {
      const raw = await fs.readFile(rowPath, 'utf8').catch(() => '')
      if (!raw) return ''
      const row = JSON.parse(raw) as { state?: unknown; retiredReason?: unknown }
      return row.state === 'retired' && row.retiredReason === 'closed' ? 'closed' : String(row.state ?? '')
    }
    await expect(async () => {
      expect(await readRowState()).toBe('closed')
    })
      .toPass({ timeout: 5_000, intervals: [150, 250, 500] })
      .catch(() => {})

    // 6. The COMPOUND loss: the browser dies FIRST (about:blank — the wall
    //    spec's determinism note: a surviving page would reconnect and
    //    force-push its registry after the shaping below), then SIGKILL.
    await pageA.goto('about:blank')
    info = await server.restartAbrupt()

    // 7. Post-kill evidence shaping + the IN-WINDOW premise read, in one
    //    pass (donor: restore-contract-wall-rust.spec.ts SIGKILL-within-5s):
    //    delete every retained generation referencing the closed session (a
    //    within-cadence loss; retention prunes them the same way in
    //    production), require a session-free newest generation per surviving
    //    client, and require its capturedAt to sit INSIDE the grace window of
    //    the row's attribution time — otherwise the time-drop clause alone
    //    would answer the exclusion and every assertion below is vacuous.
    const snapshotsRoot = path.join(capturedHome, '.freshell', 'tabs-snapshots')
    const newestByClient = new Map<string, { revision: number; capturedAt: number }>()
    let keptSessionFreeGeneration = false
    for (const deviceDirName of await fs.readdir(snapshotsRoot).catch(() => [] as string[])) {
      const deviceDir = path.join(snapshotsRoot, deviceDirName)
      for (const name of (await fs.readdir(deviceDir)).filter((n) => n.endsWith('.json'))) {
        const filePath = path.join(deviceDir, name)
        const raw = await fs.readFile(filePath, 'utf8')
        if (raw.includes(killedSessionId)) {
          await fs.rm(filePath)
          continue
        }
        keptSessionFreeGeneration = true
        let doc: any = null
        try {
          doc = JSON.parse(raw)
        } catch {
          continue
        }
        const client = doc?.clientInstanceId
        if (typeof client !== 'string' || !client) continue
        const revision = Number(doc?.snapshotRevision ?? 0)
        const capturedAt = Number(doc?.capturedAt ?? 0)
        const cur = newestByClient.get(client)
        if (!cur || revision > cur.revision || (revision === cur.revision && capturedAt > cur.capturedAt)) {
          newestByClient.set(client, { revision, capturedAt })
        }
      }
    }
    expect(
      keptSessionFreeGeneration,
      'evidence shaping must leave a session-free generation behind (the shell-pane push)',
    ).toBe(true)
    expect(newestByClient.size, 'context A pushed at least one retained generation').toBeGreaterThan(0)
    for (const [client, newest] of newestByClient) {
      expect(
        newest.capturedAt,
        `client ${client}'s newest retained generation must sit INSIDE the grace window ` +
          `of the row's attribution (capturedAt=${newest.capturedAt}, lastAttributedAt=${attributedAt}, ` +
          'grace=7000ms) — otherwise the time-drop clause alone answers the exclusion ' +
          'and this scenario is vacuous',
      ).toBeLessThanOrEqual(attributedAt + 7_000)
    }

    // 8. Inventory assertion via a STANDALONE probe BEFORE any page is opened
    //    (scenario-5 idiom): membership-absence in ledgerOnly, with the
    //    bucket-shape anti-vacuity check.
    const req = await request.newContext({
      baseURL: info.baseUrl,
      extraHTTPHeaders: { 'x-auth-token': info.token },
    })
    try {
      const res = await req.get('/api/recovery/inventory?clientInstanceId=freshell-test-probe&bootAgoMs=0')
      expect(res.ok(), `inventory probe must succeed (status ${res.status()})`).toBe(true)
      const body = (await res.json()) as { ledgerOnly?: Array<{ sessionId?: unknown }> }
      expect(Array.isArray(body.ledgerOnly), 'probe response must carry a ledgerOnly array').toBe(true)
      expect(
        (body.ledgerOnly ?? []).every((e) => e.sessionId !== killedSessionId),
        `killed-in-window ledger row ${killedSessionId} must NOT be present in the inventory's ` +
          `ledgerOnly bucket (got ${JSON.stringify(body.ledgerOnly)})`,
      ).toBe(true)
    } finally {
      await req.dispose()
    }

    // 9. Offer assertion: the shell tab survived in the evidence, so the
    //    offer is REQUIRED; the panel's ledgerOnly lines render
    //    "{tabName}: {mode} — {cwd}", and the marker cwd must appear on NO
    //    line.
    const { ctx: ctxB, page: pageB, harness: harnessB } = await openFreshContextWithOffer(browser, 'kill-window-exclusion')
    const panel = pageB.getByTestId('recovery-offer-panel')
    await expect(panel.locator('ul li', { hasText: 'kill-window-freshclaude-' })).toHaveCount(0)

    // 10. Accept: the surviving shell restores (anti-vacuity), and NO leaf
    //     anywhere carries the killed session — the pane the user closed
    //     stays closed. (Layout scan has a soft budget: the restore runs
    //     through the plan rebuild, not instantly.)
    await pageB.getByTestId('recovery-accept').click()
    await expect(pageB.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })
    await expect(async () => {
      const layout = await harnessB.getPaneLayout(await harnessB.getActiveTabId())
      const walk = (node: any): any[] =>
        !node ? [] : node.type === 'leaf' ? [node] : (node.children ?? []).flatMap(walk)
      const hit = walk(layout).some(
        (leaf) =>
          leaf?.content?.sessionRef?.sessionId === killedSessionId
          || leaf?.content?.resumeSessionId === killedSessionId
          || leaf?.content?.sessionId === killedSessionId,
      )
      expect(hit, `no restored pane may carry the killed session ${killedSessionId}`).toBe(false)
      const shellCount = walk(layout).filter(
        (leaf) => leaf?.content?.kind === 'terminal' && (leaf?.content?.mode ?? 'shell') === 'shell',
      ).length
      expect(shellCount, 'accept must restore the surviving shell (anti-vacuity)').toBeGreaterThan(0)
    }).toPass({ timeout: 30_000 })

    await ctxB.close()
    await fs.rm(markerDir, { recursive: true, force: true })
  })

  /**
   * D8 contract pin: a session that was closed before its client's newest
   * retained snapshot evidence (a stale NEVER-OPEN-at-the-evidence-horizon
   * row) is never offered via the inventory's ledgerOnly bucket. Pinned RED
   * against the pre-D8 blanket bucket (Bound + unreferenced + not live),
   * which kept the row and offered it; the server-side parent-relative
   * judgment
   * (docs/plans/2026-09-02-restore-open-sessions-only.md, Task 3) turned it
   * GREEN.
   *
   * Producer recipe (validator load-bearing-validator-v1-recipe.md): a
   * freshclaude pane split beside the boot shell pane, closed via the PLAIN
   * pane-X, sends freshAgent.kill (never terminal.kill). The 15s timing gate
   * below holds the close OUTSIDE the judgment's grace window, so the row is
   * excluded no matter how the close is recorded; since the retire-on-kill
   * repair (the prior scenario's subject) the close additionally retires the
   * row Closed. MUST remain LAST in this serial describe: it wipes the
   * generation store to re-base the evidence, which no earlier scenario may
   * observe.
   */
  test('stale never-open ledger rows are never offered', async ({ browser, e2eServerKind }) => {
    expect(e2eServerKind).toBe('rust')
    test.setTimeout(240_000) // 15s timing gate + <=120s generation poll + restart + two boots

    // 1. Re-base the evidence base: earlier scenarios' clients hold frozen
    //    generations whose clocks would co-survive selection with this
    //    scenario's junk row's parent. No client is connected at this point
    //    in the serial suite, so wiping the generation store is safe; this
    //    scenario's own context rebuilds the evidence (and keeps the offer
    //    recoverable via the surviving shell tab).
    await fs.rm(path.join(capturedHome, '.freshell', 'tabs-snapshots'), { recursive: true, force: true })

    // 2. Context A: boot shell pane, then SPLIT a freshclaude pane beside it
    //    (NEVER close a tab's only pane — that collapses to closeTab, whose
    //    closed-tab record would re-reference the row forever).
    const ctxA: BrowserContext = await browser.newContext(FRESH_CONTEXT_OPTIONS)
    const pageA = await ctxA.newPage()
    const harnessA = await connect(pageA, info)
    await selectShellIfPickerShowing(pageA)
    await expect(pageA.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })
    const tabAId = (await harnessA.getActiveTabId())!

    // 3. The marker cwd is the offer-list discriminator (the panel renders
    //    ledgerOnly rows under their tab as "{tabName}: {mode} — {cwd}",
    //    never the sessionId): create the freshclaude pane with a unique
    //    real marker dir as cwd.
    const markerDir = await fs.mkdtemp(path.join(os.tmpdir(), 'junk-freshclaude-'))
    await createFreshclaudePane(pageA, harnessA, markerDir)

    // 4. Acquire the DURABLE session id via the harness poll
    //    (sessionRef.sessionId ?? resumeSessionId, canonical-UUID shape —
    //    the argv-log idiom does not serve fresh-agent panes: the sidecar
    //    path never spawns the CLI).
    let junkSessionId = ''
    await expect
      .poll(
        async () => {
          const c = findFreshAgentLeaf(await harnessA.getPaneLayout(tabAId))?.content
          junkSessionId = c?.sessionRef?.sessionId ?? c?.resumeSessionId ?? ''
          return junkSessionId
        },
        { timeout: 30_000 },
      )
      .toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)

    // 5. Disk-wait the binding row and read bindMs (the row JSON's createdAt,
    //    serde camelCase).
    let bindMs = 0
    await expect(async () => {
      const raw = await fs
        .readFile(
          path.join(capturedHome, '.freshell', 'pane-ledger', 'bindings', 'claude', `${junkSessionId}.json`),
          'utf8',
        )
        .catch(() => '')
      expect(raw, 'the freshclaude binding row must land on disk').not.toBe('')
      const row = JSON.parse(raw) as { createdAt?: unknown }
      expect(typeof row.createdAt, 'row JSON createdAt (serde camelCase)').toBe('number')
      bindMs = row.createdAt as number
    }).toPass({ timeout: 15_000 })

    // 6. Prove it WAS snapshot-open before it becomes the stale row (pushes
    //    fire on ready + every 5s).
    await waitForSnapshotContaining([junkSessionId])

    // 7. Timing gate: close no earlier than bindMs + 15_000. The final
    //    post-close push lands within one 5s tick, so the parent's newest
    //    retained generation is server-stamped strictly after bindMs + 14_000
    //    — well past the judgment grace, so with the D8 filter the row is
    //    dropped; pre-fix the blanket bucket keeps it (the pinned red).
    const gateWaitMs = bindMs + 15_000 - Date.now()
    if (gateWaitMs > 0) await pageA.waitForTimeout(gateWaitMs)

    // 8. Close via the PLAIN pane-X — NEVER shift+close and NEVER the
    //    BackgroundSessions Stop button (terminal.kill would retire the row
    //    and vacate the pin). The shell sibling keeps the tab alive, so
    //    closePane (not closeTab) fires and no closed-tab record is written.
    await pageA
      .locator("[data-pane-id][data-context='pane']:has([data-context='fresh-agent']) button[title='Close pane']")
      .click()

    // 9. Evidence-advance: the newest generation of EVERY client must
    //    postdate bindMs + 14_000 AND no longer contain the session id — the
    //    post-close push's on-disk proof, and the post-fix "parent's newest"
    //    judgment input. (After step 1's wipe only context A's client exists;
    //    the every-client form protects the assertion if the wipe is ever
    //    skipped.)
    const snapshotsDir = path.join(capturedHome, '.freshell', 'tabs-snapshots')
    await expect(async () => {
      const newestByClient = new Map<string, { revision: number; capturedAt: number; raw: string }>()
      const devices = await fs.readdir(snapshotsDir).catch(() => [] as string[])
      for (const device of devices) {
        const deviceDir = path.join(snapshotsDir, device)
        const files = (await fs.readdir(deviceDir).catch(() => [] as string[])).filter((f) => f.endsWith('.json'))
        for (const f of files) {
          const raw = await fs.readFile(path.join(deviceDir, f), 'utf8').catch(() => '')
          let doc: any = null
          try {
            doc = JSON.parse(raw)
          } catch {
            continue
          }
          const client = doc?.clientInstanceId
          if (typeof client !== 'string' || !client) continue
          const revision = Number(doc?.snapshotRevision ?? 0)
          const capturedAt = Number(doc?.capturedAt ?? 0)
          const cur = newestByClient.get(client)
          if (!cur || revision > cur.revision || (revision === cur.revision && capturedAt > cur.capturedAt)) {
            newestByClient.set(client, { revision, capturedAt, raw })
          }
        }
      }
      expect(newestByClient.size, 'at least one client generation must exist after context A booted').toBeGreaterThan(0)
      for (const [client, newest] of newestByClient) {
        expect(
          newest.capturedAt,
          `client ${client}'s newest generation must postdate the close gate (bindMs + 14s)`,
        ).toBeGreaterThan(bindMs + 14_000)
        expect(
          newest.raw.includes(junkSessionId),
          `client ${client}'s newest generation must no longer contain the closed session`,
        ).toBe(false)
      }
    }).toPass({ timeout: 120_000 })

    // 10. Close context A, then the file's close→restart discipline parity
    //     (recoverable guard, restart, reassign info).
    await ctxA.close()
    await waitForRecoverable(info)
    info = await server.restart()

    // 11. RED/GREEN inventory assertion via a STANDALONE probe BEFORE any
    //     page is opened — never page.request (its handle dies with the
    //     context) and never a navigated page (a booted page would register
    //     as a tabs.sync client and could push inside the grace window).
    //     Membership-absence, NOT emptiness: other legit rows may exist.
    const req = await request.newContext({
      baseURL: info.baseUrl,
      extraHTTPHeaders: { 'x-auth-token': info.token },
    })
    try {
      const res = await req.get('/api/recovery/inventory?clientInstanceId=freshell-test-probe&bootAgoMs=0')
      expect(res.ok(), `inventory probe must succeed (status ${res.status()})`).toBe(true)
      const body = (await res.json()) as { ledgerOnly?: Array<{ sessionId?: unknown }> }
      // Anti-vacuity: prove the bucket shape before asserting absence — a probe
      // whose response dropped `ledgerOnly` must fail, not pass vacuously.
      expect(Array.isArray(body.ledgerOnly), 'probe response must carry a ledgerOnly array').toBe(true)
      expect(
        (body.ledgerOnly ?? []).every((e) => e.sessionId !== junkSessionId),
        `stale never-open ledger row ${junkSessionId} must NOT be present in the inventory's `
          + `ledgerOnly bucket (got ${JSON.stringify(body.ledgerOnly)})`,
      ).toBe(true)
    } finally {
      await req.dispose()
    }

    // 12. Offer assertion: the panel's ledgerOnly lines carry the row's cwd
    //     ("{tabName}: {mode} — {cwd}"), so the marker cwd discriminates. The
    //     re-based union still holds the surviving shell tab, so
    //     recoverable stays true and the offer is REQUIRED.
    const { ctx: ctxB, page: pageB } = await openFreshContextWithOffer(browser, 'junk-exclusion')
    const panel = pageB.getByTestId('recovery-offer-panel')
    await expect(panel.locator('ul li', { hasText: 'junk-freshclaude-' })).toHaveCount(0)

    // Do NOT click accept on the junk account alone: with the bucket empty of
    // this row there is no junk tab to form (Task 4 separately pins that
    // surviving rows join their original tab; rows whose tab vanished are
    // excluded server-side, so the trailing tab never forms at all).
    await ctxB.close()
    await fs.rm(markerDir, { recursive: true, force: true })
  })
})
