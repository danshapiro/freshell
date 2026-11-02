import { expect, test, type Page } from '@playwright/test'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openPanePicker } from '../helpers/pane-picker.js'
import { TestHarness } from '../helpers/test-harness.js'
import { RustServer } from '../helpers/rust-server.js'

/**
 * The 2026-09-20 daemon-death incident class, end to end on the LOCAL lane:
 * a REAL spawned Rust server + a REAL fake `opencode serve` daemon process.
 * The daemon dies an UNREQUESTED death — the fixture child consumes the
 * FAKE_OPENCODE_SELF_EXIT_MARKER file and exits ON ITS OWN (the spec never
 * signals any PID) — and the server-side self-heal chain must carry the pane
 * through it:
 *
 *   (1) the pane is materialized and live before the death;
 *   (2) the daemon self-exits (audit `self_exit` for the exact serving pid);
 *   (3) the pane shows the typed `OPENCODE_DAEMON_LOST` "Agent error:" banner
 *       (exactly ONE typed edge frame for the session);
 *   (4) the manager respawns the daemon automatically within a bounded wait
 *       (a second managed serve launch in the audit log, new pid);
 *   (5) the pane recovers: the revival pass pushes the idle snapshot (the
 *       client's transcript-refetch trigger), the refetch is SERVED by the
 *       respawned daemon (session_get/message_list audits at the new pid),
 *       the transcript still renders, and the banner is dismissible;
 *   (6) NO `freshAgent.turn.complete` chime during the death window — a
 *       crash is never a positive completion — with a positive control: the
 *       follow-up turn's real completion DOES chime, so the window absence
 *       is not vacuous.
 *
 * Mechanics follow freshopencode-restart-recovery.spec.ts (the harness
 * pattern this spec consumes): installFakeOpencode on the spawned server's
 * PATH, the RustServer + TestHarness helpers, the fake's
 * FAKE_OPENCODE_AUDIT_LOG JSONL for spawn/event assertions, and deterministic
 * waits on harness state. The cloud lane cannot guarantee daemon-death +
 * backoff-respawn timing under 2-CPU/2-worker contention (the same
 * provider-lifecycle class as its model), so the spec is registered in
 * CLOUD_SKIP_SPECS; cloud-backend PR coverage is carried by the cloud-legal
 * freshopencode-snapshot-409-recovery.spec.ts.
 */

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const fakeOpencodeSource = path.resolve(__dirname, '../fixtures/fake-opencode.cjs')

type FakeAuditEvent = {
  event?: string
  pid?: number
  hostname?: string
  port?: number
  sessionId?: string
  routeDirectory?: string
  prompt?: string
  status?: string
  argv?: string[]
}

type FreshOpencodePaneState = {
  sessionId?: string
  resumeSessionId?: string
  status?: string
  initialCwd?: string
  sessionRef?: { provider?: string; sessionId?: string }
}

