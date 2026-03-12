import type { store as appStore } from '@/store/store'
import type { PerfAuditSnapshot } from '@/lib/perf-audit-bridge'

export interface FreshellTestHarness {
  getState: () => ReturnType<typeof appStore.getState>
  dispatch: typeof appStore.dispatch
  getWsReadyState: () => string
  waitForConnection: (timeoutMs?: number) => Promise<void>
  forceDisconnect: () => void
  sendWsMessage: (msg: unknown) => void
  getTerminalBuffer: (terminalId?: string) => string | null
  registerTerminalBuffer: (terminalId: string, accessor: () => string) => void
  unregisterTerminalBuffer: (terminalId: string) => void
  getPerfAuditSnapshot: () => PerfAuditSnapshot | null
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
  getPerfAuditSnapshot: () => PerfAuditSnapshot | null = () => null,
): void {
  if (typeof window === 'undefined') return

  // Registry of terminal buffer accessors, keyed by terminalId.
  // TerminalView registers/unregisters accessors as xterm instances mount/unmount.
  const terminalBuffers = new Map<string, () => string>()

  window.__FRESHELL_TEST_HARNESS__ = {
    getState: () => store.getState(),
    dispatch: store.dispatch,
    getWsReadyState: getWsState,
    waitForConnection: waitForWsReady,
    forceDisconnect: forceWsDisconnect,
    sendWsMessage: sendWsMessage,
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
    registerTerminalBuffer: (terminalId: string, accessor: () => string) => {
      terminalBuffers.set(terminalId, accessor)
    },
    unregisterTerminalBuffer: (terminalId: string) => {
      terminalBuffers.delete(terminalId)
    },
    getPerfAuditSnapshot,
  }
}
