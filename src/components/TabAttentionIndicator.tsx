import { cn } from '@/lib/utils'
import { tabAttentionClassName } from '@/lib/tab-attention'
import type { TabAttentionStyle } from '@/store/types'

interface TabAttentionIndicatorProps {
  /** How many tabs carry the mark; nothing renders at 0. Omit for a bare mark. */
  count?: number
  /** What the mark means, e.g. "2 other tabs need attention". */
  label: string
  /** `dot`: a decorative mark inside a control whose own name/title carries
   * the meaning (aria-hidden). `count` (default): a polite live status. */
  variant?: 'count' | 'dot'
  style?: TabAttentionStyle
  className?: string
}

/**
 * The shared needs-attention mark for tab surfaces (mobile tab strip, its
 * chevrons). Visual tokens come from `tabAttentionClassName`, so it follows
 * the user's tabAttentionStyle like the desktop tabs.
 */
export function TabAttentionIndicator({
  count,
  label,
  variant = 'count',
  style = 'highlight',
  className,
}: TabAttentionIndicatorProps) {
  if (count !== undefined && count <= 0) return null
  const dotClassName = cn(
    'inline-block h-2 w-2 shrink-0 rounded-full',
    tabAttentionClassName({ needsAttention: true, style, surface: 'indicator' }),
  )

  if (variant === 'dot') {
    return <span aria-hidden="true" className={cn(dotClassName, className)} />
  }

  return (
    <span
      role="status"
      aria-live="polite"
      aria-label={label}
      title={label}
      className={cn('inline-flex shrink-0 items-center gap-1 text-[13px] font-semibold', className)}
    >
      <span aria-hidden="true" className={dotClassName} />
      {count !== undefined ? <span aria-hidden="true">{count}</span> : null}
    </span>
  )
}
