import { createHash } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import { performance } from 'node:perf_hooks'
import path from 'node:path'

import type { HolderRecord } from './coordinator-schema.js'
import { readHolder, getCoordinatorStoreDir } from './coordinator-store.js'

const UNIX_SOCKET_MAX_BYTES = 90
const CLEANUP_LOCK_RETRY_MS = 10
const CLEANUP_LOCK_TIMEOUT_MS = 5_000
const CLEANUP_LOCK_STALE_MS = 30_000
const CURRENT_PROCESS_STARTED_AT_MS = performance.timeOrigin

export type CoordinatorEndpoint =
  | {
    kind: 'unix'
    address: string
    commonDir: string
    storeDir: string
    repoHash: string
  }
  | {
    kind: 'windows'
    address: string
    commonDir: string
    storeDir: string
    repoHash: string
  }

export type ListeningServer = {
  kind: 'listening'
  endpoint: CoordinatorEndpoint
  server: net.Server
  close: () => Promise<void>
}

export function buildCoordinatorEndpoint(
  commonDir: string,
  platform: NodeJS.Platform = process.platform,
  baseDirs: string[] = defaultRuntimeBaseDirs(),
): CoordinatorEndpoint {
  const repoHash = createHash('sha256').update(commonDir).digest('hex').slice(0, 12)
  const storeDir = getCoordinatorStoreDir(commonDir)

  if (platform === 'win32') {
    return {
      kind: 'windows',
      address: `\\\\.\\pipe\\freshell-test-${repoHash}`,
      commonDir,
      storeDir,
      repoHash,
    }
  }

  const existingBaseDirs = uniqueExistingDirectories(baseDirs)
  for (const baseDir of existingBaseDirs) {
    for (const fileName of [`frt-${repoHash}.sock`, `f-${repoHash}.sock`]) {
      const address = path.join(baseDir, fileName)
      if (Buffer.byteLength(address) <= UNIX_SOCKET_MAX_BYTES) {
        return {
          kind: 'unix',
          address,
          commonDir,
          storeDir,
          repoHash,
        }
      }
    }
  }

  throw new Error(
    `No coordinator socket path fits within ${UNIX_SOCKET_MAX_BYTES} bytes. Shorten XDG_RUNTIME_DIR or set XDG_RUNTIME_DIR to a shorter existing directory.`,
  )
}

export async function tryListen(endpoint: CoordinatorEndpoint): Promise<ListeningServer | { kind: 'busy' }> {
  if (endpoint.kind === 'unix') {
    const preparation = await prepareUnixSocket(endpoint)
    if (preparation === 'busy') {
      return { kind: 'busy' }
    }
  }

  const server = net.createServer((socket) => {
    socket.end()
  })

  try {
    await listen(server, endpoint.address)
  } catch (error) {
    server.close()
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      return { kind: 'busy' }
    }
    throw error
  }

  return {
    kind: 'listening',
    endpoint,
    server,
    close: async () => {
      await closeServer(server)
    },
  }
}

async function prepareUnixSocket(endpoint: Extract<CoordinatorEndpoint, { kind: 'unix' }>): Promise<'ready' | 'busy'> {
  await fsp.mkdir(path.dirname(endpoint.address), { recursive: true })

  while (true) {
    if (!(await pathExists(endpoint.address))) {
      return 'ready'
    }

    if (await canConnect(endpoint)) {
      return 'busy'
    }

    const release = await acquireCleanupLock(endpoint.address)
    try {
      if (!(await pathExists(endpoint.address))) {
        return 'ready'
      }

      if (await canConnect(endpoint)) {
        return 'busy'
      }

      await fsp.rm(endpoint.address, { force: true })
      return 'ready'
    } finally {
      await release()
    }
  }
}

export async function readActiveHolder(endpoint: CoordinatorEndpoint): Promise<HolderRecord | 'running-undescribed' | undefined> {
  const busy = await canConnect(endpoint)
  if (!busy) {
    return undefined
  }

  const holder = await readHolder(endpoint.storeDir)
  return holder ?? 'running-undescribed'
}

async function canConnect(endpoint: CoordinatorEndpoint): Promise<boolean> {
  try {
    await connect(endpoint.address)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ECONNREFUSED' || code === 'ENOTSOCK' || code === 'ECONNRESET') {
      return false
    }
    return false
  }
}

