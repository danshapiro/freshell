import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import { test, expect } from '../helpers/fixtures.js'
import { createE2eServerHandle } from '../helpers/external-target.js'
import { TestHarness } from '../helpers/test-harness.js'
import { openPanePicker } from '../helpers/pane-picker.js'

/**
 * TERM-15 + TERM-16 (Rust) — terminal-mode CLI activity, server-authoritative
 * turn completion, and the NEW `terminal.idle` truly-idle edge.
 *
 * Rust-only (`playwright.config.ts` registers this under `rust-chromium`):
 * this is the Rust port's implementation of the legacy activity engine; the
 * frozen legacy server has its own (this branch's `server/` predates the
 * amplifier provider entirely — same KNOWN DIVERGENCE as
 * `amplifier-restore-rust.spec.ts`).
 *
 * What each scenario proves, from RAW recorded WS frames (a second,
 * node-side capture socket — real emitted frames, not injected state) AND
 * the pane/tab blue chrome the frozen client derives from them:
 *
 * 1. claude (PTY lane): submit → `claude.activity.updated` busy upsert →
 *    tab icon blue; the fake CLI's turn-complete BEL → idle upsert → blue
 *    clears; exactly ONE `terminal.turn.complete` (provider `claude`,
 *    completionSeq 1); then exactly ONE `terminal.idle` (reason `grace`).
 *    Reload during a slow busy turn: after reconnect the blue re-seeds from
 *    the `claude.activity.list.response`; the later completion carries
 *    completionSeq 2 (the monotonic per-terminal seq that makes the client's
 *    reconnect dedupe possible).
 * 2. codex (PTY lane): submit → `codex.activity.updated` `pending` upsert
 *    (rendered blue by the frozen client — decision 5A) → BEL → idle + one
 *    completion + one `terminal.idle`.
 * 3. amplifier (events.jsonl lane): the fake CLI writes schema-carrying
 *    lifecycle records; the association attaches the inotify tailer; a
 *    `prompt:complete` record broadcasts idle + `terminal.turn.complete`
 *    (provider `amplifier`) + `terminal.idle`.
 */

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const FAKE_BEL_CLI = path.resolve(__dirname, '../fixtures/fake-bel-cli.mjs')
const FAKE_AMPLIFIER_CLI = path.resolve(__dirname, '../fixtures/fake-amplifier-activity-cli.mjs')

async function installFakeCli(binDir: string, name: string, source: string): Promise<string> {
  await fs.mkdir(binDir, { recursive: true })
  const target = path.join(binDir, name)
  await fs.copyFile(source, target)
  await fs.chmod(target, 0o755)
  return target
}

/**
 * A raw, node-side WS capture client: performs the real hello handshake and
 * records every server frame, so assertions run against the ACTUAL emitted
 * bytes (same approach as `term28-path-shadow-rust.spec.ts`'s raw client).
 */
class WsCapture {
  private ws: WebSocket
  readonly frames: any[] = []
  private opened: Promise<void>

  constructor(baseUrl: string, token: string) {
    const wsUrl = `${baseUrl.replace(/^http/, 'ws')}/ws`
    this.ws = new WebSocket(wsUrl)
    this.opened = new Promise((resolve, reject) => {
      this.ws.on('open', () => {
        this.ws.send(JSON.stringify({ type: 'hello', protocolVersion: 7, token }))
        resolve()
      })
      this.ws.on('error', reject)
    })
    this.ws.on('message', (data) => {
      try {
        this.frames.push(JSON.parse(String(data)))
      } catch {
        // non-JSON frames are not part of this protocol; ignore
      }
    })
  }

  async ready(): Promise<void> {
    await this.opened
    await this.waitFor((f) => f.type === 'ready', 10_000, 'ready')
  }

