// Quick-access popover for network/remote access status in the sidebar.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import { configureNetwork } from '@/store/networkSlice'
import { isRemoteAccessEnabledStatus } from '@/lib/share-utils'
import { api } from '@/lib/api'
import { createLogger } from '@/lib/client-logger'
import { cn } from '@/lib/utils'
import { Globe, Check, Copy, Share2 } from 'lucide-react'

const log = createLogger('NetworkQuickAccess')

export interface NetworkQuickAccessProps {
  onSharePanel?: () => void
}

export default function NetworkQuickAccess({ onSharePanel }: NetworkQuickAccessProps) {
  const dispatch = useAppDispatch()
  const networkStatus = useAppSelector((s) => s.network?.status ?? null)
  const configuring = useAppSelector((s) => s.network?.configuring ?? false)
  const remoteAccessEnabled = isRemoteAccessEnabledStatus(networkStatus)
  const remoteAccessRequested = networkStatus?.remoteAccessRequested ?? remoteAccessEnabled
  const remoteAccessActive = remoteAccessEnabled || remoteAccessRequested
  const accessUrl = networkStatus?.accessUrl
  const firewall = networkStatus?.firewall

  // Build a shareable URL using the current browser origin so the link
  // works regardless of how you're accessing freshell (localhost, LAN IP,
  // custom domain, remote server).
  const shareUrl = useMemo(() => {
    if (!accessUrl) return null
    try {
      const parsed = new URL(accessUrl)
      const origin = typeof window !== 'undefined' ? window.location.origin : null
      if (origin) {
        const current = new URL(origin)
        parsed.protocol = current.protocol
        parsed.hostname = current.hostname
        parsed.port = current.port
      }
      return parsed.toString()
    } catch {
      return null
    }
  }, [accessUrl])

  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const popoverRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)

  // Close on click outside
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      const target = e.target as Node
      const inPopover = popoverRef.current?.contains(target) ?? false
      const inButton = buttonRef.current?.contains(target) ?? false
      if (!inPopover && !inButton) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const requiresPrivilegedDisable = (
    networkStatus?.firewall?.platform === 'windows'
    || networkStatus?.firewall?.platform === 'wsl2'
  )

  const handleToggleRemoteAccess = useCallback(async (enabled: boolean) => {
    try {
      if (!enabled && requiresPrivilegedDisable) {
        await api.post('/api/network/disable-remote-access', {})
        return
      }
      await dispatch(configureNetwork({
        host: enabled ? '0.0.0.0' : '127.0.0.1',
        configured: true,
      })).unwrap()
    } catch (error) {
      log.warn('Failed to configure remote access', error)
    }
  }, [dispatch, requiresPrivilegedDisable])

  const handleCopyUrl = useCallback(() => {
    if (!shareUrl) return
    void navigator.clipboard.writeText(shareUrl).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }, [shareUrl])

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    if (shareUrl) {
      void navigator.clipboard.writeText(shareUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }, [shareUrl])

  const handleDeviceAccess = useCallback(() => {
    setOpen(false)
    onSharePanel?.()
  }, [onSharePanel])

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen(!open)}
        onContextMenu={handleContextMenu}
        title={remoteAccessActive ? 'Remote access enabled' : 'Remote access disabled'}
        className={cn(
          'p-1.5 rounded-md hover:bg-muted transition-colors min-h-11 min-w-11 md:min-h-0 md:min-w-0 flex items-center justify-center',
          remoteAccessActive ? 'text-emerald-500' : 'text-muted-foreground',
        )}
        aria-label={remoteAccessActive ? 'Remote access: enabled' : 'Remote access: disabled'}
        data-testid="network-quick-access"
      >
        <Globe className="h-3.5 w-3.5" />
      </button>

      {open && (
        <div
          ref={popoverRef}
          className="absolute top-full right-0 md:right-auto md:left-0 mt-1 w-72 rounded-lg border border-border bg-card shadow-lg p-3 space-y-3 z-50"
          role="dialog"
          aria-label="Network access"
        >
          {/* Remote access toggle */}
          <div className="flex items-center justify-between">
            <span className="text-sm">Remote access</span>
            <button
              role="switch"
              aria-checked={remoteAccessActive}
              disabled={configuring}
              onClick={() => handleToggleRemoteAccess(!remoteAccessActive)}
              className={cn(
                'relative w-9 h-5 rounded-full transition-colors',
                remoteAccessActive ? 'bg-emerald-500' : 'bg-muted',
                configuring && 'opacity-50 cursor-not-allowed',
              )}
              aria-label="Toggle remote access"
            >
              <div
                className={cn(
                  'absolute top-0.5 h-4 w-4 rounded-full transition-all bg-white shadow',
                  remoteAccessActive ? 'left-[1.125rem]' : 'left-0.5',
                )}
                aria-hidden="true"
              />
            </button>
          </div>

          {/* Status */}
          <div className="flex items-center gap-2">
            <div className={cn(
              'w-2 h-2 rounded-full',
              remoteAccessActive ? 'bg-emerald-500' : 'bg-zinc-500',
            )} />
            <span className="text-xs text-muted-foreground">
              {configuring ? 'Configuring...' : remoteAccessActive ? 'Connected' : 'Local only'}
            </span>
          </div>

          {remoteAccessActive && (
            <>
              {/* Localhost URL with copy */}
              {shareUrl && (
                <div className="flex items-center gap-1.5">
                  <code className="flex-1 min-w-0 truncate text-xs bg-muted rounded px-2 py-1">
                    {shareUrl}
                  </code>
                  <button
                    onClick={handleCopyUrl}
                    className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors shrink-0"
                    aria-label="Copy access URL"
                  >
                    {copied
                      ? <Check className="w-3.5 h-3.5 text-emerald-500" />
                      : <Copy className="w-3.5 h-3.5" />
                    }
                  </button>
                </div>
              )}

              {/* Device access / share */}
              {onSharePanel && (
                <button
                  onClick={handleDeviceAccess}
                  className="w-full flex items-center gap-2 rounded-md border border-border/40 px-2.5 py-1.5 text-xs hover:bg-muted transition-colors"
                  aria-label="Get link for your devices"
                >
                  <Share2 className="w-3.5 h-3.5 text-muted-foreground" />
                  <span>Device access</span>
                  <span className="text-muted-foreground ml-auto">QR code &amp; link</span>
                </button>
              )}

              {/* Firewall status */}
              {firewall && (
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>Firewall</span>
                  <span>
                    {firewall.portOpen === true
                      ? 'Port open'
                      : firewall.active
                        ? 'Port may be blocked'
                        : 'No firewall detected'}
                    {' · '}{firewall.platform}
                  </span>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
