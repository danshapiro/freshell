import { useMemo, useState } from 'react'
import type { ManagedRuntimeSoul, ManagedRuntimeViewIntent } from '@shared/managed-runtime'
import { useAppDispatch, useAppSelector, useAppStore } from '@/store/hooks'
import {
  getManagedRuntimeIncidentSummary,
  retryManagedRuntimeSoul,
  stopManagedRuntimeSoul,
  updateManagedRuntimeViewVisibility,
} from '@/lib/api'
import { queueManagedRuntimeRefresh } from '@/lib/recovery/managed-runtime-recovery'
import { closeTab } from '@/store/tabsSlice'
import { AgentResourceLimits } from '@/components/AgentResourceLimits'

export type ManagedAgentStatusLabel =
  | 'Reconnecting'
  | 'Restarting agent'
  | 'Recovery blocked'
  | 'Lost'
  | 'Ready'
  | 'Stopped'

export function managedAgentStatusLabel(
  connectionStatus: string,
  soul: ManagedRuntimeSoul,
): ManagedAgentStatusLabel {
  if (connectionStatus !== 'ready') return 'Reconnecting'
  if (soul.recoveryState === 'lost') return 'Lost'
  if (soul.desiredState === 'stopped' || soul.recoveryState === 'stopped') return 'Stopped'
  if (soul.recoveryState === 'blocked') return 'Recovery blocked'
  if (soul.recoveryState === 'recovering' || soul.launchState !== 'running') {
    return 'Restarting agent'
  }
  return 'Ready'
}

function latestSoulRows(souls: ManagedRuntimeSoul[]): ManagedRuntimeSoul[] {
  const latest = new Map<string, ManagedRuntimeSoul>()
  for (const soul of souls) latest.set(soul.soulId, soul)
  return [...latest.values()].sort((left, right) => left.soulId.localeCompare(right.soulId))
}

function providerLabel(provider?: string): string {
  switch (provider) {
    case 'claude': return 'Claude'
    case 'codex': return 'Codex'
    case 'opencode': return 'OpenCode'
    case 'amplifier': return 'Amplifier'
    case 'shell': return 'Shell'
    default: return provider || 'Managed agent'
  }
}

function viewsForSoul(
  views: ManagedRuntimeViewIntent[],
  soulId: string,
): ManagedRuntimeViewIntent[] {
  return views
    .filter((view) => view.soulId === soulId && view.visibility !== 'hidden')
    .sort((left, right) => left.viewId.localeCompare(right.viewId))
}

