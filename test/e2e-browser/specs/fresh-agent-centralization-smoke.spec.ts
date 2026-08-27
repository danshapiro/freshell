import type { Page } from '@playwright/test'
import { test, expect } from '../helpers/fixtures.js'
import { openPanePicker } from '../helpers/pane-picker.js'
import type { E2eServerInfo } from '../helpers/server-fixture-support.js'

const LAYOUT_STORAGE_KEY = 'freshell.layout.v3'
const CANONICAL_CLAUDE_SESSION_ID = '11111111-1111-4111-8111-111111111111'

type PaneNode = {
  type: 'leaf' | 'split'
  id: string
  content?: Record<string, unknown>
  children?: PaneNode[]
}

type LayoutSnapshot = {
  tabs: Array<{ id: string; title?: string }>
  activeTabId?: string | null
  layouts: Record<string, PaneNode>
  activePane: Record<string, string>
  paneTitles?: Record<string, Record<string, string>>
  paneTitleSetByUser?: Record<string, Record<string, boolean>>
}

function freshAgentSnapshot(sessionType: string, provider: string, threadId: string) {
  return {
    sessionType,
    provider,
    threadId,
    sessionId: threadId,
    revision: 1,
    latestTurnId: null,
    status: 'idle',
    capabilities: {
      send: true,
      interrupt: true,
      approvals: true,
      questions: true,
      fork: true,
    },
    settings: {
      model: provider === 'claude' ? 'claude-opus-4-6' : provider === 'codex' ? 'gpt-5.4-flash' : 'opencode-default',
      permissionMode: provider === 'opencode' ? undefined : 'default',
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
  }
}

async function mockFreshAgentReadRoutes(page: Page) {
  await page.route('**/api/fresh-agent/model-capabilities/**', async (route) => {
    const sessionType = route.request().url().split('/').filter(Boolean).pop() ?? 'freshclaude'
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        sessionType,
        runtimeProvider: sessionType.includes('codex') ? 'codex' : sessionType.includes('opencode') ? 'opencode' : 'claude',
        models: [],
        defaultModel: null,
        updatedAt: new Date(0).toISOString(),
      }),
    })
  })
  await page.route('**/api/fresh-agent/threads/**', async (route) => {
    const url = new URL(route.request().url())
    const [, sessionType = 'freshclaude', provider = 'claude', threadId = CANONICAL_CLAUDE_SESSION_ID] =
      url.pathname.match(/\/api\/fresh-agent\/threads\/([^/]+)\/([^/]+)\/([^/?]+)/) ?? []
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(freshAgentSnapshot(sessionType, provider, decodeURIComponent(threadId))),
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

async function enableFreshClients(page: Page) {
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
        freshAgent: {
          enabled: true,
        },
      },
    })
  })
}

async function openFreshAgentPaneFromPicker(page: Page, label: string) {
  const picker = await openPanePicker(page)
  await enableFreshClients(page)
  await expect(picker.getByRole('button', { name: new RegExp(`^${label}$`, 'i') })).toBeVisible({ timeout: 10_000 })
  const paneId = await picker.getAttribute('data-pane-id')
  expect(paneId).toBeTruthy()
  await page.evaluate((currentPaneId) => {
    window.__FRESHELL_TEST_HARNESS__?.setFreshAgentNetworkEffectsSuppressed(currentPaneId, true)
  }, paneId)
  await picker.getByRole('button', { name: new RegExp(`^${label}$`, 'i') }).click({ force: true })
  await page.getByRole('combobox').fill('/tmp')
  await page.keyboard.press('Enter')
  await expect(page.locator(`[data-context="fresh-agent"]`).last()).toBeVisible({ timeout: 10_000 })
}