function defaultRuntimeBaseDirs(): string[] {
  return [process.env.XDG_RUNTIME_DIR, '/tmp', os.tmpdir()]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
}

function uniqueExistingDirectories(baseDirs: string[]): string[] {
  const unique = new Set<string>()
  for (const baseDir of [...baseDirs].sort((left, right) => Buffer.byteLength(left) - Buffer.byteLength(right))) {
    if (unique.has(baseDir)) {
      continue
    }

    try {
      if (fs.statSync(baseDir).isDirectory()) {
        unique.add(baseDir)
      }
    } catch {
      // Ignore missing or unreadable directories.
    }
  }
  return [...unique]
}

function listen(server: net.Server, address: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(address)
  })
}

function connect(address: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(address)
    const cleanup = () => {
      socket.removeAllListeners()
    }

    socket.once('connect', () => {
      cleanup()
      socket.end()
      resolve()
    })
    socket.once('error', (error) => {
      cleanup()
      reject(error)
    })
  })
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error)
      } else {
        resolve()
      }
    })
  })
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fsp.lstat(filePath)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false
    }
    throw error
  }
}

async function acquireCleanupLock(address: string): Promise<() => Promise<void>> {
  const lockPath = `${address}.cleanup.lock`
  const deadline = Date.now() + CLEANUP_LOCK_TIMEOUT_MS

  while (true) {
    try {
      const handle = await fsp.open(lockPath, 'wx')
      try {
        await handle.writeFile(JSON.stringify({
          pid: process.pid,
          startedAt: new Date().toISOString(),
        }))
      } finally {
        await handle.close()
      }

      return async () => {
        try {
          await fsp.unlink(lockPath)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw error
          }
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error
      }

      if (await clearStaleCleanupLock(lockPath)) {
        continue
      }

      if (Date.now() >= deadline) {
        throw new Error(`Timed out acquiring coordinator socket cleanup lock for ${address}.`)
      }

      await delay(CLEANUP_LOCK_RETRY_MS)
    }
  }
}

async function clearStaleCleanupLock(lockPath: string): Promise<boolean> {
  const stale = await isStaleLockFile(lockPath, CLEANUP_LOCK_STALE_MS)

  if (!stale) {
    return false
  }

  try {
    await fsp.unlink(lockPath)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function isStaleLockFile(lockPath: string, staleMs: number): Promise<boolean> {
  const metadata = await readLockMetadata(lockPath)
  if (!metadata.exists) {
    return true
  }

  if (metadata.ageMs !== undefined && metadata.ageMs > staleMs) {
    if (metadata.pid === process.pid) {
      return metadata.startedAtMs !== undefined && metadata.startedAtMs < CURRENT_PROCESS_STARTED_AT_MS
    }
    return true
  }

  if (metadata.pid !== undefined) {
    return !isProcessAlive(metadata.pid)
  }

  return false
}

async function readLockMetadata(lockPath: string): Promise<{ exists: boolean; pid?: number; ageMs?: number; startedAtMs?: number }> {
  try {
    const raw = await fsp.readFile(lockPath, 'utf8')
    const parsed = JSON.parse(raw) as { pid?: unknown; startedAt?: unknown }
    const startedAtMs = parseLockTimestamp(parsed.startedAt)
    return {
      exists: true,
      pid: typeof parsed.pid === 'number' ? parsed.pid : undefined,
      startedAtMs,
      ageMs: startedAtMs !== undefined ? Math.max(0, Date.now() - startedAtMs) : await readLockAgeFromStat(lockPath),
    }
  } catch {
    const ageMs = await readLockAgeFromStat(lockPath)
    if (ageMs === undefined) {
      return { exists: false }
    }
    return {
      exists: true,
      ageMs,
    }
  }
}

function parseLockTimestamp(startedAt: unknown): number | undefined {
  if (typeof startedAt !== 'string') {
    return undefined
  }

  const started = Date.parse(startedAt)
  if (Number.isNaN(started)) {
    return undefined
  }

  return started
}

async function readLockAgeFromStat(lockPath: string): Promise<number | undefined> {
  const stats = await fsp.stat(lockPath).catch(() => undefined)
  if (!stats) {
    return undefined
  }

  return Math.max(0, Date.now() - stats.mtimeMs)
}
