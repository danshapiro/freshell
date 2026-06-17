import { describe, it, expect, vi, beforeEach } from 'vitest'
import { registerOpenExternalHandler, type ExternalUrlDeps } from '../../../electron/external-url.js'

describe('registerOpenExternalHandler', () => {
  let deps: ExternalUrlDeps
  let handler: (event: unknown, url: string) => Promise<void>

  beforeEach(() => {
    deps = {
      ipcMain: {
        handle: vi.fn((channel: string, fn: (event: unknown, url: string) => Promise<void>) => {
          if (channel === 'open-external-url') {
            handler = fn
          }
        }),
      },
      shell: {
        openExternal: vi.fn().mockResolvedValue(undefined),
      },
    }
    registerOpenExternalHandler(deps)
  })

  it('registers open-external-url IPC handler', () => {
    expect(deps.ipcMain.handle).toHaveBeenCalledWith('open-external-url', expect.any(Function))
  })

  it('opens https URLs with shell.openExternal', async () => {
    await handler({}, 'https://example.com')
    expect(deps.shell.openExternal).toHaveBeenCalledWith('https://example.com')
  })

  it('opens http URLs with shell.openExternal', async () => {
    await handler({}, 'http://example.com')
    expect(deps.shell.openExternal).toHaveBeenCalledWith('http://example.com')
  })

  it('rejects non-string URLs', async () => {
    await expect(handler({}, undefined as unknown as string)).rejects.toThrow(/only absolute http\/https URLs are allowed/)
    expect(deps.shell.openExternal).not.toHaveBeenCalled()
  })

  it('rejects file: URLs', async () => {
    await expect(handler({}, 'file:///etc/passwd')).rejects.toThrow(/only absolute http\/https URLs are allowed/)
    expect(deps.shell.openExternal).not.toHaveBeenCalled()
  })

  it('rejects javascript: URLs', async () => {
    await expect(handler({}, 'javascript:alert(1)')).rejects.toThrow(/only absolute http\/https URLs are allowed/)
    expect(deps.shell.openExternal).not.toHaveBeenCalled()
  })

  it('rejects relative URLs', async () => {
    await expect(handler({}, '/api/proxy/http/8080/')).rejects.toThrow(/only absolute http\/https URLs are allowed/)
    expect(deps.shell.openExternal).not.toHaveBeenCalled()
  })
})
