import path from 'path'
import os from 'os'
import fsp from 'fs/promises'
import type { CodingCliProvider } from '../provider.js'
import { normalizeFirstUserMessage, type NormalizedEvent, type ParsedSessionMeta } from '../types.js'
import { resolveGitRepoRoot, statMtimeMs } from '../utils.js'

// Amplifier transcripts can grow to tens of MB. For the sidebar's first-user-message
// preview we only ever read a bounded prefix of the sibling transcript, never the whole file.
const AMPLIFIER_FIRST_USER_MESSAGE_MAX_READ_BYTES = 64 * 1024

export function defaultAmplifierHome(): string {
  return process.env.AMPLIFIER_HOME || path.join(os.homedir(), '.amplifier')
}

function parseTimestampMs(value: unknown): number | undefined {
  // Floor numeric passthroughs: downstream read-model schemas require integer epoch-ms.
  if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(value)
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function maxDefined(...values: Array<number | undefined>): number | undefined {
  let result: number | undefined
  for (const value of values) {
    if (value === undefined) continue
    result = result === undefined ? value : Math.max(result, value)
  }
  return result
}

/** Split an assistant `content` payload into reasoning (thinking) and visible text parts. */
function extractAssistantParts(content: unknown): { reasoning: string[]; text: string[] } {
  const reasoning: string[] = []
  const text: string[] = []

  if (typeof content === 'string') {
    if (content.trim()) text.push(content)
    return { reasoning, text }
  }

  if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== 'object') continue
      const typed = block as { type?: unknown; text?: unknown; thinking?: unknown }
      if (typed.type === 'thinking' && typeof typed.thinking === 'string' && typed.thinking.trim()) {
        reasoning.push(typed.thinking)
      } else if (typed.type === 'text' && typeof typed.text === 'string' && typed.text.trim()) {
        text.push(typed.text)
      } else if (typeof typed.text === 'string' && typed.text.trim()) {
        text.push(typed.text)
      }
    }
  }

  return { reasoning, text }
}

/**
 * Map an Amplifier `metadata.json` document to ParsedSessionMeta.
 * Pure and synchronous (no disk access) so it is trivial to test.
 */
export function parseAmplifierMetadata(content: string): ParsedSessionMeta {
  let data: any
  try {
    data = JSON.parse(content)
  } catch {
    return {}
  }
  if (!data || typeof data !== 'object') return {}

  const createdAt = parseTimestampMs(data.created)
  const lastActivityAt = maxDefined(
    parseTimestampMs(data.description_updated_at),
    parseTimestampMs(data.name_generated_at),
    createdAt,
  )

  // Amplifier's `name` is an AI-generated session title. Mark it
  // `provider-generated` so freshell's own auto-generated title overrides
  // (dir/first-message/ai) yield to it; explicit user renames still win.
  const name = typeof data.name === 'string' && data.name.trim() ? data.name.trim() : undefined

  return {
    sessionId: typeof data.session_id === 'string' ? data.session_id : undefined,
    cwd: typeof data.working_dir === 'string' ? data.working_dir : undefined,
    createdAt,
    lastActivityAt,
    title: name,
    titleSource: name ? 'provider-generated' : undefined,
    summary: typeof data.description === 'string' && data.description.trim() ? data.description.trim() : undefined,
    messageCount:
      typeof data.turn_count === 'number' && Number.isFinite(data.turn_count) ? data.turn_count : undefined,
    isSubagent: data.parent_id != null,
  }
}

/**
 * Best-effort, bounded read of the first user message from the sibling transcript.
 * Reads at most AMPLIFIER_FIRST_USER_MESSAGE_MAX_READ_BYTES from the start of the file
 * and never loads the whole transcript. Returns undefined on any error or missing file.
 */
async function readFirstUserMessageFromTranscript(transcriptPath: string): Promise<string | undefined> {
  try {
    const fd = await fsp.open(transcriptPath, 'r')
    try {
      const stat = await fd.stat()
      if (stat.size <= 0) return undefined
      const bytesToRead = Math.min(stat.size, AMPLIFIER_FIRST_USER_MESSAGE_MAX_READ_BYTES)
      const buffer = Buffer.alloc(bytesToRead)
      const { bytesRead } = await fd.read(buffer, 0, bytesToRead, 0)
      const chunk = buffer.subarray(0, bytesRead).toString('utf8')
      const lines = chunk.split(/\r?\n/)
      // If we didn't read the entire file, the final line may be truncated; drop it.
      const completeLines = bytesRead >= stat.size ? lines : lines.slice(0, -1)
      for (const line of completeLines) {
        if (!line.trim()) continue
        let obj: any
        try {
          obj = JSON.parse(line)
        } catch {
          continue
        }
        if (obj?.role === 'user' && typeof obj.content === 'string') {
          const normalized = normalizeFirstUserMessage(obj.content)
          // Keep scanning if this user line normalizes to empty (whitespace-only).
          if (normalized) return normalized
        }
      }
      return undefined
    } finally {
      await fd.close().catch(() => {})
    }
  } catch {
    return undefined
  }
}

async function walkMetadataFiles(dir: string): Promise<string[]> {
  let entries
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }

  const files: string[] = []
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await walkMetadataFiles(full)))
    } else if (entry.isFile() && entry.name === 'metadata.json') {
      // Only canonical metadata.json (never metadata.json.backup).
      files.push(full)
    }
  }
  return files
}

