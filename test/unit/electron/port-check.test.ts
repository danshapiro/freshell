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
  it('reports a port held by another listener as unavailable', async () => {
    const isPortAvailable = createPortAvailabilityCheck()
    const { port, close } = await listenOnEphemeral()
    try {
      expect(await isPortAvailable(port)).toBe(false)
    } finally {
      await close()
    }
  })

  it('reports an OS-selected port as available', async () => {
    // Avoid racing another local listener to claim the released ephemeral port.
    const isPortAvailable = createPortAvailabilityCheck()
    expect(await isPortAvailable(0)).toBe(true)
  })
})
