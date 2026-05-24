import type { FreshAgentSessionType } from './fresh-agent.js'

export type FreshAgentSlashCommandAction = 'new' | 'compact'

export type FreshAgentSlashCommand = {
  name: string
  description: string
  action: FreshAgentSlashCommandAction
  aliases?: readonly string[]
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
] as const satisfies readonly FreshAgentSlashCommand[]

export const FRESH_AGENT_SLASH_COMMANDS_BY_SESSION_TYPE = {
  freshclaude: BASE_COMMANDS,
  kilroy: BASE_COMMANDS,
  freshcodex: BASE_COMMANDS,
  freshopencode: BASE_COMMANDS,
} as const satisfies Record<FreshAgentSessionType, readonly FreshAgentSlashCommand[]>

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
