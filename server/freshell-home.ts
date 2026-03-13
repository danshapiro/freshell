import os from 'os'
import path from 'path'

export function getFreshellHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.FRESHELL_HOME?.trim()
  if (override) return path.resolve(override)
  return os.homedir()
}

export function getFreshellConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(getFreshellHomeDir(env), '.freshell')
}
