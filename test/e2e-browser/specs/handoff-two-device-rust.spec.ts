/**
 * HANDOFF TWO-DEVICE (kata b8ke, Task 11) — the cross-device atomic handoff
 * proof against the REAL Rust server + REAL SPA.
 *
 * Two SEPARATE BrowserContexts (distinct localStorage ⇒ distinct durable
 * `freshell.device-id.v2` device ids — two pages in one context are NOT
 * sufficient, they share device identity). The desktop context creates the
 * fresh-agent pane and drives the reopen; the phone context opens the SAME
 * durable session from the sidebar (the auto-tagged sessionType routes
 * openSessionTab through buildResumeContent — same sessionRef, no manual
 * session-id plumbing) and must converge to the "open as a terminal"
 * state when the desktop reopens the session as its CLI.
 *
 *   1. codex: dual-role CODEX_CMD shim (fake app-server + fake terminal
 *      CLI). Desktop reopens as Codex CLI; the exact durable thread id is
 *      resumed by the terminal lane, the phone pane converges with the
 *      divergence card, no sidecar resurrection past the handmark, exactly
 *      one runtime owner, and the coordinator log proves the prior sidecar
 *      was reaped BEFORE the terminal spawn (the fake app-server has no
 *      writer-lock modeling — ordering is assertable only on the
 *      coordinator's `freshell_ownership` log events, per the T2
 *      validation's fake-fidelity caveats).
 *   2. opencode: dual-role OPENCODE_CMD shim (fake serve daemon + fake
 *      terminal CLI). The shared `opencode serve` daemon is never the
 *      per-session writer that gets killed: exactly one serve launch row,
 *      zero shutdown rows, its pid still alive after the handoff; the
 *      ses_* id is resumed exactly; no duplicate session.
 *   3. offline/reconnect: the phone context goes offline (setOffline(true),
 *      a context-scoped network blackhole that does NOT close an
 *      established WebSocket — T5 probe-proven) AND drops its WebSocket
 *      (harness.forceDisconnect()) BEFORE the desktop completes the
 *      handoff. After setOffline(false) the reconnect backoff lands a REAL
 *      ready-cycle; the phone reads the authoritative owner from the
 *      ready.runtimeOwners replay (never recreates its stale fresh-agent
 *      flavor) and CAN attach — the card's Attach here lands a terminal
 *      pane with the same terminalId, no new spawn.
 *
 * Rust-only: registered in RUST_ONLY_SPECS + the rust-chromium testMatch
 * (BOTH — a missing entry silently runs zero tests). Cloud-legal by design
 * (fake CLIs only — never added to CLOUD_SKIP_SPECS).
 *
 * Helpers are copied, not imported, per the e2e suite's per-spec-ownership
 * convention (donors: reconcile-completion-rust.spec.ts,
 * fresh-agent-control-rust.spec.ts, codex-status-completeness-rust.spec.ts,
 * freshagent-settings-resume-rust.spec.ts).
 */
import { test, expect } from '../helpers/fixtures.js'
import { RustServer } from '../helpers/rust-server.js'
import type { E2eServerInfo } from '../helpers/server-fixture-support.js'
import { TestHarness } from '../helpers/test-harness.js'
import { openPanePicker } from '../helpers/pane-picker.js'
import { installRecoveryOfferAutoDeclineOnContext } from '../helpers/recovery-offer.js'
import { installDualRoleCodexCli } from '../fixtures/codex-dual-role.js'
import { installDualRoleOpencodeCli } from '../fixtures/opencode-dual-role.js'
import fs from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, BrowserContext, Page } from '@playwright/test'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const FAKE_CODEX_TERMINAL = path.resolve(__dirname, '../fixtures/fake-codex-cli.mjs')
const FAKE_OPENCODE_TERMINAL = path.resolve(__dirname, '../fixtures/fake-opencode-terminal.mjs')

// A fixed, distinctive durable thread id for the codex lane (the fake
// app-server mints this via behavior.threadStartThreadId; any non-empty
// non-placeholder id is a durable codex session id client-side).
const CODEX_THREAD_ID = 'thread-b8ke-two-device'

// ---------------------------------------------------------------------------
// Copied helpers (per-spec copies — see file doc comment)
// ---------------------------------------------------------------------------

/** Read a JSONL log as parsed rows ([] when absent/unparseable). */
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

