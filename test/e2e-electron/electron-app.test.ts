/**
 * Electron E2E tests — validates the actual desktop app experience.
 *
 * Launches the real Electron app with a temporary HOME directory so that
 * no existing user config interferes. Uses xvfb (virtual framebuffer) on
 * headless Linux.
 */

import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { TestServer } from '../e2e-browser/helpers/test-server.js'

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..', '..')

/** The auth token of the running Freshell server (read from main repo .env, not the worktree). */
function getRunningServerToken(): string {
  const mainRepoRoot = path.resolve(PROJECT_ROOT, '..', '..')
  const envPaths = [
    path.join(mainRepoRoot, '.env'),
    path.join(PROJECT_ROOT, '.env'),
  ]
  for (const envPath of envPaths) {
    try {
      const content = fs.readFileSync(envPath, 'utf-8')
      for (const line of content.split('\n')) {
        const trimmed = line.trim()
        if (trimmed.startsWith('AUTH_TOKEN=')) {
          return trimmed.slice('AUTH_TOKEN='.length).trim().replace(/^["']|["']$/g, '')
        }
      }
    } catch {
      continue
    }
  }
  throw new Error('Could not find AUTH_TOKEN in .env files')
}

function createTempHome(desktopConfig?: Record<string, unknown>): string {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'freshell-e2e-'))
  const freshellDir = path.join(tmpHome, '.freshell')
  fs.mkdirSync(freshellDir, { recursive: true })
  if (desktopConfig) {
    fs.writeFileSync(
      path.join(freshellDir, 'desktop.json'),
      JSON.stringify(desktopConfig, null, 2),
    )
  }
  return tmpHome
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function writeDesktopEnv(tmpHome: string): void {
  fs.writeFileSync(
    path.join(tmpHome, '.freshell', '.env'),
    `AUTH_TOKEN=${getRunningServerToken()}\n`,
  )
}

async function launchApp(tmpHome: string, captureOutput = false): Promise<ElectronApplication> {
  const app = await electron.launch({
    args: [PROJECT_ROOT],
    env: {
      ...process.env,
      HOME: tmpHome,
      NODE_PATH: path.join(PROJECT_ROOT, 'node_modules'),
    },
    cwd: PROJECT_ROOT,
  })

  if (captureOutput) {
    app.process().stdout?.on('data', (data: Buffer) => {
      console.log('[main]', data.toString().trim())
    })
    app.process().stderr?.on('data', (data: Buffer) => {
      const text = data.toString().trim()
      if (text) console.log('[main-err]', text)
    })
  }

  return app
}

/** Wait for a new BrowserWindow to appear (polling approach, more robust than event). */
async function waitForNewWindow(
  app: ElectronApplication,
  currentCount: number,
  timeoutMs = 30_000,
): Promise<Page> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const windows = app.windows()
    if (windows.length > currentCount) {
      return windows[windows.length - 1]
    }
    await new Promise(r => setTimeout(r, 500))
  }
  throw new Error(`Timed out waiting for new window (current: ${currentCount})`)
}

async function waitForWindowUrl(
  app: ElectronApplication,
  pattern: RegExp,
  timeoutMs = 60_000,
): Promise<Page> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    for (const win of app.windows()) {
      if (pattern.test(win.url())) {
        try {
          await win.evaluate(() => true)
          return win
        } catch {
          // A crashed renderer can keep its last URL in Playwright. Keep
          // polling until Electron exposes the recovered window target.
        }
      }
    }
    await new Promise(r => setTimeout(r, 500))
  }
  throw new Error(`Timed out waiting for window URL matching ${pattern}`)
}

function remoteConfig() {
  return {
    serverMode: 'remote',
    port: 3001,
    remoteUrl: 'http://localhost:3001',
    remoteToken: getRunningServerToken(),
    knownServers: [],
    alwaysAskOnLaunch: false,
    globalHotkey: 'CommandOrControl+`',
    startOnLogin: false,
    minimizeToTray: true,
    setupCompleted: true,
  }
}

// ---------------------------------------------------------------------------
// Test: Renderer crash recovery
// ---------------------------------------------------------------------------

