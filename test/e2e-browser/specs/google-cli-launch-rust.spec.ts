import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test, expect } from '../helpers/fixtures.js'
import { createE2eServerHandle } from '../helpers/external-target.js'
import { TestHarness } from '../helpers/test-harness.js'
import { openPanePicker } from '../helpers/pane-picker.js'
import type { Page } from '@playwright/test'

/**
 * GOOGLE CLI LAUNCH (plan Task 11, docs/plans/2026-10-29-google-cli-
 * first-class-support.md) — the launch acceptance for first-class
 * Antigravity CLI (`agy`, provider `antigravity`) terminal panes on the
 * Rust server, plus the launch half of the gemini-preservation
 * requirement: everything here runs against deterministic FAKE binaries
 * (Task 10's store-writing `fake-agy-terminal.mjs` via `ANTIGRAVITY_CMD`
 * and the harness-03 `fake-gemini.mjs` via `GEMINI_CMD`), so no real
 * provider binary is ever invoked.
 *
 * Six scenarios, per-test owned servers (the codex-terminal-restore /
 * sidebar-registry-sync per-test model — each test needs its own env
 * overrides and its own isolated HOME):
 *
 *   1. picker: the "Antigravity CLI" tile (manifest label,
 *      extensions/antigravity/freshell.json) → the directory combobox → a
 *      leaf with `content.mode === 'antigravity'` whose buffer shows the
 *      fake's `agy> ` prompt;
 *   2. REST: `POST /api/tabs {mode:'antigravity', cwd}` creates the pane
 *      (request shape: donor sidebar-registry-sync-rust.spec.ts:275);
 *   3. argv: the fake's argv log (FAKE_AGY_TERMINAL_ARGV_LOG) proves the
 *      manifest-compiled launch contract end-to-end — `-i` present, the
 *      headless `-p`/`--print`/`--prompt` spellings NEVER present
 *      (cli_launch_goldens.rs G-AN1), and `--model <m>` ONLY when a
 *      model setting was configured (`codingCli.providers.antigravity
 *      .model` seeds the settings segment, G-AN3; the unconfigured
 *      absence is pinned by scenarios 1/2/5);
 *   4. errors: `ANTIGRAVITY_CMD=/nonexistent/agy` answers a VISIBLE typed
 *      400 whose message names the provider label and the configured
 *      binary path, with NO pane, NO new tab, and no silent shell
 *      fallback (the rollback contract pinned server-side by
 *      terminal_tabs.rs::create_tab_rollback_on_spawn_failure_...).
 *      DEVIATION from the plan's wording (recorded in the task report):
 *      the message does NOT name the env-var `ANTIGRAVITY_CMD` — the
 *      wrap's env-var hint arm fires only on ErrorKind::NotFound, and a
 *      missing binary dies in portable-pty's own pre-flight as
 *      ErrorKind::Other;
 *   5. CLI client: the retained standalone client's `new-tab --mode
 *      antigravity` — the REAL CLI process (the test/unit/cli/
 *      commands.test.ts `invokeCli` tsx-spawn pattern) against the real
 *      server; its POST body shape is the one that unit test pins
 *      (`{mode:'antigravity', cwd}` — undefined fields drop out of
 *      JSON.stringify — with the `--resume` sessionRef mapping pinned at
 *      commands.test.ts:317), and here that exact POST lands on a live
 *      server and produces a working pane;
 *   6. gemini preservation: the legacy "Gemini" tile still exists
 *      alongside the new tile (antigravity's addition displaced nothing),
 *      still launches a `content.mode === 'gemini'` pane via the
 *      GEMINI_CMD fake with the manifest's NO-argv legacy shape (the
 *      gemini manifest has no `args` — the harness-03 launch ledger
 *      records an empty argv) and the `gemini> ` prompt.
 *
 * Cloud legality: deterministic fakes, generous polls (15-30 s), no
 * wall-clock-sensitive waits, and every selector is role/accessible-name
 * based except the a11y-gate-exempt `.xterm` widget root and value-carrying
 * attribute selectors.
 */

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Task 10's store-writing terminal fake (the ANTIGRAVITY_CMD surface — NOT
// the harness-03 fake-agy.mjs adapter) and the harness-03 gemini adapter.
const FAKE_AGY_TERMINAL_SOURCE = path.resolve(__dirname, '../fixtures/fake-agy-terminal.mjs')
const FAKE_GEMINI_SOURCE = path.resolve(__dirname, '../fixtures/providers/fake-gemini.mjs')

