import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import { test, expect } from '../helpers/fixtures.js'
import { createE2eServerHandle } from '../helpers/external-target.js'
import { TestHarness } from '../helpers/test-harness.js'
import { openPanePicker } from '../helpers/pane-picker.js'
import { WsCapture } from '../helpers/ws-capture.js'
import {
  expectSharedName,
  renameThroughPaneHeader,
  startFakeGemini,
  FAKE_GEMINI_KEY,
  type UnifiedNamesServer,
} from '../helpers/unified-agent-names.js'
import { registerE2eMachine, installE2eMachineIdentity } from '../helpers/fixtures.js'
import { WS_PROTOCOL_VERSION } from '../../../shared/ws-protocol.js'
import { isUnifiedAgentMode, NamedProviderSchema } from '../../../shared/session-names.js'
import type { Page } from '@playwright/test'

/**
 * GOOGLE CLI IDENTITY + ACTIVITY + ATTENTION + NAMING (plan Task 13,
 * docs/plans/2026-10-29-google-cli-first-class-support.md) — the identity,
 * activity, attention, and naming-agreement acceptance for first-class
 * Antigravity CLI (`agy`, provider `antigravity`) terminal panes on the
 * Rust server. Everything runs against Task 10's deterministic
 * store-writing fake (`fake-agy-terminal.mjs` via `ANTIGRAVITY_CMD`), so
 * no real provider binary is ever invoked; the fake's antigravity home
 * resolves through the server's own seam (the PTY child inherits the
 * isolated HOME, so both read `<isolated HOME>/.gemini/antigravity-cli`).
 *
 * The ELEVEN binding scenarios, mapped onto seven per-test owned servers (the
 * google-cli-launch / google-cli-history per-test model — each test needs
 * its own env overrides, its own isolated HOME, and its own fixture
 * child):
 *
 * TEST 1 — identity + the activity lifecycle (scenarios 1-4):
 *   1. Association frame after the store write binds identity: the first
 *      submit's store write mints the conversation, and the
 *      `terminal.session.associated` broadcast binds the pane to THAT
 *      conversation (the leaf sessionRef agrees, the brain dir exists, the
 *      fake's own post-write marker is in the buffer).
 *   2. Busy while a turn runs: every flushed submit arms the
 *      `antigravity.activity.updated` busy upsert on the wire (the
 *      provisional-busy Enter capture), and the async window below holds
 *      the tab's blue chrome stably.
 *   3. The SUBMIT-ANCHORED attach baseline (whole-delta review round 2,
 *      Major 2): the bind turn's settle lands on disk during the
 *      locator's 2 s window — its `at` is AFTER the submit that armed
 *      the pane, so it is a LIVE turn end the user may not have
 *      witnessed and rings EXACTLY ONE `terminal.turn.complete` (seq 1)
 *      + ONE `terminal.idle{reason:'grace'}` (the round-1
 *      attach-instant baseline silenced a normal quick first turn; the
 *      round-2 review falsified that contract). Every later settled
 *      turn rings exactly one completion + one idle: turn 2 mints seq 2,
 *      the follow-up seq 3, one idle each, never a duplicate.
 *   4. `/async:` settles WITHOUT full idle: NO completion arrives, the
 *      busy light PERSISTS (the tab stays blue), and the follow-up settle
 *      completes exactly once.
 *
 * TEST 2 — the honest approval state + the duplicate-settle dedupe
 * (scenarios 5 + 7):
 *   5. A scripted approval prompt leaves the turn PENDING: the pane keeps
 *      the honest busy light (no completion, no terminal.idle, no
 *      attention mark) and NO waiting edge is ever emitted — the waiting
 *      edge (`freshAgent.turn.waiting`) is NOT implemented for terminal
 *      antigravity panes (the plan's honesty clause: this asserts the
 *      honest broader state; the deviation is recorded in the task
 *      report, not faked away). A later turn settles the pending one and
 *      completes once.
 *   7. The fake's `/dup:` verb replays a byte-faithful copy of the bind
 *      turn's ALREADY-RUNG settle (same `at` — at/below the ledger's
 *      recorded completion): no completion, no bell — the per-settle `at`
 *      dedupe extended through the baseline's live replay (whole-delta
 *      review round 2, Major 2).
 *
 * TEST 3 — crash parity (scenario 8): `/explode:` mid-turn crash → the
 *   unified attention edge rings ONCE (exactly one death `terminal.idle`,
 *   one bell-pipeline event, the full emerald attention marks on the
 *   backgrounded tab) AND the pane auto-respawns with the ADJACENT
 *   `--conversation <bound id>` argv (Task 6's crash parity — both halves
 *   asserted). The bind turn before the crash rings its own live
 *   completion (seq 1, its settle landed after the submit during the
 *   locator's window); the crash's death bell is the flow's SECOND
 *   attention edge, asserted as exactly one MORE on top of the baselines.
 *
 * TEST 4 — rebind (scenario 6): `/switch:` to a new conversation and
 *   `/resume:<id>` to an EXISTING one both rebind (sessionRef updates to
 *   the new id, the rebind association frame names the superseded
 *   identity), and a STALE old-launch write to the abandoned conversation
 *   is rejected: no second association for the old id, the pane never
 *   rebinds backwards.
 *
 * TEST 5 — naming agreement (scenario 9): after the auto-title generates
 *   the shared name, a manual Rename wins on EVERY surface — pane header,
 *   tab title, sidebar row, and history row agree (with the persisted
 *   record and the canonical cache), they STILL agree AFTER RELOAD, and a
 *   later turn's naming events never resurrect the generated name.
 *   Antigravity is pinned as a UNIFIED mode (the shared schema accepts
 *   it; gemini explicitly does NOT join — the legacy pin stays).
 *
 * TEST 6 — cross-device naming (scenario 10, folded in from the Task 9
 *   review): a raw second device pushes a tabs-registry record for a
 *   REMOTE antigravity tab whose pane payload carries the sessionRef; the
 *   record's `nameSource` routes the d0b7295c7 whitelist widening, and
 *   the Tabs view's remote card resolves the session's SAVED name on this
 *   device (the canonical-cache overlay), never the record's stale
 *   captured `tabName`.
 *
 * TEST 7 — multiline identity (scenario 11, whole-delta review round 3,
 *   Major 3): a pane types a two-line prompt via Ctrl+J (`line one`,
 *   Ctrl+J, `line two`, Enter). The capture joins the Ctrl+J as inline
 *   newline content and flushes ONE full multi-line submit at the Enter
 *   (round 1), the fake CLI submits ONE turn whose user record carries
 *   both lines (the round-3 fake fix — pre-fix the fake treated the LF as
 *   a submit delimiter and ran two turns against one captured submit, so
 *   nothing bound), and the scenario pins the bind + EXACT identity: one
 *   association frame, the leaf sessionRef, one completion + one idle for
 *   the one turn, and the history surface (the session-directory row)
 *   showing the multi-line prompt bound to the pane.
 *
 * Cloud legality: deterministic fakes, generous polls (5-45 s, 120 s for
 * the naming materialization tail), no wall-clock-sensitive waits (the
 * two fixed absence windows below are generous lower bounds on
 * event-driven settling, never timing gates), and every selector is
 * role/accessible-name based except the a11y-gate-exempt `.xterm` widget
 * root and value-carrying attribute selectors (the
 * session-directory-matrix convention).
 */

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Task 10's store-writing terminal fake (the ANTIGRAVITY_CMD surface).
const FAKE_AGY_TERMINAL_SOURCE = path.resolve(__dirname, '../fixtures/fake-agy-terminal.mjs')

/** The provider list this spec seeds: antigravity only (gemini preservation
 * is Task 11's scenario 6; no gemini pane is launched here). */
const SEEDED_PROVIDERS = ['antigravity']

/** The auto-title the fake Gemini answers with (scenario 9's generated
 * name — the name a manual Rename must beat). */
const GENERATED_NAME = 'Sardine factory fix'
const MANUAL_NAME = 'Rocket tea house'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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
 * its recursive watch at boot (the realistic existing-store case) — a
 * root ABSENT at boot is only picked up by the watcher's 60 s rearm tick,
 * which these scenarios do not need to wait on. The optional `ai` segment
 * arms the auto-title naming lane (scenario 9's generated name). */
function seedHome(
  enabledProviders: string[],
  ai?: { geminiApiKey: string },
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
        ...(ai ? { ai } : {}),
      },
    }, null, 2))
    const brainRoot = path.join(homeDir, '.gemini', 'antigravity-cli', 'brain')
    await fs.mkdir(brainRoot, { recursive: true })
  }
}

