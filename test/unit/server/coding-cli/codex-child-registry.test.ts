import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import {
  cmdlineHasCodexToken,
  createCodexChildRegistry,
  deregisterCodexChild,
  PROC_ENVIRON_READ_MAX_BYTES,
  readProcFileBoundedSync,
  snapshotCodexChildren,
  type CodexChildEntry,
  type CodexChildProcessLike,
  type CodexGroupProbeResult,
} from '../../../../server/coding-cli/codex-child-registry.js'
import { CodexAppServerRuntime } from '../../../../server/coding-cli/codex-app-server/runtime.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const SERVER_DIR = path.resolve(__dirname, '../../../../server')
const REGISTRY_SOURCE_PATH = path.join(SERVER_DIR, 'coding-cli', 'codex-child-registry.ts')
const FAKE_SERVER_PATH = path.resolve(__dirname, '../../../fixtures/coding-cli/codex-app-server/fake-app-server.mjs')

// Generous startup budget for the real-spawn integration test; mirrors runtime.test.ts (the suite
// runs with fileParallelism, so freshly-spawned sidecars are CPU-starved under load).
const REAL_STARTUP_ATTEMPT_TIMEOUT_MS = 5_000

type FakeProc = CodexChildProcessLike & EventEmitter

function makeFakeProc(pid = 7_777): FakeProc {
  const emitter = new EventEmitter() as FakeProc
  ;(emitter as { pid: number }).pid = pid
  return emitter
}

// pid (comm) state ppid pgrp sess tty tpgid flags ... starttime(field 22) — comm intentionally
// contains a space + paren to exercise the lastIndexOf(')') parse. Field 22 (index 19 after the
// close paren) is starttime.
function statLine(pid: number, pgrp: number, startTimeTicks = 100): string {
  const tail = [
    'S', '1', String(pgrp), String(pgrp), '0', '-1', '4194560',
    '100', '0', '0', '0', // minflt cminflt majflt cmajflt
    '5', '3', '0', '0', // utime stime cutime cstime
    '20', '0', '1', '0', // priority nice threads itrealvalue
    String(startTimeTicks), '1024', '0', // starttime vsize rss
  ]
  return `${pid} (no de)s) ${tail.join(' ')}`
}

function makeHarness(overrides: {
  platform?: NodeJS.Platform
  ownPgid?: number | 'unreadable'
  procPid?: number
  files?: Record<string, string>
  probeGroupSync?: (pgid: number) => CodexGroupProbeResult
} = {}) {
  const procPid = overrides.procPid ?? 7_777
  const files = new Map<string, string>(Object.entries(overrides.files ?? {}))
  if (overrides.ownPgid !== 'unreadable') {
    files.set('/proc/self/stat', statLine(procPid, overrides.ownPgid ?? 4_242))
  }
  const kills: Array<{ pid: number; signal: string }> = []
  const readFileSync = vi.fn((filePath: string): Buffer => {
    const content = files.get(filePath)
    if (content === undefined) {
      const err = new Error(`ENOENT: ${filePath}`) as NodeJS.ErrnoException
      err.code = 'ENOENT'
      throw err
    }
    return Buffer.from(content)
  })
  // Directory listing derived from the fake file map (dead-pid group fallback scan).
  const readdirSync = vi.fn((dirPath: string): string[] => {
    const names = new Set<string>()
    for (const key of files.keys()) {
      if (!key.startsWith(`${dirPath}/`)) continue
      names.add(key.slice(dirPath.length + 1).split('/')[0])
    }
    return [...names]
  })
  const killSync = vi.fn((pid: number, signal: NodeJS.Signals) => {
    kills.push({ pid, signal })
  })
  const log = { warn: vi.fn(), debug: vi.fn() }
  const proc = makeFakeProc(procPid)
  const registry = createCodexChildRegistry({
    platform: overrides.platform ?? 'linux',
    readFileSync,
    readdirSync,
    killSync,
    ...(overrides.probeGroupSync ? { probeGroupSync: overrides.probeGroupSync } : {}),
    proc,
    log,
  })
  return { registry, kills, killSync, readFileSync, readdirSync, log, proc, files }
}

function entry(pid: number, kind: CodexChildEntry['kind'] = 'app-server', pgid = pid): CodexChildEntry {
  return { pid, pgid, kind }
}

// R2-M1 fixtures: the env-marker ownership proof recorded at registration and the exact
// NAME=VALUE line the group scan must find in a member's /proc environ.
const MARKER = { name: 'FRESHELL_TERMINAL_ID', value: 'term-1' }
const MARKER_ENV = 'FRESHELL_TERMINAL_ID=term-1'

