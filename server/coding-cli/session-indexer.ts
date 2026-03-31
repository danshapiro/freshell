import fs from 'fs'
import path from 'path'
import fsp from 'fs/promises'
import type { Stats } from 'fs'
import chokidar from 'chokidar'
import { logger } from '../logger.js'
import { getPerfConfig, startPerfTimer } from '../perf-logger.js'
import { configStore, SessionOverride } from '../config-store.js'
import type { CodingCliProvider } from './provider.js'
import { makeSessionKey, type CodingCliSession, type CodingCliProviderName, type ProjectGroup } from './types.js'
import { sanitizeCodexTaskEventsForTruncatedSnippet } from './providers/codex.js'
import { resolveGitCheckoutRoot, resolveGitRepoRoot } from './utils.js'
import { diffProjects } from '../sessions-sync/diff.js'
import type { SessionMetadataStore, SessionMetadataEntry } from '../session-metadata-store.js'

const perfConfig = getPerfConfig()
const REFRESH_YIELD_EVERY = 200
const SESSION_SNIPPET_BYTES = 256 * 1024
const LIGHTWEIGHT_HEAD_BYTES = 4096
const LIGHTWEIGHT_TAIL_BYTES = 16384
// How many recent sessions to fully enrich on startup for accurate isNonInteractive filtering.
const ENRICHMENT_BATCH_SIZE = 150
// Artificial per-file delay (ms) for testing event-loop behavior at scale.
const INDEXER_DELAY_MS = Number(process.env.FRESHELL_INDEXER_DELAY_MS || 0)
const SEEN_SESSION_RETENTION_MS = Number(process.env.CODING_CLI_SEEN_SESSION_RETENTION_MS || 7 * 24 * 60 * 60 * 1000)
const MAX_SEEN_SESSION_IDS = Number(process.env.CODING_CLI_SEEN_SESSION_MAX || 10_000)

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve))
const IS_WINDOWS = process.platform === 'win32'

const normalizeFilePath = (filePath: string) => {
  const resolved = path.resolve(filePath)
  return IS_WINDOWS ? resolved.toLowerCase() : resolved
}

function minDefined(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b
  if (b === undefined) return a
  return Math.min(a, b)
}

function maxDefined(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b
  if (b === undefined) return a
  return Math.max(a, b)
}

function findNearestExistingAncestor(targetPath: string): string {
  let current = normalizeFilePath(targetPath)
  let parent = path.dirname(current)
  while (current !== parent) {
    try {
      if (fs.existsSync(current)) return current
    } catch {
      // Ignore filesystem errors while walking upward.
    }
    current = parent
    parent = path.dirname(current)
  }
  return current
}

/**
 * Check if a file path is a Claude subagent session.
 * Only applies to Claude paths (containing /.claude/ or \.claude\) to avoid
 * flagging non-Claude sessions that happen to be in a directory named "subagents".
 */
export function isSubagentSession(filePath: string): boolean {
  const normalized = filePath.toLowerCase()
  const hasSubagents = normalized.includes('/subagents/') || normalized.includes('\\subagents\\')
  if (!hasSubagents) return false
  // Only flag if this is a Claude path
  return normalized.includes('/.claude/') || normalized.includes('\\.claude\\')
}

function applyOverride(session: CodingCliSession, ov: SessionOverride | undefined): CodingCliSession | null {
  if (ov?.deleted) return null
  return {
    ...session,
    title: ov?.titleOverride || session.title,
    summary: ov?.summaryOverride || session.summary,
    createdAt: ov?.createdAtOverride ?? session.createdAt,
    archived: ov?.archived ?? session.archived ?? false,
  }
}

type SessionSnippet = {
  content: string
  truncated: boolean
  tailContent?: string
}

async function readSessionSnippet(filePath: string): Promise<SessionSnippet> {
  try {
    const stat = await fsp.stat(filePath)
    if (stat.size <= SESSION_SNIPPET_BYTES) {
      return {
        content: await fsp.readFile(filePath, 'utf-8'),
        truncated: false,
        tailContent: undefined,
      }
    }

    const headBytes = Math.floor(SESSION_SNIPPET_BYTES / 2)
    const tailBytes = SESSION_SNIPPET_BYTES - headBytes
    const fd = await fsp.open(filePath, 'r')

    try {
      const headBuffer = Buffer.alloc(headBytes)
      const tailBuffer = Buffer.alloc(tailBytes)
      const [headRead, tailRead] = await Promise.all([
        fd.read(headBuffer, 0, headBytes, 0),
        fd.read(tailBuffer, 0, tailBytes, Math.max(0, stat.size - tailBytes)),
      ])

      const headRaw = headBuffer.subarray(0, headRead.bytesRead).toString('utf8')
      const tailRaw = tailBuffer.subarray(0, tailRead.bytesRead).toString('utf8')

      // Keep complete JSONL lines only: head drops trailing partial line,
      // tail drops leading partial line.
      const headNewline = headRaw.lastIndexOf('\n')
      const tailNewline = tailRaw.indexOf('\n')
      const head = headNewline >= 0 ? headRaw.slice(0, headNewline) : headRaw
      const tail = tailNewline >= 0 ? tailRaw.slice(tailNewline + 1) : tailRaw

      if (!head) return { content: tail, truncated: true, tailContent: tail }
      if (!tail) return { content: head, truncated: true, tailContent: '' }
      return { content: `${head}\n${tail}`, truncated: true, tailContent: tail }
    } finally {
      await fd.close()
    }
  } catch {
    return { content: '', truncated: false, tailContent: undefined }
  }
}

