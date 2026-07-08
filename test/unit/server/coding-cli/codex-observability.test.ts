import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  deregisterCodexChild,
  registerCodexChild,
  snapshotCodexChildren,
} from '../../../../server/coding-cli/codex-child-registry.js'
import {
  CODEX_LOG_DB_WAL_WARN_BYTES,
  countCodexLogDbHolders,
  emitCodexLogDbStatus,
  resolveCodexHome,
  runCodexReaperMaintenanceTick,
  startCodexObservability,
} from '../../../../server/coding-cli/codex-observability.js'

const tempDirs = new Set<string>()

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all([...tempDirs].map(async (dir) => {
    tempDirs.delete(dir)
    await fsp.rm(dir, { recursive: true, force: true })
  }))
})

async function makeTempDir(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-codex-obs-'))
  tempDirs.add(dir)
  return dir
}

function createLogSpy() {
  return { info: vi.fn(), warn: vi.fn() }
}

async function makeCodexHomeFixture(walBytes: number): Promise<{ codexHome: string; dbPath: string; walPath: string }> {
  const codexHome = await makeTempDir()
  const dbPath = path.join(codexHome, 'logs_2.sqlite')
  const walPath = `${dbPath}-wal`
  await fsp.writeFile(dbPath, 'not-a-real-db')
  await fsp.writeFile(walPath, Buffer.alloc(walBytes))
  return { codexHome, dbPath, walPath }
}

type ProcPidSpec = {
  fds: string[]
  /** Written to /proc/<pid>/cmdline; defaults to a codex-looking command line. */
  cmdline?: string | null
}

// Builds a fake /proc root: each key is a pid whose fd dir contains symlinks to the given targets
// and whose cmdline defaults to codex (the M3 prefilter only probes codex processes).
async function makeProcFixture(pids: Record<string, string[] | ProcPidSpec>): Promise<string> {
  const procRoot = await makeTempDir()
  for (const [pid, value] of Object.entries(pids)) {
    const spec: ProcPidSpec = Array.isArray(value) ? { fds: value } : value
    const pidDir = path.join(procRoot, pid)
    const fdDir = path.join(pidDir, 'fd')
    await fsp.mkdir(fdDir, { recursive: true })
    const cmdline = spec.cmdline === undefined ? '/usr/local/bin/codex\0app-server\0' : spec.cmdline
    if (cmdline !== null) {
      await fsp.writeFile(path.join(pidDir, 'cmdline'), cmdline)
    }
    for (const [index, target] of spec.fds.entries()) {
      await fsp.symlink(target, path.join(fdDir, String(index + 3)))
    }
  }
  await fsp.mkdir(path.join(procRoot, 'not-a-pid'), { recursive: true })
  return procRoot
}

