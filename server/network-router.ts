import { Router } from 'express'
import { z } from 'zod'
import { spawnElevatedPowerShell } from './elevated-powershell.js'
import { logger } from './logger.js'
import { computeWslPortForwardingPlan } from './wsl-port-forward.js'

const log = logger.child({ component: 'network-router' })

export const NetworkConfigureSchema = z.object({
  host: z.enum(['127.0.0.1', '0.0.0.0']),
  configured: z.boolean(),
})

const ConfigureFirewallRequestSchema = z.object({
  confirmElevation: z.literal(true).optional(),
}).strict()

const WINDOWS_ELEVATION_CONFIRMATION = {
  method: 'confirmation-required',
  title: 'Administrator approval required',
  body: 'To complete this, you will need to accept the Windows administrator prompt on the next screen.',
  confirmLabel: 'Continue',
} as const

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

  const startElevatedRepair = (
    command: string,
    script: string,
    {
      completedLog,
      failedLog,
      spawnFailedLog,
    }: {
      completedLog: string
      failedLog: string
      spawnFailedLog: string
    },
  ) => {
    networkManager.setFirewallConfiguring(true)
    const child = spawnElevatedPowerShell(command, script, (err, _stdout, stderr) => {
      if (err) {
        log.error({ err, stderr }, failedLog)
      } else {
        log.info(completedLog)
      }
      networkManager.resetFirewallCache()
      networkManager.setFirewallConfiguring(false)
    })

    child.on('error', (err) => {
      log.error({ err }, spawnFailedLog)
      networkManager.resetFirewallCache()
      networkManager.setFirewallConfiguring(false)
    })
  }

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

  router.post('/network/configure-firewall', async (req, res) => {
    const parsed = ConfigureFirewallRequestSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid request', details: parsed.error.issues })
    }

    try {
      const status = await networkManager.getStatus()
      const confirmElevation = parsed.data.confirmElevation === true

      // In-flight guard: prevent concurrent elevated firewall processes
      if (status.firewall.configuring) {
        return res.status(409).json({
          error: 'Firewall configuration already in progress',
          method: 'in-progress',
        })
      }

      const commands = status.firewall.commands

      if (status.firewall.platform === 'wsl2') {
        const plan = computeWslPortForwardingPlan(networkManager.getRelevantPorts())

        if (plan.status === 'error') {
          log.error({ message: plan.message }, 'WSL2 port forwarding setup error')
          return res.status(500).json({ error: plan.message })
        }

        if (plan.status === 'not-wsl2' || plan.status === 'noop') {
          return res.json({ method: 'none', message: 'No configuration changes required' })
        }

        if (!confirmElevation) {
          return res.json(WINDOWS_ELEVATION_CONFIRMATION)
        }

        try {
          startElevatedRepair(
            '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
            plan.script,
            {
              completedLog: 'WSL2 port forwarding completed successfully',
              failedLog: 'WSL2 port forwarding failed',
              spawnFailedLog: 'Failed to spawn PowerShell for WSL2 port forwarding',
            },
          )
          return res.json({ method: 'wsl2', status: 'started' })
        } catch (err) {
          log.error({ err }, 'WSL2 port forwarding setup error')
          networkManager.setFirewallConfiguring(false)
          return res.status(500).json({ error: 'WSL2 port forwarding failed to start' })
        }
      }

      if (status.firewall.platform === 'windows') {
        if (commands.length === 0) {
          return res.json({ method: 'none', message: 'No firewall detected' })
        }

        if (!confirmElevation) {
          return res.json(WINDOWS_ELEVATION_CONFIRMATION)
        }

        const script = commands.join('; ')
        try {
          startElevatedRepair('powershell.exe', script, {
            completedLog: 'Windows firewall configured successfully',
            failedLog: 'Windows firewall configuration failed',
            spawnFailedLog: 'Failed to spawn PowerShell for Windows firewall',
          })
          return res.json({ method: 'windows-elevated', status: 'started' })
        } catch (err) {
          log.error({ err }, 'Windows firewall setup error')
          networkManager.setFirewallConfiguring(false)
          return res.status(500).json({ error: 'Windows firewall configuration failed to start' })
        }
      }

      if (commands.length === 0) {
        return res.json({ method: 'none', message: 'No firewall detected' })
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
