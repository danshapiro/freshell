import fs from 'node:fs/promises'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { test, expect } from '../helpers/fixtures.js'
import type { SessionNameRef } from '../../../shared/session-names.js'
import {
  createNamedAgent,
  refreshHandle,
  sendFirstMessage,
  startFakeGemini,
  startFakeOneCliGeminiProxy,
  type FakeOneCliGeminiProxy,
} from '../helpers/unified-agent-names.js'
import { bootJourney, connect, resolveSessionId, type Journey } from '../helpers/unified-agent-names-modes.js'
import { writeClaudeTranscript, writeSessionNamesDocument } from '../helpers/session-names-fixture.js'

/**
 * Name-reliability Task 6 (D5 as amended): AI naming that is refused —
 * the inherited OneCLI identity without access, or a wrong Gemini key —
 * pauses instead of using up a session's attempts, says so once in the
 * server log with its code, keeps the first-message name, and recovers by
 * itself: when access is granted, or as soon as a key is saved in
 * Settings (a configured key always wins and goes straight to Gemini,
 * never through the OneCLI proxy).
 *
 * Owned servers only: an isolated home and an ephemeral loopback port per
 * case, stopped by their recorded PID. The fake Gemini and the fake OneCLI
 * proxy are loopback servers; no request leaves the host.
 */

test.setTimeout(240_000)

const FIRST_MESSAGE = 'Repair the sardine conveyor'
const AI_NAME = 'Sardine conveyor repair'
const VALID_KEY = 'e2e-valid-gemini-key-0123456789'
const WRONG_KEY = 'e2e-wrong-gemini-key-9876543210'

interface LogLine {
  level?: string
  msg?: string
  code?: string
  [field: string]: unknown
}

async function readLog(journey: Journey): Promise<{ raw: string; lines: LogLine[] }> {
  const raw = await fs.readFile(path.join(journey.server.info.logsDir, 'rust-server.jsonl'), 'utf8').catch(() => '')
  const lines: LogLine[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      lines.push(JSON.parse(line) as LogLine)
    } catch {
      // A line being written right now; the next poll reads it whole.
    }
  }
  return { raw, lines }
}

async function logEvents(journey: Journey, event: string): Promise<LogLine[]> {
  const { lines } = await readLog(journey)
  return lines.filter((line) => typeof line.msg === 'string' && line.msg.split(':')[0] === event)
}

async function capabilityCodes(journey: Journey): Promise<string[]> {
  return (await logEvents(journey, 'session_names.generation_capability_unavailable'))
    .map((line) => String(line.code))
}

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

/** Whether the saved name document holds at least one generation series
 * and none has used an attempt (the series state is internal; the file is
 * the contract). Polled: a probe in flight holds its start for a moment
 * before the refund lands. */
async function noAttemptUsed(journey: Journey): Promise<boolean> {
  const raw = await fs.readFile(path.join(journey.server.info.homeDir, '.freshell', 'session-names.json'), 'utf8')
  const document = JSON.parse(raw) as { generation?: Record<string, { consumed?: number }> }
  const consumed = Object.values(document.generation ?? {}).map((series) => series.consumed ?? 0)
  return consumed.length > 0 && consumed.every((count) => count === 0)
}

function expectNoProxyDetails(text: string, proxy: FakeOneCliGeminiProxy): void {
  expect(text).not.toContain(`127.0.0.1:${proxy.port}`)
  expect(text).not.toContain('oc_test_marker')
}

/** A Claude terminal pane whose first message is in: returns its durable
 * name reference once the first-message name is saved. */
async function claudePaneWithFirstMessage(journey: Journey, page: Page, harness: Awaited<ReturnType<typeof connect>>['harness']) {
  let handle = await createNamedAgent(harness, 'claude', { entry: 'ui', page, server: journey.server })
  await sendFirstMessage(page, harness, handle, 'claude', FIRST_MESSAGE)
  handle = await refreshHandle(harness, handle, 'claude')
  const sessionId = await resolveSessionId(journey, handle)
  const ref: SessionNameRef = { kind: 'session', provider: 'claude', sessionId }
  await expect.poll(() => readName(journey, ref), {
    timeout: 30_000, intervals: [500, 1_000, 2_000],
  }).toEqual({ name: FIRST_MESSAGE, source: 'first_message' })
  return { handle, ref }
}

