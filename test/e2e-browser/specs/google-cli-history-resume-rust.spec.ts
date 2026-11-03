import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import { test, expect } from '../helpers/fixtures.js'
import { createE2eServerHandle } from '../helpers/external-target.js'
import { TestHarness } from '../helpers/test-harness.js'
import { openPanePicker } from '../helpers/pane-picker.js'
import { WS_PROTOCOL_VERSION } from '../../../shared/ws-protocol.js'
import type { Page } from '@playwright/test'

/**
 * GOOGLE CLI HISTORY + EXACT RESUME (plan Task 12,
 * docs/plans/2026-10-29-google-cli-first-class-support.md) — the
 * history/search/resume acceptance for first-class Antigravity CLI
 * (`agy`, provider `antigravity`) terminal panes on the Rust server.
 * Everything runs against Task 10's deterministic store-writing fake
 * (`fake-agy-terminal.mjs` via `ANTIGRAVITY_CMD`), so no real provider
 * binary is ever invoked; the fake's antigravity home resolves through the
 * server's own seam (the PTY child inherits the server's isolated HOME, so
 * both read `<isolated HOME>/.gemini/antigravity-cli` — the production
 * default, no env override).
 *
 * The eight binding scenarios, mapped onto three per-test owned servers
 * (the codex-terminal-restore / google-cli-launch per-test model — each
 * test needs its own env overrides, its own isolated HOME, and its own
 * restart lifecycle):
 *
 * TEST 1 — concurrency, directory, search:
 *   1. Two concurrent panes in the SAME cwd submit DISTINCT nonces before
 *      either association is polled → each leaf gains its OWN
 *      `sessionRef {provider:'antigravity'}` with DISTINCT ids (the
 *      disk-locator content match adopts each pane's own conversation; the
 *      cache/last_conversations.json sidecar — which the fake maintains
 *      with a single "most recent" row — is never identity: two distinct
 *      bindings are impossible through it);
 *   2. `/api/session-directory` lists BOTH conversations with the right
 *      cwd / first message / title, and the sidebar + History (Projects)
 *      rows show both (the sidebar/history selector surfaces);
 *   3. A `userMessages`-tier search hits the NORMALIZED conversation, not a
 *      raw JSON grep: the nonce row matches (matchedIn `userMessage`),
 *      an UPPERCASE query still matches (case-insensitive text
 *      normalization), the literal record-type string `user_message` —
 *      present in EVERY raw transcript line, present in NO user text —
 *      matches NOTHING, and assistant-only text never matches the
 *      userMessages tier.
 *
 * TEST 2 — stop, exact resume across restart, adjacency, zero-turn:
 *   4. Stop the owned fixture process (WS `terminal.kill` with
 *      `reason:'stuck-recovery'` — the process-only kill that leaves the
 *      pane and its durable session resumable; it reaps exactly this
 *      server's OWN PTY child, never a host process) → the pane settles
 *      `exited` with its identity RETAINED (sessionRef unchanged);
 *   5. `server.restart()` (same home/port/token) + page reload → the
 *      restored pane respawns with the ADJACENT argv pair
 *      `--conversation <sessionId>` and the fake ECHOES the remembered
 *      nonce on a second turn — continued CONTENT, not just an id match;
 *   6. `--continue` NEVER appears in any captured argv (asserted in every
 *      test — Global Constraint 2: the weaker cache mechanism is never a
 *      resume path);
 *   7. A zero-turn pane (created, never submitted) restores FRESH: no
 *      sessionRef, no resume argv, and NO conversation was ever minted for
 *      it (the brain tree holds only the bound pane's conversation).
 *
 * TEST 3 — deleted store, honest restore (two-part shape):
 *   8. Delete `brain/<id>/` under the isolated HOME. PART A: the restart
 *      resume attempt spawns NOTHING — the reconcile door intercepts the
 *      deleted store (`dead_session`/`session_not_on_disk`, no provider
 *      carve-out), parks the pane with `durable_artifact_missing`, and
 *      writes the exact missing-session notice into its terminal buffer
 *      (no modal), so no restore spawn happens on the restart path. PART B
 *      drives a direct create-door restore attempt (this spec's raw WS
 *      client), which launches
 *      with `--conversation <id>` (the antigravity resume gate is deferred
 *      by design — Task 7's honest-restore: no SpawnFresh substitution),
 *      and the PROBED real-binary contract (v1.4.10 + v1.4.12, round-6
 *      receipts; the fake reproduces it byte-for-byte) plays out end to
 *      end: the CLI prints `warning: conversation "<id>" not found` in
 *      the pane and CONTINUES INTO A FRESH INTERACTIVE SESSION — the
 *      pane stays ALIVE (exactly one spawn, no respawn cycle, no exit),
 *      its identity keeps naming the deleted id, the next clean prompt
 *      mints brain/<new-id>/ and the pane REBINDS dead→new through the
 *      server's rebind machinery (previousSessionId names the dead id),
 *      and the History read model lists the fresh conversation. Never a
 *      silent replacement: the dead id is never re-minted and
 *      `--continue` never appears.
  *
  * Cloud legality: deterministic fakes, generous polls (15-100 s), no
 * wall-clock-sensitive waits, and every selector is role/accessible-name
 * based except the a11y-gate-exempt `.xterm` widget root and value-carrying
 * attribute selectors (`[data-session-id=…]`, the session-directory-matrix
 * convention).
 */

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Task 10's store-writing terminal fake (the ANTIGRAVITY_CMD surface).
const FAKE_AGY_TERMINAL_SOURCE = path.resolve(__dirname, '../fixtures/fake-agy-terminal.mjs')

/** The provider list this spec seeds: antigravity only (gemini preservation
 * is Task 11's scenario 6; no gemini pane is launched here). */
const SEEDED_PROVIDERS = ['antigravity']

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DEAD_SESSION_BUFFER_NOTICE =
  "[This pane's saved session no longer exists on disk - close this pane or start a new one]"

// ── per-spec-owned helper copies (the repo convention: copied, not imported) ──

/** Copy-then-chmod a fake CLI into a throwaway bin dir (the
 * installFakeCli pattern, sidebar-registry-sync-rust.spec.ts:37). */
async function installFakeCli(binDir: string, source: string, execName: string): Promise<string> {
  await fs.mkdir(binDir, { recursive: true })
  const target = path.join(binDir, execName)
  await fs.copyFile(source, target)
  await fs.chmod(target, 0o755)
  return target
}

/** setupHome seeding (the codex-terminal-restore-rust.spec.ts:189-198
 * model): `codingCli.enabledProviders` gates the PanePicker's CLI tiles.
 * The antigravity BRAIN ROOT is pre-created so the session watcher arms
 * its recursive watch at boot (the realistic existing-store case: a user
 * with prior conversations has `<home>/.gemini/antigravity-cli/brain/`
 * before they open a new one) — a root ABSENT at boot is only picked up by
 * the watcher's 60 s rearm tick (`session_watcher.rs`
 * REARM_INTERVAL_SECS), which these scenarios do not need to wait on. */
