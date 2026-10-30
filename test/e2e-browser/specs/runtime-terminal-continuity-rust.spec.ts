/**
 * Phase 2 Durable Souls browser gate.
 *
 * Uses a real Chromium page, a feature-enabled real Rust web server, the real
 * supervisor over its authenticated UDS, Docker, and the real session-host PTY.
 * Web restart methods own only the web PID; the managed runtime is a separate
 * Docker enclosure and is verified by supervisor inventory + exact broker receipt.
 */
import { expect } from '@playwright/test'

import { test } from '../helpers/fixtures.js'
import { createManagedRuntimeBrowserRig, createManagedOpenCodeRuntimeBrowserRig, P2_OPENCODE_MODEL, P2_OPENCODE_VERSION,
  type ManagedFixtureRig, type ManagedRuntimeView, type RuntimeTerminalContinuityObservation } from '../helpers/managed-runtime.js'
import { waitForOpenCodeTerminalCondition } from '../helpers/opencode-native-history.js'
import { TestHarness } from '../helpers/test-harness.js'
import { TerminalHelper } from '../helpers/terminal-helpers.js'
import { openPanePicker } from '../helpers/pane-picker.js'
import { bindInterruptedOrdinaryStopFailedAck, reportInterruptedOrdinaryStopAckFailure } from '../helpers/runtime-chaos-evidence.js'

function findTerminalLeaves(node: any, out: any[] = []): any[] {
  if (!node) return out
  if (node.type === 'leaf' && node.content?.kind === 'terminal') out.push(node)
  if (node.type === 'split') for (const child of node.children ?? []) findTerminalLeaves(child, out)
  return out
}

async function ensureShell(page: import('@playwright/test').Page, terminal: TerminalHelper): Promise<void> {
  if (await page.locator('.xterm').first().isVisible().catch(() => false)) return
  for (const name of ['Shell', 'Bash', 'WSL', 'CMD', 'PowerShell']) {
    const button = page.getByRole('button', { name: new RegExp(`^${name}$`, 'i') }).first()
    if (await button.isVisible().catch(() => false)) {
      await button.click()
      await terminal.waitForTerminal(0, 30_000)
      return
    }
  }
  throw new Error('managed runtime browser gate could not select a shell from the real pane picker')
}

type TerminalIdentity = {
  tabId: string
  terminalId: string
  createRequestId: string
}

async function waitForValue<T>(
  description: string,
  probe: () => T | null | undefined | Promise<T | null | undefined>,
  timeoutMs: number,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      const value = await probe()
      if (value !== null && value !== undefined) return value
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  const suffix = lastError instanceof Error ? `; last error: ${lastError.message}` : ''
  throw new Error(`timed out waiting for ${description}${suffix}`)
}

async function readTerminalIdentity(harness: TestHarness): Promise<TerminalIdentity | null> {
  const tabId = await harness.getActiveTabId()
  if (!tabId) return null
  const leaves = findTerminalLeaves(await harness.getPaneLayout(tabId))
  if (leaves.length !== 1) return null
  const { terminalId, createRequestId } = leaves[0].content
  if (typeof terminalId !== 'string' || typeof createRequestId !== 'string') return null
  return { tabId, terminalId, createRequestId }
}

function waitForTerminalIdentity(harness: TestHarness, timeoutMs: number): Promise<TerminalIdentity> {
  return waitForValue('one anchored terminal identity', () => readTerminalIdentity(harness), timeoutMs)
}

function waitForRunningView(
  rig: ManagedFixtureRig,
  terminalId: string,
  timeoutMs: number,
): Promise<ManagedRuntimeView> {
  return waitForValue(`running managed view for terminal ${terminalId}`, () => rig.runningViewForTerminal(terminalId), timeoutMs)
}

function leavesByMode(node: any, mode: string): any[] {
  if (!node) return []
  if (node.type === 'leaf') return node.content?.mode === mode ? [node] : []
  if (node.type === 'split') return (node.children ?? []).flatMap((child: any) => leavesByMode(child, mode))
  return []
}

function waitForModeLeaf(
  harness: TestHarness,
  tabId: string,
  mode: string,
  predicate: (leaf: any) => boolean,
  timeoutMs: number,
): Promise<any> {
  return waitForValue(`${mode} pane identity`, async () => {
    const leaf = leavesByMode(await harness.getPaneLayout(tabId), mode).find(predicate)
    return leaf?.content?.terminalId ? leaf : null
  }, timeoutMs)
}