type LightweightFileMeta = {
  filePath: string
  mtimeMs: number
  size: number
  sessionId?: string
  cwd?: string
  title?: string
  createdAt?: number
  lastActivityAt?: number
}

/**
 * Read just the head and tail of a session file to extract sidebar-ready metadata.
 * Head gives sessionId, cwd, title; tail gives lastActivityAt for correct sort ordering.
 */
async function readLightweightMeta(filePath: string): Promise<LightweightFileMeta> {
  try {
    const stat = await fsp.stat(filePath)
    const mtimeMs = stat.mtimeMs || stat.mtime.getTime()
    const size = stat.size
    if (size === 0) return { filePath, mtimeMs, size }

    const headSize = Math.min(LIGHTWEIGHT_HEAD_BYTES, size)
    const fd = await fsp.open(filePath, 'r')
    try {
      const headBuf = Buffer.alloc(headSize)
      const reads: Promise<any>[] = [fd.read(headBuf, 0, headSize, 0)]
      let tailBuf: Buffer | undefined
      if (size > headSize) {
        const tailSize = Math.min(LIGHTWEIGHT_TAIL_BYTES, size)
        tailBuf = Buffer.alloc(tailSize)
        reads.push(fd.read(tailBuf, 0, tailSize, Math.max(0, size - tailSize)))
      }
      await Promise.all(reads)

      // Parse head for sessionId, cwd, title, createdAt
      const headLines = headBuf.toString('utf8').split('\n').filter(Boolean)
      let sessionId: string | undefined
      let cwd: string | undefined
      let title: string | undefined
      let createdAt: number | undefined

      for (const line of headLines) {
        let obj: any
        try { obj = JSON.parse(line) } catch { continue }

        if (!sessionId) {
          sessionId = obj?.sessionId || obj?.session_id
            || obj?.payload?.id || obj?.message?.sessionId
        }
        if (!cwd) {
          const c = obj?.cwd || obj?.context?.cwd || obj?.payload?.cwd
            || obj?.data?.cwd || obj?.message?.cwd
          if (typeof c === 'string' && (c.startsWith('/') || (IS_WINDOWS && /^[a-zA-Z]:/.test(c)))) cwd = c
        }
        if (!createdAt && obj?.timestamp) {
          const parsed = typeof obj.timestamp === 'number' ? obj.timestamp : Date.parse(obj.timestamp)
          if (Number.isFinite(parsed)) createdAt = parsed
        }
        if (!title) {
          const isUser = obj?.role === 'user' || obj?.type === 'user' || obj?.message?.role === 'user'
          if (isUser) {
            const content = obj?.message?.content || obj?.content
            const text = typeof content === 'string'
              ? content
              : Array.isArray(content)
                ? content.filter((b: any) => typeof b?.text === 'string').map((b: any) => b.text).join(' ')
                : undefined
            if (typeof text === 'string' && text.trim()) title = text.trim().slice(0, 200)
          }
        }
        if (sessionId && cwd && title && createdAt) break
      }

      // Parse tail backwards for lastActivityAt (skip timestampless records like file-history-snapshot)
      let lastActivityAt: number | undefined
      if (tailBuf) {
        const tailLines = tailBuf.toString('utf8').split('\n').filter(Boolean)
        for (let i = tailLines.length - 1; i >= 0; i--) {
          try {
            const obj = JSON.parse(tailLines[i])
            if (obj?.timestamp) {
              const parsed = typeof obj.timestamp === 'number' ? obj.timestamp : Date.parse(obj.timestamp)
              if (Number.isFinite(parsed)) { lastActivityAt = parsed; break }
            }
          } catch { /* skip malformed lines */ }
        }
      }
      if (!lastActivityAt) lastActivityAt = createdAt

      return { filePath, mtimeMs, size, sessionId, cwd, title, createdAt, lastActivityAt }
    } finally {
      await fd.close()
    }
  } catch {
    return { filePath, mtimeMs: 0, size: 0 }
  }
}

type CachedSessionEntry = {
  provider: CodingCliProviderName
  mtimeMs: number
  size: number
  baseSession: CodingCliSession | null
  /** True when populated by a lightweight scan and not yet fully enriched. */
  lightweight?: boolean
}

export type SessionIndexerOptions = {
  debounceMs?: number
  throttleMs?: number
  fullScanIntervalMs?: number
}

const DEFAULT_DEBOUNCE_MS = 2_000
const DEFAULT_THROTTLE_MS = 5_000
const DEFAULT_FULL_SCAN_INTERVAL_MS = 10 * 60 * 1000 // 10 minutes
const URGENT_REFRESH_MS = 300 // Fast refresh when a titleless session might have just gained content
const URGENT_THROTTLE_MS = 1000 // Minimum spacing between urgent refreshes to cap worst-case frequency

export class CodingCliSessionIndexer {
  private watcher: chokidar.FSWatcher | null = null
  private rootWatcher: chokidar.FSWatcher | null = null
  private fullScanTimer: NodeJS.Timeout | null = null
  private projects: ProjectGroup[] = []
  private onUpdateHandlers = new Set<(projects: ProjectGroup[]) => void>()
  private refreshTimer: NodeJS.Timeout | null = null
  private refreshInFlight = false
  private refreshQueued = false
  private fileCache = new Map<string, CachedSessionEntry>()
  private dirtyFiles = new Set<string>()
  private deletedFiles = new Set<string>()
  private needsFullScan = true
  private lastEnabledKey = ''
  private lastRefreshAt = 0
  private readonly debounceMs: number
  private readonly throttleMs: number
  private readonly fullScanIntervalMs: number
  private knownSessionIds = new Set<string>()
  private seenSessionIds = new Map<string, number>()
  private onNewSessionHandlers = new Set<(session: CodingCliSession) => void>()
  private initialized = false
  private sessionKeyToFilePath = new Map<string, string>()
  private urgentRefreshNeeded = false
  private dirtyProviders = new Set<CodingCliProviderName>()

