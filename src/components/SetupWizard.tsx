import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import { configureNetwork, fetchNetworkStatus } from '@/store/networkSlice'
import { addTab } from '@/store/tabsSlice'
import { initLayout } from '@/store/panesSlice'
import { fetchFirewallConfig } from '@/lib/firewall-configure'
import { generate } from 'lean-qr'
import { toSvgDataURL } from 'lean-qr/extras/svg'
import { nanoid } from '@reduxjs/toolkit'
import { Check, Loader2, AlertCircle, Copy } from 'lucide-react'
import type { AppView } from '@/components/Sidebar'

interface SetupWizardProps {
  onComplete: () => void
  initialStep?: 1 | 2
  onNavigate?: (view: AppView) => void
  onFirewallTerminal?: (cmd: { tabId: string; command: string }) => void
}

type ChecklistItemStatus = 'pending' | 'active' | 'done' | 'error'

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
      return toSvgDataURL(code, { on: 'currentColor', off: 'transparent' })
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

  const [step, setStep] = useState<1 | 2 | 3>(initialStep)
  const [bindStatus, setBindStatus] = useState<ChecklistItemStatus>('pending')
  const [bindDetail, setBindDetail] = useState<string | undefined>()
  const [firewallStatus, setFirewallStatus] = useState<ChecklistItemStatus>('pending')
  const [firewallDetail, setFirewallDetail] = useState<string | undefined>()
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Watch for rebinding completion when on step 2
  useEffect(() => {
    if (bindStatus === 'active' && networkStatus && !networkStatus.rebinding) {
      if (networkStatus.host === '0.0.0.0') {
        setBindStatus('done')
        setBindDetail('Bound to all interfaces')
      } else {
        setBindStatus('error')
        setBindDetail('Rebind failed — rolled back to localhost')
      }
    }
  }, [bindStatus, networkStatus?.rebinding, networkStatus?.host])

  // Check firewall status after bind completes
  useEffect(() => {
    if (bindStatus === 'done' && networkStatus?.firewall) {
      if (!networkStatus.firewall.active) {
        setFirewallStatus('done')
        setFirewallDetail('No firewall detected')
      } else if (networkStatus.firewall.portOpen === true) {
        setFirewallStatus('done')
        setFirewallDetail('Port is open')
      } else if (networkStatus.firewall.portOpen === false) {
        setFirewallStatus('error')
        setFirewallDetail('Port may be blocked by firewall')
      } else {
        setFirewallStatus('done')
        setFirewallDetail('Firewall detected — check may be needed')
      }
    }
  }, [bindStatus, networkStatus?.firewall])

  // Auto-advance to step 3 when all checklist items are done.
  // Firewall errors stay on step 2 so the user can see and act on them.
  useEffect(() => {
    if (step === 2 && bindStatus === 'done' && firewallStatus === 'done') {
      const timer = setTimeout(() => setStep(3), 800)
      return () => clearTimeout(timer)
    }
  }, [step, bindStatus, firewallStatus])

  // Start binding when entering step 2 directly (e.g. re-enabling remote access
  // from share button after the user previously chose localhost-only).
  const startBind = useCallback(async () => {
    setBindStatus('active')
    setBindDetail('Binding to network...')
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

  // Auto-trigger bind when entering at step 2 directly (initialStep=2).
  // Without this, step 2 shows a pending checklist with no way to progress.
  useEffect(() => {
    if (initialStep === 2 && step === 2 && bindStatus === 'pending') {
      startBind()
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps -- mount-only

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
    const url = networkStatus?.accessUrl
    if (!url) return
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard may not be available
    }
  }, [networkStatus?.accessUrl])

  const handleConfigureFirewall = useCallback(async () => {
    try {
      const result = await fetchFirewallConfig()
      if (result.method === 'terminal') {
        const tabId = nanoid()
        dispatch(addTab({ id: tabId, title: 'Firewall Setup', mode: 'shell', shell: 'system' }))
        dispatch(initLayout({ tabId, content: { kind: 'terminal', mode: 'shell' } }))
        onFirewallTerminal?.({ tabId, command: result.command })
        // Dismiss the wizard overlay so the user can interact with the
        // terminal pane (type the sudo password). The wizard is z-[70]
        // which blocks all interaction with the terminal underneath.
        onComplete?.()
        onNavigate?.('terminal')
      } else if (result.method === 'wsl2' || result.method === 'windows-elevated') {
        // Server handles elevated process; poll for completion
        setFirewallStatus('active')
        setFirewallDetail('Configuring firewall...')
        const pollFirewall = async (attempts = 0) => {
          if (attempts >= 10) {
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
              } else {
                setFirewallStatus('done')
                setFirewallDetail('Firewall configured')
              }
              return
            }
          } catch { /* ignore */ }
          setTimeout(() => pollFirewall(attempts + 1), 1000)
        }
        setTimeout(() => pollFirewall(), 1000)
      }
      // method === 'none' or 'in-progress': do nothing
    } catch (err: any) {
      setFirewallStatus('error')
      setFirewallDetail(err?.message || 'Firewall configuration failed')
    }
  }, [dispatch, onComplete, onNavigate, onFirewallTerminal])

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Network setup wizard"
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
              {firewallStatus === 'error' && networkStatus?.firewall && (
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
                onClick={() => setStep(3)}
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

            {networkStatus?.accessUrl && (
              <div className="flex flex-col items-center gap-4">
                <QrCode url={networkStatus.accessUrl} />
                <div className="flex w-full items-center gap-2">
                  <code className="flex-1 truncate rounded bg-muted px-3 py-2 text-xs">
                    {networkStatus.accessUrl}
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
  )
}
