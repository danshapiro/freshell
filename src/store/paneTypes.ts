/**
 * Content that can be displayed in a pane
 */
export type PaneContent =
  | { kind: 'terminal'; terminalId?: string; mode?: 'shell' | 'claude' | 'codex'; resumeSessionId?: string; initialCwd?: string }
  | { kind: 'browser'; url: string; devToolsOpen: boolean }

/**
 * Recursive tree structure for pane layouts.
 * A leaf is a single pane with content.
 * A split divides space between two children.
 */
export type PaneNode =
  | { type: 'leaf'; id: string; content: PaneContent }
  | { type: 'split'; id: string; direction: 'horizontal' | 'vertical'; children: [PaneNode, PaneNode]; sizes: [number, number] }

/**
 * Redux state for pane layouts
 */
export interface PanesState {
  /** Map of tabId -> root pane node */
  layouts: Record<string, PaneNode>
  /** Map of tabId -> currently focused pane id */
  activePane: Record<string, string>
}
