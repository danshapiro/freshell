// Shared tab-registry helpers: pane-kind presentation, registry-record
// sanitization, and the "open/jump" actions used by TabsView cards AND the
// shared context-menu (ContextMenuProvider / menu-defs). React-free except
// for lucide icon component references.
import { nanoid } from 'nanoid'
import {
  Bot,
  FileCode2,
  Gauge,
  Globe,
  Square,
  TerminalSquare,
  type LucideIcon,
} from 'lucide-react'
import type { AppDispatch } from '@/store/store'
import { addTab, setActiveTab } from '@/store/tabsSlice'
import { addPane, initLayout } from '@/store/panesSlice'
import {
  RegistryPaneSnapshotSchema,
  type RegistryPaneSnapshot,
  type RegistryTabRecord,
} from '@/store/tabRegistryTypes'
import {
  normalizeFreshAgentEffortOverride,
  normalizeFreshAgentModelSelection,
  type FreshAgentCheckpointWorkspace,
  type PaneContentInput,
  type SessionLocator,
} from '@/store/paneTypes'
import type { CodingCliProviderName, TabMode } from '@/store/types'
import { isNonShellMode } from '@/lib/coding-cli-utils'
import { sanitizeRestoreError } from '@shared/session-contract'
import { sanitizeCodexDurabilityRef } from '@shared/codex-durability'
import { normalizeFreshAgentSessionType, resolveFreshAgentRuntimeProvider } from '@shared/fresh-agent'
import { normalizeFreshAgentStyleOverride } from '@shared/settings'
import { isScopedNameSourceContent, parsePaneNamingIdentityInput, remapTabNameSource } from '@/lib/tab-name-source'
import type { PaneContent } from '@/store/paneTypes'

function parseSessionLocator(value: unknown): SessionLocator | undefined {
  if (!value || typeof value !== 'object') return undefined
  const candidate = value as { provider?: unknown; sessionId?: unknown }
  if (typeof candidate.provider !== 'string' || !isNonShellMode(candidate.provider)) {
    return undefined
  }
  if (typeof candidate.sessionId !== 'string') return undefined
  return {
    provider: candidate.provider as CodingCliProviderName,
    sessionId: candidate.sessionId,
  }
}

function resolveSessionRef(options: {
  payload: Record<string, unknown>
  fallbackProvider?: CodingCliProviderName
  fallbackSessionId?: string
}): SessionLocator | undefined {
  const explicit = parseSessionLocator(options.payload.sessionRef)
  if (explicit) return explicit
  if (!options.fallbackProvider || !options.fallbackSessionId) return undefined
  return {
    provider: options.fallbackProvider,
    sessionId: options.fallbackSessionId,
  }
}

function parseLiveTerminalHandle(
  value: unknown,
  recordServerInstanceId: string,
): { terminalId: string; serverInstanceId: string } | undefined {
  if (!value || typeof value !== 'object') return undefined
  const candidate = value as { terminalId?: unknown; serverInstanceId?: unknown }
  if (typeof candidate.terminalId !== 'string' || typeof candidate.serverInstanceId !== 'string') {
    return undefined
  }
  if (candidate.serverInstanceId !== recordServerInstanceId) {
    return undefined
  }
  return {
    terminalId: candidate.terminalId,
    serverInstanceId: candidate.serverInstanceId,
  }
}

function normalizePaneSnapshot(snapshot: RegistryPaneSnapshot): RegistryPaneSnapshot {
  const parsed = RegistryPaneSnapshotSchema.safeParse(snapshot)
  return parsed.success ? parsed.data : snapshot
}