  constructor(
    private providers: CodingCliProvider[],
    options: SessionIndexerOptions = {},
    private sessionMetadataStore?: SessionMetadataStore,
  ) {
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS
    this.throttleMs = options.throttleMs ?? DEFAULT_THROTTLE_MS
    this.fullScanIntervalMs = options.fullScanIntervalMs ??
      Number(process.env.CODING_CLI_FULL_SCAN_INTERVAL_MS || DEFAULT_FULL_SCAN_INTERVAL_MS)
  }

  async start() {
    this.needsFullScan = true
    await this.refresh()
    this.initialized = true
    const globs = this.providers.map((p) => p.getSessionGlob())
    logger.info({ globs, debounceMs: this.debounceMs, throttleMs: this.throttleMs }, 'Starting coding CLI sessions watcher')

    this.watcher = chokidar.watch(globs, {
      ignoreInitial: true,
    })

    const schedule = () => this.scheduleRefresh()
    this.watcher.on('add', (filePath) => {
      this.markDirty(filePath)
      schedule()
    })
    this.watcher.on('change', (filePath) => {
      this.markDirty(filePath)
      schedule()
    })
    this.watcher.on('unlink', (filePath) => {
      this.markDeleted(filePath)
      schedule()
    })
    this.watcher.on('error', (err) => logger.warn({ err }, 'Coding CLI watcher error'))

    // Watch parent directories of provider roots for late directory creation/removal.
    // When a provider root (e.g. ~/.codex/sessions) doesn't exist at startup, chokidar's
    // glob watcher silently ignores it. This root watcher detects when the directory
    // appears and triggers a full rescan.
    this.startRootWatcher()

    // Periodic safety full-scan to catch anything the file watchers might miss.
    if (this.fullScanIntervalMs > 0) {
      this.fullScanTimer = setInterval(() => {
        this.needsFullScan = true
        this.scheduleRefresh()
      }, this.fullScanIntervalMs)
    }
  }

  stop() {
    this.watcher?.close().catch(() => {})
    this.watcher = null
    this.rootWatcher?.close().catch(() => {})
    this.rootWatcher = null
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    this.refreshTimer = null
    if (this.fullScanTimer) clearInterval(this.fullScanTimer)
    this.fullScanTimer = null
  }

  private startRootWatcher() {
    const rootSet = new Set<string>()
    for (const provider of this.providers) {
      for (const root of provider.getSessionRoots()) {
        rootSet.add(normalizeFilePath(root))
      }
    }

    if (rootSet.size === 0) return

    // Watch the nearest existing ancestor of each root so we still detect late
    // root creation when one or more intermediate directories do not exist yet.
    const watchRoots = new Set<string>()
    let maxDepth = 0
    for (const root of rootSet) {
      const ancestor = findNearestExistingAncestor(root)
      watchRoots.add(ancestor)
      const relative = path.relative(ancestor, root)
      const depth = relative ? relative.split(path.sep).filter(Boolean).length : 0
      maxDepth = Math.max(maxDepth, depth)
    }

    this.rootWatcher = chokidar.watch(Array.from(watchRoots), {
      ignoreInitial: true,
      depth: Math.max(0, maxDepth),
    })

    const roots = Array.from(rootSet)
    const affectsWatchedRoot = (entryPath: string) => {
      const normalized = normalizeFilePath(entryPath)
      return roots.some((root) => {
        if (root === normalized) return true
        const prefix = normalized.endsWith(path.sep) ? normalized : `${normalized}${path.sep}`
        return root.startsWith(prefix)
      })
    }

    this.rootWatcher.on('addDir', (dirPath) => {
      if (affectsWatchedRoot(dirPath)) {
        logger.info({ dirPath }, 'Provider session root created, scheduling full scan')
        this.needsFullScan = true
        this.scheduleRefresh()
      }
    })

    this.rootWatcher.on('unlinkDir', (dirPath) => {
      if (affectsWatchedRoot(dirPath)) {
        logger.info({ dirPath }, 'Provider session root removed, scheduling full scan')
        this.needsFullScan = true
        this.scheduleRefresh()
      }
    })

    this.rootWatcher.on('add', (filePath) => {
      if (affectsWatchedRoot(filePath)) {
        logger.info({ filePath }, 'Provider session root file created, scheduling full scan')
        this.needsFullScan = true
        this.scheduleRefresh()
      }
    })

    this.rootWatcher.on('unlink', (filePath) => {
      if (affectsWatchedRoot(filePath)) {
        logger.info({ filePath }, 'Provider session root file removed, scheduling full scan')
        this.needsFullScan = true
        this.scheduleRefresh()
      }
    })

    this.rootWatcher.on('error', (err) => logger.warn({ err }, 'Root watcher error'))
  }

  onUpdate(handler: (projects: ProjectGroup[]) => void): () => void {
    this.onUpdateHandlers.add(handler)
    return () => this.onUpdateHandlers.delete(handler)
  }

  onNewSession(handler: (session: CodingCliSession) => void): () => void {
    this.onNewSessionHandlers.add(handler)
    return () => this.onNewSessionHandlers.delete(handler)
  }

  getProjects(): ProjectGroup[] {
    return this.projects
  }

