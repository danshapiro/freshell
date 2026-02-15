import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import { updateTab, switchToNextTab, switchToPrevTab } from '@/store/tabsSlice'
import { updatePaneContent, updatePaneTitle } from '@/store/panesSlice'
import { updateSessionActivity } from '@/store/sessionActivitySlice'
import { updateSettingsLocal } from '@/store/settingsSlice'
import { recordTurnComplete, clearTabAttention, clearPaneAttention } from '@/store/turnCompletionSlice'
import { api } from '@/lib/api'
import { getWsClient } from '@/lib/ws-client'
import { getTerminalTheme } from '@/lib/terminal-themes'
import { getResumeSessionIdFromRef } from '@/components/terminal-view-utils'
import { copyText, readText } from '@/lib/clipboard'
import { registerTerminalActions } from '@/lib/pane-action-registry'
import { consumeTerminalRestoreRequestId, addTerminalRestoreRequestId } from '@/lib/terminal-restore'
import { isTerminalPasteShortcut } from '@/lib/terminal-input-policy'
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
import { ContextIds } from '@/components/context-menu/context-menu-constants'
import { resolveTerminalFontFamily } from '@/lib/terminal-fonts'
import { useChunkedAttach } from '@/components/terminal/useChunkedAttach'
import { Osc52PromptModal } from '@/components/terminal/Osc52PromptModal'
import { TerminalSearchBar } from '@/components/terminal/TerminalSearchBar'
import {
  createTerminalRuntime,
  type TerminalRuntime,
} from '@/components/terminal/terminal-runtime'
import { nanoid } from 'nanoid'
import { cn } from '@/lib/utils'
import { Terminal } from '@xterm/xterm'
import { Loader2 } from 'lucide-react'
import { ConfirmModal } from '@/components/ui/confirm-modal'
import type { PaneContent, TerminalPaneContent } from '@/store/paneTypes'
import '@xterm/xterm/css/xterm.css'

const SESSION_ACTIVITY_THROTTLE_MS = 5000
const RATE_LIMIT_RETRY_MAX_ATTEMPTS = 3
const RATE_LIMIT_RETRY_BASE_MS = 250
const RATE_LIMIT_RETRY_MAX_MS = 1000

const SEARCH_DECORATIONS = {
  matchBackground: '#515C6A',
  matchOverviewRuler: '#D4AA00',
  activeMatchBackground: '#EEB04A',
  activeMatchColorOverviewRuler: '#EEB04A',
} as const

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
  }
}

interface TerminalViewProps {
  tabId: string
  paneId: string
  paneContent: PaneContent
  hidden?: boolean
}

