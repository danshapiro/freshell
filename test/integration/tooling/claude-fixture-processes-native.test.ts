import type { ChildProcess } from 'node:child_process'
import { execFile } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { createClaudeFixture } from '../providers/claude-local-provider.mjs'

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
  const [root, control, mcp] = process.argv.slice(1)
  const child = spawn(process.execPath, ['-e', mcp, root, control], { stdio: 'ignore' })
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
  const [root, control, mode, writer, mcp] = process.argv.slice(1)
  fs.writeFileSync(path.join(control, 'root.pid'), String(process.pid))
  const child = spawn(process.execPath, ['-e', writer, root, control, mcp], { stdio: 'ignore' })
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
  for (const [mode, description] of [
    ['clean', 'a clean sidecar exit'],
    ['create-failed', 'creation fails without a created frame'],
    ['hard-killed', 'the sidecar is killed with SIGKILL'],
  ] as const) {
    it(`contains CLI and MCP descendants after ${description}`, async () => {
      const control = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-native-tree-'))
      const fixture = await createClaudeFixture({ parent: control })
      const other = await createClaudeFixture({ parent: control })
      const unrelatedReport = path.join(control, 'unrelated.pid')
      const unrelated = other.spawn(process.execPath, ['-e', `require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)`, unrelatedReport], { stdio: 'ignore' })
      const sidecar = fixture.spawn(process.execPath, ['-e', SIDECAR, fixture.root, control, mode, WRITER, MCP], {
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
        await output.closed
        const rootPid = Number(await fs.readFile(path.join(control, 'root.pid'), 'utf8'))
        const writerPid = Number(await fs.readFile(path.join(control, 'writer.pid'), 'utf8'))
        const mcpPid = Number(await fs.readFile(path.join(control, 'mcp.pid'), 'utf8'))
        expect(sidecar.pid, 'ChildProcess.pid must identify the actual root process').toBe(rootPid)
        expect(await live(writerPid)).toBe(true)
        expect(await live(mcpPid)).toBe(true)
        if (mode === 'clean') {
          expect(sidecar.exitCode).toBe(0)
          expect(sidecar.signalCode).toBeNull()
          expect(JSON.parse(output.stdout().trim())).toEqual({ type: 'created', pid: rootPid, cliPid: writerPid })
        } else if (mode === 'create-failed') {
          expect(sidecar.exitCode).toBe(2)
          expect(output.stdout()).toBe('')
        } else {
          expect(await live(rootPid)).toBe(false)
        }

        await fixture.cleanup()
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
        await other.cleanup()
        await fs.rm(control, { recursive: true, force: true })
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
})
