import type { ChildProcess } from 'node:child_process'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { createClaudeFixture } from '../providers/claude-local-provider.mjs'
import { waitForFixtureProcessExit } from '../../support/stop-fixture-process.js'

beforeAll(() => {
  const nativeRunner = (process.platform === 'win32' && process.env.RUNNER_OS === 'Windows')
    || (process.platform === 'darwin' && process.env.RUNNER_OS === 'macOS')
  expect(process.env.GITHUB_ACTIONS, 'destructive native checks require a disposable GitHub Actions runner').toBe('true')
  expect(process.env.RUNNER_ENVIRONMENT).toBe('github-hosted')
  expect(nativeRunner, 'run with native Windows or macOS Node; platform emulation does not qualify').toBe(true)
})

async function live(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0)
    if (process.platform === 'darwin') {
      const { stdout } = await promisify(execFile)('/bin/ps', ['-p', String(pid), '-o', 'stat='])
      return stdout.trim() !== '' && !/^[ZX]/.test(stdout.trim())
    }
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    if (process.platform === 'darwin' && (error as { code?: number }).code === 1) return false
    throw error
  }
}

async function waitUntil(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error('native fixture observation timed out')
    await delay(20)
  }
}

function observe(child: ChildProcess) {
  let stdout = ''
  child.stdout?.on('data', (data: Buffer) => { stdout += data.toString() })
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
  return { closed, stdout: () => stdout }
}

const MCP = `
  const fs = require('node:fs')
  const path = require('node:path')
  const [root, control] = process.argv.slice(1)
  fs.writeFileSync(path.join(control, 'mcp.pid'), String(process.pid))
  setInterval(() => {
    if (!fs.existsSync(path.join(control, 'release'))) return
    fs.mkdirSync(root, { recursive: true })
    fs.writeFileSync(path.join(root, 'late-mcp-write'), 'MCP survived cleanup')
    fs.writeFileSync(path.join(control, 'mcp.wrote'), 'yes')
  }, 5)
`
const WRITER = `
  const fs = require('node:fs')
  const path = require('node:path')
  const { spawn } = require('node:child_process')
  const [root, control, mcp, detached] = process.argv.slice(1)
  const child = spawn(process.execPath, ['-e', mcp, root, control], { stdio: 'ignore', detached: detached === 'true' })
  child.unref()
  fs.writeFileSync(path.join(control, 'writer.pid'), String(process.pid))
  setInterval(() => {
    if (!fs.existsSync(path.join(control, 'release'))) return
    fs.mkdirSync(root, { recursive: true })
    fs.writeFileSync(path.join(root, 'late-native-write'), 'native CLI survived cleanup')
    fs.writeFileSync(path.join(control, 'writer.wrote'), 'yes')
  }, 5)
`
const SIDECAR = `
  const fs = require('node:fs')
  const path = require('node:path')
  const { spawn } = require('node:child_process')
  const [root, control, mode, writer, mcp, detached = 'true'] = process.argv.slice(1)
  fs.writeFileSync(path.join(control, 'root.pid'), String(process.pid))
  const child = spawn(process.execPath, ['-e', writer, root, control, mcp, detached], { stdio: 'ignore', detached: detached === 'true' })
  child.unref()
  const ready = setInterval(() => {
    if (!fs.existsSync(path.join(control, 'writer.pid')) || !fs.existsSync(path.join(control, 'mcp.pid'))) return
    clearInterval(ready)
    if (mode === 'create-failed') process.exit(2)
    else {
      fs.writeFileSync(path.join(control, 'ready'), 'yes')
      process.stdout.write(JSON.stringify({ type: 'created', pid: process.pid, cliPid: child.pid }) + '\\n', () => {
        if (mode === 'clean') process.exit(0)
        else setInterval(() => {}, 1000)
      })
    }
  }, 5)
`

