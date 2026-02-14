import http from 'node:http'
import os from 'node:os'
import isPortReachable from 'is-port-reachable'
import { Bonjour } from 'bonjour-service'
import { detectLanIps } from './bootstrap.js'
import { detectFirewall, firewallCommands, type FirewallInfo, type FirewallPlatform } from './firewall.js'
import type { ConfigStore, NetworkSettings } from './config-store.js'
import { logger } from './logger.js'

const log = logger.child({ component: 'network-manager' })

export interface NetworkStatus {
  configured: boolean
  host: '127.0.0.1' | '0.0.0.0'
  port: number
  lanIps: string[]
  machineHostname: string
  mdns: { enabled: boolean; hostname: string } | null
  firewall: {
    platform: FirewallPlatform
    active: boolean
    portOpen: boolean | null
    commands: string[]
    configuring: boolean
  }
  rebinding: boolean
  devMode: boolean
  devPort?: number
  accessUrl: string
}

export class NetworkManager {
  private bonjour: InstanceType<typeof Bonjour> | null = null
  private firewallInfo: FirewallInfo | null = null
  private lanIps: string[] = []
  private lanIpsInitialized = false
  private wsHandler: {
    prepareForRebind(): void
    resumeAfterRebind(): void
    broadcast(msg: unknown): void
  } | null = null
  private rebindInFlight = false
  private pendingRebindConfig: NetworkSettings | null = null
  private firewallConfiguring = false

  constructor(
    private server: http.Server,
    private configStore: ConfigStore,
    private port: number,
    private devMode: boolean = false,
    private devPort?: number,
  ) {}

  setWsHandler(handler: {
    prepareForRebind(): void
    resumeAfterRebind(): void
    broadcast(msg: unknown): void
  }): void {
    this.wsHandler = handler
  }

  async getStatus(): Promise<NetworkStatus> {
    const settings = await this.configStore.getSettings()
    const network = settings.network

    this.ensureLanIps()

    if (!this.firewallInfo) {
      this.firewallInfo = await detectFirewall()
    }

    const ports = this.getRelevantPorts()

    const effectiveHost = (!network.configured && (process.env.HOST === '0.0.0.0' || process.env.HOST === '127.0.0.1'))
      ? process.env.HOST as '127.0.0.1' | '0.0.0.0'
      : network.host

    const probePort = this.devMode && this.devPort ? this.devPort : this.port
    let portOpen: boolean | null = null
    if (effectiveHost === '0.0.0.0' && this.lanIps.length > 0) {
      try {
        portOpen = await isPortReachable(probePort, { host: this.lanIps[0], timeout: 2000 })
      } catch {
        portOpen = null
      }
    }

    const commands = this.firewallInfo.active
      ? firewallCommands(this.firewallInfo.platform, ports)
      : []

    const token = process.env.AUTH_TOKEN ?? ''
    const accessHost = effectiveHost === '0.0.0.0'
      ? (this.lanIps[0] ?? 'localhost')
      : 'localhost'
    const accessPort = this.devMode && this.devPort ? this.devPort : this.port
    const accessUrl = `http://${accessHost}:${accessPort}/?token=${encodeURIComponent(token)}`

    return {
      configured: network.configured,
      host: effectiveHost,
      port: this.port,
      lanIps: this.lanIps,
      machineHostname: os.hostname().replace(/\.local$/, ''),
      mdns: effectiveHost === '0.0.0.0' ? network.mdns : null,
      firewall: {
        platform: this.firewallInfo.platform,
        active: this.firewallInfo.active,
        portOpen,
        commands,
        configuring: this.firewallConfiguring,
      },
      rebinding: this.rebindInFlight,
      devMode: this.devMode,
      devPort: this.devPort,
      accessUrl,
    }
  }

  async configure(network: NetworkSettings): Promise<{ rebindScheduled: boolean }> {
    const currentSettings = await this.configStore.getSettings()
    const currentNetwork = currentSettings.network
    const effectiveCurrentHost = (!currentNetwork.configured && (process.env.HOST === '0.0.0.0' || process.env.HOST === '127.0.0.1'))
      ? process.env.HOST
      : currentNetwork.host
    const hostChanged = effectiveCurrentHost !== network.host

    await this.configStore.patchSettings({ network })

    if (network.mdns.enabled && network.host === '0.0.0.0') {
      this.startMdns(network.mdns.hostname)
    } else {
      this.stopMdns()
    }

    this.firewallInfo = null
    this.refreshLanIps()

    if (hostChanged && this.server.listening) {
      if (this.rebindInFlight) {
        log.warn({ host: network.host }, 'Rebind in flight, queuing configure')
        this.pendingRebindConfig = network
        return { rebindScheduled: true }
      }
      this.rebindInFlight = true
      setImmediate(() => {
        this.rebind(network.host).catch((err) => {
          log.error({ err }, 'Hot rebind failed')
        })
      })
      return { rebindScheduled: true }
    }

    return { rebindScheduled: false }
  }

