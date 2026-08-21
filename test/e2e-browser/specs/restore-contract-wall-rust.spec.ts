/**
 * RESTORE CONTRACT WALL -- P0.1 "the ruler" from
 * docs/plans/2026-07-24-restart-resilience-architecture-analysis.md (§5).
 *
 * One spec that creates every pane type live against fake CLIs, SIGKILLs the
 * Rust server (RustServer.restartAbrupt()), restarts it on the same
 * home/port/token, reconnects, and asserts each pane's restore contract per
 * plan §2. Contracts that today's architecture cannot satisfy are pinned with
 * test.fail(<cond>, '<plan item>: <reason>') so the suite is CI-green while
 * the wall stays honest.
 *
 * FLIP INSTRUCTION for whoever lands a pinned plan item: Playwright turns an
 * unexpected PASS of a test.fail()-annotated test into a hard failure -- that
 * is the signal to DELETE the test.fail() line for your item and let the
 * assertion run as a normal (green) expectation. Never widen a pin; never
 * convert a pin to test.fixme (fixme'd tests produce no evidence).
 *
 * Rust-only: registered in RUST_ONLY_SPECS + rust-chromium testMatch, because
 * restartAbrupt() exists only on RustServer.
 *
 * Helpers are copied, not imported, per this suite's per-spec-ownership
 * convention (donors: compound-restart-rust.spec.ts,
 * opencode-terminal-restore-rust.spec.ts, restore-double-restart.spec.ts,
 * freshopencode-restart-recovery.spec.ts).
 */
import { test, expect } from '../helpers/fixtures.js'
import { RustServer, type TestServerInfo } from '../helpers/rust-server.js'
import { TestHarness } from '../helpers/test-harness.js'
import { openPanePicker } from '../helpers/pane-picker.js'
import { installDualRoleCodexCli } from '../fixtures/codex-dual-role'
import type { Page } from '@playwright/test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// ESM project ("type": "module" in package.json): __dirname does not exist in
// ESM modules, so derive it -- same convention as every fixture-referencing
// donor spec (e.g. compound-restart-rust.spec.ts:49-51).
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// RESTORE-01: the contract wall ASSERTS the recovery panel's own behavior at
// boot (e.g. the SIGKILL-within-5s leg below), and its tests use the default
// `page` fixture — the harness auto-decline watcher (fixtures.js `context`
// override) must not race those assertions.
test.use({ recoveryOfferHandling: 'manual' })

const FAKE_CODEX_CLI_SOURCE = path.resolve(__dirname, '../fixtures/fake-codex-cli.mjs')
const FAKE_OPENCODE_TERMINAL_SOURCE = path.resolve(__dirname, '../fixtures/fake-opencode-terminal.mjs')
const FAKE_OPENCODE_SIDECAR_SOURCE = path.resolve(__dirname, '../fixtures/fake-opencode.cjs')
const FAKE_CLAUDE_CLI_SOURCE = path.resolve(__dirname, '../fixtures/fake-claude-cli.mjs')
const FAKE_CLAUDE_SIDECAR_SOURCE = path.resolve(__dirname, '../fixtures/fake-claude-sidecar.mjs')
const FAKE_CODEX_APP_SERVER_SOURCE = path.resolve(
  __dirname,
  '../../fixtures/coding-cli/codex-app-server/fake-app-server.mjs',
)

// ---------------------------------------------------------------------------
// Shared helpers (per-spec copies -- see file doc comment)
// ---------------------------------------------------------------------------

/** Copy a fixture into <binDir>/<binName> and make it executable. */
async function installFakeCli(source: string, binName: string, binDir: string): Promise<string> {
  await fs.mkdir(binDir, { recursive: true })
  const target = path.join(binDir, binName)
  await fs.copyFile(source, target)
  await fs.chmod(target, 0o755)
  return target
}

/** Read a fake CLI's argv-log JSONL (empty array if not yet written). */
async function readArgvLog(logPath: string): Promise<Array<{ argv: string[] }>> {
  const raw = await fs.readFile(logPath, 'utf8').catch(() => '')
  if (!raw) return []
  return raw.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as { argv: string[] })
}

/** True when argv contains the adjacent pair `resume <sessionId>` (codex shape). */
function hasResumePair(argv: string[], sessionId: string): boolean {
  const idx = argv.indexOf('resume')
  return idx >= 0 && argv[idx + 1] === sessionId
}

/** True when argv contains the adjacent pair `<flag> <value>` (claude --resume / opencode --session). */
function hasFlagPair(argv: string[], flag: string, value: string): boolean {
  const idx = argv.indexOf(flag)
  return idx >= 0 && argv[idx + 1] === value
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

/** Dismiss the initial pane-type picker by choosing the first visible shell. */
async function selectShellIfPickerShowing(page: Page): Promise<void> {
  const picker = page.getByRole('toolbar', { name: /pane type picker/i }).last()
  if (!(await picker.isVisible().catch(() => false))) return
  for (const name of ['Shell', 'WSL', 'CMD', 'PowerShell', 'Bash']) {
    const option = picker.getByRole('button', { name: new RegExp(`^${name}$`, 'i') })
    if (await option.isVisible().catch(() => false)) {
      await option.click({ force: true })
      return
    }
  }
}

/** Poll the in-page harness until the WS transport reports 'ready'. */
async function waitForWsReady(page: Page, timeoutMs = 60_000): Promise<void> {
  await expect(async () => {
    const status = await page.evaluate(
      () => (window as any).__FRESHELL_TEST_HARNESS__?.getWsReadyState(),
    )
    expect(status).toBe('ready')
  }).toPass({ timeout: timeoutMs })
}

/** Force the persistence middleware to write localStorage NOW (pre-reload). */
async function flushPersistence(page: Page): Promise<void> {
  await page.evaluate(() => {
    ;(window as any).__FRESHELL_TEST_HARNESS__?.dispatch({ type: 'persist/flushNow' })
  })
}

async function reloadAndReconnect(page: Page, harness: TestHarness): Promise<void> {
  await page.reload({ waitUntil: 'domcontentloaded' })
  await harness.waitForHarness()
  await harness.waitForConnection()
}

/** Idempotent .freshell/config.json seed (setupHome re-runs on every boot). */
function seedWallConfig(input: {
  providers: string[]
  freshAgent?: boolean
}): (homeDir: string) => Promise<void> {
  return async (homeDir: string) => {
    const freshellDir = path.join(homeDir, '.freshell')
    await fs.mkdir(freshellDir, { recursive: true })
    await fs.writeFile(
      path.join(freshellDir, 'config.json'),
      JSON.stringify(
        {
          version: 1,
          settings: {
            codingCli: { enabledProviders: input.providers },
            ...(input.freshAgent ? { freshAgent: { enabled: true } } : {}),
          },
        },
        null,
        2,
      ),
    )
  }
}

/** Boot an owned RustServer, navigate, and wait for harness + WS. */
async function bootWall(
  page: Page,
  options: {
    env?: Record<string, string>
    setupHome?: (homeDir: string) => Promise<void>
  } = {},
): Promise<{ server: RustServer; info: TestServerInfo; harness: TestHarness }> {
  const server = new RustServer({ env: options.env, setupHome: options.setupHome })
  const info = await server.start()
  await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
  const harness = new TestHarness(page)
  await harness.waitForHarness()
  await harness.waitForConnection()
  return { server, info, harness }
}

/** Seed ~/.codex/sessions/<id>.jsonl so the sidebar shows a resumable codex session. */
function seedCodexHome(
  sessionId: string,
  sessionTitle: string,
  projectDir: string,
): (homeDir: string) => Promise<void> {
  return async (homeDir: string) => {
    await seedWallConfig({ providers: ['codex'] })(homeDir)
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
      JSON.stringify({
        timestamp: '2026-07-21T08:00:03.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: `${sessionTitle} request 2` }],
        },
      }),
    ]
    await fs.writeFile(path.join(codexSessionsDir, `${sessionId}.jsonl`), `${lines.join('\n')}\n`)
  }
}

// --- layout tree walkers (donor: opencode-terminal-restore-rust.spec.ts) ---

function collectLeaves(node: any): any[] {
  if (!node) return []
  if (node.type === 'leaf') return [node]
  if (node.type === 'split') return (node.children ?? []).flatMap(collectLeaves)
  return []
}

function findLeavesByMode(layout: any, mode: string): any[] {
  return collectLeaves(layout).filter((leaf) => leaf?.content?.mode === mode)
}

function findFreshAgentLeaf(node: any): any {
  if (!node) return null
  if (node.type === 'leaf' && node.content?.kind === 'fresh-agent') return node
  if (node.type === 'split') {
    for (const child of node.children ?? []) {
      const found = findFreshAgentLeaf(child)
      if (found) return found
    }
  }
  return null
}

// Durable identity reader -- ONE ordering, UNIFIED with the lane specs'
// readers (freshclaude-identity-persistence-rust.spec.ts durableIdentity,
// freshclaude-restart-parity-rust.spec.ts liveDurableIdentity; council
// follow-up, PR #562/#563 close-out: the P0.2 bug WAS a reader-ordering
// bug, so this suite keeps a single order everywhere): sessionRef IS the
// durable identity per the 2026-04-19 durable-session contract;
// resumeSessionId is the durable-intent fallback; content.sessionId is a
// LIVE handle (for claude, the create-time fc-e2e-* placeholder forever)
// and may only be read LAST.
function leafDurableIdentity(leaf: any): string | undefined {
  return (
    leaf?.content?.sessionRef?.sessionId ??
    leaf?.content?.resumeSessionId ??
    leaf?.content?.sessionId
  )
}

// --- REST helpers (donor: continuity-smoke.spec.ts / agent-continuity-matrix) ---

function restApiHeaders(info: TestServerInfo): Record<string, string> {
  return { 'x-auth-token': info.token, 'content-type': 'application/json' }
}

/** POST /api/tabs; returns the created tabId (envelope is {status,data}). */
async function createTabViaRest(info: TestServerInfo, body: object): Promise<string> {
  const res = await fetch(`${info.baseUrl}/api/tabs`, {
    method: 'POST',
    headers: restApiHeaders(info),
    body: JSON.stringify(body),
  })
  const payload = await res.json()
  expect(res.ok, `POST /api/tabs: ${JSON.stringify(payload)}`).toBe(true)
  const tabId = payload?.data?.tabId
  expect(tabId, 'POST /api/tabs envelope data.tabId').toBeTruthy()
  return tabId as string
}

// --- opencode pane helpers (donor: opencode-terminal-restore-rust.spec.ts:104-146) ---

/**
 * Open a NEW pane via the picker and select the "OpenCode" provider option.
 * The follow-up "Starting directory for OpenCode" combobox arrives pre-filled
 * and focused; Enter accepts the current directory as-is.
 */
async function openOpencodePane(page: Page): Promise<void> {
  const picker = await openPanePicker(page)
  await picker.getByRole('button', { name: /^OpenCode$/i }).click({ force: true })
  await page.getByRole('combobox', { name: /Starting directory for OpenCode/i }).press('Enter')
}

/**
 * Open a new opencode pane (splitting the current terminal) and return the
 * NEWLY-added opencode leaf -- identified by diffing the leaf set before vs
 * after, since a fresh pane's terminalId isn't known until create completes.
 */
async function openOpencodePaneAndGetLeaf(
  page: Page,
  harness: TestHarness,
  tabId: string,
): Promise<any> {
  const before = findLeavesByMode(await harness.getPaneLayout(tabId), 'opencode')
  const beforeIds = new Set(before.map((leaf) => leaf.id))
  await openOpencodePane(page)
  await expect(page.locator('.xterm').last()).toBeVisible({ timeout: 15_000 })
  return expect
    .poll(async () => {
      const layout = await harness.getPaneLayout(tabId)
      const newLeaf = findLeavesByMode(layout, 'opencode').find((leaf) => !beforeIds.has(leaf.id))
      return newLeaf?.content?.terminalId ? newLeaf : null
    }, { timeout: 15_000 })
    .not.toBeNull()
    .then(async () => {
      const layout = await harness.getPaneLayout(tabId)
      return findLeavesByMode(layout, 'opencode').find((leaf) => !beforeIds.has(leaf.id))
    })
}

/** Look up a single leaf by pane id in a tab's current layout. */
async function findLeafById(harness: TestHarness, tabId: string, paneId: string): Promise<any> {
  const layout = await harness.getPaneLayout(tabId)
  return collectLeaves(layout).find((leaf) => leaf.id === paneId) ?? null
}

// --- freshcodex fresh-agent helpers (donors: restore-matrix.spec.ts:62-92,
// restore-double-restart.spec.ts:148-176) ---

/**
 * Install the fake codex app-server as a re-exec WRAPPER, never a content
 * copy (donor: restore-matrix.spec.ts:62-92): the fixture's
 * `import { WebSocketServer } from 'ws'` is an ESM bare specifier resolved
 * relative to the FILE'S OWN location -- a copy dropped in a bare temp dir
 * has no `node_modules` ancestor and dies with ERR_MODULE_NOT_FOUND.
 */
async function installFakeCodexAppServer(destDir: string): Promise<string> {
  await fs.mkdir(destDir, { recursive: true })
  const dest = path.join(destDir, 'fake-codex-app-server-wrapper.mjs')
  const wrapper = `#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
const target = ${JSON.stringify(FAKE_CODEX_APP_SERVER_SOURCE)}
const result = spawnSync(process.execPath, [target, ...process.argv.slice(2)], { stdio: 'inherit' })
process.exit(result.status ?? 1)
`
  await fs.writeFile(dest, wrapper, 'utf8')
  await fs.chmod(dest, 0o755)
  return dest
}

