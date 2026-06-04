import { Worker } from 'node:worker_threads'
import type { OpencodeListingResult, OpencodeSessionRow } from './opencode-listing-query.js'
import { runOpencodeListingQuery } from './opencode-listing-query.js'
// Importing the worker module on the MAIN thread (or a Vitest worker) is safe:
// its auto-run is sentinel-guarded, so this import never spawns/posts anything.
import { OPENCODE_LISTING_WORKER_KIND } from './opencode-listing.worker.js'

export type OpencodeListingQueryInput = { dbPath: string; markerPattern: string }
export type OpencodeListingQueryRunner = (input: OpencodeListingQueryInput) => Promise<OpencodeListingResult>

type WorkerLike = {
  on(event: 'message', listener: (value: unknown) => void): unknown
  on(event: 'error', listener: (err: Error) => void): unknown
  on(event: 'exit', listener: (code: number) => void): unknown
  terminate(): Promise<number> | void
}

export type WorkerSpawnOptions = { workerData: unknown; execArgv: string[] }

export type CreateWorkerListingRunnerOptions = {
  /** Injectable for unit tests; default spawns a real worker_threads Worker. */
  spawn?: (workerUrl: URL, options: WorkerSpawnOptions) => WorkerLike
  /** Override the query-module URL (used by the off-thread integration fixture). */
  queryModuleUrl?: string
  /** Hard timeout for a single listing query. Default 15 s (the real query is ~180 ms). */
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 15_000
// import.meta.url ends with `.ts` in dev/test (tsx / native strip-types) and
// `.js` in prod (compiled dist). Resolve siblings with the matching extension.
const SELF_EXT = import.meta.url.endsWith('.ts') ? '.ts' : '.js'
// Append to process.execArgv (do NOT replace) so tsx's `--import .../loader.mjs`
// is inherited in dev; the flag silences node:sqlite's per-spawn ExperimentalWarning.
const WORKER_EXECARGV = [...process.execArgv, '--disable-warning=ExperimentalWarning']

function defaultWorkerUrl(): URL {
  return new URL(`./opencode-listing.worker${SELF_EXT}`, import.meta.url)
}
function defaultQueryModuleUrl(): string {
  return new URL(`./opencode-listing-query${SELF_EXT}`, import.meta.url).href
}
function defaultSpawn(workerUrl: URL, options: WorkerSpawnOptions): WorkerLike {
  return new Worker(workerUrl, options)
}

type OkMessage = { ok: true; rows: OpencodeSessionRow[]; schemaMissingParentId: boolean }
type ErrMessage = { ok: false; error: { name: string; message: string } }

// Validate the FULL shape, not just the presence of `ok` — a truncated/garbled
// message like `{ ok: true }` must NOT resolve `{ rows: undefined }`.
function isOkMessage(value: unknown): value is OkMessage {
  return typeof value === 'object' && value !== null
    && (value as { ok?: unknown }).ok === true
    && Array.isArray((value as { rows?: unknown }).rows)
    && typeof (value as { schemaMissingParentId?: unknown }).schemaMissingParentId === 'boolean'
}
function isErrMessage(value: unknown): value is ErrMessage {
  if (typeof value !== 'object' || value === null) return false
  if ((value as { ok?: unknown }).ok !== false) return false
  const error = (value as { error?: unknown }).error
  return typeof error === 'object' && error !== null
    && typeof (error as { message?: unknown }).message === 'string'
}

export function createWorkerListingRunner(
  options: CreateWorkerListingRunnerOptions = {},
): OpencodeListingQueryRunner {
  const spawn = options.spawn ?? defaultSpawn
  const queryModuleUrl = options.queryModuleUrl ?? defaultQueryModuleUrl()
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const workerUrl = defaultWorkerUrl()

  return (input: OpencodeListingQueryInput): Promise<OpencodeListingResult> => {
    return new Promise<OpencodeListingResult>((resolve, reject) => {
      const worker = spawn(workerUrl, { workerData: { ...input, queryModuleUrl, kind: OPENCODE_LISTING_WORKER_KIND }, execArgv: WORKER_EXECARGV })
      let settled = false
      let timer: NodeJS.Timeout | undefined

      const cleanup = () => {
        if (timer) clearTimeout(timer)
        try { void worker.terminate() } catch { /* ignore */ }
      }
      const settleResolve = (result: OpencodeListingResult) => {
        if (settled) return
        settled = true
        cleanup()
        resolve(result)
      }
      const settleReject = (err: Error) => {
        if (settled) return
        settled = true
        cleanup()
        reject(err)
      }

      timer = setTimeout(() => settleReject(new Error(`OpenCode listing worker timed out after ${timeoutMs}ms`)), timeoutMs)
      if (typeof (timer as NodeJS.Timeout).unref === 'function') (timer as NodeJS.Timeout).unref()

      worker.on('message', (value: unknown) => {
        if (isOkMessage(value)) {
          settleResolve({ rows: value.rows, schemaMissingParentId: value.schemaMissingParentId })
        } else if (isErrMessage(value)) {
          const err = new Error(value.error.message || 'OpenCode listing worker failed')
          err.name = value.error.name ?? 'Error'
          settleReject(err)
        } else {
          settleReject(new Error('OpenCode listing worker sent a malformed message'))
        }
      })
      worker.on('error', (err: Error) => settleReject(err))
      worker.on('exit', (code: number) => settleReject(new Error(`OpenCode listing worker exited (code ${code}) before responding`)))
    })
  }
}

/** Runs the listing query on the caller's thread (no worker). For tests and fallbacks. */
export const inProcessListingRunner: OpencodeListingQueryRunner = (input) =>
  runOpencodeListingQuery(input.dbPath, input.markerPattern)
