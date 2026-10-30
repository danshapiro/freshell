import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it, vi } from 'vitest'
import { createClaudeFixture } from '../providers/claude-local-provider.mjs'
import { stopFixtureProcess, waitForFixtureProcessExit } from '../../support/stop-fixture-process.js'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const IN_CONTAINER = existsSync('/.dockerenv') || existsSync('/run/.containerenv')

async function runInSandbox(): Promise<void> {
  const result = await promisify(execFile)('bash', [
    path.join(REPO_ROOT, 'scripts/sandbox-test.sh'),
    'pnpm run test:vitest run test/integration/tooling/claude-fixture-processes.test.ts --config config/vitest/vitest.runtime.config.ts',
  ], { cwd: REPO_ROOT, timeout: 540_000, maxBuffer: 1024 * 1024 }).catch((error: Error & { stdout?: string; stderr?: string }) => {
    throw new Error(`Claude fixture lifecycle sandbox failed:\n${error.stdout ?? ''}\n${error.stderr ?? ''}`, { cause: error })
  })
  process.stdout.write(result.stdout)
  process.stderr.write(result.stderr)
}

async function live(pid: number): Promise<boolean> {
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8')
    return !['Z', 'X'].includes(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0]!)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function waitUntil(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error('fixture process observation timed out')
    await delay(10)
  }
}

const MCP = `
  const fs = require('node:fs')
  const path = require('node:path')
  const [root, control] = process.argv.slice(1)
  fs.writeFileSync(path.join(control, 'mcp.pid'), String(process.pid))
  setInterval(() => {
    if (!fs.existsSync(path.join(control, 'release'))) return
    fs.mkdirSync(root, { recursive: true })
    fs.writeFileSync(path.join(root, 'late-mcp-write'), 'written after sidecar exit')
    fs.writeFileSync(path.join(control, 'mcp.wrote'), 'yes')
  }, 5)
`
const WRITER = `
  const fs = require('node:fs')
  const path = require('node:path')
  const { spawn } = require('node:child_process')
  const [root, control, resistTerm, mcp, detached] = process.argv.slice(1)
  const child = spawn(process.execPath, ['-e', mcp, root, control], { stdio: 'ignore', detached: detached === 'true' })
  child.unref()
  if (resistTerm === 'true') process.on('SIGTERM', () => {})
  fs.writeFileSync(path.join(control, 'native.pid'), String(process.pid))
  setInterval(() => {
    if (!fs.existsSync(path.join(control, 'release'))) return
    fs.mkdirSync(root, { recursive: true })
    fs.writeFileSync(path.join(root, 'late-native-write'), 'written after sidecar exit')
    fs.writeFileSync(path.join(control, 'wrote'), 'yes')
  }, 5)
`
const SIDECAR = `
  const fs = require('node:fs')
  const path = require('node:path')
  const { spawn } = require('node:child_process')
  const [root, control, mode, writer, mcp, detached] = process.argv.slice(1)
  const child = spawn(process.execPath, ['-e', writer, root, control, String(mode === 'clean'), mcp, detached], { stdio: 'ignore', detached: detached === 'true' })
  child.unref()
  const ready = setInterval(() => {
    if (!fs.existsSync(path.join(control, 'native.pid')) || !fs.existsSync(path.join(control, 'mcp.pid'))) return
    clearInterval(ready)
    if (mode === 'clean') process.stdout.write(JSON.stringify({ type: 'created', cliPid: child.pid }) + '\\n')
    if (mode === 'hard-killed') {
      fs.writeFileSync(path.join(control, 'ready'), 'yes')
      setInterval(() => {}, 1000)
    } else process.exit(mode === 'clean' ? 0 : 2)
  }, 5)
`

