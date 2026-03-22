import { test, expect } from '../helpers/fixtures.js'

async function selectShellForActiveTab(page: any): Promise<void> {
  const shellNames = ['Shell', 'WSL', 'CMD', 'PowerShell', 'Bash']
  for (const name of shellNames) {
    const button = page.locator(`button[aria-label="${name}"]`).first()
    if (await button.isVisible().catch(() => false)) {
      await button.click({ timeout: 5000 })
      await page.locator('.xterm').last().waitFor({ state: 'visible', timeout: 30_000 })
      return
    }
  }
  throw new Error('No shell option available for the active tab')
}

function getTerminalId(layout: any): string | null {
  if (!layout) return null
  if (layout.type === 'leaf' && layout.content?.kind === 'terminal') {
    return typeof layout.content.terminalId === 'string' ? layout.content.terminalId : null
  }
  if (layout.type === 'split' && Array.isArray(layout.children)) {
    for (const child of layout.children) {
      const terminalId = getTerminalId(child)
      if (terminalId) return terminalId
    }
  }
  return null
}

function getLeafPaneId(layout: any): string | null {
  if (!layout) return null
  if (layout.type === 'leaf') {
    return typeof layout.id === 'string' ? layout.id : null
  }
  if (layout.type === 'split' && Array.isArray(layout.children)) {
    for (const child of layout.children) {
      const paneId = getLeafPaneId(child)
      if (paneId) return paneId
    }
  }
  return null
}

