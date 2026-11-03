import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import panesReducer, { initLayout } from '@/store/panesSlice'
import settingsReducer from '@/store/settingsSlice'
import sessionsReducer from '@/store/sessionsSlice'
import freshAgentLiveReducer from '@/store/freshAgentLiveSlice'
import freshAgentReducer, { sessionInit } from '@/store/freshAgentSlice'
import tabsReducer from '@/store/tabsSlice'
import connectionReducer from '@/store/connectionSlice'
import managedRuntimeReducer from '@/store/managedRuntimeSlice'
import { FreshAgentView } from '@/components/fresh-agent/FreshAgentView'
import { useAppSelector } from '@/store/hooks'
import { handleFreshAgentMessage } from '@/lib/fresh-agent-ws'
import { applyManagedRuntimeMergePlan, buildManagedRuntimeMergePlan } from '@/lib/recovery/managed-runtime-recovery'
import { resetSnapshotSchedulerForTests } from '@/lib/fresh-agent-snapshot-scheduler'
import { resetRebindQueueForTests } from '@/lib/rebind-queue'
import { ManagedRuntimeInventorySnapshotSchema } from '@shared/managed-runtime'
import type { ServerMessage } from '@shared/ws-protocol'
import hostedCodexNativeHistory from '../fixtures/managed-native-history/codex-hosted-live.json'

const execFileAsync = promisify(execFile)
const wsMock = vi.hoisted(() => ({ send: vi.fn(), onMessage: vi.fn((_handler: (message: ServerMessage) => void) => () => {}), onReconnect: vi.fn(() => () => {}) }))
const apiMock = vi.hoisted(() => ({
  get: vi.fn(), post: vi.fn(), getFreshAgentThreadSnapshot: vi.fn(), getFreshAgentCheckpointOutcomePage: vi.fn(),
  getFreshAgentModelCapabilities: vi.fn(), requestSessionHandoff: vi.fn(), setSessionMetadata: vi.fn(),
  getManagedRuntimeInventory: vi.fn(), retryManagedRuntimeSoul: vi.fn(), stopManagedRuntimeSoul: vi.fn(),
  updateManagedRuntimeViewVisibility: vi.fn(), getManagedRuntimeSoul: vi.fn(),
}))

vi.mock('@/lib/ws-client', () => ({ getWsClient: () => wsMock }))
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return { ...actual, api: { ...actual.api, get: apiMock.get, post: apiMock.post },
    getFreshAgentThreadSnapshot: apiMock.getFreshAgentThreadSnapshot,
    getFreshAgentCheckpointOutcomePage: apiMock.getFreshAgentCheckpointOutcomePage,
    getFreshAgentModelCapabilities: apiMock.getFreshAgentModelCapabilities,
    requestSessionHandoff: apiMock.requestSessionHandoff, setSessionMetadata: apiMock.setSessionMetadata,
    getManagedRuntimeInventory: apiMock.getManagedRuntimeInventory, retryManagedRuntimeSoul: apiMock.retryManagedRuntimeSoul,
    stopManagedRuntimeSoul: apiMock.stopManagedRuntimeSoul, updateManagedRuntimeViewVisibility: apiMock.updateManagedRuntimeViewVisibility,
    getManagedRuntimeSoul: apiMock.getManagedRuntimeSoul }
})
vi.mock('@/store/settingsThunks', () => ({ saveServerSettingsPatch: (payload: unknown) => ({ type: 'settings/saveServerSettingsPatch', payload }) }))

const locator = { sessionId: 'managed-public', sessionType: 'freshcodex' as const, provider: 'codex' as const }
const inventory = ManagedRuntimeInventorySnapshotSchema.parse({
  revision: 9,
  readiness: { inventoryRevision: 9, initialScanState: 'complete', blockedSubsystems: [], startupRecoveryConcurrencyLimit: 1, startupRecoveryPeak: 0 },
  souls: [{ soulId: 'soul-one', incarnationId: 'incarnation-one', launchState: 'running', cleanupState: 'none',
    intentRevision: 3, executionGeneration: 1, desiredState: 'running', recoveryState: 'live', durabilityState: 'resume_captured',
    allocationState: 'verified_durable', provider: 'codex', freshAgentSessionType: 'freshcodex', evidenceRevision: 1,
    identityRevision: 1, successfulRecoveriesInWindow: 0, freshAgentSessionId: locator.sessionId, nativeSessionId: 'native-a' }],
  viewIntents: [{ viewId: 'view-one', soulId: 'soul-one', ownerId: 'installation', workspaceId: 'workspace',
    kind: 'automatic_primary', preferredTabId: 'tab-1', preferredPaneId: 'pane-1', title: '', placementGroup: '',
    visibility: 'visible', revision: 1, soulIntentRevision: 3, createdAt: 1, updatedAt: 1 }], pendingProjectionCount: 0,
})

