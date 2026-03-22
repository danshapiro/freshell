import type { store as appStore } from '@/store/store'
import type { PerfAuditSnapshot } from '@/lib/perf-audit-bridge'
import { syncStableTitleByTerminalId } from '@/store/titleSync'

const SUPPRESSED_TERMINAL_PANE_IDS_STORAGE_KEY = 'freshell.e2e.suppressedTerminalPaneIds'

function loadSuppressedTerminalPaneIds(): string[] {
  if (typeof localStorage === 'undefined') return []
  try {
    const raw = localStorage.getItem(SUPPRESSED_TERMINAL_PANE_IDS_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === 'string' && value.length > 0)
      : []
  } catch {
    return []
  }
}

function persistSuppressedTerminalPaneIds(paneIds: Set<string>) {
  if (typeof localStorage === 'undefined') return
  if (paneIds.size === 0) {
    localStorage.removeItem(SUPPRESSED_TERMINAL_PANE_IDS_STORAGE_KEY)
    return
  }
  localStorage.setItem(
    SUPPRESSED_TERMINAL_PANE_IDS_STORAGE_KEY,
    JSON.stringify(Array.from(paneIds)),
  )
}

export interface FreshellTestHarness {
  getState: () => ReturnType<typeof appStore.getState>
  dispatch: typeof appStore.dispatch
  getWsReadyState: () => string
  waitForConnection: (timeoutMs?: number) => Promise<void>
  forceDisconnect: () => void
  sendWsMessage: (msg: unknown) => void
  setAgentChatNetworkEffectsSuppressed: (paneId: string, suppressed: boolean) => void
  isAgentChatNetworkEffectsSuppressed: (paneId: string) => boolean
  setTerminalNetworkEffectsSuppressed: (paneId: string, suppressed: boolean) => void
  isTerminalNetworkEffectsSuppressed: (paneId: string) => boolean
  getTerminalBuffer: (terminalId?: string) => string | null
  registerTerminalBuffer: (terminalId: string, accessor: () => string) => void
  unregisterTerminalBuffer: (terminalId: string) => void
  syncStableTitleByTerminalId: (terminalId: string, title: string) => void
  getPerfAuditSnapshot: () => PerfAuditSnapshot | null
  getSentWsMessages?: () => unknown[]
  clearSentWsMessages?: () => void
  recordSentWsMessage?: (msg: unknown) => void
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
  const suppressedAgentChatPaneIds = new Set<string>()
  const suppressedTerminalPaneIds = new Set<string>(loadSuppressedTerminalPaneIds())
  const sentWsMessages: unknown[] = []
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
    setAgentChatNetworkEffectsSuppressed: (paneId: string, suppressed: boolean) => {
      if (suppressed) {
        suppressedAgentChatPaneIds.add(paneId)
        return
      }
      suppressedAgentChatPaneIds.delete(paneId)
    },
    isAgentChatNetworkEffectsSuppressed: (paneId: string) => suppressedAgentChatPaneIds.has(paneId),
    setTerminalNetworkEffectsSuppressed: (paneId: string, suppressed: boolean) => {
      if (suppressed) {
        suppressedTerminalPaneIds.add(paneId)
        persistSuppressedTerminalPaneIds(suppressedTerminalPaneIds)
        return
      }
      suppressedTerminalPaneIds.delete(paneId)
      persistSuppressedTerminalPaneIds(suppressedTerminalPaneIds)
    },
    isTerminalNetworkEffectsSuppressed: (paneId: string) => suppressedTerminalPaneIds.has(paneId),
    registerTerminalBuffer: (terminalId: string, accessor: () => string) => {
      terminalBuffers.set(terminalId, accessor)
    },
    unregisterTerminalBuffer: (terminalId: string) => {
      terminalBuffers.delete(terminalId)
    },
    syncStableTitleByTerminalId: (terminalId: string, title: string) => {
      store.dispatch(syncStableTitleByTerminalId({ terminalId, title }) as any)
    },
    getPerfAuditSnapshot,
    getSentWsMessages: () => [...sentWsMessages],
    clearSentWsMessages: () => {
      sentWsMessages.length = 0
    },
    recordSentWsMessage,
  }
}
