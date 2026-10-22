import fs from 'node:fs/promises'
import path from 'node:path'
import type { Browser } from '@playwright/test'
import { test, expect } from '../helpers/fixtures.js'
import type { SessionNameRef } from '../../../shared/session-names.js'
import {
  createNamedAgent,
  refreshHandle,
  sendFirstMessage,
} from '../helpers/unified-agent-names.js'
import { bootJourney, connect, resolveSessionId, type Journey } from '../helpers/unified-agent-names-modes.js'
import { startRefusingGemini } from '../helpers/native-title-journeys.js'

/**
 * Name-reliability Task 5, scenario D (D4): a terminal-mode Claude, Codex
 * or OpenCode pane gets its first-message name as soon as the first real
 * message is seen, even though AI naming is failing (the fake Gemini
 * refuses every request with 403, the live failure shape). Before, the
 * first-message name was offered only for a newly accepted or indexed
 * message, and the sweep reports a session open in a live terminal as
 * "opened" — so an open terminal pane kept its folder name.
 *
 * The second case starts the pane in a folder reached through a link with
 * another name: the pane's folder name ("sardine-link") is then not the
 * session's own folder ("project", what the provider records), so nothing
 * but the first-message name of the open session can replace it.
 *
 * Owned servers only: an isolated home and an ephemeral loopback port per
 * case, stopped by their recorded PID.
 */

test.setTimeout(300_000)

type TerminalMode = 'claude' | 'codex' | 'opencode'

const FIRST_MESSAGE = 'Fix the sardine importer'

async function readName(journey: Journey, ref: SessionNameRef): Promise<{ name: string; source: string } | null> {
  const response = await fetch(`${journey.server.info.baseUrl}/api/session-names/read`, {
    method: 'POST',
    headers: { 'x-auth-token': journey.server.info.token, 'content-type': 'application/json' },
    body: JSON.stringify({ refs: [ref] }),
  })
  if (!response.ok) return null
  const payload = await response.json() as { names: Array<{ record: { name: string; source: string } }> }
  const record = payload.names[0]?.record
  return record ? { name: record.name, source: record.source } : null
}

async function firstMessageNamesTheTerminalPane(
  mode: TerminalMode,
  browser: Browser,
  opts: { linkedFolder: boolean },
): Promise<void> {
  const gemini = await startRefusingGemini()
  const journey = await bootJourney(mode, {
    gemini,
    // Real opencode keeps its placeholder title until its own naming
    // runs; the fake's default (the session id as title) would read as an
    // opencode-chosen name.
    env: mode === 'opencode' ? { FAKE_OPENCODE_UNNAMED: '1' } : {},
  })
  try {
    let cwd = journey.server.projectDir
    if (opts.linkedFolder) {
      cwd = path.join(journey.server.root, 'sardine-link')
      await fs.symlink(journey.server.projectDir, cwd)
    }
    const folderName = path.basename(cwd)
    const { page, harness, context } = await connect(journey, browser)
    let handle = await createNamedAgent(harness, mode, { entry: 'ui', page, server: journey.server, cwd })
    await sendFirstMessage(page, harness, handle, mode, FIRST_MESSAGE)
    handle = await refreshHandle(harness, handle, mode)
    const sessionId = await resolveSessionId(journey, handle)
    const ref: SessionNameRef = { kind: 'session', provider: mode, sessionId }

    // The record: the first message, not the folder name. The sweep runs
    // every 5 s; the budget leaves the cloud container's index refresh a
    // pass to spare.
    await expect.poll(() => readName(journey, ref), {
      timeout: 30_000, intervals: [500, 1_000, 2_000],
    }).toEqual({ name: FIRST_MESSAGE, source: 'first_message' })

    // The pane's tab and header show it.
    const tab = page.locator(`[data-context="tab"][data-tab-id="${handle.tabId}"]`)
    await expect(tab).toContainText(FIRST_MESSAGE, { timeout: 15_000 })
    await expect(tab).not.toContainText(folderName)
    await expect(page.locator('[data-context="pane-header"]:visible').first()).toContainText(FIRST_MESSAGE, { timeout: 15_000 })
    await context.close()
  } finally {
    await journey.cleanup()
    await gemini.close().catch(() => {})
  }
}

test.describe('first-message name with AI naming failing', () => {
  for (const mode of ['claude', 'codex', 'opencode'] as const) {
    test(`[${mode}] terminal pane gets the first-message name with AI naming failing`, async ({ browser }) => {
      await firstMessageNamesTheTerminalPane(mode, browser, { linkedFolder: false })
    })
  }

  test('[claude] a pane opened through a linked folder gets the first-message name', async ({ browser }) => {
    await firstMessageNamesTheTerminalPane('claude', browser, { linkedFolder: true })
  })
})
