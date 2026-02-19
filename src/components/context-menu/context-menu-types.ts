import React from 'react'
import type { ContextId } from './context-menu-constants'

export type ContextTarget =
  | { kind: 'global' }
  | { kind: 'tab'; tabId: string }
  | { kind: 'tab-add' }
  | { kind: 'pane'; tabId: string; paneId: string }
  | { kind: 'pane-divider'; tabId: string; splitId: string }
  | { kind: 'terminal'; tabId: string; paneId: string }
  | { kind: 'browser'; tabId: string; paneId: string }
  | { kind: 'editor'; tabId: string; paneId: string }
  | { kind: 'pane-picker'; tabId: string; paneId: string }
  | { kind: 'sidebar-session'; sessionId: string; provider?: string; runningTerminalId?: string; hasTab?: boolean }
  | { kind: 'history-project'; projectPath: string }
  | { kind: 'history-session'; sessionId: string; provider?: string }
  | { kind: 'overview-terminal'; terminalId: string }
  | { kind: 'claude-message'; sessionId: string; provider?: string }
  | { kind: 'freshclaude-chat'; sessionId: string }

export type ParsedContext = {
  id: ContextId
  target: ContextTarget
}

export type MenuItem =
  | {
      type: 'item'
      id: string
      label: string
      onSelect: () => void | Promise<void>
      disabled?: boolean
      danger?: boolean
      shortcut?: string
      icon?: React.ReactNode
    }
  | {
      type: 'separator'
      id: string
    }
