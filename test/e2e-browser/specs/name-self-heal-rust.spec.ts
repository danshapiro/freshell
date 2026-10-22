import fs from 'node:fs/promises'
import path from 'node:path'
import { test, expect } from '../helpers/fixtures.js'
import type { Page } from '@playwright/test'
import type { SessionNameRef } from '../../../shared/session-names.js'
import {
  bootUnifiedNamesServer,
  connectUnifiedPage,
  type UnifiedNamesServer,
} from '../helpers/unified-agent-names.js'
import { startRefusingGemini } from '../helpers/native-title-journeys.js'
import { writeClaudeTranscript, writeSessionNamesDocument } from '../helpers/session-names-fixture.js'

/**
 * Name-reliability Task 4 (the self-heal rule): a saved name that is
 * recognizable junk heals on its own as the session is seen, and a name a
 * person chose is never touched — even when it reads "Tab 8".
 *
 * The home is seeded before boot with two real-shape Claude transcripts and
 * a name document recording the old builds' damage: a provider-level
 * "Tab 7" and a manual "Tab 8". AI naming is configured but refused (403,
 * the live failure shape), so only the free names remain.
 *
 * Owned server only: an isolated home and an ephemeral loopback port,
 * stopped by its recorded PID.
 */

test.setTimeout(240_000)

const JUNK_ID = '7a7a7a7a-0000-4000-8000-000000000007'
const MANUAL_ID = '8b8b8b8b-0000-4000-8000-000000000008'
const JUNK_FIRST_MESSAGE = 'Fix the sardine importer'

function claudeRef(sessionId: string): SessionNameRef {
  return { kind: 'session', provider: 'claude', sessionId }
}

async function readName(server: UnifiedNamesServer, ref: SessionNameRef): Promise<{ name: string; source: string } | null> {
  const response = await fetch(`${server.info.baseUrl}/api/session-names/read`, {
    method: 'POST',
    headers: { 'x-auth-token': server.info.token, 'content-type': 'application/json' },
    body: JSON.stringify({ refs: [ref] }),
  })
  if (!response.ok) return null
  const payload = await response.json() as { names: Array<{ record: { name: string; source: string } }> }
  const record = payload.names[0]?.record
  return record ? { name: record.name, source: record.source } : null
}

async function openFromSidebar(page: Page, sessionId: string, expected: string): Promise<void> {
  const row = page.locator(`[data-context="sidebar-session"][data-session-id="${sessionId}"]`)
  await expect(row).toBeVisible({ timeout: 30_000 })
  await expect(row).toContainText(expected, { timeout: 20_000 })
  await row.click()
  const header = page.locator('[data-context="pane-header"]:visible').first()
  await expect(header).toContainText(expected, { timeout: 30_000 })
  const tabId = await header.getAttribute('data-tab-id')
  expect(tabId, 'the opened pane belongs to a tab').toBeTruthy()
  await expect(page.locator(`[data-context="tab"][data-tab-id="${tabId}"]`)).toContainText(expected, { timeout: 30_000 })
}

test.describe('saved names self-heal', () => {
  test('a junk saved name heals to the first message and a manual one stays', async ({ browser }) => {
    const gemini = await startRefusingGemini()
    const server = await bootUnifiedNamesServer({
      mode: 'claude',
      gemini,
      setupHome: async (homeDir) => {
        const cwd = path.join(homeDir, 'work', 'sardines')
        await fs.mkdir(cwd, { recursive: true })
        await writeClaudeTranscript(homeDir, {
          sessionId: JUNK_ID,
          cwd,
          prompts: [JUNK_FIRST_MESSAGE, 'Add a regression test for it'],
        })
        await writeClaudeTranscript(homeDir, {
          sessionId: MANUAL_ID,
          cwd,
          prompts: ['Plan the offsite', 'Book the venue'],
        })
        await writeSessionNamesDocument(homeDir, [
          { provider: 'claude', sessionId: JUNK_ID, name: 'Tab 7', source: 'provider_ai' },
          { provider: 'claude', sessionId: MANUAL_ID, name: 'Tab 8', source: 'manual' },
        ])
      },
    })
    try {
      await expect.poll(() => readName(server, claudeRef(JUNK_ID)), {
        timeout: 30_000, intervals: [500, 1_000, 2_000],
      }).toEqual({ name: JUNK_FIRST_MESSAGE, source: 'first_message' })
      expect(await readName(server, claudeRef(MANUAL_ID))).toEqual({ name: 'Tab 8', source: 'manual' })

      const { page, context } = await connectUnifiedPage({ browser, info: server.info })
      await openFromSidebar(page, JUNK_ID, JUNK_FIRST_MESSAGE)
      await openFromSidebar(page, MANUAL_ID, 'Tab 8')
      expect(await readName(server, claudeRef(MANUAL_ID))).toEqual({ name: 'Tab 8', source: 'manual' })
      await context.close()
    } finally {
      await server.stop()
      await gemini.close().catch(() => {})
    }
  })
})
