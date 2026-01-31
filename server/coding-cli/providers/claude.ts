import path from 'path'
import os from 'os'
import fsp from 'fs/promises'
import { extractTitleFromMessage } from '../../title-utils.js'
import type { CodingCliProvider } from '../provider.js'
import type { NormalizedEvent, ParsedSessionMeta } from '../types.js'
import { parseClaudeEvent, isMessageEvent, isResultEvent, isToolResultContent, isToolUseContent, isTextContent } from '../../claude-stream-types.js'
import { looksLikePath } from '../utils.js'

export function defaultClaudeHome(): string {
  // Claude Code stores logs in ~/.claude by default (Linux/macOS).
  // On Windows, set CLAUDE_HOME to a path you can access from Node (e.g. \\wsl$\\...).
  return process.env.CLAUDE_HOME || path.join(os.homedir(), '.claude')
}

async function tryReadJson(filePath: string): Promise<any | null> {
  try {
    const raw = await fsp.readFile(filePath, 'utf-8')
    return JSON.parse(raw)
  } catch {
    return null
  }
}

async function resolveProjectPath(projectDir: string): Promise<string> {
  // Try known files first
  const candidates = ['project.json', 'metadata.json', 'config.json']
  for (const name of candidates) {
    const p = path.join(projectDir, name)
    const json = await tryReadJson(p)
    if (json) {
      const possible =
        json.projectPath || json.path || json.cwd || json.root || json.project_root || json.project_root_path
      if (typeof possible === 'string' && looksLikePath(possible)) return possible
    }
  }

  // Heuristic: scan small json files in directory
  try {
    const files = await fsp.readdir(projectDir)
    for (const f of files) {
      if (!f.endsWith('.json')) continue
      const p = path.join(projectDir, f)
      const stat = await fsp.stat(p)
      if (stat.size > 200_000) continue
      const json = await tryReadJson(p)
      if (!json) continue
      const keys = ['projectPath', 'path', 'cwd', 'root']
      for (const k of keys) {
        const v = json[k]
        if (typeof v === 'string' && looksLikePath(v)) return v
      }
    }
  } catch {}

  // Fallback to directory name.
  return path.basename(projectDir)
}

export type JsonlMeta = {
  cwd?: string
  title?: string
  summary?: string
  messageCount?: number
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

      if (typeof t === 'string' && t.trim()) {
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

  async resolveProjectPath(filePath: string): Promise<string> {
    const projectDir = path.dirname(filePath)
    return resolveProjectPath(projectDir)
  },

  extractSessionId(filePath: string): string {
    return path.basename(filePath, '.jsonl')
  },

  getCommand() {
    return process.env.CLAUDE_CMD || 'claude'
  },

  getStreamArgs(options) {
    const args = ['-p', options.prompt, '--output-format', 'stream-json']
    if (options.resumeSessionId) {
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
      raw: event,
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
