import { useCallback, useEffect, useRef, useState } from 'react'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import { api, type ApiError } from '@/lib/api'
import { createLogger } from '@/lib/client-logger'
import { configureNetwork, fetchNetworkStatus, type NetworkStatusResponse } from '@/store/networkSlice'
import { addTab } from '@/store/tabsSlice'
import { initLayout } from '@/store/panesSlice'
import {
  fetchFirewallConfig,
  type ConfigureFirewallResult,
} from '@/lib/firewall-configure'
import { nanoid } from '@reduxjs/toolkit'
import type { AppView } from '@/components/Sidebar'
import { isRemoteAccessEnabledStatus } from '@/lib/share-utils'
import { ConfirmModal } from '@/components/ui/confirm-modal'
import type { SettingsSectionProps } from './settings-types'
import {
  SettingsSection,
  SettingsRow,
  Toggle,
} from './settings-controls'

const SETTINGS_FIREWALL_POLL_INTERVAL_MS = 2000
const SETTINGS_FIREWALL_POLL_MAX_ATTEMPTS = 10
const log = createLogger('NetworkSettings')

type FirewallConfirmation = Extract<ConfigureFirewallResult, { method: 'confirmation-required' }>
type PendingConfirmation =
  | { kind: 'firewall-fix'; request: FirewallConfirmation }
  | { kind: 'remote-access-disable'; request: FirewallConfirmation }
type FirewallState = NetworkStatusResponse['firewall']

function getFirewallDescription(firewall: FirewallState, override: string | null): string {
  if (override) return override
  if (firewall.configuring) return 'Firewall configuration already in progress'
  if (firewall.portOpen === true) return 'Port is open'
  if (firewall.platform === 'wsl2' && firewall.portOpen === false) return 'Port may be blocked'
  if (!firewall.active) return 'No firewall detected'
  if (firewall.portOpen === false) return 'Port may be blocked'
  return 'Firewall detected'
}

function isFirewallRefreshInProgress(firewall: FirewallState, override: string | null): boolean {
  return firewall.configuring || override === 'Firewall configuration already in progress'
}

function shouldShowFirewallFix(firewall: FirewallState, override: string | null): boolean {
  if (isFirewallRefreshInProgress(firewall, override)) {
    return false
  }
  if (firewall.platform === 'wsl2' && firewall.portOpen === false) {
    return true
  }
  return firewall.active && firewall.portOpen !== true
}

function getErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message
  }

  if (
    typeof error === 'object'
    && error !== null
    && 'message' in error
    && typeof (error as { message?: unknown }).message === 'string'
    && (error as { message: string }).message.trim().length > 0
  ) {
    return (error as { message: string }).message
  }

  return fallback
}

export interface NetworkSettingsProps extends SettingsSectionProps {
  onNavigate?: (view: AppView) => void
  onFirewallTerminal?: (cmd: { tabId: string; command: string }) => void
  onSharePanel?: () => void
}

