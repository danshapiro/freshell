/**
 * RECONCILE CLIENT ADOPTION (Task 14) -- e2e proof that pane.reconcile
 * verdicts drive recovery end-to-end with the REAL SPA against the REAL Rust
 * server (docs/plans reconcile-client-adoption lane, Tasks 2-13 merged).
 *
 * Three scenario contracts:
 *   1. restart with mixed pane types: verdicts drive recovery, the legacy
 *      destructive census never destroys a pane (F3 closed);
 *   2. dead sessions surface as ONE batched adjudication panel (council
 *      rule 1) -- nothing auto-closed, per-row explicit decisions;
 *   3. double-restart mid-reconcile converges: no permanent 'creating'
 *      wedge, exactly one live PTY per pane (no duplicates).
 *
 * Rust-only: registered in RUST_ONLY_SPECS + rust-chromium testMatch, because
 * this spec imports RustServer directly (restart()/restartAbrupt()).
 *
 * Helpers are copied, not imported, per the e2e suite's per-spec-ownership
 * convention (donor: restore-contract-wall-rust.spec.ts).
 */
import { test, expect } from '../helpers/fixtures.js'
import { RustServer, type TestServerInfo } from '../helpers/rust-server.js'
import { TestHarness } from '../helpers/test-harness.js'
import { installDualRoleCodexCli } from '../fixtures/codex-dual-role'
import { openPanePicker } from '../helpers/pane-picker.js'
import type { Page } from '@playwright/test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const FAKE_CLAUDE_CLI_SOURCE = path.resolve(__dirname, '../fixtures/fake-claude-cli.mjs')
const FAKE_CODEX_CLI_SOURCE = path.resolve(__dirname, '../fixtures/fake-codex-cli.mjs')

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

