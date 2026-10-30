// @vitest-environment node
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ManagedExternalBrowserLifecycle, OwnedRuntimeChild } from '../../../scripts/testing/runtime-external-browser.js'

// These tests send real signals. Never permit them in the host PID namespace.
beforeAll(() => {
  if (!fs.existsSync('/.dockerenv')) throw new Error('run owned-runtime-child tests through scripts/sandbox-test.sh')
})

const directories: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const directory of directories.splice(0)) await fsp.rm(directory, { recursive: true, force: true })
})

async function launcher(exitEarly: boolean, options: { detachedChild?: boolean; childSource?: string } = {}): Promise<{
  owned: OwnedRuntimeChild; childPid: number; directory: string
}> {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'owned-runtime-child-'))
  directories.push(directory)
  const marker = path.join(directory, 'child.pid')
  const ready = path.join(directory, 'child.ready')
  const entry = path.join(directory, 'launcher.cjs')
  const childSource = `${options.childSource ?? 'setInterval(() => {}, 1000);'}
    require('node:fs').writeFileSync(${JSON.stringify(ready)}, 'ready');`
  await fsp.writeFile(entry, `
    const fs = require('node:fs');
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', ${JSON.stringify(childSource)}],
      { stdio: 'ignore', detached: ${Boolean(options.detachedChild)} });
    child.unref();
    const readyPoll = setInterval(() => {
      if (!fs.existsSync(${JSON.stringify(ready)})) return;
      clearInterval(readyPoll);
      fs.writeFileSync(${JSON.stringify(marker)}, String(child.pid));
      console.log('launcher diagnostic retained');
      console.error('launcher stderr retained');
      ${exitEarly ? 'process.exit(23);' : 'setInterval(() => {}, 1000);'}
    }, 10);
  `)
  const owned = await OwnedRuntimeChild.create(process.execPath, [entry], directory, process.env)
  await expect.poll(() => fs.existsSync(marker)).toBe(true)
  return { owned, childPid: Number(await fsp.readFile(marker, 'utf8')), directory }
}

async function absent(...pids: number[]): Promise<void> {
  await expect.poll(() => pids.every(pid => !fs.existsSync(`/proc/${pid}`)), { timeout: 3000 }).toBe(true)
}

