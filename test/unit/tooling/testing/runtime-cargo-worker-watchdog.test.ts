// @vitest-environment node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const child = vi.hoisted(() => ({ execFileSync: vi.fn() }))
vi.mock('node:child_process', () => ({ ...child, default: child }))

import { runtimeCargoBuildAndCopy, runtimeCargoCommand } from '../../../../scripts/testing/runtime-cargo-artifacts.js'
import { runRuntimeCargoArtifactWorker } from '../../../../scripts/testing/runtime-cargo-artifacts-worker.mjs'
import { SYNC_BUILD_TIMEOUT_MS } from '../../../../scripts/testing/sync-subprocess.js'

const owned: string[] = []

beforeEach(() => {
  vi.resetAllMocks()
  child.execFileSync.mockImplementation(() => { throw new Error('unexpected native subprocess in worker fixture') })
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const directory of owned.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'freshell-cargo-worker-'))
  owned.push(root)
  const targetDirectory = path.join(root, 'cargo target')
  const source = path.join(targetDirectory, 'release', 'fixture-server')
  const target = path.join(root, 'owned snapshot', 'fixture-server')
  fs.mkdirSync(path.dirname(source), { recursive: true })
  fs.writeFileSync(source, 'stale executable')
  return { root, source, target, env: { CARGO_TARGET_DIR: targetDirectory } }
}

