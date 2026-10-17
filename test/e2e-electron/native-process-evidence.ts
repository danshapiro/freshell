import fs from 'node:fs'

export interface NativeWindowIdentity {
  id: number
  mainPid: number
  webContentsId: number
  rendererPid: number
  sandbox: boolean | undefined
  contextIsolation: boolean | undefined
  nodeIntegration: boolean | undefined
}

const nativeIdentityFields = ['id', 'mainPid', 'webContentsId', 'rendererPid',
  'sandbox', 'contextIsolation', 'nodeIntegration'] as const

export interface ProcessReader {
  text(path: string): string
  link(path: string): string
}

const procReader: ProcessReader = {
  text: path => fs.readFileSync(path, 'utf8'),
  link: path => fs.readlinkSync(path),
}

export interface LinuxProcessEvidence {
  pid: number
  startTicks: string
  parentPid: number
  executable: string
  processType: string
  uid: number[]
  gid: number[]
  cgroup: string
  disablingSwitches: string[]
  noNewPrivs: number
  capEff: string
  seccomp: number
}

type RendererExecutableEvidence = { executable: string } | {
  executable: null
  executableUnavailable: { reason: 'permission-denied'; code: 'EACCES'; errno?: number }
}

export type LinuxRendererProcessEvidence = Omit<LinuxProcessEvidence, 'executable'> & RendererExecutableEvidence

function processIdentity(pid: number, reader: ProcessReader) {
  const raw = reader.text(`/proc/${pid}/stat`)
  const fields = raw.slice(raw.lastIndexOf(')') + 2).trim().split(/\s+/)
  if (!raw.startsWith(`${pid} (`) || !/^\d+$/.test(fields[19] ?? '') || !/^\d+$/.test(fields[1] ?? '')) {
    throw new Error(`native process security: invalid stat for PID ${pid}`)
  }
  return { startTicks: fields[19], parentPid: Number(fields[1]) }
}

/** Reads only the supplied live PID. Full argv/environment never leave this boundary. */
export function readLinuxNativeProcess(pid: number, reader: ProcessReader = procReader): LinuxProcessEvidence {
  return readLinuxProcess(pid, reader, false)
}

function readLinuxProcess(pid: number, reader: ProcessReader, allowRendererExecutableDenial: false): LinuxProcessEvidence
function readLinuxProcess(pid: number, reader: ProcessReader, allowRendererExecutableDenial: true): LinuxRendererProcessEvidence
function readLinuxProcess(pid: number, reader: ProcessReader, allowRendererExecutableDenial: boolean): LinuxRendererProcessEvidence {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('native process security: invalid PID')
  const before = processIdentity(pid, reader)
  const status = Object.fromEntries(reader.text(`/proc/${pid}/status`).trim().split('\n').map(line => {
    const colon = line.indexOf(':')
    return [line.slice(0, colon), line.slice(colon + 1).trim()]
  }))
  const ids = (field: 'Uid' | 'Gid') => {
    const parts = status[field]?.split(/\s+/)
    if (parts?.length !== 4 || parts.some(value => !/^\d+$/.test(value))) {
      throw new Error(`native process security: invalid ${field} for PID ${pid}`)
    }
    return parts.map(Number)
  }
  if (status.Pid !== String(pid) || !/^[01]$/.test(status.NoNewPrivs ?? '')
    || !/^[0-9a-f]{16}$/i.test(status.CapEff ?? '') || !/^[012]$/.test(status.Seccomp ?? '')) {
    throw new Error(`native process security: invalid status for PID ${pid}`)
  }
  const args = reader.text(`/proc/${pid}/cmdline`).split('\0').filter(Boolean)
  let executable: RendererExecutableEvidence
  try {
    executable = { executable: reader.link(`/proc/${pid}/exe`) }
  } catch (error) {
    const denied = error as NodeJS.ErrnoException
    if (!allowRendererExecutableDenial || !(error instanceof Error) || denied.code !== 'EACCES') throw error
    // This records unavailable data, not evidence of renderer identity or sandboxing.
    executable = {
      executable: null,
      executableUnavailable: {
        reason: 'permission-denied', code: denied.code,
        ...(denied.errno === undefined ? {} : { errno: denied.errno }),
      },
    }
  }
  const evidence: LinuxRendererProcessEvidence = {
    pid, ...before,
    ...executable,
    processType: args.find(arg => arg.startsWith('--type='))?.slice('--type='.length) ?? 'main',
    uid: ids('Uid'), gid: ids('Gid'),
    cgroup: reader.text(`/proc/${pid}/cgroup`).trim(),
    disablingSwitches: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-seccomp-filter-sandbox']
      .filter(flag => args.some(arg => arg.split('=')[0] === flag)),
    noNewPrivs: Number(status.NoNewPrivs), capEff: status.CapEff, seccomp: Number(status.Seccomp),
  }
  if (processIdentity(pid, reader).startTicks !== before.startTicks) {
    throw new Error(`native process identity changed for PID ${pid}`)
  }
  return evidence
}

export interface NativeWindowEvidence {
  platform: NodeJS.Platform
  native: NativeWindowIdentity
  linux?: { runner: LinuxProcessEvidence; main: LinuxProcessEvidence; renderer: LinuxRendererProcessEvidence }
}

export async function captureNativeWindowEvidence(
  snapshot: () => Promise<NativeWindowIdentity>,
  ownedMainPid: number,
  options: { platform?: NodeJS.Platform; runnerPid?: number; reader?: ProcessReader } = {},
): Promise<NativeWindowEvidence> {
  const platform = options.platform ?? process.platform
  const native = await snapshot()
  if (native.mainPid !== ownedMainPid || !Number.isSafeInteger(ownedMainPid) || ownedMainPid <= 0) {
    throw new Error('native window does not match the launch-owned main process')
  }
  if (native.sandbox !== true || native.contextIsolation !== true || native.nodeIntegration !== false) {
    throw new Error('native process security: unsafe native preferences')
  }
  const evidence: NativeWindowEvidence = { platform, native }
  if (platform === 'linux') {
    const runner = readLinuxNativeProcess(options.runnerPid ?? process.pid, options.reader)
    const main = readLinuxNativeProcess(native.mainPid, options.reader)
    const renderer = readLinuxProcess(native.rendererPid, options.reader ?? procReader, true)
    const sameUser = (item: Pick<LinuxProcessEvidence, 'uid' | 'gid'>) => item.uid.every(uid => uid === runner.uid[0])
      && item.gid.every(gid => gid === runner.gid[0])
    if (![runner, main, renderer].every(item => sameUser(item) && item.cgroup === runner.cgroup)
      || !runner.cgroup || !main.executable
      || (renderer.executable !== null && renderer.executable !== main.executable)
      || main.processType !== 'main' || renderer.processType !== 'renderer'
      || main.disablingSwitches.length || renderer.disablingSwitches.length
      || renderer.noNewPrivs !== 1 || !/^0+$/.test(renderer.capEff) || renderer.seccomp !== 2) {
      throw new Error('native process security: unsafe or foreign main/renderer facts')
    }
    evidence.linux = { runner, main, renderer }
  }
  const after = await snapshot()
  if (nativeIdentityFields.some(key => after[key] !== native[key])) {
    throw new Error('native mapping changed during process evidence capture')
  }
  return evidence
}
