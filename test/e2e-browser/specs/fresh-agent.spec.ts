import { test, expect } from '../helpers/fixtures.js'
import { openPanePicker } from '../helpers/pane-picker.js'

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
    }
    harness?.dispatch({
      type: 'settings/previewServerSettingsPatch',
      payload: patchPayload,
    })
  })
}

async function getActiveLeaf(harness: any) {
  const tabId = await harness.getActiveTabId()
  expect(tabId).toBeTruthy()
  const layout = await harness.getPaneLayout(tabId!)
  expect(layout?.type).toBe('leaf')
  return { tabId: tabId!, paneId: layout.id as string }
}

async function suppressFreshAgentNetworkForActivePane(page: any) {
  await page.evaluate(() => {
    const harness = window.__FRESHELL_TEST_HARNESS__
    const state = harness?.getState()
    const tabId = state?.tabs?.activeTabId
    const paneId = tabId ? state?.panes?.activePane?.[tabId] : null
    if (paneId) {
      harness?.setFreshAgentNetworkEffectsSuppressed(paneId, true)
    }
  })
}

async function openFreshAgentSettings(page: any, providerName: string) {
  const pane = page.getByRole('group').filter({
    has: page.getByText(providerName, { exact: true }),
  }).last()
  await expect(pane).toBeVisible({ timeout: 10_000 })

  const dialog = pane.getByRole('dialog', { name: 'Agent settings' })
  if (!(await dialog.isVisible().catch(() => false))) {
    await pane.getByRole('button', { name: /^agent settings$/i }).click()
  }

  await expect(dialog).toBeVisible({ timeout: 10_000 })
  return dialog
}

