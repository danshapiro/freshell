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
import type { PaneReconcileRequest } from '@shared/ws-protocol'
import { useAppDispatch, useAppSelector, useAppStore } from '@/store/hooks'
import { getWsClient, RECONCILE_VERDICT_WAIT_MS } from '@/lib/ws-client'
import { createLogger } from '@/lib/client-logger'
import { api, getFreshAgentThreadSnapshot, setSessionMetadata } from '@/lib/api'
import { clearReconcilePendingPane, consumePaneRefreshRequest, mergePaneContent, updatePaneContent } from '@/store/panesSlice'
import { FRESH_AGENT_MODEL_CATALOG_UNAVAILABLE_NOTICE } from '@/lib/fresh-agent-model-capabilities'
import { clearPendingCreateFailure, clearSessionLost, setSessionStatus } from '@/store/freshAgentSlice'
import { buildReconcileRequestForPanes, foldVerdicts, isFreshAgentReconcileActive } from '@/lib/pane-reconcile'
import { dismissTabGreen } from '@/store/turnCompletionAttention'
import { registerFreshAgentCreate } from '@/lib/fresh-agent-ws'
import { getFreshOpenCodeRouteCwd } from '@/lib/fresh-opencode-route'
import { getRebindQueue } from '@/lib/rebind-queue'
import { getSnapshotScheduler, makeSnapshotKey, type SnapshotTrigger } from '@/lib/fresh-agent-snapshot-scheduler'
import {
  getEffectiveFreshAgentEffort,
  resolveEffectiveFreshAgentModel,
  resolveFreshAgentType,
} from '@/lib/fresh-agent-registry'
import { cn } from '@/lib/utils'
import { collectPaneEntries, paneRefreshTargetMatchesContent } from '@/lib/pane-utils'
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
import FreshAgentModelDialog from '@/components/fresh-agent/FreshAgentModelDialog'
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

