/**
 * Server-build mismatch auto-reload (the-usual/server-version-reload).
 *
 * The user story: a tab running a client bundle built at commit A connects
 * to a server built at commit B; the server's `ready.buildId` differs from
 * the client's baked `__FRESHELL_BUILD_ID__`; the client reloads EXACTLY
 * ONCE (sentinel `freshell.server-build-reload` in sessionStorage, which
 * records the attempted server build id) and converges to a healthy ready
 * connection. A repeat mismatched ready for the SAME build id must NOT
 * reload again — a half-deployed server can never reload-loop.
 *
 * COVERAGE BOUNDARY (read before judging): what e2e proves here is
 * (1) the full production compare-and-reload pipeline through the REAL App
 * ready handler (mismatch injected via the test harness — a REAL server
 * stamps its own sha, which may or may not equal this worktree's client
 * bake, so the injection makes the compare deterministic either way),
 * (2) sessionStorage persistence across a REAL navigation, and (3)
 * suppression of a repeat mismatch. The "code armed the sentinel BEFORE
 * reloading" ORDER is proven by the unit suite (App.restart-signals: real
 * jsdom sessionStorage persisting across the simulated reboot). Observing
 * the code-armed sentinel surviving a REAL navigation e2e is not
 * deterministic here: after any reload the boot's REAL ready either matches
 * (same-HEAD artifacts → legitimately clears the sentinel) or mismatches
 * (stale-bake environments → keeps it), so the post-reload sentinel state
 * is environment-dependent — hence the persistence test snapshots the
 * sentinel at DOCUMENT CREATION (an init script runs before page scripts)
 * and the suppression test seeds its state AFTER the boot settles.
 * Seeding is state setup, the same practice as seeding localStorage in
 * other suites; the PERSISTENCE and SUPPRESSION behavior exercised is
 * entirely production code.
 *
 * Rust-only: registers under `rust-chromium` + RUST_ONLY_SPECS (owns a
 * RustServer directly, the e2eServerKind seam not used). CLOUD-SKIPPED with
 * justification (see playwright.cloud.config.ts): the Cloud Run image
 * builds WITHOUT git metadata, so both the Rust bake and the Vite define
 * are "unknown" there and the compare is inert BY DESIGN — this spec can
 * only pass on a lane where at least the client bake is a real sha.
 */
import { test, expect } from '../helpers/fixtures.js'
import { RustServer, ensureRustServerBuilt } from '../helpers/rust-server.js'
import type { TestServerInfo } from '../helpers/test-server.js'
import { TestHarness } from '../helpers/test-harness.js'

const MISMATCHED_BUILD_ID = 'f'.repeat(40)
const SENTINEL = 'freshell.server-build-reload'