// Copied VERBATIM from google-cli-history-resume-rust.spec.ts:144-158.
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

// Copied VERBATIM from google-cli-history-resume-rust.spec.ts:160-172.
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
 * Copied from google-cli-history-resume-rust.spec.ts:175-179. */
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
 * openCodexPane model plus the directory-combobox `fill` step
 * (unified-agent-names.ts:738-751).
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
 * the NEWLY-added leaf — identified by diffing the leaf set before vs
 * after (the openModePaneAndGetLeaf model, google-cli-launch-rust.spec.ts).
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

/**
 * A NEW tab whose FIRST content is the antigravity agent — the
 * session-owned-tab journey (a picker-split into the boot shell would
 * make a mixed, legacy-named tab instead; unified-agent-names.ts's
 * createThroughUi model). Returns the new tab id and its single leaf.
 */
async function openAntigravitySessionTab(
  page: Page,
  harness: TestHarness,
  cwd: string,
): Promise<{ tabId: string; leaf: any }> {
  const before = await harness.getTabCount()
  const addButton = page.locator('[data-context="tab-add"]')
  await expect(addButton).toBeVisible({ timeout: 10_000 })
  await addButton.click()
  await harness.waitForTabCount(before + 1)
  const tabId = await harness.getActiveTabId()
  expect(tabId).toBeTruthy()
  const leaf = await openAntigravityPaneAndGetLeaf(page, harness, tabId!, cwd)
  expect(collectLeaves(await harness.getPaneLayout(tabId!)).length, 'the session tab holds exactly the one agent pane').toBe(1)
  return { tabId: tabId!, leaf }
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
 * each iteration so a terminalId that changes once more (a respawn fold) is
 * always the CONVERGED state's buffer, never a stale sample.
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

/**
 * The blue pane icons inside a tab strip item (terminal-activity-rust's
 * tabBlueIcons): with `iconsOnTabs` a tab renders ONE icon PER pane, so
 * "the tab shows blue" means at least one pane icon carries text-blue-500.
 */
function tabBlueIcons(page: Page, tabId: string) {
  return page.locator(`[data-context="tab"][data-tab-id="${tabId}"] svg.text-blue-500`)
}

// ── the spec-owned raw WS client (the ws-ping-pong-matrix pattern) ──────────

/**
 * Open a raw WS connection and complete the harness-token hello handshake
 * (copied from google-cli-history-resume-rust.spec.ts:304-331) — the
 * input-driving lane for turns that must run while the pane's tab is
 * BACKGROUNDed (no focus races).
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

/** Close a raw WS client, tolerating an already-closed socket. */
function closeWs(ws: WebSocket | null): void {
  try {
    ws?.close()
  } catch {
    // already closed
  }
}

// ── session-directory + brain-tree helpers ─────────────────────────────────

/** The isolated antigravity brain tree — the production default resolution
 * (`<isolated HOME>/.gemini/antigravity-cli/brain`), the same seam the fake
 * resolves through the PTY child's inherited env. */
function brainRootOf(info: { homeDir: string }): string {
  return path.join(info.homeDir, '.gemini', 'antigravity-cli', 'brain')
}

/** One `DirItem` row of the History read model (the serialized
 * `SessionDirectoryItem` shape, session_directory.rs `DirItem::to_value` —
 * the google-cli-history spec's copy). */
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

/** `GET /api/session-directory?priority=visible&limit=50` — the History
 * read model (the google-cli-history spec's fetch shape). */
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
  ai?: { geminiApiKey: string },
  envExtra?: Record<string, string>,
) {
  const server = await createE2eServerHandle(process.env, {
    construct: {
      env: {
        ANTIGRAVITY_CMD: fixture.fakeAgyPath,
        FAKE_AGY_TERMINAL_ARGV_LOG: fixture.agyArgLog,
        ...(envExtra ?? {}),
      },
      setupHome: seedHome(SEEDED_PROVIDERS, ai),
    },
  })
  return server
}

/** The latest `terminal.idle` wall-clock `at` the capture has seen for a
 * terminal (0 when none) — the clock-independent "newer than" baseline for
 * waiting on the NEXT idle without matching an already-seen frame. */
function lastIdleAtFor(capture: WsCapture, terminalId: string): number {
  let latest = 0
  for (const f of capture.all) {
    if (f.type === 'terminal.idle' && f.terminalId === terminalId && typeof f.at === 'number') {
      latest = Math.max(latest, f.at)
    }
  }
  return latest
}

/** `await` one bounded settling window (an ABSENCE lower bound — the
 * event-driven lanes settle in well under this; the assertions after it
 * are state reads, never timing gates). */
async function settleWindow(page: Page, ms: number): Promise<void> {
  await page.waitForTimeout(ms)
}

