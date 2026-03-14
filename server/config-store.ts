import fsp from 'fs/promises'
import path from 'path'
import { logger } from './logger.js'
import { getFreshellConfigDir } from './freshell-home.js'
import {
  createDefaultServerSettings,
  extractLegacyLocalSettingsSeed,
  mergeLocalSettings,
  mergeServerSettings,
  stripLocalSettings,
  type LocalSettingsPatch,
  type ServerSettings,
  type ServerSettingsPatch,
} from '../shared/settings.js'

/**
 * Simple promise-based mutex to serialize write operations.
 * Prevents TOCTOU race conditions in read-modify-write cycles.
 */
class Mutex {
  private queue: Promise<void> = Promise.resolve()

  async acquire<T>(fn: () => Promise<T>): Promise<T> {
    const release = this.queue
    let resolve: () => void
    this.queue = new Promise((r) => (resolve = r))
    await release
    try {
      return await fn()
    } finally {
      resolve!()
    }
  }
}

export type AppSettings = ServerSettings
export type AppSettingsPatch = ServerSettingsPatch

export type SessionOverride = {
  titleOverride?: string
  summaryOverride?: string
  deleted?: boolean
  archived?: boolean
  createdAtOverride?: number
}

export type TerminalOverride = {
  titleOverride?: string
  descriptionOverride?: string
  deleted?: boolean
}

export type UserConfig = {
  version: 1
  settings: AppSettings
  legacyLocalSettingsSeed?: LocalSettingsPatch
  sessionOverrides: Record<string, SessionOverride>
  terminalOverrides: Record<string, TerminalOverride>
  projectColors: Record<string, string>
  recentDirectories?: string[]
}

export function resolveDefaultLoggingDebug(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV !== 'production'
}

export const defaultSettings: AppSettings = createDefaultServerSettings({
  loggingDebug: resolveDefaultLoggingDebug(),
})

function configDir(): string {
  return getFreshellConfigDir()
}

function configPath(): string {
  return path.join(configDir(), 'config.json')
}

function backupPath(): string {
  return path.join(configDir(), 'config.backup.json')
}

export type ConfigReadError = 'ENOENT' | 'PARSE_ERROR' | 'VERSION_MISMATCH' | 'READ_ERROR'

const CONFIG_TMP_PREFIX = 'config.json.tmp-'
const DEFAULT_CONFIG_TMP_MAX_AGE_MS = 24 * 60 * 60 * 1000
let cleanupPromise: Promise<void> | null = null
let cleanupDir: string | null = null

async function ensureDir() {
  await fsp.mkdir(configDir(), { recursive: true })
}

const RENAME_RETRY_DELAYS_MS = [10, 25, 50, 100, 200]

function isRetryableRenameError(err: unknown): err is NodeJS.ErrnoException {
  if (!err || typeof err !== 'object') return false
  const code = (err as NodeJS.ErrnoException).code
  return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY' || code === 'ENOENT'
}

async function delay(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function renameWithRetry(tmpPath: string, filePath: string) {
  for (let attempt = 0; attempt <= RENAME_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      await fsp.rename(tmpPath, filePath)
      return
    } catch (err) {
      if (!isRetryableRenameError(err) || attempt === RENAME_RETRY_DELAYS_MS.length) {
        throw err
      }
      await delay(RENAME_RETRY_DELAYS_MS[attempt])
    }
  }
}

