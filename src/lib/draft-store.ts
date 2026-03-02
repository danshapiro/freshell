/**
 * Module-level store for chat composer draft text.
 *
 * Survives React component unmount/remount (e.g. pane splits) without
 * involving Redux or localStorage.  Keyed by paneId so each pane keeps
 * its own independent draft.
 */

const drafts = new Map<string, string>()

export function getDraft(paneId: string): string {
  return drafts.get(paneId) ?? ''
}

export function setDraft(paneId: string, text: string): void {
  if (text) {
    drafts.set(paneId, text)
  } else {
    drafts.delete(paneId)
  }
}

export function clearDraft(paneId: string): void {
  drafts.delete(paneId)
}