// The retained standalone CLI, driven from source exactly the way
// test/unit/cli/commands.test.ts spawns it (tsx import loader).
const CLI_ENTRY = path.resolve(__dirname, '../../../tools/freshell-cli/index.ts')
const require = createRequire(import.meta.url)
const tsxLoader = pathToFileURL(require.resolve('tsx')).href

/** The home seed shared by the launch scenarios: both providers enabled. */
const SEEDED_PROVIDERS = ['antigravity', 'gemini']

/** The model the configured-model scenario seeds via provider settings. */
const SEEDED_MODEL = 'model-x'

/**
 * Copy-then-chmod a fake CLI into a throwaway bin dir — the
 * installFakeCli pattern (sidebar-registry-sync-rust.spec.ts:37,
 * mcp-qa-smoke-rust.spec.ts:46). Helpers are per-spec-owned by
 * convention: copied, not imported.
 */
async function installFakeCli(binDir: string, source: string, execName: string): Promise<string> {
  await fs.mkdir(binDir, { recursive: true })
  const target = path.join(binDir, execName)
  await fs.copyFile(source, target)
  await fs.chmod(target, 0o755)
  return target
}

/**
 * setupHome seeding (the codex-terminal-restore-rust.spec.ts:189-198
 * model): `codingCli.enabledProviders` gates the PanePicker's CLI tiles
 * (`src/components/panes/PanePicker.tsx`'s cliOptions filter), and the
 * optional `providers` entry seeds the per-provider settings segment the
 * launch resolver reads (`codingCli.providers[mode].model`,
 * freshell-ws/src/terminal.rs `cli_provider_settings`).
 */
function seedHome(
  enabledProviders: string[],
  providers?: Record<string, { model?: string }>,
): (homeDir: string) => Promise<void> {
  return async (homeDir: string) => {
    const freshellDir = path.join(homeDir, '.freshell')
    await fs.mkdir(freshellDir, { recursive: true })
    await fs.writeFile(path.join(freshellDir, 'config.json'), JSON.stringify({
      version: 1,
      settings: {
        codingCli: {
          enabledProviders,
          ...(providers ? { providers } : {}),
        },
      },
    }, null, 2))
  }
}

// Copied VERBATIM from sidebar-registry-sync-rust.spec.ts:52-66 (donor
// remote-tab-linkage-rust.spec.ts:60-74).
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

// Copied VERBATIM from sidebar-registry-sync-rust.spec.ts:69-79 (donor
// remote-tab-linkage-rust.spec.ts:76-86).
async function bootAndConnect(
  page: Page,
  info: { baseUrl: string; token: string },
): Promise<TestHarness> {
  await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
  const harness = new TestHarness(page)
  await harness.waitForHarness()
  await harness.waitForConnection()
  await selectShellIfPickerShowing(page)
  return harness
}

/** Read the fake CLI's argv-log JSONL (empty array if not yet written).
 * Copied from sidebar-registry-sync-rust.spec.ts:83 (donor
 * codex-terminal-restore-rust.spec.ts:96). */
async function readArgvLog(logPath: string): Promise<Array<{ argv: string[] }>> {
  const raw = await fs.readFile(logPath, 'utf8').catch(() => '')
  if (!raw) return []
  return raw.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as { argv: string[] })
}

/** Read the harness-03 launch ledger (fixture-core.mjs appendLaunchLedger
 * rows: `{t, pid, provider, argv, cwd, env}`). */
async function readLaunchLedger(logPath: string): Promise<Array<{ provider: string; argv: string[] }>> {
  const raw = await fs.readFile(logPath, 'utf8').catch(() => '')
  if (!raw) return []
  return raw.trim().split('\n').filter(Boolean)
    .map((line) => JSON.parse(line) as { provider: string; argv: string[] })
}

/** Flatten a pane layout tree into its leaf nodes (donor
 * codex-terminal-restore-rust.spec.ts:119). */
