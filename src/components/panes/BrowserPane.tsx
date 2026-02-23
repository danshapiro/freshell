import { useState, useRef, useCallback, useEffect } from 'react'
import { ArrowLeft, ArrowRight, RotateCcw, X, Wrench, Loader2 } from 'lucide-react'
import { useAppDispatch } from '@/store/hooks'
import { updatePaneContent } from '@/store/panesSlice'
import { cn } from '@/lib/utils'
import { copyText } from '@/lib/clipboard'
import { isLoopbackHostname } from '@/lib/url-rewrite'
import { api } from '@/lib/api'
import { registerBrowserActions } from '@/lib/pane-action-registry'
import { ContextIds } from '@/components/context-menu/context-menu-constants'

interface BrowserPaneProps {
  paneId: string
  tabId: string
  url: string
  devToolsOpen: boolean
}

const MAX_HISTORY_SIZE = 50

// Convert file:// URLs to the /local-file API endpoint for iframe loading
function toIframeSrc(url: string): string {
  if (url.startsWith('file://')) {
    try {
      const parsed = new URL(url)
      if (parsed.protocol !== 'file:') return url

      let filePath = decodeURIComponent(parsed.pathname)
      const hasWindowsDrivePrefix = /^\/[a-zA-Z]:\//.test(filePath)
      if (hasWindowsDrivePrefix) {
        // file:///C:/path -> C:/path (Windows local drive path)
        filePath = filePath.slice(1)
      }

      // file://server/share/path -> //server/share/path (UNC path)
      if (parsed.hostname && parsed.hostname !== 'localhost') {
        filePath = `//${parsed.hostname}${filePath}`
      }

      return `/local-file?path=${encodeURIComponent(filePath)}`
    } catch {
      // Fall back to legacy conversion when URL parsing fails.
      const filePath = url.replace(/^file:\/\/\/?/, '')
      return `/local-file?path=${encodeURIComponent(filePath)}`
    }
  }
  return url
}

/**
 * Determine whether a URL needs port forwarding (localhost URL + remote access).
 * Returns the parsed URL and target port, or null if no forwarding needed.
 */
function needsPortForward(url: string): { parsed: URL; targetPort: number } | null {
  if (isLoopbackHostname(window.location.hostname)) return null

  try {
    const parsed = new URL(url)
    if (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      isLoopbackHostname(parsed.hostname)
    ) {
      const targetPort = parsed.port
        ? parseInt(parsed.port, 10)
        : parsed.protocol === 'https:'
          ? 443
          : 80
      return { parsed, targetPort }
    }
  } catch {
    // Not a valid URL
  }
  return null
}

/**
 * Build the forwarded iframe URL: replace hostname and port with the host's
 * address and the forwarded port, preserving the original protocol/path/query/hash.
 * The TCP proxy is a raw pipe — it passes bytes verbatim, so the original
 * protocol must be preserved: https: URLs need the browser to perform TLS
 * with the local service through the proxy, http: URLs stay plaintext.
 */
function buildForwardedUrl(
  parsed: URL,
  forwardedPort: number,
): string {
  const forwarded = new URL(parsed.href)
  forwarded.hostname = window.location.hostname
  forwarded.port = String(forwardedPort)
  return forwarded.toString()
}

