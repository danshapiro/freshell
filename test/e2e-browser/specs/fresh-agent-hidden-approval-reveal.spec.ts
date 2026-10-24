/**
 * HIDDEN-PANE APPROVALS ON REVEAL (G26) — PW-RUST e2e.
 *
 * A Freshclaude pane's approval cards render ONLY from its REST snapshot
 * (`pendingApprovals`). When an approval is raised — or cancelled — while the
 * pane sits in a background tab, the user must find the right cards when they
 * come back to that tab, and must never be put behind the BLOCKING
 * "Refreshing conversation" overlay for it: that overlay waits for a newer
 * transcript revision, which an approval never produces, so it would spin
 * and then fail. G26 keeps this refresh non-blocking (a hidden pane owes one
 * 'reveal-surface' refresh instead of marking its transcript dirty).
 *
 *   1. an approval delivered while tab A is hidden shows its card after the
 *      reveal, and the overlay is never drawn;
 *   2. the same approval cancelled while tab A is hidden is gone after the
 *      reveal, and the overlay is never drawn.
 *
 * WHAT THIS DOES NOT ISOLATE: a hidden Claude pane already refetches its
 * snapshot whenever its Redux session record changes (the snapshot effect
 * depends on the whole `claudeSession` object and has no hidden guard), and
 * the permission frames change that record. So for Claude the card can be
 * current before the reveal, and this spec cannot tell G26's owed refresh
 * apart from that fetch; the hidden-rebind unit tests pin the owed refresh
 * itself. What this spec does catch is a regression to the blocking reveal
 * path (the overlay recorder) and a broken end-to-end journey.
 *
 * Trigger: a visible composer starts the turn. The production sidecar streams
 * the Bash tool-use transcript while tab A is visible; the test holds only
 * the resulting canUseTool approval frame at the WebSocket boundary, switches
 * tabs, then delivers that frame while A is hidden. The send and tool-use
 * transcript must not be hidden: their transcript changes legitimately test
 * the blocking transcript-refresh path instead of the approval-only reveal.
 * Then the client's own `freshAgent.interrupt` frame for the session — the
 * exact frame the Stream Deck "stop" sends to a pane in a background tab —
 * cancels it (the sidecar's interrupt-time pending cancellation, mirroring
 * the real one). The Stop reaches the sidecar because the parked turn is
 * running (an idle session's Stop sends nothing, C18).
 *
 * Stop also ends the turn, whose result legitimately invalidates the
 * transcript. Pause delivery immediately after the cancellation, preserving
 * WebSocket order, to isolate the approval-only reveal. Then deliver the
 * held result and assert that the normal turn end still reaches the client.
 *
 * CLOUD-LEGALITY: no timing dependencies — every wait is a poll on observed
 * state (simulator ledger, received WS frames, DOM). This spec must
 * NOT be added to CLOUD_SKIP_SPECS.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { test, expect } from '../helpers/fixtures.js'
import { RustServer } from '../helpers/rust-server.js'
import { TestHarness } from '../helpers/test-harness.js'
import { openPanePicker } from '../helpers/pane-picker.js'
import { claudeSimulatorServerEnv, readClaudeSimLedger } from '../helpers/claude-sim-lane.js'

const APPROVAL_REQUEST_ID = 'perm-raised-while-hidden'

/** The message that raises the approval (its turn parks on it). */
const RAISE_TEXT = 'raise an approval while hidden'

/** The send raises one Bash approval; the Stop cancels it. */
const SIMULATOR_PROGRAM = {
  rules: [
    {
      on: 'msg:prompt',
      match: { text: RAISE_TEXT },
      once: true,
      emit: [
        {
          kind: 'approval',
          data: { id: APPROVAL_REQUEST_ID, tool: 'Bash', input: { command: 'echo raised-while-hidden' } },
          delayMs: 3_000,
        },
      ],
    },
  ],
}

const REVEAL_OVERLAY_SELECTOR = [
  '[role="status"][aria-label="Refreshing conversation"]',
  '[role="alert"][aria-label="The conversation could not be refreshed."]',
].join(', ')

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

async function receivedFreshAgentEvents(harness: TestHarness, eventType: string): Promise<any[]> {
  const received = (await harness.getReceivedWsMessages()) as any[]
  return received.filter((msg) => msg?.type === 'freshAgent.event' && msg?.event?.type === eventType)
}

/** POST /api/tabs returns an unfocused tab, leaving the current pane visible. */
async function createBackgroundShellTab(info: { baseUrl: string; token: string }, cwd: string): Promise<string> {
  const res = await fetch(`${info.baseUrl}/api/tabs`, {
    method: 'POST',
    headers: { 'x-auth-token': info.token, 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'shell', cwd }),
  })
  const payload = await res.json()
  expect(res.ok, `POST /api/tabs: ${JSON.stringify(payload)}`).toBe(true)
  const tabId = payload?.data?.tabId
  expect(tabId, 'POST /api/tabs envelope data.tabId').toBeTruthy()
  return tabId as string
}

