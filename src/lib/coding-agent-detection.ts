import type { PaneContent } from '@/store/paneTypes'
import { isNonShellMode } from '@/lib/coding-cli-utils'

/**
 * A pane runs a CLI coding agent iff it is a fresh-agent pane or a terminal
 * in a non-shell coding mode (claude/codex/
 * opencode/gemini/kimi). Shell terminals and browser/editor/picker panes are
 * explicitly NOT coding agents — they keep their existing naming behaviour
 * (shell follows OSC/program title; browser follows URL navigation).
 *
 * This is the single scope predicate for stable/aligned naming; every place
 * that freezes or canonicalises a coding-agent name branches on it.
 */
export function isCodingAgentContent(content: PaneContent | undefined | null): boolean {
  if (!content) return false
  if (content.kind === 'fresh-agent') return true
  if (content.kind === 'terminal') return isNonShellMode(content.mode)
  return false
}

export const isCodingAgentPane = isCodingAgentContent
