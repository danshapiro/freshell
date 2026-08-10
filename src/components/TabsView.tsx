import { memo, useEffect, useMemo, useState } from 'react'
import {
  Archive,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Globe,
  Monitor,
  type LucideIcon,
} from 'lucide-react'
import { useAppDispatch, useAppSelector, useAppStore } from '@/store/hooks'
import { getWsClient } from '@/lib/ws-client'
import type { RegistryTabRecord } from '@/store/tabRegistryTypes'
import { setTabRegistryLoading, setTabRegistrySearchRangeDays } from '@/store/tabRegistrySlice'
import { selectTabsRegistryGroups } from '@/store/selectors/tabsRegistrySelectors'
import { getCurrentTabRegistryClientInstanceId } from '@/store/tabRegistrySync'
import { cn } from '@/lib/utils'
import { ContextIds } from '@/components/context-menu/context-menu-constants'
import {
  jumpToRecord as jumpToRecordAction,
  openRecordAsUnlinkedCopy as openRecordAsUnlinkedCopyAction,
  paneKindColorClass,
  paneKindIcon,
  paneKindLabel,
} from '@/lib/tab-registry-open'

// Compatibility re-export: test/unit/client/tab-registry-fresh-agent-migration.test.ts
// (and any external caller) imports sanitizePaneSnapshot from this module.
export { sanitizePaneSnapshot } from '@/lib/tab-registry-open'

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

type FilterMode = 'all' | 'open' | 'closed'
type ScopeMode = 'all' | 'local' | 'remote'

type DisplayRecord = RegistryTabRecord & { displayDeviceLabel: string }

type DeviceGroupData = {
  deviceId: string
  deviceLabel: string
  tabs: DisplayRecord[]
}

/* ------------------------------------------------------------------ */
/*  Utilities (unchanged business logic)                              */
/* ------------------------------------------------------------------ */

