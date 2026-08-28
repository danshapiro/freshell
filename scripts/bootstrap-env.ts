import { randomBytes } from 'node:crypto'
import { closeSync, fsyncSync, openSync, readFileSync, writeSync } from 'node:fs'
import path from 'node:path'

export type AuthTokenBootstrapResult = {
  created: boolean
  source: 'environment' | 'file' | 'generated'
}

export type AuthTokenBootstrapOptions = {
  env?: NodeJS.ProcessEnv
  envPath?: string
  generateToken?: () => string
}

const MIN_AUTH_TOKEN_LENGTH = 16

function parseAuthToken(contents: string): string | undefined {
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?AUTH_TOKEN\s*=\s*(.*?)\s*$/)
    if (!match) continue

    let value = match[1]
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (value.length > 0) return value
  }
  return undefined
}

function readExistingEnv(envPath: string): string | undefined {
  try {
    return readFileSync(envPath, 'utf8')
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return undefined
    }
    throw error
  }
}

function writeAtomicallyIfAbsent(envPath: string, contents: string): boolean {
  let descriptor: number
  try {
    // O_EXCL makes the first-run file creation atomic and prevents a second
    // process from replacing an env file that appeared concurrently.
    descriptor = openSync(envPath, 'wx', 0o600)
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST') {
      return false
    }
    throw error
  }

  try {
    writeSync(descriptor, contents, undefined, 'utf8')
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
  return true
}

function appendAtomically(envPath: string, contents: string): void {
  const descriptor = openSync(envPath, 'a', 0o600)
  try {
    writeSync(descriptor, contents, undefined, 'utf8')
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
}

/**
 * Ensure the Rust server has an authentication token without starting a
 * server. Environment variables always win; otherwise an existing .env token
 * is preserved, and a missing token is generated and made available to the
 * current process as well as the file Rust loads from its working directory.
 */
export function ensureAuthTokenFile(options: AuthTokenBootstrapOptions = {}): AuthTokenBootstrapResult {
  const env = options.env ?? process.env
  const envPath = options.envPath ?? path.join(process.cwd(), '.env')
  const generateToken = options.generateToken ?? (() => randomBytes(32).toString('hex'))

  if (env.AUTH_TOKEN?.trim()) {
    return { created: false, source: 'environment' }
  }

  let existing = readExistingEnv(envPath)
  if (existing !== undefined && parseAuthToken(existing)) {
    return { created: false, source: 'file' }
  }

  const token = generateToken()
  if (token.length < MIN_AUTH_TOKEN_LENGTH) {
    throw new Error(`Generated AUTH_TOKEN must be at least ${MIN_AUTH_TOKEN_LENGTH} characters.`)
  }
  const assignment = `AUTH_TOKEN=${token}\n`

  if (existing === undefined) {
    if (writeAtomicallyIfAbsent(envPath, assignment)) {
      env.AUTH_TOKEN = token
      return { created: true, source: 'generated' }
    }

    existing = readExistingEnv(envPath)
    if (existing !== undefined && parseAuthToken(existing)) {
      return { created: false, source: 'file' }
    }
    if (existing === undefined) {
      throw new Error('The .env file disappeared while bootstrapping AUTH_TOKEN.')
    }
  }

  if (!parseAuthToken(existing)) {
    // O_APPEND makes this one write indivisible with respect to other
    // starters and avoids replacing a file that already contains settings.
    appendAtomically(envPath, `${existing.length > 0 && !existing.endsWith('\n') ? '\n' : ''}${assignment}`)
  }

  env.AUTH_TOKEN = token
  return { created: true, source: 'generated' }
}
