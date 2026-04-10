import net from 'node:net'

export type OpencodeServerEndpoint = {
  hostname: '127.0.0.1'
  port: number
}

// This is a best-effort ephemeral port reservation. There is an unavoidable race
// between closing this probe socket and the child process binding the same port,
// so callers must still be prepared to retry startup if OpenCode loses the bind.
export async function allocateLocalhostPort(): Promise<OpencodeServerEndpoint> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()

    const onError = (error: Error) => {
      server.close(() => reject(error))
    }

    server.once('error', onError)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to allocate a localhost control port for OpenCode.')))
        return
      }

      server.close((closeError) => {
        if (closeError) {
          reject(closeError)
          return
        }
        resolve({
          hostname: '127.0.0.1',
          port: address.port,
        })
      })
    })
  })
}
