import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest'
import * as net from 'net'
import { PortForwardManager } from '../../../server/port-forward.js'
import { createRequesterIdentity } from '../../../server/request-ip.js'

// Helper: create a TCP server on localhost that echoes data back
function createEchoServer(): Promise<{ server: net.Server; port: number }> {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      socket.pipe(socket)
    })
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as net.AddressInfo
      resolve({ server, port: addr.port })
    })
  })
}

// Helper: connect to a TCP port and send/receive data
function tcpExchange(
  host: string,
  port: number,
  data: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false
    const settle = (fn: () => void) => {
      if (!settled) {
        settled = true
        fn()
      }
    }

    const socket = net.createConnection({ host, port }, () => {
      socket.write(data)
    })
    const chunks: Buffer[] = []
    socket.on('data', (chunk) => {
      chunks.push(chunk)
      const received = Buffer.concat(chunks).toString()
      if (received.length >= data.length) {
        socket.end()
        settle(() => resolve(received))
      }
    })
    socket.on('error', (err) => settle(() => reject(err)))
    socket.on('close', () => {
      settle(() => {
        const received = Buffer.concat(chunks).toString()
        if (received.length > 0) resolve(received)
        else reject(new Error('Connection closed without data'))
      })
    })
    socket.setTimeout(5000, () => {
      socket.destroy(new Error('TCP exchange timeout'))
    })
  })
}

// Helper: find a port that nothing is listening on
async function findUnusedPort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port
      srv.close(() => resolve(port))
    })
  })
}

