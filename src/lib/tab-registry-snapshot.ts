import type { PaneNode, PaneContent } from '@/store/paneTypes'
import type { Tab } from '@/store/types'
import type { RegistryPaneSnapshot, RegistryTabRecord } from '@/store/tabRegistryTypes'
import type { ClientExtensionEntry } from '@shared/extension-types'
import { getTabDisplayTitle } from '@/lib/tab-title'

const FIVE_MINUTES_MS = 5 * 60 * 1000

export function countPaneLeaves(node: PaneNode | undefined): number {
  if (!node) return 0
  if (node.type === 'leaf') return 1
  return countPaneLeaves(node.children[0]) + countPaneLeaves(node.children[1])
}

function stripPanePayload(content: PaneContent, serverInstanceId: string): Record<string, unknown> {
  switch (content.kind) {
    case 'terminal':
      return {
        mode: content.mode,
        shell: content.shell,
        sessionRef: content.sessionRef,
        codexDurability: content.mode === 'codex' ? content.codexDurability : undefined,
        liveTerminal: content.terminalId
          ? {
              terminalId: content.terminalId,
              serverInstanceId: content.serverInstanceId ?? serverInstanceId,
            }
          : undefined,
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
        wordWrap: content.wordWrap,
      }
    case 'fresh-agent':
      return {
        provider: content.provider,
        sessionType: content.sessionType,
        sessionRef: content.sessionRef,
        initialCwd: content.initialCwd,
        model: content.provider === 'codex' || content.provider === 'opencode' ? content.model : undefined,
        modelSelection: content.provider === 'claude' || content.provider === 'opencode' ? content.modelSelection : undefined,
        permissionMode: content.permissionMode,
        sandbox: content.sandbox,
        effort: content.effort,
        plugins: content.plugins,
        ...(content.style ? { style: content.style } : {}),
        ...(content.restoreError ? { restoreError: content.restoreError } : {}),
        settingsDismissed: content.settingsDismissed,
        showThinking: content.showThinking,
        showTools: content.showTools,
        showTimecodes: content.showTimecodes,
      }
    case 'extension':
      return {
        extensionName: content.extensionName,
        props: content.props,
      }
    case 'picker':
    default:
      return {}
  }
}

export function collectPaneSnapshots(
  node: PaneNode | undefined,
  serverInstanceId: string,
  paneTitles?: Record<string, string>,
): RegistryPaneSnapshot[] {
  if (!node) return []
  if (node.type === 'leaf') {
    return [{
      paneId: node.id,
      kind: node.content.kind,
      title: paneTitles?.[node.id],
      payload: stripPanePayload(node.content, serverInstanceId),
    }]
  }
  return [
    ...collectPaneSnapshots(node.children[0], serverInstanceId, paneTitles),
    ...collectPaneSnapshots(node.children[1], serverInstanceId, paneTitles),
  ]
}

type SnapshotRecordInput = {
  tab: Tab
  layout: PaneNode
  serverInstanceId: string
  paneTitles?: Record<string, string>
  extensions?: ClientExtensionEntry[]
  deviceId: string
  deviceLabel: string
  updatedAt: number
  revision: number
}

export function buildOpenTabRegistryRecord(input: SnapshotRecordInput): RegistryTabRecord {
  const paneSnapshots = collectPaneSnapshots(input.layout, input.serverInstanceId, input.paneTitles)
  return {
    tabKey: `${input.deviceId}:${input.tab.id}`,
    tabId: input.tab.id,
    serverInstanceId: input.serverInstanceId,
    deviceId: input.deviceId,
    deviceLabel: input.deviceLabel,
    // Canonical display title so the archive matches the tab bar.
    tabName: getTabDisplayTitle(input.tab, input.layout, input.paneTitles, input.extensions) || 'Untitled',
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
  const paneSnapshots = collectPaneSnapshots(input.layout, input.serverInstanceId, input.paneTitles)
  return {
    tabKey: `${input.deviceId}:${input.tab.id}`,
    tabId: input.tab.id,
    serverInstanceId: input.serverInstanceId,
    deviceId: input.deviceId,
    deviceLabel: input.deviceLabel,
    // Canonical display title so the archive matches the tab bar.
    tabName: getTabDisplayTitle(input.tab, input.layout, input.paneTitles, input.extensions) || 'Untitled',
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
