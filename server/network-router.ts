import { randomUUID } from 'node:crypto'
import { Router } from 'express'
import { z } from 'zod'
import { spawnElevatedPowerShell } from './elevated-powershell.js'
import { logger } from './logger.js'
import { buildWindowsFirewallDeleteCommands } from './network-manager.js'
import { isRemoteAccessEnabled } from './network-access.js'
import {
  clearManagedWslRemoteAccessPorts,
  computeWslPortForwardingPlanAsync,
  computeWslPortForwardingTeardownPlanAsync,
  persistManagedWslRemoteAccessPorts,
} from './wsl-port-forward.js'
import type { ServerSettings } from '../shared/settings.js'

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

const REMOTE_ACCESS_DISABLED_SUCCESS = {
  method: 'none',
  message: 'Remote access disabled',
} as const

type ConfirmationAction = 'windows-disable' | 'windows-repair' | 'wsl2-repair' | 'wsl2-disable'

type ConfirmableRepairAction = {
  kind: 'confirmable'
  confirmationAction: ConfirmationAction
  script: string
  responseMethod: 'windows-elevated' | 'wsl2'
}

type RepairActionResolution =
  | { kind: 'error'; error: string }
  | { kind: 'none'; response: { method: 'none'; message: string } }
  | { kind: 'terminal'; response: { method: 'terminal'; command: string } }
  | ConfirmableRepairAction

