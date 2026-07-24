import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect } from '../helpers/fixtures.js'
import { createE2eServerHandle } from '../helpers/external-target.js'
import { TestHarness } from '../helpers/test-harness.js'
import { openPanePicker } from '../helpers/pane-picker.js'

/**
 * SYNC-05 -- "Gate current-main expected-restart behavior across owners"
 * (docs/plans/2026-07-14-rust-tauri-parity-completion-checklist.md):
 *
 *   "This regression gate depends on TERM-22, SAFE-11, and TAURI-30;
 *    expected restart reconnects quietly while unexpected crash retains
 *    diagnostics."
 *   Playwright validation (PW-RUST, PW-TAURI-WIN): "After the dependent
 *    implementations pass, capture browser console/toasts/logs across
 *    deliberate general/Codex/app-bound restarts and equivalent crashes;
 *    assert no user-facing error noise for expected cases with successful
 *    reconnect and actionable diagnostics for unexpected cases."
 *
 * This is the OUTER spec for the "expected restart is quiet" half of that
 * gate, authored ahead of the TERM-22/SAFE-11/TAURI-30 implementation wave
 * (an experience test defining the acceptance bar before the feature
 * lands). It covers:
 *
 *   1. The GENERAL (plain-terminal) deliberate-restart case, via the
 *      generic, already-owned `E2eServerHandle.restart()` seam (HARNESS-02).
 *   2. The CODEX/APP-BOUND deliberate-restart case (2026-07-19, this task):
 *      a FreshCodex pane, backed by the JSON-RPC app-server sidecar (the
 *      SAME `fake-app-server.mjs` fixture and `freshAgent.create`/
 *      `freshAgent.attach` wire observables `restore-matrix.spec.ts`'s
 *      "targets the same durable thread ... after a full server restart"
 *      scenario already proves session-continuity for), reconnects quietly
 *      AND targets the SAME durable session after the restart. This became
 *      testable once that restore machinery landed; see that spec's own
 *      TERM-02 fix note for the underlying mechanism this leg reuses.
 *
 * The equivalent-crash/diagnostics-retained case and the WIN/Tauri-only
 * `PW-TAURI-WIN` half of the validation remain out of scope for a
 * `test/e2e-browser/**`-owned browser spec and are left to the dependent
 * tickets' own test surfaces.
 *
 * "Quiet" is defined, per grep evidence of this codebase's OWN convention
 * for user-facing error/warning surfaces, as the absence of:
 *   - any visible `role="alert"` element (TabsView's "Tabs sync unavailable"
 *     banner and SetupWizard's setup warnings both use this role for
 *     user-facing error/warning noise -- nothing should use it after an
 *     EXPECTED restart's reconnect settles);
 *   - the auth-required modal (`AuthRequiredModal.tsx`, `role="dialog"`,
 *     `aria-label="Authentication required"`) -- the noisy-path UI a user
 *     would see if the reconnect were genuinely broken (e.g. token
 *     rejected), which must not appear since the original token is still
 *     valid against the restarted process;
 *   - any plain-text error/failure language visible anywhere on the page
 *     (a broad safety net for banners that might not carry an ARIA role).
 * None of this touches the terminal's own informational
 * "[Reconnecting...]" scrollback notice (`TerminalView.tsx`), which is
 * expected chrome for an in-flight reconnect, not user-facing error noise.
 *
 * Routed through the generic `E2eServerHandle`/`e2eServerKind` seam (HARNESS-02)
 * -- no server-kind-specific assertions -- so this SAME spec runs against
 * both the legacy Node server and the owned Rust server per MATRIX_SPECS.
 */

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const FAKE_CODEX_APP_SERVER_SOURCE = path.resolve(
  __dirname,
  '../../fixtures/coding-cli/codex-app-server/fake-app-server.mjs',
)

/**
 * Same re-exec wrapper `restore-matrix.spec.ts`'s `installFakeCodexAppServer`
 * uses (duplicated locally -- not exported there, and this spec owns only
 * `test/e2e-browser/**`): re-execs `node <original fixture path>` rather than
 * copying the fixture's content (which would break its `import { WebSocketServer }
 * from 'ws'` bare-specifier resolution outside the real project tree).
 */