/** True when argv contains the adjacent pair `<flag> <value>` (claude --resume). */
function hasFlagPair(argv: string[], flag: string, value: string): boolean {
  const idx = argv.indexOf(flag)
  return idx >= 0 && argv[idx + 1] === value
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

/** Force the persistence middleware to write localStorage NOW. */
async function flushPersistence(page: Page): Promise<void> {
  await page.evaluate(() => {
    ;(window as any).__FRESHELL_TEST_HARNESS__?.dispatch({ type: 'persist/flushNow' })
  })
}

/**
 * index_warming is EXPECTED on cold boots (the server's single 2s deferral is
 * far shorter than a worst-case index scan) and the warming banner's manual
 * "Retry now" is the DESIGNED recovery path (council rule 5). Poll bodies
 * call this so a slow index warm never wedges a settle-loop -- the retry only
 * succeeds once the server-side index actually resolves, so this cannot mask
 * a real failure.
 */
async function retryWarmingIfVisible(page: Page): Promise<void> {
  const banner = page.getByRole('status').filter({ hasText: /Waiting for session index/i }).first()
  if (await banner.isVisible().catch(() => false)) {
    await banner
      .getByRole('button', { name: /Retry now/i })
      .click({ force: true })
      .catch(() => {})
  }
}

/**
 * Idempotent home seed (setupHome re-runs on every boot/restart): the wizard
 * bypass config with claude enabled, PLUS the claude provider ROOT
 * (~/.claude/projects/<proj>) so the existence probe can warm -- a missing
 * provider root is an immediate error{provider_unavailable}, not warming.
 * Deliberately does NOT write transcripts: tests write/delete those
 * themselves and a restart must not resurrect a deleted session file.
 */
const CLAUDE_PROJECT_SLUG = 'reconcile-adoption-proj'
function seedClaudeHome(): (homeDir: string) => Promise<void> {
  return async (homeDir: string) => {
    const freshellDir = path.join(homeDir, '.freshell')
    await fs.mkdir(freshellDir, { recursive: true })
    await fs.writeFile(
      path.join(freshellDir, 'config.json'),
      JSON.stringify(
        {
          version: 1,
          settings: { codingCli: { enabledProviders: ['claude'] } },
        },
        null,
        2,
      ),
    )
    await fs.mkdir(path.join(homeDir, '.claude', 'projects', CLAUDE_PROJECT_SLUG), {
      recursive: true,
    })
  }
}

function claudeTranscriptPath(homeDir: string, sessionId: string): string {
  return path.join(homeDir, '.claude', 'projects', CLAUDE_PROJECT_SLUG, `${sessionId}.jsonl`)
}

/** Minimal claude transcript the session index accepts (carries `cwd`). */
async function writeClaudeTranscript(
  homeDir: string,
  sessionId: string,
  cwd: string,
): Promise<void> {
  const line = JSON.stringify({
    type: 'user',
    message: 'hello from the reconcile adoption fixture',
    uuid: 'msg-1',
    cwd,
    timestamp: '2026-07-22T10:00:00.000Z',
  })
  await fs.writeFile(claudeTranscriptPath(homeDir, sessionId), `${line}\n`, 'utf8')
}

// --- codex dead-session fixtures (PIN 1 blast radius) ---
//
// The batched-adjudication scenario needs panes that reconcile to
// dead_session after a deleted-while-down restart. That shape no longer
// exists for claude: the never-observed-on-disk carve-out (reconcile.rs
// Absent arm) derives Respawn for ledger-bound claude ids the new server
// epoch has never seen on disk. Codex has no Absent-arm carve-out, so a
// ledger-bound codex session whose rollout file is gone stays
// dead_session{session_not_on_disk} -- exactly the batching fixture this
// contract needs. Session fixture shape donor: restore-contract-wall-rust
// .spec.ts's seedCodexHome.

const CODEX_DEAD_SESSION_A = 'aaaaaaaa-1111-4222-8333-000000000001'
const CODEX_DEAD_SESSION_B = 'aaaaaaaa-1111-4222-8333-000000000002'
const CODEX_DEAD_TITLE_A = 'adoption dead codex A'
const CODEX_DEAD_TITLE_B = 'adoption dead codex B'

function codexSessionPath(homeDir: string, sessionId: string): string {
  return path.join(homeDir, '.codex', 'sessions', `${sessionId}.jsonl`)
}

/**
 * Codex home seed: wizard-bypass config with codex enabled PLUS
 * ~/.codex/sessions fixture transcripts. setupHome re-runs on every
 * boot/restart, so the fixtures are written ONLY when the sessions dir is
 * first created -- a restart after the test deletes individual session
 * files must NOT resurrect them (same doctrine as seedClaudeHome's
 * "deliberately does NOT write transcripts" note).
 */
function seedCodexAdoptionHome(
  sessions: Array<{ id: string; title: string }>,
  projectDir: string,
): (homeDir: string) => Promise<void> {
  return async (homeDir: string) => {
    const freshellDir = path.join(homeDir, '.freshell')
    await fs.mkdir(freshellDir, { recursive: true })
    await fs.writeFile(
      path.join(freshellDir, 'config.json'),
      JSON.stringify(
        {
          version: 1,
          settings: { codingCli: { enabledProviders: ['codex'] } },
        },
        null,
        2,
      ),
    )
    const sessionsDir = path.join(homeDir, '.codex', 'sessions')
    const dirExists = await fs.access(sessionsDir).then(
      () => true,
      () => false,
    )
    if (dirExists) return
    await fs.mkdir(sessionsDir, { recursive: true })
    for (const s of sessions) {
      const lines = [
        JSON.stringify({
          timestamp: '2026-07-21T08:00:00.000Z',
          type: 'session_meta',
          payload: { id: s.id, cwd: projectDir },
        }),
        JSON.stringify({
          timestamp: '2026-07-21T08:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: `${s.title} request 1` }],
          },
        }),
        JSON.stringify({
          timestamp: '2026-07-21T08:00:02.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: `${s.title} reply 1` }],
          },
        }),
      ]
      await fs.writeFile(path.join(sessionsDir, `${s.id}.jsonl`), `${lines.join('\n')}\n`)
    }
  }
}

/**
 * Open a seeded codex session from the sidebar history (opens in a NEW tab;
 * the resume create records a durable pane-ledger binding, so 'ever
 * observed' survives a restart). Returns the pane's tab + leaf ids once the
 * pane is live with the expected sessionRef.
 */
