import type { FreshAgentPaneContent } from '@/store/paneTypes'
import { getCanonicalDurableSessionId, type SessionIdentityState } from '@/store/persistControl'
import { isValidClaudeSessionId } from '@/lib/claude-session-id'
import { isManagedRuntimeRecoveryPending } from '@/lib/managed-runtime-recovery-message'
import { isDurableProviderSessionId } from '@shared/session-flavor'

// Same create/start gate the FreshAgentView/panesSlice early-state sets apply:
// while a new session is still being created, the pane must not read an older
// durable ref.
const EARLY_STATES = new Set(['creating', 'starting'])

/** Ordinary Stop retains history without authorizing any provider lifecycle work. */
export function isManagedFreshAgentStopped(pane: FreshAgentPaneContent): boolean {
  return pane.recoverySummary?.desiredState === 'stopped'
    || pane.recoverySummary?.recoveryState === 'stopped'
}

/** The durable identity claim carried by create/attach: prefer sessionRef and
 * promote the legacy resumeSessionId only when no sessionRef exists. */
export function effectiveSessionRef(pane: FreshAgentPaneContent) {
  if (pane.sessionRef) return pane.sessionRef
  if (pane.resumeSessionId) return { provider: pane.provider, sessionId: pane.resumeSessionId }
  return undefined
}

/** A known managed conversation remains readable while its same-request
 * bootstrap has no live handle. This is exclusively an owned history source;
 * it cannot supply the settings probe or certify a live runtime. */
export function getManagedBootstrapHistoryThreadId(pane: FreshAgentPaneContent): string | undefined {
  if (!pane.soulId || !pane.createRequestId || pane.sessionId
    || (pane.pendingReconcile !== 'fresh' && pane.pendingReconcile !== 'respawn')) return undefined
  const ref = pane.sessionRef
  if (ref?.provider !== pane.provider || !isDurableProviderSessionId(pane.provider, ref.sessionId)) return undefined
  return ref.sessionId
}

function getCanonicalPaneResumeSessionId(pane: FreshAgentPaneContent): string | undefined {
  if (pane.sessionRef?.provider === 'claude' && isValidClaudeSessionId(pane.sessionRef.sessionId)) {
    return pane.sessionRef.sessionId
  }
  if (isValidClaudeSessionId(pane.resumeSessionId)) {
    return pane.resumeSessionId
  }
  if (pane.provider === 'claude' && isValidClaudeSessionId(pane.sessionId)) {
    return pane.sessionId
  }
  return undefined
}

function isFreshOpencodePlaceholderId(pane: FreshAgentPaneContent, sessionId: string | undefined): boolean {
  return pane.provider === 'opencode'
    && pane.sessionType === 'freshopencode'
    && typeof sessionId === 'string'
    && sessionId.startsWith('freshopencode-')
}

/** The thread id the REST snapshot route answers for, given the pane and the
 * claude session-identity slice. Shared by FreshAgentView (snapshot loading)
 * and FreshAgentSettingsButton (capabilities.settingScopes probe) so both
 * surfaces resolve the same thread — including the placeholder and
 * early-create guards. */
export function getFreshAgentSnapshotThreadId(
  pane: FreshAgentPaneContent,
  claudeSession: SessionIdentityState,
): string | undefined {
  if (pane.provider === 'claude') {
    // Snapshot history is keyed by Claude's durable UUID. Runtime-only live
    // handles stay interactive through the WS transport, but should not hit
    // the snapshot route or surface history-load errors.
    return getCanonicalDurableSessionId(claudeSession)
      ?? getCanonicalPaneResumeSessionId(pane)
  }
  if (EARLY_STATES.has(pane.status)) {
    // While a new session is still being created, avoid reading an older durable ref.
    return pane.sessionId
  }
  const sessionRefId = pane.sessionRef?.provider === pane.provider ? pane.sessionRef.sessionId : undefined
  if (!pane.sessionId && isFreshOpencodePlaceholderId(pane, sessionRefId)) {
    // Legacy Freshopencode panes could persist only the placeholder sessionRef.
    // Let freshAgent.create/resume repair it before snapshot loading; otherwise
    // the placeholder 404 races the promotion and marks the pane unrecoverable.
    return undefined
  }
  return pane.sessionId
    ?? sessionRefId
}

/** The actual view read route, including stopped and bootstrap history. */
export function getFreshAgentViewSnapshotThreadId(
  pane: FreshAgentPaneContent,
  claudeSession: SessionIdentityState,
): string | undefined {
  if (isManagedFreshAgentStopped(pane)) {
    const ref = effectiveSessionRef(pane)
    if (ref?.provider === pane.provider && isDurableProviderSessionId(pane.provider, ref.sessionId)) return ref.sessionId
    if (!isManagedRuntimeRecoveryPending(pane.recoverySummary)) return undefined
  }
  return getManagedBootstrapHistoryThreadId(pane) ?? getFreshAgentSnapshotThreadId(pane, claudeSession)
}

/** The pane's canonical claude resume id (sessionRef → legacy resumeSessionId
 * → live durable sessionId; non-UUID values are never canonical). Exported for
 * FreshAgentView's recovery path, which predates this extraction. */
export { getCanonicalPaneResumeSessionId }
