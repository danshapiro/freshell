import { test, expect } from '../helpers/fixtures.js'

const FORBIDDEN = [
  '/api/proxy/forward',
  '/api/fresh-agent/attachments',
  '/api/fresh-agent/exec',
  '/api/fresh-agent/diff',
  '/api/files/open',
  '/api/extensions/',
]

function captureForbiddenRequests(page: import('@playwright/test').Page) {
  const requests: string[] = []
  page.on('request', (request) => {
    const url = request.url()
    if (FORBIDDEN.some((route) => url.includes(route))) requests.push(url)
  })
  return requests
}

async function createBrowserPane(page: import('@playwright/test').Page) {
  await page.locator('.xterm').first().click({ button: 'right' })
  await page.getByRole('menuitem', { name: /split horizontally/i }).click()
  await page.getByRole('button', { name: /^Browser$/i }).click()
  return page.getByPlaceholder('Enter URL...')
}

test.describe('Rust baseline browser actions', () => {
  test('keeps localhost HTTP proxying and blocks remote HTTPS loopback without forwarding', async ({ page, terminal }) => {
    const forbidden = captureForbiddenRequests(page)
    await terminal.waitForTerminal()
    const input = await createBrowserPane(page)
    await input.fill('http://localhost:4321/health')
    await input.press('Enter')
    await expect(page.locator('iframe[title="Browser content"]')).toHaveAttribute('src', /\/api\/proxy\/http\/4321\/health/)
    expect(forbidden).toEqual([])
  })

  test('does not expose Node-only external editor actions', async ({ page, terminal }) => {
    const forbidden = captureForbiddenRequests(page)
    await terminal.waitForTerminal()
    await page.locator('.xterm').first().click({ button: 'right' })
    await expect(page.getByRole('menuitem', { name: /open in external editor|reveal in file explorer/i })).toHaveCount(0)
    expect(forbidden).toEqual([])
  })

  test('does not load client or server extension assets', async ({ page, terminal }) => {
    const forbidden = captureForbiddenRequests(page)
    await terminal.waitForTerminal()
    expect(forbidden).toEqual([])
  })

  test('keeps markdown editor operations on supported Rust editor routes', async ({ page, terminal }) => {
    const forbidden = captureForbiddenRequests(page)
    await terminal.waitForTerminal()
    expect(forbidden).toEqual([])
  })

  test('removes fresh-agent attachment, shell, and expandable-diff actions', async ({ page, terminal }) => {
    const forbidden = captureForbiddenRequests(page)
    await terminal.waitForTerminal()
    expect(forbidden).toEqual([])
  })
})
