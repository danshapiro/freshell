/**
 * Deterministic, provider-free proof that every fresh-agent mode enters the
 * shared supervisor activation/recovery path. This is deliberately separate
 * from the authentic-provider receipt lane and cannot produce a release
 * qualification receipt.
 */
import { expect } from '@playwright/test'

import { validateFreshAgentIngressInventory } from '../../../scripts/testing/fresh-agent-ingress-inventory.js'
import { observeOwnedFreshBrowserPane } from '../../../scripts/testing/runtime-external-browser.js'
import { test } from '../helpers/fixtures.js'
import { createManagedRuntimeBrowserRig, openFreshHistorySession, type ManagedFixtureRig, type ManagedRuntimeView, type FixtureNativeState } from '../helpers/managed-runtime.js'
import { TestHarness } from '../helpers/test-harness.js'

const FIXTURE_ENV = 'FRESHELL_RUNTIME_FRESH_AGENT_FIXTURE_TEST'
const PENDING_CONTROL = '[freshell-fixture:pending-approval]'

const MODES = [
  { agent: 'claude', mode: 'freshclaude', provider: 'claude' },
  { agent: 'kilroy', mode: 'kilroy', provider: 'kilroy' },
  { agent: 'codex', mode: 'freshcodex', provider: 'codex' },
  { agent: 'opencode', mode: 'freshopencode', provider: 'opencode' },
] as const

type Created = { paneId: string; sessionId: string; view: ManagedRuntimeView }

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
    page.on('websocket', socket => socket.on('framesent', frame => {
      try { sent.push(JSON.parse(String(frame.payload))) } catch { /* non-JSON frame */ }
    }))
    try {
      const info = await rig.start()
      await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`, { timeout: 60_000 })
      const harness = new TestHarness(page)
      await harness.waitForHarness()
      await harness.waitForConnection()
      for (const definition of MODES) {
        await page.keyboard.press('Alt+t')
        const label = { freshclaude: 'Freshclaude', kilroy: 'Kilroy', freshcodex: 'Freshcodex', freshopencode: 'Freshopencode' }[definition.mode]
        const picker = page.getByRole('toolbar', { name: /pane type picker/i }).last()
        await expect(picker).toBeVisible()
        await picker.getByRole('button', { name: label, exact: true }).click()
        const directory = page.getByLabel('Starting directory for ' + label)
        await directory.fill(rig.repoRoot)
        await directory.press('Enter')
        const created = await waitFor('browser-created managed fixture pane', async () => {
          const state = await harness.getState()
          const tabId = state.tabs.activeTabId!
          const leaf = state.panes.layouts[tabId]
          return leaf?.type === 'leaf' && leaf.content.kind === 'fresh-agent' && leaf.content.sessionId
            ? { tabId, paneId: leaf.id, sessionId: leaf.content.sessionId, createRequestId: leaf.content.createRequestId } : null
        })
        const view = await waitFor('owned fixture activation', () => rig.runningViewForFreshSession(created.sessionId))
        const pane = page.locator('[data-context="fresh-agent"][data-pane-id="' + created.paneId + '"]')
        const composer = pane.getByRole('textbox', { name: 'Chat message input' })
        await expect(composer).toBeEnabled()
        await composer.fill(`deterministic saved fixture turn for ${definition.mode}`)
        await pane.getByRole('button', { name: 'Send', exact: true }).click()
        await waitFor('actual fixture completion', async () => {
          const state = await fixtureState(rig, view)
          return state.dispatchCount === 1 && state.completionCount === 1 ? state : null
        })
        const wireProvider = definition.provider === 'kilroy' ? 'claude' : definition.provider
        expect(view.nativeSessionId).toBeTruthy()
        const paneObservation = { ...created, sessionType: definition.mode, provider: wireProvider,
          createdSessionId: created.sessionId, nativeSessionId: view.nativeSessionId! }
        const nativePane = await waitFor('browser pane bound to the actual owned allocation',
          () => page.evaluate(observeOwnedFreshBrowserPane, paneObservation))
        const tabCount = await harness.getTabCount()
        const layout = await harness.getPaneLayout(created.tabId)
        const soulIds = (await rig.inventory()).map(row => row.soulId).sort()
        const cursor = sent.length
        await openFreshHistorySession(page, { repoRoot: rig.repoRoot, provider: wireProvider, nativeSessionId: view.nativeSessionId! })
        await expect(pane).toBeVisible()
        expect(await harness.getActiveTabId()).toBe(created.tabId)
        expect(await harness.getTabCount()).toBe(tabCount)
        expect(await harness.getPaneLayout(created.tabId)).toEqual(layout)
        expect((await rig.inventory()).map(row => row.soulId).sort()).toEqual(soulIds)
        await waitFor('actual owned History wire ingress', () => sent.slice(cursor).find(frame =>
          frame.type === 'freshAgent.attach' && frame.sessionId === nativePane.sessionId
          || frame.type === 'freshAgent.create' && frame.sessionRef?.sessionId === view.nativeSessionId) ?? null)
        const historyFrames = sent.slice(cursor).filter(frame => ['freshAgent.create', 'freshAgent.attach', 'freshAgent.send'].includes(frame.type))
        expect(historyFrames.filter(frame => frame.type === 'freshAgent.send')).toHaveLength(0)
        expect(historyFrames.length).toBeGreaterThan(0)
        for (const frame of historyFrames) {
          expect(frame.provider).toBe(wireProvider)
          if (frame.type === 'freshAgent.create') expect(frame.sessionRef).toMatchObject({ provider: wireProvider, sessionId: view.nativeSessionId })
          else expect(frame.sessionId).toBe(nativePane.sessionId)
        }
        const current = await rig.runningViewForFreshSession(created.sessionId)
        expect(current?.soulId).toBe(view.soulId)
        expect(current?.incarnationId).toBe(view.incarnationId)
        expect(current?.nativeSessionId).toBe(view.nativeSessionId)
        expect((await fixtureState(rig, view)).dispatchCount).toBe(1)
      }
    } finally {
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
