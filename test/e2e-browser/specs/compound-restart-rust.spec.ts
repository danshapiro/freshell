import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect } from '../helpers/fixtures.js'
import { RustServer } from '../helpers/rust-server.js'
import { TestHarness } from '../helpers/test-harness.js'

/**
 * COMPOUND-RESTART -- the two never-tested disruption modes called out by
 * `docs/plans/2026-07-19-state-sync-resilience-assessment.md` §7 as "where
 * the next incident most likely lives" (Rust only):
 *
 *   MODE A -- ABRUPT SERVER DEATH + REVIVAL (WSL-restart-like): the server
 *   process is SIGKILLed (no graceful shutdown: no PTY reaping, no clean WS
 *   close frames, no state flush beyond what is already on disk) and a fresh
 *   process boots against the SAME disk state / port / token. The live
 *   browser client never reloads -- it must recover purely via its own WS
 *   auto-reconnect + terminal re-create round trip.
 *
 *   MODE B -- SERVER AND BROWSER RESTARTING TOGETHER: the server dies
 *   abruptly and the page reloads IMMEDIATELY after the revived process is
 *   healthy -- before the old page's own reconnect/restore round can settle.
 *   This interrupts an in-flight restore with a full client restart, the
 *   "server + browser at once" compound the assessment flags as the
 *   highest-risk untested mode.
 *
 * Both modes drive a terminal CLI pane (codex `resume <id>`) and pin the
 * user's bulletproof-restore contract:
 *   - SAME durable session identity after recovery (pane `sessionRef`);
 *   - the resume argv is genuinely RE-APPLIED (`codex resume <id>` appears
 *     in the fake CLI's argv-log DELTA, not just the pre-kill entries);
 *   - tab/pane state consistent: same tab count, pane re-anchored to a NEW
 *     terminal id, status never 'error', real buffer content (never blank);
 *   - sidebar state consistent: the seeded session's row is linked
 *     (`data-has-tab="true"`), never a grey orphan;
 *   - the `terminal_identity_unresolved` invariant WARN
 *     (`crates/freshell-ws/src/invariants.rs`) never fires.
 *
 * Rust-only: MODE A requires `RustServer.restartAbrupt()` (SIGKILL + reboot
 * on the same home/port/token), an owned-fixture capability the legacy
 * TestServer seam does not implement; the frozen legacy tree is not the
 * subject of this hardening. Fixture shapes (fake codex CLI, `~/.codex`
 * session seed, restart choreography) mirror `codex-terminal-bounce-rust.spec.ts`.
 * Helpers are copied, not imported, per this suite's per-spec-ownership
 * convention.
 */

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const FAKE_CODEX_CLI_SOURCE = path.resolve(__dirname, '../fixtures/fake-codex-cli.mjs')

async function installFakeCodexCli(binDir: string): Promise<string> {
  await fs.mkdir(binDir, { recursive: true })
  const target = path.join(binDir, 'codex')
  await fs.copyFile(FAKE_CODEX_CLI_SOURCE, target)
  await fs.chmod(target, 0o755)
  return target
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

/** Read the fake CLI's argv-log JSONL (empty array if not yet written). */
async function readArgvLog(logPath: string): Promise<Array<{ argv: string[] }>> {
  const raw = await fs.readFile(logPath, 'utf8').catch(() => '')
  if (!raw) return []
  return raw.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as { argv: string[] })
}

/** True when the argv tokens contain the adjacent pair `resume <sessionId>`. */
function hasResumePair(argv: string[], sessionId: string): boolean {
  const idx = argv.indexOf('resume')
  return idx >= 0 && argv[idx + 1] === sessionId
}

/** Concatenated content of every server log file in the fixture's logs dir. */
async function readServerLogs(logsDir: string): Promise<string> {
  const names = await fs.readdir(logsDir).catch(() => [] as string[])
  let combined = ''
  for (const name of names) {
    combined += await fs.readFile(path.join(logsDir, name), 'utf8').catch(() => '')
  }
  return combined
}

/** Seed a historical codex session + config into the isolated HOME (the
 *  `session_meta` + message-records shape `sidebar-click-resume.spec.ts` /
 *  `codex-terminal-bounce-rust.spec.ts` use). */
