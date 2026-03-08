// This module defines the preload script for the Electron renderer process.
// In production, it uses electron's contextBridge and ipcRenderer.
// For testability, the API shape is exported as a type and the actual
// registration is done via the registerPreloadApi function.

export interface FreshellDesktopApi {
  platform: string
  isElectron: boolean
  getServerMode: () => Promise<string>
  getServerStatus: () => Promise<{ running: boolean; mode: string }>
  setGlobalHotkey: (accelerator: string) => Promise<boolean>
  onUpdateAvailable: (callback: () => void) => void
  onUpdateDownloaded: (callback: () => void) => void
  installUpdate: () => Promise<void>
}

export interface ContextBridgeApi {
  exposeInMainWorld(apiKey: string, api: Record<string, any>): void
}

export interface IpcRendererApi {
  invoke(channel: string, ...args: any[]): Promise<any>
  on(channel: string, callback: (...args: any[]) => void): void
}

export function registerPreloadApi(
  contextBridge: ContextBridgeApi,
  ipcRenderer: IpcRendererApi,
): void {
  const api: FreshellDesktopApi = {
    platform: process.platform,
    isElectron: true,
    getServerMode: () => ipcRenderer.invoke('get-server-mode'),
    getServerStatus: () => ipcRenderer.invoke('get-server-status'),
    setGlobalHotkey: (accelerator: string) => ipcRenderer.invoke('set-global-hotkey', accelerator),
    onUpdateAvailable: (callback: () => void) => ipcRenderer.on('update-available', callback),
    onUpdateDownloaded: (callback: () => void) => ipcRenderer.on('update-downloaded', callback),
    installUpdate: () => ipcRenderer.invoke('install-update'),
  }

  contextBridge.exposeInMainWorld('freshellDesktop', api)
}
