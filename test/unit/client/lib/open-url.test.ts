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
})
