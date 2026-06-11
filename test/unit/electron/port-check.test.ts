import net from 'net'
import { describe, expect, it } from 'vitest'
import { createPortAvailabilityCheck } from '../../../electron/port-check.js'

function listenOnEphemeral(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.listen(0, () => {
      const port = (server.address() as net.AddressInfo).port
      resolve({
        port,
        close: () => new Promise<void>((done) => server.close(() => done())),
      })
    })
  })
}

describe('createPortAvailabilityCheck', () => {
  it('reports a port held by another listener as unavailable, and free once released', async () => {
    const isPortAvailable = createPortAvailabilityCheck()
    const { port, close } = await listenOnEphemeral()
    try {
      expect(await isPortAvailable(port)).toBe(false)
    } finally {
      await close()
    }
    expect(await isPortAvailable(port)).toBe(true)
  })
})
