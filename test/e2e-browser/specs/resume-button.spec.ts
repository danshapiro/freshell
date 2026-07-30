import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect } from '../helpers/fixtures.js'
import { createE2eServerHandle } from '../helpers/external-target.js'
import { TestHarness } from '../helpers/test-harness.js'

/**
 * RESUME BUTTON -- browser e2e proof for the two spec NFRs jsdom cannot prove
 * (`docs/plans/2026-07-29-resume-session-button.md`, Task 6):
 *
 *   1. Pinned visibility under REAL scrolling: the sidebar footer's "Resume
 *      session..." button stays on-screen at top/middle/bottom scroll of a
 *      genuinely-overflowing session list (40+ seeded codex sessions), and in
 *      fullWidth mobile mode.
 *   2. The paste -> Enter -> real-resume path: pasting a known session id into
 *      the dialog and pressing Enter ends in an actually-spawned CLI whose
 *      argv carries the adjacent `resume <id>` pair (plus the fake CLI's own
 *      terminal-buffer marker).
 *
 * Boot/seed scaffolding is lifted from `sidebar-click-resume.spec.ts` (the
 * direct prior art) with ONE deliberate difference: `CODEX_CMD` points at a
 * DUAL-MODE wrapper, not `fixtures/fake-codex-cli.mjs`. Root cause (see the
 * task brief and the prior art's legacy `test.fixme`): legacy codex
 * terminal-create runs `planCodexLaunch` -> `runtime.ensureReady`, which
 * spawns the SAME `CODEX_CMD` binary FIRST as a JSON-RPC sidecar
 * (`... app-server --listen <ws>`, `server/coding-cli/codex-app-server/
 * runtime.ts:1828-1834`) whose `initialize` handshake gates the PTY spawn.
 * `fake-codex-cli.mjs` never listens on the `--listen` URL, so that create
 * settles into `status: 'error'` -- a fixture/architecture mismatch, not a
 * server bug. The protocol-faithful sidecar fixture
 * (`test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs`, proven by
 * the passing `test/integration/server/codex-session-flow.test.ts`) handles
 * the sidecar mode; the wrapper below handles both modes, so THIS spec goes
 * green on legacy without inheriting the fixme.
 */

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const FAKE_APP_SERVER_SOURCE = path.resolve(
  __dirname,
  '../../fixtures/coding-cli/codex-app-server/fake-app-server.mjs',
)

/** The known target id among the seeded sessions (a real uuid so the parser extracts it). */
const RESUME_ID = '4e3f2a10-9d1c-4b7e-8a55-0c9f6b2d7e31'
/** Filler sessions so the sidebar list genuinely scrolls. */
const FILLER_COUNT = 44
const fillerId = (i: number) => `aaaaaaaa-1111-4111-8111-${String(i).padStart(12, '0')}`

/**
 * Legacy codex terminal-create spawns CODEX_CMD TWICE: first as the JSON-RPC
 * sidecar (`… app-server --listen <ws>`, runtime.ts:1828-1834) whose
 * `initialize` handshake gates the PTY spawn, then as the PTY TUI with the
 * resume argv. fixtures/fake-codex-cli.mjs handles only the second mode —
 * exactly why the prior art is test.fixme on legacy. This wrapper handles both.
 */
