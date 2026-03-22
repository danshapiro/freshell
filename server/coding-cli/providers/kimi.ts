import fs from 'fs'
import { createHash } from 'crypto'
import os from 'os'
import path from 'path'
import fsp from 'fs/promises'
import { createInterface } from 'node:readline'
import { extractTitleFromMessage } from '../../title-utils.js'
import type { CodingCliProvider, DirectSessionListOptions } from '../provider.js'
import {
  makeSessionKey,
  normalizeFirstUserMessage,
  type CodingCliSession,
  type NormalizedEvent,
  type ParsedSessionMeta,
} from '../types.js'
import { resolveGitBranchAndDirty, resolveGitRepoRoot } from '../utils.js'

const LOCAL_KAOS_NAME = 'local'
const KIMI_TITLE_MAX_CHARS = 200
const IS_WINDOWS = process.platform === 'win32'

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

type KimiCachedWorkDir = {
  cwd: string
  sessionsDir: string
  projectPath: string
  gitBranch?: string
  isDirty?: boolean
}

type KimiTrackedSessionRef = {
  workDir: KimiCachedWorkDir
  sessionId: string
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

function normalizeTrackedPath(filePath: string): string {
  const resolved = path.resolve(filePath)
  return IS_WINDOWS ? resolved.toLowerCase() : resolved
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
  const parts = collectVisibleText(content, role)
  return parts.join('\n').trim()
}

function collectVisibleText(content: unknown, role: 'user' | 'assistant'): string[] {
  if (typeof content === 'string') {
    return content.trim() ? [content.trim()] : []
  }

  if (Array.isArray(content)) {
    return content.flatMap((item) => collectVisibleText(item, role))
  }

  if (!content || typeof content !== 'object') {
    return []
  }

  const typedBlock = content as {
    type?: unknown
    text?: unknown
    content?: unknown
  }
  const type = typeof typedBlock.type === 'string' ? typedBlock.type : undefined

  if (role === 'assistant' && type === 'think') {
    return []
  }

  return [
    ...collectVisibleText(typedBlock.text, role),
    ...collectVisibleText(typedBlock.content, role),
  ]
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

  const candidatesBySessionId = new Map<string, KimiSessionCandidate>()
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
      candidatesBySessionId.set(entry.name, {
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
    if (candidatesBySessionId.has(sessionId)) {
      continue
    }
    candidatesBySessionId.set(sessionId, {
      sessionId,
      contextPath: path.join(sessionsDir, entry.name),
      sessionDir: path.join(sessionsDir, sessionId),
    })
  }

  return [...candidatesBySessionId.values()]
}

async function resolveKimiSessionCandidate(
  sessionsDir: string,
  sessionId: string,
): Promise<KimiSessionCandidate | undefined> {
  const modernSessionDir = path.join(sessionsDir, sessionId)
  const modernContextPath = path.join(modernSessionDir, 'context.jsonl')
  try {
    const stat = await fsp.stat(modernContextPath)
    if (stat.isFile()) {
      return {
        sessionId,
        contextPath: modernContextPath,
        sessionDir: modernSessionDir,
      }
    }
  } catch {
    // Fall back to the legacy flat transcript when the modern layout is absent.
  }

  const legacyContextPath = path.join(sessionsDir, `${sessionId}.jsonl`)
  if (isIgnoredLegacyTranscript(path.basename(legacyContextPath))) {
    return undefined
  }

  try {
    const stat = await fsp.stat(legacyContextPath)
    if (!stat.isFile()) {
      return undefined
    }
  } catch {
    return undefined
  }

  return {
    sessionId,
    contextPath: legacyContextPath,
    sessionDir: modernSessionDir,
  }
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
  let firstUserMessage: string | undefined
  let messageCount = 0

  try {
    const lines = createInterface({
      input: fs.createReadStream(contextPath, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    })
    try {
      for await (const line of lines) {
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
    } finally {
      lines.close()
    }
  } catch {
    return {}
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
  private readonly metadataPath: string
  private readonly sessionsRoot: string
  private cacheInitialized = false
  private workDirsBySessionsDir = new Map<string, KimiCachedWorkDir>()
  private sessionsByKey = new Map<string, CodingCliSession>()

  constructor(readonly homeDir: string = defaultKimiShareDir()) {
    this.metadataPath = path.resolve(homeDir, 'kimi.json')
    this.sessionsRoot = path.resolve(homeDir, 'sessions')
  }

  async listSessionsDirect(options?: DirectSessionListOptions): Promise<CodingCliSession[]> {
    if (!options || !this.cacheInitialized) {
      return this.refreshAllSessions()
    }

    const changedFiles = options.changedFiles ?? []
    const deletedFiles = options.deletedFiles ?? []
    if (changedFiles.length === 0 && deletedFiles.length === 0) {
      return this.snapshotSessions()
    }

    const trackedSessions = this.collectTrackedSessions(changedFiles, deletedFiles)
    if (trackedSessions === null) {
      return this.refreshAllSessions()
    }

    for (const trackedSession of trackedSessions.values()) {
      await this.refreshTrackedSession(trackedSession.workDir, trackedSession.sessionId)
    }

    return this.snapshotSessions()
  }

  private snapshotSessions(): CodingCliSession[] {
    return Array.from(this.sessionsByKey.values())
  }

  private collectTrackedSessions(
    changedFiles: string[],
    deletedFiles: string[],
  ): Map<string, KimiTrackedSessionRef> | null {
    const trackedSessions = new Map<string, KimiTrackedSessionRef>()

    for (const filePath of [...changedFiles, ...deletedFiles]) {
      const trackedSession = this.resolveTrackedSession(filePath)
      if (trackedSession === 'full') {
        return null
      }
      if (!trackedSession) {
        continue
      }
      trackedSessions.set(makeSessionKey(this.name, trackedSession.sessionId, trackedSession.workDir.cwd), trackedSession)
    }

    return trackedSessions
  }

  private resolveTrackedSession(filePath: string): KimiTrackedSessionRef | 'full' | undefined {
    const resolved = path.resolve(filePath)
    const normalized = normalizeTrackedPath(resolved)
    if (normalized === normalizeTrackedPath(this.metadataPath)) {
      return 'full'
    }

    const relative = path.relative(this.sessionsRoot, resolved)
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      return 'full'
    }

    const relativeParts = relative.split(path.sep).filter(Boolean)
    if (relativeParts.length < 2) {
      return undefined
    }

    const sessionsDir = path.join(this.sessionsRoot, relativeParts[0])
    const workDir = this.workDirsBySessionsDir.get(normalizeTrackedPath(sessionsDir))
    if (!workDir) {
      return 'full'
    }

    if (relativeParts.length === 2) {
      const fileName = relativeParts[1]
      if (path.extname(fileName) !== '.jsonl' || isIgnoredLegacyTranscript(fileName)) {
        return undefined
      }
      return {
        workDir,
        sessionId: path.basename(fileName, '.jsonl'),
      }
    }

    if (relativeParts.length === 3) {
      const leaf = relativeParts[2]
      if (leaf === 'context.jsonl' || leaf === 'wire.jsonl' || leaf === 'metadata.json') {
        return {
          workDir,
          sessionId: relativeParts[1],
        }
      }
      return undefined
    }

    return undefined
  }

  private async refreshAllSessions(): Promise<CodingCliSession[]> {
    const metadata = await loadKimiMetadata(this.homeDir)
    const sessionsByKey = new Map<string, CodingCliSession>()
    const workDirsBySessionsDir = new Map<string, KimiCachedWorkDir>()

    for (const workDir of metadata.work_dirs ?? []) {
      const cwd = typeof workDir.path === 'string' ? workDir.path : undefined
      const sessionsDir = resolveSessionDirName(this.homeDir, workDir)
      if (!cwd || !sessionsDir) continue

      const [projectPath, gitMetadata] = await Promise.all([
        resolveGitRepoRoot(cwd),
        resolveGitBranchAndDirty(cwd),
      ])

      const cachedWorkDir: KimiCachedWorkDir = {
        cwd,
        sessionsDir: path.resolve(sessionsDir),
        projectPath,
        gitBranch: gitMetadata.branch,
        isDirty: gitMetadata.isDirty,
      }
      workDirsBySessionsDir.set(normalizeTrackedPath(cachedWorkDir.sessionsDir), cachedWorkDir)

      const sessionCandidates = await listKimiSessionFiles(cachedWorkDir.sessionsDir)

      for (const sessionCandidate of sessionCandidates) {
        const session = await this.loadSessionCandidate(cachedWorkDir, sessionCandidate)
        if (!session) continue
        sessionsByKey.set(makeSessionKey(this.name, session.sessionId, session.cwd), session)
      }
    }

    this.workDirsBySessionsDir = workDirsBySessionsDir
    this.sessionsByKey = sessionsByKey
    this.cacheInitialized = true
    return this.snapshotSessions()
  }

  private async refreshTrackedSession(workDir: KimiCachedWorkDir, sessionId: string): Promise<void> {
    const sessionKey = makeSessionKey(this.name, sessionId, workDir.cwd)
    const session = await this.loadSessionById(workDir, sessionId)
    if (session) {
      this.sessionsByKey.set(sessionKey, session)
    } else {
      this.sessionsByKey.delete(sessionKey)
    }
  }

  private async loadSessionById(workDir: KimiCachedWorkDir, sessionId: string): Promise<CodingCliSession | undefined> {
    const sessionCandidate = await resolveKimiSessionCandidate(workDir.sessionsDir, sessionId)
    if (!sessionCandidate) {
      return undefined
    }
    return this.loadSessionCandidate(workDir, sessionCandidate)
  }

  private async loadSessionCandidate(
    workDir: KimiCachedWorkDir,
    sessionCandidate: KimiSessionCandidate,
  ): Promise<CodingCliSession | undefined> {
    let contextStat: import('fs').Stats
    try {
      contextStat = await fsp.stat(sessionCandidate.contextPath)
    } catch {
      return undefined
    }

    const [storedMetadata, wireSummary, contextSummary] = await Promise.all([
      loadKimiStoredMetadata(sessionCandidate.sessionDir),
      loadKimiWireSummary(sessionCandidate.sessionDir),
      loadKimiContextSummary(sessionCandidate.contextPath),
    ])

    const title = deriveKimiTitle(storedMetadata, wireSummary, contextSummary)
    return {
      provider: this.name,
      sessionId: sessionCandidate.sessionId,
      cwd: workDir.cwd,
      projectPath: workDir.projectPath,
      lastActivityAt: contextStat.mtimeMs || contextStat.mtime.getTime(),
      createdAt: wireSummary.createdAt,
      archived: storedMetadata.archived,
      messageCount: contextSummary.messageCount,
      title,
      firstUserMessage: contextSummary.firstUserMessage,
      gitBranch: workDir.gitBranch,
      isDirty: workDir.isDirty,
      sourceFile: sessionCandidate.contextPath,
    }
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
