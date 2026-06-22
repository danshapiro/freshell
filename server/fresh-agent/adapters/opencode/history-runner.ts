import { Worker } from 'node:worker_threads'
import type {
  OpencodeHistoryPage,
  OpencodeLegacySessionResolveInput,
  OpencodeHistoryReadRequest,
  OpencodeHistoryReadResult,
  OpencodeHistoryTurnBody,
  OpencodeSessionInfo,
  OpencodeTurnBodyResult,
} from './history-query.js'
import { runOpencodeHistoryQuery } from './history-query.js'
// Importing the worker module on the main thread (or a Vitest worker) is safe:
// its auto-run is sentinel-guarded, so this import never spawns/posts anything.
import {
  OPENCODE_HISTORY_WORKER_KIND,
  type OpencodeHistoryFailureReason,
  type OpencodeHistoryWorkerResponse,
  type SerializedHistoryError,
} from './history-worker.js'

export type OpencodeHistoryReader = {
  readSessionInfo(sessionId: string): Promise<OpencodeSessionInfo | undefined>
  resolveLegacySession(input: OpencodeLegacySessionResolveInput): Promise<OpencodeSessionInfo | undefined>
  readSnapshotPage(sessionId: string, limit?: number): Promise<OpencodeHistoryPage | undefined>
  readTurnPage(sessionId: string, query: { cursor?: string; limit?: number }): Promise<OpencodeHistoryPage | undefined>
  readTurnBody(sessionId: string, turnId: string): Promise<OpencodeTurnBodyResult | undefined>
}

type WorkerLike = {
  on(event: 'message', listener: (value: unknown) => void): unknown
  on(event: 'error', listener: (err: Error) => void): unknown
  on(event: 'exit', listener: (code: number) => void): unknown
  terminate(): Promise<number> | void
}

export type WorkerSpawnOptions = { workerData: unknown; execArgv: string[] }

