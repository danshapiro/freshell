#!/usr/bin/env tsx

/**
 * Pre-build guard: prevents building over a live production dist/.
 *
 * Checks if a Freshell production server is running on the configured port.
 * If so, blocks the build and suggests safe alternatives.
 */

import { readFileSync, statSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Load .env file manually (dotenv not available at this stage)
export function parseEnv(content: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    // Handle optional 'export' prefix, trim key/value, strip quotes
    const match = trimmed.match(/^(?:export\s+)?([^=]+?)(?:\s*)=(?:\s*)(.*)$/)
    if (match) {
      const key = match[1].trim()
      const raw = match[2].trim()
      // Strip surrounding quotes, allowing trailing inline comments after closing quote
      const quoted = raw.match(/^(['"])(.*)\1(?:\s+#.*)?$/)
      env[key] = quoted ? quoted[2] : raw.replace(/\s+#.*$/, '')
    }
  }
  return env
}

function loadEnv(): Record<string, string> {
  try {
    const envPath = resolve(__dirname, '..', '.env')
    const content = readFileSync(envPath, 'utf-8')
    return parseEnv(content)
  } catch {
    return {}
  }
}

export function isLinkedWorktreeCheckout(rootDir: string = resolve(__dirname, '..')): boolean {
  try {
    const dotGitPath = resolve(rootDir, '.git')
    const stat = statSync(dotGitPath)
    if (!stat.isFile()) {
      return false
    }

    const pointer = readFileSync(dotGitPath, 'utf-8').trim().replace(/\\/g, '/')
    return /^gitdir:\s+.+\/\.git\/worktrees\/.+$/m.test(pointer)
  } catch {
    return false
  }
}

export interface ProdCheckResult {
  status: 'running' | 'not-running'
  version?: string
}

const PROD_CHECK_TIMEOUT_MS = 3000
const PROD_CHECK_ATTEMPTS = 3
const PROD_CHECK_RETRY_DELAY_MS = 100

export interface ProdCheckOptions {
  timeoutMs?: number
  attempts?: number
  retryDelayMs?: number
}

async function probeProdRunning(port: number, timeoutMs: number): Promise<{
  result: ProdCheckResult
  transientFailure: boolean
}> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: controller.signal,
    })

    if (!res.ok) {
      return { result: { status: 'not-running' }, transientFailure: false }
    }

    const data = (await res.json()) as { app?: string; version?: string }
    if (data.app === 'freshell') {
      return { result: { status: 'running', version: data.version }, transientFailure: false }
    }

    return { result: { status: 'not-running' }, transientFailure: false }
  } catch {
    return { result: { status: 'not-running' }, transientFailure: true }
  } finally {
    clearTimeout(timeout)
  }
}

export async function checkProdRunning(
  port: number,
  {
    timeoutMs = PROD_CHECK_TIMEOUT_MS,
    attempts = PROD_CHECK_ATTEMPTS,
    retryDelayMs = PROD_CHECK_RETRY_DELAY_MS,
  }: ProdCheckOptions = {},
): Promise<ProdCheckResult> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const { result, transientFailure } = await probeProdRunning(port, timeoutMs)
    if (result.status === 'running') {
      return result
    }
    if (!transientFailure || attempt === attempts) {
      return result
    }
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs))
  }

  return { status: 'not-running' }
}

export async function main(): Promise<void> {
  if (isLinkedWorktreeCheckout()) {
    process.exit(0)
  }

  const env = loadEnv()
  const port = parseInt(process.env.PORT || env.PORT || '3001', 10)

  const result = await checkProdRunning(port)

  if (result.status !== 'running') {
    // No production server detected — build is safe
    process.exit(0)
  }

  const version = result.version ? ` (v${result.version})` : ''
  console.error(`\n\x1b[31m✖ Freshell production server${version} is running on port ${port}.\x1b[0m`)
  console.error(`  Building would overwrite dist/ and break the live server.\n`)
  console.error(`\x1b[33mSafe alternatives:\x1b[0m`)
  console.error(`  1. \x1b[36mnpm run check\x1b[0m        Typecheck + tests without building (safe while prod is live)`)
  console.error(`  2. Kill production, then build:`)
  console.error(`     \x1b[36mkill {PID} && npm run build\x1b[0m`)
  console.error(`  3. Build in a worktree:`)
  console.error(`     \x1b[36mcd .worktrees/{branch} && npm run build\x1b[0m\n`)
  process.exit(1)
}

// Only run when executed directly (not imported by tests)
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  main()
}
