import {
  stopFixtureProcess as stopFixtureProcessRuntime,
  waitForFixtureProcessExit as waitForFixtureProcessExitRuntime,
} from './stop-fixture-process.mjs'

/** The minimal child-process surface owned by a test fixture. */
export interface FixtureProcess {
  exitCode: number | null
  signalCode: NodeJS.Signals | null
  kill(signal: NodeJS.Signals): boolean
  once(event: 'exit', listener: () => void): unknown
  off(event: 'exit', listener: () => void): unknown
}

export interface StopFixtureProcessOptions {
  gracefulTimeoutMs?: number
  forceTimeoutMs?: number
}

// Keep the existing typed API; native Node contract harnesses import the same
// implementation directly without needing a TypeScript loader.
export const stopFixtureProcess: (
  child: FixtureProcess | undefined,
  options?: StopFixtureProcessOptions,
) => Promise<void> = stopFixtureProcessRuntime

export const waitForFixtureProcessExit: (
  child: FixtureProcess,
  timeoutMs: number,
) => Promise<void> = waitForFixtureProcessExitRuntime