describe('Claude fixture native process ownership', () => {
  if (!IN_CONTAINER) {
    // Ordinary source-runtime invocations keep their usual host behavior;
    // only these process-kill checks move into the disposable sandbox.
    it('runs its native process lifecycle checks in a disposable sandbox', runInSandbox, 600_000)
    return
  }

  const scenarios = [false, true].flatMap((detached) =>
    (['clean', 'create-failed', 'hard-killed'] as const).map((mode) => ({ detached, mode })),
  )
  for (const { detached, mode } of scenarios) {
    it(`stops ${detached ? 'detached' : 'grouped'} CLI and MCP descendants after ${mode} sidecar exit`, async () => {
      const control = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-native-owner-'))
      const fixture = await createClaudeFixture({ parent: control })
      const other = await createClaudeFixture({ parent: control })
      const unrelated = other.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
      const sidecar = fixture.spawn(process.execPath, ['-e', SIDECAR, fixture.root, control, mode, WRITER, MCP, String(detached)], {
        cwd: fixture.cwd,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      let stdout = ''
      sidecar.stdout!.on('data', (data: Buffer) => { stdout += data.toString() })
      const closed = new Promise<void>((resolve) => sidecar.once('close', () => resolve()))
      const descendants: number[] = []
      try {
        if (mode === 'hard-killed') {
          await waitUntil(async () => fs.stat(path.join(control, 'ready')).then(() => true, () => false))
          expect(sidecar.kill('SIGKILL')).toBe(true)
        }
        await waitForFixtureProcessExit(sidecar, 5_000)
        const nativePid = Number(await fs.readFile(path.join(control, 'native.pid'), 'utf8'))
        const mcpPid = Number(await fs.readFile(path.join(control, 'mcp.pid'), 'utf8'))
        descendants.push(nativePid, mcpPid)
        expect(await Promise.all(descendants.map(live))).toEqual([true, true])
        const nativeStat = await fs.readFile(`/proc/${nativePid}/stat`, 'utf8')
        const [, parent, group] = nativeStat.slice(nativeStat.lastIndexOf(')') + 2).trim().split(/\s+/)
        const mcpStat = await fs.readFile(`/proc/${mcpPid}/stat`, 'utf8')
        const [, , mcpGroup] = mcpStat.slice(mcpStat.lastIndexOf(')') + 2).trim().split(/\s+/)
        expect(Number(parent), 'writer must outlive and be reparented from its root').not.toBe(sidecar.pid)
        expect(Number(group)).toBe(detached ? nativePid : sidecar.pid)
        expect(Number(mcpGroup)).toBe(detached ? mcpPid : sidecar.pid)
        if (mode === 'clean') {
          expect(sidecar.exitCode).toBe(0)
          expect(sidecar.signalCode).toBeNull()
        } else if (mode === 'create-failed') {
          expect(sidecar.exitCode).toBe(2)
        } else {
          expect(sidecar.signalCode).toBe('SIGKILL')
        }

        await fixture.cleanup()
        await closed
        if (mode === 'clean') expect(JSON.parse(stdout.trim())).toEqual({ type: 'created', cliPid: nativePid })
        else expect(stdout).toBe('')
        const writerAlive = await live(nativePid)
        const mcpAlive = await live(mcpPid)
        // A survivor is released only after cleanup, so its write must happen
        // after deletion, independently of filesystem traversal timing.
        await fs.writeFile(path.join(control, 'release'), 'go')
        if (writerAlive) await waitUntil(async () => fs.stat(path.join(control, 'wrote')).then(() => true, () => false))
        if (mcpAlive) await waitUntil(async () => fs.stat(path.join(control, 'mcp.wrote')).then(() => true, () => false))
        await delay(50)
        const recreated = await fs.stat(fixture.root).then(() => true, () => false)

        expect({ writerAlive, mcpAlive, recreated }).toEqual({ writerAlive: false, mcpAlive: false, recreated: false })
        expect(await live(unrelated.pid!)).toBe(true)
      } finally {
        await stopFixtureProcess(sidecar)
        for (const pid of descendants) {
          if (await live(pid)) {
            process.kill(pid, 'SIGKILL')
            await waitUntil(async () => !await live(pid))
          }
        }
        await fixture.cleanup()
        await other.cleanup()
        await fs.rm(control, { recursive: true, force: true })
      }
    })
  }

  it('retains the fixture if its owned process group cannot be signalled', async () => {
    const fixture = await createClaudeFixture()
    const child = fixture.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    const realKill = process.kill
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid === -child.pid! && signal === 'SIGTERM') throw Object.assign(new Error('refused fixture signal'), { code: 'EPERM' })
      return realKill(pid, signal)
    })
    try {
      await expect(fixture.cleanup()).rejects.toMatchObject({ code: 'EPERM' })
      await expect(fs.stat(fixture.root)).resolves.toBeDefined()
      expect(await live(child.pid!)).toBe(true)
    } finally {
      kill.mockRestore()
      await fixture.cleanup()
    }
  })

  it('retains the fixture if an orphaned detached writer cannot be signalled', async () => {
    const control = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-detached-refusal-'))
    const fixture = await createClaudeFixture({ parent: control })
    const sidecar = fixture.spawn(process.execPath, ['-e', SIDECAR, fixture.root, control, 'create-failed', WRITER, MCP, 'true'], { stdio: 'ignore' })
    const originalKill = process.kill
    let denied: { mockRestore(): void } | undefined
    try {
      await waitForFixtureProcessExit(sidecar, 5_000)
      const writerPid = Number(await fs.readFile(path.join(control, 'native.pid'), 'utf8'))
      denied = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
        if (pid === writerPid && signal === 'SIGTERM') throw Object.assign(new Error('refused detached writer signal'), { code: 'EPERM' })
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

  it('inspects group membership when a signal-zero permission probe is refused', async () => {
    const fixture = await createClaudeFixture()
    const child = fixture.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    const originalKill = process.kill
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid === -child.pid! && signal === 0) throw Object.assign(new Error('permission probe refused'), { code: 'EPERM' })
      return originalKill(pid, signal)
    })
    try {
      await expect(fixture.cleanup()).resolves.toBeUndefined()
      expect(await live(child.pid!)).toBe(false)
      await expect(fs.stat(fixture.root)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      kill.mockRestore()
      await fixture.cleanup()
    }
  })

  it('cleans an owned process without exhausting descriptors while inspecting a large process table', async () => {
    const fixture = await createClaudeFixture()
    const child = fixture.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    const readdir = fs.readdir
    const readFile = fs.readFile
    let activeReads = 0
    let inspected = false
    // Repeating a real procfs row exercises hundreds of actual stat opens
    // without creating hundreds of disposable native processes.
    const directory = vi.spyOn(fs, 'readdir').mockImplementation(async (...args) => {
      if (args[0] === '/proc') return Array.from({ length: 512 }, () => String(child.pid!))
      return Reflect.apply(readdir, fs, args)
    })
    const descriptors = vi.spyOn(fs, 'readFile').mockImplementation(async (file, options) => {
      if (file !== `/proc/${child.pid!}/stat`) return readFile(file, options)
      inspected = true
      if (activeReads >= 64) throw Object.assign(new Error('fixture process inspection exhausted open files'), { code: 'EMFILE' })
      activeReads += 1
      try {
        const result = await readFile(file, options)
        await delay(2)
        return result
      } finally {
        activeReads -= 1
      }
    })
    try {
      await expect(fixture.cleanup()).resolves.toBeUndefined()
      expect(inspected).toBe(true)
      expect(await live(child.pid!)).toBe(false)
      await expect(fs.stat(fixture.root)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      descriptors.mockRestore()
      directory.mockRestore()
      await waitUntil(async () => activeReads === 0)
      await fixture.cleanup()
    }
  })

  it('retries an environment refusal while the process is still finishing its exit', async () => {
    const control = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-procfs-pending-exit-'))
    const fixture = await createClaudeFixture({ parent: control })
    const other = await createClaudeFixture({ parent: control })
    const root = fixture.spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' })
    const child = other.spawn(process.execPath, ['-e', `
      const fs = require('node:fs')
      const path = require('node:path')
      const control = process.argv[1]
      let stopping = false
      process.on('SIGTERM', () => {
        stopping = true
        fs.writeFileSync(path.join(control, 'terminating'), 'yes')
      })
      fs.writeFileSync(path.join(control, 'ready'), 'yes')
      setInterval(() => {
        if (stopping && fs.existsSync(path.join(control, 'release'))) process.exit(0)
      }, 5)
    `, control], { stdio: 'ignore' })
    const readFile = fs.readFile
    let attempts = 0
    let stopping: Promise<void> | undefined
    let denied: { mockRestore(): void } | undefined
    try {
      await waitForFixtureProcessExit(root, 5_000)
      await waitUntil(async () => fs.stat(path.join(control, 'ready')).then(() => true, () => false))
      denied = vi.spyOn(fs, 'readFile').mockImplementation(async (file, options) => {
        if (file === `/proc/${child.pid!}/environ`) {
          attempts += 1
          if (attempts === 1) {
            stopping = stopFixtureProcess(child)
            await waitUntil(async () => fs.stat(path.join(control, 'terminating')).then(() => true, () => false))
            expect(await live(child.pid!)).toBe(true)
          } else {
            await fs.writeFile(path.join(control, 'release'), 'go')
          }
          throw Object.assign(new Error('process environment is unreadable while exiting'), { code: 'EACCES' })
        }
        return readFile(file, options)
      })
      await expect(fixture.cleanup()).resolves.toBeUndefined()
      expect(attempts).toBeGreaterThanOrEqual(2)
      expect(await live(child.pid!)).toBe(false)
      await expect(fs.stat(fixture.root)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      denied?.mockRestore()
      await fs.writeFile(path.join(control, 'release'), 'go')
      await stopping
      await fixture.cleanup()
      await other.cleanup()
      await fs.rm(control, { recursive: true, force: true })
    }
  })

  for (const code of ['EACCES', 'EPERM']) {
    it(`finishes cleanup when a process exits before its environment read returns ${code}`, async () => {
      const fixture = await createClaudeFixture()
      const other = await createClaudeFixture()
      const root = fixture.spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' })
      const child = other.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
      const readFile = fs.readFile
      let intercepted = false
      const denied = vi.spyOn(fs, 'readFile').mockImplementation(async (file, options) => {
        if (file === `/proc/${child.pid!}/environ`) {
          intercepted = true
          await stopFixtureProcess(child)
          throw Object.assign(new Error('process environment became unreadable during exit'), { code })
        }
        return readFile(file, options)
      })
      try {
        await waitForFixtureProcessExit(root, 5_000)
        await expect(fixture.cleanup()).resolves.toBeUndefined()
        expect(intercepted).toBe(true)
        expect(await live(child.pid!)).toBe(false)
        await expect(fs.stat(fixture.root)).rejects.toMatchObject({ code: 'ENOENT' })
      } finally {
        denied.mockRestore()
        await fixture.cleanup()
        await other.cleanup()
      }
    })

    it(`retains files when a living detached writer's environment returns ${code}`, async () => {
      const control = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-detached-environ-'))
      const fixture = await createClaudeFixture({ parent: control })
      const root = fixture.spawn(process.execPath, ['-e', SIDECAR, fixture.root, control, 'create-failed', WRITER, MCP, 'true'], { stdio: 'ignore' })
      let denied: { mockRestore(): void } | undefined
      let intercepted = false
      try {
        await waitForFixtureProcessExit(root, 5_000)
        const writerPid = Number(await fs.readFile(path.join(control, 'native.pid'), 'utf8'))
        const readFile = fs.readFile
        denied = vi.spyOn(fs, 'readFile').mockImplementation(async (file, options) => {
          if (file === `/proc/${writerPid}/environ`) {
            intercepted = true
            throw Object.assign(new Error('living writer environment is unreadable'), { code })
          }
          return readFile(file, options)
        })
        await expect(fixture.cleanup()).rejects.toMatchObject({ code })
        expect(intercepted).toBe(true)
        expect(await live(writerPid)).toBe(true)
        await expect(fs.stat(fixture.root)).resolves.toBeDefined()
      } finally {
        denied?.mockRestore()
        await fixture.cleanup()
        await fs.rm(control, { recursive: true, force: true })
      }
    })
  }

  it('stops only its owned group and refuses new launches once cleanup starts', async () => {
    const fixture = await createClaudeFixture()
    const otherFixture = await createClaudeFixture()
    const child = fixture.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    const otherChild = otherFixture.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    try {
      const cleaning = fixture.cleanup()
      expect(() => fixture.spawn(process.execPath, ['-e', ''])).toThrow(/cleanup has started/)
      await cleaning

      expect(await live(child.pid!)).toBe(false)
      expect(await live(otherChild.pid!)).toBe(true)
      expect(() => fixture.spawn(process.execPath, ['-e', ''])).toThrow(/cleanup has started/)
    } finally {
      await fixture.cleanup()
      await otherFixture.cleanup()
    }
  })

})
