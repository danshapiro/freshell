import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { nanoid } from 'nanoid'
import type { FreshAgentPaneContent } from '@/store/paneTypes'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import { getWsClient } from '@/lib/ws-client'
import { createLogger } from '@/lib/client-logger'
import { api, getFreshAgentThreadSnapshot, setSessionMetadata } from '@/lib/api'
import { consumePaneRefreshRequest, mergePaneContent, updatePaneContent } from '@/store/panesSlice'
import { clearPendingCreateFailure } from '@/store/freshAgentSlice'
import { dismissTabGreen } from '@/store/turnCompletionAttention'
import { registerFreshAgentCreate } from '@/lib/fresh-agent-ws'
import { getFreshOpenCodeRouteCwd } from '@/lib/fresh-opencode-route'
import {
  normalizeFreshAgentEffort,
  normalizeFreshAgentModel,
  resolveFreshAgentType,
} from '@/lib/fresh-agent-registry'
import { cn } from '@/lib/utils'
import { paneRefreshTargetMatchesContent } from '@/lib/pane-utils'
import { getCanonicalDurableSessionId, getPreferredResumeSessionId } from '@/store/persistControl'
import { isValidClaudeSessionId } from '@/lib/claude-session-id'
import { makeFreshAgentSessionKey } from '@shared/fresh-agent'
import type { FreshAgentSnapshot } from '@shared/fresh-agent-contract'
import {
  freshAgentSnapshotHasUserTurn,
  freshAgentTurnText,
  getFreshAgentDisplayTurnKey,
} from '@shared/fresh-agent-turns'
import { getFreshAgentSlashCommands, type FreshAgentSlashCommand } from '@shared/fresh-agent-slash-commands'
import { buildRestoreError, type RestoreErrorReason } from '@shared/session-contract'
import { isDurableProviderSessionId } from '@shared/session-flavor'
import { DEFAULT_FRESH_AGENT_STYLE, normalizeFreshAgentStyle } from '@shared/settings'
import {
  checkpointLabelForText,
  pickCheckpointForTurn,
  type CheckpointEntry,
} from '@/lib/fresh-agent-checkpoints'
import type { FreshAgentTurn } from '@shared/fresh-agent-contract'
import { finalizeCodingAgentSessionName } from '@/store/codingAgentNaming'
import { FreshAgentApprovalBanner } from './FreshAgentApprovalBanner'
import { FreshAgentApprovalCard } from './FreshAgentApprovalCard'
import FreshAgentQuestionBanner from './FreshAgentQuestionBanner'
import { FreshAgentTranscript, type FreshAgentTranscriptHandle } from './FreshAgentTranscript'
import { FreshAgentComposer, type FreshAgentComposerHandle } from './FreshAgentComposer'
import { FreshAgentDiffPanel } from './FreshAgentDiffPanel'
import { FreshAgentSidebar } from './FreshAgentSidebar'

const EARLY_STATES = new Set(['creating', 'starting'])
const BUSY_STATES = new Set(['running', 'compacting'])
const SNAPSHOT_REFRESH_COALESCE_MS = 50
const SNAPSHOT_INVALIDATING_FRESH_AGENT_EVENTS = new Set([
  'freshAgent.session.changed',
  'freshAgent.session.snapshot',
  'freshAgent.result',
  'freshAgent.permission.request',
  'freshAgent.permission.cancelled',
  'freshAgent.question.request',
])
const log = createLogger('FreshAgentView')

function getSnapshotIdentity(snapshot: FreshAgentSnapshot): string | null {
  if (!snapshot.sessionType || !snapshot.provider || !snapshot.threadId) return null
  return `${snapshot.sessionType}:${snapshot.provider}:${snapshot.threadId}`
}

function getTurnKey(turn: FreshAgentTurn): string {
  return getFreshAgentDisplayTurnKey(turn)
}

type LocalEcho = {
  text: string
  requestId: string
  submittedTurnId?: string
}

function sameLocalEcho(a: LocalEcho | null | undefined, b: LocalEcho | null | undefined): boolean {
  return (a?.requestId ?? null) === (b?.requestId ?? null)
    && (a?.text ?? null) === (b?.text ?? null)
    && (a?.submittedTurnId ?? null) === (b?.submittedTurnId ?? null)
}

type PendingSendMetadata = {
  cwd?: string
  checkpointId?: string
  submittedTurnId?: string
  legacyAccepted?: boolean
  metadataUpdateStarted?: boolean
}

function localEchoLanded(
  turns: readonly FreshAgentTurn[],
  echo: LocalEcho,
  pending?: PendingSendMetadata,
): boolean {
  const needle = echo.text.slice(0, 80)
  const submittedTurnId = echo.submittedTurnId ?? pending?.submittedTurnId
  if (submittedTurnId) {
    return turns.some((turn) => (
      turn.role === 'user'
      && getFreshAgentDisplayTurnKey(turn) === submittedTurnId
    ))
  }
  if (pending && !pending.legacyAccepted) return false
  return turns.some((turn) => (
    turn.role === 'user'
    && freshAgentTurnText(turn).includes(needle)
  ))
}

function isSnapshotInFlight(snapshot: FreshAgentSnapshot): boolean {
  return snapshot.status === 'running' || snapshot.status === 'compacting'
}

function shouldClearStaleLocalEcho(
  snapshot: FreshAgentSnapshot,
  echo: LocalEcho,
  pending?: PendingSendMetadata,
): boolean {
  if (isSnapshotInFlight(snapshot)) return false
  const accepted = Boolean(echo.submittedTurnId || pending?.submittedTurnId || pending?.legacyAccepted)
  if (!accepted) return false
  return !localEchoLanded(snapshot.turns, echo, pending)
}

function mergeSnapshotForDisplay(
  previous: FreshAgentSnapshot | null,
  next: FreshAgentSnapshot,
): FreshAgentSnapshot {
  if (!previous) return next
  const previousIdentity = getSnapshotIdentity(previous)
  const nextIdentity = getSnapshotIdentity(next)
  if (!previousIdentity || previousIdentity !== nextIdentity) return next
  if (
    typeof previous.revision === 'number'
    && typeof next.revision === 'number'
    && next.revision < previous.revision
  ) {
    return previous
  }
  if (next.turns.length >= previous.turns.length || !isSnapshotInFlight(next)) return next

  const nextByKey = new Map(next.turns.map((turn) => [getTurnKey(turn), turn]))
  const previousKeys = new Set(previous.turns.map(getTurnKey))
  const mergedTurns = previous.turns.map((turn) => nextByKey.get(getTurnKey(turn)) ?? turn)
  for (const turn of next.turns) {
    if (!previousKeys.has(getTurnKey(turn))) {
      mergedTurns.push(turn)
    }
  }

  return { ...next, turns: mergedTurns }
}

function resolveEffectiveFreshAgentModel(
  content: FreshAgentPaneContent,
  providerDefaults?: { modelSelection?: { modelId: string } },
): string | undefined {
  const configuredModel = content.model
    ?? content.modelSelection?.modelId
    ?? providerDefaults?.modelSelection?.modelId
  return normalizeFreshAgentModel(content.sessionType, content.provider, configuredModel)
}

function getEffectiveFreshAgentEffort(
  content: FreshAgentPaneContent,
  providerDefaults?: { modelSelection?: { modelId: string } },
): string | undefined {
  return normalizeFreshAgentEffort(
    content.sessionType,
    content.provider,
    resolveEffectiveFreshAgentModel(content, providerDefaults),
    content.effort,
  )
}

function getEffectiveFreshAgentPermissionMode(content: FreshAgentPaneContent): string | undefined {
  return content.provider === 'opencode' ? undefined : content.permissionMode
}

function isStatusRegression(current: string, next: string): boolean {
  return !EARLY_STATES.has(current) && EARLY_STATES.has(next)
}

function getCanonicalPaneResumeSessionId(pane: FreshAgentPaneContent): string | undefined {
  if (pane.sessionRef?.provider === 'claude' && isValidClaudeSessionId(pane.sessionRef.sessionId)) {
    return pane.sessionRef.sessionId
  }
  if (isValidClaudeSessionId(pane.resumeSessionId)) {
    return pane.resumeSessionId
  }
  if (pane.provider === 'claude' && isValidClaudeSessionId(pane.sessionId)) {
    return pane.sessionId
  }
  return undefined
}

function isFreshOpencodePlaceholderId(pane: FreshAgentPaneContent, sessionId: string | undefined): boolean {
  return pane.provider === 'opencode'
    && pane.sessionType === 'freshopencode'
    && typeof sessionId === 'string'
    && sessionId.startsWith('freshopencode-')
}

function getFreshAgentSnapshotThreadId(
  pane: FreshAgentPaneContent,
  claudeSession: Parameters<typeof getCanonicalDurableSessionId>[0],
): string | undefined {
  if (pane.provider === 'claude') {
    // Snapshot history is keyed by Claude's durable UUID. Runtime-only live
    // handles stay interactive through the WS transport, but should not hit
    // the snapshot route or surface history-load errors.
    return getCanonicalDurableSessionId(claudeSession)
      ?? getCanonicalPaneResumeSessionId(pane)
  }
  if (EARLY_STATES.has(pane.status)) {
    // While a new session is still being created, avoid reading an older durable ref.
    return pane.sessionId
  }
  const sessionRefId = pane.sessionRef?.provider === pane.provider ? pane.sessionRef.sessionId : undefined
  if (!pane.sessionId && isFreshOpencodePlaceholderId(pane, sessionRefId)) {
    // Legacy Freshopencode panes could persist only the placeholder sessionRef.
    // Let freshAgent.create/resume repair it before snapshot loading; otherwise
    // the placeholder 404 races the promotion and marks the pane unrecoverable.
    return undefined
  }
  return pane.sessionId
    ?? sessionRefId
}

