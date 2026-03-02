import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { nanoid } from 'nanoid'
import type { AgentChatPaneContent } from '@/store/paneTypes'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import { updatePaneContent } from '@/store/panesSlice'
import { addUserMessage, clearPendingCreate, removePermission, removeQuestion } from '@/store/agentChatSlice'
import { getWsClient } from '@/lib/ws-client'
import { cn } from '@/lib/utils'
import { ChevronDown } from 'lucide-react'
import MessageBubble from './MessageBubble'
import PermissionBanner from './PermissionBanner'
import QuestionBanner from './QuestionBanner'
import ChatComposer, { type ChatComposerHandle } from './ChatComposer'
import AgentChatSettings from './AgentChatSettings'
import ThinkingIndicator from './ThinkingIndicator'
import { useStreamDebounce } from './useStreamDebounce'
import CollapsedTurn from './CollapsedTurn'
import type { ChatMessage, ChatSessionState } from '@/store/agentChatTypes'
import { api, setSessionMetadata } from '@/lib/api'
import { updateSettingsLocal } from '@/store/settingsSlice'
import { getAgentChatProviderConfig } from '@/lib/agent-chat-utils'

interface AgentChatViewProps {
  tabId: string
  paneId: string
  paneContent: AgentChatPaneContent
  hidden?: boolean
}

