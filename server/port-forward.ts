import * as net from 'net'
import { logger } from './logger.js'
import { normalizeIp, type RequesterIdentity } from './request-ip.js'

const log = logger.child({ component: 'port-forward' })

interface ForwardEntry {
  /** Port the proxy listens on (assigned by OS) */
  localPort: number
  /** The localhost port being forwarded to */
  targetPort: number
  /** Requester identity key */
  requesterKey: string
  /** Requester IP (for logging) */
  requesterIp: string
  /** Allowed client IPs */
  allowedIps: Set<string>
  /** The TCP server accepting connections */
  server: net.Server
  /** Active client connections (for cleanup) */
  connections: Set<net.Socket>
  /** Timestamp of last connection activity */
  lastActivity: number
}

export interface PortForwardOptions {
  /** How long (ms) a forward can be idle before auto-cleanup. Default: 5 minutes. */
  idleTimeoutMs?: number
  /** Maximum number of active port forwards. Default: 100. */
  maxForwards?: number
}

export class PortForwardManager {
  private forwards = new Map<number, Map<string, ForwardEntry>>()
  private inflight = new Map<string, Promise<{ port: number }>>()
  private idleTimeoutMs: number
  private maxForwards: number
  private cleanupTimer: ReturnType<typeof setInterval> | null = null

  constructor(opts: PortForwardOptions = {}) {
    this.idleTimeoutMs = opts.idleTimeoutMs ?? 5 * 60 * 1000
    this.maxForwards = opts.maxForwards ?? 100
    this.startIdleCleanup()
  }

  /**
   * Create (or reuse) a TCP forward from a random OS-assigned port to
   * 127.0.0.1:<targetPort>. Returns the local port the proxy listens on.
   */
  async forward(
    targetPort: number,
    requester: RequesterIdentity,
  ): Promise<{ port: number }> {
    if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) {
      throw new Error(`Invalid target port: ${targetPort}`)
    }

    const existing = this.forwards.get(targetPort)?.get(requester.key)
    if (existing) {
      existing.lastActivity = Date.now()
      return { port: existing.localPort }
    }

    // Deduplicate concurrent requests for the same (targetPort, requesterKey)
    const inflightKey = `${targetPort}:${requester.key}`
    const pending = this.inflight.get(inflightKey)
    if (pending) return pending

    // Enforce maximum forwards limit
    if (this.activeForwardCount() >= this.maxForwards) {
      throw new Error(
        `Maximum port forwards (${this.maxForwards}) reached. Close unused forwards first.`,
      )
    }

    const promise = new Promise<{ port: number }>((resolve, reject) => {
      const server = net.createServer((clientSocket) => {
        const entry =
          this.forwards.get(targetPort)?.get(requester.key) ?? null
        const clientIp = normalizeIp(clientSocket.remoteAddress)

        if (!entry || !clientIp || !entry.allowedIps.has(clientIp)) {
          log.warn(
            {
              targetPort,
              localPort: entry?.localPort,
              requesterIp: entry?.requesterIp,
              requesterKey: entry?.requesterKey,
              clientIp,
            },
            'Port forward rejected connection from non-requester',
          )
          clientSocket.destroy()
          return
        }

        entry.lastActivity = Date.now()
        entry.connections.add(clientSocket)

        const targetSocket = net.createConnection(
          { host: '127.0.0.1', port: targetPort },
          () => {
            clientSocket.pipe(targetSocket)
            targetSocket.pipe(clientSocket)
          },
        )

        const cleanup = () => {
          clientSocket.destroy()
          targetSocket.destroy()
          entry.connections.delete(clientSocket)
        }

        clientSocket.on('error', cleanup)
        targetSocket.on('error', (err) => {
          // Propagate target errors to the client so it sees the failure
          clientSocket.destroy(err)
          targetSocket.destroy()
          entry.connections.delete(clientSocket)
        })
        clientSocket.on('close', cleanup)
        targetSocket.on('close', cleanup)
      })

      let resolved = false
      server.on('error', (err) => {
        if (!resolved) {
          reject(err)
        } else {
          log.error({ err, targetPort }, 'Port forward server error after listen')
        }
      })

      // Listen on port 0 → OS assigns an available port.
      // Bind to 0.0.0.0 so remote clients can reach it.
      server.listen(0, '0.0.0.0', () => {
        resolved = true
        const addr = server.address() as net.AddressInfo
        const entry: ForwardEntry = {
          localPort: addr.port,
          targetPort,
          requesterKey: requester.key,
          requesterIp: requester.ip,
          allowedIps: new Set(requester.allowedIps),
          server,
          connections: new Set(),
          lastActivity: Date.now(),
        }
        const targetMap = this.forwards.get(targetPort) ?? new Map<string, ForwardEntry>()
        targetMap.set(requester.key, entry)
        this.forwards.set(targetPort, targetMap)
        log.info(
          { targetPort, localPort: addr.port, requesterIp: requester.ip },
          'Port forward created',
        )
        resolve({ port: addr.port })
      })
    }).finally(() => {
      this.inflight.delete(inflightKey)
    })

