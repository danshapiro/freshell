import path from 'path'
import { createHash } from 'crypto'
import fsp from 'fs/promises'
import { extractTitleFromMessage } from '../../title-utils.js'
import { isValidClaudeSessionId } from '../../claude-session-id.js'
import { getClaudeHome } from '../../claude-home.js'
import type { CodingCliProvider } from '../provider.js'
import type { NormalizedEvent, ParsedSessionMeta, TokenSummary } from '../types.js'
import { parseClaudeEvent, isMessageEvent, isResultEvent, isToolResultContent, isToolUseContent, isTextContent } from '../../claude-stream-types.js'
import { looksLikePath, isSystemContext, extractFromIdeContext, resolveGitCheckoutRoot } from '../utils.js'

export type JsonlMeta = {
  sessionId?: string
  cwd?: string
  title?: string
  summary?: string
  messageCount?: number
  gitBranch?: string
  isDirty?: boolean
  tokenUsage?: TokenSummary
}

const CLAUDE_DEFAULT_CONTEXT_WINDOW = 200_000
const CLAUDE_DEFAULT_COMPACT_PERCENT = 95
// Claude debug logs are noisy and can grow large. The last `autocompact:` entry can
// be pushed far away from the end of the file, so start with a cheap tail read and
// expand if no match is found.
const CLAUDE_DEBUG_AUTOCOMPACT_TAIL_BYTES = 128 * 1024
const CLAUDE_DEBUG_AUTOCOMPACT_MAX_READ_BYTES = 4 * 1024 * 1024

const CLAUDE_MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  'claude-opus-4-20250514': 200_000,
  'claude-sonnet-4-20250514': 200_000,
  'claude-3-7-sonnet-latest': 200_000,
  'claude-3-7-sonnet-20250219': 200_000,
  'claude-3-5-sonnet-latest': 200_000,
  'claude-3-5-sonnet-20241022': 200_000,
  'claude-3-5-sonnet-20240620': 200_000,
  'claude-3-5-haiku-latest': 200_000,
  'claude-3-5-haiku-20241022': 200_000,
  'claude-3-opus-20240229': 200_000,
  'claude-3-sonnet-20240229': 200_000,
  'claude-3-haiku-20240307': 200_000,
}

type ClaudeDebugAutocompactSnapshot = {
  tokens?: number
  threshold?: number
}

type ClaudeDebugAutocompactCacheEntry = {
  checkedAt: number
  mtimeMs?: number
  size?: number
  snapshot: ClaudeDebugAutocompactSnapshot | null
}

// Debug files are updated during a session. Cache results, but re-check periodically so
// token counts don't freeze and drift away from what Claude Code is showing.
const CLAUDE_DEBUG_AUTOCOMPACT_NEGATIVE_TTL_MS = 5_000
const claudeDebugAutocompactCache = new Map<string, ClaudeDebugAutocompactCacheEntry>()

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function resolveClaudeCompactPercentThreshold(): number {
  const override = toFiniteNumber(process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE)
  if (!override || override < 1) return CLAUDE_DEFAULT_COMPACT_PERCENT
  return Math.min(Math.round(override), CLAUDE_DEFAULT_COMPACT_PERCENT)
}

function resolveClaudeContextWindow(model: string | undefined): number {
  if (!model) return CLAUDE_DEFAULT_CONTEXT_WINDOW
  const normalized = model.toLowerCase().trim()
  return CLAUDE_MODEL_CONTEXT_WINDOWS[normalized] ?? CLAUDE_DEFAULT_CONTEXT_WINDOW
}

function normalizeCompactPercent(numerator: number, denominator: number): number {
  if (!Number.isFinite(denominator) || denominator <= 0) return 0
  const ratio = Math.round((numerator / denominator) * 100)
  return Math.max(0, Math.min(100, ratio))
}

function assistantUsageDedupKey(obj: any, line: string): string {
  const uuid = typeof obj?.uuid === 'string' ? obj.uuid.trim() : ''
  if (uuid) return `uuid:${uuid}`

  const messageId = typeof obj?.message?.id === 'string' ? obj.message.id.trim() : ''
  if (messageId) return `message:${messageId}`

  return `line:${createHash('sha1').update(line).digest('hex')}`
}

