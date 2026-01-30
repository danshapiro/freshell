import fsp from 'fs/promises'
import path from 'path'
import os from 'os'
import { logger } from './logger'

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

export type AppSettings = {
  theme: 'system' | 'light' | 'dark'
  terminal: {
    fontSize: number
    fontFamily: string
    lineHeight: number
    cursorBlink: boolean
    scrollback: number
    theme: 'default' | 'dark' | 'light'
  }
  defaultCwd?: string
  safety: {
    autoKillIdleMinutes: number
    warnBeforeKillMinutes: number
  }
}

export type SessionOverride = {
  titleOverride?: string
  summaryOverride?: string
  deleted?: boolean
}

export type TerminalOverride = {
  titleOverride?: string
  descriptionOverride?: string
  deleted?: boolean
}

export type UserConfig = {
  version: 1
  settings: AppSettings
  sessionOverrides: Record<string, SessionOverride>
  terminalOverrides: Record<string, TerminalOverride>
  projectColors: Record<string, string>
}

export const defaultSettings: AppSettings = {
  theme: 'system',
  terminal: {
    fontSize: 12,
    fontFamily: 'Consolas',
    lineHeight: 1,
    cursorBlink: true,
    scrollback: 5000,
    theme: 'default',
  },
  defaultCwd: undefined,
  safety: {
    autoKillIdleMinutes: 180,
    warnBeforeKillMinutes: 5,
  },
}

function configDir(): string {
  return path.join(os.homedir(), '.freshell')
}

function configPath(): string {
  return path.join(configDir(), 'config.json')
}

async function ensureDir() {
  await fsp.mkdir(configDir(), { recursive: true })
}

async function atomicWriteFile(filePath: string, data: string) {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`
  await fsp.writeFile(tmp, data, 'utf-8')
  await fsp.rename(tmp, filePath)
}

async function readConfigFile(): Promise<UserConfig | null> {
  try {
    const raw = await fsp.readFile(configPath(), 'utf-8')
    const parsed = JSON.parse(raw)
    if (parsed?.version !== 1) return null
    return parsed as UserConfig
  } catch {
    return null
  }
}

function mergeSettings(base: AppSettings, patch: Partial<AppSettings>): AppSettings {
  return {
    ...base,
    ...patch,
    terminal: { ...base.terminal, ...(patch.terminal || {}) },
    safety: { ...base.safety, ...(patch.safety || {}) },
  }
}

export class ConfigStore {
  private cache: UserConfig | null = null
  private writeMutex = new Mutex()

  async load(): Promise<UserConfig> {
    if (this.cache) return this.cache
    const existing = await readConfigFile()
    if (existing) {
      this.cache = {
        ...existing,
        settings: mergeSettings(defaultSettings, existing.settings || {}),
        sessionOverrides: existing.sessionOverrides || {},
        terminalOverrides: existing.terminalOverrides || {},
        projectColors: existing.projectColors || {},
      }
      return this.cache
    }

    // Initial config file creation - no mutex needed here since:
    // 1. atomicWriteFile is already safe against concurrent writes
    // 2. This path only runs when no config exists (rare)
    // 3. Using mutex here would cause deadlock when called from patchSettings() etc.
    await ensureDir()
    this.cache = {
      version: 1,
      settings: defaultSettings,
      sessionOverrides: {},
      terminalOverrides: {},
      projectColors: {},
    }
    await this.saveInternal(this.cache)
    return this.cache
  }

  async save(cfg: UserConfig) {
    await ensureDir()
    await atomicWriteFile(configPath(), JSON.stringify(cfg, null, 2))
    this.cache = cfg
  }

  /**
   * Internal save method - must only be called when mutex is already held
   * or during initial config creation in load()
   */
  private async saveInternal(cfg: UserConfig) {
    await ensureDir()
    await atomicWriteFile(configPath(), JSON.stringify(cfg, null, 2))
    this.cache = cfg
  }

  async getSettings(): Promise<AppSettings> {
    const cfg = await this.load()
    return cfg.settings
  }

  async patchSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
    return this.writeMutex.acquire(async () => {
      const cfg = await this.load()
      const updated: UserConfig = {
        ...cfg,
        settings: mergeSettings(cfg.settings, patch),
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
      const cfg = await this.load()
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
      const cfg = await this.load()
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
      const cfg = await this.load()
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

  async snapshot(): Promise<UserConfig> {
    return await this.load()
  }
}

export const configStore = new ConfigStore()

// Quick integrity log in dev
if (process.env.NODE_ENV !== 'production') {
  configStore.load().then((cfg) => logger.debug({ configPath: configPath() }, 'Loaded config'))
}
