type ParsedSessionKey = {
  provider: string
  sessionId: string
  cwd?: string
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

function decodeSessionKeyPart(value: string): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(value, 'base64url').toString('utf8')
  }

  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=')
  const binary = atob(padded)
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

export function makeCodingCliSessionKey(
  provider: string | undefined,
  sessionId: string,
  cwd?: string,
): string {
  const resolvedProvider = provider || 'claude'
  const scopedCwd = sessionKeyRequiresCwdScope(resolvedProvider)
    ? normalizeSessionCwdForKey(cwd)
    : undefined

  if (!scopedCwd) {
    return `${resolvedProvider}:${sessionId}`
  }

  return `${resolvedProvider}:cwd=${encodeSessionKeyPart(scopedCwd)}:sid=${encodeSessionKeyPart(sessionId)}`
}

export function parseCodingCliSessionKey(key: string): ParsedSessionKey {
  const colonIdx = key.indexOf(':')
  if (colonIdx === -1) {
    return { provider: 'claude', sessionId: key }
  }

  const provider = key.slice(0, colonIdx)
  const remainder = key.slice(colonIdx + 1)
  if (remainder.startsWith('cwd=')) {
    const sidMarker = ':sid='
    const sidIdx = remainder.indexOf(sidMarker)
    if (sidIdx !== -1) {
      try {
        const cwd = decodeSessionKeyPart(remainder.slice('cwd='.length, sidIdx))
        const sessionId = decodeSessionKeyPart(remainder.slice(sidIdx + sidMarker.length))
        return { provider, sessionId, cwd }
      } catch {
        // Fall through to the legacy parser below if decoding fails.
      }
    }
  }

  return { provider, sessionId: remainder }
}

export function isCodingCliSessionKey(value: string, provider?: string): boolean {
  if (!value.includes(':')) return false

  if (provider && sessionKeyRequiresCwdScope(provider)) {
    return value.startsWith(`${provider}:cwd=`) && value.includes(':sid=')
  }

  if (provider) {
    return value.startsWith(`${provider}:`)
  }

  return /^[^:]+:/.test(value)
}