function legacyLayoutPayload() {
  return {
    version: 3,
    tabs: {
      activeTabId: 'tab-legacy',
      tabs: [{
        id: 'tab-legacy',
        title: 'Legacy restored agents',
        createdAt: 1,
        updatedAt: 2,
      }],
    },
    panes: {
      version: 7,
      layouts: {
        'tab-legacy': {
          type: 'split',
          id: 'split-root',
          direction: 'horizontal',
          sizes: [55, 45],
          children: [
            {
              type: 'leaf',
              id: 'pane-legacy-agent',
              content: {
                kind: 'agent-chat',
                provider: 'claude',
                createRequestId: 'req-legacy-agent',
                sessionId: CANONICAL_CLAUDE_SESSION_ID,
                resumeSessionId: CANONICAL_CLAUDE_SESSION_ID,
                status: 'idle',
                settingsDismissed: true,
              },
            },
            {
              type: 'split',
              id: 'split-nested',
              direction: 'vertical',
              sizes: [50, 50],
              children: [
                {
                  type: 'leaf',
                  id: 'pane-legacy-agent-nested',
                  content: {
                    kind: 'agent-chat',
                    provider: 'freshclaude',
                    createRequestId: 'req-legacy-agent-nested',
                    sessionId: CANONICAL_CLAUDE_SESSION_ID,
                    resumeSessionId: CANONICAL_CLAUDE_SESSION_ID,
                    status: 'idle',
                    settingsDismissed: true,
                  },
                },
                {
                  type: 'leaf',
                  id: 'pane-shell',
                  content: {
                    kind: 'terminal',
                    createRequestId: 'req-shell',
                    status: 'idle',
                    mode: 'shell',
                    shell: 'system',
                  },
                },
              ],
            },
          ],
        },
      },
      activePane: { 'tab-legacy': 'pane-legacy-agent' },
      paneTitles: {},
      paneTitleSetByUser: {},
    },
    tombstones: [],
  }
}

function collectLeaves(node: PaneNode | null | undefined): PaneNode[] {
  if (!node) return []
  if (node.type === 'leaf') return [node]
  return (node.children ?? []).flatMap((child) => collectLeaves(child))
}

async function readStoredLayout(page: Page) {
  return page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? 'null'), LAYOUT_STORAGE_KEY)
}

async function sendLegacyLayoutSync(page: Page) {
  // This goes through the real WebSocket path so the server LayoutStore, not Redux, performs normalization.
  await page.evaluate((layout) => {
    window.__FRESHELL_TEST_HARNESS__?.sendWsMessage({
      type: 'ui.layout.sync',
      tabs: [{ id: 'tab-remote-legacy', title: 'Remote legacy' }],
      activeTabId: 'tab-remote-legacy',
      layouts: {
        'tab-remote-legacy': layout.panes.layouts['tab-legacy'],
      },
      activePane: { 'tab-remote-legacy': 'pane-legacy-agent' },
      paneTitles: {},
      paneTitleSetByUser: {},
      timestamp: Date.now(),
    })
  }, legacyLayoutPayload())
}

