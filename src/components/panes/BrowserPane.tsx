import { useState, useRef, useCallback, useEffect } from 'react'
import { ArrowLeft, ArrowRight, RotateCcw, X, Wrench } from 'lucide-react'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import { consumePaneRefreshRequest, updatePaneContent } from '@/store/panesSlice'
import { clearPaneRuntimeActivity, setPaneRuntimeActivity } from '@/store/paneRuntimeActivitySlice'
import { cn } from '@/lib/utils'
import { copyText } from '@/lib/clipboard'
import { isLoopbackHostname } from '@/lib/url-rewrite'
import { registerBrowserActions } from '@/lib/pane-action-registry'
import { ContextIds } from '@/components/context-menu/context-menu-constants'
import { paneRefreshTargetMatchesContent } from '@/lib/pane-utils'
import { RUST_BASELINE_UNAVAILABLE } from '@/lib/rust-baseline-unavailable'

interface BrowserPaneProps {
  paneId: string
  tabId: string
  browserInstanceId: string
  url: string
  devToolsOpen: boolean
}

const MAX_HISTORY_SIZE = 50

type BrowserNavigationState = {
  history: string[]
  index: number
}

function appendHistoryEntry(
  history: string[],
  historyIndex: number,
  nextUrl: string,
): BrowserNavigationState {
  let nextHistory = [...history.slice(0, historyIndex + 1), nextUrl]
  let nextIndex = nextHistory.length - 1

  if (nextHistory.length > MAX_HISTORY_SIZE) {
    const excess = nextHistory.length - MAX_HISTORY_SIZE
    nextHistory = nextHistory.slice(excess)
    nextIndex = nextIndex - excess
  }

  return { history: nextHistory, index: nextIndex }
}

function syncNavigationToUrl(
  history: string[],
  historyIndex: number,
  nextUrl: string,
): BrowserNavigationState {
  if (!nextUrl) {
    return { history: [], index: -1 }
  }

  const activeUrl = history[historyIndex] || ''
  if (activeUrl === nextUrl) {
    return { history, index: historyIndex }
  }

  const existingIndex = history.lastIndexOf(nextUrl)
  if (existingIndex >= 0) {
    return { history, index: existingIndex }
  }

  return appendHistoryEntry(history, historyIndex, nextUrl)
}

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
 * Build an HTTP proxy URL for localhost http: URLs. The proxy is same-origin
 * with Freshell, which means:
 * - Screenshots can access iframe content (no cross-origin restriction)
 * - WSL2/Docker networking issues are bypassed (known-reachable port)
 *
 * Works for both local and remote browsers since `/api/proxy/http/:port/`
 * is always same-origin with the Freshell page.
 *
 * HTTPS loopback remains unavailable to remote browsers because Rust exposes
 * no TLS forwarding endpoint.
 */
export function buildHttpProxyUrl(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'http:' && isLoopbackHostname(parsed.hostname)) {
      const targetPort = parsed.port ? parseInt(parsed.port, 10) : 80

      // Don't proxy requests to Freshell's own port — it's already reachable
      const freshellPort =
        parseInt(window.location.port, 10) ||
        (window.location.protocol === 'https:' ? 443 : 80)
      if (targetPort === freshellPort) return null

      const path = parsed.pathname + parsed.search + parsed.hash
      return `/api/proxy/http/${targetPort}${path}`
    }
  } catch {
    // Not a valid URL
  }
  return null
}

/**
 * Remote loopback URLs outside the supported HTTP proxy are unavailable.
 */
function isUnsupportedRemoteLoopback(url: string): boolean {
  if (isLoopbackHostname(window.location.hostname)) return false

  try {
    const parsed = new URL(url)
    if (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      isLoopbackHostname(parsed.hostname)
    ) {
      return true
    }
  } catch {
    // Not a valid URL
  }
  return false
}

export type BrowserSourceResolution = {
  src: string | null
  baselineUnavailable: boolean
}

export function resolveBrowserSource(url: string): BrowserSourceResolution {
  const proxyUrl = buildHttpProxyUrl(url)
  if (proxyUrl) return { src: proxyUrl, baselineUnavailable: false }
  if (isUnsupportedRemoteLoopback(url)) return { src: null, baselineUnavailable: true }
  return { src: toIframeSrc(url), baselineUnavailable: false }
}

