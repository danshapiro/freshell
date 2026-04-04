import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type TouchEvent as ReactTouchEvent,
} from 'react'
import { shallowEqual } from 'react-redux'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import { updateTab, switchToNextTab, switchToPrevTab } from '@/store/tabsSlice'
import { consumePaneRefreshRequest, splitPane, updatePaneContent, updatePaneTitle } from '@/store/panesSlice'
import { updateSessionActivity } from '@/store/sessionActivitySlice'
import { updateSettingsLocal } from '@/store/settingsSlice'
import { clearPaneRuntimeActivity, setPaneRuntimeActivity } from '@/store/paneRuntimeActivitySlice'
import { recordTurnComplete, clearTabAttention, clearPaneAttention } from '@/store/turnCompletionSlice'
import { focusNextTerminalSearchMatch, focusPreviousTerminalSearchMatch, loadTerminalSearch } from '@/store/terminalDirectoryThunks'
import { isFatalConnectionErrorCode } from '@/store/connectionSlice'
import { getWsClient } from '@/lib/ws-client'
import { getTerminalTheme } from '@/lib/terminal-themes'
import { getResumeSessionIdFromRef } from '@/components/terminal-view-utils'
import { copyText, readText } from '@/lib/clipboard'
import { registerTerminalActions } from '@/lib/pane-action-registry'
import { registerTerminalCaptureHandler } from '@/lib/screenshot-capture-env'
import { consumeTerminalRestoreRequestId, addTerminalRestoreRequestId } from '@/lib/terminal-restore'
import { isTerminalPasteShortcut } from '@/lib/terminal-input-policy'
import { clearTerminalCursor, loadTerminalCursor, saveTerminalCursor } from '@/lib/terminal-cursor'
import { paneRefreshTargetMatchesContent } from '@/lib/pane-utils'
import { getInstalledPerfAuditBridge } from '@/lib/perf-audit-bridge'
import {
  beginAttach,
  createAttachSeqState,
  onAttachReady,
  onOutputFrame,
  onOutputGap,
  type AttachSeqState,
} from '@/lib/terminal-attach-seq-state'
import { useMobile } from '@/hooks/useMobile'
import { findLocalFilePaths } from '@/lib/path-utils'
import { findUrls } from '@/lib/url-utils'
import { setHoveredUrl, clearHoveredUrl } from '@/lib/terminal-hovered-url'
import { getTabSwitchShortcutDirection, getTabLifecycleAction } from '@/lib/tab-switch-shortcuts'
import {
  createTurnCompleteSignalParserState,
  extractTurnCompleteSignals,
} from '@/lib/turn-complete-signal'
import {
  createOsc52ParserState,
  extractOsc52Events,
  type Osc52Event,
  type Osc52Policy,
} from '@/lib/terminal-osc52'
import {
  createTerminalStartupProbeState,
  extractTerminalStartupProbes,
} from '@/lib/terminal-startup-probes'
import { ContextIds } from '@/components/context-menu/context-menu-constants'
import { resolveTerminalFontFamily } from '@/lib/terminal-fonts'
import { ConnectionErrorOverlay } from '@/components/terminal/ConnectionErrorOverlay'
import { Osc52PromptModal } from '@/components/terminal/Osc52PromptModal'
import { TerminalSearchBar } from '@/components/terminal/TerminalSearchBar'
import { registerTerminalRequestModeBypass } from '@/components/terminal/request-mode-bypass'
import {
  createTerminalRuntime,
  type TerminalRuntime,
} from '@/components/terminal/terminal-runtime'
import { createLayoutScheduler } from '@/components/terminal/layout-scheduler'
import { createTerminalWriteQueue, type TerminalWriteQueue } from '@/components/terminal/terminal-write-queue'
import { nanoid } from 'nanoid'
import { cn } from '@/lib/utils'
import { Terminal } from '@xterm/xterm'
import { Loader2 } from 'lucide-react'
import { ConfirmModal } from '@/components/ui/confirm-modal'
import type { PaneContent, PaneContentInput, PaneRefreshRequest, TerminalPaneContent } from '@/store/paneTypes'
import '@xterm/xterm/css/xterm.css'
import { getHydrationQueue } from '@/lib/hydration-queue'
import { createLogger } from '@/lib/client-logger'

const log = createLogger('TerminalView')

const SESSION_ACTIVITY_THROTTLE_MS = 5000
export const RATE_LIMIT_RETRY_MAX_ATTEMPTS = 5
export const RATE_LIMIT_RETRY_BASE_MS = 2000
export const RATE_LIMIT_RETRY_MAX_MS = 12000
const KEYBOARD_INSET_ACTIVATION_PX = 80
const MOBILE_KEYBAR_HEIGHT_PX = 40
const MOBILE_KEY_REPEAT_INITIAL_DELAY_MS = 320
const STARTUP_PROBE_OSC11_QUERY = '\u001b]11;?\u0007'

function isClaudeTurnSubmit(data: string): boolean {
  return data.includes('\r') || data.includes('\n')
}
const MOBILE_KEY_REPEAT_INTERVAL_MS = 70
const TAP_MULTI_INTERVAL_MS = 350
const TAP_MAX_DISTANCE_PX = 24
const TOUCH_SCROLL_PIXELS_PER_LINE = 18
const LIGHT_THEME_MIN_CONTRAST_RATIO = 4.5
const DEFAULT_MIN_CONTRAST_RATIO = 1
const MAX_LAST_SENT_VIEWPORT_CACHE_ENTRIES = 200
const TRUNCATED_REPLAY_BYTES = 128 * 1024

type StartupProbeReplayDiscardState = {
  remainder: string | null
}

function resolveMinimumContrastRatio(theme?: { isDark?: boolean } | null): number {
  return theme?.isDark === false ? LIGHT_THEME_MIN_CONTRAST_RATIO : DEFAULT_MIN_CONTRAST_RATIO
}

function consumeStartupProbeReplayDiscard(raw: string, state: StartupProbeReplayDiscardState): string {
  const remainder = state.remainder
  state.remainder = null
  if (!remainder) {
    return raw
  }

  let matched = 0
  while (
    matched < raw.length
    && matched < remainder.length
    && raw[matched] === remainder[matched]
  ) {
    matched += 1
  }

  if (matched === remainder.length) {
    return raw.slice(matched)
  }

  if (matched === raw.length) {
    return ''
  }

  return raw
}

function getStartupProbeReplayRemainder(pending: string): string | null {
  if (!pending || pending === STARTUP_PROBE_OSC11_QUERY) {
    return null
  }
  return STARTUP_PROBE_OSC11_QUERY.startsWith(pending)
    ? STARTUP_PROBE_OSC11_QUERY.slice(pending.length)
    : null
}

function deferTerminalPointerMutation(callback: () => void): void {
  // xterm link activation runs inside element-level mouse handlers while it may
  // still have document-level mouseup/move listeners in flight. Reparenting the
  // terminal synchronously can dispose the renderer before those listeners finish.
  queueMicrotask(callback)
}

function createNoopRuntime(): TerminalRuntime {
  return {
    attachAddons: () => {},
    fit: () => {},
    findNext: () => false,
    findPrevious: () => false,
    clearDecorations: () => {},
    onDidChangeResults: () => ({ dispose: () => {} }),
    dispose: () => {},
    webglActive: () => false,
    suspendWebgl: () => false,
    resumeWebgl: () => {},
  }
}

interface TerminalViewProps {
  tabId: string
  paneId: string
  paneContent: PaneContent
  hidden?: boolean
}

type AttachIntent = 'viewport_hydrate' | 'keepalive_delta' | 'transport_reconnect'

type DeferredAttachState = {
  mode: 'none' | 'waiting_for_geometry' | 'attaching' | 'live'
  pendingIntent: AttachIntent | null
  pendingSinceSeq: number
}

type LaunchAttemptState = {
  requestId: string
  terminalId?: string
  restore: boolean
  attachReady: boolean
}

type SentViewport = {
  terminalId: string
  cols: number
  rows: number
}

const lastSentViewportByTerminal = new Map<string, { cols: number; rows: number }>()

function rememberSentViewport(terminalId: string, cols: number, rows: number): void {
  if (lastSentViewportByTerminal.has(terminalId)) {
    lastSentViewportByTerminal.delete(terminalId)
  }
  lastSentViewportByTerminal.set(terminalId, { cols, rows })
  if (lastSentViewportByTerminal.size > MAX_LAST_SENT_VIEWPORT_CACHE_ENTRIES) {
    const oldestTerminalId = lastSentViewportByTerminal.keys().next().value
    if (typeof oldestTerminalId === 'string') {
      lastSentViewportByTerminal.delete(oldestTerminalId)
    }
  }
}

function forgetSentViewport(terminalId?: string): void {
  if (!terminalId) return
  lastSentViewportByTerminal.delete(terminalId)
}

export function __resetLastSentViewportCacheForTests(): void {
  lastSentViewportByTerminal.clear()
}

export function __getLastSentViewportCacheSizeForTests(): number {
  return lastSentViewportByTerminal.size
}

type MobileToolbarKeyId = 'esc' | 'tab' | 'ctrl' | 'up' | 'down' | 'left' | 'right'
type RepeatableMobileToolbarKeyId = Extract<MobileToolbarKeyId, 'up' | 'down' | 'left' | 'right'>

const MOBILE_TOOLBAR_KEYS: Array<{ id: MobileToolbarKeyId; label: string; ariaLabel: string; isArrow?: boolean }> = [
  { id: 'esc', label: 'Esc', ariaLabel: 'Esc key' },
  { id: 'tab', label: 'Tab', ariaLabel: 'Tab key' },
  { id: 'ctrl', label: 'Ctrl', ariaLabel: 'Toggle Ctrl modifier' },
  { id: 'up', label: '↑', ariaLabel: 'Up key', isArrow: true },
  { id: 'down', label: '↓', ariaLabel: 'Down key', isArrow: true },
  { id: 'left', label: '←', ariaLabel: 'Left key', isArrow: true },
  { id: 'right', label: '→', ariaLabel: 'Right key', isArrow: true },
]

function isRepeatableMobileToolbarKey(keyId: MobileToolbarKeyId): keyId is RepeatableMobileToolbarKeyId {
  return keyId === 'up' || keyId === 'down' || keyId === 'left' || keyId === 'right'
}

function resolveMobileToolbarInput(keyId: Exclude<MobileToolbarKeyId, 'ctrl'>, ctrlActive: boolean): string {
  if (ctrlActive) {
    if (keyId === 'up') return '\u001b[1;5A'
    if (keyId === 'down') return '\u001b[1;5B'
    if (keyId === 'right') return '\u001b[1;5C'
    if (keyId === 'left') return '\u001b[1;5D'
    // Ctrl+Esc and Ctrl+Tab do not have canonical terminal sequences; send plain key input.
  }

  if (keyId === 'esc') return '\u001b'
  if (keyId === 'tab') return '\t'
  if (keyId === 'up') return '\u001b[A'
  if (keyId === 'down') return '\u001b[B'
  if (keyId === 'right') return '\u001b[C'
  if (keyId === 'left') return '\u001b[D'
  const unreachableKey: never = keyId
  throw new Error(`Unsupported mobile toolbar key: ${unreachableKey}`)
}

