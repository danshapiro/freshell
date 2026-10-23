import { deriveTabName } from './deriveTabName'
import { derivePaneTitle } from './derivePaneTitle'
import { matchesDerivedPaneTitle } from './pane-title'
import type { Tab } from '@/store/types'
import type { PaneNode } from '@/store/paneTypes'
import type { ClientExtensionEntry } from '@shared/extension-types'
import { isDefaultOrDerivedName, isTabNumberLabel } from '@shared/name-evidence'
import { tabNamingLeaf } from './tab-name-source'

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

/** The folder a tab's labels derive from: its own, else its naming pane's. */
function tabFolder(tab: Tab, layout: PaneNode): string | undefined {
  if (tab.initialCwd) return tab.initialCwd
  const content = tabNamingLeaf(tab, layout)?.content
  return content && 'initialCwd' in content && typeof content.initialCwd === 'string'
    ? content.initialCwd
    : undefined
}

/**
 * Name reliability (Task 14): whether a tab's STORED title is a default or
 * derived label rather than a name, so the store heals it to the unnamed
 * placeholder (`src/store/storedTabTitleHeal.ts`). Before Task 8 the
 * managed-runtime merge stored provider labels ("Shell agent", "OpenCode
 * agent", "Recovered Shell agent") on every unrenamed tab it matched.
 *
 * True only when the tab has no `titleSetByUser`, has a layout, its title is
 * not already a `Tab N` placeholder, differs from the tab's derived label (a
 * create-time label equal to it is already no title to every display), and
 * the shared classifier recognizes it for the tab's folder, mode and
 * provider. A real title (an OSC window title, a session name) is never a
 * default label, so it never heals.
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
  return isDefaultOrDerivedName(title, {
    cwd: tabFolder(tab, layout),
    mode: tab.mode,
    provider: tab.codingCliProvider,
  })
}
