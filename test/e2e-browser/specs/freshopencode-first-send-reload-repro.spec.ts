import { expect, test, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openPanePicker } from '../helpers/pane-picker.js'
import { expectNoRewindStatusText } from '../helpers/fresh-agent-transcript.js'
import { TestHarness } from '../helpers/test-harness.js'
import { RustServer } from '../helpers/rust-server.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const fakeOpencodeSource = path.resolve(__dirname, '../fixtures/fake-opencode.cjs')

type FakeAuditEvent = {
  event?: string
  prompt?: string
}

type FreshOpencodePaneState = {
  sessionId?: string
  status?: string
  sessionRef?: { provider?: string; sessionId?: string }
}

async function installFakeOpencode(binDir: string): Promise<void> {
  await fsp.mkdir(binDir, { recursive: true })
  const target = path.join(binDir, 'opencode')
  await fsp.copyFile(fakeOpencodeSource, target)
  await fsp.chmod(target, 0o755)
}

function createSetupHome(sharedOpencodeDataDir: string) {
  return async (homeDir: string): Promise<void> => {
    const xdgShare = path.join(homeDir, '.local', 'share')
    const opencodeLink = path.join(xdgShare, 'opencode')
    const freshellDir = path.join(homeDir, '.freshell')
    await fsp.mkdir(xdgShare, { recursive: true })
    await fsp.mkdir(freshellDir, { recursive: true })
    await fsp.mkdir(sharedOpencodeDataDir, { recursive: true })
    await fsp.rm(opencodeLink, { recursive: true, force: true }).catch(() => {})
    await fsp.symlink(sharedOpencodeDataDir, opencodeLink, 'dir')
    await fsp.writeFile(path.join(freshellDir, 'config.json'), JSON.stringify({
      version: 1,
      settings: {
        codingCli: {
          enabledProviders: ['opencode'],
          providers: { opencode: {} },
        },
        freshAgent: { enabled: true },
      },
    }, null, 2))
  }
}

function createServerOptions(input: {
  binDir: string
  auditLogPath: string
  logsDir: string
  sharedOpencodeDataDir: string
  /** Keep FAKE_OPENCODE_HANG_SESSION_CREATE=1 (the default) to pin session
   * materialization in flight forever, or pass false to let the fake answer
   * POST /session and materialize the durable ses_* id. */
  hangSessionCreate?: boolean
  /** Extra env vars merged into the spawned server's environment. */
  extraEnv?: Record<string, string>
}) {
  return {
    setupHome: createSetupHome(input.sharedOpencodeDataDir),
    env: {
      PATH: `${input.binDir}${path.delimiter}${process.env.PATH ?? ''}`,
      FAKE_OPENCODE_AUDIT_LOG: input.auditLogPath,
      ...(input.hangSessionCreate === false ? {} : { FAKE_OPENCODE_HANG_SESSION_CREATE: '1' }),
      FRESHELL_LOG_DIR: input.logsDir,
      ...input.extraEnv,
    },
  }
}

