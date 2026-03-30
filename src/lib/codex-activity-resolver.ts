import type { CodexActivityRecord } from '@shared/ws-protocol'

export function resolveExactCodexActivity(
  byTerminalId: Record<string, CodexActivityRecord>,
  opts: { terminalId?: string; isOnlyPane: boolean },
): CodexActivityRecord | undefined {
  if (opts.terminalId) return byTerminalId[opts.terminalId]
  return undefined
}
