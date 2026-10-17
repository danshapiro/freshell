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

function procFixture() {
  const files = new Map<string, string>()
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
    link: vi.fn(path => files.get(path)!),
  }
  return { files, reader }
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

  it('rejects a native mapping that changes while reading process facts', async () => {
    const { reader } = procFixture()
    const snapshot = vi.fn().mockResolvedValueOnce(native).mockResolvedValueOnce({ ...native, rendererPid: 103 })
    await expect(captureNativeWindowEvidence(snapshot, 101, {
      platform: 'linux', runnerPid: 100, reader,
    })).rejects.toThrow(/native mapping changed/)
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

  it.each([
    { file: '/proc/102/status', from: 'NoNewPrivs:\t1', to: 'NoNewPrivs:\t0' },
    { file: '/proc/102/status', from: 'CapEff:\t0000000000000000', to: 'CapEff:\t0000000000000001' },
    { file: '/proc/102/status', from: 'Seccomp:\t2', to: 'Seccomp:\t0' },
    { file: '/proc/102/status', from: '1000\t1000\t1000\t1000', to: '0\t0\t0\t0' },
    { file: '/proc/102/cgroup', from: 'owned-native', to: 'foreign-native' },
    { file: '/proc/102/cmdline', from: '--type=renderer', to: '--type=renderer\0--no-sandbox' },
    { file: '/proc/101/cmdline', from: '--private-argument', to: '--disable-setuid-sandbox\0--private-argument' },
    { file: '/proc/102/cmdline', from: '--type=renderer', to: '--type=renderer\0--disable-seccomp-filter-sandbox=true' },
    { file: '/proc/102/cmdline', from: '--type=renderer', to: '--type=utility' },
    { file: '/proc/102/exe', from: '/public/electron', to: '/foreign/electron' },
  ])('rejects unsafe or foreign process evidence from $file', async ({ file, from, to }) => {
    const { files, reader } = procFixture()
    files.set(file, files.get(file)!.replace(from, to))
    await expect(captureNativeWindowEvidence(async () => native, 101, {
      platform: 'linux', runnerPid: 100, reader,
    })).rejects.toThrow(/native process security/)
  })

  it('refuses incomplete kernel facts instead of manufacturing successful evidence', () => {
    const { files, reader } = procFixture()
    files.set('/proc/102/status', files.get('/proc/102/status')!.replace('Gid:\t1000\t1000\t1000\t1000', 'Gid:\t1000'))
    expect(() => readLinuxNativeProcess(102, reader)).toThrow(/invalid Gid/)
  })

  it('preserves ordinary portable native evidence without inventing Linux facts', async () => {
    const evidence = await captureNativeWindowEvidence(async () => native, 101, { platform: 'win32' })
    expect(evidence).toEqual({ platform: 'win32', native })
  })
})
