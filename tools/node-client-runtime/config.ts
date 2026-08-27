import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export type ClientConfig = { url: string; token?: string }
type ClientConfigFile = { url?: string; token?: string }

function loadConfigFile(): ClientConfigFile {
  const home = process.env.FRESHELL_HOME || path.join(os.homedir(), '.freshell')
  const file = path.join(home, 'cli.json')
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
