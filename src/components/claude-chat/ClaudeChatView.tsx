import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { ClaudeChatPaneContent } from '@/store/paneTypes'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import { updatePaneContent } from '@/store/panesSlice'
import { addUserMessage, clearPendingCreate, removePermission } from '@/store/claudeChatSlice'
import { getWsClient } from '@/lib/ws-client'
import { cn } from '@/lib/utils'
import MessageBubble from './MessageBubble'
import PermissionBanner from './PermissionBanner'
import ChatComposer from './ChatComposer'
import FreshclaudeSettings from './FreshclaudeSettings'

const DEFAULT_MODEL = 'claude-opus-4-6'
const DEFAULT_PERMISSION_MODE = 'bypassPermissions'

interface ClaudeChatViewProps {
  tabId: string
  paneId: string
  paneContent: ClaudeChatPaneContent
  hidden?: boolean
}

export default function ClaudeChatView({ tabId, paneId, paneContent, hidden }: ClaudeChatViewProps) {
  const dispatch = useAppDispatch()
  const ws = getWsClient()
  const createSentRef = useRef(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const isAtBottomRef = useRef(true)
  // Keep a ref to the latest paneContent to avoid stale closures in effects
  // while using only primitive deps for triggering.
  const paneContentRef = useRef(paneContent)
  paneContentRef.current = paneContent

  // Resolve pendingCreates -> pane sessionId
  const pendingSessionId = useAppSelector(
    (s) => s.claudeChat.pendingCreates[paneContent.createRequestId],
  )
  const session = useAppSelector(
    (s) => paneContent.sessionId ? s.claudeChat.sessions[paneContent.sessionId] : undefined,
  )

  // Wire sessionId from pendingCreates back into the pane content
  useEffect(() => {
    if (paneContent.sessionId || !pendingSessionId) return
    dispatch(updatePaneContent({
      tabId,
      paneId,
      content: { ...paneContentRef.current, sessionId: pendingSessionId, status: 'starting' },
    }))
    dispatch(clearPendingCreate({ requestId: paneContent.createRequestId }))
  }, [pendingSessionId, paneContent.sessionId, paneContent.createRequestId, tabId, paneId, dispatch])

  // Update pane status from session state
  const sessionStatus = session?.status
  useEffect(() => {
    if (!sessionStatus || sessionStatus === paneContent.status) return
    dispatch(updatePaneContent({
      tabId,
      paneId,
      content: { ...paneContentRef.current, status: sessionStatus },
    }))
  }, [sessionStatus, paneContent.status, tabId, paneId, dispatch])

  // Reset createSentRef when createRequestId changes
  const prevCreateRequestIdRef = useRef(paneContent.createRequestId)
  if (prevCreateRequestIdRef.current !== paneContent.createRequestId) {
    prevCreateRequestIdRef.current = paneContent.createRequestId
    createSentRef.current = false
  }

  // Send sdk.create when the pane first mounts with a createRequestId but no sessionId
  useEffect(() => {
    if (paneContent.sessionId || createSentRef.current) return
    if (paneContent.status !== 'creating') return

    createSentRef.current = true
    ws.send({
      type: 'sdk.create',
      requestId: paneContent.createRequestId,
      model: paneContent.model ?? DEFAULT_MODEL,
      permissionMode: paneContent.permissionMode ?? DEFAULT_PERMISSION_MODE,
      ...(paneContent.initialCwd ? { cwd: paneContent.initialCwd } : {}),
      ...(paneContent.resumeSessionId ? { resumeSessionId: paneContent.resumeSessionId } : {}),
    })

    // Update status to 'starting'
    dispatch(updatePaneContent({
      tabId,
      paneId,
      content: { ...paneContent, status: 'starting' },
    }))
  }, [paneContent.createRequestId, paneContent.sessionId, paneContent.status, tabId, paneId, dispatch, ws])

  // Attach to existing session on mount (e.g. after page refresh with persisted pane)
  const attachSentRef = useRef(false)
  useEffect(() => {
    if (!paneContent.sessionId || attachSentRef.current) return
    // Only attach if we didn't just create this session ourselves
    if (createSentRef.current) return

    attachSentRef.current = true
    ws.send({ type: 'sdk.attach', sessionId: paneContent.sessionId })
  }, [paneContent.sessionId, ws])

  // Re-attach on WS reconnect so server re-subscribes this client
  useEffect(() => {
    if (!paneContent.sessionId) return
    return ws.onReconnect(() => {
      ws.send({ type: 'sdk.attach', sessionId: paneContent.sessionId! })
    })
  }, [paneContent.sessionId, ws])

  // Smart auto-scroll: only scroll if user is already at/near the bottom
  useEffect(() => {
    if (isAtBottomRef.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [session?.messages.length, session?.streamingActive])

  const handleSend = useCallback((text: string) => {
    if (!paneContent.sessionId) return
    dispatch(addUserMessage({ sessionId: paneContent.sessionId, text }))
    ws.send({ type: 'sdk.send', sessionId: paneContent.sessionId, text })
  }, [paneContent.sessionId, dispatch, ws])

  const handleInterrupt = useCallback(() => {
    if (!paneContent.sessionId) return
    ws.send({ type: 'sdk.interrupt', sessionId: paneContent.sessionId })
  }, [paneContent.sessionId, ws])

  const handlePermissionAllow = useCallback((requestId: string) => {
    if (!paneContent.sessionId) return
    dispatch(removePermission({ sessionId: paneContent.sessionId, requestId }))
    ws.send({ type: 'sdk.permission.respond', sessionId: paneContent.sessionId, requestId, behavior: 'allow' })
  }, [paneContent.sessionId, dispatch, ws])

  const handlePermissionDeny = useCallback((requestId: string) => {
    if (!paneContent.sessionId) return
    dispatch(removePermission({ sessionId: paneContent.sessionId, requestId }))
    ws.send({ type: 'sdk.permission.respond', sessionId: paneContent.sessionId, requestId, behavior: 'deny' })
  }, [paneContent.sessionId, dispatch, ws])

  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current
    if (!el) return
    const threshold = 50
    isAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < threshold
  }, [])

  const handleSettingsChange = useCallback((changes: Record<string, unknown>) => {
    dispatch(updatePaneContent({
      tabId,
      paneId,
      content: { ...paneContentRef.current, ...changes },
    }))
  }, [tabId, paneId, dispatch])

  const handleSettingsDismiss = useCallback(() => {
    dispatch(updatePaneContent({
      tabId,
      paneId,
      content: { ...paneContentRef.current, settingsDismissed: true },
    }))
  }, [tabId, paneId, dispatch])

  // Controls (model, permissions) should be locked once sdk.create has been sent.
  // The pane status transitions from 'creating' to 'starting' immediately after sdk.create,
  // so any status other than 'creating' means the session is already configured.
  const sessionStarted = paneContent.status !== 'creating'

  const isInteractive = paneContent.status === 'idle' || paneContent.status === 'connected'
  const isRunning = paneContent.status === 'running'
  const pendingPermissions = session ? Object.values(session.pendingPermissions) : []

  // Auto-expand: count completed tools across all messages, expand the most recent N
  const RECENT_TOOLS_EXPANDED = 3
  const messages = session?.messages ?? []
  const { completedToolOffsets, autoExpandAbove } = useMemo(() => {
    let totalCompletedTools = 0
    const offsets: number[] = []
    for (const msg of messages) {
      offsets.push(totalCompletedTools)
      for (const b of msg.content) {
        if (b.type === 'tool_use' && b.id) {
          const hasResult = msg.content.some(
            r => r.type === 'tool_result' && r.tool_use_id === b.id
          )
          if (hasResult) totalCompletedTools++
        }
      }
    }
    return {
      completedToolOffsets: offsets,
      autoExpandAbove: Math.max(0, totalCompletedTools - RECENT_TOOLS_EXPANDED),
    }
  }, [messages])

  return (
    <div className={cn('h-full w-full flex flex-col', hidden ? 'tab-hidden' : 'tab-visible')} role="region" aria-label="freshclaude Chat">
      {/* Status bar */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b text-xs text-muted-foreground">
        <span>
          {pendingPermissions.length > 0 && 'Waiting for answer...'}
          {pendingPermissions.length === 0 && paneContent.status === 'creating' && 'Creating session...'}
          {pendingPermissions.length === 0 && paneContent.status === 'starting' && 'Starting Claude Code...'}
          {pendingPermissions.length === 0 && paneContent.status === 'connected' && 'Connected'}
          {pendingPermissions.length === 0 && paneContent.status === 'running' && 'Running...'}
          {pendingPermissions.length === 0 && paneContent.status === 'idle' && 'Ready'}
          {pendingPermissions.length === 0 && paneContent.status === 'compacting' && 'Compacting context...'}
          {pendingPermissions.length === 0 && paneContent.status === 'exited' && 'Session ended'}
        </span>
        <div className="flex items-center gap-2">
          {paneContent.initialCwd && (
            <span className="truncate">{paneContent.initialCwd}</span>
          )}
          <FreshclaudeSettings
            model={paneContent.model ?? DEFAULT_MODEL}
            permissionMode={paneContent.permissionMode ?? DEFAULT_PERMISSION_MODE}
            showThinking={paneContent.showThinking ?? true}
            showTools={paneContent.showTools ?? true}
            showTimecodes={paneContent.showTimecodes ?? false}
            sessionStarted={sessionStarted}
            defaultOpen={!paneContent.settingsDismissed}
            onChange={handleSettingsChange}
            onDismiss={handleSettingsDismiss}
          />
        </div>
      </div>

      {/* Message area */}
      <div ref={scrollContainerRef} onScroll={handleScroll} className="flex-1 overflow-y-auto p-4 space-y-3">
        {!session?.messages.length && (
          <div className="text-center text-muted-foreground text-sm py-8">
            <p className="font-medium mb-2">freshclaude</p>
            <p>Rich chat UI for Claude Code sessions.</p>
            <p className="text-xs mt-2">Session: {paneContent.sessionId ?? 'pending'}</p>
          </div>
        )}

        {messages.map((msg, i) => (
          <MessageBubble
            key={i}
            role={msg.role}
            content={msg.content}
            timestamp={msg.timestamp}
            model={msg.model}
            showThinking={paneContent.showThinking ?? true}
            showTools={paneContent.showTools ?? true}
            showTimecodes={paneContent.showTimecodes ?? false}
            completedToolOffset={completedToolOffsets[i]}
            autoExpandAbove={autoExpandAbove}
          />
        ))}

        {session?.streamingActive && session.streamingText && (
          <MessageBubble
            role="assistant"
            content={[{ type: 'text', text: session.streamingText }]}
            showThinking={paneContent.showThinking ?? true}
            showTools={paneContent.showTools ?? true}
            showTimecodes={paneContent.showTimecodes ?? false}
          />
        )}

        {/* Permission banners */}
        {pendingPermissions.map((perm) => (
          <PermissionBanner
            key={perm.requestId}
            permission={perm}
            onAllow={() => handlePermissionAllow(perm.requestId)}
            onDeny={() => handlePermissionDeny(perm.requestId)}
          />
        ))}

        {/* Error display */}
        {session?.lastError && (
          <div className="text-sm text-red-500 bg-red-500/10 rounded-lg p-3" role="alert">
            {session.lastError}
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Composer */}
      <ChatComposer
        onSend={handleSend}
        onInterrupt={handleInterrupt}
        disabled={!isInteractive && !isRunning}
        isRunning={isRunning}
        placeholder={
          pendingPermissions.length > 0
            ? 'Waiting for answer...'
            : isInteractive
              ? 'Message Claude...'
              : 'Waiting for connection...'
        }
      />
    </div>
  )
}
