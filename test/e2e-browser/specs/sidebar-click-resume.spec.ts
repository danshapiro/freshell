import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect } from '../helpers/fixtures.js'
import { createE2eServerHandle } from '../helpers/external-target.js'
import { TestHarness } from '../helpers/test-harness.js'

/**
 * SIDEBAR-CLICK RESUME -- SESSION-01 narrowed-MISSING closure
 * (`docs/plans/2026-07-14-rust-tauri-parity-completion-checklist.md`,
 * SESSION-01's 2026-07-18 "Narrowed MISSING" note).
 *
 * `amplifier-restore-rust.spec.ts` already e2e-proves Amplifier's resumable
 * identity for the RESTART path (a lost PTY re-launches with `amplifier
 * resume <id>` after `server.restart()`). That note explicitly leaves one
 * clause open: "resuming a session through the UI" -- a deliberate user
 * CLICK on a sidebar/History item, not an automatic restart-driven
 * re-launch. This spec proves that specific clause: click a seeded
 * historical session in the sidebar, and assert the newly-opened pane's
 * spawned CLI process actually receives `resume <sessionId>` in its argv
 * (not just that a pane opens with a plausible title, which
 * `restore-matrix.spec.ts`'s "opening a seeded historical session..."
 * scenario already covers for Claude without an argv-level check).
 *
 * Two provider legs:
 *
 *   - Amplifier (`amplifier resume <id>`): Rust-only, GREEN. KNOWN
 *     DIVERGENCE (same as `amplifier-restore-rust.spec.ts` and
 *     `session-directory-matrix.spec.ts`'s identical note): this checked-out
 *     branch's `server/` tree (legacy Node implementation, FROZEN for this
 *     task) predates upstream `origin/main` commit `05c6b1fa`
 *     ("feat(amplifier): durable session tracking via events.jsonl", #514)
 *     -- legacy has NO amplifier provider registered at all, so this leg is
 *     skipped (not silently omitted -- see the explicit `test.skip` call
 *     with its reason) on `legacy-chromium`. This test PASSES on
 *     `rust-chromium`: the click dispatches a resume, the pane gets a real
 *     `terminalId`, the spawned fake `amplifier` process's argv contains
 *     `["resume", "<sessionId>"]`, and its stdout carries the matching
 *     "resumed session" marker -- the FULL clause the SESSION-01 checklist
 *     note left open ("resuming a session through the UI" via a deliberate
 *     click, not a restart-driven re-launch) is proven for this provider.
 *   - Codex (`codex resume <id>`, per `extensions/codex-cli/freshell.json`'s
 *     `resumeArgs` and `server/terminal-registry.ts:105`/
 *     `crates/freshell-platform/src/cli_launch_goldens.rs`'s G-X2):
 *     DIAGNOSTIC ONLY (`test.fixme`), NOT a green assertion, on EITHER
 *     server kind -- see the DISCOVERED comment on the test itself for the
 *     two independent findings (legacy: terminal-create settles into
 *     `status: 'error'`; rust: the actual resume happens through the
 *     FreshCodex JSON-RPC app-server sidecar, not a plain `codex resume
 *     <id>` CLI argv, so this fixture's premise doesn't match reality).
 */

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const FAKE_CODEX_CLI_SOURCE = path.resolve(__dirname, '../fixtures/fake-codex-cli.mjs')
const FAKE_AMPLIFIER_CLI_SOURCE = path.resolve(__dirname, '../fixtures/fake-amplifier-cli.mjs')

/**
 * Install a fake CLI fixture as an executable named `binName` in a throwaway
 * bin dir -- same copy-then-chmod pattern `amplifier-restore-rust.spec.ts`'s
 * `installFakeAmplifierCli` uses (both fixtures are plain scripts with no
 * bare ESM import specifiers that would break outside their home directory,
 * so a straight copy is safe here).
 */
async function installFakeCli(source: string, binName: string, binDir: string): Promise<string> {
  await fs.mkdir(binDir, { recursive: true })
  const target = path.join(binDir, binName)
  await fs.copyFile(source, target)
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

/** Read a fixture's argv-log JSONL file and return the parsed lines (empty array if not yet written). */
async function readArgvLog(logPath: string): Promise<Array<{ argv: string[] }>> {
  const raw = await fs.readFile(logPath, 'utf8').catch(() => '')
  if (!raw) return []
  return raw.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as { argv: string[] })
}

