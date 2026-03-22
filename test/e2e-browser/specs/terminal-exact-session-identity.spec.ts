import { readFile } from 'fs/promises'
import path from 'path'
import { test, expect } from '../helpers/fixtures.js'

function buildPersistedTerminalTab(input: {
  tabId: string
  paneId: string
  title: string
  createRequestId: string
  sessionId: string
  serverInstanceId: string
}) {
  return {
    tab: {
      id: input.tabId,
      title: input.title,
      createRequestId: input.createRequestId,
      status: 'creating',
      mode: 'codex',
      shell: 'system',
      resumeSessionId: input.sessionId,
      createdAt: Date.now(),
    },
    pane: {
      type: 'leaf',
      id: input.paneId,
      content: {
        kind: 'terminal',
        createRequestId: input.createRequestId,
        status: 'creating',
        mode: 'codex',
        shell: 'system',
        initialCwd: '/workspace/shared',
        resumeSessionId: input.sessionId,
        sessionRef: {
          provider: 'codex',
          sessionId: input.sessionId,
          serverInstanceId: input.serverInstanceId,
        },
      },
    },
  }
}

test.describe('Terminal Exact Session Identity', () => {
  test('reloads same-cwd coding tabs into their own exact sessions', async ({ page, serverInfo, harness }) => {
    const serverInstanceId = (
      await readFile(path.join(serverInfo.configDir, '.freshell', 'instance-id'), 'utf8')
    ).trim()

    const first = buildPersistedTerminalTab({
      tabId: 'tab-codex-1',
      paneId: 'pane-codex-1',
      title: 'Codex One',
      createRequestId: 'req-codex-1',
      sessionId: 'codex-session-1',
      serverInstanceId,
    })
    const second = buildPersistedTerminalTab({
      tabId: 'tab-codex-2',
      paneId: 'pane-codex-2',
      title: 'Codex Two',
      createRequestId: 'req-codex-2',
      sessionId: 'codex-session-2',
      serverInstanceId,
    })

    await page.addInitScript((seed) => {
      window.localStorage.setItem('freshell.tabs.v2', JSON.stringify({
        version: 1,
        tabs: {
          activeTabId: 'tab-codex-1',
          tabs: [seed.first.tab, seed.second.tab],
        },
      }))
      window.localStorage.setItem('freshell.panes.v2', JSON.stringify({
        version: 6,
        layouts: {
          [seed.first.tab.id]: seed.first.pane,
          [seed.second.tab.id]: seed.second.pane,
        },
        activePane: {
          [seed.first.tab.id]: seed.first.pane.id,
          [seed.second.tab.id]: seed.second.pane.id,
        },
        paneTitles: {},
        paneTitleSetByUser: {},
      }))
    }, { first, second })

    await page.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1`)
    await harness.waitForHarness()
    await harness.waitForConnection()
    await harness.waitForTabCount(2)

    await expect.poll(async () => {
      const sent = await harness.getSentWsMessages()
      const createMessages = sent.filter((msg: any) => msg?.type === 'terminal.create')
      const firstSeen = createMessages.some((msg: any) => msg?.tabId === 'tab-codex-1' && msg?.resumeSessionId === 'codex-session-1')
      const secondSeen = createMessages.some((msg: any) => msg?.tabId === 'tab-codex-2' && msg?.resumeSessionId === 'codex-session-2')
      return firstSeen && secondSeen
    }).toBe(true)

    const initialCreateMessages = (await harness.getSentWsMessages())
      .filter((msg: any) => msg?.type === 'terminal.create')
    expect(initialCreateMessages.some((msg: any) => msg?.tabId === 'tab-codex-1' && msg?.resumeSessionId === 'codex-session-1')).toBe(true)
    expect(initialCreateMessages.some((msg: any) => msg?.tabId === 'tab-codex-2' && msg?.resumeSessionId === 'codex-session-2')).toBe(true)
    expect(initialCreateMessages.some((msg: any) => msg?.tabId === 'tab-codex-1' && msg?.resumeSessionId === 'codex-session-2')).toBe(false)
    expect(initialCreateMessages.some((msg: any) => msg?.tabId === 'tab-codex-2' && msg?.resumeSessionId === 'codex-session-1')).toBe(false)

    await harness.clearSentWsMessages()
    await page.reload()
    await harness.waitForHarness()
    await harness.waitForConnection()
    await harness.waitForTabCount(2)

    const tabs = page.locator('[data-context="tab"]')
    await expect(tabs).toHaveCount(2)
    await tabs.nth(1).click()
    await tabs.nth(0).click()

    await expect.poll(async () => {
      const sent = await harness.getSentWsMessages()
      const createMessages = sent.filter((msg: any) => msg?.type === 'terminal.create')
      const firstSeen = createMessages.some((msg: any) => msg?.tabId === 'tab-codex-1' && msg?.resumeSessionId === 'codex-session-1')
      const secondSeen = createMessages.some((msg: any) => msg?.tabId === 'tab-codex-2' && msg?.resumeSessionId === 'codex-session-2')
      return firstSeen && secondSeen
    }).toBe(true)

    const reloadedCreateMessages = (await harness.getSentWsMessages())
      .filter((msg: any) => msg?.type === 'terminal.create')
    expect(reloadedCreateMessages.some((msg: any) => (
      msg?.tabId === 'tab-codex-1'
      && msg?.paneId === 'pane-codex-1'
      && msg?.resumeSessionId === 'codex-session-1'
    ))).toBe(true)
    expect(reloadedCreateMessages.some((msg: any) => (
      msg?.tabId === 'tab-codex-2'
      && msg?.paneId === 'pane-codex-2'
      && msg?.resumeSessionId === 'codex-session-2'
    ))).toBe(true)
    expect(reloadedCreateMessages.some((msg: any) => msg?.tabId === 'tab-codex-1' && msg?.resumeSessionId === 'codex-session-2')).toBe(false)
    expect(reloadedCreateMessages.some((msg: any) => msg?.tabId === 'tab-codex-2' && msg?.resumeSessionId === 'codex-session-1')).toBe(false)
  })

  test('blocks degraded no-layout coding restore instead of guessing', async ({ page, serverInfo, harness }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem('freshell.tabs.v2', JSON.stringify({
        version: 1,
        tabs: {
          activeTabId: 'tab-degraded',
          tabs: [{
            id: 'tab-degraded',
            title: 'Degraded Codex',
            createRequestId: 'req-degraded',
            status: 'creating',
            mode: 'codex',
            shell: 'system',
            terminalId: 'stale-terminal-id',
            resumeSessionId: 'legacy-codex-session',
            createdAt: Date.now(),
          }],
        },
      }))
      window.localStorage.setItem('freshell.panes.v2', JSON.stringify({
        version: 6,
        layouts: {},
        activePane: {},
        paneTitles: {},
        paneTitleSetByUser: {},
      }))
    })

    await page.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1`)
    await harness.waitForHarness()
    await harness.waitForConnection()
    await harness.waitForTabCount(1)

    await page.waitForTimeout(500)

    const createMessages = (await harness.getSentWsMessages())
      .filter((msg: any) => msg?.type === 'terminal.create')
    expect(createMessages).toHaveLength(0)

    const state = await harness.getState()
    expect(state.panes.layouts['tab-degraded']).toMatchObject({
      type: 'leaf',
      content: {
        kind: 'terminal',
        createRequestId: 'req-degraded',
        resumeSessionId: 'legacy-codex-session',
        terminalId: undefined,
      },
    })

    await harness.waitForTerminalText('[Restore blocked: exact session identity missing]')
  })
})
