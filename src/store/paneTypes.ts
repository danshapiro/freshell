import type { TerminalStatus, TabMode, ShellType } from './types'

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
  /** Initial working directory */
  initialCwd?: string
}

/**
 * Browser pane content for embedded web views.
 */
export type BrowserPaneContent = {
  kind: 'browser'
  url: string
  devToolsOpen: boolean
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
export type SdkSessionStatus = 'creating' | 'starting' | 'connected' | 'running' | 'idle' | 'compacting' | 'exited'

/**
 * freshclaude chat pane — rich chat UI powered by Claude Code SDK mode.
 */
export type ClaudeChatPaneContent = {
  kind: 'claude-chat'
  /** SDK session ID (undefined until created) */
  sessionId?: string
  /** Idempotency key for sdk.create */
  createRequestId: string
  /** Current status — uses SdkSessionStatus, not TerminalStatus */
  status: SdkSessionStatus
  /** Claude session to resume */
  resumeSessionId?: string
  /** Working directory */
  initialCwd?: string
  /** Model to use (default: claude-opus-4-6) */
  model?: string
  /** Permission mode (default: bypassPermissions) */
  permissionMode?: string
  /** Effort level (default: high, creation-time only) */
  effort?: 'low' | 'medium' | 'high' | 'max'
  /** Show thinking blocks in message feed (default: true) */
  showThinking?: boolean
  /** Show tool-use blocks in message feed (default: true) */
  showTools?: boolean
  /** Show timestamps on messages (default: false) */
  showTimecodes?: boolean
  /** Whether the user has dismissed the first-launch settings popover */
  settingsDismissed?: boolean
}

/**
 * Union type for all pane content types.
 */
export type PaneContent = TerminalPaneContent | BrowserPaneContent | EditorPaneContent | PickerPaneContent | ClaudeChatPaneContent

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
 * Input type for Claude Chat panes.
 * Lifecycle fields (createRequestId, status) are optional - reducer generates defaults.
 */
export type ClaudeChatPaneInput = Omit<ClaudeChatPaneContent, 'createRequestId' | 'status'> & {
  createRequestId?: string
  status?: SdkSessionStatus
}

export type PaneContentInput = TerminalPaneInput | BrowserPaneContent | EditorPaneInput | PickerPaneContent | ClaudeChatPaneInput

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
