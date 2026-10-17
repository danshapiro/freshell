/**
 * Electron E2E tests — validates the actual desktop app experience.
 *
 * Launches the real Electron app with a temporary HOME directory so that
 * no existing user config interferes. Uses xvfb (virtual framebuffer) on
 * headless Linux.
 */

import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import type { BrowserWindow, WebPreferences } from 'electron'
import type { ChildProcess } from 'node:child_process'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { RustServer } from '../e2e-browser/helpers/rust-server.js'
import type { E2eServerInfo } from '../e2e-browser/helpers/server-fixture-support.js'
import type { LaunchServerCandidate } from '../../electron/types.js'
import { stopOwnedServerAndVerify } from './owned-server-teardown.js'
import { cleanupElectronFixture, closeElectronGracefully } from './electron-fixture-cleanup.js'
import { isolatedElectronHomeEnv } from './fixture-home-env.js'
import { navigateToUnavailableEndpoint } from './renderer-outage-navigation.js'

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..', '..')
const electronProcesses = new WeakMap<ElectronApplication, ChildProcess>()
const electronStdout = new WeakMap<ElectronApplication, string[]>()

function requireElectronE2eBuildId(): string {
  const buildId = process.env.FRESHELL_ELECTRON_E2E_BUILD_ID
  if (!buildId || !/^[0-9a-f]{40}$/.test(buildId)) {
    throw new Error('Electron E2E requires the exact-client-build preflight; run pnpm run test:e2e:electron')
  }
  return buildId
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

async function launchApp(
  tmpHome: string,
  captureOutput = false,
  discoveryCandidate?: LaunchServerCandidate,
): Promise<ElectronApplication> {
  const app = await electron.launch({
    args: [PROJECT_ROOT],
    env: {
      ...isolatedElectronHomeEnv(process.env, tmpHome),
      NODE_PATH: path.join(PROJECT_ROOT, 'node_modules'),
      // The Electron launch chooser normally probes local development ports,
      // including :3001. E2E supplies an explicit owned target instead.
      FRESHELL_ELECTRON_TEST_NO_LOCAL_DISCOVERY: '1',
      FRESHELL_ELECTRON_TEST_LIFECYCLE_STDOUT: '1',
      FRESHELL_ELECTRON_TEST_DISCOVERY_CANDIDATE: discoveryCandidate
        ? JSON.stringify(discoveryCandidate)
        : undefined,
    },
    cwd: PROJECT_ROOT,
  })
  // Capture the launch-owned process once. Cleanup may only signal this exact
  // child if Playwright's graceful close has already timed out.
  electronProcesses.set(app, app.process())
  const stdout: string[] = []
  electronStdout.set(app, stdout)
  app.process().stdout?.on('data', (data: Buffer) => {
    stdout.push(data.toString())
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

function remoteConfig(server: E2eServerInfo) {
  return {
    serverMode: 'remote',
    port: server.port,
    remoteUrl: server.baseUrl,
    remoteToken: server.token,
    knownServers: [],
    alwaysAskOnLaunch: false,
    globalHotkey: 'CommandOrControl+`',
    startOnLogin: false,
    minimizeToTray: true,
    setupCompleted: true,
  }
}

/**
 * Each Electron test that connects to a server gets its own fixture-owned Rust
 * process and Electron HOME. That keeps a prior test's durable machine
 * workspace from affecting the next test's recovery or chooser state.
 * RustServer owns the exact process tree and ephemeral port; it never probes
 * the live server.
 */
let remoteServer: RustServer | undefined
let remoteServerInfo: E2eServerInfo | undefined

function requireRemoteServerInfo(): E2eServerInfo {
  if (!remoteServerInfo) throw new Error('Electron remote-server fixture is not running')
  return remoteServerInfo
}

async function startRemoteServer(): Promise<E2eServerInfo> {
  if (remoteServer) throw new Error('Electron remote-server fixture is already running')
  remoteServer = new RustServer({
    expectedBuildCommit: requireElectronE2eBuildId(),
    expectedBuildDirty: false,
  })
  remoteServerInfo = await remoteServer.start()
  expect(remoteServerInfo.port).not.toBe(3001)
  return remoteServerInfo
}

async function stopRemoteServer(): Promise<void> {
  const server = remoteServer
  const serverInfo = remoteServerInfo
  remoteServer = undefined
  remoteServerInfo = undefined

  if (!server) return
  if (!serverInfo) {
    await server.stop()
    throw new Error('Electron remote-server fixture stopped without an owned PID/port receipt')
  }
  await stopOwnedServerAndVerify(server, serverInfo)
}

// ---------------------------------------------------------------------------
// Test: Renderer crash recovery
// ---------------------------------------------------------------------------

test.describe('Renderer crash recovery', () => {
  let app: ElectronApplication | undefined
  let server: RustServer | undefined
  let serverInfo: E2eServerInfo | undefined
  let tmpHome: string | undefined
  let serverHome: string | undefined

  function recoveryEvents(): Array<Record<string, any>> {
    if (!tmpHome) return []
    const logs = path.join(tmpHome, '.freshell', 'logs')
    if (!fs.existsSync(logs)) return []
    return fs.readdirSync(logs).filter(name => /^electron-main\..*\.jsonl$/.test(name))
      .flatMap(name => fs.readFileSync(path.join(logs, name), 'utf8').split('\n'))
      .filter(Boolean).map(line => JSON.parse(line))
  }

  async function nativeWindowState(application: ElectronApplication, page: Page) {
    const native = await application.browserWindow(page)
    try {
      return await native.evaluate((window: BrowserWindow) => {
        const preferences = (window.webContents as typeof window.webContents & {
          getLastWebPreferences(): WebPreferences
        }).getLastWebPreferences()
        return {
          id: window.id,
          mainPid: process.pid,
          webContentsId: window.webContents.id,
          rendererPid: window.webContents.getOSProcessId(),
          sandbox: preferences.sandbox,
          contextIsolation: preferences.contextIsolation,
          nodeIntegration: preferences.nodeIntegration,
          visible: window.isVisible(),
          focused: window.isFocused(),
          minimized: window.isMinimized(),
          maximized: window.isMaximized(),
          bounds: window.getBounds(),
        }
      })
    } finally { await native.dispose() }
  }

  async function prepareNativeWindow(application: ElectronApplication, page: Page) {
    const workArea = await application.evaluate(({ screen }) => screen.getPrimaryDisplay().workArea)
    const bounds = { x: workArea.x + 20, y: workArea.y + 20,
      width: Math.min(1000, workArea.width - 40), height: Math.min(700, workArea.height - 40) }
    const native = await application.browserWindow(page)
    try {
      await native.evaluate((window: BrowserWindow, target) => {
        if (window.isMinimized()) window.restore()
        window.unmaximize()
        window.setBounds(target)
        window.show()
        window.focus()
      }, bounds)
    } finally { await native.dispose() }
    // Xvfb need not have a window manager that implements maximize. Establish
    // a normal, focused native window and preserve that actual state instead.
    await expect.poll(() => nativeWindowState(application, page), { timeout: 15_000 }).toMatchObject({
      sandbox: true, contextIsolation: true, nodeIntegration: false,
      visible: true, focused: true, minimized: false, maximized: false, bounds,
    })
    expect(bounds.width).toBeGreaterThan(0)
    expect(bounds.height).toBeGreaterThan(0)
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(workArea.x + workArea.width)
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(workArea.y + workArea.height)
    return nativeWindowState(application, page)
  }

  async function expectNativeRecovery(application: ElectronApplication, page: Page, before: Awaited<ReturnType<typeof nativeWindowState>>) {
    const { id, mainPid, webContentsId, rendererPid, ...presentation } = before
    // This is a read-only native check: a hidden DOM-ready candidate cannot
    // satisfy it, and the assertion never shows/focuses the recovered window.
    await expect.poll(() => nativeWindowState(application, page), { timeout: 15_000 }).toMatchObject(presentation)
    const after = await nativeWindowState(application, page)
    expect(after.mainPid).toBe(mainPid)
    expect(after.id).not.toBe(id)
    expect(after.webContentsId).not.toBe(webContentsId)
    expect(after.rendererPid).not.toBe(rendererPid)
    expect(after.rendererPid).toBeGreaterThan(0)
    await test.info().attach('renderer-recovery-native-window.json', {
      body: JSON.stringify({ before, after }), contentType: 'application/json',
    })
  }

  test.afterEach(async () => {
    const appToClose = app
    const serverToStop = server
    const infoToVerify = serverInfo
    const homeToRemove = tmpHome
    const serverHomeToRemove = serverHome
    try {
      await test.info().attach('renderer-recovery-events.jsonl', {
        body: recoveryEvents().map(event => JSON.stringify(event)).join('\n'),
        contentType: 'application/x-ndjson',
      })
    } finally {
      app = undefined
      server = undefined
      serverInfo = undefined
      tmpHome = undefined
      serverHome = undefined
      const removeOwnedHomes = async () => {
        const ownedHomes = [homeToRemove, serverHomeToRemove].filter((home): home is string => typeof home === 'string')
        await Promise.all(ownedHomes.map(home => fs.promises.rm(home, { recursive: true, force: true })))
      }
      await cleanupElectronFixture({
        app: appToClose,
        electronProcess: appToClose ? electronProcesses.get(appToClose) : undefined,
        restoreOpenExternal: appToClose
          ? async () => {
            await appToClose.evaluate(() => {
              ;(globalThis as any).__restoreOpenExternal?.()
            })
          }
          : undefined,
        stopServer: serverToStop && infoToVerify
          ? () => stopOwnedServerAndVerify(serverToStop, infoToVerify)
          : serverToStop
            ? () => serverToStop.stop().then(() => {
              throw new Error('renderer-recovery fixture stopped without an owned PID/port receipt')
            })
            : undefined,
        removeHome: removeOwnedHomes,
      })
      await test.info().attach('renderer-recovery-cleanup.json', {
        body: JSON.stringify({ electronPid: appToClose ? electronProcesses.get(appToClose)?.pid : undefined,
          serverPid: infoToVerify?.pid, port: infoToVerify?.port,
          homes: [homeToRemove, serverHomeToRemove].filter(Boolean).map(home => ({ path: home, absent: !fs.existsSync(home!) })),
          outcome: 'exact-owned-teardown-verified' }),
        contentType: 'application/json',
      })
    }
  })

  test('recovers autonomously when an endpoint returns after the real cooldown', async () => {
    test.setTimeout(240_000)
    serverHome = fs.mkdtempSync(path.join(os.tmpdir(), 'electron-outage-server-'))
    server = new RustServer({ homeDir: serverHome, preserveHomeOnStop: true,
      expectedBuildCommit: requireElectronE2eBuildId(), expectedBuildDirty: false })
    serverInfo = await server.start()
    tmpHome = createTempHome(remoteConfig(serverInfo))
    app = await launchApp(tmpHome, true)
    const initial = await app.firstWindow()
    await expect(initial.locator('text=New Tab').first()).toBeVisible({ timeout: 30_000 })
    const initialNative = await prepareNativeWindow(app, initial)
    const savedUrl = `${serverInfo.baseUrl}/?token=${encodeURIComponent(serverInfo.token)}`
    const receipt = serverInfo
    const token = serverInfo.token, port = serverInfo.port
    await stopOwnedServerAndVerify(server, receipt)
    server = undefined
    serverInfo = undefined
    const logOffset = recoveryEvents().length
    const outageStarted = Date.now()
    const native = await app.browserWindow(initial)
    try {
      const failure = await native.evaluate(navigateToUnavailableEndpoint, savedUrl)
      await test.info().attach('renderer-outage-native-failure.json', {
        body: JSON.stringify({ windowId: initialNative.id, ...failure }), contentType: 'application/json',
      })
    } finally { await native.dispose() }
    await expect.poll(() => recoveryEvents().slice(logOffset)
      .some(e => e.event === 'main_window_recovery_circuit_open'), { timeout: 60_000 }).toBe(true)
    await expect.poll(() => recoveryEvents().slice(logOffset)
      .filter(e => e.event === 'main_window_recovery_started').length,
    { timeout: 90_000 }).toBeGreaterThanOrEqual(4)
    await expect.poll(() => Date.now() - outageStarted, { timeout: 15_000 }).toBeGreaterThan(65_000)
    expect(recoveryEvents().slice(logOffset).filter(e => e.event === 'main_window_recovery_succeeded')).toEqual([])
    const restoredAt = Date.now()
    server = new RustServer({ port, token, homeDir: serverHome, preserveHomeOnStop: true,
      expectedBuildCommit: requireElectronE2eBuildId(), expectedBuildDirty: false })
    serverInfo = await server.start()
    // No client navigation, crash event, reload, or restart is supplied after endpoint restoration.
    await expect.poll(() => recoveryEvents().slice(logOffset)
      .some(e => e.event === 'main_window_recovery_succeeded'), { timeout: 75_000 }).toBe(true)
    const recovered = await waitForWindowUrl(app,
      new RegExp(`^${escapeRegExp(serverInfo.baseUrl)}(?:[/?#]|$)`), 15_000)
    await expectNativeRecovery(app, recovered, initialNative)
    await expect(recovered.locator('text=New Tab').first()).toBeVisible({ timeout: 15_000 })
    expect(await recovered.evaluate(() => window.freshellDesktop?.getHostname?.())).toBe(os.hostname())
    await recovered.locator('button[title^="Settings"]').click()
    await expect(recovered.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible()
    await test.info().attach('renderer-outage-timing.json', {
      body: JSON.stringify({ outageStarted, restoredAt, recoveredAt: Date.now(),
        offlineMs: restoredAt - outageStarted, postRestoreClientTrigger: false,
        successWhileOffline: 0, sourceCommit: requireElectronE2eBuildId() }),
      contentType: 'application/json',
    })
  })

  test('recovers the main Freshell UI after the renderer process crashes', async () => {
    server = new RustServer({
      expectedBuildCommit: requireElectronE2eBuildId(),
      expectedBuildDirty: false,
    })
    serverInfo = await server.start()
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
    const initialNative = await prepareNativeWindow(app, firstWindow)

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
    await expectNativeRecovery(app, recoveredWindow, initialNative)
    await recoveredWindow.waitForLoadState('domcontentloaded')
    await expect(recoveredWindow.locator('text=New Tab').first()).toBeVisible({ timeout: 30_000 })
    // The client may apply its one-time stale-build reload after the first
    // recovered DOM becomes visible. Wait for that navigation to settle
    // before injecting the renderer-side IPC probe below.
    await recoveredWindow.waitForLoadState('networkidle')

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
    await startRemoteServer()
    tmpHome = createTempHome()
  })

  test.afterEach(async () => {
    const appToClose = app
    const homeToRemove = tmpHome
    app = undefined
    tmpHome = undefined
    await cleanupElectronFixture({
      app: appToClose,
      electronProcess: appToClose ? electronProcesses.get(appToClose) : undefined,
      stopServer: stopRemoteServer,
      removeHome: homeToRemove ? async () => { fs.rmSync(homeToRemove, { recursive: true, force: true }) } : undefined,
    })
  })

  test('shows wizard on first launch and completes setup', async () => {
    const serverInfo = requireRemoteServerInfo()
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
    await wizardPage.locator('#remote-url').fill(serverInfo.baseUrl)
    await wizardPage.locator('#remote-token').fill(serverInfo.token)
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
    expect(savedConfig.remoteUrl).toBe(serverInfo.baseUrl)
  })
})

// ---------------------------------------------------------------------------
// Test: Launch chooser
// ---------------------------------------------------------------------------

test.describe('Launch chooser', () => {
  let app: ElectronApplication
  let tmpHome: string

  test.beforeEach(async () => {
    await startRemoteServer()
  })

  test.afterEach(async () => {
    const appToClose = app
    const homeToRemove = tmpHome
    app = undefined
    tmpHome = undefined
    await cleanupElectronFixture({
      app: appToClose,
      electronProcess: appToClose ? electronProcesses.get(appToClose) : undefined,
      stopServer: stopRemoteServer,
      removeHome: homeToRemove ? async () => { fs.rmSync(homeToRemove, { recursive: true, force: true }) } : undefined,
    })
  })

  test('shows launch chooser when alwaysAskOnLaunch is true', async () => {
    tmpHome = createTempHome({ ...remoteConfig(requireRemoteServerInfo()), alwaysAskOnLaunch: true })

    app = await launchApp(tmpHome)
    const chooser = await app.firstWindow()
    await chooser.waitForLoadState('domcontentloaded')

    await expect(chooser.getByRole('heading', { name: 'Choose Freshell server' })).toBeVisible()
    await expect(chooser.getByRole('checkbox', { name: 'Always ask on launch' })).toBeChecked()
  })

  test('connects to its injected owned-server candidate from chooser', async () => {
    const serverInfo = requireRemoteServerInfo()
    tmpHome = createTempHome({ ...remoteConfig(serverInfo), alwaysAskOnLaunch: true })
    const candidate: LaunchServerCandidate = {
      id: `electron-e2e-owned-${serverInfo.port}`,
      url: serverInfo.baseUrl,
      origin: 'known',
      ownership: 'detected-local',
      label: `Owned fixture ${serverInfo.port}`,
      requiresAuth: true,
    }

    app = await launchApp(tmpHome, false, candidate)
    const chooser = await app.firstWindow()
    await chooser.waitForLoadState('domcontentloaded')

    // The injected candidate is the test-owned ephemeral Rust server. This
    // exercises the real chooser candidate route without scanning :3001.
    await expect(chooser.getByText(candidate.label!, { exact: true })).toBeVisible()
    await chooser.getByLabel(`Token for ${candidate.label}`).fill(serverInfo.token)
    await chooser.getByRole('button', { name: `Connect to ${candidate.label}` }).click()
    const mainPage = await waitForWindowUrl(
      app,
      new RegExp(`^${escapeRegExp(serverInfo.baseUrl)}(?:[/?#]|$)`),
      60_000,
    )
    await mainPage.waitForLoadState('domcontentloaded')

    await expect(mainPage).toHaveURL(new RegExp(`^${escapeRegExp(serverInfo.baseUrl)}(?:[/?#]|$)`))

    // This is the chooser-restart lifecycle contract. It must gracefully
    // quit within the fixture budget before exact owned server teardown.
    await expect(closeElectronGracefully(app)).resolves.toBeUndefined()
    const lifecycle = electronStdout.get(app)?.join('').split('\n')
      .flatMap((line) => {
        try { return [JSON.parse(line) as { event?: string; startupGeneration?: number }] } catch { return [] }
      }) ?? []
    for (const event of [
      'electron_before_quit',
      'electron_server_stop_started',
      'electron_server_stop_settled',
      'electron_continue_quit',
      'electron_will_quit',
    ]) {
      expect(lifecycle).toContainEqual(expect.objectContaining({ event, startupGeneration: 2 }))
    }
    app = undefined
    await expect(stopRemoteServer()).resolves.toBeUndefined()
    fs.rmSync(tmpHome, { recursive: true, force: true })
    expect(fs.existsSync(tmpHome)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Test: Main Window (pre-seeded config, remote mode)
// ---------------------------------------------------------------------------

test.describe('Main window with remote server', () => {
  let app: ElectronApplication
  let tmpHome: string

  test.beforeEach(async () => {
    await startRemoteServer()
    tmpHome = createTempHome(remoteConfig(requireRemoteServerInfo()))
  })

  test.afterEach(async () => {
    const appToClose = app
    const homeToRemove = tmpHome
    app = undefined
    tmpHome = undefined
    await cleanupElectronFixture({
      app: appToClose,
      electronProcess: appToClose ? electronProcesses.get(appToClose) : undefined,
      stopServer: stopRemoteServer,
      removeHome: homeToRemove ? async () => { fs.rmSync(homeToRemove, { recursive: true, force: true }) } : undefined,
    })
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
    const serverInfo = requireRemoteServerInfo()
    app = await launchApp(tmpHome)
    const mainPage = await app.firstWindow()
    await mainPage.waitForLoadState('domcontentloaded')
    await mainPage.waitForTimeout(5000)

    // This is the isolation receipt: the test is connected to its own
    // ephemeral RustServer, has no inherited recovery offer, and still sees
    // the real launcher choices.
    expect(serverInfo.port).not.toBe(3001)
    await expect(mainPage).toHaveURL(new RegExp(`^${escapeRegExp(serverInfo.baseUrl)}(?:[/?#]|$)`))
    await expect(mainPage.getByTestId('recovery-offer-panel')).toHaveCount(0)

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
