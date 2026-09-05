// Real Electron entry point -- the one file that bridges dependency injection to real APIs.
//
// This file imports from 'electron' directly, so it can only run inside Electron's
// runtime. It is NOT unit-testable (and doesn't need to be -- all logic lives in
// the DI modules which are fully tested).
//
// Build: tsc -p tsconfig.electron.json
// Run:   electron dist/electron/electron/entry.js
//        (or via electron-builder's packaged app)

import { app, BrowserWindow, globalShortcut, ipcMain, Tray, Menu, nativeImage, shell } from 'electron'
import path from 'path'
import os from 'os'
import http from 'http'
import https from 'https'
import fs from 'fs'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

import { readDesktopConfig, patchDesktopConfig } from './desktop-config.js'
import { getDefaultDesktopConfig } from './desktop-config.js'
import { createDaemonManager } from './daemon/create-daemon-manager.js'
import { createServerSpawner } from './server-spawner.js'
import { createHotkeyManager } from './hotkey.js'
import { createWindowStatePersistence } from './window-state.js'
import { createUpdateManager } from './updater.js'
import { createTray } from './tray.js'
import { resolveTrayIconPath } from './icon-path.js'
import { buildAppMenu } from './menu.js'
import { runStartup, type StartupContext, type BrowserWindowLike } from './startup.js'
import { acquireInstanceLock, initMainProcess } from './main.js'
import {
  DEFAULT_PROFILE_ID,
  buildPickerEntries,
  readProfilesRegistry,
  registryPathForHome,
  resolveBootShape,
  stripProfileArgs,
  type PickerEntry,
} from './profile.js'
import { createChooseProfileHandler } from './profile-choice-handler.js'
import { createWizardWindow } from './setup-wizard/wizard-window.js'
import { createChooseLaunchOptionHandler } from './launch-choice-handler.js'
import { buildLaunchOptions } from './launch-options.js'
import { applyProvisioningFile } from './desktop-provisioning.js'
import { createPortAvailabilityCheck } from './port-check.js'
import { registerOpenExternalHandler } from './external-url.js'
import { createElectronMainLogger } from './main-process-logger.js'
import type { ForcedLaunch, LaunchServerCandidate } from './types.js'
import type { RecoverableWebContents } from './renderer-recovery.js'

const isPortAvailable = createPortAvailabilityCheck()

const isDev = process.env.ELECTRON_DEV === '1'

// --- Boot-shape resolution (must run before configDir/logger binding) -------
// One process = one Chromium userData = one instance lock, ALWAYS. Named
// profiles (--profile=<id> or FRESHELL_PROFILE) and the picker launcher each
// get their own userData dir — which also re-keys the single-instance lock —
// so the picker NEVER shares a userData dir with a resident Default instance
// (two browser processes on one profile dir is a Chromium storage hazard).
const registryAtBoot = readProfilesRegistry(
  registryPathForHome(os.homedir()),
  (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : undefined),
)
const bootShape = resolveBootShape(
  process.argv, process.env, registryAtBoot,
  app.getName(), app.getPath('appData'), os.homedir(),
)
if (bootShape.userDataDir) {
  // Electron's doc contract for app.setPath: the target directory must
  // exist. Create-first is the documented-correct order.
  fs.mkdirSync(bootShape.userDataDir, { recursive: true })
  app.setPath('userData', bootShape.userDataDir)
}
const activeProfileId = bootShape.profileId
const isPickerLauncher = bootShape.kind === 'picker'
const configDir = bootShape.configDir
const mainProcessLogger = createElectronMainLogger({ configDir })
if (registryAtBoot.error) {
  mainProcessLogger.log({ severity: 'warn', event: 'profiles_registry_invalid', error: registryAtBoot.error })
}
if (bootShape.error) {
  mainProcessLogger.log({ severity: 'warn', event: 'profile_selection_invalid', error: bootShape.error })
}

/** True once this process holds its (userData-keyed) instance lock;
 *  re-entrant main() calls (wizard completion) must not re-request it. */
