// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TestCase, TestResult } from '@playwright/test/reporter'
import * as external from '../../../../scripts/testing/runtime-external-browser.js'

const original = vi.hoisted(() => ({
  cases: new Map<string, (context: any) => Promise<void>>(),
  start: vi.fn(), stop: vi.fn(), waitForHarness: vi.fn(), waitForConnection: vi.fn(),
}))
vi.mock('../../../e2e-browser/helpers/fixtures.js', () => ({
  test: Object.assign((title: string, callback: (context: any) => Promise<void>) => original.cases.set(title, callback), {
    describe: { serial: (_title: string, callback: () => void) => callback() }, skip: vi.fn(), setTimeout: vi.fn(),
  }),
}))
vi.mock('../../../e2e-browser/helpers/managed-runtime.js', () => ({
  createManagedRuntimeBrowserRig: () => ({ start: original.start, stop: original.stop }),
  openFreshHistorySession: vi.fn(),
}))
vi.mock('../../../e2e-browser/helpers/test-harness.js', () => ({
  TestHarness: class {
    waitForHarness = original.waitForHarness
    waitForConnection = original.waitForConnection
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

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })

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
