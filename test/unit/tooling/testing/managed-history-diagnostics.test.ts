// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TestCase, TestResult } from '@playwright/test/reporter'
import * as external from '../../../../scripts/testing/runtime-external-browser.js'
import { buildManagedRuntimeMergePlan } from '../../../../src/lib/recovery/managed-runtime-recovery.js'
import { EventEmitter } from 'node:events'
import panesReducer, { materializeFreshAgentSession, mergePaneContent, updatePaneContent } from '../../../../src/store/panesSlice.js'
import managedRuntimeReducer, { managedRuntimeSnapshotReceived } from '../../../../src/store/managedRuntimeSlice.js'
import { freshAgentCheckpointConversationKeyForContent } from '../../../../src/store/paneTypes.js'

const original = vi.hoisted(() => ({
  cases: new Map<string, (context: any) => Promise<void>>(),
  start: vi.fn(), stop: vi.fn(), waitForHarness: vi.fn(), waitForConnection: vi.fn(),
  rig: {} as any, history: vi.fn(), state: vi.fn(), tabCount: vi.fn(), layout: vi.fn(), activeTab: vi.fn(),
}))
vi.mock('../../../e2e-browser/helpers/fixtures.js', () => ({
  test: Object.assign((title: string, callback: (context: any) => Promise<void>) => original.cases.set(title, callback), {
    describe: { serial: (_title: string, callback: () => void) => callback() }, skip: vi.fn(), setTimeout: vi.fn(),
  }),
}))
vi.mock('../../../e2e-browser/helpers/managed-runtime.js', () => ({
  createManagedRuntimeBrowserRig: () => ({ ...original.rig, start: original.start, stop: original.stop }),
  openFreshHistorySession: (...args: any[]) => original.history(...args),
}))
vi.mock('../../../e2e-browser/helpers/test-harness.js', () => ({
  TestHarness: class {
    waitForHarness = original.waitForHarness
    waitForConnection = original.waitForConnection
    getState = original.state
    getTabCount = original.tabCount
    getPaneLayout = original.layout
    getActiveTabId = original.activeTab
  },
}))

const file = 'runtime-fresh-agent-fixture-rust.spec.ts'
const owned = {
  FRESHELL_E2E_TARGET_URL: 'https://fixture.invalid',
  FRESHELL_E2E_TARGET_WS_URL: 'wss://fixture.invalid/ws',
  FRESHELL_E2E_TARGET_TOKEN: 'private-token',
  FRESHELL_RUNTIME_EXTERNAL_RUN_ID: '11111111-1111-4111-8111-111111111111',
  FRESHELL_RUNTIME_EXTERNAL_CANDIDATE_SHA: 'a'.repeat(40),
}
const testCase = { id: 'owned-case', location: { file, line: 73, column: 1 },
  titlePath: () => [file, 'managed fixture', 'History opens existing pane'] } as TestCase

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs() })

function reporterPath() {
  for (const [key, value] of Object.entries(owned)) vi.stubEnv(key, value)
  const retained: string[] = []
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => { retained.push(String(chunk)); return true })
  const reporter = new external.default()
  // Exercise the exact worker stdout -> reporter -> retained text path,
  // including arbitrary transport chunk boundaries.
  const emit = (line: string) => {
    reporter.onStdOut(line.slice(0, 13), testCase, {} as TestResult)
    reporter.onStdOut(line.slice(13), testCase, {} as TestResult)
  }
  return { reporter, retained, emit }
}

describe('managed History original awaited phase diagnostics', () => {
  it.each(['success', 'failure'] as const)('preserves the original operation %s when the diagnostic sink throws', async outcome => {
    vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const observe = new external.ManagedHistoryAwaitedPhases(() => { throw new Error('diagnostic output unavailable') })
    const originalError = new Error('original browser operation failed')
    const operation = vi.fn(async () => { if (outcome === 'failure') throw originalError; return 42 })
    const result = observe.run('harness', 'bootstrap', operation)
    if (outcome === 'failure') await expect(result).rejects.toBe(originalError)
    else await expect(result).resolves.toBe(42)
    expect(operation).toHaveBeenCalledOnce()
  })

  it('retains the cancelled original await and timeout category while cleanup runs', async () => {
    const { reporter, retained, emit } = reporterPath()
    const observe = new external.ManagedHistoryAwaitedPhases(emit)
    const abort = new AbortController()
    const timeout = Object.assign(new Error('private URL ?token=secret and page body'), { name: 'TimeoutError' })
    const cleanup = vi.fn(async () => {})
    const next = vi.fn()
    const run = async () => {
      try {
        await observe.run('harness', 'bootstrap', () => new Promise<void>((_resolve, reject) => {
          abort.signal.addEventListener('abort', () => reject(abort.signal.reason), { once: true })
        }))
        await observe.run('connection', 'bootstrap', next)
      } finally { await cleanup() }
    }
    const result = run()
    reporter.onStepBegin(testCase, {} as TestResult, { category: 'pw:api', location: {
      file: '/private/checkout/test/e2e-browser/helpers/test-harness.ts', line: 221, column: 16,
    } } as any)
    abort.abort(timeout)
    await expect(result).rejects.toBe(timeout)
    reporter.onTestEnd(testCase, { status: 'timedOut', errors: [{ message: timeout.message }] } as TestResult)
    const events = external.parseManagedHistoryDiagnosticText(retained.join(''))
    expect(events.map(event => event.event)).toEqual(['managed_history_phase', 'managed_history_phase', 'managed_history_failure'])
    expect(events[0]).toMatchObject({ phase: 'harness', state: 'begin', mode: 'bootstrap' })
    expect(events[1]).toMatchObject({ phase: 'harness', state: 'failed', errorCategory: 'timeout' })
    expect(events[2]).toMatchObject({ phase: 'harness', mode: 'bootstrap', status: 'timedOut', errorCategory: 'timeout',
      callsite: { file: 'test/e2e-browser/helpers/test-harness.ts', line: 221, column: 16 },
      runId: owned.FRESHELL_RUNTIME_EXTERNAL_RUN_ID, candidateSha: owned.FRESHELL_RUNTIME_EXTERNAL_CANDIDATE_SHA })
    expect(cleanup).toHaveBeenCalledOnce()
    expect(next).not.toHaveBeenCalled()
    expect(retained.join('')).not.toContain('private-token')
    expect(retained.join('')).not.toContain('page body')
    expect(retained.join('')).not.toContain('/private/checkout')
  })

  it('retains ordered matching begin/end for resolved awaits and bounded navigation facts', async () => {
    const { reporter, retained, emit } = reporterPath()
    const observe = new external.ManagedHistoryAwaitedPhases(emit)
    const value = await observe.run('goto', 'bootstrap', async () => 42)
    observe.navigation({ status: 503, resourceType: 'document' })
    await observe.run('harness', 'bootstrap', async () => {})
    reporter.onTestEnd(testCase, { status: 'passed' } as TestResult)
    expect(value).toBe(42)
    const events = external.parseManagedHistoryDiagnosticText(retained.join(''))
    expect(events.map(event => [event.phase, event.state])).toEqual([
      ['goto', 'begin'], ['goto', 'end'], [undefined, undefined], ['harness', 'begin'], ['harness', 'end'],
    ])
    expect(events[2]).toMatchObject({ event: 'managed_history_navigation', status: 503, resourceType: 'document' })
    expect(events.every(event => event.runId === owned.FRESHELL_RUNTIME_EXTERNAL_RUN_ID)).toBe(true)
  })

  it('runs the original selected spec through the stalled harness await and its actual finally cleanup', async () => {
    const { reporter, retained } = reporterPath()
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
      const line = String(chunk)
      // The first leg is worker text; the second is the run-bound reporter
      // output which the existing launcher retains.
      if (external.parseManagedHistoryDiagnosticText(line)[0]?.runId) retained.push(line)
      else reporter.onStdOut(line, testCase, {} as TestResult)
      return true
    })
    await import('../../../e2e-browser/specs/runtime-fresh-agent-fixture-rust.spec.js')
    const abort = new AbortController()
    const timeout = Object.assign(new Error('Test timeout of 900000ms exceeded'), { name: 'TimeoutError' })
    let reached!: () => void
    const started = new Promise<void>(resolve => { reached = resolve })
    original.start.mockResolvedValue({ baseUrl: 'https://fixture.invalid', token: 'private-token' })
    original.stop.mockResolvedValue({ ok: true, errors: [] })
    original.waitForHarness.mockImplementation(() => new Promise<void>((_resolve, reject) => {
      reached()
      abort.signal.addEventListener('abort', () => reject(abort.signal.reason), { once: true })
    }))
    original.waitForConnection.mockClear()
    const page = { on: vi.fn(), goto: vi.fn(async () => ({ status: () => 200 })) }
    const run = original.cases.get('completed owned native fixture history opens its existing browser pane')!({ page })
    await started
    abort.abort(timeout)
    await expect(run).rejects.toBe(timeout)
    reporter.onTestEnd(testCase, { status: 'timedOut' } as TestResult)
    const events = external.parseManagedHistoryDiagnosticText(retained.join(''))
    expect(events.filter(event => event.event === 'managed_history_phase').map(event => [event.phase, event.state])).toEqual([
      ['start', 'begin'], ['start', 'end'], ['goto', 'begin'], ['goto', 'end'], ['harness', 'begin'], ['harness', 'failed'],
    ])
    expect(events.at(-1)).toMatchObject({ phase: 'harness', status: 'timedOut', errorCategory: 'timeout',
      callsite: { file: 'test/e2e-browser/specs/' + file } })
    expect(original.stop).toHaveBeenCalledOnce()
    expect(original.waitForConnection).not.toHaveBeenCalled()
    expect(retained.join('')).not.toContain('private-token')
  })
})

