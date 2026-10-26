/**
 * FRESH-AGENT CONTROL SURFACES — PW-RUST e2e validation (AGENT-04/05/06/07/24).
 *
 * Drives the REAL Rust server + real browser UI against the production Claude
 * sidecar over the CLI simulator, plus the existing Codex/OpenCode fixtures,
 * and pins the control surfaces end-to-end:
 *
 *   AGENT-05 (approval responses + cancellation): Allow/Deny clicks must
 *     Allow/Deny clicks reach the simulated CLI's real canUseTool callback —
 *     and provably no decision exists before the click; reload-while-pending
 *     restores exactly one card from the REST snapshot overlay; composer Stop
 *     cancels without inventing a user decision.
 *   AGENT-06 (question responses): single-choice / multi-select / Other
 *     answers land in `question.respond` keyed by QUESTION TEXT, and the turn
 *     continues.
 *   AGENT-04 (compact): claude/kilroy write `/compact [instructions]` as a
 *     sidecar send on the SAME session (durable id unchanged, context
 *     retained); codex issues `thread/compact/start` (NO turn/start); opencode
 *     POSTs `/session/:id/summarize {providerID,modelID}`.
 *   AGENT-07 (fork): codex `thread/fork` (+lastTurnId checkpoint divergence,
 *     `:row-N` ids normalized to raw turn ids) and opencode
 *     `/session/:id/fork` ({messageID}); per lane: (a) source unchanged after
 *     fork + parent kill, (b) the child's history stops at the fork point,
 *     (c) the child is durable across reload AND a server restart.
 *   AGENT-24 (kilroy parity): full lifecycle (KILROY_ENABLED=1 gate), a crash
 *     mid-turn in a background tab (one server ring, the highlight, then
 *     Resume with no reload), a second crash recovered by a page reload, and
 *     restart recovery, all on the SAME durable id, never a fabricated
 *     completion.
 *   Plus the capability-gate pin: /fork IS offered for claude (snapshot
 *     capabilities.fork=true since C14; the fork itself is pinned end to end
 *     by freshclaude-fork-rust.spec.ts).
 *
 * Donors (helpers copied, not imported, per this suite's per-spec-ownership
 * convention): freshclaude-identity-persistence-rust.spec.ts (boot/identity
 * plumbing), freshagent-settings-resume-rust.spec.ts (CODEX_CMD/OPENCODE_CMD
 * boot lanes), agent-checkpoint-rewind.spec.ts (turn-action hover idiom).
 */
import fs from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'
import WebSocket from 'ws'
import { test, expect } from '../helpers/fixtures.js'
import {
  RustServer,
  GEMINI_STRIP_ENV_PREFIXES,
} from '../helpers/rust-server.js'
import type { E2eServerInfo } from '../helpers/server-fixture-support.js';
import { TestHarness } from '../helpers/test-harness.js'
import { openPanePicker } from '../helpers/pane-picker.js'
import { WS_PROTOCOL_VERSION } from '../../../shared/ws-version.js'
import { claudeSimulatorServerEnv, readClaudeSimLedger } from '../helpers/claude-sim-lane.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const CODEX_APP_SERVER_FIXTURE = path.resolve(
  __dirname,
  '../../fixtures/coding-cli/codex-app-server/fake-app-server.mjs',
)
const OPENCODE_FIXTURE = path.resolve(__dirname, '../fixtures/fake-opencode.cjs')

const CANONICAL_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

// ── Simulator program (the shared Claude/Kilroy lane) ───────────────────────
// Text-driven permission and question requests. The simulator's real
// canUseTool callback handles the user's answer; its local /compact command
// and process-death behavior supply the remaining lifecycle events.
const CLAUDE_PROGRAM = {
  rules: [
    {
      on: 'msg:prompt',
      match: { text: 'RAISE_PERMISSION' },
      emit: [
        { kind: 'approval', data: { id: 'req-perm-1', tool: 'Bash', input: { command: 'ls' } } },
      ],
    },
    {
      on: 'msg:prompt',
      match: { text: 'RAISE_QUESTION' },
      emit: [
        {
          kind: 'question',
          data: {
            id: 'req-q-1',
            questions: [
              {
                question: 'Pick one',
                header: 'Fixture',
                options: [
                  { label: 'A', description: 'alpha' },
                  { label: 'B', description: 'beta' },
                ],
                multiSelect: false,
              },
            ],
          },
        },
      ],
    },
    {
      on: 'msg:prompt',
      match: { text: 'RAISE_QUESTION_MULTI' },
      emit: [
        {
          kind: 'question',
          data: {
            id: 'req-qm-1',
            questions: [
              {
                question: 'Pick any two',
                header: 'Fixture',
                options: [
                  { label: 'A', description: 'alpha' },
                  { label: 'B', description: 'beta' },
                  { label: 'C', description: 'gamma' },
                ],
                multiSelect: true,
              },
            ],
          },
        },
      ],
    },
    {
      on: 'msg:prompt',
      match: { text: 'RAISE_QUESTION_OTHER' },
      emit: [
        {
          kind: 'question',
          data: {
            id: 'req-qo-1',
            questions: [
              {
                question: 'Free text',
                header: 'Fixture',
                options: [{ label: 'A', description: 'alpha' }],
                multiSelect: false,
              },
            ],
          },
        },
      ],
    },
    {
      // The 3s delay is the window in which the crash lane moves the user to
      // another tab, so the crash ends a turn nobody is watching.
      on: 'msg:prompt',
      match: { text: 'CRASH_NOW' },
      emit: [{ kind: 'crash', delayMs: 3_000, data: { code: 1 } }],
    },
  ],
}

// ── Copied helpers (donor: freshclaude-identity-persistence-rust.spec.ts) ────

/**
 * Raw node-side WS client with a real hello handshake — used to drive the
 * EXACT `freshAgent.attach` a rehydrating pane would send for a session id
 * (AGENT-07's source-durability probe: the forked pane rides the child, so
 * the SOURCE session's resume attach is driven here instead).
 * (donor: freshagent-settings-resume-rust.spec.ts's WsCapture.)
 */
class WsCapture {
  private ws: WebSocket
  readonly frames: any[] = []
  private opened: Promise<void>

  constructor(baseUrl: string, token: string) {
    const wsUrl = `${baseUrl.replace(/^http/, 'ws')}/ws`
    this.ws = new WebSocket(wsUrl)
    this.opened = new Promise((resolve, reject) => {
      this.ws.on('open', () => {
        this.ws.send(JSON.stringify({ type: 'hello', protocolVersion: WS_PROTOCOL_VERSION, token }))
        resolve()
      })
      this.ws.on('error', reject)
    })
    this.ws.on('message', (data) => {
      try {
        this.frames.push(JSON.parse(String(data)))
      } catch {
        // non-JSON frames are not part of this protocol; ignore
      }
    })
  }

  async ready(): Promise<void> {
    await this.opened
    await this.waitFor((f) => f.type === 'ready', 10_000, 'ready')
  }

  async waitFor(pred: (frame: any) => boolean, timeoutMs: number, label: string): Promise<any> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const hit = this.frames.find(pred)
      if (hit) return hit
      await new Promise((r) => setTimeout(r, 100))
    }
    throw new Error(`WsCapture: timed out waiting for ${label}`)
  }

  send(frame: unknown): void {
    this.ws.send(JSON.stringify(frame))
  }

  close(): void {
    try {
      this.ws.close()
    } catch {
      // already closed
    }
  }
}

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

async function waitForWsReady(page: Page, timeoutMs = 60_000): Promise<void> {
  await expect(async () => {
    const status = await page.evaluate(
      () => (window as any).__FRESHELL_TEST_HARNESS__?.getWsReadyState(),
    )
    expect(status).toBe('ready')
  }).toPass({ timeout: timeoutMs })
}

