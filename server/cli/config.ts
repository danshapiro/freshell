import fs from 'fs'
import path from 'path'
import os from 'os'

type CliConfig = { url: string; token?: string }

type CliConfigFile = { url?: string; token?: string }

function loadConfigFile(): CliConfigFile {
  const file = path.join(os.homedir(), '.freshell', 'cli.json')
  if (!fs.existsSync(file)) return {}
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as CliConfigFile
    return { url: raw.url, token: raw.token }
  } catch {
    return {}
  }
}

export function resolveConfig(): CliConfig {
  const file = loadConfigFile()
  const envUrl = process.env.FRESHELL_URL
  const envToken = process.env.FRESHELL_TOKEN

  return {
    url: envUrl || file.url || 'http://localhost:3001',
    token: envToken || file.token,
  }
}
