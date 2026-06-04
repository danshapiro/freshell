import {
  CLAUDE_ACTIVITY_SWEEP_MS,
  ClaudeActivityTracker,
} from './claude-activity-tracker.js'
import type {
  TerminalInputRawEvent,
  TerminalOutputRawEvent,
  TerminalSessionBoundEvent,
} from '../terminal-stream/registry-events.js'

type ClaudeTerminalSnapshot = {
  terminalId: string
  mode: string
  status: string
}

type ClaudeActivityRegistry = {
  list: () => Array<{ terminalId: string }>
  get: (terminalId: string) => ClaudeTerminalSnapshot | undefined | null
  on: (event: string, handler: (...args: any[]) => void) => void
  off: (event: string, handler: (...args: any[]) => void) => void
}

export function wireClaudeActivityTracker(input: {
  registry: ClaudeActivityRegistry
  now?: () => number
  setIntervalFn?: typeof setInterval
  clearIntervalFn?: typeof clearInterval
}) {
  const {
    registry,
    now = () => Date.now(),
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
  } = input

  const tracker = new ClaudeActivityTracker()

  const startTracking = (record: ClaudeTerminalSnapshot) => {
    if (record.mode !== 'claude' || record.status !== 'running') return
    tracker.trackTerminal({ terminalId: record.terminalId, at: now() })
  }

  const onCreated = (record: ClaudeTerminalSnapshot) => {
    startTracking(record)
  }
  const onBound = (event: TerminalSessionBoundEvent) => {
    if (event.provider !== 'claude') return
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
  }, CLAUDE_ACTIVITY_SWEEP_MS)

  return {
    tracker,
    dispose(): void {
      registry.off('terminal.created', onCreated)
      registry.off('terminal.session.bound', onBound)
      registry.off('terminal.input.raw', onInput)
      registry.off('terminal.output.raw', onOutput)
      registry.off('terminal.exit', onExit)
      clearIntervalFn(sweepTimer)
    },
  }
}