async function expectFreshAgentSubmitButtonContrasted(
  root: any,
  expectedBackgroundVariable = '--fresh-agent-text',
) {
  const styles = await root.locator('.fresh-agent-composer-action[type="submit"]').evaluate((node: HTMLElement, backgroundVariable: string) => {
    const pane = node.closest('[data-context="fresh-agent"]') as HTMLElement | null
    if (!pane) {
      throw new Error('Fresh Agent pane root not found')
    }

    const resolveColor = (value: string) => {
      const probe = document.createElement('span')
      probe.style.color = value.trim()
      document.body.appendChild(probe)
      const color = getComputedStyle(probe).color
      probe.remove()
      return color
    }

    const buttonStyle = getComputedStyle(node)
    const paneStyle = getComputedStyle(pane)
    return {
      backgroundColor: buttonStyle.backgroundColor,
      color: buttonStyle.color,
      expectedBackgroundColor: resolveColor(paneStyle.getPropertyValue(backgroundVariable)),
      expectedColor: resolveColor(paneStyle.getPropertyValue('--fresh-agent-surface')),
      panelBackgroundColor: resolveColor(paneStyle.getPropertyValue('--fresh-agent-panel-surface')),
    }
  }, expectedBackgroundVariable)

  expect(styles.backgroundColor).toBe(styles.expectedBackgroundColor)
  expect(styles.color).toBe(styles.expectedColor)
  expect(styles.backgroundColor).not.toBe(styles.panelBackgroundColor)
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

  test('freshclaude settings use FreshAgent model defaults and create payload', async ({ freshellPage: _freshellPage, page, harness, terminal }) => {
    await terminal.waitForTerminal()
    await enableClaudeAndCodex(page)

    await harness.clearSentWsMessages()
    const picker = await openPanePicker(page)
    await suppressFreshAgentNetworkForActivePane(page)
    await picker.getByRole('button', { name: /^Freshclaude$/i }).click({ force: true })
    await page.getByRole('option').first().click()

    const dialog = await openFreshAgentSettings(page, 'Freshclaude')
    await expect(dialog.getByRole('radio', { name: 'Claude Opus 4.6' })).toBeChecked()

    const thinking = dialog.getByRole('combobox', { name: /^Thinking level$/i })
    const thinkingOptions = await thinking.locator('option').evaluateAll(
      (options) => options.map((option) => option.textContent),
    )
    expect(thinkingOptions).toEqual(['low', 'medium', 'high'])
    await expect(thinking).toHaveValue('high')

    await expect.poll(async () => {
      const sent = await harness.getSentWsMessages()
      return sent.find((message: any) => message?.type === 'freshAgent.create') ?? null
    }).toMatchObject({
      type: 'freshAgent.create',
      sessionType: 'freshclaude',
      provider: 'claude',
      model: 'claude-opus-4-6',
      effort: 'high',
    })
  })

  test('style setting persists per Fresh Agent pane type and applies serif rendering', async ({ freshellPage: _freshellPage, page, harness, terminal }) => {
    await terminal.waitForTerminal()
    await enableClaudeAndCodex(page)

    await harness.clearSentWsMessages()
    let picker = await openPanePicker(page)
    await suppressFreshAgentNetworkForActivePane(page)
    await picker.getByRole('button', { name: /^Freshcodex$/i }).click({ force: true })
    await page.getByRole('option').first().click()

    let dialog = await openFreshAgentSettings(page, 'Freshcodex')
    await expect(dialog.getByRole('combobox', { name: /^Style$/i })).toHaveValue('sans')
    await dialog.getByRole('combobox', { name: /^Style$/i }).selectOption('serif')

    const freshcodexRoot = page.locator('[data-context="fresh-agent"][data-style="serif"]').last()
    await expect(freshcodexRoot).toBeVisible({ timeout: 10_000 })
    await expect.poll(async () => {
      const settings = await harness.getSettings()
      return settings?.freshAgent?.providers?.freshcodex?.style ?? null
    }).toBe('serif')

    await page.route('**/api/fresh-agent/diff*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          diff: [
            'diff --git a/src/index.css b/src/index.css',
            '@@ -1,3 +1,3 @@',
            '-.old { color: blue; }',
            '+.fresh-agent-style-serif { color: #1d1a16; }',
            ' context line',
          ].join('\n'),
        }),
      })
    })
    await page.route('**/api/fresh-agent/threads/freshcodex/codex/style-thread*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          sessionType: 'freshcodex',
          provider: 'codex',
          threadId: 'style-thread',
          sessionId: 'style-thread',
          revision: 1,
          latestTurnId: 'turn-style',
          status: 'idle',
          summary: '',
          capabilities: { send: true, interrupt: true, approvals: true, questions: true, fork: true },
          settings: { model: 'gpt-5.4-flash', permissionMode: 'on-request', effort: 'high', plugins: [] },
          tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
          pendingApprovals: [{
            requestId: 'approval-style',
            toolName: 'Bash',
            input: { command: 'git diff -- src/index.css' },
            decisionReason: 'Review command output before continuing.',
          }],
          pendingQuestions: [{
            requestId: 'question-style',
            questions: [{
              header: 'Direction',
              question: 'Which style should apply?',
              options: [
                { label: 'Serif', description: 'Use the reference visual' },
                { label: 'Sans', description: 'Keep current UI' },
              ],
              multiSelect: false,
            }],
          }],
          worktrees: [{ id: 'wt-style', path: '/tmp/freshell', branch: 'freshagent-serif-full-style' }],
          diffs: [{ id: 'diff-style', path: 'src/index.css', title: 'src/index.css', status: 'modified' }],
          turns: [
            {
              id: 'turn-style-user',
              turnId: 'turn-style-user',
              role: 'user',
              summary: 'Apply the reference treatment',
              items: [{ id: 'item-style-user', kind: 'text', text: 'Apply the reference treatment.' }],
            },
            {
              id: 'turn-style',
              turnId: 'turn-style',
              role: 'assistant',
              summary: 'Serif transcript line',
              items: [
                { id: 'item-style', kind: 'text', text: '## Serif transcript line\n\nThe transcript uses the serif reference treatment.' },
                { id: 'think-style', kind: 'thinking', text: 'private style reasoning should stay hidden' },
                { id: 'tool-style', kind: 'tool_use', toolUseId: 'tool-style-call', name: 'Bash', input: { command: 'rg FreshAgent src' } },
                { id: 'result-style', kind: 'tool_result', toolUseId: 'tool-style-call', content: 'src/components/fresh-agent/FreshAgentView.tsx', isError: false },
              ],
            },
            {
              id: 'turn-style-continuation',
              turnId: 'turn-style-continuation',
              role: 'assistant',
              summary: 'Continuation line',
              items: [{ id: 'item-style-continuation', kind: 'text', text: 'The continuation should not repeat the agent label.' }],
            },
          ],
        }),
      })
    })
    await page.evaluate(() => {
      const harness = window.__FRESHELL_TEST_HARNESS__
      const state = harness?.getState()
      const findFreshcodexLeaf = (node: any): any => {
        if (!node) return null
        if (
          node.type === 'leaf'
          && node.content?.kind === 'fresh-agent'
          && node.content.sessionType === 'freshcodex'
          && node.content.style === 'serif'
        ) {
          return node
        }
        if (node.type === 'split') {
          return findFreshcodexLeaf(node.children?.[0]) ?? findFreshcodexLeaf(node.children?.[1])
        }
        return null
      }
      let tabId: string | null = null
      let leaf: any = null
      for (const [candidateTabId, layout] of Object.entries(state?.panes?.layouts ?? {})) {
        const candidateLeaf = findFreshcodexLeaf(layout)
        if (candidateLeaf) {
          tabId = candidateTabId
          leaf = candidateLeaf
        }
      }
      if (!tabId || !leaf) return
      harness?.dispatch({
        type: 'panes/updatePaneContent',
        payload: {
          tabId,
          paneId: leaf.id,
          content: {
            ...leaf.content,
            sessionId: 'style-thread',
            sessionRef: { provider: 'codex', sessionId: 'style-thread' },
            resumeSessionId: 'style-thread',
            status: 'idle',
            settingsDismissed: true,
            showThinking: true,
          },
        },
      })
    })

    const transcript = freshcodexRoot.locator('.fresh-agent-transcript-copy').first()
    await expect(transcript).toBeVisible({ timeout: 10_000 })
    await expect(freshcodexRoot.getByText('Serif transcript line')).toBeVisible()
    await expect(freshcodexRoot.getByText('private style reasoning should stay hidden')).toHaveCount(0)
    await expect(freshcodexRoot.locator('.fresh-agent-turn-header', { hasText: 'Freshcodex' })).toHaveCount(1)
    await expect(freshcodexRoot.locator('[data-turn-continuation="true"]')).toHaveCount(1)
    await freshcodexRoot.getByRole('button', { name: 'Toggle activity details' }).click()
    await expect(freshcodexRoot.getByText('private style reasoning should stay hidden')).toHaveCount(0)
    await freshcodexRoot.getByRole('button', { name: 'Thinking' }).click()
    await expect(freshcodexRoot.getByText('private style reasoning should stay hidden')).toBeVisible()
    await freshcodexRoot.getByRole('button', { name: /Diff: src\/index\.css/ }).click()
    const transcriptFont = await transcript.evaluate((node) => getComputedStyle(node).fontFamily)
    expect(transcriptFont.toLowerCase()).toContain('georgia')
    const rootFont = await freshcodexRoot.evaluate((node) => getComputedStyle(node).fontFamily)
    expect(rootFont.toLowerCase()).toContain('georgia')
    const composerFont = await freshcodexRoot.getByRole('textbox', { name: 'Chat message input' })
      .evaluate((node) => getComputedStyle(node).fontFamily)
    expect(composerFont.toLowerCase()).toContain('georgia')
    const toolFont = await freshcodexRoot.locator('.fresh-agent-tool-block').first()
      .evaluate((node) => getComputedStyle(node).fontFamily)
    expect(toolFont.toLowerCase()).toContain('ibm plex mono')
    const approvalBackground = await freshcodexRoot.locator('.fresh-agent-approval-card').first()
      .evaluate((node) => getComputedStyle(node).backgroundColor)
    expect(approvalBackground).toBe('rgb(251, 250, 247)')
    const questionBackground = await freshcodexRoot.locator('.fresh-agent-question-card').first()
      .evaluate((node) => getComputedStyle(node).backgroundColor)
    expect(questionBackground).toBe('rgb(251, 250, 247)')
    const diffBackground = await freshcodexRoot.locator('.fresh-agent-diff-panel').first()
      .evaluate((node) => getComputedStyle(node).backgroundColor)
    expect(diffBackground).toBe('rgb(251, 250, 247)')
    const composerButtonFont = await freshcodexRoot.locator('.fresh-agent-composer-action').first()
      .evaluate((node) => getComputedStyle(node).fontFamily)
    expect(composerButtonFont.toLowerCase()).toContain('ibm plex mono')
    await expectFreshAgentSubmitButtonContrasted(freshcodexRoot)
    const chromeFont = await page.locator('[data-context="tab-add"]').evaluate((node) => getComputedStyle(node).fontFamily)
    expect(chromeFont.toLowerCase()).not.toContain('georgia')
    expect(chromeFont.toLowerCase()).not.toContain('literata')
    const watermarkOpacity = await freshcodexRoot.getByTestId('fresh-agent-watermark')
      .evaluate((node) => Number(getComputedStyle(node).opacity))
    expect(watermarkOpacity).toBeLessThanOrEqual(0.004)

    await page.keyboard.press('Escape')
    await page.evaluate(() => {
      const harness = window.__FRESHELL_TEST_HARNESS__
      const state = harness?.getState()
      const findFreshAgentLeaf = (node: any): any => {
        if (!node) return null
        if (node.type === 'leaf' && node.content?.kind === 'fresh-agent') return node
        if (node.type === 'split') {
          return findFreshAgentLeaf(node.children?.[0]) ?? findFreshAgentLeaf(node.children?.[1])
        }
        return null
      }
      let tabId: string | null = null
      let leaf: any = null
      for (const [candidateTabId, layout] of Object.entries(state?.panes?.layouts ?? {})) {
        const candidateLeaf = findFreshAgentLeaf(layout)
        if (candidateLeaf) {
          tabId = candidateTabId
          leaf = candidateLeaf
        }
      }
      if (!tabId || !leaf) return
      harness?.dispatch({
        type: 'panes/updatePaneContent',
        payload: {
          tabId,
          paneId: leaf.id,
          content: {
            kind: 'fresh-agent',
            sessionType: 'freshclaude',
            provider: 'claude',
            createRequestId: 'req-style-freshclaude',
            sessionId: 'style-freshclaude',
            sessionRef: { provider: 'claude', sessionId: 'style-freshclaude' },
            resumeSessionId: 'style-freshclaude',
            status: 'idle',
            settingsDismissed: true,
          },
        },
      })
    })
    await expect(page.locator('[data-context="fresh-agent"][data-style="sans"]').last()).toBeVisible({ timeout: 10_000 })

    dialog = await openFreshAgentSettings(page, 'Freshclaude')
    await expect(dialog.getByRole('combobox', { name: /^Style$/i })).toHaveValue('sans')

    await page.keyboard.press('Escape')
    await page.evaluate(() => {
      const harness = window.__FRESHELL_TEST_HARNESS__
      const state = harness?.getState()
      const findFreshAgentLeaf = (node: any): any => {
        if (!node) return null
        if (node.type === 'leaf' && node.content?.kind === 'fresh-agent') return node
        if (node.type === 'split') {
          return findFreshAgentLeaf(node.children?.[0]) ?? findFreshAgentLeaf(node.children?.[1])
        }
        return null
      }
      let tabId: string | null = null
      let leaf: any = null
      for (const [candidateTabId, layout] of Object.entries(state?.panes?.layouts ?? {})) {
        const candidateLeaf = findFreshAgentLeaf(layout)
        if (candidateLeaf) {
          tabId = candidateTabId
          leaf = candidateLeaf
        }
      }
      if (!tabId || !leaf) return
      harness?.dispatch({
        type: 'panes/updatePaneContent',
        payload: {
          tabId,
          paneId: leaf.id,
          content: {
            kind: 'fresh-agent',
            sessionType: 'freshcodex',
            provider: 'codex',
            createRequestId: 'req-style-freshcodex-next',
            sessionId: 'style-freshcodex-next',
            sessionRef: { provider: 'codex', sessionId: 'style-freshcodex-next' },
            resumeSessionId: 'style-freshcodex-next',
            status: 'idle',
            settingsDismissed: true,
          },
        },
      })
    })
    await expect(page.locator('[data-context="fresh-agent"][data-style="serif"]').last()).toBeVisible({ timeout: 10_000 })

    dialog = await openFreshAgentSettings(page, 'Freshcodex')
    await expect(dialog.getByRole('combobox', { name: /^Style$/i })).toHaveValue('serif')
    await dialog.getByRole('combobox', { name: /^Style$/i }).selectOption('mono')
    const monoRoot = page.locator('[data-context="fresh-agent"][data-style="mono"]').last()
    await expect(monoRoot).toBeVisible({ timeout: 10_000 })
    await expectFreshAgentSubmitButtonContrasted(monoRoot, '--fresh-agent-accent')
  })

  test('thinking text renders lighter than the final answer across sans, serif, and mono styles', async ({ freshellPage: _freshellPage, page, harness, terminal }) => {
    await terminal.waitForTerminal()
    await enableClaudeAndCodex(page)

    await harness.clearSentWsMessages()
    const picker = await openPanePicker(page)
    await suppressFreshAgentNetworkForActivePane(page)
    await picker.getByRole('button', { name: /^Freshcodex$/i }).click({ force: true })
    await page.getByRole('option').first().click()

    // Start in serif: it has an explicit [data-markdown-body] paragraph-color
    // override, which is the hardest case for muted thinking text.
    let dialog = await openFreshAgentSettings(page, 'Freshcodex')
    await dialog.getByRole('combobox', { name: /^Style$/i }).selectOption('serif')
    await page.keyboard.press('Escape')
    await expect(page.locator('[data-context="fresh-agent"][data-style="serif"]').last()).toBeVisible({ timeout: 10_000 })

    const threadId = 'thinking-color-thread'
    const answerText = 'The final answer body text is here.'
    const thinkingText = 'reasoning that should look lighter than the answer'
    await page.route(`**/api/fresh-agent/threads/freshcodex/codex/${threadId}*`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          sessionType: 'freshcodex',
          provider: 'codex',
          threadId,
          sessionId: threadId,
          revision: 1,
          latestTurnId: 'turn-thinking-color',
          status: 'idle',
          summary: '',
          capabilities: { send: true, interrupt: true, approvals: true, questions: true, fork: true },
          settings: { model: 'gpt-5.4-flash', permissionMode: 'on-request', effort: 'high', plugins: [] },
          tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
          pendingApprovals: [],
          pendingQuestions: [],
          worktrees: [],
          diffs: [],
          turns: [
            {
              id: 'turn-thinking-color',
              turnId: 'turn-thinking-color',
              role: 'assistant',
              summary: 'done',
              items: [
                { id: 'item-answer', kind: 'text', text: answerText },
                { id: 'think-1', kind: 'thinking', text: thinkingText },
                { id: 'tool-1', kind: 'tool_use', toolUseId: 'call-1', name: 'Bash', input: { command: 'echo ok' } },
                { id: 'result-1', kind: 'tool_result', toolUseId: 'call-1', content: 'ok', isError: false },
              ],
            },
          ],
        }),
      })
    })

    await page.evaluate((id) => {
      const harness = window.__FRESHELL_TEST_HARNESS__
      const state = harness?.getState()
      const findLeaf = (node: any): any => {
        if (!node) return null
        if (node.type === 'leaf' && node.content?.kind === 'fresh-agent') return node
        if (node.type === 'split') {
          return findLeaf(node.children?.[0]) ?? findLeaf(node.children?.[1])
        }
        return null
      }
      let tabId: string | null = null
      let leaf: any = null
      for (const [candidateTabId, layout] of Object.entries(state?.panes?.layouts ?? {})) {
        const candidateLeaf = findLeaf(layout)
        if (candidateLeaf) { tabId = candidateTabId; leaf = candidateLeaf }
      }
      if (!tabId || !leaf) return
      harness?.dispatch({
        type: 'panes/updatePaneContent',
        payload: {
          tabId,
          paneId: leaf.id,
          content: {
            ...leaf.content,
            sessionId: id,
            sessionRef: { provider: 'codex', sessionId: id },
            resumeSessionId: id,
            status: 'idle',
            settingsDismissed: true,
            showThinking: true,
          },
        },
      })
    }, threadId)

    const paneRoot = page.locator('[data-context="fresh-agent"]').last()
    await expect(paneRoot.getByText(answerText)).toBeVisible({ timeout: 10_000 })

    // Expand the activity strip and the Thinking disclosure so the thinking
    // body text is in the DOM. The strip/thinking component state persists
    // across style switches (same React instances), so re-running this is a
    // no-op once expanded.
    const ensureThinkingExpanded = async (root: any) => {
      const toggle = root.getByRole('button', { name: 'Toggle activity details' })
      if (await toggle.getAttribute('aria-expanded') !== 'true') {
        await toggle.click()
      }
      const thinking = root.getByRole('button', { name: 'Thinking' })
      await expect(thinking).toBeVisible()
      if (await thinking.getAttribute('aria-expanded') !== 'true') {
        await thinking.click()
      }
      await expect(root.getByText(thinkingText)).toBeVisible()
    }
    await ensureThinkingExpanded(paneRoot)

    const probeColors = async (style: string) => {
      const root = page.locator(`[data-context="fresh-agent"][data-style="${style}"]`).last()
      await expect(root).toBeVisible({ timeout: 10_000 })
      await ensureThinkingExpanded(root)
      return root.evaluate((el: HTMLElement, answer: string) => {
        const thinkingBody = el.querySelector('.fresh-agent-thinking-body')
        const thinkingP = thinkingBody?.querySelector('p') ?? null
        const answerP = Array.from(el.querySelectorAll('p'))
          .find(p => p.textContent?.includes(answer)) ?? null
        return {
          thinkingP: thinkingP ? getComputedStyle(thinkingP).color : null,
          thinkingBody: thinkingBody ? getComputedStyle(thinkingBody).color : null,
          answerP: answerP ? getComputedStyle(answerP).color : null,
        }
      }, answerText)
    }

    for (const style of ['serif', 'sans', 'mono'] as const) {
      if (style !== 'serif') {
        dialog = await openFreshAgentSettings(page, 'Freshcodex')
        await dialog.getByRole('combobox', { name: /^Style$/i }).selectOption(style)
        await page.keyboard.press('Escape')
      }
      const colors = await probeColors(style)
      // Prose inside the thinking body must not override the muted container
      // color back to the primary answer color.
      expect(colors.thinkingP).toBe(colors.thinkingBody)
      // Thinking text must be visibly different from the final answer text.
      expect(colors.thinkingP).not.toBe(colors.answerP)
    }
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

  test('renders the fresh-agent transcript at the terminal font size without clipping the composer', async ({ freshellPage, page, harness, terminal }) => {
    await terminal.waitForTerminal()
    const { tabId, paneId } = await getActiveLeaf(harness)
    const sessionId = '44444444-4444-4444-8444-444444444444'
    await suppressFreshAgentNetworkForActivePane(page)

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
          summary: 'Terminal-sized summary line',
          capabilities: { send: true, interrupt: true, approvals: true, questions: true, fork: false },
          settings: { model: 'claude-opus-4-6', permissionMode: 'default', plugins: [] },
          tokenUsage: { inputTokens: 10, outputTokens: 20, totalTokens: 30, costUsd: 0 },
          pendingApprovals: [],
          pendingQuestions: [],
          turns: [{
            id: 'turn-scaled',
            turnId: 'turn-scaled',
            role: 'assistant',
            summary: 'Terminal-sized transcript line',
            items: [{ id: 'item-scaled', kind: 'text', text: 'Terminal-sized transcript line' }],
          }],
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
            createRequestId: 'req-e2e-terminal-font-size',
            sessionId: currentSessionId,
            sessionRef: { provider: 'claude', sessionId: currentSessionId },
            resumeSessionId: currentSessionId,
            status: 'idle',
            settingsDismissed: true,
          },
        },
      })
    }, { currentTabId: tabId, currentPaneId: paneId, currentSessionId: sessionId })

    const paneRoot = page.locator('[data-context="fresh-agent"]')
    await expect(paneRoot).toBeVisible({ timeout: 10_000 })

    const readTranscriptFontSize = () =>
      paneRoot.evaluate((el) => getComputedStyle(el).getPropertyValue('--fresh-transcript-font-size').trim())

    expect(await readTranscriptFontSize()).toBe('16px')

    const textLine = paneRoot
      .locator('article[aria-label="Freshclaude transcript turn"] p')
      .filter({ hasText: 'Terminal-sized transcript line' })
      .first()
    await expect(textLine).toBeVisible()
    const readPositiveTextHeight = async () => {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const height = await textLine
          .evaluate((el) => el.getBoundingClientRect().height)
          .catch(() => 0)
        if (height > 0) return height
        await page.waitForTimeout(50)
      }
      throw new Error('Terminal-sized transcript line did not have a measurable height')
    }
    const heightAt16 = await readPositiveTextHeight()

    // No clipping or hidden geometry growth: the composer textarea and responsive
    // layout stay within the pane when transcript text follows terminal sizing.
    const composer = paneRoot.locator('textarea').first()
    await expect(composer).toBeVisible()
    const layout = paneRoot.locator('.fresh-agent-layout')
    await expect(layout).toBeVisible()
    const paneBox = (await paneRoot.boundingBox())!
    const layoutBox = (await layout.boundingBox())!
    expect(layoutBox.width).toBeLessThanOrEqual(paneBox.width + 2)
    expect(layoutBox.height).toBeLessThanOrEqual(paneBox.height + 2)
    const composerBox = (await composer.boundingBox())!
    expect(composerBox.y + composerBox.height).toBeLessThanOrEqual(paneBox.y + paneBox.height + 2)
    await expect.poll(async () => paneRoot.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1)
    const transcript = paneRoot.locator('[data-context="fresh-agent-transcript"]')
    await expect.poll(async () => transcript.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1)

    // Changing the terminal font size updates the transcript size. The legacy
    // freshAgent.fontScale setting no longer drives Fresh Agent body text.
    await page.evaluate(() => {
      window.__FRESHELL_TEST_HARNESS__?.dispatch({
        type: 'settings/updateSettingsLocal',
        payload: { terminal: { fontSize: 20 }, freshAgent: { fontScale: 2 } },
      })
    })
    await expect.poll(readTranscriptFontSize).toBe('20px')
    const heightAt20 = await readPositiveTextHeight()

    const ratio = heightAt20 / heightAt16
    expect(ratio).toBeGreaterThan(1.15)
    expect(ratio).toBeLessThan(1.35)
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
      window.__FRESHELL_TEST_HARNESS__?.setFreshAgentNetworkEffectsSuppressed(currentPaneId, true)
    }, activePaneId)
    await page.getByRole('button', { name: /^Freshcodex$/i }).click()
    await page.getByRole('option').first().click()
    await expect(page.locator('[data-context="fresh-agent"]').last()).toBeVisible()
    await expect(page.getByText('Freshcodex', { exact: true })).toBeVisible()

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
