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
 * - It writes the saved name only when the session's saved record is cached
 *   (`selectSessionTabNameBindings`). With no record the tab keeps its
 *   last-known title: it never stores a fallback label (provider label,
 *   folder name) as the name.
 * - A mirrored title belongs to the naming ref it was mirrored from. When
 *   the tab's naming ref changes to one with no cached record (a
 *   conversation switch such as /clear, a new conversation in the pane, or
 *   the naming source moving to another pane), the old session's name is
 *   not this session's: the title returns to the unnamed placeholder
 *   (`unnamedTabTitle`, "Tab N"), which every display treats as no title,
 *   so the tab shows the new session's fallback until it has a saved name.
 *   A tab's first naming identity (a new pane's handle) never resets its
 *   create-time title.
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
import {
  selectSessionTabNameBindings,
  type SessionTabNameBinding,
} from './selectors/sessionNameSelectors.js'
import type { RootState } from './store.js'
import { unnamedTabTitle } from '@/lib/tab-title'
import { createLogger } from '@/lib/client-logger'

const log = createLogger('SavedNameTabTitleMirror')

type Tabs = RootState['tabs']['tabs']

/** The title writes one pass makes: the saved names to mirror and the tabs
 * whose mirrored title went back to the unnamed placeholder. */
type MirrorPass = {
  titles: Record<string, string>
  mirroredTabIds: string[]
  resetTabIds: string[]
}

/**
 * One mirror pass over the session-owned tabs. `mirroredRefKeyByTab`
 * remembers, per tab, the naming ref key its stored title was mirrored
 * from; the pass updates it in place.
 */
function planMirrorPass(
  tabs: Tabs | undefined,
  bindings: Record<string, SessionTabNameBinding>,
  mirroredRefKeyByTab: Map<string, string>,
): MirrorPass {
  const pass: MirrorPass = { titles: {}, mirroredTabIds: [], resetTabIds: [] }
  for (const tabId of [...mirroredRefKeyByTab.keys()]) {
    if (!bindings[tabId]) mirroredRefKeyByTab.delete(tabId)
  }
  for (const [index, tab] of (tabs ?? []).entries()) {
    const binding = bindings[tab.id]
    if (!binding) continue
    const { refKey, savedName } = binding
    if (refKey !== null && savedName !== undefined && savedName.length > 0) {
      mirroredRefKeyByTab.set(tab.id, refKey)
      if (savedName !== tab.title) {
        pass.titles[tab.id] = savedName
        pass.mirroredTabIds.push(tab.id)
      }
      continue
    }
    const mirroredFrom = mirroredRefKeyByTab.get(tab.id)
    if (mirroredFrom === undefined || mirroredFrom === refKey) continue
    // The stored title is another session's saved name.
    mirroredRefKeyByTab.delete(tab.id)
    pass.titles[tab.id] = unnamedTabTitle(index + 1)
    pass.resetTabIds.push(tab.id)
  }
  return pass
}

export const savedNameTabTitleMirrorMiddleware: Middleware = (store) => {
  // The bindings map is memoized on (tabs, layouts, name cache): the same
  // reference means none of them changed, so nothing can have drifted.
  let lastBindings: Record<string, SessionTabNameBinding> | undefined
  const mirroredRefKeyByTab = new Map<string, string>()
  return (next) => (action) => {
    const result = next(action)
    const state = store.getState() as RootState
    const bindings = selectSessionTabNameBindings(state)
    if (bindings === lastBindings) return result
    lastBindings = bindings
    const pass = planMirrorPass(state.tabs?.tabs, bindings, mirroredRefKeyByTab)
    if (pass.mirroredTabIds.length === 0 && pass.resetTabIds.length === 0) return result
    const trigger = (action as { type?: unknown }).type
    if (pass.mirroredTabIds.length > 0) {
      log.debug('mirroring saved names into session-owned tab titles', {
        tabIds: pass.mirroredTabIds,
        trigger,
      })
    }
    if (pass.resetTabIds.length > 0) {
      log.info('naming session changed to one without a saved name; tab title returns to the unnamed placeholder', {
        tabIds: pass.resetTabIds,
        trigger,
      })
    }
    store.dispatch(mirrorSessionTabTitles(pass.titles))
    return result
  }
}
