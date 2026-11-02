/**
 * Deterministic, provider-free proof that every fresh-agent mode enters the
 * shared supervisor activation/recovery path. This is deliberately separate
 * from the authentic-provider receipt lane and cannot produce a release
 * qualification receipt.
 */
import { expect } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { validateFreshAgentIngressInventory } from '../../../scripts/testing/fresh-agent-ingress-inventory.js'
import { ManagedHistoryAwaitedPhases, ManagedHistoryDirectoryResponses, observeOwnedFreshBrowserPane } from '../../../scripts/testing/runtime-external-browser.js'
import { createFreshE2ePage, test } from '../helpers/fixtures.js'
import { installDualRoleCodexCli } from '../fixtures/codex-dual-role.js'
import { createManagedRuntimeBrowserRig, ManagedRuntimeBrowserRig, openFreshHistorySession, type ManagedFixtureRig, type ManagedRuntimeView, type FixtureNativeState } from '../helpers/managed-runtime.js'
import { TestHarness } from '../helpers/test-harness.js'
import { assertManagedHistoryContinuity, type OwnedHistoryAllocation } from '../helpers/managed-history-continuity.js'
import { TerminalHelper } from '../helpers/terminal-helpers.js'

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

function allLeaves(node: any, output: any[] = []): any[] {
  if (!node) return output
  if (node.type === 'leaf') output.push(node)
  else if (node.type === 'split') for (const child of node.children ?? []) allLeaves(child, output)
  return output
}

function runtimeIdentity(view: {
  soulId: string
  incarnationId: string
  containerId?: string | null
  hostBootId?: string | null
  nativeSessionId?: string | null
}) {
  expect(view.containerId, 'managed allocation container').toBeTruthy()
  expect(view.hostBootId, 'managed allocation host boot').toBeTruthy()
  expect(view.nativeSessionId, 'managed provider native session').toBeTruthy()
  return {
    soulId: view.soulId, incarnationId: view.incarnationId, containerId: view.containerId,
    hostBootId: view.hostBootId, nativeSessionId: view.nativeSessionId,
  }
}

function countBy(records: unknown[], key: string): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const record of records) {
    if (!record || typeof record !== 'object') continue
    const value = (record as Record<string, unknown>)[key]
    if (typeof value !== 'string') continue
    counts[value] = (counts[value] ?? 0) + 1
  }
  return counts
}

async function captureAuthenticatedReadiness(rig: ManagedRuntimeBrowserRig): Promise<Record<string, unknown>> {
  try {
    const response = await fetch(`${rig.info.baseUrl}/api/runtime/readiness`, {
      headers: { 'x-auth-token': rig.info.token },
      signal: AbortSignal.timeout(5_000),
    })
    const body = await response.json().catch(() => null) as Record<string, any> | null
    const health = await rig.runtime.adminOk(rig.supervisor, { method: 'health' })
    const healthData = health?.data && typeof health.data === 'object' ? health.data : health
    const healthInstallationId = healthData?.installationId ?? healthData?.installation_id
    const healthControlEpoch = healthData?.controlEpoch ?? healthData?.control_epoch
    const identityMatchesSupervisor = Boolean(body
      && body.installationId === healthInstallationId
      && body.controlEpoch === healthControlEpoch)
    const ownership = body?.paneOwnership && typeof body.paneOwnership === 'object'
      ? body.paneOwnership as Record<string, any> : null
    const panes = Array.isArray(ownership?.panes) ? ownership.panes : []
    const unattached = Array.isArray(ownership?.unattachedProcesses) ? ownership.unattachedProcesses : []
    return {
      status: response.status,
      readinessShapePresent: Boolean(body?.readiness && ownership),
      identityMatchesSupervisor,
      initialScanState: body?.readiness?.initialScanState ?? null,
      blockedSubsystemCount: Array.isArray(body?.readiness?.blockedSubsystems)
        ? body.readiness.blockedSubsystems.length : null,
      paneOwnership: ownership ? {
        complete: ownership.complete === true,
        readyToStop: ownership.readyToStop === true,
        paneCount: panes.length,
        paneOwnershipCounts: countBy(panes, 'ownership'),
        paneKindCounts: countBy(panes, 'kind'),
        paneProviderCounts: countBy(panes, 'provider'),
        panes: panes.map((pane: Record<string, unknown>) => ({
          ownership: pane.ownership, kind: pane.kind, provider: pane.provider,
          terminalIdPresent: typeof pane.terminalId === 'string',
          sessionIdPresent: typeof pane.sessionId === 'string',
          runtimeSoulIdentityPresent: typeof pane.soulId === 'string' && typeof pane.incarnationId === 'string',
        })),
        unattachedCount: unattached.length,
        unattachedOwnershipCounts: countBy(unattached, 'ownership'),
        unattachedKindCounts: countBy(unattached, 'kind'),
        unattachedProviderCounts: countBy(unattached, 'provider'),
      } : null,
    }
  } catch (error) {
    return { status: 'capture-failed', errorName: error instanceof Error ? error.name : 'UnknownError' }
  }
}

function freshAgentLeaf(state: any, paneId: string) {
  for (const [tabId, layout] of Object.entries(state.panes.layouts)) {
    const leaf = allLeaves(layout).find(candidate => candidate.id === paneId && candidate.content.kind === 'fresh-agent')
    if (leaf) return { tabId, ...leaf }
  }
  return null
}