async function installFakeCodexAppServer(destDir: string): Promise<string> {
  await fs.mkdir(destDir, { recursive: true })
  const dest = path.join(destDir, 'fake-codex-app-server-wrapper.mjs')
  const wrapper = `#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
const target = ${JSON.stringify(FAKE_CODEX_APP_SERVER_SOURCE)}
const result = spawnSync(process.execPath, [target, ...process.argv.slice(2)], { stdio: 'inherit' })
process.exit(result.status ?? 1)
`
  await fs.writeFile(dest, wrapper, 'utf8')
  await fs.chmod(dest, 0o755)
  return dest
}

/** Find the (first) fresh-agent leaf node within a possibly-split pane layout tree. */
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

test.describe('SYNC-05 -- quiet reconnect after an expected server restart', () => {
  test.setTimeout(120_000)

  test('a live terminal pane reconnects quietly after a deliberate server restart, with no user-facing error noise', async ({ page, terminal, e2eServerKind }) => {
    const server = await createE2eServerHandle(process.env, { kind: e2eServerKind })
    const info = await server.start()

    try {
      await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
      const harness = new TestHarness(page)
      await harness.waitForHarness()
      await harness.waitForConnection()
      await selectShellIfPickerShowing(page)
      await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })

      const markerBefore = `SYNC05-PRE-${Math.random().toString(36).slice(2, 10)}`
      await terminal.executeCommand(`echo ${markerBefore}`)
      await terminal.waitForOutput(markerBefore, { timeout: 15_000 })

      const tabId = await harness.getActiveTabId()
      expect(tabId).toBeTruthy()

      // Sanity: no noise BEFORE the restart either (establishes the pane
      // starts from a genuinely quiet baseline, so any noise found later is
      // attributable to the restart itself).
      await expect(page.getByRole('alert')).toHaveCount(0)

      if (!server.restart) {
        throw new Error(`${e2eServerKind} E2eServerHandle does not implement restart()`)
      }

      // --- THE DELIBERATE, EXPECTED RESTART. This is an intentional
      // operator/user-driven restart of the owned server process (NOT a
      // crash) -- exactly the "expected restart" half of SYNC-05's
      // acceptance text. All PTYs are lost; the client's WS auto-reconnect
      // must recover the pane WITHOUT surfacing user-facing error noise. ---
      await server.restart()

      // Reconnect completes.
      await expect(async () => {
        const status = await page.evaluate(() => window.__FRESHELL_TEST_HARNESS__?.getWsReadyState())
        expect(status).toBe('ready')
      }).toPass({ timeout: 30_000 })

      // (a) QUIET -- no visible ARIA alert anywhere on the page. `role="alert"`
      // is this codebase's own convention for user-facing error/warning
      // banners (TabsView's "Tabs sync unavailable", SetupWizard's setup
      // warnings) -- confirmed via grep, none should be showing once the
      // reconnect settles.
      await expect(page.getByRole('alert')).toHaveCount(0)

      // (a2) QUIET -- the auth-required modal (the noisy-path UI a user
      // would see for a genuinely broken/unexpected reconnect, e.g. a
      // rejected token) must not appear -- the original token is still
      // valid against the restarted process.
      await expect(page.getByRole('dialog', { name: /authentication required/i })).toHaveCount(0)

      // (a3) QUIET -- broad safety net: no visible plain-text error/failure
      // language anywhere on the page (in case a future noisy banner omits
      // an ARIA role). Deliberately does NOT match "reconnect"/"reconnecting"
      // -- the terminal's own informational "[Reconnecting...]" scrollback
      // notice is expected chrome for an in-flight reconnect, not noise.
      const noisyTextVisible = await page
        .getByText(/authentication required|connection lost|failed to reconnect|unexpected error|something went wrong/i)
        .first()
        .isVisible()
        .catch(() => false)
      expect(noisyTextVisible).toBe(false)

      // (b) USABLE -- the pane returns to a working state: status is never
      // 'error', and a fresh terminalId is assigned (server-restart-recovery
      // .spec.ts's acceptance shape -- PTYs don't survive a real restart).
      await expect(async () => {
        const layout = await harness.getPaneLayout(tabId!)
        expect(layout?.content?.status).not.toBe('error')
        expect(layout?.content?.terminalId).toBeTruthy()
      }).toPass({ timeout: 30_000 })

      // (c) FUNCTIONAL -- the reattached/recreated terminal genuinely still
      // works: a fresh command executes and its output is visible.
      const markerAfter = `SYNC05-POST-${Math.random().toString(36).slice(2, 10)}`
      await terminal.executeCommand(`echo ${markerAfter}`)
      await terminal.waitForOutput(markerAfter, { timeout: 15_000 })
    } finally {
      await server.stop().catch(() => {})
    }
  })

  // -------------------------------------------------------------------
  // CODEX/APP-BOUND LEG (2026-07-19, this task) -- the deliberate-restart
  // half of SYNC-05 for a FreshCodex pane, backed by the JSON-RPC
  // app-server sidecar (NOT a plain-CLI terminal). Reuses the exact
  // `fake-app-server.mjs` fixture and `freshAgent.create`/`freshAgent.attach`
  // wire-observable pattern `restore-matrix.spec.ts`'s "targets the same
  // durable thread ... after a full server restart" scenario already
  // proves session-continuity with -- this leg ADDS the SYNC-05 "quiet"
  // assertions (no role="alert", no auth modal, no plain-text error
  // language) on top of that same restart, closing the "Codex/app-bound
  // restart leg" the file-level doc comment above previously left open.
  // -------------------------------------------------------------------
  test('a FreshCodex pane reconnects quietly after a deliberate server restart, targeting the same durable session with no user-facing error noise', async ({ page, e2eServerKind }) => {
    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-sync05-codex-'))
    try {
      const fakeCodexPath = await installFakeCodexAppServer(path.join(sharedRoot, 'bin'))

      const server = await createE2eServerHandle(process.env, {
        kind: e2eServerKind,
        construct: {
          env: { CODEX_CMD: fakeCodexPath },
          setupHome: async (homeDir) => {
            const freshellDir = path.join(homeDir, '.freshell')
            await fs.mkdir(freshellDir, { recursive: true })
            await fs.writeFile(path.join(freshellDir, 'config.json'), JSON.stringify({
              version: 1,
              settings: {
                freshAgent: { enabled: true },
                codingCli: {
                  enabledProviders: ['codex'],
                  providers: { codex: { model: 'gpt-5-codex', sandbox: 'workspace-write' } },
                },
              },
            }, null, 2))
          },
        },
      })
      const info = await server.start()

      try {
        await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
        const harness = new TestHarness(page)
        await harness.waitForHarness()
        await harness.waitForConnection()
        // Select a plain shell for the FIRST pane -- matching
        // `restore-matrix.spec.ts`'s `bootAndConnect` default -- so
        // `openPanePicker` below takes the "split an existing pane" path
        // (right-click > split horizontally) rather than the bare "Add
        // pane" path a picker-less empty tab would otherwise use.
        await selectShellIfPickerShowing(page)
        await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })

        // Client-only concern: the picker only shows Freshcodex if the
        // codex CLI appears available (same pattern `restore-matrix
        // .spec.ts` uses -- the fixture stands in for a real codex binary
        // on PATH).
        await page.evaluate(() => {
          window.__FRESHELL_TEST_HARNESS__?.dispatch({
            type: 'connection/setAvailableClis',
            payload: { claude: false, codex: true },
          })
        })

        await harness.clearSentWsMessages()
        const picker = await openPanePicker(page)
        await picker.getByRole('button', { name: /^Freshcodex$/i }).click({ force: true })
        await page.getByRole('option').first().click()

        const paneRoot = page.locator('[data-context="fresh-agent"]').last()
        await expect(paneRoot).toBeVisible({ timeout: 15_000 })

        await expect.poll(async () => {
          const sent = await harness.getSentWsMessages()
          return sent.some((m: any) => m?.type === 'freshAgent.create' && m?.provider === 'codex')
        }, { timeout: 15_000 }).toBe(true)

        const tabId = await harness.getActiveTabId()
        expect(tabId).toBeTruthy()

        // Requires the real sidecar round trip to settle (a genuine
        // server-assigned session id, not a createRequestId fallback) --
        // the post-restart continuity assertion below needs it.
        const originalSessionId: string = await expect.poll(async () => {
          const layout = await harness.getPaneLayout(tabId!)
          const leaf = findFreshAgentLeaf(layout)
          return leaf?.content?.sessionId ?? leaf?.content?.sessionRef?.sessionId ?? null
        }, { timeout: 30_000 }).not.toBeNull().then(async () => {
          const layout = await harness.getPaneLayout(tabId!)
          const leaf = findFreshAgentLeaf(layout)
          return leaf.content.sessionId ?? leaf.content.sessionRef.sessionId
        })
        expect(originalSessionId).toBeTruthy()

        // One real, independently-confirmed live turn -- establishes
        // genuine functional content (not a blank/placeholder pane) before
        // the restart, mirroring `restore-matrix.spec.ts`'s pattern.
        const composer = paneRoot.getByRole('textbox', { name: 'Chat message input' })
        const sendButton = paneRoot.getByRole('button', { name: 'Send' })
        await expect.poll(async () => {
          const layout = await harness.getPaneLayout(tabId!)
          return findFreshAgentLeaf(layout)?.content?.status
        }, { timeout: 20_000 }).toBe('idle')
        const turnText = `sync05-codex-turn-${Math.random().toString(36).slice(2, 8)}`
        await composer.fill(turnText)
        await sendButton.click()
        await expect(paneRoot.getByText(turnText)).toBeVisible({ timeout: 10_000 })
        await expect(paneRoot.getByText('Fixture turn')).toBeVisible({ timeout: 20_000 })

        // Sanity: quiet BEFORE the restart too (genuinely quiet baseline).
        await expect(page.getByRole('alert')).toHaveCount(0)

        if (!server.restart) {
          throw new Error(`${e2eServerKind} E2eServerHandle does not implement restart()`)
        }

        await harness.clearSentWsMessages()

        // --- THE DELIBERATE, EXPECTED RESTART. The fake app-server child
        // is a descendant of the server process and dies with it -- same
        // as the general-terminal leg above, but this pane's identity/
        // continuity depends on the FreshCodex sidecar restart path
        // specifically (TERM-22/SAFE-11 territory), not a plain PTY. ---
        await server.restart()

        await page.reload({ waitUntil: 'domcontentloaded' })
        await harness.waitForHarness()
        await harness.waitForConnection()

        // (a) QUIET -- identical bar to the general-terminal leg above.
        await expect(page.getByRole('alert')).toHaveCount(0)
        await expect(page.getByRole('dialog', { name: /authentication required/i })).toHaveCount(0)
        const noisyTextVisible = await page
          .getByText(/authentication required|connection lost|failed to reconnect|unexpected error|something went wrong/i)
          .first()
          .isVisible()
          .catch(() => false)
        expect(noisyTextVisible).toBe(false)

        // (b) SAME DURABLE SESSION -- every `freshAgent.create`/
        // `freshAgent.attach` sent after the restart targets the ORIGINAL
        // session (the wire-level proof `restore-matrix.spec.ts`'s TERM-02
        // scenario establishes), never a fresh/unrelated one.
        await expect(page.locator('[data-context="fresh-agent"]').last()).toBeVisible({ timeout: 20_000 })
        await expect.poll(async () => {
          const sent = await harness.getSentWsMessages()
          return sent.some((m: any) =>
            (m?.type === 'freshAgent.attach' || m?.type === 'freshAgent.create')
            && (m?.sessionId === originalSessionId
              || m?.resumeSessionId === originalSessionId
              || m?.sessionRef?.sessionId === originalSessionId),
          )
        }, { timeout: 20_000 }).toBe(true)

        const rehydratedTabId = await harness.getActiveTabId()
        const rehydratedLayout = await harness.getPaneLayout(rehydratedTabId!)
        const rehydratedLeaf = findFreshAgentLeaf(rehydratedLayout)
        expect(rehydratedLeaf?.content?.sessionId ?? rehydratedLeaf?.content?.sessionRef?.sessionId)
          .toBe(originalSessionId)

        // (c) FUNCTIONAL -- the resumed pane renders real, non-blank
        // content and settles idle (genuinely usable, not stuck
        // reconnecting).
        await expect(page.locator('[data-context="fresh-agent"]').last().getByText('Fixture turn'))
          .toBeVisible({ timeout: 20_000 })
        await expect.poll(async () => {
          const layout = await harness.getPaneLayout(rehydratedTabId!)
          return findFreshAgentLeaf(layout)?.content?.status
        }, { timeout: 20_000 }).toBe('idle')
      } finally {
        await server.stop().catch(() => {})
      }
    } finally {
      await fs.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })
})