async function createFreshcodexPane(
  page: Page,
  harness: TestHarness,
  cwd: string,
): Promise<void> {
  // setAvailableClis is client-only AND gets overwritten by the app
  // bootstrap + /api/platform fetch (App.tsx:572,609). Callers reach this
  // helper only after harness.waitForConnection(), which is what makes the
  // dispatch land AFTER those overwrites (donor ordering:
  // freshopencode-restart-recovery.spec.ts:100-115). Keep it that way.
  await page.evaluate(() => {
    ;(window as any).__FRESHELL_TEST_HARNESS__?.dispatch({
      type: 'connection/setAvailableClis',
      payload: { claude: false, codex: true },
    })
  })
  const picker = await openPanePicker(page)
  await picker.getByRole('button', { name: /^Freshcodex$/i }).click({ force: true })
  // DEFLAKE/REBASE (f3wp refresh, 2026-07-28): main's #553 added the sidebar
  // "Repo filter" -- a native <select> (Sidebar.tsx:713-727) whose <option>
  // children are DOM-earlier than the DirectoryPicker candidates, so the old
  // page-global `getByRole('option').first().click()` resolves to the
  // ALWAYS-HIDDEN "All" option of the CLOSED select whenever the sidebar has
  // repo-grouped sessions (true in THE RULER by this point) and waits on
  // visibility forever -- observed as 4/4 deterministic RULER test-timeouts
  // (trace pending on `role=option >> nth=0`, timeout 0). Use the fill+Enter
  // pattern this helper's own contingency note prescribed (same as
  // createFreshclaudePane/createFreshopencodePane) -- no role=option
  // dependency at all.
  const directoryInput = page.getByLabel(/^Starting directory for Freshcodex$/i)
  await expect(directoryInput).toBeVisible({ timeout: 15_000 })
  await directoryInput.fill(cwd)
  await directoryInput.press('Enter')
  await expect(page.locator('[data-context="fresh-agent"]').last()).toBeVisible({
    timeout: 15_000,
  })
}

/** Send one chat turn in the last fresh-agent pane and wait for idle. */
async function sendFreshAgentTurn(
  page: Page,
  harness: TestHarness,
  tabId: string,
  text: string,
): Promise<void> {
  const paneRoot = page.locator('[data-context="fresh-agent"]').last()
  await expect
    .poll(async () => findFreshAgentLeaf(await harness.getPaneLayout(tabId))?.content?.status, {
      timeout: 20_000,
    })
    .toBe('idle')
  const composer = paneRoot.getByRole('textbox', { name: 'Chat message input' })
  await composer.fill(text)
  await paneRoot.getByRole('button', { name: 'Send' }).click()
  await expect
    .poll(async () => findFreshAgentLeaf(await harness.getPaneLayout(tabId))?.content?.status, {
      timeout: 30_000,
    })
    .toBe('idle')
}

// --- freshopencode fresh-agent helpers (donor:
// freshopencode-restart-recovery.spec.ts:114-206) ---

async function enableFreshOpencode(
  page: Page,
  enabledProviders: string[] = ['opencode'],
): Promise<void> {
  // These dispatches are client-only and MUST land AFTER the app bootstrap +
  // /api/platform fetch (App.tsx:572,609 overwrite availableClis). Callers
  // reach this helper only after harness.waitForConnection(), which is the
  // donor's ordering (freshopencode-restart-recovery.spec.ts:100-115).
  //
  // CAUTION: mergeServerSettings REPLACES the enabledProviders array when the
  // key is present (shared/settings.ts:1216-1218) -- it does not union. Any
  // test that needs OTHER providers' picker buttons after this call (e.g. the
  // Task 9 ruler, which still has freshclaude to create) MUST pass the full
  // provider list, or those buttons disappear (PanePicker.tsx:125-152 gates
  // fresh-agent options on enabledProviders.includes(<provider>)).
  await page.evaluate((providers) => {
    const harness = (window as any).__FRESHELL_TEST_HARNESS__
    harness?.dispatch({ type: 'connection/setAvailableClis', payload: { opencode: true } })
    harness?.dispatch({
      type: 'settings/previewServerSettingsPatch',
      payload: { codingCli: { enabledProviders: providers }, freshAgent: { enabled: true } },
    })
  }, enabledProviders)
}

async function createFreshopencodePane(page: Page, cwd: string): Promise<void> {
  const picker = await openPanePicker(page)
  await picker.getByRole('button', { name: /^Freshopencode$/i }).click({ force: true })
  const directoryInput = page.getByLabel(/^Starting directory for Freshopencode$/i)
  await expect(directoryInput).toBeVisible({ timeout: 15_000 })
  await directoryInput.fill(cwd)
  await directoryInput.press('Enter')
  await expect(page.locator('[data-context="fresh-agent"]').last()).toBeVisible({
    timeout: 15_000,
  })
}

// --- freshclaude fresh-agent helper (fixture: fake-claude-sidecar.mjs via the
// production env seam FRESHELL_CLAUDE_SIDECAR) ---

async function createFreshclaudePane(page: Page, harness: TestHarness, cwd: string): Promise<void> {
  // setAvailableClis is client-only AND gets overwritten by the app
  // bootstrap + /api/platform fetch (App.tsx:572,609). Callers reach this
  // helper only after harness.waitForConnection(), which is what makes the
  // dispatch land AFTER those overwrites (donor ordering:
  // freshopencode-restart-recovery.spec.ts:100-115). Keep it that way.
  await page.evaluate(() => {
    ;(window as any).__FRESHELL_TEST_HARNESS__?.dispatch({
      type: 'connection/setAvailableClis',
      payload: { claude: true, codex: false },
    })
  })
  const picker = await openPanePicker(page)
  await picker.getByRole('button', { name: /^Freshclaude$/i }).click({ force: true })
  // /api/files/candidate-dirs returns [] on a clean isolated HOME (no $HOME
  // fallback, crates/freshell-server/src/files.rs:15-26), so a "first
  // option" may not exist -- TYPE the cwd and press Enter instead (donor:
  // freshopencode-restart-recovery.spec.ts:117-124).
  const directoryInput = page.getByLabel(/^Starting directory for Freshclaude$/i)
  await expect(directoryInput).toBeVisible({ timeout: 15_000 })
  await directoryInput.fill(cwd)
  await directoryInput.press('Enter')
  await expect(page.locator('[data-context="fresh-agent"]').last()).toBeVisible({
    timeout: 15_000,
  })
  // NOTE (corrected, council fix round -- the Rust router HAS shipped a
  // claude snapshot adapter since this comment was written: crates/
  // freshell-freshagent/src/snapshot.rs:133-146 routes freshclaude/kilroy +
  // claude through get_claude_snapshot(), a disk+env adapter over the CLI's
  // own transcript store; FRESH_AGENT_RUNTIME_UNAVAILABLE now only fires for
  // session types with NO adapter registered at all). A transient
  // history-load-error banner may still appear on a freshly-created pane
  // (snapshot fetch racing pane creation), so this suite still asserts pane
  // state via the harness (Redux) rather than error-free UI chrome for
  // freshclaude -- but the reason is a fetch-timing race, not a missing
  // adapter.
}

// --- browser pane helper (donor: browser-pane.spec.ts:8) -- consumed
// verbatim by the ruler (Task 9); keep the signature exact. ---

async function createBrowserPaneInPage(page: Page): Promise<void> {
  const termContainer = page.locator('.xterm').first()
  await termContainer.click({ button: 'right' })
  await page.getByRole('menuitem', { name: /split horizontally/i }).click()
  const browserButton = page.getByRole('button', { name: /^Browser$/i })
  await expect(browserButton).toBeVisible({ timeout: 10_000 })
  await browserButton.click()
  await expect(page.getByPlaceholder('Enter URL...')).toBeVisible({ timeout: 10_000 })
}

// --- dual-role CLI shims (Task 9 ruler only) -- CODEX_CMD serves BOTH the
// codex terminal CLI and the freshcodex app-server; OPENCODE_CMD serves BOTH
// the opencode terminal CLI and the freshopencode `serve` sidecar. Terminal
// spawns are PTY PATH-style exec of a single file (NO whitespace split), so
// each shim must be one executable. Dispatch on argv: codex sidecar argv
// contains `app-server`; opencode sidecar argv[0] === 'serve'. Extensionless
// executables default to CJS -- no ESM-detection dependence. ---

/** Single-executable `codex` shim: app-server argv -> fake app-server; else terminal fake. */
async function installDualRoleCodex(binDir: string, argLogPath: string): Promise<string> {
  return installDualRoleCodexCli(binDir, FAKE_CODEX_CLI_SOURCE, { FAKE_CODEX_ARGV_LOG: argLogPath })
}

/** Single-executable `opencode` shim: `serve` argv -> fake sidecar; else terminal fake. */
async function installDualRoleOpencode(
  binDir: string,
  argLogPath: string,
  auditLogPath: string,
): Promise<string> {
  await fs.mkdir(binDir, { recursive: true })
  const target = path.join(binDir, 'opencode')
  const script = `#!/usr/bin/env node
const { spawnSync } = require('node:child_process')
const argv = process.argv.slice(2)
const source = argv[0] === 'serve' || argv[0] === '--version'
  ? ${JSON.stringify(FAKE_OPENCODE_SIDECAR_SOURCE)}
  : ${JSON.stringify(FAKE_OPENCODE_TERMINAL_SOURCE)}
const env = { ...process.env, FAKE_OPENCODE_AUDIT_LOG: ${JSON.stringify(auditLogPath)}, FAKE_OPENCODE_TERMINAL_ARGV_LOG: ${JSON.stringify(argLogPath)} }
const result = spawnSync(process.execPath, [source, ...argv], { stdio: 'inherit', env })
process.exit(result.status ?? 1)
`
  await fs.writeFile(target, script, 'utf8')
  await fs.chmod(target, 0o755)
  return target
}

// ---------------------------------------------------------------------------
// The wall
// ---------------------------------------------------------------------------