test.describe('Google CLI identity + activity + attention + naming (Rust)', () => {
  test.setTimeout(360_000)

  test('scenarios 1-4: the store write binds identity; busy while a turn runs; exactly one completion + one idle per settled turn; an /async: settle never completes and busy persists', async ({ page }) => {
    const fixture = await makeFixture('freshell-google-cli-lifecycle-')
    try {
      const server = await startOwnedServer(fixture)
      const info = await server.start()
      const capture = new WsCapture(info.wsUrl, info.token)
      try {
        await capture.ready()
        const harness = await bootAndConnect(page, info)
        await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })
        const tabId = await harness.getActiveTabId()
        expect(tabId).toBeTruthy()

        // ── Scenario 1: the store write binds identity ──────────────────
        // The fake mints the conversation AT the first prompt's store write;
        // the association broadcast binds the pane to THAT conversation.
        const leaf = await openAntigravityPaneAndGetLeaf(page, harness, tabId!, fixture.cwdDir)
        const paneId: string = leaf.id
        const terminalId: string = leaf.content.terminalId
        expect(terminalId).toBeTruthy()
        await expect.poll(async () => (await leafBufferUnwrapped(harness, terminalId)).includes('agy> '), { timeout: 20_000 }).toBe(true)

        const nonce = 'lifecycle-nonce-31d7'
        await submitLine(page, paneId, `remember: ${nonce}`)

        // The associated frame on the WIRE binds the pane to a conversation
        // whose transcript EXISTS on disk (the store write preceded).
        const associated = await capture.waitFor(
          (f) => f.type === 'terminal.session.associated'
            && f.terminalId === terminalId
            && f.sessionRef?.provider === 'antigravity',
          30_000,
          'terminal.session.associated (antigravity bind)',
        )
        const boundId: string = associated.sessionRef.sessionId
        expect(boundId).toMatch(UUID_RE)
        // The store write the association consumed: the brain dir + the
        // fake's own post-write marker.
        await expect.poll(async () => {
          try {
            await fs.access(path.join(brainRootOf(info), boundId))
            return true
          } catch {
            return false
          }
        }, { timeout: 15_000 }).toBe(true)
        await expect.poll(async () => (await leafBufferUnwrapped(harness, terminalId)).includes(`agy: conversation ${boundId} started`), { timeout: 20_000 }).toBe(true)
        // The pane's leaf sessionRef IS the frame's binding.
        await expect.poll(async () => {
          const leafNow = await findLeafById(harness, tabId!, paneId)
          return leafNow?.content?.sessionRef ?? null
        }, { timeout: 20_000 }).toMatchObject({ provider: 'antigravity', sessionId: boundId })

        // ── Scenario 2: busy while a turn runs ───────────────────────────
        // Every flushed submit arms the busy upsert on the wire (the
        // Enter capture). Turn 1 (the nonce turn above) already produced
        // one; this turn produces its own.
        await capture.waitFor(
          (f) => f.type === 'antigravity.activity.updated'
            && f.upsert?.some((r: any) => r.terminalId === terminalId && r.phase === 'busy'),
          15_000,
          'antigravity busy upsert',
        )

        // ── Scenario 3: the submit-anchored baseline + one completion
        // per settled turn. Turn 1 (the bind turn) settled while the
        // locator's 2 s window was still open — its settle was ON DISK
        // when the sweep attached the lane, but its `at` is AFTER the
        // submit that armed the pane (whole-delta review round 2,
        // Major 2), so it is a LIVE turn end: it must ring EXACTLY ONE
        // completion (seq 1 — the pane's first) + ONE terminal.idle.
        const complete1 = await capture.waitFor(
          (f) => f.type === 'terminal.turn.complete' && f.terminalId === terminalId && f.completionSeq === 1,
          20_000,
          'terminal.turn.complete #1 (the bind turn settled after the submit)',
        )
        expect(complete1.provider).toBe('antigravity')
        expect(complete1.sessionId).toBe(boundId)
        // The bind turn's idle is the pane's FIRST idle (the ring lands at
        // attach time — possibly well before this wait runs — so the
        // newer-than-baseline pattern must NOT gate it).
        await capture.waitFor(
          (f) => f.type === 'terminal.idle' && f.terminalId === terminalId,
          15_000,
          'terminal.idle #1 (the bind turn)',
        )
        await settleWindow(page, 2_000)
        expect(capture.count((f) => f.type === 'terminal.turn.complete' && f.terminalId === terminalId),
          'the bind turn rings exactly one completion').toBe(1)
        expect(capture.count((f) => f.type === 'terminal.idle' && f.terminalId === terminalId),
          'the bind turn rings exactly one idle').toBe(1)

        // Turn 2 (the lane is attached — its records stream LIVE): ONE
        // completion (provider antigravity, the bound conversation,
        // seq 2) + ONE terminal.idle{reason:'grace'}.
        await submitLine(page, paneId, 'a second settled turn')
        const complete2 = await capture.waitFor(
          (f) => f.type === 'terminal.turn.complete' && f.terminalId === terminalId && f.completionSeq === 2,
          20_000,
          'terminal.turn.complete #2 (the first LIVE-streamed settled turn)',
        )
        expect(complete2.provider).toBe('antigravity')
        expect(complete2.completionSeq).toBe(2)
        expect(complete2.sessionId).toBe(boundId)
        const idleBaselineAfterTurn2 = lastIdleAtFor(capture, terminalId)
        await capture.waitFor(
          (f) => f.type === 'terminal.idle' && f.terminalId === terminalId && f.at > idleBaselineAfterTurn2,
          15_000,
          'terminal.idle #2',
        )

        // Exactly TWO of each so far — never a duplicate.
        await settleWindow(page, 2_000)
        expect(capture.count((f) => f.type === 'terminal.turn.complete' && f.terminalId === terminalId)).toBe(2)
        expect(capture.count((f) => f.type === 'terminal.idle' && f.terminalId === terminalId)).toBe(2)

        // ── Scenario 4: /async: settles WITHOUT full idle ────────────────
        // No completion for the async turn, busy PERSISTS (the blue chrome
        // holds — the stable busy window scenario 2's DOM side rides), and
        // the follow-up settle completes exactly ONCE (seq 2).
        await submitLine(page, paneId, 'async: outstanding work remains')
        await capture.waitFor(
          (f) => f.type === 'antigravity.activity.updated'
            && f.upsert?.some((r: any) => r.terminalId === terminalId && r.phase === 'busy' && r.sessionId === boundId),
          15_000,
          'async turn busy upsert',
        )
        // The busy window is stable: the tab's blue chrome holds for as
        // long as the async work is outstanding (the 2 s idle grace lapses
        // with no settle — blue must NOT clear).
        await expect(tabBlueIcons(page, tabId!)).not.toHaveCount(0, { timeout: 10_000 })
        await settleWindow(page, 4_000)
        expect(capture.count((f) => f.type === 'terminal.turn.complete' && f.terminalId === terminalId),
          'the async settle (fullyIdle:false) never completes').toBe(2)
        expect(capture.count((f) => f.type === 'terminal.idle' && f.terminalId === terminalId),
          'no terminal.idle while async work is outstanding').toBe(2)
        await expect(tabBlueIcons(page, tabId!), 'busy persists while the async work is outstanding').not.toHaveCount(0)

        // The follow-up settle completes once and clears the blue.
        await submitLine(page, paneId, 'the follow-up that settles')
        await capture.waitFor(
          (f) => f.type === 'terminal.turn.complete' && f.terminalId === terminalId && f.completionSeq === 3,
          20_000,
          'terminal.turn.complete #3 (the follow-up settles)',
        )
        const idleBaselineAfterAsync = lastIdleAtFor(capture, terminalId)
        await capture.waitFor(
          (f) => f.type === 'terminal.idle' && f.terminalId === terminalId && f.at > idleBaselineAfterAsync,
          15_000,
          'terminal.idle #3',
        )
        await expect(tabBlueIcons(page, tabId!)).toHaveCount(0, { timeout: 10_000 })
        await settleWindow(page, 1_000)
        expect(capture.count((f) => f.type === 'terminal.turn.complete' && f.terminalId === terminalId)).toBe(3)
        expect(capture.count((f) => f.type === 'terminal.idle' && f.terminalId === terminalId)).toBe(3)
      } finally {
        capture.close()
        await server.stop().catch(() => {})
      }
    } finally {
      await fs.rm(fixture.sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })

  test('scenarios 5 + 7: a pending approval keeps the honest busy light with NO waiting edge; a /dup: settle replay never double-completes and rings one bell', async ({ page }) => {
    const fixture = await makeFixture('freshell-google-cli-approval-dup-')
    try {
      const server = await startOwnedServer(fixture)
      const info = await server.start()
      const capture = new WsCapture(info.wsUrl, info.token)
      try {
        await capture.ready()
        const harness = await bootAndConnect(page, info)
        await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })
        const tabId = await harness.getActiveTabId()
        expect(tabId).toBeTruthy()

        const leaf = await openAntigravityPaneAndGetLeaf(page, harness, tabId!, fixture.cwdDir)
        const paneId: string = leaf.id
        const terminalId: string = leaf.content.terminalId
        await expect.poll(async () => (await leafBufferUnwrapped(harness, terminalId)).includes('agy> '), { timeout: 20_000 }).toBe(true)

        // The bind turn's settle lands on disk during the locator's 2 s
        // window — its `at` is AFTER the submit, so it is a LIVE turn end
        // (whole-delta review round 2, Major 2) and rings EXACTLY ONCE:
        // completion seq 1 + terminal.idle #1. The associated frame proves
        // the sweep matched and attached the lane, so the absence windows
        // below are not vacuous — and the rung settle record is exactly
        // what the /dup: verb will replay byte-faithfully below (the
        // LEDGER's recorded completion must swallow that replay).
        await submitLine(page, paneId, 'remember: approval-dup-nonce')
        const associated = await capture.waitFor(
          (f) => f.type === 'terminal.session.associated'
            && f.terminalId === terminalId
            && f.sessionRef?.provider === 'antigravity',
          30_000,
          'terminal.session.associated (the bind turn attaches the lane)',
        )
        const boundId: string = associated.sessionRef.sessionId
        const bindComplete = await capture.waitFor(
          (f) => f.type === 'terminal.turn.complete' && f.terminalId === terminalId && f.completionSeq === 1,
          20_000,
          'terminal.turn.complete #1 (the bind turn settled after the submit)',
        )
        expect(bindComplete.provider).toBe('antigravity')
        expect(bindComplete.sessionId).toBe(boundId)
        // The bind turn's idle is the pane's FIRST idle (the ring lands at
        // attach time — possibly well before this wait runs).
        await capture.waitFor(
          (f) => f.type === 'terminal.idle' && f.terminalId === terminalId,
          15_000,
          'terminal.idle #1 (the bind turn)',
        )
        await settleWindow(page, 1_500)
        expect(capture.count((f) => f.type === 'terminal.turn.complete' && f.terminalId === terminalId),
          'the bind turn rings exactly one completion').toBe(1)
        expect(capture.count((f) => f.type === 'terminal.idle' && f.terminalId === terminalId),
          'the bind turn rings exactly one idle').toBe(1)
        const seqAfterBind = (await harness.getState()).turnCompletion?.seq ?? 0
        const completionsAfterBind = capture.count((f) => f.type === 'terminal.turn.complete' && f.terminalId === terminalId)
        const idlesAfterBind = capture.count((f) => f.type === 'terminal.idle' && f.terminalId === terminalId)

        // The bind turn's idle marked the tab (terminal idles always mark;
        // the sound was suppressed as watched — the user typed into the
        // pane). Dismiss the mark the way a user does — switch away and
        // back (click mode; a throwaway second tab gives the away leg) —
        // so the approval block below asserts the PENDING turn adds NO
        // new attention, not the bind turn's dismissed leftover.
        await page.locator('[data-context="tab-add"]').click()
        await harness.waitForTabCount(2)
        await page.locator(`[data-context="tab"][data-tab-id="${tabId}"]`).click()
        await expect.poll(async () => harness.getActiveTabId(), { timeout: 15_000 }).toBe(tabId)
        await expect.poll(async () => (await harness.getState()).turnCompletion?.attentionByTab?.[tabId!] ?? null,
          { timeout: 15_000, message: 'the visit dismisses the bind turn\'s mark' }).toBeNull()

        // ── Scenario 5: a scripted approval prompt leaves the turn PENDING.
        // The pane keeps the honest busy light: no completion, no
        // terminal.idle, no attention mark, and NO waiting edge is ever
        // emitted (the `freshAgent.turn.waiting` edge is not implemented
        // for terminal antigravity panes — the plan's honesty clause; the
        // broader busy state asserted here is the honest shipped behavior,
        // recorded in the task report).
        await submitLine(page, paneId, 'approval: deploy the rocket')
        await capture.waitFor(
          (f) => f.type === 'antigravity.activity.updated'
            && f.upsert?.some((r: any) => r.terminalId === terminalId && r.phase === 'busy'),
          15_000,
          'approval turn busy upsert',
        )
        await expect.poll(async () => (await leafBufferUnwrapped(harness, terminalId)).includes('approval requested: deploy the rocket (y/n)'), { timeout: 15_000 }).toBe(true)
        await expect(tabBlueIcons(page, tabId!), 'the pending approval keeps the busy light on').not.toHaveCount(0, { timeout: 10_000 })
        await settleWindow(page, 5_000)
        expect(capture.count((f) => f.type === 'terminal.turn.complete' && f.terminalId === terminalId),
          'a pending approval never completes').toBe(completionsAfterBind)
        expect(capture.count((f) => f.type === 'terminal.idle' && f.terminalId === terminalId),
          'a pending approval never rings the idle bell').toBe(idlesAfterBind)
        expect(capture.count((f) => f.type === 'freshAgent.turn.waiting'),
          'the waiting edge is NOT implemented for terminal antigravity panes — none is emitted').toBe(0)
        await expect.poll(async () => (await harness.getState()).turnCompletion?.attentionByTab?.[tabId!] ?? null,
          { timeout: 5_000, message: 'no attention mark while the approval is pending' }).toBeNull()

        // ── Scenario 7: the /dup: duplicate-settle replay ────────────────
        // The dup Enter is mid-turn typing against the CONFIRMED approval
        // busy (it re-arms nothing), and the byte-faithful copy of the
        // bind turn's ALREADY-RUNG settle (same `at` — at/below the
        // ledger's recorded completion, whole-delta review round 2) is a
        // replay: inert — no completion, no idle, no bell.
        await submitLine(page, paneId, 'dup:')
        await expect.poll(async () => (await leafBufferUnwrapped(harness, terminalId)).includes('agy: duplicated settle'), { timeout: 15_000 }).toBe(true)
        await settleWindow(page, 5_000)
        expect(capture.count((f) => f.type === 'terminal.turn.complete' && f.terminalId === terminalId),
          'the replayed settle never double-completes').toBe(completionsAfterBind)
        expect(capture.count((f) => f.type === 'terminal.idle' && f.terminalId === terminalId),
          'the replayed settle never rings a bell').toBe(idlesAfterBind)
        expect((await harness.getState()).turnCompletion?.seq ?? 0,
          'the dup minted no bell-pipeline event').toBe(seqAfterBind)
        await expect(tabBlueIcons(page, tabId!), 'the running turn keeps the busy light through the replay').not.toHaveCount(0)

        // A later turn settles the pending one (the lane is attached — the
        // records stream LIVE): completes ONCE (seq 2 — the bind turn
        // consumed seq 1), rings the SECOND bell of the flow, and clears
        // the blue.
        await submitLine(page, paneId, 'answer the approval and finish')
        await capture.waitFor(
          (f) => f.type === 'terminal.turn.complete' && f.terminalId === terminalId && f.completionSeq === 2,
          20_000,
          'terminal.turn.complete #2 (the pending turn settles)',
        )
        const idleBaselineAfterDup = lastIdleAtFor(capture, terminalId)
        await capture.waitFor(
          (f) => f.type === 'terminal.idle' && f.terminalId === terminalId && f.at > idleBaselineAfterDup,
          15_000,
          'terminal.idle #2',
        )
        await expect(tabBlueIcons(page, tabId!)).toHaveCount(0, { timeout: 10_000 })
        await settleWindow(page, 1_000)
        expect(capture.count((f) => f.type === 'terminal.turn.complete' && f.terminalId === terminalId)).toBe(completionsAfterBind + 1)
        expect(capture.count((f) => f.type === 'terminal.idle' && f.terminalId === terminalId)).toBe(idlesAfterBind + 1)
        // Exactly ONE MORE bell-pipeline event across the rest of the flow
        // (the settled approval turn — the dup replay rang none; the bind
        // turn's bell is already inside seqAfterBind).
        expect((await harness.getState()).turnCompletion?.seq ?? 0).toBe(seqAfterBind + 1)
      } finally {
        capture.close()
        await server.stop().catch(() => {})
      }
    } finally {
      await fs.rm(fixture.sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })

  test('scenario 8: an /explode: mid-turn crash rings the unified attention edge exactly once AND auto-respawns with the adjacent --conversation pair', async ({ page }) => {
    test.setTimeout(300_000)
    const fixture = await makeFixture('freshell-google-cli-crash-')
    try {
      const server = await startOwnedServer(fixture)
      const info = await server.start()
      const capture = new WsCapture(info.wsUrl, info.token)
      let inputWs: WebSocket | null = null
      try {
        await capture.ready()
        const harness = await bootAndConnect(page, info)
        await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })
        const bootTabId = await harness.getActiveTabId()
        expect(bootTabId).toBeTruthy()

        // A session-owned agent tab (the crash lands in a BACKGROUND tab so
        // the attention marks are the full unwitnessed treatment).
        const { tabId, leaf } = await openAntigravitySessionTab(page, harness, fixture.cwdDir)
        const paneId: string = leaf.id
        const terminalId: string = leaf.content.terminalId
        await expect.poll(async () => (await leafBufferUnwrapped(harness, terminalId)).includes('agy> '), { timeout: 20_000 }).toBe(true)

        // Bind the pane (its identity is what the crash respawn must
        // carry). The bind turn's settle lands on disk during the
        // locator's 2 s window — its `at` is AFTER the submit (round 2,
        // Major 2), so it RINGS (seq 1 + one idle); the crash's
        // exactly-one edge below is asserted as ONE MORE on top of it,
        // with the bind mark dismissed first so the crash's marks are
        // observable fresh.
        await submitLine(page, paneId, 'remember: crash-parity-nonce')
        const associated = await capture.waitFor(
          (f) => f.type === 'terminal.session.associated'
            && f.terminalId === terminalId
            && f.sessionRef?.provider === 'antigravity',
          30_000,
          'terminal.session.associated (bind before the crash)',
        )
        const boundId: string = associated.sessionRef.sessionId
        expect(boundId).toMatch(UUID_RE)
        // The bind turn settled during the locator's window — its `at` is
        // AFTER the submit (whole-delta review round 2, Major 2), so it
        // RINGS: exactly one completion (seq 1) + one terminal.idle. The
        // ring was WATCHED (typed into the foregrounded tab): the mark
        // lands and the sound is suppressed.
        const bindComplete = await capture.waitFor(
          (f) => f.type === 'terminal.turn.complete' && f.terminalId === terminalId && f.completionSeq === 1,
          20_000,
          'terminal.turn.complete #1 (the bind turn settled after the submit)',
        )
        expect(bindComplete.sessionId).toBe(boundId)
        // The bind turn's idle is the pane's FIRST idle (the ring lands at
        // attach time — possibly well before this wait runs).
        await capture.waitFor(
          (f) => f.type === 'terminal.idle' && f.terminalId === terminalId,
          15_000,
          'terminal.idle #1 (the bind turn)',
        )
        await expect.poll(async () => (await harness.getState()).turnCompletion?.attentionByTab?.[tabId] ?? null,
          { timeout: 15_000, message: 'the bind turn marks the tab (watched: mark only, sound suppressed)' }).toBe(true)

        // Dismiss the bind turn's mark the way a user does — switch away
        // and back (click mode) — so the crash's own marks below are
        // observable as FRESH marks, not the bind turn's leftovers.
        await page.locator(`[data-context="tab"][data-tab-id="${bootTabId}"]`).click()
        await expect.poll(async () => harness.getActiveTabId(), { timeout: 15_000 }).toBe(bootTabId)
        await page.locator(`[data-context="tab"][data-tab-id="${tabId}"]`).click()
        await expect.poll(async () => harness.getActiveTabId(), { timeout: 15_000 }).toBe(tabId)
        await expect.poll(async () => (await harness.getState()).turnCompletion?.attentionByTab?.[tabId] ?? null,
          { timeout: 15_000, message: 'the visit dismisses the bind turn\'s mark' }).toBeNull()

        // Baselines: the bind turn rang (seq 1 + idle #1); those are
        // captured here. The crash must add EXACTLY one more idle + one
        // more bell and NO completion.
        const completionsBefore = capture.count((f) => f.type === 'terminal.turn.complete' && f.terminalId === terminalId)
        const idlesBefore = capture.count((f) => f.type === 'terminal.idle' && f.terminalId === terminalId)
        const seqBefore = (await harness.getState()).turnCompletion?.seq ?? 0
        const crashWallClock = Date.now()

        // Background the agent tab (the user is looking at the boot tab
        // when the crash lands — the unwitnessed treatment), then drive
        // the mid-turn crash through the raw input lane (no focus races).
        await page.locator(`[data-context="tab"][data-tab-id="${bootTabId}"]`).click()
        await expect.poll(async () => harness.getActiveTabId(), { timeout: 15_000 }).toBe(bootTabId)
        inputWs = await connectAndHello(info.wsUrl, info.token)
        inputWs.send(JSON.stringify({ type: 'terminal.input', terminalId, data: 'explode: mid-turn crash\r' }))

        // ── Half 1: the unified attention edge rings ONCE ─────────────────
        // The process dies mid-turn (exit 3) while the tracker holds the
        // busy engagement: exactly ONE death terminal.idle, ONE
        // bell-pipeline event, and the full emerald attention marks on the
        // backgrounded tab (the pane-header mark + the tab highlight).
        await capture.waitFor(
          (f) => f.type === 'terminal.idle' && f.terminalId === terminalId && f.at >= crashWallClock,
          15_000,
          'the death terminal.idle (the unified attention edge)',
        )
        await settleWindow(page, 2_000)
        expect(capture.count((f) => f.type === 'terminal.idle' && f.terminalId === terminalId),
          'exactly ONE death bell for the crash').toBe(idlesBefore + 1)
        expect(capture.count((f) => f.type === 'terminal.turn.complete' && f.terminalId === terminalId),
          'the crash itself mints NO turn.complete (the death bell is the edge)').toBe(completionsBefore)
        await expect.poll(async () => (await harness.getState()).turnCompletion?.seq ?? 0,
          { timeout: 15_000, message: 'exactly one bell-pipeline event for the crash' }).toBe(seqBefore + 1)
        await expect.poll(async () => (await harness.getState()).turnCompletion?.attentionByTab?.[tabId] ?? null,
          { timeout: 15_000, message: 'the backgrounded tab takes the attention mark' }).toBe(true)
        await expect.poll(async () => (await harness.getState()).turnCompletion?.attentionByPane?.[paneId] ?? null,
          { timeout: 15_000, message: 'the pane header takes the attention mark' }).toBe(true)
        await expect(page.locator(`[data-context="tab"][data-tab-id="${tabId}"]`), 'the backgrounded tab carries the emerald attention class').toHaveClass(/bg-emerald-100/)

        // ── Half 2: crash parity — the auto-respawn carries the identity.
        // The recovering/replaced lifecycle, a NEW terminal bound to the
        // SAME conversation, the ADJACENT `--conversation <bound id>` argv
        // pair, and the fake's resumed marker in the respawned pane.
        await capture.waitFor(
          (f) => f.type === 'terminal.status' && f.terminalId === terminalId && f.status === 'recovering',
          15_000,
          'terminal.status recovering',
        )
        const replaced = await capture.waitFor(
          (f) => f.type === 'terminal.replaced' && f.oldTerminalId === terminalId,
          30_000,
          'terminal.replaced (the auto-respawn)',
        )
        const newTerminalId: string = replaced.newTerminalId
        expect(newTerminalId).toBeTruthy()
        expect(newTerminalId).not.toBe(terminalId)

        // The pane's leaf now owns the NEW terminal, still bound to the
        // SAME conversation (identity survives the crash).
        await expect.poll(async () => {
          const leafNow = await findLeafById(harness, tabId, paneId)
          return leafNow?.content?.terminalId ?? null
        }, { timeout: 20_000 }).toBe(newTerminalId)
        await expect.poll(async () => {
          const leafNow = await findLeafById(harness, tabId, paneId)
          return leafNow?.content?.sessionRef ?? null
        }, { timeout: 20_000 }).toMatchObject({ provider: 'antigravity', sessionId: boundId })

        // The argv log: the respawn carries the ADJACENT pair.
        await expect.poll(async () => (await readArgvLog(fixture.agyArgLog)).length, { timeout: 20_000 }).toBeGreaterThanOrEqual(2)
        const rows = await readArgvLog(fixture.agyArgLog)
        expect(rows[0].argv, 'row 0 is the original fresh launch').not.toContain('--conversation')
        const resumeRows = rows.filter((row) => row.argv.includes('--conversation'))
        expect(resumeRows.length, 'the crash respawn is a resume spawn').toBeGreaterThanOrEqual(1)
        for (const row of resumeRows) {
          const idx = row.argv.indexOf('--conversation')
          expect(row.argv[idx + 1], `the ADJACENT pair names the bound conversation: ${JSON.stringify(row.argv)}`).toBe(boundId)
        }
        expect(rows.every((row) => row.argv.includes('-i')), 'every spawn stays interactive').toBe(true)

        // The respawned CLI really RESUMED the bound conversation (the
        // fake's marker, in the respawned pane's own buffer). The
        // attention marks were asserted while the tab was still
        // backgrounded; NOW visit the agent tab (the user's natural next
        // step — visiting also dismisses the attention marks, click mode)
        // so the respawned pane hydrates and the marker is observable.
        await page.locator(`[data-context="tab"][data-tab-id="${tabId}"]`).click()
        await expect.poll(async () => harness.getActiveTabId(), { timeout: 15_000 }).toBe(tabId)
        await pollLeafBuffer(harness, tabId, paneId, `agy: resumed conversation ${boundId}`, 30_000)
      } finally {
        closeWs(inputWs)
        capture.close()
        await server.stop().catch(() => {})
      }
    } finally {
      await fs.rm(fixture.sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })

  test('scenario 6: /switch: to a new conversation and /resume: to an existing one both rebind; a stale old-launch write is rejected (no second association for the old id)', async ({ page }) => {
    const fixture = await makeFixture('freshell-google-cli-rebind-')
    try {
      const server = await startOwnedServer(fixture)
      const info = await server.start()
      const capture = new WsCapture(info.wsUrl, info.token)
      try {
        await capture.ready()
        const harness = await bootAndConnect(page, info)
        await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })
        const tabId = await harness.getActiveTabId()
        expect(tabId).toBeTruthy()

        const leaf = await openAntigravityPaneAndGetLeaf(page, harness, tabId!, fixture.cwdDir)
        const paneId: string = leaf.id
        const terminalId: string = leaf.content.terminalId
        await expect.poll(async () => (await leafBufferUnwrapped(harness, terminalId)).includes('agy> '), { timeout: 20_000 }).toBe(true)

        // Conversation ONE binds (association #1).
        await submitLine(page, paneId, 'alpha anchor prompt one')
        const associated1 = await capture.waitFor(
          (f) => f.type === 'terminal.session.associated'
            && f.terminalId === terminalId
            && f.sessionRef?.provider === 'antigravity',
          30_000,
          'association #1 (conversation one)',
        )
        const convOne: string = associated1.sessionRef.sessionId
        expect(convOne).toMatch(UUID_RE)
        await expect.poll(async () => {
          const leafNow = await findLeafById(harness, tabId!, paneId)
          return leafNow?.content?.sessionRef?.sessionId ?? null
        }, { timeout: 20_000 }).toBe(convOne)
        await settleWindow(page, 1_500)

        // ── `/switch:` — the new-conversation rebind ──────────────────────
        // The verb mints a NEW conversation; the NEXT prompt lands as its
        // latest user record → the locator rebinds the pane.
        await submitLine(page, paneId, 'switch:')
        await expect.poll(async () => (await leafBufferUnwrapped(harness, terminalId)).includes('agy: switched to conversation '), { timeout: 15_000 }).toBe(true)
        const switchedMarker = (await leafBufferUnwrapped(harness, terminalId)).match(/agy: switched to conversation ([0-9a-f-]{36})/)
        expect(switchedMarker, 'the fake printed the new conversation id').toBeTruthy()
        const convTwo: string = switchedMarker![1]
        expect(convTwo).not.toBe(convOne)

        await submitLine(page, paneId, 'bravo anchor prompt two')
        const associated2 = await capture.waitFor(
          (f) => f.type === 'terminal.session.associated'
            && f.terminalId === terminalId
            && f.sessionRef?.sessionId === convTwo,
          30_000,
          'association #2 (the /switch: rebind)',
        )
        expect(associated2.previousSessionId, 'the rebind names the superseded identity').toBe(convOne)
        await expect.poll(async () => {
          const leafNow = await findLeafById(harness, tabId!, paneId)
          return leafNow?.content?.sessionRef?.sessionId ?? null
        }, { timeout: 20_000 }).toBe(convTwo)
        await settleWindow(page, 1_500)

        // ── The stale old-launch write is REJECTED ────────────────────────
        // A transcript write carrying the pane's CURRENT submit text but
        // written at a timestamp that predates the submit (the dead
        // launch's late write shape) is never a candidate: the recency
        // window rejects records older than the submit. The pane must NOT
        // rebind back to the abandoned conversation — no second
        // association frame for the old id, the sessionRef stays on the
        // new conversation.
        const staleWriteAt = new Date(Date.now() - 60_000).toISOString()
        const convOneTranscript = path.join(brainRootOf(info), convOne, '.system_generated', 'logs', 'transcript.jsonl')
        await fs.appendFile(convOneTranscript, `${JSON.stringify({
          type: 'user_message',
          conversationId: convOne,
          text: 'bravo anchor prompt two',
          at: staleWriteAt,
        })}\n`)
        // Let the locator sweep (a 150 ms poll) see the write, plus settle.
        await settleWindow(page, 4_000)

        expect(capture.count((f) => f.type === 'terminal.session.associated'
          && f.terminalId === terminalId && f.sessionRef?.sessionId === convOne),
          'no SECOND association for the old id — the stale write is rejected').toBe(1)
        await expect.poll(async () => {
          const leafNow = await findLeafById(harness, tabId!, paneId)
          return leafNow?.content?.sessionRef?.sessionId ?? null
        }, { timeout: 5_000 }).toBe(convTwo)

        // Non-vacuity: the pane still works on the NEW conversation — a
        // follow-up prompt lands there and the pane stays bound to it.
        await submitLine(page, paneId, 'charlie anchor prompt three')
        await expect.poll(async () => (await leafBufferUnwrapped(harness, terminalId)).includes('turn done.'), { timeout: 15_000 }).toBe(true)
        await settleWindow(page, 1_500)
        await expect.poll(async () => {
          const leafNow = await findLeafById(harness, tabId!, paneId)
          return leafNow?.content?.sessionRef?.sessionId ?? null
        }, { timeout: 5_000 }).toBe(convTwo)
        expect(capture.count((f) => f.type === 'terminal.session.associated'
          && f.terminalId === terminalId && f.sessionRef?.sessionId === convOne),
          'the follow-up turn never resurrects the old id either').toBe(1)

        // ── `/resume:` — the existing-conversation rebind ─────────────────
        // The EXISTING conversation is one this pane NEVER owned: the
        // in-CLI switch to a prior conversation of THIS pane is outside the
        // supported shape — the coordinator rekeys the abandoned key to
        // `Aliased{to: new}` at the rebind and a superseded key is NEVER
        // directly claimable again (REKEYED_ALIAS_KEY, the anti-fork
        // discipline in freshell-ownership's begin). The supported
        // existing-conversation target mirrors the Task 6 rebind suite's
        // scenario 3c: a planted, never-owned conversation in the same
        // cwd (the fake's own record format, an aged first record).
        const convExisting = 'conv-resume-existing-e2e'
        const plantedTranscriptDir = path.join(brainRootOf(info), convExisting, '.system_generated', 'logs')
        await fs.mkdir(plantedTranscriptDir, { recursive: true })
        const plantedAt = new Date(Date.now() - 60_000).toISOString()
        await fs.writeFile(path.join(plantedTranscriptDir, 'transcript.jsonl'), [
          JSON.stringify({
            type: 'session_start',
            conversationId: convExisting,
            workspacePaths: [fixture.cwdDir],
            model: 'gemini-3-pro',
            startedAt: plantedAt,
          }),
          JSON.stringify({
            type: 'user_message',
            conversationId: convExisting,
            text: 'the earlier conversation own prompt',
            at: plantedAt,
          }),
        ].map((line) => `${line}\n`).join(''))

        // The documented in-CLI switch to the EXISTING conversation: the
        // verb switches the active transcript and the NEXT prompt lands as
        // that transcript's LATEST user record → the locator rebinds the
        // pane to the existing id.
        await submitLine(page, paneId, `resume: ${convExisting}`)
        await expect.poll(async () => (await leafBufferUnwrapped(harness, terminalId)).includes(`agy: resumed conversation ${convExisting}`), { timeout: 15_000 }).toBe(true)

        await submitLine(page, paneId, 'delta anchor prompt four')
        // The pane's sessionRef moves to the EXISTING conversation (the
        // load-bearing rebind — the locator's latest-user-record match
        // adopts the resumed conversation).
        await expect.poll(async () => {
          const leafNow = await findLeafById(harness, tabId!, paneId)
          return leafNow?.content?.sessionRef?.sessionId ?? null
        }, { timeout: 30_000, message: 'the /resume: rebind moves the pane to the existing conversation' }).toBe(convExisting)
        // The REBIND association broadcast names the superseded identity.
        const associated3 = await capture.waitFor(
          (f) => f.type === 'terminal.session.associated'
            && f.terminalId === terminalId
            && f.sessionRef?.sessionId === convExisting
            && f.previousSessionId === convTwo,
          30_000,
          'association #3 (the /resume: rebind to the existing conversation)',
        )
        expect(associated3.previousSessionId, 'the resume rebind names the superseded identity').toBe(convTwo)
      } finally {
        capture.close()
        await server.stop().catch(() => {})
      }
    } finally {
      await fs.rm(fixture.sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })

  test('scenario 11: a two-line Ctrl+J prompt binds exact identity — one multi-line submit, one turn, and the history surface carries the multi-line prompt', async ({ page }) => {
    const fixture = await makeFixture('freshell-google-cli-multiline-')
    try {
      const server = await startOwnedServer(fixture)
      const info = await server.start()
      const capture = new WsCapture(info.wsUrl, info.token)
      try {
        await capture.ready()
        const harness = await bootAndConnect(page, info)
        await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })
        const tabId = await harness.getActiveTabId()
        expect(tabId).toBeTruthy()

        const leaf = await openAntigravityPaneAndGetLeaf(page, harness, tabId!, fixture.cwdDir)
        const paneId: string = leaf.id
        const terminalId: string = leaf.content.terminalId
        await expect.poll(async () => (await leafBufferUnwrapped(harness, terminalId)).includes('agy> '), { timeout: 20_000 }).toBe(true)

        // The two-line prompt: `line one`, Ctrl+J — the CLI's documented
        // "insert a newline into the prompt" (the ws capture joins the LF
        // as inline content and flushes ONE full multi-line submit at the
        // Enter; whole-delta review rounds 1+3) — then `line two`, Enter.
        // The fake must submit ONE turn carrying the full two-line text:
        // pre-fix it treated the LF as a submit delimiter and ran TWO
        // turns (`line one`, then `line two`), while the capture flushed
        // ONE submit (`line one\nline two`) — the locator's exact-text
        // match could never bind, and this wait times out.
        const xterm = paneXterm(page, paneId)
        await xterm.click()
        await page.keyboard.type('line one')
        await page.keyboard.press('Control+j')
        await page.keyboard.type('line two')
        await page.keyboard.press('Enter')

        // ONE bind: the associated frame names the conversation the
        // multi-line submit armed (the store write precedes it).
        const associated = await capture.waitFor(
          (f) => f.type === 'terminal.session.associated'
            && f.terminalId === terminalId
            && f.sessionRef?.provider === 'antigravity',
          30_000,
          'terminal.session.associated (the two-line Ctrl+J prompt binds)',
        )
        const boundId: string = associated.sessionRef.sessionId
        expect(boundId).toMatch(UUID_RE)
        await expect.poll(async () => {
          const leafNow = await findLeafById(harness, tabId!, paneId)
          return leafNow?.content?.sessionRef ?? null
        }, { timeout: 20_000 }).toMatchObject({ provider: 'antigravity', sessionId: boundId })

        // The turn completes EXACTLY ONCE (seq 1 + one idle) — one fake
        // turn for the one Enter, the pane's first live-settled turn
        // under the submit-anchored baseline.
        await capture.waitFor(
          (f) => f.type === 'terminal.turn.complete' && f.terminalId === terminalId && f.completionSeq === 1,
          20_000,
          'terminal.turn.complete #1 (the multi-line turn settles)',
        )
        await capture.waitFor(
          (f) => f.type === 'terminal.idle' && f.terminalId === terminalId,
          15_000,
          'terminal.idle #1 (the multi-line turn)',
        )
        await settleWindow(page, 2_000)
        expect(capture.count((f) => f.type === 'terminal.session.associated' && f.terminalId === terminalId),
          'exactly one bind for the whole two-line prompt').toBe(1)
        expect(capture.count((f) => f.type === 'terminal.turn.complete' && f.terminalId === terminalId),
          'the multi-line turn rings exactly one completion').toBe(1)
        expect(capture.count((f) => f.type === 'terminal.idle' && f.terminalId === terminalId),
          'the multi-line turn rings exactly one idle').toBe(1)

        // The resume/history surface shows the multi-line prompt bound to
        // the pane: the session-directory row for the bound conversation
        // carries the FULL two-line text as its first user message (the
        // message fields populate on the watcher's re-parse — the
        // google-cli-history poll shape; a poll settles when the data
        // arrives, the budget is pure headroom).
        await expect.poll(async () => {
          const rows = await fetchDirectory(info)
          const row = rows.find((r) => r.provider === 'antigravity' && r.sessionId === boundId)
          return row?.firstUserMessage === 'line one\nline two' ? row.firstUserMessage : null
        }, { timeout: 100_000, message: 'the directory row carries the multi-line prompt' }).toBe('line one\nline two')
      } finally {
        capture.close()
        await server.stop().catch(() => {})
      }
    } finally {
      await fs.rm(fixture.sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })

  test('scenario 9: the shared name agrees on pane header, tab, sidebar, and history after reload, and a manual Rename wins (unified store, not the gemini legacy pin)', async ({ page }) => {
    test.setTimeout(600_000)
    const fixture = await makeFixture('freshell-google-cli-naming-')
    const gemini = await startFakeGemini(GENERATED_NAME)
    try {
      const server = await startOwnedServer(fixture, { geminiApiKey: FAKE_GEMINI_KEY }, { FRESHELL_GEMINI_BASE_URL: gemini.baseUrl })
      const info = await server.start()
      try {
        const harness = await bootAndConnect(page, info)
        await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })

        // The unified-store pin (the contract the surfaces rely on):
        // antigravity IS a unified agent mode and the shared provider
        // schema accepts it — gemini explicitly does NOT join (the legacy
        // four-scope pin stays).
        expect(isUnifiedAgentMode('antigravity'), 'antigravity is in the unified store').toBe(true)
        expect(NamedProviderSchema.safeParse('antigravity').success).toBe(true)
        expect(isUnifiedAgentMode('gemini'), 'gemini stays on the legacy scope').toBe(false)

        // A session-owned agent tab, then the first message: the naming
        // lanes materialize the session and the auto-title generates the
        // shared short name (the fake Gemini's deterministic answer).
        const { tabId, leaf } = await openAntigravitySessionTab(page, harness, fixture.cwdDir)
        const paneId: string = leaf.id
        const terminalId: string = leaf.content.terminalId
        await expect.poll(async () => (await leafBufferUnwrapped(harness, terminalId)).includes('agy> '), { timeout: 20_000 }).toBe(true)
        await submitLine(page, paneId, 'Repair the sardine factory line')

        const boundRef = await expect.poll(async () => {
          const leafNow = await findLeafById(harness, tabId, paneId)
          return leafNow?.content?.sessionRef ?? null
        }, { timeout: 30_000 }).not.toBeNull().then(async () => {
          const leafNow = await findLeafById(harness, tabId, paneId)
          return leafNow?.content?.sessionRef as { provider: string; sessionId: string }
        })
        expect(boundRef.provider).toBe('antigravity')
        expect(boundRef.sessionId).toMatch(UUID_RE)
        const nameRef = { kind: 'session' as const, provider: 'antigravity' as const, sessionId: boundRef.sessionId }
        const namesServer = {
          server: server as unknown as UnifiedNamesServer['server'],
          info,
          projectDir: fixture.cwdDir,
          root: fixture.sharedRoot,
          stop: async () => {},
        } as UnifiedNamesServer

        // The session-directory convergence pre-wait (the Task 12 lesson):
        // the directory row first appears when the transcript materializes
        // and its message fields populate on the watcher's follow-up
        // re-parse — a naming record can converge BEFORE that. The history
        // surface reads the directory, so wait for the row's FULL shape
        // here (generous: the watcher coalesces file events and the
        // re-parse lands late under contention).
        await expect.poll(async () => {
          const response = await fetch(
            `${info.baseUrl}/api/session-directory?priority=visible&limit=50`,
            { headers: { 'x-auth-token': info.token } },
          )
          if (!response.ok) return null
          const payload = await response.json() as { items?: Array<{ sessionId?: string; provider?: string; cwd?: string; firstUserMessage?: string }> }
          const row = (payload.items ?? []).find((item) => item.sessionId === boundRef.sessionId && item.provider === 'antigravity')
          return row?.cwd === fixture.cwdDir && row?.firstUserMessage === 'Repair the sardine factory line' ? row : null
        }, { timeout: 100_000 }).not.toBeNull()

        // The GENERATED name is the one shared name on every surface (the
        // baseline the manual rename must beat).
        await expectSharedName(harness, nameRef, GENERATED_NAME, {
          page, server: namesServer, tabId, sessionId: boundRef.sessionId,
          surfaces: ['http', 'redux', 'pane', 'tab', 'sidebar', 'history'],
        })

        // ── Manual Rename wins ─────────────────────────────────────────────
        // Rename through the pane-header inline editor (a real user
        // surface): the manual name replaces the generated one on EVERY
        // surface, and the persisted record's source is the user. (The
        // history surface deliberately runs in the FIRST call (the
        // generated-name baseline, from a collapsed store) and the
        // AFTER-RELOAD call below (a fresh store) — not here: the
        // helper's project-header toggle persists in the store across
        // view switches, so a second consecutive history surface would
        // click-collapse the group its own first call expanded. The
        // after-reload call is the scenario's binding four-surface
        // agreement.)
        await renameThroughPaneHeader(page, MANUAL_NAME)
        await expectSharedName(harness, nameRef, MANUAL_NAME, {
          page, server: namesServer, tabId, sessionId: boundRef.sessionId,
          surfaces: ['http', 'redux', 'pane', 'tab', 'sidebar'],
        })
        await expect.poll(async () => {
          const response = await fetch(`${info.baseUrl}/api/session-names/read`, {
            method: 'POST',
            headers: { 'x-auth-token': info.token, 'content-type': 'application/json' },
            body: JSON.stringify({ refs: [nameRef] }),
          })
          if (!response.ok) return null
          const payload = await response.json() as { names: Array<{ record: { name: string; source: string } }> }
          return payload.names[0]?.record ?? null
        }, { timeout: 30_000, intervals: [500, 1_000, 2_000] }).toMatchObject({ name: MANUAL_NAME, source: 'manual' })

        // A LATER turn's naming events never resurrect the generated name.
        await submitLine(page, paneId, 'another turn after the rename')
        await expect.poll(async () => (await leafBufferUnwrapped(harness, terminalId)).includes('turn done.'), { timeout: 20_000 }).toBe(true)
        await expectSharedName(harness, nameRef, MANUAL_NAME, {
          page, server: namesServer, tabId, sessionId: boundRef.sessionId,
          surfaces: ['http', 'pane', 'tab'],
        })

        // ── AFTER RELOAD the four surfaces still agree ────────────────────
        // The durable saved name rehydrates from the server-side store
        // (the pane respawns with its conversation; the names bootstrap
        // re-reads the record) — pane header, tab title, sidebar row, and
        // history row all show the MANUAL name.
        await page.reload({ waitUntil: 'domcontentloaded' })
        await harness.waitForHarness()
        await harness.waitForConnection()
        await expect(async () => {
          const status = await page.evaluate(() => (window as any).__FRESHELL_TEST_HARNESS__?.getWsReadyState())
          expect(status).toBe('ready')
        }).toPass({ timeout: 30_000 })
        await pollLeafBuffer(harness, tabId, paneId, 'agy> ', 30_000)
        await expectSharedName(harness, nameRef, MANUAL_NAME, {
          page, server: namesServer, tabId, sessionId: boundRef.sessionId,
          surfaces: ['http', 'redux', 'pane', 'tab', 'sidebar', 'history'],
        })
      } finally {
        await gemini.close().catch(() => {})
        await server.stop().catch(() => {})
      }
    } finally {
      await fs.rm(fixture.sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })

  test('scenario 10: a remote antigravity tab\'s saved name resolves on this device through the tabs-registry overlay', async ({ page }) => {
    const fixture = await makeFixture('freshell-google-cli-remote-name-')
    let deviceB: WebSocket | null = null
    try {
      const server = await startOwnedServer(fixture)
      const info = await server.start()
      try {
        // Two devices: the page selects machine A; a raw second device (B)
        // pushes the remote tab record (the sidebar-remote-status-rings
        // pattern — the push discipline awaits the matching ack).
        const machineA = await registerE2eMachine(info, 'E2E Device A (naming)')
        const machineB = await registerE2eMachine(info, 'E2E Device B (naming)')
        await installE2eMachineIdentity(page.context(), info, machineA.id)
        const harness = await bootAndConnect(page, info)
        await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })

        // Bind a session here and give it a manual saved name (the durable
        // name the remote overlay must resolve).
        const { tabId, leaf } = await openAntigravitySessionTab(page, harness, fixture.cwdDir)
        const paneId: string = leaf.id
        const terminalId: string = leaf.content.terminalId
        await expect.poll(async () => (await leafBufferUnwrapped(harness, terminalId)).includes('agy> '), { timeout: 20_000 }).toBe(true)
        await submitLine(page, paneId, 'remember: remote-naming-nonce')
        const boundRef = await expect.poll(async () => {
          const leafNow = await findLeafById(harness, tabId, paneId)
          return leafNow?.content?.sessionRef ?? null
        }, { timeout: 30_000 }).not.toBeNull().then(async () => {
          const leafNow = await findLeafById(harness, tabId, paneId)
          return leafNow?.content?.sessionRef as { provider: string; sessionId: string }
        })
        expect(boundRef.provider).toBe('antigravity')
        await renameThroughPaneHeader(page, MANUAL_NAME)
        await expect.poll(async () => {
          const response = await fetch(`${info.baseUrl}/api/session-names/read`, {
            method: 'POST',
            headers: { 'x-auth-token': info.token, 'content-type': 'application/json' },
            body: JSON.stringify({ refs: [{ kind: 'session', provider: 'antigravity', sessionId: boundRef.sessionId }] }),
          })
          if (!response.ok) return null
          const payload = await response.json() as { names: Array<{ record: { name: string } }> }
          return payload.names[0]?.record?.name ?? null
        }, { timeout: 30_000, intervals: [500, 1_000, 2_000] }).toBe(MANUAL_NAME)

        // Close the local tab (the session now lives only on the OTHER
        // device's record) and RELOAD — the saved name must resolve through
        // the durable store + the bootstrap, not the in-page rename cache.
        await page.locator(`[data-context="tab"][data-tab-id="${tabId}"]`).getByRole('button', { name: /close/i }).click()
        await expect.poll(async () => (await harness.getState()).tabs.tabs.some((tab: any) => tab.id === tabId), { timeout: 15_000 }).toBe(false)
        await page.reload({ waitUntil: 'domcontentloaded' })
        await harness.waitForHarness()
        await harness.waitForConnection()
        await expect(async () => {
          const status = await page.evaluate(() => (window as any).__FRESHELL_TEST_HARNESS__?.getWsReadyState())
          expect(status).toBe('ready')
        }).toPass({ timeout: 30_000 })

        // Device B pushes its snapshot: a remote tab whose pane is the SAME
        // antigravity session, carrying the `nameSource` naming identity
        // and a deliberately STALE captured tabName (the overlay — the
        // d0b7295c7 whitelist widening — must resolve the SAVED name, so
        // the stale capture never shows).
        const STALE_CAPTURED_NAME = 'Stale captured name'
        deviceB = await connectAndHello(info.wsUrl, info.token)
        const pushSnapshot = async (records: unknown[]): Promise<void> => {
          const ackPromise = new Promise<any>((resolve, reject) => {
            const timer = setTimeout(() => {
              deviceB!.removeListener('message', onMessage)
              reject(new Error('timed out waiting for tabs.sync.ack'))
            }, 15_000)
            const onMessage = (raw: WebSocket.RawData) => {
              let msg: any
              try {
                msg = JSON.parse(String(raw))
              } catch {
                return
              }
              if (msg?.type === 'tabs.sync.ack') {
                clearTimeout(timer)
                resolve(msg)
              }
            }
            deviceB!.on('message', onMessage)
          })
          deviceB!.send(JSON.stringify({
            type: 'tabs.sync.push',
            deviceId: machineB.id,
            deviceLabel: machineB.label,
            clientInstanceId: 'e2e-device-b-naming-window',
            snapshotRevision: 1,
            records,
          }))
          const ack = await ackPromise
          expect(ack.accepted, `tabs.sync.ack accepted the push: ${JSON.stringify(ack)}`).toBe(true)
        }
        const now = Date.now()
        await pushSnapshot([{
          tabKey: `${machineB.id}:tab-agy-remote-1`,
          tabId: 'tab-agy-remote-1',
          tabName: STALE_CAPTURED_NAME,
          status: 'open',
          revision: 1,
          createdAt: now - 10_000,
          updatedAt: now,
          paneCount: 1,
          titleSetByUser: false,
          nameSource: { kind: 'session', paneId: 'pane-agy-remote-1' },
          panes: [
            {
              paneId: 'pane-agy-remote-1',
              kind: 'terminal',
              payload: {
                mode: 'antigravity',
                sessionRef: { provider: 'antigravity', sessionId: boundRef.sessionId },
                sessionKeys: [`antigravity:${boundRef.sessionId}`],
              },
            },
          ],
        }])

        // The Tabs view's OTHER-DEVICES card resolves the SAVED name on
        // this device — the canonical-cache overlay through the record's
        // naming identity, never the stale captured name.
        await page.getByRole('button', { name: 'Tabs (Ctrl+B A)' }).click()
        const card = page.locator('[data-context="tabs-card"]', { hasText: MANUAL_NAME })
        await expect(card).toBeVisible({ timeout: 45_000 })
        const cardText = await card.innerText()
        expect(cardText, 'the remote card shows the session\'s SAVED name').toContain(MANUAL_NAME)
        expect(cardText, 'the stale captured name never shows').not.toContain(STALE_CAPTURED_NAME)
        // Non-vacuity: the record really arrived as a REMOTE open record
        // keyed by this session (the store makes the name resolution
        // meaningful, not a coincidental local card).
        await expect.poll(async () => page.evaluate((key) => {
          const state = (window as any).__FRESHELL_TEST_HARNESS__?.getState()
          const scan = (records: any[] | undefined) => (records ?? []).some(
            (record) => (record?.panes ?? []).some(
              (pane: any) => (pane?.payload?.sessionKeys ?? []).includes(key),
            ),
          )
          return scan(state?.tabRegistry?.remoteOpen)
        }, `antigravity:${boundRef.sessionId}`), { timeout: 30_000 }).toBe(true)
        // The card is the REMOTE device's card (its aria-label carries the
        // other device's label + the resolved saved name).
        await expect(card).toHaveAttribute('aria-label', `${machineB.label}: ${MANUAL_NAME}`)
      } finally {
        closeWs(deviceB)
        await server.stop().catch(() => {})
      }
    } finally {
      await fs.rm(fixture.sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })
})