function parseAutocompactSnapshotFromDebugText(text: string): ClaudeDebugAutocompactSnapshot | undefined {
  const matches = text.matchAll(/autocompact:\s*tokens=(\d+)\s+threshold=(\d+)/g)
  let snapshot: ClaudeDebugAutocompactSnapshot | undefined
  for (const match of matches) {
    const tokens = Number(match[1])
    const threshold = Number(match[2])
    if (!snapshot) snapshot = {}
    if (Number.isFinite(tokens) && tokens > 0) {
      snapshot.tokens = tokens
    }
    if (Number.isFinite(threshold) && threshold > 0) {
      snapshot.threshold = threshold
    }
  }
  return snapshot?.tokens || snapshot?.threshold ? snapshot : undefined
}

async function readClaudeDebugAutocompactSnapshot(
  sessionId: string,
  claudeHome: string,
): Promise<ClaudeDebugAutocompactSnapshot | undefined> {
  if (!sessionId || !isValidClaudeSessionId(sessionId)) return undefined

  const debugPath = path.join(claudeHome, 'debug', `${sessionId}.txt`)
  const cacheKey = `${claudeHome}:${sessionId}`
  const now = Date.now()

  const cached = claudeDebugAutocompactCache.get(cacheKey)
  if (cached) {
    if (cached.snapshot === null && now - cached.checkedAt < CLAUDE_DEBUG_AUTOCOMPACT_NEGATIVE_TTL_MS) {
      return undefined
    }

    try {
      const stat = await fsp.stat(debugPath)
      const mtimeMs = stat.mtimeMs || stat.mtime.getTime()
      const size = stat.size
      if (cached.mtimeMs === mtimeMs && cached.size === size) {
        return cached.snapshot || undefined
      }
      // Fall through: file changed, so re-read below using this stat.
    } catch {
      claudeDebugAutocompactCache.set(cacheKey, {
        checkedAt: now,
        snapshot: null,
      })
      return undefined
    }
  }

  try {
    const stat = await fsp.stat(debugPath)
    const fd = await fsp.open(debugPath, 'r')
    let snapshot: ClaudeDebugAutocompactSnapshot | undefined
    try {
      const maxReadBytes = Math.min(stat.size, CLAUDE_DEBUG_AUTOCOMPACT_MAX_READ_BYTES)
      if (maxReadBytes <= 0) {
        claudeDebugAutocompactCache.set(cacheKey, {
          checkedAt: now,
          mtimeMs: stat.mtimeMs || stat.mtime.getTime(),
          size: stat.size,
          snapshot: null,
        })
        return undefined
      }

      const byteBudgets = Array.from(new Set([
        Math.min(CLAUDE_DEBUG_AUTOCOMPACT_TAIL_BYTES, maxReadBytes),
        Math.min(512 * 1024, maxReadBytes),
        Math.min(2 * 1024 * 1024, maxReadBytes),
        maxReadBytes,
      ])).filter((b) => b > 0)

      for (const bytesToRead of byteBudgets) {
        const start = Math.max(0, stat.size - bytesToRead)
        const buffer = Buffer.alloc(bytesToRead)
        const read = await fd.read(buffer, 0, bytesToRead, start)
        snapshot = parseAutocompactSnapshotFromDebugText(buffer.subarray(0, read.bytesRead).toString('utf8'))
        if (snapshot) break
      }
    } finally {
      await fd.close()
    }

    claudeDebugAutocompactCache.set(cacheKey, {
      checkedAt: now,
      mtimeMs: stat.mtimeMs || stat.mtime.getTime(),
      size: stat.size,
      snapshot: snapshot ?? null,
    })
    return snapshot
  } catch {
    claudeDebugAutocompactCache.set(cacheKey, {
      checkedAt: now,
      snapshot: null,
    })
    return undefined
  }
}

type ParseSessionOptions = {
  fallbackSessionId?: string
  compactThresholdTokens?: number
  contextTokens?: number
}

