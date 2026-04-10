import { test, expect } from '../helpers/fixtures.js'

test.describe('Agent Chat Input History', () => {
  async function setupAgentChatPane(page: any, harness: any, terminal: any) {
    await terminal.waitForTerminal()

    const tabId = await harness.getActiveTabId()
    expect(tabId).toBeTruthy()
    const layout = await harness.getPaneLayout(tabId!)
    expect(layout?.type).toBe('leaf')
    const paneId = layout.id as string
    const sessionId = `sdk-e2e-history-${Date.now()}`
    const cliSessionId = '44444444-4444-4444-8444-444444444444'

    await page.evaluate((pId: string) => {
      window.__FRESHELL_TEST_HARNESS__?.setAgentChatNetworkEffectsSuppressed(pId, true)
    }, paneId)

    await page.evaluate((args: any) => {
      const h = window.__FRESHELL_TEST_HARNESS__
      h?.dispatch({ type: 'agentChat/sessionCreated', payload: { requestId: 'req-history', sessionId: args.sid } })
      h?.dispatch({ type: 'agentChat/sessionInit', payload: { sessionId: args.sid, cliSessionId: args.cliSid } })
      h?.dispatch({
        type: 'panes/updatePaneContent',
        payload: {
          tabId: args.tid,
          paneId: args.pid,
          content: {
            kind: 'agent-chat',
            provider: 'freshclaude',
            createRequestId: 'req-history',
            sessionId: args.sid,
            status: 'idle',
          },
        },
      })
    }, { tid: tabId, pid: paneId, sid: sessionId, cliSid: cliSessionId })

    const textarea = page.getByRole('textbox', { name: 'Chat message input' })
    await expect(textarea).toBeVisible()
    return { tabId: tabId!, paneId, sessionId, textarea }
  }

  test('ArrowUp cycles through sent messages', async ({ freshellPage, page, harness, terminal }) => {
    const { textarea } = await setupAgentChatPane(page, harness, terminal)

    await textarea.click()
    await page.keyboard.type('first message')
    await page.keyboard.press('Enter')
    await expect(textarea).toHaveValue('')

    await page.keyboard.type('second message')
    await page.keyboard.press('Enter')
    await expect(textarea).toHaveValue('')

    await page.keyboard.press('ArrowUp')
    await expect(textarea).toHaveValue('second message')

    await page.keyboard.press('ArrowUp')
    await expect(textarea).toHaveValue('first message')

    await page.keyboard.press('ArrowDown')
    await expect(textarea).toHaveValue('second message')

    await page.keyboard.press('ArrowDown')
    await expect(textarea).toHaveValue('')
  })

  test('ArrowUp preserves current draft when navigating away', async ({ freshellPage, page, harness, terminal }) => {
    const { textarea } = await setupAgentChatPane(page, harness, terminal)

    await textarea.click()
    await page.keyboard.type('history entry')
    await page.keyboard.press('Enter')
    await expect(textarea).toHaveValue('')

    await page.keyboard.type('my draft')
    await page.keyboard.press('ArrowUp')
    await expect(textarea).toHaveValue('history entry')

    await page.keyboard.press('ArrowDown')
    await expect(textarea).toHaveValue('my draft')
  })

  test('history persists across page reload', async ({ freshellPage, page, harness, terminal, serverInfo }) => {
    const { paneId } = await setupAgentChatPane(page, harness, terminal)

    const textarea = page.getByRole('textbox', { name: 'Chat message input' })
    await textarea.click()
    await page.keyboard.type('persistent message')
    await page.keyboard.press('Enter')
    await expect(textarea).toHaveValue('')

    await page.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1`)
    await harness.waitForHarness()
    await harness.waitForConnection()

    await page.waitForTimeout(1000)

    const localStorageData = await page.evaluate((pid: string) => {
      return localStorage.getItem(`freshell.input-history.v1:${pid}`)
    }, paneId)
    expect(JSON.parse(localStorageData!)).toContain('persistent message')
  })

  test('history scoped per pane (different paneIds are independent)', async ({ freshellPage, page, harness, terminal }) => {
    const { paneId: firstPaneId } = await setupAgentChatPane(page, harness, terminal)
    const textarea = page.getByRole('textbox', { name: 'Chat message input' })

    await textarea.click()
    await page.keyboard.type('pane-one message')
    await page.keyboard.press('Enter')
    await expect(textarea).toHaveValue('')

    const historyKey1 = await page.evaluate((pid: string) => {
      return localStorage.getItem(`freshell.input-history.v1:${pid}`)
    }, firstPaneId)
    expect(JSON.parse(historyKey1!)).toEqual(['pane-one message'])

    const unrelatedKey = `freshell.input-history.v1:other-pane-${Date.now()}`
    const unrelatedData = await page.evaluate((key: string) => {
      return localStorage.getItem(key)
    }, unrelatedKey)
    expect(unrelatedData).toBeNull()
  })

  test('max 500 entries — oldest evicted', async ({ freshellPage, page, harness, terminal }) => {
    const { paneId } = await setupAgentChatPane(page, harness, terminal)

    await page.evaluate((pid: string) => {
      const entries: string[] = []
      for (let i = 0; i < 502; i++) {
        entries.push(`entry-${i}`)
      }
      localStorage.setItem(`freshell.input-history.v1:${pid}`, JSON.stringify(entries))
    }, paneId)

    const textarea = page.getByRole('textbox', { name: 'Chat message input' })
    await textarea.click()
    await page.keyboard.type('overflow entry')
    await page.keyboard.press('Enter')
    await expect(textarea).toHaveValue('')

    const afterPush = await page.evaluate((pid: string) => {
      const raw = localStorage.getItem(`freshell.input-history.v1:${pid}`)
      return JSON.parse(raw!)
    }, paneId)
    expect(afterPush).toHaveLength(500)
    expect(afterPush[0]).toBe('entry-3')
    expect(afterPush[499]).toBe('overflow entry')
  })
})
