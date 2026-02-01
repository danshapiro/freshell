import fs from 'fs'
import fsp from 'fs/promises'
import chokidar from 'chokidar'
import { logger } from '../logger.js'
import { configStore, SessionOverride } from '../config-store.js'
import type { CodingCliProvider } from './provider.js'
import type { CodingCliSession, ProjectGroup } from './types.js'
import { makeSessionKey } from './types.js'

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

export class CodingCliSessionIndexer {
  private watcher: chokidar.FSWatcher | null = null
  private projects: ProjectGroup[] = []
  private onUpdateHandlers = new Set<(projects: ProjectGroup[]) => void>()
  private refreshTimer: NodeJS.Timeout | null = null

  constructor(private providers: CodingCliProvider[]) {}

  async start() {
    await this.refresh()
    const globs = this.providers.map((p) => p.getSessionGlob())
    logger.info({ globs }, 'Starting coding CLI sessions watcher')

    this.watcher = chokidar.watch(globs, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 100 },
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
    const colors = await configStore.getProjectColors()
    const cfg = await configStore.snapshot()
    const enabledProviders = cfg.settings?.codingCli?.enabledProviders
    const enabledSet = new Set(enabledProviders ?? this.providers.map((p) => p.name))

    const groupsByPath = new Map<string, ProjectGroup>()

    for (const provider of this.providers) {
      if (!enabledSet.has(provider.name)) continue
      let files: string[] = []
      try {
        files = await provider.listSessionFiles()
      } catch (err) {
        logger.warn({ err, provider: provider.name }, 'Could not list session files')
        continue
      }

      for (const file of files) {
        let stat: any
        try {
          stat = await fsp.stat(file)
        } catch {
          continue
        }

        const content = await readSessionSnippet(file)
        const meta = provider.parseSessionFile(content, file)
        if (!meta.cwd) continue

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
