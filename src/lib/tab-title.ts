import { deriveTabName } from './deriveTabName'
import type { Tab } from '@/store/types'
import type { PaneNode } from '@/store/paneTypes'

export function getTabDisplayTitle(tab: Tab, layout?: PaneNode): string {
  const title = tab.title ?? ''
  const derivedName = layout ? deriveTabName(layout) : null
  if (tab.titleSetByUser) {
    return title || derivedName || 'Tab'
  }
  if (title && !title.match(/^Tab \d+$/) && title !== derivedName) {
    return title
  }
  return derivedName ?? (title || 'Tab')
}
