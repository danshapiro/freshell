import { test, expect } from '../helpers/fixtures.js'

async function enableClaudeAndCodex(page: any) {
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
}

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
    await enableClaudeAndCodex(page)

    await openPanePicker(page)
    await expect(page.getByRole('button', { name: /^Freshclaude$/i })).toBeVisible()
    await expect(page.getByRole('button', { name: /^Freshcodex$/i })).toBeVisible()
  })

  test('freshclaude banners render through the fresh-agent pane surface and answer over WS', async ({ freshellPage, page, harness, terminal }) => {
    await terminal.waitForTerminal()
    const { tabId, paneId } = await getActiveLeaf(harness)
    const sessionId = 'sdk-e2e-freshclaude'
    const cliSessionId = '33333333-3333-4333-8333-333333333333'

    await page.evaluate((currentPaneId: string) => {
      window.__FRESHELL_TEST_HARNESS__?.setAgentChatNetworkEffectsSuppressed(currentPaneId, true)
    }, paneId)

    await page.evaluate(({ currentTabId, currentPaneId, currentSessionId, currentCliSessionId }) => {
      window.__FRESHELL_TEST_HARNESS__?.dispatch({
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
            status: 'idle',
            settingsDismissed: true,
          },
        },
      })
    }, {
      currentTabId: tabId,
      currentPaneId: paneId,
      currentSessionId: sessionId,
      currentCliSessionId: cliSessionId,
    })
    await page.evaluate(({ currentSessionId, currentCliSessionId }) => {
      const harness = window.__FRESHELL_TEST_HARNESS__
      harness?.dispatch({
        type: 'agentChat/sessionCreated',
        payload: { requestId: 'req-e2e-permission', sessionId: currentSessionId },
      })
      harness?.dispatch({
        type: 'agentChat/sessionInit',
        payload: {
          sessionId: currentSessionId,
          cliSessionId: currentCliSessionId,
          model: 'claude-opus-4-6',
          cwd: '/workspace',
        },
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
        type: 'agentChat/addQuestionRequest',
        payload: {
          sessionId: currentSessionId,
          requestId: 'question-e2e',
          questions: [{
            header: 'Approve plan',
            question: 'How should Claude proceed?',
            options: [
              { label: 'Continue', description: 'Keep going' },
              { label: 'Stop', description: 'Pause the task' },
            ],
            multiSelect: false,
          }],
        },
      })
      harness?.dispatch({
        type: 'agentChat/timelinePageReceived',
        payload: {
          sessionId: currentSessionId,
          timelineSessionId: '33333333-3333-4333-8333-333333333333',
          items: [],
          nextCursor: null,
          revision: 1,
        },
      })
    }, { currentSessionId: sessionId, currentCliSessionId: cliSessionId })

    const permissionBanner = page.getByRole('alert', { name: /permission request for bash/i })
    await expect(permissionBanner).toBeVisible()
    await expect(permissionBanner).toContainText('echo hello-from-fresh-agent')
    const questionBanner = page.getByRole('region', { name: /question from claude/i })
    await expect(questionBanner).toBeVisible()
    await expect(questionBanner).toContainText('How should Claude proceed?')

    await harness.clearSentWsMessages()
    await permissionBanner.getByRole('button', { name: /allow tool use/i }).click()
    await questionBanner.getByRole('button', { name: 'Continue' }).click()

    await expect.poll(async () => {
      const sent = await harness.getSentWsMessages()
      return {
        permission: sent.find((msg: any) => msg?.type === 'sdk.permission.respond') ?? null,
        question: sent.find((msg: any) => msg?.type === 'sdk.question.respond') ?? null,
      }
    }).toMatchObject({
      permission: {
        type: 'sdk.permission.respond',
        sessionId,
        requestId: 'perm-e2e',
        behavior: 'allow',
      },
      question: {
        type: 'sdk.question.respond',
        sessionId,
        requestId: 'question-e2e',
        answers: { 'How should Claude proceed?': 'Continue' },
      },
    })
  })

  test('browser user can create and resume Freshcodex with worktree and fork metadata in the shared pane', async ({ freshellPage, page, harness, terminal, serverInfo }) => {
    await terminal.waitForTerminal()
    await enableClaudeAndCodex(page)

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

    await openPanePicker(page)
    const tabId = await harness.getActiveTabId()
    const activePaneId = await page.evaluate((currentTabId: string) => {
      const state = window.__FRESHELL_TEST_HARNESS__?.getState()
      return state?.panes?.activePane?.[currentTabId] ?? null
    }, tabId!)
    expect(activePaneId).toBeTruthy()
    await page.evaluate((currentPaneId: string) => {
      window.__FRESHELL_TEST_HARNESS__?.setAgentChatNetworkEffectsSuppressed(currentPaneId, true)
    }, activePaneId)
    await page.getByRole('button', { name: /^Freshcodex$/i }).click()
    await page.getByRole('option').first().click()
    await expect(page.getByText('Starting session')).toBeVisible()

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
            createRequestId: 'req-codex-browser',
            sessionId: 'thread-codex',
            resumeSessionId: 'thread-codex',
            status: 'connected',
          },
        },
      })
    }, {
      currentTabId: tabId,
      currentPaneId: activePaneId,
    })

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