async function writeDualModeCodexCli(binDir: string): Promise<string> {
  await fs.mkdir(binDir, { recursive: true })
  const target = path.join(binDir, 'codex')
  const script = `#!/usr/bin/env node
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const argv = process.argv.slice(2)
if (argv.includes('app-server')) {
  // Delegate to the protocol-faithful fixture AT ITS REPO PATH — it has a
  // bare \`import 'ws'\` that must resolve against the repo's node_modules,
  // so it cannot be copied into this tmp bin dir.
  const child = spawn(process.execPath, [${JSON.stringify(FAKE_APP_SERVER_SOURCE)}, ...argv], { stdio: 'inherit' })
  process.on('SIGTERM', () => child.kill('SIGTERM'))
  child.on('exit', (code) => process.exit(code ?? 0))
} else {
  // TUI mode (the PTY): same contract as fixtures/fake-codex-cli.mjs —
  // argv-log JSONL + greppable marker + stay alive. Only this mode logs
  // argv, so the log carries PTY invocations, not sidecar ones.
  const logPath = process.env.FAKE_CODEX_ARGV_LOG
  if (logPath) {
    fs.mkdirSync(path.dirname(logPath), { recursive: true })
    fs.appendFileSync(logPath, JSON.stringify({ pid: process.pid, t: Date.now(), argv }) + '\\n')
  }
  const resumeIndex = argv.indexOf('resume')
  if (resumeIndex !== -1) {
    process.stdout.write('codex: resumed session ' + (argv[resumeIndex + 1] ?? '') + '\\r\\n')
  } else {
    process.stdout.write('codex> \\r\\n')
  }
  process.stdin.resume()
}
`
  await fs.writeFile(target, script, 'utf8')
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

interface ResumeScenario {
  info: { baseUrl: string; token: string }
  argvLogPath: string
  dispose: () => Promise<void>
}

/**
 * Boot a legacy server whose isolated HOME carries 40+ codex sessions (so the
 * sidebar list scrolls) with RESUME_ID among them — same seeding shape as
 * `sidebar-click-resume.spec.ts`'s codex seed (a `session_meta` record with
 * `payload.id`/`cwd` plus `response_item`/`message` records for a real title).
 */
async function bootResumeScenario(e2eServerKind: 'legacy' | 'rust'): Promise<ResumeScenario> {
  const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-resume-button-'))
  const argvLogPath = path.join(sharedRoot, 'fake-codex-argv.jsonl')
  const projectDir = path.join(sharedRoot, 'project')
  await fs.mkdir(projectDir, { recursive: true })
  const fakeCodexPath = await writeDualModeCodexCli(path.join(sharedRoot, 'bin'))

  const writeCodexSession = async (sessionsDir: string, id: string, title: string) => {
    const lines = [
      JSON.stringify({
        timestamp: '2026-07-29T08:00:00.000Z',
        type: 'session_meta',
        payload: { id, cwd: projectDir },
      }),
      JSON.stringify({
        timestamp: '2026-07-29T08:00:01.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: `${title} request 1` }],
        },
      }),
      JSON.stringify({
        timestamp: '2026-07-29T08:00:02.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: `${title} reply 1` }],
        },
      }),
    ]
    await fs.writeFile(path.join(sessionsDir, `${id}.jsonl`), `${lines.join('\n')}\n`)
  }

  const server = await createE2eServerHandle(process.env, {
    kind: e2eServerKind,
    construct: {
      env: { CODEX_CMD: fakeCodexPath, FAKE_CODEX_ARGV_LOG: argvLogPath },
      setupHome: async (homeDir) => {
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
        await writeCodexSession(codexSessionsDir, RESUME_ID, 'resume-button target session')
        for (let i = 0; i < FILLER_COUNT; i++) {
          await writeCodexSession(codexSessionsDir, fillerId(i), `resume-button filler session ${i}`)
        }
      },
    },
  })

  let started = false
  try {
    const info = await server.start()
    started = true
    return {
      info,
      argvLogPath,
      dispose: async () => {
        await server.stop().catch(() => {})
        await fs.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
      },
    }
  } finally {
    if (!started) {
      await fs.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  }
}

test.setTimeout(90_000)

