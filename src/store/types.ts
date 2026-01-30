export type TerminalStatus = 'creating' | 'running' | 'exited' | 'error'

export type TabMode = 'shell' | 'claude' | 'codex'

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
  claudeSessionId?: string     // For claude mode
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
  mode?: 'shell' | 'claude' | 'codex'
  resumeSessionId?: string
}

export interface ClaudeSession {
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
  sessions: ClaudeSession[]
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

export type TerminalTheme =
  | 'auto'           // Follow app theme (dark/light)
  | 'dracula'
  | 'one-dark'
  | 'solarized-dark'
  | 'github-dark'
  | 'one-light'
  | 'solarized-light'
  | 'github-light'

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
}
