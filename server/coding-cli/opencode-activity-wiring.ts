import { OpencodeActivityTracker } from './opencode-activity-tracker.js'
import type { OpencodeServerEndpoint } from '../local-port.js'
import type { TerminalRecord } from '../terminal-registry.js'

type OpencodeActivityRegistry = {
  list: () => Array<{ terminalId: string }>
  get: (terminalId: string) => TerminalRecord | undefined
  on: (event: string, handler: (...args: any[]) => void) => void
  off: (event: string, handler: (...args: any[]) => void) => void
}

function getEndpoint(record: TerminalRecord): OpencodeServerEndpoint | undefined {
  return record.mode === 'opencode' ? record.opencodeServer : undefined
}

export function wireOpencodeActivityTracker(input: {
  registry: OpencodeActivityRegistry
  fetchImpl?: typeof fetch
  now?: () => number
  setTimeoutFn?: typeof setTimeout
  clearTimeoutFn?: typeof clearTimeout
  random?: () => number
}) {
  const tracker = new OpencodeActivityTracker({
    fetchImpl: input.fetchImpl,
    now: input.now,
    setTimeoutFn: input.setTimeoutFn,
    clearTimeoutFn: input.clearTimeoutFn,
    random: input.random,
  })

  const startTracking = (record: TerminalRecord) => {
    const endpoint = getEndpoint(record)
    if (!endpoint || record.status !== 'running') return
    tracker.trackTerminal({
      terminalId: record.terminalId,
      endpoint,
    })
  }

  const onCreated = (record: TerminalRecord) => {
    startTracking(record)
  }

  const onExit = (event: { terminalId?: string }) => {
    if (!event.terminalId) return
    tracker.untrackTerminal({ terminalId: event.terminalId })
  }

  input.registry.on('terminal.created', onCreated)
  input.registry.on('terminal.exit', onExit)

  for (const listed of input.registry.list()) {
    const record = input.registry.get(listed.terminalId)
    if (!record) continue
    startTracking(record)
  }

  return {
    tracker,
    dispose(): void {
      input.registry.off('terminal.created', onCreated)
      input.registry.off('terminal.exit', onExit)
      tracker.dispose()
    },
  }
}