test.describe('Renderer crash recovery', () => {
  let app: ElectronApplication | undefined
  let server: TestServer | undefined
  let tmpHome: string | undefined

  test.afterEach(async () => {
    if (app) {
      await app.evaluate(() => {
        ;(globalThis as any).__restoreOpenExternal?.()
      }).catch(() => {})
      await app.close().catch(() => {})
      app = undefined
    }
    if (server) {
      await server.stop().catch(() => {})
      server = undefined
    }
    if (tmpHome) {
      fs.rmSync(tmpHome, { recursive: true, force: true })
      tmpHome = undefined
    }
  })

  test('recovers the main Freshell UI after the renderer process crashes', async () => {
    server = new TestServer()
    const serverInfo = await server.start()
    tmpHome = createTempHome({
      serverMode: 'remote',
      port: serverInfo.port,
      remoteUrl: serverInfo.baseUrl,
      remoteToken: serverInfo.token,
      knownServers: [],
      alwaysAskOnLaunch: false,
      globalHotkey: 'CommandOrControl+`',
      startOnLogin: false,
      minimizeToTray: true,
      setupCompleted: true,
    })

    app = await launchApp(tmpHome, true)
    const firstWindow = await app.firstWindow()
    await firstWindow.waitForLoadState('domcontentloaded')
    await expect(firstWindow.locator('text=New Tab').first()).toBeVisible({ timeout: 30_000 })

    const crashed = firstWindow.waitForEvent('crash', { timeout: 10_000 }).catch(() => undefined)
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer()
    })
    await crashed

    const recoveredWindow = await waitForWindowUrl(
      app,
      new RegExp(`^${escapeRegExp(serverInfo.baseUrl)}(?:[/?#]|$)`),
      60_000,
    )
    await recoveredWindow.waitForLoadState('domcontentloaded')
    await expect(recoveredWindow.locator('text=New Tab').first()).toBeVisible({ timeout: 30_000 })

    await app.evaluate(({ shell }) => {
      const original = shell.openExternal
      ;(globalThis as any).__testOpenExternal = (url: string) => {
        ;(globalThis as any).__openedUrl = url
        return Promise.resolve()
      }
      ;(globalThis as any).__restoreOpenExternal = () => {
        shell.openExternal = original
      }
      shell.openExternal = (globalThis as any).__testOpenExternal
    })

    await recoveredWindow.evaluate(async () => {
      const link = document.createElement('a')
      link.href = 'https://example.com/freshell-recovery-ipc'
      link.target = '_blank'
      link.rel = 'noopener noreferrer'
      link.textContent = 'test recovery external link'
      document.body.appendChild(link)

      const event = new MouseEvent('click', { ctrlKey: true, bubbles: true })
      link.dispatchEvent(event)

      await new Promise<void>((resolve) => setTimeout(resolve, 500))
    })

    await expect.poll(async () =>
      app!.evaluate(() => (globalThis as any).__openedUrl),
    ).toBe('https://example.com/freshell-recovery-ipc')

    await expect.poll(() => {
      const logsDir = path.join(tmpHome!, '.freshell', 'logs')
      if (!fs.existsSync(logsDir)) return ''
      return fs.readdirSync(logsDir)
        .filter((fileName) => /^electron-main\..*\.jsonl$/.test(fileName))
        .map((fileName) => fs.readFileSync(path.join(logsDir, fileName), 'utf-8'))
        .join('\n')
    }, { timeout: 30_000 }).toContain('main_window_recovery_succeeded')
  })
})

// ---------------------------------------------------------------------------
// Test: Wizard Flow
// ---------------------------------------------------------------------------

