/** Attention missed by this page replays once on reconnect, never on reload.
 * The production sidecar runs over the CLI simulator. A second socket drives
 * a turn only after the browser socket is offline, so no timer races decide
 * whether the browser witnessed the ending. */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import type { WebSocketRoute } from '@playwright/test'
import { test, expect } from '../helpers/fixtures.js'
import { RustServer } from '../helpers/rust-server.js'
import { TestHarness } from '../helpers/test-harness.js'
import { openPanePicker } from '../helpers/pane-picker.js'
import { WS_PROTOCOL_VERSION } from '../../../shared/ws-protocol.js'

const directory = path.dirname(fileURLToPath(import.meta.url))
const sidecar = path.resolve(directory, '../../../crates/freshell-claude-sidecar/index.mjs')
const simulator = path.resolve(directory, '../../fixtures/claude-cli-sim/query.mjs')

function freshLeaf(node: any): any {
  if (node?.type === 'leaf' && node.content?.kind === 'fresh-agent') return node
  for (const child of node?.children ?? []) {
    const leaf = freshLeaf(child)
    if (leaf) return leaf
  }
  return undefined
}

async function sendFromAnotherConnection(baseUrl: string, token: string, sessionId: string, sessionType: string): Promise<void> {
  const socket = new WebSocket(`${baseUrl.replace(/^http/, 'ws')}/ws`)
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('The second connection never received the turn completion')), 30_000)
      const finish = (error?: Error) => {
        clearTimeout(timer)
        if (error) reject(error)
        else resolve()
      }
      socket.on('error', finish)
      socket.on('open', () => socket.send(JSON.stringify({ type: 'hello', token, protocolVersion: WS_PROTOCOL_VERSION })))
      socket.on('message', (raw) => {
        const frame = JSON.parse(raw.toString())
        if (frame.type === 'ready') socket.send(JSON.stringify({
          type: 'freshAgent.send', provider: 'claude', sessionType, sessionId,
          requestId: 'offline-turn', text: 'finish while the browser is offline',
        }))
        if (frame.type === 'error' && frame.requestId === 'offline-turn') finish(new Error(JSON.stringify(frame)))
        if (frame.type === 'freshAgent.event' && frame.sessionId === sessionId) {
          if (frame.event?.type === 'freshAgent.error') finish(new Error(JSON.stringify(frame)))
          if (frame.event?.type === 'freshAgent.turn.complete') finish()
        }
      })
    })
  } finally {
    socket.close()
  }
}