function buildValidOwnershipRecord(overrides: Record<string, unknown> = {}) {
  const now = new Date().toISOString()
  return {
    schemaVersion: 1,
    ownershipId: 'obs-pending',
    serverInstanceId: 'srv-previous',
    ownerServerPid: 999_999_999,
    terminalId: null,
    generation: null,
    wsUrl: 'ws://127.0.0.1:1',
    wrapperPid: 999_999_998,
    processGroupId: 999_999_997,
    wrapperIdentity: { commandLine: ['codex'], cwd: '/tmp', startTimeTicks: 1 },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

describe('codex-observability resolveCodexHome', () => {
  it('resolves the codex home from CODEX_HOME or falls back to ~/.codex', () => {
    expect(resolveCodexHome({ CODEX_HOME: '/custom/home' } as NodeJS.ProcessEnv)).toBe('/custom/home')
    expect(resolveCodexHome({ CODEX_HOME: '  ' } as NodeJS.ProcessEnv)).toBe(path.join(os.homedir(), '.codex'))
    expect(resolveCodexHome({} as NodeJS.ProcessEnv)).toBe(path.join(os.homedir(), '.codex'))
  })

  it('keeps the 2 GiB WAL warn threshold (hours of margin before the ~5 GB cliff at ~22 MB/min churn)', () => {
    expect(CODEX_LOG_DB_WAL_WARN_BYTES).toBe(2 * 1024 * 1024 * 1024)
  })
})

const describeWithLinuxProc = process.platform === 'linux' ? describe : describe.skip

describeWithLinuxProc('codex-observability monitor', () => {
  it('emits the codex-log-db status line with WAL size, holder count and quarantine count', async () => {
    const { codexHome, dbPath, walPath } = await makeCodexHomeFixture(2048)
    const procRoot = await makeProcFixture({
      '101': ['/tmp/unrelated-file', dbPath],
      '102': [walPath],
      '103': ['/tmp/unrelated-file'],
    })
    const metadataDir = await makeTempDir()
    const quarantineDir = path.join(metadataDir, 'quarantine')
    await fsp.mkdir(quarantineDir, { recursive: true })
    await fsp.writeFile(path.join(quarantineDir, 'stale.json'), '{}')
    await fsp.writeFile(path.join(quarantineDir, 'stale.json.note.json'), '{}')

    const log = createLogSpy()
    const status = await emitCodexLogDbStatus({ codexHome, metadataDir, procRoot, log })

    expect(status).toEqual({ walBytes: 2048, walStatFailed: false, holders: 2, quarantined: 1, warned: false })
    expect(log.warn).not.toHaveBeenCalled()
    expect(log.info).toHaveBeenCalledTimes(1)
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ walBytes: 2048, walStatFailed: false, holders: 2, quarantined: 1 }),
      'codex-log-db: wal_bytes=2048 holders=2 quarantined=1',
    )
  })

  it('warns when wal_bytes exceeds the threshold', async () => {
    const { codexHome } = await makeCodexHomeFixture(4096)
    const log = createLogSpy()

    const status = await emitCodexLogDbStatus({
      codexHome,
      metadataDir: await makeTempDir(),
      procRoot: await makeProcFixture({}),
      log,
      walWarnBytes: 1024,
    })

    expect(status?.warned).toBe(true)
    expect(log.warn).toHaveBeenCalledTimes(1)
    expect(log.info).not.toHaveBeenCalled()
  })

  it('reports wal_bytes=-1 and walStatFailed when the WAL stat fails for a non-ENOENT reason (M5)', async () => {
    const { codexHome, walPath } = await makeCodexHomeFixture(1024)
    const originalStat = fsp.stat.bind(fsp)
    vi.spyOn(fsp, 'stat').mockImplementation(((target: any, opts?: any) => {
      if (String(target) === walPath) {
        return Promise.reject(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }))
      }
      return originalStat(target, opts) as any
    }) as typeof fsp.stat)
    const log = createLogSpy()

    const status = await emitCodexLogDbStatus({
      codexHome,
      metadataDir: await makeTempDir(),
      procRoot: await makeProcFixture({}),
      log,
    })

    expect(status).toEqual({ walBytes: -1, walStatFailed: true, holders: 0, quarantined: 0, warned: true })
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ walBytes: -1, walStatFailed: true }),
      expect.stringContaining('wal_bytes=-1'),
    )
  })

  it('reads a missing WAL as empty, not as a stat failure', async () => {
    const codexHome = await makeTempDir() // no db, no wal
    const log = createLogSpy()

    const status = await emitCodexLogDbStatus({
      codexHome,
      metadataDir: await makeTempDir(),
      procRoot: await makeProcFixture({}),
      log,
    })

    expect(status).toEqual({ walBytes: 0, walStatFailed: false, holders: 0, quarantined: 0, warned: false })
  })

  it('warns when the holder count exceeds the threshold', async () => {
    const { codexHome, dbPath } = await makeCodexHomeFixture(0)
    const procRoot = await makeProcFixture({
      '201': [dbPath],
      '202': [dbPath],
    })
    const log = createLogSpy()

    const status = await emitCodexLogDbStatus({
      codexHome,
      metadataDir: await makeTempDir(),
      procRoot,
      log,
      holderWarnThreshold: 1,
    })

    expect(status).toEqual({ walBytes: 0, walStatFailed: false, holders: 2, quarantined: 0, warned: true })
    expect(log.warn).toHaveBeenCalledTimes(1)
  })

  it('never throws when the codex home, metadata dir and proc root are all missing', async () => {
    const log = createLogSpy()

    const status = await emitCodexLogDbStatus({
      codexHome: '/nonexistent/codex-home',
      metadataDir: '/nonexistent/metadata',
      procRoot: '/nonexistent/proc',
      log,
    })

    expect(status).toEqual({ walBytes: 0, walStatFailed: false, holders: 0, quarantined: 0, warned: false })
  })

  it('holds no file descriptor on the sqlite files after probing (read-only monitor)', async () => {
    const { codexHome, dbPath } = await makeCodexHomeFixture(1024)
    const log = createLogSpy()

    await emitCodexLogDbStatus({
      codexHome,
      metadataDir: await makeTempDir(),
      procRoot: await makeProcFixture({ '301': [dbPath] }),
      log,
    })

    const fds = await fsp.readdir('/proc/self/fd')
    const targets = await Promise.all(fds.map((fd) => fsp.readlink(`/proc/self/fd/${fd}`).catch(() => '')))
    expect(targets.filter((target) => target.startsWith(dbPath))).toEqual([])
  })

  it('ignores unreadable fd directories in the holder scan', async () => {
    const { dbPath } = await makeCodexHomeFixture(0)
    const procRoot = await makeProcFixture({ '401': [dbPath] })
    // A codex pid dir without an fd subdirectory (readdir will fail for it).
    await fsp.mkdir(path.join(procRoot, '402'), { recursive: true })
    await fsp.writeFile(path.join(procRoot, '402', 'cmdline'), 'codex\0')

    expect(await countCodexLogDbHolders(dbPath, procRoot)).toBe(1)
  })

  it('prefilters non-codex processes: only codex cmdlines are probed as holders (M3)', async () => {
    const { dbPath } = await makeCodexHomeFixture(0)
    const procRoot = await makeProcFixture({
      '501': { fds: [dbPath] }, // codex, holds the db -> counted
      '502': { fds: [dbPath], cmdline: '/usr/bin/some-other-daemon\0' }, // non-codex holder -> skipped
      '503': { fds: [dbPath], cmdline: null }, // unreadable cmdline -> skipped
      // r2-2: 'codex' as a mere path substring is NOT a codex process -> skipped
      '504': { fds: [dbPath], cmdline: '/usr/bin/vim\0/home/dan/code/codex-launch-leak-plan/notes.md\0' },
      // r2-2: node-wrapper launch (argv token basename 'codex') -> counted
      '505': { fds: [dbPath], cmdline: 'node\0/opt/tools/bin/codex\0app-server\0' },
    })

    expect(await countCodexLogDbHolders(dbPath, procRoot)).toBe(2)
  })

  it('skips the server process itself in the holder scan (M3)', async () => {
    const { dbPath } = await makeCodexHomeFixture(0)
    const procRoot = await makeProcFixture({
      [String(process.pid)]: [dbPath],
      '601': [dbPath],
    })

    expect(await countCodexLogDbHolders(dbPath, procRoot)).toBe(1)
  })

  it("matches fd targets that carry the ' (deleted)' suffix (M3)", async () => {
    const { dbPath } = await makeCodexHomeFixture(0)
    const procRoot = await makeProcFixture({
      '701': [`${dbPath} (deleted)`],
      '702': [`${dbPath}-wal (deleted)`],
      '703': ['/tmp/unrelated (deleted)'],
    })

    expect(await countCodexLogDbHolders(dbPath, procRoot)).toBe(2)
  })
})