type HistoryFault = 'unknown' | 'provider' | 'mode' | 'root' | 'misbound-pane' | 'create' | 'create-owner' | 'send' | 'missing-target' | 'new-allocation' | 'resume'
type StartupFault = 'ack-request' | 'ack-mode' | 'ack-provider' | 'ack-runtime-provider' | 'ack-root' | 'ack-missing-root' | 'ack-duplicate'
  | 'create-tab' | 'pane-request' | 'pane-mode' | 'pane-provider' | 'pane-root' | 'pane-soul' | 'pane-incarnation'
  | 'inventory-missing' | 'inventory-stale' | 'inventory-ambiguous' | 'inventory-other-alias' | 'inventory-profile'
  | 'reply-run' | 'current-soul' | 'current-incarnation' | 'current-root' | 'current-ambiguous'
  | 'current-profile' | 'current-type' | 'current-presentation' | 'current-host' | 'current-container' | 'current-intent'

type ContinuityScenario = { advance?: boolean; split?: boolean; verified?: boolean; pendingNative?: boolean; captureNative?: boolean;
  mutate?: (state: any, item: any) => void; mutateSnapshot?: (state: any, item: any) => void }

/** Settle the registered browser case under a controlled clock, including its collector and finally. */
async function historyCallback(fault?: HistoryFault, startup: 'presentation' | 'native' = 'presentation', startupFault?: StartupFault,
  actualHistoryHelper?: (...args: any[]) => Promise<void>, continuity?: ContinuityScenario) {
  await import('../../../e2e-browser/specs/runtime-fresh-agent-fixture-rust.spec.js')
  vi.useFakeTimers()
  vi.stubEnv('FRESHELL_RUNTIME_FRESH_AGENT_FIXTURE_TEST', '1')
  const definitions = [
    ['freshclaude', 'claude'], ['kilroy', 'claude'], ['freshcodex', 'codex'], ['freshopencode', 'opencode'],
  ]
  const state: any = { tabs: { activeTabId: '', tabs: [] },
    panes: structuredClone(panesReducer(undefined, { type: 'controlled/init' })),
    managedRuntime: structuredClone(managedRuntimeReducer(undefined, { type: 'controlled/init' })) }
  const allocated: any[] = []
  let observedNativePane = false
  let framesent!: (frame: { payload: string }) => void
  let framereceived: (frame: { payload: string }) => void = () => {}
  let sendCount = 0
  let inventoryAfterHistory = 0
  const promotions: number[] = []
  const historySnapshots: any[] = []
  const observedStartupIds: string[] = []
  const frame = (value: any) => framesent({ payload: JSON.stringify(value) })
  const current = () => allocated.at(-1)!
  const locator: any = {
    constructor: { name: 'Locator' },
    _expect: async () => ({ matches: true, received: 'controlled locator', log: [] }),
    last: () => locator, getByRole: () => locator,
    click: async () => {}, fill: async () => {},
    press: async () => {
      const item = current(), content = state.panes.layouts[item.tabId].content
      const request = { type: 'freshAgent.create', requestId: content.createRequestId, tabId: item.tabId,
        paneId: item.paneId, sessionType: content.sessionType, provider: content.provider }
      if (startupFault === 'create-tab') request.tabId = 'other-tab'
      frame(request)
      const ack: { sessionRef?: { provider: string, sessionId: string } } & Record<string, unknown> = { type: 'freshAgent.created', requestId: content.createRequestId,
        sessionId: item.sessionId, sessionType: content.sessionType, provider: content.provider,
        runtimeProvider: item.view.provider, sessionRef: { provider: content.provider, sessionId: item.view.nativeSessionId } }
      if (startupFault === 'ack-request') ack.requestId = 'other-request'
      if (startupFault === 'ack-mode') ack.sessionType = 'freshopencode'
      if (startupFault === 'ack-provider') ack.provider = 'opencode'
      if (startupFault === 'ack-runtime-provider') ack.runtimeProvider = 'opencode'
      if (startupFault === 'ack-root') ack.sessionRef!.sessionId = 'wrong-ack-root'
      if (startupFault === 'ack-missing-root') delete ack.sessionRef
      framereceived({ payload: JSON.stringify(ack) })
      if (startupFault === 'ack-duplicate') framereceived({ payload: JSON.stringify(ack) })
      if (startup === 'native') promote(item)
      const pane = state.panes.layouts[item.tabId].content
      if (startupFault === 'pane-request') pane.createRequestId = 'other-pane-request'
      if (startupFault === 'pane-mode') pane.sessionType = 'freshopencode'
      if (startupFault === 'pane-provider') pane.provider = 'opencode'
      if (startupFault === 'pane-root') pane.sessionId = 'wrong-pane-root'
      if (startupFault === 'pane-soul') pane.soulId = 'other-pane-soul'
      if (startupFault === 'pane-incarnation') pane.incarnationId = 'stale-pane-incarnation'
    },
  }
  const page: any = {
    off: vi.fn(),
    on: (event: string, callback: any) => {
      if (event === 'websocket') callback({ on: (kind: string, listener: any) => {
        if (kind === 'framesent') framesent = listener
        if (kind === 'framereceived') framereceived = listener
      } })
    },
    goto: async () => ({ status: () => 200 }),
    keyboard: { press: async () => {
      observedNativePane = false
      const index = allocated.length, [sessionType, provider] = definitions[index]
      const tabId = `tab-${index}`, paneId = `pane-${index}`, sessionId = `created-${index}`
      const view = { soulId: `soul-${index}`, incarnationId: `incarnation-${index}`, nativeSessionId: `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`,
        freshAgentSessionId: sessionId, freshAgentSessionType: sessionType,
        provider: sessionType === 'kilroy' ? 'kilroy' : provider, profile: 'default_agent',
        launchState: 'running', cleanupState: 'none', executionGeneration: 1, intentRevision: 1,
        desiredState: 'running', recoveryState: 'live',
        allocationState: continuity?.verified ? 'verified_durable' : 'materializing',
        durabilityState: continuity?.verified ? 'resume_captured' : 'unknown',
        evidenceRevision: 0, successfulRecoveriesInWindow: 0, containerId: String(index + 1).repeat(64), hostBootId: `boot-${index}` }
      const content = { kind: 'fresh-agent', sessionType, provider, sessionId, createRequestId: `request-${index}` }
      state.tabs.activeTabId = tabId
      state.tabs.tabs.push({ id: tabId })
      state.panes.layouts[tabId] = { type: 'leaf', id: paneId, content }
      allocated.push({ tabId, paneId, sessionId, view })
    } },
    getByRole: () => locator, getByLabel: () => locator,
    locator: () => ({ ...locator, getByRole: (_role: string, options: any) => options.name === 'Send' ? {
      ...locator, click: async () => {
        const item = current(), content = state.panes.layouts[item.tabId].content
        // Both inventory interleavings precede the first dispatched fixture turn.
        expect(content.sessionId).toBe(item.view.nativeSessionId)
        sendCount++
        content.sessionId = item.view.nativeSessionId
        content.sessionRef = { provider: content.provider, sessionId: item.view.nativeSessionId }
        // Completion follows materialization and uses the owned native identity.
        framereceived({ payload: JSON.stringify({ type: 'freshAgent.turn.complete', sessionId: item.view.nativeSessionId }) })
      },
    } : locator }),
    evaluate: async (operation: any, argument: any) => {
      vi.stubGlobal('window', { __FRESHELL_TEST_HARNESS__: { getState: () => state } })
      try {
        const result = operation(argument); observedNativePane = true
        if (continuity?.split) {
          const item = current(), leaf = state.panes.layouts[item.tabId]
          if (leaf.type === 'leaf') state.panes.layouts[item.tabId] = { type: 'split', id: `split-${item.paneId}`,
            direction: 'horizontal', sizes: [35, 65], children: [leaf,
              { type: 'leaf', id: `browser-${item.paneId}`, content: { kind: 'browser', url: 'https://controlled.invalid' } }] }
        }
        return result
      } finally { vi.unstubAllGlobals() }
    },
  }
  const fold = (snapshot: any) => {
    const plan = buildManagedRuntimeMergePlan(snapshot, state)
    expect(plan.creates).toHaveLength(0)
    for (const update of plan.updates) state.panes = structuredClone(panesReducer(state.panes, updatePaneContent(update)))
    state.managedRuntime = structuredClone(managedRuntimeReducer(state.managedRuntime,
      managedRuntimeSnapshotReceived({ snapshot, reconstructedViewCount: 0 })))
    return plan
  }
  const promote = (item: any) => {
    const soul = { ...item.view, freshAgentCreateRequestId: `request-${allocated.indexOf(item)}` }
    if (continuity?.pendingNative) delete soul.nativeSessionId
    const view = { viewId: `view-${item.paneId}`, soulId: item.view.soulId, revision: 1,
      kind: 'automatic_primary', visibility: 'visible', preferredTabId: item.tabId, preferredPaneId: item.paneId,
      ownerId: 'controlled-owner', workspaceId: 'controlled-workspace', title: 'controlled title',
      placementGroup: 'controlled-group', soulIntentRevision: 1, createdAt: 1, updatedAt: 1 }
    const plan = fold({ revision: state.managedRuntime.revision + 1, pendingProjectionCount: 0,
      souls: [...state.managedRuntime.souls, soul], viewIntents: [...state.managedRuntime.viewIntents, view] })
    expect(plan.updates).toHaveLength(allocated.length)
    if (continuity?.pendingNative) {
      // The native materialized frame reaches the pane independently of the
      // supervisor's later identity persistence and inventory projection.
      state.panes = structuredClone(panesReducer(state.panes, materializeFreshAgentSession({
        previousSessionId: item.sessionId, sessionId: item.view.nativeSessionId,
        sessionType: item.view.freshAgentSessionType,
        provider: item.view.provider === 'kilroy' ? 'claude' : item.view.provider,
      })))
    }
    promotions.push(allocated.indexOf(item))
  }
  original.start.mockResolvedValue({ baseUrl: 'https://fixture.invalid', token: 'private-token' })
  original.stop.mockClear().mockImplementation(async () => {
    await new Promise<void>(resolve => setTimeout(resolve, 1))
    return { ok: true, errors: [] }
  })
  original.waitForHarness.mockResolvedValue(undefined)
  original.waitForConnection.mockResolvedValue(undefined)
  original.state.mockClear().mockImplementation(async () => {
    if (current()?.tabId && allocated.length > sendCount) observedStartupIds.push(state.panes.layouts[current().tabId].content.sessionId)
    const snapshot = structuredClone(state)
    if (observedNativePane) continuity?.mutateSnapshot?.(snapshot, current())
    return snapshot
  })
  original.tabCount.mockImplementation(async () => state.tabs.tabs.length)
  original.layout.mockClear().mockImplementation(async (tabId: string) => structuredClone(state.panes.layouts[tabId]))
  original.activeTab.mockImplementation(async () => state.tabs.activeTabId)
  const inventory = () => {
    const rows = allocated.map(item => ({ ...item.view }))
    if (!rows.length) return rows
    if (startupFault === 'inventory-missing') return []
    if (startupFault === 'inventory-stale') rows[0].launchState = 'stopped'
    if (startupFault === 'inventory-profile') rows[0].profile = 'test_fixture'
    if (startupFault === 'inventory-ambiguous') rows.push({ ...rows[0], soulId: 'ambiguous-soul' })
    if (startupFault === 'inventory-other-alias') rows[0].freshAgentSessionId = 'unrelated-original-presentation'
    if (inventoryAfterHistory > 1 && startupFault?.startsWith('current-')) {
      if (startupFault === 'current-soul') rows[0].soulId = 'changed-current-soul'
      if (startupFault === 'current-incarnation') rows[0].incarnationId = 'changed-current-incarnation'
      if (startupFault === 'current-root') rows[0].nativeSessionId = 'changed-current-root'
      if (startupFault === 'current-profile') rows[0].profile = 'test_fixture'
      if (startupFault === 'current-type') rows[0].freshAgentSessionType = 'freshcodex'
      if (startupFault === 'current-presentation') rows[0].freshAgentSessionId = 'changed-presentation'
      if (startupFault === 'current-host') rows[0].hostBootId = 'changed-boot'
      if (startupFault === 'current-container') rows[0].containerId = 'f'.repeat(64)
      if (startupFault === 'current-intent') rows[0].intentRevision = 2
      if (startupFault === 'current-ambiguous') rows.push({ ...rows[0], incarnationId: 'ambiguous-current-incarnation' })
    }
    return rows
  }
  const descriptor = external.resolveManagedExternalDescriptor(owned)!
  const transport = vi.fn(async (_url: string, init: RequestInit) => {
    const request = JSON.parse(String(init.body))
    if (startup === 'presentation' && current()?.tabId
      && state.panes.layouts[current().tabId].content.sessionId === current().sessionId) promote(current())
    if (original.history.mock.calls.length) inventoryAfterHistory++
    expect(request.action).toBe('inventory')
    expect(request).toMatchObject({ runId: descriptor.runId, candidateSha: descriptor.candidateSha,
      scenarioId: 'browser-managed-runtime' })
    return new Response(JSON.stringify({ runId: startupFault === 'reply-run' ? '22222222-2222-4222-8222-222222222222' : request.runId, candidateSha: request.candidateSha,
      operationId: request.operationId, result: inventory() }), { status: 200 })
  })
  const externalRig = new external.ExternalManagedRuntimeRig(descriptor, transport)
  const lookups = vi.spyOn(externalRig, 'runningViewForFreshSession')
  original.rig = {
    repoRoot: '/controlled/checkout',
    runningViewForFreshSession: externalRig.runningViewForFreshSession.bind(externalRig),
    exactRuntimeHandle: externalRig.exactRuntimeHandle.bind(externalRig),
    fixtureNativeState: async () => ({ dispatchCount: current().dispatchCount ?? 1, completionCount: 1 }),
    inventory: externalRig.inventory.bind(externalRig),
  }
  original.history.mockClear().mockImplementation(async (...args: any[]) => {
    if (actualHistoryHelper) return actualHistoryHelper(...args)
    const index = allocated.length - 1
    if (continuity?.advance || continuity?.pendingNative) {
      const before = structuredClone(state)
      const snapshot = { ...structuredClone(state.managedRuntime), revision: state.managedRuntime.revision + 1 }
      const soul = snapshot.souls.find((row: any) => row.soulId === current().view.soulId)
      if (continuity.advance) {
        soul.allocationState = 'verified_durable'; soul.durabilityState = 'resume_captured'
      }
      if (continuity.pendingNative && (continuity.advance || continuity.captureNative)) soul.nativeSessionId = current().view.nativeSessionId
      fold(snapshot)
      historySnapshots.push({ before, after: structuredClone(state) })
    }
    const attach = (item: any) => {
      const root = state.panes.layouts[item.tabId]
      return { type: 'freshAgent.attach', ...(root.type === 'split' ? root.children[0].content : root.content) }
    }
    const messages = allocated.map(attach)
    if (index === 1 && fault) {
      const target = messages.at(-1)!
      if (fault === 'unknown') messages.push({ ...target, sessionId: 'unowned-session' })
      if (fault === 'provider') messages[0].provider = 'opencode'
      if (fault === 'mode') messages[0].sessionType = 'kilroy'
      if (fault === 'root') messages[0].sessionRef = { provider: 'claude', sessionId: 'wrong-root' }
      if (fault === 'create') messages.push({ ...messages[0], type: 'freshAgent.create' })
      if (fault === 'send') messages.push({ ...target, type: 'freshAgent.send' })
      if (fault === 'missing-target') messages.pop()
      if (fault === 'new-allocation') allocated.push({ view: { ...current().view, soulId: 'new-soul',
        freshAgentSessionId: 'new-allocation-presentation' } })
      if (fault === 'resume' || fault === 'create-owner') messages[index] = {
        ...target, type: 'freshAgent.create', tabId: current().tabId,
        requestId: fault === 'create-owner' ? 'unowned-request' : target.createRequestId,
      }
    }
    continuity?.mutate?.(state, current())
    for (const message of messages) frame(message)
  })
  if (fault === 'misbound-pane') original.state.mockImplementation(async () => {
    const snapshot = structuredClone(state)
    if (allocated.length === 2 && observedNativePane) snapshot.panes.layouts['tab-1'].content.sessionId = allocated[0].view.nativeSessionId
    return snapshot
  })
  const run = original.cases.get('completed owned native fixture history opens its existing browser pane')!({ page })
  // Own the polling clock and join the actual callback, including its finally,
  // before a caller can fail an assertion and restore shared mocks or timers.
  // Observe rejection immediately, but keep the original promise for the caller's
  // resolution/error assertions instead of turning refusal into success.
  const settlement = Promise.allSettled([run])
  await vi.runAllTimersAsync()
  await settlement
  expect(vi.getTimerCount()).toBe(0)
  return { run, allocated, lookups, transport, promotions, observedStartupIds, page, state, historySnapshots, sends: () => sendCount }
}

