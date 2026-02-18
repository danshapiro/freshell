import { X, ChevronDown, ChevronRight } from 'lucide-react'
import { useState } from 'react'
import { cn } from '@/lib/utils'
import { useAppSelector } from '@/store/hooks'
import { getActivityPanelEvents } from '@/store/activityPanelSlice'
import TokenUsageMeter from './TokenUsageMeter'
import PermissionActions from './PermissionActions'
import ToolActivityFeed from './ToolActivityFeed'
import TaskList from './TaskList'

interface ActivityPanelProps {
  sessionId: string
  isOpen: boolean
  onClose: () => void
  onApprovePermission?: (requestId: string) => void
  onDenyPermission?: (requestId: string) => void
}

interface SectionProps {
  title: string
  defaultOpen?: boolean
  children: React.ReactNode
  badge?: number
}

function Section({ title, defaultOpen = true, children, badge }: SectionProps) {
  const [open, setOpen] = useState(defaultOpen)

  return (
    <div className="border-b border-border last:border-b-0">
      <button
        className="flex items-center gap-1 w-full px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
        onClick={() => setOpen(!open)}
      >
        {open
          ? <ChevronDown className="h-3 w-3 shrink-0" />
          : <ChevronRight className="h-3 w-3 shrink-0" />}
        {title}
        {badge != null && badge > 0 && (
          <span className="ml-auto text-[10px] bg-muted rounded-full px-1.5 py-0.5">
            {badge}
          </span>
        )}
      </button>
      {open && children}
    </div>
  )
}

export default function ActivityPanel({
  sessionId,
  isOpen,
  onClose,
  onApprovePermission,
  onDenyPermission,
}: ActivityPanelProps) {
  const session = useAppSelector((s) => s.activityPanel.sessions[sessionId])

  if (!isOpen) return null

  const events = session ? getActivityPanelEvents(session) : []
  const approvals = session?.pendingApprovals ?? []
  const tasks = session?.tasks ?? []
  const tokenTotals = session?.tokenTotals ?? {
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    totalCost: 0,
  }

  return (
    <div className={cn(
      'flex flex-col h-full w-80 border-l border-border bg-background',
      'shrink-0',
    )}>
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-border bg-muted/50">
        <span className="text-xs font-medium">Activity</span>
        <button
          onClick={onClose}
          className="inline-flex h-5 w-5 items-center justify-center rounded opacity-60 hover:opacity-100 transition-opacity"
          title="Close activity panel"
          aria-label="Close activity panel"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Sections */}
      <div className="flex flex-col flex-1 overflow-hidden">
        {/* Permission requests (always visible when present) */}
        {approvals.length > 0 && (
          <Section title="Permissions" badge={approvals.length}>
            <PermissionActions
              approvals={approvals}
              onApprove={onApprovePermission ?? (() => {})}
              onDeny={onDenyPermission ?? (() => {})}
            />
          </Section>
        )}

        {/* Token usage */}
        <Section title="Tokens">
          <TokenUsageMeter totals={tokenTotals} />
        </Section>

        {/* Tool activity feed (scrollable, takes remaining space) */}
        <Section title="Tool Activity" badge={events.length} defaultOpen>
          <ToolActivityFeed events={events} />
        </Section>

        {/* Active tasks */}
        {tasks.length > 0 && (
          <Section title="Tasks" badge={tasks.filter((t) => t.status !== 'completed').length}>
            <TaskList tasks={tasks} />
          </Section>
        )}
      </div>

      {/* Footer: session event count */}
      {session && (
        <div className="flex-none px-3 py-1 border-t border-border text-[10px] text-muted-foreground">
          {session.eventCount} events total
        </div>
      )}
    </div>
  )
}
