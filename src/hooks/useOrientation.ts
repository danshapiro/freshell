import { useSyncExternalStore } from 'react'

const LANDSCAPE_QUERY = '(orientation: landscape)'
const LANDSCAPE_COMPACT_MAX_HEIGHT = 500

let mql: MediaQueryList | null = null

function getMql(): MediaQueryList {
  if (!mql) mql = window.matchMedia(LANDSCAPE_QUERY)
  return mql
}

export function resetOrientationHookForTests(): void {
  mql = null
}

function subscribe(callback: () => void): () => void {
  const m = getMql()
  m.addEventListener('change', callback)
  window.addEventListener('resize', callback)
  return () => {
    m.removeEventListener('change', callback)
    window.removeEventListener('resize', callback)
  }
}

function getSnapshot(): boolean {
  if (!getMql().matches) return false
  // Landscape compact mode is intentionally phone-focused; large tablet viewports
  // should keep standard chrome even when orientation is landscape.
  return window.innerHeight <= LANDSCAPE_COMPACT_MAX_HEIGHT
}

function getServerSnapshot(): boolean {
  return false
}

export function useOrientation(): { isLandscape: boolean } {
  const isLandscape = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
  return { isLandscape }
}
