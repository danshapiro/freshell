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

/** Unified agent names (Task 6): the pane's naming identity rides registry
 * payloads so recovery/copies preserve the provisional handle and the bound
 * ref; omitted when the pane has none (pre-Task-6 panes). */
function paneNamingIdentityPayload(content: PaneContent): Record<string, unknown> {
  if (content.kind !== 'terminal' && content.kind !== 'fresh-agent') return {}
  return {
    ...(content.namingHandle ? { namingHandle: content.namingHandle } : {}),
    ...(content.nameRef ? { nameRef: content.nameRef } : {}),
  }
}

function stripPanePayload(content: PaneContent, serverInstanceId: string): Record<string, unknown> {
  switch (content.kind) {
    case 'terminal':
      return {
        createRequestId: content.createRequestId,
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
        ...paneNamingIdentityPayload(content),
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
        createRequestId: content.createRequestId,
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
        showTimecodes: content.showTimecodes,
        ...paneNamingIdentityPayload(content),
      }
    case 'extension':
      return {
        extensionName: content.extensionName,
        props: content.props,
      }
    case 'host-stats':
      return {}
    case 'picker':
    default:
      return {}
  }
}

type CollectPaneSnapshotsOptions = {
  /** Name reliability (Task 9): the tab's per-pane "user renamed" flags. A
   * renamed pane's snapshot carries `titleSetByUser: true`, so a window
   * rebuilt from the registry keeps the name protected; an automatic title
   * carries no flag. */
  paneTitleSetByUser?: Record<string, boolean>
  annotatePayload?: (paneId: string) => { sessionKeys?: string[]; busySessionKeys?: string[] } | undefined
}

export function collectPaneSnapshots(
  node: PaneNode | undefined,
  serverInstanceId: string,
  paneTitles?: Record<string, string>,
  options: CollectPaneSnapshotsOptions = {},
): RegistryPaneSnapshot[] {
  if (!node) return []
  if (node.type === 'leaf') {
    const annotation = options.annotatePayload?.(node.id)
    return [{
      paneId: node.id,
      kind: node.content.kind,
      title: paneTitles?.[node.id],
      ...(options.paneTitleSetByUser?.[node.id] === true ? { titleSetByUser: true } : {}),
      payload: {
        ...stripPanePayload(node.content, serverInstanceId),
        ...(annotation?.sessionKeys?.length ? { sessionKeys: annotation.sessionKeys } : {}),
        ...(annotation?.busySessionKeys?.length ? { busySessionKeys: annotation.busySessionKeys } : {}),
      },
    }]
  }
  return [
    ...collectPaneSnapshots(node.children[0], serverInstanceId, paneTitles, options),
    ...collectPaneSnapshots(node.children[1], serverInstanceId, paneTitles, options),
  ]
}

type SnapshotRecordInput = {
  tab: Tab
  layout: PaneNode
  serverInstanceId: string
  paneTitles?: Record<string, string>
  /** Name reliability (Task 9): the tab's per-pane "user renamed" flags. */
  paneTitleSetByUser?: Record<string, boolean>
  extensions?: ClientExtensionEntry[]
  deviceId: string
  deviceLabel: string
  updatedAt: number
  revision: number
  paneIdentityActivity?: ReadonlyMap<string, { sessionKeys: string[]; busySessionKeys: string[] }>
}

export function buildOpenTabRegistryRecord(input: SnapshotRecordInput): RegistryTabRecord {
  const paneIdentityActivity = input.paneIdentityActivity
  const paneSnapshots = collectPaneSnapshots(
    input.layout,
    input.serverInstanceId,
    input.paneTitles,
    {
      paneTitleSetByUser: input.paneTitleSetByUser,
      annotatePayload: paneIdentityActivity
        ? (paneId) => paneIdentityActivity.get(paneId)
        : undefined,
    },
  )
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
    // Unified agent names (Task 6): the stable naming-source relationship
    // travels with the record so copies/recovery can remap it; omitted when
    // unresolved.
    ...(input.tab.nameSource ? { nameSource: input.tab.nameSource } : {}),
    panes: paneSnapshots,
  }
}

export function buildClosedTabRegistryRecord(input: SnapshotRecordInput): RegistryTabRecord {
  // Closed/tombstone records are never stamped with pane identity activity:
  // input.paneIdentityActivity is accepted by the shared input shape but
  // deliberately not forwarded (rings are an open-tab concern).
  const paneSnapshots = collectPaneSnapshots(input.layout, input.serverInstanceId, input.paneTitles, {
    paneTitleSetByUser: input.paneTitleSetByUser,
  })
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
    // Unified agent names (Task 6): the stable naming-source relationship
    // travels with the closed record (reopen/recovery read it back).
    ...(input.tab.nameSource ? { nameSource: input.tab.nameSource } : {}),
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
