/**
 * ESC-key single-ingress regression (follow-up to PR #406 / f50db7c9c): a REAL
 * Escape keydown in a mounted terminal pane must deliver exactly one
 * terminal.input frame containing the ESC byte (\u001b) through the client's
 * normal key pipeline. Frame-level assertion via the in-page test harness
 * (deterministic, no tty-semantics dependence); liveness anchors (echo marker
 * round-trip + an 'x' keypress frame) make the assertion non-vacuous.
 *
 * Rust-only: owns a RustServer directly (registered in RUST_ONLY_SPECS +
 * rust-chromium testMatch, mirroring silent-input-loss-rust.spec.ts).
 *
 * The 6-minute timeout covers RustServer.start()'s synchronous cold
 * `cargo build --release` on the first local run (observed ~2.5 min; the cloud
 * lane prebuilds the binary and never compiles). server.start() runs inside
 * the try/finally so a timeout or boot failure still stops the server and
 * removes the isolated home.
 */
import { randomUUID } from 'node:crypto'
import { test, expect, type Page } from '@playwright/test'
import { RustServer } from '../helpers/rust-server.js'
import { TestHarness } from '../helpers/test-harness.js'
import { TerminalHelper } from '../helpers/terminal-helpers.js'
import { openPanePicker, clickFirstVisibleShellOption } from '../helpers/pane-picker.js'

async function countInputFrames(page: Page, terminalId: string, data: string): Promise<number> {
  return page.evaluate(
    ({ id, needle }) => {
      const frames = (window as any).__FRESHELL_TEST_HARNESS__?.getSentWsMessages() ?? []
      return frames.filter(
        (f: any) => f?.type === 'terminal.input' && f.terminalId === id && f.data === needle,
      ).length
    },
    { id: terminalId, needle: data },
  )
}

test.describe('terminal Escape key single ingress', () => {
  test.setTimeout(360_000)

  test('real Escape keydown sends exactly one ESC terminal.input frame', async ({ page }) => {
    const server = new RustServer({ verbose: false })

    try {
      const info = await server.start()
      expect(info.port).not.toBe(3001)
      expect(info.port).not.toBe(3002)

      await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
      const harness = new TestHarness(page)
      const terminal = new TerminalHelper(page)
      await harness.waitForHarness()
      await harness.waitForConnection()
      await openPanePicker(page)
      await clickFirstVisibleShellOption(page)
      await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })

      const tabId = (await harness.getActiveTabId())!
      await expect
        .poll(async () => (await harness.getPaneLayout(tabId))?.content?.terminalId ?? null, {
          timeout: 20_000,
        })
        .not.toBeNull()
      const terminalId = (await harness.getPaneLayout(tabId))?.content?.terminalId as string

      // Liveness anchor 1: full round-trip through the pane.
      const marker = `ESC-LIVE-${randomUUID()}`
      await terminal.executeCommand(`echo ${marker}`)
      await terminal.waitForOutput(marker, { timeout: 20_000, terminalId })

      // Assertion window: clear captured frames, then press a plain key
      // (liveness anchor 2) and Escape. Each must arrive exactly once.
      await page.evaluate(() => (window as any).__FRESHELL_TEST_HARNESS__?.clearSentWsMessages())
      await page.locator('.xterm').first().click()
      await page.keyboard.press('x')
      await expect
        .poll(() => countInputFrames(page, terminalId, 'x'), { timeout: 10_000 })
        .toBe(1)

      await page.keyboard.press('Escape')
      await expect
        .poll(() => countInputFrames(page, terminalId, '\u001b'), { timeout: 10_000 })
        .toBe(1)
    } finally {
      await server.stop()
    }
  })
})
