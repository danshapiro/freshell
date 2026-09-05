// FRESHAGENT SETTINGS RESUME (P1.13, Lane B4 Task 14) -- end-to-end proof that
// per-provider fresh-agent settings survive a server restart, plus the codex
// crash-respawn memory-loss degradation banner:
//   1. codex: a create-shaped resume after restartAbrupt (the exact wire shape
//      the frozen client sends after page.reload -- V2/A4) carries the RECORDED
//      model/sandbox on `thread/resume`, filled from the pane ledger (Task 5(d)),
//      NOT from the resume message (which deliberately omits them).
//   2. opencode: REST-seeded session (V3: the REST surface is opencode-only);
//      after restart, a create-shaped resume + a settings-less send carries the
//      recorded model/effort on the wire (`{providerID,modelID}` object + the
//      `variant` string field -- build_prompt_body, serve.rs).
//   3. claude: the ATTACH resume path (`resume_for_attach`, Task 10) reapplies
//      the recorded model/permissionMode from the ledger on the sidecar resume
//      create. Attach is the no-reload reconnect topology (V2/A4).
//   4. codex crash respawn: THREAD_MEMORY_LOST must be USER-VISIBLE (Task 6) --
//      a role="alert" banner in the real browser UI, asserted with NO reload
//      anywhere (the banner is in-memory Redux state and does not survive
//      reload -- V1 N3).
//
// Rust-only: registered in RUST_ONLY_SPECS + rust-chromium testMatch
// (restartAbrupt exists only on RustServer). Tests 1-3 drive the server
// directly (REST + raw WS, no browser page); test 4 is a browser test.
//
// Donors: boot/env/restart plumbing from freshclaude-restart-parity-rust.spec.ts
// (:212-310); the raw node-side WS client from
// codex-status-completeness-rust.spec.ts (WsCapture); the raw-create message
// sequence from crates/freshell-ws/tests/freshagent_claude_kill_interrupt.rs
// (:295); the raw-attach frame from freshagent_claude_attach.rs; the REST
// opencode seeding from agent-continuity-matrix.spec.ts; the Freshcodex UI
// pane-creation flow from agent-checkpoint-rewind.spec.ts (:207). Helpers are
// copied, not imported, per this suite's per-spec-ownership convention.
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import { test, expect } from '../helpers/fixtures.js'
import { RustServer } from '../helpers/rust-server.js'
import { TestHarness } from '../helpers/test-harness.js'
import { openPanePicker } from '../helpers/pane-picker.js'
import type { Page } from '@playwright/test'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const CODEX_FIXTURE = path.resolve(
  __dirname,
  '../../fixtures/coding-cli/codex-app-server/fake-app-server.mjs',
)
const CLAUDE_FIXTURE = path.resolve(__dirname, '../fixtures/fake-claude-sidecar.mjs')
const OPENCODE_FIXTURE = path.resolve(__dirname, '../fixtures/fake-opencode.cjs')

// ---------------------------------------------------------------------------
// Copied helpers
// ---------------------------------------------------------------------------

/**
 * Raw node-side WS client with a real hello handshake and a frame buffer
 * (donor: codex-status-completeness-rust.spec.ts's WsCapture).
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
        this.ws.send(JSON.stringify({ type: 'hello', protocolVersion: 8, token }))
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

/**
 * `PATCH /api/settings` -- flip the shared `settings.freshAgent.enabled` gate
 * the fresh-agent WS dispatch requires (`crates/freshell-ws/src/terminal.rs`).
 * Endpoint shape verified against settings-live-reload.spec.ts (:38-45).
 */
async function enableFreshAgent(baseUrl: string, token: string): Promise<void> {
  const res = await fetch(`${baseUrl}/api/settings`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'x-auth-token': token },
    body: JSON.stringify({ freshAgent: { enabled: true } }),
  })
  if (!res.ok) {
    throw new Error(`PATCH /api/settings failed: ${res.status} ${await res.text()}`)
  }
}

/** Parse a JSONL file, tolerating absence (returns []). */
function readJsonl(filePath: string): any[] {
  if (!fs.existsSync(filePath)) return []
  return fs
    .readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
}

