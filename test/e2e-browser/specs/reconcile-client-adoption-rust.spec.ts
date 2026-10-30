/**
 * RECONCILE CLIENT ADOPTION (Task 14) -- e2e proof that pane.reconcile
 * verdicts drive recovery end-to-end with the REAL SPA against the REAL Rust
 * server (docs/plans reconcile-client-adoption lane, Tasks 2-13 merged).
 *
 * Three scenario contracts:
 *   1. destructive census never destroys a pane (F3 closed);
 *   2. dead terminal sessions surface as ONE in-buffer notice line per pane,
 *      never a modal (no-modal contract) -- nothing auto-closed, resolution
 *      through the user-named pane chrome (Replace pane, header close);
 *   3. double-restart mid-reconcile converges: no permanent 'creating'
 *      wedge, exactly one live PTY per pane (no duplicates).
 *
 * this spec imports RustServer directly (restart()/restartAbrupt()).
 *
 * Helpers are copied, not imported, per the e2e suite's per-spec-ownership
 * convention (donor: restore-contract-wall-rust.spec.ts).
 */
import { test, expect } from '../helpers/fixtures.js'
import { RustServer } from '../helpers/rust-server.js'
import type { E2eServerInfo } from '../helpers/server-fixture-support.js'
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

// The dead-session buffer notice line (no-modal contract): pins Task 2's
// DEAD_SESSION_BUFFER_NOTICE literal in src/components/TerminalView.tsx
// byte-for-byte -- a pane whose saved session was deleted explains itself
// with exactly ONE line in its own xterm buffer.
const DEAD_SESSION_BUFFER_NOTICE =
  "[This pane's saved session no longer exists on disk - close this pane or start a new one]"

// The typed SESSION_MISSING resume-refusal line prefix (byte-frozen wire
// text, TerminalView's typed-refusal arm): the reload segment pins its
// ABSENCE for a latched dead pane -- the stood-down pane never sends the
// resume create that would be refused.
const RESUME_FAILED_LINE_PREFIX = '[Resume failed]'

/** Non-overlapping occurrence count of needle in haystack. */
function countOccurrences(haystack: string, needle: string): number {
  let count = 0
  let idx = haystack.indexOf(needle)
  while (idx !== -1) {
    count += 1
    idx = haystack.indexOf(needle, idx + needle.length)
  }
  return count
}

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
 *
 * Seeding-hardened (kata ebp6, "seeded codex leaf null after 20s"): the row
 * wait is SESSION-ID-scoped -- the old title-text locator could match a
 * label anywhere on the page before the sessions index had listed the
 * fixture, clicking into a cold index whose resume create then never
 * associated the pane. Waiting for the id-addressed row guarantees the
 * index is warm BEFORE the click, and retryWarmingIfVisible is retried
 * inside both settle polls.
 */
