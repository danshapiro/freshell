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
      window.__FRESHELL_TEST_HARNESS__?.setFreshAgentNetworkEffectsSuppressed(currentPaneId, true)
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

  test('status strip collapses below 520px: short chip label, hidden context word, shrunken meter, 13px turn-header floor', async ({ freshellPage, page, harness, terminal }) => {
    await terminal.waitForTerminal()
    const tabId = await harness.getActiveTabId()
    expect(tabId).toBeTruthy()
    const layout = await harness.getPaneLayout(tabId!)
    expect(layout?.type).toBe('leaf')
    const paneId = layout.id as string

    const sessionId = '63333000-0000-4333-8333-000000000006'
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
          latestTurnId: 'turn-mobile-strip-assistant',
          status: 'idle',
          summary: '',
          capabilities: { send: true, interrupt: true, approvals: true, questions: true, fork: false },
          settings: { model: 'opus[1m]', effort: 'high', permissionMode: 'default', plugins: [] },
          tokenUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: 0 },
          pendingApprovals: [],
          pendingQuestions: [],
          turns: [
            {
              id: 'turn-mobile-strip-user',
              turnId: 'turn-mobile-strip-user',
              role: 'user',
              summary: 'Check the collapsed strip.',
              items: [{ id: 'item-mobile-strip-user', kind: 'text', text: 'Check the collapsed strip.' }],
            },
            {
              id: 'turn-mobile-strip-assistant',
              turnId: 'turn-mobile-strip-assistant',
              role: 'assistant',
              summary: 'Mobile strip transcript line.',
              items: [{ id: 'item-mobile-strip-assistant', kind: 'text', text: 'Mobile strip transcript line.' }],
            },
          ],
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
      const harnessRef = window.__FRESHELL_TEST_HARNESS__
      harnessRef?.setFreshAgentNetworkEffectsSuppressed(currentPaneId, true)
      harnessRef?.dispatch({
        type: 'panes/updatePaneContent',
        payload: {
          tabId: currentTabId,
          paneId: currentPaneId,
          content: {
            kind: 'fresh-agent',
            sessionType: 'freshclaude',
            provider: 'claude',
            createRequestId: `req-mobile-strip-${currentSessionId}`,
            sessionId: currentSessionId,
            sessionRef: { provider: 'claude', sessionId: currentSessionId },
            resumeSessionId: currentSessionId,
            status: 'idle',
            initialCwd: '/home/user/code/freshell',
            model: 'opus[1m]',
            effort: 'high',
            settingsDismissed: true,
          },
        },
      })
    }, { currentTabId: tabId!, currentPaneId: paneId, currentSessionId: sessionId })

    const paneRoot = page.locator('[data-context="fresh-agent"]')
    await expect(paneRoot).toBeVisible({ timeout: 10_000 })

    // Seed the session indexer tokenUsage the strip meter reads (47%,
    // 96,000/200,000 tokens) — matched via the pane's durable session id.
    // Boot-time sidebar session-window commits copy the server's (empty here)
    // index over state.sessions.projects, so re-seed until the meter sticks.
    const meter = paneRoot.getByRole('meter', { name: 'Context window used' })
    await expect.poll(async () => {
      await page.evaluate((currentSessionId) => {
        window.__FRESHELL_TEST_HARNESS__?.dispatch({
          type: 'sessions/applyContextUsageExtras',
          payload: {
            entries: [{
              provider: 'claude',
              sessionId: currentSessionId,
              tokenUsage: {
                inputTokens: 1,
                outputTokens: 1,
                cachedTokens: 0,
                totalTokens: 2,
                contextTokens: 96000,
                compactThresholdTokens: 200000,
                compactPercent: 47,
              },
            }],
            sourceSeq: Date.now(),
            serverInstance: '__e2e_seed__',
            paneKeys: [`claude:${currentSessionId}`],
          },
        })
      }, sessionId)
      return meter.isVisible().catch(() => false)
    }, { timeout: 15_000, intervals: [250, 500, 1000] }).toBe(true)
    await expect(meter).toBeVisible()
    await expect(meter).toHaveAttribute('aria-valuenow', '47')

    // The model chip shortens at ≤520px while the explicitly seeded effort remains visible.
    await expect(paneRoot.getByText('Claude Opus 5 high', { exact: true })).toBeVisible()
    await expect(paneRoot.getByText('Claude Opus 5 (1M context) high', { exact: true })).toBeHidden()

    // The word "context" drops from the strip (rendered label span is
    // display:none), and the combined 'context —' lug is excluded by seeding.
    const contextWord = paneRoot.getByText('context', { exact: true })
    await expect(contextWord).toHaveCount(1) // rendered but display:none — see plan Task 6 note
    await expect(contextWord).toBeHidden()
    await expect(paneRoot.getByText('context —', { exact: true })).toHaveCount(0)

    // Meter-collapse proof (relative, no fixed-pixel assertion): measure the
    // role=meter cluster here, then widen the pane past 520px and re-measure.
    const mobileClusterBox = await meter.boundingBox()
    expect(mobileClusterBox).not.toBeNull()

    // 13px phone floor for the turn-header (read from the live DOM — no
    // element handles across render epochs).
    await expect(paneRoot.getByText('You', { exact: true })).toBeVisible()
    const turnHeaderFontSize = await page.evaluate(() => {
      const root = document.querySelector('[data-context="fresh-agent"]')
      if (!root) return null
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT)
      const normalize = (text: string | null | undefined): string =>
        (text ?? '').replace(/\s+/g, ' ').trim()
      let node = walker.nextNode() as Element | null
      while (node) {
        if (normalize(node.textContent) === 'You') {
          const header = node.closest('.fresh-agent-turn-header') as HTMLElement | null
          return header ? parseFloat(getComputedStyle(header).fontSize) : null
        }
        node = walker.nextNode() as Element | null
      }
      return null
    })
    expect(turnHeaderFontSize).not.toBeNull()
    expect(turnHeaderFontSize!).toBeGreaterThanOrEqual(13)

    await page.setViewportSize({ width: 1280, height: 800 })
    await expect(paneRoot.getByText('Claude Opus 5 (1M context) high', { exact: true })).toBeVisible({ timeout: 10_000 })
    const desktopClusterBox = await meter.boundingBox()
    expect(desktopClusterBox).not.toBeNull()
    console.log(`[status-strip] mobile cluster width: ${mobileClusterBox!.width}px; desktop cluster width: ${desktopClusterBox!.width}px`)
    expect(mobileClusterBox!.width).toBeLessThan(desktopClusterBox!.width * 0.75)
  })
})
