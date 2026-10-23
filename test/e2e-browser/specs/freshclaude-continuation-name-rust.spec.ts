import { test, expect } from '../helpers/fixtures.js'
import { SessionDirectoryPageSchema } from '../../../shared/read-models.js'
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
        // A live synthetic row can precede the indexed transcript and its
        // persisted freshclaude flavor. Close only once the normal sidebar
        // resume has a durable, interactive Freshclaude row to open.
        await expect.poll(async () => {
          const query = new URLSearchParams({ priority: 'visible', includeKeys: `claude:${original}`, includeNonInteractive: '1', includeEmpty: '1', limit: '50' })
          const response = await fetch(`${lane.info.baseUrl}/api/session-directory?${query}`, { headers: { 'x-auth-token': lane.info.token } })
          if (!response.ok) throw new Error(`Session directory readiness failed (${response.status}): ${await response.text()}`)
          const payload = SessionDirectoryPageSchema.parse(await response.json())
          const item = payload.items.find((item) => item.provider === 'claude' && item.sessionId === original)
          return item ? { flavor: item.sessionType, interactive: !item.isNonInteractive, firstMessage: item.firstUserMessage } : null
        }, { timeout: 45_000, intervals: [500, 1_000, 2_000] }).toEqual({ flavor: 'freshclaude', interactive: true, firstMessage: 'Explore the cache layer' })
        const row = lane.page.locator(`[data-context="sidebar-session"][data-session-id="${original}"]`)
        await expect(row).toHaveAttribute('data-session-type', 'freshclaude', { timeout: 30_000 })
        await tab().getByRole('button', { name: /close/i }).click()
        await expect(row).toBeVisible({ timeout: 30_000 })
        await row.click()
        let tabId = ''
        const paneRoot = lane.page.locator('[data-context="fresh-agent"]').last()
        let paneId = ''
        await expect.poll(async () => {
          const active = await lane.harness.getActiveTabId()
          if (!active || active === pane.tabId) return null
          const opened = freshAgentLeaf(await lane.harness.getPaneLayout(active))
          if (opened?.content?.sessionRef?.sessionId !== original || opened.content.sessionType !== 'freshclaude') return null
          tabId = active
          paneId = opened.id
          return paneId
        }, { timeout: 30_000 }).toBeTruthy()
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
        await expect.poll(async () => {
          const id = (await leaf())?.content?.sessionRef?.sessionId
          return id && id !== previous ? id : null
        }, { timeout: 30_000 }).toBeTruthy()
        previous = (await leaf()).content.sessionRef.sessionId
        await expect(tab()).toContainText('Billing review')
        await expect(lane.page.locator('[data-context="pane-header"]:visible').first()).toContainText('Billing review')
        expect(await readName(previous)).toMatchObject({ name: 'Billing review', source: 'manual' })
      }
      await renameThroughPaneHeader(lane.page, 'Child billing name')
      await expect(tab()).toContainText('Child billing name')
      await expect.poll(() => readName(previous)).toMatchObject({ name: 'Child billing name', source: 'manual' })
      expect(await readName(original)).toMatchObject({ name: 'Billing review', source: 'manual' })
      const composer = paneRoot.getByRole('textbox', { name: 'Chat message input' })
      await composer.fill('/undo')
      await composer.press('Enter')
      await expect.poll(async () => {
        const id = (await leaf())?.content?.sessionRef?.sessionId
        return id && id !== previous ? id : null
      }, { timeout: 30_000 }).toBeTruthy()
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
