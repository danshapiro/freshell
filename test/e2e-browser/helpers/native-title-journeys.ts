import http from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Browser, Page } from '@playwright/test'
import { expect } from './fixtures.js'
import { bootJourney, connect, readRecord } from './unified-agent-names-modes.js'
import {
  createNamedAgent,
  expectSharedName,
  refreshHandle,
  sendFirstMessage,
  type FakeGemini,
} from './unified-agent-names.js'
import { readNameChangedEvents } from './name-change-events.js'

/**
 * Name-reliability Task 4 — journeys shared by more than one spec file (the
 * cloud lane attributes cases to the file that declares the `test()`, so
 * the wrappers stay in the spec files).
 */

/** The OpenCode placeholder title (the shape opencode stores until it
 * names a session) and the real title it later reports. */
export const OPENCODE_PLACEHOLDER_TITLE = 'New session - 2026-10-20T00:09:25.350Z'
export const OPENCODE_REAL_TITLE = 'Publishing blocked by token error'
const PLACEHOLDER_PREFIX = 'New session - 20'

/** Watch the naming surfaces (tab labels, pane headers, sidebar rows) for
 * any text from the moment this is installed; `placeholderSightings`
 * answers what was ever seen. A MutationObserver catches transient states
 * between polls. */
async function watchNamingSurfaces(page: Page, needle: string): Promise<void> {
  await page.evaluate((text) => {
    const w = window as unknown as { __namingSightings?: string[] }
    w.__namingSightings = []
    const selector = '[data-context="tab"], [data-context="pane-header"], [data-context="sidebar-session"]'
    const scan = () => {
      for (const element of Array.from(document.querySelectorAll(selector))) {
        const content = element.textContent ?? ''
        if (content.includes(text)) w.__namingSightings!.push(content.slice(0, 200))
      }
    }
    scan()
    new MutationObserver(scan).observe(document.body, { subtree: true, childList: true, characterData: true })
  }, needle)
}

async function namingSightings(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __namingSightings?: string[] }).__namingSightings ?? [])
}

/** The provider's real native title becomes the saved name on every
 * surface; its temporary placeholder never renders anywhere. */
export async function providerRealTitleNeverThePlaceholder(
  mode: 'opencode' | 'freshopencode',
  browser: Browser,
): Promise<void> {
  const journey = await bootJourney(mode, {
    env: { FAKE_OPENCODE_TITLE_SEQUENCE: `${OPENCODE_PLACEHOLDER_TITLE}|${OPENCODE_REAL_TITLE}` },
  })
  try {
    const { page, harness, context } = await connect(journey, browser)
    await watchNamingSurfaces(page, PLACEHOLDER_PREFIX)
    let handle = await createNamedAgent(harness, mode, { entry: 'ui', page, server: journey.server })
    await sendFirstMessage(page, harness, handle, mode, 'Check the publishing pipeline')
    handle = await refreshHandle(harness, handle, mode)
    expect(handle.nameRef).toBeTruthy()
    await expectSharedName(harness, handle.nameRef!, OPENCODE_REAL_TITLE, {
      page, server: journey.server, tabId: handle.tabId, sessionId: handle.sessionId,
    })
    const record = await readRecord(journey, handle.nameRef!)
    expect(record.source).toBe('provider_ai')
    expect(await namingSightings(page), 'no naming surface ever showed the placeholder').toEqual([])
    // Name-reliability Task 12: the real title is one logged change; the
    // placeholder never is.
    const events = await readNameChangedEvents(journey.server.info.logsDir)
    expect(events.filter((event) => event.cause === 'native_observation')).toEqual([
      expect.objectContaining({ new_name: OPENCODE_REAL_TITLE, new_source: 'provider_ai' }),
    ])
    expect(events.filter((event) => event.new_name.startsWith(PLACEHOLDER_PREFIX))).toEqual([])
    await context.close()
  } finally {
    await journey.cleanup()
  }
}

/** A local Gemini stand-in that refuses every request with 403 — the
 * live failure shape (AI naming never succeeds, so only first-message and
 * folder names remain). Counts requests so a spec can prove nothing was
 * sent. Shaped like `FakeGemini` for `bootUnifiedNamesServer`. */
export async function startRefusingGemini(): Promise<FakeGemini> {
  const requests: FakeGemini['requests'] = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk: Buffer) => { body += chunk.toString() })
    req.on('end', () => {
      requests.push({
        apiKey: typeof req.headers['x-goog-api-key'] === 'string' ? req.headers['x-goog-api-key'] : undefined,
        body,
      })
      res.writeHead(403, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { code: 403, message: 'refused by the e2e stand-in', status: 'PERMISSION_DENIED' } }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    baseUrl: `http://127.0.0.1:${port}/v1beta`,
    requests,
    hold: false,
    release: () => {},
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