function collectLeaves(node: any): any[] {
  if (!node) return []
  if (node.type === 'leaf') return [node]
  if (node.type === 'split') return (node.children ?? []).flatMap(collectLeaves)
  return []
}

/** Every terminal leaf of the given mode currently in a tab's layout. */
function findModeLeaves(layout: any, mode: string): any[] {
  return collectLeaves(layout).filter((leaf) => leaf?.content?.mode === mode)
}

/**
 * The interactive-launch argv contract every fresh antigravity spawn must
 * satisfy (the G-AN goldens, asserted here end-to-end through the fake's
 * argv log): `-i` present, the headless print spellings never present,
 * and never the weaker `--continue` cache mechanism (Global Constraint 2).
 */
function expectInteractiveAntigravityArgv(argv: string[]): void {
  expect(argv, `argv: ${JSON.stringify(argv)}`).toContain('-i')
  expect(argv).not.toContain('-p')
  expect(argv).not.toContain('--print')
  expect(argv).not.toContain('--prompt')
  expect(argv).not.toContain('--continue')
}

/**
 * POST with a bounded retry on the shared API rate limiter (429) — copied
 * from unified-agent-names-modes.ts:174 (per-spec-ownership convention).
 */
async function postJsonRetry429(url: string, body: unknown, token: string): Promise<Response> {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'x-auth-token': token, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (response.ok || response.status !== 429 || attempt >= 5) return response
    await new Promise((resolve) => setTimeout(resolve, 600))
  }
}

/**
 * Spawn the REAL standalone CLI from source — the exact
 * test/unit/cli/commands.test.ts `invokeCli` pattern (tsx import loader on
 * tools/freshell-cli/index.ts, FRESHELL_URL/FRESHELL_TOKEN env) — and
 * collect its exit code and streams. Timeout is generous for the cloud
 * lane's tsx compile under contention.
 */
async function invokeRealCli(
  args: string[],
  info: { baseUrl: string; token: string },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, ['--import', tsxLoader, CLI_ENTRY, ...args], {
    env: {
      ...process.env,
      NODE_NO_WARNINGS: '1',
      FRESHELL_URL: info.baseUrl,
      FRESHELL_TOKEN: info.token,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += String(chunk) })
  child.stderr.on('data', (chunk) => { stderr += String(chunk) })
  const [code] = await once(child, 'close')
  return { code: code as number | null, stdout, stderr }
}

/**
 * Open a new pane via the picker and select the "Antigravity CLI" tile —
 * the openCodexPane model (codex-terminal-restore-rust.spec.ts:112-116):
 * tile → follow-up "Starting directory for Antigravity CLI" combobox,
 * pre-filled and focused, Enter accepts it as-is.
 */
async function openAntigravityPane(page: Page): Promise<void> {
  const picker = await openPanePicker(page)
  await picker.getByRole('button', { name: /^Antigravity CLI$/i }).click({ force: true })
  await page.getByRole('combobox', { name: /Starting directory for Antigravity CLI/i }).press('Enter')
}

/**
 * Open a new gemini pane the same way, asserting FIRST that the legacy
 * "Gemini" tile and the new "Antigravity CLI" tile COEXIST — antigravity's
 * addition displaced nothing in the picker.
 */
async function openGeminiPaneWithCoexistencePin(page: Page): Promise<void> {
  const picker = await openPanePicker(page)
  await expect(picker.getByRole('button', { name: /^Gemini$/i })).toBeVisible()
  await expect(picker.getByRole('button', { name: /^Antigravity CLI$/i })).toBeVisible()
  await picker.getByRole('button', { name: /^Gemini$/i }).click({ force: true })
  await page.getByRole('combobox', { name: /Starting directory for Gemini/i }).press('Enter')
}

/**
 * Run `open`, then return the NEWLY-added leaf of `mode` — identified by
 * diffing the leaf set before vs after (the openCodexPaneAndGetLeaf model,
 * codex-terminal-restore-rust.spec.ts:137-154): a fresh pane's
 * `content.terminalId` isn't known until the create round-trip completes.
 */
