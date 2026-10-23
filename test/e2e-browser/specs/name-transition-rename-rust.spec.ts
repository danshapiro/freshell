import { test, expect } from '../helpers/fixtures.js'
import type { SessionNameRef } from '../../../shared/session-names.js'
import { createNamedAgent, refreshHandle, renameThroughPaneHeader, sendFirstMessage } from '../helpers/unified-agent-names.js'
import { bootJourney, connect, readRecord, resolveSessionId } from '../helpers/unified-agent-names-modes.js'

test.setTimeout(300_000)

for (const entry of ['ui', 'rest'] as const) {
  test(`${entry}: rename immediately after a conversation switch names the new session`, async ({ browser }) => {
    const journey = await bootJourney('claude')
    try {
      const { page, harness, context } = await connect(journey, browser)
      let handle = await createNamedAgent(harness, 'claude', { entry, page, server: journey.server })
      await sendFirstMessage(page, harness, handle, 'claude', 'Explore the cache layer')
      const original = await resolveSessionId(journey, handle)
      const oldRef: SessionNameRef = { kind: 'session', provider: 'claude', sessionId: original }
      await expect(async () => expect((await readRecord(journey, oldRef)).name).toBeTruthy()).toPass({ timeout: 45_000 })
      await renameThroughPaneHeader(page, 'Original cache conversation')
      await expect(async () => expect((await readRecord(journey, oldRef)).name).toBe('Original cache conversation')).toPass({ timeout: 30_000 })
      await sendFirstMessage(page, harness, handle, 'claude', '/clear')
      let replacement: SessionNameRef | undefined
      await expect.poll(async () => {
        const response = await fetch(`${journey.server.info.baseUrl}/api/terminals`, { headers: { 'x-auth-token': journey.server.info.token } })
        const rows = await response.json() as Array<{ terminalId: string; nameRef?: SessionNameRef }>
        const ref = rows.find((row) => row.terminalId === handle.terminalId)?.nameRef
        replacement = ref?.kind === 'session' && ref.sessionId !== original ? ref : undefined
        return replacement
      }, { timeout: 45_000 }).toBeTruthy()
      // No first user message is sent to the replacement. Its session-name
      // record does not exist until this rename admits it.
      handle = await refreshHandle(harness, handle, 'claude')
      await renameThroughPaneHeader(page, 'New billing conversation')
      await expect(async () => expect((await readRecord(journey, replacement!)).name).toBe('New billing conversation')).toPass({ timeout: 30_000 })
      const tab = page.locator(`[data-context="tab"][data-tab-id="${handle.tabId}"]`)
      await expect(tab).toContainText('New billing conversation')
      expect((await readRecord(journey, oldRef)).name).toBe('Original cache conversation')
      await page.reload()
      await harness.waitForHarness()
      await harness.waitForConnection()
      await expect(tab).toContainText('New billing conversation', { timeout: 30_000 })
      await context.close()
    } finally { await journey.cleanup() }
  })
}
