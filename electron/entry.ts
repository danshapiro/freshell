// Real Electron entry point -- the one file that bridges dependency injection to real APIs.
//
// This file imports from 'electron' directly, so it can only run inside Electron's
// runtime. It is NOT unit-testable (and doesn't need to be -- all logic lives in
// the DI modules which are fully tested).
//
// Build: tsc -p tsconfig.electron.json
// Run:   electron dist/electron/electron/entry.js
//        (or via electron-builder's packaged app)

import { app, BrowserWindow, globalShortcut, ipcMain, Tray, Menu, nativeImage } from 'electron'
import path from 'path'
import os from 'os'
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
import { buildAppMenu } from './menu.js'
import { runStartup, type StartupContext, type BrowserWindowLike } from './startup.js'
import { initMainProcess } from './main.js'
import { createWizardWindow } from './setup-wizard/wizard-window.js'

const isDev = process.env.ELECTRON_DEV === '1'
const configDir = path.join(os.homedir(), '.freshell')

async function main(): Promise<void> {
  // Wait for Electron to be ready before creating any BrowserWindow or using
  // Electron APIs that require the app to be initialized.
  await app.whenReady()

  // Prevent default quit-on-all-windows-closed during wizard-to-main transition.
  // Without this, closing the wizard window on Windows/Linux kills the app before
  // main() can re-run and create the main window. initMainProcess() later adds
  // its own handler that calls app.quit() on non-macOS when appropriate.
  // Guard with listenerCount so we only register once across recursive main() calls.
  if (!app.listenerCount('window-all-closed')) {
    app.on('window-all-closed', () => {
      // Intentionally empty -- keeps app alive during wizard flow.
    })
  }

  // Read desktop config (or use defaults for first run)
  const desktopConfig = (await readDesktopConfig()) ?? getDefaultDesktopConfig()
  const port = desktopConfig.port ?? 3001

  // Create DI implementations
  const resourcesPath = isDev ? undefined : process.resourcesPath
  const daemonManager = await createDaemonManager(resourcesPath)
  const serverSpawner = createServerSpawner()
  const hotkeyManager = createHotkeyManager(globalShortcut)
  const windowStatePersistence = createWindowStatePersistence()

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
    daemonManager,
    serverSpawner,
    hotkeyManager,
    windowStatePersistence,
    updateManager,
    isDev,
    port,
    resourcesPath,
    configDir,
    platform: process.platform,
    createBrowserWindow: (options) => {
      const win = new BrowserWindow({
        ...options,
        webPreferences: {
          ...options.webPreferences,
          preload: path.join(__dirname, 'preload.js'),
        },
      })
      // Cast to BrowserWindowLike -- Electron's BrowserWindow satisfies the interface
      return win as unknown as BrowserWindowLike
    },
    createTray: () => {
      const iconName = process.platform === 'win32' ? 'tray-icon-win.ico' : 'tray-icon.png'
      const iconPath = isDev
        ? path.join(__dirname, '..', '..', 'assets', 'electron', iconName)
        : path.join(process.resourcesPath!, 'assets', iconName)

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
    })
  })

  // Run startup sequence
  const result = await runStartup(ctx)

  if (result.type === 'wizard') {
    // Show the setup wizard
    const wizardWin = createWizardWindow(BrowserWindow as any, {
      isDev,
      preloadPath: path.join(__dirname, 'preload.js'),
      appPath: isDev ? undefined : app.getAppPath(),
    })

    // When wizard closes, re-read config and restart
    wizardWin.on('closed', () => {
      void main()
    })
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

// Start the app
void main()
