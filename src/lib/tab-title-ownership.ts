/**
 * Name reliability (plan Task 7, D2): who may write a tab's stored title.
 *
 * A session-owned tab (its naming source is a Claude/Codex/OpenCode pane)
 * displays that session's saved name, and its stored `title` is a display
 * mirror of the saved name, written only by the saved-name tab title mirror
 * (`src/store/savedNameTabTitleMirror.ts`). Every legacy title writer —
 * terminal OSC titles, the shell exit suffix, session reopen retitles, the
 * kilroy first-message name, a sidebar click on an unscoped session row, an
 * unscoped terminal rename from the overview or its context menu — asks
 * this one gate first, so none of them can replace the mirrored name.
 * Legacy tabs keep their writers unchanged.
 */
import { selectTabNameSourcePaneId } from '@/store/selectors/sessionNameSelectors'
import type { RootState } from '@/store/store'

/** False when the tab is session-owned (its stored title mirrors the saved
 * name); true for every legacy tab. Callers keep their own user-rename
 * (`titleSetByUser`) checks. */
export function canWriteLegacyTabTitle(state: RootState, tabId: string): boolean {
  return selectTabNameSourcePaneId(state, tabId) === null
}