export function sanitizePaneSnapshot(
  record: RegistryTabRecord,
  rawSnapshot: RegistryPaneSnapshot,
  localServerInstanceId?: string,
): PaneContentInput {
  const snapshot = normalizePaneSnapshot(rawSnapshot)
  const payload = snapshot.payload || {}
  const sameServer = !!localServerInstanceId && record.serverInstanceId === localServerInstanceId
  if (snapshot.kind === 'terminal') {
    const mode = (payload.mode as TabMode) || 'shell'
    const sessionRef = resolveSessionRef({ payload })
    const liveTerminal = parseLiveTerminalHandle(payload.liveTerminal, record.serverInstanceId)
    const codexDurability = mode === 'codex'
      ? sanitizeCodexDurabilityRef(payload.codexDurability)
      : undefined
    const includeLiveTerminal = sameServer && !sessionRef
    return {
      kind: 'terminal',
      mode,
      shell: (payload.shell as 'system' | 'cmd' | 'powershell' | 'wsl') || 'system',
      sessionRef,
      ...(codexDurability ? { codexDurability } : {}),
      terminalId: includeLiveTerminal ? liveTerminal?.terminalId : undefined,
      serverInstanceId: includeLiveTerminal ? record.serverInstanceId : undefined,
      initialCwd: payload.initialCwd as string | undefined,
      ...parsePaneNamingIdentityInput(payload),
    }
  }
  if (snapshot.kind === 'browser') {
    return {
      kind: 'browser',
      url: (payload.url as string) || 'https://example.com',
      devToolsOpen: !!payload.devToolsOpen,
    }
  }
  if (snapshot.kind === 'editor') {
    return {
      kind: 'editor',
      filePath: (payload.filePath as string | null) ?? null,
      language: (payload.language as string | null) ?? null,
      readOnly: !!payload.readOnly,
      content: '',
      viewMode: (payload.viewMode as 'source' | 'preview') || 'source',
      wordWrap: payload.wordWrap !== false,
    }
  }
  if (snapshot.kind === 'fresh-agent') {
    const sessionType = normalizeFreshAgentSessionType(payload.sessionType)
      ?? normalizeFreshAgentSessionType(payload.provider)
    const provider = (
      payload.provider === 'claude'
      || payload.provider === 'codex'
      || payload.provider === 'opencode'
    )
      ? payload.provider
      : resolveFreshAgentRuntimeProvider(sessionType)
    if (!sessionType || !provider) return { kind: 'picker' }
    const resumeSessionId = typeof payload.resumeSessionId === 'string'
      ? payload.resumeSessionId
      : undefined
    const sessionRef = resolveSessionRef({
      payload,
      fallbackProvider: provider,
      fallbackSessionId: resumeSessionId,
    })
    const style = normalizeFreshAgentStyleOverride(payload.style)
    const restoreError = sanitizeRestoreError(payload.restoreError)
    return {
      kind: 'fresh-agent',
      sessionType,
      provider,
      resumeSessionId,
      ...(sessionRef ? { sessionRef } : {}),
      ...(restoreError && !sessionRef ? { restoreError } : {}),
      serverInstanceId: record.serverInstanceId,
      initialCwd: payload.initialCwd as string | undefined,
      checkpointWorkspace: payload.checkpointWorkspace as FreshAgentCheckpointWorkspace | undefined,
      model: payload.model as string | undefined,
      modelSelection: normalizeFreshAgentModelSelection(payload.modelSelection, payload.model),
      permissionMode: payload.permissionMode as string | undefined,
      sandbox: payload.sandbox as 'read-only' | 'workspace-write' | 'danger-full-access' | undefined,
      effort: normalizeFreshAgentEffortOverride(payload.effort),
      plugins: payload.plugins as string[] | undefined,
      ...(style ? { style } : {}),
      settingsDismissed: typeof payload.settingsDismissed === 'boolean' ? payload.settingsDismissed : undefined,
      showTimecodes: typeof payload.showTimecodes === 'boolean' ? payload.showTimecodes : undefined,
      ...parsePaneNamingIdentityInput(payload),
    }
  }
  if (snapshot.kind === 'extension') {
    return {
      kind: 'extension',
      extensionName: (payload.extensionName as string) || 'unknown',
      props: (payload.props as Record<string, unknown>) || {},
    }
  }
  if (snapshot.kind === 'host-stats') {
    return { kind: 'host-stats' }
  }
  return { kind: 'picker' }
}

function deriveModeFromRecord(record: RegistryTabRecord): TabMode {
  const firstKind = record.panes[0]?.kind
  if (firstKind === 'terminal') {
    const mode = record.panes[0]?.payload?.mode
    if (typeof mode === 'string') return mode as TabMode
    return 'shell'
  }
  if (firstKind === 'fresh-agent') {
    const provider = record.panes[0]?.payload?.provider
    if (typeof provider === 'string' && isNonShellMode(provider)) return provider as TabMode
    return 'claude'
  }
  return 'shell'
}

export function paneKindIcon(kind: RegistryPaneSnapshot['kind']): LucideIcon {
  if (kind === 'terminal') return TerminalSquare
  if (kind === 'browser') return Globe
  if (kind === 'editor') return FileCode2
  if (kind === 'fresh-agent') return Bot
  if (kind === 'host-stats') return Gauge
  return Square
}

export function paneKindColorClass(kind: RegistryPaneSnapshot['kind']): string {
  if (kind === 'terminal') return 'text-foreground/50'
  if (kind === 'browser') return 'text-blue-500'
  if (kind === 'editor') return 'text-emerald-500'
  if (kind === 'fresh-agent' || kind === 'claude-chat') return 'text-amber-500'
  if (kind === 'extension') return 'text-purple-500'
  if (kind === 'host-stats') return 'text-cyan-500'
  return 'text-muted-foreground'
}

