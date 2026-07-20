import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test as base, expect } from '../helpers/fixtures.js'
import { createE2eServerHandle } from '../helpers/external-target.js'
import { TestHarness } from '../helpers/test-harness.js'

/**
 * REST-TAB-PERSISTENCE -- acceptance evidence for the tab-poisoning
 * production incident: a REST-created tab whose `mode` is not in the
 * client's hardcoded persisted-tabs enum (`src/store/persistedState.ts`'s
 * `zTabMode = z.enum(['shell', 'claude', 'codex', 'opencode', 'gemini',
 * 'kimi'])`) survives in `localStorage` untouched, but VANISHES from the tab
 * strip on the very next reload -- because `parsePersistedTabsRaw`
 * (`persistedState.ts:141-164`) runs the WHOLE persisted-tabs payload
 * through `zPersistedTabsPayload.safeParse(parsed)` and returns `null` for
 * the ENTIRE payload on ANY single tab's schema violation (not a per-tab
 * filter) -- so one out-of-enum `mode` value wipes every tab in the strip,
 * not just its own. `freshell.layout.v3` (the SEPARATE storage key holding
 * the actual pane-content tree) is never touched by this failure, which is
 * exactly the "data preserved but rejected" shape a real incident takes:
 * the bytes are still on disk, but the UI shows nothing.
 *
 * `amplifier` is the mode used to trigger this: it is accepted as a
 * REGISTERED terminal-launch target by BOTH servers' extension-manifest
 * discovery (`extensions/amplifier/freshell.json`, `category: "cli"`) --
 * proven by `amplifier-restore-rust.spec.ts` on the Rust side -- yet it was
 * never added to `zTabMode`'s hardcoded client-side enum. The mismatch
 * between "the server will happily create this" and "the client's persisted-
 * state schema doesn't know this mode exists" is the actual bug shape.
 *
 * KNOWN DIVERGENCE (rust-only, by design -- see `playwright.config.ts`'s
 * `rust-chromium`-only `testMatch` entry for this file, matching the
 * identical divergence note already established by
 * `amplifier-restore-rust.spec.ts` and `session-directory-matrix.spec.ts`):
 * this checked-out branch's `server/` tree (legacy Node implementation,
 * FROZEN for this task) predates `origin/main` commit `05c6b1fa`
 * ("feat(amplifier): durable session tracking via events.jsonl", #514).
 * Verified two independent ways before writing this gate: (1) `git
 * merge-base --is-ancestor 05c6b1fa HEAD` on this branch returns false, and
 * (2) `playwright.config.ts` already documents, for the sibling
 * `amplifier-restore-rust.spec.ts`, that legacy has "NO amplifier provider
 * registered at all" on this branch. So the legacy leg of this scenario
 * cannot even create the poisoned tab via REST in the first place -- this is
 * an absent feature on this branch, not a parity gap to gate per-assertion.
 * The underlying CLIENT bug this spec proves (`persistedState.ts`'s
 * `zTabMode` enum going stale relative to server-side extension discovery)
 * is still shared/frozen code, and legacy would be equally vulnerable to it
 * through any OTHER writer of `freshell.tabs.v2` that isn't gated by this
 * same REST mode-validation choke point (e.g. a future legacy extension
 * registration, or manual localStorage manipulation) -- this spec just
 * cannot prove that reachability on legacy in THIS environment.
 *
 * ---
 * FLIP INSTRUCTION for whoever lands the client fix (main commit range
 * including/after `a853ce03` "fix(client): persist-empty guard + MCP new-tab
 * resume alias (#518)", cherry-picked or reimplemented onto this branch):
 * once `zTabMode` (or the persisted-tabs parse path generally) tolerates an
 * unrecognized-but-well-formed mode value, the `test.fail()` annotation
 * below on `it must survive a reload` will itself start FAILING (an
 * unexpected PASS trips a `test.fail()`-annotated test into a hard
 * failure) -- that is the signal to remove the `test.fail()` wrapper and
 * let the assertion run as a normal (green) expectation.
 * ---
 */

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const FAKE_AMPLIFIER_CLI_SOURCE = path.resolve(__dirname, '../fixtures/fake-amplifier-cli.mjs')

async function installFakeAmplifierCli(binDir: string): Promise<string> {
  await fs.mkdir(binDir, { recursive: true })
  const target = path.join(binDir, 'amplifier')
  await fs.copyFile(FAKE_AMPLIFIER_CLI_SOURCE, target)
  await fs.chmod(target, 0o755)
  return target
}

function unwrapData(body: any): any {
  return body && typeof body === 'object' && 'data' in body ? body.data : body
}

