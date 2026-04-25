import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { Settings } from 'lucide-react'

import { Switch } from '@/components/ui/switch'
import { useMobile } from '@/hooks/useMobile'
import { useKeyboardInset } from '@/hooks/useKeyboardInset'
import type { AgentChatSettingsModelOption } from '@/lib/agent-chat-capabilities'
import type { AgentChatProviderConfig } from '@/lib/agent-chat-types'
import { cn } from '@/lib/utils'
import type { AgentChatPaneContent } from '@/store/paneTypes'
import type { AgentChatProviderCapabilitiesState } from '@/store/agentChatTypes'

type SettingsFields = Pick<AgentChatPaneContent, 'permissionMode' | 'effort'> & {
  model?: string
  showThinking?: boolean
  showTools?: boolean
  showTimecodes?: boolean
}

interface AgentChatSettingsProps {
  model: string
  permissionMode: string
  effort: string
  showThinking: boolean
  showTools: boolean
  showTimecodes: boolean
  sessionStarted: boolean
  defaultOpen?: boolean
  modelOptions?: AgentChatSettingsModelOption[]
  effortOptions?: string[]
  capabilitiesStatus?: AgentChatProviderCapabilitiesState['status']
  capabilityError?: AgentChatProviderCapabilitiesState['error']
  settingsVisibility?: AgentChatProviderConfig['settingsVisibility']
  onChange: (changes: Partial<SettingsFields>) => void
  onDismiss?: () => void
  onRetryCapabilities?: () => void
  onOpenChange?: (open: boolean) => void
}

const PERMISSION_OPTIONS = [
  { value: 'bypassPermissions', label: 'Skip permissions' },
  { value: 'default', label: 'Default (ask)' },
]