export type CreateWorkerHistoryReaderOptions = {
  dbPath: string
  /** Injectable for unit tests; default spawns a real worker_threads Worker. */
  spawn?: (workerUrl: URL, options: WorkerSpawnOptions) => WorkerLike
  /** Override the query-module URL (used by off-thread fixtures). */
  queryModuleUrl?: string
  /** Hard timeout for a single history query. Default 15 s. */
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 15_000
const SELF_EXT = import.meta.url.endsWith('.ts') ? '.ts' : '.js'
const WORKER_EXECARGV = [...process.execArgv, '--disable-warning=ExperimentalWarning']
const FAILURE_REASONS = new Set<OpencodeHistoryFailureReason>([
  'missing_db',
  'sqlite_unavailable',
  'schema_mismatch',
  'not_found',
  'read_error',
])

function defaultWorkerUrl(): URL {
  return new URL(`./history-worker${SELF_EXT}`, import.meta.url)
}

function defaultQueryModuleUrl(): string {
  return new URL(`./history-query${SELF_EXT}`, import.meta.url).href
}

function defaultSpawn(workerUrl: URL, options: WorkerSpawnOptions): WorkerLike {
  return new Worker(workerUrl, options)
}

export class OpencodeHistoryReaderError extends Error {
  readonly reason: OpencodeHistoryFailureReason
  readonly workerError?: SerializedHistoryError

  constructor(reason: OpencodeHistoryFailureReason, message: string, workerError?: SerializedHistoryError) {
    super(message)
    this.name = 'OpencodeHistoryReaderError'
    this.reason = reason
    this.workerError = workerError
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isReadResult(value: unknown): value is OpencodeHistoryReadResult {
  if (!isObject(value) || typeof value.type !== 'string') return false
  switch (value.type) {
    case 'session_info':
      return isObject(value.sessionInfo)
    case 'legacy_session':
      return isObject(value.sessionInfo)
    case 'snapshot_page':
    case 'turn_page':
      return isObject(value.page)
    case 'turn_body':
      return isObject(value.body)
    default:
      return false
  }
}

function isSerializedError(value: unknown): value is SerializedHistoryError {
  return isObject(value)
    && typeof value.name === 'string'
    && typeof value.message === 'string'
}

function isOkMessage(value: unknown): value is Extract<OpencodeHistoryWorkerResponse, { ok: true }> {
  return isObject(value)
    && value.ok === true
    && isReadResult(value.result)
}

function isErrMessage(value: unknown): value is Extract<OpencodeHistoryWorkerResponse, { ok: false }> {
  return isObject(value)
    && value.ok === false
    && typeof value.reason === 'string'
    && FAILURE_REASONS.has(value.reason as OpencodeHistoryFailureReason)
    && (value.error === undefined || isSerializedError(value.error))
}

function resultForType<T extends OpencodeHistoryReadResult['type']>(
  result: OpencodeHistoryReadResult | undefined,
  type: T,
): Extract<OpencodeHistoryReadResult, { type: T }> | undefined {
  if (!result) return undefined
  if (result.type !== type) {
    throw new Error(`OpenCode history worker returned ${result.type} for ${type} request`)
  }
  return result as Extract<OpencodeHistoryReadResult, { type: T }>
}

export function createWorkerHistoryReader(
  options: CreateWorkerHistoryReaderOptions,
): OpencodeHistoryReader {
  const spawn = options.spawn ?? defaultSpawn
  const queryModuleUrl = options.queryModuleUrl ?? defaultQueryModuleUrl()
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const workerUrl = defaultWorkerUrl()
  const dbPath = options.dbPath

  function run(request: OpencodeHistoryReadRequest): Promise<OpencodeHistoryReadResult | undefined> {
    return new Promise<OpencodeHistoryReadResult | undefined>((resolve, reject) => {
      const worker = spawn(workerUrl, {
        workerData: {
          kind: OPENCODE_HISTORY_WORKER_KIND,
          queryModuleUrl,
          dbPath,
          request,
        },
        execArgv: WORKER_EXECARGV,
      })
      let settled = false
      let timer: NodeJS.Timeout | undefined

      const cleanup = () => {
        if (timer) clearTimeout(timer)
        try { void worker.terminate() } catch { /* ignore */ }
      }
      const settleResolve = (result: OpencodeHistoryReadResult | undefined) => {
        if (settled) return
        settled = true
        cleanup()
        resolve(result)
      }
      const settleReject = (error: Error) => {
        if (settled) return
        settled = true
        cleanup()
        reject(error)
      }

      timer = setTimeout(
        () => settleReject(new OpencodeHistoryReaderError(
          'read_error',
          `OpenCode history worker timed out after ${timeoutMs}ms`,
        )),
        timeoutMs,
      )
      if (typeof timer.unref === 'function') timer.unref()

      worker.on('message', (value: unknown) => {
        if (isOkMessage(value)) {
          settleResolve(value.result)
          return
        }
        if (isErrMessage(value)) {
          if (value.reason === 'not_found') {
            settleResolve(undefined)
            return
          }
          settleReject(new OpencodeHistoryReaderError(
            value.reason,
            value.error?.message || `OpenCode history worker failed: ${value.reason}`,
            value.error,
          ))
          return
        }
        settleReject(new Error('OpenCode history worker sent a malformed message'))
      })
      worker.on('error', (err: Error) => settleReject(err))
      worker.on('exit', (code: number) => settleReject(new Error(`OpenCode history worker exited (code ${code}) before responding`)))
    })
  }

  return {
    async readSessionInfo(sessionId) {
      return resultForType(await run({ type: 'session_info', sessionId }), 'session_info')?.sessionInfo
    },
    async resolveLegacySession(input) {
      return resultForType(await run({ type: 'legacy_session', query: input }), 'legacy_session')?.sessionInfo
    },
    async readSnapshotPage(sessionId, limit) {
      return resultForType(await run({ type: 'snapshot_page', sessionId, limit }), 'snapshot_page')?.page
    },
    async readTurnPage(sessionId, query) {
      return resultForType(await run({ type: 'turn_page', sessionId, query }), 'turn_page')?.page
    },
    async readTurnBody(sessionId, turnId) {
      return resultForType(await run({ type: 'turn_body', sessionId, turnId }), 'turn_body')?.body
    },
  }
}

export const createWorkerOpencodeHistoryReader = createWorkerHistoryReader

/** Runs history queries on the caller's thread. Intended for tests and fallbacks. */
export function createInProcessHistoryReader(options: { dbPath: string }): OpencodeHistoryReader {
  async function run(request: OpencodeHistoryReadRequest): Promise<OpencodeHistoryReadResult | undefined> {
    return runOpencodeHistoryQuery({ dbPath: options.dbPath, request })
  }

  return {
    async readSessionInfo(sessionId) {
      return resultForType(await run({ type: 'session_info', sessionId }), 'session_info')?.sessionInfo
    },
    async resolveLegacySession(input) {
      return resultForType(await run({ type: 'legacy_session', query: input }), 'legacy_session')?.sessionInfo
    },
    async readSnapshotPage(sessionId, limit) {
      return resultForType(await run({ type: 'snapshot_page', sessionId, limit }), 'snapshot_page')?.page
    },
    async readTurnPage(sessionId, query) {
      return resultForType(await run({ type: 'turn_page', sessionId, query }), 'turn_page')?.page
    },
    async readTurnBody(sessionId, turnId) {
      const body = resultForType(await run({ type: 'turn_body', sessionId, turnId }), 'turn_body')?.body
      return body ? { message: body.message, revision: body.revision } as OpencodeTurnBodyResult & OpencodeHistoryTurnBody : undefined
    },
  }
}

export const createInProcessOpencodeHistoryReader = createInProcessHistoryReader
