import path from 'path'
import fsp from 'fs/promises'
import type { Stats } from 'fs'
import chokidar from 'chokidar'
import { logger } from '../logger.js'
import { getPerfConfig, startPerfTimer } from '../perf-logger.js'
import { configStore, SessionOverride } from '../config-store.js'
import type { CodingCliProvider } from './provider.js'
import { makeSessionKey, type CodingCliSession, type CodingCliProviderName, type ProjectGroup } from './types.js'
import { diffProjects } from '../sessions-sync/diff.js'

const perfConfig = getPerfConfig()
const REFRESH_YIELD_EVERY = 200
const SESSION_SNIPPET_BYTES = 256 * 1024
const SEEN_SESSION_RETENTION_MS = Number(process.env.CODING_CLI_SEEN_SESSION_RETENTION_MS || 7 * 24 * 60 * 60 * 1000)
const MAX_SEEN_SESSION_IDS = Number(process.env.CODING_CLI_SEEN_SESSION_MAX || 10_000)

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve))
const IS_WINDOWS = process.platform === 'win32'

const normalizeFilePath = (filePath: string) => {
  const resolved = path.resolve(filePath)
  return IS_WINDOWS ? resolved.toLowerCase() : resolved
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

async function readSessionSnippet(filePath: string): Promise<string> {
  try {
    const stat = await fsp.stat(filePath)
    if (stat.size <= SESSION_SNIPPET_BYTES) {
      return await fsp.readFile(filePath, 'utf-8')
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

      if (!head) return tail
      if (!tail) return head
      return `${head}\n${tail}`
    } finally {
      await fd.close()
    }
  } catch {
    return ''
  }
}

type CachedSessionEntry = {
  provider: CodingCliProviderName
  mtimeMs: number
  size: number
  baseSession: CodingCliSession | null
}

export type SessionIndexerOptions = {
  debounceMs?: number
  throttleMs?: number
}

const DEFAULT_DEBOUNCE_MS = 2_000
const DEFAULT_THROTTLE_MS = 5_000

export class CodingCliSessionIndexer {
  private watcher: chokidar.FSWatcher | null = null
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
  private knownSessionIds = new Set<string>()
  private seenSessionIds = new Map<string, number>()
  private onNewSessionHandlers = new Set<(session: CodingCliSession) => void>()
  private initialized = false
  private sessionKeyToFilePath = new Map<string, string>()

  constructor(private providers: CodingCliProvider[], options: SessionIndexerOptions = {}) {
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS
    this.throttleMs = options.throttleMs ?? DEFAULT_THROTTLE_MS
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
  }

  stop() {
    this.watcher?.close().catch(() => {})
    this.watcher = null
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    this.refreshTimer = null
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
    this.deletedFiles.delete(normalized)
    this.dirtyFiles.add(normalized)
  }

  private markDeleted(filePath: string) {
    const normalized = normalizeFilePath(filePath)
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
        const diff = a.updatedAt - b.updatedAt
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
    if (cached && cached.mtimeMs === mtimeMs && cached.size === size) {
      return
    }

    // Clean up previous session mapping before re-parsing
    if (cached?.baseSession?.sessionId) {
      this.sessionKeyToFilePath.delete(makeSessionKey(cached.baseSession.provider, cached.baseSession.sessionId))
    }

    const content = await readSessionSnippet(filePath)
    const meta = await provider.parseSessionFile(content, filePath)
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

    const baseSession: CodingCliSession = {
      provider: provider.name,
      sessionId,
      projectPath,
      updatedAt: stat.mtimeMs || stat.mtime.getTime(),
      messageCount: meta.messageCount,
      title: meta.title,
      summary: meta.summary,
      cwd: meta.cwd,
      gitBranch: meta.gitBranch,
      isDirty: meta.isDirty,
      tokenUsage: meta.tokenUsage,
      sourceFile: filePath,
      isSubagent: isSubagentSession(filePath) || undefined,
      isNonInteractive: meta.isNonInteractive || undefined,
    }

    this.fileCache.set(cacheKey, {
      provider: provider.name,
      mtimeMs,
      size,
      baseSession,
    })
    this.sessionKeyToFilePath.set(makeSessionKey(provider.name, sessionId), filePath)
  }

  scheduleRefresh() {
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    const elapsed = Date.now() - this.lastRefreshAt
    const delay = Math.max(this.debounceMs, this.throttleMs - elapsed)
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null
      // Re-check throttle at fire-time: an in-flight refresh may have completed
      // since scheduling, updating lastRefreshAt. Without this, a timer scheduled
      // during an in-flight refresh would fire too soon after it completes.
      const fireElapsed = Date.now() - this.lastRefreshAt
      if (this.throttleMs > 0 && fireElapsed < this.throttleMs) {
        this.refreshTimer = setTimeout(() => {
          this.refreshTimer = null
          this.refresh().catch((err) => logger.warn({ err }, 'Refresh failed'))
        }, this.throttleMs - fireElapsed)
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

  private async performRefresh() {
    const endRefreshTimer = startPerfTimer(
      'coding_cli_refresh',
      {},
      { minDurationMs: perfConfig.slowSessionRefreshMs, level: 'warn' },
    )
    const [colors, cfg] = await Promise.all([configStore.getProjectColors(), configStore.snapshot()])
    const enabledProviders = cfg.settings?.codingCli?.enabledProviders
    const enabledSet = new Set(enabledProviders ?? this.providers.map((p) => p.name))
    const enabledKey = Array.from(enabledSet).sort().join(',')
    if (enabledKey !== this.lastEnabledKey) {
      this.lastEnabledKey = enabledKey
      this.needsFullScan = true
    }

    const groupsByPath = new Map<string, ProjectGroup>()
    let fileCount = 0
    let sessionCount = 0
    let processedEntries = 0

    const shouldFullScan = this.needsFullScan || this.fileCache.size === 0
    if (shouldFullScan) {
      this.needsFullScan = false
      this.dirtyFiles.clear()
      this.deletedFiles.clear()

      const seenFiles = new Set<string>()
      for (const provider of this.providers) {
        if (!enabledSet.has(provider.name)) continue
        let files: string[] = []
        try {
          files = await provider.listSessionFiles()
        } catch (err) {
          logger.warn({ err, provider: provider.name }, 'Could not list session files')
          continue
        }
        fileCount += files.length

        for (const file of files) {
          processedEntries += 1
          if (processedEntries % REFRESH_YIELD_EVERY === 0) {
            await yieldToEventLoop()
          }
          const cacheKey = normalizeFilePath(file)
          seenFiles.add(cacheKey)
          await this.updateCacheEntry(provider, file, cacheKey)
        }
      }

      for (const cachedFile of this.fileCache.keys()) {
        processedEntries += 1
        if (processedEntries % REFRESH_YIELD_EVERY === 0) {
          await yieldToEventLoop()
        }
        const cached = this.fileCache.get(cachedFile)
        if (!cached || !enabledSet.has(cached.provider) || !seenFiles.has(cachedFile)) {
          this.deleteCacheEntry(cachedFile)
        }
      }
    } else {
      const deletedFiles = Array.from(this.deletedFiles)
      const dirtyFiles = Array.from(this.dirtyFiles)
      this.deletedFiles.clear()
      this.dirtyFiles.clear()

      for (const file of deletedFiles) {
        this.deleteCacheEntry(file)
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

    processedEntries = 0
    for (const [cachedFile, cached] of this.fileCache) {
      processedEntries += 1
      if (processedEntries % REFRESH_YIELD_EVERY === 0) {
        await yieldToEventLoop()
      }
      if (!enabledSet.has(cached.provider)) {
        this.deleteCacheEntry(cachedFile)
        continue
      }
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
      sessions: group.sessions.sort((a, b) => b.updatedAt - a.updatedAt),
    }))

    // Sort projects by most recent session activity.
    groups.sort((a, b) => {
      const diff = (b.sessions[0]?.updatedAt || 0) - (a.sessions[0]?.updatedAt || 0)
      if (diff !== 0) return diff
      if (a.projectPath < b.projectPath) return -1
      if (a.projectPath > b.projectPath) return 1
      return 0
    })

    const allSessions = groups.flatMap((g) => g.sessions)
    this.detectNewSessions(allSessions)

    const projectsDiff = diffProjects(this.projects, groups)
    const changed = projectsDiff.upsertProjects.length > 0 || projectsDiff.removeProjectPaths.length > 0
    if (changed) {
      this.projects = groups
      this.emitUpdate()
    } else {
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
