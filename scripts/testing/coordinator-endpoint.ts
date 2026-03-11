import { createHash } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

import type { HolderRecord } from './coordinator-schema.js'
import { readHolder, getCoordinatorStoreDir } from './coordinator-store.js'

const UNIX_SOCKET_MAX_BYTES = 90

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
    await fsp.mkdir(path.dirname(endpoint.address), { recursive: true })

    const existingEntry = await fsp.lstat(endpoint.address).then(() => true).catch(() => false)
    if (existingEntry) {
      const liveOwner = await canConnect(endpoint)
      if (liveOwner) {
        return { kind: 'busy' }
      }

      await fsp.rm(endpoint.address, { force: true })
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
