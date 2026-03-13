import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import { configureNetwork, fetchNetworkStatus, type NetworkStatusResponse } from '@/store/networkSlice'
import { addTab } from '@/store/tabsSlice'
import { initLayout } from '@/store/panesSlice'
import {
  cancelFirewallConfirmation,
  fetchFirewallConfig,
  type ConfigureFirewallResult,
} from '@/lib/firewall-configure'
import { ensureShareUrlToken, isRemoteAccessEnabledStatus } from '@/lib/share-utils'
import { getAuthToken } from '@/lib/auth'
import {
  SETUP_WIZARD_AUTO_ADVANCE_DELAY_MS,
  SETUP_WIZARD_COPY_RESET_DELAY_MS,
  SETUP_WIZARD_FIREWALL_POLL_INTERVAL_MS,
  SETUP_WIZARD_FIREWALL_POLL_MAX_ATTEMPTS,
} from '@/components/setup-wizard-timing'
import { generate } from 'lean-qr'
import { toSvgDataURL } from 'lean-qr/extras/svg'
import { nanoid } from '@reduxjs/toolkit'
import { Check, Loader2, AlertCircle, Copy } from 'lucide-react'
import type { AppView } from '@/components/Sidebar'
import { ConfirmModal } from '@/components/ui/confirm-modal'

interface SetupWizardProps {
  onComplete: () => void
  initialStep?: 1 | 2
  onNavigate?: (view: AppView) => void
  onFirewallTerminal?: (cmd: { tabId: string; command: string }) => void
}

type ChecklistItemStatus = 'pending' | 'active' | 'done' | 'error'
type FirewallConfirmation = Extract<ConfigureFirewallResult, { method: 'confirmation-required' }>
type FirewallState = NetworkStatusResponse['firewall']
type FirewallChecklistStatus = Pick<NetworkStatusResponse, 'firewall' | 'host' | 'remoteAccessEnabled'>

function isRemoteAccessBindRequested(status: NetworkStatusResponse | null): boolean {
  if (status === null || status.host !== '0.0.0.0') {
    return false
  }

  return status.remoteAccessRequested ?? isRemoteAccessEnabledStatus(status)
}

function isBoundToAllInterfaces(status: NetworkStatusResponse | null): boolean {
  return status?.host === '0.0.0.0'
}

function getFirewallChecklistState(status: FirewallChecklistStatus): { status: ChecklistItemStatus; detail: string } {
  const { firewall } = status
  if (firewall.portOpen === true) {
    return { status: 'done', detail: 'Port is open' }
  }

  if (firewall.configuring) {
    return { status: 'active', detail: 'Firewall configuration already in progress' }
  }

  if (firewall.platform === 'wsl2' && !isRemoteAccessEnabledStatus(status)) {
    return { status: 'error', detail: 'Port may be blocked by firewall' }
  }

  if (!firewall.active) {
    return { status: 'done', detail: 'No firewall detected' }
  }

  if (firewall.portOpen === false) {
    return { status: 'error', detail: 'Port may be blocked by firewall' }
  }

  return { status: 'done', detail: 'Firewall detected — check may be needed' }
}

function ChecklistItem({ label, status, detail }: { label: string; status: ChecklistItemStatus; detail?: string }) {
  return (
    <div className="flex items-start gap-3 py-2">
      <div className="mt-0.5 flex-shrink-0">
        {status === 'pending' && <div className="h-5 w-5 rounded-full border-2 border-muted" />}
        {status === 'active' && <Loader2 className="h-5 w-5 animate-spin text-blue-500" />}
        {status === 'done' && <Check className="h-5 w-5 text-green-500" />}
        {status === 'error' && <AlertCircle className="h-5 w-5 text-red-500" />}
      </div>
      <div className="flex flex-col">
        <span className="text-sm">{label}</span>
        {detail && <span className="text-xs text-muted-foreground">{detail}</span>}
      </div>
    </div>
  )
}

function QrCode({ url }: { url: string }) {
  const dataUrl = useMemo(() => {
    try {
      const code = generate(url)
      return toSvgDataURL(code, { on: 'black', off: 'white' })
    } catch {
      return null
    }
  }, [url])

  if (!dataUrl) return null
  return <img src={dataUrl} alt="QR code for access URL" className="h-32 w-32" />
}