let instanceLockHeld = false

/**
 * Show the profile picker and relaunch into the chosen profile.
 *
 * This launcher process holds the LAUNCHER-scoped instance lock (own
 * userData dir), so a racing flag-less launch is turned away at the lock gate
 * and delivers `second-instance` here, where we surface the existing picker
 * window. Every confirmed choice — Default included — relaunches with an
 * explicit `--profile=<id>` and exits; the relaunched process then takes the
 * chosen profile's own lock. The returned promise never settles.
 * Closing the picker without choosing exits the app.
 */
async function runProfilePicker(entries: PickerEntry[]): Promise<void> {
  const pickerWin = new BrowserWindow({
    width: 520,
    height: 480,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  })
  const pickerWebContentsId = pickerWin.webContents.id
  // Duplicate flag-less launches are surfaced by the canonical handler
  // installed in main() (covers all windows), so the picker doesn't add one.

  const cleanup = () => {
    ipcMain.removeHandler('get-profiles')
    ipcMain.removeHandler('choose-profile')
  }

  ipcMain.removeHandler('get-profiles')
  ipcMain.removeHandler('choose-profile')
  ipcMain.handle('get-profiles', (event) => {
    if ((event as { sender?: { id?: number } }).sender?.id !== pickerWebContentsId) return []
    return entries
  })
  ipcMain.handle('choose-profile', createChooseProfileHandler({
    entries,
    isAllowedSender: (event) =>
      (event as { sender?: { id?: number } }).sender?.id === pickerWebContentsId,
    relaunchWithProfile: (id) => {
      const args = [...stripProfileArgs(process.argv.slice(1)), `--profile=${id}`]
      app.relaunch({ args })
      app.exit(0)
    },
  }))

  pickerWin.on('closed', () => {
    cleanup()
    app.exit(0)
  })

  try {
    if (isDev) {
      await pickerWin.loadURL('http://localhost:5179')
    } else {
      const packaged = path.join(process.resourcesPath, 'profile-picker', 'index.html')
      const unpackaged = path.join(app.getAppPath(), 'dist', 'profile-picker', 'index.html')
      await pickerWin.loadFile(fs.existsSync(packaged) ? packaged : unpackaged)
    }
  } catch (err) {
    // The picker is the default boot path once profiles.json exists — log the
    // failure loudly and still show the (broken) window so the user can close
    // it instead of the app dying as a background zombie.
    mainProcessLogger.log({ severity: 'error', event: 'profile_picker_load_failed', error: err instanceof Error ? err.message : String(err) })
  }
  pickerWin.show()
  return new Promise<void>(() => {
    // Never settles: this launcher exits via app.exit(0) on choice or close.
  })
}

type EntryBrowserWindow = InstanceType<typeof BrowserWindow>
type WindowListener = { event: string; callback: (...args: any[]) => void }