describe('runtime Cargo worker watchdog boundary', () => {
  it.each([
    { label: 'timeout', fields: { code: 'ETIMEDOUT', errno: -110, syscall: 'spawnSync fixture-cargo', status: null, signal: 'SIGKILL', pid: 424242 } },
    { label: 'spawn failure', fields: { code: 'ENOENT', errno: -2, syscall: 'spawnSync fixture-cargo', path: 'fixture-cargo', status: null, signal: null, pid: 0 } },
    { label: 'signal exit', fields: { status: null, signal: 'SIGTERM', pid: 424242 } },
  ])('retains $label through the worker report without copying stale output', ({ label, fields }) => {
    const f = fixture()
    const nativeFailure = Object.assign(new Error(`fixture ${label}`), fields)
    const execute = vi.fn(() => { throw nativeFailure })
    const log = vi.fn()
    let workerFailure: Error | undefined
    child.execFileSync.mockImplementation((_command: string, args: string[]) => {
      const reports: unknown[] = []
      const request = JSON.parse(args[args.length - 1])
      try {
        runRuntimeCargoArtifactWorker(request, { execute, reportFailure: (failure: unknown) => reports.push(failure), log })
      } catch (error) {
        expect(error).toBe(nativeFailure)
        expect(reports).toHaveLength(1)
        workerFailure = Object.assign(new Error('worker exited unsuccessfully'), {
          status: 1, signal: null, output: [null, null, null, Buffer.from(JSON.stringify(reports[0]))],
        })
        throw workerFailure
      }
      throw new Error('failed native build unexpectedly completed')
    })

    let failure: unknown
    try {
      runtimeCargoBuildAndCopy(f.root, 'fixture-cargo', ['build', '--locked'], [{ source: f.source, target: f.target }], f.env, 1234)
    } catch (error) { failure = error }

    expect(failure).toBeInstanceOf(Error)
    expect(failure).toMatchObject({ message: nativeFailure.message, ...fields, cause: workerFailure })
    expect(execute).toHaveBeenCalledExactlyOnceWith('fixture-cargo', ['build', '--locked'], {
      stdio: 'inherit', timeout: 1234, killSignal: 'SIGKILL',
    })
    expect(fs.readFileSync(f.source, 'utf8')).toBe('stale executable')
    expect(fs.existsSync(f.target)).toBe(false)
    expect(log).not.toHaveBeenCalled()
    expect(child.execFileSync).toHaveBeenCalledTimes(1)
    const [command, args, options] = child.execFileSync.mock.calls[0]
    expect(options).not.toHaveProperty('timeout')
    expect(options).not.toHaveProperty('killSignal')
    if (process.platform === 'linux') {
      expect(command).toBe('flock')
      expect(args.slice(0, 3)).toEqual(['--close', '--wait', '1.234'])
      expect(args[3]).toBe(path.join(fs.realpathSync(f.env.CARGO_TARGET_DIR), '.freshell-runtime-artifacts.lock'))
      expect(args[4]).toBe(process.execPath)
    } else {
      expect(command).toBe(process.execPath)
    }
  })

  it('copies only the successful build output before publishing completion', () => {
    const f = fixture()
    const execute = vi.fn(() => { fs.writeFileSync(f.source, 'current executable') })
    const reportFailure = vi.fn()
    const log = vi.fn((_message: string) => { expect(fs.readFileSync(f.target, 'utf8')).toBe('current executable') })

    runRuntimeCargoArtifactWorker({ command: 'fixture-cargo', args: ['build'], copies: [{ source: f.source, target: f.target }], timeoutMs: 1234 },
      { execute, reportFailure, log })

    expect(execute).toHaveBeenCalledTimes(1)
    expect(reportFailure).not.toHaveBeenCalled()
    expect(fs.readFileSync(f.target, 'utf8')).toBe('current executable')
    expect(log).toHaveBeenCalledTimes(1)
    expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({ event: 'runtime.cargo.artifacts_snapshotted', artifactCount: 1 })
    expect(child.execFileSync).not.toHaveBeenCalled()
  })

  it('keeps copy failures on the same failure channel after a successful build', () => {
    const f = fixture()
    fs.rmSync(f.source)
    const execute = vi.fn()
    const reportFailure = vi.fn()
    const log = vi.fn()

    expect(() => runRuntimeCargoArtifactWorker({ command: 'fixture-cargo', args: ['build'], copies: [{ source: f.source, target: f.target }], timeoutMs: 1234 },
      { execute, reportFailure, log })).toThrow()

    expect(execute).toHaveBeenCalledTimes(1)
    expect(reportFailure).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ code: 'ENOENT', path: f.source, dest: f.target }))
    expect(fs.existsSync(f.target)).toBe(false)
    expect(log).not.toHaveBeenCalled()
  })

  it('does not replace the native failure when its diagnostic pipe is unavailable', () => {
    const f = fixture()
    const nativeFailure = Object.assign(new Error('native build timeout'), { code: 'ETIMEDOUT' })
    const execute = vi.fn(() => { throw nativeFailure })
    const reportFailure = vi.fn(() => { throw new Error('closed diagnostic pipe') })
    let failure: unknown
    try {
      runRuntimeCargoArtifactWorker({ command: 'fixture-cargo', args: ['build'], copies: [{ source: f.source, target: f.target }], timeoutMs: 1234 },
        { execute, reportFailure, log: vi.fn() })
    } catch (error) { failure = error }
    expect(failure).toBe(nativeFailure)
    expect(fs.existsSync(f.target)).toBe(false)
  })

  it('uses the existing build budget when the caller omits an override', () => {
    const f = fixture()
    child.execFileSync.mockReturnValue(Buffer.alloc(0))
    runtimeCargoBuildAndCopy(f.root, 'fixture-cargo', ['build'], [], f.env)
    const [, args] = child.execFileSync.mock.calls[0]
    expect(JSON.parse(args[args.length - 1]).timeoutMs).toBe(SYNC_BUILD_TIMEOUT_MS)
    if (process.platform === 'linux') expect(args.slice(0, 3)).toEqual(['--close', '--wait', String(SYNC_BUILD_TIMEOUT_MS / 1000)])
  })

  it('refuses a disabled watchdog before creating a lock or launching a child', () => {
    const f = fixture()
    expect(() => runtimeCargoCommand(f.root, 'fixture-cargo', ['build'], f.env, 0)).toThrow('positive finite')
    expect(child.execFileSync).not.toHaveBeenCalled()
  })
})