export interface NetworkRouterDeps {
  networkManager: {
    getStatus: () => Promise<any>
    configure: (data: any) => Promise<{ rebindScheduled: boolean }>
    getManagedWindowsRemoteAccessPorts: () => Promise<number[]>
    getRelevantPorts: () => number[]
    getRemoteAccessPorts: () => number[]
    persistManagedWindowsRemoteAccessPorts: () => Promise<void>
    setFirewallConfiguring: (v: boolean) => void
    clearManagedWindowsRemoteAccessPorts: () => Promise<void>
    resetFirewallCache: () => void
  }
  configStore: {
    getSettings: () => Promise<ServerSettings>
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
  let currentConfirmation: { token: string; action: ConfirmationAction } | null = null
  let confirmedRepairInFlight = false

  const getCurrentConfirmation = () => currentConfirmation

  const consumeCurrentConfirmation = (token: string | undefined) => {
    const confirmation = getCurrentConfirmation()
    if (confirmation === null || confirmation.token !== token) {
      return false
    }

    currentConfirmation = null
    return true
  }

  const broadcastSettingsUpdated = async () => {
    try {
      const fullSettings = await configStore.getSettings()
      wsHandler.broadcast({ type: 'settings.updated', settings: fullSettings })
    } catch (broadcastErr) {
      log.error({ err: broadcastErr }, 'Failed to broadcast settings after network configure')
    }
  }

  const applyRemoteAccessSetting = async (host: '127.0.0.1' | '0.0.0.0') => {
    await networkManager.configure({ host, configured: true })
    await broadcastSettingsUpdated()
  }

  const applyRemoteAccessDisabledState = async (
    platform: Awaited<ReturnType<NetworkRouterDeps['networkManager']['getStatus']>>['firewall']['platform'],
  ) => {
    await applyRemoteAccessSetting('127.0.0.1')
    if (platform === 'wsl2') {
      await clearManagedWslRemoteAccessPortsSafe()
    } else if (platform === 'windows') {
      try {
        await networkManager.clearManagedWindowsRemoteAccessPorts()
      } catch (err) {
        log.error({ err }, 'Failed to clear managed Windows remote access ports')
      }
    }
  }

  const persistCurrentWslRemoteAccessPorts = async () => {
    try {
      await persistManagedWslRemoteAccessPorts(networkManager.getRemoteAccessPorts())
    } catch (err) {
      log.error({ err }, 'Failed to persist managed WSL remote access ports')
    }
  }

  const clearManagedWslRemoteAccessPortsSafe = async () => {
    try {
      await clearManagedWslRemoteAccessPorts()
    } catch (err) {
      log.error({ err }, 'Failed to clear managed WSL remote access ports')
    }
  }

  const startElevatedRepair = (
    command: string,
    script: string,
    {
      completedLog,
      failedLog,
      spawnFailedLog,
      verifySuccess,
      onSuccess,
      releaseConfirmedRepair,
    }: {
      completedLog: string
      failedLog: string
      spawnFailedLog: string
      verifySuccess?: () => Promise<void>
      onSuccess?: () => Promise<void> | void
      releaseConfirmedRepair: () => void
    },
  ) => {
    let settled = false
    const settleRepair = () => {
      if (settled) {
        return
      }
      settled = true
      releaseConfirmedRepair()
    }

    try {
      const child = spawnElevatedPowerShell(command, script, (err, _stdout, stderr) => {
        void (async () => {
          if (err) {
            log.error({ err, stderr }, failedLog)
          } else {
            try {
              if (verifySuccess) {
                await verifySuccess()
              }
              log.info(completedLog)
              if (onSuccess) {
                try {
                  await onSuccess()
                } catch (onSuccessErr) {
                  log.error({ err: onSuccessErr }, 'Failed to apply post-repair network settings')
                }
              }
            } catch (verificationErr) {
              log.error({ err: verificationErr }, failedLog)
            }
          }
          settleRepair()
        })()
      })

      if (!settled) {
        networkManager.setFirewallConfiguring(true)
      }

      child.on('error', (err) => {
        log.error({ err }, spawnFailedLog)
        settleRepair()
      })
    } catch (err) {
      settleRepair()
      throw err
    }
  }

  const issueConfirmation = (action: ConfirmationAction) => {
    const confirmationToken = randomUUID()
    currentConfirmation = {
      token: confirmationToken,
      action,
    }
    return {
      ...WINDOWS_ELEVATION_CONFIRMATION,
      confirmationToken,
    }
  }

  const matchesConfirmation = (token: string | undefined, action: ConfirmationAction) => {
    const confirmation = getCurrentConfirmation()
    return confirmation !== null
      && confirmation.token === token
      && confirmation.action === action
  }

  const consumeConfirmation = (token: string | undefined, action: ConfirmationAction) => {
    if (!matchesConfirmation(token, action)) {
      return false
    }

    currentConfirmation = null
    return true
  }

  const acquireConfirmedRepairLock = () => {
    if (confirmedRepairInFlight) {
      return FIREWALL_REPAIR_LOCKED
    }

    confirmedRepairInFlight = true
    let released = false
    return () => {
      if (released) {
        return
      }
      released = true
      confirmedRepairInFlight = false
      networkManager.resetFirewallCache()
      networkManager.setFirewallConfiguring(false)
    }
  }

  const resolveRepairAction = async (
    status: Awaited<ReturnType<NetworkRouterDeps['networkManager']['getStatus']>>,
    settings: Awaited<ReturnType<NetworkRouterDeps['configStore']['getSettings']>>,
  ): Promise<RepairActionResolution> => {
    if (!isRemoteAccessEnabled(settings.network, status.host, status.firewall.platform)) {
      return { kind: 'none', response: REMOTE_ACCESS_DISABLED }
    }

    if (status.firewall.platform === 'wsl2') {
      if (status.firewall.portOpen === true) {
        return { kind: 'none', response: NO_CONFIGURATION_CHANGES_REQUIRED }
      }

      const plan = await computeWslPortForwardingPlanAsync(
        networkManager.getRemoteAccessPorts(),
        networkManager.getRelevantPorts(),
      )
      if (plan.status === 'error') {
        return { kind: 'error', error: plan.message }
      }
      if (plan.status === 'noop' || plan.status === 'not-wsl2' || plan.status === 'disabled') {
        return { kind: 'none', response: NO_CONFIGURATION_CHANGES_REQUIRED }
      }

      return {
        kind: 'confirmable',
        confirmationAction: 'wsl2-repair',
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
        confirmationAction: 'windows-repair',
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

  const resolveRemoteAccessDisableAction = async (
    status: Awaited<ReturnType<NetworkRouterDeps['networkManager']['getStatus']>>,
    settings: Awaited<ReturnType<NetworkRouterDeps['configStore']['getSettings']>>,
  ): Promise<RepairActionResolution> => {
    const remoteAccessRequested = isRemoteAccessEnabled(settings.network, status.host, status.firewall.platform)

    if (status.firewall.platform === 'windows') {
      const managedWindowsPorts = new Set(await networkManager.getManagedWindowsRemoteAccessPorts())
      if (managedWindowsPorts.size === 0) {
        return {
          kind: 'none',
          response: remoteAccessRequested ? REMOTE_ACCESS_DISABLED_SUCCESS : REMOTE_ACCESS_DISABLED,
        }
      }

      return {
        kind: 'confirmable',
        confirmationAction: 'windows-disable',
        script: buildWindowsFirewallDeleteCommands(managedWindowsPorts).join('; '),
        responseMethod: 'windows-elevated',
      }
    }

    if (status.firewall.platform !== 'wsl2') {
      return {
        kind: 'none',
        response: remoteAccessRequested ? REMOTE_ACCESS_DISABLED_SUCCESS : REMOTE_ACCESS_DISABLED,
      }
    }

    const teardownPlan = await computeWslPortForwardingTeardownPlanAsync(
      networkManager.getRemoteAccessPorts(),
      networkManager.getRelevantPorts(),
    )

    if (teardownPlan.status === 'error') {
      return { kind: 'error', error: teardownPlan.message }
    }

    if (teardownPlan.status === 'not-wsl2' || teardownPlan.status === 'disabled') {
      return { kind: 'none', response: REMOTE_ACCESS_DISABLED }
    }

    if (teardownPlan.status === 'noop') {
      return {
        kind: 'none',
        response: remoteAccessRequested ? REMOTE_ACCESS_DISABLED_SUCCESS : REMOTE_ACCESS_DISABLED,
      }
    }

    return {
      kind: 'confirmable',
      confirmationAction: 'wsl2-disable',
      script: teardownPlan.script,
      responseMethod: 'wsl2',
    }
  }

  const verifyWslRepairSuccess = async () => {
    const plan = await computeWslPortForwardingPlanAsync(
      networkManager.getRemoteAccessPorts(),
      networkManager.getRelevantPorts(),
    )
    if (plan.status === 'error') {
      throw new Error(plan.message)
    }
    if (plan.status === 'ready') {
      throw new Error('WSL2 port forwarding verification failed')
    }
  }

  const verifyWslDisableSuccess = async () => {
    const teardownPlan = await computeWslPortForwardingTeardownPlanAsync(
      networkManager.getRemoteAccessPorts(),
      networkManager.getRelevantPorts(),
    )
    if (teardownPlan.status === 'error') {
      throw new Error(teardownPlan.message)
    }
    if (teardownPlan.status === 'ready') {
      throw new Error('WSL2 remote access teardown verification failed')
    }
  }

  const verifyWindowsDisableSuccess = async () => {
    if ((await networkManager.getManagedWindowsRemoteAccessPorts()).length > 0) {
      throw new Error('Windows remote access teardown verification failed')
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
    await broadcastSettingsUpdated()
  })

  router.post('/network/disable-remote-access', async (req, res) => {
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

      if (confirmedRepairInFlight) {
        return res.status(409).json({
          error: 'Firewall configuration already in progress',
          method: 'in-progress',
        })
      }

      const action = await resolveRemoteAccessDisableAction(status, settings)

      if (action.kind === 'error') {
        if (confirmElevation) {
          consumeCurrentConfirmation(confirmationToken)
        }
        return res.status(500).json({ error: action.error })
      }

      if (action.kind === 'terminal') {
        if (confirmElevation) {
          consumeCurrentConfirmation(confirmationToken)
        }
        return res.status(500).json({ error: 'Invalid remote access disable action' })
      }

      if (action.kind === 'none') {
        if (action.response.message === REMOTE_ACCESS_DISABLED_SUCCESS.message) {
          await applyRemoteAccessDisabledState(status.firewall.platform)
        }
        if (confirmElevation) {
          consumeCurrentConfirmation(confirmationToken)
        }
        return res.json(action.response)
      }

      if (!confirmElevation || !matchesConfirmation(confirmationToken, action.confirmationAction)) {
        return res.json(issueConfirmation(action.confirmationAction))
      }

      const releaseConfirmedRepair = acquireConfirmedRepairLock()
      if (releaseConfirmedRepair === FIREWALL_REPAIR_LOCKED) {
        return res.status(409).json({
          error: 'Firewall configuration already in progress',
          method: 'in-progress',
        })
      }

      const lockedResult = await (async () => {
        const [freshStatus, freshSettings] = await Promise.all([
          networkManager.getStatus(),
          configStore.getSettings(),
        ])
        const freshAction = await resolveRemoteAccessDisableAction(freshStatus, freshSettings)

        if (freshAction.kind === 'error') {
          consumeCurrentConfirmation(confirmationToken)
          releaseConfirmedRepair()
          return {
            status: 500 as const,
            body: { error: freshAction.error },
          }
        }

        if (freshAction.kind === 'terminal') {
          consumeCurrentConfirmation(confirmationToken)
          releaseConfirmedRepair()
          return {
            status: 500 as const,
            body: { error: 'Invalid remote access disable action' },
          }
        }

        if (freshAction.kind === 'none') {
          consumeCurrentConfirmation(confirmationToken)
          try {
            if (freshAction.response.message === REMOTE_ACCESS_DISABLED_SUCCESS.message) {
              await applyRemoteAccessDisabledState(freshStatus.firewall.platform)
            }
            return { status: 200 as const, body: freshAction.response }
          } catch (err) {
            log.error({ err }, 'Failed to persist confirmed remote access disable settings')
            return {
              status: 500 as const,
              body: { error: 'Failed to persist remote access disable settings' },
            }
          } finally {
            releaseConfirmedRepair()
          }
        }

        if (!consumeConfirmation(confirmationToken, freshAction.confirmationAction)) {
          releaseConfirmedRepair()
          return {
            status: 200 as const,
            body: issueConfirmation(freshAction.confirmationAction),
          }
        }

        try {
          startElevatedRepair(
            freshAction.confirmationAction === 'wsl2-disable'
              ? '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'
              : 'powershell.exe',
            freshAction.script,
            freshAction.confirmationAction === 'wsl2-disable'
              ? {
                completedLog: 'WSL2 remote access teardown completed successfully',
                failedLog: 'WSL2 remote access teardown failed',
                spawnFailedLog: 'Failed to spawn PowerShell for WSL2 remote access teardown',
                verifySuccess: verifyWslDisableSuccess,
                onSuccess: async () => {
                  await applyRemoteAccessDisabledState('wsl2')
                },
                releaseConfirmedRepair,
              }
              : {
                completedLog: 'Windows remote access teardown completed successfully',
                failedLog: 'Windows remote access teardown failed',
                spawnFailedLog: 'Failed to spawn PowerShell for Windows remote access teardown',
                verifySuccess: verifyWindowsDisableSuccess,
                onSuccess: async () => {
                  await applyRemoteAccessDisabledState('windows')
                },
                releaseConfirmedRepair,
              },
          )

          return {
            status: 200 as const,
            body: { method: freshAction.responseMethod, status: 'started' as const },
          }
        } catch (err) {
          log.error(
            { err },
            freshAction.confirmationAction === 'wsl2-disable'
              ? 'WSL2 remote access teardown error'
              : 'Windows remote access teardown error',
          )
          releaseConfirmedRepair()
          return {
            status: 500 as const,
            body: {
              error: freshAction.confirmationAction === 'wsl2-disable'
                ? 'WSL2 remote access teardown failed to start'
                : 'Windows remote access teardown failed to start',
            },
          }
        }
      })()

      return res.status(lockedResult.status).json(lockedResult.body)
    } catch (err) {
      log.error({ err }, 'Remote access disable error')
      res.status(500).json({ error: 'Remote access disable failed' })
    }
  })

  router.post('/network/configure-firewall', async (req, res) => {
    const parsed = ConfigureFirewallRequestSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid request', details: parsed.error.issues })
    }

    try {
      if (confirmedRepairInFlight) {
        return res.status(409).json({
          error: 'Firewall configuration already in progress',
          method: 'in-progress',
        })
      }

      const confirmElevation = parsed.data.confirmElevation === true
      const confirmationToken = parsed.data.confirmationToken
      const [status, settings] = await Promise.all([
        networkManager.getStatus(),
        configStore.getSettings(),
      ])
      const action = await resolveRepairAction(status, settings)

      if (action.kind === 'error') {
        if (confirmElevation) {
          consumeCurrentConfirmation(confirmationToken)
        }
        return res.status(500).json({ error: action.error })
      }

      if (action.kind === 'none' || action.kind === 'terminal') {
        if (confirmElevation) {
          consumeCurrentConfirmation(confirmationToken)
        }
        return res.json(action.response)
      }

      if (confirmedRepairInFlight) {
        return res.status(409).json({
          error: 'Firewall configuration already in progress',
          method: 'in-progress',
        })
      }

      if (!confirmElevation || !matchesConfirmation(confirmationToken, action.confirmationAction)) {
        return res.json(issueConfirmation(action.confirmationAction))
      }

      const releaseConfirmedRepair = acquireConfirmedRepairLock()
      if (releaseConfirmedRepair === FIREWALL_REPAIR_LOCKED) {
        return res.status(409).json({
          error: 'Firewall configuration already in progress',
          method: 'in-progress',
        })
      }

      const lockedResult = await (async () => {
        const [freshStatus, freshSettings] = await Promise.all([
          networkManager.getStatus(),
          configStore.getSettings(),
        ])
        const freshAction = await resolveRepairAction(freshStatus, freshSettings)

        if (freshAction.kind === 'error') {
          consumeCurrentConfirmation(confirmationToken)
          releaseConfirmedRepair()
          return {
            status: 500 as const,
            body: { error: freshAction.error },
          }
        }

        if (freshAction.kind === 'none' || freshAction.kind === 'terminal') {
          consumeCurrentConfirmation(confirmationToken)
          releaseConfirmedRepair()
          return { status: 200 as const, body: freshAction.response }
        }

        if (!consumeConfirmation(confirmationToken, freshAction.confirmationAction)) {
          releaseConfirmedRepair()
          return {
            status: 200 as const,
            body: issueConfirmation(freshAction.confirmationAction),
          }
        }

        try {
          startElevatedRepair(
            freshAction.confirmationAction === 'wsl2-repair'
              ? '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'
              : 'powershell.exe',
            freshAction.script,
            freshAction.confirmationAction === 'wsl2-repair'
              ? {
                completedLog: 'WSL2 port forwarding completed successfully',
                failedLog: 'WSL2 port forwarding failed',
                spawnFailedLog: 'Failed to spawn PowerShell for WSL2 port forwarding',
                verifySuccess: verifyWslRepairSuccess,
                onSuccess: async () => {
                  await persistCurrentWslRemoteAccessPorts()
                },
                releaseConfirmedRepair,
              }
              : {
                completedLog: 'Windows firewall configured successfully',
                failedLog: 'Windows firewall configuration failed',
                spawnFailedLog: 'Failed to spawn PowerShell for Windows firewall',
                onSuccess: async () => {
                  await networkManager.persistManagedWindowsRemoteAccessPorts()
                },
                releaseConfirmedRepair,
              },
          )

          return {
            status: 200 as const,
            body: { method: freshAction.responseMethod, status: 'started' as const },
          }
        } catch (err) {
          log.error(
            { err },
            freshAction.confirmationAction === 'wsl2-repair'
              ? 'WSL2 port forwarding setup error'
              : 'Windows firewall setup error',
          )
          releaseConfirmedRepair()
          return {
            status: 500 as const,
            body: {
              error: freshAction.confirmationAction === 'wsl2-repair'
                ? 'WSL2 port forwarding failed to start'
                : 'Windows firewall configuration failed to start',
            },
          }
        }
      })()

      return res.status(lockedResult.status).json(lockedResult.body)
    } catch (err) {
      log.error({ err }, 'Firewall configuration error')
      res.status(500).json({ error: 'Firewall configuration failed' })
    }
  })

  return router
}
