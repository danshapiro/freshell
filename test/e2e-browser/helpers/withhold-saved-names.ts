import type { Page, WebSocketRoute } from '@playwright/test'

const NAME_READ_PATH = '/api/session-names/read'

/** Remove every `sessionName` key (a saved-name record projection) from a
 * decoded JSON value; returns how many were removed. */
function stripSessionNames(value: unknown): number {
  if (!value || typeof value !== 'object') return 0
  let removed = 0
  if (Array.isArray(value)) {
    for (const entry of value) removed += stripSessionNames(entry)
    return removed
  }
  const record = value as Record<string, unknown>
  if ('sessionName' in record) {
    delete record.sessionName
    removed += 1
  }
  for (const entry of Object.values(record)) removed += stripSessionNames(entry)
  return removed
}

/** From the next navigation, withhold saved records from HTTP reads,
 * embedded projections and WebSocket updates. Identity metadata keeps
 * flowing. `release` restores record delivery on the current connection. */
export async function withholdSavedNames(page: Page): Promise<{ readonly withheld: number; release: () => void }> {
  let withheld = 0
  let active = true
  await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
    if (!active) {
      await route.continue()
      return
    }
    const { pathname } = new URL(route.request().url())
    if (pathname === NAME_READ_PATH) {
      withheld += 1
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ names: [] }) })
      return
    }
    const response = await route.fetch()
    const contentType = response.headers()['content-type'] ?? ''
    if (!contentType.includes('application/json')) {
      await route.fulfill({ response })
      return
    }
    const text = await response.text()
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      await route.fulfill({ response })
      return
    }
    const removed = stripSessionNames(body)
    if (removed === 0) {
      await route.fulfill({ response })
      return
    }
    withheld += removed
    // The rewritten body has its own length; the fetched body is already
    // decoded.
    const headers = { ...response.headers() }
    delete headers['content-length']
    delete headers['content-encoding']
    await route.fulfill({ status: response.status(), headers, body: JSON.stringify(body) })
  })
  await page.routeWebSocket((url) => url.pathname === '/ws', (client: WebSocketRoute) => {
    const server = client.connectToServer()
    client.onMessage((raw) => server.send(raw))
    server.onMessage((raw) => {
      if (!active || typeof raw !== 'string') {
        client.send(raw)
        return
      }
      let message: unknown
      try {
        message = JSON.parse(raw)
      } catch {
        client.send(raw)
        return
      }
      if ((message as { type?: unknown } | null)?.type === 'session.name.updated') {
        withheld += 1
        return
      }
      const removed = stripSessionNames(message)
      withheld += removed
      client.send(removed > 0 ? JSON.stringify(message) : raw)
    })
    client.onClose((code, reason) => void server.close({ code, reason }).catch(() => {}))
    server.onClose((code, reason) => void client.close({ code, reason }).catch(() => {}))
  })
  return { get withheld() { return withheld }, release: () => { active = false } }
}

