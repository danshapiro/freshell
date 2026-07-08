import fs from 'node:fs'
import { logger } from '../logger.js'

// Stage 1a (plan §6): in-memory registry of live codex children (app-server sidecar wrappers and
// codex resume ptys) so `process.on('exit')` can synchronously best-effort SIGKILL any process
// group that graceful teardown did not confirm dead.
//
// Invariants (plan §2):
// - I3: never signal an unregistered process. The group-kill primitive below has exactly ONE
//   caller (`reapSync`), and `reapSync` is referenced only from the `'exit'` binding — both are
//   enforced structurally by test/unit/server/coding-cli/codex-child-registry.test.ts. The only
//   other negative-pid syscall in this module is the signal-0 liveness probe, which delivers
//   nothing by definition.
// - I4: nothing here may throw out of an exit path or block boot. Every reap step is per-entry
//   try/catch'd; registration is a Map write plus a best-effort /proc stat read.
//
// Platform gating: the negative-pid group kill and the /proc identity re-check are Linux-only
// (consistent with `assertUnixSidecarSupport` in codex-app-server/runtime.ts). On win32 (and any
// non-Linux platform) register/deregister still track entries, but `reapSync` does nothing.

export type CodexChildKind = 'app-server' | 'resume-pty'

export type CodexChildEnvMarker = {
  /** Env var name injected into the child's environment at spawn (e.g. FRESHELL_TERMINAL_ID). */
  name: string
  value: string
}

export type CodexChildEntry = {
  /** Direct child pid (app-server wrapper pid, or the resume pty's pid). */
  pid: number
  /** Process group id. Both child kinds are spawned as group/session leaders, so pgid == pid. */
  pgid: number
  kind: CodexChildKind
  /**
   * /proc/<pid>/stat starttime (field 22, clock ticks since boot) captured at registration.
   * Registration is best-effort: undefined when the stat was unreadable/unparseable at register
   * time, in which case reapSync routes the entry to the ownership-gated group scan (r2-1) —
   * pgrp+cmdline alone are never trusted for a kill.
   */
  startTimeTicks?: number
  /**
   * R2-M1: ownership proof for the dead-pid group-scan fallback. The exact `NAME=VALUE` pair must
   * be present in a group member's /proc environ before the fallback may conclude the registered
   * pgid still hosts OUR codex child. Without a recorded marker the fallback never kills (fail
   * closed): a recycled pgid can host the OTHER server instance's live codex pane.
   */
  envMarker?: CodexChildEnvMarker
}

export type CodexChildRegistryLogger = {
  warn: (fields: Record<string, unknown>, message: string) => void
  /**
   * R3-M1: optional debug hook -- used to distinguish "provably not ours" from "ownership marker
   * unreachable past a truncated environ read". Absent on minimal injected loggers (no-op then).
   */
  debug?: (fields: Record<string, unknown>, message: string) => void
}

export type CodexChildExitHandlerOptions = {
  /**
   * Routes SIGHUP into the existing graceful shutdown path (index.ts `shutdown()`, idempotent via
   * `isShuttingDown`). Invoked with the literal reason 'SIGHUP'.
   */
  requestShutdown: (signal: string) => void
}

/** Minimal process surface, injectable for hermetic tests. */
export type CodexChildProcessLike = {
  pid: number
  on: (event: string, listener: (...args: any[]) => void) => unknown
}

export type CodexGroupProbeResult = 'alive' | 'gone' | 'unknown'

export type CodexChildRegistryDeps = {
  platform?: NodeJS.Platform
  /** Sync read used for /proc/<pid>/stat identity checks (small, fixed-size content). */
  readFileSync?: (filePath: string) => Buffer
  /**
   * r2-3: bounded sync read used for /proc cmdline/environ on the exit path. Defaults to an
   * openSync+readSync fixed-buffer read; when only readFileSync is injected (tests), a bounded
   * wrapper is derived from it.
   */
  readFileBoundedSync?: (filePath: string, maxBytes: number) => { data: Buffer; truncated: boolean }
  /** Sync directory listing used only by the dead-pid group-membership fallback scan. */
  readdirSync?: (dirPath: string) => string[]
  /** The raw signal syscall. Only `killProcessGroupSync` may invoke it with a negative pid. */
  killSync?: (pid: number, signal: NodeJS.Signals) => void
  /**
   * Signal-0 group liveness probe (delivers NOTHING — error checking only, I3-safe). 'unknown'
   * covers EPERM and any other non-ESRCH failure: the group may still have members we cannot see.
   */
  probeGroupSync?: (pgid: number) => CodexGroupProbeResult
  proc?: CodexChildProcessLike
  log?: CodexChildRegistryLogger
}

