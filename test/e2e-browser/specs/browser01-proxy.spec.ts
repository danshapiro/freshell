import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { test, expect } from '../helpers/fixtures.js'

/**
 * BROWSER-01 — Complete same-origin HTTP reverse proxying.
 *
 * Checklist Playwright validation (PW-RUST): "Load a fixture that sets
 * CSP/X-Frame-Options in a Browser pane, interact through `frameLocator`,
 * issue GET/POST/streaming requests, and assert exact upstream inputs and
 * visible responses."
 *
 * The in-spec fixture upstream records the EXACT bytes it receives (raw
 * request target, raw body, headers) and serves an interactive page with
 * X-Frame-Options: DENY + CSP frame-ancestors 'none' — which only renders in
 * the Browser pane's iframe if the proxy stripped precisely those headers.
 * The unit-level contract (duplicate headers, byte-exact anything, strict
 * incremental streaming, error shapes) is pinned by raw-socket tests in
 * `crates/freshell-server/src/proxy.rs` + `tests/browser01_proxy.rs`; this
 * spec is the browser-visible owned-Rust baseline.
 *
 */

interface CapturedRequest {
  method: string
  rawUrl: string
  headers: http.IncomingHttpHeaders
  body: string
}

const IFRAME_BLOCKERS: Record<string, string> = {
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "frame-ancestors 'none'",
  'Content-Security-Policy-Report-Only': "default-src 'self'",
}

// Every fixture page embeds the FULL control set, so post-navigation pages
// keep offering every interaction (no history/back games).
function chrome(result: string): string {
  return `<!doctype html>
<html>
<head><title>BROWSER-01 fixture</title></head>
<body>
  <h1 id="title">PROXY-FIXTURE-READY</h1>
  <div id="result">${result}</div>

  <form action="query-submit" method="GET">
    <input type="hidden" name="q" value="a/b+c d" />
    <button id="get-btn" type="submit">send-get</button>
  </form>

  <form action="form-submit" method="POST">
    <input type="hidden" name="message" value="hello world" />
    <input type="hidden" name="sigil" value="P%ss/&amp;=?" />
    <button id="post-btn" type="submit">send-post</button>
  </form>

  <button id="echo-btn">echo</button>
  <pre id="echo-result"></pre>

  <button id="stream-btn">stream</button>
  <pre id="stream-result"></pre>

  <script>
    // An app-scoped cookie: proves the proxy withholds ONLY the freshell-auth
    // credential pair (set AFTER the root navigation, so the echo/fetch legs
    // below carry it while the root capture proves the auth pair never crossed).
    document.cookie = 'app-session=fixture-1'
    document.getElementById('echo-btn').addEventListener('click', async () => {
      const resp = await fetch('api/echo?x=%2F&plus=1+2')
      document.getElementById('echo-result').textContent = await resp.text()
    })
    document.getElementById('stream-btn').addEventListener('click', async () => {
      const out = document.getElementById('stream-result')
      out.textContent = ''
      const resp = await fetch('stream')
      const reader = resp.body.getReader()
      const dec = new TextDecoder()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        out.textContent += dec.decode(value)
      }
    })
  </script>
</body>
</html>`
}

function startFixture(): Promise<{ server: http.Server; port: number; captured: CapturedRequest[] }> {
  const captured: CapturedRequest[] = []
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = req.url ?? '/'
      const pathname = url.split('?')[0]
      const record = (body = '') =>
        captured.push({ method: req.method ?? '?', rawUrl: url, headers: req.headers, body })

      const sendHtml = (result: string, status = 200, extra: Record<string, string> = {}) => {
        for (const [k, v] of Object.entries({ ...IFRAME_BLOCKERS, ...extra })) {
          res.setHeader(k, v)
        }
        res.statusCode = status
        res.setHeader('Content-Type', 'text/html; charset=utf-8')
        res.end(chrome(result))
      }

      if (req.method === 'GET' && pathname === '/') {
        record()
        return sendHtml('<span id="root">root-ok</span>')
      }
      if (req.method === 'GET' && pathname === '/query-submit') {
        record()
        // The RAW url is the whole point: /query-submit?q=a%2Fb%2Bc+d byte-exact.
        return sendHtml(`<p id="qresult">RAW:url=${url}</p>`)
      }
      if (req.method === 'POST' && pathname === '/form-submit') {
        let body = ''
        req.on('data', (c) => (body += c))
        req.on('end', () => {
          record(body)
          sendHtml(`<p id="presult">POST-RECEIVED:${body}</p>`)
        })
        return
      }
      if (req.method === 'GET' && pathname === '/api/echo') {
        record()
        for (const [k, v] of Object.entries(IFRAME_BLOCKERS)) res.setHeader(k, v)
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ method: req.method, url, sawCookie: Boolean(req.headers.cookie) }))
        return
      }
      if (req.method === 'GET' && pathname === '/stream') {
        record()
        for (const [k, v] of Object.entries(IFRAME_BLOCKERS)) res.setHeader(k, v)
        res.setHeader('Content-Type', 'text/plain; charset=utf-8')
        res.flushHeaders()
        res.write('STREAM-FIRST;')
        setTimeout(() => {
          res.write('STREAM-SECOND;')
          res.end()
        }, 300)
        return
      }
      // Everything else (e.g. favicon): bounded 404, recorded.
      record()
      res.statusCode = 404
      res.end('not-found')
    })
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo
      resolve({ server, port: addr.port, captured })
    })
    server.on('error', reject)
  })
}

