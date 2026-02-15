import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  getRequiredAuthToken,
  validateStartupSecurity,
  httpAuthMiddleware,
  parseAllowedOrigins,
  isOriginAllowed,
  isLoopbackAddress,
  timingSafeCompare,
} from '../../../server/auth'

describe('auth module', () => {
  const originalEnv = process.env

  beforeEach(() => {
    vi.resetModules()
    process.env = { ...originalEnv }
  })

  afterEach(() => {
    process.env = originalEnv
  })

  describe('getRequiredAuthToken', () => {
    it('returns AUTH_TOKEN when set', () => {
      process.env.AUTH_TOKEN = 'valid-token-16chars'
      expect(getRequiredAuthToken()).toBe('valid-token-16chars')
    })

    it('throws when AUTH_TOKEN is not set', () => {
      delete process.env.AUTH_TOKEN
      expect(() => getRequiredAuthToken()).toThrow('AUTH_TOKEN is required')
    })
  })

  describe('validateStartupSecurity', () => {
    it('throws when AUTH_TOKEN is missing', () => {
      delete process.env.AUTH_TOKEN
      expect(() => validateStartupSecurity()).toThrow('AUTH_TOKEN is required')
    })

    it('throws when AUTH_TOKEN is too short', () => {
      process.env.AUTH_TOKEN = 'short'
      expect(() => validateStartupSecurity()).toThrow('too short')
    })

    it('throws for short weak values due to length check first', () => {
      // Note: The weak values ('changeme', 'default', 'password', 'token') are all < 16 chars,
      // so they fail the length check before reaching the weak value check
      process.env.AUTH_TOKEN = 'changeme'
      expect(() => validateStartupSecurity()).toThrow('too short')
    })

    it('would detect weak values if they were 16+ chars (but they are not)', () => {
      // The weak value check uses exact match, so padded versions pass through
      // This test documents the actual behavior - padded weak values are accepted
      process.env.AUTH_TOKEN = 'changeme12345678'
      expect(() => validateStartupSecurity()).not.toThrow()
    })

    it('accepts valid AUTH_TOKEN', () => {
      process.env.AUTH_TOKEN = 'secure-token-that-is-long-enough'
      expect(() => validateStartupSecurity()).not.toThrow()
    })
  })

  describe('httpAuthMiddleware', () => {
    it('allows /api/health without auth', () => {
      process.env.AUTH_TOKEN = 'valid-token-16chars'
      const req = { path: '/api/health' } as any
      const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as any
      const next = vi.fn()

      httpAuthMiddleware(req, res, next)

      expect(next).toHaveBeenCalled()
      expect(res.status).not.toHaveBeenCalled()
    })

    it('returns 401 when token is missing', () => {
      process.env.AUTH_TOKEN = 'valid-token-16chars'
      const req = { path: '/api/settings', headers: {} } as any
      const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as any
      const next = vi.fn()

      httpAuthMiddleware(req, res, next)

      expect(res.status).toHaveBeenCalledWith(401)
      expect(next).not.toHaveBeenCalled()
    })

    it('returns 401 when token is wrong', () => {
      process.env.AUTH_TOKEN = 'valid-token-16chars'
      const req = { path: '/api/settings', headers: { 'x-auth-token': 'wrong' } } as any
      const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as any
      const next = vi.fn()

      httpAuthMiddleware(req, res, next)

      expect(res.status).toHaveBeenCalledWith(401)
    })

    it('calls next when token is correct', () => {
      process.env.AUTH_TOKEN = 'valid-token-16chars'
      const req = { path: '/api/settings', headers: { 'x-auth-token': 'valid-token-16chars' } } as any
      const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as any
      const next = vi.fn()

      httpAuthMiddleware(req, res, next)

      expect(next).toHaveBeenCalled()
    })

    it('returns 500 when AUTH_TOKEN is not configured', () => {
      delete process.env.AUTH_TOKEN
      const req = { path: '/api/settings', headers: {} } as any
      const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as any
      const next = vi.fn()

      httpAuthMiddleware(req, res, next)

      expect(res.status).toHaveBeenCalledWith(500)
      expect(res.json).toHaveBeenCalledWith({ error: 'Server misconfigured: AUTH_TOKEN missing' })
    })
  })

  describe('parseAllowedOrigins', () => {
    it('returns default origins when ALLOWED_ORIGINS not set', () => {
      delete process.env.ALLOWED_ORIGINS
      const origins = parseAllowedOrigins()
      expect(origins).toContain('http://localhost:5173')
      expect(origins).toContain('http://localhost:3001')
    })

    it('parses comma-separated ALLOWED_ORIGINS', () => {
      process.env.ALLOWED_ORIGINS = 'http://example.com, http://test.com'
      const origins = parseAllowedOrigins()
      expect(origins).toEqual(['http://example.com', 'http://test.com'])
    })

    it('filters out empty strings', () => {
      process.env.ALLOWED_ORIGINS = 'http://example.com,  , http://test.com'
      const origins = parseAllowedOrigins()
      expect(origins).toEqual(['http://example.com', 'http://test.com'])
    })
  })

  describe('isOriginAllowed', () => {
    it('returns false for undefined origin', () => {
      expect(isOriginAllowed(undefined)).toBe(false)
    })

    it('returns true for allowed origin', () => {
      delete process.env.ALLOWED_ORIGINS
      expect(isOriginAllowed('http://localhost:5173')).toBe(true)
    })

    it('returns false for disallowed origin', () => {
      delete process.env.ALLOWED_ORIGINS
      expect(isOriginAllowed('http://evil.com')).toBe(false)
    })
  })

  describe('timingSafeCompare', () => {
    it('returns true for identical tokens', () => {
      expect(timingSafeCompare('my-secret-token', 'my-secret-token')).toBe(true)
    })

    it('returns false for different tokens of same length', () => {
      expect(timingSafeCompare('my-secret-token', 'xx-secret-token')).toBe(false)
    })

    it('returns false for different length tokens', () => {
      expect(timingSafeCompare('short', 'a-much-longer-token')).toBe(false)
    })

    it('returns true for two empty strings', () => {
      expect(timingSafeCompare('', '')).toBe(true)
    })

    it('returns false when one is empty', () => {
      expect(timingSafeCompare('', 'non-empty')).toBe(false)
      expect(timingSafeCompare('non-empty', '')).toBe(false)
    })

    it('handles unicode/multibyte characters', () => {
      expect(timingSafeCompare('tokën-with-ünïcödé', 'tokën-with-ünïcödé')).toBe(true)
      expect(timingSafeCompare('tokën-with-ünïcödé', 'token-with-unicode')).toBe(false)
    })
  })

  describe('isLoopbackAddress', () => {
    it('returns false for undefined', () => {
      expect(isLoopbackAddress(undefined)).toBe(false)
    })

    it('returns true for 127.0.0.1', () => {
      expect(isLoopbackAddress('127.0.0.1')).toBe(true)
    })

    it('returns true for ::1', () => {
      expect(isLoopbackAddress('::1')).toBe(true)
    })

    it('returns true for ::ffff:127.0.0.1', () => {
      expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true)
    })

    it('returns true for ::ffff:localhost', () => {
      expect(isLoopbackAddress('::ffff:localhost')).toBe(true)
    })

    it('returns false for external IP', () => {
      expect(isLoopbackAddress('192.168.1.1')).toBe(false)
    })
  })
})
