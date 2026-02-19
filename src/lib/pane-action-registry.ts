export type TerminalActions = {
  copySelection: () => Promise<void> | void
  paste: () => Promise<void> | void
  selectAll: () => void
  clearScrollback: () => void
  reset: () => void
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
  openWithSystemViewer: () => Promise<void> | void
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

export function registerTerminalActions(paneId: string, actions: TerminalActions): () => void {
  terminalRegistry.set(paneId, actions)
  return () => terminalRegistry.delete(paneId)
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
