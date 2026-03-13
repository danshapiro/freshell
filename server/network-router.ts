import { randomUUID } from 'node:crypto'
import { Router } from 'express'
import { z } from 'zod'
import { spawnElevatedPowerShell } from './elevated-powershell.js'
import { logger } from './logger.js'
import { computeWslPortForwardingPlanAsync } from './wsl-port-forward.js'

const log = logger.child({ component: 'network-router' })

export const NetworkConfigureSchema = z.object({
  host: z.enum(['127.0.0.1', '0.0.0.0']),
  configured: z.boolean(),
})

const ConfigureFirewallRequestSchema = z.object({
  confirmElevation: z.literal(true).optional(),
  confirmationToken: z.string().min(1).optional(),
}).strict()

const WINDOWS_ELEVATION_CONFIRMATION = {
  method: 'confirmation-required',
  title: 'Administrator approval required',
  body: 'To complete this, you will need to accept the Windows administrator prompt on the next screen.',
  confirmLabel: 'Continue',
} as const

const NO_CONFIGURATION_CHANGES_REQUIRED = {
  method: 'none',
  message: 'No configuration changes required',
} as const

const REMOTE_ACCESS_DISABLED = {
  method: 'none',
  message: 'Remote access is not enabled',
} as const

type RepairPlatform = 'windows' | 'wsl2'

type ConfirmableRepairAction = {
  kind: 'confirmable'
  platform: RepairPlatform
  script: string
  responseMethod: 'windows-elevated' | 'wsl2'
}

type RepairActionResolution =
  | { kind: 'none'; response: { method: 'none'; message: string } }
  | { kind: 'terminal'; response: { method: 'terminal'; command: string } }
  | ConfirmableRepairAction

