import { afterEach, beforeEach } from 'vitest'
import { installConsoleTraps } from './console-trap.js'
import {
  getCapturedConsoleLogRecords,
  resetCapturedConsoleLogRecords,
} from '../../server/test-log-capture.js'

// Server-side counterpart of test/setup/dom.ts. The server emits output through
// two channels, and unexpected output on either fails the test:
//   1. Direct console.error / console.warn calls — trapped like the client.
//   2. The shared pino logger, whose console-bound records (error level and
//      above) are captured in memory by server/logger.ts under test runtime.
// A test that legitimately logs an error must capture it: assert on the pino
// record (getCapturedConsoleLogRecords) or, for the whole test, opt out by
// setting __ALLOW_CONSOLE_ERROR__ = true (also clears captured error records).

// Node emits an ExperimentalWarning the first time node:sqlite is loaded. That
// is runtime infrastructure noise, not app output, so filter only that warning.
const originalEmitWarning = process.emitWarning.bind(process)
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const name = warning instanceof Error ? warning.name : (rest[0] as { type?: string })?.type
  const message = warning instanceof Error ? warning.message : String(warning)
  if (name === 'ExperimentalWarning' && /SQLite/i.test(message)) return
  return (originalEmitWarning as (...args: unknown[]) => void)(warning, ...rest)
}) as typeof process.emitWarning

let installedConsoleTraps: ReturnType<typeof installConsoleTraps> | null = null

beforeEach(() => {
  resetCapturedConsoleLogRecords()
  installedConsoleTraps = installConsoleTraps()
})

afterEach(() => {
  // Read the opt-out before collectFailures(), which consumes and resets it.
  const allowError = (globalThis as any).__ALLOW_CONSOLE_ERROR__ === true

  const failures = installedConsoleTraps?.collectFailures() ?? []
  installedConsoleTraps = null

  const leakedLogRecords = getCapturedConsoleLogRecords()
  resetCapturedConsoleLogRecords()
  if (!allowError && leakedLogRecords.length > 0) {
    const first = leakedLogRecords[0]
    failures.push(`Unexpected server log (${first.severity}): ${first.msg ?? ''}\n${first.raw}`)
  }

  if (failures.length > 0) {
    throw new Error(failures.join('\n'))
  }
})
