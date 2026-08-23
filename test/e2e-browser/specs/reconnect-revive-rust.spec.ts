/**
 * RECONNECT REVIVE (rust) -- first-class browser proof of the user-visible
 * reconnect acceptance shape on the production server stack
 * (docs/plans/2026-08-22-reconnect-revive.md, Task 8).
 *
 * Six lanes, one per named coverage gap:
 *
 *  1. terminal pane reattaches and repaints after a bare socket drop --
 *     rust-side plain socket drop with "stops being gray/dead" assertions:
 *     pre-drop backlog visible again, offline/recovering chips gone, and a
 *     LIVE post-reconnect input round trip (not a frozen repaint).
 *  2. REST resume door names the live owner in its refusal (red-first
 *     contract): POST /api/tabs with a sessionRef naming a still-running
 *     session stays a 409 (D7 stays in force) but now carries
 *     `liveTerminalId` so any refused caller can reattach instead of
 *     dead-ending on "Session ... is still running on the server."
 *  3. sidebar close -> reopen of a live session converges (regression pin):
 *     LB-1 proved the negotiated WS door / live-row direct attach already
 *     adopts on base -- GREEN on base and after; pins the adopt arm so the
 *     Task 7 refusal-lane work can never regress it.
 *  4. two sequential drops mid-reattach converge to a live pane.
 *  5. server-process freeze (SIGSTOP) forces client-side abandonment before
 *     thaw -- the ONLY discriminating assertion is the client's own status
 *     transition while NO close frame exists (fresh-eyes F3); after thaw,
 *     a normal reconnect + input round trip proves recovery.
 *  6. fresh-agent pane reattaches and round-trips after a bare socket drop.
 *     FIXTURE LIMITATION (per Task 8 execution note): the fake claude
 *     sidecar's real scripted affordances (create/send/interrupt/shutdown +
 *     HOLD_TURN knobs) offer NO scriptable unsolicited post-creation
 *     emission, so there is no "server-side-only marker while the client is
 *     down" hook to use. The discriminator here is therefore the
 *     post-reconnect composer round trip itself, made non-vacuous two ways:
 *     (a) server-side the sidecar request log must gain a NEW send after
 *     the reconnect (the prompt genuinely crossed the new connection), and
 *     (b) client-side the pane must render a strictly GREATER count of the
 *     fixture's fixed reply text than before the drop (the response
 *     genuinely came back over the reattached subscription -- fresh-eyes
 *     F3-2: render-only assertions can pass on surviving local state with a
 *     fully broken reattach).
 *
 * Rust-only: registered in RUST_ONLY_SPECS + the rust-chromium testMatch
 * (socket-drop/freeze revival; drives RustServer + forceDisconnect +
 * SIGSTOP). Not in CLOUD_SKIP_SPECS -- no real provider binaries needed
 * (every claude interaction uses the committed fakes via CLAUDE_CMD /
 * FRESHELL_CLAUDE_SIDECAR env seams).
 *
 * Helpers are COPIED from the donor specs (hidden-pane-rebind-rust,
 * reconcile-client-adoption-rust, restore-contract-wall-rust,
 * opencode-restart-recovery, freshclaude-identity-persistence-rust), not
 * imported, per this suite's per-spec-ownership convention.
 */
import { test, expect } from '../helpers/fixtures.js'
import { RustServer } from '../helpers/rust-server.js'
import type { TestServerInfo } from '../helpers/test-server.js'
import { TestHarness } from '../helpers/test-harness.js'
import { openPanePicker } from '../helpers/pane-picker.js'
import type { Page } from '@playwright/test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// ESM project: derive __dirname -- same convention as every fixture-
// referencing donor spec (e.g. restore-contract-wall-rust.spec.ts).
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const FAKE_CLAUDE_CLI_SOURCE = path.resolve(__dirname, '../fixtures/fake-claude-cli.mjs')
const FAKE_CLAUDE_SIDECAR_SOURCE = path.resolve(__dirname, '../fixtures/fake-claude-sidecar.mjs')

const noDeadEndText = /still running on the server|\[Restore failed\]/

