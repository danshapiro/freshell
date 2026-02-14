import React, { useCallback, useEffect, useMemo, useRef } from 'react'
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
import ThinkingIndicator from './ThinkingIndicator'
import { useStreamDebounce } from './useStreamDebounce'
import CollapsedTurn from './CollapsedTurn'
import type { ChatMessage } from '@/store/claudeChatTypes'
import { api } from '@/lib/api'

const DEFAULT_MODEL = 'claude-opus-4-6'
const DEFAULT_PERMISSION_MODE = 'bypassPermissions'
const DEFAULT_EFFORT = 'high'

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
  const availableModels = useAppSelector((s) => s.claudeChat.availableModels)

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
      effort: paneContent.effort ?? DEFAULT_EFFORT,
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

    const pc = paneContentRef.current

    // Mid-session model change
    if (changes.model && pc.sessionId && pc.status !== 'creating') {
      ws.send({ type: 'sdk.set-model', sessionId: pc.sessionId, model: changes.model as string })
    }

    // Mid-session permission mode change
    if (changes.permissionMode && pc.sessionId && pc.status !== 'creating') {
      ws.send({ type: 'sdk.set-permission-mode', sessionId: pc.sessionId, permissionMode: changes.permissionMode as string })
    }

    // Persist as defaults
    const defaultsPatch: Record<string, string> = {}
    if (changes.model) defaultsPatch.defaultModel = changes.model as string
    if (changes.permissionMode) defaultsPatch.defaultPermissionMode = changes.permissionMode as string
    if (changes.effort) defaultsPatch.defaultEffort = changes.effort as string
    if (Object.keys(defaultsPatch).length > 0) {
      void api.patch('/api/settings', { freshclaude: defaultsPatch }).catch(() => {})
    }
  }, [tabId, paneId, dispatch, ws])

  const handleSettingsDismiss = useCallback(() => {
    dispatch(updatePaneContent({
      tabId,
      paneId,
      content: { ...paneContentRef.current, settingsDismissed: true },
    }))
  }, [tabId, paneId, dispatch])

  // Effort is locked once sdk.create has been sent (no mid-session setter in SDK).
  // Model and permission mode can be changed mid-session via sdk.set-model / sdk.set-permission-mode.
  const sessionStarted = paneContent.status !== 'creating'

  const isInteractive = paneContent.status === 'idle' || paneContent.status === 'connected'
  const isRunning = paneContent.status === 'running'
  const pendingPermissions = session ? Object.values(session.pendingPermissions) : []

  // Auto-expand: count completed tools across all messages, expand the most recent N
  const RECENT_TOOLS_EXPANDED = 3
  const messages = useMemo(() => session?.messages ?? [], [session?.messages])
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

  // Debounce streaming text to limit markdown re-parsing to ~20x/sec
  const debouncedStreamingText = useStreamDebounce(
    session?.streamingText ?? '',
    session?.streamingActive ?? false,
  )

  // Memoize the content array so React.memo on MessageBubble works.
  // Without this, a new array reference is created every render, defeating memo.
  const streamingContent = useMemo(
    () => debouncedStreamingText
      ? [{ type: 'text' as const, text: debouncedStreamingText }]
      : [],
    [debouncedStreamingText],
  )

  // Build render items: pair adjacent user→assistant into turns, everything else standalone.
  const RECENT_TURNS_FULL = 3
  type RenderItem =
    | { kind: 'turn'; user: ChatMessage; assistant: ChatMessage; msgIndices: [number, number] }
    | { kind: 'standalone'; message: ChatMessage; msgIndex: number }

  const renderItems = useMemo(() => {
    const items: RenderItem[] = []
    let mi = 0
    while (mi < messages.length) {
      const msg = messages[mi]
      if (
        msg.role === 'user' &&
        mi + 1 < messages.length &&
        messages[mi + 1].role === 'assistant'
      ) {
        items.push({ kind: 'turn', user: msg, assistant: messages[mi + 1], msgIndices: [mi, mi + 1] })
        mi += 2
      } else {
        items.push({ kind: 'standalone', message: msg, msgIndex: mi })
        mi++
      }
    }
    return items
  }, [messages])

  const turnItems = renderItems.filter(r => r.kind === 'turn')
  const collapseThreshold = Math.max(0, turnItems.length - RECENT_TURNS_FULL)

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
            effort={paneContent.effort ?? DEFAULT_EFFORT}
            showThinking={paneContent.showThinking ?? true}
            showTools={paneContent.showTools ?? true}
            showTimecodes={paneContent.showTimecodes ?? false}
            sessionStarted={sessionStarted}
            defaultOpen={!paneContent.settingsDismissed}
            modelOptions={availableModels.length > 0 ? availableModels : undefined}
            onChange={handleSettingsChange}
            onDismiss={handleSettingsDismiss}
          />
        </div>
      </div>

      {/* Message area */}
      <div ref={scrollContainerRef} onScroll={handleScroll} className="flex-1 overflow-y-auto p-4 space-y-3" data-context="freshclaude-chat" data-session-id={paneContent.sessionId}>
        {!session?.messages.length && (
          <div className="text-center text-muted-foreground text-sm py-8">
            <p className="font-medium mb-2">freshclaude</p>
            <p>Rich chat UI for Claude Code sessions.</p>
            <p className="text-xs mt-2">Session: {paneContent.sessionId ?? 'pending'}</p>
          </div>
        )}

        {(() => {
          let turnIndex = 0
          return renderItems.map((item, i) => {
            if (item.kind === 'turn') {
              const isOld = turnIndex < collapseThreshold
              turnIndex++
              if (isOld) {
                return (
                  <CollapsedTurn
                    key={`turn-${i}`}
                    userMessage={item.user}
                    assistantMessage={item.assistant}
                    showThinking={paneContent.showThinking ?? true}
                    showTools={paneContent.showTools ?? true}
                    showTimecodes={paneContent.showTimecodes ?? false}
                  />
                )
              }
              return (
                <React.Fragment key={`turn-${i}`}>
                  <MessageBubble
                    role={item.user.role}
                    content={item.user.content}
                    timestamp={item.user.timestamp}
                    showThinking={paneContent.showThinking ?? true}
                    showTools={paneContent.showTools ?? true}
                    showTimecodes={paneContent.showTimecodes ?? false}
                  />
                  <MessageBubble
                    role={item.assistant.role}
                    content={item.assistant.content}
                    timestamp={item.assistant.timestamp}
                    model={item.assistant.model}
                    showThinking={paneContent.showThinking ?? true}
                    showTools={paneContent.showTools ?? true}
                    showTimecodes={paneContent.showTimecodes ?? false}
                    completedToolOffset={completedToolOffsets[item.msgIndices[1]]}
                    autoExpandAbove={autoExpandAbove}
                  />
                </React.Fragment>
              )
            }
            // Standalone messages
            return (
              <MessageBubble
                key={`msg-${i}`}
                role={item.message.role}
                content={item.message.content}
                timestamp={item.message.timestamp}
                model={item.message.model}
                showThinking={paneContent.showThinking ?? true}
                showTools={paneContent.showTools ?? true}
                showTimecodes={paneContent.showTimecodes ?? false}
                completedToolOffset={completedToolOffsets[item.msgIndex]}
                autoExpandAbove={autoExpandAbove}
              />
            )
          })
        })()}

        {session?.streamingActive && streamingContent.length > 0 && (
          <MessageBubble
            role="assistant"
            content={streamingContent}
            showThinking={paneContent.showThinking ?? true}
            showTools={paneContent.showTools ?? true}
            showTimecodes={paneContent.showTimecodes ?? false}
          />
        )}

        {/* Thinking indicator — shown when running but no response content yet.
            Three guards prevent false positives:
            1. status === 'running' — Claude is actively processing
            2. !streamingActive — no text currently streaming
            3. lastMessage.role === 'user' — no assistant content committed yet
            The component self-debounces with a 200ms render delay to prevent
            flash during brief SDK gaps (content_block_stop → sdk.assistant). */}
        {session?.status === 'running' &&
          !session.streamingActive &&
          messages.length > 0 &&
          messages[messages.length - 1].role === 'user' && (
          <ThinkingIndicator />
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
