import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it, vi } from 'vitest'
import { createClaudeFixture, FAKE_MODEL, resolvePinnedClaude, startLocalProvider } from '../providers/claude-local-provider.mjs'
import { stopFixtureProcess, waitForFixtureProcessExit } from '../../support/stop-fixture-process.js'
import { createFixtureProcessOwner } from '../../support/owned-fixture-processes.mjs'

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

const WRITER = `
  const fs = require('node:fs')
  const path = require('node:path')
  const [root, control, resistTerm] = process.argv.slice(1)
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
  const [root, control, mode, writer] = process.argv.slice(1)
  const child = spawn(process.execPath, ['-e', writer, root, control, String(mode === 'clean')], { stdio: 'ignore' })
  child.unref()
  const ready = setInterval(() => {
    if (!fs.existsSync(path.join(control, 'native.pid'))) return
    clearInterval(ready)
    if (mode === 'clean') process.stdout.write(JSON.stringify({ type: 'created', cliPid: child.pid }) + '\\n')
    process.exit(mode === 'clean' ? 0 : 2)
  }, 5)
`

describe('Claude fixture native process ownership', () => {
  if (!IN_CONTAINER) {
    // Ordinary source-runtime invocations keep their usual host behavior;
    // only these process-kill checks move into the disposable sandbox.
    it('runs its native process lifecycle checks in a disposable sandbox', runInSandbox, 600_000)
    return
  }

  for (const mode of ['clean', 'create-failed'] as const) {
    it(`stops a native writer after its sidecar ${mode === 'clean' ? 'exits cleanly' : 'fails before sending created'}`, async () => {
      const control = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-native-owner-'))
      const fixture = await createClaudeFixture({ parent: control })
      const sidecar = fixture.spawn(process.execPath, ['-e', SIDECAR, fixture.root, control, mode, WRITER], {
        cwd: fixture.cwd,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      let stdout = ''
      sidecar.stdout!.on('data', (data: Buffer) => { stdout += data.toString() })
      const closed = new Promise<void>((resolve) => sidecar.once('close', () => resolve()))
      let nativePid: number | undefined
      try {
        await waitForFixtureProcessExit(sidecar, 5_000)
        await closed
        nativePid = Number(await fs.readFile(path.join(control, 'native.pid'), 'utf8'))
        expect(await live(nativePid)).toBe(true)
        if (mode === 'clean') {
          expect(sidecar.exitCode).toBe(0)
          expect(sidecar.signalCode).toBeNull()
          expect(JSON.parse(stdout.trim())).toEqual({ type: 'created', cliPid: nativePid })
        } else {
          expect(stdout).toBe('')
          expect(sidecar.exitCode).toBe(2)
        }

        await fixture.cleanup()
        const writerAlive = await live(nativePid)
        // A survivor is released only after cleanup, so its write must happen
        // after deletion, independently of filesystem traversal timing.
        await fs.writeFile(path.join(control, 'release'), 'go')
        if (writerAlive) await waitUntil(async () => fs.stat(path.join(control, 'wrote')).then(() => true, () => false))
        await delay(50)
        const recreated = await fs.stat(fixture.root).then(() => true, () => false)

        expect({ writerAlive, recreated }).toEqual({ writerAlive: false, recreated: false })
      } finally {
        await stopFixtureProcess(sidecar)
        if (nativePid !== undefined && await live(nativePid)) {
          process.kill(nativePid, 'SIGKILL')
          await waitUntil(async () => !await live(nativePid!))
        }
        await fixture.cleanup()
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

  it('settles a macOS-style process group using the portable process table', async () => {
    const owner = createFixtureProcessOwner({ platform: 'darwin' })
    const child = owner.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    try {
      expect(await live(child.pid!)).toBe(true)
      await owner.stop()
      expect(await live(child.pid!)).toBe(false)
    } finally {
      await owner.stop()
    }
  })

  for (const mode of ['flush', 'abrupt'] as const) {
    it(`Windows ownership ${mode === 'flush' ? 'waits for a native flush without changing the sidecar PID' : 'refuses deletion after an unconfirmed sidecar exit'}`, async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-windows-owner-'))
      const owner = createFixtureProcessOwner({ platform: 'win32', root })
      const writer = `
        const fs = require('node:fs')
        const path = require('node:path')
        const root = process.argv[1]
        process.on('SIGTERM', () => setTimeout(() => {
          fs.writeFileSync(path.join(root, 'flushed'), 'native flush completed')
          process.exit(0)
        }, 150))
        fs.writeFileSync(path.join(root, 'native.pid'), String(process.pid))
        setInterval(() => {}, 1000)
      `
      const script = `
        import fs from 'node:fs'
        import path from 'node:path'
        import { spawn } from 'node:child_process'
        const [root, mode, writer] = process.argv.slice(1)
        fs.writeFileSync(path.join(root, 'sidecar.pid'), String(process.pid))
        const native = spawn(process.execPath, ['-e', writer, root], { stdio: 'ignore' })
        native.unref()
        const ready = setInterval(() => {
          if (!fs.existsSync(path.join(root, 'native.pid'))) return
          clearInterval(ready)
          if (mode === 'abrupt') throw new Error('synthetic sidecar crash')
          native.kill('SIGTERM')
          process.exit(0)
        }, 5)
      `
      const child = owner.spawn(process.execPath, ['--input-type=module', '-e', script, root, mode, writer], { stdio: 'ignore', env: {} })
      let nativePid: number | undefined
      try {
        await waitForFixtureProcessExit(child, 10_000)
        nativePid = Number(await fs.readFile(path.join(root, 'native.pid'), 'utf8'))
        expect(Number(await fs.readFile(path.join(root, 'sidecar.pid'), 'utf8'))).toBe(child.pid)
        if (mode === 'flush') {
          expect(child.exitCode).toBe(0)
          expect(await live(nativePid)).toBe(false)
          expect(await fs.readFile(path.join(root, 'flushed'), 'utf8')).toBe('native flush completed')
          await owner.stop()
        } else {
          expect(child.exitCode).not.toBe(0)
          await expect(owner.stop()).rejects.toThrow(/unconfirmed native process exit/)
          expect(await live(nativePid)).toBe(true)
          await expect(fs.stat(root)).resolves.toBeDefined()
        }
      } finally {
        await stopFixtureProcess(child)
        if (nativePid !== undefined && await live(nativePid)) {
          process.kill(nativePid, 'SIGKILL')
          await waitUntil(async () => !await live(nativePid!))
        }
        await fs.rm(root, { recursive: true, force: true })
      }
    })
  }

  it('Windows ownership waits for a directly launched native executable to exit', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-windows-native-'))
    const owner = createFixtureProcessOwner({ platform: 'win32', root })
    const child = owner.spawn('/bin/sleep', ['30'], { stdio: 'ignore' })
    try {
      expect(await live(child.pid!)).toBe(true)
      await owner.stop()
      expect(await live(child.pid!)).toBe(false)
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
    } finally {
      await owner.stop()
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('Windows exit observation joins the real pinned SDK native child', async () => {
    const pinned = await resolvePinnedClaude(REPO_ROOT)
    const fixture = await createClaudeFixture()
    const owner = createFixtureProcessOwner({ platform: 'win32', root: fixture.root })
    const provider = await startLocalProvider()
    const child = owner.spawn(process.execPath, [path.join(REPO_ROOT, 'crates/freshell-claude-sidecar/index.mjs')], {
      cwd: path.join(REPO_ROOT, 'crates/freshell-claude-sidecar'),
      env: fixture.env(provider.url, { CLAUDE_CMD: pinned.nativeCli, FRESHELL_CLAUDE_ONECLI_API_KEY: '1' }),
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    child.stdin!.on('error', () => {})
    child.stderr!.resume()
    const lines = createInterface({ input: child.stdout! })
    try {
      const requestId = randomUUID()
      const created = new Promise<{ type: string; cliPid: number; message?: string }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('pinned sidecar create timed out')), 30_000)
        lines.on('line', (line: string) => {
          const frame = JSON.parse(line)
          if (frame.requestId === requestId && ['created', 'create.failed'].includes(frame.type)) {
            clearTimeout(timer)
            resolve(frame)
          }
        })
      })
      child.stdin!.write(`${JSON.stringify({ type: 'create', protocol: 2, boot: { kind: 'fresh' }, requestId, sessionId: randomUUID(), cwd: fixture.cwd, model: FAKE_MODEL, permissionMode: 'default' })}\n`)
      const frame = await created
      expect(frame.type, frame.message).toBe('created')
      expect(await live(frame.cliPid)).toBe(true)
      child.stdin!.end(`${JSON.stringify({ type: 'shutdown' })}\n`)
      await waitForFixtureProcessExit(child, 10_000)
      expect(child.exitCode).toBe(0)
      expect(await live(frame.cliPid)).toBe(false)
      await owner.stop()
    } finally {
      lines.close()
      await provider.close()
      // If ownership cannot be established, stop() throws before directory
      // removal; the enclosing disposable sandbox contains any survivor.
      await owner.stop()
      await fixture.cleanup()
    }
  })
})
