import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

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
  execSync: typeof execSync
  env: NodeJS.ProcessEnv
  log: Pick<Console, 'log'>
}

export function ensureFreshE2eBuild(
  root: string,
  deps: EnsureFreshE2eBuildDeps = {
    execSync,
    env: process.env,
    log: console,
  },
): void {
  deps.log.log('[e2e-setup] Building client and server...')
  deps.execSync('npm run build:client && npm run build:server', {
    cwd: root,
    stdio: 'inherit',
    env: { ...deps.env, NODE_ENV: 'production' },
  })
  deps.log.log('[e2e-setup] Build complete.')
}

export default async function globalSetup() {
  const root = findProjectRoot()
  ensureFreshE2eBuild(root)
}
