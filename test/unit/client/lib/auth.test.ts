import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const AUTH_KEY = 'freshell.auth-token'
const LEGACY_KEY = 'auth-token'

// Dynamic import so we can reset module state between tests.
let auth: typeof import('@/lib/auth')

describe('auth', () => {
  beforeEach(async () => {
    localStorage.clear()
    sessionStorage.clear()
    vi.resetModules()
    auth = await import('@/lib/auth')
  })

  afterEach(() => {
    localStorage.clear()
    sessionStorage.clear()
  })

  describe('getAuthToken', () => {
    it('returns undefined when no token is stored', () => {
      expect(auth.getAuthToken()).toBeUndefined()
    })

    it('returns the token from localStorage', () => {
      localStorage.setItem(AUTH_KEY, 'my-token')
      expect(auth.getAuthToken()).toBe('my-token')
    })

    it('returns undefined for empty string', () => {
      localStorage.setItem(AUTH_KEY, '')
      expect(auth.getAuthToken()).toBeUndefined()
    })
  })

  describe('setAuthToken', () => {
    it('writes the token to localStorage', () => {
      auth.setAuthToken('abc')
      expect(localStorage.getItem(AUTH_KEY)).toBe('abc')
    })

    it('sets freshell-auth cookie', () => {
      auth.setAuthToken('abc')
      expect(document.cookie).toContain('freshell-auth=abc')
    })

    it('overwrites a previous token', () => {
      auth.setAuthToken('first')
      auth.setAuthToken('second')
      expect(localStorage.getItem(AUTH_KEY)).toBe('second')
    })
  })

  describe('initializeAuthToken', () => {
    it('migrates a legacy sessionStorage token to localStorage', () => {
      sessionStorage.setItem(LEGACY_KEY, 'legacy-token')
      auth.initializeAuthToken()
      expect(localStorage.getItem(AUTH_KEY)).toBe('legacy-token')
      expect(auth.getAuthToken()).toBe('legacy-token')
    })

    it('does not migrate if localStorage already has a token', () => {
      localStorage.setItem(AUTH_KEY, 'existing')
      sessionStorage.setItem(LEGACY_KEY, 'legacy')
      auth.initializeAuthToken()
      // URL token would override, but there's no URL token here,
      // so localStorage stays as-is
      expect(localStorage.getItem(AUTH_KEY)).toBe('existing')
    })

    it('extracts token from URL and stores it in localStorage', () => {
      // Set up location with a token param
      const original = window.location
      const replaceStateSpy = vi.spyOn(window.history, 'replaceState')

      Object.defineProperty(window, 'location', {
        value: {
          ...original,
          search: '?token=url-token&other=value',
          pathname: '/app',
        },
        writable: true,
        configurable: true,
      })

      auth.initializeAuthToken()
      expect(localStorage.getItem(AUTH_KEY)).toBe('url-token')
      expect(auth.getAuthToken()).toBe('url-token')

      // Should have cleaned the URL
      expect(replaceStateSpy).toHaveBeenCalledWith(
        {},
        '',
        '/app?other=value',
      )

      Object.defineProperty(window, 'location', {
        value: original,
        writable: true,
        configurable: true,
      })
      replaceStateSpy.mockRestore()
    })

    it('URL token takes precedence over legacy migration', () => {
      sessionStorage.setItem(LEGACY_KEY, 'legacy')

      const original = window.location
      const replaceStateSpy = vi.spyOn(window.history, 'replaceState')

      Object.defineProperty(window, 'location', {
        value: {
          ...original,
          search: '?token=url-token',
          pathname: '/',
        },
        writable: true,
        configurable: true,
      })

      auth.initializeAuthToken()
      expect(localStorage.getItem(AUTH_KEY)).toBe('url-token')

      Object.defineProperty(window, 'location', {
        value: original,
        writable: true,
        configurable: true,
      })
      replaceStateSpy.mockRestore()
    })

    it('cleans URL when token is the only param', () => {
      const original = window.location
      const replaceStateSpy = vi.spyOn(window.history, 'replaceState')

      Object.defineProperty(window, 'location', {
        value: {
          ...original,
          search: '?token=t',
          pathname: '/test',
        },
        writable: true,
        configurable: true,
      })

      auth.initializeAuthToken()

      expect(replaceStateSpy).toHaveBeenCalledWith({}, '', '/test')

      Object.defineProperty(window, 'location', {
        value: original,
        writable: true,
        configurable: true,
      })
      replaceStateSpy.mockRestore()
    })

    it('does nothing when no legacy token and no URL token', () => {
      const replaceStateSpy = vi.spyOn(window.history, 'replaceState')
      auth.initializeAuthToken()
      expect(localStorage.getItem(AUTH_KEY)).toBeNull()
      expect(replaceStateSpy).not.toHaveBeenCalled()
      replaceStateSpy.mockRestore()
    })

    it('sets freshell-auth cookie when token extracted from URL', () => {
      const original = window.location
      const replaceStateSpy = vi.spyOn(window.history, 'replaceState')

      Object.defineProperty(window, 'location', {
        value: {
          ...original,
          search: '?token=url-cookie-test',
          pathname: '/',
          protocol: 'http:',
        },
        writable: true,
        configurable: true,
      })

      auth.initializeAuthToken()
      expect(document.cookie).toContain('freshell-auth=url-cookie-test')

      Object.defineProperty(window, 'location', {
        value: original,
        writable: true,
        configurable: true,
      })
      replaceStateSpy.mockRestore()
    })

    it('sets freshell-auth cookie from existing localStorage token', () => {
      localStorage.setItem(AUTH_KEY, 'stored-token')
      auth.initializeAuthToken()
      expect(document.cookie).toContain('freshell-auth=stored-token')
    })
  })
})
