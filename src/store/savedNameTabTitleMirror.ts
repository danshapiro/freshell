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
 * - When a tab stops taking its name from a session (its last
 *   Claude/Codex/OpenCode pane is closed or replaced by other content, so
 *   the tab turns legacy), its stored title returns to the unnamed
 *   placeholder too, so the tab shows its own derived label (or its next
 *   window title), never the old session's name. The mirror takes back only
 *   the name it wrote: a title that changed in the same write, or a
 *   user-renamed tab, is kept.
 * - The write (`mirrorSessionTabTitles`) changes the title only: no
 *   `updatedAt` bump (tab recency) and no `titleSetByUser`.
 * - Legacy tabs are otherwise never written; legacy title writers ask
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

/** The title writes one pass makes: the saved names to mirror, the tabs
 * whose naming session changed to one without a saved name, and the tabs
 * that stopped taking their name from a session. The last two return to the
 * unnamed placeholder. */
type MirrorPass = {
  titles: Record<string, string>
  mirroredTabIds: string[]
  resetTabIds: string[]
  releasedTabIds: string[]
}

/** What a tab's stored title was last mirrored from: the naming ref key and
 * the saved name. */
type MirroredTitle = { refKey: string; name: string }

/**
 * One mirror pass over the tabs. `mirroredByTab` remembers, per tab, what
 * its stored title was last mirrored from; the pass updates it in place.
 */
function planMirrorPass(
  tabs: Tabs | undefined,
  bindings: Record<string, SessionTabNameBinding>,
  mirroredByTab: Map<string, MirroredTitle>,
): MirrorPass {
  const pass: MirrorPass = { titles: {}, mirroredTabIds: [], resetTabIds: [], releasedTabIds: [] }
  const openTabIds = new Set<string>()
  for (const [index, tab] of (tabs ?? []).entries()) {
    openTabIds.add(tab.id)
    const binding = bindings[tab.id]
    const mirrored = mirroredByTab.get(tab.id)
    if (!binding) {
      // A legacy tab. One the mirror wrote has just stopped taking its name
      // from a session: take the name back only while it is still the
      // stored title (a title written in the same change, or a rename,
      // stays).
      if (!mirrored) continue
      mirroredByTab.delete(tab.id)
      if (tab.titleSetByUser || tab.title !== mirrored.name) continue
      pass.titles[tab.id] = unnamedTabTitle(index + 1)
      pass.releasedTabIds.push(tab.id)
      continue
    }
    const { refKey, savedName } = binding
    if (refKey !== null && savedName !== undefined && savedName.length > 0) {
      mirroredByTab.set(tab.id, { refKey, name: savedName })
      if (savedName !== tab.title) {
        pass.titles[tab.id] = savedName
        pass.mirroredTabIds.push(tab.id)
      }
      continue
    }
    if (mirrored === undefined || mirrored.refKey === refKey) continue
    // The stored title is another session's saved name.
    mirroredByTab.delete(tab.id)
    pass.titles[tab.id] = unnamedTabTitle(index + 1)
    pass.resetTabIds.push(tab.id)
  }
  // A closed tab keeps the name it closed with (its closed-tab record).
  for (const tabId of [...mirroredByTab.keys()]) {
    if (!openTabIds.has(tabId)) mirroredByTab.delete(tabId)
  }
  return pass
}

export const savedNameTabTitleMirrorMiddleware: Middleware = (store) => {
  // The bindings map is memoized on (tabs, layouts, name cache): the same
  // reference means none of them changed, so nothing can have drifted.
  let lastBindings: Record<string, SessionTabNameBinding> | undefined
  const mirroredByTab = new Map<string, MirroredTitle>()
  return (next) => (action) => {
    const result = next(action)
    const state = store.getState() as RootState
    const bindings = selectSessionTabNameBindings(state)
    if (bindings === lastBindings) return result
    lastBindings = bindings
    const pass = planMirrorPass(state.tabs?.tabs, bindings, mirroredByTab)
    if (Object.keys(pass.titles).length === 0) return result
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
    if (pass.releasedTabIds.length > 0) {
      log.info('tab no longer takes its name from a session; tab title returns to the unnamed placeholder', {
        tabIds: pass.releasedTabIds,
        trigger,
      })
    }
    store.dispatch(mirrorSessionTabTitles(pass.titles))
    return result
  }
}
