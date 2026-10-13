import type { ManagedRuntimeProjectionFields } from '../../shared/managed-runtime.js'
import type { TerminalStatus } from '../store/types.js'

/** A retained process ending does not erase the supervisor's final verdict. */
export function managedTerminalPaneStatus(terminal: ManagedRuntimeProjectionFields, fallback: TerminalStatus): TerminalStatus {
  if (terminal.runtimeStatus === 'blocked') return 'error'
  if (!terminal.soulId || !terminal.recoverySummary) return fallback
  const { recoveryState, desiredState } = terminal.recoverySummary
  if (recoveryState === 'blocked' || recoveryState === 'lost') return 'error'
  if (recoveryState === 'stopped' || desiredState === 'stopped') return 'exited'
  return fallback
}

/** Status for a pane reconstructed from a retained managed terminal projection. */
export function managedTerminalResumePaneStatus(
  terminal: ManagedRuntimeProjectionFields & { status?: 'running' | 'exited' },
): TerminalStatus {
  const fallback = terminal.runtimeStatus === 'exited' || terminal.status === 'exited'
    ? 'exited'
    : terminal.runtimeStatus === 'recovering'
      ? 'recovering'
      : 'running'
  return managedTerminalPaneStatus(terminal, fallback)
}

/** Summarize a split tab from every terminal pane in a stable severity order. */
export function aggregateTerminalTabStatus(statuses: readonly TerminalStatus[]): TerminalStatus | undefined {
  for (const status of ['error', 'recovering', 'running', 'creating', 'exited'] as const) {
    if (statuses.includes(status)) return status
  }
  return undefined
}

export function managedTerminalRecoveryLabel(terminal: ManagedRuntimeProjectionFields): string | undefined {
  if (!terminal.soulId) return undefined
  switch (terminal.recoverySummary?.recoveryState) {
    case 'blocked': return 'Blocked'
    case 'lost': return 'Lost'
    case 'stopped': return 'Stopped'
    default: return undefined
  }
}

/** A retained facade remains attachable independently of its process state. */
export function isRetainedManagedTerminal(terminal: { terminalId?: string; soulId?: string }): boolean {
  return Boolean(terminal.terminalId && terminal.soulId)
}

export function canReplayManagedTerminal(terminal?: (ManagedRuntimeProjectionFields & { terminalId?: string }) | null): boolean {
  return Boolean(terminal?.terminalId && terminal.soulId && terminal.runtimeStatus)
}

export function managedTerminalProjection(terminal?: ManagedRuntimeProjectionFields): ManagedRuntimeProjectionFields {
  if (!terminal?.soulId) return {}
  return {
    soulId: terminal.soulId,
    incarnationId: terminal.incarnationId,
    runtimeStatus: terminal.runtimeStatus,
    recoverySummary: terminal.recoverySummary,
  }
}

export function sameManagedTerminalProjection(a: ManagedRuntimeProjectionFields, b: ManagedRuntimeProjectionFields): boolean {
  if (a.soulId !== b.soulId || a.incarnationId !== b.incarnationId || a.runtimeStatus !== b.runtimeStatus) return false
  const first = a.recoverySummary, second = b.recoverySummary
  if (first === second) return true
  if (!first || !second) return false
  return first.desiredState === second.desiredState && first.recoveryState === second.recoveryState
    && first.reason === second.reason && first.attemptId === second.attemptId && first.incidentId === second.incidentId
    && first.durabilityState === second.durabilityState && first.allocationState === second.allocationState
}
