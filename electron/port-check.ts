import net from 'net'

/**
 * Returns a probe that reports whether a TCP port can actually be bound on this
 * host right now. Unlike a reachability check against `localhost`, this attempts
 * a real `listen()` on all interfaces, so it also catches a port occupied on a
 * different local interface (e.g. a server bound to `0.0.0.0` under WSL or when
 * network access is enabled). Resolves `false` on any bind error, erring toward
 * "occupied" when uncertain rather than risk a doomed spawn.
 */
export function createPortAvailabilityCheck(): (port: number) => Promise<boolean> {
  return (port: number) =>
    new Promise<boolean>((resolve) => {
      const tester = net.createServer()
      tester.once('error', () => resolve(false))
      tester.once('listening', () => {
        tester.close(() => resolve(true))
      })
      tester.listen(port)
    })
}
