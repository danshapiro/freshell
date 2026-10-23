import fs from 'node:fs/promises'
import path from 'node:path'
import { test, expect } from '../helpers/fixtures.js'
import type { BrowserContext, Page } from '@playwright/test'
import type { SessionNameRef } from '../../../shared/session-names.js'
import {
  bootUnifiedNamesServer,
  connectUnifiedPage,
  renameThroughCanonicalApi,
  type UnifiedNamesServer,
} from '../helpers/unified-agent-names.js'
import {
  LIVE_SIZE_NAME_DOCUMENT,
  writeClaudeTranscript,
  writeSessionNamesLoadDocument,
} from '../helpers/session-names-fixture.js'

/**
 * Name-reliability Task 11 (RC9) smoke: names keep loading while the name
 * document is the live machine's size and renames keep committing.
 *
 * The home is seeded before boot with a live-size name document (5,000
 * records, 1,200 idle AI-naming series with 1.5 KB excerpts, 1,600
 * acknowledged migration ids; at least 4.5 MB) holding three real-shape
 * Claude sessions with saved names. Three pages each open one of them; then
 * all three reload at once while 20 renames commit one after another.
 * Every name read the pages make must succeed, and every tab must end up
 * showing its session's saved name.
 *
 * Not a red step: whether the old lock-bound read failed here depended on
 * machine speed. It guards the end-to-end read path.
 *
 * Owned server only: an isolated home and an ephemeral loopback port,
 * stopped by its recorded PID.
 */

test.setTimeout(300_000)

const SESSIONS = [
  { sessionId: '1a1a1a1a-0000-4000-8000-000000000011', name: 'Load page one' },
  { sessionId: '2b2b2b2b-0000-4000-8000-000000000022', name: 'Load page two' },
  { sessionId: '3c3c3c3c-0000-4000-8000-000000000033', name: 'Load page three' },
] as const
const RENAMES = 20

function claudeRef(sessionId: string): SessionNameRef {
  return { kind: 'session', provider: 'claude', sessionId }
}

async function readName(server: UnifiedNamesServer, sessionId: string): Promise<string | null> {
  const response = await fetch(`${server.info.baseUrl}/api/session-names/read`, {
    method: 'POST',
    headers: { 'x-auth-token': server.info.token, 'content-type': 'application/json' },
    body: JSON.stringify({ refs: [claudeRef(sessionId)] }),
  })
  if (!response.ok) return null
  const payload = await response.json() as { names: Array<{ record: { name: string } }> }
  return payload.names[0]?.record.name ?? null
}

/** Open the session from the sidebar; returns the id of the tab it opened. */
async function openFromSidebar(page: Page, sessionId: string, expected: string): Promise<string> {
  const row = page.locator(`[data-context="sidebar-session"][data-session-id="${sessionId}"]`)
  await expect(row).toBeVisible({ timeout: 30_000 })
  await expect(row).toContainText(expected, { timeout: 20_000 })
  await row.click()
  const header = page.locator('[data-context="pane-header"]:visible').first()
  await expect(header).toContainText(expected, { timeout: 30_000 })
  const tabId = await header.getAttribute('data-tab-id')
  expect(tabId, 'the opened pane belongs to a tab').toBeTruthy()
  await expect(page.locator(`[data-context="tab"][data-tab-id="${tabId}"]`)).toContainText(expected, { timeout: 30_000 })
  return tabId!
}

test.describe('name reads under load', () => {
  test('three pages reload during a rename burst on a live-size name document', async ({ browser }) => {
    let documentBytes = 0
    const server = await bootUnifiedNamesServer({
      mode: 'claude',
      setupHome: async (homeDir) => {
        const cwd = path.join(homeDir, 'work', 'load')
        await fs.mkdir(cwd, { recursive: true })
        for (const [index, session] of SESSIONS.entries()) {
          await writeClaudeTranscript(homeDir, {
            sessionId: session.sessionId,
            cwd,
            prompts: [`Load test prompt ${index + 1}`, 'Keep going'],
          })
        }
        documentBytes = await writeSessionNamesLoadDocument(homeDir, SESSIONS.map((session) => ({
          provider: 'claude' as const,
          sessionId: session.sessionId,
          name: session.name,
          source: 'manual' as const,
        })))
      },
    })
    const contexts: BrowserContext[] = []
    try {
      expect(documentBytes, 'the seeded document is live size').toBeGreaterThanOrEqual(LIVE_SIZE_NAME_DOCUMENT.minBytes)

      const reads: Array<{ page: number; status: number; afterReload: boolean }> = []
      let reloading = false
      const opened: Array<{ page: Page; tabId: string }> = []
      for (const [index, session] of SESSIONS.entries()) {
        const { context, page } = await connectUnifiedPage({ browser, info: server.info })
        contexts.push(context)
        page.on('response', (response) => {
          if (new URL(response.url()).pathname !== '/api/session-names/read') return
          reads.push({ page: index, status: response.status(), afterReload: reloading })
        })
        opened.push({ page, tabId: await openFromSidebar(page, session.sessionId, session.name) })
      }

      // All three reload at once while the renames commit one by one.
      reloading = true
      const finalNames = new Map<string, string>()
      const renameBurst = (async () => {
        for (let i = 0; i < RENAMES; i += 1) {
          const session = SESSIONS[i % SESSIONS.length]
          const name = `${session.name} r${i + 1}`
          await renameThroughCanonicalApi(server, claudeRef(session.sessionId), name)
          finalNames.set(session.sessionId, name)
        }
      })()
      await Promise.all([renameBurst, ...opened.map(({ page }) => page.reload())])

      for (const [index, session] of SESSIONS.entries()) {
        const saved = finalNames.get(session.sessionId)!
        expect(await readName(server, session.sessionId), 'the last rename is the saved name').toBe(saved)
        const { page, tabId } = opened[index]
        await expect(page.locator(`[data-context="tab"][data-tab-id="${tabId}"]`)).toContainText(saved, { timeout: 30_000 })
      }

      for (const index of SESSIONS.keys()) {
        expect(
          reads.filter((read) => read.page === index && read.afterReload).length,
          `page ${index + 1} read names after its reload`,
        ).toBeGreaterThan(0)
      }
      expect(reads.filter((read) => read.status !== 200), 'every name read succeeded').toEqual([])
      const { stdout, stderr } = server.server.capturedOutput()
      expect(`${stdout}\n${stderr}`, 'no name operation hit the document lock').not.toContain('NAME_LOCK_UNAVAILABLE')
    } finally {
      for (const context of contexts) await context.close().catch(() => {})
      await server.stop()
    }
  })
})
