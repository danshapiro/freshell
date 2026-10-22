import { expect, test } from '../helpers/fixtures.js'
import type { SessionNameRef } from '../../../shared/session-names.js'
import {
  createNamedAgent,
  refreshHandle,
  renameThroughPaneHeader,
  sendFirstMessage,
} from '../helpers/unified-agent-names.js'
import {
  activityGeneratesOneSharedShortName,
  bootJourney,
  connect,
  everyApplicableRenameEntryConverges,
  manualNameSurvivesLateGenerationAndSwitch,
  pendingNameSurvivesMaterializeAndReopen,
  readRecord,
  resolveSessionId,
  twoBrowsersAndAnloadedHistoryConverge,
  type Journey,
} from '../helpers/unified-agent-names-modes.js'

/** The server's `/api/terminals` row for one terminal (null when absent). */
async function terminalRow(journey: Journey, terminalId: string): Promise<Record<string, any> | null> {
  const response = await fetch(`${journey.server.info.baseUrl}/api/terminals`, {
    headers: { 'x-auth-token': journey.server.info.token },
  })
  if (!response.ok) return null
  const rows = await response.json() as Array<Record<string, any>>
  return rows.find((row) => row.terminalId === terminalId) ?? null
}

// UNIFIED AGENT NAMES (plan Task 8) — the [claude] slice of the six-mode
// acceptance, split per coordinator ruling (task-008-decisions.md,
// Ruling 1): cloud packing is per spec FILE, and one 36-case file starved
// a single 2-CPU Cloud Run task. The five journey BODIES live in the
// shared modes helper; the test wrappers are declared HERE so Playwright
// attributes each case to this file (the cloud shard discovery matches
// spec files by the tests' reported location). The case names are the
// plan's, unchanged.

test.setTimeout(360_000)

test.describe('[claude] unified agent names', () => {
  test('activity generates one shared short name', async ({ browser }) => {
    await activityGeneratesOneSharedShortName('claude', browser)
  })

  test('every applicable rename entry converges', async ({ browser }) => {
    // The broadest case: NINE rename entries, each verified on FIVE
    // surfaces — the bounded per-surface waits accumulate legitimately,
    // so this case gets double the file's default budget.
    test.setTimeout(480_000)
    await everyApplicableRenameEntryConverges('claude', browser)
  })

  test('pending name survives materialize and reopen', async ({ browser }) => {
    // The pre-durable rename + materialize + reopen chain rides the
    // container's cold-fs bind tail (the verified pending->durable bind
    // converges in 60-120s there vs seconds locally): the cold attempt
    // legitimately sums every convergence window (~450s observed across
    // the five expectSharedName surfaces + the reopen chain) — 600s
    // leaves real headroom without masking anything (a correctness
    // failure still fails its own assertion long before this budget).
    test.setTimeout(600_000)
    await pendingNameSurvivesMaterializeAndReopen('claude', browser)
  })

  test('two browsers and an unloaded history page converge', async ({ browser }) => {
    // The longest journey (two live browsers + an unloaded history page +
    // three convergence windows): the 360s file ceiling has no headroom
    // under a full local 3-worker lane — the same per-case treatment the
    // rename-entry case gets.
    test.setTimeout(480_000)
    await twoBrowsersAndAnloadedHistoryConverge('claude', browser)
  })

  test('manual name survives late generation and conversation switch', async ({ browser }) => {
    await manualNameSurvivesLateGenerationAndSwitch('claude', browser)
  })

  // Name reliability (Task 10, G45): an IN-PANE conversation switch (the
  // CLI's `/clear`) moves the terminal row to the new session and shows that
  // session's name; the old session keeps its own.
  test('a conversation switch shows the new conversation name', async ({ browser }) => {
    const journey = await bootJourney('claude')
    try {
      const { page, harness, context } = await connect(journey, browser)
      const created = await createNamedAgent(harness, 'claude', { entry: 'ui', page, server: journey.server })
      let handle = await refreshHandle(harness, created, 'claude')
      expect(handle.terminalId, 'the claude pane has a terminal').toBeTruthy()
      const terminalId = handle.terminalId!
      await sendFirstMessage(page, harness, handle, 'claude', 'Explore the cache layer')
      const sessionA = await resolveSessionId(journey, handle)
      const refA: SessionNameRef = { kind: 'session', provider: 'claude', sessionId: sessionA }
      // The pane's pending name binds onto session A once its transcript
      // exists (the claude naming lane): the row is then on A's own record.
      await expect.poll(async () => (await terminalRow(journey, terminalId))?.nameRef, {
        timeout: 45_000, intervals: [500, 1_000, 2_000],
      }).toEqual(refA)
      await renameThroughPaneHeader(page, 'LotL')
      await expect(async () => {
        expect((await readRecord(journey, refA)).name).toBe('LotL')
      }).toPass({ timeout: 30_000 })
      await expect.poll(async () => (await terminalRow(journey, terminalId))?.sessionName?.name, {
        timeout: 30_000,
      }).toBe('LotL')

      // The switch: the CLI starts a new conversation inside the same pane.
      await sendFirstMessage(page, harness, handle, 'claude', '/clear')
      let sessionB = ''
      await expect.poll(async () => {
        const nameRef = (await terminalRow(journey, terminalId))?.nameRef
        sessionB = nameRef?.kind === 'session' && nameRef.sessionId !== sessionA ? nameRef.sessionId : ''
        return sessionB
      }, { timeout: 45_000, intervals: [500, 1_000, 2_000] }).toBeTruthy()
      const paneHeader = page.locator('[data-context="pane-header"]:visible').first()
      await expect(paneHeader, 'the pane leaves the old conversation\'s name').not.toContainText('LotL', {
        timeout: 30_000,
      })
      expect((await terminalRow(journey, terminalId))?.sessionName?.name).not.toBe('LotL')

      // The new conversation's first message names it.
      handle = await refreshHandle(harness, handle, 'claude')
      await sendFirstMessage(page, harness, handle, 'claude', 'Billing bug in invoices')
      await expect(paneHeader).toContainText('Billing bug in invoices', { timeout: 90_000 })
      await expect.poll(async () => (await terminalRow(journey, terminalId))?.sessionName?.name, {
        timeout: 30_000,
      }).toBe('Billing bug in invoices')
      // The old session keeps its own name.
      expect((await readRecord(journey, refA)).name).toBe('LotL')
      await context.close()
    } finally {
      await journey.cleanup()
    }
  })
})
