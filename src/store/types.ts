export type TerminalStatus = 'creating' | 'running' | 'recovering' | 'exited' | 'error'

import type {
  AttentionDismiss,
  ClaudePermissionMode,
  CodingCliSettings,
  CodexSandboxMode,
  DefaultNewPane,
  LocalSettings,
  LocalSettingsPatch,
  Osc52ClipboardPolicy,
  ResolvedSettings,
  SessionOpenMode,
  ServerSettings,
  ServerSettingsPatch,
  SidebarSortMode,
  TerminalRendererMode,
  TerminalTheme,
  TabAttentionStyle,
  WorktreeGrouping,
} from '@shared/settings'
import type { CodingCliProviderName, TokenSummary, SessionLocator } from '@shared/ws-protocol'
import type { CodexDurabilityRef } from '@shared/codex-durability'
import type {
  SessionNameRecord,
  SessionNameRef,
  TabNameSource,
} from '@shared/session-names'
import type { TitleSource } from '../../shared/title-source'
import type { ManagedRuntimeProjectionFields } from '@shared/managed-runtime'
export type { CodingCliProviderName }

// TabMode includes 'shell' for regular terminals, plus all coding CLI providers
// This allows future providers (opencode, gemini, kimi) to work as tab modes
export type TabMode = 'shell' | CodingCliProviderName

/**
 * Shell type for terminal creation.
 * - 'system': Use the platform's default shell ($SHELL on macOS/Linux, cmd on Windows)
 * - 'cmd': Windows Command Prompt (Windows only)
 * - 'powershell': Windows PowerShell (Windows only)
 * - 'wsl': Windows Subsystem for Linux (Windows only)
 *
 * On macOS/Linux, all values normalize to 'system' (uses $SHELL or fallback).
 */
export type ShellType = 'system' | 'cmd' | 'powershell' | 'wsl'

export interface SessionListMetadata {
  sessionType?: string
  firstUserMessage?: string
  isSubagent?: boolean
  isNonInteractive?: boolean
}

export interface Tab extends ManagedRuntimeProjectionFields {
  id: string
  createRequestId: string
  title: string
  description?: string
  codingCliProvider?: CodingCliProviderName
  status: TerminalStatus
  mode: TabMode
  shell?: ShellType
  initialCwd?: string
  sessionRef?: SessionLocator
  codexDurability?: CodexDurabilityRef
  serverInstanceId?: string
  resumeSessionId?: string     // Legacy migration field; canonical durable identity lives in sessionRef
  sessionMetadataByKey?: Record<string, SessionListMetadata>
  createdAt: number
  updatedAt?: number
  titleSetByUser?: boolean     // If true, don't auto-update title
  lastInputAt?: number
  /**
   * Unified agent names (Task 1): which session names this tab — a stable
   * source-pane relationship, never a separately stored tab name. Absent
   * until initial content or migration resolves ownership (undefined ⇒
   * existing non-agent derivation).
   */
  nameSource?: TabNameSource
}

export interface BackgroundTerminal {
  terminalId: string
  title: string
  createdAt: number
  lastActivityAt: number
  cwd?: string
  status: 'running' | 'exited'
  runtimeStatus?: 'running' | 'recovering'
  hasClients: boolean
  mode?: TabMode
  sessionRef?: SessionLocator
  codexDurability?: CodexDurabilityRef
  /**
   * Server-computed: this terminal's resume target is an opencode
   * SUBAGENT (child) session. Manufactured rail entries and tab/pane
   * fallback rows copy it into SidebarSessionItem.isSubagent so
   * showSubagents filtering applies.
   */
  resumeTargetIsSubagent?: boolean
  /** Unified agent names (Task 1): canonical name projection (last-known). */
  sessionName?: SessionNameRecord
  /** Unified agent names (Task 1): the naming identity this terminal's
   * displayed name resolves through. */
  nameRef?: SessionNameRef
}

export interface CodingCliSession {
  provider: CodingCliProviderName
  sessionType?: string
  sessionId: string
  projectPath: string
  checkoutPath?: string
  createdAt?: number
  lastActivityAt: number
  messageCount?: number
  title?: string
  summary?: string
  firstUserMessage?: string
  cwd?: string
  archived?: boolean
  sourceFile?: string
  isSubagent?: boolean
  isNonInteractive?: boolean
  isRunning?: boolean
  runningTerminalId?: string
  liveTerminalOnly?: boolean
  gitBranch?: string
  isDirty?: boolean
  tokenUsage?: TokenSummary
  /**
   * b5fb provenance exposure for the reviewed reset flow: true exactly when a
   * stored titleOverride currently applies to this row; `providerTitle` is the
   * parsed pre-override title (absent when none was parsed);
   * `titleOverrideSource` is the applied override's recorded titleSource
   * (absent when the override never recorded one).
   */
  titleOverridden?: boolean
  providerTitle?: string
  titleOverrideSource?: TitleSource
  /**
   * Client-side only monotonic fetch stamp set by the sessions commit
   * reducer (sessionsSlice commitWindowPayload): rows freshly fetched in a
   * commit get the next counter value; rows RETAINED from an earlier fetch
   * keep their old stamps. Never sent to the server, never persisted —
   * the session-title mirror keys row freshness on it.
   */
  fetchSeq?: number
  /**
   * Unified agent names (Task 1): the canonical naming identity for this
   * row's session (pending handle before durable identity exists).
   */
  nameRef?: SessionNameRef
  /**
   * Unified agent names (Task 2 projection): the durable record's CURRENT
   * name (a plain string — the server merges it onto every directory row
   * additively; manual/legacy-protected names also win the displayed
   * `title`). The canonical sessionNames cache stays the live display
   * authority; this is the row's last-known projection.
   */
  sessionName?: string
}

export interface ProjectGroup {
  projectPath: string
  sessions: CodingCliSession[]
  color?: string
}

export interface SessionOverride {
  titleOverride?: string
  summaryOverride?: string
  deleted?: boolean
  archived?: boolean
  createdAtOverride?: number
}

export interface TerminalOverride {
  titleOverride?: string
  descriptionOverride?: string
  deleted?: boolean
}

export type {
  AttentionDismiss,
  ClaudePermissionMode,
  CodingCliSettings,
  CodexSandboxMode,
  DefaultNewPane,
  LocalSettings,
  LocalSettingsPatch,
  Osc52ClipboardPolicy,
  SessionOpenMode,
  ServerSettings,
  ServerSettingsPatch,
  SidebarSortMode,
  TabAttentionStyle,
  TerminalRendererMode,
  TerminalTheme,
  WorktreeGrouping,
}

export type AppSettings = ResolvedSettings

export type {
  RegistryPaneSnapshot,
  RegistryTabRecord,
  RegistryTabStatus,
} from './tabRegistryTypes'
