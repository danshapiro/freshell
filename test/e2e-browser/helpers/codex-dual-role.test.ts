import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { describe, it, expect } from 'vitest'
import { installDualRoleCodexCli } from '../fixtures/codex-dual-role'

/**
 * Behavioral pinning for the dual-role codex shim installed by e2e specs.
 *
 * The Rust server's codex terminal lane spawns TWO processes from the same
 * CODEX_CMD: the TUI (plain argv) and a `codex app-server` sidecar FIRST.
 * A terminal-only fake at CODEX_CMD exits 0 instantly on the sidecar spawn
 * (stdin is /dev/null), and every codex pane create dies PTY_SPAWN_FAILED.
 * The dual-role shim must therefore:
 *   (a) run the given terminal fake for plain argv (stdi. in/out passthrough), and
 *   (b) route argv containing `app-server` to the shared fake app-server,
 *       which STAYS ALIVE listening (the sidecar contract).
 */

const TERMINAL_MARKER = 'DUAL_ROLE_TERMINAL_RAN'

async function writeTerminalFake(binDir: string): Promise<string> {
  const terminalSrc = path.join(binDir, 'terminal-src.mjs')
  await fs.writeFile(terminalSrc, `console.log(${JSON.stringify(TERMINAL_MARKER)})\nprocess.exit(0)\n`, 'utf8')
  return terminalSrc
}

function spawnShim(binPath: string, args: string[]): { child: ChildProcess; stdout: string[] } {
  const stdout: string[] = []
  const child = spawn(binPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout?.on('data', (d) => stdout.push(String(d)))
  return { child, stdout }
}

async function waitExit(child: ChildProcess, timeoutMs: number): Promise<number | null> {
  return await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs)
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve(code)
    })
  })
}

describe('codex-dual-role shim', () => {
  it('runs the terminal fake for plain argv', async () => {
    const binDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dual-role-'))
    const terminalSrc = await writeTerminalFake(binDir)
    const bin = await installDualRoleCodexCli(binDir, terminalSrc)
    expect(bin).toBe(path.join(binDir, 'codex'))

    const { child, stdout } = spawnShim(bin, [])
    const code = await waitExit(child, 10_000)
    expect(code).not.toBeNull()
    expect(code).toBe(0)
    await waitUntil(2_000, () => stdout.join('').includes(TERMINAL_MARKER))
  }, 30_000)

  it('routes `app-server` argv to the fake app-server, which keeps listening (the sidecar contract)', async () => {
    const binDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dual-role-'))
    const terminalSrc = await writeTerminalFake(binDir)
    const bin = await installDualRoleCodexCli(binDir, terminalSrc)

    const { child, stdout } = spawnShim(bin, ['-c', 'features.apps=false', 'app-server', '--listen', 'ws://127.0.0.1:0'])
    // A listening sidecar survives its whole lifetime — it does NOT exit 0
    // instantly the way a terminal-only fake does when stdin is /dev/null.
    const earlyExit = await waitExit(child, 3_000)
    expect(earlyExit).toBeNull()
    // And it never confused itself for the terminal fake.
    await new Promise((r) => setTimeout(r, 100))
    expect(stdout.join('')).not.toContain(TERMINAL_MARKER)
    child.kill('SIGTERM')
    await waitExit(child, 10_000)
  }, 30_000)

  it('passes terminalEnv through to the terminal role only', async () => {
    const binDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dual-role-'))
    const terminalSrc = path.join(binDir, 'terminal-src.mjs')
    await fs.writeFile(
      terminalSrc,
      "console.log('env=' + process.env.DUAL_ROLE_TEST_ENV)\nprocess.exit(0)\n",
      'utf8',
    )
    const bin = await installDualRoleCodexCli(binDir, terminalSrc, {
      DUAL_ROLE_TEST_ENV: 'env-carry-1',
    })
    const { child, stdout } = spawnShim(bin, [])
    const code = await waitExit(child, 10_000)
    expect(code).toBe(0)
    await waitUntil(2_000, () => stdout.join('').includes('env=env-carry-1'))
  }, 30_000)

  it('a terminal-only fake at CODEX_CMD exits 0 instantly under sidecar argv (the pathology this shim fixes)', async () => {
    // Contrast test: documents the failure this helper prevents. If the
    // shared app-server fake stops working, the previous test fails; if the
    // dispatch breaks toward the terminal role, this one catches regression
    // in the FIXture's transitive meaning.
    const binDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dual-role-'))
    const terminalSrc = await writeTerminalFake(binDir)
    const bin = await installDualRoleCodexCli(binDir, terminalSrc)

    const { child, stdout } = spawnShim(bin, ['-c', 'features.apps=false', 'app-server', '--listen', 'ws://127.0.0.1:0'])
    const code = await waitExit(child, 10_000)
    child.kill('SIGTERM')
    // Terminal fake must NOT have run.
    expect(stdout.join('')).not.toContain(TERMINAL_MARKER)
    expect(code).toBeNull()
  }, 30_000)
})

async function waitUntil(timeoutMs: number, pred: () => boolean): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (pred()) return
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error('waitUntil timed out')
}
