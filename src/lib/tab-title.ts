import { deriveTabName } from './deriveTabName'
import { derivePaneTitle } from './derivePaneTitle'
import {
  inferLegacyPaneTitleSource,
  resolveEffectiveLegacyTabTitleSource,
  shouldReplaceDurableTitleSource,
  type DurableTitleSource,
} from './title-source'
import type { Tab } from '@/store/types'
import type { PaneContent, PaneNode } from '@/store/paneTypes'
import type { ClientExtensionEntry } from '@shared/extension-types'

type TitleCandidate = {
  title: string
  source: DurableTitleSource
}

function getDurablePaneTitleCandidate(
  paneId: string,
  content: PaneContent,
  paneTitles: Record<string, string> | undefined,
  paneTitleSources: Record<string, DurableTitleSource> | undefined,
  extensions?: ClientExtensionEntry[],
): TitleCandidate {
  const derivedPaneTitle = derivePaneTitle(content, extensions)
  return {
    title: paneTitles?.[paneId] || derivedPaneTitle,
    source: paneTitleSources?.[paneId]
      ?? inferLegacyPaneTitleSource({
        storedTitle: paneTitles?.[paneId],
        derivedTitle: derivedPaneTitle,
      }),
  }
}

function getDurableTabTitleCandidate(
  tab: Tab,
  layout: PaneNode | undefined,
  paneTitles: Record<string, string> | undefined,
  paneTitleSources: Record<string, DurableTitleSource> | undefined,
  extensions?: ClientExtensionEntry[],
): TitleCandidate {
  const derivedTabTitle = layout ? deriveTabName(layout, extensions) : (tab.title || 'Tab')

  const paneCandidate = layout?.type === 'leaf'
    ? getDurablePaneTitleCandidate(layout.id, layout.content, paneTitles, paneTitleSources, extensions)
    : null
  const tabSource = tab.titleSource
    ?? resolveEffectiveLegacyTabTitleSource({
      storedTitle: tab.title,
      titleSetByUser: tab.titleSetByUser,
      layout,
      paneTitle: paneCandidate?.title,
      paneTitleSource: paneCandidate?.source,
      extensions,
    })
    ?? (tab.titleSetByUser ? 'user' : 'stable')
  const tabCandidate: TitleCandidate = {
    title: tab.title || derivedTabTitle || 'Tab',
    source: tabSource,
  }

  if (
    !paneCandidate
    || paneCandidate.source === tabCandidate.source
    || !shouldReplaceDurableTitleSource(tabCandidate.source, paneCandidate.source)
  ) {
    if (tabCandidate.source === 'derived') {
      const prefersStoredExitedTitle = tab.status === 'exited'
        && typeof tab.title === 'string'
        && tab.title.length > 0
        && tab.title !== derivedTabTitle
      return {
        title: prefersStoredExitedTitle
          ? tab.title
          : (derivedTabTitle || tabCandidate.title || 'Tab'),
        source: 'derived',
      }
    }
    return tabCandidate
  }

  return paneCandidate
}

export function getTabDurableDisplayTitle(
  tab: Tab,
  layout?: PaneNode,
  paneTitles?: Record<string, string>,
  paneTitleSources?: Record<string, DurableTitleSource>,
  extensions?: ClientExtensionEntry[],
): string {
  return getDurableTabTitleCandidate(tab, layout, paneTitles, paneTitleSources, extensions).title
}

export function getPaneDisplayTitle(
  paneId: string,
  content: PaneContent,
  paneTitles?: Record<string, string>,
  paneTitleSources?: Record<string, DurableTitleSource>,
  paneRuntimeTitles?: Record<string, string>,
  extensions?: ClientExtensionEntry[],
): string {
  const durableCandidate = getDurablePaneTitleCandidate(
    paneId,
    content,
    paneTitles,
    paneTitleSources,
    extensions,
  )
  if (durableCandidate.source === 'derived' && paneRuntimeTitles?.[paneId]) {
    return paneRuntimeTitles[paneId]
  }
  return durableCandidate.title
}

export function getTabDisplayTitle(
  tab: Tab,
  layout?: PaneNode,
  paneTitles?: Record<string, string>,
  paneTitleSources?: Record<string, DurableTitleSource>,
  paneRuntimeTitles?: Record<string, string>,
  extensions?: ClientExtensionEntry[],
): string {
  const durableCandidate = getDurableTabTitleCandidate(
    tab,
    layout,
    paneTitles,
    paneTitleSources,
    extensions,
  )
  if (
    layout?.type === 'leaf'
    && durableCandidate.source === 'derived'
    && paneRuntimeTitles?.[layout.id]
  ) {
    return paneRuntimeTitles[layout.id]
  }
  return durableCandidate.title
}