describe('managed History startup inventory binding', () => {
  it('joins the original polling failure and asynchronous rig cleanup before returning the fixture', async () => {
    vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    vi.useFakeTimers()
    const { run } = await historyCallback(undefined, 'native', 'ack-request')
    try {
      expect(original.stop).toHaveBeenCalledOnce()
      expect(original.stop.mock.settledResults[0]?.type).toBe('fulfilled')
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      await vi.runAllTimersAsync()
      await expect(run).rejects.toThrow(/timed out waiting for owned fixture activation/)
    }
  })

  it.each(['presentation', 'native'] as const)('uses the original acknowledgement with %s startup identity through all four modes', async startup => {
    vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    const { run, allocated, lookups, transport, promotions, observedStartupIds, sends } = await historyCallback(undefined, startup)
    await expect(run).resolves.toBeUndefined()
    expect(allocated).toHaveLength(4)
    expect(promotions).toEqual([0, 1, 2, 3])
    expect(observedStartupIds).toEqual(allocated.map(item => startup === 'native' ? item.view.nativeSessionId : item.sessionId))
    expect(lookups.mock.calls.map(([alias]) => alias)).toEqual(allocated.flatMap(item => [item.sessionId, item.sessionId]))
    expect(sends()).toBe(4)
    expect(original.history).toHaveBeenCalledTimes(4)
    expect(original.stop).toHaveBeenCalledOnce()
    expect(new Set(transport.mock.calls.map(([, init]) => JSON.parse(String(init.body)).operationId)).size).toBe(transport.mock.calls.length)
  })

  it.each<StartupFault>(['ack-request', 'ack-mode', 'ack-provider', 'ack-runtime-provider', 'ack-root', 'ack-missing-root', 'ack-duplicate',
    'create-tab', 'pane-request', 'pane-mode', 'pane-provider', 'pane-root', 'pane-soul', 'pane-incarnation',
    'inventory-missing', 'inventory-stale', 'inventory-ambiguous', 'inventory-other-alias', 'inventory-profile', 'reply-run',
    'current-soul', 'current-incarnation', 'current-root', 'current-ambiguous',
    'current-profile', 'current-type', 'current-presentation', 'current-host', 'current-container', 'current-intent'])(
    'refuses %s through the actual callback and closes exactly once', async startupFault => {
      const phases: string[] = []
      vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
        for (const event of external.parseManagedHistoryDiagnosticText(String(chunk))) {
          if (event.state === 'failed') phases.push(event.phase!)
        }
        return true
      })
      const { run, allocated, lookups, sends } = await historyCallback(undefined, 'native', startupFault)
      const cause: Record<StartupFault, RegExp> = {
        'ack-request': /timed out waiting for owned fixture activation/,
        'ack-mode': /freshopencode/, 'ack-provider': /opencode/, 'ack-runtime-provider': /opencode/,
        'ack-root': /wrong-ack-root/, 'ack-missing-root': /Received: undefined/, 'ack-duplicate': /Received length: 2/, 'create-tab': /other-tab/,
        'pane-request': /Received length: 0/, 'pane-mode': /freshopencode/, 'pane-provider': /opencode/,
        'pane-root': /wrong-pane-root/, 'pane-soul': /other-pane-soul/, 'pane-incarnation': /stale-pane-incarnation/,
        'inventory-missing': /timed out waiting for owned fixture activation/,
        'inventory-stale': /timed out waiting for owned fixture activation/,
        'inventory-ambiguous': /Received length: 2/,
        'inventory-other-alias': /timed out waiting for owned fixture activation/,
        'inventory-profile': /test_fixture/, 'reply-run': /invalid run, candidate, operation or shape/,
        'current-soul': /changed-current-soul/, 'current-incarnation': /changed-current-incarnation/,
        'current-root': /changed-current-root/,
        'current-ambiguous': /Received length: 2/,
        'current-profile': /test_fixture/, 'current-type': /freshcodex/,
        'current-presentation': /Received: undefined/, 'current-host': /changed-boot/,
        'current-container': /ffffffff/, 'current-intent': /intentRevision/,
      }
      await expect(run).rejects.toThrow(cause[startupFault])
      const afterHistory = startupFault.startsWith('current-')
      expect(phases).toEqual([afterHistory ? 'history-current' : 'first-inventory'])
      expect(allocated).toHaveLength(1)
      expect(sends()).toBe(afterHistory ? 1 : 0)
      expect(original.history).toHaveBeenCalledTimes(afterHistory ? 1 : 0)
      if (startupFault === 'inventory-other-alias') expect(lookups.mock.calls.every(([alias]) => alias === 'created-0')).toBe(true)
      expect(original.stop).toHaveBeenCalledOnce()
    },
  )
})

