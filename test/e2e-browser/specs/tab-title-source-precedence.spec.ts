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
})