// Task 14: SESSION_RESERVED bounded re-drive. The window must outlast the
// server lease TTL (20s) with margin -- same arithmetic as TerminalView's
// reserve-retry constants; the floor is the fixed re-drive cadence (the
// server's create.failed carries no retry-after field by design).
export const FRESH_AGENT_RESERVE_RETRY_WINDOW_MS = 30_000
export const FRESH_AGENT_RESERVE_RETRY_FLOOR_MS = 1_000
// Task 16 (zrrj): bounded re-poll when an idle snapshot is missing the
// just-sent turn (server emitted idle before the durable transcript caught
// up). Exported so tests assert the cap against the real constant.
export const IDLE_INCOMPLETE_MAX_RETRIES = 5
const IDLE_INCOMPLETE_RETRY_DELAY_MS = 1_000
// Exported so tests assert membership against the real constant.
export const SNAPSHOT_INVALIDATING_FRESH_AGENT_EVENTS = new Set([
  'freshAgent.session.changed',
  'freshAgent.session.snapshot',
  'freshAgent.result',
  'freshAgent.turn.complete',
  'freshAgent.permission.request',
  'freshAgent.permission.cancelled',
  'freshAgent.question.request',
  // A provider-cancelled question must also re-drive the snapshot, so the card clears
  // even if the freshAgent.question.cancelled fold races (fresh-eyes round-3 F3).
  'freshAgent.question.cancelled',
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
  /** The exact text of the freshAgent.send frame -- retained as the resend
   * payload for the lost-session retry (Task 10). Never read back from the
   * local echo. */
  text?: string
}

function localEchoLanded(
  turns: readonly FreshAgentTurn[],
  echo: LocalEcho,
  pending?: PendingSendMetadata,
  options: {
    allowTextMatch?: boolean
    previousTurns?: readonly FreshAgentTurn[]
  } = {},
): boolean {
  const needle = echo.text.slice(0, 80)
  const submittedTurnId = echo.submittedTurnId ?? pending?.submittedTurnId
  const previousTurnKeys = options.previousTurns
    ? new Set(options.previousTurns.map(getTurnKey))
    : null
  const canMatchText = Boolean(needle) && (
    options.allowTextMatch === true
    || pending?.legacyAccepted === true
    || !pending
  )
  return turns.some((turn) => (
    turn.role === 'user'
    && (
      (submittedTurnId ? getFreshAgentDisplayTurnKey(turn) === submittedTurnId : false)
      || (turn as { requestId?: unknown }).requestId === echo.requestId
      || (
        canMatchText
        && (!previousTurnKeys || !previousTurnKeys.has(getTurnKey(turn)))
        && freshAgentTurnText(turn).includes(needle)
      )
    )
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

// resolveEffectiveFreshAgentModel + getEffectiveFreshAgentEffort are the
// shared registry helpers (imported above): display, model dialog, and the
// send/create payloads all read one central normalization so a stamped
// probed-model effort survives everywhere.

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

// Codex fresh-agent threads don't have a UUID-format validator the way Claude
// does (isValidClaudeSessionId), so this mirrors getCanonicalPaneResumeSessionId's
// fallback chain (sessionRef -> resumeSessionId -> sessionId) without that
// claude-specific format check. Used only to let a lost codex session attempt
// a bounded resume instead of being permanently abandoned (see triggerRecovery).
function getCanonicalCodexResumeSessionId(pane: FreshAgentPaneContent): string | undefined {
  if (pane.sessionRef?.provider === 'codex' && pane.sessionRef.sessionId) {
    return pane.sessionRef.sessionId
  }
  if (pane.provider === 'codex' && pane.resumeSessionId) {
    return pane.resumeSessionId
  }
  if (pane.provider === 'codex' && pane.sessionId) {
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

/// The ONE durable-identity claim an outgoing create/attach carries: the
/// canonical sessionRef, with a legacy-only pane's `resumeSessionId` promoted
/// into it ({provider, sessionId} — the same §5.2 promotion rule the server's
/// reconcile door applies). The legacy wire field itself is no longer sent;
/// every server door resolves its resume input from sessionRef
/// (claude.rs/codex.rs/opencode_ws.rs create paths, claude.rs
/// attach_durable_id, Node runtime-manager.ts:106-108).
function effectiveSessionRef(content: FreshAgentPaneContent) {
  if (content.sessionRef) return content.sessionRef
  if (content.resumeSessionId) {
    return { provider: content.provider, sessionId: content.resumeSessionId }
  }
  return undefined
}

function buildFreshAgentAttachMessage(content: FreshAgentPaneContent, cwd?: string) {
  const sessionRef = effectiveSessionRef(content)
  return {
    type: 'freshAgent.attach',
    sessionId: content.sessionId,
    sessionType: content.sessionType,
    provider: content.provider,
    ...(sessionRef ? { sessionRef } : {}),
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
  const appStore = useAppStore()
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
  const hasUnresolvedLocalEchoForSession = useAppSelector((state) => {
    if (!paneContent.sessionId) return false
    return Object.values(state.panes.layouts).some((layout) => {
      if (!layout) return false
      return collectPaneEntries(layout).some(({ content }) => (
        content.kind === 'fresh-agent'
        && content.provider === paneContent.provider
        && content.sessionType === paneContent.sessionType
        && content.sessionId === paneContent.sessionId
        && !!content.pendingLocalEcho
      ))
    })
  })
  const hasUnresolvedLocalEchoForSessionRef = useRef(false)
  hasUnresolvedLocalEchoForSessionRef.current = hasUnresolvedLocalEchoForSession
  const agentSessionStatusRef = useRef(agentSession?.status)
  agentSessionStatusRef.current = agentSession?.status
  const agentSessionStatusVersionRef = useRef(agentSession?.statusVersion ?? 0)
  agentSessionStatusVersionRef.current = agentSession?.statusVersion ?? 0
  const freshOpenCodeRouteCwd = getFreshOpenCodeRouteCwd(paneContent, { sessionCwd: agentSession?.cwd })
  const freshOpenCodeRouteCwdRef = useRef(freshOpenCodeRouteCwd)
  freshOpenCodeRouteCwdRef.current = freshOpenCodeRouteCwd
  const refreshRequest = useAppSelector((state) => state.panes.refreshRequestsByPane?.[tabId]?.[paneId] ?? null)
  const activeTabId = useAppSelector((state) => state.tabs.activeTabId)
  const activePaneId = useAppSelector((state) => state.panes.activePane[tabId])
  // Reconnect authority for the .lost recovery driver below: App flips
  // connection.status away from 'ready' on every stale-socket abandon and back
  // to 'ready' after handshake, so a dep flip re-runs the driver on a fresh
  // reconnect even when every other dep is unchanged.
  const connectionStatus = useAppSelector((s) => s.connection.status)
  const isActivePane = !hidden && activeTabId === tabId && activePaneId === paneId
  const [snapshot, setSnapshot] = useState<FreshAgentSnapshot | null>(null)
  const snapshotRef = useRef<FreshAgentSnapshot | null>(null)
  const commitSnapshot = useCallback((next: FreshAgentSnapshot | null) => {
    snapshotRef.current = next
    setSnapshot(next)
  }, [])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [snapshotRefreshNonce, setSnapshotRefreshNonce] = useState(0)
  const snapshotRefreshTriggerRef = useRef<SnapshotTrigger>('identity')
  // Non-null while the snapshot key is rate-limited (429/backoff): the last
  // good snapshot stays visible and a single retry is armed at expiry.
  // Task 17 also consumes this for the snapshot `trigger` query param.
  const [rateLimitedUntil, setRateLimitedUntil] = useState<number | null>(null)
  void rateLimitedUntil
  const rateLimitRetryTimerRef = useRef<number | null>(null)
  // Task 16: idle-incomplete re-poll budget and pending retry timer (deduped:
  // never a second timer while one counts down; cleared on unmount). The
  // local echo is the loop's marker -- see applySnapshot.
  const idleIncompleteRetryCountRef = useRef(0)
  const idleIncompleteRetryTimerRef = useRef<number | null>(null)
  const [queuedMessages, setQueuedMessages] = useState<string[]>([])
  // Transient, self-clearing banner for action feedback (rewind, shell errors).
  const [notice, setNotice] = useState<string | null>(null)
  const [modelDialogOpen, setModelDialogOpen] = useState(false)
  const closeModelDialog = useCallback(() => setModelDialogOpen(false), [])
  // /model with a dead catalog opens the shared notice, not an empty dialog.
  const handleModelCatalogUnavailable = useCallback(() => setNotice(FRESH_AGENT_MODEL_CATALOG_UNAVAILABLE_NOTICE), [])
  // Optimistic echo of the just-sent user message: the transcript renders
  // snapshot turns only, which left a 2-10s blank gap after send
  // (live-test finding). Cleared when a snapshot containing the turn lands.
  const [localEcho, setLocalEchoState] = useState<LocalEcho | null>(() => paneContent.pendingLocalEcho ?? null)
  const localEchoRef = useRef<LocalEcho | null>(null)
  localEchoRef.current = localEcho
  const pendingSendMetadataRef = useRef<Map<string, PendingSendMetadata>>(new Map())
  // Task 10: requestIds whose FRESH_AGENT_LOST_SESSION failure already fired a
  // retry, plus the retry requestIds themselves -- a retry is never retried,
  // so a resend can happen at most once per failed request (loop-proof).
  const lostSessionRetryRef = useRef<Set<string>>(new Set())
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
  // Pre-verdict create wait (fresh-agent leg of Task 8's pattern): a pane
  // named in an outgoing pane.reconcile request defers its mount-time create
  // until its verdict folds -- bounded by RECONCILE_VERDICT_WAIT_MS, then the
  // legacy eager create proceeds (never a silent wedge). The Task 6b sender
  // hold is the authoritative gate; this view layer avoids burning the
  // rebind-queue slot / send on a pane whose verdict is in flight.
  const reconcilePendingSince = useAppSelector(
    (s) => s.panes.reconcilePendingPanes?.[`${tabId}:${paneId}`],
  )
  const reconcilePendingSinceRef = useRef<number | undefined>(reconcilePendingSince)
  reconcilePendingSinceRef.current = reconcilePendingSince
  const verdictWaitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // F8 hidden-pane rebind: mirror `hidden` into a ref for use inside queued
  // jobs and ws callbacks (same pattern as TerminalView's hiddenRef).
  const hiddenRef = useRef(hidden)
  useEffect(() => {
    hiddenRef.current = hidden
  }, [hidden])
  // Snapshot refresh owed at next reveal (set when a reconnect happens hidden).
  const pendingRevealRefreshRef = useRef(false)
  // Release callback for an in-flight queued CREATE rebind; released by the
  // freshAgent.created / create-failed ack (or the queue's 10s backstop).
  const pendingRebindReleaseRef = useRef<(() => void) | null>(null)
  // Queued rebind jobs can outlive the pane (they sit in the shared
  // RebindQueue). Jobs check this ref so a pane closed while its create job
  // was queued does not spawn a server session no pane owns.
  const isMountedRef = useRef(true)
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

  const releasePendingRebind = useCallback(() => {
    const release = pendingRebindReleaseRef.current
    pendingRebindReleaseRef.current = null
    release?.()
  }, [])

  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
      // Free any slot held by an un-acked create so the shared queue does
      // not wait out the 10s backstop for a pane that no longer exists.
      releasePendingRebind()
      // Pre-verdict wait timer: never leak past unmount.
      if (verdictWaitTimerRef.current !== null) {
        clearTimeout(verdictWaitTimerRef.current)
        verdictWaitTimerRef.current = null
      }
    }
  }, [releasePendingRebind])

  // Single trigger-tagged refresh path: every refresh site tags WHY it wants
  // a snapshot, and the fetch effect hands that trigger to the shared per-key
  // scheduler (debounce/coalesce now live there, not in this component).
  const requestSnapshotRefresh = useCallback((trigger: SnapshotTrigger) => {
    snapshotRefreshTriggerRef.current = trigger
    setSnapshotRefreshNonce((value) => value + 1)
  }, [])

  useEffect(() => () => {
    if (rateLimitRetryTimerRef.current !== null) {
      window.clearTimeout(rateLimitRetryTimerRef.current)
      rateLimitRetryTimerRef.current = null
    }
  }, [])

  // Task 16: never leak a pending idle-incomplete retry timer past unmount.
  useEffect(() => () => {
    if (idleIncompleteRetryTimerRef.current !== null) {
      window.clearTimeout(idleIncompleteRetryTimerRef.current)
      idleIncompleteRetryTimerRef.current = null
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

  /** Builds and sends the freshAgent.send frame. Shared by the composer
   * submit path (sendUserText) and the lost-session retry (Task 10) so the
   * retry frame carries exactly the same fields, plus the route cwd. */
  const sendFreshAgentSendFrame = useCallback((requestId: string, text: string, cwd?: string) => {
    const current = paneContentRef.current
    if (!current.sessionId) return
    sendFreshAgentMessage({
      type: 'freshAgent.send',
      requestId,
      sessionId: current.sessionId,
      sessionType: current.sessionType,
      provider: current.provider,
      ...(cwd ? { cwd } : {}),
      text,
      settings: {
        ...(current.initialCwd ? { cwd: current.initialCwd } : {}),
        ...(resolveEffectiveFreshAgentModel(current, providerDefaults) ? { model: resolveEffectiveFreshAgentModel(current, providerDefaults) } : {}),
        ...(getEffectiveFreshAgentPermissionMode(current) ? { permissionMode: getEffectiveFreshAgentPermissionMode(current) } : {}),
        ...(current.sandbox ? { sandbox: current.sandbox } : {}),
        ...(getEffectiveFreshAgentEffort(current, providerDefaults) ? { effort: getEffectiveFreshAgentEffort(current, providerDefaults) } : {}),
      },
    })
  }, [providerDefaults, sendFreshAgentMessage])

  /** Task 10: re-issue a failed send under a fresh requestId with the
   * retained text + route cwd. The retry gets its own pending-metadata entry
   * (same text) so a second failure cleans up through the normal fall-through
   * path, and the visible local echo is re-stamped to the retry's requestId
   * so the retry's eventual acceptance or failure correlates with what is on
   * screen. */
  const resendPendingMessage = useCallback((retryRequestId: string, text: string, cwd: string) => {
    recordPendingSendMetadata(retryRequestId, { text })
    sendFreshAgentSendFrame(retryRequestId, text, cwd)
    const echo = localEchoRef.current
    if (echo && echo.text === text) {
      setLocalEcho({ ...echo, requestId: retryRequestId })
    }
  }, [recordPendingSendMetadata, sendFreshAgentSendFrame, setLocalEcho])

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

  // Re-arm the create effect when EITHER the createRequestId changes (legacy
  // retry paths mint a new id) OR a pane.reconcile verdict folds into this
  // pane (reconcileEpoch bump). Verdict folds PRESERVE createRequestId
  // (council rule 2 — never re-minted), so the epoch is the ONLY signal that
  // a fold needs a fresh create round.
  const createArmKey = `${paneContent.createRequestId}:${paneContent.reconcileEpoch ?? 0}`
  const lastCreateArmKeyRef = useRef(createArmKey)
  if (lastCreateArmKeyRef.current !== createArmKey) {
    lastCreateArmKeyRef.current = createArmKey
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
      sessionRef: effectiveSessionRef(content),
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
    if (command.action === 'model') {
      // Opens the shared model + thinking selector. Commit stages the choice
      // for the next message — nothing in-flight is interrupted or resent.
      setModelDialogOpen(true)
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
      requestSnapshotRefresh('manual')
    } else if (current.status === 'creating' || current.status === 'starting') {
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
  }, [buildCreateMessage, commitSnapshot, dispatch, paneId, refreshRequest, requestSnapshotRefresh, sendFreshAgentMessage, tabId])

  const triggerRecovery = useCallback(() => {
    if (restoreTimeoutRef.current !== null) {
      clearTimeout(restoreTimeoutRef.current)
      restoreTimeoutRef.current = null
    }
    const nextRequestId = nanoid()
    const current = paneContentRef.current
    // Codex threads don't carry Claude's UUID-format durable identity, so they
    // resolve their canonical resume id through the codex-specific helper
    // instead of getCanonicalDurableSessionId/getCanonicalPaneResumeSessionId
    // (both of which gate on isValidClaudeSessionId).
    const canonicalResumeSessionId = current.provider === 'codex'
      ? getCanonicalCodexResumeSessionId(current)
      : getCanonicalDurableSessionId(claudeSession) ?? getCanonicalPaneResumeSessionId(current)
    if (!canonicalResumeSessionId) {
      const hadLegacyRestoreTarget = current.provider === 'codex'
        ? Boolean(current.resumeSessionId)
        : Boolean(getPreferredResumeSessionId(claudeSession) || current.resumeSessionId)
      dispatch(updatePaneContent({
        tabId,
        paneId,
        content: {
          ...current,
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
        ...current,
        sessionId: undefined,
        resumeSessionId: canonicalResumeSessionId,
        sessionRef: { provider: current.provider, sessionId: canonicalResumeSessionId },
        restoreError: undefined,
        createRequestId: nextRequestId,
        status: 'creating',
        createError: undefined,
      },
    }))
  }, [claudeSession, dispatch, paneId, tabId])

  // Capability-gated .lost resolution (paneReconcileFreshAgentV1): a lost
  // session asks the SERVER for the pane's true state via a single-pane
  // reconcile owned by this view (fold-ownership rule: it folds only its own
  // reconcileId) -- the verdict answers attach/respawn/dead instead of the
  // triggerRecovery heuristics. Same pattern as TerminalView's exhaustion
  // reconcile.
  const lostReconcileRef = useRef<PaneReconcileRequest | null>(null)

  const reconcileLostPane = useCallback(() => {
    const request = buildReconcileRequestForPanes(appStore.getState(), [{ tabId, paneId }])
    if (!request) {
      // The pane lost its reconcilable state (no createRequestId) -- fall
      // back to the legacy recovery path instead of wedging silently.
      triggerRecovery()
      return
    }
    lostReconcileRef.current = request
    ws.send(request)
  }, [appStore, paneId, tabId, triggerRecovery, ws])

  // Task 14: SESSION_RESERVED bounded re-drive. A transient reservation (the
  // server's D8 lease loser answer) re-drives the SAME create/attach after a
  // fixed floor; when the window exhausts, a single-pane reconcile resolves
  // the pane automatically (attach verdict -> silent attach to the winner;
  // dead -> the visible dead-session panel/fresh flow). Never create-failed,
  // never an error card, never a re-minted createRequestId.
  const reserveRedriveRef = useRef<{
    windowStart: number | null
    timer: ReturnType<typeof setTimeout> | null
  }>({ windowStart: null, timer: null })

  const clearReserveRedrive = useCallback(() => {
    const state = reserveRedriveRef.current
    state.windowStart = null
    if (state.timer !== null) {
      clearTimeout(state.timer)
      state.timer = null
    }
  }, [])

  useEffect(() => clearReserveRedrive, [clearReserveRedrive]) // unmount

  const redriveAfterSessionReserved = useCallback(() => {
    const state = reserveRedriveRef.current
    if (state.windowStart === null) state.windowStart = Date.now()
    if (Date.now() - state.windowStart >= FRESH_AGENT_RESERVE_RETRY_WINDOW_MS) {
      clearReserveRedrive()
      reconcileLostPane() // Task 10's single-pane reconcile + fold = the auto-resolve
      return
    }
    if (state.timer !== null) return
    state.timer = setTimeout(() => {
      state.timer = null
      const current = paneContentRef.current
      if (current.sessionId) {
        // Attach loser: re-send the attach directly (the attach effect keys on
        // sessionId, which has not changed -- a content nudge cannot re-fire it).
        const cwd = getFreshOpenCodeRouteCwd(current, { sessionCwd: freshOpenCodeRouteCwdRef.current })
        sendFreshAgentMessage(buildFreshAgentAttachMessage(current, cwd))
        return
      }
      createSentRef.current = false // re-arm the create effect
      lastCreateArmKeyRef.current = '' // force the render-phase re-arm
      dispatch(updatePaneContent({ tabId, paneId, content: { ...paneContentRef.current } })) // nudge the effect
    }, FRESH_AGENT_RESERVE_RETRY_FLOOR_MS)
  }, [clearReserveRedrive, dispatch, paneId, reconcileLostPane, sendFreshAgentMessage, tabId])

  useEffect(() => {
    if (paneContent.sessionId) return
    if (paneContent.restoreError) return
    if (
      paneContent.status !== 'creating'
      && paneContent.status !== 'starting'
      && !paneContent.sessionRef
    ) return
    // Pre-verdict create wait: a reconcile-pending pane defers its mount-time
    // create until its verdict folds (the fold's clearReconcilePendingPane
    // re-fires this effect via the reconcilePendingSince dep), bounded by
    // RECONCILE_VERDICT_WAIT_MS wall-clock -- on timeout the pending flag is
    // released and the legacy eager create proceeds (never a silent wedge,
    // same createRequestId, never re-minted). Returns BEFORE createSentRef is
    // consumed and BEFORE the hidden rebind-queue enqueue.
    const pendingSince = reconcilePendingSinceRef.current
    if (pendingSince !== undefined && Date.now() - pendingSince < RECONCILE_VERDICT_WAIT_MS) {
      if (verdictWaitTimerRef.current === null) {
        const paneKey = `${tabId}:${paneId}`
        verdictWaitTimerRef.current = setTimeout(() => {
          verdictWaitTimerRef.current = null
          dispatch(clearReconcilePendingPane({ paneKey }))
        }, RECONCILE_VERDICT_WAIT_MS - (Date.now() - pendingSince))
      }
      return
    }
    if (createSentRef.current) return
    createSentRef.current = true
    const runCreate = (release?: () => void) => {
      if (!isMountedRef.current) {
        // Pane closed while this job sat in the queue: creating the session
        // now would orphan it server-side with no owning pane.
        release?.()
        return
      }
      const current = paneContentRef.current
      if (current.sessionId) {
        release?.()
        return
      }
      registerFreshAgentCreate(dispatch, current.createRequestId, {
        sessionType: current.sessionType,
        provider: current.provider,
        resumeSessionId: current.resumeSessionId,
        sessionRef: current.sessionRef,
        cwd: current.initialCwd,
      })
      if (release) {
        // Free any slot still held by a prior un-acked create before taking
        // ownership of the new one (otherwise the old slot leaks until the
        // queue's 10s backstop).
        releasePendingRebind()
        pendingRebindReleaseRef.current = release
      }
      sendFreshAgentMessage(buildCreateMessage(current))
    }
    if (hiddenRef.current) {
      getRebindQueue().enqueue({
        // requestId in the key: a stale queued job from a superseded/unmounted
        // instance must never dedup-block a newly minted createRequestId.
        key: `freshagent:${paneId}:create:${paneContent.createRequestId}`,
        run: runCreate,
      })
    } else {
      runCreate()
    }
  }, [
    buildCreateMessage,
    dispatch,
    paneId,
    paneContent,
    // reconcilePendingSince: re-run when the pane's pre-verdict wait state
    // changes -- the verdict fold (or the bounded timeout) clears the entry
    // and the deferred mount-create must then proceed.
    reconcilePendingSince,
    releasePendingRebind,
    sendFreshAgentMessage,
    tabId,
  ])

  useEffect(() => {
    if (paneContent.sessionId || !createSentRef.current) return
    if (paneContent.status !== 'creating' && paneContent.status !== 'starting') return
    if (typeof ws.onReconnect !== 'function') return
    return ws.onReconnect(() => {
      const current = paneContentRef.current
      if (current.sessionId) return
      if (current.status !== 'creating' && current.status !== 'starting') return
      const resend = (release?: () => void) => {
        if (!isMountedRef.current) {
          release?.()
          return
        }
        const latest = paneContentRef.current
        if (latest.sessionId) {
          release?.()
          return
        }
        if (release) {
          releasePendingRebind()
          pendingRebindReleaseRef.current = release
        }
        sendFreshAgentMessage(buildCreateMessage(latest))
      }
      if (hiddenRef.current) {
        getRebindQueue().enqueue({ key: `freshagent:${paneId}:create:${current.createRequestId}`, run: resend })
      } else {
        resend()
      }
    })
  }, [
    buildCreateMessage,
    paneId,
    paneContent.sessionId,
    paneContent.status,
    releasePendingRebind,
    sendFreshAgentMessage,
    ws,
  ])

  useEffect(() => {
    if (!paneContent.sessionId) return
    const sendAttach = () => {
      const current = paneContentRef.current
      if (!current.sessionId) return
      const cwd = getFreshOpenCodeRouteCwd(current, { sessionCwd: freshOpenCodeRouteCwdRef.current })
      sendFreshAgentMessage(buildFreshAgentAttachMessage(current, cwd))
    }
    if (hiddenRef.current) {
      // Hidden: cheap session rebind still happens, but paced through the
      // rebind queue so 20 background panes do not stampede the server.
      getRebindQueue().enqueue({
        key: `freshagent:${paneId}:attach`,
        run: (release) => {
          sendAttach()
          // attach has no ack frame -- hold the slot briefly for spacing.
          setTimeout(release, 100)
        },
      })
    } else {
      sendAttach()
    }
  }, [
    freshOpenCodeRouteCwd,
    paneId,
    paneContent.provider,
    paneContent.resumeSessionId,
    paneContent.sessionId,
    paneContent.sessionRef?.provider,
    paneContent.sessionRef?.sessionId,
    paneContent.sessionType,
    sendFreshAgentMessage,
  ])

  useEffect(() => {
    if (!paneContent.sessionId) return
    if (typeof ws.onReconnect !== 'function') return
    return ws.onReconnect(() => {
      const current = paneContentRef.current
      if (!current.sessionId) return
      const sendAttach = () => {
        const latest = paneContentRef.current
        if (!latest.sessionId) return
        const cwd = getFreshOpenCodeRouteCwd(latest, { sessionCwd: freshOpenCodeRouteCwdRef.current })
        sendFreshAgentMessage(buildFreshAgentAttachMessage(latest, cwd))
      }
      if (hiddenRef.current) {
        getRebindQueue().enqueue({
          key: `freshagent:${paneId}:attach`,
          run: (release) => {
            sendAttach()
            setTimeout(release, 100)
          },
        })
        // Surface hydration (HTTP transcript snapshot fetch) is EXPENSIVE --
        // defer it until reveal instead of fetching for every hidden pane.
        pendingRevealRefreshRef.current = true
      } else {
        sendAttach()
        requestSnapshotRefresh('reconnect')
      }
    })
  }, [paneId, paneContent.sessionId, requestSnapshotRefresh, sendFreshAgentMessage, ws])

  // F8: consume the deferred snapshot refresh on reveal.
  useEffect(() => {
    if (hidden) return
    if (!pendingRevealRefreshRef.current) return
    pendingRevealRefreshRef.current = false
    requestSnapshotRefresh('reveal')
  }, [hidden, requestSnapshotRefresh])

  // reconcileNotice is a one-shot: visible for 5s, then consumed from the
  // pane content (a chat pane has no xterm write-notice channel; a timed
  // dismiss keeps it user-visible without persisting -- council rule:
  // `corrected: true` is always user-visible).
  useEffect(() => {
    if (!paneContent.reconcileNotice) return
    const t = setTimeout(() => {
      dispatch(updatePaneContent({ tabId, paneId, content: { ...paneContentRef.current, reconcileNotice: undefined } }))
    }, 5_000)
    return () => clearTimeout(t)
  }, [dispatch, paneContent.reconcileNotice, paneId, tabId])

  useEffect(() => {
    if (typeof ws.onMessage !== 'function') return
    const unsubscribe = ws.onMessage((message) => {
      if (message.type === 'pane.reconcile.result') {
        // Fold-ownership rule (pane-reconcile.ts): fold ONLY the result whose
        // reconcileId this view minted for its .lost reconcile; foreign
        // reconciles (App boot, other panes) are silently skipped.
        const lostRequest = lostReconcileRef.current
        if (lostRequest && message.reconcileId === lostRequest.reconcileId) {
          lostReconcileRef.current = null
          foldVerdicts(dispatch, lostRequest, message)
          // markSessionLost's counterpart: an attach fold where the durable id
          // equals the old sessionId leaves the SAME freshAgent session entry
          // flagged lost=true (the attach-path reducers never clear it), which
          // would re-trigger the .lost driver forever. Neutralize the flag for
          // this pane's current session. Respawn folds are already safe (the
          // reset clears sessionId; the later created ack clears lost), and an
          // extra clear there is a harmless no-op.
          const current = paneContentRef.current
          if (current.sessionId) {
            dispatch(clearSessionLost({
              sessionId: current.sessionId,
              sessionType: current.sessionType,
              provider: current.provider,
            }))
          }
        }
        return
      }
      if (message.type === 'freshAgent.created' && message.requestId === paneContentRef.current.createRequestId) {
        releasePendingRebind()
        clearReserveRedrive() // Task 14: a completed create ends the reservation window
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
            // A19 (fresh-agent leg): a completed create consumes the
            // reconcile intent -- stale respawn/fresh intent must never
            // survive past a created ack.
            pendingReconcile: undefined,
          },
        }))
      }
      if (message.type === 'freshAgent.create.failed' && message.requestId === paneContentRef.current.createRequestId) {
        releasePendingRebind()
        if (message.code === 'SESSION_RESERVED' && message.retryable) {
          // Task 14: transient reservation -- keep status 'creating' (never
          // create-failed) and re-drive the SAME create after the floor.
          redriveAfterSessionReserved()
          return
        }
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
        requestSnapshotRefresh('materialized')
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
        message.type === 'freshAgent.event'
        && message.sessionId === paneContentRef.current.sessionId
        && (message.event as { type?: string; code?: string } | undefined)?.type === 'freshAgent.error'
        && (message.event as { code?: string }).code === 'SESSION_RESERVED'
      ) {
        // Task 14 (attach loser): a transient reservation re-drives the attach
        // after the floor; exhaustion resolves via the single-pane reconcile.
        // The banner is suppressed via lastErrorCode (never surfaced).
        redriveAfterSessionReserved()
        return
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
        requestSnapshotRefresh('send-accepted')
      }
      if (message.type === 'error') {
        // Task 10: owned send failures. `requestId` is the only correlation
        // handle on an error frame, and freshAgent.send is the only
        // fresh-agent path that threads it: frames whose requestId matches a
        // pendingSendMetadataRef entry are this pane's send failures. Frames
        // with no matching requestId are not ours -- leave them alone.
        const failedRequestId = typeof message.requestId === 'string' ? message.requestId : undefined
        if (!failedRequestId || !pendingSendMetadataRef.current.has(failedRequestId)) return
        const current = paneContentRef.current
        if (
          message.code === 'FRESH_AGENT_LOST_SESSION'
          && current.sessionType === 'freshopencode'
          && !lostSessionRetryRef.current.has(failedRequestId)
        ) {
          const pendingMeta = pendingSendMetadataRef.current.get(failedRequestId)
          const cwd = freshOpenCodeRouteCwdRef.current
          const sessionId = current.sessionId
          // The ses_ guard keeps genuinely-invalid placeholder/non-durable
          // lost-session errors on the normal cleanup path below.
          if (pendingMeta?.text && cwd && sessionId && sessionId.startsWith('ses_')) {
            // Re-attach with the route cwd (the incident's no-cwd locator),
            // then resend the retained text exactly once. The original
            // request is consumed here; the retry itself is never retried.
            lostSessionRetryRef.current.add(failedRequestId)
            pendingSendMetadataRef.current.delete(failedRequestId)
            sendFreshAgentMessage({
              type: 'freshAgent.attach',
              sessionId,
              sessionType: 'freshopencode',
              provider: 'opencode',
              cwd,
            })
            const retryRequestId = nanoid()
            lostSessionRetryRef.current.add(retryRequestId)
            resendPendingMessage(retryRequestId, pendingMeta.text, cwd)
            // Do NOT fall through: the echo stays visible while the retry is
            // in flight.
            return
          }
        }
        // Cleanup fall-through: every owned send failure that did not take
        // the retry path (including a retried request failing again) releases
        // the three leaks a failed send otherwise leaves behind -- the
        // pending-metadata entry, the stale local echo (dual-write), and the
        // optimistic `running` status.
        pendingSendMetadataRef.current.delete(failedRequestId)
        if (localEchoRef.current?.requestId === failedRequestId) {
          setLocalEcho(null)
        }
        if (current.provider === 'opencode' && current.status === 'running') {
          dispatch(mergePaneContent({ tabId, paneId, updates: { status: 'idle' } }))
        }
        return
      }
      if (
        isSnapshotInvalidatingFreshAgentEvent(message)
        && locatorMatchesPane(message, paneContentRef.current, freshOpenCodeRouteCwdRef.current)
      ) {
        requestSnapshotRefresh('event')
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
  }, [agentSession?.cwd, clearReserveRedrive, commitSnapshot, dispatch, migratePendingAutoTitle, paneContent, paneContent.createRequestId, paneId, recordPendingSendMetadata, redriveAfterSessionReserved, releasePendingRebind, requestSnapshotRefresh, resendPendingMessage, sendFreshAgentMessage, setLocalEcho, tabId, ws])

  useEffect(() => {
    if (!snapshotThreadId) return
    // agentSession is the provider-agnostic session-meta selector (see above);
    // for claude it's the same entry as claudeSession, so this also covers
    // claude's existing behavior. Skip the snapshot fetch while a resumable
    // provider is lost -- fetching against a dead thread id is a guaranteed
    // 404 and triggerRecovery (below) is what should react to `.lost`.
    if ((paneContent.provider === 'claude' || paneContent.provider === 'codex') && agentSession?.lost) return
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
    // A1: resolve the cwd ONCE (route cwd falls through initialCwd -> session
    // cwd) and use the SAME value for both the scheduler key and the request,
    // so sibling panes whose raw initialCwd diverges ('' vs '/w') still share
    // one key -- keying on raw initialCwd would let the N-pane fan-out survive.
    const requestCwd = freshOpenCodeRouteCwdRef.current ?? paneContentRef.current.initialCwd
    const requestAgentSessionStatusVersion = agentSessionStatusVersionRef.current
    const applySnapshot = (next: FreshAgentSnapshot) => {
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
      const previousSnapshot = snapshotRef.current
      const displaySnapshot = mergeSnapshotForDisplay(previousSnapshot, resolved)
      const snapshotAccepted = displaySnapshot !== previousSnapshot
      commitSnapshot(displaySnapshot)
      setSnapshotAutoTitleIdentity(snapshotIdentity)
      const echo = localEchoRef.current
      const echoPendingMetadata = echo ? pendingSendMetadataRef.current.get(echo.requestId) : undefined
      const landedEcho = echo
        ? localEchoLanded(displaySnapshot.turns, echo, echoPendingMetadata, {
            allowTextMatch: snapshotAccepted,
            previousTurns: previousSnapshot?.turns,
          })
        : false
      // Task 16: 'accepted but not landed' -- the raw input predicate of the
      // stale-echo clear, INDEPENDENT of the retry-exhaustion gate below.
      const echoStillPending = echo
        ? !landedEcho && shouldClearStaleLocalEcho(displaySnapshot, echo, echoPendingMetadata)
        : false
      // The echo is the idle-incomplete re-poll loop's marker: it may only be
      // cleared as STALE once the bounded retry budget is exhausted. A landed
      // echo still clears immediately.
      const staleEcho = echo
        ? snapshotAccepted
          && idleIncompleteRetryCountRef.current >= IDLE_INCOMPLETE_MAX_RETRIES
          && shouldClearStaleLocalEcho(displaySnapshot, echo, echoPendingMetadata)
        : false
      if (echo) {
        if (landedEcho || staleEcho) setLocalEcho(null)
      }
      // Task 16 (zrrj): an idle snapshot that does not yet contain the
      // just-sent turn means the durable transcript is lagging -- schedule a
      // bounded re-poll instead of permanently going quiet.
      if (
        displaySnapshot.status === 'idle'
        && echoStillPending
        && idleIncompleteRetryCountRef.current < IDLE_INCOMPLETE_MAX_RETRIES
      ) {
        idleIncompleteRetryCountRef.current += 1
        if (idleIncompleteRetryTimerRef.current === null) { // dedupe: one pending timer max
          idleIncompleteRetryTimerRef.current = window.setTimeout(() => {
            idleIncompleteRetryTimerRef.current = null
            requestSnapshotRefresh('idle-incomplete')
          }, IDLE_INCOMPLETE_RETRY_DELAY_MS)
        }
      } else if (!echoStillPending) {
        idleIncompleteRetryCountRef.current = 0
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
      const hasBlockingLocalEchoForSession = hasUnresolvedLocalEchoForSessionRef.current
      const sessionStatus = nextStatus === 'create-failed' ? null : nextStatus
      const snapshotIsBusy = sessionStatus === 'running' || sessionStatus === 'compacting'
      const statusChangedSinceRequest = agentSessionStatusVersionRef.current !== requestAgentSessionStatusVersion
      const currentSessionStatus = agentSessionStatusRef.current ?? fresh.status
      const wouldRegressStatus = sessionStatus
        ? isStatusRegression(currentSessionStatus, sessionStatus)
        : false
      const opencodeStatusFromLiveState =
        (next as { extensions?: { opencode?: { statusFromLiveState?: unknown } } })
          .extensions?.opencode?.statusFromLiveState === true
      const canAdoptSnapshotStatus =
        (provider === 'codex' && requestSessionType === 'freshcodex')
        || (provider === 'opencode' && requestSessionType === 'freshopencode'
          // busy (running) may always be adopted; idle (busy-CLEARING) only when
          // live-reconciled -- otherwise the restore-window idle default (untracked
          // or mid-reconcile adapter state) would clear a genuinely running turn.
          && (snapshotIsBusy || opencodeStatusFromLiveState))
      if (
        sessionStatus
        && nextSessionId
        && canAdoptSnapshotStatus
        && !wouldRegressStatus
        && (
          snapshotIsBusy
          || (!hasBlockingLocalEchoForSession && !statusChangedSinceRequest)
        )
      ) {
        dispatch(setSessionStatus({
          sessionId: nextSessionId,
          sessionType: requestSessionType,
          provider,
          status: sessionStatus,
        }))
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
    }
    const handleSnapshotError = (error: unknown) => {
      // AbortError swallow kept as harmless dead armor: scheduler-path
      // fetches carry no signal (A2), so this can no longer fire.
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
    }
    const key = makeSnapshotKey({ sessionType: requestSessionType, provider, threadId: sessionId, cwd: requestCwd })
    const trigger = snapshotRefreshTriggerRef.current
    void getSnapshotScheduler().schedule(key, trigger, () =>
      // NO signal: the run may execute on behalf of other panes sharing the
      // key, or after this effect cleaned up (A2). Staleness is handled by
      // isStaleSnapshotRequest() when the outcome is applied, not by aborting.
      getFreshAgentThreadSnapshot(requestSessionType, provider, sessionId, {
        ...(requestCwd ? { cwd: requestCwd } : {}),
        trigger,
      }),
    ).then((outcome) => {
      if (isStaleSnapshotRequest()) return
      if (outcome.status === 'ok') {
        applySnapshot(outcome.value as FreshAgentSnapshot)
        return
      }
      if (outcome.status === 'rate-limited' || outcome.status === 'backoff') {
        // Keep the last good snapshot visible; no error banner. Re-arm one
        // retry at expiry (dedupe: never arm a second timer alongside one
        // already counting down).
        setRateLimitedUntil(outcome.retryAtMs)
        if (rateLimitRetryTimerRef.current === null) {
          const delay = Math.max(0, outcome.retryAtMs - Date.now())
          rateLimitRetryTimerRef.current = window.setTimeout(() => {
            rateLimitRetryTimerRef.current = null
            setRateLimitedUntil(null)
            requestSnapshotRefresh('manual')
          }, delay + 50)
        }
        return
      }
      if (outcome.status === 'coalesced') return
      handleSnapshotError(outcome.error)
    })
    // Depend only on what identifies *which* snapshot to load. This effect
    // dispatches updatePaneContent to persist its own resolved resumeSessionId/
    // status; listing the whole paneContent object (or those output fields) made
    // that self-update retrigger the effect, firing a redundant second fetch for
    // the same session. Current values for non-identity fields are read live via
    // paneContentRef.current inside the effect.
  }, [
    agentSession?.lost,
    claudeSession,
    isRestoring,
    dispatch,
    paneContent.provider,
    paneContent.createRequestId,
    paneContent.sessionId,
    paneContent.sessionType,
    paneId,
    commitSnapshot,
    migratePendingAutoTitle,
    requestSnapshotRefresh,
    setLocalEcho,
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

  // This is the actual .lost-state recovery/retry reaction. It was originally
  // claude-only (guarded on paneContent.provider === 'claude'), which meant a
  // codex fresh-agent pane that received a lost-session frame (markSessionLost
  // via INVALID_SESSION_ID -- see fresh-agent-ws.ts, which dispatches it for
  // ANY provider, not just claude) permanently sat abandoned: nothing ever
  // called triggerRecovery for it. Codex's server-side resume machinery
  // supports re-attach, so it's extended here. agentSession is the
  // provider-agnostic session selector (identical to claudeSession for
  // claude), so this reuses the exact same bounded shape: give up (handled
  // inside triggerRecovery) when no canonical resume id can be resolved,
  // otherwise attempt exactly once per `.lost` transition -- the effect only
  // re-fires when these dependencies change, so it does not loop.
  // Opencode is deliberately NOT included: it already has its own dedicated
  // lost-thread recovery path (isLostFreshOpencodeThreadError, handled
  // elsewhere in this file) that predates this effect and must not be
  // double-driven.
  useEffect(() => {
    if (paneContent.provider !== 'claude' && paneContent.provider !== 'codex') return
    if (!paneContent.sessionId || !agentSession?.lost) return
    // fresh-eyes F4: the connectionStatus dep also fires on ready->disconnected.
    // Recovery may only act on POST-reconnect evidence -- while offline,
    // triggerRecovery() would clear the pane's session id / mint a create
    // request with no server truth behind it.
    if (connectionStatus !== 'ready') return
    const shouldDeferUntilVisibleRestore = Boolean(
      agentSession.latestTurnId !== undefined && agentSession.historyLoaded === true
    )
    if (shouldDeferUntilVisibleRestore) {
      const sessionIdForRecovery = paneContent.sessionId
      restoreTimeoutRef.current = window.setTimeout(() => {
        restoreTimeoutRef.current = null
        if (paneContentRef.current.sessionId !== sessionIdForRecovery) return
        if (!agentSession?.lost) return
        if (isFreshAgentReconcileActive()) reconcileLostPane()
        else triggerRecovery()
      }, 0)
      return () => {
        if (restoreTimeoutRef.current !== null) {
          clearTimeout(restoreTimeoutRef.current)
          restoreTimeoutRef.current = null
        }
      }
    }
    if (isFreshAgentReconcileActive()) reconcileLostPane()
    else triggerRecovery()
  }, [
    agentSession?.historyLoaded,
    agentSession?.latestTurnId,
    agentSession?.lost,
    connectionStatus,
    paneContent.provider,
    paneContent.sessionId,
    reconcileLostPane,
    triggerRecovery,
  ])

  const effectiveStatus = paneContent.provider === 'claude'
    ? (claudeSessionStatus ?? paneContent.status)
    : (agentSession?.status ?? paneContent.status)
  const isBusy = BUSY_STATES.has(effectiveStatus)
  const sessionEnded = effectiveStatus === 'exited' || effectiveStatus === 'create-failed'
  // Task 14: SESSION_RESERVED is a transient reservation the view re-drives
  // through -- never surfaced as a pane-level error banner.
  const sessionErrorMessage = (agentSession as { lastError?: string; lastErrorCode?: string } | undefined)?.lastErrorCode === 'SESSION_RESERVED'
    ? null
    : (agentSession as { lastError?: string } | undefined)?.lastError ?? null
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
      requestSnapshotRefresh('poll')
    }, 3000)
    return () => window.clearInterval(timer)
  }, [effectiveStatus, hidden, isBusy, paneContent.sessionId, requestSnapshotRefresh])

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
    // Task 16: a new send starts a fresh idle-incomplete re-poll budget.
    idleIncompleteRetryCountRef.current = 0
    const routeCwd = getFreshOpenCodeRouteCwd(current, { sessionCwd: freshOpenCodeRouteCwdRef.current })
    // Retain the exact outgoing text as the resend payload (Task 10): the
    // lost-session retry resends from this metadata, never from the echo.
    recordPendingSendMetadata(requestId, { text })
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
    sendFreshAgentSendFrame(requestId, text, routeCwd)
    setLocalEchoState(nextLocalEcho)
    dispatch(mergePaneContent({
      tabId,
      paneId,
      updates: {
        ...(current.provider === 'opencode' ? { status: 'running' } : {}),
        pendingLocalEcho: nextLocalEcho,
      },
    }))
  }, [dispatch, paneId, recordPendingSendMetadata, sendFreshAgentSendFrame, snapshotConfirmsNoUserTurns, tabId])

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
          // A defined updatedInput (even {}) wholesale REPLACES the tool input server-side
          // (sdk-bridge resolves the decision verbatim). Omit the key entirely.
          decision: { behavior: 'allow' },
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
          ? { behavior: 'allow' }
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
              {paneContent.reconcileNotice ? (
                <div role="status" className="px-3 py-1 text-xs text-amber-600 dark:text-amber-400">
                  {paneContent.reconcileNotice}
                </div>
              ) : null}
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
            <FreshAgentModelDialog
              tabId={tabId}
              paneId={paneId}
              paneContent={paneContent}
              open={modelDialogOpen}
              onClose={closeModelDialog}
              onCatalogUnavailable={handleModelCatalogUnavailable}
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
    modelDialogOpen,
    closeModelDialog,
    handleModelCatalogUnavailable,
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
