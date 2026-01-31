import { useEffect, useRef, useMemo, useState } from 'react'
import { List, type RowComponentProps, useDynamicRowHeight, useListRef } from 'react-window'
import { useAppSelector, useAppDispatch } from '@/store/hooks'
import { addClaudeEvent, setClaudeSessionStatus } from '@/store/claudeSlice'
import { cn } from '@/lib/utils'
import { MessageBubble } from './claude/MessageBubble'
import { getWsClient } from '@/lib/ws-client'
import type { MessageEvent, ResultEvent } from '@/lib/claude-types'

interface ClaudeSessionViewProps {
  sessionId: string
  hidden?: boolean
}

type ClaudeRow =
  | { kind: 'message'; event: MessageEvent }
  | { kind: 'result'; event: ResultEvent }

const DEFAULT_ROW_HEIGHT = 120
const DEFAULT_LIST_HEIGHT = 360

export default function ClaudeSessionView({ sessionId, hidden }: ClaudeSessionViewProps) {
  const session = useAppSelector((s) => s.claude.sessions[sessionId])
  const dispatch = useAppDispatch()
  const ws = useMemo(() => getWsClient(), [])
  const listRef = useListRef()
  const listContainerRef = useRef<HTMLDivElement>(null)
  const [listHeight, setListHeight] = useState(0)

  const rows = useMemo<ClaudeRow[]>(() => {
    if (!session) return []
    const items: ClaudeRow[] = session.messages.map((event) => ({ kind: 'message', event }))
    if (session.result) {
      items.push({ kind: 'result', event: session.result })
    }
    return items
  }, [session?.messages, session?.result])

  const rowHeight = useDynamicRowHeight({ defaultRowHeight: DEFAULT_ROW_HEIGHT, key: sessionId })

  // Subscribe to WebSocket events for this session
  useEffect(() => {
    ws.connect().catch(() => {})

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

  useEffect(() => {
    const container = listContainerRef.current
    if (!container) return

    const updateHeight = () => {
      const nextHeight = container.clientHeight
      if (nextHeight > 0) {
        setListHeight(nextHeight)
      }
    }

    updateHeight()

    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => updateHeight())
    ro.observe(container)
    return () => ro.disconnect()
  }, [])

  // Auto-scroll to bottom on new events
  useEffect(() => {
    if (hidden) return
    if (rows.length === 0) return
    listRef.current?.scrollToRow({ index: rows.length - 1, align: 'end' })
  }, [rows.length, hidden, listRef])

  if (!session) return null

  const effectiveListHeight = listHeight > 0 ? listHeight : DEFAULT_LIST_HEIGHT

  const rowProps = useMemo(() => ({
    rows,
    rowHeight,
  }), [rows, rowHeight])

  const Row = ({ index, style, ariaAttributes, ...data }: RowComponentProps<typeof rowProps>) => {
    const row = data.rows[index]
    const rowRef = useRef<HTMLDivElement | null>(null)

    useEffect(() => {
      const el = rowRef.current
      if (!el) return
      return data.rowHeight.observeRowElements([el])
    }, [data.rowHeight, row])

    return (
      <div ref={rowRef} style={{ ...style, paddingBottom: 16 }} {...ariaAttributes}>
        {row.kind === 'message' ? (
          <MessageBubble event={row.event} />
        ) : (
          <div className="text-center text-sm text-muted-foreground py-4 border-t">
            <span className="bg-muted px-2 py-1 rounded">
              Completed in {(row.event.duration_ms / 1000).toFixed(1)}s
              {row.event.total_cost_usd && ` • $${row.event.total_cost_usd.toFixed(4)}`}
            </span>
          </div>
        )}
      </div>
    )
  }

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
      <div ref={listContainerRef} className="flex-1 overflow-hidden p-4">
        {rows.length === 0 && session.status === 'running' ? (
          <div className="text-center text-muted-foreground py-8">
            <div className="animate-pulse">Waiting for response...</div>
          </div>
        ) : (
          <List
            defaultHeight={effectiveListHeight}
            rowCount={rows.length}
            rowHeight={rowHeight}
            rowComponent={Row}
            rowProps={rowProps}
            listRef={listRef}
            className="overflow-y-auto"
            style={{ height: effectiveListHeight, width: '100%' }}
          />
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
