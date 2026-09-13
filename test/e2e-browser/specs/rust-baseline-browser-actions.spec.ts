import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { test, expect } from '../helpers/fixtures.js'

const FORBIDDEN = [
  '/api/proxy/forward',
  '/api/fresh-agent/attachments',
  '/api/fresh-agent/exec',
  '/api/fresh-agent/diff',
  '/api/files/open',
  '/api/extensions/',
]

function captureForbiddenRequests(page: Page) {
  const requests: string[] = []
  page.on('request', (request) => {
    const url = request.url()
    if (FORBIDDEN.some((route) => url.includes(route))) requests.push(url)
  })
  return requests
}

async function createPane(page: Page, label: RegExp) {
  await page.locator('.xterm').first().click({ button: 'right' })
  await page.getByRole('menuitem', { name: /split horizontally/i }).click()
  const option = page.getByRole('button', { name: label }).last()
  await expect(option).toBeVisible({ timeout: 10_000 })
  await option.click()
}

async function createBrowserPane(page: Page) {
  await createPane(page, /^Browser$/i)
  return page.getByPlaceholder('Enter URL...').last()
}

async function createEditorPane(page: Page) {
  await createPane(page, /^Editor$/i)
  const editor = page.locator('[data-testid="editor-pane"]').last()
  await expect(editor).toBeVisible({ timeout: 15_000 })
  return editor
}

async function installExtensionRegistry(page: Page) {
  await page.route('**/api/extensions', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify([
        { name: 'fake-client-extension', label: 'Fake client extension', category: 'client' },
        { name: 'fake-server-extension', label: 'Fake server extension', category: 'server' },
      ]),
    })
  })
  await page.reload()
  await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 15_000 })
}

async function installExtensionPane(page: Page, extensionName: string) {
  await page.evaluate((name) => {
    const harness = window.__FRESHELL_TEST_HARNESS__
    const state = harness?.getState()
    const tabId = state?.tabs?.activeTabId as string | undefined
    const paneId = tabId ? state?.panes?.activePane?.[tabId] as string | undefined : undefined
    if (!tabId || !paneId || !harness) throw new Error('No active pane for extension fixture')
    harness.dispatch({
      type: 'panes/splitPane',
      payload: {
        tabId,
        paneId,
        direction: 'horizontal',
        newContent: { kind: 'extension', extensionName: name },
      },
    })
  }, extensionName)
}

async function installFakeProviderPane(page: Page) {
  await page.route('**/api/fresh-agent/threads/freshclaude/claude/**', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        sessionType: 'freshclaude', provider: 'claude',
        threadId: '11111111-1111-4111-8111-111111111111',
        sessionId: '11111111-1111-4111-8111-111111111111',
        revision: 1, latestTurnId: null, status: 'idle', summary: '',
        capabilities: { send: true, interrupt: true, approvals: true, questions: true, fork: false, diffs: true },
        tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
        pendingApprovals: [], pendingQuestions: [], worktrees: [], childThreads: [], turns: [],
        diffs: [{ id: 'fake-diff', path: 'README.md', status: 'modified' }], extensions: {},
      }),
    })
  })
  await page.evaluate(() => {
    const harness = window.__FRESHELL_TEST_HARNESS__
    const state = harness?.getState()
    const tabId = state?.tabs?.activeTabId as string | undefined
    const paneId = tabId ? state?.panes?.activePane?.[tabId] as string | undefined : undefined
    if (!tabId || !paneId || !harness) throw new Error('No active pane for fake provider fixture')
    const sessionId = '11111111-1111-4111-8111-111111111111'
    harness.setFreshAgentNetworkEffectsSuppressed(paneId, true)
    harness.dispatch({
      type: 'panes/updatePaneContent',
      payload: { tabId, paneId, content: {
        kind: 'fresh-agent', sessionType: 'freshclaude', provider: 'claude',
        createRequestId: 'fake-provider-request', sessionId,
        sessionRef: { provider: 'claude', sessionId }, resumeSessionId: sessionId,
        status: 'idle', initialCwd: '/tmp/fake-provider', model: 'fake-model', settingsDismissed: true,
      } },
    })
  })
  await expect(page.locator('[data-context="fresh-agent"]').last()).toBeVisible({ timeout: 10_000 })
}

