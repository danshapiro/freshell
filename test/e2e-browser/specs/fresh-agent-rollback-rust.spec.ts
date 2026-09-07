/**
 * FRESH-AGENT CONVERSATION ROLLBACK (/undo + /redo) — PW-RUST e2e (kata 1wxv, Task 7).
 *
 * Drives the REAL Rust server + real browser UI against hermetic provider
 * fakes and pins the rollback surface end-to-end across every provider lane:
 *
 *   opencode (revert/unrevert, patch-carrying turn): a /undo STEP refills the
 *     composer (decision 4), the fake keeps serving the reverted tail
 *     UNFLAGGED (freshell computes the active prefix itself), /redo restores,
 *     a new submission destroys redo (decision 5) while the marker bucket
 *     survives (decision 6), undoing a PATCH-CARRYING turn leaves the working
 *     tree BYTE-IDENTICAL (decision 1: rollback is conversation-only — the
 *     managed serve runs with opencode snapshots disabled so native file
 *     re-application can never fire), and a double undo orders markers in
 *     CONVERSATION order (user-role filter proves it — one step = a user row
 *     AND an assistant row).
 *   opencode undo-to-here: the per-turn hover-toolbar icon is ONE revert at
 *     the targeted user message (decision 3), never N round trips.
 *   codex (thread/revert; undo-only): undo-to-here reverts in place (exactly
 *     one thread/revert, never the deprecated thread/rollback path) and a
 *     typed /redo is answered by the pinned client-side codex notice
 *     (decision 5 — the reserved-name interception; the wire refusal stays as
 *     backstop).
 *   claude AND kilroy (fork-at-point emulation): /undo re-keys the pane via a
 *     forkSession:true sidecar create that MINTS a fresh durable id (the s2rk
 *     correction), refills the composer, never touches checkpoints (decision
 *     1 — zero /checkpoints/restore traffic), and /redo re-forks the retained
 *     original (the tip/LCP contract).
 *   mid-turn lockout (decisions 6/7): a typed /undo while a turn runs is
 *     refused by the client busy gate with the pinned steer copy, NO rollback
 *     frames leave the client (the sidecar stdin audit shows no fork create),
 *     and the parked approval card is never silently resolved (cancel frames
 *     fire only on a SUCCESSFUL rollback; the sanity tail then proves /undo
 *     succeeds once the turn completes).
 *   multi-client convergence (decision 10): a sibling raw-WS client observes
 *     freshAgent.session.rolledBack{revokeAttention:true}; the REST snapshot
 *     (another client's truth) reads identically; a page reload re-attaches
 *     to the same post-rollback state (the durable record survives refresh).
 *
 * Every test hard-gates expect(e2eServerKind).toBe('rust') and owns its
 * RustServer. Per-test wall budget: 120s (the cloud e2e budget — this spec is
 * cloud-runnable by design: every provider is an in-repo hermetic fake, so it
 * appears in NEITHER CLOUD_SKIP_SPECS nor CLOUD_SKIP_TITLES).
 *
 * Donors (helpers copied, not imported, per this suite's per-spec-ownership
 * convention): fresh-agent-control-rust.spec.ts (lane boots, pane bootstrap,
 * snapshot/audit/stdin readers, sendOpencodeTurn/sendCodexTurnAndWaitRows),
 * agent-checkpoint-rewind.spec.ts (turn-action hover-toolbar idiom:
 * hover the turn's article, click the aria-labeled button inside the
 * "Turn actions" toolbar). WsCapture is IMPORTED from
 * ../helpers/ws-capture.js (the shared helper — never re-declared).
 */
import fs from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import crypto from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'
import { test, expect } from '../helpers/fixtures.js'
import {
  RustServer,
  GEMINI_STRIP_ENV_PREFIXES,
  type TestServerInfo,
} from '../helpers/rust-server.js'
import { TestHarness } from '../helpers/test-harness.js'
import { openPanePicker } from '../helpers/pane-picker.js'
import { WsCapture } from '../helpers/ws-capture.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const CLAUDE_SIDECAR_FIXTURE = path.resolve(__dirname, '../fixtures/providers/fake-claude-sdk-sidecar.mjs')
const CODEX_APP_SERVER_FIXTURE = path.resolve(
  __dirname,
  '../../fixtures/coding-cli/codex-app-server/fake-app-server.mjs',
)
const OPENCODE_FIXTURE = path.resolve(__dirname, '../fixtures/fake-opencode.cjs')

const CANONICAL_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

// ── Fixture program (claude/kilroy lane) ────────────────────────────────────
// Plain sends take the canned success turn (u/a transcript lines + a positive
// completion); 'RAISE_PERMISSION' parks the turn behind an approval card
// until the Allow respond lands (the mid-turn lockout case).
const ROLLBACK_CLAUDE_PROGRAM = {
  rules: [
    {
      on: 'msg:send',
      match: { text: 'RAISE_PERMISSION' },
      emit: [
        { kind: 'approval', data: { id: 'req-perm-1', tool: 'Bash', input: { command: 'ls' } } },
      ],
    },
    {
      on: 'msg:permission.respond',
      match: { decision: { behavior: 'allow' } },
      emit: [{ kind: 'completion', data: { subtype: 'success' } }],
    },
  ],
}

// ── Copied helpers (donor: fresh-agent-control-rust.spec.ts) ────────────────

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

