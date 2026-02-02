import fs from 'fs'
import fsp from 'fs/promises'
import chokidar from 'chokidar'
import { logger } from '../logger.js'
import { getPerfConfig, startPerfTimer } from '../perf-logger.js'
import { configStore, SessionOverride } from '../config-store.js'
import type { CodingCliProvider } from './provider.js'
import type { CodingCliSession, ProjectGroup } from './types.js'
import { makeSessionKey } from './types.js'

const perfConfig = getPerfConfig()
const REFRESH_YIELD_EVERY = 200

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve))

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

  constructor(private providers: CodingCliProvider[]) {}

  async start() {
    await this.refresh()
    const globs = this.providers.map((p) => p.getSessionGlob())
    logger.info({ globs }, 'Starting coding CLI sessions watcher')

    this.watcher = chokidar.watch(globs, {
      ignoreInitial: true,
    })

    const schedule = () => this.scheduleRefresh()
    this.watcher.on('add', schedule)
    this.watcher.on('change', schedule)
    this.watcher.on('unlink', schedule)
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
    const colors = await configStore.getProjectColors()
    const cfg = await configStore.snapshot()
    const enabledProviders = cfg.settings?.codingCli?.enabledProviders
    const enabledSet = new Set(enabledProviders ?? this.providers.map((p) => p.name))

    const groupsByPath = new Map<string, ProjectGroup>()
    let fileCount = 0
    let sessionCount = 0
    let processedEntries = 0
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
        seenFiles.add(file)
        let stat: any
        try {
          stat = await fsp.stat(file)
        } catch {
          continue
        }
        const mtimeMs = stat.mtimeMs || stat.mtime.getTime()
        const size = stat.size

        const cached = this.fileCache.get(file)
        if (cached && cached.mtimeMs === mtimeMs && cached.size === size) {
          if (!cached.baseSession) continue
          const compositeKey = makeSessionKey(cached.baseSession.provider, cached.baseSession.sessionId)
          const ov = cfg.sessionOverrides?.[compositeKey]
          const merged = applyOverride(cached.baseSession, ov)
          if (!merged) continue
          const group = groupsByPath.get(merged.projectPath) || {
            projectPath: merged.projectPath,
            sessions: [],
          }
          group.sessions.push(merged)
          groupsByPath.set(merged.projectPath, group)
          sessionCount += 1
          continue
        }

        const content = await readSessionSnippet(file)
        const meta = provider.parseSessionFile(content, file)
        if (!meta.cwd) {
          this.fileCache.set(file, {
            mtimeMs,
            size,
            baseSession: null,
          })
          continue
        }

        const projectPath = await provider.resolveProjectPath(file, meta)
        const sessionId = meta.sessionId || provider.extractSessionId(file, meta)

        const baseSession: CodingCliSession = {
          provider: provider.name,
          sessionId,
          projectPath,
          updatedAt: stat.mtimeMs || stat.mtime.getTime(),
          messageCount: meta.messageCount,
          title: meta.title,
          summary: meta.summary,
          cwd: meta.cwd,
          sourceFile: file,
        }

        this.fileCache.set(file, {
          mtimeMs,
          size,
          baseSession,
        })

        const compositeKey = makeSessionKey(provider.name, sessionId)
        const ov = cfg.sessionOverrides?.[compositeKey]
        const merged = applyOverride(baseSession, ov)
        if (!merged) continue

        const group = groupsByPath.get(projectPath) || {
          projectPath,
          sessions: [],
        }
        group.sessions.push(merged)
        groupsByPath.set(projectPath, group)
        sessionCount += 1
      }
    }

    for (const cachedFile of this.fileCache.keys()) {
      processedEntries += 1
      if (processedEntries % REFRESH_YIELD_EVERY === 0) {
        await yieldToEventLoop()
      }
      if (!seenFiles.has(cachedFile)) {
        this.fileCache.delete(cachedFile)
      }
    }

    const groups: ProjectGroup[] = Array.from(groupsByPath.values()).map((group) => ({
      ...group,
      color: colors[group.projectPath],
      sessions: group.sessions.sort((a, b) => b.updatedAt - a.updatedAt),
    }))

    // Sort projects by most recent session activity.
    groups.sort((a, b) => (b.sessions[0]?.updatedAt || 0) - (a.sessions[0]?.updatedAt || 0))

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