function expectOnlyDurabilityAdvance(before: any, after: any) {
  const expected = structuredClone(before.panes.layouts)
  const summary = expected[before.tabs.activeTabId].content.recoverySummary
  summary.allocationState = 'verified_durable'
  summary.durabilityState = 'resume_captured'
  expect(after.panes.layouts).toStrictEqual(expected)
  expect(after.managedRuntime.revision).toBeGreaterThan(before.managedRuntime.revision)
}

function expectAllHistoryPhases(events: any[]) {
  const ordered = ['new-tab', 'picker-visible', 'picker-click', 'directory-fill', 'directory-enter', 'pane-observation',
    'first-inventory', 'composer-enabled', 'composer-fill', 'send', 'completion', 'native-pane', 'tab-count', 'layout',
    'inventory-before', 'history-open', 'history-pane-visible', 'history-active-tab', 'history-tab-count', 'history-layout',
    'history-inventory', 'history-wire', 'history-current', 'history-dispatch']
  for (const mode of ['freshclaude', 'kilroy', 'freshcodex', 'freshopencode']) {
    const phases = events.filter(event => event.event === 'managed_history_phase' && event.mode === mode)
    expect(phases.filter(event => event.state === 'end')).toHaveLength(24)
    expect(phases.filter(event => event.state === 'failed')).toEqual([])
    expect(phases.map(event => [event.phase, event.state])).toEqual(ordered.flatMap(phase => [[phase, 'begin'], [phase, 'end']]))
  }
}

