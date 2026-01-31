import { useEffect, useRef, useMemo } from 'react'
import { useAppSelector, useAppDispatch } from '@/store/hooks'
import { addClaudeEvent, setClaudeSessionStatus } from '@/store/claudeSlice'
import { cn } from '@/lib/utils'
import { MessageBubble } from './claude/MessageBubble'
import { getWsClient } from '@/lib/ws-client'

interface ClaudeSessionViewProps {
  sessionId: string
  hidden?: boolean
}

export default function ClaudeSessionView({ sessionId, hidden }: ClaudeSessionViewProps) {
  const session = useAppSelector((s) => s.claude.sessions[sessionId])
  const dispatch = useAppDispatch()
  const scrollRef = useRef<HTMLDivElement>(null)
  const ws = useMemo(() => getWsClient(), [])

  // Subscribe to WebSocket events for this session
  useEffect(() => {
    const unsub = ws.onMessage((msg) => {
      if (msg.type === 'claude.event' && msg.sessionId === sessionId) {
        dispatch(addClaudeEvent({ sessionId, event: msg.event }))
      }
      if (msg.type === 'claude.exit' && msg.sessionId === sessionId) {
        dispatch(
          setClaudeSessionStatus({
            sessionId,
            status: msg.exitCode === 0 ? 'completed' : 'error',
          })
        )
      }
    })

    return unsub
  }, [sessionId, dispatch, ws])

  // Auto-scroll to bottom on new events
  useEffect(() => {
    if (scrollRef.current && !hidden) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [session?.messages.length, session?.result, hidden])

  if (!session) return null

  const messageEvents = session.messages
  const resultEvent = session.result

  return (
    <div className={cn('h-full w-full flex flex-col', hidden ? 'hidden' : '')}>
      {/* Header */}
      <div className="flex-none border-b px-4 py-2 bg-muted/30">
        <div className="text-sm text-muted-foreground truncate">Prompt: {session.prompt}</div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground mt-1">
          <span
            className={cn(
              'px-1.5 py-0.5 rounded',
              session.status === 'running' && 'bg-blue-500/20 text-blue-500',
              session.status === 'completed' && 'bg-green-500/20 text-green-500',
              session.status === 'error' && 'bg-red-500/20 text-red-500'
            )}
          >
            {session.status}
          </span>
          {session.claudeSessionId && <span className="font-mono">{session.claudeSessionId.slice(0, 8)}...</span>}
        </div>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-4">
        {messageEvents.length === 0 && session.status === 'running' && (
          <div className="text-center text-muted-foreground py-8">
            <div className="animate-pulse">Waiting for response...</div>
          </div>
        )}

        {messageEvents.map((event, index) => (
          <MessageBubble key={index} event={event} />
        ))}

        {resultEvent && (
          <div className="text-center text-sm text-muted-foreground py-4 border-t mt-4">
            <span className="bg-muted px-2 py-1 rounded">
              Completed in {(resultEvent.duration_ms / 1000).toFixed(1)}s
              {resultEvent.total_cost_usd && ` • $${resultEvent.total_cost_usd.toFixed(4)}`}
            </span>
          </div>
        )}
      </div>

      {/* Input area (placeholder for now) */}
      <div className="flex-none border-t p-4 bg-muted/30">
        <div className="text-sm text-muted-foreground text-center">
          {session.status === 'running' ? <span>Claude is working...</span> : <span>Session {session.status}</span>}
        </div>
      </div>
    </div>
  )
}
