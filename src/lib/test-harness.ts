import type { store as appStore } from '@/store/store'
import type { PerfAuditSnapshot } from '@/lib/perf-audit-bridge'
import type { ServerMessage } from '@shared/ws-protocol'

export type TerminalWriteEvent = {
  terminalId?: string
  paneId?: string
  phase: 'submitted' | 'written'
  chars: number
  data: string
  at: number
}

const MAX_TERMINAL_WRITE_EVENTS = 1000
const MAX_TERMINAL_WRITE_EVENT_BYTES = 1024 * 1024

export interface FreshellTestHarness {
  getState: () => ReturnType<typeof appStore.getState>
  dispatch: typeof appStore.dispatch
  getWsReadyState: () => string
  waitForConnection: (timeoutMs?: number) => Promise<void>
  forceDisconnect: () => void
  sendWsMessage: (msg: unknown) => void
  receiveWsMessage?: (msg: ServerMessage) => void
  suppressAllFreshAgentNetworkEffects?: boolean
  setSuppressAllFreshAgentNetworkEffects: (suppressed: boolean) => void
  isAllFreshAgentNetworkEffectsSuppressed: () => boolean
  setFreshAgentNetworkEffectsSuppressed: (paneId: string, suppressed: boolean) => void
  isFreshAgentNetworkEffectsSuppressed: (paneId: string) => boolean
  setTerminalNetworkEffectsSuppressed: (paneId: string, suppressed: boolean) => void
  isTerminalNetworkEffectsSuppressed: (paneId: string) => boolean
  getTerminalBuffer: (terminalId?: string) => string | null
  registerTerminalBuffer: (terminalId: string, accessor: () => string) => void
  unregisterTerminalBuffer: (terminalId: string) => void
  getPerfAuditSnapshot: () => PerfAuditSnapshot | null
  getSentWsMessages?: () => unknown[]
  clearSentWsMessages?: () => void
  recordSentWsMessage?: (msg: unknown) => void
  recordTerminalWrite?: (event: TerminalWriteEvent) => void
  getTerminalWriteEvents?: () => TerminalWriteEvent[]
  clearTerminalWriteEvents?: () => void
}

declare global {
  interface Window {
    __FRESHELL_TEST_HARNESS__?: FreshellTestHarness
  }
}

/**
 * Install the test harness on window.__FRESHELL_TEST_HARNESS__.
 *
 * Activation: This is called when the URL contains `?e2e=1`.
 * It is NOT gated behind import.meta.env.PROD or process.env.NODE_ENV
 * because E2E tests run against the production-built client. The URL
 * parameter is a runtime check that works in all build modes.
 */
