export type TerminalStatus = 'creating' | 'running' | 'exited' | 'error'

import type { CodingCliProviderName } from '@shared/ws-protocol'
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
  sessionId: string
  projectPath: string
  createdAt?: number
  updatedAt: number
  messageCount?: number
  title?: string
  summary?: string
  cwd?: string
  archived?: boolean
  sourceFile?: string
  isSubagent?: boolean
  isNonInteractive?: boolean
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

export type SidebarSortMode = 'recency' | 'recency-pinned' | 'activity' | 'project'

export type DefaultNewPane = 'ask' | 'shell' | 'browser' | 'editor'

export type TabAttentionStyle = 'highlight' | 'pulse' | 'darken' | 'none'

export type AttentionDismiss = 'click' | 'type'

export type TerminalTheme =
  | 'auto'           // Follow app theme (dark/light)
  | 'dracula'
  | 'one-dark'
  | 'solarized-dark'
  | 'github-dark'
  | 'one-light'
  | 'solarized-light'
  | 'github-light'

export type Osc52ClipboardPolicy = 'ask' | 'always' | 'never'
export type TerminalRendererMode = 'auto' | 'webgl' | 'canvas'

export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

export type ClaudePermissionMode = 'default' | 'plan' | 'acceptEdits' | 'bypassPermissions'

export interface CodingCliSettings {
  enabledProviders: CodingCliProviderName[]
  providers: Partial<Record<CodingCliProviderName, {
    model?: string
    sandbox?: CodexSandboxMode
    permissionMode?: ClaudePermissionMode
    maxTurns?: number
    cwd?: string
  }>>
}

export interface AppSettings {
  theme: 'system' | 'light' | 'dark'
  uiScale: number // 1 = 100%, 1.5 = 150%, 2 = 200%
  terminal: {
    fontSize: number
    fontFamily: string
    lineHeight: number
    cursorBlink: boolean
    scrollback: number
    theme: TerminalTheme
    warnExternalLinks: boolean
    osc52Clipboard: Osc52ClipboardPolicy
    renderer: TerminalRendererMode
  }
  defaultCwd?: string
  logging: {
    debug: boolean
  }
  safety: {
    autoKillIdleMinutes: number
    warnBeforeKillMinutes: number
  }
  sidebar: {
    sortMode: SidebarSortMode
    showProjectBadges: boolean
    showSubagents: boolean
    showNoninteractiveSessions: boolean
    width: number // pixels, default 288 (equivalent to w-72)
    collapsed: boolean // for mobile/responsive use
  }
  notifications: {
    soundEnabled: boolean
  }
  codingCli: CodingCliSettings
  panes: {
    defaultNewPane: DefaultNewPane
    snapThreshold: number // 0-8, % of container's smallest dimension; 0 = off
    iconsOnTabs: boolean
    tabAttentionStyle: TabAttentionStyle
    attentionDismiss: AttentionDismiss
  }
  freshclaude?: {
    defaultModel?: string
    defaultPermissionMode?: string
    defaultEffort?: 'low' | 'medium' | 'high' | 'max'
  }
  network: {
    host: '127.0.0.1' | '0.0.0.0'
    configured: boolean
  }
}

export type {
  RegistryPaneSnapshot,
  RegistryTabRecord,
  RegistryTabStatus,
} from './tabRegistryTypes'