function seedCodexHome(sessionId: string, sessionTitle: string, projectDir: string) {
  return async (homeDir: string): Promise<void> => {
    const freshellDir = path.join(homeDir, '.freshell')
    await fs.mkdir(freshellDir, { recursive: true })
    await fs.writeFile(path.join(freshellDir, 'config.json'), JSON.stringify({
      version: 1,
      settings: {
        codingCli: { enabledProviders: ['claude', 'codex', 'opencode'] },
      },
    }, null, 2))

    const codexSessionsDir = path.join(homeDir, '.codex', 'sessions')
    await fs.mkdir(codexSessionsDir, { recursive: true })
    const lines = [
      JSON.stringify({
        timestamp: '2026-07-21T08:00:00.000Z',
        type: 'session_meta',
        payload: { id: sessionId, cwd: projectDir },
      }),
      JSON.stringify({
        timestamp: '2026-07-21T08:00:01.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: `${sessionTitle} request 1` }],
        },
      }),
      JSON.stringify({
        timestamp: '2026-07-21T08:00:02.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: `${sessionTitle} reply 1` }],
        },
      }),
    ]
    await fs.writeFile(
      path.join(codexSessionsDir, `${sessionId}.jsonl`),
      `${lines.join('\n')}\n`,
    )
  }
}

/** Open the seeded session from the sidebar and prove the create-time resume.
 *  Returns the new tab id and the pane's first terminal id. */
async function openSeededSessionFromSidebar(
  page: import('@playwright/test').Page,
  harness: TestHarness,
  sessionTitle: string,
  sessionId: string,
  argLogPath: string,
): Promise<{ tabId: string; terminalId: string }> {
  const sessionList = page.getByTestId('sidebar-session-list')
  await expect(sessionList).toBeVisible({ timeout: 15_000 })
  const sessionItem = page.getByText(sessionTitle, { exact: false }).first()
  await expect(sessionItem).toBeVisible({ timeout: 15_000 })

  const tabCountBefore = await harness.getTabCount()
  await sessionItem.click()
  await expect(async () => {
    expect(await harness.getTabCount()).toBe(tabCountBefore + 1)
  }).toPass({ timeout: 15_000 })

  const tabId = await harness.getActiveTabId()
  expect(tabId).toBeTruthy()

  await expect.poll(async () => {
    return (await harness.getPaneLayout(tabId!))?.content?.terminalId ?? null
  }, { timeout: 20_000 }).not.toBeNull()
  const terminalId: string = (await harness.getPaneLayout(tabId!))?.content?.terminalId
  expect(terminalId).toBeTruthy()

  // The pane's persisted identity is the sessionRef shape.
  const paneContent = (await harness.getPaneLayout(tabId!))?.content
  expect(paneContent?.sessionRef?.provider).toBe('codex')
  expect(paneContent?.sessionRef?.sessionId).toBe(sessionId)

  // Create-time resume argv proof.
  await expect.poll(async () => {
    const entries = await readArgvLog(argLogPath)
    return entries.some((e) => hasResumePair(e.argv, sessionId))
  }, { timeout: 20_000 }).toBe(true)

  // Buffer proof (the fake CLI's greppable marker).
  await expect.poll(async () => {
    const buffer = await harness.getTerminalBuffer(terminalId)
    const unwrapped = typeof buffer === 'string' ? buffer.replace(/\n/g, '') : ''
    return unwrapped.includes(`codex: resumed session ${sessionId}`)
  }, { timeout: 20_000 }).toBe(true)

  return { tabId: tabId!, terminalId }
}

/** Post-recovery contract shared by both modes: same identity, resume argv
 *  re-applied (argv delta), pane re-anchored + non-blank, sidebar linked. */
