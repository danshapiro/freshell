import { test, expect } from '../helpers/fixtures.js'
import { createE2eServerHandle } from '../helpers/external-target.js'
import { TestHarness } from '../helpers/test-harness.js'

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
 * lands). It covers the general (plain-terminal) deliberate-restart case
 * via the generic, already-owned `E2eServerHandle.restart()` seam (HARNESS-02)
 * -- the Codex/app-bound and equivalent-crash cases, and the WIN/Tauri-only
 * `PW-TAURI-WIN` half of the validation, are out of scope for a
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
})