function isRemoteAccessEnabled(
  settings: { network?: { host?: string; configured?: boolean } },
  effectiveHost: '127.0.0.1' | '0.0.0.0',
  firewallPlatform: string,
): boolean {
  if (settings.network?.host === '0.0.0.0') {
    return true
  }

  if (firewallPlatform === 'wsl2') {
    return false
  }

  return settings.network?.configured !== true && effectiveHost === '0.0.0.0'
}

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
  const FIREWALL_REPAIR_LOCKED = Symbol('FIREWALL_REPAIR_LOCKED')
  let currentConfirmation: { token: string; platform: RepairPlatform } | null = null
  let confirmedRepairInFlight = false

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

  const issueConfirmation = (platform: RepairPlatform) => {
    const confirmationToken = randomUUID()
    currentConfirmation = { token: confirmationToken, platform }
    return {
      ...WINDOWS_ELEVATION_CONFIRMATION,
      confirmationToken,
    }
  }

  const matchesConfirmation = (token: string | undefined, platform: RepairPlatform) => {
    return currentConfirmation !== null
      && currentConfirmation.token === token
      && currentConfirmation.platform === platform
  }

  const consumeConfirmation = (token: string | undefined, platform: RepairPlatform) => {
    if (!matchesConfirmation(token, platform)) {
      return false
    }

    currentConfirmation = null
    return true
  }

  const withConfirmedRepairLock = async <T,>(fn: () => Promise<T>) => {
    if (confirmedRepairInFlight) {
      return FIREWALL_REPAIR_LOCKED
    }

    confirmedRepairInFlight = true
    try {
      return await fn()
    } finally {
      confirmedRepairInFlight = false
    }
  }

  const resolveRepairAction = async (
    status: Awaited<ReturnType<NetworkRouterDeps['networkManager']['getStatus']>>,
    settings: Awaited<ReturnType<NetworkRouterDeps['configStore']['getSettings']>>,
  ): Promise<RepairActionResolution> => {
    if (!isRemoteAccessEnabled(settings, status.host, status.firewall.platform)) {
      return { kind: 'none', response: REMOTE_ACCESS_DISABLED }
    }

    if (status.firewall.platform === 'wsl2') {
      if (status.firewall.portOpen === true) {
        return { kind: 'none', response: NO_CONFIGURATION_CHANGES_REQUIRED }
      }

      const plan = await computeWslPortForwardingPlanAsync(networkManager.getRelevantPorts())
      if (plan.status === 'error') {
        throw new Error(plan.message)
      }
      if (plan.status === 'noop' || plan.status === 'not-wsl2') {
        return { kind: 'none', response: NO_CONFIGURATION_CHANGES_REQUIRED }
      }

      return {
        kind: 'confirmable',
        platform: 'wsl2',
        script: plan.script,
        responseMethod: 'wsl2',
      }
    }

    if (status.firewall.platform === 'windows') {
      if (status.firewall.commands.length === 0) {
        return { kind: 'none', response: { method: 'none', message: 'No firewall detected' } }
      }
      if (status.firewall.portOpen === true) {
        return { kind: 'none', response: NO_CONFIGURATION_CHANGES_REQUIRED }
      }

      return {
        kind: 'confirmable',
        platform: 'windows',
        script: status.firewall.commands.join('; '),
        responseMethod: 'windows-elevated',
      }
    }

    if (status.firewall.commands.length === 0) {
      return { kind: 'none', response: { method: 'none', message: 'No firewall detected' } }
    }

    return {
      kind: 'terminal',
      response: { method: 'terminal', command: status.firewall.commands.join(' && ') },
    }
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
      const confirmElevation = parsed.data.confirmElevation === true
      const confirmationToken = parsed.data.confirmationToken
      const [status, settings] = await Promise.all([
        networkManager.getStatus(),
        configStore.getSettings(),
      ])
      const action = await resolveRepairAction(status, settings)

      if (action.kind === 'none' || action.kind === 'terminal') {
        return res.json(action.response)
      }

      if (!confirmElevation || !matchesConfirmation(confirmationToken, action.platform)) {
        return res.json(issueConfirmation(action.platform))
      }

      const lockedResult = await withConfirmedRepairLock(async () => {
        const [freshStatus, freshSettings] = await Promise.all([
          networkManager.getStatus(),
          configStore.getSettings(),
        ])
        const freshAction = await resolveRepairAction(freshStatus, freshSettings)

        if (freshAction.kind === 'none' || freshAction.kind === 'terminal') {
          return { status: 200 as const, body: freshAction.response }
        }

        if (!consumeConfirmation(confirmationToken, freshAction.platform)) {
          return {
            status: 200 as const,
            body: issueConfirmation(freshAction.platform),
          }
        }

        try {
          startElevatedRepair(
            freshAction.platform === 'wsl2'
              ? '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'
              : 'powershell.exe',
            freshAction.script,
            freshAction.platform === 'wsl2'
              ? {
                completedLog: 'WSL2 port forwarding completed successfully',
                failedLog: 'WSL2 port forwarding failed',
                spawnFailedLog: 'Failed to spawn PowerShell for WSL2 port forwarding',
              }
              : {
                completedLog: 'Windows firewall configured successfully',
                failedLog: 'Windows firewall configuration failed',
                spawnFailedLog: 'Failed to spawn PowerShell for Windows firewall',
              },
          )

          return {
            status: 200 as const,
            body: { method: freshAction.responseMethod, status: 'started' as const },
          }
        } catch (err) {
          log.error(
            { err },
            freshAction.platform === 'wsl2'
              ? 'WSL2 port forwarding setup error'
              : 'Windows firewall setup error',
          )
          networkManager.setFirewallConfiguring(false)
          return {
            status: 500 as const,
            body: {
              error: freshAction.platform === 'wsl2'
                ? 'WSL2 port forwarding failed to start'
                : 'Windows firewall configuration failed to start',
            },
          }
        }
      })

      if (lockedResult === FIREWALL_REPAIR_LOCKED) {
        return res.status(409).json({
          error: 'Firewall configuration already in progress',
          method: 'in-progress',
        })
      }

      return res.status(lockedResult.status).json(lockedResult.body)
    } catch (err) {
      log.error({ err }, 'Firewall configuration error')
      res.status(500).json({ error: 'Firewall configuration failed' })
    }
  })

  return router
}
