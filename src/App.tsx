import { lazy, Suspense, useCallback, useEffect, useRef, useState, type TouchEvent as ReactTouchEvent } from 'react'
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
import { api, type VersionInfo } from '@/lib/api'
import { getShareAction } from '@/lib/share-utils'
import { getWsClient } from '@/lib/ws-client'
import { getSessionsForHello } from '@/lib/session-utils'
import { setClientPerfEnabled } from '@/lib/perf-logger'
import { applyLocalTerminalFontFamily } from '@/lib/terminal-fonts'
import { store } from '@/store/store'
import { useThemeEffect } from '@/hooks/useTheme'
import { useMobile } from '@/hooks/useMobile'
import { useOrientation } from '@/hooks/useOrientation'
import { useFullscreen } from '@/hooks/useFullscreen'
import { useTurnCompletionNotifications } from '@/hooks/useTurnCompletionNotifications'
import { useDrag } from '@use-gesture/react'
import { installCrossTabSync } from '@/store/crossTabSync'
import { startTabRegistrySync } from '@/store/tabRegistrySync'
import Sidebar, { AppView } from '@/components/Sidebar'
import TabBar from '@/components/TabBar'
import TabContent from '@/components/TabContent'
import OverviewView from '@/components/OverviewView'
import TabsView from '@/components/TabsView'
import PaneDivider from '@/components/panes/PaneDivider'
import { AuthRequiredModal } from '@/components/AuthRequiredModal'
import { SetupWizard } from '@/components/SetupWizard'
import { ErrorBoundary } from '@/components/ui/error-boundary'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { fetchNetworkStatus } from '@/store/networkSlice'
import { ContextMenuProvider } from '@/components/context-menu/ContextMenuProvider'
import { ContextIds } from '@/components/context-menu/context-menu-constants'
import { triggerHapticFeedback } from '@/lib/mobile-haptics'
import { Wifi, WifiOff, Moon, Sun, Share2, X, Copy, Check, PanelLeftClose, PanelLeft, Loader2, Minimize2, Maximize2, AlertCircle, AlertTriangle } from 'lucide-react'
import { updateSettingsLocal, markSaved } from '@/store/settingsSlice'
import { clearIdleWarning, recordIdleWarning } from '@/store/idleWarningsSlice'
import { setTerminalMetaSnapshot, upsertTerminalMeta, removeTerminalMeta } from '@/store/terminalMetaSlice'
import { handleSdkMessage } from '@/lib/sdk-message-handler'

// Lazy QR code component to avoid loading lean-qr until the share panel opens
function ShareQrCode({ url }: { url: string }) {
  const [svgUrl, setSvgUrl] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const { generate } = await import('lean-qr')
        const { toSvgDataURL } = await import('lean-qr/extras/svg')
        if (cancelled) return
        const code = generate(url)
        setSvgUrl(toSvgDataURL(code))
      } catch {
        // QR generation failed — panel still shows URL text
      }
    })()
    return () => { cancelled = true }
  }, [url])
  if (!svgUrl) return null
  return <img src={svgUrl} alt="QR code for access URL" className="w-48 h-48" />
}

const HistoryView = lazy(() => import('@/components/HistoryView'))
const SettingsView = lazy(() => import('@/components/SettingsView'))

const SIDEBAR_MIN_WIDTH = 200
const SIDEBAR_MAX_WIDTH = 500
const EMPTY_IDLE_WARNINGS: Record<string, unknown> = {}

function isVersionInfo(value: unknown): value is VersionInfo {
  return !!value && typeof value === 'object' && typeof (value as { currentVersion?: unknown }).currentVersion === 'string'
}

type ConfigFallbackInfo = {
  reason: 'PARSE_ERROR' | 'VERSION_MISMATCH' | 'READ_ERROR' | 'ENOENT'
  backupExists: boolean
}