describe('codex child registry', () => {
  describe('registration lifecycle', () => {
    it('registers, snapshots, and deregisters entries', () => {
      const { registry } = makeHarness()
      registry.register(entry(100, 'app-server'))
      registry.register(entry(200, 'resume-pty'))

      expect(registry.snapshot()).toEqual([
        { pid: 100, pgid: 100, kind: 'app-server' },
        { pid: 200, pgid: 200, kind: 'resume-pty' },
      ])

      expect(registry.deregister(100)).toBe(true)
      expect(registry.snapshot()).toEqual([{ pid: 200, pgid: 200, kind: 'resume-pty' }])
      expect(registry.deregister(100)).toBe(false)
    })

    it('captures the /proc starttime at registration (best-effort identity pin)', () => {
      const { registry, files } = makeHarness()
      files.set('/proc/100/stat', statLine(100, 100, 777))
      registry.register(entry(100))
      // pid 200 has no readable stat: registration still succeeds without the pin.
      registry.register(entry(200, 'resume-pty'))

      expect(registry.snapshot()).toEqual([
        { pid: 100, pgid: 100, kind: 'app-server', startTimeTicks: 777 },
        { pid: 200, pgid: 200, kind: 'resume-pty' },
      ])
    })

    it('records the env-marker ownership proof and drops malformed markers (R2-M1)', () => {
      const { registry } = makeHarness()
      registry.register({ ...entry(100), envMarker: MARKER })
      registry.register({ ...entry(200, 'resume-pty'), envMarker: { name: '', value: 'x' } })

      expect(registry.snapshot()).toEqual([
        { pid: 100, pgid: 100, kind: 'app-server', envMarker: MARKER },
        { pid: 200, pgid: 200, kind: 'resume-pty' },
      ])
    })

    it('is safe to double-register the same pid (latest registration wins)', () => {
      const { registry } = makeHarness()
      registry.register(entry(100, 'app-server'))
      registry.register({ pid: 100, pgid: 100, kind: 'resume-pty' })

      expect(registry.snapshot()).toEqual([{ pid: 100, pgid: 100, kind: 'resume-pty' }])
    })

    it('refuses invalid pids and pgids (never track -1/0/1)', () => {
      const { registry, log } = makeHarness()
      registry.register({ pid: 0, pgid: 100, kind: 'app-server' })
      registry.register({ pid: -3, pgid: 100, kind: 'app-server' })
      registry.register({ pid: 1.5, pgid: 100, kind: 'app-server' })
      registry.register({ pid: 100, pgid: -1, kind: 'app-server' })
      registry.register({ pid: 100, pgid: 0, kind: 'app-server' })
      registry.register({ pid: 100, pgid: 1, kind: 'app-server' })

      expect(registry.snapshot()).toEqual([])
      expect(log.warn).toHaveBeenCalledTimes(6)
    })

    it('snapshot returns copies (mutation cannot corrupt the registry)', () => {
      const { registry } = makeHarness()
      registry.register(entry(100))
      const snap = registry.snapshot()
      snap[0].pgid = -1
      snap.pop()
      expect(registry.snapshot()).toEqual([{ pid: 100, pgid: 100, kind: 'app-server' }])
    })
  })

  describe('reapSync', () => {
    it('SIGKILLs only registered entries whose /proc identity still verifies (starttime+pgrp+cmdline)', () => {
      const { registry, kills, files } = makeHarness()
      files.set('/proc/100/stat', statLine(100, 100, 11))
      files.set('/proc/100/cmdline', '/usr/local/bin/codex\0resume\0abc\0')
      // pid 300 was reused by a non-codex process (same pid, non-codex cmdline).
      files.set('/proc/300/stat', statLine(300, 300, 33))
      files.set('/proc/300/cmdline', '/bin/bash\0')
      registry.register(entry(100, 'app-server'))
      registry.register(entry(300, 'resume-pty'))

      registry.reapSync()

      expect(kills).toEqual([{ pid: -100, signal: 'SIGKILL' }])
      // The pass drains the registry: a second reap is a no-op.
      expect(registry.snapshot()).toEqual([])
      registry.reapSync()
      expect(kills).toHaveLength(1)
    })

    it('kills the group when the registered pid is dead and a member carries the env marker (M1b + R2-M1)', () => {
      const { registry, kills, files } = makeHarness()
      // The registered wrapper (pid 200) is gone from /proc, but grandchild 250 still lives in
      // pgid 200, looks like codex, AND provably carries the marker this registration injected at
      // spawn — this is the D-state-holder case the registry exists for.
      files.set('/proc/250/stat', statLine(250, 200, 55))
      files.set('/proc/250/cmdline', '/usr/local/bin/codex\0app-server\0')
      files.set('/proc/250/environ', `HOME=/root\0${MARKER_ENV}\0`)
      registry.register({ ...entry(200, 'app-server'), envMarker: MARKER })

      registry.reapSync()

      expect(kills).toEqual([{ pid: -200, signal: 'SIGKILL' }])
    })

    it('never group-kills when no env marker was recorded, even with a codex member present (R2-M1)', () => {
      const { registry, kills, files } = makeHarness()
      files.set('/proc/250/stat', statLine(250, 200, 55))
      files.set('/proc/250/cmdline', '/usr/local/bin/codex\0app-server\0')
      files.set('/proc/250/environ', `${MARKER_ENV}\0`)
      registry.register(entry(200, 'app-server')) // no envMarker: no ownership proof exists

      registry.reapSync()

      expect(kills).toEqual([])
    })

    it('never group-kills when the codex member lacks the exact marker (R2-M1)', () => {
      const { registry, kills, files } = makeHarness()
      // pgid recycled: the member is a REAL codex process, but it belongs to someone else (e.g.
      // the other server instance's live pane) — its environ carries a different marker value.
      files.set('/proc/250/stat', statLine(250, 200, 55))
      files.set('/proc/250/cmdline', '/usr/local/bin/codex\0resume\0')
      files.set('/proc/250/environ', 'FRESHELL_TERMINAL_ID=someone-else\0')
      registry.register({ ...entry(200, 'app-server'), envMarker: MARKER })

      registry.reapSync()

      expect(kills).toEqual([])
    })

    it('never group-kills when the member environ is unreadable (R2-M1 fail-closed)', () => {
      const { registry, kills, files } = makeHarness()
      files.set('/proc/250/stat', statLine(250, 200, 55))
      files.set('/proc/250/cmdline', '/usr/local/bin/codex\0')
      // no /proc/250/environ entry: the read throws (EACCES/ENOENT equivalent)
      registry.register({ ...entry(200, 'app-server'), envMarker: MARKER })

      registry.reapSync()

      expect(kills).toEqual([])
    })

    it('never group-kills when the marker sits past the environ read bound (r2-3/R3-M1 fail-closed)', () => {
      const { registry, kills, files, log } = makeHarness()
      files.set('/proc/250/stat', statLine(250, 200, 55))
      files.set('/proc/250/cmdline', '/usr/local/bin/codex\0')
      // The filler alone exceeds PROC_ENVIRON_READ_MAX_BYTES, so the trailing marker is unreachable.
      files.set('/proc/250/environ', `FILLER=${'A'.repeat(PROC_ENVIRON_READ_MAX_BYTES)}\0${MARKER_ENV}\0`)
      registry.register({ ...entry(200, 'app-server'), envMarker: MARKER })

      registry.reapSync()

      expect(kills).toEqual([])
      // R3-M1: "marker unreachable past the bound" is distinguishable from "provably not ours".
      expect(log.debug).toHaveBeenCalledWith(
        expect.objectContaining({ pid: 250, pgid: 200, maxBytes: PROC_ENVIRON_READ_MAX_BYTES }),
        expect.stringContaining('Truncated environ read without ownership marker'),
      )
    })

    it('group-kills when the marker sits at the real-world ~5,900-byte environ position (R3-M1)', () => {
      const { registry, kills, files } = makeHarness()
      files.set('/proc/250/stat', statLine(250, 200, 55))
      files.set('/proc/250/cmdline', '/usr/local/bin/codex\0')
      // Both spawn sites append the marker LAST in env-spread order and real environs on this host
      // run ~5,900 bytes; under the old 4096-byte bound this marker was unreachable on essentially
      // every spawn, so the dead-pid group reap silently never fired.
      files.set('/proc/250/environ', `FILLER=${'A'.repeat(5_900)}\0${MARKER_ENV}\0`)
      registry.register({ ...entry(200, 'app-server'), envMarker: MARKER })

      registry.reapSync()

      expect(kills).toEqual([{ pid: -200, signal: 'SIGKILL' }])
    })

    it('never counts a truncation-torn trailing token as the marker (R3-m2)', () => {
      const { registry, kills, files } = makeHarness()
      files.set('/proc/250/stat', statLine(250, 200, 55))
      files.set('/proc/250/cmdline', '/usr/local/bin/codex\0')
      // A DIFFERENT env value (`${MARKER_ENV}EXTRA`) cut exactly at the read bound leaves visible
      // bytes identical to the real marker. The torn final token must never count as ownership
      // proof, so this member is "not provably ours" and the group is never signalled.
      const prefix = `FILLER=${'A'.repeat(PROC_ENVIRON_READ_MAX_BYTES - 'FILLER=\0'.length - MARKER_ENV.length)}\0`
      files.set('/proc/250/environ', `${prefix}${MARKER_ENV}EXTRA\0`)
      registry.register({ ...entry(200, 'app-server'), envMarker: MARKER })

      registry.reapSync()

      expect(kills).toEqual([])
    })

    it('group-kills when the marker is within the read bound of a truncated environ (r2-3)', () => {
      const { registry, kills, files } = makeHarness()
      files.set('/proc/250/stat', statLine(250, 200, 55))
      files.set('/proc/250/cmdline', '/usr/local/bin/codex\0')
      files.set('/proc/250/environ', `${MARKER_ENV}\0FILLER=${'A'.repeat(PROC_ENVIRON_READ_MAX_BYTES)}\0`)
      registry.register({ ...entry(200, 'app-server'), envMarker: MARKER })

      registry.reapSync()

      expect(kills).toEqual([{ pid: -200, signal: 'SIGKILL' }])
    })

    it('routes zombie wrappers (empty cmdline) through the ownership-gated group scan (R2-M1)', () => {
      const { registry, kills, files } = makeHarness()
      files.set('/proc/200/stat', statLine(200, 200, 44))
      registry.register({ ...entry(200, 'app-server'), envMarker: MARKER })
      files.set('/proc/200/cmdline', '') // zombie: stat readable, cmdline empty
      files.set('/proc/250/stat', statLine(250, 200, 55))
      files.set('/proc/250/cmdline', '/usr/local/bin/codex\0')
      files.set('/proc/250/environ', `${MARKER_ENV}\0`)

      registry.reapSync()

      expect(kills).toEqual([{ pid: -200, signal: 'SIGKILL' }])
    })

    it('skips a dead pid whose pgid was recycled by non-codex processes (M1b)', () => {
      const { registry, kills, files } = makeHarness()
      files.set('/proc/250/stat', statLine(250, 200, 55))
      files.set('/proc/250/cmdline', '/bin/bash\0')
      // Even a (nonsensical) matching marker cannot rescue a non-codex member: the cmdline
      // prefilter rejects it before the environ is consulted.
      files.set('/proc/250/environ', `${MARKER_ENV}\0`)
      registry.register({ ...entry(200, 'app-server'), envMarker: MARKER })

      registry.reapSync()

      expect(kills).toEqual([])
    })

    it('skips a dead pid whose group has no remaining members', () => {
      const { registry, kills } = makeHarness()
      registry.register(entry(200, 'app-server'))

      registry.reapSync()

      expect(kills).toEqual([])
    })

    it('skips an entry whose recorded starttime no longer matches (pid recycled, M1a)', () => {
      const { registry, kills, files } = makeHarness()
      files.set('/proc/100/stat', statLine(100, 100, 11))
      files.set('/proc/100/cmdline', 'codex\0')
      registry.register(entry(100))
      // The pid was recycled: same pid+pgrp+codex-looking cmdline, different starttime — e.g. the
      // OTHER server instance's live codex pane. Must never be signaled.
      files.set('/proc/100/stat', statLine(100, 100, 999))

      registry.reapSync()

      expect(kills).toEqual([])
    })

    it('skips an entry whose pid left the registered process group (M1a)', () => {
      const { registry, kills, files } = makeHarness()
      files.set('/proc/100/stat', statLine(100, 100, 11))
      files.set('/proc/100/cmdline', 'codex\0')
      registry.register(entry(100))
      files.set('/proc/100/stat', statLine(100, 999, 11))

      registry.reapSync()

      expect(kills).toEqual([])
    })

    it('does not trust the live-pid path without a starttime pin: pgrp+cmdline alone never kill (r2-1)', () => {
      const { registry, kills, files } = makeHarness()
      // No stat available at register time (startTimeTicks undefined)...
      registry.register({ ...entry(100), envMarker: MARKER })
      // ...readable at reap time with a codex cmdline — but the pin is missing, so the entry
      // routes to the ownership-gated group scan, and no member carries the marker.
      files.set('/proc/100/stat', statLine(100, 100, 11))
      files.set('/proc/100/cmdline', 'codex\0')

      registry.reapSync()

      expect(kills).toEqual([])
    })

    it('kills via the group scan when an unpinned live pid provably carries the marker (r2-1 + R2-M1)', () => {
      const { registry, kills, files } = makeHarness()
      registry.register({ ...entry(100), envMarker: MARKER })
      files.set('/proc/100/stat', statLine(100, 100, 11))
      files.set('/proc/100/cmdline', 'codex\0')
      files.set('/proc/100/environ', `${MARKER_ENV}\0`)

      registry.reapSync()

      expect(kills).toEqual([{ pid: -100, signal: 'SIGKILL' }])
    })

    it('builds the /proc group index once per pass across dead-pid entries (r2-4)', () => {
      const { registry, kills, readdirSync, files } = makeHarness()
      files.set('/proc/250/stat', statLine(250, 200, 55))
      files.set('/proc/250/cmdline', 'codex\0')
      files.set('/proc/250/environ', `${MARKER_ENV}\0`)
      files.set('/proc/350/stat', statLine(350, 300, 66))
      files.set('/proc/350/cmdline', 'codex\0')
      files.set('/proc/350/environ', `${MARKER_ENV}\0`)
      registry.register({ ...entry(200), envMarker: MARKER })
      registry.register({ ...entry(300), envMarker: MARKER })

      registry.reapSync()

      expect(kills).toEqual([
        { pid: -200, signal: 'SIGKILL' },
        { pid: -300, signal: 'SIGKILL' },
      ])
      // One readdir for the whole pass, not one per dead-pid entry.
      expect(readdirSync).toHaveBeenCalledTimes(1)
    })

    it('never signals our own process group or our own pid group', () => {
      const { registry, kills, files } = makeHarness({ ownPgid: 4_242, procPid: 7_777 })
      files.set('/proc/555/stat', statLine(555, 4_242))
      files.set('/proc/555/cmdline', 'codex\0')
      files.set('/proc/556/stat', statLine(556, 7_777))
      files.set('/proc/556/cmdline', 'codex\0')
      registry.register({ pid: 555, pgid: 4_242, kind: 'app-server' }) // own pgid
      registry.register({ pid: 556, pgid: 7_777, kind: 'app-server' }) // our pid's group

      registry.reapSync()

      expect(kills).toEqual([])
    })

    it('signals nothing when our own pgid cannot be proven', () => {
      const { registry, kills, files } = makeHarness({ ownPgid: 'unreadable' })
      files.set('/proc/100/stat', statLine(100, 100))
      files.set('/proc/100/cmdline', 'codex\0')
      registry.register(entry(100))

      registry.reapSync()

      expect(kills).toEqual([])
    })

    it('is a no-op on win32 (register/deregister still track)', () => {
      const { registry, kills, readFileSync } = makeHarness({ platform: 'win32' })
      registry.register(entry(100))

      expect(registry.snapshot()).toEqual([{ pid: 100, pgid: 100, kind: 'app-server' }])
      registry.reapSync()
      expect(kills).toEqual([])
      expect(readFileSync).not.toHaveBeenCalled()
      expect(registry.snapshot()).toEqual([{ pid: 100, pgid: 100, kind: 'app-server' }])
    })

    it('never throws out of the exit path and keeps reaping after a kill failure', () => {
      const { registry, killSync, kills, files } = makeHarness()
      files.set('/proc/100/stat', statLine(100, 100, 11))
      files.set('/proc/100/cmdline', 'codex\0')
      files.set('/proc/200/stat', statLine(200, 200, 22))
      files.set('/proc/200/cmdline', 'codex\0')
      killSync.mockImplementationOnce(() => {
        throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
      })
      registry.register(entry(100))
      registry.register(entry(200))

      expect(() => registry.reapSync()).not.toThrow()
      // First kill threw; the second entry was still processed.
      expect(kills).toEqual([{ pid: -200, signal: 'SIGKILL' }])
    })
  })

  describe('installExitHandlers', () => {
    it("binds 'exit' to reapSync itself, routes SIGHUP to shutdown, and observes uncaught exceptions", () => {
      const { registry, proc, log } = makeHarness()
      const requestShutdown = vi.fn()

      registry.installExitHandlers({ requestShutdown })

      expect(proc.listeners('exit')).toEqual([registry.reapSync])
      expect(proc.listenerCount('SIGHUP')).toBe(1)
      expect(proc.listenerCount('uncaughtExceptionMonitor')).toBe(1)

      proc.emit('SIGHUP')
      expect(requestShutdown).toHaveBeenCalledExactlyOnceWith('SIGHUP')

      proc.emit('uncaughtExceptionMonitor', new Error('boom'), 'uncaughtException')
      expect(log.warn).toHaveBeenCalledTimes(1)
      // Observe-only: the monitor must not trigger shutdown or reap.
      expect(requestShutdown).toHaveBeenCalledTimes(1)
    })

    it('is idempotent (double install binds once)', () => {
      const { registry, proc } = makeHarness()
      registry.installExitHandlers({ requestShutdown: vi.fn() })
      registry.installExitHandlers({ requestShutdown: vi.fn() })

      expect(proc.listenerCount('exit')).toBe(1)
      expect(proc.listenerCount('SIGHUP')).toBe(1)
      expect(proc.listenerCount('uncaughtExceptionMonitor')).toBe(1)
    })
  })

  describe('cmdlineHasCodexToken (r2-2)', () => {
    it('accepts codex argv tokens by basename (plain binary, absolute path, node wrapper)', () => {
      expect(cmdlineHasCodexToken('codex\0')).toBe(true)
      expect(cmdlineHasCodexToken('/usr/bin/codex\0resume\0abc\0')).toBe(true)
      expect(cmdlineHasCodexToken('node\0/x/bin/codex\0app-server\0')).toBe(true)
    })

    it('rejects substring and path-only matches', () => {
      expect(cmdlineHasCodexToken('vim\0codex-notes.md\0')).toBe(false)
      expect(cmdlineHasCodexToken('/home/dan/.worktrees/codex-launch-leak-plan/server/index.ts\0')).toBe(false)
      expect(cmdlineHasCodexToken('/usr/bin/codex-tui\0')).toBe(false)
      expect(cmdlineHasCodexToken('bash\0-c\0echo codex\0')).toBe(false)
      expect(cmdlineHasCodexToken('')).toBe(false)
    })
  })

  describe('readProcFileBoundedSync (R3-m4: the production openSync/readSync helper)', () => {
    it('bounds oversized files, returns small files whole, and throws ENOENT for missing paths', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freshell-bounded-read-'))
      try {
        const bigPath = path.join(dir, 'big')
        const smallPath = path.join(dir, 'small')
        fs.writeFileSync(bigPath, Buffer.alloc(4096 + 500, 0x41))
        fs.writeFileSync(smallPath, 'MARKER=value\0')

        // Oversized content: exactly maxBytes bytes back, flagged truncated.
        const big = readProcFileBoundedSync(bigPath, 4096)
        expect(big.truncated).toBe(true)
        expect(big.data.length).toBe(4096)
        expect(big.data.equals(Buffer.alloc(4096, 0x41))).toBe(true)

        // Undersized content: returned whole, not truncated.
        const small = readProcFileBoundedSync(smallPath, 4096)
        expect(small.truncated).toBe(false)
        expect(small.data.toString('utf8')).toBe('MARKER=value\0')

        // Exact-bound content is NOT flagged (the helper reads one byte past to detect overflow).
        const exact = readProcFileBoundedSync(bigPath, 4096 + 500)
        expect(exact.truncated).toBe(false)
        expect(exact.data.length).toBe(4096 + 500)

        // Missing file: the open throws (callers per-pid try/catch and fail closed).
        expect(() => readProcFileBoundedSync(path.join(dir, 'missing'), 4096)).toThrow(/ENOENT/)
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    })
  })

  describe('deregisterIfGroupGone (m8, r2-13b)', () => {
    it('keeps the entry on alive/unknown probes and deregisters only on a confirmed-gone group', () => {
      const probeGroupSync = vi.fn((_pgid: number): CodexGroupProbeResult => 'alive')
      const { registry } = makeHarness({ probeGroupSync })
      registry.register(entry(100, 'resume-pty'))

      expect(registry.deregisterIfGroupGone(100)).toBe(false) // alive: keep
      expect(registry.snapshot()).toHaveLength(1)

      probeGroupSync.mockReturnValueOnce('unknown') // e.g. EPERM: cannot confirm, keep
      expect(registry.deregisterIfGroupGone(100)).toBe(false)
      expect(registry.snapshot()).toHaveLength(1)

      probeGroupSync.mockReturnValueOnce('gone')
      expect(registry.deregisterIfGroupGone(100)).toBe(true)
      expect(registry.snapshot()).toEqual([])
      expect(probeGroupSync).toHaveBeenCalledWith(100)
    })

    it('deregisters unconditionally off Linux (no probe semantics there)', () => {
      const probeGroupSync = vi.fn((_pgid: number): CodexGroupProbeResult => 'alive')
      const { registry } = makeHarness({ platform: 'win32', probeGroupSync })
      registry.register(entry(100, 'resume-pty'))

      expect(registry.deregisterIfGroupGone(100)).toBe(true)
      expect(probeGroupSync).not.toHaveBeenCalled()
    })
  })

  describe('probeResumePtyGroups (r2-11)', () => {
    it('drains confirmed-gone resume-pty groups; never probes app-server entries', () => {
      const gone = new Set([200])
      const probeGroupSync = vi.fn((pgid: number): CodexGroupProbeResult => (gone.has(pgid) ? 'gone' : 'alive'))
      const { registry } = makeHarness({ probeGroupSync })
      registry.register(entry(100, 'resume-pty')) // alive -> kept
      registry.register(entry(200, 'resume-pty')) // gone -> drained
      registry.register(entry(300, 'app-server')) // app-server: owned by teardown, never probed

      expect(registry.probeResumePtyGroups()).toBe(1)

      expect(registry.snapshot().map((child) => child.pid)).toEqual([100, 300])
      expect(probeGroupSync).toHaveBeenCalledTimes(2)
      expect(probeGroupSync).not.toHaveBeenCalledWith(300)
    })

    it('keeps entries whose probe is inconclusive (unknown/EPERM)', () => {
      const probeGroupSync = vi.fn((_pgid: number): CodexGroupProbeResult => 'unknown')
      const { registry } = makeHarness({ probeGroupSync })
      registry.register(entry(200, 'resume-pty'))

      expect(registry.probeResumePtyGroups()).toBe(0)
      expect(registry.snapshot()).toHaveLength(1)
    })

    it('is a no-op off Linux', () => {
      const probeGroupSync = vi.fn((_pgid: number): CodexGroupProbeResult => 'gone')
      const { registry } = makeHarness({ platform: 'darwin', probeGroupSync })
      registry.register(entry(200, 'resume-pty'))

      expect(registry.probeResumePtyGroups()).toBe(0)
      expect(registry.snapshot()).toHaveLength(1)
      expect(probeGroupSync).not.toHaveBeenCalled()
    })
  })

  describe('structural I3 assertion (plan §6 acceptance #2)', () => {
    const source = fs.readFileSync(REGISTRY_SOURCE_PATH, 'utf8')

    it('the group-kill primitive is the only negative-pid signal and has exactly one caller: reapSync', () => {
      // Exactly one negative-pid kill in the module, and it lives inside killProcessGroupSync.
      const negativeKills = source.match(/killSync\(\s*-/g) ?? []
      expect(negativeKills).toHaveLength(1)
      // The ONLY other negative-pid syscall is the signal-0 liveness probe (r2-11/m8), which by
      // definition delivers nothing — every process.kill(-...) in the module must pass signal 0.
      const negativeProcessKills = source.match(/process\.kill\(\s*-[^)]*\)/g) ?? []
      expect(negativeProcessKills).toEqual(['process.kill(-pgid, 0)'])

      const primitiveBody = source.slice(
        source.indexOf('function killProcessGroupSync'),
        source.indexOf('function reapSync'),
      )
      expect(primitiveBody).toContain("killSync(-pgid, 'SIGKILL')")

      // killProcessGroupSync appears exactly twice: its definition and its single call site…
      const references = source.match(/killProcessGroupSync\(/g) ?? []
      expect(references).toHaveLength(2)
      // …and the call site is inside reapSync's body. The identity helpers between the primitive
      // and reapSync (groupHasCodexMemberSync/shouldKillEntrySync) only return verdicts — they
      // must never signal.
      const reapBody = source.slice(
        source.indexOf('function reapSync'),
        source.indexOf('function installExitHandlers'),
      )
      expect(reapBody.match(/killProcessGroupSync\(/g)).toHaveLength(1)
    })

    it("reapSync is never invoked directly and is referenced only by the 'exit' binding", () => {
      // No direct invocation anywhere in the module (the definition is the only `reapSync(` token).
      const invocations = source.match(/(?<!function )reapSync\(/g) ?? []
      expect(invocations).toEqual([])
      // Exactly one handler registration passes reapSync, and it is the 'exit' binding.
      expect(source.match(/,\s*reapSync\)/g)).toHaveLength(1)
      expect(source).toContain("proc.on('exit', reapSync)")
    })

    it('no other server module invokes reapSync', () => {
      const offenders: string[] = []
      const walk = (dir: string): void => {
        for (const dirent of fs.readdirSync(dir, { withFileTypes: true })) {
          const fullPath = path.join(dir, dirent.name)
          if (dirent.isDirectory()) {
            if (dirent.name === 'node_modules') continue
            walk(fullPath)
            continue
          }
          if (!dirent.name.endsWith('.ts')) continue
          if (fullPath === REGISTRY_SOURCE_PATH) continue
          const content = fs.readFileSync(fullPath, 'utf8')
          // Invocation, or importing the exported reapSync binding (comments may legitimately
          // *mention* reapSync when documenting the exit path).
          const invokes = /\breapSync\(/.test(content)
          const importsBinding = /\{[^}]*\breapSync\b[^}]*\}\s*from\s*'[^']*codex-child-registry/.test(content)
          if (invokes || importsBinding) {
            offenders.push(fullPath)
          }
        }
      }
      walk(SERVER_DIR)
      expect(offenders).toEqual([])
    })
  })

  describe('wiring (source-level)', () => {
    it('runtime.ts registers at spawn and deregisters only on confirmed group death', () => {
      const runtimeSource = fs.readFileSync(path.join(SERVER_DIR, 'coding-cli', 'codex-app-server', 'runtime.ts'), 'utf8')
      expect(runtimeSource).toMatch(
        /registerCodexChild\(\{\s*pid: child\.pid,\s*pgid: child\.pid,\s*kind: 'app-server',[\s\S]{0,400}?envMarker: \{ name: 'FRESHELL_CODEX_SIDECAR_ID', value: ownershipId \},\s*\}\)/,
      )
      // Deregistration is gated on teardownOwnedProcessGroup's confirmed-death result…
      expect(runtimeSource).toContain('if (confirmedGone) deregisterCodexChild(ownership.metadata.wrapperPid)')
      // …and the wrapper-exit handler does NOT deregister (grandchildren can outlive the wrapper).
      const wrapperExitBody = runtimeSource.slice(
        runtimeSource.indexOf('private attachChildExitHandler'),
        runtimeSource.indexOf('private async stopActiveChild'),
      )
      expect(wrapperExitBody).not.toContain('deregisterCodexChild')
      // m1: the spawn-failure-before-ownership path deregisters on the child's exit (the only
      // case where ownership teardown will never run for the child).
      const stopActiveChildBody = runtimeSource.slice(
        runtimeSource.indexOf('private async stopActiveChild'),
        runtimeSource.indexOf('private async waitForOwnershipTeardown'),
      )
      expect(stopActiveChildBody).toContain('deregisterCodexChild')
    })

    it('terminal-registry.ts registers codex ptys at both spawn sites and deregisters only on confirmed group death', () => {
      const registrySource = fs.readFileSync(path.join(SERVER_DIR, 'terminal-registry.ts'), 'utf8')
      const registrations = registrySource.match(
        /registerCodexChild\(\{\s*pid: ptyProc\.pid,\s*pgid: ptyProc\.pid,\s*kind: 'resume-pty',/g,
      ) ?? []
      expect(registrations).toHaveLength(2)
      // R2-M1: both spawn sites record the FRESHELL_TERMINAL_ID env marker (already present in
      // the pty env via buildTerminalBaseEnv) as the group-scan ownership proof.
      const markers = registrySource.match(
        /envMarker: \{ name: 'FRESHELL_TERMINAL_ID', value: (?:terminalId|record\.terminalId) \}/g,
      ) ?? []
      expect(markers).toHaveLength(2)
      // The primary spawn site registers codex panes only.
      expect(registrySource).toContain("if (opts.mode === 'codex' && ptyProc.pid) {")
      // Both spawn-site onExit handlers route through the liveness-probing deregister helper (m8),
      // gated with the same codex condition as registration (m6). kill() never deregisters (it
      // only sends a signal).
      const deregistrations = registrySource.match(/deregisterCodexPtyIfGroupGone\(ptyProc\.pid\)/g) ?? []
      expect(deregistrations).toHaveLength(2)
      expect(registrySource).toContain("if (opts.mode === 'codex') deregisterCodexPtyIfGroupGone(ptyProc.pid)")
      expect(registrySource).toContain("if (record.mode === 'codex') deregisterCodexPtyIfGroupGone(ptyProc.pid)")
      // m8/r2-13b: the helper (now homed in codex-child-registry.ts behind an injectable probe
      // seam) only deregisters when the group is confirmed gone; terminal-registry imports it.
      expect(registrySource).toContain('deregisterCodexChildIfGroupGone as deregisterCodexPtyIfGroupGone')
      const killBody = registrySource.slice(
        registrySource.indexOf('kill(terminalId: string'),
        registrySource.indexOf('private markCodexRecoveryFinalClose'),
      )
      expect(killBody).not.toContain('deregisterCodexChild')
    })

    it('index.ts installs the bindings once and arms an unref()d 30s hard-exit timer in shutdown()', () => {
      const indexSource = fs.readFileSync(path.join(SERVER_DIR, 'index.ts'), 'utf8')
      expect(indexSource.match(/installCodexChildExitHandlers\(\{/g)).toHaveLength(1)
      expect(indexSource).toContain('const SHUTDOWN_HARD_EXIT_TIMEOUT_MS = 30_000')
      expect(indexSource).toContain('hardExitTimer.unref()')
      // M6: slow-but-healthy shutdowns get their connections severed; the force-exit line is also
      // written synchronously (async pino may not flush before exit); the happy path clears the timer.
      expect(indexSource).toContain('server.closeIdleConnections?.()')
      // r2-10: in-flight HTTP responses get a 3s unref()'d grace before closeAllConnections severs
      // them, cleared as soon as the server finishes closing on its own.
      expect(indexSource).toMatch(/setTimeout\(\(\) => \{\s*server\.closeAllConnections\?\.\(\)\s*\}, 3_000\)/)
      expect(indexSource).toContain('closeAllConnectionsTimer.unref()')
      expect(indexSource).toContain('void httpServerClosed.then(() => clearTimeout(closeAllConnectionsTimer))')
      expect(indexSource).toContain('process.stderr.write(')
      expect(indexSource).toContain('clearTimeout(hardExitTimer)')
      expect(indexSource).toContain("forcing exit")
      expect(indexSource).toContain('process.exit(1)\n    }, SHUTDOWN_HARD_EXIT_TIMEOUT_MS)')
    })
  })
})

const describeWithLinuxProc = process.platform === 'linux' ? describe : describe.skip

describeWithLinuxProc('codex child registry runtime integration', () => {
  const runtimes = new Set<CodexAppServerRuntime>()
  const tempDirs = new Set<string>()

  afterEach(async () => {
    await Promise.all([...runtimes].map(async (runtime) => {
      runtimes.delete(runtime)
      await runtime.shutdown()
    }))
    await Promise.all([...tempDirs].map(async (dir) => {
      tempDirs.delete(dir)
      await fsp.rm(dir, { recursive: true, force: true })
    }))
  })

  it('deregisters a spawn-failed no-ownership child on its exit (m1, r2-13a)', async () => {
    const metadataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-codex-child-registry-'))
    tempDirs.add(metadataDir)
    const fakePid = 3_999_999
    const child = Object.assign(new EventEmitter(), {
      pid: fakePid,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      stdout: null,
      stderr: null,
      kill: vi.fn(() => true),
    })
    const runtime = new CodexAppServerRuntime({
      metadataDir,
      startupAttemptLimit: 1,
      portAllocator: async () => ({ hostname: '127.0.0.1', port: 1 }),
      // The owner-identity read fails BEFORE any ownership record exists, so ownership teardown
      // (the usual deregistration point) will never run for this child.
      processIdentityReader: async () => null,
      spawnProcess: (() => child) as unknown as typeof spawn,
    })
    runtimes.add(runtime)

    await expect(runtime.ensureReady()).rejects.toThrow(/owner identity could not be completely read/)

    try {
      // Registered at spawn (with the R2-M1 env marker), SIGTERM'd by stopActiveChild, and still
      // registered while the child has not exited — kill() only sends a signal.
      expect(snapshotCodexChildren()).toContainEqual(expect.objectContaining({
        pid: fakePid,
        pgid: fakePid,
        kind: 'app-server',
        envMarker: expect.objectContaining({ name: 'FRESHELL_CODEX_SIDECAR_ID' }),
      }))
      expect(child.kill).toHaveBeenCalledWith('SIGTERM')

      child.exitCode = 0
      child.emit('exit', 0, null)

      expect(snapshotCodexChildren().some((c) => c.pid === fakePid)).toBe(false)
    } finally {
      deregisterCodexChild(fakePid)
    }
  })

  it('registers the app-server group at spawn and deregisters on confirmed teardown', async () => {
    const metadataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-codex-child-registry-'))
    tempDirs.add(metadataDir)
    const runtime = new CodexAppServerRuntime({
      command: process.execPath,
      commandArgs: [FAKE_SERVER_PATH],
      metadataDir,
      startupAttemptTimeoutMs: REAL_STARTUP_ATTEMPT_TIMEOUT_MS,
    })
    runtimes.add(runtime)

    const ready = await runtime.ensureReady()

    // The live registration also pins the wrapper's /proc starttime (M1a).
    expect(snapshotCodexChildren()).toContainEqual(expect.objectContaining({
      pid: ready.processPid,
      pgid: ready.processPid,
      kind: 'app-server',
      startTimeTicks: expect.any(Number),
    }))

    await runtime.shutdown()

    expect(snapshotCodexChildren().some((child) => child.pid === ready.processPid)).toBe(false)
  })
})
