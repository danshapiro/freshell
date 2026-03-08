import type { CodexActivityRecord } from '@shared/ws-protocol'

export function resolveExactCodexActivity(
  byTerminalId: Record<string, CodexActivityRecord>,
  opts: { terminalId?: string; tabTerminalId?: string; isOnlyPane: boolean },
): CodexActivityRecord | undefined {
  if (opts.terminalId) return byTerminalId[opts.terminalId]
  if (opts.isOnlyPane && opts.tabTerminalId) return byTerminalId[opts.tabTerminalId]
  return undefined
}
