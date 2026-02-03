const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isValidClaudeSessionId(value?: string): value is string {
  return typeof value === 'string' && UUID_REGEX.test(value)
}
