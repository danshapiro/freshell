/**
 * Extracts a display title from user message content.
 * Used for auto-naming tabs and sessions based on the first user prompt.
 *
 * For multi-line content, uses the first non-empty line as the title
 * (instead of collapsing all whitespace and truncating mid-thought).
 * Single-line behavior: collapse whitespace, trim, truncate to maxLen.
 */
export function extractTitleFromMessage(content: string, maxLen = 50): string {
  // For multi-line content, use first non-empty line
  if (content.includes('\n')) {
    const lines = content.split('\n')
    const firstLine = lines.find((line) => line.trim().length > 0)
    if (firstLine) {
      const cleaned = firstLine.trim().replace(/\s+/g, ' ')
      return cleaned.length <= maxLen ? cleaned : cleaned.slice(0, maxLen)
    }
    return ''
  }

  // Single-line: collapse whitespace, trim
  const cleaned = content.trim().replace(/\s+/g, ' ')

  if (cleaned.length <= maxLen) {
    return cleaned
  }

  // Truncate to maxLen (UI can add ellipsis via CSS if needed)
  return cleaned.slice(0, maxLen)
}

/**
 * Extracts title from a JSONL line object.
 * Matches the logic in parseSessionContent but for a single parsed object.
 */
export function extractTitleFromJsonlObject(obj: any, maxLen = 50): string | undefined {
  // Check explicit title fields first
  const explicitTitle = obj?.title || obj?.sessionTitle
  if (typeof explicitTitle === 'string' && explicitTitle.trim()) {
    return extractTitleFromMessage(explicitTitle, maxLen)
  }

  // Check for user message content
  const userContent =
    (obj?.role === 'user' && typeof obj?.content === 'string' ? obj.content : undefined) ||
    (obj?.message?.role === 'user' && typeof obj?.message?.content === 'string' ? obj.message.content : undefined)

  if (typeof userContent === 'string' && userContent.trim()) {
    return extractTitleFromMessage(userContent, maxLen)
  }

  return undefined
}