describe('managed History checked continuity', () => {
  it('accepts corroborated atomic durability advancement through all four original modes', async () => {
    const events: any[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
      events.push(...external.parseManagedHistoryDiagnosticText(String(chunk))); return true
    })
    const { run, allocated, historySnapshots, sends, transport } = await historyCallback(undefined, 'native', undefined, undefined, { advance: true })
    try { await run } catch (error) {
      expect(events.filter(event => event.state === 'failed').map(event => event.phase)).toEqual(['history-layout'])
      expect(sends()).toBe(1)
      expect(allocated).toHaveLength(1)
      expect(original.stop).toHaveBeenCalledOnce()
      const { before, after } = historySnapshots[0]
      expectOnlyDurabilityAdvance(before, after)
      throw error
    }
    expect(allocated).toHaveLength(4)
    expect(historySnapshots).toHaveLength(4)
    for (const { before, after } of historySnapshots) {
      expectOnlyDurabilityAdvance(before, after)
    }
    expectAllHistoryPhases(events)
    expect(sends()).toBe(4)
    expect(original.state).toHaveBeenCalledTimes(12)
    expect(original.layout).not.toHaveBeenCalled()
    expect(transport).toHaveBeenCalledTimes(24)
    expect(original.history).toHaveBeenCalledTimes(4)
    expect(original.stop).toHaveBeenCalledOnce()
  })

  it.each([false, true])('keeps unchanged observations and split geometry (durable=%s)', async verified => {
    vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    const { run, allocated, sends } = await historyCallback(undefined, 'native', undefined, undefined, { split: true, verified })
    await expect(run).resolves.toBeUndefined()
    expect(allocated).toHaveLength(4)
    expect(sends()).toBe(4)
    expect(original.stop).toHaveBeenCalledOnce()
  })

  it.each(['pending', 'native-recorded', 'durable'] as const)(
    'accepts the independently materialized native pane while authority becomes %s through all four modes', async observation => {
      const events: any[] = []
      vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
        events.push(...external.parseManagedHistoryDiagnosticText(String(chunk))); return true
      })
      const { run, allocated, historySnapshots, sends, transport } = await historyCallback(undefined, 'native', undefined, undefined, {
        pendingNative: true, captureNative: observation === 'native-recorded', advance: observation === 'durable',
      })
      try { await run } finally {
        expect(original.stop).toHaveBeenCalledOnce()
        for (const { before, after } of historySnapshots) {
          const item = allocated.find(item => item.tabId === before.tabs.activeTabId)!
          const prior = before.managedRuntime.souls.find((row: any) => row.soulId === item.view.soulId)
          const current = after.managedRuntime.souls.find((row: any) => row.soulId === item.view.soulId)
          expect(prior.nativeSessionId).toBeUndefined()
          expect(prior).toMatchObject({ allocationState: 'materializing', durabilityState: 'unknown', freshAgentSessionId: item.sessionId })
          expect(current.nativeSessionId).toBe(observation === 'pending' ? undefined : item.view.nativeSessionId)
          expect(current.freshAgentSessionId).toBe(item.sessionId)
          for (const state of [before, after]) expect(state.panes.layouts[item.tabId].content).toMatchObject({
            sessionId: item.view.nativeSessionId, resumeSessionId: item.view.nativeSessionId,
            sessionRef: { provider: item.view.provider === 'kilroy' ? 'claude' : item.view.provider, sessionId: item.view.nativeSessionId },
          })
          if (observation === 'durable') expectOnlyDurabilityAdvance(before, after)
          else expect(after.panes.layouts).toStrictEqual(before.panes.layouts)
        }
      }
      expect(historySnapshots).toHaveLength(4)
      expect(allocated).toHaveLength(4)
      expectAllHistoryPhases(events)
      expect(sends()).toBe(4)
      expect(original.state).toHaveBeenCalledTimes(12)
      expect(original.layout).not.toHaveBeenCalled()
      expect(transport).toHaveBeenCalledTimes(24)
      expect(original.history).toHaveBeenCalledTimes(4)
    },
  )

  const content = (state: any, item: any) => {
    const root = state.panes.layouts[item.tabId]
    return root.type === 'split' ? root.children[0].content : root.content
  }
  const soul = (state: any, item: any) => state.managedRuntime.souls.find((row: any) => row.soulId === item.view.soulId)
  const view = (state: any, item: any) => state.managedRuntime.viewIntents.find((row: any) => row.soulId === item.view.soulId)

  const publishCheckpoint = (state: any, item: any) => {
    const pane = content(state, item)
    const outcome = { version: 1 as const, requestId: `checkpoint-${item.paneId}`,
      conversationRequestId: pane.createRequestId,
      conversationSessionKey: freshAgentCheckpointConversationKeyForContent(pane),
      status: 'available' as const, checkpointId: `saved-${item.paneId}`, workspace: pane.checkpointWorkspace }
    state.panes = structuredClone(panesReducer(state.panes, mergePaneContent({ tabId: item.tabId,
      paneId: item.paneId, updates: { checkpointOutcomes: [outcome] } })))
  }

  it('accepts asynchronous checkpoint publication while the original History case reuses each existing pane', async () => {
    const events: any[] = [], publications: any[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
      events.push(...external.parseManagedHistoryDiagnosticText(String(chunk))); return true
    })
    const { run, allocated, sends } = await historyCallback(undefined, 'native', undefined, undefined, {
      advance: true, split: true, mutate: (state, item) => {
        expect(content(state, item).checkpointOutcomes).toBeUndefined()
        publishCheckpoint(state, item)
        if (item.tabId !== 'tab-0') state.panes.layouts['tab-0'].children[0].content.checkpointOutcomes[0].nativeTurnId = 'background-native-turn'
        publications.push(content(state, item).checkpointOutcomes)
      },
    })
    await expect(run).resolves.toBeUndefined()
    expect(publications).toHaveLength(4)
    expect(publications.every(outcomes => outcomes[0].status === 'available')).toBe(true)
    expect(allocated).toHaveLength(4)
    expect(sends()).toBe(4)
    expectAllHistoryPhases(events)
    expect(original.stop).toHaveBeenCalledOnce()
  })

  it.each(['turn-metadata', 'available-after-unavailable'] as const)(
    'accepts checkpoint hydration progress (%s) without replacing a pane', async progress => {
      vi.spyOn(process.stdout, 'write').mockReturnValue(true)
      const observed = new Set<string>()
      const { run, allocated, sends } = await historyCallback(undefined, 'native', undefined, undefined, {
        mutateSnapshot: (state, item) => {
          if (observed.has(item.paneId)) return
          observed.add(item.paneId)
          publishCheckpoint(state, item)
          const outcome = content(state, item).checkpointOutcomes[0]
          if (progress === 'available-after-unavailable') {
            outcome.status = 'unavailable'; outcome.code = 'capture_pending'; outcome.reason = 'Capture is settling'
            delete outcome.checkpointId
          }
        },
        mutate: (state, item) => {
          publishCheckpoint(state, item)
          if (progress === 'turn-metadata') content(state, item).checkpointOutcomes[0].nativeTurnId = 'native-turn'
        },
      })
      await expect(run).resolves.toBeUndefined()
      expect(allocated).toHaveLength(4)
      expect(sends()).toBe(4)
      expect(original.stop).toHaveBeenCalledOnce()
    },
  )

  it.each(['sessionId', 'model', 'split-sizes', 'extra-terminal'] as const)(
    'still rejects %s when checkpoint publication also occurs', async fault => {
      const failures: string[] = []
      vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
        failures.push(...external.parseManagedHistoryDiagnosticText(String(chunk)).filter(event => event.state === 'failed').map(event => event.phase!)); return true
      })
      const { run, allocated, sends } = await historyCallback(undefined, 'native', undefined, undefined, {
        split: true, mutate: (state, item) => {
          publishCheckpoint(state, item)
          if (fault === 'split-sizes') state.panes.layouts[item.tabId].sizes = [50, 50]
          else if (fault === 'extra-terminal') state.panes.layouts[item.tabId].children.push({
            type: 'leaf', id: 'unexpected-terminal', content: { kind: 'terminal', terminalId: 'unexpected' },
          })
          else content(state, item)[fault] = 'unexpected-' + fault
        },
      })
      await expect(run).rejects.toThrow()
      expect(failures).toEqual(['history-layout'])
      expect(allocated).toHaveLength(1)
      expect(sends()).toBe(1)
      expect(original.stop).toHaveBeenCalledOnce()
    },
  )
  it.each(['wrong-native', 'durable-missing', 'durable-baseline-missing', 'pending-disappeared'] as const)(
    'rejects %s authority while retaining the exact native pane', async fault => {
      const failures: string[] = [], snapshots: any[] = []
      vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
        failures.push(...external.parseManagedHistoryDiagnosticText(String(chunk)).filter(event => event.state === 'failed').map(event => event.phase!))
        return true
      })
      const { run, allocated, sends } = await historyCallback(undefined, 'native', undefined, undefined, {
        pendingNative: fault !== 'pending-disappeared', captureNative: fault === 'wrong-native',
        advance: fault === 'durable-missing', verified: fault === 'durable-baseline-missing',
        mutate: (state, item) => {
          if (fault === 'wrong-native') soul(state, item).nativeSessionId = 'wrong-observed-native'
          else if (fault !== 'durable-baseline-missing') delete soul(state, item).nativeSessionId
        },
        mutateSnapshot: state => { snapshots.push(state) },
      })
      const cause = fault === 'wrong-native' ? /wrong-observed-native/
        : fault === 'pending-disappeared' ? /Received: undefined/ : /materializing/
      try { await expect(run).rejects.toThrow(cause) } finally {
        expect(original.stop).toHaveBeenCalledOnce()
        const item = allocated[0], [before, after] = snapshots
        expect(soul(before, item).nativeSessionId).toBe(fault === 'pending-disappeared' ? item.view.nativeSessionId : undefined)
        expect(soul(after, item).nativeSessionId).toBe(fault === 'wrong-native' ? 'wrong-observed-native' : undefined)
        for (const state of [before, after]) expect(content(state, item)).toMatchObject({
          sessionId: item.view.nativeSessionId, resumeSessionId: item.view.nativeSessionId,
          sessionRef: { provider: 'claude', sessionId: item.view.nativeSessionId },
        })
        if (fault === 'durable-missing') expectOnlyDurabilityAdvance(before, after)
        else expect(after.panes.layouts).toStrictEqual(before.panes.layouts)
      }
      expect(snapshots).toHaveLength(2)
      expect(failures).toEqual(['history-layout'])
      expect(allocated).toHaveLength(1)
      expect(sends()).toBe(1)
    },
  )

  it('rejects the same wrong projected view ID in both original History snapshots', async () => {
    const events: any[] = [], snapshots: any[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
      events.push(...external.parseManagedHistoryDiagnosticText(String(chunk))); return true
    })
    const wrongViewId = 'nonexistent-projected-view'
    const { run, allocated, sends } = await historyCallback(undefined, 'native', undefined, undefined, {
      advance: true, mutateSnapshot: (state, item) => {
        content(state, item).viewIntentId = wrongViewId
        snapshots.push(state)
      },
    })
    try { await expect(run).rejects.toThrow(/viewId/) } finally {
      expect(original.stop).toHaveBeenCalledOnce()
      const [before, after] = snapshots
      const expectedView = expect.objectContaining({ viewId: 'view-pane-0', soulId: allocated[0].view.soulId,
        preferredTabId: 'tab-0', preferredPaneId: 'pane-0' })
      for (const state of [before, after]) {
        expect(content(state, allocated[0]).viewIntentId).toBe(wrongViewId)
        expect(state.managedRuntime.viewIntents).toEqual([expectedView])
      }
      expect(after.managedRuntime.viewIntents).toStrictEqual(before.managedRuntime.viewIntents)
      expectOnlyDurabilityAdvance(before, after)
    }
    expect(events.filter(event => event.state === 'failed').map(event => event.phase)).toEqual(['history-layout'])
    expect(snapshots).toHaveLength(2)
    expect(allocated).toHaveLength(1)
    expect(sends()).toBe(1)
  })

  const mutations: [string, (state: any, item: any) => void][] = [
    ...['createRequestId', 'provider', 'sessionType', 'sessionId', 'resumeSessionId', 'soulId', 'incarnationId', 'viewIntentId', 'model'].map(key =>
      [key, (state: any, item: any) => { content(state, item)[key] = 'changed-' + key }] as [string, (state: any, item: any) => void]),
    ['sessionRef', (state, item) => { content(state, item).sessionRef.sessionId = 'wrong-native-root' }],
    ['view-revision', (state, item) => { content(state, item).viewIntentRevision++ }],
    ['soul-intent', (state, item) => { content(state, item).soulIntentRevision++ }],
    ...['reason', 'recoveryState', 'desiredState', 'attemptId', 'incidentId'].map(key =>
      ['summary-' + key, (state: any, item: any) => { content(state, item).recoverySummary[key] = 'changed-' + key }] as [string, (state: any, item: any) => void]),
    ['missing-pair', (state, item) => { delete content(state, item).recoverySummary.allocationState }],
    ['partial-pair', (state, item) => {
      for (const row of [content(state, item).recoverySummary, soul(state, item)]) row.durabilityState = 'unknown'
    }],
    ['partial-allocation', (state, item) => {
      for (const row of [content(state, item).recoverySummary, soul(state, item)]) row.allocationState = 'materializing'
    }],
    ['unknown-pair', (state, item) => {
      for (const row of [content(state, item).recoverySummary, soul(state, item)]) row.allocationState = 'unknown'
    }],
    ['checkpoint', (state, item) => {
      for (const row of [content(state, item).recoverySummary, soul(state, item)]) row.durabilityState = 'checkpoint_captured'
    }],
    ['uncorroborated-pair', (state, item) => { soul(state, item).allocationState = 'materializing'; soul(state, item).durabilityState = 'unknown' }],
    ['missing-soul', (state) => { state.managedRuntime.souls = [] }],
    ['duplicate-soul', (state, item) => { state.managedRuntime.souls.push({ ...soul(state, item), nativeSessionId: 'wrong-duplicate-root' }) }],
    ['duplicate-native-owner', (state, item) => { state.managedRuntime.souls.push({ ...soul(state, item), soulId: 'other-soul-owner' }) }],
    ['missing-view', (state) => { state.managedRuntime.viewIntents = [] }],
    ['duplicate-view', (state, item) => { state.managedRuntime.viewIntents.push({ ...view(state, item), preferredPaneId: 'wrong-duplicate-pane' }) }],
    ['duplicate-pane-owner', (state, item) => { state.managedRuntime.viewIntents.push({ ...view(state, item), viewId: 'other-view-owner' }) }],
    ['stale-snapshot', (state) => { state.managedRuntime.revision = 0 }],
    ...['nativeSessionId', 'profile', 'provider', 'freshAgentSessionId', 'freshAgentSessionType', 'freshAgentCreateRequestId',
      'soulId', 'incarnationId', 'containerId', 'hostBootId', 'freshAgentRuntimeVariant'].map(key =>
      ['soul-' + key, (state: any, item: any) => { soul(state, item)[key] = 'changed-' + key }] as [string, (state: any, item: any) => void]),
    ['soul-intent-revision', (state, item) => { soul(state, item).intentRevision++ }],
    ['execution-generation', (state, item) => { soul(state, item).executionGeneration++ }],
    ['missing-intent', (state, item) => { delete soul(state, item).intentRevision }],
    ['missing-native-reference', (state, item) => { delete content(state, item).sessionRef }],
    ['missing-durability', (state, item) => { delete content(state, item).recoverySummary.durabilityState }],
    ['authoritative-launch-state', (state, item) => { soul(state, item).launchState = 'stopped' }],
    ['view-soul', (state, item) => { view(state, item).soulId = 'wrong-view-soul' }],
    ['view-pane', (state, item) => { view(state, item).preferredPaneId = 'wrong-view-pane' }],
    ['view-tab', (state, item) => { view(state, item).preferredTabId = 'wrong-view-tab' }],
    ['view-kind', (state, item) => { view(state, item).kind = 'explicit' }],
    ['missing-view-revision', (state, item) => { delete view(state, item).revision }],
    ['view-placement', (state, item) => { view(state, item).placementGroup = 'changed-group' }],
    ['leaf-id', (state, item) => { state.panes.layouts[item.tabId].children[0].id = 'changed-leaf' }],
    ['leaf-type', (state, item) => { state.panes.layouts[item.tabId].children[0].type = 'split'; state.panes.layouts[item.tabId].children[0].children = [] }],
    ['content-kind', (state, item) => { content(state, item).kind = 'terminal' }],
    ['root-id', (state, item) => { state.panes.layouts[item.tabId].id = 'changed-root' }],
    ['split-direction', (state, item) => { state.panes.layouts[item.tabId].direction = 'vertical' }],
    ['split-sizes', (state, item) => { state.panes.layouts[item.tabId].sizes = [50, 50] }],
    ['split-order', (state, item) => { state.panes.layouts[item.tabId].children.reverse() }],
    ['added-leaf', (state, item) => { state.panes.layouts[item.tabId].children.push({ type: 'leaf', id: 'extra', content: { kind: 'browser', url: 'https://extra.invalid' } }) }],
    ['removed-leaf', (state, item) => { state.panes.layouts[item.tabId].children.pop() }],
    ['other-leaf-content', (state, item) => { state.panes.layouts[item.tabId].children[1].content.url = 'https://changed.invalid' }],
    ['background-owner', (state) => { state.panes.layouts['tab-0'].children[0].content.sessionId = 'wrong-background-native' }],
  ]
  it.each(mutations)('rejects %s through the original History continuity guard', async (name, mutate) => {
    const failures: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
      failures.push(...external.parseManagedHistoryDiagnosticText(String(chunk)).filter(event => event.state === 'failed').map(event => event.phase!))
      return true
    })
    const background = name === 'background-owner'
    const { run, allocated, sends } = await historyCallback(undefined, 'native', undefined, undefined, {
      advance: true, split: true, mutate: (state, item) => { if (!background || item.tabId === 'tab-1') mutate(state, item) },
    })
    await expect(run).rejects.toThrow()
    expect(failures).toEqual(['history-layout'])
    expect(allocated).toHaveLength(background ? 2 : 1)
    expect(sends()).toBe(background ? 2 : 1)
    expect(original.stop).toHaveBeenCalledOnce()
  })

  it('rejects a fully corroborated backwards durability pair', async () => {
    const failures: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
      failures.push(...external.parseManagedHistoryDiagnosticText(String(chunk)).filter(event => event.state === 'failed').map(event => event.phase!)); return true
    })
    const { run } = await historyCallback(undefined, 'native', undefined, undefined, { verified: true,
      mutate: (state, item) => {
        for (const row of [content(state, item).recoverySummary, soul(state, item)]) {
          row.allocationState = 'materializing'; row.durabilityState = 'unknown'
        }
      } })
    await expect(run).rejects.toThrow(/materializing/)
    expect(failures).toEqual(['history-layout'])
    expect(original.stop).toHaveBeenCalledOnce()
  })

  it.each(['new-tab', 'dispatch-two'] as const)('retains the later %s guard with valid continuity', async fault => {
    const failures: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
      failures.push(...external.parseManagedHistoryDiagnosticText(String(chunk)).filter(event => event.state === 'failed').map(event => event.phase!)); return true
    })
    const { run, sends, allocated } = await historyCallback(undefined, 'native', undefined, undefined, { advance: true,
      mutate: (state, item) => {
        if (fault === 'new-tab') state.tabs.tabs.push({ id: 'unexpected-tab' })
        else item.dispatchCount = 2
      } })
    await expect(run).rejects.toThrow()
    expect(failures).toEqual([fault === 'new-tab' ? 'history-tab-count' : 'history-dispatch'])
    expect(sends()).toBe(1)
    expect(allocated).toHaveLength(1)
    expect(original.stop).toHaveBeenCalledOnce()
  })
})

