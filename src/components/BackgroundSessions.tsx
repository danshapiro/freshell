import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getWsClient } from '@/lib/ws-client'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import { addTab } from '@/store/tabsSlice'

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
  const settings = useAppSelector((s) => s.settings.settings)

  const ws = useMemo(() => getWsClient(), [])
  const [terminals, setTerminals] = useState<BackgroundTerminal[]>([])
  const requestIdRef = useRef<string | null>(null)

  const refresh = useCallback(() => {
    const requestId = `list-${Date.now()}`
    requestIdRef.current = requestId
    ws.send({ type: 'terminal.list', requestId })
  }, [ws])

  useEffect(() => {
    let unsub = () => {}
    let interval: number | null = null

    ws.connect().catch(() => {})
    refresh()
    interval = window.setInterval(refresh, 5000)

    unsub = ws.onMessage((msg) => {
      if (msg.type === 'terminal.list.response' && msg.requestId === requestIdRef.current) {
        setTerminals(msg.terminals || [])
      }
      if (msg.type === 'terminal.detached') {
        refresh()
      }
      if (msg.type === 'terminal.attach.ready') {
        refresh()
      }
      if (msg.type === 'terminal.exit') {
        refresh()
      }
      if (msg.type === 'terminal.list.updated') {
        refresh()
      }
    })

    return () => {
      unsub()
      if (interval) window.clearInterval(interval)
    }
  }, [ws, refresh])

  const detachedRunning = terminals.filter((t) => t.status === 'running' && !t.hasClients)

  const killMinutesRaw = Number(settings.safety.autoKillIdleMinutes) || 0
  const warnMinutesRaw = Number(settings.safety.warnBeforeKillMinutes) || 0
  const killMinutes = killMinutesRaw > 0 ? killMinutesRaw : 0
  const warnMinutes = warnMinutesRaw > 0 && warnMinutesRaw < killMinutes ? warnMinutesRaw : 0
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
              const idleMinutes = idleMs / 60000
              const warnAtMinutes = warnMinutes > 0 ? killMinutes - warnMinutes : Number.POSITIVE_INFINITY
              const warn = warnMinutes > 0 && idleMinutes >= warnAtMinutes && idleMinutes < killMinutes
              const over = killMinutes > 0 && idleMinutes >= killMinutes

              return (
                <div
                  key={t.terminalId}
                  className="flex items-center gap-2 rounded-md border border-border/60 bg-background px-2 py-2"
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">{t.title}</div>
                    <div className="text-xs text-muted-foreground truncate">
                      {t.cwd ? t.cwd + ' • ' : ''}idle {formatAge(idleMs)}
                      {warn ? ' • will auto-kill soon' : ''}
                      {over ? ' • overdue' : ''}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      dispatch(addTab({ title: t.title, terminalId: t.terminalId, status: 'running', mode: (t.mode as any) || 'shell', resumeSessionId: t.resumeSessionId }))
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
