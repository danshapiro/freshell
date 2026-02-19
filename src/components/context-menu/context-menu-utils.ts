import { ContextIds, type ContextId } from './context-menu-constants'
import type { ContextTarget } from './context-menu-types'

export type ContextDataset = Record<string, string | undefined>

export function copyDataset(dataset: DOMStringMap): ContextDataset {
  const result: ContextDataset = {}
  for (const [key, value] of Object.entries(dataset)) {
    result[key] = value
  }
  return result
}

export function clampToViewport(x: number, y: number, menuW: number, menuH: number, padding = 8) {
  const maxX = Math.max(padding, window.innerWidth - menuW - padding)
  const maxY = Math.max(padding, window.innerHeight - menuH - padding)
  return {
    x: Math.min(Math.max(x, padding), maxX),
    y: Math.min(Math.max(y, padding), maxY),
  }
}

export function isTextInputLike(el: HTMLElement | null): boolean {
  if (!el) return false
  const tag = el.tagName.toLowerCase()
  if (tag === 'input' || tag === 'textarea') return true
  if ((el as any).isContentEditable) return true
  return false
}

export function parseContextTarget(contextId: ContextId, data: ContextDataset): ContextTarget | null {
  switch (contextId) {
    case ContextIds.Global:
      return { kind: 'global' }
    case ContextIds.Tab:
      return data.tabId ? { kind: 'tab', tabId: data.tabId } : null
    case ContextIds.TabAdd:
      return { kind: 'tab-add' }
    case ContextIds.Pane:
      return data.tabId && data.paneId
        ? { kind: 'pane', tabId: data.tabId, paneId: data.paneId }
        : null
    case ContextIds.PaneDivider:
      return data.tabId && data.splitId
        ? { kind: 'pane-divider', tabId: data.tabId, splitId: data.splitId }
        : null
    case ContextIds.Terminal:
      return data.tabId && data.paneId
        ? { kind: 'terminal', tabId: data.tabId, paneId: data.paneId }
        : null
    case ContextIds.Browser:
      return data.tabId && data.paneId
        ? { kind: 'browser', tabId: data.tabId, paneId: data.paneId }
        : null
    case ContextIds.Editor:
      return data.tabId && data.paneId
        ? { kind: 'editor', tabId: data.tabId, paneId: data.paneId }
        : null
    case ContextIds.PanePicker:
      return data.tabId && data.paneId
        ? { kind: 'pane-picker', tabId: data.tabId, paneId: data.paneId }
        : null
    case ContextIds.SidebarSession:
      return data.sessionId
        ? {
            kind: 'sidebar-session',
            sessionId: data.sessionId,
            provider: data.provider,
            runningTerminalId: data.runningTerminalId,
            hasTab: data.hasTab === 'true' ? true : data.hasTab === 'false' ? false : undefined,
          }
        : null
    case ContextIds.HistoryProject:
      return data.projectPath ? { kind: 'history-project', projectPath: data.projectPath } : null
    case ContextIds.HistorySession:
      return data.sessionId ? { kind: 'history-session', sessionId: data.sessionId, provider: data.provider } : null
    case ContextIds.OverviewTerminal:
      return data.terminalId ? { kind: 'overview-terminal', terminalId: data.terminalId } : null
    case ContextIds.ClaudeMessage:
      return data.sessionId ? { kind: 'claude-message', sessionId: data.sessionId, provider: data.provider } : null
    case ContextIds.FreshclaudeChat:
      return data.sessionId ? { kind: 'freshclaude-chat', sessionId: data.sessionId } : null
    default:
      return null
  }
}
