import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import { nanoid } from 'nanoid'
import type { FreshAgentPaneContent } from '@/store/paneTypes'
import type { PaneReconcileRequest } from '@shared/ws-protocol'
import { useAppDispatch, useAppSelector, useAppStore } from '@/store/hooks'
import type { AppStore } from '@/store/store'
import { usePaneFocusAdoption } from '@/hooks/usePaneFocusAdoption'
import { getWsClient, RECONCILE_VERDICT_WAIT_MS } from '@/lib/ws-client'
import { sendSuppressedAwareFreshAgentFrame } from '@/lib/fresh-agent-configure'
import { KILL_ACK_TIMEOUT_MESSAGE, KILL_FAILED_MESSAGE, sendFreshAgentKillAndAwait } from '@/lib/kill-ack'
import { createLogger } from '@/lib/client-logger'
import { api, getFreshAgentModelCapabilities, getFreshAgentThreadSnapshot, setSessionMetadata } from '@/lib/api'
import { clearReconcilePendingPane, consumePaneRefreshRequest, mergePaneContent, updatePaneContent } from '@/store/panesSlice'
import { FRESH_AGENT_MODEL_CATALOG_UNAVAILABLE_NOTICE } from '@/lib/fresh-agent-model-capabilities'
import { clearPendingCreateFailure, clearRestoreFailure, clearSessionError, clearSessionLost, sessionError, setSessionStatus } from '@/store/freshAgentSlice'
import { openSessionTab } from '@/store/tabsSlice'
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
import { Loader2 } from 'lucide-react'
import { collectPaneEntries, paneRefreshTargetMatchesContent } from '@/lib/pane-utils'
import { getCanonicalDurableSessionId, getPreferredResumeSessionId } from '@/store/persistControl'
import { isValidClaudeSessionId } from '@/lib/claude-session-id'
import {
  canonicalPaneSession,
  derivePaneOwnerDivergence,
  isLifecycleStartSuperseded,
  resolveCanonicalPaneSession,
  selectPaneOwnerFence,
  selectSessionRuntimeOwner,
  type ObservedOwnerFence,
} from '@/store/selectors/runtimeOwner'
import type { RuntimeOwnerRecord } from '@/store/freshAgentTypes'
import { makeFreshAgentSessionKey } from '@shared/fresh-agent'
import type { FreshAgentSnapshot } from '@shared/fresh-agent-contract'
import {
  freshAgentSnapshotHasUserTurn,
  freshAgentTurnText,
  getFreshAgentDisplayTurnKey,
} from '@shared/fresh-agent-turns'
import {
  buildFreshAgentSlashCommandMenu,
  getFreshAgentSlashCommands,
  type FreshAgentSlashCommand,
} from '@shared/fresh-agent-slash-commands'
import { FRESH_AGENT_MODEL_OPTIONS_BY_SESSION_TYPE } from '@shared/fresh-agent-models'
import {
  asRollbackAck,
  buildRollbackFrame,
  gateRollbackCommand,
  isRollbackErrorEvent,
  REDO_CODEX_UNSUPPORTED_NOTICE,
  REDO_DESTROYED_NOTICE,
  ROLLBACK_BUSY_REDO_NOTICE,
  ROLLBACK_BUSY_UNDO_NOTICE,
  UNDO_REFILL_NOTICE,
  rollbackUnsupportedNotice,
} from '@/lib/fresh-agent-rollback'
import { registerFreshAgentPaneActions } from '@/lib/pane-action-registry'
import { buildTerminalAttachContent } from '@/lib/session-type-utils'
import { FencedOwnerRecoveryActions, SessionHandoffErrorBanner } from '@/components/SessionHandoffErrorBanner'
import {
  freshAgentContextSessionId,
  guardContextUsageTokenSummary,
} from '@/lib/fresh-agent-context-usage'
import { refreshActiveSessionWindow } from '@/store/sessionsThunks'
import FreshAgentModelDialog from '@/components/fresh-agent/FreshAgentModelDialog'
import { buildRestoreError, type RestoreErrorReason } from '@shared/session-contract'
import { isDurableProviderSessionId } from '@shared/session-flavor'
import {
  getCanonicalPaneResumeSessionId,
  getFreshAgentSnapshotThreadId,
} from '@/lib/fresh-agent-snapshot-thread'
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
import { FreshAgentOpenSessionContext } from './FreshAgentItemCard'
import FreshAgentQuestionBanner from './FreshAgentQuestionBanner'
import { FreshAgentTranscript, type FreshAgentTranscriptHandle } from './FreshAgentTranscript'
import { FreshAgentComposer, type FreshAgentComposerHandle } from './FreshAgentComposer'
import { FreshAgentDiffPanel } from './FreshAgentDiffPanel'
import { FreshAgentSidebar } from './FreshAgentSidebar'
import { FreshAgentStatusStrip } from './FreshAgentStatusStrip'

const EARLY_STATES = new Set(['creating', 'starting'])
const BUSY_STATES = new Set(['running', 'compacting'])
// Copy for the stuck-notice card (role="alert") shown while the store carries
// the deadman's 'stuck' status; recovery actions live on the card itself.
const FRESH_AGENT_STUCK_NOTICE_TEXT = 'Agent appears stuck — no events from the agent process for a while.'

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
  // kata 1wxv: rollback converges through the invalidating snapshot — the marker
  // bucket, the active prefix, and rollback{canRedo,undoneDepth} all ride it.
  'freshAgent.session.rolledBack',
  'freshAgent.session.redone',
  'freshAgent.rolledBack', // the requesting pane's ack also refetches
  'freshAgent.redone',
])
// These events mean the durable transcript may have changed. Status, approval,
// and question events are deliberately excluded: they update the surrounding
// pane UI, but do not make an already-rendered transcript stale. That keeps a
// hidden pane immediately usable when its last transcript snapshot is still
// current.
export const TRANSCRIPT_INVALIDATING_FRESH_AGENT_EVENTS = new Set([
  'freshAgent.session.changed',
  'freshAgent.result',
  'freshAgent.turn.complete',
  'freshAgent.error',
  'freshAgent.assistant',
  'freshAgent.stream',
  'freshAgent.session.rolledBack',
  'freshAgent.session.redone',
  'freshAgent.rolledBack',
  'freshAgent.redone',
])
const REVEAL_REFRESH_MAX_WAIT_MS = 15_000
const log = createLogger('FreshAgentView')
// Context usage validity window for the strip meter: at 60s the strip triggers
// a background refresh (never a blank-out of an accurate idle reading); if no
// re-stamp arrives within a further 30s grace the strip falls to "context —".
const CONTEXT_USAGE_VALID_MS = 60_000
const CONTEXT_USAGE_GRACE_MS = 30_000

function getSnapshotIdentity(snapshot: FreshAgentSnapshot): string | null {
  if (!snapshot.sessionType || !snapshot.provider || !snapshot.threadId) return null
  return `${snapshot.sessionType}:${snapshot.provider}:${snapshot.threadId}`
}

function getTurnKey(turn: FreshAgentTurn): string {
  return getFreshAgentDisplayTurnKey(turn)
}

/**
 * Bidirectional text match between the local echo (raw user input) and the
 * server-normalised turn text. The server may add content (system context,
 * metadata) or remove content (strip quoting, trim whitespace), so we check
 * both directions: the turn text contains the echo text, or the echo text
 * contains the turn text.
 */
function echoTextMatchesTurn(echoText: string, needle: string, turnText: string): boolean {
  if (turnText.includes(needle)) return true
  const trimmedTurnText = turnText.trim()
  return trimmedTurnText.length > 0 && echoText.includes(trimmedTurnText)
}

