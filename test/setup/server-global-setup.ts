import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const PROJECT_ROOT = path.resolve(__dirname, '../..')

interface EnsureBuiltServerEntryDeps {
  existsSync: (path: string) => boolean
  execFileSync: typeof execFileSync
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
}

export function ensureBuiltServerEntry(
  projectRoot: string,
  deps: EnsureBuiltServerEntryDeps = {
    existsSync: fs.existsSync,
    execFileSync,
    env: process.env,
    platform: process.platform,
  },
): void {
  const serverEntry = path.join(projectRoot, 'dist', 'server', 'index.js')
  if (deps.existsSync(serverEntry)) {
    return
  }

  const npmCommand = deps.platform === 'win32' ? 'npm.cmd' : 'npm'
  deps.execFileSync(npmCommand, ['run', 'build:server'], {
    cwd: projectRoot,
    env: {
      ...deps.env,
      NODE_ENV: 'production',
    },
    stdio: 'inherit',
  })
}

export default async function globalSetup(): Promise<void> {
  ensureBuiltServerEntry(PROJECT_ROOT)
}
