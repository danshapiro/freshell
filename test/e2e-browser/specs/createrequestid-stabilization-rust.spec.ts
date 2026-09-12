/**
 * Lane A1 (P1.6, restart-resilience campaign): createRequestId key
 * stabilization. Rust-only: the mint under test lives in the Rust REST
 * ingress (crates/freshell-freshagent spawn_terminal_pane).
 *
 * Proves, end to end:
 *  1. A pane created via POST /api/tabs carries a SERVER-minted
 *     createRequestId (32-hex Uuid::simple — a client-side fallback mint
 *     would be a 21-char nanoid, so the format assertion discriminates).
 *  2. A full page reload hydrates the SAME createRequestId (no re-mint).
 */
import os from 'node:os'
import { test as base, expect } from '../helpers/fixtures.js'
import { TestHarness } from '../helpers/test-harness.js'

const test = base

function unwrapData(body: any): any {
  return body && typeof body === 'object' && 'data' in body ? body.data : body
}

async function createTab(
  baseUrl: string,
  token: string,
  payload: Record<string, unknown>,
): Promise<{ status: number; tabId?: string; paneId?: string; body: any }> {
  const res = await fetch(`${baseUrl}/api/tabs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-auth-token': token },
    body: JSON.stringify(payload),
  })
  const rawBody = await res.json().catch(() => undefined)
  const data = unwrapData(rawBody) as { tabId?: string; paneId?: string } | undefined
  return { status: res.status, tabId: data?.tabId, paneId: data?.paneId, body: rawBody }
}

function collectTerminalCreateRequestIds(node: any, out: string[] = []): string[] {
  if (!node) return out
  if (node.type === 'leaf') {
    if (node.content?.kind === 'terminal' && typeof node.content.createRequestId === 'string') {
      out.push(node.content.createRequestId)
    }
    return out
  }
  collectTerminalCreateRequestIds(node.children?.[0], out)
  collectTerminalCreateRequestIds(node.children?.[1], out)
  return out
}

test.describe('createRequestId stabilization (rust REST ingress + reload)', () => {
  test('REST-created terminal pane carries a server-minted createRequestId', async ({ page, serverInfo }) => {
    const { baseUrl, token } = serverInfo

    // Connect the browser FIRST: the server broadcasts ui.command{tab.create}
    // over the live WS connection when a tab is created via REST.
    await page.goto(`${baseUrl}/?token=${token}&e2e=1`)
    const harness = new TestHarness(page)
    await harness.waitForHarness()
    await harness.waitForConnection()

    const created = await createTab(baseUrl, token, {
      mode: 'shell', cwd: os.tmpdir(), name: 'crid-rest-tab',
    })
    expect(created.status, `POST /api/tabs failed: ${JSON.stringify(created.body)}`).toBe(200)
    expect(created.tabId).toBeTruthy()

    await expect
      .poll(async () => collectTerminalCreateRequestIds(await harness.getPaneLayout(created.tabId!)), {
        timeout: 15_000,
      })
      .toHaveLength(1)

    const [key] = collectTerminalCreateRequestIds(await harness.getPaneLayout(created.tabId!))
    // 32 lowercase hex = Uuid::new_v4().simple() minted by the Rust REST
    // ingress; a 21-char nanoid here would mean the client minted a fallback
    // key because the server sent none.
    expect(key).toMatch(/^[0-9a-f]{32}$/)
  })

  test('page reload hydrates the same createRequestId for the pane', async ({ page, serverInfo }) => {
    const { baseUrl, token } = serverInfo

    await page.goto(`${baseUrl}/?token=${token}&e2e=1`)
    const harness = new TestHarness(page)
    await harness.waitForHarness()
    await harness.waitForConnection()

    const created = await createTab(baseUrl, token, {
      mode: 'shell', cwd: os.tmpdir(), name: 'crid-reload-tab',
    })
    expect(created.status).toBe(200)
    expect(created.tabId).toBeTruthy()

    await expect
      .poll(async () => collectTerminalCreateRequestIds(await harness.getPaneLayout(created.tabId!)), {
        timeout: 15_000,
      })
      .toHaveLength(1)
    const [keyBefore] = collectTerminalCreateRequestIds(await harness.getPaneLayout(created.tabId!))
    expect(keyBefore).toMatch(/^[0-9a-f]{32}$/)

    // Defeat the persist debounce before reloading (house pattern).
    await page.evaluate(() => {
      (window as any).__FRESHELL_TEST_HARNESS__?.dispatch({ type: 'persist/flushNow' })
    })
    const layoutRaw = await page.evaluate(() => localStorage.getItem('freshell.layout.v3'))
    expect(layoutRaw, 'layout must be persisted before reload').toBeTruthy()
    expect(layoutRaw).toContain(keyBefore)

    await page.reload({ waitUntil: 'domcontentloaded' })
    await harness.waitForHarness()
    await harness.waitForConnection()

    await expect
      .poll(async () => collectTerminalCreateRequestIds(await harness.getPaneLayout(created.tabId!)), {
        timeout: 15_000,
      })
      .toHaveLength(1)
    const [keyAfter] = collectTerminalCreateRequestIds(await harness.getPaneLayout(created.tabId!))
    expect(keyAfter, 'reload must hydrate the SAME pane identity key, not re-mint').toBe(keyBefore)
  })
})