/** Parse session metadata from jsonl content (pure function for testing) */
export function parseSessionContent(content: string, options: ParseSessionOptions = {}): JsonlMeta {
  const lines = content.split(/\r?\n/).filter(Boolean)
  let sessionId: string | undefined
  let cwd: string | undefined
  let title: string | undefined
  let summary: string | undefined
  let gitBranch: string | undefined
  let isDirty: boolean | undefined
  let model: string | undefined
  const usageSeen = new Set<string>()
  let latestUsage:
    | {
      inputTokens: number
      outputTokens: number
      cachedTokens: number
    }
    | undefined

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

    if (!model) {
      const modelCandidate = [obj?.model, obj?.message?.model].find((v: any) => typeof v === 'string' && v.trim())
      if (typeof modelCandidate === 'string') model = modelCandidate
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

    if (!gitBranch) {
      const branchCandidate = [
        obj?.git?.branch,
        obj?.payload?.git?.branch,
        obj?.message?.git?.branch,
      ].find((v: any) => typeof v === 'string' && v.trim())
      if (typeof branchCandidate === 'string') gitBranch = branchCandidate.trim()
    }

    if (isDirty === undefined) {
      const dirtyCandidate = [
        obj?.git?.dirty,
        obj?.git?.isDirty,
        obj?.payload?.git?.dirty,
        obj?.payload?.git?.isDirty,
        obj?.message?.git?.dirty,
        obj?.message?.git?.isDirty,
      ].find((v: any) => typeof v === 'boolean')
      if (typeof dirtyCandidate === 'boolean') isDirty = dirtyCandidate
    }

    const isAssistantEntry =
      obj?.type === 'assistant' ||
      obj?.role === 'assistant' ||
      obj?.message?.role === 'assistant'

    const usage = obj?.message?.usage
    if (isAssistantEntry && usage && typeof usage === 'object') {
      const dedupeKey = assistantUsageDedupKey(obj, line)
      if (!usageSeen.has(dedupeKey)) {
        usageSeen.add(dedupeKey)
        latestUsage = {
          inputTokens: toFiniteNumber(usage.input_tokens) ?? 0,
          outputTokens: toFiniteNumber(usage.output_tokens) ?? 0,
          cachedTokens:
            (toFiniteNumber(usage.cache_read_input_tokens) ?? 0) +
            (toFiniteNumber(usage.cache_creation_input_tokens) ?? 0),
        }
      }
    }
  }

  if (!sessionId && options.fallbackSessionId && isValidClaudeSessionId(options.fallbackSessionId)) {
    sessionId = options.fallbackSessionId
  }

  let tokenUsage: TokenSummary | undefined
  if (latestUsage) {
    const contextTokensFromUsage = latestUsage.inputTokens + latestUsage.outputTokens + latestUsage.cachedTokens
    const contextTokens = options.contextTokens ?? contextTokensFromUsage
    const modelContextWindow = resolveClaudeContextWindow(model)
    const compactThresholdTokens =
      options.compactThresholdTokens ??
      Math.round((modelContextWindow * resolveClaudeCompactPercentThreshold()) / 100)
    tokenUsage = {
      inputTokens: latestUsage.inputTokens,
      outputTokens: latestUsage.outputTokens,
      cachedTokens: latestUsage.cachedTokens,
      totalTokens: contextTokens,
      contextTokens,
      modelContextWindow,
      compactThresholdTokens,
      compactPercent: normalizeCompactPercent(contextTokens, compactThresholdTokens),
    }
  }

  return {
    sessionId,
    cwd,
    title,
    summary,
    messageCount: lines.length,
    gitBranch,
    isDirty,
    tokenUsage,
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
        const entryPath = path.join(projectDir, entry)
        if (entry.endsWith('.jsonl')) {
          files.push(entryPath)
          continue
        }
        // Scan session subdirectories for subagents/*.jsonl
        try {
          const entryStat = await fsp.stat(entryPath)
          if (!entryStat.isDirectory()) continue
        } catch {
          continue
        }
        const subagentsDir = path.join(entryPath, 'subagents')
        try {
          const subEntries = await fsp.readdir(subagentsDir)
          for (const sub of subEntries) {
            if (sub.endsWith('.jsonl')) {
              files.push(path.join(subagentsDir, sub))
            }
          }
        } catch {
          // No subagents directory — that's fine
        }
      }
    }
    return files
  },

  async parseSessionFile(content: string, filePath: string): Promise<ParsedSessionMeta> {
    const fallbackSessionId = path.basename(filePath, '.jsonl')
    const debugAutocompact = await readClaudeDebugAutocompactSnapshot(fallbackSessionId, this.homeDir)
    return parseSessionContent(content, {
      fallbackSessionId,
      compactThresholdTokens: debugAutocompact?.threshold,
      contextTokens: debugAutocompact?.tokens,
    })
  },

  async resolveProjectPath(_filePath: string, meta: ParsedSessionMeta): Promise<string> {
    if (!meta.cwd) return 'unknown'
    return resolveGitCheckoutRoot(meta.cwd)
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
