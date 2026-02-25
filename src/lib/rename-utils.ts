import type { TabMode } from '@/store/types'

const SYNCABLE_MODES: TabMode[] = ['claude', 'codex', 'opencode', 'gemini', 'kimi']

/**
 * Determines whether a pane rename should be synced to the server.
 * Only coding CLI panes (claude, codex, opencode, gemini, kimi) with an
 * assigned terminalId need server-side persistence — the server cascades
 * the terminal title override to the associated session override.
 * Shell panes remain Redux-only.
 */
export function shouldSyncRenameToServer(
  mode: TabMode | undefined,
  terminalId: string | undefined,
): boolean {
  if (!mode || !terminalId) return false
  return SYNCABLE_MODES.includes(mode)
}
