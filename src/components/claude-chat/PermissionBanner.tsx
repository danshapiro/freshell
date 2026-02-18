import { memo } from 'react'
import { ShieldAlert, Terminal, FileText, Pencil, Eye } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { PermissionRequest } from '@/store/claudeChatTypes'

interface PermissionBannerProps {
  permission: PermissionRequest
  onAllow: () => void
  onDeny: () => void
  disabled?: boolean
}

const TOOL_ICONS: Record<string, typeof Terminal> = {
  Bash: Terminal,
  Read: Eye,
  Write: FileText,
  Edit: Pencil,
}

function PermissionBanner({ permission, onAllow, onDeny, disabled }: PermissionBannerProps) {
  const toolName = permission.tool?.name ?? 'Unknown'
  const Icon = TOOL_ICONS[toolName] || ShieldAlert
  const input = permission.tool?.input

  return (
    <div
      className="border border-yellow-500/50 bg-yellow-500/10 rounded-lg p-3 space-y-2"
      role="alert"
      aria-label={`Permission request for ${toolName}`}
    >
      <div className="flex items-center gap-2 text-sm font-medium">
        <ShieldAlert className="h-4 w-4 text-yellow-500" />
        <span>Permission requested: {toolName}</span>
      </div>

      {input && (
        <div className="flex items-start gap-2 text-xs">
          <Icon className="h-3 w-3 mt-0.5 shrink-0 text-muted-foreground" />
          <pre className="font-mono whitespace-pre-wrap max-h-32 overflow-y-auto text-muted-foreground">
            {toolName === 'Bash' && typeof input.command === 'string'
              ? `$ ${input.command}`
              : JSON.stringify(input, null, 2)}
          </pre>
        </div>
      )}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={onAllow}
          disabled={disabled}
          className={cn(
            'px-3 py-1 text-xs rounded font-medium',
            'bg-green-600 text-white hover:bg-green-700',
            'disabled:opacity-50'
          )}
          aria-label="Allow tool use"
        >
          Allow
        </button>
        <button
          type="button"
          onClick={onDeny}
          disabled={disabled}
          className={cn(
            'px-3 py-1 text-xs rounded font-medium',
            'bg-red-600 text-white hover:bg-red-700',
            'disabled:opacity-50'
          )}
          aria-label="Deny tool use"
        >
          Deny
        </button>
      </div>
    </div>
  )
}

export default memo(PermissionBanner)
