import { useEffect, useMemo, useRef } from 'react'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import { updateTab } from '@/store/tabsSlice'
import { getWsClient } from '@/lib/ws-client'
import { cn } from '@/lib/utils'
import { Terminal } from 'xterm'
import { FitAddon } from 'xterm-addon-fit'
import 'xterm/css/xterm.css'

function getXtermTheme(theme: 'default' | 'dark' | 'light') {
  if (theme === 'light') {
    return {
      background: '#ffffff',
      foreground: '#1a1a2e',
      cursor: '#1a1a2e',
      cursorAccent: '#ffffff',
      selectionBackground: 'rgba(0, 0, 0, 0.1)',
      selectionForeground: '#1a1a2e',
    }
  }
  if (theme === 'dark') {
    return {
      background: '#09090b',
      foreground: '#fafafa',
      cursor: '#fafafa',
      cursorAccent: '#09090b',
      selectionBackground: 'rgba(255, 255, 255, 0.15)',
      selectionForeground: '#fafafa',
    }
  }
  return undefined
}

export default function TerminalView({ tabId, hidden }: { tabId: string; hidden?: boolean }) {
  const dispatch = useAppDispatch()
  const tab = useAppSelector((s) => s.tabs.tabs.find((t) => t.id === tabId))
  const settings = useAppSelector((s) => s.settings.settings)

  const ws = useMemo(() => getWsClient(), [])

  const containerRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)

  const requestIdRef = useRef<string | null>(null)
  const terminalIdRef = useRef<string | undefined>(tab?.terminalId)
  const mountedRef = useRef(false)

  // Keep refs in sync
  useEffect(() => {
    terminalIdRef.current = tab?.terminalId
  }, [tab?.terminalId])

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
      theme: getXtermTheme(settings.terminal.theme),
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

    const ro = new ResizeObserver(() => {
      // Only fit if visible and not disposed
      if (hidden || termRef.current !== term) return
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
    term.options.theme = getXtermTheme(settings.terminal.theme)
    // Fit after font changes
    if (!hidden) fitRef.current?.fit()
  }, [settings, hidden])

  // When becoming visible, fit and send size
  useEffect(() => {
    if (!hidden) {
      fitRef.current?.fit()
      const term = termRef.current
      const terminalId = terminalIdRef.current
      if (term && terminalId) {
        ws.send({ type: 'terminal.resize', terminalId, cols: term.cols, rows: term.rows })
      }
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

        if (msg.type === 'error' && msg.requestId && msg.requestId === requestIdRef.current) {
          dispatch(updateTab({ id: tab.id, updates: { status: 'error' } }))
          term.writeln(`\r\n[Error] ${msg.message || msg.code || 'Unknown error'}\r\n`)
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
          mode: tab.mode,
          shell: tab.shell || 'system',
          cwd: tab.initialCwd,
          resumeSessionId: tab.resumeSessionId,
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

  return (
    <div className={cn('h-full w-full', hidden ? 'hidden' : '')}>
      <div ref={containerRef} className="h-full w-full" />
    </div>
  )
}