function createStore() {
  return configureStore({
    reducer: { panes: panesReducer, settings: settingsReducer, sessions: sessionsReducer, freshAgent: freshAgentReducer,
      freshAgentLive: freshAgentLiveReducer, tabs: tabsReducer, connection: connectionReducer, managedRuntime: managedRuntimeReducer },
    middleware: (defaults) => defaults({ serializableCheck: { ignoredPaths: ['sessions.expandedProjects'] } }),
    preloadedState: {
      connection: { status: 'ready' as const, platform: null, availableClis: {}, featureFlags: {} },
      sessions: { projects: [], expandedProjects: new Set<string>(), wsSnapshotReceived: true, windows: {}, contextUsageByKey: {} },
      panes: { layouts: {}, activePane: {}, paneTitles: {}, paneTitleSetByUser: {}, renameRequestTabId: null,
        renameRequestPaneId: null, zoomedPane: {}, refreshRequestsByPane: {}, restoreFallbackAttemptsByPane: {},
        reconcileWarming: null, reconcilePendingPanes: {}, closingTabs: {}, closingPanes: {} },
      tabs: { tabs: [{ id: 'tab-1', createRequestId: 'tab-1', title: 'Tab 1', titleSetByUser: false,
        status: 'running' as const, mode: 'shell' as const, shell: 'system' as const, createdAt: Date.now() }], activeTabId: 'tab-1',
        renameRequestTabId: null, tombstones: [] },
    },
  })
}

function MountedPane() {
  const content = useAppSelector((state) => {
    const layout = state.panes.layouts['tab-1']
    if (!layout || layout.type !== 'leaf' || layout.content.kind !== 'fresh-agent') throw new Error('missing controlled pane')
    return layout.content
  })
  return <FreshAgentView tabId="tab-1" paneId="pane-1" paneContent={content} />
}

function sends() {
  return wsMock.send.mock.calls.map(([frame]) => frame).filter((frame): frame is Record<string, unknown> =>
    !!frame && typeof frame === 'object' && (frame as { type?: unknown }).type === 'freshAgent.send')
}

async function controlledFrames(request: Record<string, unknown>, outcome: 'refused' | 'ambiguous') {
  const server = process.env.FRESHELL_TEST_CONTROLLED_GATEWAY_BINARY
  const host = process.env.FRESHELL_TEST_CONTROLLED_HOST_BINARY
  if (process.env.FRESHELL_SANDBOX_MODE !== 'runtime-suite' || !server || !host) throw new Error('controlled contract requires its sandbox and both test binaries')
  const temporary = process.env.TMPDIR
  if (!temporary) throw new Error('controlled contract requires its owned temporary directory')
  expect(os.tmpdir()).toBe(temporary)
  expect(path.dirname(path.dirname(fs.realpathSync(temporary)))).toBe('/freshell-test-artifacts')
  expect(fs.statSync(temporary).dev).toBe(fs.statSync('/freshell-test-artifacts').dev)
  for (const [name, child] of [['XDG_CACHE_HOME', 'cache'], ['XDG_DATA_HOME', 'data'], ['npm_config_cache', 'pnpm']] as const) {
    expect(process.env[name]).toBe(path.join(temporary, child))
    expect(fs.statSync(process.env[name]!).dev).toBe(fs.statSync(temporary).dev)
  }
  const result = await execFileAsync(server, [
    '--exact', 'fresh_agent_proxy::tests::codex_replacement_realpath::review_definite_refusal_crosses_actor_supervisor_gateway_without_provider_notice',
    '--nocapture', '--test-threads=1',
  ], { env: { ...process.env, FRESHELL_TEST_CONTROLLED_HOST_BINARY: host,
    FRESHELL_TEST_CONTROLLED_CLIENT_REQUEST: JSON.stringify(request), FRESHELL_TEST_CONTROLLED_OUTCOME: outcome,
    FRESHELL_TEST_CONTROLLED_MODE: 'client-contract' }, maxBuffer: 4 * 1024 * 1024 })
  expect(result.stdout).toMatch(/test result: ok\. 1 passed;/)
  const fixtureDirs = result.stdout.split('\n').filter((line) => line.includes('FRESHELL_PRODUCTION_HOST_FIXTURE_TMP='))
  expect(fixtureDirs.length).toBeGreaterThan(0)
  for (const line of fixtureDirs) expect(line.slice(line.indexOf('FRESHELL_PRODUCTION_HOST_FIXTURE_TMP=') + 'FRESHELL_PRODUCTION_HOST_FIXTURE_TMP='.length)).toMatch(`${temporary}/`)
  const read = (marker: string) => {
    const lines = result.stdout.split('\n').filter((line) => line.includes(marker))
    if (lines.length !== 1) throw new Error(`expected exactly one ${marker} frame, got ${lines.length}`)
    return JSON.parse(lines[0].slice(lines[0].indexOf(marker) + marker.length)) as Record<string, unknown>
  }
  const match = read(`FRESHELL_PRODUCTION_HOST_SEND_${outcome === 'refused' ? 'Refused' : 'Ambiguous'}=`)
  expect((match.event as Record<string, unknown>).requestId).toBe(request.requestId)
  const different = read('FRESHELL_PRODUCTION_HOST_SEND_Different=')
  expect((different.event as Record<string, unknown>).requestId).not.toBe(request.requestId)
  return { match, different }
}

