// @vitest-environment node
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const child = vi.hoisted(() => ({ execFile: vi.fn(), execFileSync: vi.fn(), spawnSync: vi.fn(), spawn: vi.fn() }))
vi.mock('node:child_process', () => ({ ...child, default: child }))
vi.mock('../../../setup/manager-command.js', () => ({
  resolveManagerExecFileCommand: () => ({ command: 'fixture-manager', args: ['run', 'build:tools'] }),
}))

import { RuntimeHarness } from '../../../../scripts/testing/runtime-sandbox.js'
import { SYNC_BUILD_TIMEOUT_MS, SYNC_PROBE_TIMEOUT_MS } from '../../../../scripts/testing/sync-subprocess.js'
import { ManagedRuntimeBrowserRig } from '../../../e2e-browser/helpers/managed-runtime.js'
import { ensureMcpServerBuilt } from '../../../e2e-browser/helpers/mcp-stdio-client.js'
import { ensureRustServerBuilt, ownedDescendantPids, RustServer } from '../../../e2e-browser/helpers/rust-server.js'

const ownedDirectories: string[] = []
const revision = 'a'.repeat(40)
const containerId = 'b'.repeat(64)
const timedOut = () => Object.assign(new Error('fixture subprocess watchdog expired'), { code: 'ETIMEDOUT' })
const interrupted = (error: Error) => ({ error, status: null, signal: 'SIGKILL', stdout: '', stderr: '' })

function gitResult(args: string[], options?: { encoding?: string }): string | Buffer {
  const command = args.join(' ')
  let value: string
  if (command === 'rev-parse HEAD' || command === 'rev-parse --verify HEAD') value = `${revision}\n`
  else if (command === 'status --porcelain'
    || command === 'status --porcelain=v1 -z --untracked-files=all'
    || command === 'diff --no-ext-diff --no-textconv --binary HEAD --') value = ''
  else throw new Error(`unexpected Git probe in watchdog fixture: ${command}`)
  return options?.encoding ? value : Buffer.from(value)
}

function cargoWorkerCalls() {
  return child.execFileSync.mock.calls.filter(([, args]) =>
    args.some((arg: string) => arg.endsWith('/runtime-cargo-artifacts-worker.mjs')))
}

function cargoWorkerRequest(call: unknown[]) {
  const args = call[1] as string[]
  return JSON.parse(args[args.length - 1])
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubEnv('FRESHELL_RUNTIME_TEST_BUILD_MANIFEST', '')
  vi.stubEnv('FRESHELL_E2E_RUST_SERVER_BIN', '')
  vi.stubEnv('CARGO_TARGET_DIR', '')
  vi.stubEnv('FRESHELL_RUNTIME_WORKLOAD_IMAGE_DIGEST', undefined)
  child.execFileSync.mockImplementation((program: string, args: string[], options?: { encoding?: string }) => {
    if (program === 'git') return gitResult(args, options)
    throw new Error(`unexpected executable in watchdog fixture: ${program}`)
  })
  child.spawnSync.mockImplementation(() => { throw new Error('unexpected synchronous child in watchdog fixture') })
  child.spawn.mockImplementation(() => { throw new Error('unexpected child in watchdog fixture') })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  for (const directory of ownedDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'frs-watchdog-'))
  ownedDirectories.push(root)
  return root
}

function harness(phase: 1 | 2 = 1): RuntimeHarness {
  const runtime = new RuntimeHarness(temporaryRoot(), undefined, phase)
  ownedDirectories.push(runtime.testRoot)
  return runtime
}

function rig(): ManagedRuntimeBrowserRig {
  const root = temporaryRoot()
  // Qualification state is an input to the builder, independent of the
  // repository's current live-provider certification campaign.
  const manifest = path.join(root, 'docs/development/runtime-provider-capabilities.json')
  fs.mkdirSync(path.dirname(manifest), { recursive: true })
  fs.writeFileSync(manifest, JSON.stringify({
    certification: {},
    providers: [{ provider: 'codex', certificationState: 'pending_live_provider_certification', qualificationReady: true }],
  }))
  const browser = new ManagedRuntimeBrowserRig(root, 2, {}, {}, 'test', { enabledProviders: ['codex'] })
  ownedDirectories.push(browser.runtime.testRoot)
  return browser
}

