import type { ActionSheetItem } from '@/components/fresh-agent/FreshAgentActionSheet'

export type TerminalActions = {
  copySelection: () => Promise<void> | void
  paste: () => Promise<void> | void
  selectAll: () => void
  clearScrollback: () => void
  reset: () => void
  scrollToBottom: () => void
  hasSelection: () => boolean
  openSearch: () => void
}

export type EditorActions = {
  cut: () => Promise<void> | void
  copy: () => Promise<void> | void
  paste: () => Promise<void> | void
  selectAll: () => Promise<void> | void
  saveNow: () => Promise<void> | void
  togglePreview: () => void
  copyPath: () => Promise<void> | void
  revealInExplorer: () => Promise<void> | void
  openInEditor: () => Promise<void> | void
}

export type BrowserActions = {
  back: () => void
  forward: () => void
  reload: () => void
  stop: () => void
  copyUrl: () => Promise<void> | void
  openExternal: () => void
  toggleDevTools: () => void
}

const terminalRegistry = new Map<string, TerminalActions>()
const editorRegistry = new Map<string, EditorActions>()
const browserRegistry = new Map<string, BrowserActions>()

/** kata 1wxv: fresh-agent pane rollback actions (undo/redo last turn), consumed
 * by the pane context menu. undoSupported/redoSupported stamp the provider's
 * snapshot capabilities (codex is undo-only) and decide ROW PRESENCE; canUndo/
 * canRedo are stamped per registration from the owning view's busy state and
 * decide ENABLED state on shown rows. */
export type FreshAgentPaneActions = {
  undo: () => void
  redo: () => void
  canUndo: boolean
  canRedo: boolean
  undoSupported: boolean
  redoSupported: boolean
}

const freshAgentActionsRegistry = new Map<string, FreshAgentPaneActions>()

export function registerFreshAgentPaneActions(paneId: string, actions: FreshAgentPaneActions): () => void {
  freshAgentActionsRegistry.set(paneId, actions)
  return () => {
    freshAgentActionsRegistry.delete(paneId)
  }
}

export function getFreshAgentPaneActions(paneId: string): FreshAgentPaneActions | undefined {
  return freshAgentActionsRegistry.get(paneId)
}

/**
 * Per-turn action items for the unified fresh-agent context menu, keyed by the
 * owning pane. Registered by FreshAgentTranscript (the one place that can map
 * a rendered article index to its action turn through the merged-line layout);
 * consumed by the global ContextMenuProvider's fresh-agent menu builder, which
 * prepends them for plain-text turn regions. Shares the item vocabulary with
 * the touch action sheet (both flow from buildTurnActionItems), so desktop and
 * mobile never drift. null/undefined means "no turn at that article index" —
 * the menu then shows only its region/base rows.
 */
export type FreshAgentTurnItemsBuilder = (articleIndex: number) => ActionSheetItem[] | null

const freshAgentTurnItemsRegistry = new Map<string, FreshAgentTurnItemsBuilder>()

export function registerFreshAgentTurnItems(paneId: string, builder: FreshAgentTurnItemsBuilder): () => void {
  freshAgentTurnItemsRegistry.set(paneId, builder)
  return () => {
    if (freshAgentTurnItemsRegistry.get(paneId) === builder) {
      freshAgentTurnItemsRegistry.delete(paneId)
    }
  }
}

export function getFreshAgentTurnItemsBuilder(paneId: string): FreshAgentTurnItemsBuilder | undefined {
  return freshAgentTurnItemsRegistry.get(paneId)
}

export function registerTerminalActions(paneId: string, actions: TerminalActions): () => void {
  terminalRegistry.set(paneId, actions)
  return () => {
    if (terminalRegistry.get(paneId) === actions) {
      terminalRegistry.delete(paneId)
    }
  }
}

export function getTerminalActions(paneId: string): TerminalActions | undefined {
  return terminalRegistry.get(paneId)
}

export function registerEditorActions(paneId: string, actions: EditorActions): () => void {
  editorRegistry.set(paneId, actions)
  return () => editorRegistry.delete(paneId)
}

export function getEditorActions(paneId: string): EditorActions | undefined {
  return editorRegistry.get(paneId)
}

export function registerBrowserActions(paneId: string, actions: BrowserActions): () => void {
  browserRegistry.set(paneId, actions)
  return () => browserRegistry.delete(paneId)
}

export function getBrowserActions(paneId: string): BrowserActions | undefined {
  return browserRegistry.get(paneId)
}