beforeEach(() => {
  resetSnapshotSchedulerForTests()
  resetRebindQueueForTests()
  window.sessionStorage.clear()
  wsMock.send.mockReset()
  wsMock.onMessage.mockReset()
  wsMock.onReconnect.mockReset().mockImplementation(() => () => {})
  apiMock.get.mockResolvedValue({ checkpoints: [] })
  apiMock.post.mockResolvedValue({ title: null, source: 'none' })
  apiMock.getFreshAgentCheckpointOutcomePage.mockResolvedValue({ outcomes: [] })
  apiMock.getFreshAgentThreadSnapshot.mockResolvedValue({ ...hostedCodexNativeHistory, threadId: 'native-a' })
  apiMock.setSessionMetadata.mockResolvedValue(undefined)
  apiMock.getManagedRuntimeInventory.mockResolvedValue(inventory)
})
afterEach(() => { cleanup(); resetSnapshotSchedulerForTests(); resetRebindQueueForTests() })

describe('controlled production-host send contract', () => {
  it.each(['refused', 'ambiguous'] as const)('delivers the unchanged %s response to the originating mounted client', async (outcome) => {
    const { WsClient } = await vi.importActual<typeof import('@/lib/ws-client')>('@/lib/ws-client')
    const client = new WsClient('ws://controlled-host-client.test/ws')
    const store = createStore()
    client.onMessage((frame) => { handleFreshAgentMessage(store.dispatch, frame, client) })
    wsMock.onMessage.mockImplementation((handler) => client.onMessage(handler))
    store.dispatch(sessionInit(locator))
    store.dispatch(initLayout({ tabId: 'tab-1', paneId: 'pane-1', content: { kind: 'fresh-agent', ...locator,
      createRequestId: 'controlled-host-client', status: 'idle', sessionRef: { provider: 'codex', sessionId: 'native-a' },
      soulId: 'soul-one', soulIntentRevision: 3, viewIntentId: 'view-one' } }))
    render(<Provider store={store}><MountedPane /></Provider>)
    act(() => applyManagedRuntimeMergePlan(store as any, buildManagedRuntimeMergePlan(inventory, store.getState() as any)))
    const composer = await screen.findByRole('textbox', { name: 'Chat message input' })
    await waitFor(() => expect(composer).toBeEnabled())
    const send = (text: string) => {
      fireEvent.change(composer, { target: { value: text } })
      fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    }
    send('First controlled input')
    send('Queued controlled input')
    expect(sends()).toHaveLength(1)
    const request = sends()[0]
    expect(typeof request.requestId).toBe('string')
    const frames = await controlledFrames(request, outcome)
    act(() => client.receiveMessageForTest(frames.different as never))
    expect(composer).toHaveValue('')
    expect(sends()).toHaveLength(1)
    expect(screen.queryByText(/Delivery uncertain/)).not.toBeInTheDocument()
    act(() => client.receiveMessageForTest(frames.match as never))
    if (outcome === 'refused') {
      await waitFor(() => expect(composer).toHaveValue('First controlled input'))
      expect(screen.getByText(/Message not sent:/)).toBeInTheDocument()
      await waitFor(() => expect(sends()).toHaveLength(2))
      expect(sends()[1]).toMatchObject({ text: 'Queued controlled input' })
    } else {
      expect(sends()).toHaveLength(1)
      expect(screen.getByRole('status', { name: 'Queued messages' })).toHaveTextContent('1 queued')
      expect(screen.getByText(/Delivery uncertain/)).toBeInTheDocument()
    }
    fs.appendFileSync(path.join(process.env.TMPDIR!, 'request-identities.jsonl'), `${JSON.stringify({ outcome,
      requestId: request.requestId, responseRequestId: (frames.match.event as Record<string, unknown>).requestId,
      differentRequestId: (frames.different.event as Record<string, unknown>).requestId })}\n`)
  })
})