export type CodexChildRegistry = {
  register: (entry: CodexChildEntry) => void
  deregister: (pid: number) => boolean
  /**
   * m8: deregister only when the signal-0 probe confirms the whole group is gone (ESRCH). On
   * 'alive'/'unknown' (e.g. EPERM) the entry stays registered so exit-time reap still covers it.
   * On non-Linux platforms (no negative-pid probe semantics guaranteed + reapSync is a no-op
   * there) deregisters unconditionally.
   */
  deregisterIfGroupGone: (pid: number) => boolean
  snapshot: () => CodexChildEntry[]
  /**
   * r2-11: steady-state drain — ESRCH-probe every 'resume-pty' entry and deregister confirmed-gone
   * groups. onExit-time deregistration keeps an entry when its group still had members (or the
   * probe was inconclusive); if those members die later no event fires, so the hourly
   * observability tick calls this. Probe-only (signal 0): never signals. Returns drained count.
   */
  probeResumePtyGroups: () => number
  reapSync: () => void
  installExitHandlers: (options: CodexChildExitHandlerOptions) => void
}

/** r2-3: hard byte bound for exit-path /proc cmdline reads. */
export const PROC_READ_MAX_BYTES = 4096

/**
 * R3-M1: hard byte bound for exit-path /proc environ reads. Both spawn sites append the ownership
 * marker LAST in env-spread order (reordering would break override semantics when the dev server
 * itself runs inside a freshell pane whose parentEnv already carries FRESHELL_TERMINAL_ID), and
 * real environs on this host run ~5,900 bytes -- so the previous 4096-byte bound left the marker
 * unreachable on essentially every spawn and the dead-pid group reap silently never fired. Linux
 * caps a single env string at 128 KiB, so 256 KiB stays a hard bound while comfortably covering
 * any realistic environ.
 */
export const PROC_ENVIRON_READ_MAX_BYTES = 256 * 1024

type ProcStatInfo = { pgrp: number; startTimeTicks: number }

export type BoundedRead = { data: Buffer; truncated: boolean }

/** pgid -> live member pids, built at most once per reap pass (r2-4). */
type ProcGroupIndex = Map<number, number[]>

/**
 * Parses pgrp (field 5) and starttime (field 22) of a `/proc/<pid>/stat` line; comm may contain
 * spaces/parens, so fields are counted after the LAST close paren.
 */
function parseProcStatInfo(stat: string): ProcStatInfo | null {
  const closeParen = stat.lastIndexOf(')')
  if (closeParen === -1) return null
  const fields = stat.slice(closeParen + 2).trim().split(/\s+/)
  const pgrp = Number(fields[2])
  const startTimeTicks = Number(fields[19])
  if (!Number.isInteger(pgrp) || !Number.isFinite(startTimeTicks)) return null
  return { pgrp, startTimeTicks }
}

/**
 * r2-2: codex identity predicate over a NUL-separated /proc cmdline. Some argv token's basename
 * must be exactly `codex` — argv[0] for the plain binary, any later token for node-wrapper
 * launches like `node /x/bin/codex`. Substring matches are rejected: `vim codex-notes.md` or a
 * path that merely contains "codex" (worktree/branch names) must never look like a codex process.
 *
 * r2-12 (accepted reap-completeness caveat): a codex binary invoked under a name whose argv
 * contains no `codex` basename token (renamed copy, busybox-style symlink) is INVISIBLE to
 * exit-time reap and to the observability holder count. That fails SAFE for I3 — we never signal
 * what we cannot identify — but stays open for the leak; the async reaper's env-marker ownership
 * proof (runtime.ts) is the durable backstop for such groups.
 */
