import type { FreshAgentSessionCommand } from './fresh-agent-contract.js'
import type { FreshAgentSessionType } from './fresh-agent.js'

export type FreshAgentSlashCommandAction = 'new' | 'compact' | 'fork' | 'model' | 'undo' | 'redo'

export type FreshAgentSlashCommand = {
  name: string
  description: string
  action: FreshAgentSlashCommandAction
  aliases?: readonly string[]
  /**
   * Requires the matching capability flag in the thread snapshot to be true.
   * Absent/unknown-to-the-menu capability ⇒ the menu entry is HIDDEN (the client
   * rule that absent ⇔ false) — never "show then reject". Delta-r1 F7 added
   * `undo`/`redo`: before capability discovery (no snapshot) and on
   * capability-false panes, /undo and /redo leave the menu.
   */
  requiresCapability?: 'fork' | 'undo' | 'redo'
}

const BASE_COMMANDS = [
  {
    name: 'new',
    description: 'Start a new conversation in this pane',
    action: 'new',
    aliases: ['reset', 'restart'],
  },
  {
    name: 'compact',
    description: 'Ask the agent to compact its current conversation context',
    action: 'compact',
    aliases: ['compress', 'summarize-context'],
  },
  {
    name: 'fork',
    description: 'Fork this conversation into a new session from this point',
    action: 'fork',
    aliases: ['branch'],
    requiresCapability: 'fork',
  },
  {
    name: 'undo',
    description: 'Roll back the last turn (conversation only — files stay as they are)',
    action: 'undo',
    requiresCapability: 'undo',
  },
  {
    name: 'redo',
    description: 'Restore the last rolled-back turn',
    action: 'redo',
    requiresCapability: 'redo',
  },
] as const satisfies readonly FreshAgentSlashCommand[]

/**
 * Opens the model + thinking selector dialog. Every fresh-agent session type
 * gets it: freshopencode (probed catalog), freshcodex (static table), and
 * freshclaude/kilroy (statics merged static-wins with the probed claude
 * catalog) — the shared FreshAgentModelDialog now renders for all four.
 */
const MODEL_COMMAND = {
  name: 'model',
  description: 'Choose model and thinking level',
  action: 'model',
} as const satisfies FreshAgentSlashCommand

const COMMANDS_WITH_MODEL: readonly FreshAgentSlashCommand[] = [...BASE_COMMANDS, MODEL_COMMAND]

export const FRESH_AGENT_SLASH_COMMANDS_BY_SESSION_TYPE = {
  freshclaude: COMMANDS_WITH_MODEL,
  kilroy: COMMANDS_WITH_MODEL,
  // /redo is CAPABILITY-FILTERED out of the freshcodex catalog (kata 1wxv
  // decision 5 — codex is undo-only; no "show then reject"). The server-side
  // codex×redo refusal stays as the permanent wire backstop. merge: main
  // extended the model command to every session type, and BASE_COMMANDS now
  // carries undo/redo, so COMMANDS_WITH_MODEL inherits both.
  freshcodex: [...BASE_COMMANDS.filter((command) => command.name !== 'redo'), MODEL_COMMAND],
  freshopencode: [...BASE_COMMANDS, MODEL_COMMAND],
} as const satisfies Record<FreshAgentSessionType, readonly FreshAgentSlashCommand[]>

/**
 * kata 1wxv (r3 correction 8): the reserved names the COMPOSER intercepts
 * before catalog resolution — a typed `/undo` or `/redo` is NEVER sent to the
 * model as text, even where the catalog filtered it out (freshcodex `/redo`
 * gets the pinned unsupported notice instead). Exported so composer + view +
 * tests share one source.
 */
export const RESERVED_ROLLBACK_SLASH_NAMES = ['undo', 'redo'] as const

export function getFreshAgentSlashCommands(sessionType: FreshAgentSessionType): readonly FreshAgentSlashCommand[] {
  return FRESH_AGENT_SLASH_COMMANDS_BY_SESSION_TYPE[sessionType]
}

export function resolveFreshAgentSlashCommand(
  sessionType: FreshAgentSessionType,
  rawName: string,
): FreshAgentSlashCommand | undefined {
  const normalized = rawName.replace(/^\//, '').trim().toLowerCase()
  if (!normalized) return undefined
  return getFreshAgentSlashCommands(sessionType).find((command) => (
    command.name === normalized || command.aliases?.includes(normalized)
  ))
}

/**
 * A provider-advertised session command as a menu row. `kind: 'session'`
 * lets the composer dispatch switch: action rows dispatch, session rows
 * insert verbatim `/name ` text (never auto-send).
 */
export type FreshAgentSessionMenuRow = {
  kind: 'session'
  name: string
  description: string
  argumentHint?: string
  aliases?: readonly string[]
}

/**
 * Groups the static pane-action commands and a provider-advertised session
 * catalog into one menu. Statics are returned verbatim; session rows are
 * deduped within their kind by case-insensitive canonical name (first wins).
 * Cross-kind name collisions are allowed on purpose: a session row named
 * 'compact' survives alongside the static action 'compact' (typed-Enter
 * dispatch consults action rows only, and that dispatch lives elsewhere).
 */
export function buildFreshAgentSlashCommandMenu(
  statics: readonly FreshAgentSlashCommand[],
  catalog: readonly FreshAgentSessionCommand[] | undefined,
): { action: readonly FreshAgentSlashCommand[]; session: readonly FreshAgentSessionMenuRow[] } {
  const session: FreshAgentSessionMenuRow[] = []
  const seen = new Set<string>()
  for (const command of catalog ?? []) {
    const key = command.name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    const row: FreshAgentSessionMenuRow = {
      kind: 'session',
      name: command.name,
      description: command.description,
    }
    if (command.argumentHint !== undefined) row.argumentHint = command.argumentHint
    if (command.aliases !== undefined) row.aliases = command.aliases
    session.push(row)
  }
  return { action: statics, session }
}