type LocalEcho = {
  text: string
  requestId: string
  submittedTurnId?: string
  /** Turn keys captured at send time — used by the echo-landed check to
   * distinguish the new server turn from pre-existing turns. Unlike the
   * previous-snapshot turns, these never include the just-sent turn, so
   * the text-match guard cannot permanently block the echo from clearing
   * if the first snapshot's text match fails (e.g. the server normalises
   * the text by stripping quoting). */
  previousTurnKeys?: readonly string[]
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
    previousTurnKeys?: Set<string> | null
  } = {},
): boolean {
  const needle = echo.text.slice(0, 80)
  const submittedTurnId = echo.submittedTurnId ?? pending?.submittedTurnId
  const previousTurnKeys = options.previousTurnKeys ?? null
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
        && echoTextMatchesTurn(echo.text, needle, freshAgentTurnText(turn))
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

// Codex fresh-agent threads don't have a UUID-format validator the way Claude
// does (isValidClaudeSessionId), so this mirrors getCanonicalPaneResumeSessionId's
// fallback chain (sessionRef -> resumeSessionId -> sessionId) without that
// claude-specific format check. Used only to let a lost codex session attempt
// a bounded resume instead of being permanently abandoned (see triggerRecovery).
// (getCanonicalPaneResumeSessionId and getFreshAgentSnapshotThreadId live in
// @/lib/fresh-agent-snapshot-thread — shared with the settings popover's
// settingScopes probe.)
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

type AttachmentAttempt = {
  key: string
  content: FreshAgentPaneContent
  fence: ObservedOwnerFence | undefined
}

function attachmentAttemptKey(
  state: ReturnType<AppStore['getState']>,
  content: FreshAgentPaneContent,
  decisionSerial: number,
): string {
  const canonical = resolveCanonicalPaneSession(state, content)
  return JSON.stringify([
    canonical?.provider ?? content.provider,
    content.sessionType,
    canonical?.sessionId ?? content.sessionRef?.sessionId ?? content.sessionId ?? null,
    content.createRequestId,
    content.reconcileEpoch ?? 0,
    state.connection.bootId ?? null,
    decisionSerial,
  ])
}

function captureAttachmentAttempt(
  state: ReturnType<AppStore['getState']>,
  content: FreshAgentPaneContent,
  previous: AttachmentAttempt | null,
  decisionSerial: number,
): AttachmentAttempt {
  const key = attachmentAttemptKey(state, content, decisionSerial)
  if (previous?.key === key && previous.fence) return previous
  return { key, content, fence: selectPaneOwnerFence(state, content) }
}

function buildFreshAgentAttachMessage(
  content: FreshAgentPaneContent,
  cwd?: string,
  observedFence?: ObservedOwnerFence,
) {
  const sessionRef = effectiveSessionRef(content)
  return {
    type: 'freshAgent.attach',
    sessionId: content.sessionId,
    sessionType: content.sessionType,
    provider: content.provider,
    ...(sessionRef ? { sessionRef } : {}),
    ...(cwd ? { cwd } : {}),
    ...(observedFence
      ? { observedEpoch: observedFence.epoch, observedGeneration: observedFence.generation }
      : {}),
  } as const
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

function isTranscriptInvalidatingFreshAgentEvent(message: Record<string, unknown>): boolean {
  if (message.type !== 'freshAgent.event') return false
  const eventType = readMessageEventType(message)
  if (eventType === 'freshAgent.session.snapshot') {
    const event = isRecord(message.event) ? message.event : undefined
    return typeof event?.status === 'string' && BUSY_STATES.has(event.status)
  }
  return Boolean(eventType && TRANSCRIPT_INVALIDATING_FRESH_AGENT_EVENTS.has(eventType))
}

/**
 * b8ke ext F1: exported for the alias-convergence unit tests (the pure
 * pane-locator predicate).
 */
export function locatorMatchesPane(
  message: Record<string, unknown>,
  content: FreshAgentPaneContent,
  knownCwd?: string,
  runtimeOwners?: Record<string, RuntimeOwnerRecord>,
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
    // b8ke ext F1: the pane's RESOLVED canonical key is valid too — a
    // pane holding the pre-rekey id accepts canonical-session events
    // (pre-ext an old-key pane rejected them and never converged).
    if (runtimeOwners) {
      const canonical = canonicalPaneSession(content, runtimeOwners)
      if (canonical) validSessionIds.add(canonical.sessionId)
    }
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
  focusEpoch = 0,
}: {
  tabId: string
  paneId: string
  paneContent: FreshAgentPaneContent
  hidden?: boolean
  /** Focus-nudge epoch: explicit same-target selects bump this so the focus
   *  effect re-runs even without an eligibility transition. */
  focusEpoch?: number
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
  const globalExpandThinking = useAppSelector(
    (state) => state.settings.settings.freshAgent?.expandThinking
      ?? false,
  )
  const globalExpandTools = useAppSelector(
    (state) => state.settings.settings.freshAgent?.expandTools
      ?? false,
  )
  const globalShowTimecodes = useAppSelector(
    (state) => state.settings.settings.freshAgent?.showTimecodes
      ?? false,
  )
  const effectiveShowTimecodes = paneContent.showTimecodes ?? globalShowTimecodes
  const showTranscriptMinimap = useAppSelector(
    (state) => state.settings.settings.freshAgent?.showTranscriptMinimap
      ?? true,
  )
  const activeStyle = normalizeFreshAgentStyle(
    paneContent.style ?? providerDefaults?.style ?? DEFAULT_FRESH_AGENT_STYLE,
  )
  const pendingCreateFailure = useAppSelector(
    (state) => state.freshAgent?.pendingCreateFailures?.[paneContent.createRequestId],
  )
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
  // Status-strip context meter source: the unified usage map stamped by
  // committed sidebar refreshes (fresh rows + out-of-band extras). Deliberately
  // NOT the fresh-agent snapshot tokenUsage — that channel never carries
  // compactPercent on any provider, so reading it would be a silent
  // "always unknown" bug. (The session-directory channel itself carries
  // complete opencode usage too — see
  // docs/plans/2026-09-14-freshopencode-context-meter.md.)
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
  // The LIVE session cwd (snapshot-fed): the `!command` exec escape's
  // fallback when the pane carries no `initialCwd` (resumed/API-created
  // panes), so a shell command runs in the session's working directory —
  // never silently in the user's home.
  const agentSessionCwdRef = useRef(agentSession?.cwd)
  agentSessionCwdRef.current = agentSession?.cwd
  const refreshRequest = useAppSelector((state) => state.panes.refreshRequestsByPane?.[tabId]?.[paneId] ?? null)
  const activeTabId = useAppSelector((state) => state.tabs.activeTabId)
  const activePaneId = useAppSelector((state) => state.panes.activePane[tabId])
  // Reconnect authority for the .lost recovery driver below: App flips
  // connection.status away from 'ready' on every stale-socket abandon and back
  // to 'ready' after handshake, so a dep flip re-runs the driver on a fresh
  // reconnect even when every other dep is unchanged.
  const connectionStatus = useAppSelector((s) => s.connection.status)
  const connectionBootId = useAppSelector((s) => s.connection.bootId)
  // kata b8ke: the pane's canonical session's runtime-owner record. Subscribe
  // to the RECORD (a stable store reference) and derive the divergence
  // locally — a derived object inside the selector would re-render on every
  // store notification. Null divergence = same-mode multi-device attachment
  // (or no owner known) — the pane keeps operating exactly as before.
  // b8ke ext F1: the store's runtime-owners map for the pure
  // locatorMatchesPane predicate (the pane-identity resolution consumes
  // the stored rekey alias chain).
  const runtimeOwnersForLocator = useCallback(
    (): Record<string, RuntimeOwnerRecord> => appStore.getState().freshAgent?.runtimeOwners ?? {},
    [appStore],
  )

  const runtimeOwner = useAppSelector((state) => {
    // b8ke ext F1: the pane's identity resolves through the stored rekey
    // alias chain to the CANONICAL key — an old-key pane observes the
    // canonical record (never the same-kind mirror), so the divergence
    // card (the "opened as CLI elsewhere"/attach flow) renders and the
    // pane converges.
    const canonical = resolveCanonicalPaneSession(state, paneContent)
    return canonical ? selectSessionRuntimeOwner(state, canonical.provider, canonical.sessionId) : undefined
  })
  const ownerDivergence = derivePaneOwnerDivergence(runtimeOwner, 'fresh-agent')
  const ownerDivergenceRef = useRef(ownerDivergence)
  ownerDivergenceRef.current = ownerDivergence
  const isActivePane = !hidden && activeTabId === tabId && activePaneId === paneId
  // Mount-time focus adoption gate (agent focus neutrality): an eligible
  // REMOUNT only re-focuses if this pane owned DOM focus before teardown — an
  // agent-driven split while the user is in app chrome must not yank it back.
  // Eligibility flips and focus-epoch bumps (explicit selects) bypass.
  const mayFocusNow = usePaneFocusAdoption(paneId, isActivePane, focusEpoch)
  const [snapshot, setSnapshot] = useState<FreshAgentSnapshot | null>(null)
  const snapshotRef = useRef<FreshAgentSnapshot | null>(null)
  const commitSnapshot = useCallback((next: FreshAgentSnapshot | null) => {
    snapshotRef.current = next
    setSnapshot(next)
  }, [])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [snapshotRefreshNonce, setSnapshotRefreshNonce] = useState(0)
  const snapshotRefreshTriggerRef = useRef<SnapshotTrigger>('identity')
  // A hidden pane keeps its last good transcript until a transcript-changing
  // event says that it is no longer current. On reveal, the old DOM remains
  // mounted but is concealed behind a refresh state so the user never reads a
  // stale conversation as if it were current.
  const [snapshotDirty, setSnapshotDirty] = useState(false)
  const snapshotDirtyRef = useRef(false)
  const snapshotDirtyVersionRef = useRef(0)
  const snapshotDirtyBaseRevisionRef = useRef<number | null>(null)
  const revealRefreshVersionRef = useRef<number | null>(null)
  const revealRefreshStartedAtRef = useRef<number | null>(null)
  const revealRefreshRetryTimerRef = useRef<number | null>(null)
  const snapshotRefreshSerialRef = useRef(0)
  const [snapshotRevealError, setSnapshotRevealError] = useState<string | null>(null)
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
  // Reserve a turn synchronously: the provider's running event may arrive
  // after another submit. Only completion (or failure) releases the reservation.
  const outgoingTurnRef = useRef<(LocalEcho & {
    sawBusy: boolean
    previousTurns: readonly FreshAgentTurn[]
  }) | null>(null)
  const [outgoingTurnVersion, refreshOutgoingTurn] = useReducer((value: number) => value + 1, 0)
  // Transient, self-clearing banner for action feedback (rewind, shell errors).
  const [notice, setNotice] = useState<string | null>(null)
  const [modelDialogOpen, setModelDialogOpen] = useState(false)
  const closeModelDialog = useCallback(() => setModelDialogOpen(false), [])
  const openModelDialog = useCallback(() => setModelDialogOpen(true), [])
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
  // Status-strip model display: the chip mirrors the LIVE session model when
  // the runtime reports one, else the staged/effective pane model. Label
  // resolution maps the id through the static table by exact match only —
  // never the default-substituting resolveFreshAgentModelOption helper: a
  // catalog-only id renders NO label until the probe or pick-time stamp
  // resolves a real display name (raw ids are tooltip-only) and never
  // masquerades as the default.
  // The displayed model is the LIVE session's — reported via the runtime
  // session record (init), the REST snapshot's settings.model (Node adapters
  // report it), and only then the staged/effective pane model. Restored,
  // REST-created, and MCP panes can lack the init model while a snapshot with
  // the active model is already loaded.
  const stripModelId = agentSession?.model
    ?? snapshot?.settings?.model
    ?? resolveEffectiveFreshAgentModel(paneContent, providerDefaults)
  const stripStaticModelLabel = FRESH_AGENT_MODEL_OPTIONS_BY_SESSION_TYPE[paneContent.sessionType]
    ?.find((option) => option.value === stripModelId)?.label
  // Paired with the model id the probe resolved: a live-model switch leaves
  // the previous model's probed label in state until the effect re-runs; only
  // the id-paired label may render (no stale-label frame, no raw id).
  const [stripProbedModelPair, setStripProbedModelPair] = useState<{ modelId: string; label: string } | null>(null)
  // Catalog display-name upgrade: freshopencode's static table is empty
  // ("live catalog only"), and freshclaude/kilroy users can now pick
  // catalog-only models in the shared dialog — without this probe both would
  // permanently render raw ids on the chip ("raw id is tooltip-only" is the
  // contract). Same endpoint the settings popover calls (5-min server cache +
  // in-flight dedupe). Re-probes when the active model changes; the raw id
  // renders immediately and survives a catalog failure — never blank, never
  // "Loading". Cancelled-flag guard matches the sibling probe effects
  // (FreshAgentModelDialog/FreshAgentSettingsButton).
  // Id-paired pick-time stamp from the dialog/popover: authoritative for
  // catalog-only ids — the chip shows the picked label immediately, with no
  // probe window and no raw-id flash, and survives probe failure.
  const stripStampedModelLabel = paneContent.modelLabel != null && paneContent.modelLabel.modelId === stripModelId
    ? paneContent.modelLabel.label
    : undefined
  const stripProbeSessionType = paneContent.sessionType === 'freshopencode'
    || paneContent.sessionType === 'freshclaude'
    || paneContent.sessionType === 'kilroy'
    ? paneContent.sessionType
    : null
  useEffect(() => {
    setStripProbedModelPair(null)
    if (!stripProbeSessionType || !stripModelId || stripStaticModelLabel || stripStampedModelLabel) return
    let cancelled = false
    void getFreshAgentModelCapabilities(stripProbeSessionType, { cwd: paneContent.initialCwd })
      .then((result) => {
        if (cancelled) return
        const probed = result.ok
          ? result.models.find((model) => model.id === stripModelId)?.displayName ?? null
          : null
        // A displayName echoing the raw id is not a display name (e.g.
        // opencode's no-name fallback) — the chip would render a raw id,
        // which is tooltip-only by contract.
        setStripProbedModelPair(probed && probed !== stripModelId ? { modelId: stripModelId, label: probed } : null)
      })
      .catch(() => {
        if (!cancelled) setStripProbedModelPair(null)
      })
    return () => { cancelled = true }
  }, [stripProbeSessionType, paneContent.initialCwd, stripModelId, stripStaticModelLabel, stripStampedModelLabel])
  const stripProbedModelLabel = stripProbedModelPair && stripProbedModelPair.modelId === stripModelId
    ? stripProbedModelPair.label
    : undefined
  // The chip NEVER renders a raw model id (user directive, review-loop round
  // delta-1/focused-ep1: raw ids are tooltip-only). The chip exists ONLY once a
  // display name resolves through the required chain (static table → pick-time
  // stamp → catalog probe). A pane with NO model set at all gets no chip
  // either — the pane-type label is not a model display name, and model
  // selection stays reachable from the settings gear and /model.
  const stripModelLabel = stripModelId
    ? (stripStaticModelLabel ?? stripStampedModelLabel ?? stripProbedModelLabel)
    : null
  // ≤520px collapse favors the short form: drop a trailing "(1M context)"-style
  // parenthetical (raw ids carry none and pass through unchanged).
  const stripModelLabelShort = stripModelLabel?.replace(/\s*\([^)]*\)\s*$/, '') || stripModelLabel
  // Tooltip carries the live session's effort when the runtime reports one:
  // the session-metadata event's fold first (fresher than any REST snapshot by
  // construction — it lands the instant a configure/turn changes the live
  // pair, with null meaning an explicit clear), else the REST snapshot's
  // settings.effort, else the effort the pane was created/resumed with — the
  // tooltip words the SESSION's effort; the model id it labels is the live one.
  const stripEffort = agentSession?.effort !== undefined
    ? agentSession.effort
    : snapshot?.settings?.effort ?? getEffectiveFreshAgentEffort(paneContent, providerDefaults)
  const stripModelTooltip = !stripModelId
    ? 'model not set'
    : `${stripModelId} · effort ${stripEffort ?? 'Default'}`
  const contextSessionId = freshAgentContextSessionId(paneContent, agentSession)
  const [usageTick, forceUsageTick] = useReducer((tick: number) => tick + 1, 0)
  const usageRefreshDispatchedRef = useRef(false)
  // STATUS-STRIP: one unified, timestamped usage map (state.sessions.contextUsageByKey).
  // A reading stays live for 60s after its last stamp. At the boundary the strip
  // triggers a background revalidation (extras + fresh rows re-stamp it) rather
  // than blanking an accurate idle reading; if no re-stamp lands within a 30s
  // grace, the strip drops to "context —". So nothing rides stale AND right-now
  // idle sessions never go blank. Merge/retained rows never write, so the value
  // can never regress; server-side usage-stop evicts immediately.
  const usageEntry = useAppSelector((state) => (
    contextSessionId
      ? state.sessions?.contextUsageByKey?.[`${paneContent.provider}:${contextSessionId}`]
      : undefined
  ))
  const usageValid = Boolean(
    usageEntry && (
      Date.now() - usageEntry.fetchedAt < CONTEXT_USAGE_VALID_MS
      || (usageRefreshDispatchedRef.current && Date.now() - usageEntry.fetchedAt < CONTEXT_USAGE_VALID_MS + CONTEXT_USAGE_GRACE_MS)
    ),
  )
  const contextUsage = useMemo(
    () => (usageEntry && usageValid ? guardContextUsageTokenSummary(usageEntry.tokenUsage) : null),
    // usageTick forces the boundary re-evaluation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [usageEntry, usageValid, usageTick],
  )
  useEffect(() => {
    if (!usageEntry || !contextUsage) {
      usageRefreshDispatchedRef.current = false
      return
    }
    const boundaryMs = usageEntry.fetchedAt + (usageRefreshDispatchedRef.current
      ? CONTEXT_USAGE_VALID_MS + CONTEXT_USAGE_GRACE_MS
      : CONTEXT_USAGE_VALID_MS)
    const timer = window.setTimeout(() => {
      if (!usageRefreshDispatchedRef.current) {
        usageRefreshDispatchedRef.current = true
        // The boundary revalidation is best-effort: a rejected thunk (partial
        // store shape in tests, transient network failure) must never surface
        // as an unhandled rejection from this timer.
        const revalidation = dispatch(refreshActiveSessionWindow() as any)
        if (revalidation && typeof (revalidation as Promise<unknown>)?.catch === 'function') {
          ;(revalidation as Promise<unknown>).catch(() => {})
        }
      }
      forceUsageTick()
    }, Math.max(boundaryMs - Date.now(), 0))
    return () => window.clearTimeout(timer)
  }, [usageEntry, contextUsage, dispatch])
  // A new stamp resets the revalidation arm (data arrived before the boundary).
  useEffect(() => {
    usageRefreshDispatchedRef.current = false
  }, [usageEntry])
  // Capability-gated commands (e.g. /fork) only appear once the snapshot
  // confirms the provider supports the action. Provider-advertised session
  // commands from the same snapshot merge in under their own group; they
  // select-to-insert, never auto-send.
  const slashCommands = useMemo(() => {
    const actions = getFreshAgentSlashCommands(paneContent.sessionType).filter((command) => (
      command.requiresCapability
        ? snapshot?.capabilities?.[command.requiresCapability] === true
        : true
    ))
    return buildFreshAgentSlashCommandMenu(actions, snapshot?.commands)
  }, [paneContent.sessionType, snapshot?.capabilities, snapshot?.commands])
  const paneContentRef = useRef(paneContent)
  const composerRef = useRef<FreshAgentComposerHandle | null>(null)
  const transcriptRef = useRef<FreshAgentTranscriptHandle | null>(null)
  const paneRootRef = useRef<HTMLDivElement | null>(null)
  paneContentRef.current = paneContent
  const setLocalEcho = useCallback((next: LocalEcho | null) => {
    setLocalEchoState(next)
    const current = paneContentRef.current
    // Strip runtime-only fields (previousTurnKeys) before persisting —
    // the persisted echo only needs the wire-identity fields. On remount
    // the echo is restored without previousTurnKeys, which correctly
    // disables the text-match guard (no send-time turns to compare against).
    const persisted = next
      ? { requestId: next.requestId, text: next.text, ...(next.submittedTurnId ? { submittedTurnId: next.submittedTurnId } : {}) }
      : undefined
    if (sameLocalEcho(current.pendingLocalEcho, persisted)) return
    dispatch(mergePaneContent({
      tabId,
      paneId,
      updates: { pendingLocalEcho: persisted },
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
  // b8ke ext r35 F2: the PER-REQUEST create fence capture — the observed
  // (epoch, generation) pair the create request FIRST observed, REUSED by
  // every automatic re-send of the SAME createRequestId (the retryable
  // SESSION_RESERVED redrive's effect re-arm, the reconnect resend, the
  // hidden rebind-queue execution). An automatic retry must never
  // substitute a current fence for the original observation (pre-r35 the
  // redrive re-armed the create effect, which re-captured the LATEST
  // record — so a queued create whose original pair was superseded by
  // another device's start/stop cycle was presented as current and could
  // resume the Fresh Agent runtime without a new user lifecycle decision,
  // defeating the server-side stale-generation safety net). The ORIGINAL
  // pair flows either way honestly: still current → the retry proceeds;
  // stale → the r28 vacant-generation-advanced suppression holds it
  // (the earlier observation IS preserved now) or the server refuses it
  // typed. A NEW createRequestId (a genuinely new create decision)
  // captures fresh.
  const createFenceRef = useRef<{
    createRequestId: string
    reconcileEpoch: number
    fence: ObservedOwnerFence | undefined
  } | null>(null)
  // F3: an attach fence belongs to one immutable attachment decision. The
  // key changes for a new durable identity, create round, server boot, or
  // explicit recovery decision; queued/timer retries keep the same attempt.
  const attachmentAttemptRef = useRef<AttachmentAttempt | null>(null)
  const attachDecisionSerialRef = useRef(0)
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
  const snapshotHydrationIdentity = `${paneContent.createRequestId}:${paneContent.sessionType}:${paneContent.provider}:${snapshotThreadId ?? ''}`
  const previousSnapshotHydrationIdentityRef = useRef(snapshotHydrationIdentity)
  useEffect(() => {
    if (previousSnapshotHydrationIdentityRef.current === snapshotHydrationIdentity) return
    previousSnapshotHydrationIdentityRef.current = snapshotHydrationIdentity
    snapshotDirtyRef.current = false
    snapshotDirtyVersionRef.current += 1
    snapshotDirtyBaseRevisionRef.current = null
    revealRefreshVersionRef.current = null
    revealRefreshStartedAtRef.current = null
    if (revealRefreshRetryTimerRef.current !== null) {
      clearTimeout(revealRefreshRetryTimerRef.current)
      revealRefreshRetryTimerRef.current = null
    }
    setSnapshotDirty(false)
    setSnapshotRevealError(null)
  }, [snapshotHydrationIdentity])
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
    // The shared suppression-aware send seam (fresh-agent-configure.ts): a
    // suppressed frame goes to the e2e harness's sent-message spy, never the
    // wire — identical to every other freshAgent.* frame this view sends.
    sendSuppressedAwareFreshAgentFrame(paneId, message)
  }, [paneId])

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
      if (revealRefreshRetryTimerRef.current !== null) {
        clearTimeout(revealRefreshRetryTimerRef.current)
        revealRefreshRetryTimerRef.current = null
      }
    }
  }, [releasePendingRebind])

  // Single trigger-tagged refresh path: every refresh site tags WHY it wants
  // a snapshot, and the fetch effect hands that trigger to the shared per-key
  // scheduler (debounce/coalesce now live there, not in this component).
  const requestSnapshotRefresh = useCallback((trigger: SnapshotTrigger) => {
    snapshotRefreshTriggerRef.current = trigger
    snapshotRefreshSerialRef.current += 1
    setSnapshotRefreshNonce((value) => value + 1)
  }, [])

  const markSnapshotDirty = useCallback(() => {
    if (!snapshotDirtyRef.current) {
      const revision = snapshotRef.current?.revision
      snapshotDirtyBaseRevisionRef.current = typeof revision === 'number' ? revision : null
    }
    snapshotDirtyVersionRef.current += 1
    snapshotDirtyRef.current = true
    setSnapshotDirty(true)
    setSnapshotRevealError(null)
  }, [])

  const requestRevealRefresh = useCallback((force = false) => {
    if (hiddenRef.current || !snapshotDirtyRef.current) return
    const version = snapshotDirtyVersionRef.current
    if (!force && revealRefreshVersionRef.current === version) return
    revealRefreshVersionRef.current = version
    if (revealRefreshStartedAtRef.current === null) revealRefreshStartedAtRef.current = Date.now()
    setSnapshotRevealError(null)
    requestSnapshotRefresh('reveal')
  }, [requestSnapshotRefresh])

  // kata b8ke (round-3 F6): the ONE fenced attach sender — every
  // freshAgent.attach producer (mount rebind, reconnect re-attach,
  // SESSION_RESERVED redrive, pane-refresh reaction, lost-session retry)
  // goes through this. Attach is a lifecycle start (it can cold-resume an
  // untracked session): suppressed while the canonical session diverges
  // (owned by the other kind — the pane renders the divergence state
  // instead), otherwise carrying the observed (epoch, generation) fence so
  // a delayed attach naming superseded ownership is typed-refused
  // server-side. Returns whether the attach was sent — false means
  // suppressed, so reaction handlers that follow the attach with more
  // sends (the lost-session retry's resend) can skip them.
  const captureFreshAgentAttachmentAttempt = useCallback((content: FreshAgentPaneContent) => {
    const attempt = captureAttachmentAttempt(
      appStore.getState(),
      content,
      attachmentAttemptRef.current,
      attachDecisionSerialRef.current,
    )
    attachmentAttemptRef.current = attempt
    return attempt
  }, [appStore])

  const sendFencedFreshAgentAttach = useCallback((attempt: AttachmentAttempt): boolean => {
    const content = paneContentRef.current
    if (!isMountedRef.current || !content.sessionId) return false
    // One state read (review N1): the suppression check and the current-round
    // identity check observe the same store snapshot — nothing dispatches in
    // between. A queued callback may never upgrade itself to a newer fence.
    const state = appStore.getState()
    if (attachmentAttemptRef.current !== attempt) return false
    if (attachmentAttemptKey(state, content, attachDecisionSerialRef.current) !== attempt.key) return false
    if (isLifecycleStartSuperseded(state, 'fresh-agent', content, attempt.fence)) return false
    const cwd = getFreshOpenCodeRouteCwd(attempt.content, { sessionCwd: freshOpenCodeRouteCwdRef.current })
    sendFreshAgentMessage(buildFreshAgentAttachMessage(attempt.content, cwd, attempt.fence))
    return true
  }, [appStore, sendFreshAgentMessage])

  // kata b8ke: the opened-as-CLI-elsewhere attach action — THIS pane adopts
  // the committed terminal owner (keeping its sessionRef + createRequestId,
  // entering `running` so TerminalView's mount effect attaches instead of
  // creating a second process). Only the card's committed path offers it.
  const attachTerminalOwnerHere = useCallback(() => {
    const divergence = ownerDivergenceRef.current
    const content = paneContentRef.current
    if (!divergence || divergence.ownerKind !== 'terminal' || divergence.terminalId === undefined) return
    if (content.kind !== 'fresh-agent') return
    const sessionRef = content.sessionRef ?? (
      content.sessionId !== undefined ? { provider: content.provider, sessionId: content.sessionId } : undefined
    )
    if (!sessionRef) return
    // b8ke ext r34 F2: canonicalize at the WRITE (mirroring the reverse
    // action's discipline at TerminalView's openAsFreshAgentHere) — the
    // divergence was discovered through the alias chain, so the pane
    // write must anchor to the CANONICAL session ref, never the pane's
    // raw superseded one: runtime-owner aliases reset on reconnect and
    // the ownership registry is reconstructed in memory at server start,
    // so a pane durably written with the retired pre-rekey provisional id
    // could no longer be identified with the canonical conversation by
    // later restoration or lifecycle recovery.
    const canonical = resolveCanonicalPaneSession(appStore.getState(), content)
    const sessionId = canonical?.sessionId ?? sessionRef.sessionId
    dispatch(updatePaneContent({
      tabId,
      paneId,
      content: buildTerminalAttachContent({
        createRequestId: content.createRequestId,
        mode: content.provider,
        provider: sessionRef.provider,
        sessionId,
        terminalId: divergence.terminalId,
        cwd: content.initialCwd,
      }),
    }))
  }, [appStore, dispatch, paneId, tabId])

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
    // b8ke ext r8 F5: the send is a lifecycle producer — it carries the
    // observed (epoch, generation) fence so a queued send landing after a
    // crash + generation advance is typed-refused server-side, never an
    // unfenced recreation.
    const fence = selectPaneOwnerFence(appStore.getState(), current)
    sendFreshAgentMessage({
      type: 'freshAgent.send',
      requestId,
      sessionId: current.sessionId,
      sessionType: current.sessionType,
      provider: current.provider,
      ...(fence ? { observedEpoch: fence.epoch, observedGeneration: fence.generation } : {}),
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
    if (outgoingTurnRef.current) outgoingTurnRef.current.requestId = retryRequestId
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
        outgoingTurnRef.current = null
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

  const buildCreateMessage = useCallback((content: FreshAgentPaneContent, observedFence?: ObservedOwnerFence) => {
    return {
      type: 'freshAgent.create',
      requestId: content.createRequestId,
      sessionType: content.sessionType,
      provider: content.provider,
      cwd: content.initialCwd,
      sessionRef: effectiveSessionRef(content),
      modelSelection: content.modelSelection,
      model: resolveEffectiveFreshAgentModel(content, providerDefaults),
      ...(getEffectiveFreshAgentPermissionMode(content) ? { permissionMode: getEffectiveFreshAgentPermissionMode(content) } : {}),
      sandbox: content.sandbox,
      effort: getEffectiveFreshAgentEffort(content, providerDefaults),
      plugins: content.plugins,
      // D8 (restore-open-sessions-only): the server composes the ledger row's
      // tabKey as `deviceId:tabId` from the connection identity + this field.
      tabId,
      // kata b8ke delayed-request fence (round-2 review: the fence is the
      // (epoch, generation) PAIR from the runtime-owner record observed when
      // the create was decided). A pair sent together is the fence;
      // neither-sent is legacy-unfenced.
      ...(observedFence
        ? { observedEpoch: observedFence.epoch, observedGeneration: observedFence.generation }
        : {}),
    } as const
  }, [providerDefaults, tabId])

  const startNewConversation = useCallback(() => {
    const current = paneContentRef.current
    // Focused-episode-6 round 2 (Finding 6): a session-bearing conversation
    // replacement AWAITS the old session's durable close before swapping the
    // pane — a close the server cannot record is not a close, and dropping
    // the conversation anyway would leave a live server session open on no
    // tab. On failure the current conversation stays (the killed fold's
    // session-error banner — or the await's timeout write — explains it).
    void (async () => {
      // b8ke ext F2: the kill target is the pane's DURABLE session —
      // content.sessionId OR the restored pane's sessionRef.sessionId
      // (the sessionRef's provider must match the pane's). Pre-ext the
      // content.sessionId gate skipped the awaited kill entirely for a
      // sessionRef-only restored pane, clearing the durable reference
      // and starting a blank conversation while the prior runtime
      // stayed live and unrepresented.
      const killSessionId = current.sessionId
        ?? (current.sessionRef?.provider === current.provider
          ? current.sessionRef.sessionId
          : undefined)
      if (killSessionId) {
        const cwd = getFreshOpenCodeRouteCwd(current, { sessionCwd: freshOpenCodeRouteCwdRef.current })
        // kata b8ke (round-3 F6): the kill is a lifecycle producer — carry
        // the observed (epoch, generation) fence so a delayed kill naming
        // superseded ownership is typed-refused instead of killing the
        // wrong runtime.
        const fence = selectPaneOwnerFence(appStore.getState(), current)
        const ack = await sendFreshAgentKillAndAwait(
          {
            sessionId: killSessionId,
            sessionType: current.sessionType,
            provider: current.provider,
            ...(cwd ? { cwd } : {}),
            ...(fence ? { observedEpoch: fence.epoch, observedGeneration: fence.generation } : {}),
          },
          { send: (m) => sendFreshAgentMessage(m as Record<string, unknown>) },
        )
        if (!ack.ok) {
          dispatch(sessionError({
            sessionId: killSessionId,
            sessionType: current.sessionType,
            provider: current.provider,
            code: 'KILL_FAILED',
            message: ack.timedOut ? KILL_ACK_TIMEOUT_MESSAGE : KILL_FAILED_MESSAGE,
          }))
          return
        }
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
    })()
  }, [appStore, commitSnapshot, dispatch, paneId, sendFreshAgentMessage, setLocalEcho, tabId])

  const sendFork = useCallback((atTurnId?: string) => {
    const current = paneContentRef.current
    if (!current.sessionId) return
    const cwd = getFreshOpenCodeRouteCwd(current, { sessionCwd: freshOpenCodeRouteCwdRef.current })
    // The freshAgent.forked broadcast is matched on createRequestId +
    // parentSessionId by the listener below, which repoints this pane at
    // the forked session. atTurnId is best-effort: providers that can't
    // fork mid-thread fork from the tip. D8 (focused-ep1-r5): `tabId` lets
    // the fork child row stamp this forking tab's identity — a forceNew
    // multi-tab fork must not inherit the OTHER tab's parked attribution.
    // b8ke ext r21 F2: the fork's delayed-request fence (the r8 F5
    // send/attach discipline): the observed pair rides the frame so a
    // reconnect-replayed stale fork landing after a crash + generation
    // advance is typed-refused server-side, never an unfenced recreation
    // of the parent runtime.
    const fence = selectPaneOwnerFence(appStore.getState(), current)
    sendFreshAgentMessage({
      type: 'freshAgent.fork',
      requestId: current.createRequestId,
      sessionId: current.sessionId,
      sessionType: current.sessionType,
      provider: current.provider,
      tabId,
      ...(cwd ? { cwd } : {}),
      ...(atTurnId ? { input: { atTurnId } } : {}),
      ...(fence ? { observedEpoch: fence.epoch, observedGeneration: fence.generation } : {}),
    })
  }, [appStore, sendFreshAgentMessage, tabId])

  // kata 1wxv: rollback requests mint a requestId so the requesting-sink ack
  // (composer refill) and any rollback-flagged refusal route back to THIS pane;
  // sibling clients converge through the session.rolledBack broadcast instead.
  const pendingRollbackRef = useRef<Map<string, { direction: 'undo' | 'redo' }>>(new Map())
  // Busy mirror for the advisory rollback gate: isBusy is derived far below the
  // slash-command callback, so the gate reads the ref (same idiom as
  // agentSessionStatusRef above) — always the current render's value at call time.
  const isBusyRef = useRef(false)
  const sendRollback = useCallback((direction: 'undo' | 'redo', mode: 'step' | 'toTurn', turnId?: string) => {
    const current = paneContentRef.current
    if (!current.sessionId) return
    const cwd = getFreshOpenCodeRouteCwd(current, { sessionCwd: freshOpenCodeRouteCwdRef.current })
    const requestId = nanoid()
    pendingRollbackRef.current.set(requestId, { direction })
    // b8ke ext r21 F2: the undo/redo delayed-request fence (the r8 F5
    // send/attach discipline): the observed pair rides the frame so a
    // reconnect-replayed stale rollback landing after a crash +
    // generation advance is typed-refused server-side, never an
    // unfenced recreation.
    const fence = selectPaneOwnerFence(appStore.getState(), current)
    sendFreshAgentMessage(buildRollbackFrame({
      direction,
      requestId,
      sessionId: current.sessionId,
      sessionType: current.sessionType,
      provider: current.provider,
      ...(cwd ? { cwd } : {}),
      mode,
      ...(turnId ? { turnId } : {}),
      ...(fence ? { observedEpoch: fence.epoch, observedGeneration: fence.generation } : {}),
    }))
  }, [appStore, sendFreshAgentMessage])

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
      // b8ke ext r21 F2: the compact's delayed-request fence (the r8 F5
      // send/attach discipline): the observed pair rides the frame so a
      // reconnect-replayed stale compact landing after a crash +
      // generation advance is typed-refused server-side, never an
      // unfenced recreation.
      const fence = selectPaneOwnerFence(appStore.getState(), current)
      sendFreshAgentMessage({
        type: 'freshAgent.compact',
        sessionId: current.sessionId,
        sessionType: current.sessionType,
        provider: current.provider,
        ...(cwd ? { cwd } : {}),
        ...(args ? { instructions: args } : {}),
        ...(fence ? { observedEpoch: fence.epoch, observedGeneration: fence.generation } : {}),
      })
      return
    }
    if (command.action === 'fork') {
      sendFork()
      return
    }
    // kata 1wxv: /undo and /redo handle CATALOG-RESOLVED commands (the menu pick and
    // the typed name that resolves against the capability-filtered catalog). The
    // RESERVED-NAME interception for capability-filtered-out names (freshcodex /redo)
    // lives in the COMPOSER's submit path instead (r3 correction 8): runSlashCommand
    // only ever sees catalog-resolved commands, so a filtered-out /redo could never
    // reach here — it would fall through to onSend as model text.
    if (command.action === 'undo' || command.action === 'redo') {
      const direction = command.action
      if (!current.sessionId) return
      const rollbackSnapshot = snapshotRef.current
      // The client gate is ADVISORY — the server's BUSY_TURN/refusal frames are the
      // authority and render their server-supplied message verbatim on the banner.
      const gate = gateRollbackCommand({
        direction,
        provider: current.provider,
        providerLabel: descriptor?.label ?? current.provider,
        capabilityUndo: rollbackSnapshot?.capabilities?.undo,
        capabilityRedo: rollbackSnapshot?.capabilities?.redo,
        canRedo: rollbackSnapshot?.rollback?.canRedo,
        isBusy: isBusyRef.current,
        hasRolledBackTurns: (rollbackSnapshot?.rolledBackTurns?.length ?? 0) > 0,
      })
      if (gate.kind === 'reject') {
        setNotice(gate.notice)
        return
      }
      sendRollback(direction, 'step')
      return
    }
  }, [descriptor?.label, sendFork, sendFreshAgentMessage, sendRollback, startNewConversation])

  useEffect(() => {
    if (!refreshRequest) return
    if (handledRefreshRequestIdRef.current === refreshRequest.requestId) return
    const current = paneContentRef.current
    if (!paneRefreshTargetMatchesContent(refreshRequest.target, current)) return

    handledRefreshRequestIdRef.current = refreshRequest.requestId
    commitSnapshot(null)
    setLoadError(null)

    if (current.sessionId) {
      // kata b8ke (review I1): the refresh reaction's attach is a lifecycle
      // start — routed through the ONE fenced sender, so a diverged pane
      // suppresses it (and the snapshot churn that follows) instead of
      // sending a stale attach the server would only typed-refuse.
      // A pane refresh is an explicit new attachment decision. Automatic
      // retries keep their existing decision serial and observation.
      attachDecisionSerialRef.current += 1
      const attempt = captureFreshAgentAttachmentAttempt(current)
      if (sendFencedFreshAgentAttach(attempt)) {
        requestSnapshotRefresh('manual')
      }
    } else if (current.status === 'creating' || current.status === 'starting') {
      // kata b8ke (review I1): the refresh reaction's create re-send gets
      // the same fence discipline as the create effect — capture the
      // observed fence, suppress on divergence. Suppressed re-sends leave
      // createSentRef armed so the standard create effect retains
      // responsibility for any later (converged) retry.
      const observedFence = selectPaneOwnerFence(appStore.getState(), current)
      if (!isLifecycleStartSuperseded(appStore.getState(), 'fresh-agent', current, observedFence)) {
        createSentRef.current = true
        registerFreshAgentCreate(dispatch, current.createRequestId, {
          sessionType: current.sessionType,
          provider: current.provider,
          resumeSessionId: current.resumeSessionId,
          sessionRef: current.sessionRef,
          cwd: current.initialCwd,
        })
        sendFreshAgentMessage(buildCreateMessage(current, observedFence))
      }
    }

    dispatch(consumePaneRefreshRequest({ tabId, paneId, requestId: refreshRequest.requestId }))
  }, [appStore, buildCreateMessage, captureFreshAgentAttachmentAttempt, commitSnapshot, dispatch, paneId, refreshRequest, requestSnapshotRefresh, sendFencedFreshAgentAttach, sendFreshAgentMessage, tabId])

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

  // Stuck-card recovery: kill the wedged sidecar (same kill-frame shape as
  // startNewConversation), then re-mint the pane through the existing
  // triggerRecovery path so the canonical resume id keeps the durable thread.
  const restartStuckSidecar = useCallback(() => {
    const current = paneContentRef.current
    // b8ke ext F2: the kill target is the pane's DURABLE session —
    // content.sessionId OR the restored pane's sessionRef.sessionId
    // (pre-ext a sessionRef-only pane skipped the kill and re-drove
    // creation over the live wedged runtime).
    const killSessionId = current.sessionId
      ?? (current.sessionRef?.provider === current.provider
        ? current.sessionRef.sessionId
        : undefined)
    if (killSessionId) {
      const cwd = getFreshOpenCodeRouteCwd(current, { sessionCwd: freshOpenCodeRouteCwdRef.current })
      // kata b8ke (round-3 F6): the kill carries the observed
      // (epoch, generation) fence like every lifecycle producer.
      const fence = selectPaneOwnerFence(appStore.getState(), current)
      sendFreshAgentMessage({
        type: 'freshAgent.kill',
        sessionId: killSessionId,
        sessionType: current.sessionType,
        provider: current.provider,
        ...(cwd ? { cwd } : {}),
        ...(fence ? { observedEpoch: fence.epoch, observedGeneration: fence.generation } : {}),
      })
    }
    triggerRecovery()
  }, [appStore, sendFreshAgentMessage, triggerRecovery])

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
    const scheduledContent = paneContentRef.current
    const scheduledAttempt = scheduledContent.sessionId
      ? captureFreshAgentAttachmentAttempt(scheduledContent)
      : null
    state.timer = setTimeout(() => {
      state.timer = null
      const current = paneContentRef.current
      if (current.sessionId) {
        // Attach loser: re-send the (fenced, divergence-gated) attach
        // directly — the attach effect keys on sessionId, which has not
        // changed, so a content nudge cannot re-fire it.
        if (scheduledAttempt) sendFencedFreshAgentAttach(scheduledAttempt)
        return
      }
      createSentRef.current = false // re-arm the create effect
      lastCreateArmKeyRef.current = '' // force the render-phase re-arm
      dispatch(updatePaneContent({ tabId, paneId, content: { ...paneContentRef.current } })) // nudge the effect
    }, FRESH_AGENT_RESERVE_RETRY_FLOOR_MS)
  }, [captureFreshAgentAttachmentAttempt, clearReserveRedrive, dispatch, paneId, reconcileLostPane, sendFencedFreshAgentAttach, tabId])

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
    // kata b8ke: the observed fence — the (epoch, generation) pair from
    // the runtime-owner record at the CREATE REQUEST's first send (the
    // decision moment). Carried on the create so the server stale-rejects
    // a delayed create naming superseded ownership; undefined means no
    // owner is known (legacy-unfenced). b8ke ext r35 F2: the capture is
    // PER-REQUEST — the SESSION_RESERVED redrive's effect re-arm re-runs
    // this effect but MUST reuse the ORIGINAL pair, never re-read the
    // record (the r28 vacant-generation-advanced suppression then
    // protects the retry, because the earlier observation is preserved
    // through it). b8ke ext r37 F1: the cache key includes the pane's
    // reconcileEpoch — the SAME shape as the terminal cache — because an
    // authoritative pane-reconcile recovery deliberately PRESERVES the
    // createRequestId and bumps the epoch to begin a NEW create round: a
    // respawn/fresh verdict after ownership advanced N→N+1 must capture
    // the CURRENT fence (a new recovery decision, not an automatic
    // retry). Pre-r37 the epoch-bumped re-arm reused the OLD N fence,
    // the server refused it SESSION_RESERVED, the client retried the
    // stale pair, and the bounded re-reconcile could drain the respawn
    // cap and falsely classify a recoverable durable session as dead.
    // Automatic retries WITHIN a round (no epoch bump) keep the
    // round-35 contract: the original pair.
    let observedFence: ObservedOwnerFence | undefined
    const fenceArmEpoch = paneContent.reconcileEpoch ?? 0
    if (
      createFenceRef.current?.createRequestId === paneContent.createRequestId
      && createFenceRef.current.reconcileEpoch === fenceArmEpoch
    ) {
      observedFence = createFenceRef.current.fence
    } else {
      observedFence = selectPaneOwnerFence(appStore.getState(), paneContent)
      createFenceRef.current = {
        createRequestId: paneContent.createRequestId,
        reconcileEpoch: fenceArmEpoch,
        fence: observedFence,
      }
    }
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
      // kata b8ke pre-send divergence check: a stale callback (rebind-queue
      // run, reconnect resend) must not issue a lifecycle-start for a
      // session the runtime-owner store now shows as owned by the other
      // kind. The pane keeps its identity and renders the divergence state
      // (Task 9's card) instead; the server-side fence is the backstop.
      if (isLifecycleStartSuperseded(appStore.getState(), 'fresh-agent', current, observedFence)) {
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
      sendFreshAgentMessage(buildCreateMessage(current, observedFence))
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
    appStore,
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
        // kata b8ke: reconnect resends are stale-callback lifecycle starts —
        // they carry the create request's ORIGINAL captured pair, suppress
        // on divergence. b8ke ext r35 F2: the pair comes from the
        // PER-REQUEST capture (keyed by createRequestId), captured at the
        // request's first send — the reconnect execution time never
        // re-reads the record (a silent refresh here would present a
        // long-queued create as current over a newer lifecycle).
        let reconnectFence: ObservedOwnerFence | undefined
        const reconnectArmEpoch = latest.reconcileEpoch ?? 0
        if (
          createFenceRef.current?.createRequestId === latest.createRequestId
          && createFenceRef.current.reconcileEpoch === reconnectArmEpoch
        ) {
          reconnectFence = createFenceRef.current.fence
        } else {
          reconnectFence = selectPaneOwnerFence(appStore.getState(), latest)
          createFenceRef.current = {
            createRequestId: latest.createRequestId,
            reconcileEpoch: reconnectArmEpoch,
            fence: reconnectFence,
          }
        }
        const observedFence = reconnectFence
        if (isLifecycleStartSuperseded(appStore.getState(), 'fresh-agent', latest, observedFence)) {
          release?.()
          return
        }
        if (release) {
          releasePendingRebind()
          pendingRebindReleaseRef.current = release
        }
        sendFreshAgentMessage(buildCreateMessage(latest, observedFence))
      }
      if (hiddenRef.current) {
        getRebindQueue().enqueue({ key: `freshagent:${paneId}:create:${current.createRequestId}`, run: resend })
      } else {
        resend()
      }
    })
  }, [
    appStore,
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
    const attempt = captureFreshAgentAttachmentAttempt(paneContent)
    const sendAttach = () => {
      sendFencedFreshAgentAttach(attempt)
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
    captureFreshAgentAttachmentAttempt,
    connectionBootId,
    freshOpenCodeRouteCwd,
    paneId,
    paneContent.createRequestId,
    paneContent.reconcileEpoch,
    paneContent.provider,
    paneContent.sessionId,
    paneContent.sessionRef?.provider,
    paneContent.sessionRef?.sessionId,
    paneContent.sessionType,
    sendFencedFreshAgentAttach,
  ])

  useEffect(() => {
    if (!paneContent.sessionId) return
    if (typeof ws.onReconnect !== 'function') return
    return ws.onReconnect(() => {
      // The ready handler folds the new boot and runtime-owner state in the
      // same turn as this callback. Defer the decision so the attempt observes
      // that completed authority state instead of the old boot/fence.
      queueMicrotask(() => {
        if (!isMountedRef.current) return
        const current = paneContentRef.current
        if (!current.sessionId) return
        const attempt = captureFreshAgentAttachmentAttempt(current)
        const sendAttach = () => {
          sendFencedFreshAgentAttach(attempt)
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
          markSnapshotDirty()
        } else {
          sendAttach()
          requestSnapshotRefresh('reconnect')
        }
      })
    })
  }, [
    captureFreshAgentAttachmentAttempt,
    connectionBootId,
    paneId,
    paneContent.sessionId,
    paneContent.reconcileEpoch,
    markSnapshotDirty,
    requestSnapshotRefresh,
    sendFencedFreshAgentAttach,
    ws,
  ])

  // F8: consume the deferred snapshot refresh on reveal. The dirty marker is
  // also used by transcript-changing websocket events, so the same path
  // handles reconnects and provider activity without duplicate fetches.
  useEffect(() => {
    if (hidden) return
    if (pendingRevealRefreshRef.current) pendingRevealRefreshRef.current = false
    requestRevealRefresh()
  }, [hidden, requestRevealRefresh, snapshotDirty])

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
        if (!ownsRequest
          || !locatorMatchesPane(message, current, freshOpenCodeRouteCwdRef.current, runtimeOwnersForLocator())) {
          return
        }
        const submittedTurnId = typeof message.submittedTurnId === 'string'
          ? message.submittedTurnId
          : undefined
        if (submittedTurnId) {
          recordPendingSendMetadata(message.requestId, { submittedTurnId })
          if (outgoingTurnRef.current?.requestId === message.requestId) {
            outgoingTurnRef.current.submittedTurnId = submittedTurnId
          }
          if (echo?.requestId === message.requestId) {
            setLocalEcho({ ...echo, submittedTurnId })
          }
        } else {
          recordPendingSendMetadata(message.requestId, { legacyAccepted: true })
        }
        if (hiddenRef.current) markSnapshotDirty()
        else requestSnapshotRefresh('send-accepted')
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
            // kata b8ke (review I1): the retry's re-attach is a lifecycle
            // start — routed through the ONE fenced attach sender. While the
            // canonical session has diverged the retry is suppressed (no
            // attach, no resend at a stale session) and the failure falls
            // through to the normal cleanup path below instead.
            const attempt = captureFreshAgentAttachmentAttempt(current)
            if (sendFencedFreshAgentAttach(attempt)) {
              // Re-attach with the route cwd (the incident's no-cwd
              // locator), then resend the retained text exactly once. The
              // original request is consumed here; the retry itself is
              // never retried.
              lostSessionRetryRef.current.add(failedRequestId)
              pendingSendMetadataRef.current.delete(failedRequestId)
              const retryRequestId = nanoid()
              lostSessionRetryRef.current.add(retryRequestId)
              resendPendingMessage(retryRequestId, pendingMeta.text, cwd)
              // Do NOT fall through: the echo stays visible while the retry is
              // in flight.
              return
            }
          }
        }
        // Cleanup fall-through: every owned send failure that did not take
        // the retry path (including a retried request failing again) releases
        // the three leaks a failed send otherwise leaves behind -- the
        // pending-metadata entry, the stale local echo (dual-write), and the
        // optimistic `running` status.
        pendingSendMetadataRef.current.delete(failedRequestId)
        if (outgoingTurnRef.current?.requestId === failedRequestId) {
          outgoingTurnRef.current = null
          refreshOutgoingTurn()
        }
        if (localEchoRef.current?.requestId === failedRequestId) {
          setLocalEcho(null)
        }
        if (current.provider === 'opencode' && current.status === 'running') {
          dispatch(mergePaneContent({ tabId, paneId, updates: { status: 'idle' } }))
        }
        return
      }
      if (
        message.type === 'freshAgent.event'
        && locatorMatchesPane(message, paneContentRef.current, freshOpenCodeRouteCwdRef.current, runtimeOwnersForLocator())
        && outgoingTurnRef.current && isRecord(message.event)
      ) {
        const event = message.event
        const stream = isRecord(event.event) ? event.event : undefined
        const isBusyEvent = ((event.type === 'freshAgent.status' || event.type === 'freshAgent.session.snapshot')
          && typeof event.status === 'string' && BUSY_STATES.has(event.status))
          || (event.type === 'freshAgent.stream' && (stream?.type === 'content_block_start' || stream?.type === 'content_block_delta'))
        // Observe fast turns even when React batches running and idle into
        // one render. The status version below still observes that final idle.
        if (isBusyEvent) outgoingTurnRef.current.sawBusy = true
      }
      const messageBelongsToPane = message.type === 'freshAgent.event'
        && locatorMatchesPane(message, paneContentRef.current, freshOpenCodeRouteCwdRef.current, runtimeOwnersForLocator())
      const eventType = readMessageEventType(message)
      const event = message.type === 'freshAgent.event' && isRecord(message.event) ? message.event : undefined
      const eventStatus = typeof event?.status === 'string' ? event.status : undefined
      const previousStatus = agentSessionStatusRef.current ?? paneContentRef.current.status
      const busySnapshotSettled = eventType === 'freshAgent.session.snapshot'
        && eventStatus !== undefined
        && !BUSY_STATES.has(eventStatus)
        && BUSY_STATES.has(previousStatus)
      const transcriptChanged = isTranscriptInvalidatingFreshAgentEvent(message) || busySnapshotSettled
      if (messageBelongsToPane && transcriptChanged && (hiddenRef.current || snapshotDirtyRef.current)) {
        markSnapshotDirty()
      }
      if (messageBelongsToPane && !hiddenRef.current && transcriptChanged && snapshotDirtyRef.current) {
        requestRevealRefresh(true)
      } else if (messageBelongsToPane && isSnapshotInvalidatingFreshAgentEvent(message)) {
        if (!hiddenRef.current) requestSnapshotRefresh('event')
      }
      // kata 1wxv: the requesting-sink ack drives the composer refill; rollback
      // refusals render their server-pinned message verbatim. Both match on the
      // pane-minted requestId, so foreign panes' rollback traffic never routes here.
      if (message.type === 'freshAgent.event') {
        const ack = asRollbackAck(message.event)
        if (ack && pendingRollbackRef.current.has(ack.requestId)) {
          const pending = pendingRollbackRef.current.get(ack.requestId)
          pendingRollbackRef.current.delete(ack.requestId)
          if (ack.kind === 'freshAgent.rolledBack' && pending?.direction === 'undo') {
            setLocalEcho(null) // a pending optimistic echo must not survive a rollback
            if (typeof ack.removedPromptText === 'string') {
              composerRef.current?.replaceText(ack.removedPromptText) // decision 4: overwrite refill
              setNotice(UNDO_REFILL_NOTICE)
            }
          }
          // A redone ack leaves the composer alone — the server kept prompt truth.
        } else if (
          isRollbackErrorEvent(message.event)
          && typeof (message.event as { requestId?: unknown }).requestId === 'string'
          && pendingRollbackRef.current.has((message.event as { requestId: string }).requestId)
        ) {
          pendingRollbackRef.current.delete((message.event as { requestId: string }).requestId)
          // The server's supplied message is PINNED SERVER-SIDE and rendered VERBATIM —
          // BUSY_TURN carries ROLLBACK_BUSY_MESSAGE; REDO_UNAVAILABLE carries the
          // destroyed / empty / claude moved-tip copy; capability failures carry their
          // exact copy (CODEX_LEGACY_THREAD_COPY / old-CLI copies / parity text). The
          // client NEVER substitutes client-side guess copy for a supplied message.
          const supplied = (message.event as { message?: unknown }).message
          setNotice(typeof supplied === 'string' ? supplied : rollbackUnsupportedNotice(descriptor?.label ?? paneContentRef.current.provider))
        }
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
          // kata b8ke (review I1): the post-fork cleanup kill carries the
          // observed (epoch, generation) fence exactly like
          // startNewConversation/restartStuckSidecar — kills are fenced,
          // never suppressed; the server typed-refuses a stale cross-kind
          // kill from the pair instead of the client guessing.
          const fence = selectPaneOwnerFence(appStore.getState(), paneContent)
          sendFreshAgentMessage({
            type: 'freshAgent.kill',
            sessionId: paneContent.sessionId,
            sessionType: paneContent.sessionType,
            provider: paneContent.provider,
            ...(cwd ? { cwd } : {}),
            ...(fence ? { observedEpoch: fence.epoch, observedGeneration: fence.generation } : {}),
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
  }, [agentSession?.cwd, appStore, captureFreshAgentAttachmentAttempt, clearReserveRedrive, commitSnapshot, descriptor?.label, dispatch, markSnapshotDirty, migratePendingAutoTitle, paneContent, paneContent.createRequestId, paneId, recordPendingSendMetadata, redriveAfterSessionReserved, releasePendingRebind, requestRevealRefresh, requestSnapshotRefresh, resendPendingMessage, sendFencedFreshAgentAttach, sendFreshAgentMessage, setLocalEcho, tabId, ws])

  useEffect(() => {
    if (!snapshotThreadId) return
    // kata b8ke: a divergent pane (the canonical session's runtime owner is
    // the other kind) stops ALL old-kind snapshot traffic — polling, event
    // refreshes, and this identity fetch alike. Read via the ref so the
    // identity-deps discipline below is not disturbed.
    if (ownerDivergenceRef.current) return
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
      // kata b8ke: a divergence flip (the session's runtime owner became the
      // other kind while this request was in flight) makes the result stale —
      // result-application fencing, never an AbortSignal (the run-closure
      // contract).
      || ownerDivergenceRef.current !== null
    )
    // A1: resolve the cwd ONCE (route cwd falls through initialCwd -> session
    // cwd) and use the SAME value for both the scheduler key and the request,
    // so sibling panes whose raw initialCwd diverges ('' vs '/w') still share
    // one key -- keying on raw initialCwd would let the N-pane fan-out survive.
    const requestCwd = freshOpenCodeRouteCwdRef.current ?? paneContentRef.current.initialCwd
    const requestAgentSessionStatusVersion = agentSessionStatusVersionRef.current
    const requestOutgoingTurnId = outgoingTurnRef.current?.requestId
    const trigger = snapshotRefreshTriggerRef.current
    const refreshSerial = snapshotRefreshSerialRef.current
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
      const snapshotStatusAuthoritative = provider === 'codex'
        || resolved.extensions?.[provider]?.statusFromLiveState === true
      const outgoing = outgoingTurnRef.current
      if (
        outgoing && outgoing.requestId === requestOutgoingTurnId
        && snapshotAccepted && displaySnapshot.status === 'idle'
        && snapshotStatusAuthoritative
        && agentSessionStatusVersionRef.current === requestAgentSessionStatusVersion
        && localEchoLanded(displaySnapshot.turns, outgoing, pendingSendMetadataRef.current.get(outgoing.requestId), {
          allowTextMatch: true,
          previousTurnKeys: new Set((outgoing.previousTurns ?? []).map(getTurnKey)),
        })
      ) {
        // Reconnect may miss every stream/status event. A current idle snapshot
        // containing this submitted turn is sufficient evidence to advance.
        // Snapshots requested before this send, or newer activity, cannot unlock it.
        outgoingTurnRef.current = null
        refreshOutgoingTurn()
      }
      commitSnapshot(displaySnapshot)
      setSnapshotAutoTitleIdentity(snapshotIdentity)
      const revealRefreshIsCurrent = (
        trigger === 'reveal'
        && snapshotDirtyRef.current
        && revealRefreshVersionRef.current === snapshotDirtyVersionRef.current
        && refreshSerial === snapshotRefreshSerialRef.current
      )
      const revealRevisionIsFresh = snapshotDirtyBaseRevisionRef.current === null
        || typeof resolved.revision !== 'number'
        || resolved.revision > snapshotDirtyBaseRevisionRef.current
      if (revealRefreshIsCurrent && revealRevisionIsFresh) {
        if (revealRefreshRetryTimerRef.current !== null) {
          clearTimeout(revealRefreshRetryTimerRef.current)
          revealRefreshRetryTimerRef.current = null
        }
        snapshotDirtyRef.current = false
        snapshotDirtyBaseRevisionRef.current = null
        revealRefreshVersionRef.current = null
        revealRefreshStartedAtRef.current = null
        setSnapshotDirty(false)
        setSnapshotRevealError(null)
      } else if (revealRefreshIsCurrent && !revealRevisionIsFresh
        && revealRefreshRetryTimerRef.current === null) {
        const startedAt = revealRefreshStartedAtRef.current ?? Date.now()
        const remaining = startedAt + REVEAL_REFRESH_MAX_WAIT_MS - Date.now()
        if (remaining <= 0) {
          revealRefreshStartedAtRef.current = null
          setSnapshotRevealError('The conversation did not finish refreshing. Try again.')
        } else {
          revealRefreshRetryTimerRef.current = window.setTimeout(() => {
            revealRefreshRetryTimerRef.current = null
            if (!isMountedRef.current || hiddenRef.current || !snapshotDirtyRef.current) return
            requestRevealRefresh(true)
          }, Math.min(250, remaining))
        }
      }
      const echo = localEchoRef.current
      const echoPendingMetadata = echo ? pendingSendMetadataRef.current.get(echo.requestId) : undefined
      const landedEcho = echo
        ? localEchoLanded(displaySnapshot.turns, echo, echoPendingMetadata, {
            allowTextMatch: snapshotAccepted,
            previousTurnKeys: echo.previousTurnKeys ? new Set(echo.previousTurnKeys) : null,
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
      const canAdoptSnapshotStatus =
        (provider === 'codex' && requestSessionType === 'freshcodex')
        || (provider === 'claude' && snapshotStatusAuthoritative)
        || (provider === 'opencode' && requestSessionType === 'freshopencode'
          // busy (running) may always be adopted; idle (busy-CLEARING) only when
          // live-reconciled -- otherwise the restore-window idle default (untracked
          // or mid-reconcile adapter state) would clear a genuinely running turn.
          && (snapshotIsBusy || snapshotStatusAuthoritative))
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
      // An idle/busy-less snapshot must not clear a genuinely running turn.
      // The pane-content status echo is user-visible state and deserves the
      // same protection the session record has — the two writes must never
      // disagree. "Genuinely running" is the session record's positive busy
      // assertion (the server's running broadcast / status events): while
      // the record asserts busy, a busy-less snapshot status may not
      // overwrite the pane's 'running' unless the session-record gate's own
      // adoption legality (canAdoptSnapshotStatus and its companion
      // conditions; the busy disjunct is already excluded by the trigger
      // below) would allow the same adoption; once the record no longer
      // asserts busy (authoritative events already ended the turn), the
      // pane's 'running' is stale and adopting the snapshot's status
      // restores the agreement.
      const sessionRecordAssertsBusy = agentSessionStatusRef.current !== undefined
        && BUSY_STATES.has(agentSessionStatusRef.current)
      const snapshotClearsGenuineRunning = !snapshotIsBusy
        && fresh.status === 'running'
        && sessionRecordAssertsBusy
        && !(
          sessionStatus
          && nextSessionId
          && canAdoptSnapshotStatus
          && !wouldRegressStatus
          && (!hasBlockingLocalEchoForSession && !statusChangedSinceRequest)
        )
      const nextPaneStatus = snapshotClearsGenuineRunning ? fresh.status : nextStatus
      if (
        nextPaneStatus === fresh.status
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
          status: nextPaneStatus,
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
      if (trigger === 'reveal' && snapshotDirtyRef.current) {
        revealRefreshStartedAtRef.current = null
        setSnapshotRevealError(error instanceof Error ? error.message : 'Failed to refresh conversation')
        return
      }
      setLoadError(error instanceof Error ? error.message : 'Failed to load session')
    }
    const key = makeSnapshotKey({ sessionType: requestSessionType, provider, threadId: sessionId, cwd: requestCwd })
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
          if (
            trigger === 'reveal'
            && revealRefreshStartedAtRef.current !== null
            && Date.now() + delay > revealRefreshStartedAtRef.current + REVEAL_REFRESH_MAX_WAIT_MS
          ) {
            revealRefreshStartedAtRef.current = null
            setSnapshotRevealError('The conversation did not finish refreshing. Try again.')
            return
          }
          rateLimitRetryTimerRef.current = window.setTimeout(() => {
            rateLimitRetryTimerRef.current = null
            setRateLimitedUntil(null)
            if (snapshotDirtyRef.current && !hiddenRef.current) {
              requestRevealRefresh(true)
            } else {
              requestSnapshotRefresh('manual')
            }
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
    requestRevealRefresh,
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

  // Delta-review round-1 F2: the Task 4 content-status gate (in applySnapshot)
  // can strand the pane-content status at a busy state. When a turn ends
  // without a snapshot-invalidating event (freshAgent.error via sessionError,
  // freshAgent.exit via sessionExited, codex stuck/exited — none of which is
  // in SNAPSHOT_INVALIDATING_FRESH_AGENT_EVENTS), the record clears busy
  // through a path that triggers no follow-up snapshot, and the busy poll
  // stops once the record is idle — so the pane's refused 'running' echo has
  // nothing left to repair it. (Opencode's interrupt and end-of-turn paths DO
  // emit freshAgent.session.snapshot, which refetches; this effect covers the
  // event-shaped endings.) The record's busy→non-busy edge is the last
  // authoritative signal: re-derive the pane-content status from it.
  // Claude is excluded because the level-triggered mirror above already
  // covers it. This cannot weaken the gate: it fires only once the record
  // ITSELF no longer asserts busy, which is exactly when the Task 4
  // invariant considers the pane's 'running' stale. Edge-triggered (not
  // level-triggered) so it never fights the opencode send path's optimistic
  // 'running' write, which lands while the record is already non-busy.
  const agentSessionStatus = agentSession?.status
  const previousSessionRecordStatusRef = useRef(agentSessionStatus)
  useEffect(() => {
    const previousStatus = previousSessionRecordStatusRef.current
    previousSessionRecordStatusRef.current = agentSessionStatus
    if (paneContent.provider === 'claude') return
    if (!agentSessionStatus || !previousStatus) return
    if (!BUSY_STATES.has(previousStatus) || BUSY_STATES.has(agentSessionStatus)) return
    if (!BUSY_STATES.has(paneContent.status)) return
    if (isStatusRegression(paneContent.status, agentSessionStatus)) return
    dispatch(mergePaneContent({
      tabId,
      paneId,
      updates: { status: agentSessionStatus },
    }))
  }, [agentSessionStatus, dispatch, paneContent.provider, paneContent.status, paneId, tabId])

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
  isBusyRef.current = isBusy
  // kata 1wxv: snapshot-stamped rollback capabilities drive every client affordance
  // (per-turn icon, slash/menus, the pre-flight gate). Legacy servers emit neither
  // key, so absent is false; codex v1 is undo-only (redo stamps false server-side).
  const canRollback = snapshot?.capabilities?.undo === true
  const canRedoNow = snapshot?.capabilities?.redo === true && snapshot?.rollback?.canRedo === true
  // Pane context-menu registration: "Undo last turn"/"Redo last turn" ride the
  // pane-action registry; both still run the advisory gates at commit time.
  useEffect(() => registerFreshAgentPaneActions(paneId, {
    undo: () => sendRollback('undo', 'step'),
    redo: () => sendRollback('redo', 'step'),
    canUndo: canRollback && !isBusy && Boolean(snapshot?.sessionId ?? paneContent.sessionId),
    canRedo: canRedoNow && !isBusy,
    // Capability stamps drive menu ROW PRESENCE: codex stamps redo:false
    // server-side, so its menu never offers a dead "Redo last turn" row.
    undoSupported: canRollback,
    redoSupported: snapshot?.capabilities?.redo === true,
  }), [paneId, sendRollback, canRollback, canRedoNow, isBusy, snapshot?.sessionId, snapshot?.capabilities?.redo, paneContent.sessionId])
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
  // read-only when idle. b8ke ext r32 F3: a DIVERGED/transition pane is a
  // pure observer (the runtime-owner state owns it — "open as a terminal
  // on another device" or transition-in-progress): the composer stays
  // disabled so a user cannot submit text, get a local echo, and issue an
  // old-kind send the server's generation fence would refuse with a
  // misleading failure instead of the pane's recoverable attach action.
  const composerDisabled = !paneContent.sessionId || sessionEnded || (!canSend && !isBusy) || Boolean(ownerDivergence)

  useEffect(() => {
    const outgoing = outgoingTurnRef.current
    if (!outgoing) return
    if (isBusy) outgoing.sawBusy = true
    else if (outgoing.sawBusy || sessionEnded) outgoingTurnRef.current = null
  }, [agentSession?.statusVersion, isBusy, sessionEnded])

  useEffect(() => {
    if (!isActivePane) return
    const frame = requestAnimationFrame(() => {
      const active = document.activeElement
      if (active instanceof HTMLElement
        && paneRootRef.current?.contains(active)
        && isEditableTarget(active)) return
      if (!mayFocusNow()) return
      if (composerDisabled) {
        paneRootRef.current?.focus()
        return
      }
      composerRef.current?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [isActivePane, composerDisabled, mayFocusNow])

  // Fallback poll while the agent is (or claims to be) working: if a
  // transport event is missed, the pane self-heals within a few seconds
  // instead of stranding on an empty turn with a stop button.
  useEffect(() => {
    if (hidden || !paneContent.sessionId) return
    // kata b8ke: the runtime-owner transition stops old-kind scheduling
    // IMMEDIATELY — while the canonical session is owned by the other kind,
    // no fallback poll re-arms (the effect re-runs on the divergence flip
    // and clears any live interval). Same-mode multi-device attachment is
    // untouched: a same-kind owner does not diverge.
    if (ownerDivergence) return
    if (!isBusy && !EARLY_STATES.has(effectiveStatus)) return
    const timer = window.setInterval(() => {
      requestSnapshotRefresh('poll')
    }, 3000)
    return () => window.clearInterval(timer)
  }, [effectiveStatus, hidden, isBusy, ownerDivergence, paneContent.sessionId, requestSnapshotRefresh])

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
    outgoingTurnRef.current = { requestId, text, sawBusy: false, previousTurns: snapshotRef.current?.turns ?? [] }
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
    const nextLocalEcho: LocalEcho = {
      text,
      requestId,
      previousTurnKeys: (snapshotRef.current?.turns ?? []).map(getTurnKey),
    }
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

  // Providers accept one active turn. Keep follow-ups until the session can
  // actually accept them, including across disconnects and provider failures.
  // b8ke ext r32 F3: a DIVERGED/transition pane never flushes its queue —
  // the pane is a pure observer with the attach action; a queued message
  // held from before the divergence (or the transition) stays held until
  // the pane is no longer diverged (the effect re-runs on the flip).
  useEffect(() => {
    if (isBusy || !canSend || connectionStatus !== 'ready' || isRestoring || hasRestoreFailure) return
    if (ownerDivergenceRef.current) return
    if (outgoingTurnRef.current || queuedMessages.length === 0 || !paneContentRef.current.sessionId) return
    sendUserText(queuedMessages[0])
    setQueuedMessages((queue) => queue.slice(1))
  }, [agentSession?.statusVersion, canSend, connectionStatus, hasRestoreFailure, isBusy, isRestoring, outgoingTurnVersion, ownerDivergence, queuedMessages, sendUserText])

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
    // Prefer the pane's starting directory; a resumed/API-created pane
    // without one falls back to the LIVE session cwd (the snapshot's), so
    // the command runs in the session's working directory rather than the
    // server's user-home default when the directory is actually known.
    const cwd = current.initialCwd ?? agentSessionCwdRef.current
    // Bind the async result to THIS conversation: the exec budget is 30 s,
    // and a /new (or any session replacement) mid-command must never let
    // the stale completion append into — and auto-send within — the new
    // conversation's queue.
    const launchSessionId = current.sessionId
    void Promise
      .resolve(api.post<{ output: string; exitCode: number | null; truncated: boolean }>(
        '/api/fresh-agent/exec',
        { command, ...(cwd ? { cwd } : {}) },
      ))
      .then((result) => {
        if (paneContentRef.current.sessionId !== launchSessionId) {
          setNotice('Shell command finished after the conversation was replaced; its output was not sent.')
          return
        }
        const status = result.exitCode === 0 ? '' : ` (exit ${result.exitCode})`
        const body = `I ran \`${command}\`${status} in ${cwd ?? 'the home directory'}. Output:\n\`\`\`\n${result.output || '(no output)'}\n\`\`\``
        setQueuedMessages((queue) => [...queue, body])
      })
      .catch((error: unknown) => {
        setNotice(error instanceof Error ? `Shell command failed: ${error.message}` : 'Shell command failed')
      })
  }, [])

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

  // Task 6 (freshopencode TUI parity): the delegation block's "Open session"
  // link resumes the child durable session in its own pane, like the sidebar
  // row does. The cwd uses the view's existing opencode route resolution —
  // the pane's starting directory falling back to the LIVE session cwd — so a
  // resumed/API-created pane still opens the child in the right project; when
  // no cwd resolves at all, undefined lets the thunk locate the session itself.
  const openDelegationSession = useCallback((sessionId: string, title?: string) => {
    dispatch(openSessionTab({
      sessionId,
      title: title ?? sessionId,
      cwd: freshOpenCodeRouteCwd,
      provider: 'opencode',
      sessionType: 'freshopencode',
      isSubagent: true,
    }))
  }, [dispatch, freshOpenCodeRouteCwd])

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
    // b8ke ext r32 F3: a DIVERGED/transition pane has NO interrupt
    // affordance — the pane is a pure observer (the runtime-owner state
    // owns the session; an old-kind interrupt would at best fail the
    // server's generation fence and at worst tear at a writer the
    // diverged pane no longer owns).
    const canInterrupt = !ownerDivergence && isBusy && (snapshot?.capabilities?.interrupt === true || (
      paneContent.provider === 'claude'
      && Boolean(paneContent.sessionId)
      && ['connected', 'running', 'compacting'].includes(effectiveStatus)
    ))
    const canFork = snapshot?.capabilities?.fork === true
    const questionAgentLabel = getQuestionAgentLabel(paneContent, descriptor?.label)
    // Session-record locator for the dismissal dispatches below — the same
    // triple the agentSession selector keys on. `sessionId` is non-empty
    // whenever a dismissable session-record banner is showing (the record
    // must already exist to have produced the error).
    const sessionRecordLocator = {
      sessionId: paneContent.sessionId ?? '',
      sessionType: paneContent.sessionType,
      provider: paneContent.provider,
    }
    const visibleRestoreFailure = paneContent.provider === 'claude'
      ? claudeSession?.restoreFailureMessage
      : null
    const visiblePaneRestoreFailure = visibleRestoreFailure
      ? null
      : (paneContent.restoreError ? getRestoreErrorMessage(paneContent.restoreError.reason) : null)
    const visibleLoadError = visibleRestoreFailure || visiblePaneRestoreFailure || isRestoring ? null : loadError
    const revealRefreshBlocking = !hidden && snapshotDirty
    const revealRefreshStatus = snapshotRevealError
      ? 'The conversation could not be refreshed.'
      : 'Refreshing conversation'
    const WatermarkIcon = descriptor?.icon
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
                  <FreshAgentApprovalBanner
                    text={(pendingCreateFailure ?? paneContent.createError)?.message ?? 'Create failed'}
                    onDismiss={() => {
                      if (paneContent.createRequestId) {
                        dispatch(clearPendingCreateFailure({ requestId: paneContent.createRequestId }))
                      }
                      if (paneContent.createError) {
                        dispatch(updatePaneContent({
                          tabId,
                          paneId,
                          content: {
                            ...paneContentRef.current,
                            createError: undefined,
                          },
                        }))
                      }
                    }}
                  />
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
              {visibleRestoreFailure ? (
                <FreshAgentApprovalBanner
                  text={visibleRestoreFailure}
                  onDismiss={() => dispatch(clearRestoreFailure(sessionRecordLocator))}
                />
              ) : null}
              {visiblePaneRestoreFailure ? (
                <FreshAgentApprovalBanner
                  text={visiblePaneRestoreFailure}
                  onDismiss={() => dispatch(updatePaneContent({
                    tabId,
                    paneId,
                    content: {
                      ...paneContentRef.current,
                      restoreError: undefined,
                    },
                  }))}
                />
              ) : null}
              {visibleLoadError ? (
                <FreshAgentApprovalBanner text={visibleLoadError} onDismiss={() => setLoadError(null)} />
              ) : null}
              {paneContent.reconcileNotice ? (
                <div role="status" className="px-3 py-1 text-xs text-amber-600 dark:text-amber-400">
                  {paneContent.reconcileNotice}
                </div>
              ) : null}
              {sessionErrorMessage ? (
                <FreshAgentApprovalBanner
                  text={`Agent error: ${sessionErrorMessage}`}
                  onDismiss={() => dispatch(clearSessionError(sessionRecordLocator))}
                />
              ) : null}
              {effectiveStatus === 'stuck' ? (
                <div
                  className="fresh-agent-stuck-card flex items-center justify-between gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-sm"
                  role="alert"
                >
                  <span>{FRESH_AGENT_STUCK_NOTICE_TEXT}</span>
                  <div className="flex shrink-0 gap-2">
                    <button
                      type="button"
                      className="fresh-agent-stuck-action shrink-0 rounded border border-border/70 px-2 py-1 text-xs"
                      aria-label="Restart sidecar and resume session"
                      onClick={restartStuckSidecar}
                    >
                      Restart sidecar
                    </button>
                    <button
                      type="button"
                      className="fresh-agent-stuck-action shrink-0 rounded border border-border/70 px-2 py-1 text-xs"
                      aria-label="Start new conversation"
                      onClick={startNewConversation}
                    >
                      Start new conversation
                    </button>
                  </div>
                </div>
              ) : null}
              {ownerDivergence?.fencedReason !== undefined ? (
                <div
                  className="fresh-agent-fenced-card flex items-center justify-between gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-sm"
                  role="alert"
                  aria-label="Session blocked pending recovery"
                >
                  <span>
                    {`This conversation is blocked pending recovery (${ownerDivergence.fencedReason}).`}
                  </span>
                  {/* b8ke ext r28 F2: the direct recovery actions — the
                   * acknowledged force-clear for the server's accepted
                   * unconfirmable reasons, the acknowledged START for the
                   * cleared-unverified state; never a passive card. */}
                  <FencedOwnerRecoveryActions
                    fencedReason={ownerDivergence.fencedReason}
                    appStore={appStore}
                    tabId={tabId}
                    paneId={paneId}
                  />
                </div>
              ) : ownerDivergence?.ownerKind === 'terminal' ? (
                <div
                  className="fresh-agent-divergence-card flex items-center justify-between gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-sm"
                  role="alert"
                  aria-label="Session open as a terminal on another device"
                >
                  <span>
                    {ownerDivergence.transition === 'handoff-committed' && ownerDivergence.terminalId !== undefined
                      ? 'This conversation is open as a terminal on another device.'
                      : 'This conversation is being reopened as a terminal elsewhere…'}
                  </span>
                  {ownerDivergence.transition === 'handoff-committed' && ownerDivergence.terminalId !== undefined ? (
                    <button
                      type="button"
                      className="fresh-agent-divergence-action shrink-0 rounded border border-border/70 px-2 py-1 text-xs"
                      aria-label="Attach the terminal here"
                      onClick={attachTerminalOwnerHere}
                    >
                      Attach here
                    </button>
                  ) : null}
                </div>
              ) : ownerDivergence?.inProgress ? (
                // b8ke focused round-5 R5-3: a SAME-KIND in-progress
                // lifecycle transition (the ready-replay fold of
                // starting/handoff/stopping, or a live handoff-started
                // broadcast naming this pane's kind) is transition-blocked:
                // the pane shows the transition state and suspends its
                // normal polling/scheduling until the transition settles.
                <div
                  className="fresh-agent-transition-card flex items-center justify-between gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-sm"
                  role="alert"
                  aria-label="Session transition in progress"
                  data-testid="fresh-agent-owner-transition-card"
                >
                  <span>This conversation is being reopened elsewhere…</span>
                </div>
              ) : null}
              {paneContent.handoffError ? (
                <SessionHandoffErrorBanner
                  error={paneContent.handoffError}
                  appStore={appStore}
                  tabId={tabId}
                  paneId={paneId}
                />
              ) : null}
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
                      ...(entry.id ? { id: entry.id } : {}),
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
                // Same resolution as the !command exec escape: the pane's
                // starting directory, falling back to the LIVE session cwd
                // so a resumed/API-created pane without an initialCwd still
                // fetches diffs instead of showing "Diff unavailable".
                cwd={paneContent.initialCwd ?? agentSession?.cwd}
                onComment={(text) => composerRef.current?.insertText(text)}
              />
            </div>
            <FreshAgentOpenSessionContext.Provider value={openDelegationSession}>
              <div
                className="relative min-h-0 flex-1"
                aria-busy={revealRefreshBlocking}
              >
                <div
                  className={cn('h-full min-h-0', revealRefreshBlocking && 'invisible')}
                  {...(revealRefreshBlocking
                    ? { 'aria-hidden': true, 'data-testid': 'fresh-agent-stale-transcript' }
                    : {})}
                >
                  <FreshAgentTranscript
                    ref={transcriptRef}
                    presentationPaused={revealRefreshBlocking}
                    paneId={paneId}
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
                    canRollback={canRollback}
                    rollbackBusy={isBusy}
                    rolledBackTurns={snapshot?.rolledBackTurns ?? []}
                    canRedo={canRedoNow}
                    redoableTurnIds={snapshot?.rollback?.redoableTurnIds}
                    // Conversation identity for the disclosure's conversation scoping.
                    // Codex snapshots carry NO sessionId (codex.rs stamps threadId
                    // only) — fall back to threadId so a codex pane re-collapses the
                    // history line across conversation switches too.
                    sessionId={snapshot?.sessionId ?? snapshot?.threadId}
                    agentLabel={descriptor?.label}
                    expandThinking={globalExpandThinking}
                    expandTools={globalExpandTools}
                    showTimecodes={effectiveShowTimecodes}
                    showTranscriptMinimap={showTranscriptMinimap}
                    isStreaming={isBusy}
                    onForkFromTurn={(turnId) => sendFork(turnId)}
                    onRollbackToTurn={(turnId) => {
                      // The busy pre-flight gate picks copy by DIRECTION (decision 7)…
                      if (isBusy) {
                        setNotice(ROLLBACK_BUSY_UNDO_NOTICE)
                        return
                      }
                      // …and a capability-false provider gets an explicit refusal (decision 8:
                      // no confirmations, explicit rejections, tooltips name the step).
                      if (canRollback) {
                        sendRollback('undo', 'toTurn', turnId)
                        return
                      }
                      setNotice(rollbackUnsupportedNotice(descriptor?.label ?? paneContent.provider))
                    }}
                    onRedoToTurn={(turnId) => {
                      if (isBusy) {
                        setNotice(ROLLBACK_BUSY_REDO_NOTICE)
                        return
                      }
                      if (canRedoNow) {
                        sendRollback('redo', 'toTurn', turnId)
                        return
                      }
                      setNotice(REDO_DESTROYED_NOTICE)
                    }}
                    onRewindToTurn={paneContent.initialCwd ? rewindToTurn : undefined}
                  />
                </div>
                {revealRefreshBlocking ? (
                  <div
                    className="absolute inset-0 z-20 flex items-center justify-center bg-background/80 px-4 backdrop-blur-[1px]"
                    role={snapshotRevealError ? 'alert' : 'status'}
                    aria-label={revealRefreshStatus}
                  >
                    {snapshotRevealError ? (
                      <div className="flex max-w-sm items-center gap-3 rounded-md border border-amber-500/50 bg-background px-3 py-2 text-sm shadow-sm">
                        <span>{snapshotRevealError}</span>
                        <button
                          type="button"
                          className="shrink-0 rounded border border-border/70 px-2 py-1 text-xs"
                          onClick={() => requestRevealRefresh(true)}
                        >
                          Retry
                        </button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2 rounded-md border border-border/70 bg-background px-3 py-2 text-sm shadow-sm">
                        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                        <span>Refreshing conversation…</span>
                      </div>
                    )}
                  </div>
                ) : null}
              </div>
            </FreshAgentOpenSessionContext.Provider>
            {/* Every fresh-agent pane gets the strip (unknown state included):
                the model chip opens the shared model dialog and the strip owns
                the bottom-chrome divider (the composer draws no border-top). */}
            <FreshAgentStatusStrip
              modelLabel={stripModelLabel ?? null}
              modelLabelShort={stripModelLabelShort ?? undefined}
              modelTooltip={stripModelTooltip}
              contextUsage={contextUsage}
              onOpenModelDialog={openModelDialog}
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
              cwd={paneContent.initialCwd ?? agentSession?.cwd}
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
              onReservedRollbackCommand={(direction) => setNotice(
                // kata 1wxv (r3 correction 8): typed reserved names that failed catalog
                // resolution land here. Codex /redo gets its pinned undo-only copy; any
                // other capability-false provider gets the parity notice. The wire-side
                // codex×redo refusal stays as backstop; gateRollbackCommand's codex
                // branch covers catalog-resolved and non-composer callers.
                direction === 'redo' && paneContent.provider === 'codex'
                  ? REDO_CODEX_UNSUPPORTED_NOTICE
                  : rollbackUnsupportedNotice(descriptor?.label ?? paneContent.provider),
              )}
              onShellCommand={runShellCommand}
              onSend={(text, attachmentPaths) => {
                dispatch(dismissTabGreen(tabId))
                if (!paneContent.sessionId || sessionEnded) return
                if (!canSend && !isBusy) return
                const outgoing = composeOutgoingText(text, attachmentPaths)
                if (!outgoing) return
                setQueuedMessages((queue) => [...queue, outgoing])
              }}
            />
            <FreshAgentModelDialog
              tabId={tabId}
              paneId={paneId}
              paneContent={paneContent}
              open={modelDialogOpen}
              onClose={closeModelDialog}
              onCatalogUnavailable={handleModelCatalogUnavailable}
              settingScopes={snapshot?.capabilities?.settingScopes}
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
    contextUsage,
    descriptor?.icon,
    descriptor?.label,
    freshOpenCodeRouteCwd,
    canRedoNow,
    canRollback,
    effectiveStatus,
    globalExpandThinking,
    effectiveShowTimecodes,
    showTranscriptMinimap,
    globalExpandTools,
    isBusy,
    isRestoring,
    loadError,
    localEcho,
    modelDialogOpen,
    closeModelDialog,
    openModelDialog,
    stripModelLabel,
    stripModelLabelShort,
    stripModelTooltip,
    handleModelCatalogUnavailable,
    notice,
    ownerDivergence,
    attachTerminalOwnerHere,
    paneContent,
    pendingCreateFailure,
    queuedMessages,
    hidden,
    requestRevealRefresh,
    restartStuckSidecar,
    rewindToTurn,
    openDelegationSession,
    runShellCommand,
    sessionEnded,
    sessionErrorMessage,
    startNewConversation,
    runSlashCommand,
    sendFork,
    sendRollback,
    snapshot,
    snapshotRevealError,
    snapshotDirty,
    slashCommands,
    dispatch,
    appStore,
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