test.describe('server build mismatch reload (rust)', () => {
  let server: RustServer | undefined
  let info: TestServerInfo

  test.beforeAll(async () => {
    test.setTimeout(600_000) // first release build of freshell-server can take minutes
    ensureRustServerBuilt()
    server = new RustServer()
    info = await server.start()
  })

  test.afterAll(async () => {
    await server?.stop().catch(() => {})
  })

  test('mismatched ready buildId reloads exactly once and converges', async ({ browser }) => {
    const context = await browser.newContext({ serviceWorkers: 'block' })
    const page = await context.newPage()
    await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
    const harness = new TestHarness(page)
    await harness.waitForHarness()
    await harness.waitForConnection()

    // Start counting AFTER the boot-time compare so the real ready's own
    // match/mismatch outcome (both artifacts usually share this worktree's
    // HEAD) cannot pollute the count; also re-clear the sentinel so the
    // injected mismatch is the one that arms it.
    await page.evaluate((key) => sessionStorage.removeItem(key), SENTINEL)
    let navigations = 0
    page.on('framenavigated', () => { navigations++ })

    // Injected mismatch → exactly one reload, and the page reboots into a
    // healthy ready connection (convergence).
    await harness.receiveWsMessage({
      type: 'ready',
      timestamp: new Date().toISOString(),
      serverInstanceId: 'srv-build-mismatch-probe',
      bootId: 'boot-build-mismatch-probe',
      buildId: MISMATCHED_BUILD_ID,
    })
    await expect.poll(() => navigations, { timeout: 20_000 }).toBe(1)
    const rebooted = new TestHarness(page)
    await rebooted.waitForHarness()
    await rebooted.waitForConnection()

    // The real post-reload ready must MATCH: in normal e2e runs the harness
    // guarantees same-HEAD artifacts — global setup fresh-builds both sides
    // (test/e2e-browser/global-setup.ts runs `npm run build:client && npm run
    // build:server` at run start) and `ensureRustServerBuilt` restamps the
    // Rust binary on HEAD moves — so the real `ready.buildId` equals the
    // client's baked `__FRESHELL_BUILD_ID__` and the production match path
    // MUST have cleared the sentinel. A failure here means the real ready
    // did not MATCH — a genuine cross-artifact stamping regression, not a
    // suppression artifact. (Known caveat: a stale dist from a non-harness
    // flow will fail this assertion loudly, which is the feature working as
    // designed.)
    expect(
      await page.evaluate((key) => sessionStorage.getItem(key), SENTINEL),
      'real post-reload ready must MATCH and clear the sentinel (same-HEAD harness guarantee)',
    ).toBeNull()

    await context.close()
  })

  test('sentinel persists across a real navigation', async ({ browser }) => {
    const context = await browser.newContext({ serviceWorkers: 'block' })
    const page = await context.newPage()
    await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
    const harness = new TestHarness(page)
    await harness.waitForHarness()
    await harness.waitForConnection()

    // Seed the state the production code would have armed on a previous
    // mismatched ready in this tab (see the coverage boundary above): the
    // sentinel records the attempted server build id, which here is the id
    // a mismatched ready would have presented.
    await page.evaluate(([key, value]) => sessionStorage.setItem(key, value), [SENTINEL, MISMATCHED_BUILD_ID])

    // A REAL navigation: sessionStorage must survive it (per-tab, per-origin
    // storage). The value is snapshotted at DOCUMENT CREATION — an init
    // script runs before page scripts — so it is immune to the rebooted
    // app's later match-and-clear (same-HEAD artifacts legitimately clear
    // the sentinel after the real ready): the reload's `commit` event only
    // guarantees the document exists, and by the time the new app has
    // received the real (matching) ready it may ALREADY have cleared the
    // sentinel before a late `page.evaluate` could read it. `null` would
    // mean absent at document start; `MISMATCHED_BUILD_ID` means persisted.
    await page.addInitScript((key) => {
      ;(window as any).__sentinelAtDocumentStart = window.sessionStorage.getItem(key)
    }, SENTINEL)
    await page.reload({ waitUntil: 'commit' })
    const persisted = await page
      .waitForFunction(() => (window as any).__sentinelAtDocumentStart !== undefined)
      .then(() => page.evaluate(() => (window as any).__sentinelAtDocumentStart))
    expect(persisted, 'sentinel must survive a real navigation').toBe(MISMATCHED_BUILD_ID)

    await context.close()
  })

  test('a seeded sentinel suppresses a repeat mismatch (no reload)', async ({ browser }) => {
    const context = await browser.newContext({ serviceWorkers: 'block' })
    const page = await context.newPage()
    await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
    const harness = new TestHarness(page)
    await harness.waitForHarness()
    await harness.waitForConnection()

    // Seed AFTER the boot settles (the boot's real ready may legitimately
    // match-and-clear an earlier sentinel; seeding here is the setup for
    // the suppression proof — the arming ORDER is unit-proven, the
    // navigation persistence is proven by the previous test). The value is
    // MISMATCHED_BUILD_ID: the attempted server build id the injected
    // mismatch below will present, so the production suppression branch
    // (same id already attempted) is the one exercised.
    await page.evaluate(([key, value]) => sessionStorage.setItem(key, value), [SENTINEL, MISMATCHED_BUILD_ID])
    let navigations = 0
    page.on('framenavigated', () => { navigations++ })

    await harness.receiveWsMessage({
      type: 'ready',
      timestamp: new Date().toISOString(),
      serverInstanceId: 'srv-build-mismatch-probe',
      bootId: 'boot-build-mismatch-probe',
      buildId: MISMATCHED_BUILD_ID,
    })
    await page.waitForTimeout(3_000)
    expect(navigations, 'persisted sentinel must suppress the repeat mismatch').toBe(0)

    await context.close()
  })
})
