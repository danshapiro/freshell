// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { observeCargo, parseReportedJobs } from '../../../scripts/testing/sandbox-diagnostics.mjs'

// The supplied table and clock are the only process inputs these tests use.
// Keep them in the strict enclosure along with the real launcher fixtures.
if (process.env.FRESHELL_SANDBOX_MODE !== 'runtime-suite') {
  throw new Error('Cargo observer fixtures require the strict sandbox')
}

type Process = { pid: number; parent: number; start: string }
const context = { container: 'freshell-sandbox-abcdefgh', phase: 'ordinary', command_sha256: null }

function table(count = 1) {
  const processes = new Map<number, Process>([[10, { pid: 10, parent: 1, start: '10' }]])
  const scripts: string[] = []
  const rows: Record<string, unknown>[] = []
  for (let i = 0; i < count; i++) {
    const cargo = 100 + i
    const script = 1000 + i
    processes.set(cargo, { pid: cargo, parent: 10, start: String(cargo) })
    processes.set(script, { pid: script, parent: cargo, start: String(script) })
    scripts.push(String(script))
  }
  const hooks = {
    stat: (pid: number) => {
      const value = processes.get(pid)
      return value ? { ...value } : null
    },
    exe: (pid: number) => scripts.includes(String(pid))
      ? '/fixture/target/debug/build/example-0123456789abcdef/build-script-build'
      : pid >= 100 && pid < 100 + count ? '/toolchain/bin/cargo' : null,
    jobs: (_pid: number): number | null => 2,
    list: () => scripts,
    output: (row: Record<string, unknown>) => { rows.push(row) },
    schedule: (_callback: () => void, _ms: number) => 1,
    cancel: (_timer: number) => {},
  }
  return { processes, rows, hooks }
}

describe('bounded Cargo observation', () => {
  it('accepts only a complete, unique, positive, bounded numeric NUM_JOBS entry', () => {
    expect(parseReportedJobs(Buffer.from('SECRET=hidden\0NUM_JOBS=12\0'))).toBe(12)
    for (const input of [
      'NUM_JOBS=12', 'NUM_JOBS=0\0', 'NUM_JOBS=-1\0', 'NUM_JOBS=1x\0',
      'NUM_JOBS=1000001\0', 'NUM_JOBS=2\0NUM_JOBS=3\0', 'OTHER=2\0',
      `NUM_JOBS=2\0${'x'.repeat(65536)}\0`,
    ]) expect(parseReportedJobs(Buffer.from(input))).toBeNull()
  })

  it('rejects a process whose birth identity or ancestry changes during the read', () => {
    for (const change of ['birth', 'parent'] as const) {
      const { hooks, processes, rows } = table()
      let read = false
      hooks.jobs = () => {
        read = true
        const script = processes.get(1000)!
        if (change === 'birth') script.start = 'replacement'
        else script.parent = 1
        return 2
      }
      observeCargo(context, 10, '10', hooks)
      expect(read).toBe(true)
      expect(rows).toEqual([])
    }
  })

  it('rejects a Cargo child outside the bound caller and inaccessible values', () => {
    const foreign = table()
    foreign.processes.get(100)!.parent = 1
    observeCargo(context, 10, '10', foreign.hooks)
    expect(foreign.rows).toEqual([])
    const unavailable = table()
    unavailable.hooks.jobs = () => null
    observeCargo(context, 10, '10', unavailable.hooks)
    expect(unavailable.rows).toEqual([])
  })

  it('limits distinct emitted samples and includes only the fixed numeric metadata', () => {
    const { hooks, rows } = table(80)
    observeCargo(context, 10, '10', hooks)
    expect(rows).toHaveLength(64)
    expect(rows[0]).toEqual({ severity: 'info', event: 'sandbox_cargo_jobs', ...context,
      state: 'observed', source: 'cargo_build_script', cargo_process: 1, jobs: 2 })
    expect(rows.at(-1)?.cargo_process).toBe(64)
  })

  it('limits the process scan and stops cleanly when output is unavailable', () => {
    const limited = table(600)
    let checked = 0
    limited.hooks.exe = () => { checked++; return null }
    observeCargo(context, 10, '10', limited.hooks)
    expect(checked).toBe(512)
    const failed = table()
    let scheduled = false
    failed.hooks.output = () => { throw new Error('OUTPUT_SECRET') }
    failed.hooks.schedule = () => { scheduled = true; return 1 }
    expect(() => observeCargo(context, 10, '10', failed.hooks)).not.toThrow()
    expect(scheduled).toBe(false)
  })
})
