import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const PROJECT_ROOT = path.resolve(__dirname, '../..')

interface EnsureBuiltServerEntryDeps {
  execFileSync: typeof execFileSync
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
}

export function ensureBuiltServerEntry(
  projectRoot: string,
  deps: EnsureBuiltServerEntryDeps = {
    execFileSync,
    env: process.env,
    platform: process.platform,
  },
): void {
  // dist/ is gitignored in worktrees, so rebuild unconditionally here rather
  // than trusting a possibly stale compiled entry from an earlier branch state.
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
