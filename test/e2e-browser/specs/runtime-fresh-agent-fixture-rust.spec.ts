/**
 * Deterministic, provider-free proof that every fresh-agent mode enters the
 * shared supervisor activation/recovery path. This is deliberately separate
 * from the authentic-provider receipt lane and cannot produce a release
 * qualification receipt.
 */
import { expect } from '@playwright/test'

import { validateFreshAgentIngressInventory } from '../../../scripts/testing/fresh-agent-ingress-inventory.js'
import { test } from '../helpers/fixtures.js'
import { ManagedRuntimeBrowserRig, type ManagedRuntimeView } from '../helpers/managed-runtime.js'

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

function fixtureState(rig: ManagedRuntimeBrowserRig, containerId: string): any {
  return JSON.parse(rig.ownedContainerExec(containerId, [
    'cat', '/home/freshell/provider/.freshell-fixture/provider-native-state.json',
  ]))
}

function fixtureWorkerPid(processes: string, provider: string): number {
  const line = processes.split('\n').find((candidate) => (
    candidate.includes('fresh-agent-fixture-worker')
    && candidate.includes(`--provider ${provider}`)
  ))
  const pid = Number(line?.trim().match(/^(\d+)/)?.[1])
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error(`fixture worker for ${provider} is absent`)
  return pid
}

async function replacement(
  rig: ManagedRuntimeBrowserRig,
  sessionId: string,
  priorIncarnationId: string,
): Promise<ManagedRuntimeView> {
  return waitFor('supervisor-owned replacement incarnation', async () => {
    const view = await rig.runningViewForFreshSession(sessionId)
    return view?.containerId && view.incarnationId !== priorIncarnationId ? view : null
  })
}

test.describe.serial('managed fresh-agent deterministic fixture', () => {
  test('all modes share activation and exact-native recovery without provider access', async ({ e2eServerKind }) => {
    test.skip(process.env[FIXTURE_ENV] !== '1', `set ${FIXTURE_ENV}=1 explicitly`)
    expect(e2eServerKind).toBe('rust')
    test.setTimeout(900_000)
    validateFreshAgentIngressInventory(process.cwd())

    const modeNames = MODES.map(({ mode }) => mode)
    const rig = new ManagedRuntimeBrowserRig(process.cwd(), 3, {}, {
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
        expect(rig.ownedContainerProcessTable(view.containerId!)).toContain('fresh-agent-fixture-worker')

        const send = await post(info.baseUrl, info.token, `/api/panes/${tab.paneId}/send-keys`, {
          data: `deterministic turn for ${definition.mode}`,
        })
        expect(send.sessionId).toBe(tab.sessionId)
        const state = await waitFor('one provider-native fixture completion', async () => {
          const current = fixtureState(rig, view.containerId!)
          return current.dispatchCount === 1 && current.completionCount === 1 ? current : null
        })
        expect(view.nativeSessionId).toBe(state.nativeSessionId)
        created.push({ paneId: tab.paneId, sessionId: tab.sessionId, view })
      }

      expect(new Set(created.map(({ view }) => view.containerId)).size).toBe(MODES.length)
      const volumes = created.map(({ view }) => (
        rig.runtime.broker.receipts().find((receipt) => receipt.soulId === view.soulId)?.providerVolumeName
      ))
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
      })
      const pendingState = await waitFor('fixture approval request', async () => {
        const state = fixtureState(rig, claude.view.containerId!)
        return typeof state.pendingDecisionId === 'string' ? state : null
      })
      const decisionId = pendingState.pendingDecisionId as string
      rig.runtime.killOwnedRuntimeExact(claude.view.containerId!)
      const recoveredClaude = await replacement(rig, claude.sessionId, claude.view.incarnationId)
      expect(recoveredClaude.nativeSessionId).toBe(claude.view.nativeSessionId)
      const epoch = await rig.controlEpoch()
      await rig.runtime.adminOk(rig.supervisor, rig.runtime.freshAgentResolveBody(
        recoveredClaude.soulId,
        decisionId,
        { behavior: 'allow' },
        epoch,
      ))
      await waitFor('exactly-once pending completion', async () => {
        const state = fixtureState(rig, recoveredClaude.containerId!)
        return state.pendingDecisionId === null && state.dispatchCount === 2
          && state.completionCount === 2 ? state : null
      })

      const codex = created[2]
      const workerPid = fixtureWorkerPid(
        rig.ownedContainerProcessTable(codex.view.containerId!),
        'codex',
      )
      rig.runtime.killOwnedRuntimePidExact(codex.view.containerId!, workerPid)
      const recoveredCodex = await replacement(rig, codex.sessionId, codex.view.incarnationId)
      expect(recoveredCodex.nativeSessionId).toBe(codex.view.nativeSessionId)
      expect(fixtureState(rig, recoveredCodex.containerId!).dispatchCount).toBe(1)

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
