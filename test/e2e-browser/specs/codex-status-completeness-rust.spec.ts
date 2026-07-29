import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import { test, expect } from '../helpers/fixtures.js'
import { createE2eServerHandle } from '../helpers/external-target.js'
import { RustServer } from '../helpers/rust-server.js'
import { TestHarness } from '../helpers/test-harness.js'
import { openPanePicker } from '../helpers/pane-picker.js'

/**
 * Codex status completeness (Rust only) — the G3 gap: a FRESH codex terminal
 * (created with no resume id) whose persisted rollout is announced by the
 * client (`terminal.codex.candidate.persisted`) must ADOPT that identity, and
 * the adoption must be observable on the wire — an identity-bearing
 * `codex.activity.updated` upsert, then a `terminal.turn.complete` frame that
 * carries the adopted `sessionId`.
 *
 * NOTE (validated scope): no Rust code emits `terminal.codex.durability.updated`
 * today, so the production client never sends this candidate frame against the
 * Rust server — the trigger chain goes live at S5. This spec's raw-WS injection
 * is the established protocol-level proof of the server-side adopt path (same
 * pattern as `crates/freshell-ws/tests/codex_candidate_persisted.rs`); it is
 * honest evidence for the SERVER half of G3-fresh, and the plan documents the
 * S5 dependency explicitly rather than claiming production-trigger coverage.
 *
 * Rust-only (`playwright.config.ts` registers this under `rust-chromium`):
 * the candidate-adopt path lives entirely in the Rust port
 * (`crates/freshell-ws/src/codex_candidate.rs` + `crates/freshell-activity`).
 */

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const FAKE_BEL_CLI = path.resolve(__dirname, '../fixtures/fake-bel-cli.mjs')

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

  send(frame: unknown): void {
    this.ws.send(JSON.stringify(frame))
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
 * The tab strip item in its working (busy) visual state. Tab icons are
 * unconditionally dark grey now, so busy is signalled structurally via the
 * `data-visual-state="working"` marker on the tab container. The attribute
 * value is conditional on busy, so both `.toHaveCount(0)` (idle) and
 * `.not.toHaveCount(0)` (busy) assertions stay meaningful.
 */
function workingTab(page: import('@playwright/test').Page, tabId: string) {
  return page.locator(`[data-context="tab"][data-tab-id="${tabId}"][data-visual-state="working"]`)
}

async function typePromptIntoLastPane(page: import('@playwright/test').Page, text: string): Promise<void> {
  await page.locator('.xterm').last().click()
  await page.keyboard.type(text)
  await page.keyboard.press('Enter')
}

const THREAD_A = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeee0001'
const SESSION_TITLE = 'Codex status completeness seeded session'

/** Write a real dated rollout owned by `sessionId` under <home>/.codex.
 * Mirrors the donor seeds (codex-terminal-bounce-rust.spec.ts:129-131,
 * sidebar-click-resume.spec.ts:174-177): the `session_meta` record carries
 * identity/cwd, and the `response_item`/`message` records exist so a REAL
 * title is extracted -- Task 9's sidebar resume gesture selects the session
 * by that title text, so these records are load-bearing, not decoration. */
async function seedRollout(
  homeDir: string,
  sessionId: string,
  extraLines: string[] = [],
): Promise<string> {
  const rolloutDir = path.join(homeDir, '.codex', 'sessions', '2026', '07', '25')
  await fs.mkdir(rolloutDir, { recursive: true })
  const rolloutPath = path.join(rolloutDir, `rollout-2026-07-25T08-00-00-${sessionId}.jsonl`)
  const lines = [
    JSON.stringify({
      timestamp: '2026-07-25T08:00:00.000Z',
      type: 'session_meta',
      payload: { id: sessionId, cwd: os.tmpdir() },
    }),
    JSON.stringify({
      timestamp: '2026-07-25T08:00:01.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: `${SESSION_TITLE} request 1` }],
      },
    }),
    JSON.stringify({
      timestamp: '2026-07-25T08:00:02.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: `${SESSION_TITLE} reply 1` }],
      },
    }),
    ...extraLines,
  ]
  await fs.writeFile(rolloutPath, `${lines.join('\n')}\n`)
  return rolloutPath
}

function taskEventLine(payloadType: string, isoTs: string): string {
  return JSON.stringify({ timestamp: isoTs, type: 'event_msg', payload: { type: payloadType } })
}