type ReceivedFrame = Record<string, any>

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
  selfExitMarkerPath: string
  port?: number
  token?: string
}) {
  return {
    ...(input.port ? { port: input.port } : {}),
    ...(input.token ? { token: input.token } : {}),
    setupHome: createSetupHome(input.sharedOpencodeDataDir),
    env: {
      PATH: `${input.binDir}${path.delimiter}${process.env.PATH ?? ''}`,
      FAKE_OPENCODE_AUDIT_LOG: input.auditLogPath,
      FAKE_OPENCODE_REQUIRE_DIRECTORY_ROUTE: '1',
      FAKE_OPENCODE_SELF_EXIT_MARKER: input.selfExitMarkerPath,
      FRESHELL_LOG_DIR: input.logsDir,
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

/**
 * The audit `launch` events of MANAGED serve daemons only — argv is
 * `['serve', '--hostname', H, '--port', P]` — excluding the catalog probe's
 * short-lived `serve --pure` sidecars (which share the audit log).
 */
function managedServeLaunches(events: FakeAuditEvent[]): FakeAuditEvent[] {
  return events.filter((event) =>
    event.event === 'launch'
    && Array.isArray(event.argv)
    && event.argv[0] === 'serve'
    && !event.argv.includes('--pure'))
}

/** The `freshAgent.event` frames the client received for one inner event
 * type and session (the server wraps every edge in the same envelope). */
function freshAgentEventFrames(
  frames: ReceivedFrame[],
  sessionId: string,
  innerType: string,
): ReceivedFrame[] {
  return frames.filter((frame) =>
    frame?.type === 'freshAgent.event'
    && frame?.event?.type === innerType
    && frame?.event?.sessionId === sessionId)
}

/** Capture the server→client frames of the page's Freshell /ws socket.
 * Registered BEFORE page.goto so the whole session is covered. */
function captureReceivedFrames(page: Page, wsOrigin: string, sink: ReceivedFrame[]): void {
  page.on('websocket', (socket) => {
    if (!socket.url().startsWith(wsOrigin)) return
    socket.on('framereceived', ({ payload }) => {
      try {
        const frame = JSON.parse(String(payload))
        if (frame && typeof frame === 'object' && !Array.isArray(frame)) {
          sink.push(frame as ReceivedFrame)
        }
      } catch {
        // Ignore protocol frames that are not JSON.
      }
    })
  })
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

async function waitForMaterializedSession(page: Page): Promise<FreshOpencodePaneState> {
  await expect.poll(async () => getFreshOpencodePaneState(page), { timeout: 30_000 }).toMatchObject({
    sessionId: expect.stringMatching(/^ses_/),
    resumeSessionId: expect.stringMatching(/^ses_/),
    initialCwd: expect.any(String),
    sessionRef: {
      provider: 'opencode',
      sessionId: expect.stringMatching(/^ses_/),
    },
  })
  const state = await getFreshOpencodePaneState(page)
  expect(state.sessionId).toBe(state.sessionRef?.sessionId)
  return state
}

async function waitForSettledPane(page: Page, sessionId: string): Promise<void> {
  await expect.poll(async () => {
    const state = await getFreshOpencodePaneState(page)
    return {
      sessionId: state.sessionId,
      status: state.status,
    }
  }, { timeout: 30_000 }).toEqual({
    sessionId,
    status: 'idle',
  })
}

test.describe('Freshopencode daemon-death self-heal (local lane)', () => {
  test.setTimeout(240_000)

  test('daemon self-exit self-heals end to end: loss banner, backoff respawn, revival refetch, no chime', async ({ page }) => {
    const sharedRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-freshopencode-daemon-death-'))
    const binDir = path.join(sharedRoot, 'bin')
    const logsDir = path.join(sharedRoot, 'logs')
    const auditLogPath = path.join(sharedRoot, 'fake-opencode-audit.jsonl')
    const sharedOpencodeDataDir = path.join(sharedRoot, 'opencode-data')
    const selfExitMarkerPath = path.join(sharedRoot, 'daemon-self-exit.marker')
    const cwd = path.join(sharedRoot, 'project')
    const firstPrompt = `freshopencode daemon-death first ${Date.now()}`
    const followUpPrompt = `freshopencode daemon-death follow-up ${Date.now()}`
    await fsp.mkdir(cwd, { recursive: true })
    await installFakeOpencode(binDir)

    const server = new RustServer(createServerOptions({
      binDir,
      auditLogPath,
      logsDir,
      sharedOpencodeDataDir,
      selfExitMarkerPath,
    }))

    const receivedFrames: ReceivedFrame[] = []
    try {
      const info = await server.start()
      captureReceivedFrames(page, info.wsUrl, receivedFrames)
      await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
      const harness = new TestHarness(page)
      await harness.waitForHarness()
      await harness.waitForConnection()
      await enableFreshOpencode(page)
      await createFreshopencodePane(page, cwd)

      // (1) The pane is materialized and live.
      await sendFreshAgentPrompt(page, firstPrompt)
      await expect(page.getByText(`Fake OpenCode response: ${firstPrompt}`)).toBeVisible({ timeout: 30_000 })
      const materialized = await waitForMaterializedSession(page)
      expect(materialized.initialCwd).toBe(cwd)
      const sessionId = materialized.sessionId!
      await waitForSettledPane(page, sessionId)

      const eventsBeforeDeath = await readAuditEvents(auditLogPath)
      const launchesBeforeDeath = managedServeLaunches(eventsBeforeDeath)
      expect(launchesBeforeDeath.length, 'the pane is served by a managed daemon before the death').toBeGreaterThanOrEqual(1)
      const firstDaemonPid = launchesBeforeDeath[launchesBeforeDeath.length - 1].pid!
      const eventCountBeforeDeath = eventsBeforeDeath.length
      const deathWindowStartIndex = receivedFrames.length

      // (2) The daemon dies an UNREQUESTED death: the fixture child consumes
      // the marker and exits ON ITS OWN — this writeFile is the test's ONLY
      // death-triggering action; no PID is ever signaled.
      await fsp.writeFile(selfExitMarkerPath, 'self-exit now\n')
      await expect.poll(async () => {
        const events = await readAuditEvents(auditLogPath)
        return events.slice(eventCountBeforeDeath).find((event) =>
          event.event === 'self_exit' && event.pid === firstDaemonPid) ?? null
      }, { timeout: 15_000 }).toBeTruthy()

      // (3) The pane shows the OPENCODE_DAEMON_LOST "Agent error:" banner.
      const daemonLostBanner = page.locator('[data-agent-error="session"]')
      await expect(daemonLostBanner.getByRole('alert')).toHaveText('Agent error', { timeout: 30_000 })
      await daemonLostBanner.locator('summary').click()
      await expect(daemonLostBanner).toContainText('The opencode serve daemon was lost unexpectedly')
      await expect(daemonLostBanner).toContainText('Agent error:')

      // The typed edge: exactly ONE OPENCODE_DAEMON_LOST frame for the
      // materialized session.
      await expect.poll(async () =>
        freshAgentEventFrames(receivedFrames, sessionId, 'freshAgent.error')
          .filter((frame) => frame.event.code === 'OPENCODE_DAEMON_LOST').length
      , { timeout: 30_000 }).toBe(1)

      // (4) The daemon respawns automatically within a bounded wait — a
      // second managed serve launch with a NEW pid in the audit log.
      let respawnedPid: number | undefined
      await expect.poll(async () => {
        const events = await readAuditEvents(auditLogPath)
        respawnedPid = managedServeLaunches(events)
          .find((event) => event.pid !== firstDaemonPid)?.pid
        return respawnedPid ?? null
      }, { timeout: 30_000 }).toBeTruthy()

      // (5) The pane recovers: the revival pass pushed the idle snapshot
      // (the client's transcript-refetch trigger)...
      await expect.poll(async () =>
        freshAgentEventFrames(receivedFrames, sessionId, 'freshAgent.session.snapshot')
          .filter((frame) => frame.event.status === 'idle').length
      , { timeout: 30_000 }).toBeGreaterThanOrEqual(1)
      // ...and the transcript refetch was SERVED by the respawned daemon
      // (session_get + message_list audits at the new pid; the refetch is
      // the only client-driven daemon read in this window).
      await expect.poll(async () => {
        const events = await readAuditEvents(auditLogPath)
        const afterRespawn = events.filter((event) => event.pid === respawnedPid)
        return {
          sessionGet: afterRespawn.some((event) =>
            event.event === 'session_get' && event.sessionId === sessionId),
          messageList: afterRespawn.some((event) =>
            event.event === 'message_list' && event.sessionId === sessionId),
        }
      }, { timeout: 30_000 }).toEqual({ sessionGet: true, messageList: true })

      // The refetched transcript still renders the first turn.
      await expect(page.getByText(`Fake OpenCode response: ${firstPrompt}`)).toBeVisible({ timeout: 15_000 })

      // (6) NO freshAgent.turn.complete during the death window (a crash is
      // never a positive completion). Asserted BEFORE the follow-up turn so
      // the window contains only the death→revival frames.
      const deathWindowFrames = receivedFrames.slice(deathWindowStartIndex)
      const chimeFramesDuringDeath = deathWindowFrames.filter((frame) =>
        frame?.type === 'freshAgent.event' && frame?.event?.type === 'freshAgent.turn.complete')
      expect(chimeFramesDuringDeath, 'no chime frames during the daemon-death window').toEqual([])

      // The pane kept its identity through the death and recovery.
      const paneStateAfterRecovery = await getFreshOpencodePaneState(page)
      expect(paneStateAfterRecovery.sessionId).toBe(sessionId)
      expect(paneStateAfterRecovery.status).not.toBe('create-failed')

      // The banner is dismissible — no dead-end remains.
      await daemonLostBanner.getByRole('button', { name: 'Dismiss' }).click()
      await expect(daemonLostBanner).toHaveCount(0)

      // The composer works against the RESPAWNED daemon: a follow-up turn
      // is served end to end by the new pid.
      const framesBeforeFollowUp = receivedFrames.length
      await sendFreshAgentPrompt(page, followUpPrompt)
      await expect(page.getByText(`Fake OpenCode response: ${followUpPrompt}`)).toBeVisible({ timeout: 30_000 })
      await waitForSettledPane(page, sessionId)
      await expect.poll(async () => {
        const events = await readAuditEvents(auditLogPath)
        return events.some((event) =>
          event.event === 'prompt_async'
          && event.sessionId === sessionId
          && event.routeDirectory === cwd
          && event.prompt === followUpPrompt
          && event.pid === respawnedPid)
      }, { timeout: 15_000 }).toBe(true)

      // Positive control for the chime absence: the follow-up turn's real
      // positive completion DID emit freshAgent.turn.complete — the lane is
      // alive, so the death-window silence was not vacuous.
      await expect.poll(async () =>
        receivedFrames.slice(framesBeforeFollowUp)
          .filter((frame) =>
            frame?.type === 'freshAgent.event'
            && frame?.event?.type === 'freshAgent.turn.complete'
            && frame?.event?.sessionId === sessionId).length
      , { timeout: 15_000 }).toBeGreaterThanOrEqual(1)
    } finally {
      await server.stop().catch(() => {})
      await fsp.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })
})
