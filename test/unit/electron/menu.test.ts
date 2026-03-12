import { describe, it, expect, vi, beforeEach } from 'vitest'
import { buildAppMenu, type MenuBuildApi, type MenuItemOptions } from '../../../electron/menu.js'

describe('buildAppMenu', () => {
  let mockMenu: MenuBuildApi
  let capturedTemplate: MenuItemOptions[]

  beforeEach(() => {
    capturedTemplate = []
    mockMenu = {
      buildFromTemplate: vi.fn((template: MenuItemOptions[]) => {
        capturedTemplate = template
        return { items: template }
      }),
      setApplicationMenu: vi.fn(),
    }
  })

  it('includes Edit menu with Undo, Redo, Cut, Copy, Paste, Select All', () => {
    buildAppMenu(mockMenu, {
      onPreferences: vi.fn(),
      onCheckUpdates: vi.fn(),
      appVersion: '0.6.0',
      isMac: false,
    })

    const editMenu = capturedTemplate.find((m) => m.label === 'Edit')
    expect(editMenu).toBeDefined()
    const roles = editMenu!.submenu!.map((item) => item.role).filter(Boolean)
    expect(roles).toContain('undo')
    expect(roles).toContain('redo')
    expect(roles).toContain('cut')
    expect(roles).toContain('copy')
    expect(roles).toContain('paste')
    expect(roles).toContain('selectAll')
  })

  it('includes View menu with Reload, Toggle DevTools, zoom controls', () => {
    buildAppMenu(mockMenu, {
      onPreferences: vi.fn(),
      onCheckUpdates: vi.fn(),
      appVersion: '0.6.0',
      isMac: false,
    })

    const viewMenu = capturedTemplate.find((m) => m.label === 'View')
    expect(viewMenu).toBeDefined()
    const roles = viewMenu!.submenu!.map((item) => item.role).filter(Boolean)
    expect(roles).toContain('reload')
    expect(roles).toContain('forceReload')
    expect(roles).toContain('toggleDevTools')
    expect(roles).toContain('zoomIn')
    expect(roles).toContain('zoomOut')
  })

  it('includes Help menu with Check for Updates', () => {
    const onCheckUpdates = vi.fn()
    buildAppMenu(mockMenu, {
      onPreferences: vi.fn(),
      onCheckUpdates,
      appVersion: '0.6.0',
      isMac: false,
    })

    const helpMenu = capturedTemplate.find((m) => m.label === 'Help')
    expect(helpMenu).toBeDefined()
    const checkUpdatesItem = helpMenu!.submenu!.find((item) => item.label === 'Check for Updates')
    expect(checkUpdatesItem).toBeDefined()
    checkUpdatesItem!.click!()
    expect(onCheckUpdates).toHaveBeenCalled()
  })

  it('sets application menu via Menu.setApplicationMenu', () => {
    buildAppMenu(mockMenu, {
      onPreferences: vi.fn(),
      onCheckUpdates: vi.fn(),
      appVersion: '0.6.0',
      isMac: false,
    })
    expect(mockMenu.setApplicationMenu).toHaveBeenCalled()
  })

  it('includes Preferences callback on macOS', () => {
    const onPreferences = vi.fn()
    buildAppMenu(mockMenu, {
      onPreferences,
      onCheckUpdates: vi.fn(),
      appVersion: '0.6.0',
      isMac: true,
    })

    // Find the app menu (first entry on macOS)
    const appMenu = capturedTemplate[0]
    expect(appMenu.role).toBe('appMenu')
    const prefsItem = appMenu.submenu!.find((item) => item.label === 'Preferences')
    expect(prefsItem).toBeDefined()
    prefsItem!.click!()
    expect(onPreferences).toHaveBeenCalled()
  })
})
