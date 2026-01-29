import { useEffect, useMemo, useRef, useState } from 'react'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import { updateTab } from '@/store/tabsSlice'
import { getWsClient } from '@/lib/ws-client'
import { getTerminalTheme } from '@/lib/terminal-themes'
import { nanoid } from 'nanoid'
import { cn } from '@/lib/utils'
import { Terminal } from 'xterm'
import { FitAddon } from 'xterm-addon-fit'
import { Loader2 } from 'lucide-react'
import type { PaneContent } from '@/store/paneTypes'
import 'xterm/css/xterm.css'

interface TerminalViewProps {
  tabId: string
  paneId?: string
  paneContent?: PaneContent | null
  hidden?: boolean
}

export default function TerminalView({ tabId, paneId, paneContent, hidden }: TerminalViewProps) {
  const dispatch = useAppDispatch()
  const tab = useAppSelector((s) => s.tabs.tabs.find((t) => t.id === tabId))
  const settings = useAppSelector((s) => s.settings.settings)

  // Use pane content when available, otherwise fall back to tab properties
  const terminalMode = paneContent?.kind === 'terminal' ? paneContent.mode : tab?.mode
  const terminalResumeSessionId = paneContent?.kind === 'terminal' ? paneContent.resumeSessionId : tab?.resumeSessionId
  const terminalInitialCwd = paneContent?.kind === 'terminal' ? paneContent.initialCwd : tab?.initialCwd

  const ws = useMemo(() => getWsClient(), [])
  const [isAttaching, setIsAttaching] = useState(false)

  const containerRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)

  const requestIdRef = useRef<string | null>(null)
  const terminalIdRef = useRef<string | undefined>(tab?.terminalId)
  const mountedRef = useRef(false)
  const hiddenRef = useRef(hidden)

  // Keep refs in sync
  useEffect(() => {
    terminalIdRef.current = tab?.terminalId
  }, [tab?.terminalId])

  useEffect(() => {
    hiddenRef.current = hidden
  }, [hidden])

  // Init xterm once
  useEffect(() => {
    if (!containerRef.current) return

    // Prevent re-init on StrictMode double-mount
    if (mountedRef.current && termRef.current) return
    mountedRef.current = true

    // Clean up any existing terminal first
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

    // Delay fit to allow renderer to initialize
    requestAnimationFrame(() => {
      if (termRef.current === term) {
        try {
          fit.fit()
        } catch {
          // Ignore if disposed
        }
      }
    })

    term.onData((data) => {
      const terminalId = terminalIdRef.current
      if (!terminalId) return
      ws.send({ type: 'terminal.input', terminalId, data })
    })

    // Handle copy/paste keyboard shortcuts
    term.attachCustomKeyEventHandler((event) => {
      // Ctrl+Shift+C to copy
      if (event.ctrlKey && event.shiftKey && event.key === 'C' && event.type === 'keydown') {
        const selection = term.getSelection()
        if (selection) {
          void navigator.clipboard.writeText(selection).catch(() => {
            // Ignore clipboard errors (e.g., permission denied)
          })
        }
        return false // Prevent default
      }
      // Ctrl+Shift+V to paste
      if (event.ctrlKey && event.shiftKey && event.key === 'V' && event.type === 'keydown') {
        void navigator.clipboard.readText().then((text) => {
          const terminalId = terminalIdRef.current
          if (terminalId && text) {
            ws.send({ type: 'terminal.input', terminalId, data: text })
          }
        }).catch(() => {
          // Ignore clipboard errors (e.g., permission denied)
        })
        return false // Prevent default
      }
      return true // Allow other keys
    })

    const ro = new ResizeObserver(() => {
      // Only fit if visible and not disposed
      if (hiddenRef.current || termRef.current !== term) return
      try {
        fit.fit()
        const terminalId = terminalIdRef.current
        if (terminalId) {
          ws.send({ type: 'terminal.resize', terminalId, cols: term.cols, rows: term.rows })
        }
      } catch {
        // Ignore if disposed
      }
    })
    ro.observe(containerRef.current)

    return () => {
      ro.disconnect()
      if (termRef.current === term) {
        term.dispose()
        termRef.current = null
        fitRef.current = null
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Apply settings changes
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    // Set options individually to avoid read-only option errors
    term.options.cursorBlink = settings.terminal.cursorBlink
    term.options.fontSize = settings.terminal.fontSize
    term.options.fontFamily = settings.terminal.fontFamily
    term.options.lineHeight = settings.terminal.lineHeight
    term.options.scrollback = settings.terminal.scrollback
    term.options.theme = getTerminalTheme(settings.terminal.theme, settings.theme)
    // Fit after font changes
    if (!hidden) fitRef.current?.fit()
  }, [settings, hidden])

  // When becoming visible, fit and send size
  useEffect(() => {
    if (!hidden) {
      // Use requestAnimationFrame to wait for browser layout reflow after display:none is removed
      const frameId = requestAnimationFrame(() => {
        fitRef.current?.fit()
        const term = termRef.current
        const terminalId = terminalIdRef.current
        if (term && terminalId) {
          ws.send({ type: 'terminal.resize', terminalId, cols: term.cols, rows: term.rows })
        }
      })
      return () => cancelAnimationFrame(frameId)
    }
  }, [hidden, ws])

  // Create or attach to backend terminal.
  useEffect(() => {
    if (!tab) return

    const term = termRef.current
    if (!term) return

    let unsub = () => {}
    let unsubReconnect = () => {}

    function attach(terminalId: string) {
      setIsAttaching(true)
      ws.send({ type: 'terminal.attach', terminalId })
      // Send current size after attach
      ws.send({ type: 'terminal.resize', terminalId, cols: term.cols, rows: term.rows })
    }

    async function ensure() {
      try {
        await ws.connect()
      } catch {
        // handled elsewhere
      }

      // Subscribe to messages for this terminal
      unsub = ws.onMessage((msg) => {
        const terminalId = terminalIdRef.current

        if (msg.type === 'terminal.output' && msg.terminalId && msg.terminalId === terminalId) {
          term.write(msg.data || '')
        }

        if (msg.type === 'terminal.snapshot' && msg.terminalId && msg.terminalId === terminalId) {
          // Clear and render snapshot
          try {
            term.clear()
          } catch {
            // Ignore if disposed
          }
          const snapshot = msg.snapshot || ''
          if (snapshot) {
            try {
              term.write(snapshot)
            } catch {
              // Ignore if disposed
            }
          }
        }

        // Terminal created in response to our request
        if (msg.type === 'terminal.created' && msg.requestId && msg.requestId === requestIdRef.current) {
          const newId = msg.terminalId as string
          terminalIdRef.current = newId
          dispatch(updateTab({ id: tab.id, updates: { terminalId: newId, status: 'running' } }))
          if (msg.snapshot) {
            try {
              term.clear()
              term.write(msg.snapshot)
            } catch {
              // Ignore if disposed
            }
          }
          // Some servers may require explicit attach after create; safe to do anyway.
          attach(newId)
        }

        if (msg.type === 'terminal.attached' && msg.terminalId && msg.terminalId === terminalId) {
          setIsAttaching(false)
          if (msg.snapshot) {
            try {
              term.clear()
              term.write(msg.snapshot)
            } catch {
              // Ignore if disposed
            }
          }
          dispatch(updateTab({ id: tab.id, updates: { status: 'running' } }))
        }

        if (msg.type === 'terminal.exit' && msg.terminalId && msg.terminalId === terminalId) {
          const code = typeof msg.exitCode === 'number' ? msg.exitCode : undefined
          dispatch(
            updateTab({
              id: tab.id,
              updates: { status: 'exited', title: tab.title + (code !== undefined ? ` (exit ${code})` : '') },
            }),
          )
        }

        // Auto-update title from Claude session (only if user hasn't manually set it)
        if (msg.type === 'terminal.title.updated' && msg.terminalId && msg.terminalId === terminalId) {
          if (!tab.titleSetByUser && msg.title) {
            dispatch(updateTab({ id: tab.id, updates: { title: msg.title } }))
          }
        }

        if (msg.type === 'error' && msg.requestId && msg.requestId === requestIdRef.current) {
          setIsAttaching(false)
          dispatch(updateTab({ id: tab.id, updates: { status: 'error' } }))
          term.writeln(`\r\n[Error] ${msg.message || msg.code || 'Unknown error'}\r\n`)
        }

        // Handle INVALID_TERMINAL_ID errors (e.g., after server restart)
        // These come without requestId when attach fails
        if (msg.type === 'error' && msg.code === 'INVALID_TERMINAL_ID' && !msg.requestId) {
          const terminalId = terminalIdRef.current
          if (terminalId) {
            // Terminal no longer exists on server - recreate it
            term.writeln('\r\n[Reconnecting...]\r\n')
            const newRequestId = nanoid()
            requestIdRef.current = newRequestId
            terminalIdRef.current = undefined
            dispatch(updateTab({ id: tab.id, updates: { terminalId: undefined, createRequestId: newRequestId, status: 'creating' } }))
            ws.send({
              type: 'terminal.create',
              requestId: newRequestId,
              mode: terminalMode,
              shell: tab.shell || 'system',
              cwd: terminalInitialCwd,
              resumeSessionId: terminalResumeSessionId,
            })
          }
        }
      })

      unsubReconnect = ws.onReconnect(() => {
        const terminalId = terminalIdRef.current
        if (terminalId) {
          attach(terminalId)
        }
      })

      if (tab.terminalId) {
        attach(tab.terminalId)
      } else {
        // Create a new terminal on first mount.
        const requestId = tab.createRequestId
        requestIdRef.current = requestId
        ws.send({
          type: 'terminal.create',
          requestId,
          mode: terminalMode,
          shell: tab.shell || 'system',
          cwd: terminalInitialCwd,
          resumeSessionId: terminalResumeSessionId,
        })
      }
    }

    ensure()

    return () => {
      unsub()
      unsubReconnect()
    }
  }, [tabId, tab?.terminalId]) // intentionally not including tab object to avoid re-run loops

  if (!tab) return null

  const showSpinner = tab.status === 'creating' || isAttaching

  return (
    <div className={cn('h-full w-full relative', hidden ? 'hidden' : '')}>
      <div ref={containerRef} className="h-full w-full" />
      {showSpinner && (
        <div className="absolute inset-0 flex items-center justify-center bg-background/80">
          <div className="flex flex-col items-center gap-3">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            <span className="text-sm text-muted-foreground">
              {tab.status === 'creating' ? 'Starting terminal...' : 'Reconnecting...'}
            </span>
          </div>
        </div>
      )}
    </div>
  )
}