async function openModePaneAndGetLeaf(
  page: Page,
  harness: TestHarness,
  tabId: string,
  mode: string,
  open: () => Promise<void>,
): Promise<any> {
  const beforeIds = new Set(
    findModeLeaves(await harness.getPaneLayout(tabId), mode).map((leaf) => leaf.id),
  )
  await open()
  await expect(page.locator('.xterm').last()).toBeVisible({ timeout: 20_000 })
  await expect.poll(async () => {
    const layout = await harness.getPaneLayout(tabId)
    const newLeaf = findModeLeaves(layout, mode).find((leaf) => !beforeIds.has(leaf.id))
    return newLeaf?.content?.terminalId ? newLeaf : null
  }, { timeout: 20_000 }).not.toBeNull()
  const layout = await harness.getPaneLayout(tabId)
  const newLeaf = findModeLeaves(layout, mode).find((leaf) => !beforeIds.has(leaf.id))
  if (!newLeaf) throw new Error(`no new ${mode} leaf appeared after the picker launch`)
  return newLeaf
}

/**
 * GET /api/tabs tab count through the automation envelope — the route
 * answers ok_json({tabs, activeTabId}), i.e. `{status:'ok', data:{tabs}}`
 * (terminal_tabs.rs list_tabs; envelope pinned by automation-layout-rust).
 */
async function fetchTabCount(info: { baseUrl: string; token: string }): Promise<number> {
  const body = await fetch(`${info.baseUrl}/api/tabs`, { headers: { 'x-auth-token': info.token } })
    .then((r) => r.json() as Promise<{ data?: { tabs?: unknown[] } }>)
  return body?.data?.tabs?.length ?? 0
}