export default function BrowserPane({
  paneId,
  tabId,
  browserInstanceId,
  url,
  devToolsOpen,
}: BrowserPaneProps) {
  const dispatch = useAppDispatch()
  const refreshRequest = useAppSelector((state) => state.panes.refreshRequestsByPane?.[tabId]?.[paneId] ?? null)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [inputUrl, setInputUrl] = useState(url)
  const [isLoading, setIsLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [navigation, setNavigation] = useState<BrowserNavigationState>(() => ({
    history: url ? [url] : [],
    index: url ? 0 : -1,
  }))

  const history = navigation.history
  const historyIndex = navigation.index

  const [resolvedSrc, setResolvedSrc] = useState<string | null>(null)
  const [baselineUnavailable, setBaselineUnavailable] = useState(false)

  const currentUrl = history[historyIndex] || ''

  useEffect(() => {
    if (!currentUrl) {
      dispatch(clearPaneRuntimeActivity({ paneId }))
      return
    }

    if (baselineUnavailable || loadError) {
      dispatch(setPaneRuntimeActivity({ paneId, source: 'browser', phase: 'error' }))
      return
    }


    if (isLoading) {
      dispatch(setPaneRuntimeActivity({ paneId, source: 'browser', phase: 'loading' }))
      return
    }

    dispatch(setPaneRuntimeActivity({ paneId, source: 'browser', phase: 'idle' }))
  }, [baselineUnavailable, currentUrl, dispatch, isLoading, loadError, paneId])

  useEffect(() => () => {
    dispatch(clearPaneRuntimeActivity({ paneId }))
  }, [dispatch, paneId])

  useEffect(() => {
    const previousUrl = currentUrl
    const { history: syncedHistory, index: syncedIndex } = syncNavigationToUrl(history, historyIndex, url)

    if (syncedHistory !== history || syncedIndex !== historyIndex) {
      setNavigation({ history: syncedHistory, index: syncedIndex })
    }

    setInputUrl(url)

    if (!url) {
      setLoadError(null)
      setIsLoading(false)
      return
    }

    if (url !== previousUrl) {
      setLoadError(null)
      setIsLoading(true)
    }
  }, [url])

  // Resolve the iframe src: proxy localhost URLs through Freshell, else direct
  useEffect(() => {
    if (!currentUrl) {
      setResolvedSrc(null)
      setBaselineUnavailable(false)
      return
    }

    const resolution = resolveBrowserSource(currentUrl)
    setResolvedSrc(resolution.src)
    setBaselineUnavailable(resolution.baselineUnavailable)
    if (resolution.baselineUnavailable) setIsLoading(false)
  }, [currentUrl])

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

    const { history: nextHistory, index: nextIndex } = appendHistoryEntry(history, historyIndex, fullUrl)
    setNavigation({ history: nextHistory, index: nextIndex })

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
      setNavigation({ history, index: newIndex })
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
      setNavigation({ history, index: newIndex })
      setInputUrl(history[newIndex])
      setLoadError(null)
      dispatch(updatePaneContent({
        tabId,
        paneId,
        content: { kind: 'browser', url: history[newIndex], devToolsOpen },
      }))
    }
  }, [dispatch, tabId, paneId, devToolsOpen, history, historyIndex])

  const recoverCurrentPage = useCallback(() => {
    if (!currentUrl) return

    const resolution = resolveBrowserSource(currentUrl)
    setLoadError(null)
    setResolvedSrc(resolution.src)
    setBaselineUnavailable(resolution.baselineUnavailable)
    setIsLoading(!resolution.baselineUnavailable)
  }, [currentUrl])

  const refresh = useCallback(() => {
    if (!currentUrl) return

    const iframe = iframeRef.current
    if (!iframe) {
      recoverCurrentPage()
      return
    }

    // Prefer reloading the current document (handles in-iframe navigations when allowed).
    try {
      iframe.contentWindow?.location.reload()
      setLoadError(null)
      setIsLoading(true)
      return
    } catch {
      // cross-origin or unavailable; fall back to resetting src
    }

    const src = iframe.src || resolvedSrc || toIframeSrc(currentUrl)
    iframe.src = src
    setLoadError(null)
    setIsLoading(true)
  }, [currentUrl, recoverCurrentPage, resolvedSrc])

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
    if (!refreshRequest) return

    const matchesRequest = paneRefreshTargetMatchesContent(refreshRequest.target, {
      kind: 'browser',
      browserInstanceId,
      url,
      devToolsOpen,
    })
    if (!matchesRequest) return

    refresh()
    dispatch(consumePaneRefreshRequest({ tabId, paneId, requestId: refreshRequest.requestId }))
  }, [browserInstanceId, devToolsOpen, dispatch, paneId, refresh, refreshRequest, tabId, url])

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
        // Open the resolved URL (with port forwarding) so it works for remote users.
        // This stays inside the Freshell session so authenticated /api/proxy and
        // /local-file paths keep the auth cookie.
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
          {baselineUnavailable ? (
            <div className="flex items-center justify-center h-full p-4 text-center text-muted-foreground" role="status">
              {RUST_BASELINE_UNAVAILABLE.remoteLoopback}
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
          ) : resolvedSrc ? (
            <iframe
              ref={iframeRef}
              src={resolvedSrc}
              className="w-full h-full border-0 bg-white"
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
              onLoad={() => setIsLoading(false)}
              onErrorCapture={() => {
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
