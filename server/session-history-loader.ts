/**
 * Loads chat history from Claude Code session .jsonl files.
 * Used to populate FreshClaude pane history when resuming a session
 * after server restart.
 */

import fsp from 'fs/promises'
import path from 'path'
import { getClaudeHome } from './claude-home.js'
import type { ContentBlock } from '../shared/ws-protocol.js'

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: ContentBlock[]
  timestamp?: string
  model?: string
}

/**
 * Parse JSONL content from a Claude Code session file and extract chat messages
 * in the format compatible with sdk.history.
 */
export function extractChatMessagesFromJsonl(content: string): ChatMessage[] {
  const lines = content.split(/\r?\n/).filter(Boolean)
  const messages: ChatMessage[] = []

  for (const line of lines) {
    let obj: any
    try {
      obj = JSON.parse(line)
    } catch {
      continue
    }

    // Only process user and assistant message events
    if (obj.type !== 'user' && obj.type !== 'assistant') continue

    const role = obj.type as 'user' | 'assistant'
    const timestamp = obj.timestamp as string | undefined
    const msg = obj.message

    if (typeof msg === 'string') {
      // Simple/legacy format: message is a plain string
      messages.push({
        role,
        content: [{ type: 'text', text: msg }],
        ...(timestamp ? { timestamp } : {}),
      })
    } else if (msg && typeof msg === 'object' && Array.isArray(msg.content)) {
      // Structured format: message is a ClaudeMessage object
      messages.push({
        role: msg.role || role,
        content: msg.content as ContentBlock[],
        ...(timestamp ? { timestamp } : {}),
        ...(msg.model ? { model: msg.model } : {}),
      })
    }
  }

  return messages
}

/**
 * Find and load chat messages from a Claude Code session .jsonl file.
 * Searches all project directories under `<claudeHome>/projects/` for the session file.
 * Returns parsed ChatMessage[] or null if the session file is not found.
 */
export async function loadSessionHistory(
  sessionId: string,
  claudeHome?: string,
): Promise<ChatMessage[] | null> {
  const home = claudeHome ?? getClaudeHome()
  const projectsDir = path.join(home, 'projects')

  let projectDirs: string[]
  try {
    const entries = await fsp.readdir(projectsDir, { withFileTypes: true })
    projectDirs = entries
      .filter((e) => e.isDirectory())
      .map((e) => path.join(projectsDir, e.name))
  } catch {
    return null
  }

  // Prevent path traversal: only allow the basename (no slashes or ..)
  const safeName = path.basename(sessionId)
  if (!safeName || safeName !== sessionId) return null
  const filename = `${safeName}.jsonl`

  for (const dir of projectDirs) {
    // Check directly under the project dir (standard Claude Code layout)
    const directPath = path.join(dir, filename)
    try {
      const content = await fsp.readFile(directPath, 'utf-8')
      return extractChatMessagesFromJsonl(content)
    } catch {
      // Not found directly, check one level of subdirectories
    }

    // Check subdirectories (e.g. sessions/, or session-id dirs with subagents)
    try {
      const entries = await fsp.readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const nestedPath = path.join(dir, entry.name, filename)
        try {
          const content = await fsp.readFile(nestedPath, 'utf-8')
          return extractChatMessagesFromJsonl(content)
        } catch {
          // Not found in this subdirectory
        }
      }
    } catch {
      // Failed to read subdirectories
    }
  }

  return null
}