describe('managed History original wire ownership', () => {
  it('accepts each allocation-backed background attach while requiring the target through all four modes', async () => {
    vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    const { run, allocated } = await historyCallback()
    await expect(run).resolves.toBeUndefined()
    expect(allocated).toHaveLength(4)
    expect(original.history).toHaveBeenCalledTimes(4)
    expect(original.stop).toHaveBeenCalledOnce()
  })

  it('accepts an explicit target resume without another allocation', async () => {
    vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    const { run, allocated } = await historyCallback('resume')
    await expect(run).resolves.toBeUndefined()
    expect(allocated).toHaveLength(4)
    expect(original.stop).toHaveBeenCalledOnce()
  })

  it.each<HistoryFault>(['unknown', 'provider', 'mode', 'root', 'misbound-pane', 'create', 'create-owner', 'send', 'missing-target', 'new-allocation'])(
    'rejects %s ownership or activity through the original callback and closes the rig', async fault => {
      vi.spyOn(process.stdout, 'write').mockReturnValue(true)
      const { run, allocated } = await historyCallback(fault)
      const cause: Partial<Record<HistoryFault, RegExp>> = {
        unknown: /Received length: 0/,
        provider: /opencode/, mode: /kilroy/, root: /wrong-root/, 'misbound-pane': /11111111-1111-4111-8111-000000000000/,
        create: /freshclaude/, 'create-owner': /unowned-request/, send: /freshAgent.send/,
        'missing-target': /timed out waiting for actual owned History wire ingress/,
        'new-allocation': /new-soul/,
      }
      await expect(run).rejects.toThrow(cause[fault])
      expect(allocated).toHaveLength(fault === 'new-allocation' ? 3 : 2)
      expect(original.history).toHaveBeenCalledTimes(fault === 'misbound-pane' ? 1 : 2)
      expect(original.stop).toHaveBeenCalledOnce()
    },
  )
})