export function installTestHarness(
  store: typeof appStore,
  getWsState: () => string,
  waitForWsReady: (timeoutMs?: number) => Promise<void>,
  forceWsDisconnect: () => void,
  sendWsMessage: (msg: unknown) => void,
  receiveWsMessageOrGetPerfAuditSnapshot?: ((msg: ServerMessage) => void) | (() => PerfAuditSnapshot | null),
  getPerfAuditSnapshot: () => PerfAuditSnapshot | null = () => null,
): void {
  if (typeof window === 'undefined') return

  let resolvedReceiveWsMessage: ((msg: ServerMessage) => void) | undefined
  let resolvedGetPerfAuditSnapshot = getPerfAuditSnapshot
  if (arguments.length <= 6) {
    resolvedGetPerfAuditSnapshot = (receiveWsMessageOrGetPerfAuditSnapshot as (() => PerfAuditSnapshot | null) | undefined)
      ?? (() => null)
  } else if (receiveWsMessageOrGetPerfAuditSnapshot) {
    resolvedReceiveWsMessage = receiveWsMessageOrGetPerfAuditSnapshot as (msg: ServerMessage) => void
  }

  // Registry of terminal buffer accessors, keyed by terminalId.
  // TerminalView registers/unregisters accessors as xterm instances mount/unmount.
  const terminalBuffers = new Map<string, () => string>()
  const suppressedFreshAgentPaneIds = new Set<string>()
  let suppressAllFreshAgentNetworkEffects = window.__FRESHELL_TEST_HARNESS__?.suppressAllFreshAgentNetworkEffects === true
    || (window as { __FRESHELL_SUPPRESS_ALL_FRESH_AGENT_NETWORK_EFFECTS__?: boolean }).__FRESHELL_SUPPRESS_ALL_FRESH_AGENT_NETWORK_EFFECTS__ === true
  const suppressedTerminalPaneIds = new Set<string>()
  const sentWsMessages: unknown[] = []
  const terminalWriteEvents: TerminalWriteEvent[] = []
  let terminalWriteEventBytes = 0
  const recordSentWsMessage = (msg: unknown) => {
    try {
      sentWsMessages.push(JSON.parse(JSON.stringify(msg)))
    } catch {
      sentWsMessages.push(msg)
    }
    if (sentWsMessages.length > 500) sentWsMessages.shift()
  }

  window.__FRESHELL_TEST_HARNESS__ = {
    getState: () => store.getState(),
    dispatch: store.dispatch,
    getWsReadyState: getWsState,
    waitForConnection: waitForWsReady,
    forceDisconnect: forceWsDisconnect,
    sendWsMessage: sendWsMessage,
    receiveWsMessage: resolvedReceiveWsMessage,
    get suppressAllFreshAgentNetworkEffects() {
      return suppressAllFreshAgentNetworkEffects
    },
    setSuppressAllFreshAgentNetworkEffects: (suppressed: boolean) => {
      suppressAllFreshAgentNetworkEffects = suppressed
      ;(window as { __FRESHELL_SUPPRESS_ALL_FRESH_AGENT_NETWORK_EFFECTS__?: boolean }).__FRESHELL_SUPPRESS_ALL_FRESH_AGENT_NETWORK_EFFECTS__ = suppressed
    },
    isAllFreshAgentNetworkEffectsSuppressed: () => suppressAllFreshAgentNetworkEffects,
    getTerminalBuffer: (terminalId?: string) => {
      if (terminalId) {
        const accessor = terminalBuffers.get(terminalId)
        return accessor ? accessor() : null
      }
      // No terminalId: return first registered terminal's buffer (convenience)
      const first = terminalBuffers.values().next()
      if (first.done) return null
      return first.value()
    },
    setFreshAgentNetworkEffectsSuppressed: (paneId: string, suppressed: boolean) => {
      if (suppressed) {
        suppressedFreshAgentPaneIds.add(paneId)
        return
      }
      suppressedFreshAgentPaneIds.delete(paneId)
    },
    isFreshAgentNetworkEffectsSuppressed: (paneId: string) => suppressedFreshAgentPaneIds.has(paneId),
    setTerminalNetworkEffectsSuppressed: (paneId: string, suppressed: boolean) => {
      if (suppressed) {
        suppressedTerminalPaneIds.add(paneId)
        return
      }
      suppressedTerminalPaneIds.delete(paneId)
    },
    isTerminalNetworkEffectsSuppressed: (paneId: string) => suppressedTerminalPaneIds.has(paneId),
    registerTerminalBuffer: (terminalId: string, accessor: () => string) => {
      terminalBuffers.set(terminalId, accessor)
    },
    unregisterTerminalBuffer: (terminalId: string) => {
      terminalBuffers.delete(terminalId)
    },
    getPerfAuditSnapshot: resolvedGetPerfAuditSnapshot,
    getSentWsMessages: () => [...sentWsMessages],
    clearSentWsMessages: () => {
      sentWsMessages.length = 0
    },
    recordSentWsMessage,
    recordTerminalWrite: (event: TerminalWriteEvent) => {
      const retainedEvent = { ...event }
      terminalWriteEvents.push(retainedEvent)
      terminalWriteEventBytes += retainedEvent.data.length
      while (
        terminalWriteEvents.length > MAX_TERMINAL_WRITE_EVENTS
        || terminalWriteEventBytes > MAX_TERMINAL_WRITE_EVENT_BYTES
      ) {
        const removedEvent = terminalWriteEvents.shift()
        if (!removedEvent) break
        terminalWriteEventBytes -= removedEvent.data.length
      }
    },
    getTerminalWriteEvents: () => [...terminalWriteEvents],
    clearTerminalWriteEvents: () => {
      terminalWriteEvents.length = 0
      terminalWriteEventBytes = 0
    },
  }
}
