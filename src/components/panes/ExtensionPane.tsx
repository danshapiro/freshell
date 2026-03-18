// Renders server and client extension panes as sandboxed iframes.
// Server extensions are proxied through /api/proxy/http/:port/ for Docker/WSL2 compatibility.

import { useState, useEffect } from 'react'
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

  if (!extension) {
    return <ExtensionError name={content.extensionName} />
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
      src={src}
      className="w-full h-full border-0"
      sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
      title={extension.label}
    />
  )
}