function getCreatedResumeSessionId(
  current: FreshAgentPaneContent,
  message: { sessionId: string; sessionRef?: { provider: string; sessionId: string } },
): string | undefined {
  if (current.resumeSessionId) return current.resumeSessionId
  if (message.sessionRef?.provider === current.provider) return message.sessionRef.sessionId
  if (current.provider === 'claude' && !isValidClaudeSessionId(message.sessionId)) return undefined
  return message.sessionId
}

function persistDurableFreshAgentFlavor(message: {
  provider: string
  sessionId?: string
  sessionType: string
  sessionRef?: { provider: string; sessionId: string }
}) {
  const provider = message.sessionRef?.provider ?? message.provider
  const sessionId = message.sessionRef?.sessionId ?? message.sessionId
  if (!provider || !sessionId || !isDurableProviderSessionId(provider, sessionId)) return
  setSessionMetadata(provider, sessionId, message.sessionType, {
    sessionTypeSource: 'materialized',
  }).catch((err) => {
    log.warn({
      event: 'fresh_agent_session_metadata_tag_failed',
      provider,
      sessionId,
      sessionType: message.sessionType,
      err,
    })
  })
}

function buildFreshAgentAttachMessage(content: FreshAgentPaneContent, cwd?: string) {
  return {
    type: 'freshAgent.attach',
    sessionId: content.sessionId,
    sessionType: content.sessionType,
    provider: content.provider,
    ...(content.resumeSessionId ? { resumeSessionId: content.resumeSessionId } : {}),
    ...(content.sessionRef ? { sessionRef: content.sessionRef } : {}),
    ...(cwd ? { cwd } : {}),
  } as const
}

function buildLegacyRestoreContext(tab: { title?: string; createdAt?: number; updatedAt?: number } | undefined) {
  if (!tab) return undefined
  const title = typeof tab.title === 'string' && tab.title.trim().length > 0
    ? tab.title.trim()
    : undefined
  const createdAt = typeof tab.createdAt === 'number' && Number.isFinite(tab.createdAt)
    ? tab.createdAt
    : undefined
  const updatedAt = typeof tab.updatedAt === 'number' && Number.isFinite(tab.updatedAt)
    ? tab.updatedAt
    : undefined
  if (!title && createdAt === undefined && updatedAt === undefined) return undefined
  return {
    ...(title ? { title } : {}),
    ...(createdAt !== undefined ? { createdAt } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
  }
}

function getQuestionAgentLabel(paneContent: FreshAgentPaneContent, descriptorLabel?: string): string {
  if (paneContent.sessionType === 'kilroy') return 'Kilroy'
  switch (paneContent.provider) {
    case 'claude':
      return 'Claude'
    case 'codex':
      return 'Codex'
    case 'opencode':
      return 'Opencode'
    default:
      return descriptorLabel ?? 'Fresh Agent'
  }
}

function isUnmaterializedCodexThreadError(error: unknown): boolean {
  return !!error
    && typeof error === 'object'
    && 'message' in error
    && typeof (error as { message?: unknown }).message === 'string'
    && (error as { message: string }).message.includes('no rollout found for thread id')
}

function isLostFreshOpencodeThreadError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const status = 'status' in error ? (error as { status?: unknown }).status : undefined
  const details = 'details' in error ? (error as { details?: unknown }).details : undefined
  const code = details && typeof details === 'object' && 'code' in details
    ? (details as { code?: unknown }).code
    : undefined
  return status === 404 && code === 'FRESH_AGENT_LOST_SESSION'
}

