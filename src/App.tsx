import { useCallback, useEffect, useRef, useState } from 'react'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import { setStatus, setError, setPlatform } from '@/store/connectionSlice'
import { setSettings } from '@/store/settingsSlice'
import { setProjects } from '@/store/sessionsSlice'
import { addTab, removeTab } from '@/store/tabsSlice'
import { api } from '@/lib/api'
import { buildShareUrl } from '@/lib/utils'
import { getWsClient } from '@/lib/ws-client'
import { getSessionsForHello } from '@/lib/session-utils'
import { store } from '@/store/store'
import { useThemeEffect } from '@/hooks/useTheme'
import Sidebar, { AppView } from '@/components/Sidebar'
import TabBar from '@/components/TabBar'
import TabContent from '@/components/TabContent'
import HistoryView from '@/components/HistoryView'
import SettingsView from '@/components/SettingsView'
import OverviewView from '@/components/OverviewView'
import PaneDivider from '@/components/panes/PaneDivider'
import { Wifi, WifiOff, Moon, Sun, Share2, X, Copy, Check, PanelLeftClose, PanelLeft } from 'lucide-react'
import { updateSettingsLocal, markSaved } from '@/store/settingsSlice'

const SIDEBAR_MIN_WIDTH = 200
const SIDEBAR_MAX_WIDTH = 500
const MOBILE_BREAKPOINT = 768

