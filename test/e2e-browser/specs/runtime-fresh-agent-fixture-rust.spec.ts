/**
 * Deterministic, provider-free proof that every fresh-agent mode enters the
 * shared supervisor activation/recovery path. This is deliberately separate
 * from the authentic-provider receipt lane and cannot produce a release
 * qualification receipt.
 */
import { expect } from '@playwright/test'

import { validateFreshAgentIngressInventory } from '../../../scripts/testing/fresh-agent-ingress-inventory.js'
import { ManagedHistoryAwaitedPhases, ManagedHistoryDirectoryResponses, observeOwnedFreshBrowserPane } from '../../../scripts/testing/runtime-external-browser.js'
import { test } from '../helpers/fixtures.js'
import { createManagedRuntimeBrowserRig, openFreshHistorySession, type ManagedFixtureRig, type ManagedRuntimeView, type FixtureNativeState } from '../helpers/managed-runtime.js'
import { TestHarness } from '../helpers/test-harness.js'
import { assertManagedHistoryContinuity, type OwnedHistoryAllocation } from '../helpers/managed-history-continuity.js'

const FIXTURE_ENV = 'FRESHELL_RUNTIME_FRESH_AGENT_FIXTURE_TEST'
const PENDING_CONTROL = '[freshell-fixture:pending-approval]'

const MODES = [
  { agent: 'claude', mode: 'freshclaude', provider: 'claude' },
  { agent: 'kilroy', mode: 'kilroy', provider: 'kilroy' },
  { agent: 'codex', mode: 'freshcodex', provider: 'codex' },
  { agent: 'opencode', mode: 'freshopencode', provider: 'opencode' },
] as const

type Created = { paneId: string; sessionId: string; view: ManagedRuntimeView }
type ObservedResourceType = Parameters<ManagedHistoryAwaitedPhases['navigation']>[0]['resourceType']

/** Snapshot every existing pane before Projects unmounts and remounts the workspace. */
function historyPaneOwners(state: any, allocations: OwnedHistoryAllocation[]) {
  const leaves = (node: any): any[] => node?.type === 'leaf' ? [node]
    : node?.children?.flatMap(leaves) ?? []
  const panes = Object.entries(state.panes.layouts).flatMap(([tabId, layout]) => leaves(layout)
    .filter(leaf => leaf.content.kind === 'fresh-agent').map(leaf => ({ tabId, ...leaf })))
  expect(panes).toHaveLength(allocations.length)
  const owners = allocations.map(allocation => {
    const matches = panes.filter(pane => pane.id === allocation.paneId && pane.tabId === allocation.tabId)
    expect(matches, 'one existing pane per actual owned allocation').toHaveLength(1)
    const content = matches[0].content
    expect(content).toMatchObject({ createRequestId: allocation.createRequestId,
      sessionType: allocation.sessionType, provider: allocation.provider })
    expect([allocation.createdSessionId, allocation.nativeSessionId]).toContain(content.sessionId)
    const sessionRef = content.sessionRef ?? (content.resumeSessionId
      ? { provider: content.provider, sessionId: content.resumeSessionId } : undefined)
    if (sessionRef) expect(sessionRef).toEqual({ provider: allocation.provider, sessionId: allocation.nativeSessionId })
    return { ...allocation, sessionId: content.sessionId as string, sessionRef }
  })
  expect(new Set(owners.map(owner => owner.paneId)).size).toBe(owners.length)
  expect(new Set(owners.map(owner => owner.sessionId)).size).toBe(owners.length)
  return owners
}

function unwrap(body: any): any {
  return body?.data ?? body
}

async function post(baseUrl: string, token: string, route: string, body: unknown): Promise<any> {
  const response = await fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-auth-token': token },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`${route} failed: ${response.status} ${await response.text()}`)
  return unwrap(await response.json())
}

async function waitFor<T>(description: string, probe: () => Promise<T | null>, timeout = 90_000): Promise<T> {
  const deadline = Date.now() + timeout
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      const value = await probe()
      if (value !== null) return value
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  const suffix = lastError instanceof Error ? `; last error: ${lastError.message}` : ''
  throw new Error(`timed out waiting for ${description}${suffix}`)
}

async function fixtureState(rig: ManagedFixtureRig, view: ManagedRuntimeView): Promise<FixtureNativeState> {
  return rig.fixtureNativeState(rig.exactRuntimeHandle(view))
}

