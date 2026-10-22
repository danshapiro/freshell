/**
 * Lane D1 (Task 9): agent crash auto-resume, end-to-end with a real server +
 * real browser (docs/plans/2026-07-27-agent-crash-resilience.md).
 *
 * The fake claude CLI (fixtures/fake-crashing-claude-cli.mjs) crashes on
 * demand (FAKE_CRASH_MODE=once|always|clean, FAKE_CRASH_UNTIL=N) and appends
 * every invocation's argv to a JSONL log, so each user story is proven from
 * both sides at once — the server's process table (argv-log deltas) and the
 * user's screen (role=status notice / role=alert bar / Relaunch button):
 *
 *  1. crash → bounded auto-resume with `--resume <same id>` + visible notice
 *  2. instantly re-crashing CLI → EXACTLY 3 invocations (1 + 2 retries),
 *     loud role=alert bar with 'process exited (code 1)' and a Relaunch button
 *  3. clean exit (code 0) → no resume, no alarm (quiet exited presentation)
 *  4. Relaunch button → invocation 4 with `--resume <same id>`, alert clears,
 *     pane stays genuinely live (FAKE_CRASH_UNTIL=3: the surviving invocation
 *     bypasses the 'clean' default so liveness is non-vacuous)
 *
 * Helper shapes (installFakeCli, seedConfig, shell-picker choreography,
 * argv-log delta assertions) are COPIED from recover-my-panes-rust.spec.ts
 * per this suite's per-spec-ownership convention.
 *
 * Rust-only: the auto-resume orchestrator lives in the Rust server
 * (crates/freshell-ws/src/auto_resume.rs); owns one RustServer per test rig
 * (ephemeral loopback port — NEVER 3001/3002). Registered ONLY under
 */
import { createFreshE2ePage, test, expect } from '../helpers/fixtures.js'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { fileURLToPath } from 'node:url'
import type { Browser, BrowserContext, Page } from '@playwright/test'
import { RustServer, ensureRustServerBuilt } from '../helpers/rust-server.js'
import type { E2eServerInfo } from '../helpers/server-fixture-support.js'
import { TestHarness } from '../helpers/test-harness.js'
import { openPanePicker } from '../helpers/pane-picker.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** Donor: recover-my-panes-rust.spec.ts:43 */
async function installFakeCli(binDir: string, name: string, source: string): Promise<string> {
  await fs.mkdir(binDir, { recursive: true })
  const target = path.join(binDir, name)
  await fs.copyFile(path.resolve(__dirname, '../fixtures', source), target)
  await fs.chmod(target, 0o755)
  return target
}

/** Donor: recover-my-panes-rust.spec.ts:52 */
function seedConfig() {
  return async (homeDir: string): Promise<void> => {
    const freshellDir = path.join(homeDir, '.freshell')
    await fs.mkdir(freshellDir, { recursive: true })
    await fs.writeFile(
      path.join(freshellDir, 'config.json'),
      JSON.stringify(
        {
          version: 1,
          settings: { codingCli: { enabledProviders: ['claude', 'codex', 'opencode'] } },
        },
        null,
        2,
      ),
    )
  }
}

/**
 * Donor: recover-my-panes-rust.spec.ts:75 (load-bearing comment there):
 * a live shell terminal's cwd pre-fills the Starting-directory combobox the
 * CLI-pane creates below depend on.
 */
async function selectShellIfPickerShowing(page: Page): Promise<void> {
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

/** Donor: recover-my-panes-rust.spec.ts:92 */
async function openCliPane(page: Page, buttonName: RegExp): Promise<void> {
  const picker = await openPanePicker(page)
  await picker.getByRole('button', { name: buttonName }).click({ force: true })
  await page.getByRole('combobox', { name: /Starting directory/i }).press('Enter')
}

/** Read the fake CLI's argv-log JSONL (empty array if not yet written). */
async function readArgvLog(logPath: string): Promise<Array<{ argv: string[] }>> {
  const raw = await fs.readFile(logPath, 'utf8').catch(() => '')
  if (!raw) return []
  return raw.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as { argv: string[] })
}

/**
 * Claude-adapted adjacent-pair matcher (donor: recover-my-panes-rust.spec.ts:111):
 * the fake claude CLI receives the `--resume <id>` FLAG — NOT codex's bare
 * `resume` subcommand token.
 */
