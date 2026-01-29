import { useEffect, useRef, useState } from 'react'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import { setStatus, setError } from '@/store/connectionSlice'
import { setSettings } from '@/store/settingsSlice'
import { setProjects } from '@/store/sessionsSlice'
import { addTab, removeTab } from '@/store/tabsSlice'
import { api } from '@/lib/api'
import { getWsClient } from '@/lib/ws-client'
import { useThemeEffect } from '@/hooks/useTheme'
import Sidebar, { AppView } from '@/components/Sidebar'
import TabBar from '@/components/TabBar'
import TerminalView from '@/components/TerminalView'
import HistoryView from '@/components/HistoryView'
import SettingsView from '@/components/SettingsView'
import OverviewView from '@/components/OverviewView'
import { Wifi, WifiOff } from 'lucide-react'

export default function App() {
  useThemeEffect()

  const dispatch = useAppDispatch()
  const tabs = useAppSelector((s) => s.tabs.tabs)
  const activeTabId = useAppSelector((s) => s.tabs.activeTabId)
  const connection = useAppSelector((s) => s.connection.status)
  const connectionError = useAppSelector((s) => s.connection.lastError)

  const [view, setView] = useState<AppView>('terminal')

  // Bootstrap: load settings, sessions, and connect websocket.
  useEffect(() => {
    let cancelled = false
    async function bootstrap() {
      try {
        const settings = await api.get('/api/settings')
        if (!cancelled) dispatch(setSettings(settings))
      } catch (err: any) {
        console.warn('Failed to load settings', err)
      }

      try {
        const projects = await api.get('/api/sessions')
        if (!cancelled) dispatch(setProjects(projects))
      } catch (err: any) {
        console.warn('Failed to load sessions', err)
      }

      const ws = getWsClient()
      dispatch(setError(undefined))
      dispatch(setStatus('connecting'))
      try {
        await ws.connect()
        if (!cancelled) dispatch(setStatus('ready'))
      } catch (err: any) {
        if (!cancelled) {
          dispatch(setStatus('disconnected'))
          dispatch(setError(err?.message || 'WebSocket connection failed'))
        }
        return
      }

      const unsubscribe = ws.onMessage((msg) => {
        if (!msg?.type) return
        if (msg.type === 'sessions.updated') {
          dispatch(setProjects(msg.projects || []))
        }
        if (msg.type === 'settings.updated') {
          dispatch(setSettings(msg.settings))
        }
        if (msg.type === 'terminal.exit') {
          const terminalId = msg.terminalId
          const code = msg.exitCode
          console.log('terminal exit', terminalId, code)
        }
      })

      const unsubReconnect = ws.onReconnect(async () => {
        try {
          const projects = await api.get('/api/sessions')
          dispatch(setProjects(projects))
        } catch {}
        try {
          const settings = await api.get('/api/settings')
          dispatch(setSettings(settings))
        } catch {}
      })

      return () => {
        unsubscribe()
        unsubReconnect()
      }
    }

    const cleanupPromise = bootstrap()

    return () => {
      cancelled = true
      void cleanupPromise
    }
  }, [dispatch])

  // Keyboard shortcuts: Ctrl+B prefix, then a command.
  const prefixActiveRef = useRef(false)
  const prefixTimeoutRef = useRef<number | null>(null)

  useEffect(() => {
    function clearPrefix() {
      prefixActiveRef.current = false
      if (prefixTimeoutRef.current) window.clearTimeout(prefixTimeoutRef.current)
      prefixTimeoutRef.current = null
    }

    function isTextInput(el: any): boolean {
      if (!el) return false
      const tag = (el.tagName || '').toLowerCase()
      if (tag === 'input' || tag === 'textarea' || el.isContentEditable) return true
      if (el.classList?.contains('xterm-helper-textarea')) return true
      return false
    }

    function onKeyDown(e: KeyboardEvent) {
      if (isTextInput(e.target)) return

      if (e.ctrlKey && !e.shiftKey && !e.altKey && (e.key === 'b' || e.key === 'B')) {
        e.preventDefault()
        prefixActiveRef.current = true
        if (prefixTimeoutRef.current) window.clearTimeout(prefixTimeoutRef.current)
        prefixTimeoutRef.current = window.setTimeout(clearPrefix, 1500)
        return
      }

      if (!prefixActiveRef.current) return

      const key = e.key.toLowerCase()
      clearPrefix()

      if (key === 't') {
        e.preventDefault()
        dispatch(addTab({ mode: 'shell' }))
        setView('terminal')
      } else if (key === 'w') {
        e.preventDefault()
        if (activeTabId) dispatch(removeTab(activeTabId))
      } else if (key === 's') {
        e.preventDefault()
        setView('sessions')
      } else if (key === 'o') {
        e.preventDefault()
        setView('overview')
      } else if (key === ',') {
        e.preventDefault()
        setView('settings')
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      if (prefixTimeoutRef.current) window.clearTimeout(prefixTimeoutRef.current)
    }
  }, [dispatch, activeTabId])

  // Ensure at least one tab exists for first-time users.
  useEffect(() => {
    if (tabs.length === 0) {
      dispatch(addTab({ mode: 'shell' }))
    }
  }, [tabs.length, dispatch])

  const content = (() => {
    if (view === 'sessions') return <HistoryView />
    if (view === 'settings') return <SettingsView />
    if (view === 'overview') return <OverviewView onOpenTab={() => setView('terminal')} />
    return (
      <div className="flex flex-col h-full">
        <TabBar />
        <div className="flex-1 min-h-0 relative">
          {tabs.map((t) => (
            <TerminalView key={t.id} tabId={t.id} hidden={t.id !== activeTabId} />
          ))}
        </div>
      </div>
    )
  })()

  return (
    <div className="h-full flex bg-background text-foreground">
      <Sidebar view={view} onNavigate={setView} />
      <div className="flex-1 min-w-0 flex flex-col">
        {/* Minimal status bar */}
        <div className="h-8 px-4 flex items-center justify-end border-b border-border/30 bg-background">
          <div className="flex items-center gap-2">
            {connection === 'ready' ? (
              <Wifi className="h-3.5 w-3.5 text-success" />
            ) : connection === 'connecting' ? (
              <Wifi className="h-3.5 w-3.5 text-warning animate-pulse" />
            ) : (
              <WifiOff className="h-3.5 w-3.5 text-destructive" />
            )}
            {connectionError && (
              <span className="text-2xs text-destructive">{connectionError}</span>
            )}
          </div>
        </div>
        <div className="flex-1 min-h-0">{content}</div>
      </div>
    </div>
  )
}