export default function NetworkSettings({
  onNavigate,
  onFirewallTerminal,
  onSharePanel,
}: NetworkSettingsProps) {
  const dispatch = useAppDispatch()
  const networkStatus = useAppSelector((s) => s.network.status)
  const configuring = useAppSelector((s) => s.network.configuring)
  const remoteAccessEnabled = isRemoteAccessEnabledStatus(networkStatus)
  const remoteAccessRequested = networkStatus?.remoteAccessRequested ?? remoteAccessEnabled
  const requiresPrivilegedRemoteAccessDisable = (
    networkStatus?.firewall?.platform === 'windows'
    || networkStatus?.firewall?.platform === 'wsl2'
  )
  const remoteAccessToggleChecked = remoteAccessEnabled || remoteAccessRequested

  const [pendingConfirmation, setPendingConfirmation] = useState<PendingConfirmation | null>(null)
  const [firewallRefreshDetail, setFirewallRefreshDetail] = useState<string | null>(null)
  const firewallRepairInProgress = networkStatus?.firewall
    ? isFirewallRefreshInProgress(networkStatus.firewall, firewallRefreshDetail)
    : false
  const [remoteAccessPending, setRemoteAccessPending] = useState(false)
  const [remoteAccessError, setRemoteAccessError] = useState<string | null>(null)
  const firewallRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const firewallRefreshRequestRef = useRef(0)
  const remoteAccessRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const remoteAccessRefreshRequestRef = useRef(0)

  useEffect(() => {
    return () => {
      if (firewallRefreshTimerRef.current) clearTimeout(firewallRefreshTimerRef.current)
      if (remoteAccessRefreshTimerRef.current) clearTimeout(remoteAccessRefreshTimerRef.current)
    }
  }, [])

  const refreshFirewallStatusAfterNoop = useCallback(async (message?: string) => {
    setFirewallRefreshDetail(message ?? 'Refreshing firewall status...')
    try {
      await dispatch(fetchNetworkStatus()).unwrap()
      setFirewallRefreshDetail(null)
    } catch {
      setFirewallRefreshDetail('Failed to refresh firewall status')
    }
  }, [dispatch])

  const queueFirewallRefresh = useCallback((refreshRequestId: number, detail: string | null, attempts = 0) => {
    firewallRefreshTimerRef.current = setTimeout(() => {
      firewallRefreshTimerRef.current = null
      void dispatch(fetchNetworkStatus())
        .unwrap()
        .then((status) => {
          if (firewallRefreshRequestRef.current !== refreshRequestId) {
            return
          }

          if (status.firewall.configuring) {
            if (attempts + 1 >= SETTINGS_FIREWALL_POLL_MAX_ATTEMPTS) {
              setFirewallRefreshDetail('Firewall configuration timed out')
              return
            }

            queueFirewallRefresh(refreshRequestId, detail, attempts + 1)
            return
          }

          setFirewallRefreshDetail(null)
        })
        .catch(() => {
          if (firewallRefreshRequestRef.current === refreshRequestId) {
            setFirewallRefreshDetail('Failed to refresh firewall status')
          }
        })
    }, SETTINGS_FIREWALL_POLL_INTERVAL_MS)
  }, [dispatch])

  const scheduleFirewallRefresh = useCallback((detail: string | null = null) => {
    setFirewallRefreshDetail(detail)
    if (firewallRefreshTimerRef.current) {
      clearTimeout(firewallRefreshTimerRef.current)
    }
    firewallRefreshRequestRef.current += 1
    const refreshRequestId = firewallRefreshRequestRef.current
    queueFirewallRefresh(refreshRequestId, detail)
  }, [queueFirewallRefresh])

  const reconcileRemoteAccessRefreshFailure = useCallback(async (
    refreshRequestId: number,
    errorMessage: string,
  ) => {
    try {
      await dispatch(fetchNetworkStatus()).unwrap()
    } catch (refreshError) {
      log.warn('Failed to reconcile remote access status after polling error', refreshError)
    }
    if (remoteAccessRefreshRequestRef.current !== refreshRequestId) {
      return
    }
    setRemoteAccessPending(false)
    setRemoteAccessError(errorMessage)
  }, [dispatch])

  const queueRemoteAccessRefresh = useCallback((refreshRequestId: number, attempts = 0) => {
    remoteAccessRefreshTimerRef.current = setTimeout(() => {
      remoteAccessRefreshTimerRef.current = null
      void dispatch(fetchNetworkStatus())
        .unwrap()
        .then((status) => {
          if (remoteAccessRefreshRequestRef.current !== refreshRequestId) {
            return
          }

          if (status.firewall.configuring) {
            if (attempts + 1 >= SETTINGS_FIREWALL_POLL_MAX_ATTEMPTS) {
              void reconcileRemoteAccessRefreshFailure(
                refreshRequestId,
                'Timed out turning off remote access',
              )
              return
            }

            queueRemoteAccessRefresh(refreshRequestId, attempts + 1)
            return
          }

          const remoteAccessStillEnabled = isRemoteAccessEnabledStatus(status)
            || (status.remoteAccessRequested ?? false)
          if (remoteAccessStillEnabled) {
            setRemoteAccessPending(false)
            setRemoteAccessError('Remote access is still enabled')
            return
          }

          setRemoteAccessPending(false)
        })
        .catch((error) => {
          if (remoteAccessRefreshRequestRef.current === refreshRequestId) {
            log.warn('Failed to refresh remote access status', error)
            void reconcileRemoteAccessRefreshFailure(
              refreshRequestId,
              'Failed to refresh remote access status',
            )
          }
        })
    }, SETTINGS_FIREWALL_POLL_INTERVAL_MS)
  }, [dispatch, reconcileRemoteAccessRefreshFailure])

  const scheduleRemoteAccessRefresh = useCallback(() => {
    setRemoteAccessPending(true)
    setRemoteAccessError(null)
    if (remoteAccessRefreshTimerRef.current) {
      clearTimeout(remoteAccessRefreshTimerRef.current)
    }
    remoteAccessRefreshRequestRef.current += 1
    const refreshRequestId = remoteAccessRefreshRequestRef.current
    queueRemoteAccessRefresh(refreshRequestId)
  }, [queueRemoteAccessRefresh])

  const handleFirewallFixResult = useCallback((result: ConfigureFirewallResult) => {
    if (result.method === 'confirmation-required') {
      setPendingConfirmation({ kind: 'firewall-fix', request: result })
      return
    }

    if (result.method === 'none') {
      void refreshFirewallStatusAfterNoop(result.message)
      return
    }

    setFirewallRefreshDetail(null)

    if (result.method === 'terminal') {
      const tabId = nanoid()
      dispatch(addTab({ id: tabId, title: 'Firewall Setup', mode: 'shell', shell: 'system' }))
      dispatch(initLayout({ tabId, content: { kind: 'terminal', mode: 'shell' } }))
      onFirewallTerminal?.({ tabId, command: result.command })
      onNavigate?.('terminal')
      return
    }

    if (result.method === 'in-progress') {
      scheduleFirewallRefresh(result.error)
      return
    }

    if (result.method === 'wsl2' || result.method === 'windows-elevated') {
      scheduleFirewallRefresh('Firewall configuration already in progress')
    }
  }, [dispatch, onFirewallTerminal, onNavigate, refreshFirewallStatusAfterNoop, scheduleFirewallRefresh])

  const requestFirewallFix = useCallback(async (
    body: { confirmElevation?: true; confirmationToken?: string } = {},
  ) => {
    setFirewallRefreshDetail(null)
    try {
      const result = await fetchFirewallConfig(body)
      handleFirewallFixResult(result)
    } catch (error) {
      log.warn('Failed to configure firewall', error)
      setFirewallRefreshDetail(getErrorMessage(error, 'Failed to configure firewall'))
    }
  }, [handleFirewallFixResult])

  const requestRemoteAccessDisable = useCallback(async (
    body: { confirmElevation?: true; confirmationToken?: string } = {},
  ) => {
    setRemoteAccessError(null)
    try {
      const result = await api.post<ConfigureFirewallResult>('/api/network/disable-remote-access', body)
      if (result.method === 'confirmation-required') {
        setPendingConfirmation({ kind: 'remote-access-disable', request: result })
        return
      }
      if (result.method === 'none') {
        setRemoteAccessPending(false)
        await dispatch(fetchNetworkStatus()).unwrap()
        return
      }
      if (
        result.method === 'in-progress'
        || result.method === 'windows-elevated'
        || result.method === 'wsl2'
      ) {
        scheduleRemoteAccessRefresh()
      }
    } catch (error) {
      const apiError = error as ApiError | undefined
      const details = apiError?.details as { method?: string; error?: string } | undefined
      if (apiError?.status === 409 && details?.method === 'in-progress') {
        scheduleRemoteAccessRefresh()
        return
      }

      log.warn('Failed to disable remote access', error)
      setRemoteAccessPending(false)
      setRemoteAccessError(getErrorMessage(error, 'Failed to disable remote access'))
    }
  }, [dispatch, scheduleRemoteAccessRefresh])

  const requestRemoteAccessConfigure = useCallback(async (host: '127.0.0.1' | '0.0.0.0') => {
    setRemoteAccessError(null)
    try {
      await dispatch(configureNetwork({
        host,
        configured: true,
      })).unwrap()
    } catch (error) {
      log.warn('Failed to configure remote access', error)
      setRemoteAccessError(getErrorMessage(error, 'Failed to configure remote access'))
    }
  }, [dispatch])

  const handleConfirmPendingAction = useCallback(() => {
    if (!pendingConfirmation) {
      return
    }

    const { kind, request } = pendingConfirmation
    const confirmationToken = request.confirmationToken
    setPendingConfirmation(null)

    if (kind === 'firewall-fix') {
      void requestFirewallFix({
        confirmElevation: true,
        confirmationToken,
      })
      return
    }

    void requestRemoteAccessDisable({
      confirmElevation: true,
      confirmationToken,
    })
  }, [pendingConfirmation, requestFirewallFix, requestRemoteAccessDisable])

  const handleCancelPendingAction = useCallback(() => {
    setPendingConfirmation(null)
  }, [])

  return (
    <>
      <SettingsSection id="network" title="Network" description="Remote access for this Freshell server">
        <SettingsRow
          label="Remote access"
          description={remoteAccessError ?? 'Allow connections from other devices on your network'}
        >
          <Toggle
            checked={remoteAccessToggleChecked}
            disabled={configuring || remoteAccessPending || firewallRepairInProgress}
            aria-label="Remote access"
            onChange={async (checked) => {
              setRemoteAccessError(null)
              if (checked) {
                await requestRemoteAccessConfigure('0.0.0.0')
                return
              }

              if (requiresPrivilegedRemoteAccessDisable) {
                await requestRemoteAccessDisable()
                return
              }

              await requestRemoteAccessConfigure(checked ? '0.0.0.0' : '127.0.0.1')
            }}
          />
        </SettingsRow>

        {remoteAccessError && (
          <div
            role="alert"
            className="rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300"
          >
            {remoteAccessError}
          </div>
        )}

        {(remoteAccessEnabled || remoteAccessRequested) && networkStatus && (
          <>
            {networkStatus.firewall && (
              <SettingsRow
                label="Firewall"
                description={getFirewallDescription(networkStatus.firewall, firewallRefreshDetail)}
              >
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">{networkStatus.firewall.platform}</span>
                  {shouldShowFirewallFix(networkStatus.firewall, firewallRefreshDetail) && (
                    <button
                      onClick={() => {
                        void requestFirewallFix()
                      }}
                      className="rounded border px-2 py-0.5 text-xs font-medium transition-colors hover:bg-muted"
                      aria-label="Fix firewall configuration"
                    >
                      Fix
                    </button>
                  )}
                </div>
              </SettingsRow>
            )}

            {remoteAccessEnabled && networkStatus.accessUrl && (
              <SettingsRow label="Device access" description="Get a link to use from your phone or other computers">
                <button
                  onClick={() => onSharePanel?.()}
                  className="rounded border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-muted"
                  aria-label="Get link for your devices"
                >
                  Get link
                </button>
              </SettingsRow>
            )}

            {networkStatus.devMode && networkStatus.firewall?.platform !== 'wsl2' && (
              <div className="rounded border border-yellow-200 bg-yellow-50 p-3 text-sm text-yellow-800 dark:border-yellow-800 dark:bg-yellow-950 dark:text-yellow-300" role="alert">
                Dev mode: restart <code className="font-mono text-xs">npm run dev</code> for the Vite server to bind to the new address.
              </div>
            )}
          </>
        )}
      </SettingsSection>

      <ConfirmModal
        open={pendingConfirmation !== null}
        title={pendingConfirmation?.request.title ?? ''}
        body={pendingConfirmation?.request.body ?? ''}
        confirmLabel={pendingConfirmation?.request.confirmLabel ?? 'Continue'}
        confirmVariant="default"
        onConfirm={handleConfirmPendingAction}
        onCancel={handleCancelPendingAction}
      />
    </>
  )
}