export default function TerminalView({ tabId, paneId, paneContent, hidden }: TerminalViewProps) {
  const dispatch = useAppDispatch()
  const isMobile = useMobile()
  const connectionStatus = useAppSelector((s) => s.connection.status)
  const tab = useAppSelector((s) => s.tabs.tabs.find((t) => t.id === tabId))
  const activeTabId = useAppSelector((s) => s.tabs.activeTabId)
  const tabOrder = useAppSelector((s) => s.tabs.tabs.map((t) => t.id), shallowEqual)
  const activePaneId = useAppSelector((s) => s.panes.activePane[tabId])
  const refreshRequest = useAppSelector((s) => s.panes.refreshRequestsByPane?.[tabId]?.[paneId] ?? null)
  const localServerInstanceId = useAppSelector((s) => s.connection.serverInstanceId)
  const connectionErrorCode = useAppSelector((s) => s.connection.lastErrorCode)
  const settings = useAppSelector((s) => s.settings.settings)
  const hasAttention = useAppSelector((s) => !!s.turnCompletion?.attentionByTab?.[tabId])
  const hasAttentionRef = useRef(hasAttention)
  const hasPaneAttention = useAppSelector((s) => !!s.turnCompletion?.attentionByPane?.[paneId])
  const hasPaneAttentionRef = useRef(hasPaneAttention)

  // All hooks MUST be called before any conditional returns
  const ws = useMemo(() => getWsClient(), [])
  // Playwright can opt a pane into state-only mode so activity chrome tests
  // don't race the live terminal create/attach lifecycle.
  const suppressNetworkEffects = typeof window !== 'undefined'
    && window.__FRESHELL_TEST_HARNESS__?.isTerminalNetworkEffectsSuppressed?.(paneId) === true
  const [isAttaching, setIsAttaching] = useState(false)
  const [truncatedHistoryGap, setTruncatedHistoryGap] = useState<{ fromSeq: number; toSeq: number } | null>(null)
  const [backgroundHydrationTriggered, setBackgroundHydrationTriggered] = useState(false)
  const wasCreatedFreshRef = useRef(paneContent.kind === 'terminal' && paneContent.status === 'creating')
  const [pendingLinkUri, setPendingLinkUri] = useState<string | null>(null)
  const [pendingOsc52Event, setPendingOsc52Event] = useState<Osc52Event | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [keyboardInsetPx, setKeyboardInsetPx] = useState(0)
  const [mobileCtrlActive, setMobileCtrlActive] = useState(false)
  const setPendingLinkUriRef = useRef(setPendingLinkUri)
  const mobileCtrlActiveRef = useRef(false)

  const containerRef = useRef<HTMLDivElement | null>(null)
  const wrapperRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const runtimeRef = useRef<TerminalRuntime | null>(null)
  const writeQueueRef = useRef<TerminalWriteQueue | null>(null)
  const layoutSchedulerRef = useRef<ReturnType<typeof createLayoutScheduler> | null>(null)
  const pendingLayoutWorkRef = useRef({
    fit: false,
    resize: false,
    scrollToBottom: false,
    focus: false,
  })
  const mountedRef = useRef(false)
  const hiddenRef = useRef(hidden)
  const hydrationRegisteredRef = useRef(false)
  const lastSessionActivityAtRef = useRef(0)
  const rateLimitRetryRef = useRef<{ count: number; timer: ReturnType<typeof setTimeout> | null }>({ count: 0, timer: null })
  const restoreRequestIdRef = useRef<string | null>(null)
  const restoreFlagRef = useRef(false)
  const turnCompleteSignalStateRef = useRef(createTurnCompleteSignalParserState())
  const startupProbeStateRef = useRef(createTerminalStartupProbeState())
  const startupProbeReplayDiscardStateRef = useRef<StartupProbeReplayDiscardState>({
    remainder: null,
  })
  const osc52ParserRef = useRef(createOsc52ParserState())
  const resolvedThemeRef = useRef(getTerminalTheme(settings.terminal.theme, settings.theme))
  const osc52PolicyRef = useRef<Osc52Policy>(settings.terminal.osc52Clipboard)
  const pendingOsc52EventRef = useRef<Osc52Event | null>(null)
  const osc52QueueRef = useRef<Osc52Event[]>([])
  const warnExternalLinksRef = useRef(settings.terminal.warnExternalLinks)
  const debugRef = useRef(!!settings.logging?.debug)
  const attentionDismissRef = useRef(settings.panes?.attentionDismiss ?? 'click')
  const touchActiveRef = useRef(false)
  const touchSelectionModeRef = useRef(false)
  const touchStartYRef = useRef(0)
  const touchLastYRef = useRef(0)
  const touchScrollAccumulatorRef = useRef(0)
  const touchStartXRef = useRef(0)
  const touchMovedRef = useRef(false)
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mobileKeyRepeatDelayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mobileKeyRepeatIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const lastTapAtRef = useRef(0)
  const lastTapPointRef = useRef<{ x: number; y: number } | null>(null)
  const tapCountRef = useRef(0)
  const terminalFirstOutputMarkedRef = useRef(false)
  const turnCompletedSinceLastInputRef = useRef(true)

  // Extract terminal-specific fields (safe because we check kind later)
  const isTerminal = paneContent.kind === 'terminal'
  const terminalContent = isTerminal ? paneContent : null
  const terminalSearchState = useAppSelector((state) => {
    const terminalId = terminalContent?.terminalId
    if (!terminalId) return null
    return (state as any).terminalDirectory?.searches?.[terminalId] ?? null
  }) as {
    query: string
    matches: Array<unknown>
    activeIndex?: number
    loading: boolean
  } | null

  // Refs for terminal lifecycle (only meaningful if isTerminal)
  // CRITICAL: Use refs to avoid callback/effect dependency on changing content
  const requestIdRef = useRef<string>(terminalContent?.createRequestId || '')
  const terminalIdRef = useRef<string | undefined>(terminalContent?.terminalId)
  const seqStateRef = useRef<AttachSeqState>(createAttachSeqState())
  const attachCounterRef = useRef(0)
  const currentAttachRef = useRef<{
    requestId: string
    intent: AttachIntent
    terminalId: string
    sinceSeq: number
    cols: number
    rows: number
  } | null>(null)
  const launchAttemptRef = useRef<LaunchAttemptState | null>(null)
  const suppressNextMatchingResizeRef = useRef<{
    terminalId: string
    cols: number
    rows: number
  } | null>(null)
  const lastSentViewportRef = useRef<SentViewport | null>(null)
  const handledCreatedMessageRef = useRef<{
    requestId: string
    terminalId: string
  } | null>(null)
  const searchTerminalIdCleanupRef = useRef<string | null>(terminalContent?.terminalId ?? null)
  const deferredAttachStateRef = useRef<DeferredAttachState>({
    mode: 'none',
    pendingIntent: null,
    pendingSinceSeq: 0,
  })
  const contentRef = useRef<TerminalPaneContent | null>(terminalContent)
  const refreshRequestRef = useRef<PaneRefreshRequest | null>(refreshRequest)
  const handledRefreshRequestIdRef = useRef<string | null>(null)
  const hasMountedRefreshEffectRef = useRef(false)

  const applySeqState = useCallback((
    nextState: AttachSeqState,
    options?: { terminalId?: string; persistCursor?: boolean },
  ) => {
    const previousLastSeq = seqStateRef.current.lastSeq
    seqStateRef.current = nextState
    if (
      options?.persistCursor
      && options.terminalId
      && nextState.lastSeq > 0
      && nextState.lastSeq > previousLastSeq
    ) {
      saveTerminalCursor(options.terminalId, nextState.lastSeq)
    }
  }, [])

  // Keep refs in sync with props
  useEffect(() => {
    if (terminalContent) {
      const prev = contentRef.current
      const prevTerminalId = terminalIdRef.current
      if (prev && terminalContent.resumeSessionId !== prev.resumeSessionId) {
        if (debugRef.current) log.debug('[TRACE resumeSessionId] ref sync from props CHANGED resumeSessionId', {
          paneId,
          from: prev.resumeSessionId,
          to: terminalContent.resumeSessionId,
          createRequestId: terminalContent.createRequestId,
        })
      }
      terminalIdRef.current = terminalContent.terminalId
      if (terminalContent.terminalId !== prevTerminalId) {
        forgetSentViewport(prevTerminalId)
        const cachedViewport = terminalContent.terminalId
          ? lastSentViewportByTerminal.get(terminalContent.terminalId)
          : undefined
        lastSentViewportRef.current = terminalContent.terminalId && cachedViewport
          ? { terminalId: terminalContent.terminalId, cols: cachedViewport.cols, rows: cachedViewport.rows }
          : null
        const initialSeq = terminalContent.terminalId
          ? loadTerminalCursor(terminalContent.terminalId)
          : 0
        applySeqState(createAttachSeqState({ lastSeq: initialSeq }))
      }
      requestIdRef.current = terminalContent.createRequestId
      contentRef.current = terminalContent
    }
  }, [terminalContent, paneId, applySeqState])

  // Register terminal buffer accessor with test harness (for E2E tests).
  // Uses xterm.js Terminal.buffer.active API which works with all renderers
  // (WebGL, canvas, DOM) — unlike DOM scraping via .xterm-rows which only
  // works with the DOM renderer.
  //
  // This must be a useEffect watching terminalContent?.terminalId because:
  // 1. When the xterm Terminal is first created, terminalId is undefined
  //    (the server hasn't responded with terminal.created yet)
  // 2. terminalId becomes defined asynchronously via a WS message handler
  // 3. The useEffect fires when terminalId transitions from undefined to a
  //    real value, which is exactly when we can register the buffer
  useEffect(() => {
    const tid = terminalContent?.terminalId
    if (!window.__FRESHELL_TEST_HARNESS__ || !tid) return

    window.__FRESHELL_TEST_HARNESS__.registerTerminalBuffer(
      tid,
      () => {
        const t = termRef.current
        if (!t) return ''
        const buf = t.buffer.active
        const lines: string[] = []
        for (let y = 0; y < buf.length; y++) {
          const line = buf.getLine(y)
          if (line) lines.push(line.translateToString(true))
        }
        return lines.join('\n')
      },
    )

    return () => {
      window.__FRESHELL_TEST_HARNESS__?.unregisterTerminalBuffer(tid)
    }
  }, [terminalContent?.terminalId])

  useEffect(() => {
    hiddenRef.current = hidden
    if (hidden) {
      clearHoveredUrl(paneId)
      if (wrapperRef.current) {
        delete wrapperRef.current.dataset.hoveredUrl
      }
    }
  }, [hidden, paneId])

  useEffect(() => {
    warnExternalLinksRef.current = settings.terminal.warnExternalLinks
  }, [settings.terminal.warnExternalLinks])

  useEffect(() => {
    osc52PolicyRef.current = settings.terminal.osc52Clipboard
  }, [settings.terminal.osc52Clipboard])

  useEffect(() => {
    pendingOsc52EventRef.current = pendingOsc52Event
  }, [pendingOsc52Event])

  // Sync during render (not in useEffect) so refs always have latest values
  hasAttentionRef.current = hasAttention
  hasPaneAttentionRef.current = hasPaneAttention
  attentionDismissRef.current = settings.panes?.attentionDismiss ?? 'click'
  debugRef.current = !!settings.logging?.debug
  refreshRequestRef.current = refreshRequest

  const shouldFocusActiveTerminal = !hidden && activeTabId === tabId && activePaneId === paneId

  // Keep the active pane's terminal focused when tabs/panes switch so typing works immediately.
  useEffect(() => {
    if (!isTerminal) return
    if (!shouldFocusActiveTerminal) return
    const term = termRef.current
    if (!term) return

    requestAnimationFrame(() => {
      if (termRef.current !== term) return
      term.focus()
    })
  }, [isTerminal, shouldFocusActiveTerminal])

  useEffect(() => {
    lastSessionActivityAtRef.current = 0
  }, [terminalContent?.resumeSessionId])

  useEffect(() => {
    if (!isMobile || typeof window === 'undefined' || !window.visualViewport) {
      setKeyboardInsetPx(0)
      return
    }

    const viewport = window.visualViewport
    let rafId: number | null = null

    const updateKeyboardInset = () => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId)
      }
      rafId = requestAnimationFrame(() => {
        const rawInset = Math.max(0, window.innerHeight - (viewport.height + viewport.offsetTop))
        const nextInset = rawInset >= KEYBOARD_INSET_ACTIVATION_PX ? Math.round(rawInset) : 0
        setKeyboardInsetPx((prev) => (prev === nextInset ? prev : nextInset))
      })
    }

    updateKeyboardInset()
    viewport.addEventListener('resize', updateKeyboardInset)
    viewport.addEventListener('scroll', updateKeyboardInset)

    return () => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId)
      }
      viewport.removeEventListener('resize', updateKeyboardInset)
      viewport.removeEventListener('scroll', updateKeyboardInset)
    }
  }, [isMobile])

  const clearLongPressTimer = useCallback(() => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current)
      longPressTimerRef.current = null
    }
  }, [])

  const getCellFromClientPoint = useCallback((clientX: number, clientY: number) => {
    const term = termRef.current
    const container = containerRef.current
    if (!term || !container) return null
    if (term.cols <= 0 || term.rows <= 0) return null

    const rect = container.getBoundingClientRect()
    const relativeX = clientX - rect.left
    const relativeY = clientY - rect.top
    if (relativeX < 0 || relativeY < 0 || relativeX > rect.width || relativeY > rect.height) return null

    const columnWidth = rect.width / term.cols
    const rowHeight = rect.height / term.rows
    if (columnWidth <= 0 || rowHeight <= 0) return null

    const col = Math.max(0, Math.min(term.cols - 1, Math.floor(relativeX / columnWidth)))
    const viewportRow = Math.max(0, Math.min(term.rows - 1, Math.floor(relativeY / rowHeight)))
    const baseRow = term.buffer.active?.viewportY ?? 0
    const row = baseRow + viewportRow
    return { col, row }
  }, [])

  const selectWordAtPoint = useCallback((clientX: number, clientY: number) => {
    const term = termRef.current
    if (!term) return
    const cell = getCellFromClientPoint(clientX, clientY)
    if (!cell) return

    const line = term.buffer.active?.getLine(cell.row)
    const text = line?.translateToString(true) ?? ''
    if (!text) return

    const isWordChar = (char: string | undefined) => !!char && /[A-Za-z0-9_$./-]/.test(char)
    let start = Math.min(cell.col, Math.max(0, text.length - 1))
    let end = start

    if (!isWordChar(text[start])) {
      term.select(start, cell.row, 1)
      return
    }

    while (start > 0 && isWordChar(text[start - 1])) start -= 1
    while (end < text.length && isWordChar(text[end])) end += 1

    term.select(start, cell.row, Math.max(1, end - start))
  }, [getCellFromClientPoint])

  const selectLineAtPoint = useCallback((clientX: number, clientY: number) => {
    const term = termRef.current
    if (!term) return
    const cell = getCellFromClientPoint(clientX, clientY)
    if (!cell) return
    term.selectLines(cell.row, cell.row)
  }, [getCellFromClientPoint])

  const handleMobileTouchStart = useCallback((event: ReactTouchEvent<HTMLDivElement>) => {
    if (!isMobile) return
    const touch = event.touches[0]
    if (!touch) return

    touchActiveRef.current = true
    touchSelectionModeRef.current = false
    touchMovedRef.current = false
    touchStartYRef.current = touch.clientY
    touchLastYRef.current = touch.clientY
    touchStartXRef.current = touch.clientX
    touchScrollAccumulatorRef.current = 0
    clearLongPressTimer()
    longPressTimerRef.current = setTimeout(() => {
      touchSelectionModeRef.current = true
    }, 350)
  }, [clearLongPressTimer, isMobile])

  const handleMobileTouchMove = useCallback((event: ReactTouchEvent<HTMLDivElement>) => {
    if (!isMobile || !touchActiveRef.current) return
    const touch = event.touches[0]
    if (!touch) return

    const deltaX = Math.abs(touch.clientX - touchStartXRef.current)
    const deltaYFromStart = Math.abs(touch.clientY - touchStartYRef.current)
    if (!touchMovedRef.current && (deltaX > 8 || deltaYFromStart > 8)) {
      touchMovedRef.current = true
      clearLongPressTimer()
    }

    if (touchSelectionModeRef.current) return

    const deltaY = touch.clientY - touchLastYRef.current
    touchLastYRef.current = touch.clientY
    // Match native touch behavior: content follows drag direction.
    touchScrollAccumulatorRef.current -= deltaY

    const rawLines = touchScrollAccumulatorRef.current / TOUCH_SCROLL_PIXELS_PER_LINE
    const lines = rawLines > 0 ? Math.floor(rawLines) : Math.ceil(rawLines)
    if (lines !== 0) {
      termRef.current?.scrollLines(lines)
      touchScrollAccumulatorRef.current -= lines * TOUCH_SCROLL_PIXELS_PER_LINE
    }
  }, [clearLongPressTimer, isMobile])

  const handleMobileTouchEnd = useCallback((event: ReactTouchEvent<HTMLDivElement>) => {
    if (!isMobile) return
    clearLongPressTimer()

    const changed = event.changedTouches[0]
    const wasSelectionMode = touchSelectionModeRef.current
    const moved = touchMovedRef.current

    touchActiveRef.current = false
    touchSelectionModeRef.current = false
    touchMovedRef.current = false
    touchScrollAccumulatorRef.current = 0

    if (!changed || wasSelectionMode || moved) return

    const now = Date.now()
    const lastTapPoint = lastTapPointRef.current
    const lastTapAt = lastTapAtRef.current
    const withinInterval = now - lastTapAt <= TAP_MULTI_INTERVAL_MS
    const withinDistance = !!lastTapPoint
      && Math.abs(changed.clientX - lastTapPoint.x) <= TAP_MAX_DISTANCE_PX
      && Math.abs(changed.clientY - lastTapPoint.y) <= TAP_MAX_DISTANCE_PX

    if (withinInterval && withinDistance) {
      tapCountRef.current += 1
    } else {
      tapCountRef.current = 1
    }

    lastTapAtRef.current = now
    lastTapPointRef.current = { x: changed.clientX, y: changed.clientY }

    if (tapCountRef.current === 2) {
      selectWordAtPoint(changed.clientX, changed.clientY)
      return
    }
    if (tapCountRef.current >= 3) {
      selectLineAtPoint(changed.clientX, changed.clientY)
      tapCountRef.current = 0
    }
  }, [clearLongPressTimer, isMobile, selectLineAtPoint, selectWordAtPoint])

  useEffect(() => {
    return () => {
      clearLongPressTimer()
    }
  }, [clearLongPressTimer])

  useEffect(() => {
    const terminalId = terminalContent?.terminalId ?? null
    const previousTerminalId = searchTerminalIdCleanupRef.current
    if (previousTerminalId && previousTerminalId !== terminalId) {
      void dispatch(loadTerminalSearch({ terminalId: previousTerminalId, query: '' }) as any).catch(() => {})
      setSearchQuery('')
    }
    searchTerminalIdCleanupRef.current = terminalId
  }, [dispatch, terminalContent?.terminalId])

  useEffect(() => {
    return () => {
      const terminalId = searchTerminalIdCleanupRef.current
      if (!terminalId) return
      void dispatch(loadTerminalSearch({ terminalId, query: '' }) as any).catch(() => {})
    }
  }, [dispatch])

  // Helper to update pane content - uses ref to avoid recreation on content changes
  // This is CRITICAL: if updateContent depended on terminalContent directly,
  // it would be recreated on every status update, causing the effect to re-run
  const updateContent = useCallback((updates: Partial<TerminalPaneContent>) => {
    const current = contentRef.current
    if (!current) return
    const next = { ...current, ...updates }
    // Trace resumeSessionId changes
    if ('resumeSessionId' in updates && updates.resumeSessionId !== current.resumeSessionId) {
      if (debugRef.current) log.debug('[TRACE resumeSessionId] updateContent CHANGING resumeSessionId', {
        paneId,
        from: current.resumeSessionId,
        to: updates.resumeSessionId,
        stack: new Error().stack?.split('\n').slice(1, 5).join('\n'),
      })
    }
    contentRef.current = next
    dispatch(updatePaneContent({
      tabId,
      paneId,
      content: next,
    }))
  }, [dispatch, tabId, paneId]) // NO terminalContent dependency - uses ref

  const requestTerminalLayout = useCallback((options: {
    fit?: boolean
    resize?: boolean
    scrollToBottom?: boolean
    focus?: boolean
  }) => {
    const pending = pendingLayoutWorkRef.current
    if (options.fit || options.resize) pending.fit = true
    if (options.resize) pending.resize = true
    if (options.scrollToBottom) pending.scrollToBottom = true
    if (options.focus) pending.focus = true
    layoutSchedulerRef.current?.request()
  }, [])

  const flushScheduledLayout = useCallback(() => {
    const term = termRef.current
    if (!term) return

    const runtime = runtimeRef.current
    const pending = pendingLayoutWorkRef.current
    const shouldFit = pending.fit
    const shouldResize = pending.resize
    const shouldScrollToBottom = pending.scrollToBottom
    const shouldFocus = pending.focus
    pending.fit = false
    pending.resize = false
    pending.scrollToBottom = false
    pending.focus = false

    if (shouldFit && !hiddenRef.current && runtime) {
      try {
        runtime.fit()
      } catch {
        // disposed
      }

      if (shouldResize) {
        const tid = terminalIdRef.current
        if (tid) {
          const suppressedResize = suppressNextMatchingResizeRef.current
          const matchesSuppressedViewport = suppressedResize
            && suppressedResize.terminalId === tid
            && suppressedResize.cols === term.cols
            && suppressedResize.rows === term.rows
          const lastSentViewport = lastSentViewportRef.current
          const matchesLastSentViewport = lastSentViewport
            && lastSentViewport.terminalId === tid
            && lastSentViewport.cols === term.cols
            && lastSentViewport.rows === term.rows
          if (matchesSuppressedViewport) {
            suppressNextMatchingResizeRef.current = null
          } else if (!matchesLastSentViewport && !suppressNetworkEffects) {
            ws.send({ type: 'terminal.resize', terminalId: tid, cols: term.cols, rows: term.rows })
            rememberSentViewport(tid, term.cols, term.rows)
            lastSentViewportRef.current = { terminalId: tid, cols: term.cols, rows: term.rows }
          }
        }
      }
    }

    if (shouldScrollToBottom) {
      try { term.scrollToBottom() } catch { /* disposed */ }
    }
    if (shouldFocus) {
      term.focus()
    }
  }, [suppressNetworkEffects, ws])

  const enqueueTerminalWrite = useCallback((data: string, onWritten?: () => void) => {
    if (!data) return
    const queue = writeQueueRef.current
    if (queue) {
      queue.enqueue(data, onWritten)
      return
    }
    const term = termRef.current
    if (!term) return
    try {
      term.write(data, onWritten)
    } catch {
      // disposed
    }
  }, [])

  const attemptOsc52ClipboardWrite = useCallback((text: string) => {
    void copyText(text).catch(() => {})
  }, [])

  const persistOsc52Policy = useCallback((policy: Osc52Policy) => {
    osc52PolicyRef.current = policy
    dispatch(updateSettingsLocal({ terminal: { osc52Clipboard: policy } }))
  }, [dispatch])

  const advanceOsc52Prompt = useCallback(() => {
    const next = osc52QueueRef.current.shift() ?? null
    pendingOsc52EventRef.current = next
    setPendingOsc52Event(next)
  }, [])

  const closeOsc52Prompt = useCallback(() => {
    pendingOsc52EventRef.current = null
    setPendingOsc52Event(null)
  }, [])

  const handleOsc52Event = useCallback((event: Osc52Event) => {
    const policy = osc52PolicyRef.current
    if (policy === 'always') {
      attemptOsc52ClipboardWrite(event.text)
      return
    }
    if (policy === 'never') {
      return
    }
    if (pendingOsc52EventRef.current) {
      osc52QueueRef.current.push(event)
      return
    }
    pendingOsc52EventRef.current = event
    setPendingOsc52Event(event)
  }, [attemptOsc52ClipboardWrite])

  const sendInput = useCallback((data: string) => {
    const tid = terminalIdRef.current
    if (!tid) return
    // In 'type' mode, clear attention when user sends input.
    // In 'click' mode, attention is cleared by the notification hook on tab switch.
    if (attentionDismissRef.current === 'type') {
      if (hasAttentionRef.current) {
        dispatch(clearTabAttention({ tabId }))
      }
      if (hasPaneAttentionRef.current) {
        dispatch(clearPaneAttention({ paneId }))
      }
    }
    if (contentRef.current?.mode === 'claude' && isClaudeTurnSubmit(data)) {
      turnCompletedSinceLastInputRef.current = false
      dispatch(setPaneRuntimeActivity({
        paneId: paneIdRef.current,
        source: 'terminal',
        phase: 'pending',
      }))
    }
    ws.send({ type: 'terminal.input', terminalId: tid, data })
  }, [dispatch, tabId, paneId, ws])

  const resetStartupProbeParser = useCallback((opts?: { discardReplayRemainder?: boolean }) => {
    const pendingProbe = startupProbeStateRef.current.pending
    if (opts?.discardReplayRemainder) {
      const remainder = getStartupProbeReplayRemainder(pendingProbe)
      startupProbeReplayDiscardStateRef.current = {
        remainder,
      }
      if (pendingProbe && !remainder) {
        return
      }
    } else {
      startupProbeReplayDiscardStateRef.current = { remainder: null }
    }
    startupProbeStateRef.current = createTerminalStartupProbeState()
  }, [])

  const handleTerminalOutput = useCallback((
    raw: string,
    mode: TerminalPaneContent['mode'],
    tid: string | undefined,
    allowReplies: boolean,
  ) => {
    const startup = extractTerminalStartupProbes(raw, startupProbeStateRef.current, {
      foreground: resolvedThemeRef.current.foreground,
      background: resolvedThemeRef.current.background,
      cursor: resolvedThemeRef.current.cursor,
    })

    if (allowReplies) {
      for (const reply of startup.replies) {
        sendInput(reply)
      }
    }

    const osc = extractOsc52Events(startup.cleaned, osc52ParserRef.current)
    const { cleaned, count } = extractTurnCompleteSignals(osc.cleaned, mode, turnCompleteSignalStateRef.current)

    if (count > 0 && tid) {
      dispatch(recordTurnComplete({
        tabId,
        paneId: paneIdRef.current,
        terminalId: tid,
        at: Date.now(),
      }))
      if (mode === 'claude') {
        dispatch(clearPaneRuntimeActivity({ paneId: paneIdRef.current }))
        turnCompletedSinceLastInputRef.current = true
      }
    }

    if (
      mode === 'claude'
      && cleaned
      && count === 0
      && !seqStateRef.current.pendingReplay
      && !turnCompletedSinceLastInputRef.current
    ) {
      dispatch(setPaneRuntimeActivity({
        paneId: paneIdRef.current,
        source: 'terminal',
        phase: 'working',
      }))
    }

    if (cleaned) {
      enqueueTerminalWrite(cleaned)
    }

    for (const event of osc.events) {
      handleOsc52Event(event)
    }
  }, [dispatch, enqueueTerminalWrite, handleOsc52Event, sendInput, tabId])

  const findNext = useCallback((value: string = searchQuery) => {
    const terminalId = terminalIdRef.current
    const query = value.trim()
    if (!terminalId || !query) return
    if (terminalSearchState?.query !== query || terminalSearchState.loading) {
      void dispatch(loadTerminalSearch({ terminalId, query }) as any).catch(() => {})
      return
    }
    void dispatch(focusNextTerminalSearchMatch(terminalId) as any)
  }, [dispatch, searchQuery, terminalSearchState?.loading, terminalSearchState?.query])

  const findPrevious = useCallback((value: string = searchQuery) => {
    const terminalId = terminalIdRef.current
    const query = value.trim()
    if (!terminalId || !query) return
    if (terminalSearchState?.query !== query || terminalSearchState.loading) {
      void dispatch(loadTerminalSearch({ terminalId, query }) as any).catch(() => {})
      return
    }
    void dispatch(focusPreviousTerminalSearchMatch(terminalId) as any)
  }, [dispatch, searchQuery, terminalSearchState?.loading, terminalSearchState?.query])

  const handleSearchQueryChange = useCallback((value: string) => {
    setSearchQuery(value)
    const terminalId = terminalIdRef.current
    if (!terminalId) return
    void dispatch(loadTerminalSearch({ terminalId, query: value }) as any).catch(() => {})
  }, [dispatch])

  const closeSearch = useCallback(() => {
    setSearchOpen(false)
    setSearchQuery('')
    const terminalId = terminalIdRef.current
    if (terminalId) {
      void dispatch(loadTerminalSearch({ terminalId, query: '' }) as any).catch(() => {})
    }
    requestAnimationFrame(() => {
      termRef.current?.focus()
    })
  }, [dispatch])

  const sendMobileToolbarKey = useCallback((keyId: MobileToolbarKeyId) => {
    if (keyId === 'ctrl') {
      setMobileCtrlActive((prev) => {
        const next = !prev
        mobileCtrlActiveRef.current = next
        return next
      })
      return
    }

    const input = resolveMobileToolbarInput(keyId, mobileCtrlActiveRef.current)
    sendInput(input)
    termRef.current?.focus()
  }, [sendInput])

  const clearMobileToolbarRepeat = useCallback(() => {
    if (mobileKeyRepeatDelayTimerRef.current) {
      clearTimeout(mobileKeyRepeatDelayTimerRef.current)
      mobileKeyRepeatDelayTimerRef.current = null
    }
    if (mobileKeyRepeatIntervalRef.current) {
      clearInterval(mobileKeyRepeatIntervalRef.current)
      mobileKeyRepeatIntervalRef.current = null
    }
  }, [])

  const handleMobileToolbarPointerDown = useCallback((event: ReactPointerEvent<HTMLButtonElement>, keyId: MobileToolbarKeyId) => {
    if (!isRepeatableMobileToolbarKey(keyId)) return

    event.preventDefault()
    event.stopPropagation()
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // Ignore capture failures (e.g. unsupported pointer source)
    }
    sendMobileToolbarKey(keyId)
    clearMobileToolbarRepeat()
    mobileKeyRepeatDelayTimerRef.current = setTimeout(() => {
      mobileKeyRepeatIntervalRef.current = setInterval(() => {
        sendMobileToolbarKey(keyId)
      }, MOBILE_KEY_REPEAT_INTERVAL_MS)
    }, MOBILE_KEY_REPEAT_INITIAL_DELAY_MS)
  }, [clearMobileToolbarRepeat, sendMobileToolbarKey])

  const handleMobileToolbarPointerEnd = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault()
    event.stopPropagation()
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    clearMobileToolbarRepeat()
  }, [clearMobileToolbarRepeat])

  const handleMobileToolbarClick = useCallback((event: ReactMouseEvent<HTMLButtonElement>, keyId: MobileToolbarKeyId) => {
    // Pointer interactions are handled via pointerdown to support press-and-hold repeat.
    // Keep click handling for non-repeatable keys and keyboard activation (detail === 0).
    if (isRepeatableMobileToolbarKey(keyId) && event.detail !== 0) return
    sendMobileToolbarKey(keyId)
  }, [sendMobileToolbarKey])

  const handleMobileToolbarContextMenu = useCallback((event: ReactMouseEvent<HTMLButtonElement>, keyId: MobileToolbarKeyId) => {
    if (!isRepeatableMobileToolbarKey(keyId)) return
    event.preventDefault()
    event.stopPropagation()
  }, [])

  const queuePaneSplit = useCallback((newContent: PaneContentInput) => {
    deferTerminalPointerMutation(() => {
      dispatch(splitPane({
        tabId,
        paneId,
        direction: 'horizontal',
        newContent,
      }))
    })
  }, [dispatch, paneId, tabId])

  useEffect(() => {
    return () => {
      clearMobileToolbarRepeat()
    }
  }, [clearMobileToolbarRepeat])

  // Init xterm once
  useEffect(() => {
    if (!isTerminal) return
    if (!containerRef.current) return
    if (mountedRef.current && termRef.current) return
    mountedRef.current = true

    if (termRef.current) {
      runtimeRef.current?.dispose()
      runtimeRef.current = null
      termRef.current.dispose()
      termRef.current = null
    }

    const resolvedTheme = getTerminalTheme(settings.terminal.theme, settings.theme)
    resolvedThemeRef.current = resolvedTheme
    const term = new Terminal({
      allowProposedApi: true,
      convertEol: true,
      cursorBlink: settings.terminal.cursorBlink,
      fontSize: settings.terminal.fontSize,
      fontFamily: resolveTerminalFontFamily(settings.terminal.fontFamily),
      lineHeight: settings.terminal.lineHeight,
      scrollback: settings.terminal.scrollback,
      theme: resolvedTheme,
      minimumContrastRatio: resolveMinimumContrastRatio(resolvedTheme),
      linkHandler: {
        activate: (event: MouseEvent, uri: string) => {
          if (event.button !== 0) return
          // Only open http/https URLs. Block javascript:, data:, and other
          // potentially dangerous schemes from OSC 8 links.
          if (!/^https?:\/\//i.test(uri)) return
          if (warnExternalLinksRef.current !== false) {
            setPendingLinkUriRef.current(uri)
          } else {
            queuePaneSplit({ kind: 'browser', url: uri, devToolsOpen: false })
          }
        },
        hover: (_event: MouseEvent, text: string, _range: import('@xterm/xterm').IBufferRange) => {
          setHoveredUrl(paneId, text)
          if (wrapperRef.current) {
            wrapperRef.current.dataset.hoveredUrl = text
          }
        },
        leave: () => {
          clearHoveredUrl(paneId)
          if (wrapperRef.current) {
            delete wrapperRef.current.dataset.hoveredUrl
          }
        },
      },
    })
    const rendererMode = settings.terminal.renderer ?? 'auto'
    // OpenCode paints a dense truecolor light surface that currently renders
    // unreliably through xterm WebGL on Chrome/Windows. Keep auto mode on the
    // safer canvas path for that provider unless the user explicitly forces WebGL.
    const enableWebgl = rendererMode === 'webgl'
      || (rendererMode === 'auto' && paneContent.mode !== 'opencode')
    let runtime = createNoopRuntime()
    try {
      runtime = createTerminalRuntime({ terminal: term, enableWebgl })
      runtime.attachAddons()
    } catch {
      // Renderer/addon failures should not prevent terminal availability.
      runtime = createNoopRuntime()
    }

    termRef.current = term
    runtimeRef.current = runtime
    const writeQueue = createTerminalWriteQueue({
      write: (data, onWritten) => {
        try {
          term.write(data, onWritten)
        } catch {
          // disposed
        }
      },
    })
    writeQueueRef.current = writeQueue
    const layoutScheduler = createLayoutScheduler(flushScheduledLayout)
    layoutSchedulerRef.current = layoutScheduler

    term.open(containerRef.current)
    const requestModeBypass = registerTerminalRequestModeBypass(term, sendInput)

    // Register custom link provider for clickable local file paths
    const filePathLinkDisposable = typeof term.registerLinkProvider === 'function'
      ? term.registerLinkProvider({
        provideLinks(bufferLineNumber: number, callback: (links: import('@xterm/xterm').ILink[] | undefined) => void) {
          const bufferLine = term.buffer.active.getLine(bufferLineNumber - 1)
          if (!bufferLine) { callback(undefined); return }
          const text = bufferLine.translateToString()
          const matches = findLocalFilePaths(text)
          if (matches.length === 0) { callback(undefined); return }
          callback(matches.map((m) => ({
            range: {
              start: { x: m.startIndex + 1, y: bufferLineNumber },
              end: { x: m.endIndex, y: bufferLineNumber },
            },
            text: m.path,
            activate: (event: MouseEvent) => {
              if (event && event.button !== 0) return
              queuePaneSplit({
                kind: 'editor',
                filePath: m.path,
                language: null,
                readOnly: false,
                content: '',
                viewMode: 'source',
              })
            },
          })))
        },
      })
      : { dispose: () => {} }

    // Register custom link provider for clickable URLs in terminal output
    const urlLinkDisposable = typeof term.registerLinkProvider === 'function'
      ? term.registerLinkProvider({
        provideLinks(bufferLineNumber: number, callback: (links: import('@xterm/xterm').ILink[] | undefined) => void) {
          const bufferLine = term.buffer.active.getLine(bufferLineNumber - 1)
          if (!bufferLine) { callback(undefined); return }
          const text = bufferLine.translateToString()
          const urls = findUrls(text)
          if (urls.length === 0) { callback(undefined); return }
          callback(urls.map((m) => ({
            range: {
              start: { x: m.startIndex + 1, y: bufferLineNumber },
              end: { x: m.endIndex, y: bufferLineNumber },
            },
            text: m.url,
            activate: (event: MouseEvent) => {
              if (event && event.button !== 0) return
              if (warnExternalLinksRef.current !== false) {
                setPendingLinkUriRef.current(m.url)
              } else {
                queuePaneSplit({ kind: 'browser', url: m.url, devToolsOpen: false })
              }
            },
            hover: () => {
              setHoveredUrl(paneId, m.url)
              if (wrapperRef.current) {
                wrapperRef.current.dataset.hoveredUrl = m.url
              }
            },
            leave: () => {
              clearHoveredUrl(paneId)
              if (wrapperRef.current) {
                delete wrapperRef.current.dataset.hoveredUrl
              }
            },
          })))
        },
      })
      : { dispose: () => {} }

    const unregisterActions = registerTerminalActions(paneId, {
      copySelection: async () => {
        const selection = term.getSelection()
        if (selection) {
          await copyText(selection)
        }
      },
      paste: async () => {
        const text = await readText()
        if (!text) return
        term.paste(text)
      },
      selectAll: () => term.selectAll(),
      clearScrollback: () => term.clear(),
      reset: () => term.reset(),
      scrollToBottom: () => { try { term.scrollToBottom() } catch { /* disposed */ } },
      hasSelection: () => term.getSelection().length > 0,
      openSearch: () => setSearchOpen(true),
    })
    const unregisterCaptureHandler = registerTerminalCaptureHandler(paneId, {
      suspendWebgl: () => runtimeRef.current?.suspendWebgl?.() ?? false,
      resumeWebgl: () => {
        runtimeRef.current?.resumeWebgl?.()
      },
    })

    requestTerminalLayout({ fit: true, focus: true })

    term.onData((data) => {
      sendInput(data)
      const currentTab = tabRef.current
      const currentContent = contentRef.current
      if (currentTab) {
        const now = Date.now()
        dispatch(updateTab({ id: currentTab.id, updates: { lastInputAt: now } }))
        const resumeSessionId = currentContent?.resumeSessionId
        if (resumeSessionId && currentContent?.mode && currentContent.mode !== 'shell') {
          if (now - lastSessionActivityAtRef.current >= SESSION_ACTIVITY_THROTTLE_MS) {
            lastSessionActivityAtRef.current = now
            const provider = currentContent.mode
            dispatch(updateSessionActivity({ sessionId: resumeSessionId, provider, lastInputAt: now }))
          }
        }
      }
    })

    // When the clipboard contains an image but no text, the browser paste event
    // fires but xterm has nothing to write. CLI tools like Codex listen for the
    // raw Ctrl+V byte (\x16) to trigger a native clipboard read. Send it so
    // image paste works for CLIs running inside the terminal.
    const xtermTextarea = term.textarea
    const handleImagePaste = (e: ClipboardEvent) => {
      const hasText = e.clipboardData?.types.includes('text/plain')
      const hasImage = Array.from(e.clipboardData?.items ?? []).some(
        (item) => item.kind === 'file' && item.type.startsWith('image/'),
      )
      if (hasImage && !hasText) {
        sendInput('\x16')
      }
    }
    xtermTextarea?.addEventListener('paste', handleImagePaste)

    term.attachCustomKeyEventHandler((event) => {
      if (
        event.ctrlKey &&
        !event.shiftKey &&
        !event.altKey &&
        !event.metaKey &&
        event.type === 'keydown' &&
        event.key.toLowerCase() === 'f'
      ) {
        event.preventDefault()
        setSearchOpen(true)
        return false
      }

      // Ctrl+Shift+C to copy (ignore key repeat)
      if (event.ctrlKey && event.shiftKey && event.key === 'C' && event.type === 'keydown' && !event.repeat) {
        const selection = term.getSelection()
        if (selection) {
          void navigator.clipboard.writeText(selection).catch(() => {})
        }
        return false
      }

      if (isTerminalPasteShortcut(event)) {
        // Policy-only: block xterm key translation (for example Ctrl+V -> ^V)
        // and allow native/browser paste path to feed xterm.
        return false
      }

      const tabSwitchDirection = getTabSwitchShortcutDirection(event)
      if (tabSwitchDirection && event.type === 'keydown' && !event.repeat) {
        event.preventDefault()
        dispatch(tabSwitchDirection === 'prev' ? switchToPrevTab() : switchToNextTab())
        return false
      }

      // Ctrl+Shift+Arrow is tab reorder (handled by TabBar on window).
      // Alt+T/W is new/close tab (handled by App on window).
      // Return false so xterm doesn't consume the event and block propagation.
      if (event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey
        && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
        return false
      }
      if (getTabLifecycleAction(event)) {
        return false
      }

      // Shift+Enter -> send newline (same as Ctrl+J)
      if (event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey && event.key === 'Enter' && event.type === 'keydown' && !event.repeat) {
        event.preventDefault()
        const tid = terminalIdRef.current
        if (tid) {
          ws.send({ type: 'terminal.input', terminalId: tid, data: '\n' })
        }
        return false
      }

      // Scroll to bottom: Cmd+End (macOS) / Ctrl+End (other)
      if ((event.metaKey || event.ctrlKey) && event.code === 'End' && event.type === 'keydown' && !event.repeat) {
        event.preventDefault()
        try { term.scrollToBottom() } catch { /* disposed */ }
        return false
      }

      return true
    })

    const ro = new ResizeObserver(() => {
      if (hiddenRef.current || termRef.current !== term) return
      requestTerminalLayout({ fit: true, resize: true })
    })
    ro.observe(containerRef.current)

    const wrapperEl = wrapperRef.current
    return () => {
      requestModeBypass.dispose()
      filePathLinkDisposable?.dispose()
      urlLinkDisposable?.dispose()
      clearHoveredUrl(paneId)
      if (wrapperEl) {
        delete wrapperEl.dataset.hoveredUrl
      }
      ro.disconnect()
      xtermTextarea?.removeEventListener('paste', handleImagePaste)
      unregisterActions()
      unregisterCaptureHandler()
      if (writeQueueRef.current === writeQueue) {
        writeQueue.clear()
        writeQueueRef.current = null
      }
      if (layoutSchedulerRef.current === layoutScheduler) {
        layoutScheduler.cancel()
        layoutSchedulerRef.current = null
      }
      pendingLayoutWorkRef.current = {
        fit: false,
        resize: false,
        scrollToBottom: false,
        focus: false,
      }
      if (termRef.current === term) {
        runtime.dispose()
        runtimeRef.current = null
        term.dispose()
        termRef.current = null
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isTerminal])

  // Ref for tab to avoid re-running effects when tab changes
  const tabRef = useRef(tab)
  useEffect(() => {
    tabRef.current = tab
  }, [tab])

  // Ref for paneId to avoid stale closures in title handlers
  const paneIdRef = useRef(paneId)
  useEffect(() => {
    paneIdRef.current = paneId
  }, [paneId])

  // Track last title we set to avoid churn from spinner animations
  const lastTitleRef = useRef<string | null>(null)
  const lastTitleUpdateRef = useRef<number>(0)
  const TITLE_UPDATE_THROTTLE_MS = 2000

  // Handle xterm title changes (from terminal escape sequences)
  useEffect(() => {
    if (!isTerminal) return
    const term = termRef.current
    if (!term) return

    const disposable = term.onTitleChange((rawTitle: string) => {
      // Strip prefix noise (spinners, status chars) - everything before first letter
      const match = rawTitle.match(/[a-zA-Z]/)
      if (!match) return // No letters = all noise, ignore
      const cleanTitle = rawTitle.slice(match.index)
      if (!cleanTitle) return

      // Only update if the cleaned title actually changed
      if (cleanTitle === lastTitleRef.current) return

      // Throttle updates to avoid churn from rapid title changes (e.g., spinner animations)
      const now = Date.now()
      if (now - lastTitleUpdateRef.current < TITLE_UPDATE_THROTTLE_MS) return

      lastTitleRef.current = cleanTitle
      lastTitleUpdateRef.current = now

      // Tab and pane titles are independently guarded:
      // - Tab title gated by tab.titleSetByUser
      // - Pane title gated by paneTitleSetByUser (in the reducer)
      const currentTab = tabRef.current
      if (currentTab && !currentTab.titleSetByUser) {
        dispatch(updateTab({ id: currentTab.id, updates: { title: cleanTitle } }))
      }
      dispatch(updatePaneTitle({ tabId, paneId: paneIdRef.current, title: cleanTitle, setByUser: false }))
    })

    return () => disposable.dispose()
  }, [isTerminal, dispatch, tabId])

  const tabOrderRef = useRef(tabOrder)
  tabOrderRef.current = tabOrder
  const markAttachComplete = useCallback(() => {
    wasCreatedFreshRef.current = false
    deferredAttachStateRef.current = {
      mode: 'live',
      pendingIntent: null,
      pendingSinceSeq: 0,
    }
    const queue = getHydrationQueue()
    if (hiddenRef.current) {
      queue.onHydrationComplete(paneId)
    } else {
      queue.onActiveTabReady(tabId, tabOrderRef.current)
    }
  }, [paneId, tabId])

  const isCurrentAttachMessage = useCallback((msg: {
    type: string
    terminalId: string
    attachRequestId?: string
  }) => {
    const current = currentAttachRef.current
    if (!current) return true
    if (!msg.attachRequestId) {
      if (debugRef.current) {
        log.debug('Ignoring untagged stream message for active attach generation', {
          paneId: paneIdRef.current,
          terminalId: msg.terminalId,
          type: msg.type,
          currentAttachRequestId: current.requestId,
        })
      }
      return false
    }
    return msg.attachRequestId === current.requestId
  }, [])

  const attachTerminal = useCallback((
    tid: string,
    intent: AttachIntent,
    opts?: {
      clearViewportFirst?: boolean
      suppressNextMatchingResize?: boolean
      skipPreAttachFit?: boolean
      maxReplayBytes?: number
    },
  ) => {
    if (suppressNetworkEffects) return
    const term = termRef.current
    if (!term) return
    const runtime = runtimeRef.current
    if (runtime && !hiddenRef.current && !opts?.skipPreAttachFit) {
      try {
        runtime.fit()
      } catch {
        // disposed
      }
    }
    const cols = Math.max(2, term.cols || 80)
    const rows = Math.max(2, term.rows || 24)
    setIsAttaching(true)
    setTruncatedHistoryGap(null)

    const persistedSeq = loadTerminalCursor(tid)
    const deltaSeq = Math.max(seqStateRef.current.lastSeq, persistedSeq)
    const sinceSeq = intent === 'viewport_hydrate' ? 0 : deltaSeq

    // Startup probes must not leak across attach generations.
    resetStartupProbeParser()

    if (intent === 'viewport_hydrate') {
      if (opts?.clearViewportFirst) {
        try {
          termRef.current?.clear()
        } catch {
          // disposed
        }
      }
      // Keep persisted cursor untouched so transport reconnect can still use high-water.
      applySeqState(beginAttach(createAttachSeqState({ lastSeq: 0 })))
    } else {
      applySeqState(beginAttach(createAttachSeqState({ lastSeq: deltaSeq })))
    }

    deferredAttachStateRef.current = {
      mode: 'attaching',
      pendingIntent: intent,
      pendingSinceSeq: sinceSeq,
    }

    const attachRequestId = `${paneIdRef.current}:${++attachCounterRef.current}:${nanoid(6)}`
    currentAttachRef.current = {
      requestId: attachRequestId,
      intent,
      terminalId: tid,
      sinceSeq,
      cols,
      rows,
    }
    suppressNextMatchingResizeRef.current = opts?.suppressNextMatchingResize
      ? { terminalId: tid, cols, rows }
      : null

    ws.send({
      type: 'terminal.attach',
      terminalId: tid,
      cols,
      rows,
      sinceSeq,
      attachRequestId,
      ...(opts?.maxReplayBytes ? { maxReplayBytes: opts.maxReplayBytes } : {}),
    })
    rememberSentViewport(tid, cols, rows)
    lastSentViewportRef.current = { terminalId: tid, cols, rows }
  }, [suppressNetworkEffects, ws, applySeqState, resetStartupProbeParser])

  const runRefreshAttach = useCallback((request: PaneRefreshRequest | null | undefined) => {
    if (suppressNetworkEffects) return false
    if (!request) return false
    if (handledRefreshRequestIdRef.current === request.requestId) return true

    const tid = terminalIdRef.current
    const currentContent = contentRef.current
    if (!tid || !currentContent) return false
    if (!paneRefreshTargetMatchesContent(request.target, currentContent)) return false

    handledRefreshRequestIdRef.current = request.requestId
    ws.send({ type: 'terminal.detach', terminalId: tid })

    if (hiddenRef.current) {
      currentAttachRef.current = null
      deferredAttachStateRef.current = {
        mode: 'waiting_for_geometry',
        pendingIntent: 'viewport_hydrate',
        pendingSinceSeq: 0,
      }
      setIsAttaching(false)
    } else {
      attachTerminal(tid, 'viewport_hydrate', { clearViewportFirst: true, maxReplayBytes: TRUNCATED_REPLAY_BYTES })
    }

    dispatch(consumePaneRefreshRequest({ tabId, paneId, requestId: request.requestId }))
    return true
  }, [attachTerminal, dispatch, paneId, suppressNetworkEffects, tabId, ws])

  // Apply settings changes
  useEffect(() => {
    if (!isTerminal) return
    const term = termRef.current
    if (!term) return
    const resolvedTheme = getTerminalTheme(settings.terminal.theme, settings.theme)
    resolvedThemeRef.current = resolvedTheme
    term.options.cursorBlink = settings.terminal.cursorBlink
    term.options.fontSize = settings.terminal.fontSize
    term.options.fontFamily = resolveTerminalFontFamily(settings.terminal.fontFamily)
    term.options.lineHeight = settings.terminal.lineHeight
    term.options.scrollback = settings.terminal.scrollback
    term.options.theme = resolvedTheme
    term.options.minimumContrastRatio = resolveMinimumContrastRatio(resolvedTheme)
    if (!hiddenRef.current) {
      const deferred = deferredAttachStateRef.current
      if (deferred.mode === 'waiting_for_geometry' && deferred.pendingIntent) {
        requestTerminalLayout({ fit: true })
      } else {
        requestTerminalLayout({ fit: true, resize: true })
      }
    }
  }, [isTerminal, settings, requestTerminalLayout])

  // When becoming visible, fit and send size
  // Note: With visibility:hidden CSS, dimensions are always stable, so no RAF needed
  useEffect(() => {
    if (!isTerminal) return
    if (!hidden) {
      const tid = terminalIdRef.current
      const deferred = deferredAttachStateRef.current
      if (tid && deferred.mode === 'waiting_for_geometry' && deferred.pendingIntent) {
        // Unregister from background queue — this tab is now being directly hydrated
        if (hydrationRegisteredRef.current) {
          getHydrationQueue().unregister(paneId)
          hydrationRegisteredRef.current = false
        }
        getHydrationQueue().onActiveTabChanged(tabId, tabOrderRef.current)
        attachTerminal(tid, deferred.pendingIntent, {
          clearViewportFirst: deferred.pendingIntent === 'viewport_hydrate',
          suppressNextMatchingResize: true,
          skipPreAttachFit: true,
          ...(deferred.pendingIntent === 'viewport_hydrate' ? { maxReplayBytes: TRUNCATED_REPLAY_BYTES } : {}),
        })
        return
      }
      requestTerminalLayout({ fit: true, resize: true })
    }
  }, [hidden, isTerminal, requestTerminalLayout, attachTerminal])

  // Background hydration: triggered by the hydration queue for hidden tabs
  useEffect(() => {
    if (!backgroundHydrationTriggered) return
    setBackgroundHydrationTriggered(false)
    const tid = terminalIdRef.current
    if (!tid || !hiddenRef.current) return
    attachTerminal(tid, 'viewport_hydrate', { clearViewportFirst: true })
  }, [backgroundHydrationTriggered, attachTerminal])

  // Create or attach to backend terminal
  useEffect(() => {
    if (suppressNetworkEffects) return
    if (!isTerminal || !terminalContent) return
    const termCandidate = termRef.current
    if (!termCandidate) return
    const term = termCandidate
    turnCompleteSignalStateRef.current = createTurnCompleteSignalParserState()
    resetStartupProbeParser()
    osc52ParserRef.current = createOsc52ParserState()
    osc52QueueRef.current = []
    pendingOsc52EventRef.current = null
    setPendingOsc52Event(null)

    // NOTE: We intentionally don't destructure terminalId here.
    // We read it from terminalIdRef.current to avoid stale closures.
    const { createRequestId, mode, shell, initialCwd } = terminalContent

    let unsub = () => {}
    let unsubReconnect = () => {}

    const clearRateLimitRetry = () => {
      const retryState = rateLimitRetryRef.current
      if (retryState.timer) {
        clearTimeout(retryState.timer)
        retryState.timer = null
      }
      retryState.count = 0
    }

    const getRestoreFlag = (requestId: string) => {
      if (restoreRequestIdRef.current !== requestId) {
        restoreRequestIdRef.current = requestId
        restoreFlagRef.current = consumeTerminalRestoreRequestId(requestId)
      }
      return restoreFlagRef.current
    }

    const sendCreate = (requestId: string) => {
      const restore = getRestoreFlag(requestId)
      const resumeId = getResumeSessionIdFromRef(contentRef)
      launchAttemptRef.current = {
        requestId,
        restore,
        attachReady: false,
      }
      if (handledCreatedMessageRef.current?.requestId === requestId) {
        handledCreatedMessageRef.current = null
      }
      if (debugRef.current) log.debug('[TRACE resumeSessionId] sendCreate', {
        paneId: paneIdRef.current,
        requestId,
        resumeSessionId: resumeId,
        contentRefResumeSessionId: contentRef.current?.resumeSessionId,
        mode,
      })
      ws.send({
        type: 'terminal.create',
        requestId,
        mode,
        shell: shell || 'system',
        cwd: initialCwd,
        resumeSessionId: resumeId,
        tabId,
        paneId: paneIdRef.current,
        ...(restore ? { restore: true } : {}),
      })
    }

    const scheduleRateLimitRetry = (requestId: string) => {
      const retryState = rateLimitRetryRef.current
      if (retryState.count >= RATE_LIMIT_RETRY_MAX_ATTEMPTS) return false
      retryState.count += 1
      const delayMs = Math.min(
        RATE_LIMIT_RETRY_BASE_MS * (2 ** (retryState.count - 1)),
        RATE_LIMIT_RETRY_MAX_MS
      )
      if (retryState.timer) clearTimeout(retryState.timer)
      retryState.timer = setTimeout(() => {
        retryState.timer = null
        if (requestIdRef.current !== requestId) return
        sendCreate(requestId)
      }, delayMs)
      term.writeln(`\r\n[Rate limited - retrying in ${(delayMs / 1000).toFixed(0)}s]\r\n`)
      return true
    }

    async function ensure() {
      clearRateLimitRetry()
      // Connection is owned by App.tsx; messages will queue until ready

      const failLaunch = (message: string, restore: boolean, terminalId?: string) => {
        clearRateLimitRetry()
        setIsAttaching(false)
        currentAttachRef.current = null
        deferredAttachStateRef.current = {
          mode: 'none',
          pendingIntent: null,
          pendingSinceSeq: 0,
        }
        dispatch(clearPaneRuntimeActivity({ paneId: paneIdRef.current }))
        if (terminalId) {
          clearTerminalCursor(terminalId)
          forgetSentViewport(terminalId)
        }
        lastSentViewportRef.current = null
        terminalIdRef.current = undefined
        launchAttemptRef.current = null
        applySeqState(createAttachSeqState())
        updateContent({ terminalId: undefined, status: 'error' })
        const currentTab = tabRef.current
        if (currentTab) {
          dispatch(updateTab({ id: currentTab.id, updates: { status: 'error' } }))
        }
        const prefix = restore ? '[Restore failed]' : '[Launch failed]'
        term.writeln(`\r\n${prefix} ${message}\r\n`)
      }

      unsub = ws.onMessage((msg) => {
        const tid = terminalIdRef.current
        const reqId = requestIdRef.current

        if (msg.type === 'terminal.output' && msg.terminalId === tid) {
          if (!isCurrentAttachMessage(msg)) {
            if (debugRef.current) {
              log.debug('Ignoring stale attach generation message', {
                paneId: paneIdRef.current,
                terminalId: msg.terminalId,
                attachRequestId: msg.attachRequestId,
                currentAttachRequestId: currentAttachRef.current?.requestId,
                type: msg.type,
              })
            }
            return
          }

          if (typeof msg.seqStart !== 'number' || typeof msg.seqEnd !== 'number') {
            if (import.meta.env.DEV) {
              log.warn('Ignoring terminal.output without sequence range', {
                paneId: paneIdRef.current,
                terminalId: tid,
              })
            }
            return
          }
          const previousSeqState = seqStateRef.current
          const frameDecision = onOutputFrame(previousSeqState, {
            seqStart: msg.seqStart,
            seqEnd: msg.seqEnd,
          })
          if (!frameDecision.accept) {
            if (import.meta.env.DEV) {
              log.warn('Ignoring overlapping terminal.output sequence range', {
                paneId: paneIdRef.current,
                terminalId: tid,
                seqStart: msg.seqStart,
                seqEnd: msg.seqEnd,
                lastSeq: previousSeqState.lastSeq,
              })
            }
            return
          }

          if (tid && frameDecision.freshReset) {
            clearTerminalCursor(tid)
          }
          let raw = msg.data || ''
          const mode = contentRef.current?.mode || 'shell'
          const frameOverlapsReplay = Boolean(
            previousSeqState.pendingReplay
            && msg.seqEnd >= previousSeqState.pendingReplay.fromSeq
            && msg.seqStart <= previousSeqState.pendingReplay.toSeq,
          )
          const enteringFreshLiveOutput = !frameOverlapsReplay
            && (Boolean(previousSeqState.pendingReplay) || previousSeqState.awaitingFreshSequence)
          if (enteringFreshLiveOutput) {
            resetStartupProbeParser({ discardReplayRemainder: Boolean(previousSeqState.pendingReplay) })
          }
          raw = consumeStartupProbeReplayDiscard(raw, startupProbeReplayDiscardStateRef.current)
          handleTerminalOutput(raw, mode, tid, !frameOverlapsReplay)
          if (
            raw.length > 0
            && !terminalFirstOutputMarkedRef.current
            && activeTabId === tabId
            && activePaneId === paneId
            && !hiddenRef.current
          ) {
            getInstalledPerfAuditBridge()?.mark('terminal.first_output', {
              tabId,
              paneId,
              terminalId: tid,
            })
            terminalFirstOutputMarkedRef.current = true
          }
          applySeqState(frameDecision.state, { terminalId: tid, persistCursor: true })
          const completedAttachOnFrame = !frameDecision.state.pendingReplay
            && (Boolean(previousSeqState.pendingReplay) || previousSeqState.awaitingFreshSequence)
          if (completedAttachOnFrame) {
            if (frameOverlapsReplay) {
              resetStartupProbeParser({ discardReplayRemainder: true })
            }
            setIsAttaching(false)
            markAttachComplete()
          }
        }

        if (msg.type === 'terminal.output.gap' && msg.terminalId === tid) {
          if (!isCurrentAttachMessage(msg)) {
            if (debugRef.current) {
              log.debug('Ignoring stale attach generation message', {
                paneId: paneIdRef.current,
                terminalId: msg.terminalId,
                attachRequestId: msg.attachRequestId,
                currentAttachRequestId: currentAttachRef.current?.requestId,
                type: msg.type,
              })
            }
            return
          }

          // Only show "load more" when the server confirms the gap is from
          // byte-budget truncation (recoverable), not ring overflow (data gone).
          const isTruncatedReplay = msg.reason === 'replay_budget_exceeded'
            && seqStateRef.current.pendingReplay
          if (isTruncatedReplay) {
            setTruncatedHistoryGap({ fromSeq: msg.fromSeq, toSeq: msg.toSeq })
          } else {
            const reason = msg.reason === 'replay_window_exceeded'
              ? 'reconnect window exceeded'
              : 'slow link backlog'
            try {
              term.writeln(`\r\n[Output gap ${msg.fromSeq}-${msg.toSeq}: ${reason}]\r\n`)
            } catch {
              // disposed
            }
          }
          const previousSeqState = seqStateRef.current
          const nextSeqState = onOutputGap(previousSeqState, { fromSeq: msg.fromSeq, toSeq: msg.toSeq })
          applySeqState(nextSeqState, { terminalId: tid, persistCursor: true })
          const completedAttachOnGap = !nextSeqState.pendingReplay
            && (Boolean(previousSeqState.pendingReplay) || previousSeqState.awaitingFreshSequence)
          if (completedAttachOnGap) {
            resetStartupProbeParser({ discardReplayRemainder: Boolean(previousSeqState.pendingReplay) })
            setIsAttaching(false)
            markAttachComplete()
          }
        }

        if (msg.type === 'terminal.attach.ready' && msg.terminalId === tid) {
          if (!isCurrentAttachMessage(msg)) {
            if (debugRef.current) {
              log.debug('Ignoring stale attach generation message', {
                paneId: paneIdRef.current,
                terminalId: msg.terminalId,
                attachRequestId: msg.attachRequestId,
                currentAttachRequestId: currentAttachRef.current?.requestId,
                type: msg.type,
              })
            }
            return
          }

          if (launchAttemptRef.current?.terminalId === tid) {
            launchAttemptRef.current = {
              ...launchAttemptRef.current,
              attachReady: true,
            }
          }

          const nextSeqState = onAttachReady(seqStateRef.current, {
            headSeq: msg.headSeq,
            replayFromSeq: msg.replayFromSeq,
            replayToSeq: msg.replayToSeq,
          })
          applySeqState(nextSeqState, {
            terminalId: tid,
            persistCursor: !nextSeqState.pendingReplay,
          })
          setIsAttaching(Boolean(nextSeqState.pendingReplay))
          updateContent({ status: 'running' })
          if (!nextSeqState.pendingReplay) {
            markAttachComplete()
          }
        }

        if (msg.type === 'terminal.created' && msg.requestId === reqId) {
          clearRateLimitRetry()
          const newId = msg.terminalId as string
          const handled = handledCreatedMessageRef.current
          if (handled?.requestId === reqId && handled.terminalId === newId) {
            if (debugRef.current) {
              log.debug('Ignoring duplicate terminal.created for handled request', {
                paneId: paneIdRef.current,
                requestId: reqId,
                terminalId: newId,
              })
            }
            return
          }
          handledCreatedMessageRef.current = {
            requestId: reqId,
            terminalId: newId,
          }
          const pendingLaunch = launchAttemptRef.current
          launchAttemptRef.current = {
            requestId: reqId,
            terminalId: newId,
            restore: pendingLaunch?.requestId === reqId ? pendingLaunch.restore : false,
            attachReady: false,
          }
          currentAttachRef.current = null
          if (debugRef.current) log.debug('[TRACE resumeSessionId] terminal.created received', {
            paneId: paneIdRef.current,
            requestId: reqId,
            terminalId: newId,
            effectiveResumeSessionId: msg.effectiveResumeSessionId,
            currentResumeSessionId: contentRef.current?.resumeSessionId,
            willUpdate: !!(msg.effectiveResumeSessionId && msg.effectiveResumeSessionId !== contentRef.current?.resumeSessionId),
          })
          terminalIdRef.current = newId
          updateContent({ terminalId: newId, status: 'running' })
          // Also update tab status
          const currentTab = tabRef.current
          if (currentTab) {
            dispatch(updateTab({ id: currentTab.id, updates: { status: 'running' } }))
          }
          if (msg.effectiveResumeSessionId && msg.effectiveResumeSessionId !== contentRef.current?.resumeSessionId) {
            updateContent({ resumeSessionId: msg.effectiveResumeSessionId })
          }

          applySeqState(createAttachSeqState({ lastSeq: 0 }))
          if (hiddenRef.current) {
            deferredAttachStateRef.current = {
              mode: 'waiting_for_geometry',
              pendingIntent: 'viewport_hydrate',
              pendingSinceSeq: 0,
            }
            setIsAttaching(false)
          } else {
            attachTerminal(newId, 'viewport_hydrate', { clearViewportFirst: true })
          }
        }

        if (msg.type === 'terminal.exit' && msg.terminalId === tid) {
          const launchAttempt = launchAttemptRef.current
          const exitedDuringLaunch = launchAttempt?.terminalId === tid && !launchAttempt.attachReady
          if (exitedDuringLaunch) {
            const exitSuffix = typeof msg.exitCode === 'number' ? ` (exit ${msg.exitCode})` : ''
            const message = launchAttempt.restore
              ? `The restored terminal exited before it finished starting${exitSuffix}. Fix the underlying CLI or working directory, then refresh to retry.`
              : `The terminal exited before it finished starting${exitSuffix}. Fix the underlying CLI or working directory, then retry.`
            failLaunch(message, launchAttempt.restore, tid)
            return
          }

          launchAttemptRef.current = null
          currentAttachRef.current = null
          deferredAttachStateRef.current = {
            mode: 'none',
            pendingIntent: null,
            pendingSinceSeq: 0,
          }
          dispatch(clearPaneRuntimeActivity({ paneId: paneIdRef.current }))
          clearTerminalCursor(tid)
          forgetSentViewport(tid)
          lastSentViewportRef.current = null
          // Clear terminalIdRef AND the stored terminalId to prevent any subsequent
          // operations (resize, input) from sending commands to the dead terminal,
          // which would trigger INVALID_TERMINAL_ID and cause a reconnection loop.
          // We must clear both the ref AND the Redux state because the ref sync effect
          // would otherwise reset the ref from the Redux state on re-render.
          terminalIdRef.current = undefined
          applySeqState(createAttachSeqState())
          updateContent({ terminalId: undefined, status: 'exited' })
          const exitTab = tabRef.current
          if (exitTab) {
            const code = typeof msg.exitCode === 'number' ? msg.exitCode : undefined
            // Only modify title if user hasn't manually set it
            const updates: { status: 'exited'; title?: string } = { status: 'exited' }
            if (!exitTab.titleSetByUser) {
              updates.title = exitTab.title + (code !== undefined ? ` (exit ${code})` : '')
            }
            dispatch(updateTab({ id: exitTab.id, updates }))
          }
        }

        // Auto-update title from Claude session
        // Tab and pane titles are independently guarded
        if (msg.type === 'terminal.title.updated' && msg.terminalId === tid && msg.title) {
          const titleTab = tabRef.current
          if (titleTab && !titleTab.titleSetByUser) {
            dispatch(updateTab({ id: titleTab.id, updates: { title: msg.title } }))
          }
          dispatch(updatePaneTitle({ tabId, paneId: paneIdRef.current, title: msg.title, setByUser: false }))
        }

        // Handle one-time session association (when Claude creates a new session)
        // Message type: { type: 'terminal.session.associated', terminalId: string, sessionId: string }
        if (msg.type === 'terminal.session.associated' && msg.terminalId === tid) {
          const sessionId = msg.sessionId as string
          if (debugRef.current) log.debug('[TRACE resumeSessionId] terminal.session.associated', {
            paneId: paneIdRef.current,
            terminalId: tid,
            oldResumeSessionId: contentRef.current?.resumeSessionId,
            newResumeSessionId: sessionId,
          })
          const mode = contentRef.current?.mode
          const sessionRef = mode && mode !== 'shell'
            ? {
              provider: mode,
              sessionId,
              ...(localServerInstanceId ? { serverInstanceId: localServerInstanceId } : {}),
            }
            : undefined
          updateContent({
            resumeSessionId: sessionId,
            ...(sessionRef ? { sessionRef } : {}),
          })
          // Mirror to tab so TabContent can reconstruct correct default
          // content if pane layout is lost (e.g., localStorage quota error)
          const currentTab = tabRef.current
          if (currentTab) {
            dispatch(updateTab({ id: currentTab.id, updates: { resumeSessionId: sessionId } }))
          }
        }

        if (msg.type === 'error' && msg.requestId === reqId) {
          if (msg.code === 'RATE_LIMITED') {
            const scheduled = scheduleRateLimitRetry(reqId)
            if (scheduled) {
              return
            }
          }
          const launchAttempt = launchAttemptRef.current?.requestId === reqId
            ? launchAttemptRef.current
            : null
          launchAttemptRef.current = null
          clearRateLimitRetry()
          setIsAttaching(false)
          dispatch(clearPaneRuntimeActivity({ paneId: paneIdRef.current }))
          updateContent({ status: 'error' })
          const currentTab = tabRef.current
          if (currentTab) {
            dispatch(updateTab({ id: currentTab.id, updates: { status: 'error' } }))
          }
          const prefix = launchAttempt
            ? (launchAttempt.restore ? '[Restore failed]' : '[Launch failed]')
            : '[Error]'
          term.writeln(`\r\n${prefix} ${msg.message || msg.code || 'Unknown error'}\r\n`)
        }

        if (msg.type === 'error' && msg.code === 'INVALID_TERMINAL_ID' && !msg.requestId) {
          const currentTerminalId = terminalIdRef.current
          const current = contentRef.current
          const launchAttempt = launchAttemptRef.current
          if (debugRef.current) log.debug('[TRACE resumeSessionId] INVALID_TERMINAL_ID received', {
            paneId: paneIdRef.current,
            msgTerminalId: msg.terminalId,
            currentTerminalId,
            currentResumeSessionId: current?.resumeSessionId,
            currentStatus: current?.status,
          })
          if (msg.terminalId && msg.terminalId !== currentTerminalId) {
            // Show feedback if the terminal already exited (the ID was cleared by
            // the exit handler, so msg.terminalId no longer matches the ref)
            if (current?.status === 'exited') {
              term.writeln('\r\n[Terminal exited - use the + button or split to start a new session]\r\n')
            }
            return
          }
          const failedDuringLaunch = Boolean(
            launchAttempt
            && currentTerminalId
            && launchAttempt.terminalId === currentTerminalId
            && launchAttempt.terminalId === msg.terminalId
            && !launchAttempt.attachReady
          )
          if (failedDuringLaunch) {
            failLaunch(msg.message || 'The terminal failed before it finished starting.', launchAttempt!.restore, currentTerminalId)
            return
          }
          // Only auto-reconnect if terminal hasn't already exited.
          // This prevents an infinite respawn loop when terminals fail immediately
          // (e.g., due to permission errors on cwd). User must explicitly restart.
          if (currentTerminalId && current?.status !== 'exited') {
            term.writeln('\r\n[Reconnecting...]\r\n')
            const newRequestId = nanoid()
            if (debugRef.current) log.debug('[TRACE resumeSessionId] INVALID_TERMINAL_ID reconnecting', {
              paneId: paneIdRef.current,
              oldRequestId: requestIdRef.current,
              newRequestId,
              resumeSessionId: current?.resumeSessionId,
            })
            // Any INVALID_TERMINAL_ID reconnect is restoring a terminal that existed
            // before the server lost state. Always mark it as restore so the
            // subsequent terminal.create bypasses the server's rate limit.
            // Consume the old ID's flag (if any) to clean up the set, but mark the
            // new request regardless — non-restore terminals also need rate-limit
            // bypass when burst-reconnecting after a server restart.
            consumeTerminalRestoreRequestId(requestIdRef.current)
            addTerminalRestoreRequestId(newRequestId)
            requestIdRef.current = newRequestId
            clearTerminalCursor(currentTerminalId)
            forgetSentViewport(currentTerminalId)
            lastSentViewportRef.current = null
            terminalIdRef.current = undefined
            deferredAttachStateRef.current = {
              mode: 'none',
              pendingIntent: null,
              pendingSinceSeq: 0,
            }
            applySeqState(createAttachSeqState())
            updateContent({ terminalId: undefined, createRequestId: newRequestId, status: 'creating' })
            const currentTab = tabRef.current
            if (currentTab) {
              dispatch(updateTab({ id: currentTab.id, updates: { status: 'creating' } }))
            }
          } else if (current?.status === 'exited') {
            term.writeln('\r\n[Terminal exited - use the + button or split to start a new session]\r\n')
          }
        }
      })

      unsubReconnect = ws.onReconnect(() => {
        const tid = terminalIdRef.current
        if (debugRef.current) log.debug('[TRACE resumeSessionId] onReconnect', {
          paneId: paneIdRef.current,
          terminalId: tid,
          resumeSessionId: contentRef.current?.resumeSessionId,
        })
        if (!tid) return
        if (hiddenRef.current) {
          deferredAttachStateRef.current = deferredAttachStateRef.current.mode === 'live'
            ? { mode: 'waiting_for_geometry', pendingIntent: 'transport_reconnect', pendingSinceSeq: seqStateRef.current.lastSeq }
            : { mode: 'waiting_for_geometry', pendingIntent: 'viewport_hydrate', pendingSinceSeq: 0 }
          return
        }
        attachTerminal(tid, 'transport_reconnect')
      })

      // Use paneContent for terminal lifecycle - NOT tab
      // Read terminalId from REF (not from destructured value) to get current value
      // This is critical: we want the effect to run once per createRequestId,
      // not re-run when terminalId changes from undefined to defined
      const currentTerminalId = terminalIdRef.current

      if (debugRef.current) log.debug('[TRACE resumeSessionId] effect initial decision', {
        paneId: paneIdRef.current,
        currentTerminalId,
        createRequestId,
        resumeSessionId: contentRef.current?.resumeSessionId,
        refreshRequestId: refreshRequestRef.current?.requestId,
        action: currentTerminalId
          ? (refreshRequestRef.current
            ? 'refresh_attach'
            : (deferredAttachStateRef.current.mode === 'live' ? 'keepalive_delta' : 'viewport_hydrate'))
          : 'sendCreate',
      })
      if (currentTerminalId && runRefreshAttach(refreshRequestRef.current)) {
        return
      }

      if (currentTerminalId) {
        if (hiddenRef.current) {
          deferredAttachStateRef.current = deferredAttachStateRef.current.mode === 'live'
            ? { mode: 'waiting_for_geometry', pendingIntent: 'transport_reconnect', pendingSinceSeq: seqStateRef.current.lastSeq }
            : { mode: 'waiting_for_geometry', pendingIntent: 'viewport_hydrate', pendingSinceSeq: 0 }
          setIsAttaching(false)

          // Register with hydration queue for progressive background hydration
          if (!hydrationRegisteredRef.current && deferredAttachStateRef.current.pendingIntent === 'viewport_hydrate') {
            hydrationRegisteredRef.current = true
            const setBgTriggered = setBackgroundHydrationTriggered
            getHydrationQueue().register({
              tabId,
              paneId: paneIdRef.current,
              trigger: () => setBgTriggered(true),
            })
          }
        } else {
          const intent: AttachIntent = deferredAttachStateRef.current.mode === 'live'
            ? 'keepalive_delta'
            : 'viewport_hydrate'
          attachTerminal(currentTerminalId, intent, intent === 'viewport_hydrate' ? { maxReplayBytes: TRUNCATED_REPLAY_BYTES } : undefined)
        }
      } else {
        deferredAttachStateRef.current = {
          mode: 'none',
          pendingIntent: null,
          pendingSinceSeq: 0,
        }
        sendCreate(createRequestId)
      }
    }

    ensure()

    return () => {
      clearRateLimitRetry()
      unsub()
      unsubReconnect()
      if (hydrationRegisteredRef.current) {
        getHydrationQueue().unregister(paneIdRef.current)
        hydrationRegisteredRef.current = false
      }
    }
  // Dependencies explanation:
  // - isTerminal: skip effect for non-terminal panes
  // - paneId: unique identifier for this pane instance
  // - terminalContent?.createRequestId: re-run when createRequestId changes (reconnect after INVALID_TERMINAL_ID)
  // - updateContent: stable callback (uses refs internally)
  // - ws: WebSocket client instance
  //
  // NOTE: terminalId is intentionally NOT in dependencies!
  // - On fresh creation: terminalId=undefined, we create, handler sets terminalId
  //   Effect should NOT re-run (handler already attached)
  // - On hydration: terminalId from storage, we attach once
  // - On reconnect: createRequestId changes, effect re-runs, terminalId is undefined, we create
  // We read terminalId from terminalIdRef.current to get the current value without triggering re-runs
  //
  // NOTE: tab is intentionally NOT in dependencies - we use tabRef to avoid re-attaching
  // when tab properties (like title) change
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    isTerminal,
    paneId,
    suppressNetworkEffects,
    terminalContent?.createRequestId,
    updateContent,
    ws,
    dispatch,
    handleTerminalOutput,
    attachTerminal,
    markAttachComplete,
    resetStartupProbeParser,
    runRefreshAttach,
  ])

  useEffect(() => {
    if (!hasMountedRefreshEffectRef.current) {
      hasMountedRefreshEffectRef.current = true
      return
    }
    if (!isTerminal || !refreshRequest) return
    runRefreshAttach(refreshRequest)
  }, [isTerminal, refreshRequest, runRefreshAttach])

  const mobileToolbarBottomPx = isMobile ? keyboardInsetPx : 0
  const mobileBottomInsetPx = isMobile ? keyboardInsetPx + MOBILE_KEYBAR_HEIGHT_PX : 0
  const terminalContainerStyle = useMemo(() => {
    if (!isMobile) return undefined

    return {
      touchAction: 'none' as const,
      height: `calc(100% - ${mobileBottomInsetPx}px)`,
    }
  }, [isMobile, mobileBottomInsetPx])

  const handleLoadMoreHistory = useCallback(() => {
    const tid = terminalIdRef.current
    if (!tid) return
    setTruncatedHistoryGap(null)
    attachTerminal(tid, 'viewport_hydrate', { clearViewportFirst: true })
  }, [attachTerminal])

  // NOW we can do the conditional return - after all hooks
  if (!isTerminal || !terminalContent) {
    return null
  }

  const hasFatalConnectionError = isFatalConnectionErrorCode(connectionErrorCode)
  const showBlockingSpinner = terminalContent.status === 'creating' && !hasFatalConnectionError
  const showInlineOfflineStatus = connectionStatus !== 'ready' && !hasFatalConnectionError
  const showInlineRecoveringStatus = connectionStatus === 'ready' && isAttaching && terminalContent.status !== 'creating' && !wasCreatedFreshRef.current
  const inlineStatusMessage = showInlineOfflineStatus
    ? 'Offline: input will queue until reconnected.'
    : (showInlineRecoveringStatus ? 'Recovering terminal output...' : null)

  return (
    <div
      ref={wrapperRef}
      className={cn('h-full w-full', hidden ? 'tab-hidden' : 'tab-visible relative')}
      data-context={ContextIds.Terminal}
      data-pane-id={paneId}
      data-tab-id={tabId}
    >
      <div
        ref={containerRef}
        data-testid="terminal-xterm-container"
        className="h-full w-full"
        style={terminalContainerStyle}
        onTouchStart={isMobile ? handleMobileTouchStart : undefined}
        onTouchMove={isMobile ? handleMobileTouchMove : undefined}
        onTouchEnd={isMobile ? handleMobileTouchEnd : undefined}
        onTouchCancel={isMobile ? handleMobileTouchEnd : undefined}
      />
      {isMobile && (
        <div
          data-testid="mobile-terminal-toolbar"
          className="absolute inset-x-0 z-20 px-1 pb-1"
          style={{ bottom: `${mobileToolbarBottomPx}px` }}
        >
          <div className="flex h-8 w-full items-center gap-1 rounded-md border border-border/70 bg-background/95 p-1 shadow-sm">
            {MOBILE_TOOLBAR_KEYS.map((key) => {
              const isCtrl = key.id === 'ctrl'
              const ctrlPressed = isCtrl && mobileCtrlActive
              return (
                <button
                  key={key.id}
                  type="button"
                  className={cn(
                    'h-full min-w-0 flex-1 rounded-sm border border-border/60 px-1 text-[11px] font-medium leading-none touch-manipulation select-none',
                    key.isArrow ? 'text-[19px] font-bold' : '',
                    ctrlPressed ? 'bg-primary/20 text-primary border-primary/40' : 'bg-muted/80 text-foreground',
                  )}
                  aria-label={key.ariaLabel}
                  aria-pressed={isCtrl ? ctrlPressed : undefined}
                  onClick={(event) => handleMobileToolbarClick(event, key.id)}
                  onPointerDown={key.isArrow ? (event) => handleMobileToolbarPointerDown(event, key.id) : undefined}
                  onPointerUp={key.isArrow ? handleMobileToolbarPointerEnd : undefined}
                  onPointerCancel={key.isArrow ? handleMobileToolbarPointerEnd : undefined}
                  onPointerLeave={key.isArrow ? handleMobileToolbarPointerEnd : undefined}
                  onContextMenu={(event) => handleMobileToolbarContextMenu(event, key.id)}
                >
                  {key.label}
                </button>
              )
            })}
          </div>
        </div>
      )}
      {showBlockingSpinner && (
        <div className="absolute inset-0 flex items-center justify-center bg-background/80">
          <div className="flex flex-col items-center gap-3">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            <span className="text-sm text-muted-foreground">Starting terminal...</span>
          </div>
        </div>
      )}
      {inlineStatusMessage && (
        <div className="pointer-events-none absolute right-2 top-2 z-10" role="status" aria-live="polite">
          <span className="rounded bg-background/90 px-2 py-1 text-xs text-muted-foreground shadow-sm ring-1 ring-border/60">
            {inlineStatusMessage}
          </span>
        </div>
      )}
      {truncatedHistoryGap && (
        <div className="absolute inset-x-0 top-0 z-10 flex justify-center">
          <button
            type="button"
            className="rounded-b bg-muted/90 px-3 py-1 text-xs text-muted-foreground shadow-sm ring-1 ring-border/60 hover:bg-muted hover:text-foreground transition-colors"
            onClick={handleLoadMoreHistory}
            aria-label="Load earlier terminal history"
          >
            Load more history
          </button>
        </div>
      )}
      <ConnectionErrorOverlay />
      {searchOpen && (
        <TerminalSearchBar
          query={searchQuery}
          onQueryChange={handleSearchQueryChange}
          onFindNext={() => findNext()}
          onFindPrevious={() => findPrevious()}
          onClose={closeSearch}
          resultIndex={terminalSearchState?.activeIndex}
          resultCount={searchQuery.trim() && terminalSearchState && !terminalSearchState.loading
            ? terminalSearchState.matches.length
            : undefined}
        />
      )}
      <Osc52PromptModal
        open={pendingOsc52Event !== null}
        onYes={() => {
          if (pendingOsc52EventRef.current) {
            attemptOsc52ClipboardWrite(pendingOsc52EventRef.current.text)
          }
          advanceOsc52Prompt()
        }}
        onNo={() => {
          advanceOsc52Prompt()
        }}
        onAlways={() => {
          if (pendingOsc52EventRef.current) {
            attemptOsc52ClipboardWrite(pendingOsc52EventRef.current.text)
          }
          for (const queued of osc52QueueRef.current) {
            attemptOsc52ClipboardWrite(queued.text)
          }
          osc52QueueRef.current = []
          persistOsc52Policy('always')
          closeOsc52Prompt()
        }}
        onNever={() => {
          osc52QueueRef.current = []
          persistOsc52Policy('never')
          closeOsc52Prompt()
        }}
      />
      <ConfirmModal
        open={pendingLinkUri !== null}
        title="Open external link?"
        body={
          <>
            <p className="break-all font-mono text-xs bg-muted rounded px-2 py-1 mb-2">{pendingLinkUri}</p>
            <p>Links from terminal output could be dangerous. Only open links you trust.</p>
          </>
        }
        confirmLabel="Open link"
        onConfirm={() => {
          if (pendingLinkUri) {
            dispatch(splitPane({
              tabId,
              paneId,
              direction: 'horizontal',
              newContent: { kind: 'browser', url: pendingLinkUri, devToolsOpen: false },
            }))
          }
          setPendingLinkUri(null)
        }}
        onCancel={() => setPendingLinkUri(null)}
      />
    </div>
  )
}
