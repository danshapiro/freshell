import type { PaneNode, PaneContent } from '@/store/paneTypes'
import type { Tab } from '@/store/types'
import type { RegistryPaneSnapshot, RegistryTabRecord } from '@/store/tabRegistryTypes'

const FIVE_MINUTES_MS = 5 * 60 * 1000

export function countPaneLeaves(node: PaneNode | undefined): number {
  if (!node) return 0
  if (node.type === 'leaf') return 1
  return countPaneLeaves(node.children[0]) + countPaneLeaves(node.children[1])
}

function stripPanePayload(content: PaneContent): Record<string, unknown> {
  switch (content.kind) {
    case 'terminal':
      return {
        mode: content.mode,
        shell: content.shell,
        resumeSessionId: content.resumeSessionId,
        initialCwd: content.initialCwd,
      }
    case 'browser':
      return {
        url: content.url,
        devToolsOpen: content.devToolsOpen,
      }
    case 'editor':
      return {
        filePath: content.filePath,
        language: content.language,
        readOnly: content.readOnly,
        viewMode: content.viewMode,
      }
    case 'claude-chat':
      return {
        resumeSessionId: content.resumeSessionId,
        initialCwd: content.initialCwd,
        model: content.model,
        permissionMode: content.permissionMode,
        effort: content.effort,
      }
    case 'picker':
    default:
      return {}
  }
}

export function collectPaneSnapshots(
  node: PaneNode | undefined,
  paneTitles?: Record<string, string>,
): RegistryPaneSnapshot[] {
  if (!node) return []
  if (node.type === 'leaf') {
    return [{
      paneId: node.id,
      kind: node.content.kind,
      title: paneTitles?.[node.id],
      payload: stripPanePayload(node.content),
    }]
  }
  return [
    ...collectPaneSnapshots(node.children[0], paneTitles),
    ...collectPaneSnapshots(node.children[1], paneTitles),
  ]
}

type SnapshotRecordInput = {
  tab: Tab
  layout: PaneNode
  paneTitles?: Record<string, string>
  deviceId: string
  deviceLabel: string
  updatedAt: number
  revision: number
}

export function buildOpenTabRegistryRecord(input: SnapshotRecordInput): RegistryTabRecord {
  const paneSnapshots = collectPaneSnapshots(input.layout, input.paneTitles)
  return {
    tabKey: `${input.deviceId}:${input.tab.id}`,
    tabId: input.tab.id,
    deviceId: input.deviceId,
    deviceLabel: input.deviceLabel,
    tabName: input.tab.title || 'Untitled',
    status: 'open',
    revision: input.revision,
    createdAt: input.tab.createdAt || input.updatedAt,
    updatedAt: input.updatedAt,
    paneCount: paneSnapshots.length,
    titleSetByUser: !!input.tab.titleSetByUser,
    panes: paneSnapshots,
  }
}

export function buildClosedTabRegistryRecord(input: SnapshotRecordInput): RegistryTabRecord {
  const paneSnapshots = collectPaneSnapshots(input.layout, input.paneTitles)
  return {
    tabKey: `${input.deviceId}:${input.tab.id}`,
    tabId: input.tab.id,
    deviceId: input.deviceId,
    deviceLabel: input.deviceLabel,
    tabName: input.tab.title || 'Untitled',
    status: 'closed',
    revision: input.revision,
    createdAt: input.tab.createdAt || input.updatedAt,
    updatedAt: input.updatedAt,
    closedAt: input.updatedAt,
    paneCount: paneSnapshots.length,
    titleSetByUser: !!input.tab.titleSetByUser,
    panes: paneSnapshots,
  }
}

export function shouldKeepClosedTab(input: {
  openDurationMs: number
  paneCount: number
  titleSetByUser: boolean
}): boolean {
  return (
    input.openDurationMs > FIVE_MINUTES_MS ||
    input.paneCount > 1 ||
    input.titleSetByUser
  )
}