// Playwright signature: waitForFunction(pageFunction, arg, options) -- the
// options object must be the THIRD argument or the timeout is ignored
// (fresh-eyes F3-4).
const waitReady = (page: Page) => page.waitForFunction(
  () => (window as any).__FRESHELL_TEST_HARNESS__?.getState()?.connection?.status === 'ready',
  undefined,
  { timeout: 20_000 },
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

// --- tab close (donor: opencode-restart-recovery.spec.ts:341-348) --
// Plain tab close is DETACH-ONLY (TabBar.tsx: shift-click kills); the
// server-side PTY keeps running -- exactly the close-and-reopen story this
// spec covers.

async function closeTab(page: Page, tabId: string): Promise<void> {
  await page.locator(`[data-context="tab"][data-tab-id="${tabId}"]`).click()
  await page.locator(`[data-context="tab"][data-tab-id="${tabId}"]`).getByRole('button', { name: /close/i }).click()
  await page.waitForFunction((closedTabId) => {
    const tabs = (window as any).__FRESHELL_TEST_HARNESS__?.getState()?.tabs?.tabs ?? []
    return !tabs.some((tab: any) => tab.id === closedTabId)
  }, tabId, { timeout: 10_000 })
}

// --- claude terminal pane via the picker (donor: restore-contract-wall
// :631-719 and reconcile-client-adoption :352-405) -- the picker/WS path
// pre-allocates --session-id at t=0 and binds the pane's session identity,
// which is what the D7 live-guard join sees. ---

async function openClaudePaneAndCapture(
  page: Page,
  harness: TestHarness,
  tabId: string,
  projectDir: string,
  argLogPath: string,
): Promise<{ paneId: string; terminalId: string; sessionId: string }> {
  const beforeIds = new Set(
    findLeavesByMode(await harness.getPaneLayout(tabId), 'claude').map((l) => l.id),
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
  const terminalId: string = leaf.content.terminalId

  const sessionId: string = await expect
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
  expect(sessionId).toMatch(/^[0-9a-f-]{36}$/)

  // Client persisted the identity on the pane (fold via terminal.created).
  await expect
    .poll(async () => {
      const layout = await harness.getPaneLayout(tabId)
      return collectLeaves(layout).find((l) => l.id === leaf.id)?.content?.sessionRef?.sessionId ?? null
    }, { timeout: 20_000 })
    .toBe(sessionId)

  return { paneId: leaf.id, terminalId, sessionId }
}

/**
 * Minimal claude transcript the session index treats as interactive and the
 * sidebar renders: TWO user/assistant turns (a one-turn session is classified
 * non-interactive and silently excluded from the sidebar's default query --
 * restore-matrix.spec.ts's root-cause note) plus a summary line carrying the
 * unique title. Shape donor: restore-matrix.spec.ts scenario 3.
 */
async function writeClaudeTranscript(input: {
  homeDir: string
  projectSlug: string
  sessionId: string
  cwd: string
  title: string
}): Promise<void> {
  const { homeDir, projectSlug, sessionId, cwd, title } = input
  const mk = (suffix: string, extra: Record<string, unknown>) =>
    JSON.stringify({
      parentUuid: `${sessionId}-${suffix}`,
      cwd,
      sessionId,
      version: '2.1.23',
      gitBranch: 'main',
      ...extra,
    })
  const lines: string[] = [
    JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: sessionId,
      uuid: `${sessionId}-system`,
      timestamp: '2026-08-22T08:00:00.000Z',
      cwd,
      git: { branch: 'main', dirty: false },
    }),
    mk('user-1', {
      type: 'user',
      message: { role: 'user', content: `${title} request 1` },
      uuid: `${sessionId}-user-1`,
      timestamp: '2026-08-22T08:00:01.000Z',
    }),
    mk('assistant-1', {
      type: 'assistant',
      message: {
        role: 'assistant',
        model: 'claude-opus-4-6-20260301',
        content: [{ type: 'text', text: `${title} reply 1` }],
        usage: { input_tokens: 100, output_tokens: 40 },
      },
      uuid: `${sessionId}-assistant-1`,
      timestamp: '2026-08-22T08:00:02.000Z',
    }),
    mk('user-2', {
      type: 'user',
      message: { role: 'user', content: `${title} request 2` },
      uuid: `${sessionId}-user-2`,
      timestamp: '2026-08-22T08:00:03.000Z',
    }),
    mk('assistant-2', {
      type: 'assistant',
      message: {
        role: 'assistant',
        model: 'claude-opus-4-6-20260301',
        content: [{ type: 'text', text: `${title} reply 2` }],
        usage: { input_tokens: 100, output_tokens: 40 },
      },
      uuid: `${sessionId}-assistant-2`,
      timestamp: '2026-08-22T08:00:04.000Z',
    }),
    JSON.stringify({
      type: 'summary',
      summary: title,
      leafUuid: `${sessionId}-assistant-2`,
    }),
  ]
  const projectDir = path.join(homeDir, '.claude', 'projects', projectSlug)
  await fs.mkdir(projectDir, { recursive: true })
  await fs.writeFile(path.join(projectDir, `${sessionId}.jsonl`), `${lines.join('\n')}\n`, 'utf8')
}