function cleanupRigWithRetainedBuild() {
  const browser = rig()
  child.execFileSync.mockImplementation((program: string, args: string[]) => {
    if (program === 'docker' && (args[0] === 'ps' || args.join(' ') === 'volume ls --format {{.Name}}')) return ''
    throw new Error(`unexpected cleanup command: ${program} ${args.join(' ')}`)
  })
  fs.mkdirSync(browser.runtime.buildDir, { recursive: true })
  fs.writeFileSync(path.join(browser.runtime.buildDir, 'retained-build'), 'owned evidence')
  return { browser, cleanup: vi.spyOn(browser.runtime, 'cleanup') }
}

describe('runtime synchronous subprocess watchdogs', () => {
  it.each(['running-state', 'removal', 'logs', 'image-lookup'] as const)(
    'does not turn an interrupted Docker probe into a negative answer: %s', operation => {
      const runtime = harness()
      const error = timedOut()
      child.spawnSync.mockReturnValue(interrupted(error))
      const invoke = () => {
        if (operation === 'running-state') return runtime.isContainerRunning(containerId)
        if (operation === 'removal') return runtime.removeContainerExact(containerId)
        if (operation === 'logs') return runtime.containerLogs(containerId)
        return (runtime as unknown as { ensureRuntimeImage(): void }).ensureRuntimeImage()
      }

      expect(invoke).toThrow(error)
      expect(child.spawnSync).toHaveBeenCalledExactlyOnceWith('docker', expect.any(Array), expect.objectContaining({
        timeout: SYNC_PROBE_TIMEOUT_MS, killSignal: 'SIGKILL',
      }))
      expect(child.execFileSync.mock.calls.filter(([program]) => program === 'docker')).toEqual([])
    },
  )

  it('does not treat a signaled Docker inspection as an absent container', () => {
    const runtime = harness()
    child.spawnSync.mockReturnValue({ status: null, signal: 'SIGKILL', stdout: 'false\n', stderr: '' })
    expect(() => runtime.isContainerRunning(containerId)).toThrow('Docker client did not complete')
  })

  it('preserves completed absent-container results', () => {
    const runtime = harness()
    child.spawnSync.mockReturnValue({ status: 1, signal: null, stdout: '', stderr: 'No such container' })
    expect(runtime.isContainerRunning(containerId)).toBe(false)
    expect(runtime.removeContainerExact(containerId)).toBeUndefined()
    expect(child.spawnSync.mock.calls.every(([, args]) => args[0] === 'inspect')).toBe(true)
  })

  it.each(['supervisor', 'supervisor-volume', 'web-lifetime-sentinel', 'foreign-sentinel'] as const)(
    'does not certify cleanup after interrupted %s creation', async resource => {
      const runtime = harness()
      const error = timedOut()
      runtime.imageRef = `sha256:${'c'.repeat(64)}`
      runtime.testSupervisorBinary = path.join(runtime.buildDir, 'supervisor')
      runtime.testHostBinary = path.join(runtime.buildDir, 'host')
      runtime.broker = {
        proxySocketPath: path.join(runtime.testRoot, 'docker.sock'),
        historyHelperNames: () => [], settleForwarded: async () => true,
        awaitPendingRequests: async () => [], receipts: () => [],
        initialProviderVolumeCreations: () => [], receiptIds: () => new Set(),
        candidateVolumeNames: () => [], eventsSnapshot: () => [], unsafeAttempts: () => [],
      } as unknown as typeof runtime.broker
      fs.mkdirSync(runtime.buildDir, { recursive: true })
      fs.writeFileSync(path.join(runtime.buildDir, 'retained-build'), 'owned evidence')
      child.execFileSync.mockImplementation((program: string, args: string[]) => {
        if (program !== 'docker') throw new Error('unexpected executable')
        if (args[0] === 'volume') {
          if (resource === 'supervisor-volume' && args[1] === 'create') throw error
          if (args[1] === 'ls') return ''
          return `${args[2]}\n`
        }
        if (args[0] === 'ps') return ''
        if (args[0] === 'run') throw error
        throw new Error('unexpected Docker operation')
      })
      const create = async () => {
        if (resource === 'web-lifetime-sentinel') return runtime.startWebLifetimeSentinel('watchdog')
        if (resource === 'foreign-sentinel') return runtime.createForeignSentinel({ scenarioId: 'watchdog' })
        return runtime.startSupervisor({ scenarioId: 'watchdog', waitForHealth: false })
      }

      await expect(create()).rejects.toThrow(error)
      const cleanup = await runtime.cleanup()

      expect(cleanup.ok).toBe(false)
      const subject = {
        supervisor: 'supervisor',
        'supervisor-volume': 'volume',
        'web-lifetime-sentinel': 'web lifetime sentinel',
        'foreign-sentinel': 'foreign sentinel',
      }[resource]
      expect(cleanup.errors.join('\n')).toContain(`creation completion was not observed for ${subject}`)
      expect(fs.readFileSync(path.join(runtime.buildDir, 'retained-build'), 'utf8')).toBe('owned evidence')
      const receipt = JSON.parse(fs.readFileSync(path.join(runtime.evidenceDir, 'cleanup.json'), 'utf8'))
      expect(receipt.ok).toBe(false)
      expect(receipt.errors).toEqual(cleanup.errors)
      expect(receipt.exactContainerIds).toEqual([])
      expect(child.spawnSync).not.toHaveBeenCalled()
      expect(child.execFileSync.mock.calls.some(([, args]) => args[0] === 'rm')).toBe(false)
    },
  )

  it('bounds the runtime compiler probe separately from Cargo builds', () => {
    const runtime = harness()
    const error = timedOut()
    child.execFileSync.mockImplementation((_program: string, args: string[]) => {
      if (args.includes('rustc')) return 'rustc fixture\n'
      throw error
    })

    expect(() => (runtime as unknown as { buildBinaries(): void }).buildBinaries()).toThrow(error)
    const probes = child.execFileSync.mock.calls.filter(([program]) => program.endsWith('/mise'))
    expect(probes).toHaveLength(1)
    expect(probes[0][2]).toMatchObject({ timeout: SYNC_PROBE_TIMEOUT_MS, killSignal: 'SIGKILL' })
    const builds = cargoWorkerCalls()
    expect(builds).toHaveLength(1)
    expect(cargoWorkerRequest(builds[0])).toMatchObject({
      command: expect.stringMatching(/[/\\]mise$/), args: expect.arrayContaining(['cargo', 'build']),
      timeoutMs: SYNC_BUILD_TIMEOUT_MS,
    })
    expect(fs.existsSync(runtime.testSupervisorBinary)).toBe(false)
  })

  it('bounds the owned Docker image build without treating interruption as success', () => {
    const runtime = harness(2)
    const error = timedOut()
    child.execFileSync.mockImplementation((program: string, args: string[], options?: { encoding?: string }) => {
      if (program === 'git') return gitResult(args, options)
      throw error
    })
    expect(() => (runtime as unknown as { ensureRuntimeImage(): void }).ensureRuntimeImage()).toThrow(error)
    expect(child.execFileSync).toHaveBeenLastCalledWith('docker', expect.arrayContaining(['build']), expect.objectContaining({
      timeout: SYNC_BUILD_TIMEOUT_MS, killSignal: 'SIGKILL',
    }))
    expect(runtime.imageRef).toBe('')
  })

  it.each(['buildManagedServer', 'buildQualificationSupervisor'] as const)(
    'bounds the managed Cargo build and rejects interrupted output: %s', method => {
      const browser = rig()
      const error = timedOut()
      child.execFileSync.mockImplementation((program: string, args: string[], options?: { encoding?: string }) => {
        if (program === 'git') return gitResult(args, options)
        throw error
      })
      const builders = browser as unknown as { buildManagedServer(): string; buildQualificationSupervisor(): string }
      expect(() => builders[method]()).toThrow(error)
      const builds = cargoWorkerCalls()
      expect(builds).toHaveLength(1)
      expect(cargoWorkerRequest(builds[0])).toMatchObject({
        command: expect.stringMatching(/[/\\]mise$/), args: expect.arrayContaining(['cargo', 'build']),
        timeoutMs: SYNC_BUILD_TIMEOUT_MS,
      })
    },
  )

  it('propagates MCP build interruption without accepting stale output', () => {
    const root = temporaryRoot()
    const bin = path.join(root, 'dist/tools/freshell-mcp/server.js')
    fs.mkdirSync(path.dirname(bin), { recursive: true })
    fs.writeFileSync(bin, '// stale artifact')
    const error = timedOut()
    child.spawnSync.mockReturnValue(interrupted(error))
    expect(() => ensureMcpServerBuilt(root)).toThrow(error)
    expect(child.spawnSync).toHaveBeenCalledExactlyOnceWith('fixture-manager', ['run', 'build:tools'], expect.objectContaining({
      timeout: SYNC_BUILD_TIMEOUT_MS, killSignal: 'SIGKILL',
    }))
  })

  it('propagates fallback Rust build interruption without accepting stale output', () => {
    const root = temporaryRoot()
    const bin = path.join(root, 'target/release/freshell-server')
    fs.mkdirSync(path.dirname(bin), { recursive: true })
    fs.writeFileSync(bin, 'stale artifact')
    const error = timedOut()
    child.execFileSync.mockImplementation(() => { throw error })
    expect(() => ensureRustServerBuilt(root)).toThrow(expect.objectContaining({ cause: error }))
    const builds = cargoWorkerCalls()
    expect(builds).toHaveLength(1)
    expect(cargoWorkerRequest(builds[0])).toMatchObject({
      command: 'cargo', args: expect.arrayContaining(['build', '--locked']), timeoutMs: SYNC_BUILD_TIMEOUT_MS,
    })
    expect(fs.readdirSync(path.join(root, '.runtime-build'))).toEqual([])
  })

  it('does not report an empty owned descendant tree when ps times out', () => {
    const error = timedOut()
    child.spawnSync.mockReturnValue(interrupted(error))
    expect(() => ownedDescendantPids(424242)).toThrow(error)
    expect(child.spawnSync).toHaveBeenCalledExactlyOnceWith('ps', ['-o', 'pid=', '--ppid', '424242'], expect.objectContaining({
      timeout: SYNC_PROBE_TIMEOUT_MS, killSignal: 'SIGKILL',
    }))
  })

  it.each(['stop', 'restartAbrupt'] as const)('retains the exact live server handle when the ownership scan fails: %s', async operation => {
    const server = new RustServer()
    const handle = Object.assign(new EventEmitter(), { pid: 424242 })
    const state = server as unknown as { process: typeof handle; homeDir: string; _info: object; boot(): Promise<unknown> }
    state.process = handle
    state.homeDir = temporaryRoot()
    state._info = { port: 1234, token: 'fixture' }
    const error = timedOut()
    child.spawnSync.mockReturnValue(interrupted(error))
    const signal = vi.spyOn(process, 'kill').mockImplementation((_pid, value) => {
      handle.emit('exit', 0, value)
      return true
    })
    vi.spyOn(state, 'boot').mockRejectedValue(new Error('unexpected boot after failed ownership scan'))

    await expect(server[operation]()).rejects.toThrow(error)
    expect(state.process).toBe(handle)
    expect(signal).not.toHaveBeenCalled()
  })

  it('retains web-server cleanup failure while still settling the managed runtime', async () => {
    const { browser, cleanup } = cleanupRigWithRetainedBuild()
    const error = timedOut()
    const stop = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce(undefined)
    const kill = vi.fn().mockResolvedValue(undefined)
    browser.web = { stop, kill } as unknown as typeof browser.web
    const result = await browser.stop()
    expect(stop).toHaveBeenCalledTimes(2)
    expect(kill).toHaveBeenCalledExactlyOnceWith('SIGKILL')
    expect(stop.mock.invocationCallOrder[0]).toBeLessThan(kill.mock.invocationCallOrder[0])
    expect(kill.mock.invocationCallOrder[0]).toBeLessThan(stop.mock.invocationCallOrder[1])
    expect(cleanup).toHaveBeenCalledExactlyOnceWith([`web stop: ${error.message}`])
    expect(result.ok).toBe(false)
    expect(result.errors).toEqual([`web stop: ${error.message}`])
    const receipt = JSON.parse(fs.readFileSync(path.join(browser.runtime.evidenceDir, 'cleanup.json'), 'utf8'))
    expect(receipt.ok).toBe(false)
    expect(receipt.errors).toEqual(result.errors)
    expect(fs.readFileSync(path.join(browser.runtime.buildDir, 'retained-build'), 'utf8')).toBe('owned evidence')
  })

  it('retains both web stop and forced-kill failures with the owned cleanup evidence', async () => {
    const { browser, cleanup } = cleanupRigWithRetainedBuild()
    const stopError = timedOut()
    const killError = new Error('owned web process could not be killed')
    const stop = vi.fn().mockRejectedValue(stopError)
    const kill = vi.fn().mockRejectedValue(killError)
    browser.web = { stop, kill } as unknown as typeof browser.web

    const result = await browser.stop()

    expect(stop).toHaveBeenCalledTimes(1)
    expect(kill).toHaveBeenCalledExactlyOnceWith('SIGKILL')
    expect(result.ok).toBe(false)
    expect(result.errors).toEqual([`web stop: ${stopError.message}`, `web stop: ${killError.message}`])
    expect(cleanup).toHaveBeenCalledExactlyOnceWith(result.errors)
    const receipt = JSON.parse(fs.readFileSync(path.join(browser.runtime.evidenceDir, 'cleanup.json'), 'utf8'))
    expect(receipt.ok).toBe(false)
    expect(receipt.errors).toEqual(result.errors)
    expect(fs.readFileSync(path.join(browser.runtime.buildDir, 'retained-build'), 'utf8')).toBe('owned evidence')
  })
})
