import type { SessionLocator } from '../shared/ws-protocol.js'
import { buildTerminalSessionRef, type TerminalRecord } from './terminal-registry.js'

type TerminalSessionIdentityRecord = Pick<TerminalRecord, 'mode' | 'resumeSessionId' | 'codexDurability'>

export type SessionIdentityMismatchDetails = {
  expectedSessionRef?: SessionLocator
  actualSessionRef?: SessionLocator
}

export function canonicalActualSessionRef(
  record: TerminalSessionIdentityRecord,
): SessionLocator | undefined {
  return buildTerminalSessionRef(record)
}

export function terminalMatchesExpectedSession(
  record: TerminalSessionIdentityRecord,
  expectedSessionRef: SessionLocator | undefined,
): boolean {
  if (!expectedSessionRef) return true
  const actualSessionRef = canonicalActualSessionRef(record)
  return actualSessionRef?.provider === expectedSessionRef.provider
    && actualSessionRef.sessionId === expectedSessionRef.sessionId
}

export function buildSessionIdentityMismatchDetails(
  record: TerminalSessionIdentityRecord,
  expectedSessionRef: SessionLocator | undefined,
): SessionIdentityMismatchDetails {
  const actualSessionRef = canonicalActualSessionRef(record)
  return {
    ...(expectedSessionRef ? { expectedSessionRef } : {}),
    ...(actualSessionRef ? { actualSessionRef } : {}),
  }
}
