import fs from 'fs/promises'
import path from 'path'
import type { Page } from '@playwright/test'
import { test, expect } from '../helpers/fixtures.js'

// Helper: wait for a page to be connected and ready
async function waitForReady(page: Page): Promise<void> {
  await page.waitForFunction(() => !!window.__FRESHELL_TEST_HARNESS__, { timeout: 15_000 })
  await page.waitForFunction(() =>
    window.__FRESHELL_TEST_HARNESS__?.getWsReadyState() === 'ready',
    { timeout: 15_000 }
  )
}

async function ensureTerminalReady(page: Page): Promise<void> {
  await page.waitForTimeout(500)
  const xtermVisible = await page.locator('.xterm').first().isVisible().catch(() => false)
  if (!xtermVisible) {
    const shellNames = ['Shell', 'WSL', 'CMD', 'PowerShell', 'Bash']
    for (const name of shellNames) {
      try {
        const button = page.getByRole('button', { name: new RegExp(`^${name}$`, 'i') })
        if (await button.isVisible().catch(() => false)) {
          await button.click({ timeout: 5000 })
          break
        }
      } catch {
        continue
      }
    }
  }

  await page.locator('.xterm').first().waitFor({ state: 'visible', timeout: 30_000 })
  await page.waitForFunction(() => {
    const buf = window.__FRESHELL_TEST_HARNESS__?.getTerminalBuffer()
    return buf !== null && buf !== undefined && buf.length > 0
  }, { timeout: 20_000 })
}

async function executeCommand(page: Page, command: string): Promise<void> {
  await page.locator('.xterm').first().click()
  await page.keyboard.type(command)
  await page.keyboard.press('Enter')
}

async function waitForTerminalText(page: Page, text: string, terminalId?: string, timeout = 15_000): Promise<void> {
  await page.waitForFunction(
    ({ searchText, id }) => window.__FRESHELL_TEST_HARNESS__?.getTerminalBuffer(id)?.includes(searchText) ?? false,
    { searchText: text, id: terminalId },
    { timeout },
  )
}

async function getActiveTerminalId(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const state = window.__FRESHELL_TEST_HARNESS__?.getState()
    const activeTabId = state?.tabs?.activeTabId
    const layout = activeTabId ? state?.panes?.layouts?.[activeTabId] : null

    const readTerminalId = (node: any): string | null => {
      if (!node) return null
      if (node.type === 'leaf' && node.content?.kind === 'terminal') {
        return typeof node.content.terminalId === 'string' ? node.content.terminalId : null
      }
      if (node.type === 'split' && Array.isArray(node.children)) {
        for (const child of node.children) {
          const terminalId = readTerminalId(child)
          if (terminalId) return terminalId
        }
      }
      return null
    }

    return readTerminalId(layout)
  })
}

async function waitForTabWithTerminalId(page: Page, expectedTerminalId: string, timeout = 20_000): Promise<string> {
  await page.waitForFunction((terminalId) => {
    const state = window.__FRESHELL_TEST_HARNESS__?.getState()

    const readTerminalId = (node: any): string | null => {
      if (!node) return null
      if (node.type === 'leaf' && node.content?.kind === 'terminal') {
        return typeof node.content.terminalId === 'string' ? node.content.terminalId : null
      }
      if (node.type === 'split' && Array.isArray(node.children)) {
        for (const child of node.children) {
          const childTerminalId = readTerminalId(child)
          if (childTerminalId) return childTerminalId
        }
      }
      return null
    }

    const layouts = state?.panes?.layouts ?? {}
    return Object.entries(layouts).some(([, layout]) => readTerminalId(layout) === terminalId)
  }, expectedTerminalId, { timeout })

  const tabId = await page.evaluate((terminalId) => {
    const state = window.__FRESHELL_TEST_HARNESS__?.getState()
    const layouts = state?.panes?.layouts ?? {}

    const readTerminalId = (node: any): string | null => {
      if (!node) return null
      if (node.type === 'leaf' && node.content?.kind === 'terminal') {
        return typeof node.content.terminalId === 'string' ? node.content.terminalId : null
      }
      if (node.type === 'split' && Array.isArray(node.children)) {
        for (const child of node.children) {
          const childTerminalId = readTerminalId(child)
          if (childTerminalId) return childTerminalId
        }
      }
      return null
    }

    for (const [tabId, layout] of Object.entries(layouts)) {
      if (readTerminalId(layout) === terminalId) return tabId
    }
    return null
  }, expectedTerminalId)

  if (!tabId) {
    throw new Error(`Expected to find a tab containing terminal ${expectedTerminalId}`)
  }

  return tabId
}

async function readMarkedPtySize(page: Page, marker: string, terminalId?: string): Promise<string | null> {
  return page.evaluate(({ id, label }) => {
    const buffer = window.__FRESHELL_TEST_HARNESS__?.getTerminalBuffer(id) ?? ''
    const regex = new RegExp(`${label}:(\\d+\\s+\\d+)`, 'g')
    let match: RegExpExecArray | null = null
    let last: string | null = null
    while ((match = regex.exec(buffer)) !== null) {
      last = match[1] ?? null
    }
    return last
  }, { id: terminalId, label: marker })
}

