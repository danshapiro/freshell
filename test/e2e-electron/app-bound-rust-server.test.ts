/**
 * App-bound Electron acceptance: Electron owns one Rust child and does not
 * interfere with another process started from the same binary.
 *
 * This fixture deliberately uses ports allocated by the OS, never the live
 * self-hosted port. The foreign process is stopped by its own captured handle
 * during cleanup.
 */
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..', '..')
const VITE_ROOT = path.join(PROJECT_ROOT, 'node_modules')
const RUST_BINARY = path.join(PROJECT_ROOT, 'target', 'debug', process.platform === 'win32'
  ? 'freshell-server.exe'
  : 'freshell-server')
const CLIENT_DIR = path.join(PROJECT_ROOT, 'dist', 'client')

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = http.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        reject(new Error('Could not determine an ephemeral port'))
        return
      }
      const port = address.port
      server.close((error) => error ? reject(error) : resolve(port))
    })
  })
}

async function waitForHealth(port: number, token: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 30_000
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/server-info`, {
        headers: { 'x-auth-token': token },
      })
      if (response.ok) {
        const info = await response.json() as Record<string, unknown>
        if (info.runtime === 'rust' && typeof info.commit === 'string' && info.commit.length > 0) {
          return info
        }
        lastError = new Error('server-info did not contain Rust build provenance')
      } else {
        lastError = new Error(`server-info returned ${response.status}`)
      }
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Timed out waiting for Rust server: ${String(lastError)}`)
}

async function waitForHttp(url: string): Promise<void> {
  const deadline = Date.now() + 30_000
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok) return
      lastError = new Error(`HTTP ${response.status}`)
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Timed out waiting for ${url}: ${String(lastError)}`)
}

async function waitForWindowUrl(
  app: ElectronApplication,
  pattern: RegExp,
): Promise<Page> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    for (const window of app.windows()) {
      if (!pattern.test(window.url())) continue
      try {
        await window.evaluate(() => true)
        return window
      } catch {
        // The chooser can still be closing while the main window is created.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Timed out waiting for Electron window matching ${pattern}`)
}

function startLaunchChooserDevServer(): ChildProcess {
  return spawn(process.execPath, [
    path.join(VITE_ROOT, 'vite/bin/vite.js'),
    '--config',
    path.join(PROJECT_ROOT, 'config/vite/vite.launch-chooser.config.ts'),
  ], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      NODE_PATH: path.join(PROJECT_ROOT, 'node_modules'),
    },
    stdio: 'ignore',
  })
}

function directChildPids(parentPid: number): number[] {
  const result = spawnSync('ps', [
    '-o', 'pid=', '--ppid', String(parentPid),
  ], { encoding: 'utf8' }) as { status: number; stdout: string }
  if (result.status !== 0) return []
  return result.stdout
    .split('\n')
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((pid) => Number.isInteger(pid) && pid > 0)
}

function executablePath(pid: number): string | undefined {
  try {
    return fs.readlinkSync(`/proc/${pid}/exe`)
  } catch {
    return undefined
  }
}

