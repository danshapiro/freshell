import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { logger } from '../logger.js'
import { cmdlineHasCodexToken, probeRegisteredResumePtyGroups } from './codex-child-registry.js'
import {
  countCodexQuarantinedRecords,
  hasDueCodexReaperRetries,
  reapOrphanedCodexAppServerSidecars,
  rescanCodexReaperQuarantine,
} from './codex-app-server/runtime.js'

// Stage 1c observability (plan §7.5): one structured `codex-log-db:` line at boot and then hourly,
// plus the hourly retry of pending reaper records and the quarantine rescan trigger.
//
// The status/emit/count functions below (emitCodexLogDbStatus, countCodexLogDbHolders,
// statWalBytes) are STRICTLY read-only over codex state — `fs.stat` on the WAL and a `/proc/*/fd`
// readlink scan — and MUST NOT open the SQLite database or signal any process (I1/I3). The hourly
// maintenance tick is the one exception by design: it delegates to the ownership-gated reaper in
// runtime.ts, which owns all signalling decisions. Every path is try/catch'd: the monitor can
// never throw, crash the server, or block boot (I4).

export const CODEX_LOG_DB_FILENAME = 'logs_2.sqlite'
/**
 * Warn once the WAL exceeds this size. The launch-wedge cliff is ~5 GB and the measured worst-case
 * churn on the incident machine is ~22 MB/min (accepted until Stage 2), so 2 GiB leaves hours of
 * margin — not weeks — while keeping the hourly line quiet during known-noisy-but-accepted churn.
 */
export const CODEX_LOG_DB_WAL_WARN_BYTES = 2 * 1024 * 1024 * 1024
/** Warn once this many processes hold the log DB open (~2 per pane; normal is tens, not hundreds). */
export const CODEX_LOG_DB_HOLDER_WARN_THRESHOLD = 64
export const CODEX_OBSERVABILITY_INTERVAL_MS = 60 * 60 * 1000
/** Bounded fan-out for the /proc fd scan: at most this many pids are probed concurrently (M3). */
export const CODEX_HOLDER_SCAN_CONCURRENCY = 12

export type CodexObservabilityLogger = {
  info: (fields: Record<string, unknown>, message: string) => void
  warn: (fields: Record<string, unknown>, message: string) => void
}

const defaultLog: CodexObservabilityLogger = logger.child({ component: 'codex-observability' })

export type CodexReaperMaintenanceOptions = {
  serverInstanceId: string
  metadataDir?: string
  terminateGraceMs?: number
  log?: CodexObservabilityLogger
}

export type CodexObservabilityOptions = CodexReaperMaintenanceOptions & {
  codexHome?: string
  procRoot?: string
  intervalMs?: number
  walWarnBytes?: number
  holderWarnThreshold?: number
  env?: NodeJS.ProcessEnv
}

export function resolveCodexHome(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.CODEX_HOME?.trim()
  return fromEnv ? fromEnv : path.join(os.homedir(), '.codex')
}

export function resolveCodexLogDbPath(codexHome: string): string {
  return path.join(codexHome, CODEX_LOG_DB_FILENAME)
}

// Symlink-proof canonicalization so fd readlink targets (always fully resolved) compare against
// the same string. Falls back to a plain resolve when the DB does not exist yet.
function canonicalizeDbPath(dbPath: string): string {
  try {
    return fs.realpathSync.native(dbPath)
  } catch {
    return path.resolve(dbPath)
  }
}

type WalStat = { walBytes: number; walStatFailed: boolean }

// ENOENT genuinely means "no WAL" (an idle or absent DB) and reads as 0. Any OTHER stat failure is
// reported as walBytes=-1 + walStatFailed so a permission/IO problem can never masquerade as an
// empty WAL (panel M5).
async function statWalBytes(walPath: string): Promise<WalStat> {
  try {
    return { walBytes: (await fsp.stat(walPath)).size, walStatFailed: false }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { walBytes: 0, walStatFailed: false }
    return { walBytes: -1, walStatFailed: true }
  }
}

// Counts processes holding the log DB (or its -wal/-shm siblings) open via a read-only /proc fd
// readlink scan. Cost-bounded (panel M3): only pids whose cmdline mentions codex are probed (they
// are the only holders this line cares to count), the server itself is skipped, and at most
// CODEX_HOLDER_SCAN_CONCURRENCY pids are in flight at once. Unreadable cmdlines/fd tables (EACCES,
// exited mid-scan) are skipped, never fatal. fd targets of unlinked-but-open files carry a
// ' (deleted)' suffix which is stripped before comparison.
export async function countCodexLogDbHolders(
  dbPath: string,
  procRoot = '/proc',
  selfPid: number = process.pid,
): Promise<number> {
  const resolvedDbPath = canonicalizeDbPath(dbPath)
  let entries: string[]
  try {
    entries = await fsp.readdir(procRoot)
  } catch {
    return 0
  }
  const pids = entries.filter((entry) => /^\d+$/.test(entry) && Number(entry) !== selfPid)
  const matchesDb = (rawTarget: string): boolean => {
    const target = rawTarget.endsWith(' (deleted)')
      ? rawTarget.slice(0, -' (deleted)'.length)
      : rawTarget
    return target === resolvedDbPath || target.startsWith(`${resolvedDbPath}-`)
  }
  let holders = 0
  let next = 0
  const worker = async (): Promise<void> => {
    while (true) {
      const index = next
      next += 1
      if (index >= pids.length) return
      const pid = pids[index]
      // Prefilter: one cheap cmdline read gates the (much more expensive) per-fd readlink walk.
      let cmdline: string
      try {
        cmdline = (await fsp.readFile(path.join(procRoot, pid, 'cmdline'))).toString('utf8')
      } catch {
        continue
      }
      // r2-2: same argv-token predicate as the exit-path registry — a path merely containing
      // "codex" (worktree names, notes files) must not count as a holder.
      if (!cmdlineHasCodexToken(cmdline)) continue
      const fdDir = path.join(procRoot, pid, 'fd')
      let fds: string[]
      try {
        fds = await fsp.readdir(fdDir)
      } catch {
        continue
      }
      for (const fd of fds) {
        let target: string
        try {
          target = await fsp.readlink(path.join(fdDir, fd))
        } catch {
          continue
        }
        if (matchesDb(target)) {
          holders += 1
          break
        }
      }
    }
  }
  const workerCount = Math.max(1, Math.min(CODEX_HOLDER_SCAN_CONCURRENCY, pids.length))
  await Promise.all(Array.from({ length: workerCount }, () => worker()))
  return holders
}

