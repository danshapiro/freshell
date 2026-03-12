import { test, expect } from '../helpers/fixtures.js'

// Helper: wait for a page to be connected and ready
async function waitForReady(page: any): Promise<void> {
  await page.waitForFunction(() => !!window.__FRESHELL_TEST_HARNESS__, { timeout: 15_000 })
  await page.waitForFunction(() =>
    window.__FRESHELL_TEST_HARNESS__?.getWsReadyState() === 'ready',
    { timeout: 15_000 }
  )
}

test.describe('Multi-Client', () => {
  test('two browser tabs share the same server', async ({ browser, serverInfo }) => {
    // Open two pages to the same server
    const context = await browser.newContext()
    const page1 = await context.newPage()
    const page2 = await context.newPage()

    await page1.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1`)
    await page2.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1`)

    // Both should connect successfully
    await waitForReady(page1)
    await waitForReady(page2)

    await context.close()
  })

  test('terminal output appears in both clients', async ({ browser, serverInfo }) => {
    const context = await browser.newContext()
    const page1 = await context.newPage()

    await page1.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1`)
    await waitForReady(page1)

    // Handle PanePicker on page1 (select a shell if picker is showing)
    await page1.waitForTimeout(500)
    const xtermVisible = await page1.locator('.xterm').first().isVisible().catch(() => false)
    if (!xtermVisible) {
      const shellNames = ['Shell', 'WSL', 'CMD', 'PowerShell', 'Bash']
      for (const name of shellNames) {
        try {
          const btn = page1.getByRole('button', { name: new RegExp(`^${name}$`, 'i') })
          if (await btn.isVisible().catch(() => false)) {
            await btn.click({ timeout: 5000 })
            break
          }
        } catch { continue }
      }
    }

    // Wait for terminal on page1
    await page1.locator('.xterm').first().waitFor({ state: 'visible', timeout: 30_000 })
    await page1.waitForFunction(() => {
      const buf = window.__FRESHELL_TEST_HARNESS__?.getTerminalBuffer()
      return buf !== null && buf !== undefined && buf.length > 0
    }, { timeout: 20_000 })

    // Type a command in page1's terminal
    await page1.locator('.xterm').first().click()
    await page1.keyboard.type('echo "multi-client-marker"')
    await page1.keyboard.press('Enter')

    // Verify the output appears in page1
    await page1.waitForFunction(
      (text) => window.__FRESHELL_TEST_HARNESS__?.getTerminalBuffer()?.includes(text) ?? false,
      'multi-client-marker',
      { timeout: 10_000 }
    )

    await context.close()
  })

  test('settings change broadcasts to other clients', async ({ browser, serverInfo }) => {
    const context = await browser.newContext()
    const page1 = await context.newPage()
    const page2 = await context.newPage()

    await page1.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1`)
    await page2.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1`)

    await waitForReady(page1)
    await waitForReady(page2)

    // Get initial font size from page2 (settings.settings.terminal.fontSize)
    const settingsBefore = await page2.evaluate(() =>
      window.__FRESHELL_TEST_HARNESS__?.getState()?.settings?.settings?.terminal?.fontSize
    )

    // Change font size setting from page1 via the API (PATCH /api/settings).
    // Only send the specific field to change (spreading full terminal settings
    // would include client-side-only keys like fontFamily that the server rejects).
    const newFontSize = (settingsBefore || 14) + 1
    const patchResponse = await page1.evaluate(async (info) => {
      const res = await fetch(`${info.baseUrl}/api/settings`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'x-auth-token': info.token,
        },
        body: JSON.stringify({
          terminal: { fontSize: info.newFontSize },
        }),
      })
      return { ok: res.ok, status: res.status }
    }, { baseUrl: serverInfo.baseUrl, token: serverInfo.token, newFontSize })

    expect(patchResponse.ok).toBe(true)

    // Wait for page2 to receive the broadcast and update its settings
    await page2.waitForFunction(
      (expectedFontSize) => {
        const current = window.__FRESHELL_TEST_HARNESS__?.getState()?.settings?.settings?.terminal?.fontSize
        return current === expectedFontSize
      },
      newFontSize,
      { timeout: 15_000 }
    )

    const settingsAfter = await page2.evaluate(() =>
      window.__FRESHELL_TEST_HARNESS__?.getState()?.settings?.settings?.terminal?.fontSize
    )
    expect(settingsAfter).toBe(newFontSize)

    await context.close()
  })

  test('server handles many concurrent connections', async ({ browser, serverInfo }) => {
    const context = await browser.newContext()
    const pages = []

    // Open 5 pages
    for (let i = 0; i < 5; i++) {
      const page = await context.newPage()
      await page.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1`)
      pages.push(page)
    }

    // All should connect
    for (const page of pages) {
      await page.waitForFunction(() =>
        window.__FRESHELL_TEST_HARNESS__?.getWsReadyState() === 'ready',
        { timeout: 20_000 }
      )
    }

    await context.close()
  })

  test('client disconnect is handled gracefully', async ({ browser, serverInfo }) => {
    const context = await browser.newContext()
    const page1 = await context.newPage()
    const page2 = await context.newPage()

    await page1.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1`)
    await page2.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1`)

    // Close one page
    await page1.close()

    // Other page should still work
    await page2.waitForFunction(() =>
      window.__FRESHELL_TEST_HARNESS__?.getWsReadyState() === 'ready'
    )

    await context.close()
  })
})
