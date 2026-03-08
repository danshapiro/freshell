export interface HotkeyManager {
  /** Register the global hotkey. Returns true if successful. */
  register(accelerator: string, callback: () => void): boolean

  /** Unregister the current hotkey. */
  unregister(): void

  /** Change the hotkey accelerator. */
  update(accelerator: string, callback: () => void): boolean

  /** Get the currently registered accelerator. */
  current(): string | null
}

export interface GlobalShortcutApi {
  register(accelerator: string, callback: () => void): boolean
  unregister(accelerator: string): void
}

export function createHotkeyManager(globalShortcut: GlobalShortcutApi): HotkeyManager {
  let currentAccelerator: string | null = null

  return {
    register(accelerator: string, callback: () => void): boolean {
      const success = globalShortcut.register(accelerator, callback)
      if (success) {
        currentAccelerator = accelerator
      }
      return success
    },

    unregister(): void {
      if (currentAccelerator) {
        globalShortcut.unregister(currentAccelerator)
        currentAccelerator = null
      }
    },

    update(accelerator: string, callback: () => void): boolean {
      if (currentAccelerator) {
        globalShortcut.unregister(currentAccelerator)
      }
      const success = globalShortcut.register(accelerator, callback)
      if (success) {
        currentAccelerator = accelerator
      } else {
        currentAccelerator = null
      }
      return success
    },

    current(): string | null {
      return currentAccelerator
    },
  }
}
