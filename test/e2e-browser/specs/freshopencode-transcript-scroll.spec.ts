import { createFreshE2ePage, expect, test, type Page } from '../helpers/fixtures.js'
import { openPanePicker } from '../helpers/pane-picker.js'
import { selectShellFromPicker, TestHarness } from '../helpers/test-harness.js'
import { TerminalHelper } from '../helpers/terminal-helpers.js'
import type { E2eServerInfo } from '../helpers/server-fixture-support.js'

test.use({ viewport: { width: 1280, height: 720 } })

const SESSION_ID = 'ses-scroll-regression'
const FINAL_TRANSCRIPT_MARKER = 'FRESHOPENCODE_SCROLL_TRANSCRIPT_FINAL_MARKER'
const REVEAL_TRANSCRIPT_MARKER = 'FRESHOPENCODE_SCROLL_REVEAL_MARKER'
const LONG_PAIR_COUNT = 32

type ScrollMetrics = {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  scroller: { top: number; bottom: number; height: number }
  main: { top: number; bottom: number; height: number }
  pane: { top: number; bottom: number; height: number }
}

function makeLongTranscriptTurns() {
  return Array.from({ length: LONG_PAIR_COUNT }, (_, index) => {
    const turnNumber = index + 1
    return [
      {
        id: 'scroll-user-' + turnNumber,
        turnId: 'scroll-user-' + turnNumber,
        role: 'user',
        summary: 'Inspect the scroll regression example ' + turnNumber + '.',
        items: [{
          id: 'scroll-user-item-' + turnNumber,
          kind: 'text',
          text: 'Inspect the scroll regression example ' + turnNumber + '.',
        }],
      },
      {
        id: 'scroll-assistant-' + turnNumber,
        turnId: 'scroll-assistant-' + turnNumber,
        role: 'assistant',
        summary: '',
        items: [{
          id: 'scroll-assistant-item-' + turnNumber,
          kind: 'text',
          text: [
            'Freshopencode response ' + turnNumber + '.',
            'This paragraph is deliberately long enough to exercise the real transcript layout.',
            'The browser must keep this content inside a bounded viewport instead of growing the pane.',
            'The final response number is ' + turnNumber + '.',
            ...(turnNumber === LONG_PAIR_COUNT ? [FINAL_TRANSCRIPT_MARKER] : []),
          ].join('\n\n'),
        }],
      },
    ]
  }).flat()
}

function makeRevealTurns() {
  return [
    {
      id: 'scroll-reveal-user',
      turnId: 'scroll-reveal-user',
      role: 'user',
      summary: 'Continue while the conversation is hidden.',
      items: [{
        id: 'scroll-reveal-user-item',
        kind: 'text',
        text: 'Continue while the conversation is hidden.',
      }],
    },
    {
      id: 'scroll-reveal-assistant',
      turnId: 'scroll-reveal-assistant',
      role: 'assistant',
      summary: '',
      items: [{
        id: 'scroll-reveal-assistant-item',
        kind: 'text',
        text: REVEAL_TRANSCRIPT_MARKER,
      }],
    },
  ]
}

type SnapshotStatus = 'idle' | 'running'

function snapshotFor(turns: unknown[], revision: number, status: SnapshotStatus) {
  return {
    sessionType: 'freshopencode',
    provider: 'opencode',
    threadId: SESSION_ID,
    sessionId: SESSION_ID,
    revision,
    latestTurnId: (turns.at(-1) as { id?: string } | undefined)?.id ?? null,
    status,
    summary: '',
    capabilities: {
      send: true,
      interrupt: true,
      approvals: false,
      questions: false,
      fork: true,
    },
    settings: {
      model: 'opencode-default',
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
    extensions: { opencode: { statusFromLiveState: true } },
    turns,
  }
}

async function routeFreshopencodeSnapshot(page: Page, initialTurns: unknown[], initialStatus: SnapshotStatus = 'idle') {
  let turns = initialTurns
  let revision = 1
  let status = initialStatus
  let requests = 0
  let revealRefreshRequests = 0

  await page.route('**/api/fresh-agent/threads/freshopencode/opencode/' + SESSION_ID + '*', async (route) => {
    const trigger = new URL(route.request().url()).searchParams.get('trigger')
    requests += 1
    if (trigger === 'reveal') revealRefreshRequests += 1
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(snapshotFor(turns, revision, status)),
    })
  })

  return {
    replaceTurns(nextTurns: unknown[]) {
      turns = nextTurns
      revision += 1
    },
    setStatus(nextStatus: SnapshotStatus) {
      // A live status change need not advance the saved transcript revision.
      status = nextStatus
    },
    getRequests() {
      return requests
    },
    getRevealRefreshRequests() {
      return revealRefreshRequests
    },
  }
}

