import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  registerPreloadApi,
  type ContextBridgeApi,
  type IpcRendererApi,
  type FreshellDesktopApi,
} from '../../../electron/preload.js'

describe('Preload API', () => {
  let mockContextBridge: ContextBridgeApi
  let mockIpcRenderer: IpcRendererApi
  let exposedApi: FreshellDesktopApi

  beforeEach(() => {
    mockContextBridge = {
      exposeInMainWorld: vi.fn((key: string, api: any) => {
        exposedApi = api
      }),
    }
    mockIpcRenderer = {
      invoke: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
    }
    registerPreloadApi(mockContextBridge, mockIpcRenderer)
  })

  it('exposes API under freshellDesktop key', () => {
    expect(mockContextBridge.exposeInMainWorld).toHaveBeenCalledWith(
      'freshellDesktop',
      expect.any(Object),
    )
  })

  it('has exactly the expected keys', () => {
    const keys = Object.keys(exposedApi).sort()
    expect(keys).toEqual([
      'completeSetup',
      'getServerMode',
      'getServerStatus',
      'installUpdate',
      'isElectron',
      'onUpdateAvailable',
      'onUpdateDownloaded',
      'platform',
      'setGlobalHotkey',
    ])
  })

  it('isElectron is true', () => {
    expect(exposedApi.isElectron).toBe(true)
  })

  it('each function key is a function', () => {
    expect(typeof exposedApi.getServerMode).toBe('function')
    expect(typeof exposedApi.getServerStatus).toBe('function')
    expect(typeof exposedApi.setGlobalHotkey).toBe('function')
    expect(typeof exposedApi.onUpdateAvailable).toBe('function')
    expect(typeof exposedApi.onUpdateDownloaded).toBe('function')
    expect(typeof exposedApi.installUpdate).toBe('function')
    expect(typeof exposedApi.completeSetup).toBe('function')
  })

  it('getServerMode invokes correct IPC channel', () => {
    exposedApi.getServerMode()
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('get-server-mode')
  })

  it('setGlobalHotkey invokes correct IPC channel with accelerator', () => {
    exposedApi.setGlobalHotkey('CommandOrControl+Space')
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('set-global-hotkey', 'CommandOrControl+Space')
  })

  it('onUpdateAvailable registers on correct channel', () => {
    const callback = vi.fn()
    exposedApi.onUpdateAvailable(callback)
    expect(mockIpcRenderer.on).toHaveBeenCalledWith('update-available', callback)
  })

  it('completeSetup invokes correct IPC channel with config', () => {
    const config = {
      serverMode: 'daemon' as const,
      port: 3001,
      remoteUrl: '',
      remoteToken: '',
      globalHotkey: 'CommandOrControl+`',
    }
    exposedApi.completeSetup(config)
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('complete-setup', config)
  })
})
