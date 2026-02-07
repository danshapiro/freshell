import fs from 'fs'
import path from 'path'
import fsp from 'fs/promises'
import chokidar from 'chokidar'
import { logger } from '../logger.js'
import { getPerfConfig, startPerfTimer } from '../perf-logger.js'
import { configStore, SessionOverride } from '../config-store.js'
import type { CodingCliProvider } from './provider.js'
import type { CodingCliSession, CodingCliProviderName, ProjectGroup } from './types.js'
import { makeSessionKey } from './types.js'

const perfConfig = getPerfConfig()
const REFRESH_YIELD_EVERY = 200

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve))
const IS_WINDOWS = process.platform === 'win32'

const normalizeFilePath = (filePath: string) => {
  const resolved = path.resolve(filePath)
  return IS_WINDOWS ? resolved.toLowerCase() : resolved
}

/**
 * Check if a file path is a Claude subagent session.
 * Subagent sessions are internal implementation details and shouldn't
 * appear in the user-facing session list.
 */
function isSubagentSession(filePath: string): boolean {
  const normalized = filePath.toLowerCase()
  return normalized.includes('/subagents/') || normalized.includes('\\subagents\\')
}

function applyOverride(session: CodingCliSession, ov: SessionOverride | undefined): CodingCliSession | null {
  if (ov?.deleted) return null
  return {
    ...session,
    title: ov?.titleOverride || session.title,
    summary: ov?.summaryOverride || session.summary,
  }
}

async function readSessionSnippet(filePath: string): Promise<string> {
  try {
    const stream = fs.createReadStream(filePath, { encoding: 'utf-8', highWaterMark: 256 * 1024 })
    let data = ''
    for await (const chunk of stream) {
      data += chunk
      if (data.length >= 256 * 1024) break
    }
    stream.close()
    return data
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

  constructor(private providers: CodingCliProvider[]) {}

  async start() {
    this.needsFullScan = true
    await this.refresh()
    const globs = this.providers.map((p) => p.getSessionGlob())
    logger.info({ globs }, 'Starting coding CLI sessions watcher')

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

  getProjects(): ProjectGroup[] {
    return this.projects
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

  private async updateCacheEntry(provider: CodingCliProvider, filePath: string, cacheKey: string) {
    let stat: fs.Stats
    try {
      stat = await fsp.stat(filePath)
    } catch {
      this.fileCache.delete(cacheKey)
      return
    }

    const mtimeMs = stat.mtimeMs || stat.mtime.getTime()
    const size = stat.size

    const cached = this.fileCache.get(cacheKey)
    if (cached && cached.mtimeMs === mtimeMs && cached.size === size) {
      return
    }

    const content = await readSessionSnippet(filePath)
    const meta = provider.parseSessionFile(content, filePath)
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
      sourceFile: filePath,
    }

    this.fileCache.set(cacheKey, {
      provider: provider.name,
      mtimeMs,
      size,
      baseSession,
    })
  }

  private scheduleRefresh() {
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    this.refreshTimer = setTimeout(() => {
      this.refresh().catch((err) => logger.warn({ err }, 'Refresh failed'))
    }, 250)
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
          this.fileCache.delete(cachedFile)
        }
      }
    } else {
      const deletedFiles = Array.from(this.deletedFiles)
      const dirtyFiles = Array.from(this.dirtyFiles)
      this.deletedFiles.clear()
      this.dirtyFiles.clear()

      for (const file of deletedFiles) {
        this.fileCache.delete(file)
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
          this.fileCache.delete(file)
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
        this.fileCache.delete(cachedFile)
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

    this.projects = groups
    this.emitUpdate()
    endRefreshTimer({ projectCount: groups.length, sessionCount, fileCount })
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
