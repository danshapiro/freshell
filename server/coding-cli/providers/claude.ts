import path from 'path'
import os from 'os'
import fsp from 'fs/promises'
import { extractTitleFromMessage } from '../../title-utils.js'
import { isValidClaudeSessionId } from '../../claude-session-id.js'
import type { CodingCliProvider } from '../provider.js'
import type { NormalizedEvent, ParsedSessionMeta } from '../types.js'
import { parseClaudeEvent, isMessageEvent, isResultEvent, isToolResultContent, isToolUseContent, isTextContent } from '../../claude-stream-types.js'
import { looksLikePath } from '../utils.js'

export function defaultClaudeHome(): string {
  // Claude Code stores logs in ~/.claude by default (Linux/macOS).
  // On Windows, set CLAUDE_HOME to a path you can access from Node (e.g. \\wsl$\\...).
  return process.env.CLAUDE_HOME || path.join(os.homedir(), '.claude')
}

export type JsonlMeta = {
  cwd?: string
  title?: string
  summary?: string
  messageCount?: number
}

/**
 * Check if a "user" message is actually system context.
 * Claude subagents inject system prompts as role:"user" messages:
 * - Agent mode instructions: [SUGGESTION MODE: ...], [REVIEW MODE: ...]
 * - AGENTS.md/instruction files: "# AGENTS.md instructions..."
 * - XML-wrapped system context: <system_context>, <environment_context>, etc.
 */
