import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useAppSelector } from '@/store/hooks'
import { setAuthToken } from '@/lib/auth'
import { OVERLAY_Z } from '@/components/ui/overlay'
import { X } from 'lucide-react'

function getFocusable(container: HTMLElement): HTMLElement[] {
  const selectors = [
    'button',
    '[href]',
    'input',
    'select',
    'textarea',
    '[tabindex]:not([tabindex="-1"])',
  ]
  return Array.from(container.querySelectorAll<HTMLElement>(selectors.join(',')))
    .filter((el) => !el.hasAttribute('disabled') && !el.getAttribute('aria-hidden'))
}

function parseTokenFromInput(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null

  // Try to parse as URL with ?token= param
  try {
    const url = new URL(trimmed)
    // Input looks like a URL — only accept it if it has a token param.
    // Returning the raw URL string would store a garbage token.
    return url.searchParams.get('token') || null
  } catch {
    // Not a URL — treat as raw token
  }

  return trimmed
}

export function AuthRequiredModal() {
  const status = useAppSelector((s) => s.connection.status)
  const lastError = useAppSelector((s) => s.connection.lastError)
  const [dismissed, setDismissed] = useState(false)
  const [tokenInput, setTokenInput] = useState('')
  const dialogRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const isAuthError = status === 'disconnected' && !!lastError?.includes('Authentication failed')
  const shouldShow = isAuthError && !dismissed
  const currentOrigin = typeof window !== 'undefined' ? window.location.origin : ''

  // Focus input when modal opens
  useEffect(() => {
    if (!shouldShow) return
    const timer = window.setTimeout(() => {
      inputRef.current?.focus()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [shouldShow])

  // Escape key to dismiss
  useEffect(() => {
    if (!shouldShow) return
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        setDismissed(true)
      }
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [shouldShow])

  const handleSubmit = () => {
    const token = parseTokenFromInput(tokenInput)
    if (!token) return
    setAuthToken(token)
    window.location.reload()
  }

  const handleInputKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleSubmit()
    }
  }

  if (!shouldShow) return null

  return createPortal(
    <div
      className={`fixed inset-0 flex items-center justify-center bg-black/50 ${OVERLAY_Z.modal}`}
      onClick={() => setDismissed(true)}
      role="presentation"
      tabIndex={-1}
    >
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
      <div
        ref={dialogRef}
        className="bg-background border border-border rounded-lg shadow-lg w-full max-w-md mx-4 p-5"
        role="dialog"
        aria-modal="true"
        aria-label="Authentication required"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key !== 'Tab') return
          const dialog = dialogRef.current
          if (!dialog) return
          const focusables = getFocusable(dialog)
          if (focusables.length === 0) {
            e.preventDefault()
            return
          }
          const first = focusables[0]
          const last = focusables[focusables.length - 1]
          const active = document.activeElement as HTMLElement | null
          if (e.shiftKey) {
            if (active === first || !dialog.contains(active)) {
              e.preventDefault()
              last.focus()
            }
          } else if (active === last) {
            e.preventDefault()
            first.focus()
          }
        }}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">Authentication required</h2>
          <button
            onClick={() => setDismissed(true)}
            className="p-1 rounded hover:bg-muted transition-colors"
            aria-label="Dismiss"
          >
            <X className="h-4 w-4 text-muted-foreground" />
          </button>
        </div>

        <p className="text-sm text-muted-foreground mb-3">
          This browser is missing a valid auth token for this Freshell server.
        </p>
        <div className="text-sm text-muted-foreground mb-4 space-y-2">
          <p>
            Open Freshell using a token URL, like:
          </p>
          <pre className="text-xs bg-muted px-3 py-2 rounded overflow-auto">
            <code>{currentOrigin}/?token=YOUR_AUTH_TOKEN</code>
          </pre>
          <p>
            You can get <code className="text-xs bg-muted px-1 rounded">YOUR_AUTH_TOKEN</code> from:
          </p>
          <ul className="list-disc pl-5 space-y-1">
            <li>The server console output (it prints a URL on startup)</li>
            <li>
              Your <code className="text-xs bg-muted px-1 rounded">.env</code> file (
              <code className="text-xs bg-muted px-1 rounded">AUTH_TOKEN</code>)
            </li>
          </ul>
          <p>
            Tip: if you switch between <code className="text-xs bg-muted px-1 rounded">localhost</code> and a VPN/LAN IP, you may need to re-authenticate for the new address.
          </p>
        </div>

        <div className="space-y-3">
          <div>
            <label htmlFor="auth-token-input" className="block text-sm font-medium mb-1">
              Token or token URL
            </label>
            <input
              ref={inputRef}
              id="auth-token-input"
              type="text"
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              onKeyDown={handleInputKeyDown}
              placeholder="Paste token (or a token URL) here"
              className="w-full px-3 py-2 text-sm border border-border rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-ring"
              autoComplete="off"
            />
          </div>
          <button
            onClick={handleSubmit}
            className="w-full px-4 py-2 text-sm bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors"
          >
            Connect
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