test.describe('Wizard flow', () => {
  let app: ElectronApplication
  let tmpHome: string

  test.beforeEach(async () => {
    tmpHome = createTempHome()
  })

  test.afterEach(async () => {
    if (app) await app.close().catch(() => {})
    fs.rmSync(tmpHome, { recursive: true, force: true })
  })

  test('shows wizard on first launch and completes setup', async () => {
    app = await launchApp(tmpHome, true)
    const wizardPage = await app.firstWindow()
    await wizardPage.waitForLoadState('domcontentloaded')
    await wizardPage.screenshot({ path: 'test-results/wizard-01-welcome.png' })

    // Welcome step
    await expect(wizardPage.locator('h1:has-text("Welcome to Freshell")')).toBeVisible()
    await wizardPage.getByRole('button', { name: /get started/i }).click()

    // Server mode step
    await expect(wizardPage.locator('h2:has-text("Server Mode")')).toBeVisible()
    await wizardPage.screenshot({ path: 'test-results/wizard-02-server-mode.png' })
    await wizardPage.locator('text=Remote only').click()
    await wizardPage.getByRole('button', { name: /next/i }).click()

    // Configuration step
    await expect(wizardPage.locator('h2:has-text("Configuration")')).toBeVisible()
    await wizardPage.screenshot({ path: 'test-results/wizard-03-configuration.png' })
    await wizardPage.locator('#remote-url').fill('http://localhost:3001')
    await wizardPage.locator('#remote-token').fill(getRunningServerToken())
    await wizardPage.getByRole('button', { name: /next/i }).click()

    // Hotkey step
    await expect(wizardPage.locator('h2:has-text("Global Hotkey")')).toBeVisible()
    await wizardPage.screenshot({ path: 'test-results/wizard-04-hotkey.png' })
    await wizardPage.getByRole('button', { name: /next/i }).click()

    // Complete step
    await expect(wizardPage.locator('h2:has-text("Ready to go!")')).toBeVisible()
    await wizardPage.screenshot({ path: 'test-results/wizard-05-complete.png' })

    // Config should not exist yet
    const configPath = path.join(tmpHome, '.freshell', 'desktop.json')
    expect(fs.existsSync(configPath)).toBe(false)

    // Record current window count before clicking Launch
    const windowCountBefore = app.windows().length
    console.log(`[wizard-test] windows before click: ${windowCountBefore}`)

    await wizardPage.getByRole('button', { name: /launch freshell/i }).click()

    // Give the IPC handler time to save the config before the wizard closes
    await new Promise(r => setTimeout(r, 2000))

    // Check if config was saved
    const configAfterClick = fs.existsSync(configPath)
      ? fs.readFileSync(configPath, 'utf-8')
      : 'NOT SAVED'
    console.log(`[wizard-test] config after click: ${configAfterClick}`)
    console.log(`[wizard-test] windows after click: ${app.windows().length}`)

    // Wait for the wizard to close and the main window to open
    const mainPage = await waitForNewWindow(app, 0, 60_000)
    await mainPage.waitForLoadState('domcontentloaded')
    await mainPage.waitForTimeout(5000)
    await mainPage.screenshot({ path: 'test-results/wizard-06-main-after-wizard.png' })

    // Verify config was saved
    expect(fs.existsSync(configPath)).toBe(true)
    const savedConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
    expect(savedConfig.setupCompleted).toBe(true)
    expect(savedConfig.serverMode).toBe('remote')
  })
})

// ---------------------------------------------------------------------------
// Test: Launch chooser
// ---------------------------------------------------------------------------

test.describe('Launch chooser', () => {
  let app: ElectronApplication
  let tmpHome: string

  test.afterEach(async () => {
    if (app) await app.close().catch(() => {})
    if (tmpHome) fs.rmSync(tmpHome, { recursive: true, force: true })
  })

  test('shows launch chooser when alwaysAskOnLaunch is true', async () => {
    tmpHome = createTempHome({
      serverMode: 'remote',
      port: 3001,
      remoteUrl: 'http://localhost:3001',
      remoteToken: getRunningServerToken(),
      knownServers: [],
      alwaysAskOnLaunch: true,
      globalHotkey: 'CommandOrControl+`',
      startOnLogin: false,
      minimizeToTray: true,
      setupCompleted: true,
    })

    app = await launchApp(tmpHome)
    const chooser = await app.firstWindow()
    await chooser.waitForLoadState('domcontentloaded')

    await expect(chooser.getByRole('heading', { name: 'Choose Freshell server' })).toBeVisible()
    await expect(chooser.getByRole('checkbox', { name: 'Always ask on launch' })).toBeChecked()
  })

  test('connects to an existing server from chooser', async () => {
    tmpHome = createTempHome({
      serverMode: 'app-bound',
      port: 3001,
      knownServers: [{ url: 'http://localhost:3001', label: 'Test server' }],
      alwaysAskOnLaunch: true,
      globalHotkey: 'CommandOrControl+`',
      startOnLogin: false,
      minimizeToTray: true,
      setupCompleted: true,
    })
    writeDesktopEnv(tmpHome)

    app = await launchApp(tmpHome)
    const chooser = await app.firstWindow()
    await chooser.waitForLoadState('domcontentloaded')

    // The candidate button's accessible name is "Connect to <label|url>".
    // Selecting it must connect this launch even with "Always ask on launch"
    // still checked — that is exactly the forced-launch behavior under test.
    await chooser.getByRole('button', { name: /^Connect to / }).first().click()
    const mainPage = await waitForWindowUrl(app, /http:\/\/localhost:3001/, 60_000)
    await mainPage.waitForLoadState('domcontentloaded')

    await expect(mainPage).toHaveURL(/http:\/\/localhost:3001/)
  })
})

