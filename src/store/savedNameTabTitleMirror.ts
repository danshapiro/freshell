/**
 * Name reliability (plan Task 7, D2) — the saved-name tab title mirror.
 *
 * A session-owned tab (its naming source is a Claude/Codex/OpenCode pane)
 * displays that session's saved name. Its stored `tab.title` is kept as a
 * display MIRROR of that name, because every other consumer of a tab — the
 * persisted layout, the server's layout mirror (`ui.layout.sync`, served by
 * `GET /api/tabs`), the tabs registry and closed-tab snapshots — already
 * copies `tab.title`. With the mirror they all carry the saved name, and a
 * reload shows it before names load.
 *
 * Rules:
 * - It writes only when the session's saved record is cached
 *   (`selectSessionTabSavedNames`). With no record the tab keeps its
 *   last-known title: it never stores a fallback label (provider label,
 *   folder name, "Tab N").
 * - The write (`mirrorSessionTabTitles`) changes the title only: no
 *   `updatedAt` bump (tab recency) and no `titleSetByUser`.
 * - Legacy tabs are never written; legacy title writers ask
 *   `canWriteLegacyTabTitle` (`src/lib/tab-title-ownership.ts`) and leave
 *   session-owned tabs alone.
 *
 * Not to be confused with `src/store/sessionTitleMirror.ts`, which copies
 * session-directory titles into the titles of NON-scoped panes.
 */
import type { Middleware } from '@reduxjs/toolkit'
import { mirrorSessionTabTitles } from './tabsSlice.js'
import { selectSessionTabSavedNames } from './selectors/sessionNameSelectors.js'
import type { RootState } from './store.js'
import { createLogger } from '@/lib/client-logger'

const log = createLogger('SavedNameTabTitleMirror')

/** The session-owned tabs whose stored title differs from their saved
 * name, as `{tabId: savedName}`; undefined when every title matches. */
function staleMirroredTitles(
  tabs: RootState['tabs']['tabs'] | undefined,
  savedNames: Record<string, string>,
): Record<string, string> | undefined {
  let stale: Record<string, string> | undefined
  for (const tab of tabs ?? []) {
    const savedName = savedNames[tab.id]
    if (savedName === undefined || savedName === tab.title) continue
    stale ??= {}
    stale[tab.id] = savedName
  }
  return stale
}

export const savedNameTabTitleMirrorMiddleware: Middleware = (store) => {
  // The saved-names map is memoized on (tabs, layouts, name cache): the same
  // reference means none of them changed, so nothing can have drifted.
  let lastSavedNames: Record<string, string> | undefined
  return (next) => (action) => {
    const result = next(action)
    const state = store.getState() as RootState
    const savedNames = selectSessionTabSavedNames(state)
    if (savedNames === lastSavedNames) return result
    lastSavedNames = savedNames
    const stale = staleMirroredTitles(state.tabs?.tabs, savedNames)
    if (stale) {
      log.debug('mirroring saved names into session-owned tab titles', {
        tabIds: Object.keys(stale),
        trigger: (action as { type?: unknown }).type,
      })
      store.dispatch(mirrorSessionTabTitles(stale))
    }
    return result
  }
}
