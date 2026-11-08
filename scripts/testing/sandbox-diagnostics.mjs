import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { closeSync, openSync, readFileSync, readSync, readdirSync, readlinkSync, writeSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const phases = new Set(['ordinary', 'dependency-preparation', 'runtime-suite', 'external-browser'])
const nullableHex = value => {
  if (value === '') return null
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('invalid identity')
  return value
}
const status = value => {
  if (value === '') return null
  if (!/^(0|[1-9]\d{0,2})$/.test(value) || Number(value) > 255) throw new Error('invalid status')
  return Number(value)
}
const jobs = value => value === '' ? null : /^-?\d+$/.test(value) ? value : 'non-numeric'
const emit = row => process.stderr.write(`${JSON.stringify(row)}\n`)

// Only the sandbox's private PID namespace is scanned. Each candidate must
// be a direct child of Cargo, have Cargo's build-script executable layout,
// and remain a descendant of the bound caller throughout the observation.
// A missed, inaccessible, raced or cached script simply remains unknown.
const procStat = pid => {
  try {
    const text = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const end = text.lastIndexOf(') ')
    if (end < 0) return null
    const fields = text.slice(end + 2).split(' ')
    if (!/^\d+$/.test(fields[1] ?? '') || !/^\d+$/.test(fields[19] ?? '')) return null
    return { pid, parent: Number(fields[1]), start: fields[19] }
  } catch { return null }
}
const executable = pid => {
  try { return readlinkSync(`/proc/${pid}/exe`) } catch { return null }
}
const sameProcess = (a, b) => a && b && a.pid === b.pid && a.parent === b.parent && a.start === b.start
export const parseReportedJobs = data => {
  if (!data.length || data.length > 65536 || data[data.length - 1] !== 0) return null
  const values = data.toString('latin1').split('\0').filter(value => value.startsWith('NUM_JOBS='))
  if (values.length !== 1 || !/^NUM_JOBS=[1-9]\d{0,6}$/.test(values[0])) return null
  const value = Number(values[0].slice('NUM_JOBS='.length))
  return value <= 1_000_000 ? value : null
}
const reportedJobs = pid => {
  let fd
  try {
    fd = openSync(`/proc/${pid}/environ`, 'r')
    // Bound reads and reject truncation, duplicate keys and malformed values.
    const data = Buffer.alloc(65537)
    let length = 0
    while (length < data.length) {
      const count = readSync(fd, data, length, data.length - length, null)
      if (count === 0) break
      length += count
    }
    return parseReportedJobs(data.subarray(0, length))
  } catch { return null } finally { if (fd !== undefined) closeSync(fd) }
}

export const observeCargo = (context, callerPid, callerStart, hooks = {}) => {
  // Explicit read/clock hooks let confined tests exercise process races and
  // output bounds without reading or affecting any real process.
  const stat = hooks.stat ?? procStat
  const exe = hooks.exe ?? executable
  const jobsValue = hooks.jobs ?? reportedJobs
  const list = hooks.list ?? (() => readdirSync('/proc'))
  const output = hooks.output ?? (row => writeSync(3, `${JSON.stringify(row)}\n`))
  const schedule = hooks.schedule ?? ((fn, ms) => setInterval(fn, ms))
  const cancel = hooks.cancel ?? (timer => clearInterval(timer))
  // One numeric process ordinal per witnessed Cargo incarnation, and at most
  // 64 distinct samples total; neither process IDs nor paths are emitted.
  const cargoProcesses = new Map()
  let emitted = 0
  const scan = () => {
    const caller = stat(callerPid)
    if (!caller || caller.start !== callerStart) return false
    let pids
    try { pids = list().filter(name => /^[1-9]\d*$/.test(name)).slice(0, 512) } catch { return false }
    for (const pidText of pids) {
      const pid = Number(pidText)
      const scriptExe = exe(pid)
      if (!scriptExe || !/\/build\/[^/]+-[a-f0-9]{16}\/build-script-[A-Za-z0-9_-]+$/.test(scriptExe)) continue
      const script = stat(pid)
      const cargo = script && stat(script.parent)
      const cargoExe = cargo && exe(cargo.pid)
      if (!cargo || !cargoExe || basename(cargoExe) !== 'cargo') continue

      const chain = [script, cargo]
      while (chain.at(-1).pid !== callerPid && chain.length <= 64) {
        const parent = stat(chain.at(-1).parent)
        if (!parent || chain.some(item => item.pid === parent.pid)) break
        chain.push(parent)
      }
      if (chain.at(-1).pid !== callerPid || chain.at(-1).start !== callerStart) continue
      const value = jobsValue(pid)
      if (value === null || chain.some(item => !sameProcess(item, stat(item.pid)))) continue
      if (exe(pid) !== scriptExe || exe(cargo.pid) !== cargoExe) continue

      const key = `${cargo.pid}:${cargo.start}`
      let observed = cargoProcesses.get(key)
      if (!observed) {
        observed = { ordinal: cargoProcesses.size + 1, values: new Set() }
        cargoProcesses.set(key, observed)
      }
      if (observed.values.has(value)) continue
      observed.values.add(value)
      try {
        output({ severity: 'info', event: 'sandbox_cargo_jobs', ...context,
          state: 'observed', source: 'cargo_build_script', cargo_process: observed.ordinal, jobs: value })
      } catch { return false }
      if (++emitted >= 64) return false
    }
    return true
  }
  if (!scan()) return
  const timer = schedule(() => { if (!scan()) cancel(timer) }, 200)
}

export async function main() {
  try {
    const [mode, ...args] = process.argv.slice(2)
    if (mode === 'digest' && args.length === 0) {
      const hash = createHash('sha256')
      for await (const chunk of process.stdin) hash.update(chunk)
      process.stdout.write(hash.digest('hex'))
    } else {
      const [container, phase, digest, ...values] = args
      if (!/^freshell-sandbox-[A-Za-z0-9]{8}$/.test(container ?? '') || !phases.has(phase)) throw new Error('invalid context')
      const context = { container, phase, command_sha256: nullableHex(digest) }
      if (mode === 'configured' && values.length === 1) {
        emit({ severity: 'info', event: 'sandbox_resources_requested', ...context,
          cpus: 2, memory_bytes: 8 * 1024 ** 3, memory_swap_bytes: 16 * 1024 ** 3, pids_limit: 512,
          cargo_build_jobs_env: jobs(values[0]) })
      } else if (mode === 'effective' && values.length === 1) {
        const controls = {}
        for (const [field, file, pattern] of [
          ['cpu_max', 'cpu.max', /^(max|\d+) \d+$/],
          ['memory_max', 'memory.max', /^(max|\d+)$/],
          ['memory_swap_max', 'memory.swap.max', /^(max|\d+)$/],
          ['pids_max', 'pids.max', /^(max|\d+)$/],
        ]) {
          let value = null
          try {
            const text = (await readFile(`/sys/fs/cgroup/${file}`, 'utf8')).trim()
            if (pattern.test(text)) value = text
          } catch { /* A missing or inaccessible own-cgroup control stays unknown. */ }
          controls[field] = value
        }
        const available = Object.values(controls).filter(value => value !== null).length
        emit({ severity: available === 4 ? 'info' : 'warn', event: 'sandbox_effective_limits', ...context,
          ...controls, availability: available === 4 ? 'complete' : available === 0 ? 'unavailable' : 'partial',
          cargo_build_jobs_env: jobs(values[0]) })
      } else if (mode === 'observe-launch' && values.length === 1) {
        if (!/^[1-9]\d*$/.test(values[0])) throw new Error('invalid caller')
        const caller = procStat(Number(values[0]))
        if (!caller) throw new Error('missing caller')
        // The short launcher is joined by the prelude. When it exits, the
        // existing container init adopts the watcher before the caller execs.
        // fd 3 alone carries fixed JSONL; startup/runtime stderr is discarded.
        const watcher = spawn(process.execPath, [process.argv[1], 'observe-watch', container, phase, digest,
          values[0], caller.start], { stdio: ['ignore', 'ignore', 'ignore', 3] })
        watcher.on('error', () => {})
        watcher.unref()
      } else if (mode === 'observe-watch' && values.length === 2) {
        if (!/^[1-9]\d*$/.test(values[0]) || !/^\d+$/.test(values[1])) throw new Error('invalid caller')
        observeCargo(context, Number(values[0]), values[1])
      } else if (mode === 'workload' && values.length === 2) {
        const dockerStatus = status(values[1])
        emit({ severity: dockerStatus === 0 ? 'info' : 'error', event: 'sandbox_workload_exit', ...context,
          cid: nullableHex(values[0]), docker_status: dockerStatus, state: 'not_retained', oom_killed: null })
      } else if (mode === 'final' && values.length === 3) {
        if (!['0', '1'].includes(values[2])) throw new Error('invalid settlement')
        const finalStatus = status(values[1])
        if (finalStatus === null) throw new Error('missing final status')
        emit({ severity: finalStatus === 0 ? 'info' : 'error', event: 'sandbox_result', ...context,
          docker_status: status(values[0]), final_status: finalStatus, settled: values[2] === '1' })
      } else throw new Error('invalid mode')
    }
  } catch {
    // The launcher emits a fixed unavailable event; never echo input or errors.
    process.exitCode = 1
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