function isSystemContext(text: string): boolean {
  const trimmed = text.trim()
  // Bracketed agent mode instructions: [SUGGESTION MODE: ...], [REVIEW MODE: ...]
  if (/^\[[A-Z][A-Z_ ]*:/.test(trimmed)) return true
  // XML-wrapped system context: <system_context>, <environment_context>, <INSTRUCTIONS>, etc.
  if (/^<[a-zA-Z_][\w_-]*[>\s]/.test(trimmed)) return true
  // Instruction file headers: "# AGENTS.md instructions for...", "# System", "# Instructions"
  if (/^#\s*(AGENTS|Instructions?|System)/i.test(trimmed)) return true
  return false
}

/** Parse session metadata from jsonl content (pure function for testing) */
export function parseSessionContent(content: string): JsonlMeta {
  const lines = content.split(/\r?\n/).filter(Boolean)
  let cwd: string | undefined
  let title: string | undefined
  let summary: string | undefined

  for (const line of lines) {
    let obj: any
    try {
      obj = JSON.parse(line)
    } catch {
      continue
    }

    const candidates = [
      obj?.cwd,
      obj?.context?.cwd,
      obj?.payload?.cwd,
      obj?.data?.cwd,
      obj?.message?.cwd,
    ].filter((v: any) => typeof v === 'string') as string[]
    if (!cwd) {
      const found = candidates.find((v) => looksLikePath(v))
      if (found) cwd = found
    }

    if (!title) {
      const t =
        obj?.title ||
        obj?.sessionTitle ||
        (obj?.role === 'user' && typeof obj?.content === 'string' ? obj.content : undefined) ||
        (obj?.message?.role === 'user' && typeof obj?.message?.content === 'string'
          ? obj.message.content
          : undefined)

      if (typeof t === 'string' && t.trim() && !isSystemContext(t)) {
        // Store up to 200 chars - UI truncates visually, tooltip shows full text
        title = extractTitleFromMessage(t, 200)
      }
    }

    if (!summary) {
      const s = obj?.summary || obj?.sessionSummary
      if (typeof s === 'string' && s.trim()) summary = s.trim().slice(0, 240)
    }

    if (cwd && title && summary) break
  }

  return {
    cwd,
    title,
    summary,
    messageCount: lines.length,
  }
}

export const claudeProvider: CodingCliProvider = {
  name: 'claude',
  displayName: 'Claude',
  homeDir: defaultClaudeHome(),

  getSessionGlob() {
    return path.join(this.homeDir, 'projects', '**', '*.jsonl')
  },

  async listSessionFiles() {
    const projectsDir = path.join(this.homeDir, 'projects')
    let projectDirs: string[] = []
    try {
      projectDirs = (await fsp.readdir(projectsDir)).map((name) => path.join(projectsDir, name))
    } catch {
      return []
    }

    const files: string[] = []
    for (const projectDir of projectDirs) {
      try {
        const stat = await fsp.stat(projectDir)
        if (!stat.isDirectory()) continue
      } catch {
        continue
      }

      let entries: string[] = []
      try {
        entries = await fsp.readdir(projectDir)
      } catch {
        continue
      }
      for (const entry of entries) {
        if (!entry.endsWith('.jsonl')) continue
        files.push(path.join(projectDir, entry))
      }
    }
    return files
  },

  parseSessionFile(content: string): ParsedSessionMeta {
    return parseSessionContent(content)
  },

  async resolveProjectPath(_filePath: string, meta: ParsedSessionMeta): Promise<string> {
    return meta.cwd || 'unknown'
  },

  extractSessionId(filePath: string): string {
    return path.basename(filePath, '.jsonl')
  },

  getCommand() {
    return process.env.CLAUDE_CMD || 'claude'
  },

  getStreamArgs(options) {
    const args = ['-p', options.prompt, '--output-format', 'stream-json']
    if (options.resumeSessionId && isValidClaudeSessionId(options.resumeSessionId)) {
      args.push('--resume', options.resumeSessionId)
    }
    if (options.model) {
      args.push('--model', options.model)
    }
    if (options.maxTurns) {
      args.push('--max-turns', String(options.maxTurns))
    }
    if (options.permissionMode) {
      args.push('--permission-mode', options.permissionMode)
    }
    if (options.allowedTools?.length) {
      for (const tool of options.allowedTools) args.push('--allowedTools', tool)
    }
    if (options.disallowedTools?.length) {
      for (const tool of options.disallowedTools) args.push('--disallowedTools', tool)
    }
    return args
  },

  getResumeArgs(sessionId: string) {
    if (!isValidClaudeSessionId(sessionId)) return []
    return ['--resume', sessionId]
  },

  parseEvent(line: string): NormalizedEvent[] {
    const event = parseClaudeEvent(line)
    const now = new Date().toISOString()
    const sessionId = 'session_id' in event ? event.session_id : 'unknown'
    const base = {
      timestamp: now,
      sessionId,
      provider: 'claude' as const,
    }

    if (event.type === 'system' && 'subtype' in event && event.subtype === 'init') {
      const sessionPayload = {
        cwd: event.cwd,
        model: event.model,
        provider: 'claude' as const,
      }
      return [
        {
          ...base,
          type: 'session.start',
          session: sessionPayload,
          sessionInfo: sessionPayload, // Legacy alias
        },
      ]
    }

    if (isMessageEvent(event)) {
      const events: NormalizedEvent[] = []
      const textBlocks = event.message.content.filter(isTextContent).map((b) => b.text)
      const hasExplicitText = textBlocks.length > 0
      const hasNoContent = event.message.content.length === 0
      if (hasExplicitText || hasNoContent) {
        events.push({
          ...base,
          type: event.type === 'user' ? 'message.user' : 'message.assistant',
          message: {
            role: event.message.role as 'user' | 'assistant',
            content: textBlocks.join('\\n').trim(),
          },
        })
      }

      for (const block of event.message.content) {
        if (isToolUseContent(block)) {
          const toolPayload = {
            callId: block.id,
            name: block.name,
            arguments: block.input,
          }
          events.push({
            ...base,
            type: 'tool.call',
            tool: toolPayload,
            // Legacy alias
            toolCall: {
              id: block.id,
              name: block.name,
              arguments: block.input,
            },
          })
        }
        if (isToolResultContent(block)) {
          const toolPayload = {
            callId: block.tool_use_id,
            name: '', // Claude tool_result doesn't include name
            output: block.content,
            isError: block.is_error ?? false,
          }
          events.push({
            ...base,
            type: 'tool.result',
            tool: toolPayload,
            // Legacy alias
            toolResult: {
              id: block.tool_use_id,
              output: block.content,
              isError: block.is_error ?? false,
            },
          })
        }
      }

      return events
    }

    if (isResultEvent(event)) {
      const tokensPayload = event.usage
        ? {
            inputTokens: event.usage.input_tokens ?? 0,
            outputTokens: event.usage.output_tokens ?? 0,
          }
        : undefined
      const tokenUsageLegacy = event.usage
        ? {
            input: event.usage.input_tokens ?? 0,
            output: event.usage.output_tokens ?? 0,
            total: (event.usage.input_tokens ?? 0) + (event.usage.output_tokens ?? 0),
          }
        : undefined
      return [
        {
          ...base,
          type: 'session.end',
          tokens: tokensPayload,
          tokenUsage: tokenUsageLegacy, // Legacy alias
        },
      ]
    }

    return []
  },

  supportsLiveStreaming() {
    return true
  },

  supportsSessionResume() {
    return true
  },
}
