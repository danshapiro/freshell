/** Hard watchdogs for synchronous test-fixture children: Vitest timers cannot
 * run while a worker is blocked in spawnSync/execFileSync. */
export const SYNC_PROBE_TIMEOUT_MS = 30_000
/** Matches the existing runtime Cargo preflight build cap. */
export const SYNC_BUILD_TIMEOUT_MS = 900_000

/** A signal or spawn error is infrastructure failure, never an expected
 * nonzero command result such as an absent container or no child PIDs. */
export function assertSubprocessCompleted(
  result: { error?: Error; status: number | null; signal?: NodeJS.Signals | null },
  label: string,
): void {
  if (result.error) throw result.error
  if (result.signal || result.status === null) {
    throw new Error(`${label} did not complete (signal ${result.signal ?? 'unknown'})`)
  }
}

/** execFileSync uses numeric status for an ordinary nonzero exit, but an
 * OS error code, a signal, or null status when completion was not observed. */
export function subprocessInterrupted(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const result = error as { code?: unknown; signal?: unknown; status?: unknown }
  return typeof result.code === 'string' || typeof result.signal === 'string' || result.status === null
}