async function openSeededCodexSession(
  page: Page,
  harness: TestHarness,
  sessionId: string,
): Promise<{ tabId: string; leafId: string }> {
  await retryWarmingIfVisible(page)
  const sessionItem = page.locator(
    `[data-context="sidebar-session"][data-session-id="${sessionId}"]`,
  )
  await expect(sessionItem).toBeVisible({ timeout: 20_000 })
  const tabCountBefore = await harness.getTabCount()
  await sessionItem.click()
  await expect(async () => {
    await retryWarmingIfVisible(page)
    expect(await harness.getTabCount()).toBe(tabCountBefore + 1)
  }).toPass({ timeout: 15_000 })
  const tabId = (await harness.getActiveTabId())!
  const leafId: string = await expect
    .poll(async () => {
      await retryWarmingIfVisible(page)
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
): Promise<{ server: RustServer; info: E2eServerInfo; harness: TestHarness }> {
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
  info: E2eServerInfo,
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
  }) => {
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

  test('dead terminal sessions surface as one in-buffer notice line per pane, no modal', async ({
    page,
  }) => {
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
      //    'ever observed' survives the restart); verify both live. Capture
      //    each pane's terminalId pre-restart: the harness buffer registry
      //    is keyed by terminalId, and a dead pane KEEPS its stale
      //    terminalId through BOTH the live reconnect and the page reload
      //    (the boot rehydrate -- loadPersistedPanes -- strips transient
      //    fields, never terminal identity).
      await selectShellIfPickerShowing(page)
      await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })
      const paneA = await openSeededCodexSession(page, harness, CODEX_DEAD_SESSION_A)
      const paneB = await openSeededCodexSession(page, harness, CODEX_DEAD_SESSION_B)
      expect(paneB.tabId).not.toBe(paneA.tabId)
      await expect
        .poll(async () =>
          (await listTerminals(info)).filter((t) => t.mode === 'codex' && t.status === 'running').length,
        { timeout: 20_000 })
        .toBe(2)
      await flushPersistence(page)
      const leavesBefore = await allTerminalLeaves(harness)
      const tabCountBefore = await harness.getTabCount()
      const staleTerminalIds = new Map<string, string>()
      for (const pane of [paneA, paneB]) {
        const leaf = await findLeafById(harness, pane.tabId, pane.leafId)
        expect(leaf?.content?.terminalId, 'the pre-restart pane carries its terminalId').toBeTruthy()
        staleTerminalIds.set(pane.leafId, leaf!.content!.terminalId as string)
      }

      // 2. Stop + delete both session files + start on the SAME home/port/
      //    token (RustServer.restart() -- the isolated HOME is never touched
      //    in between, so the deletion below is exactly "gone while down";
      //    the seed's dir-exists guard keeps setupHome from resurrecting
      //    the deleted fixtures on the restart boot).
      await fs.rm(codexSessionPath(info.homeDir, CODEX_DEAD_SESSION_A))
      await fs.rm(codexSessionPath(info.homeDir, CODEX_DEAD_SESSION_B))
      await server.restart()
      await waitForWsReady(page)

      // 3. LIVE-RECONNECT SHAPE: the dead verdict folds onto each pane as
      //    the durable restoreError latch (verdict sync for every assert
      //    below -- the fold is what writes the notice and stands recovery
      //    down).
      await expect
        .poll(async () => {
          await retryWarmingIfVisible(page)
          const contents = await Promise.all(
            [paneA, paneB].map(async (p) => (await findLeafById(harness, p.tabId, p.leafId))?.content),
          )
          return contents.filter((c) => c?.restoreError?.reason === 'durable_artifact_missing').length
        }, { timeout: 90_000 })
        .toBe(2)

      // 3a. ZERO dialogs for the whole test: the blocking DeadSessionPanel
      //     modal is GONE -- a dead pane is announced only by its own
      //     surfaces (the notice line + the latch), never a modal.
      const deadSessionsDialog = page.getByRole('dialog', { name: 'Dead sessions' })
      await expect(deadSessionsDialog).toHaveCount(0)

      // 3b. Each dead pane's stale buffer carries the notice line EXACTLY
      //     ONCE. The retained-terminalId line is written at the stand-down
      //     gate AFTER the pane's post-fold attach round is rejected: for
      //     the ACTIVE tab that round is the fold-driven reconcile attach;
      //     for a pane in a BACKGROUND tab it is the REVEAL hydration -- a
      //     background dead pane announces nothing until the user looks at
      //     it (the accepted no-modal tradeoff). Visit each dead pane's tab
      //     first (the user's own tab navigation -- existing chrome, no
      //     new UI), then assert presence-and-count on the FINAL buffer
      //     (read through the captured stale terminalId; a reconnect
      //     reconstruction may legitimately wipe the pre-restart output
      //     first -- the line lands on the post-rejection surface).
      for (const pane of [paneA, paneB]) {
        await page.locator(`[data-context="tab"][data-tab-id="${pane.tabId}"]`).click()
        const staleTerminalId = staleTerminalIds.get(pane.leafId)!
        await expect
          .poll(async () => {
            await retryWarmingIfVisible(page)
            const buffer = (await harness.getTerminalBuffer(staleTerminalId)) ?? ''
            return countOccurrences(buffer, DEAD_SESSION_BUFFER_NOTICE)
          }, { timeout: 60_000 })
          .toBe(1)
      }

      // 3c. No auto-close: NOTHING was removed by the verdicts -- the pane
      //     count and tab count are unchanged from pre-restart.
      expect((await allTerminalLeaves(harness)).length).toBe(leavesBefore.length)
      expect(await harness.getTabCount()).toBe(tabCountBefore)

      // 3d. NO PTY attributable to either dead pane's session was spawned:
      //     no server terminal resuming either dead codex session id. This
      //     is PANE-SCOPED only -- the spec's initial SHELL pane
      //     legitimately gets its own fresh-verdict PTY after the restart,
      //     so server-WIDE PTY counts must never be asserted.
      const termsAfterReconnect = await listTerminals(info)
      expect(
        termsAfterReconnect.filter(
          (t) => t.sessionRef?.sessionId === CODEX_DEAD_SESSION_A
            || t.sessionRef?.sessionId === CODEX_DEAD_SESSION_B,
        ),
        'no terminal may resume either deleted session',
      ).toEqual([])

      // 4. RELOAD SHAPE (the persisted-latch timeline): the per-pane
      //    restoreError latch DELIBERATELY survives the reload, and the
      //    boot rehydrate keeps the pane's stale terminalId
      //    (loadPersistedPanes strips transient fields, never terminal
      //    identity), so the reloaded dead pane takes the SAME stand-down
      //    path as the live reconnect: the boot reconcile re-adjudicates
      //    both panes dead (re-folding the latch and a fresh notice mint)
      //    and the pane's attach to the stale terminal is rejected
      //    INVALID_TERMINAL_ID -- with the latch already standing, the
      //    stand-down gate owns the round and NO recovery create is ever
      //    minted: no PTY, no typed refusal, no failure card (the
      //    resume-the-dead-session attempt never happens), and the one
      //    notice line is re-written onto the fresh post-reload surface.
      //    (The typed SESSION_MISSING [Resume failed] + failure-card shape
      //    belongs to a DIFFERENT timeline -- a reload that lands BEFORE
      //    the dead verdict, when the unlatched pane's recovery create
      //    still resumes the deleted session; it stays pinned by the
      //    TerminalView unit tests and the server's wire tests.)
      await page.reload({ waitUntil: 'domcontentloaded' })
      await harness.waitForHarness(60_000)
      await harness.waitForConnection(120_000)
      for (const pane of [paneA, paneB]) {
        const staleTerminalId = staleTerminalIds.get(pane.leafId)!
        // (a) The boot reconcile re-adjudicates the pane dead: the latch
        //     (persisted AND re-folded) stands.
        await expect
          .poll(async () => {
            await retryWarmingIfVisible(page)
            return (await findLeafById(harness, pane.tabId, pane.leafId))?.content?.restoreError?.reason ?? null
          }, { timeout: 90_000 })
          .toBe('durable_artifact_missing')
        // (b) The pane kept its stale terminalId and carries NO launch
        //     failure: nothing was created and nothing was refused.
        const reloadedContent = (await findLeafById(harness, pane.tabId, pane.leafId))?.content
        expect(reloadedContent?.terminalId).toBe(staleTerminalId)
        expect(reloadedContent?.launchFailure).toBeFalsy()
        // (c) Visit the pane's tab (a BACKGROUND dead pane announces
        //     nothing until the user looks at it -- the reveal drives the
        //     pane's attach round), then the pane's fresh post-reload
        //     buffer carries the notice line EXACTLY ONCE and NEVER a
        //     [Resume failed] line (no create was refused).
        await page.locator(`[data-context="tab"][data-tab-id="${pane.tabId}"]`).click()
        await expect
          .poll(async () => {
            const buffer = (await harness.getTerminalBuffer(staleTerminalId)) ?? ''
            return countOccurrences(buffer, DEAD_SESSION_BUFFER_NOTICE) === 1
              && !buffer.includes(RESUME_FAILED_LINE_PREFIX)
          }, { timeout: 60_000 })
          .toBe(true)
        // (d) NO typed failure card renders: the dead pane's only surfaces
        //     are the notice line and the latch (the Start-fresh card
        //     belongs to the create-refusal shape, which the stood-down
        //     pane never enters).
        const paneShell = page.locator(`[data-pane-shell="true"][data-pane-id="${pane.leafId}"]`)
        await expect(paneShell).toBeVisible({ timeout: 15_000 })
        await expect(paneShell.getByRole('alert', { name: /^Launch failed:/ })).toHaveCount(0)
      }
      // Still zero dialogs after the reload's re-adjudication.
      await expect(deadSessionsDialog).toHaveCount(0)
      const termsAfterReload = await listTerminals(info)
      expect(
        termsAfterReload.filter(
          (t) => t.sessionRef?.sessionId === CODEX_DEAD_SESSION_A
            || t.sessionRef?.sessionId === CODEX_DEAD_SESSION_B,
        ),
      ).toEqual([])

      // 5. Resolve pane A through the user-named "Replace pane" chrome
      //    route (review round 1, finding 5): the pane's own context menu
      //    re-keys the SAME pane node to the type picker; picking a
      //    terminal type mints a NEW identity-less conversation. First
      //    e2e drive of Replace pane (structure donors: PanePicker.tsx,
      //    test/e2e/replace-pane.test.tsx).
      const paneATab = page.locator(`[data-context="tab"][data-tab-id="${paneA.tabId}"]`)
      await paneATab.click()
      const paneAShell = page.locator(`[data-pane-shell="true"][data-pane-id="${paneA.leafId}"]`)
      await expect(paneAShell).toBeVisible({ timeout: 15_000 })
      await paneAShell.locator('.xterm').click({ button: 'right' })
      await page.getByRole('menuitem', { name: 'Replace pane' }).click()
      // The SAME pane node becomes the type picker (replacePane re-keys the
      // leaf's content; the pane id is preserved).
      const paneAPicker = paneAShell.getByRole('toolbar', { name: /pane type picker/i })
      await expect(paneAPicker).toBeVisible({ timeout: 15_000 })
      // A terminal-type option: Codex CLI if offered for this cwd, else
      // Shell (both are existing picker chrome; either proves the route).
      const codexOption = paneAPicker.getByRole('button', { name: /^Codex CLI$/i })
      let replacementMode = 'shell'
      if (await codexOption.isVisible().catch(() => false)) {
        replacementMode = 'codex'
        await codexOption.click({ force: true })
        const directoryInput = paneAShell.getByRole('combobox', {
          name: /Starting directory for Codex/i,
        })
        await expect(directoryInput).toBeVisible({ timeout: 15_000 })
        await directoryInput.fill(projectDir)
        await directoryInput.press('Enter')
      } else {
        await paneAPicker.getByRole('button', { name: /^Shell$/i }).click({ force: true })
      }
      // The same pane node now carries a LIVE terminal: a NEW terminalId
      // (never the stale one), running, latch cleared.
      const paneANewTerminalId = await expect
        .poll(async () => {
          const content = (await findLeafById(harness, paneA.tabId, paneA.leafId))?.content
          return content?.kind === 'terminal'
            && content?.mode === replacementMode
            && content?.terminalId
            && content?.terminalId !== staleTerminalIds.get(paneA.leafId)
            && content?.status === 'running'
            && !content?.restoreError
            ? content.terminalId
            : null
        }, { timeout: 60_000 })
        .not.toBeNull()
        .then(async () => {
          const content = (await findLeafById(harness, paneA.tabId, paneA.leafId))!.content!
          return content.terminalId as string
        })
      // The pane's new conversation is identity-less: its content carries
      // neither dead session id.
      const paneAContentAfterReplace = (await findLeafById(harness, paneA.tabId, paneA.leafId))!.content!
      expect(paneAContentAfterReplace.sessionRef?.sessionId ?? null).not.toBe(CODEX_DEAD_SESSION_A)
      expect(paneAContentAfterReplace.sessionRef?.sessionId ?? null).not.toBe(CODEX_DEAD_SESSION_B)
      // Exactly ONE identity-less PTY attributable to pane A: the new
      // terminalId names exactly one server terminal whose sessionRef (if
      // any -- the directory derives it from RESUME args, and a fresh
      // create has none) is neither dead id. No --resume of the dead
      // session anywhere.
      const termsAfterReplace = await listTerminals(info)
      const paneANewTerminals = termsAfterReplace.filter((t) => t.terminalId === paneANewTerminalId)
      expect(paneANewTerminals).toHaveLength(1)
      expect(paneANewTerminals[0].status).toBe('running')
      expect(paneANewTerminals[0].sessionRef?.sessionId ?? null).not.toBe(CODEX_DEAD_SESSION_A)
      expect(paneANewTerminals[0].sessionRef?.sessionId ?? null).not.toBe(CODEX_DEAD_SESSION_B)
      expect(
        termsAfterReplace.filter(
          (t) => t.sessionRef?.sessionId === CODEX_DEAD_SESSION_A
            || t.sessionRef?.sessionId === CODEX_DEAD_SESSION_B,
        ),
      ).toEqual([])

      // 6. Close pane B via its pane header close button (existing chrome).
      //    LB4 (validated): each dead pane is its own single-pane tab, so
      //    closing pane B removes B's TAB (pane A's tab survives) -- by the
      //    user's click, never by a verdict.
      const paneBTab = page.locator(`[data-context="tab"][data-tab-id="${paneB.tabId}"]`)
      await paneBTab.click()
      await page
        .locator(`[data-pane-shell="true"][data-pane-id="${paneB.leafId}"]`)
        .getByRole('button', { name: 'Close pane' })
        .click()
      await expect(paneBTab).toHaveCount(0, { timeout: 15_000 })
      expect(await harness.getTabCount()).toBe(tabCountBefore - 1)
      expect((await allTerminalLeaves(harness)).length).toBe(leavesBefore.length - 1)

      // 7. FINAL: still zero dialogs for the whole test; pane A's
      //    resolution produced exactly its one new identity-less PTY and
      //    pane B's tab was closed by the user's click; no terminal ever
      //    resumed either dead session id.
      await expect(deadSessionsDialog).toHaveCount(0)
      const termsFinal = await listTerminals(info)
      expect(termsFinal.filter((t) => t.terminalId === paneANewTerminalId)).toHaveLength(1)
      expect(
        termsFinal.filter(
          (t) => t.sessionRef?.sessionId === CODEX_DEAD_SESSION_A
            || t.sessionRef?.sessionId === CODEX_DEAD_SESSION_B,
        ),
      ).toEqual([])
    } finally {
      await server.stop()
      await fs.rm(sharedRoot, { recursive: true, force: true })
    }
  })

  test('double-restart mid-reconcile converges with no duplicates', async ({
    page,
  }) => {
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
