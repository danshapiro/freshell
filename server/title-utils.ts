// Re-export the shared title extraction utility so existing server imports continue to work.
import { extractTitleFromMessage } from '../shared/title-utils.js'
export { extractTitleFromMessage }

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
