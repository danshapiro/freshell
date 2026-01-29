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
import TabContent from '@/components/TabContent'
import HistoryView from '@/components/HistoryView'
import SettingsView from '@/components/SettingsView'
import OverviewView from '@/components/OverviewView'
import { Wifi, WifiOff, Moon, Sun, Share2 } from 'lucide-react'
import { updateSettingsLocal, markSaved } from '@/store/settingsSlice'

export default function App() {
  useThemeEffect()

  const dispatch = useAppDispatch()
  const tabs = useAppSelector((s) => s.tabs.tabs)
  const activeTabId = useAppSelector((s) => s.tabs.activeTabId)
  const connection = useAppSelector((s) => s.connection.status)
  const connectionError = useAppSelector((s) => s.connection.lastError)
  const settings = useAppSelector((s) => s.settings.settings)

  const [view, setView] = useState<AppView>('terminal')

  const toggleTheme = async () => {
    const newTheme = settings.theme === 'dark' ? 'light' : settings.theme === 'light' ? 'system' : 'dark'
    dispatch(updateSettingsLocal({ theme: newTheme }))
    try {
      await api.patch('/api/settings', { theme: newTheme })
      dispatch(markSaved())
    } catch {}
  }

  const handleShare = async () => {
    // Build shareable URL with token
    const url = new URL(window.location.href)
    const token = sessionStorage.getItem('authToken')
    if (token) {
      url.searchParams.set('token', token)
    }

    if (navigator.share) {
      try {
        await navigator.share({
          title: 'Freshell Terminal',
          text: 'Access my terminal session',
          url: url.toString(),
        })
      } catch (err) {
        // User cancelled or share failed - that's okay
        console.warn('Share cancelled or failed:', err)
      }
    } else {
      // Fallback: copy to clipboard
      try {
        await navigator.clipboard.writeText(url.toString())
        // TODO: Show toast notification
      } catch (err) {
        console.warn('Clipboard write failed:', err)
      }
    }
  }

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
    if (view === 'sessions') return <HistoryView onOpenSession={() => setView('terminal')} />
    if (view === 'settings') return <SettingsView />
    if (view === 'overview') return <OverviewView onOpenTab={() => setView('terminal')} />
    return (
      <div className="flex flex-col h-full">
        <TabBar />
        <div className="flex-1 min-h-0 relative">
          {tabs.map((t) => (
            <TabContent key={t.id} tabId={t.id} hidden={t.id !== activeTabId} />
          ))}
        </div>
      </div>
    )
  })()

  return (
    <div className="h-full flex flex-col bg-background text-foreground">
      {/* Top header bar spanning full width */}
      <div className="h-8 px-4 flex items-center justify-between border-b border-border/30 bg-background flex-shrink-0">
        <span className="font-mono text-base font-semibold tracking-tight">🐚freshell</span>
        <div className="flex items-center gap-1">
          <button
            onClick={toggleTheme}
            className="p-1.5 rounded-md hover:bg-muted transition-colors"
            title={`Theme: ${settings.theme}`}
          >
            {settings.theme === 'dark' ? (
              <Moon className="h-3.5 w-3.5 text-muted-foreground" />
            ) : (
              <Sun className="h-3.5 w-3.5 text-muted-foreground" />
            )}
          </button>
          <button
            onClick={handleShare}
            className="p-1.5 rounded-md hover:bg-muted transition-colors"
            title="Share LAN access"
          >
            <Share2 className="h-3.5 w-3.5 text-muted-foreground" />
          </button>
          <div
            className="p-1.5"
            title={connection === 'ready' ? 'Connected' : connection === 'connecting' ? 'Connecting...' : connectionError || 'Disconnected'}
          >
            {connection === 'ready' ? (
              <Wifi className="h-3.5 w-3.5 text-muted-foreground" />
            ) : connection === 'connecting' ? (
              <Wifi className="h-3.5 w-3.5 text-muted-foreground animate-pulse" />
            ) : (
              <WifiOff className="h-3.5 w-3.5 text-muted-foreground" />
            )}
          </div>
        </div>
      </div>
      {/* Main content area with sidebar */}
      <div className="flex-1 min-h-0 flex">
        <Sidebar view={view} onNavigate={setView} />
        <div className="flex-1 min-w-0 flex flex-col">
          {content}
        </div>
      </div>
    </div>
  )
}
