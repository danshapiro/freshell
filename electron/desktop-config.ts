import fsp from 'fs/promises'
import os from 'os'
import path from 'path'
import { z } from 'zod'
import { DesktopConfigSchema, type DesktopConfig } from './types.js'

const DESKTOP_CONFIG_FILENAME = 'desktop.json'
const LEGACY_SERVER_MODE = 'daemon'

function getConfigPath(): string {
  return path.join(os.homedir(), '.freshell', DESKTOP_CONFIG_FILENAME)
}

function getConfigDir(): string {
  return path.join(os.homedir(), '.freshell')
}

export function getDefaultDesktopConfig(): DesktopConfig {
  return {
    serverMode: 'app-bound',
    port: 3001,
    knownServers: [],
    alwaysAskOnLaunch: false,
    globalHotkey: 'CommandOrControl+`',
    startOnLogin: false,
    minimizeToTray: true,
    setupCompleted: false,
  }
}

export async function readDesktopConfig(): Promise<DesktopConfig | null> {
  const configPath = getConfigPath()
  try {
    const content = await fsp.readFile(configPath, 'utf-8')
    const parsed = JSON.parse(content)
    const migrated = migratePersistedConfig(parsed)
    const result = DesktopConfigSchema.safeParse(migrated.config)
    if (!result.success) {
      return null
    }

    if (migrated.changed) {
      // Preserve fields introduced by newer/older desktop clients while
      // changing only the retired mode. The schema result above still gives
      // callers the validated current shape and defaults.
      await writeDesktopConfig(migrated.config as DesktopConfig)
      console.info(JSON.stringify({
        severity: 'info',
        component: 'electron-desktop-config',
        event: 'desktop_config_migrated',
        from: 'daemon',
        to: 'app-bound',
      }))
    }

    return result.data
  } catch {
    return null
  }
}

const PersistedConfigSchema = z.object({
  serverMode: z.enum([
    LEGACY_SERVER_MODE,
    'app-bound',
    'remote',
  ]),
}).passthrough()

function migratePersistedConfig(value: unknown): { config: unknown; changed: boolean } {
  const persisted = PersistedConfigSchema.safeParse(value)
  if (!persisted.success || persisted.data.serverMode !== LEGACY_SERVER_MODE) {
    return { config: value, changed: false }
  }

  return {
    config: { ...persisted.data, serverMode: 'app-bound' },
    changed: true,
  }
}

export async function writeDesktopConfig(config: DesktopConfig): Promise<void> {
  const configDir = getConfigDir()
  await fsp.mkdir(configDir, { recursive: true })

  const configPath = getConfigPath()
  const tmpPath = configPath + '.tmp'
  await fsp.writeFile(tmpPath, JSON.stringify(config, null, 2))
  await fsp.rename(tmpPath, configPath)
}

// Simple mutex for serializing config patches
let mutexChain: Promise<void> = Promise.resolve()

export async function patchDesktopConfig(patch: Partial<DesktopConfig>): Promise<DesktopConfig> {
  let result: DesktopConfig

  // Chain onto the existing mutex so concurrent calls run sequentially
  const work = mutexChain.then(async () => {
    const existing = await readDesktopConfig()
    const base = existing ?? getDefaultDesktopConfig()
    const merged = { ...base, ...patch }
    const validated = DesktopConfigSchema.parse(merged)
    await writeDesktopConfig(validated)
    result = validated
  })

  // Update the chain -- subsequent calls wait for this one to finish
  mutexChain = work.catch(() => {})

  await work
  return result!
}

/**
 * Reset the internal mutex chain. Only for use in tests to ensure
 * inter-test isolation -- the module-level mutexChain holds references
 * from prior calls, which can leak state between test files.
 */
export function _resetMutexForTesting(): void {
  mutexChain = Promise.resolve()
}
