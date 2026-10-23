// terminal-commands.mjs — the slash commands an SDK session cannot run.
//
// The CLI lists every command in its boot catalog (initializationResult().commands,
// T2), terminal-only ones included, and names the terminal-only ones only in the
// `terminal_slash_commands` of each turn's system/init (T1), which needs a prompt.
// The catalog the sidecar publishes at boot must already leave them out, so until
// the first init reports the CLI's own list the sidecar uses the pinned CLI's.

/**
 * The pinned CLI's terminal-only commands, exactly as its system/init lists them.
 * The real-CLI contract suite (test/integration/providers/claude-cli-contract.test.ts)
 * fails when the pinned CLI's list differs.
 */
export const PINNED_TERMINAL_COMMANDS = Object.freeze(['doctor', 'color'])

/**
 * The catalog rows an SDK session can use: `catalog` without the terminal-only
 * commands (`terminalNames`, from the latest init; the pinned list before one).
 */
export function usableCommands(catalog, terminalNames = PINNED_TERMINAL_COMMANDS) {
  const terminal = new Set(terminalNames)
  return catalog.filter((row) => !terminal.has(row.name))
}
