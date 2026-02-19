import { useCallback, useEffect, useState } from 'react'

function getFullscreenElement(): Element | null {
  if (typeof document === 'undefined') return null
  return document.fullscreenElement ?? null
}

export function useFullscreen() {
  const [isFullscreen, setIsFullscreen] = useState(() => !!getFullscreenElement())

  useEffect(() => {
    if (typeof document === 'undefined') return

    const onChange = () => {
      setIsFullscreen(!!getFullscreenElement())
    }

    document.addEventListener('fullscreenchange', onChange)
    return () => {
      document.removeEventListener('fullscreenchange', onChange)
    }
  }, [])

  const enterFullscreen = useCallback(async (target?: HTMLElement | null) => {
    if (typeof document === 'undefined') return false
    const el = target ?? document.documentElement
    if (!el || typeof el.requestFullscreen !== 'function') return false

    try {
      await el.requestFullscreen()
      return true
    } catch {
      return false
    }
  }, [])

  const exitFullscreen = useCallback(async () => {
    if (typeof document === 'undefined') return false
    if (!document.fullscreenElement || typeof document.exitFullscreen !== 'function') return false

    try {
      await document.exitFullscreen()
      return true
    } catch {
      return false
    }
  }, [])

  const toggleFullscreen = useCallback(async (target?: HTMLElement | null) => {
    if (getFullscreenElement()) {
      return exitFullscreen()
    }
    return enterFullscreen(target)
  }, [enterFullscreen, exitFullscreen])

  return {
    isFullscreen,
    enterFullscreen,
    exitFullscreen,
    toggleFullscreen,
  }
}
