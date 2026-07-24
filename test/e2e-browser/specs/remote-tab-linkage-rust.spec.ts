import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect } from '../helpers/fixtures.js'
import { createE2eServerHandle } from '../helpers/external-target.js'
import { TestHarness } from '../helpers/test-harness.js'

/**
 * REMOTE TAB LINKAGE -- the e2e proof for STATE-SYNC FIX 1 (EDEV-07 +
 * increment 2, rust commit `80772ff2`): a REST-created amplifier resume tab
 * must be fully LINKED, not a grey orphan.
 *
 * This is the user's exact 2026-07-19 incident chain
 * (`docs/plans/2026-07-19-state-sync-cartography.md` Part 1), replayed and
 * now expected GREEN because the rust server synthesizes the canonical
 * `sessionRef {provider: mode, sessionId}` onto the `ui.command{tab.create}`
 * payload (`crates/freshell-freshagent/src/terminal_tabs.rs`,
 * `spawn_terminal_pane`) instead of forwarding the legacy bare
 * `resumeSessionId` the frozen client's matchers are blind to for every
 * mode but `claude` (`src/lib/session-utils.ts:135-139`):
 *
 *   1. Sidebar linkage: the session-directory row renders OPEN
 *      (`data-has-tab="true"` on the row button, `src/components/Sidebar.tsx:857`;
 *      the icon flips to `text-success`, `:865`) -- the `hasTab` matcher keys
 *      on pane `sessionRef` (`sidebarSelectors.ts:198-203` ->
 *      `extractSessionLocators`).
 *   2. Tab dedupe: clicking that sidebar row FOCUSES the existing REST tab
 *      (tab count unchanged) -- `findTabIdForSession` joins on the same
 *      extraction (`src/store/tabsSlice.ts:721-763`).
 *   3. Restart durability: the persisted layout (`freshell.layout.v3`)
 *      carries the synthesized `sessionRef` (persist-save strips
 *      `resumeSessionId` outright, `persistMiddleware.ts:245-264` -- the
 *      sessionRef is the ONLY key that survives), so after
 *      `server.restart()` + reload the pane respawns via
 *      `amplifier resume <id>` (argv-log proof).
 *
 * KNOWN DIVERGENCE (rust-only, by design -- same note as
 * `amplifier-restore-rust.spec.ts` / `rest-tab-persistence.spec.ts` /
 * `session-directory-matrix.spec.ts`): this branch's FROZEN legacy `server/`
 * tree predates upstream #514 (`05c6b1fa`) and has no amplifier provider
 * registered at all, so this scenario cannot run there. Registered ONLY
 * under the `rust-chromium` project in `playwright.config.ts`.
 */

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const FAKE_AMPLIFIER_CLI_SOURCE = path.resolve(__dirname, '../fixtures/fake-amplifier-cli.mjs')

/** Same copy-then-chmod pattern as `amplifier-restore-rust.spec.ts`. */
async function installFakeAmplifierCli(binDir: string): Promise<string> {
  await fs.mkdir(binDir, { recursive: true })
  const target = path.join(binDir, 'amplifier')
  await fs.copyFile(FAKE_AMPLIFIER_CLI_SOURCE, target)
  await fs.chmod(target, 0o755)
  return target
}

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

/** Read the fake CLI's argv-log JSONL (empty array if not yet written). */
async function readArgvLog(logPath: string): Promise<Array<{ argv: string[] }>> {
  const raw = await fs.readFile(logPath, 'utf8').catch(() => '')
  if (!raw) return []
  return raw.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as { argv: string[] })
}

/** Recursively search parsed JSON for a `sessionRef` matching provider+id. */
function containsSessionRef(node: unknown, provider: string, sessionId: string): boolean {
  if (!node || typeof node !== 'object') return false
  const obj = node as Record<string, unknown>
  const ref = obj.sessionRef as Record<string, unknown> | undefined
  if (ref && ref.provider === provider && ref.sessionId === sessionId) return true
  return Object.values(obj).some((value) => containsSessionRef(value, provider, sessionId))
}

