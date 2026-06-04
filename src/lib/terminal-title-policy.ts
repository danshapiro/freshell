/**
 * Whether a terminal pane should take its displayed title from the program's
 * OSC window-title escape sequences (and the process-exit suffix).
 *
 * Only plain shell terminals follow OSC titles — that is how a shell tab can
 * track the running program (ssh host, vim file, PROMPT_COMMAND, ...).
 *
 * Coding-agent terminals (claude/codex/opencode/gemini/kimi, or any non-shell
 * mode) are named from their working directory and the first message / Gemini
 * via the server session override, and must stay stable, so they ignore OSC
 * titles. An unknown/missing mode is treated as a coding agent (frozen) so a
 * transient null content can never accidentally unfreeze an agent.
 */
export function terminalFollowsOscTitle(mode: string | undefined): boolean {
  return mode === 'shell'
}