async function waitForOwnedChild(parentPid: number, expectedBinary: string): Promise<number> {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const pid = directChildPids(parentPid).find((candidate) => executablePath(candidate) === expectedBinary)
    if (pid !== undefined) return pid
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Timed out waiting for Rust child of Electron PID ${parentPid}`)
}

async function waitForPidGone(pid: number): Promise<void> {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`PID ${pid} remained alive after its owner exited`)
}

async function stopCapturedChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      resolve()
    }
    child.once('close', finish)
    child.once('error', finish)
    child.kill('SIGTERM')
    const timer = setTimeout(() => {
      if (settled) return
      child.kill('SIGKILL')
      setTimeout(finish, 5_000)
    }, 5_000)
    child.once('close', () => clearTimeout(timer))
    child.once('error', () => clearTimeout(timer))
  })
}

test.describe('Electron app-bound Rust server', () => {
  test('resolves the launch chooser from this checkout', () => {
    expect(VITE_ROOT).toBe(path.join(PROJECT_ROOT, 'node_modules'))
    expect(fs.existsSync(path.join(VITE_ROOT, 'vite/bin/vite.js'))).toBe(true)
  })

  test('authenticates Rust server-info and stops only its exact child', async () => {
    test.skip(process.platform === 'win32', 'The exact /proc executable assertion is Linux-only.')
    expect(fs.existsSync(RUST_BINARY)).toBe(true)
    expect(fs.existsSync(CLIENT_DIR)).toBe(true)

    const appPort = await findFreePort()
    let foreignPort = await findFreePort()
    while (foreignPort === appPort) foreignPort = await findFreePort()

    const appHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-electron-rust-'))
    const foreignHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-electron-foreign-'))
    const appConfigDir = path.join(appHome, '.freshell')
    const foreignConfigDir = path.join(foreignHome, '.freshell')
    await fsp.mkdir(appConfigDir, { recursive: true })
    await fsp.mkdir(foreignConfigDir, { recursive: true })

    const appToken = `electron-app-bound-${Date.now()}`
    const foreignToken = `electron-foreign-${Date.now()}`
    await fsp.writeFile(path.join(appConfigDir, '.env'), `AUTH_TOKEN=${appToken}\n`)
    await fsp.writeFile(path.join(foreignConfigDir, '.env'), `AUTH_TOKEN=${foreignToken}\n`)
    await fsp.writeFile(path.join(appConfigDir, 'desktop.json'), JSON.stringify({
      serverMode: 'app-bound',
      port: appPort,
      knownServers: [],
      // Force the chooser so this test starts the configured app-bound server
      // rather than auto-connecting to another developer's local server.
      alwaysAskOnLaunch: true,
      globalHotkey: 'CommandOrControl+`',
      startOnLogin: false,
      minimizeToTray: true,
      setupCompleted: true,
    }))

    let app: ElectronApplication | undefined
    let foreign: ChildProcess | undefined
    let chooserDevServer: ChildProcess | undefined
    let appServerPid: number | undefined
    try {
      foreign = spawn(RUST_BINARY, [], {
        cwd: foreignConfigDir,
        env: {
          ...process.env,
          PORT: String(foreignPort),
          AUTH_TOKEN: undefined,
          FRESHELL_HOME: foreignHome,
          FRESHELL_CLIENT_DIR: CLIENT_DIR,
        },
        stdio: 'ignore',
      })
      await waitForHealth(foreignPort, foreignToken)

      // In development Electron loads the chooser from Vite. Start only that
      // fixture here; the Rust server serves the main client from disk.
      chooserDevServer = startLaunchChooserDevServer()
      await waitForHttp('http://localhost:5175')

      app = await electron.launch({
        args: [PROJECT_ROOT],
        cwd: PROJECT_ROOT,
        env: {
          ...process.env,
          HOME: appHome,
          ELECTRON_DEV: '1',
          FRESHELL_ELECTRON_TEST_NO_LOCAL_DISCOVERY: '1',
          NODE_PATH: path.join(PROJECT_ROOT, 'node_modules'),
        },
      })
      const mainPage = await app.firstWindow()
      await mainPage.waitForLoadState('domcontentloaded')
      const chooser = mainPage.getByRole('heading', { name: 'Choose Freshell server' })
      await expect(chooser).toBeVisible({ timeout: 30_000 })
      await mainPage.getByRole('button', { name: 'Start local' }).click()
      const appPage = await waitForWindowUrl(app, new RegExp(`^http://localhost:${appPort}(?:[/?#]|$)`))
      await appPage.waitForLoadState('domcontentloaded')
      await expect(appPage.locator('text=New Tab').first()).toBeVisible({ timeout: 30_000 })

      const electronPid = app.process().pid
      if (electronPid === undefined) throw new Error('Electron process did not expose a PID')
      appServerPid = await waitForOwnedChild(electronPid, RUST_BINARY)
      const appInfo = await waitForHealth(appPort, appToken)
      expect(appInfo.runtime).toBe('rust')
      expect(appInfo.commit).toEqual(expect.any(String))

      await app.close()
      app = undefined
      await waitForPidGone(appServerPid)

      // The same-path foreign Rust server must remain available after the app
      // closes. Cleanup below stops it through its captured ChildProcess.
      await expect.poll(async () => {
        try {
          const response = await fetch(`http://127.0.0.1:${foreignPort}/api/health`)
          return response.ok
        } catch {
          return false
        }
      }).toBe(true)
    } finally {
      if (app) await app.close().catch(() => {})
      if (chooserDevServer) await stopCapturedChild(chooserDevServer).catch(() => {})
      if (foreign) await stopCapturedChild(foreign).catch(() => {})
      await fsp.rm(appHome, { recursive: true, force: true })
      await fsp.rm(foreignHome, { recursive: true, force: true })
    }
  })
})