export function paneKindLabel(kind: RegistryPaneSnapshot['kind']): string {
  if (kind === 'terminal') return 'Terminal'
  if (kind === 'browser') return 'Browser'
  if (kind === 'editor') return 'Editor'
  if (kind === 'fresh-agent' || kind === 'claude-chat') return 'Agent'
  if (kind === 'extension') return 'Extension'
  if (kind === 'host-stats') return 'System Status'
  return kind
}

export type TabsRegistryGroups = {
  localOpen: RegistryTabRecord[]
  sameDeviceOpen: RegistryTabRecord[]
  remoteOpen: RegistryTabRecord[]
  closed: RegistryTabRecord[]
}

export function findRecordByTabKey(
  groups: TabsRegistryGroups,
  tabKey: string,
  status?: RegistryTabRecord['status'],
): RegistryTabRecord | undefined {
  const lists = [groups.localOpen, groups.sameDeviceOpen, groups.remoteOpen, groups.closed]
  if (status) {
    for (const list of lists) {
      const match = list.find((record) => record.tabKey === tabKey && record.status === status)
      if (match) return match
    }
  }
  for (const list of lists) {
    const match = list.find((record) => record.tabKey === tabKey)
    if (match) return match
  }
  return undefined
}

export type OpenTabRecordDeps = {
  dispatch: AppDispatch
  localServerInstanceId?: string
  onOpened?: () => void
}

export function openRecordAsUnlinkedCopy(record: RegistryTabRecord, deps: OpenTabRecordDeps): void {
  const { dispatch, localServerInstanceId, onOpened } = deps
  const tabId = nanoid()
  const paneSnapshots = record.panes || []
  // Unified agent names (Task 6): the copy remints every pane id EXPLICITLY
  // (initLayout/addPane accept the minted ids) so the old→new map exists to
  // remap the tab's nameSource through — a stale recorded pane id must never
  // survive into the new tab's pointer.
  const paneIdMap = new Map<string, string>()
  for (const pane of paneSnapshots) {
    paneIdMap.set(pane.paneId, nanoid())
  }
  const firstPane = paneSnapshots[0]
  const firstContent = firstPane
    ? sanitizePaneSnapshot(record, firstPane, localServerInstanceId)
    : ({ kind: 'terminal', mode: 'shell' } as const)
  dispatch(
    addTab({
      id: tabId,
      title: record.tabName,
      mode: deriveModeFromRecord(record),
      status: 'creating',
      serverInstanceId: record.serverInstanceId,
      ...(record.nameSource
        ? { nameSource: remapTabNameSource(record.nameSource, paneIdMap) }
        : {}),
    }),
  )
  dispatch(initLayout({
    tabId,
    paneId: paneIdMap.get(firstPane?.paneId ?? '') ?? undefined,
    content: firstContent,
  }))
  for (const pane of paneSnapshots.slice(1)) {
    dispatch(addPane({
      tabId,
      newContent: sanitizePaneSnapshot(record, pane, localServerInstanceId),
      newPaneId: paneIdMap.get(pane.paneId),
    }))
  }
  onOpened?.()
}

export function openPaneInNewTab(
  record: RegistryTabRecord,
  pane: RegistryPaneSnapshot,
  deps: OpenTabRecordDeps,
): void {
  const { dispatch, localServerInstanceId, onOpened } = deps
  const tabId = nanoid()
  const content = sanitizePaneSnapshot(record, pane, localServerInstanceId)
  // Unified agent names (Task 6): a scoped agent pane moved into its own tab
  // OWNS that tab — never the composed `${record.tabName} · ${pane.title}`
  // agent-group label. The pane's own title (or kind label) is the neutral
  // fallback; the display reads the canonical session name once cached, and
  // the lifecycle middleware resolves the tab's pointer from the created
  // layout (that pane is the original pane). Non-agent panes keep the
  // existing composed title.
  const scopedPane = isScopedNameSourceContent(content as PaneContent)
  dispatch(
    addTab({
      id: tabId,
      title: scopedPane
        ? (pane.title || paneKindLabel(pane.kind))
        : `${record.tabName} · ${pane.title || pane.kind}`,
      mode: deriveModeFromRecord(record),
      status: 'creating',
      serverInstanceId: record.serverInstanceId,
    }),
  )
  dispatch(
    initLayout({
      tabId,
      content,
    }),
  )
  onOpened?.()
}

export function jumpToRecord(
  record: RegistryTabRecord,
  deps: OpenTabRecordDeps & { hasLocalTab: (tabId: string) => boolean },
): void {
  if (!deps.hasLocalTab(record.tabId)) {
    openRecordAsUnlinkedCopy(record, deps)
    return
  }
  deps.dispatch(setActiveTab(record.tabId))
  deps.onOpened?.()
}
