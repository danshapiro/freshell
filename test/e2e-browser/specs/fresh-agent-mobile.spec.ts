import { test, expect } from '../helpers/fixtures.js'

test.describe('Fresh Agent Mobile', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('mobile tab switcher and sidebar stay usable with a fresh-agent pane', async ({ freshellPage, page, harness, terminal }) => {
    await terminal.waitForTerminal()
    const tabId = await harness.getActiveTabId()
    const layout = await harness.getPaneLayout(tabId!)
    expect(layout?.type).toBe('leaf')
    const paneId = layout.id as string

    await page.evaluate(({ currentTabId, currentPaneId }) => {
      window.__FRESHELL_TEST_HARNESS__?.setAgentChatNetworkEffectsSuppressed(currentPaneId, true)
      window.__FRESHELL_TEST_HARNESS__?.dispatch({
        type: 'agentChat/sessionCreated',
        payload: { requestId: 'req-mobile', sessionId: 'sdk-mobile' },
      })
      window.__FRESHELL_TEST_HARNESS__?.dispatch({
        type: 'agentChat/sessionInit',
        payload: {
          sessionId: 'sdk-mobile',
          cliSessionId: '55555555-5555-4555-8555-555555555555',
        },
      })
      window.__FRESHELL_TEST_HARNESS__?.dispatch({
        type: 'panes/updatePaneContent',
        payload: {
          tabId: currentTabId,
          paneId: currentPaneId,
          content: {
            kind: 'fresh-agent',
            sessionType: 'freshclaude',
            provider: 'claude',
            createRequestId: 'req-mobile',
            sessionId: 'sdk-mobile',
            status: 'idle',
            settingsDismissed: true,
          },
        },
      })
    }, { currentTabId: tabId, currentPaneId: paneId })

    await expect(page.getByRole('textbox', { name: 'Chat message input' })).toBeVisible()

    await page.getByRole('button', { name: /open tab switcher/i }).click()
    await expect(page.getByRole('button', { name: /close tab switcher/i })).toBeVisible()
    await page.getByRole('button', { name: /close tab switcher/i }).click()

    const hideSidebar = page.getByRole('button', { name: /hide sidebar/i })
    if (await hideSidebar.isVisible().catch(() => false)) {
      await hideSidebar.click()
      await expect(page.getByRole('button', { name: /show sidebar/i })).toBeVisible()
      await page.getByRole('button', { name: /show sidebar/i }).click()
    }

    await expect(page.getByRole('textbox', { name: 'Chat message input' })).toBeVisible()
  })
})
