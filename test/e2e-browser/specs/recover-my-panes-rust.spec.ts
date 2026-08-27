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
 * Scenario 3 (no-restart browser loss, D7): the browser is lost WITHOUT a
 * server restart, so the claude PTY stays Running (registry-owned). The next
 * fresh context's offer shows the live-session note, and accepting recreates
 * the pane WITHOUT `--resume` — the running session is left untouched.
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
 * Fixture shapes (fake CLI, config seeding, shell-picker choreography) are
 * COPIED from pane-ledger-restart-rust.spec.ts per this suite's
 * per-spec-ownership convention.
 *
 * Rust-only: drives `GET /api/recovery/inventory` (no legacy equivalent) and
 * owns a RustServer directly (ephemeral loopback port — NEVER 3001/3002).
 * Registered ONLY under `Rust browser lane` and testIgnore'd on every match-all
 * project (see playwright.config.ts's RUST_ONLY_SPECS).
 */
import { test, expect } from '../helpers/fixtures.js'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { fileURLToPath } from 'node:url'
import { request, type BrowserContext, type Page } from '@playwright/test'
import { RustServer, ensureRustServerBuilt } from '../helpers/rust-server.js'
import type { E2eServerInfo } from '../helpers/server-fixture-support.js'
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
          settings: { codingCli: { enabledProviders: ['claude', 'codex', 'opencode'] } },
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
  info: E2eServerInfo,
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
  let info: E2eServerInfo

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
      env: { CLAUDE_CMD: fakeClaude, FAKE_CLAUDE_ARGV_LOG: argLog },
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

  test('scenario 1: lose the browser, restart the server, accept — panes recreated, claude resumed, reload never re-offers', async ({ browser }) => {
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

  test('scenario 2: decline path — panel closes, no recovered tabs added', async ({ browser }) => {
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

  test('scenario 3: no-restart browser loss — live session recreates WITHOUT resume (D7)', async ({ browser }) => {
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

    // The argv-log watermark for the D7 negative assertion below.
    const argvCountAtD = (await readArgvLog(argLog)).length

    // ---- Lose the browser WITHOUT restarting the server: the claude PTY
    // stays Running (registry-owned, not connection-owned). ----
    await ctxD.close()
    // Guard (R2a): context E's boot below REQUIRES the offer for D's layout.
    await waitForRecoverable(info)

    // ---- Context E: the offer appears (the new session changed the
    // recoverable substance — scenario 2's dismissal cannot suppress it, and
    // E is a different fresh context anyway) with the live-session note. ----
    const { ctx: ctxE, page: pageE } = await openFreshContextWithOffer(browser, 'contextE')

    const panelE = pageE.getByTestId('recovery-offer-panel')
    await expect(pageE.getByTestId('recovery-live-note')).toBeVisible()

    await pageE.getByTestId('recovery-accept').click()
    await expect(panelE).toHaveCount(0)

    // A terminal pane is recreated.
    await expect(pageE.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })

    // D7 negative assertion, non-vacuously: FIRST wait until the recreated
    // claude spawn is OBSERVED in the log (the live pane recreates as a fresh
    // claude — a new entry past the watermark), THEN assert none of the new
    // entries carries `--resume <sessionIdD>`. The matcher itself is proven
    // non-vacuous by scenario 1's PRIMARY poll, which matched a real pair.
    await expect(async () => {
      const entries = await readArgvLog(argLog)
      expect(entries.length, 'accept must re-spawn a claude CLI for the live pane').toBeGreaterThan(argvCountAtD)
    }).toPass({ timeout: 30_000 })
    const newEntries = (await readArgvLog(argLog)).slice(argvCountAtD)
    expect(
      newEntries.some((e) => hasClaudeResumePair(e.argv, sessionIdD)),
      'live session must be recreated WITHOUT --resume (left untouched, D7)',
    ).toBe(false)

    // Deliberately UNGUARDED close (R2a): scenario 4's populating boot never
    // branches on offer visibility timing — it captures the boot inventory
    // response payload and declines only when the payload says recoverable,
    // so it is correct whether or not E's teardown has settled.
    await ctxE.close()
  })

  test('scenario 4: small-viewport boots offer the full dialog and the decline control is tappable', async ({ browser }) => {
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
})