async function routeFreshopencodeSetupApis(page: Page): Promise<void> {
  await page.route('**/api/fresh-agent/model-capabilities/freshopencode**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        sessionType: 'freshopencode',
        runtimeProvider: 'opencode',
        status: 'fresh',
        models: [],
        defaultModel: null,
        updatedAt: new Date(0).toISOString(),
      }),
    })
  })
  await page.route('**/api/files/candidate-dirs', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ directories: ['/tmp'] }),
    })
  })
  await page.route('**/api/files/validate-dir', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ valid: true, resolvedPath: '/tmp' }),
    })
  })
}

async function enableFreshopencode(page: Page): Promise<void> {
  await page.evaluate(() => {
    const harness = window.__FRESHELL_TEST_HARNESS__
    harness?.dispatch({
      type: 'connection/setAvailableClis',
      payload: { opencode: true },
    })
    harness?.dispatch({
      type: 'settings/previewServerSettingsPatch',
      payload: {
        codingCli: { enabledProviders: ['opencode'] },
        freshAgent: { enabled: true },
      },
    })
  })
}

async function createFreshopencodePane(page: Page): Promise<void> {
  // Suppress only the provider frames. The browser still uses the real pane,
  // snapshot, React, and CSS paths below; no provider binary is needed for
  // this geometry regression.
  await page.evaluate(() => {
    window.__FRESHELL_TEST_HARNESS__?.setSuppressAllFreshAgentNetworkEffects(true)
  })

  const picker = await openPanePicker(page)
  await expect(picker.getByRole('button', { name: /^Freshopencode$/i })).toBeVisible({ timeout: 10_000 })
  await picker.getByRole('button', { name: /^Freshopencode$/i }).click({ force: true })

  const directoryInput = page.getByLabel(/^Starting directory for Freshopencode$/i)
  await expect(directoryInput).toBeVisible({ timeout: 15_000 })
  await directoryInput.fill('/tmp')
  await directoryInput.press('Enter')
  await expect(page.locator('[data-context="fresh-agent"][data-session-type="freshopencode"]').last())
    .toBeVisible({ timeout: 15_000 })

  await page.evaluate((sessionId) => {
    const harness = window.__FRESHELL_TEST_HARNESS__
    if (!harness) throw new Error('Freshell test harness unavailable')
    const state = harness.getState()
    const tabId = state.tabs.activeTabId
    if (!tabId) throw new Error('No active tab for Freshopencode pane')

    const findLeaf = (node: any): any => {
      if (!node) return undefined
      if (node.type === 'leaf' && node.content?.kind === 'fresh-agent' && node.content.sessionType === 'freshopencode') {
        return node
      }
      return (node.children ?? []).map(findLeaf).find(Boolean)
    }
    const leaf = findLeaf(state.panes.layouts[tabId])
    if (!leaf) throw new Error('Freshopencode pane was not created')
    harness.dispatch({
      type: 'panes/updatePaneContent',
      payload: {
        tabId,
        paneId: leaf.id,
        content: {
          ...leaf.content,
          sessionId,
          sessionRef: { provider: 'opencode', sessionId },
          resumeSessionId: sessionId,
          status: 'idle',
          settingsDismissed: true,
        },
      },
    })
  }, SESSION_ID)
}