export function ManagedAgentRecoveryStatus() {
  const dispatch = useAppDispatch()
  const store = useAppStore()
  const connectionStatus = useAppSelector((state) => state.connection.status)
  const runtime = useAppSelector((state) => state.managedRuntime)
  const tabs = useAppSelector((state) => state.tabs.tabs)
  const [pending, setPending] = useState<string>()
  const [message, setMessage] = useState<string>()

  const souls = useMemo(() => latestSoulRows(runtime.souls), [runtime.souls])
  if (!runtime.available) return null

  const labels = souls.map((soul) => managedAgentStatusLabel(connectionStatus, soul))
  const attention = labels.some((label) => label !== 'Ready')
  const readyCount = labels.filter((label) => label === 'Ready').length

  const refresh = (reason: string) => queueManagedRuntimeRefresh(store, reason)

  const run = async (key: string, operation: () => Promise<unknown>) => {
    if (pending) return
    setPending(key)
    setMessage(undefined)
    try {
      await operation()
      await refresh(key)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setPending(undefined)
    }
  }

  const closeView = async (view: ManagedRuntimeViewIntent) => {
    await run(`close-view:${view.viewId}`, async () => {
      await updateManagedRuntimeViewVisibility(
        view.viewId,
        'detached',
        view.revision,
        view.soulIntentRevision,
      )
      const tab = tabs.find((candidate) => candidate.viewIntentId === view.viewId)
      if (tab) await dispatch(closeTab(tab.id)).unwrap()
    })
  }

  return (
    <aside
      aria-label="Managed agent recovery"
      className="fixed bottom-3 right-3 z-40 w-[min(28rem,calc(100vw-1.5rem))] rounded-lg border border-border bg-background/95 shadow-lg backdrop-blur"
    >
      <details open={attention || undefined}>
        <summary className="cursor-pointer px-3 py-2 text-sm font-medium">
          Managed agents · {readyCount}/{souls.length} ready
          {runtime.readiness?.initialScanState !== 'complete'
            ? ` · startup ${runtime.readiness?.initialScanState ?? 'pending'}`
            : ''}
        </summary>
        <div className="max-h-[70vh] space-y-3 overflow-y-auto border-t border-border p-3">
          {souls.length === 0 ? (
            <p className="text-sm text-muted-foreground" role="status">
              No managed agents are registered.
            </p>
          ) : souls.map((soul) => {
            const status = managedAgentStatusLabel(connectionStatus, soul)
            const views = viewsForSoul(runtime.viewIntents, soul.soulId)
            const actionBusy = pending?.includes(soul.soulId)
            return (
              <section
                key={soul.soulId}
                aria-label={`${providerLabel(soul.provider)} managed agent`}
                className="rounded-md border border-border p-3"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="truncate text-sm font-semibold">
                      {providerLabel(soul.provider)}
                    </h3>
                    <p className="text-xs text-muted-foreground">
                      <span className="font-medium text-foreground">{status}</span>
                      {soul.recoveryReason ? ` · ${soul.recoveryReason}` : ''}
                    </p>
                    <p className="truncate text-[11px] text-muted-foreground" title={soul.soulId}>
                      {soul.soulId}
                    </p>
                  </div>
                  <div className="flex flex-wrap justify-end gap-1">
                    {soul.recoveryState === 'blocked' && (
                      <button
                        className="rounded border border-border px-2 py-1 text-xs hover:bg-muted disabled:opacity-50"
                        disabled={Boolean(pending)}
                        onClick={() => void run(`retry:${soul.soulId}`, () => (
                          retryManagedRuntimeSoul(soul.soulId, soul.intentRevision)
                        ))}
                        type="button"
                      >
                        Retry recovery
                      </button>
                    )}
                    {soul.desiredState === 'running' && (
                      <button
                        className="rounded border border-border px-2 py-1 text-xs hover:bg-muted disabled:opacity-50"
                        disabled={Boolean(pending) || actionBusy}
                        onClick={() => {
                          if (!window.confirm('Stop this managed agent? Its views remain as stopped history.')) return
                          void run(`stop:${soul.soulId}`, () => (
                            stopManagedRuntimeSoul(soul.soulId, soul.intentRevision)
                          ))
                        }}
                        type="button"
                      >
                        Stop agent
                      </button>
                    )}
                  </div>
                </div>

                {views.length > 0 && (
                  <ul className="mt-2 space-y-1" aria-label="Agent views">
                    {views.map((view) => (
                      <li className="flex items-center justify-between gap-2 text-xs" key={view.viewId}>
                        <span className="truncate" title={view.title}>{view.title}</span>
                        <button
                          className="rounded border border-border px-2 py-1 hover:bg-muted disabled:opacity-50"
                          disabled={Boolean(pending)}
                          onClick={() => void closeView(view)}
                          type="button"
                        >
                          Close view
                        </button>
                      </li>
                    ))}
                  </ul>
                )}

                {soul.recoveryState === 'lost' && soul.incidentId && (
                  <button
                    className="mt-2 text-xs underline underline-offset-2"
                    onClick={() => void run(`incident:${soul.soulId}`, async () => {
                      const summary = await getManagedRuntimeIncidentSummary(soul.incidentId!)
                      setMessage(
                        `${summary.observedCause} Cleanup: ${summary.cleanup.verifiedEmpty
                          ? 'verified empty'
                          : summary.state.replaceAll('_', ' ')}. Reference: ${summary.incidentId}.`,
                      )
                    })}
                    type="button"
                  >
                    View incident details
                  </button>
                )}

                <AgentResourceLimits
                  soul={soul}
                  onSaved={() => refresh(`limits:${soul.soulId}`)}
                />
              </section>
            )
          })}
          {message && (
            <p className="text-sm text-destructive" role="alert" aria-live="assertive">
              {message}
            </p>
          )}
        </div>
      </details>
    </aside>
  )
}
