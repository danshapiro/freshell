import path from 'path'

export interface WizardWindowOptions {
  isDev: boolean
  preloadPath?: string
  /** The ASAR app root path (from app.getAppPath()). Required in production. */
  appPath?: string
}

export interface BrowserWindowConstructor {
  new (options: Record<string, any>): any
}

export function createWizardWindow(
  BrowserWindow: BrowserWindowConstructor,
  options: WizardWindowOptions,
): any {
  const win = new BrowserWindow({
    width: 640,
    height: 500,
    resizable: false,
    center: true,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: options.preloadPath,
    },
  })

  if (options.isDev) {
    void win.loadURL('http://localhost:5174')
  } else {
    // In production, resolve the wizard HTML relative to the ASAR app root
    // so Electron finds it correctly inside the packaged app.
    const wizardHtml = options.appPath
      ? path.join(options.appPath, 'dist', 'wizard', 'index.html')
      : path.join('dist', 'wizard', 'index.html')
    void win.loadFile(wizardHtml)
  }

  return win
}
