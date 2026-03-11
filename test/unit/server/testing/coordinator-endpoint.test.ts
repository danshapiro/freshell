import { mkdirSync } from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  buildCoordinatorEndpoint,
  tryListen,
} from '../../../../scripts/testing/coordinator-endpoint.js'

let tempDir: string

beforeEach(async () => {
  tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-coordinator-endpoint-'))
})

afterEach(async () => {
  await fsp.rm(tempDir, { recursive: true, force: true })
})

async function closeHandle(handle: Awaited<ReturnType<typeof tryListen>>) {
  if (handle.kind !== 'listening') return
  await handle.close()
}

async function createDirectoryWithByteLength(parentDir: string, byteLength: number): Promise<string> {
  const baseDir = path.join(parentDir, 'runtime')
  await fsp.mkdir(baseDir, { recursive: true })

  const currentLength = Buffer.byteLength(baseDir)
  const requiredNameLength = Math.max(1, byteLength - currentLength - 1)
  const current = path.join(baseDir, 'x'.repeat(requiredNameLength))
  await fsp.mkdir(current, { recursive: true })
  return current
}

describe('buildCoordinatorEndpoint()', () => {
  it('uses a repo-hash unix socket path under the shortest existing runtime directory', () => {
    const commonDir = path.join(tempDir, 'repo', '.git')
    const shortDir = path.join(tempDir, 'tmp')
    const longDir = path.join(tempDir, 'very', 'long', 'runtime', 'directory')
    fsSetup(shortDir, longDir)

    const endpoint = buildCoordinatorEndpoint(commonDir, 'linux', [longDir, shortDir])

    expect(endpoint.kind).toBe('unix')
    expect(endpoint.repoHash).toHaveLength(12)
    expect(endpoint.address).toBe(path.join(shortDir, `frt-${endpoint.repoHash}.sock`))
    expect(Buffer.byteLength(endpoint.address)).toBeLessThanOrEqual(90)
  })

  it('falls back to the shorter unix socket name when the preferred path is too long', async () => {
    const commonDir = path.join(tempDir, 'repo', '.git')
    const constrainedDir = await createDirectoryWithByteLength(tempDir, 69)

    const endpoint = buildCoordinatorEndpoint(commonDir, 'linux', [constrainedDir])

    expect(endpoint.kind).toBe('unix')
    expect(path.basename(endpoint.address)).toBe(`f-${endpoint.repoHash}.sock`)
    expect(Buffer.byteLength(endpoint.address)).toBeLessThanOrEqual(90)
  })

  it('raises an actionable error when no unix socket candidate fits within the byte cap', async () => {
    const commonDir = path.join(tempDir, 'repo', '.git')
    const tooLongDir = await createDirectoryWithByteLength(tempDir, 71)

    expect(() => buildCoordinatorEndpoint(commonDir, 'linux', [tooLongDir])).toThrow(/XDG_RUNTIME_DIR/)
  })

  it('uses the documented windows named pipe format', () => {
    const commonDir = path.join(tempDir, 'repo', '.git')

    const endpoint = buildCoordinatorEndpoint(commonDir, 'win32')

    expect(endpoint).toMatchObject({
      kind: 'windows',
      address: `\\\\.\\pipe\\freshell-test-${endpoint.repoHash}`,
    })
  })
})

function fsSetup(...dirs: string[]) {
  for (const dir of dirs) {
    mkdirSync(dir, { recursive: true })
  }
}

describe('tryListen()', () => {
  it('reports busy without deleting the unix socket when a live owner is present', async () => {
    const commonDir = path.join(tempDir, 'repo', '.git')
    const endpoint = buildCoordinatorEndpoint(commonDir, 'linux', [tempDir])

    const holder = await tryListen(endpoint)
    expect(holder.kind).toBe('listening')

    const contender = await tryListen(endpoint)

    expect(contender).toEqual({ kind: 'busy' })
    await expect(fsp.stat(endpoint.address)).resolves.toBeDefined()

    await closeHandle(holder)
  })

  it('removes stale unix socket files only after a failed connection proves no live owner', async () => {
    const commonDir = path.join(tempDir, 'repo', '.git')
    const endpoint = buildCoordinatorEndpoint(commonDir, 'linux', [tempDir])

    await fsp.mkdir(path.dirname(endpoint.address), { recursive: true })
    await fsp.writeFile(endpoint.address, '')

    const handle = await tryListen(endpoint)
    expect(handle.kind).toBe('listening')

    const stat = await fsp.lstat(endpoint.address)
    expect(stat.isSocket()).toBe(true)

    await closeHandle(handle)
  })
})
