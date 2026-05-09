import { isCanonicalClaudeSessionId } from '../shared/session-contract.js'

export function isValidClaudeSessionId(value?: string): value is string {
  return isCanonicalClaudeSessionId(value)
}
