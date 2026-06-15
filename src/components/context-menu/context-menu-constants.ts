export const ContextIds = {
  Global: 'global',
  Tab: 'tab',
  TabAdd: 'tab-add',
  Pane: 'pane',
  PaneDivider: 'pane-divider',
  Terminal: 'terminal',
  Browser: 'browser',
  Editor: 'editor',
  PanePicker: 'pane-picker',
  SidebarSession: 'sidebar-session',
  HistoryProject: 'history-project',
  HistorySession: 'history-session',
  OverviewTerminal: 'overview-terminal',
  ClaudeMessage: 'claude-message',
  FreshAgent: 'fresh-agent',
} as const

export type ContextId = typeof ContextIds[keyof typeof ContextIds]
