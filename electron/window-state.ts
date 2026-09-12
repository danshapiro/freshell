import { readDesktopConfig, patchDesktopConfig } from './desktop-config.js'

export interface WindowState {
  x?: number
  y?: number
  width: number
  height: number
  maximized: boolean
}

export interface WindowStatePersistence {
  /** Load persisted state, returning defaults if not found */
  load(): Promise<WindowState>

  /** Save current window state */
  save(state: { x: number; y: number; width: number; height: number; maximized: boolean }): Promise<void>
}

const DEFAULTS: WindowState = {
  width: 1200,
  height: 800,
  maximized: false,
}

export function createWindowStatePersistence(): WindowStatePersistence {
  return {
    async load(): Promise<WindowState> {
      const config = await readDesktopConfig()
      if (!config?.windowState) {
        return { ...DEFAULTS }
      }
      return {
        x: config.windowState.x,
        y: config.windowState.y,
        width: config.windowState.width ?? DEFAULTS.width,
        height: config.windowState.height ?? DEFAULTS.height,
        maximized: config.windowState.maximized ?? DEFAULTS.maximized,
      }
    },

    async save(state: { x: number; y: number; width: number; height: number; maximized: boolean }): Promise<void> {
      await patchDesktopConfig({ windowState: state })
    },
  }
}