export default function App() {
  useThemeEffect()

  const dispatch = useAppDispatch()
  const tabs = useAppSelector((s) => s.tabs.tabs)
  const activeTabId = useAppSelector((s) => s.tabs.activeTabId)
  const connection = useAppSelector((s) => s.connection.status)
  const connectionError = useAppSelector((s) => s.connection.lastError)
  const settings = useAppSelector((s) => s.settings.settings)

  const [view, setView] = useState<AppView>('terminal')
  const [shareModalUrl, setShareModalUrl] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [isMobile, setIsMobile] = useState(false)
  const mainContentRef = useRef<HTMLDivElement>(null)

  // Sidebar width from settings (or local state during drag)
  const sidebarWidth = settings.sidebar?.width ?? 288
  const sidebarCollapsed = settings.sidebar?.collapsed ?? false

  // Check for mobile viewport
  useEffect(() => {
    const checkMobile = () => {
      setIsMobile(window.innerWidth < MOBILE_BREAKPOINT)
    }
    checkMobile()
    window.addEventListener('resize', checkMobile)
    return () => window.removeEventListener('resize', checkMobile)
  }, [])

  // Auto-collapse sidebar on mobile
  useEffect(() => {
    if (isMobile && !sidebarCollapsed) {
      dispatch(updateSettingsLocal({ sidebar: { ...settings.sidebar, collapsed: true } }))
    }
  }, [isMobile])

  const handleSidebarResize = useCallback((delta: number) => {
    const newWidth = Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, sidebarWidth + delta))
    dispatch(updateSettingsLocal({ sidebar: { ...settings.sidebar, width: newWidth } }))
  }, [sidebarWidth, settings.sidebar, dispatch])

  const handleSidebarResizeEnd = useCallback(async () => {
    try {
      await api.patch('/api/settings', { sidebar: settings.sidebar })
      dispatch(markSaved())
    } catch {}
  }, [settings.sidebar, dispatch])

  const toggleSidebarCollapse = useCallback(async () => {
    const newCollapsed = !sidebarCollapsed
    dispatch(updateSettingsLocal({ sidebar: { ...settings.sidebar, collapsed: newCollapsed } }))
    try {
      await api.patch('/api/settings', { sidebar: { ...settings.sidebar, collapsed: newCollapsed } })
      dispatch(markSaved())
    } catch {}
  }, [sidebarCollapsed, settings.sidebar, dispatch])

  const toggleTheme = async () => {
    const newTheme = settings.theme === 'dark' ? 'light' : settings.theme === 'light' ? 'system' : 'dark'
    dispatch(updateSettingsLocal({ theme: newTheme }))
    try {
      await api.patch('/api/settings', { theme: newTheme })
      dispatch(markSaved())
    } catch {}
  }

  const handleShare = async () => {
    // Build shareable URL with LAN IP and token
    let lanIp: string | null = null
    try {
      const res = await api.get<{ ips: string[] }>('/api/lan-info')
      if (res.ips.length > 0) {
        lanIp = res.ips[0]
      }
    } catch {
      // Fall back to current host if LAN info unavailable
    }

    const token = sessionStorage.getItem('auth-token')
    const shareUrl = buildShareUrl({
      currentUrl: window.location.href,
      lanIp,
      token,
      isDev: import.meta.env.DEV,
    })

    // On Windows, show a modal instead of using system share
    const isWindows = navigator.platform.includes('Win')
    if (isWindows) {
      setCopied(false)
      setShareModalUrl(shareUrl)
      return
    }

    const shareText = `You need to use this on your local network or with a VPN.\n${shareUrl}`

    if (navigator.share) {
      try {
        await navigator.share({
          title: 'Welcome to your freshell!',
          text: shareText,
        })
      } catch (err) {
        // User cancelled or share failed - that's okay
        console.warn('Share cancelled or failed:', err)
      }
    } else {
      // Fallback: copy to clipboard
      try {
        await navigator.clipboard.writeText(shareText)
        // TODO: Show toast notification
      } catch (err) {
        console.warn('Clipboard write failed:', err)
      }
    }
  }

  const handleCopyShareLink = async () => {
    if (!shareModalUrl) return
    try {
      await navigator.clipboard.writeText(shareModalUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.warn('Clipboard write failed:', err)
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
        const platformInfo = await api.get<{ platform: string }>('/api/platform')
        if (!cancelled) dispatch(setPlatform(platformInfo.platform))
      } catch (err: any) {
        console.warn('Failed to load platform info', err)
      }

      try {
        const projects = await api.get('/api/sessions')
        if (!cancelled) dispatch(setProjects(projects))
      } catch (err: any) {
        console.warn('Failed to load sessions', err)
      }

      const ws = getWsClient()

      // Set up hello extension to include session IDs for prioritized repair
      ws.setHelloExtensionProvider(() => ({
        sessions: getSessionsForHello(store.getState()),
      }))

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
        if (msg.type === 'session.status') {
          // Log session repair status (silent for healthy/repaired, visible for problems)
          const { sessionId, status, orphansFixed } = msg
          if (status === 'missing') {
            console.warn(`Session ${sessionId.slice(0, 8)}... file is missing`)
          } else if (status === 'repaired') {
            console.log(`Session ${sessionId.slice(0, 8)}... repaired (${orphansFixed} orphans fixed)`)
          }
          // For 'healthy' status, no logging needed
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
      } else if (key === 'b') {
        e.preventDefault()
        toggleSidebarCollapse()
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
        <div className="flex items-center gap-2">
          <button
            onClick={toggleSidebarCollapse}
            className="p-1.5 rounded-md hover:bg-muted transition-colors"
            title={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}
          >
            {sidebarCollapsed ? (
              <PanelLeft className="h-3.5 w-3.5 text-muted-foreground" />
            ) : (
              <PanelLeftClose className="h-3.5 w-3.5 text-muted-foreground" />
            )}
          </button>
          <span className="font-mono text-base font-semibold tracking-tight">🐚🔥freshell</span>
        </div>
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
      <div className="flex-1 min-h-0 flex relative" ref={mainContentRef}>
        {/* Mobile overlay when sidebar is open */}
        {isMobile && !sidebarCollapsed && (
          <div
            className="absolute inset-0 bg-black/50 z-10"
            onClick={toggleSidebarCollapse}
          />
        )}
        {/* Sidebar - on mobile it overlays, on desktop it's inline */}
        {!sidebarCollapsed && (
          <div className={isMobile ? 'absolute left-0 top-0 bottom-0 z-20' : 'contents'}>
            <Sidebar view={view} onNavigate={(v) => {
              setView(v)
              // On mobile, collapse sidebar after navigation
              if (isMobile) toggleSidebarCollapse()
            }} width={sidebarWidth} />
            {!isMobile && (
              <PaneDivider
                direction="horizontal"
                onResize={handleSidebarResize}
                onResizeEnd={handleSidebarResizeEnd}
              />
            )}
          </div>
        )}
        <div className="flex-1 min-w-0 flex flex-col">
          {content}
        </div>
      </div>

      {/* Share modal for Windows */}
      {shareModalUrl && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
          onClick={() => setShareModalUrl(null)}
        >
          <div
            className="bg-background border border-border rounded-lg shadow-lg max-w-md w-full mx-4 p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold">Welcome to your freshell!</h2>
              <button
                onClick={() => setShareModalUrl(null)}
                className="p-1 rounded hover:bg-muted transition-colors"
              >
                <X className="h-4 w-4 text-muted-foreground" />
              </button>
            </div>
            <p className="text-sm text-muted-foreground mb-4">
              You need to use this on your local network or with a VPN.
            </p>
            <div className="bg-muted rounded-md p-3 mb-4">
              <code className="text-sm break-all select-all">{shareModalUrl}</code>
            </div>
            <button
              onClick={handleCopyShareLink}
              className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors"
            >
              {copied ? (
                <>
                  <Check className="h-4 w-4" />
                  Copied!
                </>
              ) : (
                <>
                  <Copy className="h-4 w-4" />
                  Copy link
                </>
              )}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
