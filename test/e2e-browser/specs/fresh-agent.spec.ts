import { test, expect } from '../helpers/fixtures.js'

async function openPanePicker(page: any) {
  const termContainer = page.locator('.xterm').first()
  await termContainer.click({ button: 'right' })
  await page.getByRole('menuitem', { name: /split horizontally/i }).click()
  await expect(page.getByRole('toolbar', { name: /pane type picker/i })).toBeVisible({ timeout: 10_000 })
}

async function getActiveLeaf(harness: any) {
  const tabId = await harness.getActiveTabId()
  expect(tabId).toBeTruthy()
  const layout = await harness.getPaneLayout(tabId!)
  expect(layout?.type).toBe('leaf')
  return { tabId: tabId!, paneId: layout.id as string }
}

test.describe('Fresh Agent', () => {
  test('pane picker shows Freshclaude and Freshcodex when their CLIs are enabled', async ({ freshellPage, page, terminal }) => {
    await terminal.waitForTerminal()
    await page.evaluate(() => {
      const harness = window.__FRESHELL_TEST_HARNESS__
      harness?.dispatch({
        type: 'connection/setAvailableClis',
        payload: { claude: true, codex: true },
      })
      harness?.dispatch({
        type: 'settings/updateSettingsLocal',
        payload: {
          codingCli: {
            enabledProviders: ['claude', 'codex'],
          },
        },
      })
    })

    await openPanePicker(page)
    await expect(page.getByRole('button', { name: /^Freshclaude$/i })).toBeVisible()
    await expect(page.getByRole('button', { name: /^Freshcodex$/i })).toBeVisible()
  })

  test('freshclaude permission banners render from a fresh-agent pane and send the response over WS', async ({ freshellPage, page, harness, terminal }) => {
    await terminal.waitForTerminal()
    const { tabId, paneId } = await getActiveLeaf(harness)
    const sessionId = 'sdk-e2e-freshclaude'
    const cliSessionId = '33333333-3333-4333-8333-333333333333'

    await page.evaluate((currentPaneId: string) => {
      window.__FRESHELL_TEST_HARNESS__?.setAgentChatNetworkEffectsSuppressed(currentPaneId, true)
    }, paneId)

    await page.evaluate(({ currentTabId, currentPaneId, currentSessionId, currentCliSessionId }) => {
      const harness = window.__FRESHELL_TEST_HARNESS__
      harness?.dispatch({
        type: 'agentChat/sessionCreated',
        payload: { requestId: 'req-e2e-permission', sessionId: currentSessionId },
      })
      harness?.dispatch({
        type: 'agentChat/sessionInit',
        payload: { sessionId: currentSessionId, cliSessionId: currentCliSessionId },
      })
      harness?.dispatch({
        type: 'agentChat/addPermissionRequest',
        payload: {
          sessionId: currentSessionId,
          requestId: 'perm-e2e',
          subtype: 'can_use_tool',
          tool: {
            name: 'Bash',
            input: { command: 'echo hello-from-fresh-agent' },
          },
        },
      })
      harness?.dispatch({
        type: 'panes/updatePaneContent',
        payload: {
          tabId: currentTabId,
          paneId: currentPaneId,
          content: {
            kind: 'fresh-agent',
            sessionType: 'freshclaude',
            provider: 'claude',
            createRequestId: 'req-e2e-permission',
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

    const banner = page.getByRole('alert', { name: /permission request for bash/i })
    await expect(banner).toBeVisible()
    await expect(banner).toContainText('echo hello-from-fresh-agent')

    await harness.clearSentWsMessages()
    await banner.getByRole('button', { name: /allow tool use/i }).click()

    await expect.poll(async () => {
      const sent = await harness.getSentWsMessages()
      return sent.find((msg: any) => msg?.type === 'sdk.permission.respond') ?? null
    }).toMatchObject({
      type: 'sdk.permission.respond',
      sessionId,
      requestId: 'perm-e2e',
      behavior: 'allow',
    })
  })

  test('freshcodex pane restores and shows worktree and fork metadata from the fresh-agent thread route', async ({ freshellPage, page, harness, terminal, serverInfo }) => {
    await terminal.waitForTerminal()
    const { tabId, paneId } = await getActiveLeaf(harness)

    await page.route(`${serverInfo.baseUrl}/api/fresh-agent/threads/codex/thread-codex*`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          provider: 'codex',
          threadId: 'thread-codex',
          revision: 7,
          status: 'idle',
          summary: 'Freshcodex session',
          capabilities: { send: true, interrupt: true, fork: true },
          tokenUsage: { totalTokens: 42, inputTokens: 10, outputTokens: 32 },
          worktrees: [{ id: 'wt-1', path: '/tmp/worktree', branch: 'feature/fresh-agent' }],
          diffs: [{ id: 'diff-1', title: 'README.md' }],
          childThreads: [{ id: 'child-1', threadId: 'child-thread', title: 'Subagent' }],
          turns: [{ id: 'turn-1', role: 'assistant', items: [{ id: 'item-1', kind: 'text', text: 'Codex transcript' }] }],
        }),
      })
    })

    await page.evaluate(({ currentTabId, currentPaneId }) => {
      window.__FRESHELL_TEST_HARNESS__?.dispatch({
        type: 'panes/updatePaneContent',
        payload: {
          tabId: currentTabId,
          paneId: currentPaneId,
          content: {
            kind: 'fresh-agent',
            sessionType: 'freshcodex',
            provider: 'codex',
            createRequestId: 'req-codex',
            sessionId: 'thread-codex',
            resumeSessionId: 'thread-codex',
            status: 'connected',
          },
        },
      })
    }, { currentTabId: tabId, currentPaneId: paneId })

    await expect(page.getByText('Freshcodex session')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Fork' })).toBeVisible()
    await expect(page.getByText(/feature\/fresh-agent/)).toBeVisible()
    await expect(page.getByText('README.md')).toBeVisible()

    await page.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1`)
    await harness.waitForHarness()
    await harness.waitForConnection()
    await expect(page.getByText('Freshcodex session')).toBeVisible()
    await expect(page.getByText(/feature\/fresh-agent/)).toBeVisible()
  })
})