function seedHome(
  enabledProviders: string[],
): (homeDir: string) => Promise<void> {
  return async (homeDir: string) => {
    const freshellDir = path.join(homeDir, '.freshell')
    await fs.mkdir(freshellDir, { recursive: true })
    await fs.writeFile(path.join(freshellDir, 'config.json'), JSON.stringify({
      version: 1,
      settings: {
        codingCli: {
          enabledProviders,
        },
      },
    }, null, 2))
    const brainRoot = path.join(homeDir, '.gemini', 'antigravity-cli', 'brain')
    await fs.mkdir(brainRoot, { recursive: true })
  }
}

// Copied VERBATIM from google-cli-launch-rust.spec.ts:135-149 (donor
// sidebar-registry-sync-rust.spec.ts:52-66).
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

// Copied VERBATIM from google-cli-launch-rust.spec.ts:151-163.
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
 * Copied from google-cli-launch-rust.spec.ts:165-172. */
async function readArgvLog(logPath: string): Promise<Array<{ argv: string[] }>> {
  const raw = await fs.readFile(logPath, 'utf8').catch(() => '')
  if (!raw) return []
  return raw.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as { argv: string[] })
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

/** Re-read the (possibly reshuffled) leaf for a given pane id (the donor's
 * findLeafById, codex-terminal-restore-rust.spec.ts:251-254). */
async function findLeafById(
  harness: TestHarness,
  tabId: string,
  paneId: string,
): Promise<any> {
  const layout = await harness.getPaneLayout(tabId)
  return collectLeaves(layout).find((leaf) => leaf.id === paneId)
}

/**
 * Open a new antigravity pane via the picker with an EXPLICIT cwd — the
 * openCodexPane model (codex-terminal-restore-rust.spec.ts:112-116) plus
 * the directory-combobox `fill` step (unified-agent-names.ts:738-751): the
 * CLI picker's "Starting directory for Antigravity CLI" combobox is filled
 * with `cwd` (both same-cwd panes share it) and Enter submits it.
 */
async function openAntigravityPaneWithCwd(page: Page, cwd: string): Promise<void> {
  const picker = await openPanePicker(page)
  await picker.getByRole('button', { name: /^Antigravity CLI$/i }).click({ force: true })
  const directoryInput = page.getByRole('combobox', { name: /Starting directory for Antigravity CLI/i })
  await directoryInput.waitFor({ state: 'visible', timeout: 10_000 })
  await directoryInput.fill(cwd)
  await directoryInput.press('Enter')
}

/**
 * Open a new antigravity pane (splitting the current terminal) and return
 * the NEWLY-added leaf — identified by diffing the leaf set before vs after
 * (the openModePaneAndGetLeaf model, google-cli-launch-rust.spec.ts:287-308).
 */
async function openAntigravityPaneAndGetLeaf(
  page: Page,
  harness: TestHarness,
  tabId: string,
  cwd: string,
): Promise<any> {
  const beforeIds = new Set(
    findModeLeaves(await harness.getPaneLayout(tabId), 'antigravity').map((leaf) => leaf.id),
  )
  await openAntigravityPaneWithCwd(page, cwd)
  await expect(page.locator('.xterm').last()).toBeVisible({ timeout: 20_000 })
  await expect.poll(async () => {
    const layout = await harness.getPaneLayout(tabId)
    const newLeaf = findModeLeaves(layout, 'antigravity').find((leaf) => !beforeIds.has(leaf.id))
    return newLeaf?.content?.terminalId ? newLeaf : null
  }, { timeout: 20_000 }).not.toBeNull()
  const layout = await harness.getPaneLayout(tabId)
  const newLeaf = findModeLeaves(layout, 'antigravity').find((leaf) => !beforeIds.has(leaf.id))
  if (!newLeaf) throw new Error('no new antigravity leaf appeared after the picker launch')
  return newLeaf
}

/** The pane-scoped xterm container (TerminalView stamps its root with
 * `data-context="terminal"` + `data-pane-id`; a value-carrying attribute
 * selector — the session-directory-matrix convention). */
function paneXterm(page: Page, paneId: string) {
  return page.locator(`[data-context="terminal"][data-pane-id="${paneId}"] .xterm`)
}

/** Click the pane's terminal and submit one line (the codex-restore
 * typing model: click → focus → keyboard). */
async function submitLine(page: Page, paneId: string, line: string): Promise<void> {
  const xterm = paneXterm(page, paneId)
  await xterm.click()
  await page.keyboard.type(line)
  await page.keyboard.press('Enter')
}

/** The pane's terminal buffer with wrapped newlines stripped (xterm wraps
 * long lines at the column width — the codex-restore `unwrapped` model). */
async function leafBufferUnwrapped(
  harness: TestHarness,
  terminalId: string,
): Promise<string> {
  const buffer = await harness.getTerminalBuffer(terminalId)
  return typeof buffer === 'string' ? buffer.replace(/\n/g, '') : ''
}

/**
 * Poll a pane's CURRENT terminal buffer for `needle` — re-reading the leaf
 * each iteration so a terminalId that changes once more after the reload
 * (the reconcile-verdict respawn fold, codex-terminal-restore's WAVE-B
 * note) is always the CONVERGED state's buffer, never a stale sample.
 */
async function pollLeafBuffer(
  harness: TestHarness,
  tabId: string,
  paneId: string,
  needle: string,
  timeout: number,
): Promise<void> {
  await expect.poll(async () => {
    const leaf = await findLeafById(harness, tabId, paneId)
    const terminalId = leaf?.content?.terminalId
    if (!terminalId || leaf?.content?.status === 'error') return false
    const unwrapped = await leafBufferUnwrapped(harness, terminalId)
    return unwrapped.includes(needle)
  }, { timeout }).toBe(true)
}

// ── the spec-owned raw WS client (the ws-ping-pong-matrix.spec.ts pattern,
// extended with frame capture — WsCapture where frames matter) ────────────

/**
 * Open a raw WS connection and complete the harness-token hello handshake
 * (copied from ws-ping-pong-matrix.spec.ts:37-64).
 */
function connectAndHello(wsUrl: string, token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    const timeout = setTimeout(() => {
      ws.removeAllListeners()
      ws.terminate()
      reject(new Error('Timed out waiting for ready after hello'))
    }, 15_000)

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'hello', token, protocolVersion: WS_PROTOCOL_VERSION }))
    })

    ws.on('message', (raw) => {
      const message = JSON.parse(String(raw))
      if (message?.type === 'ready') {
        clearTimeout(timeout)
        ws.removeAllListeners('message')
        resolve(ws)
      }
    })

    ws.on('error', (err) => {
      clearTimeout(timeout)
      reject(err)
    })
  })
}

/** Resolve with the next message matching `predicate`, or reject on timeout
 * (copied from ws-ping-pong-matrix.spec.ts:67-85). */