async function createTab(
  baseUrl: string,
  token: string,
  payload: Record<string, unknown>,
): Promise<{ status: number; tabId?: string; paneId?: string; body: any }> {
  const res = await fetch(`${baseUrl}/api/tabs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-auth-token': token },
    body: JSON.stringify(payload),
  })
  const rawBody = await res.json().catch(() => undefined)
  const data = unwrapData(rawBody) as { tabId?: string; paneId?: string } | undefined
  return { status: res.status, tabId: data?.tabId, paneId: data?.paneId, body: rawBody }
}

const test = base.extend<Record<string, never>, { e2eServerKind: 'legacy' | 'rust' }>({
  testServer: [async ({ e2eServerKind }, use) => {
    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-rest-tab-persistence-'))
    const binDir = path.join(sharedRoot, 'bin')
    const cwd = path.join(sharedRoot, 'project')
    await installFakeAmplifierCli(binDir)
    await fs.mkdir(cwd, { recursive: true })

    const server = await createE2eServerHandle(process.env, {
      kind: e2eServerKind,
      construct: {
        env: {
          PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
        },
        setupHome: async (homeDir) => {
          const freshellDir = path.join(homeDir, '.freshell')
          await fs.mkdir(freshellDir, { recursive: true })
          await fs.writeFile(path.join(freshellDir, 'config.json'), JSON.stringify({
            version: 1,
            settings: {
              codingCli: { enabledProviders: ['amplifier'] },
            },
          }, null, 2))
        },
      },
    })
    await server.start()
    ;(server as any).__cwd = cwd
    await use(server)
    await server.stop()
    await fs.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
  }, { scope: 'worker' }],
})

test.describe('REST tab persistence (amplifier out-of-enum mode)', () => {
  test.setTimeout(60_000)

  test('creating a tab via REST with an out-of-enum mode materializes it in the tab strip and persists to localStorage, but the tab strip goes empty on reload while localStorage still holds the data', async ({ page, e2eServerKind, serverInfo, testServer }) => {
    // Registered ONLY under the `rust-chromium` project (see this file's
    // doc comment + `playwright.config.ts`) -- assert the precondition
    // explicitly so an accidental `MATRIX_SPECS` inclusion fails loudly
    // instead of silently no-op'ing on legacy.
    expect(e2eServerKind).toBe('rust')

    const { baseUrl, token } = serverInfo
    const cwd = (testServer as any).__cwd as string

    // Connect the browser FIRST: the Rust server (like legacy) broadcasts
    // `ui.command{tab.create}` over the live WS connection when a tab is
    // created via REST (`state.broadcast(...)`,
    // `crates/freshell-freshagent/src/terminal_tabs.rs`) -- a client that
    // connects AFTER the create call would miss that broadcast entirely and
    // never see the tab materialize (no separate "list current tabs" fetch
    // backs this REST-created-tab path). Creating the tab only once a live
    // client is already connected is what makes this a faithful reproduction
    // of the real incident (a user with the app open in their browser,
    // creating a tab), not an artifact of test ordering.
    await page.goto(`${baseUrl}/?token=${token}&e2e=1`)
    const harness = new TestHarness(page)
    await harness.waitForHarness()
    await harness.waitForConnection()

    const created = await createTab(baseUrl, token, { mode: 'amplifier', cwd, name: 'amplifier-poison-tab' })
    expect(created.status, `POST /api/tabs {mode:'amplifier'} should succeed on the rust server (registered via extensions/amplifier/freshell.json): ${JSON.stringify(created.body)}`).toBe(200)
    expect(created.tabId).toBeTruthy()
    expect(created.paneId).toBeTruthy()

    const tabStrip = page.locator('[data-testid="tab-strip"]')
    await expect(tabStrip.getByText('amplifier-poison-tab')).toBeVisible({ timeout: 15_000 })

    // Force a persist flush (same pattern `amplifier-restore-rust.spec.ts`
    // uses) so the assertions below don't race the debounce.
    await page.evaluate(() => {
      (window as any).__FRESHELL_TEST_HARNESS__?.dispatch({ type: 'persist/flushNow' })
    })

    const layoutBefore = await page.evaluate(() => localStorage.getItem('freshell.layout.v3'))
    expect(layoutBefore, 'localStorage should hold the persisted layout before reload').toBeTruthy()
    expect(layoutBefore).toContain('amplifier')

    await page.reload({ waitUntil: 'domcontentloaded' })
    await harness.waitForHarness()
    await harness.waitForConnection()

    // GREEN today: the raw bytes survive the reload untouched -- this is
    // the "data preserved" half of the incident shape. `zTabMode` only
    // governs the client's IN-MEMORY parse/hydrate step, never the write
    // path, so nothing here should ever mutate what was written before the
    // reload.
    const layoutAfter = await page.evaluate(() => localStorage.getItem('freshell.layout.v3'))
    expect(layoutAfter, 'localStorage layout must still hold the data after reload (preserved-but-rejected)').toBeTruthy()
    expect(layoutAfter).toContain('amplifier')

    // RED today (see this file's top doc comment for the exact flip
    // instruction): `zTabMode` (`src/store/persistedState.ts:22`) does not
    // include `'amplifier'`. `freshell.layout.v3` is validated in ONE
    // shot by `zPersistedLayoutPayload` (`persistedState.ts:360-365`),
    // which embeds `zPersistedTabsState` -> `zTab` -> `zTabMode` for its
    // `tabs` field -- so ONE tab carrying an out-of-enum `mode` fails
    // `zPersistedLayoutPayload.safeParse` for the ENTIRE combined payload
    // (tabs AND panes AND tombstones together, `parsePersistedLayoutRaw`
    // returns `null`), not just that one tab. The rehydrated tab strip
    // renders empty, even though the exact bytes that same tab's content
    // came from are still sitting untouched in `freshell.layout.v3` above.
    // This is the exact incident shape: data preserved, but rejected from
    // ever being shown again.
    test.fail(true, 'KNOWN BUG (client-side, shared): zTabMode enum in ' +
      'src/store/persistedState.ts does not include "amplifier", so ' +
      'parsePersistedTabsRaw drops the ENTIRE persisted tabs payload on ' +
      'reload once any tab carries that mode. Once the client fix for this ' +
      '(persistedState.ts zTabMode enum, or an equivalent tolerant-parse ' +
      'fix) lands on this branch, this test.fail() call itself will start ' +
      'failing (an unexpected pass trips a test.fail()-annotated test into ' +
      'a hard failure) -- that is the signal to delete this test.fail() ' +
      'call and let the assertion below run as a normal green expectation.')
    await expect(tabStrip.getByText('amplifier-poison-tab')).toBeVisible({ timeout: 15_000 })
  })
})
