import { parentPort, workerData } from 'node:worker_threads'
import type { OpencodeListingResult } from './opencode-listing-query.js'

/**
 * Sentinel proving this thread was spawned by OUR runner. REQUIRED because the
 * server Vitest config runs test files in worker threads (`pool: 'threads'`), so
 * `parentPort` is non-null when a test imports this module. Without the sentinel,
 * the auto-run block below would fire on import using Vitest's OWN workerData and
 * post a message to Vitest's parent port — corrupting/hanging the test worker.
 * The runner injects this exact value in workerData; Vitest's workerData never has it.
 */
export const OPENCODE_LISTING_WORKER_KIND = 'opencode-listing-worker'

export type WorkerListingInput = {
  kind: typeof OPENCODE_LISTING_WORKER_KIND
  queryModuleUrl: string
  dbPath: string
  markerPattern: string
}

/**
 * Run the listing query by dynamically importing the EXACT resolved query-module
 * URL (.ts in dev/test, .js in prod) provided by the spawning code. We pass the
 * exact URL rather than a static relative import because NodeNext `.js`→`.ts`
 * remapping fails inside a worker thread (validated by spike).
 */
export async function executeListing(
  input: { queryModuleUrl: string; dbPath: string; markerPattern: string },
): Promise<OpencodeListingResult> {
  const mod = await import(input.queryModuleUrl) as typeof import('./opencode-listing-query.js')
  return mod.runOpencodeListingQuery(input.dbPath, input.markerPattern)
}

// Auto-run ONLY when we are a real worker spawned by our runner (parentPort present
// AND our sentinel in workerData). This is import-safe under Vitest's thread pool.
if (parentPort && (workerData as Partial<WorkerListingInput> | undefined)?.kind === OPENCODE_LISTING_WORKER_KIND) {
  const port = parentPort
  executeListing(workerData as WorkerListingInput)
    .then((result) => port.postMessage({ ok: true, rows: result.rows, schemaMissingParentId: result.schemaMissingParentId }))
    .catch((err: unknown) => {
      const error = err instanceof Error ? { name: err.name, message: err.message } : { name: 'Error', message: String(err) }
      port.postMessage({ ok: false, error })
    })
}
