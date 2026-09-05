import { test, expect } from '../helpers/fixtures.js'
import { RustServer } from '../helpers/rust-server.js'
import { TestHarness } from '../helpers/test-harness.js'

/**
 * LANE C: two rapid abrupt server deaths — the second landing while the
 * client is still mid-recovery from the first — must still converge every
 * terminal pane to a live terminal. No permanent error state, no duplicate
 * tabs/panes. Rust-only: requires RustServer.restartAbrupt().
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

function collectLeaves(node: any): any[] {
  if (!node) return []
  if (node.type === 'leaf') return [node]
  if (node.type === 'split') return (node.children ?? []).flatMap(collectLeaves)
  return []
}

test.describe('Rapid double abrupt restart (Rust only)', () => {
  test.setTimeout(180_000)

  test('a shell pane converges across two rapid abrupt restarts', async ({ page }) => {
    const server = new RustServer({})
    const info = await server.start()
    try {
      await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
      const harness = new TestHarness(page)
      await harness.waitForHarness()
      await harness.waitForConnection()
      await selectShellIfPickerShowing(page)
      await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })

      const tabId = await harness.getActiveTabId()
      await expect.poll(async () => {
        return (await harness.getPaneLayout(tabId!))?.content?.terminalId ?? null
      }, { timeout: 20_000 }).not.toBeNull()
      const terminalIdBefore: string = (await harness.getPaneLayout(tabId!))?.content?.terminalId
      const tabCountBefore = await harness.getTabCount()

      // Death #1, then death #2 one second into the recovery window.
      await server.restartAbrupt()
      await page.waitForTimeout(1_000)
      await server.restartAbrupt()

      await expect(async () => {
        const status = await page.evaluate(() => (window as any).__FRESHELL_TEST_HARNESS__?.getWsReadyState())
        expect(status).toBe('ready')
      }).toPass({ timeout: 60_000 })

      // The pane re-anchors to a NEW live terminal — old PTY died with the
      // first process — and never lands in 'error'.
      await expect(async () => {
        const content = (await harness.getPaneLayout(tabId!))?.content
        expect(content?.status).not.toBe('error')
        expect(content?.terminalId).toBeTruthy()
        expect(content?.terminalId).not.toBe(terminalIdBefore)
      }).toPass({ timeout: 90_000 })

      // Convergence, not duplication.
      expect(await harness.getTabCount()).toBe(tabCountBefore)
      const state = await harness.getState()
      expect(collectLeaves(state!.panes.layouts[tabId!]).length).toBe(1)
    } finally {
      await server.stop().catch(() => {})
    }
  })
})