describe('PortForwardManager', () => {
  let manager: PortForwardManager
  let echoServer: net.Server | null = null

  beforeEach(() => {
    manager = new PortForwardManager({ idleTimeoutMs: 60_000 })
  })

  afterEach(async () => {
    await manager.closeAll()
    if (echoServer) {
      echoServer.close()
      echoServer = null
    }
  })

  describe('forward()', () => {
    it('creates a TCP forwarding proxy to the target port', async () => {
      const echo = await createEchoServer()
      echoServer = echo.server

      const result = await manager.forward(
        echo.port,
        createRequesterIdentity('127.0.0.1'),
      )
      expect(result.port).toBeGreaterThan(0)
      expect(result.port).not.toBe(echo.port)

      // Connect through the forward and verify data is piped
      const response = await tcpExchange('127.0.0.1', result.port, 'hello')
      expect(response).toBe('hello')
    })

    it('reuses an existing forward for the same target port', async () => {
      const echo = await createEchoServer()
      echoServer = echo.server

      const first = await manager.forward(
        echo.port,
        createRequesterIdentity('127.0.0.1'),
      )
      const second = await manager.forward(
        echo.port,
        createRequesterIdentity('127.0.0.1'),
      )

      expect(first.port).toBe(second.port)
    })

    it('creates separate forwards for different target ports', async () => {
      const echo1 = await createEchoServer()
      const echo2 = await createEchoServer()

      const forward1 = await manager.forward(
        echo1.port,
        createRequesterIdentity('127.0.0.1'),
      )
      const forward2 = await manager.forward(
        echo2.port,
        createRequesterIdentity('127.0.0.1'),
      )

      expect(forward1.port).not.toBe(forward2.port)

      echo1.server.close()
      echo2.server.close()
    })

    it('rejects invalid port numbers', async () => {
      await expect(
        manager.forward(0, createRequesterIdentity('127.0.0.1')),
      ).rejects.toThrow()
      await expect(
        manager.forward(70000, createRequesterIdentity('127.0.0.1')),
      ).rejects.toThrow()
      await expect(
        manager.forward(-1, createRequesterIdentity('127.0.0.1')),
      ).rejects.toThrow()
    })

    it('rejects when max forwards limit is reached', async () => {
      const limitedManager = new PortForwardManager({
        idleTimeoutMs: 60_000,
        maxForwards: 2,
      })
      const echo1 = await createEchoServer()
      const echo2 = await createEchoServer()
      const echo3 = await createEchoServer()

      await limitedManager.forward(echo1.port, createRequesterIdentity('127.0.0.1'))
      await limitedManager.forward(echo2.port, createRequesterIdentity('127.0.0.1'))

      await expect(
        limitedManager.forward(echo3.port, createRequesterIdentity('127.0.0.1')),
      ).rejects.toThrow(/Maximum port forwards/)

      await limitedManager.closeAll()
      echo1.server.close()
      echo2.server.close()
      echo3.server.close()
    })

    it('handles connection errors when target is not listening', async () => {
      // Forward to a port nothing is listening on
      const unusedPort = await findUnusedPort()
      const result = await manager.forward(
        unusedPort,
        createRequesterIdentity('127.0.0.1'),
      )

      // The forward itself succeeds (TCP server starts)
      expect(result.port).toBeGreaterThan(0)

      // But connecting through it should fail (ECONNREFUSED from target)
      await expect(
        tcpExchange('127.0.0.1', result.port, 'hello'),
      ).rejects.toThrow()
    })

    it('creates separate forwards for the same target port and different requesters', async () => {
      const echo = await createEchoServer()
      echoServer = echo.server

      const forwardA = await manager.forward(
        echo.port,
        createRequesterIdentity('127.0.0.1'),
      )
      const forwardB = await manager.forward(
        echo.port,
        createRequesterIdentity('10.0.0.5'),
      )

      expect(forwardA.port).not.toBe(forwardB.port)
    })

    it('deduplicates concurrent forward requests for the same target and requester', async () => {
      const echo = await createEchoServer()
      echoServer = echo.server

      const requester = createRequesterIdentity('127.0.0.1')
      const [a, b] = await Promise.all([
        manager.forward(echo.port, requester),
        manager.forward(echo.port, requester),
      ])

      // Both should get the same port (not two separate servers)
      expect(a.port).toBe(b.port)

      // Verify it works
      const response = await tcpExchange('127.0.0.1', a.port, 'hello')
      expect(response).toBe('hello')
    })

    it('drops connections from other IPs', async () => {
      const echo = await createEchoServer()
      echoServer = echo.server

      const result = await manager.forward(
        echo.port,
        createRequesterIdentity('10.0.0.1'),
      )

      await expect(
        tcpExchange('127.0.0.1', result.port, 'hello'),
      ).rejects.toThrow()
    })
  })

  describe('close()', () => {
    it('closes the forward and frees the port', async () => {
      const echo = await createEchoServer()
      echoServer = echo.server

      const result = await manager.forward(
        echo.port,
        createRequesterIdentity('127.0.0.1'),
      )

      // Verify forward works
      const response = await tcpExchange('127.0.0.1', result.port, 'test')
      expect(response).toBe('test')

      // Close the forward
      await manager.close(echo.port, createRequesterIdentity('127.0.0.1').key)

      // Verify forward is gone (connection should fail)
      await expect(
        tcpExchange('127.0.0.1', result.port, 'test'),
      ).rejects.toThrow()
    })

    it('is a no-op for non-existent forwards', async () => {
      // Should not throw
      await manager.close(99999)
    })

    it('allows re-creating a forward after closing', async () => {
      const echo = await createEchoServer()
      echoServer = echo.server

      const first = await manager.forward(
        echo.port,
        createRequesterIdentity('127.0.0.1'),
      )
      await manager.close(echo.port, createRequesterIdentity('127.0.0.1').key)

      const second = await manager.forward(
        echo.port,
        createRequesterIdentity('127.0.0.1'),
      )
      // May or may not get the same port, but it should work
      const response = await tcpExchange('127.0.0.1', second.port, 'again')
      expect(response).toBe('again')
    })
  })

  describe('closeAll()', () => {
    it('closes all active forwards', async () => {
      const echo1 = await createEchoServer()
      const echo2 = await createEchoServer()

      const f1 = await manager.forward(
        echo1.port,
        createRequesterIdentity('127.0.0.1'),
      )
      const f2 = await manager.forward(
        echo2.port,
        createRequesterIdentity('127.0.0.1'),
      )

      await manager.closeAll()

      await expect(
        tcpExchange('127.0.0.1', f1.port, 'test'),
      ).rejects.toThrow()
      await expect(
        tcpExchange('127.0.0.1', f2.port, 'test'),
      ).rejects.toThrow()

      echo1.server.close()
      echo2.server.close()
    })
  })

  describe('getForwardedPort()', () => {
    it('returns the forwarded port for an active forward', async () => {
      const echo = await createEchoServer()
      echoServer = echo.server

      const requester = createRequesterIdentity('127.0.0.1')
      const result = await manager.forward(echo.port, requester)
      expect(manager.getForwardedPort(echo.port, requester.key)).toBe(result.port)
    })

    it('returns undefined for non-existent forwards', () => {
      expect(
        manager.getForwardedPort(12345, createRequesterIdentity('127.0.0.1').key),
      ).toBeUndefined()
    })
  })

  describe('idle timeout', () => {
    it('cleans up forwards after idle timeout with no active connections', async () => {
      vi.useFakeTimers()

      const shortManager = new PortForwardManager({ idleTimeoutMs: 1000 })
      const echo = await createEchoServer()
      echoServer = echo.server

      const requester = createRequesterIdentity('127.0.0.1')
      await shortManager.forward(echo.port, requester)
      expect(shortManager.getForwardedPort(echo.port, requester.key)).toBeDefined()

      // Advance past idle timeout + cleanup interval
      vi.advanceTimersByTime(70_000)

      expect(shortManager.getForwardedPort(echo.port, requester.key)).toBeUndefined()

      await shortManager.closeAll()
      vi.useRealTimers()
    })
  })
})
