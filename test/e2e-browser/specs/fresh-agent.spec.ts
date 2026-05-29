import { test, expect } from '../helpers/fixtures.js'

async function enableClaudeAndCodex(page: any) {
  await page.evaluate(() => {
    const harness = window.__FRESHELL_TEST_HARNESS__
    harness?.dispatch({
      type: 'connection/setAvailableClis',
      payload: { claude: true, codex: true },
    })
    const patchPayload = {
      codingCli: {
        enabledProviders: ['claude', 'codex'],
      },
      freshAgent: {
        enabled: true,
      },
      agentChat: {
        enabled: true,
      },
    }
    harness?.dispatch({
      type: 'settings/previewServerSettingsPatch',
      payload: patchPayload,
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
  test('pane picker hides fresh clients by default even when their CLIs are enabled', async ({ freshellPage, page, terminal }) => {
    await terminal.waitForTerminal()
    await page.evaluate(() => {
      const harness = window.__FRESHELL_TEST_HARNESS__
      harness?.dispatch({
        type: 'connection/setAvailableClis',
        payload: { claude: true, codex: true, opencode: true },
      })
      harness?.dispatch({
        type: 'settings/previewServerSettingsPatch',
        payload: {
          codingCli: {
            enabledProviders: ['claude', 'codex', 'opencode'],
          },
        },
      })
    })

    await openPanePicker(page)
    await expect(page.getByRole('button', { name: /^Freshclaude$/i })).toHaveCount(0)
    await expect(page.getByRole('button', { name: /^Freshcodex$/i })).toHaveCount(0)
    await expect(page.getByRole('button', { name: /^Freshopencode$/i })).toHaveCount(0)
    await expect(page.getByRole('button', { name: /^Kilroy$/i })).toHaveCount(0)
  })

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
    const sessionId = '33333333-3333-4333-8333-333333333333'

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
          status: 'running',
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
            inputTokens: 10,
            outputTokens: 20,
            totalTokens: 30,
            costUsd: 0,
          },
          pendingApprovals: [{
            requestId: 'perm-e2e',
            toolName: 'Bash',
            input: { command: 'echo hello-from-fresh-agent' },
          }],
          pendingQuestions: [{
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
          }],
          turns: [],
          extensions: {
            claude: {
              liveSessionId: sessionId,
              cliSessionId: '33333333-3333-4333-8333-333333333333',
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
            createRequestId: 'req-e2e-permission',
            sessionId: currentSessionId,
            sessionRef: { provider: 'claude', sessionId: currentSessionId },
            resumeSessionId: currentSessionId,
            status: 'idle',
            settingsDismissed: true,
          },
        },
      })
    }, {
      currentTabId: tabId,
      currentPaneId: paneId,
      currentSessionId: sessionId,
    })

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
        permission: sent.find((msg: any) => msg?.type === 'freshAgent.approval.respond') ?? null,
        question: sent.find((msg: any) => msg?.type === 'freshAgent.question.respond') ?? null,
      }
    }).toMatchObject({
      permission: {
        type: 'freshAgent.approval.respond',
        sessionId,
        sessionType: 'freshclaude',
        provider: 'claude',
        requestId: 'perm-e2e',
        decision: {
          behavior: 'allow',
        },
      },
      question: {
        type: 'freshAgent.question.respond',
        sessionId,
        sessionType: 'freshclaude',
        provider: 'claude',
        requestId: 'question-e2e',
        answers: { 'How should Claude proceed?': 'Continue' },
      },
    })
  })

  test('browser user can create and resume Freshcodex with worktree, review, and fork metadata in the shared pane', async ({ freshellPage, page, harness, terminal, serverInfo }) => {
    await terminal.waitForTerminal()
    await enableClaudeAndCodex(page)

    await page.route(`${serverInfo.baseUrl}/api/fresh-agent/threads/freshcodex/codex/thread-codex*`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          sessionType: 'freshcodex',
          provider: 'codex',
          threadId: 'thread-codex',
          revision: 7,
          status: 'idle',
          summary: 'Freshcodex session',
          capabilities: { send: false, interrupt: false, approvals: false, questions: false, fork: false },
          tokenUsage: { totalTokens: 42, inputTokens: 10, outputTokens: 32 },
          worktrees: [{ id: 'wt-1', path: '/tmp/worktree', branch: 'feature/fresh-agent' }],
          diffs: [{ id: 'diff-1', title: 'README.md' }],
          childThreads: [{ id: 'child-1', threadId: 'child-thread', origin: 'codex', title: 'Subagent' }],
          extensions: {
            codex: {
              review: { id: 'review-1', status: 'pending' },
              fork: { parentThreadId: 'thread-parent-1' },
            },
          },
          turns: [{
            id: 'turn-1',
            turnId: 'turn-1',
            role: 'assistant',
            summary: 'Codex transcript',
            items: [{ id: 'item-1', kind: 'text', text: 'Codex transcript' }],
          }],
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
    await expect(page.getByRole('group', { name: /pane: freshcodex/i }).last()).toBeVisible()

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
            sessionRef: { provider: 'codex', sessionId: 'thread-codex' },
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
    await expect(page.getByText(/feature\/fresh-agent/)).toBeVisible()
    await expect(page.getByText('README.md')).toBeVisible()
    await expect(page.getByText('review-1')).toBeVisible()
    await expect(page.getByText('pending')).toBeVisible()
    await expect(page.getByText('thread-parent-1')).toBeVisible()

    await page.evaluate(() => {
      window.__FRESHELL_TEST_HARNESS__?.dispatch({ type: 'persist/flushNow' })
    })
    await page.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1`)
    await harness.waitForHarness()
    await harness.waitForConnection()
    await expect(page.getByText('Freshcodex session')).toBeVisible()
    await expect(page.getByText(/feature\/fresh-agent/)).toBeVisible()
  })
})
