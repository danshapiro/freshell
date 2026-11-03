import { X } from 'lucide-react'

/**
 * The fresh-agent pane's inline banner. Purely presentational: `text` is the
 * full message, and an optional `onDismiss` renders the X that clears the
 * owning error state — persistent error banners are dismissable, but
 * transient informational banners (e.g. "Restoring session...") omit it.
 * Set `announce` to false when an enclosing summary already announces it.
 */
export function FreshAgentApprovalBanner({ text, onDismiss, announce = true }: {
  text: string
  onDismiss?: () => void
  announce?: boolean
}) {
  return (
    <div
      role={announce ? 'alert' : undefined}
      className="fresh-agent-banner flex items-center justify-between gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-sm"
    >
      <span className="fresh-agent-banner-text min-w-0">{text}</span>
      {onDismiss ? (
        <button
          type="button"
          aria-label="Dismiss"
          className="fresh-agent-banner-dismiss shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
          onClick={onDismiss}
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      ) : null}
    </div>
  )
}
