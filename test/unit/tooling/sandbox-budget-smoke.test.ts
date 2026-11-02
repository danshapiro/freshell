// @vitest-environment node
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

type Observation = { name: string; jobs: number | string; start: string; end: string }

const secret = 'BUDGET_SECRET_SENTINEL'
const controls: Record<string, string> = {
  'cpu.max': '200000 100000',
  'memory.max': '8589934592',
  'memory.swap.max': '8589934592',
  'pids.max': '512',
  'memory.peak': '1073741824',
  'memory.pressure': 'some avg10=0.00 avg60=0.00 avg300=0.00 total=0',
}

function observations(jobs: number, parallel = false): Observation[] {
  return Array.from({ length: 6 }, (_, index) => {
    const start = parallel && index < 2 ? 0 : index * 10
    return { name: `unit${index}`, jobs, start: String(start), end: String(start + 5) }
  })
}

// Exercise the actual smoke module without launching Cargo or another process.
// The fake Cargo validates its invocation before writing tiny observations.
async function runInProcess(rows: Observation[], readings: Record<string, string> = {}) {
  const parent = process.env.FRESHELL_TEST_EXECUTABLE_TMP_DIR ?? os.tmpdir()
  const root = mkdtempSync(path.join(parent, 'sandbox-in-process-'))
  const observedControls = { ...controls, ...readings }
  const previousArgv = process.argv
  const previousExitCode = process.exitCode
  const stdout = vi.spyOn(console, 'log').mockImplementation(() => {})
  const stderr = vi.spyOn(console, 'error').mockImplementation(() => {})
  let cargoCalls = 0
  try {
    process.argv = ['node', 'sandbox-budget-smoke.mjs', '2']
    process.exitCode = 0
    for (const key of ['CARGO_BUILD_JOBS', 'CARGO_MAKEFLAGS', 'MAKEFLAGS', 'MFLAGS']) vi.stubEnv(key, undefined)
    vi.stubEnv('FAKE_SECRET_INPUT', secret)
    vi.stubEnv('FRESHELL_TEST_EXECUTABLE_TMP_DIR', root)
    // Fail closed even if the module mock fails to intercept the invocation.
    vi.stubEnv('PATH', root)
    vi.resetModules()
    vi.doMock('node:child_process', async importOriginal => {
      const actual = await importOriginal<typeof import('node:child_process')>()
      return { ...actual, execFileSync: (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => {
        const events = options?.env?.BUDGET_EVENTS
        if (command !== 'cargo' || JSON.stringify(args) !== JSON.stringify(['build', '--workspace', '--offline'])
            || path.dirname(options.cwd) !== root || events !== path.join(options.cwd, 'events')) {
          throw new Error('unexpected smoke Cargo invocation')
        }
        cargoCalls++
        for (const [index, row] of rows.entries()) {
          writeFileSync(path.join(events, `${index}.jsonl`), `${JSON.stringify(row)}\n`)
        }
      } }
    })
    vi.doMock('node:fs', async importOriginal => {
      const actual = await importOriginal<typeof import('node:fs')>()
      const fake = {
        ...actual.default,
        readFileSync: (file: string, options: BufferEncoding) => {
          const prefix = '/sys/fs/cgroup/'
          if (typeof file === 'string' && file.startsWith(prefix) && Object.hasOwn(observedControls, file.slice(prefix.length))) {
            return observedControls[file.slice(prefix.length)]
          }
          return readFileSync(file, options)
        },
        existsSync: (file: string) => {
          // The fake Cargo ignores real ancestor configuration.
          if (/\/\.cargo\/config(?:\.toml)?$/.test(file) && !file.startsWith(`${root}/cargo-budget-`)) return false
          return existsSync(file)
        },
      }
      return { ...actual, default: fake }
    })
    await import('../../../scripts/testing/sandbox-budget-smoke.mjs')
    const calls = [...stdout.mock.calls, ...stderr.mock.calls]
    const lines = calls.flatMap(([line]) => {
      try { return [JSON.parse(String(line))] } catch { return [] }
    })
    const output = calls.map(call => call.map(String).join(' ')).join('\n')
    return { status: process.exitCode, lines, output, cargoCalls, leftovers: readdirSync(root) }
  } finally {
    process.argv = previousArgv
    process.exitCode = previousExitCode
    vi.unstubAllEnvs()
    vi.doUnmock('node:child_process')
    vi.doUnmock('node:fs')
    vi.resetModules()
    stdout.mockRestore()
    stderr.mockRestore()
    rmSync(root, { recursive: true, force: true })
  }
}

// The CLI still creates and cleans its real temporary workspace. This finite
// fake Cargo supplies controlled build-script observations; a preload supplies
// cgroup readings, so failure cases do not consume memory or alter host limits.
function runSmoke(options: {
  rows: Observation[]
  args?: string[]
  cargoJobs?: string
  readings?: Record<string, string>
}) {
  const parent = process.env.FRESHELL_TEST_EXECUTABLE_TMP_DIR ?? os.tmpdir()
  const root = mkdtempSync(path.join(parent, `sandbox-smoke-${secret}-`))
  const bin = path.join(root, 'bin')
  const work = path.join(root, 'work')
  mkdirSync(bin)
  writeFileSync(path.join(bin, 'package.json'), JSON.stringify({ type: 'commonjs' }))
  mkdirSync(work)
  const preload = path.join(root, 'controls.cjs')
  writeFileSync(preload, `
    const fs = require('node:fs')
    const original = fs.readFileSync
    const originalExists = fs.existsSync
    const values = JSON.parse(process.env.FAKE_SMOKE_CONTROLS)
    // The fixture runs a fake Cargo, so unrelated ancestor configs cannot
    // influence it. Ignore them while leaving its own project config visible.
    fs.existsSync = function(file) {
      if (typeof file === 'string' && /\\/\\.cargo\\/config(?:\\.toml)?$/.test(file)
          && !file.startsWith(process.env.FRESHELL_TEST_EXECUTABLE_TMP_DIR + '/cargo-budget-')) return false
      return originalExists.apply(this, arguments)
    }
    fs.readFileSync = function(file, options) {
      const prefix = '/sys/fs/cgroup/'
      if (typeof file === 'string' && file.startsWith(prefix) && Object.hasOwn(values, file.slice(prefix.length))) {
        const value = values[file.slice(prefix.length)]
        return typeof options === 'string' || options?.encoding ? value : Buffer.from(value)
      }
      return original.apply(this, arguments)
    }
  `)
  const cargo = path.join(bin, 'cargo')
  writeFileSync(cargo, `#!/usr/bin/env node
    const fs = require('node:fs')
    const path = require('node:path')
    const rows = JSON.parse(process.env.FAKE_SMOKE_ROWS)
    for (const [index, row] of rows.entries()) {
      fs.writeFileSync(path.join(process.env.BUDGET_EVENTS, String(index) + '.jsonl'), JSON.stringify(row) + '\\n')
    }
  `)
  chmodSync(cargo, 0o755)
  const env = { ...process.env }
  for (const key of ['CARGO_BUILD_JOBS', 'CARGO_MAKEFLAGS', 'MAKEFLAGS', 'MFLAGS']) delete env[key]
  if (options.cargoJobs !== undefined) env.CARGO_BUILD_JOBS = options.cargoJobs
  Object.assign(env, {
    PATH: `${bin}:${process.env.PATH}`,
    NODE_OPTIONS: `--require=${preload}`,
    FRESHELL_TEST_EXECUTABLE_TMP_DIR: work,
    FAKE_SMOKE_ROWS: JSON.stringify(options.rows),
    FAKE_SMOKE_CONTROLS: JSON.stringify({ ...controls, ...options.readings }),
    FAKE_SECRET_INPUT: secret,
  })
  try {
    const result = spawnSync(process.execPath, [path.resolve('scripts/testing/sandbox-budget-smoke.mjs'), ...(options.args ?? ['2'])], {
      env, encoding: 'utf8', timeout: 20_000,
    })
    const lines = `${result.stdout}\n${result.stderr}`.split('\n').flatMap(line => {
      try { return [JSON.parse(line)] } catch { return [] }
    })
    const leftovers = readdirSync(work)
    return { ...result, lines, leftovers }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe('sandbox build budget smoke observations', () => {
  it.each([
    ['serial', false, 1],
    ['overlapping', true, 0],
  ] as const)('in-process overlap: %s two-job work', async (_label, parallel, expectedStatus) => {
    const result = await runInProcess(observations(2, parallel))
    expect(result.cargoCalls).toBe(1)
    expect(result.leftovers).toEqual([])
    expect(result.status).toBe(expectedStatus)
    expect(result.lines).toContainEqual(expect.objectContaining({
      event: parallel ? 'sandbox_budget_smoke_passed' : 'sandbox_budget_smoke_failed',
    }))
  })

  it.each([
    ['wrong jobs', observations(2, true).map((row, index) => index === 0 ? { ...row, jobs: 5, ignored: secret } : row), {},
      { reason: 'jobs', expected_jobs: 2, observed_jobs: 5 }],
    ['non-numeric jobs', observations(2, true).map((row, index) => index === 0 ? { ...row, jobs: secret } : row), {},
      { reason: 'jobs', expected_jobs: 2, observed_jobs: null }],
    ['serial overlap', observations(2), {}, { reason: 'overlap', expected_jobs: 2, observed_overlap: 1 }],
    ['memory peak', observations(2, true), { 'memory.peak': '3221225472' },
      { reason: 'memory_peak', limit_bytes: 2147483648, observed_bytes: 3221225472 }],
    ['invalid memory peak', observations(2, true), { 'memory.peak': secret },
      { reason: 'memory_peak', limit_bytes: 2147483648, observed_bytes: null }],
    ['memory pressure', observations(2, true), { 'memory.pressure': 'some avg10=8.50 avg60=0.00 avg300=0.00 total=0' },
      { reason: 'memory_pressure', limit_avg10: 5, observed_avg10: 8.5 }],
  ] as const)('in-process failure diagnostics: %s', async (_label, rows, readings, detail) => {
    const result = await runInProcess(rows, readings)
    expect(result.cargoCalls).toBe(1)
    expect(result.leftovers).toEqual([])
    expect(result.status).toBe(1)
    expect(result.output).not.toContain(secret)
    expect(result.lines).toContainEqual(expect.objectContaining({ severity: 'error', event: 'sandbox_budget_smoke_failed', ...detail }))
  })

  it('rejects serial observations when two concurrent jobs are expected', () => {
    const result = runSmoke({ rows: observations(2) })
    expect(result.status, result.stderr).toBe(1)
    expect(result.lines).toContainEqual(expect.objectContaining({
      severity: 'error', event: 'sandbox_budget_smoke_failed', reason: 'overlap', expected_jobs: 2, observed_overlap: 1,
    }))
    expect(result.leftovers).toEqual([])
  })

  it('accepts observed overlapping work when two jobs are expected', () => {
    const result = runSmoke({ rows: observations(2, true) })
    expect(result.status, result.stderr).toBe(0)
    expect(result.lines).toContainEqual(expect.objectContaining({ event: 'sandbox_budget_smoke_passed', jobs: 2, peakOverlap: 2 }))
    expect(result.leftovers).toEqual([])
  })

  it('does not copy unrelated observation fields into a success receipt', () => {
    const rows = observations(2, true)
    rows[0] = { ...rows[0], ignored: secret } as Observation
    const result = runSmoke({ rows })
    expect(result.status, result.stderr).toBe(0)
    expect(result.lines).toContainEqual(expect.objectContaining({ event: 'sandbox_budget_smoke_passed', peakOverlap: 2 }))
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(secret)
    expect(result.leftovers).toEqual([])
  })

  it.each([
    ['native', ['1'], undefined],
    ['environment', ['1'], '1'],
    ['project', ['1', '--project-jobs', '1'], undefined],
    ['cli', ['1', '--cli-jobs', '1'], undefined],
  ] as const)('retains the one-job %s case', (mode, args, cargoJobs) => {
    const result = runSmoke({ rows: observations(1), args: [...args], cargoJobs })
    expect(result.status, result.stderr).toBe(0)
    expect(result.lines).toContainEqual(expect.objectContaining({ event: 'sandbox_budget_smoke_passed', mode, jobs: 1, peakOverlap: 1 }))
    expect(result.leftovers).toEqual([])
  })

  it.each([
    ['count', observations(2, true).slice(0, 5), {}, { reason: 'completion_count', expected_count: 6, observed_count: 5 }],
    ['identity', observations(2, true).map((row, index) => index === 0 ? { ...row, name: secret } : row), {}, { reason: 'completion_identity' }],
    ['jobs', observations(2, true).map((row, index) => index === 0 ? { ...row, jobs: 5 } : row), {}, { reason: 'jobs', expected_jobs: 2, observed_jobs: 5 }],
    ['non-numeric jobs', observations(2, true).map((row, index) => index === 0 ? { ...row, jobs: secret } : row), {}, { reason: 'jobs', expected_jobs: 2, observed_jobs: null }],
    ['interval', observations(2, true).map((row, index) => index === 0 ? { ...row, start: secret } : row), {}, { reason: 'interval' }],
    ['excess overlap', observations(2, true).map((row, index) => index === 2 ? { ...row, start: '0', end: '5' } : row), {}, { reason: 'overlap', expected_jobs: 2, observed_overlap: 3 }],
    ['CPU limit', observations(2, true), { 'cpu.max': '100000 100000' }, { reason: 'cpu_limit', expected_cpus: 2, observed_cpus: 1 }],
    ['memory limit', observations(2, true), { 'memory.max': '1073741824' }, { reason: 'memory_limit', expected_bytes: 8589934592, observed_bytes: 1073741824 }],
    ['swap limit', observations(2, true), { 'memory.swap.max': '1073741824' }, { reason: 'swap_limit', expected_bytes: 8589934592, observed_bytes: 1073741824 }],
    ['process limit', observations(2, true), { 'pids.max': '64' }, { reason: 'pids_limit', expected_pids: 512, observed_pids: 64 }],
    ['memory peak', observations(2, true), { 'memory.peak': '3221225472' }, { reason: 'memory_peak', limit_bytes: 2147483648, observed_bytes: 3221225472 }],
    ['invalid memory peak', observations(2, true), { 'memory.peak': secret }, { reason: 'memory_peak', limit_bytes: 2147483648, observed_bytes: null }],
    ['memory pressure', observations(2, true), { 'memory.pressure': 'some avg10=8.50 avg60=0.00 avg300=0.00 total=0' }, { reason: 'memory_pressure', limit_avg10: 5, observed_avg10: 8.5 }],
  ] as const)('keeps safe, distinct %s failure details after cleanup', (_label, rows, readings, detail) => {
    const result = runSmoke({ rows, readings })
    expect(result.status, result.stderr).toBe(1)
    expect(result.lines).toContainEqual(expect.objectContaining({ severity: 'error', event: 'sandbox_budget_smoke_failed', ...detail }))
    expect(result.leftovers).toEqual([])
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(secret)
  })

  it('does not echo invalid arguments or environment inputs', () => {
    const result = runSmoke({ rows: observations(2, true), args: ['2', secret, secret] })
    expect(result.status, result.stderr).toBe(1)
    expect(result.lines).toContainEqual(expect.objectContaining({ severity: 'error', event: 'sandbox_budget_smoke_failed', stage: 'arguments' }))
    expect(result.leftovers).toEqual([])
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(secret)
  })
})
