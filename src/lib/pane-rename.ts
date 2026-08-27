/**
 * Human pane renames PATCH /api/panes/:id. The server's layout mirror is
 * client-pushed (ui.layout.sync, 200ms-1000ms+ debounce after a fresh
 * resume), so a fast rename can hit the documented Node-parity no-op
 * 200 {message:'pane not found'} even though the pane plainly exists
 * (kata r49m companion race: the open editor was stranded with a stale
 * error). Only that transient no-op is retried; it is the one response
 * that provably means "mirror not landed yet" rather than a user error.
 */
import { createLogger } from '@/lib/client-logger'

const log = createLogger('pane-rename')

export type PaneRenameResponse =
  | { data?: { paneId?: string; tabId?: string; tabRenamed?: boolean }; message?: string }
  | null
  | undefined

export type PaneRenameResult =
  | { ok: true; response: PaneRenameResponse }
  | { ok: false; message: string }

const MIRROR_NOT_FOUND_MESSAGE = 'pane not found'
const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [200, 400, 800]
const GENERIC_FAILURE_MESSAGE = 'Failed to rename pane'

export async function renamePaneWithMirrorRetry(
  paneId: string,
  name: string,
  opts: {
    patch: (path: string, body: unknown) => Promise<PaneRenameResponse>
    sleep?: (ms: number) => Promise<void>
    retryDelaysMs?: readonly number[]
  },
): Promise<PaneRenameResult> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const retryDelaysMs = opts.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS
  for (let attempt = 0; ; attempt++) {
    const response = await opts.patch(`/api/panes/${encodeURIComponent(paneId)}`, { name })
    if (response?.data?.paneId === paneId) {
      return { ok: true, response }
    }
    const message =
      typeof response?.message === 'string' && response.message ? response.message : GENERIC_FAILURE_MESSAGE
    const retryable = message === MIRROR_NOT_FOUND_MESSAGE && attempt < retryDelaysMs.length
    if (!retryable) return { ok: false, message }
    const delayMs = retryDelaysMs[attempt]
    log.debug('retrying pane rename after transient pane-not-found (layout mirror not landed yet)', {
      paneId,
      attempt: attempt + 1,
      delayMs,
    })
    await sleep(delayMs)
  }
}