function terminalLeaf(state: any, paneId: string) {
  for (const [tabId, layout] of Object.entries(state.panes.layouts)) {
    const leaf = allLeaves(layout).find(candidate => candidate.id === paneId && candidate.content.kind === 'terminal')
    if (leaf) return { tabId, ...leaf }
  }
  return null
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

test('managed update modes - default preserves running souls and reports reminder', async ({ browser }) => {
  test.skip(process.env[FIXTURE_ENV] !== '1', `set ${FIXTURE_ENV}=1 explicitly`)
  test.setTimeout(900_000)
  const repoRoot = process.cwd()
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), `freshell-managed-update-${randomUUID()}-`))
  const openCodeFixtureWorkspace = path.join(fixtureRoot, 'workspace')
  const providerFixtureHome = path.join(fixtureRoot, 'provider-home')
  const codexFixtureBin = path.join(openCodeFixtureWorkspace, 'bin')
  const fakeOpenCode = path.join(openCodeFixtureWorkspace, 'fake-opencode-terminal.mjs')
  const task6FakeOpenCode = path.join(openCodeFixtureWorkspace, 'task6-fake-opencode.mjs')
  let ownedRig: ManagedRuntimeBrowserRig | undefined
  let closeOwnedContext: (() => Promise<void>) | undefined
  try {
    fs.chmodSync(fixtureRoot, 0o755)
    fs.mkdirSync(openCodeFixtureWorkspace, { mode: 0o755 })
    fs.chmodSync(openCodeFixtureWorkspace, 0o755)
    fs.mkdirSync(providerFixtureHome, { mode: 0o700 })
    fs.mkdirSync(path.join(providerFixtureHome, '.codex'), { mode: 0o700 })
    // The managed terminal executes as an unprivileged user inside the soul
    // container. Stage only the fake executable into a readable temporary
    // workspace so it can run without access to the host user's home. Give the
    // fixture its own provider HOME, with an empty Codex root for Freshcodex;
    // host OpenCode settings and native stores must not seed this provider-free
    // test's managed provider preparation.
    fs.copyFileSync(path.join(repoRoot, 'test/e2e-browser/fixtures/fake-opencode-terminal.mjs'), fakeOpenCode, fs.constants.COPYFILE_EXCL)
    fs.chmodSync(fakeOpenCode, 0o555)
    fs.writeFileSync(task6FakeOpenCode, [
      '#!/usr/bin/env node',
      'process.env.FAKE_OPENCODE_ACTIVITY_SERVER = "1"',
      'process.env.FAKE_OPENCODE_NATIVE_IDENTITY_SIGNAL = "1"',
      'await import("./fake-opencode-terminal.mjs")',
      '',
    ].join('\n'), { mode: 0o555 })
    fs.chmodSync(task6FakeOpenCode, 0o555)
    const fakeCodex = await installDualRoleCodexCli(
      codexFixtureBin,
      path.join(repoRoot, 'test/e2e-browser/fixtures/fake-codex-terminal.mjs'),
      {
        FAKE_CODEX_TERMINAL_PARITY_STARTUP: '1',
        FAKE_CODEX_TERMINAL_REPEAT_TURNS: '1',
      },
    )
    const rig = new ManagedRuntimeBrowserRig(repoRoot, 3, {
      CODEX_CMD: fakeCodex, OPENCODE_CMD: task6FakeOpenCode,
    }, {
      FRESHELL_RUNTIME_OBSERVER_INTERVAL_MS: '250',
    }, 'test', {
      enabledProviders: ['codex', 'opencode'],
      freshAgentModes: ['freshcodex', 'freshopencode'],
      fixtureFreshAgentModes: ['freshcodex', 'freshopencode'],
      providerSettings: { freshcodex: {}, freshopencode: {} }, providerFreeFixture: true,
    }, providerFixtureHome)
    ownedRig = rig
    rig.runtime.allowOwnedWorkspaceRoot(openCodeFixtureWorkspace)
    rig.runtime.recordLifecycle('task6.opencode_fixture_workspace.prepared', {
      path: openCodeFixtureWorkspace, executable: fakeOpenCode, executableMode: '0555',
      codexExecutable: fakeCodex,
      workspaceMode: (fs.statSync(openCodeFixtureWorkspace).mode & 0o7777).toString(8).padStart(4, '0'),
    })
    rig.runtime.recordLifecycle('task6.provider_fixture_home.prepared', {
      path: providerFixtureHome, homeMode: '0700', codexHomeMode: '0700', isolatedFromHostProviderRoots: true,
    })
    rig.requestManagedUpdateClientFixture()
    const completedTurnCounts = new Map<string, number>()
    const maintenanceFrames: Record<string, unknown>[] = []
    const info = await rig.start()
    const ownedBrowser = await createFreshE2ePage(browser, info)
    closeOwnedContext = () => ownedBrowser.context.close()
    const page = ownedBrowser.page
    page.on('websocket', socket => socket.on('framereceived', frame => {
      try {
        const message = JSON.parse(String(frame.payload))
        const event = message.type === 'freshAgent.event' ? message.event : message
        if (event?.type === 'freshAgent.turn.complete' && typeof message.sessionId === 'string') {
          completedTurnCounts.set(message.sessionId, (completedTurnCounts.get(message.sessionId) ?? 0) + 1)
        }
        if (message.type === 'freshAgent.create.failed' || message.type === 'freshAgent.created') {
          maintenanceFrames.push({ type: message.type, requestId: message.requestId, code: message.code, message: message.message })
        }
      } catch { /* unrelated or non-JSON websocket frame */ }
    }))
    page.on('websocket', socket => socket.on('framesent', frame => {
      try {
        const message = JSON.parse(String(frame.payload))
        if (message.type === 'freshAgent.create') {
          maintenanceFrames.push({ type: message.type, requestId: message.requestId, sessionType: message.sessionType })
        }
      } catch { /* unrelated or non-JSON websocket frame */ }
    }))
    await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
    const harness = new TestHarness(page)
    const terminal = new TerminalHelper(page)
    await harness.waitForHarness()
    await harness.waitForConnection()

    // The held admission path is an ordinary Fresh Agent picker create. The
    // failure must be visible and retryable, then the same pane must succeed.
    await page.keyboard.press('Alt+t')
    let picker = page.getByRole('toolbar', { name: /pane type picker/i }).last()
    await expect(picker).toBeVisible()
    await picker.getByRole('button', { name: 'Freshcodex', exact: true }).click()
    const freshDirectory = page.getByLabel('Starting directory for Freshcodex')
    await freshDirectory.fill(rig.repoRoot)
    const leaseOwner = `browser-maintenance-${Date.now()}`
    const quiesce = await post(info.baseUrl, info.token, '/api/runtime/maintenance/quiesce', {
      ownerId: leaseOwner, leaseDurationMs: 120_000, drainTimeoutMs: 10_000,
    })
    expect(quiesce).toMatchObject({ drained: true, admission: { phase: 'quiesced', activePermits: 0 } })
    const statusResponse = await fetch(`${info.baseUrl}/api/runtime/maintenance/status`, {
      headers: { 'x-auth-token': info.token }, cache: 'no-store',
    })
    expect(statusResponse.status).toBe(200)
    expect(unwrap(await statusResponse.json())).toMatchObject({ phase: 'quiesced', activePermits: 0, leaseOwner })
    const leaseId = quiesce.lease?.leaseId
    expect(typeof leaseId).toBe('string')
    await freshDirectory.press('Enter')
    let latestFreshAgentPanes: unknown[] = []
    const failed = await waitFor('visible retryable coding-agent maintenance refusal', async () => {
      const state = await harness.getState()
      const leaves = Object.entries(state.panes.layouts).flatMap(([tabId, layout]) => allLeaves(layout).map(leaf => ({ tabId, ...leaf })))
      latestFreshAgentPanes = leaves.filter(candidate => candidate.content.kind === 'fresh-agent').map(candidate => ({
        tabId: candidate.tabId, paneId: candidate.id, status: candidate.content.status,
        createRequestId: candidate.content.createRequestId, createError: candidate.content.createError,
      }))
      const leaf = leaves.find(candidate => candidate.content.kind === 'fresh-agent' && candidate.content.status === 'create-failed')
      return leaf ?? null
    }, 20_000).catch(error => {
      throw new Error(`${error instanceof Error ? error.message : String(error)}; panes=${JSON.stringify(latestFreshAgentPanes)}; frames=${JSON.stringify(maintenanceFrames)}`)
    })
    expect(failed.content.createError).toMatchObject({ retryable: true })
    const failedPane = page.locator(`[data-context="fresh-agent"][data-pane-id="${failed.id}"]`)
    await expect(failedPane.getByText(/Host coding-agent starts are temporarily paused for maintenance/)).toBeVisible()
    await expect(failedPane.getByRole('button', { name: 'Retry', exact: true })).toBeVisible()
    await post(info.baseUrl, info.token, '/api/runtime/maintenance/release', { ownerId: leaseOwner, leaseId })
    await failedPane.getByRole('button', { name: 'Retry', exact: true }).click()
    const firstCreated = await waitFor('Freshcodex create after admission release', async () => {
      const leaf = freshAgentLeaf(await harness.getState(), failed.id)
      return leaf?.content.status === 'connected' && leaf.content.sessionId ? leaf : null
    })
    expect(firstCreated.content.sessionType).toBe('freshcodex')
    expect(firstCreated.content.provider).toBe('codex')
    expect(firstCreated.content.createRequestId).not.toBe(failed.content.createRequestId)
    const firstCodexPrompt = 'managed update saved history first turn'
    const freshPane = page.locator(`[data-context="fresh-agent"][data-pane-id="${failed.id}"]`)
    const freshComposer = freshPane.getByRole('textbox', { name: 'Chat message input' })
    await expect(freshComposer).toBeEnabled()
    await freshComposer.fill(firstCodexPrompt)
    await freshPane.getByRole('button', { name: 'Send', exact: true }).click()
    const freshSessionId = firstCreated.content.sessionId as string
    const codexView = await waitFor('Freshcodex native session identity', async () => {
      const view = await rig.runningViewForFreshSession(freshSessionId)
      return view?.nativeSessionId ? view : null
    })
    const codexHandle = rig.exactRuntimeHandle(codexView)
    await waitFor('first deterministic Freshcodex completion', async () => {
      const state = await rig.fixtureNativeState(codexHandle)
      return state.dispatchCount === 1 && state.completionCount === 1 ? state : null
    })
    const freshBeforeLeaf = await waitFor('native Freshcodex browser session reference', async () => {
      const leaf = freshAgentLeaf(await harness.getState(), failed.id)
      return leaf?.content.sessionRef?.sessionId === codexView.nativeSessionId ? leaf : null
    })
    const freshBefore = {
      tabId: freshBeforeLeaf.tabId, paneId: freshBeforeLeaf.id,
      createRequestId: freshBeforeLeaf.content.createRequestId, sessionId: freshBeforeLeaf.content.sessionId,
      sessionType: freshBeforeLeaf.content.sessionType, provider: freshBeforeLeaf.content.provider,
      sessionRef: freshBeforeLeaf.content.sessionRef,
    }
    expect(freshBefore.sessionRef).toEqual({ provider: 'codex', sessionId: codexView.nativeSessionId })
    const freshRuntimeBefore = runtimeIdentity(codexView)

    // Create a Codex terminal through the ordinary picker. The dual-role
    // fixture routes the app-server sidecar and terminal CLI without network
    // access, and records each turn under the same native thread identity.
    await page.keyboard.press('Alt+t')
    picker = page.getByRole('toolbar', { name: /pane type picker/i }).last()
    await expect(picker).toBeVisible()
    await picker.getByRole('button', { name: /^Codex CLI$/i }).click()
    const codexDirectory = page.getByRole('combobox', { name: /Starting directory for Codex CLI/i })
    await expect(codexDirectory).toBeVisible()
    await codexDirectory.fill(openCodeFixtureWorkspace)
    await codexDirectory.press('Enter')
    const codexTerminalLeaf = await waitFor('ordinary Codex terminal pane', async () => {
      const state = await harness.getState()
      const tabId = state.tabs.activeTabId
      const leaf = allLeaves(state.panes.layouts[tabId]).find(candidate => candidate.content.kind === 'terminal'
        && candidate.content.mode === 'codex' && candidate.content.terminalId)
      return leaf ? { tabId, ...leaf } : null
    })
    const codexTerminalId = codexTerminalLeaf.content.terminalId as string
    await terminal.waitForOutput('codex> ', { timeout: 90_000, terminalId: codexTerminalId })
    const firstCodexTerminalPrompt = 'codex terminal initial update history turn'
    const codexTerminalSurface = page.locator(`[data-context="terminal"][data-pane-id="${codexTerminalLeaf.id}"] .xterm`)
    await codexTerminalSurface.click()
    await page.keyboard.insertText(firstCodexTerminalPrompt)
    await codexTerminalSurface.click()
    await page.keyboard.press('Enter')
    await terminal.waitForOutput('codex: session', { timeout: 90_000, terminalId: codexTerminalId })
    const codexTerminalView = await waitFor('Codex terminal native session in supervisor inventory', async () => {
      const view = await rig.runningViewForTerminal(codexTerminalId)
      return view?.nativeSessionId ? view : null
    })
    expect(codexTerminalView.provider).toBe('codex')
    const codexTerminalBeforeLeaf = await waitFor('Codex terminal native session reference in the pane', async () => {
      const leaf = terminalLeaf(await harness.getState(), codexTerminalLeaf.id)
      return leaf?.content.sessionRef?.sessionId === codexTerminalView.nativeSessionId ? leaf : null
    })
    const codexTerminalBefore = {
      tabId: codexTerminalBeforeLeaf.tabId, paneId: codexTerminalBeforeLeaf.id,
      createRequestId: codexTerminalBeforeLeaf.content.createRequestId,
      terminalId: codexTerminalBeforeLeaf.content.terminalId,
      sessionRef: codexTerminalBeforeLeaf.content.sessionRef,
    }
    expect(codexTerminalBefore.sessionRef).toEqual({ provider: 'codex', sessionId: codexTerminalView.nativeSessionId })
    const codexTerminalRuntimeBefore = runtimeIdentity(codexTerminalView)
    const codexRolloutContains = async (prompt: string) => JSON.parse(await rig.ownedProviderExec(
      codexTerminalView.containerId!, [
        'node', '-e',
        "const fs=require('node:fs');const path=require('node:path');const root='/home/freshell/provider/.codex/sessions';const files=[];function walk(p){for(const e of fs.readdirSync(p,{withFileTypes:true})){const q=path.join(p,e.name);if(e.isDirectory())walk(q);else if(e.isFile()&&e.name.endsWith('.jsonl'))files.push(q)}}try{walk(root)}catch{};let same=[];for(const f of files){let rows=[];try{rows=fs.readFileSync(f,'utf8').split('\\n').filter(Boolean).map(JSON.parse)}catch{};if(rows.some(row=>row.type==='session_meta'&&row.payload?.id===process.argv[1]))same.push(...rows)};console.log(JSON.stringify({sessionFound:same.length>0,promptFound:same.some(row=>row.payload?.message===process.argv[2]||row.payload?.content?.some(item=>item.text===process.argv[2]))}))",
        codexTerminalView.nativeSessionId!, prompt,
      ])) as { sessionFound: boolean; promptFound: boolean }
    expect(await codexRolloutContains(firstCodexTerminalPrompt)).toEqual({ sessionFound: true, promptFound: true })

    // Create FreshOpenCode through the ordinary Fresh Agent picker path.
    await page.keyboard.press('Alt+t')
    picker = page.getByRole('toolbar', { name: /pane type picker/i }).last()
    await expect(picker).toBeVisible()
    await picker.getByRole('button', { name: /^Freshopencode$/i }).click()
    const freshOpenCodeDirectory = page.getByRole('combobox', { name: /Starting directory for Freshopencode/i })
    await expect(freshOpenCodeDirectory).toBeVisible()
    await freshOpenCodeDirectory.fill(openCodeFixtureWorkspace)
    await freshOpenCodeDirectory.press('Enter')
    const freshOpenCodeCreated = await waitFor('ordinary FreshOpenCode pane', async () => {
      const state = await harness.getState()
      const tabId = state.tabs.activeTabId
      const leaf = allLeaves(state.panes.layouts[tabId]).find(candidate => candidate.content.kind === 'fresh-agent'
        && candidate.content.sessionType === 'freshopencode' && candidate.content.provider === 'opencode'
        && candidate.content.status === 'connected' && candidate.content.sessionId)
      return leaf ? { tabId, ...leaf } : null
    })
    const firstFreshOpenCodePrompt = 'freshopencode initial update history turn'
    const freshOpenCodePane = page.locator(`[data-context="fresh-agent"][data-pane-id="${freshOpenCodeCreated.id}"]`)
    const freshOpenCodeComposer = freshOpenCodePane.getByRole('textbox', { name: 'Chat message input' })
    await expect(freshOpenCodeComposer).toBeEnabled()
    await freshOpenCodeComposer.fill(firstFreshOpenCodePrompt)
    await freshOpenCodePane.getByRole('button', { name: 'Send', exact: true }).click()
    const freshOpenCodeSessionId = freshOpenCodeCreated.content.sessionId as string
    const freshOpenCodeView = await waitFor('FreshOpenCode native session identity', async () => {
      const view = await rig.runningViewForFreshSession(freshOpenCodeSessionId)
      return view?.nativeSessionId ? view : null
    })
    expect(freshOpenCodeView).toMatchObject({ provider: 'opencode', freshAgentSessionType: 'freshopencode' })
    const freshOpenCodeHandle = rig.exactRuntimeHandle(freshOpenCodeView)
    await waitFor('first deterministic FreshOpenCode completion', async () => {
      const state = await rig.fixtureNativeState(freshOpenCodeHandle)
      return state.dispatchCount === 1 && state.completionCount === 1 ? state : null
    })
    const freshOpenCodeBeforeLeaf = await waitFor('FreshOpenCode native session reference in the pane', async () => {
      const leaf = freshAgentLeaf(await harness.getState(), freshOpenCodeCreated.id)
      return leaf?.content.sessionRef?.sessionId === freshOpenCodeView.nativeSessionId ? leaf : null
    })
    const freshOpenCodeBefore = {
      tabId: freshOpenCodeBeforeLeaf.tabId, paneId: freshOpenCodeBeforeLeaf.id,
      createRequestId: freshOpenCodeBeforeLeaf.content.createRequestId,
      sessionId: freshOpenCodeBeforeLeaf.content.sessionId,
      sessionType: freshOpenCodeBeforeLeaf.content.sessionType,
      provider: freshOpenCodeBeforeLeaf.content.provider,
      sessionRef: freshOpenCodeBeforeLeaf.content.sessionRef,
    }
    expect(freshOpenCodeBefore.sessionRef).toEqual({ provider: 'opencode', sessionId: freshOpenCodeView.nativeSessionId })
    const freshOpenCodeRuntimeBefore = runtimeIdentity(freshOpenCodeView)

    // Create an OpenCode terminal through the normal picker and TerminalView.
    await page.keyboard.press('Alt+t')
    picker = page.getByRole('toolbar', { name: /pane type picker/i }).last()
    await expect(picker).toBeVisible()
    await picker.getByRole('button', { name: /^OpenCode$/i }).click()
    const openCodeDirectory = page.getByRole('combobox', { name: /Starting directory for OpenCode/i })
    await expect(openCodeDirectory).toBeVisible()
    await openCodeDirectory.fill(openCodeFixtureWorkspace)
    await openCodeDirectory.press('Enter')
    const openCodePane = await waitFor('local OpenCode terminal pane/create request', async () => {
      const state = await harness.getState()
      const tabId = state.tabs.activeTabId
      const leaf = allLeaves(state.panes.layouts[tabId]).find(candidate => candidate.content.kind === 'terminal'
        && candidate.content.mode === 'opencode' && typeof candidate.content.createRequestId === 'string')
      return leaf ? { tabId, paneId: leaf.id } : null
    })
    const openCodeLeaf = await waitFor('ordinary OpenCode terminalId', async () => {
      const state = await harness.getState()
      const leaf = allLeaves(state.panes.layouts[openCodePane.tabId]).find(candidate => candidate.id === openCodePane.paneId
        && candidate.content.kind === 'terminal' && candidate.content.mode === 'opencode'
        && typeof candidate.content.terminalId === 'string')
      return leaf ? { tabId: openCodePane.tabId, ...leaf } : null
    })
    const openCodeTerminalId = openCodeLeaf.content.terminalId as string
    expect(openCodeLeaf.content.createRequestId).toBeTruthy()
    await terminal.waitForOutput('opencode>', { timeout: 90_000, terminalId: openCodeTerminalId })
    const openCodeBeforeFirstPrompt = await waitFor(
      'OpenCode managed terminal attached before its first native session exists',
      async () => {
        const view = await rig.runningViewForTerminal(openCodeTerminalId)
        return view && !view.nativeSessionId ? view : null
      },
    )
    expect(openCodeBeforeFirstPrompt.terminalId).toBe(openCodeTerminalId)
    expect(openCodeBeforeFirstPrompt.provider).toBe('opencode')
    expect(openCodeBeforeFirstPrompt.nativeSessionId).toBeFalsy()

    const firstOpenCodePrompt = 'opencode initial update history turn'
    const openCodeTerminalSurface = page.locator(`[data-context="terminal"][data-pane-id="${openCodeLeaf.id}"] .xterm`)
    await openCodeTerminalSurface.click()
    await page.keyboard.insertText(firstOpenCodePrompt)
    await openCodeTerminalSurface.click()
    await page.keyboard.press('Enter')
    await terminal.waitForOutput('opencode: session', { timeout: 90_000, terminalId: openCodeTerminalId })
    const openCodeView = await waitFor('OpenCode native session in supervisor inventory', async () => {
      const view = await rig.runningViewForTerminal(openCodeTerminalId)
      return view?.nativeSessionId ? view : null
    })
    expect(openCodeView.provider).toBe('opencode')
    const openCodeHandle = rig.exactRuntimeHandle(openCodeView)
    const openCodeBeforeLeaf = await waitFor('OpenCode sessionRef in the ordinary terminal pane', async () => {
      const leaf = terminalLeaf(await harness.getState(), openCodeLeaf.id)
      return leaf?.content.sessionRef?.sessionId === openCodeView.nativeSessionId ? leaf : null
    })
    const openCodeBefore = {
      tabId: openCodeBeforeLeaf.tabId, paneId: openCodeBeforeLeaf.id,
      createRequestId: openCodeBeforeLeaf.content.createRequestId, terminalId: openCodeBeforeLeaf.content.terminalId,
      sessionRef: openCodeBeforeLeaf.content.sessionRef,
    }
    expect(openCodeBefore.sessionRef).toEqual({ provider: 'opencode', sessionId: openCodeView.nativeSessionId })
    const openCodeRuntimeBefore = runtimeIdentity(openCodeView)
    rig.runtime.recordLifecycle('task6.managed_identity.before_web_update', {
      freshCodex: { ui: freshBefore, runtime: freshRuntimeBefore },
      codexTerminal: { ui: codexTerminalBefore, runtime: codexTerminalRuntimeBefore },
      freshOpenCode: { ui: freshOpenCodeBefore, runtime: freshOpenCodeRuntimeBefore },
      openCode: { ui: openCodeBefore, runtime: openCodeRuntimeBefore },
    })
    const nativeMessages = async () => JSON.parse(await rig.ownedProviderExec(openCodeView.containerId!, [
      'node', '-e',
      "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('/home/freshell/provider/.local/share/opencode/opencode.db');const rows=db.prepare('SELECT m.data AS message_data,p.data AS part_data FROM message m LEFT JOIN part p ON p.message_id=m.id WHERE m.session_id=? ORDER BY m.time_created,p.id').all(process.argv[1]);console.log(JSON.stringify(rows.map(row=>({role:JSON.parse(row.message_data).role,text:row.part_data?JSON.parse(row.part_data).text:null}))))",
      openCodeView.nativeSessionId!,
    ])) as Array<{ role: string; text: string | null }>
    expect((await nativeMessages()).some(message => message.text === firstOpenCodePrompt)).toBe(true)

    const clientMeta = page.locator('meta[name="managed-update-fixture"]')
    await expect(clientMeta).toHaveAttribute('content', 'web-v1')
    const readyBefore = await harness.getLastReadyAt()
    const readinessBefore = await captureAuthenticatedReadiness(rig)
    rig.runtime.recordLifecycle('task6.readiness.before_client_update', readinessBefore)
    expect(readinessBefore).toMatchObject({
      status: 200,
      readinessShapePresent: true,
      identityMatchesSupervisor: true,
      initialScanState: 'complete',
      blockedSubsystemCount: 0,
      paneOwnership: {
        complete: true,
        paneCount: 4,
        paneOwnershipCounts: { durable: 4 },
        paneKindCounts: { terminal: 2, 'fresh-agent': 2 },
        paneProviderCounts: { codex: 2, opencode: 2 },
        unattachedCount: 0,
      },
    })
    const report = await rig.runManagedUpdateFixture('client', { liveWeb: true })
    const refusalCategory = report.operatorLines.some(line => line.includes('Host-managed, unknown, or unattached coding work prevents shutdown'))
      ? 'coding_work_ownership_blocker'
      : report.operatorLines.some(line => line.includes('safe to stop'))
        ? 'pane_census_not_ready'
        : report.operatorLines.some(line => line.includes('initial scan'))
          ? 'runtime_scan_incomplete'
          : report.operatorLines.some(line => line.includes('Authenticated live runtime readiness'))
            ? 'authenticated_runtime_readiness_unavailable'
            : report.operatorLines.some(line => line.includes('supervisor'))
              ? 'supervisor_identity_mismatch_or_unavailable' : 'none_or_unclassified'
    const blockerKinds = report.operatorLines.flatMap(line => [...line.matchAll(/pane \S+ \(([^,]+), (host-managed|unknown)\)/g)]
      .map(match => ({ kind: match[1], ownership: match[2] })))
    rig.runtime.recordLifecycle('task6.update_client_readiness_result', {
      exitCode: report.exitCode,
      refusalCategory,
      blockerKinds,
      updateFailures: report.jsonlRows.filter(event => event.event === 'update.failed').map(event => ({
        phase: event.phase, error_code: event.error_code,
      })),
    })
    expect(report.exitCode).toBe(0)
    expect(report.approvalRead).toBeNull()
    expect(report.supervisorAfter).toEqual(report.supervisorBefore)
    expect(report.effects).toContain('stop:freshell-rust.service')
    expect(report.effects).toContain('start:freshell-rust.service')
    expect(report.effects.some(effect => /(?:stop|start|restart):freshell-supervisor\.service$/.test(effect))).toBe(false)
    expect(report.clientDigestAfter).not.toBe(report.clientDigestBefore)
    expect(report.timeline).toContain('operator:default-reminder')
    expect(report.timeline.indexOf('operator:default-reminder')).toBeLessThan(report.timeline.indexOf('handoff'))
    const completed = report.jsonlRows.find(event => event.event === 'update.completed')
    expect(completed).toMatchObject({ mode: 'client', reminder: expect.stringContaining('supervisor and managed coding sessions were not restarted') })
    expect(report.operatorLines.some(line => line.includes('Reset-capable updates require the exact word APPROVED.'))).toBe(true)
    const freshCodexAfterUpdate = report.viewsAfter.find(view => view.soulId === codexView.soulId)
    const codexTerminalAfterUpdate = report.viewsAfter.find(view => view.soulId === codexTerminalView.soulId)
    const freshOpenCodeAfterUpdate = report.viewsAfter.find(view => view.soulId === freshOpenCodeView.soulId)
    const openCodeAfterUpdate = report.viewsAfter.find(view => view.soulId === openCodeView.soulId)
    expect(freshCodexAfterUpdate).toMatchObject(freshRuntimeBefore)
    expect(codexTerminalAfterUpdate).toMatchObject(codexTerminalRuntimeBefore)
    expect(freshOpenCodeAfterUpdate).toMatchObject(freshOpenCodeRuntimeBefore)
    expect(openCodeAfterUpdate).toMatchObject(openCodeRuntimeBefore)
    rig.runtime.recordLifecycle('task6.managed_identity.after_web_update', {
      freshCodex: { ui: freshBefore, runtime: freshCodexAfterUpdate && runtimeIdentity(freshCodexAfterUpdate) },
      codexTerminal: { ui: codexTerminalBefore, runtime: codexTerminalAfterUpdate && runtimeIdentity(codexTerminalAfterUpdate) },
      freshOpenCode: { ui: freshOpenCodeBefore, runtime: freshOpenCodeAfterUpdate && runtimeIdentity(freshOpenCodeAfterUpdate) },
      openCode: { ui: openCodeBefore, runtime: openCodeAfterUpdate && runtimeIdentity(openCodeAfterUpdate) },
    })

    await page.reload({ waitUntil: 'domcontentloaded' })
    await harness.waitForHarness()
    await harness.waitForConnectionAfter(readyBefore, 90_000)
    await expect(page.locator('meta[name="managed-update-fixture"]')).toHaveAttribute('content', /^web-v2-/)
    const reattachedFresh = await waitFor('same Freshcodex pane after client reload', async () => freshAgentLeaf(await harness.getState(), freshBefore.paneId))
    expect({ tabId: reattachedFresh.tabId, paneId: reattachedFresh.id,
      createRequestId: reattachedFresh.content.createRequestId, sessionId: reattachedFresh.content.sessionId,
      sessionType: reattachedFresh.content.sessionType, provider: reattachedFresh.content.provider,
      sessionRef: reattachedFresh.content.sessionRef }).toEqual(freshBefore)
    const reattachedTerminal = await waitFor('same OpenCode terminal identity after client reload', async () => {
      const leaf = terminalLeaf(await harness.getState(), openCodeBefore.paneId)
      return leaf?.tabId === openCodeBefore.tabId
        && leaf.content.createRequestId === openCodeBefore.createRequestId
        && leaf.content.terminalId === openCodeBefore.terminalId
        && leaf.content.sessionRef?.provider === 'opencode'
        && leaf.content.sessionRef.sessionId === openCodeBefore.sessionRef.sessionId
        ? leaf : null
    })
    const reattachedCodexTerminal = await waitFor('same Codex terminal after client reload', async () => terminalLeaf(await harness.getState(), codexTerminalBefore.paneId))
    const reattachedFreshOpenCode = await waitFor('same FreshOpenCode pane after client reload', async () => freshAgentLeaf(await harness.getState(), freshOpenCodeBefore.paneId))
    expect({ tabId: reattachedTerminal.tabId, paneId: reattachedTerminal.id,
      createRequestId: reattachedTerminal.content.createRequestId, terminalId: reattachedTerminal.content.terminalId,
      sessionRef: reattachedTerminal.content.sessionRef }).toEqual(openCodeBefore)
    expect({ tabId: reattachedCodexTerminal.tabId, paneId: reattachedCodexTerminal.id,
      createRequestId: reattachedCodexTerminal.content.createRequestId, terminalId: reattachedCodexTerminal.content.terminalId,
      sessionRef: reattachedCodexTerminal.content.sessionRef }).toEqual(codexTerminalBefore)
    expect({ tabId: reattachedFreshOpenCode.tabId, paneId: reattachedFreshOpenCode.id,
      createRequestId: reattachedFreshOpenCode.content.createRequestId, sessionId: reattachedFreshOpenCode.content.sessionId,
      sessionType: reattachedFreshOpenCode.content.sessionType, provider: reattachedFreshOpenCode.content.provider,
      sessionRef: reattachedFreshOpenCode.content.sessionRef }).toEqual(freshOpenCodeBefore)
    const reattachedCodexRuntime = runtimeIdentity(await waitFor(
      'same Freshcodex managed allocation after web-only update', () => rig.runningViewForFreshSession(freshSessionId),
    ))
    const reattachedCodexTerminalRuntime = runtimeIdentity(await waitFor(
      'same Codex terminal managed allocation after web-only update', () => rig.runningViewForTerminal(codexTerminalId),
    ))
    const reattachedFreshOpenCodeRuntime = runtimeIdentity(await waitFor(
      'same FreshOpenCode managed allocation after web-only update', () => rig.runningViewForFreshSession(freshOpenCodeSessionId),
    ))
    const reattachedOpenCodeRuntime = runtimeIdentity(await waitFor(
      'same OpenCode managed allocation after web-only update', () => rig.runningViewForTerminal(openCodeTerminalId),
    ))
    expect(reattachedCodexRuntime).toEqual(freshRuntimeBefore)
    expect(reattachedCodexTerminalRuntime).toEqual(codexTerminalRuntimeBefore)
    expect(reattachedFreshOpenCodeRuntime).toEqual(freshOpenCodeRuntimeBefore)
    expect(reattachedOpenCodeRuntime).toEqual(openCodeRuntimeBefore)
    rig.runtime.recordLifecycle('task6.managed_identity.after_client_reload', {
      freshCodex: { ui: { tabId: reattachedFresh.tabId, paneId: reattachedFresh.id,
        createRequestId: reattachedFresh.content.createRequestId, sessionId: reattachedFresh.content.sessionId,
        sessionType: reattachedFresh.content.sessionType, provider: reattachedFresh.content.provider,
        sessionRef: reattachedFresh.content.sessionRef }, runtime: reattachedCodexRuntime },
      codexTerminal: { ui: { tabId: reattachedCodexTerminal.tabId, paneId: reattachedCodexTerminal.id,
        createRequestId: reattachedCodexTerminal.content.createRequestId, terminalId: reattachedCodexTerminal.content.terminalId,
        sessionRef: reattachedCodexTerminal.content.sessionRef }, runtime: reattachedCodexTerminalRuntime },
      freshOpenCode: { ui: { tabId: reattachedFreshOpenCode.tabId, paneId: reattachedFreshOpenCode.id,
        createRequestId: reattachedFreshOpenCode.content.createRequestId, sessionId: reattachedFreshOpenCode.content.sessionId,
        sessionType: reattachedFreshOpenCode.content.sessionType, provider: reattachedFreshOpenCode.content.provider,
        sessionRef: reattachedFreshOpenCode.content.sessionRef }, runtime: reattachedFreshOpenCodeRuntime },
      openCode: { ui: { tabId: reattachedTerminal.tabId, paneId: reattachedTerminal.id,
        createRequestId: reattachedTerminal.content.createRequestId, terminalId: reattachedTerminal.content.terminalId,
        sessionRef: reattachedTerminal.content.sessionRef }, runtime: reattachedOpenCodeRuntime },
    })

    const secondCodexPrompt = 'managed update same native session follow-up'
    await page.locator(`[data-context="tab"][data-tab-id="${freshBefore.tabId}"]`).click()
    const reloadedFreshPane = page.locator(`[data-context="fresh-agent"][data-pane-id="${freshBefore.paneId}"]`)
    await expect(reloadedFreshPane.getByText(firstCodexPrompt)).toBeVisible()
    const composer = reloadedFreshPane.getByRole('textbox', { name: 'Chat message input' })
    await expect(composer).toBeEnabled()
    await composer.fill(secondCodexPrompt)
    await reloadedFreshPane.getByRole('button', { name: 'Send', exact: true }).click()
    await waitFor('second deterministic Freshcodex completion on same native session', async () => {
      const state = await rig.fixtureNativeState(codexHandle)
      return state.dispatchCount === 2 && state.completionCount === 2 ? state : null
    })
    await waitFor('both Freshcodex completion events on the same native session', async () => (
      (completedTurnCounts.get(codexView.nativeSessionId!) ?? 0) >= 2 ? completedTurnCounts.get(codexView.nativeSessionId!)! : null
    ))
    expect(completedTurnCounts.get(codexView.nativeSessionId!)).toBeGreaterThanOrEqual(2)

    const secondFreshOpenCodePrompt = 'freshopencode follow up after web-only update'
    await page.locator(`[data-context="tab"][data-tab-id="${freshOpenCodeBefore.tabId}"]`).click()
    const reloadedFreshOpenCodePane = page.locator(`[data-context="fresh-agent"][data-pane-id="${freshOpenCodeBefore.paneId}"]`)
    await expect(reloadedFreshOpenCodePane.getByText(firstFreshOpenCodePrompt)).toBeVisible()
    const freshOpenCodeFollowUpComposer = reloadedFreshOpenCodePane.getByRole('textbox', { name: 'Chat message input' })
    await expect(freshOpenCodeFollowUpComposer).toBeEnabled()
    await freshOpenCodeFollowUpComposer.fill(secondFreshOpenCodePrompt)
    await reloadedFreshOpenCodePane.getByRole('button', { name: 'Send', exact: true }).click()
    await waitFor('second deterministic FreshOpenCode completion on same native session', async () => {
      const state = await rig.fixtureNativeState(freshOpenCodeHandle)
      return state.dispatchCount === 2 && state.completionCount === 2 ? state : null
    })
    const finalFreshOpenCodeView = await waitFor('same FreshOpenCode allocation after follow-up', () =>
      rig.runningViewForFreshSession(freshOpenCodeSessionId))
    expect(runtimeIdentity(finalFreshOpenCodeView)).toEqual(freshOpenCodeRuntimeBefore)

    const secondCodexTerminalPrompt = 'codex terminal follow up after web-only update'
    await page.locator(`[data-context="tab"][data-tab-id="${codexTerminalBefore.tabId}"]`).click()
    const reloadedCodexTerminalSurface = page.locator(`[data-context="terminal"][data-pane-id="${codexTerminalBefore.paneId}"] .xterm`)
    await reloadedCodexTerminalSurface.click()
    await page.keyboard.insertText(secondCodexTerminalPrompt)
    await reloadedCodexTerminalSurface.click()
    await page.keyboard.press('Enter')
    await terminal.waitForOutput(`FAKE_CODEX_REPLY:${codexTerminalView.nativeSessionId}:${secondCodexTerminalPrompt.toUpperCase()}`,
      { timeout: 90_000, terminalId: codexTerminalId })
    expect(await codexRolloutContains(secondCodexTerminalPrompt)).toEqual({ sessionFound: true, promptFound: true })
    const finalCodexTerminalView = await waitFor('same Codex terminal allocation after follow-up', () =>
      rig.runningViewForTerminal(codexTerminalId))
    expect(runtimeIdentity(finalCodexTerminalView)).toEqual(codexTerminalRuntimeBefore)

    await page.locator(`[data-context="tab"][data-tab-id="${openCodeBefore.tabId}"]`).click()
    const repeatTurn = 'opencode follow up after web-only update'
    await openCodeTerminalSurface.click()
    await page.keyboard.insertText(repeatTurn)
    await openCodeTerminalSurface.click()
    await page.keyboard.press('Enter')
    await terminal.waitForOutput(`FAKE_OPENCODE_REPLY:${repeatTurn.toUpperCase()}`, { timeout: 90_000, terminalId: openCodeTerminalId })
    const finalMessages = await nativeMessages()
    expect(finalMessages.some(message => message.text === firstOpenCodePrompt)).toBe(true)
    expect(finalMessages.some(message => message.text === repeatTurn)).toBe(true)
    expect(finalMessages.some(message => message.role === 'assistant' && message.text === `FAKE_OPENCODE_REPLY:${repeatTurn.toUpperCase()}`)).toBe(true)
    const finalOpenCodeView = await waitFor('same OpenCode managed allocation after follow-up', () => rig.runningViewForTerminal(openCodeTerminalId))
    expect(runtimeIdentity(finalOpenCodeView)).toEqual(runtimeIdentity(openCodeView))

    // A pre-existing host-owned pane is reported without stopping its process.
    const host = await rig.runManagedUpdateFixture('client', { hostPane: 'before-build' })
    expect(host.exitCode).toBe(2)
    expect(host.operatorLines.join('\n')).toMatch(/host-agent-pane-17.*host-managed/)
    expect(host.effects.some(effect => effect.startsWith('build:') || effect.startsWith('stop:') || effect.startsWith('soul-stop:'))).toBe(false)
    expect(host.hostPaneProcess?.remainsRunning).toBe(true)
    expect(host.hostPaneProcess?.response).toMatch(/^host-agent-pong:ping-/)

    // A host-owned pane arriving during artifact preparation is found by the
    // final census. The updater refuses at maintenance_quiesce before stopping
    // either service, and the host process remains usable.
    const race = await rig.runManagedUpdateFixture('client', { hostPane: 'during-build' })
    expect(race.exitCode).toBe(2)
    expect(race.operatorLines.join('\n')).toMatch(/host-agent-pane-17.*host-managed/)
    expect(race.effects).toContain('build:client')
    expect(race.effects).not.toContain('stop:freshell-rust.service')
    expect(race.effects).not.toContain('stop:freshell-supervisor.service')
    expect(race.events).toContainEqual(expect.objectContaining({
      event: 'update.failed', phase: 'maintenance_quiesce', error_code: 'preflight_refused',
      attempted_prefix: [], maintenance_gate_state: 'open',
    }))
    expect(race.hostPaneProcess?.remainsRunning).toBe(true)
    expect(race.hostPaneProcess?.response).toMatch(/^host-agent-pong:ping-/)
    expect(race.postReleaseCreateAccepted).toBe(true)
  } finally {
    try {
      await closeOwnedContext?.().catch(() => {})
      if (ownedRig) {
        const cleanup = await ownedRig.stop()
        expect(cleanup.ok, cleanup.errors.join('\n')).toBe(true)
      }
    } finally {
      fs.rmSync(fixtureRoot, { recursive: true, force: true })
      if (ownedRig) ownedRig.runtime.recordLifecycle('task6.fixture_workspaces.removed', {
        root: fixtureRoot, workspace: openCodeFixtureWorkspace, providerHome: providerFixtureHome,
      })
    }
  }
})

