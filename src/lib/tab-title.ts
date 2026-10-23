import { deriveTabName } from './deriveTabName'
import { derivePaneTitle } from './derivePaneTitle'
import { matchesDerivedPaneTitle } from './pane-title'
import type { Tab } from '@/store/types'
import type { PaneNode } from '@/store/paneTypes'
import type { ClientExtensionEntry } from '@shared/extension-types'
import { isDefaultOrDerivedName, isTabNumberLabel } from '@shared/name-evidence'

function getSinglePaneOverrideTitle(
  layout: PaneNode | undefined,
  paneTitles: Record<string, string> | undefined,
  extensions?: ClientExtensionEntry[],
): string | null {
  if (!layout || layout.type !== 'leaf') return null
  const storedTitle = paneTitles?.[layout.id]
  if (!storedTitle) return null
  return matchesDerivedPaneTitle(storedTitle, layout.content, extensions) ? null : storedTitle
}

/**
 * The title a tab without a name stores: `Tab <position>`. Every display
 * treats it as no title (`isTabNumberLabel`) and shows the derived label
 * instead, and it is never name evidence.
 */
export function unnamedTabTitle(position: number): string {
  return `Tab ${position}`
}

export function getTabDisplayTitle(
  tab: Tab,
  layout?: PaneNode,
  paneTitles?: Record<string, string>,
  extensions?: ClientExtensionEntry[],
): string {
  const title = tab.title ?? ''
  const singlePaneTitle = getSinglePaneOverrideTitle(layout, paneTitles, extensions)
  const derivedName = layout ? deriveTabName(layout, extensions) : null
  if (tab.titleSetByUser) {
    return title || singlePaneTitle || derivedName || (layout?.type === 'leaf' ? derivePaneTitle(layout.content, extensions) : null) || 'Tab'
  }
  if (singlePaneTitle) {
    return singlePaneTitle
  }
  if (title && !isTabNumberLabel(title) && title !== derivedName) {
    return title
  }
  return derivedName ?? (title || 'Tab')
}

/**
 * Name reliability (Task 14): whether a tab's STORED title is a default
 * label rather than a name, so the store heals it to the unnamed placeholder
 * (`src/store/storedTabTitleHeal.ts`). Before Task 8 the managed-runtime
 * merge stored provider labels ("Shell agent", "OpenCode agent", "Recovered
 * Shell agent") on every unrenamed tab it matched.
 *
 * True only when the tab has no `titleSetByUser`, has a layout, its title is
 * not already a `Tab N` placeholder, differs from the tab's derived label (a
 * create-time label equal to it is already no title to every display), and
 * the shared classifier recognizes it for the tab's mode and provider: a
 * provider or mode label in any of the forms the old merge wrote, a
 * provider's own placeholder, or tool wrapper text.
 *
 * The classifier's folder-name rule is deliberately left out (no `cwd`). The
 * old merge never stored a folder name, and a folder name that differs from
 * the derived label is a live title (a shell prompt that titles the window
 * with its folder, in a split tab whose label comes from another pane) or a
 * create-time label; both stay.
 *
 * A title's writer is not recorded, so a live window title that is itself
 * one of those labels (a program in a shell titling the window "opencode")
 * heals too on a tab without a rename. Only a split tab shows it: a
 * single-pane tab keeps showing the window title through its pane title.
 * Every other window title, session name and rename is never healed.
 */
export function isHealableStoredTabTitle(
  tab: Tab,
  layout: PaneNode | undefined,
  extensions?: ClientExtensionEntry[],
): boolean {
  if (tab.titleSetByUser || !layout) return false
  const title = tab.title ?? ''
  if (!title || isTabNumberLabel(title)) return false
  if (title === deriveTabName(layout, extensions)) return false
  return isDefaultOrDerivedName(title, { mode: tab.mode, provider: tab.codingCliProvider })
}