export function SetupWizard({ onComplete, initialStep = 1, onNavigate, onFirewallTerminal }: SetupWizardProps) {
  const dispatch = useAppDispatch()
  const networkStatus = useAppSelector((s) => s.network.status)
  const configuring = useAppSelector((s) => s.network.configuring)
  const shareAccessUrl = networkStatus?.accessUrl
    ? ensureShareUrlToken(networkStatus.accessUrl, getAuthToken())
    : null

  const [step, setStep] = useState<1 | 2 | 3>(initialStep)
  const [bindStatus, setBindStatus] = useState<ChecklistItemStatus>('pending')
  const [bindDetail, setBindDetail] = useState<string | undefined>()
  const [firewallStatus, setFirewallStatus] = useState<ChecklistItemStatus>('pending')
  const [firewallDetail, setFirewallDetail] = useState<string | undefined>()
  const [firewallConfirmation, setFirewallConfirmation] = useState<FirewallConfirmation | null>(null)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const mountedRef = useRef(true)
  const copyResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const firewallPollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      mountedRef.current = false
      if (copyResetTimerRef.current) {
        clearTimeout(copyResetTimerRef.current)
        copyResetTimerRef.current = null
      }
      if (firewallPollTimerRef.current) {
        clearTimeout(firewallPollTimerRef.current)
        firewallPollTimerRef.current = null
      }
    }
  }, [])

  // Watch for rebinding completion when on step 2
  useEffect(() => {
    if (bindStatus === 'active' && networkStatus && !configuring && !networkStatus.rebinding) {
      if (isBoundToAllInterfaces(networkStatus)) {
        setBindStatus('done')
        setBindDetail('Bound to all interfaces')
      } else {
        setBindStatus('error')
        setBindDetail('Rebind failed — rolled back to localhost')
      }
    }
  }, [bindStatus, configuring, networkStatus])

  const applyFirewallChecklistState = useCallback((status: FirewallChecklistStatus) => {
    const next = getFirewallChecklistState(status)
    setFirewallStatus(next.status)
    setFirewallDetail(next.detail)
  }, [])

  // Check firewall status after bind completes
  useEffect(() => {
    if (bindStatus === 'done' && networkStatus?.firewall) {
      applyFirewallChecklistState(networkStatus)
    }
  }, [applyFirewallChecklistState, bindStatus, networkStatus])

  // Auto-advance to step 3 when all checklist items are done.
  // Firewall errors stay on step 2 so the user can see and act on them.
  useEffect(() => {
    if (
      step === 2
      && bindStatus === 'done'
      && firewallStatus === 'done'
      && (networkStatus?.firewall.platform !== 'wsl2' || isRemoteAccessEnabledStatus(networkStatus))
    ) {
      const timer = setTimeout(() => setStep(3), SETUP_WIZARD_AUTO_ADVANCE_DELAY_MS)
      return () => clearTimeout(timer)
    }
  }, [step, bindStatus, firewallStatus, networkStatus])

  // Start binding when entering step 2 directly (e.g. re-enabling remote access
  // from share button after the user previously chose localhost-only).
  const startBind = useCallback(async () => {
    setBindStatus('active')
    setBindDetail('Applying network settings...')
    try {
      await dispatch(configureNetwork({
        host: '0.0.0.0',
        configured: true,
      })).unwrap()
    } catch (err: any) {
      setBindStatus('error')
      setBindDetail(err?.message || 'Failed to configure network')
    }
  }, [dispatch])

  // Entering directly at step 2 can mean either "enable remote access now"
  // or "remote access is already enabled, go straight to firewall checks".
  useEffect(() => {
    if (step !== 2 || bindStatus !== 'pending' || configuring) {
      return
    }

    if (networkStatus && !networkStatus.rebinding && isRemoteAccessBindRequested(networkStatus)) {
      setBindStatus('done')
      setBindDetail('Bound to all interfaces')
      return
    }

    if (initialStep === 2) {
      startBind()
    }
  }, [bindStatus, configuring, initialStep, networkStatus, startBind, step])

  const handleYes = useCallback(async () => {
    setStep(2)
    startBind()
  }, [startBind])

  const handleNo = useCallback(async () => {
    setError(null)
    try {
      await dispatch(configureNetwork({
        host: '127.0.0.1',
        configured: true,
      })).unwrap()
      onComplete()
    } catch (err: any) {
      setError(err?.message || 'Failed to save preference')
    }
  }, [dispatch, onComplete])

  const handleCopy = useCallback(async () => {
    const url = shareAccessUrl
    if (!url) return
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      if (copyResetTimerRef.current) {
        clearTimeout(copyResetTimerRef.current)
      }
      copyResetTimerRef.current = setTimeout(() => {
        copyResetTimerRef.current = null
        if (!mountedRef.current) return
        setCopied(false)
      }, SETUP_WIZARD_COPY_RESET_DELAY_MS)
    } catch {
      // Clipboard may not be available
    }
  }, [shareAccessUrl])

  const startFirewallPolling = useCallback((initialDetail = 'Configuring firewall...') => {
    setFirewallStatus('active')
    setFirewallDetail(initialDetail)
    const pollFirewall = async (attempts = 0) => {
      if (!mountedRef.current) return
      if (attempts >= SETUP_WIZARD_FIREWALL_POLL_MAX_ATTEMPTS) {
        setFirewallStatus('error')
        setFirewallDetail('Firewall configuration timed out')
        return
      }
      try {
        const action = await dispatch(fetchNetworkStatus()).unwrap()
        if (!action.firewall.configuring) {
          if (action.firewall.portOpen === true) {
            setFirewallStatus('done')
            setFirewallDetail('Firewall configured — port is open')
          } else if (action.firewall.portOpen === false) {
            setFirewallStatus('error')
            setFirewallDetail('Firewall configuration did not open the port')
          } else if (action.firewall.platform === 'wsl2' && !isRemoteAccessEnabledStatus(action)) {
            setFirewallStatus('error')
            setFirewallDetail('Port may be blocked by firewall')
          } else {
            setFirewallStatus('done')
            setFirewallDetail('Firewall configured')
          }
          return
        }
      } catch {
        // Ignore transient polling failures and continue retrying.
      }
      firewallPollTimerRef.current = setTimeout(() => {
        firewallPollTimerRef.current = null
        void pollFirewall(attempts + 1)
      }, SETUP_WIZARD_FIREWALL_POLL_INTERVAL_MS)
    }
    firewallPollTimerRef.current = setTimeout(() => {
      firewallPollTimerRef.current = null
      void pollFirewall()
    }, SETUP_WIZARD_FIREWALL_POLL_INTERVAL_MS)
  }, [dispatch])

  const refreshFirewallStatus = useCallback(async (pendingDetail: string) => {
    setFirewallStatus('active')
    setFirewallDetail(pendingDetail)
    try {
      const action = await dispatch(fetchNetworkStatus()).unwrap()
      if (!isBoundToAllInterfaces(action)) {
        setBindStatus('error')
        setBindDetail('Remote access is not enabled')
        setFirewallStatus('error')
        setFirewallDetail('Remote access is not enabled')
        return
      }
      applyFirewallChecklistState(action)
    } catch {
      setFirewallStatus('error')
      setFirewallDetail('Failed to refresh firewall status')
    }
  }, [applyFirewallChecklistState, dispatch])

  const handleFirewallResult = useCallback((result: ConfigureFirewallResult) => {
    if (result.method === 'confirmation-required') {
      setFirewallConfirmation(result)
      return
    }

    if (result.method === 'none') {
      void refreshFirewallStatus(result.message ?? 'Refreshing firewall status...')
      return
    }

    if (result.method === 'terminal') {
      const tabId = nanoid()
      dispatch(addTab({ id: tabId, title: 'Firewall Setup', mode: 'shell', shell: 'system' }))
      dispatch(initLayout({ tabId, content: { kind: 'terminal', mode: 'shell' } }))
      onFirewallTerminal?.({ tabId, command: result.command })
      // Dismiss the wizard overlay so the user can interact with the
      // terminal pane (type the sudo password).
      onComplete?.()
      onNavigate?.('terminal')
      return
    }

    if (result.method === 'in-progress') {
      startFirewallPolling(result.error)
      return
    }

    if (result.method === 'wsl2' || result.method === 'windows-elevated') {
      startFirewallPolling()
    }
  }, [onComplete, onNavigate, onFirewallTerminal, refreshFirewallStatus, startFirewallPolling])

  const requestFirewallConfig = useCallback(async (
    body: { confirmElevation?: true; confirmationToken?: string } = {},
  ) => {
    const result = await fetchFirewallConfig(body)
    handleFirewallResult(result)
  }, [handleFirewallResult])

  const handleConfigureFirewall = useCallback(async () => {
    try {
      await requestFirewallConfig()
    } catch (err: any) {
      setFirewallStatus('error')
      setFirewallDetail(err?.message || 'Firewall configuration failed')
    }
  }, [requestFirewallConfig])

  const handleConfirmFirewall = useCallback(async () => {
    if (!firewallConfirmation) {
      return
    }

    const confirmationToken = firewallConfirmation.confirmationToken
    setFirewallConfirmation(null)
    try {
      await requestFirewallConfig({
        confirmElevation: true,
        confirmationToken,
      })
    } catch (err: any) {
      setFirewallStatus('error')
      setFirewallDetail(err?.message || 'Firewall configuration failed')
    }
  }, [firewallConfirmation, requestFirewallConfig])

  const handleCancelFirewallConfirmation = useCallback(() => {
    const confirmationToken = firewallConfirmation?.confirmationToken
    setFirewallConfirmation(null)
    if (!confirmationToken) {
      return
    }
    void cancelFirewallConfirmation(confirmationToken).catch(() => {})
  }, [firewallConfirmation])

  const handleContinueAnyway = useCallback(() => {
    if (networkStatus?.firewall.platform === 'wsl2' && !isRemoteAccessEnabledStatus(networkStatus)) {
      onComplete()
      return
    }

    setStep(3)
  }, [networkStatus, onComplete])

  return (
    <>
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
        role={firewallConfirmation ? undefined : 'dialog'}
        aria-modal={firewallConfirmation ? undefined : 'true'}
        aria-label={firewallConfirmation ? undefined : 'Network setup wizard'}
        aria-hidden={firewallConfirmation ? 'true' : undefined}
      >
        <div className="mx-4 w-full max-w-md rounded-lg border bg-background p-6 shadow-lg">
        {/* Step 1: Ask */}
        {step === 1 && (
          <div className="space-y-6">
            <div>
              <h2 className="text-lg font-semibold">Remote Access</h2>
              <p className="mt-2 text-sm text-muted-foreground">
                Set up Freshell so you can use it from your phone and other computers on your network?
              </p>
            </div>

            {error && (
              <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
                {error}
              </div>
            )}

            <div className="flex gap-3">
              <button
                onClick={handleYes}
                disabled={configuring}
                className="flex-1 rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-50"
                aria-label="Yes, set it up"
              >
                Yes, set it up
              </button>
              <button
                onClick={handleNo}
                disabled={configuring}
                className="flex-1 rounded-md border px-4 py-2 text-sm font-medium transition-colors hover:bg-muted disabled:opacity-50"
                aria-label="No, just this computer"
              >
                No, just this computer
              </button>
            </div>
          </div>
        )}

        {/* Step 2: Configure */}
        {step === 2 && (
          <div className="space-y-6">
            <div>
              <h2 className="text-lg font-semibold">Setting up remote access</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Configuring network access for your devices.
              </p>
            </div>

            <div className="space-y-1">
              <ChecklistItem label="Binding to network..." status={bindStatus} detail={bindDetail} />
              <ChecklistItem label="Checking firewall..." status={firewallStatus} detail={firewallDetail} />
              {bindStatus === 'done' && firewallStatus === 'error' && networkStatus?.firewall && (
                <button
                  onClick={handleConfigureFirewall}
                  className="ml-8 mt-1 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-muted"
                  aria-label="Configure firewall now"
                >
                  Configure now
                </button>
              )}
            </div>

            {bindStatus === 'error' && (
              <div className="flex gap-3">
                <button
                  onClick={() => { setStep(1); setBindStatus('pending'); setBindDetail(undefined); setError(null) }}
                  className="flex-1 rounded-md border px-4 py-2 text-sm font-medium transition-colors hover:bg-muted"
                >
                  Back
                </button>
                <button
                  onClick={onComplete}
                  className="flex-1 rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background transition-opacity hover:opacity-90"
                >
                  Close
                </button>
              </div>
            )}

            {bindStatus === 'done' && firewallStatus === 'error' && (
              <button
                onClick={handleContinueAnyway}
                className="w-full rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background transition-opacity hover:opacity-90"
                aria-label="Continue anyway"
              >
                Continue anyway
              </button>
            )}
          </div>
        )}

        {/* Step 3: Done */}
        {step === 3 && (
          <div className="space-y-6">
            <div>
              <h2 className="text-lg font-semibold">You&apos;re all set!</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Freshell is now accessible from other devices on your network.
              </p>
            </div>

            {shareAccessUrl && (
              <div className="flex flex-col items-center gap-4">
                <QrCode url={shareAccessUrl} />
                <div className="flex w-full items-center gap-2">
                  <code className="flex-1 truncate rounded bg-muted px-3 py-2 text-xs">
                    {shareAccessUrl}
                  </code>
                  <button
                    onClick={handleCopy}
                    className="rounded-md border p-2 transition-colors hover:bg-muted"
                    aria-label={copied ? 'Copied' : 'Copy URL'}
                  >
                    {copied ? <Check className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4" />}
                  </button>
                </div>
              </div>
            )}

            {networkStatus?.devMode && networkStatus.firewall?.platform !== 'wsl2' && (
              <div className="rounded border border-yellow-200 bg-yellow-50 p-3 text-sm text-yellow-800 dark:border-yellow-800 dark:bg-yellow-950 dark:text-yellow-300" role="alert">
                You&apos;re running in dev mode. Restart <code className="font-mono text-xs">npm run dev</code> for the Vite dev server to bind to the new address.
              </div>
            )}

            <button
              onClick={onComplete}
              className="w-full rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background transition-opacity hover:opacity-90"
            >
              Done
            </button>
          </div>
        )}
        </div>
      </div>
      <ConfirmModal
        open={firewallConfirmation !== null}
        title={firewallConfirmation?.title ?? ''}
        body={firewallConfirmation?.body ?? ''}
        confirmLabel={firewallConfirmation?.confirmLabel ?? 'Continue'}
        confirmVariant="default"
        onConfirm={() => {
          void handleConfirmFirewall()
        }}
        onCancel={handleCancelFirewallConfirmation}
      />
    </>
  )
}
