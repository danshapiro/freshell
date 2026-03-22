import type { CodingCliProviderName } from '@/store/types'
import {
  isCodingCliSessionKey,
  makeCodingCliSessionKey,
  normalizeSessionCwdForKey,
  sessionKeyRequiresCwdScope,
} from '@shared/coding-cli-session-key'

type SessionKeyInput = {
  provider?: string
  sessionId: string
  cwd?: string
  sessionKey?: string
}

export {
  isCodingCliSessionKey,
  makeCodingCliSessionKey,
  normalizeSessionCwdForKey,
  sessionKeyRequiresCwdScope,
}

export function getCodingCliSessionKey(input: SessionKeyInput): string {
  if (typeof input.sessionKey === 'string' && input.sessionKey.length > 0) {
    return input.sessionKey
  }
  return makeCodingCliSessionKey(input.provider, input.sessionId, input.cwd)
}