function nextMessage(
  ws: WebSocket,
  predicate: (message: any) => boolean,
  timeoutMs = 15_000,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.removeListener('message', onMessage)
      reject(new Error(`Timed out waiting for matching WS message within ${timeoutMs}ms`))
    }, timeoutMs)

    function onMessage(raw: WebSocket.RawData) {
      let message: any
      try {
        message = JSON.parse(String(raw))
      } catch {
        return
      }
      if (predicate(message)) {
        clearTimeout(timeout)
        ws.removeListener('message', onMessage)
        resolve(message)
      }
    }

    ws.on('message', onMessage)
  })
}

/** Close a raw WS client, tolerating an already-closed socket. */
function closeWs(ws: WebSocket | null): void {
  try {
    ws?.close()
  } catch {
    // already closed
  }
}

// ── session-directory + brain-tree helpers ─────────────────────────────────

/**
 * The sidebar's session list is the always-rendered session surface (the
 * session-directory-matrix spec asserts `sidebar-session-list` visible at
 * boot); tolerate a collapsed sidebar (mobile-width boots) through the
 * "Show sidebar" toggle (the unified-agent-names.ts:1419 fallback).
 */
async function ensureSidebarVisible(page: Page): Promise<void> {
  const list = page.getByTestId('sidebar-session-list')
  if (await list.isVisible().catch(() => false)) return
  await page.getByRole('button', { name: /show sidebar/i }).click()
  await expect(list).toBeVisible({ timeout: 15_000 })
}

/** One `DirItem` row of the History read model (the serialized
 * `SessionDirectoryItem` shape, session_directory.rs `DirItem::to_value`). */
interface DirectoryItem {
  sessionId: string
  provider: string
  cwd?: string
  title?: string
  summary?: string
  firstUserMessage?: string
  matchedIn?: string
  snippet?: string
  isRunning?: boolean
}

/** `GET /api/session-directory?priority=visible&limit=50` — the History read
 * model (the session-directory-matrix.spec.ts:422-427 fetch shape). */
async function fetchDirectory(
  info: { baseUrl: string; token: string },
): Promise<DirectoryItem[]> {
  const response = await fetch(
    `${info.baseUrl}/api/session-directory?priority=visible&limit=50`,
    { headers: { 'x-auth-token': info.token } },
  )
  expect(response.ok, `GET /api/session-directory: ${response.status}`).toBe(true)
  const payload = await response.json() as { items?: DirectoryItem[] }
  return payload?.items ?? []
}

/** The isolated antigravity brain tree — the production default resolution
 * (`<isolated HOME>/.gemini/antigravity-cli/brain`), the same seam the fake
 * resolves through the PTY child's inherited env. */
function brainRootOf(info: { homeDir: string }): string {
  return path.join(info.homeDir, '.gemini', 'antigravity-cli', 'brain')
}

/** Every conversation id currently minted under the isolated brain tree. */
async function listBrainIds(info: { homeDir: string }): Promise<string[]> {
  const entries = await fs.readdir(brainRootOf(info), { withFileTypes: true })
    .catch(() => [] as Array<{ name: string; isDirectory(): boolean }>)
  return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort()
}

/** The antigravity argv contract shared by every scenario: `-i` present on
 * fresh spawns, and the weaker `--continue` cache mechanism NEVER present
 * (Global Constraint 2 — scenario 6, asserted in all three tests). */
function expectNoContinueAnywhere(rows: Array<{ argv: string[] }>): void {
  for (const row of rows) {
    expect(row.argv, `argv: ${JSON.stringify(row.argv)}`).not.toContain('--continue')
  }
}

/** The fixture bundle every test owns: a fake `agy` binary, its argv log,
 * and a cwd dir the panes share. */
async function makeFixture(rootPrefix: string): Promise<{
  sharedRoot: string
  agyArgLog: string
  fakeAgyPath: string
  cwdDir: string
}> {
  const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), rootPrefix))
  const agyArgLog = path.join(sharedRoot, 'fake-agy-terminal-argv.jsonl')
  const fakeAgyPath = await installFakeCli(path.join(sharedRoot, 'bin'), FAKE_AGY_TERMINAL_SOURCE, 'agy')
  const cwdDir = path.join(sharedRoot, 'workdir')
  await fs.mkdir(cwdDir, { recursive: true })
  return { sharedRoot, agyArgLog, fakeAgyPath, cwdDir }
}

/** Boot the per-test owned server with the fake CLI wired (the
 * google-cli-launch-rust.spec.ts server shape). */
async function startOwnedServer(
  fixture: { fakeAgyPath: string; agyArgLog: string },
) {
  const server = await createE2eServerHandle(process.env, {
    construct: {
      env: {
        ANTIGRAVITY_CMD: fixture.fakeAgyPath,
        FAKE_AGY_TERMINAL_ARGV_LOG: fixture.agyArgLog,
      },
      setupHome: seedHome(SEEDED_PROVIDERS),
    },
  })
  return server
}