  getFilePathForSession(sessionId: string, provider?: CodingCliProviderName): string | undefined {
    if (provider) {
      return this.sessionKeyToFilePath.get(makeSessionKey(provider, sessionId))
    }

    // Session repair currently resolves Claude sessions by bare session ID.
    // Preserve that behavior for existing call sites.
    const claudePath = this.sessionKeyToFilePath.get(makeSessionKey('claude', sessionId))
    if (claudePath) return claudePath

    let match: string | undefined
    const suffix = `:${sessionId}`
    for (const [key, filePath] of this.sessionKeyToFilePath) {
      if (!key.endsWith(suffix)) continue
      if (match && match !== filePath) {
        return undefined
      }
      match = filePath
    }
    return match
  }

  private markDirty(filePath: string) {
    const normalized = normalizeFilePath(filePath)
    const provider = this.resolveProviderForFile(filePath)
    if (provider?.listSessionsDirect) {
      this.dirtyProviders.add(provider.name)
      this.deletedFiles.delete(normalized)
      this.urgentRefreshNeeded = true
      return
    }
    this.deletedFiles.delete(normalized)
    this.dirtyFiles.add(normalized)

    // If the cached session has no title, this change might be the first user
    // message arriving. Flag for urgent refresh so the session appears in the
    // sidebar without the normal debounce/throttle delay.
    const cached = this.fileCache.get(normalized)
    if (cached?.baseSession && !cached.baseSession.title) {
      this.urgentRefreshNeeded = true
    }
  }

  private markDeleted(filePath: string) {
    const normalized = normalizeFilePath(filePath)
    const provider = this.resolveProviderForFile(filePath)
    if (provider?.listSessionsDirect) {
      this.dirtyProviders.add(provider.name)
      this.dirtyFiles.delete(normalized)
      return
    }
    this.dirtyFiles.delete(normalized)
    this.deletedFiles.add(normalized)
  }

  private resolveProviderForFile(filePath: string): CodingCliProvider | undefined {
    const normalized = normalizeFilePath(filePath)
    let matched: CodingCliProvider | undefined
    let matchedLength = -1

    for (const provider of this.providers) {
      const homeDir = normalizeFilePath(provider.homeDir)
      if (!normalized.startsWith(homeDir)) continue
      if (homeDir.length > matchedLength) {
        matched = provider
        matchedLength = homeDir.length
      }
    }

    return matched
  }

  private deleteCacheEntry(cacheKey: string) {
    const cached = this.fileCache.get(cacheKey)
    if (cached?.baseSession?.sessionId) {
      this.sessionKeyToFilePath.delete(makeSessionKey(cached.baseSession.provider, cached.baseSession.sessionId))
    }
    this.fileCache.delete(cacheKey)
  }

  private makeDirectCacheKey(provider: CodingCliProviderName, sessionId: string): string {
    return `direct:${provider}:${sessionId}`
  }

  private isDirectCacheKey(cacheKey: string): boolean {
    return cacheKey.startsWith('direct:')
  }

  private pruneSeenSessions(now: number) {
    const cutoff = now - SEEN_SESSION_RETENTION_MS
    for (const [id, lastSeen] of this.seenSessionIds) {
      if (lastSeen < cutoff) {
        this.seenSessionIds.delete(id)
      }
    }

    if (this.seenSessionIds.size <= MAX_SEEN_SESSION_IDS) return
    const ordered = Array.from(this.seenSessionIds.entries()).sort((a, b) => a[1] - b[1])
    const overflow = this.seenSessionIds.size - MAX_SEEN_SESSION_IDS
    for (let i = 0; i < overflow; i++) {
      this.seenSessionIds.delete(ordered[i][0])
    }
  }

  private detectNewSessions(sessions: CodingCliSession[]) {
    const currentIds = new Set<string>(sessions.map((s) => makeSessionKey(s.provider, s.sessionId)))

    // Prune knownSessionIds to only contain IDs that still exist
    for (const id of this.knownSessionIds) {
      if (!currentIds.has(id)) {
        this.knownSessionIds.delete(id)
      }
    }

    const now = Date.now()
    this.pruneSeenSessions(now)

    const newSessions: CodingCliSession[] = []
    for (const session of sessions) {
      if (!session.cwd) continue

      const sessionKey = makeSessionKey(session.provider, session.sessionId)
      const wasKnown = this.knownSessionIds.has(sessionKey)
      if (!wasKnown) this.knownSessionIds.add(sessionKey)

      const seenBefore = this.seenSessionIds.has(sessionKey)
      this.seenSessionIds.set(sessionKey, now)

      if (this.initialized && !wasKnown && !seenBefore) {
        newSessions.push(session)
      }
    }

    if (this.initialized && newSessions.length > 0) {
      newSessions.sort((a, b) => {
        const diff = a.lastActivityAt - b.lastActivityAt
        return diff !== 0
          ? diff
          : makeSessionKey(a.provider, a.sessionId).localeCompare(makeSessionKey(b.provider, b.sessionId))
      })
      for (const session of newSessions) {
        for (const h of this.onNewSessionHandlers) {
          try {
            h(session)
          } catch (err) {
            logger.warn({ err }, 'onNewSession handler failed')
          }
        }
      }
    }
  }

