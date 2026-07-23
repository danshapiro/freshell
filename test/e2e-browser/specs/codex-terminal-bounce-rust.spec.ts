import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect } from '../helpers/fixtures.js'
import { createE2eServerHandle } from '../helpers/external-target.js'
import { TestHarness } from '../helpers/test-harness.js'

/**
 * CODEX TERMINAL BOUNCE -- the exact 2026-07-22 incident, as a regression
 * test (Rust only).
 *
 * INCIDENT: every server restart lost every codex terminal's session. The WS
 * `terminal.create` resume derivation (`crates/freshell-ws/src/terminal.rs`)
 * treated codex SPECIALLY -- it read ONLY `create.resumeSessionId` and never
 * consulted `create.sessionRef`. The frozen client (post-Jul-20 rework)
 * carries identity ONLY in `sessionRef` (`TerminalView.tsx:2782-2795`'s
 * `sendCreate` has no `resumeSessionId` field; persistence strips it), so
 * every codex create -- bounce restores AND sidebar reopens -- spawned plain
 * `codex` with no resume args. In the 19:25 incident batch, 3 amplifier panes
 * (same client path, generic derivation) resumed correctly while all 6 codex
 * panes came back fresh. Legacy parity: `server/ws-handler.ts:2040-2047`
 * derives the codex resume id from the sessionRef too (via
 * `planCodexCreateRestoreDecision`'s `durable_session_ref_resume`).
 *
 * The scenario (both incident legs, in one flow):
 *   1. Sidebar reopen: click a seeded historical codex session (the
 *      sidebar-resume shape -- the pane carries `sessionRef`, never
 *      `resumeSessionId`) and prove the spawned argv contains
 *      `resume <sessionId>`.
 *   2. THE BOUNCE: `server.restart()` WITHOUT `page.reload()` -- the live
 *      client auto-reconnects and re-creates the pane's terminal. Prove the
 *      RE-spawned argv (argv-log delta) contains `resume <sessionId>` again,
 *      AND that no `terminal_identity_unresolved` WARN
 *      (`crates/freshell-ws/src/invariants.rs`) ever fires in the server log.
 *
 * Rust-only: this drives the Rust server's WS create path; the frozen legacy
 * `server/` tree derives codex resume correctly already (the anchor above)
 * and is not the subject of this regression.
 *
 * Fixture reuse: `fake-codex-cli.mjs` + the `~/.codex/sessions` seed are the
 * exact shapes `sidebar-click-resume.spec.ts` uses; the restart choreography
 * mirrors `opencode-terminal-restore-rust.spec.ts` (minus the reload).
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

test.describe('Codex Terminal Bounce (Rust only)', () => {
  test.setTimeout(150_000)

  test('a sidebar-resumed codex pane re-resumes (argv `resume <id>`) across a server restart without a page reload', async ({ page, e2eServerKind }) => {
    expect(e2eServerKind).toBe('rust')

    const CODEX_SESSION_ID = 'codex-bounce-resume-0001'
    const SESSION_TITLE = 'codex-terminal-bounce seeded session'

    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-codex-bounce-'))
    const argLogPath = path.join(sharedRoot, 'fake-codex-argv.jsonl')
    const projectDir = path.join(sharedRoot, 'project')
    await fs.mkdir(projectDir, { recursive: true })

    try {
      const fakeCodexPath = await installFakeCodexCli(path.join(sharedRoot, 'bin'))

      const server = await createE2eServerHandle(process.env, {
        kind: e2eServerKind,
        construct: {
          env: { CODEX_CMD: fakeCodexPath, FAKE_CODEX_ARGV_LOG: argLogPath },
          setupHome: async (homeDir) => {
            const freshellDir = path.join(homeDir, '.freshell')
            await fs.mkdir(freshellDir, { recursive: true })
            await fs.writeFile(path.join(freshellDir, 'config.json'), JSON.stringify({
              version: 1,
              settings: {
                codingCli: { enabledProviders: ['claude', 'codex', 'opencode'] },
              },
            }, null, 2))

            // Same real-reader seed shape as `sidebar-click-resume.spec.ts` /
            // `session-directory-matrix.spec.ts`: a `session_meta` record
            // carrying `payload.id`/`cwd` plus message records for a title.
            const codexSessionsDir = path.join(homeDir, '.codex', 'sessions')
            await fs.mkdir(codexSessionsDir, { recursive: true })
            const lines = [
              JSON.stringify({
                timestamp: '2026-07-21T08:00:00.000Z',
                type: 'session_meta',
                payload: { id: CODEX_SESSION_ID, cwd: projectDir },
              }),
              JSON.stringify({
                timestamp: '2026-07-21T08:00:01.000Z',
                type: 'response_item',
                payload: {
                  type: 'message',
                  role: 'user',
                  content: [{ type: 'input_text', text: `${SESSION_TITLE} request 1` }],
                },
              }),
              JSON.stringify({
                timestamp: '2026-07-21T08:00:02.000Z',
                type: 'response_item',
                payload: {
                  type: 'message',
                  role: 'assistant',
                  content: [{ type: 'output_text', text: `${SESSION_TITLE} reply 1` }],
                },
              }),
            ]
            await fs.writeFile(
              path.join(codexSessionsDir, `${CODEX_SESSION_ID}.jsonl`),
              `${lines.join('\n')}\n`,
            )
          },
        },
      })
      const info = await server.start()

      try {
        await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
        const harness = new TestHarness(page)
        await harness.waitForHarness()
        await harness.waitForConnection()
        await selectShellIfPickerShowing(page)
        await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })

        // -------------------------------------------------------------
        // Leg 1 -- sidebar reopen: click the seeded codex session row.
        // The pane this opens carries identity ONLY in `sessionRef`
        // (the incident's create shape).
        // -------------------------------------------------------------
        const sessionList = page.getByTestId('sidebar-session-list')
        await expect(sessionList).toBeVisible({ timeout: 15_000 })
        const sessionItem = page.getByText(SESSION_TITLE, { exact: false }).first()
        await expect(sessionItem).toBeVisible({ timeout: 15_000 })

        const tabCountBefore = await harness.getTabCount()
        await sessionItem.click()
        await expect(async () => {
          expect(await harness.getTabCount()).toBe(tabCountBefore + 1)
        }).toPass({ timeout: 15_000 })

        const newTabId = await harness.getActiveTabId()
        expect(newTabId).toBeTruthy()

        const terminalIdBefore: string = await expect.poll(async () => {
          return (await harness.getPaneLayout(newTabId!))?.content?.terminalId ?? null
        }, { timeout: 20_000 }).not.toBeNull().then(async () => {
          return (await harness.getPaneLayout(newTabId!))?.content?.terminalId
        })
        expect(terminalIdBefore).toBeTruthy()

        // The pane's persisted identity is the sessionRef shape.
        const paneContent = (await harness.getPaneLayout(newTabId!))?.content
        expect(paneContent?.sessionRef?.provider).toBe('codex')
        expect(paneContent?.sessionRef?.sessionId).toBe(CODEX_SESSION_ID)

        // Argv proof for the sidebar-reopen leg.
        await expect.poll(async () => {
          const entries = await readArgvLog(argLogPath)
          return entries.some((e) => hasResumePair(e.argv, CODEX_SESSION_ID))
        }, { timeout: 20_000 }).toBe(true)

        // Buffer proof (the fake CLI's greppable marker, scoped to the pane).
        await expect.poll(async () => {
          const buffer = await harness.getTerminalBuffer(terminalIdBefore)
          const unwrapped = typeof buffer === 'string' ? buffer.replace(/\n/g, '') : ''
          return unwrapped.includes(`codex: resumed session ${CODEX_SESSION_ID}`)
        }, { timeout: 20_000 }).toBe(true)

        const argvCountBeforeRestart = (await readArgvLog(argLogPath)).length

        // -------------------------------------------------------------
        // Leg 2 -- THE BOUNCE: restart the server WITHOUT reloading the
        // page. PTYs are lost; the live client auto-reconnects (same
        // port/token) and re-creates the pane's terminal, carrying
        // identity ONLY in `sessionRef`. This is the exact incident
        // shape: pre-fix, the re-spawn was plain `codex` (no resume).
        // -------------------------------------------------------------
        if (!server.restart) {
          throw new Error(`${e2eServerKind} E2eServerHandle does not implement restart()`)
        }
        await server.restart()

        // Deliberately NO page.reload() -- wait for the client's own WS
        // reconnect + terminal re-create round trip.
        await expect(async () => {
          const status = await page.evaluate(() => (window as any).__FRESHELL_TEST_HARNESS__?.getWsReadyState())
          expect(status).toBe('ready')
        }).toPass({ timeout: 60_000 })

        const terminalIdAfter: string = await expect.poll(async () => {
          const tid = (await harness.getPaneLayout(newTabId!))?.content?.terminalId ?? null
          return tid && tid !== terminalIdBefore ? tid : null
        }, { timeout: 30_000 }).not.toBeNull().then(async () => {
          return (await harness.getPaneLayout(newTabId!))?.content?.terminalId
        })
        expect(terminalIdAfter).toBeTruthy()
        expect(terminalIdAfter).not.toBe(terminalIdBefore)

        // THE regression assertion: the RE-spawned argv (delta beyond the
        // pre-restart log) contains `resume <sessionId>` again.
        await expect.poll(async () => {
          const entries = await readArgvLog(argLogPath)
          return entries.slice(argvCountBeforeRestart).some((e) => hasResumePair(e.argv, CODEX_SESSION_ID))
        }, { timeout: 30_000 }).toBe(true)

        // Buffer proof on the re-created terminal.
        await expect.poll(async () => {
          const buffer = await harness.getTerminalBuffer(terminalIdAfter)
          const unwrapped = typeof buffer === 'string' ? buffer.replace(/\n/g, '') : ''
          return unwrapped.includes(`codex: resumed session ${CODEX_SESSION_ID}`)
        }, { timeout: 20_000 }).toBe(true)

        // The pane never degrades to an error state.
        expect((await harness.getPaneLayout(newTabId!))?.content?.status).not.toBe('error')

        // -------------------------------------------------------------
        // Identity-invariant proof: the `terminal_identity_unresolved`
        // WARN (`crates/freshell-ws/src/invariants.rs`) fires ~10s
        // (IDENTITY_RESOLUTION_GRACE_MS) after any running non-shell
        // terminal is left without a resolvable session identity -- the
        // exact alarm the incident's terminals tripped. Wait out the
        // grace window (plus sweep slack) on the RE-created terminal,
        // then prove the server log stayed clean.
        // -------------------------------------------------------------
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