async function openSeededCodexSession(
  page: Page,
  harness: TestHarness,
  title: string,
  sessionId: string,
): Promise<{ tabId: string; leafId: string }> {
  const sessionList = page.getByTestId('sidebar-session-list')
  await expect(sessionList).toBeVisible({ timeout: 15_000 })
  const sessionItem = page.getByText(title, { exact: false }).first()
  await expect(sessionItem).toBeVisible({ timeout: 15_000 })
  const tabCountBefore = await harness.getTabCount()
  await sessionItem.click()
  await expect(async () => {
    expect(await harness.getTabCount()).toBe(tabCountBefore + 1)
  }).toPass({ timeout: 15_000 })
  const tabId = (await harness.getActiveTabId())!
  const leafId: string = await expect
    .poll(async () => {
      const layout = await harness.getPaneLayout(tabId)
      const leaf = findLeavesByMode(layout, 'codex').find(
        (l) => l?.content?.terminalId && l?.content?.sessionRef?.sessionId === sessionId,
      )
      return leaf?.id ?? null
    }, { timeout: 20_000 })
    .not.toBeNull()
    .then(async () => {
      const layout = await harness.getPaneLayout(tabId)
      return findLeavesByMode(layout, 'codex').find(
        (l) => l?.content?.sessionRef?.sessionId === sessionId,
      )!.id
    })
  return { tabId, leafId }
}

