import type {
  TerminalInputRawEvent,
  TerminalOutputRawEvent,
  TerminalSessionBoundEvent,
} from '../terminal-stream/registry-events.js'

/**
 * Shared registry→tracker wiring for PTY-signal-driven activity trackers
 * (docs/plans/2026-07-08-amplifier-session-durability-plan.md §9 Phase 4:
 * claude/amplifier wiring unification — the two modules were byte-identical
 * except for the mode string, the sweep interval, and tracker disposal).
 *
 * Parameterized by:
 * - `mode`: the terminal mode AND the `terminal.session.bound` provider string
 *   (identical for both current users: 'claude', 'amplifier').
 * - `sweepIntervalMs`: the tracker's expire() sweep cadence.
 * - `disposeTracker`: optional per-tracker teardown run on dispose() (the
 *   amplifier tracker clears its per-terminal debounce/grace timers; the
 *   claude tracker has no timers to clear).
 */

export type ActivityWiringTerminalSnapshot = {
  terminalId: string
  mode: string
  status: string
}

export type ActivityWiringRegistry = {
  list: () => Array<{ terminalId: string }>
  get: (terminalId: string) => ActivityWiringTerminalSnapshot | undefined | null
  on: (event: string, handler: (...args: any[]) => void) => void
  off: (event: string, handler: (...args: any[]) => void) => void
}

export type PtyActivityTracker = {
  trackTerminal(input: { terminalId: string; sessionId?: string; at: number }): void
  bindSession(input: { terminalId: string; sessionId: string; at: number }): void
  noteInput(input: { terminalId: string; data: string; at: number }): void
  noteOutput(input: { terminalId: string; data: string; at: number }): void
  noteExit(input: { terminalId: string }): void
  expire(at: number): void
}

export function wirePtyActivityTracker<T extends PtyActivityTracker>(input: {
  mode: string
  tracker: T
  sweepIntervalMs: number
  registry: ActivityWiringRegistry
  now?: () => number
  setIntervalFn?: typeof setInterval
  clearIntervalFn?: typeof clearInterval
  disposeTracker?: (tracker: T) => void
}): { tracker: T; dispose(): void } {
  const {
    mode,
    tracker,
    sweepIntervalMs,
    registry,
    now = () => Date.now(),
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
    disposeTracker,
  } = input

  const startTracking = (record: ActivityWiringTerminalSnapshot) => {
    if (record.mode !== mode || record.status !== 'running') return
    tracker.trackTerminal({ terminalId: record.terminalId, at: now() })
  }

  const onCreated = (record: ActivityWiringTerminalSnapshot) => {
    startTracking(record)
  }
  const onBound = (event: TerminalSessionBoundEvent) => {
    if (event.provider !== mode) return
    // Production emits 'terminal.session.bound' BEFORE 'terminal.created', so a plain
    // bindSession would be a no-op (no record yet) and drop the sessionId. Ensure the
    // record exists with its sessionId first (trackTerminal is idempotent and updates
    // the sessionId on an existing record); a later 'terminal.created' won't clobber it.
    tracker.trackTerminal({ terminalId: event.terminalId, sessionId: event.sessionId, at: now() })
    tracker.bindSession({ terminalId: event.terminalId, sessionId: event.sessionId, at: now() })
  }
  const onInput = (event: TerminalInputRawEvent) => {
    tracker.noteInput({ terminalId: event.terminalId, data: event.data, at: event.at })
  }
  const onOutput = (event: TerminalOutputRawEvent) => {
    tracker.noteOutput({ terminalId: event.terminalId, data: event.data, at: event.at })
  }
  const onExit = (event: { terminalId?: string }) => {
    if (!event.terminalId) return
    tracker.noteExit({ terminalId: event.terminalId })
  }

  registry.on('terminal.created', onCreated)
  registry.on('terminal.session.bound', onBound)
  registry.on('terminal.input.raw', onInput)
  registry.on('terminal.output.raw', onOutput)
  registry.on('terminal.exit', onExit)

  for (const listed of registry.list()) {
    const record = registry.get(listed.terminalId)
    if (record) startTracking(record)
  }

  const sweepTimer = setIntervalFn(() => {
    tracker.expire(now())
  }, sweepIntervalMs)

  return {
    tracker,
    dispose(): void {
      registry.off('terminal.created', onCreated)
      registry.off('terminal.session.bound', onBound)
      registry.off('terminal.input.raw', onInput)
      registry.off('terminal.output.raw', onOutput)
      registry.off('terminal.exit', onExit)
      clearIntervalFn(sweepTimer)
      disposeTracker?.(tracker)
    },
  }
}
