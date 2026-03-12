import { describe, it, expect, vi, beforeEach } from 'vitest'
import path from 'path'
import {
  createWizardWindow,
  type BrowserWindowConstructor,
  type WizardWindowOptions,
} from '../../../../electron/setup-wizard/wizard-window.js'

function createMockBrowserWindow() {
  const instances: any[] = []

  const MockBrowserWindow = vi.fn().mockImplementation((options: Record<string, any>) => {
    const win = {
      options,
      loadURL: vi.fn().mockResolvedValue(undefined),
      loadFile: vi.fn().mockResolvedValue(undefined),
    }
    instances.push(win)
    return win
  }) as unknown as BrowserWindowConstructor

  return { MockBrowserWindow, instances }
}

describe('createWizardWindow', () => {
  let MockBrowserWindow: BrowserWindowConstructor
  let instances: any[]

  beforeEach(() => {
    const mock = createMockBrowserWindow()
    MockBrowserWindow = mock.MockBrowserWindow
    instances = mock.instances
  })

  it('creates a BrowserWindow with correct dimensions and settings', () => {
    createWizardWindow(MockBrowserWindow, { isDev: true })

    expect(MockBrowserWindow).toHaveBeenCalledTimes(1)
    const opts = (MockBrowserWindow as any).mock.calls[0][0]
    expect(opts.width).toBe(640)
    expect(opts.height).toBe(500)
    expect(opts.resizable).toBe(false)
    expect(opts.center).toBe(true)
    expect(opts.autoHideMenuBar).toBe(true)
  })

  it('sets contextIsolation=true and nodeIntegration=false', () => {
    createWizardWindow(MockBrowserWindow, { isDev: true })

    const opts = (MockBrowserWindow as any).mock.calls[0][0]
    expect(opts.webPreferences.contextIsolation).toBe(true)
    expect(opts.webPreferences.nodeIntegration).toBe(false)
  })

  it('passes preload path to webPreferences', () => {
    createWizardWindow(MockBrowserWindow, {
      isDev: true,
      preloadPath: '/app/dist/electron/preload.js',
    })

    const opts = (MockBrowserWindow as any).mock.calls[0][0]
    expect(opts.webPreferences.preload).toBe('/app/dist/electron/preload.js')
  })

  describe('dev mode', () => {
    it('loads dev server URL via loadURL', () => {
      createWizardWindow(MockBrowserWindow, { isDev: true })

      expect(instances[0].loadURL).toHaveBeenCalledWith('http://localhost:5174')
      expect(instances[0].loadFile).not.toHaveBeenCalled()
    })
  })

  describe('production mode', () => {
    it('loads wizard HTML via loadFile with appPath when provided', () => {
      createWizardWindow(MockBrowserWindow, {
        isDev: false,
        appPath: '/app/resources/app.asar',
      })

      const expectedPath = path.join('/app/resources/app.asar', 'dist', 'wizard', 'index.html')
      expect(instances[0].loadFile).toHaveBeenCalledWith(expectedPath)
      expect(instances[0].loadURL).not.toHaveBeenCalled()
    })

    it('falls back to relative path when appPath is not provided', () => {
      createWizardWindow(MockBrowserWindow, { isDev: false })

      const expectedPath = path.join('dist', 'wizard', 'index.html')
      expect(instances[0].loadFile).toHaveBeenCalledWith(expectedPath)
    })
  })

  it('returns the created window instance', () => {
    const win = createWizardWindow(MockBrowserWindow, { isDev: true })
    expect(win).toBe(instances[0])
  })
})
