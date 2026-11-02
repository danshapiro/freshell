import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

const phases = new Set(['ordinary', 'dependency-preparation', 'runtime-suite'])
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
