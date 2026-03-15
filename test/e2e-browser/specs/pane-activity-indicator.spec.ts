import { test, expect } from '../helpers/fixtures.js'

async function getActiveLeaf(harness: any) {
  const tabId = await harness.getActiveTabId()
  expect(tabId).toBeTruthy()
  const layout = await harness.getPaneLayout(tabId!)
  expect(layout?.type).toBe('leaf')
  return { tabId: tabId!, paneId: layout.id as string }
}

function activeTabIcon(page: any, tabId: string) {
  return page.locator(`[data-context="tab"][data-tab-id="${tabId}"]`).locator('svg').first()
}

function activePaneIcon(page: any) {
  return page.getByRole('banner', { name: /^Pane:/ }).locator('svg').first()
}

async function expectChromeBlue(page: any, tabId: string, expected: boolean) {
  const tabIcon = activeTabIcon(page, tabId)
  const paneIcon = activePaneIcon(page)
  if (expected) {
    await expect(tabIcon).toHaveClass(/text-blue-500/)
    await expect(paneIcon).toHaveClass(/text-blue-500/)
    return
  }

  await expect(tabIcon).not.toHaveClass(/text-blue-500/)
  await expect(paneIcon).not.toHaveClass(/text-blue-500/)
}

test.describe('Pane Activity Indicator', () => {
  test('browser panes transition from idle to blue loading and back', async ({ freshellPage, page, harness, terminal }) => {
    await terminal.waitForTerminal()
    const { tabId, paneId } = await getActiveLeaf(harness)

    await page.evaluate(({ tabId: currentTabId, paneId: currentPaneId }) => {
      window.__FRESHELL_TEST_HARNESS__?.dispatch({
        type: 'panes/updatePaneContent',
        payload: {
          tabId: currentTabId,
          paneId: currentPaneId,
          content: {
            kind: 'browser',
            browserInstanceId: 'browser-e2e',
            url: '',
            devToolsOpen: false,
          },
        },
      })
    }, { tabId, paneId })

    await expect(page.getByPlaceholder('Enter URL...')).toBeVisible()
    await expectChromeBlue(page, tabId, false)

    await page.evaluate((currentPaneId: string) => {
      window.__FRESHELL_TEST_HARNESS__?.dispatch({
        type: 'paneRuntimeActivity/setPaneRuntimeActivity',
        payload: {
          paneId: currentPaneId,
          source: 'browser',
          phase: 'loading',
        },
      })
    }, paneId)

    await expectChromeBlue(page, tabId, true)

    await page.evaluate((currentPaneId: string) => {
      window.__FRESHELL_TEST_HARNESS__?.dispatch({
        type: 'paneRuntimeActivity/clearPaneRuntimeActivity',
        payload: { paneId: currentPaneId },
      })
    }, paneId)

    await expectChromeBlue(page, tabId, false)
  })

  test('freshclaude panes transition from waiting to blue running and back to idle', async ({ freshellPage, page, harness, terminal }) => {
    await terminal.waitForTerminal()
    const { tabId, paneId } = await getActiveLeaf(harness)
    const sessionId = 'sdk-e2e-fresh'
    const cliSessionId = '22222222-2222-4222-8222-222222222222'

    await page.evaluate((currentPaneId: string) => {
      window.__FRESHELL_TEST_HARNESS__?.setAgentChatNetworkEffectsSuppressed(currentPaneId, true)
    }, paneId)

    await page.evaluate(({ currentTabId, currentPaneId, currentSessionId, currentCliSessionId }) => {
      const harness = window.__FRESHELL_TEST_HARNESS__
      harness?.dispatch({
        type: 'agentChat/sessionCreated',
        payload: {
          requestId: 'req-e2e-fresh',
          sessionId: currentSessionId,
        },
      })
      harness?.dispatch({
        type: 'agentChat/sessionInit',
        payload: {
          sessionId: currentSessionId,
          cliSessionId: currentCliSessionId,
        },
      })
      harness?.dispatch({
        type: 'agentChat/setSessionStatus',
        payload: {
          sessionId: currentSessionId,
          status: 'running',
        },
      })
      harness?.dispatch({
        type: 'agentChat/addPermissionRequest',
        payload: {
          sessionId: currentSessionId,
          requestId: 'perm-e2e',
          subtype: 'can_use_tool',
        },
      })
      harness?.dispatch({
        type: 'panes/updatePaneContent',
        payload: {
          tabId: currentTabId,
          paneId: currentPaneId,
          content: {
            kind: 'agent-chat',
            provider: 'freshclaude',
            createRequestId: 'req-e2e-fresh',
            sessionId: currentSessionId,
            resumeSessionId: currentCliSessionId,
            status: 'running',
          },
        },
      })
    }, {
      currentTabId: tabId,
      currentPaneId: paneId,
      currentSessionId: sessionId,
      currentCliSessionId: cliSessionId,
    })

    await expectChromeBlue(page, tabId, false)

    await page.evaluate((currentSessionId: string) => {
      const harness = window.__FRESHELL_TEST_HARNESS__
      harness?.dispatch({
        type: 'agentChat/removePermission',
        payload: {
          sessionId: currentSessionId,
          requestId: 'perm-e2e',
        },
      })
    }, sessionId)

    await expectChromeBlue(page, tabId, true)

    await page.evaluate((currentSessionId: string) => {
      window.__FRESHELL_TEST_HARNESS__?.dispatch({
        type: 'agentChat/setSessionStatus',
        payload: {
          sessionId: currentSessionId,
          status: 'idle',
        },
      })
    }, sessionId)

    await expectChromeBlue(page, tabId, false)
  })

  test('claude terminals transition from pending to blue working and back on completion', async ({ freshellPage, page, harness, terminal }) => {
    await terminal.waitForTerminal()
    const { tabId, paneId } = await getActiveLeaf(harness)
    const claudeSessionId = '11111111-1111-4111-8111-111111111111'

    await page.evaluate((currentPaneId: string) => {
      window.__FRESHELL_TEST_HARNESS__?.setTerminalNetworkEffectsSuppressed(currentPaneId, true)
    }, paneId)

    await page.evaluate(({ currentTabId, currentPaneId, currentSessionId }) => {
      const harness = window.__FRESHELL_TEST_HARNESS__
      harness?.dispatch({
        type: 'tabs/updateTab',
        payload: {
          id: currentTabId,
          updates: {
            mode: 'claude',
            terminalId: undefined,
            resumeSessionId: currentSessionId,
          },
        },
      })
      harness?.dispatch({
        type: 'panes/updatePaneContent',
        payload: {
          tabId: currentTabId,
          paneId: currentPaneId,
          content: {
            kind: 'terminal',
            createRequestId: 'req-e2e-claude',
            status: 'running',
            mode: 'claude',
            shell: 'system',
            resumeSessionId: currentSessionId,
          },
        },
      })
    }, {
      currentTabId: tabId,
      currentPaneId: paneId,
      currentSessionId: claudeSessionId,
    })

    await expectChromeBlue(page, tabId, false)

    await page.evaluate((currentPaneId: string) => {
      window.__FRESHELL_TEST_HARNESS__?.dispatch({
        type: 'paneRuntimeActivity/setPaneRuntimeActivity',
        payload: {
          paneId: currentPaneId,
          source: 'terminal',
          phase: 'pending',
        },
      })
    }, paneId)

    await expectChromeBlue(page, tabId, false)

    await page.evaluate((currentPaneId: string) => {
      window.__FRESHELL_TEST_HARNESS__?.dispatch({
        type: 'paneRuntimeActivity/setPaneRuntimeActivity',
        payload: {
          paneId: currentPaneId,
          source: 'terminal',
          phase: 'working',
        },
      })
    }, paneId)

    await expectChromeBlue(page, tabId, true)

    await page.evaluate((currentPaneId: string) => {
      window.__FRESHELL_TEST_HARNESS__?.dispatch({
        type: 'paneRuntimeActivity/clearPaneRuntimeActivity',
        payload: { paneId: currentPaneId },
      })
    }, paneId)

    await expectChromeBlue(page, tabId, false)
  })
})
