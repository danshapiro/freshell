import { EventEmitter } from 'events'
import { describe, expect, it, vi } from 'vitest'
import { createWorkerListingRunner } from '../../../../server/coding-cli/providers/opencode-listing-runner'
import { THREE_VIEWS_MARKER_SQL_PATTERN } from '../../../../server/coding-cli/providers/opencode-listing-query'

class FakeWorker extends EventEmitter {
  terminated = 0
  postedData: unknown
  execArgv: string[]
  constructor(public url: URL, public options: { workerData: unknown; execArgv: string[] }) {
    super()
    this.postedData = options.workerData
    this.execArgv = options.execArgv
  }
  terminate() { this.terminated += 1; return Promise.resolve(0) }
  // helpers
  emitMessage(msg: unknown) { this.emit('message', msg) }
  emitError(err: Error) { this.emit('error', err) }
  emitExit(code: number) { this.emit('exit', code) }
}

function makeRunner(overrides: Partial<Parameters<typeof createWorkerListingRunner>[0]> = {}) {
  const workers: FakeWorker[] = []
  const spawn = vi.fn((url: URL, options: { workerData: unknown; execArgv: string[] }) => {
    const w = new FakeWorker(url, options)
    workers.push(w)
    return w
  })
  const runner = createWorkerListingRunner({ spawn: spawn as any, timeoutMs: 50, ...overrides })
  return { runner, workers, spawn }
}

const input = { dbPath: '/tmp/opencode.db', markerPattern: THREE_VIEWS_MARKER_SQL_PATTERN }

describe('createWorkerListingRunner', () => {
  it('resolves rows from an ok message and terminates the worker', async () => {
    const { runner, workers } = makeRunner()
    const promise = runner(input)
    await Promise.resolve()
    workers[0].emitMessage({ ok: true, rows: [{ sessionId: 's1' }], schemaMissingParentId: false })
    const result = await promise
    expect(result.rows).toEqual([{ sessionId: 's1' }])
    expect(result.schemaMissingParentId).toBe(false)
    expect(workers[0].terminated).toBe(1)
  })

  it('passes dbPath, markerPattern and a queryModuleUrl in workerData, and suppresses the experimental warning via execArgv', async () => {
    const { runner, workers } = makeRunner()
    const promise = runner(input)
    await Promise.resolve()
    const data = workers[0].postedData as any
    expect(data.dbPath).toBe(input.dbPath)
    expect(data.markerPattern).toBe(THREE_VIEWS_MARKER_SQL_PATTERN)
    expect(String(data.queryModuleUrl)).toContain('opencode-listing-query')
    expect(data.kind).toBe('opencode-listing-worker') // sentinel that gates the worker auto-run
    // Appended to process.execArgv so the tsx loader (dev) survives AND the
    // per-spawn node:sqlite ExperimentalWarning is silenced.
    expect(workers[0].execArgv).toEqual([...process.execArgv, '--disable-warning=ExperimentalWarning'])
    workers[0].emitMessage({ ok: true, rows: [], schemaMissingParentId: false })
    await promise
  })

  it('ignores a late exit event after a successful message (no double-settle)', async () => {
    const { runner, workers } = makeRunner()
    const promise = runner(input)
    await Promise.resolve()
    workers[0].emitMessage({ ok: true, rows: [{ sessionId: 's1' }], schemaMissingParentId: false })
    // A real Worker emits 'exit' after terminate(); the settled guard must swallow it.
    workers[0].emitExit(0)
    await expect(promise).resolves.toMatchObject({ rows: [{ sessionId: 's1' }] })
    expect(workers[0].terminated).toBe(1)
  })

  it('rejects on an error message and terminates', async () => {
    const { runner, workers } = makeRunner()
    const promise = runner(input)
    await Promise.resolve()
    workers[0].emitMessage({ ok: false, error: { name: 'SqliteError', message: 'boom' } })
    await expect(promise).rejects.toThrow(/boom/)
    expect(workers[0].terminated).toBe(1)
  })

  it.each([
    ['ok:true without rows', { ok: true, schemaMissingParentId: false }],
    ['ok:true with non-array rows', { ok: true, rows: 'nope', schemaMissingParentId: false }],
    ['ok:true without schemaMissingParentId', { ok: true, rows: [] }],
    ['ok:false without error', { ok: false }],
    ['no ok key', { rows: [] }],
  ])('rejects a malformed message (%s) instead of resolving undefined', async (_label, msg) => {
    const { runner, workers } = makeRunner()
    const promise = runner(input)
    await Promise.resolve()
    workers[0].emitMessage(msg)
    await expect(promise).rejects.toThrow(/malformed|failed/i)
    expect(workers[0].terminated).toBe(1)
  })

  it('rejects on a worker error event and terminates', async () => {
    const { runner, workers } = makeRunner()
    const promise = runner(input)
    await Promise.resolve()
    workers[0].emitError(new Error('worker crashed'))
    await expect(promise).rejects.toThrow(/worker crashed/)
    expect(workers[0].terminated).toBe(1)
  })

  it('rejects when the worker exits before sending a message', async () => {
    const { runner, workers } = makeRunner()
    const promise = runner(input)
    await Promise.resolve()
    workers[0].emitExit(1)
    await expect(promise).rejects.toThrow(/exit/i)
  })

  it('rejects and terminates on timeout', async () => {
    vi.useFakeTimers()
    try {
      const { runner, workers } = makeRunner({ timeoutMs: 25 })
      const promise = runner(input)
      await Promise.resolve()
      const expectation = expect(promise).rejects.toThrow(/timed out/i)
      await vi.advanceTimersByTimeAsync(30)
      await expectation
      expect(workers[0].terminated).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
