import { createServer as createHttpServer, type Server as HttpServer } from 'node:http'
import { createServer as createNetServer, type Server as NetServer, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'

import { waitForHttp } from './wait-for-http.js'

const openServers: Array<HttpServer | NetServer> = []
const openSockets = new Set<Socket>()

async function listen(server: HttpServer | NetServer): Promise<number> {
  openServers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('test server did not receive a TCP port')
  }
  return address.port
}

async function closeServer(server: HttpServer | NetServer): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  })
}

afterEach(async () => {
  for (const socket of openSockets) socket.destroy()
  openSockets.clear()
  await Promise.all(openServers.splice(0).map(closeServer))
})

describe('waitForHttp', () => {
  it('rejects a persistent HTTP 200 response when waiting for shutdown', async () => {
    const server = createHttpServer((_request, response) => {
      response.writeHead(200).end('ok')
    })
    const port = await listen(server)

    await expect(
      waitForHttp(port, 'down', 30, { pollInterval: 1 }),
    ).rejects.toThrow(`port ${port} did not become down`)
  })

  it('accepts a failed connection as proof of shutdown', async () => {
    const server = createNetServer()
    const port = await listen(server)
    await closeServer(server)

    await expect(
      waitForHttp(port, 'down', 100, { pollInterval: 1 }),
    ).resolves.toBeUndefined()
  })

  it('accepts a normal HTTP 200 response as proof of startup', async () => {
    const server = createHttpServer((_request, response) => {
      response.writeHead(200).end('ok')
    })
    const port = await listen(server)

    await expect(
      waitForHttp(port, 'up', 100, { pollInterval: 1 }),
    ).resolves.toBeUndefined()
  })

  it('rejects shutdown when a listener accepts the request but never responds', async () => {
    const server = createNetServer((socket) => {
      openSockets.add(socket)
      socket.once('close', () => openSockets.delete(socket))
    })
    const port = await listen(server)

    let watchdog: ReturnType<typeof setTimeout> | undefined
    const outcome = await Promise.race([
      waitForHttp(port, 'down', 40, { pollInterval: 1 }).then(
        () => ({ state: 'resolved' as const }),
        (error: unknown) => ({ state: 'rejected' as const, error }),
      ),
      new Promise<{ state: 'watchdog' }>((resolve) => {
        watchdog = setTimeout(() => resolve({ state: 'watchdog' }), 250)
      }),
    ]).finally(() => clearTimeout(watchdog))

    expect(outcome.state).toBe('rejected')
    if (outcome.state === 'rejected') {
      expect(outcome.error).toEqual(
        new Error(`port ${port} did not become down`),
      )
    }
  })
})