/** Dismiss the initial pane-type picker by choosing the first visible shell.
 * (donor: restore-contract-wall-rust.spec.ts :95-105) */
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

/** Idempotent .freshell/config.json seed (setupHome re-runs on every boot).
 * (donor: freshclaude-restart-parity-rust.spec.ts :76-98) */
function seedWallConfig(input: {
  providers: string[]
  freshAgent?: boolean
}): (homeDir: string) => Promise<void> {
  return async (homeDir: string) => {
    const freshellDir = path.join(homeDir, '.freshell')
    await fsp.mkdir(freshellDir, { recursive: true })
    await fsp.writeFile(
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

/** Boot an owned RustServer, navigate, and wait for harness + WS.
 * (donor: freshclaude-restart-parity-rust.spec.ts :102-116) */
async function bootWall(
  page: Page,
  options: {
    env?: Record<string, string>
    setupHome?: (homeDir: string) => Promise<void>
  } = {},
): Promise<{ server: RustServer; info: Awaited<ReturnType<RustServer['start']>>; harness: TestHarness }> {
  const server = new RustServer({ env: options.env, setupHome: options.setupHome })
  const info = await server.start()
  await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
  const harness = new TestHarness(page)
  await harness.waitForHarness()
  await harness.waitForConnection()
  return { server, info, harness }
}

/** Find the (first) fresh-agent leaf within a possibly-split pane layout tree.
 * (donor: agent-checkpoint-rewind.spec.ts :109-119) */
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

/** Create a Claude or Codex pane through the real pane-picker UI.
 * (donor: agent-checkpoint-rewind.spec.ts :188-214, availableClis preamble from
 * freshclaude-restart-parity-rust.spec.ts :177-205) */
async function createFreshAgentPane(page: Page, cwd: string, provider: 'claude' | 'codex'): Promise<void> {
  // setAvailableClis is client-only AND gets overwritten by the app bootstrap +
  // /api/platform fetch; callers reach this only after waitForConnection().
  await page.evaluate((provider) => {
    ;(window as any).__FRESHELL_TEST_HARNESS__?.dispatch({
      type: 'connection/setAvailableClis',
      payload: { claude: provider === 'claude', codex: provider === 'codex' },
    })
  }, provider)
  const picker = await openPanePicker(page)
  const label = provider === 'claude' ? 'Freshclaude' : 'Freshcodex'
  await picker.getByRole('button', { name: label, exact: true }).click({ force: true })
  const directoryInput = page.getByRole('combobox', { name: `Starting directory for ${label}` })
  await expect(directoryInput).toBeVisible({ timeout: 15_000 })
  await directoryInput.fill(cwd)
  await directoryInput.press('Enter')
  await expect(page.locator('[data-context="fresh-agent"]').last()).toBeVisible({
    timeout: 15_000,
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('fresh-agent settings survive restart (rust)', () => {
  test('claude: model, thinking, and permission changes apply to the next message in the same conversation', async ({ page, e2eServerKind }) => {
    test.setTimeout(180_000)
    expect(e2eServerKind).toBe('rust')
    const sharedRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'fa-settings-next-claude-'))
    const sidecarLogPath = path.join(sharedRoot, 'sidecar-requests.jsonl')
    // Deterministic catalog only: the conversation and settings writes run
    // through the real browser, WebSocket handler, and Rust Claude runtime.
    await page.route('**/api/fresh-agent/model-capabilities/freshclaude**', (route) => route.fulfill({ json: {
      ok: true, sessionType: 'freshclaude', runtimeProvider: 'claude', status: 'fresh', fetchedAt: Date.now(),
      models: [{ id: 'sonnet', displayName: 'Sonnet', provider: 'claude', supportsEffort: true,
        supportedEffortLevels: ['low', 'medium', 'high'], supportsAdaptiveThinking: false }],
    } }))
    const { server, harness } = await bootWall(page, {
      env: { FRESHELL_CLAUDE_SIDECAR: CLAUDE_FIXTURE, FAKE_CLAUDE_SIDECAR_LOG: sidecarLogPath, FAKE_CLAUDE_SIDECAR_ECHO_SETTINGS: '1' },
      setupHome: seedWallConfig({ providers: ['claude'], freshAgent: true }),
    })
    try {
      await selectShellIfPickerShowing(page)
      await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })
      const tabId = (await harness.getActiveTabId())!
      await createFreshAgentPane(page, sharedRoot, 'claude')
      const pane = page.locator('[data-context="fresh-agent"]').last()
      const composer = pane.getByRole('textbox', { name: 'Chat message input' })
      await expect(composer).toBeEnabled({ timeout: 30_000 })
      await composer.fill('First message before settings change')
      await pane.getByRole('button', { name: 'Send', exact: true }).click()
      await expect(pane.getByText(/^Fixture claude turn/)).toBeVisible({ timeout: 30_000 })
      await expect(pane.getByRole('button', { name: 'Stop', exact: true })).toBeHidden()
      const before = findFreshAgentLeaf(await harness.getPaneLayout(tabId)).content

      await pane.getByRole('button', { name: /^Model:.*change model$/ }).click()
      const dialog = page.getByRole('dialog', { name: 'Model and thinking level' })
      await dialog.getByRole('option', { name: 'Sonnet', exact: true }).click()
      await dialog.getByRole('option', { name: 'low', exact: true }).click()
      await dialog.getByRole('button', { name: 'Use Sonnet · low' }).click()
      await page.getByRole('button', { name: 'Agent settings', exact: true }).click()
      await page.getByRole('combobox', { name: 'Permission mode' }).selectOption('plan')
      await page.getByRole('button', { name: 'Agent settings', exact: true }).click()
      await composer.fill('Second message uses the selected settings')
      await pane.getByRole('button', { name: 'Send', exact: true }).click()
      await expect(pane.getByText('Fixture claude turn (sonnet, low, plan)', { exact: true })).toBeVisible({ timeout: 30_000 })

      const requests = readJsonl(sidecarLogPath).map((row) => row.msg)
      const secondSend = requests.findIndex((msg) => msg.type === 'send' && msg.text === 'Second message uses the selected settings')
      const configure = requests.findLastIndex((msg) => msg.type === 'configure')
      expect(configure).toBeGreaterThan(-1)
      expect(configure).toBeLessThan(secondSend)
      expect(requests[configure].settings).toMatchObject({ model: 'sonnet', effort: 'low', permissionMode: 'plan' })
      expect(requests.filter((msg) => msg.type === 'create')).toHaveLength(1)
      const after = findFreshAgentLeaf(await harness.getPaneLayout(tabId)).content
      expect(after.sessionId).toBe(before.sessionId)
      expect(after.sessionRef).toEqual(before.sessionRef)
    } finally {
      await server.stop().catch(() => {})
      await fsp.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })

  test('codex: create-shaped resume after restart carries the recorded model', async ({ e2eServerKind }) => {
    test.setTimeout(180_000)
    expect(e2eServerKind).toBe('rust')
    const sharedRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'fa-settings-codex-'))
    const opLogPath = path.join(sharedRoot, 'codex-ops.jsonl')
    const projectDir = path.join(sharedRoot, 'proj')
    await fsp.mkdir(projectDir, { recursive: true })
    const server = new RustServer({
      env: {
        // Whitespace-split by spawn_sidecar (codex.rs): interpreter + script.
        CODEX_CMD: `${process.execPath} ${CODEX_FIXTURE}`,
        // STATIC per server boot (V4/A6): resume succeeds by default.
        FAKE_CODEX_APP_SERVER_BEHAVIOR: JSON.stringify({
          appendThreadOperationLogPath: opLogPath,
        }),
      },
    })
    let ws: WsCapture | null = null
    try {
      const info = await server.start()
      await enableFreshAgent(info.baseUrl, info.token)
      ws = new WsCapture(info.baseUrl, info.token)
      await ws.ready()

      // Raw create WITH settings -- the values the ledger must record.
      ws.send({
        type: 'freshAgent.create',
        requestId: 'req-codex-settings-1',
        sessionType: 'freshcodex',
        provider: 'codex',
        model: 'gpt-5.3-codex-spark',
        sandbox: 'workspace-write',
        cwd: projectDir,
      })
      const created = await ws.waitFor(
        (f) => f.type === 'freshAgent.created' && f.requestId === 'req-codex-settings-1',
        30_000,
        'freshAgent.created (codex create)',
      )
      const threadId = created.sessionId as string
      expect(threadId).toBeTruthy()

      // One turn. `freshAgent.send.accepted` is broadcast after `turn/start`
      // resolves (codex.rs handle_send), and the fake answers turn/start with a
      // completed turn -- so this IS the turn's completion edge on this fixture.
      ws.send({
        type: 'freshAgent.send',
        provider: 'codex',
        sessionId: threadId,
        sessionType: 'freshcodex',
        text: 'settings-resume first turn',
      })
      await ws.waitFor(
        (f) => f.type === 'freshAgent.send.accepted' && f.sessionId === threadId,
        30_000,
        'freshAgent.send.accepted (codex first turn)',
      )
      ws.close()
      ws = null

      // ── SIGKILL + reboot on the same home/port/token.
      await server.restartAbrupt()
      await enableFreshAgent(server.info.baseUrl, server.info.token)
      ws = new WsCapture(server.info.baseUrl, server.info.token)
      await ws.ready()

      // Create-shaped resume with NO model/sandbox -- the values must come from
      // the LEDGER (R1 fills gaps, Task 5(d)), not from this message.
      ws.send({
        type: 'freshAgent.create',
        requestId: 'req-codex-settings-resume',
        sessionType: 'freshcodex',
        provider: 'codex',
        sessionRef: { provider: 'codex', sessionId: threadId },
      })
      await ws.waitFor(
        (f) => f.type === 'freshAgent.created' && f.requestId === 'req-codex-settings-resume',
        30_000,
        'freshAgent.created (codex resume)',
      )

      const ops = fs.readFileSync(opLogPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
      const resume = ops.find((o) => o.method === 'thread/resume')
      expect(resume, 'restart must resume the durable thread').toBeTruthy()
      expect(resume.params.model, 'resume must carry the recorded model, not null').toBe('gpt-5.3-codex-spark')
      expect(resume.params.sandbox, 'resume must carry the recorded sandbox').toBe('workspace-write')
    } finally {
      ws?.close()
      await server.stop().catch(() => {})
      await fsp.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })

  test('opencode: create-shaped resume after restart -> next send carries the recorded model/effort', async ({ e2eServerKind }) => {
    test.setTimeout(180_000)
    expect(e2eServerKind).toBe('rust')
    const sharedRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'fa-settings-opencode-'))
    const binDir = path.join(sharedRoot, 'bin')
    const auditLogPath = path.join(sharedRoot, 'opencode-audit.jsonl')
    const projectDir = path.join(sharedRoot, 'proj')
    await fsp.mkdir(projectDir, { recursive: true })
    // Install the fake as an executable named `opencode` (donor:
    // agent-continuity-matrix.spec.ts installFakeOpencode) and point
    // OPENCODE_CMD at it (serve.rs ServeConfig).
    await fsp.mkdir(binDir, { recursive: true })
    const fakeOpencode = path.join(binDir, 'opencode')
    await fsp.copyFile(OPENCODE_FIXTURE, fakeOpencode)
    await fsp.chmod(fakeOpencode, 0o755)
    const server = new RustServer({
      env: {
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
        OPENCODE_CMD: fakeOpencode,
        FAKE_OPENCODE_AUDIT_LOG: auditLogPath,
      },
      // Re-seeded on every boot; keeps the freshAgent gate + provider enabled
      // across the restart (donor: agent-continuity-matrix.spec.ts).
      setupHome: seedWallConfig({ providers: ['opencode'], freshAgent: true }),
    })
    let ws: WsCapture | null = null
    try {
      const info = await server.start()

      // REST seeding (V3: this surface is opencode-only). The model id MUST be
      // `provider/model`-shaped -- split_opencode_model returns None for
      // slashless ids and build_prompt_body then omits `model` entirely.
      const tabRes = await fetch(`${info.baseUrl}/api/tabs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-auth-token': info.token },
        body: JSON.stringify({
          agent: 'opencode',
          model: 'fakeprov/big-model',
          effort: 'high',
          cwd: projectDir,
        }),
      })
      expect(tabRes.ok, `POST /api/tabs must succeed: ${tabRes.status}`).toBe(true)
      const tabBody = (await tabRes.json()) as any
      const paneId = (tabBody?.data ?? tabBody)?.paneId as string
      expect(paneId, 'POST /api/tabs must return a paneId').toBeTruthy()

      // One send-keys materializes the ses_* session (Task 7's REST-site
      // ledger write records the settings).
      const sendRes = await fetch(`${info.baseUrl}/api/panes/${encodeURIComponent(paneId)}/send-keys`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-auth-token': info.token },
        body: JSON.stringify({ data: 'settings-resume first opencode turn' }),
      })
      const sendResText = await sendRes.text()
      expect(sendRes.ok, `send-keys must succeed: ${sendRes.status} ${sendResText}`).toBe(true)

      // Read the durable ses_* id from the audit log's prompt_async entry
      // (V4/A5: entries are keyed by `event`, never `path`).
      await expect
        .poll(
          () => readJsonl(auditLogPath).find((e) => e.event === 'prompt_async')?.sessionId ?? null,
          { timeout: 30_000 },
        )
        .toMatch(/^ses_/)
      const sesId = readJsonl(auditLogPath).find((e) => e.event === 'prompt_async')!.sessionId as string
      const promptsBeforeRestart = readJsonl(auditLogPath).filter((e) => e.event === 'prompt_async').length

      // ── The REST panes map is in-memory and gone after this; post-restart
      // driving is via raw WS.
      await server.restartAbrupt()
      await enableFreshAgent(server.info.baseUrl, server.info.token)
      ws = new WsCapture(server.info.baseUrl, server.info.token)
      await ws.ready()

      // Create-shaped resume with NO model/effort (the P1.13 pin, Task 8(b)).
      ws.send({
        type: 'freshAgent.create',
        requestId: 'req-opencode-settings-resume',
        sessionType: 'freshopencode',
        provider: 'opencode',
        sessionRef: { provider: 'opencode', sessionId: sesId },
      })
      const created = await ws.waitFor(
        (f) => f.type === 'freshAgent.created' && f.requestId === 'req-opencode-settings-resume',
        30_000,
        'freshAgent.created (opencode resume)',
      )
      expect(created.sessionId, 'resume must answer the durable ses_* id, not a placeholder').toBe(sesId)

      // One send with NO per-send settings.
      ws.send({
        type: 'freshAgent.send',
        provider: 'opencode',
        sessionId: sesId,
        sessionType: 'freshopencode',
        text: 'settings-resume post-restart turn',
      })
      await expect
        .poll(
          () => readJsonl(auditLogPath).filter((e) => e.event === 'prompt_async').length,
          { timeout: 30_000 },
        )
        .toBeGreaterThan(promptsBeforeRestart)

      const audit = fs.readFileSync(auditLogPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
      const prompts = audit.filter((e) => e.event === 'prompt_async') // V4: entries have `event`, never `path`
      const afterRestart = prompts[prompts.length - 1]
      // On the wire (build_prompt_body, serve.rs:939-955): model is the OBJECT
      // { providerID: 'fakeprov', modelID: 'big-model' }, effort is the string
      // field `variant` -- never `effort`/`reasoningEffort`.
      expect(afterRestart.body?.model, 'post-restart send must carry the recorded model').toEqual({ providerID: 'fakeprov', modelID: 'big-model' })
      expect(afterRestart.body?.variant, 'post-restart send must carry the recorded effort (wire field: variant)').toBe('high')
    } finally {
      ws?.close()
      await server.stop().catch(() => {})
      await fsp.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })

  test('claude: attach resume request carries model/permissionMode', async ({ e2eServerKind }) => {
    test.setTimeout(180_000)
    expect(e2eServerKind).toBe('rust')
    const sharedRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'fa-settings-claude-'))
    const sidecarLogPath = path.join(sharedRoot, 'sidecar-requests.jsonl')
    const projectDir = path.join(sharedRoot, 'proj')
    await fsp.mkdir(projectDir, { recursive: true })
    const server = new RustServer({
      env: {
        FRESHELL_CLAUDE_SIDECAR: CLAUDE_FIXTURE,
        FAKE_CLAUDE_SIDECAR_LOG: sidecarLogPath,
      },
    })
    let ws: WsCapture | null = null
    try {
      const info = await server.start()
      await enableFreshAgent(info.baseUrl, info.token)
      ws = new WsCapture(info.baseUrl, info.token)
      await ws.ready()

      // Raw create WITH settings; the server forwards model/permissionMode to
      // the sidecar verbatim and records the binding row at sdk.session.init.
      ws.send({
        type: 'freshAgent.create',
        requestId: 'req-claude-settings-1',
        sessionType: 'freshclaude',
        provider: 'claude',
        model: 'opus-x',
        permissionMode: 'plan',
        cwd: projectDir,
      })
      const created = await ws.waitFor(
        (f) => f.type === 'freshAgent.created' && f.requestId === 'req-claude-settings-1',
        30_000,
        'freshAgent.created (claude create)',
      )
      const bridgeSessionId = created.sessionId as string
      // sdk.session.init -> freshAgent.session.init carries the durable UUID.
      const init = await ws.waitFor(
        (f) =>
          f.type === 'freshAgent.event' &&
          f.sessionId === bridgeSessionId &&
          f.event?.type === 'freshAgent.session.init',
        30_000,
        'freshAgent.session.init',
      )
      const durable = init.event.cliSessionId as string
      expect(durable).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)

      // One turn (fixture completes it with sdk.turn.complete).
      ws.send({
        type: 'freshAgent.send',
        provider: 'claude',
        sessionId: bridgeSessionId,
        sessionType: 'freshclaude',
        text: 'settings-resume first claude turn',
      })
      await ws.waitFor(
        (f) =>
          f.type === 'freshAgent.event' &&
          f.sessionId === bridgeSessionId &&
          f.event?.type === 'freshAgent.turn.complete',
        30_000,
        'freshAgent.turn.complete (claude first turn)',
      )
      ws.close()
      ws = null

      await server.restartAbrupt()
      await enableFreshAgent(server.info.baseUrl, server.info.token)
      ws = new WsCapture(server.info.baseUrl, server.info.token)
      await ws.ready()

      // Attach with the durable UUID. `provider` is a REQUIRED attach field
      // (client_messages.rs FreshAgentAttach); the durable id must ride
      // resumeSessionId/sessionRef -- `attach_durable_id` (claude.rs:858-864)
      // reads ONLY those two fields, exactly what the frozen client writes
      // (FreshAgentView.tsx:303-313).
      ws.send({
        type: 'freshAgent.attach',
        provider: 'claude',
        sessionId: durable,
        sessionType: 'freshclaude',
        sessionRef: { provider: 'claude', sessionId: durable },
      })

      // The resume-on-attach spawns a fresh sidecar whose create carries
      // resumeSessionId + the LEDGER-recorded settings (Task 10).
      await expect
        .poll(
          () =>
            readJsonl(sidecarLogPath).some((m) => m.msg && m.msg.resumeSessionId === durable),
          { timeout: 30_000 },
        )
        .toBe(true)

      const msgs = fs.readFileSync(sidecarLogPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
      const resumeCreate = msgs.filter((m) => m.msg && m.msg.resumeSessionId).pop()
      expect(resumeCreate, 'restart must issue a resume create').toBeTruthy()
      expect(resumeCreate.msg.model, 'resume must carry the recorded model, not null').toBe('opus-x')
      expect(resumeCreate.msg.permissionMode, 'resume must carry the recorded permissionMode').toBe('plan')
    } finally {
      ws?.close()
      await server.stop().catch(() => {})
      await fsp.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })

  test('codex: crash respawn shows a visible memory-loss notice', async ({ page, e2eServerKind }) => {
    test.setTimeout(180_000)
    expect(e2eServerKind).toBe('rust')
    const sharedRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'fa-crash-banner-'))
    const threadOpsPath = path.join(sharedRoot, 'thread-ops.jsonl')
    const projectDir = path.join(sharedRoot, 'proj')
    await fsp.mkdir(projectDir, { recursive: true })
    // ONE static behavior for the whole test (V4/A6). The static thread/resume
    // error is fine: the first spawn goes through thread/start (a fresh session
    // never resumes) and the only resume attempt is the post-crash one, which
    // must fail so the respawn mints a new thread.
    const behavior = {
      overrides: { 'thread/resume': { error: { code: -32602, message: 'thread not found' } } },
      crashOnPromptMarker: 'CRASH_NOW',
      crashOnPromptMarkerOnceMarkerPath: path.join(sharedRoot, 'crash.once'),
      appendThreadOperationLogPath: threadOpsPath,
    }
    const { server, harness } = await bootWall(page, {
      env: {
        CODEX_CMD: `${process.execPath} ${CODEX_FIXTURE}`,
        FAKE_CODEX_APP_SERVER_BEHAVIOR: JSON.stringify(behavior),
      },
      setupHome: seedWallConfig({ providers: ['codex'], freshAgent: true }),
    })
    let ws: WsCapture | null = null
    try {
      await selectShellIfPickerShowing(page)
      const tabId = (await harness.getActiveTabId())!
      // Wait for the boot pane to become a REAL terminal before opening the
      // pane picker (donor: freshclaude-restart-parity-rust.spec.ts :229-232).
      await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })
      await createFreshAgentPane(page, projectDir, 'codex')

      const paneRoot = page.locator('[data-context="fresh-agent"]').last()
      await expect
        .poll(async () => findFreshAgentLeaf(await harness.getPaneLayout(tabId))?.content?.status, {
          timeout: 30_000,
        })
        .toBe('idle')
      const sessionId: string = findFreshAgentLeaf(await harness.getPaneLayout(tabId))?.content?.sessionId
      expect(sessionId).toBeTruthy()

      // First send via the pane composer: the sidecar hard-exits(1) mid-turn
      // (once, cross-process marker), simulating a codex crash.
      const composer = paneRoot.getByRole('textbox', { name: 'Chat message input' })
      await composer.fill('CRASH_NOW')
      await paneRoot.getByRole('button', { name: 'Send' }).click()

      // The exit watcher broadcasts freshAgent.status 'exited' (the self-heal
      // edge); the frozen client folds it into the freshAgent slice (NOT the
      // pane-layout content.status) and shows the session-ended card while
      // DISABLING the composer (FreshAgentView's sessionEnded gate,
      // :1699/:1714). So the recovery-triggering second send is driven over a
      // raw WS client for the SAME session -- crash recovery is send-triggered
      // server-side regardless of which client sends, and the BANNER assertion
      // below still runs against the real browser UI, which receives the
      // broadcast frames. NO page.reload() anywhere: the banner is in-memory
      // Redux state (V1 N3).
      await expect(
        paneRoot.getByText('This session has ended'),
        'the sidecar crash must surface the exited state client-side first',
      ).toBeVisible({ timeout: 30_000 })

      ws = new WsCapture(server.info.baseUrl, server.info.token)
      await ws.ready()
      ws.send({
        type: 'freshAgent.send',
        provider: 'codex',
        sessionId,
        sessionType: 'freshcodex',
        text: 'post-crash recovery message',
      })

      // Task 6's contract: memory loss must be user-visible, not server-log-only.
      const banner = page.getByRole('alert').filter({ hasText: 'no longer has memory' })
      await expect(banner, 'memory loss must be user-visible, not just a server warn').toBeVisible({ timeout: 15000 })

      // "New thread minted" = TWO thread/start entries in the op log. The fake
      // reuses the same thread id (threadStartThreadId default) and errored
      // thread/resume ops are NOT logged -- do NOT assert id inequality or a
      // logged resume (V4/A6).
      const ops = fs.readFileSync(threadOpsPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
      expect(ops.filter((o) => o.method === 'thread/start').length, 'respawn must mint a second thread').toBe(2)
    } finally {
      ws?.close()
      await server.stop().catch(() => {})
      await fsp.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })
})
