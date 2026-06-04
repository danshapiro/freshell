// Drop-in replacement for opencode-listing-query's runOpencodeListingQuery that
// blocks its OWN (worker) thread for a fixed duration, then returns known rows.
// Used to prove the main event loop is not blocked while the worker runs.
// (Returns synchronously; the worker awaits it, so a non-Promise return is fine.)
import type { OpencodeListingResult } from '../../../../server/coding-cli/providers/opencode-listing-query.js'

const SLEEP_MS = 250

export function runOpencodeListingQuery(_dbPath: string, _markerPattern: string): OpencodeListingResult {
  const end = Date.now() + SLEEP_MS
  while (Date.now() < end) { /* busy-block this worker thread */ }
  return {
    rows: [{ sessionId: 'slow-1', cwd: '/repo/root', title: 'Slow', createdAt: 1000, lastActivityAt: 2000, projectPath: '/repo/root', hasThreeViewsMarker: 0 }],
    schemaMissingParentId: false,
  }
}
