import type { PaneContent } from '@/store/paneTypes'
import type { ClientExtensionEntry } from '@shared/extension-types'
import { derivePaneTitle } from './derivePaneTitle'

/**
 * Stored pane titles can be auto-derived before the extension registry loads,
 * so tolerate both the extension-aware title and the legacy fallback title.
 */
export function matchesDerivedPaneTitle(
  storedTitle: string | undefined,
  content: PaneContent,
  extensions?: ClientExtensionEntry[],
): boolean {
  if (!storedTitle) return false
  // The host-stats pane is always named by the app ('System Status'): every
  // stored title — the legacy 'Host Stats' default, the canonical name, or a
  // stale user override — resolves to the derived title. Renaming it is
  // blocked at the UX entry points; this forces any title that already
  // exists in persisted state.
  if (content.kind === 'host-stats') return true
  if (storedTitle === derivePaneTitle(content, extensions)) return true
  // Only treat the legacy extension-blind label as equivalent when we also
  // have extension metadata that could have changed the canonical label.
  return !!extensions && storedTitle === derivePaneTitle(content)
}

export function getPaneDisplayTitle(
  content: PaneContent,
  storedTitle: string | undefined,
  extensions?: ClientExtensionEntry[],
): string {
  const derivedTitle = derivePaneTitle(content, extensions)
  if (!storedTitle || matchesDerivedPaneTitle(storedTitle, content, extensions)) {
    return derivedTitle
  }
  return storedTitle
}
