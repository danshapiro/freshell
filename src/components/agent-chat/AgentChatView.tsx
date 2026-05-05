import React, { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { nanoid } from 'nanoid'
import type { AgentChatPaneContent } from '@/store/paneTypes'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import { updatePaneContent, mergePaneContent, restartAgentChatCreate, updatePaneTitle } from '@/store/panesSlice'
import { updateTab } from '@/store/tabsSlice'
import {
  addUserMessage,
  clearPendingCreate,
  clearPendingCreateFailure,
  registerPendingCreate,
  removePermission,
  removeQuestion,
} from '@/store/agentChatSlice'
import {
  fetchAgentChatCapabilities,
  loadAgentTimelineWindow,
  loadAgentTurnBody,
  refreshAgentChatCapabilities,
} from '@/store/agentChatThunks'
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
import type { ChatMessage } from '@/store/agentChatTypes'
import {
  getAgentChatSettingsModelOptions,
  getAgentChatSettingsModelValue,
  getAgentChatSupportedEffortLevels,
  isAgentChatCapabilitiesFresh,
  isAgentChatEffortSupported,
  parseAgentChatSettingsModelValue,
  requiresAgentChatCapabilityValidation,
  resolveAgentChatModelSelection,
} from '@/lib/agent-chat-capabilities'
import { setSessionMetadata } from '@/lib/api'
import { getAgentChatProviderConfig } from '@/lib/agent-chat-utils'
import { isValidClaudeSessionId } from '@/lib/claude-session-id'
import { extractTitleFromMessage } from '@shared/title-utils'
import { getInstalledPerfAuditBridge } from '@/lib/perf-audit-bridge'
import { saveServerSettingsPatch } from '@/store/settingsThunks'
import { updateSettingsLocal } from '@/store/settingsSlice'
import type { Tab } from '@/store/types'
import {
  buildAgentChatPersistedIdentityUpdate,
  flushPersistedLayoutNow,
  getCanonicalDurableSessionId,
  getPreferredResumeSessionId,
} from '@/store/persistControl'
import { useMobile } from '@/hooks/useMobile'
import { useKeyboardInset } from '@/hooks/useKeyboardInset'

/** Early lifecycle states that should not be re-entered once the session has advanced. */
const EARLY_STATES = new Set(['creating', 'starting'])

/**
 * Returns true if transitioning from `current` to `next` would be a regression.
 * Only blocks regression back to early states (creating/starting) — normal cycles
 * like running→idle are allowed since they happen after every turn.
 */
function isStatusRegression(current: string, next: string): boolean {
  return !EARLY_STATES.has(current) && EARLY_STATES.has(next)
}

function modelSelectionsMatch(
  left: AgentChatPaneContent['modelSelection'],
  right: AgentChatPaneContent['modelSelection'],
): boolean {
  if (!left && !right) return true
  if (!left || !right) return false
  return left.kind === right.kind && left.modelId === right.modelId
}

function paneMatchesCurrentProviderDefaults(
  pane: Pick<AgentChatPaneContent, 'modelSelection' | 'effort'>,
  providerDefaults?: Pick<AgentChatPaneContent, 'modelSelection' | 'effort'>,
): boolean {
  return modelSelectionsMatch(pane.modelSelection, providerDefaults?.modelSelection)
    && pane.effort === providerDefaults?.effort
}

interface AgentChatViewProps {
  tabId: string
  paneId: string
  paneContent: AgentChatPaneContent
  hidden?: boolean
}

export default function AgentChatView({ tabId, paneId, paneContent, hidden }: AgentChatViewProps) {
  const dispatch = useAppDispatch()
  const ws = useMemo(() => getWsClient(), [])
  const isMobile = useMobile()
  const keyboardInsetPx = useKeyboardInset()
  const providerConfig = getAgentChatProviderConfig(paneContent.provider)
  const providerDefaultModelId = providerConfig?.providerDefaultModelId ?? 'opus'
  const defaultPermissionMode = providerConfig?.defaultPermissionMode ?? 'bypassPermissions'
  const localSettings = useAppSelector((state) => state.settings.settings)
  const providerSettings = localSettings.agentChat?.providers?.[paneContent.provider]
  const defaultShowThinking = localSettings.agentChat.showThinking
  const defaultShowTools = localSettings.agentChat.showTools
  const defaultShowTimecodes = localSettings.agentChat.showTimecodes
  const providerLabel = providerConfig?.label ?? 'Agent Chat'
  const createSentRef = useRef(false)
  const attachSentRef = useRef(false)
  const staleRetryAttachKeyRef = useRef<string | null>(null)
  const snapshotRefreshAttachKeyRef = useRef<string | null>(null)
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
    (s) => s.agentChat.pendingCreates[paneContent.createRequestId]?.sessionId,
  )
  const pendingCreateFailure = useAppSelector(
    (s) => s.agentChat.pendingCreateFailures[paneContent.createRequestId],
  )
  const sessionId = paneContent.sessionId
  const session = useAppSelector(
    (s) => sessionId ? s.agentChat.sessions[sessionId] : undefined,
  )
  const currentTab = useAppSelector((s) => (
    (s as { tabs?: { tabs?: Tab[] } }).tabs?.tabs?.find((entry) => entry.id === tabId)
  ))
  const tabTitleSetByUser = currentTab?.titleSetByUser ?? false
  const providerCapabilitiesState = useAppSelector(
    (s) => s.agentChat.capabilitiesByProvider?.[paneContent.provider],
  )
  const providerCapabilities = providerCapabilitiesState?.capabilities
  const providerCapabilitiesRef = useRef(providerCapabilities)
  providerCapabilitiesRef.current = providerCapabilities
  const resolvedModelSelection = useMemo(
    () => resolveAgentChatModelSelection({
      providerDefaultModelId,
      capabilities: providerCapabilities,
      modelSelection: paneContent.modelSelection,
    }),
    [paneContent.modelSelection, providerCapabilities, providerDefaultModelId],
  )
  const settingsModelOptions = useMemo(
    () => getAgentChatSettingsModelOptions({
      providerDefaultModelId,
      capabilities: providerCapabilities,
      modelSelection: paneContent.modelSelection,
    }),
    [paneContent.modelSelection, providerCapabilities, providerDefaultModelId],
  )
  const settingsModelValue = getAgentChatSettingsModelValue(
    paneContent.modelSelection,
    providerCapabilities,
  )
  const effortOptions = useMemo(
    () => getAgentChatSupportedEffortLevels({
      providerDefaultModelId,
      capabilities: providerCapabilities,
      modelSelection: paneContent.modelSelection,
    }),
    [paneContent.modelSelection, providerCapabilities, providerDefaultModelId],
  )
  const settingsLoaded = useAppSelector((s) => s.settings.loaded)
  const initialSetupDone = useAppSelector((s) => s.settings.settings.agentChat?.initialSetupDone ?? false)
  const activePaneId = useAppSelector((s) => s.panes.activePane[tabId])
  const surfaceVisibleMarkedRef = useRef(false)
  const sessionRef = useRef(session)
  sessionRef.current = session
  const persistedTimelineSessionId = isValidClaudeSessionId(paneContent.resumeSessionId)
    ? paneContent.resumeSessionId
    : undefined
  const canonicalDurableSessionId = getCanonicalDurableSessionId(session) ?? persistedTimelineSessionId
  const timelineSessionId = getPreferredResumeSessionId(session) ?? persistedTimelineSessionId
  const restoreHistoryQueryId = timelineSessionId ?? paneContent.sessionId
  const attachResumeSessionId = getPreferredResumeSessionId(session)
    ?? (
      typeof paneContent.resumeSessionId === 'string' && paneContent.resumeSessionId.trim().length > 0
        ? paneContent.resumeSessionId
        : undefined
    )
  const attachPayload = useMemo(() => {
    if (!paneContent.sessionId) return null
    return {
      type: 'sdk.attach' as const,
      sessionId: paneContent.sessionId,
      ...(attachResumeSessionId ? { resumeSessionId: attachResumeSessionId } : {}),
    }
  }, [attachResumeSessionId, paneContent.sessionId])
  const waitingForDurableHistoryIdentity = Boolean(
    session?.awaitingDurableHistory
      && session.latestTurnId === null
      && !canonicalDurableSessionId,
  )
  // Playwright can opt a pane into state-only mode so chrome activity tests
  // don't race the live SDK attach/create lifecycle.
  const suppressNetworkEffects = typeof window !== 'undefined'
    && window.__FRESHELL_TEST_HARNESS__?.isAgentChatNetworkEffectsSuppressed?.(paneId) === true

  const clearPersistedProviderEffortIfPaneMatchesDefaults = useCallback((
    pane: Pick<AgentChatPaneContent, 'modelSelection' | 'effort'>,
  ) => {
    if (!paneMatchesCurrentProviderDefaults(pane, providerSettings)) {
      return
    }

    void dispatch(saveServerSettingsPatch({
      agentChat: {
        providers: {
          [paneContent.provider]: {
            effort: undefined,
          },
        },
      },
    }))
  }, [dispatch, paneContent.provider, providerSettings])

  // Track whether we're waiting for a session restore (persisted sessionId, history not yet loaded).
  // Fresh creates set historyLoaded=true immediately; reloads wait for the initial
  // HTTP timeline window (even if it is empty).
  const hasRestoreFailure = Boolean(
    paneContent.sessionId
      && session?.historyLoaded
      && session?.restoreFailureCode
      && session?.restoreFailureMessage,
  )
  const isRestoring = !!paneContent.sessionId && !session?.historyLoaded && !hasRestoreFailure

  // Shared recovery logic: clears stale sessionId and resets to 'creating' so a new
  // SDK session is spawned. Preserves resumeSessionId for CLI session continuity.
  const triggerRecovery = useCallback(() => {
    const newRequestId = nanoid()
    const resumeSessionId = getPreferredResumeSessionId(sessionRef.current)
      ?? paneContentRef.current.resumeSessionId
    dispatch(updatePaneContent({
      tabId,
      paneId,
      content: {
        ...paneContentRef.current,
        sessionId: undefined,
        resumeSessionId,
        createRequestId: newRequestId,
        status: 'creating' as const,
      },
    }))
    createSentRef.current = false
    attachSentRef.current = false
  }, [tabId, paneId, dispatch])

  // Recover once the server confirms the session is gone. If a pinned restore
  // snapshot is still waiting on its first timeline window, let that hydrate
  // first so the rebuilt transcript can render before the pane detaches.
  const sessionLost = !!session?.lost
  const waitingForInitialRestoreWindow = (
    sessionLost
    && session?.latestTurnId !== undefined
    && session?.historyLoaded === false
  )
  const shouldDeferLostRecoveryUntilAfterRestoreRender = (
    sessionLost
    && session?.latestTurnId !== undefined
    && session?.historyLoaded === true
  )
  useEffect(() => {
    if (suppressNetworkEffects) return
    if (!sessionLost || !paneContent.sessionId) return
    if (waitingForInitialRestoreWindow) return
    if (shouldDeferLostRecoveryUntilAfterRestoreRender) {
      const sessionIdForRecovery = paneContent.sessionId
      const timeoutId = window.setTimeout(() => {
        if (paneContentRef.current.sessionId !== sessionIdForRecovery) return
        if (!sessionRef.current?.lost) return
        triggerRecovery()
      }, 0)
      return () => {
        clearTimeout(timeoutId)
      }
    }
    triggerRecovery()
  }, [
    shouldDeferLostRecoveryUntilAfterRestoreRender,
    sessionLost,
    paneContent.sessionId,
    suppressNetworkEffects,
    triggerRecovery,
    waitingForInitialRestoreWindow,
  ])

  useEffect(() => {
    if (suppressNetworkEffects) return
    if (!paneContent.sessionId) {
      staleRetryAttachKeyRef.current = null
      return
    }
    if (session?.restoreFailureCode !== 'RESTORE_STALE_REVISION') {
      staleRetryAttachKeyRef.current = null
      return
    }
    if ((session.restoreRetryCount ?? 0) !== 1) {
      staleRetryAttachKeyRef.current = null
      return
    }
    const retryKey = `${paneContent.sessionId}:${session.restoreRetryCount}:${attachPayload?.resumeSessionId ?? ''}`
    if (staleRetryAttachKeyRef.current === retryKey) return
    staleRetryAttachKeyRef.current = retryKey
    if (attachPayload) {
      ws.send(attachPayload)
    }
  }, [
    attachPayload,
    paneContent.sessionId,
    session?.restoreFailureCode,
    session?.restoreRetryCount,
    suppressNetworkEffects,
    ws,
  ])

  useEffect(() => {
    if (suppressNetworkEffects) return
    if (!paneContent.sessionId) {
      snapshotRefreshAttachKeyRef.current = null
      return
    }
    const snapshotRefreshRequestId = session?.snapshotRefreshRequestId
    if (!snapshotRefreshRequestId) {
      snapshotRefreshAttachKeyRef.current = null
      return
    }
    const refreshKey = `${paneContent.sessionId}:${snapshotRefreshRequestId}:${attachPayload?.resumeSessionId ?? ''}`
    if (snapshotRefreshAttachKeyRef.current === refreshKey) return
    snapshotRefreshAttachKeyRef.current = refreshKey
    if (attachPayload) {
      ws.send(attachPayload)
    }
  }, [
    attachPayload,
    paneContent.sessionId,
    session?.snapshotRefreshRequestId,
    suppressNetworkEffects,
    ws,
  ])

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

  useEffect(() => {
    if (!pendingCreateFailure || paneContent.sessionId) return
    dispatch(mergePaneContent({
      tabId,
      paneId,
      updates: {
        sessionId: undefined,
        status: 'create-failed',
        createError: pendingCreateFailure,
      } as Partial<AgentChatPaneContent>,
    }))
    dispatch(clearPendingCreateFailure({ requestId: paneContent.createRequestId }))
    dispatch(clearPendingCreate({ requestId: paneContent.createRequestId }))
    createSentRef.current = false
    attachSentRef.current = false
  }, [pendingCreateFailure, paneContent.sessionId, paneContent.createRequestId, tabId, paneId, dispatch])

  // Update pane status from session state.
  // Uses mergePaneContent (not updatePaneContent) to avoid stale-ref overwrites when
  // multiple effects dispatch in the same render batch (e.g. sessionStatus + cliSessionId).
  // Only syncs forward — never regresses from a more advanced status (e.g. connected→starting)
  // because cross-tab sync or sdk.attach responses can report stale server-side status.
  const sessionStatus = session?.status
  useEffect(() => {
    if (!sessionStatus || sessionStatus === paneContent.status) return
    // Don't sync status from a lost session — the recovery effect will clear the
    // sessionId and start fresh. Syncing here would overwrite the recovery with stale data.
    if (session?.lost) return
    // Don't regress to a less advanced status. The server may report 'starting' on
    // sdk.attach even though the client already received the preliminary sdk.session.init
    // and optimistically advanced to 'connected'. This prevents the status bar from
    // flipping back to "Starting Claude Code..." after splits or cross-tab sync.
    if (isStatusRegression(paneContent.status, sessionStatus)) return
    dispatch(mergePaneContent({
      tabId,
      paneId,
      updates: { status: sessionStatus },
    }))
  }, [sessionStatus, paneContent.status, session?.lost, tabId, paneId, dispatch])

  // Persist the canonical durable Claude ID as soon as the server knows it so later
  // reload/recovery paths do not depend on sdk.session.init arriving first.
  useEffect(() => {
    const metadataProvider = providerConfig?.codingCliProvider
      ?? currentTab?.codingCliProvider
      ?? (currentTab?.mode !== 'shell' ? currentTab?.mode : undefined)
    const identityUpdate = buildAgentChatPersistedIdentityUpdate({
      session,
      paneContent: paneContentRef.current,
      currentTab,
      metadataProvider,
    })
    if (!identityUpdate) return

    if (identityUpdate.paneUpdates) {
      dispatch(mergePaneContent({
        tabId,
        paneId,
        updates: identityUpdate.paneUpdates,
      }))
    }

    if (currentTab && identityUpdate.tabUpdates) {
      dispatch(updateTab({
        id: currentTab.id,
        updates: identityUpdate.tabUpdates,
      }))
    }

    if (identityUpdate.shouldFlush) {
      dispatch(flushPersistedLayoutNow())
    }
  }, [currentTab, dispatch, paneId, providerConfig?.codingCliProvider, session, tabId])

  // Tag this Claude Code session as belonging to this agent-chat provider.
  // Fires once when cliSessionId first becomes available (including resumes).
  // Best-effort: errors are logged but do not block the UI.
  const taggedSessionRef = useRef<string | null>(null)
  useEffect(() => {
    if (suppressNetworkEffects) return
    const preferredResumeSessionId = getPreferredResumeSessionId(session)
    if (!preferredResumeSessionId) return
    if (taggedSessionRef.current === preferredResumeSessionId) return
    taggedSessionRef.current = preferredResumeSessionId

    if (providerConfig?.codingCliProvider) {
      setSessionMetadata(
        providerConfig.codingCliProvider,
        preferredResumeSessionId,
        paneContent.provider,
      ).catch((err) => {
        console.warn('Failed to tag session metadata:', err)
      })
    }
  }, [paneContent.provider, providerConfig?.codingCliProvider, session?.cliSessionId, session?.timelineSessionId, suppressNetworkEffects])

  // Reset createSentRef when createRequestId changes
  const prevCreateRequestIdRef = useRef(paneContent.createRequestId)
  if (prevCreateRequestIdRef.current !== paneContent.createRequestId) {
    prevCreateRequestIdRef.current = paneContent.createRequestId
    createSentRef.current = false
  }

  // Send sdk.create when the pane first mounts with a createRequestId but no sessionId
  useEffect(() => {
    if (suppressNetworkEffects) return
    if (paneContent.sessionId || createSentRef.current) return
    if (paneContent.status !== 'creating') return

    const requestId = paneContent.createRequestId
    createSentRef.current = true
    let cancelled = false

    const failCreate = (error: AgentChatPaneContent['createError']) => {
      if (cancelled) return
      createSentRef.current = false
      attachSentRef.current = false
      dispatch(updatePaneContent({
        tabId,
        paneId,
        content: {
          ...paneContentRef.current,
          status: 'create-failed',
          createError: error,
        },
      }))
    }

    void (async () => {
      let capabilities = providerCapabilitiesRef.current

      if (requiresAgentChatCapabilityValidation({
        modelSelection: paneContent.modelSelection,
        effort: paneContent.effort,
      }) && !isAgentChatCapabilitiesFresh(capabilities)) {
        const response = await dispatch(fetchAgentChatCapabilities(paneContent.provider))
        if (cancelled) return
        if (!response.ok) {
          failCreate(response.error)
          return
        }
        capabilities = response.capabilities
      }

      if (cancelled) return

      const currentPane = paneContentRef.current
      if (
        currentPane.createRequestId !== requestId
        || currentPane.sessionId
        || currentPane.status !== 'creating'
      ) {
        return
      }

      // Create-time resume accepts either the canonical durable Claude id or a
      // live/named resume token. We persist only canonical ids for reload/attach
      // flows, but named resumes still need to launch a restoring session that can
      // later upgrade in place once the canonical timeline id is known.
      const createResumeSessionId = (
        currentPane.sessionRef?.provider === 'claude'
        && isValidClaudeSessionId(currentPane.sessionRef.sessionId)
      )
        ? currentPane.sessionRef.sessionId
        : (typeof currentPane.resumeSessionId === 'string' && currentPane.resumeSessionId.trim().length > 0
          ? currentPane.resumeSessionId
          : undefined)
      const resolvedSelection = resolveAgentChatModelSelection({
        providerDefaultModelId,
        capabilities,
        modelSelection: currentPane.modelSelection,
      })

      if (!resolvedSelection.resolvedModelId) {
        const unavailableModelId =
          resolvedSelection.unavailableExactSelection?.modelId
          ?? currentPane.modelSelection?.modelId
          ?? 'the selected model'
        failCreate({
          code: 'MODEL_UNAVAILABLE',
          message: `Selected model ${unavailableModelId} is no longer available.`,
          retryable: false,
        })
        return
      }

      let resolvedEffort = currentPane.effort
      let shouldClearPersistedProviderEffort = false
      if (resolvedEffort) {
        if (!resolvedSelection.capability) {
          failCreate({
            code: 'CAPABILITY_VALIDATION_REQUIRED',
            message: 'Could not validate the selected effort for this model.',
            retryable: true,
          })
          return
        }

        if (!isAgentChatEffortSupported(resolvedSelection.capability, resolvedEffort)) {
          resolvedEffort = undefined
          shouldClearPersistedProviderEffort = paneMatchesCurrentProviderDefaults(
            currentPane,
            providerSettings,
          )
        }
      }

      dispatch(registerPendingCreate({
        requestId,
        expectsHistoryHydration: Boolean(createResumeSessionId),
      }))
      ws.send({
        type: 'sdk.create',
        requestId,
        model: resolvedSelection.resolvedModelId,
        permissionMode: currentPane.permissionMode ?? defaultPermissionMode,
        ...(resolvedEffort ? { effort: resolvedEffort } : {}),
        ...(currentPane.initialCwd ? { cwd: currentPane.initialCwd } : {}),
        ...(createResumeSessionId ? { resumeSessionId: createResumeSessionId } : {}),
        ...(currentPane.plugins ? { plugins: currentPane.plugins } : {}),
      })

      dispatch(updatePaneContent({
        tabId,
        paneId,
        content: {
          ...currentPane,
          status: 'starting',
          ...(resolvedEffort ? {} : { effort: undefined }),
          createError: undefined,
        },
      }))

      if (shouldClearPersistedProviderEffort) {
        clearPersistedProviderEffortIfPaneMatchesDefaults(currentPane)
      }

    })()

    return () => {
      cancelled = true
    }
  }, [
    defaultPermissionMode,
    dispatch,
    paneContent.createRequestId,
    paneContent.effort,
    paneContent.modelSelection,
    paneContent.provider,
    paneContent.sessionId,
    paneContent.status,
    paneId,
    providerDefaultModelId,
    providerSettings,
    suppressNetworkEffects,
    tabId,
    ws,
  ])

  // Attach to existing session on mount (e.g. after page refresh with persisted pane).
  // Skip when session is already fully hydrated (e.g. split-induced remount) — the WS
  // subscription is connection-scoped so it survives the React unmount/remount cycle.
  // Real disconnects are handled by the separate onReconnect listener below.
  const sessionAlreadyHydrated = session?.historyLoaded === true
  useEffect(() => {
    if (suppressNetworkEffects) return
    if (!attachPayload || attachSentRef.current) return
    // Only attach if we didn't just create this session ourselves
    if (createSentRef.current) return
    // Session already loaded in Redux (split-induced remount) — content reflows
    // naturally without needing to re-fetch from the server.
    if (sessionAlreadyHydrated) return

    attachSentRef.current = true
    ws.send(attachPayload)
  }, [attachPayload, sessionAlreadyHydrated, suppressNetworkEffects, ws])

  // Re-attach on WS reconnect so server re-subscribes this client
  useEffect(() => {
    if (suppressNetworkEffects) return
    if (!attachPayload) return
    return ws.onReconnect(() => {
      ws.send(attachPayload)
    })
  }, [attachPayload, suppressNetworkEffects, ws])

  useEffect(() => {
    if (suppressNetworkEffects) return
    if (!paneContent.sessionId || !restoreHistoryQueryId) return
    if (hidden) return
    if (activePaneId && activePaneId !== paneId) return
    if (session?.latestTurnId === undefined) return
    if (session?.historyLoaded) return
    if (waitingForDurableHistoryIdentity) return

    const promise = dispatch(loadAgentTimelineWindow({
      sessionId: paneContent.sessionId,
      timelineSessionId: restoreHistoryQueryId,
      requestKey: `${tabId}:${paneId}`,
    }))
    return () => {
      promise.abort()
    }
  }, [
    activePaneId,
    dispatch,
    hidden,
    paneContent.sessionId,
    paneId,
    restoreHistoryQueryId,
    session?.restoreHydrationRequestId,
    session?.latestTurnId,
    waitingForDurableHistoryIdentity,
    suppressNetworkEffects,
    tabId,
  ])

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

    // Auto-title the pane and tab from the first user message,
    // mirroring how terminal CLI panes get titles from session indexer.
    const isFirstMessage = !session?.messages.length && !session?.timelineItems?.length
    if (isFirstMessage) {
      const title = extractTitleFromMessage(text)
      if (title) {
        dispatch(updatePaneTitle({ tabId, paneId, title, setByUser: false }))
        if (!tabTitleSetByUser) {
          dispatch(updateTab({ id: tabId, updates: { title } }))
        }
      }
    }

    dispatch(addUserMessage({ sessionId: paneContent.sessionId, text }))
    ws.send({ type: 'sdk.send', sessionId: paneContent.sessionId, text })
    // Always scroll to bottom when the user sends a message
    scrollToBottom()
  }, [paneContent.sessionId, session?.messages.length, session?.timelineItems?.length, dispatch, ws, scrollToBottom, tabId, paneId, tabTitleSetByUser])

  const handleInterrupt = useCallback(() => {
    if (!paneContent.sessionId) return
    ws.send({ type: 'sdk.interrupt', sessionId: paneContent.sessionId })
  }, [paneContent.sessionId, ws])

  const handleRetryCreate = useCallback(() => {
    dispatch(restartAgentChatCreate({ tabId, paneId }))
    createSentRef.current = false
    attachSentRef.current = false
  }, [dispatch, paneId, tabId])

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
    const paneChanges: Partial<AgentChatPaneContent> = {}
    const localChanges: Record<string, unknown> = {}
    const hasModelChange = Object.prototype.hasOwnProperty.call(changes, 'model')
    const hasPermissionModeChange = Object.prototype.hasOwnProperty.call(changes, 'permissionMode')
    const hasEffortChange = Object.prototype.hasOwnProperty.call(changes, 'effort')
    const nextModelValue = typeof changes.model === 'string' && changes.model.trim().length > 0
      ? changes.model
      : undefined
    const nextModelSelection = nextModelValue
      ? parseAgentChatSettingsModelValue(nextModelValue)
      : undefined
    const nextEffort = typeof changes.effort === 'string' && changes.effort.trim().length > 0
      ? changes.effort
      : undefined

    for (const [key, value] of Object.entries(changes)) {
      if (key === 'showThinking' || key === 'showTools' || key === 'showTimecodes') {
        localChanges[key] = value
      } else if (key === 'model') {
        paneChanges.modelSelection = nextModelSelection
      } else if (key === 'effort') {
        paneChanges.effort = nextEffort
      } else {
        (paneChanges as Record<string, unknown>)[key] = value
      }
    }

    if (Object.keys(paneChanges).length > 0) {
      dispatch(updatePaneContent({
        tabId,
        paneId,
        content: { ...paneContentRef.current, ...paneChanges },
      }))
    }

    if (Object.keys(localChanges).length > 0) {
      dispatch(updateSettingsLocal({ agentChat: localChanges }))
    }

    const pc = paneContentRef.current

    // Mid-session model change
    if (hasModelChange && nextModelValue && pc.sessionId && pc.status !== 'creating') {
      const resolvedSelection = resolveAgentChatModelSelection({
        providerDefaultModelId,
        capabilities: providerCapabilitiesRef.current,
        modelSelection: nextModelSelection,
      })
      if (resolvedSelection.resolvedModelId) {
        ws.send({ type: 'sdk.set-model', sessionId: pc.sessionId, model: resolvedSelection.resolvedModelId })
      }
    }

    // Mid-session permission mode change
    if (hasPermissionModeChange && changes.permissionMode && pc.sessionId && pc.status !== 'creating') {
      ws.send({ type: 'sdk.set-permission-mode', sessionId: pc.sessionId, permissionMode: changes.permissionMode as string })
    }

    // Persist as defaults
    if (hasModelChange) {
      void dispatch(saveServerSettingsPatch({
        agentChat: {
          providers: {
            [paneContent.provider]: {
              modelSelection: nextModelSelection,
            },
          },
        },
      }))
    }

    if (hasPermissionModeChange && changes.permissionMode) {
      void dispatch(saveServerSettingsPatch({
        agentChat: {
          providers: {
            [paneContent.provider]: {
              defaultPermissionMode: changes.permissionMode as string,
            },
          },
        },
      }))
    }

    if (hasEffortChange) {
      void dispatch(saveServerSettingsPatch({
        agentChat: {
          providers: {
            [paneContent.provider]: {
              effort: nextEffort,
            },
          },
        },
      }))
    }

    const effectiveEffort = hasEffortChange ? nextEffort : pc.effort

    if (hasModelChange && nextModelValue && effectiveEffort) {
      void (async () => {
        let capabilities = providerCapabilitiesRef.current
        if (!capabilities) {
          const response = await dispatch(fetchAgentChatCapabilities(pc.provider))
          if (!response.ok) return
          capabilities = response.capabilities
        }

        const resolvedSelection = resolveAgentChatModelSelection({
          providerDefaultModelId,
          capabilities,
          modelSelection: nextModelSelection,
        })
        if (!resolvedSelection.capability || isAgentChatEffortSupported(resolvedSelection.capability, effectiveEffort)) {
          return
        }

        dispatch(mergePaneContent({
          tabId,
          paneId,
          updates: { effort: undefined },
        }))
        clearPersistedProviderEffortIfPaneMatchesDefaults(pc)
      })()
    }
  }, [clearPersistedProviderEffortIfPaneMatchesDefaults, dispatch, paneContent.provider, paneId, providerDefaultModelId, tabId, ws])

  useEffect(() => {
    if (paneContent.status === 'creating') return
    if (!paneContent.effort) return
    if (!resolvedModelSelection.capability) return
    if (isAgentChatEffortSupported(resolvedModelSelection.capability, paneContent.effort)) return

    dispatch(mergePaneContent({
      tabId,
      paneId,
      updates: { effort: undefined },
    }))
    clearPersistedProviderEffortIfPaneMatchesDefaults(paneContent)
  }, [
    clearPersistedProviderEffortIfPaneMatchesDefaults,
    dispatch,
    paneContent.effort,
    paneContent.provider,
    paneContent.status,
    paneId,
    resolvedModelSelection.capability,
    tabId,
  ])

  const handleSettingsDismiss = useCallback(() => {
    dispatch(updatePaneContent({
      tabId,
      paneId,
      content: { ...paneContentRef.current, settingsDismissed: true },
    }))
    void dispatch(saveServerSettingsPatch({ agentChat: { initialSetupDone: true } }))
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

  // Focus is handled by the ChatComposer readiness prop below.
  // When settings are dismissed, focus imperatively via the dismiss callback.


  // Keyboard-aware container style: push content above the virtual keyboard on mobile
  const keyboardContainerStyle = useMemo<CSSProperties | undefined>(() => {
    if (!isMobile || keyboardInsetPx === 0) return undefined
    return { paddingBottom: `${keyboardInsetPx}px` }
  }, [isMobile, keyboardInsetPx])

  // Scroll to bottom when mobile keyboard opens to keep latest content visible
  const prevKeyboardInsetRef = useRef(0)
  useEffect(() => {
    if (keyboardInsetPx > 0 && prevKeyboardInsetRef.current === 0 && isAtBottomRef.current) {
      // Keyboard just opened -- scroll to bottom (only if user is already at bottom)
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
    prevKeyboardInsetRef.current = keyboardInsetPx
  }, [keyboardInsetPx])

  // Effort is locked once sdk.create has been sent (no mid-session setter in SDK).
  // Model and permission mode can be changed mid-session via sdk.set-model / sdk.set-permission-mode.
  const sessionStarted = paneContent.status !== 'creating'

  const isInteractive = paneContent.status === 'idle' || paneContent.status === 'connected'
  const isRunning = paneContent.status === 'running'
  const pendingPermissions = session ? Object.values(session.pendingPermissions) : []
  const pendingQuestions = session ? Object.values(session.pendingQuestions) : []
  const hasWaitingItems = pendingPermissions.length > 0 || pendingQuestions.length > 0
  const timelineItems = useMemo(() => session?.timelineItems ?? [], [session?.timelineItems])
  const timelineBodies = session?.timelineBodies ?? {}

  const messages = useMemo(() => session?.messages ?? [], [session?.messages])

  // Debounce streaming text to limit markdown re-parsing to ~20x/sec
  const debouncedStreamingText = useStreamDebounce(
    session?.streamingText ?? '',
    session?.streamingActive ?? false,
  )
  const streamingPreviewText = session?.streamingActive
    ? debouncedStreamingText
    : (session?.streamingText ?? '')

  // Memoize the content array so React.memo on MessageBubble works.
  // Without this, a new array reference is created every render, defeating memo.
  const streamingContent = useMemo(
    () => streamingPreviewText
      ? [{ type: 'text' as const, text: streamingPreviewText }]
      : [],
    [streamingPreviewText],
  )
  const hasStreamingPreview = streamingContent.length > 0
  const shouldRenderStreamingPreview = hasStreamingPreview && session?.status === 'running'

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

  useEffect(() => {
    if (surfaceVisibleMarkedRef.current) return
    if (hidden) return
    if (activePaneId && activePaneId !== paneId) return
    if (!session?.historyLoaded) return
    if (renderItems.length === 0 && timelineItems.length === 0) return
    getInstalledPerfAuditBridge()?.mark('agent_chat.surface_visible', {
      tabId,
      paneId,
      sessionId: paneContent.sessionId,
    })
    surfaceVisibleMarkedRef.current = true
  }, [activePaneId, hidden, paneContent.sessionId, paneId, renderItems.length, session?.historyLoaded, tabId, timelineItems.length])

  return (
    <div className={cn('h-full w-full flex flex-col', hidden ? 'tab-hidden' : 'tab-visible')} role="region" aria-label={`${providerLabel} Chat`} onPointerUp={handleContainerPointerUp} style={keyboardContainerStyle}>
      {/* Status bar */}
      <div className={cn('flex items-center justify-between py-1 border-b text-xs text-muted-foreground', isMobile ? 'px-2' : 'px-3')}>
        <span>
          {hasWaitingItems && 'Waiting for answer...'}
          {!hasWaitingItems && paneContent.status === 'creating' && 'Creating session...'}
          {!hasWaitingItems && paneContent.status === 'starting' && 'Starting Claude Code...'}
          {!hasWaitingItems && paneContent.status === 'connected' && 'Connected'}
          {!hasWaitingItems && paneContent.status === 'running' && 'Running...'}
          {!hasWaitingItems && paneContent.status === 'idle' && 'Ready'}
          {!hasWaitingItems && paneContent.status === 'compacting' && 'Compacting context...'}
          {!hasWaitingItems && paneContent.status === 'create-failed' && 'Create failed'}
          {!hasWaitingItems && paneContent.status === 'exited' && 'Session ended'}
        </span>
        <div className="flex items-center gap-2">
          {paneContent.initialCwd && (
            <span className="truncate">{paneContent.initialCwd}</span>
          )}
          <AgentChatSettings
            model={settingsModelValue}
            permissionMode={paneContent.permissionMode ?? defaultPermissionMode}
            effort={paneContent.effort ?? ''}
            showThinking={defaultShowThinking}
            showTools={defaultShowTools}
            showTimecodes={defaultShowTimecodes}
            sessionStarted={sessionStarted}
            defaultOpen={shouldShowSettings}
            modelOptions={settingsModelOptions}
            effortOptions={effortOptions}
            capabilitiesStatus={providerCapabilitiesState?.status ?? 'idle'}
            capabilityError={providerCapabilitiesState?.error}
            settingsVisibility={providerConfig?.settingsVisibility}
            onRetryCapabilities={() => {
              void dispatch(refreshAgentChatCapabilities(paneContent.provider))
            }}
            onOpenChange={(open) => {
              if (!open) return
              const status = providerCapabilitiesState?.status ?? 'idle'
              if (status === 'loading' || status === 'failed') return
              if (isAgentChatCapabilitiesFresh(providerCapabilitiesState?.capabilities)) return
              void dispatch(fetchAgentChatCapabilities(paneContent.provider))
            }}
            onChange={handleSettingsChange}
            onDismiss={handleSettingsDismiss}
          />
        </div>
      </div>

      {/* Message area wrapper (relative for scroll-to-bottom button positioning) */}
      <div className="relative flex-1 min-h-0">
      <div ref={scrollContainerRef} onScroll={handleScroll} className={cn('h-full overflow-y-auto overflow-x-auto py-3 space-y-2', isMobile ? 'px-2' : 'px-3')} data-context="agent-chat" data-session-id={paneContent.sessionId}>
        {/* Restoring: persisted sessionId but history not yet loaded (reload/back-nav). */}
        {isRestoring && (
          <div className="text-center text-muted-foreground text-sm py-6">
            <p>Restoring session...</p>
          </div>
        )}

        {hasRestoreFailure && session?.restoreFailureMessage && (
          <div className="rounded-lg border border-red-300/60 bg-red-500/10 px-4 py-4 text-sm" role="alert">
            <p className="font-medium text-red-700 dark:text-red-300">Session restore failed</p>
            <p className="mt-1 text-red-700/90 dark:text-red-200">{session.restoreFailureMessage}</p>
          </div>
        )}

        {paneContent.status === 'create-failed' && paneContent.createError && (
          <div className="rounded-lg border border-red-300/60 bg-red-500/10 px-4 py-4 text-sm" role="alert">
            <p className="font-medium text-red-700 dark:text-red-300">Session start failed</p>
            <p className="mt-1 text-red-700/90 dark:text-red-200">{paneContent.createError.message}</p>
            <button
              type="button"
              className="mt-3 rounded-md border border-red-400/60 px-3 py-1.5 text-sm font-medium text-red-700 transition-colors hover:bg-red-500/10 dark:text-red-200"
              onClick={handleRetryCreate}
            >
              Retry
            </button>
          </div>
        )}

        {/* Welcome: no sessionId or the current session is empty after restore completed. */}
        {!session?.messages.length && timelineItems.length === 0 && !isRestoring && !hasRestoreFailure && paneContent.status !== 'create-failed' && (
          <div className="text-center text-muted-foreground text-sm py-6">
            <p className="font-medium mb-1">{providerLabel}</p>
            <p>Rich chat UI for AI agent sessions.</p>
          </div>
        )}

        {timelineItems.map((item) => {
          const turn = timelineBodies[item.turnId]
          if (turn) {
            return (
              <MessageBubble
                key={`timeline-${item.turnId}`}
                speaker={turn.message.role}
                content={turn.message.content}
                timestamp={turn.message.timestamp}
                model={turn.message.model}
                showThinking={defaultShowThinking}
                showTools={defaultShowTools}
                showTimecodes={defaultShowTimecodes}
              />
            )
          }

          return (
            <CollapsedTurn
              key={`timeline-${item.turnId}`}
              summary={item.summary}
              loading={session?.timelineLoading}
              onExpand={() => {
                if (!paneContent.sessionId) return
                void dispatch(loadAgentTurnBody({
                  sessionId: paneContent.sessionId,
                  timelineSessionId: restoreHistoryQueryId,
                  turnId: item.turnId,
                }))
              }}
              showThinking={defaultShowThinking}
              showTools={defaultShowTools}
              showTimecodes={defaultShowTimecodes}
            />
          )
        })}

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
                    showThinking={defaultShowThinking}
                    showTools={defaultShowTools}
                    showTimecodes={defaultShowTimecodes}
                  />
                )
              }
              return (
                <React.Fragment key={`turn-${i}`}>
                  <MessageBubble
                    speaker={item.user.role}
                    content={item.user.content}
                    timestamp={item.user.timestamp}
                    showThinking={defaultShowThinking}
                    showTools={defaultShowTools}
                    showTimecodes={defaultShowTimecodes}
                  />
                  <MessageBubble
                    speaker={item.assistant.role}
                    content={item.assistant.content}
                    timestamp={item.assistant.timestamp}
                    model={item.assistant.model}
                    isLastMessage={isLast}
                    showThinking={defaultShowThinking}
                    showTools={defaultShowTools}
                    showTimecodes={defaultShowTimecodes}
                  />
                </React.Fragment>
              )
            }
            // Standalone messages
            return (
              <MessageBubble
                key={`msg-${i}`}
                speaker={item.message.role}
                content={item.message.content}
                timestamp={item.message.timestamp}
                model={item.message.model}
                isLastMessage={isLast}
                showThinking={defaultShowThinking}
                showTools={defaultShowTools}
                showTimecodes={defaultShowTimecodes}
              />
            )
          })
        })()}

        {shouldRenderStreamingPreview && (
          <MessageBubble
            speaker="assistant"
            content={streamingContent}
            showThinking={defaultShowThinking}
            showTools={defaultShowTools}
            showTimecodes={defaultShowTimecodes}
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
          !hasStreamingPreview &&
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
        {!hasRestoreFailure && session?.lastError && (
          <div className="text-sm text-red-500 bg-red-500/10 rounded-lg px-3 py-2" role="alert">
            {session.lastError}
          </div>
        )}

        {!hasRestoreFailure && session?.timelineError && (
          <div className="text-sm text-red-500 bg-red-500/10 rounded-lg px-3 py-2" role="alert">
            {session.timelineError}
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Scroll-to-bottom button */}
      {showScrollButton && (
        <button
          onClick={scrollToBottom}
          aria-label="Scroll to bottom"
          className="absolute bottom-2 left-1/2 -translate-x-1/2 z-10 rounded-full bg-background border shadow-md p-2 hover:bg-muted transition-colors"
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
        paneId={paneId}
        onSend={handleSend}
        onInterrupt={handleInterrupt}
        disabled={!isInteractive && !isRunning}
        isRunning={isRunning}
        shouldFocusOnReady={!shouldShowSettings}
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
