import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHotkeyManager, type GlobalShortcutApi } from '../../../electron/hotkey.js'

describe('HotkeyManager', () => {
  let mockGlobalShortcut: GlobalShortcutApi
  let manager: ReturnType<typeof createHotkeyManager>

  beforeEach(() => {
    mockGlobalShortcut = {
      register: vi.fn().mockReturnValue(true),
      unregister: vi.fn(),
    }
    manager = createHotkeyManager(mockGlobalShortcut)
  })

  describe('register', () => {
    it('calls globalShortcut.register with correct accelerator', () => {
      const callback = vi.fn()
      manager.register('CommandOrControl+`', callback)

      expect(mockGlobalShortcut.register).toHaveBeenCalledWith('CommandOrControl+`', callback)
    })

    it('returns true on successful registration', () => {
      expect(manager.register('CommandOrControl+`', vi.fn())).toBe(true)
    })

    it('returns false if accelerator is already in use', () => {
      ;(mockGlobalShortcut.register as ReturnType<typeof vi.fn>).mockReturnValue(false)
      expect(manager.register('CommandOrControl+Space', vi.fn())).toBe(false)
    })

    it('does not set current on failed registration', () => {
      ;(mockGlobalShortcut.register as ReturnType<typeof vi.fn>).mockReturnValue(false)
      manager.register('CommandOrControl+Space', vi.fn())
      expect(manager.current()).toBeNull()
    })
  })

  describe('unregister', () => {
    it('calls globalShortcut.unregister with current accelerator', () => {
      manager.register('CommandOrControl+`', vi.fn())
      manager.unregister()

      expect(mockGlobalShortcut.unregister).toHaveBeenCalledWith('CommandOrControl+`')
    })

    it('sets current to null', () => {
      manager.register('CommandOrControl+`', vi.fn())
      manager.unregister()
      expect(manager.current()).toBeNull()
    })
  })

  describe('update', () => {
    it('unregisters old, registers new', () => {
      manager.register('CommandOrControl+`', vi.fn())
      manager.update('CommandOrControl+Space', vi.fn())

      expect(mockGlobalShortcut.unregister).toHaveBeenCalledWith('CommandOrControl+`')
      expect(mockGlobalShortcut.register).toHaveBeenCalledWith('CommandOrControl+Space', expect.any(Function))
    })

    it('updates current to new accelerator', () => {
      manager.register('CommandOrControl+`', vi.fn())
      manager.update('CommandOrControl+Space', vi.fn())
      expect(manager.current()).toBe('CommandOrControl+Space')
    })
  })

  describe('current', () => {
    it('returns null when nothing registered', () => {
      expect(manager.current()).toBeNull()
    })

    it('returns active accelerator', () => {
      manager.register('CommandOrControl+`', vi.fn())
      expect(manager.current()).toBe('CommandOrControl+`')
    })
  })
})
