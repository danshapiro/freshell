import os from 'node:os'
import path from 'node:path'

/** Environment shape needed by the filesystem-neutral configuration helpers. */
export type FreshellEnvironment = Readonly<Record<string, string | undefined>>

/** Resolve Freshell's home directory, honoring the explicit test/deployment override. */
export function getFreshellHomeDir(env: FreshellEnvironment = process.env): string {
  const override = env.FRESHELL_HOME?.trim()
  if (override) return path.resolve(override)
  return os.homedir()
}

/** Resolve the directory containing Freshell's persisted configuration. */
export function getFreshellConfigDir(env: FreshellEnvironment = process.env): string {
  return path.join(getFreshellHomeDir(env), '.freshell')
}