// --- freshclaude fresh-agent helper (fixture: fake-claude-sidecar.mjs via
// the production env seam FRESHELL_CLAUDE_SIDECAR; donor: hidden-pane-rebind
// :153-182 / freshclaude-identity-persistence :183-219) ---

async function createFreshclaudePane(page: Page, cwd: string): Promise<void> {
  // setAvailableClis is client-only AND gets overwritten by the app
  // bootstrap + /api/platform fetch; callers reach this helper only after
  // harness.waitForConnection(), so the dispatch lands AFTER those
  // overwrites (donor ordering). Keep it that way.
  await page.evaluate(() => {
    ;(window as any).__FRESHELL_TEST_HARNESS__?.dispatch({
      type: 'connection/setAvailableClis',
      payload: { claude: true, codex: false },
    })
  })
  const picker = await openPanePicker(page)
  await picker.getByRole('button', { name: /^Freshclaude$/i }).click({ force: true })
  // /api/files/candidate-dirs returns [] on a clean isolated HOME (no $HOME
  // fallback), so TYPE the cwd and press Enter instead.
  const directoryInput = page.getByLabel(/^Starting directory for Freshclaude$/i)
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

/** Count rendered copies of the fixture's fixed assistant reply text inside
 *  the LAST fresh-agent pane. Per-turn render count is >=1 per turn, so a
 *  strictly-greater count after the second turn is proof the second reply
 *  genuinely rendered (the fixture's reply text is constant, so a distinct-
 *  text assertion is impossible -- count growth is the discriminator). */
async function fixtureReplyCount(page: Page): Promise<number> {
  return page
    .locator('[data-context="fresh-agent"]')
    .last()
    .getByText('Fixture claude turn', { exact: false })
    .count()
}

/** Count `send` entries in the fake claude sidecar's request log. */
async function sidecarSendCount(requestLogPath: string): Promise<number> {
  const raw = await fs.readFile(requestLogPath, 'utf8').catch(() => '')
  if (!raw) return 0
  return raw
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as { msg?: { type?: string } }
      } catch {
        return {}
      }
    })
    .filter((e) => e.msg?.type === 'send').length
}

// ---------------------------------------------------------------------------
// The tests
// ---------------------------------------------------------------------------

