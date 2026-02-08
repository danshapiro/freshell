import { useCallback, useEffect, useRef, useState } from 'react'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import { setStatus, setError, setPlatform, setAvailableClis } from '@/store/connectionSlice'
import { setSettings } from '@/store/settingsSlice'
import {
  setProjects,
  clearProjects,
  mergeProjects,
  applySessionsPatch,
  markWsSnapshotReceived,
  resetWsSnapshotReceived,
} from '@/store/sessionsSlice'
import { addTab, switchToNextTab, switchToPrevTab } from '@/store/tabsSlice'
import { api } from '@/lib/api'
import { getAuthToken } from '@/lib/auth'
import { buildShareUrl } from '@/lib/utils'
import { getWsClient } from '@/lib/ws-client'
import { getSessionsForHello } from '@/lib/session-utils'
import { setClientPerfEnabled } from '@/lib/perf-logger'
import { applyLocalTerminalFontFamily } from '@/lib/terminal-fonts'
import { store } from '@/store/store'
import { useThemeEffect } from '@/hooks/useTheme'
import { installCrossTabSync } from '@/store/crossTabSync'
import Sidebar, { AppView } from '@/components/Sidebar'
import TabBar from '@/components/TabBar'
import TabContent from '@/components/TabContent'
import HistoryView from '@/components/HistoryView'
import SettingsView from '@/components/SettingsView'
import OverviewView from '@/components/OverviewView'
import PaneDivider from '@/components/panes/PaneDivider'
import { AuthRequiredModal } from '@/components/AuthRequiredModal'
import { ContextMenuProvider } from '@/components/context-menu/ContextMenuProvider'
import { ContextIds } from '@/components/context-menu/context-menu-constants'
import { Wifi, WifiOff, Moon, Sun, Share2, X, Copy, Check, PanelLeftClose, PanelLeft } from 'lucide-react'
import { updateSettingsLocal, markSaved } from '@/store/settingsSlice'
import { clearIdleWarning, recordIdleWarning } from '@/store/idleWarningsSlice'

const SIDEBAR_MIN_WIDTH = 200
const SIDEBAR_MAX_WIDTH = 500
const MOBILE_BREAKPOINT = 768
const EMPTY_IDLE_WARNINGS: Record<string, unknown> = {}