describe('owned launch cleanup (Docker only)', () => {
  it('stops a surviving child after the actual launcher has exited, retaining diagnostics', async () => {
    const { owned, childPid } = await launcher(true)
    try {
      expect(await owned.wait()).toBe(23)
      expect(fs.existsSync(`/proc/${owned.identity.pid}`)).toBe(false)
      expect(fs.existsSync(`/proc/${childPid}`)).toBe(true)
      await owned.stop()
      await absent(childPid)
      expect(owned.output()).toEqual({ stdout: 'launcher diagnostic retained\n', stderr: 'launcher stderr retained\n' })
      await owned.stop()
    } finally {
      // Exact fixture PID only; container --init reaps the orphan on failure.
      try { process.kill(childPid, 'SIGKILL') } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
    }
  })

  it('stops a live launcher and its child without touching another launch', async () => {
    const first = await launcher(false)
    const other = await launcher(false)
    try {
      await first.owned.stop()
      await absent(first.owned.identity.pid, first.childPid)
      expect(other.owned.alive()).toBe(true)
      expect(fs.existsSync(`/proc/${other.childPid}`)).toBe(true)
    } finally {
      await first.owned.stop()
      await other.owned.stop()
    }
  })

  it.each([false, true])('retains cleanup authority across interrupted cleanup (detached child: %s)', async (detachedChild) => {
    const { owned, childPid } = await launcher(false, { detachedChild })
    const kill = process.kill.bind(process)
    const failure = new Error('fixture signal interrupted')
    const signal = vi.spyOn(process, 'kill').mockImplementation((pid, value) => {
      if (pid === childPid || pid === -owned.identity.pid) throw failure
      return kill(pid, value)
    })
    try {
      await expect(owned.stop()).rejects.toBe(failure)
      expect(owned.alive()).toBe(false)
      expect(fs.existsSync(`/proc/${childPid}`)).toBe(true)
      signal.mockRestore()
      await owned.stop()
      await absent(childPid)
    } finally {
      signal.mockRestore()
      await owned.stop()
    }
  })

  it('refuses a replaced launcher PID before signalling any process', async () => {
    const { owned, childPid } = await launcher(false)
    const read = fs.readFileSync
    const statPath = `/proc/${owned.identity.pid}/stat`
    const readSpy = vi.spyOn(fs, 'readFileSync').mockImplementation((...args) => {
      const value = Reflect.apply(read, fs, args) as ReturnType<typeof fs.readFileSync>
      if (args[0] !== statPath || typeof value !== 'string') return value
      const offset = value.lastIndexOf(')') + 2
      const fields = value.slice(offset).split(' ')
      fields[19] = String(BigInt(fields[19]) + 1n)
      return value.slice(0, offset) + fields.join(' ')
    })
    const signal = vi.spyOn(process, 'kill')
    try {
      await expect(owned.stop()).rejects.toThrow('owned process identity was replaced')
      expect(signal).not.toHaveBeenCalled()
      expect(owned.alive()).toBe(true)
      expect(fs.existsSync(`/proc/${childPid}`)).toBe(true)
    } finally {
      readSpy.mockRestore()
      signal.mockRestore()
      await owned.stop()
    }
  })

  it('retains the same detached child across a working-directory change between retries', async () => {
    const { owned, childPid, directory } = await launcher(false, { detachedChild: true,
      childSource: `
        const flag = require('node:path').join(process.cwd(), 'change-cwd');
        setInterval(() => { if (require('node:fs').existsSync(flag)) process.chdir('/'); }, 10);
      `,
    })
    const kill = process.kill.bind(process)
    const failure = new Error('fixture signal interrupted before directory change')
    const signal = vi.spyOn(process, 'kill').mockImplementation((pid, value) => {
      if (pid === childPid) throw failure
      return kill(pid, value)
    })
    try {
      await expect(owned.stop()).rejects.toBe(failure)
      signal.mockRestore()
      await fsp.writeFile(path.join(directory, 'change-cwd'), 'ready')
      await expect.poll(() => fs.readlinkSync(`/proc/${childPid}/cwd`)).toBe('/')
      await owned.stop()
      await absent(childPid)
    } finally {
      signal.mockRestore()
      try { process.kill(childPid, 'SIGKILL') } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
    }
  })

  it('refuses an unrelated reused group and keeps cleanup retryable', async () => {
    const { owned, childPid } = await launcher(true)
    await owned.wait()
    const read = fs.readFileSync
    const readSpy = vi.spyOn(fs, 'readFileSync').mockImplementation((...args) => {
      if (args[0] === `/proc/${childPid}/environ`) return 'UNRELATED_LAUNCH=1\0'
      return Reflect.apply(read, fs, args)
    })
    const signal = vi.spyOn(process, 'kill')
    try {
      await expect(owned.stop()).rejects.toThrow('owned process group identity was replaced')
      expect(signal).not.toHaveBeenCalled()
      expect(fs.existsSync(`/proc/${childPid}`)).toBe(true)
    } finally {
      readSpy.mockRestore()
      signal.mockRestore()
      await owned.stop()
      await absent(childPid)
    }
  })

  it('reports failed absence verification, then retries the same scope successfully', async () => {
    const { owned, childPid } = await launcher(true)
    await owned.wait()
    const signal = vi.spyOn(process, 'kill').mockReturnValue(true)
    vi.useFakeTimers()
    try {
      const failure = expect(owned.stop()).rejects.toThrow('owned process cleanup could not verify absence')
      await vi.runAllTimersAsync()
      await failure
      expect(signal).toHaveBeenCalledWith(childPid, 'SIGKILL')
      expect(fs.existsSync(`/proc/${childPid}`)).toBe(true)
    } finally {
      vi.useRealTimers()
      signal.mockRestore()
      await owned.stop()
      await absent(childPid)
    }
  })

  it('escalates an uncooperative orphan to SIGKILL', async () => {
    const { owned, childPid } = await launcher(true, {
      childSource: "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);",
    })
    await owned.wait()
    const signal = vi.spyOn(process, 'kill')
    try {
      await owned.stop()
      expect(signal).toHaveBeenCalledWith(childPid, 'SIGTERM')
      expect(signal).toHaveBeenCalledWith(childPid, 'SIGKILL')
      await absent(childPid)
    } finally {
      signal.mockRestore()
      await owned.stop()
    }
  })

  it('finds a new group member created while an orphan is terminating', async () => {
    const { owned, childPid, directory } = await launcher(true, {
      childSource: `
        process.on('SIGTERM', () => {
          const child = require('node:child_process').spawn(process.execPath,
            ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
          require('node:fs').writeFileSync('late.pid', String(child.pid));
          child.unref();
          process.exit(0);
        });
        setInterval(() => {}, 1000);
      `,
    })
    await owned.wait()
    try {
      await owned.stop()
      const latePid = Number(await fsp.readFile(path.join(directory, 'late.pid'), 'utf8'))
      await absent(childPid, latePid)
    } finally {
      await owned.stop()
    }
  })

  it.each(['next scan', 'retry'] as const)('does not retire a group after a fork/exit between enumeration and stat (%s)', async recovery => {
    const { owned, childPid } = await launcher(true)
    await owned.wait()
    const childStat = fs.readFileSync(`/proc/${childPid}/stat`, 'utf8')
    const childEnvironment = fs.readFileSync(`/proc/${childPid}/environ`, 'utf8')
    const executable = fs.readlinkSync(`/proc/${childPid}/exe`)
    const cwd = fs.readlinkSync(`/proc/${childPid}/cwd`)
    process.kill(childPid, 'SIGTERM')
    await absent(childPid)

    // Simulate the exact scan interleaving; all signals below are intercepted.
    const latePid = childPid + 1_000_000
    let scans = 0
    let orphanPresent = true
    let latePresent = false
    let revealLate = recovery === 'next scan'
    const missing = () => Object.assign(new Error('fixture process absent'), { code: 'ENOENT' })
    const readdir = fs.readdirSync
    const readdirSpy = vi.spyOn(fs, 'readdirSync').mockImplementation((...args) => {
      if (args[0] !== '/proc') return Reflect.apply(readdir, fs, args)
      scans += 1
      if (scans === 1) return [String(childPid)] as never
      if (scans === 2) {
        // The listed orphan forks and exits before its stat is read. The new
        // child belongs to the group but was not in this directory snapshot.
        orphanPresent = false
        latePresent = true
        return [String(childPid)] as never
      }
      return (revealLate && latePresent ? [String(latePid)] : []) as never
    })
    const read = fs.readFileSync
    const readSpy = vi.spyOn(fs, 'readFileSync').mockImplementation((...args) => {
      if (args[0] === `/proc/${childPid}/stat`) {
        if (!orphanPresent) throw missing()
        return childStat
      }
      if (args[0] === `/proc/${latePid}/stat`) {
        if (!latePresent) throw missing()
        return childStat.replace(/^\d+/, String(latePid))
      }
      if (args[0] === `/proc/${childPid}/environ` || args[0] === `/proc/${latePid}/environ`) return childEnvironment
      return Reflect.apply(read, fs, args)
    })
    const readlink = fs.readlinkSync
    const readlinkSpy = vi.spyOn(fs, 'readlinkSync').mockImplementation((...args) => {
      if ([`/proc/${childPid}/exe`, `/proc/${latePid}/exe`].includes(String(args[0]))) return executable
      if ([`/proc/${childPid}/cwd`, `/proc/${latePid}/cwd`].includes(String(args[0]))) return cwd
      return Reflect.apply(readlink, fs, args)
    })
    const signal = vi.spyOn(process, 'kill').mockImplementation((pid, value) => {
      if (pid === -owned.identity.pid && value === 0) {
        if (!latePresent) throw Object.assign(new Error('fixture group absent'), { code: 'ESRCH' })
        return true
      }
      if (pid !== latePid || value !== 'SIGTERM') throw new Error('unchecked fixture termination signal')
      latePresent = false
      return true
    })
    vi.useFakeTimers()
    try {
      if (recovery === 'retry') {
        const result = owned.stop().then(() => undefined, (error: unknown) => error)
        await vi.runAllTimersAsync()
        expect(await result).toEqual(new Error('owned process cleanup could not verify absence'))
        expect(latePresent).toBe(true)
        revealLate = true
      }
      const cleanup = owned.stop()
      await vi.runAllTimersAsync()
      await cleanup
      expect(latePresent).toBe(false)
      expect(signal).toHaveBeenCalledWith(latePid, 'SIGTERM')
      expect(signal).toHaveBeenCalledWith(-owned.identity.pid, 0)
    } finally {
      vi.useRealTimers()
      readdirSpy.mockRestore()
      readSpy.mockRestore()
      readlinkSpy.mockRestore()
      signal.mockRestore()
      await owned.stop()
    }
  })

  it.each(['EPERM', 'EIO', undefined])('keeps absence-probe failure retryable (%s)', async code => {
    const { owned, childPid } = await launcher(true)
    await owned.wait()
    // An empty directory snapshot cannot overrule a failed kernel probe.
    const readdirSpy = vi.spyOn(fs, 'readdirSync').mockReturnValue([])
    const failure = Object.assign(new Error('fixture group probe failed'), { code })
    const kill = process.kill.bind(process)
    const signal = vi.spyOn(process, 'kill').mockImplementation((pid, value) => {
      if (pid === -owned.identity.pid) {
        if (value !== 0) throw new Error('unchecked group termination signal')
        throw failure
      }
      return kill(pid, value)
    })
    try {
      await expect(owned.stop()).rejects.toBe(failure)
      expect(fs.existsSync(`/proc/${childPid}`)).toBe(true)
      readdirSpy.mockRestore()
      signal.mockRestore()
      await owned.stop()
      await absent(childPid)
    } finally {
      readdirSpy.mockRestore()
      signal.mockRestore()
      // Also clean the fixture when the regression falsely retired its scope.
      try { process.kill(childPid, 'SIGKILL') } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
      await absent(childPid)
    }
  })

  it('does not reclaim a numeric scope after a completed stop', async () => {
    const { owned, childPid } = await launcher(true)
    await owned.wait()
    const childStat = fs.readFileSync(`/proc/${childPid}/stat`, 'utf8')
    await owned.stop()
    const read = fs.readFileSync
    const readSpy = vi.spyOn(fs, 'readFileSync').mockImplementation((...args) => {
      if (args[0] === `/proc/${owned.identity.pid}/stat`) return childStat
      return Reflect.apply(read, fs, args)
    })
    const signal = vi.spyOn(process, 'kill')
    try {
      await expect(owned.stop()).resolves.toBeUndefined()
      expect(owned.descendants()).toEqual([])
      expect(signal).not.toHaveBeenCalled()
    } finally {
      readSpy.mockRestore()
      signal.mockRestore()
    }
  })

  it('keeps the production cleanup result failed until the orphan is actually stopped', async () => {
    const { owned, childPid } = await launcher(true)
    await owned.wait()
    const lifecycle = new ManagedExternalBrowserLifecycle()
    Reflect.set(lifecycle, 'cloud', owned)
    const kill = process.kill.bind(process)
    const signal = vi.spyOn(process, 'kill').mockImplementation((pid, value) => {
      if (pid === childPid) throw Object.assign(new Error('fixture signal denied'), { code: 'EPERM' })
      return kill(pid, value)
    })
    try {
      await expect(lifecycle.finish()).resolves.toEqual({ ok: false, errors: ['cloud child cleanup failed'] })
      expect(fs.existsSync(`/proc/${childPid}`)).toBe(true)
      signal.mockRestore()
      await expect(lifecycle.finish()).resolves.toEqual({ ok: true, errors: [] })
      await absent(childPid)
    } finally {
      signal.mockRestore()
      await owned.stop()
    }
  })

  it('waits for the process group to disappear even when its last member is an unreaped zombie', async () => {
    const { owned, childPid } = await launcher(true)
    await owned.wait()
    const childStat = fs.readFileSync(`/proc/${childPid}/stat`, 'utf8')
    process.kill(childPid, 'SIGTERM')
    await absent(childPid)
    // Reuse an enumerated /proc entry for synthetic facts; never signal it.
    const zombiePid = process.pid
    const offset = childStat.lastIndexOf(')') + 2
    const fields = childStat.slice(offset).split(' ')
    fields[0] = 'Z'
    const zombieStat = `${zombiePid} (fixture zombie) ${fields.join(' ')}`
    const read = fs.readFileSync
    const readlink = fs.readlinkSync
    const readSpy = vi.spyOn(fs, 'readFileSync').mockImplementation((...args) => {
      if (args[0] === `/proc/${zombiePid}/stat`) return zombieStat
      return Reflect.apply(read, fs, args)
    })
    const readlinkSpy = vi.spyOn(fs, 'readlinkSync').mockImplementation((...args) => {
      if (args[0] === `/proc/${zombiePid}/exe`) throw Object.assign(new Error('fixture zombie has no executable'), { code: 'ENOENT' })
      return Reflect.apply(readlink, fs, args)
    })
    const signal = vi.spyOn(process, 'kill')
    vi.useFakeTimers()
    try {
      const failure = expect(owned.stop()).rejects.toThrow('owned process cleanup could not verify absence')
      await vi.runAllTimersAsync()
      await failure
      expect(signal).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
      readSpy.mockRestore()
      readlinkSpy.mockRestore()
      signal.mockRestore()
      await owned.stop()
    }
  })
})
