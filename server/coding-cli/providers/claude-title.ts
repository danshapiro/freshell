import { extractTitleFromMessage } from '../../title-utils.js'

export function extractClaudeGeneratedTitleFromJsonlObject(obj: unknown, maxLen = 200): string | undefined {
  const record = obj as { type?: unknown; summary?: unknown }
  if (record?.type !== 'summary') return undefined
  if (typeof record.summary !== 'string' || !record.summary.trim()) return undefined
  const title = extractTitleFromMessage(record.summary, maxLen)
  return title || undefined
}
