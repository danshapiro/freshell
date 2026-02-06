import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import { switchToNextTab, switchToPrevTab } from '@/store/tabsSlice'
import { updatePaneContent, updatePaneTitle } from '@/store/panesSlice'
import { recordInput, recordOutput } from '@/store/terminalActivitySlice'
import { updateSessionActivity } from '@/store/sessionActivitySlice'
import { getWsClient } from '@/lib/ws-client'
import { getTerminalTheme } from '@/lib/terminal-themes'
import { getResumeSessionIdFromRef } from '@/components/terminal-view-utils'
import { copyText, readText, isClipboardReadAvailable } from '@/lib/clipboard'
import { registerTerminalActions } from '@/lib/pane-action-registry'
import { ContextIds } from '@/components/context-menu/context-menu-constants'
import { nanoid } from 'nanoid'
import { cn } from '@/lib/utils'
import { isCodingCliMode } from '@/lib/coding-cli-utils'
import { Terminal } from 'xterm'
import { FitAddon } from 'xterm-addon-fit'
import { Loader2 } from 'lucide-react'
import type { PaneContent, TerminalPaneContent } from '@/store/paneTypes'
import 'xterm/css/xterm.css'

const SESSION_ACTIVITY_THROTTLE_MS = 5000

interface TerminalViewProps {
  tabId: string
  paneId: string
  paneContent: PaneContent
  hidden?: boolean
}