async function waitForMarkedPtySize(page: Page, marker: string, terminalId?: string, timeout = 15_000): Promise<string> {
  await page.waitForFunction(({ id, label }) => {
    const buffer = window.__FRESHELL_TEST_HARNESS__?.getTerminalBuffer(id) ?? ''
    return new RegExp(`${label}:(\\d+\\s+\\d+)`).test(buffer)
  }, { id: terminalId, label: marker }, { timeout })

  const size = await readMarkedPtySize(page, marker, terminalId)
  if (!size) {
    throw new Error(`Expected to parse PTY size marker ${marker}`)
  }
  return size
}

async function flushPersistedLayout(page: Page, terminalId: string): Promise<void> {
  await page.evaluate(() => {
    window.__FRESHELL_TEST_HARNESS__?.dispatch({ type: 'persist/flushNow' })
  })
  await page.waitForFunction((id) => {
    const raw = window.localStorage.getItem('freshell.layout.v3')
    return typeof raw === 'string' && raw.includes(id)
  }, terminalId, { timeout: 10_000 })
}

async function activateTab(page: Page, tabId: string): Promise<void> {
  await page.evaluate((id) => {
    window.__FRESHELL_TEST_HARNESS__?.dispatch({ type: 'tabs/setActiveTab', payload: id })
  }, tabId)
  await page.waitForFunction((id) => window.__FRESHELL_TEST_HARNESS__?.getState()?.tabs?.activeTabId === id, tabId, { timeout: 10_000 })
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
    await ensureTerminalReady(page1)

    const terminalId = await getActiveTerminalId(page1)
    expect(terminalId).toBeTruthy()
    await flushPersistedLayout(page1, terminalId!)

    const page2 = await context.newPage()
    await page2.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1`)
    await waitForReady(page2)
    const sharedTabId = await waitForTabWithTerminalId(page2, terminalId!)
    await activateTab(page2, sharedTabId)

    await executeCommand(page1, 'echo "multi-client-marker"')

    await waitForTerminalText(page1, 'multi-client-marker', terminalId!)
    await waitForTerminalText(page2, 'multi-client-marker', terminalId!)

    await context.close()
  })

  test('reconnecting second viewer keeps page 1 PTY size stable and both pages keep shared output', async ({ browser, serverInfo }) => {
    const context = await browser.newContext()
    const page1 = await context.newPage()
    await page1.setViewportSize({ width: 1500, height: 980 })

    await page1.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1`)
    await waitForReady(page1)
    await ensureTerminalReady(page1)

    const terminalId = await getActiveTerminalId(page1)
    expect(terminalId).toBeTruthy()
    await flushPersistedLayout(page1, terminalId!)

    const page2 = await context.newPage()
    await page2.setViewportSize({ width: 920, height: 640 })
    await page2.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1`)
    await waitForReady(page2)
    const sharedTabId = await waitForTabWithTerminalId(page2, terminalId!)
    await activateTab(page2, sharedTabId)

    await executeCommand(page1, 'echo "__MULTI_CLIENT_READY__"')
    await waitForTerminalText(page1, '__MULTI_CLIENT_READY__', terminalId!)
    await waitForTerminalText(page2, '__MULTI_CLIENT_READY__', terminalId!)

    await executeCommand(page1, 'printf "__PTY_SIZE_BEFORE__:%s\\n" "$(stty size)"')
    const beforeSize = await waitForMarkedPtySize(page1, '__PTY_SIZE_BEFORE__', terminalId!)

    await page2.evaluate(() => {
      window.__FRESHELL_TEST_HARNESS__?.clearSentWsMessages?.()
      window.__FRESHELL_TEST_HARNESS__?.forceDisconnect()
    })

    await waitForReady(page2)
    await waitForTerminalText(page2, '__MULTI_CLIENT_READY__', terminalId!)

    await page2.waitForFunction((id) => {
      const sent = window.__FRESHELL_TEST_HARNESS__?.getSentWsMessages?.() ?? []
      return sent.filter((msg: any) =>
        msg?.type === 'terminal.attach'
        && msg?.terminalId === id
        && msg?.intent === 'transport_reconnect'
      ).length === 1
    }, terminalId!, { timeout: 20_000 })

    const reconnectAttachMessages = await page2.evaluate((id) => {
      const sent = window.__FRESHELL_TEST_HARNESS__?.getSentWsMessages?.() ?? []
      return sent.filter((msg: any) =>
        msg?.type === 'terminal.attach'
        && msg?.terminalId === id
        && msg?.intent === 'transport_reconnect'
      )
    }, terminalId!)
    expect(reconnectAttachMessages).toHaveLength(1)

    await executeCommand(page1, 'printf "__PTY_SIZE_AFTER__:%s\\n" "$(stty size)"')
    const afterSize = await waitForMarkedPtySize(page1, '__PTY_SIZE_AFTER__', terminalId!)
    expect(afterSize).toBe(beforeSize)

    await executeCommand(page1, 'echo "__AFTER_PAGE2_RECONNECT__"')
    await waitForTerminalText(page1, '__AFTER_PAGE2_RECONNECT__', terminalId!)
    await waitForTerminalText(page2, '__AFTER_PAGE2_RECONNECT__', terminalId!)

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