test.describe('Google CLI history + exact resume (Rust): antigravity identity, directory, search, restart', () => {
  test.setTimeout(240_000)

  test('scenarios 1-3: two same-cwd panes bind distinct conversations; the directory and sidebar/history list both; the userMessages tier searches normalized text, never raw JSON', async ({ page }) => {
    const fixture = await makeFixture('freshell-google-cli-history-')
    try {
      const server = await startOwnedServer(fixture)
      const info = await server.start()
      try {
        const harness = await bootAndConnect(page, info)
        await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })
        const tabId = await harness.getActiveTabId()
        expect(tabId).toBeTruthy()

        // ── Scenario 1: two concurrent panes in the SAME cwd ──────────────
        // Both panes are opened and BOTH nonces submitted before either
        // association is polled (the rebind suite's true-concurrency shape,
        // end to end: each pane's locator sees both transcripts; content
        // matching must adopt each pane's OWN conversation).
        const leafA = await openAntigravityPaneAndGetLeaf(page, harness, tabId!, fixture.cwdDir)
        const paneIdA: string = leafA.id
        const terminalIdA: string = leafA.content.terminalId
        expect(terminalIdA).toBeTruthy()

        const leafB = await openAntigravityPaneAndGetLeaf(page, harness, tabId!, fixture.cwdDir)
        const paneIdB: string = leafB.id
        const terminalIdB: string = leafB.content.terminalId
        expect(terminalIdB).toBeTruthy()
        expect(paneIdB).not.toBe(paneIdA)

        await expect.poll(async () => (await leafBufferUnwrapped(harness, terminalIdA)).includes('agy> '), { timeout: 20_000 }).toBe(true)
        await expect.poll(async () => (await leafBufferUnwrapped(harness, terminalIdB)).includes('agy> '), { timeout: 20_000 }).toBe(true)

        const nonceLineA = 'remember: nonce-alpha-7f3k9q'
        const nonceLineB = 'remember: nonce-bravo-2x8m4t'
        await submitLine(page, paneIdA, nonceLineA)
        await submitLine(page, paneIdB, nonceLineB)

        // Each leaf gains its OWN sessionRef {provider:'antigravity'} with
        // DISTINCT ids (the fake mints crypto.randomUUID() per first turn).
        const idA = await expect.poll(async () => {
          const leaf = await findLeafById(harness, tabId!, paneIdA)
          return leaf?.content?.sessionRef?.sessionId ?? null
        }, { timeout: 30_000 }).not.toBeNull().then(async () => {
          const leaf = await findLeafById(harness, tabId!, paneIdA)
          return leaf?.content?.sessionRef as { provider: string; sessionId: string }
        })
        expect(idA.provider).toBe('antigravity')
        expect(idA.sessionId).toMatch(UUID_RE)

        const idB = await expect.poll(async () => {
          const leaf = await findLeafById(harness, tabId!, paneIdB)
          return leaf?.content?.sessionRef?.sessionId ?? null
        }, { timeout: 30_000 }).not.toBeNull().then(async () => {
          const leaf = await findLeafById(harness, tabId!, paneIdB)
          return leaf?.content?.sessionRef as { provider: string; sessionId: string }
        })
        expect(idB.provider).toBe('antigravity')
        expect(idB.sessionId).toMatch(UUID_RE)
        expect(idB.sessionId, 'two same-cwd panes bind DISTINCT conversations').not.toBe(idA.sessionId)

        // The fake's store-write markers prove each CLI minted its own
        // conversation (the transcript + ownership record landed on disk).
        await expect.poll(async () => (await leafBufferUnwrapped(harness, terminalIdA)).includes(`agy: conversation ${idA.sessionId} started`), { timeout: 20_000 }).toBe(true)
        await expect.poll(async () => (await leafBufferUnwrapped(harness, terminalIdB)).includes(`agy: conversation ${idB.sessionId} started`), { timeout: 20_000 }).toBe(true)

        // The association frames the client received (the wire evidence the
        // leaf sessionRef folds from): one `terminal.session.associated` per
        // pane, each binding the antigravity provider and the pane's OWN id.
        await expect.poll(async () => {
          const received = (await harness.getReceivedWsMessages()) as any[]
          const hitA = received.some((m) => m?.type === 'terminal.session.associated'
            && m?.terminalId === terminalIdA
            && m?.sessionRef?.provider === 'antigravity'
            && m?.sessionRef?.sessionId === idA.sessionId)
          const hitB = received.some((m) => m?.type === 'terminal.session.associated'
            && m?.terminalId === terminalIdB
            && m?.sessionRef?.provider === 'antigravity'
            && m?.sessionRef?.sessionId === idB.sessionId)
          return hitA && hitB
        }, { timeout: 20_000 }).toBe(true)

        // ── Scenario 6 (this test's slice): --continue never appears ────
        await expect.poll(async () => (await readArgvLog(fixture.agyArgLog)).length, { timeout: 15_000 }).toBeGreaterThanOrEqual(2)
        expectNoContinueAnywhere(await readArgvLog(fixture.agyArgLog))

        // ── Scenario 2: the History read model lists BOTH ────────────────
        // Right cwd / first message / title for each conversation. The
        // directory reads the session INDEX (a cached snapshot the watcher
        // re-parses on file-change events): a row first appears when its
        // transcript materializes (the ownership record) and its message
        // fields populate on the follow-up re-parse — so the poll requires
        // the FULL expected shape, not just the ids. Generous budget: the
        // watcher coalesces file events and under cloud contention the
        // re-parse lands late (the observed cloud failure was a 45 s poll
        // missing the update by a hair; a poll settles the moment the data
        // arrives, so the budget is pure headroom, never a fixed wait).
        const items = await expect.poll(async () => {
          const rows = await fetchDirectory(info)
          const mine = rows.filter((row) => row.provider === 'antigravity')
          const rowA = mine.find((row) => row.sessionId === idA.sessionId)
          const rowB = mine.find((row) => row.sessionId === idB.sessionId)
          const shaped = rowA && rowB
            && rowA.firstUserMessage === nonceLineA
            && rowB.firstUserMessage === nonceLineB
          return shaped ? mine : null
        }, { timeout: 100_000 }).not.toBeNull().then(async () => {
          const rows = await fetchDirectory(info)
          return rows.filter((row) => row.provider === 'antigravity')
        })
        expect(items.length, 'exactly the two conversations — no ghost rows').toBe(2)
        const rowA = items.find((row) => row.sessionId === idA.sessionId)!
        const rowB = items.find((row) => row.sessionId === idB.sessionId)!
        expect(rowA.cwd).toBe(fixture.cwdDir)
        expect(rowB.cwd).toBe(fixture.cwdDir)
        expect(rowA.firstUserMessage).toBe(nonceLineA)
        expect(rowB.firstUserMessage).toBe(nonceLineB)
        expect(String(rowA.title)).toContain('nonce-alpha-7f3k9q')
        expect(String(rowB.title)).toContain('nonce-bravo-2x8m4t')

        // The sidebar rows show both sessions (the sidebar selector
        // surface; session-directory-matrix's row shape).
        await ensureSidebarVisible(page)
        const sidebarRowA = page.locator(`[data-context="sidebar-session"][data-provider="antigravity"][data-session-id="${idA.sessionId}"]`)
        const sidebarRowB = page.locator(`[data-context="sidebar-session"][data-provider="antigravity"][data-session-id="${idB.sessionId}"]`)
        await expect(sidebarRowA).toBeVisible({ timeout: 30_000 })
        await expect(sidebarRowB).toBeVisible({ timeout: 30_000 })

        // The History (Projects) rows show both sessions too.
        await page.getByTitle('Projects (Ctrl+B P)').click()
        const projectHeader = page.locator(`[data-context="history-project"][data-project-path="${fixture.cwdDir}"]`)
        await expect(projectHeader).toBeVisible({ timeout: 30_000 })
        await projectHeader.click()
        const historyRowA = page.locator(`[data-context="history-session"][data-provider="antigravity"][data-session-id="${idA.sessionId}"]`)
        const historyRowB = page.locator(`[data-context="history-session"][data-provider="antigravity"][data-session-id="${idB.sessionId}"]`)
        await expect(historyRowA).toBeVisible({ timeout: 30_000 })
        await expect(historyRowB).toBeVisible({ timeout: 30_000 })

        // ── Scenario 3: userMessages-tier search hits the NORMALIZED ─────
        // conversation, never a raw JSON grep. Driven through the sidebar's
        // own search box (the session-directory-matrix runSearch pattern:
        // fill the query, select the tier, await the exact route response).
        await ensureSidebarVisible(page)
        const search = page.getByPlaceholder('Search...', { exact: true })
        const searchTier = page.getByRole('combobox', { name: 'Search tier' })
        const runSearch = async (query: string, tier: string): Promise<DirectoryItem[]> => {
          const responsePromise = page.waitForResponse((response) => {
            const url = new URL(response.url())
            return url.pathname === '/api/session-directory'
              && url.searchParams.get('query') === query
              && url.searchParams.get('tier') === tier
              && response.request().method() === 'GET'
          }, { timeout: 15_000 })
          await search.fill(query)
          await expect(searchTier).toBeVisible()
          await searchTier.selectOption(tier)
          const response = await responsePromise
          expect(response.ok()).toBe(true)
          const payload = await response.json() as { items?: DirectoryItem[] }
          return payload?.items ?? []
        }

        // (a) the nonce row matches through the USER text (matchedIn
        // `userMessage` + a snippet of the normalized text) — and only the
        // RIGHT conversation.
        const hitAlpha = await runSearch('nonce-alpha-7f3k9q', 'userMessages')
        expect(hitAlpha.length).toBe(1)
        expect(hitAlpha[0]).toMatchObject({
          provider: 'antigravity',
          sessionId: idA.sessionId,
          matchedIn: 'userMessage',
        })
        expect(String(hitAlpha[0].snippet)).toContain('nonce-alpha-7f3k9q')

        // (b) an UPPERCASE query still matches: the tier searches the
        // parsed, case-normalized message text, not byte-exact file bytes.
        const hitBravo = await runSearch('NONCE-BRAVO-2X8M4T', 'userMessages')
        expect(hitBravo.length).toBe(1)
        expect(hitBravo[0]).toMatchObject({
          provider: 'antigravity',
          sessionId: idB.sessionId,
          matchedIn: 'userMessage',
        })

        // (c) NOT a raw JSON grep: the literal record-type string
        // `user_message` appears in EVERY raw transcript line
        // (`"type":"user_message"`) but in NO user-authored text — a raw
        // file grep would return both conversations; the normalized tier
        // returns NOTHING.
        const hitStructural = await runSearch('user_message', 'userMessages')
        expect(hitStructural).toEqual([])

        // (d) tier scoping: assistant-only text never matches the
        // userMessages tier (the fake's assistant replies are
        // `done; remembered: …`, never user-typed here).
        const hitAssistantOnly = await runSearch('done; remembered:', 'userMessages')
        expect(hitAssistantOnly).toEqual([])

        // Reset the search so the leaving state is the unfiltered list.
        await search.fill('')
      } finally {
        await server.stop().catch(() => {})
      }
    } finally {
      await fs.rm(fixture.sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })

  test('scenarios 4-7: a stopped pane keeps its identity; server.restart() restores it with the adjacent --conversation pair and remembered content; --continue never appears; a zero-turn pane restores fresh', async ({ page }) => {
    const fixture = await makeFixture('freshell-google-cli-resume-')
    try {
      const server = await startOwnedServer(fixture)
      const info = await server.start()
      try {
        const harness = await bootAndConnect(page, info)
        await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })
        const tabId = await harness.getActiveTabId()
        expect(tabId).toBeTruthy()

        // The bound pane: submits a nonce, so its conversation carries
        // recallable content for the post-restart second turn.
        const leafBound = await openAntigravityPaneAndGetLeaf(page, harness, tabId!, fixture.cwdDir)
        const paneIdBound: string = leafBound.id
        const terminalIdBound: string = leafBound.content.terminalId
        expect(terminalIdBound).toBeTruthy()
        await expect.poll(async () => (await leafBufferUnwrapped(harness, terminalIdBound)).includes('agy> '), { timeout: 20_000 }).toBe(true)

        const nonce = 'tango-nonce-5d8p2w'
        await submitLine(page, paneIdBound, `remember: ${nonce}`)

        const boundRef = await expect.poll(async () => {
          const leaf = await findLeafById(harness, tabId!, paneIdBound)
          return leaf?.content?.sessionRef?.sessionId ?? null
        }, { timeout: 30_000 }).not.toBeNull().then(async () => {
          const leaf = await findLeafById(harness, tabId!, paneIdBound)
          return leaf?.content?.sessionRef as { provider: string; sessionId: string }
        })
        expect(boundRef.provider).toBe('antigravity')
        const boundId = boundRef.sessionId
        expect(boundId).toMatch(UUID_RE)
        await expect.poll(async () => (await leafBufferUnwrapped(harness, terminalIdBound)).includes(`agy: conversation ${boundId} started`), { timeout: 20_000 }).toBe(true)

        // The zero-turn pane: created, NEVER submitted (scenario 7's
        // negative control — restores FRESH across the same restart).
        const leafZero = await openAntigravityPaneAndGetLeaf(page, harness, tabId!, fixture.cwdDir)
        const paneIdZero: string = leafZero.id
        const terminalIdZero: string = leafZero.content.terminalId
        expect(terminalIdZero).toBeTruthy()
        expect(paneIdZero).not.toBe(paneIdBound)
        await expect.poll(async () => (await leafBufferUnwrapped(harness, terminalIdZero)).includes('agy> '), { timeout: 20_000 }).toBe(true)
        const zeroLeafPre = await findLeafById(harness, tabId!, paneIdZero)
        expect(zeroLeafPre?.content?.sessionRef).toBeUndefined()

        // Persist the pane tree before the restart (the codex-restore
        // donor's pre-restart step).
        await page.evaluate(() => {
          (window as any).__FRESHELL_TEST_HARNESS__?.dispatch({ type: 'persist/flushNow' })
        })

        // ── Scenario 4: stop the OWNED fixture process ───────────────────
        // `terminal.kill` with `reason:'stuck-recovery'` is the PROCESS-ONLY
        // kill: it reaps exactly this per-test server's OWN PTY child (the
        // fake `agy`), keeps the pane, and leaves its durable session
        // resumable — no durable close, no identity retirement.
        let ws: WebSocket | null = null
        try {
          ws = await connectAndHello(info.wsUrl, info.token)
          const killRequestId = 'req-antigravity-history-kill'
          const killedPromise = nextMessage(ws, (m: any) => m?.type === 'terminal.killed' && m?.requestId === killRequestId, 15_000)
          ws.send(JSON.stringify({
            type: 'terminal.kill',
            terminalId: terminalIdBound,
            requestId: killRequestId,
            reason: 'stuck-recovery',
          }))
          const killed = await killedPromise
          expect(killed.success, `terminal.killed reply: ${JSON.stringify(killed)}`).toBe(true)
          // (No `terminal.exit` broadcast exists for a kill — verified by
          // the focused repro: the kill's process-death evidence on the
          // client side is the pane's `exited` fold below.)

          // The pane settles `exited` with its identity RETAINED.
          await expect.poll(async () => {
            const leaf = await findLeafById(harness, tabId!, paneIdBound)
            return leaf?.content?.status === 'exited' ? leaf.content.sessionRef?.sessionId : null
          }, { timeout: 20_000 }).toBe(boundId)
          const exitedLeaf = await findLeafById(harness, tabId!, paneIdBound)
          expect(exitedLeaf?.content?.sessionRef).toMatchObject({ provider: 'antigravity', sessionId: boundId })
        } finally {
          closeWs(ws)
        }

        // ── Scenario 5: server.restart() → exact resume ───────────────────
        // Same home/port/token; the reloaded client restores the persisted
        // panes — the bound pane's restore create carries its sessionRef, so
        // the respawned CLI must launch with the ADJACENT
        // `--conversation <bound id>` argv pair.
        if (!server.restart) {
          throw new Error('Owned Rust E2eServerHandle does not implement restart()')
        }
        await server.restart()

        await page.reload({ waitUntil: 'domcontentloaded' })
        await harness.waitForHarness()
        await harness.waitForConnection()
        await expect(async () => {
          const status = await page.evaluate(() => (window as any).__FRESHELL_TEST_HARNESS__?.getWsReadyState())
          expect(status).toBe('ready')
        }).toPass({ timeout: 30_000 })

        // The restored pane respawns and the fake RESUMES the exact
        // conversation (id-level marker in the pane's own buffer).
        await expect.poll(async () => {
          const leaf = await findLeafById(harness, tabId!, paneIdBound)
          const tid = leaf?.content?.terminalId
          return tid && leaf?.content?.status !== 'error' ? tid : null
        }, { timeout: 30_000 }).toBeTruthy()
        await pollLeafBuffer(harness, tabId!, paneIdBound, `agy: resumed conversation ${boundId}`, 30_000)

        // Identity persists across the restart (the create-time reseed from
        // the restore's sessionRef).
        const restoredLeaf = await findLeafById(harness, tabId!, paneIdBound)
        expect(restoredLeaf?.content?.sessionRef).toMatchObject({ provider: 'antigravity', sessionId: boundId })

        // CONTENT continuation, not just an id match: a second turn in the
        // restored pane echoes the nonce the FIRST turn registered — the
        // resumed CLI re-read it from the conversation transcript.
        await submitLine(page, paneIdBound, 'second turn after restart')
        await pollLeafBuffer(harness, tabId!, paneIdBound, `agy: remembered: ${nonce}`, 30_000)

        // ── Scenario 7: the zero-turn pane restores FRESH ─────────────────
        // No sessionRef, no resume argv — its restore create carries no
        // identity, so the CLI launches fresh (`agy> `) and NO conversation
        // was ever minted for it.
        await expect.poll(async () => {
          const leaf = await findLeafById(harness, tabId!, paneIdZero)
          const tid = leaf?.content?.terminalId
          return tid && leaf?.content?.status !== 'error' ? tid : null
        }, { timeout: 30_000 }).toBeTruthy()
        const zeroLeafPost = await findLeafById(harness, tabId!, paneIdZero)
        expect(zeroLeafPost?.content?.sessionRef).toBeUndefined()
        expect(zeroLeafPost?.content?.resumeSessionId).toBeUndefined()
        await pollLeafBuffer(harness, tabId!, paneIdZero, 'agy> ', 30_000)

        // The brain tree holds ONLY the bound pane's conversation — the
        // zero-turn pane minted nothing, before or after the restart.
        await expect.poll(async () => listBrainIds(info), { timeout: 15_000 }).toEqual([boundId])

        // ── Scenarios 5/6/7 argv invariants ───────────────────────────────
        // The spawn record so far: the two initial fresh launches, the
        // bound pane's `--conversation` restore, and the zero-turn pane's
        // fresh restore (>= 4 rows). Exact counts are deliberately NOT
        // pinned — the reload-path pane-reconcile flow may transiently
        // replace a pre-verdict create (the donor's WAVE-B note) — but the
        // INVARIANTS are absolute: every resume row names the exact bound
        // id (nothing else was ever resumable, and a substitution would
        // fail here), `--continue` never appears, and every spawn stays
        // interactive — BARE (the probed binaries v1.4.10+v1.4.12 start
        // interactive with no launch flag; `-i` takes a prompt VALUE and
        // a bare one exits 2), so no prompt-taking or headless spelling
        // ever appears.
        await expect.poll(async () => (await readArgvLog(fixture.agyArgLog)).length, { timeout: 20_000 }).toBeGreaterThanOrEqual(4)
        const rows = await readArgvLog(fixture.agyArgLog)
        expectNoContinueAnywhere(rows)
        const resumeRows = rows.filter((row) => row.argv.includes('--conversation'))
        expect(resumeRows.length, 'at least the bound pane\'s restore is a resume spawn').toBeGreaterThanOrEqual(1)
        for (const row of resumeRows) {
          const conversationIdx = row.argv.indexOf('--conversation')
          expect(row.argv[conversationIdx + 1], `the ADJACENT pair names the exact bound id: ${JSON.stringify(row.argv)}`).toBe(boundId)
        }
        for (const row of rows) {
          expect(row.argv, `fresh spawns stay interactive (bare): ${JSON.stringify(row.argv)}`).not.toContain('-i')
          expect(row.argv, `no prompt-taking interactive flag: ${JSON.stringify(row.argv)}`).not.toContain('--prompt-interactive')
          expect(row.argv, `no headless spelling: ${JSON.stringify(row.argv)}`).not.toContain('-p')
          expect(row.argv, `no headless spelling: ${JSON.stringify(row.argv)}`).not.toContain('--print')
          expect(row.argv, `no headless spelling: ${JSON.stringify(row.argv)}`).not.toContain('--prompt')
        }
      } finally {
        await server.stop().catch(() => {})
      }
    } finally {
      await fs.rm(fixture.sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })

  test('scenario 8: a deleted brain/<id> parks the pane in the distinct dead-session state; a direct resume attempt warns in-pane, stays alive, and rebinds to the CLI\'s fresh conversation — never a silent replacement', async ({ page }) => {
    const fixture = await makeFixture('freshell-google-cli-deleted-store-')
    try {
      const server = await startOwnedServer(fixture)
      const info = await server.start()
      try {
        const harness = await bootAndConnect(page, info)
        await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })
        const tabId = await harness.getActiveTabId()
        expect(tabId).toBeTruthy()

        // Bind a pane (its conversation lands in the isolated brain tree).
        const leaf = await openAntigravityPaneAndGetLeaf(page, harness, tabId!, fixture.cwdDir)
        const paneId: string = leaf.id
        const terminalId: string = leaf.content.terminalId
        expect(terminalId).toBeTruthy()
        await expect.poll(async () => (await leafBufferUnwrapped(harness, terminalId)).includes('agy> '), { timeout: 20_000 }).toBe(true)
        await submitLine(page, paneId, 'remember: hotel-nonce-9c2v7k')

        const boundRef = await expect.poll(async () => {
          const leafNow = await findLeafById(harness, tabId!, paneId)
          return leafNow?.content?.sessionRef?.sessionId ?? null
        }, { timeout: 30_000 }).not.toBeNull().then(async () => {
          const leafNow = await findLeafById(harness, tabId!, paneId)
          return leafNow?.content?.sessionRef as { provider: string; sessionId: string }
        })
        expect(boundRef.provider).toBe('antigravity')
        const boundId = boundRef.sessionId
        expect(boundId).toMatch(UUID_RE)

        // The conversation dir exists before the deletion (the precondition
        // the scenario deletes).
        const brainRoot = brainRootOf(info)
        const conversationDir = path.join(brainRoot, boundId)
        await expect.poll(async () => {
          try {
            await fs.access(conversationDir)
            return true
          } catch {
            return false
          }
        }, { timeout: 15_000 }).toBe(true)

        await page.evaluate(() => {
          (window as any).__FRESHELL_TEST_HARNESS__?.dispatch({ type: 'persist/flushNow' })
        })

        // Delete `brain/<id>/` under the isolated HOME — the store the
        // resume must read.
        await fs.rm(conversationDir, { recursive: true, force: true })

        if (!server.restart) {
          throw new Error('Owned Rust E2eServerHandle does not implement restart()')
        }
        await server.restart()

        await page.reload({ waitUntil: 'domcontentloaded' })
        await harness.waitForHarness()
        await harness.waitForConnection()
        await expect(async () => {
          const status = await page.evaluate(() => (window as any).__FRESHELL_TEST_HARNESS__?.getWsReadyState())
          expect(status).toBe('ready')
        }).toPass({ timeout: 30_000 })

        // ── Part A: the shipped browser-restart honest state ────────────
        // The pane-reconcile door consults the session-existence probe
        // BEFORE any restore spawn: a session that WAS on disk and is now
        // gone answers the typed `dead_session` verdict with reason
        // `session_not_on_disk` (reconcile.rs's §5.3 rows 4/4b gate). The
        // current no-modal contract parks the pane with the durable
        // `durable_artifact_missing` latch and writes the missing-session
        // notice into its terminal buffer. NO resume attempt, NO spawn, NO
        // replacement. (DEVIATION from the plan's
        // scenario-8 wording — recorded in the task report: the plan
        // assumed the restart restore would reach the CREATE door and the
        // CLI's own error would print in-pane; the shipped reconcile door
        // intercepts first. The create-door behavior the plan describes —
        // launch with
        // `--conversation <id>`, the CLI's own error surfaces, never a
        // replacement — is pinned by Part B below, end to end.)
        await expect.poll(async () => {
          const leafNow = await findLeafById(harness, tabId!, paneId)
          return leafNow?.content?.restoreError?.reason ?? null
        }, { timeout: 60_000 }).toBe('durable_artifact_missing')
        await expect(page.getByRole('dialog', { name: 'Dead sessions' })).toHaveCount(0)
        await expect.poll(async () => {
          const buffer = await harness.getTerminalBuffer(terminalId)
          return typeof buffer === 'string'
            ? buffer.split(DEAD_SESSION_BUFFER_NOTICE).length - 1
            : 0
        }, { timeout: 60_000 }).toBe(1)

        // The parked pane keeps its identity (never a substituted fresh id)
        // and carries the per-pane missing-store breadcrumb
        // (`durable_artifact_missing`).
        const parkedLeaf = await findLeafById(harness, tabId!, paneId)
        expect(parkedLeaf?.content?.sessionRef).toMatchObject({ provider: 'antigravity', sessionId: boundId })
        expect(parkedLeaf?.content?.restoreError).toMatchObject({ code: 'RESTORE_UNAVAILABLE', reason: 'durable_artifact_missing' })

        // NO spawn happened for the parked pane: the argv log still holds
        // EXACTLY the original fresh launch (row 0) — no resume attempt, no
        // fresh replacement, and `--continue` never appears (scenario 6).
        const partARows = await readArgvLog(fixture.agyArgLog)
        expect(partARows.length, 'the reconcile door never spawns for a dead session').toBe(1)
        expectNoContinueAnywhere(partARows)

        // ── Part B: the resume attempt itself (the create door the plan's
        // scenario describes) ────────────────────────────────────────────
          // A deliberate restore create carrying the deleted sessionRef goes
          // through the CREATE door, where the antigravity resume gate is
          // DEFERRED by design (Task 7: never a typed SESSION_MISSING
          // refusal, never a Freshell-side substituted id): the CLI
          // launches with the ADJACENT `--conversation <deleted id>` pair,
          // and the REAL CLI contract (probed v1.4.10 + v1.4.12, the
          // round-6 PTY receipts; the fake reproduces it byte-for-byte)
          // prints `warning: conversation "<id>" not found` and CONTINUES
          // INTO A FRESH INTERACTIVE SESSION — the pane STAYS ALIVE (no
          // exit, no auto-resume respawn cycle, exactly ONE spawn), the
          // warning surfaces in the pane's own output, and the pane's
          // identity still names the DEAD id. The next clean prompt mints
          // brain/<new-id>/ and the pane REBINDS dead→new through the
          // server's rebind machinery (the association frame names the
          // dead id as previousSessionId) — a stale resume never
          // dead-ends the pane and never silently substitutes: it warns
          // AND rebinds transparently. Driven through the spec-owned raw
          // WS client, attached to the spawned terminal so the output
          // bytes and the association frames are captured directly.
          let newId: string | null = null
          let ws: WebSocket | null = null
          try {
          ws = await connectAndHello(info.wsUrl, info.token)
          // A persistent frame collector: everything this connection
          // receives from here on (the created reply, the attach replay,
          // the fake's output stream, the rebind broadcast) lands in one
          // array the polls below scan — no listener-arithmetic races.
          const collected: any[] = []
          ws.on('message', (raw) => {
            try {
              collected.push(JSON.parse(String(raw)))
            } catch {
              // non-JSON control frame — ignore
            }
          })
          const createRequestId = 'req-agy-deleted-store-resume'
          ws.send(JSON.stringify({
            type: 'terminal.create',
            requestId: createRequestId,
            mode: 'antigravity',
            shell: 'system',
            cwd: fixture.cwdDir,
            restore: true,
            sessionRef: { provider: 'antigravity', sessionId: boundId },
          }))

          // The create is NEVER refused (the deferred gate) and the EXACT
          // deleted id passes through — never a substituted fresh id.
          const created = await new Promise<any>((resolve, reject) => {
            const deadline = setTimeout(() => reject(new Error('no terminal.created for the restore create')), 30_000)
            const timer = setInterval(() => {
              const hit = collected.find((m) => m?.type === 'terminal.created' && m?.requestId === createRequestId)
              if (hit) {
                clearTimeout(deadline)
                clearInterval(timer)
                resolve(hit)
              }
            }, 50)
          })
          expect(created.sessionRef).toMatchObject({ provider: 'antigravity', sessionId: boundId })
          const resumeTerminalId: string = created.terminalId
          expect(resumeTerminalId).toBeTruthy()

          // ATTACH. Under the probed contract the fake never dies, so a
          // plain attach streams the warning; the bounded retry below
          // merely tolerates a transient SESSION_RESERVED bounce (the
          // pre-round-7 spec followed auto-resume replacement chains
          // that only existed because the FAKE exited — cycles the real
          // CLI never produces).
          const attachDeadline = Date.now() + 30_000
          let currentTerminalId: string = resumeTerminalId
          let attached = false
          for (let attempt = 0; !attached && Date.now() < attachDeadline; attempt += 1) {
            const attachRequestId = `att-agy-deleted-store-${attempt}`
            ws.send(JSON.stringify({
              type: 'terminal.attach',
              terminalId: currentTerminalId,
              requestId: attachRequestId,
              intent: 'viewport_hydrate',
              cols: 120,
              rows: 30,
            }))
            const outcome = await new Promise<'output' | 'bounce' | 'timeout'>((resolve) => {
              const timer = setInterval(() => {
                const bounce = collected.find((m) => m?.type === 'error' && m?.requestId === attachRequestId && m?.code === 'SESSION_RESERVED')
                if (bounce) {
                  clearInterval(timer)
                  resolve('bounce')
                  return
                }
                const out = collected.find((m) => (m?.type === 'terminal.output' || m?.type === 'terminal.output.batch') && m?.terminalId === currentTerminalId)
                if (out) {
                  clearInterval(timer)
                  resolve('output')
                  return
                }
                if (Date.now() > attachDeadline) {
                  clearInterval(timer)
                  resolve('timeout')
                }
              }, 50)
            })
            if (outcome === 'output') {
              attached = true
            } else if (outcome === 'bounce') {
              // The server's bounce names a settle budget; poll well
              // inside it and retry (a poll, never a fixed wait).
              await new Promise((resolve) => setTimeout(resolve, 300))
            }
            // 'timeout' exits the loop and fails the assertion below.
          }
          expect(attached, 'the stale-resume terminal never streamed output to this client').toBe(true)

          // The CLI's OWN probed warning surfaces in the resumed
          // terminal's output stream — byte-faithful, quotes included.
          const warningNeedle = `warning: conversation "${boundId}" not found`
          // The poll's value on a miss is the collected-frame summary, so
          // a failure names exactly what this attached client saw.
          const summarizeCollected = () => collected.map((m) => {
            if (m?.type === 'terminal.output' || m?.type === 'terminal.output.batch') {
              return `${m.type}:${String(m?.data ?? '').slice(0, 200)}`
            }
            const detail = JSON.stringify({
              type: m?.type,
              code: m?.code,
              message: m?.message,
              status: m?.status,
              exitCode: m?.exitCode,
              terminalId: m?.terminalId,
            })
            return detail.slice(0, 400)
          }).join(' | ')
          await expect.poll(async () => {
            const joined = collected
              .filter((m) => m?.type === 'terminal.output' || m?.type === 'terminal.output.batch')
              .map((m) => String(m?.data ?? ''))
              .join('')
              .replace(/[\r\n]/g, '')
            return joined.includes(warningNeedle) ? true : summarizeCollected()
          }, { timeout: 45_000 }).toBe(true)

          // The pane STAYS ALIVE: no exit frame for the resumed terminal
          // ever arrives (a bounded absence window — the pre-round-7
          // fake exited 1 and drove a respawn cycle the real CLI never
          // produces), and the spawn stays exactly ONE (no respawn
          // row carrying the dead id).
          await new Promise((resolve) => setTimeout(resolve, 2_000))
          const exited = collected.find(
            (m) => m?.type === 'terminal.exit' && m?.terminalId === resumeTerminalId && typeof m?.exitCode === 'number',
          )
          expect(exited, 'the stale-resume pane never exits (the probed fresh session stays alive)').toBeUndefined()
          const resumeSpawnCount = (await readArgvLog(fixture.agyArgLog))
            .filter((row) => {
              const idx = row.argv.indexOf('--conversation')
              return idx !== -1 && row.argv[idx + 1] === boundId
            }).length
          expect(resumeSpawnCount, 'exactly ONE spawn carries the dead id (no respawn cycle, no replacement spawn)').toBe(1)

          // The pane's identity still names the DEAD id (the created
          // frame carried it verbatim — the rebind below names it as
          // previousSessionId, proving the identity held the dead id up
          // to the rebind). The next clean prompt mints the CLI's fresh
          // conversation and REBINDS the pane dead→new.
          ws.send(JSON.stringify({ type: 'terminal.input', terminalId: resumeTerminalId, data: 'stale-resume nonce 6y3n8p\r' }))

          // The fresh conversation is minted under a NEW id — the dead id
          // is never re-minted.
          await expect.poll(async () => {
            const ids = await listBrainIds(info)
            const fresh = ids.find((id) => id !== boundId)
            if (fresh) newId = fresh
            return newId
          }, { timeout: 30_000, message: 'the CLI\'s fresh session mints a NEW brain/<id>/ (the dead id is never re-minted)' }).not.toBeNull()
          expect(newId).not.toBe(boundId)
          expect(newId).toMatch(UUID_RE)

          // …and the pane REBINDS dead→new through the server's rebind
          // machinery: the association frame names the NEW conversation
          // with the DEAD id as previousSessionId (the loud supersede —
          // never a silent swap).
          await expect.poll(async () => {
            const hit = collected.find((m) => m?.type === 'terminal.session.associated'
              && m?.terminalId === resumeTerminalId
              && m?.sessionRef?.provider === 'antigravity'
              && m?.sessionRef?.sessionId === newId
              && m?.previousSessionId === boundId)
            return hit ? true : summarizeCollected()
          }, { timeout: 45_000, message: 'the stale-resume pane REBINDS dead→new (terminal.session.associated with previousSessionId = the dead id)' }).toBe(true)

          // Sidebar/history reflect the NEW conversation: the session
          // index picks the minted transcript up through the watcher and
          // the History read model lists it (generous budget — the
          // watcher coalesces events and the re-parse lands late under
          // cloud contention; the poll settles the moment the row
          // appears).
          await expect.poll(async () => {
            const rows = await fetchDirectory(info)
            return rows.some((row) => row.provider === 'antigravity' && row.sessionId === newId)
              ? true
              : `directory rows: ${rows.filter((row) => row.provider === 'antigravity').map((row) => row.sessionId).join(',')}`
          }, { timeout: 100_000, message: 'the History read model lists the rebound fresh conversation' }).toBe(true)
        } finally {
          closeWs(ws)
        }

        // ── The no-replacement invariants (both doors) ───────────────────
        // argv: row 0 is the pane's original fresh launch; row 1 is the
        // Part-B resume attempt carrying the ADJACENT `--conversation
        // <deleted id>` pair; NO further row EVER exists (no respawn
        // cycle, no replacement fresh spawn — the pane stayed alive), and
        // no row names any other id. `--continue` never appears.
        await expect.poll(async () => (await readArgvLog(fixture.agyArgLog)).length, { timeout: 30_000 }).toBe(2)
        const rows = await readArgvLog(fixture.agyArgLog)
        expectNoContinueAnywhere(rows)
        expect(rows[0].argv, 'row 0 is the original fresh launch').not.toContain('--conversation')
        expect(rows.length, 'exactly two spawns: the fresh launch + the ONE stale resume').toBe(2)
        const resumeIdx = rows[1].argv.indexOf('--conversation')
        expect(resumeIdx, 'the resume attempt carries the adjacent pair').not.toBe(-1)
        expect(rows[1].argv[resumeIdx + 1], 'the resume attempt names the deleted id').toBe(boundId)

        // The brain tree holds EXACTLY the fresh conversation: the
        // deleted conversation was never re-minted under its dead id —
        // the CLI's fresh session minted a NEW id and the pane is
        // rebound to it.
        expect(newId, 'the rebind landed before the tail invariants').not.toBeNull()
        await expect.poll(async () => listBrainIds(info), { timeout: 15_000 }).toEqual([newId])
      } finally {
        await server.stop().catch(() => {})
      }
    } finally {
      await fs.rm(fixture.sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })
})
