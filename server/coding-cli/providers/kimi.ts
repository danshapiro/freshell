import { createHash } from 'crypto'
import os from 'os'
import path from 'path'
import fsp from 'fs/promises'
import { extractTitleFromMessage } from '../../title-utils.js'
import type { CodingCliProvider } from '../provider.js'
import {
  normalizeFirstUserMessage,
  type CodingCliSession,
  type NormalizedEvent,
  type ParsedSessionMeta,
} from '../types.js'
import { resolveGitBranchAndDirty, resolveGitRepoRoot } from '../utils.js'

const LOCAL_KAOS_NAME = 'local'
const KIMI_TITLE_MAX_CHARS = 200

type KimiWorkDirMeta = {
  path?: string
  kaos?: string
  last_session_id?: string | null
}

type KimiMetadata = {
  work_dirs?: KimiWorkDirMeta[]
}

type KimiSessionCandidate = {
  sessionId: string
  contextPath: string
  sessionDir: string
}

type KimiContextSummary = {
  firstUserMessage?: string
  messageCount?: number
}

type KimiWireSummary = {
  createdAt?: number
  title?: string
}

type KimiStoredMetadata = {
  archived?: boolean
  title?: string
}

function md5Hex(value: string): string {
  return createHash('md5').update(value).digest('hex')
}

function isIgnoredLegacyTranscript(fileName: string): boolean {
  return /^context_\d+\.jsonl$/.test(fileName) || /^context_sub_\d+\.jsonl$/.test(fileName)
}

function normalizeTimestampMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1_000_000_000_000 ? Math.round(value) : Math.round(value * 1000)
  }
  if (typeof value === 'string' && value.trim()) {
    const asNumber = Number(value)
    if (Number.isFinite(asNumber)) {
      return normalizeTimestampMs(asNumber)
    }
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) {
      return parsed
    }
  }
  return undefined
}

function flattenVisibleText(content: unknown, role: 'user' | 'assistant'): string {
  if (typeof content === 'string') {
    return content.trim()
  }

  if (!Array.isArray(content)) {
    return ''
  }

  const parts = content.flatMap((block) => {
    if (typeof block === 'string') {
      return block.trim() ? [block.trim()] : []
    }
    if (!block || typeof block !== 'object') {
      return []
    }

    const typedBlock = block as {
      type?: unknown
      text?: unknown
      think?: unknown
      content?: unknown
    }
    const type = typeof typedBlock.type === 'string' ? typedBlock.type : undefined

    if (role === 'assistant' && type === 'think') {
      return []
    }
    if (typeof typedBlock.text === 'string' && typedBlock.text.trim()) {
      return [typedBlock.text.trim()]
    }
    if (typeof typedBlock.content === 'string' && typedBlock.content.trim()) {
      return [typedBlock.content.trim()]
    }
    return []
  })

  return parts.join('\n').trim()
}

function parseKimiContextRecord(record: unknown): NormalizedEvent[] {
  if (!record || typeof record !== 'object') {
    return []
  }

  const line = record as {
    role?: unknown
    content?: unknown
  }
  const role = line.role === 'user' || line.role === 'assistant'
    ? line.role
    : undefined
  if (!role) {
    return []
  }

  const content = flattenVisibleText(line.content, role)
  if (!content) {
    return []
  }

  return [{
    timestamp: new Date().toISOString(),
    sessionId: 'unknown',
    provider: 'kimi',
    type: role === 'user' ? 'message.user' : 'message.assistant',
    message: {
      role,
      content,
    },
  }]
}

async function readJsonFile<T>(filePath: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fsp.readFile(filePath, 'utf8')) as T
  } catch {
    return undefined
  }
}

async function loadKimiMetadata(homeDir: string): Promise<KimiMetadata> {
  return (await readJsonFile<KimiMetadata>(path.join(homeDir, 'kimi.json'))) ?? {}
}

