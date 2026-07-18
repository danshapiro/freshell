import { Writable } from 'node:stream'
import type { DestinationStream } from 'pino'

// Standalone, dependency-light capture buffer for the shared logger's
// console-bound output under test. It is kept separate from logger.ts (and its
// heavy transitive imports such as freshell-home) so the server test setup can
// read captured records WITHOUT importing the logger graph — importing that
// graph at setup-eval time defeats per-test module mocks (e.g. vi.mock('os')).

export interface CapturedLogRecord {
  level: number
  severity: string
  msg?: string
  raw: string
}

let capturedConsoleLogRecords: CapturedLogRecord[] = []

export function getCapturedConsoleLogRecords(): readonly CapturedLogRecord[] {
  return capturedConsoleLogRecords
}

export function resetCapturedConsoleLogRecords(): void {
  capturedConsoleLogRecords = []
}

/**
 * Assert-and-consume the expected server error/warn logs a test deliberately
 * triggers: returns the matching records and removes them from the buffer so the
 * server test harness's afterEach only fails on output the test did NOT expect.
 */
export function consumeCapturedLogRecords(
  predicate: (record: CapturedLogRecord) => boolean,
): CapturedLogRecord[] {
  const matched = capturedConsoleLogRecords.filter(predicate)
  capturedConsoleLogRecords = capturedConsoleLogRecords.filter((record) => !predicate(record))
  return matched
}

export function createConsoleCaptureStream(): DestinationStream {
  return new Writable({
    write(chunk, _encoding, callback) {
      const raw = chunk.toString()
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue
        try {
          const parsed = JSON.parse(line) as { level?: number; severity?: string; msg?: string }
          capturedConsoleLogRecords.push({
            level: parsed.level ?? 0,
            severity: parsed.severity ?? 'unknown',
            msg: parsed.msg,
            raw: line,
          })
        } catch {
          capturedConsoleLogRecords.push({ level: 0, severity: 'unparsed', raw: line })
        }
      }
      callback()
    },
  }) as unknown as DestinationStream
}
