import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { GlobalSetupContext } from 'vitest/node'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const PROJECT_ROOT = path.resolve(__dirname, '../..')

interface EnsureBuiltRuntimeDeps {
  execFileSync: typeof execFileSync
  rmSync: typeof fs.rmSync
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
}

interface InstallBuiltRuntimeRefreshDeps {
  ensureBuiltRuntime: (projectRoot: string) => void
}

export function ensureBuiltRuntime(
  projectRoot: string,
  deps: EnsureBuiltRuntimeDeps = {
    execFileSync,
    rmSync: fs.rmSync,
    env: process.env,
    platform: process.platform,
  },
): void {
  deps.rmSync(path.join(projectRoot, 'dist', '.env'), { force: true })
  const npmCommand = deps.platform === 'win32' ? 'npm.cmd' : 'npm'
  deps.execFileSync(npmCommand, ['run', 'build'], {
    cwd: projectRoot,
    env: {
      ...deps.env,
      NODE_ENV: 'production',
    },
    stdio: 'inherit',
  })
}

export function installBuiltRuntimeRefresh(
  project: Pick<GlobalSetupContext, 'onTestsRerun'>,
  projectRoot: string,
  deps: InstallBuiltRuntimeRefreshDeps = {
    ensureBuiltRuntime: (root) => ensureBuiltRuntime(root),
  },
): void {
  deps.ensureBuiltRuntime(projectRoot)
  project.onTestsRerun(() => {
    deps.ensureBuiltRuntime(projectRoot)
  })
}

export default async function globalSetup(project: GlobalSetupContext): Promise<void> {
  installBuiltRuntimeRefresh(project, PROJECT_ROOT)
}
