#!/usr/bin/env tsx

/**
 * Pre-flight check before starting dev/serve.
 *
 * Checks (in order):
 * 1. Update availability - prompts user to update if newer version exists
 * 2. Missing dependencies - ensures node_modules has all required packages
 * 3. Port conflicts - detects if freshell is already running
 */

import { readFileSync, existsSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { runUpdateCheck, shouldSkipUpdateCheck } from '../server/updater/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const rootDir = resolve(__dirname, '..')

// Load package.json for version
function getPackageVersion(): string {
  try {
    const pkgPath = resolve(rootDir, 'package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
    return pkg.version || '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/**
 * Check if node_modules is missing required dependencies from package.json.
 * Returns list of missing packages.
 */
function checkMissingDependencies(): string[] {
  const missing: string[] = []
  try {
    const pkgPath = resolve(rootDir, 'package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
    const allDeps: Record<string, string> = {
      ...pkg.dependencies,
      ...pkg.devDependencies,
    }

    for (const dep of Object.keys(allDeps)) {
      const depPath = resolve(rootDir, 'node_modules', dep)
      if (!existsSync(depPath)) {
        missing.push(dep)
      }
    }
  } catch {
    // If we can't read package.json, skip this check
  }
  return missing
}

// Load .env file manually (dotenv not available at this stage)
function loadEnv(): Record<string, string> {
  try {
    const envPath = resolve(__dirname, '..', '.env')
    const content = readFileSync(envPath, 'utf-8')
    const env: Record<string, string> = {}
    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const match = trimmed.match(/^([^=]+)=(.*)$/)
      if (match) {
        env[match[1]] = match[2]
      }
    }
    return env
  } catch {
    return {}
  }
}

const env = loadEnv()
// process.env takes precedence over .env file so CLI overrides work:
//   PORT=3002 VITE_PORT=5174 npm run dev
const VITE_PORT = parseInt(process.env.VITE_PORT || env.VITE_PORT || '5173', 10)
const SERVER_PORT = parseInt(process.env.PORT || env.PORT || '3001', 10)

interface PortCheckResult {
  status: 'freshell' | 'other' | 'free'
  data?: unknown
}

/**
 * Check if freshell server is running on a port via /api/health endpoint.
 */
async function checkServerPort(port: number): Promise<PortCheckResult> {
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 2000)

    const res = await fetch(`http://localhost:${port}/api/health`, {
      signal: controller.signal,
    })
    clearTimeout(timeout)

    if (res.ok) {
      const data = await res.json() as { app?: string }
      if (data.app === 'freshell') {
        return { status: 'freshell', data }
      }
      return { status: 'other' }
    }
    return { status: 'other' }
  } catch (err: unknown) {
    const error = err as { code?: string; name?: string; cause?: { code?: string } }
    if (error.code === 'ECONNREFUSED' || error.cause?.code === 'ECONNREFUSED') {
      return { status: 'free' }
    }
    // Timeout or reset: likely nothing useful (e.g., WSL networking via IP Helper)
    if (error.name === 'AbortError') {
      return { status: 'free' }
    }
    if (error.code === 'ECONNRESET' || error.cause?.code === 'ECONNRESET') {
      return { status: 'free' }
    }
    return { status: 'other' }
  }
}

/**
 * Check if freshell Vite dev server is running by looking for markers in the index page.
 */
async function checkVitePort(): Promise<PortCheckResult> {
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 2000)

    const res = await fetch(`http://localhost:${VITE_PORT}/`, {
      signal: controller.signal,
    })
    clearTimeout(timeout)

    const text = await res.text()
    if (text.includes('freshell') || text.includes('@vite/client')) {
      return { status: 'freshell' }
    }
    return { status: 'other' }
  } catch (err: unknown) {
    const error = err as { code?: string; name?: string; cause?: { code?: string } }
    if (error.code === 'ECONNREFUSED' || error.cause?.code === 'ECONNREFUSED') {
      return { status: 'free' }
    }
    // Timeout or reset: likely nothing useful (e.g., WSL networking via IP Helper)
    if (error.name === 'AbortError') {
      return { status: 'free' }
    }
    if (error.code === 'ECONNRESET' || error.cause?.code === 'ECONNRESET') {
      return { status: 'free' }
    }
    return { status: 'other' }
  }
}

async function main(): Promise<void> {
  // 1. Check for updates first (before anything else can fail)
  if (!shouldSkipUpdateCheck()) {
    const currentVersion = getPackageVersion()
    const updateResult = await runUpdateCheck(currentVersion)

    if (updateResult.action === 'updated') {
      // Update succeeded - it already ran npm install and build
      // Exit with special code to signal caller that update happened
      console.log('\n\x1b[32m✓ Update complete!\x1b[0m Restart freshell to use the new version.\n')
      process.exit(0)
    }

    if (updateResult.action === 'error') {
      console.error(`\n\x1b[33m⚠ Update failed: ${updateResult.error}\x1b[0m`)
      console.error('Continuing with current version...\n')
    }
  }

  // 2. Check for missing dependencies
  const missingDeps = checkMissingDependencies()
  if (missingDeps.length > 0) {
    console.error('\n\x1b[31m✖ Missing dependencies detected:\x1b[0m\n')
    missingDeps.slice(0, 10).forEach(dep => console.error(`  • ${dep}`))
    if (missingDeps.length > 10) {
      console.error(`  • ... and ${missingDeps.length - 10} more`)
    }
    console.error('\n\x1b[33mTo fix:\x1b[0m')
    console.error('  npm install\n')
    process.exit(1)
  }

  // 3. Check for port conflicts
  // Only check Vite port in dev mode (predev), not production (preserve)
  const isDevMode = process.env.npm_lifecycle_event === 'predev'

  const serverCheck = await checkServerPort(SERVER_PORT)
  const viteCheck = isDevMode ? await checkVitePort() : { status: 'free' as const }

  const issues: string[] = []

  if (serverCheck.status === 'freshell') {
    issues.push(`Port ${SERVER_PORT}: Another freshell server is already running`)
  } else if (serverCheck.status === 'other') {
    issues.push(`Port ${SERVER_PORT}: Something else is using this port`)
  }

  if (viteCheck.status === 'freshell') {
    issues.push(`Port ${VITE_PORT}: Another freshell dev server is already running`)
  } else if (viteCheck.status === 'other') {
    issues.push(`Port ${VITE_PORT}: Something else is using this port`)
  }

  if (issues.length > 0) {
    console.error('\n\x1b[31m✖ Cannot start freshell:\x1b[0m\n')
    issues.forEach(issue => console.error(`  • ${issue}`))
    console.error('\n\x1b[33mTo fix:\x1b[0m')
    console.error('  1. Close the other freshell instance, or')
    console.error('  2. Find and kill the process:')
    console.error('     Windows:  netstat -ano | findstr :5173')
    console.error('               taskkill /F /PID <pid>')
    console.error('     WSL:      wsl --list --running')
    console.error('               wsl --terminate <distro>')
    console.error('     Unix:     lsof -i :5173 && kill <pid>\n')
    process.exit(1)
  }

  // All clear
  process.exit(0)
}

main()