  async initializeFromStartup(
    effectiveHost: '127.0.0.1' | '0.0.0.0',
    network: NetworkSettings,
  ): Promise<void> {
    if (network.mdns.enabled && effectiveHost === '0.0.0.0') {
      this.startMdns(network.mdns.hostname)
    } else {
      this.stopMdns()
    }

    this.refreshLanIps()
    await this.rebuildAllowedOrigins()
  }

  private async rebind(host: string): Promise<void> {
    if (!this.rebindInFlight) {
      log.error({ host }, 'rebind() called without rebindInFlight set')
      this.rebindInFlight = true
    }

    const addr = this.server.address()
    const oldHost = (addr && typeof addr === 'object') ? addr.address : '127.0.0.1'

    log.info({ host, port: this.port, oldHost }, 'Hot rebinding server')

    if (this.wsHandler) {
      log.info('Preparing WsHandler for rebind')
      this.wsHandler.prepareForRebind()
    }

    try {
      await new Promise<void>((resolve, reject) => {
        this.server.close((err) => {
          if (err) {
            log.error({ err }, 'Failed to close server for rebind')
            reject(err)
            return
          }

          const onListenError = (listenErr: Error) => {
            log.error({ err: listenErr, host }, 'Failed to rebind server to new host')

            const onRollbackError = (rollbackErr: Error) => {
              log.error(
                { err: rollbackErr, originalErr: listenErr, oldHost, port: this.port },
                'CATASTROPHIC: Rollback bind also failed — server has no active listener',
              )
              reject(listenErr)
            }
            this.server.once('error', onRollbackError)
            this.server.listen(this.port, oldHost, async () => {
              this.server.removeListener('error', onRollbackError)
              log.warn({ oldHost, port: this.port }, 'Rolled back to previous bind address')

              if (oldHost === '127.0.0.1') {
                this.stopMdns()
              }

              try {
                await this.configStore.patchSettings({
                  network: { host: oldHost as '127.0.0.1' | '0.0.0.0' },
                } as any)
                if (oldHost === '0.0.0.0') {
                  const rolledBackSettings = await this.configStore.getSettings()
                  if (rolledBackSettings.network.mdns.enabled) {
                    this.startMdns(rolledBackSettings.network.mdns.hostname)
                  }
                }
                await this.rebuildAllowedOrigins()
                if (this.wsHandler) {
                  const correctedSettings = await this.configStore.getSettings()
                  this.wsHandler.broadcast({
                    type: 'settings.updated',
                    settings: correctedSettings,
                  })
                }
              } catch (patchErr) {
                log.error({ err: patchErr }, 'Failed to revert config/origins after rebind failure')
              }
              reject(listenErr)
            })
          }
          this.server.once('error', onListenError)

          this.server.listen(this.port, host, () => {
            this.server.removeListener('error', onListenError)
            log.info({ host, port: this.port }, 'Server rebound successfully')
            resolve()
          })
        })
      })
    } finally {
      if (this.wsHandler) {
        this.wsHandler.resumeAfterRebind()
        log.info('WsHandler resumed after rebind')
      }
      this.rebindInFlight = false

      const queuedConfig = this.pendingRebindConfig
      this.pendingRebindConfig = null
      if (queuedConfig !== null) {
        log.info({ host: queuedConfig.host }, 'Processing queued configure')
        setImmediate(() => {
          this.configure(queuedConfig).catch((err) => {
            log.error({ err }, 'Queued configure failed')
          })
        })
      }
    }
  }

  private startMdns(hostname: string): void {
    this.stopMdns()
    try {
      this.bonjour = new Bonjour()
      const port = this.devMode && this.devPort ? this.devPort : this.port
      this.bonjour.publish({ name: hostname, type: 'http', port })
      log.info({ hostname, port }, 'mDNS service published')
    } catch (err) {
      log.warn({ err }, 'Failed to start mDNS')
    }
  }

  private stopMdns(): void {
    if (this.bonjour) {
      this.bonjour.unpublishAll()
      this.bonjour.destroy()
      this.bonjour = null
    }
  }

  resetFirewallCache(): void {
    this.firewallInfo = null
  }

  setFirewallConfiguring(configuring: boolean): void {
    this.firewallConfiguring = configuring
  }

  getRelevantPorts(): number[] {
    const ports = [this.port]
    if (this.devMode && this.devPort && this.devPort !== this.port) {
      ports.push(this.devPort)
    }
    return ports
  }

  private ensureLanIps(): void {
    if (!this.lanIpsInitialized) {
      this.refreshLanIps()
      this.lanIpsInitialized = true
    }
  }

  private refreshLanIps(): void {
    try {
      this.lanIps = detectLanIps()
    } catch {
      this.lanIps = []
    }
  }

  // Stub — implemented in Task 12 when buildAllowedOrigins() is added
  async rebuildAllowedOrigins(): Promise<void> {}

  async stop(): Promise<void> {
    this.stopMdns()
  }
}
