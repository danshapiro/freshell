import { test, expect } from '../helpers/fixtures.js'
import { ClaudeSimLane, freshAgentLeaf, type ClaudeSimPane } from '../helpers/claude-sim-lane.js'
import { renameThroughPaneHeader } from '../helpers/unified-agent-names.js'

test.setTimeout(180_000)

for (const resume of [false, true]) {
  test(`${resume ? 'resumed' : 'original'} named Claude conversation keeps its name through undo, redo and reload`, async ({ browser }, testInfo) => {
    const lane = await ClaudeSimLane.start(browser, { flavour: 'freshclaude', env: { GOOGLE_GENERATIVE_AI_API_KEY: '' } })
    try {
      // Make the agent the tab's first pane, so the tab is session-owned.
      const before = await lane.harness.getTabCount()
      await lane.page.locator('[data-context="tab-add"]').click()
      await lane.harness.waitForTabCount(before + 1)
      let pane = await lane.openPane()
      for (const text of ['Explore the cache layer', 'Add billing coverage']) {
        await lane.send(pane, text)
        await lane.waitForIdle(pane)
      }
      const leaf = async () => freshAgentLeaf(await lane.harness.getPaneLayout(pane.tabId))
      const original = (await leaf()).content.sessionRef.sessionId as string
      const readName = async (sessionId: string) => {
        const response = await fetch(`${lane.info.baseUrl}/api/session-names/read`, {
          method: 'POST', headers: { 'content-type': 'application/json', 'x-auth-token': lane.info.token },
          body: JSON.stringify({ refs: [{ kind: 'session', provider: 'claude', sessionId }] }),
        })
        expect(response.ok).toBe(true)
        const payload = await response.json() as { names: Array<{ record: { name: string; source: string } }> }
        return payload.names[0]?.record
      }
      await renameThroughPaneHeader(lane.page, 'Billing review')
      await expect.poll(() => readName(original), { timeout: 45_000 }).toMatchObject({ name: 'Billing review', source: 'manual' })
      const tab = () => lane.page.locator(`[data-context="tab"][data-tab-id="${pane.tabId}"]`)
      await expect(tab()).toContainText('Billing review', { timeout: 30_000 })
      if (resume) {
        await tab().getByRole('button', { name: /close/i }).click()
        const row = lane.page.locator(`[data-context="sidebar-session"][data-session-id="${original}"]`)
        await expect(row).toBeVisible({ timeout: 30_000 })
        await row.click()
        const tabId = (await lane.harness.getActiveTabId())!
        const paneRoot = lane.page.locator('[data-context="fresh-agent"]').last()
        let paneId = ''
        await expect.poll(async () => {
          paneId = freshAgentLeaf(await lane.harness.getPaneLayout(tabId))?.id ?? ''
          return paneId
        }).not.toBe('')
        pane = { tabId, paneId, paneRoot } satisfies ClaudeSimPane
        expect((await leaf()).content.namingHandle, 'sidebar resume has no old pre-create naming handle').toBeFalsy()
      }
      const paneRoot = pane.paneRoot
      await expect(tab()).toContainText('Billing review')
      let previous = original
      for (const command of ['/undo', '/redo']) {
        const article = paneRoot.locator('article[data-turn-role="user"]').first()
        await article.hover()
        await expect(article.getByRole('button', { name: 'Undo to here' })).toBeVisible({ timeout: 15_000 })
        await lane.page.mouse.move(0, 0)
        const composer = paneRoot.getByRole('textbox', { name: 'Chat message input' })
        await composer.fill(command)
        await composer.press('Enter')
        await expect.poll(async () => (await leaf())?.content?.sessionRef?.sessionId ?? '', { timeout: 30_000 }).not.toBe(previous)
        previous = (await leaf()).content.sessionRef.sessionId
        await expect(tab()).toContainText('Billing review')
        await expect(lane.page.locator('[data-context="pane-header"]:visible').first()).toContainText('Billing review')
        expect(await readName(previous)).toMatchObject({ name: 'Billing review', source: 'manual' })
      }
      await renameThroughPaneHeader(lane.page, 'Child billing name')
      await expect(tab()).toContainText('Child billing name')
      expect(await readName(previous)).toMatchObject({ name: 'Child billing name', source: 'manual' })
      expect(await readName(original)).toMatchObject({ name: 'Billing review', source: 'manual' })
      const composer = paneRoot.getByRole('textbox', { name: 'Chat message input' })
      await composer.fill('/undo')
      await composer.press('Enter')
      await expect.poll(async () => (await leaf())?.content?.sessionRef?.sessionId ?? '', { timeout: 30_000 }).not.toBe(previous)
      await expect(tab()).toContainText('Child billing name')
      await lane.page.reload()
      await lane.harness.waitForHarness()
      await lane.harness.waitForConnection()
      await expect(tab()).toContainText('Child billing name', { timeout: 30_000 })
    } finally {
      await lane.attachLogsOnFailure(testInfo)
      await lane.stop()
    }
  })
}
