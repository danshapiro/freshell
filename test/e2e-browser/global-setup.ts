import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveNpmExecFileCommand } from '../setup/npm-command.js'

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
  execFileSync: typeof execFileSync
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  log: Pick<Console, 'log'>
}

export function ensureFreshE2eBuild(
  root: string,
  deps: EnsureFreshE2eBuildDeps = {
    execFileSync,
    env: process.env,
    platform: process.platform,
    log: console,
  },
): void {
  const env = { ...deps.env, NODE_ENV: 'production' }
  const prebuild = resolveNpmExecFileCommand(['run', 'prebuild'], deps.env, deps.platform)
  deps.execFileSync(prebuild.command, prebuild.args, {
    cwd: root,
    stdio: 'inherit',
    env,
  })
  deps.log.log('[e2e-setup] Building client and Rust server...')
  const npm = resolveNpmExecFileCommand(['run', 'build:client'], deps.env, deps.platform)
  deps.execFileSync(npm.command, npm.args, {
    cwd: root,
    stdio: 'inherit',
    env,
  })
  deps.execFileSync('cargo', ['build', '--release', '-p', 'freshell-server', '--locked'], {
    cwd: root,
    stdio: 'inherit',
    env,
  })
  deps.log.log('[e2e-setup] Build complete.')
}

export default async function globalSetup() {
  const root = findProjectRoot()
  ensureFreshE2eBuild(root)
}
