import { EventEmitter } from 'events'
import { describe, expect, it, vi } from 'vitest'

import {
  createWorkerHistoryReader,
  OpencodeHistoryReaderError,
} from '../../../../server/fresh-agent/adapters/opencode/history-runner.js'

class FakeWorker extends EventEmitter {
  terminated = 0
  postedData: unknown
  execArgv: string[]

  constructor(public url: URL, public options: { workerData: unknown; execArgv: string[] }) {
    super()
    this.postedData = options.workerData
    this.execArgv = options.execArgv
  }

  terminate() {
    this.terminated += 1
    return Promise.resolve(0)
  }

  emitMessage(message: unknown) { this.emit('message', message) }
  emitError(error: Error) { this.emit('error', error) }
  emitExit(code: number) { this.emit('exit', code) }
}

function makeReader(overrides: Partial<Parameters<typeof createWorkerHistoryReader>[0]> = {}) {
  const workers: FakeWorker[] = []
  const spawn = vi.fn((url: URL, options: { workerData: unknown; execArgv: string[] }) => {
    const worker = new FakeWorker(url, options)
    workers.push(worker)
    return worker
  })
  const reader = createWorkerHistoryReader({
    dbPath: '/tmp/opencode.db',
    spawn: spawn as any,
    timeoutMs: 50,
    ...overrides,
  })
  return { reader, workers, spawn }
}

describe('createWorkerHistoryReader', () => {
  it('resolves session info from an ok message and terminates the worker', async () => {
    const { reader, workers } = makeReader()
    const promise = reader.readSessionInfo('ses-1')
    await Promise.resolve()

    workers[0].emitMessage({
      ok: true,
      result: {
        type: 'session_info',
        sessionInfo: { id: 'ses-1', title: 'History' },
      },
    })

    await expect(promise).resolves.toMatchObject({ id: 'ses-1', title: 'History' })
    expect(workers[0].terminated).toBe(1)
  })

  it('passes dbPath, request, queryModuleUrl, sentinel kind, and warning-suppression execArgv', async () => {
    const { reader, workers } = makeReader()
    const promise = reader.readTurnPage('ses-1', { cursor: 'opaque-cursor', limit: 3 })
    await Promise.resolve()

    const data = workers[0].postedData as any
    expect(data.kind).toBe('opencode-history-worker')
    expect(data.dbPath).toBe('/tmp/opencode.db')
    expect(String(data.queryModuleUrl)).toContain('history-query')
    expect(data.request).toEqual({
      type: 'turn_page',
      sessionId: 'ses-1',
      query: { cursor: 'opaque-cursor', limit: 3 },
    })
    expect(workers[0].execArgv).toEqual([...process.execArgv, '--disable-warning=ExperimentalWarning'])

    workers[0].emitMessage({
      ok: true,
      result: {
        type: 'turn_page',
        page: {
          exported: { messages: [] },
          revision: 1,
          nextCursor: null,
          hasMoreBefore: false,
        },
      },
    })
    await promise
  })

  it('resolves not_found responses as undefined', async () => {
    const { reader, workers } = makeReader()
    const promise = reader.readTurnBody('ses-1', 'missing-turn')
    await Promise.resolve()

    workers[0].emitMessage({ ok: false, reason: 'not_found' })

    await expect(promise).resolves.toBeUndefined()
    expect(workers[0].terminated).toBe(1)
  })

  it.each([
    ['missing_db', { ok: false, reason: 'missing_db' }],
    ['schema_mismatch', {
      ok: false,
      reason: 'schema_mismatch',
      error: {
        name: 'OpencodeHistorySchemaError',
        message: 'missing columns',
        code: 'OPENCODE_HISTORY_SCHEMA_ERROR',
        table: 'session',
        missingColumns: ['directory'],
      },
    }],
    ['read_error', { ok: false, reason: 'read_error', error: { name: 'Error', message: 'boom' } }],
  ] as const)('rejects %s responses with the typed failure reason', async (reason, message) => {
    const { reader, workers } = makeReader()
    const promise = reader.readSessionInfo('ses-1')
    await Promise.resolve()

    workers[0].emitMessage(message)

    let caught: unknown
    try {
      await promise
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(OpencodeHistoryReaderError)
    expect(caught).toMatchObject({ reason })
  })

  it.each([
    ['ok:true without result', { ok: true }],
    ['ok:true with malformed result', { ok: true, result: { type: 'session_info' } }],
    ['ok:false without reason', { ok: false }],
    ['ok:false with unknown reason', { ok: false, reason: 'other_error' }],
    ['no ok key', { result: {} }],
  ])('rejects malformed worker messages (%s)', async (_label, message) => {
    const { reader, workers } = makeReader()
    const promise = reader.readSessionInfo('ses-1')
    await Promise.resolve()

    workers[0].emitMessage(message)

    await expect(promise).rejects.toThrow(/malformed/i)
    expect(workers[0].terminated).toBe(1)
  })

  it('rejects on a worker error event and terminates', async () => {
    const { reader, workers } = makeReader()
    const promise = reader.readSessionInfo('ses-1')
    await Promise.resolve()

    workers[0].emitError(new Error('worker crashed'))

    await expect(promise).rejects.toThrow(/worker crashed/)
    expect(workers[0].terminated).toBe(1)
  })

  it('rejects when the worker exits before sending a message', async () => {
    const { reader, workers } = makeReader()
    const promise = reader.readSessionInfo('ses-1')
    await Promise.resolve()

    workers[0].emitExit(1)

    await expect(promise).rejects.toThrow(/exit/i)
  })

  it('rejects and terminates on timeout', async () => {
    vi.useFakeTimers()
    try {
      const { reader, workers } = makeReader({ timeoutMs: 25 })
      const promise = reader.readSessionInfo('ses-1')
      await Promise.resolve()
      const caughtPromise = promise.then(
        () => undefined,
        (error: unknown) => error,
      )

      await vi.advanceTimersByTimeAsync(30)

      const caught = await caughtPromise
      expect(caught).toBeInstanceOf(OpencodeHistoryReaderError)
      expect(caught).toMatchObject({ reason: 'read_error' })
      expect(workers[0].terminated).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects if a worker returns a different result type than requested', async () => {
    const { reader, workers } = makeReader()
    const promise = reader.readSessionInfo('ses-1')
    await Promise.resolve()

    workers[0].emitMessage({
      ok: true,
      result: {
        type: 'turn_page',
        page: {
          exported: { messages: [] },
          revision: 1,
          nextCursor: null,
          hasMoreBefore: false,
        },
      },
    })

    await expect(promise).rejects.toThrow(/returned turn_page/)
  })
})
