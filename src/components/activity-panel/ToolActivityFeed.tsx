import { useRef, useEffect, useState } from 'react'
import { Terminal, FileText, AlertCircle, Check, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatToolName, formatTimestamp } from '@/lib/activity-panel-utils'
import type { ActivityPanelEvent } from '@/store/activityPanelTypes'

interface ToolActivityFeedProps {
  events: ActivityPanelEvent[]
}

function EventIcon({ event }: { event: ActivityPanelEvent['event'] }) {
  if (event.type === 'error') {
    return <AlertCircle className="h-3.5 w-3.5 text-red-500 shrink-0" />
  }
  if (event.type === 'tool.result') {
    if (event.tool?.isError) {
      return <AlertCircle className="h-3.5 w-3.5 text-red-500 shrink-0" />
    }
    return <Check className="h-3.5 w-3.5 text-green-500 shrink-0" />
  }
  if (event.type === 'tool.call') {
    return <Terminal className="h-3.5 w-3.5 text-blue-500 shrink-0" />
  }
  if (event.type === 'approval.request' || event.type === 'approval.response') {
    return <FileText className="h-3.5 w-3.5 text-amber-500 shrink-0" />
  }
  if (event.type === 'token.usage') {
    return <Loader2 className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
  }
  return <FileText className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
}

function EventRow({ panelEvent }: { panelEvent: ActivityPanelEvent }) {
  const { event } = panelEvent

  let label: string
  let detail: string | undefined

  if (event.type === 'tool.call') {
    label = formatToolName(event.tool?.name ?? 'Unknown')
    // Truncate arguments for preview
    if (event.tool?.arguments) {
      const argStr = typeof event.tool.arguments === 'string'
        ? event.tool.arguments
        : JSON.stringify(event.tool.arguments)
      detail = argStr.length > 80 ? argStr.slice(0, 80) + '...' : argStr
    }
  } else if (event.type === 'tool.result') {
    label = formatToolName(event.tool?.name ?? 'Result')
    if (event.tool?.isError) {
      detail = event.tool.output?.slice(0, 80) ?? 'Error'
    } else {
      detail = event.tool?.output
        ? (event.tool.output.length > 80 ? event.tool.output.slice(0, 80) + '...' : event.tool.output)
        : 'Success'
    }
  } else if (event.type === 'error') {
    label = 'Error'
    detail = event.error?.message
  } else if (event.type === 'approval.request') {
    label = `Permission: ${formatToolName(event.approval?.toolName ?? 'Unknown')}`
    detail = event.approval?.description
  } else if (event.type === 'approval.response') {
    label = `Permission ${event.approval?.approved ? 'Approved' : 'Denied'}`
    detail = formatToolName(event.approval?.toolName ?? '')
  } else if (event.type === 'token.usage') {
    label = 'Token usage update'
  } else {
    label = event.type
  }

  return (
    <div className={cn(
      'flex items-start gap-2 py-1.5 px-3 text-xs',
      event.type === 'error' && 'bg-red-500/5',
    )}>
      <EventIcon event={event} />
      <div className="flex-1 min-w-0">
        <div className="font-medium truncate">{label}</div>
        {detail && (
          <div className="text-muted-foreground truncate">{detail}</div>
        )}
      </div>
      <span className="text-[10px] text-muted-foreground shrink-0 mt-0.5">
        {formatTimestamp(event.timestamp)}
      </span>
    </div>
  )
}

export default function ToolActivityFeed({ events }: ToolActivityFeedProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [autoScroll, setAutoScroll] = useState(true)

  // Auto-scroll to bottom on new events (if user hasn't scrolled up)
  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [events.length, autoScroll])

  // Detect manual scroll to disable auto-scroll
  const handleScroll = () => {
    if (!scrollRef.current) return
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current
    const atBottom = scrollHeight - scrollTop - clientHeight < 32
    setAutoScroll(atBottom)
  }

  if (events.length === 0) {
    return (
      <div className="text-xs text-muted-foreground px-3 py-4 text-center">
        No tool activity yet
      </div>
    )
  }

  return (
    <div
      ref={scrollRef}
      className="flex-1 overflow-y-auto divide-y divide-border"
      onScroll={handleScroll}
    >
      {events.map((panelEvent) => (
        <EventRow key={panelEvent.id} panelEvent={panelEvent} />
      ))}
    </div>
  )
}