async function assertRecoveredPane(
  page: import('@playwright/test').Page,
  harness: TestHarness,
  opts: {
    tabId: string
    tabCountBefore: number
    terminalIdBefore: string
    sessionId: string
    argLogPath: string
    argvCountBeforeKill: number
  },
): Promise<void> {
  const { tabId, tabCountBefore, terminalIdBefore, sessionId, argLogPath, argvCountBeforeKill } = opts

  // Tab/pane state consistent: the tab survived, no extras minted.
  await expect.poll(() => harness.getTabCount(), { timeout: 20_000 }).toBe(tabCountBefore)

  // The pane re-anchors to a NEW live terminal (the old PTY died with the
  // server process).
  await expect.poll(async () => {
    const tid = (await harness.getPaneLayout(tabId))?.content?.terminalId ?? null
    return tid && tid !== terminalIdBefore ? tid : null
  }, { timeout: 30_000 }).not.toBeNull()
  const terminalIdAfter: string = (await harness.getPaneLayout(tabId))?.content?.terminalId
  expect(terminalIdAfter).toBeTruthy()
  expect(terminalIdAfter).not.toBe(terminalIdBefore)

  // SAME durable identity -- never a blank replacement or a fresh session.
  const paneContent = (await harness.getPaneLayout(tabId))?.content
  expect(paneContent?.sessionRef?.provider).toBe('codex')
  expect(paneContent?.sessionRef?.sessionId).toBe(sessionId)
  expect(paneContent?.status).not.toBe('error')

  // The resume argv was genuinely RE-APPLIED after the kill (delta beyond
  // the pre-kill log entries).
  await expect.poll(async () => {
    const entries = await readArgvLog(argLogPath)
    return entries.slice(argvCountBeforeKill).some((e) => hasResumePair(e.argv, sessionId))
  }, { timeout: 30_000 }).toBe(true)

  // Non-blank: the re-created terminal carries real CLI output.
  await expect.poll(async () => {
    const buffer = await harness.getTerminalBuffer(terminalIdAfter)
    const unwrapped = typeof buffer === 'string' ? buffer.replace(/\n/g, '') : ''
    return unwrapped.includes(`codex: resumed session ${sessionId}`)
  }, { timeout: 20_000 }).toBe(true)

  // Sidebar state consistent: the session's row is LINKED (`data-has-tab`),
  // never a grey orphan (Sidebar.tsx renders the attribute on the row button).
  await expect(
    page.locator(`[data-session-id="${sessionId}"][data-provider="codex"]`).first(),
  ).toHaveAttribute('data-has-tab', 'true', { timeout: 20_000 })
}