async function bootWall(
  page: Page,
  options: {
    env?: Record<string, string>
    stripEnvPrefixes?: string[]
    setupHome?: (homeDir: string) => Promise<void>
  } = {},
): Promise<{ server: RustServer; info: TestServerInfo; harness: TestHarness }> {
  const server = new RustServer({
    env: options.env,
    stripEnvPrefixes: options.stripEnvPrefixes,
    setupHome: options.setupHome,
  })
  const info = await server.start()
  await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
  const harness = new TestHarness(page)
  await harness.waitForHarness()
  await harness.waitForConnection()
  return { server, info, harness }
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

// JSONL fixture-log readers (retry-until polling, never bare fixed sleeps).
function readJsonl(filePath: string): any[] {
  if (!existsSync(filePath)) return []
  return readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter((row) => row !== null)
}

/** Read the sidecar raw-stdin audit, JSON-parsing each recorded frame. */
function readStdinFrames(stdinLog: string): any[] {
  return readJsonl(stdinLog)
    .map((row) => {
      try {
        return JSON.parse(row.line)
      } catch {
        return null
      }
    })
    .filter((frame) => frame !== null)
}

async function waitForStdinFrame(
  stdinLog: string,
  pred: (frame: any) => boolean,
  what: string,
  timeoutMs = 15_000,
): Promise<any> {
  let found: any = null
  await expect
    .poll(
      () => {
        found = readStdinFrames(stdinLog).find(pred) ?? null
        return Boolean(found)
      },
      { timeout: timeoutMs, message: `timed out waiting for ${what} in ${stdinLog}` },
    )
    .toBe(true)
  return found
}

/** Direct REST snapshot read — the route every card renders from. */
async function fetchSnapshot(
  info: TestServerInfo,
  sessionType: string,
  provider: string,
  threadId: string,
): Promise<any | null> {
  const res = await fetch(
    `${info.baseUrl}/api/fresh-agent/threads/${sessionType}/${provider}/${encodeURIComponent(threadId)}`,
    { headers: { 'x-auth-token': info.token } },
  )
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`snapshot fetch failed: ${res.status} ${await res.text()}`)
  return res.json()
}

// ── Pane bootstrap helpers (one per lane, donor-derived) ────────────────────

async function enableClis(page: Page, clis: Record<string, boolean>): Promise<void> {
  await page.evaluate((payload) => {
    ;(window as any).__FRESHELL_TEST_HARNESS__?.dispatch({
      type: 'connection/setAvailableClis',
      payload,
    })
  }, clis)
}

async function createFreshAgentPane(page: Page, name: RegExp, label: string, cwd: string): Promise<void> {
  const picker = await openPanePicker(page)
  await picker.getByRole('button', { name }).click({ force: true })
  const directoryInput = page.getByLabel(new RegExp(`^Starting directory for ${label}$`, 'i'))
  await expect(directoryInput).toBeVisible({ timeout: 15_000 })
  await directoryInput.fill(cwd)
  await directoryInput.press('Enter')
  await expect(page.locator('[data-context="fresh-agent"]').last()).toBeVisible({
    timeout: 15_000,
  })
}

async function paneLeaf(harness: TestHarness, tabId: string): Promise<any> {
  return findFreshAgentLeaf(await harness.getPaneLayout(tabId))
}

async function waitForPaneStatus(
  harness: TestHarness,
  tabId: string,
  wanted: string | string[],
  timeoutMs = 30_000,
): Promise<void> {
  const wantedSet = Array.isArray(wanted) ? wanted : [wanted]
  await expect
    .poll(
      async () => {
        const status = (await paneLeaf(harness, tabId))?.content?.status ?? null
        return typeof status === 'string' && wantedSet.includes(status)
      },
      { timeout: timeoutMs },
    )
    .toBe(true)
}

/** Fill the visible fresh-agent composer and click Send. */
async function sendComposerText(page: Page, text: string): Promise<void> {
  const paneRoot = page.locator('[data-context="fresh-agent"]').last()
  const composer = paneRoot.getByRole('textbox', { name: 'Chat message input' })
  await composer.fill(text)
  await paneRoot.getByRole('button', { name: 'Send' }).click()
}

/** Capture the pane's durable sessionRef id once it exists. */
async function captureDurableId(
  harness: TestHarness,
  tabId: string,
  match: RegExp,
  timeoutMs = 15_000,
): Promise<string> {
  let captured = ''
  await expect
    .poll(
      async () => {
        captured = (await paneLeaf(harness, tabId))?.content?.sessionRef?.sessionId ?? ''
        return captured
      },
      { timeout: timeoutMs },
    )
    .toMatch(match)
  return captured
}

function claudeLaneEnv(
  sharedRoot: string,
  flavour: 'freshclaude' | 'kilroy',
  extraEnv: Record<string, string> = {},
): Record<string, string> {
  return {
    FRESHELL_CLAUDE_SIDECAR: CLAUDE_SIDECAR_FIXTURE,
    FRESHELL_CLAUDE_NODE: process.execPath,
    FRESHELL_FAKE_PROVIDER: flavour,
    FRESHELL_FAKE_PROGRAM: JSON.stringify(ROLLBACK_CLAUDE_PROGRAM),
    FRESHELL_FAKE_STDIN: path.join(sharedRoot, 'sidecar-stdin.jsonl'),
    FRESHELL_FAKE_EVENTS: path.join(sharedRoot, 'sidecar-events.jsonl'),
    ...extraEnv,
  }
}