test('resume button stays visible at top/middle/bottom scroll', async ({ page, e2eServerKind }) => {
  const scenario = await bootResumeScenario(e2eServerKind)
  try {
    await bootAndConnect(page, scenario.info)

    const button = page.getByTestId('sidebar-resume-button')
    await expect(button).toBeVisible({ timeout: 15_000 })

    const sessionList = page.getByTestId('sidebar-session-list')
    await expect(sessionList).toBeVisible({ timeout: 15_000 })
    // The seeded 45 sessions must actually render before scroll positions mean anything.
    await expect(page.getByText('resume-button target session', { exact: false }).first())
      .toBeVisible({ timeout: 15_000 })

    for (const fraction of [0, 0.5, 1]) {
      await page.getByTestId('sidebar-session-list').evaluate((el, f) => {
        el.scrollTop = (el.scrollHeight - el.clientHeight) * f
      }, fraction)
      await expect(button).toBeVisible()
      const box = await button.boundingBox()
      const viewport = page.viewportSize()
      expect(box).not.toBeNull()
      expect(box!.y + box!.height).toBeLessThanOrEqual(viewport!.height)
    }
  } finally {
    await scenario.dispose()
  }
})

test('resume button is visible in fullWidth mobile mode', async ({ page, e2eServerKind }) => {
  const scenario = await bootResumeScenario(e2eServerKind)
  try {
    await page.setViewportSize({ width: 390, height: 844 })
    await bootAndConnect(page, scenario.info)

    // Open the sidebar via the mobile control (same approach as
    // mobile-viewport.spec.ts's "Show sidebar" toggle: MobileTabStrip's
    // control carries only aria-label="Show sidebar"; App.tsx's
    // show-sidebar-button testid variant does not render while a terminal
    // tab is active, so the role locator is the one that matches both).
    await page.getByRole('button', { name: /show sidebar/i }).first().click({ timeout: 15_000 })
    await expect(page.getByTestId('sidebar-resume-button')).toBeVisible({ timeout: 15_000 })
  } finally {
    await scenario.dispose()
  }
})

test('paste-then-Enter resumes the session with the right agent', async ({ page, e2eServerKind }) => {
  const scenario = await bootResumeScenario(e2eServerKind)
  try {
    const harness = await bootAndConnect(page, scenario.info)
    const tabCountBefore = await harness.getTabCount()

    await page.getByTestId('sidebar-resume-button').click({ timeout: 15_000 })
    await expect(page.getByTestId('resume-dialog')).toBeVisible()
    await page.getByTestId('resume-input').fill(RESUME_ID)
    await page.getByTestId('resume-input').press('Enter')

    // argv proof — identical mechanism to sidebar-click-resume.spec.ts (the
    // adjacent `resume <id>` pair anywhere in argv, since resumeArgs are
    // appended last):
    await expect
      .poll(async () => {
        const entries = await readArgvLog(scenario.argvLogPath)
        return entries.some(
          ({ argv }) => argv.includes('resume') && argv[argv.indexOf('resume') + 1] === RESUME_ID,
        )
      }, { timeout: 45_000 })
      .toBe(true)

    // Terminal-buffer proof: the fake CLI's own greppable marker, scoped to
    // the newly-opened pane's terminal (same flow as the prior art).
    await expect(async () => {
      const tabCount = await harness.getTabCount()
      expect(tabCount).toBe(tabCountBefore + 1)
    }).toPass({ timeout: 15_000 })
    const newTabId = await harness.getActiveTabId()
    expect(newTabId).toBeTruthy()
    const terminalId: string = await expect.poll(async () => {
      return (await harness.getPaneLayout(newTabId!))?.content?.terminalId ?? null
    }, { timeout: 20_000 }).not.toBeNull().then(async () => {
      return (await harness.getPaneLayout(newTabId!))?.content?.terminalId
    })
    expect(terminalId).toBeTruthy()
    await expect.poll(async () => {
      const buffer = await harness.getTerminalBuffer(terminalId)
      return typeof buffer === 'string' && buffer.includes(`codex: resumed session ${RESUME_ID}`)
    }, { timeout: 20_000 }).toBe(true)
  } finally {
    await scenario.dispose()
  }
})