export function cmdlineHasCodexToken(rawCmdline: string): boolean {
  for (const token of rawCmdline.split('\0')) {
    if (token.length === 0) continue
    if (token.slice(token.lastIndexOf('/') + 1) === 'codex') return true
  }
  return false
}

/**
 * r2-3: bounded synchronous /proc read for the exit path — openSync + readSync into a fixed
 * buffer, never fs.readFileSync (a pathological cmdline/environ cannot balloon exit-time memory
 * or latency). Reads one byte past maxBytes purely to detect truncation.
 */
export function readProcFileBoundedSync(filePath: string, maxBytes: number): BoundedRead {
  const fd = fs.openSync(filePath, 'r')
  try {
    const buffer = Buffer.allocUnsafe(maxBytes + 1)
    let total = 0
    while (total < buffer.length) {
      const bytesRead = fs.readSync(fd, buffer, total, buffer.length - total, null)
      if (bytesRead === 0) break
      total += bytesRead
    }
    return { data: buffer.subarray(0, Math.min(total, maxBytes)), truncated: total > maxBytes }
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * Default signal-0 group liveness probe. Signal 0 performs error checking only — the kernel
 * delivers nothing, so this can never kill (I3-safe; the structural test pins the `0`).
 */
function defaultProbeGroupSync(pgid: number): CodexGroupProbeResult {
  try {
    process.kill(-pgid, 0)
    return 'alive'
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'gone' : 'unknown'
  }
}

export function createCodexChildRegistry(deps: CodexChildRegistryDeps = {}): CodexChildRegistry {
  const platform = deps.platform ?? process.platform
  const readFileSync = deps.readFileSync ?? ((filePath: string) => fs.readFileSync(filePath))
  // r2-3: tests that inject only readFileSync get a bounded wrapper derived from it, so the same
  // fake file map drives both read paths; production uses the fixed-buffer openSync read.
  const readFileBoundedSync = deps.readFileBoundedSync
    ?? (deps.readFileSync
      ? (filePath: string, maxBytes: number): BoundedRead => {
          const data = readFileSync(filePath)
          return { data: data.subarray(0, maxBytes), truncated: data.length > maxBytes }
        }
      : readProcFileBoundedSync)
  const readdirSync = deps.readdirSync ?? ((dirPath: string) => fs.readdirSync(dirPath))
  const killSync = deps.killSync ?? ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal))
  const probeGroupSync = deps.probeGroupSync ?? defaultProbeGroupSync
  const proc = deps.proc ?? (process as CodexChildProcessLike)
  const log = deps.log ?? logger.child({ component: 'codex-child-registry' })

  const children = new Map<number, CodexChildEntry>()
  let handlersInstalled = false

  function register(entry: CodexChildEntry): void {
    // Guards (I3): only well-formed, signalable-in-principle entries are ever tracked. pgid <= 1
    // would make the exit-time kill(-pgid) hit "every process" (-1) / "own group" (0) / init (1).
    if (!Number.isInteger(entry.pid) || entry.pid <= 0 || !Number.isInteger(entry.pgid) || entry.pgid <= 1) {
      log.warn({ entry }, 'Refusing to register codex child with invalid pid/pgid')
      return
    }
    // Pin the pid's identity at registration (panel M1a): entries can outlive a recycled pid by
    // days, so the exit-time reap must be able to prove the pid still names the SAME process.
    // Best-effort — an unreadable stat stores undefined and that entry is routed to the
    // ownership-gated group scan at reap time (r2-1).
    let startTimeTicks: number | undefined
    if (platform === 'linux') {
      try {
        startTimeTicks = parseProcStatInfo(readFileSync(`/proc/${entry.pid}/stat`).toString('utf8'))?.startTimeTicks
      } catch {
        startTimeTicks = undefined
      }
    }
    // R2-M1: only a well-formed NAME=VALUE marker is recorded; anything else is treated as "no
    // ownership proof available", which fail-closes the dead-pid group fallback for this entry.
    const envMarker =
      entry.envMarker
      && typeof entry.envMarker.name === 'string' && entry.envMarker.name.length > 0
      && typeof entry.envMarker.value === 'string' && entry.envMarker.value.length > 0
        ? { name: entry.envMarker.name, value: entry.envMarker.value }
        : undefined
    // Double-registration of the same pid is safe: latest registration wins (plan §6 idempotency).
    children.set(entry.pid, {
      pid: entry.pid,
      pgid: entry.pgid,
      kind: entry.kind,
      ...(startTimeTicks !== undefined ? { startTimeTicks } : {}),
      ...(envMarker ? { envMarker } : {}),
    })
  }

  function deregister(pid: number): boolean {
    return children.delete(pid)
  }

  function deregisterIfGroupGone(pid: number): boolean {
    if (platform === 'linux') {
      const pgid = children.get(pid)?.pgid ?? pid
      if (probeGroupSync(pgid) !== 'gone') return false
    }
    return children.delete(pid)
  }

  function snapshot(): CodexChildEntry[] {
    return [...children.values()].map((entry) => ({ ...entry }))
  }

  function probeResumePtyGroups(): number {
    // Linux-only, like reapSync: negative-pid probe semantics are what the drain relies on, and
    // exit-time reap (the thing stale entries would mislead) is a no-op elsewhere anyway.
    if (platform !== 'linux') return 0
    let drained = 0
    for (const [pid, entry] of [...children]) {
      if (entry.kind !== 'resume-pty') continue
      try {
        if (probeGroupSync(entry.pgid) === 'gone') {
          children.delete(pid)
          drained += 1
        }
      } catch {
        // The probe seam must never break the observability tick.
      }
    }
    return drained
  }

  /**
   * THE group-kill primitive. I3 (structural): its only caller is `reapSync`, which itself runs
   * only from the `'exit'` binding installed by `installExitHandlers`.
   */
  function killProcessGroupSync(pgid: number): void {
    killSync(-pgid, 'SIGKILL')
  }

  /**
   * r2-4: one bounded /proc walk per reap pass, shared across all dead-pid entries — a single
   * readdir plus one stat parse per pid, instead of a full rescan per entry. Returns null when
   * /proc cannot be enumerated (callers fail towards not signalling, I3).
   */
  function buildProcGroupIndexSync(): ProcGroupIndex | null {
    let names: string[]
    try {
      names = readdirSync('/proc')
    } catch {
      return null
    }
    const index: ProcGroupIndex = new Map()
    for (const name of names) {
      if (!/^\d+$/.test(name)) continue
      try {
        const info = parseProcStatInfo(readFileSync(`/proc/${name}/stat`).toString('utf8'))
        if (!info) continue
        const members = index.get(info.pgrp)
        if (members) {
          members.push(Number(name))
        } else {
          index.set(info.pgrp, [Number(name)])
        }
      } catch {
        continue // pid vanished mid-scan or unreadable
      }
    }
    return index
  }

  /**
   * Dead-pid fallback (panel M1b + R2-M1 ownership gate): the registered wrapper pid being gone
   * does NOT mean the group is gone — live grandchildren (the actual DB holders) can survive it,
   * and that is precisely the case the registry exists for. But pgid recycling means membership
   * plus a codex-looking cmdline is NOT ownership proof (the recycled pgid could host the OTHER
   * server instance's live codex pane). Kill only when a member of the registered pgid provably
   * carries the exact env marker this registration injected at spawn. No marker recorded,
   * unreadable environ, or a marker missing from a TRUNCATED environ read all fail closed.
   * Fully synchronous, per-pid try/catch'd.
   */
  function groupHasOwnedCodexMemberSync(
    entry: CodexChildEntry,
    getGroupIndex: () => ProcGroupIndex | null,
  ): boolean {
    // R2-M1: without a recorded env marker there is no ownership proof to check — never kill.
    if (!entry.envMarker) return false
    const marker = `${entry.envMarker.name}=${entry.envMarker.value}`
    const index = getGroupIndex()
    if (!index) return false // cannot enumerate /proc: fail towards not signalling (I3)
    const members = index.get(entry.pgid)
    if (!members || members.length === 0) return false // group gone (or fully unreadable)
    for (const pid of members) {
      try {
        // Cheap cmdline prefilter before the (larger) environ read.
        const cmdline = readFileBoundedSync(`/proc/${pid}/cmdline`, PROC_READ_MAX_BYTES)
        if (!cmdlineHasCodexToken(cmdline.data.toString('utf8'))) continue
        // Ownership proof: the exact NAME=VALUE marker injected at spawn. A marker that is absent
        // from a truncated read could live past the cutoff — that is absence of proof, not proof
        // of absence, so it never justifies a kill (r2-3 fail-closed). R3-M1: the environ bound is
        // deliberately larger than the cmdline bound because the spawn sites append the marker LAST.
        const environ = readFileBoundedSync(`/proc/${pid}/environ`, PROC_ENVIRON_READ_MAX_BYTES)
        const tokens = environ.data.toString('utf8').split('\0')
        // R3-m2: a truncated read can cut mid-token; the final element is potentially partial and
        // must never count as proof (`MARKER=valueEXTRA` cut exactly at the bound reads back as
        // `MARKER=value`).
        if (environ.truncated) tokens.pop()
        if (tokens.includes(marker)) return true
        if (environ.truncated) {
          // R3-M1: make "marker unreachable past the read bound" distinguishable from "provably
          // not ours" in the logs. Fail-closed behavior is unchanged either way.
          log.debug?.(
            { pid, pgid: entry.pgid, markerName: entry.envMarker.name, maxBytes: PROC_ENVIRON_READ_MAX_BYTES },
            'Truncated environ read without ownership marker; failing closed (not treated as owned)',
          )
        }
      } catch {
        continue // member vanished mid-scan or is unreadable: not proof either way
      }
    }
    return false // no member carries our marker: never signal
  }

  /**
   * Identity verdict for one registered entry (panel M1a). The live-pid fast path kills only when
   * EVERY provable check passes: recorded starttime matches exactly, the pid is still in the
   * registered process group, and its cmdline carries a codex token. Entries without a starttime
   * pin (r2-1), dead pids, and zombie/unreadable-cmdline wrappers all route to the ownership-gated
   * group scan above — pgrp+cmdline alone are never grounds to kill.
   */
  function shouldKillEntrySync(entry: CodexChildEntry, getGroupIndex: () => ProcGroupIndex | null): boolean {
    let statRaw: string | null
    try {
      statRaw = readFileSync(`/proc/${entry.pid}/stat`).toString('utf8')
    } catch {
      statRaw = null
    }
    if (statRaw === null) {
      // Registered pid is dead; the group may still hold live codex grandchildren.
      return groupHasOwnedCodexMemberSync(entry, getGroupIndex)
    }
    const info = parseProcStatInfo(statRaw)
    if (!info) return false // present but unprovable: never signal (I3)
    if (entry.startTimeTicks === undefined) {
      // r2-1: no identity pin was captured at registration, so the live-pid path cannot prove the
      // pid was not recycled. Route to the ownership-gated group scan instead of trusting
      // pgrp+cmdline alone.
      return groupHasOwnedCodexMemberSync(entry, getGroupIndex)
    }
    if (info.startTimeTicks !== entry.startTimeTicks) {
      return false // pid recycled by a different process: stale entry
    }
    if (info.pgrp !== entry.pgid) return false // pid no longer in the registered group: stale entry
    let cmdline: BoundedRead
    try {
      cmdline = readFileBoundedSync(`/proc/${entry.pid}/cmdline`, PROC_READ_MAX_BYTES)
    } catch {
      // stat readable but cmdline not (e.g. zombie wrapper): treat as dead-pid, scan the group.
      return groupHasOwnedCodexMemberSync(entry, getGroupIndex)
    }
    if (cmdline.data.length === 0) {
      // Zombie wrapper (empty cmdline): the wrapper is dead but grandchildren may live.
      return groupHasOwnedCodexMemberSync(entry, getGroupIndex)
    }
    return cmdlineHasCodexToken(cmdline.data.toString('utf8'))
  }

  /**
   * Synchronous best-effort reap of still-registered codex process groups, for `process.on('exit')`.
   * After a graceful shutdown the registry has been drained (children deregistered on confirmed
   * group death / pty exit), so this is a no-op.
   *
   * Residual pgid-reuse window (accepted, plan §6): the sync starttime+pgrp+cmdline re-check
   * narrows — but cannot close — the check-then-kill race. Between the /proc reads and kill(-pgid)
   * the pid could exit and the pgid be reused. This is narrower than signalling blindly but wider
   * than the async reaper's fresh ownership classification (runtime.ts classifyOwnedProcessGroup);
   * at process-death time there is no async alternative.
   */
  function reapSync(): void {
    try {
      // Linux-only: negative-pid group kill semantics plus the /proc identity re-check. On win32
      // (and darwin, which lacks /proc) this is a documented no-op.
      if (platform !== 'linux') return

      // Never signal our own process group. If we cannot prove our own pgid, refuse to signal
      // anything (fail towards not signalling — I3 over reap completeness).
      let ownPgid: number | null = null
      try {
        ownPgid = parseProcStatInfo(readFileSync('/proc/self/stat').toString('utf8'))?.pgrp ?? null
      } catch {
        ownPgid = null
      }
      if (ownPgid === null) return

      // r2-4: the /proc group index for dead-pid fallbacks is built lazily, at most once per pass,
      // and shared across every entry that needs the group scan.
      let groupIndex: ProcGroupIndex | null | undefined
      const getGroupIndex = (): ProcGroupIndex | null => {
        if (groupIndex === undefined) groupIndex = buildProcGroupIndexSync()
        return groupIndex
      }

      for (const [pid, entry] of [...children]) {
        try {
          children.delete(pid)
          const { pgid } = entry
          // Guards (I3): only registered pgids; never -1/0/1, our own pid's group, or our own pgid.
          if (!Number.isInteger(pgid) || pgid <= 1) continue
          if (pgid === proc.pid || pgid === ownPgid) continue
          if (!shouldKillEntrySync(entry, getGroupIndex)) continue

          killProcessGroupSync(pgid)
        } catch {
          // Best-effort per entry: an exit path must never throw (I4).
        }
      }
    } catch {
      // Never throw out of an exit path (I4).
    }
  }

  function installExitHandlers(options: CodexChildExitHandlerOptions): void {
    if (handlersInstalled) return
    handlersInstalled = true
    // 'exit' handlers must be synchronous; reapSync is. This is the ONLY binding that may
    // reference reapSync (I3, enforced structurally by the unit test).
    proc.on('exit', reapSync)
    // SIGHUP joins the existing graceful shutdown path (idempotent via isShuttingDown in index.ts).
    proc.on('SIGHUP', () => options.requestShutdown('SIGHUP'))
    // Observe/log ONLY: uncaughtException default-fatal semantics stay untouched; the fatal path
    // then runs 'exit' -> reapSync.
    proc.on('uncaughtExceptionMonitor', (error: unknown, origin: unknown) => {
      try {
        log.warn({ err: error, origin }, 'Uncaught exception observed; codex children will be reaped on exit')
      } catch {
        // Observability must never alter fatal-exception semantics.
      }
    })
  }

  return {
    register,
    deregister,
    deregisterIfGroupGone,
    snapshot,
    probeResumePtyGroups,
    reapSync,
    installExitHandlers,
  }
}

const defaultRegistry = createCodexChildRegistry()

export const registerCodexChild: CodexChildRegistry['register'] = defaultRegistry.register
export const deregisterCodexChild: CodexChildRegistry['deregister'] = defaultRegistry.deregister
export const deregisterCodexChildIfGroupGone: CodexChildRegistry['deregisterIfGroupGone'] =
  defaultRegistry.deregisterIfGroupGone
export const snapshotCodexChildren: CodexChildRegistry['snapshot'] = defaultRegistry.snapshot
export const probeRegisteredResumePtyGroups: CodexChildRegistry['probeResumePtyGroups'] =
  defaultRegistry.probeResumePtyGroups
export const reapSync: CodexChildRegistry['reapSync'] = defaultRegistry.reapSync
export const installCodexChildExitHandlers: CodexChildRegistry['installExitHandlers'] =
  defaultRegistry.installExitHandlers