async function listKimiSessionFiles(sessionsDir: string): Promise<KimiSessionCandidate[]> {
  let entries: Array<import('fs').Dirent>
  try {
    entries = await fsp.readdir(sessionsDir, { withFileTypes: true })
  } catch {
    return []
  }

  const candidates: KimiSessionCandidate[] = []
  const sortedEntries = [...entries].sort((a, b) => a.name.localeCompare(b.name))

  for (const entry of sortedEntries) {
    if (entry.isDirectory()) {
      const sessionDir = path.join(sessionsDir, entry.name)
      const contextPath = path.join(sessionDir, 'context.jsonl')
      try {
        const stat = await fsp.stat(contextPath)
        if (!stat.isFile()) continue
      } catch {
        continue
      }
      candidates.push({
        sessionId: entry.name,
        contextPath,
        sessionDir,
      })
      continue
    }

    if (!entry.isFile() || path.extname(entry.name) !== '.jsonl' || isIgnoredLegacyTranscript(entry.name)) {
      continue
    }

    const sessionId = path.basename(entry.name, '.jsonl')
    candidates.push({
      sessionId,
      contextPath: path.join(sessionsDir, entry.name),
      sessionDir: path.join(sessionsDir, sessionId),
    })
  }

  return candidates
}

async function loadKimiStoredMetadata(sessionDir: string): Promise<KimiStoredMetadata> {
  const metadata = await readJsonFile<Record<string, unknown>>(path.join(sessionDir, 'metadata.json'))
  if (!metadata) {
    return {}
  }

  const rawTitle = typeof metadata.title === 'string' ? metadata.title.trim() : undefined
  return {
    title: rawTitle && rawTitle !== 'Untitled'
      ? extractTitleFromMessage(rawTitle, KIMI_TITLE_MAX_CHARS)
      : undefined,
    archived: typeof metadata.archived === 'boolean' ? metadata.archived : undefined,
  }
}

async function loadKimiWireSummary(sessionDir: string): Promise<KimiWireSummary> {
  const wirePath = path.join(sessionDir, 'wire.jsonl')
  let raw: string
  try {
    raw = await fsp.readFile(wirePath, 'utf8')
  } catch {
    return {}
  }

  let createdAt: number | undefined
  let title: string | undefined

  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line) as {
        timestamp?: unknown
        message?: {
          type?: unknown
          payload?: {
            user_input?: unknown
          }
        }
      }
      const timestamp = normalizeTimestampMs(parsed.timestamp)
      if (timestamp !== undefined) {
        createdAt = createdAt === undefined ? timestamp : Math.min(createdAt, timestamp)
      }

      if (!title && parsed.message?.type === 'TurnBegin') {
        const userInput = flattenVisibleText(parsed.message.payload?.user_input, 'user')
        if (userInput) {
          title = extractTitleFromMessage(userInput, KIMI_TITLE_MAX_CHARS)
        }
      }
    } catch {
      continue
    }
  }

  return { createdAt, title }
}

async function loadKimiContextSummary(contextPath: string): Promise<KimiContextSummary> {
  let raw: string
  try {
    raw = await fsp.readFile(contextPath, 'utf8')
  } catch {
    return {}
  }

  let firstUserMessage: string | undefined
  let messageCount = 0

  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }

    const events = parseKimiContextRecord(parsed)
    for (const event of events) {
      if (event.type !== 'message.user' && event.type !== 'message.assistant') continue
      messageCount += 1
      if (!firstUserMessage && event.type === 'message.user') {
        firstUserMessage = normalizeFirstUserMessage(event.message?.content ?? '')
      }
    }
  }

  return {
    firstUserMessage,
    ...(messageCount > 0 ? { messageCount } : {}),
  }
}

function deriveKimiTitle(
  storedMetadata: KimiStoredMetadata,
  wireSummary: KimiWireSummary,
  contextSummary: KimiContextSummary,
): string | undefined {
  if (storedMetadata.title) {
    return storedMetadata.title
  }
  if (wireSummary.title) {
    return wireSummary.title
  }
  if (contextSummary.firstUserMessage) {
    return extractTitleFromMessage(contextSummary.firstUserMessage, KIMI_TITLE_MAX_CHARS)
  }
  return undefined
}