export default function BrowserPane({ paneId, tabId, url, devToolsOpen }: BrowserPaneProps) {
  const dispatch = useAppDispatch()
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [inputUrl, setInputUrl] = useState(url)
  const [isLoading, setIsLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [history, setHistory] = useState<string[]>(url ? [url] : [])
  const [historyIndex, setHistoryIndex] = useState(url ? 0 : -1)

  // Port forwarding state
  const [resolvedSrc, setResolvedSrc] = useState<string | null>(null)
  const [isForwarding, setIsForwarding] = useState(false)
  const [forwardError, setForwardError] = useState<string | null>(null)
  const [forwardRetryKey, setForwardRetryKey] = useState(0)

  const currentUrl = history[historyIndex] || ''

  // Resolve the iframe src: port-forward localhost URLs when remote, else direct
  useEffect(() => {
    if (!currentUrl) {
      setResolvedSrc(null)
      setForwardError(null)
      setIsForwarding(false)
      return
    }

    const forward = needsPortForward(currentUrl)
    if (!forward) {
      // No forwarding needed - use the URL directly (with file:// conversion)
      setResolvedSrc(toIframeSrc(currentUrl))
      setForwardError(null)
      setIsForwarding(false)
      return
    }

    // Request a port forward from the server
    let cancelled = false
    let forwardedTargetPort: number | null = null
    setIsForwarding(true)
    setForwardError(null)
    setResolvedSrc(null)
    setIsLoading(false)

    api
      .post<{ forwardedPort: number }>('/api/proxy/forward', {
        port: forward.targetPort,
      })
      .then((result) => {
        if (cancelled) return
        forwardedTargetPort = forward.targetPort
        setResolvedSrc(buildForwardedUrl(forward.parsed, result.forwardedPort))
      })
      .catch((err) => {
        if (cancelled) return
        const msg = err instanceof Error ? err.message : String(err)
        setForwardError(`Failed to connect to localhost:${forward.targetPort} — ${msg}`)
      })
      .finally(() => {
        if (!cancelled) setIsForwarding(false)
      })

    return () => {
      cancelled = true
      if (forwardedTargetPort !== null) {
        api.delete(`/api/proxy/forward/${forwardedTargetPort}`).catch(() => {})
      }
    }
  }, [currentUrl, forwardRetryKey])

  const navigate = useCallback((newUrl: string) => {
    if (!newUrl.trim()) return

    // Add protocol if missing (preserve file:// URLs)
    let fullUrl = newUrl
    if (!fullUrl.match(/^(https?|file):\/\//)) {
      fullUrl = 'https://' + fullUrl
    }

    setInputUrl(fullUrl)
    setIsLoading(true)
    setLoadError(null)

    // Update history, limiting to MAX_HISTORY_SIZE entries
    let newHistory = [...history.slice(0, historyIndex + 1), fullUrl]
    let newIndex = newHistory.length - 1

    // Truncate old entries if history exceeds max size
    if (newHistory.length > MAX_HISTORY_SIZE) {
      const excess = newHistory.length - MAX_HISTORY_SIZE
      newHistory = newHistory.slice(excess)
      newIndex = newIndex - excess
    }

    setHistory(newHistory)
    setHistoryIndex(newIndex)

    // Persist to Redux
    dispatch(updatePaneContent({
      tabId,
      paneId,
      content: { kind: 'browser', url: fullUrl, devToolsOpen },
    }))
  }, [dispatch, tabId, paneId, devToolsOpen, history, historyIndex])

  const goBack = useCallback(() => {
    if (historyIndex > 0) {
      const newIndex = historyIndex - 1
      setHistoryIndex(newIndex)
      setInputUrl(history[newIndex])
      setLoadError(null)
      dispatch(updatePaneContent({
        tabId,
        paneId,
        content: { kind: 'browser', url: history[newIndex], devToolsOpen },
      }))
    }
  }, [dispatch, tabId, paneId, devToolsOpen, history, historyIndex])

  const goForward = useCallback(() => {
    if (historyIndex < history.length - 1) {
      const newIndex = historyIndex + 1
      setHistoryIndex(newIndex)
      setInputUrl(history[newIndex])
      setLoadError(null)
      dispatch(updatePaneContent({
        tabId,
        paneId,
        content: { kind: 'browser', url: history[newIndex], devToolsOpen },
      }))
    }
  }, [dispatch, tabId, paneId, devToolsOpen, history, historyIndex])

  const refresh = useCallback(() => {
    const iframe = iframeRef.current
    if (!iframe) return

    // Prefer reloading the current document (handles in-iframe navigations when allowed).
    try {
      iframe.contentWindow?.location.reload()
      setIsLoading(true)
      return
    } catch {
      // cross-origin or unavailable; fall back to resetting src
    }

    const src = iframe.src
    iframe.src = src
    setIsLoading(true)
  }, [])

  const stop = useCallback(() => {
    if (iframeRef.current) {
      iframeRef.current.src = 'about:blank'
      setIsLoading(false)
    }
  }, [])

  const toggleDevTools = useCallback(() => {
    dispatch(updatePaneContent({
      tabId,
      paneId,
      content: { kind: 'browser', url, devToolsOpen: !devToolsOpen },
    }))
  }, [dispatch, tabId, paneId, url, devToolsOpen])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      navigate(inputUrl)
    }
  }

  useEffect(() => {
    // Focus the URL input only when there's no initial URL (user just created a new browser pane)
    // This is more accessible than autoFocus and allows users to manually control focus
    if (!url && inputRef.current) {
      inputRef.current.focus()
    }
  }, [url])

  useEffect(() => {
    return registerBrowserActions(paneId, {
      back: goBack,
      forward: goForward,
      reload: refresh,
      stop,
      copyUrl: async () => {
        if (currentUrl) await copyText(currentUrl)
      },
      openExternal: () => {
        // Open the resolved URL (with port forwarding) so it works for remote users
        if (resolvedSrc) {
          window.open(resolvedSrc, '_blank', 'noopener,noreferrer')
        } else if (currentUrl) {
          window.open(currentUrl, '_blank', 'noopener,noreferrer')
        }
      },
      toggleDevTools,
    })
  }, [paneId, goBack, goForward, refresh, stop, toggleDevTools, currentUrl, resolvedSrc])

  return (
    <div
      className="flex flex-col h-full w-full bg-background"
      data-context={ContextIds.Browser}
      data-pane-id={paneId}
      data-tab-id={tabId}
    >
      {/* Toolbar */}
      <div className="flex items-center gap-1 px-2 py-1.5 border-b border-border bg-card">
        <button
          onClick={goBack}
          disabled={historyIndex <= 0}
          className="p-1.5 rounded hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed"
          title="Back"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>

        <button
          onClick={goForward}
          disabled={historyIndex >= history.length - 1}
          className="p-1.5 rounded hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed"
          title="Forward"
        >
          <ArrowRight className="h-4 w-4" />
        </button>

        <button
          onClick={isLoading ? stop : refresh}
          className="p-1.5 rounded hover:bg-muted"
          title={isLoading ? 'Stop' : 'Refresh'}
        >
          {isLoading ? <X className="h-4 w-4" /> : <RotateCcw className="h-4 w-4" />}
        </button>

        <input
          ref={inputRef}
          type="text"
          value={inputUrl}
          onChange={(e) => setInputUrl(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Enter URL..."
          className="flex-1 h-8 px-3 text-sm bg-muted/50 border-0 rounded-md placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-border"
        />

        <button
          onClick={toggleDevTools}
          className={cn(
            'p-1.5 rounded hover:bg-muted',
            devToolsOpen && 'bg-muted'
          )}
          title="Developer Tools"
        >
          <Wrench className="h-4 w-4" />
        </button>
      </div>

      {/* Content area */}
      <div className="flex-1 flex min-h-0">
        {/* iframe */}
        <div className={cn('flex-1 min-w-0', devToolsOpen && 'border-r border-border')}>
          {forwardError ? (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-3 p-4">
              <div className="text-destructive font-medium">Failed to connect</div>
              <div className="text-sm text-center max-w-md">{forwardError}</div>
              <button
                onClick={() => {
                  setForwardError(null)
                  setResolvedSrc(null)
                  setForwardRetryKey((k) => k + 1)
                }}
                className="mt-2 px-4 py-2 rounded bg-muted hover:bg-muted/80 text-sm"
              >
                Try Again
              </button>
            </div>
          ) : loadError ? (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-3 p-4">
              <div className="text-destructive font-medium">Failed to load page</div>
              <div className="text-sm text-center max-w-md">{loadError}</div>
              <button
                onClick={() => {
                  setLoadError(null)
                  refresh()
                }}
                className="mt-2 px-4 py-2 rounded bg-muted hover:bg-muted/80 text-sm"
              >
                Try Again
              </button>
            </div>
          ) : isForwarding ? (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-3 p-4">
              <Loader2 className="h-6 w-6 animate-spin" />
              <div className="text-sm">Connecting to {currentUrl}...</div>
            </div>
          ) : resolvedSrc ? (
            <iframe
              ref={iframeRef}
              src={resolvedSrc}
              className="w-full h-full border-0 bg-white"
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
              onLoad={() => setIsLoading(false)}
              onError={() => {
                setIsLoading(false)
                setLoadError(`Unable to load "${currentUrl}". The page may not exist, or the server may be blocking embedded access.`)
              }}
              title="Browser content"
            />
          ) : !currentUrl ? (
            <div className="flex items-center justify-center h-full text-muted-foreground">
              Enter a URL to browse
            </div>
          ) : null}
        </div>

        {/* Dev tools panel */}
        {devToolsOpen && (
          <div className="w-[40%] min-w-[200px] bg-card flex flex-col">
            <div className="px-3 py-2 border-b border-border text-sm font-medium">
              Developer Tools
            </div>
            <div className="flex-1 p-3 text-sm text-muted-foreground overflow-auto">
              <p className="mb-2">Limited dev tools for embedded browsers.</p>
              <p className="text-xs">
                Due to browser security restrictions, full dev tools access requires the page to be same-origin or opened in a separate window.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
