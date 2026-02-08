import path from 'path'
import fsp from 'fs/promises'
import { extractTitleFromMessage } from '../../title-utils.js'
import { isValidClaudeSessionId } from '../../claude-session-id.js'
import { getClaudeHome } from '../../claude-home.js'
import type { CodingCliProvider } from '../provider.js'
import type { NormalizedEvent, ParsedSessionMeta } from '../types.js'
import { parseClaudeEvent, isMessageEvent, isResultEvent, isToolResultContent, isToolUseContent, isTextContent } from '../../claude-stream-types.js'
import { looksLikePath, isSystemContext, extractFromIdeContext } from '../utils.js'

export type JsonlMeta = {
  sessionId?: string
  cwd?: string
  title?: string
  summary?: string
  messageCount?: number
}

/** Parse session metadata from jsonl content (pure function for testing) */
export function parseSessionContent(content: string): JsonlMeta {
  const lines = content.split(/\r?\n/).filter(Boolean)
  let sessionId: string | undefined
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

    if (!sessionId) {
      const candidates = [
        obj?.sessionId,
        obj?.session_id,
        obj?.message?.sessionId,
        obj?.message?.session_id,
        obj?.data?.sessionId,
        obj?.data?.session_id,
      ].filter((v: any) => typeof v === 'string') as string[]
      const valid = candidates.find((v) => isValidClaudeSessionId(v))
      if (valid) sessionId = valid
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

      if (typeof t === 'string' && t.trim()) {
        // Try to extract user request from IDE-formatted context first
        const ideRequest = extractFromIdeContext(t)
        if (ideRequest) {
          title = extractTitleFromMessage(ideRequest, 200)
        } else if (!isSystemContext(t)) {
          // Store up to 200 chars - UI truncates visually, tooltip shows full text
          title = extractTitleFromMessage(t, 200)
        }
      }
    }

    if (!summary) {
      const s = obj?.summary || obj?.sessionSummary
      if (typeof s === 'string' && s.trim()) summary = s.trim().slice(0, 240)
    }

    if (cwd && title && summary && sessionId) break
  }

  return {
    sessionId,
    cwd,
    title,
    summary,
    messageCount: lines.length,
  }
}

export const claudeProvider: CodingCliProvider = {
  name: 'claude',
  displayName: 'Claude',
  homeDir: getClaudeHome(),

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
    // Claude Code requires verbose mode for stream-json output. Enable it explicitly so
    // behavior doesn't depend on the user's local Claude config (which can otherwise
    // cause silent hangs / missing output in our integration test and UI).
    const args = ['-p', options.prompt, '--output-format', 'stream-json', '--verbose']
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
