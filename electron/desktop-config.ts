import fsp from 'fs/promises'
import os from 'os'
import path from 'path'
import { DesktopConfigSchema, type DesktopConfig } from './types.js'

const DESKTOP_CONFIG_FILENAME = 'desktop.json'

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
    const result = DesktopConfigSchema.safeParse(parsed)
    if (!result.success) {
      return null
    }
    return result.data
  } catch {
    return null
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
