import fsp from 'node:fs/promises'
import { parentPort, workerData } from 'node:worker_threads'
import type {
  OpencodeHistoryReadRequest,
  OpencodeHistoryReadResult,
  OpencodeHistorySchemaError,
} from './history-query.js'

export const OPENCODE_HISTORY_WORKER_KIND = 'opencode-history-worker'

export type OpencodeHistoryFailureReason =
  | 'missing_db'
  | 'sqlite_unavailable'
  | 'schema_mismatch'
  | 'not_found'
  | 'read_error'

export type WorkerHistoryInput = {
  kind: typeof OPENCODE_HISTORY_WORKER_KIND
  queryModuleUrl: string
  dbPath: string
  request: OpencodeHistoryReadRequest
}

export type SerializedHistoryError = {
  name: string
  message: string
  code?: string
  table?: string
  missingColumns?: string[]
}

export type OpencodeHistoryWorkerResponse =
  | { ok: true; result: OpencodeHistoryReadResult }
  | { ok: false; reason: OpencodeHistoryFailureReason; error?: SerializedHistoryError }

function serializeError(error: unknown): SerializedHistoryError {
  if (!(error instanceof Error)) {
    return { name: 'Error', message: String(error) }
  }
  const details = error as Partial<OpencodeHistorySchemaError> & { code?: unknown }
  return {
    name: error.name,
    message: error.message,
    ...(typeof details.code === 'string' ? { code: details.code } : {}),
    ...(typeof details.table === 'string' ? { table: details.table } : {}),
    ...(Array.isArray(details.missingColumns) ? { missingColumns: details.missingColumns } : {}),
  }
}

function isSqliteUnavailableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const code = (error as { code?: unknown }).code
  return code === 'ERR_UNKNOWN_BUILTIN_MODULE'
    || error.message.includes('node:sqlite')
    || error.message.includes('No such built-in module')
}

function classifyError(error: unknown): OpencodeHistoryFailureReason {
  if (isSqliteUnavailableError(error)) return 'sqlite_unavailable'
  if (
    error instanceof Error
    && (
      error.name === 'OpencodeHistorySchemaError'
      || (error as { code?: unknown }).code === 'OPENCODE_HISTORY_SCHEMA_ERROR'
    )
  ) {
    return 'schema_mismatch'
  }
  return 'read_error'
}

async function databaseExists(dbPath: string): Promise<boolean> {
  try {
    await fsp.access(dbPath)
    return true
  } catch {
    return false
  }
}

/**
 * Run the selected history query by dynamically importing the exact resolved
 * query-module URL (.ts in dev/test, .js in prod) supplied by the spawning code.
 */
export async function executeHistory(input: {
  queryModuleUrl: string
  dbPath: string
  request: OpencodeHistoryReadRequest
}): Promise<OpencodeHistoryWorkerResponse> {
  if (!await databaseExists(input.dbPath)) {
    return { ok: false, reason: 'missing_db' }
  }

  try {
    const mod = await import(input.queryModuleUrl) as typeof import('./history-query.js')
    const result = await mod.runOpencodeHistoryQuery({
      dbPath: input.dbPath,
      request: input.request,
    })
    if (!result) return { ok: false, reason: 'not_found' }
    return { ok: true, result }
  } catch (error) {
    return {
      ok: false,
      reason: classifyError(error),
      error: serializeError(error),
    }
  }
}

// Auto-run ONLY when spawned by our runner. Vitest server tests run inside worker
// threads, so importing this module must not post to Vitest's parent port.
if (parentPort && (workerData as Partial<WorkerHistoryInput> | undefined)?.kind === OPENCODE_HISTORY_WORKER_KIND) {
  const port = parentPort
  executeHistory(workerData as WorkerHistoryInput)
    .then((response) => port.postMessage(response))
    .catch((error: unknown) => {
      port.postMessage({
        ok: false,
        reason: classifyError(error),
        error: serializeError(error),
      } satisfies OpencodeHistoryWorkerResponse)
    })
}
