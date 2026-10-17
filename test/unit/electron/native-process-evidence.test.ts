import fs from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  captureNativeWindowEvidence,
  readLinuxNativeProcess,
  type NativeWindowIdentity,
  type ProcessReader,
} from '../../e2e-electron/native-process-evidence.js'

const native: NativeWindowIdentity = {
  id: 1, mainPid: 101, webContentsId: 2, rendererPid: 102,
  sandbox: true, contextIsolation: true, nodeIntegration: false,
}

const rendererExecutables = ['readable', 'permission-denied'] as const

function procFixture(rendererExecutable: typeof rendererExecutables[number] = 'readable') {
  const files = new Map<string, string>()
  const denied = Object.assign(new Error('readlink permission denied: must-not-appear'), { code: 'EACCES', errno: -13 })
  for (const pid of [100, 101, 102]) {
    const fields = ['S', '100', '100', '100', ...Array<string>(15).fill('0'), String(pid * 10)]
    files.set(`/proc/${pid}/stat`, `${pid} (native (test) process) ${fields.join(' ')}\n`)
    files.set(`/proc/${pid}/status`, [
      `Pid:\t${pid}`, 'Uid:\t1000\t1000\t1000\t1000', 'Gid:\t1000\t1000\t1000\t1000',
      'NoNewPrivs:\t1', 'CapEff:\t0000000000000000', 'Seccomp:\t2',
    ].join('\n'))
    files.set(`/proc/${pid}/cgroup`, '0::/system.slice/owned-native.service\n')
    files.set(`/proc/${pid}/cmdline`, `electron\0${pid === 102 ? '--type=renderer\0' : ''}--private-argument=must-not-appear\0`)
    files.set(`/proc/${pid}/exe`, '/public/electron')
  }
  const reader: ProcessReader = {
    text: vi.fn(path => {
      const value = files.get(path)
      if (value === undefined) throw Object.assign(new Error('missing owned file'), { code: 'ENOENT' })
      return value
    }),
    link: vi.fn(path => {
      if (rendererExecutable === 'permission-denied' && path === '/proc/102/exe') throw denied
      const value = files.get(path)
      if (value === undefined) throw Object.assign(new Error('missing owned file'), { code: 'ENOENT' })
      return value
    }),
  }
  return { files, reader, denied }
}

