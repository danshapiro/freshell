/**
 * Phase 4 browser gate: controller-first managed-runtime reconciliation and
 * authoritative view-intent rehydration.
 *
 * This uses real Chromium, a real feature-enabled Rust web server, the real
 * supervisor/session-host/Docker path, and three actual managed shell souls.
 * Shell souls avoid provider billing while still exercising the Phase 4
 * ownership, startup, view projection, merge, action, and compatibility
 * contracts end to end.
 */
import { expect, type Page } from '@playwright/test'
import WebSocket from 'ws'

import { test } from '../helpers/fixtures.js'
import { type ManagedFixtureRig, createManagedRuntimeBrowserRig, type FreshCodexHistoryMeasurementError, type FreshCodexHistoryMeasurementFinish, FreshCodexSavedHistoryMeasurementSchema, FreshCodexSavedHistoryPreservationSchema } from '../helpers/managed-runtime.js'
import { TestHarness } from '../helpers/test-harness.js'
import { runtimeBrowserPost as apiPost, pruneRuntimeBrowserLayout } from '../helpers/runtime-browser-api.js'
import { LAYOUT_WINDOW_ID_STORAGE_KEY } from '../../../src/store/storage-keys.js'
import { derivedLayoutKey } from '../../../src/store/window-layout-keys.js'
import { WS_PROTOCOL_VERSION } from '@shared/ws-version'

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

async function browserState(page: Page): Promise<any> {
  return new TestHarness(page).getState()
}

function visibleManagedTabs(state: any): any[] {
  return (state.tabs?.tabs ?? []).filter((tab: any) => typeof tab.viewIntentId === 'string')
}

function latestSoul(snapshot: any, soulId: string): any | undefined {
  return (snapshot.souls ?? []).filter((soul: any) => soul.soulId === soulId).at(-1)
}

async function prunePersistedLayoutToTab(page: Page, keepTabId: string): Promise<string> {
  const layoutWindowId = await page.evaluate(
    (key) => sessionStorage.getItem(key),
    LAYOUT_WINDOW_ID_STORAGE_KEY,
  )
  if (!layoutWindowId) throw new Error('browser has no layout-window id')
  const layoutStorageKey = derivedLayoutKey(layoutWindowId)
  const persisted = await waitForValue('canonical persisted browser layout', async () => {
    const raw = await page.evaluate((key) => localStorage.getItem(key), layoutStorageKey)
    if (!raw) return null
    const value = JSON.parse(raw)
    return value?.tabs?.tabs?.some((tab: any) => tab.id === keepTabId) && value?.panes?.layouts?.[keepTabId]
      ? value : null
  }, 15_000)
  const pruned = pruneRuntimeBrowserLayout(persisted, keepTabId)
  const marker = `freshell-runtime-pruned-layout-${keepTabId}`
  // The outgoing page's pagehide handler deliberately flushes live Redux state.
  // Install the isolated fixture mutation in the next top-level document before
  // application modules read storage, rather than racing that safety flush.
  await page.addInitScript(({ key, raw, marker }) => {
    if (window.top !== window || sessionStorage.getItem(marker) === 'installed') return
    localStorage.setItem(key, raw)
    sessionStorage.setItem(marker, 'installed')
  }, { key: layoutStorageKey, raw: JSON.stringify(pruned), marker })
  return layoutStorageKey
}

class RawWsClient {
  readonly socket: WebSocket
  private readonly messages: any[] = []
  private readonly waiters = new Set<() => void>()

  private constructor(socket: WebSocket) {
    this.socket = socket
    socket.on('message', (raw) => {
      try {
        this.messages.push(JSON.parse(raw.toString()))
      } catch {
        // Non-JSON frames are not part of the control protocol.
      }
      for (const wake of this.waiters) wake()
      this.waiters.clear()
    })
  }

  static async connect(baseUrl: string, token: string): Promise<RawWsClient> {
    const origin = baseUrl
    const url = `${baseUrl.replace(/^http/, 'ws')}/ws`
    const socket = new WebSocket(url, { headers: { Origin: origin } })
    const client = new RawWsClient(socket)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('raw compatibility socket open timed out')), 15_000)
      socket.once('open', () => {
        clearTimeout(timer)
        resolve()
      })
      socket.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
    })
    socket.send(JSON.stringify({
      type: 'hello',
      token,
      protocolVersion: WS_PROTOCOL_VERSION,
      clientId: `phase4-old-client-${Date.now()}`,
      capabilities: {
        terminalOutputBatchV1: true,
        paneReconcileV1: true,
        paneReconcileFreshAgentV1: true,
        // Deliberately no managedRuntimeV1: this is the mixed-version client.
      },
    }))
    await client.waitFor((message) => message.type === 'ready', 20_000, 'ready')
    return client
  }

  send(value: unknown): void {
    this.socket.send(JSON.stringify(value))
  }

  async waitFor(
    predicate: (message: any) => boolean,
    timeoutMs: number,
    description: string,
  ): Promise<any> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const index = this.messages.findIndex(predicate)
      if (index >= 0) return this.messages.splice(index, 1)[0]
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.waiters.delete(wake)
          resolve()
        }, Math.min(250, Math.max(1, deadline - Date.now())))
        const wake = () => {
          clearTimeout(timer)
          resolve()
        }
        this.waiters.add(wake)
      })
    }
    throw new Error(`timed out waiting for raw WS ${description}; messages=${JSON.stringify(this.messages)}`)
  }

  close(): void {
    this.socket.close()
  }
}

