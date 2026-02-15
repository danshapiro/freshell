import { useEffect, useMemo, useState } from 'react'
import { nanoid } from 'nanoid'
import { useAppDispatch, useAppSelector, useAppStore } from '@/store/hooks'
import { getWsClient } from '@/lib/ws-client'
import type { RegistryPaneSnapshot, RegistryTabRecord } from '@/store/tabRegistryTypes'
import { addTab, setActiveTab } from '@/store/tabsSlice'
import { addPane, initLayout } from '@/store/panesSlice'
import { setTabRegistryLoading, setTabRegistrySearchRangeDays } from '@/store/tabRegistrySlice'
import { selectTabsRegistryGroups } from '@/store/selectors/tabsRegistrySelectors'
import type { PaneContentInput } from '@/store/paneTypes'
import type { TabMode } from '@/store/types'

type FilterMode = 'all' | 'open' | 'closed'
type ScopeMode = 'all' | 'local' | 'remote'

function sanitizePaneSnapshot(snapshot: RegistryPaneSnapshot): PaneContentInput {
  const payload = snapshot.payload || {}
  if (snapshot.kind === 'terminal') {
    return {
      kind: 'terminal',
      mode: (payload.mode as TabMode) || 'shell',
      shell: (payload.shell as 'system' | 'cmd' | 'powershell' | 'wsl') || 'system',
      resumeSessionId: payload.resumeSessionId as string | undefined,
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
    return {
      kind: 'claude-chat',
      resumeSessionId: payload.resumeSessionId as string | undefined,
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

function matchRecord(record: RegistryTabRecord, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  const paneTitles = record.panes.map((pane) => pane.title || '').join(' ')
  return (
    record.tabName.toLowerCase().includes(q) ||
    record.deviceLabel.toLowerCase().includes(q) ||
    paneTitles.toLowerCase().includes(q)
  )
}

function Section({
  title,
  records,
  onJump,
  onOpenAsCopy,
  onOpenPaneInCurrent,
  onOpenPaneInNewTab,
}: {
  title: string
  records: RegistryTabRecord[]
  onJump: (record: RegistryTabRecord) => void
  onOpenAsCopy: (record: RegistryTabRecord) => void
  onOpenPaneInCurrent: (record: RegistryTabRecord, pane: RegistryPaneSnapshot) => void
  onOpenPaneInNewTab: (record: RegistryTabRecord, pane: RegistryPaneSnapshot) => void
}) {
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold text-muted-foreground">{title}</h2>
      {records.length === 0 ? (
        <div className="rounded-md border border-border/60 p-3 text-xs text-muted-foreground">None</div>
      ) : (
        records.map((record) => (
          <article key={record.tabKey} className="rounded-md border border-border/60 p-3 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="text-sm font-medium truncate">{record.deviceLabel}: {record.tabName}</div>
                <div className="text-xs text-muted-foreground">
                  {record.status} · {record.paneCount} pane{record.paneCount === 1 ? '' : 's'}
                </div>
              </div>
              <div className="flex items-center gap-1">
                {record.status === 'open' ? (
                  <button
                    className="px-2 py-1 text-xs rounded-md border hover:bg-muted"
                    onClick={() => onJump(record)}
                  >
                    Jump
                  </button>
                ) : null}
                <button
                  className="px-2 py-1 text-xs rounded-md border hover:bg-muted"
                  onClick={() => onOpenAsCopy(record)}
                >
                  Open copy
                </button>
              </div>
            </div>
            {record.panes.length > 0 ? (
              <div className="space-y-1">
                {record.panes.map((pane) => (
                  <div key={pane.paneId} className="flex items-center justify-between text-xs bg-muted/30 rounded px-2 py-1 gap-2">
                    <span className="truncate">{pane.title || pane.kind}</span>
                    <div className="flex items-center gap-1">
                      <button
                        className="px-2 py-0.5 rounded border hover:bg-muted"
                        onClick={() => onOpenPaneInCurrent(record, pane)}
                      >
                        Open here
                      </button>
                      <button
                        className="px-2 py-0.5 rounded border hover:bg-muted"
                        onClick={() => onOpenPaneInNewTab(record, pane)}
                      >
                        New tab
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
          </article>
        ))
      )}
    </section>
  )
}

export default function TabsView({ onOpenTab }: { onOpenTab?: () => void }) {
  const dispatch = useAppDispatch()
  const store = useAppStore()
  const ws = useMemo(() => getWsClient(), [])
  const groups = useAppSelector(selectTabsRegistryGroups)
  const { deviceId, searchRangeDays, syncError } = useAppSelector((state) => state.tabRegistry)
  const activeTabId = useAppSelector((state) => state.tabs.activeTabId)
  const connectionStatus = useAppSelector((state) => state.connection.status)
  const connectionError = useAppSelector((state) => state.connection.lastError)
  const [query, setQuery] = useState('')
  const [filterMode, setFilterMode] = useState<FilterMode>('all')
  const [scopeMode, setScopeMode] = useState<ScopeMode>('all')

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
    const localOpen = groups.localOpen.filter((record) => matchRecord(record, query))
    const remoteOpen = groups.remoteOpen.filter((record) => matchRecord(record, query))
    const closed = groups.closed.filter((record) => matchRecord(record, query))

    const byScope = (records: RegistryTabRecord[], scope: 'local' | 'remote') => {
      if (scopeMode === 'all') return records
      return scopeMode === scope ? records : []
    }

    return {
      localOpen: filterMode === 'closed' ? [] : byScope(localOpen, 'local'),
      remoteOpen: filterMode === 'closed' ? [] : byScope(remoteOpen, 'remote'),
      closed: filterMode === 'open' ? [] : closed,
    }
  }, [groups, query, filterMode, scopeMode])

  const openRecordAsUnlinkedCopy = (record: RegistryTabRecord) => {
    const tabId = nanoid()
    const paneSnapshots = record.panes || []
    const firstPane = paneSnapshots[0]
    const firstContent = firstPane ? sanitizePaneSnapshot(firstPane) : { kind: 'terminal', mode: 'shell' } as const
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
        newContent: sanitizePaneSnapshot(pane),
      }))
    }
    onOpenTab?.()
  }

  const openPaneInCurrent = (_record: RegistryTabRecord, pane: RegistryPaneSnapshot) => {
    if (!activeTabId) {
      openPaneInNewTab(_record, pane)
      return
    }
    dispatch(addPane({
      tabId: activeTabId,
      newContent: sanitizePaneSnapshot(pane),
    }))
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
      content: sanitizePaneSnapshot(pane),
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
          <h1 className="text-xl font-semibold tracking-tight">Tabs</h1>
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
          records={filtered.localOpen}
          onJump={jumpToRecord}
          onOpenAsCopy={openRecordAsUnlinkedCopy}
          onOpenPaneInCurrent={openPaneInCurrent}
          onOpenPaneInNewTab={openPaneInNewTab}
        />
        <Section
          title="Open on other devices"
          records={filtered.remoteOpen}
          onJump={jumpToRecord}
          onOpenAsCopy={openRecordAsUnlinkedCopy}
          onOpenPaneInCurrent={openPaneInCurrent}
          onOpenPaneInNewTab={openPaneInNewTab}
        />
        <Section
          title="Closed"
          records={filtered.closed}
          onJump={jumpToRecord}
          onOpenAsCopy={openRecordAsUnlinkedCopy}
          onOpenPaneInCurrent={openPaneInCurrent}
          onOpenPaneInNewTab={openPaneInNewTab}
        />
      </div>
    </div>
  )
}