  async waitFor(pred: (frame: any) => boolean, timeoutMs: number, label: string): Promise<any> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const hit = this.frames.find(pred)
      if (hit) return hit
      await new Promise((r) => setTimeout(r, 100))
    }
    throw new Error(`WsCapture: timed out waiting for ${label}`)
  }

  count(pred: (frame: any) => boolean): number {
    return this.frames.filter(pred).length
  }

  close(): void {
    try {
      this.ws.close()
    } catch {
      // already closed
    }
  }
}

async function selectShellIfPickerShowing(page: import('@playwright/test').Page): Promise<void> {
  await page.waitForTimeout(500)
  const xtermVisible = await page.locator('.xterm').first().isVisible().catch(() => false)
  if (xtermVisible) return
  const shellNames = ['Shell', 'WSL', 'CMD', 'PowerShell', 'Bash']
  for (const name of shellNames) {
    try {
      await page.getByRole('button', { name: new RegExp(`^${name}$`, 'i') }).click({ timeout: 5_000 })
      await page.locator('.xterm').first().waitFor({ state: 'visible', timeout: 15_000 })
      return
    } catch {
      continue
    }
  }
}

async function bootAndConnect(
  page: import('@playwright/test').Page,
  info: { baseUrl: string; token: string },
): Promise<TestHarness> {
  await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
  const harness = new TestHarness(page)
  await harness.waitForHarness()
  await harness.waitForConnection()
  await selectShellIfPickerShowing(page)
  return harness
}

/** Open a new CLI pane via the picker (same flow as amplifier-restore-rust). */
async function openCliPane(page: import('@playwright/test').Page, buttonName: RegExp): Promise<void> {
  const picker = await openPanePicker(page)
  await picker.getByRole('button', { name: buttonName }).click({ force: true })
  await page.getByRole('combobox', { name: /Starting directory/i }).press('Enter')
}

function collectLeaves(node: any): any[] {
  if (!node) return []
  if (node.type === 'leaf') return [node]
  if (node.type === 'split') return (node.children ?? []).flatMap(collectLeaves)
  return []
}

async function openCliPaneAndGetTerminalId(
  page: import('@playwright/test').Page,
  harness: TestHarness,
  tabId: string,
  buttonName: RegExp,
  mode: string,
): Promise<string> {
  const before = collectLeaves(await harness.getPaneLayout(tabId))
    .filter((leaf) => leaf?.content?.mode === mode)
  const beforeIds = new Set(before.map((leaf) => leaf.id))
  await openCliPane(page, buttonName)
  await expect(page.locator('.xterm').last()).toBeVisible({ timeout: 15_000 })
  await expect.poll(async () => {
    const layout = await harness.getPaneLayout(tabId)
    const leaf = collectLeaves(layout)
      .find((l) => l?.content?.mode === mode && !beforeIds.has(l.id) && l?.content?.terminalId)
    return leaf?.content?.terminalId ?? null
  }, { timeout: 15_000 }).not.toBeNull()
  const layout = await harness.getPaneLayout(tabId)
  const leaf = collectLeaves(layout)
    .find((l) => l?.content?.mode === mode && !beforeIds.has(l.id) && l?.content?.terminalId)
  return leaf.content.terminalId as string
}

/**
 * The blue pane icons inside a tab strip item. With `iconsOnTabs`, a split
 * tab renders ONE icon PER pane (`TabItem.renderIcons()`), so "the tab shows
 * blue" means "at least one pane icon in the tab carries text-blue-500" —
 * asserting on `.first()` would pin the sibling shell pane's icon instead.
 */
function tabBlueIcons(page: import('@playwright/test').Page, tabId: string) {
  return page.locator(`[data-context="tab"][data-tab-id="${tabId}"] svg.text-blue-500`)
}

async function typePromptIntoLastPane(page: import('@playwright/test').Page, text: string): Promise<void> {
  await page.locator('.xterm').last().click()
  await page.keyboard.type(text)
  await page.keyboard.press('Enter')
}

