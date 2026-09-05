import type { TerminalStatus, TabMode, ShellType } from './types'
import {
  FreshAgentModelSelectionSchema,
  type FreshAgentModelSelection,
} from '@shared/fresh-agent-model-capabilities'
import type { SessionLocator as SharedSessionLocator } from '@shared/ws-protocol'
import type { RestoreError, CrashTrace } from '@shared/session-contract'
import type { CodexDurabilityRef } from '@shared/codex-durability'
import type { FreshAgentRuntimeProvider, FreshAgentSessionType } from '@shared/fresh-agent'
import type { FreshAgentStyle } from '@shared/settings'

export type SessionLocator = SharedSessionLocator

export function isFreshAgentModelSelection(value: unknown): value is FreshAgentModelSelection {
  return FreshAgentModelSelectionSchema.safeParse(value).success
}

export function normalizeFreshAgentModelSelection(
  value: unknown,
  legacyModel?: unknown,
): FreshAgentModelSelection | undefined {
  const parsed = FreshAgentModelSelectionSchema.safeParse(value)
  if (parsed.success) {
    return parsed.data
  }

  if (typeof legacyModel === 'string' && legacyModel.trim().length > 0) {
    return {
      kind: 'exact',
      modelId: legacyModel,
    }
  }

  return undefined
}

const LEGACY_FRESHOPENCODE_DEFAULT_MODEL = 'opencode-go/deepseek-v4-flash'

export function normalizeFreshAgentPaneModelSelection(args: {
  sessionType?: unknown
  provider?: unknown
  modelSelection?: unknown
  legacyModel?: unknown
}): FreshAgentModelSelection | undefined {
  const explicitSelection = normalizeFreshAgentModelSelection(args.modelSelection)
  if (explicitSelection) return explicitSelection

  if (
    args.sessionType === 'freshopencode'
    && args.provider === 'opencode'
    && typeof args.legacyModel === 'string'
    && args.legacyModel.trim() === LEGACY_FRESHOPENCODE_DEFAULT_MODEL
  ) {
    return undefined
  }
  return normalizeFreshAgentModelSelection(undefined, args.legacyModel)
}

export function normalizeFreshAgentEffortOverride(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

export function normalizeFreshAgentModelEffortLevels(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined
  }
  return value.filter((level): level is string => typeof level === 'string')
}

/**
 * Terminal pane content with full lifecycle management.
 * Each terminal pane owns its backend terminal process.
 */
/** Persistent crash trace (kata znhn item 1): "crashed & auto-resumed" —
 * survives reload (pane-content persistence is a denylist) until the user
 * dismisses it or the pane closes. Shape + schema live in
 * `@shared/session-contract` (`CrashTraceSchema`) beside its persisted
 * siblings; re-exported here where pane content consumers import from. */
export type { CrashTrace }

export type TerminalPaneContent = {
  kind: 'terminal'
  /** Backend terminal ID (undefined until created) */
  terminalId?: string
  /** Idempotency key for terminal.create requests */
  createRequestId: string
  /** Current terminal status */
  status: TerminalStatus
  /** Terminal mode: shell, claude, or codex */
  mode: TabMode
  /** Shell type (optional, defaults to 'system') */
  shell?: ShellType
  /** Claude session to resume */
  resumeSessionId?: string
  /** Portable session reference for cross-device tab snapshots */
  sessionRef?: SessionLocator
  /** Non-canonical Codex restore durability state and proof metadata. */
  codexDurability?: CodexDurabilityRef
  /** Runtime-only server locality for same-server matching; never part of canonical durable identity. */
  serverInstanceId?: string
  /** Runtime output stream identity from terminal.attach.ready; invalidates delta replay after stream replacement. */
  streamId?: string
  /** Explicit restore failure when no canonical durable target exists. */
  restoreError?: RestoreError
  /** Initial working directory */
  initialCwd?: string
  /** One-shot user-visible reconcile notice (corrected identity, fresh-by-reason, duplicate ignored). Rendered then cleared by TerminalView. */
  reconcileNotice?: string
  /** Set by verdict folding; consumed by TerminalView when it sends terminal.create. 'respawn' = create-with-resume from sessionRef; 'fresh' = clean create. */
  pendingReconcile?: 'respawn' | 'fresh'
  /** VOLATILE fold counter. Incremented by applyReconcileAttach / resetPaneForReconcileCreate so a fold on an already-mounted pane (same createRequestId — never re-minted) re-fires TerminalView's create-or-attach effect (Task 12 adds it to the dep array). Stripped from persistence (Task 8). */
  reconcileEpoch?: number
  /** znhn item 1: persisted deliberately — do NOT add to
   * stripTransientSessionFields. Absent on old layouts = no trace. */
  crashTrace?: CrashTrace
}

/**
 * Browser pane content for embedded web views.
 */
export type BrowserPaneContent = {
  kind: 'browser'
  browserInstanceId: string
  url: string
  devToolsOpen: boolean
}

