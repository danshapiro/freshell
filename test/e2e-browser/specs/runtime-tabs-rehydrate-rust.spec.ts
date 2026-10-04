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
import fs from 'node:fs/promises'
import path from 'node:path'

import { test } from '../helpers/fixtures.js'
import { ManagedRuntimeBrowserRig } from '../helpers/managed-runtime.js'
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
    const rig = new ManagedRuntimeBrowserRig(process.cwd(), 3, {}, {
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
      await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
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
      const rolloutPath = `/home/freshell/provider/.codex/sessions/2026/03/01/rollout-${view.nativeSessionId}.jsonl`
      const makeTranscript = (nativeId: string) => [
        JSON.stringify({ type: 'session_meta', payload: { id: nativeId, cwd: '/workspace', model_provider: 'openai' } }),
        ...Array.from({ length: 80 }, (_, index) => [
          JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: `retained-${index}` } }),
          JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: `Managed prompt ${index}` } }),
          JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', turn_id: `retained-${index}`,
            last_agent_message: `${index === 79 ? 'Managed fixture saved answer' : `Managed retained answer ${index}`}\n${'x'.repeat(20_000)}` } }),
        ]).flat(),
      ].join('\n') + '\n'
      const transcript = makeTranscript(view.nativeSessionId!)
      expect(Buffer.byteLength(transcript)).toBeGreaterThan(1024 * 1024)
      // Generate in the owned provider process, avoiding a multi-MiB argv value.
      rig.ownedProviderExec(view.containerId!, ['node', '--input-type=module', '-e',
        `import fs from "node:fs"; import path from "node:path"; const makeTranscript = ${makeTranscript.toString()}; fs.mkdirSync(path.dirname(process.argv[1]), {recursive:true}); fs.writeFileSync(process.argv[1], makeTranscript(process.argv[2]));`,
        rolloutPath, view.nativeSessionId!])
      const fixtureState = () => JSON.parse(rig.ownedProviderExec(view.containerId!, [
        'cat', '/home/freshell/provider/.freshell-fixture/provider-native-state.json',
      ]))
      const before = fixtureState()
      const ownedSnapshot = await rig.runtime.adminOk(rig.supervisor, {
        method: 'fresh_agent_read_snapshot', params: { soulId: view.soulId, expectedControlEpoch: await rig.controlEpoch() },
      })
      expect(ownedSnapshot.data.threadId).toBe(view.nativeSessionId)
      const expectLargeRetainedHistory = (snapshot: any) => {
        expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeGreaterThan(1024 * 1024)
        // The native projection preserves each user/assistant row independently.
        expect(snapshot.turns).toHaveLength(160)
        expect(snapshot.turns[0].turnId).toBe('retained-0:row-0')
        expect(snapshot.turns[159].turnId).toBe('retained-79:row-1')
        const first = snapshot.turns[1].items.find((item: any) => item.text?.startsWith('Managed retained answer 0'))
        const last = snapshot.turns[159].items.find((item: any) => item.text?.startsWith('Managed fixture saved answer'))
        expect(first.text).toBe(`Managed retained answer 0\n${'x'.repeat(20_000)}`)
        expect(last.text).toBe(`Managed fixture saved answer\n${'x'.repeat(20_000)}`)
        expect(snapshot.extensions.codex.nativeHistoryRetention).toBeUndefined()
      }
      expectLargeRetainedHistory(ownedSnapshot.data)
      const initialSnapshot = await fetch(`${info.baseUrl}/api/fresh-agent/threads/freshcodex/codex/${view.nativeSessionId}`, {
        headers: { 'x-auth-token': info.token },
      })
      expect(initialSnapshot.ok).toBe(true)
      expectLargeRetainedHistory(await initialSnapshot.json())
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
      let release!: () => void
      const held = new Promise<void>((resolve) => { release = resolve })
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
      expect(fixtureState().dispatchCount).toBe(before.dispatchCount)
      release()
      await expect(composer).toBeEnabled()
      await expect(composer).toHaveValue('Draft stays in this managed conversation')
      await composer.press('Enter')
      await expect.poll(() => fixtureState().completionCount, { timeout: 30_000 }).toBe(before.completionCount + 1)
      expect(fixtureState().dispatchCount).toBe(before.dispatchCount + 1)
      expect(fixtureState().nativeSessionId).toBe(view.nativeSessionId)
      const current = (await rig.inventory()).find((row) => row.soulId === view.soulId)
      expect(current).toMatchObject({ soulId: view.soulId, containerId: view.containerId,
        incarnationId: view.incarnationId, nativeSessionId: view.nativeSessionId })
      await expectOriginalConversation()
      expect(sent.slice(baseline).filter((frame) => frame.type === 'freshAgent.create' || frame.type === 'pane.reconcile.request')).toHaveLength(0)
      expect(rig.ownedProviderExec(view.containerId!, ['cat', rolloutPath])).toBe(transcript)
      const stableProviderState = fixtureState()
      // A tracked host can stop answering while its managed projection still says live.
      // Its saved source is the owned provider volume, never a coincident web-local file.
      await page.unroute('**/api/fresh-agent/threads/**')
      const wrongPath = `${info.homeDir}/.codex/sessions/rollout-${view.nativeSessionId}.jsonl`
      await fs.mkdir(`${info.homeDir}/.codex/sessions`, { recursive: true })
      const wrongTranscript = transcript.replaceAll('Managed fixture saved answer', 'Wrong web-local answer')
      await fs.writeFile(wrongPath, wrongTranscript)
      const lifecyclePath = path.join(path.dirname(rig.supervisor.runtimeRoot), 'evidence', 'lifecycle.jsonl')
      const readLifecycle = async () => (await fs.readFile(lifecyclePath, 'utf8'))
        .split('\n').filter(Boolean).map((line) => JSON.parse(line))
      const startupFinished = (await readLifecycle()).find((event) => event.event === 'supervisor.startup_scan.finished')
      expect(Number.isFinite(startupFinished?.at)).toBe(true)
      // The observer sleeps first, after startup reconciliation finishes.
      const firstObservationNotBefore = startupFinished.at + observerIntervalMs
      const holdRequestedAt = Date.now()
      expect(firstObservationNotBefore - holdRequestedAt,
        'owned history/read/reload must have a measured window before STOP').toBeGreaterThanOrEqual(25_000)
      const pid = rig.runtime.ownedContainerHostPidExact(view.containerId!)
      heldHost = { containerId: view.containerId!, incarnationId: view.incarnationId, pid }
      rig.signalOwnedSessionHostExact(heldHost.containerId, heldHost.incarnationId, 'SIGSTOP', pid)
      await expect.poll(async () => /State:\s+T/.test(await fs.readFile(`/proc/${pid}/status`, 'utf8'))).toBe(true)
      const heldAt = Date.now()
      rig.runtime.recordLifecycle('browser.owned_host_hold', { ...heldHost, state: 'T' })
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
      expectLargeRetainedHistory(history)
      expect(JSON.stringify(history)).not.toContain('Wrong web-local answer')
      expect(sent.slice(unavailableBaseline).filter((frame) => frame.type === 'freshAgent.create' || frame.type === 'pane.reconcile.request')).toHaveLength(0)
      expect(fixtureState()).toMatchObject({ nativeSessionId: stableProviderState.nativeSessionId,
        dispatchCount: stableProviderState.dispatchCount, completionCount: stableProviderState.completionCount })
      const reloadSentBaseline = sent.length
      const reloadReceivedBaseline = received.length
      await page.reload()
      await harness.waitForHarness()
      await harness.waitForConnection()
      const bootstrap = await waitForValue('canonical reload reconciliation acknowledgement', () => {
        const request = sent.slice(reloadSentBaseline).find((frame) => frame.type === 'pane.reconcile.request')
        const result = received.slice(reloadReceivedBaseline).find((frame) => frame.type === 'pane.reconcile.result'
          && frame.reconcileId === request?.reconcileId)
        return request && result ? { request, result } : null
      }, 30_000)
      expect(bootstrap.request.panes).toEqual([expect.objectContaining({
        paneKey: `${created.tabId}:${created.paneId}`, createRequestId: original.createRequestId,
        sessionRef: original.sessionRef, kind: 'fresh-agent', mode: 'codex',
      })])
      if (bootstrap.result.verdicts.some((verdict: any) => ['fresh', 'respawn'].includes(verdict.verdict))) {
        await waitForValue('same-request bootstrap create acknowledgement', () => received.slice(reloadReceivedBaseline)
          .find((frame) => ['freshAgent.created', 'freshAgent.create.failed'].includes(frame.type)
            && frame.requestId === original.createRequestId), 30_000)
      }
      const bootstrapLifecycle = () => sent.slice(reloadSentBaseline)
        .filter((frame) => frame.type === 'freshAgent.create' || frame.type === 'pane.reconcile.request')
      const expectOnlyCanonicalBootstrap = () => {
        const frames = bootstrapLifecycle()
        expect(frames.filter((frame) => frame.type === 'pane.reconcile.request')).toEqual([bootstrap.request])
        const creates = frames.filter((frame) => frame.type === 'freshAgent.create')
        expect(creates.length).toBeLessThanOrEqual(1)
        for (const frame of creates) {
          expect(frame).toMatchObject({ requestId: original.createRequestId, tabId: created.tabId,
            provider: 'codex', sessionType: 'freshcodex' })
          if (frame.sessionRef) expect(frame.sessionRef).toEqual(original.sessionRef)
        }
      }
      expectOnlyCanonicalBootstrap()
      const settledLifecycleCount = bootstrapLifecycle().length
      await expect(pane.getByText('Managed fixture saved answer', { exact: false })).toBeVisible({ timeout: 60_000 })
      await expect(composer).toBeDisabled()
      await expect(pane.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0)
      await expect(pane.getByText('Wrong web-local answer', { exact: false })).toHaveCount(0)
      await expectOriginalConversation()
      expect(fixtureState()).toMatchObject({ nativeSessionId: stableProviderState.nativeSessionId,
        dispatchCount: stableProviderState.dispatchCount, completionCount: stableProviderState.completionCount })
      expect(rig.ownedProviderExec(view.containerId!, ['cat', rolloutPath])).toBe(transcript)
      expect(await fs.readFile(wrongPath, 'utf8')).toBe(wrongTranscript)
      const managedReceipts = rig.runtime.broker.receipts().filter((receipt) => receipt.soulId === view.soulId)
      expect(managedReceipts).toHaveLength(1)
      expect(managedReceipts[0].containerId).toBe(view.containerId)
      expect(rig.runtime.broker.eventsSnapshot().filter((event) => event.containerId === view.containerId
        && event.method === 'POST' && event.url === `/v1.47/containers/${view.containerId}/start`)).toHaveLength(1)
      const lifecycle = await readLifecycle()
      const launches = lifecycle.filter((event) => event.event === 'supervisor.launch_running' && event.data.soulId === view.soulId)
      expect(launches).toHaveLength(1)
      expect(launches[0].data).toMatchObject({ incarnationId: view.incarnationId, containerId: view.containerId, workerLaunchCount: 1 })
      expectOnlyCanonicalBootstrap()
      expect(bootstrapLifecycle()).toHaveLength(settledLifecycleCount)
      const historyEvidence = { source: 'owned provider-volume native history',
        wrongSource: 'coincident web-local native history', heldHost, bootstrap: bootstrap.request,
        bootstrapCreates: bootstrapLifecycle().filter((frame) => frame.type === 'freshAgent.create'),
        nativeSessionId: view.nativeSessionId, beforeHistory: stableProviderState, afterReload: fixtureState(),
        originalIdentity: canonicalIdentity, managedLaunch: launches[0], bothSourcesUnchanged: true }
      rig.signalOwnedSessionHostExact(heldHost.containerId, heldHost.incarnationId, 'SIGCONT', pid)
      const releasedAt = Date.now()
      rig.runtime.recordLifecycle('browser.owned_host_release', heldHost)
      heldHost = undefined
      await expect.poll(async () => /State:\s+T/.test(await fs.readFile(`/proc/${pid}/status`, 'utf8'))).toBe(false)
      const resumedAt = Date.now()
      expect(resumedAt, 'exact owned host must resume before the first observer pass').toBeLessThan(firstObservationNotBefore)
      await expectOriginalConversation()
      expect(fixtureState()).toMatchObject({ nativeSessionId: stableProviderState.nativeSessionId,
        dispatchCount: stableProviderState.dispatchCount, completionCount: stableProviderState.completionCount })
      expectOnlyCanonicalBootstrap()
      expect(bootstrapLifecycle()).toHaveLength(settledLifecycleCount)
      const targetSoulRecoveries = (await readLifecycle()).filter((event) => event.event === 'supervisor.runtime_observer.recovery_scheduled'
        && event.data.soulId === view.soulId)
      expect(targetSoulRecoveries).toHaveLength(0)
      rig.runtime.writeBrowserArtifact('owned-host-history-preservation', { ...historyEvidence,
        observerWindow: { intervalMs: observerIntervalMs, startupFinished, firstObservationNotBefore,
          holdRequestedAt, heldAt, releasedAt, resumedAt, targetSoulRecoveries } })
    } finally {
      try {
        if (heldHost) rig.signalOwnedSessionHostExact(heldHost.containerId, heldHost.incarnationId, 'SIGCONT', heldHost.pid)
      } finally {
        const cleanup = await rig.stop()
        expect(cleanup.ok, cleanup.errors.join('\n')).toBe(true)
      }
    }
  })

  test('P4-G08: controller inventory reconstructs views without duplicating souls', async ({ page }) => {
    test.setTimeout(900_000)

    const rig = new ManagedRuntimeBrowserRig(process.cwd(), 4)
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
      const receiptCountBefore = rig.runtime.broker.receipts().length
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
      expect(rig.runtime.broker.receipts()).toHaveLength(receiptCountBefore)
      expect(latestSoul(await rig.inventorySnapshot(), compatibilitySoulId)?.launchState).toBe('running')

      const finalState = await browserState(page)
      const receipt = {
        schemaVersion: 1,
        status: 'PASS',
        candidateSha: rig.runtime.candidateSha,
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
            && rig.runtime.broker.receipts().length === receiptCountBefore,
          initialSoulIds,
          expectedTabIds,
          expectedPaneIds,
          browserTabId,
          createdTabIds: created.map((response) => response.tabId),
        },
      }
      expect(receipt.browser.focusObservations).toHaveLength(4)
      expect(receipt.browser.focusStable).toBe(true)
      const receiptPath = rig.writePhase4BrowserReceipt(receipt)
      // eslint-disable-next-line no-console
      console.log(`[P4-G08] runtime tab rehydration receipt: ${receiptPath}`)
    } finally {
      oldClient?.close()
      const cleanup = await rig.stop()
      expect(cleanup.ok, cleanup.errors.join('\n')).toBe(true)
    }
  })
})
