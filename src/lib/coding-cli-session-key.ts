import type { CodingCliProviderName } from '@/store/types'

type SessionKeyInput = {
  provider?: string
  sessionId: string
  cwd?: string
  sessionKey?: string
}

export function sessionKeyRequiresCwdScope(provider?: string): boolean {
  return provider === 'kimi'
}

export function normalizeSessionCwdForKey(cwd?: string): string | undefined {
  if (!cwd) return undefined
  const normalized = cwd.replace(/\\/g, '/').replace(/\/+$/, '')
  if (!normalized) return '/'
  if (/^[a-zA-Z]:\//.test(normalized) || normalized.startsWith('//')) {
    return normalized.toLowerCase()
  }
  return normalized
}

function encodeSessionKeyPart(value: string): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(value, 'utf8').toString('base64url')
  }

  const bytes = new TextEncoder().encode(value)
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

export function makeCodingCliSessionKey(
  provider: CodingCliProviderName | string | undefined,
  sessionId: string,
  cwd?: string,
): string {
  const resolvedProvider = (provider || 'claude') as string
  const scopedCwd = sessionKeyRequiresCwdScope(resolvedProvider)
    ? normalizeSessionCwdForKey(cwd)
    : undefined

  if (!scopedCwd) {
    return `${resolvedProvider}:${sessionId}`
  }

  return `${resolvedProvider}:cwd=${encodeSessionKeyPart(scopedCwd)}:sid=${encodeSessionKeyPart(sessionId)}`
}

export function getCodingCliSessionKey(input: SessionKeyInput): string {
  if (typeof input.sessionKey === 'string' && input.sessionKey.length > 0) {
    return input.sessionKey
  }
  return makeCodingCliSessionKey(input.provider, input.sessionId, input.cwd)
}