test.describe('Google CLI launch (Rust): antigravity first-class, gemini preserved', () => {
  test.setTimeout(150_000)

  test('scenario 1 (picker): the Antigravity CLI tile launches an interactive antigravity pane (agy -i, never -p)', async ({ page }) => {
    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-google-cli-launch-'))
    const agyArgLog = path.join(sharedRoot, 'fake-agy-terminal-argv.jsonl')
    try {
      const fakeAgyPath = await installFakeCli(path.join(sharedRoot, 'bin'), FAKE_AGY_TERMINAL_SOURCE, 'agy')
      // The gemini adapter has sibling imports (terminal-cli.mjs →
      // fixture-core.mjs), so GEMINI_CMD points at the REPO file directly
      // (the unified-agent-names-cross-mode.spec.ts:258 pattern) — a
      // copy-then-chmod clone would strand its relative imports.
      const fakeGeminiPath = FAKE_GEMINI_SOURCE

      const server = await createE2eServerHandle(process.env, {
        construct: {
          env: {
            ANTIGRAVITY_CMD: fakeAgyPath,
            GEMINI_CMD: fakeGeminiPath,
            FAKE_AGY_TERMINAL_ARGV_LOG: agyArgLog,
          },
          setupHome: seedHome(SEEDED_PROVIDERS),
        },
      })
      const info = await server.start()
      try {
        const harness = await bootAndConnect(page, info)
        await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })
        const tabId = await harness.getActiveTabId()
        expect(tabId).toBeTruthy()

        // tile → directory combobox → leaf `content.mode === 'antigravity'`
        const leaf = await openModePaneAndGetLeaf(page, harness, tabId!, 'antigravity', () => openAntigravityPane(page))
        expect(leaf?.content?.mode).toBe('antigravity')
        const terminalId: string = leaf?.content?.terminalId
        expect(terminalId).toBeTruthy()

        // the fake's `agy> ` prompt reached the pane's terminal buffer
        await expect.poll(async () => {
          const buffer = await harness.getTerminalBuffer(terminalId)
          return typeof buffer === 'string' && buffer.includes('agy> ')
        }, { timeout: 20_000 }).toBe(true)

        // argv contract (G-AN1): interactive `-i`, never the headless
        // spellings, no model (none configured), never `--continue`.
        await expect.poll(async () => (await readArgvLog(agyArgLog)).length, { timeout: 15_000 })
          .toBeGreaterThan(0)
        const entries = await readArgvLog(agyArgLog)
        expect(entries.length).toBe(1)
        expectInteractiveAntigravityArgv(entries[0].argv)
        expect(entries[0].argv).not.toContain('--model')
      } finally {
        await server.stop().catch(() => {})
      }
    } finally {
      await fs.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })

  test('scenario 2 (REST): POST /api/tabs {mode:"antigravity", cwd} creates an antigravity pane', async ({ page }) => {
    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-google-cli-launch-'))
    const agyArgLog = path.join(sharedRoot, 'fake-agy-terminal-argv.jsonl')
    try {
      const fakeAgyPath = await installFakeCli(path.join(sharedRoot, 'bin'), FAKE_AGY_TERMINAL_SOURCE, 'agy')
      // The gemini adapter has sibling imports (terminal-cli.mjs →
      // fixture-core.mjs), so GEMINI_CMD points at the REPO file directly
      // (the unified-agent-names-cross-mode.spec.ts:258 pattern) — a
      // copy-then-chmod clone would strand its relative imports.
      const fakeGeminiPath = FAKE_GEMINI_SOURCE

      const server = await createE2eServerHandle(process.env, {
        construct: {
          env: {
            ANTIGRAVITY_CMD: fakeAgyPath,
            GEMINI_CMD: fakeGeminiPath,
            FAKE_AGY_TERMINAL_ARGV_LOG: agyArgLog,
          },
          setupHome: seedHome(SEEDED_PROVIDERS),
        },
      })
      const info = await server.start()
      try {
        const harness = await bootAndConnect(page, info)

        const res = await postJsonRetry429(`${info.baseUrl}/api/tabs`, {
          mode: 'antigravity',
          cwd: sharedRoot,
        }, info.token)
        // Read the body ONCE (an eagerly-evaluated expect message that
        // awaits res.text() consumes the stream and breaks a later
        // res.json()).
        const createText = await res.text()
        expect(res.ok, `POST /api/tabs antigravity: ${res.status} ${createText}`).toBe(true)
        const body = JSON.parse(createText) as { data?: { tabId?: string; paneId?: string } }
        const restTabId = body?.data?.tabId
        expect(restTabId).toBeTruthy()
        expect(body?.data?.paneId).toBeTruthy()

        // REST creates are focus-neutral by contract: select the returned
        // tab before waiting on its renderer-backed terminal buffer (donor
        // sidebar-registry-sync-rust.spec.ts:284-288).
        await page.locator(`[data-context="tab"][data-tab-id="${restTabId}"]`).click()
        await expect.poll(async () => harness.getActiveTabId(), { timeout: 15_000 }).toBe(restTabId)

        let terminalId: string | null = null
        await expect.poll(async () => {
          const layout = await harness.getPaneLayout(restTabId!)
          const leaf = findModeLeaves(layout, 'antigravity')[0]
          terminalId = leaf?.content?.terminalId ?? null
          return terminalId
        }, { timeout: 20_000 }).toBeTruthy()

        await expect.poll(async () => {
          const buffer = await harness.getTerminalBuffer(terminalId!)
          return typeof buffer === 'string' && buffer.includes('agy> ')
        }, { timeout: 20_000 }).toBe(true)

        // Same launch argv contract through the REST door.
        await expect.poll(async () => (await readArgvLog(agyArgLog)).length, { timeout: 15_000 })
          .toBeGreaterThan(0)
        const entries = await readArgvLog(agyArgLog)
        expect(entries.length).toBe(1)
        expectInteractiveAntigravityArgv(entries[0].argv)
        expect(entries[0].argv).not.toContain('--model')
      } finally {
        await server.stop().catch(() => {})
      }
    } finally {
      await fs.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })

  test('scenario 3 (argv): a configured antigravity model setting adds the adjacent --model pair; unconfigured launches carry none', async ({ page }) => {
    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-google-cli-launch-'))
    const agyArgLog = path.join(sharedRoot, 'fake-agy-terminal-argv.jsonl')
    try {
      const fakeAgyPath = await installFakeCli(path.join(sharedRoot, 'bin'), FAKE_AGY_TERMINAL_SOURCE, 'agy')
      // The gemini adapter has sibling imports (terminal-cli.mjs →
      // fixture-core.mjs), so GEMINI_CMD points at the REPO file directly
      // (the unified-agent-names-cross-mode.spec.ts:258 pattern) — a
      // copy-then-chmod clone would strand its relative imports.
      const fakeGeminiPath = FAKE_GEMINI_SOURCE

      // The ONLY per-test delta: `codingCli.providers.antigravity.model` is
      // seeded, so the WS create door's settings segment renders the
      // manifest's `modelArgs` template. Settings-derived provider config
      // applies on the WS/picker door (`handle_create`'s
      // cli_provider_settings, freshell-ws/src/terminal.rs:6511-6525) — the
      // REST create door takes explicit body values only (terminal_tabs.rs
      // Slice-3a scope note) — so this scenario launches through the PICKER.
      // (The unconfigured absence side of "only when" is pinned by scenarios
      // 1/2/5, whose servers seed no model.)
      const server = await createE2eServerHandle(process.env, {
        construct: {
          env: {
            ANTIGRAVITY_CMD: fakeAgyPath,
            GEMINI_CMD: fakeGeminiPath,
            FAKE_AGY_TERMINAL_ARGV_LOG: agyArgLog,
          },
          setupHome: seedHome(SEEDED_PROVIDERS, { antigravity: { model: SEEDED_MODEL } }),
        },
      })
      const info = await server.start()
      try {
        const harness = await bootAndConnect(page, info)
        await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })
        const tabId = await harness.getActiveTabId()
        expect(tabId).toBeTruthy()

        const leaf = await openModePaneAndGetLeaf(page, harness, tabId!, 'antigravity', () => openAntigravityPane(page))
        expect(leaf?.content?.mode).toBe('antigravity')
        const terminalId: string = leaf?.content?.terminalId
        expect(terminalId).toBeTruthy()

        await expect.poll(async () => {
          const buffer = await harness.getTerminalBuffer(terminalId)
          return typeof buffer === 'string' && buffer.includes('agy> ')
        }, { timeout: 20_000 }).toBe(true)

        await expect.poll(async () => (await readArgvLog(agyArgLog)).length, { timeout: 15_000 })
          .toBeGreaterThan(0)
        const entries = await readArgvLog(agyArgLog)
        expect(entries.length).toBe(1)
        const argv = entries[0].argv
        expectInteractiveAntigravityArgv(argv)
        // G-AN3: the manifest's modelArgs template applies as the ADJACENT
        // pair `--model <configured value>`, verbatim.
        const modelIdx = argv.indexOf('--model')
        expect(modelIdx).not.toBe(-1)
        expect(argv[modelIdx + 1]).toBe(SEEDED_MODEL)
      } finally {
        await server.stop().catch(() => {})
      }
    } finally {
      await fs.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })

  test('scenario 4 (error): a missing ANTIGRAVITY_CMD binary answers a visible typed error naming the configured binary, with no pane and no silent shell fallback', async ({ page }) => {
    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-google-cli-launch-'))
    try {
      // The gemini adapter has sibling imports (terminal-cli.mjs →
      // fixture-core.mjs), so GEMINI_CMD points at the REPO file directly
      // (the unified-agent-names-cross-mode.spec.ts:258 pattern) — a
      // copy-then-chmod clone would strand its relative imports.
      const fakeGeminiPath = FAKE_GEMINI_SOURCE

      // Deliberately NOT installed: the override points at a binary that
      // does not exist anywhere.
      const server = await createE2eServerHandle(process.env, {
        construct: {
          env: {
            ANTIGRAVITY_CMD: '/nonexistent/agy',
            GEMINI_CMD: fakeGeminiPath,
          },
          setupHome: seedHome(SEEDED_PROVIDERS),
        },
      })
      const info = await server.start()
      try {
        const harness = await bootAndConnect(page, info)
        const tabId = await harness.getActiveTabId()
        expect(tabId).toBeTruthy()

        // The pre-state: the boot tab exists, the client synced it into
        // the server's layout mirror, and the active tab holds exactly
        // its boot leaves.
        await expect.poll(async () => fetchTabCount(info), { timeout: 20_000 }).toBe(1)
        const leavesBefore = collectLeaves(await harness.getPaneLayout(tabId!)).length

        const res = await postJsonRetry429(`${info.baseUrl}/api/tabs`, {
          mode: 'antigravity',
          cwd: sharedRoot,
        }, info.token)
        // The create REFUSES — a visible, typed error, not a shell pane.
        expect(res.ok).toBe(false)
        expect(res.status).toBe(400)
        const body = await res.json() as { status?: string; message?: string }
        expect(body?.status).toBe('error')
        // The honest shipped error shape (observed red, recorded as this
        // task's deviation from the plan's "mentioning ANTIGRAVITY_CMD"):
        // wrap_terminal_spawn_error's env-var hint arm fires only on
        // ErrorKind::NotFound, but a missing ANTIGRAVITY_CMD binary dies in
        // portable-pty's OWN spawn pre-flight (cmdbuilder.rs "Unable to
        // spawn ... because it doesn't exist ... or is not executable",
        // an anyhow error surfaced as ErrorKind::Other), so the message
        // names the provider label and the CONFIGURED BINARY PATH — the
        // ANTIGRAVITY_CMD override's exact value — but not the env-var
        // NAME. This pins that honest behavior; the env-var-name hint is
        // flagged in the task report as a product gap for a follow-up.
        const message = String(body?.message)
        expect(message).toContain('Could not start Antigravity CLI')
        expect(message).toContain('/nonexistent/agy')
        expect(message).not.toContain('shell')

        // NO pane and NO silent shell fallback: the failed create rolled
        // back completely — the active tab's leaf set is unchanged (no new
        // pane of ANY mode, shell included), no antigravity leaf exists,
        // and the server's layout mirror still holds exactly the one boot
        // tab. The 400 is returned only after the rollback completes, so
        // these are deterministic post-condition reads, not races.
        const layout = await harness.getPaneLayout(tabId!)
        expect(collectLeaves(layout).length).toBe(leavesBefore)
        expect(findModeLeaves(layout, 'antigravity')).toEqual([])
        expect(await fetchTabCount(info)).toBe(1)
      } finally {
        await server.stop().catch(() => {})
      }
    } finally {
      await fs.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })

  test('scenario 5 (CLI client): the standalone client new-tab --mode antigravity creates the pane end-to-end', async ({ page }) => {
    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-google-cli-launch-'))
    const agyArgLog = path.join(sharedRoot, 'fake-agy-terminal-argv.jsonl')
    try {
      const fakeAgyPath = await installFakeCli(path.join(sharedRoot, 'bin'), FAKE_AGY_TERMINAL_SOURCE, 'agy')
      // The gemini adapter has sibling imports (terminal-cli.mjs →
      // fixture-core.mjs), so GEMINI_CMD points at the REPO file directly
      // (the unified-agent-names-cross-mode.spec.ts:258 pattern) — a
      // copy-then-chmod clone would strand its relative imports.
      const fakeGeminiPath = FAKE_GEMINI_SOURCE

      const server = await createE2eServerHandle(process.env, {
        construct: {
          env: {
            ANTIGRAVITY_CMD: fakeAgyPath,
            GEMINI_CMD: fakeGeminiPath,
            FAKE_AGY_TERMINAL_ARGV_LOG: agyArgLog,
          },
          setupHome: seedHome(SEEDED_PROVIDERS),
        },
      })
      const info = await server.start()
      try {
        const harness = await bootAndConnect(page, info)

        // The REAL retained CLI process. Its POST body for this argv is
        // the shape test/unit/cli/commands.test.ts pins (the same
        // tools/freshell-cli/index.ts new-tab handler: `{mode:'antigravity',
        // cwd}` — undefined fields drop out of the JSON body — with the
        // --resume sessionRef mapping pinned at commands.test.ts:317).
        // Here that exact POST lands on a live server.
        const { code, stdout, stderr } = await invokeRealCli(
          ['new-tab', '--mode', 'antigravity', '--cwd', sharedRoot],
          info,
        )
        expect(stderr, `CLI stderr: ${stderr}`).toBe('')
        expect(code, `CLI exit code ${code}; stdout: ${stdout}`).toBe(0)
        const payload = JSON.parse(stdout) as { status?: string; data?: { tabId?: string; paneId?: string } }
        expect(payload?.status).toBe('ok')
        const cliTabId = payload?.data?.tabId
        expect(cliTabId, `CLI stdout: ${stdout}`).toBeTruthy()
        expect(payload?.data?.paneId).toBeTruthy()

        // The CLI-created tab is focus-neutral: select it, then verify
        // the pane and its terminal like scenario 2.
        await page.locator(`[data-context="tab"][data-tab-id="${cliTabId}"]`).click()
        await expect.poll(async () => harness.getActiveTabId(), { timeout: 15_000 }).toBe(cliTabId)

        let terminalId: string | null = null
        await expect.poll(async () => {
          const layout = await harness.getPaneLayout(cliTabId!)
          const leaf = findModeLeaves(layout, 'antigravity')[0]
          terminalId = leaf?.content?.terminalId ?? null
          return terminalId
        }, { timeout: 20_000 }).toBeTruthy()

        await expect.poll(async () => {
          const buffer = await harness.getTerminalBuffer(terminalId!)
          return typeof buffer === 'string' && buffer.includes('agy> ')
        }, { timeout: 20_000 }).toBe(true)

        // Same launch argv contract through the CLI-driven door.
        await expect.poll(async () => (await readArgvLog(agyArgLog)).length, { timeout: 15_000 })
          .toBeGreaterThan(0)
        const entries = await readArgvLog(agyArgLog)
        expect(entries.length).toBe(1)
        expectInteractiveAntigravityArgv(entries[0].argv)
        expect(entries[0].argv).not.toContain('--model')
      } finally {
        await server.stop().catch(() => {})
      }
    } finally {
      await fs.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })

  test('scenario 6 (gemini preservation): the Gemini tile still launches the legacy no-argv gemini pane', async ({ page }) => {
    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-google-cli-launch-'))
    const geminiLedger = path.join(sharedRoot, 'fake-gemini-launch-ledger.jsonl')
    try {
      const fakeAgyPath = await installFakeCli(path.join(sharedRoot, 'bin'), FAKE_AGY_TERMINAL_SOURCE, 'agy')
      // The gemini adapter has sibling imports (terminal-cli.mjs →
      // fixture-core.mjs), so GEMINI_CMD points at the REPO file directly
      // (the unified-agent-names-cross-mode.spec.ts:258 pattern) — a
      // copy-then-chmod clone would strand its relative imports.
      const fakeGeminiPath = FAKE_GEMINI_SOURCE

      const server = await createE2eServerHandle(process.env, {
        construct: {
          env: {
            ANTIGRAVITY_CMD: fakeAgyPath,
            GEMINI_CMD: fakeGeminiPath,
            // The harness-03 terminal-CLI engine (fixture-core.mjs) records
            // one launch-ledger row per process to FRESHELL_FAKE_LEDGER —
            // the gemini preservation pin reads its argv.
            FRESHELL_FAKE_LEDGER: geminiLedger,
          },
          setupHome: seedHome(SEEDED_PROVIDERS),
        },
      })
      const info = await server.start()
      try {
        const harness = await bootAndConnect(page, info)
        await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })
        const tabId = await harness.getActiveTabId()
        expect(tabId).toBeTruthy()

        // openGeminiPaneWithCoexistencePin asserts the Antigravity tile
        // did not displace the legacy Gemini tile, then launches gemini.
        const leaf = await openModePaneAndGetLeaf(page, harness, tabId!, 'gemini', () => openGeminiPaneWithCoexistencePin(page))
        expect(leaf?.content?.mode).toBe('gemini')
        const terminalId: string = leaf?.content?.terminalId
        expect(terminalId).toBeTruthy()

        await expect.poll(async () => {
          const buffer = await harness.getTerminalBuffer(terminalId)
          return typeof buffer === 'string' && buffer.includes('gemini> ')
        }, { timeout: 20_000 }).toBe(true)

        // LEGACY SHAPE PIN: the gemini manifest (extensions/gemini/
        // freshell.json) carries no `args` — the launched gemini process
        // received an EMPTY argv. Antigravity's `-i` (and its resume/
        // model templates) must never bleed into the gemini launch.
        await expect.poll(async () => (await readLaunchLedger(geminiLedger)).length, { timeout: 15_000 })
          .toBeGreaterThan(0)
        const rows = await readLaunchLedger(geminiLedger)
        expect(rows.length).toBe(1)
        expect(rows[0].provider).toBe('gemini')
        expect(rows[0].argv).toEqual([])
      } finally {
        await server.stop().catch(() => {})
      }
    } finally {
      await fs.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })
})
