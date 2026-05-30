import { test, expect } from '../helpers/fixtures.js'

test.describe('Fresh Agent Mobile', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('mobile tab switcher and sidebar stay usable with a restored fresh-agent pane', async ({ freshellPage, page, harness, terminal }) => {
    await terminal.waitForTerminal()
    const tabId = await harness.getActiveTabId()
    const layout = await harness.getPaneLayout(tabId!)
    expect(layout?.type).toBe('leaf')
    const paneId = layout.id as string

    await page.evaluate((currentPaneId: string) => {
      window.__FRESHELL_TEST_HARNESS__?.setAgentChatNetworkEffectsSuppressed(currentPaneId, true)
    }, paneId)

    const sessionId = '55555555-5555-4555-8555-555555555555'

    await page.route(`**/api/fresh-agent/threads/freshclaude/claude/${sessionId}*`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          sessionType: 'freshclaude',
          provider: 'claude',
          threadId: sessionId,
          sessionId,
          revision: 1,
          latestTurnId: null,
          status: 'idle',
          capabilities: {
            send: true,
            interrupt: true,
            approvals: true,
            questions: true,
            fork: false,
          },
          settings: {
            model: 'claude-opus-4-6',
            permissionMode: 'default',
            plugins: [],
          },
          tokenUsage: {
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            costUsd: 0,
          },
          pendingApprovals: [],
          pendingQuestions: [],
          turns: [],
          extensions: {
            claude: {
              liveSessionId: sessionId,
              cliSessionId: sessionId,
            },
          },
        }),
      })
    })

    await page.evaluate(({ currentTabId, currentPaneId, currentSessionId }) => {
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
            sessionId: currentSessionId,
            sessionRef: { provider: 'claude', sessionId: currentSessionId },
            resumeSessionId: currentSessionId,
            status: 'idle',
            settingsDismissed: true,
          },
        },
      })
    }, { currentTabId: tabId, currentPaneId: paneId, currentSessionId: sessionId })

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