function getRestoreErrorMessage(reason: RestoreErrorReason): string {
  switch (reason) {
    case 'invalid_legacy_restore_target':
      return 'This session cannot be resumed because Freshell only has a legacy name, not a canonical Claude session id.'
    case 'dead_live_handle':
      return 'This session cannot be resumed because the live session handle is gone and no durable session id was saved.'
    case 'missing_canonical_identity':
      return 'This session cannot be resumed because no canonical session id was saved.'
    case 'durable_artifact_missing':
      return 'This session cannot be resumed because the saved session artifact is no longer available.'
    case 'provider_runtime_failed':
      return 'This session cannot be resumed because the provider runtime rejected the restore request.'
    default:
      return 'This session cannot be resumed.'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function readMessageEventType(message: Record<string, unknown>): string | undefined {
  const event = isRecord(message.event) ? message.event : undefined
  return typeof event?.type === 'string' ? event.type : undefined
}

function isSnapshotInvalidatingFreshAgentEvent(message: Record<string, unknown>): boolean {
  if (message.type !== 'freshAgent.event') return false
  const eventType = readMessageEventType(message)
  return Boolean(eventType && SNAPSHOT_INVALIDATING_FRESH_AGENT_EVENTS.has(eventType))
}

function locatorMatchesPane(
  message: Record<string, unknown>,
  content: FreshAgentPaneContent,
  knownCwd?: string,
): boolean {
  if (typeof message.sessionType === 'string' && message.sessionType !== content.sessionType) return false
  if (typeof message.provider === 'string' && message.provider !== content.provider) return false

  const event = isRecord(message.event) ? message.event : undefined
  const locatorSessionId = typeof message.sessionId === 'string'
    ? message.sessionId
    : (typeof event?.sessionId === 'string' ? event.sessionId : undefined)
  if (locatorSessionId) {
    const validSessionIds = new Set<string>()
    if (content.sessionId) validSessionIds.add(content.sessionId)
    if (content.resumeSessionId) validSessionIds.add(content.resumeSessionId)
    if (content.sessionRef?.provider === content.provider) validSessionIds.add(content.sessionRef.sessionId)
    if (!validSessionIds.has(locatorSessionId)) return false
  }

  const locatorCwd = typeof message.cwd === 'string'
    ? message.cwd
    : (typeof event?.cwd === 'string' ? event.cwd : undefined)
  if (locatorCwd) {
    const validCwds = new Set<string>()
    if (content.initialCwd) validCwds.add(content.initialCwd)
    if (knownCwd) validCwds.add(knownCwd)
    if (!validCwds.has(locatorCwd)) return false
  }

  return true
}

function readCodexReview(value: unknown): { id?: string; status?: string } | undefined {
  if (!isRecord(value)) return undefined
  return {
    id: typeof value.id === 'string' ? value.id : undefined,
    status: typeof value.status === 'string' ? value.status : undefined,
  }
}

function readCodexFork(value: unknown): { parentThreadId?: string } | undefined {
  if (!isRecord(value)) return undefined
  return {
    parentThreadId: typeof value.parentThreadId === 'string' ? value.parentThreadId : undefined,
  }
}

function composeOutgoingText(text: string, attachmentPaths: string[]): string {
  if (attachmentPaths.length === 0) return text
  const list = attachmentPaths.map((path) => `- ${path}`).join('\n')
  return `${text ? `${text}\n\n` : ''}Attached files (read them from disk):\n${list}`
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return Boolean(target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]'))
}

function isPlainTextKey(event: ReactKeyboardEvent<HTMLElement>): boolean {
  return event.key.length === 1
    && !event.ctrlKey
    && !event.metaKey
    && !event.altKey
}

function isInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return Boolean(target.closest(
    'input, textarea, select, button, a[href], [contenteditable=""], [contenteditable="true"], [role="button"], [role="menuitem"]',
  ))
}

function isTranscriptNavigationKey(event: ReactKeyboardEvent<HTMLElement>): boolean {
  if (event.ctrlKey || event.metaKey || event.altKey) return false
  switch (event.key) {
    case 'ArrowUp':
    case 'ArrowDown':
    case 'PageUp':
    case 'PageDown':
    case 'Home':
    case 'End':
      return true
    default:
      return false
  }
}

function scrollTranscriptByKey(
  event: ReactKeyboardEvent<HTMLElement>,
  handle: FreshAgentTranscriptHandle | null,
): boolean {
  if (!handle) return false
  switch (event.key) {
    case 'ArrowDown':
      handle.scrollByLine(1)
      break
    case 'ArrowUp':
      handle.scrollByLine(-1)
      break
    case 'PageDown':
      handle.scrollByPage(1)
      break
    case 'PageUp':
      handle.scrollByPage(-1)
      break
    case 'Home':
      handle.scrollToTop()
      break
    case 'End':
      handle.scrollToBottom()
      break
    default:
      return false
  }
  event.preventDefault()
  return true
}

export function FreshAgentView({
  tabId,
  paneId,
  paneContent,
  hidden,
}: {
  tabId: string
  paneId: string
  paneContent: FreshAgentPaneContent
  hidden?: boolean
}) {
  const dispatch = useAppDispatch()
  const ws = getWsClient()
  const terminalFontSize = useAppSelector(
    (state) => state.settings.settings.terminal?.fontSize,
  ) ?? 16
  const providerDefaults = useAppSelector(
    (state) => state.settings.settings.freshAgent?.providers?.[paneContent.sessionType]
      ?? state.settings.serverSettings?.freshAgent?.providers?.[paneContent.sessionType],
  )
  const globalShowThinking = useAppSelector(
    (state) => state.settings.settings.freshAgent?.showThinking
      ?? false,
  )
  const globalShowTools = useAppSelector(
    (state) => state.settings.settings.freshAgent?.showTools
      ?? false,
  )
  const globalShowTimecodes = useAppSelector(
    (state) => state.settings.settings.freshAgent?.showTimecodes
      ?? false,
  )
  const effectiveShowThinking = paneContent.showThinking ?? globalShowThinking
  const effectiveShowTools = paneContent.showTools ?? globalShowTools
  const effectiveShowTimecodes = paneContent.showTimecodes ?? globalShowTimecodes
  const activeStyle = normalizeFreshAgentStyle(
    paneContent.style ?? providerDefaults?.style ?? DEFAULT_FRESH_AGENT_STYLE,
  )
  const pendingCreateFailure = useAppSelector(
    (state) => state.freshAgent?.pendingCreateFailures?.[paneContent.createRequestId],
  )
  const tabRestoreSource = useAppSelector((state) => (
    state.tabs?.tabs?.find((tab) => tab.id === tabId)
  ))
  const claudeSession = useAppSelector((state) => {
    if (paneContent.provider !== 'claude' || !paneContent.sessionId) return undefined
    const sessionKey = makeFreshAgentSessionKey({
      sessionId: paneContent.sessionId,
      sessionType: paneContent.sessionType,
      provider: paneContent.provider,
    })
    return state.freshAgent.sessions[sessionKey]
  })
  // Provider-agnostic session meta: codex/opencode status and errors flow
  // through the freshAgent slice too, but the claudeSession selector above is
  // claude-only — without this, a dead codex/opencode process left the pane
  // looking healthy (blank pane, enabled composer).
  const agentSession = useAppSelector((state) => {
    if (!paneContent.sessionId) return undefined
    const sessionKey = makeFreshAgentSessionKey({
      sessionId: paneContent.sessionId,
      sessionType: paneContent.sessionType,
      provider: paneContent.provider,
    })
    return state.freshAgent.sessions[sessionKey]
  })
  const freshOpenCodeRouteCwd = getFreshOpenCodeRouteCwd(paneContent, { sessionCwd: agentSession?.cwd })
  const freshOpenCodeRouteCwdRef = useRef(freshOpenCodeRouteCwd)
  freshOpenCodeRouteCwdRef.current = freshOpenCodeRouteCwd
  const refreshRequest = useAppSelector((state) => state.panes.refreshRequestsByPane?.[tabId]?.[paneId] ?? null)
  const activeTabId = useAppSelector((state) => state.tabs.activeTabId)
  const activePaneId = useAppSelector((state) => state.panes.activePane[tabId])
  const isActivePane = !hidden && activeTabId === tabId && activePaneId === paneId
  const [snapshot, setSnapshot] = useState<FreshAgentSnapshot | null>(null)
  const snapshotRef = useRef<FreshAgentSnapshot | null>(null)
  const commitSnapshot = useCallback((next: FreshAgentSnapshot | null) => {
    snapshotRef.current = next
    setSnapshot(next)
  }, [])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [snapshotRefreshNonce, setSnapshotRefreshNonce] = useState(0)
  const snapshotRefreshTimerRef = useRef<number | null>(null)
  const [queuedMessages, setQueuedMessages] = useState<string[]>([])
  // Transient, self-clearing banner for action feedback (rewind, shell errors).
  const [notice, setNotice] = useState<string | null>(null)
  // Optimistic echo of the just-sent user message: the transcript renders
  // snapshot turns only, which left a 2-10s blank gap after send
  // (live-test finding). Cleared when a snapshot containing the turn lands.
  const [localEcho, setLocalEchoState] = useState<LocalEcho | null>(() => paneContent.pendingLocalEcho ?? null)
  const localEchoRef = useRef<LocalEcho | null>(null)
  localEchoRef.current = localEcho
  const pendingSendMetadataRef = useRef<Map<string, PendingSendMetadata>>(new Map())
  const descriptor = resolveFreshAgentType(paneContent.sessionType)
  // Capability-gated commands (e.g. /fork) only appear once the snapshot
  // confirms the provider supports the action.
  const slashCommands = useMemo(() => (
    getFreshAgentSlashCommands(paneContent.sessionType).filter((command) => (
      command.requiresCapability
        ? snapshot?.capabilities?.[command.requiresCapability] === true
        : true
    ))
  ), [paneContent.sessionType, snapshot?.capabilities])
  const paneContentRef = useRef(paneContent)
  const composerRef = useRef<FreshAgentComposerHandle | null>(null)
  const transcriptRef = useRef<FreshAgentTranscriptHandle | null>(null)
  const paneRootRef = useRef<HTMLDivElement | null>(null)
  paneContentRef.current = paneContent
  const setLocalEcho = useCallback((next: LocalEcho | null) => {
    setLocalEchoState(next)
    const current = paneContentRef.current
    if (sameLocalEcho(current.pendingLocalEcho, next)) return
    dispatch(mergePaneContent({
      tabId,
      paneId,
      updates: { pendingLocalEcho: next ?? undefined },
    }))
  }, [dispatch, paneId, tabId])
  useEffect(() => {
    const next = paneContent.pendingLocalEcho ?? null
    if (sameLocalEcho(localEchoRef.current, next)) return
    setLocalEchoState(next)
  }, [
    paneContent.pendingLocalEcho?.requestId,
    paneContent.pendingLocalEcho?.submittedTurnId,
    paneContent.pendingLocalEcho?.text,
  ])
  const restoreTimeoutRef = useRef<number | null>(null)
  const createSentRef = useRef(false)
  // Session-scoped "always allow" tool names; reset with the pane, never persisted.
  const alwaysAllowToolsRef = useRef<Set<string>>(new Set())
  // Auto-title state tracks four things:
  // 1. whether this mounted pane has already consumed first-message auto-title,
  // 2. whether we observed a fresh conversation boundary in this mount,
  // 3. the last create boundary we saw, and
  // 4. the last stable/effective conversation identity so retries, restores, and materialization
  //    can preserve latch state for the same conversation instead of reopening it.
  const autoTitleSentRef = useRef(false)
  const autoTitleFreshBoundaryRef = useRef(false)
  const autoTitleCreateRequestIdRef = useRef(paneContent.createRequestId)
  const autoTitleDurableIdentityRef = useRef<string | null>(null)
  const autoTitleIdentityRef = useRef<string | null>(null)
  const pendingAutoTitleBySessionIdRef = useRef<Map<string, string>>(new Map())
  const handledRefreshRequestIdRef = useRef<string | null>(null)
  const preferredResumeSessionId = getPreferredResumeSessionId(claudeSession) ?? paneContent.resumeSessionId
  const snapshotThreadId = getFreshAgentSnapshotThreadId(paneContent, claudeSession)
  const snapshotThreadIdRef = useRef(snapshotThreadId)
  snapshotThreadIdRef.current = snapshotThreadId
  const hasRestoreFailure = Boolean(
    paneContent.provider === 'claude'
      && paneContent.sessionId
      && claudeSession?.historyLoaded
      && claudeSession?.restoreFailureCode
      && claudeSession?.restoreFailureMessage,
  )
  const isRestoring = Boolean(
    paneContent.provider === 'claude'
      && paneContent.sessionId
      && !snapshot
      && Boolean(claudeSession?.latestTurnId !== undefined || claudeSession?.lost)
      && claudeSession?.historyLoaded !== true
      && !hasRestoreFailure,
  )
  const hasUserTurns = useMemo(() => freshAgentSnapshotHasUserTurn(snapshot), [snapshot])
  const autoTitleDurableIdentity = useMemo(() => {
    const paneSessionRefId = paneContent.sessionRef?.provider === paneContent.provider
      ? paneContent.sessionRef.sessionId
      : undefined
    const stableSnapshotThreadId = snapshotThreadId
      && (
        snapshotThreadId !== paneContent.sessionId
        || (!paneSessionRefId && !preferredResumeSessionId && !paneContent.resumeSessionId)
      )
        ? snapshotThreadId
        : undefined
    return paneSessionRefId
      ?? preferredResumeSessionId
      ?? paneContent.resumeSessionId
      ?? stableSnapshotThreadId
      ?? null
  }, [
    paneContent.provider,
    paneContent.resumeSessionId,
    paneContent.sessionId,
    paneContent.sessionRef,
    preferredResumeSessionId,
    snapshotThreadId,
  ])
  const autoTitleIdentity = useMemo(() => {
    const stableIdentity = autoTitleDurableIdentity
      ?? paneContent.sessionId
      ?? paneContent.createRequestId
    return `${paneContent.sessionType}:${paneContent.provider}:${stableIdentity}`
  }, [
    autoTitleDurableIdentity,
    paneContent.createRequestId,
    paneContent.provider,
    paneContent.sessionId,
    paneContent.sessionType,
  ])
  const [snapshotAutoTitleIdentity, setSnapshotAutoTitleIdentity] = useState<string | null>(null)
  const hasCurrentSnapshot = snapshot !== null && snapshotAutoTitleIdentity === autoTitleIdentity
  const snapshotConfirmsNoUserTurns = hasCurrentSnapshot && !hasUserTurns
  const snapshotConfirmsUserTurns = hasCurrentSnapshot && hasUserTurns
  const currentAutoTitleIdentityRef = useRef(autoTitleIdentity)
  currentAutoTitleIdentityRef.current = autoTitleIdentity

  const sendFreshAgentMessage = useCallback((message: Record<string, unknown>) => {
    const suppressed = typeof window !== 'undefined'
      && (
        window.__FRESHELL_TEST_HARNESS__?.isAllFreshAgentNetworkEffectsSuppressed?.() === true
        || window.__FRESHELL_TEST_HARNESS__?.isFreshAgentNetworkEffectsSuppressed?.(paneId) === true
      )
    if (suppressed) {
      window.__FRESHELL_TEST_HARNESS__?.recordSentWsMessage?.(message)
      return
    }
    ws.send(message as never)
  }, [paneId, ws])

  const scheduleSnapshotRefresh = useCallback(() => {
    if (snapshotRefreshTimerRef.current !== null) return
    snapshotRefreshTimerRef.current = window.setTimeout(() => {
      snapshotRefreshTimerRef.current = null
      setSnapshotRefreshNonce((value) => value + 1)
    }, SNAPSHOT_REFRESH_COALESCE_MS)
  }, [])

  useEffect(() => () => {
    if (snapshotRefreshTimerRef.current !== null) {
      window.clearTimeout(snapshotRefreshTimerRef.current)
      snapshotRefreshTimerRef.current = null
    }
  }, [])

  const recordPendingSendMetadata = useCallback((requestId: string, patch: PendingSendMetadata) => {
    const current = pendingSendMetadataRef.current.get(requestId) ?? {}
    const next: PendingSendMetadata = { ...current, ...patch }
    pendingSendMetadataRef.current.set(requestId, next)
    if (
      next.metadataUpdateStarted
      || !next.cwd
      || !next.checkpointId
      || !next.submittedTurnId
    ) {
      return
    }
    pendingSendMetadataRef.current.set(requestId, { ...next, metadataUpdateStarted: true })
    void Promise
      .resolve(api.post('/api/fresh-agent/checkpoints/metadata', {
        cwd: next.cwd,
        id: next.checkpointId,
        requestId,
        turnId: next.submittedTurnId,
      }))
      .then(() => {
        pendingSendMetadataRef.current.delete(requestId)
      })
      .catch(() => {
        const latest = pendingSendMetadataRef.current.get(requestId)
        if (latest) {
          pendingSendMetadataRef.current.set(requestId, { ...latest, metadataUpdateStarted: false })
        }
      })
  }, [])

  const migratePendingAutoTitle = useCallback((
    previousSessionId: string | undefined,
    nextSessionId: string | undefined,
    provider: string,
  ) => {
    if (!previousSessionId || !nextSessionId || previousSessionId === nextSessionId) return
    const firstMessage = pendingAutoTitleBySessionIdRef.current.get(previousSessionId)
    if (!firstMessage) return
    pendingAutoTitleBySessionIdRef.current.delete(previousSessionId)
    dispatch(finalizeCodingAgentSessionName({
      tabId,
      paneId,
      provider,
      sessionId: nextSessionId,
      firstMessage,
    }))
  }, [dispatch, paneId, tabId])

  const prevCreateRequestIdRef = useRef(paneContent.createRequestId)
  if (prevCreateRequestIdRef.current !== paneContent.createRequestId) {
    prevCreateRequestIdRef.current = paneContent.createRequestId
    createSentRef.current = false
  }

  useEffect(() => {
    if (autoTitleCreateRequestIdRef.current !== paneContent.createRequestId) {
      const previousAutoTitleIdentity = autoTitleIdentityRef.current
      const previousDurableIdentity = autoTitleDurableIdentityRef.current
      autoTitleCreateRequestIdRef.current = paneContent.createRequestId
      autoTitleDurableIdentityRef.current = autoTitleDurableIdentity
      autoTitleIdentityRef.current = autoTitleIdentity
      if (
        previousAutoTitleIdentity === autoTitleIdentity
        || (autoTitleDurableIdentity && previousDurableIdentity === autoTitleDurableIdentity)
      ) {
        autoTitleFreshBoundaryRef.current = autoTitleFreshBoundaryRef.current || snapshotConfirmsNoUserTurns
        autoTitleSentRef.current = autoTitleSentRef.current || snapshotConfirmsUserTurns
      } else {
        autoTitleFreshBoundaryRef.current = true
        autoTitleSentRef.current = false
        setSnapshotAutoTitleIdentity(null)
      }
      return
    }
    if (autoTitleIdentityRef.current === null) {
      autoTitleDurableIdentityRef.current = autoTitleDurableIdentity
      autoTitleIdentityRef.current = autoTitleIdentity
      autoTitleFreshBoundaryRef.current = !paneContent.sessionId
        && (paneContent.status === 'creating' || paneContent.status === 'starting')
      autoTitleSentRef.current = snapshotConfirmsUserTurns
      return
    }
    if (autoTitleIdentityRef.current !== autoTitleIdentity) {
      autoTitleDurableIdentityRef.current = autoTitleDurableIdentity
      autoTitleIdentityRef.current = autoTitleIdentity
      autoTitleFreshBoundaryRef.current = autoTitleFreshBoundaryRef.current || snapshotConfirmsNoUserTurns
      autoTitleSentRef.current = autoTitleSentRef.current || snapshotConfirmsUserTurns
      return
    }
    if (snapshotConfirmsNoUserTurns && !autoTitleSentRef.current) {
      autoTitleFreshBoundaryRef.current = true
    }
    if (snapshotConfirmsUserTurns) {
      autoTitleFreshBoundaryRef.current = false
      autoTitleSentRef.current = true
    }
  }, [
    autoTitleDurableIdentity,
    autoTitleIdentity,
    paneContent.createRequestId,
    paneContent.sessionId,
    paneContent.status,
    snapshotConfirmsNoUserTurns,
    snapshotConfirmsUserTurns,
  ])

  const buildCreateMessage = useCallback((content: FreshAgentPaneContent) => {
    const legacyRestoreContext = content.provider === 'opencode'
      ? buildLegacyRestoreContext(tabRestoreSource)
      : undefined
    return {
      type: 'freshAgent.create',
      requestId: content.createRequestId,
      sessionType: content.sessionType,
      provider: content.provider,
      cwd: content.initialCwd,
      ...(legacyRestoreContext ? { legacyRestoreContext } : {}),
      resumeSessionId: content.resumeSessionId
        ?? (content.sessionRef?.provider === content.provider ? content.sessionRef.sessionId : undefined),
      sessionRef: content.sessionRef,
      modelSelection: content.modelSelection,
      model: resolveEffectiveFreshAgentModel(content, providerDefaults),
      ...(getEffectiveFreshAgentPermissionMode(content) ? { permissionMode: getEffectiveFreshAgentPermissionMode(content) } : {}),
      sandbox: content.sandbox,
      effort: getEffectiveFreshAgentEffort(content, providerDefaults),
      plugins: content.plugins,
    } as const
  }, [providerDefaults, tabRestoreSource])

  const startNewConversation = useCallback(() => {
    const current = paneContentRef.current
    if (current.sessionId) {
      const cwd = getFreshOpenCodeRouteCwd(current, { sessionCwd: freshOpenCodeRouteCwdRef.current })
      sendFreshAgentMessage({
        type: 'freshAgent.kill',
        sessionId: current.sessionId,
        sessionType: current.sessionType,
        provider: current.provider,
        ...(cwd ? { cwd } : {}),
      })
    }
    commitSnapshot(null)
    setLoadError(null)
    setQueuedMessages([])
    setLocalEcho(null)
    alwaysAllowToolsRef.current.clear()
    pendingAutoTitleBySessionIdRef.current.clear()
    dispatch(updatePaneContent({
      tabId,
      paneId,
      content: {
        ...current,
        createRequestId: nanoid(),
        sessionId: undefined,
        sessionRef: undefined,
        resumeSessionId: undefined,
        restoreError: undefined,
        createError: undefined,
        status: 'creating',
        pendingLocalEcho: undefined,
      },
    }))
  }, [commitSnapshot, dispatch, paneId, sendFreshAgentMessage, setLocalEcho, tabId])

  const sendFork = useCallback((atTurnId?: string) => {
    const current = paneContentRef.current
    if (!current.sessionId) return
    const cwd = getFreshOpenCodeRouteCwd(current, { sessionCwd: freshOpenCodeRouteCwdRef.current })
    // The freshAgent.forked broadcast is matched on createRequestId +
    // parentSessionId by the listener below, which repoints this pane at
    // the forked session. atTurnId is best-effort: providers that can't
    // fork mid-thread fork from the tip.
    sendFreshAgentMessage({
      type: 'freshAgent.fork',
      requestId: current.createRequestId,
      sessionId: current.sessionId,
      sessionType: current.sessionType,
      provider: current.provider,
      ...(cwd ? { cwd } : {}),
      ...(atTurnId ? { input: { atTurnId } } : {}),
    })
  }, [sendFreshAgentMessage])

  const runSlashCommand = useCallback((command: FreshAgentSlashCommand, args: string) => {
    const current = paneContentRef.current
    if (command.action === 'new') {
      startNewConversation()
      return
    }
    if (command.action === 'compact') {
      if (!current.sessionId) return
      const cwd = getFreshOpenCodeRouteCwd(current, { sessionCwd: freshOpenCodeRouteCwdRef.current })
      sendFreshAgentMessage({
        type: 'freshAgent.compact',
        sessionId: current.sessionId,
        sessionType: current.sessionType,
        provider: current.provider,
        ...(cwd ? { cwd } : {}),
        ...(args ? { instructions: args } : {}),
      })
      return
    }
    if (command.action === 'fork') {
      sendFork()
    }
  }, [sendFork, sendFreshAgentMessage, startNewConversation])

  useEffect(() => {
    if (!refreshRequest) return
    if (handledRefreshRequestIdRef.current === refreshRequest.requestId) return
    const current = paneContentRef.current
    if (!paneRefreshTargetMatchesContent(refreshRequest.target, current)) return

    handledRefreshRequestIdRef.current = refreshRequest.requestId
    commitSnapshot(null)
    setLoadError(null)

    if (current.sessionId) {
      const cwd = getFreshOpenCodeRouteCwd(current, { sessionCwd: freshOpenCodeRouteCwdRef.current })
      sendFreshAgentMessage(buildFreshAgentAttachMessage(current, cwd))
      setSnapshotRefreshNonce((value) => value + 1)
    } else if (!hidden && (current.status === 'creating' || current.status === 'starting')) {
      createSentRef.current = true
      registerFreshAgentCreate(dispatch, current.createRequestId, {
        sessionType: current.sessionType,
        provider: current.provider,
        resumeSessionId: current.resumeSessionId,
        sessionRef: current.sessionRef,
        cwd: current.initialCwd,
      })
      sendFreshAgentMessage(buildCreateMessage(current))
    }

    dispatch(consumePaneRefreshRequest({ tabId, paneId, requestId: refreshRequest.requestId }))
  }, [buildCreateMessage, commitSnapshot, dispatch, hidden, paneId, refreshRequest, sendFreshAgentMessage, tabId])

  const triggerRecovery = useCallback(() => {
    if (restoreTimeoutRef.current !== null) {
      clearTimeout(restoreTimeoutRef.current)
      restoreTimeoutRef.current = null
    }
    const nextRequestId = nanoid()
    const canonicalResumeSessionId = getCanonicalDurableSessionId(claudeSession)
      ?? getCanonicalPaneResumeSessionId(paneContentRef.current)
    if (!canonicalResumeSessionId) {
      const hadLegacyRestoreTarget = Boolean(getPreferredResumeSessionId(claudeSession) || paneContentRef.current.resumeSessionId)
      dispatch(updatePaneContent({
        tabId,
        paneId,
        content: {
          ...paneContentRef.current,
          sessionId: undefined,
          resumeSessionId: undefined,
          sessionRef: undefined,
          restoreError: buildRestoreError(hadLegacyRestoreTarget ? 'invalid_legacy_restore_target' : 'dead_live_handle'),
          createRequestId: nextRequestId,
          status: 'idle',
          createError: undefined,
        },
      }))
      return
    }

    dispatch(updatePaneContent({
      tabId,
      paneId,
      content: {
        ...paneContentRef.current,
        sessionId: undefined,
        resumeSessionId: canonicalResumeSessionId,
        sessionRef: { provider: 'claude', sessionId: canonicalResumeSessionId },
        restoreError: undefined,
        createRequestId: nextRequestId,
        status: 'creating',
        createError: undefined,
      },
    }))
  }, [claudeSession, dispatch, paneId, tabId])

  useEffect(() => {
    if (paneContent.sessionId || hidden) return
    if (paneContent.restoreError) return
    if (
      paneContent.status !== 'creating'
      && paneContent.status !== 'starting'
      && !paneContent.sessionRef
    ) return
    if (createSentRef.current) return
    createSentRef.current = true
    registerFreshAgentCreate(dispatch, paneContent.createRequestId, {
      sessionType: paneContent.sessionType,
      provider: paneContent.provider,
      resumeSessionId: paneContent.resumeSessionId,
      sessionRef: paneContent.sessionRef,
      cwd: paneContent.initialCwd,
    })
    sendFreshAgentMessage(buildCreateMessage(paneContent))
  }, [
    buildCreateMessage,
    dispatch,
    hidden,
    paneContent,
    sendFreshAgentMessage,
  ])

  useEffect(() => {
    if (hidden) return
    if (paneContent.sessionId || !createSentRef.current) return
    if (paneContent.status !== 'creating' && paneContent.status !== 'starting') return
    if (typeof ws.onReconnect !== 'function') return
    return ws.onReconnect(() => {
      const current = paneContentRef.current
      if (current.sessionId) return
      if (current.status !== 'creating' && current.status !== 'starting') return
      sendFreshAgentMessage(buildCreateMessage(current))
    })
  }, [
    buildCreateMessage,
    hidden,
    paneContent.sessionId,
    paneContent.status,
    sendFreshAgentMessage,
    ws,
  ])

  useEffect(() => {
    if (!paneContent.sessionId || hidden) return
    sendFreshAgentMessage(buildFreshAgentAttachMessage(paneContent, freshOpenCodeRouteCwd))
  }, [
    freshOpenCodeRouteCwd,
    hidden,
    paneContent.provider,
    paneContent.resumeSessionId,
    paneContent.sessionId,
    paneContent.sessionRef?.provider,
    paneContent.sessionRef?.sessionId,
    paneContent.sessionType,
    sendFreshAgentMessage,
  ])

  useEffect(() => {
    if (hidden || !paneContent.sessionId) return
    if (typeof ws.onReconnect !== 'function') return
    return ws.onReconnect(() => {
      const current = paneContentRef.current
      if (!current.sessionId) return
      const cwd = getFreshOpenCodeRouteCwd(current, { sessionCwd: freshOpenCodeRouteCwdRef.current })
      sendFreshAgentMessage(buildFreshAgentAttachMessage(current, cwd))
      scheduleSnapshotRefresh()
    })
  }, [hidden, paneContent.sessionId, scheduleSnapshotRefresh, sendFreshAgentMessage, ws])

  useEffect(() => {
    if (typeof ws.onMessage !== 'function') return
    const unsubscribe = ws.onMessage((message) => {
      if (message.type === 'freshAgent.created' && message.requestId === paneContentRef.current.createRequestId) {
        const current = paneContentRef.current
        persistDurableFreshAgentFlavor(message)
        dispatch(updatePaneContent({
          tabId,
          paneId,
          content: {
            ...current,
            sessionId: message.sessionId,
            sessionRef: message.sessionRef ?? current.sessionRef,
            resumeSessionId: getCreatedResumeSessionId(current, {
              sessionId: message.sessionId,
              sessionRef: message.sessionRef,
            }),
            status: 'connected',
            createError: undefined,
            restoreError: undefined,
          },
        }))
      }
      if (message.type === 'freshAgent.create.failed' && message.requestId === paneContentRef.current.createRequestId) {
        dispatch(updatePaneContent({
          tabId,
          paneId,
          content: {
            ...paneContentRef.current,
            status: 'create-failed',
            createError: {
              code: message.code,
              message: message.message,
              retryable: message.retryable,
            },
          },
        }))
      }
      if (
        message.type === 'freshAgent.session.materialized'
        && message.previousSessionId === paneContentRef.current.sessionId
        && message.sessionType === paneContentRef.current.sessionType
        && message.provider === paneContentRef.current.provider
      ) {
        const current = paneContentRef.current
        const sessionRef = message.sessionRef ?? { provider: message.provider, sessionId: message.sessionId }
        persistDurableFreshAgentFlavor({
          provider: message.provider,
          sessionId: message.sessionId,
          sessionType: message.sessionType,
          sessionRef,
        })
        migratePendingAutoTitle(current.sessionId, message.sessionId, message.provider)
        setSnapshotRefreshNonce((value) => value + 1)
        dispatch(updatePaneContent({
          tabId,
          paneId,
          content: {
            ...current,
            sessionId: message.sessionId,
            sessionRef,
            resumeSessionId: message.sessionId,
            restoreError: undefined,
          },
        }))
      }
      if (
        message.type === 'freshAgent.send.accepted'
        && typeof message.requestId === 'string'
      ) {
        const current = paneContentRef.current
        const echo = localEchoRef.current
        const ownsRequest = pendingSendMetadataRef.current.has(message.requestId)
          || echo?.requestId === message.requestId
        if (!ownsRequest || !locatorMatchesPane(message, current, freshOpenCodeRouteCwdRef.current)) {
          return
        }
        const submittedTurnId = typeof message.submittedTurnId === 'string'
          ? message.submittedTurnId
          : undefined
        if (submittedTurnId) {
          recordPendingSendMetadata(message.requestId, { submittedTurnId })
          if (echo?.requestId === message.requestId) {
            setLocalEcho({ ...echo, submittedTurnId })
          }
        } else {
          recordPendingSendMetadata(message.requestId, { legacyAccepted: true })
        }
        scheduleSnapshotRefresh()
      }
      if (
        isSnapshotInvalidatingFreshAgentEvent(message)
        && locatorMatchesPane(message, paneContentRef.current, freshOpenCodeRouteCwdRef.current)
      ) {
        scheduleSnapshotRefresh()
      }
      if (
        message.type === 'freshAgent.forked'
        && message.requestId === paneContent.createRequestId
        && message.parentSessionId === paneContent.sessionId
        && message.sessionType === paneContent.sessionType
        && message.provider === paneContent.provider
        && typeof message.sessionId === 'string'
      ) {
        if (message.sessionId !== paneContent.sessionId) {
          const cwd = getFreshOpenCodeRouteCwd(paneContent, { sessionCwd: agentSession?.cwd })
          sendFreshAgentMessage({
            type: 'freshAgent.kill',
            sessionId: paneContent.sessionId,
            sessionType: paneContent.sessionType,
            provider: paneContent.provider,
            ...(cwd ? { cwd } : {}),
          })
        }
        commitSnapshot(null)
        dispatch(updatePaneContent({
          tabId,
          paneId,
          content: {
            ...paneContentRef.current,
            createRequestId: nanoid(),
            sessionId: message.sessionId,
            sessionRef: {
              provider: paneContent.provider,
              sessionId: message.sessionId,
            },
            resumeSessionId: message.sessionId,
            status: 'connected',
            createError: undefined,
            restoreError: undefined,
          },
        }))
      }
    })
    return unsubscribe
  }, [agentSession?.cwd, commitSnapshot, dispatch, migratePendingAutoTitle, paneContent, paneContent.createRequestId, paneId, recordPendingSendMetadata, scheduleSnapshotRefresh, sendFreshAgentMessage, setLocalEcho, tabId, ws])

  useEffect(() => {
    if (!snapshotThreadId) return
    if (paneContent.provider === 'claude' && claudeSession?.lost) return
    const controller = new AbortController()
    setLoadError(null)
    const sessionId = snapshotThreadId
    const provider = paneContent.provider
    const requestSessionType = paneContent.sessionType
    const requestCreateRequestId = paneContent.createRequestId
    const isStaleSnapshotRequest = () => (
      paneContentRef.current.createRequestId !== requestCreateRequestId
      || paneContentRef.current.provider !== provider
      || paneContentRef.current.sessionType !== requestSessionType
      || snapshotThreadIdRef.current !== sessionId
    )
    const requestCwd = paneContentRef.current.initialCwd
    void getFreshAgentThreadSnapshot(requestSessionType, provider, sessionId, {
      signal: controller.signal,
      ...(requestCwd ? { cwd: requestCwd } : {}),
    })
      .then((next) => {
        if (isStaleSnapshotRequest()) return
        const snapshotIdentity = currentAutoTitleIdentityRef.current
        const resolved = next as FreshAgentSnapshot
        const resolvedHasUserTurns = freshAgentSnapshotHasUserTurn(resolved)
        if (!resolvedHasUserTurns && !autoTitleSentRef.current) {
          autoTitleFreshBoundaryRef.current = true
        }
        if (resolvedHasUserTurns) {
          autoTitleFreshBoundaryRef.current = false
          autoTitleSentRef.current = true
        }
        const displaySnapshot = mergeSnapshotForDisplay(snapshotRef.current, resolved)
        const snapshotAccepted = displaySnapshot !== snapshotRef.current
        commitSnapshot(displaySnapshot)
        setSnapshotAutoTitleIdentity(snapshotIdentity)
        const echo = localEchoRef.current
        const echoPendingMetadata = echo ? pendingSendMetadataRef.current.get(echo.requestId) : undefined
        const landedEcho = echo
          ? localEchoLanded(displaySnapshot.turns, echo, echoPendingMetadata)
          : false
        const staleEcho = echo
          ? snapshotAccepted && shouldClearStaleLocalEcho(displaySnapshot, echo, echoPendingMetadata)
          : false
        if (echo) {
          if (landedEcho || staleEcho) setLocalEcho(null)
        }
        const fresh = paneContentRef.current
        const nextStatus = (resolved.status as FreshAgentPaneContent['status']) ?? fresh.status
        const snapshotSessionRef = provider === 'opencode' && resolved.sessionId && resolved.sessionId !== sessionId
          ? { provider, sessionId: resolved.sessionId }
          : undefined
        const nextSessionId = snapshotSessionRef?.sessionId ?? fresh.sessionId
        const nextSessionRef = snapshotSessionRef ?? fresh.sessionRef
        const nextResumeSessionId = snapshotSessionRef?.sessionId ?? fresh.resumeSessionId ?? sessionId
        if (snapshotSessionRef) {
          migratePendingAutoTitle(fresh.sessionId, snapshotSessionRef.sessionId, provider)
        }
        if (
          nextStatus === fresh.status
          && nextSessionId === fresh.sessionId
          && nextResumeSessionId === fresh.resumeSessionId
          && nextSessionRef?.provider === fresh.sessionRef?.provider
          && nextSessionRef?.sessionId === fresh.sessionRef?.sessionId
        ) {
          return
        }
        dispatch(updatePaneContent({
          tabId,
          paneId,
          content: {
            ...fresh,
            sessionId: nextSessionId,
            sessionRef: nextSessionRef,
            status: nextStatus,
            resumeSessionId: nextResumeSessionId,
            pendingLocalEcho: landedEcho || staleEcho ? undefined : fresh.pendingLocalEcho,
          },
        }))
      })
      .catch((error: unknown) => {
        if (error instanceof Error && error.name === 'AbortError') return
        if (isStaleSnapshotRequest()) return
        if (paneContent.provider === 'claude' && claudeSession && isRestoring) {
          // While a restore is in flight the snapshot legitimately 404s.
          // Outside of restore, swallowing here left dead Claude sessions as
          // silent blank panes (live-test finding) — let the error surface.
          setLoadError(null)
          return
        }
        if (paneContent.provider === 'codex' && isUnmaterializedCodexThreadError(error)) {
          const fresh = paneContentRef.current
          setLoadError(null)
          commitSnapshot(null)
          dispatch(updatePaneContent({
            tabId,
            paneId,
            content: {
              ...fresh,
              sessionId: undefined,
              sessionRef: undefined,
              createRequestId: nanoid(),
              status: 'idle',
              createError: undefined,
              restoreError: buildRestoreError('durable_artifact_missing'),
            },
          }))
          return
        }
        if (paneContent.provider === 'opencode' && isLostFreshOpencodeThreadError(error)) {
          const fresh = paneContentRef.current
          setLoadError(null)
          commitSnapshot(null)
          dispatch(updatePaneContent({
            tabId,
            paneId,
            content: {
              ...fresh,
              sessionId: undefined,
              sessionRef: undefined,
              resumeSessionId: undefined,
              createRequestId: nanoid(),
              status: 'idle',
              createError: undefined,
              restoreError: buildRestoreError('durable_artifact_missing'),
            },
          }))
          return
        }
        setLoadError(error instanceof Error ? error.message : 'Failed to load session')
      })
    return () => controller.abort()
    // Depend only on what identifies *which* snapshot to load. This effect
    // dispatches updatePaneContent to persist its own resolved resumeSessionId/
    // status; listing the whole paneContent object (or those output fields) made
    // that self-update retrigger the effect, firing a redundant second fetch for
    // the same session. Current values for non-identity fields are read live via
    // paneContentRef.current inside the effect.
  }, [
    claudeSession?.lost,
    dispatch,
    paneContent.provider,
    paneContent.createRequestId,
    paneContent.sessionId,
    paneContent.sessionType,
    paneId,
    commitSnapshot,
    migratePendingAutoTitle,
    snapshotThreadId,
    snapshotRefreshNonce,
    tabId,
  ])

  const claudeSessionStatus = claudeSession?.status
  useEffect(() => {
    if (paneContent.provider !== 'claude') return
    if (!claudeSessionStatus || claudeSessionStatus === paneContent.status) return
    if (claudeSession?.lost) return
    if (isStatusRegression(paneContent.status, claudeSessionStatus)) return
    dispatch(mergePaneContent({
      tabId,
      paneId,
      updates: { status: claudeSessionStatus },
    }))
  }, [claudeSession?.lost, claudeSessionStatus, dispatch, paneContent.provider, paneContent.status, paneId, tabId])

  useEffect(() => {
    if (paneContent.provider !== 'claude') return
    if (!paneContent.sessionId) return
    const canonicalResumeSessionId = getCanonicalDurableSessionId(claudeSession)
    const shouldUpdateResumeSessionId = Boolean(
      preferredResumeSessionId && preferredResumeSessionId !== paneContent.resumeSessionId,
    )
    const shouldClearRestoreError = Boolean(canonicalResumeSessionId && paneContent.restoreError)
    if (!shouldUpdateResumeSessionId && !shouldClearRestoreError) return
    dispatch(mergePaneContent({
      tabId,
      paneId,
      updates: {
        ...(shouldUpdateResumeSessionId ? { resumeSessionId: preferredResumeSessionId } : {}),
        ...(canonicalResumeSessionId
          ? {
              sessionRef: { provider: 'claude', sessionId: canonicalResumeSessionId },
              restoreError: undefined,
            }
          : {}),
      },
    }))
  }, [
    claudeSession,
    dispatch,
    paneContent.provider,
    paneContent.resumeSessionId,
    paneContent.restoreError,
    paneContent.sessionId,
    paneId,
    preferredResumeSessionId,
    tabId,
  ])

  useEffect(() => {
    if (paneContent.provider !== 'claude') return
    if (!paneContent.sessionId || !claudeSession?.lost) return
    const shouldDeferUntilVisibleRestore = Boolean(
      claudeSession.latestTurnId !== undefined && claudeSession.historyLoaded === true
    )
    if (shouldDeferUntilVisibleRestore) {
      const sessionIdForRecovery = paneContent.sessionId
      restoreTimeoutRef.current = window.setTimeout(() => {
        restoreTimeoutRef.current = null
        if (paneContentRef.current.sessionId !== sessionIdForRecovery) return
        if (!claudeSession?.lost) return
        triggerRecovery()
      }, 0)
      return () => {
        if (restoreTimeoutRef.current !== null) {
          clearTimeout(restoreTimeoutRef.current)
          restoreTimeoutRef.current = null
        }
      }
    }
    triggerRecovery()
  }, [
    claudeSession?.historyLoaded,
    claudeSession?.latestTurnId,
    claudeSession?.lost,
    paneContent.provider,
    paneContent.sessionId,
    triggerRecovery,
  ])

  const effectiveStatus = paneContent.provider === 'claude'
    ? (claudeSessionStatus ?? paneContent.status)
    : (agentSession?.status ?? paneContent.status)
  const isBusy = BUSY_STATES.has(effectiveStatus)
  const sessionEnded = effectiveStatus === 'exited' || effectiveStatus === 'create-failed'
  const sessionErrorMessage = (agentSession as { lastError?: string } | undefined)?.lastError ?? null
  // sessionEnded gates everything: a stale snapshot can still claim
  // capabilities.send after the provider process died.
  const canSend = !sessionEnded && (snapshot?.capabilities?.send === true || (
    paneContent.provider === 'claude'
    && Boolean(paneContent.sessionId)
    && !isRestoring
    && !hasRestoreFailure
    && !['creating', 'starting', 'create-failed', 'exited'].includes(effectiveStatus)
  ))
  // Providers report capabilities.send=false WHILE BUSY — that must not
  // disable the composer, or queueing becomes unreachable for codex and
  // opencode (live-test finding). Disabled = no session, ended, or truly
  // read-only when idle.
  const composerDisabled = !paneContent.sessionId || sessionEnded || (!canSend && !isBusy)

  useEffect(() => {
    if (!isActivePane) return
    const frame = requestAnimationFrame(() => {
      const active = document.activeElement
      if (active instanceof HTMLElement
        && paneRootRef.current?.contains(active)
        && isEditableTarget(active)) return
      if (composerDisabled) {
        paneRootRef.current?.focus()
        return
      }
      composerRef.current?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [isActivePane, composerDisabled])

  // Fallback poll while the agent is (or claims to be) working: if a
  // transport event is missed, the pane self-heals within a few seconds
  // instead of stranding on an empty turn with a stop button.
  useEffect(() => {
    if (hidden || !paneContent.sessionId) return
    if (!isBusy && !EARLY_STATES.has(effectiveStatus)) return
    const timer = window.setInterval(() => {
      setSnapshotRefreshNonce((value) => value + 1)
    }, 3000)
    return () => window.clearInterval(timer)
  }, [effectiveStatus, hidden, isBusy, paneContent.sessionId])

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(null), 6000)
    return () => window.clearTimeout(timer)
  }, [notice])

  /** Core outgoing-message path shared by direct sends and queue flushes. */
  const sendUserText = useCallback((text: string) => {
    const current = paneContentRef.current
    if (!current.sessionId) return
    const requestId = nanoid()
    const routeCwd = getFreshOpenCodeRouteCwd(current, { sessionCwd: freshOpenCodeRouteCwdRef.current })
    recordPendingSendMetadata(requestId, {})
    // Checkpoint the working tree before the agent acts on this message, so
    // "rewind code to here" on this turn restores the pre-turn state. Fire and
    // forget: a failed snapshot must never block the send.
    if (current.initialCwd) {
      recordPendingSendMetadata(requestId, { cwd: current.initialCwd })
      void Promise
        .resolve(api.post<CheckpointEntry>('/api/fresh-agent/checkpoints', {
          cwd: current.initialCwd,
          label: checkpointLabelForText(text),
          requestId,
        }))
        .then((entry) => {
          if (entry?.id) {
            recordPendingSendMetadata(requestId, {
              cwd: current.initialCwd,
              checkpointId: entry.id,
            })
          }
        })
        .catch(() => { /* surfaced lazily when a rewind finds no checkpoint */ })
    }
    const isFirstMessage = !autoTitleSentRef.current
      && (autoTitleFreshBoundaryRef.current || snapshotConfirmsNoUserTurns)
    if (isFirstMessage) {
      autoTitleFreshBoundaryRef.current = false
      autoTitleSentRef.current = true
      pendingAutoTitleBySessionIdRef.current.set(current.sessionId, text)
      dispatch(finalizeCodingAgentSessionName({
        tabId,
        paneId,
        provider: current.provider,
        sessionId: current.sessionId,
        firstMessage: text,
      }))
    }
    const nextLocalEcho: LocalEcho = { text, requestId }
    sendFreshAgentMessage({
      type: 'freshAgent.send',
      requestId,
      sessionId: current.sessionId,
      sessionType: current.sessionType,
      provider: current.provider,
      ...(routeCwd ? { cwd: routeCwd } : {}),
      text,
      settings: {
        ...(current.initialCwd ? { cwd: current.initialCwd } : {}),
        ...(resolveEffectiveFreshAgentModel(current, providerDefaults) ? { model: resolveEffectiveFreshAgentModel(current, providerDefaults) } : {}),
        ...(getEffectiveFreshAgentPermissionMode(current) ? { permissionMode: getEffectiveFreshAgentPermissionMode(current) } : {}),
        ...(current.sandbox ? { sandbox: current.sandbox } : {}),
        ...(getEffectiveFreshAgentEffort(current, providerDefaults) ? { effort: getEffectiveFreshAgentEffort(current, providerDefaults) } : {}),
      },
    })
    setLocalEchoState(nextLocalEcho)
    dispatch(mergePaneContent({
      tabId,
      paneId,
      updates: {
        ...(current.provider === 'opencode' ? { status: 'running' } : {}),
        pendingLocalEcho: nextLocalEcho,
      },
    }))
  }, [dispatch, paneId, providerDefaults, recordPendingSendMetadata, sendFreshAgentMessage, snapshotConfirmsNoUserTurns, tabId])

  // Flush queued messages when the turn ends. One flush per status change is
  // enough: all queued entries are delivered in order for the next turn.
  useEffect(() => {
    if (isBusy || queuedMessages.length === 0) return
    if (!paneContentRef.current.sessionId) return
    const toSend = queuedMessages
    setQueuedMessages([])
    for (const message of toSend) {
      sendUserText(message)
    }
  }, [isBusy, queuedMessages, sendUserText])

  // Session-scoped auto-approval: any pending approval whose tool the user
  // marked "always allow" is answered immediately.
  const pendingApprovalsFromSnapshot = snapshot?.pendingApprovals
  useEffect(() => {
    if (!pendingApprovalsFromSnapshot || pendingApprovalsFromSnapshot.length === 0) return
    const current = paneContentRef.current
    if (!current.sessionId) return
    const cwd = getFreshOpenCodeRouteCwd(current, { sessionCwd: freshOpenCodeRouteCwdRef.current })
    for (const approval of pendingApprovalsFromSnapshot) {
      if (approval.toolName && alwaysAllowToolsRef.current.has(approval.toolName)) {
        sendFreshAgentMessage({
          type: 'freshAgent.approval.respond',
          sessionId: current.sessionId,
          sessionType: current.sessionType,
          provider: current.provider,
          ...(cwd ? { cwd } : {}),
          requestId: approval.requestId,
          decision: { behavior: 'allow', updatedInput: {} },
        })
      }
    }
  }, [pendingApprovalsFromSnapshot, sendFreshAgentMessage])

  /** `!command` shell escape: run via the extras endpoint, then hand the
   * command + output to the agent as explicit user-provided context. */
  const runShellCommand = useCallback((command: string) => {
    const current = paneContentRef.current
    void Promise
      .resolve(api.post<{ output: string; exitCode: number | null; truncated: boolean }>(
        '/api/fresh-agent/exec',
        { command, cwd: current.initialCwd },
      ))
      .then((result) => {
        const status = result.exitCode === 0 ? '' : ` (exit ${result.exitCode})`
        const body = `I ran \`${command}\`${status} in ${current.initialCwd ?? 'the home directory'}. Output:\n\`\`\`\n${result.output || '(no output)'}\n\`\`\``
        if (isBusy) {
          setQueuedMessages((queue) => [...queue, body])
        } else {
          sendUserText(body)
        }
      })
      .catch((error: unknown) => {
        setNotice(error instanceof Error ? `Shell command failed: ${error.message}` : 'Shell command failed')
      })
  }, [isBusy, sendUserText])

  /** Rewind the working tree to the checkpoint taken when a user turn was
   * sent. Conversation history is untouched — this is the code half of
   * rewind; fork-from-turn covers the conversation half. */
  const rewindToTurn = useCallback((turn: FreshAgentTurn) => {
    const current = paneContentRef.current
    if (!current.initialCwd) {
      setNotice('Rewind unavailable: this session has no working directory.')
      return
    }
    const cwd = current.initialCwd
    void Promise
      .resolve(api.get<{ checkpoints: CheckpointEntry[] }>(
        `/api/fresh-agent/checkpoints?cwd=${encodeURIComponent(cwd)}`,
      ))
      .then((result) => {
        const checkpoint = pickCheckpointForTurn(result?.checkpoints ?? [], snapshot?.turns ?? [], turn)
        if (!checkpoint) {
          setNotice('No checkpoint found for that message (it may predate checkpointing).')
          return
        }
        const confirmed = typeof window === 'undefined' || window.confirm(
          `Rewind code to the state before "${checkpoint.label}"?\n\nTracked files changed since will be overwritten. Files created since are left in place. The conversation is not affected.`,
        )
        if (!confirmed) return
        return Promise
          .resolve(api.post('/api/fresh-agent/checkpoints/restore', { cwd, id: checkpoint.id }))
          .then(() => setNotice(`Code rewound to before: "${checkpoint.label}"`))
      })
      .catch((error: unknown) => {
        setNotice(error instanceof Error ? `Rewind failed: ${error.message}` : 'Rewind failed')
      })
  }, [snapshot?.turns])

  const content = useMemo(() => {
    const turns = snapshot?.turns ?? []
    const pendingApprovals = snapshot?.pendingApprovals ?? []
    const pendingQuestions = snapshot?.pendingQuestions ?? []
    const worktrees = snapshot?.worktrees ?? []
    const childThreads = snapshot?.childThreads ?? []
    const diffs = snapshot?.diffs ?? []
    const codexReview = readCodexReview(snapshot?.extensions?.codex?.review)
    const codexFork = readCodexFork(snapshot?.extensions?.codex?.fork)
    const hasSidebarMetadata = worktrees.length > 0
      || childThreads.length > 0
      || Boolean(codexReview)
      || Boolean(codexFork)
    const canInterrupt = isBusy && (snapshot?.capabilities?.interrupt === true || (
      paneContent.provider === 'claude'
      && Boolean(paneContent.sessionId)
      && ['connected', 'running', 'compacting'].includes(effectiveStatus)
    ))
    const canFork = snapshot?.capabilities?.fork === true
    const questionAgentLabel = getQuestionAgentLabel(paneContent, descriptor?.label)
    const visibleRestoreFailure = paneContent.provider === 'claude'
      ? claudeSession?.restoreFailureMessage
      : null
    const visiblePaneRestoreFailure = visibleRestoreFailure
      ? null
      : (paneContent.restoreError ? getRestoreErrorMessage(paneContent.restoreError.reason) : null)
    const visibleLoadError = visibleRestoreFailure || visiblePaneRestoreFailure || isRestoring ? null : loadError
    const WatermarkIcon = descriptor?.icon
    const handlePanePointerUp = (event: ReactPointerEvent<HTMLElement>) => {
      if (isEditableTarget(event.target)) return
      if (window.getSelection()?.toString()) return
      requestAnimationFrame(() => composerRef.current?.focus())
    }
    const handlePaneKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
      if (event.defaultPrevented) return
      if (isTranscriptNavigationKey(event) && !isInteractiveTarget(event.target)) {
        scrollTranscriptByKey(event, transcriptRef.current)
        return
      }
      if (isEditableTarget(event.target)) return
      if (!isPlainTextKey(event)) return
      event.preventDefault()
      composerRef.current?.appendText(event.key)
    }
    const contextSessionId = paneContent.sessionId
      ?? (paneContent.sessionRef?.provider === paneContent.provider ? paneContent.sessionRef.sessionId : undefined)
      ?? paneContent.resumeSessionId
    const sendInterrupt = () => {
      if (!paneContent.sessionId || !canInterrupt) return
      sendFreshAgentMessage({
        type: 'freshAgent.interrupt',
        sessionId: paneContent.sessionId,
        sessionType: paneContent.sessionType,
        provider: paneContent.provider,
        ...(freshOpenCodeRouteCwd ? { cwd: freshOpenCodeRouteCwd } : {}),
      })
    }
    const respondToApproval = (requestId: string | number, allow: boolean) => {
      dispatch(dismissTabGreen(tabId))
      if (!paneContent.sessionId) return
      sendFreshAgentMessage({
        type: 'freshAgent.approval.respond',
        sessionId: paneContent.sessionId,
        sessionType: paneContent.sessionType,
        provider: paneContent.provider,
        ...(freshOpenCodeRouteCwd ? { cwd: freshOpenCodeRouteCwd } : {}),
        requestId,
        decision: allow
          ? { behavior: 'allow', updatedInput: {} }
          : { behavior: 'deny', message: 'Denied by user', interrupt: false },
      })
    }

    return (
      <div
        ref={paneRootRef}
        tabIndex={-1}
        className={cn(
          'fresh-agent-pane relative flex h-full min-h-0 flex-col overflow-hidden',
          `fresh-agent-style-${activeStyle}`,
        )}
        data-context="fresh-agent"
        data-style={activeStyle}
        data-tab-id={tabId}
        data-pane-id={paneId}
        data-session-id={contextSessionId}
        data-provider={paneContent.provider}
        data-session-type={paneContent.sessionType}
        style={{ '--fresh-transcript-font-size': `${terminalFontSize}px` } as CSSProperties}
        onPointerUpCapture={handlePanePointerUp}
        onKeyDownCapture={handlePaneKeyDown}
      >
        {WatermarkIcon ? (
          <WatermarkIcon
            className="fresh-agent-watermark pointer-events-none absolute left-1/2 top-1/2 z-0 h-[min(34rem,64%)] w-[min(34rem,64%)] -translate-x-1/2 -translate-y-1/2 text-foreground"
            aria-hidden="true"
            data-testid="fresh-agent-watermark"
          />
        ) : null}
        <div className={`${hasSidebarMetadata ? 'fresh-agent-layout--with-sidebar ' : ''}fresh-agent-layout relative z-10 min-h-0 flex-1`}>
          <div className="fresh-agent-main flex min-h-0 flex-1 flex-col">
            <div className="fresh-agent-top-stack space-y-2 px-3 pt-3">
              {isRestoring ? (
                <FreshAgentApprovalBanner text="Restoring session..." />
              ) : null}
              {snapshot?.summary ? (
                <div className="fresh-agent-summary-card rounded-md border border-border/60 bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
                  {snapshot.summary}
                </div>
              ) : null}
              {pendingCreateFailure || paneContent.createError ? (
                <div className="fresh-agent-error-card flex items-center justify-between gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-sm">
                  <FreshAgentApprovalBanner text={(pendingCreateFailure ?? paneContent.createError)?.message ?? 'Create failed'} />
                  {(pendingCreateFailure ?? paneContent.createError)?.retryable ? (
                    <button
                      type="button"
                      className="fresh-agent-error-action rounded border border-border/70 px-2 py-1"
                      onClick={() => {
                        const nextRequestId = nanoid()
                        dispatch(updatePaneContent({
                          tabId,
                          paneId,
                          content: {
                            ...paneContentRef.current,
                            sessionId: undefined,
                            createRequestId: nextRequestId,
                            status: 'creating',
                            createError: undefined,
                          },
                        }))
                      }}
                    >
                      Retry
                    </button>
                  ) : null}
                </div>
              ) : null}
              {visibleRestoreFailure ? <FreshAgentApprovalBanner text={visibleRestoreFailure} /> : null}
              {visiblePaneRestoreFailure ? <FreshAgentApprovalBanner text={visiblePaneRestoreFailure} /> : null}
              {visibleLoadError ? <FreshAgentApprovalBanner text={visibleLoadError} /> : null}
              {sessionErrorMessage ? <FreshAgentApprovalBanner text={`Agent error: ${sessionErrorMessage}`} /> : null}
              {sessionEnded ? (
                <div className="fresh-agent-session-ended-card flex items-center justify-between gap-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm">
                  <span>This session has ended{sessionErrorMessage ? '' : ' (the agent process exited)'}.</span>
                  <button
                    type="button"
                    className="fresh-agent-session-ended-action shrink-0 rounded border border-border/70 px-2 py-1 text-xs"
                    onClick={startNewConversation}
                  >
                    Start new session
                  </button>
                </div>
              ) : null}
              {notice ? <FreshAgentApprovalBanner text={notice} /> : null}
              {pendingApprovals.map((approval) => (
                <FreshAgentApprovalCard
                  key={String(approval.requestId)}
                  approval={approval}
                  disabled={!paneContent.sessionId}
                  onAllow={() => respondToApproval(approval.requestId, true)}
                  onAlwaysAllow={(toolName) => {
                    alwaysAllowToolsRef.current.add(toolName)
                    respondToApproval(approval.requestId, true)
                  }}
                  onDeny={() => respondToApproval(approval.requestId, false)}
                />
              ))}
              {pendingQuestions.map((question) => (
                <FreshAgentQuestionBanner
                  key={String(question.requestId)}
                  question={{
                    requestId: String(question.requestId),
                    questions: (question.questions ?? []).map((entry) => ({
                      question: entry.question,
                      header: entry.header ?? 'Question',
                      options: entry.options ?? [],
                      multiSelect: entry.multiSelect === true,
                    })),
                  }}
                  providerLabel={questionAgentLabel}
                  onAnswer={(answers) => {
                    dispatch(dismissTabGreen(tabId))
                    if (!paneContent.sessionId) return
                    sendFreshAgentMessage({
                      type: 'freshAgent.question.respond',
                      sessionId: paneContent.sessionId,
                      sessionType: paneContent.sessionType,
                      provider: paneContent.provider,
                      ...(freshOpenCodeRouteCwd ? { cwd: freshOpenCodeRouteCwd } : {}),
                      requestId: question.requestId,
                      answers,
                    })
                  }}
                  disabled={!paneContent.sessionId}
                />
              ))}
              <FreshAgentDiffPanel
                diffs={diffs}
                cwd={paneContent.initialCwd}
                onComment={(text) => composerRef.current?.insertText(text)}
              />
            </div>
            <FreshAgentTranscript
              ref={transcriptRef}
              turns={localEcho
                ? [...turns, {
                    id: `__local-echo:${localEcho.requestId}`,
                    turnId: localEcho.submittedTurnId ?? `__local-echo:${localEcho.requestId}`,
                    requestId: localEcho.requestId,
                    role: 'user',
                    summary: localEcho.text,
                    items: [{ id: `__local-echo-item:${localEcho.requestId}`, kind: 'text', text: localEcho.text }],
                  } as FreshAgentTurn]
                : turns}
              canFork={canFork}
              agentLabel={descriptor?.label}
              showThinking={effectiveShowThinking}
              showTools={effectiveShowTools}
              showTimecodes={effectiveShowTimecodes}
              isStreaming={isBusy}
              onForkFromTurn={(turnId) => sendFork(turnId)}
              onRewindToTurn={paneContent.initialCwd ? rewindToTurn : undefined}
            />
            <FreshAgentComposer
              ref={composerRef}
              disabled={composerDisabled}
              placeholder={
                sessionEnded
                  ? 'Session ended — start a new one above or via the ⌘ menu'
                  : !paneContent.sessionId || EARLY_STATES.has(effectiveStatus)
                    ? 'Starting session…'
                    : isBusy
                      ? 'Agent is working — sends queue for the next turn'
                      : !canSend
                        ? 'Read-only session'
                        : undefined
              }
              storageKey={`fresh-agent-draft:${paneContent.sessionType}:${paneContent.sessionId ?? paneContent.createRequestId}`}
              historyKey={`fresh-agent-prompt-history:${paneContent.sessionType}`}
              cwd={paneContent.initialCwd}
              provider={paneContent.provider}
              thinking={isBusy}
              queuedMessages={queuedMessages}
              onCancelQueued={(index) => {
                setQueuedMessages((queue) => queue.filter((_, i) => i !== index))
              }}
              canInterrupt={canInterrupt && Boolean(paneContent.sessionId)}
              onInterrupt={sendInterrupt}
              commands={slashCommands}
              onCommand={runSlashCommand}
              onShellCommand={runShellCommand}
              onSend={(text, attachmentPaths) => {
                dispatch(dismissTabGreen(tabId))
                if (!paneContent.sessionId || sessionEnded) return
                if (!canSend && !isBusy) return
                const outgoing = composeOutgoingText(text, attachmentPaths)
                if (!outgoing) return
                if (isBusy) {
                  setQueuedMessages((queue) => [...queue, outgoing])
                  return
                }
                sendUserText(outgoing)
              }}
            />
          </div>
          <FreshAgentSidebar
            worktrees={worktrees}
            childThreads={childThreads}
            codexReview={codexReview}
            codexFork={codexFork}
          />
        </div>
      </div>
    )
  }, [
    canSend,
    claudeSession?.restoreFailureMessage,
    activeStyle,
    composerDisabled,
    descriptor?.icon,
    descriptor?.label,
    effectiveStatus,
    effectiveShowThinking,
    effectiveShowTimecodes,
    effectiveShowTools,
    isBusy,
    isRestoring,
    loadError,
    localEcho,
    notice,
    paneContent,
    pendingCreateFailure,
    queuedMessages,
    rewindToTurn,
    runShellCommand,
    sessionEnded,
    sessionErrorMessage,
    startNewConversation,
    runSlashCommand,
    sendFork,
    sendUserText,
    snapshot,
    slashCommands,
    dispatch,
    paneId,
    sendFreshAgentMessage,
    tabId,
    terminalFontSize,
  ])

  useEffect(() => {
    if (!pendingCreateFailure) return
    return () => {
      dispatch(clearPendingCreateFailure({ requestId: paneContent.createRequestId }))
    }
  }, [dispatch, paneContent.createRequestId, pendingCreateFailure])

  return content
}

export default FreshAgentView