export default function App() {
  useThemeEffect()

  const dispatch = useAppDispatch()
  const tabs = useAppSelector((s) => s.tabs.tabs)
  const activeTabId = useAppSelector((s) => s.tabs.activeTabId)
  const connection = useAppSelector((s) => s.connection.status)
  const connectionError = useAppSelector((s) => s.connection.lastError)
  const settings = useAppSelector((s) => s.settings.settings)
  const idleWarnings = useAppSelector((s) => (s as any).idleWarnings?.warnings ?? EMPTY_IDLE_WARNINGS)
  const idleWarningCount = Object.keys(idleWarnings).length

  const [view, setView] = useState<AppView>('terminal')
  const [shareModalUrl, setShareModalUrl] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [isMobile, setIsMobile] = useState(false)
  const mainContentRef = useRef<HTMLDivElement>(null)
  const userOpenedSidebarOnMobileRef = useRef(false)

  // Keep this tab's Redux state in sync with persisted writes from other browser tabs.
  useEffect(() => {
    return installCrossTabSync(store)
  }, [])

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
    if (!isMobile) {
      userOpenedSidebarOnMobileRef.current = false
      return
    }
    if (!sidebarCollapsed && !userOpenedSidebarOnMobileRef.current) {
      dispatch(updateSettingsLocal({ sidebar: { ...settings.sidebar, collapsed: true } }))
    }
  }, [isMobile, sidebarCollapsed, settings.sidebar, dispatch])

  const handleSidebarResize = useCallback((delta: number) => {
    const newWidth = Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, sidebarWidth + delta))
    dispatch(updateSettingsLocal({ sidebar: { ...settings.sidebar, width: newWidth } }))
  }, [sidebarWidth, settings.sidebar, dispatch])

  const handleSidebarResizeEnd = useCallback(async () => {
    try {
      await api.patch('/api/settings', { sidebar: settings.sidebar })
      dispatch(markSaved())
    } catch (err) {
      console.warn('Failed to save sidebar settings', err)
    }
  }, [settings.sidebar, dispatch])

  const toggleSidebarCollapse = useCallback(async () => {
    const newCollapsed = !sidebarCollapsed
    if (isMobile && !newCollapsed) {
      userOpenedSidebarOnMobileRef.current = true
    }
    dispatch(updateSettingsLocal({ sidebar: { ...settings.sidebar, collapsed: newCollapsed } }))
    try {
      await api.patch('/api/settings', { sidebar: { ...settings.sidebar, collapsed: newCollapsed } })
      dispatch(markSaved())
    } catch (err) {
      console.warn('Failed to save sidebar settings', err)
    }
  }, [isMobile, sidebarCollapsed, settings.sidebar, dispatch])

  const toggleTheme = async () => {
    const newTheme = settings.theme === 'dark' ? 'light' : settings.theme === 'light' ? 'system' : 'dark'
    dispatch(updateSettingsLocal({ theme: newTheme }))
    try {
      await api.patch('/api/settings', { theme: newTheme })
      dispatch(markSaved())
    } catch (err) {
      console.warn('Failed to save theme setting', err)
    }
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

    const token = getAuthToken() ?? null
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
    let cleanedUp = false
    let cleanup: (() => void) | null = null
    async function bootstrap() {
      try {
        const settings = await api.get('/api/settings')
        if (!cancelled) dispatch(setSettings(applyLocalTerminalFontFamily(settings)))
      } catch (err: any) {
        console.warn('Failed to load settings', err)
      }

      try {
        const platformInfo = await api.get<{ platform: string; availableClis?: Record<string, boolean> }>('/api/platform')
        if (!cancelled) {
          dispatch(setPlatform(platformInfo.platform))
          if (platformInfo.availableClis) {
            dispatch(setAvailableClis(platformInfo.availableClis))
          }
        }
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

      const unsubscribe = ws.onMessage((msg) => {
        if (!msg?.type) return
        if (msg.type === 'ready') {
          // If the initial connect attempt failed before ready, WsClient may still auto-reconnect.
          // Treat 'ready' as the source of truth for connection status.
          dispatch(setError(undefined))
          dispatch(setStatus('ready'))
          dispatch(resetWsSnapshotReceived())
        }
        if (msg.type === 'sessions.updated') {
          // Support chunked sessions for mobile browsers with limited WebSocket buffers
          if (msg.clear) {
            // First chunk: clear existing, then merge
            dispatch(clearProjects())
            dispatch(mergeProjects(msg.projects || []))
          } else if (msg.append) {
            // Subsequent chunks: merge with existing
            dispatch(mergeProjects(msg.projects || []))
          } else {
            // Full update (broadcasts, legacy): replace all
            dispatch(setProjects(msg.projects || []))
          }
          dispatch(markWsSnapshotReceived())
        }
        if (msg.type === 'sessions.patch') {
          dispatch(applySessionsPatch({
            upsertProjects: msg.upsertProjects || [],
            removeProjectPaths: msg.removeProjectPaths || [],
          }))
        }
        if (msg.type === 'settings.updated') {
          dispatch(setSettings(applyLocalTerminalFontFamily(msg.settings)))
        }
        if (msg.type === 'terminal.exit') {
          const terminalId = msg.terminalId
          const code = msg.exitCode
          if (import.meta.env.MODE === 'development') console.log('terminal exit', terminalId, code)
          if (terminalId) dispatch(clearIdleWarning(terminalId))
        }
        if (msg.type === 'terminal.idle.warning') {
          if (!msg.terminalId) return
          dispatch(recordIdleWarning({
            terminalId: msg.terminalId,
            killMinutes: Number(msg.killMinutes) || 0,
            warnMinutes: Number(msg.warnMinutes) || 0,
            lastActivityAt: typeof msg.lastActivityAt === 'number' ? msg.lastActivityAt : undefined,
          }))
        }
        if (msg.type === 'session.status') {
          // Log session repair status (silent for healthy/repaired, visible for problems)
          const { sessionId, status, orphansFixed } = msg
          if (status === 'missing') {
            if (import.meta.env.MODE === 'development') console.warn(`Session ${sessionId.slice(0, 8)}... file is missing`)
          } else if (status === 'repaired') {
            if (import.meta.env.MODE === 'development') console.log(`Session ${sessionId.slice(0, 8)}... repaired (${orphansFixed} orphans fixed)`)
          }
          // For 'healthy' status, no logging needed
        }
        if (msg.type === 'perf.logging') {
          setClientPerfEnabled(!!msg.enabled, 'server')
        }
      })

      cleanup = () => {
        unsubscribe()
      }
      if (cleanedUp) cleanup()

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
      }
    }

    const cleanupPromise = bootstrap()

    return () => {
      cancelled = true
      cleanedUp = true
      cleanup?.()
      void cleanupPromise
    }
  }, [dispatch])

  // Keyboard shortcuts
  useEffect(() => {
    function isTextInput(el: any): boolean {
      if (!el) return false
      const tag = (el.tagName || '').toLowerCase()
      if (tag === 'input' || tag === 'textarea' || el.isContentEditable) return true
      if (el.classList?.contains('xterm-helper-textarea')) return true
      return false
    }

    function onKeyDown(e: KeyboardEvent) {
      if (isTextInput(e.target)) return

      // Tab switching: Ctrl+Shift+[ (prev) and Ctrl+Shift+] (next)
      // Also handled in TerminalView.tsx for when terminal is focused
      if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey) {
        if (e.code === 'BracketLeft') {
          e.preventDefault()
          dispatch(switchToPrevTab())
          return
        }
        if (e.code === 'BracketRight') {
          e.preventDefault()
          dispatch(switchToNextTab())
          return
        }
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [dispatch])

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
        <div className="flex-1 min-h-0 relative bg-background">
          {tabs.map((t) => (
            <TabContent key={t.id} tabId={t.id} hidden={t.id !== activeTabId} />
          ))}
        </div>
      </div>
    )
  })()

  return (
    <ContextMenuProvider
      view={view}
      onViewChange={setView}
      onToggleSidebar={toggleSidebarCollapse}
      sidebarCollapsed={sidebarCollapsed}
    >
      <div
        className="h-full flex flex-col bg-background text-foreground"
        data-context={ContextIds.Global}
      >
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
          {idleWarningCount > 0 && (
            <button
              onClick={() => setView('overview')}
              className="px-2 py-1 rounded-md bg-amber-100 text-amber-950 hover:bg-amber-200 transition-colors text-xs font-medium"
              aria-label={`${idleWarningCount} terminal(s) will auto-kill soon`}
              title="View idle terminals"
            >
              {idleWarningCount} terminal{idleWarningCount === 1 ? '' : 's'} will auto-kill soon
            </button>
          )}
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
            role="presentation"
            onClick={toggleSidebarCollapse}
            onKeyDown={(e) => {
              if (e.key === 'Escape') toggleSidebarCollapse()
            }}
            tabIndex={-1}
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
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-[60]"
          role="presentation"
          onClick={() => setShareModalUrl(null)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setShareModalUrl(null)
          }}
          tabIndex={-1}
        >
          {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions */}
          <div
            className="bg-background border border-border rounded-lg shadow-lg max-w-md w-full mx-4 p-6"
            role="dialog"
            aria-modal="true"
            aria-label="Share freshell invitation"
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
      <AuthRequiredModal />
      </div>
    </ContextMenuProvider>
  )
}
