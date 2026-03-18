// Renders server and client extension panes as sandboxed iframes.
// Server extensions are proxied through /api/proxy/http/:port/ for Docker/WSL2 compatibility.

import { useState, useEffect, useCallback, useRef } from 'react'
import { useAppSelector, useAppDispatch } from '@/store/hooks'
import { updateServerStatus } from '@/store/extensionsSlice'
import { api } from '@/lib/api'
import { useEnsureExtensionsRegistry } from '@/hooks/useEnsureExtensionsRegistry'
import type { ExtensionPaneContent } from '@/store/paneTypes'
import ExtensionError from './ExtensionError'

interface ExtensionPaneProps {
  tabId: string
  paneId: string
  content: ExtensionPaneContent
}

/**
 * Replace `{{varName}}` placeholders in a URL template with values from props.
 * Undefined variables are replaced with empty strings.
 */
function interpolateUrl(template: string, props: Record<string, unknown>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, varName) => {
    const value = props[varName]
    return value !== undefined ? String(value) : ''
  })
}

/**
 * Check if an iframe loaded an error response instead of real content.
 * Detects small JSON error bodies like {"error":"..."} that freshell's
 * API middleware returns for auth failures, proxy errors, etc.
 */
function detectIframeError(iframe: HTMLIFrameElement): string | null {
  try {
    const doc = iframe.contentDocument
    if (!doc?.body) return null

    const text = doc.body.textContent?.trim() ?? ''
    // Only check small responses — real extension pages are larger
    if (text.length > 500) return null

    // Look for the {"error":"..."} pattern anywhere in the text.
    // Chrome's JSON viewer may wrap the raw JSON in additional elements,
    // so we can't rely on children count being zero.
    const match = text.match(/\{"error"\s*:\s*"([^"]+)"\}/)
    if (match) {
      return match[1]
    }
  } catch {
    // Cross-origin or access denied — not an error we can detect
  }
  return null
}

export default function ExtensionPane({ content }: ExtensionPaneProps) {
  useEnsureExtensionsRegistry()

  const dispatch = useAppDispatch()
  const extension = useAppSelector((s) =>
    s.extensions.entries.find((e) => e.name === content.extensionName),
  )

  // Auto-start state for server extensions
  const [startState, setStartState] = useState<'idle' | 'starting' | 'error'>('idle')
  const [startError, setStartError] = useState<string | null>(null)
  const [startAttempt, setStartAttempt] = useState(0)

  // Iframe load error state
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const iframeRef = useRef<HTMLIFrameElement>(null)

  // Auto-start server extensions that aren't running
  useEffect(() => {
    if (!extension || extension.category !== 'server') return
    if (extension.serverRunning) {
      // Server came up (e.g. via WS broadcast) — reset start state
      setStartState('idle')
      setStartError(null)
      return
    }

    setStartState('starting')
    let cancelled = false

    api
      .post<{ port: number }>(`/api/extensions/${encodeURIComponent(extension.name)}/start`, {})
      .then((result) => {
        // The WS broadcast normally updates Redux, but as a fallback (e.g. if WS
        // is disrupted), dispatch from the API response to avoid getting stuck.
        if (!cancelled) {
          dispatch(
            updateServerStatus({
              name: extension.name,
              serverRunning: true,
              serverPort: result.port,
            }),
          )
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          let msg: string
          if (err instanceof Error) {
            msg = err.message
          } else if (err && typeof err === 'object' && 'message' in err) {
            msg = String((err as { message: unknown }).message)
          } else {
            msg = String(err)
          }
          setStartState('error')
          setStartError(msg)
        }
      })

    return () => {
      cancelled = true
    }
  }, [extension?.name, extension?.category, extension?.serverRunning, startAttempt, dispatch])

  const handleIframeError = useCallback(() => {
    setLoadError(`Extension "${extension?.label ?? content.extensionName}" failed to load.`)
  }, [extension?.label, content.extensionName])

  const handleIframeLoad = useCallback(() => {
    if (!iframeRef.current) return
    const error = detectIframeError(iframeRef.current)
    if (error) {
      setLoadError(error)
    }
  }, [])

  // Attach native event listeners for iframe error detection.
  // React's synthetic onError/onLoad don't reliably fire for iframes in all
  // environments, so we use native listeners on the ref.
  useEffect(() => {
    const iframe = iframeRef.current
    if (!iframe) return

    iframe.addEventListener('error', handleIframeError)
    iframe.addEventListener('load', handleIframeLoad)

    return () => {
      iframe.removeEventListener('error', handleIframeError)
      iframe.removeEventListener('load', handleIframeLoad)
    }
  }, [handleIframeError, handleIframeLoad, loadAttempt])

  // Reset load error on retry
  useEffect(() => {
    setLoadError(null)
  }, [loadAttempt])

  if (!extension) {
    return <ExtensionError name={content.extensionName} />
  }

  if (loadError) {
    return (
      <ExtensionError
        name={content.extensionName}
        message={loadError}
        onRetry={() => setLoadAttempt((n) => n + 1)}
      />
    )
  }

  const urlTemplate = extension.url ?? '/'
  let interpolated = interpolateUrl(urlTemplate, content.props)
  // Ensure path starts with / for correct URL construction
  if (interpolated && !interpolated.startsWith('/')) {
    interpolated = '/' + interpolated
  }

  let src: string
  if (extension.category === 'server') {
    if (!extension.serverRunning || !extension.serverPort) {
      if (startState === 'error') {
        return (
          <ExtensionError
            name={content.extensionName}
            message={`Failed to start "${extension.label}": ${startError}`}
            onRetry={() => setStartAttempt((n) => n + 1)}
          />
        )
      }
      // Starting or waiting for WS broadcast
      return (
        <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
          Starting extension server...
        </div>
      )
    }

    // Proxy all server extension requests through freshell's own port.
    // This works in Docker, WSL2, and local environments — the browser
    // only needs to reach freshell's port, and freshell proxies to the
    // extension's dynamically allocated port internally.
    src = `/api/proxy/http/${extension.serverPort}${interpolated}`
  } else if (extension.category === 'client') {
    src = `/api/extensions/${encodeURIComponent(extension.name)}/client${interpolated}`
  } else {
    // CLI extensions shouldn't use this component — they use TerminalView.
    return (
      <ExtensionError
        name={content.extensionName}
        message={`CLI extension "${content.extensionName}" cannot be rendered as an iframe pane.`}
      />
    )
  }

  return (
    <iframe
      key={loadAttempt}
      ref={iframeRef}
      src={src}
      className="w-full h-full border-0"
      sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
      title={extension.label}
    />
  )
}
