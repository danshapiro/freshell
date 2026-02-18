import { ShieldAlert, Check, X } from 'lucide-react'
import { formatToolName } from '@/lib/activity-panel-utils'
import type { PendingApproval } from '@/store/activityPanelTypes'

interface PermissionActionsProps {
  approvals: PendingApproval[]
  onApprove: (requestId: string) => void
  onDeny: (requestId: string) => void
}

export default function PermissionActions({ approvals, onApprove, onDeny }: PermissionActionsProps) {
  if (approvals.length === 0) {
    return null
  }

  return (
    <div className="space-y-2 px-3 py-2">
      {approvals.map((approval) => (
        <div
          key={approval.requestId}
          className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-2"
        >
          <ShieldAlert className="h-4 w-4 shrink-0 text-amber-500 mt-0.5" />
          <div className="flex-1 min-w-0">
            <div className="text-xs font-medium truncate">
              {formatToolName(approval.toolName)}
            </div>
            <div className="text-[11px] text-muted-foreground truncate">
              {approval.description}
            </div>
          </div>
          <div className="flex gap-1 shrink-0">
            <button
              onClick={() => onApprove(approval.requestId)}
              className="inline-flex h-6 w-6 items-center justify-center rounded bg-green-500/20 text-green-500 hover:bg-green-500/30 transition-colors"
              title="Approve"
              aria-label={`Approve ${approval.toolName}`}
            >
              <Check className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={() => onDeny(approval.requestId)}
              className="inline-flex h-6 w-6 items-center justify-center rounded bg-red-500/20 text-red-500 hover:bg-red-500/30 transition-colors"
              title="Deny"
              aria-label={`Deny ${approval.toolName}`}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}