// ---------------------------------------------------------------------------
// Test: Main Window (pre-seeded config, remote mode)
// ---------------------------------------------------------------------------

test.describe('Main window with remote server', () => {
  let app: ElectronApplication
  let tmpHome: string

  test.beforeEach(async () => {
    tmpHome = createTempHome(remoteConfig())
  })

  test.afterEach(async () => {
    if (app) await app.close().catch(() => {})
    fs.rmSync(tmpHome, { recursive: true, force: true })
  })

  test('loads authenticated Freshell UI', async () => {
    app = await launchApp(tmpHome)
    const mainPage = await app.firstWindow()
    await mainPage.waitForLoadState('domcontentloaded')
    await mainPage.waitForTimeout(5000)
    await mainPage.screenshot({ path: 'test-results/main-01-loaded.png' })

    // Auth succeeded — token in localStorage
    const authToken = await mainPage.evaluate(() =>
      localStorage.getItem('freshell.auth-token')
    )
    expect(authToken).toBeTruthy()

    // No auth modal
    await expect(mainPage.locator('h2:has-text("Authentication required")')).not.toBeVisible()

    // Tab bar visible
    await expect(mainPage.locator('text=New Tab').first()).toBeVisible()

    await mainPage.screenshot({ path: 'test-results/main-02-authenticated.png' })
  })

  test('shows terminal launcher grid', async () => {
    app = await launchApp(tmpHome)
    const mainPage = await app.firstWindow()
    await mainPage.waitForLoadState('domcontentloaded')
    await mainPage.waitForTimeout(5000)

    // The launcher grid should have recognizable session types.
    // Use the specific launcher area (main content, not sidebar).
    // The launcher tiles have specific text content that's unique enough.
    await expect(mainPage.getByText('Claude CLI')).toBeVisible({ timeout: 10_000 })
    await expect(mainPage.getByText('Codex CLI')).toBeVisible()
    await expect(mainPage.getByText('Editor')).toBeVisible()
    await expect(mainPage.getByText('Browser')).toBeVisible()

    await mainPage.screenshot({ path: 'test-results/main-03-launcher.png' })
  })

  test('ctrl-clicking an external link uses the system browser', async () => {
    app = await launchApp(tmpHome)
    const mainPage = await app.firstWindow()
    await mainPage.waitForLoadState('domcontentloaded')
    await mainPage.waitForTimeout(3000)

    // Patch shell.openExternal in the main process so the test can observe the
    // real IPC flow without actually launching a browser window.
    await app.evaluate(({ shell }) => {
      const original = shell.openExternal
      ;(globalThis as any).__testOpenExternal = (url: string) => {
        ;(globalThis as any).__openedUrl = url
        return Promise.resolve()
      }
      ;(globalThis as any).__restoreOpenExternal = () => {
        shell.openExternal = original
      }
      shell.openExternal = (globalThis as any).__testOpenExternal
    })

    // Inject an external link and ctrl-click it in the main renderer.
    await mainPage.evaluate(async () => {
      const link = document.createElement('a')
      link.href = 'https://example.com/freshell-test-link'
      link.target = '_blank'
      link.rel = 'noopener noreferrer'
      link.textContent = 'test external link'
      document.body.appendChild(link)

      const event = new MouseEvent('click', { ctrlKey: true, bubbles: true })
      link.dispatchEvent(event)

      // Wait for the IPC round-trip.
      await new Promise<void>((resolve) => setTimeout(resolve, 500))
    })

    await expect.poll(async () =>
      app.evaluate(() => (globalThis as any).__openedUrl),
    ).toBe('https://example.com/freshell-test-link')
  })
})
