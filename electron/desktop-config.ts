import fsp from 'fs/promises'
import os from 'os'
import path from 'path'
import { DesktopConfigSchema, type DesktopConfig } from './types.js'

const DESKTOP_CONFIG_FILENAME = 'desktop.json'

function defaultConfigDir(): string {
  return path.join(os.homedir(), '.freshell')
}

function resolveConfigDir(configDir?: string): string {
  return configDir ?? defaultConfigDir()
}

function getConfigPath(configDir?: string): string {
  return path.join(resolveConfigDir(configDir), DESKTOP_CONFIG_FILENAME)
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

export async function readDesktopConfig(configDir?: string): Promise<DesktopConfig | null> {
  const configPath = getConfigPath(configDir)
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

export async function writeDesktopConfig(config: DesktopConfig, configDir?: string): Promise<void> {
  const dir = resolveConfigDir(configDir)
  await fsp.mkdir(dir, { recursive: true })

  const configPath = getConfigPath(dir)
  const tmpPath = configPath + '.tmp'
  await fsp.writeFile(tmpPath, JSON.stringify(config, null, 2))
  await fsp.rename(tmpPath, configPath)
}

// Per-directory mutex chains so two profiles' writes never serialize against
// each other while writes on the SAME directory stay ordered.
const mutexChains = new Map<string, Promise<void>>()

export async function patchDesktopConfig(
  patch: Partial<DesktopConfig>,
  configDir?: string,
): Promise<DesktopConfig> {
  const dir = resolveConfigDir(configDir)
  let result: DesktopConfig

  // Chain onto the existing mutex for THIS directory so concurrent calls on
  // the same dir run sequentially.
  const work = (mutexChains.get(dir) ?? Promise.resolve()).then(async () => {
    const existing = await readDesktopConfig(dir)
    const base = existing ?? getDefaultDesktopConfig()
    const merged = { ...base, ...patch }
    const validated = DesktopConfigSchema.parse(merged)
    await writeDesktopConfig(validated, dir)
    result = validated
  })

  // Update the chain — subsequent calls wait for this one to finish.
  mutexChains.set(dir, work.catch(() => {}))

  await work
  return result!
}

/**
 * Reset the internal mutex chains. Only for use in tests to ensure
 * inter-test isolation — the module-level mutex map holds references from
 * prior calls, which can leak state between test files.
 */
export function _resetMutexForTesting(): void {
  mutexChains.clear()
}
