import { test, expect } from '../helpers/fixtures.js'

test.describe('Tab Layout Integrity', () => {
  test('shows an explicit error for a persisted pane-backed tab with no layout', async ({
    page,
    serverInfo,
    harness,
  }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem('freshell.workspace.v1', JSON.stringify({
        version: 1,
        tabs: {
          activeTabId: 'broken-tab',
          tabs: [{
            id: 'broken-tab',
            title: 'Broken Codex',
            createRequestId: 'req-broken',
            status: 'creating',
            mode: 'codex',
            shell: 'system',
            resumeSessionId: 'codex-session-broken',
            createdAt: Date.now(),
          }],
        },
        panes: {
          layouts: {},
          activePane: {},
          paneTitles: {},
          paneTitleSetByUser: {},
        },
      }))
      window.localStorage.setItem('freshell.tabs.v2', JSON.stringify({
        version: 1,
        tabs: {
          activeTabId: 'broken-tab',
          tabs: [{
            id: 'broken-tab',
            title: 'Broken Codex',
            createRequestId: 'req-broken',
            status: 'creating',
            mode: 'codex',
            shell: 'system',
            resumeSessionId: 'codex-session-broken',
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

    await expect(page.getByTestId('missing-layout-error')).toBeVisible()
    await expect(page.getByTestId('missing-layout-error')).toContainText('layout is missing')
    await expect(
      page.locator('[data-context="tab"]').filter({ hasText: 'Broken Codex' })
    ).toBeVisible()

    const createMessages = (await harness.getSentWsMessages())
      .filter((msg: any) => msg?.type === 'terminal.create')
    expect(createMessages).toHaveLength(0)

    const state = await harness.getState()
    expect(state.tabs.tabs).toHaveLength(1)
    expect(state.tabs.tabs[0]?.id).toBe('broken-tab')
    expect(state.panes.layouts['broken-tab']).toBeUndefined()
  })
})