test.describe('Remote tab linkage (Rust only)', () => {
  test.setTimeout(150_000)

  test('a REST-created amplifier resume tab shows OPEN in the sidebar, dedupes on sidebar click, and survives a server restart via the persisted sessionRef', async ({ page, e2eServerKind }) => {
    // Registered ONLY under `rust-chromium` (`playwright.config.ts`) --
    // assert the precondition explicitly so an accidental matrix inclusion
    // fails loudly instead of silently no-op'ing on legacy.
    expect(e2eServerKind).toBe('rust')

    const SEEDED_SESSION_ID = 'amp-remote-linkage-0001'
    const SESSION_TITLE = 'remote-tab-linkage seeded session'
    const TAB_NAME = 'remote-linkage-tab'

    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-remote-tab-linkage-'))
    const argLogPath = path.join(sharedRoot, 'fake-amplifier-argv.jsonl')
    const projectDir = path.join(sharedRoot, 'project')
    await fs.mkdir(projectDir, { recursive: true })

    try {
      const fakeAmplifierPath = await installFakeAmplifierCli(path.join(sharedRoot, 'bin'))

      const server = await createE2eServerHandle(process.env, {
        kind: e2eServerKind,
        construct: {
          env: {
            AMPLIFIER_CMD: fakeAmplifierPath,
            FAKE_AMPLIFIER_ARGV_LOG: argLogPath,
          },
          setupHome: async (homeDir) => {
            // Same settings surface `amplifier-restore-rust.spec.ts` seeds.
            const freshellDir = path.join(homeDir, '.freshell')
            await fs.mkdir(freshellDir, { recursive: true })
            await fs.writeFile(path.join(freshellDir, 'config.json'), JSON.stringify({
              version: 1,
              settings: {
                codingCli: { enabledProviders: ['amplifier'] },
              },
            }, null, 2))

            // Seed the amplifier session the REST create will resume --
            // same fixture shape as `sidebar-click-resume.spec.ts` /
            // `session-directory-matrix.spec.ts` (`metadata.json` + sibling
            // `transcript.jsonl` under
            // `<amplifier_home>/projects/<slug>/sessions/<id>/`;
            // `working_dir` is mandatory -- the indexer's R10b cwd gate,
            // `crates/freshell-sessions/src/amplifier.rs::parse_amplifier_file`).
            const sessionDir = path.join(
              homeDir, '.amplifier', 'projects', 'remote-linkage-project', 'sessions', SEEDED_SESSION_ID,
            )
            await fs.mkdir(sessionDir, { recursive: true })
            await fs.writeFile(
              path.join(sessionDir, 'metadata.json'),
              JSON.stringify({
                session_id: SEEDED_SESSION_ID,
                working_dir: projectDir,
                created: '2026-07-20T08:00:00.000Z',
                description_updated_at: '2026-07-20T08:00:02.000Z',
                name: SESSION_TITLE,
                description: `${SESSION_TITLE} summary`,
              }),
            )
            await fs.writeFile(
              path.join(sessionDir, 'transcript.jsonl'),
              [
                JSON.stringify({ role: 'user', content: `${SESSION_TITLE} request 1` }),
                JSON.stringify({ role: 'assistant', content: `${SESSION_TITLE} reply 1` }),
              ].join('\n') + '\n',
            )
          },
        },
      })
      const info = await server.start()

      try {
        const harness = await bootAndConnect(page, info)
        await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })

        // The seeded session's sidebar row (`SidebarItem`,
        // `src/components/Sidebar.tsx:852-857`: `data-session-id` /
        // `data-provider` / `data-has-tab` on the row button). GREY first:
        // no tab references it yet.
        const sessionRow = page.locator(
          `[data-session-id="${SEEDED_SESSION_ID}"][data-provider="amplifier"]`,
        ).first()
        await expect(sessionRow).toBeVisible({ timeout: 20_000 })
        await expect(sessionRow).toHaveAttribute('data-has-tab', 'false')

        const tabCountBeforeCreate = await harness.getTabCount()

        // ------------------------------------------------------------------
        // Step 2: the incident's exact trigger -- REST create with a bare
        // legacy `resumeSessionId` (no sessionRef in the request).
        // ------------------------------------------------------------------
        const res = await fetch(`${info.baseUrl}/api/tabs`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-auth-token': info.token },
          body: JSON.stringify({
            mode: 'amplifier',
            cwd: projectDir,
            resumeSessionId: SEEDED_SESSION_ID,
            name: TAB_NAME,
          }),
        })
        const body = await res.json()
        expect(res.status, JSON.stringify(body)).toBe(200)
        const restTabId: string = body?.data?.tabId
        expect(restTabId).toBeTruthy()

        // The tab materializes in the live browser via the
        // `ui.command{tab.create}` broadcast.
        const tabStrip = page.locator('[data-testid="tab-strip"]')
        await expect(tabStrip.getByText(TAB_NAME)).toBeVisible({ timeout: 15_000 })
        await expect.poll(() => harness.getTabCount()).toBe(tabCountBeforeCreate + 1)

        // The spawned PTY genuinely resumed the seeded session (fake CLI
        // argv log -- this first entry is the CREATE-time resume; the
        // restart proof below asserts a NEW one beyond this count).
        const resumesAfterCreate = await expect.poll(async () => {
          const lines = await readArgvLog(argLogPath)
          return lines.filter((e) => e.argv[0] === 'resume' && e.argv[1] === SEEDED_SESSION_ID).length
        }, { timeout: 20_000 }).toBeGreaterThan(0).then(async () => {
          const lines = await readArgvLog(argLogPath)
          return lines.filter((e) => e.argv[0] === 'resume' && e.argv[1] === SEEDED_SESSION_ID).length
        })

        // ------------------------------------------------------------------
        // Step 3: SIDEBAR LINKAGE -- the row flips to OPEN. This was the
        // incident's headline symptom (grey forever); the matcher only
        // joins on pane `sessionRef`, which the server now synthesizes.
        // ------------------------------------------------------------------
        await expect(sessionRow).toHaveAttribute('data-has-tab', 'true', { timeout: 15_000 })

        // ------------------------------------------------------------------
        // Step 4: NO DUPLICATE -- clicking the (now-open) sidebar row must
        // FOCUS the existing REST tab, not mint another one. Make the
        // check meaningful: switch away first, so the click has real work
        // to do.
        // ------------------------------------------------------------------
        const state = await harness.getState()
        const otherTabId: string | undefined = state?.tabs?.tabs
          ?.map((t: any) => t.id)
          ?.find((id: string) => id !== restTabId)
        expect(otherTabId).toBeTruthy()
        await page.evaluate((tabId: string) => {
          (window as any).__FRESHELL_TEST_HARNESS__?.dispatch({ type: 'tabs/setActiveTab', payload: tabId })
        }, otherTabId!)
        await expect.poll(() => harness.getActiveTabId()).toBe(otherTabId)

        const tabCountBeforeClick = await harness.getTabCount()
        await sessionRow.click()
        await expect.poll(() => harness.getActiveTabId(), { timeout: 15_000 }).toBe(restTabId)
        expect(await harness.getTabCount()).toBe(tabCountBeforeClick)

        // NOTE: the dedupe click also SYNCS the real session title into the
        // focused tab (`openSessionTab`, `tabsSlice.ts:683-688,730-759` --
        // one of the few matchers that already handles both identity keys),
        // so the tab is now titled with the seeded session's name, not the
        // REST `name`. Track it by ID + current title for the post-restart
        // assertions.
        const tabTitleAfterClick: string = await expect.poll(async () => {
          const s = await harness.getState()
          return s?.tabs?.tabs?.find((t: any) => t.id === restTabId)?.title ?? null
        }, { timeout: 10_000 }).not.toBeNull().then(async () => {
          const s = await harness.getState()
          return s.tabs.tabs.find((t: any) => t.id === restTabId).title
        })

        // ------------------------------------------------------------------
        // Durability mechanism: the persisted layout carries the
        // synthesized sessionRef. (Persist-save strips `resumeSessionId`
        // outright -- `persistMiddleware.ts:245-264` -- so without the
        // synthesis this pane would have NO durable identity on disk.)
        // ------------------------------------------------------------------
        await page.evaluate(() => {
          (window as any).__FRESHELL_TEST_HARNESS__?.dispatch({ type: 'persist/flushNow' })
        })
        const persistedLayout = await page.evaluate(() => localStorage.getItem('freshell.layout.v3'))
        expect(persistedLayout, 'persisted layout must exist after flush').toBeTruthy()
        expect(
          containsSessionRef(JSON.parse(persistedLayout!), 'amplifier', SEEDED_SESSION_ID),
          `freshell.layout.v3 must contain sessionRef {provider:'amplifier', sessionId:'${SEEDED_SESSION_ID}'}`,
        ).toBe(true)

        // ------------------------------------------------------------------
        // Step 5: RESTART DURABILITY -- server restart kills every PTY;
        // after reload the tab must survive and the pane must respawn via
        // `amplifier resume <id>` (a NEW argv entry beyond the create-time
        // count).
        // ------------------------------------------------------------------
        if (!server.restart) {
          throw new Error(`${e2eServerKind} E2eServerHandle does not implement restart()`)
        }
        await server.restart()

        await page.reload({ waitUntil: 'domcontentloaded' })
        await harness.waitForHarness()
        await harness.waitForConnection()
        await expect(async () => {
          const status = await page.evaluate(() => (window as any).__FRESHELL_TEST_HARNESS__?.getWsReadyState())
          expect(status).toBe('ready')
        }).toPass({ timeout: 30_000 })

        // The tab survived the restart + reload -- same tab ID in the
        // rebuilt state, and its (session-synced) title back in the strip.
        await expect.poll(async () => {
          const s = await harness.getState()
          return s?.tabs?.tabs?.some((t: any) => t.id === restTabId) ?? false
        }, { timeout: 15_000 }).toBe(true)
        await expect(tabStrip.getByText(tabTitleAfterClick)).toBeVisible({ timeout: 15_000 })

        // The restored pane respawned with `amplifier resume <id>` -- a NEW
        // invocation beyond the create-time one(s).
        await expect.poll(async () => {
          const lines = await readArgvLog(argLogPath)
          return lines.filter((e) => e.argv[0] === 'resume' && e.argv[1] === SEEDED_SESSION_ID).length
        }, { timeout: 30_000 }).toBeGreaterThan(resumesAfterCreate)

        // And the linkage itself survived: the sidebar row is OPEN again
        // (the restored pane still carries the sessionRef).
        await expect(
          page.locator(`[data-session-id="${SEEDED_SESSION_ID}"][data-provider="amplifier"]`).first(),
        ).toHaveAttribute('data-has-tab', 'true', { timeout: 20_000 })
      } finally {
        await server.stop().catch(() => {})
      }
    } finally {
      await fs.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })
})