    this.inflight.set(inflightKey, promise)
    return promise
  }

  /** Return the forwarded local port for a given target port, or undefined. */
  getForwardedPort(targetPort: number, requesterKey: string): number | undefined {
    return this.forwards.get(targetPort)?.get(requesterKey)?.localPort
  }

  /** Count total active forward entries across all target ports. */
  private activeForwardCount(): number {
    let count = 0
    for (const targetMap of this.forwards.values()) {
      count += targetMap.size
    }
    return count
  }

  /** Close a single forward by target port and requester key. */
  async close(targetPort: number, requesterKey?: string): Promise<void> {
    const targetMap = this.forwards.get(targetPort)
    if (!targetMap) return

    if (requesterKey) {
      const entry = targetMap.get(requesterKey)
      if (!entry) return
      await this.closeEntry(targetPort, entry, targetMap)
      if (targetMap.size === 0) {
        this.forwards.delete(targetPort)
      }
      return
    }

    await Promise.all([...targetMap.values()].map((entry) => this.closeEntry(targetPort, entry, targetMap)))
    if (targetMap.size === 0) {
      this.forwards.delete(targetPort)
    }
  }

  /** Close all active forwards and stop the idle-cleanup timer. */
  async closeAll(): Promise<void> {
    const closePromises: Promise<void>[] = []
    for (const [targetPort, targetMap] of [...this.forwards.entries()]) {
      for (const entry of [...targetMap.values()]) {
        closePromises.push(this.closeEntry(targetPort, entry, targetMap))
      }
      this.forwards.delete(targetPort)
    }
    this.inflight.clear()
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = null
    }
    await Promise.all(closePromises)
  }

  private startIdleCleanup(): void {
    this.cleanupTimer = setInterval(() => {
      const now = Date.now()
      for (const [targetPort, targetMap] of [...this.forwards]) {
        for (const entry of [...targetMap.values()]) {
          const idle = now - entry.lastActivity > this.idleTimeoutMs
          const noConnections = entry.connections.size === 0
          if (idle && noConnections) {
            log.info(
              { targetPort, localPort: entry.localPort, requesterIp: entry.requesterIp },
              'Port forward idle-closed',
            )
            void this.closeEntry(targetPort, entry, targetMap)
          }
        }
        if (targetMap.size === 0) {
          this.forwards.delete(targetPort)
        }
      }
    }, 60_000)

    // Don't let the timer keep the process alive
    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref()
    }
  }

  private async closeEntry(
    targetPort: number,
    entry: ForwardEntry,
    targetMap: Map<string, ForwardEntry>,
  ): Promise<void> {
    targetMap.delete(entry.requesterKey)
    for (const conn of entry.connections) {
      conn.destroy()
    }
    entry.connections.clear()
    await new Promise<void>((resolve) => {
      if (!entry.server.listening) {
        resolve()
        return
      }
      entry.server.close(() => resolve())
    })
    log.info(
      {
        targetPort,
        localPort: entry.localPort,
        requesterIp: entry.requesterIp,
      },
      'Port forward closed',
    )
  }
}
