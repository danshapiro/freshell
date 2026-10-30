import { createServer, type ServerResponse } from 'node:http'
import { test, expect, type Page } from '@playwright/test'
import { TestHarness } from '../helpers/test-harness.js'
import { resumeStoppedRepairBrowserView } from '../helpers/stopped-repair-browser-phase.js'

test.describe.configure({ retries: 0 })

type Fault = 'held load' | 'absent harness' | 'disabled Resume' | 'none'

async function fixture(page: Page, fault: Fault) {
  let reloading = false
  const held = new Set<ServerResponse>()
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const server = createServer((request, response) => {
    if (request.url === '/resource' && reloading && fault === 'held load') {
      held.add(response)
      const timer = setTimeout(() => {
        response.end('released')
        held.delete(response)
        timers.delete(timer)
      }, 6_000)
      timers.add(timer)
      return
    }
    if (request.url === '/resource') {
      response.end('ready')
      return
    }
    const delayHarness = reloading && fault === 'absent harness'
    const disabled = reloading && fault === 'disabled Resume'
    response.setHeader('content-type', 'text/html')
    response.end(`<!doctype html><html><body>
      <div data-pane-id="fixture-pane"><div data-testid="managed-runtime-recovery-card">
        <button ${disabled ? 'disabled' : ''} onclick="window.fixtureClicks++">Resume restored session</button>
      </div></div><img src="/resource" alt="">
      <script>
        window.fixtureClicks = 0; window.fixtureSelected = null; window.fixtureSelections = 0;
        function install() {
          window.__FRESHELL_TEST_HARNESS__ = {
            getState: () => ({ connection: { status: 'ready' } }),
            getWsReadyState: () => 'ready',
            dispatch: action => { window.fixtureSelected = action.payload; window.fixtureSelections++; }
          };
        }
        ${delayHarness ? 'setTimeout(install, 6000)' : 'install()'};
        ${disabled ? "setTimeout(() => document.querySelector('button').disabled = false, 6000)" : ''};
      </script></body></html>`)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture has no owned TCP address')
  return {
    async open() {
      await page.goto(`http://127.0.0.1:${address.port}`, { timeout: 10_000 })
      reloading = true
    },
    async close() {
      try {
        await page.close()
      } finally {
        for (const timer of timers) clearTimeout(timer)
        for (const response of held) response.destroy()
        server.closeAllConnections()
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
        expect(server.listening).toBe(false)
        console.info(JSON.stringify({ severity: 'info', event: 'stopped_repair_browser_fixture_closed',
          pid: process.pid, port: address.port, fault }))
      }
    },
  }
}

for (const [fault, expectedPhase] of [
  ['held load', 'reload'],
  ['absent harness', 'harness'],
  ['disabled Resume', 'Resume click'],
] as const) {
  test(`stopped repair bounds ${fault} at its causal phase`, async ({ page }) => {
    test.setTimeout(30_000)
    const owned = await fixture(page, fault)
    try {
      await owned.open()
      const started = Date.now()
      const error = await resumeStoppedRepairBrowserView(page, new TestHarness(page),
        'fixture-tab', 'fixture-pane', 2_000).then(() => null, (error: unknown) => error)
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toBe(`stopped repair: ${expectedPhase} failed`)
      expect((error as Error).cause).toBeInstanceOf(Error)
      expect(((error as Error).cause as Error).message).toContain('Timeout')
      const elapsedMs = Date.now() - started
      expect(elapsedMs).toBeLessThan(5_000)
      console.info(JSON.stringify({ severity: 'info', event: 'stopped_repair_browser_phase_timeout',
        fault, phase: expectedPhase, timeoutMs: 2_000, elapsedMs,
        errorName: ((error as Error).cause as Error).name }))
      expect(await page.evaluate(() => (window as any).fixtureClicks)).toBe(0)
      if (fault === 'held load') {
        expect(await page.evaluate(() => ({
          readyState: document.readyState,
          harnessPresent: !!window.__FRESHELL_TEST_HARNESS__,
          selected: (window as any).fixtureSelected,
        }))).toEqual({ readyState: 'interactive', harnessPresent: true, selected: null })
      }
      // Releasing actionability after a rejected click must not dispatch a late action.
      if (fault === 'disabled Resume') {
        await page.getByRole('button').evaluate(button => { (button as HTMLButtonElement).disabled = false })
        await page.waitForTimeout(300)
        expect(await page.evaluate(() => (window as any).fixtureClicks)).toBe(0)
      }
    } finally {
      await owned.close()
    }
  })
}

test('stopped repair completes ready reload and one Resume action', async ({ page }) => {
  const owned = await fixture(page, 'none')
  try {
    await owned.open()
    await resumeStoppedRepairBrowserView(page, new TestHarness(page), 'fixture-tab', 'fixture-pane', 2_000)
    expect(await page.evaluate(() => ({ selected: (window as any).fixtureSelected,
      selections: (window as any).fixtureSelections,
      clicks: (window as any).fixtureClicks }))).toEqual({ selected: 'fixture-tab', selections: 1, clicks: 1 })
  } finally {
    await owned.close()
  }
})