function waitForSessionId(content: () => Promise<any>, timeoutMs: number): Promise<string> {
  return waitForValue('native provider session id', async () => {
    const sessionId = (await content())?.sessionRef?.sessionId
    return typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : null
  }, timeoutMs)
}

test.describe.serial('Phase 2 managed runtime continuity', () => {
  test('P2-G01: real browser shell survives ten graceful/abrupt web replacements', async ({ page }) => {
    test.setTimeout(1_800_000)

    const wsEvents: Array<Record<string, unknown>> = []
    const recordWsEvent = (event: Record<string, unknown>) => {
      wsEvents.push({ at: Date.now(), ...event })
      if (wsEvents.length > 200) wsEvents.shift()
    }
    page.on('websocket', (socket) => {
      recordWsEvent({ event: 'open', url: socket.url() })
      socket.on('close', () => recordWsEvent({ event: 'close' }))
      for (const event of ['framesent', 'framereceived'] as const) {
        const listener = (frame: { payload: string | Buffer }) => {
          try {
            const message = JSON.parse(String(frame.payload))
            recordWsEvent({ event, type: message.type, terminalId: message.terminalId, code: message.code })
          } catch {
            recordWsEvent({ event, type: 'non-json' })
          }
        }
        if (event === 'framesent') socket.on(event, listener)
        else socket.on(event, listener)
      }
    })

    const rig = createManagedRuntimeBrowserRig()
    try {
      const info = await rig.start()
      await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
      const harness = new TestHarness(page)
      const terminal = new TerminalHelper(page)
      await harness.waitForHarness()
      await harness.waitForConnection()
      await ensureShell(page, terminal)
      await terminal.waitForPrompt({ timeout: 90_000 })

      const initialPane = await waitForTerminalIdentity(harness, 90_000)
      const initialView = await waitForRunningView(rig, initialPane.terminalId, 90_000)
      if (!initialView?.containerId || !initialView.hostBootId) throw new Error('managed runtime view missing container/host identity')

      // Two long-lived descendants: one heartbeat producer proves output is
      // continuously drained while web disappears; one plain sleep gives a
      // stable child PID to assert across every replacement.
      await terminal.executeCommandInserted(
        `(i=0; while true; do echo P2_HEARTBEAT:$i; i=$((i+1)); sleep 1; done) & echo P2_HEARTBEAT_PID=$!; sleep 3600 & child=$!; echo "$child" > "$HOME/p2-child-pid"; echo P2_CHILD_READY`,
      )
      await terminal.waitForOutput('P2_CHILD_READY', { timeout: 20_000, terminalId: initialPane.terminalId })
      const childEnclosure = rig.runtimeEnclosureHandle(initialView)
      const childPid = await waitForValue('numeric original owned child PID', async () => (
        (await rig.terminalChildFacts(childEnclosure)).pid
      ), 20_000)
      expect(await rig.terminalChildFacts(childEnclosure)).toEqual({ pid: childPid, running: true })
      const seeded = await terminal.getVisibleText(initialPane.terminalId)
      const originalIdentity = {
        soulId: initialView.soulId,
        incarnationId: initialView.incarnationId,
        containerId: initialView.containerId,
        hostBootId: initialView.hostBootId,
        childPid,
      }
      const receiptCount = (await rig.ownershipFacts()).receiptCount
      let outputAdvanced = false
      let lastHeartbeat = Number(seeded.match(/P2_HEARTBEAT:(\d+)/g)?.at(-1)?.split(':')[1] ?? -1)

      for (let cycle = 1; cycle <= 10; cycle += 1) {
        const previousLastReadyAt = await harness.getLastReadyAt()
        if (cycle % 2 === 1) await rig.restartWebGracefully()
        else await rig.crashAndRestartWeb()

        await harness.waitForConnectionAfter(previousLastReadyAt, 90_000)
        const pane = await waitForTerminalIdentity(harness, 60_000)
        expect(pane.createRequestId).toBe(initialPane.createRequestId)
        // Managed IDs are deterministic from createRequestId; this also proves
        // the restarted web server did not mint a conflicting runtime payload.
        expect(pane.terminalId).toBe(initialPane.terminalId)

        const view = await waitForRunningView(rig, pane.terminalId, 60_000)
        expect(view?.soulId).toBe(originalIdentity.soulId)
        expect(view?.incarnationId).toBe(originalIdentity.incarnationId)
        expect(view?.containerId).toBe(originalIdentity.containerId)
        expect(view?.hostBootId).toBe(originalIdentity.hostBootId)
        expect((await rig.ownershipFacts()).receiptCount).toBe(receiptCount)
        expect(await rig.terminalChildFacts(childEnclosure)).toEqual({ pid: childPid, running: true })

        const failWithDiagnostics = async (error: unknown): Promise<never> => {
          const connection = await page.evaluate(() => ({
            ws: window.__FRESHELL_TEST_HARNESS__?.getWsReadyState(),
            redux: window.__FRESHELL_TEST_HARNESS__?.getState()?.connection,
            managedRuntime: window.__FRESHELL_TEST_HARNESS__?.getState()?.managedRuntime,
          })).catch(() => null)
          const webProcess = await rig.webProcessFacts().catch(() => null)
          const ownerDiagnostics = await rig.captureTerminalContinuityDiagnostics(childEnclosure)
          const terminalText = await terminal.getVisibleText(pane.terminalId).catch(() => '')
          throw new Error(`${error instanceof Error ? error.message : String(error)}; diagnostics=${JSON.stringify({
            cycle, lastHeartbeat, connection, webProcess,
            paneContent: findTerminalLeaves(await harness.getPaneLayout(pane.tabId))[0]?.content,
            wsEvents: wsEvents.slice(-100),
            terminalTail: terminalText.slice(-800),
            ownerDiagnostics,
          })}`)
        }

        const heartbeat = await waitForValue(`heartbeat advance after web cycle ${cycle}`, async () => {
            const text = await terminal.getVisibleText(pane.terminalId)
            const value = Number(text.match(/P2_HEARTBEAT:(\d+)/g)?.at(-1)?.split(':')[1] ?? -1)
            return value > lastHeartbeat ? value : null
          }, 60_000).catch(failWithDiagnostics)
        outputAdvanced = true
        lastHeartbeat = heartbeat

        const marker = `P2_WEB_CYCLE_${cycle}_${Date.now()}`
        await terminal.executeCommandInserted(
          `printf '%s\n' ${JSON.stringify(marker)} > "$HOME/p2-web-cycle-${cycle}"`,
        )
        try {
          await waitForValue(`owned terminal cycle marker ${marker}`, async () => (
            await rig.terminalWebCycleCompleted(childEnclosure, marker)
          ) ? true : null, 30_000)
        } catch (error) {
          await failWithDiagnostics(error)
        }

        expect(await harness.getTabCount()).toBe(1)
        expect(findTerminalLeaves(await harness.getPaneLayout(pane.tabId))).toHaveLength(1)
      }

      expect(outputAdvanced).toBe(true)
      const receipt: RuntimeTerminalContinuityObservation = {
        caseId: 'P2-G01',
        status: 'PASS',
        restartCycles: 10,
        ...originalIdentity,
        outputAdvanced: true,
        inputUsable: true,
        viewAssociations: 1,
        createRequestId: initialPane.createRequestId,
        terminalId: initialPane.terminalId,
      }
      const { artifactRef } = await rig.publishTerminalContinuityReceipt(childEnclosure, receipt)
      console.log(`[P2-G01] browser continuity receipt: ${artifactRef}`)
    } finally {
      const cleanup = await rig.stop()
      expect(cleanup.ok, cleanup.errors.join('\n')).toBe(true)
    }
  })

  test('P2-G04: OpenAI-authenticated OpenCode tool turn survives web replacement in one native session', async ({ page }) => {
    test.setTimeout(900_000)

    // Private native grants are validated and mounted by the rig owner.
    const rig = createManagedOpenCodeRuntimeBrowserRig(process.cwd(), 2)
    try {
      const info = await rig.start()
      await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
      const harness = new TestHarness(page)
      const terminal = new TerminalHelper(page)
      await harness.waitForHarness()
      await harness.waitForConnection()
      await ensureShell(page, terminal)
      await terminal.waitForPrompt({ timeout: 90_000 })
      const tabId = await harness.getActiveTabId()
      if (!tabId) throw new Error('P2-G04 has no active tab')

      const before = new Set(leavesByMode(await harness.getPaneLayout(tabId), 'opencode').map((leaf) => leaf.id))
      const picker = await openPanePicker(page)
      await picker.getByRole('button', { name: /^OpenCode$/i }).click({ force: true })
      const dirInput = page.getByRole('combobox', { name: /Starting directory for OpenCode/i })
      await expect(dirInput).toBeVisible({ timeout: 15_000 })
      await dirInput.fill(rig.repoRoot)
      await dirInput.press('Enter')

      const opencodeLeaf = await waitForModeLeaf(
        harness,
        tabId,
        'opencode',
        (candidate) => !before.has(candidate.id),
        90_000,
      )
      const paneId: string = opencodeLeaf.id
      const terminalId: string = opencodeLeaf.content.terminalId
      const content = async () => {
        const leaves = leavesByMode(await harness.getPaneLayout(tabId), 'opencode')
        return leaves.find((leaf) => leaf.id === paneId)?.content
      }
      const view = await waitForRunningView(rig, terminalId, 90_000)
      if (!view?.containerId || !view.hostBootId) throw new Error('real OpenCode managed view missing ownership identity')
      expect((await rig.openCodeVersionFacts(rig.runtimeEnclosureHandle(view))).version).toBe(P2_OPENCODE_VERSION)
      const continuityEnclosure = rig.runtimeEnclosureHandle(view)
      const startupFacts = await rig.openCodeContinuityStartupFacts(continuityEnclosure)
      expect(startupFacts.authPresent).toBe(true)
      expect(startupFacts.modelAvailable).toBe(true)
      expect(startupFacts.explicitModelArg).toBe(true)
      expect(startupFacts.loopbackHostname).toBe(true)
      expect(startupFacts.explicitPort).toBe(true)

      const opencodeIndex = Math.max(0, (await page.locator('.xterm').count()) - 1)
      await waitForOpenCodeTerminalCondition({
        readTerminalText: () => terminal.getVisibleText(terminalId),
        wait: (milliseconds) => page.waitForTimeout(milliseconds),
        description: 'the OpenCode prompt',
        succeeds: (text) => text.includes('Ask anything...'),
        timeoutMs: 90_000,
      })
      const firstTurnMarker = 'P2_OPENCODE_FIRST_TURN_DONE'
      await terminal.executeCommandInserted(
        'Use the bash tool to run exactly: echo P2_OPENCODE_FIRST_TURN_DONE > "$HOME/p2-opencode-first-turn". Reply with exactly READY when the command completes.',
        opencodeIndex,
      )
      await waitForOpenCodeTerminalCondition({
        readTerminalText: () => terminal.getVisibleText(terminalId),
        wait: (milliseconds) => page.waitForTimeout(milliseconds),
        description: `OpenCode tool marker ${firstTurnMarker}`,
        succeeds: () => rig.openCodeContinuityFirstTurnCompleted(continuityEnclosure),
        timeoutMs: 90_000,
      })

      const sessionId = await waitForSessionId(content, 90_000)
      expect(sessionId).toMatch(/^ses_/)
      const firstTurn = await waitForValue('native OpenCode first reply', () => (
        rig.openCodeContinuityFirstReply(rig.exactRuntimeHandle({ ...view, nativeSessionId: sessionId }))
      ), 30_000)
      expect(`${firstTurn.resolvedProvider}/${firstTurn.resolvedModel}`).toBe(P2_OPENCODE_MODEL)

      await new Promise((resolve) => setTimeout(resolve, 1_000))
      await terminal.executeCommandInserted(
        'Use the bash tool to run exactly: sleep 12; echo P2_OPENCODE_TOOL_DONE >> "$HOME/p2-opencode-tool-count". Do not finish your response until that command completes.',
        opencodeIndex,
      )
      await waitForValue('owned OpenCode long-tool process', async () => (
        await rig.openCodeContinuityLongToolRunning(continuityEnclosure)
      ) ? true : null, 60_000)

      const previousLastReadyAt = await harness.getLastReadyAt()
      await rig.crashAndRestartWeb()
      await harness.waitForConnectionAfter(previousLastReadyAt, 90_000)
      const afterLeaf = await waitForModeLeaf(
        harness,
        tabId,
        'opencode',
        (leaf) => leaf.id === paneId,
        60_000,
      )
      expect(afterLeaf.content.terminalId).toBe(terminalId)
      await expect.poll(async () => (await content())?.sessionRef?.sessionId ?? null, { timeout: 60_000 }).toBe(sessionId)
      const afterView = await waitForRunningView(rig, terminalId, 60_000)
      expect(afterView?.soulId).toBe(view.soulId)
      expect(afterView?.incarnationId).toBe(view.incarnationId)
      expect(afterView?.containerId).toBe(view.containerId)
      expect(afterView?.hostBootId).toBe(view.hostBootId)

      await expect.poll(() => rig.openCodeContinuityEffectCount(continuityEnclosure), { timeout: 60_000 }).toBe(1)

      const afterIndex = Math.max(0, (await page.locator('.xterm').count()) - 1)
      await new Promise((resolve) => setTimeout(resolve, 1_000))
      await terminal.executeCommandInserted(
        'Use the bash tool to run exactly: echo P2_OPENCODE_FOLLOWUP_DONE > "$HOME/p2-opencode-followup". Reply with exactly FOLLOWUP when the command completes.',
        afterIndex,
      )
      await expect.poll(() => rig.openCodeContinuityFollowUpCompleted(continuityEnclosure), { timeout: 90_000 }).toBe(true)
      const hostFacts = await rig.chaosHostFacts(rig.exactRuntimeHandle({ ...view, nativeSessionId: sessionId }))
      expect(hostFacts.workerLaunchCount).toBe(1)
      expect((await content())?.sessionRef?.sessionId).toBe(sessionId)

      const receipt: RuntimeTerminalContinuityObservation = {
        caseId: 'P2-G04',
        status: 'PASS',
        provider: 'opencode',
        modelProvider: firstTurn.resolvedProvider,
        opencodeVersion: P2_OPENCODE_VERSION,
        model: `${firstTurn.resolvedProvider}/${firstTurn.resolvedModel}`,
        resolvedModel: firstTurn.resolvedModel,
        freeTier: false,
        nativeSessionId: sessionId,
        sameNativeSession: true,
        sameIncarnation: true,
        soulId: view.soulId,
        incarnationId: view.incarnationId,
        containerId: view.containerId,
        hostBootId: view.hostBootId,
        toolCompletionCount: 1,
        followupSucceeded: true,
        providerLaunchCount: hostFacts.workerLaunchCount,
      }
      const { artifactRef } = await rig.publishTerminalContinuityReceipt(continuityEnclosure, receipt)
      console.log(`[P2-G04] real OpenCode continuity receipt: ${artifactRef}`)
    } finally {
      const cleanup = await rig.stop()
      expect(cleanup.ok, cleanup.errors.join('\n')).toBe(true)
    }
  })

  test('synthetic interrupted ordinary Stop preserves history', async ({ page }, testInfo) => {
    test.skip(process.env.FRESHELL_RUNTIME_SYNTHETIC_RESUME !== '1', 'requires the explicit synthetic runtime lane')
    test.setTimeout(900_000)
    const supervisorEnv = {
      FRESHELL_RUNTIME_HOST_COMMAND_TIMEOUT_MS: '5000',
      FRESHELL_RUNTIME_FRESH_AGENT_COMMAND_TIMEOUT_MS: '10000',
      FRESHELL_RUNTIME_OBSERVER_INTERVAL_MS: '60000',
    }
    const rig = createManagedRuntimeBrowserRig(process.cwd(), 3, {}, supervisorEnv, 'test', {
      enabledProviders: [], freshAgentModes: ['freshcodex'], fixtureFreshAgentModes: ['freshcodex'],
      providerSettings: { freshcodex: {} },
    })
    const historyResponses: Array<{
      route: 'managed' | 'native'; status: number; threadId?: string; turnCount?: number; canSend?: boolean
    }> = []
    const historyResponseReads: Promise<void>[] = []
    page.on('response', (response) => {
      if (response.request().method() !== 'GET') return
      const pathname = new URL(response.url()).pathname
      const route = pathname.startsWith('/api/runtime/souls/') && pathname.endsWith('/history')
        ? 'managed'
        : pathname.startsWith('/api/fresh-agent/threads/') ? 'native' : undefined
      if (!route) return
      const fact: (typeof historyResponses)[number] = { route, status: response.status() }
      historyResponses.push(fact)
      historyResponseReads.push(response.json().then((body: any) => {
        if (typeof body.threadId === 'string') fact.threadId = body.threadId
        if (Array.isArray(body.turns)) fact.turnCount = body.turns.length
        if (typeof body.capabilities?.send === 'boolean') fact.canSend = body.capabilities.send
      }).catch(() => undefined))
    })
    const sent: any[] = []
    const received: any[] = []
    const socketStartedAt = Date.now()
    const socketLifecycle: { socketOrdinal: number; atMs: number; event: string }[] = []
    const sentSocketFacts: { socketOrdinal: number; atMs: number }[] = []
    const receivedSocketFacts: { socketOrdinal: number; atMs: number }[] = []
    let socketCount = 0
    page.on('websocket', (socket) => {
      const socketOrdinal = ++socketCount
      const socketEvent = (event: string) => socketLifecycle.push({ socketOrdinal, atMs: Date.now() - socketStartedAt, event })
      socketEvent('created')
      let observedOpen = false
      const frameFacts = () => {
        if (!observedOpen) { socketEvent('open-observed-by-frame'); observedOpen = true }
        return { socketOrdinal, atMs: Date.now() - socketStartedAt }
      }
      socket.on('framesent', (frame) => {
        sent.push(JSON.parse(String(frame.payload)))
        sentSocketFacts.push(frameFacts())
      })
      socket.on('framereceived', (frame) => {
        received.push(JSON.parse(String(frame.payload)))
        receivedSocketFacts.push(frameFacts())
      })
      socket.on('close', () => { socketEvent('closed') })
      socket.on('socketerror', () => { socketEvent('error') })
    })
    try {
      const info = await rig.start()
      const settings = await fetch(`${info.baseUrl}/api/settings`, {
        method: 'PATCH', headers: { 'content-type': 'application/json', 'x-auth-token': info.token },
        body: JSON.stringify({ codingCli: { enabledProviders: ['codex'] } }),
      })
      expect(settings.ok).toBe(true)
      await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1&perfAudit=1`)
      const harness = new TestHarness(page)
      await harness.waitForHarness()
      await harness.waitForConnection()
      await page.getByRole('button', { name: 'Freshcodex', exact: true }).click()
      await page.getByRole('option', { name: rig.repoRoot, exact: true }).click()
      const created = await waitForValue('registered synthetic pane', async () => {
        const state = await harness.getState()
        const tabId = state.tabs.activeTabId!
        const leaf = state.panes.layouts[tabId]
        return leaf?.type === 'leaf' && leaf.content.kind === 'fresh-agent'
          ? { tabId, paneId: leaf.id, createRequestId: leaf.content.createRequestId } : null
      }, 60_000)
      const createdReply = await waitForValue('synthetic fresh-agent create acknowledgement', async () => {
        const reply = received.find((frame) => frame.type === 'freshAgent.created' && frame.requestId === created.createRequestId)
        return typeof reply?.sessionId === 'string' && reply.sessionId.length > 0 ? reply : null
      }, 60_000)
      const view = await waitForValue('synthetic managed native root', async () => {
        const current = await rig.runningViewForFreshSession(createdReply.sessionId)
        return current?.containerId && current.nativeSessionId ? current : null
      }, 90_000)
      const nativeId = view.nativeSessionId!
      const handle = rig.exactRuntimeHandle(view)
      await rig.prepareInterruptedOrdinaryStopHistory(handle)
      const history = async () => {
        const response = await fetch(`${info.baseUrl}/api/fresh-agent/threads/freshcodex/codex/${nativeId}`, {
          headers: { 'x-auth-token': info.token },
        })
        expect(response.ok).toBe(true)
        return response.json()
      }
      const retained = await history()
      expect(retained.threadId).toBe(nativeId)
      expect(retained.turns).toHaveLength(6)
      expect(retained.turns.flatMap((turn: any) => turn.items).map((item: any) => item.text))
        .toEqual([0, 1, 2].flatMap((index) => [`Synthetic saved prompt ${index}`, `Synthetic saved answer ${index}`]))

      // Arm only the test supervisor. Its durable registry, secret, native
      // store and existing provider remain the exact registered originals.
      await rig.armInterruptedOrdinaryStop(handle)
      let ready = await harness.getLastReadyAt()
      await rig.restartWebGracefully()
      await harness.waitForConnectionAfter(ready, 90_000)
      await page.reload()
      await harness.waitForHarness()
      await harness.waitForConnection()
      const pane = page.locator(`[data-pane-shell="true"][data-pane-id="${created.paneId}"]`)
      await expect(pane.getByText('Synthetic saved answer 2', { exact: true })).toBeVisible({ timeout: 60_000 })
      const original = (await harness.getPaneLayout(created.tabId)).content
      expect(original.soulId).toBe(view.soulId)
      expect(original.sessionRef.sessionId).toBe(nativeId)
      const canonical = { soulId: original.soulId, sessionRef: original.sessionRef,
        createRequestId: original.createRequestId }
      const beforeFacts = await rig.installInterruptedOrdinaryStopCounters(handle)
      const before = beforeFacts.durable
      expect(before.incarnations).toHaveLength(1)
      expect(before.writers).toBe(1)
      const receiptCount = (await rig.ownershipFacts()).receiptCount
      const workerLaunchCount = beforeFacts.workerLaunchCount
      const closeState = await harness.getState()
      const closePane = closeState.panes.layouts[created.tabId]
      const sentAtStop = sent.length
      const receivedAtStop = received.length
      const stopSocketAtMs = Date.now() - socketStartedAt

      // Close pane sends the fenced, acknowledged ordinary Stop. Composer
      // Stop interrupts a turn and does not commit durable stopped intent.
      await pane.getByRole('button', { name: 'Close pane', exact: true }).click()
      await expect.poll(async () => (await rig.interruptedOrdinaryStopCrashFacts(handle)).running, { timeout: 30_000 }).toBe(false)
      const crash = await rig.interruptedOrdinaryStopCrashFacts(handle)
      expect(crash.crashPoint).toBe('ordinary_stop_after_intent')
      expect(crash.exitCode).toBe(134)
      try {
        const hasFailedAck = bindInterruptedOrdinaryStopFailedAck(sent, sentAtStop, {
          pane: closePane, paneId: created.paneId, createRequestId: canonical.createRequestId,
          soulId: view.soulId, nativeSessionId: nativeId, provider: 'codex', sessionType: 'freshcodex',
          pendingCreate: closeState.freshAgent.pendingCreates[canonical.createRequestId],
        })
        await expect.poll(() => hasFailedAck(received, receivedAtStop), { timeout: 30_000 }).toBe(true)
      } catch (failure) {
        await reportInterruptedOrdinaryStopAckFailure(failure, testInfo, {
          expected: { presentationSessionId: original.sessionId ?? null, nativeSessionId: nativeId, soulId: view.soulId },
          sentAtStop, receivedAtStop, stopSocketAtMs, sent, received, sentSocketFacts, receivedSocketFacts, socketLifecycle,
        })
      }
      expect(sent.slice(sentAtStop).filter((frame) => frame.type === 'freshAgent.kill')).toHaveLength(1)
      await expect(pane).toBeVisible()
      const afterStop = (await harness.getPaneLayout(created.tabId)).content
      expect(afterStop).toMatchObject(canonical)
      await expect(pane.getByText('Synthetic saved answer 2', { exact: true })).toBeVisible()

      await rig.restartSupervisor()
      const stopped = await waitForValue('restarted supervisor finishes the original Stop', async () => {
        const current = (await rig.inventory()).find((row) => row.soulId === view.soulId)
        return current?.launchState === 'stopped' && current.cleanupState === 'verified_empty' ? current : null
      }, 60_000)
      expect(stopped).toMatchObject({ soulId: view.soulId, incarnationId: view.incarnationId,
        containerId: view.containerId, nativeSessionId: nativeId, desiredState: 'stopped',
        intentRevision: before.soul.intent_revision + 1 })
      expect((await rig.ownedContainerState(rig.runtimeEnclosureHandle(view))).running).toBe(false)
      ready = await harness.getLastReadyAt()
      const postStopRestartResponseStart = historyResponses.length
      await rig.restartWebGracefully()
      await harness.waitForConnectionAfter(ready, 90_000)
      await page.reload()
      await harness.waitForHarness()
      await harness.waitForConnection()
      await expect(pane).toBeVisible()
      const contentAfterRestart = (await harness.getPaneLayout(created.tabId)).content
      expect(contentAfterRestart).toMatchObject(canonical)
      const waitForPostStopHistoryResponse = () => waitForValue('read-only stopped history response', async () => {
        await Promise.all(historyResponseReads.slice(postStopRestartResponseStart))
        return historyResponses.slice(postStopRestartResponseStart).find((response) => response.route === 'managed'
          && response.status === 200 && response.threadId === nativeId
          && response.turnCount === retained.turns.length && response.canSend === false) ?? null
      }, 60_000)
      let historyResponseWaitFailure: string | undefined
      try {
        await waitForPostStopHistoryResponse()
      } catch (error) {
        historyResponseWaitFailure = error instanceof Error ? error.message : String(error)
      }
      await Promise.all(historyResponseReads.slice(postStopRestartResponseStart))
      const postStopHistoryResponses = historyResponses.slice(postStopRestartResponseStart)
      const readSnapshotRequests = async () => (await harness.getPerfAuditSnapshot())?.perfEvents
        .filter((event) => event.event === 'fresh_agent.snapshot_request')
        .slice(-12)
        .map(({ view, stage, reason, requestSerial, readGeneration, check, stale, fence, outcome, ran,
          providerMatches, typeMatches, threadMatches, historyOnly, requestReadOnly, hasSoul,
          createChanged, soulChanged, revisionChanged, bootChanged,
          ownerChanged, providerChanged, typeChanged, threadChanged, paneSessionChanged, recoveryChanged,
          live, vacant, rows, previousRows, accepted }) => ({
          view, stage, reason, requestSerial, readGeneration, check, stale, fence, outcome, ran,
          providerMatches, typeMatches, threadMatches, historyOnly, requestReadOnly, hasSoul,
          createChanged, soulChanged, revisionChanged, bootChanged,
          ownerChanged, providerChanged, typeChanged, threadChanged, paneSessionChanged, recoveryChanged,
          live, vacant, rows, previousRows, accepted,
        })) ?? []
      const snapshotRequests = await readSnapshotRequests()
      const contentFacts = {
        status: contentAfterRestart.status,
        hasSessionId: Boolean(contentAfterRestart.sessionId),
        hasSessionRef: Boolean(contentAfterRestart.sessionRef?.sessionId),
        pendingReconcile: contentAfterRestart.pendingReconcile,
        recovery: contentAfterRestart.recoverySummary ? {
          desiredState: contentAfterRestart.recoverySummary.desiredState,
          recoveryState: contentAfterRestart.recoverySummary.recoveryState,
        } : null,
      }
      expect(historyResponseWaitFailure,
        `the reloaded stopped pane must return saved read-only history; pane=${JSON.stringify(contentFacts)}; responses=${JSON.stringify(postStopHistoryResponses)}; snapshotRequests=${JSON.stringify(snapshotRequests)}`)
        .toBeUndefined()
      const afterHistory = await history()
      expect(afterHistory.threadId).toBe(nativeId)
      expect(afterHistory.turns).toEqual(retained.turns)
      expect(afterHistory.capabilities.send).toBe(false)
      let transcriptWaitFailure: string | undefined
      try {
        await expect(pane.getByText('Synthetic saved answer 2', { exact: true })).toBeVisible({ timeout: 60_000 })
      } catch (error) {
        transcriptWaitFailure = error instanceof Error ? error.message : String(error)
      }
      const finalSnapshotRequests = await readSnapshotRequests()
      expect(transcriptWaitFailure,
        `the retained stopped transcript response did not appear in the pane; responses=${JSON.stringify(postStopHistoryResponses)}; snapshotRequests=${JSON.stringify(finalSnapshotRequests)}`)
        .toBeUndefined()
      await expect(pane.getByRole('textbox', { name: 'Chat message input' })).toBeDisabled()
      const afterFacts = await rig.interruptedOrdinaryStopFacts(handle)
      const after = afterFacts.durable
      expect(after.soul).toEqual({ ...before.soul, desired_state: 'stopped', intent_revision: stopped.intentRevision })
      expect(after.incarnations).toEqual(before.incarnations.map((incarnation) => ({
        ...incarnation, launch_state: 'stopped', cleanup_state: 'verified_empty',
      })))
      expect(after.stops).toEqual([{ intent_revision: stopped.intentRevision,
        outcome: 'verified_empty', revoke_pending: 0, settled: 1 }])
      expect(after.tombstones).toBe(before.tombstones + 1)
      expect(after.writers).toBe(0)
      expect(after.effects).toEqual([])
      expect(afterFacts.workerLaunchCount).toBe(workerLaunchCount)
      expect((await rig.ownershipFacts()).receiptCount).toBe(receiptCount)
      expect(sent.slice(sentAtStop).filter((frame) => ['freshAgent.create', 'terminal.create'].includes(frame.type))).toEqual([])
      expect(sent.slice(sentAtStop).filter((frame) => ['freshAgent.send', 'freshAgent.recovery.stop'].includes(frame.type))).toEqual([])
      const lifecycle = afterFacts.lifecycle
      expect(lifecycle.filter((event) => event.event === 'supervisor.stop_committed').map((event) => event.data.intentRevision))
        .toEqual([stopped.intentRevision])
      expect(lifecycle.some((event) => event.event === 'supervisor.stop_continuation'
        && event.data.intentRevision === stopped.intentRevision)).toBe(true)
      await rig.publishInterruptedOrdinaryStopResult(handle, afterHistory.turns.length)
    } finally {
      const cleanup = await rig.stop()
      expect(cleanup.ok, cleanup.errors.join('\n')).toBe(true)
    }
  })

})
