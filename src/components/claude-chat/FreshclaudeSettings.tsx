import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { Settings } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Switch } from '@/components/ui/switch'
import { useMobile } from '@/hooks/useMobile'
import type { ClaudeChatPaneContent } from '@/store/paneTypes'

type SettingsFields = Pick<ClaudeChatPaneContent, 'model' | 'permissionMode' | 'effort' | 'showThinking' | 'showTools' | 'showTimecodes'>

interface FreshclaudeSettingsProps {
  model: string
  permissionMode: string
  effort: string
  showThinking: boolean
  showTools: boolean
  showTimecodes: boolean
  sessionStarted: boolean
  defaultOpen?: boolean
  modelOptions?: Array<{ value: string; displayName: string }>
  onChange: (changes: Partial<SettingsFields>) => void
  onDismiss?: () => void
}

const MODEL_OPTIONS = [
  { value: 'claude-opus-4-6', label: 'Opus 4.6' },
  { value: 'claude-sonnet-4-5-20250929', label: 'Sonnet 4.5' },
  { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
]

const PERMISSION_OPTIONS = [
  { value: 'bypassPermissions', label: 'Skip permissions' },
  { value: 'default', label: 'Default (ask)' },
]

const EFFORT_OPTIONS = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'max', label: 'Max' },
]

export default function FreshclaudeSettings({
  model,
  permissionMode,
  effort,
  showThinking,
  showTools,
  showTimecodes,
  sessionStarted,
  defaultOpen = false,
  modelOptions,
  onChange,
  onDismiss,
}: FreshclaudeSettingsProps) {
  const instanceId = useId()
  const isMobile = useMobile()
  const [open, setOpen] = useState(defaultOpen)
  const popoverRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)

  const handleClose = useCallback(() => {
    setOpen(false)
    onDismiss?.()
  }, [onDismiss])

  const handleToggle = useCallback(() => {
    if (open) {
      handleClose()
    } else {
      setOpen(true)
    }
  }, [open, handleClose])

  // Close on click outside
  useEffect(() => {
    if (!open) return
    const handleMouseDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (
        popoverRef.current && !popoverRef.current.contains(target) &&
        buttonRef.current && !buttonRef.current.contains(target)
      ) {
        handleClose()
      }
    }
    document.addEventListener('mousedown', handleMouseDown)
    return () => document.removeEventListener('mousedown', handleMouseDown)
  }, [open, handleClose])

  // Close on Escape key — uses document listener so it works regardless of focus location
  useEffect(() => {
    if (!open) return
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        handleClose()
      }
    }
    document.addEventListener('keydown', handleEscape)
    return () => document.removeEventListener('keydown', handleEscape)
  }, [open, handleClose])

  // Use dynamic model options when available, fall back to hardcoded
  const resolvedModelOptions = modelOptions
    ? modelOptions.map((m) => ({ value: m.value, label: m.displayName }))
    : MODEL_OPTIONS

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={handleToggle}
        className={cn(
          'p-1 rounded hover:bg-muted transition-colors',
          open && 'bg-muted'
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
                ? 'fixed inset-x-0 bottom-0 max-h-[80dvh] overflow-y-auto rounded-b-none border-x-0'
                : 'absolute right-0 top-full mt-1 w-64',
            )}
            role="dialog"
            aria-label="freshclaude settings"
          >
            <div className="space-y-3">
            {/* Model */}
            <div className="space-y-1">
              <label htmlFor={`${instanceId}-model`} className="text-xs font-medium">Model</label>
              <select
                id={`${instanceId}-model`}
                aria-label="Model"
                value={model}
                onChange={(e) => onChange({ model: e.target.value })}
                className="w-full rounded border bg-background px-2 py-1 text-xs"
              >
                {resolvedModelOptions.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>

            {/* Permission mode */}
            <div className="space-y-1">
              <label htmlFor={`${instanceId}-permissions`} className="text-xs font-medium">Permissions</label>
              <select
                id={`${instanceId}-permissions`}
                aria-label="Permissions"
                value={permissionMode}
                onChange={(e) => onChange({ permissionMode: e.target.value })}
                className="w-full rounded border bg-background px-2 py-1 text-xs"
              >
                {PERMISSION_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>

            {/* Effort — locked after session starts */}
            <div className="space-y-1">
              <label htmlFor={`${instanceId}-effort`} className="text-xs font-medium">Effort</label>
              <select
                id={`${instanceId}-effort`}
                aria-label="Effort"
                value={effort}
                disabled={sessionStarted}
                onChange={(e) => onChange({ effort: e.target.value as ClaudeChatPaneContent['effort'] })}
                className="w-full rounded border bg-background px-2 py-1 text-xs disabled:opacity-50"
              >
                {EFFORT_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>

            <hr className="border-border" />

            {/* Display toggles using existing Switch component */}
            <ToggleRow
              label="Show thinking"
              checked={showThinking}
              onChange={(v) => onChange({ showThinking: v })}
            />
            <ToggleRow
              label="Show tools"
              checked={showTools}
              onChange={(v) => onChange({ showTools: v })}
            />
            <ToggleRow
              label="Show timecodes & model"
              checked={showTimecodes}
              onChange={(v) => onChange({ showTimecodes: v })}
            />
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

function ToggleRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
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
