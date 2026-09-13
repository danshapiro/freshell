import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createTray, type TrayOptions, type TrayApi, type MenuApi, type MenuItemTemplate } from '../../../electron/tray.js'

describe('Tray', () => {
  let mockTrayInstance: any
  let MockTray: TrayApi
  let mockMenu: MenuApi
  let options: TrayOptions
  let capturedTemplate: MenuItemTemplate[]

  beforeEach(() => {
    mockTrayInstance = {
      setToolTip: vi.fn(),
      setContextMenu: vi.fn(),
      on: vi.fn(),
    }
    MockTray = vi.fn().mockReturnValue(mockTrayInstance) as any
    capturedTemplate = []
    mockMenu = {
      buildFromTemplate: vi.fn((template: MenuItemTemplate[]) => {
        capturedTemplate = template
        return { items: template }
      }),
    }
    options = {
      onShow: vi.fn(),
      onHide: vi.fn(),
      onSettings: vi.fn(),
      onCheckUpdates: vi.fn(),
      onQuit: vi.fn(),
      getServerStatus: vi.fn().mockResolvedValue({ running: true, mode: 'app-bound' }),
    }
  })

  it('creates tray with icon', () => {
    createTray(MockTray, mockMenu, '/path/to/icon.png', options)
    expect(MockTray).toHaveBeenCalledWith('/path/to/icon.png')
  })

  it('sets tooltip to Freshell', () => {
    createTray(MockTray, mockMenu, '/path/to/icon.png', options)
    expect(mockTrayInstance.setToolTip).toHaveBeenCalledWith('Freshell')
  })

  it('context menu has expected items', async () => {
    createTray(MockTray, mockMenu, '/path/to/icon.png', options)
    // Wait for async menu build
    await vi.waitFor(() => {
      expect(mockMenu.buildFromTemplate).toHaveBeenCalled()
    })

    const labels = capturedTemplate.map((item) => item.label || item.type)
    expect(labels).toContain('Show/Hide')
    expect(labels).toContain('Settings')
    expect(labels).toContain('Check for Updates')
    expect(labels).toContain('Quit')
  })

  it('server status is fetched and displayed', async () => {
    createTray(MockTray, mockMenu, '/path/to/icon.png', options)
    await vi.waitFor(() => {
      expect(mockMenu.buildFromTemplate).toHaveBeenCalled()
    })

    const statusItem = capturedTemplate.find((item) => item.label?.includes('Server:'))
    expect(statusItem).toBeDefined()
    expect(statusItem!.label).toContain('Running')
    expect(statusItem!.enabled).toBe(false)
  })

  it('Show/Hide click calls onShow callback', async () => {
    createTray(MockTray, mockMenu, '/path/to/icon.png', options)
    await vi.waitFor(() => {
      expect(mockMenu.buildFromTemplate).toHaveBeenCalled()
    })

    const showItem = capturedTemplate.find((item) => item.label === 'Show/Hide')
    showItem!.click!()
    expect(options.onShow).toHaveBeenCalled()
  })

  it('Quit click calls onQuit callback', async () => {
    createTray(MockTray, mockMenu, '/path/to/icon.png', options)
    await vi.waitFor(() => {
      expect(mockMenu.buildFromTemplate).toHaveBeenCalled()
    })

    const quitItem = capturedTemplate.find((item) => item.label === 'Quit')
    quitItem!.click!()
    expect(options.onQuit).toHaveBeenCalled()
  })
})