test.describe.serial('Phase 4 managed-runtime tab rehydration', () => {
  test('managed fresh-agent: already-live attach restores stale loss through real hosted HTTP truth', async ({ page }) => {
    test.setTimeout(900_000)
    const observerIntervalMs = 60_000
    const rig = createManagedRuntimeBrowserRig(process.cwd(), 3, {}, {
      FRESHELL_RUNTIME_HOST_COMMAND_TIMEOUT_MS: '5000', FRESHELL_RUNTIME_FRESH_AGENT_COMMAND_TIMEOUT_MS: '10000',
      // Exercise owned history before the supervisor's normal periodic recovery.
      FRESHELL_RUNTIME_OBSERVER_INTERVAL_MS: String(observerIntervalMs),
    }, 'test', {
      enabledProviders: [], freshAgentModes: ['freshcodex'], fixtureFreshAgentModes: ['freshcodex'],
      providerSettings: { freshcodex: {} },
    })
    const sent: any[] = []
    const received: any[] = []
    let heldHost: {containerId: string, incarnationId: string, pid: number} | undefined
    let heldHandle: ReturnType<ManagedFixtureRig['exactRuntimeHandle']> | undefined
    let historyEnclosure: ReturnType<ManagedFixtureRig['runtimeEnclosureHandle']> | undefined
    let cpuSession: Awaited<ReturnType<ReturnType<Page['context']>['newCDPSession']>> | undefined
    let profilingStarted = false
    let releaseHeldSnapshot: (() => void) | undefined
    const measurementErrors: FreshCodexHistoryMeasurementError[] = []
    const measurement: Record<string, unknown> = { kind: 'owned-page saved-history diagnostic', errors: measurementErrors }
    const measurementFinish: FreshCodexHistoryMeasurementFinish = { errors: measurementErrors }
    // Keep only asset names and route classes, never auth queries or native text.
    const scriptLabel = (url: string) => {
      if (!url) return 'native-or-anonymous'
      try {
        const parsed = new URL(url)
        return ['http:', 'https:'].includes(parsed.protocol) && parsed.pathname.startsWith('/assets/')
          ? parsed.pathname.split('/').at(-1) : 'document-or-other-script'
      } catch { return 'anonymous-script' }
    }
    try {
      const info = await rig.start()
      const settings = await fetch(`${info.baseUrl}/api/settings`, {
        method: 'PATCH', headers: { 'content-type': 'application/json', 'x-auth-token': info.token },
        body: JSON.stringify({ codingCli: { enabledProviders: ['codex'] } }),
      })
      expect(settings.ok).toBe(true)
      await page.routeWebSocket('**/ws', (socket) => {
        const upstream = socket.connectToServer()
        socket.onMessage((data) => { sent.push(JSON.parse(String(data))); upstream.send(data) })
        upstream.onMessage((data) => { received.push(JSON.parse(String(data))); socket.send(data) })
      })
      await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1&perfAudit=1`)
      const harness = new TestHarness(page)
      await harness.waitForHarness()
      await harness.waitForConnection()
      await page.getByRole('button', { name: 'Freshcodex', exact: true }).click()
      await page.getByRole('option', { name: rig.repoRoot, exact: true }).click()
      const created = await waitForValue('browser-created fresh pane', async () => {
        const state = await harness.getState()
        const tabId = state.tabs.activeTabId!
        const leaf = state.panes.layouts[tabId]
        return leaf?.type === 'leaf' && leaf.content.kind === 'fresh-agent' && leaf.content.sessionId
          ? { tabId, paneId: leaf.id, sessionId: leaf.content.sessionId } : null
      }, 60_000)
      const view = await waitForValue('real managed fresh Codex session', async () => (
        (await rig.inventory()).find((row) => row.freshAgentSessionType === 'freshcodex' && row.launchState === 'running') ?? null
      ), 90_000)
      expect(view.containerId).toBeTruthy()
      expect(view.nativeSessionId).toBeTruthy()
      historyEnclosure = rig.runtimeEnclosureHandle(view)
      const seededHistory = await rig.prepareFreshCodexSavedHistory(rig.exactRuntimeHandle(view))
      expect(seededHistory.bytes).toBeGreaterThan(1024 * 1024)
      const fixtureState = () => rig.fixtureNativeState(rig.exactRuntimeHandle(view))
      const before = (await fixtureState())
      const ownedSnapshot = await rig.freshCodexRetainedSnapshotFacts(rig.exactRuntimeHandle(view))
      expect(ownedSnapshot.threadId).toBe(view.nativeSessionId)
      expect(ownedSnapshot.bytes).toBeGreaterThan(1024 * 1024)
      expect(ownedSnapshot.turnCount).toBe(160)
      expect(ownedSnapshot.firstTurnId).toBe('retained-0:row-0')
      expect(ownedSnapshot.lastTurnId).toBe('retained-79:row-1')
      expect(ownedSnapshot.firstAnswerMatches).toBe(true)
      expect(ownedSnapshot.lastAnswerMatches).toBe(true)
      expect(ownedSnapshot.retentionAbsent).toBe(true)
      let retainedTurns: any[] | undefined
      const expectLargeRetainedHistory = (snapshot: any, additionalTurns = 0) => {
        expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeGreaterThan(1024 * 1024)
        // The native projection preserves each user/assistant row independently.
        expect(snapshot.turns).toHaveLength(160 + additionalTurns)
        if (retainedTurns) expect(snapshot.turns.slice(0, 160)).toEqual(retainedTurns)
        expect(snapshot.turns[0].turnId).toBe('retained-0:row-0')
        expect(snapshot.turns[159].turnId).toBe('retained-79:row-1')
        const first = snapshot.turns[1].items.find((item: any) => item.text?.startsWith('Managed retained answer 0'))
        const last = snapshot.turns[159].items.find((item: any) => item.text?.startsWith('Managed fixture saved answer'))
        expect(first.text).toBe(`Managed retained answer 0\n${'x'.repeat(20_000)}`)
        expect(last.text).toBe(`Managed fixture saved answer\n${'x'.repeat(20_000)}`)
        expect(snapshot.extensions.codex.nativeHistoryRetention).toBeUndefined()
      }
      const initialSnapshot = await fetch(`${info.baseUrl}/api/fresh-agent/threads/freshcodex/codex/${view.nativeSessionId}`, {
        headers: { 'x-auth-token': info.token },
      })
      expect(initialSnapshot.ok).toBe(true)
      const initialHistory = await initialSnapshot.json()
      expectLargeRetainedHistory(initialHistory)
      retainedTurns = initialHistory.turns
      await page.reload()
      await harness.waitForHarness()
      await harness.waitForConnection()
      const pane = page.locator(`[data-pane-id="${created.paneId}"]`)
      await expect(pane.getByText('Managed fixture saved answer', { exact: false })).toBeVisible({ timeout: 60_000 })
      const composer = pane.getByRole('textbox', { name: 'Chat message input' })
      await expect(composer).toBeEnabled()
      await expect.poll(async () => {
        const state = await harness.getState()
        return [view.freshAgentSessionId, view.nativeSessionId].includes(state.panes.layouts[created.tabId].content.sessionId)
      }).toBe(true)
      await composer.fill('Draft stays in this managed conversation')
      const original = await page.evaluate(({ tabId, paneId }) => {
        const root = window.__FRESHELL_TEST_HARNESS__!.getState().panes.layouts[tabId]
        const find = (node: any): any => node.type === 'leaf' ? node.id === paneId ? node.content : undefined
          : node.children.map(find).find(Boolean)
        return find(root)
      }, { tabId: created.tabId, paneId: created.paneId })
      expect(original.soulId).toBe(view.soulId)
      expect(original.sessionRef.sessionId).toBe(view.nativeSessionId)
      const canonicalIdentity = { sessionRef: original.sessionRef, resumeSessionId: original.resumeSessionId,
        createRequestId: original.createRequestId, soulId: original.soulId }
      const expectOriginalConversation = async () => {
        const state = await harness.getState()
        const content = state.panes.layouts[created.tabId].content
        expect(content).toMatchObject(canonicalIdentity)
        // The managed gateway and native materialization use these two
        // existing presentation aliases for the same canonical conversation.
        expect([view.freshAgentSessionId, view.nativeSessionId]).toContain(content.sessionId)
        const current = (await rig.inventory()).find((row) => row.soulId === view.soulId)
        expect(current).toMatchObject({ soulId: view.soulId, containerId: view.containerId,
          incarnationId: view.incarnationId, nativeSessionId: view.nativeSessionId })
      }
      expect(sent.some((frame) => frame.type === 'freshAgent.attach' && frame.sessionId === original.sessionId)).toBe(true)
      const held = new Promise<void>((resolve) => { releaseHeldSnapshot = resolve })
      let liveResponse: any
      await page.route('**/api/fresh-agent/threads/**', async (route) => {
        const actual = await route.fetch()
        liveResponse = await actual.json()
        await held
        await route.fulfill({ response: actual })
      })
      const baseline = sent.length
      await harness.receiveWsMessage({ type: 'freshAgent.event', provider: 'codex', sessionType: 'freshcodex',
        sessionId: original.sessionId, event: { type: 'freshAgent.error', code: 'INVALID_SESSION_ID', message: 'Stale managed lookup' } })
      await expect(composer).toBeDisabled()
      await expect(composer).toHaveValue('Draft stays in this managed conversation')
      await expect.poll(() => liveResponse?.extensions?.codex?.statusFromLiveState).toBe(true)
      expect(liveResponse.threadId).toBe(view.nativeSessionId)
      expect(liveResponse.capabilities.send).toBe(true)
      expectLargeRetainedHistory(liveResponse)
      const afterLoss = sent.slice(baseline)
      expect(afterLoss.filter((frame) => frame.type === 'freshAgent.create' || frame.type === 'pane.reconcile.request')).toHaveLength(0)
      expect(received.filter((frame) => frame.type === 'freshAgent.event' && frame.sessionId === original.sessionId
        && frame.event?.type === 'freshAgent.session.snapshot')).toHaveLength(0)
      await expect(pane.getByText('Managed fixture saved answer', { exact: false })).toBeVisible()
      await expect(page.getByTestId('managed-runtime-recovery-card')).toHaveCount(0)
      await expect(pane.getByRole('button', { name: 'Start new session' })).toHaveCount(0)
      await expectOriginalConversation()
      expect((await fixtureState()).dispatchCount).toBe(before.dispatchCount)
      releaseHeldSnapshot!()
      await expect(composer).toBeEnabled()
      await expect(composer).toHaveValue('Draft stays in this managed conversation')
      const sentTurnBaseline = received.length
      await composer.press('Enter')
      await expect.poll(async () => (await fixtureState()).completionCount, { timeout: 30_000 }).toBe(before.completionCount + 1)
      await waitForValue('completed native fixture turn', () => received.slice(sentTurnBaseline).find(frame => {
        const event = frame.type === 'freshAgent.event' ? frame.event : frame
        return event?.type === 'freshAgent.turn.complete' && frame.sessionId === view.nativeSessionId
      }), 30_000)
      expect((await fixtureState()).dispatchCount).toBe(before.dispatchCount + 1)
      expect((await fixtureState()).nativeSessionId).toBe(view.nativeSessionId)
      const current = (await rig.inventory()).find((row) => row.soulId === view.soulId)
      expect(current).toMatchObject({ soulId: view.soulId, containerId: view.containerId,
        incarnationId: view.incarnationId, nativeSessionId: view.nativeSessionId })
      await expectOriginalConversation()
      expect(sent.slice(baseline).filter((frame) => frame.type === 'freshAgent.create' || frame.type === 'pane.reconcile.request')).toHaveLength(0)
      expect(await rig.freshCodexSavedHistoryUnchanged(rig.exactRuntimeHandle(view))).toBe(true)
      const stableProviderState = (await fixtureState())
      // A tracked host can stop answering while its managed projection still says live.
      // Its saved source is the owned provider volume, never a coincident web-local file.
      // A send can start another snapshot while the fixture counters settle.
      // Drain its real fetch/fulfill before removal continues in-flight routes.
      await page.unrouteAll({ behavior: 'wait' })
      await rig.prepareCoincidentFreshCodexHistory(rig.exactRuntimeHandle(view))
      // Finish healthy preparation before starting this owned controller's
      // first observation window. Its startup must reattach the original host.
      const oldControllerId = (await rig.ownershipFacts()).supervisorContainerId
      const oldControlEpoch = await rig.controlEpoch()
      const controllerSentBaseline = sent.length
      const controllerRestartStartedAt = Date.now()
      await rig.restartSupervisor()
      const { controllerHealth, startupFinished, controllerReady } = await rig.freshCodexControllerStartupFacts(rig.exactRuntimeHandle(view))
      const reattached = (await rig.inventory()).find((row) => row.soulId === view.soulId)
      if (!reattached) throw new Error('original managed soul was not reattached by its controller')
      expect(reattached).toMatchObject({ soulId: view.soulId, containerId: view.containerId,
        incarnationId: view.incarnationId, nativeSessionId: view.nativeSessionId,
        desiredState: 'running', launchState: 'running', recoveryState: 'live' })
      expect((await fixtureState())).toMatchObject({ nativeSessionId: stableProviderState.nativeSessionId,
        dispatchCount: stableProviderState.dispatchCount, completionCount: stableProviderState.completionCount })
      expect(await rig.freshCodexSavedHistoryUnchanged(rig.exactRuntimeHandle(view))).toBe(true)
      expect(await rig.coincidentFreshCodexHistoryUnchanged(rig.exactRuntimeHandle(view))).toBe(true)
      await expectOriginalConversation()
      expect(sent.slice(controllerSentBaseline).filter((frame) => frame.type === 'freshAgent.create'
        || frame.type === 'pane.reconcile.request')).toHaveLength(0)
      expect(Number.isFinite(startupFinished?.at)).toBe(true)
      expect(Number.isFinite(controllerReady?.at)).toBe(true)
      expect(startupFinished.at).toBeGreaterThanOrEqual(controllerRestartStartedAt)
      expect(controllerReady.at).toBeGreaterThanOrEqual(startupFinished.at)
      expect(startupFinished.data).toMatchObject({ scanned: 1, blockedSubsystems: [] })
      expect(controllerReady.data).toMatchObject({ controlEpoch: controllerHealth.control_epoch,
        installationId: controllerHealth.installation_id })
      expect(controllerReady.data.controlEpoch).toBeGreaterThan(oldControlEpoch)
      expect((await rig.ownershipFacts()).supervisorContainerId).not.toBe(oldControllerId)
      const controllerReattachment = { oldControllerId, currentControllerId: (await rig.ownershipFacts()).supervisorContainerId,
        oldControlEpoch, currentControlEpoch: controllerReady.data.controlEpoch, controllerRestartStartedAt,
        controllerReady, startupFinished, reattached, completedAt: Date.now() }
      await rig.recordFreshCodexControllerReattachment(rig.exactRuntimeHandle(view), controllerReattachment)
      // The observer sleeps first, after startup reconciliation finishes.
      const firstObservationNotBefore = startupFinished.at + observerIntervalMs
      const holdRequestedAt = Date.now()
      expect(firstObservationNotBefore - holdRequestedAt,
        'owned history/read/reload must have a measured window before STOP').toBeGreaterThanOrEqual(55_000)
      heldHandle = rig.exactRuntimeHandle(view)
      const { pid } = await rig.holdRuntimeHost(heldHandle)
      heldHost = { containerId: view.containerId!, incarnationId: view.incarnationId, pid }
      await expect.poll(async () => {
        const state = await rig.ownedRuntimeHostState(rig.runtimeEnclosureHandle(view))
        expect(state.pid).toBe(pid)
        return state.stopped
      }).toBe(true)
      const heldAt = Date.now()
      const unavailableBaseline = sent.length
      const unavailable = await fetch(`${info.baseUrl}/api/fresh-agent/threads/freshcodex/codex/${view.nativeSessionId}`, {
        headers: { 'x-auth-token': info.token },
      })
      expect(unavailable.status).toBe(200)
      const history = await unavailable.json()
      expect(history.threadId).toBe(view.nativeSessionId)
      expect(history.extensions.codex.nativeHistoryAvailable).toBe(true)
      expect(history.extensions.codex.ownerKind).toBe('vacant')
      expect(history.extensions.codex.statusFromLiveState).not.toBe(true)
      expect(history.capabilities.send).toBe(false)
      expectLargeRetainedHistory(history, 2)
      expect(history.turns.slice(160).map((turn: any) => turn.role)).toEqual(['user', 'assistant'])
      expect(history.turns[161].items).toContainEqual(expect.objectContaining({ text: 'deterministic fixture completion' }))
      expect(JSON.stringify(history)).not.toContain('Wrong web-local answer')
      expect(sent.slice(unavailableBaseline).filter((frame) => frame.type === 'freshAgent.create' || frame.type === 'pane.reconcile.request')).toHaveLength(0)
      expect((await fixtureState())).toMatchObject({ nativeSessionId: stableProviderState.nativeSessionId,
        dispatchCount: stableProviderState.dispatchCount, completionCount: stableProviderState.completionCount })
      const reloadSentBaseline = sent.length
      const reloadReceivedBaseline = received.length
      cpuSession = await page.context().newCDPSession(page)
      await cpuSession.send('Profiler.enable')
      const browserBeforeReload = await page.evaluate(() => ({ timeOrigin: performance.timeOrigin, now: performance.now() }))
      measurement.browserBeforeReload = browserBeforeReload
      const cpuStartRequestedAt = Date.now()
      measurement.cpuStartRequestedAt = cpuStartRequestedAt
      measurementFinish.cpuStartRequestedAt = cpuStartRequestedAt
      await cpuSession.send('Profiler.start')
      profilingStarted = true
      const cpuStartedAt = Date.now()
      measurement.cpuStartedAt = cpuStartedAt
      measurementFinish.cpuStartedAt = cpuStartedAt
      await rig.startFreshCodexSavedHistoryMeasurement(rig.exactRuntimeHandle(view), {
        kind: 'owned-page saved-history diagnostic', errors: measurementErrors, browserBeforeReload, cpuStartRequestedAt, cpuStartedAt,
      })
      await page.reload()
      await harness.waitForHarness()
      await harness.waitForConnection()
      const reloadReady = await waitForValue('reloaded managed connection ready', () => received.slice(reloadReceivedBaseline)
        .find((frame) => frame.type === 'ready'), 30_000)
      expect(reloadReady.capabilities.managedRuntimeV1).toBe(true)
      const reloadLifecycle = () => sent.slice(reloadSentBaseline)
        .filter((frame) => frame.type === 'freshAgent.create' || frame.type === 'pane.reconcile.request')
      const expectManagedReload = () => {
        const frames = reloadLifecycle()
        expect(frames.filter((frame) => frame.type === 'pane.reconcile.request')).toHaveLength(0)
        const creates = frames.filter((frame) => frame.type === 'freshAgent.create')
        expect(creates.length).toBeLessThanOrEqual(1)
        for (const frame of creates) {
          // The create protocol also rebinds an existing native reference;
          // it must reuse this exact request and cannot allocate a new soul.
          expect(frame).toMatchObject({ requestId: original.createRequestId, tabId: created.tabId, paneId: created.paneId,
            provider: 'codex', sessionType: 'freshcodex', sessionRef: original.sessionRef })
        }
      }
      expectManagedReload()
      await expect(pane.getByText('Managed fixture saved answer', { exact: false })).toBeVisible({ timeout: 60_000 })
      await expect(pane.getByText('deterministic fixture completion', { exact: true })).toBeVisible()
      await expect(composer).toBeDisabled()
      await expect(pane.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0)
      await expect(pane.getByText('Wrong web-local answer', { exact: false })).toHaveCount(0)
      await expectOriginalConversation()
      expect((await fixtureState())).toMatchObject({ nativeSessionId: stableProviderState.nativeSessionId,
        dispatchCount: stableProviderState.dispatchCount, completionCount: stableProviderState.completionCount })
      expect(await rig.freshCodexSavedHistoryUnchanged(rig.exactRuntimeHandle(view))).toBe(true)
      expect(await rig.coincidentFreshCodexHistoryUnchanged(rig.exactRuntimeHandle(view))).toBe(true)
      const ownership = await rig.freshCodexSavedHistoryOwnershipFacts(rig.exactRuntimeHandle(view))
      expect(ownership.receiptContainerIds).toHaveLength(1)
      expect(ownership.receiptContainerIds[0]).toBe(view.containerId)
      expect(ownership.startCount).toBe(1)
      const launches = ownership.launches
      expect(launches).toHaveLength(1)
      expect(launches[0].data).toMatchObject({ incarnationId: view.incarnationId, containerId: view.containerId, workerLaunchCount: 1 })
      expectManagedReload()
      const settledReloadLifecycle = reloadLifecycle()
      if (settledReloadLifecycle.some((frame) => frame.type === 'freshAgent.create')) {
        const rebound = await waitForValue('existing managed bootstrap create acknowledgement', () => received.slice(reloadReceivedBaseline)
          .find((frame) => frame.type === 'freshAgent.created' && frame.requestId === original.createRequestId), 30_000)
        expect(rebound).toMatchObject({ sessionId: view.nativeSessionId, sessionRef: original.sessionRef })
      }
      const historyEvidence = { source: 'owned provider-volume native history',
        wrongSource: 'coincident web-local native history', heldHost,
        bootstrap: settledReloadLifecycle.find((frame) => frame.type === 'pane.reconcile.request') ?? null,
        bootstrapCreates: settledReloadLifecycle.filter((frame) => frame.type === 'freshAgent.create'),
        nativeSessionId: view.nativeSessionId, beforeHistory: stableProviderState, afterReload: (await fixtureState()),
        originalIdentity: canonicalIdentity, managedLaunch: launches[0], bothSourcesUnchanged: true }
      await rig.releaseRuntimeHost(rig.exactRuntimeHandle(view))
      const releasedAt = Date.now()
      heldHost = undefined
      await expect.poll(async () => {
        const state = await rig.ownedRuntimeHostState(rig.runtimeEnclosureHandle(view))
        expect(state.pid).toBe(pid)
        return state.stopped
      }).toBe(false)
      const resumedAt = Date.now()
      expect(resumedAt, 'exact owned host must resume before the first observer pass').toBeLessThan(firstObservationNotBefore)
      await expectOriginalConversation()
      expect((await fixtureState())).toMatchObject({ nativeSessionId: stableProviderState.nativeSessionId,
        dispatchCount: stableProviderState.dispatchCount, completionCount: stableProviderState.completionCount })
      expectManagedReload()
      expect(reloadLifecycle()).toHaveLength(settledReloadLifecycle.length)
      const { targetSoulRecoveries } = await rig.freshCodexSavedHistoryOwnershipFacts(rig.exactRuntimeHandle(view))
      expect(targetSoulRecoveries).toHaveLength(0)
      await rig.publishFreshCodexSavedHistoryPreservation(rig.exactRuntimeHandle(view), FreshCodexSavedHistoryPreservationSchema.parse({ ...historyEvidence,
        observerWindow: { intervalMs: observerIntervalMs, controllerReattachment, startupFinished, firstObservationNotBefore,
          holdRequestedAt, heldAt, releasedAt, resumedAt, targetSoulRecoveries } }))
    } finally {
      measurement.finallyEnteredAt = Date.now()
      try {
        try {
          releaseHeldSnapshot?.()
          await page.unrouteAll({ behavior: 'wait' })
        } finally {
          if (heldHost && heldHandle) await rig.releaseRuntimeHost(heldHandle)
        }
      } finally {
        try {
          // Resume the exact owned host before diagnostic extraction on failure.
          if (cpuSession) {
            try {
              if (profilingStarted) {
                const cpuStopRequestedAt = Date.now()
                measurement.cpuStopRequestedAt = cpuStopRequestedAt
                measurementFinish.cpuStopRequestedAt = cpuStopRequestedAt
                const { profile } = await cpuSession.send('Profiler.stop')
                const cpuStoppedAt = Date.now()
                measurement.cpuStoppedAt = cpuStoppedAt
                measurementFinish.cpuStoppedAt = cpuStoppedAt
                const nodes = new Map<number, any>(profile.nodes.map((node: any) => [node.id, node]))
                const parents = new Map<number, number>()
                for (const node of profile.nodes) for (const child of node.children ?? []) parents.set(child, node.id)
                const describeFrame = (id: number) => {
                  const frame = nodes.get(id)?.callFrame
                  return { functionName: String(frame?.functionName ?? '').replace(/[^\w .()<>:$-]/g, '').slice(0, 120),
                    script: scriptLabel(frame?.url ?? ''), line: frame?.lineNumber, column: frame?.columnNumber }
                }
                const totals = new Map<number, { samples: number, durationMs: number }>()
                const seconds = new Map<number, { durationMs: number, samples: number, idleMs: number }>()
                let elapsedUs = 0
                const samples = profile.samples ?? []
                for (let index = 0; index < samples.length; index += 1) {
                  const id = samples[index]
                  const durationMs = (profile.timeDeltas?.[index] ?? 0) / 1000
                  const total = totals.get(id) ?? { samples: 0, durationMs: 0 }
                  total.samples += 1
                  total.durationMs += durationMs
                  totals.set(id, total)
                  const second = Math.floor(elapsedUs / 1_000_000)
                  const bucket = seconds.get(second) ?? { durationMs: 0, samples: 0, idleMs: 0 }
                  bucket.durationMs += durationMs
                  bucket.samples += 1
                  if (nodes.get(id)?.callFrame.functionName === '(idle)') bucket.idleMs += durationMs
                  seconds.set(second, bucket)
                  elapsedUs += durationMs * 1000
                }
                measurement.cpu = { startTimeUs: profile.startTime, endTimeUs: profile.endTime,
                  sampledDurationMs: elapsedUs / 1000, sampleCount: profile.samples?.length ?? 0,
                  // Sampling attributes each delta to its leaf, not exact function wall time.
                  topLeaves: [...totals.entries()].sort((a, b) => b[1].durationMs - a[1].durationMs).slice(0, 80)
                    .map(([id, total]) => {
                      const stack = []
                      let parent = parents.get(id)
                      while (parent !== undefined && stack.length < 20) {
                        stack.push(describeFrame(parent))
                        parent = parents.get(parent)
                      }
                      return { ...total, ...describeFrame(id), stack }
                    }),
                  seconds: [...seconds.entries()].map(([second, bucket]) => ({ second, ...bucket })) }
              }
            } catch { measurementErrors.push('owned CPU profile stop/extraction failed') }
            finally {
              try { await cpuSession.send('Profiler.disable') } catch { measurementErrors.push('owned CPU profiler disable failed') }
              try { await cpuSession.detach() } catch { measurementErrors.push('owned CDP detach failed') }
            }
          }
          try {
            // Sanitize inside the owned page before returning audit data to Node.
            measurement.audit = await page.evaluate((cutoffWallMs) => {
              const snapshot = window.__FRESHELL_TEST_HARNESS__?.getPerfAuditSnapshot()
              const routeClass = (raw: unknown) => {
                if (typeof raw !== 'string') return undefined
                let pathname: string
                try { pathname = new URL(raw, location.origin).pathname } catch { return 'unknown-route' }
                if (pathname.startsWith('/api/fresh-agent/threads/')) return 'native-thread-snapshot'
                if (/^\/api\/runtime\/souls\/[^/]+\/history$/.test(pathname)) return 'owned-soul-history'
                if (pathname.startsWith('/assets/')) return `asset:${pathname.split('/').at(-1)}`
                return pathname.startsWith('/api/') ? 'other-api' : 'document-or-resource'
              }
              const requestRecords = (snapshot?.perfEvents ?? []).filter((entry) => entry.event === 'fresh_agent.snapshot_request')
              const stages = ['refresh_requested', 'effect_skipped', 'request_captured', 'request_queued', 'run_started',
                'native_started', 'native_completed', 'native_failed', 'soul_started', 'outcome_received',
                'currentness_checked', 'identity_rejected', 'display_committed']
              const triggers = ['identity', 'event', 'send-accepted', 'materialized', 'manual', 'poll', 'reconnect', 'reveal', 'idle-incomplete']
              const allowed = { stage: stages, trigger: triggers, reason: ['no_thread', 'divergence', 'unmanaged_lost'],
                check: ['native-error', 'before-soul', 'outcome', 'error-fold'], source: ['direct', 'fallback'],
                fence: ['create', 'soul', 'revision', 'boot', 'owner', 'applied_serial', 'read_generation', 'recovery',
                  'provider', 'session_type', 'thread', 'divergence'], errorKind: ['abort', 'error'],
                outcome: ['ok', 'error', 'coalesced', 'rate-limited', 'backoff'] }
              const numericFields = ['timestamp', 'view', 'requestSerial', 'readGeneration', 'refreshSerial', 'appliedSerial',
                'currentGeneration', 'previousRows', 'rows', 'revision']
              const booleanFields = ['requestReadOnly', 'hasSoul', 'ran', 'stale', 'historyOnly', 'live', 'vacant', 'accepted',
                'providerMatches', 'typeMatches', 'threadMatches', 'initialCapture', 'createChanged', 'soulChanged',
                'revisionChanged', 'bootChanged', 'ownerChanged', 'providerChanged', 'typeChanged', 'threadChanged',
                'paneSessionChanged', 'recoveryChanged', 'lostChanged', 'supervisorChanged', 'refreshChanged']
              return { timeOrigin: performance.timeOrigin, extractedAtMs: performance.now(), available: Boolean(snapshot),
                cutoffWallMs, requestRecordCount: requestRecords.length, requestRecordsReturned: Math.min(2000, requestRecords.length),
                requestRecordsDropped: Math.max(0, requestRecords.length - 2000),
                requestRecords: requestRecords.slice(0, 2000).map((entry, sequence) => ({ sequence,
                  ...Object.fromEntries(Object.entries(allowed).filter(([key, values]) => values.includes(String(entry[key])))
                    .map(([key]) => [key, entry[key]])),
                  ...Object.fromEntries(numericFields.filter((key) => typeof entry[key] === 'number' && Number.isFinite(entry[key]))
                    .map((key) => [key, entry[key]])),
                  ...Object.fromEntries(booleanFields.filter((key) => typeof entry[key] === 'boolean').map((key) => [key, entry[key]])) })),
                // The existing sink has no event timestamp: retain sequence and measured durations only.
                events: (snapshot?.perfEvents ?? []).flatMap((entry, sequence) => {
                  if (!['perf.api_slow', 'perf.api_parse_slow', 'perf.longtask', 'perf.resource_slow'].includes(String(entry.event))) return []
                  const numeric = Object.fromEntries(['status', 'durationMs', 'ttfbMs', 'bodyMs', 'parseMs', 'payloadChars',
                    'startTime', 'transferSize', 'encodedBodySize', 'decodedBodySize']
                    .filter((key) => typeof entry[key] === 'number').map((key) => [key, entry[key]]))
                  return [{ sequence, event: entry.event, route: routeClass(entry.path ?? entry.name), ...numeric }]
                }) }
            }, Number(measurement.finallyEnteredAt))
          } catch { measurementErrors.push('owned perf audit extraction failed') }
          if (historyEnclosure) {
            await rig.publishFreshCodexSavedHistoryMeasurement(historyEnclosure, FreshCodexSavedHistoryMeasurementSchema.parse(measurement))
            await rig.finishFreshCodexSavedHistoryMeasurement(historyEnclosure, measurementFinish)
          }
        } finally {
          const cleanup = await rig.stop()
          expect(cleanup.ok, cleanup.errors.join('\n')).toBe(true)
        }
      }
    }
  })

  test('P4-G08: controller inventory reconstructs views without duplicating souls', async ({ page }) => {
    test.setTimeout(900_000)

    const rig = createManagedRuntimeBrowserRig(process.cwd(), 4)
    let oldClient: RawWsClient | undefined
    try {
      const info = await rig.start()
      await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
      const harness = new TestHarness(page)
      await harness.waitForHarness()
      await harness.waitForConnection()
      const emptyStartup = await browserState(page)
      const startupTabCount = emptyStartup.tabs.tabs.length
      expect(visibleManagedTabs(emptyStartup)).toHaveLength(0)
      expect((await rig.inventorySnapshot()).souls).toHaveLength(0)

      const browser = await apiPost<any>(page, info.token, '/api/tabs', {
        browser: 'about:blank',
        name: 'Existing saved layout',
      })
      expect(browser.tabId).toEqual(expect.any(String))
      expect(browser.paneId).toEqual(expect.any(String))
      const browserTabId: string = browser.tabId
      await expect.poll(() => harness.getTabCount(), { timeout: 30_000 }).toBe(startupTabCount + 1)

      const created: any[] = []
      for (let index = 1; index <= 3; index += 1) {
        const response = await apiPost<any>(page, info.token, '/api/tabs', {
          mode: 'shell',
          name: `Managed shell ${index}`,
          cwd: rig.repoRoot,
        })
        expect(response.tabId).toEqual(expect.any(String))
        expect(response.paneId).toEqual(expect.any(String))
        created.push(response)
      }
      await expect.poll(() => harness.getTabCount(), { timeout: 60_000 }).toBe(startupTabCount + 4)

      const initialSnapshot = await waitForValue('three managed souls and views', async () => {
        const snapshot = await rig.inventorySnapshot()
        const running = snapshot.souls.filter((soul: any) => soul.launchState === 'running')
        const visible = snapshot.viewIntents.filter((view: any) => view.visibility === 'visible')
        return running.length === 3 && visible.length === 3 ? snapshot : null
      }, 90_000)
      expect(initialSnapshot.readiness.initialScanState).toBe('complete')
      const initialSoulIds = initialSnapshot.souls
        .filter((soul: any) => soul.launchState === 'running')
        .map((soul: any) => soul.soulId)
        .sort()
      const initialRuntimeIdentity = new Map(
        initialSnapshot.souls
          .filter((soul: any) => soul.launchState === 'running')
          .map((soul: any) => [soul.soulId, {
            terminalId: soul.terminalId,
            incarnationId: soul.incarnationId,
            containerId: soul.containerId,
          }]),
      )
      const expectedTabIds = initialSnapshot.viewIntents
        .map((view: any) => view.preferredTabId)
        .sort()
      const expectedPaneIds = initialSnapshot.viewIntents
        .map((view: any) => view.preferredPaneId)
        .sort()

      // Set the saved-layout focus as fixture state. All subsequent restoration,
      // close-view and stop-agent checks still run through the live browser.
      await page.evaluate((tabId) => {
        const testHarness = window.__FRESHELL_TEST_HARNESS__
        if (!testHarness) throw new Error('Freshell test harness is unavailable')
        testHarness.dispatch({ type: 'tabs/setActiveTab', payload: tabId })
      }, browserTabId)
      await expect.poll(() => harness.getActiveTabId()).toBe(browserTabId)
      const activePaneBefore = (await browserState(page)).panes.activePane[browserTabId]
      expect(activePaneBefore).toEqual(expect.any(String))
      const layoutStorageKey = await prunePersistedLayoutToTab(page, browserTabId)
      expect(layoutStorageKey.length).toBeGreaterThan(0)

      await page.reload()
      await harness.waitForHarness()
      await harness.waitForConnection()
      const rehydrated = await waitForValue('authoritative managed view rehydration', async () => {
        const state = await browserState(page)
        const tabs = visibleManagedTabs(state)
        return tabs.length === 3 && state.managedRuntime?.status === 'ready' ? state : null
      }, 90_000)
      expect(rehydrated.tabs.tabs.map((tab: any) => tab.id).sort()).toEqual(
        [browserTabId, ...expectedTabIds].sort(),
      )
      expect(rehydrated.tabs.activeTabId).toBe(browserTabId)
      expect(rehydrated.panes.activePane[browserTabId]).toBe(activePaneBefore)
      const focusObservations = [{
        stage: 'rehydration',
        activeTabId: rehydrated.tabs.activeTabId,
        activePaneId: rehydrated.panes.activePane[rehydrated.tabs.activeTabId] ?? null,
      }]
      expect(visibleManagedTabs(rehydrated).map((tab: any) => tab.viewIntentId).sort()).toEqual(
        initialSnapshot.viewIntents.map((view: any) => view.viewId).sort(),
      )
      expect(visibleManagedTabs(rehydrated).map((tab: any) => tab.soulId).sort()).toEqual(initialSoulIds)
      const recoveredPaneIds = expectedTabIds.map((tabId: string) => {
        const node = rehydrated.panes.layouts[tabId]
        return node?.type === 'leaf' ? node.id : undefined
      }).sort()
      expect(recoveredPaneIds).toEqual(expectedPaneIds)

      for (let cycle = 1; cycle <= 3; cycle += 1) {
        const priorReadyAt = await harness.getLastReadyAt()
        if (cycle % 2 === 1) await rig.crashAndRestartWeb()
        else await rig.restartWebGracefully()
        await harness.waitForConnectionAfter(priorReadyAt, 90_000)
        const state = await waitForValue(`stable tabs after web restart ${cycle}`, async () => {
          const current = await browserState(page)
          return visibleManagedTabs(current).length === 3
            && current.managedRuntime?.status === 'ready'
            ? current
            : null
        }, 90_000)
        expect(state.tabs.tabs.map((tab: any) => tab.id).sort()).toEqual(
          [browserTabId, ...expectedTabIds].sort(),
        )
        expect(state.tabs.activeTabId).toBe(browserTabId)
        expect(state.panes.activePane[browserTabId]).toBe(activePaneBefore)
        focusObservations.push({
          stage: `web_restart_${cycle}`,
          activeTabId: state.tabs.activeTabId,
          activePaneId: state.panes.activePane[state.tabs.activeTabId] ?? null,
        })
        expect(new Set(visibleManagedTabs(state).map((tab: any) => tab.viewIntentId)).size).toBe(3)
        expect(visibleManagedTabs(state).map((tab: any) => tab.soulId).sort()).toEqual(initialSoulIds)
      }

      const afterRestarts = await rig.inventorySnapshot()
      for (const soulId of initialSoulIds) {
        const before = initialRuntimeIdentity.get(soulId) as any
        const after = latestSoul(afterRestarts, soulId)
        expect(after?.incarnationId).toBe(before.incarnationId)
        expect(after?.containerId).toBe(before.containerId)
        expect(after?.terminalId).toBe(before.terminalId)
      }

      const closeSoulId = initialSoulIds[0]
      const stateBeforeClose = await browserState(page)
      const closeTabId = stateBeforeClose.tabs.tabs.find((tab: any) => tab.soulId === closeSoulId)?.id
      const closePaneId = expectedTabIds
        .map((tabId: string) => stateBeforeClose.panes.layouts[tabId])
        .find((node: any) => node?.type === 'leaf' && node.content?.soulId === closeSoulId)?.id
      expect(closeTabId).toEqual(expect.any(String))
      expect(closePaneId).toEqual(expect.any(String))
      // Ordinary pane close is the durable view intent action. It detaches the
      // managed view after close evidence succeeds; it never stops the soul.
      await page.locator(`[data-context="tab"][data-tab-id="${closeTabId}"]`).click()
      await page.locator(`[data-pane-id="${closePaneId}"] button[title="Close pane"]`).click()
      const closeOutcome = await waitForValue('detached view with live soul', async () => {
        const snapshot = await rig.inventorySnapshot()
        const view = snapshot.viewIntents.find((candidate: any) => candidate.soulId === closeSoulId)
        const soul = latestSoul(snapshot, closeSoulId)
        return view?.visibility === 'detached' && soul?.launchState === 'running'
          ? { snapshot, view, soul }
          : null
      }, 60_000)
      expect(closeOutcome.soul.desiredState).toBe('running')
      await expect.poll(async () => visibleManagedTabs(await browserState(page)).length, {
        timeout: 30_000,
      }).toBe(2)

      // Reconnect the browser to force the normal inventory refresh path. A
      // detached view must remain absent after reconciliation; the live soul
      // is intentionally not recreated as a replacement conversation.
      const priorReadyAt = await harness.getLastReadyAt()
      await rig.restartWebGracefully()
      await harness.waitForConnectionAfter(priorReadyAt, 90_000)
      await expect.poll(async () => visibleManagedTabs(await browserState(page)).length, {
        timeout: 30_000,
      }).toBe(2)
      const afterCloseRefresh = await browserState(page)
      expect(afterCloseRefresh.tabs.tabs.some((tab: any) => tab.soulId === closeSoulId)).toBe(false)

      const stopSoulId = initialSoulIds[1]
      const stopTabId = afterCloseRefresh.tabs.tabs.find((tab: any) => tab.soulId === stopSoulId)?.id
      expect(stopTabId).toEqual(expect.any(String))
      // Retain stop coverage through the existing terminal shift-close path.
      await page.locator(`[data-context="tab"][data-tab-id="${stopTabId}"]`)
        .getByRole('button', { name: /close/i })
        .click({ modifiers: ['Shift'] })
      const stopOutcome = await waitForValue('explicitly stopped soul', async () => {
        const snapshot = await rig.inventorySnapshot()
        const soul = latestSoul(snapshot, stopSoulId)
        return soul?.desiredState === 'stopped' && soul?.launchState === 'stopped'
          ? { snapshot, soul }
          : null
      }, 90_000)
      expect(stopOutcome.soul.cleanupState).toBe('verified_empty')

      const compatibilitySoulId = initialSoulIds[2]
      const compatibilitySoul = latestSoul(await rig.inventorySnapshot(), compatibilitySoulId)
      if (!compatibilitySoul?.terminalCreateRequestId || !compatibilitySoul?.terminalId) {
        throw new Error('compatibility soul lacks durable terminal/create identity')
      }
      const receiptCountBefore = (await rig.ownershipFacts()).receiptCount
      oldClient = await RawWsClient.connect(info.baseUrl, info.token)
      oldClient.send({
        type: 'terminal.create',
        requestId: compatibilitySoul.terminalCreateRequestId,
        shell: 'system',
        mode: compatibilitySoul.terminalMode || 'shell',
        cwd: compatibilitySoul.terminalCwd || rig.repoRoot,
        tabId: 'old-client-tab',
        paneId: 'old-client-pane',
        restore: true,
      })
      const createdReply = await oldClient.waitFor(
        (message) => message.type === 'terminal.created'
          && message.requestId === compatibilitySoul.terminalCreateRequestId,
        30_000,
        'compatibility terminal.created',
      )
      expect(createdReply.terminalId).toBe(compatibilitySoul.terminalId)
      expect((await rig.ownershipFacts()).receiptCount).toBe(receiptCountBefore)
      expect(latestSoul(await rig.inventorySnapshot(), compatibilitySoulId)?.launchState).toBe('running')

      const finalState = await browserState(page)
      const receipt = {
        schemaVersion: 1,
        status: 'PASS',
        browser: {
          browserInteraction: true,
          coldStartAgents: initialSoulIds.length,
          restartCycles: focusObservations.length - 1,
          deterministicPlacement: recoveredPaneIds.join('|') === expectedPaneIds.join('|'),
          singleViewPerIntent: new Set(
            finalState.tabs.tabs
              .map((tab: any) => tab.viewIntentId)
              .filter(Boolean),
          ).size === finalState.tabs.tabs.filter((tab: any) => tab.viewIntentId).length,
          existingLayoutPreserved: Boolean(finalState.tabs.tabs.find((tab: any) => tab.id === browserTabId)),
          // Only automatic restore/restart observations belong to this
          // guarantee; the close/stop interactions deliberately move focus.
          focusStable: focusObservations.every((observed) => (
            observed.activeTabId === browserTabId && observed.activePaneId === activePaneBefore
          )),
          expectedFocus: { activeTabId: browserTabId, activePaneId: activePaneBefore },
          focusObservations,
          sameSoulIds: initialSoulIds.every((soulId: string) => (
            afterRestarts.souls.some((soul: any) => soul.soulId === soulId)
          )),
          noBlankSubstitution: initialSoulIds.every((soulId: string) => {
            const before = initialRuntimeIdentity.get(soulId) as any
            const after = latestSoul(afterRestarts, soulId)
            return after?.terminalId === before.terminalId
          }),
          closeViewKeepsAgent: closeOutcome.soul.launchState === 'running',
          closeViewNotRecreatedAfterInventoryRefresh: afterCloseRefresh.tabs.tabs.every(
            (tab: any) => tab.soulId !== closeSoulId,
          ),
          stopAgentStopsRuntime: stopOutcome.soul.launchState === 'stopped',
          oldClientNoDuplicate: createdReply.terminalId === compatibilitySoul.terminalId
            && (await rig.ownershipFacts()).receiptCount === receiptCountBefore,
          initialSoulIds,
          expectedTabIds,
          expectedPaneIds,
          browserTabId,
          createdTabIds: created.map((response) => response.tabId),
        },
      }
      expect(receipt.browser.focusObservations).toHaveLength(4)
      expect(receipt.browser.focusStable).toBe(true)
      const published = await rig.publishPhase4BrowserReceipt(receipt.browser)
      console.log(`[P4-G08] runtime tab rehydration receipt: ${published.artifactRef}`)
    } finally {
      oldClient?.close()
      const cleanup = await rig.stop()
      expect(cleanup.ok, cleanup.errors.join('\n')).toBe(true)
    }
  })
})
