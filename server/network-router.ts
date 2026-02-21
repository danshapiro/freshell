import { Router } from 'express'
import { z } from 'zod'
import { logger } from './logger.js'

const log = logger.child({ component: 'network-router' })

export const NetworkConfigureSchema = z.object({
  host: z.enum(['127.0.0.1', '0.0.0.0']),
  configured: z.boolean(),
})

export interface NetworkRouterDeps {
  networkManager: {
    getStatus: () => Promise<any>
    configure: (data: any) => Promise<{ rebindScheduled: boolean }>
    getRelevantPorts: () => number[]
    setFirewallConfiguring: (v: boolean) => void
    resetFirewallCache: () => void
  }
  configStore: {
    getSettings: () => Promise<any>
  }
  wsHandler: {
    broadcast: (msg: any) => void
  }
  detectLanIps: () => string[]
}

export function createNetworkRouter(deps: NetworkRouterDeps): Router {
  const { networkManager, configStore, wsHandler, detectLanIps } = deps
  const router = Router()

  router.get('/lan-info', (_req, res) => {
    res.json({ ips: detectLanIps() })
  })

  router.get('/network/status', async (_req, res) => {
    try {
      const status = await networkManager.getStatus()
      res.json(status)
    } catch (err) {
      log.error({ err }, 'Failed to get network status')
      res.status(500).json({ error: 'Failed to get network status' })
    }
  })

  router.post('/network/configure', async (req, res) => {
    const parsed = NetworkConfigureSchema.safeParse(req.body || {})
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid request', details: parsed.error.issues })
    }
    try {
      const { rebindScheduled } = await networkManager.configure(parsed.data)
      const status = await networkManager.getStatus()
      res.json({ ...status, rebindScheduled })
    } catch (err) {
      log.error({ err }, 'Failed to configure network')
      res.status(500).json({ error: 'Failed to configure network' })
      return
    }
    try {
      const fullSettings = await configStore.getSettings()
      wsHandler.broadcast({ type: 'settings.updated', settings: fullSettings })
    } catch (broadcastErr) {
      log.error({ err: broadcastErr }, 'Failed to broadcast settings after network configure')
    }
  })

  router.post('/network/configure-firewall', async (_req, res) => {
    try {
      const status = await networkManager.getStatus()

      // In-flight guard: prevent concurrent elevated firewall processes
      if (status.firewall.configuring) {
        return res.status(409).json({
          error: 'Firewall configuration already in progress',
          method: 'in-progress',
        })
      }

      const commands = status.firewall.commands

      if (commands.length === 0) {
        if (status.firewall.platform === 'wsl2') {
          const { execFile } = await import('node:child_process')
          const { buildPortForwardingScript, getWslIp } = await import('./wsl-port-forward.js')
          const POWERSHELL_PATH = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'
          try {
            const wslIp = getWslIp()
            if (!wslIp) {
              log.error('Failed to detect WSL2 IP address')
              return res.status(500).json({ error: 'Could not detect WSL2 IP address' })
            }
            const ports = networkManager.getRelevantPorts()
            const rawScript = buildPortForwardingScript(wslIp, ports)
            const script = rawScript.replace(/\\\$/g, '$')
            const escapedScript = script.replace(/'/g, "''")
            networkManager.setFirewallConfiguring(true)
            const child = execFile(POWERSHELL_PATH, [
              '-Command',
              `Start-Process powershell -Verb RunAs -Wait -ArgumentList '-Command', '${escapedScript}'`,
            ], { timeout: 120000 }, (err, _stdout, stderr) => {
              if (err) {
                log.error({ err, stderr }, 'WSL2 port forwarding failed')
              } else {
                log.info('WSL2 port forwarding completed successfully')
              }
              networkManager.resetFirewallCache()
              networkManager.setFirewallConfiguring(false)
            })
            child.on('error', (err) => {
              log.error({ err }, 'Failed to spawn PowerShell for WSL2 port forwarding')
              networkManager.resetFirewallCache()
              networkManager.setFirewallConfiguring(false)
            })
            return res.json({ method: 'wsl2', status: 'started' })
          } catch (err) {
            log.error({ err }, 'WSL2 port forwarding setup error')
            networkManager.setFirewallConfiguring(false)
            return res.status(500).json({ error: 'WSL2 port forwarding failed to start' })
          }
        }
        return res.json({ method: 'none', message: 'No firewall detected' })
      }

      if (status.firewall.platform === 'windows') {
        const { execFile } = await import('node:child_process')
        const script = commands.join('; ')
        const escapedScript = script.replace(/'/g, "''")
        try {
          networkManager.setFirewallConfiguring(true)
          const child = execFile('powershell.exe', [
            '-Command',
            `Start-Process powershell -Verb RunAs -Wait -ArgumentList '-Command', '${escapedScript}'`,
          ], { timeout: 120000 }, (err, _stdout, stderr) => {
            if (err) {
              log.error({ err, stderr }, 'Windows firewall configuration failed')
            } else {
              log.info('Windows firewall configured successfully')
            }
            networkManager.resetFirewallCache()
            networkManager.setFirewallConfiguring(false)
          })
          child.on('error', (err) => {
            log.error({ err }, 'Failed to spawn PowerShell for Windows firewall')
            networkManager.resetFirewallCache()
            networkManager.setFirewallConfiguring(false)
          })
          return res.json({ method: 'windows-elevated', status: 'started' })
        } catch (err) {
          log.error({ err }, 'Windows firewall setup error')
          networkManager.setFirewallConfiguring(false)
          return res.status(500).json({ error: 'Windows firewall configuration failed to start' })
        }
      }

      // Linux/macOS: return command for client to run in a terminal pane
      const command = commands.join(' && ')
      res.json({ method: 'terminal', command })
    } catch (err) {
      log.error({ err }, 'Firewall configuration error')
      res.status(500).json({ error: 'Firewall configuration failed' })
    }
  })

  return router
}
