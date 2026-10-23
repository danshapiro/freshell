import { deriveTabName } from './deriveTabName'
import { derivePaneTitle } from './derivePaneTitle'
import { matchesDerivedPaneTitle } from './pane-title'
import type { Tab } from '@/store/types'
import type { PaneNode } from '@/store/paneTypes'
import type { ClientExtensionEntry } from '@shared/extension-types'
import { isTabNumberLabel } from '@shared/name-evidence'

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
