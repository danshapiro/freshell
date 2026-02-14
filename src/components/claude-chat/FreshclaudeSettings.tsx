import { useCallback, useEffect, useRef, useState } from 'react'
import { Settings } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Switch } from '@/components/ui/switch'
import type { ClaudeChatPaneContent } from '@/store/paneTypes'

type SettingsFields = Pick<ClaudeChatPaneContent, 'model' | 'permissionMode' | 'showThinking' | 'showTools' | 'showTimecodes'>

interface FreshclaudeSettingsProps {
  model: string
  permissionMode: string
  showThinking: boolean
  showTools: boolean
  showTimecodes: boolean
  sessionStarted: boolean
  defaultOpen?: boolean
  onChange: (changes: Partial<SettingsFields>) => void
  onDismiss?: () => void
}

const MODEL_OPTIONS = [
  { value: 'claude-opus-4-6', label: 'Opus 4.6' },
  { value: 'claude-sonnet-4-5-20250929', label: 'Sonnet 4.5' },
  { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
]

const PERMISSION_OPTIONS = [
  { value: 'dangerouslySkipPermissions', label: 'Skip permissions' },
  { value: 'default', label: 'Default (ask)' },
]

export default function FreshclaudeSettings({
  model,
  permissionMode,
  showThinking,
  showTools,
  showTimecodes,
  sessionStarted,
  defaultOpen = false,
  onChange,
  onDismiss,
}: FreshclaudeSettingsProps) {
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

  // Close on Escape key (handled via onKeyDown on the dialog)
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      handleClose()
    }
  }, [handleClose])

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
        <div
          ref={popoverRef}
          className="absolute right-0 top-full mt-1 z-50 w-64 rounded-lg border bg-popover p-3 shadow-lg"
          role="dialog"
          aria-label="freshclaude settings"
          onKeyDown={handleKeyDown}
        >
          <div className="space-y-3">
            {/* Model */}
            <div className="space-y-1">
              <label htmlFor="fc-model" className="text-xs font-medium">Model</label>
              <select
                id="fc-model"
                aria-label="Model"
                value={model}
                disabled={sessionStarted}
                onChange={(e) => onChange({ model: e.target.value })}
                className="w-full rounded border bg-background px-2 py-1 text-xs disabled:opacity-50"
              >
                {MODEL_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>

            {/* Permission mode */}
            <div className="space-y-1">
              <label htmlFor="fc-permissions" className="text-xs font-medium">Permissions</label>
              <select
                id="fc-permissions"
                aria-label="Permissions"
                value={permissionMode}
                disabled={sessionStarted}
                onChange={(e) => onChange({ permissionMode: e.target.value })}
                className="w-full rounded border bg-background px-2 py-1 text-xs disabled:opacity-50"
              >
                {PERMISSION_OPTIONS.map((opt) => (
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
              label="Show timecodes"
              checked={showTimecodes}
              onChange={(v) => onChange({ showTimecodes: v })}
            />
          </div>
        </div>
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
