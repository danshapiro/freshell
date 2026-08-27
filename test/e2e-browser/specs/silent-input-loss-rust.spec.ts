/**
 * Kata dtfn: typed input during the pane-recreate window after a server
 * restart was SILENTLY LOST (head-truncated commands). This spec types a
 * marker at the exact reconnect-before-reattach moment -- the discriminating
 * scenario from the diagnosis -- and asserts the FULL marker arrives
 * byte-for-byte in the recreated terminal. The client buffers un-anchored
 * keystrokes and flushes them after the pane's next anchor, so the design
 * guarantee here is ARRIVAL (the visible input-loss notice is the fallback
 * for overflow/timeout paths, covered by unit tests).
 *
 * because it imports RustServer directly for restart() (same-home/same-port/
 * same-token revival -- the browser's WS auto-reconnect targets the original
 * port, so only a same-port restart lets the existing page reconnect).
 *
 * The post-restart `.xterm` click is safe because the 'creating' blocking
 * overlay is pointer-events-none (invariant 10a) -- without that fix the
 * click would blur xterm and the typed marker would never reach onData.
 */
import { randomUUID } from 'node:crypto'
import { test, expect, type Page } from '@playwright/test'
import { RustServer } from '../helpers/rust-server.js'
import { TestHarness } from '../helpers/test-harness.js'
import { TerminalHelper } from '../helpers/terminal-helpers.js'
import { openPanePicker, clickFirstVisibleShellOption } from '../helpers/pane-picker.js'

async function selectFirstShellFromPicker(page: Page): Promise<void> {
  await openPanePicker(page)
  await clickFirstVisibleShellOption(page)
}

/** Poll the in-page harness until the WS transport reports 'ready'. */
async function waitForWsReady(page: Page, timeoutMs = 60_000): Promise<void> {
  await expect(async () => {
    const status = await page.evaluate(
      () => (window as any).__FRESHELL_TEST_HARNESS__?.getWsReadyState(),
    )
    expect(status).toBe('ready')
  }).toPass({ timeout: timeoutMs })
}

test.describe('silent input loss across restart (kata dtfn)', () => {
  test.setTimeout(180_000)

  test('input typed in the reconnect-before-reattach window arrives byte-exact', async ({ page }) => {
    const server = new RustServer({ verbose: false })
    const info = await server.start()
    expect(info.port).not.toBe(3001)
    expect(info.port).not.toBe(3002)

    try {
      await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
      const harness = new TestHarness(page)
      const terminal = new TerminalHelper(page)
      await harness.waitForHarness()
      await harness.waitForConnection()
      await selectFirstShellFromPicker(page)
      await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })

      const tabId = (await harness.getActiveTabId())!
      await expect
        .poll(async () => (await harness.getPaneLayout(tabId))?.content?.terminalId ?? null, {
          timeout: 20_000,
        })
        .not.toBeNull()
      const terminalIdBefore = (await harness.getPaneLayout(tabId))?.content?.terminalId as string

      // Prove the pane is live pre-restart.
      const preMarker = `DTFN-PRE-${randomUUID()}`
      await terminal.executeCommand(`echo ${preMarker}`)
      await terminal.waitForOutput(preMarker, { timeout: 20_000, terminalId: terminalIdBefore })

      // --- Restart, and type in the un-anchored window. Typing after
      // waitForWsReady is NOT reliably discriminating on this machine: the
      // reconnect + pane recreate completed before the click landed (the
      // pane had already re-anchored -- measured, new terminalId + status
      // 'running' at type time). So type while the socket is observably
      // DOWN instead -- strictly harder, and it exercises the same buffer
      // path (TerminalView's input gate buffers on the synchronous
      // `ws.isReady === false` arm as well as post-disconnect-before-anchor).
      const restarted = server.restart()
      await expect(async () => {
        const status = await page.evaluate(
          () => (window as any).__FRESHELL_TEST_HARNESS__?.getWsReadyState(),
        )
        expect(status).not.toBe('ready')
      }).toPass({ timeout: 30_000 })

      const marker = `DTFN-POST-${randomUUID()}`
      await page.locator('.xterm').first().click()
      await page.keyboard.type(`echo ${marker}`)
      await page.keyboard.press('Enter')

      await restarted
      await waitForWsReady(page)

      // Deterministic anchor wait: pane recreates with a NEW terminalId.
      // 60s, not 30s: post-restart recreate has documented slow-path history
      // under parallel-worker load (ledger A23; 402e3ed3 bumped waits to 60s).
      await expect
        .poll(async () => {
          const tid = (await harness.getPaneLayout(tabId))?.content?.terminalId ?? null
          return tid && tid !== terminalIdBefore ? tid : null
        }, { timeout: 60_000 })
        .not.toBeNull()
      const terminalIdAfter = (await harness.getPaneLayout(tabId))?.content?.terminalId as string

      // The buffered keystrokes flush after the anchor: the marker output
      // must appear -- and the ECHOED COMMAND LINE must be intact too (the
      // historical failure truncated the head: "command not found" from a
      // marker-uuid tail).
      await expect
        .poll(async () => {
          const buffer = await harness.getTerminalBuffer(terminalIdAfter)
          return typeof buffer === 'string' && buffer.includes(marker)
        }, { timeout: 60_000 })
        .toBe(true)
      const buffer = (await harness.getTerminalBuffer(terminalIdAfter)) ?? ''
      expect(buffer).toContain(`echo ${marker}`)
      expect(buffer).not.toContain('command not found')
    } finally {
      await server.stop()
    }
  })
})