/**
 * Resume the seeded codex session from the sidebar (donor gesture:
 * codex-terminal-bounce-rust.spec.ts ~:181-218). Clicking the seeded
 * session's TITLE entry opens a NEW tab; returns that tab's id plus the
 * codex leaf's terminalId.
 */
async function resumeCodexSessionFromSidebar(
  page: import('@playwright/test').Page,
  harness: TestHarness,
  title: string,
): Promise<{ tabId: string; terminalId: string }> {
  await expect(page.getByTestId('sidebar-session-list')).toBeVisible({ timeout: 15_000 })
  const sessionItem = page.getByText(title, { exact: false }).first()
  await expect(sessionItem).toBeVisible({ timeout: 15_000 })

  const tabCountBefore = await harness.getTabCount()
  await sessionItem.click()
  await expect(async () => {
    expect(await harness.getTabCount()).toBe(tabCountBefore + 1)
  }).toPass({ timeout: 15_000 })

  const tabId = await harness.getActiveTabId()
  expect(tabId).toBeTruthy()

  await expect.poll(async () => {
    const layout = await harness.getPaneLayout(tabId!)
    const leaf = collectLeaves(layout)
      .find((l) => l?.content?.mode === 'codex' && l?.content?.terminalId)
    return leaf?.content?.terminalId ?? null
  }, { timeout: 20_000 }).not.toBeNull()
  const layout = await harness.getPaneLayout(tabId!)
  const leaf = collectLeaves(layout)
    .find((l) => l?.content?.mode === 'codex' && l?.content?.terminalId)
  return { tabId: tabId!, terminalId: leaf.content.terminalId as string }
}

/**
 * After an abrupt restart, the live client re-creates the resume tab's codex
 * terminal under a NEW id. Poll the RESUME tab's pane layout (the tab id
 * persists client-side across the restart) until a codex leaf carries a
 * terminalId different from `previousId`, and return it.
 */
async function waitForRestoredCodexTerminalId(
  harness: TestHarness,
  tabId: string,
  previousId: string,
): Promise<string> {
  const findRestored = async () => {
    const layout = await harness.getPaneLayout(tabId)
    const leaf = collectLeaves(layout).find(
      (l) =>
        l?.content?.mode === 'codex' &&
        l?.content?.terminalId &&
        l.content.terminalId !== previousId,
    )
    return leaf?.content?.terminalId ?? null
  }
  await expect.poll(findRestored, { timeout: 30_000 }).not.toBeNull()
  const restored = await findRestored()
  expect(restored).toBeTruthy()
  return restored as string
}