function formatRelativeTime(timestamp: number, now: number): string {
  const diff = Math.max(0, now - timestamp)
  const minutes = Math.floor(diff / 60000)
  const hours = Math.floor(diff / 3600000)
  const days = Math.floor(diff / 86400000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  if (hours < 24) return `${hours}h ago`
  if (days < 30) return `${days}d ago`
  return new Date(timestamp).toLocaleDateString()
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

function groupByDevice(records: DisplayRecord[]): DeviceGroupData[] {
  const map = new Map<string, DeviceGroupData>()
  for (const record of records) {
    const existing = map.get(record.deviceId)
    if (existing) {
      existing.tabs.push(record)
    } else {
      map.set(record.deviceId, {
        deviceId: record.deviceId,
        deviceLabel: record.displayDeviceLabel,
        tabs: [record],
      })
    }
  }
  return [...map.values()]
}

/* ------------------------------------------------------------------ */
/*  Segmented control                                                 */
/* ------------------------------------------------------------------ */

function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: { value: T; label: string }[]
  value: T
  onChange: (value: T) => void
  ariaLabel: string
}) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className="inline-flex rounded-md border border-border bg-muted/40 p-0.5"
    >
      {options.map((option) => (
        <button
          key={option.value}
          role="radio"
          aria-checked={option.value === value}
          className={cn(
            'px-2.5 py-1 text-xs rounded-sm transition-colors',
            option.value === value
              ? 'bg-background text-foreground shadow-sm font-medium'
              : 'text-muted-foreground hover:text-foreground',
          )}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Tab card                                                          */
/* ------------------------------------------------------------------ */

function TabCard({
  record,
  isLocal,
  showDevice,
  onAction,
}: {
  record: DisplayRecord
  isLocal: boolean
  showDevice?: boolean
  onAction: () => void
}) {
  const now = Date.now()
  const isOpen = record.status === 'open'
  const paneKinds = [...new Set(record.panes.map((p) => p.kind))]
  const timestamp = record.closedAt ?? record.updatedAt
  const actionLabel = isLocal && isOpen ? 'Jump' : 'Pull'

  return (
    <button
      type="button"
      className={cn(
        'group relative w-full rounded-md border p-3 text-left transition-all cursor-default select-none',
        'hover:shadow-sm',
        isOpen
          ? 'border-border/60 border-l-2 border-l-emerald-500/70 hover:border-border hover:bg-muted/40'
          : 'border-border/40 border-l-2 border-l-muted-foreground/20 opacity-70 hover:opacity-90 hover:bg-muted/30',
      )}
      data-context={ContextIds.TabsCard}
      data-tab-key={record.tabKey}
      data-tab-status={record.status}
      aria-label={`${record.displayDeviceLabel}: ${record.tabName}`}
      onClick={onAction}
    >
      {showDevice && (
        <div className="text-2xs text-muted-foreground/60 truncate mb-0.5 uppercase tracking-wide">
          {record.displayDeviceLabel}
        </div>
      )}

      <div className="text-sm font-medium truncate pr-12">{record.tabName}</div>

      <div className="mt-1.5 flex items-center gap-1.5 text-2xs text-muted-foreground">
        {paneKinds.map((kind) => {
          const Icon = paneKindIcon(kind)
          return (
            <Icon
              key={kind}
              className={cn('h-3 w-3 shrink-0', paneKindColorClass(kind))}
              aria-label={paneKindLabel(kind)}
            />
          )
        })}
        {record.paneCount > 0 && (
          <>
            <span className="text-muted-foreground/30 select-none" aria-hidden>
              &middot;
            </span>
            <span>
              {record.paneCount} pane{record.paneCount === 1 ? '' : 's'}
            </span>
          </>
        )}
        <span className="text-muted-foreground/30 select-none" aria-hidden>
          &middot;
        </span>
        <span>{formatRelativeTime(timestamp, now)}</span>
      </div>

      <div
        className={cn(
          'absolute top-2.5 right-2.5 opacity-0 group-hover:opacity-100',
          'transition-opacity pointer-events-none',
        )}
        aria-hidden
      >
        <span
          className={cn(
            'inline-flex items-center gap-1 px-1.5 py-0.5 text-2xs font-medium rounded',
            isLocal && isOpen
              ? 'bg-muted text-foreground'
              : 'bg-primary/10 text-primary',
          )}
        >
          {actionLabel}
          <ExternalLink className="h-2.5 w-2.5" />
        </span>
      </div>
    </button>
  )
}

/* ------------------------------------------------------------------ */
/*  Device section                                                    */
/* ------------------------------------------------------------------ */

function DeviceSection({
  label,
  icon: Icon,
  count,
  tabs,
  isLocal,
  collapsible,
  defaultExpanded,
  showDeviceOnCards,
  onPullAll,
  onJump,
  onOpenCopy,
}: {
  label: string
  icon: LucideIcon
  count: number
  tabs: DisplayRecord[]
  isLocal: boolean
  collapsible?: boolean
  defaultExpanded?: boolean
  showDeviceOnCards?: boolean
  onPullAll?: () => void
  onJump: (record: RegistryTabRecord) => void
  onOpenCopy: (record: RegistryTabRecord) => void
}) {
  const [expanded, setExpanded] = useState(defaultExpanded ?? true)

  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2">
        {collapsible ? (
          <button
            className="flex items-center gap-2 text-sm font-semibold text-muted-foreground hover:text-foreground transition-colors"
            onClick={() => setExpanded(!expanded)}
            aria-expanded={expanded}
            aria-label={`${expanded ? 'Collapse' : 'Expand'} ${label}`}
          >
            {expanded ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
            <Icon className="h-4 w-4" />
            <span>{label}</span>
          </button>
        ) : (
          <h2 className="flex items-center gap-2 text-sm font-semibold text-muted-foreground">
            <Icon className="h-4 w-4" />
            <span>{label}</span>
          </h2>
        )}
        <span className="text-2xs text-muted-foreground/50">
          {count} tab{count === 1 ? '' : 's'}
        </span>
        {!isLocal && onPullAll && count > 1 && (
          <button
            className="ml-auto text-2xs text-muted-foreground hover:text-foreground transition-colors"
            onClick={onPullAll}
            aria-label={`Pull all tabs from ${label}`}
          >
            Pull all
          </button>
        )}
      </div>

      {expanded && (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-2">
          {tabs.map((record) => (
            <TabCard
              key={record.tabKey}
              record={record}
              isLocal={isLocal}
              showDevice={showDeviceOnCards}
              onAction={() =>
                isLocal && record.status === 'open'
                  ? onJump(record)
                  : onOpenCopy(record)
              }
            />
          ))}
        </div>
      )}
    </section>
  )
}

/* ------------------------------------------------------------------ */
/*  Main component                                                    */
/* ------------------------------------------------------------------ */

function TabsView({ onOpenTab }: { onOpenTab?: () => void }) {
  const dispatch = useAppDispatch()
  const store = useAppStore()
  const ws = useMemo(() => getWsClient(), [])
  const groups = useAppSelector(selectTabsRegistryGroups)
  const { deviceId, deviceLabel, deviceAliases, searchRangeDays, syncError } = useAppSelector(
    (state) => state.tabRegistry,
  )
  const localServerInstanceId = useAppSelector((state) => state.connection.serverInstanceId)
  const connectionStatus = useAppSelector((state) => state.connection.status)
  const connectionError = useAppSelector((state) => state.connection.lastError)

  const [query, setQuery] = useState('')
  const [filterMode, setFilterMode] = useState<FilterMode>('all')
  const [scopeMode, setScopeMode] = useState<ScopeMode>('all')

  /* -- device label resolver ---------------------------------------- */

  const withDisplayDeviceLabel = useMemo(
    () =>
      (record: RegistryTabRecord): DisplayRecord => ({
        ...record,
        displayDeviceLabel:
          record.deviceId === deviceId
            ? deviceLabel
            : deviceAliases[record.deviceId] || record.deviceLabel,
      }),
    [deviceAliases, deviceId, deviceLabel],
  )

  /* -- search range sync -------------------------------------------- */

  useEffect(() => {
    if (ws.state !== 'ready') return
    if (searchRangeDays <= 30) return
    dispatch(setTabRegistryLoading(true))
    ws.sendTabsSyncQuery({
      requestId: `tabs-range-${Date.now()}`,
      deviceId,
      clientInstanceId: getCurrentTabRegistryClientInstanceId(),
      closedTabRetentionDays: searchRangeDays,
    })
  }, [dispatch, ws, deviceId, searchRangeDays])

  /* -- filtering ---------------------------------------------------- */

  const filtered = useMemo(() => {
    const localOpen = groups.localOpen.map(withDisplayDeviceLabel).filter((r) => matchRecord(r, query))
    const remoteOpen = groups.remoteOpen.map(withDisplayDeviceLabel).filter((r) => matchRecord(r, query))
    const closed = groups.closed.map(withDisplayDeviceLabel).filter((r) => matchRecord(r, query))

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

  const remoteDeviceGroups = useMemo(
    () => groupByDevice(filtered.remoteOpen),
    [filtered.remoteOpen],
  )

  const totalCount =
    filtered.localOpen.length + filtered.remoteOpen.length + filtered.closed.length

  /* -- actions ------------------------------------------------------ */

  const openRecordAsUnlinkedCopy = (record: RegistryTabRecord) => {
    openRecordAsUnlinkedCopyAction(record, { dispatch, localServerInstanceId, onOpened: onOpenTab })
  }

  const jumpToRecord = (record: RegistryTabRecord) => {
    jumpToRecordAction(record, {
      dispatch,
      localServerInstanceId,
      onOpened: onOpenTab,
      hasLocalTab: (tabId) => store.getState().tabs.tabs.some((tab) => tab.id === tabId),
    })
  }

  const pullAllFromDevice = (tabs: DisplayRecord[]) => {
    for (const record of tabs) {
      openRecordAsUnlinkedCopy(record)
    }
  }

  /* -- render ------------------------------------------------------- */

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="px-6 py-5 border-b border-border/30 space-y-3">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-lg font-semibold tracking-tight">Tabs</h1>
            <p className="text-xs text-muted-foreground mt-0.5">
              All your tabs across devices. Click to pull, right-click for options.
            </p>
          </div>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search..."
            className="h-8 w-48 px-3 text-xs rounded-md border border-border bg-background placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary/40"
            aria-label="Search tabs"
          />
        </div>

        {(connectionStatus !== 'ready' || syncError) && (
          <div
            role="alert"
            className="rounded-md border border-amber-500/50 bg-amber-500/10 p-2 text-xs text-amber-900 dark:text-amber-200"
          >
            Tabs sync unavailable.
            {syncError ? ` ${syncError}` : ' Reconnect WebSocket to refresh remote tabs.'}
            {!syncError && connectionError ? ` (${connectionError})` : ''}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <SegmentedControl
            options={[
              { value: 'all' as const, label: 'All' },
              { value: 'open' as const, label: 'Open' },
              { value: 'closed' as const, label: 'Closed' },
            ]}
            value={filterMode}
            onChange={setFilterMode}
            ariaLabel="Tab status filter"
          />
          <SegmentedControl
            options={[
              { value: 'all' as const, label: 'All devices' },
              { value: 'local' as const, label: 'This device' },
              { value: 'remote' as const, label: 'Other devices' },
            ]}
            value={scopeMode}
            onChange={setScopeMode}
            ariaLabel="Device scope filter"
          />
          <select
            value={String(searchRangeDays)}
            onChange={(e) => dispatch(setTabRegistrySearchRangeDays(Number(e.target.value)))}
            className="h-7 px-2 text-xs rounded-md border border-border bg-background text-muted-foreground"
            aria-label="Closed range filter"
          >
            <option value="30">Last 30 days</option>
            <option value="90">Last 90 days</option>
            <option value="365">Last year</option>
          </select>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-6">
        {totalCount === 0 && (
          <div className="flex items-center justify-center h-32 text-sm text-muted-foreground/60">
            {query ? 'No tabs match your search.' : 'No tabs to display.'}
          </div>
        )}

        {/* This device */}
        {filtered.localOpen.length > 0 && (
          <DeviceSection
            label={`This device (${deviceLabel})`}
            icon={Monitor}
            count={filtered.localOpen.length}
            tabs={filtered.localOpen}
            isLocal
            onJump={jumpToRecord}
            onOpenCopy={openRecordAsUnlinkedCopy}
          />
        )}

        {/* Remote devices */}
        {remoteDeviceGroups.length > 0 && (
          <div className="space-y-5">
            {filtered.localOpen.length > 0 && (
              <h2 className="text-xs font-semibold text-muted-foreground/50 uppercase tracking-wider">
                Other devices
              </h2>
            )}
            {remoteDeviceGroups.map((group) => (
              <DeviceSection
                key={group.deviceId}
                label={group.deviceLabel}
                icon={Globe}
                count={group.tabs.length}
                tabs={group.tabs}
                isLocal={false}
                onPullAll={() => pullAllFromDevice(group.tabs)}
                onJump={jumpToRecord}
                onOpenCopy={openRecordAsUnlinkedCopy}
              />
            ))}
          </div>
        )}

        {/* Recently closed */}
        {filtered.closed.length > 0 && (
          <DeviceSection
            label="Recently closed"
            icon={Archive}
            count={filtered.closed.length}
            tabs={filtered.closed}
            isLocal={false}
            collapsible
            defaultExpanded={filterMode === 'closed'}
            showDeviceOnCards
            onJump={jumpToRecord}
            onOpenCopy={openRecordAsUnlinkedCopy}
          />
        )}
      </div>
    </div>
  )
}

const MemoizedTabsView = memo(TabsView)
MemoizedTabsView.displayName = 'TabsView'

export default MemoizedTabsView