describe('exact native process evidence', () => {
  it('reads the exact live process on Linux without retaining its arguments', () => {
    if (process.platform !== 'linux') {
      expect(fs.existsSync('/proc/self/stat')).toBe(false)
      return
    }
    const evidence = readLinuxNativeProcess(process.pid)
    expect(evidence.pid).toBe(process.pid)
    expect(evidence.startTicks).toMatch(/^\d+$/)
    expect(evidence.uid).toEqual([process.getuid!(), process.geteuid!(), process.geteuid!(), process.geteuid!()])
    expect(evidence.cgroup).toBe(fs.readFileSync('/proc/self/cgroup', 'utf8').trim())
    expect(evidence.executable).toBe(fs.readlinkSync('/proc/self/exe'))
    expect(evidence).not.toHaveProperty('argv')
  })

  it('joins a secure native window to stable main, renderer and runner kernel facts', async () => {
    const { reader } = procFixture()
    const evidence = await captureNativeWindowEvidence(async () => ({ ...native }), 101, {
      platform: 'linux', runnerPid: 100, reader,
    })
    expect(evidence).toMatchObject({
      platform: 'linux', native,
      linux: {
        runner: { pid: 100, startTicks: '1000' },
        main: { pid: 101, startTicks: '1010', processType: 'main' },
        renderer: { pid: 102, startTicks: '1020', processType: 'renderer',
          noNewPrivs: 1, capEff: '0000000000000000', seccomp: 2 },
      },
    })
    expect(JSON.stringify(evidence)).not.toContain('must-not-appear')
    expect((reader.text as ReturnType<typeof vi.fn>).mock.calls.every(([file]) => /^\/proc\/(100|101|102)\//.test(file))).toBe(true)
  })

  it('keeps complete secure evidence when only the renderer executable is permission denied', async () => {
    const { reader } = procFixture('permission-denied')
    const snapshot = vi.fn(async () => ({ ...native }))
    const evidence = await captureNativeWindowEvidence(snapshot, 101, {
      platform: 'linux', runnerPid: 100, reader,
    })
    expect(evidence).toMatchObject({
      platform: 'linux', native,
      linux: {
        runner: { pid: 100, executable: '/public/electron', startTicks: '1000' },
        main: { pid: 101, executable: '/public/electron', startTicks: '1010', processType: 'main' },
        renderer: {
          pid: 102, executable: null,
          executableUnavailable: { reason: 'permission-denied', code: 'EACCES', errno: -13 },
          startTicks: '1020', parentPid: 100, processType: 'renderer',
          uid: [1000, 1000, 1000, 1000], gid: [1000, 1000, 1000, 1000],
          cgroup: '0::/system.slice/owned-native.service', disablingSwitches: [],
          noNewPrivs: 1, capEff: '0000000000000000', seccomp: 2,
        },
      },
    })
    expect(snapshot).toHaveBeenCalledTimes(2)
    expect((reader.text as ReturnType<typeof vi.fn>).mock.calls.filter(([file]) => file === '/proc/102/stat'))
      .toHaveLength(2)
    expect((reader.text as ReturnType<typeof vi.fn>).mock.calls.every(([file]) => /^\/proc\/(100|101|102)\//.test(file))).toBe(true)
    expect(JSON.stringify(evidence)).not.toContain('must-not-appear')
  })

  it('records only the supplied permission-denied metadata when errno is absent', async () => {
    const { reader } = procFixture()
    const link = reader.link
    reader.link = path => {
      if (path === '/proc/102/exe') throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
      return link(path)
    }
    const evidence = await captureNativeWindowEvidence(async () => native, 101, {
      platform: 'linux', runnerPid: 100, reader,
    })
    expect(evidence.linux!.renderer).toMatchObject({ executable: null })
    expect(evidence.linux!.renderer).toHaveProperty('executableUnavailable', {
      reason: 'permission-denied', code: 'EACCES',
    })
  })

  it('keeps the public process reader strict even for a renderer executable denial', () => {
    const { reader, denied } = procFixture('permission-denied')
    expect(() => readLinuxNativeProcess(102, reader)).toThrow(denied)
  })

  it.each(['ENOENT', 'ESRCH', 'EIO', 'EPERM', undefined])('rejects unexpected renderer executable error %s', async code => {
    const { reader } = procFixture()
    const link = reader.link
    const error = Object.assign(new Error('unexpected executable error'), code ? { code } : {})
    reader.link = path => {
      if (path === '/proc/102/exe') throw error
      return link(path)
    }
    await expect(captureNativeWindowEvidence(async () => native, 101, {
      platform: 'linux', runnerPid: 100, reader,
    })).rejects.toBe(error)
  })

  it.each(['EACCES', { code: 'EACCES', errno: -13 }, null])('rejects an untyped renderer executable error %j', async error => {
    const { reader } = procFixture()
    const link = reader.link
    reader.link = path => {
      if (path === '/proc/102/exe') throw error
      return link(path)
    }
    await expect(captureNativeWindowEvidence(async () => native, 101, {
      platform: 'linux', runnerPid: 100, reader,
    })).rejects.toBe(error)
  })

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid process PID %s before reading', pid => {
    const { reader } = procFixture()
    expect(() => readLinuxNativeProcess(pid, reader)).toThrow(/invalid PID/)
    expect(reader.text).not.toHaveBeenCalled()
    expect(reader.link).not.toHaveBeenCalled()
  })

  it('rejects a changed kernel process identity during capture', () => {
    const { reader } = procFixture()
    const read = reader.text
    let statReads = 0
    reader.text = path => {
      const value = read(path)
      return path === '/proc/102/stat' && ++statReads > 1 ? value.replace(/1020\n$/, '9999\n') : value
    }
    expect(() => readLinuxNativeProcess(102, reader)).toThrow(/identity changed/)
  })

  it('refuses a main process other than the launch-owned child', async () => {
    await expect(captureNativeWindowEvidence(async () => native, 999, { platform: 'win32' }))
      .rejects.toThrow(/launch-owned main/)
  })

  it.each([
    { sandbox: false }, { contextIsolation: false }, { nodeIntegration: true },
  ])('refuses unsafe native preferences %j on every platform', async preferences => {
    await expect(captureNativeWindowEvidence(async () => ({ ...native, ...preferences }), 101, { platform: 'win32' }))
      .rejects.toThrow(/unsafe native preferences/)
  })

  describe.each(rendererExecutables)('capture with renderer executable %s', rendererExecutable => {
    it.each([100, 101])('rejects executable permission denial for required PID %s', async pid => {
      const { reader, denied } = procFixture(rendererExecutable)
      const link = reader.link
      reader.link = path => {
        if (path === `/proc/${pid}/exe`) throw denied
        return link(path)
      }
      await expect(captureNativeWindowEvidence(async () => native, 101, {
        platform: 'linux', runnerPid: 100, reader,
      })).rejects.toBe(denied)
    })

    it.each([100, 101, 102])('rejects changed kernel process identity for PID %s', async pid => {
      const { reader } = procFixture(rendererExecutable)
      const read = reader.text
      let statReads = 0
      reader.text = path => {
        const value = read(path)
        return path === `/proc/${pid}/stat` && ++statReads > 1
          ? value.replace(new RegExp(`${pid * 10}\\n$`), '9999\n') : value
      }
      await expect(captureNativeWindowEvidence(async () => native, 101, {
        platform: 'linux', runnerPid: 100, reader,
      })).rejects.toThrow(/identity changed/)
    })

    it.each([
      { id: 3 }, { mainPid: 103 }, { webContentsId: 3 }, { rendererPid: 103 },
      { sandbox: false }, { contextIsolation: false }, { nodeIntegration: true },
    ])('rejects native mapping changes %j after the required reads', async changed => {
      const { reader } = procFixture(rendererExecutable)
      const snapshot = vi.fn().mockResolvedValueOnce(native).mockResolvedValueOnce({ ...native, ...changed })
      await expect(captureNativeWindowEvidence(snapshot, 101, {
        platform: 'linux', runnerPid: 100, reader,
      })).rejects.toThrow(/native mapping changed/)
      expect(snapshot).toHaveBeenCalledTimes(2)
    })

    it.each(['stat', 'status', 'cmdline', 'cgroup'])('rejects permission denial for required renderer %s', async field => {
      const { reader, denied } = procFixture(rendererExecutable)
      const read = reader.text
      reader.text = path => {
        if (path === `/proc/102/${field}`) throw denied
        return read(path)
      }
      await expect(captureNativeWindowEvidence(async () => native, 101, {
        platform: 'linux', runnerPid: 100, reader,
      })).rejects.toBe(denied)
    })

    it('rejects a renderer that disappears before the final identity read', async () => {
      const { reader } = procFixture(rendererExecutable)
      const read = reader.text
      const error = Object.assign(new Error('renderer disappeared'), { code: 'ENOENT' })
      let statReads = 0
      reader.text = path => {
        if (path === '/proc/102/stat' && ++statReads > 1) throw error
        return read(path)
      }
      await expect(captureNativeWindowEvidence(async () => native, 101, {
        platform: 'linux', runnerPid: 100, reader,
      })).rejects.toBe(error)
    })

    it.each([
      { file: '/proc/102/status', from: 'NoNewPrivs:\t1', to: 'NoNewPrivs:\t0' },
      { file: '/proc/102/status', from: 'CapEff:\t0000000000000000', to: 'CapEff:\t0000000000000001' },
      { file: '/proc/102/status', from: 'Seccomp:\t2', to: 'Seccomp:\t0' },
      { file: '/proc/102/status', from: '1000\t1000\t1000\t1000', to: '0\t0\t0\t0' },
      { file: '/proc/102/status', from: 'Gid:\t1000\t1000\t1000\t1000', to: 'Gid:\t1000\t1000\t1000\t0' },
      { file: '/proc/102/cgroup', from: 'owned-native', to: 'foreign-native' },
      { file: '/proc/100/cgroup', from: '0::/system.slice/owned-native.service', to: '' },
      { file: '/proc/102/cmdline', from: '--type=renderer', to: '--type=renderer\0--no-sandbox' },
      { file: '/proc/101/cmdline', from: '--private-argument', to: '--disable-setuid-sandbox\0--private-argument' },
      { file: '/proc/102/cmdline', from: '--type=renderer', to: '--type=renderer\0--disable-seccomp-filter-sandbox=true' },
      { file: '/proc/102/cmdline', from: '--type=renderer', to: '--type=utility' },
    ])('rejects unsafe or foreign process evidence from $file', async ({ file, from, to }) => {
      const { files, reader } = procFixture(rendererExecutable)
      files.set(file, files.get(file)!.replace(from, to))
      await expect(captureNativeWindowEvidence(async () => native, 101, {
        platform: 'linux', runnerPid: 100, reader,
      })).rejects.toThrow(/native process security/)
    })

    it.each([
      ['Pid:\t102', ''], ['Uid:\t1000\t1000\t1000\t1000', 'Uid:\t1000'],
      ['Gid:\t1000\t1000\t1000\t1000', 'Gid:\t1000'],
      ['NoNewPrivs:\t1', ''], ['CapEff:\t0000000000000000', 'CapEff:\tinvalid'], ['Seccomp:\t2', ''],
    ])('refuses missing or malformed renderer kernel facts %s', async (from, to) => {
      const { files, reader } = procFixture(rendererExecutable)
      files.set('/proc/102/status', files.get('/proc/102/status')!.replace(from, to))
      await expect(captureNativeWindowEvidence(async () => native, 101, {
        platform: 'linux', runnerPid: 100, reader,
      })).rejects.toThrow(/native process security/)
    })
  })

  it('rejects a readable renderer executable that differs from the main executable', async () => {
    const { files, reader } = procFixture()
    files.set('/proc/102/exe', '/foreign/electron')
    await expect(captureNativeWindowEvidence(async () => native, 101, {
      platform: 'linux', runnerPid: 100, reader,
    })).rejects.toThrow(/native process security/)
  })

  it('preserves ordinary portable native evidence without inventing Linux facts', async () => {
    const evidence = await captureNativeWindowEvidence(async () => native, 101, { platform: 'win32' })
    expect(evidence).toEqual({ platform: 'win32', native })
  })
})
