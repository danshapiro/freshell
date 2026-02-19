import { useEffect, useMemo, useState } from 'react'
import { nanoid } from 'nanoid'
import {
  Archive,
  Bot,
  ChevronDown,
  ChevronRight,
  FileCode2,
  Globe,
  Monitor,
  Square,
  TerminalSquare,
  type LucideIcon,
} from 'lucide-react'
import { useAppDispatch, useAppSelector, useAppStore } from '@/store/hooks'
import { getWsClient } from '@/lib/ws-client'
import type { RegistryPaneSnapshot, RegistryTabRecord } from '@/store/tabRegistryTypes'
import { addTab, setActiveTab } from '@/store/tabsSlice'
import { addPane, initLayout } from '@/store/panesSlice'
import { setTabRegistryLoading, setTabRegistrySearchRangeDays } from '@/store/tabRegistrySlice'
import { selectTabsRegistryGroups } from '@/store/selectors/tabsRegistrySelectors'
import { CODING_CLI_PROVIDERS } from '@/lib/coding-cli-utils'
import type { PaneContentInput, SessionLocator } from '@/store/paneTypes'
import type { CodingCliProviderName, TabMode } from '@/store/types'

type FilterMode = 'all' | 'open' | 'closed'
type ScopeMode = 'all' | 'local' | 'remote'

type DisplayRecord = RegistryTabRecord & { displayDeviceLabel: string }

const CODING_CLI_PROVIDER_SET: ReadonlySet<CodingCliProviderName> = new Set(CODING_CLI_PROVIDERS)

function parseSessionLocator(value: unknown): SessionLocator | undefined {
  if (!value || typeof value !== 'object') return undefined
  const candidate = value as { provider?: unknown; sessionId?: unknown; serverInstanceId?: unknown }
  if (typeof candidate.provider !== 'string' || !CODING_CLI_PROVIDER_SET.has(candidate.provider as CodingCliProviderName)) {
    return undefined
  }
  if (typeof candidate.sessionId !== 'string') return undefined
  return {
    provider: candidate.provider as CodingCliProviderName,
    sessionId: candidate.sessionId,
    ...(typeof candidate.serverInstanceId === 'string' ? { serverInstanceId: candidate.serverInstanceId } : {}),
  }
}

function resolveSessionRef(options: {
  payload: Record<string, unknown>
  fallbackProvider?: CodingCliProviderName
  fallbackSessionId?: string
  fallbackServerInstanceId?: string
}): SessionLocator | undefined {
  const explicit = parseSessionLocator(options.payload.sessionRef)
  if (explicit) return explicit
  if (!options.fallbackProvider || !options.fallbackSessionId) return undefined
  return {
    provider: options.fallbackProvider,
    sessionId: options.fallbackSessionId,
    ...(options.fallbackServerInstanceId ? { serverInstanceId: options.fallbackServerInstanceId } : {}),
  }
}

