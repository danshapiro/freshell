import { expect } from '@playwright/test'
import { test } from '../helpers/fixtures.js'
import { TestHarness } from '../helpers/test-harness.js'
import { createManagedRuntimeBrowserRig } from '../helpers/managed-runtime.js'
import { resolveManagedExternalDescriptor } from '../../../scripts/testing/runtime-external-browser.js'
import { WS_PROTOCOL_VERSION } from '../../../shared/ws-protocol.js'

test('actual managed external topology and finite owner facts', async ({ page, request }) => {
  test.setTimeout(900_000)
  const descriptor = resolveManagedExternalDescriptor(process.env)
  if (!descriptor) throw new Error('this smoke requires the complete owned external target')
  const rig = createManagedRuntimeBrowserRig(process.cwd(), 3, {}, {}, 'test', {
    enabledProviders: [], freshAgentModes: ['freshopencode'], fixtureFreshAgentModes: ['freshopencode'],
  })
  try {
    const info = await rig.start()
    const headers = { 'x-auth-token': info.token, Origin: info.baseUrl }
    const server = await request.get(`${info.baseUrl}/api/server-info`, { headers })
    expect(server.ok()).toBe(true)
    expect(await server.json()).toMatchObject({ runtime: 'rust', commit: descriptor.candidateSha, buildDirty: false })
    expect((await request.get(`${info.baseUrl}/api/server-info`)).status()).toBe(401)
    expect((await request.get(`${info.baseUrl}/api/server-info`, { headers: { ...headers, 'x-auth-token': 'foreign-token' } })).status()).toBe(401)
    expect((await request.get(`${info.baseUrl}/api/server-info`, { headers: { ...headers, Origin: 'https://unowned.invalid' } })).status()).toBe(403)
    expect(await rig.inventory()).toEqual([])

    await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
    const harness = new TestHarness(page)
    await harness.waitForHarness()
    await harness.waitForConnection()
    const ready = await page.evaluate(async ({ wsUrl, token, protocolVersion }) => {
      return new Promise<{ buildId: string; managedRuntimeV1: boolean }>((resolve, reject) => {
        const socket = new WebSocket(wsUrl)
        const timer = setTimeout(() => { socket.close(); reject(new Error('owned WSS ready timed out')) }, 10_000)
        socket.onopen = () => socket.send(JSON.stringify({ type: 'hello', token, protocolVersion,
          capabilities: { managedRuntimeV1: true, paneReconcileV1: true } }))
        socket.onerror = () => { clearTimeout(timer); socket.close(); reject(new Error('owned WSS failed')) }
        socket.onmessage = event => {
          const frame = JSON.parse(String(event.data))
          if (frame.type !== 'ready') return
          clearTimeout(timer)
          socket.close()
          resolve({ buildId: frame.buildId, managedRuntimeV1: frame.capabilities?.managedRuntimeV1 === true })
        }
      })
    }, { wsUrl: info.wsUrl, token: info.token, protocolVersion: WS_PROTOCOL_VERSION })
    expect(ready).toEqual({ buildId: descriptor.candidateSha, managedRuntimeV1: true })

    const created = await request.post(`${info.baseUrl}/api/tabs`, { headers, data: { agent: 'opencode', cwd: rig.repoRoot } })
    expect(created.ok()).toBe(true)
    const raw = await created.json()
    const tab = raw.data ?? raw
    expect(tab.paneId).toBeTruthy()
    expect(tab.sessionId).toBeTruthy()
    await expect.poll(async () => (await rig.runningViewForFreshSession(tab.sessionId))?.launchState, { timeout: 90_000 }).toBe('running')
    const view = await rig.runningViewForFreshSession(tab.sessionId)
    if (!view) throw new Error('actual deterministic managed pane has no current registry row')
    const handle = rig.exactRuntimeHandle(view)
    const sent = await request.post(`${info.baseUrl}/api/panes/${tab.paneId}/send-keys`, { headers, data: { data: 'Task008 deterministic fixture turn' } })
    expect(sent.ok()).toBe(true)
    await expect.poll(async () => (await rig.fixtureNativeState(handle)).completionCount, { timeout: 90_000 }).toBe(1)
    const state = await rig.fixtureNativeState(handle)
    expect(state).toMatchObject({ nativeSessionId: handle.nativeSessionId, pendingDecisionId: null, dispatchCount: 1, completionCount: 1 })
    const worker = await rig.fixtureWorkerFacts(handle)
    expect(worker.provider).toBe('opencode')
    expect(worker.workerPid).toBeGreaterThan(1)
    const facts = await rig.chaosHostFacts(handle)
    expect(facts.workerPid).toBeGreaterThan(0)
    expect(facts.workerLaunchCount).toBe(1)
    expect(facts.limits).toEqual({ cpuMax: '200000 100000', memoryMax: '4294967296', swapMax: '0', pidsMax: '512' })
    expect(facts.unsafeBrokerAttempts).toBe(0)

    const challenge = await rig.createSyntheticOpenCodeChallenge(handle)
    expect(challenge.nativeSessionId).toBe(state.nativeSessionId)
    expect(await rig.nativeToolEvidence(handle, challenge.challengeId)).toEqual({
      requestIds: [challenge.toolPartId], resultIds: [challenge.toolPartId], replayCount: 0,
    })
    expect(await rig.nativeFollowUpMessageIds(handle, challenge.challengeId)).toEqual([challenge.messageId])

    const readyAt = await harness.getLastReadyAt()
    expect(await rig.crashAndRestartWeb()).toMatchObject(info)
    await harness.waitForConnectionAfter(readyAt, 90_000)
    expect(page.url().startsWith(`${descriptor.baseUrl}/`)).toBe(true)
    expect(await rig.runningViewForFreshSession(tab.sessionId)).toMatchObject({ incarnationId: view.incarnationId, nativeSessionId: state.nativeSessionId })
    expect(await rig.chaosHostFacts(handle)).toEqual(facts)
    expect(await rig.nativeFollowUpMessageIds(handle, challenge.challengeId)).toEqual([challenge.messageId])
  } finally {
    const cleanup = await rig.stop()
    expect(cleanup.ok, cleanup.errors.join('\n')).toBe(true)
  }
})
