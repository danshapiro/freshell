import { useSyncExternalStore } from 'react'

const MOBILE_QUERY = '(max-width: 767px)'

let mql: MediaQueryList | null = null

function getMql(): MediaQueryList {
  if (!mql) mql = window.matchMedia(MOBILE_QUERY)
  return mql
}

function subscribe(callback: () => void): () => void {
  const m = getMql()
  m.addEventListener('change', callback)
  return () => m.removeEventListener('change', callback)
}

function getSnapshot(): boolean {
  return getMql().matches
}

function getServerSnapshot(): boolean {
  return false
}

export function useMobile(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}
