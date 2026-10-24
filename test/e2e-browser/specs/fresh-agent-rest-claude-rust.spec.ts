import type { Browser } from '@playwright/test'
import { test, expect } from '../helpers/fixtures.js'
import { ClaudeSimLane, onPrompt } from '../helpers/claude-sim-lane.js'
import { ensureMcpServerBuilt, McpStdioClient, REPO_ROOT } from '../helpers/mcp-stdio-client.js'

const PROMPT = 'hello from the external MCP client'
const REPLY = 'REST-created Freshclaude reply'
const UI_PROMPT = 'hello to the browser-created pane'
const UI_REPLY = 'Browser-created pane received the MCP prompt'

async function withLane(browser: Browser, body: (lane: ClaudeSimLane, mcp: McpStdioClient) => Promise<void>) {
  const mcpPath = ensureMcpServerBuilt(REPO_ROOT).path
  const lane = await ClaudeSimLane.start(browser, {
    flavour: 'freshclaude', env: { KILROY_ENABLED: '1' },
    program: { rules: [
      onPrompt(PROMPT, [{ kind: 'text', delayMs: 300, data: { text: REPLY } }]),
      onPrompt(UI_PROMPT, [{ kind: 'text', data: { text: UI_REPLY } }]),
      onPrompt('kilroy hello', [{ kind: 'text', data: { text: 'Kilroy REST reply' } }]),
    ] },
  })
  const mcp = new McpStdioClient({
    command: process.execPath,
    args: [mcpPath],
    env: { ...process.env, FRESHELL_URL: lane.info.baseUrl, FRESHELL_TOKEN: lane.info.token },
    requestTimeoutMs: 60_000,
  })
  try {
    await mcp.initialize()
    await body(lane, mcp)
  } finally {
    await lane.attachLogsOnFailure(test.info())
    await mcp.close()
    await lane.stop()
  }
}

function leaf(node: any, id: string): any {
  if (node?.type === 'leaf') return node.id === id ? node : undefined
  return (node?.children ?? []).map((child: any) => leaf(child, id)).find(Boolean)
}

test.describe('external REST/MCP controls the shared Claude runtime', () => {
  test.setTimeout(180_000)

  test('MCP creates and prompts a background Freshclaude tab once, captures it, splits Kilroy, and captures after restart', async ({ browser }) => {
    await withLane(browser, async (lane, mcp) => {
      const { page, harness } = lane
      const originalTab = await harness.getActiveTabId()
      // Observe the production notification's audio boundary. End the test
      // device's sound immediately so another ring cannot hide in its queue.
      await page.evaluate(() => {
        const browserWindow = window as typeof window & { __restNotificationPlays?: number }
        browserWindow.__restNotificationPlays = 0
        const play = HTMLMediaElement.prototype.play
        HTMLMediaElement.prototype.play = function () {
          if (this.src.endsWith('/your-code-is-ready.mp3')) {
            browserWindow.__restNotificationPlays! += 1
            queueMicrotask(() => this.dispatchEvent(new Event('ended')))
            return Promise.resolve()
          }
          return play.call(this)
        }
      })
      const created = await mcp.callFreshellAction('new-tab', { agent: 'claude', cwd: lane.workspace, prompt: PROMPT })
      expect(created.status).toBe('ok')
      const { tabId, paneId, sessionId } = created.data
      await expect.poll(() => harness.getPaneLayout(tabId), { timeout: 20_000 }).not.toBeNull()
      expect(await harness.getActiveTabId()).toBe(originalTab)
      await expect.poll(async () => (await harness.getState()).turnCompletion?.attentionByTab?.[tabId] ?? false, { timeout: 20_000 }).toBe(true)
      await expect.poll(() => page.evaluate(() => (window as typeof window & { __restNotificationPlays?: number }).__restNotificationPlays ?? 0), { timeout: 10_000 }).toBe(1)
      expect(lane.ledger().filter((row) => row.kind === 'boot' && row.sessionId === sessionId)).toHaveLength(1)
      await expect.poll(() => mcp.callFreshellAction('capture-pane', { target: paneId }), {
        timeout: 20_000, message: 'the CLI flushed the settled turn to saved history',
      }).toContain(REPLY)
      const captured = await mcp.callFreshellAction('capture-pane', { target: paneId })
      expect(captured).toContain(`user: ${PROMPT}`)
      expect(captured).toContain(`assistant: ${REPLY}`)
      await mcp.callFreshellAction('select-tab', { target: tabId })
      await expect(page.locator(`[data-context="fresh-agent"][data-pane-id="${paneId}"]`)).toBeVisible()
      await expect(page.locator(`[data-context="fresh-agent"][data-pane-id="${paneId}"]`)).toContainText(REPLY)
      expect(await page.evaluate(() => (window as typeof window & { __restNotificationPlays?: number }).__restNotificationPlays)).toBe(1)

      const split = await mcp.callFreshellAction('split-pane', { target: paneId, agent: 'kilroy', cwd: lane.workspace, direction: 'vertical' })
      expect(split.status).toBe('ok')
      const splitId = split.data.paneId
      await expect.poll(async () => leaf(await harness.getPaneLayout(tabId), splitId)?.content?.sessionType, { timeout: 20_000 }).toBe('kilroy')
      const kilroySend = await mcp.callFreshellAction('send-keys', { target: splitId, keys: 'kilroy hello\r', literal: true })
      expect(kilroySend.status, JSON.stringify(kilroySend)).toBe('ok')
      expect(kilroySend.data.status, JSON.stringify(kilroySend)).toBe('idle')
      await expect.poll(() => mcp.callFreshellAction('capture-pane', { target: splitId }), {
        timeout: 20_000, message: 'the externally prompted Kilroy turn reached saved history',
      }).toContain('Kilroy REST reply')
      await expect(page.locator(`[data-context="fresh-agent"][data-pane-id="${splitId}"]`)).toBeVisible()
      await expect(page.locator(`[data-context="fresh-agent"][data-pane-id="${splitId}"]`)).toContainText('Kilroy REST reply')

      // With no browser to attach or repair a REST pane row, the persisted
      // layout and durable transcript must still serve the external client.
      await lane.context.close()
      await lane.server.restart()
      const restored = await mcp.callFreshellAction('capture-pane', { target: paneId })
      expect(restored).toBe(captured)
    })
  })

  test('MCP send and capture work on a pane created through the picker', async ({ browser }) => {
    await withLane(browser, async (lane, mcp) => {
      const pane = await lane.openPane()
      await expect.poll(async () => {
        const response = await fetch(`${lane.info.baseUrl}/api/panes`, { headers: { 'x-auth-token': lane.info.token } })
        const body = await response.json()
        return JSON.stringify(body).includes(pane.paneId)
      }, { timeout: 15_000, message: 'the browser layout reached the shared server layout' }).toBe(true)
      const result = await mcp.callFreshellAction('send-keys', { target: pane.paneId, keys: `${UI_PROMPT}\r`, literal: true })
      expect(result.status).toBe('ok')
      expect(result.data.status).toBe('idle')
      await expect(pane.paneRoot).toContainText(UI_REPLY)
      await expect.poll(() => mcp.callFreshellAction('capture-pane', { target: pane.paneId }), {
        timeout: 20_000, message: 'capture reads the browser-created pane’s saved reply',
      }).toContain(UI_REPLY)
      expect(lane.ledger().filter((row) => row.kind === 'boot')).toHaveLength(1)
    })
  })
})
