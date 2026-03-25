/**
 * Extract user-only messages from a coding CLI session's JSONL content.
 * Returns the last MAX_CHARS characters of user messages joined with
 * "..." placeholders representing omitted assistant responses.
 * Biases towards recency by truncating from the front.
 */

import { stripAnsi } from './ai-prompts.js'

const MAX_CHARS = 20_000
const PLACEHOLDER = '...'

/**
 * Extract text content from a user message object.
 * Handles both Claude and Codex JSONL formats:
 * - Claude: { type: 'user', message: { role: 'user', content: string | ContentBlock[] } }
 *           or { role: 'user', content: string | ContentBlock[] }
 * - Codex: { type: 'response_item', payload: { type: 'message', role: 'user', content: ContentBlock[] } }
 */
function extractUserText(obj: any, provider: string): string | undefined {
  // Claude format: { type: 'user', message: { role: 'user', content: ... } }
  if (obj?.message?.role === 'user') {
    return resolveContent(obj.message.content)
  }

  // Claude format: { role: 'user', content: ... }
  if (obj?.role === 'user') {
    return resolveContent(obj.content)
  }

  // Codex format: { type: 'response_item', payload: { type: 'message', role: 'user', content: ... } }
  if (
    provider === 'codex' &&
    obj?.type === 'response_item' &&
    obj?.payload?.type === 'message' &&
    obj?.payload?.role === 'user'
  ) {
    return resolveContent(obj.payload.content)
  }

  return undefined
}

function resolveContent(content: unknown): string | undefined {
  if (typeof content === 'string') return content

  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const block of content) {
      if (typeof block === 'string') {
        parts.push(block)
      } else if (block && typeof block === 'object') {
        const text = (block as { text?: unknown }).text
        if (typeof text === 'string') parts.push(text)
      }
    }
    return parts.length > 0 ? parts.join('\n') : undefined
  }

  if (content && typeof content === 'object' && !Array.isArray(content)) {
    const text = (content as { text?: unknown }).text
    if (typeof text === 'string') return text
  }

  return undefined
}

export function extractUserMessages(jsonlContent: string, provider: string): string {
  if (!jsonlContent.trim()) return ''

  const lines = jsonlContent.split(/\r?\n/).filter(Boolean)
  const userMessages: string[] = []

  for (const line of lines) {
    let obj: any
    try {
      obj = JSON.parse(line)
    } catch {
      continue
    }

    const text = extractUserText(obj, provider)
    if (text) {
      const cleaned = stripAnsi(text).trim()
      if (cleaned) {
        userMessages.push(cleaned)
      }
    }
  }

  if (userMessages.length === 0) return ''

  // Join with placeholder separators
  const joined = userMessages.join(`\n${PLACEHOLDER}\n`)

  // Truncate from the front to keep the last MAX_CHARS, biasing recency
  if (joined.length <= MAX_CHARS) return joined
  return joined.slice(-MAX_CHARS)
}
