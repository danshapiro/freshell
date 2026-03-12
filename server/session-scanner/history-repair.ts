import { promises as fs } from 'fs'
import path from 'path'
import { getClaudeHome } from '../claude-home.js'

export interface ClaudeHistoryEntry {
  display: string
  pastedContents: Record<string, never>
  timestamp: number
  project: string
  sessionId: string
}

export interface ClaudeHistoryRepairResult {
  status: 'created' | 'already_present' | 'skipped'
}

class Mutex {
  private queue: Promise<void> = Promise.resolve()

  async acquire<T>(fn: () => Promise<T>): Promise<T> {
    const release = this.queue
    let resolve!: () => void
    this.queue = new Promise((r) => {
      resolve = r
    })
    await release
    try {
      return await fn()
    } finally {
      resolve()
    }
  }
}

function normalizeDisplay(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function normalizeDisplayOrNull(text: string | undefined): string | null {
  if (typeof text !== 'string') return null
  const normalized = normalizeDisplay(text)
  return normalized ? normalized : null
}

function extractMessageContentText(content: unknown): string | undefined {
  if (typeof content === 'string') return content

  if (content && typeof content === 'object' && !Array.isArray(content)) {
    const text = (content as { text?: unknown }).text
    return typeof text === 'string' ? text : undefined
  }

  if (!Array.isArray(content)) return undefined

  const text = content
    .filter((block): block is { type?: unknown; text?: unknown } => Boolean(block) && typeof block === 'object')
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join(' ')
  return text || undefined
}

function extractUserDisplay(message: unknown): string | null {
  if (typeof message === 'string') {
    return normalizeDisplayOrNull(message)
  }

  if (!message || typeof message !== 'object') return null
  const content = extractMessageContentText((message as { content?: unknown }).content)
  if (typeof content !== 'string') return null

  return normalizeDisplayOrNull(content)
}

export function deriveClaudeHistoryEntryFromTranscript(
  sessionId: string,
  content: string,
): ClaudeHistoryEntry | null {
  const lines = content.split(/\r?\n/).filter(Boolean)

  for (const line of lines) {
    let obj: any
    try {
      obj = JSON.parse(line)
    } catch {
      continue
    }

    if (obj?.type !== 'user') continue

    const display = extractUserDisplay(obj.message)
    const project = typeof obj.cwd === 'string' ? obj.cwd.trim() : ''
    const timestamp = typeof obj.timestamp === 'string' ? Date.parse(obj.timestamp) : Number.NaN

    if (!display || !project || !Number.isFinite(timestamp)) {
      continue
    }

    return {
      display,
      pastedContents: {},
      timestamp,
      project,
      sessionId,
    }
  }

  return null
}

export class ClaudeHistoryRepairer {
  private readonly historyPath: string
  private readonly mutex = new Mutex()
  private knownSessionIds: Set<string> | null = null
  private historyMtimeMs: number | null = null

  constructor(options?: { claudeHome?: string }) {
    const claudeHome = options?.claudeHome ?? getClaudeHome()
    this.historyPath = path.join(claudeHome, 'history.jsonl')
  }

  async ensureHistoryEntryForFile(filePath: string): Promise<ClaudeHistoryRepairResult> {
    const sessionId = path.basename(filePath, '.jsonl')
    await this.refreshKnownSessionIds()
    if (this.knownSessionIds?.has(sessionId)) {
      return { status: 'already_present' }
    }

    let content: string
    try {
      content = await fs.readFile(filePath, 'utf8')
    } catch {
      return { status: 'skipped' }
    }

    const entry = deriveClaudeHistoryEntryFromTranscript(sessionId, content)
    if (!entry) {
      return { status: 'skipped' }
    }

    return this.ensureHistoryEntry(entry)
  }

  async ensureHistoryEntry(entry: ClaudeHistoryEntry): Promise<ClaudeHistoryRepairResult> {
    return this.mutex.acquire(async () => {
      await this.refreshKnownSessionIds()
      if (this.knownSessionIds?.has(entry.sessionId)) {
        return { status: 'already_present' }
      }

      await fs.mkdir(path.dirname(this.historyPath), { recursive: true })
      await fs.appendFile(this.historyPath, `${JSON.stringify(entry)}\n`, 'utf8')
      this.knownSessionIds ??= new Set()
      this.knownSessionIds.add(entry.sessionId)
      await this.refreshKnownSessionIds({ force: true })
      return { status: 'created' }
    })
  }

  private async refreshKnownSessionIds(options?: { force?: boolean }): Promise<void> {
    let stat: Awaited<ReturnType<typeof fs.stat>> | null = null
    try {
      stat = await fs.stat(this.historyPath)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err
      }
    }

    const nextMtimeMs = stat?.mtimeMs ?? null
    if (!options?.force && this.knownSessionIds && this.historyMtimeMs === nextMtimeMs) {
      return
    }

    if (!stat) {
      this.knownSessionIds = new Set()
      this.historyMtimeMs = null
      return
    }

    const known = new Set<string>()
    const lines = (await fs.readFile(this.historyPath, 'utf8')).split(/\r?\n/)
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const obj = JSON.parse(line)
        if (typeof obj?.sessionId === 'string' && obj.sessionId) {
          known.add(obj.sessionId)
        }
      } catch {
        // Ignore malformed history lines; Claude itself tolerates JSONL append history.
      }
    }

    this.knownSessionIds = known
    this.historyMtimeMs = nextMtimeMs
  }
}
