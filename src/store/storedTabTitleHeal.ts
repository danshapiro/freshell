/**
 * Name reliability (plan Task 14, Residual 23) — the stored tab title heal.
 *
 * Before Task 8 the managed-runtime refresh stored its view titles ("Shell
 * agent", "OpenCode agent", "Recovered Shell agent") as the title of every
 * unrenamed tab it matched. Such a stored title is not a name. This module
 * is the one place that heals it: the title returns to the unnamed
 * placeholder (`unnamedTabTitle`, "Tab N"), which every display treats as
 * no title, so the tab shows its derived label.
 *
 * Why the store: every way a tab enters it — the persisted-layout load,
 * cross-window sync, the new-window rebuild, a tabs-registry open, a write
 * from an old client — passes here, and every consumer copies the stored
 * state: the persist middleware writes the healed layout (the heal is a
 * `tabs/` action), the layout mirror sends the healed title (served by
 * `GET /api/tabs`), and the tabs registry follows the display. So all four
 * agree.
 *
 * Rules (`isHealableStoredTabTitle`, `src/lib/tab-title.ts`): only a tab
 * without `titleSetByUser`, never a title the saved-name mirror owns (a
 * session-owned tab whose saved record is cached keeps the mirrored saved
 * name, so the two never fight), never a `Tab N` placeholder or the tab's
 * own derived label, and only text the shared classifier
 * (`shared/name-evidence.ts`) recognizes as a provider or mode label, a
 * provider placeholder or tool wrapper text for the tab's mode and provider
 * (its folder-name rule is not used). A title's writer is not recorded, so a
 * live window title that is itself such a label (a program in a shell
 * titling the window "opencode") heals too; a single-pane tab still shows it
 * through its pane title, a split tab shows its derived label. Any other
 * window title, a session name or a rename is never healed and still wins.
 * The write (`healStoredTabTitles`) changes the title only: no `updatedAt`
 * bump, no flag.
 *
 * It runs after every action whose tabs, layouts, saved names or extensions
 * changed, and once when the store is created (`healStoredTabTitlesOnLoad`),
 * so the loaded layout is healed before anything reads it.
 */
import type { Middleware } from '@reduxjs/toolkit'
import { healStoredTabTitles } from './tabsSlice.js'
import { selectSessionTabSavedNames } from './selectors/sessionNameSelectors.js'
import type { RootState } from './store.js'
import { isHealableStoredTabTitle, unnamedTabTitle } from '@/lib/tab-title'
import { createLogger } from '@/lib/client-logger'

const log = createLogger('StoredTabTitleHeal')

type HealStore = {
  getState: () => unknown
  dispatch: (action: ReturnType<typeof healStoredTabTitles>) => unknown
}

/** `{tabId: placeholder}` for every tab whose stored title heals. */
function planHeals(state: RootState): Record<string, string> {
  const savedNames = selectSessionTabSavedNames(state)
  const layouts = state.panes?.layouts ?? {}
  const extensions = state.extensions?.entries
  const heals: Record<string, string> = {}
  for (const [index, tab] of (state.tabs?.tabs ?? []).entries()) {
    if (savedNames[tab.id] !== undefined) continue
    if (!isHealableStoredTabTitle(tab, layouts[tab.id], extensions)) continue
    heals[tab.id] = unnamedTabTitle(index + 1)
  }
  return heals
}

function runHealPass(store: HealStore, trigger: unknown): void {
  const heals = planHeals(store.getState() as RootState)
  const tabIds = Object.keys(heals)
  if (tabIds.length === 0) return
  // Tab ids only: a stored label can be tool wrapper text that quotes a
  // prompt, so the titles themselves are never logged.
  log.info('stored tab titles were default labels, not names; healed to the unnamed placeholder', {
    tabIds,
    trigger,
  })
  store.dispatch(healStoredTabTitles(heals))
}

/** One heal pass over the store as it was loaded (store creation). */
export function healStoredTabTitlesOnLoad(store: HealStore): void {
  runHealPass(store, 'load')
}

export const storedTabTitleHealMiddleware: Middleware = (store) => {
  // Re-plan only when an input changed: the same tabs, layouts, saved names
  // and extensions cannot hold a new default label.
  let last: readonly unknown[] | undefined
  return (next) => (action) => {
    const result = next(action)
    const state = store.getState() as RootState
    const inputs = [
      state.tabs?.tabs,
      state.panes?.layouts,
      selectSessionTabSavedNames(state),
      state.extensions?.entries,
    ] as const
    if (last && inputs.every((input, index) => input === last![index])) return result
    last = inputs
    runHealPass(store, (action as { type?: unknown }).type)
    return result
  }
}
