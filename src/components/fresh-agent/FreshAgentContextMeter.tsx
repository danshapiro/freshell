import { useEffect, useRef, useState } from 'react'
import { useAppSelector } from '@/store/hooks'
import { makeFreshAgentSessionKey } from '@shared/fresh-agent'
import type { FreshAgentPaneContent } from '@/store/paneTypes'
import { cn } from '@/lib/utils'

const WARN_PERCENT = 80

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1000) return `${Math.round(value / 1000)}k`
  return String(value)
}

/**
 * Compact context-usage meter for fresh-agent pane headers. Reads the thread
 * snapshot's tokenUsage and renders a small bar + percent, switching to a
 * warning treatment near compaction. Hover shows the detail via title on
 * desktop; tap toggles an inline detail popover (tooltips don't exist on
 * touch). Renders nothing until the provider reports usable numbers.
 */
export function FreshAgentContextMeter({ paneContent }: { paneContent: FreshAgentPaneContent }) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLSpanElement>(null)
  const tokenUsage = useAppSelector((state) => {
    if (!paneContent.sessionId) return undefined
    const key = makeFreshAgentSessionKey({
      sessionId: paneContent.sessionId,
      sessionType: paneContent.sessionType,
      provider: paneContent.provider,
    })
    return state.freshAgent?.sessions?.[key]?.snapshot?.tokenUsage
  })

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent | TouchEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('touchstart', onPointerDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('touchstart', onPointerDown)
    }
  }, [open])

  if (!tokenUsage) return null

  const percent = typeof tokenUsage.compactPercent === 'number' && Number.isFinite(tokenUsage.compactPercent)
    ? Math.max(0, Math.min(100, Math.round(tokenUsage.compactPercent)))
    : null
  const contextTokens = typeof tokenUsage.contextTokens === 'number' && Number.isFinite(tokenUsage.contextTokens)
    ? tokenUsage.contextTokens
    : null

  if (percent === null && contextTokens === null) return null

  const warn = percent !== null && percent >= WARN_PERCENT
  const detailRows = [
    contextTokens !== null ? `Context: ${formatTokens(contextTokens)} tokens` : null,
    percent !== null ? `${percent}% of compaction threshold` : null,
    `In ${formatTokens(tokenUsage.inputTokens)} / out ${formatTokens(tokenUsage.outputTokens)}`,
    typeof tokenUsage.costUsd === 'number' && tokenUsage.costUsd > 0
      ? `$${tokenUsage.costUsd.toFixed(2)}`
      : null,
    warn ? 'Compaction soon — /compact to compact now' : null,
  ].filter((row): row is string => row !== null)

  return (
    <span ref={rootRef} className="relative inline-flex">
      <button
        type="button"
        title={detailRows.join(' · ')}
        aria-expanded={open}
        className="inline-flex min-h-[2rem] items-center rounded px-1 sm:min-h-0 sm:px-0"
        onClick={(event) => {
          event.stopPropagation()
          setOpen((value) => !value)
        }}
      >
        {/* role="status" on a span inside the toggle button: the metric is a
            live region; the button is just its tap target. jsx-a11y flags
            this at warn level only — split the elements if it ever errors. */}
        <span
          role="status"
          data-warn={warn ? '' : undefined}
          aria-label={percent !== null ? `Context ${percent}% full` : `Context ${formatTokens(contextTokens ?? 0)} tokens`}
          className={cn(
            'inline-flex shrink-0 items-center gap-1.5 text-2xs',
            warn ? 'text-warning' : 'text-muted-foreground',
          )}
        >
          {percent !== null ? (
            <>
              <span className="h-1 w-9 overflow-hidden rounded-full bg-border" aria-hidden>
                <span
                  className={cn('block h-full rounded-full', warn ? 'bg-warning' : 'bg-primary')}
                  style={{ width: `${percent}%` }}
                />
              </span>
              <span>{percent}%</span>
            </>
          ) : (
            <span>{formatTokens(contextTokens ?? 0)} ctx</span>
          )}
        </span>
      </button>
      {open ? (
        <span
          role="note"
          aria-label="Context usage detail"
          className="absolute right-0 top-full z-50 mt-1 block w-max max-w-[min(18rem,calc(100vw-1rem))] rounded-md border border-border bg-card px-3 py-2 text-xs text-foreground shadow-lg"
        >
          {detailRows.map((row) => (
            <span key={row} className="block py-0.5">{row}</span>
          ))}
        </span>
      ) : null}
    </span>
  )
}

export default FreshAgentContextMeter
