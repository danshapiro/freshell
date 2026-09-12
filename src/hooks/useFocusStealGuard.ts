import { useEffect } from 'react'
import { installFocusStealGuard } from '@/lib/focus-steal-guard'

/**
 * Installs the app-wide focus-steal rebuff (non-eligible iframe panes whose
 * nested SCRIPT hoists them into document.activeElement — inert alone does
 * not stop this). Mounted once at the app root.
 */
export function useFocusStealGuard() {
  useEffect(() => installFocusStealGuard(), [])
}