const hasClaudeResumePair = (argv: string[], sessionId: string) => {
  const i = argv.indexOf('--resume')
  return i !== -1 && argv[i + 1] === sessionId
}

/** `--session-id <id>` values, in order, from a slice of argv-log entries. */
function sessionIdsOf(entries: Array<{ argv: string[] }>): string[] {
  return entries.flatMap((e) => {
    const i = e.argv.indexOf('--session-id')
    return i >= 0 ? [e.argv[i + 1]] : []
  })
}

/** The server's `/api/terminals` rows. */
async function terminalRows(info: E2eServerInfo): Promise<Array<Record<string, any>>> {
  const response = await fetch(`${info.baseUrl}/api/terminals`, {
    headers: { 'x-auth-token': info.token },
  })
  expect(response.ok, `GET /api/terminals: ${response.status}`).toBe(true)
  return await response.json() as Array<Record<string, any>>
}

/** Rename a terminal's saved name through its route (bounded 429 retry: the
 *  API rate limiter is shared). */
async function renameTerminal(info: E2eServerInfo, terminalId: string, name: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(`${info.baseUrl}/api/terminals/${encodeURIComponent(terminalId)}`, {
      method: 'PATCH',
      headers: { 'x-auth-token': info.token, 'content-type': 'application/json' },
      body: JSON.stringify({ titleOverride: name, nameIntent: 'user' }),
    })
    if (response.ok) return
    if (response.status !== 429 || attempt >= 5) {
      throw new Error(`rename failed: ${response.status} ${await response.text()}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 600))
  }
}

/** Boot a page against the server (donor: recover-my-panes-rust.spec.ts:125). */
async function connect(page: Page, info: { baseUrl: string; token: string }): Promise<TestHarness> {
  await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
  const harness = new TestHarness(page)
  await harness.waitForHarness()
  await harness.waitForConnection()
  return harness
}

/**
 * One owned server per rig: each test needs a DIFFERENT fake-CLI behavior
 * env, and the invocation counter (FAKE_CRASH_STATE_FILE) must start at zero
 * for the exactly-N assertions to be meaningful.
 */
interface Rig {
  root: string
  argvLog: string
  server: RustServer
  info: E2eServerInfo
}

async function bootRig(prefix: string, behaviorEnv: Record<string, string>): Promise<Rig> {
  ensureRustServerBuilt()
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `agent-crash-e2e-${prefix}-`))
  const argvLog = path.join(root, 'claude-argv.jsonl')
  const fakeCliPath = await installFakeCli(path.join(root, 'bin'), 'claude', 'fake-crashing-claude-cli.mjs')
  const server = new RustServer({
    env: {
      CLAUDE_CMD: fakeCliPath,
      FAKE_CLAUDE_ARGV_LOG: argvLog,
      FAKE_CRASH_STATE_FILE: path.join(root, 'crash-state'),
      FRESHELL_AUTO_RESUME_DELAYS_MS: '100,200', // fast retries for CI
      ...behaviorEnv,
    },
    setupHome: seedConfig(),
  })
  const info = await server.start()
  return { root, argvLog, server, info }
}

async function teardownRig(rig: Rig | undefined): Promise<void> {
  await rig?.server.stop().catch(() => {})
  if (rig?.root) await fs.rm(rig.root, { recursive: true, force: true }).catch(() => {})
}

interface RigPage {
  rig: Rig
  context: BrowserContext
  page: Page
}

async function bootRigPage(
  browser: Browser,
  prefix: string,
  behaviorEnv: Record<string, string>,
): Promise<RigPage> {
  const rig = await bootRig(prefix, behaviorEnv)
  try {
    const { context, page } = await createFreshE2ePage(browser, rig.info)
    return { rig, context, page }
  } catch (error) {
    await teardownRig(rig)
    throw error
  }
}

async function teardownRigPage(rigPage: RigPage | undefined): Promise<void> {
  await rigPage?.context.close().catch(() => {})
  await teardownRig(rigPage?.rig)
}

/** Connect, ensure a live shell terminal, then create a claude pane via the UI. */
async function createClaudePane(page: Page, info: E2eServerInfo): Promise<TestHarness> {
  const harness = await connect(page, info)
  await selectShellIfPickerShowing(page)
  await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })
  await openCliPane(page, /^Claude CLI$/i)
  return harness
}

/** The auto-resume notice strip (role=status, TerminalExitBanner.tsx) — the
 *  filter excludes unrelated role=status surfaces (offline / attach-recovery).
 *  Matches BOTH the in-flight recovering notice ("auto-resuming") and the
 *  persistent crash trace ("auto-resumed at HH:MM"). */
const autoResumeNotice = (page: Page) => page.getByRole('status').filter({ hasText: /auto-resum/ })

/** ONLY the in-flight recovering notice (znhn#1 retired the ephemeral
 *  'resumed' strip; the persistent crash trace says "auto-resumed at"). */
const recoveringNotice = (page: Page) => page.getByRole('status').filter({ hasText: /auto-resuming/ })

test.describe('agent crash auto-resume (rust only)', () => {
  // Pay any cold cargo release build inside a generous HOOK timeout, not a
  // test timeout (donor: recover-my-panes-rust.spec.ts's beforeAll). With
  // fullyParallel this runs once per worker; cargo no-ops when already built.
  test.beforeAll(async () => {
    test.setTimeout(1_200_000)
    ensureRustServerBuilt()
  })

  test('crash → bounded auto-resume with --resume <same id> and a visible notice', async ({ browser }) => {
    test.setTimeout(240_000)
    let rigPage: RigPage | undefined
    try {
      // FAKE_CRASH_MODE=once: invocation 1 crashes (exit 1), invocation 2 survives.
      rigPage = await bootRigPage(browser, 'once', { FAKE_CRASH_MODE: 'once' })
      const { rig, page } = rigPage
      await createClaudePane(page, rig.info)

      // The session id the server minted for invocation 1: the WS/picker
      // create path pre-allocates `--session-id <uuid>` (terminal.rs:969-982).
      let sessionId = ''
      await expect(async () => {
        const sid = sessionIdsOf(await readArgvLog(rig!.argvLog))[0]
        expect(sid, 'fake claude received a pre-allocated --session-id').toBeTruthy()
        sessionId = sid!
      }).toPass({ timeout: 30_000 })

      // Auto-resume proof: 2 invocations total, and invocation 2 carries the
      // adjacent pair `--resume <same id>`.
      await expect(async () => {
        const entries = await readArgvLog(rig!.argvLog)
        expect(entries.length, 'one crash + one auto-resume').toBe(2)
        expect(
          hasClaudeResumePair(entries[1].argv, sessionId),
          `invocation 2 must be \`--resume ${sessionId}\``,
        ).toBe(true)
      }).toPass({ timeout: 30_000 })

      // UI: the auto-resume surface is visible (znhn#1: the persistent crash
      // trace — "crashed & auto-resumed at HH:MM" — replaced the ephemeral
      // resumed strip and persists until dismissed, so this cannot race the
      // 100ms recovering window)...
      await expect(autoResumeNotice(page)).toBeVisible({ timeout: 15_000 })
      // ...and the pane is back to a live terminal: no role=alert error bar,
      // and the claude pane's content settles on a running terminal.
      await expect(page.getByRole('alert')).toHaveCount(0)
      await expect(async () => {
        const state = await new TestHarness(page).getState()
        const leaves: any[] = []
        const walk = (node: any) => {
          if (!node) return
          if (node.type === 'leaf') { leaves.push(node); return }
          for (const child of node.children ?? []) walk(child)
        }
        for (const tab of state?.tabs?.tabs ?? []) walk(state?.panes?.layouts?.[tab.id])
        const claude = leaves.find((l) => l?.content?.kind === 'terminal' && l.content.mode === 'claude')
        expect(claude, 'a claude pane exists').toBeTruthy()
        expect(claude.content.status).toBe('running')
        expect(claude.content.terminalId).toBeTruthy()
      }).toPass({ timeout: 30_000 })
    } finally {
      await teardownRigPage(rigPage)
    }
  })

  // Name reliability (Task 10): the auto-resume respawn's replacement row is
  // bound to the SAME durable session, so it carries the saved name (it was
  // titled "Claude CLI (auto-resumed)" with no naming binding at all).
  test('the auto-resumed terminal keeps its saved name', async ({ browser }) => {
    test.setTimeout(240_000)
    let rigPage: RigPage | undefined
    try {
      // Invocation 1 stays alive until the test sends `crash-now`; every
      // invocation writes the transcript the claude naming lane verifies the
      // pane's pending name against.
      rigPage = await bootRigPage(browser, 'named', {
        FAKE_CRASH_ON_LINE: 'crash-now',
        FAKE_CLAUDE_TRANSCRIPT: '1',
      })
      const { rig, page } = rigPage
      await createClaudePane(page, rig.info)

      let sessionId = ''
      await expect(async () => {
        const sid = sessionIdsOf(await readArgvLog(rig!.argvLog))[0]
        expect(sid, 'fake claude received a pre-allocated --session-id').toBeTruthy()
        sessionId = sid!
      }).toPass({ timeout: 30_000 })

      // The pane's pending name is bound onto the durable session.
      let originalTerminalId = ''
      await expect(async () => {
        const row = (await terminalRows(rig!.info)).find((candidate) =>
          candidate.mode === 'claude' && candidate.status === 'running')
        expect(row?.nameRef, 'the claude row is bound to its durable session').toEqual({
          kind: 'session', provider: 'claude', sessionId,
        })
        originalTerminalId = row!.terminalId
      }).toPass({ timeout: 30_000 })

      // Rename it, then crash the CLI.
      await renameTerminal(rig.info, originalTerminalId, 'Survivor')
      await expect(async () => {
        const row = (await terminalRows(rig!.info)).find((candidate) =>
          candidate.terminalId === originalTerminalId)
        expect(row?.sessionName?.name).toBe('Survivor')
      }).toPass({ timeout: 30_000 })
      await page.evaluate((terminalId: string) => {
        window.__FRESHELL_TEST_HARNESS__?.sendWsMessage({
          type: 'terminal.input', terminalId, data: 'crash-now\r',
        })
      }, originalTerminalId)

      // Auto-resume: invocation 2 is `--resume <same id>`.
      await expect(async () => {
        const entries = await readArgvLog(rig!.argvLog)
        expect(entries.length, 'one crash + one auto-resume').toBe(2)
        expect(hasClaudeResumePair(entries[1].argv, sessionId)).toBe(true)
      }).toPass({ timeout: 30_000 })

      // The replacement row carries the saved name...
      let resumedTerminalId = ''
      await expect(async () => {
        const row = (await terminalRows(rig!.info)).find((candidate) =>
          candidate.mode === 'claude'
          && candidate.status === 'running'
          && candidate.terminalId !== originalTerminalId)
        expect(row, 'the auto-resumed row is listed').toBeTruthy()
        expect(row!.sessionName?.name).toBe('Survivor')
        expect(row!.title).toBe('Survivor')
        resumedTerminalId = row!.terminalId
      }).toPass({ timeout: 30_000 })

      // ...and the Overview card shows it.
      await page.getByTitle('Panes (Ctrl+B O)').click()
      const card = page.locator(`[data-terminal-id="${resumedTerminalId}"]`)
      await expect(card).toBeVisible({ timeout: 15_000 })
      await expect(card).toContainText('Survivor', { timeout: 15_000 })
    } finally {
      await teardownRigPage(rigPage)
    }
  })

  test('instantly re-crashing CLI exhausts retries and settles with a loud banner', async ({ browser }) => {
    test.setTimeout(240_000)
    let rigPage: RigPage | undefined
    try {
      // FAKE_CRASH_MODE=always: every invocation exits 1 immediately.
      rigPage = await bootRigPage(browser, 'always', { FAKE_CRASH_MODE: 'always' })
      const { rig, page } = rigPage
      await createClaudePane(page, rig.info)

      // Converge to EXACTLY 3 invocations (1 original + 2 retries)...
      await expect(async () => {
        const entries = await readArgvLog(rig!.argvLog)
        expect(entries.length, '1 original + 2 bounded retries').toBe(3)
      }).toPass({ timeout: 30_000 })
      // ...and STAY there for 1s (no unbounded retry storm).
      await page.waitForTimeout(1_000)
      expect((await readArgvLog(rig.argvLog)).length, 'retry budget must stay exhausted').toBe(3)

      // UI: loud role=alert bar with the exit code and the Relaunch button.
      const alert = page.getByRole('alert').filter({ hasText: 'process exited (code 1)' })
      await expect(alert).toBeVisible({ timeout: 15_000 })
      await expect(page.getByRole('button', { name: 'Relaunch claude session' })).toBeVisible()
    } finally {
      await teardownRigPage(rigPage)
    }
  })

  test('clean exit (code 0) neither resumes nor alarms', async ({ browser }) => {
    test.setTimeout(240_000)
    let rigPage: RigPage | undefined
    try {
      // FAKE_CRASH_MODE=clean: prints then exits 0.
      rigPage = await bootRigPage(browser, 'clean', { FAKE_CRASH_MODE: 'clean' })
      const { rig, page } = rigPage
      await createClaudePane(page, rig.info)

      // The single clean-exit invocation lands...
      await expect(async () => {
        expect((await readArgvLog(rig!.argvLog)).length).toBe(1)
      }).toPass({ timeout: 30_000 })
      // ...and after a 1s grace no auto-resume respawn has been attempted.
      await page.waitForTimeout(1_000)
      expect((await readArgvLog(rig.argvLog)).length, 'clean exit must never auto-resume').toBe(1)

      // Quiet exited presentation: no alert bar, no auto-resume notice.
      await expect(page.getByRole('alert')).toHaveCount(0)
      await expect(autoResumeNotice(page)).toHaveCount(0)
    } finally {
      await teardownRigPage(rigPage)
    }
  })

  test('Relaunch button drives a resume with the same session id', async ({ browser }) => {
    test.setTimeout(240_000)
    let rigPage: RigPage | undefined
    try {
      // FAKE_CRASH_UNTIL=3 and NO FAKE_CRASH_MODE: invocations 1..3 crash
      // (exit 1) and invocation 4 SURVIVES as a long-running process — the
      // fixture's FAKE_CRASH_UNTIL branch takes precedence over the mode
      // checks, so the 'clean' default can never exit-0 the surviving
      // invocation and vacuously satisfy the liveness assertions below.
      rigPage = await bootRigPage(browser, 'until3', { FAKE_CRASH_UNTIL: '3' })
      const { rig, page } = rigPage
      await createClaudePane(page, rig.info)

      // The session id minted for invocation 1 (see test 1).
      let sessionId = ''
      await expect(async () => {
        const sid = sessionIdsOf(await readArgvLog(rig!.argvLog))[0]
        expect(sid, 'fake claude received a pre-allocated --session-id').toBeTruthy()
        sessionId = sid!
      }).toPass({ timeout: 30_000 })

      // Settles exhausted after 3 invocations (1 original + 2 retries) with
      // the alert bar and the Relaunch button.
      await expect(async () => {
        expect((await readArgvLog(rig!.argvLog)).length).toBe(3)
      }).toPass({ timeout: 30_000 })
      const alert = page.getByRole('alert').filter({ hasText: 'process exited (code 1)' })
      await expect(alert).toBeVisible({ timeout: 15_000 })
      const relaunch = page.getByRole('button', { name: 'Relaunch claude session' })
      await expect(relaunch).toBeVisible()

      await relaunch.click()

      // Invocation 4 appears with the adjacent pair `--resume <same id>`.
      await expect(async () => {
        const entries = await readArgvLog(rig!.argvLog)
        expect(entries.length, 'relaunch spawns invocation 4').toBe(4)
        expect(
          hasClaudeResumePair(entries[3].argv, sessionId),
          `invocation 4 must be \`--resume ${sessionId}\``,
        ).toBe(true)
      }).toPass({ timeout: 30_000 })

      // The alert bar disappears.
      await expect(page.getByRole('alert')).toHaveCount(0, { timeout: 15_000 })

      // Genuinely LIVE: the argv log stays at EXACTLY 4 invocations for >=1s
      // (a clean exit-0 would re-settle the pane; a crash would append
      // invocation 5), and neither the alert bar nor an in-flight recovering
      // notice reappears in that window. (The persistent crash trace from the
      // earlier successful auto-resumes legitimately remains — znhn#1 — so
      // the assertion targets the RECOVERING notice specifically.)
      await page.waitForTimeout(1_000)
      expect((await readArgvLog(rig.argvLog)).length, 'invocation 4 must stay alive').toBe(4)
      await expect(page.getByRole('alert')).toHaveCount(0)
      await expect(recoveringNotice(page)).toHaveCount(0)
    } finally {
      await teardownRigPage(rigPage)
    }
  })

  test('a persistent crash trace survives reload and is dismissible', async ({ browser }) => {
    test.setTimeout(240_000)
    let rigPage: RigPage | undefined
    try {
      rigPage = await bootRigPage(browser, 'trace', { FAKE_CRASH_MODE: 'once' })
      const { rig, page } = rigPage
      await createClaudePane(page, rig.info)

      const trace = page.getByTestId('crash-trace')
      await expect(trace).toBeVisible({ timeout: 30_000 })
      await expect(trace).toHaveText(/claude crashed \(exit 1\) & auto-resumed at \d{2}:\d{2}/)
      await expect(page.getByRole('alert')).toHaveCount(0)

      // The morning-user scenario: the trace survives a reload.
      await page.reload()
      await connect(page, rig.info)
      await expect(page.getByTestId('crash-trace')).toBeVisible({ timeout: 30_000 })

      // Dismiss → gone, and STAYS gone across another reload.
      await page.getByRole('button', { name: 'Dismiss claude crash notice' }).click()
      await expect(page.getByTestId('crash-trace')).toHaveCount(0)
      await page.reload()
      await connect(page, rig.info)
      await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })
      await expect(page.getByTestId('crash-trace')).toHaveCount(0)
    } finally {
      await teardownRigPage(rigPage)
    }
  })

  test('a flap loop trips the circuit breaker: settles with the crashed-N-times banner', async ({ browser }) => {
    test.setTimeout(240_000)
    let rigPage: RigPage | undefined
    try {
      rigPage = await bootRigPage(browser, 'flap', {
        FAKE_CRASH_MODE: 'always',
        FAKE_CRASH_LIVE_MS: '1000',
        FRESHELL_AUTO_RESUME_DELAYS_MS: '100,200',
        // Each 1s generation counts as "healthy" (budget resets — the
        // forever-loop precondition) and stays under the registry window so
        // the generation cap never preempts the breaker.
        FRESHELL_AUTO_RESUME_HEALTHY_LIFETIME_MS: '500',
        FRESHELL_RESPAWN_LIVENESS_WINDOW_MS: '500',
        FRESHELL_AUTO_RESUME_MAX_CYCLES: '3',
      })
      const { rig, page } = rigPage
      await createClaudePane(page, rig.info)

      const alert = page.getByRole('alert').filter({ hasText: 'claude crashed 3 times — auto-resume paused' })
      await expect(alert).toBeVisible({ timeout: 60_000 })

      // Bounded: 1 original + 3 auto-resumes, then nothing more.
      await expect(async () => {
        expect((await readArgvLog(rig!.argvLog)).length).toBe(4)
      }).toPass({ timeout: 15_000 })
      await page.waitForTimeout(3_000)
      expect((await readArgvLog(rig.argvLog)).length, 'breaker must stay open').toBe(4)
      await expect(page.getByRole('button', { name: 'Relaunch claude session' })).toBeVisible()
    } finally {
      await teardownRigPage(rigPage)
    }
  })

  test('cancel clears the recovering notice immediately and no respawn happens', async ({ browser }) => {
    test.setTimeout(240_000)
    let rigPage: RigPage | undefined
    try {
      // Long backoff = a wide window where the OLD behavior would have lied
      // for 30s (znhn#3) and no window at all for the alert bar (znhn#6).
      // FAKE_CRASH_LIVE_MS keeps invocation 1 alive ~5s so the pane-creation
      // choreography fully settles BEFORE the crash: the cancel click then
      // lands early in the 8s backoff (observed: a crash mid-choreography
      // pushed the click past the first backoff, so attempt 1 had already
      // respawned before the cancel could land).
      rigPage = await bootRigPage(browser, 'cancel', {
        FAKE_CRASH_MODE: 'always',
        FAKE_CRASH_LIVE_MS: '5000',
        FRESHELL_AUTO_RESUME_DELAYS_MS: '8000,8000',
      })
      const { rig, page } = rigPage
      await createClaudePane(page, rig.info)

      await expect(recoveringNotice(page)).toBeVisible({ timeout: 30_000 })
      await page.getByRole('button', { name: 'Cancel auto-resume for claude' }).click()

      // Settle frame, not TTL: the notice clears within seconds, the loud
      // alert takes its place.
      await expect(recoveringNotice(page)).toHaveCount(0, { timeout: 3_000 })
      await expect(page.getByRole('alert').filter({ hasText: 'process exited (code 1)' })).toBeVisible({ timeout: 5_000 })

      // The planned respawn was guard-aborted: still only 1 invocation.
      await page.waitForTimeout(10_000)
      expect((await readArgvLog(rig.argvLog)).length, 'cancel must abort the planned respawn').toBe(1)
    } finally {
      await teardownRigPage(rigPage)
    }
  })
})
