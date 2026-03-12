import {
  ACTIVITY_SWEEP_MS,
  CodexActivityTracker,
} from './codex-activity-tracker.js'
import type { ProjectGroup } from './types.js'
import type {
  TerminalInputRawEvent,
  TerminalOutputRawEvent,
  TerminalSessionBoundEvent,
  TerminalSessionUnboundEvent,
} from '../terminal-stream/registry-events.js'

type CodexActivityRegistry = {
  on: (event: string, handler: (...args: any[]) => void) => void
  off: (event: string, handler: (...args: any[]) => void) => void
}

type CodexActivityIndexer = {
  getProjects: () => ProjectGroup[]
  onUpdate: (handler: (projects: ProjectGroup[]) => void) => () => void
}

function findCodexSession(projects: ProjectGroup[], sessionId: string) {
  for (const project of projects) {
    const session = project.sessions.find((entry) => entry.provider === 'codex' && entry.sessionId === sessionId)
    if (session) return session
  }
  return undefined
}

export function wireCodexActivityTracker(input: {
  registry: CodexActivityRegistry
  codingCliIndexer: CodexActivityIndexer
  now?: () => number
  setIntervalFn?: typeof setInterval
  clearIntervalFn?: typeof clearInterval
}) {
  const {
    registry,
    codingCliIndexer,
    now = () => Date.now(),
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
  } = input

  const tracker = new CodexActivityTracker()

  const onBound = (event: TerminalSessionBoundEvent) => {
    if (event.provider !== 'codex') return
    tracker.bindTerminal({
      terminalId: event.terminalId,
      sessionId: event.sessionId,
      reason: event.reason,
      session: findCodexSession(codingCliIndexer.getProjects(), event.sessionId),
      at: now(),
    })
  }

  const onUnbound = (event: TerminalSessionUnboundEvent) => {
    if (event.provider !== 'codex') return
    tracker.unbindTerminal({ terminalId: event.terminalId, at: now() })
  }

  const onInput = (event: TerminalInputRawEvent) => {
    tracker.noteInput({ terminalId: event.terminalId, data: event.data, at: event.at })
  }

  const onOutput = (event: TerminalOutputRawEvent) => {
    tracker.noteOutput({ terminalId: event.terminalId, data: event.data, at: event.at })
  }

  const onExit = (event: { terminalId: string }) => {
    tracker.noteExit({ terminalId: event.terminalId, at: now() })
  }

  registry.on('terminal.session.bound', onBound)
  registry.on('terminal.session.unbound', onUnbound)
  registry.on('terminal.input.raw', onInput)
  registry.on('terminal.output.raw', onOutput)
  registry.on('terminal.exit', onExit)

  const stopIndexerUpdates = codingCliIndexer.onUpdate((projects) => {
    tracker.reconcileProjects(projects, now())
  })
  tracker.reconcileProjects(codingCliIndexer.getProjects(), now())

  const sweepTimer = setIntervalFn(() => {
    tracker.expire(now())
  }, ACTIVITY_SWEEP_MS)

  return {
    tracker,
    dispose(): void {
      registry.off('terminal.session.bound', onBound)
      registry.off('terminal.session.unbound', onUnbound)
      registry.off('terminal.input.raw', onInput)
      registry.off('terminal.output.raw', onOutput)
      registry.off('terminal.exit', onExit)
      stopIndexerUpdates()
      clearIntervalFn(sweepTimer)
    },
  }
}