test('managed update modes - all reopens on updated runtime and restores primary view', async () => {
  test.skip(process.env[FIXTURE_ENV] !== '1', `set ${FIXTURE_ENV}=1 explicitly`)
  const rig = new ManagedRuntimeBrowserRig(process.cwd(), 3, {}, {}, 'test', {
    enabledProviders: [], freshAgentModes: ['freshcodex'], fixtureFreshAgentModes: ['freshcodex'],
    providerSettings: { freshcodex: {} },
  })
  const report = await rig.runManagedUpdateFixture('all')
  expect(report.exitCode).toBe(0)
  expect(report.approvalRead).toBe('APPROVED')
  expect(report.approvalConsumed).toBe(true)
  expect(report.supervisorAfter.installationId).toBe(report.supervisorBefore.installationId)
  expect(report.supervisorAfter.controlEpoch).toBeGreaterThan(report.supervisorBefore.controlEpoch)
  expect(report.webVersionAfter).not.toBe(report.webVersionBefore)
  expect(report.clientDigestAfter).not.toBe(report.clientDigestBefore)
  expect(report.effects).toContain('stop:freshell-supervisor.service')
  expect(report.effects).toContain('start:freshell-supervisor.service')
  expect(report.reopenCalls).toHaveLength(2)
  for (const previous of report.viewsBefore) {
    const reopened = report.viewsAfter.find(view => view.soulId === previous.soulId)
    expect(reopened).toBeTruthy()
    expect(reopened!.incarnationId).not.toBe(previous.incarnationId)
    expect(reopened).toMatchObject({ soulId: previous.soulId, provider: previous.provider,
      providerStoreId: previous.providerStoreId, nativeSessionId: previous.nativeSessionId,
      historyMessageCount: previous.historyMessageCount, desiredState: 'running', launchState: 'running' })
  }
  for (const call of report.reopenCalls) {
    expect(call.requestId).toMatch(/^fixture-reopen-/)
    expect(call.primaryViewVisibleImmediately).toBe(true)
    expect(call.candidate.conversation).toMatchObject({ kind: expect.any(String) })
  }
  expect(report.events.filter(event => event.event === 'update.reopen_result')).toEqual(
    expect.arrayContaining([expect.objectContaining({ outcome: 'reopened' }), expect.objectContaining({ outcome: 'reopened' })]),
  )
  expect(report.jsonlRows).toContainEqual(expect.objectContaining({ event: 'update.completed', mode: 'all', reopened_count: 2 }))

  const refused = await new ManagedRuntimeBrowserRig(process.cwd(), 3, {}, {}, 'test', {
    enabledProviders: [], freshAgentModes: ['freshcodex'], fixtureFreshAgentModes: ['freshcodex'],
    providerSettings: { freshcodex: {} },
  }).runManagedUpdateFixture('all', { approvalLine: 'APPROVED ' })
  expect(refused.exitCode).toBe(2)
  expect(refused.approvalRead).toBe('APPROVED ')
  expect(refused.approvalConsumed).toBe(false)
  expect(refused.effects.some(effect => effect.startsWith('build:') || effect.startsWith('stop:') || effect.startsWith('soul-stop:'))).toBe(false)
})

