import type { Request, Response, NextFunction } from 'express'
import { timingSafeEqual } from 'crypto'
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

export function timingSafeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8')
  const bufB = Buffer.from(b, 'utf8')
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

export function httpAuthMiddleware(req: Request, res: Response, next: NextFunction) {
  // Allow health checks without auth (optional)
  if (req.path === '/api/health') return next()

  const token = process.env.AUTH_TOKEN
  if (!token) return res.status(500).json({ error: 'Server misconfigured: AUTH_TOKEN missing' })

  const provided = (req.headers['x-auth-token'] as string | undefined) || undefined
  if (!provided || !timingSafeCompare(provided, token)) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  next()
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