function sanitizePaneSnapshot(
  record: RegistryTabRecord,
  snapshot: RegistryPaneSnapshot,
  localServerInstanceId?: string,
): PaneContentInput {
  const payload = snapshot.payload || {}
  const sameServer = !!localServerInstanceId && record.serverInstanceId === localServerInstanceId
  if (snapshot.kind === 'terminal') {
    const mode = (payload.mode as TabMode) || 'shell'
    const resumeSessionId = payload.resumeSessionId as string | undefined
    const sessionRef = resolveSessionRef({
      payload,
      fallbackProvider: mode !== 'shell' ? mode : undefined,
      fallbackSessionId: resumeSessionId,
      fallbackServerInstanceId: record.serverInstanceId,
    })
    return {
      kind: 'terminal',
      mode,
      shell: (payload.shell as 'system' | 'cmd' | 'powershell' | 'wsl') || 'system',
      resumeSessionId: sameServer ? resumeSessionId : undefined,
      sessionRef,
      initialCwd: payload.initialCwd as string | undefined,
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
    }
  }
  if (snapshot.kind === 'claude-chat') {
    const resumeSessionId = payload.resumeSessionId as string | undefined
    const sessionRef = resolveSessionRef({
      payload,
      fallbackProvider: 'claude',
      fallbackSessionId: resumeSessionId,
      fallbackServerInstanceId: record.serverInstanceId,
    })
    return {
      kind: 'claude-chat',
      resumeSessionId: sameServer ? resumeSessionId : undefined,
      sessionRef,
      initialCwd: payload.initialCwd as string | undefined,
      model: payload.model as string | undefined,
      permissionMode: payload.permissionMode as string | undefined,
      effort: payload.effort as 'low' | 'medium' | 'high' | 'max' | undefined,
    }
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
  if (firstKind === 'claude-chat') return 'claude'
  return 'shell'
}

function paneKindIcon(kind: RegistryPaneSnapshot['kind']): LucideIcon {
  if (kind === 'terminal') return TerminalSquare
  if (kind === 'browser') return Globe
  if (kind === 'editor') return FileCode2
  if (kind === 'claude-chat') return Bot
  return Square
}

function formatClosedSince(record: RegistryTabRecord, now: number): string {
  const closedAt = record.closedAt ?? record.updatedAt
  const diff = Math.max(0, now - closedAt)
  const minutes = Math.floor(diff / 60000)
  const hours = Math.floor(diff / 3600000)
  const days = Math.floor(diff / 86400000)
  if (minutes < 1) return 'closed just now'
  if (minutes < 60) return `closed ~${minutes}m ago`
  if (hours < 24) return `closed ~${hours}h ago`
  if (days < 30) return `closed ~${days}d ago`
  return `closed ${new Date(closedAt).toLocaleDateString()}`
}

function matchRecord(record: DisplayRecord, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  const paneText = record.panes
    .map((pane) => `${pane.title || ''} ${pane.kind}`)
    .join(' ')
    .toLowerCase()
  return (
    record.tabName.toLowerCase().includes(q) ||
    record.displayDeviceLabel.toLowerCase().includes(q) ||
    paneText.includes(q)
  )
}

function Section({
  title,
  icon: Icon,
  records,
  expanded,
  onToggleExpanded,
  onJump,
  onOpenAsCopy,
  onOpenPaneInNewTab,
}: {
  title: string
  icon: LucideIcon
  records: DisplayRecord[]
  expanded: Record<string, boolean>
  onToggleExpanded: (tabKey: string) => void
  onJump: (record: RegistryTabRecord) => void
  onOpenAsCopy: (record: RegistryTabRecord) => void
  onOpenPaneInNewTab: (record: RegistryTabRecord, pane: RegistryPaneSnapshot) => void
}) {
  const now = Date.now()
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold text-muted-foreground flex items-center gap-2">
        <Icon className="h-4 w-4" />
        <span>{title}</span>
      </h2>
      {records.length === 0 ? (
        <div className="rounded-md border border-border/60 p-3 text-xs text-muted-foreground">None</div>
      ) : (
        records.map((record) => {
          const isExpanded = expanded[record.tabKey] ?? (record.status === 'open')
          const paneKinds = [...new Set(record.panes.map((pane) => pane.kind))]
          return (
            <article key={record.tabKey} className="rounded-md border border-border/60 p-3 space-y-2">
              <div className="flex items-start justify-between gap-2">
                <button
                  className="flex items-start gap-2 min-w-0 text-left hover:opacity-90"
                  onClick={() => onToggleExpanded(record.tabKey)}
                  aria-expanded={isExpanded}
                  aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${record.displayDeviceLabel}: ${record.tabName}`}
                >
                  {isExpanded ? <ChevronDown className="h-4 w-4 mt-0.5 shrink-0" /> : <ChevronRight className="h-4 w-4 mt-0.5 shrink-0" />}
                  <div className="min-w-0">
                    <div className="text-sm font-medium truncate flex items-center gap-2">
                      <span className="truncate">{record.displayDeviceLabel}: {record.tabName}</span>
                    </div>
                    <div className="text-xs text-muted-foreground flex items-center gap-2">
                      <span>
                        {record.status === 'closed'
                          ? formatClosedSince(record, now)
                          : `${record.status} · ${record.paneCount} pane${record.paneCount === 1 ? '' : 's'}`}
                      </span>
                    </div>
                  </div>
                </button>
                <div className="flex items-center gap-1 shrink-0">
                  {paneKinds.map((kind) => {
                    const PaneIcon = paneKindIcon(kind)
                    return <PaneIcon key={`${record.tabKey}-${kind}`} className="h-3.5 w-3.5 text-muted-foreground" />
                  })}
                  {record.status === 'open' ? (
                    <button
                      className="px-2 py-1 text-xs rounded-md border hover:bg-muted"
                      aria-label={`Jump to ${record.displayDeviceLabel}: ${record.tabName}`}
                      onClick={() => onJump(record)}
                    >
                      Jump
                    </button>
                  ) : null}
                  <button
                    className="px-2 py-1 text-xs rounded-md border hover:bg-muted"
                    aria-label={`Open copy of ${record.displayDeviceLabel}: ${record.tabName}`}
                    onClick={() => onOpenAsCopy(record)}
                  >
                    Open copy
                  </button>
                </div>
              </div>

              {isExpanded && record.panes.length > 0 ? (
                <div className="space-y-1">
                  {record.panes.map((pane) => {
                    const PaneIcon = paneKindIcon(pane.kind)
                    return (
                      <div key={pane.paneId} className="flex items-center justify-between text-xs bg-muted/30 rounded px-2 py-1 gap-2">
                        <span className="truncate flex items-center gap-2">
                          <PaneIcon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                          <span className="truncate">{pane.title || pane.kind}</span>
                        </span>
                        <button
                          className="px-2 py-0.5 rounded border hover:bg-muted shrink-0"
                          aria-label={`Open pane ${pane.title || pane.kind} from ${record.displayDeviceLabel}: ${record.tabName} in a new tab`}
                          onClick={() => onOpenPaneInNewTab(record, pane)}
                        >
                          Open pane
                        </button>
                      </div>
                    )
                  })}
                </div>
              ) : null}
            </article>
          )
        })
      )}
    </section>
  )
}

export default function TabsView({ onOpenTab }: { onOpenTab?: () => void }) {
  const dispatch = useAppDispatch()
  const store = useAppStore()
  const ws = useMemo(() => getWsClient(), [])
  const groups = useAppSelector(selectTabsRegistryGroups)
  const { deviceId, deviceLabel, deviceAliases, searchRangeDays, syncError } = useAppSelector((state) => state.tabRegistry)
  const localServerInstanceId = useAppSelector((state) => state.connection.serverInstanceId)
  const connectionStatus = useAppSelector((state) => state.connection.status)
  const connectionError = useAppSelector((state) => state.connection.lastError)
  const [query, setQuery] = useState('')
  const [filterMode, setFilterMode] = useState<FilterMode>('all')
  const [scopeMode, setScopeMode] = useState<ScopeMode>('all')
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  const withDisplayDeviceLabel = useMemo(
    () => (record: RegistryTabRecord): DisplayRecord => ({
      ...record,
      displayDeviceLabel:
        record.deviceId === deviceId
          ? deviceLabel
          : (deviceAliases[record.deviceId] || record.deviceLabel),
    }),
    [deviceAliases, deviceId, deviceLabel],
  )

  useEffect(() => {
    if (ws.state !== 'ready') return
    if (searchRangeDays <= 30) return
    dispatch(setTabRegistryLoading(true))
    ws.sendTabsSyncQuery({
      requestId: `tabs-range-${Date.now()}`,
      deviceId,
      rangeDays: searchRangeDays,
    })
  }, [dispatch, ws, deviceId, searchRangeDays])

  const filtered = useMemo(() => {
    const localOpen = groups.localOpen.map(withDisplayDeviceLabel).filter((record) => matchRecord(record, query))
    const remoteOpen = groups.remoteOpen.map(withDisplayDeviceLabel).filter((record) => matchRecord(record, query))
    const closed = groups.closed.map(withDisplayDeviceLabel).filter((record) => matchRecord(record, query))

    const byScope = (records: DisplayRecord[], scope: 'local' | 'remote') => {
      if (scopeMode === 'all') return records
      return scopeMode === scope ? records : []
    }

    return {
      localOpen: filterMode === 'closed' ? [] : byScope(localOpen, 'local'),
      remoteOpen: filterMode === 'closed' ? [] : byScope(remoteOpen, 'remote'),
      closed: filterMode === 'open' ? [] : closed,
    }
  }, [groups, query, filterMode, scopeMode, withDisplayDeviceLabel])

  const openRecordAsUnlinkedCopy = (record: RegistryTabRecord) => {
    const tabId = nanoid()
    const paneSnapshots = record.panes || []
    const firstPane = paneSnapshots[0]
    const firstContent = firstPane
      ? sanitizePaneSnapshot(record, firstPane, localServerInstanceId)
      : { kind: 'terminal', mode: 'shell' } as const
    dispatch(addTab({
      id: tabId,
      title: record.tabName,
      mode: deriveModeFromRecord(record),
      status: 'creating',
    }))
    dispatch(initLayout({
      tabId,
      content: firstContent,
    }))
    for (const pane of paneSnapshots.slice(1)) {
      dispatch(addPane({
        tabId,
        newContent: sanitizePaneSnapshot(record, pane, localServerInstanceId),
      }))
    }
    onOpenTab?.()
  }

  const openPaneInNewTab = (record: RegistryTabRecord, pane: RegistryPaneSnapshot) => {
    const tabId = nanoid()
    dispatch(addTab({
      id: tabId,
      title: `${record.tabName} · ${pane.title || pane.kind}`,
      mode: deriveModeFromRecord(record),
      status: 'creating',
    }))
    dispatch(initLayout({
      tabId,
      content: sanitizePaneSnapshot(record, pane, localServerInstanceId),
    }))
    onOpenTab?.()
  }

  const jumpToRecord = (record: RegistryTabRecord) => {
    const localTabExists = store.getState().tabs.tabs.some((tab) => tab.id === record.tabId)
    if (!localTabExists) {
      openRecordAsUnlinkedCopy(record)
      return
    }
    dispatch(setActiveTab(record.tabId))
    onOpenTab?.()
  }

  return (
    <div className="h-full flex flex-col">
      <div className="px-6 py-5 border-b border-border/30 space-y-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight flex items-center gap-2">
            <Archive className="h-5 w-5" />
            <span>Tabs</span>
          </h1>
          <p className="text-sm text-muted-foreground">
            Open on this machine, open on other machines, and closed history.
          </p>
        </div>
        {connectionStatus !== 'ready' || syncError ? (
          <div role="alert" className="rounded-md border border-amber-500/50 bg-amber-500/10 p-2 text-xs text-amber-900 dark:text-amber-200">
            Tabs sync unavailable.
            {syncError ? ` ${syncError}` : ' Reconnect WebSocket to refresh remote tabs.'}
            {!syncError && connectionError ? ` (${connectionError})` : ''}
          </div>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <input
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search tabs, devices, panes..."
            className="h-9 min-w-[14rem] px-3 text-sm rounded-md border border-border bg-background"
            aria-label="Search tabs"
          />
          <select
            value={filterMode}
            onChange={(event) => setFilterMode(event.target.value as FilterMode)}
            className="h-9 px-2 text-sm rounded-md border border-border bg-background"
            aria-label="Tab status filter"
          >
            <option value="all">All</option>
            <option value="open">Open</option>
            <option value="closed">Closed</option>
          </select>
          <select
            value={scopeMode}
            onChange={(event) => setScopeMode(event.target.value as ScopeMode)}
            className="h-9 px-2 text-sm rounded-md border border-border bg-background"
            aria-label="Device scope filter"
          >
            <option value="all">Local + Remote</option>
            <option value="local">Local</option>
            <option value="remote">Remote</option>
          </select>
          <select
            value={String(searchRangeDays)}
            onChange={(event) => dispatch(setTabRegistrySearchRangeDays(Number(event.target.value)))}
            className="h-9 px-2 text-sm rounded-md border border-border bg-background"
            aria-label="Closed range filter"
          >
            <option value="30">Last 30 days (default)</option>
            <option value="90">Last 90 days</option>
            <option value="365">Last year</option>
          </select>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-5">
        <Section
          title="Open on this device"
          icon={Monitor}
          records={filtered.localOpen}
          expanded={expanded}
          onToggleExpanded={(tabKey) => setExpanded((current) => ({ ...current, [tabKey]: !(current[tabKey] ?? true) }))}
          onJump={jumpToRecord}
          onOpenAsCopy={openRecordAsUnlinkedCopy}
          onOpenPaneInNewTab={openPaneInNewTab}
        />
        <Section
          title="Open on other devices"
          icon={Globe}
          records={filtered.remoteOpen}
          expanded={expanded}
          onToggleExpanded={(tabKey) => setExpanded((current) => ({ ...current, [tabKey]: !(current[tabKey] ?? true) }))}
          onJump={jumpToRecord}
          onOpenAsCopy={openRecordAsUnlinkedCopy}
          onOpenPaneInNewTab={openPaneInNewTab}
        />
        <Section
          title="Closed"
          icon={Archive}
          records={filtered.closed}
          expanded={expanded}
          onToggleExpanded={(tabKey) => setExpanded((current) => ({ ...current, [tabKey]: !(current[tabKey] ?? false) }))}
          onJump={jumpToRecord}
          onOpenAsCopy={openRecordAsUnlinkedCopy}
          onOpenPaneInNewTab={openPaneInNewTab}
        />
      </div>
    </div>
  )
}
