import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export type ClientConfig = { url: string; token?: string }
type ClientConfigFile = { url?: string; token?: string }

function loadConfigFile(): ClientConfigFile {
  // FRESHELL_HOME names the user's home directory. Keep the same layout as
  // the server-side config: <FRESHELL_HOME>/.freshell/cli.json.
  const configuredHome = process.env.FRESHELL_HOME?.trim()
  const home = configuredHome ? path.resolve(configuredHome) : os.homedir()
  const file = path.join(home, '.freshell', 'cli.json')
  if (!fs.existsSync(file)) return {}
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as ClientConfigFile
    return { url: raw.url, token: raw.token }
  } catch {
    return {}
  }
}

/** Resolve the common standalone-client endpoint without starting a server. */
export function resolveClientConfig(): ClientConfig {
  const file = loadConfigFile()
  return {
    url: process.env.FRESHELL_URL || file.url || 'http://localhost:3001',
    token: process.env.FRESHELL_TOKEN || file.token,
  }
}