async function flushPersistence(page: Page): Promise<void> {
  await page.evaluate(() => {
    ;(window as any).__FRESHELL_TEST_HARNESS__?.dispatch({ type: 'persist/flushNow' })
  })
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
): Promise<{ server: RustServer; info: E2eServerInfo; harness: TestHarness }> {
  const server = new RustServer({
    env: options.env,
    stripEnvPrefixes: options.stripEnvPrefixes,
    setupHome: options.setupHome,
    verbose: process.env.FRESHELL_E2E_SERVER_VERBOSE === '1',
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

async function waitForLogEntry(
  logPath: string,
  pred: (row: any) => boolean,
  what: string,
  timeoutMs = 15_000,
): Promise<any> {
  let found: any = null
  await expect
    .poll(
      () => {
        found = readJsonl(logPath).find(pred) ?? null
        return Boolean(found)
      },
      { timeout: timeoutMs, message: `timed out waiting for ${what} in ${logPath}` },
    )
    .toBe(true)
  return found
}

async function waitForSimRow(
  simLedger: string,
  pred: (row: any) => boolean,
  what: string,
  timeoutMs = 15_000,
): Promise<any> {
  let found: any = null
  await expect
    .poll(
      () => {
        found = readClaudeSimLedger(simLedger).find(pred) ?? null
        return Boolean(found)
      },
      { timeout: timeoutMs, message: `timed out waiting for ${what} in ${simLedger}` },
    )
    .toBe(true)
  return found
}

/** Direct REST snapshot read — the route every card renders from. */
async function fetchSnapshot(
  info: E2eServerInfo,
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
    ...claudeSimulatorServerEnv({
      ledgerPath: path.join(sharedRoot, 'claude-sim-ledger.jsonl'),
      flavour,
      program: CLAUDE_PROGRAM,
    }),
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
  info: E2eServerInfo
  harness: TestHarness
  sharedRoot: string
  projectDir: string
  simLedger: string
  tabId: string
}> {
  const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), `freshell-agentctl-${flavour}-`))
  try {
    const projectDir = path.join(sharedRoot, 'project')
    await fs.mkdir(projectDir, { recursive: true })
    const { server, info, harness } = await bootWall(page, {
      env: claudeLaneEnv(sharedRoot, flavour, extraEnv),
      // AGENT-24 (task-008-review M-3, hardened in delta review round 4):
      // kilroy parity includes independence from Gemini-summary availability
      // — made STRUCTURAL: every env name that could give the spawned server
      // Gemini access (GOOGLE_GENERATIVE_AI_API_KEY — what main.rs actually
      // consumes, env winning over settings.ai.geminiApiKey — plus
      // GEMINI_API_KEY, the FRESHELL_GEMINI_BASE_URL test seam, and any other
      // GEMINI_* var a developer shell carries) is scrubbed from its env via
      // the one shared list (unit-pinned in helpers/rust-server.test.ts), so
      // the lifecycle provably passes with no Gemini credentials available.
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
      simLedger: path.join(sharedRoot, 'claude-sim-ledger.jsonl'),
      tabId,
    }
  } catch (error) {
    await fs.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

/** Raise the scripted Bash permission and wait until its card is up, proving
 * no decision reached the CLI before the user's click. */
async function raisePermissionAndAssertNoDecisions(
  page: Page,
  harness: TestHarness,
  tabId: string,
  simLedger: string,
): Promise<void> {
  // Claude's REST create default is bypassPermissions unless the user saved a
  // provider default. This scenario exercises canUseTool, so choose the
  // product's asking mode explicitly instead of relying on that saved default.
  await page.getByRole('button', { name: 'Agent settings', exact: true }).click()
  await page.getByRole('combobox', { name: 'Permission mode' }).selectOption('default')
  await page.keyboard.press('Escape')
  await expect.poll(async () => (await paneLeaf(harness, tabId))?.content?.permissionMode ?? null)
    .toBe('default')
  await waitForSimRow(
    simLedger,
    (row) => row.kind === 'control' && row.name === 'setPermissionMode' && row.args?.[0] === 'default',
    'the CLI asking permission mode',
  )

  await sendComposerText(page, 'RAISE_PERMISSION')
  const raiseSend = (await harness.getSentWsMessages() as any[]).find(
    (message) => message?.type === 'freshAgent.send' && message?.text === 'RAISE_PERMISSION',
  )
  expect(raiseSend?.settings?.permissionMode, 'the approval send carries the asking mode').toBe('default')
  const card = page.getByRole('alert', { name: 'Permission request for Bash' })
  try {
    await expect(card).toBeVisible({ timeout: 15_000 })
  } catch (error) {
    const rows = readClaudeSimLedger(simLedger)
    const received = (await harness.getReceivedWsMessages()) as any[]
    const diagnostic = {
      severity: 'error',
      event: 'e2e.claude_approval_card_diagnostic',
      queryPermissionModes: rows.filter((row) => row.kind === 'query')
        .map((row) => row.options?.permissionMode ?? null),
      promptPermissionModes: rows.filter((row) => row.kind === 'prompt')
        .map((row) => row.permissionMode ?? null),
      approvalEmissionCount: rows.filter((row) => row.kind === 'approval').length,
      canUseToolOutcomes: rows.filter((row) => row.kind === 'can_use_tool')
        .map((row) => ({ toolName: row.toolName, behavior: row.decision?.behavior, rejected: Boolean(row.error) })),
      receivedFreshAgentEvents: received
        .filter((message) => message?.type === 'freshAgent.event')
        .map((message) => ({ type: message.event?.type, code: message.event?.code }))
        .slice(-30),
    }
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${JSON.stringify(diagnostic)}`)
  }
  // AGENT-05 pause-proof: the CLI has received zero decisions — the card came
  // from the snapshot overlay, not from any fabricated user choice.
  expect(
    readClaudeSimLedger(simLedger).filter((row) => row.kind === 'can_use_tool'),
    'no canUseTool decision may exist before a user click',
  ).toEqual([])
  // And the raise is pending server-side too (the REST snapshot overlay the
  // card renders from carries exactly one pending approval).
  const leaf = await paneLeaf(harness, tabId)
  const durable = leaf?.content?.sessionRef?.sessionId
  expect(durable, 'sessionRef must be known before raise').toBeTruthy()
}

// ─────────────────────────────────────────────────────────────────────────────
// AGENT-05/06/04 — claude lane
// ─────────────────────────────────────────────────────────────────────────────

test.describe('fresh-agent control surfaces — claude lane (rust)', () => {
  test.setTimeout(180_000)

  test('approval: Allow reaches the simulated CLI only after the click', async ({ page }) => {
    const lane = await bootClaudeLane(page, 'freshclaude')
    try {
      await waitForPaneStatus(lane.harness, lane.tabId, ['connected', 'idle'])
      await raisePermissionAndAssertNoDecisions(page, lane.harness, lane.tabId, lane.simLedger)

      const card = page.getByRole('alert', { name: 'Permission request for Bash' })
      await card.getByRole('button', { name: 'Allow tool use' }).click()

      // The production sidecar resolves its parked canUseTool callback with
      // the user's decision; the simulator ledger records that actual result.
      const response = await waitForSimRow(
        lane.simLedger,
        (row) => row.kind === 'can_use_tool' && row.toolName === 'Bash',
        'the CLI permission decision',
      )
      expect(response.decision).toEqual({ behavior: 'allow' })

      // The scripted continuation completes the turn; the card clears.
      await expect(card).toBeHidden({ timeout: 15_000 })
      await waitForPaneStatus(lane.harness, lane.tabId, 'idle')
    } finally {
      await lane.server.stop().catch(() => {})
      await fs.rm(lane.sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })

  test('approval: Deny reaches the CLI, rings the unified attention edge, and leaves the pane usable', async ({ page }) => {
    const lane = await bootClaudeLane(page, 'freshclaude')
    try {
      await waitForPaneStatus(lane.harness, lane.tabId, ['connected', 'idle'])
      await raisePermissionAndAssertNoDecisions(page, lane.harness, lane.tabId, lane.simLedger)

      const card = page.getByRole('alert', { name: 'Permission request for Bash' })

      // The raise's waiting edge (freshAgent.turn.waiting — the 0→≥1 pending
      // transition) is the FIRST turnCompletion event (seq 1). Capture it
      // BEFORE the deny so the deny's own edge is pinned as an exact delta.
      await expect
        .poll(
          async () => (await lane.harness.getState())?.turnCompletion?.seq ?? 0,
          { timeout: 15_000, message: 'the waiting edge folds as seq 1 while the card is up' },
        )
        .toBe(1)

      await card.getByRole('button', { name: 'Deny tool use' }).click()

      const response = await waitForSimRow(
        lane.simLedger,
        (row) => row.kind === 'can_use_tool' && row.toolName === 'Bash',
        'the CLI permission decision',
      )
      expect(response.decision).toMatchObject({ behavior: 'deny', message: 'Denied by user' })

      // A denied tool result returns control to the simulated model, which
      // completes its response just as the real CLI can.
      await expect(card).toBeHidden({ timeout: 15_000 })
      await waitForPaneStatus(lane.harness, lane.tabId, 'idle')
      const deniedBridgeId = (await paneLeaf(lane.harness, lane.tabId))?.content?.sessionId as string
      expect(deniedBridgeId).toBeTruthy()

      // BROWSER-FACING contract: the server's edge for the denied result
      // folded in the browser as EXACTLY ONE new turnCompletion event
      // (seq 1 → 2), recorded under the bare completion namespace (distinct
      // from the waiting edge's `#waiting` bucket). The user is WATCHING
      // this pane — they clicked Deny — so the unified client partition
      // renders the tab-strip mark ONLY: the watched mark is set and no
      // unwitnessed attention flags exist (no bell, no sidebar row, no
      // pane-header mark from THIS ending).
      await expect
        .poll(
          async () => (await lane.harness.getState())?.turnCompletion?.seq ?? 0,
          { timeout: 15_000, message: 'the deny edge folds as exactly one new event (seq 2)' },
        )
        .toBe(2)
      const deniedState = await lane.harness.getState()
      expect(
        deniedState?.turnCompletion?.lastAtByTerminalId?.[`claude:${deniedBridgeId}`],
        'the deny edge folded in the completion namespace',
      ).toBeGreaterThan(0)
      expect(
        deniedState?.turnCompletion?.watchedCompletionByTab?.[lane.tabId],
        'the watched deny sets the tab-strip-only watched mark',
      ).toBe(true)
      expect(
        deniedState?.turnCompletion?.attentionByTab?.[lane.tabId],
        'a watched deny creates no unwitnessed tab attention',
      ).toBeUndefined()
      expect(
        Object.keys(deniedState?.turnCompletion?.attentionByPane ?? {}),
        'a watched deny creates no pane-header attention mark',
      ).toEqual([])
      const deniedTab = page.locator(`[data-context="tab"][data-tab-id="${lane.tabId}"]`)
      await expect(deniedTab, 'the active tab renders the watched top-line mark').toHaveClass(/border-t-success/)
      await expect(deniedTab, 'the watched mark never shades an active tab like a background alert').not.toHaveClass(/bg-emerald-100/)

      // Prompt-usable again: a plain follow-up send completes normally.
      await sendComposerText(page, 'follow-up after deny')
      await waitForPaneStatus(lane.harness, lane.tabId, 'idle')
      await waitForSimRow(
        lane.simLedger,
        (row) => row.kind === 'prompt' && row.text === 'follow-up after deny',
        'the follow-up prompt',
      )
    } finally {
      await lane.server.stop().catch(() => {})
      await fs.rm(lane.sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })

  test('approval: survives page reload mid-pending (exactly one restored card), Allow still works', async ({ page }) => {
    const lane = await bootClaudeLane(page, 'freshclaude')
    try {
      await waitForPaneStatus(lane.harness, lane.tabId, ['connected', 'idle'])
      const durableBefore = await captureDurableId(lane.harness, lane.tabId, CANONICAL_UUID_RE)
      await raisePermissionAndAssertNoDecisions(page, lane.harness, lane.tabId, lane.simLedger)

      // RELOAD while the permission is pending. The card must come back from
      // the REST snapshot overlay as EXACTLY ONE entry — no WS replay exists.
      await flushPersistence(page)
      await page.reload({ waitUntil: 'domcontentloaded' })
      const harness2 = new TestHarness(page)
      await harness2.waitForHarness()
      await harness2.waitForConnection()
      const tabId2 = (await harness2.getActiveTabId())!
      expect(tabId2).toBeTruthy()

      const card = page.getByRole('alert', { name: 'Permission request for Bash' })
      await expect(card).toBeVisible({ timeout: 30_000 })
      await expect(
        page.getByRole('alert', { name: 'Permission request for Bash' }),
        'exactly one pending approval survives the reload',
      ).toHaveCount(1)
      // The reload window itself must never have fabricated a decision.
      expect(
        readClaudeSimLedger(lane.simLedger).filter((row) => row.kind === 'can_use_tool'),
      ).toEqual([])

      await card.getByRole('button', { name: 'Allow tool use' }).click()
      const response = await waitForSimRow(
        lane.simLedger,
        (row) => row.kind === 'can_use_tool' && row.toolName === 'Bash',
        'the CLI permission decision',
      )
      expect(response.decision).toEqual({ behavior: 'allow' })
      await expect(card).toBeHidden({ timeout: 15_000 })
      expect(await captureDurableId(harness2, tabId2, CANONICAL_UUID_RE)).toBe(durableBefore)
    } finally {
      await lane.server.stop().catch(() => {})
      await fs.rm(lane.sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })

  test('approval cancellation: composer Stop removes the card with zero fabricated decisions', async ({ page }) => {
    const lane = await bootClaudeLane(page, 'freshclaude')
    try {
      await waitForPaneStatus(lane.harness, lane.tabId, ['connected', 'idle'])
      await raisePermissionAndAssertNoDecisions(page, lane.harness, lane.tabId, lane.simLedger)

      const card = page.getByRole('alert', { name: 'Permission request for Bash' })
      const paneRoot = page.locator('[data-context="fresh-agent"]').last()
      await paneRoot.getByRole('button', { name: 'Stop' }).click()

      await expect(card).toBeHidden({ timeout: 15_000 })
      // Give the interrupt's full round trip a deterministic landing point:
      // the sidecar's cancellation event clears the card, and the session
      // returns to idle.
      await waitForPaneStatus(lane.harness, lane.tabId, 'idle')
      expect(
        readClaudeSimLedger(lane.simLedger)
          .filter((row) => row.kind === 'can_use_tool')
          .map((row) => ({ toolName: row.toolName, decision: row.decision })),
        'Stop resolves the CLI callback as a provider interruption, never as a user choice',
      ).toEqual([{ toolName: 'Bash', decision: { behavior: 'deny', message: 'Interrupted' } }])
      expect(
        readClaudeSimLedger(lane.simLedger).some((row) => row.kind === 'interrupt'),
        'the CLI observes the actual interrupt call',
      ).toBe(true)
    } finally {
      await lane.server.stop().catch(() => {})
      await fs.rm(lane.sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })

  test('questions: single-choice, multi-select, and Other answers keyed by question text', async ({ page }) => {
    const lane = await bootClaudeLane(page, 'freshclaude')
    try {
      await waitForPaneStatus(lane.harness, lane.tabId, ['connected', 'idle'])
      const banner = page.getByRole('region', { name: /Question from/ })

      // 1. single-choice
      await sendComposerText(page, 'RAISE_QUESTION')
      await expect(banner).toBeVisible({ timeout: 15_000 })
      expect(
        readClaudeSimLedger(lane.simLedger).filter((row) => row.kind === 'can_use_tool' && row.toolName === 'AskUserQuestion'),
        'no question answer may reach canUseTool before the user answers',
      ).toEqual([])
      await banner.getByRole('button', { name: 'A' }).click()
      let answer = await waitForSimRow(
        lane.simLedger,
        (row) => row.kind === 'can_use_tool' && row.toolName === 'AskUserQuestion',
        'the first CLI question answer',
      )
      expect(answer.decision.updatedInput.answers).toEqual({ 'Pick one': 'A' })
      await expect(banner).toBeHidden({ timeout: 15_000 })
      await waitForPaneStatus(lane.harness, lane.tabId, 'idle')

      // 2. multi-select (two of three)
      await sendComposerText(page, 'RAISE_QUESTION_MULTI')
      await expect(banner).toBeVisible({ timeout: 15_000 })
      await banner.getByRole('button', { name: 'A' }).click()
      await banner.getByRole('button', { name: 'C' }).click()
      await banner.getByRole('button', { name: 'Submit' }).click()
      await expect
        .poll(
          () => readClaudeSimLedger(lane.simLedger).filter((row) => row.kind === 'can_use_tool' && row.toolName === 'AskUserQuestion').length,
          { timeout: 15_000 },
        )
        .toBe(2)
      answer = readClaudeSimLedger(lane.simLedger)
        .filter((row) => row.kind === 'can_use_tool' && row.toolName === 'AskUserQuestion')
        .at(-1)
      expect(answer.decision.updatedInput.answers).toEqual({ 'Pick any two': 'A, C' })
      await expect(banner).toBeHidden({ timeout: 15_000 })
      await waitForPaneStatus(lane.harness, lane.tabId, 'idle')

      // 3. Other / free-text
      await sendComposerText(page, 'RAISE_QUESTION_OTHER')
      await expect(banner).toBeVisible({ timeout: 15_000 })
      await banner.getByRole('button', { name: 'Other' }).click()
      const otherInput = banner.getByRole('textbox', { name: 'Free text', exact: true })
      await otherInput.fill('Something custom')
      await banner.getByRole('button', { name: 'Submit' }).click()
      await expect
        .poll(
          () => readClaudeSimLedger(lane.simLedger).filter((row) => row.kind === 'can_use_tool' && row.toolName === 'AskUserQuestion').length,
          { timeout: 15_000 },
        )
        .toBe(3)
      answer = readClaudeSimLedger(lane.simLedger)
        .filter((row) => row.kind === 'can_use_tool' && row.toolName === 'AskUserQuestion')
        .at(-1)
      expect(answer.decision.updatedInput.answers).toEqual({ 'Free text': 'Something custom' })
      await expect(banner).toBeHidden({ timeout: 15_000 })
      await waitForPaneStatus(lane.harness, lane.tabId, 'idle')
    } finally {
      await lane.server.stop().catch(() => {})
      await fs.rm(lane.sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })

  test('compact: /compact instructions land on the same session; compacting shows; context retained', async ({ page }) => {
    // Give the simulator's real local /compact operation enough wall time for
    // the UI's compacting state to be observed.
    // 20x keeps the 500 ms simulated /compact window observable without
    // stretching the 600 ms SDK boot to 30 seconds (50x). At that scale the
    // pane did not reach its initial ready state before the test's 30 second
    // setup bound under cloud scheduling.
    const lane = await bootClaudeLane(page, 'freshclaude', { FRESHELL_CLAUDE_SIM_TIME_SCALE: '20' })
    try {
      await waitForPaneStatus(lane.harness, lane.tabId, ['connected', 'idle'])
      const durableBefore = await captureDurableId(lane.harness, lane.tabId, CANONICAL_UUID_RE)

      // Warm the session with one ordinary turn.
      await sendComposerText(page, 'warm-up turn')
      await waitForPaneStatus(lane.harness, lane.tabId, 'idle')

      // The compact gesture: typed slash text, executed by the composer.
      const paneRoot = page.locator('[data-context="fresh-agent"]').last()
      await paneRoot.getByRole('textbox', { name: 'Chat message input' }).fill('/compact focus the diff')
      await paneRoot.getByRole('textbox', { name: 'Chat message input' }).press('Enter')

      // The real local command exposes the compacting state while it works.
      await expect(page.getByTestId('fresh-agent-thinking-bar')).toHaveAttribute(
        'data-state',
        'active',
        { timeout: 15_000 },
      )
      // The CLI ledger records the exact local command text and durable id.
      const compactSend = await waitForSimRow(
        lane.simLedger,
        (row) => row.kind === 'prompt' && typeof row.text === 'string' && row.text.startsWith('/compact'),
        'compact command',
      )
      expect(compactSend.text).toBe('/compact focus the diff')
      expect(compactSend.sessionId).toBe(durableBefore)
      await waitForPaneStatus(lane.harness, lane.tabId, 'idle')

      // Follow-up prompt on the same pane → retained session + turn completes.
      // Gate on the prompt reaching the simulated CLI, never a stale idle
      // status from before the send's busy flip.
      await sendComposerText(page, 'follow-up after compact')
      await waitForSimRow(
        lane.simLedger,
        (row) => row.kind === 'prompt' && row.text === 'follow-up after compact',
        'follow-up prompt',
      )
      await waitForPaneStatus(lane.harness, lane.tabId, 'idle')
      const prompts = readClaudeSimLedger(lane.simLedger).filter((row) => row.kind === 'prompt')
      expect(
        prompts.filter((row) => row.text === '/compact focus the diff').length,
        'exactly one compact command',
      ).toBe(1)
      expect(
        prompts.filter((row) => row.text === 'follow-up after compact').length,
        'exactly one follow-up prompt',
      ).toBe(1)
      expect(new Set(prompts.map((row) => row.sessionId)), 'all commands use ONE durable Claude session').toEqual(new Set([durableBefore]))
      expect(await captureDurableId(lane.harness, lane.tabId, CANONICAL_UUID_RE)).toBe(durableBefore)

      // The durable transcript accumulates compaction + follow-up entries.
      const transcriptDir = path.join(lane.info.homeDir, '.claude', 'projects')
      const transcriptFile = path.join(transcriptDir, projectSlugOf(lane.projectDir), `${durableBefore}.jsonl`)
      // Native transcript writes may finish just after the result/idle frame.
      // Retain the earlier conversation and follow-up, and correlate the saved
      // local-command metadata with the actual command submitted to this CLI.
      await expect(async () => {
        const transcriptLines = readJsonl(transcriptFile)
        const userRows = transcriptLines.filter((line) => line.type === 'user')
        const textOf = (line: any): string => {
          const content = line.message?.content
          if (typeof content === 'string') return content
          if (Array.isArray(content)) {
            return content
              .map((block: any) => typeof block?.text === 'string' ? block.text : '')
              .filter(Boolean)
              .join('\n')
          }
          return ''
        }
        expect(userRows.map(textOf)).toEqual(
          expect.arrayContaining(['warm-up turn', 'follow-up after compact']),
        )
        const savedCommands = userRows.filter((line) => line.uuid === compactSend.uuid)
        expect(savedCommands, 'exactly one saved row for the submitted compact command').toHaveLength(1)
        expect(textOf(savedCommands[0])).toContain('<command-name>/compact</command-name>')
        expect(textOf(savedCommands[0])).toContain('<command-args>focus the diff</command-args>')
        expect(transcriptLines).toEqual(expect.arrayContaining([
          expect.objectContaining({ type: 'system', subtype: 'compact_boundary' }),
          expect.objectContaining({ type: 'user', isCompactSummary: true }),
        ]))
      }).toPass({ timeout: 15_000 })
    } finally {
      await lane.server.stop().catch(() => {})
      await fs.rm(lane.sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })

  test('capability gate: /fork is offered for claude', async ({ page }) => {
    const lane = await bootClaudeLane(page, 'freshclaude')
    try {
      await waitForPaneStatus(lane.harness, lane.tabId, ['connected', 'idle'])
      // One turn so the snapshot sheet is fully hydrated.
      await sendComposerText(page, 'gate warm-up')
      await waitForPaneStatus(lane.harness, lane.tabId, 'idle')

      const paneRoot = page.locator('[data-context="fresh-agent"]').last()
      await paneRoot.getByRole('button', { name: 'Slash commands' }).click()
      const menu = page.getByRole('menu', { name: 'Slash commands' })
      await expect(menu).toBeVisible({ timeout: 10_000 })
      await expect(
        menu.getByRole('group', { name: 'Pane actions' })
          .getByRole('menuitem', { name: /^\/compact Ask the agent to compact its current conversation context$/ }),
      ).toBeVisible()
      await expect(
        menu.getByRole('menuitem', { name: /^\/fork/ }),
        'claude capabilities.fork=true offers /fork in the menu (C14)',
      ).toBeVisible()
      await page.keyboard.press('Escape')
    } finally {
      await lane.server.stop().catch(() => {})
      await fs.rm(lane.sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })

  test('per-send settings reach the CLI before the next prompt (freshclaude)', async ({ page }) => {
    const lane = await bootClaudeLane(page, 'freshclaude')
    try {
      await waitForPaneStatus(lane.harness, lane.tabId, ['connected', 'idle'])

      // Change the permission mode BETWEEN sends through the pane's real
      // settings gear: freshclaude's registry default is 'default', so picking
      // 'acceptEdits' is a REAL change the next send must apply.
      await page.getByRole('button', { name: 'Agent settings' }).click()
      await page.getByRole('combobox', { name: 'Permission mode' }).selectOption('acceptEdits')
      await page.keyboard.press('Escape')
      await expect
        .poll(async () => (await paneLeaf(lane.harness, lane.tabId))?.content?.permissionMode ?? null)
        .toBe('acceptEdits')

      await sendComposerText(page, 'settings probe')
      // The production sidecar applies controls before it sends the queued
      // prompt to the simulated CLI; the ledger records both operations.
      await waitForSimRow(
        lane.simLedger,
        (row) => row.kind === 'control' && row.name === 'setPermissionMode' && row.args?.[0] === 'acceptEdits',
        'the CLI permission-mode control',
      )
      await waitForSimRow(
        lane.simLedger,
        (row) => row.kind === 'prompt' && row.text === 'settings probe',
        'settings probe prompt',
      )

      const records = readClaudeSimLedger(lane.simLedger)
      const configureIdx = records.findIndex(
        (row) => row.kind === 'control' && row.name === 'setPermissionMode' && row.args?.[0] === 'acceptEdits',
      )
      const sendIdx = records.findIndex((row) => row.kind === 'prompt' && row.text === 'settings probe')
      expect(configureIdx, 'the CLI must receive the new permission mode').toBeGreaterThanOrEqual(0)
      expect(sendIdx, 'the CLI must receive the settings probe').toBeGreaterThanOrEqual(0)
      expect(configureIdx, 'the control must land strictly BEFORE the prompt it applies to').toBeLessThan(sendIdx)
      expect(records[sendIdx].sessionId).toBe((await paneLeaf(lane.harness, lane.tabId))?.content?.sessionRef?.sessionId)
      expect(records[sendIdx].permissionMode).toBe('acceptEdits')
      await waitForPaneStatus(lane.harness, lane.tabId, 'idle')
    } finally {
      await lane.server.stop().catch(() => {})
      await fs.rm(lane.sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AGENT-24 — kilroy lane
// ─────────────────────────────────────────────────────────────────────────────

test.describe('fresh-agent control surfaces — kilroy lane (rust)', () => {
  test.setTimeout(240_000)

  test('kilroy lifecycle: create/send/approval/question/reload/cancel on the KILROY_ENABLED gate', async ({ page }) => {
    const lane = await bootClaudeLane(page, 'kilroy', { KILROY_ENABLED: '1' })
    try {
      await waitForPaneStatus(lane.harness, lane.tabId, 'idle')
      const durableBefore = await captureDurableId(lane.harness, lane.tabId, CANONICAL_UUID_RE)

      // Approval surfacing is exercised with a NON-BYPASS permission mode in
      // effect (kilroy's registry default is bypassPermissions — switch it to
      // the claude-family "Default (ask)" via the pane's real settings UI;
      // the raise's send frame provably carries the effective mode).
      const paneRoot = page.locator('[data-context="fresh-agent"]').last()
      // The settings button lives in the PANE HEADER (PaneHeader.tsx), not the
      // fresh-agent content root — only one exists on this tab.
      await page.getByRole('button', { name: 'Agent settings' }).click()
      await page.getByRole('combobox', { name: 'Permission mode' }).selectOption('default')
      await page.keyboard.press('Escape')
      await expect
        .poll(async () => (await paneLeaf(lane.harness, lane.tabId))?.content?.permissionMode ?? null)
        .toBe('default')

      // Approval: raise -> card (kilroy-branded surfaces ride the claude path)
      await sendComposerText(page, 'RAISE_PERMISSION')
      const card = page.getByRole('alert', { name: 'Permission request for Bash' })
      await expect(card).toBeVisible({ timeout: 15_000 })
      const sent = await lane.harness.getSentWsMessages()
      const raiseSend = (sent as any[]).find(
        (m) => m?.type === 'freshAgent.send' && m?.text === 'RAISE_PERMISSION',
      )
      expect(
        raiseSend?.settings?.permissionMode,
        'the raise send carries the non-bypass pane permission mode',
      ).toBe('default')
      await card.getByRole('button', { name: 'Allow tool use' }).click()
      const response = await waitForSimRow(
        lane.simLedger,
        (row) => row.kind === 'can_use_tool' && row.toolName === 'Bash',
        'the CLI permission decision',
      )
      expect(response.decision).toEqual({ behavior: 'allow' })
      await expect(card).toBeHidden({ timeout: 15_000 })
      await waitForPaneStatus(lane.harness, lane.tabId, 'idle')

      // Question: raise -> answer by question text -> completion
      const banner = page.getByRole('region', { name: 'Question from Kilroy' })
      await sendComposerText(page, 'RAISE_QUESTION')
      await expect(banner).toBeVisible({ timeout: 15_000 })
      await banner.getByRole('button', { name: 'A' }).click()
      await expect
        .poll(
          () => readClaudeSimLedger(lane.simLedger).filter((row) => row.kind === 'can_use_tool' && row.toolName === 'AskUserQuestion').length,
          { timeout: 15_000 },
        )
        .toBe(1)
      const qAnswer = readClaudeSimLedger(lane.simLedger).find((row) => row.kind === 'can_use_tool' && row.toolName === 'AskUserQuestion')
      expect(qAnswer.decision.updatedInput.answers).toEqual({ 'Pick one': 'A' })
      await expect(banner).toBeHidden({ timeout: 15_000 })
      await waitForPaneStatus(lane.harness, lane.tabId, 'idle')

      // Reload-while-pending: the card restores from the snapshot overlay and
      // the respond still resolves (against the SAME durable session).
      await sendComposerText(page, 'RAISE_PERMISSION')
      await expect(card).toBeVisible({ timeout: 15_000 })
      await flushPersistence(page)
      await page.reload({ waitUntil: 'domcontentloaded' })
      const harness2 = new TestHarness(page)
      await harness2.waitForHarness()
      await harness2.waitForConnection()
      const tabId2 = (await harness2.getActiveTabId())!
      await expect(card).toBeVisible({ timeout: 30_000 })
      await expect(card).toHaveCount(1)
      await card.getByRole('button', { name: 'Allow tool use' }).click()
      await expect
        .poll(
          () => readClaudeSimLedger(lane.simLedger).filter((row) => row.kind === 'can_use_tool' && row.toolName === 'Bash').length,
          { timeout: 15_000 },
        )
        .toBe(2)
      await expect(card).toBeHidden({ timeout: 15_000 })
      await waitForPaneStatus(harness2, tabId2, 'idle')
      expect(await captureDurableId(harness2, tabId2, CANONICAL_UUID_RE)).toBe(durableBefore)

      // Interrupt-cancel: Stop drops the card with zero fabricated decisions
      // for this raise.
      await sendComposerText(page, 'RAISE_PERMISSION')
      await expect(card).toBeVisible({ timeout: 15_000 })
      await paneRoot.getByRole('button', { name: 'Stop' }).click()
      await expect(card).toBeHidden({ timeout: 15_000 })
      await waitForPaneStatus(harness2, tabId2, 'idle')
      expect(
        readClaudeSimLedger(lane.simLedger)
          .filter((row) => row.kind === 'can_use_tool' && row.toolName === 'Bash')
          .map((row) => row.decision),
        'the two clicks allow the tool; Stop resolves the parked callback as Interrupted',
      ).toEqual([
        { behavior: 'allow' },
        { behavior: 'allow' },
        { behavior: 'deny', message: 'Interrupted' },
      ])
    } finally {
      await lane.server.stop().catch(() => {})
      await fs.rm(lane.sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })

  test('kilroy crash mid-turn in the background: one ring, Resume (no reload), a reload and restart recover the SAME durable session', async ({ page }) => {
    const lane = await bootClaudeLane(page, 'kilroy', { KILROY_ENABLED: '1' })
    try {
      await waitForPaneStatus(lane.harness, lane.tabId, ['connected', 'idle'])
      const durableBefore = await captureDurableId(lane.harness, lane.tabId, CANONICAL_UUID_RE)
      const paneRoot = page.locator('[data-context="fresh-agent"]').last()
      const tabLocator = page.locator(`[data-context="tab"][data-tab-id="${lane.tabId}"]`)
      const turnCompletion = async () => ((await lane.harness.getState()) as any)?.turnCompletion ?? {}
      const seqBefore = (await turnCompletion()).seq ?? 0
      // A page reload would wipe this marker: Resume must restore the
      // conversation in place.
      await page.evaluate(() => { (window as any).__freshellNoReloadMarker = 'kilroy-crash-lane' })

      // Crash mid-turn while the user is in another tab: the simulator ends
      // the CLI process, so the production sidecar reports the stream exit.
      await sendComposerText(page, 'CRASH_NOW')
      await page.getByRole('button', { name: 'New shell tab' }).click()
      await lane.harness.waitForTabCount(2)
      await waitForSimRow(
        lane.simLedger,
        (row) => row.kind === 'crash',
        'simulated CLI process exit',
      )
      // The server rings the lost turn exactly once (G05: a crash is a turn
      // end the user did not witness) and the background tab is highlighted.
      await expect
        .poll(async () => (await turnCompletion()).seq ?? 0,
          { timeout: 30_000, message: 'the crashed turn rings exactly one event' })
        .toBe(seqBefore + 1)
      expect((await turnCompletion()).attentionByTab?.[lane.tabId], 'the crash highlights the tab').toBe(true)
      await expect(tabLocator, 'the background tab carries the attention highlight').toHaveClass(/bg-emerald-100/)
      // Back on the tab: the session reads as ended, with Resume, and the
      // composer is disabled (nothing typed there could be lost).
      await tabLocator.click()
      await expect(
        page.getByRole('alert').filter({ hasText: 'exited unexpectedly' }),
        'the sidecar death must surface as a visible banner',
      ).toBeVisible({ timeout: 30_000 })
      await expect(paneRoot.getByText('This session has ended')).toBeVisible({ timeout: 30_000 })
      await waitForPaneStatus(lane.harness, lane.tabId, 'exited')
      await expect(paneRoot.getByRole('textbox', { name: 'Chat message input' })).toBeDisabled()

      // Resume reopens the SAME durable session in place, with no reload.
      await paneRoot.getByRole('button', { name: 'Resume session' }).click()
      await waitForSimRow(
        lane.simLedger,
        (row) => row.kind === 'query' && row.options?.resume === durableBefore,
        'the replacement CLI resumed the crashed durable session',
      )
      expect(await captureDurableId(lane.harness, lane.tabId, CANONICAL_UUID_RE, 30_000)).toBe(durableBefore)
      await waitForPaneStatus(lane.harness, lane.tabId, ['idle', 'connected'])
      await expect(paneRoot.getByText('This session has ended')).toHaveCount(0)
      expect(
        await page.evaluate(() => (window as any).__freshellNoReloadMarker),
        'Resume must not reload the page',
      ).toBe('kilroy-crash-lane')

      // The recovered session answers a follow-up turn — gated on the REAL
      // landing (the sidecar saw the send and completed it), never the
      // client's optimistic local echo.
      await sendComposerText(page, 'post-crash recovery turn')
      await waitForSimRow(
        lane.simLedger,
        (row) => row.kind === 'prompt' && row.text === 'post-crash recovery turn',
        'post-crash recovery prompt',
        30_000,
      )
      await waitForPaneStatus(lane.harness, lane.tabId, 'idle')
      await expect(paneRoot).toContainText('post-crash recovery turn', { timeout: 30_000 })

      // A second crash, recovered by reloading the page instead: the pane
      // hydrates as ended, and its attach must still resume the SAME durable
      // session (the server holds a dead-session record for it until then).
      const crashes = () => readClaudeSimLedger(lane.simLedger).filter((row) => row.kind === 'crash').length
      const resumes = () => readClaudeSimLedger(lane.simLedger)
        .filter((row) => row.kind === 'query' && row.options?.resume === durableBefore).length
      const resumesBeforeReload = resumes()
      await sendComposerText(page, 'CRASH_NOW')
      await expect.poll(crashes, { timeout: 30_000, message: 'the second fixture crash' }).toBe(2)
      await waitForPaneStatus(lane.harness, lane.tabId, 'exited')
      await expect(paneRoot.getByText('This session has ended')).toBeVisible({ timeout: 30_000 })
      await flushPersistence(page)
      await page.reload({ waitUntil: 'domcontentloaded' })
      await waitForWsReady(page)
      const harness2 = new TestHarness(page)
      await harness2.waitForHarness()
      await harness2.waitForConnection()
      const tabId2 = (await harness2.getActiveTabId())!
      await expect.poll(resumes, {
        timeout: 30_000,
        message: 'the reloaded pane resumed the crashed durable session',
      }).toBe(resumesBeforeReload + 1)
      expect(await captureDurableId(harness2, tabId2, CANONICAL_UUID_RE, 30_000)).toBe(durableBefore)
      await waitForPaneStatus(harness2, tabId2, ['idle', 'connected'])
      await expect(paneRoot.getByText('This session has ended')).toHaveCount(0)
      await sendComposerText(page, 'post-reload recovery turn')
      await waitForSimRow(
        lane.simLedger,
        (row) => row.kind === 'prompt' && row.text === 'post-reload recovery turn',
        'post-reload recovery prompt',
        30_000,
      )
      await waitForPaneStatus(harness2, tabId2, 'idle')
      await expect(paneRoot).toContainText('post-reload recovery turn', { timeout: 30_000 })

      // Restart mid-session: graceful reboot on the same home/port/token;
      // the pane re-hydrates from the durable transcript and resumes.
      await lane.server.restart()
      await waitForWsReady(page)
      expect(await captureDurableId(harness2, tabId2, CANONICAL_UUID_RE, 30_000)).toBe(durableBefore)
      await expect.poll(resumes,
        { timeout: 60_000, message: 'the restarted server resumed the same durable session' })
        .toBeGreaterThanOrEqual(resumesBeforeReload + 2)
      await sendComposerText(page, 'post-restart turn')
      await waitForSimRow(
        lane.simLedger,
        (row) => row.kind === 'prompt' && row.text === 'post-restart turn',
        'post-restart prompt on the new CLI process',
        60_000,
      )
      await waitForPaneStatus(harness2, tabId2, 'idle', 60_000)
      await expect(paneRoot).toContainText('post-restart turn', { timeout: 30_000 })
      // Ground truth at the durable store: every user turn sits in the SAME
      // transcript — neither crash forked the identity.
      const transcriptFile = path.join(
        lane.info.homeDir,
        '.claude',
        'projects',
        projectSlugOf(lane.projectDir),
        `${durableBefore}.jsonl`,
      )
      await expect(async () => {
        const userTexts = readJsonl(transcriptFile)
          .filter((l) => l.type === 'user')
          .map((l) => l.message?.content?.[0]?.text)
        expect(userTexts).toEqual(
          expect.arrayContaining(['CRASH_NOW', 'post-crash recovery turn', 'post-reload recovery turn', 'post-restart turn']),
        )
      }).toPass({ timeout: 30_000 })
    } finally {
      await lane.server.stop().catch(() => {})
      await fs.rm(lane.sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })
})

/** The fixture's transcript dir slug for a cwd (mirrors its mangleCwd). */
function projectSlugOf(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-')
}

// ─────────────────────────────────────────────────────────────────────────────
// AGENT-04/07 — codex lane (fake app-server, recordTurns on)
// ─────────────────────────────────────────────────────────────────────────────

/** Boot a freshcodex pane against the behavior-driven fake codex app-server. */
async function bootCodexLane(
  page: Page,
  behavior: Record<string, unknown> = {},
  extraEnv: Record<string, string> = {},
): Promise<{
  server: RustServer
  info: E2eServerInfo
  harness: TestHarness
  sharedRoot: string
  projectDir: string
  opLogPath: string
  responseLogPath: string
  tabId: string
}> {
  const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-agentctl-codex-'))
  try {
    const projectDir = path.join(sharedRoot, 'project')
    await fs.mkdir(projectDir, { recursive: true })
    const opLogPath = path.join(sharedRoot, 'codex-ops.jsonl')
    const responseLogPath = path.join(sharedRoot, 'codex-responses.jsonl')
    const { server, info, harness } = await bootWall(page, {
      env: {
        // Whitespace-split by spawn_sidecar (codex.rs): interpreter + script.
        CODEX_CMD: `${process.execPath} ${CODEX_APP_SERVER_FIXTURE}`,
        FAKE_CODEX_APP_SERVER_BEHAVIOR: JSON.stringify({
          appendThreadOperationLogPath: opLogPath,
          // REAL per-thread turn recording (fixture opt-in): thread/read
          // answers the recorded history, so forks provably diverge at the pin.
          recordTurns: true,
          appendClientResponseLogPath: responseLogPath,
          ...behavior,
        }),
        ...extraEnv,
      },
      setupHome: seedWallConfig({ providers: ['codex'], freshAgent: true }),
    })
    await selectShellIfPickerShowing(page)
    await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })
    await enableClis(page, { codex: true })
    const tabId = (await harness.getActiveTabId())!
    expect(tabId).toBeTruthy()
    await createFreshAgentPane(page, /^Freshcodex$/, 'Freshcodex', projectDir)
    return { server, info, harness, sharedRoot, projectDir, opLogPath, responseLogPath, tabId }
  } catch (error) {
    await fs.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

function readCodexOps(opLogPath: string): any[] {
  return readJsonl(opLogPath)
}

/** Bounded fixture-only diagnostics; never include control bodies or answers. */
async function captureCodexLaneDiagnostics(
  page: Page,
  lane: Awaited<ReturnType<typeof bootCodexLane>>,
): Promise<void> {
  const rows = (turns: any[] = []) => turns.map((turn) => ({
    id: turn.turnId, nativeTurnId: turn.nativeTurnId, role: turn.role,
    items: (turn.items ?? []).map((item: any) => ({ id: item.id, kind: item.kind, textBytes: typeof item.text === 'string' ? item.text.length : undefined })),
  }))
  const summarizeMetadata = (metadata: any) => metadata && ({
    ...metadata,
    turnOutputStates: Object.fromEntries(Object.entries(metadata.turnOutputStates ?? {}).map(([id, output]: [string, any]) => [id, {
      provenance: output.provenance, diagnostic: output.diagnostic, refreshPending: output.refreshPending,
      savedTurns: rows(output.savedTurns), retainedTurns: rows(output.retainedTurns),
    }])),
  })
  const summarizeSnapshot = (snapshot: any) => snapshot && ({
    threadId: snapshot.threadId, status: snapshot.status, revision: snapshot.revision,
    turns: rows(snapshot.turns),
    projection: summarizeMetadata(snapshot.extensions?.codex?.projection),
  })
  const result = await Promise.allSettled([
    fetchSnapshot(lane.info, 'freshcodex', 'codex', 'thread-new-1'),
    lane.harness.getReceivedWsMessages(),
    lane.harness.getState(),
    page.locator('[data-context="fresh-agent"]').last().getByRole('button').allTextContents(),
  ])
  const value = (index: number): any => {
    const item = result[index]
    return item.status === 'fulfilled' ? item.value : { diagnosticError: String(item.reason) }
  }
  const state = value(2)
  const live = Object.values(state?.freshAgentLive?.bySession ?? {}).map((session: any) => ({
    sessionId: session.sessionId,
    retainedSourceKey: session.retainedSourceKey,
    retainedSnapshot: summarizeSnapshot(session.retainedSnapshot),
    projection: session.projection && {
      id: session.projection.id, historyGeneration: session.projection.historyGeneration,
      eventRevision: session.projection.eventRevision, needsResnapshot: session.projection.needsResnapshot,
      turns: rows(session.projection.turns), turnRows: session.projection.turnRows,
    },
  }))
  const frames = Array.isArray(value(1)) ? value(1).slice(-100).map((frame: any) => ({
    type: frame.type, sessionId: frame.sessionId, provider: frame.provider,
    event: frame.event && {
      type: frame.event.type, status: frame.event.status,
      projectionId: frame.event.projectionId, historyGeneration: frame.event.historyGeneration,
      afterRevision: frame.event.afterRevision,
      ops: frame.event.ops?.map((op: any) => ({ op: op.op, revision: op.revision, nativeTurnId: op.nativeTurnId })),
      source: frame.event.retainedState?.source,
      snapshot: summarizeSnapshot(frame.event.retainedState?.snapshot),
    },
  })) : value(1)
  console.log('TASK006_CODEX_STATE_DIAGNOSTIC', JSON.stringify({
    test: test.info().title, nativeOperations: readCodexOps(lane.opLogPath).slice(-100),
    restSnapshot: summarizeSnapshot(value(0)), forwardedFrames: frames,
    live, sessions: Object.values(state?.freshAgent?.sessions ?? {}).map((session: any) => ({ sessionId: session.sessionId, status: session.status })), visibleButtonLabels: value(3),
  }))
}

/** Read a freshAgent session's status from the harness store — the exact
 * `agentSession.status` the stuck card's `effectiveStatus` renders from. */
async function readFreshAgentSessionStatus(
  harness: TestHarness,
  sessionId: string,
): Promise<string | null> {
  const state = await harness.getState()
  const sessions = state?.freshAgent?.sessions ?? {}
  const session = Object.values(sessions).find((s: any) => s?.sessionId === sessionId) as any
  return session?.status ?? null
}

/**
 * The fork handoff's lifecycle methods (task-008-review C-1). The fake's op
 * log records EVERY `thread/*` RPC — including `thread/read` snapshot
 * refetches (post-`turn/completed` or attach-time) that may legally
 * INTERLEAVE the archive→unarchive→resume chain — so absolute-adjacency
 * indexing over the raw log (`ops[forkIdx + N]`) is a false-precision flake
 * source. Assertions over the chain must filter to these methods first and
 * then check RELATIVE order + id placements.
 */
const CODEX_FORK_LIFECYCLE_METHODS = new Set([
  'thread/fork',
  'thread/archive',
  'thread/unarchive',
  'thread/resume',
])

/**
 * Send one freshcodex turn only after the browser accepts it, then wait for
 * the provider's durable idle snapshot. A durable snapshot from the previous
 * turn is not permission to assume a newly clicked composer submit left the
 * browser: FreshAgentView intentionally queues submits while its own outgoing
 * reservation is still being reconciled.
 */
async function sendCodexTurnAndWaitRows(
  page: Page,
  info: E2eServerInfo,
  harness: TestHarness,
  expectedRowCount: number,
  text: string,
): Promise<void> {
  const sentBefore = await harness.getSentWsMessages()
  const matchingSendsBefore = (sentBefore as any[]).filter(
    (message) => message?.type === 'freshAgent.send'
      && message?.provider === 'codex'
      && message?.sessionId === 'thread-new-1'
      && message?.text === text,
  ).length
  await sendComposerText(page, text)
  await expect
    .poll(
      async () => (await harness.getSentWsMessages() as any[]).filter(
        (message) => message?.type === 'freshAgent.send'
          && message?.provider === 'codex'
          && message?.sessionId === 'thread-new-1'
          && message?.text === text,
      ).length,
      {
        timeout: 30_000,
        message: `the browser did not dispatch the Codex send for "${text}"`,
      },
    )
    .toBe(matchingSendsBefore + 1)
  const paneRoot = page.locator('[data-context="fresh-agent"]').last()
  await expect(
    paneRoot.locator('article[data-turn-index]'),
    `${expectedRowCount} snapshot rows after "${text}"`,
  ).toHaveCount(expectedRowCount, { timeout: 30_000 })
  // The pane layout starts idle and can paint rows before the provider has
  // completed its turn. The Rust snapshot is the authoritative provider state;
  // require both the expected durable rows and an idle status before the next
  // send, compact, or fork action.
  await expect
    .poll(
      async () => {
        const snapshot = await fetchSnapshot(info, 'freshcodex', 'codex', 'thread-new-1')
        return {
          rows: snapshot?.turns?.length ?? 0,
          status: snapshot?.status ?? null,
        }
      },
      {
        timeout: 30_000,
        message: `timed out waiting for the durable Codex snapshot to settle after "${text}"`,
      },
    )
    .toEqual({ rows: expectedRowCount, status: 'idle' })
  // Synchronize the next UI action with the same client session status that
  // releases the outgoing reservation, rather than the independently fetched
  // provider snapshot alone.
  await expect
    .poll(
      () => readFreshAgentSessionStatus(harness, 'thread-new-1'),
      {
        timeout: 30_000,
        message: `the browser did not settle its Codex session after "${text}"`,
      },
    )
    .toBe('idle')
}

/** The parent's durable rollout file under the fake's CODEX_HOME. */
async function readRollout(homeDir: string, threadId: string): Promise<string | null> {
  const base = path.join(homeDir, '.codex', 'sessions')
  async function walk(dir: string): Promise<string | null> {
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return null
    }
    for (const entry of entries) {
      const p = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        const hit = await walk(p)
        if (hit) return hit
      } else if (entry.name === `rollout-${threadId}.jsonl`) {
        return p
      }
    }
    return null
  }
  const file = await walk(base)
  if (!file) return null
  return fs.readFile(file, 'utf8')
}

test.describe('fresh-agent control surfaces — codex lane (rust)', () => {
  test.setTimeout(240_000)

  test('Codex approvals and questions survive reload and send user decisions to the provider', async ({ page }) => {
    const lane = await bootCodexLane(page, { serverRequestsByPrompt: {
      'Approve tests': { id: 501, method: 'item/commandExecution/requestApproval', params: { command: 'npm test', reason: 'Run project tests' } },
      'Ask a question': { id: 'question-501', method: 'item/tool/requestUserInput', params: { isBlocking: true, questions: [{ id: 'color', header: 'Color', question: 'Choose a color', options: [{ label: 'Blue', description: 'Use blue' }] }] } },
      'Deny an edit': { id: 502, method: 'item/fileChange/requestApproval', params: { reason: 'Change the file', grantRoot: '/tmp/example' } },
    } })
    try {
      await waitForPaneStatus(lane.harness, lane.tabId, 'idle')
      await sendComposerText(page, 'Approve tests')
      const approval = page.getByRole('alert', { name: 'Permission request for Bash' })
      await expect(approval).toBeVisible()
      expect(readJsonl(lane.responseLogPath)).toHaveLength(0)
      await page.reload()
      await expect(approval).toHaveCount(1)
      await expect(approval).toBeVisible()
      expect(readJsonl(lane.responseLogPath)).toHaveLength(0)
      await approval.getByRole('button', { name: 'Allow', exact: true }).click()
      await expect.poll(() => readJsonl(lane.responseLogPath)).toContainEqual({ id: 501, result: { decision: 'accept' } })
      await expect(approval).toBeHidden()
      await waitForPaneStatus(lane.harness, lane.tabId, 'idle')
      await sendComposerText(page, 'Ask a question')
      const question = page.getByRole('region', { name: 'Question from Codex' })
      await expect(question).toBeVisible()
      await question.getByRole('button', { name: 'Blue', exact: true }).click()
      await expect.poll(() => readJsonl(lane.responseLogPath)).toContainEqual({ id: 'question-501', result: { answers: { color: { answers: ['Blue'] } } } })
      await expect(question).toBeHidden()
      await waitForPaneStatus(lane.harness, lane.tabId, 'idle')
      await sendComposerText(page, 'Deny an edit')
      const edit = page.getByRole('alert', { name: 'Permission request for Edit' })
      await expect(edit).toBeVisible()
      await edit.getByRole('button', { name: 'Decline', exact: true }).click()
      await expect.poll(() => readJsonl(lane.responseLogPath)).toContainEqual({ id: 502, result: { decision: 'decline' } })
      await expect(edit).toBeHidden()
      await waitForPaneStatus(lane.harness, lane.tabId, 'idle')
      console.log('TASK006_NATIVE_APPROVAL_CONTRACT', JSON.stringify({ test: test.info().title, normalizedNativeResponses: readJsonl(lane.responseLogPath) }))
    } catch (error) {
      await captureCodexLaneDiagnostics(page, lane).catch((diagnosticError) => console.log('TASK006_CODEX_DIAGNOSTIC_FAILED', String(diagnosticError)))
      throw error
    } finally {
      await lane.server.stop().catch(() => {})
      await fs.rm(lane.sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })

  // Native grants belong to Codex's offered decision, rather than a generic
  // pane-local tool bypass. A subsequent native request still needs a choice.
  test('Codex native session approval forwards an offered decision and keeps later requests user-gated', async ({ page }) => {
    const lane = await bootCodexLane(page, { serverRequestsByPrompt: {
      'Approve tests': { id: 601, method: 'item/commandExecution/requestApproval', params: { command: 'npm test', reason: 'Run project tests', availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'] } },
      'Approve a build': { id: 602, method: 'item/commandExecution/requestApproval', params: { command: 'npm run build', reason: 'Build the project', availableDecisions: ['decline', 'cancel'] } },
    } })
    try {
      await waitForPaneStatus(lane.harness, lane.tabId, 'idle')
      await sendComposerText(page, 'Approve tests')
      const approval = page.getByRole('alert', { name: 'Permission request for Bash' })
      await expect(approval).toBeVisible()
      const beforeReload = (await fetchSnapshot(lane.info, 'freshcodex', 'codex', 'thread-new-1')).pendingApprovals[0]
      expect(beforeReload).toMatchObject({ providerRequest: { id: 601, method: 'item/commandExecution/requestApproval' }, native: { availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'] } })
      expect(readJsonl(lane.responseLogPath)).toEqual([])
      await expect(approval.getByRole('button', { name: 'Always allow Bash in this pane', exact: true })).toHaveCount(0)
      expect((await lane.harness.getSentWsMessages() as any[]).filter((frame) => frame.type === 'freshAgent.send' && frame.text === 'Approve tests')).toHaveLength(1)
      await page.reload()
      await expect(approval).toHaveCount(1)
      await expect(approval).toBeVisible()
      const afterReload = (await fetchSnapshot(lane.info, 'freshcodex', 'codex', 'thread-new-1')).pendingApprovals[0]
      expect(afterReload.requestId).toBe(beforeReload.requestId)
      expect(afterReload.native.availableDecisions).toEqual(['accept', 'acceptForSession', 'decline', 'cancel'])
      expect(readJsonl(lane.responseLogPath)).toEqual([])
      await approval.getByRole('button', { name: 'Allow for this session', exact: true }).click()
      await expect.poll(() => readJsonl(lane.responseLogPath)).toEqual([{ id: 601, result: { decision: 'acceptForSession' } }])
      await expect(approval).toBeHidden()
      await waitForPaneStatus(lane.harness, lane.tabId, 'idle')

      // The provider raises a different command with a narrower offer. The
      // first session choice does not authorize a client-side automatic reply.
      await sendComposerText(page, 'Approve a build')
      await expect(approval).toHaveCount(1)
      await expect(approval).toBeVisible()
      const second = (await fetchSnapshot(lane.info, 'freshcodex', 'codex', 'thread-new-1')).pendingApprovals[0]
      expect(second).toMatchObject({ providerRequest: { id: 602, method: 'item/commandExecution/requestApproval' }, native: { availableDecisions: ['decline', 'cancel'] } })
      await expect(approval.getByRole('button', { name: 'Allow', exact: true })).toHaveCount(0)
      await expect(approval.getByRole('button', { name: 'Allow for this session', exact: true })).toHaveCount(0)
      await expect(approval.getByRole('button', { name: 'Always allow Bash in this pane', exact: true })).toHaveCount(0)
      expect(readJsonl(lane.responseLogPath)).toEqual([{ id: 601, result: { decision: 'acceptForSession' } }])
      expect((await lane.harness.getSentWsMessages() as any[]).filter((frame) => frame.type === 'freshAgent.approval.respond' && frame.requestId === second.requestId)).toEqual([])
      await approval.getByRole('button', { name: 'Decline', exact: true }).click()
      await expect.poll(() => readJsonl(lane.responseLogPath)).toEqual([{ id: 601, result: { decision: 'acceptForSession' } }, { id: 602, result: { decision: 'decline' } }])
      await waitForPaneStatus(lane.harness, lane.tabId, 'idle')
      await expect(approval).toBeHidden()
      expect((await lane.harness.getSentWsMessages() as any[]).filter((frame) => frame.type === 'freshAgent.send' && frame.text === 'Approve a build')).toHaveLength(1)
      const recorded = JSON.parse(await fs.readFile(path.join(lane.info.homeDir, '.codex', 'fake-turns', 'thread-new-1.json'), 'utf8'))
      expect(recorded).toHaveLength(2)
      console.log('TASK006_NATIVE_APPROVAL_CONTRACT', JSON.stringify({
        test: test.info().title,
        normalizedRequests: [beforeReload, afterReload, second].map((request) => ({ requestId: request.requestId, providerRequest: request.providerRequest, availableDecisions: request.native.availableDecisions })),
        normalizedNativeResponses: readJsonl(lane.responseLogPath), recordedTurns: recorded.length,
      }))
    } catch (error) {
      await captureCodexLaneDiagnostics(page, lane).catch((diagnosticError) => console.log('TASK006_CODEX_DIAGNOSTIC_FAILED', String(diagnosticError)))
      throw error
    } finally {
      await lane.server.stop().catch(() => {})
      await fs.rm(lane.sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })

  test('a real Freshcodex thread persists its durable reference and reloads its snapshot metadata', async ({ page }) => {
    const lane = await bootCodexLane(page)
    try {
      await waitForPaneStatus(lane.harness, lane.tabId, 'idle')
      await sendCodexTurnAndWaitRows(page, lane.info, lane.harness, 2, 'durable browser reload turn')

      // The fake app-server's real thread/start plus its recorded snapshot are
      // the lifecycle precondition the route-only metadata test cannot supply.
      const beforeReloadLeaf = await paneLeaf(lane.harness, lane.tabId)
      const threadId = beforeReloadLeaf?.content?.sessionId as string
      expect(threadId).toBe('thread-new-1')
      expect(beforeReloadLeaf?.content?.sessionRef).toEqual({ provider: 'codex', sessionId: threadId })
      const durableSnapshot = await fetchSnapshot(lane.info, 'freshcodex', 'codex', threadId)
      expect(durableSnapshot?.turns).toHaveLength(2)
      expect(
        readCodexOps(lane.opLogPath).filter((op) => op.method === 'thread/start' && op.threadId === threadId),
        'the thread must have been created by the real fake app-server before persistence',
      ).toHaveLength(1)

      await flushPersistence(page)
      const persisted = await page.evaluate(({ tabId, paneId }) => {
        const raw = localStorage.getItem(`freshell.layout.v3.${sessionStorage.getItem('freshell.layout-window-id.v1')}`)
        if (!raw) throw new Error('Missing persisted layout after Freshcodex flush')
        const layout = JSON.parse(raw)
        const findPane = (node: any): any => {
          if (node?.type === 'leaf' && node.id === paneId) return node.content
          for (const child of node?.children ?? []) {
            const found = findPane(child)
            if (found) return found
          }
          return undefined
        }
        const content = findPane(layout.panes?.layouts?.[tabId])
        if (!content) throw new Error('Persisted Freshcodex pane is missing')
        return {
          sessionRef: content.sessionRef,
          hasSessionId: Object.prototype.hasOwnProperty.call(content, 'sessionId'),
        }
      }, { tabId: lane.tabId, paneId: beforeReloadLeaf.id })
      expect(persisted).toEqual({
        sessionRef: { provider: 'codex', sessionId: threadId },
        hasSessionId: false,
      })

      // This route owns only the visual metadata fixture. It is installed
      // after the real thread exists, so reload/reconciliation still targets
      // the same Rust server and durable fake-app-server session above.
      await page.route(
        `${lane.info.baseUrl}/api/fresh-agent/threads/freshcodex/codex/${threadId}*`,
        async (route) => route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            sessionType: 'freshcodex',
            provider: 'codex',
            threadId,
            sessionId: threadId,
            revision: 7,
            status: 'idle',
            summary: 'Freshcodex durable snapshot',
            capabilities: { send: true, interrupt: true, approvals: false, questions: false, fork: true },
            tokenUsage: { totalTokens: 42, inputTokens: 10, outputTokens: 32 },
            worktrees: [{ id: 'wt-1', path: '/tmp/worktree', branch: 'feature/fresh-agent' }],
            diffs: [{ id: 'diff-1', title: 'README.md' }],
            childThreads: [{ id: 'child-1', threadId: 'child-thread', origin: 'codex', title: 'Subagent' }],
            extensions: {
              codex: {
                review: { id: 'review-1', status: 'pending' },
                fork: { parentThreadId: 'thread-parent-1' },
              },
            },
            turns: [{
              id: 'turn-reload',
              turnId: 'turn-reload',
              role: 'assistant',
              summary: 'Codex durable transcript',
              items: [{ id: 'item-reload', kind: 'text', text: 'Codex durable transcript' }],
            }],
          }),
        }),
      )

      await page.reload({ waitUntil: 'domcontentloaded' })
      const reloadedHarness = new TestHarness(page)
      await reloadedHarness.waitForHarness()
      await reloadedHarness.waitForConnection()
      const reloadedTabId = (await reloadedHarness.getActiveTabId())!

      // The handshake's reconcile inventory and the recovery request must both
      // name the persisted durable reference. The latter may be attach or a
      // create-shaped resume, but must never mint an unrelated thread.
      await expect.poll(async () => {
        const sent = await reloadedHarness.getSentWsMessages() as any[]
        return sent.some((message) =>
          message?.type === 'pane.reconcile.request'
            && message?.panes?.some((pane: any) =>
              pane?.kind === 'fresh-agent'
                && pane?.sessionRef?.provider === 'codex'
                && pane?.sessionRef?.sessionId === threadId,
            ),
        )
      }, { timeout: 30_000, message: 'reload reconcile inventory must retain the durable Codex reference' }).toBe(true)
      await expect.poll(async () => {
        const sent = await reloadedHarness.getSentWsMessages() as any[]
        return sent.some((message) =>
          (message?.type === 'freshAgent.attach' || message?.type === 'freshAgent.create')
            && (message?.sessionId === threadId
              || message?.resumeSessionId === threadId
              || message?.sessionRef?.sessionId === threadId),
        )
      }, { timeout: 30_000, message: 'reload must attach or resume the persisted Codex thread' }).toBe(true)
      await expect.poll(async () => (
        (await paneLeaf(reloadedHarness, reloadedTabId))?.content?.sessionRef?.sessionId ?? null
      ), { timeout: 30_000 }).toBe(threadId)
      expect(
        readCodexOps(lane.opLogPath).filter((op) => op.method === 'thread/start' && op.threadId === threadId),
        'reload must not create a second Codex thread',
      ).toHaveLength(1)

      const pane = page.locator('[data-context="fresh-agent"]').last()
      await expect(pane).toContainText('Codex durable transcript', { timeout: 30_000 })
      await expect(pane).toContainText('feature/fresh-agent')
      await expect(pane).toContainText('README.md')
      await expect(pane).toContainText('review-1')
      await expect(pane).toContainText('pending')
      await expect(pane).toContainText('thread-parent-1')
    } catch (error) {
      await captureCodexLaneDiagnostics(page, lane).catch((diagnosticError) => console.log('TASK006_CODEX_DIAGNOSTIC_FAILED', String(diagnosticError)))
      throw error
    } finally {
      await lane.server.stop().catch(() => {})
      await fs.rm(lane.sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })

  test('compact: thread/compact/start, never a turn; pane returns usable', async ({ page }) => {
    const lane = await bootCodexLane(page)
    try {
      await waitForPaneStatus(lane.harness, lane.tabId, 'idle')
      await sendCodexTurnAndWaitRows(page, lane.info, lane.harness, 2, 'codex turn one')

      // Typed slash gesture → freshAgent.compact → thread/compact/start.
      const paneRoot = page.locator('[data-context="fresh-agent"]').last()
      await paneRoot.getByRole('textbox', { name: 'Chat message input' }).fill('/compact')
      await paneRoot.getByRole('textbox', { name: 'Chat message input' }).press('Enter')

      const compactOp = await waitForLogEntry(
        lane.opLogPath,
        (o) => o.method === 'thread/compact/start',
        'thread/compact/start op',
      )
      expect(compactOp.params.threadId).toBe('thread-new-1')
      // Busy→idle ride the probed notification sequence; the pane settles.
      await waitForPaneStatus(lane.harness, lane.tabId, 'idle')

      // AGENT-04's crucial shape pin: compact minted NO turn. The fixture's
      // recorded-turns store is the ground truth — after the compact the
      // snapshot still shows exactly the warm-up turn's two display rows.
      await expect(async () => {
        const snapshot = await fetchSnapshot(lane.info, 'freshcodex', 'codex', 'thread-new-1')
        expect((snapshot?.turns ?? []).length).toBe(2)
      }).toPass({ timeout: 15_000 })

      // Usable after compact: a follow-up prompt mints exactly the next turn
      // (two recorded turns -> four display rows).
      await sendCodexTurnAndWaitRows(page, lane.info, lane.harness, 4, 'codex post-compact turn')
    } catch (error) {
      await captureCodexLaneDiagnostics(page, lane).catch((diagnosticError) => console.log('TASK006_CODEX_DIAGNOSTIC_FAILED', String(diagnosticError)))
      throw error
    } finally {
      await lane.server.stop().catch(() => {})
      await fs.rm(lane.sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })

  test('fork from tip: fork→archive→(child) unarchive→resume chain; source untouched; pane repoints', async ({ page }) => {
    const lane = await bootCodexLane(page)
    try {
      await waitForPaneStatus(lane.harness, lane.tabId, 'idle')
      await sendCodexTurnAndWaitRows(page, lane.info, lane.harness, 2, 'codex turn one')
      await sendCodexTurnAndWaitRows(page, lane.info, lane.harness, 4, 'codex turn two')

      const parentRolloutBefore = await readRollout(lane.info.homeDir, 'thread-new-1')
      expect(parentRolloutBefore, 'the parent rollout must exist').toBeTruthy()

      // Tip fork via the slash menu (the capability-gated affordance).
      const paneRoot = page.locator('[data-context="fresh-agent"]').last()
      await paneRoot.getByRole('button', { name: 'Slash commands' }).click()
      await page.getByRole('menuitem', { name: /^\/fork/ }).click()

      // freshAgent.forked repoints the pane at the child id the fork minted.
      const forkOp = await waitForLogEntry(
        lane.opLogPath,
        (o) => o.method === 'thread/fork',
        'thread/fork op',
      )
      const childId = forkOp.threadId as string
      expect(childId, 'the op log threadId field is the RESULT (child) id').not.toBe('thread-new-1')
      expect(forkOp.params.threadId).toBe('thread-new-1')
      expect(forkOp.params.lastTurnId ?? null).toBeNull()
      await expect
        .poll(async () => (await paneLeaf(lane.harness, lane.tabId))?.content?.sessionId ?? null)
        .toBe(childId)

      // The exact handoff chain — fork, archive, then the CHILD sidecar's own
      // unarchive → resume (second spawn's log rows share the same file).
      // RELATIVE order over lifecycle-filtered rows (see
      // CODEX_FORK_LIFECYCLE_METHODS): `thread/read` refetches may interleave
      // the chain, so raw-log adjacency is not assertable.
      await waitForLogEntry(lane.opLogPath, (o) => o.method === 'thread/resume' && o.params?.threadId === childId, 'child thread/resume')
      const ops = readCodexOps(lane.opLogPath)
      const forkIdx = ops.findIndex((o) => o.method === 'thread/fork')
      const chain = ops.filter(
        (o) =>
          CODEX_FORK_LIFECYCLE_METHODS.has(o.method)
          && (o.threadId === childId
            || o.threadId === 'thread-new-1'
            || o.params?.threadId === childId
            || o.params?.threadId === 'thread-new-1'),
      )
      expect(
        chain.map((o) => o.method),
        'fork lifecycle handoff in relative order (thread/read rows may interleave)',
      ).toEqual(['thread/fork', 'thread/archive', 'thread/unarchive', 'thread/resume'])
      expect(chain[1].threadId).toBe(childId)
      expect(chain[2].threadId).toBe(childId)
      expect(chain[3].params.threadId).toBe(childId)
      // The handoff provably crossed a process: the resume/unarchive rows ride
      // a DIFFERENT app-server listener than the parent's.
      expect(chain[3].listenUrl).not.toBe(chain[0].listenUrl)

      // AGENT-07 (a) source unchanged: after the fork call, NO mutation/turn
      // operation touches the source thread, and the source rollout is
      // byte-identical (rollouts are copy-on-write).
      const mutationsAgainstParent = ops
        .slice(forkIdx + 1)
        .filter(
          (o) =>
            o.params?.threadId === 'thread-new-1'
            && (o.method === 'turn/start' || o.method === 'thread/compact/start' || o.method === 'thread/fork'),
        )
      expect(mutationsAgainstParent, 'no post-fork mutation against the source thread').toEqual([])
      expect(await readRollout(lane.info.homeDir, 'thread-new-1')).toBe(parentRolloutBefore)
    } catch (error) {
      await captureCodexLaneDiagnostics(page, lane).catch((diagnosticError) => console.log('TASK006_CODEX_DIAGNOSTIC_FAILED', String(diagnosticError)))
      throw error
    } finally {
      await lane.server.stop().catch(() => {})
      await fs.rm(lane.sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })

  test('per-turn fork: :row-N normalizes to the raw turn id, child diverges at the pin, dual durability', async ({ page }) => {
    const lane = await bootCodexLane(page)
    try {
      await waitForPaneStatus(lane.harness, lane.tabId, 'idle')
      await sendCodexTurnAndWaitRows(page, lane.info, lane.harness, 2, 'codex turn one')
      await sendCodexTurnAndWaitRows(page, lane.info, lane.harness, 4, 'codex turn two')

      // Fork from turn 1's ASSISTANT row (data-turn-index 1, the synthesized
      // split id `turn-1:row-1`) via the turn's real hover affordance.
      await lane.harness.clearSentWsMessages()
      const paneRoot = page.locator('[data-context="fresh-agent"]').last()
      const turn1AssistantRow = paneRoot.locator('article[data-turn-index="1"]')
      await expect(turn1AssistantRow).toBeVisible({ timeout: 15_000 })
      await turn1AssistantRow.hover()
      await turn1AssistantRow.getByRole('button', { name: 'Fork conversation from here' }).click()

      // The client sends the SYNTHETIC split id; the server normalizes it —
      // the op log carries the RAW provider turn id (a missed strip would hit
      // the fake's strict-pin error and fork would fail loudly).
      const forkOp = await waitForLogEntry(
        lane.opLogPath,
        (o) => o.method === 'thread/fork',
        'thread/fork op',
      )
      expect(forkOp.params.lastTurnId).toBe('turn-1')
      const sent = await lane.harness.getSentWsMessages()
      const forkFrame = (sent as any[]).find((m) => m?.type === 'freshAgent.fork')
      expect(forkFrame?.input?.atTurnId).toBe('turn-1:row-1')

      const childId = forkOp.threadId as string
      await expect
        .poll(async () => (await paneLeaf(lane.harness, lane.tabId))?.content?.sessionId ?? null)
        .toBe(childId)

      // AGENT-07 (b) checkpoint divergence: the child's history contains turn
      // 1's rows and provably NOT turn 2's.
      await expect(async () => {
        const snapshot = await fetchSnapshot(lane.info, 'freshcodex', 'codex', childId)
        expect(snapshot).toBeTruthy()
        const ids = (snapshot.turns ?? []).map((t: any) => t.turnId ?? t.id)
        expect(ids.sort()).toEqual(['turn-1:row-0', 'turn-1:row-1'])
      }).toPass({ timeout: 30_000 })

      // AGENT-07 (a′, delta-round-1 fix D1-F3): the SOURCE remains independently
      // durable after the forked repoint + the client's parent-kill. The attach
      // below must land AFTER the parent's kill (else the kill would reap the
      // resumed runtime) — gate on the kill frame leaving the page.
      await expect
        .poll(async () =>
          (await lane.harness.getSentWsMessages() as any[])
            .filter((m) => m?.type === 'freshAgent.kill' && m?.sessionId === 'thread-new-1')
            .length,
        { timeout: 30_000, message: 'the client killed the parent after the forked repoint' })
        .toBe(1)
      // Drive the SAME resume-attach a rehydrating pane would send for the
      // source id: the fake must log a thread/resume for it, and its transcript
      // must render the FULL pre-fork history through the REST snapshot — turns
      // visible, under a fixture identity DISTINCT from the child's.
      const sourceAttachWs = new WsCapture(lane.info.baseUrl, lane.info.token)
      await sourceAttachWs.ready()
      sourceAttachWs.send({
        type: 'freshAgent.attach',
        provider: 'codex',
        sessionId: 'thread-new-1',
        sessionType: 'freshcodex',
        cwd: lane.projectDir,
        sessionRef: { provider: 'codex', sessionId: 'thread-new-1' },
      })
      // No thread/resume for the source existed before this attach (create rode
      // thread/start; the fork handoff's resume named the child), so the FIRST
      // such op row is the proof of the source's independent resume.
      const sourceResume = await waitForLogEntry(
        lane.opLogPath,
        (o) => o.method === 'thread/resume' && o.params?.threadId === 'thread-new-1',
        'thread/resume of the SOURCE after its parent-kill',
        30_000,
      )
      // The resumed source sidecar is a fresh process: its resume lands on a
      // listener distinct from the original parent's.
      expect(sourceResume.listenUrl).not.toBe(forkOp.listenUrl)
      await expect(async () => {
        const snapshot = await fetchSnapshot(lane.info, 'freshcodex', 'codex', 'thread-new-1')
        expect(snapshot).toBeTruthy()
        const ids = (snapshot.turns ?? []).map((t: any) => t.turnId ?? t.id).sort()
        expect(
          ids,
          'the source transcript renders BOTH pre-fork turns (unchanged by the fork)',
        ).toEqual(['turn-1:row-0', 'turn-1:row-1', 'turn-2:row-0', 'turn-2:row-1'])
      }).toPass({ timeout: 30_000 })
      expect(childId, 'distinct fixture identities: child ≠ source').not.toBe('thread-new-1')
      sourceAttachWs.close()

      // AGENT-07 (c1) browser-loss durability: reload; the SAME child id
      // re-hydrates (attach succeeds against the live child session).
      await flushPersistence(page)
      await page.reload({ waitUntil: 'domcontentloaded' })
      const harness2 = new TestHarness(page)
      await harness2.waitForHarness()
      await harness2.waitForConnection()
      const tabId2 = (await harness2.getActiveTabId())!
      await expect
        .poll(async () => (await paneLeaf(harness2, tabId2))?.content?.sessionId ?? null, { timeout: 30_000 })
        .toBe(childId)

      // AGENT-07 (c2) restart durability: abrupt reboot; the reconcile
      // re-drive RESUMES the durable child through the fake (a fresh fake
      // process reads the child's persisted turns from disk).
      const opCountBeforeRestart = readCodexOps(lane.opLogPath).length
      await lane.server.restartAbrupt()
      await waitForWsReady(page)
      await waitForLogEntry(
        lane.opLogPath,
        (o) => o.method === 'thread/resume' && o.params?.threadId === childId,
        'post-restart thread/resume of the child',
        60_000,
      )
      await expect
        .poll(async () => (await paneLeaf(harness2, tabId2))?.content?.sessionId ?? null, { timeout: 60_000 })
        .toBe(childId)

      // AGENT-07 (a′ cont., D1-F3): after the abrupt restart the SOURCE must
      // resume too — the pane proves the CHILD, this attach proves the SOURCE.
      const sourceRestartWs = new WsCapture(lane.info.baseUrl, lane.info.token)
      await sourceRestartWs.ready()
      sourceRestartWs.send({
        type: 'freshAgent.attach',
        provider: 'codex',
        sessionId: 'thread-new-1',
        sessionType: 'freshcodex',
        cwd: lane.projectDir,
        sessionRef: { provider: 'codex', sessionId: 'thread-new-1' },
      })
      await expect
        .poll(
          () => readCodexOps(lane.opLogPath)
            .slice(opCountBeforeRestart)
            .some((o) => o.method === 'thread/resume' && o.params?.threadId === 'thread-new-1'),
          { timeout: 60_000, message: 'post-restart thread/resume of the SOURCE' },
        )
        .toBe(true)
      // Resume/read evidence for BOTH ids post-restart (the child's resume
      // rides its pane re-attach; its read + the source's resume/read are
      // driven explicitly here, so the op-log window proves BOTH transcripts
      // still render — the child at the fork pin, the source in full).
      await expect(async () => {
        const snapshot = await fetchSnapshot(lane.info, 'freshcodex', 'codex', childId)
        expect((snapshot.turns ?? []).map((t: any) => t.turnId ?? t.id).sort())
          .toEqual(['turn-1:row-0', 'turn-1:row-1'])
      }).toPass({ timeout: 30_000 })
      await expect(async () => {
        const snapshot = await fetchSnapshot(lane.info, 'freshcodex', 'codex', 'thread-new-1')
        expect((snapshot.turns ?? []).map((t: any) => t.turnId ?? t.id).sort())
          .toEqual(['turn-1:row-0', 'turn-1:row-1', 'turn-2:row-0', 'turn-2:row-1'])
      }).toPass({ timeout: 30_000 })
      await expect
        .poll(() => {
          const post = readCodexOps(lane.opLogPath).slice(opCountBeforeRestart)
          return ['thread-new-1', childId].every((id) =>
            post.some((o) => o.method === 'thread/resume' && o.params?.threadId === id)
            && post.some((o) => o.method === 'thread/read' && (o.threadId === id || o.params?.threadId === id)))
        }, { timeout: 30_000, message: 'post-restart resume+read evidence for BOTH source and child' })
        .toBe(true)
      sourceRestartWs.close()
    } catch (error) {
      await captureCodexLaneDiagnostics(page, lane).catch((diagnosticError) => console.log('TASK006_CODEX_DIAGNOSTIC_FAILED', String(diagnosticError)))
      throw error
    } finally {
      await lane.server.stop().catch(() => {})
      await fs.rm(lane.sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })
  // Wedged-sidecar deadman (r47n): the fake's turnCompleteDelayMs keeps the
  // process alive but the turn/completed broadcast effectively never lands
  // (3.6e6 ms), so the quiet window must surface the stuck state with recovery
  // instead of an eternal spinner.
  test('wedged sidecar: quiet window surfaces the stuck state with recovery, not an eternal spinner', async ({ page }) => {
    const lane = await bootCodexLane(
      page,
      { turnCompleteDelayMs: 3_600_000 },
      { FRESHELL_FRESHCODEX_QUIET_WINDOW_MS: '4000' },
    )
    try {
      await waitForPaneStatus(lane.harness, lane.tabId, 'idle')
      const paneRoot = page.locator('[data-context="fresh-agent"]').last()
      const stuckAlert = paneRoot.getByRole('alert').filter({ hasText: /appears stuck/i })
      const threadId = ((await paneLeaf(lane.harness, lane.tabId))?.content?.sessionId ?? '') as string
      expect(threadId, 'freshcodex thread id materialized before the send').toBeTruthy()

      await sendComposerText(page, 'run a turn that will wedge')

      // Within the bound (2s < 4s window, measured from the send — the
      // deadman arms when the send's turn/start RPC lands): no stuck state.
      await page.waitForTimeout(2000)
      await expect(stuckAlert).toHaveCount(0)

      // Past the bound: the stuck notice surfaces (role=alert), and the pane
      // stops asserting "working" — the session status the card reads is now
      // 'stuck' (the STATUS frame itself asserts no outcome).
      await expect(stuckAlert, 'stuck notice after the quiet window').toBeVisible({ timeout: 25_000 })
      await expect
        .poll(
          () => readFreshAgentSessionStatus(lane.harness, threadId),
          { timeout: 15_000, message: 'session status stops asserting busy (stuck)' },
        )
        .toBe('stuck')

      // Unified attention contract: the deadman rings DELIBERATELY — alongside
      // the stuck status, the server emits the companion freshAgent.turn.complete
      // edge, so the pane's tab gets exactly one turnCompletion event (seq 1).
      // The user is watching this pane (single tab, focused window), so the
      // client partitions the edge as WATCHED — the tab-strip mark, no bell —
      // but the edge itself MUST arrive: a wedged turn is a turn end.
      await expect
        .poll(
          async () => (await lane.harness.getState())?.turnCompletion?.seq ?? 0,
          { timeout: 15_000, message: 'the deadman companion edge folds as exactly one event (seq 1)' },
        )
        .toBe(1)
      const deadmanState = await lane.harness.getState()
      expect(
        deadmanState?.turnCompletion?.lastAtByTerminalId?.[`codex:${threadId}`],
        'the deadman edge folded under the completion namespace for the wedged thread',
      ).toBeGreaterThan(0)
      expect(
        deadmanState?.turnCompletion?.watchedCompletionByTab?.[lane.tabId],
        'the watched deadman fire sets the tab-strip-only watched mark',
      ).toBe(true)
      expect(
        deadmanState?.turnCompletion?.attentionByTab?.[lane.tabId],
        'a watched deadman fire creates no unwitnessed tab attention',
      ).toBeUndefined()

      // The wedge is a live, in-flight turn: exactly one recorded turn
      // renders (user + assistant rows) and the PROVIDER never completes it
      // — the ring above is the deadman's deliberate synthesis, not a
      // fabricated provider turn/completed.
      await expect(
        paneRoot.locator('article[data-turn-index]'),
        'exactly one wedged turn renders (user+assistant rows), alive with no provider completion',
      ).toHaveCount(2, { timeout: 30_000 })

      // Recovery stops only the wedged process, then resumes the same durable
      // thread. The recorded turn survives and the replacement accepts work.
      const turnsBefore = (await fetchSnapshot(lane.info, 'freshcodex', 'codex', threadId))?.turns
      expect(turnsBefore?.length).toBeGreaterThan(0)
      const opsBeforeRestart = readCodexOps(lane.opLogPath).length
      await stuckAlert.getByRole('button', { name: /restart sidecar/i }).click()
      await waitForPaneStatus(lane.harness, lane.tabId, 'idle')
      await expect(stuckAlert).toHaveCount(0)
      expect((await paneLeaf(lane.harness, lane.tabId))?.content?.sessionId).toBe(threadId)
      const postRestartOps = readCodexOps(lane.opLogPath).slice(opsBeforeRestart)
      expect(postRestartOps.some((op) => op.method === 'thread/resume' && op.params?.threadId === threadId)).toBe(true)
      expect(postRestartOps.some((op) => op.method === 'thread/start')).toBe(false)
      const turnsAfter = (await fetchSnapshot(lane.info, 'freshcodex', 'codex', threadId))?.turns
      expect(turnsAfter?.length).toBeGreaterThanOrEqual(turnsBefore.length)
      await sendComposerText(page, 'follow-up after sidecar restart')
      // The REST projection stores a user and assistant row for each turn.
      await expect.poll(async () =>
        (await fetchSnapshot(lane.info, 'freshcodex', 'codex', threadId))?.turns?.length,
      { timeout: 15_000 }).toBe(turnsAfter.length + 2)
    } catch (error) {
      await captureCodexLaneDiagnostics(page, lane).catch((diagnosticError) => console.log('TASK006_CODEX_DIAGNOSTIC_FAILED', String(diagnosticError)))
      throw error
    } finally {
      await lane.server.stop().catch(() => {})
      await fs.rm(lane.sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })

  test('long turn within the quiet window completes normally and never shows the stuck state', async ({ page }) => {
    const lane = await bootCodexLane(
      page,
      { turnCompleteDelayMs: 3_000 },
      { FRESHELL_FRESHCODEX_QUIET_WINDOW_MS: '8000' },
    )
    try {
      await waitForPaneStatus(lane.harness, lane.tabId, 'idle')
      const paneRoot = page.locator('[data-context="fresh-agent"]').last()
      const stuckAlert = paneRoot.getByRole('alert').filter({ hasText: /appears stuck/i })

      await sendComposerText(page, 'a slow but healthy turn')
      const sentAt = Date.now()

      // The turn runs and renders (user + assistant rows = exactly one
      // recorded turn) and completes within the 8s window: the pane returns
      // to a truthful idle (turn/completed at ~3s disarms the deadman).
      await expect(
        paneRoot.locator('article[data-turn-index]'),
        'the slow turn renders and is tracked',
      ).toHaveCount(2, { timeout: 30_000 })
      await waitForPaneStatus(lane.harness, lane.tabId, 'idle')

      // ... and stays stuck-free PAST the bound (measured from the send): a
      // completed turn must never fire the deadman — an alert here would be
      // exactly the false positive the bound exists to prevent.
      await page.waitForTimeout(Math.max(0, 11_000 - (Date.now() - sentAt)))
      await expect(stuckAlert).toHaveCount(0)
    } catch (error) {
      await captureCodexLaneDiagnostics(page, lane).catch((diagnosticError) => console.log('TASK006_CODEX_DIAGNOSTIC_FAILED', String(diagnosticError)))
      throw error
    } finally {
      await lane.server.stop().catch(() => {})
      await fs.rm(lane.sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })

  test('per-send settings alter the turn payload against the Rust server (freshcodex)', async ({ page }) => {
    const lane = await bootCodexLane(page)
    try {
      await waitForPaneStatus(lane.harness, lane.tabId, 'idle')
      // Turn 1 rides the pane's untouched defaults.
      await sendCodexTurnAndWaitRows(page, lane.info, lane.harness, 2, 'codex turn one')
      const threadId = (await paneLeaf(lane.harness, lane.tabId))?.content?.sessionId as string
      expect(threadId, 'the durable codex thread id must be known before turn two').toBeTruthy()

      // Change model + effort BETWEEN sends through the real settings UI:
      // gear popover → Model row ("Change…") → the two-column model dialog →
      // pick GPT-5.6 Sol, stage its `low` thinking level, commit.
      await page.getByRole('button', { name: 'Agent settings' }).click()
      const popover = page.getByRole('dialog', { name: 'Agent settings' })
      await expect(popover).toBeVisible({ timeout: 10_000 })
      await popover.getByRole('button', { name: /Change/ }).click()
      const dialog = page.getByRole('dialog', { name: 'Model and thinking level' })
      await expect(dialog).toBeVisible({ timeout: 10_000 })
      await dialog.getByRole('option', { name: 'GPT-5.6 Sol' }).click()
      const levelsList = dialog.getByRole('listbox', { name: 'Thinking levels for GPT-5.6 Sol' })
      await expect(levelsList).toBeVisible()
      await levelsList.getByRole('option', { name: 'low', exact: true }).click()
      await dialog.getByRole('button', { name: 'Use GPT-5.6 Sol · low' }).click()
      await expect(dialog).toHaveCount(0)
      // The commit leaves the settings popover open behind the dialog; close it.
      await page.keyboard.press('Escape')
      await expect(popover).toHaveCount(0, { timeout: 10_000 })
      await expect
        .poll(async () => {
          const content = (await paneLeaf(lane.harness, lane.tabId))?.content
          return content ? `${content.model ?? ''}|${content.effort ?? ''}` : ''
        })
        .toBe('gpt-5.6-sol|low')

      // Turn 2 must now carry the changed knobs (canonical's codex.rs merges
      // msg.settings over the session baseline before turn/start).
      await sendCodexTurnAndWaitRows(page, lane.info, lane.harness, 4, 'codex turn two')

      // Ground truth: the fake's recorded-turns file under the lane's isolated
      // CODEX_HOME (<home>/.codex/fake-turns/<threadId>.json). Each recorded
      // turn carries its captured turn/start params additively under `start` —
      // turn 2 carries the per-send selection while turn 1 kept the defaults
      // (gpt-6-astra / the default 'max' effort, wire-mapped 'xhigh' by
      // to_codex_reasoning_effort).
      const turnsPath = path.join(lane.info.homeDir, '.codex', 'fake-turns', `${threadId}.json`)
      await expect(async () => {
        const turns = JSON.parse(await fs.readFile(turnsPath, 'utf8')) as any[]
        expect(turns, 'exactly the two recorded turns').toHaveLength(2)
        expect(turns[1]?.start?.model).toBe('gpt-5.6-sol')
        expect(turns[1]?.start?.effort).toBe('low')
        expect(turns[0]?.start?.model).toBe('gpt-6-astra')
        expect(turns[0]?.start?.effort).toBe('xhigh')
        expect(turns[0]?.start?.model).not.toBe(turns[1]?.start?.model)
        expect(turns[0]?.start?.effort).not.toBe(turns[1]?.start?.effort)
      }).toPass({ timeout: 15_000 })
    } catch (error) {
      await captureCodexLaneDiagnostics(page, lane).catch((diagnosticError) => console.log('TASK006_CODEX_DIAGNOSTIC_FAILED', String(diagnosticError)))
      throw error
    } finally {
      await lane.server.stop().catch(() => {})
      await fs.rm(lane.sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AGENT-04/07 — opencode lane (fake opencode serve, audit log)
// ─────────────────────────────────────────────────────────────────────────────

/** Boot a freshopencode pane against the HTTP/SSE fake opencode serve. */
async function bootOpencodeLane(
  page: Page,
  extraEnv: Record<string, string> = {},
): Promise<{
  server: RustServer
  info: E2eServerInfo
  harness: TestHarness
  sharedRoot: string
  projectDir: string
  auditLogPath: string
  tabId: string
}> {
  const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-agentctl-opencode-'))
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

/** Send a prompt, wait for materialization (placeholder → ses_*), settle idle. */
async function sendOpencodeTurn(
  page: Page,
  harness: TestHarness,
  tabId: string,
  text: string,
  expectedPromptCount: number,
  auditLogPath: string,
  options: { expectResponseText?: boolean } = {},
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
  await waitForLogEntry(
    auditLogPath,
    (e) => e.event === 'prompt_async' && e.prompt === text,
    `prompt_async audit for "${text}"`,
  )
  // The assistant reply renders from the fake's own message store.
  if (options.expectResponseText !== false) {
    await expect(paneRoot).toContainText(`Fake OpenCode response: ${text}`, { timeout: 30_000 })
  }
  return (await paneLeaf(harness, tabId))?.content?.sessionId as string
}

test.describe('fresh-agent control surfaces — opencode lane (rust)', () => {
  test.setTimeout(240_000)

  test('compact: POST /session/:id/summarize carries {providerID,modelID} exactly', async ({ page }) => {
    const lane = await bootOpencodeLane(page)
    try {
      const sessionId = await sendOpencodeTurn(page, lane.harness, lane.tabId, 'opencode turn one', 1, lane.auditLogPath)

      const paneRoot = page.locator('[data-context="fresh-agent"]').last()
      await paneRoot.getByRole('textbox', { name: 'Chat message input' }).fill('/compact')
      await paneRoot.getByRole('textbox', { name: 'Chat message input' }).press('Enter')

      const summarize = await waitForLogEntry(
        lane.auditLogPath,
        (e) => e.event === 'summarize',
        'summarize audit entry',
      )
      expect(summarize.sessionId).toBe(sessionId)
      // The strict 1.18.18 schema: exactly {providerID, modelID}, derived from
      // the fake provider's configured default model (/config).
      expect(summarize.bodyKeys).toEqual(['modelID', 'providerID'])
      expect(summarize.body).toEqual({ providerID: 'opencode', modelID: 'fake-opencode' })

      // Usable afterward: a follow-up turn materializes another prompt.
      await sendOpencodeTurn(page, lane.harness, lane.tabId, 'opencode post-compact turn', 2, lane.auditLogPath)
      expect(
        readOpencodeAudit(lane.auditLogPath).filter((e) => e.event === 'prompt_async'),
      ).toHaveLength(2)
    } finally {
      await lane.server.stop().catch(() => {})
      await fs.rm(lane.sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })

  test('fork from tip: child insert + pane repoint; source untouched after parent kill', async ({ page }) => {
    const lane = await bootOpencodeLane(page)
    try {
      const parentId = await sendOpencodeTurn(page, lane.harness, lane.tabId, 'opencode turn one', 1, lane.auditLogPath)
      await sendOpencodeTurn(page, lane.harness, lane.tabId, 'opencode turn two', 2, lane.auditLogPath)

      const paneRoot = page.locator('[data-context="fresh-agent"]').last()
      await paneRoot.getByRole('button', { name: 'Slash commands' }).click()
      await page.getByRole('menuitem', { name: /^\/fork/ }).click()

      const forkAudit = await waitForLogEntry(
        lane.auditLogPath,
        (e) => e.event === 'fork',
        'fork audit entry',
      )
      expect(forkAudit.sessionId).toBe(parentId)
      // A tip fork sends NO messageID at all (never an unknown key into the
      // strict fork body schema).
      expect(forkAudit.bodyKeys).toEqual([])
      const childId = forkAudit.parentId === parentId
        ? (await waitForLogEntry(lane.auditLogPath, (e) => e.event === 'forked', 'forked audit entry')).sessionId
        : null
      expect(childId).toMatch(/^ses_/)

      // freshAgent.forked repoints the pane (the client kills the parent).
      await expect
        .poll(async () => (await paneLeaf(lane.harness, lane.tabId))?.content?.sessionId ?? null, { timeout: 30_000 })
        .toBe(childId)

      // AGENT-07 (a): after the fork call, NO mutation event (prompt/summarize/
      // fork) ever lands on the source session — and the child's history holds
      // BOTH turns (tip fork), readable through the fake's own store.
      const audit = readOpencodeAudit(lane.auditLogPath)
      const forkIndex = audit.findIndex((e) => e.event === 'fork' && e.sessionId === parentId)
      const mutationsAgainstParent = audit
        .slice(forkIndex + 1)
        .filter(
          (e) =>
            e.sessionId === parentId
            && (e.event === 'prompt_async' || e.event === 'summarize' || e.event === 'fork'),
        )
      expect(mutationsAgainstParent, 'no post-fork mutation against the source session').toEqual([])
      await expect
        .poll(async () => {
          const snapshot = await fetchSnapshot(lane.info, 'freshopencode', 'opencode', childId as string)
          return (snapshot?.turns ?? []).length
        }, { timeout: 30_000 })
        .toBe(4) // user1 + assistant1 + user2 + assistant2
    } finally {
      await lane.server.stop().catch(() => {})
      await fs.rm(lane.sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })

  test('per-turn fork: messageID lands; child history stops at the pin; dual durability', async ({ page }) => {
    const lane = await bootOpencodeLane(page)
    try {
      const parentId = await sendOpencodeTurn(page, lane.harness, lane.tabId, 'opencode turn one', 1, lane.auditLogPath)
      await sendOpencodeTurn(page, lane.harness, lane.tabId, 'opencode turn two', 2, lane.auditLogPath)

      // Fork from turn 1's ASSISTANT row (turnId = its message id), hovered
      // through the real turn affordance.
      const paneRoot = page.locator('[data-context="fresh-agent"]').last()
      const turn1AssistantRow = paneRoot.locator('article[data-turn-index="1"]')
      await expect(turn1AssistantRow).toBeVisible({ timeout: 15_000 })
      const expectedMessageId = `msg_${parentId}_2_assistant`
      await turn1AssistantRow.hover()
      await turn1AssistantRow.getByRole('button', { name: 'Fork conversation from here' }).click()

      const forkAudit = await waitForLogEntry(
        lane.auditLogPath,
        (e) => e.event === 'fork',
        'fork audit entry',
      )
      expect(forkAudit.sessionId).toBe(parentId)
      expect(forkAudit.bodyKeys).toEqual(['messageID'])
      expect(forkAudit.body?.messageID).toBe(expectedMessageId)

      const forkedAudit = await waitForLogEntry(
        lane.auditLogPath,
        (e) => e.event === 'forked' && e.parentId === parentId,
        'forked audit entry',
      )
      const childId = forkedAudit.sessionId as string
      await expect
        .poll(async () => (await paneLeaf(lane.harness, lane.tabId))?.content?.sessionId ?? null, { timeout: 30_000 })
        .toBe(childId)

      // AGENT-07 (b): the child's history in the fake contains turn 1 and NOT
      // turn 2 (messageID honored by the fake arm).
      await expect(async () => {
        const snapshot = await fetchSnapshot(lane.info, 'freshopencode', 'opencode', childId)
        const texts = (snapshot?.turns ?? []).flatMap((t: any) =>
          (t.items ?? []).map((i: any) => i.text).filter(Boolean),
        )
        expect(texts.some((t: string) => t.includes('opencode turn one'))).toBe(true)
        expect(texts.some((t: string) => t.includes('opencode turn two'))).toBe(false)
        expect((snapshot?.turns ?? []).length).toBe(2) // user1 + assistant1 only
      }).toPass({ timeout: 30_000 })

      // AGENT-07 (a′, delta-round-1 fix D1-F3): the SOURCE remains independently
      // durable after the forked repoint + the client's parent-kill. The attach
      // below must land AFTER the parent's kill (else the kill would reap the
      // resumed runtime) — gate on the kill frame leaving the page.
      await expect
        .poll(async () =>
          (await lane.harness.getSentWsMessages() as any[])
            .filter((m) => m?.type === 'freshAgent.kill' && m?.sessionId === parentId)
            .length,
        { timeout: 30_000, message: 'the client killed the parent after the forked repoint' })
        .toBe(1)
      // Drive the SAME resume-attach a rehydrating pane would send for the
      // source id: the fake serve must log its resume probe (session_get)
      // POST-fork, and the source transcript renders the FULL pre-fork history
      // — turns visible, under a fixture identity DISTINCT from the child's.
      const sourceAttachWs = new WsCapture(lane.info.baseUrl, lane.info.token)
      await sourceAttachWs.ready()
      sourceAttachWs.send({
        type: 'freshAgent.attach',
        provider: 'opencode',
        sessionId: parentId,
        sessionType: 'freshopencode',
        cwd: lane.projectDir,
        sessionRef: { provider: 'opencode', sessionId: parentId },
      })
      const forkRowIndex = readOpencodeAudit(lane.auditLogPath)
        .findIndex((e) => e.event === 'fork' && e.sessionId === parentId)
      await expect
        .poll(
          () => readOpencodeAudit(lane.auditLogPath)
            .slice(forkRowIndex + 1)
            .some((e) => e.event === 'session_get' && e.sessionId === parentId),
          { timeout: 30_000, message: 'post-fork resume probe (session_get) of the SOURCE' },
        )
        .toBe(true)
      await expect(async () => {
        const snapshot = await fetchSnapshot(lane.info, 'freshopencode', 'opencode', parentId)
        const texts = (snapshot?.turns ?? []).flatMap((t: any) =>
          (t.items ?? []).map((i: any) => i.text).filter(Boolean),
        )
        expect(texts.some((t: string) => t.includes('opencode turn one'))).toBe(true)
        expect(texts.some((t: string) => t.includes('opencode turn two'))).toBe(true)
        expect((snapshot?.turns ?? []).length).toBe(4) // both pre-fork turns, unchanged
      }).toPass({ timeout: 30_000 })
      expect(childId, 'distinct fixture identities: child ≠ source').not.toBe(parentId)
      sourceAttachWs.close()

      // AGENT-07 (c1) reload durability: the child id re-hydrates.
      await flushPersistence(page)
      await page.reload({ waitUntil: 'domcontentloaded' })
      const harness2 = new TestHarness(page)
      await harness2.waitForHarness()
      await harness2.waitForConnection()
      const tabId2 = (await harness2.getActiveTabId())!
      await expect
        .poll(async () => (await paneLeaf(harness2, tabId2))?.content?.sessionId ?? null, { timeout: 30_000 })
        .toBe(childId)

      // AGENT-07 (c2) restart durability: ABRUPT reboot (delta-round-1 fix
      // D1-F3 hardens the probe from graceful to SIGKILL-class); the resume
      // probe lands on the NEW fake serve process (a different pid than the
      // fork's).
      const forkServePid = forkAudit.pid
      const auditCountBeforeRestart = readOpencodeAudit(lane.auditLogPath).length
      await lane.server.restartAbrupt()
      await waitForWsReady(page)
      await waitForLogEntry(
        lane.auditLogPath,
        (e) => e.event === 'session_get' && e.sessionId === childId && e.pid !== forkServePid,
        'post-restart resume probe of the child on the new serve',
        60_000,
      )
      await expect
        .poll(async () => (await paneLeaf(harness2, tabId2))?.content?.sessionId ?? null, { timeout: 60_000 })
        .toBe(childId)

      // AGENT-07 (a′ cont., D1-F3): after the abrupt restart the SOURCE resumes
      // too — the pane proves the CHILD, this attach proves the SOURCE (resume
      // probe on the new serve process, full transcript still rendering).
      const sourceRestartWs = new WsCapture(lane.info.baseUrl, lane.info.token)
      await sourceRestartWs.ready()
      sourceRestartWs.send({
        type: 'freshAgent.attach',
        provider: 'opencode',
        sessionId: parentId,
        sessionType: 'freshopencode',
        cwd: lane.projectDir,
        sessionRef: { provider: 'opencode', sessionId: parentId },
      })
      await expect
        .poll(
          () => readOpencodeAudit(lane.auditLogPath)
            .slice(auditCountBeforeRestart)
            .some((e) => e.event === 'session_get' && e.sessionId === parentId && e.pid !== forkServePid),
          { timeout: 60_000, message: 'post-restart resume probe of the SOURCE on the new serve' },
        )
        .toBe(true)
      await expect(async () => {
        const snapshot = await fetchSnapshot(lane.info, 'freshopencode', 'opencode', parentId)
        expect(
          (snapshot?.turns ?? []).length,
          'the source transcript still renders both pre-fork turns post-restart',
        ).toBe(4)
      }).toPass({ timeout: 30_000 })
      await expect(async () => {
        const snapshot = await fetchSnapshot(lane.info, 'freshopencode', 'opencode', childId)
        expect(
          (snapshot?.turns ?? []).length,
          'the child transcript still renders exactly its fork-point history post-restart',
        ).toBe(2)
      }).toPass({ timeout: 30_000 })
      await expect
        .poll(() => {
          const post = readOpencodeAudit(lane.auditLogPath).slice(auditCountBeforeRestart)
          return [parentId, childId].every((id) =>
            post.some((e) => e.event === 'session_get' && e.sessionId === id)
            && post.some((e) => e.event === 'message_list' && e.sessionId === id))
        }, { timeout: 30_000, message: 'post-restart resume+read evidence for BOTH source and child' })
        .toBe(true)
      sourceRestartWs.close()
    } finally {
      await lane.server.stop().catch(() => {})
      await fs.rm(lane.sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })

  test('durable provider error projects into the transcript and survives reload', async ({ page }) => {
    const providerMessage = 'request deadline exceeded after 1195s before the response completed'
    const toolErrorMessage = 'The user has specified a rule which prevents you from using this specific tool call.'
    const lane = await bootOpencodeLane(page, {
      FAKE_OPENCODE_PROMPT_ERROR: providerMessage,
      FAKE_OPENCODE_TOOL_ERROR: toolErrorMessage,
    })
    try {
      await sendOpencodeTurn(
        page, lane.harness, lane.tabId, 'opencode error turn', 1, lane.auditLogPath,
        { expectResponseText: false },
      )

      // The snapshot refetch after idle carries the persisted info.error: the
      // activity-only errored turn mounts its own article + durable module.
      // Pre-fix (no errored-turn boundary) it merged into the first assistant
      // activity line and this locator never appeared.
      const transcript = page.locator('[data-context="fresh-agent-transcript"]')
      const errorModule = transcript.getByTestId('fresh-agent-turn-error')
      await expect(errorModule).toBeVisible({ timeout: 30_000 })
      await expect(errorModule).toContainText(providerMessage)
      await expect(errorModule).toContainText('request_deadline_exceeded')

      // The persisted tool-part state.error text is CLI-visible; the failed
      // tool row (single-tool strip) expands to show it.
      await transcript.getByRole('button', { name: 'Toggle activity details' }).first().click()
      await expect(transcript.locator('[data-tool-output]').first()).toContainText(toolErrorMessage)

      // Durability: both carriers re-derive from the REST snapshot after reload.
      await flushPersistence(page)
      await page.reload({ waitUntil: 'domcontentloaded' })
      const harness2 = new TestHarness(page)
      await harness2.waitForHarness()
      await harness2.waitForConnection()
      await expect(errorModule).toContainText(providerMessage, { timeout: 30_000 })
      await transcript.getByRole('button', { name: 'Toggle activity details' }).first().click()
      await expect(transcript.locator('[data-tool-output]').first()).toContainText(toolErrorMessage)

      // Wire-shape pin: the raw double-encoded provider payload survived as the
      // message, and the tool item carries the persisted error text.
      const sessionId = (await paneLeaf(harness2, (await harness2.getActiveTabId())!))?.content?.sessionId
      await expect(async () => {
        const snapshot = await fetchSnapshot(lane.info, 'freshopencode', 'opencode', sessionId)
        const erroredTurn = (snapshot?.turns ?? []).find((turn: any) => turn.error)
        expect(erroredTurn?.error?.name).toBe('UnknownError')
        expect(erroredTurn?.error?.message).toBe(
          JSON.stringify({ message: providerMessage, type: 'request_deadline_exceeded' }),
        )
        const toolErrorItem = (snapshot?.turns ?? [])
          .flatMap((turn: any) => turn.items ?? [])
          .find((item: any) => item.kind === 'dynamic_tool' && item.error)
        expect(toolErrorItem?.error).toBe(toolErrorMessage)
      }).toPass({ timeout: 30_000 })
    } finally {
      await lane.server.stop().catch(() => {})
      await fs.rm(lane.sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })

  test('a raw send during a parked compaction is queued and delivered after the compact settles', async ({ page }) => {
    // The gate dir BEFORE boot (the mkdtemp precedent in bootOpencodeLane).
    const gateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-agentctl-opencode-'))
    const gatePath = path.join(gateDir, 'release-summarize.flag')
    const lane = await bootOpencodeLane(page, { FAKE_OPENCODE_HOLD_SUMMARIZE_GATE_PATH: gatePath })
    const tabId = lane.tabId
    try {
      // Materialize + idle (the existing helper returns the durable ses_* id).
      const sessionId = await sendOpencodeTurn(page, lane.harness, tabId, 'first turn before compact', 1, lane.auditLogPath)

      // /compact through the composer (the compact-test precedent above): the
      // summarize POST parks on the gate file, so the compact drive is
      // deterministically in flight (the audit `summarize` entry lands at
      // REQUEST RECEIPT — the knob parks only the response).
      const paneRoot = page.locator('[data-context="fresh-agent"]').last()
      await paneRoot.getByRole('textbox', { name: 'Chat message input' }).fill('/compact')
      await paneRoot.getByRole('textbox', { name: 'Chat message input' }).press('Enter')
      await waitForLogEntry(
        lane.auditLogPath,
        (e) => e.event === 'summarize',
        'the parked compact\'s summarize receipt',
      )

      // A raw WS send — the server-side queue seam, deterministic while the
      // compact is parked (the browser's own composer would busy-gate it).
      // The frame is deliberately UNFENCED (no observed pair): the drain's
      // unfenced tolerance is the direct path's own tolerance, and this e2e
      // pins exactly that end-to-end.
      const frame = {
        type: 'freshAgent.send',
        requestId: 'e2e-queued-during-compact',
        sessionId,
        sessionType: 'freshopencode',
        provider: 'opencode',
        text: 'sent while compacting',
      }
      await page.evaluate((f) => {
        window.__FRESHELL_TEST_HARNESS__?.sendWsMessage(f)
      }, frame)
      // SYNC 1: the frame provably left the page (the harness records every
      // client-sent frame, injected ones included — only from the real
      // socket send path). The read is ASYNC (a page.evaluate wrapper) — it
      // MUST be awaited INSIDE the poll callback.
      await expect
        .poll(async () =>
          (await lane.harness.getSentWsMessagesWithTimestamps())
            .some((m) => m.requestId === 'e2e-queued-during-compact'))
        .toBe(true)

      // SYNC 1.5 (delta-review round 8, extension 2, Minor): the frame
      // leaving the browser proves nothing about the SERVER - under
      // cloud scheduling the server's handling could lag past the fixed
      // dwell below, the gate would release first, and the send could
      // take the ordinary direct path while the test still passed. The
      // requestId-correlated freshAgent.send.accepted ack proves the
      // server PROCESSED the send while the compact was still parked
      // (the negative hold below proves the compact was parked at the
      // same moment) - together they pin the queued path, not just an
      // eventually-delivered message.
      await expect
        .poll(async () =>
          ((await lane.harness.getReceivedWsMessages()) as Array<{
            type?: string
            requestId?: string
          }>).some(
            (m) =>
              m.type === 'freshAgent.send.accepted' &&
              m.requestId === 'e2e-queued-during-compact',
          ))
        .toBe(true)

      // SYNC 2 + the NEGATIVE HOLD: the compact is provably STILL parked —
      // the knob holds back the summarize response AND its idle emission,
      // so while the gate is held the audit can contain NO
      // session_idle_emitted after the summarize receipt: an ungated
      // compact answers within ~25ms and its idle lands long before this
      // check (exactly the round-2 vacuity finding this kills). (The plan
      // sketch's stat(gatePath) parked-proof was unsatisfiable as written —
      // under the consume-on-release knob the gate file cannot exist while
      // parked, since only the test writes it, at release; the
      // no-idle-after-receipt check is the honest replacement. Counting
      // audit events generally does NOT prove parked-ness — the fixture
      // records many event kinds per session — but the idle emission is
      // the exact artifact the knob parks.) Dwell a bounded 1.5s inside
      // that provably-parked window, then assert the queued prompt NEVER
      // posted. (A single immediate poll would be vacuous — absence after
      // positive syncs plus a bounded dwell while the gate is verifiably
      // held is the honest negative form.)
      await page.waitForTimeout(1_500)
      const auditWhileParked = readOpencodeAudit(lane.auditLogPath)
      const summarizeReceiptIx = auditWhileParked.findIndex((e) => e.event === 'summarize')
      expect(
        auditWhileParked
          .slice(summarizeReceiptIx + 1)
          .filter((e) => e.event === 'session_idle_emitted'),
        'no idle emission after the summarize receipt — the compact is still parked',
      ).toHaveLength(0)
      expect(auditWhileParked.some(
        (e) => e.event === 'prompt_async' && e.prompt === 'sent while compacting')).toBe(false)

      // Release: the compact settles, the drain drives the queued send.
      await fs.writeFile(gatePath, 'release')
      await waitForLogEntry(lane.auditLogPath,
        (e) => e.event === 'prompt_async' && e.prompt === 'sent while compacting',
        'the queued send drains after the compact settles')
      // ORDER: the compact's summarize POST happened BEFORE the queued prompt.
      const all = readOpencodeAudit(lane.auditLogPath)
      const summarizeIx = all.findIndex((e) => e.event === 'summarize')
      const queuedIx = all.findIndex((e) => e.event === 'prompt_async' && e.prompt === 'sent while compacting')
      expect(queuedIx).toBeGreaterThan(summarizeIx)

      await waitForPaneStatus(lane.harness, tabId, 'idle')
    } finally {
      await lane.server.stop().catch(() => {})
      await fs.rm(lane.sharedRoot, { recursive: true, force: true }).catch(() => {})
      await fs.rm(gateDir, { recursive: true, force: true }).catch(() => {})
    }
  })

  test('a composer-typed message during a parked compaction is held, flushed on idle, and renders as a turn', async ({ page }) => {
    const gateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-agentctl-opencode-'))
    const gatePath = path.join(gateDir, 'release-summarize.flag')
    const lane = await bootOpencodeLane(page, { FAKE_OPENCODE_HOLD_SUMMARIZE_GATE_PATH: gatePath })
    const tabId = lane.tabId
    try {
      await sendOpencodeTurn(page, lane.harness, tabId, 'first turn before compact', 1, lane.auditLogPath)
      const paneRoot = page.locator('[data-context="fresh-agent"]').last()
      await paneRoot.getByRole('textbox', { name: 'Chat message input' }).fill('/compact')
      await paneRoot.getByRole('textbox', { name: 'Chat message input' }).press('Enter')
      await waitForLogEntry(
        lane.auditLogPath,
        (e) => e.event === 'summarize',
        'the parked compact\'s summarize receipt',
      )

      // THE USER STORY: type while the compact is parked. The composer stays
      // interactive; the client's own queue holds the message (busy).
      await sendComposerText(page, 'typed while compacting')
      // Held client-side: no prompt audit while parked.
      await page.waitForTimeout(1_500)
      expect(readOpencodeAudit(lane.auditLogPath).some(
        (e) => e.event === 'prompt_async' && e.prompt === 'typed while compacting')).toBe(false)

      // Release: the compact settles → idle → the client flushes → the
      // message POSTs → the pane renders the turn AND the assistant reply
      // (the sendOpencodeTurn response-text convention).
      await fs.writeFile(gatePath, 'release')
      await waitForLogEntry(lane.auditLogPath,
        (e) => e.event === 'prompt_async' && e.prompt === 'typed while compacting',
        'the held message flushes after the compact settles')
      await expect(paneRoot).toContainText('Fake OpenCode response: typed while compacting', { timeout: 30_000 })
      await waitForPaneStatus(lane.harness, tabId, 'idle')
    } finally {
      await lane.server.stop().catch(() => {})
      await fs.rm(lane.sharedRoot, { recursive: true, force: true }).catch(() => {})
      await fs.rm(gateDir, { recursive: true, force: true }).catch(() => {})
    }
  })
})
