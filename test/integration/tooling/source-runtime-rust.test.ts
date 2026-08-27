// @vitest-environment node

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(TEST_DIR, '../../..')
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'

let child: ChildProcess | undefined
let homeDir: string | undefined

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('could not resolve ephemeral port')))
        return
      }
      server.close(() => resolve(address.port))
    })
  })
}

async function waitForHealth(baseUrl: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/health`)
      if (response.ok) return
    } catch {
      // The owned child is still booting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`timed out waiting for ${baseUrl}/api/health`)
}

function childPids(parentPid: number): number[] {
  if (process.platform === 'win32') return []
  const result = spawnSync('ps', ['-o', 'pid=', '--ppid', String(parentPid)], { encoding: 'utf8' }) as { status: number; stdout?: string }
  if (result.status !== 0 || !result.stdout) return []
  return result.stdout
    .split('\n')
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((pid) => Number.isInteger(pid) && pid > 0)
}

function descendants(parentPid: number): number[] {
  const found: number[] = []
  const queue = [parentPid]
  while (queue.length > 0) {
    const current = queue.shift()!
    for (const pid of childPids(current)) {
      found.push(pid)
      queue.push(pid)
    }
  }
  return found
}

async function waitForRustChild(parentPid: number, timeoutMs = 10_000): Promise<number> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    for (const pid of descendants(parentPid)) {
      try {
        const cmdline = await readFile(`/proc/${pid}/cmdline`, 'utf8')
        if (cmdline.includes(`${path.sep}target${path.sep}release${path.sep}freshell-server`)) return pid
      } catch {
        // The process may exit between ps and /proc.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('could not identify the exact release freshell-server child')
}

async function waitForExit(processToWait: ChildProcess, timeoutMs = 10_000): Promise<void> {
  if (processToWait.exitCode !== null) return
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('owned child did not exit')), timeoutMs)
    processToWait.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

afterEach(async () => {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM')
    await waitForExit(child).catch(() => undefined)
  }
  child = undefined
  if (homeDir) await rm(homeDir, { recursive: true, force: true })
  homeDir = undefined
})

describe('source runtime', () => {
  it('starts the release Rust binary through npm start and serves the built SPA', async () => {
    homeDir = await mkdtemp(path.join(os.tmpdir(), 'freshell-source-runtime-'))
    const port = await findFreePort()
    const token = `source-runtime-${process.pid}`
    child = spawn(npmCommand, ['start'], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        NODE_ENV: 'production',
        PORT: String(port),
        AUTH_TOKEN: token,
        HOME: homeDir,
        USERPROFILE: homeDir,
        FRESHELL_HOME: homeDir,
        FRESHELL_BIND_HOST: '127.0.0.1',
        FRESHELL_CLIENT_DIR: path.join(PROJECT_ROOT, 'dist', 'client'),
      },
      stdio: 'ignore',
    })

    await waitForHealth(`http://127.0.0.1:${port}`)
    const rustPid = await waitForRustChild(child.pid!)
    const response = await fetch(`http://127.0.0.1:${port}/api/server-info`, {
      headers: { 'x-auth-token': token },
    })
    expect(response.ok).toBe(true)
    const info = await response.json() as { runtime?: string; commit?: string }
    expect(info.runtime).toBe('rust')
    expect(info.commit).toMatch(/^[0-9a-f]{7,40}$/)

    const spa = await fetch(`http://127.0.0.1:${port}/`)
    expect(spa.ok).toBe(true)
    expect(await spa.text()).toContain('<div id="root">')

    process.kill(rustPid, 'SIGTERM')
    await waitForExit(child)
    child = undefined
  })
})
