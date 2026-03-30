import type { CodexActivityRecord } from '@shared/ws-protocol'
import { collectPaneContents } from '@/lib/pane-utils'
import { resolveExactCodexActivity } from '@/lib/codex-activity-resolver'
import type { PaneNode } from '@/store/paneTypes'
import type { Tab } from '@/store/types'

const EMPTY_ACTIVITY_TERMINAL_IDS: string[] = []

export function getBusyCodexActivityTerminalIdsForTab(
  tab: Tab,
  paneLayouts: Record<string, PaneNode | undefined>,
  codexActivityByTerminalId: Record<string, CodexActivityRecord>,
): string[] {
  const layout = paneLayouts[tab.id]
  if (!layout) {
    return EMPTY_ACTIVITY_TERMINAL_IDS
  }

  const busyTerminalIds = new Set<string>()
  const isOnlyPane = layout.type === 'leaf'
  for (const content of collectPaneContents(layout)) {
    if (content.kind !== 'terminal') continue
    if (content.status !== 'running') continue
    const record = resolveExactCodexActivity(codexActivityByTerminalId, {
      terminalId: content.terminalId,
      isOnlyPane,
    })
    if (record?.phase === 'busy') {
      busyTerminalIds.add(record.terminalId)
    }
  }

  return busyTerminalIds.size > 0 ? Array.from(busyTerminalIds) : EMPTY_ACTIVITY_TERMINAL_IDS
}
