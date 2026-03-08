export interface WizardWindowOptions {
  isDev: boolean
  preloadPath?: string
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
    // In production, load the built wizard HTML
    // The path is relative to the app's resources directory
    void win.loadFile('dist/wizard/index.html')
  }

  return win
}