async function originalFreshAllocation(rig: ManagedFixtureRig, sessionId: string): Promise<ManagedRuntimeView | null> {
  const view = await rig.runningViewForFreshSession(sessionId)
  if (!view) return null
  const matches = (await rig.inventory()).filter(row => row.freshAgentSessionId === sessionId && row.launchState === 'running')
  expect(matches, 'one current owned original allocation').toHaveLength(1)
  expect(matches[0]).toEqual(view)
  return view
}

async function replacement(
  rig: ManagedFixtureRig,
  sessionId: string,
  priorIncarnationId: string,
): Promise<ManagedRuntimeView> {
  return waitFor('supervisor-owned replacement incarnation', async () => {
    const view = await rig.runningViewForFreshSession(sessionId)
    return view?.containerId && view.incarnationId !== priorIncarnationId ? view : null
  })
}

test.describe.serial('managed fresh-agent deterministic fixture', () => {
  test('completed owned native fixture history opens its existing browser pane', async ({ page }) => {
    test.skip(process.env[FIXTURE_ENV] !== '1', `set ${FIXTURE_ENV}=1 explicitly`)
    test.setTimeout(900_000)
    const modeNames = MODES.map(({ mode }) => mode)
    const rig = createManagedRuntimeBrowserRig(process.cwd(), 3, {}, {
      FRESHELL_RUNTIME_OBSERVER_INTERVAL_MS: '250',
    }, 'test', {
      enabledProviders: [], freshAgentModes: modeNames, fixtureFreshAgentModes: modeNames,
      providerSettings: Object.fromEntries(MODES.map(({ mode }) => [mode, {}])),
    })
    const sent: any[] = []
    const createdReplies: any[] = []
    const completedTurnSessionIds = new Set<string>()
    const allocations: OwnedHistoryAllocation[] = []
    const observation = new ManagedHistoryAwaitedPhases()
    let historyDiagnostics: ManagedHistoryDirectoryResponses | undefined
    let resourceFailures = 0
    page.on('response', response => {
      if (response.status() >= 400 && resourceFailures++ < 32) observation.navigation({
        status: response.status(), resourceType: response.request().resourceType() as ObservedResourceType, category: 'response',
      })
    })
    page.on('requestfailed', request => {
      if (resourceFailures++ < 32) observation.navigation({ resourceType: request.resourceType() as ObservedResourceType, category: 'request-failed' })
    })
    page.on('pageerror', () => {
      if (resourceFailures++ < 32) observation.navigation({ resourceType: 'other', category: 'page-error' })
    })
    page.on('websocket', socket => {
      socket.on('framesent', frame => {
        try { sent.push(JSON.parse(String(frame.payload))) } catch { /* non-JSON frame */ }
      })
      socket.on('framereceived', frame => {
        try {
          const message = JSON.parse(String(frame.payload))
          if (message.type === 'freshAgent.created') createdReplies.push(message)
          const event = message.type === 'freshAgent.event' ? message.event : message
          if (event?.type === 'freshAgent.turn.complete' && typeof message.sessionId === 'string') {
            completedTurnSessionIds.add(message.sessionId)
          }
        } catch { /* non-JSON frame */ }
      })
    })
    try {
      const info = await observation.run('start', 'bootstrap', () => rig.start())
      const response = await observation.run('goto', 'bootstrap', () => page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`, { timeout: 60_000 }))
      if (response) observation.navigation({ status: response.status(), resourceType: 'document', category: 'response' })
      const harness = new TestHarness(page)
      await observation.run('harness', 'bootstrap', () => harness.waitForHarness())
      await observation.run('connection', 'bootstrap', () => harness.waitForConnection())
      for (const definition of MODES) {
        const phase = <T>(name: Parameters<ManagedHistoryAwaitedPhases['run']>[0], operation: () => T | Promise<T>) => observation.run(name, definition.mode, operation)
        await phase('new-tab', () => page.keyboard.press('Alt+t'))
        const label = { freshclaude: 'Freshclaude', kilroy: 'Kilroy', freshcodex: 'Freshcodex', freshopencode: 'Freshopencode' }[definition.mode]
        const picker = page.getByRole('toolbar', { name: /pane type picker/i }).last()
        await phase('picker-visible', () => expect(picker).toBeVisible())
        await phase('picker-click', () => picker.getByRole('button', { name: label, exact: true }).click())
        const directory = page.getByLabel('Starting directory for ' + label)
        await phase('directory-fill', () => directory.fill(rig.repoRoot))
        await phase('directory-enter', () => directory.press('Enter'))
        const created = await phase('pane-observation', () => waitFor('browser-created managed fixture pane', async () => {
          const state = await harness.getState()
          const tabId = state.tabs.activeTabId!
          const leaf = state.panes.layouts[tabId]
          return leaf?.type === 'leaf' && leaf.content.kind === 'fresh-agent' && leaf.content.sessionId
            ? { tabId, paneId: leaf.id, sessionId: leaf.content.sessionId, createRequestId: leaf.content.createRequestId,
              sessionType: leaf.content.sessionType, provider: leaf.content.provider, sessionRef: leaf.content.sessionRef,
              soulId: leaf.content.soulId, incarnationId: leaf.content.incarnationId } : null
        }))
        const wireProvider = definition.provider === 'kilroy' ? 'claude' : definition.provider
        const { view, createdSessionId } = await phase('first-inventory', () => waitFor('owned fixture activation', async () => {
          expect(created).toMatchObject({ sessionType: definition.mode, provider: wireProvider })
          const requests = sent.filter(frame => frame.type === 'freshAgent.create' && frame.requestId === created.createRequestId)
          expect(requests, 'one original pane creation request').toHaveLength(1)
          expect(requests[0]).toMatchObject({ tabId: created.tabId, paneId: created.paneId,
            sessionType: definition.mode, provider: wireProvider })
          const replies = createdReplies.filter(reply => reply.requestId === created.createRequestId)
          if (!replies.length) return null
          expect(replies, 'one original creation acknowledgement').toHaveLength(1)
          const reply = replies[0]
          expect(reply).toMatchObject({ sessionType: definition.mode, provider: wireProvider, runtimeProvider: definition.provider })
          expect(typeof reply.sessionId).toBe('string')
          expect(reply.sessionId).toBeTruthy()
          // Inventory may already have promoted the pane to native identity.
          // External lookup deliberately addresses the original presentation only.
          const view = await originalFreshAllocation(rig, reply.sessionId)
          if (!view) return null
          expect(view).toMatchObject({ provider: definition.provider, freshAgentSessionType: definition.mode,
            freshAgentSessionId: reply.sessionId, profile: 'default_agent' })
          rig.exactRuntimeHandle(view)
          expect(reply.sessionRef).toEqual({ provider: wireProvider, sessionId: view.nativeSessionId })
          expect([reply.sessionId, view.nativeSessionId]).toContain(created.sessionId)
          if (created.sessionRef) expect(created.sessionRef).toEqual(reply.sessionRef)
          if (created.soulId) expect(created.soulId).toBe(view.soulId)
          if (created.incarnationId) expect(created.incarnationId).toBe(view.incarnationId)
          return { view, createdSessionId: reply.sessionId as string }
        }))
        const pane = page.locator('[data-context="fresh-agent"][data-pane-id="' + created.paneId + '"]')
        const composer = pane.getByRole('textbox', { name: 'Chat message input' })
        await phase('composer-enabled', () => expect(composer).toBeEnabled())
        await phase('composer-fill', () => composer.fill(`deterministic saved fixture turn for ${definition.mode}`))
        await phase('send', () => pane.getByRole('button', { name: 'Send', exact: true }).click())
        expect(view.nativeSessionId).toBeTruthy()
        const nativeSessionId = view.nativeSessionId!
        await phase('completion', () => waitFor('actual fixture completion', async () => {
          const state = await fixtureState(rig, view)
          // The fixture counter advances before its provider-history write.
          // Materialization follows that write and promotes the proxy route;
          // the following completion must use the owned native identity.
          expect({ state, createdSessionId, nativeSessionId, completedTurnSessionIds: [...completedTurnSessionIds] })
            .toMatchObject({ state: { dispatchCount: 1, completionCount: 1 },
              completedTurnSessionIds: expect.arrayContaining([nativeSessionId]) })
          return state
        }))
        const paneObservation = { ...created, sessionType: definition.mode, provider: wireProvider,
          createdSessionId, nativeSessionId }
        const nativePane = await phase('native-pane', () => waitFor('browser pane bound to the actual owned allocation',
          () => page.evaluate(observeOwnedFreshBrowserPane, paneObservation)))
        allocations.push({ ...paneObservation, soulId: view.soulId, incarnationId: view.incarnationId,
          containerId: view.containerId!, hostBootId: view.hostBootId!, intentRevision: view.intentRevision })
        const tabCount = await phase('tab-count', () => harness.getTabCount())
        const { baseline, owners } = await phase('layout', async () => {
          const baseline = await harness.getState()
          return { baseline, owners: historyPaneOwners(baseline, allocations) }
        })
        expect(owners.find(owner => owner.paneId === created.paneId)?.sessionId).toBe(nativePane.sessionId)
        const soulIds = (await phase('inventory-before', () => rig.inventory())).map(row => row.soulId).sort()
        const cursor = sent.length
        const historyIdentity = { repoRoot: rig.repoRoot, provider: wireProvider, nativeSessionId: view.nativeSessionId! }
        historyDiagnostics = new ManagedHistoryDirectoryResponses(page, observation, definition.mode, historyIdentity)
        await phase('history-open', () => openFreshHistorySession(page, historyIdentity, historyDiagnostics))
        await phase('history-pane-visible', () => expect(pane).toBeVisible())
        await phase('history-active-tab', async () => expect(await harness.getActiveTabId()).toBe(created.tabId))
        await phase('history-tab-count', async () => expect(await harness.getTabCount()).toBe(tabCount))
        await phase('history-layout', async () => {
          const currentState = await harness.getState()
          assertManagedHistoryContinuity(baseline, currentState, allocations)
          expect(historyPaneOwners(currentState, allocations)).toEqual(owners)
        })
        await phase('history-inventory', async () => expect((await rig.inventory()).map(row => row.soulId).sort()).toEqual(soulIds))
        await phase('history-wire', () => waitFor('actual owned History wire ingress', () => sent.slice(cursor).find(frame =>
          frame.type === 'freshAgent.attach' && frame.sessionId === nativePane.sessionId
          || frame.type === 'freshAgent.create' && frame.sessionRef?.sessionId === view.nativeSessionId) ?? null))
        const historyFrames = sent.slice(cursor).filter(frame => ['freshAgent.create', 'freshAgent.attach', 'freshAgent.send'].includes(frame.type))
        expect(historyFrames.filter(frame => frame.type === 'freshAgent.send')).toHaveLength(0)
        expect(historyFrames.length).toBeGreaterThan(0)
        for (const frame of historyFrames) {
          if (frame.type === 'freshAgent.create') {
            expect(frame.provider).toBe(wireProvider)
            expect(frame.sessionType).toBe(definition.mode)
            expect(frame.requestId).toBe(created.createRequestId)
            expect(frame.tabId).toBe(created.tabId)
            expect(frame.sessionRef).toMatchObject({ provider: wireProvider, sessionId: view.nativeSessionId })
          } else {
            // Hidden tabs also reattach. Every frame still needs a unique,
            // allocation-backed owner; filtering only the target would hide bugs.
            const matches = owners.filter(owner => owner.sessionId === frame.sessionId)
            expect(matches, 'History attachment must have one preexisting owned pane').toHaveLength(1)
            expect(frame.provider).toBe(matches[0].provider)
            expect(frame.sessionType).toBe(matches[0].sessionType)
            expect(frame.sessionRef).toEqual(matches[0].sessionRef)
          }
        }
        await phase('history-current', async () => {
          const current = await originalFreshAllocation(rig, createdSessionId)
          expect(current?.soulId).toBe(view.soulId)
          expect(current?.incarnationId).toBe(view.incarnationId)
          expect(current?.nativeSessionId).toBe(view.nativeSessionId)
          expect(current).toMatchObject({ provider: view.provider, profile: view.profile,
            intentRevision: view.intentRevision,
            freshAgentSessionType: definition.mode, freshAgentSessionId: createdSessionId })
          expect(rig.exactRuntimeHandle(current!)).toEqual(rig.exactRuntimeHandle(view))
        })
        await phase('history-dispatch', async () => expect((await fixtureState(rig, view)).dispatchCount).toBe(1))
        await historyDiagnostics.close()
        historyDiagnostics = undefined
      }
    } finally {
      try { await historyDiagnostics?.close() } catch { /* diagnostics cannot replace the original result or cleanup */ }
      const cleanup = await rig.stop()
      expect(cleanup.ok, cleanup.errors.join('\n')).toBe(true)
    }
  })

  test('all modes share activation and exact-native recovery without provider access', async () => {
    test.skip(process.env[FIXTURE_ENV] !== '1', `set ${FIXTURE_ENV}=1 explicitly`)
    test.setTimeout(900_000)
    validateFreshAgentIngressInventory(process.cwd())

    const modeNames = MODES.map(({ mode }) => mode)
    const rig = createManagedRuntimeBrowserRig(process.cwd(), 3, {}, {
      FRESHELL_RUNTIME_OBSERVER_INTERVAL_MS: '250',
    }, 'test', {
      enabledProviders: [],
      freshAgentModes: modeNames,
      fixtureFreshAgentModes: modeNames,
      providerSettings: Object.fromEntries(MODES.map(({ mode }) => [mode, {}])),
    })
    const created: Created[] = []
    try {
      const info = await rig.start()

      for (const definition of MODES) {
        const tab = await post(info.baseUrl, info.token, '/api/tabs', {
          agent: definition.agent,
          cwd: rig.repoRoot,
        })
        expect(tab.paneId).toBeTruthy()
        expect(tab.sessionId).toBeTruthy()
        const view = await waitFor('fresh-agent supervisor activation', () => (
          rig.runningViewForFreshSession(tab.sessionId)
        ))
        expect(view.freshAgentSessionType).toBe(definition.mode)
        expect(view.provider).toBe(definition.provider)
        expect(view.containerId).toBeTruthy()
        const worker = await rig.fixtureWorkerFacts(rig.exactRuntimeHandle(view))
        expect(worker.provider).toBe(definition.provider)
        expect(worker.workerPid).toBeGreaterThan(1)

        const send = await post(info.baseUrl, info.token, `/api/panes/${tab.paneId}/send-keys`, {
          data: `deterministic turn for ${definition.mode}`,
        })
        expect(send.sessionId).toBe(tab.sessionId)
        const state = await waitFor('one provider-native fixture completion', async () => {
          const current = (await fixtureState(rig, view))
          return current.dispatchCount === 1 && current.completionCount === 1 ? current : null
        })
        expect(view.nativeSessionId).toBe(state.nativeSessionId)
        created.push({ paneId: tab.paneId, sessionId: tab.sessionId, view })
      }

      expect(new Set(created.map(({ view }) => view.containerId)).size).toBe(MODES.length)
      const volumes = await Promise.all(created.map(async ({ view }) => (
        (await rig.providerVolumeFacts(rig.exactRuntimeHandle(view))).providerVolumeName
      )))
      expect(volumes.every(Boolean)).toBe(true)
      expect(new Set(volumes).size).toBe(MODES.length)

      const restarted = await rig.crashAndRestartWeb()
      for (const item of created) {
        const current = await rig.runningViewForFreshSession(item.sessionId)
        expect(current?.incarnationId).toBe(item.view.incarnationId)
        expect(current?.nativeSessionId).toBe(item.view.nativeSessionId)
      }

      const claude = created[0]
      await post(restarted.baseUrl, restarted.token, `/api/panes/${claude.paneId}/send-keys`, {
        data: PENDING_CONTROL,
        timeout: 0,
      })
      const pendingState = await waitFor('fixture approval request', async () => {
        const state = (await fixtureState(rig, claude.view))
        return typeof state.pendingDecisionId === 'string' ? state : null
      })
      const decisionId = pendingState.pendingDecisionId
      if (!decisionId) throw new Error('observed pending fixture decision required')
      await rig.crashRuntimeHost(rig.exactRuntimeHandle(claude.view))
      const recoveredClaude = await replacement(rig, claude.sessionId, claude.view.incarnationId)
      expect(recoveredClaude.nativeSessionId).toBe(claude.view.nativeSessionId)
      await rig.allowFixtureDecision(rig.exactRuntimeHandle(recoveredClaude), decisionId)
      await waitFor('exactly-once pending completion', async () => {
        const state = (await fixtureState(rig, recoveredClaude))
        return state.pendingDecisionId === null && state.dispatchCount === 2
          && state.completionCount === 2 ? state : null
      })

      const codex = created[2]
      expect((await rig.fixtureWorkerFacts(rig.exactRuntimeHandle(codex.view))).provider).toBe('codex')
      await rig.crashFixtureWorker(rig.exactRuntimeHandle(codex.view))
      const recoveredCodex = await replacement(rig, codex.sessionId, codex.view.incarnationId)
      expect(recoveredCodex.nativeSessionId).toBe(codex.view.nativeSessionId)
      expect((await fixtureState(rig, recoveredCodex)).dispatchCount).toBe(1)

      await rig.restartSupervisor()
      await rig.crashAndRestartWeb()
      for (const item of created) {
        const current = await waitFor('startup-reconciled fresh-agent', () => (
          rig.runningViewForFreshSession(item.sessionId)
        ))
        expect(current.nativeSessionId).toBe(item.view.nativeSessionId)
      }
    } finally {
      const cleanup = await rig.stop()
      expect(cleanup.ok, cleanup.errors.join('\n')).toBe(true)
    }
  })
})