export const amplifierProvider: CodingCliProvider = {
  name: 'amplifier',
  displayName: 'Amplifier',
  homeDir: defaultAmplifierHome(),

  getSessionGlob() {
    return path.join(this.homeDir, 'projects', '**', 'sessions', '**', 'metadata.json')
  },

  getSessionRoots() {
    return [path.join(this.homeDir, 'projects')]
  },

  getSessionWatchBases() {
    // Watch the Amplifier home (not projects/) so the very first session is
    // live-detected even before ~/.amplifier/projects exists on cold start.
    // Mirrors claude/codex, which watch their provider home dir.
    return [this.homeDir]
  },

  async getActivityMtimeMs(filePath: string): Promise<number | undefined> {
    // Amplifier writes session activity to sibling sidecars next to metadata.json.
    // metadata.json's own mtime lags real activity (it only changes on name/description
    // updates), so recency and the re-parse gate must also consider these files.
    // We only stat (never read) so the cost stays a couple of syscalls per session.
    const dir = path.dirname(filePath)
    const sidecars = ['transcript.jsonl', 'events.jsonl']
    const mtimes = await Promise.all(
      sidecars.map(async (name) => {
        try {
          const stat = await fsp.stat(path.join(dir, name))
          return statMtimeMs(stat)
        } catch {
          return undefined
        }
      }),
    )
    return maxDefined(...mtimes)
  },

  getLiveEventsPath(filePath: string): string | undefined {
    // Same sidecar-layout knowledge as getActivityMtimeMs: a session dir holds
    // metadata.json + transcript.jsonl + events.jsonl side by side.
    return path.join(path.dirname(filePath), 'events.jsonl')
  },

  // INDEXER POLICY for metadata-less dirs (plan §7, Phase 0 finding E6): a session
  // dir containing only events.jsonl (process killed before its first
  // prompt:complete) never gains metadata.json and is NOT resumable. Discovery
  // deliberately keys on metadata.json, so such dirs are skipped — this is
  // explicit, intentional behavior, not an accident. Live visibility while such a
  // session is running comes from the activity pipeline (events.jsonl tailer),
  // never from the index; the sidebar entry appears naturally when metadata.json
  // lands at the first prompt:complete.
  async listSessionFiles() {
    const projectsDir = path.join(this.homeDir, 'projects')
    const files = await walkMetadataFiles(projectsDir)
    // Restrict to files under a `sessions` directory (projects/<slug>/sessions/<id>/metadata.json).
    return files.filter((file) =>
      path.relative(projectsDir, file).split(path.sep).includes('sessions'),
    )
  },

  async parseSessionFile(content: string, filePath: string): Promise<ParsedSessionMeta> {
    const meta = parseAmplifierMetadata(content)
    const firstUserMessage = await readFirstUserMessageFromTranscript(
      path.join(path.dirname(filePath), 'transcript.jsonl'),
    )
    if (firstUserMessage) meta.firstUserMessage = firstUserMessage
    return meta
  },

  async resolveProjectPath(_filePath: string, meta: ParsedSessionMeta): Promise<string> {
    if (!meta.cwd) return 'unknown'
    return resolveGitRepoRoot(meta.cwd)
  },

  extractSessionId(filePath: string, meta?: ParsedSessionMeta): string {
    // The session id is the name of the directory that holds metadata.json.
    return meta?.sessionId || path.basename(path.dirname(filePath))
  },

  getCommand() {
    return process.env.AMPLIFIER_CMD || 'amplifier'
  },

  getStreamArgs(options) {
    // Unused: Amplifier's REPL has no JSON streaming path, so streaming is disabled
    // (supportsLiveStreaming === false). Provide a sensible default regardless.
    return ['run', '--output-format', 'json', options.prompt]
  },

  getResumeArgs(sessionId: string) {
    return ['resume', sessionId]
  },

  parseEvent(line: string): NormalizedEvent[] {
    let obj: any
    try {
      obj = JSON.parse(line)
    } catch {
      return []
    }
    if (!obj || typeof obj !== 'object') return []

    const base = {
      timestamp: new Date().toISOString(),
      sessionId: 'unknown',
      provider: 'amplifier' as const,
    }

    if (obj.role === 'user') {
      const content =
        typeof obj.content === 'string' ? obj.content : extractAssistantParts(obj.content).text.join('\n')
      return [{ ...base, type: 'message.user', message: { role: 'user', content: content.trim() } }]
    }

    if (obj.role === 'assistant') {
      const events: NormalizedEvent[] = []
      const { reasoning, text } = extractAssistantParts(obj.content)
      for (const thought of reasoning) {
        events.push({ ...base, type: 'reasoning', reasoning: thought, thinking: thought })
      }
      const joined = text.join('\n').trim()
      if (joined) {
        events.push({ ...base, type: 'message.assistant', message: { role: 'assistant', content: joined } })
      }
      return events
    }

    if (obj.role === 'tool') {
      const output = typeof obj.content === 'string' ? obj.content : ''
      const callId = typeof obj.tool_call_id === 'string' ? obj.tool_call_id : 'unknown'
      const name = typeof obj.name === 'string' ? obj.name : ''
      return [
        {
          ...base,
          type: 'tool.result',
          tool: { callId, name, output, isError: false },
          // Legacy alias
          toolResult: { id: callId, output, isError: false },
        },
      ]
    }

    return []
  },

  supportsLiveStreaming() {
    return false
  },

  supportsSessionResume() {
    return true
  },

  providesAuthoritativeTitle() {
    // Amplifier AI-names every session (metadata `name`), so its title is the
    // authoritative one; freshell's own auto-title overrides must yield to it.
    return true
  },
}
