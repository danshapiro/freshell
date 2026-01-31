export type TerminalStatus = 'creating' | 'running' | 'exited' | 'error'

export type CodingCliProviderName = 'claude' | 'codex' | 'opencode' | 'gemini' | 'kimi'

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
  resumeSessionId?: string
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
  updatedAt: number
  messageCount?: number
  title?: string
  summary?: string
  cwd?: string
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
}

export interface TerminalOverride {
  titleOverride?: string
  descriptionOverride?: string
  deleted?: boolean
}

export type SidebarSortMode = 'recency' | 'activity' | 'project'

export type DefaultNewPane = 'ask' | 'shell' | 'browser' | 'editor'

export type TerminalTheme =
  | 'auto'           // Follow app theme (dark/light)
  | 'dracula'
  | 'one-dark'
  | 'solarized-dark'
  | 'github-dark'
  | 'one-light'
  | 'solarized-light'
  | 'github-light'

export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

export type ClaudePermissionMode = 'default' | 'plan' | 'acceptEdits' | 'bypassPermissions'

export interface CodingCliSettings {
  enabledProviders: CodingCliProviderName[]
  providers: Partial<Record<CodingCliProviderName, {
    model?: string
    sandbox?: CodexSandboxMode
    permissionMode?: ClaudePermissionMode
    maxTurns?: number
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
  }
  defaultCwd?: string
  safety: {
    autoKillIdleMinutes: number
    warnBeforeKillMinutes: number
  }
  sidebar: {
    sortMode: SidebarSortMode
    showProjectBadges: boolean
    width: number // pixels, default 288 (equivalent to w-72)
    collapsed: boolean // for mobile/responsive use
  }
  codingCli: CodingCliSettings
  panes: {
    defaultNewPane: DefaultNewPane
  }
  notifications: {
    /** Show pulsing indicator on tab when terminal is actively streaming output */
    visualWhenWorking: boolean
    /** Show "ready" badge on tab when streaming finishes (clears when tab is selected) */
    visualWhenFinished: boolean
    /** Play sound when streaming finishes on a background tab */
    soundWhenFinished: boolean
  }
}