export default function AgentChatSettings({
  model,
  permissionMode,
  effort,
  showThinking,
  showTools,
  showTimecodes,
  sessionStarted,
  defaultOpen = false,
  modelOptions,
  effortOptions,
  capabilitiesStatus = 'idle',
  capabilityError,
  settingsVisibility,
  onChange,
  onDismiss,
  onRetryCapabilities,
  onOpenChange,
}: AgentChatSettingsProps) {
  const instanceId = useId()
  const isMobile = useMobile()
  const keyboardInsetPx = useKeyboardInset()
  const [open, setOpen] = useState(defaultOpen)
  const popoverRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    setOpen(defaultOpen)
  }, [defaultOpen])

  useEffect(() => {
    onOpenChange?.(open)
  }, [onOpenChange, open])

  const handleClose = useCallback(() => {
    setOpen(false)
    onDismiss?.()
  }, [onDismiss])

  const handleToggle = useCallback(() => {
    if (open) {
      handleClose()
      return
    }
    setOpen(true)
  }, [handleClose, open])

  useEffect(() => {
    if (!open) return

    const handleMouseDown = (event: MouseEvent) => {
      const target = event.target as Node
      if (
        popoverRef.current && !popoverRef.current.contains(target)
        && buttonRef.current && !buttonRef.current.contains(target)
      ) {
        handleClose()
      }
    }

    document.addEventListener('mousedown', handleMouseDown)
    return () => document.removeEventListener('mousedown', handleMouseDown)
  }, [handleClose, open])

  useEffect(() => {
    if (!open) return

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      handleClose()
    }

    document.addEventListener('keydown', handleEscape)
    return () => document.removeEventListener('keydown', handleEscape)
  }, [handleClose, open])

  const resolvedModelOptions = modelOptions ?? []
  const selectedModelOption = useMemo(
    () => resolvedModelOptions.find((option) => option.value === model),
    [model, resolvedModelOptions],
  )
  const resolvedEffortOptions = effortOptions ?? []
  const showCapabilityControls = capabilitiesStatus !== 'failed'
  const showEffortControl = resolvedEffortOptions.length > 0

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={handleToggle}
        className={cn(
          'p-1 rounded hover:bg-muted transition-colors',
          open && 'bg-muted',
          isMobile && 'min-w-11 min-h-11'
        )}
        aria-label="Settings"
        aria-expanded={open}
      >
        <Settings className="h-3.5 w-3.5" />
      </button>

      {open && (
        <>
          {isMobile && (
            <button
              type="button"
              className="fixed inset-0 z-40 bg-black/40"
              aria-label="Close settings"
              onClick={handleClose}
            />
          )}
          <div
            ref={popoverRef}
            className={cn(
              'z-50 rounded-lg border bg-card p-3 shadow-lg',
              isMobile
                ? 'fixed inset-x-0 max-h-[80dvh] overflow-y-auto rounded-b-none border-x-0'
                : 'absolute right-0 top-full mt-1 w-64',
            )}
            style={isMobile ? { bottom: `${keyboardInsetPx}px` } : undefined}
            role="dialog"
            aria-label="Agent chat settings"
          >
            <div className="space-y-3">
              {capabilitiesStatus === 'loading' && (
                <div role="status" className="text-xs text-muted-foreground">
                  Loading available models...
                </div>
              )}

              {capabilitiesStatus === 'failed' && capabilityError && (
                <div
                  role="alert"
                  className="rounded-md border border-red-300/60 bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-200"
                >
                  <p>{capabilityError.message}</p>
                  {(capabilityError.retryable ?? true) && onRetryCapabilities && (
                    <button
                      type="button"
                      className="mt-2 rounded-md border border-red-400/60 px-2 py-1 text-xs font-medium hover:bg-red-500/10"
                      onClick={onRetryCapabilities}
                    >
                      Retry model load
                    </button>
                  )}
                </div>
              )}

              {showCapabilityControls && settingsVisibility?.model !== false && (
                <div className="space-y-1">
                  <label htmlFor={`${instanceId}-model`} className="text-xs font-medium">Model</label>
                  <select
                    id={`${instanceId}-model`}
                    aria-label="Model"
                    value={model}
                    onChange={(event) => onChange({ model: event.target.value })}
                    className="w-full rounded border bg-background px-2 py-1 text-xs"
                  >
                    {resolvedModelOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  {selectedModelOption?.description && (
                    <p className="text-[11px] text-muted-foreground">
                      {selectedModelOption.description}
                    </p>
                  )}
                </div>
              )}

              {settingsVisibility?.permissionMode !== false && (
                <div className="space-y-1">
                  <label htmlFor={`${instanceId}-permissions`} className="text-xs font-medium">Permissions</label>
                  <select
                    id={`${instanceId}-permissions`}
                    aria-label="Permissions"
                    value={permissionMode}
                    onChange={(event) => onChange({ permissionMode: event.target.value })}
                    className="w-full rounded border bg-background px-2 py-1 text-xs"
                  >
                    {PERMISSION_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {showCapabilityControls && settingsVisibility?.effort !== false && showEffortControl && (
                <div className="space-y-1">
                  <label htmlFor={`${instanceId}-effort`} className="text-xs font-medium">Effort</label>
                  <select
                    id={`${instanceId}-effort`}
                    aria-label="Effort"
                    value={effort}
                    disabled={sessionStarted}
                    onChange={(event) => onChange({ effort: event.target.value || undefined })}
                    className="w-full rounded border bg-background px-2 py-1 text-xs disabled:opacity-50"
                  >
                    <option value="">Model default</option>
                    {resolvedEffortOptions.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {showCapabilityControls && settingsVisibility?.effort !== false && !showEffortControl && (
                <p className="text-[11px] text-muted-foreground">
                  This model uses its own default effort behavior.
                </p>
              )}

              <hr className="border-border" />

              {settingsVisibility?.thinking !== false && (
                <ToggleRow
                  label="Show thinking"
                  checked={showThinking}
                  onChange={(checked) => onChange({ showThinking: checked })}
                />
              )}
              {settingsVisibility?.tools !== false && (
                <ToggleRow
                  label="Show tools"
                  checked={showTools}
                  onChange={(checked) => onChange({ showTools: checked })}
                />
              )}
              {settingsVisibility?.timecodes !== false && (
                <ToggleRow
                  label="Show timecodes & model"
                  checked={showTimecodes}
                  onChange={(checked) => onChange({ showTimecodes: checked })}
                />
              )}

              {isMobile && (
                <button
                  type="button"
                  className="mt-2 min-h-11 w-full rounded-md border border-border px-3 text-sm font-medium"
                  onClick={handleClose}
                >
                  Done
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function ToggleRow({
  label,
  checked,
  onChange,
}: {
  label: string
  checked: boolean
  onChange: (value: boolean) => void
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-xs">{label}</span>
      <Switch
        checked={checked}
        onCheckedChange={onChange}
        aria-label={label}
      />
    </div>
  )
}