function describeConfigFallbackReason(reason: ConfigFallbackInfo['reason']): string {
  if (reason === 'PARSE_ERROR') return 'could not parse config JSON'
  if (reason === 'VERSION_MISMATCH') return 'config version is incompatible'
  if (reason === 'READ_ERROR') return 'config file could not be read'
  return 'config file was missing'
}

function parseConfigFallbackReason(value: unknown): ConfigFallbackInfo['reason'] {
  return value === 'PARSE_ERROR' || value === 'VERSION_MISMATCH' || value === 'READ_ERROR' || value === 'ENOENT'
    ? value
    : 'READ_ERROR'
}

export default function App() {
  useThemeEffect()
  useTurnCompletionNotifications()

  const dispatch = useAppDispatch()
  const tabs = useAppSelector((s) => s.tabs.tabs)
  const activeTabId = useAppSelector((s) => s.tabs.activeTabId)
  const connection = useAppSelector((s) => s.connection.status)
  const connectionError = useAppSelector((s) => s.connection.lastError)
  const settings = useAppSelector((s) => s.settings.settings)
  const idleWarnings = useAppSelector((s) => (s as any).idleWarnings?.warnings ?? EMPTY_IDLE_WARNINGS)
  const idleWarningCount = Object.keys(idleWarnings).length
  const networkStatus = useAppSelector((s) => s.network.status)

  const networkLoading = useAppSelector((s) => s.network.loading)
  const networkConfiguring = useAppSelector((s) => s.network.configuring)
  const networkBusy = networkLoading || networkConfiguring || !!networkStatus?.rebinding

  const [view, setView] = useState<AppView>('terminal')
  const [showSharePanel, setShowSharePanel] = useState(false)
  const [showUpdateInstructions, setShowUpdateInstructions] = useState(false)
  const [showSetupWizard, setShowSetupWizard] = useState(false)
  const [configFallback, setConfigFallback] = useState<ConfigFallbackInfo | null>(null)
  const [wizardInitialStep, setWizardInitialStep] = useState<1 | 2>(1)
  const [copied, setCopied] = useState(false)
  const [versionInfo, setVersionInfo] = useState<VersionInfo | null>(null)
  const [pendingFirewallCommand, setPendingFirewallCommand] = useState<{ tabId: string; command: string } | null>(null)
  const isMobile = useMobile()
  const isMobileRef = useRef(isMobile)
  const { isLandscape } = useOrientation()
  const { isFullscreen, toggleFullscreen, exitFullscreen } = useFullscreen()
  const paneLayouts = useAppSelector((s) => s.panes.layouts)
  const mainContentRef = useRef<HTMLDivElement>(null)
  const userOpenedSidebarOnMobileRef = useRef(false)
  const terminalMetaListRequestStartedAtRef = useRef(new Map<string, number>())
  const fullscreenTouchStartYRef = useRef<number | null>(null)
  const isLandscapeTerminalView = isMobile && isLandscape && view === 'terminal'

  // Keep this tab's Redux state in sync with persisted writes from other browser tabs.
  useEffect(() => {
    return installCrossTabSync(store)
  }, [])

  useEffect(() => {
    isMobileRef.current = isMobile
  }, [isMobile])

  // Sidebar width from settings (or local state during drag)
  const sidebarWidth = settings.sidebar?.width ?? 288
  const sidebarCollapsed = settings.sidebar?.collapsed ?? false

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

  useEffect(() => {
    if (isLandscapeTerminalView && !sidebarCollapsed) {
      dispatch(updateSettingsLocal({ sidebar: { ...settings.sidebar, collapsed: true } }))
    }
  }, [dispatch, isLandscapeTerminalView, settings.sidebar, sidebarCollapsed])

  useEffect(() => {
    if (view !== 'terminal' && isFullscreen) {
      void exitFullscreen()
    }
  }, [exitFullscreen, isFullscreen, view])

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
      triggerHapticFeedback()
    } else if (isMobile && newCollapsed) {
      triggerHapticFeedback()
    }
    dispatch(updateSettingsLocal({ sidebar: { ...settings.sidebar, collapsed: newCollapsed } }))
    try {
      await api.patch('/api/settings', { sidebar: { ...settings.sidebar, collapsed: newCollapsed } })
      dispatch(markSaved())
    } catch (err) {
      console.warn('Failed to save sidebar settings', err)
    }
  }, [isMobile, sidebarCollapsed, settings.sidebar, dispatch])

  // Swipe gesture: right-swipe from left edge opens sidebar, left-swipe closes it
  const swipeStartXRef = useRef(0)

  const bindSidebarSwipe = useDrag(
    ({ movement: [mx], velocity: [vx], direction: [dx], first, last, xy: [x] }) => {
      if (!isMobile || isLandscapeTerminalView) return
      if (first) {
        swipeStartXRef.current = x
        return
      }
      if (!last) return

      const startX = swipeStartXRef.current
      const swipedRight = dx > 0 && (mx > 50 || vx > 0.5)
      const swipedLeft = dx < 0 && (Math.abs(mx) > 50 || vx > 0.5)

      if (swipedRight && sidebarCollapsed && startX < 30) {
        toggleSidebarCollapse()
      } else if (swipedLeft && !sidebarCollapsed) {
        toggleSidebarCollapse()
      }
    },
    {
      axis: 'x',
      filterTaps: true,
      pointer: { touch: true },
    }
  )

  // Swipe gesture: left/right on terminal content area switches tabs
  const tabSwipeStartXRef = useRef(0)
  const bindTabSwipe = useDrag(
    ({ movement: [mx], velocity: [vx], direction: [dx], first, last, xy: [x] }) => {
      if (!isMobile || view !== 'terminal') return
      if (first) {
        tabSwipeStartXRef.current = x
        return
      }
      if (!last) return

      // If swipe started from the left edge, the sidebar swipe handler owns it
      if (tabSwipeStartXRef.current < 30 && sidebarCollapsed) return

      const swipedLeft = dx < 0 && (Math.abs(mx) > 50 || vx > 0.5)
      const swipedRight = dx > 0 && (mx > 50 || vx > 0.5)

      if (swipedLeft) {
        triggerHapticFeedback()
        dispatch(switchToNextTab())
      } else if (swipedRight) {
        triggerHapticFeedback()
        dispatch(switchToPrevTab())
      }
    },
    {
      axis: 'x',
      filterTaps: true,
      pointer: { touch: true },
    }
  )

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

  const handleShare = () => {
    const action = getShareAction(networkStatus)

    switch (action.type) {
      case 'loading':
        // Network status not loaded yet — retry the fetch so a transient
        // failure doesn't permanently disable the Share button.
        dispatch(fetchNetworkStatus())
        return
      case 'wizard':
        setWizardInitialStep(action.initialStep)
        setShowSetupWizard(true)
        return
      case 'panel':
        setCopied(false)
        setShowSharePanel(true)
        return
    }
  }

  const handleCopyAccessUrl = async () => {
    if (!networkStatus?.accessUrl) return
    try {
      await navigator.clipboard.writeText(networkStatus.accessUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.warn('Clipboard write failed:', err)
    }
  }

  const currentVersion = versionInfo?.currentVersion ?? null
  const updateCheck = versionInfo?.updateCheck ?? null
  const updateAvailable = !!updateCheck?.updateAvailable
  const latestVersion = updateCheck?.latestVersion ?? null
  const releaseUrl = updateCheck?.releaseUrl ?? null

  const handleBrandClick = useCallback(() => {
    if (updateAvailable) {
      setShowUpdateInstructions(true)
    }
  }, [updateAvailable])

  // Bootstrap: load settings, sessions, and connect websocket.
  useEffect(() => {
    let cancelled = false
    let cleanedUp = false
    let cleanup: (() => void) | null = null
    let stopTabRegistrySync: (() => void) | null = null
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
        const nextVersionInfo = await api.get<VersionInfo>('/api/version')
        if (!cancelled && isVersionInfo(nextVersionInfo)) {
          setVersionInfo(nextVersionInfo)
        }
      } catch (err: any) {
        console.warn('Failed to load version info', err)
      }

      try {
        const projects = await api.get('/api/sessions')
        if (!cancelled) dispatch(setProjects(projects))
      } catch (err: any) {
        console.warn('Failed to load sessions', err)
      }

      // Load network status for remote access wizard/settings
      if (!cancelled) dispatch(fetchNetworkStatus())

      const ws = getWsClient()
      stopTabRegistrySync = startTabRegistrySync(store, ws)

      // Set up hello extension to include session IDs for prioritized repair
      ws.setHelloExtensionProvider(() => ({
        sessions: getSessionsForHello(store.getState()),
        client: { mobile: isMobileRef.current },
      }))

      const unsubscribe = ws.onMessage((msg) => {
        if (!msg?.type) return
        if (msg.type === 'ready') {
          // If the initial connect attempt failed before ready, WsClient may still auto-reconnect.
          // Treat 'ready' as the source of truth for connection status.
          dispatch(setError(undefined))
          dispatch(setStatus('ready'))
          dispatch(resetWsSnapshotReceived())
          terminalMetaListRequestStartedAtRef.current.clear()
          const requestId = `terminal-meta-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
          terminalMetaListRequestStartedAtRef.current.set(requestId, Date.now())
          ws.send({
            type: 'terminal.meta.list',
            requestId,
          })
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
        if (msg.type === 'terminal.meta.list.response') {
          const requestId = typeof msg.requestId === 'string' ? msg.requestId : ''
          const requestedAt = requestId
            ? terminalMetaListRequestStartedAtRef.current.get(requestId)
            : undefined
          if (requestId) {
            terminalMetaListRequestStartedAtRef.current.delete(requestId)
          }
          dispatch(setTerminalMetaSnapshot({
            terminals: msg.terminals || [],
            requestedAt,
          }))
        }
        if (msg.type === 'terminal.meta.updated') {
          const upsert = Array.isArray(msg.upsert) ? msg.upsert : []
          if (upsert.length > 0) {
            dispatch(upsertTerminalMeta(upsert))
          }

          const remove = Array.isArray(msg.remove) ? msg.remove : []
          for (const terminalId of remove) {
            dispatch(removeTerminalMeta(terminalId))
          }
        }
        if (msg.type === 'terminal.exit') {
          const terminalId = msg.terminalId
          const code = msg.exitCode
          if (import.meta.env.MODE === 'development') console.log('terminal exit', terminalId, code)
          if (terminalId) {
            dispatch(clearIdleWarning(terminalId))
            dispatch(removeTerminalMeta(terminalId))
          }
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
        if (msg.type === 'config.fallback') {
          setConfigFallback({
            reason: parseConfigFallbackReason(msg.reason),
            backupExists: !!msg.backupExists,
          })
        }

        // SDK message handling (freshclaude pane)
        handleSdkMessage(dispatch, msg, ws)
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
      stopTabRegistrySync?.()
      void cleanupPromise
    }
  }, [dispatch])

  // Auto-show setup wizard on first run (unconfigured + localhost)
  useEffect(() => {
    if (networkStatus && !networkStatus.configured && networkStatus.host === '127.0.0.1') {
      setWizardInitialStep(1)
      setShowSetupWizard(true)
    }
  }, [networkStatus?.configured, networkStatus?.host])

  // Watch for terminal to become ready, then send the pending firewall command.
  // This respects the pane-owned terminal lifecycle in TerminalView.tsx —
  // TerminalView sends terminal.create and handles terminal.created internally.
  useEffect(() => {
    if (!pendingFirewallCommand) return
    const { tabId, command } = pendingFirewallCommand
    const layout = paneLayouts[tabId]
    if (!layout || layout.type !== 'leaf' || layout.content.kind !== 'terminal') return
    const terminalId = layout.content.terminalId
    if (!terminalId) return // terminal not ready yet

    // Terminal is running — send the firewall command
    const ws = getWsClient()
    ws.send({ type: 'terminal.input', terminalId, data: command + '\n' })
    setPendingFirewallCommand(null)
  }, [pendingFirewallCommand, paneLayouts])

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

  const handleTerminalChromeRevealTouchStart = useCallback((event: ReactTouchEvent<HTMLDivElement>) => {
    if (!isMobile || !isFullscreen || view !== 'terminal') return
    const touch = event.touches[0]
    if (!touch) return
    if (touch.clientY <= 48) {
      fullscreenTouchStartYRef.current = touch.clientY
    } else {
      fullscreenTouchStartYRef.current = null
    }
  }, [isFullscreen, isMobile, view])

  const handleTerminalChromeRevealTouchEnd = useCallback((event: ReactTouchEvent<HTMLDivElement>) => {
    const startY = fullscreenTouchStartYRef.current
    fullscreenTouchStartYRef.current = null
    if (!isMobile || !isFullscreen || view !== 'terminal') return
    if (startY === null) return
    const touch = event.changedTouches[0]
    if (!touch) return
    const deltaY = touch.clientY - startY
    if (deltaY > 60) {
      triggerHapticFeedback()
      void exitFullscreen()
    }
  }, [exitFullscreen, isFullscreen, isMobile, view])

  const content = (() => {
    if (view === 'sessions') {
      return (
        <ErrorBoundary label="Projects" onNavigate={() => setView('overview')}>
          <Suspense fallback={<div className="flex h-full items-center justify-center text-sm text-muted-foreground">Loading sessions…</div>}>
            <HistoryView onOpenSession={() => setView('terminal')} />
          </Suspense>
        </ErrorBoundary>
      )
    }
    if (view === 'settings') {
      return (
        <ErrorBoundary label="Settings" onNavigate={() => setView('overview')}>
          <Suspense fallback={<div className="flex h-full items-center justify-center text-sm text-muted-foreground">Loading settings…</div>}>
            <SettingsView onNavigate={setView} onFirewallTerminal={setPendingFirewallCommand} onSharePanel={() => { setCopied(false); setShowSharePanel(true) }} />
          </Suspense>
        </ErrorBoundary>
      )
    }
    if (view === 'overview') {
      return (
        <ErrorBoundary label="Panes">
          <OverviewView onOpenTab={() => setView('terminal')} />
        </ErrorBoundary>
      )
    }
    if (view === 'tabs') {
      return (
        <ErrorBoundary label="Tabs">
          <TabsView onOpenTab={() => setView('terminal')} />
        </ErrorBoundary>
      )
    }
    return (
      <div className="flex flex-col h-full">
        {!isLandscapeTerminalView && <TabBar />}
        <div
          className="flex-1 min-h-0 relative bg-background"
          data-testid="terminal-work-area"
          onTouchStart={handleTerminalChromeRevealTouchStart}
          onTouchEnd={handleTerminalChromeRevealTouchEnd}
        >
          <div
            className="pointer-events-none absolute inset-x-0 top-0 z-10 h-[3px] bg-background"
            data-testid="terminal-work-area-connector"
            aria-hidden="true"
          />
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
        className="h-full overflow-hidden flex flex-col bg-background text-foreground"
        data-context={ContextIds.Global}
      >
      {/* Top header bar spanning full width */}
      {isLandscapeTerminalView ? (
        <div className="h-6 px-2 flex items-center justify-between border-b border-border/30 bg-background/95 flex-shrink-0 text-xs">
          {currentVersion ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className={`font-mono text-[11px] rounded px-1 -mx-1 border-0 p-0 bg-transparent inline-flex items-center gap-1 transition-colors ${
                    updateAvailable
                      ? 'text-amber-700 dark:text-amber-400 bg-amber-100/60 dark:bg-amber-950/40 hover:bg-amber-200/70 dark:hover:bg-amber-900/60 cursor-pointer'
                      : 'text-muted-foreground cursor-default'
                  }`}
                  onClick={handleBrandClick}
                  aria-label={
                    updateAvailable
                      ? `Freshell v${currentVersion}. Update available${latestVersion ? `: v${latestVersion}` : ''}. Click for update instructions.`
                      : `Freshell v${currentVersion}. Up to date.`
                  }
                  data-testid="app-brand-status"
                >
                  <span>freshell</span>
                  {updateAvailable && <AlertCircle className="h-3 w-3" aria-hidden="true" />}
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {updateAvailable ? (
                  <div>
                    <div>v{currentVersion} - {latestVersion ? `v${latestVersion} available` : 'update available'}</div>
                    <div className="text-muted-foreground">Click for update instructions</div>
                  </div>
                ) : (
                  <div>v{currentVersion} (up to date)</div>
                )}
              </TooltipContent>
            </Tooltip>
          ) : (
            <span className="font-mono text-[11px] text-muted-foreground">freshell</span>
          )}
          <div className="flex items-center gap-1">
            <button
              onClick={() => { triggerHapticFeedback(); void toggleFullscreen(mainContentRef.current) }}
              className="min-h-6 rounded px-2 text-[11px] text-muted-foreground hover:text-foreground"
              aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
            >
              {isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
            </button>
            <div
              className="px-1.5"
              title={connection === 'ready' ? 'Connected' : connection === 'connecting' ? 'Connecting...' : connectionError || 'Disconnected'}
            >
              {connection === 'ready' ? (
                <Wifi className="h-3 w-3 text-muted-foreground" />
              ) : connection === 'connecting' ? (
                <Wifi className="h-3 w-3 text-muted-foreground animate-pulse" />
              ) : (
                <WifiOff className="h-3 w-3 text-muted-foreground" />
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="h-8 px-3 md:px-4 flex items-center justify-between border-b border-border/30 bg-background flex-shrink-0">
          <div className="flex items-center gap-2">
            <button
              onClick={toggleSidebarCollapse}
              className="p-1.5 rounded-md hover:bg-muted transition-colors min-h-11 min-w-11 md:min-h-0 md:min-w-0 flex items-center justify-center"
              title={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}
            >
              {sidebarCollapsed ? (
                <PanelLeft className="h-3.5 w-3.5 text-muted-foreground" />
              ) : (
                <PanelLeftClose className="h-3.5 w-3.5 text-muted-foreground" />
              )}
            </button>
            {currentVersion ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className={`font-mono text-base font-semibold tracking-tight rounded px-1 -mx-1 border-0 p-0 bg-transparent inline-flex items-center gap-1 transition-colors ${
                      updateAvailable
                        ? 'text-amber-700 dark:text-amber-400 bg-amber-100/60 dark:bg-amber-950/40 hover:bg-amber-200/70 dark:hover:bg-amber-900/60 cursor-pointer'
                        : 'cursor-default'
                    }`}
                    onClick={handleBrandClick}
                    aria-label={
                      updateAvailable
                        ? `Freshell v${currentVersion}. Update available${latestVersion ? `: v${latestVersion}` : ''}. Click for update instructions.`
                        : `Freshell v${currentVersion}. Up to date.`
                    }
                    data-testid="app-brand-status"
                  >
                    <span>🐚🔥freshell</span>
                    {updateAvailable && <AlertCircle className="h-3.5 w-3.5" aria-hidden="true" />}
                  </button>
                </TooltipTrigger>
              <TooltipContent side="bottom">
                {updateAvailable ? (
                  <div>
                    <div>v{currentVersion} - {latestVersion ? `v${latestVersion} available` : 'update available'}</div>
                      <div className="text-muted-foreground">Click for update instructions</div>
                    </div>
                  ) : (
                    <div>v{currentVersion} (up to date)</div>
                  )}
                </TooltipContent>
              </Tooltip>
            ) : (
              <span className="font-mono text-base font-semibold tracking-tight">🐚🔥freshell</span>
            )}
          </div>
          <div className="flex items-center gap-1">
            {idleWarningCount > 0 && (
              <button
                onClick={() => setView('overview')}
                className="px-2 py-1 rounded-md bg-amber-100 text-amber-950 hover:bg-amber-200 transition-colors text-xs font-medium"
                aria-label={`${idleWarningCount} coding agent terminal(s) will auto-kill soon`}
                title="View in Panes"
              >
                {idleWarningCount} terminal{idleWarningCount === 1 ? '' : 's'} will auto-kill soon
              </button>
            )}
            <button
              onClick={toggleTheme}
              className="p-1.5 rounded-md hover:bg-muted transition-colors min-h-11 min-w-11 md:min-h-0 md:min-w-0 flex items-center justify-center"
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
              className="p-1.5 rounded-md hover:bg-muted transition-colors min-h-11 min-w-11 md:min-h-0 md:min-w-0 flex items-center justify-center"
              title="Share LAN access"
              aria-label="Share"
            >
              {networkBusy ? (
                <Loader2 className="h-3.5 w-3.5 text-muted-foreground animate-spin" />
              ) : (
                <Share2 className="h-3.5 w-3.5 text-muted-foreground" />
              )}
            </button>
            {isMobile && view === 'terminal' && (
              <button
                onClick={() => { triggerHapticFeedback(); void toggleFullscreen(mainContentRef.current) }}
                className="p-1.5 rounded-md hover:bg-muted transition-colors min-h-11 min-w-11 md:min-h-0 md:min-w-0 flex items-center justify-center"
                title={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
                aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
              >
                {isFullscreen ? (
                  <Minimize2 className="h-3.5 w-3.5 text-muted-foreground" />
                ) : (
                  <Maximize2 className="h-3.5 w-3.5 text-muted-foreground" />
                )}
              </button>
            )}
            <div
              className="p-1.5 min-h-11 min-w-11 md:min-h-0 md:min-w-0 flex items-center justify-center"
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
      )}
      {configFallback && (
        <div className="px-3 md:px-4 py-2 border-b border-destructive/30 bg-destructive/10 text-destructive text-xs">
          <div className="flex items-start gap-2">
            <AlertTriangle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" aria-hidden="true" />
            <div className="flex-1 min-w-0" role="status" aria-live="polite">
              <p>
                Config file was invalid ({describeConfigFallbackReason(configFallback.reason)}), so freshell loaded defaults.
                {configFallback.backupExists
                  ? ' Backup found at ~/.freshell/config.backup.json.'
                  : ' No backup file was found.'}
              </p>
            </div>
            <button
              onClick={() => setConfigFallback(null)}
              className="text-destructive/80 hover:text-destructive transition-colors"
              aria-label="Dismiss config fallback warning"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}
      {/* Main content area with sidebar */}
      <div className="flex-1 min-h-0 flex relative" ref={mainContentRef} {...(isMobile ? bindSidebarSwipe() : {})} style={isMobile ? { touchAction: 'pan-y' } : undefined}>
        {/* Mobile overlay when sidebar is open */}
        {isMobile && !sidebarCollapsed && (
          <div
            className="absolute inset-0 bg-black/50 z-10"
            role="presentation"
            onClick={toggleSidebarCollapse}
            onTouchEnd={(e) => {
              e.preventDefault()
              toggleSidebarCollapse()
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') toggleSidebarCollapse()
            }}
            tabIndex={-1}
          />
        )}
        {/* Sidebar - on mobile it overlays, on desktop it's inline */}
        {!sidebarCollapsed && (
          <div className={isMobile ? 'absolute inset-y-0 left-0 right-0 z-20' : 'contents'}>
            <Sidebar view={view} onNavigate={(v) => {
              setView(v)
              // On mobile, collapse sidebar after navigation
              if (isMobile) toggleSidebarCollapse()
            }} width={sidebarWidth} fullWidth={isMobile} />
            {!isMobile && (
              <PaneDivider
                direction="horizontal"
                onResize={handleSidebarResize}
                onResizeEnd={handleSidebarResizeEnd}
              />
            )}
          </div>
        )}
        {/* TODO(#5): When fullscreen mode (#29) is implemented, add a vertical swipe-down
             gesture here to reveal the hidden tab bar. The @use-gesture/react useDrag
             infrastructure from the sidebar swipe can be extended for this. */}
        <div
          className="flex-1 min-w-0 flex flex-col"
          {...(isMobile ? bindTabSwipe() : {})}
          style={isMobile ? { touchAction: 'pan-y' } : undefined}
        >
          {content}
        </div>
      </div>

      {showUpdateInstructions && currentVersion && updateAvailable && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-[60]"
          role="presentation"
          onClick={() => setShowUpdateInstructions(false)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setShowUpdateInstructions(false)
          }}
          tabIndex={-1}
        >
          {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions */}
          <div
            className="bg-background border border-border rounded-lg shadow-lg max-w-md w-full mx-4 p-6"
            role="dialog"
            aria-modal="true"
            aria-label="Update instructions"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-lg font-semibold">Update Available</h2>
              <button
                onClick={() => setShowUpdateInstructions(false)}
                className="p-1 rounded hover:bg-muted transition-colors"
                aria-label="Close update instructions"
              >
                <X className="h-4 w-4 text-muted-foreground" />
              </button>
            </div>
            <p className="text-sm text-muted-foreground mb-3">
              You are running v{currentVersion}. {latestVersion ? `v${latestVersion} is available.` : 'A newer release is available.'}
            </p>
            <p className="text-sm text-muted-foreground mb-2">From your freshell install directory:</p>
            <pre className="bg-muted rounded-md p-3 text-xs overflow-x-auto mb-3">{`git pull
npm install
npm run build
npm run serve`}</pre>
            <p className="text-sm text-muted-foreground mb-4">
              You can also restart and accept the startup auto-update prompt.
            </p>
            <div className="flex items-center justify-end gap-2">
              {releaseUrl && (
                <a
                  href={releaseUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="h-8 px-3 rounded-md border border-border hover:bg-muted transition-colors text-sm inline-flex items-center"
                >
                  Release notes
                </a>
              )}
              <button
                onClick={() => setShowUpdateInstructions(false)}
                className="h-8 px-3 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors text-sm"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Network-aware share panel */}
      {showSharePanel && networkStatus && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-[60]"
          role="presentation"
          onClick={() => setShowSharePanel(false)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setShowSharePanel(false)
          }}
          tabIndex={-1}
        >
          {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions */}
          <div
            className="bg-background border border-border rounded-lg shadow-lg max-w-md w-full mx-4 p-6"
            role="dialog"
            aria-modal="true"
            aria-label="Share freshell access"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold">Share Access</h2>
              <button
                onClick={() => setShowSharePanel(false)}
                className="p-1 rounded hover:bg-muted transition-colors"
                aria-label="Close share panel"
              >
                <X className="h-4 w-4 text-muted-foreground" />
              </button>
            </div>
            <p className="text-sm text-muted-foreground mb-4">
              Share this link with devices on your local network or VPN.
            </p>
            {networkStatus.accessUrl && (
              <div className="flex justify-center mb-4">
                <ShareQrCode url={networkStatus.accessUrl} />
              </div>
            )}
            <div className="bg-muted rounded-md p-3 mb-4">
              <code className="text-sm break-all select-all">{networkStatus.accessUrl}</code>
            </div>
            <button
              onClick={handleCopyAccessUrl}
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
      {showSetupWizard && (
        <SetupWizard
          initialStep={wizardInitialStep}
          onNavigate={setView}
          onFirewallTerminal={setPendingFirewallCommand}
          onComplete={() => {
            setShowSetupWizard(false)
            dispatch(fetchNetworkStatus())
          }}
        />
      )}
      </div>
    </ContextMenuProvider>
  )
}
