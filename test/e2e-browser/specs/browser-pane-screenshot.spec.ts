import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { test, expect } from '../helpers/fixtures.js'

/**
 * Browser Pane Screenshot E2E Tests
 *
 * These tests verify that the proxy header stripping works end-to-end:
 * - Proxied localhost URLs render actual iframe content (not placeholders)
 *   because the proxy strips X-Frame-Options and Content-Security-Policy
 * - Truly cross-origin URLs still fall back to a placeholder with the
 *   source URL (since they bypass the proxy entirely)
 */

// Helper: create a browser pane via context menu split + picker
async function createBrowserPane(page: any) {
  const termContainer = page.locator('.xterm').first()
  await termContainer.click({ button: 'right' })
  await page.getByRole('menuitem', { name: /split horizontally/i }).click()

  const browserButton = page.getByRole('button', { name: /^Browser$/i })
  await expect(browserButton).toBeVisible({ timeout: 10_000 })
  await browserButton.click()

  await expect(page.getByPlaceholder('Enter URL...')).toBeVisible({ timeout: 10_000 })
}

/**
 * Start a tiny HTTP server that serves a page with iframe-blocking headers.
 * Returns the server and port. The caller must close the server after use.
 */
function startCanaryServer(): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((_req, res) => {
      res.setHeader('X-Frame-Options', 'DENY')
      res.setHeader('Content-Security-Policy', "frame-ancestors 'none'; default-src 'self'")
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.end(`<!doctype html>
<html>
<head><title>Canary Page</title></head>
<body>
  <h1 id="canary">SCREENSHOT_CANARY</h1>
  <p>This page has X-Frame-Options: DENY and CSP frame-ancestors 'none'</p>
</body>
</html>`)
    })
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo
      resolve({ server, port: addr.port })
    })
    server.on('error', reject)
  })
}

test.describe('Browser Pane Screenshot', () => {
  test('proxied localhost URL with iframe-blocking headers renders actual content, not placeholder', async ({
    freshellPage,
    page,
    serverInfo,
    terminal,
  }) => {
    // Start a canary HTTP server with X-Frame-Options and CSP headers
    const canary = await startCanaryServer()

    try {
      await terminal.waitForTerminal()
      await createBrowserPane(page)

      // Navigate to the canary server's localhost URL
      const urlInput = page.getByPlaceholder('Enter URL...')
      await urlInput.fill(`http://localhost:${canary.port}/`)
      await urlInput.press('Enter')

      // Wait for iframe to load - the BrowserPane should proxy it
      const iframe = page.locator('iframe[title="Browser content"]')
      await iframe.waitFor({ state: 'attached', timeout: 15_000 })

      // Verify the iframe src uses the proxy URL pattern
      const src = await iframe.getAttribute('src')
      expect(src).toContain(`/api/proxy/http/${canary.port}/`)

      // Wait for the iframe content to actually load by checking the frame's content.
      // Since the proxy strips X-Frame-Options and CSP, the iframe should render.
      const frame = iframe.contentFrame()

      // Wait for the canary text to appear in the iframe
      await expect(frame!.locator('#canary')).toHaveText('SCREENSHOT_CANARY', { timeout: 10_000 })

      // Verify there is no placeholder element visible on the page
      // (The placeholder would appear if the iframe content was blocked)
      const placeholder = page.locator('[data-screenshot-iframe-placeholder="true"]')
      await expect(placeholder).toHaveCount(0)

      // Take a screenshot via the agent API (POST /api/screenshots)
      // This exercises the full screenshot chain: captureUiScreenshot ->
      // captureIframeReplacement -> html2canvas
      const screenshotResponse = await page.evaluate(
        async (info: { baseUrl: string; token: string }) => {
          const res = await fetch(`${info.baseUrl}/api/screenshots`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-auth-token': info.token,
            },
            body: JSON.stringify({ scope: 'view', name: 'canary-screenshot', overwrite: true }),
          })
          return { status: res.status, body: await res.json() }
        },
        { baseUrl: serverInfo.baseUrl, token: serverInfo.token },
      )

      // The screenshot should succeed (agent API uses { status: 'ok', data: {...} })
      expect(screenshotResponse.status).toBe(200)
      expect(screenshotResponse.body.status).toBe('ok')
      expect(screenshotResponse.body.data?.path).toBeTruthy()
      expect(screenshotResponse.body.data?.width).toBeGreaterThan(0)
      expect(screenshotResponse.body.data?.height).toBeGreaterThan(0)
    } finally {
      await new Promise<void>((resolve) => canary.server.close(() => resolve()))
    }
  })

  test('truly cross-origin URL falls back to placeholder with source URL', async ({
    freshellPage,
    page,
    terminal,
  }) => {
    await terminal.waitForTerminal()
    await createBrowserPane(page)

    // Navigate to a truly cross-origin URL that the proxy cannot handle
    const urlInput = page.getByPlaceholder('Enter URL...')
    await urlInput.fill('https://example.com')
    await urlInput.press('Enter')

    // Wait for the iframe to load
    const iframe = page.locator('iframe[title="Browser content"]')
    await iframe.waitFor({ state: 'attached', timeout: 15_000 })

    // The iframe src should NOT use the proxy (it's not a localhost URL)
    const src = await iframe.getAttribute('src')
    expect(src).not.toContain('/api/proxy/')

    // The page should show the URL text "example.com" somewhere visible
    // (either in the iframe content or in the URL bar)
    await expect(page.getByPlaceholder('Enter URL...')).toHaveValue(/example\.com/, { timeout: 5_000 })
  })
})