  private async updateCacheEntry(provider: CodingCliProvider, filePath: string, cacheKey: string) {
    let stat: Stats
    try {
      stat = await fsp.stat(filePath)
    } catch {
      this.deleteCacheEntry(cacheKey)
      return
    }

    const mtimeMs = stat.mtimeMs || stat.mtime.getTime()
    const size = stat.size

    const cached = this.fileCache.get(cacheKey)
    if (cached && cached.mtimeMs === mtimeMs && cached.size === size && !cached.lightweight) {
      return
    }

    // Clean up previous session mapping before re-parsing
    if (cached?.baseSession?.sessionId) {
      this.sessionKeyToFilePath.delete(makeSessionKey(cached.baseSession.provider, cached.baseSession.sessionId))
    }

    const snippet = await readSessionSnippet(filePath)
    const meta = await provider.parseSessionFile(snippet.content, filePath)
    if (snippet.truncated && provider.name === 'codex') {
      const tailMeta = snippet.tailContent
        ? await provider.parseSessionFile(snippet.tailContent, filePath)
        : undefined
      meta.codexTaskEvents = sanitizeCodexTaskEventsForTruncatedSnippet(
        meta.codexTaskEvents,
        tailMeta?.codexTaskEvents,
      )
    }
    if (!meta.cwd) {
      this.fileCache.set(cacheKey, {
        provider: provider.name,
        mtimeMs,
        size,
        baseSession: null,
      })
      return
    }

    const projectPath = await provider.resolveProjectPath(filePath, meta)
    const sessionId = meta.sessionId || provider.extractSessionId(filePath, meta)
    const previous = cached?.lightweight ? undefined : cached?.baseSession
    const sameSession = previous?.provider === provider.name && previous?.sessionId === sessionId
    const appendOnlyReparse = sameSession && size >= (cached?.size ?? 0)
    const createdAt = appendOnlyReparse
      ? minDefined(previous?.createdAt, meta.createdAt)
      : (sameSession ? (meta.createdAt ?? previous?.createdAt) : meta.createdAt)
    const lastActivityAt = appendOnlyReparse
      ? (maxDefined(previous?.lastActivityAt, meta.lastActivityAt) ?? createdAt ?? 0)
      : (sameSession
          ? (meta.lastActivityAt ?? previous?.lastActivityAt ?? createdAt ?? 0)
          : (meta.lastActivityAt ?? createdAt ?? 0))

    const checkoutRoot = meta.cwd ? await resolveGitCheckoutRoot(meta.cwd) : undefined
    const checkoutPath = checkoutRoot && checkoutRoot !== projectPath ? checkoutRoot : undefined

    const baseSession: CodingCliSession = {
      provider: provider.name,
      sessionId,
      projectPath,
      ...(checkoutPath ? { checkoutPath } : {}),
      lastActivityAt,
      createdAt,
      messageCount: meta.messageCount,
      title: meta.title,
      summary: meta.summary,
      ...(meta.firstUserMessage ? { firstUserMessage: meta.firstUserMessage } : {}),
      cwd: meta.cwd,
      gitBranch: meta.gitBranch,
      isDirty: meta.isDirty,
      tokenUsage: meta.tokenUsage,
      sourceFile: filePath,
      isSubagent: meta.isSubagent || isSubagentSession(filePath) || undefined,
      isNonInteractive: meta.isNonInteractive || undefined,
      codexTaskEvents: meta.codexTaskEvents,
    }

    this.fileCache.set(cacheKey, {
      provider: provider.name,
      mtimeMs,
      size,
      baseSession,
    })
    this.sessionKeyToFilePath.set(makeSessionKey(provider.name, sessionId), filePath)
  }

  private updateDirectCacheEntry(provider: CodingCliProvider, session: CodingCliSession, cacheKey: string) {
    this.fileCache.set(cacheKey, {
      provider: provider.name,
      mtimeMs: session.lastActivityAt,
      size: 0,
      baseSession: {
        ...session,
        provider: provider.name,
      },
    })
  }

  private async refreshDirectProvider(provider: CodingCliProvider): Promise<Set<string>> {
    if (!provider.listSessionsDirect) return new Set()

    const seenKeys = new Set<string>()
    let sessions: CodingCliSession[] = []
    try {
      sessions = await provider.listSessionsDirect()
    } catch (err) {
      logger.warn({ err, provider: provider.name }, 'Could not list provider sessions directly')
      return seenKeys
    }

    for (const session of sessions) {
      const cacheKey = this.makeDirectCacheKey(provider.name, session.sessionId)
      seenKeys.add(cacheKey)
      this.updateDirectCacheEntry(provider, session, cacheKey)
    }

    for (const [cacheKey, cached] of this.fileCache) {
      if (!this.isDirectCacheKey(cacheKey) || cached.provider !== provider.name) continue
      if (!seenKeys.has(cacheKey)) {
        this.deleteCacheEntry(cacheKey)
      }
    }

    return seenKeys
  }

