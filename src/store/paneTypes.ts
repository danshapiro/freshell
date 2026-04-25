import type { TerminalStatus, TabMode, ShellType } from './types'
import type { AgentChatProviderName } from '@/lib/agent-chat-types'
import {
  AgentChatModelSelectionSchema,
  type AgentChatModelSelection,
} from '@shared/agent-chat-capabilities'
import type { SessionLocator as SharedSessionLocator } from '@shared/ws-protocol'

export type SessionLocator = SharedSessionLocator

export function isAgentChatModelSelection(value: unknown): value is AgentChatModelSelection {
  return AgentChatModelSelectionSchema.safeParse(value).success
}

export function normalizeAgentChatModelSelection(
  value: unknown,
  legacyModel?: unknown,
): AgentChatModelSelection | undefined {
  const parsed = AgentChatModelSelectionSchema.safeParse(value)
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

export function normalizeAgentChatEffortOverride(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/**
 * Terminal pane content with full lifecycle management.
 * Each terminal pane owns its backend terminal process.
 */
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
  /** Initial working directory */
  initialCwd?: string
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
}

/**
 * Picker pane content - shows pane type selection UI.
 */
export type PickerPaneContent = {
  kind: 'picker'
}

/** SDK session statuses — richer than TerminalStatus to reflect Claude Code lifecycle */
export type SdkSessionStatus = 'creating' | 'starting' | 'connected' | 'running' | 'idle' | 'compacting' | 'exited' | 'create-failed'

export type AgentChatCreateError = {
  code: string
  message: string
  retryable?: boolean
}

/**
 * Agent chat pane — rich chat UI powered by a configurable provider.
 */
export type AgentChatPaneContent = {
  kind: 'agent-chat'
  /** Which agent chat provider this pane uses */
  provider: AgentChatProviderName
  /** SDK session ID (undefined until created) */
  sessionId?: string
  /** Idempotency key for sdk.create */
  createRequestId: string
  /** Current status — uses SdkSessionStatus, not TerminalStatus */
  status: SdkSessionStatus
  /** Claude session to resume */
  resumeSessionId?: string
  /** Portable session reference for cross-device tab snapshots */
  sessionRef?: SessionLocator
  /** Working directory */
  initialCwd?: string
  /** Request-scoped create failure promoted into pane-local visible state. */
  createError?: AgentChatCreateError
  /** Stored selection strategy; omit to use the provider-default track. */
  modelSelection?: AgentChatModelSelection
  /** Permission mode (default from provider config) */
  permissionMode?: string
  /** Explicit effort override; omit to use the model default behavior. */
  effort?: string
  /** Plugin paths to load into this session (absolute paths to plugin directories) */
  plugins?: string[]
  /** Whether the user has dismissed the first-launch settings popover */
  settingsDismissed?: boolean
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
  | PickerPaneContent | AgentChatPaneContent | ExtensionPaneContent

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

/**
 * Input type for splitPane/initLayout actions.
 * Accepts either full content or partial terminal input.
 */
/**
 * Input type for Agent Chat panes.
 * Lifecycle fields (createRequestId, status) are optional - reducer generates defaults.
 */
export type AgentChatPaneInput = Omit<AgentChatPaneContent, 'createRequestId' | 'status'> & {
  createRequestId?: string
  status?: SdkSessionStatus
}

/**
 * Input type for extension panes.
 * Extension content needs no normalization — passes through unchanged.
 */
export type ExtensionPaneInput = ExtensionPaneContent

export type PaneContentInput = TerminalPaneInput | BrowserPaneInput | EditorPaneInput
  | PickerPaneContent | AgentChatPaneInput | ExtensionPaneInput

export type PaneRefreshTarget =
  | { kind: 'terminal'; createRequestId: string }
  | { kind: 'browser'; browserInstanceId: string }

export interface PaneRefreshRequest {
  requestId: string
  target: PaneRefreshTarget
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