async function fetchWithAuth(serverInfo: E2eServerInfo, path: string, init: RequestInit = {}) {
  return fetch(`${serverInfo.baseUrl}${path}`, {
    ...init,
    headers: {
      'x-auth-token': serverInfo.token,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  })
}

async function fetchNormalizedLayoutProducedByLegacySync(serverInfo: E2eServerInfo, tabId: string): Promise<LayoutSnapshot> {
  await expect.poll(async () => {
    const response = await fetchWithAuth(serverInfo, `/api/layout/snapshot?tabId=${encodeURIComponent(tabId)}`)
    const body = await response.json()
    const layout = body?.data?.layouts?.[tabId] as PaneNode | undefined
    return collectLeaves(layout).map((leaf) => ({
      id: leaf.id,
      kind: leaf.content?.kind,
      createRequestId: leaf.content?.createRequestId,
    }))
  }).toEqual(expect.arrayContaining([
    { id: 'pane-legacy-agent', kind: 'fresh-agent', createRequestId: 'req-legacy-agent' },
    { id: 'pane-legacy-agent-nested', kind: 'fresh-agent', createRequestId: 'req-legacy-agent-nested' },
    { id: 'pane-shell', kind: 'terminal', createRequestId: 'req-shell' },
  ]))

  const response = await fetchWithAuth(serverInfo, `/api/layout/snapshot?tabId=${encodeURIComponent(tabId)}`)
  expect(response.status).toBe(200)
  const body = await response.json()
  const snapshot = body.data as LayoutSnapshot
  const serialized = JSON.stringify(snapshot)
  expect(snapshot.tabs).toEqual([expect.objectContaining({ id: tabId, title: 'Remote legacy' })])
  expect(snapshot.activePane).toMatchObject({ [tabId]: 'pane-legacy-agent' })
  expect(serialized).toContain('"fresh-agent"')
  expect(serialized).not.toContain('"agent-chat"')

  const leaves = collectLeaves(snapshot.layouts[tabId])
  const rootFreshAgent = leaves.find((leaf) => leaf.id === 'pane-legacy-agent')
  const nestedFreshAgent = leaves.find((leaf) => leaf.id === 'pane-legacy-agent-nested')
  expect(rootFreshAgent?.content).toMatchObject({
    kind: 'fresh-agent',
    sessionType: 'freshclaude',
    provider: 'claude',
    createRequestId: 'req-legacy-agent',
    sessionRef: { provider: 'claude', sessionId: CANONICAL_CLAUDE_SESSION_ID },
  })
  expect(nestedFreshAgent?.content).toMatchObject({
    kind: 'fresh-agent',
    sessionType: 'freshclaude',
    provider: 'claude',
    createRequestId: 'req-legacy-agent-nested',
    sessionRef: { provider: 'claude', sessionId: CANONICAL_CLAUDE_SESSION_ID },
  })
  return snapshot
}

async function renderNormalizedLegacySyncSnapshot(page: Page, snapshot: LayoutSnapshot, tabId: string) {
  await page.evaluate(({ snapshot, tabId }) => {
    const harness = window.__FRESHELL_TEST_HARNESS__
    if (!harness) throw new Error('Freshell test harness unavailable')

    const layout = snapshot.layouts[tabId]
    const collectLeaves = (node: any): Array<{ id: string; content?: { kind?: string } }> => {
      if (!node) return []
      if (node.type === 'leaf') return [node]
      return (node.children ?? []).flatMap((child: any) => collectLeaves(child))
    }

    for (const leaf of collectLeaves(layout)) {
      if (leaf.content?.kind === 'fresh-agent') {
        harness.setFreshAgentNetworkEffectsSuppressed(leaf.id, true)
      }
    }

    const tab = snapshot.tabs.find((item) => item.id === tabId)
    if (!tab) throw new Error(`Missing normalized tab ${tabId}`)

    harness.dispatch({
      type: 'tabs/addTab',
      payload: { id: tab.id, title: tab.title ?? tab.id, status: 'running' },
    })
    // The harness cannot receive an echoed ui.layout.sync, so this applies the exact
    // server-normalized snapshot produced by the legacy sync before selecting the tab.
    const current = harness.getState().panes
    harness.dispatch({
      type: 'panes/hydratePanes',
      payload: {
        ...current,
        layouts: { ...current.layouts, [tabId]: layout },
        activePane: { ...current.activePane, [tabId]: snapshot.activePane[tabId] },
        paneTitles: { ...current.paneTitles, ...(snapshot.paneTitles ?? {}) },
        paneTitleSetByUser: { ...current.paneTitleSetByUser, ...(snapshot.paneTitleSetByUser ?? {}) },
      },
    })
    harness.dispatch({ type: 'tabs/setActiveTab', payload: tabId })
  }, { snapshot, tabId })
}

test.describe('Fresh-agent centralization smoke', () => {
  test('creates fresh panes without legacy UI or routes', async ({ freshellPage: _freshellPage, page, terminal }) => {
    await mockFreshAgentReadRoutes(page)
    const requestedUrls: string[] = []
    page.on('request', (request) => requestedUrls.push(request.url()))

    await terminal.waitForTerminal()
    await enableFreshClients(page)

    for (const label of ['Freshclaude', 'Freshcodex', 'Freshopencode']) {
      await openFreshAgentPaneFromPicker(page, label)
    }

    await expect(page.locator('[data-context="fresh-agent"]')).toHaveCount(3)
    await expect(page.locator('[data-context="agent-chat"]')).toHaveCount(0)
    expect(requestedUrls.filter((url) => url.includes('/api/agent-chat') || url.includes('/api/agent-sessions'))).toEqual([])
  })

  test('migrates persisted legacy agent-chat layout before fresh-agent network effects run', async ({ page, serverInfo, harness }) => {
    await mockFreshAgentReadRoutes(page)
    await page.addInitScript(({ key, layout }) => {
      const actualFreshAgentFrames: unknown[] = []
      const originalSend = window.WebSocket.prototype.send
      window.WebSocket.prototype.send = function patchedSend(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
        try {
          const parsed = typeof data === 'string' ? JSON.parse(data) : null
          if (parsed?.type === 'freshAgent.create' || parsed?.type === 'freshAgent.attach') {
            actualFreshAgentFrames.push(parsed)
          }
        } catch {
          // Non-JSON frames are irrelevant for this smoke.
        }
        return originalSend.call(this, data)
      }
      ;(window as typeof window & { __FRESHELL_ACTUAL_FRESH_AGENT_FRAMES__?: unknown[] }).__FRESHELL_ACTUAL_FRESH_AGENT_FRAMES__ = actualFreshAgentFrames
      ;(window as typeof window & { __FRESHELL_SUPPRESS_ALL_FRESH_AGENT_NETWORK_EFFECTS__?: boolean }).__FRESHELL_SUPPRESS_ALL_FRESH_AGENT_NETWORK_EFFECTS__ = true
      localStorage.setItem('freshell_version', '5')
      localStorage.setItem(key, JSON.stringify(layout))
    }, { key: LAYOUT_STORAGE_KEY, layout: legacyLayoutPayload() })

    await page.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1`)
    await harness.waitForHarness()
    await harness.waitForConnection()

    await expect(page.locator('[data-context="fresh-agent"]')).toHaveCount(2, { timeout: 10_000 })
    await expect(page.locator('[data-context="agent-chat"]')).toHaveCount(0)
    await expect(page.getByText(/something went wrong/i)).toHaveCount(0)

    const state = await harness.getState()
    const leaves = collectLeaves(state.panes.layouts['tab-legacy'])
    expect(leaves.filter((leaf) => leaf.content?.kind === 'fresh-agent')).toHaveLength(2)
    expect(JSON.stringify(state.panes.layouts['tab-legacy'])).not.toContain('"agent-chat"')

    const stored = await readStoredLayout(page)
    expect(JSON.stringify(stored)).not.toContain('"agent-chat"')

    const actualFreshAgentFrames = await page.evaluate(() => (
      (window as typeof window & { __FRESHELL_ACTUAL_FRESH_AGENT_FRAMES__?: unknown[] }).__FRESHELL_ACTUAL_FRESH_AGENT_FRAMES__ ?? []
    ))
    expect(actualFreshAgentFrames).toEqual([])
  })

  test('normalizes remote legacy layout sync before exposing server pane snapshots', async ({ freshellPage: _freshellPage, page, harness, serverInfo }) => {
    await mockFreshAgentReadRoutes(page)
    await harness.waitForConnection()

    await sendLegacyLayoutSync(page)

    await expect.poll(async () => {
      const response = await fetchWithAuth(serverInfo, '/api/panes?tabId=tab-remote-legacy')
      const body = await response.json()
      return body?.data?.panes ?? []
    }).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'pane-legacy-agent',
        kind: 'fresh-agent',
      }),
    ]))

    const capture = await fetchWithAuth(serverInfo, '/api/panes/pane-legacy-agent/capture')
    expect(capture.status).toBe(422)
    expect(await capture.json()).toMatchObject({
      status: 'error',
      message: expect.stringContaining('pane kind "fresh-agent"'),
    })

    const normalizedLegacySyncSnapshot = await fetchNormalizedLayoutProducedByLegacySync(serverInfo, 'tab-remote-legacy')
    await renderNormalizedLegacySyncSnapshot(page, normalizedLegacySyncSnapshot, 'tab-remote-legacy')

    await expect(page.locator('[data-context="fresh-agent"]')).toHaveCount(2, { timeout: 10_000 })
    await expect(page.locator('[data-context="agent-chat"]')).toHaveCount(0)

    const browserState = await harness.getState()
    const renderedLayout = browserState.panes.layouts['tab-remote-legacy']
    expect(JSON.stringify(renderedLayout)).toContain('"fresh-agent"')
    expect(JSON.stringify(renderedLayout)).not.toContain('"agent-chat"')
    expect(collectLeaves(renderedLayout)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'pane-legacy-agent',
        content: expect.objectContaining({ createRequestId: 'req-legacy-agent' }),
      }),
      expect.objectContaining({
        id: 'pane-legacy-agent-nested',
        content: expect.objectContaining({ createRequestId: 'req-legacy-agent-nested' }),
      }),
    ]))
  })

  test('keeps fresh-agent settings and routes while legacy settings and routes are removed', async ({ freshellPage: _freshellPage, page, serverInfo }) => {
    const freshSettings = await fetchWithAuth(serverInfo, '/api/settings', {
      method: 'PATCH',
      body: JSON.stringify({ freshAgent: { enabled: true, defaultPlugins: [] } }),
    })
    expect(freshSettings.status).toBe(200)
    const freshSettingsBody = await freshSettings.json()
    expect(freshSettingsBody.freshAgent).toMatchObject({ enabled: true, defaultPlugins: [] })
    expect(freshSettingsBody.agentChat).toBeUndefined()

    const legacySettings = await fetchWithAuth(serverInfo, '/api/settings', {
      method: 'PATCH',
      body: JSON.stringify({ agentChat: { enabled: true } }),
    })
    expect(legacySettings.status).toBe(400)

    const legacyAgentChat = await fetchWithAuth(serverInfo, '/api/agent-chat/capabilities/freshclaude')
    expect(legacyAgentChat.status).toBe(404)
    const legacyAgentSessions = await fetchWithAuth(serverInfo, `/api/agent-sessions/${CANONICAL_CLAUDE_SESSION_ID}`)
    expect(legacyAgentSessions.status).toBe(404)

    const modelCapabilities = await fetchWithAuth(serverInfo, '/api/fresh-agent/model-capabilities/freshclaude')
    expect(modelCapabilities.status).not.toBe(404)
    const thread = await fetchWithAuth(serverInfo, `/api/fresh-agent/threads/freshclaude/claude/${CANONICAL_CLAUDE_SESSION_ID}`)
    expect(thread.headers.get('content-type')).toContain('application/json')
    if (thread.status === 404) {
      const threadBody = await thread.json()
      expect(threadBody.code).toMatch(/^(FRESH_AGENT_LOST_SESSION|RESTORE_NOT_FOUND)$/)
    } else {
      expect(thread.ok || thread.status === 503).toBe(true)
    }

    await page.getByRole('button', { name: /Settings/ }).click()
    await page.getByRole('tab', { name: 'Workspace' }).click()
    await expect(page.getByText('Fresh agent')).toBeVisible()
    await expect(page.getByText(/agent chat/i)).toHaveCount(0)
  })
})
