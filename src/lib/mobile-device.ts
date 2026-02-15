const MOBILE_QUERY = '(max-width: 767px)'

let mql: MediaQueryList | null = null

function getMql(): MediaQueryList | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null
  if (!mql) mql = window.matchMedia(MOBILE_QUERY)
  return mql
}

export function isMobileDevice(): boolean {
  try {
    return getMql()?.matches === true
  } catch {
    return false
  }
}

export function resetMobileDeviceForTests(): void {
  mql = null
}