  scheduleRefresh() {
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    const urgent = this.urgentRefreshNeeded
    this.urgentRefreshNeeded = false
    const elapsed = Date.now() - this.lastRefreshAt
    const delay = urgent ? URGENT_REFRESH_MS : Math.max(this.debounceMs, this.throttleMs - elapsed)
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null
      // Re-check throttle at fire-time: an in-flight refresh may have completed
      // since scheduling, updating lastRefreshAt. Without this, a timer scheduled
      // during an in-flight refresh would fire too soon after it completes.
      // Urgent refreshes use a shorter throttle floor to stay responsive while
      // capping worst-case frequency for sessions that stay titleless under load.
      const effectiveThrottle = urgent
        ? (this.throttleMs > 0 ? Math.min(URGENT_THROTTLE_MS, this.throttleMs) : 0)
        : this.throttleMs
      const fireElapsed = Date.now() - this.lastRefreshAt
      if (effectiveThrottle > 0 && fireElapsed < effectiveThrottle) {
        this.refreshTimer = setTimeout(() => {
          this.refreshTimer = null
          this.refresh().catch((err) => logger.warn({ err }, 'Refresh failed'))
        }, effectiveThrottle - fireElapsed)
        return
      }
      this.refresh().catch((err) => logger.warn({ err }, 'Refresh failed'))
    }, delay)
  }

  async refresh() {
    if (this.refreshInFlight) {
      this.refreshQueued = true
      return
    }
    this.refreshInFlight = true
    try {
      do {
        this.refreshQueued = false
        await this.performRefresh()
      } while (this.refreshQueued)
    } finally {
      this.refreshInFlight = false
      this.lastRefreshAt = Date.now()
    }
  }

  /**
   * Build sorted, grouped project list from the current file cache.
   */
  private buildProjectGroups(
    colors: Record<string, string | undefined>,
    cfg: { sessionOverrides?: Record<string, SessionOverride> },
    sessionMetadata: Record<string, SessionMetadataEntry>,
    enabledSet: Set<string>,
  ): { groups: ProjectGroup[]; sessionCount: number } {
    const groupsByPath = new Map<string, ProjectGroup>()
    let sessionCount = 0

    for (const [, cached] of this.fileCache) {
      if (!enabledSet.has(cached.provider)) continue
      if (!cached.baseSession) continue
      const compositeKey = makeSessionKey(cached.baseSession.provider, cached.baseSession.sessionId)
      let ov = cfg.sessionOverrides?.[compositeKey] || cfg.sessionOverrides?.[cached.baseSession.sessionId]
      if (!ov && cached.baseSession.provider === 'claude' && cached.baseSession.sourceFile) {
        const legacySessionId = path.basename(cached.baseSession.sourceFile, '.jsonl')
        if (legacySessionId && legacySessionId !== cached.baseSession.sessionId) {
          const legacyKey = makeSessionKey(cached.baseSession.provider, legacySessionId)
          const legacyOverride = cfg.sessionOverrides?.[legacyKey] || cfg.sessionOverrides?.[legacySessionId]
          if (legacyOverride) {
            logger.warn({ sessionId: cached.baseSession.sessionId, legacySessionId }, 'Using legacy Claude session override')
            ov = legacyOverride
          }
        }
      }
      const merged = applyOverride(cached.baseSession, ov)
      if (!merged) continue
      const metaKey = makeSessionKey(merged.provider, merged.sessionId)
      const meta = sessionMetadata[metaKey]
      if (meta?.sessionType) {
        merged.sessionType = meta.sessionType
      }
      const group = groupsByPath.get(merged.projectPath) || {
        projectPath: merged.projectPath,
        sessions: [],
      }
      group.sessions.push(merged)
      groupsByPath.set(merged.projectPath, group)
      sessionCount += 1
    }

    const groups: ProjectGroup[] = Array.from(groupsByPath.values()).map((group) => ({
      ...group,
      color: colors[group.projectPath],
      sessions: group.sessions.sort((a, b) => b.lastActivityAt - a.lastActivityAt),
    }))

    groups.sort((a, b) => {
      const diff = (b.sessions[0]?.lastActivityAt || 0) - (a.sessions[0]?.lastActivityAt || 0)
      if (diff !== 0) return diff
      if (a.projectPath < b.projectPath) return -1
      if (a.projectPath > b.projectPath) return 1
      return 0
    })

    return { groups, sessionCount }
  }

  /**
   * Publish current project groups to listeners if they changed.
   */
  private commitProjects(groups: ProjectGroup[], sessionCount: number, fileCount: number): boolean {
    const allSessions = groups.flatMap((g) => g.sessions)
    this.detectNewSessions(allSessions)

    const projectsDiff = diffProjects(this.projects, groups)
    const changed = projectsDiff.upsertProjects.length > 0 || projectsDiff.removeProjectPaths.length > 0
    if (changed) {
      this.projects = groups
      this.emitUpdate()
    }
    return changed
  }

  /**
   * Fast parallel scan that reads head+tail of each file to populate the sidebar.
   * Returns file lists per provider so the enrichment pass can reuse them.
   */
  private async lightweightScan(
    enabledSet: Set<string>,
    colors: Record<string, string | undefined>,
    cfg: { sessionOverrides?: Record<string, SessionOverride> },
    sessionMetadata: Record<string, SessionMetadataEntry>,
  ): Promise<{ filesByProvider: Map<CodingCliProvider, string[]>; seenCacheKeys: Set<string> }> {
    const endTimer = startPerfTimer('coding_cli_lightweight_scan', {}, { minDurationMs: 200, level: 'info' })
    const filesByProvider = new Map<CodingCliProvider, string[]>()
    const seenCacheKeys = new Set<string>()

    // Discover files across all file-based providers in parallel.
    await Promise.all(this.providers
      .filter((p) => enabledSet.has(p.name) && !p.listSessionsDirect)
      .map(async (provider) => {
        try {
          const files = await provider.listSessionFiles()
          filesByProvider.set(provider, files)
        } catch (err) {
          logger.warn({ err, provider: provider.name }, 'Could not list session files')
        }
      }),
    )

    const allFiles: Array<{ provider: CodingCliProvider; filePath: string }> = []
    for (const [provider, files] of filesByProvider) {
      for (const f of files) allFiles.push({ provider, filePath: f })
    }

    if (allFiles.length === 0) {
      endTimer({ fileCount: 0, sessionCount: 0 })
      return { filesByProvider, seenCacheKeys }
    }

    // Read head+tail of every file in parallel.
    const metas = await Promise.all(allFiles.map(({ provider, filePath }) =>
      readLightweightMeta(filePath).then((meta) => ({ provider, meta })),
    ))

    // Build lightweight cache entries.
    for (const { provider, meta } of metas) {
      const cacheKey = normalizeFilePath(meta.filePath)
      seenCacheKeys.add(cacheKey)

      if (!meta.cwd) continue
      // Don't overwrite a full entry from a prior scan.
      const existing = this.fileCache.get(cacheKey)
      if (existing && existing.baseSession) continue

      const sessionId = meta.sessionId || provider.extractSessionId(meta.filePath)
      const projectPath = meta.cwd ? await resolveGitRepoRoot(meta.cwd) : meta.cwd
      const baseSession: CodingCliSession = {
        provider: provider.name,
        sessionId,
        projectPath,
        lastActivityAt: meta.lastActivityAt || meta.mtimeMs,
        createdAt: meta.createdAt,
        title: meta.title,
        cwd: meta.cwd,
        sourceFile: meta.filePath,
        isSubagent: isSubagentSession(meta.filePath) || undefined,
      }

      this.fileCache.set(cacheKey, {
        provider: provider.name,
        mtimeMs: meta.mtimeMs,
        size: meta.size,
        baseSession,
        lightweight: true,
      })
      this.sessionKeyToFilePath.set(makeSessionKey(provider.name, sessionId), meta.filePath)
    }

    // Emit early only when there are enough files that enrichment will take noticeable time.
    // With few files the full enrichment completes within milliseconds and the early emit
    // would just cause a redundant sessions.changed broadcast.
    let lightweightSessionCount = this.fileCache.size
    if (allFiles.length > ENRICHMENT_BATCH_SIZE) {
      const built = this.buildProjectGroups(colors, cfg, sessionMetadata, enabledSet)
      this.commitProjects(built.groups, built.sessionCount, allFiles.length)
      lightweightSessionCount = built.sessionCount
    }
    endTimer({ fileCount: allFiles.length, sessionCount: lightweightSessionCount })
    logger.info({ fileCount: allFiles.length, sessionCount: lightweightSessionCount }, 'Lightweight scan complete')

    return { filesByProvider, seenCacheKeys }
  }

  /**
   * Enrich the most recent sessions with full metadata (isNonInteractive, token usage, etc).
   * Only enriches the top N by recency — enough to fill the first sidebar page with filtered results.
   */
  private async enrichRecentSessions(
    filesByProvider: Map<CodingCliProvider, string[]>,
    enabledSet: Set<string>,
    seenCacheKeys: Set<string>,
  ): Promise<void> {
    // Collect all file-based entries for enrichment. Files the lightweight scan couldn't
    // parse (e.g. Codex with 14KB first lines) use file mtime as the recency estimate.
    const statCache = new Map<string, number>()
    const candidates: Array<{ provider: CodingCliProvider; filePath: string; cacheKey: string; lastActivityAt: number; isSubagent: boolean }> = []
    for (const [provider, files] of filesByProvider) {
      if (!enabledSet.has(provider.name)) continue
      for (const filePath of files) {
        const cacheKey = normalizeFilePath(filePath)
        const cached = this.fileCache.get(cacheKey)
        let lastActivityAt = cached?.baseSession?.lastActivityAt ?? cached?.mtimeMs ?? 0
        if (lastActivityAt === 0) {
          // No cache entry — file wasn't parseable from 4KB. Use mtime for sorting.
          try {
            let mtime = statCache.get(cacheKey)
            if (mtime === undefined) {
              const stat = await fsp.stat(filePath)
              mtime = stat.mtimeMs || stat.mtime.getTime()
              statCache.set(cacheKey, mtime)
            }
            lastActivityAt = mtime
          } catch { /* file may have been deleted */ }
        }
        const isSubagent = cached?.baseSession?.isSubagent ?? isSubagentSession(filePath)
        candidates.push({ provider, filePath, cacheKey, lastActivityAt, isSubagent })
      }
    }

    // When there are few enough files, enrich all of them. The lightweight scan is
    // an optimization for large libraries; small sets don't benefit from deferral.
    let batch: typeof candidates
    if (candidates.length <= ENRICHMENT_BATCH_SIZE) {
      batch = candidates
    } else {
      // Prioritize non-subagent, most-recent sessions for the first sidebar page.
      candidates.sort((a, b) => {
        if (a.isSubagent !== b.isSubagent) return a.isSubagent ? 1 : -1
        return b.lastActivityAt - a.lastActivityAt
      })
      batch = candidates.slice(0, ENRICHMENT_BATCH_SIZE)
    }

    let enriched = 0
    for (const { provider, filePath, cacheKey } of batch) {
      if (INDEXER_DELAY_MS > 0) {
        await new Promise((r) => setTimeout(r, INDEXER_DELAY_MS))
      }
      await this.updateCacheEntry(provider, filePath, cacheKey)
      enriched += 1
      if (enriched % REFRESH_YIELD_EVERY === 0) {
        await yieldToEventLoop()
      }
    }

    logger.info({ enriched, total: candidates.length }, 'Enriched recent sessions')
  }

  private async performRefresh() {
    const endRefreshTimer = startPerfTimer(
      'coding_cli_refresh',
      {},
      { minDurationMs: perfConfig.slowSessionRefreshMs, level: 'warn' },
    )
    const [colors, cfg, sessionMetadata] = await Promise.all([
      configStore.getProjectColors(),
      configStore.snapshot(),
      this.sessionMetadataStore?.getAll() ?? Promise.resolve({} as Record<string, SessionMetadataEntry>),
    ])
    const enabledProviders = cfg.settings?.codingCli?.enabledProviders
    const enabledSet = new Set(enabledProviders ?? this.providers.map((p) => p.name))
    const enabledKey = Array.from(enabledSet).sort().join(',')
    if (enabledKey !== this.lastEnabledKey) {
      this.lastEnabledKey = enabledKey
      this.needsFullScan = true
    }

    let fileCount = 0
    let processedEntries = 0

    const shouldFullScan = this.needsFullScan || this.fileCache.size === 0
    if (shouldFullScan) {
      const isColdStart = this.fileCache.size === 0
      this.needsFullScan = false
      this.dirtyFiles.clear()
      this.deletedFiles.clear()
      this.dirtyProviders.clear()

      let filesByProvider: Map<CodingCliProvider, string[]> | undefined
      const seenCacheKeys = new Set<string>()

      if (isColdStart) {
        // Cold start: lightweight parallel scan populates the sidebar immediately,
        // then selective enrichment fills in filtering metadata for the first page.
        const result = await this.lightweightScan(enabledSet, colors, cfg, sessionMetadata)
        filesByProvider = result.filesByProvider
        for (const key of result.seenCacheKeys) seenCacheKeys.add(key)
      }

      // Handle direct-listing providers.
      for (const provider of this.providers) {
        if (!enabledSet.has(provider.name) || !provider.listSessionsDirect) continue
        const seenDirectKeys = await this.refreshDirectProvider(provider)
        fileCount += seenDirectKeys.size
        for (const cacheKey of seenDirectKeys) seenCacheKeys.add(cacheKey)
      }

      // Full enrichment pass for file-based providers.
      // On cold start this only enriches the top N (rest already have lightweight data).
      // On warm rescan this processes all files normally.
      for (const provider of this.providers) {
        if (!enabledSet.has(provider.name) || provider.listSessionsDirect) continue
        const files = filesByProvider?.get(provider) ?? await provider.listSessionFiles().catch((err) => {
          logger.warn({ err, provider: provider.name }, 'Could not list session files')
          return [] as string[]
        })
        fileCount += files.length

        if (isColdStart) {
          // Selective enrichment: only the most recent non-subagent sessions.
          await this.enrichRecentSessions(
            new Map([[provider, files]]), enabledSet, seenCacheKeys,
          )
          for (const f of files) seenCacheKeys.add(normalizeFilePath(f))
        } else {
          // Warm rescan: process all files (cache hits skip unchanged files).
          for (const file of files) {
            processedEntries += 1
            if (processedEntries % REFRESH_YIELD_EVERY === 0) {
              await yieldToEventLoop()
            }
            const cacheKey = normalizeFilePath(file)
            seenCacheKeys.add(cacheKey)
            await this.updateCacheEntry(provider, file, cacheKey)
          }
        }
      }

      // Prune cache entries for files that no longer exist.
      for (const cachedFile of this.fileCache.keys()) {
        const cached = this.fileCache.get(cachedFile)
        if (!cached || !enabledSet.has(cached.provider) || !seenCacheKeys.has(cachedFile)) {
          this.deleteCacheEntry(cachedFile)
        }
      }
    } else {
      // Incremental refresh — only process changed files.
      const deletedFiles = Array.from(this.deletedFiles)
      const dirtyFiles = Array.from(this.dirtyFiles)
      const dirtyProviders = Array.from(this.dirtyProviders)
      this.deletedFiles.clear()
      this.dirtyFiles.clear()
      this.dirtyProviders.clear()

      for (const file of deletedFiles) {
        this.deleteCacheEntry(file)
      }

      for (const providerName of dirtyProviders) {
        const provider = this.providers.find((candidate) => candidate.name === providerName)
        if (!provider?.listSessionsDirect) continue
        if (!enabledSet.has(provider.name)) {
          for (const [cacheKey, cached] of this.fileCache) {
            if (this.isDirectCacheKey(cacheKey) && cached.provider === provider.name) {
              this.deleteCacheEntry(cacheKey)
            }
          }
          continue
        }
        await this.refreshDirectProvider(provider)
      }

      for (const file of dirtyFiles) {
        processedEntries += 1
        if (processedEntries % REFRESH_YIELD_EVERY === 0) {
          await yieldToEventLoop()
        }
        const cached = this.fileCache.get(file)
        const provider = cached
          ? this.providers.find((p) => p.name === cached.provider)
          : this.resolveProviderForFile(file)
        if (!provider) {
          this.needsFullScan = true
          continue
        }
        if (provider.listSessionsDirect) continue
        if (!enabledSet.has(provider.name)) {
          this.deleteCacheEntry(file)
          continue
        }
        await this.updateCacheEntry(provider, file, file)
      }
    }

    if (fileCount === 0) {
      fileCount = this.fileCache.size
    }

    // Prune disabled providers from cache.
    for (const [cachedFile, cached] of this.fileCache) {
      if (!enabledSet.has(cached.provider)) {
        this.deleteCacheEntry(cachedFile)
      }
    }

    const { groups, sessionCount } = this.buildProjectGroups(colors, cfg, sessionMetadata, enabledSet)
    const changed = this.commitProjects(groups, sessionCount, fileCount)
    if (!changed) {
      logger.debug({ sessionCount, fileCount }, 'Skipping no-op refresh (no project changes)')
    }
    endRefreshTimer({ projectCount: groups.length, sessionCount, fileCount, skipped: !changed })
  }

  private emitUpdate() {
    for (const h of this.onUpdateHandlers) {
      try {
        h(this.projects)
      } catch (err) {
        logger.warn({ err }, 'onUpdate handler failed')
      }
    }
  }
}