async function readAuditEvents(auditLogPath: string): Promise<FakeAuditEvent[]> {
  try {
    const text = await fsp.readFile(auditLogPath, 'utf8')
    return text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as FakeAuditEvent)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

async function enableFreshOpencode(page: Page): Promise<void> {
  await page.evaluate(() => {
    const harness = window.__FRESHELL_TEST_HARNESS__
    harness?.dispatch({
      type: 'connection/setAvailableClis',
      payload: { opencode: true },
    })
    harness?.dispatch({
      type: 'settings/previewServerSettingsPatch',
      payload: {
        codingCli: { enabledProviders: ['opencode'] },
        freshAgent: { enabled: true },
      },
    })
  })
}

async function createFreshopencodePane(page: Page, cwd: string): Promise<void> {
  const picker = await openPanePicker(page)
  await picker.getByRole('button', { name: /^Freshopencode$/i }).click({ force: true })
  const directoryInput = page.getByLabel(/^Starting directory for Freshopencode$/i)
  await expect(directoryInput).toBeVisible({ timeout: 15_000 })
  await directoryInput.fill(cwd)
  await directoryInput.press('Enter')
  await expect(page.locator('[data-context="fresh-agent"]').last()).toBeVisible({ timeout: 15_000 })
}

async function getFreshOpencodePaneState(page: Page): Promise<FreshOpencodePaneState> {
  return page.evaluate(() => {
    const state = window.__FRESHELL_TEST_HARNESS__?.getState()
    const activeTabId = state?.tabs?.activeTabId
    const findFreshOpencode = (node: any): any => {
      if (!node) return undefined
      if (node.type === 'leaf' && node.content?.kind === 'fresh-agent' && node.content.provider === 'opencode') {
        return node.content
      }
      if (node.type === 'split') return findFreshOpencode(node.children?.[0]) ?? findFreshOpencode(node.children?.[1])
      return undefined
    }
    return findFreshOpencode(state?.panes?.layouts?.[activeTabId]) ?? {}
  })
}

/** The active tab's freshopencode pane id plus its content — for scoping
 * locators to THIS pane when other fresh-agent panes exist in background
 * tabs (an MCP-created tab folds focus-neutrally). */
async function getFreshOpencodePaneIdentity(
  page: Page,
): Promise<{ paneId?: string; content: FreshOpencodePaneState } | undefined> {
  return page.evaluate(() => {
    const state = window.__FRESHELL_TEST_HARNESS__?.getState()
    const activeTabId = state?.tabs?.activeTabId
    const findFreshOpencode = (node: any): any => {
      if (!node) return undefined
      if (node.type === 'leaf' && node.content?.kind === 'fresh-agent' && node.content.provider === 'opencode') {
        return { paneId: node.id, content: node.content }
      }
      if (node.type === 'split') return findFreshOpencode(node.children?.[0]) ?? findFreshOpencode(node.children?.[1])
      return undefined
    }
    return findFreshOpencode(state?.panes?.layouts?.[activeTabId])
  })
}

async function sendFreshAgentPrompt(page: Page, prompt: string): Promise<void> {
  const textbox = page.getByRole('textbox', { name: 'Chat message input' })
  await expect(textbox).toBeVisible({ timeout: 15_000 })
  await expect(textbox).not.toBeDisabled({ timeout: 15_000 })
  await textbox.fill(prompt)
  await page.getByRole('button', { name: 'Send' }).click()
}

test.describe('Freshopencode first-send reload regression', () => {
  test.setTimeout(90_000)

  test('keeps a submitted first prompt visible across reload while session materialization is pending', async ({ page }) => {
    const sharedRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-freshopencode-repro-'))
    const binDir = path.join(sharedRoot, 'bin')
    const logsDir = path.join(sharedRoot, 'logs')
    const auditLogPath = path.join(sharedRoot, 'fake-opencode-audit.jsonl')
    const sharedOpencodeDataDir = path.join(sharedRoot, 'opencode-data')
    const cwd = path.join(sharedRoot, 'project')
    const prompt = `playwright repro prompt ${Date.now()}`
    await fsp.mkdir(cwd, { recursive: true })
    await installFakeOpencode(binDir)

    const server = new RustServer(createServerOptions({
      binDir,
      auditLogPath,
      logsDir,
      sharedOpencodeDataDir,
    }))

    try {
      const info = await server.start()
      await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
      const harness = new TestHarness(page)
      await harness.waitForHarness()
      await harness.waitForConnection()
      await enableFreshOpencode(page)
      await createFreshopencodePane(page, cwd)

      await expect.poll(async () => getFreshOpencodePaneState(page), { timeout: 15_000 }).toMatchObject({
        sessionId: expect.stringMatching(/^freshopencode-/),
      })
      await page.evaluate(() => {
        window.__FRESHELL_TEST_HARNESS__?.dispatch({ type: 'persist/flushNow' })
      })

      await sendFreshAgentPrompt(page, prompt)
      const transcript = page.locator('[data-context="fresh-agent-transcript"]')
      await expect(transcript.getByText(prompt, { exact: true })).toBeVisible({ timeout: 5_000 })
      await expect.poll(async () => {
        const events = await readAuditEvents(auditLogPath)
        return events.some((event) => event.event === 'session_create_requested')
      }, { timeout: 15_000 }).toBe(true)

      // Two layers, evidence-corrected (Task 4): the PRIMARY failure was
      // deterministic, not load lag — on every freshopencode first send
      // the server's running broadcast is snapshot-invalidating, and the
      // placeholder short-circuit snapshot it triggers replies
      // status 'idle'; applySnapshot's pane-content status write was UNGATED
      // (unlike the session-record write), so that idle snapshot clobbered
      // the optimistic 'running' even unloaded (Expected "running",
      // Received "idle" — every run, not just under load). Fixed by the
      // production gate (Task 4: the pane-content status adoption now
      // mirrors the session-record gate). The SECONDARY layer the poll also
      // covers is load lag — the audit write (fake CLI process) and the
      // client's status broadcast (WS -> Redux) are different pipelines,
      // and under full-lane load the broadcast can lag the audit event.
      // Poll instead of a one-shot read: FAKE_OPENCODE_HANG_SESSION_CREATE=1
      // pins the turn in flight, so 'running' is a stable steady state —
      // polling to it does not weaken the pinned contract (the submitted
      // prompt must stay visible across reload while materialization is
      // pending).
      await expect.poll(async () => getFreshOpencodePaneState(page), { timeout: 30_000 }).toMatchObject({
        sessionId: expect.stringMatching(/^freshopencode-/),
        status: 'running',
        sessionRef: {
          sessionId: expect.stringMatching(/^freshopencode-/),
        },
      })

      await page.reload()
      await harness.waitForHarness()
      await harness.waitForConnection()
      const afterReloadTranscript = page.locator('[data-context="fresh-agent-transcript"]')

      await expect(afterReloadTranscript.getByText(prompt, { exact: true })).toBeVisible({ timeout: 5_000 })
    } finally {
      await server.stop().catch(() => {})
      await fsp.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })
})

test.describe('Freshopencode first-message code checkpoint', () => {
  test('binds the first message\'s code checkpoint live, without a reload', async ({ page }) => {
    test.setTimeout(180_000)
    const sharedRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-freshopencode-live-'))
    const binDir = path.join(sharedRoot, 'bin')
    const logsDir = path.join(sharedRoot, 'logs')
    const auditLogPath = path.join(sharedRoot, 'fake-opencode-audit.jsonl')
    const sharedOpencodeDataDir = path.join(sharedRoot, 'opencode-data')
    const cwd = path.join(sharedRoot, 'project')
    const promptGatePath = path.join(sharedRoot, 'prompt-gate')
    const prompt = `playwright live checkpoint prompt ${Date.now()}`
    await fsp.mkdir(cwd, { recursive: true })
    // A Git workspace cwd so the code checkpoint capture succeeds: the send's
    // workspace intent has provenance 'resolved-project', which resolves
    // through the checkout root (a non-Git scope is honestly unavailable).
    await fsp.writeFile(path.join(cwd, 'tracked.txt'), 'fixture workspace file\n')
    execFileSync('git', ['init', cwd], { stdio: 'ignore' })
    execFileSync('git', ['-C', cwd, 'config', 'user.email', 'fixture@example.invalid'], { stdio: 'ignore' })
    execFileSync('git', ['-C', cwd, 'config', 'user.name', 'Freshell fixture'], { stdio: 'ignore' })
    execFileSync('git', ['-C', cwd, 'add', '--', 'tracked.txt'], { stdio: 'ignore' })
    execFileSync('git', ['-C', cwd, 'commit', '-m', 'fixture'], { stdio: 'ignore' })
    await installFakeOpencode(binDir)

    // The existing test's harness pins session materialization in flight
    // forever (FAKE_OPENCODE_HANG_SESSION_CREATE=1: the fixture never answers
    // POST /session), so the durable ses_* id would never appear and this
    // journey could never complete. Run the flag-less harness instead, and
    // hold the /prompt_async turn completion behind the new gate so the
    // mid-turn pending window is deterministically observable.
    const server = new RustServer(createServerOptions({
      binDir,
      auditLogPath,
      logsDir,
      sharedOpencodeDataDir,
      hangSessionCreate: false,
      extraEnv: { FAKE_OPENCODE_HOLD_PROMPT_GATE_PATH: promptGatePath },
    }))

    try {
      const info = await server.start()
      await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
      const harness = new TestHarness(page)
      await harness.waitForHarness()
      await harness.waitForConnection()
      await enableFreshOpencode(page)
      await createFreshopencodePane(page, cwd)

      await expect.poll(async () => getFreshOpencodePaneState(page), { timeout: 15_000 }).toMatchObject({
        sessionId: expect.stringMatching(/^freshopencode-/),
      })

      await sendFreshAgentPrompt(page, prompt)
      // The fake answers POST /session, materializes the durable session and
      // drives /prompt_async: the busy SSE, the persisted user+assistant rows
      // and this audit row all fire at REQUEST RECEIPT — only the response +
      // idle emit park behind the gate file.
      await expect.poll(async () => {
        const events = await readAuditEvents(auditLogPath)
        return events.some((event) => event.event === 'prompt_async' && event.prompt === prompt)
      }, { timeout: 30_000 }).toBe(true)

      const paneRoot = page.locator('[data-context="fresh-agent"]').last()
      // The snapshot's landed user row (msg_-id, source durable). toHaveCount(1)
      // also proves the optimistic echo row cleared, so the pending hover below
      // targets the landed durable row — the request-keyed capture outcome
      // cannot bind it (Task 1 semantics: the outcome has no row identity and
      // the durable row carries no requestId), so mid-turn it is honestly
      // still-saving.
      const userTurn = paneRoot.locator('[data-turn-role="user"]', { hasText: prompt })
      await expect(userTurn).toHaveCount(1, { timeout: 20_000 })

      // Parked-ness proof: the gate file does not exist yet, so the daemon
      // cannot have emitted the turn's idle — the turn is deterministically
      // still in flight at this point.
      const idleEmitted = async () => (await readAuditEvents(auditLogPath))
        .some((event) => event.event === 'session_idle_emitted')
      await expect(await idleEmitted()).toBe(false)

      // MID-TURN busy-pending (Task 1 e2e): the held turn keeps the pane's
      // agent session busy, so the newest user row's hover shows the disabled
      // still-saving state — deterministically, because the gate parks the
      // idle emit.
      await userTurn.hover()
      const saving = userTurn.getByRole('button', { name: 'Saving code rewind checkpoint' })
      await expect(saving).toBeVisible()
      await expect(saving).toBeDisabled()
      await expect(saving).toHaveAttribute('title', 'Saving the code state from before this message')

      // ROLE GATE (Task 1 e2e): the assistant row renders its hover toolbar
      // (Copy proves it is genuinely shown) but NO rewind control in ANY
      // state — enabled, disabled-unavailable or still-saving.
      const assistantTurn = paneRoot.locator('[data-turn-role="assistant"]', {
        hasText: `Fake OpenCode response: ${prompt}`,
      })
      await expect(assistantTurn).toBeVisible({ timeout: 10_000 })
      await assistantTurn.hover()
      await expect(assistantTurn.getByRole('button', { name: 'Copy turn' })).toBeVisible()
      await expect(assistantTurn.getByRole('button', { name: 'Rewind code to here' })).toHaveCount(0)
      await expect(assistantTurn.getByRole('button', { name: 'Rewind unavailable for this message' })).toHaveCount(0)
      await expect(assistantTurn.getByRole('button', { name: 'Saving code rewind checkpoint' })).toHaveCount(0)

      // NOTE ABSENCE (Task 2 e2e): no per-turn rewind status text renders
      // anywhere in the pane — the inline note block is gone; rewind state
      // lives only on the hover button and in the sheet/menu labels.
      await expectNoRewindStatusText(paneRoot)

      // Release the gate: the parked response answers, the idle emit settles
      // the turn server-side, the identity observation finds the persisted
      // msg_-id row and the enriched outcome is re-broadcast to every session
      // alias.
      await fsp.writeFile(promptGatePath, 'release\n')
      await expect.poll(idleEmitted, { timeout: 30_000 }).toBe(true)

      // LIVE BINDING (defect 3): the pane never reloads — the hover flips from
      // still-saving to the enabled rewind button the moment the enriched
      // outcome binds (the brief unavailable window between idle and the
      // enriched frame is retried through by the assertion itself).
      await userTurn.hover()
      const rewind = userTurn.getByRole('button', { name: 'Rewind code to here' })
      await expect(rewind).toBeEnabled({ timeout: 30_000 })
    } finally {
      await server.stop().catch(() => {})
      await fsp.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })
})

test.describe('Freshopencode restored-echo rewind honesty', () => {
  test('a reload inside the echo window shows the restored echo still saving, then the enriched row enabled after the settle', async ({ page }) => {
    test.setTimeout(240_000)
    const sharedRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-freshopencode-restored-echo-'))
    const binDir = path.join(sharedRoot, 'bin')
    const logsDir = path.join(sharedRoot, 'logs')
    const auditLogPath = path.join(sharedRoot, 'fake-opencode-audit.jsonl')
    const sharedOpencodeDataDir = path.join(sharedRoot, 'opencode-data')
    const cwd = path.join(sharedRoot, 'project')
    const promptGatePath = path.join(sharedRoot, 'prompt-gate')
    const prompt = `playwright restored echo reload prompt ${Date.now()}`
    await fsp.mkdir(cwd, { recursive: true })
    // A Git workspace cwd so the code checkpoint capture succeeds (the
    // enabled rewind at the journey's end requires an available capture).
    await fsp.writeFile(path.join(cwd, 'tracked.txt'), 'fixture workspace file\n')
    execFileSync('git', ['init', cwd], { stdio: 'ignore' })
    execFileSync('git', ['-C', cwd, 'config', 'user.email', 'fixture@example.invalid'], { stdio: 'ignore' })
    execFileSync('git', ['-C', cwd, 'config', 'user.name', 'Freshell fixture'], { stdio: 'ignore' })
    execFileSync('git', ['-C', cwd, 'add', '--', 'tracked.txt'], { stdio: 'ignore' })
    execFileSync('git', ['-C', cwd, 'commit', '-m', 'fixture'], { stdio: 'ignore' })
    await installFakeOpencode(binDir)

    // The flag-less harness (the durable ses_* id must materialize for the
    // journey's end) with the prompt gate holding the turn in flight.
    const server = new RustServer(createServerOptions({
      binDir,
      auditLogPath,
      logsDir,
      sharedOpencodeDataDir,
      hangSessionCreate: false,
      extraEnv: { FAKE_OPENCODE_HOLD_PROMPT_GATE_PATH: promptGatePath },
    }))

    try {
      const info = await server.start()
      // Frame-level pin for the whole journey, installed BEFORE the page's
      // first WebSocket so it owns both the original page's socket and the
      // reloaded page's socket (the message-holding idiom of
      // fresh-agent-hidden-approval-reveal.spec.ts). Server->client frames
      // pass through until the send flips the hold; from then until the
      // release below they are buffered undelivered — so the dying page's
      // pagehide persist cannot write the send's follow-up frames (the
      // checkpoint outcome, the materialization re-key, the refetch's
      // status adoption) into the persisted pane content, and the reloaded
      // page boots on persisted content alone (no frames, so no snapshot
      // fetch, no outcome history, no status overwrite). The
      // client->server direction always passes — the composer send itself
      // rides it, so the server really runs the capture, forwards the
      // prompt to the fake, and parks the turn at the gate.
      let holdServerFrames = false
      const heldFrames: Array<() => void> = []
      await page.routeWebSocket('**/ws', (route) => {
        const upstream = route.connectToServer()
        upstream.onMessage((message) => {
          const deliver = () => {
            try {
              route.send(message)
            } catch {
              // The owning page died with its socket (the reload); the
              // buffered frame dies with it.
            }
          }
          if (holdServerFrames) {
            heldFrames.push(deliver)
            return
          }
          deliver()
        })
      })
      await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
      const harness = new TestHarness(page)
      await harness.waitForHarness()
      await harness.waitForConnection()
      await enableFreshOpencode(page)
      await createFreshopencodePane(page, cwd)

      await expect.poll(async () => getFreshOpencodePaneState(page), { timeout: 15_000 }).toMatchObject({
        sessionId: expect.stringMatching(/^freshopencode-/),
      })
      // Flush the pane's placeholder identity so the reloaded page
      // rehydrates this pane at all.
      await page.evaluate(() => {
        window.__FRESHELL_TEST_HARNESS__?.dispatch({ type: 'persist/flushNow' })
      })

      await sendFreshAgentPrompt(page, prompt)
      // From the send on, no server frame may update the store: the
      // optimistic echo row is the displayed copy of the in-flight first
      // send — the echo window the reload must land inside. Wait for the
      // pane store to hold the echo (raf-cadence polling, so the flush
      // below runs before any debounced persist could), then persist
      // EXACTLY this state: the optimistic echo plus the optimistic
      // running status, with no checkpoint outcome bound under the send's
      // request.
      holdServerFrames = true
      await page.waitForFunction(() => {
        const state = window.__FRESHELL_TEST_HARNESS__?.getState() as any
        const findFreshOpencode = (node: any): any => {
          if (!node) return undefined
          if (node.type === 'leaf' && node.content?.kind === 'fresh-agent' && node.content.provider === 'opencode') {
            return node.content
          }
          if (node.type === 'split') return findFreshOpencode(node.children?.[0]) ?? findFreshOpencode(node.children?.[1])
          return undefined
        }
        const activeTabId = state?.tabs?.activeTabId
        const content = findFreshOpencode(state?.panes?.layouts?.[activeTabId])
        return Boolean(content?.pendingLocalEcho && content?.status === 'running')
      })
      await page.evaluate(() => {
        window.__FRESHELL_TEST_HARNESS__?.dispatch({ type: 'persist/flushNow' })
      })
      await page.reload()
      await harness.waitForHarness()

      // The rehydrated pane boots from persisted content alone: the
      // restored echo row renders with the persisted running status, no
      // snapshot can land the durable row (the frames that trigger the
      // refetch are held, and the fetch itself is gated on the connection
      // the held ready frame never establishes), and no outcome is bound
      // under the send's request. Mid-turn, the restored echo is the
      // pane's newest user row whose checkpoint outcome is genuinely in
      // flight — so its hover shows the DISABLED still-saving state, never
      // the legacy enabled rewind offer an unbound restored echo used to
      // fall to.
      const paneRoot = page.locator('[data-context="fresh-agent"]').last()
      const echoRow = paneRoot.locator('[data-turn-role="user"]', { hasText: prompt })
      await expect(echoRow).toBeVisible({ timeout: 10_000 })
      // Pin that the pane really reports busy: the held-frame boot has no
      // server-seen session record and no snapshot, so the pane's status IS
      // the persisted running status the send stamped — the still-saving
      // verdict below is only honest mid-turn. (The composer's Stop button
      // is not usable as this pin: it needs a snapshot's interrupt
      // capability, which the held-frame boot has not fetched.)
      await expect.poll(async () => getFreshOpencodePaneState(page), { timeout: 10_000 }).toMatchObject({
        status: 'running',
      })
      await echoRow.hover()
      const saving = echoRow.getByRole('button', { name: 'Saving code rewind checkpoint' })
      await expect(saving).toBeVisible()
      await expect(saving).toBeDisabled()
      await expect(saving).toHaveAttribute('title', 'Saving the code state from before this message')
      await expect(echoRow.getByRole('button', { name: 'Rewind code to here' })).toHaveCount(0)

      // Reconnect the page: the held frames deliver (the original page's
      // die with its socket; the reloaded page's ready frame and everything
      // after it flow), and the server's truth reaches the pane — the
      // record's current status, the capture's outcome, the
      // materialization, and the parked turn's busy window.
      holdServerFrames = false
      for (const deliver of heldFrames.splice(0)) deliver()
      await harness.waitForConnection()
      // Parked-ness (the live legs' discipline): the fake received the
      // prompt and never emitted the turn's idle — the still-saving
      // verdict above was made while the turn was genuinely in flight.
      await expect.poll(async () => {
        const events = await readAuditEvents(auditLogPath)
        return events.some((event) => event.event === 'prompt_async' && event.prompt === prompt)
      }, { timeout: 60_000 }).toBe(true)
      const idleEmitted = async () => (await readAuditEvents(auditLogPath))
        .some((event) => event.event === 'session_idle_emitted')
      await expect(await idleEmitted()).toBe(false)

      // Release the gate: the parked response answers, the idle settles the
      // turn, the identity observation binds the enriched outcome (the
      // per-alias broadcast reaches this pane whichever session id the
      // reload persisted), and the durable row lands — the echo clears at
      // its landing.
      await fsp.writeFile(promptGatePath, 'release\n')
      await expect.poll(idleEmitted, { timeout: 30_000 }).toBe(true)

      // The enriched row shows the enabled rewind hover: the journey's end
      // matches the live-binding leg, reached through the reload.
      const userTurn = paneRoot.locator('[data-turn-role="user"]', { hasText: prompt })
      await expect(userTurn).toHaveCount(1, { timeout: 30_000 })
      await userTurn.hover()
      const rewind = userTurn.getByRole('button', { name: 'Rewind code to here' })
      await expect(rewind).toBeEnabled({ timeout: 30_000 })
    } finally {
      await server.stop().catch(() => {})
      await fsp.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })
})

test.describe('Freshopencode MCP/CLI rewind honesty', () => {
  test('an MCP/CLI-driven turn through the REST lane makes no rewind claim mid-turn, and the honest unavailable verdict returns at settle', async ({ page }) => {
    test.setTimeout(180_000)
    const sharedRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-freshopencode-mcp-honesty-'))
    const binDir = path.join(sharedRoot, 'bin')
    const logsDir = path.join(sharedRoot, 'logs')
    const auditLogPath = path.join(sharedRoot, 'fake-opencode-audit.jsonl')
    const sharedOpencodeDataDir = path.join(sharedRoot, 'opencode-data')
    const cwd = path.join(sharedRoot, 'project')
    const promptGatePath = path.join(sharedRoot, 'prompt-gate')
    const setupPrompt = `playwright composer setup prompt ${Date.now()}`
    const mcpPrompt = `playwright mcp honesty prompt ${Date.now()}`
    await fsp.mkdir(cwd, { recursive: true })
    // A Git workspace so the cwd is capture-CAPABLE: the unavailable verdict
    // pinned below can then only come from the REST lane performing no
    // checkpoint capture at all — never from a capture that would have
    // failed on a non-Git scope anyway. If REST-lane capture is ever
    // added, this assertion must flip consciously, not silently.
    await fsp.writeFile(path.join(cwd, 'tracked.txt'), 'fixture workspace file\n')
    execFileSync('git', ['init', cwd], { stdio: 'ignore' })
    execFileSync('git', ['-C', cwd, 'config', 'user.email', 'fixture@example.invalid'], { stdio: 'ignore' })
    execFileSync('git', ['-C', cwd, 'config', 'user.name', 'Freshell fixture'], { stdio: 'ignore' })
    execFileSync('git', ['-C', cwd, 'add', '--', 'tracked.txt'], { stdio: 'ignore' })
    execFileSync('git', ['-C', cwd, 'commit', '-m', 'fixture'], { stdio: 'ignore' })
    await installFakeOpencode(binDir)

    const server = new RustServer(createServerOptions({
      binDir,
      auditLogPath,
      logsDir,
      sharedOpencodeDataDir,
      hangSessionCreate: false,
      extraEnv: { FAKE_OPENCODE_HOLD_PROMPT_GATE_PATH: promptGatePath },
    }))

    try {
      const info = await server.start()
      const authed = { 'content-type': 'application/json', 'x-auth-token': info.token }
      await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
      const harness = new TestHarness(page)
      await harness.waitForHarness()
      await harness.waitForConnection()
      await enableFreshOpencode(page)

      // The browser pane comes from the picker (this file's existing
      // harness): the user's pane, whose conversation the MCP client below
      // drives a turn on.
      await createFreshopencodePane(page, cwd)
      await expect.poll(async () => getFreshOpencodePaneState(page), { timeout: 15_000 }).toMatchObject({
        sessionId: expect.stringMatching(/^freshopencode-/),
      })

      // SETUP TURN (the composer, the pane's own lane): the pre-armed gate
      // releases this turn at the fixture's first gate poll, so it
      // materializes the durable ses_* session through the WS lane — which
      // bridges the session's serve-SSE — and settles immediately. The
      // bridge is what makes the MCP turn below observable live in this
      // pane.
      await fsp.writeFile(promptGatePath, 'release\n')
      await sendFreshAgentPrompt(page, setupPrompt)
      // The pane re-keys onto the durable session once the turn
      // materializes it.
      await expect.poll(async () => getFreshOpencodePaneState(page), { timeout: 30_000 }).toMatchObject({
        sessionId: expect.stringMatching(/^ses_/),
      })
      const pane = await getFreshOpencodePaneIdentity(page)
      expect(pane?.paneId).toBeTruthy()
      const paneRoot = page.locator(
        `[data-pane-id="${pane!.paneId}"] [data-context="fresh-agent"], [data-pane-id="${pane!.paneId}"][data-context="fresh-agent"]`,
      ).first()
      const durableSessionId = pane?.content.sessionId
      expect(durableSessionId).toMatch(/^ses_/)
      const idleAfterPrompt = async (prompt: string) => {
        const events = await readAuditEvents(auditLogPath)
        const promptIndex = events.findLastIndex((event) => event.event === 'prompt_async' && event.prompt === prompt)
        return promptIndex >= 0
          && events.slice(promptIndex + 1).some((event) => event.event === 'session_idle_emitted')
      }
      await expect.poll(() => idleAfterPrompt(setupPrompt), { timeout: 30_000 }).toBe(true)

      // THE HONESTY TURN: an MCP/CLI client opens the SAME conversation
      // through the REST tab lane (POST /api/tabs with sessionRef — the
      // documented MCP new-tab resume route) and drives one turn through
      // the REST send lane — which performs no checkpoint capture. The
      // turn parks behind the gate file the fixture consumed on the setup
      // turn's release.
      const createRes = await fetch(`${info.baseUrl}/api/tabs`, {
        method: 'POST',
        headers: authed,
        body: JSON.stringify({
          agent: 'opencode',
          sessionRef: { provider: 'opencode', sessionId: durableSessionId },
          cwd,
        }),
      })
      const createText = await createRes.text()
      expect(createRes.ok, createText).toBe(true)
      const created = (JSON.parse(createText) as { data?: { tabId?: string; paneId?: string } }).data
      expect(created?.paneId, `POST /api/tabs envelope: ${createText}`).toBeTruthy()
      // The MCP pane folds into the browser as a background tab (focus-neutral
      // create). Its mount attach broadcasts the session's CURRENT status —
      // computed from the WS session record, which knows nothing about the
      // REST turn below — so wait for that mount trail to go QUIESCENT before
      // firing the turn: the attach's idle broadcast must never clobber the
      // turn's busy status mid-flight.
      const paneBRoot = page.locator(`[data-pane-id="${created!.paneId!}"]`).first()
      await expect(
        paneBRoot.locator('[data-turn-role="user"]', { hasText: setupPrompt }),
      ).toHaveCount(1, { timeout: 15_000 })
      const readRecordStatusVersion = () => page.evaluate((sid: string) => {
        const state = window.__FRESHELL_TEST_HARNESS__?.getState() as any
        const record = state?.freshAgent?.sessions?.[`freshopencode:opencode:${sid}`]
        return typeof record?.statusVersion === 'number' ? record.statusVersion : -1
      }, durableSessionId as string)
      await expect.poll(async () => {
        const before = await readRecordStatusVersion()
        if (before < 0) return null
        await page.waitForTimeout(400)
        const after = await readRecordStatusVersion()
        return before === after ? after : null
      }, { timeout: 15_000 }).toBeGreaterThanOrEqual(0)
      const mcpSendPromise = fetch(`${info.baseUrl}/api/panes/${encodeURIComponent(created!.paneId!)}/send-keys`, {
        method: 'POST',
        headers: authed,
        body: JSON.stringify({ data: mcpPrompt }),
      })
      await expect.poll(async () => {
        const events = await readAuditEvents(auditLogPath)
        return events.some((event) => event.event === 'prompt_async' && event.prompt === mcpPrompt)
      }, { timeout: 30_000 }).toBe(true)

      // The user's pane observes the MCP turn live through its bridge: the
      // turn's user row lands on the open transcript.
      const userTurn = paneRoot.locator('[data-turn-role="user"]', { hasText: mcpPrompt })
      await expect(userTurn).toHaveCount(1, { timeout: 20_000 })

      // Parked-ness (the live test's discipline): no idle can have been
      // emitted after the MCP turn's prompt_async receipt — the turn is
      // deterministically still in flight at the assertions below.
      await expect(await idleAfterPrompt(mcpPrompt)).toBe(false)

      // BUSY pin: the user's pane observes the MCP turn running — the
      // pane's busy window is genuinely open, which is the state a
      // dishonest "Saving code rewind checkpoint" claim would ride.
      await expect(paneRoot.getByRole('button', { name: 'Stop' })).toBeVisible({ timeout: 15_000 })

      // The honesty verdict: while the MCP turn is parked the row makes NO
      // rewind claim at all — nothing is being saved for it (never a
      // still-saving hover), and the uncertain mid-turn window supports no
      // verdict this pane can evidence (no unavailable hover, no enabled
      // hover either): the User Request's "(or nothing)" acceptance.
      await userTurn.hover()
      await expect(userTurn.getByRole('button', { name: 'Saving code rewind checkpoint' })).toHaveCount(0)
      await expect(userTurn.getByRole('button', { name: 'Rewind unavailable for this message' })).toHaveCount(0)
      await expect(userTurn.getByRole('button', { name: 'Rewind code to here' })).toHaveCount(0)

      // Release the gate and let the turn settle; the REST drive resolves.
      await fsp.writeFile(promptGatePath, 'release\n')
      await expect.poll(() => idleAfterPrompt(mcpPrompt), { timeout: 30_000 }).toBe(true)
      const mcpSend = await mcpSendPromise
      const mcpText = await mcpSend.text()
      expect(mcpSend.ok, mcpText).toBe(true)

      // The honest settled verdict: the turn's end returns the disabled
      // unavailable rewind with its reason.
      await userTurn.hover()
      const rewind = userTurn.getByRole('button', { name: 'Rewind unavailable for this message' })
      await expect(rewind).toBeVisible({ timeout: 15_000 })
      await expect(rewind).toBeDisabled()
      await expect(rewind).toHaveAttribute('title', 'Rewind unavailable: No exact code checkpoint is available for this message.')
    } finally {
      await server.stop().catch(() => {})
      await fsp.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })
})
