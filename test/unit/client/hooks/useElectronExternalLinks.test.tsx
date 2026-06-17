import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render } from '@testing-library/react'
import { useElectronExternalLinks } from '@/hooks/useElectronExternalLinks'

const openExternalUrlMock = vi.hoisted(() => vi.fn())

vi.mock('@/lib/open-url', () => ({
  openExternalUrl: openExternalUrlMock,
  shouldOpenLinkExternally: (event: MouseEvent) => event.ctrlKey || event.shiftKey,
}))

function TestHarness() {
  useElectronExternalLinks()
  return <a href="https://example.com" target="_blank" rel="noopener noreferrer">link</a>
}

describe('useElectronExternalLinks', () => {
  beforeEach(() => {
    openExternalUrlMock.mockClear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('does nothing in a normal browser', () => {
    vi.stubGlobal('freshellDesktop', undefined)
    const addEventListenerSpy = vi.spyOn(document, 'addEventListener')
    const { container } = render(<TestHarness />)
    const link = container.querySelector('a')!
    const clickEvent = new MouseEvent('click', { ctrlKey: true, bubbles: true })

    link.dispatchEvent(clickEvent)

    expect(addEventListenerSpy).not.toHaveBeenCalledWith('click', expect.any(Function), true)
    expect(openExternalUrlMock).not.toHaveBeenCalled()
    addEventListenerSpy.mockRestore()
  })

  it('opens external https links on ctrl+click in Electron', () => {
    vi.stubGlobal('freshellDesktop', { isElectron: true })
    const { container } = render(<TestHarness />)
    const link = container.querySelector('a')!
    const clickEvent = new MouseEvent('click', { ctrlKey: true, bubbles: true })

    link.dispatchEvent(clickEvent)

    expect(openExternalUrlMock).toHaveBeenCalledWith('https://example.com/')
  })

  it('opens external https links on shift+click in Electron', () => {
    vi.stubGlobal('freshellDesktop', { isElectron: true })
    const { container } = render(<TestHarness />)
    const link = container.querySelector('a')!
    const clickEvent = new MouseEvent('click', { shiftKey: true, bubbles: true })

    link.dispatchEvent(clickEvent)

    expect(openExternalUrlMock).toHaveBeenCalledWith('https://example.com/')
  })

  it('ignores plain left-clicks in Electron', () => {
    vi.stubGlobal('freshellDesktop', { isElectron: true })
    const { container } = render(<TestHarness />)
    const link = container.querySelector('a')!
    const clickEvent = new MouseEvent('click', { bubbles: true })

    link.dispatchEvent(clickEvent)

    expect(openExternalUrlMock).not.toHaveBeenCalled()
  })

  it('ignores non-http anchors in Electron', () => {
    vi.stubGlobal('freshellDesktop', { isElectron: true })
    function TestHarnessWithMail() {
      useElectronExternalLinks()
      return <a href="mailto:test@example.com">email</a>
    }
    const { container } = render(<TestHarnessWithMail />)
    const link = container.querySelector('a')!
    const clickEvent = new MouseEvent('click', { ctrlKey: true, bubbles: true })

    link.dispatchEvent(clickEvent)

    expect(openExternalUrlMock).not.toHaveBeenCalled()
  })
})