async function saveKeyInSettings(page: Page, key: string): Promise<void> {
  await page.getByRole('button', { name: /settings/i }).click()
  await page.getByRole('tab', { name: /^Naming$/i }).click()
  const saved = page.waitForResponse((response) =>
    response.url().endsWith('/api/settings') && response.request().method() === 'PATCH' && response.ok())
  await page.getByLabel('Gemini API key').fill(key)
  await saved
  // Back to the panes (Settings replaces the tab strip's view).
  await page.getByTitle('Coding Agents (Ctrl+B T)').click()
}

test.describe('AI naming pauses on refused credentials', () => {
  test('sending to a historical fresh conversation names it from the stored first message', async ({ browser }) => {
    const sessionId = 'a113a113-0000-4000-8000-000000000001'
    const ref: SessionNameRef = { kind: 'session', provider: 'claude', sessionId }
    const gemini = await startFakeGemini(AI_NAME)
    const journey = await bootJourney('freshclaude', {
      gemini,
      setupHome: async (homeDir) => {
        const cwd = path.join(homeDir, 'work', 'historical-sardines')
        await fs.mkdir(cwd, { recursive: true })
        await writeClaudeTranscript(homeDir, {
          sessionId, cwd, prompts: [FIRST_MESSAGE, 'Add regression coverage'],
        })
        await writeSessionNamesDocument(homeDir, [{
          provider: 'claude', sessionId, name: FIRST_MESSAGE, source: 'first_message',
          restingGenerationInput: FIRST_MESSAGE,
        }])
      },
    })
    try {
      const { page, harness, context } = await connect(journey, browser)
      const tabId = 'historical-naming-tab'
      const paneId = 'historical-naming-pane'
      // The same durable resume content as a sidebar-opened fresh pane:
      // no pending naming handle exists to activate the absorbed series.
      await page.evaluate(({ tabId, paneId, sessionId, cwd }) => {
        const dispatch = window.__FRESHELL_TEST_HARNESS__!.dispatch
        dispatch({ type: 'tabs/addTab', payload: { id: tabId, mode: 'claude' } })
        dispatch({ type: 'panes/initLayout', payload: {
          tabId, paneId, content: {
            kind: 'fresh-agent', provider: 'claude', sessionType: 'freshclaude',
            sessionId, resumeSessionId: sessionId, sessionRef: { provider: 'claude', sessionId },
            initialCwd: cwd, status: 'idle',
          },
        } })
      }, { tabId, paneId, sessionId, cwd: path.join(journey.server.info.homeDir, 'work', 'historical-sardines') })
      const pane = page.locator(`[data-pane-id="${paneId}"] [data-context="fresh-agent"], [data-pane-id="${paneId}"][data-context="fresh-agent"]`).first()
      await expect(pane.getByRole('button', { name: 'Send', exact: true })).toBeEnabled({ timeout: 30_000 })
      // This fixture starts idle before its attach finishes. Wait for the
      // committed owner pair that the real send must carry.
      await expect.poll(async () => {
        const owner = (await harness.getState()).freshAgent?.runtimeOwners?.[`claude:${sessionId}`]
        return owner && owner.epoch > 0 && owner.generation > 0 && !owner.fenced ? owner : null
      }, { timeout: 30_000 }).toMatchObject({
        provider: 'claude', sessionId, ownerKind: 'fresh-agent', transition: 'handoff-committed',
      })
      expect(gemini.requests, 'resting historical input is not background work').toEqual([])
      await sendFirstMessage(page, harness, { tabId, paneId, nameRef: ref, sessionId }, 'freshclaude', 'Second turn must never be title input')
      await expect.poll(async () => {
        const sent = await harness.getSentWsMessages() as Record<string, unknown>[]
        const send = sent.find((frame) => frame.type === 'freshAgent.send'
          && frame.sessionId === sessionId && frame.text === 'Second turn must never be title input')
        if (typeof send?.requestId !== 'string') return false
        const received = await harness.getReceivedWsMessages() as Record<string, unknown>[]
        return received.some((frame) => frame.type === 'freshAgent.send.accepted'
          && frame.sessionId === sessionId && frame.requestId === send.requestId)
      }, { timeout: 30_000 }).toBe(true)
      await expect.poll(() => gemini.requests.length, { timeout: 30_000 }).toBeGreaterThan(0)
      for (const request of gemini.requests) {
        expect(request.body).toContain(FIRST_MESSAGE)
        expect(request.body).not.toContain('Second turn must never be title input')
      }
      await expect.poll(() => readName(journey, ref), { timeout: 30_000 }).toEqual({ name: AI_NAME, source: 'freshell_ai' })
      await expect(page.locator(`[data-context="tab"][data-tab-id="${tabId}"]`)).toContainText(AI_NAME)
      await context.close()
    } finally {
      await journey.cleanup()
    }
  })

  test('a later fresh-agent message does not replace the first naming input while paused', async ({ browser }) => {
    const proxy = await startFakeOneCliGeminiProxy(AI_NAME, FIRST_MESSAGE, { mode: 'access_restricted' })
    const journey = await bootJourney('freshclaude', {
      oneCliGeminiProxy: proxy,
      env: { FRESHELL_NAMING_CAPABILITY_REPROBE_MS: '2000' },
    })
    try {
      const { page, harness, context } = await connect(journey, browser)
      let handle = await createNamedAgent(harness, 'freshclaude', { entry: 'ui', page, server: journey.server })
      await sendFirstMessage(page, harness, handle, 'freshclaude', FIRST_MESSAGE)
      handle = await refreshHandle(harness, handle, 'freshclaude')
      const sessionId = await resolveSessionId(journey, handle)
      const ref: SessionNameRef = { kind: 'session', provider: 'claude', sessionId }
      await expect.poll(() => capabilityCodes(journey), { timeout: 30_000 }).toEqual(['access_restricted'])

      const pane = page.locator(`[data-pane-id="${handle.paneId}"] [data-context="fresh-agent"], [data-pane-id="${handle.paneId}"][data-context="fresh-agent"]`).first()
      await expect(pane.getByRole('button', { name: 'Send', exact: true })).toBeEnabled({ timeout: 15_000 })
      await sendFirstMessage(page, harness, handle, 'freshclaude', 'continue')
      await expect(pane.getByRole('button', { name: 'Send', exact: true })).toBeEnabled({ timeout: 15_000 })
      const probesBeforeRecovery = proxy.requests.length
      await expect.poll(() => proxy.requests.length, { timeout: 10_000 }).toBeGreaterThan(probesBeforeRecovery)
      expect(proxy.requests.every((request) => request.promptContainsExpectedFirstMessage)).toBe(true)
      expect(await readName(journey, ref)).toEqual({ name: FIRST_MESSAGE, source: 'first_message' })

      proxy.mode = 'ok'
      await expect.poll(() => readName(journey, ref), { timeout: 15_000 }).toEqual({ name: AI_NAME, source: 'freshell_ai' })
      expect(proxy.requests.every((request) => request.promptContainsExpectedFirstMessage)).toBe(true)
      await expect(page.locator(`[data-context="tab"][data-tab-id="${handle.tabId}"]`)).toContainText(AI_NAME)
      await context.close()
    } finally {
      await journey.cleanup()
    }
  })

  test('pauses naming on access_restricted and recovers when access is granted', async ({ browser }) => {
    const proxy = await startFakeOneCliGeminiProxy(AI_NAME, FIRST_MESSAGE, { mode: 'access_restricted' })
    // No key: the server borrows the inherited OneCLI identity, which the
    // gateway refuses. A 2 s re-probe keeps the recovery inside the budget.
    const journey = await bootJourney('claude', {
      oneCliGeminiProxy: proxy,
      env: { FRESHELL_NAMING_CAPABILITY_REPROBE_MS: '2000' },
    })
    try {
      const { page, harness, context } = await connect(journey, browser)
      const { handle, ref } = await claudePaneWithFirstMessage(journey, page, harness)

      // The refusal is logged once, with its code, while the paused worker
      // keeps re-probing (one request per window, never a key).
      await expect.poll(() => capabilityCodes(journey), { timeout: 30_000 }).toEqual(['access_restricted'])
      await expect.poll(() => proxy.requests.length, { timeout: 20_000 }).toBeGreaterThanOrEqual(3)
      expect(await capabilityCodes(journey)).toEqual(['access_restricted'])
      const [warning] = await logEvents(journey, 'session_names.generation_capability_unavailable')
      expect(warning.level).toBe('WARN')
      expectNoProxyDetails(JSON.stringify(warning), proxy)
      expect(await logEvents(journey, 'session_names.generation_failed'), 'refused attempts are not consumed failures').toEqual([])
      expect(proxy.requests.every((request) => !request.hasApiKey)).toBe(true)
      await expect.poll(() => noAttemptUsed(journey), { timeout: 5_000 }).toBe(true)
      expect(await readName(journey, ref)).toEqual({ name: FIRST_MESSAGE, source: 'first_message' })

      // Access granted: the next probe names the session.
      proxy.mode = 'ok'
      await expect.poll(() => readName(journey, ref), {
        timeout: 10_000, intervals: [250, 500, 1_000],
      }).toEqual({ name: AI_NAME, source: 'freshell_ai' })
      const tab = page.locator(`[data-context="tab"][data-tab-id="${handle.tabId}"]`)
      await expect(tab).toContainText(AI_NAME, { timeout: 10_000 })
      expect(await logEvents(journey, 'session_names.generation_capability_restored')).toHaveLength(1)
      expectNoProxyDetails((await readLog(journey)).raw, proxy)
      await context.close()
    } finally {
      await journey.cleanup()
    }
  })

  test('a key entered in Settings takes over from a refusing proxy', async ({ browser }) => {
    const gemini = await startFakeGemini(AI_NAME, { validKey: VALID_KEY })
    const proxy = await startFakeOneCliGeminiProxy('Gateway name', FIRST_MESSAGE, { mode: 'access_restricted' })
    // The fake Gemini is the base URL and the fake OneCLI proxy the ambient
    // HTTP proxy (NO_PROXY empty: reqwest has no implicit loopback bypass),
    // so the keyless request traverses the proxy; no key at boot.
    const journey = await bootJourney('claude', {
      oneCliGeminiProxy: proxy,
      env: { FRESHELL_GEMINI_BASE_URL: gemini.baseUrl },
    })
    try {
      const { page, harness, context } = await connect(journey, browser)
      const { handle, ref } = await claudePaneWithFirstMessage(journey, page, harness)
      await expect.poll(() => capabilityCodes(journey), { timeout: 30_000 }).toEqual(['access_restricted'])
      expect(proxy.requests).toHaveLength(1)
      expect(gemini.requests).toHaveLength(0)

      await saveKeyInSettings(page, VALID_KEY)
      await expect.poll(() => readName(journey, ref), {
        timeout: 10_000, intervals: [250, 500, 1_000],
      }).toEqual({ name: AI_NAME, source: 'freshell_ai' })
      const tab = page.locator(`[data-context="tab"][data-tab-id="${handle.tabId}"]`)
      await expect(tab).toContainText(AI_NAME, { timeout: 10_000 })
      expect(gemini.requests.map((request) => request.apiKey), 'one keyed request, straight to Gemini').toEqual([VALID_KEY])
      expect(proxy.requests.filter((request) => request.hasApiKey), 'the key never traverses the OneCLI proxy').toEqual([])
      expect(proxy.requests).toHaveLength(1)
      const { raw } = await readLog(journey)
      expect(raw).not.toContain(VALID_KEY)
      await context.close()
    } finally {
      await journey.cleanup()
      await gemini.close().catch(() => {})
    }
  })

  test('a wrong key pauses naming instead of using up attempts', async ({ browser }) => {
    const gemini = await startFakeGemini(AI_NAME, { validKey: VALID_KEY })
    const proxy = await startFakeOneCliGeminiProxy('Gateway name', FIRST_MESSAGE, { mode: 'access_restricted' })
    const journey = await bootJourney('claude', {
      oneCliGeminiProxy: proxy,
      env: { FRESHELL_GEMINI_BASE_URL: gemini.baseUrl },
    })
    try {
      const { page, harness, context } = await connect(journey, browser)
      const { ref } = await claudePaneWithFirstMessage(journey, page, harness)
      await expect.poll(() => capabilityCodes(journey), { timeout: 30_000 }).toEqual(['access_restricted'])

      await saveKeyInSettings(page, WRONG_KEY)
      await expect.poll(() => capabilityCodes(journey), { timeout: 10_000 }).toEqual(['access_restricted', 'API_KEY_INVALID'])
      expect(gemini.requests.map((request) => request.apiKey)).toEqual([WRONG_KEY])
      await expect.poll(() => noAttemptUsed(journey), { timeout: 5_000 }).toBe(true)
      expect(await logEvents(journey, 'session_names.generation_failed')).toEqual([])
      expect(await readName(journey, ref)).toEqual({ name: FIRST_MESSAGE, source: 'first_message' })
      expect(proxy.requests.filter((request) => request.hasApiKey)).toEqual([])
      expect((await readLog(journey)).raw).not.toContain(WRONG_KEY)
      await context.close()
    } finally {
      await journey.cleanup()
      await gemini.close().catch(() => {})
    }
  })
})
