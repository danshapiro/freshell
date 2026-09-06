import { configStore } from './config-store.js'
import type { CodingCliProviderName } from './coding-cli/types.js'
import type { TerminalMeta } from './terminal-metadata-service.js'

/**
 * Find a terminal whose coding CLI session matches the given provider+sessionId.
 */
export function findTerminalForSession(
  allMeta: TerminalMeta[],
  provider: CodingCliProviderName,
  sessionId: string,
): TerminalMeta | undefined {
  return allMeta.find(
    (m) => m.provider === provider && m.sessionId === sessionId,
  )
}

/**
 * When a session is renamed, cascade the title override to the terminal
 * currently running that session (if any).
 * Returns the terminalId if a matching terminal was found.
 */
export async function cascadeSessionRenameToTerminal(
  allMeta: TerminalMeta[],
  provider: CodingCliProviderName,
  sessionId: string,
  titleOverride: string,
): Promise<string | undefined> {
  const match = findTerminalForSession(allMeta, provider, sessionId)
  if (!match) return undefined

  await configStore.patchTerminalOverride(match.terminalId, { titleOverride })
  return match.terminalId
}
