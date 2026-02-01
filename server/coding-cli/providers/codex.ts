import path from 'path'
import os from 'os'
import fsp from 'fs/promises'
import { extractTitleFromMessage } from '../../title-utils.js'
import type { CodingCliProvider } from '../provider.js'
import type { NormalizedEvent, ParsedSessionMeta } from '../types.js'
import { looksLikePath } from '../utils.js'

export function defaultCodexHome(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex')
}

function extractTextContent(items: any[] | undefined): string {
  if (!Array.isArray(items)) return ''
  return items
    .map((item) => (item && typeof item.text === 'string' ? item.text : ''))
    .filter(Boolean)
    .join('\n')
}

export function parseCodexSessionContent(content: string): ParsedSessionMeta {
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

    if (obj?.type === 'session_meta') {
      const payload = obj.payload || {}
      if (!sessionId && typeof payload.id === 'string') sessionId = payload.id
      if (!cwd && typeof payload.cwd === 'string' && looksLikePath(payload.cwd)) {
        cwd = payload.cwd
      }
    }

    if (!cwd) {
      const possible = obj?.payload?.cwd || obj?.cwd || obj?.context?.cwd
      if (typeof possible === 'string' && looksLikePath(possible)) {
        cwd = possible
      }
    }

    if (!title && obj?.type === 'response_item' && obj?.payload?.type === 'message' && obj?.payload?.role === 'user') {
      const text = extractTextContent(obj.payload.content)
      if (text.trim()) {
        title = extractTitleFromMessage(text, 200)
      }
    }

    if (!summary && obj?.type === 'response_item' && obj?.payload?.type === 'message' && obj?.payload?.role === 'assistant') {
      const text = extractTextContent(obj.payload.content)
      if (text.trim()) {
        summary = text.trim().slice(0, 240)
      }
    }

    if (!cwd && obj?.type === 'turn_context' && typeof obj?.payload?.cwd === 'string') {
      const ctxCwd = obj.payload.cwd
      if (looksLikePath(ctxCwd)) cwd = ctxCwd
    }

    if (sessionId && cwd && title && summary) break
  }

  return {
    sessionId,
    cwd,
    title,
    summary,
    messageCount: lines.length,
  }
}

function extractSessionIdFromFilename(filePath: string): string {
  const base = path.basename(filePath, '.jsonl')
  const match = base.match(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/)
  return match ? match[0] : base
}

async function walkJsonlFiles(dir: string): Promise<string[]> {
  let entries: any[] = []
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }

  const files: string[] = []
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await walkJsonlFiles(full)))
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      files.push(full)
    }
  }
  return files
}