test.describe('Restore Contract Wall (P0.1)', () => {
  test.setTimeout(180_000)

  test('shell terminal: SIGKILL restore yields a fresh shell in initialCwd', async ({
    page,
    e2eServerKind,
  }) => {
    expect(e2eServerKind).toBe('rust')
    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-wall-shell-'))
    const projectDir = path.join(sharedRoot, 'project')
    await fs.mkdir(projectDir, { recursive: true })

    const { server, harness, info } = await bootWall(page)
    try {
      await selectShellIfPickerShowing(page)

      // Create the shell pane with a KNOWN cwd via REST so the initialCwd
      // contract is assertable.
      const tabCountBefore = await harness.getTabCount()
      const tabId = await createTabViaRest(info, { mode: 'shell', cwd: projectDir })
      await expect(async () => {
        expect(await harness.getTabCount()).toBe(tabCountBefore + 1)
      }).toPass({ timeout: 15_000 })

      const terminalIdBefore: string = await expect
        .poll(async () => (await harness.getPaneLayout(tabId))?.content?.terminalId ?? null, {
          timeout: 20_000,
        })
        .not.toBeNull()
        .then(async () => (await harness.getPaneLayout(tabId))?.content?.terminalId)
      expect(terminalIdBefore).toBeTruthy()

      // Prove the shell is interactive before the kill.
      await page.locator('.xterm').last().click()
      await page.keyboard.type('echo wall-shell-alive')
      await page.keyboard.press('Enter')
      await expect
        .poll(async () => {
          const buffer = await harness.getTerminalBuffer(terminalIdBefore)
          return typeof buffer === 'string' && buffer.replace(/\n/g, '').includes('wall-shell-alive')
        }, { timeout: 15_000 })
        .toBe(true)

      // --- SIGKILL + revive on the same disk state; live client reconnects. ---
      await server.restartAbrupt()
      await waitForWsReady(page)

      // CONTRACT §2.1: pane recreates (new terminalId), never status:error.
      const terminalIdAfter: string = await expect
        .poll(async () => {
          const tid = (await harness.getPaneLayout(tabId))?.content?.terminalId ?? null
          return tid && tid !== terminalIdBefore ? tid : null
        }, { timeout: 30_000 })
        .not.toBeNull()
        .then(async () => (await harness.getPaneLayout(tabId))?.content?.terminalId)
      expect((await harness.getPaneLayout(tabId))?.content?.status).not.toBe('error')

      // CONTRACT §2.1: the fresh shell starts in the pane's opened directory.
      await page.locator('.xterm').last().click()
      await page.keyboard.type('pwd')
      await page.keyboard.press('Enter')
      await expect
        .poll(async () => {
          const buffer = await harness.getTerminalBuffer(terminalIdAfter)
          return typeof buffer === 'string' && buffer.replace(/\n/g, '').includes(projectDir)
        }, { timeout: 15_000 })
        .toBe(true)
    } finally {
      await server.stop()
      await fs.rm(sharedRoot, { recursive: true, force: true })
    }
  })

  test('claude terminal: pre-allocated session resumes with --resume after SIGKILL', async ({
    page,
    e2eServerKind,
  }) => {
    expect(e2eServerKind).toBe('rust')
    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-wall-claude-term-'))
    const projectDir = path.join(sharedRoot, 'project')
    await fs.mkdir(projectDir, { recursive: true })
    const argLogPath = path.join(sharedRoot, 'claude-argv.jsonl')
    const fakeClaudePath = await installFakeCli(
      FAKE_CLAUDE_CLI_SOURCE,
      'claude',
      path.join(sharedRoot, 'bin'),
    )

    const { server, harness, info } = await bootWall(page, {
      env: { CLAUDE_CMD: fakeClaudePath, FAKE_CLAUDE_ARGV_LOG: argLogPath },
      setupHome: seedWallConfig({ providers: ['claude'] }),
    })
    try {
      await selectShellIfPickerShowing(page)
      const tabId = (await harness.getActiveTabId())!

      // Fresh claude pane via the PICKER (WS path) -> server pre-allocates
      // --session-id (terminal.rs:969-982). REST would not (PF1,
      // terminal_tabs.rs:756-768). Candidate dirs can be EMPTY on a clean
      // isolated HOME (crates/freshell-server/src/files.rs:15-26 -- no $HOME
      // fallback), so TYPE the cwd instead of clicking a suggestion (donor:
      // freshopencode-restart-recovery.spec.ts:117-124).
      const beforeIds = new Set(
        findLeavesByMode(await harness.getPaneLayout(tabId), 'claude').map((l) => l.id),
      )
      // The boot picker commits its selection only after its fade-out
      // transition (PanePicker onTransitionEnd -> onSelect), so wait for the
      // boot pane to become a REAL terminal before opening the pane picker --
      // otherwise openPanePicker early-returns the still-fading boot picker
      // and the Claude click is swallowed when that pane turns into the shell
      // (donor: truly-idle-alerting.spec.ts waits for .xterm after picking).
      await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })
      const picker = await openPanePicker(page)
      await picker.getByRole('button', { name: /^Claude CLI$/i }).click({ force: true })
      const dirInput = page.getByRole('combobox', { name: /Starting directory for Claude/i })
      await expect(dirInput).toBeVisible({ timeout: 15_000 })
      await dirInput.fill(projectDir)
      await dirInput.press('Enter')

      // The new claude pane is a SPLIT in the active tab -- track it by leaf id.
      const claudeLeaf = await expect
        .poll(async () => {
          const layout = await harness.getPaneLayout(tabId)
          const newLeaf = findLeavesByMode(layout, 'claude').find((l) => !beforeIds.has(l.id))
          return newLeaf?.content?.terminalId ? newLeaf : null
        }, { timeout: 20_000 })
        .not.toBeNull()
        .then(async () => {
          const layout = await harness.getPaneLayout(tabId)
          return findLeavesByMode(layout, 'claude').find((l) => !beforeIds.has(l.id))!
        })
      const paneId: string = claudeLeaf.id
      const terminalIdBefore: string = claudeLeaf.content.terminalId
      const claudeContent = async () => {
        const layout = await harness.getPaneLayout(tabId)
        return collectLeaves(layout).find((l) => l.id === paneId)?.content
      }

      // t=0 identity: the FIRST spawn already carries --session-id <uuid>.
      const preallocatedId: string = await expect
        .poll(async () => {
          const entries = await readArgvLog(argLogPath)
          const withId = entries.find((e) => e.argv.includes('--session-id'))
          if (!withId) return null
          return withId.argv[withId.argv.indexOf('--session-id') + 1] ?? null
        }, { timeout: 20_000 })
        .not.toBeNull()
        .then(async () => {
          const entries = await readArgvLog(argLogPath)
          const withId = entries.find((e) => e.argv.includes('--session-id'))!
          return withId.argv[withId.argv.indexOf('--session-id') + 1]!
        })
      expect(preallocatedId).toMatch(/^[0-9a-f-]{36}$/)

      // Client persisted the identity ("restore info set quickly", §2.2).
      // PANE-level content.sessionRef: the fold happens in the mounted pane's
      // own terminal.created handler (TerminalView.tsx:3729-3742 ->
      // panesSlice.ts:1705-1707), so assert on the leaf, never the tab.
      await expect
        .poll(async () => (await claudeContent())?.sessionRef?.sessionId ?? null, {
          timeout: 20_000,
        })
        .toBe(preallocatedId)

      // FIXTURE REALISM (reconcile adoption): real claude writes
      // ~/.claude/projects/<proj>/<sessionId>.jsonl as soon as the session
      // starts; the fake CLI does not. Under the adopted client the
      // post-restart verdict is derived from DISK truth (a claimed session
      // with no file is a loud dead_session, never an optimistic silent
      // respawn), so mirror what real claude persists before the kill.
      const claudeProjDir = path.join(info.homeDir, '.claude', 'projects', 'wall-claude-proj')
      await fs.mkdir(claudeProjDir, { recursive: true })
      await fs.writeFile(
        path.join(claudeProjDir, `${preallocatedId}.jsonl`),
        `${JSON.stringify({
          type: 'user',
          message: 'wall claude fixture transcript',
          uuid: 'msg-1',
          cwd: projectDir,
          timestamp: '2026-07-21T08:00:00.000Z',
        })}\n`,
        'utf8',
      )

      const argvCountBeforeKill = (await readArgvLog(argLogPath)).length

      // --- SIGKILL + revive; live client recovers on its own reconnect. ---
      await server.restartAbrupt()
      await waitForWsReady(page)

      // CONTRACT §2.2: new terminalId, resumed with --resume <preallocatedId>.
      await expect
        .poll(async () => {
          const tid = (await claudeContent())?.terminalId ?? null
          return tid && tid !== terminalIdBefore ? tid : null
        }, { timeout: 30_000 })
        .not.toBeNull()
      await expect
        .poll(async () => {
          const entries = await readArgvLog(argLogPath)
          return entries
            .slice(argvCountBeforeKill)
            .some((e) => hasFlagPair(e.argv, '--resume', preallocatedId))
        }, { timeout: 30_000 })
        .toBe(true)

      const terminalIdAfter = (await claudeContent())?.terminalId
      await expect
        .poll(async () => {
          const buffer = await harness.getTerminalBuffer(terminalIdAfter)
          const unwrapped = typeof buffer === 'string' ? buffer.replace(/\n/g, '') : ''
          return unwrapped.includes(`claude: resumed session ${preallocatedId}`)
        }, { timeout: 20_000 })
        .toBe(true)
      expect((await claudeContent())?.status).not.toBe('error')
      expect((await claudeContent())?.sessionRef?.sessionId).toBe(preallocatedId)
    } finally {
      await server.stop()
      await fs.rm(sharedRoot, { recursive: true, force: true })
    }
  })

  test('codex terminal: sessionRef-bound pane resumes with `resume <id>` after SIGKILL', async ({
    page,
    e2eServerKind,
  }) => {
    expect(e2eServerKind).toBe('rust')
    const CODEX_SESSION_ID = '11111111-2222-4333-8444-555555555555'
    const SESSION_TITLE = 'wall codex session'
    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-wall-codex-term-'))
    const projectDir = path.join(sharedRoot, 'project')
    await fs.mkdir(projectDir, { recursive: true })
    const argLogPath = path.join(sharedRoot, 'codex-argv.jsonl')
    // Dual-role: the Rust server's codex terminal lane boots a `codex
    // app-server` sidecar FIRST (PTY_SPAWN_FAILED otherwise), so the fake
    // must answer both app-server argv (fake app-server) and terminal argv.
    const fakeCodexPath = await installDualRoleCodex(path.join(sharedRoot, 'bin'), argLogPath)

    const { server, harness } = await bootWall(page, {
      env: { CODEX_CMD: fakeCodexPath, FAKE_CODEX_ARGV_LOG: argLogPath },
      setupHome: seedCodexHome(CODEX_SESSION_ID, SESSION_TITLE, projectDir),
    })
    try {
      await selectShellIfPickerShowing(page)

      // Open the seeded historical session from the sidebar (identity lands
      // in content.sessionRef only -- the incident shape).
      const sessionList = page.getByTestId('sidebar-session-list')
      await expect(sessionList).toBeVisible({ timeout: 15_000 })
      const sessionItem = page.getByText(SESSION_TITLE, { exact: false }).first()
      await expect(sessionItem).toBeVisible({ timeout: 15_000 })
      const tabCountBefore = await harness.getTabCount()
      await sessionItem.click()
      await expect(async () => {
        expect(await harness.getTabCount()).toBe(tabCountBefore + 1)
      }).toPass({ timeout: 15_000 })
      const tabId = (await harness.getActiveTabId())!

      const terminalIdBefore: string = await expect
        .poll(async () => (await harness.getPaneLayout(tabId))?.content?.terminalId ?? null, {
          timeout: 20_000,
        })
        .not.toBeNull()
        .then(async () => (await harness.getPaneLayout(tabId))?.content?.terminalId)
      expect((await harness.getPaneLayout(tabId))?.content?.sessionRef?.sessionId).toBe(
        CODEX_SESSION_ID,
      )

      // Create-time resume proof.
      await expect
        .poll(async () => {
          const entries = await readArgvLog(argLogPath)
          return entries.some((e) => hasResumePair(e.argv, CODEX_SESSION_ID))
        }, { timeout: 20_000 })
        .toBe(true)

      const argvCountBeforeKill = (await readArgvLog(argLogPath)).length

      // --- SIGKILL + revive; live client recovers on its own reconnect. ---
      await server.restartAbrupt()
      await waitForWsReady(page)

      // CONTRACT §2.3: new terminalId, re-resumed argv, same sessionRef.
      await expect
        .poll(async () => {
          const tid = (await harness.getPaneLayout(tabId))?.content?.terminalId ?? null
          return tid && tid !== terminalIdBefore ? tid : null
        }, { timeout: 30_000 })
        .not.toBeNull()
      await expect
        .poll(async () => {
          const entries = await readArgvLog(argLogPath)
          return entries
            .slice(argvCountBeforeKill)
            .some((e) => hasResumePair(e.argv, CODEX_SESSION_ID))
        }, { timeout: 30_000 })
        .toBe(true)
      const contentAfter = (await harness.getPaneLayout(tabId))?.content
      expect(contentAfter?.status).not.toBe('error')
      expect(contentAfter?.sessionRef?.sessionId).toBe(CODEX_SESSION_ID)
      const terminalIdAfter = contentAfter?.terminalId
      await expect
        .poll(async () => {
          const buffer = await harness.getTerminalBuffer(terminalIdAfter)
          const unwrapped = typeof buffer === 'string' ? buffer.replace(/\n/g, '') : ''
          return unwrapped.includes(`codex: resumed session ${CODEX_SESSION_ID}`)
        }, { timeout: 20_000 })
        .toBe(true)
    } finally {
      await server.stop()
      await fs.rm(sharedRoot, { recursive: true, force: true })
    }
  })

  test('opencode terminal: locator-resolved session resumes with --session after SIGKILL', async ({
    page,
    e2eServerKind,
  }) => {
    expect(e2eServerKind).toBe('rust')
    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-wall-opencode-term-'))
    const argLogPath = path.join(sharedRoot, 'opencode-argv.jsonl')
    const fakeOpencodePath = await installFakeCli(
      FAKE_OPENCODE_TERMINAL_SOURCE,
      'opencode',
      path.join(sharedRoot, 'bin'),
    )

    const { server, harness } = await bootWall(page, {
      env: {
        OPENCODE_CMD: fakeOpencodePath,
        FAKE_OPENCODE_TERMINAL_ARGV_LOG: argLogPath,
      },
      // NOTE: seedWallConfig only overwrites config.json -- it never touches
      // <home>/.local/share/opencode/opencode.db, so the runtime-minted DB
      // survives restartAbrupt()'s setupHome re-run. No symlink needed.
      setupHome: seedWallConfig({ providers: ['opencode'] }),
    })
    try {
      await selectShellIfPickerShowing(page)
      const tabId = (await harness.getActiveTabId())!
      // Wait for the boot pane to become a REAL terminal before opening the
      // pane picker, else openPanePicker races the boot picker's fade-out
      // (donor: truly-idle-alerting.spec.ts:122; same guard as Contract B).
      await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })
      const leaf = await openOpencodePaneAndGetLeaf(page, harness, tabId)
      const paneId: string = leaf.id
      const terminalIdBefore: string = leaf.content.terminalId

      // Mint the session: click the pane, type, press Enter (the fake writes
      // the opencode.db row on its first stdin data event).
      await page.locator('.xterm').last().click()
      await page.keyboard.type('hello wall opencode')
      await page.keyboard.press('Enter')

      // Wait for the locator to associate (identity lands in sessionRef).
      const associatedSessionId: string = await expect
        .poll(async () => {
          const l = await findLeafById(harness, tabId, paneId)
          return l?.content?.sessionRef?.sessionId ?? l?.content?.resumeSessionId ?? null
        }, { timeout: 20_000 })
        .not.toBeNull()
        .then(async () => {
          const l = await findLeafById(harness, tabId, paneId)
          return l?.content?.sessionRef?.sessionId ?? l?.content?.resumeSessionId
        })
      expect(associatedSessionId).toMatch(/^ses_e2e_/)

      const argvCountBeforeKill = (await readArgvLog(argLogPath)).length

      // --- SIGKILL + revive; live client recovers on its own reconnect. ---
      await server.restartAbrupt()
      await waitForWsReady(page)

      // CONTRACT §2.4: new terminalId, resumed via --session <id>.
      await expect
        .poll(async () => {
          const l = await findLeafById(harness, tabId, paneId)
          const tid = l?.content?.terminalId ?? null
          return tid && tid !== terminalIdBefore ? tid : null
        }, { timeout: 30_000 })
        .not.toBeNull()
      await expect
        .poll(async () => {
          const entries = await readArgvLog(argLogPath)
          return entries
            .slice(argvCountBeforeKill)
            .some((e) => hasFlagPair(e.argv, '--session', associatedSessionId))
        }, { timeout: 30_000 })
        .toBe(true)
      const leafAfter = await findLeafById(harness, tabId, paneId)
      expect(leafAfter?.content?.status).not.toBe('error')
      await expect
        .poll(async () => {
          const buffer = await harness.getTerminalBuffer(leafAfter?.content?.terminalId)
          const unwrapped = typeof buffer === 'string' ? buffer.replace(/\n/g, '') : ''
          return unwrapped.includes(`opencode: resumed session ${associatedSessionId}`)
        }, { timeout: 20_000 })
        .toBe(true)
    } finally {
      await server.stop()
      await fs.rm(sharedRoot, { recursive: true, force: true })
    }
  })

  // Per plan §2.6: freshcodex is the reference implementation -- after
  // SIGKILL+restart+reload the pane must rebind to the SAME durable thread
  // with history rehydrated ('Fixture turn' is the fake's deterministic
  // reply) and a non-wedged status.
  test('freshcodex: SIGKILL restore rebinds the same thread with history rehydrated', async ({
    page,
    e2eServerKind,
  }) => {
    expect(e2eServerKind).toBe('rust')
    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-wall-freshcodex-'))
    const fakeCodexPath = await installFakeCodexAppServer(path.join(sharedRoot, 'bin'))

    const { server, harness } = await bootWall(page, {
      env: { CODEX_CMD: fakeCodexPath },
      setupHome: seedWallConfig({ providers: ['codex'], freshAgent: true }),
    })
    try {
      await selectShellIfPickerShowing(page)
      const tabId = (await harness.getActiveTabId())!
      // Wait for the boot pane to become a REAL terminal before opening the
      // pane picker, else openPanePicker races the boot picker's fade-out and
      // the Freshcodex click is swallowed (donor ordering:
      // restore-double-restart.spec.ts:210-214; same guard as Contracts B/D).
      await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })
      await createFreshcodexPane(page, harness, sharedRoot)
      await sendFreshAgentTurn(page, harness, tabId, 'wall freshcodex turn')
      await expect(
        page.locator('[data-context="fresh-agent"]').last().getByText('Fixture turn'),
      ).toBeVisible({ timeout: 20_000 })

      const originalSessionId: string = await expect
        .poll(async () => leafDurableIdentity(findFreshAgentLeaf(await harness.getPaneLayout(tabId))) ?? null, {
          timeout: 20_000,
        })
        .not.toBeNull()
        .then(async () =>
          leafDurableIdentity(findFreshAgentLeaf(await harness.getPaneLayout(tabId)))!,
        )

      await flushPersistence(page)
      await harness.clearSentWsMessages()

      // --- SIGKILL + revive, then reload (full client rehydrate). ---
      await server.restartAbrupt()
      await waitForWsReady(page)
      await reloadAndReconnect(page, harness)

      // CONTRACT §2.6: same durable identity, history rehydrated, not wedged,
      // and every post-reload create targets the ORIGINAL thread.
      const rehydratedTabId = (await harness.getActiveTabId())!
      const rehydratedIdentity: string | undefined = await expect
        .poll(async () => leafDurableIdentity(findFreshAgentLeaf(await harness.getPaneLayout(rehydratedTabId))), {
          timeout: 30_000,
        })
        .not.toBeUndefined()
        .then(async () =>
          leafDurableIdentity(findFreshAgentLeaf(await harness.getPaneLayout(rehydratedTabId))),
        )
      expect(rehydratedIdentity).toBe(originalSessionId)
      await expect(
        page.locator('[data-context="fresh-agent"]').last().getByText('Fixture turn'),
      ).toBeVisible({ timeout: 30_000 })
      const finalLeaf = findFreshAgentLeaf(await harness.getPaneLayout(rehydratedTabId))
      expect(finalLeaf?.content?.status).not.toBe('error')

      const sentAfterReload = await harness.getSentWsMessages()
      const createsAfterReload = sentAfterReload.filter((m: any) => m?.type === 'freshAgent.create')
      for (const create of createsAfterReload) {
        const resumeTarget = (create as any).resumeSessionId ?? (create as any).sessionRef?.sessionId
        expect(resumeTarget).toBe(originalSessionId)
      }
    } finally {
      await server.stop()
      await fs.rm(sharedRoot, { recursive: true, force: true })
    }
  })

  // Per plan §2.7: the serve DB survives; after SIGKILL+restart+reload the
  // pane must carry the SAME ses_* identity, rehydrate prompt+response, and
  // mint NO new session.
  test('freshopencode: SIGKILL restore keeps the ses_* identity and rehydrates history', async ({
    page,
    e2eServerKind,
  }) => {
    expect(e2eServerKind).toBe('rust')
    // HISTORY: this test was pinned `test.fail()` as P1.8/P1.13 (observed
    // 2026-07-24): after SIGKILL+restart+RELOAD the pane re-minted a
    // lazy-create `freshopencode-<requestId>` placeholder instead of
    // rebinding the surviving ses_* session, and no history was visible.
    // Fixed by this lane's settings-from-ledger resume work (run of
    // 2026-07-26): post-reload the frozen client sends
    // `freshAgent.create{resumeSessionId: ses_*}` (never attach), and
    // opencode's `handle_create` now honors `resume_session_id`
    // (crates/freshell-freshagent/src/opencode_ws.rs, unit pin
    // `create_with_resume_session_id_rebinds_the_durable_session`), so
    // the pane rebinds the durable identity and rehydrates history -- the
    // pin is removed (flip pattern: restore-matrix.spec.ts TERM-25).
    // NOTE: the flip unmasked a latent strict-mode locator ambiguity in
    // the history assertion below -- the prompt text renders in THREE
    // places post-rehydrate (pane-header detail span, transcript "You"
    // turn, and the response line), so `page.getByText(prompt)` was never
    // satisfiable once rehydration worked. The assertion now targets the
    // transcript's "You" turn explicitly, a strictly stronger check
    // (history in the transcript, not merely the prompt echoed anywhere).
    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-wall-freshopencode-'))
    const projectDir = path.join(sharedRoot, 'project')
    await fs.mkdir(projectDir, { recursive: true })
    const auditLogPath = path.join(sharedRoot, 'opencode-audit.jsonl')
    const fakeOpencodePath = await installFakeCli(
      FAKE_OPENCODE_SIDECAR_SOURCE,
      'opencode',
      path.join(sharedRoot, 'bin'),
    )

    const { server, harness } = await bootWall(page, {
      env: { OPENCODE_CMD: fakeOpencodePath, FAKE_OPENCODE_AUDIT_LOG: auditLogPath },
      setupHome: seedWallConfig({ providers: ['opencode'], freshAgent: true }),
    })
    // NOTE: the fixture's /session/:id/abort and /fork routes 404 -- known
    // and out of contract scope (the only production caller is
    // freshAgent.interrupt, whose error is swallowed,
    // crates/freshell-freshagent/src/opencode_ws.rs:562-572). Do not add
    // interrupt-shaped assertions against this fixture.
    try {
      await selectShellIfPickerShowing(page)
      const tabId = (await harness.getActiveTabId())!
      await enableFreshOpencode(page)
      // Wait for the boot pane to become a REAL terminal before opening the
      // pane picker, else openPanePicker races the boot picker's fade-out and
      // the Freshopencode click is swallowed (donor:
      // truly-idle-alerting.spec.ts:122; same guard as Contracts B/D/E --
      // kept in the TEST BODY so the produced helpers stay verbatim).
      await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })
      await createFreshopencodePane(page, projectDir)

      const prompt = 'wall freshopencode turn'
      await sendFreshAgentTurn(page, harness, tabId, prompt)
      await expect(page.getByText(`Fake OpenCode response: ${prompt}`)).toBeVisible({
        timeout: 30_000,
      })

      // Materialized ses_* identity.
      const sessionId: string = await expect
        .poll(async () => {
          const id = leafDurableIdentity(findFreshAgentLeaf(await harness.getPaneLayout(tabId)))
          return id && /^ses_/.test(id) ? id : null
        }, { timeout: 30_000 })
        .not.toBeNull()
        .then(async () =>
          leafDurableIdentity(findFreshAgentLeaf(await harness.getPaneLayout(tabId)))!,
        )

      const auditRawBefore = await fs.readFile(auditLogPath, 'utf8').catch(() => '')
      const auditCountBefore = auditRawBefore ? auditRawBefore.trim().split('\n').length : 0

      await flushPersistence(page)

      // --- SIGKILL + revive, then reload. The opencode.db lives under the
      // preserved home (XDG_DATA_HOME) and survives; setupHome only rewrites
      // config.json. ---
      await server.restartAbrupt()
      await waitForWsReady(page)
      await reloadAndReconnect(page, harness)

      // CONTRACT §2.7: same identity, history rehydrated, not wedged.
      const rehydratedTabId = (await harness.getActiveTabId())!
      await expect
        .poll(async () => leafDurableIdentity(findFreshAgentLeaf(await harness.getPaneLayout(rehydratedTabId))), {
          timeout: 30_000,
        })
        .toBe(sessionId)
      await expect(page.getByLabel('You transcript turn').getByText(prompt)).toBeVisible({
        timeout: 30_000,
      })
      await expect(page.getByText(`Fake OpenCode response: ${prompt}`)).toBeVisible({
        timeout: 30_000,
      })
      const finalLeaf = findFreshAgentLeaf(await harness.getPaneLayout(rehydratedTabId))
      expect(finalLeaf?.content?.status).not.toBe('error')

      // No NEW durable session was minted by the restore.
      const auditRawAfter = await fs.readFile(auditLogPath, 'utf8').catch(() => '')
      const eventsAfter = auditRawAfter
        .trim()
        .split('\n')
        .filter(Boolean)
        .slice(auditCountBefore)
        .map((line) => JSON.parse(line) as { event?: string })
      expect(
        eventsAfter.filter(
          (event) => event.event === 'session_create_requested' || event.event === 'session_created',
        ),
      ).toEqual([])
    } finally {
      await server.stop()
      await fs.rm(sharedRoot, { recursive: true, force: true })
    }
  })

  // Per plan §2.8: freshclaude is "not restart-resilient at all": attach is
  // swallowed, snapshot 503s. The CONTRACT asserted is the target state
  // (rebound with history rehydrated, status not wedged); the pin records
  // today's reality.
  test('freshclaude: SIGKILL restore rebinds with history rehydrated and status not wedged', async ({
    page,
    e2eServerKind,
  }) => {
    expect(e2eServerKind).toBe('rust')
    // HISTORY: the P0.2 pin was FLIPPED 2026-07-27 by lane D4
    // (freshclaude-identity-persistence). Investigation showed the durable
    // identity ALREADY survives reload: FreshAgentView's merge effect folds
    // the canonical claude cliSessionId into content.sessionRef +
    // resumeSessionId (FreshAgentView.tsx mergePaneContent effect), and
    // persistMiddleware round-trips sessionRef -- the 2026-04-19
    // durable-session contract's designated durable identity -- while the
    // live placeholder in content.sessionId stays unpersisted. This leg was
    // red only because leafDurableIdentity read content.sessionId (the
    // fc-e2e-* live handle, legitimately different across reloads) FIRST;
    // the reader is sessionRef-first accordingly. The stale-claim hazard
    // that motivated the original strip is pinned by
    // specs/freshclaude-identity-persistence-rust.spec.ts (dead_session,
    // never silent).

    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-wall-freshclaude-'))
    const projectDir = path.join(sharedRoot, 'project')
    await fs.mkdir(projectDir, { recursive: true })

    const { server, harness, info } = await bootWall(page, {
      env: { FRESHELL_CLAUDE_SIDECAR: FAKE_CLAUDE_SIDECAR_SOURCE },
      setupHome: seedWallConfig({ providers: ['claude'], freshAgent: true }),
    })
    try {
      await selectShellIfPickerShowing(page)
      const tabId = (await harness.getActiveTabId())!
      // Wait for the boot pane to become a REAL terminal before opening the
      // pane picker, else openPanePicker races the boot picker's fade-out and
      // the Freshclaude click is swallowed (donor:
      // truly-idle-alerting.spec.ts:122; same guard as Contracts B/D/E/F --
      // kept in the TEST BODY so the produced helper stays verbatim).
      await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })
      await createFreshclaudePane(page, harness, projectDir)
      await sendFreshAgentTurn(page, harness, tabId, 'wall freshclaude turn')
      // Pre-kill turn proof via the HARNESS (Redux), not UI chrome (corrected,
      // council fix round): the fresh-agent transcript renders exclusively
      // from the REST thread snapshot (FreshAgentView.tsx:1302,1782 --
      // getFreshAgentThreadSnapshot -> snapshot?.turns). The claim that "the
      // Rust router has NO claude snapshot adapter -> 503" is FALSE at HEAD --
      // crates/freshell-freshagent/src/snapshot.rs:133-146 routes
      // freshclaude/kilroy + claude through get_claude_snapshot(), a
      // disk+env adapter over the CLI's own transcript store;
      // FRESH_AGENT_RUNTIME_UNAVAILABLE now only fires for session types
      // with no adapter registered at all. This assertion still reads via
      // the harness (not DOM) because the snapshot fetch can race pane
      // creation, not because the adapter is missing. The sidecar protocol
      // itself is verified end-to-end regardless: freshAgent.event/
      // freshAgent.assistant arrives on the wire and folds into the
      // freshAgent slice (turns[]) -- assert THAT (createFreshclaudePane's
      // note: assert pane state via the harness, never error-free UI chrome
      // for freshclaude).
      await expect
        .poll(async () => {
          const sessions = (await harness.getState())?.freshAgent?.sessions ?? {}
          return Object.values(sessions).some((s: any) =>
            (s?.turns ?? []).some((turn: any) =>
              turn?.role === 'assistant'
              && (turn?.items ?? []).some(
                (item: any) => typeof item?.text === 'string' && item.text.includes('Fixture claude turn'),
              ),
            ),
          )
        }, { timeout: 20_000 })
        .toBe(true)

      const originalSessionId: string = await expect
        .poll(async () => leafDurableIdentity(findFreshAgentLeaf(await harness.getPaneLayout(tabId))) ?? null, {
          timeout: 20_000,
        })
        .not.toBeNull()
        .then(async () =>
          leafDurableIdentity(findFreshAgentLeaf(await harness.getPaneLayout(tabId)))!,
        )

      await flushPersistence(page)

      // Council fix round (freshclaude-identity-persistence, B2): audit the
      // FULL restart+reload window for identity-losing re-creates. The fake
      // sidecar mints the SAME static id for every resume-less create, so a
      // regressed persistMiddleware that silently drops sessionRef would
      // still leave leafDurableIdentity() reading the identical constant
      // (colliding onto the SAME transcript file) -- collision-blind on this
      // exact axis, same discrimination applied in
      // specs/freshclaude-identity-persistence-rust.spec.ts.
      await harness.clearSentWsMessages()

      // --- SIGKILL + revive, then reload. ---
      await server.restartAbrupt()
      await waitForWsReady(page)
      await reloadAndReconnect(page, harness)

      // CONTRACT §2.8 target: same identity, history rehydrated, not wedged.
      const rehydratedTabId = (await harness.getActiveTabId())!
      await expect
        .poll(async () => leafDurableIdentity(findFreshAgentLeaf(await harness.getPaneLayout(rehydratedTabId))), {
          timeout: 30_000,
        })
        .toBe(originalSessionId)
      await expect(
        page.locator('[data-context="fresh-agent"]').last().getByText('Fixture claude turn'),
      ).toBeVisible({ timeout: 30_000 })
      const finalLeaf = findFreshAgentLeaf(await harness.getPaneLayout(rehydratedTabId))
      expect(finalLeaf?.content?.status).not.toBe('error')
      expect(finalLeaf?.content?.status).not.toBe('creating')

      // Any freshAgent.create fired across the restart+reload window must
      // carry the ORIGINAL durable id -- never a bare (resume-less) create,
      // which the fixture would otherwise re-stamp with the same static
      // default and mask a lost identity. Non-vacuity checked (follow-up
      // from the PR #562 council review): unlike
      // specs/freshclaude-identity-persistence-rust.spec.ts's test 1, which
      // RELOADS BEFORE the SIGKILL restart and observes exactly one RESPAWN
      // freshAgent.create, THIS leg's ordering -- SIGKILL restart THEN
      // reload -- resolves via freshAgent.attach alone; verified empirically
      // (message list: hello, terminal.attach x3, ..., freshAgent.attach --
      // zero freshAgent.create). So no non-vacuity assertion is added here:
      // one would assert a create that never happens on this ordering and
      // permanently red this leg. The for-loop below stays as the safety
      // net against any future regression that starts firing a bare
      // (identity-losing) create on this path, without falsely claiming a
      // create is expected today.
      const sentAfterRestartReload = await harness.getSentWsMessages()
      const restartCreates = sentAfterRestartReload.filter((m: any) => m?.type === 'freshAgent.create') as any[]
      for (const create of restartCreates) {
        expect(create.resumeSessionId ?? create.sessionRef?.sessionId, JSON.stringify(create)).toBe(originalSessionId)
      }

      // LIVENESS (council follow-up, PR #562/#563 close-out): everything
      // above proves the durable IDENTITY survived, but a mutation where the
      // attach arm sets pane status and never wires the event stream (the
      // literal historical P0.2 bug shape) would leave every assertion above
      // green over a dead socket. Mirror lane test 1's post-restart turn on
      // THIS ordering (SIGKILL restart THEN reload, attach-resolved): send a
      // second turn and require the assistant reply to ROUND-TRIP through
      // the live event stream into the freshAgent slice (turns[] is fed by
      // wire events -- freshAgent.assistant folds, fresh-agent-ws.ts -- so a
      // dead socket can never grow it), plus the fixture transcript on disk
      // gaining the second user line (the server->sidecar leg).
      const countFoldedAssistantTurns = async (): Promise<number> => {
        const sessions = (await harness.getState())?.freshAgent?.sessions ?? {}
        return Object.values(sessions).reduce(
          (n: number, s: any) =>
            n + (s?.turns ?? []).filter((t: any) => t?.role === 'assistant').length,
          0,
        )
      }
      const assistantTurnsBefore = await countFoldedAssistantTurns()
      await sendFreshAgentTurn(page, harness, rehydratedTabId, 'wall freshclaude liveness turn')
      await expect
        .poll(countFoldedAssistantTurns, { timeout: 30_000 })
        .toBeGreaterThan(assistantTurnsBefore)
      const transcriptFile = path.join(
        info.homeDir,
        '.claude',
        'projects',
        '-fixture',
        `${originalSessionId}.jsonl`,
      )
      const transcriptLines = (await fs.readFile(transcriptFile, 'utf8'))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
      const userTexts = transcriptLines
        .filter((l: any) => l.type === 'user')
        .map((l: any) => l.message?.content?.[0]?.text)
      expect(userTexts).toEqual(
        expect.arrayContaining(['wall freshclaude turn', 'wall freshclaude liveness turn']),
      )
      expect(transcriptLines.filter((l: any) => l.type === 'assistant').length).toBeGreaterThanOrEqual(2)
    } finally {
      await server.stop()
      await fs.rm(sharedRoot, { recursive: true, force: true })
    }
  })

  // Per plan §2.9: browser/editor panes are pure client state -- after
  // SIGKILL+restart+reload the browser url and the editor filePath+viewMode
  // must be intact. First-ever reload/restart coverage for these pane kinds.
  test('browser and editor panes: state intact after SIGKILL restart', async ({
    page,
    e2eServerKind,
  }) => {
    expect(e2eServerKind).toBe('rust')
    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-wall-broweditor-'))
    // FILE-BACKED editor pane: content.content never survives persistence
    // (stripEditorContent blanks it at flush AND load, persistMiddleware.ts:
    // 236-243,581 -- BY DESIGN); visible content re-materializes only via
    // file re-fetch on mount (EditorPane.tsx:450-463, connection-gated).
    // PLAINTEXT file, not markdown: the mount re-fetch recomputes
    // viewMode = resolveViewMode(path, language) (EditorPane.tsx:399,122-127)
    // and forces 'preview' for previewable files (markdown/html), clobbering
    // the dispatched 'source' and unmounting Monaco -- a fixture artifact,
    // not a restore red. Plaintext resolves 'source', keeping the §2.9
    // viewMode round-trip + Monaco-visible-marker assertions honest.
    const editorMarker = `wall-editor-${Math.random().toString(36).slice(2, 8)}`
    const editorFilePath = path.join(sharedRoot, 'wall-editor.txt')
    await fs.writeFile(editorFilePath, `wall\n\n${editorMarker}\n`)
    const { server, harness, info } = await bootWall(page)
    try {
      await selectShellIfPickerShowing(page)
      const tabId = (await harness.getActiveTabId())!
      // Wait for the boot pane to become a REAL terminal before right-clicking
      // it, else the boot picker's fade-out swallows the interaction (same
      // guard as Contracts B/D/E/F/G -- kept in the TEST BODY so the produced
      // helper stays verbatim for the Task 9 ruler).
      await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })

      // Browser pane with a concrete URL.
      await createBrowserPaneInPage(page)
      const urlInput = page.getByPlaceholder('Enter URL...')
      await urlInput.fill(`${info.baseUrl}/api/health`)
      await urlInput.press('Enter')
      const iframe = page.locator('iframe[title="Browser content"]')
      await iframe.waitFor({ state: 'attached', timeout: 10_000 })

      // Editor pane via Redux dispatch, file-backed: empty content + filePath
      // makes EditorPane auto-fetch the file on mount (EditorPane.tsx:450-463).
      await page.evaluate(
        ({ currentTabId, filePath }) => {
          const harnessApi = (window as any).__FRESHELL_TEST_HARNESS__
          const state = harnessApi?.getState()
          const paneId = state?.panes?.activePane?.[currentTabId]
          harnessApi?.dispatch({
            type: 'panes/splitPane',
            payload: {
              tabId: currentTabId,
              paneId,
              direction: 'horizontal',
              newPaneId: 'pane-wall-editor',
              newContent: {
                kind: 'editor',
                filePath,
                language: 'plaintext',
                content: '',
                readOnly: false,
                viewMode: 'source',
              },
            },
          })
        },
        { currentTabId: tabId, filePath: editorFilePath },
      )
      await expect(page.locator('.monaco-editor').getByText(editorMarker)).toBeVisible({
        timeout: 20_000,
      })

      await flushPersistence(page)

      // --- SIGKILL + revive, then reload. ---
      await server.restartAbrupt()
      await waitForWsReady(page)
      await reloadAndReconnect(page, harness)

      // CONTRACT §2.9: browser url intact; editor filePath+viewMode intact
      // and visible content re-materialized from the FILE. Do NOT assert
      // content.content in Redux -- it is '' by design (stripEditorContent,
      // persistMiddleware.ts:236-243,581): a red there would be a TEST BUG,
      // never a product regression to pin.
      const rehydratedTabId = (await harness.getActiveTabId())!
      await expect
        .poll(async () => {
          const layout = await harness.getPaneLayout(rehydratedTabId)
          const browserLeaf = collectLeaves(layout).find((l) => l?.content?.kind === 'browser')
          return browserLeaf?.content?.url ?? null
        }, { timeout: 30_000 })
        .toContain('/api/health')
      const layout = await harness.getPaneLayout(rehydratedTabId)
      const editorLeaf = collectLeaves(layout).find((l) => l?.content?.kind === 'editor')
      expect(editorLeaf?.content?.viewMode).toBe('source')
      expect(editorLeaf?.content?.filePath).toBe(editorFilePath)
      // Re-fetch is ASYNC and gated on connection ready (EditorPane.tsx:
      // 454-457) -- poll for the visible content, never assert immediately.
      await expect(page.locator('.monaco-editor').getByText(editorMarker)).toBeVisible({
        timeout: 30_000,
      })
      await expect(page.getByPlaceholder('Enter URL...')).toHaveValue(/\/api\/health/, {
        timeout: 15_000,
      })
    } finally {
      await server.stop()
      await fs.rm(sharedRoot, { recursive: true, force: true })
    }
  })

  test('THE RULER: all pane types live, one SIGKILL, every §2 contract holds', async ({
    page,
    e2eServerKind,
  }) => {
    expect(e2eServerKind).toBe('rust')
    // DEFLAKE (f3wp refresh): 300 s timed out twice back-to-back under
    // concurrent-suite load (2026-07-28, runs at 01:28 and 01:37; both
    // failure screenshots show a healthy, still-progressing page -- slow,
    // not wedged). The ruler's serial cost is structurally LARGER than the
    // double-restart test's (~91 s bootWall + one ~65 s restartAbrupt +
    // every per-pane creation/identity gate for ALL pane types across two
    // tabs), and a 300 s budget recreates the same sum-of-gates > timeout
    // defect the f3wp double-restart fix (:2068-2076) removed at 180 s.
    // 600 s covers the worst case with margin, matching that sibling.
    // NOTE (historical): while this test carried a test.fail pin, a
    // load-starved run's 300 s TEST timeout fired BEFORE the pin's expected
    // in-test red was reached, and a test-level timeout does not satisfy a
    // pin -- so the underfunded budget reds the whole run. The generous
    // budget stays.
    test.setTimeout(600_000)
    // THE RULER IS LIVE (P0.1, last wall pin retired): the composed all-pane
    // ruler runs un-pinned. Its final two reds closed as (1) the claude
    // never-conversed carve-out (reconcile derives Respawn; the post-restart
    // --resume argv leg passes under composition) and (2) the quiet-client
    // alert count excluding monaco's structural aria scaffold -- see the
    // assertion note at the end of this test.

    const CODEX_SESSION_ID = '99999999-8888-4777-8666-555555555555'
    const SESSION_TITLE = 'ruler codex session'
    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-wall-ruler-'))
    const projectDir = path.join(sharedRoot, 'project')
    await fs.mkdir(projectDir, { recursive: true })
    const claudeArgLog = path.join(sharedRoot, 'claude-argv.jsonl')
    const codexArgLog = path.join(sharedRoot, 'codex-argv.jsonl')
    const opencodeArgLog = path.join(sharedRoot, 'opencode-argv.jsonl')
    const opencodeAuditLog = path.join(sharedRoot, 'opencode-audit.jsonl')
    const binDir = path.join(sharedRoot, 'bin')
    const fakeClaudePath = await installFakeCli(FAKE_CLAUDE_CLI_SOURCE, 'claude', binDir)
    const fakeCodexPath = await installDualRoleCodex(binDir, codexArgLog)
    const fakeOpencodePath = await installDualRoleOpencode(binDir, opencodeArgLog, opencodeAuditLog)

    const { server, harness, info } = await bootWall(page, {
      env: {
        CLAUDE_CMD: fakeClaudePath,
        FAKE_CLAUDE_ARGV_LOG: claudeArgLog,
        CODEX_CMD: fakeCodexPath,
        FAKE_CODEX_ARGV_LOG: codexArgLog,
        OPENCODE_CMD: fakeOpencodePath,
        FRESHELL_CLAUDE_SIDECAR: FAKE_CLAUDE_SIDECAR_SOURCE,
      },
      setupHome: async (homeDir) => {
        await seedWallConfig({ providers: ['claude', 'codex', 'opencode'], freshAgent: true })(
          homeDir,
        )
        await seedCodexHome(CODEX_SESSION_ID, SESSION_TITLE, projectDir)(homeDir)
        // seedCodexHome overwrote config.json with codex-only providers; the
        // second write below restores the full set (both are idempotent).
        await seedWallConfig({ providers: ['claude', 'codex', 'opencode'], freshAgent: true })(
          homeDir,
        )
      },
    })
    try {
      // Multi-tab picker opener (setup fix, run of 2026-07-24): openPanePicker
      // probes `.xterm`.first() (pane-picker.ts:10-15), which in this
      // multi-tab test is a HIDDEN tab's still-mounted terminal, so it falls
      // through to an ambiguous 'Add pane' button -- strict-mode violation
      // with >1 tab mounted. Pre-open the split picker from the VISIBLE
      // terminal's context menu; the creation helpers' openPanePicker call
      // then early-returns the already-open picker (pane-picker.ts:5-8),
      // keeping the shared helpers verbatim.
      const openSplitPickerOnVisibleTerminal = async () => {
        await page.locator('.xterm:visible').last().click({ button: 'right' })
        await page.getByRole('menuitem', { name: /split horizontally/i }).click()
        await expect(page.getByRole('toolbar', { name: /pane type picker/i }).last()).toBeVisible({
          timeout: 10_000,
        })
      }

      await selectShellIfPickerShowing(page)
      const tab1 = (await harness.getActiveTabId())!
      // Wait for the boot pane to become a REAL terminal before splitting it,
      // else the boot picker's fade-out swallows the right-click (same guard
      // as Contracts B/D/E/F/G/H -- kept in the TEST BODY).
      await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })

      // --- TAB 1: shell (already there) + browser + editor. ---
      await createBrowserPaneInPage(page)
      const urlInput = page.getByPlaceholder('Enter URL...')
      await urlInput.fill(`${info.baseUrl}/api/health`)
      await urlInput.press('Enter')
      // FILE-BACKED editor pane (editor content.content never survives
      // persistence -- stripEditorContent, persistMiddleware.ts:236-243,581).
      // PLAINTEXT, not markdown (setup fix, run of 2026-07-24; same rationale
      // as Contract H): the mount re-fetch recomputes viewMode =
      // resolveViewMode(path, language) (EditorPane.tsx:399,122-127) and
      // forces 'preview' for previewable files, clobbering the dispatched
      // 'source' BEFORE the kill -- a fixture artifact, not a restore red.
      const editorMarker = 'ruler-editor-marker'
      const editorFilePath = path.join(projectDir, 'ruler-editor.txt')
      await fs.writeFile(editorFilePath, `ruler\n\n${editorMarker}\n`)
      await page.evaluate(
        ({ currentTabId, filePath }) => {
          const harnessApi = (window as any).__FRESHELL_TEST_HARNESS__
          const state = harnessApi?.getState()
          const paneId = state?.panes?.activePane?.[currentTabId]
          harnessApi?.dispatch({
            type: 'panes/splitPane',
            payload: {
              tabId: currentTabId,
              paneId,
              direction: 'horizontal',
              newPaneId: 'pane-ruler-editor',
              newContent: {
                kind: 'editor',
                filePath,
                language: 'plaintext',
                content: '',
                readOnly: false,
                viewMode: 'source',
              },
            },
          })
        },
        { currentTabId: tab1, filePath: editorFilePath },
      )

      // --- TAB 2 (picker/WS path): claude terminal, fresh -> pre-allocated
      // id. REST POST /api/tabs never pre-allocates --session-id
      // (terminal_tabs.rs:756-768); only the WS-path terminal.create does
      // (terminal.rs:969-982), so create the tab via tab-add and pick Claude
      // in the new tab's own pane-type picker. Type the cwd -- candidate
      // dirs may be empty on a clean HOME (files.rs:15-26).
      await page.locator('[data-context="tab-add"]').click()
      await harness.waitForTabCount(2)
      const claudeTabId = (await harness.getActiveTabId())!
      const claudePicker = page.getByRole('toolbar', { name: /pane type picker/i }).last()
      await claudePicker.getByRole('button', { name: /^Claude CLI$/i }).click({ force: true })
      const claudeDirInput = page.getByRole('combobox', {
        name: /Starting directory for Claude/i,
      })
      await expect(claudeDirInput).toBeVisible({ timeout: 15_000 })
      await claudeDirInput.fill(projectDir)
      await claudeDirInput.press('Enter')
      const claudePreallocatedId: string = await expect
        .poll(async () => {
          const entries = await readArgvLog(claudeArgLog)
          const withId = entries.find((e) => e.argv.includes('--session-id'))
          return withId ? withId.argv[withId.argv.indexOf('--session-id') + 1] ?? null : null
        }, { timeout: 20_000 })
        .not.toBeNull()
        .then(async () => {
          const entries = await readArgvLog(claudeArgLog)
          const withId = entries.find((e) => e.argv.includes('--session-id'))!
          return withId.argv[withId.argv.indexOf('--session-id') + 1]!
        })

      // --- TAB 3 (sidebar): codex terminal on the seeded session. ---
      const codexItem = page.getByText(SESSION_TITLE, { exact: false }).first()
      await expect(codexItem).toBeVisible({ timeout: 15_000 })
      await codexItem.click()
      const codexTabId = (await harness.getActiveTabId())!
      await expect
        .poll(async () => (await harness.getPaneLayout(codexTabId))?.content?.terminalId ?? null, {
          timeout: 20_000,
        })
        .not.toBeNull()

      // --- TAB 3 split: opencode terminal, minted via Enter. ---
      // Wait for the codex tab's xterm to render before opening the picker
      // (boot-picker fade-out guard, same as Contracts B/D/E/F/G/H).
      await expect(page.locator('.xterm').last()).toBeVisible({ timeout: 30_000 })
      await openSplitPickerOnVisibleTerminal()
      const opencodeLeaf = await openOpencodePaneAndGetLeaf(page, harness, codexTabId)
      await page.locator('.xterm').last().click()
      await page.keyboard.type('hello ruler opencode')
      await page.keyboard.press('Enter')
      const opencodeSessionId: string = await expect
        .poll(async () => {
          const l = await findLeafById(harness, codexTabId, opencodeLeaf.id)
          return l?.content?.sessionRef?.sessionId ?? l?.content?.resumeSessionId ?? null
        }, { timeout: 20_000 })
        .not.toBeNull()
        .then(async () => {
          const l = await findLeafById(harness, codexTabId, opencodeLeaf.id)
          return l?.content?.sessionRef?.sessionId ?? l?.content?.resumeSessionId
        })

      // --- TAB 4: freshcodex; TAB 5: freshopencode; TAB 6: freshclaude. ---
      // (Tab count so far: tab1 + claude picker tab + codex sidebar tab = 3;
      // the opencode pane is a SPLIT inside the codex tab, not a tab.)
      await page.locator('[data-context="tab-add"]').click()
      await harness.waitForTabCount(4)
      const freshcodexTabId = (await harness.getActiveTabId())!
      await selectShellIfPickerShowing(page)
      // Wait for the new tab's shell xterm before opening the pane picker
      // (boot-picker fade-out guard applies after every tab-add + shell pick).
      await expect(page.locator('.xterm').last()).toBeVisible({ timeout: 30_000 })
      await openSplitPickerOnVisibleTerminal()
      await createFreshcodexPane(page, harness, projectDir)
      await sendFreshAgentTurn(page, harness, freshcodexTabId, 'ruler freshcodex turn')
      const freshcodexId = leafDurableIdentity(
        findFreshAgentLeaf(await harness.getPaneLayout(freshcodexTabId)),
      )!

      await page.locator('[data-context="tab-add"]').click()
      await harness.waitForTabCount(5)
      const freshopencodeTabId = (await harness.getActiveTabId())!
      await selectShellIfPickerShowing(page)
      await expect(page.locator('.xterm').last()).toBeVisible({ timeout: 30_000 })
      // MUST pass the FULL provider list: enableFreshOpencode's
      // previewServerSettingsPatch REPLACES enabledProviders
      // (mergeServerSettings, shared/settings.ts:1216-1218). The default
      // ['opencode'] would hide the Freshclaude button needed for tab 6
      // (PanePicker.tsx:125-152 gates on enabledProviders.includes('claude')).
      await enableFreshOpencode(page, ['claude', 'codex', 'opencode'])
      await openSplitPickerOnVisibleTerminal()
      await createFreshopencodePane(page, projectDir)
      await sendFreshAgentTurn(page, harness, freshopencodeTabId, 'ruler freshopencode turn')
      const freshopencodeId = leafDurableIdentity(
        findFreshAgentLeaf(await harness.getPaneLayout(freshopencodeTabId)),
      )!

      await page.locator('[data-context="tab-add"]').click()
      await harness.waitForTabCount(6)
      const freshclaudeTabId = (await harness.getActiveTabId())!
      await selectShellIfPickerShowing(page)
      await expect(page.locator('.xterm').last()).toBeVisible({ timeout: 30_000 })
      await openSplitPickerOnVisibleTerminal()
      await createFreshclaudePane(page, harness, projectDir)
      await sendFreshAgentTurn(page, harness, freshclaudeTabId, 'ruler freshclaude turn')
      const freshclaudeId = leafDurableIdentity(
        findFreshAgentLeaf(await harness.getPaneLayout(freshclaudeTabId)),
      )!

      const tabCountBefore = await harness.getTabCount()
      const claudeArgvBefore = (await readArgvLog(claudeArgLog)).length
      const codexArgvBefore = (await readArgvLog(codexArgLog)).length
      const opencodeArgvBefore = (await readArgvLog(opencodeArgLog)).length
      await flushPersistence(page)

      // ===================== THE SIGKILL ====================
      await server.restartAbrupt()
      await waitForWsReady(page)
      await reloadAndReconnect(page, harness)
      // ======================================================

      expect(await harness.getTabCount()).toBe(tabCountBefore)

      // Shell (§2.1): recreated, not error.
      await expect
        .poll(async () => {
          const layout = await harness.getPaneLayout(tab1)
          const shellLeaf = collectLeaves(layout).find(
            (l) => l?.content?.kind === 'terminal' && (l?.content?.mode ?? 'shell') === 'shell',
          )
          return shellLeaf?.content?.terminalId ?? null
        }, { timeout: 30_000 })
        .not.toBeNull()

      // Browser + editor (§2.9): durable state intact. Editor content.content
      // is '' by design after persistence (stripEditorContent,
      // persistMiddleware.ts:236-243,581) -- assert the durable fields
      // (filePath/viewMode) instead; tab1 is HIDDEN post-reload, so no
      // visible-content re-fetch assertion here (the file-backed re-fetch is
      // covered by Contract H on a visible pane).
      const tab1Layout = await harness.getPaneLayout(tab1)
      expect(
        collectLeaves(tab1Layout).find((l) => l?.content?.kind === 'browser')?.content?.url,
      ).toContain('/api/health')
      const rulerEditorLeaf = collectLeaves(tab1Layout).find((l) => l?.content?.kind === 'editor')
      expect(rulerEditorLeaf?.content?.viewMode).toBe('source')
      expect(rulerEditorLeaf?.content?.filePath).toBe(editorFilePath)

      // Claude terminal (§2.2): resumed with the pre-allocated id.
      await expect
        .poll(async () => {
          const entries = await readArgvLog(claudeArgLog)
          return entries
            .slice(claudeArgvBefore)
            .some((e) => hasFlagPair(e.argv, '--resume', claudePreallocatedId))
        }, { timeout: 45_000 })
        .toBe(true)

      // Codex terminal (§2.3): resumed.
      await expect
        .poll(async () => {
          const entries = await readArgvLog(codexArgLog)
          return entries
            .slice(codexArgvBefore)
            .some((e) => hasResumePair(e.argv, CODEX_SESSION_ID))
        }, { timeout: 45_000 })
        .toBe(true)

      // Opencode terminal (§2.4): resumed.
      await expect
        .poll(async () => {
          const entries = await readArgvLog(opencodeArgLog)
          return entries
            .slice(opencodeArgvBefore)
            .some((e) => hasFlagPair(e.argv, '--session', opencodeSessionId))
        }, { timeout: 45_000 })
        .toBe(true)

      // Fresh agents (§2.6/§2.7/§2.8): identities survive, status not wedged.
      for (const [tabIdX, expectedId] of [
        [freshcodexTabId, freshcodexId],
        [freshopencodeTabId, freshopencodeId],
        [freshclaudeTabId, freshclaudeId],
      ] as const) {
        await expect
          .poll(async () => leafDurableIdentity(findFreshAgentLeaf(await harness.getPaneLayout(tabIdX))), {
            timeout: 45_000,
          })
          .toBe(expectedId)
        const leafX = findFreshAgentLeaf(await harness.getPaneLayout(tabIdX))
        expect(leafX?.content?.status).not.toBe('error')
        expect(leafX?.content?.status).not.toBe('creating')
      }

      // Quiet client: no alerts, no noisy error text (donor: restore-sync05).
      // (A prior CAVEAT here blamed a freshclaude snapshot 503; that was
      // stale -- snapshot.rs:133-146 routes freshclaude through the disk+env
      // claude adapter and the endpoint has not 503'd since wave A. The only
      // known benign alert source is the transient history-load-error banner
      // from the snapshot fetch racing pane creation -- see
      // createFreshclaudePane's note above.)
      // Monaco's aria scaffold is excluded: setARIAContainer (monaco-editor
      // esm/vs/base/browser/ui/aria/aria.js) permanently mounts exactly two
      // EMPTY `role="alert"` divs (.monaco-alert) the moment the editor pane
      // loads -- screen-reader announcement slots, not user-facing alerts.
      // Unlike restore-sync05 (this assertion's donor), THIS composition has
      // an editor pane (pane-ruler-editor above), so a bare getByRole('alert')
      // count is structurally >=2 here regardless of restart behavior. Every
      // product alert (Pane error banner, TerminalExitBanner, fresh-agent
      // banners, ConnectionErrorOverlay, ...) lacks .monaco-alert and is
      // still counted.
      await expect(page.locator('[role="alert"]:not(.monaco-alert)')).toHaveCount(0)
    } finally {
      await server.stop()
      await fs.rm(sharedRoot, { recursive: true, force: true })
    }
  })

  // -------------------------------------------------------------------------
  // The six named red tests from plan §5 P0.1
  // -------------------------------------------------------------------------

  test('SIGKILL-within-5s-of-pane-creation: identity survives without client state', async ({
    page,
    e2eServerKind,
  }) => {
    expect(e2eServerKind).toBe('rust')
    // P1.8+P1.9 (D3, §4.2) LANDED -- pin flipped: the claude binding row is
    // written durably to the pane-identity ledger BEFORE the PTY spawn, so a
    // SIGKILL moments after spawn (before any snapshot cadence) still leaves
    // a recoverable row. After browser-state loss the recovery inventory
    // reports it (recoverable: true) and the "recover my panes" offer
    // (data-testid="recovery-offer-panel") surfaces it -- the poll below
    // accepts either an auto-restored pane or the visible offer.
    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-wall-5s-'))
    const projectDir = path.join(sharedRoot, 'project')
    await fs.mkdir(projectDir, { recursive: true })
    const argLogPath = path.join(sharedRoot, 'claude-argv.jsonl')
    const fakeClaudePath = await installFakeCli(
      FAKE_CLAUDE_CLI_SOURCE,
      'claude',
      path.join(sharedRoot, 'bin'),
    )
    const { server, harness, info } = await bootWall(page, {
      env: { CLAUDE_CMD: fakeClaudePath, FAKE_CLAUDE_ARGV_LOG: argLogPath },
      setupHome: seedWallConfig({ providers: ['claude'] }),
    })
    try {
      await selectShellIfPickerShowing(page)
      // Wait for the boot pane to become a REAL terminal before opening the
      // pane picker, else openPanePicker races the boot picker's fade-out and
      // the Claude click is swallowed (same guard as Contracts B/D/E/F/G/H).
      await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })
      // Fresh claude pane via the picker/WS path -- REST POST /api/tabs never
      // pre-allocates --session-id (terminal_tabs.rs:756-768); only the
      // WS-path terminal.create does (terminal.rs:969-982). Type the cwd --
      // candidate dirs may be empty on a clean HOME (files.rs:15-26).
      const picker = await openPanePicker(page)
      await picker.getByRole('button', { name: /^Claude CLI$/i }).click({ force: true })
      const dirInput = page.getByRole('combobox', { name: /Starting directory for Claude/i })
      await expect(dirInput).toBeVisible({ timeout: 15_000 })
      await dirInput.fill(projectDir)
      await dirInput.press('Enter')

      // Server-minted identity exists the moment the CLI spawns: the fake
      // appends its argv line synchronously at spawn, so the first
      // --session-id entry marks the pane's t=0. UI creation is slower than
      // a REST call, so the poll gets a UI-scale timeout; the "within 5s of
      // creation" premise is anchored on the SPAWN instead -- SIGKILL is
      // issued immediately after the entry appears (moments after spawn,
      // well inside any snapshot cadence).
      const preallocatedId: string = await expect
        .poll(async () => {
          const entries = await readArgvLog(argLogPath)
          const withId = entries.find((e) => e.argv.includes('--session-id'))
          return withId ? withId.argv[withId.argv.indexOf('--session-id') + 1] ?? null : null
        }, { timeout: 20_000 })
        .not.toBeNull()
        .then(async () => {
          const entries = await readArgvLog(argLogPath)
          const withId = entries.find((e) => e.argv.includes('--session-id'))!
          return withId.argv[withId.argv.indexOf('--session-id') + 1]!
        })

      // ...and the SIGKILL lands immediately after the spawn -- before any
      // snapshot cadence could have persisted the binding. Then the browser
      // loses its state. TWO deviations from the naive clear+reload
      // (observed hang, run of 2026-07-24, DEBUG=pw:api):
      //   (1) an evaluate-time localStorage.clear() is racy -- the persist
      //       middleware re-writes the whole state on the next store update
      //       (reconnect churn), so the "lost" tabs came back. The clear must
      //       run at NAVIGATION time (init script) to be deterministic.
      //   (2) the app strips ?token= from the URL after stashing it in the
      //       (now-cleared) localStorage, so a bare reload can never
      //       re-authenticate -- WS stays offline forever and waitForConnection
      //       hung to the 180s test timeout (setup hang, not the contract
      //       red). Re-enter through the token URL instead -- the same door a
      //       user who lost their browser state walks back in through.
      await server.restartAbrupt()
      await page.addInitScript(() => {
        try {
          localStorage.clear()
          sessionStorage.clear()
        } catch {
          /* about:blank etc. */
        }
      })
      await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
      await harness.waitForHarness()
      await harness.waitForConnection()

      // TARGET CONTRACT (§4.2/§4.4): the server still knows the binding --
      // some pane resuming <preallocatedId> becomes reachable (auto-restored
      // or offered via "recover my panes").
      await expect
        .poll(async () => {
          const state = await harness.getState()
          const layouts = state?.panes?.layouts ?? {}
          for (const layout of Object.values(layouts)) {
            const hit = collectLeaves(layout).find(
              (l) => l?.content?.sessionRef?.sessionId === preallocatedId,
            )
            if (hit) return true
          }
          const recoverOffer = await page
            .getByTestId('recovery-offer-panel')
            .isVisible()
            .catch(() => false)
          return recoverOffer
        }, { timeout: 30_000 })
        .toBe(true)
    } finally {
      await server.stop()
      await fs.rm(sharedRoot, { recursive: true, force: true })
    }
  })

  test('SIGKILL-inside-locator-window: never silently fresh', async ({
    page,
    e2eServerKind,
  }) => {
    expect(e2eServerKind).toBe('rust')
    // P1.8 (§2.4/§4.2 pending markers) LANDED -- pin flipped: killing the
    // server inside the opencode locator's ~2s correlation window is no
    // longer silently fresh. The server derives a loud Fresh{fresh_by_race}
    // verdict from the pending marker that survives the restart (keyed by
    // the client's stale terminalId), and the client renders a DOM-visible
    // breadcrumb (data-testid="fresh-by-race-notice") matching the probe
    // regex below.
    // DETERMINISM (pre-kill phase): the fake's session-row write is held
    // behind FAKE_OPENCODE_TERMINAL_ROW_GATE_PATH and this test NEVER
    // creates the gate file before the kill, so the identity provably
    // cannot land pre-kill -- the race loss is guaranteed, not a few-percent
    // 150ms-sweep coin flip. The gate is opened only AFTER restart, to
    // prove the re-armed locator (P1.10) captures identity end to end.
    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-wall-locwin-'))
    const argLogPath = path.join(sharedRoot, 'opencode-argv.jsonl')
    // Deliberately never created -- see the DETERMINISM note above.
    const rowGatePath = path.join(sharedRoot, 'row-gate-never-created')
    const fakeOpencodePath = await installFakeCli(
      FAKE_OPENCODE_TERMINAL_SOURCE,
      'opencode',
      path.join(sharedRoot, 'bin'),
    )
    const { server, harness } = await bootWall(page, {
      env: {
        OPENCODE_CMD: fakeOpencodePath,
        FAKE_OPENCODE_TERMINAL_ARGV_LOG: argLogPath,
        FAKE_OPENCODE_TERMINAL_ROW_GATE_PATH: rowGatePath,
      },
      setupHome: seedWallConfig({ providers: ['opencode'] }),
    })
    try {
      await selectShellIfPickerShowing(page)
      const tabId = (await harness.getActiveTabId())!
      // Boot-picker fade-out guard before opening the pane picker (same as
      // Contract D and every sibling).
      await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })
      const leaf = await openOpencodePaneAndGetLeaf(page, harness, tabId)

      // Mint the session and kill IMMEDIATELY -- inside the locator window,
      // before terminal.session.associated can land.
      await page.locator('.xterm').last().click()
      await page.keyboard.type('hello locator window')
      await page.keyboard.press('Enter')
      const argvCountBeforeKill = (await readArgvLog(argLogPath)).length
      await server.restartAbrupt()
      await waitForWsReady(page)

      // Wait for the pane to settle post-restart.
      await expect
        .poll(async () => {
          const l = await findLeafById(harness, tabId, leaf.id)
          const tid = l?.content?.terminalId ?? null
          return tid && tid !== leaf.content.terminalId ? tid : null
        }, { timeout: 30_000 })
        .not.toBeNull()

      // TARGET CONTRACT (§2.4/§4.2): EITHER resumed with a ses_ id, OR a
      // visible fresh-by-race breadcrumb. Silent fresh is the failure.
      const resumed = (await readArgvLog(argLogPath))
        .slice(argvCountBeforeKill)
        .some((e) => e.argv.includes('--session'))
      const breadcrumbVisible = await page
        .getByText(/couldn't be resumed|could not be resumed|fresh session/i)
        .first()
        .isVisible()
        .catch(() => false)
      expect(resumed || breadcrumbVisible).toBe(true)

      // P1.10 end-to-end (landed; pinned unit-side by opencode_association.rs
      // restore_created_pane_without_identity_arms_and_resolves_into_the_
      // ledger): the restore-created pane lacks identity, so the locator
      // re-armed at restore-create. Open the fake's row gate NOW and submit —
      // the re-armed locator must capture a ses_ identity post-restart.
      await fs.writeFile(rowGatePath, '')
      await page.locator('.xterm').last().click()
      await page.keyboard.type('hello again after restart')
      await page.keyboard.press('Enter')
      await expect
        .poll(async () => {
          const l = await findLeafById(harness, tabId, leaf.id)
          return l?.content?.sessionRef?.sessionId ?? null
        }, { timeout: 30_000 })
        .toMatch(/^ses_/)
    } finally {
      await server.stop()
      await fs.rm(sharedRoot, { recursive: true, force: true })
    }
  })

  test('two-clients-same-sessionRef: duplicate respawn must yield exactly 1 PTY', async ({
    page,
    browser,
    e2eServerKind,
  }) => {
    expect(e2eServerKind).toBe('rust')
    // Cloud (2-worker shard) wall-clock: SIGKILL + dual-client recovery + a
    // stable-count settle on the arg log exceeds the describe-level 180s.
    test.setTimeout(300_000)
    // P1.7 (D8, §4.3) LANDED -- pin flipped by the reconcile-client-adoption
    // lane: the server now runs a per-sessionRef single-flight lease on the
    // create path (losers get error{SESSION_RESERVED}) and reconcile verdicts
    // attach every other client's claim to the winner, so two clients holding
    // the same sessionRef converge to EXACTLY ONE PTY after SIGKILL.
    const CODEX_SESSION_ID = '77777777-6666-4555-8444-333333333333'
    const SESSION_TITLE = 'two-client codex session'
    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-wall-twoclient-'))
    const projectDir = path.join(sharedRoot, 'project')
    await fs.mkdir(projectDir, { recursive: true })
    const argLogPath = path.join(sharedRoot, 'codex-argv.jsonl')
    // Dual-role: the Rust server's codex terminal lane boots a `codex
    // app-server` sidecar FIRST (PTY_SPAWN_FAILED otherwise), so the fake
    // must answer both app-server argv (fake app-server) and terminal argv.
    const fakeCodexPath = await installDualRoleCodex(path.join(sharedRoot, 'bin'), argLogPath)
    const { server, harness, info } = await bootWall(page, {
      env: { CODEX_CMD: fakeCodexPath, FAKE_CODEX_ARGV_LOG: argLogPath },
      setupHome: seedCodexHome(CODEX_SESSION_ID, SESSION_TITLE, projectDir),
    })
    const contextB = await browser.newContext()
    const pageB = await contextB.newPage()
    try {
      // Client A opens the seeded session from the sidebar.
      await selectShellIfPickerShowing(page)
      await page.getByText(SESSION_TITLE, { exact: false }).first().click()
      const tabIdA = (await harness.getActiveTabId())!
      await expect
        .poll(async () => (await harness.getPaneLayout(tabIdA))?.content?.sessionRef?.sessionId ?? null, {
          timeout: 20_000,
        })
        .toBe(CODEX_SESSION_ID)

      // Client B (separate context = separate localStorage) does the same.
      await pageB.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
      const harnessB = new TestHarness(pageB)
      await harnessB.waitForHarness()
      await harnessB.waitForConnection()
      await selectShellIfPickerShowing(pageB)
      await pageB.getByText(SESSION_TITLE, { exact: false }).first().click()
      const tabIdB = (await harnessB.getActiveTabId())!
      await expect
        .poll(async () => (await harnessB.getPaneLayout(tabIdB))?.content?.sessionRef?.sessionId ?? null, {
          timeout: 20_000,
        })
        .toBe(CODEX_SESSION_ID)

      const argvCountBeforeKill = (await readArgvLog(argLogPath)).length

      // --- SIGKILL; both live clients race to respawn the same sessionRef. ---
      await server.restartAbrupt()
      await waitForWsReady(page)
      await waitForWsReady(pageB)

      // Let both recovery rounds fully settle before counting.
      const countRespawns = async () =>
        (await readArgvLog(argLogPath))
          .slice(argvCountBeforeKill)
          .filter((e) => hasResumePair(e.argv, CODEX_SESSION_ID)).length
      await expect
        .poll(countRespawns, { timeout: 45_000 })
        .toBeGreaterThan(0)
      // STABLE-COUNT settle (not a fixed sleep): accept only when two samples
      // >=5s apart agree, so a tail-latency straggler cannot make the count
      // read 1 spuriously. Under the pre-lease bug the stable count was 2;
      // with sessionRef single-flight landed it must be exactly 1.
      await expect
        .poll(
          async () => {
            const first = await countRespawns()
            await page.waitForTimeout(5_000)
            const second = await countRespawns()
            return second === first ? second : null
          },
          { timeout: 60_000 },
        )
        .not.toBeNull()

      // TARGET CONTRACT (§4.3 multi-client single-flight): EXACTLY 1 PTY.
      const respawns = (await readArgvLog(argLogPath))
        .slice(argvCountBeforeKill)
        .filter((e) => hasResumePair(e.argv, CODEX_SESSION_ID))
      expect(respawns.length).toBe(1)
    } finally {
      await contextB.close()
      await server.stop()
      await fs.rm(sharedRoot, { recursive: true, force: true })
    }
  })

  test('freshclaude busy-restart: a pane that was BUSY at SIGKILL must not wedge BUSY', async ({
    page,
    e2eServerKind,
  }) => {
    expect(e2eServerKind).toBe('rust')
    // PREDICTED-FAIL P0.2 (§2.8.1) but OBSERVED GREEN (run of 2026-07-24), so
    // per the decision rule this test is NOT pinned. The plan predicted a
    // forever-BUSY wedge (freshAgent.attach for claude is silently swallowed,
    // crates/freshell-ws/src/terminal.rs:535-553, so no lost frame arrives).
    // Observed: after SIGKILL+reload the pane's status LEAVES 'running' --
    // claude fresh-agent identity is never persisted (claude.rs:94-96,247 +
    // persistMiddleware.ts:245-266), so the rehydrated pane comes back in the
    // pre-create shape rather than a wedged BUSY one. The §2.8.1 wedge
    // (attach-swallow) is thus masked by the earlier P0.2 identity gap; the
    // pane-level Contract G pin above still covers that gap. If a partial
    // P0.2 fix lands identity persistence WITHOUT the attach arm, this test
    // goes red -- pin it P0.2 (§2.8.1) at that point.
    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-wall-fcbusy-'))
    const projectDir = path.join(sharedRoot, 'project')
    await fs.mkdir(projectDir, { recursive: true })
    const { server, harness } = await bootWall(page, {
      env: {
        FRESHELL_CLAUDE_SIDECAR: FAKE_CLAUDE_SIDECAR_SOURCE,
        FAKE_CLAUDE_SIDECAR_HOLD_TURN: '1',
      },
      setupHome: seedWallConfig({ providers: ['claude'], freshAgent: true }),
    })
    try {
      await selectShellIfPickerShowing(page)
      const tabId = (await harness.getActiveTabId())!
      // Boot-picker fade-out guard before createFreshclaudePane opens the
      // pane picker (same as Contract G and every sibling).
      await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })
      await createFreshclaudePane(page, harness, projectDir)

      // Send a turn that NEVER completes (HOLD_TURN) -> status running.
      const paneRoot = page.locator('[data-context="fresh-agent"]').last()
      await expect
        .poll(async () => findFreshAgentLeaf(await harness.getPaneLayout(tabId))?.content?.status, {
          timeout: 20_000,
        })
        .toBe('idle')
      await paneRoot.getByRole('textbox', { name: 'Chat message input' }).fill('busy turn')
      await paneRoot.getByRole('button', { name: 'Send' }).click()
      await expect
        .poll(async () => findFreshAgentLeaf(await harness.getPaneLayout(tabId))?.content?.status, {
          timeout: 20_000,
        })
        .toBe('running')

      await flushPersistence(page)

      // --- SIGKILL while BUSY, revive, reload (client re-attaches). ---
      await server.restartAbrupt()
      await waitForWsReady(page)
      await reloadAndReconnect(page, harness)

      // TARGET CONTRACT (§2.8.1): within 45s the pane must LEAVE 'running' --
      // any surfaced terminal state (lost/error/idle) is acceptable; a
      // forever-running status is the wedge.
      const rehydratedTabId = (await harness.getActiveTabId())!
      await expect
        .poll(
          async () =>
            findFreshAgentLeaf(await harness.getPaneLayout(rehydratedTabId))?.content?.status ?? null,
          { timeout: 45_000 },
        )
        .not.toBe('running')
    } finally {
      await server.stop()
      await fs.rm(sharedRoot, { recursive: true, force: true })
    }
  })

  test('double-restart mid-recovery: a second SIGKILL during recovery must not duplicate or wedge', async ({
    page,
    e2eServerKind,
  }) => {
    expect(e2eServerKind).toBe('rust')
    // DEFLAKE (f3wp): this test's serial gate budget (20+45+60+30+60+30 s
    // = 245 s) plus 3 serialized boot/health budgets (~91 s bootWall +
    // 2 x 65 s restartAbrupt) structurally exceeds the describe-level 180 s
    // under full parallel-suite load. Post-fix worst case (with the new
    // 60 s WS gate and the 30 s explicit click) is ~556 s, so 300 s would
    // recreate the same sum-of-gates > timeout defect at a higher threshold.
    // 600 s covers the strict worst case with margin. Same per-test override
    // pattern THE RULER uses (:1364).
    test.setTimeout(600_000)
    // ADOPTED REALITY (reconcile-client-adoption lane): the client advertises
    // capabilities.paneReconcileV1 in hello and sends pane.reconcile.request
    // after EVERY ready, so a restart landing mid-recovery is answered by a
    // fresh verdict round on the next reconnect -- panes converge to exactly
    // one live terminal each (asserted via /api/terminals), never a
    // double-create or a dead-ended pane (F9).
    const CODEX_SESSION_ID = '55555555-4444-4333-8222-111111111111'
    const SESSION_TITLE = 'double-restart codex session'
    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-wall-dblrestart-'))
    const projectDir = path.join(sharedRoot, 'project')
    await fs.mkdir(projectDir, { recursive: true })
    const argLogPath = path.join(sharedRoot, 'codex-argv.jsonl')
    // Dual-role: the Rust server's codex terminal lane boots a `codex
    // app-server` sidecar FIRST (PTY_SPAWN_FAILED otherwise), so the fake
    // must answer both app-server argv (fake app-server) and terminal argv.
    const fakeCodexPath = await installDualRoleCodex(path.join(sharedRoot, 'bin'), argLogPath)
    const { server, harness, info } = await bootWall(page, {
      env: { CODEX_CMD: fakeCodexPath, FAKE_CODEX_ARGV_LOG: argLogPath },
      setupHome: seedCodexHome(CODEX_SESSION_ID, SESSION_TITLE, projectDir),
    })
    try {
      await selectShellIfPickerShowing(page)
      await page.getByText(SESSION_TITLE, { exact: false }).first().click({ timeout: 30_000 })
      const tabId = (await harness.getActiveTabId())!
      await expect
        .poll(async () => (await harness.getPaneLayout(tabId))?.content?.terminalId ?? null, {
          timeout: 20_000,
        })
        .not.toBeNull()
      const tabCountBefore = await harness.getTabCount()
      const argvCountBeforeKill = (await readArgvLog(argLogPath)).length
      const countReconcileRequests = async () =>
        (await harness.getSentWsMessages()).filter(
          (m) => (m as { type?: string })?.type === 'pane.reconcile.request',
        ).length
      const reconcileRequestsBeforeKill = await countReconcileRequests()

      // First SIGKILL; wait until recovery is IN FLIGHT (a new spawn hit the
      // argv log), then SIGKILL again mid-recovery.
      await server.restartAbrupt()
      // DEFLAKE (f3wp): gate the reconnect BEFORE polling for the recovery
      // spawn -- under load the client can still be mid-reconnect here, and
      // the argv poll silently burns its 45 s budget waiting on a spawn that
      // cannot start until the WS is ready. The second SIGKILL still lands
      // mid-recovery: the argv-growth poll below remains the trigger.
      await waitForWsReady(page)
      await expect
        .poll(async () => (await readArgvLog(argLogPath)).length, { timeout: 45_000 })
        .toBeGreaterThan(argvCountBeforeKill)
      await server.restartAbrupt()
      await waitForWsReady(page)

      // ADOPTED CONTRACT: the client re-sends pane.reconcile.request on the
      // post-restart ready (the request is per-connection, so the reconnect
      // after the final SIGKILL must have produced at least one more).
      await expect
        .poll(countReconcileRequests, { timeout: 30_000 })
        .toBeGreaterThan(reconcileRequestsBeforeKill)

      // CONTRACT: the pane settles resumed on the same session -- exactly one
      // pane, same tab count, not status:error, resumed argv in the final
      // recovery round.
      await expect(async () => {
        expect(await harness.getTabCount()).toBe(tabCountBefore)
        const content = (await harness.getPaneLayout(tabId))?.content
        expect(content?.status).not.toBe('error')
        expect(content?.sessionRef?.sessionId).toBe(CODEX_SESSION_ID)
        expect(content?.terminalId).toBeTruthy()
      }).toPass({ timeout: 60_000 })
      // No duplicate codex panes anywhere.
      const state = await harness.getState()
      const layouts = state?.panes?.layouts ?? {}
      let codexLeaves = 0
      for (const layout of Object.values(layouts)) {
        codexLeaves += collectLeaves(layout).filter(
          (l) => l?.content?.sessionRef?.sessionId === CODEX_SESSION_ID,
        ).length
      }
      expect(codexLeaves).toBe(1)
      // CONVERGENCE via the REST directory: the persisted codex pane ends
      // with EXACTLY ONE live PTY -- the one the pane is attached to. A
      // stray duplicate from the interrupted first recovery round would
      // show up here as a second running codex terminal.
      // FLAKE HARDENING (2026-07-26, C2 6x proof): resolve the pane's CURRENT
      // terminalId INSIDE the poll -- a pre-poll capture races the pane's own
      // final convergence round (the pane can adopt a NEWER terminal a beat
      // after the toPass block above, leaving the poll comparing against a
      // stale id forever). Assertion strength unchanged: exactly one running
      // codex PTY, and it IS the pane's.
      await expect
        .poll(async () => {
          const paneTerminalId = (await harness.getPaneLayout(tabId))?.content?.terminalId
          if (!paneTerminalId) return null
          const res = await fetch(`${info.baseUrl}/api/terminals`, {
            headers: restApiHeaders(info),
          })
          if (!res.ok) return null
          const terms = (await res.json()) as Array<{ terminalId: string; mode: string; status: string }>
          const runningCodex = terms.filter((t) => t.mode === 'codex' && t.status === 'running')
          return runningCodex.length === 1 && runningCodex[0].terminalId === paneTerminalId
        }, { timeout: 30_000 })
        .toBe(true)
    } finally {
      await server.stop()
      await fs.rm(sharedRoot, { recursive: true, force: true })
    }
  })

  test('hidden-pane rebind: a background tab pane must rebind without being revealed', async ({
    page,
    e2eServerKind,
  }) => {
    expect(e2eServerKind).toBe('rust')
    // PREDICTED-FAIL P1.11 (F8) but OBSERVED GREEN (run of 2026-07-24), so
    // per the decision rule this test is NOT pinned. The plan predicted that
    // hidden panes never send create/attach on reconnect; observed instead
    // that the hidden tab's pane got a NEW terminalId without being revealed
    // -- consistent with the ruler run, where the dead-terminal census
    // reached hidden tabs' layouts and their resume argv polls went green.
    // If F8's prediction materializes in some other composition, pin P1.11
    // here at that point.
    const { server, harness, info } = await bootWall(page)
    try {
      await selectShellIfPickerShowing(page)
      const hiddenTabId = (await harness.getActiveTabId())!
      const hiddenTerminalIdBefore: string = await expect
        .poll(async () => (await harness.getPaneLayout(hiddenTabId))?.content?.terminalId ?? null, {
          timeout: 20_000,
        })
        .not.toBeNull()
        .then(async () => (await harness.getPaneLayout(hiddenTabId))?.content?.terminalId)

      // Second tab becomes active; the first is now hidden.
      await createTabViaRest(info, { mode: 'shell', cwd: os.tmpdir() })
      await harness.waitForTabCount(2)
      await expect
        .poll(async () => harness.getActiveTabId(), { timeout: 15_000 })
        .not.toBe(hiddenTabId)

      // --- SIGKILL + revive; do NOT touch the hidden tab. ---
      await server.restartAbrupt()
      await waitForWsReady(page)

      // TARGET CONTRACT (F8): the HIDDEN pane rebinds (new terminalId) within
      // 30s without being revealed.
      await expect
        .poll(async () => {
          const tid = (await harness.getPaneLayout(hiddenTabId))?.content?.terminalId ?? null
          return tid && tid !== hiddenTerminalIdBefore ? tid : null
        }, { timeout: 30_000 })
        .not.toBeNull()
    } finally {
      await server.stop()
    }
  })
})
