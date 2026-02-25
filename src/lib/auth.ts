const AUTH_KEY = 'freshell.auth-token'
const LEGACY_KEY = 'auth-token'

function buildAuthCookie(value: string, extraDirectives = ''): string {
  const secure = window.location.protocol === 'https:' ? '; Secure' : ''
  return `freshell-auth=${value}; path=/; SameSite=Strict${secure}${extraDirectives}`
}

export function getAuthToken(): string | undefined {
  return localStorage.getItem(AUTH_KEY) || undefined
}

function setAuthCookie(token: string): void {
  document.cookie = buildAuthCookie(encodeURIComponent(token))
}

export function clearAuthCookie(): void {
  document.cookie = buildAuthCookie('', '; Max-Age=0')
}

export function setAuthToken(token: string): void {
  localStorage.setItem(AUTH_KEY, token)
  setAuthCookie(token)
}

/**
 * Called ONCE on app bootstrap. Migrates legacy sessionStorage token to
 * localStorage, then extracts ?token= from the URL (URL takes precedence).
 * Removes the token from the URL to avoid leaking via browser history.
 */
export function initializeAuthToken(): void {
  // Migrate legacy sessionStorage token
  const legacy = sessionStorage.getItem(LEGACY_KEY)
  if (legacy && !localStorage.getItem(AUTH_KEY)) {
    localStorage.setItem(AUTH_KEY, legacy)
  }

  // URL token takes precedence
  const params = new URLSearchParams(window.location.search)
  const urlToken = params.get('token')
  if (urlToken) {
    localStorage.setItem(AUTH_KEY, urlToken)
    setAuthCookie(urlToken)
    params.delete('token')
    const newUrl = params.toString()
      ? `${window.location.pathname}?${params.toString()}`
      : window.location.pathname
    window.history.replaceState({}, '', newUrl)
  }

  // Set cookie from existing localStorage token (for sessions that already have a token)
  const stored = localStorage.getItem(AUTH_KEY)
  if (stored) {
    setAuthCookie(stored)
  } else {
    clearAuthCookie()
  }
}