test('managed update modes - durable-only preserves old web and client', async () => {
  test.skip(process.env[FIXTURE_ENV] !== '1', `set ${FIXTURE_ENV}=1 explicitly`)
  const rig = new ManagedRuntimeBrowserRig(process.cwd(), 3, {}, {}, 'test', {
    enabledProviders: [], freshAgentModes: ['freshcodex'], fixtureFreshAgentModes: ['freshcodex'],
    providerSettings: { freshcodex: {} },
  })
  const report = await rig.runManagedUpdateFixture('durable-only')
  expect(report.exitCode).toBe(0)
  expect(report.approvalRead).toBe('APPROVED')
  expect(report.approvalConsumed).toBe(true)
  expect(report.webVersionAfter).toBe(report.webVersionBefore)
  expect(report.callbackShapeAfter).toBe(report.callbackShapeBefore)
  expect(report.clientDigestAfter).toBe(report.clientDigestBefore)
  expect(report.supervisorAfter.controlEpoch).toBeGreaterThan(report.supervisorBefore.controlEpoch)
  expect(report.effects).toContain('stop:freshell-supervisor.service')
  expect(report.effects).toContain('start:freshell-supervisor.service')
  expect(report.effects).not.toContain('client-swap')
  expect(report.reopenCalls).toHaveLength(2)
  expect(report.reopenCalls.every(call => call.candidate.expectedIntentRevision > 0
    && call.candidate.conversation.kind.length > 0 && report.webVersionAfter === report.webVersionBefore)).toBe(true)
  expect(report.jsonlRows).toContainEqual(expect.objectContaining({ event: 'update.completed', mode: 'durable-only', reopened_count: 2 }))

  const refused = await new ManagedRuntimeBrowserRig(process.cwd(), 3, {}, {}, 'test', {
    enabledProviders: [], freshAgentModes: ['freshcodex'], fixtureFreshAgentModes: ['freshcodex'],
    providerSettings: { freshcodex: {} },
  }).runManagedUpdateFixture('durable-only', { approvalLine: 'APPROVED\n' })
  expect(refused.exitCode).toBe(2)
  expect(refused.approvalRead).toBe('APPROVED\n')
  expect(refused.approvalConsumed).toBe(false)
  expect(refused.effects.some(effect => effect.startsWith('build:') || effect.startsWith('stop:') || effect.startsWith('soul-stop:'))).toBe(false)
})
