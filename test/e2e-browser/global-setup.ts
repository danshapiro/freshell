import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveManagerExecFileCommand } from '../setup/manager-command.js'
import { assertSubprocessCompleted } from '../../scripts/testing/sync-subprocess.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

function findProjectRoot(): string {
  let dir = __dirname
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir
    dir = path.dirname(dir)
  }
  throw new Error('Could not find project root')
}

interface EnsureFreshE2eBuildDeps {
  spawnSync: typeof spawnSync
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  log: Pick<Console, 'log'>
}

function assertBuildSucceeded(result: ReturnType<typeof spawnSync>, stage: string): void {
  assertSubprocessCompleted(result, `[e2e-setup] ${stage}`)
  if (result.status !== 0) {
    throw new Error(`[e2e-setup] ${stage} failed (exit ${result.status}); refusing to run browsers against stale assets`)
  }
}

export function ensureFreshE2eBuild(
  root: string,
  deps: EnsureFreshE2eBuildDeps = {
    spawnSync,
    env: process.env,
    platform: process.platform,
    log: console,
  },
): void {
  const env = { ...deps.env, NODE_ENV: 'production' }
  const prebuild = resolveManagerExecFileCommand(['run', 'prebuild'], deps.env, deps.platform, process.execPath, root)
  const prebuildResult = deps.spawnSync(prebuild.command, prebuild.args, {
    cwd: root,
    stdio: 'inherit',
    env,
    shell: prebuild.viaShell ?? false,
  })
  assertBuildSucceeded(prebuildResult, 'prebuild')
  deps.log.log('[e2e-setup] Building client and Rust server...')
  const client = resolveManagerExecFileCommand(['run', 'build:client'], deps.env, deps.platform, process.execPath, root)
  const clientResult = deps.spawnSync(client.command, client.args, {
    cwd: root,
    stdio: 'inherit',
    env,
    shell: client.viaShell ?? false,
  })
  assertBuildSucceeded(clientResult, 'client build')
  const serverResult = deps.spawnSync('cargo', ['build', '--release', '-p', 'freshell-server', '--locked'], {
    cwd: root,
    stdio: 'inherit',
    env,
  })
  assertBuildSucceeded(serverResult, 'Rust server build')
  deps.log.log('[e2e-setup] Build complete.')
}

export default async function globalSetup() {
  const root = findProjectRoot()
  ensureFreshE2eBuild(root)
}