test.describe('reconnect revive (rust)', () => {
  test.setTimeout(240_000)

  test('terminal pane reattaches and repaints after a bare socket drop', async ({ freshellPage, page, harness, terminal, e2eServerKind }) => {
    expect(e2eServerKind).toBe('rust')
    await terminal.waitForTerminal()
    await terminal.waitForPrompt()
    await terminal.executeCommand('echo "rr-marker-one"')
    await terminal.waitForOutput('rr-marker-one')

    await harness.forceDisconnect()
    await harness.waitForConnection()
    await waitReady(page)

    // Settled end state, not just "ready": backlog visible again, chips gone.
    await terminal.waitForOutput('rr-marker-one', { timeout: 20_000 })
    await expect(page.getByText('Offline: input will queue until reconnected.')).toHaveCount(0)
    await expect(page.getByText('Recovering terminal output...')).toHaveCount(0)
    await expect(page.getByText(noDeadEndText)).toHaveCount(0)
    // Buffer-level dead-end proof (the xterm notice channel renders to the
    // terminal surface, which getByText can miss under the WebGL renderer).
    expect(await harness.getTerminalBuffer() ?? '').not.toMatch(noDeadEndText)

    // Live, not a frozen repaint: the PTY still answers input AFTER reconnect.
    await terminal.executeCommand('echo "rr-marker-two"')
    await terminal.waitForOutput('rr-marker-two', { timeout: 10_000 })
  })

  test('REST resume door names the live owner in its refusal (red-first contract)', async ({ page, e2eServerKind }) => {
    expect(e2eServerKind).toBe('rust')
    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-rr-rest-door-'))
    const projectDir = path.join(sharedRoot, 'project')
    await fs.mkdir(projectDir, { recursive: true })
    const argLogPath = path.join(sharedRoot, 'claude-argv.jsonl')
    const fakeClaudePath = await installFakeCli(FAKE_CLAUDE_CLI_SOURCE, 'claude', path.join(sharedRoot, 'bin'))
    const { server, harness, info } = await bootWall(page, {
      env: { CLAUDE_CMD: fakeClaudePath, FAKE_CLAUDE_ARGV_LOG: argLogPath },
      setupHome: seedWallConfig({ providers: ['claude'] }),
    })
    try {
      await selectShellIfPickerShowing(page)
      const tabId = (await harness.getActiveTabId())!
      // Wait for the boot pane to become a REAL terminal before opening the
      // pane picker (boot-picker fade-out guard, wall spec :641-647).
      await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })

      // Provider-mode (claude) terminal pane, hermetically seeded with a KNOWN
      // session id (picker pre-allocation; shell panes never reach D7 --
      // create_session_locator -> None for shell).
      const { terminalId, sessionId } = await openClaudePaneAndCapture(
        page,
        harness,
        tabId,
        projectDir,
        argLogPath,
      )

      // Close the tab (detach-only -- a plain close never kills the PTY).
      // NOTE: the app auto-creates a fresh boot tab when the last tab closes,
      // so "the tab is gone" (closeTab's own wait) is the close evidence --
      // never a tab-count of zero.
      await closeTab(page, tabId)

      // The session is STILL RUNNING server-side after the client-side close.
      const terminals = await page.evaluate(
        async ({ baseUrl, token }) => {
          const res = await fetch(`${baseUrl}/api/terminals`, {
            headers: { 'x-auth-token': token },
          })
          return res.ok ? ((await res.json()) as Array<{ terminalId: string; status: string }>) : []
        },
        { baseUrl: info.baseUrl, token: info.token },
      )
      const liveRow = terminals.find((t) => t.terminalId === terminalId)
      expect(liveRow, `terminal ${terminalId} must still be server-side after detach-only close`).toBeTruthy()
      expect(liveRow!.status).toBe('running')

      // Drive the REST resume door exactly as the plan specifies:
      // POST /api/tabs { mode:'claude', sessionRef {...} } via page.evaluate.
      const refusal = await page.evaluate(
        async ({ baseUrl, token, sessionId: sid, cwd }) => {
          const res = await fetch(`${baseUrl}/api/tabs`, {
            method: 'POST',
            headers: { 'x-auth-token': token, 'content-type': 'application/json' },
            body: JSON.stringify({
              mode: 'claude',
              cwd,
              sessionRef: { provider: 'claude', sessionId: sid },
            }),
          })
          return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null }
        },
        { baseUrl: info.baseUrl, token: info.token, sessionId, cwd: projectDir },
      )

      // D7 stays in force: still a 409 with the byte-identical refusal text.
      expect(refusal.status).toBe(409)
      expect(refusal.body?.status).toBe('error')
      expect(refusal.body?.code).toBe('RESTORE_UNAVAILABLE')
      expect(String(refusal.body?.message ?? '')).toContain('is still running on the server.')
      // RED on base: the refusal must NAME the still-running terminal so the
      // refused caller can reattach instead of dead-ending. (Reopen in the
      // same client adopts namelessly via WS; this field is what lets any
      // refused caller reattach.)
      expect(refusal.body?.liveTerminalId).toBe(terminalId)
    } finally {
      await server.stop().catch(() => {})
      await fs.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })

  test('sidebar close -> reopen of a live session converges (regression pin)', async ({ page, e2eServerKind }) => {
    expect(e2eServerKind).toBe('rust')
    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-rr-sidebar-'))
    const projectDir = path.join(sharedRoot, 'project')
    await fs.mkdir(projectDir, { recursive: true })
    const argLogPath = path.join(sharedRoot, 'claude-argv.jsonl')
    const fakeClaudePath = await installFakeCli(FAKE_CLAUDE_CLI_SOURCE, 'claude', path.join(sharedRoot, 'bin'))
    const sessionTitle = `rr sidebar revive ${Date.now()}`
    const { server, harness, info } = await bootWall(page, {
      env: { CLAUDE_CMD: fakeClaudePath, FAKE_CLAUDE_ARGV_LOG: argLogPath },
      setupHome: seedWallConfig({ providers: ['claude'] }),
    })
    try {
      await selectShellIfPickerShowing(page)
      const tabId = (await harness.getActiveTabId())!
      await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })
      const { terminalId, sessionId } = await openClaudePaneAndCapture(
        page,
        harness,
        tabId,
        projectDir,
        argLogPath,
      )
      // Realism: a live claude session always has an on-disk transcript; the
      // sidebar row (and the isRunning enrichment that merges live state into
      // it) is indexed from that file.
      await writeClaudeTranscript({
        homeDir: info.homeDir,
        projectSlug: 'rr-sidebar-proj',
        sessionId,
        cwd: projectDir,
        title: sessionTitle,
      })

      // The sidebar row appears (server session watcher -> sessions.changed ->
      // refetch) and -- because the terminal is still running -- the merged
      // row reports it, which is what routes the click through the
      // direct-attach arm of openSessionTab.
      const sessionList = page.getByTestId('sidebar-session-list')
      await expect(sessionList).toBeVisible({ timeout: 30_000 })
      const sessionRow = sessionList
        .locator(`[data-context="sidebar-session"][data-session-id="${sessionId}"]`)
      await expect(sessionRow).toBeVisible({ timeout: 30_000 })
      await expect(sessionRow).toHaveAttribute('data-is-running', 'true', { timeout: 30_000 })
      await expect(sessionRow).toHaveAttribute('data-running-terminal-id', terminalId, { timeout: 30_000 })

      // Close the tab (detach-only) and reopen from the sidebar session row.
      // (The app auto-creates a fresh boot tab on last-close -- the close
      // evidence is closeTab's own wait, not a zero tab count.)
      await closeTab(page, tabId)

      const argvCountBeforeReopen = (await readArgvLog(argLogPath)).length
      await sessionRow.click()

      // A new tab opens for the session and ADOPTS the still-running terminal:
      // same terminalId on the pane, never a respawn.
      const newTabId: string = await expect
        .poll(async () => harness.getActiveTabId(), { timeout: 15_000 })
        .not.toBeNull()
        .then(async () => (await harness.getActiveTabId())!)
      expect(newTabId).not.toBe(tabId)
      await expect
        .poll(async () => {
          const layout = await harness.getPaneLayout(newTabId)
          const leaf = findLeavesByMode(layout, 'claude')[0]
          return leaf?.content?.terminalId ?? null
        }, { timeout: 20_000 })
        .toBe(terminalId)

      // No respawn: the fake CLI's argv log gains NO new invocation after the
      // click (adoption reattaches to the live PTY, never re-launches claude).
      const argvAfterReopen = await readArgvLog(argLogPath)
      expect(argvAfterReopen.length).toBe(argvCountBeforeReopen)

      // Output continuity: the pane repaints the ORIGINAL spawn marker from
      // the live terminal's scrollback...
      await expect
        .poll(async () => {
          const buffer = await harness.getTerminalBuffer(terminalId)
          return typeof buffer === 'string'
            && buffer.replace(/\n/g, '').includes(`claude: session ${sessionId} started`)
        }, { timeout: 20_000 })
        .toBe(true)

      // ...and the post-reopen input round trip is live: keystrokes reach the
      // still-running PTY and echo back (canonical-mode line discipline under
      // the fixture CLI, which never touches termios).
      await page.locator(`[data-context="terminal"][data-tab-id="${newTabId}"] .xterm`).first().click()
      await page.keyboard.type('rr-reopen-echo-live')
      await expect
        .poll(async () => {
          const buffer = await harness.getTerminalBuffer(terminalId)
          return typeof buffer === 'string' && buffer.replace(/\n/g, '').includes('rr-reopen-echo-live')
        }, { timeout: 15_000 })
        .toBe(true)

      // No dead-end text anywhere -- not in DOM chrome, not in the xterm
      // notice buffer (the pre-Task-7 failure mode was a terminal write of
      // "[Restore failed] ... still running on the server.").
      await expect(page.getByText(noDeadEndText)).toHaveCount(0)
      expect((await harness.getTerminalBuffer(terminalId)) ?? '').not.toMatch(noDeadEndText)
    } finally {
      await server.stop().catch(() => {})
      await fs.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })

  test('two sequential drops mid-reattach converge to a live pane', async ({ freshellPage, page, harness, terminal, e2eServerKind }) => {
    expect(e2eServerKind).toBe('rust')
    await terminal.waitForTerminal()
    await terminal.waitForPrompt()
    await terminal.executeCommand('echo "rr-double"')
    await terminal.waitForOutput('rr-double')
    await harness.forceDisconnect()
    await harness.waitForConnection()
    await harness.forceDisconnect() // drop again before reattach could settle
    await harness.waitForConnection()
    await waitReady(page)
    await terminal.executeCommand('echo "rr-double-after"')
    await terminal.waitForOutput('rr-double-after', { timeout: 20_000 })
    await expect(page.getByText(noDeadEndText)).toHaveCount(0)
    expect((await harness.getTerminalBuffer()) ?? '').not.toMatch(noDeadEndText)
  })

  test('server-process freeze forces client-side abandonment before thaw', async ({ freshellPage, page, harness, terminal, testServer, e2eServerKind }) => {
    expect(e2eServerKind).toBe('rust')
    test.slow() // freeze window must cover the 30s probe + 10s pong timeout
    test.skip(process.platform === 'win32', 'SIGSTOP/SIGCONT are POSIX-only (freeze-spec gate)')
    await terminal.waitForTerminal()
    await terminal.waitForPrompt()
    await terminal.executeCommand('echo "rr-freeze"')
    await terminal.waitForOutput('rr-freeze')

    // Fresh-eyes F3 discrimination: a stalled socket that merely RESUMES after
    // SIGCONT passes every old assertion (ready + input), so they cannot be the
    // discriminator. The one thing only the Task 1 watchdog produces is a
    // client-driven status transition while NO close frame exists. Start an
    // in-page status sampler FIRST (the browser is not frozen -- only the
    // server is), then freeze the server, then require a non-'ready' sample
    // BEFORE thaw.
    await page.evaluate(() => {
      ;(window as any).__rrStatuses = []
      ;(window as any).__rrTimer = setInterval(() => {
        ;(window as any).__rrStatuses.push((window as any).__FRESHELL_TEST_HARNESS__?.getState()?.connection?.status)
      }, 1_000)
    })
    const pid = testServer.info.pid
    try {
      process.kill(pid, 'SIGSTOP')
      // Base behavior: no inbound traffic ever forces a state change -- the
      // sampler never leaves 'ready' and this wait times out (true red-first).
      // With Task 1: t=30s probe -> no pong -> t=40s abandon -> status flips.
      // NOTE (deviation from the plan's 50_000, hardened against flakiness,
      // NOT against discrimination): the 10s liveness TICK is not phase-locked
      // to the freeze, so the worst real timeline is probe fired ~t=40 +
      // pong timeout 10s + sampler lag ~1s => the flip can appear at ~t=51s.
      // 60s still discriminates perfectly: on base the sampler NEVER flips
      // while frozen, so any finite budget reds there identically.
      await page.waitForFunction(
        () => (window as any).__rrStatuses?.some((s: string | undefined) => s !== undefined && s !== 'ready'),
        undefined,
        { timeout: 60_000 },
      )
    } finally {
      try {
        process.kill(pid, 'SIGCONT') // never leave the fixture server stopped
      } catch {
        // Process already gone (fixture teardown raced us) — the primary
        // error from the test body stays the reported failure.
      }
      await page.evaluate(() => clearInterval((window as any).__rrTimer)).catch(() => {})
    }
    await harness.waitForConnection(30_000)
    await waitReady(page)
    await terminal.executeCommand('echo "rr-thawed"')
    await terminal.waitForOutput('rr-thawed', { timeout: 30_000 })
    await expect(page.getByText(noDeadEndText)).toHaveCount(0)
    expect((await harness.getTerminalBuffer()) ?? '').not.toMatch(noDeadEndText)
  })

  test('fresh-agent pane reattaches and round-trips after a bare socket drop', async ({ page, e2eServerKind }) => {
    expect(e2eServerKind).toBe('rust')
    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-rr-freshclaude-'))
    const projectDir = path.join(sharedRoot, 'project')
    await fs.mkdir(projectDir, { recursive: true })
    const requestLogPath = path.join(sharedRoot, 'claude-sidecar-requests.jsonl')
    const { server, harness } = await bootWall(page, {
      env: { FRESHELL_CLAUDE_SIDECAR: FAKE_CLAUDE_SIDECAR_SOURCE, FAKE_CLAUDE_SIDECAR_LOG: requestLogPath },
      setupHome: seedWallConfig({ providers: ['claude'], freshAgent: true }),
    })
    try {
      await selectShellIfPickerShowing(page)
      // Boot-picker fade-out guard before opening the pane picker (donor).
      await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })
      const freshTabId = (await harness.getActiveTabId())!
      await createFreshclaudePane(page, projectDir)
      await expect
        .poll(async () => {
          const c = findFreshAgentLeaf(await harness.getPaneLayout(freshTabId))?.content
          return c?.sessionId ? true : null
        }, { timeout: 30_000 })
        .not.toBeNull()

      // One completed turn BEFORE the drop (the plain happy path).
      await sendFreshAgentTurn(page, harness, freshTabId, 'rr fresh agent turn one')
      const replyCountBeforeDrop: number = await expect
        .poll(async () => fixtureReplyCount(page), { timeout: 30_000 })
        .toBeGreaterThan(0)
        .then(() => fixtureReplyCount(page))
      const sendsBeforeDrop = await sidecarSendCount(requestLogPath)
      expect(sendsBeforeDrop).toBe(1)

      const contentBeforeDrop = findFreshAgentLeaf(
        await harness.getPaneLayout(freshTabId),
      )!.content!

      // Bare socket drop; the server-side sidecar session stays live.
      await harness.forceDisconnect()
      await harness.waitForConnection()
      await waitReady(page)

      // Same session identity after reconnect -- an in-place reattach, never
      // a re-created session. Assert the DURABLE identity: the pane content's
      // bridge-domain `sessionId` may re-key to the durable id during
      // reconnect reconcile (legitimate cosmetics; ordering-dependent), while
      // the durable id domain (`resumeSessionId` / `sessionRef.sessionId`) is
      // the user-meaningful invariant that a reconnect must preserve.
      const contentAfterReconnect = findFreshAgentLeaf(
        await harness.getPaneLayout(freshTabId),
      )!.content!
      expect(contentBeforeDrop.sessionRef?.sessionId).toBeTruthy()
      expect(contentAfterReconnect.sessionRef?.sessionId).toBe(
        contentBeforeDrop.sessionRef?.sessionId,
      )
      expect(contentAfterReconnect.resumeSessionId).toBe(
        contentBeforeDrop.resumeSessionId,
      )

      // Discriminating round trip (see this file's FIXTURE LIMITATION note):
      // (a) the pane renders strictly MORE replies than survived the drop...
      await sendFreshAgentTurn(page, harness, freshTabId, 'rr fresh agent turn two')
      await expect
        .poll(async () => fixtureReplyCount(page), { timeout: 30_000 })
        .toBeGreaterThan(replyCountBeforeDrop)
      // ...(b) and the sidecar request log proves the second send genuinely
      // crossed the (new) server connection to the still-live sidecar.
      await expect
        .poll(async () => sidecarSendCount(requestLogPath), { timeout: 15_000 })
        .toBe(2)
      // ...and no dead-end text ever surfaces in the pane chrome.
      await expect(page.getByText(noDeadEndText)).toHaveCount(0)
    } finally {
      await server.stop().catch(() => {})
      await fs.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })
})
