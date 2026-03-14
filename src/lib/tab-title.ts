import { deriveTabName } from './deriveTabName'
import { derivePaneTitle } from './derivePaneTitle'
import type { Tab } from '@/store/types'
import type { PaneNode } from '@/store/paneTypes'
import type { ClientExtensionEntry } from '@shared/extension-types'

function getSinglePaneOverrideTitle(
  layout: PaneNode | undefined,
  paneTitles: Record<string, string> | undefined,
  extensions?: ClientExtensionEntry[],
): string | null {
  if (!layout || layout.type !== 'leaf') return null
  const storedTitle = paneTitles?.[layout.id]
  if (!storedTitle) return null
  const derivedPaneTitle = derivePaneTitle(layout.content, extensions)
  return storedTitle !== derivedPaneTitle ? storedTitle : null
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
  if (title && !title.match(/^Tab \d+$/) && title !== derivedName) {
    return title
  }
  return derivedName ?? (title || 'Tab')
}
