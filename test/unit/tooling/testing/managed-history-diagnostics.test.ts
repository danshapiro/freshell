// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TestCase, TestResult } from '@playwright/test/reporter'
import * as external from '../../../../scripts/testing/runtime-external-browser.js'
import { buildManagedRuntimeMergePlan } from '../../../../src/lib/recovery/managed-runtime-recovery.js'
import { EventEmitter } from 'node:events'

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

/** Execute the registered browser case, including its actual global collector and finally. */
async function historyCallback(fault?: HistoryFault, startup: 'presentation' | 'native' = 'presentation', startupFault?: StartupFault,
  actualHistoryHelper?: (...args: any[]) => Promise<void>) {
  await import('../../../e2e-browser/specs/runtime-fresh-agent-fixture-rust.spec.js')
  vi.stubEnv('FRESHELL_RUNTIME_FRESH_AGENT_FIXTURE_TEST', '1')
  const definitions = [
    ['freshclaude', 'claude'], ['kilroy', 'claude'], ['freshcodex', 'codex'], ['freshopencode', 'opencode'],
  ]
  const state: any = { tabs: { activeTabId: '', tabs: [] }, panes: { layouts: {} } }
  const allocated: any[] = []
  let observedNativePane = false
  let framesent!: (frame: { payload: string }) => void
  let framereceived: (frame: { payload: string }) => void = () => {}
  let sendCount = 0
  let inventoryAfterHistory = 0
  const promotions: number[] = []
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
        sessionType: content.sessionType, provider: content.provider }
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
      const view = { soulId: `soul-${index}`, incarnationId: `incarnation-${index}`, nativeSessionId: `native-${index}`,
        freshAgentSessionId: sessionId, freshAgentSessionType: sessionType,
        provider: sessionType === 'kilroy' ? 'kilroy' : provider, profile: 'default_agent',
        launchState: 'running', intentRevision: 1, containerId: String(index + 1).repeat(64), hostBootId: `boot-${index}` }
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
      },
    } : locator }),
    evaluate: async (operation: any, argument: any) => {
      vi.stubGlobal('window', { __FRESHELL_TEST_HARNESS__: { getState: () => state } })
      try { const result = operation(argument); observedNativePane = true; return result } finally { vi.unstubAllGlobals() }
    },
  }
  const promote = (item: any) => {
    const soul = { ...item.view, freshAgentCreateRequestId: `request-${allocated.indexOf(item)}`,
      desiredState: 'running', recoveryState: 'live' }
    const view = { viewId: `view-${item.paneId}`, soulId: item.view.soulId, revision: 1,
      kind: 'automatic_primary', visibility: 'visible', preferredTabId: item.tabId, preferredPaneId: item.paneId }
    const plan = buildManagedRuntimeMergePlan({ revision: 1, souls: [soul], viewIntents: [view] } as any, state)
    expect(plan.creates).toHaveLength(0)
    expect(plan.updates).toHaveLength(1)
    state.panes.layouts[item.tabId].content = plan.updates[0].content
    promotions.push(allocated.indexOf(item))
  }
  original.start.mockResolvedValue({ baseUrl: 'https://fixture.invalid', token: 'private-token' })
  original.stop.mockClear().mockResolvedValue({ ok: true, errors: [] })
  original.waitForHarness.mockResolvedValue(undefined)
  original.waitForConnection.mockResolvedValue(undefined)
  original.state.mockImplementation(async () => {
    if (allocated.length > sendCount) observedStartupIds.push(state.panes.layouts[current().tabId].content.sessionId)
    return structuredClone(state)
  })
  original.tabCount.mockImplementation(async () => state.tabs.tabs.length)
  original.layout.mockImplementation(async (tabId: string) => structuredClone(state.panes.layouts[tabId]))
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
    fixtureNativeState: async () => ({ dispatchCount: 1, completionCount: 1 }),
    inventory: externalRig.inventory.bind(externalRig),
  }
  original.history.mockClear().mockImplementation(async (...args: any[]) => {
    if (actualHistoryHelper) return actualHistoryHelper(...args)
    const index = allocated.length - 1
    const attach = (item: any) => ({ type: 'freshAgent.attach', ...state.panes.layouts[item.tabId].content })
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
    for (const message of messages) frame(message)
    // Cancel only the controlled probe's original 90s boundary; no host timer wedge.
    if (index === 1 && fault === 'missing-target') {
      const now = Date.now()
      vi.spyOn(Date, 'now').mockReturnValueOnce(now).mockReturnValue(now + 90_001)
    }
  })
  if (fault === 'misbound-pane') original.state.mockImplementation(async () => {
    const snapshot = structuredClone(state)
    if (allocated.length === 2 && observedNativePane) snapshot.panes.layouts['tab-1'].content.sessionId = 'native-0'
    return snapshot
  })
  const run = original.cases.get('completed owned native fixture history opens its existing browser pane')!({ page })
  void run.catch(() => {}) // Controlled clocks may settle refusal before the caller awaits it.
  return { run, allocated, lookups, transport, promotions, observedStartupIds, page, sends: () => sendCount }
}

describe('managed History startup inventory binding', () => {
  it.each(['presentation', 'native'] as const)('uses the original acknowledgement with %s startup identity through all four modes', async startup => {
    vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    vi.useFakeTimers()
    const { run, allocated, lookups, transport, promotions, observedStartupIds, sends } = await historyCallback(undefined, startup)
    await vi.advanceTimersByTimeAsync(90_001)
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
    'current-soul', 'current-incarnation', 'current-root', 'current-ambiguous'])(
    'refuses %s through the actual callback and closes exactly once', async startupFault => {
      const phases: string[] = []
      vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
        for (const event of external.parseManagedHistoryDiagnosticText(String(chunk))) {
          if (event.state === 'failed') phases.push(event.phase!)
        }
        return true
      })
      vi.useFakeTimers()
      const { run, allocated, lookups, sends } = await historyCallback(undefined, 'native', startupFault)
      await vi.advanceTimersByTimeAsync(90_001)
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
        provider: /opencode/, mode: /kilroy/, root: /wrong-root/, 'misbound-pane': /native-0/,
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
