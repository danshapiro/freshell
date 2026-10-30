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
