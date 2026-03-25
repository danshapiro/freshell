import fs from 'fs/promises'
import path from 'path'
import { test, expect } from '../helpers/fixtures.js'

function buildBrokenWorkspacePayloads() {
  const workspaceRaw = JSON.stringify({
    version: 1,
    tabs: {
      activeTabId: 'broken-remote-tab',
      tabs: [{
        id: 'broken-remote-tab',
        title: 'Broken Remote Tab',
        createRequestId: 'req-broken-remote',
        status: 'creating',
        mode: 'codex',
        shell: 'system',
        resumeSessionId: 'remote-broken-session',
        createdAt: 1,
      }],
    },
    panes: {
      layouts: {},
      activePane: {},
      paneTitles: {},
      paneTitleSetByUser: {},
    },
  })
  const tabsRaw = JSON.stringify({
    version: 1,
    tabs: {
      activeTabId: 'broken-remote-tab',
      tabs: [{
        id: 'broken-remote-tab',
        title: 'Broken Remote Tab',
        createRequestId: 'req-broken-remote',
        status: 'creating',
        mode: 'codex',
        shell: 'system',
        resumeSessionId: 'remote-broken-session',
        createdAt: 1,
      }],
    },
  })
  const panesRaw = JSON.stringify({
    version: 6,
    layouts: {},
    activePane: {},
    paneTitles: {},
    paneTitleSetByUser: {},
  })

  return { workspaceRaw, tabsRaw, panesRaw }
}

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

    const sharedDefaultCwd = path.join(serverInfo.homeDir, 'multi-client-default-cwd')
    await fs.mkdir(sharedDefaultCwd, { recursive: true })

    // Get initial default cwd from page2 before changing it server-side.
    const settingsBefore = await page2.evaluate(() =>
      window.__FRESHELL_TEST_HARNESS__?.getState()?.settings?.settings?.defaultCwd
    )

    // Change a server-backed field from page1 via the API.
    const patchResponse = await page1.evaluate(async (info) => {
      const res = await fetch(`${info.baseUrl}/api/settings`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'x-auth-token': info.token,
        },
        body: JSON.stringify({
          defaultCwd: info.defaultCwd,
        }),
      })
      return { ok: res.ok, status: res.status }
    }, { baseUrl: serverInfo.baseUrl, token: serverInfo.token, defaultCwd: sharedDefaultCwd })

    expect(patchResponse.ok).toBe(true)

    // Wait for page2 to receive the broadcast and update its settings
    await page2.waitForFunction(
      (expectedDefaultCwd) => {
        const current = window.__FRESHELL_TEST_HARNESS__?.getState()?.settings?.settings?.defaultCwd
        return current === expectedDefaultCwd
      },
      sharedDefaultCwd,
      { timeout: 15_000 }
    )

    const settingsAfter = await page2.evaluate(() =>
      window.__FRESHELL_TEST_HARNESS__?.getState()?.settings?.settings?.defaultCwd
    )
    expect(settingsAfter).toBe(sharedDefaultCwd)
    expect(settingsAfter).not.toBe(settingsBefore)

    await context.close()
  })

  test('authoritative workspace sync surfaces missing-layout corruption in another client', async ({ browser, serverInfo }) => {
    const context = await browser.newContext()
    const page1 = await context.newPage()
    const page2 = await context.newPage()

    await page1.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1`)
    await page2.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1`)

    await waitForReady(page1)
    await waitForReady(page2)

    await page2.evaluate(() => {
      window.__FRESHELL_TEST_HARNESS__?.clearSentWsMessages?.()
    })

    const payloads = buildBrokenWorkspacePayloads()
    await page1.evaluate((seed) => {
      window.localStorage.setItem('freshell.workspace.v1', seed.workspaceRaw)
      window.localStorage.setItem('freshell.tabs.v2', seed.tabsRaw)
      window.localStorage.setItem('freshell.panes.v2', seed.panesRaw)
    }, payloads)

    await page2.waitForFunction(() => (
      window.__FRESHELL_TEST_HARNESS__?.getState()?.tabs?.tabs?.some((tab: any) => tab?.id === 'broken-remote-tab')
    ), { timeout: 15_000 })

    await expect(
      page2.locator('[data-context="tab"]').filter({ hasText: 'Broken Remote Tab' })
    ).toBeVisible()
    await expect(page2.getByTestId('missing-layout-error')).toBeVisible()

    const createMessages = await page2.evaluate(() => (
      window.__FRESHELL_TEST_HARNESS__?.getSentWsMessages?.() ?? []
    ))
    expect((createMessages as any[]).filter((msg) => msg?.type === 'terminal.create')).toHaveLength(0)

    await context.close()
  })

  test('authoritative workspace sync drops an existing layout in another client when the snapshot removes it', async ({ browser, serverInfo }) => {
    const context = await browser.newContext()
    const page1 = await context.newPage()
    const page2 = await context.newPage()

    await page1.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1`)
    await page2.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1`)

    await waitForReady(page1)
    await waitForReady(page2)

    const existingTab = await page2.evaluate(() => {
      const state = window.__FRESHELL_TEST_HARNESS__?.getState()
      const activeTabId = state?.tabs?.activeTabId
      const tab = state?.tabs?.tabs?.find((entry: any) => entry?.id === activeTabId)
      const hasLayout = !!(activeTabId && state?.panes?.layouts?.[activeTabId])
      return {
        activeTabId,
        tab,
        title: tab?.title ?? null,
        hasLayout,
      }
    })

    expect(existingTab.activeTabId).toBeTruthy()
    expect(existingTab.title).toBeTruthy()
    expect(existingTab.hasLayout).toBe(true)

    await page2.evaluate(() => {
      window.__FRESHELL_TEST_HARNESS__?.clearSentWsMessages?.()
    })

    const brokenWorkspaceRaw = await page1.evaluate((target) => {
      const activeTabId = target.activeTabId
      const activeTab = target.tab
      if (!activeTabId || !activeTab) {
        throw new Error('Expected an active tab with a layout before corrupting the workspace snapshot')
      }

      const brokenWorkspaceRaw = JSON.stringify({
        version: 1,
        tabs: {
          activeTabId,
          tabs: [activeTab],
        },
        panes: {
          layouts: {},
          activePane: {},
          paneTitles: {},
          paneTitleSetByUser: {},
        },
      })
      const brokenTabsRaw = JSON.stringify({
        version: 1,
        tabs: {
          activeTabId,
          tabs: [activeTab],
        },
      })
      const brokenPanesRaw = JSON.stringify({
        version: 6,
        layouts: {},
        activePane: {},
        paneTitles: {},
        paneTitleSetByUser: {},
      })

      window.localStorage.setItem('freshell.workspace.v1', brokenWorkspaceRaw)
      window.localStorage.setItem('freshell.tabs.v2', brokenTabsRaw)
      window.localStorage.setItem('freshell.panes.v2', brokenPanesRaw)
      return brokenWorkspaceRaw
    }, { activeTabId: existingTab.activeTabId, tab: existingTab.tab })

    await page2.evaluate((raw) => {
      window.dispatchEvent(new StorageEvent('storage', {
        key: 'freshell.workspace.v1',
        newValue: raw,
      }))
    }, brokenWorkspaceRaw)

    await page2.waitForFunction((tabId) => {
      const state = window.__FRESHELL_TEST_HARNESS__?.getState()
      return !state?.panes?.layouts?.[tabId as string]
    }, existingTab.activeTabId, { timeout: 15_000 })

    await expect(
      page2.locator('[data-context="tab"]').filter({ hasText: existingTab.title as string })
    ).toBeVisible()
    await expect(page2.getByTestId('missing-layout-error')).toBeVisible()

    const createMessages = await page2.evaluate(() => (
      window.__FRESHELL_TEST_HARNESS__?.getSentWsMessages?.() ?? []
    ))
    expect((createMessages as any[]).filter((msg) => msg?.type === 'terminal.create')).toHaveLength(0)

    await context.close()
  })

  test('a hidden corrupted tab only surfaces the missing-layout error when reselected in another client', async ({ browser, serverInfo }) => {
    const context = await browser.newContext()
    const page1 = await context.newPage()
    const page2 = await context.newPage()

    await page1.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1`)
    await page2.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1`)

    await waitForReady(page1)
    await waitForReady(page2)

    const tabState = await page2.evaluate(() => {
      const harness = window.__FRESHELL_TEST_HARNESS__
      const state = harness?.getState()
      const originalTabId = state?.tabs?.activeTabId
      const originalTab = state?.tabs?.tabs?.find((tab: any) => tab?.id === originalTabId)
      const originalLayout = originalTabId ? state?.panes?.layouts?.[originalTabId] : null
      if (!originalTabId || !originalTab || !originalLayout) {
        throw new Error('Expected an existing active pane-backed tab before creating the hidden-tab scenario')
      }

      harness?.dispatch({
        type: 'workspace/createPaneBackedTab',
        payload: {
          tab: {
            id: 'healthy-secondary-tab',
            title: 'Healthy Secondary Tab',
            createRequestId: 'req-healthy-secondary',
            status: 'running',
            mode: 'shell',
            shell: 'system',
            createdAt: 2,
          },
          content: {
            kind: 'browser',
            url: 'https://example.com/healthy-secondary',
            devToolsOpen: false,
            browserInstanceId: 'browser-healthy-secondary',
          },
        },
      })

      const nextState = harness?.getState()
      const secondaryTab = nextState?.tabs?.tabs?.find((tab: any) => tab?.id === 'healthy-secondary-tab')
      const secondaryLayout = nextState?.panes?.layouts?.['healthy-secondary-tab']
      if (!secondaryTab || !secondaryLayout) {
        throw new Error('Expected the healthy secondary tab to exist with a layout')
      }

      return {
        originalTabId,
        originalTab,
        originalTitle: originalTab.title,
        originalLayout,
        secondaryTab,
        secondaryLayout,
      }
    })

    await expect(
      page2.locator('[data-context="tab"]').filter({ hasText: 'Healthy Secondary Tab' })
    ).toBeVisible()

    await page2.evaluate(() => {
      window.__FRESHELL_TEST_HARNESS__?.clearSentWsMessages?.()
    })

    const brokenWorkspaceRaw = await page1.evaluate((stateForBreak) => {
      const brokenWorkspaceRaw = JSON.stringify({
        version: 1,
        tabs: {
          activeTabId: stateForBreak.secondaryTab.id,
          tabs: [stateForBreak.originalTab, stateForBreak.secondaryTab],
        },
        panes: {
          layouts: {
            [stateForBreak.secondaryTab.id]: stateForBreak.secondaryLayout,
          },
          activePane: {
            [stateForBreak.secondaryTab.id]: stateForBreak.secondaryLayout.id,
          },
          paneTitles: {},
          paneTitleSetByUser: {},
        },
      })
      const brokenTabsRaw = JSON.stringify({
        version: 1,
        tabs: {
          activeTabId: stateForBreak.secondaryTab.id,
          tabs: [stateForBreak.originalTab, stateForBreak.secondaryTab],
        },
      })
      const brokenPanesRaw = JSON.stringify({
        version: 6,
        layouts: {
          [stateForBreak.secondaryTab.id]: stateForBreak.secondaryLayout,
        },
        activePane: {
          [stateForBreak.secondaryTab.id]: stateForBreak.secondaryLayout.id,
        },
        paneTitles: {},
        paneTitleSetByUser: {},
      })

      window.localStorage.setItem('freshell.workspace.v1', brokenWorkspaceRaw)
      window.localStorage.setItem('freshell.tabs.v2', brokenTabsRaw)
      window.localStorage.setItem('freshell.panes.v2', brokenPanesRaw)
      return brokenWorkspaceRaw
    }, tabState)

    await page2.evaluate((raw) => {
      window.dispatchEvent(new StorageEvent('storage', {
        key: 'freshell.workspace.v1',
        newValue: raw,
      }))
    }, brokenWorkspaceRaw)

    await page2.waitForFunction((tabId) => {
      const state = window.__FRESHELL_TEST_HARNESS__?.getState()
      return (
        state?.tabs?.activeTabId === 'healthy-secondary-tab'
        && !state?.panes?.layouts?.[tabId as string]
        && !!state?.panes?.layouts?.['healthy-secondary-tab']
      )
    }, tabState.originalTabId, { timeout: 15_000 })

    await expect(page2.getByTestId('missing-layout-error')).not.toBeVisible()

    await page2
      .locator('[data-context="tab"]')
      .filter({ hasText: tabState.originalTitle as string })
      .click()

    await expect(page2.getByTestId('missing-layout-error')).toBeVisible()

    const createMessages = await page2.evaluate(() => (
      window.__FRESHELL_TEST_HARNESS__?.getSentWsMessages?.() ?? []
    ))
    expect((createMessages as any[]).filter((msg) => msg?.type === 'terminal.create')).toHaveLength(0)

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
