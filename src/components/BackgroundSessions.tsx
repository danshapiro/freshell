import { useCallback, useEffect, useMemo } from 'react'
import { getWsClient } from '@/lib/ws-client'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import { addTab } from '@/store/tabsSlice'
import { fetchTerminalDirectoryWindow } from '@/store/terminalDirectoryThunks'

type BackgroundTerminal = {
  terminalId: string
  title: string
  createdAt: number
  lastActivityAt: number
  cwd?: string
  status: 'running' | 'exited'
  hasClients: boolean
  mode?: string
  resumeSessionId?: string
}

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
  const ws = useMemo(() => getWsClient(), [])
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

  const detachedRunning = terminals.filter((t) => t.status === 'running' && !t.hasClients)

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
          No detached running terminals. Close a tab to detach it, or kill it with Shift+Close.
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
                    <div className="text-xs text-muted-foreground truncate">
                      {t.cwd ? t.cwd + ' • ' : ''}idle {formatAge(idleMs)}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      dispatch(addTab({
                        title: t.title,
                        titleSource: 'stable',
                        terminalId: t.terminalId,
                        status: 'running',
                        mode: (t.mode as any) || 'shell',
                        resumeSessionId: t.resumeSessionId,
                      }))
                    }}
                  >
                    Attach
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => ws.send({ type: 'terminal.kill', terminalId: t.terminalId })}
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
