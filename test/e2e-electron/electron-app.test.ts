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

function remoteConfig() {
  return {
    serverMode: 'remote',
    port: 3001,
    remoteUrl: 'http://localhost:3001',
    remoteToken: getRunningServerToken(),
    globalHotkey: 'CommandOrControl+`',
    startOnLogin: false,
    minimizeToTray: true,
    setupCompleted: true,
  }
}

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
})