export const codexProvider: CodingCliProvider = {
  name: 'codex',
  displayName: 'Codex',
  homeDir: defaultCodexHome(),

  getSessionGlob() {
    return path.join(this.homeDir, 'sessions', '**', '*.jsonl')
  },

  async listSessionFiles() {
    const sessionsDir = path.join(this.homeDir, 'sessions')
    return walkJsonlFiles(sessionsDir)
  },

  parseSessionFile(content: string) {
    return parseCodexSessionContent(content)
  },

  async resolveProjectPath(_filePath: string, meta: ParsedSessionMeta): Promise<string> {
    return meta.cwd || 'unknown'
  },

  extractSessionId(filePath: string, meta?: ParsedSessionMeta): string {
    return meta?.sessionId || extractSessionIdFromFilename(filePath)
  },

  getCommand() {
    return process.env.CODEX_CMD || 'codex'
  },

  getStreamArgs(options) {
    // CRITICAL: Codex --json flag ONLY works with `exec` mode (non-interactive).
    // For `resume`, we cannot use --json - the interactive TUI doesn't support JSON output.
    // Resume sessions must be spawned as PTY without JSON parsing.
    if (options.resumeSessionId) {
      // Return resume args WITHOUT --json - caller should use PTY mode
      const args = ['resume', options.resumeSessionId]
      if (options.model) args.push('--model', options.model)
      if (options.sandbox) args.push('--sandbox', options.sandbox)
      return args
    }

    // For new exec sessions, use --json for streaming
    const args = ['exec', '--json']
    if (options.model) args.push('--model', options.model)
    if (options.sandbox) args.push('--sandbox', options.sandbox)
    args.push(options.prompt)
    return args
  },

  getResumeArgs(sessionId: string) {
    return ['resume', sessionId]
  },

  parseEvent(line: string): NormalizedEvent[] {
    const obj = JSON.parse(line)
    const timestamp = obj?.timestamp || new Date().toISOString()
    const sessionId =
      obj?.payload?.id ||
      obj?.payload?.session_id ||
      obj?.session_id ||
      obj?.payload?.sessionId ||
      'unknown'

    const base = {
      timestamp,
      sessionId,
      provider: 'codex' as const,
      raw: obj,
    }

    if (obj?.type === 'session_meta') {
      const sessionPayload = {
        cwd: obj?.payload?.cwd,
        model: obj?.payload?.model || obj?.payload?.model_provider,
        provider: 'codex' as const,
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

    if (obj?.type === 'response_item' && obj?.payload?.type === 'message') {
      const role = obj.payload.role === 'user' ? 'user' as const : 'assistant' as const
      const content = extractTextContent(obj.payload.content).trim()
      return [
        {
          ...base,
          type: role === 'user' ? 'message.user' : 'message.assistant',
          message: { role, content },
        },
      ]
    }

    if (obj?.type === 'response_item' && obj?.payload?.type === 'function_call') {
      let args: unknown = obj.payload.arguments
      if (typeof args === 'string') {
        try {
          args = JSON.parse(args)
        } catch {
          // keep as string
        }
      }
      const toolPayload = {
        callId: obj.payload.call_id || 'unknown',
        name: obj.payload.name || 'unknown',
        arguments: args,
      }
      return [
        {
          ...base,
          type: 'tool.call',
          tool: toolPayload,
          // Legacy alias
          toolCall: {
            id: obj.payload.call_id || 'unknown',
            name: obj.payload.name || 'unknown',
            arguments: args,
          },
        },
      ]
    }

    if (obj?.type === 'response_item' && obj?.payload?.type === 'function_call_output') {
      const toolPayload = {
        callId: obj.payload.call_id || 'unknown',
        name: '',
        output: obj.payload.output || '',
        isError: false,
      }
      return [
        {
          ...base,
          type: 'tool.result',
          tool: toolPayload,
          // Legacy alias
          toolResult: {
            id: obj.payload.call_id || 'unknown',
            output: obj.payload.output || '',
            isError: false,
          },
        },
      ]
    }

    if (obj?.type === 'event_msg' && obj?.payload?.type === 'agent_reasoning') {
      return [
        {
          ...base,
          type: 'reasoning',
          reasoning: obj.payload.text || obj.payload.message || '',
          thinking: obj.payload.text || obj.payload.message || '',
        },
      ]
    }

    if (obj?.type === 'event_msg' && obj?.payload?.type === 'agent_message') {
      const content = obj.payload.message || obj.payload.text || ''
      return [
        {
          ...base,
          type: 'message.assistant',
          message: { role: 'assistant', content },
        },
      ]
    }

    if (obj?.type === 'event_msg' && obj?.payload?.type === 'token_count') {
      const input = Number(obj.payload.input || 0)
      const output = Number(obj.payload.output || 0)
      const total = Number(obj.payload.total || input + output)
      return [
        {
          ...base,
          type: 'token.usage',
          tokens: { inputTokens: input, outputTokens: output },
          tokenUsage: { input, output, total }, // Legacy alias
        },
      ]
    }

    return []
  },

  supportsLiveStreaming() {
    // IMPORTANT: Codex supports JSON streaming only in `exec` mode (one-shot non-interactive).
    // We still allow streaming sessions for new prompts, but resume requires PTY mode.
    return true
  },

  supportsSessionResume() {
    // Codex supports resume via `codex resume <sessionId>` but NOT with JSON output.
    // Streaming resume is not supported; use terminal.create with mode='codex'.
    return false
  },
}
