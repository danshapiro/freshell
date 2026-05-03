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

export default async function globalSetup() {
  const root = findProjectRoot()
  const clientDir = path.join(root, 'dist', 'client')
  const serverEntry = path.join(root, 'dist', 'server', 'index.js')

  // Build if dist doesn't exist
  if (!fs.existsSync(clientDir) || !fs.existsSync(serverEntry)) {
    console.log('[e2e-setup] Building client and server...')
    execSync('npm run build:client && npm run build:server', {
      cwd: root,
      stdio: 'inherit',
      env: { ...process.env, NODE_ENV: 'production' },
    })
    console.log('[e2e-setup] Build complete.')
  } else {
    console.log('[e2e-setup] Using existing build in dist/')
  }
}
