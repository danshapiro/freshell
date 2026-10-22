import fs from 'node:fs/promises'
import path from 'node:path'
import { test, expect } from '../helpers/fixtures.js'
import { legacyNameCandidateId, type SessionNameRef } from '../../../shared/session-names.js'
import { createNamedAgent, sendFirstMessage } from '../helpers/unified-agent-names.js'
import {
  bootJourney,
  connect,
  resolveSessionId,
  type Journey,
} from '../helpers/unified-agent-names-modes.js'

/**
 * NAME RELIABILITY (plan Task 3, RC1 server side): once the one-time
 * name consolidation is complete, a browser import — what an old client
 * build left open after the deploy keeps sending on every reconnect — is
 * acknowledged and changes nothing. Before this fix the server applied the
 * old window's live tab title ("Tab 23") over the saved name.
 *
 * The send is made from the page exactly as an old client makes it
 * (`POST /api/session-names/import` with a per-window layout envelope); the
 * current client no longer produces such an envelope at all (Task 2), so
 * the old client's request is reproduced directly.
 *
 * Never a live target: the server is spawned by this spec on an ephemeral
 * loopback port with an isolated HOME and stopped by its recorded PID.
 */

test.setTimeout(240_000)

type StoredRecord = { ref: SessionNameRef; name: string; source: string; revision: number }

async function readFullRecord(journey: Journey, ref: SessionNameRef): Promise<StoredRecord | null> {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(`${journey.server.info.baseUrl}/api/session-names/read`, {
      method: 'POST',
      headers: { 'x-auth-token': journey.server.info.token, 'content-type': 'application/json' },
      body: JSON.stringify({ refs: [ref] }),
    })
    if (response.ok) {
      const payload = await response.json() as { names: Array<{ record: StoredRecord }> }
      return payload.names[0]?.record ?? null
    }
    // The read route shares the API rate limiter: a 429 is transient.
    if (attempt >= 5 || response.status !== 429) {
      throw new Error(`session-names read failed (${response.status})`)
    }
    await new Promise((resolve) => setTimeout(resolve, 600))
  }
}

/** Longer than the naming tick (2 s) plus the sweep's minimum pass
 * interval (5 s): a revision that holds this long is not mid-bind. */
const NAMING_QUIET_WINDOW_MS = 7_500

/** Whether the pane's pending handle is bound to its durable session: a read
 * through a bound pending ref resolves to the session's record. */
async function pendingIsBound(journey: Journey, pending: SessionNameRef | null): Promise<boolean> {
  if (pending?.kind !== 'pending') return true
  const viaPending = await readFullRecord(journey, pending)
  return viaPending?.ref.kind === 'session'
}

/** Wait until the session's saved record has settled: it exists, the pane's
 * pending handle is bound to it (the bind allocates a new record revision
 * even when the text is unchanged), and its revision holds across a quiet
 * window. Only then is it a fair baseline for "never moves". */
async function waitForSettledRecord(
  journey: Journey,
  ref: SessionNameRef,
  pending: SessionNameRef | null,
  timeoutMs = 60_000,
): Promise<StoredRecord> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const first = await readFullRecord(journey, ref)
    if (first && await pendingIsBound(journey, pending)) {
      await new Promise((resolve) => setTimeout(resolve, NAMING_QUIET_WINDOW_MS))
      const second = await readFullRecord(journey, ref)
      if (second && second.revision === first.revision) return second
    }
    if (Date.now() > deadline) throw new Error(`no settled saved record for ${JSON.stringify(ref)} within ${timeoutMs} ms`)
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
}

/** Every `session_names.import_ignored_after_completion` line for one import id. */
async function ignoredImportLines(logsDir: string, importId: string): Promise<unknown[]> {
  const files = await fs.readdir(logsDir).catch(() => [] as string[])
  const lines: unknown[] = []
  for (const file of files.filter((name) => name.endsWith('.jsonl'))) {
    const text = await fs.readFile(path.join(logsDir, file), 'utf8').catch(() => '')
    for (const line of text.split('\n')) {
      if (!line.includes('import_ignored_after_completion')) continue
      const parsed = JSON.parse(line) as { msg?: string; import_id?: string }
      if (parsed.msg === 'session_names.import_ignored_after_completion' && parsed.import_id === importId) {
        lines.push(parsed)
      }
    }
  }
  return lines
}

test.describe('name import after completion', () => {
  test('server ignores a forced stale import', async ({ browser }) => {
    const journey = await bootJourney('claude')
    try {
      const { page, harness, context } = await connect(journey, browser)
      const handle = await createNamedAgent(harness, 'claude', { entry: 'ui', page, server: journey.server })
      await sendFirstMessage(page, harness, handle, 'claude', 'Draft the quarterly billing report')
      const sessionId = await resolveSessionId(journey, handle)
      const sessionRef: SessionNameRef = { kind: 'session', provider: 'claude', sessionId }
      const baseline = await waitForSettledRecord(journey, sessionRef, handle.nameRef)
      expect(baseline.name).not.toBe('Tab 23')

      // An old client's per-window envelope: the live tab title of a
      // second window, which still says "Tab 23" for this session.
      const storageKey = 'freshell.layout.v3.layout-window-stale'
      const candidate = {
        id: legacyNameCandidateId({
          storageKey,
          tabId: 'tab-stale',
          scope: 'source_tab',
          provider: 'claude',
          sessionId,
          name: 'Tab 23',
          source: 'provider_ai',
          protectionEvidence: 'none',
        }),
        target: sessionRef,
        name: 'Tab 23',
        source: 'provider_ai',
        scope: 'source_tab',
        evidenceKey: `${storageKey}#tab-stale`,
        protectionEvidence: 'none',
      }
      const importId = `stale-window-import-${sessionId}`
      const body = {
        version: 1,
        importId,
        evidence: [{
          storageKey,
          raw: JSON.stringify({
            version: 4,
            tabs: { tabs: [{ id: 'tab-stale', title: 'Tab 23', titleSetByUser: false }] },
            panes: {},
          }),
        }],
        candidates: [candidate],
      }

      // The old client resends on every connection-ready edge: send twice.
      for (let send = 0; send < 2; send += 1) {
        const result = await page.evaluate(async ({ url, token, payload }) => {
          const response = await fetch(url, {
            method: 'POST',
            headers: { 'x-auth-token': token, 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          })
          return { status: response.status, body: await response.json() as unknown }
        }, {
          url: `${journey.server.info.baseUrl}/api/session-names/import`,
          token: journey.server.info.token,
          payload: body,
        })
        expect(result.status, JSON.stringify(result.body)).toBe(200)
        expect(result.body).toEqual({ acknowledged: [candidate.id], names: [] })
      }

      // The saved name and its revision never move.
      for (let check = 0; check < 3; check += 1) {
        const current = await readFullRecord(journey, sessionRef)
        expect(current).toEqual(expect.objectContaining({
          name: baseline.name,
          source: baseline.source,
          revision: baseline.revision,
        }))
        await page.waitForTimeout(500)
      }

      // One INFO line for the import id, however many times it was sent.
      await expect.poll(
        async () => (await ignoredImportLines(journey.server.info.logsDir, importId)).length,
        { timeout: 10_000, intervals: [250, 500, 1_000] },
      ).toBe(1)
      const [line] = await ignoredImportLines(journey.server.info.logsDir, importId)
      expect(line).toEqual(expect.objectContaining({ level: 'INFO', candidates: 1 }))
      await context.close()
    } finally {
      await journey.cleanup()
    }
  })
})