export default function AgentChatView({ tabId, paneId, paneContent, hidden }: AgentChatViewProps) {
  const dispatch = useAppDispatch()
  const ws = getWsClient()
  const providerConfig = getAgentChatProviderConfig(paneContent.provider)
  const defaultModel = providerConfig?.defaultModel ?? 'claude-opus-4-6'
  const defaultPermissionMode = providerConfig?.defaultPermissionMode ?? 'bypassPermissions'
  const defaultEffort = providerConfig?.defaultEffort ?? 'high'
  const defaultShowThinking = providerConfig?.defaultShowThinking ?? true
  const defaultShowTools = providerConfig?.defaultShowTools ?? true
  const defaultShowTimecodes = providerConfig?.defaultShowTimecodes ?? false
  const providerLabel = providerConfig?.label ?? 'Agent Chat'
  const createSentRef = useRef(false)
  const attachSentRef = useRef(false)
  const composerRef = useRef<ChatComposerHandle>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const isAtBottomRef = useRef(true)
  const [showScrollButton, setShowScrollButton] = useState(false)
  const [hasNewMessages, setHasNewMessages] = useState(false)
  // Keep a ref to the latest paneContent to avoid stale closures in effects
  // while using only primitive deps for triggering.
  const paneContentRef = useRef(paneContent)
  paneContentRef.current = paneContent

  // Resolve pendingCreates -> pane sessionId
  const pendingSessionId = useAppSelector(
    (s) => s.agentChat.pendingCreates[paneContent.createRequestId],
  )
  const sessionId = paneContent.sessionId
  const session = useAppSelector(
    (s) => sessionId ? s.agentChat.sessions[sessionId] : undefined,
  )
  const availableModels = useAppSelector((s) => s.agentChat.availableModels)
  const settingsLoaded = useAppSelector((s) => s.settings.loaded)
  const initialSetupDone = useAppSelector((s) => s.settings.settings.agentChat?.initialSetupDone ?? false)

  // Track whether we're waiting for a session restore (persisted sessionId, history not yet loaded).
  // Fresh creates set historyLoaded=true immediately; reloads wait for sdk.history.
  // Times out after 5s to handle stale sessionIds from server restarts.
  const isRestoring = !!paneContent.sessionId && !session?.historyLoaded
  const [restoreTimedOut, setRestoreTimedOut] = useState(false)
  useEffect(() => {
    if (!isRestoring) {
      setRestoreTimedOut(false)
      return
    }
    const timer = setTimeout(() => setRestoreTimedOut(true), 5_000)
    return () => clearTimeout(timer)
  }, [isRestoring])

  // Auto-recover when restore times out (e.g. server restarted, SDK session lost).
  // Clears the stale sessionId and resets to 'creating' so a new SDK session is spawned.
  // Preserves resumeSessionId so the new session can resume the old Claude Code session.
  useEffect(() => {
    if (!restoreTimedOut || !isRestoring) return
    const newRequestId = nanoid()
    dispatch(updatePaneContent({
      tabId,
      paneId,
      content: {
        ...paneContentRef.current,
        sessionId: undefined,
        createRequestId: newRequestId,
        status: 'creating' as const,
      },
    }))
    createSentRef.current = false
    attachSentRef.current = false
  }, [restoreTimedOut, isRestoring, tabId, paneId, dispatch])

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

  // Persist cliSessionId as resumeSessionId so we can resume the Claude Code session
  // after a server restart (pane content survives in localStorage, Redux state does not).
  const cliSessionId = session?.cliSessionId
  useEffect(() => {
    if (!cliSessionId) return
    if (paneContentRef.current.resumeSessionId !== cliSessionId) {
      dispatch(updatePaneContent({
        tabId,
        paneId,
        content: { ...paneContentRef.current, resumeSessionId: cliSessionId },
      }))
    }
  }, [cliSessionId, tabId, paneId, dispatch])

  // Tag this Claude Code session as belonging to this agent-chat provider.
  // Fires once when cliSessionId first becomes available (including resumes).
  // Best-effort: errors are logged but do not block the UI.
  const taggedSessionRef = useRef<string | null>(null)
  useEffect(() => {
    if (!cliSessionId) return
    if (taggedSessionRef.current === cliSessionId) return
    taggedSessionRef.current = cliSessionId

    if (providerConfig?.codingCliProvider) {
      setSessionMetadata(
        providerConfig.codingCliProvider,
        cliSessionId,
        paneContent.provider,
      ).catch((err) => {
        console.warn('Failed to tag session metadata:', err)
      })
    }
  }, [cliSessionId, providerConfig?.codingCliProvider, paneContent.provider])

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
      model: paneContent.model ?? defaultModel,
      permissionMode: paneContent.permissionMode ?? defaultPermissionMode,
      effort: paneContent.effort ?? defaultEffort,
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
    } else if (session?.messages.length) {
      // New message arrived while scrolled up — show badge
      setHasNewMessages(true)
    }
  }, [session?.messages.length, session?.streamingActive])

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    setHasNewMessages(false)
    setShowScrollButton(false)
    isAtBottomRef.current = true
  }, [])

  const handleSend = useCallback((text: string) => {
    if (!paneContent.sessionId) return
    dispatch(addUserMessage({ sessionId: paneContent.sessionId, text }))
    ws.send({ type: 'sdk.send', sessionId: paneContent.sessionId, text })
    // Always scroll to bottom when the user sends a message
    scrollToBottom()
  }, [paneContent.sessionId, dispatch, ws, scrollToBottom])

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

  const handleQuestionAnswer = useCallback((requestId: string, answers: Record<string, string>) => {
    if (!paneContent.sessionId) return
    dispatch(removeQuestion({ sessionId: paneContent.sessionId, requestId }))
    ws.send({ type: 'sdk.question.respond', sessionId: paneContent.sessionId, requestId, answers })
  }, [paneContent.sessionId, dispatch, ws])

  const handleContainerPointerUp = useCallback((e: React.PointerEvent) => {
    // Don't steal focus from interactive elements or text selections
    const target = e.target as HTMLElement
    if (
      target.closest('button, a, input, textarea, select, details, [role="button"], pre')
    ) return
    if (window.getSelection()?.toString()) return
    composerRef.current?.focus()
  }, [])

  // When the pane resizes (e.g. split), text reflows and scrollHeight changes.
  // If the user was at the bottom, keep them at the bottom after the reflow.
  useEffect(() => {
    const el = scrollContainerRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      if (isAtBottomRef.current) {
        el.scrollTop = el.scrollHeight - el.clientHeight
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current
    if (!el) return
    const threshold = 50
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < threshold
    isAtBottomRef.current = atBottom
    setShowScrollButton(!atBottom)
    if (atBottom) setHasNewMessages(false)
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
      void api.patch('/api/settings', { agentChat: { providers: { [paneContent.provider]: defaultsPatch } } }).catch(() => {})
    }
  }, [tabId, paneId, dispatch, ws])

  const handleSettingsDismiss = useCallback(() => {
    dispatch(updatePaneContent({
      tabId,
      paneId,
      content: { ...paneContentRef.current, settingsDismissed: true },
    }))
    // Persist globally so future panes skip the settings panel.
    // Update Redux optimistically so immediately-opened panes reflect the change.
    dispatch(updateSettingsLocal({ agentChat: { initialSetupDone: true } }))
    void api.patch('/api/settings', { agentChat: { initialSetupDone: true } }).catch(() => {})
    composerRef.current?.focus()
  }, [tabId, paneId, dispatch])

  // Settings should only auto-open on the very first launch ever.
  // Once dismissed on any pane (global flag) or this pane, skip it.
  // When relying on the global initialSetupDone flag, wait for settings
  // to load to avoid a flash for returning users. Fall back to showing
  // settings if the load takes too long (e.g. API failure).
  const [settingsLoadTimedOut, setSettingsLoadTimedOut] = useState(false)
  useEffect(() => {
    if (settingsLoaded || paneContent.settingsDismissed) return
    const timer = setTimeout(() => setSettingsLoadTimedOut(true), 2_000)
    return () => clearTimeout(timer)
  }, [settingsLoaded, paneContent.settingsDismissed])

  const shouldShowSettings = !paneContent.settingsDismissed
    && !initialSetupDone
    && (settingsLoaded || settingsLoadTimedOut)

  // Auto-focus is handled by the ChatComposer's autoFocus prop below.
  // When settings are dismissed, focus imperatively via the dismiss callback.


  // Effort is locked once sdk.create has been sent (no mid-session setter in SDK).
  // Model and permission mode can be changed mid-session via sdk.set-model / sdk.set-permission-mode.
  const sessionStarted = paneContent.status !== 'creating'

  const isInteractive = paneContent.status === 'idle' || paneContent.status === 'connected'
  const isRunning = paneContent.status === 'running'
  const pendingPermissions = session ? Object.values(session.pendingPermissions) : []
  const pendingQuestions = session ? Object.values(session.pendingQuestions) : []
  const hasWaitingItems = pendingPermissions.length > 0 || pendingQuestions.length > 0

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
    <div className={cn('h-full w-full flex flex-col', hidden ? 'tab-hidden' : 'tab-visible')} role="region" aria-label={`${providerLabel} Chat`} onPointerUp={handleContainerPointerUp}>
      {/* Status bar */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b text-xs text-muted-foreground">
        <span>
          {hasWaitingItems && 'Waiting for answer...'}
          {!hasWaitingItems && paneContent.status === 'creating' && 'Creating session...'}
          {!hasWaitingItems && paneContent.status === 'starting' && 'Starting Claude Code...'}
          {!hasWaitingItems && paneContent.status === 'connected' && 'Connected'}
          {!hasWaitingItems && paneContent.status === 'running' && 'Running...'}
          {!hasWaitingItems && paneContent.status === 'idle' && 'Ready'}
          {!hasWaitingItems && paneContent.status === 'compacting' && 'Compacting context...'}
          {!hasWaitingItems && paneContent.status === 'exited' && 'Session ended'}
        </span>
        <div className="flex items-center gap-2">
          {paneContent.initialCwd && (
            <span className="truncate">{paneContent.initialCwd}</span>
          )}
          <AgentChatSettings
            model={paneContent.model ?? defaultModel}
            permissionMode={paneContent.permissionMode ?? defaultPermissionMode}
            effort={paneContent.effort ?? defaultEffort}
            showThinking={paneContent.showThinking ?? defaultShowThinking}
            showTools={paneContent.showTools ?? defaultShowTools}
            showTimecodes={paneContent.showTimecodes ?? defaultShowTimecodes}
            sessionStarted={sessionStarted}
            defaultOpen={shouldShowSettings}
            modelOptions={availableModels.length > 0 ? availableModels : undefined}
            settingsVisibility={providerConfig?.settingsVisibility}
            onChange={handleSettingsChange}
            onDismiss={handleSettingsDismiss}
          />
        </div>
      </div>

      {/* Message area wrapper (relative for scroll-to-bottom button positioning) */}
      <div className="relative flex-1 min-h-0">
      <div ref={scrollContainerRef} onScroll={handleScroll} className="h-full overflow-y-auto p-4 space-y-3" data-context="agent-chat" data-session-id={paneContent.sessionId}>
        {/* Restoring: persisted sessionId but history not yet loaded (reload/back-nav).
             Falls back to welcome screen after timeout (e.g. server restarted, session lost). */}
        {isRestoring && !restoreTimedOut && (
          <div className="text-center text-muted-foreground text-sm py-8">
            <p>Restoring session...</p>
          </div>
        )}

        {/* Welcome: no sessionId, session exists but empty, or restore timed out */}
        {!session?.messages.length && (!isRestoring || restoreTimedOut) && (
          <div className="text-center text-muted-foreground text-sm py-8">
            <p className="font-medium mb-2">{providerLabel}</p>
            <p>Rich chat UI for AI agent sessions.</p>
          </div>
        )}

        {(() => {
          let turnIndex = 0
          return renderItems.map((item, i) => {
            const isLast = i === renderItems.length - 1
            if (item.kind === 'turn') {
              const isOld = turnIndex < collapseThreshold
              turnIndex++
              if (isOld) {
                return (
                  <CollapsedTurn
                    key={`turn-${i}`}
                    userMessage={item.user}
                    assistantMessage={item.assistant}
                    showThinking={paneContent.showThinking ?? defaultShowThinking}
                    showTools={paneContent.showTools ?? defaultShowTools}
                    showTimecodes={paneContent.showTimecodes ?? defaultShowTimecodes}
                  />
                )
              }
              return (
                <React.Fragment key={`turn-${i}`}>
                  <MessageBubble
                    role={item.user.role}
                    content={item.user.content}
                    timestamp={item.user.timestamp}
                    showThinking={paneContent.showThinking ?? defaultShowThinking}
                    showTools={paneContent.showTools ?? defaultShowTools}
                    showTimecodes={paneContent.showTimecodes ?? defaultShowTimecodes}
                  />
                  <MessageBubble
                    role={item.assistant.role}
                    content={item.assistant.content}
                    timestamp={item.assistant.timestamp}
                    model={item.assistant.model}
                    isLastMessage={isLast}
                    showThinking={paneContent.showThinking ?? defaultShowThinking}
                    showTools={paneContent.showTools ?? defaultShowTools}
                    showTimecodes={paneContent.showTimecodes ?? defaultShowTimecodes}
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
                isLastMessage={isLast}
                showThinking={paneContent.showThinking ?? defaultShowThinking}
                showTools={paneContent.showTools ?? defaultShowTools}
                showTimecodes={paneContent.showTimecodes ?? defaultShowTimecodes}
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
            showThinking={paneContent.showThinking ?? defaultShowThinking}
            showTools={paneContent.showTools ?? defaultShowTools}
            showTimecodes={paneContent.showTimecodes ?? defaultShowTimecodes}
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

        {/* Question banners */}
        {pendingQuestions.map((q) => (
          <QuestionBanner
            key={q.requestId}
            question={q}
            onAnswer={(answers) => handleQuestionAnswer(q.requestId, answers)}
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

      {/* Scroll-to-bottom button */}
      {showScrollButton && (
        <button
          onClick={scrollToBottom}
          aria-label="Scroll to bottom"
          className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10 rounded-full bg-background border shadow-md p-2 hover:bg-muted transition-colors"
        >
          <ChevronDown className="h-4 w-4" />
          {hasNewMessages && (
            <span
              data-testid="new-message-badge"
              className="absolute -top-1 -right-1 h-3 w-3 rounded-full bg-blue-500"
            />
          )}
        </button>
      )}
      </div>

      {/* Composer */}
      <ChatComposer
        ref={composerRef}
        onSend={handleSend}
        onInterrupt={handleInterrupt}
        disabled={!isInteractive && !isRunning}
        isRunning={isRunning}
        autoFocus={!shouldShowSettings}
        placeholder={
          hasWaitingItems
            ? 'Waiting for answer...'
            : isInteractive
              ? `Message ${providerLabel}...`
              : 'Waiting for connection...'
        }
      />
    </div>
  )
}
