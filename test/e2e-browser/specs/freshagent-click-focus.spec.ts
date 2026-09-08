import { test, expect } from '../helpers/fixtures.js'

test.describe('Fresh Agent click-to-defocus', () => {
  test('clicking the transcript moves focus off the composer so scroll keys work, and real pane re-activation refocuses the composer', async ({ freshellPage: _freshellPage, page, harness, terminal }) => {
    await terminal.waitForTerminal()
    const tabId = await harness.getActiveTabId()
    expect(tabId).toBeTruthy()
    const layout = await harness.getPaneLayout(tabId!)
    expect(layout?.type).toBe('leaf')
    const terminalPaneId = layout.id as string
    const freshPaneId = 'pane-c1fa-e2e'

    const sessionId = '63333000-0000-4333-8333-00000000c1fa'

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
          latestTurnId: 'turn-c1fa-agent',
          status: 'idle',
          summary: '',
          capabilities: { send: true, interrupt: true, approvals: true, questions: true, fork: false },
          settings: { model: 'opus[1m]', permissionMode: 'default', plugins: [] },
          tokenUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: 0 },
          pendingApprovals: [],
          pendingQuestions: [],
          turns: [
            {
              id: 'turn-c1fa-user',
              turnId: 'turn-c1fa-user',
              role: 'user',
              summary: 'Scroll me',
              items: [{ id: 'item-c1fa-user', kind: 'text', text: 'Scroll me.' }],
            },
            {
              id: 'turn-c1fa-agent',
              turnId: 'turn-c1fa-agent',
              role: 'assistant',
              summary: 'A tall transcript body',
              items: [{
                id: 'item-c1fa-agent',
                kind: 'text',
                text: 'A tall transcript body.\n\n' + Array.from({ length: 80 }, (_, i) => `Line ${i + 1}: the quick brown fox jumps over the lazy dog.`).join('\n\n'),
              }],
            },
          ],
          extensions: { claude: { liveSessionId: sessionId, cliSessionId: sessionId } },
        }),
      })
    })

    // Split the terminal pane: the original stays a terminal (a real second pane
    // to click away to), the new pane is the fresh-agent. This lets the
    // reactivation proof exercise a genuine click-to-activate path instead of a
    // direct Redux dispatch.
    await page.evaluate(({ currentTabId, currentTerminalPaneId, currentFreshPaneId, currentSessionId }) => {
      window.__FRESHELL_TEST_HARNESS__?.setFreshAgentNetworkEffectsSuppressed(currentFreshPaneId, true)
      window.__FRESHELL_TEST_HARNESS__?.dispatch({
        type: 'panes/splitPane',
        payload: {
          tabId: currentTabId,
          paneId: currentTerminalPaneId,
          direction: 'horizontal',
          newPaneId: currentFreshPaneId,
          newContent: {
            kind: 'fresh-agent',
            sessionType: 'freshclaude',
            provider: 'claude',
            createRequestId: 'req-c1fa-e2e',
            sessionId: currentSessionId,
            sessionRef: { provider: 'claude', sessionId: currentSessionId },
            resumeSessionId: currentSessionId,
            status: 'idle',
            settingsDismissed: true,
          },
        },
      })
    }, { currentTabId: tabId, currentTerminalPaneId: terminalPaneId, currentFreshPaneId: freshPaneId, currentSessionId: sessionId })

    const freshPane = page.locator(`[data-context="fresh-agent"][data-pane-id="${freshPaneId}"]`)
    await expect(freshPane).toBeVisible({ timeout: 10_000 })
    const scroller = freshPane.locator('[data-context="fresh-agent-transcript"]')
    await expect(scroller).toBeVisible({ timeout: 10_000 })
    const input = freshPane.getByRole('textbox', { name: 'Chat message input' })
    await expect(input).toBeEnabled({ timeout: 10_000 })

    // On activation the new fresh-agent pane's composer holds focus.
    await expect.poll(async () => page.evaluate(() => {
      const el = document.activeElement
      return el ? el.getAttribute('aria-label') : null
    }), { timeout: 10_000 }).toBe('Chat message input')

    // Click the transcript body (not the composer). The browser moves focus
    // onto the now-focusable transcript scroller (tabindex="-1").
    await scroller.click()
    await expect.poll(async () => page.evaluate(() => {
      const el = document.activeElement
      return el ? el.getAttribute('data-context') : null
    }), { timeout: 5_000 }).toBe('fresh-agent-transcript')

    // With focus on the transcript, the existing nav-key handler now receives a
    // non-interactive target. The transcript loads at the BOTTOM (atBottom=true;
    // a layout effect pins scrollTop=scrollHeight on signature change), so first
    // jump to the TOP with Home, then prove PageDown scrolls DOWN from there.
    await page.keyboard.press('Home')
    await expect.poll(async () => scroller.evaluate((el: HTMLElement) => el.scrollTop), { timeout: 5_000 }).toBe(0)

    const before = await scroller.evaluate((el: HTMLElement) => el.scrollTop)
    await page.keyboard.press('PageDown')
    await expect.poll(async () => scroller.evaluate((el: HTMLElement) => el.scrollTop), { timeout: 5_000 }).toBeGreaterThan(before)

    // End jumps back to the bottom. Browsers clamp scrollTop to scrollHeight -
    // clientHeight (the repo uses this exact formula in resume-button.spec.ts),
    // so assert against the real maximum, not scrollHeight itself.
    await page.keyboard.press('End')
    const maxScroll = await scroller.evaluate((el: HTMLElement) => el.scrollHeight - el.clientHeight)
    await expect.poll(async () => scroller.evaluate((el: HTMLElement) => el.scrollTop), { timeout: 5_000 }).toBe(maxScroll)

    // Real pane re-activation: click the sibling terminal pane's xterm (the
    // repo's standard click-to-focus-a-terminal pattern, e.g.
    // page.locator('.xterm').first().click() in silent-input-loss-rust.spec.ts),
    // which focuses the terminal and deactivates + defocuses the fresh-agent
    // composer. Then click back into the fresh-agent transcript: the mousedown
    // dispatches setActivePane -> isActivePane flips true -> the activation
    // effect refocuses the composer, overriding the transcript's click-focus.
    // This is the genuine user-facing path the request requires, not a direct
    // Redux dispatch.
    const terminalPane = page.locator(`[data-context="pane"][data-pane-id="${terminalPaneId}"]`)
    await terminalPane.locator('.xterm').click()
    await expect.poll(async () => page.evaluate(() => {
      const el = document.activeElement
      return el ? el.getAttribute('aria-label') : null
    }), { timeout: 5_000 }).not.toBe('Chat message input')

    await scroller.click()
    await expect.poll(async () => page.evaluate(() => {
      const el = document.activeElement
      return el ? el.getAttribute('aria-label') : null
    }), { timeout: 10_000 }).toBe('Chat message input')
  })
})
