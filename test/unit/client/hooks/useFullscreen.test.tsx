import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { useFullscreen } from '@/hooks/useFullscreen'

function FullscreenProbe() {
  const { isFullscreen, toggleFullscreen } = useFullscreen()

  return (
    <div>
      <span data-testid="fullscreen-state">{isFullscreen ? 'on' : 'off'}</span>
      <button type="button" onClick={() => { void toggleFullscreen() }}>
        Toggle fullscreen
      </button>
    </div>
  )
}

describe('useFullscreen', () => {
  const originalRequestFullscreen = document.documentElement.requestFullscreen
  const originalExitFullscreen = document.exitFullscreen
  const originalFullscreenElementDescriptor = Object.getOwnPropertyDescriptor(document, 'fullscreenElement')

  let fullscreenEl: Element | null = null

  beforeEach(() => {
    fullscreenEl = null
    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true,
      get: () => fullscreenEl,
    })

    Object.defineProperty(document.documentElement, 'requestFullscreen', {
      configurable: true,
      value: vi.fn(async () => {
        fullscreenEl = document.documentElement
        document.dispatchEvent(new Event('fullscreenchange'))
      }),
    })

    Object.defineProperty(document, 'exitFullscreen', {
      configurable: true,
      value: vi.fn(async () => {
        fullscreenEl = null
        document.dispatchEvent(new Event('fullscreenchange'))
      }),
    })
  })

  afterEach(() => {
    if (originalFullscreenElementDescriptor) {
      Object.defineProperty(document, 'fullscreenElement', originalFullscreenElementDescriptor)
    }

    Object.defineProperty(document.documentElement, 'requestFullscreen', {
      configurable: true,
      value: originalRequestFullscreen,
    })

    Object.defineProperty(document, 'exitFullscreen', {
      configurable: true,
      value: originalExitFullscreen,
    })
  })

  it('enters and exits fullscreen via toggle', async () => {
    render(<FullscreenProbe />)

    expect(screen.getByTestId('fullscreen-state')).toHaveTextContent('off')

    fireEvent.click(screen.getByRole('button', { name: 'Toggle fullscreen' }))

    await waitFor(() => {
      expect(screen.getByTestId('fullscreen-state')).toHaveTextContent('on')
    })

    fireEvent.click(screen.getByRole('button', { name: 'Toggle fullscreen' }))

    await waitFor(() => {
      expect(screen.getByTestId('fullscreen-state')).toHaveTextContent('off')
    })
  })
})
