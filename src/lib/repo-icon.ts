import { isNonShellMode } from '@/lib/coding-cli-utils'
import type { PaneContent } from '@/store/paneTypes'
import type { Tab } from '@/store/types'
import type { TerminalMetaRecord } from '@/store/terminalMetaSlice'

/**
 * The cwd hint used to identify a pane's repo, for coding-agent panes only.
 * Terminal panes: terminalMeta (repoRoot > checkoutRoot > cwd, populated by
 * the Rust server's metadata sweep) then the pane/tab initialCwd.
 * Fresh-agent panes: their initialCwd. Plain shells and non-terminal panes
 * are out of scope (return undefined).
 */
export function resolvePaneRepoCwd(
  content: PaneContent,
  tab: Tab | undefined,
  terminalMetaById: Record<string, TerminalMetaRecord>,
): string | undefined {
  if (content.kind === 'terminal') {
    if (!isNonShellMode(content.mode)) return undefined
    const meta = content.terminalId ? terminalMetaById[content.terminalId] : undefined
    return meta?.repoRoot || meta?.checkoutRoot || meta?.cwd || content.initialCwd || tab?.initialCwd
  }
  if (content.kind === 'fresh-agent') {
    return content.initialCwd || tab?.initialCwd
  }
  return undefined
}

/** Last path segment, tolerant of trailing separators and backslashes. */
export function pathBasename(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, '')
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed
}

/** Relative same-origin URL; auth rides the freshell-auth cookie (img cannot set headers). */
export function buildRepoIconUrl(cwd: string): string {
  return `/api/repo-icon?cwd=${encodeURIComponent(cwd)}`
}
