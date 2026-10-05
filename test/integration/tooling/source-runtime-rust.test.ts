// @vitest-environment node

import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { ensureAuthTokenFile } from '../../../scripts/bootstrap-env.js'
import {
  detectProjectManager,
  resolveManagerCommand,
} from '../../../scripts/lib/package-manager.js'
import {
  findReleaseServerPid,
  readProcessSnapshot,
} from '../../../scripts/testing/process-tree.js'

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(TEST_DIR, '../../..')

let child: ChildProcess | undefined
let homeDir: string | undefined
let ownedRustPid: number | undefined

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

async function waitForRustChild(parentPid: number, timeoutMs = 10_000): Promise<number> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const pid = findReleaseServerPid(parentPid, readProcessSnapshot(), process.platform)
      if (pid !== undefined) return pid
    } catch {
      // The process table may be unavailable briefly while the package
      // manager is starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('could not identify the exact release freshell-server child')
}

async function waitForExit(processToWait: ChildProcess, timeoutMs = 10_000): Promise<void> {
  if (hasExited(processToWait)) return
  await new Promise<void>((resolve, reject) => {
    const onExit = () => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      processToWait.off('exit', onExit)
      reject(new Error(`owned child did not exit (pid ${processToWait.pid ?? 'unknown'})`))
    }, timeoutMs)
    processToWait.once('exit', onExit)
  })
}

function hasExited(processToCheck: ChildProcess): boolean {
  return processToCheck.exitCode !== null || processToCheck.signalCode !== null
}

afterEach(async () => {
  if (ownedRustPid !== undefined) {
    try {
      process.kill(ownedRustPid, 'SIGTERM')
    } catch {
      // The exact owned child may already have exited.
    }
  }
  if (child && !hasExited(child)) {
    child.kill('SIGTERM')
    await waitForExit(child).catch(() => undefined)
  }
  child = undefined
  ownedRustPid = undefined
  if (homeDir) await rm(homeDir, { recursive: true, force: true })
  homeDir = undefined
})

describe('source runtime', () => {
  it('recognizes an owned child that exited by signal before the wait began', async () => {
    const signaledChild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    await once(signaledChild, 'spawn')
    signaledChild.kill('SIGTERM')
    await once(signaledChild, 'exit')
    expect(signaledChild.signalCode).toBe('SIGTERM')

    await waitForExit(signaledChild, 100)
  })

  it.each([
    'AUTH_TOKEN=\n',
    'AUTH_TOKEN=""\n',
    'AUTH_TOKEN=replace-with-a-long-random-token # choose a token\n',
  ])('preserves working authentication across restarts after bootstrapping %j', async (assignment) => {
    homeDir = await mkdtemp(path.join(os.tmpdir(), 'freshell-source-auth-'))
    const envPath = path.join(homeDir, '.env')
    await writeFile(envPath, assignment)
    const port = await findFreePort()
    const token = `bootstrap-runtime-${process.pid}`
    const binary = path.join(PROJECT_ROOT, 'target/release', `freshell-server${process.platform === 'win32' ? '.exe' : ''}`)

    for (let launch = 0; launch < 2; launch += 1) {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        AUTH_TOKEN: undefined,
        PORT: String(port),
        HOME: homeDir,
        USERPROFILE: homeDir,
        FRESHELL_HOME: homeDir,
        FRESHELL_BIND_HOST: '127.0.0.1',
      }
      ensureAuthTokenFile({ env, envPath, generateToken: () => token })
      child = spawn(binary, [], { cwd: homeDir, env, stdio: 'ignore' })
      ownedRustPid = child.pid

      await waitForHealth(`http://127.0.0.1:${port}`, 5_000)
      const response = await fetch(`http://127.0.0.1:${port}/api/server-info`, {
        headers: { 'x-auth-token': token },
      })
      expect(response.ok).toBe(true)

      expect(child.kill('SIGTERM')).toBe(true)
      await waitForExit(child)
      expect(child.exitCode).toBe(0)
      child = undefined
      ownedRustPid = undefined
    }
  })

  it('starts the release Rust binary through the detected package manager start script and serves the built SPA', async () => {
    homeDir = await mkdtemp(path.join(os.tmpdir(), 'freshell-source-runtime-'))
    const port = await findFreePort()
    const token = `source-runtime-${process.pid}`
    const manager = detectProjectManager(PROJECT_ROOT).manager
    const startCommand = resolveManagerCommand({ manager, args: ['start'], env: process.env })
    child = spawn(startCommand.command, startCommand.args, {
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
      shell: startCommand.viaShell ?? false,
    })

    await waitForHealth(`http://127.0.0.1:${port}`)
    const rustPid = await waitForRustChild(child.pid!)
    ownedRustPid = rustPid
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
    ownedRustPid = undefined
    child = undefined
  })
})