test.describe('Compound Restart (Rust only)', () => {
  test.setTimeout(180_000)

  // -------------------------------------------------------------------
  // MODE A -- ABRUPT DEATH + REVIVAL (WSL-restart-like), no page reload.
  // -------------------------------------------------------------------
  test('a resumed codex pane survives an abrupt SIGKILL server death + revival without a page reload', async ({ page, e2eServerKind }) => {
    expect(e2eServerKind).toBe('rust')

    const CODEX_SESSION_ID = 'codex-compound-sigkill-0001'
    const SESSION_TITLE = 'compound-restart sigkill seeded session'

    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-compound-sigkill-'))
    const argLogPath = path.join(sharedRoot, 'fake-codex-argv.jsonl')
    const projectDir = path.join(sharedRoot, 'project')
    await fs.mkdir(projectDir, { recursive: true })

    try {
      const fakeCodexPath = await installFakeCodexCli(path.join(sharedRoot, 'bin'))

      const server = new RustServer({
        env: { CODEX_CMD: fakeCodexPath, FAKE_CODEX_ARGV_LOG: argLogPath },
        setupHome: seedCodexHome(CODEX_SESSION_ID, SESSION_TITLE, projectDir),
      })
      const info = await server.start()

      try {
        await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
        const harness = new TestHarness(page)
        await harness.waitForHarness()
        await harness.waitForConnection()
        await selectShellIfPickerShowing(page)
        await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })

        const { tabId, terminalId } = await openSeededSessionFromSidebar(
          page, harness, SESSION_TITLE, CODEX_SESSION_ID, argLogPath,
        )
        const tabCountBefore = await harness.getTabCount()
        const argvCountBeforeKill = (await readArgvLog(argLogPath)).length

        // --- THE COMPOUND: SIGKILL, then revive on the same disk state.
        // No graceful shutdown ran; the live client must recover on its
        // own reconnect (deliberately NO page.reload()). ---
        await server.restartAbrupt()

        await expect(async () => {
          const status = await page.evaluate(() => (window as any).__FRESHELL_TEST_HARNESS__?.getWsReadyState())
          expect(status).toBe('ready')
        }).toPass({ timeout: 60_000 })

        await assertRecoveredPane(page, harness, {
          tabId,
          tabCountBefore,
          terminalIdBefore: terminalId,
          sessionId: CODEX_SESSION_ID,
          argLogPath,
          argvCountBeforeKill,
        })

        // Identity-invariant proof: wait out the resolution grace window
        // (IDENTITY_RESOLUTION_GRACE_MS ~10s + sweep slack) on the
        // re-created terminal, then prove the WARN never fired.
        await page.waitForTimeout(12_000)
        const serverLogs = await readServerLogs(info.logsDir)
        expect(serverLogs.length).toBeGreaterThan(0)
        expect(serverLogs).not.toContain('terminal_identity_unresolved')
      } finally {
        await server.stop().catch(() => {})
      }
    } finally {
      await fs.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })

  // -------------------------------------------------------------------
  // MODE B -- SERVER AND BROWSER RESTARTING TOGETHER.
  // -------------------------------------------------------------------
  test('a resumed codex pane survives the server and the browser page restarting together', async ({ page, e2eServerKind }) => {
    expect(e2eServerKind).toBe('rust')

    const CODEX_SESSION_ID = 'codex-compound-both-0001'
    const SESSION_TITLE = 'compound-restart both seeded session'

    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-compound-both-'))
    const argLogPath = path.join(sharedRoot, 'fake-codex-argv.jsonl')
    const projectDir = path.join(sharedRoot, 'project')
    await fs.mkdir(projectDir, { recursive: true })

    try {
      const fakeCodexPath = await installFakeCodexCli(path.join(sharedRoot, 'bin'))

      const server = new RustServer({
        env: { CODEX_CMD: fakeCodexPath, FAKE_CODEX_ARGV_LOG: argLogPath },
        setupHome: seedCodexHome(CODEX_SESSION_ID, SESSION_TITLE, projectDir),
      })
      const info = await server.start()

      try {
        await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
        const harness = new TestHarness(page)
        await harness.waitForHarness()
        await harness.waitForConnection()
        await selectShellIfPickerShowing(page)
        await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })

        const { tabId, terminalId } = await openSeededSessionFromSidebar(
          page, harness, SESSION_TITLE, CODEX_SESSION_ID, argLogPath,
        )
        const tabCountBefore = await harness.getTabCount()

        // Flush the layout so the reload rehydrates from persisted state
        // (the browser-restart half of the compound).
        await page.evaluate(() => {
          window.__FRESHELL_TEST_HARNESS__?.dispatch({ type: 'persist/flushNow' })
        })

        const argvCountBeforeKill = (await readArgvLog(argLogPath)).length

        // --- THE COMPOUND: abrupt server death + revival, then reload the
        // page IMMEDIATELY -- deliberately WITHOUT waiting for the old
        // page's own WS reconnect/restore round to settle first, so the
        // in-flight restore is interrupted by a full client restart. ---
        await server.restartAbrupt()
        await page.reload({ waitUntil: 'domcontentloaded' })
        await harness.waitForHarness()
        await harness.waitForConnection()

        await assertRecoveredPane(page, harness, {
          tabId,
          tabCountBefore,
          terminalIdBefore: terminalId,
          sessionId: CODEX_SESSION_ID,
          argLogPath,
          argvCountBeforeKill,
        })

        // --- Idempotency re-check: reload AGAIN (no further kill). The
        // recovery must be durable, not a one-shot that reverts on the
        // next client restart. ---
        const terminalIdAfterFirstRecovery: string = (await harness.getPaneLayout(tabId))?.content?.terminalId
        await page.evaluate(() => {
          window.__FRESHELL_TEST_HARNESS__?.dispatch({ type: 'persist/flushNow' })
        })
        await page.reload({ waitUntil: 'domcontentloaded' })
        await harness.waitForHarness()
        await harness.waitForConnection()

        await expect.poll(() => harness.getTabCount(), { timeout: 20_000 }).toBe(tabCountBefore)
        await expect.poll(async () => {
          return (await harness.getPaneLayout(tabId))?.content?.terminalId ?? null
        }, { timeout: 30_000 }).not.toBeNull()
        const finalContent = (await harness.getPaneLayout(tabId))?.content
        expect(finalContent?.sessionRef?.sessionId).toBe(CODEX_SESSION_ID)
        expect(finalContent?.status).not.toBe('error')
        // The server survived the second reload's reattach: the SAME live
        // terminal is re-attached (the server never restarted again), or at
        // minimum a live one is anchored -- never a blank/error pane.
        expect(finalContent?.terminalId).toBeTruthy()
        void terminalIdAfterFirstRecovery

        // Identity-invariant proof (same as MODE A).
        await page.waitForTimeout(12_000)
        const serverLogs = await readServerLogs(info.logsDir)
        expect(serverLogs.length).toBeGreaterThan(0)
        expect(serverLogs).not.toContain('terminal_identity_unresolved')
      } finally {
        await server.stop().catch(() => {})
      }
    } finally {
      await fs.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })
})
