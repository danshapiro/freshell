import { createLogger } from '@/lib/client-logger'

const log = createLogger('ServerBuildCheck')

const SERVER_BUILD_RELOAD_SENTINEL = 'freshell.server-build-reload'

export interface ServerBuildCheckOptions {
  /** The client's own baked build id; defaults to `__FRESHELL_BUILD_ID__`. */
  clientBuildId?: string
  /** The server's `ready.buildId`. */
  serverBuildId?: string
  reload?: () => void
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
}

/**
 * The client's Vite-baked build id (`config/vite/vite.config.ts` defines it
 * from `git rev-parse HEAD`). `typeof`-guarded because the Vitest client
 * config has no define for it (same precedent as `__PERF_LOGGING__` in
 * `src/lib/perf-logger.ts`) — an unbaked id means "cannot compare", never
 * "reload".
 */
function resolveClientBuildId(): string | undefined {
  if (typeof __FRESHELL_BUILD_ID__ === 'undefined') return undefined
  const id = __FRESHELL_BUILD_ID__
  return id.length > 0 ? id : undefined
}

/**
 * sessionStorage can throw on PROPERTY ACCESS in hardened contexts (iframe
 * sandboxing, privacy modes) — resolving it must be inside the fail-safe,
 * never a ready-handler crash.
 */
function defaultStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | undefined {
  try {
    return window.sessionStorage
  } catch {
    return undefined
  }
}

/**
 * Compare the server's `ready.buildId` against our own baked build id and
 * reload ONCE on a real mismatch. Invariants:
 * - reload iff BOTH ids are present, non-empty, neither is "unknown", and
 *   they differ ("unknown" == "unknown" is a no-op, never a match-and-clear);
 * - the sessionStorage sentinel records the ATTEMPTED server build id and is
 *   written BEFORE reloading: the same server build id never reloads twice
 *   this tab session (a half-deployed server can never reload-loop), while a
 *   DIFFERENT mismatched id re-arms the guard — a corrected deployment
 *   changes what a reload fetches, so it must stay reachable; any
 *   sessionStorage failure = no reload, logged, fail-safe;
 * - a MATCHING ready clears the sentinel (self-re-arm after convergence).
 * KNOWN LIMITS (accepted for the self-hosted single-server threat model):
 * - the mixed-build-origin oscillation door stays open through match-clears:
 *   one origin fronted by servers built from DIFFERENT commits can oscillate
 *   (mismatch → reload → match clears → mismatch → …). Not hardened with a
 *   clears-per-session cap; revisit only if a split-deploy origin appears.
 * - the compare is direction-free (shas carry no ordering), so a NEWER
 *   client against an OLDER server performs one futile bounded reload per
 *   fresh tab session.
 */
export function checkServerBuildId(options?: ServerBuildCheckOptions): void {
  const clientBuildId = options?.clientBuildId ?? resolveClientBuildId()
  const serverBuildId = options?.serverBuildId
  if (!clientBuildId || !serverBuildId) return
  if (clientBuildId === 'unknown' || serverBuildId === 'unknown') return

  const reload = options?.reload ?? (() => window.location.reload())

  if (clientBuildId === serverBuildId) {
    const storage = options?.storage ?? defaultStorage()
    try {
      storage?.removeItem(SERVER_BUILD_RELOAD_SENTINEL)
    } catch {
      // Ignore sessionStorage access failures (already disarmed-or-armed as
      // found; nothing reloads on the match path either way).
    }
    return
  }

  const storage = options?.storage ?? defaultStorage()
  if (!storage) {
    log.warn(
      `server build ${serverBuildId} differs from client build ${clientBuildId} but `
      + 'sessionStorage is unavailable — suppressing the reload (fail-safe against loops)',
    )
    return
  }
  try {
    if (storage.getItem(SERVER_BUILD_RELOAD_SENTINEL) === serverBuildId) {
      log.warn(
        `server build ${serverBuildId} still differs from client build ${clientBuildId}; `
        + `a reload for build ${serverBuildId} was already attempted this tab session — `
        + 'suppressing further reloads for it',
      )
      return
    }
    storage.setItem(SERVER_BUILD_RELOAD_SENTINEL, serverBuildId)
  } catch (err) {
    log.warn('server-build sentinel persistence failed; suppressing the reload', err)
    return
  }
  log.warn(
    `server build ${serverBuildId} differs from client build ${clientBuildId}; `
    + `reloading once for build ${serverBuildId} to pick up the matching client bundle `
    + '(a different server build id will re-arm this guard)',
  )
  reload()
}
