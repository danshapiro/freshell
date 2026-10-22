/**
 * The needs-attention look of every tab surface, in one place: the single
 * owner of the emerald (highlight/pulse), darken and pulse class tokens used
 * by the desktop tab (TabItem), the mobile title pill (MobileTabStrip), the
 * tab-switcher card (TabSwitcher) and the attention indicator dot.
 *
 * Returns '' when the surface shows no mark (no attention, or the user's
 * `tabAttentionStyle` is 'none'); the caller then keeps its normal styling.
 */
import { cn } from '@/lib/utils'
import type { TabAttentionStyle } from '@/store/types'

export type TabAttentionSurface = 'tab' | 'card' | 'pill' | 'indicator'

export function tabAttentionClassName({
  needsAttention,
  style,
  active = false,
  surface,
}: {
  needsAttention: boolean
  style: TabAttentionStyle
  active?: boolean
  surface: TabAttentionSurface
}): string {
  if (!needsAttention || style === 'none') return ''
  const darken = style === 'darken'
  const pulse = style === 'pulse' && 'animate-pulse'

  switch (surface) {
    case 'tab':
      if (active) {
        return cn(
          darken
            ? 'border-t-[3px] border-t-muted-foreground bg-foreground/[0.08] shadow-[inset_0_4px_8px_hsl(var(--foreground)/0.1)]'
            : 'border-t-[3px] border-t-success bg-success/15 dark:bg-success/25 shadow-[inset_0_4px_8px_hsl(var(--success)/0.2)]',
          pulse,
        )
      }
      return darken
        ? 'bg-foreground/15 text-foreground hover:bg-foreground/20 dark:bg-foreground/20 dark:text-foreground dark:hover:bg-foreground/25'
        : cn(
            'bg-emerald-100 text-emerald-900 hover:bg-emerald-200 dark:bg-emerald-900/40 dark:text-emerald-100 dark:hover:bg-emerald-900/55',
            pulse,
          )
    case 'card':
      return cn(
        darken
          ? 'border-foreground/40 bg-foreground/15 dark:bg-foreground/20'
          : 'border-emerald-500 bg-emerald-100 text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-100',
        pulse,
      )
    case 'pill':
      return cn(
        'rounded-full px-2 py-0.5',
        darken
          ? 'bg-foreground/15 text-foreground dark:bg-foreground/20'
          : 'bg-emerald-100 text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-100',
        pulse,
      )
    case 'indicator':
      return cn(darken ? 'bg-foreground/60' : 'bg-emerald-500', pulse)
  }
}

/** Status wording for the mobile strip's count of OTHER tabs with the mark. */
export function otherTabsNeedAttentionLabel(count: number): string {
  return count === 1 ? '1 other tab needs attention' : `${count} other tabs need attention`
}

/** Visible badge wording on a tab card that carries the mark. */
export const NEEDS_ATTENTION_LABEL = 'Needs attention'
