import { useEffect, useMemo, useRef } from 'react'
import { useAppSelector, useAppDispatch } from '@/store/hooks'
import { addCodingCliEvent, getCodingCliSessionEvents, setCodingCliSessionStatus } from '@/store/codingCliSlice'
import { cn } from '@/lib/utils'
import { MessageBubble } from './session/MessageBubble'
import { ToolCallBlock } from './session/ToolCallBlock'
import { ToolResultBlock } from './session/ToolResultBlock'
import { getWsClient } from '@/lib/ws-client'
import { getProviderLabel } from '@/lib/coding-cli-utils'
import type { NormalizedEvent } from '@/lib/coding-cli-types'

interface SessionViewProps {
  sessionId: string
  hidden?: boolean
}

export default function SessionView({ sessionId, hidden }: SessionViewProps) {
  const session = useAppSelector((s) => s.codingCli.sessions[sessionId])
  const dispatch = useAppDispatch()
  const scrollRef = useRef<HTMLDivElement>(null)
  const ws = useMemo(() => getWsClient(), [])
  const events = useMemo(() => (session ? getCodingCliSessionEvents(session) : []), [session])

  // Subscribe to WebSocket events for this session
  useEffect(() => {
    ws.connect().catch(() => {})
    const unsub = ws.onMessage((msg) => {
      if (msg.type === 'codingcli.event' && msg.sessionId === sessionId) {
        dispatch(addCodingCliEvent({ sessionId, event: msg.event }))
      }
      if (msg.type === 'codingcli.exit' && msg.sessionId === sessionId) {
        dispatch(
          setCodingCliSessionStatus({
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
  }, [events.length, hidden])

  if (!session) {
    return (
      <div className={cn('h-full w-full flex items-center justify-center', hidden ? 'hidden' : '')}>
        <span className="text-sm text-muted-foreground">Starting session...</span>
      </div>
    )
  }

  const statusBadge = session.status
  const providerLabel = getProviderLabel(session.provider)
  const endEvent = events.find((e) => e.type === 'session.end')

  const renderEvent = (event: NormalizedEvent, index: number) => {
    if (event.type === 'message.user' || event.type === 'message.assistant') {
      return <MessageBubble key={index} event={event} />
    }
    if (event.type === 'tool.call' && event.toolCall) {
      return <ToolCallBlock key={index} tool={event.toolCall} />
    }
    if (event.type === 'tool.result' && event.toolResult) {
      return <ToolResultBlock key={index} result={event.toolResult} />
    }
    if ((event.type === 'reasoning' || event.type === 'thinking') && (event.reasoning || event.thinking)) {
      const text = event.reasoning || event.thinking
      return (
        <div key={index} className="text-xs text-muted-foreground italic whitespace-pre-wrap">
          {text}
        </div>
      )
    }
    return null
  }

  return (
    <div className={cn('h-full w-full flex flex-col', hidden ? 'hidden' : '')}>
      {/* Header */}
      <div className="flex-none border-b px-4 py-2 bg-muted/30">
        <div className="flex items-center gap-2 text-sm text-muted-foreground truncate">
          <span className="text-xs bg-muted px-1.5 py-0.5 rounded">{providerLabel}</span>
          <span className="truncate">Prompt: {session.prompt}</span>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground mt-1">
          <span
            className={cn(
              'px-1.5 py-0.5 rounded',
              statusBadge === 'running' && 'bg-blue-500/20 text-blue-500',
              statusBadge === 'completed' && 'bg-green-500/20 text-green-500',
              statusBadge === 'error' && 'bg-red-500/20 text-red-500'
            )}
          >
            {statusBadge}
          </span>
          {session.providerSessionId && (
            <span className="font-mono">{session.providerSessionId.slice(0, 8)}...</span>
          )}
        </div>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-4">
        {events.length === 0 && session.status === 'running' && (
          <div className="text-center text-muted-foreground py-8">
            <div className="animate-pulse">Waiting for response...</div>
          </div>
        )}

        {events.map(renderEvent)}

        {endEvent && (
          <div className="text-center text-sm text-muted-foreground py-4 border-t mt-4">
            <span className="bg-muted px-2 py-1 rounded">
              Session ended
              {endEvent.tokenUsage && ` • ${endEvent.tokenUsage.total} tokens`}
            </span>
          </div>
        )}
      </div>

      {/* Status footer */}
      <div className="flex-none border-t p-4 bg-muted/30">
        <div className="text-sm text-muted-foreground text-center">
          {session.status === 'running' ? <span>Session running...</span> : <span>Session {session.status}</span>}
        </div>
      </div>
    </div>
  )
}
