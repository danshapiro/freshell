import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import { updateTab, switchToNextTab, switchToPrevTab } from '@/store/tabsSlice'
import { updatePaneContent, updatePaneTitle } from '@/store/panesSlice'
import { updateSessionActivity } from '@/store/sessionActivitySlice'
import { getWsClient } from '@/lib/ws-client'
import { getTerminalTheme } from '@/lib/terminal-themes'
import { getResumeSessionIdFromRef } from '@/components/terminal-view-utils'
import { copyText, readText } from '@/lib/clipboard'
import { registerTerminalActions } from '@/lib/pane-action-registry'
import { ContextIds } from '@/components/context-menu/context-menu-constants'
import { resolveTerminalFontFamily } from '@/lib/terminal-fonts'
import { nanoid } from 'nanoid'
import { cn } from '@/lib/utils'
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
  const tab = useAppSelector((s) => s.tabs.tabs.find((t) => t.id === tabId))
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
  }, [tab?.resumeSessionId])

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
      fontFamily: resolveTerminalFontFamily(settings.terminal.fontFamily),
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
      },
      selectAll: () => term.selectAll(),
      clearScrollback: () => term.clear(),
      reset: () => term.reset(),
      hasSelection: () => term.getSelection().length > 0,
    })

    requestAnimationFrame(() => {
      if (termRef.current === term) {
        try { fit.fit() } catch { /* disposed */ }
      }
    })

    term.onData((data) => {
      const tid = terminalIdRef.current
      if (!tid) return
      ws.send({ type: 'terminal.input', terminalId: tid, data })

      const currentTab = tabRef.current
      if (currentTab) {
        const now = Date.now()
        dispatch(updateTab({ id: currentTab.id, updates: { lastInputAt: now } }))
        if (currentTab.resumeSessionId) {
          if (now - lastSessionActivityAtRef.current >= SESSION_ACTIVITY_THROTTLE_MS) {
            lastSessionActivityAtRef.current = now
            const provider =
              currentTab.codingCliProvider ||
              (currentTab.mode !== 'shell' ? currentTab.mode : undefined) ||
              'claude'
            dispatch(updateSessionActivity({ sessionId: currentTab.resumeSessionId, provider, lastInputAt: now }))
          }
        }
      }
    })

    term.attachCustomKeyEventHandler((event) => {
      // Ctrl+Shift+C to copy (ignore key repeat)
      if (event.ctrlKey && event.shiftKey && event.key === 'C' && event.type === 'keydown' && !event.repeat) {
        const selection = term.getSelection()
        if (selection) {
          void navigator.clipboard.writeText(selection).catch(() => {})
        }
        return false
      }

      // Ctrl+V or Ctrl+Shift+V to paste
      // xterm.js does NOT have a built-in paste handler - we must handle it explicitly
      if (event.ctrlKey && (event.key === 'v' || event.key === 'V') && event.type === 'keydown' && !event.repeat) {
        void readText().then((text) => {
          if (!text) return
          const tid = terminalIdRef.current
          if (!tid) return
          ws.send({ type: 'terminal.input', terminalId: tid, data: text })
        })
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
      const currentTab = tabRef.current
      if (!currentTab || currentTab.titleSetByUser) return

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

      dispatch(updateTab({ id: currentTab.id, updates: { title: cleanTitle } }))
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
    term.options.fontFamily = resolveTerminalFontFamily(settings.terminal.fontFamily)
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
    const term = termRef.current
    if (!term) return

    // NOTE: We intentionally don't destructure terminalId here.
    // We read it from terminalIdRef.current to avoid stale closures.
    const { createRequestId, mode, shell, initialCwd } = terminalContent

    let unsub = () => {}
    let unsubReconnect = () => {}

    function attach(tid: string) {
      setIsAttaching(true)
      ws.send({ type: 'terminal.attach', terminalId: tid })
      ws.send({ type: 'terminal.resize', terminalId: tid, cols: term.cols, rows: term.rows })
    }

    async function ensure() {
      try {
        await ws.connect()
      } catch { /* handled elsewhere */ }

      unsub = ws.onMessage((msg) => {
        const tid = terminalIdRef.current
        const reqId = requestIdRef.current

        if (msg.type === 'terminal.output' && msg.terminalId === tid) {
          term.write(msg.data || '')
        }

        if (msg.type === 'terminal.snapshot' && msg.terminalId === tid) {
          try { term.clear() } catch {}
          if (msg.snapshot) {
            try { term.write(msg.snapshot) } catch {}
          }
        }

        if (msg.type === 'terminal.created' && msg.requestId === reqId) {
          const newId = msg.terminalId as string
          terminalIdRef.current = newId
          updateContent({ terminalId: newId, status: 'running' })
          // Also update tab for title purposes
          const currentTab = tabRef.current
          if (currentTab) {
            dispatch(updateTab({ id: currentTab.id, updates: { terminalId: newId, status: 'running' } }))
          }
          if (msg.snapshot) {
            try { term.clear(); term.write(msg.snapshot) } catch {}
          }
          attach(newId)
        }

        if (msg.type === 'terminal.attached' && msg.terminalId === tid) {
          setIsAttaching(false)
          if (msg.snapshot) {
            try { term.clear(); term.write(msg.snapshot) } catch {}
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

        // Auto-update title from Claude session (only if user hasn't manually set it)
        if (msg.type === 'terminal.title.updated' && msg.terminalId === tid) {
          const titleTab = tabRef.current
          if (titleTab && !titleTab.titleSetByUser && msg.title) {
            dispatch(updateTab({ id: titleTab.id, updates: { title: msg.title } }))
            dispatch(updatePaneTitle({ tabId, paneId: paneIdRef.current, title: msg.title }))
          }
        }

        // Handle one-time session association (when Claude creates a new session)
        // Message type: { type: 'terminal.session.associated', terminalId: string, sessionId: string }
        if (msg.type === 'terminal.session.associated' && msg.terminalId === tid) {
          const sessionId = msg.sessionId as string
          updateContent({ resumeSessionId: sessionId })
          // Also update the tab for sidebar session matching
          const currentTab = tabRef.current
          if (currentTab) {
            dispatch(updateTab({ id: currentTab.id, updates: { resumeSessionId: sessionId } }))
          }
        }

        if (msg.type === 'error' && msg.requestId === reqId) {
          setIsAttaching(false)
          updateContent({ status: 'error' })
          term.writeln(`\r\n[Error] ${msg.message || msg.code || 'Unknown error'}\r\n`)
        }

        if (msg.type === 'error' && msg.code === 'INVALID_TERMINAL_ID' && !msg.requestId) {
          const currentTerminalId = terminalIdRef.current
          const current = contentRef.current
          if (msg.terminalId && msg.terminalId !== currentTerminalId) {
            // Show feedback if the terminal already exited (the ID was cleared by
            // the exit handler, so msg.terminalId no longer matches the ref)
            if (current?.status === 'exited') {
              term.writeln('\r\n[Terminal exited — use the + button or split to start a new session]\r\n')
            }
            return
          }
          // Only auto-reconnect if terminal hasn't already exited.
          // This prevents an infinite respawn loop when terminals fail immediately
          // (e.g., due to permission errors on cwd). User must explicitly restart.
          if (currentTerminalId && current?.status !== 'exited') {
            term.writeln('\r\n[Reconnecting...]\r\n')
            const newRequestId = nanoid()
            requestIdRef.current = newRequestId
            terminalIdRef.current = undefined
            updateContent({ terminalId: undefined, createRequestId: newRequestId, status: 'creating' })
          } else if (current?.status === 'exited') {
            term.writeln('\r\n[Terminal exited — use the + button or split to start a new session]\r\n')
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

      if (currentTerminalId) {
        attach(currentTerminalId)
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
  // NOTE: tab is intentionally NOT in dependencies - we use tabRef to avoid re-attaching
  // when tab properties (like title) change
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isTerminal, paneId, terminalContent?.createRequestId, updateContent, ws, dispatch])

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
