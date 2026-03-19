// Quick-access popover for network/remote access status in the sidebar.

import { useCallback, useEffect, useRef, useState } from 'react'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import { configureNetwork } from '@/store/networkSlice'
import { isRemoteAccessEnabledStatus } from '@/lib/share-utils'
import { createLogger } from '@/lib/client-logger'
import { cn } from '@/lib/utils'
import { Globe, Check, Copy } from 'lucide-react'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'

const log = createLogger('NetworkQuickAccess')

export default function NetworkQuickAccess() {
  const dispatch = useAppDispatch()
  const networkStatus = useAppSelector((s) => s.network?.status ?? null)
  const configuring = useAppSelector((s) => s.network?.configuring ?? false)
  const remoteAccessEnabled = isRemoteAccessEnabledStatus(networkStatus)
  const accessUrl = networkStatus?.accessUrl

  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const popoverRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)

  // Close on click outside
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (
        popoverRef.current && !popoverRef.current.contains(e.target as Node) &&
        buttonRef.current && !buttonRef.current.contains(e.target as Node)
      ) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const handleToggleRemoteAccess = useCallback(async (enabled: boolean) => {
    try {
      await dispatch(configureNetwork({
        host: enabled ? '0.0.0.0' : '127.0.0.1',
        configured: true,
      })).unwrap()
    } catch (error) {
      log.warn('Failed to configure remote access', error)
    }
  }, [dispatch])

  const handleCopyUrl = useCallback(() => {
    if (!accessUrl) return
    void navigator.clipboard.writeText(accessUrl).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }, [accessUrl])

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    if (accessUrl) {
      void navigator.clipboard.writeText(accessUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }, [accessUrl])

  return (
    <div className="relative">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            ref={buttonRef}
            type="button"
            onClick={() => setOpen(!open)}
            onContextMenu={handleContextMenu}
            className={cn(
              'p-1.5 rounded-md hover:bg-muted transition-colors min-h-11 min-w-11 md:min-h-0 md:min-w-0 flex items-center justify-center',
              remoteAccessEnabled ? 'text-emerald-500' : 'text-muted-foreground',
            )}
            aria-label={remoteAccessEnabled ? 'Remote access: enabled' : 'Remote access: disabled'}
            data-testid="network-quick-access"
          >
            <Globe className="h-3.5 w-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {remoteAccessEnabled ? 'Remote access enabled' : 'Remote access disabled'}
        </TooltipContent>
      </Tooltip>

      {open && (
        <div
          ref={popoverRef}
          className="absolute top-full left-0 mt-1 w-64 rounded-lg border border-border bg-card shadow-lg p-3 space-y-3 z-50"
          role="dialog"
          aria-label="Network access"
        >
          {/* Remote access toggle */}
          <div className="flex items-center justify-between">
            <span className="text-sm">Remote access</span>
            <button
              role="switch"
              aria-checked={remoteAccessEnabled}
              disabled={configuring || networkStatus?.rebinding}
              onClick={() => handleToggleRemoteAccess(!remoteAccessEnabled)}
              className={cn(
                'relative w-9 h-5 rounded-full transition-colors',
                remoteAccessEnabled ? 'bg-emerald-500' : 'bg-muted',
                (configuring || networkStatus?.rebinding) && 'opacity-50 cursor-not-allowed',
              )}
              aria-label="Toggle remote access"
            >
              <div
                className={cn(
                  'absolute top-0.5 h-4 w-4 rounded-full transition-all bg-white shadow',
                  remoteAccessEnabled ? 'left-[1.125rem]' : 'left-0.5',
                )}
                aria-hidden="true"
              />
            </button>
          </div>

          {/* Status */}
          <div className="flex items-center gap-2">
            <div className={cn(
              'w-2 h-2 rounded-full',
              remoteAccessEnabled ? 'bg-emerald-500' : 'bg-zinc-500',
            )} />
            <span className="text-xs text-muted-foreground">
              {configuring ? 'Configuring...' : remoteAccessEnabled ? 'Connected' : 'Local only'}
            </span>
          </div>

          {/* URL with copy */}
          {remoteAccessEnabled && accessUrl && (
            <div className="flex items-center gap-1.5">
              <code className="flex-1 min-w-0 truncate text-xs bg-muted rounded px-2 py-1">
                {accessUrl}
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
        </div>
      )}
    </div>
  )
}