test.describe('Terminal-mode CLI activity (Rust only)', () => {
  test.setTimeout(180_000)

  test('claude PTY lane: busy blue, one turn.complete, one terminal.idle, reload re-seeds', async ({ page, e2eServerKind }) => {
    expect(e2eServerKind).toBe('rust')

    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-activity-claude-'))
    const fakeClaude = await installFakeCli(path.join(sharedRoot, 'bin'), 'claude', FAKE_BEL_CLI)
    const server = await createE2eServerHandle(process.env, {
      kind: e2eServerKind,
      construct: {
        env: { CLAUDE_CMD: fakeClaude },
        setupHome: async (homeDir) => {
          const freshellDir = path.join(homeDir, '.freshell')
          await fs.mkdir(freshellDir, { recursive: true })
          await fs.writeFile(path.join(freshellDir, 'config.json'), JSON.stringify({
            version: 1,
            settings: { codingCli: { enabledProviders: ['claude'] } },
          }, null, 2))
        },
      },
    })
    const info = await server.start()
    const capture = new WsCapture(info.baseUrl, info.token)
    try {
      await capture.ready()
      const harness = await bootAndConnect(page, info)
      await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })
      const tabId = await harness.getActiveTabId()
      expect(tabId).toBeTruthy()

      const terminalId = await openCliPaneAndGetTerminalId(page, harness, tabId!, /Claude/i, 'claude')
      await expect.poll(async () => {
        const buffer = await harness.getTerminalBuffer(terminalId)
        return typeof buffer === 'string' && buffer.includes('fake-cli>')
      }, { timeout: 15_000 }).toBe(true)

      // ── Turn 1: submit → busy (blue), BEL → idle, ONE completion, ONE idle edge.
      await typePromptIntoLastPane(page, 'slow first prompt')

      const busyFrame = await capture.waitFor(
        (f) => f.type === 'claude.activity.updated'
          && f.upsert?.some((r: any) => r.terminalId === terminalId && r.phase === 'busy'),
        10_000,
        'claude busy upsert',
      )
      expect(busyFrame.upsert[0].terminalId).toBe(terminalId)
      // The frozen client renders that exact frame as blue chrome. (The
      // prompt asked for a 6s "slow" turn so the busy window is stable to
      // observe — a sub-second turn can complete between DOM polls.)
      await expect(tabBlueIcons(page, tabId!)).not.toHaveCount(0, { timeout: 10_000 })

      await capture.waitFor(
        (f) => f.type === 'claude.activity.updated'
          && f.upsert?.some((r: any) => r.terminalId === terminalId && r.phase === 'idle'),
        15_000,
        'claude idle upsert (BEL)',
      )
      await expect(tabBlueIcons(page, tabId!)).toHaveCount(0, { timeout: 10_000 })

      const complete1 = await capture.waitFor(
        (f) => f.type === 'terminal.turn.complete' && f.terminalId === terminalId,
        10_000,
        'terminal.turn.complete #1',
      )
      expect(complete1.provider).toBe('claude')
      expect(complete1.completionSeq).toBe(1)

      const idleEdge = await capture.waitFor(
        (f) => f.type === 'terminal.idle' && f.terminalId === terminalId,
        10_000,
        'terminal.idle',
      )
      expect(idleEdge.reason).toBe('grace')
      expect(typeof idleEdge.at).toBe('number')

      // Exactly ONE of each — no duplicates for a single positive turn end.
      await page.waitForTimeout(1_000)
      expect(capture.count((f) => f.type === 'terminal.turn.complete' && f.terminalId === terminalId)).toBe(1)
      expect(capture.count((f) => f.type === 'terminal.idle' && f.terminalId === terminalId)).toBe(1)

      // ── Turn 2 (slow): reload mid-turn — the blue must RE-SEED from the
      // activity-list response, and the eventual completion carries seq 2.
      await typePromptIntoLastPane(page, 'slow prompt please')
      await capture.waitFor(
        (f) => f.type === 'claude.activity.updated'
          && f.upsert?.some((r: any) => r.terminalId === terminalId && r.phase === 'busy'),
        10_000,
        'claude busy upsert (slow turn)',
      )
      await page.reload()
      const harness2 = new TestHarness(page)
      await harness2.waitForHarness()
      await harness2.waitForConnection()
      // Re-seeded blue, from claude.activity.list.response — the turn is
      // still running server-side (6s fake turn).
      await expect(tabBlueIcons(page, tabId!)).not.toHaveCount(0, { timeout: 10_000 })

      const complete2 = await capture.waitFor(
        (f) => f.type === 'terminal.turn.complete' && f.terminalId === terminalId && f.completionSeq === 2,
        20_000,
        'terminal.turn.complete #2 (seq 2 after reload)',
      )
      expect(complete2.provider).toBe('claude')
      await expect(tabBlueIcons(page, tabId!)).toHaveCount(0, { timeout: 10_000 })
    } finally {
      capture.close()
      await server.stop().catch(() => {})
      await fs.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })

  test('codex PTY lane: pending blue, BEL completes once, terminal.idle follows', async ({ page, e2eServerKind }) => {
    expect(e2eServerKind).toBe('rust')

    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-activity-codex-'))
    const fakeCodex = await installFakeCli(path.join(sharedRoot, 'bin'), 'codex', FAKE_BEL_CLI)
    const server = await createE2eServerHandle(process.env, {
      kind: e2eServerKind,
      construct: {
        env: { CODEX_CMD: fakeCodex },
        setupHome: async (homeDir) => {
          const freshellDir = path.join(homeDir, '.freshell')
          await fs.mkdir(freshellDir, { recursive: true })
          await fs.writeFile(path.join(freshellDir, 'config.json'), JSON.stringify({
            version: 1,
            settings: { codingCli: { enabledProviders: ['codex'] } },
          }, null, 2))
        },
      },
    })
    const info = await server.start()
    const capture = new WsCapture(info.baseUrl, info.token)
    try {
      await capture.ready()
      const harness = await bootAndConnect(page, info)
      await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })
      const tabId = await harness.getActiveTabId()
      expect(tabId).toBeTruthy()

      const terminalId = await openCliPaneAndGetTerminalId(page, harness, tabId!, /Codex/i, 'codex')
      await expect.poll(async () => {
        const buffer = await harness.getTerminalBuffer(terminalId)
        return typeof buffer === 'string' && buffer.includes('fake-cli>')
      }, { timeout: 15_000 }).toBe(true)

      await typePromptIntoLastPane(page, 'slow thing please')

      // The codex PTY lane enters `pending` — which the frozen client
      // renders blue (decision 5A, `src/lib/pane-activity.ts`).
      await capture.waitFor(
        (f) => f.type === 'codex.activity.updated'
          && f.upsert?.some((r: any) => r.terminalId === terminalId && r.phase === 'pending'),
        10_000,
        'codex pending upsert',
      )
      await expect(tabBlueIcons(page, tabId!)).not.toHaveCount(0, { timeout: 10_000 })

      await capture.waitFor(
        (f) => f.type === 'codex.activity.updated'
          && f.upsert?.some((r: any) => r.terminalId === terminalId && r.phase === 'idle'),
        15_000,
        'codex idle upsert (BEL)',
      )
      await expect(tabBlueIcons(page, tabId!)).toHaveCount(0, { timeout: 10_000 })

      const complete = await capture.waitFor(
        (f) => f.type === 'terminal.turn.complete' && f.terminalId === terminalId,
        10_000,
        'codex terminal.turn.complete',
      )
      expect(complete.provider).toBe('codex')
      expect(complete.completionSeq).toBe(1)

      const idleEdge = await capture.waitFor(
        (f) => f.type === 'terminal.idle' && f.terminalId === terminalId,
        10_000,
        'codex terminal.idle',
      )
      expect(idleEdge.reason).toBe('grace')

      await page.waitForTimeout(1_000)
      expect(capture.count((f) => f.type === 'terminal.turn.complete' && f.terminalId === terminalId)).toBe(1)
      expect(capture.count((f) => f.type === 'terminal.idle' && f.terminalId === terminalId)).toBe(1)
    } finally {
      capture.close()
      await server.stop().catch(() => {})
      await fs.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })

  test('amplifier events lane: busy from prompt:submit, complete + idle from prompt:complete', async ({ page, e2eServerKind }) => {
    expect(e2eServerKind).toBe('rust')

    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-activity-amp-'))
    const fakeAmplifier = await installFakeCli(path.join(sharedRoot, 'bin'), 'amplifier', FAKE_AMPLIFIER_CLI)
    const server = await createE2eServerHandle(process.env, {
      kind: e2eServerKind,
      construct: {
        // 15s fake turn: long enough that the locator association (sweep-
        // driven, a few seconds) lands and the events lane confirms busy
        // while the turn is provably still running.
        env: { AMPLIFIER_CMD: fakeAmplifier, FAKE_AMPLIFIER_TURN_MS: '15000' },
        setupHome: async (homeDir) => {
          const freshellDir = path.join(homeDir, '.freshell')
          await fs.mkdir(freshellDir, { recursive: true })
          await fs.writeFile(path.join(freshellDir, 'config.json'), JSON.stringify({
            version: 1,
            settings: { codingCli: { enabledProviders: ['amplifier'] } },
          }, null, 2))
        },
      },
    })
    const info = await server.start()
    const capture = new WsCapture(info.baseUrl, info.token)
    try {
      await capture.ready()
      const harness = await bootAndConnect(page, info)
      await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })
      const tabId = await harness.getActiveTabId()
      expect(tabId).toBeTruthy()

      const terminalId = await openCliPaneAndGetTerminalId(page, harness, tabId!, /Amplifier/i, 'amplifier')
      await expect.poll(async () => {
        const buffer = await harness.getTerminalBuffer(terminalId)
        return typeof buffer === 'string' && buffer.includes('amplifier>')
      }, { timeout: 15_000 }).toBe(true)

      await typePromptIntoLastPane(page, 'hello amplifier')

      // Provisional busy from the PTY Enter (blue immediately)…
      await capture.waitFor(
        (f) => f.type === 'amplifier.activity.updated'
          && f.upsert?.some((r: any) => r.terminalId === terminalId && r.phase === 'busy'),
        10_000,
        'amplifier busy upsert',
      )
      await expect(tabBlueIcons(page, tabId!)).not.toHaveCount(0, { timeout: 10_000 })

      // …then the events lane finishes the turn: the locator associates the
      // session (sweep-driven, a few seconds), the tailer attaches, and the
      // fixture's prompt:complete record produces idle + the completion.
      const complete = await capture.waitFor(
        (f) => f.type === 'terminal.turn.complete' && f.terminalId === terminalId,
        45_000,
        'amplifier terminal.turn.complete',
      )
      expect(complete.provider).toBe('amplifier')
      expect(complete.completionSeq).toBe(1)
      expect(String(complete.sessionId ?? '')).toMatch(/^fake-amp-/)

      await expect(tabBlueIcons(page, tabId!)).toHaveCount(0, { timeout: 10_000 })

      const idleEdge = await capture.waitFor(
        (f) => f.type === 'terminal.idle' && f.terminalId === terminalId,
        10_000,
        'amplifier terminal.idle',
      )
      expect(idleEdge.reason).toBe('grace')

      await page.waitForTimeout(1_000)
      expect(capture.count((f) => f.type === 'terminal.turn.complete' && f.terminalId === terminalId)).toBe(1)
      expect(capture.count((f) => f.type === 'terminal.idle' && f.terminalId === terminalId)).toBe(1)
    } finally {
      capture.close()
      await server.stop().catch(() => {})
      await fs.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })
})