test.describe('Codex status completeness (Rust only)', () => {
  test.setTimeout(240_000)

  test('fresh codex terminal: candidate adoption stamps sessionId on turn-complete', async ({
    page,
    e2eServerKind,
  }) => {
    expect(e2eServerKind).toBe('rust')
    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-codex-status-'))
    const fakeCodex = await installFakeCli(path.join(sharedRoot, 'bin'), 'codex', FAKE_BEL_CLI)
    let rolloutPath = ''
    const server = await createE2eServerHandle(process.env, {
      kind: e2eServerKind,
      construct: {
        env: { CODEX_CMD: fakeCodex },
        setupHome: async (homeDir) => {
          const freshellDir = path.join(homeDir, '.freshell')
          await fs.mkdir(freshellDir, { recursive: true })
          await fs.writeFile(
            path.join(freshellDir, 'config.json'),
            JSON.stringify(
              { version: 1, settings: { codingCli: { enabledProviders: ['codex'] } } },
              null,
              2,
            ),
          )
          rolloutPath = await seedRollout(homeDir, THREAD_A)
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

      // FRESH codex pane -- created with no resume id: the G3 gap state.
      const terminalId = await openCliPaneAndGetTerminalId(page, harness, tabId!, /Codex/i, 'codex')
      await expect
        .poll(async () => {
          const buffer = await harness.getTerminalBuffer(terminalId)
          return typeof buffer === 'string' && buffer.includes('fake-cli>')
        }, { timeout: 15_000 })
        .toBe(true)

      // The client announces the persisted rollout (candidate adoption).
      // Field casing verified against the Rust protocol type
      // (`TerminalCodexCandidatePersisted`, client_messages.rs:227-232,
      // rename_all = "camelCase"): terminalId / candidateThreadId /
      // rolloutPath / capturedAt (required i64 — omitting it rejects the
      // frame on deserialize).
      capture.send({
        type: 'terminal.codex.candidate.persisted',
        terminalId,
        candidateThreadId: THREAD_A,
        rolloutPath,
        capturedAt: Date.now(),
      })
      // Adoption is observable on the wire: identity upsert...
      await capture.waitFor(
        (f) =>
          f.type === 'codex.activity.updated' &&
          f.upsert?.some((r: any) => r.terminalId === terminalId && r.sessionId === THREAD_A),
        10_000,
        'adopted identity upsert',
      )

      // ...and the payoff: a full turn's completion carries the sessionId.
      await typePromptIntoLastPane(page, 'do the thing')
      const complete = await capture.waitFor(
        (f) => f.type === 'terminal.turn.complete' && f.terminalId === terminalId,
        15_000,
        'identity-bearing turn complete',
      )
      expect(complete.provider).toBe('codex')
      expect(complete.sessionId).toBe(THREAD_A)
    } finally {
      capture.close()
      await server.stop().catch(() => {})
      await fs.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })

  test('restartAbrupt mid-codex-turn: restored pane seeds busy from the rollout, then completes with identity', async ({
    page,
    e2eServerKind,
  }) => {
    expect(e2eServerKind).toBe('rust')
    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-codex-restart-'))
    const fakeCodex = await installFakeCli(
      path.join(sharedRoot, 'bin'),
      'codex',
      path.resolve(__dirname, '../fixtures/fake-codex-cli.mjs'),
    )
    let rolloutPath = ''
    const server = new RustServer({
      env: { CODEX_CMD: fakeCodex },
      setupHome: async (homeDir) => {
        const freshellDir = path.join(homeDir, '.freshell')
        await fs.mkdir(freshellDir, { recursive: true })
        await fs.writeFile(
          path.join(freshellDir, 'config.json'),
          JSON.stringify(
            { version: 1, settings: { codingCli: { enabledProviders: ['codex'] } } },
            null,
            2,
          ),
        )
        // Idempotent across restartAbrupt's setupHome re-run: seed only once.
        const candidate = path.join(
          homeDir, '.codex', 'sessions', '2026', '07', '25',
          `rollout-2026-07-25T08-00-00-${THREAD_A}.jsonl`,
        )
        try {
          await fs.access(candidate)
          rolloutPath = candidate
        } catch {
          rolloutPath = await seedRollout(homeDir, THREAD_A)
        }
      },
    })
    try {
      const info = await server.start()
      const harness = await bootAndConnect(page, info)
      await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })

      // Resume the seeded session from the sidebar (donor gesture:
      // codex-terminal-bounce-rust.spec.ts ~:181-218 -- click the seeded
      // session's TITLE entry; the click opens a NEW tab, so all later
      // assertions target the returned resumeTabId, not the boot tab).
      // The rollout is currently RESOLVED (no task events), so no busy yet.
      const { tabId: resumeTabId, terminalId } = await resumeCodexSessionFromSidebar(
        page,
        harness,
        SESSION_TITLE,
      )

      // The turn goes mid-flight on disk (codex writes task_started), then
      // the server dies abruptly -- the classic mid-turn crash.
      await fs.appendFile(rolloutPath, `${taskEventLine('task_started', '2026-07-25T09:00:00.000Z')}\n`)
      await server.restartAbrupt()

      // The page's WS auto-reconnects; the client restores the pane, which
      // re-creates the terminal with the resume id -> locator attaches the
      // lane -> initial drain sees the unresolved start -> BUSY (blue).
      await harness.waitForConnection(30_000)
      const capture = new WsCapture(info.baseUrl, info.token)
      try {
        await capture.ready()
        const restoredId = await waitForRestoredCodexTerminalId(harness, resumeTabId, terminalId)
        await capture.waitFor(
          (f) =>
            f.type === 'codex.activity.updated' &&
            f.upsert?.some(
              (r: any) =>
                r.terminalId === restoredId && r.phase === 'busy' && r.sessionId === THREAD_A,
            ),
          20_000,
          'resume-busy seeding after abrupt restart',
        )
        await expect(workingTab(page, resumeTabId)).not.toHaveCount(0, { timeout: 10_000 })

        // The (dead) turn's completion arrives on disk -> lane clears it.
        await fs.appendFile(rolloutPath, `${taskEventLine('task_complete', '2026-07-25T09:05:00.000Z')}\n`)
        await capture.waitFor(
          (f) =>
            f.type === 'codex.activity.updated' &&
            f.upsert?.some((r: any) => r.terminalId === restoredId && r.phase === 'idle'),
          15_000,
          'reconcile clear -> idle',
        )
        const complete = await capture.waitFor(
          (f) => f.type === 'terminal.turn.complete' && f.terminalId === restoredId,
          15_000,
          'reconcile-lane turn complete',
        )
        expect(complete.provider).toBe('codex')
        expect(complete.sessionId).toBe(THREAD_A)
        await expect(workingTab(page, resumeTabId)).toHaveCount(0, { timeout: 10_000 })
      } finally {
        capture.close()
      }
    } finally {
      await server.stop().catch(() => {})
      await fs.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })

  test('two concurrent servers keep independent codex status streams', async ({
    page,
    e2eServerKind,
    browser,
  }) => {
    expect(e2eServerKind).toBe('rust')
    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-codex-twin-'))
    const fakeCodex = await installFakeCli(path.join(sharedRoot, 'bin'), 'codex', FAKE_BEL_CLI)
    const mkServer = () =>
      new RustServer({
        env: { CODEX_CMD: fakeCodex },
        setupHome: async (homeDir) => {
          const freshellDir = path.join(homeDir, '.freshell')
          await fs.mkdir(freshellDir, { recursive: true })
          await fs.writeFile(
            path.join(freshellDir, 'config.json'),
            JSON.stringify(
              { version: 1, settings: { codingCli: { enabledProviders: ['codex'] } } },
              null,
              2,
            ),
          )
        },
      })
    const serverA = mkServer()
    const serverB = mkServer()
    let contextB: import('@playwright/test').BrowserContext | undefined
    try {
      const [infoA, infoB] = await Promise.all([serverA.start(), serverB.start()])
      expect(infoA.port).not.toBe(infoB.port)

      const captureA = new WsCapture(infoA.baseUrl, infoA.token)
      const captureB = new WsCapture(infoB.baseUrl, infoB.token)
      try {
        await Promise.all([captureA.ready(), captureB.ready()])

        // Server A: page-driven codex pane + a full turn.
        const harnessA = await bootAndConnect(page, infoA)
        await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })
        const tabA = await harnessA.getActiveTabId()
        const terminalA = await openCliPaneAndGetTerminalId(page, harnessA, tabA!, /Codex/i, 'codex')

        // Server B: second browser context, its own codex pane + turn.
        contextB = await browser.newContext()
        const pageB = await contextB.newPage()
        const harnessB = await bootAndConnect(pageB, infoB)
        await expect(pageB.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })
        const tabB = await harnessB.getActiveTabId()
        const terminalB = await openCliPaneAndGetTerminalId(pageB, harnessB, tabB!, /Codex/i, 'codex')

        // Drive a turn on A only.
        await typePromptIntoLastPane(page, 'turn on A')
        const completeA = await captureA.waitFor(
          (f) => f.type === 'terminal.turn.complete' && f.terminalId === terminalA,
          15_000,
          'A turn complete',
        )
        expect(completeA.provider).toBe('codex')

        // Independence: B's stream never saw A's terminal, and vice versa.
        expect(captureB.count((f) => f.terminalId === terminalA)).toBe(0)
        expect(captureA.count((f) => f.terminalId === terminalB && f.type === 'terminal.turn.complete')).toBe(0)

        // Now a turn on B, proving B's stream is live and independent.
        await pageB.locator('.xterm').last().click()
        await pageB.keyboard.type('turn on B')
        await pageB.keyboard.press('Enter')
        const completeB = await captureB.waitFor(
          (f) => f.type === 'terminal.turn.complete' && f.terminalId === terminalB,
          15_000,
          'B turn complete',
        )
        expect(completeB.provider).toBe('codex')
        expect(completeB.completionSeq).toBe(1)
        expect(captureA.count((f) => f.terminalId === terminalB)).toBe(0)
      } finally {
        captureA.close()
        captureB.close()
      }
    } finally {
      await contextB?.close().catch(() => {})
      await Promise.all([
        serverA.stop().catch(() => {}),
        serverB.stop().catch(() => {}),
      ])
      await fs.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })
})