/** Boot the claude lane: create a freshclaude/kilroy pane on an owned server. */
async function bootClaudeLane(
  page: Page,
  flavour: 'freshclaude' | 'kilroy',
  extraEnv: Record<string, string> = {},
): Promise<{
  server: RustServer
  info: TestServerInfo
  harness: TestHarness
  sharedRoot: string
  projectDir: string
  stdinLog: string
  eventsLog: string
  tabId: string
}> {
  const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), `freshell-rollback-${flavour}-`))
  try {
    const projectDir = path.join(sharedRoot, 'project')
    await fs.mkdir(projectDir, { recursive: true })
    const { server, info, harness } = await bootWall(page, {
      env: claudeLaneEnv(sharedRoot, flavour, extraEnv),
      // Kilroy parity includes independence from Gemini-summary availability
      // (donor: the control spec's AGENT-24 strip — every Gemini-capable env
      // name is scrubbed from the spawned server's env, unit-pinned in
      // helpers/rust-server.test.ts).
      stripEnvPrefixes: flavour === 'kilroy' ? [...GEMINI_STRIP_ENV_PREFIXES] : undefined,
      setupHome: seedWallConfig({ providers: ['claude'], freshAgent: true }),
    })
    await selectShellIfPickerShowing(page)
    await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })
    await enableClis(page, { claude: true })
    const tabId = (await harness.getActiveTabId())!
    expect(tabId).toBeTruthy()
    await createFreshAgentPane(
      page,
      flavour === 'kilroy' ? /^Kilroy$/ : /^Freshclaude$/,
      flavour === 'kilroy' ? 'Kilroy' : 'Freshclaude',
      projectDir,
    )
    return {
      server,
      info,
      harness,
      sharedRoot,
      projectDir,
      stdinLog: path.join(sharedRoot, 'sidecar-stdin.jsonl'),
      eventsLog: path.join(sharedRoot, 'sidecar-events.jsonl'),
      tabId,
    }
  } catch (error) {
    await fs.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

async function bootCodexLane(page: Page): Promise<{
  server: RustServer
  info: TestServerInfo
  harness: TestHarness
  sharedRoot: string
  projectDir: string
  opLogPath: string
  tabId: string
}> {
  const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-rollback-codex-'))
  try {
    const projectDir = path.join(sharedRoot, 'project')
    await fs.mkdir(projectDir, { recursive: true })
    const opLogPath = path.join(sharedRoot, 'codex-ops.jsonl')
    const { server, info, harness } = await bootWall(page, {
      env: {
        // Whitespace-split by spawn_sidecar (codex.rs): interpreter + script.
        CODEX_CMD: `${process.execPath} ${CODEX_APP_SERVER_FIXTURE}`,
        FAKE_CODEX_APP_SERVER_BEHAVIOR: JSON.stringify({
          appendThreadOperationLogPath: opLogPath,
          // REAL per-thread turn recording (fixture opt-in): thread/read
          // answers the recorded history, so a revert provably removes the tail.
          recordTurns: true,
        }),
      },
      setupHome: seedWallConfig({ providers: ['codex'], freshAgent: true }),
    })
    await selectShellIfPickerShowing(page)
    await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })
    await enableClis(page, { codex: true })
    const tabId = (await harness.getActiveTabId())!
    expect(tabId).toBeTruthy()
    await createFreshAgentPane(page, /^Freshcodex$/, 'Freshcodex', projectDir)
    return { server, info, harness, sharedRoot, projectDir, opLogPath, tabId }
  } catch (error) {
    await fs.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

async function bootOpencodeLane(page: Page, extraEnv: Record<string, string> = {}): Promise<{
  server: RustServer
  info: TestServerInfo
  harness: TestHarness
  sharedRoot: string
  projectDir: string
  auditLogPath: string
  tabId: string
}> {
  const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-rollback-opencode-'))
  try {
    const projectDir = path.join(sharedRoot, 'project')
    const binDir = path.join(sharedRoot, 'bin')
    const auditLogPath = path.join(sharedRoot, 'opencode-audit.jsonl')
    await fs.mkdir(projectDir, { recursive: true })
    await fs.mkdir(binDir, { recursive: true })
    const fakeOpencode = path.join(binDir, 'opencode')
    await fs.copyFile(OPENCODE_FIXTURE, fakeOpencode)
    await fs.chmod(fakeOpencode, 0o755)
    const { server, info, harness } = await bootWall(page, {
      env: {
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
        OPENCODE_CMD: fakeOpencode,
        FAKE_OPENCODE_AUDIT_LOG: auditLogPath,
        ...extraEnv,
      },
      setupHome: seedWallConfig({ providers: ['opencode'], freshAgent: true }),
    })
    await selectShellIfPickerShowing(page)
    await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })
    await enableClis(page, { opencode: true })
    const tabId = (await harness.getActiveTabId())!
    expect(tabId).toBeTruthy()
    await createFreshAgentPane(page, /^Freshopencode$/, 'Freshopencode', projectDir)
    return { server, info, harness, sharedRoot, projectDir, auditLogPath, tabId }
  } catch (error) {
    await fs.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

function readOpencodeAudit(auditLogPath: string): any[] {
  return readJsonl(auditLogPath)
}

/**
 * Read the codex fake's persisted per-thread turn records ([] when absent —
 * mirrors the fixture's own load semantics). turn/start sends are RECORDED
 * here (recordTurns opt-in); they are never op-logged (the op log only
 * carries thread/* methods), so this is the surface that proves a send did
 * or did not reach the provider.
 */
async function readRecordedCodexTurns(homeDir: string, threadId: string): Promise<any[]> {
  try {
    const parsed = JSON.parse(
      await fs.readFile(path.join(homeDir, '.codex', 'fake-turns', `${threadId}.json`), 'utf8'),
    )
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/** Send a prompt, wait for materialization (placeholder → ses_*), settle idle. */
async function sendOpencodeTurn(
  page: Page,
  harness: TestHarness,
  tabId: string,
  text: string,
  expectedPromptCount: number,
  auditLogPath: string,
): Promise<string> {
  const paneRoot = page.locator('[data-context="fresh-agent"]').last()
  await sendComposerText(page, text)
  if (expectedPromptCount === 1) {
    // First send materializes the durable ses_* id onto the pane.
    await expect
      .poll(async () => (await paneLeaf(harness, tabId))?.content?.sessionId ?? '', { timeout: 30_000 })
      .toMatch(/^ses_/)
  }
  await waitForPaneStatus(harness, tabId, 'idle')
  await expect
    .poll(
      () => readJsonl(auditLogPath).some((e) => e.event === 'prompt_async' && e.prompt === text),
      { timeout: 15_000 },
    )
    .toBe(true)
  // The assistant reply renders from the fake's own message store.
  await expect(paneRoot).toContainText(`Fake OpenCode response: ${text}`, { timeout: 30_000 })
  return (await paneLeaf(harness, tabId))?.content?.sessionId as string
}

/** Send one freshcodex turn and wait until its snapshot rows render. */
async function sendCodexTurnAndWaitRows(
  page: Page,
  expectedRowCount: number,
  text: string,
): Promise<void> {
  await sendComposerText(page, text)
  const paneRoot = page.locator('[data-context="fresh-agent"]').last()
  await expect(
    paneRoot.locator('article[data-turn-index]'),
    `${expectedRowCount} snapshot rows after "${text}"`,
  ).toHaveCount(expectedRowCount, { timeout: 30_000 })
}

// ── Rollback-spec helpers (no donor) ────────────────────────────────────────

/** The visible fresh-agent composer textbox. */
function composerLocator(page: Page) {
  return page.locator('[data-context="fresh-agent"]').last().getByRole('textbox', { name: 'Chat message input' })
}

/** Type a slash command into the composer and commit it with Enter. */
async function typeSlash(page: Page, text: string): Promise<void> {
  const composer = composerLocator(page)
  await composer.fill(text)
  await composer.press('Enter')
}

/**
 * Wait until the CLIENT's snapshot carries the rollback capability stamps —
 * the typed /undo and /redo gates read `snapshot?.capabilities`, and a typed
 * gesture before those stamps land is client-rejected with an auto-dismissing
 * notice (6s) and zero wire frames (observed as a full-parallel-run flake).
 * The "Undo to here" icon renders exactly when `capabilities.undo === true`,
 * so its presence is the same truth the gate consults.
 */
async function waitForRollbackCapability(page: Page): Promise<void> {
  const paneRoot = page.locator('[data-context="fresh-agent"]').last()
  const article = paneRoot.locator('article[data-turn-role="user"]').first()
  await article.hover()
  await expect(
    article.getByRole('button', { name: 'Undo to here' }),
    'the client-side rollback capability stamp landed (undo icon renders)',
  ).toBeVisible({ timeout: 15_000 })
  // Dismiss the hover toolbar so later gestures re-hover from a clean state.
  await page.mouse.move(0, 0)
}

/** Count of USER-role rows in a fresh-agent snapshot (null snapshot ⇒ 0). */
function userRows(snapshot: any | null): number {
  return ((snapshot?.turns ?? []) as any[]).filter((turn) => turn?.role === 'user').length
}

/**
 * Byte-exact working-tree fingerprint: every file under rootDir, paths sorted,
 * hashed path+contents. Decision 1's proof shape — undoing a patch-carrying
 * turn must leave this digest IDENTICAL.
 */
async function sha256Tree(rootDir: string): Promise<string> {
  const hash = crypto.createHash('sha256')
  async function walk(dir: string): Promise<void> {
    let entries: import('node:fs').Dirent[] = []
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(entryPath)
      } else if (entry.isFile()) {
        hash.update(path.relative(rootDir, entryPath))
        hash.update('\0')
        hash.update(await fs.readFile(entryPath))
        hash.update('\0')
      }
    }
  }
  await walk(rootDir)
  return hash.digest('hex')
}

test.describe('fresh-agent /undo + /redo conversation rollback (rust, kata 1wxv)', () => {
  // Per-test wall budget: 120s — the cloud e2e budget (this spec is
  // cloud-runnable by design; the forced-local receipt is a stand-in proof).
  test.setTimeout(120_000)

  test('opencode: /undo step refills composer, /redo restores, a new submission destroys redo — and undoing a patch-carrying turn never touches files (decisions 1, 4, 5)', async ({ page, e2eServerKind }) => {
    expect(e2eServerKind).toBe('rust')
    // Turn 2 is PATCH-CARRYING: the fake writes <cwd>/patch-target.txt while
    // simulating it, so the undo below provably crosses a file-mutating turn.
    const lane = await bootOpencodeLane(page, { FAKE_OPENCODE_PATCH_TURN: '2' })
    try {
      await waitForPaneStatus(lane.harness, lane.tabId, 'idle')
      const sessionId = await sendOpencodeTurn(page, lane.harness, lane.tabId, 'prompt one', 1, lane.auditLogPath)
      await sendOpencodeTurn(page, lane.harness, lane.tabId, 'prompt two', 2, lane.auditLogPath)
      const snap = (): Promise<any | null> => fetchSnapshot(lane.info, 'freshopencode', 'opencode', sessionId)

      // The patch-carrying turn wrote into the session working tree (never a
      // vacuous byte-identical proof: the file exists to be clobbered).
      await expect
        .poll(() => existsSync(path.join(lane.projectDir, 'patch-target.txt')), { timeout: 10_000 })
        .toBe(true)

      expect(userRows(await snap())).toBe(2)
      const treeHashBefore = await sha256Tree(lane.projectDir)
      await waitForRollbackCapability(page)

      // ── /undo (one step): turn 2 rolls back, the composer refills with its
      // prompt, the working tree is BYTE-IDENTICAL, and the marker bucket
      // holds msg_u2+msg_a2. ──
      await typeSlash(page, '/undo')
      await expect.poll(async () => userRows(await snap()), { timeout: 15_000 }).toBe(1)
      await expect
        .poll(() => composerLocator(page).inputValue(), { timeout: 15_000 })
        .toBe('prompt two') // decision 4 refill
      expect(await sha256Tree(lane.projectDir)).toBe(treeHashBefore)
      const reverted = readOpencodeAudit(lane.auditLogPath).filter((e) => e.event === 'reverted')
      expect(reverted).toHaveLength(1)
      expect(reverted[0].messageID).toMatch(/^msg/)
      const undone = await snap()
      // Delta-r1 F6: the rollback block carries the server-authored per-marker redo
      // gate — exactly the current-epoch marker's user id.
      const undoneUserMarkerIds = (undone.rolledBackTurns ?? [])
        .filter((t: any) => t.role === 'user')
        .map((t: any) => t.turnId)
      expect(undone.rollback).toEqual({ canRedo: true, undoneDepth: 1, redoableTurnIds: undoneUserMarkerIds })
      expect(undoneUserMarkerIds).toHaveLength(1)
      expect(undone.rolledBackTurns).toHaveLength(2) // msg_u2 + msg_a2
      expect(undone.rolledBackTurns.every((t: any) => t.rolledBack === true)).toBe(true)
      // The client snapshot caught up: the marker section renders.
      await expect(page.getByText(/Rolled back \(1\)/)).toBeVisible({ timeout: 15_000 })

      // ── /redo: the tail restores, the audit gains exactly one unreverted,
      // and redo availability collapses. (A FULL redo empties the marker
      // bucket — and the landed Task-5 contract omits the whole `rollback`
      // block for an empty bucket, never a phantom `canRedo:false`.) ──
      await typeSlash(page, '/redo')
      await expect.poll(async () => userRows(await snap()), { timeout: 15_000 }).toBe(2)
      await expect
        .poll(() => readOpencodeAudit(lane.auditLogPath).filter((e) => e.event === 'unreverted').length, { timeout: 15_000 })
        .toBe(1)
      const redone = await snap()
      expect(redone?.rollback ?? null).toBeNull()
      expect(redone?.rolledBackTurns ?? null).toBeNull()

      // ── DOUBLE undo: turn 2 then turn 1 roll back; the marker bucket lists
      // both steps in CONVERSATION order (user-role filter first — one undone
      // step contributes a user row AND an assistant row). ──
      await typeSlash(page, '/undo')
      await expect.poll(async () => userRows(await snap()), { timeout: 15_000 }).toBe(1)
      await typeSlash(page, '/undo')
      await expect.poll(async () => userRows(await snap()), { timeout: 15_000 }).toBe(0)
      await expect
        .poll(
          async () => ((await snap())?.rolledBackTurns ?? [])
            .filter((t: any) => t.role === 'user')
            .map((t: any) => t.summary),
          { timeout: 15_000 },
        )
        .toEqual(['prompt one', 'prompt two'])

      // ── A new submission destroys redo (decision 5); the markers survive
      // (decision 6). The new send also natively DELETES the reverted tail in
      // the fake (the verified opencode semantics). ──
      await sendComposerText(page, 'prompt three')
      await expect
        .poll(
          () => readOpencodeAudit(lane.auditLogPath).filter((e) => e.event === 'prompt_async').length,
          { timeout: 15_000 },
        )
        .toBe(3)
      await waitForPaneStatus(lane.harness, lane.tabId, 'idle')
      expect((await snap())?.rollback?.canRedo).toBe(false)
      expect(((await snap())?.rolledBackTurns ?? []).length).toBeGreaterThan(0)
    } finally {
      await lane.server.stop().catch(() => {})
      await fs.rm(lane.sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })

  test('opencode: multi-epoch markers — frozen prior-epoch rows lose "Redo to here" while the current epoch keeps it (delta-r1 F6)', async ({ page, e2eServerKind }) => {
    expect(e2eServerKind).toBe('rust')
    const lane = await bootOpencodeLane(page)
    try {
      await waitForPaneStatus(lane.harness, lane.tabId, 'idle')
      await sendOpencodeTurn(page, lane.harness, lane.tabId, 'prompt one', 1, lane.auditLogPath)
      await sendOpencodeTurn(page, lane.harness, lane.tabId, 'prompt two', 2, lane.auditLogPath)
      const sessionId = await sendOpencodeTurn(page, lane.harness, lane.tabId, 'prompt three', 3, lane.auditLogPath)
      const snap = (): Promise<any | null> => fetchSnapshot(lane.info, 'freshopencode', 'opencode', sessionId)
      expect(userRows(await snap())).toBe(3)
      await waitForRollbackCapability(page)

      // Epoch 0: /undo removes the prompt-three step — the marker IS redoable.
      await typeSlash(page, '/undo')
      await expect.poll(async () => userRows(await snap()), { timeout: 15_000 }).toBe(2)
      const epoch0 = await snap()
      expect(epoch0.rollback.canRedo).toBe(true)
      expect(epoch0.rollback.redoableTurnIds).toHaveLength(1)
      const epoch0MarkerId = epoch0.rollback.redoableTurnIds[0]
      const section = () => page.getByRole('region', { name: 'Rolled back turns' })
      await expect(section().getByRole('button', { name: 'Redo to here' })).toHaveCount(1, { timeout: 15_000 })

      // A new submission destroys redo AND (natively, in the fake) deletes the
      // epoch-0 tail — epoch 0's markers are now frozen forever.
      await sendComposerText(page, 'prompt three edited')
      await waitForPaneStatus(lane.harness, lane.tabId, 'idle')
      await expect.poll(async () => (await snap())?.rollback?.canRedo, { timeout: 15_000 }).toBe(false)

      // Epoch 1: /undo removes the RESENT step only — the bucket's union is the
      // frozen epoch-0 pair ++ the new epoch's pair, in conversation order.
      await typeSlash(page, '/undo')
      await expect.poll(async () => userRows(await snap()), { timeout: 15_000 }).toBe(2)
      const epoch1 = await snap()
      expect(epoch1.rollback.canRedo).toBe(true)
      expect(epoch1.rollback.undoneDepth).toBe(2)
      // The server-authored gate: exactly the CURRENT epoch's user marker id.
      expect(epoch1.rollback.redoableTurnIds).toHaveLength(1)
      const epoch1MarkerId = epoch1.rollback.redoableTurnIds[0]
      expect(epoch1MarkerId).not.toBe(epoch0MarkerId)
      const bucketIds = (epoch1.rolledBackTurns ?? []).map((t: any) => t.turnId)
      expect(bucketIds.indexOf(epoch0MarkerId)).toBeGreaterThanOrEqual(0)
      expect(bucketIds.indexOf(epoch1MarkerId)).toBeGreaterThan(bucketIds.indexOf(epoch0MarkerId))

      // UI: the frozen marker row offers NO affordance; the current-epoch one does.
      const frozenRow = section().locator('div.flex.items-start', { has: page.getByText('prompt three', { exact: true }) })
      const currentRow = section().locator('div.flex.items-start', { has: page.getByText('prompt three edited', { exact: true }) })
      await expect(currentRow.getByRole('button', { name: 'Redo to here' })).toHaveCount(1, { timeout: 15_000 })
      await expect(frozenRow.getByRole('button', { name: 'Redo to here' })).toHaveCount(0)
      await expect(section().getByRole('button', { name: 'Redo to here' })).toHaveCount(1)
    } finally {
      await lane.server.stop().catch(() => {})
      await fs.rm(lane.sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })

  test('opencode: undo-to-here via the per-turn icon is ONE revert (decision 3)', async ({ page, e2eServerKind }) => {
    expect(e2eServerKind).toBe('rust')
    const lane = await bootOpencodeLane(page)
    try {
      await waitForPaneStatus(lane.harness, lane.tabId, 'idle')
      const sessionId = await sendOpencodeTurn(page, lane.harness, lane.tabId, 'prompt one', 1, lane.auditLogPath)
      await sendOpencodeTurn(page, lane.harness, lane.tabId, 'prompt two', 2, lane.auditLogPath)
      await sendOpencodeTurn(page, lane.harness, lane.tabId, 'prompt three', 3, lane.auditLogPath)
      const snap = (): Promise<any | null> => fetchSnapshot(lane.info, 'freshopencode', 'opencode', sessionId)
      expect(userRows(await snap())).toBe(3)
      // The icon's toTurn target is the second user message's id — pulled from
      // the snapshot, never assumed from the fake's id scheme.
      const secondUserTurnId = ((await snap())?.turns ?? [])
        .filter((t: any) => t.role === 'user')[1]?.turnId
      expect(typeof secondUserTurnId).toBe('string')

      // The real UI gesture (hover toolbar idiom): hover the second user
      // turn's article, click "Undo to here" inside "Turn actions".
      const paneRoot = page.locator('[data-context="fresh-agent"]').last()
      const secondUserArticle = paneRoot.locator('article[data-turn-role="user"]', { hasText: 'prompt two' })
      await secondUserArticle.hover()
      await secondUserArticle.getByRole('button', { name: 'Undo to here' }).click()

      await expect.poll(async () => userRows(await snap()), { timeout: 15_000 }).toBe(1)
      const reverted = readOpencodeAudit(lane.auditLogPath).filter((e) => e.event === 'reverted')
      expect(reverted, 'exactly ONE revert — never N round trips').toHaveLength(1)
      expect(reverted[0].messageID).toBe(secondUserTurnId)
    } finally {
      await lane.server.stop().catch(() => {})
      await fs.rm(lane.sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })

  test('codex: undo-to-here reverts in place; /redo is refused with the codex copy', async ({ page, e2eServerKind }) => {
    expect(e2eServerKind).toBe('rust')
    const lane = await bootCodexLane(page)
    try {
      await waitForPaneStatus(lane.harness, lane.tabId, 'idle')
      await sendCodexTurnAndWaitRows(page, 2, 'codex turn one')
      await sendCodexTurnAndWaitRows(page, 4, 'codex turn two')
      const snap = (): Promise<any | null> => fetchSnapshot(lane.info, 'freshcodex', 'codex', 'thread-new-1')
      expect(userRows(await snap())).toBe(2)

      // Undo-to-here on the FIRST user turn (empty-prefix revert is legal on
      // codex): one thread/read + one thread/revert, never thread/rollback.
      const paneRoot = page.locator('[data-context="fresh-agent"]').last()
      const firstUserArticle = paneRoot.locator('article[data-turn-role="user"]', { hasText: 'codex turn one' })
      await firstUserArticle.hover()
      await firstUserArticle.getByRole('button', { name: 'Undo to here' }).click()

      await expect.poll(async () => userRows(await snap()), { timeout: 15_000 }).toBe(0)
      const ops = readJsonl(lane.opLogPath).filter((o) => typeof o?.method === 'string' && o.method.startsWith('thread/'))
      expect(ops.map((o) => o.method)).toEqual(
        expect.arrayContaining(['thread/read', 'thread/revert']),
      )
      const reverts = ops.filter((o) => o.method === 'thread/revert')
      expect(reverts).toHaveLength(1)
      expect(reverts[0].params?.beforeTurnId).toBeTruthy()
      expect(ops.map((o) => o.method)).not.toContain('thread/rollback') // deprecated path never used

      // Typed /redo never reaches the wire: the composer's reserved-name
      // interception answers with the pinned codex undo-only copy.
      await typeSlash(page, '/redo')
      await expect(
        page.getByText(/Redo is not available for Codex sessions/),
        'the REDO_CODEX_UNSUPPORTED_NOTICE prefix renders on the notice banner',
      ).toBeVisible({ timeout: 15_000 })
      expect(userRows(await snap())).toBe(0) // transcript unchanged

      // The pinned-notice path never touches the provider: after the notice
      // poll + the REST round trip above (a timed, failure-observable window —
      // the interception is synchronous client-side), re-read the recording
      // surfaces. The op log must still hold exactly ONE thread/revert for the
      // pane's thread (an escaped /redo issuing a second revert would leave
      // the prefix already empty, so the zero-row assertion alone could not
      // catch it), and the recorded-turns store must hold NO turn carrying the
      // typed text (a leaked freshAgent.send lands there via turn/start —
      // turn/start is never op-logged).
      const paneThreadReverts = readJsonl(lane.opLogPath)
        .filter((o) => o?.method === 'thread/revert' && o?.threadId === 'thread-new-1')
      expect(
        paneThreadReverts,
        'still exactly ONE thread/revert on the pane thread after the typed /redo — the pinned notice issued no provider-side rollback',
      ).toHaveLength(1)
      const recordedTurnsAfterRedo = await readRecordedCodexTurns(lane.info.homeDir, 'thread-new-1')
      expect(
        recordedTurnsAfterRedo.some((turn) =>
          (turn?.items ?? []).some(
            (item: any) => item?.type === 'userMessage'
              && (item?.content ?? []).some(
                (part: any) => typeof part?.text === 'string' && part.text.includes('/redo'),
              ),
          ),
        ),
        'no freshAgent.send (turn/start) carried the typed /redo to the codex provider',
      ).toBe(false)
    } finally {
      await lane.server.stop().catch(() => {})
      await fs.rm(lane.sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })

  test('claude: /undo fork-at-point re-keys the pane and refills — and never touches checkpoints (decision 1)', async ({ page, e2eServerKind }) => {
    expect(e2eServerKind).toBe('rust')
    const lane = await bootClaudeLane(page, 'freshclaude')
    try {
      await waitForPaneStatus(lane.harness, lane.tabId, 'idle')
      const checkpointRestores: string[] = []
      page.on('request', (request) => {
        if (request.url().includes('/checkpoints/restore')) checkpointRestores.push(request.url())
      })
      await sendComposerText(page, 'prompt one')
      const ORIG = await captureDurableId(lane.harness, lane.tabId, CANONICAL_UUID_RE)
      await expect
        .poll(async () => userRows(await fetchSnapshot(lane.info, 'freshclaude', 'claude', ORIG)), { timeout: 15_000 })
        .toBe(1)
      await sendComposerText(page, 'prompt two')
      await expect
        .poll(async () => userRows(await fetchSnapshot(lane.info, 'freshclaude', 'claude', ORIG)), { timeout: 15_000 })
        .toBe(2)
      await waitForPaneStatus(lane.harness, lane.tabId, 'idle')
      await waitForRollbackCapability(page)

      await typeSlash(page, '/undo')

      // The pane re-keys: fork-at-point adopts a MINTED-FRESH durable id (the
      // s2rk correction) via the materialized-adoption leg.
      await expect
        .poll(
          async () => (await paneLeaf(lane.harness, lane.tabId))?.content?.sessionRef?.sessionId ?? '',
          { timeout: 30_000 },
        )
        .not.toBe(ORIG)
      const CHILD = (await paneLeaf(lane.harness, lane.tabId))?.content?.sessionRef?.sessionId as string
      expect(CHILD).toMatch(CANONICAL_UUID_RE)
      await expect
        .poll(() => composerLocator(page).inputValue(), { timeout: 15_000 })
        .toBe('prompt two')

      // Exactly ONE fork-at-point create: forkSession:true + resumeSessionId
      // ORIG + a resumeSessionAt the raw-chain resume point (the sidecar's
      // guard validated — no guard-refusal retry would land a second create).
      const forks = readStdinFrames(lane.stdinLog)
        .filter((f) => f?.type === 'create' && f?.forkSession === true)
      expect(forks).toHaveLength(1)
      expect(forks[0].resumeSessionId).toBe(ORIG)
      expect(typeof forks[0].resumeSessionAt).toBe('string')
      // The wire log's sdk.session.init for the fork carries the NEW id.
      const wires = readJsonl(lane.eventsLog).filter((r) => r.kind === 'wire')
      expect(
        wires.some((r) => r.frame?.type === 'sdk.session.init' && r.frame?.cliSessionId === CHILD),
        'sdk.session.init carries the fresh-minted cliSessionId (never ORIG)',
      ).toBe(true)

      // The adopted snapshot shows the prefix + the marker bucket + redo.
      const childSnap = await fetchSnapshot(lane.info, 'freshclaude', 'claude', CHILD)
      expect(userRows(childSnap)).toBe(1)
      expect(childSnap?.rollback?.canRedo).toBe(true)
      expect(childSnap?.rolledBackTurns ?? []).toHaveLength(2)

      // The client snapshot caught up (the gate for typed /redo consults its
      // rollback.canRedo — the marker section render proves the same stamp).
      await expect(page.getByText(/Rolled back \(1\)/)).toBeVisible({ timeout: 15_000 })

      // /redo re-forks from the retained ORIGINAL (the tip/LCP contract) and
      // the transcript restores to two user rows.
      await typeSlash(page, '/redo')
      await expect
        .poll(
          async () => (await paneLeaf(lane.harness, lane.tabId))?.content?.sessionRef?.sessionId ?? '',
          { timeout: 30_000 },
        )
        .not.toBe(CHILD)
      const REDONE = (await paneLeaf(lane.harness, lane.tabId))?.content?.sessionRef?.sessionId as string
      await expect
        .poll(async () => userRows(await fetchSnapshot(lane.info, 'freshclaude', 'claude', REDONE)), { timeout: 15_000 })
        .toBe(2)
      const reforks = readStdinFrames(lane.stdinLog)
        .filter((f) => f?.type === 'create' && f?.forkSession === true)
      expect(reforks.length).toBe(2)
      expect(reforks[1].resumeSessionId).toBe(ORIG)

      // Rollback never touches files: ZERO checkpoint-restore traffic.
      expect(checkpointRestores).toEqual([])
    } finally {
      await lane.server.stop().catch(() => {})
      await fs.rm(lane.sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })

  test('kilroy: typed /undo drives the claude lane — fork-at-point fork, pane re-key, refill, marker (r2 provider coverage)', async ({ page, e2eServerKind }) => {
    expect(e2eServerKind).toBe('rust')
    const lane = await bootClaudeLane(page, 'kilroy', { KILROY_ENABLED: '1' })
    try {
      await waitForPaneStatus(lane.harness, lane.tabId, 'idle')
      await sendComposerText(page, 'prompt one')
      const ORIG = await captureDurableId(lane.harness, lane.tabId, CANONICAL_UUID_RE)
      await expect
        .poll(async () => userRows(await fetchSnapshot(lane.info, 'kilroy', 'claude', ORIG)), { timeout: 15_000 })
        .toBe(1)
      await sendComposerText(page, 'prompt two')
      await expect
        .poll(async () => userRows(await fetchSnapshot(lane.info, 'kilroy', 'claude', ORIG)), { timeout: 15_000 })
        .toBe(2)
      await waitForPaneStatus(lane.harness, lane.tabId, 'idle')
      await waitForRollbackCapability(page)

      await typeSlash(page, '/undo')

      await expect
        .poll(
          async () => (await paneLeaf(lane.harness, lane.tabId))?.content?.sessionRef?.sessionId ?? '',
          { timeout: 30_000 },
        )
        .not.toBe(ORIG)
      const CHILD = (await paneLeaf(lane.harness, lane.tabId))?.content?.sessionRef?.sessionId as string
      expect(CHILD).toMatch(CANONICAL_UUID_RE)
      const forks = readStdinFrames(lane.stdinLog)
        .filter((f) => f?.type === 'create' && f?.forkSession === true)
      expect(forks).toHaveLength(1)
      expect(forks[0].resumeSessionId).toBe(ORIG)
      expect(typeof forks[0].resumeSessionAt).toBe('string')
      await expect
        .poll(() => composerLocator(page).inputValue(), { timeout: 15_000 })
        .toBe('prompt two')
      const childSnap = await fetchSnapshot(lane.info, 'kilroy', 'claude', CHILD)
      expect(userRows(childSnap)).toBe(1)
      expect(childSnap?.rolledBackTurns ?? []).toHaveLength(2)
      expect((childSnap?.rolledBackTurns ?? []).every((t: any) => t.rolledBack === true)).toBe(true)
    } finally {
      await lane.server.stop().catch(() => {})
      await fs.rm(lane.sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })

  test('multi-client convergence: sibling raw-WS client + REST see the same post-rollback truth (decision 10)', async ({ page, e2eServerKind }) => {
    expect(e2eServerKind).toBe('rust')
    const lane = await bootOpencodeLane(page)
    try {
      await waitForPaneStatus(lane.harness, lane.tabId, 'idle')
      await sendOpencodeTurn(page, lane.harness, lane.tabId, 'prompt one', 1, lane.auditLogPath)
      const sessionId = await sendOpencodeTurn(page, lane.harness, lane.tabId, 'prompt two', 2, lane.auditLogPath)
      const snap = (): Promise<any | null> => fetchSnapshot(lane.info, 'freshopencode', 'opencode', sessionId)

      // The sibling raw-WS client connects BEFORE the rollback, so the
      // broadcast is observed live (never backfilled).
      const wsUrl = `${lane.info.baseUrl.replace(/^http/, 'ws')}/ws`
      const sibling = new WsCapture(wsUrl, lane.info.token)
      await sibling.ready()
      try {
        await waitForRollbackCapability(page)
        await typeSlash(page, '/undo')

        const rolledBack = await sibling.waitFor(
          (f) => f.type === 'freshAgent.event' && f.event?.type === 'freshAgent.session.rolledBack',
          15_000,
          'freshAgent.session.rolledBack broadcast',
        )
        expect(rolledBack.sessionId).toBe(sessionId)
        expect(rolledBack.event.revokeAttention).toBe(true)
        expect(rolledBack.event.canRedo).toBe(true)

        // REST (another client's truth) reads identically to the driving pane.
        await expect.poll(async () => userRows(await snap()), { timeout: 15_000 }).toBe(1)
        const viaRest = await snap()
        const restUserMarkerIds = ((viaRest.rolledBackTurns ?? []) as any[])
          .filter((t) => t.role === 'user')
          .map((t) => t.turnId)
        expect(viaRest.rollback).toEqual({ canRedo: true, undoneDepth: 1, redoableTurnIds: restUserMarkerIds })
        expect(restUserMarkerIds).toHaveLength(1)
        expect(viaRest.rolledBackTurns).toHaveLength(2)
      } finally {
        sibling.close()
      }

      // A reload re-attaches and re-fetches: the same assertions hold (the
      // durable rollback record survives refresh — markers + redo availability).
      await page.reload({ waitUntil: 'domcontentloaded' })
      const harness2 = new TestHarness(page)
      await harness2.waitForHarness()
      await harness2.waitForConnection()
      const paneRoot = page.locator('[data-context="fresh-agent"]').last()
      await expect(paneRoot.locator('article[data-turn-role="user"]')).toHaveCount(1, { timeout: 30_000 })
      await expect(page.getByText(/Rolled back \(1\)/)).toBeVisible({ timeout: 15_000 })
      const afterReload = await snap()
      expect(userRows(afterReload)).toBe(1)
      const reloadedUserMarkerIds = ((afterReload.rolledBackTurns ?? []) as any[])
        .filter((t) => t.role === 'user')
        .map((t) => t.turnId)
      expect(afterReload.rollback).toEqual({ canRedo: true, undoneDepth: 1, redoableTurnIds: reloadedUserMarkerIds })
      expect(afterReload.rolledBackTurns).toHaveLength(2)
    } finally {
      await lane.server.stop().catch(() => {})
      await fs.rm(lane.sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })

  test('mid-turn lockout: /undo is rejected while a turn runs; cards survive (decisions 6, 7)', async ({ page, e2eServerKind }) => {
    expect(e2eServerKind).toBe('rust')
    const lane = await bootClaudeLane(page, 'freshclaude')
    try {
      await waitForPaneStatus(lane.harness, lane.tabId, 'idle')
      await sendComposerText(page, 'RAISE_PERMISSION')
      const card = page.getByRole('alert', { name: 'Permission request for Bash' })
      await expect(card).toBeVisible({ timeout: 15_000 })
      const ORIG = await captureDurableId(lane.harness, lane.tabId, CANONICAL_UUID_RE)
      await expect
        .poll(async () => userRows(await fetchSnapshot(lane.info, 'freshclaude', 'claude', ORIG)), { timeout: 15_000 })
        .toBe(1)
      await waitForRollbackCapability(page)

      // Mid-turn /undo: the client busy gate answers with the pinned steer
      // copy — no rollback frame ever leaves the client.
      await typeSlash(page, '/undo')
      await expect(
        page.getByText(/queue a message to steer it/),
        'the pinned busy copy renders on the notice banner',
      ).toBeVisible({ timeout: 15_000 })
      // Transcript unchanged; the parked card is NEVER silently resolved
      // (cancel frames fire only on a SUCCESSFUL rollback).
      expect(userRows(await fetchSnapshot(lane.info, 'freshclaude', 'claude', ORIG))).toBe(1)
      await expect(card).toBeVisible()
      expect(
        readStdinFrames(lane.stdinLog).filter((f) => f?.type === 'create' && f?.forkSession === true),
        'no fork-at-point create ever left the client for the refused /undo',
      ).toEqual([])

      // Resolve the approval — the turn completes, then /undo succeeds.
      await card.getByRole('button', { name: 'Allow tool use' }).click()
      await waitForStdinFrame(lane.stdinLog, (f) => f?.type === 'permission.respond', 'permission.respond')
      await expect(card).toBeHidden({ timeout: 15_000 })
      await waitForPaneStatus(lane.harness, lane.tabId, 'idle')
      await typeSlash(page, '/undo')
      await expect(
        page.getByText(/the removed prompt is back in the composer/),
        'UNDO_REFILL_NOTICE: the post-turn /undo succeeds',
      ).toBeVisible({ timeout: 15_000 })
      // The tail /undo provably rolled back through EXACTLY ONE create event
      // for the session: the busy window was proven window-silent above, so a
      // frame leaked there plus the tail's legitimate rollback create would
      // surface as TWO — as would a silent second create from the guard-retry
      // or adoption seams (every attempt mints a fresh "rollback-<uuid>"
      // requestId and lands on the raw-stdin audit BEFORE its `created`
      // response, so the row is on disk before the ack that refills the
      // composer). NOTE: this tail is a FIRST-TURN rollback — the resume point
      // resolves to None (claude_snapshot.rs), so the rollback create is a
      // FRESH-conversation create carrying NO resumeSessionId/forkSession keys;
      // counting forkSession:true frames here would count ZERO by design.
      const isRollbackCreate = (f: any) =>
        f?.type === 'create' && typeof f?.requestId === 'string' && (f.requestId as string).startsWith('rollback-')
      await waitForStdinFrame(lane.stdinLog, isRollbackCreate, 'the tail /undo rollback create')
      const rollbackCreates = readStdinFrames(lane.stdinLog).filter(isRollbackCreate)
      expect(
        rollbackCreates,
        'exactly ONE rollback create for the session — no second silent create from any retry/adoption race',
      ).toHaveLength(1)
    } finally {
      await lane.server.stop().catch(() => {})
      await fs.rm(lane.sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })
})