export type BrowserPaneInput = Omit<BrowserPaneContent, 'browserInstanceId'> & {
  browserInstanceId?: string
}

/**
 * Editor pane content for Monaco-based file editing.
 */
export type EditorPaneContent = {
  kind: 'editor'
  /** File path being edited, null for scratch pad */
  filePath: string | null
  /** Language for syntax highlighting, null for auto-detect */
  language: string | null
  /** Whether the file is read-only */
  readOnly: boolean
  /** Current buffer content */
  content: string
  /** View mode: source editor or rendered preview */
  viewMode: 'source' | 'preview'
  /** Line wrap toggle (default true) */
  wordWrap: boolean
}

/**
 * Picker pane content - shows pane type selection UI.
 */
export type PickerPaneContent = {
  kind: 'picker'
}

/**
 * Host stats pane content — the host pressure dashboard (CPU/memory/PSI/IO).
 * Stateless: every value lives in the connection-level hostStats slice, so a
 * host-stats leaf carries no fields beyond its kind.
 */
export type HostStatsPaneContent = {
  kind: 'host-stats'
}

/** SDK session statuses — richer than TerminalStatus to reflect Claude Code lifecycle */
export type SdkSessionStatus = 'creating' | 'starting' | 'connected' | 'running' | 'idle' | 'compacting' | 'exited' | 'create-failed'

export type FreshAgentCreateError = {
  code: string
  message: string
  retryable?: boolean
}

export type FreshAgentPendingLocalEcho = {
  requestId: string
  text: string
  submittedTurnId?: string
}

export function normalizeFreshAgentPendingLocalEcho(value: unknown): FreshAgentPendingLocalEcho | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (typeof record.requestId !== 'string' || record.requestId.length === 0) return undefined
  if (typeof record.text !== 'string' || record.text.length === 0) return undefined
  return {
    requestId: record.requestId,
    text: record.text,
    ...(typeof record.submittedTurnId === 'string' && record.submittedTurnId.length > 0
      ? { submittedTurnId: record.submittedTurnId }
      : {}),
  }
}

export type FreshAgentPaneContent = {
  kind: 'fresh-agent'
  sessionType: FreshAgentSessionType
  provider: FreshAgentRuntimeProvider
  sessionId?: string
  createRequestId: string
  status: SdkSessionStatus
  resumeSessionId?: string
  sessionRef?: SessionLocator
  /** Runtime-only server locality for same-server matching; never part of canonical durable identity. */
  serverInstanceId?: string
  /** Explicit restore failure when no canonical durable target exists. */
  restoreError?: RestoreError
  initialCwd?: string
  createError?: FreshAgentCreateError
  modelSelection?: FreshAgentModelSelection
  model?: string
  permissionMode?: string
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access'
  effort?: string
  /** Effort levels for the current model as known at selection time (static
   * or probed catalog), stamped by the settings selector's model switch. An
   * empty array is still a stamp: the selected model declared no levels.
   * Absent for panes created outside the selector (REST/MCP/restored) —
   * those fall back to static-table normalization, unchanged. */
  modelEffortLevels?: string[]
  /** Display label for the pane's model as known at pick time (static-table or
   * probed catalog label), stamped by the selectors together with the model id.
   * Id-paired: readers apply it only while the pane's effective model id still
   * equals `modelId`, so a writer that changes the model without restamping can
   * never mislabel the chip. */
  modelLabel?: { modelId: string; label: string }
  plugins?: string[]
  /** Visual style for this pane; missing legacy panes resolve from provider defaults, then sans. */
  style?: FreshAgentStyle
  settingsDismissed?: boolean
  showThinking?: boolean
  showTools?: boolean
  showTimecodes?: boolean
  /** Persisted optimistic user turn that has not yet appeared in a durable provider snapshot. */
  pendingLocalEcho?: FreshAgentPendingLocalEcho
  /** One-shot user-visible reconcile notice; rendered + cleared by FreshAgentView. VOLATILE. */
  reconcileNotice?: string
  /** Set by verdict folds; consumed when freshAgent.created lands. VOLATILE. */
  pendingReconcile?: 'respawn' | 'fresh'
  /** VOLATILE fold counter — re-fires FreshAgentView's create effect on same-createRequestId folds. */
  reconcileEpoch?: number
}

/**
 * Extension pane content — generic catch-all for extension-system panes.
 */
export type ExtensionPaneContent = {
  kind: 'extension'
  extensionName: string
  props: Record<string, unknown>
}

/**
 * Union type for all pane content types.
 */
export type PaneContent = TerminalPaneContent | BrowserPaneContent | EditorPaneContent
  | PickerPaneContent | FreshAgentPaneContent | ExtensionPaneContent | HostStatsPaneContent

/**
 * Input type for creating terminal panes.
 * Lifecycle fields (createRequestId, status) are optional - reducer generates defaults.
 */
export type TerminalPaneInput = Omit<TerminalPaneContent, 'createRequestId' | 'status'> & {
  createRequestId?: string
  status?: TerminalStatus
}

