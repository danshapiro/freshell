import fs from 'fs/promises'

const TERMINAL_REPLAY_AUDIT_EVENTS = new Set([
  'terminal.replay.batch',
  'terminal.replay.progress',
  'terminal.replay.gap',
])

export async function parseVisibleFirstServerLogs(debugLogPath: string): Promise<{
  httpRequests: unknown[]
  perfEvents: unknown[]
  perfSystemSamples: unknown[]
  terminalReplayEvents: Array<Record<string, unknown>>
  terminalOutputEvents: Array<Record<string, unknown>>
  parserDiagnostics: string[]
}> {
  const content = await fs.readFile(debugLogPath, 'utf8')
  const httpRequests: unknown[] = []
  const perfEvents: unknown[] = []
  const perfSystemSamples: unknown[] = []
  const terminalReplayEvents: Array<Record<string, unknown>> = []
  const terminalOutputEvents: Array<Record<string, unknown>> = []
  const parserDiagnostics: string[] = []

  for (const [index, line] of content.split(/\r?\n/).entries()) {
    if (!line.trim()) continue

    try {
      const parsed = JSON.parse(line) as { event?: string; component?: string }
      if (parsed.event === 'http_request') {
        httpRequests.push(parsed)
        continue
      }
      if (parsed.event === 'perf_system') {
        perfSystemSamples.push(parsed)
        continue
      }
      if (parsed.component === 'perf' || (typeof parsed.event === 'string' && parsed.event.startsWith('perf'))) {
        perfEvents.push(parsed)
      }
      if (typeof parsed.event === 'string' && TERMINAL_REPLAY_AUDIT_EVENTS.has(parsed.event)) {
        terminalReplayEvents.push(parsed as Record<string, unknown>)
      }
      if (
        parsed.event === 'terminal.output'
        || parsed.event === 'terminal.output.batch'
        || parsed.event === 'terminal.output.gap'
      ) {
        terminalOutputEvents.push(parsed as Record<string, unknown>)
      }
    } catch (error) {
      parserDiagnostics.push(`line ${index + 1}: ${(error as Error).message}`)
    }
  }

  return {
    httpRequests,
    perfEvents,
    perfSystemSamples,
    terminalReplayEvents,
    terminalOutputEvents,
    parserDiagnostics,
  }
}
