import type { PaneContent, PaneNode } from '@/store/paneTypes'
import type { Tab } from '@/store/types'
import { isValidClaudeSessionId } from '@/lib/claude-session-id'
import { migrateLegacyTerminalDurableState, sanitizeSessionRef } from '@shared/session-contract'

function sessionRefEquals(a?: Tab['sessionRef'], b?: Tab['sessionRef']): boolean {
  return a?.provider === b?.provider && a?.sessionId === b?.sessionId
}

function deriveLeafSessionRef(
  tab: Pick<Tab, 'mode'>,
  content: PaneContent,
): Tab['sessionRef'] | undefined {
  if (content.kind === 'terminal') {
    return migrateLegacyTerminalDurableState({
      provider: content.mode !== 'shell' ? content.mode : (tab.mode !== 'shell' ? tab.mode : undefined),
      sessionRef: content.sessionRef,
      resumeSessionId: content.resumeSessionId,
    }).sessionRef
  }

  if (content.kind === 'agent-chat') {
    const explicit = sanitizeSessionRef(content.sessionRef)
    if (explicit) return explicit
    if (!isValidClaudeSessionId(content.resumeSessionId)) return undefined
    return sanitizeSessionRef({
      provider: 'claude',
      sessionId: content.resumeSessionId,
    })
  }

  return undefined
}

export function buildTabFallbackIdentityUpdates(input: {
  tab: Pick<Tab, 'id' | 'mode' | 'sessionRef' | 'resumeSessionId'>
  layout?: PaneNode
}): Partial<Tab> | undefined {
  const { tab, layout } = input
  if (!layout) return undefined

  const desiredSessionRef = layout.type === 'leaf'
    ? deriveLeafSessionRef(tab, layout.content)
    : undefined

  const needsSessionRefSync = !sessionRefEquals(tab.sessionRef, desiredSessionRef)
  const needsResumeClear = typeof tab.resumeSessionId === 'string'
  if (!needsSessionRefSync && !needsResumeClear) return undefined

  return {
    ...(needsSessionRefSync ? { sessionRef: desiredSessionRef } : {}),
    ...(needsResumeClear ? { resumeSessionId: undefined } : {}),
  }
}

export function sanitizeTabsAgainstLayouts<T extends Pick<Tab, 'id' | 'mode' | 'sessionRef' | 'resumeSessionId'>>(
  tabs: T[],
  layouts: Record<string, PaneNode | undefined>,
): T[] {
  let changed = false
  const nextTabs = tabs.map((tab) => {
    const updates = buildTabFallbackIdentityUpdates({
      tab,
      layout: layouts[tab.id],
    })
    if (!updates) return tab
    changed = true
    return {
      ...tab,
      ...updates,
    }
  })

  return changed ? nextTabs : tabs
}
