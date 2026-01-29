import { useState, useRef, useCallback } from 'react'
import { ArrowLeft, ArrowRight, RotateCcw, X, Wrench } from 'lucide-react'
import { useAppDispatch } from '@/store/hooks'
import { updatePaneContent } from '@/store/panesSlice'
import { cn } from '@/lib/utils'

interface BrowserPaneProps {
  paneId: string
  tabId: string
  url: string
  devToolsOpen: boolean
}

export default function BrowserPane({ paneId, tabId, url, devToolsOpen }: BrowserPaneProps) {
  const dispatch = useAppDispatch()
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [inputUrl, setInputUrl] = useState(url)
  const [isLoading, setIsLoading] = useState(false)
  const [history, setHistory] = useState<string[]>(url ? [url] : [])
  const [historyIndex, setHistoryIndex] = useState(url ? 0 : -1)

  const navigate = useCallback((newUrl: string) => {
    if (!newUrl.trim()) return

    // Add protocol if missing
    let fullUrl = newUrl
    if (!fullUrl.match(/^https?:\/\//)) {
      fullUrl = 'https://' + fullUrl
    }

    setInputUrl(fullUrl)
    setIsLoading(true)

    // Update history
    const newHistory = [...history.slice(0, historyIndex + 1), fullUrl]
    setHistory(newHistory)
    setHistoryIndex(newHistory.length - 1)

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
      dispatch(updatePaneContent({
        tabId,
        paneId,
        content: { kind: 'browser', url: history[newIndex], devToolsOpen },
      }))
    }
  }, [dispatch, tabId, paneId, devToolsOpen, history, historyIndex])

  const refresh = useCallback(() => {
    if (iframeRef.current) {
      iframeRef.current.src = iframeRef.current.src
      setIsLoading(true)
    }
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

  const currentUrl = history[historyIndex] || ''

  return (
    <div className="flex flex-col h-full w-full bg-background">
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
          type="text"
          value={inputUrl}
          onChange={(e) => setInputUrl(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Enter URL..."
          className="flex-1 h-8 px-3 text-sm bg-muted/50 border-0 rounded-md placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-border"
          autoFocus={!url}
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
          {currentUrl ? (
            <iframe
              ref={iframeRef}
              src={currentUrl}
              className="w-full h-full border-0 bg-white"
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
              onLoad={() => setIsLoading(false)}
              title="Browser content"
            />
          ) : (
            <div className="flex items-center justify-center h-full text-muted-foreground">
              Enter a URL to browse
            </div>
          )}
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
