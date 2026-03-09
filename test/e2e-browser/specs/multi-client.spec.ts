import { test, expect } from '../helpers/fixtures.js'

test.describe('Multi-Client', () => {
  test('two browser tabs share the same server', async ({ browser, serverInfo }) => {
    // Open two pages to the same server
    const context = await browser.newContext()
    const page1 = await context.newPage()
    const page2 = await context.newPage()

    await page1.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1`)
    await page2.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1`)

    // Both should connect successfully
    await page1.waitForFunction(() => !!window.__FRESHELL_TEST_HARNESS__)
    await page2.waitForFunction(() => !!window.__FRESHELL_TEST_HARNESS__)

    await context.close()
  })

  test('terminal output appears in both clients', async ({ browser, serverInfo }) => {
    const context = await browser.newContext()
    const page1 = await context.newPage()
    const page2 = await context.newPage()

    await page1.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1`)
    await page2.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1`)

    // Wait for both to be ready and terminals to load
    await page1.waitForFunction(() =>
      window.__FRESHELL_TEST_HARNESS__?.getWsReadyState() === 'ready'
    )
    await page2.waitForFunction(() =>
      window.__FRESHELL_TEST_HARNESS__?.getWsReadyState() === 'ready'
    )

    // Wait for terminal on page1
    await page1.locator('.xterm').first().waitFor({ state: 'visible', timeout: 15_000 })
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

    await page1.waitForFunction(() =>
      window.__FRESHELL_TEST_HARNESS__?.getWsReadyState() === 'ready'
    )
    await page2.waitForFunction(() =>
      window.__FRESHELL_TEST_HARNESS__?.getWsReadyState() === 'ready'
    )

    // Get initial settings from page2
    const settingsBefore = await page2.evaluate(() =>
      window.__FRESHELL_TEST_HARNESS__?.getState()?.settings?.terminal?.fontSize
    )

    // Change font size setting from page1 via the API
    await page1.evaluate(async (info) => {
      const state = window.__FRESHELL_TEST_HARNESS__?.getState()
      const currentSettings = state?.settings || {}
      const newFontSize = (currentSettings.terminal?.fontSize || 14) + 1
      await fetch(`${info.baseUrl}/api/settings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-auth-token': info.token,
        },
        body: JSON.stringify({
          ...currentSettings,
          terminal: { ...currentSettings.terminal, fontSize: newFontSize },
        }),
      })
    }, { baseUrl: serverInfo.baseUrl, token: serverInfo.token })

    // Wait for page2 to receive the broadcast and update its settings
    await page2.waitForFunction(
      (before) => {
        const current = window.__FRESHELL_TEST_HARNESS__?.getState()?.settings?.terminal?.fontSize
        return current !== before && current !== undefined
      },
      settingsBefore,
      { timeout: 10_000 }
    )

    const settingsAfter = await page2.evaluate(() =>
      window.__FRESHELL_TEST_HARNESS__?.getState()?.settings?.terminal?.fontSize
    )
    expect(settingsAfter).not.toBe(settingsBefore)

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