async function readScrollMetrics(transcript: ReturnType<Page['locator']>): Promise<ScrollMetrics> {
  return transcript.evaluate((node) => {
    const scroller = node as HTMLElement
    const pane = node.closest('[data-context="fresh-agent"]') as HTMLElement | null
    const main = pane?.querySelector('.fresh-agent-main') as HTMLElement | null
    if (!pane || !main) throw new Error('Freshopencode layout geometry is incomplete')
    const rect = (element: HTMLElement) => {
      const box = element.getBoundingClientRect()
      return { top: box.top, bottom: box.bottom, height: box.height }
    }
    return {
      scrollTop: scroller.scrollTop,
      scrollHeight: scroller.scrollHeight,
      clientHeight: scroller.clientHeight,
      scroller: rect(scroller),
      main: rect(main),
      pane: rect(pane),
    }
  })
}

async function createTabViaRest(info: E2eServerInfo): Promise<string> {
  const response = await fetch(info.baseUrl + '/api/tabs', {
    method: 'POST',
    headers: {
      'x-auth-token': info.token,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ mode: 'shell', cwd: '/tmp' }),
  })
  const body = await response.json()
  expect(response.ok, 'POST /api/tabs failed: ' + JSON.stringify(body)).toBe(true)
  const tabId = body?.data?.tabId
  expect(tabId).toEqual(expect.any(String))
  return tabId
}

async function revealTab(page: Page, tabId: string): Promise<void> {
  const tabButton = page.locator('[data-context="tab"][data-tab-id="' + tabId + '"]')
  if (await tabButton.count()) {
    await tabButton.first().click()
  } else {
    await page.evaluate((id) => {
      window.__FRESHELL_TEST_HARNESS__?.dispatch({ type: 'tabs/setActiveTab', payload: id })
    }, tabId)
  }
}