/**
 * Input type for editor panes.
 * Same as EditorPaneContent since no lifecycle fields need defaults.
 */
export type EditorPaneInput = EditorPaneContent

export type FreshAgentPaneInput = Omit<FreshAgentPaneContent, 'createRequestId' | 'status'> & {
  createRequestId?: string
  status?: SdkSessionStatus
}

/**
 * Input type for extension panes.
 * Extension content needs no normalization — passes through unchanged.
 */
export type ExtensionPaneInput = ExtensionPaneContent

export type LivePaneContentInput = TerminalPaneInput | BrowserPaneInput | EditorPaneInput
  | PickerPaneContent | FreshAgentPaneInput | ExtensionPaneInput | HostStatsPaneContent

export type LegacyPaneContentInput = Record<string, unknown>

export type PaneContentInput = LivePaneContentInput | LegacyPaneContentInput

export type PaneRefreshTarget =
  | { kind: 'terminal'; createRequestId: string }
  | { kind: 'browser'; browserInstanceId: string }
  | {
    kind: 'fresh-agent'
    createRequestId: string
    sessionId?: string
    sessionType: FreshAgentPaneContent['sessionType']
    provider: FreshAgentPaneContent['provider']
  }

export interface PaneRefreshRequest {
  requestId: string
  target: PaneRefreshTarget
}

export type RestoreFallbackAttempt = {
  staleTerminalId: string
  requestId: string
  reason: 'dead_live_handle_without_session_ref'
}

/**
 * One pane awaiting user adjudication after the server reported its
 * session dead in a pane.reconcile verdict. Council rule 12: dead_session
 * is a UI state, not a deletion — the pane stays until the user decides.
 */
export type DeadSessionEntry = {
  tabId: string
  paneId: string
  title: string
  mode: string
  /** Absent = terminal (backwards compatible). */
  kind?: 'terminal' | 'fresh-agent'
  sessionRef?: { provider: string; sessionId: string }
  reason?: string
}

/**
 * Slice-level banner state while reconcile-driven creates are warming.
 * Ephemeral — must never be persisted.
 */
export type ReconcileWarmingState = {
  count: number
  paneRefs: { tabId: string; paneId: string }[]
}

/**
 * Recursive tree structure for pane layouts.
 * A leaf is a single pane with content.
 * A split divides space between two children.
 */
export type PaneNode =
  | { type: 'leaf'; id: string; content: PaneContent }
  | { type: 'split'; id: string; direction: 'horizontal' | 'vertical'; children: [PaneNode, PaneNode]; sizes: [number, number] }

/**
 * Redux state for pane layouts (runtime)
 */
export interface PanesState {
  /** Map of tabId -> root pane node */
  layouts: Record<string, PaneNode>
  /** Map of tabId -> currently focused pane id */
  activePane: Record<string, string>
  /**
   * Map of tabId -> paneId -> explicit title override.
   * Used to keep user-edited or derived titles stable across renders.
   */
  paneTitles: Record<string, Record<string, string>>
  /** Map of tabId -> paneId -> whether the user explicitly set the title */
  paneTitleSetByUser: Record<string, Record<string, boolean>>
  /**
   * Ephemeral UI signal: request PaneContainer to enter inline rename mode.
   * Must never be persisted.
   */
  renameRequestTabId: string | null
  renameRequestPaneId: string | null
  /**
   * Ephemeral zoom state: map of tabId -> zoomed paneId.
   * When set, only the zoomed pane renders; the rest of the tree is hidden but preserved.
   * Must never be persisted.
   */
  zoomedPane: Record<string, string | undefined>
  /**
   * Ephemeral one-shot refresh requests keyed by tab and pane id.
   * Must never be persisted.
   */
  refreshRequestsByPane: Record<string, Record<string, PaneRefreshRequest>>
  /**
   * Ephemeral one-shot fresh recovery guards keyed by tab and pane id.
   * Must never be persisted.
   */
  restoreFallbackAttemptsByPane: Record<string, Record<string, RestoreFallbackAttempt>>
  /**
   * Batched dead-session adjudication list from pane.reconcile verdicts.
   * Ephemeral UI state — must never be persisted.
   */
  deadSessionAdjudication?: DeadSessionEntry[]
  /**
   * Reconcile warming banner state while reconcile-driven creates run.
   * Ephemeral UI state — must never be persisted.
   */
  reconcileWarming?: ReconcileWarmingState | null
  /** Ephemeral: paneKey -> wall-clock ms when a reconcile request naming this pane went out.
   *  While present (and young), the pane's mount drive defers its create until the verdict folds. */
  reconcilePendingPanes?: Record<string, number>
}

/**
 * Persisted panes state (localStorage format).
 * Extends PanesState with version for migrations.
 * NOTE: This type is only for documentation - not used in runtime code.
 */
export interface PersistedPanesState extends PanesState {
  /** Schema version for migrations. */
  version: number
}