export default function TerminalView({ tabId, paneId, paneContent, hidden }: TerminalViewProps) {
  const dispatch = useAppDispatch()
  const settings = useAppSelector((s) => s.settings.settings)

  // All hooks MUST be called before any conditional returns
  const ws = useMemo(() => getWsClient(), [])
  const [isAttaching, setIsAttaching] = useState(false)

  const containerRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const mountedRef = useRef(false)
  const hiddenRef = useRef(hidden)
  const lastSessionActivityAtRef = useRef(0)
  const lastOutputDispatchAtRef = useRef(0)

  // Throttle recordOutput dispatches to avoid performance issues with chatty terminals
  const OUTPUT_DISPATCH_THROTTLE_MS = 500

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
      terminalIdRef.current = terminalContent.terminalId
      requestIdRef.current = terminalContent.createRequestId
      contentRef.current = terminalContent
    }
  }, [terminalContent])

  useEffect(() => {
    hiddenRef.current = hidden
  }, [hidden])

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
    contentRef.current = next
    dispatch(updatePaneContent({
      tabId,
      paneId,
      content: next,
    }))
  }, [dispatch, tabId, paneId]) // NO terminalContent dependency - uses ref

  // Init xterm once
  useEffect(() => {
    if (!isTerminal) return
    if (!containerRef.current) return
    if (mountedRef.current && termRef.current) return
    mountedRef.current = true

    if (termRef.current) {
      termRef.current.dispose()
      termRef.current = null
      fitRef.current = null
    }

    const term = new Terminal({
      convertEol: true,
      cursorBlink: settings.terminal.cursorBlink,
      fontSize: settings.terminal.fontSize,
      fontFamily: settings.terminal.fontFamily,
      lineHeight: settings.terminal.lineHeight,
      scrollback: settings.terminal.scrollback,
      theme: getTerminalTheme(settings.terminal.theme, settings.theme),
    })
    const fit = new FitAddon()
    term.loadAddon(fit)

    termRef.current = term
    fitRef.current = fit

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
        const tid = terminalIdRef.current
        if (!tid) return
        ws.send({ type: 'terminal.input', terminalId: tid, data: text })
        dispatch(recordInput({ paneId }))
        // Update session activity for sidebar sorting
        const now = Date.now()
        const sessionId = contentRef.current?.resumeSessionId
        const mode = contentRef.current?.mode
        if (sessionId && mode && isCodingCliMode(mode)) {
          if (now - lastSessionActivityAtRef.current >= SESSION_ACTIVITY_THROTTLE_MS) {
            lastSessionActivityAtRef.current = now
            dispatch(updateSessionActivity({ sessionId, provider: mode, lastInputAt: now }))
          }
        }
      },
      selectAll: () => term.selectAll(),
      clearScrollback: () => term.clear(),
      reset: () => term.reset(),
      hasSelection: () => term.getSelection().length > 0,
    })

    requestAnimationFrame(() => {
      if (termRef.current === term) {
        try { fit.fit() } catch { /* disposed */ }
        term.focus()
      }
    })

    term.onData((data) => {
      const tid = terminalIdRef.current
      if (!tid) return
      ws.send({ type: 'terminal.input', terminalId: tid, data })

      // Track input for activity monitoring (to filter out echo)
      dispatch(recordInput({ paneId }))

      const now = Date.now()
      const sessionId = contentRef.current?.resumeSessionId
      const mode = contentRef.current?.mode
      if (sessionId && mode && isCodingCliMode(mode)) {
        if (now - lastSessionActivityAtRef.current >= SESSION_ACTIVITY_THROTTLE_MS) {
          lastSessionActivityAtRef.current = now
          dispatch(updateSessionActivity({ sessionId, provider: mode, lastInputAt: now }))
        }
      }
    })

    term.attachCustomKeyEventHandler((event) => {
      // Ctrl+Shift+C to copy (ignore key repeat)
      if (event.ctrlKey && event.shiftKey && event.key === 'C' && event.type === 'keydown' && !event.repeat) {
        const selection = term.getSelection()
        if (selection) {
          void copyText(selection)
        }
        return false
      }

      // Ctrl+V or Ctrl+Shift+V to paste
      // Only intercept if clipboard API is available (secure context required)
      // Otherwise, let the browser handle paste natively via paste event
      if (event.ctrlKey && (event.key === 'v' || event.key === 'V') && event.type === 'keydown' && !event.repeat) {
        if (isClipboardReadAvailable()) {
          void readText().then((text) => {
            if (!text) return
            const tid = terminalIdRef.current
            if (!tid) return
            ws.send({ type: 'terminal.input', terminalId: tid, data: text })
            dispatch(recordInput({ paneId }))
            // Update session activity for sidebar sorting
            const now = Date.now()
            const sessionId = contentRef.current?.resumeSessionId
            const mode = contentRef.current?.mode
            if (sessionId && mode && isCodingCliMode(mode)) {
              if (now - lastSessionActivityAtRef.current >= SESSION_ACTIVITY_THROTTLE_MS) {
                lastSessionActivityAtRef.current = now
                dispatch(updateSessionActivity({ sessionId, provider: mode, lastInputAt: now }))
              }
            }
          })
          return false
        }
        // Non-secure context: return false to prevent xterm from processing
        // Ctrl+V (which sends ^V and cancels the event). This allows the
        // browser's native paste event to fire.
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
        fit.fit()
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
      if (termRef.current === term) {
        term.dispose()
        termRef.current = null
        fitRef.current = null
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isTerminal])

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

      dispatch(updatePaneTitle({ tabId, paneId: paneIdRef.current, title: cleanTitle }))
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
    term.options.fontFamily = settings.terminal.fontFamily
    term.options.lineHeight = settings.terminal.lineHeight
    term.options.scrollback = settings.terminal.scrollback
    term.options.theme = getTerminalTheme(settings.terminal.theme, settings.theme)
    if (!hidden) fitRef.current?.fit()
  }, [isTerminal, settings, hidden])

  // When becoming visible, fit and send size
  // Note: With visibility:hidden CSS, dimensions are always stable, so no RAF needed
  useEffect(() => {
    if (!isTerminal) return
    if (!hidden) {
      fitRef.current?.fit()
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
    const xterm = termRef.current
    if (!xterm) return
    // TS doesn't preserve outer-scope null narrowing inside closures; capture a non-null instance.
    const xtermApi = xterm

    // NOTE: We intentionally don't destructure terminalId here.
    // We read it from terminalIdRef.current to avoid stale closures.
    const { createRequestId, mode, shell, initialCwd } = terminalContent

    let unsub = () => {}
    let unsubReconnect = () => {}

    function attach(tid: string) {
      setIsAttaching(true)
      ws.send({ type: 'terminal.attach', terminalId: tid })
      ws.send({ type: 'terminal.resize', terminalId: tid, cols: xtermApi.cols, rows: xtermApi.rows })
    }

    async function ensure() {
      try {
        await ws.connect()
      } catch { /* handled elsewhere */ }

      unsub = ws.onMessage((msg) => {
        const tid = terminalIdRef.current
        const reqId = requestIdRef.current

        if (msg.type === 'terminal.output' && msg.terminalId === tid) {
          xtermApi.write(msg.data || '')
          // Throttle recordOutput dispatches to avoid performance issues with chatty terminals
          const now = Date.now()
          if (now - lastOutputDispatchAtRef.current >= OUTPUT_DISPATCH_THROTTLE_MS) {
            lastOutputDispatchAtRef.current = now
            dispatch(recordOutput({ paneId }))
          }
        }

        if (msg.type === 'terminal.snapshot' && msg.terminalId === tid) {
          try { xtermApi.clear() } catch {}
          if (msg.snapshot) {
            try { xtermApi.write(msg.snapshot) } catch {}
          }
        }

        if (msg.type === 'terminal.created' && msg.requestId === reqId) {
          const newId = msg.terminalId as string
          terminalIdRef.current = newId
          updateContent({ terminalId: newId, status: 'running' })
          if (msg.snapshot) {
            try { xtermApi.clear(); xtermApi.write(msg.snapshot) } catch {}
          }
          attach(newId)
        }

        if (msg.type === 'terminal.attached' && msg.terminalId === tid) {
          setIsAttaching(false)
          if (msg.snapshot) {
            try { xtermApi.clear(); xtermApi.write(msg.snapshot) } catch {}
          }
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
        }

        // Auto-update title from Claude session (only if user hasn't manually set it)
        if (msg.type === 'terminal.title.updated' && msg.terminalId === tid) {
          if (msg.title) {
            dispatch(updatePaneTitle({ tabId, paneId: paneIdRef.current, title: msg.title }))
          }
        }

        // Handle one-time session association (when Claude creates a new session)
        // Message type: { type: 'terminal.session.associated', terminalId: string, sessionId: string }
        if (msg.type === 'terminal.session.associated' && msg.terminalId === tid) {
          const sessionId = msg.sessionId as string
          updateContent({ resumeSessionId: sessionId })
        }

        if (msg.type === 'error' && msg.requestId === reqId) {
          setIsAttaching(false)
          updateContent({ status: 'error' })
          xtermApi.writeln(`\r\n[Error] ${msg.message || msg.code || 'Unknown error'}\r\n`)
        }

        if (msg.type === 'error' && msg.code === 'INVALID_TERMINAL_ID' && !msg.requestId) {
          const currentTerminalId = terminalIdRef.current
          if (msg.terminalId && msg.terminalId !== currentTerminalId) {
            return
          }
          if (currentTerminalId) {
            xtermApi.writeln('\r\n[Reconnecting...]\r\n')
            const newRequestId = nanoid()
            requestIdRef.current = newRequestId
            terminalIdRef.current = undefined
            updateContent({ terminalId: undefined, createRequestId: newRequestId, status: 'creating' })
          }
        }
      })

      unsubReconnect = ws.onReconnect(() => {
        const tid = terminalIdRef.current
        if (tid) attach(tid)
      })

      // Use paneContent for terminal lifecycle - NOT tab
      // Read terminalId from REF (not from destructured value) to get current value
      // This is critical: we want the effect to run once per createRequestId,
      // not re-run when terminalId changes from undefined to defined
      const currentTerminalId = terminalIdRef.current
      const currentStatus = contentRef.current?.status

      if (currentTerminalId) {
        attach(currentTerminalId)
      } else if (currentStatus === 'exited') {
        // Terminal has exited - don't create a new one
        // User can restart manually via context menu if needed
      } else {
        ws.send({
          type: 'terminal.create',
          requestId: createRequestId,
          mode,
          shell: shell || 'system',
          cwd: initialCwd,
          resumeSessionId: getResumeSessionIdFromRef(contentRef),
        })
      }
    }

    ensure()

    return () => {
      unsub()
      unsubReconnect()
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
  // NOTE: No tab dependency - terminal lifecycle is pane-owned
  // when tab properties (like title) change
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isTerminal, paneId, terminalContent?.createRequestId, updateContent, ws, dispatch])

  // Detach when this terminal pane unmounts (tab close or pane swap)
  useEffect(() => {
    return () => {
      const tid = terminalIdRef.current
      if (tid) {
        ws.send({ type: 'terminal.detach', terminalId: tid })
      }
    }
  }, [ws])

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
    </div>
  )
}
