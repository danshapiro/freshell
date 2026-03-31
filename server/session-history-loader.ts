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

export interface LoadSessionHistoryDeps {
  /** O(1) path resolver from session indexer. Returns file path or undefined. */
  resolveFilePath?: (sessionId: string) => string | undefined
  /** Parsed content cache. When provided, avoids re-reading unchanged files. */
  contentCache?: { get(filePath: string): Promise<ChatMessage[] | null> }
}

/**
 * Parse JSONL content from a Claude Code session file and extract chat messages
 * in the normalized shape used by visible-first restore flows.
 */
export function extractChatMessagesFromJsonl(content: string): ChatMessage[] {
  const lines = content.split(/\r?\n/).filter(Boolean)
  const messages: ChatMessage[] = []

  /** Check if content blocks contain only tool_use and tool_result blocks. */
  const isToolOnly = (blocks: ContentBlock[]): boolean =>
    blocks.length > 0 && blocks.every(
      (b) => b.type === 'tool_use' || b.type === 'tool_result'
    )

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

    let newContent: ContentBlock[]
    let newMessage: ChatMessage

    if (typeof msg === 'string') {
      // Simple/legacy format: message is a plain string
      newContent = [{ type: 'text', text: msg }]
      newMessage = {
        role,
        content: newContent,
        ...(timestamp ? { timestamp } : {}),
      }
    } else if (msg && typeof msg === 'object' && Array.isArray(msg.content)) {
      // Structured format: message is a ClaudeMessage object
      newContent = msg.content as ContentBlock[]
      newMessage = {
        role: msg.role || role,
        content: newContent,
        ...(timestamp ? { timestamp } : {}),
        ...(msg.model ? { model: msg.model } : {}),
      }
    } else {
      continue
    }

    // Coalesce consecutive tool-only assistant messages
    const prevMessage = messages[messages.length - 1]
    if (
      prevMessage?.role === 'assistant' &&
      newMessage.role === 'assistant' &&
      isToolOnly(prevMessage.content) &&
      isToolOnly(newMessage.content)
    ) {
      // Append content blocks to previous message
      prevMessage.content = [...prevMessage.content, ...newMessage.content]
    } else {
      messages.push(newMessage)
    }
  }

  return messages
}

/** Read a file and parse its JSONL content into ChatMessages. */
async function readAndParse(filePath: string): Promise<ChatMessage[] | null> {
  try {
    const content = await fsp.readFile(filePath, 'utf-8')
    return extractChatMessagesFromJsonl(content)
  } catch {
    return null
  }
}

/**
 * Find and load chat messages from a Claude Code session .jsonl file.
 *
 * When `deps.resolveFilePath` is provided and returns a path, reads that file
 * directly (O(1) lookup). Falls back to the brute-force directory scan when:
 *   - No resolver is provided
 *   - The resolver returns undefined
 *   - The resolved file cannot be read
 *
 * When `deps.contentCache` is provided, delegates file reading to the cache
 * (which handles mtime+size stat invalidation and request coalescing).
 */
export async function loadSessionHistory(
  sessionId: string,
  claudeHome?: string,
  deps?: LoadSessionHistoryDeps,
): Promise<ChatMessage[] | null> {
  // Prevent path traversal: only allow the basename (no slashes or ..)
  const safeName = path.basename(sessionId)
  if (!safeName || safeName !== sessionId) return null

  // Layer 1: resolve via index
  const resolvedPath = deps?.resolveFilePath?.(sessionId)
  if (resolvedPath) {
    // Layer 2: check content cache
    if (deps?.contentCache) {
      const cached = await deps.contentCache.get(resolvedPath)
      if (cached !== null) return cached
    } else {
      const result = await readAndParse(resolvedPath)
      if (result !== null) return result
    }
  }

  // Brute-force directory scan (original behavior)
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

  const filename = `${safeName}.jsonl`

  for (const dir of projectDirs) {
    // Check directly under the project dir (standard Claude Code layout)
    const directPath = path.join(dir, filename)
    if (deps?.contentCache) {
      const cached = await deps.contentCache.get(directPath)
      if (cached !== null) return cached
    } else {
      const result = await readAndParse(directPath)
      if (result !== null) return result
    }

    // Check subdirectories (e.g. sessions/, or session-id dirs with subagents)
    try {
      const entries = await fsp.readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const nestedPath = path.join(dir, entry.name, filename)
        if (deps?.contentCache) {
          const cached = await deps.contentCache.get(nestedPath)
          if (cached !== null) return cached
        } else {
          const result = await readAndParse(nestedPath)
          if (result !== null) return result
        }
      }
    } catch {
      // Failed to read subdirectories
    }
  }

  return null
}
