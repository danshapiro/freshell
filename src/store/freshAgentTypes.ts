import type {
  FreshAgentRuntimeProvider,
  FreshAgentSessionType,
} from '@shared/fresh-agent'
import type {
  FreshAgentPendingApproval,
  FreshAgentPendingQuestion,
  FreshAgentPendingElicitation,
  FreshAgentRequestId,
  FreshAgentSnapshot,
  FreshAgentTurn,
} from '@shared/fresh-agent-contract'
import type { SessionRuntimeOwnerMessage } from '@shared/ws-protocol'

export type { FreshAgentRequestId }
export type FreshAgentPermissionRequest = FreshAgentPendingApproval
export type FreshAgentQuestionRequest = FreshAgentPendingQuestion
export type FreshAgentThreadItem = FreshAgentTurn
export type FreshAgentThreadTurn = FreshAgentTurn
export type FreshAgentContentBlock = FreshAgentTurn['items'][number]
export type FreshAgentMessage = FreshAgentTurn

export type FreshAgentSessionStatus =
  | 'creating'
  | 'starting'
  | 'connected'
  | 'running'
  | 'idle'
  | 'compacting'
  | 'exited'
  | 'stuck'

export type FreshAgentSessionLocator = {
  sessionType: FreshAgentSessionType
  provider: FreshAgentRuntimeProvider
  sessionId: string
}

export type PendingCreateFailure = {
  code: string
  message: string
  retryable?: boolean
  /** kata b8ke: ownership-conflict refusals carry the owning kind, its
   *  generation, and the emitting server's boot epoch (preserved from the
   *  freshAgent.create.failed frame so the typed-conflict recovery UI can
   *  refresh its observed fence from the refusal itself). */
  ownerKind?: 'terminal' | 'fresh-agent'
  ownerGeneration?: number
  ownerEpoch?: number
}

/**
 * kata b8ke: the client-side runtime-owner record — one per canonical
 * (provider, sessionId), folded from `session.runtimeOwner` broadcasts and
 * the ready handshake's owner replay. The record KEEPS the transition state
 * (round-2 review: handoff-in-progress renders from it) until superseded by
 * a same-or-newer (epoch, generation) frame; a `handoff-failed` at
 * generation G supersedes a `handoff-started` at G.
 */
export type RuntimeOwnerRecord = {
  provider: string
  sessionId: string
  epoch: number
  generation: number
  ownerKind: 'terminal' | 'fresh-agent' | 'vacant'
  previousKind?: 'terminal' | 'fresh-agent'
  terminalId?: string
  transition: SessionRuntimeOwnerMessage['transition']
  reason?: string
  /** b8ke R3-5: the record is FENCED (the ownerKind names the fenced
   *  prior, not a live owner) — every pane holding the sessionRef shows
   *  the typed recovery state. */
  fenced?: boolean
  /** b8ke focused episode-2 post-cap F5: this key was RE-KEYED — the
   *  record's owner state is the CANONICAL key's (the server resolved the
   *  fixpoint) and `aliasOf` names the canonical id. A pane holding the
   *  pre-rekey sessionRef folds the authoritative owner state through
   *  this record and navigates future lifecycle operations to the
   *  canonical key. */
  aliasOf?: string
  updatedAt: number
}

export type FreshAgentPendingCreate = {
  sessionId?: string
  sessionKey?: string
  sessionType?: FreshAgentSessionType
  provider?: FreshAgentRuntimeProvider
  cwd?: string
  expectsHistoryHydration: boolean
}

export type FreshAgentSessionState = FreshAgentSessionLocator & {
  sessionKey: string
  threadId: string
  status: FreshAgentSessionStatus
  statusVersion?: number
  snapshot?: FreshAgentSnapshot
  latestTurnId?: string | null
  historySessionId?: string
  historyRevision?: number
  cliSessionId?: string
  cwd?: string
  model?: string | null
  /** The LIVE session's thinking level, folded from
   * `freshAgent.session.metadata` (string), JSON null (an explicit clear —
   * e.g. opencode's Default row), or absent while no metadata ever stated
   * it. The status-strip tooltip prefers it over the REST snapshot's
   * settings.effort: the event is fresher by construction. */
  effort?: string | null
  /** The LIVE session's permission mode as the server last stated it
   * (`freshAgent.session.metadata`): after a configure, or when the CLI
   * changed it itself (an approved ExitPlanMode leaves plan mode). Absent
   * while no metadata ever stated it. */
  permissionMode?: string
  tools?: Array<{ name: string }>
  turns: FreshAgentTurn[]
  historyItems: FreshAgentTurn[]
  historyBodies: Record<string, FreshAgentTurn>
  nextHistoryCursor?: string | null
  historyLoading?: boolean
  historyError?: string
  /** A streamed content block opened this turn (cleared when the turn ends). */
  streamingActive: boolean
  pendingPermissions: Record<string, FreshAgentPermissionRequest>
  pendingQuestions: Record<string, FreshAgentQuestionRequest>
  pendingElicitations?: Record<string, FreshAgentPendingElicitation>
  totalCostUsd: number
  totalInputTokens: number
  totalOutputTokens: number
  lastError?: string
  /// Task 14: the code that produced lastError -- the view filters
  /// SESSION_RESERVED out of the pane-level error banner (transient, re-driven).
  lastErrorCode?: string
  historyLoaded?: boolean
  awaitingDurableHistory?: boolean
  lost?: boolean
  restoreRetryCount?: number
  restoreFailureCode?: string
  restoreFailureMessage?: string
  snapshotRefreshRequestId?: number
  restoreHydrationRequestId?: number
}

export type FreshAgentState = {
  sessions: Record<string, FreshAgentSessionState>
  pendingCreates: Record<string, FreshAgentPendingCreate>
  pendingCreateFailures: Record<string, PendingCreateFailure>
  availableModels: Array<{ value: string; displayName: string; description: string }>
  /** kata b8ke: runtime-owner records keyed `${provider}:${sessionId}`. */
  runtimeOwners: Record<string, RuntimeOwnerRecord>
}
