import os from 'os'
import path from 'path'

export function getFreshellHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.FRESHELL_HOME?.trim()
  if (override) return path.resolve(override)
  return os.homedir()
}

/**
 * The Freshell config dir (~/.freshell by default).
 *
 * Resolution order:
 *   1. FRESHELL_CONFIG_DIR — explicit full override. This is how the Electron
 *      app's named profiles (`~/.freshell-<id>`) and the daemon service
 *      templates pin state; FRESHELL_HOME cannot express those paths because
 *      it is the PARENT of '.freshell'.
 *   2. FRESHELL_HOME (or the OS homedir) + '/.freshell'.
 */
export function getFreshellConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const configOverride = env.FRESHELL_CONFIG_DIR?.trim()
  if (configOverride) return path.resolve(configOverride)
  return path.join(getFreshellHomeDir(env), '.freshell')
}