test.describe('Rust baseline browser actions', () => {
  test('keeps localhost HTTP proxying and blocks remote HTTPS loopback without forwarding', async ({ freshellPage, page, serverInfo, terminal }) => {
    const forbidden = captureForbiddenRequests(page)
    await terminal.waitForTerminal()
    const input = await createBrowserPane(page)
    await input.fill('http://localhost:4321/health')
    await input.press('Enter')
    await expect(page.locator('iframe[title="Browser content"]')).toHaveAttribute('src', '/api/proxy/http/4321/health')

    // Chromium resolves any *.localhost name to loopback, while BrowserPane
    // correctly treats the browser host itself as remote (not "localhost").
    await page.goto(`${serverInfo.baseUrl.replace('127.0.0.1', 'freshell-baseline.localhost')}/?token=${serverInfo.token}&e2e=1`)
    const shell = page.getByRole('button', { name: /^Shell$/i })
    await expect(shell).toBeVisible({ timeout: 15_000 })
    await shell.click()
    await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 15_000 })
    const remoteInput = await createBrowserPane(page)
    await remoteInput.fill('https://localhost:4321/health')
    await remoteInput.press('Enter')
    await expect(page.getByText('Remote loopback forwarding is unavailable; use a localhost HTTP URL or open the URL on the server host.', { exact: true })).toBeVisible()
    await expect(page.locator('iframe[title="Browser content"]')).toHaveCount(0)
    expect(forbidden).toEqual([])
  })

  test('does not expose Node-only external editor actions and keeps save available', async ({ freshellPage, page, serverInfo, terminal }) => {
    const forbidden = captureForbiddenRequests(page)
    await terminal.waitForTerminal()
    const filePath = path.join(serverInfo.homeDir, 'editor-context.md')
    await writeFile(filePath, '# Context menu\n')
    const editor = await createEditorPane(page)
    const pathInput = editor.getByPlaceholder('Enter file path...')
    await pathInput.fill(filePath)
    await pathInput.press('Enter')
    await editor.getByRole('button', { name: 'Source' }).click()
    await expect(editor.locator('.monaco-editor')).toBeVisible({ timeout: 15_000 })
    await editor.click({ button: 'right' })
    await expect(page.getByRole('menuitem', { name: /open in external editor|reveal in file explorer/i })).toHaveCount(0)
    await expect(page.getByRole('menuitem', { name: /^save now$/i })).toBeVisible()
    expect(forbidden).toEqual([])
  })

  test('renders client and server extension panes as accessible unsupported baseline panels', async ({ freshellPage, page, terminal }) => {
    const forbidden = captureForbiddenRequests(page)
    await terminal.waitForTerminal()
    await installExtensionRegistry(page)
    await installExtensionPane(page, 'fake-client-extension')
    await expect(page.getByRole('status', { name: 'Unsupported extension pane' })).toHaveText(/Fake client extension.*This extension pane is unavailable with the Rust server baseline\./)
    await installExtensionPane(page, 'fake-server-extension')
    await expect(page.getByRole('status', { name: 'Unsupported extension pane' }).last()).toHaveText(/Fake server extension.*This extension pane is unavailable with the Rust server baseline\./)
    expect(forbidden).toEqual([])
  })

  test('reads, edits, saves, and previews markdown through Rust editor routes', async ({ freshellPage, page, serverInfo, terminal }) => {
    const forbidden = captureForbiddenRequests(page)
    await terminal.waitForTerminal()
    const filePath = path.join(serverInfo.homeDir, 'round-trip.md')
    const edited = '# Rust editor round trip\n\nSaved from the browser.\n'
    await writeFile(filePath, '# Initial\n')
    const editor = await createEditorPane(page)
    const pathInput = editor.getByPlaceholder('Enter file path...')
    await pathInput.fill(filePath)
    await pathInput.press('Enter')
    await editor.getByRole('button', { name: 'Source' }).click()
    const paneId = await editor.getAttribute('data-pane-id')
    const tabId = await editor.getAttribute('data-tab-id')
    expect(paneId).toBeTruthy()
    expect(tabId).toBeTruthy()
    await page.evaluate(({ tabId: currentTabId, paneId: currentPaneId, filePath: currentFilePath, content }) => {
      window.__FRESHELL_TEST_HARNESS__?.dispatch({
        type: 'panes/updatePaneContent',
        payload: {
          tabId: currentTabId,
          paneId: currentPaneId,
          content: {
            kind: 'editor', filePath: currentFilePath, language: 'markdown',
            content, readOnly: false, viewMode: 'source', wordWrap: true,
          },
        },
      })
    }, { tabId, paneId, filePath, content: edited })
    await expect(editor.getByText('Rust editor round trip')).toBeVisible()
    await editor.click({ button: 'right' })
    await page.getByRole('menuitem', { name: /^save now$/i }).click()
    await expect.poll(() => readFile(filePath, 'utf8')).toBe(edited)
    await editor.getByRole('button', { name: 'Preview' }).click()
    await expect(editor.getByRole('heading', { name: 'Rust editor round trip' })).toBeVisible()
    await expect(editor.getByText('Saved from the browser.')).toBeVisible()
    expect(forbidden).toEqual([])
  })

  test('removes fresh-agent attachment, shell, and expandable-diff actions', async ({ freshellPage, page, terminal }) => {
    const forbidden = captureForbiddenRequests(page)
    await terminal.waitForTerminal()
    await installFakeProviderPane(page)
    const pane = page.locator('[data-context="fresh-agent"]').last()
    await expect(pane.getByLabel(/attach|attachment|upload/i)).toHaveCount(0)
    await pane.getByRole('textbox', { name: 'Chat message input' }).fill('!echo blocked')
    await pane.getByRole('button', { name: 'Send' }).click()
    await expect(pane.getByRole('status')).toHaveText('Shell commands are unavailable here; open a shell pane instead')
    const diff = pane.locator('.fresh-agent-file-diff')
    await expect(diff).toContainText('README.md')
    await expect(diff).toContainText('Full diff loading is unavailable.')
    await expect(diff.getByRole('button')).toHaveCount(0)
    expect(forbidden).toEqual([])
  })
})