export type CodexLogDbStatus = {
  walBytes: number
  walStatFailed: boolean
  holders: number
  quarantined: number
  warned: boolean
}

export async function emitCodexLogDbStatus(
  options: Partial<CodexObservabilityOptions> = {},
): Promise<CodexLogDbStatus | null> {
  const log = options.log ?? defaultLog
  try {
    const codexHome = options.codexHome ?? resolveCodexHome(options.env)
    const dbPath = canonicalizeDbPath(resolveCodexLogDbPath(codexHome))
    const walPath = `${dbPath}-wal`
    const [walStat, holders, quarantined] = await Promise.all([
      statWalBytes(walPath),
      countCodexLogDbHolders(dbPath, options.procRoot ?? '/proc'),
      countCodexQuarantinedRecords(options.metadataDir),
    ])
    const { walBytes, walStatFailed } = walStat
    const walWarnBytes = options.walWarnBytes ?? CODEX_LOG_DB_WAL_WARN_BYTES
    const holderWarnThreshold = options.holderWarnThreshold ?? CODEX_LOG_DB_HOLDER_WARN_THRESHOLD
    const warned = walBytes > walWarnBytes || holders > holderWarnThreshold || walStatFailed
    const fields = { walBytes, walStatFailed, holders, quarantined, walPath, dbPath }
    const message = `codex-log-db: wal_bytes=${walBytes} holders=${holders} quarantined=${quarantined}`
    if (warned) {
      log.warn(fields, message)
    } else {
      log.info(fields, message)
    }
    return { walBytes, walStatFailed, holders, quarantined, warned }
  } catch (error) {
    try {
      log.warn({ err: error }, 'codex-log-db observability probe failed')
    } catch {
      // the monitor never throws
    }
    return null
  }
}

// Hourly maintenance (plan §7.3–.5): trigger the quarantine rescan and, when any retry-in-place
// record's time-based backoff window has elapsed (or a quarantined record was just promoted),
// re-run the reaper. The per-boot reap attempt always runs at startup; backoff gates only this
// hourly cadence (per record, via respectRetryBackoff) and the reaper's log escalation. NOTE:
// unlike the read-only status functions above, this tick deliberately delegates to the
// ownership-gated reaper, which may signal provably-owned process groups.
export async function runCodexReaperMaintenanceTick(options: CodexReaperMaintenanceOptions): Promise<void> {
  const log = options.log ?? defaultLog
  try {
    // r2-11: steady-state drain of stale resume-pty registry entries (signal-0 probe only; never
    // signals). onExit-time deregistration keeps an entry when its group still had members or the
    // probe was inconclusive — if those members die later no event fires, so re-probe hourly here.
    probeRegisteredResumePtyGroups()
  } catch {
    // best-effort; the registry probe must never block the maintenance tick
  }
  try {
    const { promotedRecords } = await rescanCodexReaperQuarantine(options.metadataDir)
    const due = await hasDueCodexReaperRetries(options.metadataDir)
    if (promotedRecords.length === 0 && !due) return
    await reapOrphanedCodexAppServerSidecars({
      serverInstanceId: options.serverInstanceId,
      // m2: per-record backoff gating — only due records are re-attempted (and re-counted).
      respectRetryBackoff: true,
      ...(options.metadataDir !== undefined ? { metadataDir: options.metadataDir } : {}),
      ...(options.terminateGraceMs !== undefined ? { terminateGraceMs: options.terminateGraceMs } : {}),
    })
  } catch (error) {
    try {
      log.warn({ err: error }, 'codex reaper hourly retry tick failed')
    } catch {
      // the monitor never throws
    }
  }
}

export type CodexObservabilityHandle = { stop(): void }

// Started from server/index.ts at boot. Emits one status line immediately, then hourly on an
// unref()'d interval timer (it can never hold the process open). Fully fail-open. index.ts keeps
// the handle and calls stop() as the first step of shutdown() so a tick cannot race teardown (m7).
export function startCodexObservability(options: CodexObservabilityOptions): CodexObservabilityHandle {
  let timer: NodeJS.Timeout | null = null
  const tick = async (): Promise<void> => {
    await emitCodexLogDbStatus(options)
    await runCodexReaperMaintenanceTick(options)
  }
  try {
    void tick()
    timer = setInterval(() => {
      void tick()
    }, options.intervalMs ?? CODEX_OBSERVABILITY_INTERVAL_MS)
    timer.unref()
  } catch (error) {
    try {
      const log = options.log ?? defaultLog
      log.warn({ err: error }, 'failed to start codex observability')
    } catch {
      // the monitor never throws
    }
  }
  return {
    stop(): void {
      if (timer) {
        clearInterval(timer)
        timer = null
      }
    },
  }
}
