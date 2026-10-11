import type { ManagedRuntimeProjectionFields } from '../../shared/managed-runtime.js'

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