describeWithLinuxProc('codex-observability reaper maintenance tick', () => {
  it('re-runs the reaper only when a pending record is due under the time-based backoff', async () => {
    const metadataDir = await makeTempDir()
    const recordPath = path.join(metadataDir, 'pending.json')
    await fsp.writeFile(recordPath, JSON.stringify(buildValidOwnershipRecord()), { mode: 0o600 })

    // Not due: the last attempt just happened (interval for a young record is one hour).
    const now = Date.now()
    await fsp.writeFile(`${recordPath}.reaper.json`, JSON.stringify({
      firstSeen: new Date(now - 60_000).toISOString(),
      attempts: 1,
      lastAttempt: new Date(now).toISOString(),
    }), { mode: 0o600 })
    await runCodexReaperMaintenanceTick({ serverInstanceId: 'srv-tick', metadataDir, terminateGraceMs: 1 })
    await expect(fsp.stat(recordPath)).resolves.toBeDefined()

    // Due: the last attempt was two hours ago. The record's owner is dead and its group is gone,
    // so the re-run reaps it exactly like the boot pass would.
    await fsp.writeFile(`${recordPath}.reaper.json`, JSON.stringify({
      firstSeen: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
      attempts: 1,
      lastAttempt: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
    }), { mode: 0o600 })
    await runCodexReaperMaintenanceTick({ serverInstanceId: 'srv-tick', metadataDir, terminateGraceMs: 1 })
    await expect(fsp.stat(recordPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('gates re-attempts per record: a not-yet-due record is untouched even when another is due (m2)', async () => {
    const metadataDir = await makeTempDir()
    const now = Date.now()

    // Due record: owner dead, group gone -> gets reaped by the tick.
    const duePath = path.join(metadataDir, 'due.json')
    await fsp.writeFile(duePath, JSON.stringify(buildValidOwnershipRecord({ ownershipId: 'obs-due' })), { mode: 0o600 })
    await fsp.writeFile(`${duePath}.reaper.json`, JSON.stringify({
      firstSeen: new Date(now - 3 * 60 * 60 * 1000).toISOString(),
      attempts: 2,
      lastAttempt: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
    }), { mode: 0o600 })

    // Fresh record: attempted seconds ago -> must be skipped entirely (no attempt increment).
    const freshPath = path.join(metadataDir, 'fresh.json')
    await fsp.writeFile(freshPath, JSON.stringify(buildValidOwnershipRecord({ ownershipId: 'obs-fresh' })), { mode: 0o600 })
    const freshState = {
      firstSeen: new Date(now - 60_000).toISOString(),
      attempts: 1,
      lastAttempt: new Date(now).toISOString(),
    }
    await fsp.writeFile(`${freshPath}.reaper.json`, JSON.stringify(freshState), { mode: 0o600 })

    await runCodexReaperMaintenanceTick({ serverInstanceId: 'srv-tick', metadataDir, terminateGraceMs: 1 })

    await expect(fsp.stat(duePath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fsp.stat(freshPath)).resolves.toBeDefined()
    const stateAfter = JSON.parse(await fsp.readFile(`${freshPath}.reaper.json`, 'utf8'))
    expect(stateAfter.attempts).toBe(1)
    expect(stateAfter.lastAttempt).toBe(freshState.lastAttempt)
  })

  it('detects a sidecar-less orphan record and reaps it on the tick (r2-6)', async () => {
    const metadataDir = await makeTempDir()
    // Orphaned AFTER boot: no .reaper.json sidecar exists, owner pid is dead, group is gone.
    const orphanPath = path.join(metadataDir, 'orphan.json')
    await fsp.writeFile(orphanPath, JSON.stringify(buildValidOwnershipRecord({ ownershipId: 'obs-orphan' })), { mode: 0o600 })
    // Control: a sidecar-less record whose owner is provably ALIVE must not be touched.
    const livePath = path.join(metadataDir, 'live-owner.json')
    await fsp.writeFile(livePath, JSON.stringify(buildValidOwnershipRecord({
      ownershipId: 'obs-live-owner',
      ownerServerPid: process.pid,
    })), { mode: 0o600 })

    await runCodexReaperMaintenanceTick({ serverInstanceId: 'srv-tick', metadataDir, terminateGraceMs: 1 })

    await expect(fsp.stat(orphanPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fsp.stat(livePath)).resolves.toBeDefined()
  })

  it('drains stale resume-pty registry entries on the tick (r2-11)', async () => {
    // A REAL exited detached child: its group is confirmed gone (ESRCH), so the tick must drain it.
    const deadChild = spawn(process.execPath, ['-e', ''], { detached: true, stdio: 'ignore' })
    const deadPid = deadChild.pid!
    await new Promise<void>((resolve) => deadChild.once('exit', () => resolve()))
    // A REAL live detached group leader: the probe reports alive, so the entry must be kept.
    const liveChild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { detached: true, stdio: 'ignore' })
    liveChild.unref()
    const livePid = liveChild.pid!
    registerCodexChild({ pid: deadPid, pgid: deadPid, kind: 'resume-pty' })
    registerCodexChild({ pid: livePid, pgid: livePid, kind: 'resume-pty' })
    try {
      await runCodexReaperMaintenanceTick({ serverInstanceId: 'srv-tick', metadataDir: await makeTempDir(), terminateGraceMs: 1 })

      const pids = snapshotCodexChildren().map((child) => child.pid)
      expect(pids).not.toContain(deadPid)
      expect(pids).toContain(livePid)
    } finally {
      deregisterCodexChild(deadPid)
      deregisterCodexChild(livePid)
      try {
        process.kill(-livePid, 'SIGKILL')
      } catch {
        // already gone
      }
    }
  })

  it('never throws when the metadata dir is missing', async () => {
    await expect(runCodexReaperMaintenanceTick({
      serverInstanceId: 'srv-tick',
      metadataDir: '/nonexistent/metadata',
      log: createLogSpy(),
    })).resolves.toBeUndefined()
  })
})

describeWithLinuxProc('codex-observability lifecycle', () => {
  it('emits a boot status line, ticks on the interval, and stop() clears the timer', async () => {
    const { codexHome } = await makeCodexHomeFixture(0)
    const metadataDir = await makeTempDir()
    const log = createLogSpy()

    const handle = startCodexObservability({
      serverInstanceId: 'srv-obs',
      codexHome,
      metadataDir,
      procRoot: await makeProcFixture({}),
      intervalMs: 20,
      log,
    })

    const deadline = Date.now() + 5_000
    while (log.info.mock.calls.length < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(log.info.mock.calls.length).toBeGreaterThanOrEqual(2)

    handle.stop()
    await new Promise((resolve) => setTimeout(resolve, 50))
    const callsAfterStop = log.info.mock.calls.length
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(log.info.mock.calls.length).toBe(callsAfterStop)
  })
})
