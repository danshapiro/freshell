import { useState, useEffect } from 'react'
import { useAppSelector } from '@/store/hooks'
import { isLoopbackHostname } from '@/lib/url-rewrite'
import { api } from '@/lib/api'
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
  const extension = useAppSelector((s) =>
    s.extensions.entries.find((e) => e.name === content.extensionName),
  )

  // Port forwarding state for server extensions accessed remotely
  const [forwardedPort, setForwardedPort] = useState<number | null>(null)
  const [forwardError, setForwardError] = useState<string | null>(null)

  const isRemote = typeof window !== 'undefined' && !isLoopbackHostname(window.location.hostname)
  const serverPort = extension?.serverPort
  const serverRunning = extension?.serverRunning

  useEffect(() => {
    if (!isRemote || !serverPort || !serverRunning || extension?.category !== 'server') {
      // Clean up stale state when extension stops or is no longer forwarding
      setForwardedPort(null)
      setForwardError(null)
      return
    }

    // Reset state when dependencies change to avoid stale forwarding info
    setForwardedPort(null)
    setForwardError(null)

    let cancelled = false
    api
      .post<{ forwardedPort: number }>('/api/proxy/forward', { port: serverPort })
      .then((result) => {
        if (!cancelled) setForwardedPort(result.forwardedPort)
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
          setForwardError(`Failed to connect to extension server on port ${serverPort}: ${msg}`)
        }
      })

    return () => {
      cancelled = true
      api.delete(`/api/proxy/forward/${serverPort}`).catch(() => {})
    }
  }, [isRemote, serverPort, serverRunning, extension?.category])

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
      return (
        <ExtensionError
          name={content.extensionName}
          message={`Server extension "${extension.label}" is not running.`}
        />
      )
    }

    if (forwardError) {
      return <ExtensionError name={content.extensionName} message={forwardError} />
    }

    if (isRemote) {
      if (!forwardedPort) {
        // Still waiting for port forwarding
        return (
          <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
            Connecting to extension server...
          </div>
        )
      }
      // Use current page protocol to avoid mixed-content blocking on HTTPS
      src = `${window.location.protocol}//${window.location.hostname}:${forwardedPort}${interpolated}`
    } else {
      src = `${window.location.protocol}//localhost:${extension.serverPort}${interpolated}`
    }
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