export default function TerminalView({ tabId, paneId, paneContent, hidden }: TerminalViewProps) {
  const dispatch = useAppDispatch()
  const tab = useAppSelector((s) => s.tabs.tabs.find((t) => t.id === tabId))
  const activeTabId = useAppSelector((s) => s.tabs.activeTabId)
  const activePaneId = useAppSelector((s) => s.panes.activePane[tabId])
  const settings = useAppSelector((s) => s.settings.settings)
  const hasAttention = useAppSelector((s) => !!s.turnCompletion?.attentionByTab?.[tabId])
  const hasAttentionRef = useRef(hasAttention)
  const hasPaneAttention = useAppSelector((s) => !!s.turnCompletion?.attentionByPane?.[paneId])
  const hasPaneAttentionRef = useRef(hasPaneAttention)

  // All hooks MUST be called before any conditional returns
  const ws = useMemo(() => getWsClient(), [])
  const [isAttaching, setIsAttaching] = useState(false)
  const [pendingLinkUri, setPendingLinkUri] = useState<string | null>(null)
  const [pendingOsc52Event, setPendingOsc52Event] = useState<Osc52Event | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<{ resultIndex: number; resultCount: number } | null>(null)
  const setPendingLinkUriRef = useRef(setPendingLinkUri)

  const containerRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const runtimeRef = useRef<TerminalRuntime | null>(null)
  const mountedRef = useRef(false)
  const hiddenRef = useRef(hidden)
  const lastSessionActivityAtRef = useRef(0)
  const rateLimitRetryRef = useRef<{ count: number; timer: ReturnType<typeof setTimeout> | null }>({ count: 0, timer: null })
  const restoreRequestIdRef = useRef<string | null>(null)
  const restoreFlagRef = useRef(false)
  const turnCompleteSignalStateRef = useRef(createTurnCompleteSignalParserState())
  const osc52ParserRef = useRef(createOsc52ParserState())
  const osc52PolicyRef = useRef<Osc52Policy>(settings.terminal.osc52Clipboard)
  const pendingOsc52EventRef = useRef<Osc52Event | null>(null)
  const osc52QueueRef = useRef<Osc52Event[]>([])
  const warnExternalLinksRef = useRef(settings.terminal.warnExternalLinks)
  const debugRef = useRef(!!(settings as any).logging?.debug)
  const attentionDismissRef = useRef(settings.panes?.attentionDismiss ?? 'click')

  // Extract terminal-specific fields (safe because we check kind later)
  const isTerminal = paneContent.kind === 'terminal'
  const terminalContent = isTerminal ? paneContent : null

  // Refs for terminal lifecycle (only meaningful if isTerminal)
  // CRITICAL: Use refs to avoid callback/effect dependency on changing content
  const requestIdRef = useRef<string>(terminalContent?.createRequestId || '')
  const terminalIdRef = useRef<string | undefined>(terminalContent?.terminalId)
  const contentRef = useRef<TerminalPaneContent | null>(terminalContent)

  // Keep refs in sync with props
  useEffect(() => {
    if (terminalContent) {
      const prev = contentRef.current
      if (prev && terminalContent.resumeSessionId !== prev.resumeSessionId) {
        if (debugRef.current) console.log('[TRACE resumeSessionId] ref sync from props CHANGED resumeSessionId', {
          paneId,
          from: prev.resumeSessionId,
          to: terminalContent.resumeSessionId,
          createRequestId: terminalContent.createRequestId,
        })
      }
      terminalIdRef.current = terminalContent.terminalId
      requestIdRef.current = terminalContent.createRequestId
      contentRef.current = terminalContent
    }
  }, [terminalContent, paneId])

  useEffect(() => {
    hiddenRef.current = hidden
  }, [hidden])

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
  debugRef.current = !!(settings as any).logging?.debug

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

  // Helper to update pane content - uses ref to avoid recreation on content changes
  // This is CRITICAL: if updateContent depended on terminalContent directly,
  // it would be recreated on every status update, causing the effect to re-run
  const updateContent = useCallback((updates: Partial<TerminalPaneContent>) => {
    const current = contentRef.current
    if (!current) return
    const next = { ...current, ...updates }
    // Trace resumeSessionId changes
    if ('resumeSessionId' in updates && updates.resumeSessionId !== current.resumeSessionId) {
      if (debugRef.current) console.log('[TRACE resumeSessionId] updateContent CHANGING resumeSessionId', {
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

  const sendWsMessage = useCallback((msg: { type: 'terminal.attach'; terminalId: string }) => {
    ws.send(msg)
  }, [ws])

  const attemptOsc52ClipboardWrite = useCallback((text: string) => {
    void copyText(text).catch(() => {})
  }, [])

  const persistOsc52Policy = useCallback((policy: Osc52Policy) => {
    osc52PolicyRef.current = policy
    dispatch(updateSettingsLocal({ terminal: { osc52Clipboard: policy } } as any))
    void api.patch('/api/settings', {
      terminal: { osc52Clipboard: policy },
    }).catch(() => {})
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

  const handleTerminalSnapshot = useCallback((snapshot: string | undefined, term: Terminal) => {
    const osc = extractOsc52Events(snapshot ?? '', createOsc52ParserState())
    try { term.clear() } catch { /* disposed */ }
    if (osc.cleaned) {
      try { term.write(osc.cleaned) } catch { /* disposed */ }
    }
    for (const event of osc.events) {
      handleOsc52Event(event)
    }
  }, [handleOsc52Event])

  const handleTerminalOutput = useCallback((raw: string, mode: TerminalPaneContent['mode'], term: Terminal, tid?: string) => {
    const osc = extractOsc52Events(raw, osc52ParserRef.current)
    const { cleaned, count } = extractTurnCompleteSignals(osc.cleaned, mode, turnCompleteSignalStateRef.current)

    if (count > 0 && tid) {
      dispatch(recordTurnComplete({
        tabId,
        paneId: paneIdRef.current,
        terminalId: tid,
        at: Date.now(),
      }))
    }

    if (cleaned) {
      term.write(cleaned)
    }

    for (const event of osc.events) {
      handleOsc52Event(event)
    }
  }, [dispatch, handleOsc52Event, tabId])

  const applyChunkedSnapshot = useCallback((snapshot: string) => {
    const term = termRef.current
    if (!term) return
    handleTerminalSnapshot(snapshot, term)
  }, [handleTerminalSnapshot])

  const markChunkedRunning = useCallback(() => {
    updateContent({ status: 'running' })
  }, [updateContent])

  const {
    snapshotWarning,
    handleChunkLifecycleMessage,
    markSnapshotChunkedCreated,
    bumpConnectionGeneration,
    clearChunkedAttachState,
  } = useChunkedAttach({
    activeTerminalId: terminalContent?.terminalId,
    activeTerminalIdRef: terminalIdRef,
    setIsAttaching,
    applySnapshot: applyChunkedSnapshot,
    markRunning: markChunkedRunning,
    wsSend: sendWsMessage,
  })

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
    ws.send({ type: 'terminal.input', terminalId: tid, data })
  }, [dispatch, tabId, paneId, ws])

  const searchOpts = useMemo(() => ({
    caseSensitive: false,
    incremental: true,
    decorations: SEARCH_DECORATIONS,
  }), [])

  const findNext = useCallback((value: string = searchQuery) => {
    if (!value) return
    runtimeRef.current?.findNext(value, searchOpts)
  }, [searchQuery, searchOpts])

  const findPrevious = useCallback((value: string = searchQuery) => {
    if (!value) return
    runtimeRef.current?.findPrevious(value, searchOpts)
  }, [searchQuery, searchOpts])

  const closeSearch = useCallback(() => {
    setSearchOpen(false)
    setSearchResults(null)
    runtimeRef.current?.clearDecorations()
    requestAnimationFrame(() => {
      termRef.current?.focus()
    })
  }, [])

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

    const term = new Terminal({
      allowProposedApi: true,
      convertEol: true,
      cursorBlink: settings.terminal.cursorBlink,
      fontSize: settings.terminal.fontSize,
      fontFamily: resolveTerminalFontFamily(settings.terminal.fontFamily),
      lineHeight: settings.terminal.lineHeight,
      scrollback: settings.terminal.scrollback,
      theme: getTerminalTheme(settings.terminal.theme, settings.theme),
      linkHandler: {
        activate: (_event: MouseEvent, uri: string) => {
          if (warnExternalLinksRef.current !== false) {
            setPendingLinkUriRef.current(uri)
          } else {
            window.open(uri, '_blank', 'noopener,noreferrer')
          }
        },
      },
    })
    const rendererMode = settings.terminal.renderer ?? 'auto'
    const enableWebgl = rendererMode === 'auto' || rendererMode === 'webgl'
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

    const searchResultsDisposable = runtime.onDidChangeResults((event) => {
      setSearchResults({ resultIndex: event.resultIndex, resultCount: event.resultCount })
    })

    term.open(containerRef.current)

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
      hasSelection: () => term.getSelection().length > 0,
      openSearch: () => setSearchOpen(true),
    })

    requestAnimationFrame(() => {
      if (termRef.current === term) {
        try { runtime.fit() } catch { /* disposed */ }
        term.focus()
      }
    })

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

      // Tab switching: Ctrl+Shift+[ (prev) and Ctrl+Shift+] (next)
      if (event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey && event.type === 'keydown' && !event.repeat) {
        if (event.code === 'BracketLeft') {
          event.preventDefault()
          dispatch(switchToPrevTab())
          return false
        }
        if (event.code === 'BracketRight') {
          event.preventDefault()
          dispatch(switchToNextTab())
          return false
        }
      }

      return true
    })

    const ro = new ResizeObserver(() => {
      if (hiddenRef.current || termRef.current !== term) return
      try {
        runtime.fit()
        const tid = terminalIdRef.current
        if (tid) {
          ws.send({ type: 'terminal.resize', terminalId: tid, cols: term.cols, rows: term.rows })
        }
      } catch { /* disposed */ }
    })
    ro.observe(containerRef.current)

    return () => {
      ro.disconnect()
      unregisterActions()
      searchResultsDisposable.dispose()
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

  // Apply settings changes
  useEffect(() => {
    if (!isTerminal) return
    const term = termRef.current
    if (!term) return
    term.options.cursorBlink = settings.terminal.cursorBlink
    term.options.fontSize = settings.terminal.fontSize
    term.options.fontFamily = resolveTerminalFontFamily(settings.terminal.fontFamily)
    term.options.lineHeight = settings.terminal.lineHeight
    term.options.scrollback = settings.terminal.scrollback
    term.options.theme = getTerminalTheme(settings.terminal.theme, settings.theme)
    if (!hidden) runtimeRef.current?.fit()
  }, [isTerminal, settings, hidden])

  // When becoming visible, fit and send size
  // Note: With visibility:hidden CSS, dimensions are always stable, so no RAF needed
  useEffect(() => {
    if (!isTerminal) return
    if (!hidden) {
      runtimeRef.current?.fit()
      const term = termRef.current
      const tid = terminalIdRef.current
      if (term && tid) {
        ws.send({ type: 'terminal.resize', terminalId: tid, cols: term.cols, rows: term.rows })
      }
    }
  }, [isTerminal, hidden, ws])

  // Create or attach to backend terminal
  useEffect(() => {
    if (!isTerminal || !terminalContent) return
    const termCandidate = termRef.current
    if (!termCandidate) return
    const term = termCandidate
    turnCompleteSignalStateRef.current = createTurnCompleteSignalParserState()
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
      if (debugRef.current) console.log('[TRACE resumeSessionId] sendCreate', {
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
      term.writeln(`\r\n[Rate limited - retrying in ${delayMs}ms]\r\n`)
      return true
    }

    function attach(tid: string) {
      setIsAttaching(true)
      ws.send({ type: 'terminal.attach', terminalId: tid })
      // NOTE: Do NOT send terminal.resize here. At this point fit() hasn't run yet,
      // so term.cols/rows are xterm defaults (80×24), not the actual viewport size.
      // Sending a resize with wrong dimensions causes the PTY to resize, triggering
      // a TUI redraw at the wrong size (e.g., Codex renders 24 rows in a 40-row viewport,
      // putting the text input at the top of the pane). The correct resize is sent by:
      // - ResizeObserver callback (for visible tabs, after fit() runs)
      // - Visibility effect (for hidden tabs, when they become visible)
    }

    async function ensure() {
      clearRateLimitRetry()
      try {
        await ws.connect()
      } catch {
        // handled elsewhere
      }

      unsub = ws.onMessage((msg) => {
        const tid = terminalIdRef.current
        const reqId = requestIdRef.current

        if (handleChunkLifecycleMessage(msg)) {
          return
        }

        if (msg.type === 'terminal.output' && msg.terminalId === tid) {
          const raw = msg.data || ''
          const mode = contentRef.current?.mode || 'shell'
          handleTerminalOutput(raw, mode, term, tid)
        }

        if (msg.type === 'terminal.snapshot' && msg.terminalId === tid) {
          handleTerminalSnapshot(msg.snapshot, term)
        }

        if (msg.type === 'terminal.created' && msg.requestId === reqId) {
          clearRateLimitRetry()
          const newId = msg.terminalId as string
          if (debugRef.current) console.log('[TRACE resumeSessionId] terminal.created received', {
            paneId: paneIdRef.current,
            requestId: reqId,
            terminalId: newId,
            effectiveResumeSessionId: msg.effectiveResumeSessionId,
            currentResumeSessionId: contentRef.current?.resumeSessionId,
            willUpdate: !!(msg.effectiveResumeSessionId && msg.effectiveResumeSessionId !== contentRef.current?.resumeSessionId),
          })
          terminalIdRef.current = newId
          updateContent({ terminalId: newId, status: 'running' })
          // Also update tab for title purposes
          const currentTab = tabRef.current
          if (currentTab) {
            dispatch(updateTab({ id: currentTab.id, updates: { terminalId: newId, status: 'running' } }))
          }
          if (msg.effectiveResumeSessionId && msg.effectiveResumeSessionId !== contentRef.current?.resumeSessionId) {
            updateContent({ resumeSessionId: msg.effectiveResumeSessionId })
          }
          const isSnapshotChunked = msg.snapshotChunked === true
          if (isSnapshotChunked) {
            markSnapshotChunkedCreated()
          } else {
            handleTerminalSnapshot(msg.snapshot, term)
          }
          // Creator is already attached server-side for this terminal.
          // Avoid sending terminal.attach here: it can race with terminal.output and lead to
          // the later terminal.attached snapshot wiping already-rendered output.
          ws.send({ type: 'terminal.resize', terminalId: newId, cols: term.cols, rows: term.rows })
          if (!isSnapshotChunked) {
            setIsAttaching(false)
          }
        }

        if (msg.type === 'terminal.attached' && msg.terminalId === tid) {
          clearRateLimitRetry()
          setIsAttaching(false)
          handleTerminalSnapshot(msg.snapshot, term)
          updateContent({ status: 'running' })
        }

        if (msg.type === 'terminal.exit' && msg.terminalId === tid) {
          // Clear terminalIdRef AND the stored terminalId to prevent any subsequent
          // operations (resize, input) from sending commands to the dead terminal,
          // which would trigger INVALID_TERMINAL_ID and cause a reconnection loop.
          // We must clear both the ref AND the Redux state because the ref sync effect
          // would otherwise reset the ref from the Redux state on re-render.
          terminalIdRef.current = undefined
          updateContent({ terminalId: undefined, status: 'exited' })
          const exitTab = tabRef.current
          if (exitTab) {
            const code = typeof msg.exitCode === 'number' ? msg.exitCode : undefined
            // Only modify title if user hasn't manually set it
            const updates: { terminalId: undefined; status: 'exited'; title?: string } = { terminalId: undefined, status: 'exited' }
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
          if (debugRef.current) console.log('[TRACE resumeSessionId] terminal.session.associated', {
            paneId: paneIdRef.current,
            terminalId: tid,
            oldResumeSessionId: contentRef.current?.resumeSessionId,
            newResumeSessionId: sessionId,
          })
          updateContent({ resumeSessionId: sessionId })
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
          clearRateLimitRetry()
          setIsAttaching(false)
          updateContent({ status: 'error' })
          term.writeln(`\r\n[Error] ${msg.message || msg.code || 'Unknown error'}\r\n`)
        }

        if (msg.type === 'error' && msg.code === 'INVALID_TERMINAL_ID' && !msg.requestId) {
          const currentTerminalId = terminalIdRef.current
          const current = contentRef.current
          if (debugRef.current) console.log('[TRACE resumeSessionId] INVALID_TERMINAL_ID received', {
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
          // Only auto-reconnect if terminal hasn't already exited.
          // This prevents an infinite respawn loop when terminals fail immediately
          // (e.g., due to permission errors on cwd). User must explicitly restart.
          if (currentTerminalId && current?.status !== 'exited') {
            term.writeln('\r\n[Reconnecting...]\r\n')
            const newRequestId = nanoid()
            if (debugRef.current) console.log('[TRACE resumeSessionId] INVALID_TERMINAL_ID reconnecting', {
              paneId: paneIdRef.current,
              oldRequestId: requestIdRef.current,
              newRequestId,
              resumeSessionId: current?.resumeSessionId,
            })
            // Preserve the restore flag so the re-creation bypasses rate limiting.
            // The original createRequestId's flag was never consumed (we went
            // through attach, not sendCreate), so check the old ID first.
            const wasRestore = consumeTerminalRestoreRequestId(requestIdRef.current)
            if (wasRestore) {
              addTerminalRestoreRequestId(newRequestId)
            }
            requestIdRef.current = newRequestId
            terminalIdRef.current = undefined
            updateContent({ terminalId: undefined, createRequestId: newRequestId, status: 'creating' })
            // Also clear the tab's terminalId to keep it in sync.
            // This prevents openSessionTab from using the stale terminalId for dedup.
            const currentTab = tabRef.current
            if (currentTab) {
              dispatch(updateTab({ id: currentTab.id, updates: { terminalId: undefined, status: 'creating' } }))
            }
          } else if (current?.status === 'exited') {
            term.writeln('\r\n[Terminal exited - use the + button or split to start a new session]\r\n')
          }
        }
      })

      unsubReconnect = ws.onReconnect(() => {
        bumpConnectionGeneration()
        const tid = terminalIdRef.current
        if (debugRef.current) console.log('[TRACE resumeSessionId] onReconnect', {
          paneId: paneIdRef.current,
          terminalId: tid,
          resumeSessionId: contentRef.current?.resumeSessionId,
        })
        if (tid) attach(tid)
      })

      // Use paneContent for terminal lifecycle - NOT tab
      // Read terminalId from REF (not from destructured value) to get current value
      // This is critical: we want the effect to run once per createRequestId,
      // not re-run when terminalId changes from undefined to defined
      const currentTerminalId = terminalIdRef.current

      if (debugRef.current) console.log('[TRACE resumeSessionId] effect initial decision', {
        paneId: paneIdRef.current,
        currentTerminalId,
        createRequestId,
        resumeSessionId: contentRef.current?.resumeSessionId,
        action: currentTerminalId ? 'attach' : 'sendCreate',
      })
      if (currentTerminalId) {
        attach(currentTerminalId)
      } else {
        sendCreate(createRequestId)
      }
    }

    ensure()

    return () => {
      clearRateLimitRetry()
      unsub()
      unsubReconnect()
      clearChunkedAttachState()
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
    terminalContent?.createRequestId,
    updateContent,
    ws,
    dispatch,
    bumpConnectionGeneration,
    clearChunkedAttachState,
    handleChunkLifecycleMessage,
    handleTerminalOutput,
    handleTerminalSnapshot,
    markSnapshotChunkedCreated,
  ])

  // NOW we can do the conditional return - after all hooks
  if (!isTerminal || !terminalContent) {
    return null
  }

  const showSpinner = terminalContent.status === 'creating' || isAttaching

  return (
    <div
      className={cn('h-full w-full', hidden ? 'tab-hidden' : 'tab-visible relative')}
      data-context={ContextIds.Terminal}
      data-pane-id={paneId}
      data-tab-id={tabId}
    >
      <div ref={containerRef} className="h-full w-full" />
      {showSpinner && (
        <div className="absolute inset-0 flex items-center justify-center bg-background/80">
          <div className="flex flex-col items-center gap-3">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            <span className="text-sm text-muted-foreground">
              {terminalContent.status === 'creating' ? 'Starting terminal...' : 'Reconnecting...'}
            </span>
          </div>
        </div>
      )}
      {searchOpen && (
        <TerminalSearchBar
          query={searchQuery}
          onQueryChange={(value) => {
            setSearchQuery(value)
            findNext(value)
          }}
          onFindNext={() => findNext()}
          onFindPrevious={() => findPrevious()}
          onClose={closeSearch}
          resultIndex={searchResults?.resultIndex}
          resultCount={searchResults?.resultCount}
        />
      )}
      {snapshotWarning && (
        <div className="pointer-events-none absolute inset-x-2 bottom-2 rounded border border-amber-300 bg-amber-50/95 px-2 py-1 text-xs text-amber-900">
          {snapshotWarning}
        </div>
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
            window.open(pendingLinkUri, '_blank', 'noopener,noreferrer')
          }
          setPendingLinkUri(null)
        }}
        onCancel={() => setPendingLinkUri(null)}
      />
    </div>
  )
}