async function cleanupStaleConfigTmpFiles(options: { directory?: string; maxAgeMs?: number } = {}) {
  const directory = options.directory ?? configDir()
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_CONFIG_TMP_MAX_AGE_MS
  let entries: string[]
  try {
    entries = await fsp.readdir(directory)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
    logger.warn({ event: 'config_tmp_cleanup_error', directory, err }, 'Failed to read config directory for temp cleanup')
    return
  }

  const now = Date.now()
  let removed = 0
  let failed = 0
  const errors: Array<{ file: string; code?: string; message: string }> = []

  for (const entry of entries) {
    if (!entry.startsWith(CONFIG_TMP_PREFIX)) continue
    const filePath = path.join(directory, entry)
    try {
      const stat = await fsp.stat(filePath)
      if (!stat.isFile()) continue
      if (now - stat.mtimeMs <= maxAgeMs) continue
      await fsp.rm(filePath, { force: true })
      removed += 1
    } catch (err) {
      failed += 1
      if (errors.length < 5) {
        errors.push({
          file: entry,
          code: (err as NodeJS.ErrnoException).code,
          message: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }

  if (removed === 0 && failed === 0) return

  const payload = {
    event: 'config_tmp_cleanup',
    directory,
    removed,
    failed,
    maxAgeMs,
    errors: errors.length > 0 ? errors : undefined,
  }

  if (failed > 0) {
    logger.warn(payload, 'Config temp cleanup completed with errors')
    return
  }

  logger.info(payload, 'Config temp cleanup completed')
}

function ensureConfigTmpCleanup(): Promise<void> {
  const directory = configDir()
  if (cleanupPromise && cleanupDir === directory) return cleanupPromise
  cleanupDir = directory
  cleanupPromise = cleanupStaleConfigTmpFiles({ directory }).catch((err) => {
    logger.warn({ event: 'config_tmp_cleanup_error', directory, err }, 'Config temp cleanup failed')
  })
  return cleanupPromise
}

async function atomicWriteFile(filePath: string, data: string) {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`
  await fsp.writeFile(tmp, data, 'utf-8')
  try {
    await renameWithRetry(tmp, filePath)
  } catch (err) {
    if (isRetryableRenameError(err)) {
      logger.warn({ err, filePath }, 'Atomic rename failed; falling back to direct write')
      await fsp.writeFile(filePath, data, 'utf-8')
      return
    }
    throw err
  } finally {
    await fsp.rm(tmp, { force: true })
  }
}

function logConfigFallback(error: ConfigReadError, details: { err?: unknown; filePath: string; foundVersion?: unknown }) {
  const backupFile = backupPath()
  if (error === 'PARSE_ERROR') {
    logger.error(
      { err: details.err, filePath: details.filePath, event: 'config_parse_error' },
      'Config file parse failed; falling back to defaults'
    )
  } else if (error === 'VERSION_MISMATCH') {
    logger.error(
      {
        filePath: details.filePath,
        event: 'config_version_mismatch',
        found: details.foundVersion,
      },
      'Config file version mismatch; falling back to defaults'
    )
  } else if (error === 'READ_ERROR') {
    logger.error(
      { err: details.err, filePath: details.filePath, event: 'config_read_error' },
      'Config file read failed; falling back to defaults'
    )
  }
  logger.warn(
    { backupPath: backupFile, error },
    'Config fallback in effect; restore backup with: mv ~/.freshell/config.backup.json ~/.freshell/config.json'
  )
}

async function readConfigFile(): Promise<{ config: UserConfig | null; error?: ConfigReadError }> {
  const filePath = configPath()
  try {
    const raw = await fsp.readFile(filePath, 'utf-8')
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      logConfigFallback('PARSE_ERROR', { err, filePath })
      return { config: null, error: 'PARSE_ERROR' }
    }

    if ((parsed as UserConfig)?.version !== 1) {
      logConfigFallback('VERSION_MISMATCH', {
        filePath,
        foundVersion: (parsed as { version?: unknown })?.version,
      })
      return { config: null, error: 'VERSION_MISMATCH' }
    }

    return { config: parsed as UserConfig }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { config: null }
    }
    logConfigFallback('READ_ERROR', { err, filePath })
    return { config: null, error: 'READ_ERROR' }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function migrateLegacyFreshClaudeSettings(rawSettings: Record<string, unknown>): Record<string, unknown> {
  if (!isRecord(rawSettings.freshclaude)) {
    return rawSettings
  }

  const migrated = { ...rawSettings }
  const existingAgentChat = isRecord(migrated.agentChat) ? { ...migrated.agentChat } : {}
  const existingProviders = isRecord(existingAgentChat.providers) ? { ...existingAgentChat.providers } : {}

  existingProviders.freshclaude = {
    ...rawSettings.freshclaude,
    ...(isRecord(existingProviders.freshclaude) ? existingProviders.freshclaude : {}),
  }

  existingAgentChat.providers = existingProviders
  migrated.agentChat = existingAgentChat
  delete migrated.freshclaude

  return migrated
}

export class ConfigStore {
  private cache: UserConfig | null = null
  private writeMutex = new Mutex()
  private lastReadError?: ConfigReadError

  getLastReadError(): ConfigReadError | undefined {
    return this.lastReadError
  }

  async backupExists(): Promise<boolean> {
    try {
      await fsp.access(backupPath())
      return true
    } catch {
      return false
    }
  }

  private async loadInternal(options: { persistNormalizedConfig: boolean }): Promise<UserConfig> {
    if (this.cache) return this.cache
    await ensureConfigTmpCleanup()
    const { config: existing, error } = await readConfigFile()
    this.lastReadError = error
    if (existing) {
      this.lastReadError = undefined
      const rawSettings = migrateLegacyFreshClaudeSettings(
        isRecord(existing.settings) ? { ...existing.settings } : {},
      )
      const extractedLegacyLocalSettingsSeed = extractLegacyLocalSettingsSeed(rawSettings)
      const storedLegacyLocalSettingsSeed = isRecord(existing.legacyLocalSettingsSeed)
        ? extractLegacyLocalSettingsSeed(existing.legacyLocalSettingsSeed)
        : undefined
      const legacyLocalSettingsSeed = storedLegacyLocalSettingsSeed
        ? mergeLocalSettings(extractedLegacyLocalSettingsSeed, storedLegacyLocalSettingsSeed)
        : extractedLegacyLocalSettingsSeed
      const settings = mergeServerSettings(
        createDefaultServerSettings({ loggingDebug: resolveDefaultLoggingDebug(process.env) }),
        stripLocalSettings(rawSettings) as AppSettingsPatch,
      )
      const normalized: UserConfig = {
        ...existing,
        settings,
        legacyLocalSettingsSeed,
        sessionOverrides: existing.sessionOverrides || {},
        terminalOverrides: existing.terminalOverrides || {},
        projectColors: existing.projectColors || {},
        recentDirectories: Array.isArray(existing.recentDirectories)
          ? existing.recentDirectories.filter((dir) => typeof dir === 'string' && dir.trim().length > 0)
          : [],
      }

      const shouldPersistNormalizedConfig =
        JSON.stringify(existing.settings) !== JSON.stringify(settings)
        || JSON.stringify(existing.legacyLocalSettingsSeed) !== JSON.stringify(legacyLocalSettingsSeed)
      this.cache = normalized
      if (options.persistNormalizedConfig && shouldPersistNormalizedConfig) {
        try {
          await this.saveInternal(normalized)
        } catch (err) {
          logger.warn(
            { err, event: 'config_normalize_persist_failed', filePath: configPath() },
            'Failed to persist normalized config; using in-memory normalized config'
          )
        }
      }

      return this.cache ?? normalized
    }

    // Initial config file creation - no mutex needed here since:
    // 1. atomicWriteFile is already safe against concurrent writes
    // 2. This path only runs when no config exists (rare)
    // 3. Using mutex here would cause deadlock when called from patchSettings() etc.
    await ensureDir()
    this.cache = {
      version: 1,
      settings: defaultSettings,
      legacyLocalSettingsSeed: undefined,
      sessionOverrides: {},
      terminalOverrides: {},
      projectColors: {},
      recentDirectories: [],
    }
    await this.saveInternal(this.cache)
    return this.cache
  }

  async load(): Promise<UserConfig> {
    if (this.cache) return this.cache
    return this.writeMutex.acquire(async () => {
      if (this.cache) return this.cache
      return this.loadInternal({ persistNormalizedConfig: true })
    })
  }

  private async loadForWrite(): Promise<UserConfig> {
    if (this.cache) return this.cache
    return this.loadInternal({ persistNormalizedConfig: false })
  }

  async save(cfg: UserConfig) {
    await this.writeMutex.acquire(async () => {
      await this.saveInternal(cfg)
    })
  }

  /**
   * Internal save method - must only be called when mutex is already held
   * or during initial config creation in load()
   */
  private async saveInternal(cfg: UserConfig) {
    await ensureDir()
    await atomicWriteFile(configPath(), JSON.stringify(cfg, null, 2))
    try {
      await fsp.copyFile(configPath(), backupPath())
    } catch (err) {
      logger.warn({ err, event: 'config_backup_failed' }, 'Failed to write config backup')
    }
    this.cache = cfg
  }

  async getSettings(): Promise<AppSettings> {
    const cfg = await this.load()
    return cfg.settings
  }

  async getLegacyLocalSettingsSeed(): Promise<LocalSettingsPatch | undefined> {
    const cfg = await this.load()
    return cfg.legacyLocalSettingsSeed
  }

  async patchSettings(patch: AppSettingsPatch): Promise<AppSettings> {
    return this.writeMutex.acquire(async () => {
      const cfg = await this.loadForWrite()
      const updated: UserConfig = {
        ...cfg,
        settings: mergeServerSettings(cfg.settings, patch),
      }
      await this.saveInternal(updated)
      return updated.settings
    })
  }

  async getSessionOverride(sessionId: string): Promise<SessionOverride | undefined> {
    const cfg = await this.load()
    return cfg.sessionOverrides[sessionId]
  }

  async patchSessionOverride(sessionId: string, patch: SessionOverride): Promise<SessionOverride> {
    return this.writeMutex.acquire(async () => {
      const cfg = await this.loadForWrite()
      const existing = cfg.sessionOverrides[sessionId] || {}
      const next = { ...existing, ...patch }
      const updated: UserConfig = {
        ...cfg,
        sessionOverrides: { ...cfg.sessionOverrides, [sessionId]: next },
      }
      await this.saveInternal(updated)
      return next
    })
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.patchSessionOverride(sessionId, { deleted: true })
  }

  async getTerminalOverride(terminalId: string): Promise<TerminalOverride | undefined> {
    const cfg = await this.load()
    return cfg.terminalOverrides[terminalId]
  }

  async patchTerminalOverride(terminalId: string, patch: TerminalOverride): Promise<TerminalOverride> {
    return this.writeMutex.acquire(async () => {
      const cfg = await this.loadForWrite()
      const existing = cfg.terminalOverrides[terminalId] || {}
      const next = { ...existing, ...patch }
      const updated: UserConfig = {
        ...cfg,
        terminalOverrides: { ...cfg.terminalOverrides, [terminalId]: next },
      }
      await this.saveInternal(updated)
      return next
    })
  }

  async deleteTerminal(terminalId: string): Promise<void> {
    await this.patchTerminalOverride(terminalId, { deleted: true })
  }

  async setProjectColor(projectPath: string, color: string): Promise<void> {
    return this.writeMutex.acquire(async () => {
      const cfg = await this.loadForWrite()
      const updated: UserConfig = {
        ...cfg,
        projectColors: { ...cfg.projectColors, [projectPath]: color },
      }
      await this.saveInternal(updated)
    })
  }

  async getProjectColors(): Promise<Record<string, string>> {
    const cfg = await this.load()
    return cfg.projectColors || {}
  }

  async pushRecentDirectory(dir: string): Promise<string[]> {
    const trimmed = typeof dir === 'string' ? dir.trim() : ''
    if (!trimmed) {
      const cfg = await this.load()
      return cfg.recentDirectories || []
    }

    return this.writeMutex.acquire(async () => {
      const cfg = await this.loadForWrite()
      const existing = cfg.recentDirectories || []
      const next = [trimmed, ...existing.filter((value) => value !== trimmed)].slice(0, 20)
      const updated: UserConfig = {
        ...cfg,
        recentDirectories: next,
      }
      await this.saveInternal(updated)
      return next
    })
  }

  async snapshot(): Promise<UserConfig> {
    return await this.load()
  }
}

export const configStore = new ConfigStore()

// Quick integrity log in dev
if (process.env.NODE_ENV !== 'production' && process.env.NODE_ENV !== 'test') {
  configStore.load().then((cfg) => logger.debug({ configPath: configPath() }, 'Loaded config'))
}