test.describe('Sidebar Click Resume', () => {
  test.setTimeout(90_000)

  // -------------------------------------------------------------------
  // CODEX -- both server kinds (legacy is a genuine control; see file
  // doc comment above).
  // -------------------------------------------------------------------
  test('clicking a seeded Codex session in the sidebar spawns it via `codex resume <id>`', async ({ page, e2eServerKind }) => {
    // DISCOVERED (2026-07-19, this task) -- the premise of this test does
    // NOT hold on either server kind, for two DIFFERENT reasons, so this
    // test is diagnostic-only (`test.fixme`) rather than a green assertion:
    //
    //   - `legacy-chromium`: clicking this seeded Codex session's sidebar
    //     row correctly dispatches a resume (the pane's persisted content
    //     shows the correct `sessionRef: { provider: 'codex', sessionId }`
    //     and `initialCwd`), but the server-side terminal-create request
    //     settles into `content.status === 'error'` with NO `terminalId`
    //     ever assigned -- confirmed with `CODEX_CMD` pointed at a real,
    //     executable fake CLI (proven to work for the identical claude-CLI
    //     shape in `restore-matrix.spec.ts`) and with
    //     `codingCli.enabledProviders` explicitly including `codex` (ruling
    //     out the `ws-handler.ts` enabled-provider gate). `server/` is
    //     FROZEN for this task, so this cannot be root-caused/fixed here.
    //   - `rust-chromium`: the pane DOES get a real `terminalId` and a
    //     running process, but the captured argv is NOT `["resume", id]` --
    //     it is a set of `-c key=value` config overrides
    //     (`tui.notification_method=bel`, `mcp_servers.freshell.command=...`)
    //     characteristic of the FreshCodex JSON-RPC app-server protocol
    //     (`fake-app-server.mjs`'s shape in `restore-matrix.spec.ts`), NOT
    //     the plain-CLI `server/terminal-registry.ts`/`cli_launch_goldens.rs`
    //     resume-argv path this fixture assumes. In other words: resuming a
    //     `codex`-provider session from the sidebar on Rust today routes
    //     through the FreshCodex sidecar's JSON-RPC resume message, not a
    //     bare `codex resume <id>` argv -- a genuinely different mechanism
    //     from Amplifier's plain-terminal-CLI resume (proven below), which
    //     this test's argv-log assertion cannot observe. Proving THAT
    //     mechanism (JSON-RPC resume-on-click) is real work, out of scope
    //     for this pass, and is left as a follow-up rather than silently
    //     misrepresented as covered by this file.
    //
    // `test.fixme` keeps this compiled and runnable for diagnostics (see the
    // DEBUG-derived findings above) while making clear no claim is made that
    // it currently passes.
    test.fixme(true, 'See DISCOVERED comment above: neither server kind resumes this seeded Codex session via a plain `codex resume <id>` CLI argv today.')

    const CODEX_SESSION_ID = 'codex-click-resume-0001'
    const SESSION_TITLE = 'sidebar-click-resume codex session'

    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-sidebar-click-resume-codex-'))
    const argLogPath = path.join(sharedRoot, 'fake-codex-argv.jsonl')
    const projectDir = path.join(sharedRoot, 'project')
    await fs.mkdir(projectDir, { recursive: true })

    try {
      const fakeCodexPath = await installFakeCli(FAKE_CODEX_CLI_SOURCE, 'codex', path.join(sharedRoot, 'bin'))

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

            // Same real-reader shape as `session-directory-matrix.spec.ts`'s
            // codex seed: a `session_meta` record carrying `payload.id`/`cwd`
            // plus a `response_item`/`message` record so a real title is
            // extracted.
            const codexSessionsDir = path.join(homeDir, '.codex', 'sessions')
            await fs.mkdir(codexSessionsDir, { recursive: true })
            const lines = [
              JSON.stringify({
                timestamp: '2026-07-19T08:00:00.000Z',
                type: 'session_meta',
                payload: { id: CODEX_SESSION_ID, cwd: projectDir },
              }),
              JSON.stringify({
                timestamp: '2026-07-19T08:00:01.000Z',
                type: 'response_item',
                payload: {
                  type: 'message',
                  role: 'user',
                  content: [{ type: 'input_text', text: `${SESSION_TITLE} request 1` }],
                },
              }),
              JSON.stringify({
                timestamp: '2026-07-19T08:00:02.000Z',
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
        const harness = await bootAndConnect(page, info)
        await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })

        const sessionList = page.getByTestId('sidebar-session-list')
        await expect(sessionList).toBeVisible({ timeout: 15_000 })
        const sessionItem = page.getByText(SESSION_TITLE, { exact: false }).first()
        await expect(sessionItem).toBeVisible({ timeout: 15_000 })

        const tabCountBefore = await harness.getTabCount()

        // THE CLICK -- a deliberate user click on the sidebar history item,
        // not a restart-driven auto-recreate.
        await sessionItem.click()

        await expect(async () => {
          const tabCount = await harness.getTabCount()
          expect(tabCount).toBe(tabCountBefore + 1)
        }).toPass({ timeout: 15_000 })

        const newTabId = await harness.getActiveTabId()
        expect(newTabId).toBeTruthy()

        const newTabTerminal = page.locator(`[data-context="terminal"][data-tab-id="${newTabId}"]`)
        await expect(newTabTerminal.locator('.xterm').first()).toBeVisible({ timeout: 20_000 })

        // `terminalId` is only assigned once the server's `terminal.created`
        // round trip completes (async over the WS connection) -- poll for it
        // rather than reading `getPaneLayout` a single time immediately after
        // the (possibly-just-a-placeholder) `.xterm` container appears.
        const terminalId: string = await expect.poll(async () => {
          return (await harness.getPaneLayout(newTabId!))?.content?.terminalId ?? null
        }, { timeout: 20_000 }).not.toBeNull().then(async () => {
          return (await harness.getPaneLayout(newTabId!))?.content?.terminalId
        })
        expect(terminalId).toBeTruthy()

        // (1) Terminal-buffer proof: the fake CLI's own greppable marker,
        // scoped to this pane's terminal.
        await expect.poll(async () => {
          const buffer = await harness.getTerminalBuffer(terminalId)
          return typeof buffer === 'string' && buffer.includes(`codex: resumed session ${CODEX_SESSION_ID}`)
        }, { timeout: 20_000 }).toBe(true)

        // (2) Argv-log proof: independent of terminal-buffer scraping --
        // the fake CLI mirrors its OWN argv to a file on every invocation.
        const resumeInvocations = (await expect.poll(async () => {
          const lines = await readArgvLog(argLogPath)
          return lines.filter((entry) => entry.argv[0] === 'resume')
        }, { timeout: 20_000 }).not.toEqual([]).then(async () => {
          const lines = await readArgvLog(argLogPath)
          return lines.filter((entry) => entry.argv[0] === 'resume')
        }))
        expect(resumeInvocations.some((entry) => entry.argv[1] === CODEX_SESSION_ID)).toBe(true)
      } finally {
        await server.stop().catch(() => {})
      }
    } finally {
      await fs.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })

  // -------------------------------------------------------------------
  // AMPLIFIER -- Rust only. KNOWN DIVERGENCE: see file doc comment above.
  // -------------------------------------------------------------------
  test('clicking a seeded Amplifier session in the sidebar spawns it via `amplifier resume <id>` (Rust only)', async ({ page, e2eServerKind }) => {
    test.skip(
      e2eServerKind !== 'rust',
      'KNOWN DIVERGENCE: this branch\'s FROZEN legacy server/ tree predates upstream #514 (05c6b1fa) -- ' +
      'no amplifier provider registered at all on legacy (see session-directory-matrix.spec.ts and ' +
      'amplifier-restore-rust.spec.ts\'s identical note). Not a parity gap to gate per-assertion.',
    )

    const AMPLIFIER_SESSION_ID = 'amp-click-resume-0001'
    const SESSION_TITLE = 'sidebar-click-resume amplifier session'

    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-sidebar-click-resume-amplifier-'))
    const argLogPath = path.join(sharedRoot, 'fake-amplifier-argv.jsonl')
    const projectDir = path.join(sharedRoot, 'project')
    await fs.mkdir(projectDir, { recursive: true })

    try {
      const fakeAmplifierPath = await installFakeCli(FAKE_AMPLIFIER_CLI_SOURCE, 'amplifier', path.join(sharedRoot, 'bin'))

      const server = await createE2eServerHandle(process.env, {
        kind: e2eServerKind,
        construct: {
          env: {
            AMPLIFIER_CMD: fakeAmplifierPath,
            FAKE_AMPLIFIER_ARGV_LOG: argLogPath,
          },
          // Same real settings surface `amplifier-restore-rust.spec.ts` seeds
          // -- PanePicker gates on `enabledProviders`, but this scenario
          // never opens the picker; seeded here anyway for parity/safety in
          // case any provider-enabled gate applies to resume as well.
          setupHome: async (homeDir) => {
            const freshellDir = path.join(homeDir, '.freshell')
            await fs.mkdir(freshellDir, { recursive: true })
            await fs.writeFile(path.join(freshellDir, 'config.json'), JSON.stringify({
              version: 1,
              settings: {
                codingCli: { enabledProviders: ['amplifier'] },
              },
            }, null, 2))

            // Same shape as `session-directory-matrix.spec.ts`'s amplifier
            // seed: `metadata.json` + sibling `transcript.jsonl` under
            // `<amplifier_home>/projects/<slug>/sessions/<id>/`.
            const amplifierSessionDir = path.join(
              homeDir, '.amplifier', 'projects', 'sidebar-click-resume-project', 'sessions', AMPLIFIER_SESSION_ID,
            )
            await fs.mkdir(amplifierSessionDir, { recursive: true })
            await fs.writeFile(
              path.join(amplifierSessionDir, 'metadata.json'),
              JSON.stringify({
                session_id: AMPLIFIER_SESSION_ID,
                working_dir: projectDir,
                created: '2026-07-19T08:00:00.000Z',
                description_updated_at: '2026-07-19T08:00:02.000Z',
                name: SESSION_TITLE,
                description: `${SESSION_TITLE} summary`,
              }),
            )
            await fs.writeFile(
              path.join(amplifierSessionDir, 'transcript.jsonl'),
              [
                JSON.stringify({ role: 'user', content: `${SESSION_TITLE} request 1` }),
                JSON.stringify({ role: 'assistant', content: `${SESSION_TITLE} reply 1` }),
              ].join('\n') + '\n',
            )
          },
        },
      })
      const info = await server.start()

      try {
        const harness = await bootAndConnect(page, info)
        await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })

        const sessionList = page.getByTestId('sidebar-session-list')
        await expect(sessionList).toBeVisible({ timeout: 15_000 })
        const sessionItem = page.getByText(SESSION_TITLE, { exact: false }).first()
        await expect(sessionItem).toBeVisible({ timeout: 15_000 })

        const tabCountBefore = await harness.getTabCount()

        // THE CLICK.
        await sessionItem.click()

        await expect(async () => {
          const tabCount = await harness.getTabCount()
          expect(tabCount).toBe(tabCountBefore + 1)
        }).toPass({ timeout: 15_000 })

        const newTabId = await harness.getActiveTabId()
        expect(newTabId).toBeTruthy()

        const newTabTerminal = page.locator(`[data-context="terminal"][data-tab-id="${newTabId}"]`)
        await expect(newTabTerminal.locator('.xterm').first()).toBeVisible({ timeout: 20_000 })

        const terminalId: string | undefined = (await harness.getPaneLayout(newTabId!))?.content?.terminalId
        expect(terminalId).toBeTruthy()

        await expect.poll(async () => {
          const buffer = await harness.getTerminalBuffer(terminalId)
          return typeof buffer === 'string' && buffer.includes(`amplifier: resumed session ${AMPLIFIER_SESSION_ID}`)
        }, { timeout: 20_000 }).toBe(true)

        const resumeInvocations = (await expect.poll(async () => {
          const lines = await readArgvLog(argLogPath)
          return lines.filter((entry) => entry.argv[0] === 'resume')
        }, { timeout: 20_000 }).not.toEqual([]).then(async () => {
          const lines = await readArgvLog(argLogPath)
          return lines.filter((entry) => entry.argv[0] === 'resume')
        }))
        expect(resumeInvocations.some((entry) => entry.argv[1] === AMPLIFIER_SESSION_ID)).toBe(true)
      } finally {
        await server.stop().catch(() => {})
      }
    } finally {
      await fs.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })
})