/** Boot an owned RustServer, navigate, and wait for harness + WS. */
async function bootAdoption(
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

// --- layout tree walkers (donor: restore-contract-wall-rust.spec.ts) ---

function collectLeaves(node: any): any[] {
  if (!node) return []
  if (node.type === 'leaf') return [node]
  if (node.type === 'split') return (node.children ?? []).flatMap(collectLeaves)
  return []
}

function findLeavesByMode(layout: any, mode: string): any[] {
  return collectLeaves(layout).filter((leaf) => leaf?.content?.mode === mode)
}

/** Every terminal-pane leaf across every tab layout. */
async function allTerminalLeaves(harness: TestHarness): Promise<any[]> {
  const state = await harness.getState()
  const layouts = state?.panes?.layouts ?? {}
  const leaves: any[] = []
  for (const layout of Object.values(layouts)) {
    leaves.push(...collectLeaves(layout).filter((l) => l?.content?.kind === 'terminal'))
  }
  return leaves
}

// --- REST directory helper (donor: reconcile-handshake-rust.spec.ts) ---

async function listTerminals(
  info: TestServerInfo,
): Promise<Array<{ terminalId: string; mode: string; status: string; sessionRef?: { provider: string; sessionId: string } }>> {
  const res = await fetch(`${info.baseUrl}/api/terminals`, {
    headers: { 'x-auth-token': info.token },
  })
  expect(res.ok).toBe(true)
  return (await res.json()) as Array<{
    terminalId: string
    mode: string
    status: string
    sessionRef?: { provider: string; sessionId: string }
  }>
}

// --- claude pane creation (donor: restore-contract-wall-rust.spec.ts's
// claude terminal contract; the picker/WS path pre-allocates --session-id) ---

/**
 * Open a NEW claude pane via the picker and return its leaf plus the
 * pre-allocated session id (the Nth distinct `--session-id` value in the
 * fake CLI's argv log).
 */
async function openClaudePaneAndGetLeaf(
  page: Page,
  harness: TestHarness,
  tabId: string,
  projectDir: string,
  argLogPath: string,
): Promise<{ leaf: any; sessionId: string }> {
  const beforeIds = new Set(
    findLeavesByMode(await harness.getPaneLayout(tabId), 'claude').map((l) => l.id),
  )
  const sessionIdsBefore = new Set(
    (await readArgvLog(argLogPath))
      .filter((e) => e.argv.includes('--session-id'))
      .map((e) => e.argv[e.argv.indexOf('--session-id') + 1]),
  )
  const picker = await openPanePicker(page)
  await picker.getByRole('button', { name: /^Claude CLI$/i }).click({ force: true })
  const dirInput = page.getByRole('combobox', { name: /Starting directory for Claude/i })
  await expect(dirInput).toBeVisible({ timeout: 15_000 })
  await dirInput.fill(projectDir)
  await dirInput.press('Enter')

  const leaf = await expect
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

  const sessionId: string = await expect
    .poll(async () => {
      const entries = await readArgvLog(argLogPath)
      const fresh = entries
        .filter((e) => e.argv.includes('--session-id'))
        .map((e) => e.argv[e.argv.indexOf('--session-id') + 1]!)
        .find((id) => id && !sessionIdsBefore.has(id))
      return fresh ?? null
    }, { timeout: 20_000 })
    .not.toBeNull()
    .then(async () => {
      const entries = await readArgvLog(argLogPath)
      return entries
        .filter((e) => e.argv.includes('--session-id'))
        .map((e) => e.argv[e.argv.indexOf('--session-id') + 1]!)
        .find((id) => id && !sessionIdsBefore.has(id))!
    })
  expect(sessionId).toMatch(/^[0-9a-f-]{36}$/)
  return { leaf, sessionId }
}

/** Look up a single leaf by pane id in a tab's current layout. */
async function findLeafById(harness: TestHarness, tabId: string, paneId: string): Promise<any> {
  const layout = await harness.getPaneLayout(tabId)
  return collectLeaves(layout).find((leaf) => leaf.id === paneId) ?? null
}

// ---------------------------------------------------------------------------
// The scenarios
// ---------------------------------------------------------------------------

test.describe('reconcile client adoption (rust server, real SPA)', () => {
  test.setTimeout(240_000)

  test('restart with mixed pane types: verdicts drive recovery, census never destroys', async ({
    page,
    e2eServerKind,
  }) => {
    expect(e2eServerKind).toBe('rust')
    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-adopt-mixed-'))
    const projectDir = path.join(sharedRoot, 'project')
    await fs.mkdir(projectDir, { recursive: true })
    const argLogPath = path.join(sharedRoot, 'claude-argv.jsonl')
    const fakeClaudePath = await installFakeCli(
      FAKE_CLAUDE_CLI_SOURCE,
      'claude',
      path.join(sharedRoot, 'bin'),
    )
    const { server, harness, info } = await bootAdoption(page, {
      env: { CLAUDE_CMD: fakeClaudePath, FAKE_CLAUDE_ARGV_LOG: argLogPath },
      setupHome: seedClaudeHome(),
    })
    try {
      // 1. Boot SPA: a shell pane (the boot picker) + a fake-CLI claude pane
      //    whose pre-allocated session gets a REAL fixture transcript in the
      //    server home (so the post-restart verdict is a respawn, not fresh).
      await selectShellIfPickerShowing(page)
      const tabId = (await harness.getActiveTabId())!
      await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })
      const shellLeaf = collectLeaves(await harness.getPaneLayout(tabId)).find(
        (l) => l?.content?.mode === 'shell',
      )!
      expect(shellLeaf).toBeTruthy()
      const shellTerminalIdBefore: string = await expect
        .poll(async () => (await findLeafById(harness, tabId, shellLeaf.id))?.content?.terminalId ?? null, {
          timeout: 20_000,
        })
        .not.toBeNull()
        .then(async () => (await findLeafById(harness, tabId, shellLeaf.id))!.content.terminalId)

      const { leaf: claudeLeaf, sessionId } = await openClaudePaneAndGetLeaf(
        page,
        harness,
        tabId,
        projectDir,
        argLogPath,
      )
      await writeClaudeTranscript(info.homeDir, sessionId, projectDir)
      const claudeTerminalIdBefore: string = claudeLeaf.content.terminalId
      // Client persisted the identity on the pane (fold via terminal.created).
      await expect
        .poll(async () => (await findLeafById(harness, tabId, claudeLeaf.id))?.content?.sessionRef?.sessionId ?? null, {
          timeout: 20_000,
        })
        .toBe(sessionId)
      await flushPersistence(page)

      const leavesBefore = await allTerminalLeaves(harness)
      const tabCountBefore = await harness.getTabCount()
      const argvCountBeforeRestart = (await readArgvLog(argLogPath)).length

      // 2. Graceful restart on the same home/port/token; the live client
      //    reconnects and reconciles on the new ready.
      await server.restart()
      await waitForWsReady(page)

      // 3a. Shell pane comes back LIVE (fresh per contract row 8): a new
      //     terminalId, working terminal, no restoreError.
      await expect
        .poll(async () => {
          await retryWarmingIfVisible(page)
          const l = await findLeafById(harness, tabId, shellLeaf.id)
          const tid = l?.content?.terminalId ?? null
          return tid && tid !== shellTerminalIdBefore && l?.content?.status === 'running' ? tid : null
        }, { timeout: 60_000 })
        .not.toBeNull()
      expect((await findLeafById(harness, tabId, shellLeaf.id))?.content?.restoreError).toBeFalsy()

      // 3b. CLI pane RESUMES with the SAME sessionRef: new terminalId,
      //     `claude --resume <sessionId>` argv in the post-restart round,
      //     pane sessionRef unchanged.
      await expect
        .poll(async () => {
          await retryWarmingIfVisible(page)
          const l = await findLeafById(harness, tabId, claudeLeaf.id)
          const tid = l?.content?.terminalId ?? null
          return tid && tid !== claudeTerminalIdBefore ? tid : null
        }, { timeout: 60_000 })
        .not.toBeNull()
      await expect
        .poll(async () => {
          const entries = await readArgvLog(argLogPath)
          return entries
            .slice(argvCountBeforeRestart)
            .some((e) => hasFlagPair(e.argv, '--resume', sessionId))
        }, { timeout: 30_000 })
        .toBe(true)
      const claudeAfter = (await findLeafById(harness, tabId, claudeLeaf.id))?.content
      expect(claudeAfter?.sessionRef?.sessionId).toBe(sessionId)
      expect(claudeAfter?.status).not.toBe('error')
      expect(claudeAfter?.restoreError).toBeFalsy()

      //     ...and the resume is visible server-side via /api/terminals: the
      //     running claude terminal carries the SAME sessionRef (the
      //     directory derives it from the resume args the create ran with).
      await expect
        .poll(async () => {
          const terms = await listTerminals(info)
          const running = terms.filter((t) => t.mode === 'claude' && t.status === 'running')
          return (
            running.length === 1
            && running[0].sessionRef?.provider === 'claude'
            && running[0].sessionRef?.sessionId === sessionId
          )
        }, { timeout: 30_000 })
        .toBe(true)

      // 3c. Pane count unchanged -- NOTHING destroyed by the census (F3
      //     closed), no dead-session adjudication for healthy panes.
      const leavesAfter = await allTerminalLeaves(harness)
      expect(leavesAfter.length).toBe(leavesBefore.length)
      expect(await harness.getTabCount()).toBe(tabCountBefore)
      await expect(page.getByRole('dialog', { name: 'Dead sessions' })).toHaveCount(0)
    } finally {
      await server.stop()
      await fs.rm(sharedRoot, { recursive: true, force: true })
    }
  })

  test('dead sessions surface as ONE batched adjudication panel', async ({
    page,
    e2eServerKind,
  }) => {
    expect(e2eServerKind).toBe('rust')
    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-adopt-dead-'))
    const projectDir = path.join(sharedRoot, 'project')
    await fs.mkdir(projectDir, { recursive: true })
    // Dual-role: the Rust codex terminal lane boots a 'codex app-server'
    // sidecar first; a terminal-only fake dies on it (PTY_SPAWN_FAILED).
    const fakeCodexPath = await installDualRoleCodexCli(path.join(sharedRoot, 'bin'), FAKE_CODEX_CLI_SOURCE)
    const { server, harness, info } = await bootAdoption(page, {
      env: { CODEX_CMD: fakeCodexPath },
      setupHome: seedCodexAdoptionHome(
        [
          { id: CODEX_DEAD_SESSION_A, title: CODEX_DEAD_TITLE_A },
          { id: CODEX_DEAD_SESSION_B, title: CODEX_DEAD_TITLE_B },
        ],
        projectDir,
      ),
    })
    try {
      // 1. Two fake-CLI codex panes opened from the seeded sidebar history
      //    (the resume creates record durable pane-ledger bindings, so
      //    'ever observed' survives the restart); verify both live.
      await selectShellIfPickerShowing(page)
      await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })
      const paneA = await openSeededCodexSession(
        page,
        harness,
        CODEX_DEAD_TITLE_A,
        CODEX_DEAD_SESSION_A,
      )
      const paneB = await openSeededCodexSession(
        page,
        harness,
        CODEX_DEAD_TITLE_B,
        CODEX_DEAD_SESSION_B,
      )
      expect(paneB.tabId).not.toBe(paneA.tabId)
      await expect
        .poll(async () =>
          (await listTerminals(info)).filter((t) => t.mode === 'codex' && t.status === 'running').length,
        { timeout: 20_000 })
        .toBe(2)
      await flushPersistence(page)
      const leavesBefore = await allTerminalLeaves(harness)
      const tabCountBefore = await harness.getTabCount()

      // 2. Stop + delete both session files + start on the SAME home/port/
      //    token (RustServer.restart() -- the isolated HOME is never touched
      //    in between, so the deletion below is exactly "gone while down";
      //    the seed's dir-exists guard keeps setupHome from resurrecting
      //    the deleted fixtures on the restart boot).
      await fs.rm(codexSessionPath(info.homeDir, CODEX_DEAD_SESSION_A))
      await fs.rm(codexSessionPath(info.homeDir, CODEX_DEAD_SESSION_B))
      await server.restart()
      await waitForWsReady(page)

      // 3. EXACTLY ONE [role=dialog] (aria-label "Dead sessions") listing
      //    BOTH panes -- never one modal per pane, nothing auto-closed.
      const dialog = page.getByRole('dialog', { name: 'Dead sessions' })
      await expect(async () => {
        await retryWarmingIfVisible(page)
        await expect(dialog).toHaveCount(1)
        await expect(dialog.getByRole('listitem')).toHaveCount(2)
      }).toPass({ timeout: 90_000 })
      // The adjudication panel is the ONLY dialog on screen.
      await expect(page.getByRole('dialog')).toHaveCount(1)

      // Click "Start fresh here" on the FIRST row -> that pane becomes a
      // live terminal (same createRequestId -- the reducer preserves it;
      // exactly ONE running codex PTY serves it).
      await dialog.getByRole('listitem').first().getByRole('button', { name: 'Start fresh here' }).click()

      // Exactly one of the two panes is now a live fresh terminal...
      await expect
        .poll(async () => {
          const contents = await Promise.all(
            [paneA, paneB].map(async (p) => (await findLeafById(harness, p.tabId, p.leafId))?.content),
          )
          const live = contents.filter(
            (c) => c?.status === 'running' && c?.terminalId && !c?.restoreError,
          )
          return live.length
        }, { timeout: 60_000 })
        .toBe(1)
      //    ...backed by EXACTLY ONE running codex PTY server-side (one
      //    create for the pane's createRequestId, no duplicates).
      await expect
        .poll(async () =>
          (await listTerminals(info)).filter((t) => t.mode === 'codex' && t.status === 'running').length,
        { timeout: 30_000 })
        .toBe(1)

      // The second entry is STILL listed; nothing was auto-closed.
      await expect(dialog.getByRole('listitem')).toHaveCount(1)
      expect((await allTerminalLeaves(harness)).length).toBe(leavesBefore.length)
      expect(await harness.getTabCount()).toBe(tabCountBefore)
    } finally {
      await server.stop()
      await fs.rm(sharedRoot, { recursive: true, force: true })
    }
  })

  test('double-restart mid-reconcile converges with no duplicates', async ({
    page,
    e2eServerKind,
  }) => {
    expect(e2eServerKind).toBe('rust')
    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-adopt-dbl-'))
    const projectDir = path.join(sharedRoot, 'project')
    await fs.mkdir(projectDir, { recursive: true })
    const argLogPath = path.join(sharedRoot, 'claude-argv.jsonl')
    const fakeClaudePath = await installFakeCli(
      FAKE_CLAUDE_CLI_SOURCE,
      'claude',
      path.join(sharedRoot, 'bin'),
    )
    const { server, harness, info } = await bootAdoption(page, {
      env: { CLAUDE_CMD: fakeClaudePath, FAKE_CLAUDE_ARGV_LOG: argLogPath },
      setupHome: seedClaudeHome(),
    })
    try {
      // 1. Boot SPA with 2 CLI panes (fixture transcripts on disk).
      await selectShellIfPickerShowing(page)
      const tabId = (await harness.getActiveTabId())!
      await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })
      const paneA = await openClaudePaneAndGetLeaf(page, harness, tabId, projectDir, argLogPath)
      await writeClaudeTranscript(info.homeDir, paneA.sessionId, projectDir)
      const paneB = await openClaudePaneAndGetLeaf(page, harness, tabId, projectDir, argLogPath)
      await writeClaudeTranscript(info.homeDir, paneB.sessionId, projectDir)
      for (const pane of [paneA, paneB]) {
        await expect
          .poll(async () => (await findLeafById(harness, tabId, pane.leaf.id))?.content?.sessionRef?.sessionId ?? null, {
            timeout: 20_000,
          })
          .toBe(pane.sessionId)
      }
      await flushPersistence(page)
      const leavesBefore = await allTerminalLeaves(harness)
      const tabCountBefore = await harness.getTabCount()

      // 2. SIGKILL + reboot; ~300ms into the reconcile window, SIGKILL again.
      await server.restartAbrupt()
      await page.waitForTimeout(300)
      await server.restartAbrupt()
      await waitForWsReady(page)

      // 3a. Within the recovery timeout every pane settles: a LIVE terminal
      //     or an explicit labeled state (restoreError) -- never a permanent
      //     'creating' wedge.
      await expect
        .poll(async () => {
          await retryWarmingIfVisible(page)
          const leaves = await allTerminalLeaves(harness)
          const unsettled = leaves.filter((l) => {
            const c = l?.content
            const live = c?.status === 'running' && c?.terminalId
            const labeled = !!c?.restoreError
            return !(live || labeled)
          })
          return unsettled.length
        }, { timeout: 120_000 })
        .toBe(0)

      // 3b. /api/terminals shows exactly one live PTY per pane
      //     (createRequestId is the pane-owned create key, so pane:PTY is
      //     1:1): every live pane's terminalId is a distinct running
      //     terminal, and NO running terminal is unclaimed (a stray
      //     duplicate from the interrupted first recovery round would show
      //     up as an orphan or a shared terminalId).
      await expect(async () => {
        const leaves = await allTerminalLeaves(harness)
        const liveIds = leaves
          .map((l) => l?.content)
          .filter((c) => c?.status === 'running' && c?.terminalId)
          .map((c) => c.terminalId as string)
        expect(new Set(liveIds).size).toBe(liveIds.length) // no shared PTYs
        const running = (await listTerminals(info)).filter((t) => t.status === 'running')
        const runningIds = new Set(running.map((t) => t.terminalId))
        for (const id of liveIds) expect(runningIds.has(id)).toBe(true)
        expect(running.length).toBe(liveIds.length) // no orphan duplicates
      }).toPass({ timeout: 60_000 })

      // Structural convergence: same tabs, same pane count, and any pane
      // that settled live with an identity kept ITS OWN session.
      expect(await harness.getTabCount()).toBe(tabCountBefore)
      expect((await allTerminalLeaves(harness)).length).toBe(leavesBefore.length)
      for (const pane of [paneA, paneB]) {
        const c = (await findLeafById(harness, tabId, pane.leaf.id))?.content
        if (c?.status === 'running' && c?.sessionRef?.sessionId) {
          expect(c.sessionRef.sessionId).toBe(pane.sessionId)
        }
      }
    } finally {
      await server.stop()
      await fs.rm(sharedRoot, { recursive: true, force: true })
    }
  })
})
