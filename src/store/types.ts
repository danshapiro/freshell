export type TerminalStatus = 'creating' | 'running' | 'exited' | 'error'

import type {
  AgentChatEffort,
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
import type { CodingCliProviderName, TokenSummary } from '@shared/ws-protocol'
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

export interface Tab {
  id: string
  createRequestId: string
  title: string
  description?: string
  terminalId?: string          // For shell mode
  codingCliSessionId?: string  // For coding CLI session view
  codingCliProvider?: CodingCliProviderName
  claudeSessionId?: string     // Legacy field (migrated to codingCliSessionId)
  status: TerminalStatus
  mode: TabMode
  shell?: ShellType
  initialCwd?: string
  resumeSessionId?: string     // Mirrored from pane content on session association; serves as fallback if pane layout is lost
  sessionMetadataByKey?: Record<string, SessionListMetadata>
  createdAt: number
  titleSetByUser?: boolean     // If true, don't auto-update title
  lastInputAt?: number
}

export interface BackgroundTerminal {
  terminalId: string
  title: string
  createdAt: number
  lastActivityAt: number
  cwd?: string
  status: 'running' | 'exited'
  hasClients: boolean
  mode?: TabMode
  resumeSessionId?: string
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
  gitBranch?: string
  isDirty?: boolean
  tokenUsage?: TokenSummary
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
  AgentChatEffort,
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
