import fs from 'fs/promises'

export async function parseVisibleFirstServerLogs(debugLogPath: string): Promise<{
  httpRequests: unknown[]
  perfEvents: unknown[]
  perfSystemSamples: unknown[]
  parserDiagnostics: string[]
}> {
  const content = await fs.readFile(debugLogPath, 'utf8')
  const httpRequests: unknown[] = []
  const perfEvents: unknown[] = []
  const perfSystemSamples: unknown[] = []
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
    } catch (error) {
      parserDiagnostics.push(`line ${index + 1}: ${(error as Error).message}`)
    }
  }

  return {
    httpRequests,
    perfEvents,
    perfSystemSamples,
    parserDiagnostics,
  }
}
