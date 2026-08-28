// @vitest-environment node
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { ensureAuthTokenFile } from '../../../scripts/bootstrap-env.js'

const tempRoots: string[] = []

afterEach(async () => {
  while (tempRoots.length > 0) {
    await rm(tempRoots.pop()!, { recursive: true, force: true })
  }
})

async function createTempEnvPath(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'freshell-bootstrap-env-'))
  tempRoots.push(root)
  return path.join(root, '.env')
}

describe('ensureAuthTokenFile', () => {
  it('creates a private .env atomically with a secure token when no token exists', async () => {
    const envPath = await createTempEnvPath()
    const env: NodeJS.ProcessEnv = {}

    const result = ensureAuthTokenFile({
      env,
      envPath,
      generateToken: () => 'a'.repeat(64),
    })

    expect(result).toEqual({ created: true, source: 'generated' })
    expect(env.AUTH_TOKEN).toBe('a'.repeat(64))
    expect(await readFile(envPath, 'utf8')).toBe(`AUTH_TOKEN=${env.AUTH_TOKEN}\n`)
    expect((await stat(envPath)).mode & 0o777).toBe(0o600)
  })

  it('preserves an existing file token and does not regenerate or overwrite it', async () => {
    const envPath = await createTempEnvPath()
    const original = 'PORT=3456\nAUTH_TOKEN="existing-token"\nCUSTOM=value\n'
    await writeFile(envPath, original, { mode: 0o600 })
    const env: NodeJS.ProcessEnv = {}

    const result = ensureAuthTokenFile({
      env,
      envPath,
      generateToken: () => {
        throw new Error('token should not be generated')
      },
    })

    expect(result).toEqual({ created: false, source: 'file' })
    expect(env.AUTH_TOKEN).toBeUndefined()
    expect(await readFile(envPath, 'utf8')).toBe(original)
  })

  it('honors an existing environment token without creating a file', async () => {
    const envPath = await createTempEnvPath()
    const env: NodeJS.ProcessEnv = { AUTH_TOKEN: 'environment-token', PORT: '3456' }

    const result = ensureAuthTokenFile({
      env,
      envPath,
      generateToken: () => {
        throw new Error('token should not be generated')
      },
    })

    expect(result).toEqual({ created: false, source: 'environment' })
    await expect(readFile(envPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(env).toEqual({ AUTH_TOKEN: 'environment-token', PORT: '3456' })
  })

  it('keeps existing dotenv values when adding a missing token', async () => {
    const envPath = await createTempEnvPath()
    await writeFile(envPath, 'PORT=3456\nCUSTOM=value\n', { mode: 0o600 })
    const env: NodeJS.ProcessEnv = {}

    const result = ensureAuthTokenFile({
      env,
      envPath,
      generateToken: () => 'b'.repeat(64),
    })

    expect(result).toEqual({ created: true, source: 'generated' })
    expect(await readFile(envPath, 'utf8')).toBe('PORT=3456\nCUSTOM=value\nAUTH_TOKEN=' + 'b'.repeat(64) + '\n')
    expect(env.AUTH_TOKEN).toBe('b'.repeat(64))
  })

  it('replaces the copied .env.example placeholder instead of treating it as a token', async () => {
    const envPath = await createTempEnvPath()
    await writeFile(envPath, 'PORT=3456\nAUTH_TOKEN=replace-with-a-long-random-token\nCUSTOM=value\n', { mode: 0o600 })
    const env: NodeJS.ProcessEnv = {}

    const result = ensureAuthTokenFile({
      env,
      envPath,
      generateToken: () => 'c'.repeat(64),
    })

    expect(result).toEqual({ created: true, source: 'generated' })
    expect(env.AUTH_TOKEN).toBe('c'.repeat(64))
    expect(await readFile(envPath, 'utf8')).toBe(
      'PORT=3456\nAUTH_TOKEN=' + 'c'.repeat(64) + '\nCUSTOM=value\n',
    )
    expect(await readFile(envPath, 'utf8')).not.toContain('replace-with-a-long-random-token')
  })
})
