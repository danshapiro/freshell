const AUTH_KEY = 'freshell.auth-token'
const LEGACY_KEY = 'auth-token'

export function getAuthToken(): string | undefined {
  return localStorage.getItem(AUTH_KEY) || undefined
}

function setAuthCookie(token: string): void {
  const secure = window.location.protocol === 'https:' ? '; Secure' : ''
  document.cookie = `freshell-auth=${encodeURIComponent(token)}; path=/; SameSite=Strict${secure}`
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
  }
}