function createRecoverableEntryWindow(
  options: Record<string, any>,
  preloadPath: string,
  onWebContentsChanged: (webContentsId: number) => void,
): BrowserWindowLike {
  const windowListeners: WindowListener[] = []
  const webContentsListeners: WindowListener[] = []
  let lastLoadUrl: string | undefined
  let activeWindow: EntryBrowserWindow
  let replacingWindow = false

  const createNativeWindow = (nativeOptions: Record<string, any>) => {
    const win = new BrowserWindow({
      ...nativeOptions,
      webPreferences: {
        ...nativeOptions.webPreferences,
        preload: preloadPath,
      },
    })

    for (const { event, callback } of windowListeners) {
      win.on(event as any, callback)
    }
    for (const { event, callback } of webContentsListeners) {
      win.webContents.on(event as any, callback)
    }

    return win
  }

  const getRecoveryUrl = (fallbackWindow: EntryBrowserWindow): string | undefined => {
    if (lastLoadUrl) return lastLoadUrl
    try {
      return fallbackWindow.webContents.getURL()
    } catch {
      return undefined
    }
  }

  const replaceCrashedWindow = async () => {
    if (replacingWindow) return
    replacingWindow = true

    let recoveryUrl: string | undefined
    let replacement: EntryBrowserWindow | undefined

    try {
      const crashedWindow = activeWindow
      recoveryUrl = getRecoveryUrl(crashedWindow)
      if (!recoveryUrl) {
        throw new Error('main window recovery URL unavailable')
      }

      const bounds = crashedWindow.getBounds()
      const wasVisible = crashedWindow.isVisible()
      const wasFocused = crashedWindow.isFocused()
      const wasMaximized = crashedWindow.isMaximized()
      replacement = createNativeWindow({
        ...options,
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        show: false,
      })

      await replacement.loadURL(recoveryUrl)
      activeWindow = replacement
      onWebContentsChanged(replacement.webContents.id)

      if (wasMaximized) {
        replacement.maximize()
      }
      if (wasVisible) {
        replacement.show()
      }
      if (wasFocused) {
        replacement.focus()
      }
      if (!crashedWindow.isDestroyed()) {
        crashedWindow.destroy()
      }
    } catch (error) {
      if (replacement && !replacement.isDestroyed()) {
        replacement.destroy()
      }
      mainProcessLogger.log({
        severity: 'error',
        event: 'main_window_replacement_failed',
        loadUrl: recoveryUrl,
        error,
      })
      throw error
    } finally {
      replacingWindow = false
    }
  }

  activeWindow = createNativeWindow(options)
  onWebContentsChanged(activeWindow.webContents.id)

  const webContentsProxy: RecoverableWebContents = {
    get id() {
      return activeWindow.webContents.id
    },
    on(event, callback) {
      webContentsListeners.push({ event, callback })
      activeWindow.webContents.on(event as any, callback)
    },
    getURL() {
      return activeWindow.webContents.getURL()
    },
    isDestroyed() {
      return activeWindow.webContents.isDestroyed()
    },
    reload() {
      return replaceCrashedWindow()
    },
    forcefullyCrashRenderer() {
      activeWindow.webContents.forcefullyCrashRenderer()
    },
  }

  const windowProxy = {
    get webContents() {
      return webContentsProxy
    },
    loadURL(url: string, loadOptions?: Parameters<EntryBrowserWindow['loadURL']>[1]) {
      lastLoadUrl = url
      return activeWindow.loadURL(url, loadOptions)
    },
    show() {
      activeWindow.show()
    },
    hide() {
      activeWindow.hide()
    },
    focus() {
      activeWindow.focus()
    },
    maximize() {
      activeWindow.maximize()
    },
    isVisible() {
      return activeWindow.isVisible()
    },
    isFocused() {
      return activeWindow.isFocused()
    },
    isDestroyed() {
      return activeWindow.isDestroyed()
    },
    getBounds() {
      return activeWindow.getBounds()
    },
    isMaximized() {
      return activeWindow.isMaximized()
    },
    isMinimized() {
      return activeWindow.isMinimized()
    },
    restore() {
      activeWindow.restore()
    },
    on(event: string, callback: (...args: any[]) => void) {
      windowListeners.push({ event, callback })
      activeWindow.on(event as any, callback)
    },
  }

  return windowProxy as BrowserWindowLike
}

/** True during the wizard flow; prevents app.quit() on window-all-closed. */
let wizardPhase = true

/**
 * An explicit chooser selection to honor on the next main() pass. Set by the
 * choose-launch-option handler before it restarts the launch flow, consumed
 * once at the top of main().
 */
let pendingForcedLaunch: ForcedLaunch | undefined