/** Record whether the blocking reveal overlay is EVER drawn from now on. */
async function armRevealOverlayRecorder(page: Page): Promise<void> {
  await page.evaluate((selector) => {
    const w = window as unknown as {
      __revealOverlaySeen?: boolean
      __revealOverlayObserver?: MutationObserver
    }
    w.__revealOverlayObserver?.disconnect()
    w.__revealOverlaySeen = false
    const check = () => {
      if (document.querySelector(selector)) w.__revealOverlaySeen = true
    }
    const observer = new MutationObserver(check)
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['role', 'aria-label'],
    })
    w.__revealOverlayObserver = observer
    check()
  }, REVEAL_OVERLAY_SELECTOR)
}

async function revealOverlaySeen(page: Page): Promise<boolean> {
  return page.evaluate(() => (window as unknown as { __revealOverlaySeen?: boolean }).__revealOverlaySeen === true)
}

test.describe('hidden fresh-agent panes show current approvals on reveal without blocking (G26)', () => {
  test.setTimeout(180_000)

  test('an approval raised, then cancelled, while the pane is hidden is current on reveal, with no blocking overlay', async ({ page }) => {
    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-hidden-approval-'))
    const simLedger = path.join(sharedRoot, 'claude-sim-ledger.jsonl')
    let server: RustServer | undefined
    let pauseAfterCancellation = false
    let deliveryPaused = false
    let heldResults = 0
    let heldPermissionRequest = false
    let releasePermissionRequest: (() => void) | null = null
    const heldDeliveries: Array<() => void> = []
    const releaseApprovalRequest = () => {
      const deliver = releasePermissionRequest
      releasePermissionRequest = null
      deliver?.()
    }
    const releaseDeliveries = () => {
      deliveryPaused = false
      for (const deliver of heldDeliveries.splice(0)) deliver()
    }
    try {
      await page.routeWebSocket('**/ws', (route) => {
        const upstream = route.connectToServer()
        upstream.onMessage((message) => {
          let frame: any
          try { frame = JSON.parse(String(message)) } catch { /* Forward non-JSON messages unchanged. */ }
          if (deliveryPaused) {
            if (frame?.type === 'freshAgent.event' && frame.event?.type === 'freshAgent.result') heldResults += 1
            heldDeliveries.push(() => route.send(message))
            return
          }
          // Deliver the streamed tool-use transcript while the pane is
          // visible, then hold only the approval surface event until its tab
          // is hidden. This isolates the non-blocking approval reveal from
          // the separate transcript-dirty reveal path.
          if (!heldPermissionRequest
            && frame?.type === 'freshAgent.event'
            && frame.event?.type === 'freshAgent.permission.request'
            && frame.provider === 'claude') {
            heldPermissionRequest = true
            releasePermissionRequest = () => route.send(message)
            return
          }
          route.send(message)
          if (pauseAfterCancellation && frame?.type === 'freshAgent.event'
            && frame.event?.type === 'freshAgent.permission.cancelled') {
            pauseAfterCancellation = false
            deliveryPaused = true
          }
        })
      })
      const projectDir = path.join(sharedRoot, 'project')
      await fs.mkdir(projectDir, { recursive: true })
      server = new RustServer({
        verbose: process.env.FRESHELL_E2E_SERVER_VERBOSE === '1',
        env: claudeSimulatorServerEnv({ ledgerPath: simLedger, program: SIMULATOR_PROGRAM }),
        setupHome: async (homeDir) => {
          const freshellDir = path.join(homeDir, '.freshell')
          await fs.mkdir(freshellDir, { recursive: true })
          await fs.writeFile(path.join(freshellDir, 'config.json'), JSON.stringify({
            version: 1,
            settings: {
              codingCli: { enabledProviders: ['claude'] },
              freshAgent: { enabled: true },
            },
          }, null, 2))
        },
      })
      const info = await server.start()
      await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
      const harness = new TestHarness(page)
      await harness.waitForHarness()
      await harness.waitForConnection()

      // ── Tab A: a Freshclaude pane replaces the boot tab's pane picker ─────
      await page.evaluate(() => {
        window.__FRESHELL_TEST_HARNESS__?.dispatch({
          type: 'connection/setAvailableClis',
          payload: { claude: true },
        })
      })
      const picker = await openPanePicker(page)
      await picker.getByRole('button', { name: /^Freshclaude$/i }).click({ force: true })
      const directoryInput = page.getByLabel(/^Starting directory for Freshclaude$/i)
      await expect(directoryInput).toBeVisible({ timeout: 15_000 })
      await directoryInput.fill(projectDir)
      await directoryInput.press('Enter')

      const tabA = (await harness.getActiveTabId())!
      expect(tabA).toBeTruthy()
      const leafA = async () => findFreshAgentLeaf(await harness.getPaneLayout(tabA))
      await expect
        .poll(async () => (await leafA())?.content?.sessionRef?.sessionId ?? '', { timeout: 30_000 })
        .toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
      await expect
        .poll(async () => (await leafA())?.content?.status ?? null, { timeout: 30_000 })
        .toBe('idle')
      const bridgeSessionId: string = (await leafA()).content.sessionId
      expect(bridgeSessionId, 'the pane is bound to its sidecar session').toBeTruthy()

      // The provider's saved default is bypassPermissions in a fresh test
      // HOME. This scenario needs a real canUseTool approval, so opt into the
      // asking mode through the same settings control a user would use.
      await page.getByRole('button', { name: 'Agent settings', exact: true }).click()
      await page.getByRole('combobox', { name: 'Permission mode' }).selectOption('default')
      await page.keyboard.press('Escape')
      await expect.poll(async () => {
        const content = findFreshAgentLeaf(await harness.getPaneLayout(tabA))?.content
        return content?.permissionMode ?? null
      }).toBe('default')
      await expect.poll(() => readClaudeSimLedger(simLedger).some(
        (row) => row.kind === 'control' && row.name === 'setPermissionMode' && row.args?.[0] === 'default',
      )).toBe(true)

      const paneA = page.locator('[data-context="fresh-agent"]').first()
      await expect(paneA).toBeVisible({ timeout: 15_000 })
      // The composer is up: the pane's first snapshot has rendered.
      await expect(paneA.getByRole('textbox', { name: 'Chat message input' })).toBeVisible({ timeout: 15_000 })

      // includeHidden: the card lives in a visibility-hidden background tab.
      const cardInAnyTab = page.getByRole('alert', { name: 'Permission request for Bash', includeHidden: true })
      const visibleCard = page.getByRole('alert', { name: 'Permission request for Bash' })
      await expect(cardInAnyTab, 'no approval before the trigger').toHaveCount(0)

      // Create B without changing focus, then start the turn while A is
      // visible. This keeps send acceptance out of the hidden-pane path.
      const tabB = await createBackgroundShellTab(info, os.tmpdir())
      await harness.waitForTabCount(2)
      expect(tabB).not.toBe(tabA)
      expect(await harness.getActiveTabId()).toBe(tabA)
      const tabALocator = page.locator(`[data-context="tab"][data-tab-id="${tabA}"]`)
      const tabBLocator = page.locator(`[data-context="tab"][data-tab-id="${tabB}"]`)

      const interruptHiddenPane = () => page.evaluate((sessionId) => {
        // The Stream Deck stop's exact frame for a fresh-agent pane.
        window.__FRESHELL_TEST_HARNESS__?.sendWsMessage({
          type: 'freshAgent.interrupt',
          sessionId,
          sessionType: 'freshclaude',
          provider: 'claude',
        })
      }, bridgeSessionId)

      // ── 1. An approval delivered while hidden appears on reveal ─────────
      const composer = paneA.getByRole('textbox', { name: 'Chat message input' })
      await composer.fill(RAISE_TEXT)
      await paneA.getByRole('button', { name: 'Send' }).click()
      await expect.poll(() => readClaudeSimLedger(simLedger).some(
        (row) => row.kind === 'prompt' && row.text === RAISE_TEXT,
      ), { timeout: 15_000, message: 'the visible pane starts the approval-triggering prompt' }).toBe(true)
      let sendRequestId = ''
      await expect.poll(async () => {
        const sends = (await harness.getSentWsMessages())
          .filter((message: any) => message?.type === 'freshAgent.send' && message?.text === RAISE_TEXT)
        sendRequestId = sends.at(-1)?.requestId ?? ''
        return sendRequestId
      }, { timeout: 10_000, message: 'the visible turn has a request id before the tab switch' }).toBeTruthy()
      await expect.poll(async () => (await harness.getReceivedWsMessages()).some(
        (message: any) => message?.type === 'freshAgent.send.accepted' && message?.requestId === sendRequestId,
      ), { timeout: 10_000, message: 'the server accepted the send while tab A is still visible' }).toBe(true)
      await expect.poll(async () => (await leafA())?.content?.status, {
        timeout: 10_000,
        message: 'the visible pane observed the turn start before it is hidden',
      }).toBe('running')
      // The tool-use transcript and assistant line arrive while A remains
      // visible. The matching canUseTool request is held at the WS boundary.
      await expect.poll(async () => {
        const received = ((await harness.getReceivedWsMessages()) as any[]).filter((message) => (
          message?.type === 'freshAgent.event' && message.sessionId === bridgeSessionId
        ))
        const assistant = received.find((message) => message.event?.type === 'freshAgent.assistant'
          && message.event?.content?.some((block: any) => block?.type === 'tool_use' && block?.name === 'Bash'))
        return typeof assistant?.event?.uuid === 'string'
          && received.some((message) => message.event?.type === 'freshAgent.session.changed'
            && message.event?.reason === 'transcript'
            && message.event?.uuid === assistant.event.uuid)
      }, {
        timeout: 15_000,
        message: 'the prompt and Bash tool-use transcript land while the pane is visible',
      }).toBe(true)
      await expect
        .poll(() => readClaudeSimLedger(simLedger).filter((row) => row.kind === 'approval').length, {
          timeout: 15_000,
          message: 'the simulated CLI invokes the production canUseTool approval path',
        })
        .toBe(1)
      await expect.poll(() => releasePermissionRequest !== null, {
        timeout: 15_000,
        message: 'the pending approval event is held at the WS boundary',
      }).toBe(true)
      expect(await harness.getActiveTabId(), 'the transcript changed while tab A was visible').toBe(tabA)
      // The approval event arrives after A is hidden; no transcript-changing
      // event is introduced in the hidden interval before this surface update.
      await tabBLocator.click()
      await expect.poll(() => harness.getActiveTabId(), { timeout: 10_000 }).toBe(tabB)
      releaseApprovalRequest()
      try {
        await expect
          .poll(async () => (await receivedFreshAgentEvents(harness, 'freshAgent.permission.request')).length, {
            timeout: 15_000,
            message: 'the client receives the approval while tab A is hidden',
          })
          .toBe(1)
      } catch (error) {
        const rows = readClaudeSimLedger(simLedger)
        const received = (await harness.getReceivedWsMessages()) as any[]
        const diagnostic = {
          severity: 'error',
          event: 'e2e.claude_hidden_approval_diagnostic',
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
      expect(await harness.getActiveTabId(), 'the approval arrived while tab A was hidden').toBe(tabB)

      await armRevealOverlayRecorder(page)
      await tabALocator.click()
      await expect.poll(() => harness.getActiveTabId(), { timeout: 10_000 }).toBe(tabA)
      await expect(paneA, 'the reveal has rendered the pane').toBeVisible()
      await expect(visibleCard, 'the revealed pane shows the approval card').toBeVisible({ timeout: 15_000 })
      expect(await revealOverlaySeen(page), 'the reveal never blocks behind "Refreshing conversation"').toBe(false)

      // ── 2. The same approval CANCELLED while hidden is gone on reveal ────
      await tabBLocator.click()
      await expect.poll(() => harness.getActiveTabId(), { timeout: 10_000 }).toBe(tabB)
      pauseAfterCancellation = true
      await interruptHiddenPane()
      await expect
        .poll(() => readClaudeSimLedger(simLedger).filter((row) => row.kind === 'interrupt').length, {
          timeout: 15_000,
          message: 'the server forwards the Stop of the parked turn',
        })
        .toBe(1)
      await expect
        .poll(async () => (await receivedFreshAgentEvents(harness, 'freshAgent.permission.cancelled')).length, {
          timeout: 15_000,
          message: 'the client receives the cancellation while tab A is hidden',
        })
        .toBe(1)
      await expect.poll(() => heldResults, {
        timeout: 15_000,
        message: 'the Stop result is held after the cancellation, in wire order',
      }).toBe(1)
      expect(await receivedFreshAgentEvents(harness, 'freshAgent.result')).toHaveLength(0)
      expect(await harness.getActiveTabId(), 'the cancellation arrived while tab A was hidden').toBe(tabB)

      await armRevealOverlayRecorder(page)
      await tabALocator.click()
      await expect.poll(() => harness.getActiveTabId(), { timeout: 10_000 }).toBe(tabA)
      await expect(paneA, 'the reveal has rendered the pane').toBeVisible()
      await expect(cardInAnyTab, 'the revealed pane no longer shows the cancelled card').toHaveCount(0, { timeout: 15_000 })
      expect(await revealOverlaySeen(page), 'the reveal never blocks behind "Refreshing conversation"').toBe(false)
      releaseDeliveries()
      await expect.poll(async () => (await receivedFreshAgentEvents(harness, 'freshAgent.result')).length, {
        timeout: 15_000,
        message: 'the stopped turn result is delivered after the approval-only reveal',
      }).toBe(1)
    } finally {
      try { releaseApprovalRequest() } catch { /* The page can already be closed after a failed test. */ }
      try { releaseDeliveries() } catch { /* The page can already be closed after a failed test. */ }
      await server?.stop().catch(() => {})
      await fs.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })
})
