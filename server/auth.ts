import type { Request, Response, NextFunction } from 'express'
import { logger } from './logger.js'

const log = logger.child({ component: 'auth' })

const DEFAULT_BAD_TOKENS = new Set(['changeme', 'default', 'password', 'token'])

export function getRequiredAuthToken(): string {
  const token = process.env.AUTH_TOKEN
  if (!token) throw new Error('AUTH_TOKEN is required')
  return token
}

export function validateStartupSecurity() {
  const token = process.env.AUTH_TOKEN
  if (!token) {
    throw new Error('AUTH_TOKEN is required. Refusing to start without authentication.')
  }
  if (token.length < 16) {
    throw new Error('AUTH_TOKEN is too short. Use at least 16 characters.')
  }
  if (DEFAULT_BAD_TOKENS.has(token.toLowerCase())) {
    throw new Error('AUTH_TOKEN appears to be a default/weak value. Refusing to start.')
  }
  log.info({ tokenLength: token.length, event: 'auth_token_configured' }, 'Security: AUTH_TOKEN configured')
}

export function httpAuthMiddleware(req: Request, res: Response, next: NextFunction) {
  // Allow health checks without auth (optional)
  if (req.path === '/api/health') return next()

  // Optional: trust Cloudflare Access for auth (SSO) when explicitly enabled.
  // This allows single-login via Access for remote usage while keeping AUTH_TOKEN
  // as the fallback for direct/local access.
  if (isCloudflareAccessAuthAllowed(req)) return next()

  const token = process.env.AUTH_TOKEN
  if (!token) return res.status(500).json({ error: 'Server misconfigured: AUTH_TOKEN missing' })

  const provided = (req.headers['x-auth-token'] as string | undefined) || undefined
  if (!provided || provided !== token) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  next()
}

function parseCsvEnv(name: string): string[] {
  const raw = process.env[name]
  if (!raw) return []
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

export function getCloudflareAccessEmail(req: Request): string | null {
  // Cloudflare Access injects this header for authenticated users.
  const email = req.headers['cf-access-authenticated-user-email'] as string | undefined
  if (!email) return null
  return email.trim() || null
}

export function isCloudflareAccessAuthAllowed(req: Request): boolean {
  const enabled = (process.env.FRESHELL_TRUST_CF_ACCESS || '').toLowerCase() === 'true'
  if (!enabled) return false

  const email = getCloudflareAccessEmail(req)
  if (!email) return false

  const allow = parseCsvEnv('FRESHELL_CF_ACCESS_EMAIL_ALLOWLIST').map((e) => e.toLowerCase())
  if (allow.length === 0) return false

  return allow.includes(email.toLowerCase())
}

export function parseAllowedOrigins(): string[] {
  const env = process.env.ALLOWED_ORIGINS
  if (env) return env.split(',').map((s) => s.trim()).filter(Boolean)

  // Default localhost dev/prod origins.
  return [
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'http://localhost:3001',
    'http://127.0.0.1:3001',
  ]
}

export function isOriginAllowed(origin: string | undefined): boolean {
  if (!origin) return false
  const allowed = parseAllowedOrigins()
  return allowed.includes(origin)
}

export function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false
  return (
    addr === '127.0.0.1' ||
    addr === '::1' ||
    addr.startsWith('::ffff:127.') ||
    addr === '::ffff:localhost'
  )
}