async function main(): Promise<void> {
  // Wait for Electron to be ready before creating any BrowserWindow or using
  // Electron APIs that require the app to be initialized.
  await app.whenReady()
  mainProcessLogger.log({
    severity: 'info',
    event: 'electron_main_started',
    appVersion: app.getVersion(),
    isDev,
    profile: activeProfileId,
  })

  // Instance lock, acquired BEFORE any side effects (provisioning, server
  // spawn). Keyed to the userData dir chosen at module top: an explicit
  // profile's own dir, the default dir for a plain launch, or the launcher
  // dir for a picker launch. A same-profile duplicate quits here (delivering
  // `second-instance` to the resident, which then shows its window).
  //
  // The onDenied hook lifts the `will-quit` wizard-phase veto: at this point
  // `wizardPhase` is still true (it only flips false once a chooser/main
  // window is reached), and entry.ts's module-level `will-quit` guard would
  // otherwise preventDefault() this quit, leaving the turned-away duplicate
  // as a headless zombie process. A denied duplicate never enters the wizard,
  // so flipping it is unconditionally correct here.
  if (!instanceLockHeld) {
    if (!acquireInstanceLock(app, () => { wizardPhase = false })) {
      return
    }
    instanceLockHeld = true
  }

  // Canonical duplicate-launch surfacing, registered ONCE, as early as
  // possible: covers the wizard, chooser, and (until initMainProcess's own
  // handler supersedes it for the main window) every intermediate phase.
  if (!app.listenerCount('second-instance')) {
    app.on('second-instance', () => {
      const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
      if (!win) return
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    })
  }

  // --- Profile picker -------------------------------------------------------
  // A picker launch (no explicit profile + registry names ≥1 profile) parks
  // its userData in the launcher dir, holds the launcher lock, shows only the
  // picker, and ends here. See resolveBootShape (module top) for the shape
  // decision and runProfilePicker for choice semantics.
  if (isPickerLauncher) {
    await runProfilePicker(buildPickerEntries(registryAtBoot))
    return
  }

  // Consolidated window-all-closed handler: during the wizard phase we keep
  // the app alive so main() can re-run after the wizard closes. Once the main
  // window is up (wizardPhase = false), quit on non-macOS as is standard.
  // Guard with listenerCount so we only register once across recursive main() calls.
  if (!app.listenerCount('window-all-closed')) {
    app.on('window-all-closed', () => {
      if (wizardPhase) return  // Keep alive during wizard-to-main transition
      if (process.platform !== 'darwin') {
        app.quit()
      }
    })
  }

  // Apply one-time provisioning from a silent install. The installer writes raw
  // values to desktop.provision (it cannot escape JSON); we convert them into a
  // properly-serialized desktop.json here, then remove the provision file.
  await applyProvisioningFile(path.join(configDir, 'desktop.provision'), {
    readFile: (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : undefined),
    deleteFile: (p) => {
      try {
        fs.rmSync(p, { force: true })
      } catch {
        /* best-effort cleanup */
      }
    },
    patchDesktopConfig: (p) => patchDesktopConfig(p, configDir),
  })

  // Consume any pending forced launch (set by the chooser handler before it
  // restarted main). It must apply only to this pass.
  const forcedLaunch = pendingForcedLaunch
  pendingForcedLaunch = undefined

  // Read desktop config (or use defaults for first run)
  const desktopConfig = (await readDesktopConfig(configDir)) ?? getDefaultDesktopConfig()
  const port = desktopConfig.port ?? 3001

  // Create DI implementations
  const resourcesPath = isDev ? undefined : process.resourcesPath
  const daemonManager = await createDaemonManager(resourcesPath)
  const serverSpawner = createServerSpawner()
  const hotkeyManager = createHotkeyManager(globalShortcut)
  const windowStatePersistence = createWindowStatePersistence(configDir)

  // autoUpdater is only available when the app is packaged.
  // In dev mode, provide a no-op stub.
  let updateManager: StartupContext['updateManager']
  if (isDev) {
    updateManager = {
      checkForUpdates: async () => {},
      downloadUpdate: async () => {},
      installAndRestart: () => {},
      on: () => {},
    }
  } else {
    // electron-updater's autoUpdater is a separate package import.
    // It may not be available if the package wasn't bundled (e.g. unsigned builds).
    try {
      const { autoUpdater } = await import('electron-updater')
      updateManager = createUpdateManager(autoUpdater)
    } catch {
      console.warn('electron-updater not available, auto-updates disabled')
      updateManager = {
        checkForUpdates: async () => {},
        downloadUpdate: async () => {},
        installAndRestart: () => {},
        on: () => {},
      }
    }
  }

  // Construct the startup context
  const ctx: StartupContext = {
    desktopConfig,
    forcedLaunch,
    profileId: activeProfileId,
    // Default is just another tenant in a multi-profile install: once the
    // registry names any named profile, even the default boot owns its own
    // server (skips discovery auto-connect, auto-bumps a busy port).
    ownsServer: activeProfileId !== DEFAULT_PROFILE_ID || registryAtBoot.profiles.length > 0,
    daemonManager,
    serverSpawner,
    hotkeyManager,
    windowStatePersistence,
    updateManager,
    isDev,
    port,
    resourcesPath,
    configDir,
    mainProcessLogger,
    isPortAvailable,
    patchDesktopConfig: (patch: { port?: number }) => patchDesktopConfig(patch, configDir),
    platform: process.platform,
    fetchHealthCheck: (url: string): Promise<boolean> => {
      // Use Node's http module instead of global fetch() — Electron's main
      // process fetch can hang in certain lifecycle states (e.g. after wizard
      // window closes and the app re-enters main()).
      return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), 10_000)
        const req = http.get(url, (res) => {
          clearTimeout(timer)
          resolve(res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 400)
          res.resume() // Drain the response
        })
        req.on('error', () => {
          clearTimeout(timer)
          resolve(false)
        })
      })
    },
    fetchAuthenticated: (url: string, token: string): Promise<boolean> => {
      return new Promise((resolve) => {
        let parsed: URL
        try {
          parsed = new URL(url)
        } catch {
          resolve(false)
          return
        }

        const client = parsed.protocol === 'https:' ? https : http
        const timer = setTimeout(() => resolve(false), 10_000)
        const req = client.get(parsed, { headers: { 'x-auth-token': token } }, (res) => {
          clearTimeout(timer)
          resolve(res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 400)
          res.resume()
        })
        req.on('error', () => {
          clearTimeout(timer)
          resolve(false)
        })
      })
    },
    readEnvToken: async (envPath: string): Promise<string | undefined> => {
      try {
        const fsp = await import('fs/promises')
        const content = await fsp.readFile(envPath, 'utf-8')
        for (const line of content.split('\n')) {
          const trimmed = line.trim()
          if (trimmed.startsWith('AUTH_TOKEN=')) {
            const value = trimmed.slice('AUTH_TOKEN='.length).trim()
            // Strip surrounding quotes if present
            if ((value.startsWith('"') && value.endsWith('"')) ||
                (value.startsWith("'") && value.endsWith("'"))) {
              return value.slice(1, -1)
            }
            return value
          }
        }
        return undefined
      } catch {
        return undefined
      }
    },
    createBrowserWindow: (options) => {
      return createRecoverableEntryWindow(
        options,
        path.join(__dirname, 'preload.js'),
        (webContentsId) => {
          mainWebContentsId = webContentsId
        },
      )
    },
    createTray: () => {
      const iconPath = resolveTrayIconPath({
        platform: process.platform,
        isDev,
        moduleDir: __dirname,
        resourcesPath: process.resourcesPath,
      })

      createTray(
        Tray as any,
        Menu as any,
        iconPath,
        {
          onShow: () => {
            const wins = BrowserWindow.getAllWindows()
            if (wins.length > 0) {
              wins[0].show()
              wins[0].focus()
            }
          },
          onHide: () => {
            const wins = BrowserWindow.getAllWindows()
            if (wins.length > 0) {
              wins[0].hide()
            }
          },
          onSettings: () => {
            // Navigate the main window to settings
            const wins = BrowserWindow.getAllWindows()
            if (wins.length > 0) {
              wins[0].show()
              wins[0].focus()
            }
          },
          onCheckUpdates: () => {
            void updateManager.checkForUpdates()
          },
          onQuit: () => {
            app.quit()
          },
          getServerStatus: async () => {
            return {
              running: serverSpawner.isRunning(),
              mode: desktopConfig.serverMode,
            }
          },
        },
        { tooltip: activeProfileId === DEFAULT_PROFILE_ID ? 'Freshell' : `Freshell (${activeProfileId})` },
      )
    },
  }

  // Remove any previously registered IPC handlers (main() is called again
  // after the wizard closes, so we need to avoid duplicate handler errors).
  ipcMain.removeHandler('complete-setup')
  ipcMain.removeHandler('get-server-mode')
  ipcMain.removeHandler('get-server-status')
  ipcMain.removeHandler('set-global-hotkey')
  ipcMain.removeHandler('install-update')
  ipcMain.removeHandler('get-launch-options')
  ipcMain.removeHandler('choose-launch-option')
  ipcMain.removeHandler('open-external-url')

  let pendingLaunchChooser: { candidates: LaunchServerCandidate[]; reason: string } | undefined
  // webContents id of the launch window, so choose-launch-option only
  // honors requests originating from it (the API is exposed to every window).
  let chooserWebContentsId: number | undefined

  // Identity of the main Freshell window (webContents id + expected origin).
  // The open-external-url handler only honors requests from this window and
  // origin so other renderer surfaces or navigations cannot drive
  // shell.openExternal.
  let mainWebContentsId: number | undefined = undefined
  let mainServerUrl: string | undefined = undefined

  function getExpectedOrigin(): string | undefined {
    if (!mainServerUrl) return undefined
    try {
      return new URL(mainServerUrl).origin
    } catch {
      return undefined
    }
  }

  // Register system-browser link handler.
  registerOpenExternalHandler({
    ipcMain,
    shell,
    isAllowedSender: (event) => {
      const typed = event as {
        sender?: { id?: number }
        senderFrame?: { url?: string }
      }
      const senderId = typed.sender?.id
      if (mainWebContentsId === undefined || senderId !== mainWebContentsId) {
        return false
      }
      const expectedOrigin = getExpectedOrigin()
      if (!expectedOrigin) return false
      const frameUrl = typed.senderFrame?.url
      if (!frameUrl) return false
      try {
        return new URL(frameUrl).origin === expectedOrigin
      } catch {
        return false
      }
    },
  })

  // Register the complete-setup handler before runStartup so it is available
  // when the wizard renderer calls it via the preload API.
  ipcMain.handle('complete-setup', async (_event, config: {
    serverMode: string
    port: number
    remoteUrl: string
    remoteToken: string
    globalHotkey: string
  }) => {
    await patchDesktopConfig({
      serverMode: config.serverMode as 'daemon' | 'app-bound' | 'remote',
      port: config.port,
      remoteUrl: config.remoteUrl || undefined,
      remoteToken: config.remoteToken || undefined,
      globalHotkey: config.globalHotkey,
      setupCompleted: true,
    }, configDir)
  })

  ipcMain.handle('get-launch-options', () =>
    buildLaunchOptions({ pending: pendingLaunchChooser, desktopConfig }),
  )

  ipcMain.handle('choose-launch-option', createChooseLaunchOptionHandler({
    patchDesktopConfig: (patch) => patchDesktopConfig(patch, configDir),
    getCurrentPort: () => desktopConfig.port,
    validateServerAuth: (url: string, token: string) => ctx.fetchAuthenticated?.(`${url}/api/settings`, token) ?? Promise.resolve(false),
    isAllowedSender: (event) => {
      const senderId = (event as { sender?: { id?: number } }).sender?.id
      return chooserWebContentsId !== undefined && senderId === chooserWebContentsId
    },
    isPortAvailable,
    restartMain: async (forced: ForcedLaunch) => {
      pendingForcedLaunch = forced
      wizardPhase = true
      for (const win of BrowserWindow.getAllWindows()) {
        win.close()
      }
      setTimeout(() => {
        main().catch((err) => {
          console.error('Failed to restart after launch choice:', err)
        })
      }, 250)
    },
  }))

  // Run startup sequence
  const result = await runStartup(ctx)

  if (result.type === 'wizard') {
    // Show the setup wizard
    const wizardWin = createWizardWindow(BrowserWindow as any, {
      isDev,
      preloadPath: path.join(__dirname, 'preload.js'),
      appPath: isDev ? undefined : app.getAppPath(),
    })

    // When wizard closes, re-read config and restart.
    // Use setTimeout to defer to a clean event loop tick — calling main()
    // synchronously inside the 'closed' handler can block I/O callbacks.
    wizardWin.on('closed', () => {
      setTimeout(() => {
        main().catch((err) => {
          console.error('Failed to restart after wizard:', err)
        })
      }, 500)
    })
    return
  }

  if (result.type === 'chooser') {
    wizardPhase = false
    pendingLaunchChooser = {
      candidates: result.candidates,
      reason: result.reason,
    }

    const chooserWin = new BrowserWindow({
      width: 760,
      height: 720,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        nodeIntegration: false,
        contextIsolation: true,
      },
    })
    // Only this window may drive choose-launch-option (see isAllowedSender).
    chooserWebContentsId = chooserWin.webContents.id

    if (isDev) {
      await chooserWin.loadURL('http://localhost:5175')
    } else {
      const packagedChooser = path.join(process.resourcesPath, 'launch-chooser', 'index.html')
      const unpackagedChooser = path.join(app.getAppPath(), 'dist', 'launch-chooser', 'index.html')
      await chooserWin.loadFile(fs.existsSync(packagedChooser) ? packagedChooser : unpackagedChooser)
    }
    chooserWin.show()
    return
  }

  // Register IPC handlers for the main window's renderer process
  ipcMain.handle('get-server-mode', () => desktopConfig.serverMode)

  ipcMain.handle('get-server-status', async () => ({
    running: serverSpawner.isRunning(),
    mode: desktopConfig.serverMode,
  }))

  ipcMain.handle('set-global-hotkey', (_event, accelerator: string) => {
    return hotkeyManager.update(accelerator, () => {
      // Toggle the main window visibility when the hotkey is pressed
      const wins = BrowserWindow.getAllWindows()
      if (wins.length > 0) {
        if (wins[0].isVisible()) {
          wins[0].hide()
        } else {
          wins[0].show()
          wins[0].focus()
        }
      }
    })
  })

  ipcMain.handle('install-update', () => {
    updateManager.installAndRestart()
  })

  // Build the application menu
  buildAppMenu(Menu as any, {
    onPreferences: () => {
      result.window.show()
      result.window.focus()
    },
    onCheckUpdates: () => {
      void updateManager.checkForUpdates()
    },
    appVersion: app.getVersion(),
    isMac: process.platform === 'darwin',
  })

  // Main window is about to be created -- leave wizard phase so the
  // consolidated window-all-closed handler can quit when appropriate.
  wizardPhase = false

  // Remember the main window's webContents id and origin so privileged IPC
  // handlers can verify requests originate from the trusted renderer.
  mainWebContentsId = (result.window as unknown as BrowserWindow).webContents?.id
  mainServerUrl = result.serverUrl

  // Initialize the main process lifecycle (single-instance, close-to-tray, etc.)
  await initMainProcess({
    app,
    createMainWindow: async () => result.window,
    stopServer: async () => {
      clearTimeout(result.updateCheckTimer)
      hotkeyManager.unregister()
      await serverSpawner.stop()
    },
    minimizeToTray: desktopConfig.minimizeToTray,
    platform: process.platform,
  })
}

// Prevent Electron from quitting when all windows close during the wizard phase.
// The window-all-closed handler alone is not sufficient — Electron also fires
// will-quit independently, and without this guard the process exits before
// main() can re-run to create the main window.
app.on('will-quit', (e) => {
  if (wizardPhase) {
    e.preventDefault()
  }
})

// Start the app
void main()