test.describe('Tab title source precedence', () => {
  test('keeps a hidden session title after a later generic OSC runtime title', async ({
    freshellPage,
    page,
    harness,
    terminal,
  }) => {
    const durableTitle = 'codex resume 019d1213-9c59-7bb0-80ae-70c74427f346'
    const sentinel = 'background-title-runtime-sentinel'

    await terminal.waitForTerminal()
    await terminal.waitForPrompt()

    await page.locator('[data-context="tab-add"]').click()
    await harness.waitForTabCount(2)
    await selectShellForActiveTab(page)

    const secondTabId = await harness.getActiveTabId()
    expect(secondTabId).toBeTruthy()

    const secondLayout = await harness.getPaneLayout(secondTabId!)
    const secondTerminalId = getTerminalId(secondLayout)
    expect(secondTerminalId).toBeTruthy()

    await terminal.waitForPrompt({ timeout: 30_000, terminalId: secondTerminalId! })

    const tabs = page.locator('[data-context="tab"]')
    const secondTab = tabs.nth(1)

    await harness.syncStableTitleByTerminalId(secondTerminalId!, durableTitle)

    await expect(secondTab).toContainText(durableTitle)

    await tabs.first().click()
    await expect(secondTab).toContainText(durableTitle)

    await page.evaluate(({ terminalId, backgroundSentinel }) => {
      window.__FRESHELL_TEST_HARNESS__?.sendWsMessage({
        type: 'terminal.input',
        terminalId,
        data: `printf '\\033]0;codex\\007'; printf '${backgroundSentinel}\\n'\n`,
      })
    }, { terminalId: secondTerminalId, backgroundSentinel: sentinel })

    await expect(secondTab).toContainText(durableTitle)

    await secondTab.click()
    await terminal.waitForOutput(sentinel, { terminalId: secondTerminalId! })
    await expect(secondTab).toContainText(durableTitle)
  })

  test('shows runtime-only terminal titles live, drops them after reload, and restores them after re-emission', async ({
    freshellPage,
    page,
    harness,
    terminal,
  }) => {
    const runtimeTitle = 'vim README.md'
    const firstSentinel = 'runtime-title-before-reload'
    const secondSentinel = 'runtime-title-after-reload'
    const activeTab = page.locator('[data-context="tab"]').first()
    const paneHeader = page.locator('[data-pane-id] [role="banner"]').first()

    await terminal.waitForTerminal()
    await terminal.waitForPrompt()

    const tabId = await harness.getActiveTabId()
    expect(tabId).toBeTruthy()

    const layout = await harness.getPaneLayout(tabId!)
    const terminalId = getTerminalId(layout)
    const paneId = getLeafPaneId(layout)
    expect(terminalId).toBeTruthy()
    expect(paneId).toBeTruthy()

    const initialState = await harness.getState()
    const initialTab = initialState.tabs.tabs.find((tab: any) => tab.id === tabId)
    const initialDurableTabTitle = initialTab?.title
    const initialDurablePaneTitle = initialState.panes.paneTitles?.[tabId!]?.[paneId!]
    const initialVisibleTabTitle = (await activeTab.textContent())?.trim()
    expect(initialDurableTabTitle).toBeTruthy()
    expect(initialDurablePaneTitle).toBeTruthy()
    expect(initialVisibleTabTitle).toBeTruthy()

    await page.evaluate(({ currentTerminalId, nextTitle, sentinel }) => {
      window.__FRESHELL_TEST_HARNESS__?.sendWsMessage({
        type: 'terminal.input',
        terminalId: currentTerminalId,
        data: `printf '\\033]0;${nextTitle}\\007'; printf '${sentinel}\\n'\n`,
      })
    }, { currentTerminalId: terminalId, nextTitle: runtimeTitle, sentinel: firstSentinel })

    await terminal.waitForOutput(firstSentinel, { terminalId: terminalId! })
    await expect(activeTab).toContainText(runtimeTitle)
    await expect(paneHeader).toContainText(runtimeTitle)

    await harness.setTerminalNetworkEffectsSuppressed(paneId!, true)
    await page.reload()
    await harness.waitForHarness()
    await harness.waitForConnection()
    await harness.waitForTabCount(1)

    const reloadedTabId = await harness.getActiveTabId()
    expect(reloadedTabId).toBeTruthy()

    const reloadedLayout = await harness.getPaneLayout(reloadedTabId!)
    const reloadedPaneId = getLeafPaneId(reloadedLayout)
    expect(reloadedPaneId).toBeTruthy()

    const reloadedState = await harness.getState()
    const reloadedTab = reloadedState.tabs.tabs.find((tab: any) => tab.id === reloadedTabId)
    const reloadedDurableTabTitle = reloadedTab?.title
    const reloadedDurablePaneTitle = reloadedState.panes.paneTitles?.[reloadedTabId!]?.[reloadedPaneId!]
    expect(reloadedDurableTabTitle).toBeTruthy()
    expect(reloadedDurablePaneTitle).toBeTruthy()
    expect(reloadedState.paneRuntimeTitle?.titlesByPaneId?.[reloadedPaneId!]).toBeUndefined()

    const reloadedActiveTab = page.locator('[data-context="tab"]').first()
    const reloadedPaneHeader = page.locator('[data-pane-id] [role="banner"]').first()
    await expect(reloadedActiveTab).toContainText(initialVisibleTabTitle!)
    await expect(reloadedActiveTab).not.toContainText(runtimeTitle)
    await expect(reloadedPaneHeader).toContainText(reloadedDurablePaneTitle)
    await expect(reloadedPaneHeader).not.toContainText(runtimeTitle)

    await harness.setTerminalNetworkEffectsSuppressed(reloadedPaneId!, false)
    await page.reload()
    await harness.waitForHarness()
    await harness.waitForConnection()
    await harness.waitForTabCount(1)

    const reattachedTabId = await harness.getActiveTabId()
    expect(reattachedTabId).toBeTruthy()

    const reattachedLayout = await harness.getPaneLayout(reattachedTabId!)
    const reattachedTerminalId = getTerminalId(reattachedLayout)
    expect(reattachedTerminalId).toBeTruthy()

    await terminal.waitForPrompt({ timeout: 30_000, terminalId: reattachedTerminalId! })
    await page.evaluate(({ currentTerminalId, nextTitle, sentinel }) => {
      window.__FRESHELL_TEST_HARNESS__?.sendWsMessage({
        type: 'terminal.input',
        terminalId: currentTerminalId,
        data: `printf '\\033]0;${nextTitle}\\007'; printf '${sentinel}\\n'\n`,
      })
    }, { currentTerminalId: reattachedTerminalId, nextTitle: runtimeTitle, sentinel: secondSentinel })

    await terminal.waitForOutput(secondSentinel, { terminalId: reattachedTerminalId! })
    await expect(reloadedActiveTab).toContainText(runtimeTitle)
    await expect(reloadedPaneHeader).toContainText(runtimeTitle)
  })
})
