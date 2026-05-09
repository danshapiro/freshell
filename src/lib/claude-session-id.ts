import { isCanonicalClaudeSessionId } from '@shared/session-contract'

export function isValidClaudeSessionId(value?: string): value is string {
  return isCanonicalClaudeSessionId(value)
}
