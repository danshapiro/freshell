import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { openExternalUrl } from '@/lib/open-url'

describe('openExternalUrl', () => {
  let windowOpenSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    windowOpenSpy = vi.spyOn(window, 'open').mockImplementation(() => null)
  })

  afterEach(() => {
    windowOpenSpy.mockRestore()
    vi.unstubAllGlobals()
  })

  it('uses window.freshellDesktop.openExternal when available', () => {
    const openExternal = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('freshellDesktop', { openExternal, isElectron: true })

    openExternalUrl('https://example.com')

    expect(openExternal).toHaveBeenCalledWith('https://example.com')
    expect(windowOpenSpy).not.toHaveBeenCalled()
  })

  it('falls back to window.open when freshellDesktop is unavailable', () => {
    vi.stubGlobal('freshellDesktop', undefined)

    openExternalUrl('https://example.com')

    expect(windowOpenSpy).toHaveBeenCalledWith('https://example.com', '_blank', 'noopener,noreferrer')
  })

  it('falls back to window.open when freshellDesktop.openExternal is not a function', () => {
    vi.stubGlobal('freshellDesktop', { isElectron: true })

    openExternalUrl('https://example.com')

    expect(windowOpenSpy).toHaveBeenCalledWith('https://example.com', '_blank', 'noopener,noreferrer')
  })

  it('resolves relative URLs against window.location when using openExternal', () => {
    const openExternal = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('freshellDesktop', { openExternal, isElectron: true })
    vi.stubGlobal('location', { href: 'https://freshell.example.com:3001/pane/tab-1' })

    openExternalUrl('/api/proxy/http/8080/')

    expect(openExternal).toHaveBeenCalledWith('https://freshell.example.com:3001/api/proxy/http/8080/')
  })

  it('resolves relative URLs against window.location when falling back to window.open', () => {
    vi.stubGlobal('freshellDesktop', undefined)
    vi.stubGlobal('location', { href: 'https://freshell.example.com:3001/' })

    openExternalUrl('/api/proxy/http/8080/')

    expect(windowOpenSpy).toHaveBeenCalledWith('https://freshell.example.com:3001/api/proxy/http/8080/', '_blank', 'noopener,noreferrer')
  })

  it('logs a warning but does not throw when openExternal rejects', async () => {
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const openExternal = vi.fn().mockRejectedValue(new Error('OS refused'))
    vi.stubGlobal('freshellDesktop', { openExternal, isElectron: true })

    openExternalUrl('https://example.com')

    // Wait for the promise rejection to be caught.
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(openExternal).toHaveBeenCalledWith('https://example.com')
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      'Failed to open external URL via Electron:',
      'https://example.com',
      expect.any(Error),
    )
    consoleWarnSpy.mockRestore()
  })

  it('ignores non-string URLs', () => {
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('freshellDesktop', undefined)

    openExternalUrl(undefined as unknown as string)

    expect(windowOpenSpy).not.toHaveBeenCalled()
    expect(consoleWarnSpy).toHaveBeenCalled()
    consoleWarnSpy.mockRestore()
  })
})