describe('native Claude fixture process ownership', () => {
  it('closes a root-only process stream while its Windows Job host remains alive', async () => {
    const fixture = await createClaudeFixture()
    const child = fixture.spawn(process.execPath, ['-e', 'process.stdout.write("root finished\\n", () => process.exit(0))'], { stdio: 'pipe' })
    const hostPid = (child as ChildProcess & { fixtureHostPid?: number }).fixtureHostPid
    child.stderr!.resume()
    const output = observe(child)
    let closed = false
    void output.closed.then(() => { closed = true })
    try {
      await waitUntil(async () => closed)
      expect(child.exitCode).toBe(0)
      expect(output.stdout()).toBe('root finished\n')
      if (process.platform === 'win32') {
        expect(Number.isInteger(hostPid)).toBe(true)
        expect(await live(hostPid!)).toBe(true)
      }
      await fixture.cleanup()
      if (process.platform === 'win32') {
        expect(await live(hostPid!)).toBe(false)
      }
    } finally {
      await fixture.cleanup()
    }
  })

  const exitModes = [
    ['clean', 'a clean sidecar exit'],
    ['create-failed', 'creation fails without a created frame'],
    ['hard-killed', 'the sidecar is killed with SIGKILL'],
  ] as const
  const scenarios = (process.platform === 'win32' ? [true] : [false, true]).flatMap((detached) =>
    exitModes.map(([mode, description]) => ({ detached, mode, description })),
  )
  for (const { detached, mode, description } of scenarios) {
    it(`contains ${detached ? 'detached' : 'grouped'} CLI and MCP descendants after ${description}`, async () => {
      const control = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-native-tree-'))
      const fixture = await createClaudeFixture({ parent: control })
      const other = await createClaudeFixture({ parent: control })
      const unrelatedReport = path.join(control, 'unrelated.pid')
      const unrelated = other.spawn(process.execPath, ['-e', `require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)`, unrelatedReport], { stdio: 'ignore' })
      const sidecar = fixture.spawn(process.execPath, ['-e', SIDECAR, fixture.root, control, mode, WRITER, MCP, String(detached)], {
        cwd: fixture.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      sidecar.stderr!.on('data', () => {})
      const output = observe(sidecar)
      try {
        await waitUntil(async () => fs.stat(unrelatedReport).then(() => true, () => false))
        const unrelatedPid = Number(await fs.readFile(unrelatedReport, 'utf8'))
        expect(unrelated.pid).toBe(unrelatedPid)
        if (mode === 'hard-killed') {
          await waitUntil(async () => fs.stat(path.join(control, 'ready')).then(() => true, () => false))
          expect(sidecar.kill('SIGKILL')).toBe(true)
        }
        // Root exit precedes stream closure when a descendant still holds a
        // stream. Join the full tree before requiring drained/closed stdio.
        await waitForFixtureProcessExit(sidecar, 15_000)
        const rootPid = Number(await fs.readFile(path.join(control, 'root.pid'), 'utf8'))
        const writerPid = Number(await fs.readFile(path.join(control, 'writer.pid'), 'utf8'))
        const mcpPid = Number(await fs.readFile(path.join(control, 'mcp.pid'), 'utf8'))
        expect(sidecar.pid, 'ChildProcess.pid must identify the actual root process').toBe(rootPid)
        expect(await live(writerPid)).toBe(true)
        expect(await live(mcpPid)).toBe(true)
        if (process.platform === 'darwin') {
          const { stdout } = await promisify(execFile)('/bin/ps', ['-p', `${writerPid},${mcpPid}`, '-o', 'pid=,ppid=,pgid='])
          const processes = new Map(stdout.trim().split('\n').map((line) => {
            const [pid, parent, group] = line.trim().split(/\s+/).map(Number)
            return [pid, { parent, group }] as const
          }))
          expect(processes.get(writerPid)?.parent, 'writer must be reparented after its root exits').not.toBe(rootPid)
          expect(processes.get(writerPid)?.group).toBe(detached ? writerPid : rootPid)
          expect(processes.get(mcpPid)?.group).toBe(detached ? mcpPid : rootPid)
        }
        if (mode === 'clean') {
          expect(sidecar.exitCode).toBe(0)
          expect(sidecar.signalCode).toBeNull()
        } else if (mode === 'create-failed') {
          expect(sidecar.exitCode).toBe(2)
        } else {
          expect(await live(rootPid)).toBe(false)
        }

        await fixture.cleanup()
        await output.closed
        if (mode === 'clean') {
          expect(JSON.parse(output.stdout().trim())).toEqual({ type: 'created', pid: rootPid, cliPid: writerPid })
        } else if (mode === 'create-failed') {
          expect(output.stdout()).toBe('')
        }
        const writerAlive = await live(writerPid)
        const mcpAlive = await live(mcpPid)
        await fs.writeFile(path.join(control, 'release'), 'go')
        if (writerAlive) await waitUntil(async () => fs.stat(path.join(control, 'writer.wrote')).then(() => true, () => false))
        if (mcpAlive) await waitUntil(async () => fs.stat(path.join(control, 'mcp.wrote')).then(() => true, () => false))
        await delay(100)
        const recreated = await fs.stat(fixture.root).then(() => true, () => false)

        expect({ writerAlive, mcpAlive, recreated }).toEqual({ writerAlive: false, mcpAlive: false, recreated: false })
        expect(await live(unrelatedPid)).toBe(true)
      } finally {
        await fixture.cleanup()
        // The red regression deliberately leaves detached descendants alive.
        // Settle only PIDs reported by this fixture before discarding controls.
        for (const report of ['writer.pid', 'mcp.pid']) {
          const pid = Number(await fs.readFile(path.join(control, report), 'utf8').catch(() => ''))
          if (Number.isSafeInteger(pid) && pid > 0 && await live(pid)) {
            process.kill(pid, 'SIGKILL')
            await waitUntil(async () => !await live(pid))
          }
        }
        await other.cleanup()
        await fs.rm(control, { recursive: true, force: true })
      }
    })
  }

  if (process.platform === 'win32') {
    it('reports abrupt Job host death and releases its controller without a polling leak', async () => {
      const control = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-abrupt-job-'))
      const fixtureModule = new URL('../providers/claude-local-provider.mjs', import.meta.url).href
      const controller = spawn(process.execPath, ['--input-type=module', '-e', `
        import fs from 'node:fs/promises'
        import path from 'node:path'
        import { setTimeout as delay } from 'node:timers/promises'
        const [moduleUrl, control, sidecar, writer, mcp] = process.argv.slice(1)
        const { createClaudeFixture } = await import(moduleUrl)
        const fixture = await createClaudeFixture({ parent: control })
        const child = fixture.spawn(process.execPath, ['-e', sidecar, fixture.root, control, 'hard-killed', writer, mcp], { stdio: 'pipe' })
        const events = []
        let failure
        child.on('error', (error) => { failure = error.message; events.push('error') })
        child.on('exit', () => events.push('exit'))
        const closed = new Promise(resolve => child.once('close', () => { events.push('close'); resolve() }))
        child.stdout.resume()
        child.stderr.resume()
        while (!await fs.stat(path.join(control, 'ready')).then(() => true, () => false)) await delay(20)
        const pids = await Promise.all(['root.pid', 'writer.pid', 'mcp.pid'].map(async file => Number(await fs.readFile(path.join(control, file), 'utf8'))))
        for (const pid of [child.fixtureHostPid, ...pids]) process.kill(pid, 0)
        await fs.writeFile(path.join(control, 'controller-ready.json'), JSON.stringify({ pid: process.pid, root: fixture.root, hostPid: child.fixtureHostPid, rootPid: child.pid }))
        process.kill(child.fixtureHostPid, 'SIGKILL')
        await closed
        await fs.writeFile(path.join(control, 'controller-done.json'), JSON.stringify({ events, failure, exitCode: child.exitCode, signalCode: child.signalCode }))
        // Deliberately omit cleanup and process.exit. After terminal error,
        // closed pipes and a stopped poller must let Node finish naturally.
      `, fixtureModule, control, SIDECAR, WRITER, MCP], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
      const output = observe(controller)
      let stderr = ''
      controller.stderr!.on('data', (data: Buffer) => { stderr += data.toString() })
      let ownedPids: number[] | undefined
      try {
        await waitUntil(async () => {
          if (await fs.stat(path.join(control, 'controller-ready.json')).then(() => true, () => false)) return true
          if (controller.exitCode !== null || controller.signalCode !== null) throw new Error(`abrupt-host controller exited before readiness: ${stderr}`)
          return false
        })
        const metadata = JSON.parse(await fs.readFile(path.join(control, 'controller-ready.json'), 'utf8')) as { pid: number; root: string; hostPid: number; rootPid: number }
        expect(controller.pid).toBe(metadata.pid)
        ownedPids = [metadata.hostPid, ...await Promise.all(['root.pid', 'writer.pid', 'mcp.pid'].map(async (file) => Number(await fs.readFile(path.join(control, file), 'utf8'))))]
        expect(metadata.rootPid).toBe(ownedPids[1])
        expect(new Set(ownedPids).size).toBe(4)
        await waitUntil(async () => fs.stat(path.join(control, 'controller-done.json')).then(() => true, () => false))
        await waitUntil(async () => controller.exitCode !== null || controller.signalCode !== null)
        await output.closed
        expect(controller.exitCode, stderr).toBe(0)
        expect(controller.signalCode).toBeNull()
        const result = JSON.parse(await fs.readFile(path.join(control, 'controller-done.json'), 'utf8'))
        expect(result).toMatchObject({ events: ['error', 'close'], exitCode: null, signalCode: null })
        expect(result.failure).toContain('fixture Job host exited without confirming its process tree')
        await waitUntil(async () => (await Promise.all(ownedPids!.map(live))).every((running) => !running))
        await expect(fs.stat(metadata.root)).resolves.toBeDefined()
        const directory = (await fs.readdir(metadata.root)).find((entry) => entry.startsWith('.process-job-'))!
        const status = JSON.parse(await fs.readFile(path.join(metadata.root, directory, 'status.json'), 'utf8'))
        expect(status).toMatchObject({ pid: metadata.rootPid, rootExited: false, settled: false })
      } finally {
        if (controller.exitCode === null && controller.signalCode === null) controller.kill('SIGKILL')
        if (ownedPids !== undefined) {
          for (const pid of ownedPids) if (await live(pid)) process.kill(pid, 'SIGKILL')
          await waitUntil(async () => (await Promise.all(ownedPids!.map(live))).every((running) => !running))
        }
        await output.closed
        if (ownedPids !== undefined) await fs.rm(control, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      }
    })

    it('stops later launches after an earlier owned target refuses termination', async () => {
      const fixture = await createClaudeFixture()
      const other = await createClaudeFixture()
      const spawnTarget = (owner: typeof fixture, name: string) => owner.spawn(process.execPath, ['-e', `require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)`, path.join(owner.root, name)], { stdio: 'ignore' })
      const first = spawnTarget(fixture, 'first.pid')
      const second = spawnTarget(fixture, 'second.pid')
      const unrelated = spawnTarget(other, 'unrelated.pid')
      let denied: { mockRestore(): void } | undefined
      try {
        await waitUntil(async () => (await Promise.all([
          path.join(fixture.root, 'first.pid'), path.join(fixture.root, 'second.pid'), path.join(other.root, 'unrelated.pid'),
        ].map((file) => fs.stat(file).then(() => true, () => false)))).every(Boolean))
        expect(await live(first.pid!)).toBe(true)
        expect(await live(second.pid!)).toBe(true)
        expect(await live(unrelated.pid!)).toBe(true)
        denied = vi.spyOn(first, 'kill').mockImplementation(() => { throw Object.assign(new Error('first target refuses termination'), { code: 'EPERM' }) })

        const failure = await fixture.cleanup().then(() => undefined, (error: unknown) => error)
        const causes: Error[] = []
        for (let cause = failure; cause instanceof Error; cause = cause.cause) causes.push(cause)
        expect(causes).toContainEqual(expect.objectContaining({ code: 'EPERM' }))
        expect(await live(first.pid!)).toBe(true)
        expect(await live(second.pid!)).toBe(false)
        expect(await live((second as ChildProcess & { fixtureHostPid: number }).fixtureHostPid)).toBe(false)
        expect(await live(unrelated.pid!)).toBe(true)
        await expect(fs.stat(fixture.root)).resolves.toBeDefined()
      } finally {
        denied?.mockRestore()
        await fixture.cleanup()
        await other.cleanup()
      }
    })

    it('closes after a terminal Job host failure with a target PID and retains unconfirmed fixture files', async () => {
      const fixture = await createClaudeFixture()
      const report = path.join(fixture.root, 'started.pid')
      const child = fixture.spawn(process.execPath, ['-e', `require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)`, report], {
        env: fixture.env('http://127.0.0.1:9'), stdio: 'pipe',
      })
      const hostPid = (child as ChildProcess & { fixtureHostPid?: number }).fixtureHostPid
      const events: string[] = []
      let hostFailure: Error | undefined
      let closed = false
      child.on('error', (error: Error) => { hostFailure = error; events.push('error') })
      child.on('exit', () => events.push('exit'))
      child.on('close', () => { closed = true; events.push('close') })
      child.stdout!.resume()
      child.stderr!.resume()
      try {
        await waitUntil(async () => fs.stat(report).then(() => true, () => false))
        const rootPid = Number(await fs.readFile(report, 'utf8'))
        expect(child.pid).toBe(rootPid)
        expect(await live(rootPid)).toBe(true)
        expect(await live(hostPid!)).toBe(true)

        // The real host rejects this control message after target startup.
        // It drops the Job, reports an error with the allocated PID, and
        // cannot claim a root-exit or full-tree settlement observation.
        expect(child.kill('SIGUSR1')).toBe(true)
        await waitUntil(async () => hostFailure !== undefined)
        expect(hostFailure?.message).toContain('unsupported fixture root termination signal')
        await waitUntil(async () => closed)
        expect(events).toEqual(['error', 'close'])
        expect(child.exitCode).toBeNull()
        expect(child.signalCode).toBeNull()
        await waitUntil(async () => !await live(rootPid) && !await live(hostPid!))

        await expect(fixture.cleanup()).rejects.toThrow('unsupported fixture root termination signal')
        await expect(fs.stat(fixture.root)).resolves.toBeDefined()
        const sessionDirectory = (await fs.readdir(fixture.root)).find((entry) => entry.startsWith('.process-job-'))
        expect(sessionDirectory).toBeDefined()
        const status = JSON.parse(await fs.readFile(path.join(fixture.root, sessionDirectory!, 'status.json'), 'utf8'))
        expect(status).toMatchObject({ pid: rootPid, rootExited: false, settled: false })
      } finally {
        // This one-target fixture deliberately retains an error receipt.
        // Delete it only after exact target and Job-host OS exits, even red.
        await fixture.cleanup().catch(() => {})
        const ownedPids = [child.pid, hostPid].filter((pid): pid is number => Number.isSafeInteger(pid) && pid! > 0)
        for (const pid of ownedPids) if (await live(pid)) process.kill(pid, 'SIGKILL')
        await waitUntil(async () => (await Promise.all(ownedPids.map(live))).every((running) => !running))
        child.stdin?.destroy()
        child.stdout?.destroy()
        child.stderr?.destroy()
        await fs.rm(fixture.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      }
    })

    it('settles the Job host and its process tree when the owning Node controller exits without cleanup', async () => {
      const control = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-abandoned-job-'))
      const fixtureModule = new URL('../providers/claude-local-provider.mjs', import.meta.url).href
      const controller = spawn(process.execPath, ['--input-type=module', '-e', `
        import fs from 'node:fs/promises'
        import path from 'node:path'
        import { setTimeout as delay } from 'node:timers/promises'
        const [moduleUrl, control, sidecar, writer, mcp] = process.argv.slice(1)
        const { createClaudeFixture } = await import(moduleUrl)
        const fixture = await createClaudeFixture({ parent: control })
        const child = fixture.spawn(process.execPath, ['-e', sidecar, fixture.root, control, 'hard-killed', writer, mcp], { stdio: 'ignore' })
        child.on('error', (error) => { process.stderr.write(String(error)); process.exit(2) })
        while (!await fs.stat(path.join(control, 'ready')).then(() => true, () => false)) await delay(20)
        await fs.writeFile(path.join(control, 'owner.pid'), String(child.fixtureHostPid))
        await fs.writeFile(path.join(control, 'controller-ready.json'), JSON.stringify({ pid: process.pid, root: fixture.root }))
        while (!await fs.stat(path.join(control, 'exit-controller')).then(() => true, () => false)) await delay(20)
        // Deliberately omit fixture.cleanup(): the Job host's owner-process
        // watch must end the entire tree and then the host itself.
        process.exit(0)
      `, fixtureModule, control, SIDECAR, WRITER, MCP], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
      const output = observe(controller)
      let stderr = ''
      controller.stderr!.on('data', (data: Buffer) => { stderr += data.toString() })
      let ownedPids: number[] | undefined
      try {
        await waitUntil(async () => {
          if (controller.exitCode !== null || controller.signalCode !== null) throw new Error(`native controller exited before readiness: ${stderr}`)
          return fs.stat(path.join(control, 'controller-ready.json')).then(() => true, () => false)
        })
        const metadata = JSON.parse(await fs.readFile(path.join(control, 'controller-ready.json'), 'utf8')) as { pid: number; root: string }
        expect(controller.pid).toBe(metadata.pid)
        const reportedPids = await Promise.all(['owner.pid', 'root.pid', 'writer.pid', 'mcp.pid'].map(async (file) => Number(await fs.readFile(path.join(control, file), 'utf8'))))
        expect(reportedPids.every((pid) => Number.isSafeInteger(pid) && pid > 0)).toBe(true)
        ownedPids = reportedPids
        expect(new Set(ownedPids).size).toBe(4)
        expect(await Promise.all(ownedPids.map(live))).toEqual([true, true, true, true])

        await fs.writeFile(path.join(control, 'exit-controller'), 'exit without cleanup')
        await output.closed
        expect(controller.exitCode).toBe(0)
        expect(controller.signalCode).toBeNull()
        await waitUntil(async () => (await Promise.all(ownedPids!.map(live))).every((running) => !running))
        expect(await Promise.all(ownedPids.map(live))).toEqual([false, false, false, false])
      } finally {
        if (controller.exitCode === null && controller.signalCode === null) controller.kill('SIGKILL')
        await output.closed
        if (ownedPids !== undefined) {
          // Retain all evidence if any real process survives. Only confirmed
          // exits permit removing the abandoned fixture and control files.
          await waitUntil(async () => (await Promise.all(ownedPids!.map(live))).every((running) => !running))
          await fs.rm(control, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
        }
      }
    })
  }

  it('settles a genuine executable startup failure before removing the fixture', async () => {
    const fixture = await createClaudeFixture()
    const child = fixture.spawn(path.join(fixture.root, 'missing-executable'), [], { stdio: 'pipe' })
    const error = once(child, 'error')
    const output = observe(child)
    try {
      expect((await error)[0]).toBeInstanceOf(Error)
      await output.closed
      await fixture.cleanup()
      await expect(fs.stat(fixture.root)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await fixture.cleanup()
    }
  })

  it('retains files when permission refusal prevents confirmed teardown', async () => {
    const fixture = await createClaudeFixture()
    const report = path.join(fixture.root, 'own.pid')
    const child = fixture.spawn(process.execPath, ['-e', `require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)`, report], { stdio: 'ignore' })
    const originalKill = process.kill
    let denied: { mockRestore(): void } | undefined
    try {
      await waitUntil(async () => fs.stat(report).then(() => true, () => false))
      const rootPid = Number(await fs.readFile(report, 'utf8'))
      denied = process.platform === 'win32'
        ? vi.spyOn(child, 'kill').mockImplementation(() => { throw Object.assign(new Error('native fixture teardown denied'), { code: 'EPERM' }) })
        : vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
          if (pid === -rootPid && signal === 'SIGTERM') throw Object.assign(new Error('native fixture teardown denied'), { code: 'EPERM' })
          return originalKill(pid, signal)
        })
      expect(child.pid).toBe(rootPid)
      const refusal = await fixture.cleanup().then(() => undefined, (error: unknown) => error)
      const causes: Error[] = []
      for (let cause = refusal; cause instanceof Error; cause = cause.cause) causes.push(cause)
      expect(causes).toContainEqual(expect.objectContaining({ code: 'EPERM' }))
      await expect(fs.stat(fixture.root)).resolves.toBeDefined()
      expect(await live(rootPid)).toBe(true)
    } finally {
      denied?.mockRestore()
      await fixture.cleanup()
    }
  })

  if (process.platform === 'darwin') {
    it('excludes its inspector when the caller adopts the fixture environment', async () => {
      const fixture = await createClaudeFixture()
      const key = 'FRESHELL_CLAUDE_FIXTURE_OWNER'
      const original = process.env[key]
      const environment = fixture.env('http://127.0.0.1:9')
      try {
        expect(environment[key]).toBeTruthy()
        process.env[key] = environment[key]
        const child = fixture.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
        await fixture.cleanup()
        expect(await live(child.pid!)).toBe(false)
        await expect(fs.stat(fixture.root)).rejects.toMatchObject({ code: 'ENOENT' })
      } finally {
        if (original === undefined) delete process.env[key]
        else process.env[key] = original
        await fixture.cleanup()
      }
    })

    it('retains files when an orphaned detached writer refuses termination', async () => {
      const control = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-native-detached-refusal-'))
      const fixture = await createClaudeFixture({ parent: control })
      const sidecar = fixture.spawn(process.execPath, ['-e', SIDECAR, fixture.root, control, 'create-failed', WRITER, MCP, 'true'], { stdio: 'ignore' })
      const originalKill = process.kill
      let denied: { mockRestore(): void } | undefined
      try {
        await waitForFixtureProcessExit(sidecar, 15_000)
        const writerPid = Number(await fs.readFile(path.join(control, 'writer.pid'), 'utf8'))
        denied = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
          if (pid === writerPid && signal === 'SIGTERM') throw Object.assign(new Error('detached writer teardown denied'), { code: 'EPERM' })
          return originalKill(pid, signal)
        })
        await expect(fixture.cleanup()).rejects.toMatchObject({ code: 'EPERM' })
        await expect(fs.stat(fixture.root)).resolves.toBeDefined()
        expect(await live(writerPid)).toBe(true)
      } finally {
        denied?.mockRestore()
        await fixture.cleanup()
        await fs.rm(control, { recursive: true, force: true })
      }
    })

    it('uses the native process table after a refused signal-zero probe', async () => {
      const fixture = await createClaudeFixture()
      const child = fixture.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
      const originalKill = process.kill
      const denied = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
        if (pid === -child.pid! && signal === 0) throw Object.assign(new Error('probe refused'), { code: 'EPERM' })
        return originalKill(pid, signal)
      })
      try {
        await fixture.cleanup()
        expect(await live(child.pid!)).toBe(false)
        await expect(fs.stat(fixture.root)).rejects.toMatchObject({ code: 'ENOENT' })
      } finally {
        denied.mockRestore()
        await fixture.cleanup()
      }
    })
  }
})
