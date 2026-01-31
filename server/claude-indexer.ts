import path from 'path'
import os from 'os'
import fsp from 'fs/promises'
import fs from 'fs'
import chokidar from 'chokidar'
import { logger } from './logger.js'
import { configStore, SessionOverride } from './config-store.js'
import { extractTitleFromMessage } from './title-utils.js'

const SEEN_SESSION_RETENTION_MS = Number(process.env.CLAUDE_SEEN_SESSION_RETENTION_MS || 7 * 24 * 60 * 60 * 1000)
const MAX_SEEN_SESSION_IDS = Number(process.env.CLAUDE_SEEN_SESSION_MAX || 10_000)
const INCREMENTAL_DEBOUNCE_MS = Number(process.env.CLAUDE_INDEXER_DEBOUNCE_MS || 250)

export type ClaudeSession = {
  sessionId: string
  projectPath: string
  updatedAt: number
  messageCount?: number
  title?: string
  summary?: string
  cwd?: string
}

export type ProjectGroup = {
  projectPath: string
  sessions: ClaudeSession[]
  color?: string
}

export function defaultClaudeHome(): string {
  // Claude Code stores logs in ~/.claude by default (Linux/macOS).
  // On Windows, set CLAUDE_HOME to a path you can access from Node (e.g. \\wsl$\...).
  return process.env.CLAUDE_HOME || path.join(os.homedir(), '.claude')
}

export function looksLikePath(s: string): boolean {
  // Reject URLs and protocol-based strings (contain :// before any path separator)
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s)) {
    return false
  }

  // Accept special directory references
  if (s === '~' || s === '.' || s === '..') {
    return true
  }

  // Accept paths with separators or Windows drive letters
  return s.includes('/') || s.includes('\\') || /^[A-Za-z]:\\/.test(s)
}

async function tryReadJson(filePath: string): Promise<any | null> {
  try {
    const raw = await fsp.readFile(filePath, 'utf-8')
    return JSON.parse(raw)
  } catch {
    return null
  }
}

async function resolveProjectPath(projectDir: string): Promise<string> {
  // Try known files first
  const candidates = ['project.json', 'metadata.json', 'config.json']
  for (const name of candidates) {
    const p = path.join(projectDir, name)
    const json = await tryReadJson(p)
    if (json) {
      const possible =
        json.projectPath || json.path || json.cwd || json.root || json.project_root || json.project_root_path
      if (typeof possible === 'string' && looksLikePath(possible)) return possible
    }
  }

  // Heuristic: scan small json files in directory
  try {
    const files = await fsp.readdir(projectDir)
    for (const f of files) {
      if (!f.endsWith('.json')) continue
      const p = path.join(projectDir, f)
      const stat = await fsp.stat(p)
      if (stat.size > 200_000) continue
      const json = await tryReadJson(p)
      if (!json) continue
      const keys = ['projectPath', 'path', 'cwd', 'root']
      for (const k of keys) {
        const v = json[k]
        if (typeof v === 'string' && looksLikePath(v)) return v
      }
    }
  } catch {}

  // Fallback to directory name.
  return path.basename(projectDir)
}

export type JsonlMeta = {
  cwd?: string
  title?: string
  summary?: string
  messageCount?: number
}

/** Parse session metadata from jsonl content (pure function for testing) */
export function parseSessionContent(content: string): JsonlMeta {
  const lines = content.split(/\r?\n/).filter(Boolean)
  let cwd: string | undefined
  let title: string | undefined
  let summary: string | undefined

  for (const line of lines) {
    let obj: any
    try {
      obj = JSON.parse(line)
    } catch {
      continue
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
        // Store up to 200 chars - UI truncates visually, tooltip shows full text
        title = extractTitleFromMessage(t, 200)
      }
    }

    if (!summary) {
      const s = obj?.summary || obj?.sessionSummary
      if (typeof s === 'string' && s.trim()) summary = s.trim().slice(0, 240)
    }

    if (cwd && title && summary) break
  }

  return {
    cwd,
    title,
    summary,
    messageCount: lines.length,
  }
}

export async function parseSessionJsonlMeta(filePath: string): Promise<JsonlMeta> {
  try {
    const stream = fs.createReadStream(filePath, { encoding: 'utf-8', highWaterMark: 256 * 1024 })
    let data = ''
    for await (const chunk of stream) {
      data += chunk
      if (data.length >= 256 * 1024) break
    }
    stream.close()

    return parseSessionContent(data)
  } catch {
    return {}
  }
}

function applyOverride(session: ClaudeSession, ov: SessionOverride | undefined): ClaudeSession | null {
  if (ov?.deleted) return null
  return {
    ...session,
    title: ov?.titleOverride || session.title,
    summary: ov?.summaryOverride || session.summary,
  }
}

export class ClaudeSessionIndexer {
  private claudeHome = defaultClaudeHome()
  private watcher: chokidar.FSWatcher | null = null
  private projects: ProjectGroup[] = []
  private onUpdateHandlers = new Set<(projects: ProjectGroup[]) => void>()
  private knownSessionIds = new Set<string>()
  private seenSessionIds = new Map<string, number>()
  private onNewSessionHandlers = new Set<(session: ClaudeSession) => void>()
  private initialized = false
  private sessionsById = new Map<string, ClaudeSession>()
  private projectsByPath = new Map<string, ProjectGroup>()
  private incrementalTimers = new Map<string, NodeJS.Timeout>()