test.describe('Freshopencode transcript scrolling', () => {
  test.setTimeout(120_000)

  test('keeps a long transcript scrollable through wheel, paging, and hidden-activity reveal refresh', async ({
    freshellPage: _freshellPage,
    page,
    harness,
    terminal,
    serverInfo,
  }) => {
    await terminal.waitForTerminal()
    await routeFreshopencodeSetupApis(page)
    const initialTurns = makeLongTranscriptTurns()
    const snapshot = await routeFreshopencodeSnapshot(page, initialTurns)
    await enableFreshopencode(page)
    await createFreshopencodePane(page)

    const pane = page.locator('[data-context="fresh-agent"][data-session-type="freshopencode"]').last()
    const transcript = pane.locator('[data-context="fresh-agent-transcript"]')
    await expect(transcript).toBeVisible({ timeout: 15_000 })
    await expect(transcript.getByText(FINAL_TRANSCRIPT_MARKER)).toBeVisible({ timeout: 15_000 })

    const initial = await readScrollMetrics(transcript)
    expect(initial.clientHeight, 'the transcript must have a real CSS viewport').toBeGreaterThan(0)
    expect(initial.scrollHeight, 'the long transcript must overflow the viewport').toBeGreaterThan(initial.clientHeight)
    expect(initial.scrollTop, 'the mounted transcript should settle at its bottom').toBeGreaterThan(0)
    expect(initial.scroller.bottom).toBeLessThanOrEqual(initial.main.bottom + 1)
    expect(initial.scroller.bottom).toBeLessThanOrEqual(initial.pane.bottom + 1)
    expect(initial.scroller.height).toBeLessThan(initial.pane.height)

    // Use a real wheel gesture over the real overflow node. Starting at the
    // bottom makes the negative delta unambiguous and avoids relying on a
    // synthetic scrollTop assignment.
    await transcript.hover()
    const beforeWheel = await readScrollMetrics(transcript)
    await page.mouse.wheel(0, -Math.max(240, Math.floor(beforeWheel.clientHeight * 0.8)))
    await expect.poll(async () => (await readScrollMetrics(transcript)).scrollTop, {
      timeout: 5_000,
    }).toBeLessThan(beforeWheel.scrollTop - 10)

    // PageDown/PageUp are handled by FreshAgentView's pane-level navigation
    // path, which calls the transcript handle against this same DOM scroller.
    await transcript.focus()
    await expect(transcript).toBeFocused()
    const beforePageDown = await readScrollMetrics(transcript)
    await page.keyboard.press('PageDown')
    await expect.poll(async () => (await readScrollMetrics(transcript)).scrollTop, {
      timeout: 5_000,
    }).toBeGreaterThan(beforePageDown.scrollTop + 10)

    const beforePageUp = await readScrollMetrics(transcript)
    await page.keyboard.press('PageUp')
    await expect.poll(async () => (await readScrollMetrics(transcript)).scrollTop, {
      timeout: 5_000,
    }).toBeLessThan(beforePageUp.scrollTop - 10)

    const freshTabId = await harness.getActiveTabId()
    expect(freshTabId).toBeTruthy()
    const hiddenTabId = await createTabViaRest(serverInfo)
    await harness.waitForTabCount(2)
    await revealTab(page, hiddenTabId)
    await expect.poll(async () => harness.getActiveTabId(), { timeout: 10_000 }).toBe(hiddenTabId)
    await expect(page.locator('[data-tab-content-id="' + freshTabId + '"]')).toHaveClass(/tab-hidden/)

    snapshot.replaceTurns([...initialTurns, ...makeRevealTurns()])
    await harness.receiveWsMessage({
      type: 'freshAgent.event',
      sessionType: 'freshopencode',
      provider: 'opencode',
      sessionId: SESSION_ID,
      event: {
        type: 'freshAgent.session.changed',
        sessionId: SESSION_ID,
      },
    })

    await revealTab(page, freshTabId!)
    await expect.poll(async () => harness.getActiveTabId(), { timeout: 10_000 }).toBe(freshTabId)
    await expect.poll(() => snapshot.getRevealRefreshRequests(), { timeout: 15_000 }).toBeGreaterThan(0)
    await expect(transcript.getByText(REVEAL_TRANSCRIPT_MARKER, { exact: true })).toBeVisible({ timeout: 15_000 })

    const afterReveal = await readScrollMetrics(transcript)
    expect(afterReveal.scrollHeight).toBeGreaterThan(afterReveal.clientHeight)
    expect(afterReveal.scroller.bottom).toBeLessThanOrEqual(afterReveal.main.bottom + 1)
    expect(afterReveal.scroller.bottom).toBeLessThanOrEqual(afterReveal.pane.bottom + 1)
  })

  for (const initialStatus of ['idle', 'running'] as const) {
    test(`reveals the ${initialStatus} OpenCode transcript after a real reconnect with an unchanged revision`, async ({ browser, serverInfo }) => {
      const { context, page } = await createFreshE2ePage(browser, serverInfo)
      const harness = new TestHarness(page)
      const terminal = new TerminalHelper(page)
      let helloCount = 0
      try {
        // The synthetic pane is local to this browser, so the test negotiates
        // without pane reconciliation. Install the transport before the first
        // socket opens so it can keep that same pane through the later reconnect.
        await context.routeWebSocket((url) => url.pathname === '/ws', (client) => {
          const upstream = client.connectToServer()
          client.onMessage((message) => {
            let outgoing = message
            try {
              const frame = JSON.parse(String(message)) as Record<string, unknown>
              if (frame.type === 'hello' && frame.capabilities && typeof frame.capabilities === 'object') {
                helloCount += 1
                outgoing = JSON.stringify({
                  ...frame,
                  capabilities: {
                    ...(frame.capabilities as Record<string, unknown>),
                    paneReconcileV1: false,
                    paneReconcileFreshAgentV1: false,
                  },
                })
              }
            } catch {
              // Forward non-JSON WebSocket messages unchanged.
            }
            upstream.send(outgoing)
          })
          upstream.onMessage((message) => client.send(message))
          client.onClose((code, reason) => void upstream.close({ code, reason }).catch(() => {}))
          upstream.onClose((code, reason) => void client.close({ code, reason }).catch(() => {}))
        })

        await routeFreshopencodeSetupApis(page)
        const snapshot = await routeFreshopencodeSnapshot(page, makeLongTranscriptTurns(), initialStatus)
        await page.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1`)
        await harness.waitForHarness()
        await harness.waitForConnection()
        await selectShellFromPicker(page)
        await terminal.waitForTerminal()
        await enableFreshopencode(page)
        await createFreshopencodePane(page)

        const pane = page.locator('[data-context="fresh-agent"][data-session-type="freshopencode"]').last()
        const transcript = pane.locator('[data-context="fresh-agent-transcript"]')
        await expect(transcript).toBeVisible({ timeout: 15_000 })
        await expect(transcript.getByText(FINAL_TRANSCRIPT_MARKER)).toBeVisible({ timeout: 15_000 })
        const stop = pane.getByRole('button', { name: 'Stop', exact: true })
        if (initialStatus === 'running') await expect(stop).toBeEnabled()
        else await expect(stop).toHaveCount(0)

        const freshTabId = await harness.getActiveTabId()
        expect(freshTabId).toBeTruthy()
        const hiddenTabId = await createTabViaRest(serverInfo)
        await harness.waitForTabCount(2)
        await revealTab(page, hiddenTabId)
        await expect.poll(async () => harness.getActiveTabId(), { timeout: 10_000 }).toBe(hiddenTabId)
        await expect(page.locator('[data-tab-content-id="' + freshTabId + '"]')).toHaveClass(/tab-hidden/)

        const previousLastReadyAt = await harness.getLastReadyAt()
        const attachCountBeforeReconnect = await page.evaluate(() => (
          window.__FRESHELL_TEST_HARNESS__?.getSentWsMessages?.() as Array<Record<string, unknown>> | undefined
        )?.filter((message) => message.type === 'freshAgent.attach').length ?? 0)
        await harness.forceDisconnect()
        await harness.waitForConnectionAfter(previousLastReadyAt)
        expect(helloCount, 'the test transport must observe a reconnect hello').toBeGreaterThan(1)
        const survivingSessionId = await page.evaluate((targetTabId) => {
          const state = window.__FRESHELL_TEST_HARNESS__?.getState()
          const findFreshLeaf = (node: any): any => {
            if (!node) return undefined
            if (node.type === 'leaf' && node.content?.kind === 'fresh-agent' && node.content.sessionType === 'freshopencode') return node
            return (node.children ?? []).map(findFreshLeaf).find(Boolean)
          }
          return findFreshLeaf(state?.panes?.layouts?.[targetTabId])?.content?.sessionId
        }, freshTabId!)
        expect(survivingSessionId, 'the hidden fixture must retain the target OpenCode session').toBe(SESSION_ID)
        await expect.poll(async () => (await page.evaluate(() => (
          window.__FRESHELL_TEST_HARNESS__?.getSentWsMessages?.() as Array<Record<string, unknown>> | undefined
        )?.filter((message) => message.type === 'freshAgent.attach').length ?? 0))).toBeGreaterThan(attachCountBeforeReconnect)
        expect(await snapshot.getRevealRefreshRequests()).toBe(0)

        await revealTab(page, freshTabId!)
        await expect.poll(async () => harness.getActiveTabId(), { timeout: 10_000 }).toBe(freshTabId)
        await expect.poll(() => snapshot.getRevealRefreshRequests(), { timeout: 15_000 }).toBeGreaterThan(0)
        await expect(transcript.getByText(FINAL_TRANSCRIPT_MARKER)).toBeVisible({ timeout: 15_000 })
        await expect(page.getByRole('status', { name: 'Refreshing conversation' })).toHaveCount(0)
        if (initialStatus === 'running') {
          // No busy WebSocket event was supplied. The live REST response must
          // restore busy state and retain the user's ability to stop the work.
          await expect(stop).toBeEnabled()
          const beforeIdleRefresh = snapshot.getRequests()
          snapshot.setStatus('idle')
          await harness.receiveWsMessage({
            type: 'freshAgent.event',
            sessionType: 'freshopencode',
            provider: 'opencode',
            sessionId: SESSION_ID,
            event: { type: 'freshAgent.session.changed', sessionId: SESSION_ID },
          })
          await expect.poll(() => snapshot.getRequests()).toBeGreaterThan(beforeIdleRefresh)
          await expect(stop).toHaveCount(0)
          await expect(transcript.getByText(FINAL_TRANSCRIPT_MARKER)).toBeVisible()
          await expect(page.getByRole('status', { name: 'Refreshing conversation' })).toHaveCount(0)
        }
      } finally {
        await harness.killAllTerminals(serverInfo).catch(() => {})
        await context.close()
      }
    })
  }
})
