import { useCallback, useEffect, useRef } from 'react'
import { nanoid } from 'nanoid'
import { resolveTerminalKillFence, sendTerminalKill } from '@/lib/terminal-kill'
import { foldRefusalFencePair, hasRefusalFencePair } from '@/lib/owner-fence-heal'
import { getWsClient } from '@/lib/ws-client'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { useAppDispatch, useAppSelector, useAppStore } from '@/store/hooks'
import { addTab } from '@/store/tabsSlice'
import { initLayout } from '@/store/panesSlice'
import { fetchTerminalDirectoryWindow } from '@/store/terminalDirectoryThunks'
import type { BackgroundTerminal } from '@/store/types'
import { isRetainedManagedTerminal, managedTerminalPaneStatus, managedTerminalProjection } from '@/lib/managed-terminal.js'
import ManagedTerminalRecoveryDetails from './ManagedTerminalRecoveryDetails.js'

const EMPTY_TERMINALS: BackgroundTerminal[] = []

function formatAge(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return `${h}h`
}

export default function BackgroundSessions() {
  const dispatch = useAppDispatch()
  const appStore = useAppStore()
  const terminals = useAppSelector((state) => (
    (state as any).terminalDirectory?.windows?.background?.items ?? EMPTY_TERMINALS
  )) as BackgroundTerminal[]

  const refresh = useCallback(() => {
    void dispatch(fetchTerminalDirectoryWindow({
      surface: 'background',
      priority: 'visible',
    }) as any).catch(() => {})
  }, [dispatch])

  useEffect(() => {
    let interval: number | null = null

    refresh()
    interval = window.setInterval(refresh, 5000)

    return () => {
      if (interval) window.clearInterval(interval)
    }
  }, [refresh])

  const detachedRunning = terminals.filter((t) => (t.status === 'running' || isRetainedManagedTerminal(t)) && !t.hasClients)

  // b8ke fence-heal (fix b): detached terminals have NO mounted
  // TerminalView to consume their typed kill refusal — fold it HERE so
  // the next Kill click (whose send-time fence read re-selects from the
  // store) carries the fresh pair. The pane-like target mirrors the
  // component's own kill fence shape below; a refusal matching no row is
  // a no-op.
  const detachedRunningRef = useRef<BackgroundTerminal[]>([])
  detachedRunningRef.current = detachedRunning

  useEffect(() => {
    const unsubscribe = getWsClient().onMessage((raw) => {
      const msg = raw as {
        type?: string
        requestId?: string
        terminalId?: string
        ownerEpoch?: number
        ownerGeneration?: number
      }
      if (msg.type !== 'error' || msg.requestId || !msg.terminalId) return
      const row = detachedRunningRef.current.find((r) => r.terminalId === msg.terminalId)
      if (!row?.sessionRef) return
      if (!hasRefusalFencePair(msg)) return
      foldRefusalFencePair(
        dispatch,
        appStore.getState(),
        { sessionRef: row.sessionRef, provider: row.sessionRef.provider },
        msg,
      )
    })
    return unsubscribe
  }, [dispatch, appStore])

  const now = Date.now()

  return (
    <div className="px-3 py-2">
      <div className="flex items-center gap-2">
        <div className="text-sm font-medium">Background sessions</div>
        <Badge variant="outline">{detachedRunning.length}</Badge>
        <div className="ml-auto">
          <Button size="sm" variant="outline" onClick={refresh}>
            Refresh
          </Button>
        </div>
      </div>

      {detachedRunning.length === 0 ? (
        <div className="pt-2 text-xs text-muted-foreground">
          No detached terminals. Close a tab to detach it, or kill it with Shift+Close.
        </div>
      ) : (
        <div className="pt-2 flex flex-col gap-2">
          {detachedRunning
            .slice()
            .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
            .map((t) => {
              const idleMs = now - (t.lastActivityAt || t.createdAt)

              return (
                <div
                  key={t.terminalId}
                  className="flex items-center gap-2 rounded-md border border-border/60 bg-background px-2 py-2"
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">{t.title}</div>
                    <ManagedTerminalRecoveryDetails terminal={t} />
                    <div className="text-xs text-muted-foreground truncate">
                      {t.cwd ? t.cwd + ' • ' : ''}idle {formatAge(idleMs)}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      const tabId = nanoid()
                      const mode = ((t.mode as any) || 'shell') as string
                      const initialCwd = typeof t.cwd === 'string' && t.cwd.trim() ? t.cwd : undefined
                      const status = managedTerminalPaneStatus(t, t.status === 'exited' ? 'exited' : 'running')
                      dispatch(addTab({
                        id: tabId,
                        title: t.title,
                        status,
                        ...managedTerminalProjection(t),
                        mode: mode as any,
                        sessionRef: t.sessionRef,
                        ...(initialCwd ? { initialCwd } : {}),
                      }))
                      dispatch(initLayout({
                        tabId,
                        content: {
                          kind: 'terminal',
                          mode: mode as any,
                          terminalId: t.terminalId,
                          status,
                          ...managedTerminalProjection(t),
                          sessionRef: t.sessionRef,
                          ...(initialCwd ? { initialCwd } : {}),
                        },
                      }))
                    }}
                  >
                    Attach
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => sendTerminalKill(
                      t.terminalId,
                      // b8ke ext r20 F2: the kill carries the session's
                      // observed (epoch, generation) pair — a reconnect-
                      // queued stale kill is typed-refused instead of
                      // killing a newer owner.
                      resolveTerminalKillFence(appStore, {
                        provider: t.sessionRef?.provider,
                        sessionRef: t.sessionRef,
                      }),
                    )}
                  >
                    Kill
                  </Button>
                </div>
              )
            })}
        </div>
      )}
    </div>
  )
}
