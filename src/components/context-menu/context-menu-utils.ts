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

/**
 * The rectangle of the viewport actually visible to the user, in
 * layout-viewport (position: fixed) coordinates.
 *
 * On mobile, the on-screen keyboard shrinks `window.visualViewport` while
 * `window.innerHeight` (the layout viewport) usually stays unchanged, so
 * clamping against the layout viewport can place a fixed-position menu
 * underneath the keyboard. Prefer the visual viewport when the browser
 * provides it; fall back to the layout viewport otherwise (older browsers,
 * jsdom).
 */
export function getVisibleViewportRect(): {
  left: number
  top: number
  width: number
  height: number
} {
  const vv = typeof window !== 'undefined' ? window.visualViewport : null
  if (vv) {
    return { left: vv.offsetLeft, top: vv.offsetTop, width: vv.width, height: vv.height }
  }
  return { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight }
}

export function clampToViewport(x: number, y: number, menuW: number, menuH: number, padding = 8) {
  const viewport = getVisibleViewportRect()
  const minX = viewport.left + padding
  const minY = viewport.top + padding
  const maxX = Math.max(minX, viewport.left + viewport.width - menuW - padding)
  const maxY = Math.max(minY, viewport.top + viewport.height - menuH - padding)
  return {
    x: Math.min(Math.max(x, minX), maxX),
    y: Math.min(Math.max(y, minY), maxY),
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
    case ContextIds.PaneHeader:
      return data.tabId && data.paneId
        ? { kind: 'pane', tabId: data.tabId, paneId: data.paneId }
        : null
    case ContextIds.PaneDivider:
      return data.tabId && data.splitId
        ? { kind: 'pane-divider', tabId: data.tabId, splitId: data.splitId }
        : null
    case ContextIds.Terminal:
      return data.tabId && data.paneId
        ? {
            kind: 'terminal',
            tabId: data.tabId,
            paneId: data.paneId,
            hoveredUrl: data.hoveredUrl,
          }
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
            sessionType: data.sessionType,
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
    case ContextIds.FreshAgent:
      return data.sessionId || (data.tabId && data.paneId)
        ? {
            kind: 'fresh-agent',
            sessionId: data.sessionId,
            tabId: data.tabId,
            paneId: data.paneId,
            provider: data.provider,
            sessionType: data.sessionType,
          }
        : null
    case ContextIds.TabsCard:
      return data.tabKey
        ? { kind: 'tabs-card', tabKey: data.tabKey, status: data.tabStatus === 'closed' ? 'closed' : 'open' }
        : null
    default:
      return null
  }
}