function resolveSessionDirName(homeDir: string, workDir: KimiWorkDirMeta): string | undefined {
  const cwd = typeof workDir.path === 'string' ? workDir.path : undefined
  if (!cwd) return undefined
  const hash = md5Hex(cwd)
  const kaos = workDir.kaos || LOCAL_KAOS_NAME
  const dirName = kaos === LOCAL_KAOS_NAME ? hash : `${kaos}_${hash}`
  return path.join(homeDir, 'sessions', dirName)
}

export function defaultKimiShareDir(): string {
  return process.env.KIMI_SHARE_DIR || path.join(os.homedir(), '.kimi')
}

export class KimiProvider implements CodingCliProvider {
  readonly name = 'kimi' as const
  readonly displayName = 'Kimi'

  constructor(readonly homeDir: string = defaultKimiShareDir()) {}

  async listSessionsDirect(): Promise<CodingCliSession[]> {
    const metadata = await loadKimiMetadata(this.homeDir)
    const sessions: CodingCliSession[] = []

    for (const workDir of metadata.work_dirs ?? []) {
      const cwd = typeof workDir.path === 'string' ? workDir.path : undefined
      const sessionsDir = resolveSessionDirName(this.homeDir, workDir)
      if (!cwd || !sessionsDir) continue

      const sessionCandidates = await listKimiSessionFiles(sessionsDir)
      const [projectPath, gitMetadata] = await Promise.all([
        resolveGitRepoRoot(cwd),
        resolveGitBranchAndDirty(cwd),
      ])
      if (!projectPath) continue

      for (const sessionCandidate of sessionCandidates) {
        let contextStat: import('fs').Stats
        try {
          contextStat = await fsp.stat(sessionCandidate.contextPath)
        } catch {
          continue
        }

        const [storedMetadata, wireSummary, contextSummary] = await Promise.all([
          loadKimiStoredMetadata(sessionCandidate.sessionDir),
          loadKimiWireSummary(sessionCandidate.sessionDir),
          loadKimiContextSummary(sessionCandidate.contextPath),
        ])

        const title = deriveKimiTitle(storedMetadata, wireSummary, contextSummary)
        sessions.push({
          provider: this.name,
          sessionId: sessionCandidate.sessionId,
          cwd,
          projectPath,
          lastActivityAt: contextStat.mtimeMs || contextStat.mtime.getTime(),
          createdAt: wireSummary.createdAt,
          archived: storedMetadata.archived,
          messageCount: contextSummary.messageCount,
          title,
          firstUserMessage: contextSummary.firstUserMessage,
          gitBranch: gitMetadata.branch,
          isDirty: gitMetadata.isDirty,
          sourceFile: sessionCandidate.contextPath,
        })
      }
    }

    return sessions
  }

  getSessionGlob(): string {
    return path.join(this.homeDir, '{kimi.json,sessions/**/*.{json,jsonl}}')
  }

  getSessionRoots(): string[] {
    return [this.homeDir, path.join(this.homeDir, 'sessions')]
  }

  async listSessionFiles(): Promise<string[]> {
    return []
  }

  async parseSessionFile(): Promise<ParsedSessionMeta> {
    return {}
  }

  async resolveProjectPath(_filePath: string, meta: ParsedSessionMeta): Promise<string> {
    return meta.cwd ? resolveGitRepoRoot(meta.cwd) : 'unknown'
  }

  extractSessionId(filePath: string, meta?: ParsedSessionMeta): string {
    if (meta?.sessionId) return meta.sessionId
    if (path.basename(filePath) === 'context.jsonl') {
      return path.basename(path.dirname(filePath))
    }
    return path.basename(filePath, path.extname(filePath))
  }

  getCommand(): string {
    return process.env.KIMI_CMD || 'kimi'
  }

  getStreamArgs(): string[] {
    return []
  }

  getResumeArgs(sessionId: string): string[] {
    return ['--session', sessionId]
  }

  parseEvent(line: string): NormalizedEvent[] {
    return parseKimiContextRecord(JSON.parse(line))
  }

  supportsLiveStreaming(): boolean {
    return false
  }

  supportsSessionResume(): boolean {
    return true
  }
}

export const kimiProvider = new KimiProvider()