const historyIdentity = { repoRoot: '/private-owned-checkout', provider: 'claude', nativeSessionId: 'private-native-root' }
const directoryPage = () => ({ items: [{ provider: 'claude', sessionId: historyIdentity.nativeSessionId,
  projectPath: historyIdentity.repoRoot, cwd: historyIdentity.repoRoot, checkoutPath: historyIdentity.repoRoot,
  title: 'PRIVATE-BODY', firstUserMessage: 'PRIVATE-PROMPT', lastActivityAt: 1, isRunning: false }],
  nextCursor: null, revision: 1, snapshotSeq: 7, partial: false })
const directoryRequest = (query = '?query=PRIVATE-QUERY&tier=fullText&limit=50&includeKeys=PRIVATE-KEY,OTHER-PRIVATE-KEY') => ({
  url: () => 'https://private.invalid/api/session-directory' + query,
  method: () => 'GET', failure: () => ({ errorText: 'PRIVATE-ERROR net::ERR_ABORTED' }),
})

describe('managed History passive directory and window diagnostics', () => {
  it('correlates overlapping actual responses and emits only validated safe facts through the reporter', async () => {
    const { retained, emit } = reporterPath()
    const observation = new external.ManagedHistoryAwaitedPhases(emit)
    const page = new EventEmitter()
    const observer = new external.ManagedHistoryDirectoryResponses(page as any, observation, 'freshclaude', historyIdentity)
    observer.begin(Date.now() + 60_000)
    const first = directoryRequest(), second = directoryRequest('?limit=50&includeEmpty=1')
    page.emit('request', first); page.emit('request', second)
    page.emit('response', { request: () => second, status: () => 200, body: async () => Buffer.from(JSON.stringify(directoryPage())) })
    page.emit('response', { request: () => first, status: () => 200, body: async () => Buffer.from(JSON.stringify({ ...directoryPage(),
      items: [{ ...directoryPage().items[0], lastActivityAt: 'PRIVATE-SCHEMA-VALUE' }] })) })
    await observer.settle()
    await observer.close()
    const events = external.parseManagedHistoryDiagnosticText(retained.join('')).filter(event => event.event === 'managed_history_directory') as any[]
    expect(events.map(event => [event.requestSeq, event.stage, event.order])).toEqual([
      [1, 'request', 1], [2, 'request', 2], [2, 'response', 3], [1, 'response', 4], [2, 'body', 5], [1, 'body', 6],
    ])
    expect(events[0]).toMatchObject({ method: 'GET', route: 'session-directory', query: { queryEmpty: false, tier: 'other', limit: 50, includeKeysCount: 2 } })
    expect(events[1]).toMatchObject({ query: { queryEmpty: true, tier: 'title', includeEmpty: true } })
    expect(events[4]).toMatchObject({ status: 200, parseSuccess: true, itemCount: 1, exactIdentityCount: 1,
      nextCursorPresent: false, partial: false, integrity: 'none', snapshotSeq: 7,
      ownedContext: [{ projectMatches: true, cwdMatches: true, checkoutMatches: true }] })
    expect(events[5]).toMatchObject({ status: 200, parseSuccess: false, issues: [{ code: 'invalid_type', path: ['items', 'index', 'field'] }] })
    expect(events.every(event => event.runId === owned.FRESHELL_RUNTIME_EXTERNAL_RUN_ID)).toBe(true)
    for (const value of ['PRIVATE', 'private.invalid', historyIdentity.repoRoot, historyIdentity.nativeSessionId]) expect(retained.join('')).not.toContain(value)
    expect(page.eventNames()).toEqual([])
  })

  it('keeps non-ok, aborted, transport and unavailable body facts distinct without inventing status', async () => {
    const { retained, emit } = reporterPath()
    const page = new EventEmitter()
    const observer = new external.ManagedHistoryDirectoryResponses(page as any, new external.ManagedHistoryAwaitedPhases(emit), 'kilroy', historyIdentity)
    observer.begin(Date.now() + 60_000)
    const requests = Array.from({ length: 5 }, () => directoryRequest())
    requests.forEach(request => page.emit('request', request))
    const unread = vi.fn()
    page.emit('response', { request: () => requests[0], status: () => 503, body: unread })
    page.emit('requestfailed', requests[1])
    requests[2].failure = () => ({ errorText: 'PRIVATE-TRANSPORT-ERROR' })
    // Same request object is the actual transport correlation key.
    page.emit('requestfailed', requests[2])
    page.emit('response', { request: () => requests[3], status: () => 200, body: async () => { throw new Error('PRIVATE-BODY-ERROR') } })
    await observer.settle()
    page.emit('response', { request: () => requests[4], status: () => 200, body: () => new Promise(() => {}) })
    await observer.close()
    const events = external.parseManagedHistoryDiagnosticText(retained.join('')).filter(event => event.event === 'managed_history_directory') as any[]
    expect(events.find(event => event.requestSeq === 1 && event.stage === 'response')).toMatchObject({ status: 503, category: 'http-error' })
    expect(events.find(event => event.requestSeq === 2 && event.stage === 'failed')).toMatchObject({ category: 'aborted' })
    expect(events.find(event => event.requestSeq === 3 && event.stage === 'failed')).toMatchObject({ category: 'transport-failed' })
    expect(events.filter(event => event.stage === 'failed').every(event => event.status === undefined)).toBe(true)
    expect(events.find(event => event.requestSeq === 4 && event.stage === 'body')).toMatchObject({ category: 'body-unavailable', status: 200 })
    expect(events.find(event => event.requestSeq === 5 && event.stage === 'body')).toMatchObject({ category: 'unknown', status: 200 })
    expect(unread).not.toHaveBeenCalled()
    expect(retained.join('')).not.toContain('PRIVATE')
    expect(page.eventNames()).toEqual([])
  })

  it('executes the real projector over zero, committed and removed History windows', async () => {
    const helper = await vi.importActual<any>('../../../e2e-browser/helpers/managed-runtime.js')
    const { retained, emit } = reporterPath()
    const page = new EventEmitter()
    const observer = new external.ManagedHistoryDirectoryResponses(page as any, new external.ManagedHistoryAwaitedPhases(emit), 'freshcodex', historyIdentity)
    observer.begin(Date.now() + 60_000)
    const sessions: any = { activeSurface: 'history', projects: [], windows: { history: { projects: [], query: '', appliedQuery: '',
      searchTier: 'title', appliedSearchTier: 'title', resultVersion: 0, loading: true, loadingKind: 'initial', error: 'PRIVATE-ERROR' }, sidebar: { projects: [] } } }
    const project = { projectPath: historyIdentity.repoRoot, sessions: directoryPage().items }
    const read = () => {
      vi.stubGlobal('window', { __FRESHELL_TEST_HARNESS__: { getState: () => ({ sessions }) } })
      try { return helper.observeManagedHistoryWindow(historyIdentity) } finally { vi.unstubAllGlobals() }
    }
    observer.window('before-projects', read().facts)
    sessions.windows.history = { ...sessions.windows.history, projects: [project], resultVersion: 1, loading: false, lastLoadedAt: 4 }
    sessions.projects = [project]; sessions.windows.sidebar.projects = [project]
    const indexed = read()
    expect(indexed.indexed).toEqual([{ projectPath: historyIdentity.repoRoot, cwd: historyIdentity.repoRoot, checkoutPath: historyIdentity.repoRoot }])
    observer.window('indexed', indexed.facts)
    sessions.windows.history.projects = []
    observer.window('failed', read().facts)
    await observer.close()
    const events = external.parseManagedHistoryDiagnosticText(retained.join('')).filter(event => event.event === 'managed_history_window') as any[]
    expect(events.map(event => event.facts.exactIdentityCount)).toEqual([0, 1, 0])
    expect(events[0].facts).toMatchObject({ resultVersion: 0, loading: true, loadingKind: 'initial', errorPresent: true, lastLoadedAtPresent: false })
    expect(events[1].facts).toMatchObject({ resultVersion: 1, lastLoadedAtPresent: true, sidebarExactIdentityCount: 1, topLevelExactIdentityCount: 1,
      requestedQueryEmpty: true, appliedQueryEmpty: true, requestedTier: 'title', appliedTier: 'title', activeSurface: 'history' })
    expect(events[2].facts.resultVersion).toBe(1)
    expect(retained.join('')).not.toContain('PRIVATE')
    expect(retained.join('')).not.toContain(historyIdentity.repoRoot)
  })

  it('bounds request and read work at the original action deadline and removes only its listeners', async () => {
    vi.useFakeTimers()
    const { retained, emit } = reporterPath()
    const page = new EventEmitter()
    const foreign = vi.fn()
    page.on('response', foreign)
    const fetch = vi.spyOn(globalThis, 'fetch')
    const observer = new external.ManagedHistoryDirectoryResponses(page as any, new external.ManagedHistoryAwaitedPhases(emit), 'freshopencode', historyIdentity)
    const reads = Array.from({ length: 20 }, () => vi.fn(() => new Promise<Buffer>(() => {})))
    observer.begin(Date.now() + 60_000)
    const requests = reads.map(() => directoryRequest())
    requests.forEach(request => page.emit('request', request))
    reads.forEach((body, index) => page.emit('response', { request: () => requests[index], status: () => 200, body }))
    observer.captureWindow('before-projects', () => new Promise(() => {}))
    observer.captureWindow('before-refresh', async () => { throw new Error('PRIVATE-READ-ERROR') })
    await vi.advanceTimersByTimeAsync(60_000)
    await observer.close()
    const events = external.parseManagedHistoryDiagnosticText(retained.join('')) as any[]
    expect(events.filter(event => event.stage === 'request')).toHaveLength(8)
    expect(events.filter(event => event.stage === 'body' && event.category === 'unknown')).toHaveLength(8)
    expect(events.filter(event => event.event === 'managed_history_window').map(event => event.facts)).toEqual([{ available: false }, { available: false }])
    expect(reads.slice(0, 8).every(read => read.mock.calls.length === 1)).toBe(true)
    expect(reads.slice(8).every(read => read.mock.calls.length === 0)).toBe(true)
    expect(page.listeners('response')).toEqual([foreign])
    expect(page.listenerCount('request')).toBe(0)
    expect(page.listenerCount('requestfailed')).toBe(0)
    expect(fetch).not.toHaveBeenCalled()
    expect(retained.join('')).not.toContain('PRIVATE')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('preserves the original helper assertion, action order and exact state read while diagnostics observe', async () => {
    const helper = await vi.importActual<any>('../../../e2e-browser/helpers/managed-runtime.js')
    const { retained, emit } = reporterPath()
    const calls: string[] = []
    const state: any = { sessions: { activeSurface: 'history', windows: { history: { projects: [] }, sidebar: { projects: [] } }, projects: [] } }
    const page: any = new EventEmitter()
    const locator: any = {
      constructor: { name: 'Locator' }, _expect: async () => ({ matches: true, received: '', log: [] }),
      getByRole: () => locator, isVisible: async () => true,
      click: async () => { calls.push('open'); },
    }
    page.getByRole = (_role: string, options: any) => ({ ...locator, click: async () => {
      calls.push(options.name === 'Refresh sessions' ? 'refresh' : 'projects')
    } })
    page.locator = () => locator
    page.evaluate = async (operation: any, argument: any) => {
      vi.stubGlobal('window', { __FRESHELL_TEST_HARNESS__: { getState: () => state } })
      try { return operation(argument) } finally { vi.unstubAllGlobals() }
    }
    const observer = new external.ManagedHistoryDirectoryResponses(page, new external.ManagedHistoryAwaitedPhases(emit), 'freshclaude', historyIdentity)
    let failure: unknown
    const cleanup = vi.fn()
    try { await helper.openFreshHistorySession(page, historyIdentity, observer) } catch (error) { failure = error } finally {
      await observer.close(); cleanup()
    }
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toMatch(/Expected length: 1/)
    expect((failure as Error).message).toMatch(/Received length: 0/)
    expect(calls).toEqual(['projects', 'refresh'])
    expect(cleanup).toHaveBeenCalledOnce()
    const events = external.parseManagedHistoryDiagnosticText(retained.join('')).filter(event => event.event === 'managed_history_window') as any[]
    expect(events.map(event => event.stage)).toEqual(['before-projects', 'before-refresh', 'indexed', 'failed'])
    expect(events.find(event => event.stage === 'indexed').facts.exactIdentityCount).toBe(0)
    expect(page.eventNames()).toEqual([])

    // The same helper reaches Open exactly once when the actual indexed row exists.
    state.sessions.windows.history.projects = [{ projectPath: historyIdentity.repoRoot, sessions: directoryPage().items }]
    const observe = new external.ManagedHistoryDirectoryResponses(page, new external.ManagedHistoryAwaitedPhases(emit), 'freshclaude', historyIdentity)
    await helper.openFreshHistorySession(page, historyIdentity, observe)
    await observe.close()
    expect(calls).toEqual(['projects', 'refresh', 'projects', 'refresh', 'open'])
    expect(page.eventNames()).toEqual([])
  })

  it('rethrows an identical helper operation error when diagnostic callbacks themselves fail', async () => {
    const helper = await vi.importActual<any>('../../../e2e-browser/helpers/managed-runtime.js')
    const error = new Error('PRIVATE-ORIGINAL-ERROR')
    const diagnosticError = new Error('PRIVATE-DIAGNOSTIC-ERROR')
    const cleanup = vi.fn()
    const observation = { begin: () => { throw diagnosticError }, captureWindow: () => { throw diagnosticError }, window: () => { throw diagnosticError } }
    const page: any = { getByRole: () => ({ click: async () => { throw error } }) }
    const run = async () => { try { await helper.openFreshHistorySession(page, historyIdentity, observation) } finally { cleanup() } }
    await expect(run()).rejects.toBe(error)
    expect(cleanup).toHaveBeenCalledOnce()
  })

  it('propagates the real helper indexed failure through the original browser callback and its actual rig cleanup', async () => {
    const helper = await vi.importActual<any>('../../../e2e-browser/helpers/managed-runtime.js')
    vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    const { run, allocated, page, sends } = await historyCallback(undefined, 'native', undefined, helper.openFreshHistorySession)
    await expect(run).rejects.toThrow(/Received length: 0/)
    expect(allocated).toHaveLength(1)
    expect(sends()).toBe(1)
    expect(original.history).toHaveBeenCalledOnce()
    expect(original.stop).toHaveBeenCalledOnce()
    expect(page.off.mock.calls.map(([event]: [string]) => event)).toEqual(['request', 'response', 'requestfailed'])
  })

  it('keeps the existing stream and line limits while accepting safe diagnostics', () => {
    const { retained, emit } = reporterPath()
    const observation = new external.ManagedHistoryAwaitedPhases(emit)
    for (let index = 0; index < 300; index++) observation.window('freshclaude', 'indexed', { available: true, exactIdentityCount: index })
    expect(external.parseManagedHistoryDiagnosticText(retained.join(''))).toHaveLength(256)
    const tooLong = retained[0].trimEnd() + ' '.repeat(8192)
    expect(external.parseManagedHistoryDiagnosticText(tooLong)).toEqual([])
  })
})