for (const flavour of ['freshclaude', 'kilroy'] as const) {
  test(`${flavour}: reconnect replays missed attention once and reload seeds silently`, async ({ page }) => {
    test.setTimeout(120_000)
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-attention-reconnect-'))
    const project = path.join(root, 'project')
    await fs.mkdir(project)
    const server = new RustServer({
      env: {
        FRESHELL_CLAUDE_SIDECAR: sidecar,
        FRESHELL_CLAUDE_NODE: process.execPath,
        FRESHELL_CLAUDE_SDK_QUERY_MODULE: simulator,
        // Kilroy is hidden unless its server-side feature flag is enabled.
        ...(flavour === 'kilroy' ? { KILROY_ENABLED: '1' } : {}),
      },
      setupHome: async (home) => {
        await fs.mkdir(path.join(home, '.freshell'), { recursive: true })
        await fs.writeFile(path.join(home, '.freshell', 'config.json'), JSON.stringify({
          version: 1, settings: { codingCli: { enabledProviders: ['claude'] }, freshAgent: { enabled: true } },
        }))
      },
    })
    let blocked = false
    let readyFrames = 0
    const liveSockets: WebSocketRoute[] = []
    const blockedSockets: WebSocketRoute[] = []
    await page.context().routeWebSocket((url) => url.pathname === '/ws', (client) => {
      if (blocked) {
        blockedSockets.push(client)
        return
      }
      const upstream = client.connectToServer()
      liveSockets.push(client)
      client.onMessage((message) => upstream.send(message))
      upstream.onMessage((message) => {
        if (typeof message === 'string' && JSON.parse(message).type === 'ready') readyFrames += 1
        client.send(message)
      })
      client.onClose((code, reason) => void upstream.close({ code, reason }).catch(() => {}))
      upstream.onClose((code, reason) => void client.close({ code, reason }).catch(() => {}))
    })
    try {
      const info = await server.start()
      await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
      const harness = new TestHarness(page)
      await harness.waitForHarness()
      await harness.waitForConnection()
      const shellPicker = page.getByRole('toolbar', { name: /pane type picker/i }).last()
      if (await shellPicker.isVisible().catch(() => false)) {
        await shellPicker.getByRole('button', { name: /^(Shell|Bash|WSL|CMD|PowerShell)$/i }).first().click()
      }
      // The boot picker remains mounted while it fades out. Wait for the
      // selected shell to render before openPanePicker looks for an existing
      // picker, or it can return the fading boot picker and miss the click.
      await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })
      await page.evaluate(() => (window as any).__FRESHELL_TEST_HARNESS__.dispatch({
        type: 'connection/setAvailableClis', payload: { claude: true },
      }))
      const tabId = (await harness.getActiveTabId())!
      const picker = await openPanePicker(page)
      const label = flavour === 'kilroy' ? 'Kilroy' : 'Freshclaude'
      await picker.getByRole('button', { name: new RegExp(`^${label}$`) }).click({ force: true })
      const cwd = page.getByLabel(new RegExp(`^Starting directory for ${label}$`, 'i'))
      await cwd.fill(project)
      await cwd.press('Enter')
      const pane = page.locator('[data-context="fresh-agent"]').last()
      await expect(pane).toBeVisible()
      await pane.getByRole('textbox', { name: 'Chat message input' }).fill('establish the conversation')
      await pane.getByRole('button', { name: 'Send' }).click()
      const completion = async () => (await harness.getState()).turnCompletion
      await expect.poll(async () => (await completion()).seq, { timeout: 30_000 }).toBe(1)
      const leaf = freshLeaf(await harness.getPaneLayout(tabId))
      const { sessionId, sessionRef } = leaf.content
      expect(sessionId).toBeTruthy()
      expect(sessionRef?.sessionId).toBeTruthy()
      await page.getByRole('button', { name: 'New shell tab' }).click()
      await harness.waitForTabCount(2)
      expect(await harness.getActiveTabId()).not.toBe(tabId)

      blocked = true
      for (const socket of liveSockets.splice(0)) await socket.close({ code: 1012, reason: 'Test offline' })
      await expect.poll(async () => (await harness.getState()).connection.status).not.toBe('ready')
      await sendFromAnotherConnection(info.baseUrl, info.token, sessionId, flavour)
      expect((await completion()).seq).toBe(1)
      expect((await completion()).attentionByTab[tabId]).toBeUndefined()

      const beforeReady = readyFrames
      blocked = false
      for (const socket of blockedSockets.splice(0)) await socket.close({ code: 1012, reason: 'Test reconnect' })
      await expect.poll(() => readyFrames, { timeout: 30_000 }).toBeGreaterThan(beforeReady)
      await harness.waitForConnection()
      await expect.poll(async () => (await completion()).seq).toBe(2)
      expect((await completion()).attentionByTab[tabId]).toBe(true)
      expect((await completion()).attentionByPane[leaf.id]).toBe(true)
      await expect(page.locator(`[data-context="tab"][data-tab-id="${tabId}"]`)).toHaveClass(/bg-emerald-100/)
      await expect(page.getByTestId('sidebar-session-list').locator(`[data-session-id="${sessionRef.sessionId}"][data-provider="claude"]`)).toHaveClass(/bg-emerald-50|border-l-emerald-500/)

      await harness.forceDisconnect()
      await harness.waitForConnection()
      const reconnectState = await completion()
      const received = await harness.getReceivedWsMessages() as Array<Record<string, any>>
      const evidence = {
        seq: reconnectState.seq,
        freshAgentBaselines: reconnectState.lastAtByTerminalId,
        terminalIdleBaselines: reconnectState.lastIdleAtByTerminalId,
        pendingEvents: reconnectState.pendingEvents,
        turnEdges: received
          .filter((message) => message.type === 'freshAgent.event'
            && message.event?.type === 'freshAgent.turn.complete')
          .map((message) => ({ sessionId: message.sessionId, event: message.event })),
        readyAttention: received
          .filter((message) => message.type === 'ready')
          .map((message) => message.freshAgentAttention),
        terminalIdle: received
          .filter((message) => message.type === 'terminal.idle')
          .map((message) => ({ terminalId: message.terminalId, at: message.at, reason: message.reason })),
      }
      expect(reconnectState.seq, JSON.stringify(evidence)).toBe(2)
      await page.reload()
      await harness.waitForHarness()
      await harness.waitForConnection()
      expect((await completion()).seq).toBe(0)
      expect((await completion()).attentionByTab[tabId]).toBeUndefined()
    } finally {
      await server.stop()
      await fs.rm(root, { recursive: true, force: true })
    }
  })
}