  async start() {
    // Initial scan (populates knownSessionIds with existing sessions)
    await this.refresh()
    // Now enable onNewSession handlers for new sessions detected after startup
    this.initialized = true

    const projectsDir = path.join(this.claudeHome, 'projects')
    const sessionsGlob = path.join(projectsDir, '**', '*.jsonl')
    logger.info({ sessionsGlob }, 'Starting Claude sessions watcher')

    this.watcher = chokidar.watch(sessionsGlob, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 100 },
    })

    const scheduleUpsert = (filePath: string) => this.scheduleFileUpsert(filePath)
    const scheduleRemove = (filePath: string) => this.scheduleFileRemove(filePath)

    this.watcher.on('add', scheduleUpsert)
    this.watcher.on('change', scheduleUpsert)
    this.watcher.on('unlink', scheduleRemove)
    this.watcher.on('error', (err) => logger.warn({ err }, 'Claude watcher error'))
  }

  stop() {
    this.watcher?.close().catch(() => {})
    this.watcher = null
    for (const timer of this.incrementalTimers.values()) {
      clearTimeout(timer)
    }
    this.incrementalTimers.clear()
  }

  onUpdate(handler: (projects: ProjectGroup[]) => void): () => void {
    this.onUpdateHandlers.add(handler)
    return () => this.onUpdateHandlers.delete(handler)
  }

  onNewSession(handler: (session: ClaudeSession) => void): () => void {
    this.onNewSessionHandlers.add(handler)
    return () => this.onNewSessionHandlers.delete(handler)
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

  private detectNewSessions(sessions: ClaudeSession[]) {
    // Build set of current session IDs to prune stale entries (prevents memory leak)
    const currentIds = new Set(sessions.map(s => s.sessionId))

    // Prune knownSessionIds to only contain IDs that still exist
    for (const id of this.knownSessionIds) {
      if (!currentIds.has(id)) {
        this.knownSessionIds.delete(id)
      }
    }

    const now = Date.now()
    this.pruneSeenSessions(now)

    const newSessions: ClaudeSession[] = []
    for (const session of sessions) {
      // Skip sessions without cwd - can't associate them
      if (!session.cwd) continue

      const wasKnown = this.knownSessionIds.has(session.sessionId)
      if (!wasKnown) this.knownSessionIds.add(session.sessionId)

      const seenBefore = this.seenSessionIds.has(session.sessionId)
      this.seenSessionIds.set(session.sessionId, now)

      if (this.initialized && !wasKnown && !seenBefore) {
        newSessions.push(session)
      }
    }

    if (this.initialized && newSessions.length > 0) {
      newSessions.sort((a, b) => {
        const diff = a.updatedAt - b.updatedAt
        return diff !== 0 ? diff : a.sessionId.localeCompare(b.sessionId)
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

  getProjects(): ProjectGroup[] {
    return this.projects
  }

  private scheduleFileUpsert(filePath: string) {
    const existing = this.incrementalTimers.get(filePath)
    if (existing) clearTimeout(existing)
    this.incrementalTimers.set(
      filePath,
      setTimeout(() => {
        this.incrementalTimers.delete(filePath)
        this.upsertSessionFromFile(filePath).catch((err) =>
          logger.warn({ err, filePath }, 'Incremental session update failed')
        )
      }, INCREMENTAL_DEBOUNCE_MS)
    )
  }

  private scheduleFileRemove(filePath: string) {
    const existing = this.incrementalTimers.get(filePath)
    if (existing) clearTimeout(existing)
    this.incrementalTimers.set(
      filePath,
      setTimeout(() => {
        this.incrementalTimers.delete(filePath)
        const sessionId = path.basename(filePath, '.jsonl')
        if (this.removeSession(sessionId)) {
          this.rebuildProjects()
        }
      }, INCREMENTAL_DEBOUNCE_MS)
    )
  }

  private removeSession(sessionId: string): boolean {
    const existing = this.sessionsById.get(sessionId)
    if (!existing) return false

    this.sessionsById.delete(sessionId)
    this.removeSessionFromProject(existing.sessionId, existing.projectPath)
    return true
  }

  private removeSessionFromProject(sessionId: string, projectPath: string) {
    const group = this.projectsByPath.get(projectPath)
    if (!group) return
    group.sessions = group.sessions.filter((s) => s.sessionId !== sessionId)
    if (group.sessions.length === 0) {
      this.projectsByPath.delete(projectPath)
    }
  }

  private applySessionUpdate(session: ClaudeSession, projectColor?: string) {
    const existing = this.sessionsById.get(session.sessionId)
    if (existing && existing.projectPath !== session.projectPath) {
      this.removeSessionFromProject(existing.sessionId, existing.projectPath)
    }

    this.sessionsById.set(session.sessionId, session)

    let group = this.projectsByPath.get(session.projectPath)
    if (!group) {
      group = {
        projectPath: session.projectPath,
        sessions: [],
        color: projectColor,
      }
      this.projectsByPath.set(session.projectPath, group)
    }

    group.color = projectColor

    const idx = group.sessions.findIndex((s) => s.sessionId === session.sessionId)
    if (idx >= 0) {
      group.sessions[idx] = session
    } else {
      group.sessions.push(session)
    }
  }

  private rebuildProjects() {
    const groups = Array.from(this.projectsByPath.values()).filter((g) => g.sessions.length > 0)

    for (const group of groups) {
      group.sessions.sort((a, b) => b.updatedAt - a.updatedAt)
    }

    groups.sort((a, b) => (b.sessions[0]?.updatedAt || 0) - (a.sessions[0]?.updatedAt || 0))

    const allSessions = groups.flatMap((g) => g.sessions)
    this.detectNewSessions(allSessions)

    this.projects = groups
    this.emitUpdate()
  }

  private async upsertSessionFromFile(filePath: string) {
    const sessionId = path.basename(filePath, '.jsonl')
    let stat: any
    try {
      stat = await fsp.stat(filePath)
    } catch {
      if (this.removeSession(sessionId)) {
        this.rebuildProjects()
      }
      return
    }

    const meta = await parseSessionJsonlMeta(filePath)
    if (!meta.cwd) {
      if (this.removeSession(sessionId)) {
        this.rebuildProjects()
      }
      return
    }

    const projectDir = path.dirname(filePath)
    const projectPath = await resolveProjectPath(projectDir)

    const cfg = await configStore.snapshot()
    const colors = await configStore.getProjectColors()

    const baseSession: ClaudeSession = {
      sessionId,
      projectPath,
      updatedAt: stat.mtimeMs || stat.mtime.getTime(),
      messageCount: meta.messageCount,
      title: meta.title,
      summary: meta.summary,
      cwd: meta.cwd,
    }

    const ov = cfg.sessionOverrides?.[sessionId]
    const merged = applyOverride(baseSession, ov)
    if (!merged) {
      if (this.removeSession(sessionId)) {
        this.rebuildProjects()
      }
      return
    }

    this.applySessionUpdate(merged, colors[projectPath])
    this.rebuildProjects()
  }

  async refresh() {
    const projectsDir = path.join(this.claudeHome, 'projects')
    const colors = await configStore.getProjectColors()
    const cfg = await configStore.snapshot()

    const groups: ProjectGroup[] = []
    let projectDirs: string[] = []
    try {
      projectDirs = (await fsp.readdir(projectsDir)).map((name) => path.join(projectsDir, name))
    } catch (err: any) {
      logger.warn({ err, projectsDir }, 'Could not read Claude projects directory')
      this.projects = []
      this.sessionsById.clear()
      this.projectsByPath.clear()
      this.emitUpdate()
      return
    }

    for (const projectDir of projectDirs) {
      // Check if this is a directory (skip files at project root level)
      let dirStat: any
      try {
        dirStat = await fsp.stat(projectDir)
        if (!dirStat.isDirectory()) continue
      } catch {
        continue
      }

      // Look for .jsonl files directly in the project directory
      let files: string[] = []
      try {
        files = (await fsp.readdir(projectDir)).filter((f) => f.endsWith('.jsonl'))
      } catch {
        continue
      }

      const projectPath = await resolveProjectPath(projectDir)

      const sessions: ClaudeSession[] = []
      for (const file of files) {
        const full = path.join(projectDir, file)
        let stat: any
        try {
          stat = await fsp.stat(full)
        } catch {
          continue
        }
        const sessionId = path.basename(file, '.jsonl')
        const meta = await parseSessionJsonlMeta(full)

        // Skip orphaned sessions (no conversation events, just snapshots)
        if (!meta.cwd) continue

        const baseSession: ClaudeSession = {
          sessionId,
          projectPath,
          updatedAt: stat.mtimeMs || stat.mtime.getTime(),
          messageCount: meta.messageCount,
          title: meta.title,
          summary: meta.summary,
          cwd: meta.cwd,
        }

        const ov = cfg.sessionOverrides?.[sessionId]
        const merged = applyOverride(baseSession, ov)
        if (merged) sessions.push(merged)
      }

      if (sessions.length === 0) continue

      groups.push({
        projectPath,
        color: colors[projectPath],
        sessions: sessions.sort((a, b) => b.updatedAt - a.updatedAt),
      })
    }

    // Sort projects by most recent session activity.
    groups.sort((a, b) => (b.sessions[0]?.updatedAt || 0) - (a.sessions[0]?.updatedAt || 0))

    const allSessions = groups.flatMap((g) => g.sessions)
    this.detectNewSessions(allSessions)

    this.sessionsById.clear()
    this.projectsByPath.clear()
    for (const group of groups) {
      this.projectsByPath.set(group.projectPath, group)
      for (const session of group.sessions) {
        this.sessionsById.set(session.sessionId, session)
      }
    }

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

export const claudeIndexer = new ClaudeSessionIndexer()