// Same UI-driving pattern as browser-pane.spec.ts / browser-pane-screenshot.spec.ts.
async function createBrowserPane(page: any) {
  const termContainer = page.locator('.xterm').first()
  await termContainer.click({ button: 'right' })
  await page.getByRole('menuitem', { name: /split horizontally/i }).click()

  const browserButton = page.getByRole('button', { name: /^Browser$/i })
  await expect(browserButton).toBeVisible({ timeout: 10_000 })
  await browserButton.click()

  await expect(page.getByPlaceholder('Enter URL...')).toBeVisible({ timeout: 10_000 })
}

test.describe('BROWSER-01 same-origin reverse proxy', () => {
  test('fixture with CSP/XFO renders + interacts; GET/POST/streaming preserve exact upstream inputs', async ({
    freshellPage,
    page,
    terminal,
  }) => {
    const fixture = await startFixture()
    try {
      await terminal.waitForTerminal()
      await createBrowserPane(page)

      // Navigate the Browser pane at the loopback fixture — buildHttpProxyUrl
      // rewrites it to same-origin /api/proxy/http/<port>/…
      const urlInput = page.getByPlaceholder('Enter URL...')
      await urlInput.fill(`http://localhost:${fixture.port}/`)
      await urlInput.press('Enter')

      const iframe = page.locator('iframe[title="Browser content"]')
      await iframe.waitFor({ state: 'attached', timeout: 15_000 })
      expect(await iframe.getAttribute('src')).toContain(`/api/proxy/http/${fixture.port}/`)

      // Renders: only possible if XFO + CSP(frame-ancestors) were stripped.
      const frame = page.frameLocator('iframe[title="Browser content"]')
      await expect(frame.locator('#title')).toHaveText('PROXY-FIXTURE-READY', { timeout: 15_000 })
      await expect(frame.locator('#root')).toHaveText('root-ok')
      await expect(page.locator('[data-screenshot-iframe-placeholder="true"]')).toHaveCount(0)

      // GET through a form submit: query bytes reach upstream verbatim,
      // browser-visibly echoed by the fixture.
      await frame.locator('#get-btn').click()
      await expect(frame.locator('#qresult')).toHaveText(
        'RAW:url=/query-submit?q=a%2Fb%2Bc+d',
        { timeout: 10_000 },
      )

      // POST through a form submit (controls persist post-navigation):
      // urlencoded body reaches upstream verbatim, browser-visibly echoed.
      await frame.locator('#post-btn').click()
      await expect(frame.locator('#presult')).toHaveText(
        'POST-RECEIVED:message=hello+world&sigil=P%25ss%2F%26%3D%3F',
        { timeout: 10_000 },
      )

      // fetch() GET with reserved-byte query: byte-exact raw url at
      // upstream — %2F must NOT decode into a path separator.
      await frame.locator('#echo-btn').click()
      await expect(frame.locator('#echo-result')).toContainText(
        '"url":"/api/echo?x=%2F&plus=1+2"',
        { timeout: 10_000 },
      )
      await expect(frame.locator('#echo-result')).toContainText('"method":"GET"')
      await expect(frame.locator('#echo-result')).toContainText('"sawCookie":true')

      // Streaming response: the visible output grows progressively.
      await frame.locator('#stream-btn').click()
      await expect(frame.locator('#stream-result')).toContainText('STREAM-FIRST', {
        timeout: 10_000,
      })
      await expect(frame.locator('#stream-result')).toHaveText('STREAM-FIRST;STREAM-SECOND;', {
        timeout: 10_000,
      })

      // Upstream-side exactness: what the fixture server actually received.
      const root = fixture.captured.find((c) => c.rawUrl === '/')
      expect(root, 'upstream saw the iframe navigation').toBeTruthy()
      // The proxy's gate credentials are
      // withheld from upstream — the root navigation carried ONLY the
      // freshell-auth cookie, so nothing cookie-shaped may survive.
      expect(String(root!.headers.cookie ?? '')).not.toContain('freshell-auth')

      const post = fixture.captured.find((c) => c.method === 'POST' && c.rawUrl === '/form-submit')
      expect(post?.body).toBe('message=hello+world&sigil=P%25ss%2F%26%3D%3F')

      const echo = fixture.captured.find((c) => c.rawUrl.startsWith('/api/echo'))
      expect(echo?.rawUrl).toBe('/api/echo?x=%2F&plus=1+2')
      // By echo time the fixture's JS had set app-session=fixture-1: the
      // app's cookie flows through, still without freshell-auth.
      expect(String(echo?.headers.cookie ?? '')).toContain('app-session=fixture-1')
      expect(String(echo?.headers.cookie ?? '')).not.toContain('freshell-auth')

      const query = fixture.captured.find((c) => c.rawUrl.startsWith('/query-submit'))
      expect(query?.rawUrl).toBe('/query-submit?q=a%2Fb%2Bc+d')
    } finally {
      await new Promise<void>((resolve) => fixture.server.close(() => resolve()))
    }
  })
})