/** Poll a JSONL log until a row matches `pred` (never a bare fixed sleep). */
async function waitForJsonlRow(
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

/** The Rust server's structured JSONL log rows (logging.rs schema). */
function readServerLogRows(info: E2eServerInfo): any[] {
  return readJsonl(path.join(info.logsDir, 'rust-server.jsonl'))
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

/**
 * Idempotent .freshell/config.json seed (donor: reconcile-completion-rust)
 * PLUS the provider watch-root pre-creation this spec's mid-test artifacts
 * need: the session watcher arms at boot, and the fake CLIs create their
 * session stores MID-TEST (the rollout dirs on the first codex turn; the
 * opencode db on the first pane create). Pre-creating the layout's watch
 * bases means those writes land in already-watched dirs (the recursive
 * codex watch follows the new date subdirs; the non-recursive opencode
 * watch sees the db file) instead of waiting out the 15-minute index TTL.
 */
function seedSpecConfig(input: {
  providers: string[]
  freshAgent?: boolean
  preCreateDirs?: string[]
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
    for (const dir of input.preCreateDirs ?? []) {
      await fs.mkdir(path.join(homeDir, dir), { recursive: true })
    }
  }
}

/**
 * Seed ~/.codex/sessions/<id>.jsonl so both devices' sidebars list a
 * resumable codex TERMINAL session (the wall spec's seedCodexHome shape,
 * copied per the suite's per-spec-ownership convention): config.json with
 * codex-only providers plus a titled session transcript.
 */
function seedFenceHealCodexHome(
  sessionId: string,
  sessionTitle: string,
  projectDir: string,
): (homeDir: string) => Promise<void> {
  return async (homeDir: string) => {
    await seedSpecConfig({ providers: ['codex'] })(homeDir)
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

/**
 * The fake app-server's rollout path for a thread (its own
 * rolloutFilename/getRolloutSessionDir: UTC-dated dir, percent-encoded id).
 */
function codexRolloutPath(homeDir: string, threadId: string): string {
  const now = new Date()
  const yyyy = String(now.getUTCFullYear())
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(now.getUTCDate()).padStart(2, '0')
  return path.join(
    homeDir, '.codex', 'sessions', yyyy, mm, dd,
    `rollout-${encodeURIComponent(threadId)}.jsonl`,
  )
}

/**
 * The fake app-server writes ONLY the session_meta line to the rollout — a
 * session with no first user message stays UNTITLED, and the default
 * sidebar window hides untitled sessions (`hideEmptySessions: true`).
 * Append the turn's user-message record (the same shape the codex-status
 * donor seeds) so the indexer extracts a REAL title and the phone's sidebar
 * actually lists the session.
 */
async function giveCodexRolloutATitle(homeDir: string, threadId: string, turnText: string): Promise<void> {
  const rolloutPath = codexRolloutPath(homeDir, threadId)
  // The fake writes the rollout after the turn/start response: wait for its
  // write before appending, so the append can never race the mkdir+write.
  await expect
    .poll(async () => existsSync(rolloutPath), {
      timeout: 20_000,
      message: `timed out waiting for the fake's rollout at ${rolloutPath}`,
    })
    .toBe(true)
  await fs.appendFile(
    rolloutPath,
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: turnText }],
      },
    })}\n`,
  )
}

// --- layout walkers (donor: reconcile-completion-rust.spec.ts) ---

function collectLeaves(node: any): any[] {
  if (!node) return []
  if (node.type === 'leaf') return [node]
  if (node.type === 'split') return (node.children ?? []).flatMap(collectLeaves)
  return []
}

function findLeafByPaneId(layout: any, paneId: string): any {
  return collectLeaves(layout).find((leaf) => leaf?.id === paneId) ?? null
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

/** The fresh-agent pane's DURABLE identity: sessionRef.sessionId. */
async function freshAgentDurableRef(harness: TestHarness, tabId: string): Promise<string | null> {
  return findFreshAgentLeaf(await harness.getPaneLayout(tabId))?.content?.sessionRef?.sessionId ?? null
}

// --- fresh-agent pane helpers (donor: fresh-agent-control-rust.spec.ts) ---

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

/** Fill the visible fresh-agent composer and click Send. */
async function sendComposerText(page: Page, text: string): Promise<void> {
  const paneRoot = page.locator('[data-context="fresh-agent"]').last()
  const composer = paneRoot.getByRole('textbox', { name: 'Chat message input' })
  await composer.fill(text)
  await paneRoot.getByRole('button', { name: 'Send' }).click()
}

async function waitForPaneLeafStatus(
  harness: TestHarness,
  tabId: string,
  wanted: string,
  timeoutMs = 30_000,
): Promise<void> {
  await expect
    .poll(
      async () => findFreshAgentLeaf(await harness.getPaneLayout(tabId))?.content?.status ?? null,
      { timeout: timeoutMs },
    )
    .toBe(wanted)
}

// --- two-device harness (donor: settings-split-rust.spec.ts's contexts) ---

/**
 * A DEVICE: its own BrowserContext (⇒ its own localStorage, its own durable
 * `freshell.device-id.v2`), with the recovery-offer auto-decline adopted
 * directly (manual newContext bypasses the fixture's context watcher).
 */
async function newDeviceContext(browser: Browser): Promise<BrowserContext> {
  const context = await browser.newContext()
  installRecoveryOfferAutoDeclineOnContext(context)
  return context
}

/** Open one device's page against the owned server and wait for the harness. */
async function openDevicePage(
  context: BrowserContext,
  info: E2eServerInfo,
  receivedFrames?: Array<Record<string, any>>,
): Promise<{ page: Page; harness: TestHarness }> {
  const page = await context.newPage()
  if (receivedFrames) {
    const ownedWsOrigin = info.baseUrl.replace(/^http/, 'ws')
    page.on('websocket', (socket) => {
      if (!socket.url().startsWith(ownedWsOrigin)) return
      socket.on('framereceived', ({ payload }) => {
        try {
          const frame = JSON.parse(String(payload))
          if (frame && typeof frame === 'object' && !Array.isArray(frame)) {
            receivedFrames.push(frame as Record<string, any>)
          }
        } catch {
          // Ignore protocol frames that are not JSON.
        }
      })
    })
  }
  await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
  // The server-owned machine registry gates every fresh context's boot: a
  // server that already registered a machine (this spec's FIRST device
  // auto-creates one — a fresh context's localStorage holds no selection)
  // shows the "Choose a machine" dialog to every later fresh-context page,
  // and the machine gate blocks the WS transport while the dialog shows.
  // Answer it with the REAL "Add this machine" affordance: the submit
  // registers a fresh machine for this context (each device stays its OWN
  // machine — machine-identity.ts resolves the deviceId from the machine
  // id) and reloads; the next boot resolves with the persisted selection.
  // Best-effort by contract (the installRecoveryOfferAutoDecline pattern):
  // a dialog that never shows is a no-op, and a failed answer falls
  // through to waitForHarness/waitForConnection's own diagnostics.
  const machineChooser = page.getByRole('dialog', { name: 'Choose a machine' })
  await page
    .waitForFunction(
      () =>
        Boolean(
          document.querySelector('[data-testid="sidebar-session-list"]')
            || (document.querySelector('section[role="dialog"]')?.textContent ?? '').includes('Choose a machine'),
        ),
      undefined,
      { timeout: 15_000 },
    )
    .catch(() => {})
  if (await machineChooser.isVisible().catch(() => false)) {
    await page.getByRole('button', { name: 'Add this machine' }).click()
    // The chooser's submit reloads the page; the reloaded boot resolves the
    // machine identity from the persisted selection and mounts the app. A
    // failed answer falls through to waitForHarness/waitForConnection's own
    // diagnostics.
    await machineChooser.waitFor({ state: 'detached', timeout: 20_000 }).catch(() => {})
  }
  const harness = new TestHarness(page)
  await harness.waitForHarness()
  await harness.waitForConnection()
  return { page, harness }
}

/** The device's durable id (localStorage key freshell.device-id.v2). */
async function deviceId(page: Page): Promise<string | null> {
  return page.evaluate(() => localStorage.getItem('freshell.device-id.v2'))
}

/**
 * Poll the session directory (the server-global listing the phone's sidebar
 * renders from) until the durable session appears; returns its joined
 * sessionType — the desktop pane's fire-and-forget metadata tag that routes
 * the phone's sidebar open through the fresh-agent branch.
 */
async function waitForSessionDirectoryTag(
  info: E2eServerInfo,
  provider: string,
  sessionId: string,
  timeoutMs = 45_000,
): Promise<string> {
  let tagged: string | null = null
  await expect
    .poll(
      async () => {
        const res = await fetch(
          `${info.baseUrl}/api/session-directory?priority=visible&limit=50`,
          { headers: { 'x-auth-token': info.token } },
        )
        if (!res.ok) return null
        const body = (await res.json()) as { items?: Array<{ sessionId?: string; provider?: string; sessionType?: string }> }
        const item = (body.items ?? []).find(
          (i) => i.sessionId === sessionId && (i.provider ?? '') === provider,
        )
        tagged = item?.sessionType ?? null
        return tagged
      },
      { timeout: timeoutMs, message: `timed out waiting for ${provider}:${sessionId} in the session directory` },
    )
    .toBeTruthy()
  return tagged as string
}

/**
 * Open the durable session from the phone's SIDEBAR (the accessible
 * SidebarItem row) and settle the resulting fresh-agent pane on the SAME
 * sessionRef. Returns the session tab id + pane id.
 */
async function openSessionFromSidebar(
  page: Page,
  harness: TestHarness,
  sessionId: string,
  expectedSessionType: string,
): Promise<{ tabId: string; paneId: string }> {
  const sessionList = page.getByTestId('sidebar-session-list')
  await expect(sessionList).toBeVisible({ timeout: 15_000 })
  const row = sessionList.locator(`[data-session-id="${sessionId}"]`)
  await expect(row).toBeVisible({ timeout: 30_000 })
  await expect(row).toHaveAttribute('data-session-type', expectedSessionType)

  const tabCountBefore = await harness.getTabCount()
  await row.click()
  await expect(async () => {
    expect(await harness.getTabCount()).toBe(tabCountBefore + 1)
  }).toPass({ timeout: 15_000 })
  const tabId = (await harness.getActiveTabId())!
  expect(tabId).toBeTruthy()

  // The pane is a fresh-agent pane carrying the SAME durable sessionRef.
  const paneId = await expect
    .poll(async () => findFreshAgentLeaf(await harness.getPaneLayout(tabId))?.id ?? null, {
      timeout: 30_000,
    })
    .not.toBeNull()
    .then(async () => findFreshAgentLeaf(await harness.getPaneLayout(tabId))!.id)
  return { tabId, paneId }
}

/**
 * The reopen gesture: right-click the fresh-agent pane's transcript and
 * select the "Reopen as <CLI>" menu item (the ONE atomic server-side
 * handoff — ContextMenuProvider → runPaneSessionHandoff → POST
 * /api/sessions/handoff).
 */
async function reopenPaneAsCli(page: Page, menuItemName: RegExp): Promise<void> {
  const paneRoot = page.locator('[data-context="fresh-agent"]').last()
  // The transcript scroll region: right-clicking it (turn article or pane
  // background) opens the unified fresh-agent menu with the pane-level
  // reopen row. The composer sits BELOW this container and is never hit.
  const transcript = paneRoot.locator('.fresh-agent-transcript-scroll')
  await expect(transcript).toBeVisible({ timeout: 15_000 })
  await transcript.click({ button: 'right' })
  const item = page.getByRole('menuitem', { name: menuItemName })
  await expect(item).toBeVisible({ timeout: 10_000 })
  await expect(item).toBeEnabled()
  await item.click()
  await expect(page.getByRole('menu')).toHaveCount(0, { timeout: 10_000 })
}

/**
 * The STABLE-COUNT settle idiom (donor: reconcile-completion-rust.spec.ts):
 * accept a sampled value only when two samples >= gapMs apart agree, so a
 * tail-latency straggler cannot make a count read low spuriously. This is
 * the "wait BEYOND the snapshot debounce + poll windows" leg.
 */
async function settledSample<T>(
  sample: () => Promise<T>,
  opts: { gapMs?: number; timeoutMs?: number; what?: string } = {},
): Promise<T> {
  const { gapMs = 5_000, timeoutMs = 90_000, what = 'sample' } = opts
  let settled: T | undefined
  let haveSettled = false
  await expect
    .poll(
      async () => {
        const first = await sample()
        await new Promise((resolve) => setTimeout(resolve, gapMs))
        const second = await sample()
        if (JSON.stringify(second) === JSON.stringify(first)) {
          settled = second
          haveSettled = true
          return true
        }
        return false
      },
      { timeout: timeoutMs, message: `timed out waiting for ${what} to settle (two samples ${gapMs}ms apart)` },
    )
    .toBe(true)
  expect(haveSettled).toBe(true)
  return settled as T
}

/** The codex fake's WRITER rows for a thread (thread/start|thread/resume;
 * thread/read snapshot fetches are side-effect-free GETs and excluded). */
function codexWriterRows(opLogPath: string, threadId: string): any[] {
  return readJsonl(opLogPath).filter(
    (row) =>
      (row?.method === 'thread/start' || row?.method === 'thread/resume') &&
      (row?.threadId === threadId || row?.params?.threadId === threadId),
  )
}

/** The fake codex terminal's spawn argv log rows. */
function codexTerminalSpawns(argvLogPath: string): Array<{ pid: number; t: number; argv: string[] }> {
  return readJsonl(argvLogPath)
}

/**
 * Unwrap a tracing field serialized through Rust's `Debug` for an
 * Option<String> (e.g. `Some("term-1")` -> `term-1`; `None` -> null) — the
 * handoff log's `runtime_id`/`live_session_key` fields use the `?` sigil.
 */
function debugOptionString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const match = value.match(/^Some\("(.*)"\)$/s)
  return match ? match[1] : null
}

/** Rows of the opencode serve fake's audit ledger, filtered by event. */
function opencodeAuditRows(auditLogPath: string, event: string): any[] {
  return readJsonl(auditLogPath).filter((row) => row?.event === event)
}

// ---------------------------------------------------------------------------
// The scenarios
// ---------------------------------------------------------------------------

test.describe('Session handoff across two devices (rust only)', () => {
  test.setTimeout(240_000)

  test('codex: reopen-as-CLI on desktop converges the phone pane and never double-writes', async ({
    browser,
  }) => {
    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-handoff2d-codex-'))
    const projectDir = path.join(sharedRoot, 'project')
    await fs.mkdir(projectDir, { recursive: true })
    const opLogPath = path.join(sharedRoot, 'codex-ops.jsonl')
    const termArgvLogPath = path.join(sharedRoot, 'codex-terminal-argv.jsonl')
    // Dual-role: the freshcodex lane boots a `codex app-server` sidecar and
    // the terminal lane spawns the `codex ... resume <id>` TUI from the SAME
    // CODEX_CMD — one shim routes both (codex-dual-role.ts).
    const fakeCodex = await installDualRoleCodexCli(
      path.join(sharedRoot, 'bin'),
      FAKE_CODEX_TERMINAL,
    )
    const server = new RustServer({
      env: {
        CODEX_CMD: fakeCodex,
        FAKE_CODEX_ARGV_LOG: termArgvLogPath,
        FAKE_CODEX_APP_SERVER_BEHAVIOR: JSON.stringify({
          threadStartThreadId: CODEX_THREAD_ID,
          appendThreadOperationLogPath: opLogPath,
          recordTurns: true,
        }),
      },
      setupHome: seedSpecConfig({
        providers: ['codex'],
        freshAgent: true,
        preCreateDirs: [path.join('.codex', 'sessions')],
      }),
    })
    let desktopCtx: BrowserContext | null = null
    let phoneCtx: BrowserContext | null = null
    try {
      const info = await server.start()
      desktopCtx = await newDeviceContext(browser)
      phoneCtx = await newDeviceContext(browser)
      const desktop = await openDevicePage(desktopCtx, info)
      const phone = await openDevicePage(phoneCtx, info)

      // Two contexts ⇒ two durable device ids (the cross-device premise).
      const desktopDeviceId = await deviceId(desktop.page)
      const phoneDeviceId = await deviceId(phone.page)
      expect(desktopDeviceId).toBeTruthy()
      expect(phoneDeviceId).toBeTruthy()
      expect(phoneDeviceId, 'two BrowserContexts must mint two device ids').not.toBe(desktopDeviceId)

      // 1. DESKTOP: create the freshcodex pane, run one turn (the durable
      // rollout + the sessionType tag land), capture the durable identity.
      await selectShellIfPickerShowing(desktop.page)
      await expect(desktop.page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })
      await enableClis(desktop.page, { codex: true })
      const desktopTabId = (await desktop.harness.getActiveTabId())!
      expect(desktopTabId).toBeTruthy()
      await createFreshAgentPane(desktop.page, /^Freshcodex$/, 'Freshcodex', projectDir)
      await waitForPaneLeafStatus(desktop.harness, desktopTabId, 'idle')
      await sendComposerText(desktop.page, 'two-device handoff turn one')
      // The turn's REAL completion gate (the fake answers turn/start
      // instantly, so the status poll alone can pass on the pre-turn
      // idle): the recorded turn renders as two snapshot rows.
      await expect
        .poll(
          async () =>
            await desktop.page
              .locator('[data-context="fresh-agent"]')
              .last()
              .locator('article[data-turn-index]')
              .count(),
          { timeout: 30_000 },
        )
        .toBeGreaterThanOrEqual(2)
      await expect
        .poll(async () => freshAgentDurableRef(desktop.harness, desktopTabId), { timeout: 20_000 })
        .toBe(CODEX_THREAD_ID)
      const desktopPaneId = findFreshAgentLeaf(
        await desktop.harness.getPaneLayout(desktopTabId),
      )!.id
      // The rollout the fake wrote carries only session_meta; give the
      // session a REAL title (the turn's user record) so the default
      // sidebar window lists it for the phone.
      await giveCodexRolloutATitle(info.homeDir, CODEX_THREAD_ID, 'two-device handoff turn one')

      // 2. PHONE: the session is listed with the pane's auto-tagged
      // sessionType; opening it from the sidebar lands a freshcodex pane
      // with the SAME sessionRef.
      const tagged = await waitForSessionDirectoryTag(info, 'codex', CODEX_THREAD_ID)
      expect(tagged).toBe('freshcodex')
      const phoneSession = await openSessionFromSidebar(phone.page, phone.harness, CODEX_THREAD_ID, 'freshcodex')
      await expect
        .poll(async () => freshAgentDurableRef(phone.harness, phoneSession.tabId), { timeout: 45_000 })
        .toBe(CODEX_THREAD_ID)
      await waitForPaneLeafStatus(phone.harness, phoneSession.tabId, 'idle', 45_000)

      // Restart the owned server while both devices remain mounted. The
      // reconnect must use the new boot/owner authority without replacing the
      // durable conversation, and a subsequent turn must remain visible on
      // both devices.
      const readyBeforeRestart = await Promise.all([
        desktop.page.evaluate(() => ({
          lastReadyAt: (window as any).__FRESHELL_TEST_HARNESS__?.getState?.()?.connection?.lastReadyAt ?? null,
          bootId: (window as any).__FRESHELL_TEST_HARNESS__?.getState?.()?.connection?.bootId ?? null,
        })),
        phone.page.evaluate(() => ({
          lastReadyAt: (window as any).__FRESHELL_TEST_HARNESS__?.getState?.()?.connection?.lastReadyAt ?? null,
          bootId: (window as any).__FRESHELL_TEST_HARNESS__?.getState?.()?.connection?.bootId ?? null,
        })),
      ])
      await server.restart()
      await expect(async () => {
        const current = await desktop.page.evaluate(() => ({
          ws: (window as any).__FRESHELL_TEST_HARNESS__?.getWsReadyState?.() ?? null,
          lastReadyAt: (window as any).__FRESHELL_TEST_HARNESS__?.getState?.()?.connection?.lastReadyAt ?? null,
          bootId: (window as any).__FRESHELL_TEST_HARNESS__?.getState?.()?.connection?.bootId ?? null,
        }))
        expect(current.ws).toBe('ready')
        expect(String(current.lastReadyAt)).not.toBe(String(readyBeforeRestart[0].lastReadyAt))
        expect(current.bootId).not.toBe(readyBeforeRestart[0].bootId)
      }).toPass({ timeout: 60_000 })
      await expect(async () => {
        const current = await phone.page.evaluate(() => ({
          ws: (window as any).__FRESHELL_TEST_HARNESS__?.getWsReadyState?.() ?? null,
          lastReadyAt: (window as any).__FRESHELL_TEST_HARNESS__?.getState?.()?.connection?.lastReadyAt ?? null,
          bootId: (window as any).__FRESHELL_TEST_HARNESS__?.getState?.()?.connection?.bootId ?? null,
        }))
        expect(current.ws).toBe('ready')
        expect(String(current.lastReadyAt)).not.toBe(String(readyBeforeRestart[1].lastReadyAt))
        expect(current.bootId).not.toBe(readyBeforeRestart[1].bootId)
      }).toPass({ timeout: 60_000 })
      await expect
        .poll(async () => freshAgentDurableRef(desktop.harness, desktopTabId), { timeout: 45_000 })
        .toBe(CODEX_THREAD_ID)
      await expect
        .poll(async () => freshAgentDurableRef(phone.harness, phoneSession.tabId), { timeout: 45_000 })
        .toBe(CODEX_THREAD_ID)
      await waitForPaneLeafStatus(desktop.harness, desktopTabId, 'idle', 45_000)
      await waitForPaneLeafStatus(phone.harness, phoneSession.tabId, 'idle', 45_000)
      // Scope to the transcript: the session row button and the pane header
      // legitimately show the same text (the extracted session title IS the
      // turn text), so a page-global getByText would strict-violate on three
      // matches.
      await expect(
        desktop.page
          .locator('[data-context="fresh-agent"]')
          .last()
          .locator('.fresh-agent-transcript-scroll')
          .getByText('two-device handoff turn one', { exact: true }),
      ).toBeVisible({ timeout: 30_000 })
      await expect(
        phone.page
          .locator('[data-context="fresh-agent"]')
          .last()
          .locator('.fresh-agent-transcript-scroll')
          .getByText('two-device handoff turn one', { exact: true }),
      ).toBeVisible({ timeout: 30_000 })
      await sendComposerText(desktop.page, 'two-device handoff turn after restart')
      await expect
        .poll(
          async () => await desktop.page.locator('[data-context="fresh-agent"]').last().locator('article[data-turn-index]').count(),
          { timeout: 30_000 },
        )
        .toBeGreaterThanOrEqual(3)
      await expect
        .poll(
          async () => await phone.page.locator('[data-context="fresh-agent"]').last().locator('article[data-turn-index]').count(),
          { timeout: 30_000 },
        )
        .toBeGreaterThanOrEqual(3)

      // The watermarks: everything the phone's pane did to adopt the live
      // session is BEFORE this point; post-handmark writer rows are the
      // sidecar-resurrection failure mode.
      const writerRowsBefore = codexWriterRows(opLogPath, CODEX_THREAD_ID).length
      expect(writerRowsBefore).toBeGreaterThan(0)

      // 3. DESKTOP: Reopen as Codex CLI (the ONE atomic server-side handoff).
      await reopenPaneAsCli(desktop.page, /^Reopen as Codex CLI$/i)

      // 4. The desktop pane is now a TERMINAL pane whose sessionRef is the
      // EXACT original thread id, with a live terminalId.
      const desktopTerminalLeaf = await expect
        .poll(async () => {
          const leaf = findLeafByPaneId(
            await desktop.harness.getPaneLayout(desktopTabId),
            desktopPaneId,
          )
          return leaf?.content?.kind === 'terminal' && leaf?.content?.terminalId ? leaf : null
        }, { timeout: 45_000 })
        .not.toBeNull()
        .then(async () =>
          findLeafByPaneId(await desktop.harness.getPaneLayout(desktopTabId), desktopPaneId)!)
      expect(desktopTerminalLeaf.content.mode).toBe('codex')
      expect(desktopTerminalLeaf.content.sessionRef?.provider).toBe('codex')
      expect(desktopTerminalLeaf.content.sessionRef?.sessionId).toBe(CODEX_THREAD_ID)
      const handoffTerminalId = desktopTerminalLeaf.content.terminalId as string

      // 5. The terminal lane resumed the EXACT original thread id: the fake
      // TUI's resume marker in the live buffer, and no launch failure.
      await expect
        .poll(
          async () =>
            ((await desktop.harness.getTerminalBuffer(handoffTerminalId)) ?? '').replace(/\n/g, ''),
          { timeout: 20_000 },
        )
        .toContain(`codex: resumed session ${CODEX_THREAD_ID}`)
      const desktopBuffer = ((await desktop.harness.getTerminalBuffer(handoffTerminalId)) ?? '').replace(/\n/g, '')
      expect(desktopBuffer).not.toContain('[Launch failed]')

      // 6. PHONE convergence: the matching fresh-agent pane shows the
      // "open as a terminal" divergence card (role=alert) — polling stopped,
      // no pane reset.
      const phoneCard = phone.page.getByRole('alert', {
        name: 'Session open as a terminal on another device',
      })
      await expect(phone.page.locator('[data-agent-error="owner"] summary')).toBeVisible({ timeout: 45_000 })
      await phone.page.locator('[data-agent-error="owner"] summary').click()
      await expect(phoneCard).toBeVisible({ timeout: 45_000 })

      // 7. Wait BEYOND the snapshot debounce + poll windows: the writer-row
      // count for the identity must be stable across two samples >=5s apart
      // (no fresh-agent resume — no sidecar resurrection from the phone).
      const settledWriterRows = await settledSample(
        async () => codexWriterRows(opLogPath, CODEX_THREAD_ID).length,
        { what: 'codex writer rows post-handmark' },
      )
      expect(
        settledWriterRows,
        'no post-handmark fresh-agent thread/start|thread/resume for the identity',
      ).toBe(writerRowsBefore)

      // 8. Exactly ONE terminal-lane resume spawn for the identity, and no
      // identity-less spawns (the managed-proxy resume vehicle under fakes:
      // the terminal PTY argv — the app-server op log carries no
      // terminal-lane thread/resume because the fake TUI's resume marker is
      // the only resume vehicle, per the T2 fake-fidelity caveats).
      const spawns = codexTerminalSpawns(termArgvLogPath)
      const resumeSpawns = spawns.filter(
        (s) => Array.isArray(s?.argv) && s.argv[s.argv.indexOf('resume') + 1] === CODEX_THREAD_ID,
      )
      expect(resumeSpawns, 'exactly one terminal resume spawn for the identity').toHaveLength(1)
      expect(
        spawns.filter((s) => !s.argv.includes('resume')),
        'no identity-less fresh codex terminal spawns',
      ).toHaveLength(0)

      // 9. Exactly one runtime owner — the coordinator's committed
      // handoff.done row for this session, with the terminal's runtime id,
      // and ZERO stale-generation invariants for it.
      const doneRows = () =>
        readServerLogRows(info).filter(
          (row) =>
            row?.event === 'ownership.handoff.done' &&
            row?.provider === 'codex' &&
            row?.session_id === CODEX_THREAD_ID,
        )
      await waitForJsonlRow(
        path.join(info.logsDir, 'rust-server.jsonl'),
        (row) => row?.event === 'ownership.handoff.done' && row?.session_id === CODEX_THREAD_ID,
        'ownership.handoff.done for the codex identity',
        30_000,
      )
      const committedRows = doneRows().filter((row) => row?.outcome === 'committed')
      expect(committedRows, 'exactly one committed handoff for the session').toHaveLength(1)
      expect(debugOptionString(committedRows[0].runtime_id)).toBe(handoffTerminalId)
      expect(
        readServerLogRows(info).filter(
          (row) => row?.event === 'ownership.commit_live.stale_generation' && row?.session_id === CODEX_THREAD_ID,
        ),
        'zero stale-generation commits for the session',
      ).toHaveLength(0)

      // 10. Reap-before-start ordering (coordinator log only — the fake
      // app-server models no writer lock, per the T2 caveats): the prior
      // freshcodex sidecar was CONFIRMED reaped before the terminal spawn,
      // and the spawn before the commit.
      const reapTs = await waitForJsonlRow(
        path.join(info.logsDir, 'rust-server.jsonl'),
        (row) =>
          row?.msg === 'freshagent.sidecar.reaped' &&
          row?.session_id === CODEX_THREAD_ID,
        'freshagent.sidecar.reaped for the codex identity',
        30_000,
      ).then((row) => Date.parse(row.ts))
      const spawnTs = await waitForJsonlRow(
        path.join(info.logsDir, 'rust-server.jsonl'),
        (row) => row?.msg === 'terminal.created' && row?.terminal_id === handoffTerminalId,
        'terminal.created for the handoff terminal',
        30_000,
      ).then((row) => Date.parse(row.ts))
      expect(reapTs, 'the old sidecar was reaped before the terminal spawn').toBeLessThanOrEqual(spawnTs)
      expect(spawnTs, 'the terminal spawned before the owner commit').toBeLessThanOrEqual(
        Date.parse(committedRows[0].ts),
      )

      // 11. The phone's divergence card carries a DIRECT attach action:
      // clicking it lands the pane on the terminal-owned runtime (the SAME
      // terminalId, keeping the exact sessionRef) — a pure same-mode
      // attach: no new terminal spawn, no fresh-agent writer rows.
      await phone.page.getByRole('button', { name: 'Attach the terminal here' }).click()
      const attachedLeaf = await expect
        .poll(async () => {
          const leaf = findLeafByPaneId(
            await phone.harness.getPaneLayout(phoneSession.tabId),
            phoneSession.paneId,
          )
          return leaf?.content?.kind === 'terminal' && leaf?.content?.terminalId ? leaf : null
        }, { timeout: 30_000 })
        .not.toBeNull()
        .then(async () =>
          findLeafByPaneId(await phone.harness.getPaneLayout(phoneSession.tabId), phoneSession.paneId)!)
      expect(attachedLeaf.content.mode).toBe('codex')
      expect(attachedLeaf.content.terminalId).toBe(handoffTerminalId)
      expect(attachedLeaf.content.sessionRef?.sessionId).toBe(CODEX_THREAD_ID)
      expect(codexTerminalSpawns(termArgvLogPath), 'the card attach spawned nothing').toHaveLength(spawns.length)
      expect(
        codexWriterRows(opLogPath, CODEX_THREAD_ID).length,
        'the card attach wrote no fresh-agent rows',
      ).toBe(settledWriterRows)
    } finally {
      await desktopCtx?.close().catch(() => {})
      await phoneCtx?.close().catch(() => {})
      await server.stop().catch(() => {})
      await fs.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })

  test('opencode: reopen-as-CLI keeps the shared serve daemon healthy and the ses_ id stable', async ({
    browser,
  }) => {
    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-handoff2d-opencode-'))
    const projectDir = path.join(sharedRoot, 'project')
    await fs.mkdir(projectDir, { recursive: true })
    const auditLogPath = path.join(sharedRoot, 'opencode-audit.jsonl')
    const termArgvLogPath = path.join(sharedRoot, 'opencode-terminal-argv.jsonl')
    // Dual-role: the shared `opencode serve` daemon AND the terminal
    // `opencode --session <id>` TUI are BOTH selected through OPENCODE_CMD
    // (opencode-dual-role.ts dispatches on the `serve` token).
    const fakeOpencode = await installDualRoleOpencodeCli(
      path.join(sharedRoot, 'bin'),
      FAKE_OPENCODE_TERMINAL,
    )
    const server = new RustServer({
      env: {
        PATH: `${path.join(sharedRoot, 'bin')}${path.delimiter}${process.env.PATH ?? ''}`,
        OPENCODE_CMD: fakeOpencode,
        FAKE_OPENCODE_AUDIT_LOG: auditLogPath,
        FAKE_OPENCODE_TERMINAL_ARGV_LOG: termArgvLogPath,
      },
      setupHome: seedSpecConfig({
        providers: ['opencode'],
        freshAgent: true,
        preCreateDirs: [path.join('.local', 'share', 'opencode')],
      }),
    })
    let desktopCtx: BrowserContext | null = null
    let phoneCtx: BrowserContext | null = null
    try {
      const info = await server.start()
      desktopCtx = await newDeviceContext(browser)
      phoneCtx = await newDeviceContext(browser)
      const desktopFrames: Array<Record<string, any>> = []
      const desktop = await openDevicePage(desktopCtx, info, desktopFrames)
      const phone = await openDevicePage(phoneCtx, info)

      expect(await deviceId(desktop.page)).not.toBe(await deviceId(phone.page))

      // 1. DESKTOP: freshopencode pane + one turn (the first send
      // materializes the durable ses_* row + the sessionType tag).
      await selectShellIfPickerShowing(desktop.page)
      await expect(desktop.page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })
      await enableClis(desktop.page, { opencode: true })
      const desktopTabId = (await desktop.harness.getActiveTabId())!
      expect(desktopTabId).toBeTruthy()
      await createFreshAgentPane(desktop.page, /^Freshopencode$/, 'Freshopencode', projectDir)
      await waitForPaneLeafStatus(desktop.harness, desktopTabId, 'idle')

      // The fresh OpenCode pane starts with an unmaterialized placeholder.
      // Observe the actual wire snapshot before sending a turn, then force
      // one real reconnect and require another snapshot for that same
      // placeholder. A placeholder attach is observation-only: neither cycle
      // may reserve a provider writer.
      const placeholderId = await expect
        .poll(async () => freshAgentDurableRef(desktop.harness, desktopTabId), { timeout: 20_000 })
        .toMatch(/^freshopencode-/)
        .then(async () => (await freshAgentDurableRef(desktop.harness, desktopTabId))!)
      const placeholderSnapshots = () => desktopFrames.filter(
        (frame) => frame.type === 'freshAgent.event'
          && frame.sessionId === placeholderId
          && frame.event?.type === 'freshAgent.session.snapshot',
      )
      const placeholderReservationErrors = () => desktopFrames.filter(
        (frame) => frame.type === 'freshAgent.event'
          && frame.sessionId === placeholderId
          && frame.event?.type === 'freshAgent.error'
          && frame.event?.code === 'SESSION_RESERVED',
      )
      await expect.poll(() => placeholderSnapshots().length, { timeout: 30_000 }).toBeGreaterThan(0)
      const snapshotsBeforeReconnect = placeholderSnapshots().length
      await expect.poll(() => placeholderReservationErrors().length).toBe(0)
      await desktop.harness.forceDisconnect()
      await expect
        .poll(() => placeholderSnapshots().length, { timeout: 30_000 })
        .toBeGreaterThan(snapshotsBeforeReconnect)
      expect(placeholderReservationErrors(), 'placeholder attaches never reserve a writer').toHaveLength(0)

      await sendComposerText(desktop.page, 'two-device opencode turn one')
      const sesId = await expect
        .poll(async () => freshAgentDurableRef(desktop.harness, desktopTabId), { timeout: 30_000 })
        .toMatch(/^ses_/)
        .then(async () => (await freshAgentDurableRef(desktop.harness, desktopTabId))!)
      await waitForPaneLeafStatus(desktop.harness, desktopTabId, 'idle')
      const desktopPaneId = findFreshAgentLeaf(
        await desktop.harness.getPaneLayout(desktopTabId),
      )!.id

      // 2. PHONE: the session is listed with the freshopencode tag; the
      // sidebar open lands a freshopencode pane on the SAME ses_* ref.
      const tagged = await waitForSessionDirectoryTag(info, 'opencode', sesId)
      expect(tagged).toBe('freshopencode')
      const phoneSession = await openSessionFromSidebar(phone.page, phone.harness, sesId, 'freshopencode')
      await expect
        .poll(async () => freshAgentDurableRef(phone.harness, phoneSession.tabId), { timeout: 45_000 })
        .toBe(sesId)
      await waitForPaneLeafStatus(phone.harness, phoneSession.tabId, 'idle', 45_000)

      const sessionCreatedBefore = opencodeAuditRows(auditLogPath, 'session_created').length

      // 3. DESKTOP: Reopen as OpenCode CLI.
      await reopenPaneAsCli(desktop.page, /^Reopen as OpenCode CLI$/i)

      // 4. Exact session resumption: the desktop pane is a terminal pane
      // with the SAME ses_* id and a live terminalId.
      const desktopTerminalLeaf = await expect
        .poll(async () => {
          const leaf = findLeafByPaneId(
            await desktop.harness.getPaneLayout(desktopTabId),
            desktopPaneId,
          )
          return leaf?.content?.kind === 'terminal' && leaf?.content?.terminalId ? leaf : null
        }, { timeout: 45_000 })
        .not.toBeNull()
        .then(async () =>
          findLeafByPaneId(await desktop.harness.getPaneLayout(desktopTabId), desktopPaneId)!)
      expect(desktopTerminalLeaf.content.mode).toBe('opencode')
      expect(desktopTerminalLeaf.content.sessionRef?.provider).toBe('opencode')
      expect(desktopTerminalLeaf.content.sessionRef?.sessionId).toBe(sesId)
      const handoffTerminalId = desktopTerminalLeaf.content.terminalId as string

      // No failed terminal pane: the fake TUI's resume marker renders.
      // Strip newlines before matching: xterm wraps long lines at the
      // terminal's column width (donor: opencode-terminal-restore).
      await expect
        .poll(
          async () =>
            ((await desktop.harness.getTerminalBuffer(handoffTerminalId)) ?? '').replace(/\n/g, ''),
          { timeout: 20_000 },
        )
        .toContain(`opencode: resumed session ${sesId}`)
      const desktopBuffer = ((await desktop.harness.getTerminalBuffer(handoffTerminalId)) ?? '').replace(/\n/g, '')
      expect(desktopBuffer).not.toContain('[Launch failed]')

      // 5. PHONE convergence: the divergence card.
      await expect(phone.page.locator('[data-agent-error="owner"] summary')).toBeVisible({ timeout: 45_000 })
      await phone.page.locator('[data-agent-error="owner"] summary').click()
      await expect(
        phone.page.getByRole('alert', { name: 'Session open as a terminal on another device' }),
      ).toBeVisible({ timeout: 45_000 })

      // 6. The shared serve daemon was never treated as the per-session
      // writer to kill: exactly one serve launch row, ZERO shutdown rows,
      // and that launch's pid is STILL alive.
      const serveLaunches = () =>
        opencodeAuditRows(auditLogPath, 'launch').filter((row) => (row?.argv ?? []).includes('serve'))
      await waitForJsonlRow(
        auditLogPath,
        (row) => row?.event === 'launch' && (row?.argv ?? []).includes('serve'),
        'the serve daemon launch row',
        15_000,
      )
      const settledServeLaunches = await settledSample(
        async () => serveLaunches().length,
        { what: 'serve daemon launch rows' },
      )
      expect(
        settledServeLaunches,
        'exactly one shared serve daemon launch, no respawn',
      ).toBe(1)
      expect(
        opencodeAuditRows(auditLogPath, 'shutdown'),
        'the shared serve daemon was never shut down',
      ).toHaveLength(0)
      const servePid = serveLaunches()[0]?.pid as number
      expect(servePid).toBeTruthy()
      expect(() => process.kill(servePid, 0), 'the serve daemon process is still alive').not.toThrow()

      // 7. No duplicate session: exactly one session_created row for the
      // whole journey (the desktop's first send), stable beyond the
      // debounce windows; the terminal lane resumed, never minted.
      const settledSessionCreations = await settledSample(
        async () => opencodeAuditRows(auditLogPath, 'session_created').length,
        { what: 'session_created rows' },
      )
      expect(settledSessionCreations).toBe(sessionCreatedBefore)
      expect(sessionCreatedBefore).toBe(1)
      const termSpawns = readJsonl(termArgvLogPath)
      const resumeSpawns = termSpawns.filter(
        (s: any) => Array.isArray(s?.argv) && s.argv[s.argv.indexOf('--session') + 1] === sesId,
      )
      expect(resumeSpawns, 'exactly one terminal resume spawn for the ses_* id').toHaveLength(1)
      expect(
        termSpawns.filter((s: any) => !(s?.argv ?? []).includes('--session')),
        'no fresh (identity-less) opencode terminal spawns',
      ).toHaveLength(0)

      // 8. Exactly one runtime owner: the committed coordinator row.
      await waitForJsonlRow(
        path.join(info.logsDir, 'rust-server.jsonl'),
        (row) => row?.event === 'ownership.handoff.done' && row?.session_id === sesId,
        'ownership.handoff.done for the opencode identity',
        30_000,
      )
      const committedRows = readServerLogRows(info).filter(
        (row) =>
          row?.event === 'ownership.handoff.done' &&
          row?.provider === 'opencode' &&
          row?.session_id === sesId &&
          row?.outcome === 'committed',
      )
      expect(committedRows, 'exactly one committed handoff for the session').toHaveLength(1)
      expect(debugOptionString(committedRows[0].runtime_id)).toBe(handoffTerminalId)
    } finally {
      await desktopCtx?.close().catch(() => {})
      await phoneCtx?.close().catch(() => {})
      await server.stop().catch(() => {})
      await fs.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })

  test('offline/reconnect: a disconnected device converges on reconnect without recreating its stale flavor', async ({
    browser,
  }) => {
    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-handoff2d-offline-'))
    const projectDir = path.join(sharedRoot, 'project')
    await fs.mkdir(projectDir, { recursive: true })
    const opLogPath = path.join(sharedRoot, 'codex-ops.jsonl')
    const termArgvLogPath = path.join(sharedRoot, 'codex-terminal-argv.jsonl')
    const fakeCodex = await installDualRoleCodexCli(
      path.join(sharedRoot, 'bin'),
      FAKE_CODEX_TERMINAL,
    )
    const server = new RustServer({
      env: {
        CODEX_CMD: fakeCodex,
        FAKE_CODEX_ARGV_LOG: termArgvLogPath,
        FAKE_CODEX_APP_SERVER_BEHAVIOR: JSON.stringify({
          threadStartThreadId: CODEX_THREAD_ID,
          appendThreadOperationLogPath: opLogPath,
          recordTurns: true,
        }),
      },
      setupHome: seedSpecConfig({
        providers: ['codex'],
        freshAgent: true,
        preCreateDirs: [path.join('.codex', 'sessions')],
      }),
    })
    let desktopCtx: BrowserContext | null = null
    let phoneCtx: BrowserContext | null = null
    try {
      const info = await server.start()
      desktopCtx = await newDeviceContext(browser)
      phoneCtx = await newDeviceContext(browser)
      const desktop = await openDevicePage(desktopCtx, info)
      const phone = await openDevicePage(phoneCtx, info)

      // Seed: desktop freshcodex pane + turn; phone opens the same session.
      await selectShellIfPickerShowing(desktop.page)
      await expect(desktop.page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })
      await enableClis(desktop.page, { codex: true })
      const desktopTabId = (await desktop.harness.getActiveTabId())!
      expect(desktopTabId).toBeTruthy()
      await createFreshAgentPane(desktop.page, /^Freshcodex$/, 'Freshcodex', projectDir)
      await waitForPaneLeafStatus(desktop.harness, desktopTabId, 'idle')
      await sendComposerText(desktop.page, 'offline handoff turn one')
      await expect
        .poll(
          async () =>
            await desktop.page
              .locator('[data-context="fresh-agent"]')
              .last()
              .locator('article[data-turn-index]')
              .count(),
          { timeout: 30_000 },
        )
        .toBeGreaterThanOrEqual(2)
      await expect
        .poll(async () => freshAgentDurableRef(desktop.harness, desktopTabId), { timeout: 20_000 })
        .toBe(CODEX_THREAD_ID)
      const desktopPaneId = findFreshAgentLeaf(
        await desktop.harness.getPaneLayout(desktopTabId),
      )!.id
      await giveCodexRolloutATitle(info.homeDir, CODEX_THREAD_ID, 'offline handoff turn one')

      await waitForSessionDirectoryTag(info, 'codex', CODEX_THREAD_ID)
      const phoneSession = await openSessionFromSidebar(phone.page, phone.harness, CODEX_THREAD_ID, 'freshcodex')
      await expect
        .poll(async () => freshAgentDurableRef(phone.harness, phoneSession.tabId), { timeout: 45_000 })
        .toBe(CODEX_THREAD_ID)
      await waitForPaneLeafStatus(phone.harness, phoneSession.tabId, 'idle', 45_000)

      // Watermarks while the phone is still connected.
      const phoneCreateSends = async () =>
        (await phone.harness.getSentWsMessages()).filter(
          (m: any) => m?.type === 'freshAgent.create',
        ).length
      const phoneCreatesBefore = await phoneCreateSends()
      expect(phoneCreatesBefore).toBeGreaterThan(0)
      const writerRowsBefore = codexWriterRows(opLogPath, CODEX_THREAD_ID).length
      const spawnsBefore = codexTerminalSpawns(termArgvLogPath).length

      // OFFLINE: setOffline alone is a context-scoped network blackhole that
      // does NOT close an established WebSocket (T5 probe-proven) — pair it
      // with the harness's forceDisconnect() for a true missed-broadcast +
      // reconnect journey.
      const lastReadyAtBefore = await phone.page.evaluate(
        () => (window as any).__FRESHELL_TEST_HARNESS__?.getState?.()?.connection?.lastReadyAt ?? null,
      )
      // Drop the WebSocket FIRST (while the network is up, so the close
      // handshake flushes and onclose fires — an offline-first close can
      // hang on the blackholed socket and never schedule the reconnect),
      // THEN blackhole the context so the reconnect attempts fail until
      // setOffline(false). The first attempt is >=1s out (the client's
      // base reconnect delay), far behind the offline call.
      await phone.harness.forceDisconnect()
      await phoneCtx.setOffline(true)

      // DESKTOP completes the reopen-as-CLI while the phone is offline.
      await reopenPaneAsCli(desktop.page, /^Reopen as Codex CLI$/i)
      const desktopTerminalLeaf = await expect
        .poll(async () => {
          const leaf = findLeafByPaneId(
            await desktop.harness.getPaneLayout(desktopTabId),
            desktopPaneId,
          )
          return leaf?.content?.kind === 'terminal' && leaf?.content?.terminalId ? leaf : null
        }, { timeout: 45_000 })
        .not.toBeNull()
        .then(async () =>
          findLeafByPaneId(await desktop.harness.getPaneLayout(desktopTabId), desktopPaneId)!)
      expect(desktopTerminalLeaf.content.sessionRef?.sessionId).toBe(CODEX_THREAD_ID)
      const handoffTerminalId = desktopTerminalLeaf.content.terminalId as string
      await expect
        .poll(
          async () =>
            ((await desktop.harness.getTerminalBuffer(handoffTerminalId)) ?? '').replace(/\n/g, ''),
          { timeout: 20_000 },
        )
        .toContain(`codex: resumed session ${CODEX_THREAD_ID}`)
      // The desktop's terminal-lane resume spawn is the ONLY new spawn the
      // handoff may add; everything after it must be pure attaches.
      const spawnsAfterHandoff = codexTerminalSpawns(termArgvLogPath).length
      expect(spawnsAfterHandoff).toBe(spawnsBefore + 1)

      // Wait past the debounce/poll windows while the phone is still offline.
      await settledSample(
        async () => codexWriterRows(opLogPath, CODEX_THREAD_ID).length,
        { what: 'codex writer rows while the phone is offline' },
      )

      // RECONNECT: the client's backoff lands a REAL ready cycle (a NEW
      // lastReadyAt — waitForWsReady alone would be vacuous if the socket
      // had never dropped, per the T5 probe).
      await phoneCtx.setOffline(false)
      await expect(async () => {
        const state = await phone.page.evaluate(() => {
          const harness = (window as any).__FRESHELL_TEST_HARNESS__
          return {
            ws: harness?.getWsReadyState?.() ?? null,
            lastReadyAt: harness?.getState?.()?.connection?.lastReadyAt ?? null,
          }
        })
        expect(state.ws).toBe('ready')
        expect(String(state.lastReadyAt)).not.toBe(String(lastReadyAtBefore))
      }).toPass({ timeout: 60_000 })

      // The phone's pane reads the authoritative owner from the
      // ready.runtimeOwners replay: the divergence card appears, the pane is
      // NOT reset to a fresh create (no freshAgent.create sent after the
      // reconnect, no new writer rows, no new spawns), and the pane kept its
      // fresh-agent kind (the reconcile respawn fold refused to reset the
      // divergent pane).
      const phoneCard = phone.page.getByRole('alert', {
        name: 'Session open as a terminal on another device',
      })
      await expect(phone.page.locator('[data-agent-error="owner"] summary')).toBeVisible({ timeout: 45_000 })
      await phone.page.locator('[data-agent-error="owner"] summary').click()
      await expect(phoneCard).toBeVisible({ timeout: 45_000 })
      const phoneLeaf = findLeafByPaneId(
        await phone.harness.getPaneLayout(phoneSession.tabId),
        phoneSession.paneId,
      )
      expect(phoneLeaf?.content?.kind).toBe('fresh-agent')

      const settledWriterRows = await settledSample(
        async () => codexWriterRows(opLogPath, CODEX_THREAD_ID).length,
        { what: 'codex writer rows across the reconnect window' },
      )
      expect(
        settledWriterRows,
        'no fresh-agent writer rows for the identity across the reconnect',
      ).toBe(writerRowsBefore)
      expect(await phoneCreateSends()).toBe(phoneCreatesBefore)
      expect(codexTerminalSpawns(termArgvLogPath)).toHaveLength(spawnsAfterHandoff)

      // The phone CAN attach: the card's Attach here lands a terminal pane
      // with the SAME terminalId (a pure attach — no new spawn).
      await phone.page.getByRole('button', { name: 'Attach the terminal here' }).click()
      const attachedLeaf = await expect
        .poll(async () => {
          const leaf = findLeafByPaneId(
            await phone.harness.getPaneLayout(phoneSession.tabId),
            phoneSession.paneId,
          )
          return leaf?.content?.kind === 'terminal' && leaf?.content?.terminalId ? leaf : null
        }, { timeout: 30_000 })
        .not.toBeNull()
        .then(async () =>
          findLeafByPaneId(await phone.harness.getPaneLayout(phoneSession.tabId), phoneSession.paneId)!)
      expect(attachedLeaf.content.terminalId).toBe(handoffTerminalId)
      expect(attachedLeaf.content.sessionRef?.sessionId).toBe(CODEX_THREAD_ID)
      // Same-mode multi-device attachment: the attach spawned nothing.
      expect(codexTerminalSpawns(termArgvLogPath)).toHaveLength(spawnsAfterHandoff)

      // Exactly one owner for the whole journey.
      const committedRows = readServerLogRows(info).filter(
        (row) =>
          row?.event === 'ownership.handoff.done' &&
          row?.provider === 'codex' &&
          row?.session_id === CODEX_THREAD_ID &&
          row?.outcome === 'committed',
      )
      expect(committedRows, 'exactly one committed handoff for the session').toHaveLength(1)
      expect(debugOptionString(committedRows[0].runtime_id)).toBe(handoffTerminalId)
      expect(
        readServerLogRows(info).filter(
          (row) => row?.event === 'ownership.commit_live.stale_generation' && row?.session_id === CODEX_THREAD_ID,
        ),
        'zero stale-generation commits for the session',
      ).toHaveLength(0)
    } finally {
      await desktopCtx?.close().catch(() => {})
      await phoneCtx?.close().catch(() => {})
      await server.stop().catch(() => {})
      await fs.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })

  // the-usual ownership-fence-fix Task 7 Test B (delta round-4 rework, F1;
  // focused review 2): the cross-device leg. Device A opens the seeded
  // session (terminal-lane resume create) and stays connected; device B
  // attaches to the SAME terminal from its own sidebar, then KILLS it via
  // the real shift-click affordance -- committing a new ownership generation
  // (the durable stop) behind A's back. A's pane folds the exit and must
  // converge to the honest EXITED state and STAY there: a killed session
  // NEVER auto-restarts (delta F1) -- nothing moves until the user acts (a
  // bounded negative poll pins the stillness). The pane must also SURFACE
  // its recovery affordance (focused review 2: the killed-session shape --
  // clean exit code 0 + the canonical owner record folded VACANT -- renders
  // the in-pane Reopen action, never an actionless dead pane). The
  // USER-DRIVEN reopen -- A clicks that surfaced in-pane affordance (the
  // respawn resume-create) -- must converge with NO page reload: post-fix
  // every terminal-lane commit broadcasts its own committed (epoch,
  // generation) pair AND terminal.created carries it (folded before the
  // queued attach), so the reopen's attach lands and A's page is live
  // again. Pre-fix the commits were silent: the reopen's queued attach was
  // refused typed forever -- the recorded incident's exact wedge (the pane
  // stuck "Recovering terminal output", no PTY output until a page reload).
  test('cross-device kill+reopen does not wedge a connected page (no reload)', async ({ browser }) => {
    const CODEX_SESSION_ID = '21000000-aaaa-4bbb-8ccc-000000000002'
    const SESSION_TITLE = 'fence-heal cross-device codex session'
    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-handoff2d-fence-heal-'))
    const projectDir = path.join(sharedRoot, 'project')
    await fs.mkdir(projectDir, { recursive: true })
    // Dual-role: the codex terminal lane boots a `codex app-server` sidecar
    // FIRST (PTY_SPAWN_FAILED otherwise), so the fake must answer both
    // app-server argv and terminal argv (codex-dual-role.ts).
    const fakeCodex = await installDualRoleCodexCli(
      path.join(sharedRoot, 'bin'),
      FAKE_CODEX_TERMINAL,
    )
    const server = new RustServer({
      env: { CODEX_CMD: fakeCodex },
      setupHome: seedFenceHealCodexHome(CODEX_SESSION_ID, SESSION_TITLE, projectDir),
    })
    let deviceACtx: BrowserContext | null = null
    let deviceBCtx: BrowserContext | null = null
    try {
      const info = await server.start()
      deviceACtx = await newDeviceContext(browser)
      deviceBCtx = await newDeviceContext(browser)
      const deviceA = await openDevicePage(deviceACtx, info)
      const deviceB = await openDevicePage(deviceBCtx, info)

      // Two contexts ⇒ two durable device ids (the cross-device premise).
      expect(await deviceId(deviceA.page)).not.toBe(await deviceId(deviceB.page))

      const sessionRowOn = (page: Page) =>
        page.getByTestId('sidebar-session-list').locator(`[data-session-id="${CODEX_SESSION_ID}"]`)

      await selectShellIfPickerShowing(deviceA.page)
      await selectShellIfPickerShowing(deviceB.page)

      // 1. DEVICE A opens the seeded session from the sidebar (the
      //    terminal-lane resume create) and stays connected; the pane
      //    attaches -- the fake's resumed marker can only arrive through
      //    the attach stream.
      const aRow = sessionRowOn(deviceA.page)
      await expect(aRow).toBeVisible({ timeout: 15_000 })
      const aTabCountBefore = await deviceA.harness.getTabCount()
      await aRow.click()
      await expect(async () => {
        expect(await deviceA.harness.getTabCount()).toBe(aTabCountBefore + 1)
      }).toPass({ timeout: 15_000 })
      const aTabId = (await deviceA.harness.getActiveTabId())!

      const firstTerminalId: string = await expect
        .poll(
          async () => (await deviceA.harness.getPaneLayout(aTabId))?.content?.terminalId ?? null,
          { timeout: 20_000 },
        )
        .not.toBeNull()
        .then(async () => (await deviceA.harness.getPaneLayout(aTabId))?.content?.terminalId)
      await expect
        .poll(async () => {
          const buffer = await deviceA.harness.getTerminalBuffer(firstTerminalId)
          const unwrapped = typeof buffer === 'string' ? buffer.replace(/\n/g, '') : ''
          return unwrapped.includes(`codex: resumed session ${CODEX_SESSION_ID}`)
        }, { timeout: 30_000 })
        .toBe(true)

      // 2. DEVICE B opens the SAME session from its own sidebar: B's row
      //    reports A's running terminal (data-is-running /
      //    data-running-terminal-id), which routes the click through the
      //    direct-attach arm -- B's pane lands on the SAME terminalId,
      //    never a respawn.
      const bRow = sessionRowOn(deviceB.page)
      await expect(bRow).toBeVisible({ timeout: 15_000 })
      await expect(bRow).toHaveAttribute('data-is-running', 'true', { timeout: 30_000 })
      await expect(bRow).toHaveAttribute('data-running-terminal-id', firstTerminalId, { timeout: 30_000 })
      const bTabCountBefore = await deviceB.harness.getTabCount()
      await bRow.click()
      await expect(async () => {
        expect(await deviceB.harness.getTabCount()).toBe(bTabCountBefore + 1)
      }).toPass({ timeout: 15_000 })
      const bTabId = (await deviceB.harness.getActiveTabId())!
      await expect
        .poll(
          async () => (await deviceB.harness.getPaneLayout(bTabId))?.content?.terminalId ?? null,
          { timeout: 20_000 },
        )
        .toBe(firstTerminalId)
      await expect
        .poll(async () => {
          const buffer = await deviceB.harness.getTerminalBuffer(firstTerminalId)
          const unwrapped = typeof buffer === 'string' ? buffer.replace(/\n/g, '') : ''
          return unwrapped.includes(`codex: resumed session ${CODEX_SESSION_ID}`)
        }, { timeout: 30_000 })
        .toBe(true)

      // The no-reload sentinels (both pages): surviving to the end proves
      // neither device ever needed a reload.
      await deviceA.page.evaluate(() => {
        ;(window as any).__fenceHealNoReloadSentinel = 'xdev-a'
      })
      await deviceB.page.evaluate(() => {
        ;(window as any).__fenceHealNoReloadSentinel = 'xdev-b'
      })

      // 3. DEVICE B KILLS the shared terminal via the REAL kill affordance:
      //    shift-click its tab's CLOSE button (plain close is DETACH-ONLY;
      //    TabBar decides kill vs detach from e.shiftKey on the
      //    CLOSE-BUTTON event). B's tab closes after the durable-close ack.
      await deviceB.page
        .locator(`[data-context="tab"][data-tab-id="${bTabId}"]`)
        .getByRole('button', { name: /close/i })
        .click({ modifiers: ['Shift'] })
      await expect(async () => {
        expect(await deviceB.harness.getTabCount()).toBe(bTabCountBefore)
      }).toPass({ timeout: 15_000 })

      // 4. A's CONNECTED pane converges to the honest EXITED state — and
      //    STAYS there: a killed session never auto-restarts (delta F1).
      //    The exit fold clears the pane's terminalId; the bounded negative
      //    poll (8s) genuinely pins the stillness — no new terminalId
      //    appears without user action.
      await expect
        .poll(
          async () => (await deviceA.harness.getPaneLayout(aTabId))?.content?.status ?? null,
          { timeout: 20_000 },
        )
        .toBe('exited')
      await expect
        .poll(
          async () => (await deviceA.harness.getPaneLayout(aTabId))?.content?.terminalId ?? null,
          { timeout: 20_000 },
        )
        .toBe(null)
      await expect(aRow).toHaveAttribute('data-is-running', 'false', { timeout: 15_000 })
      // A kill is a CLEAN exit by wire contract (the registry fans
      // terminal.exit{exitCode:0} on the kill path), so the loud crash
      // banner intentionally does NOT render — but the killed-session
      // shape (clean exit + the stop commit's VACANT owner record) must
      // SURFACE the recovery affordance (focused review 2): never an
      // actionless dead pane. Recovery is USER-DRIVEN, never automatic.
      const reopenButton = deviceA.page
        .locator(`[data-context="terminal"][data-tab-id="${aTabId}"]`)
        .getByRole('button', { name: 'Reopen codex session' })
      await expect(reopenButton).toBeVisible({ timeout: 15_000 })
      await deviceA.page.waitForTimeout(8_000)
      expect((await deviceA.harness.getPaneLayout(aTabId))?.content?.terminalId ?? null).toBe(null)
      expect((await deviceA.harness.getPaneLayout(aTabId))?.content?.status).toBe('exited')

      // 5. The USER-DRIVEN reopen (no reload): A clicks the pane's SURFACED
      //    recovery affordance — the respawn resume-create that commits a
      //    new ownership generation in the SAME pane. Post-fix the commit
      //    broadcasts its own committed pair AND terminal.created carries it
      //    (folded before the queued attach), so the reopened pane lands on a
      //    new terminal; pre-fix (base_ref) the reopen wedged behind the
      //    silent commits (the recorded incident).
      const aTabCountAtReopen = await deviceA.harness.getTabCount()
      await reopenButton.click()
      const reopenedTerminalId: string = await expect
        .poll(
          async () => (await deviceA.harness.getPaneLayout(aTabId))?.content?.terminalId ?? null,
          { timeout: 30_000 },
        )
        .not.toBeNull()
        .then(async () => (await deviceA.harness.getPaneLayout(aTabId))?.content?.terminalId)
      // The reopen stays in the SAME pane/tab — no new tab was minted.
      expect(await deviceA.harness.getTabCount()).toBe(aTabCountAtReopen)
      // A TRUE kill never resurrects the dead terminal: the reopen is a
      // new PTY.
      expect(reopenedTerminalId).not.toBe(firstTerminalId)
      await expect
        .poll(async () => {
          const buffer = await deviceA.harness.getTerminalBuffer(reopenedTerminalId)
          const unwrapped = typeof buffer === 'string' ? buffer.replace(/\n/g, '') : ''
          return unwrapped.includes(`codex: resumed session ${CODEX_SESSION_ID}`)
        }, { timeout: 30_000 })
        .toBe(true)
      await expect(aRow).toHaveAttribute('data-is-running', 'true', { timeout: 30_000 })
      await expect(aRow).toHaveAttribute('data-running-terminal-id', reopenedTerminalId, { timeout: 30_000 })

      // 6. A round-trips input on the reopened terminal -- the connected page
      //    never wedged and never reloaded.
      await deviceA.page
        .locator(`[data-context="terminal"][data-tab-id="${aTabId}"] .xterm`)
        .first()
        .click()
      await deviceA.page.keyboard.type('fence-heal-cross-device')
      await expect
        .poll(async () => {
          const buffer = await deviceA.harness.getTerminalBuffer(reopenedTerminalId)
          const unwrapped = typeof buffer === 'string' ? buffer.replace(/\n/g, '') : ''
          return unwrapped.includes('fence-heal-cross-device')
        }, { timeout: 30_000 })
        .toBe(true)

      expect(
        await deviceA.page.evaluate(() => (window as any).__fenceHealNoReloadSentinel),
      ).toBe('xdev-a')
      expect(
        await deviceB.page.evaluate(() => (window as any).__fenceHealNoReloadSentinel),
      ).toBe('xdev-b')
    } finally {
      await deviceACtx?.close().catch(() => {})
      await deviceBCtx?.close().catch(() => {})
      await server.stop().catch(() => {})
      await fs.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })
})
