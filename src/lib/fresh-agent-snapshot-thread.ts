import type { FreshAgentPaneContent } from '@/store/paneTypes'
import { getCanonicalDurableSessionId, type SessionIdentityState } from '@/store/persistControl'
import { isValidClaudeSessionId } from '@/lib/claude-session-id'

// Same create/start gate the FreshAgentView/panesSlice early-state sets apply:
// while a new session is still being created, the pane must not read an older
// durable ref.
const EARLY_STATES = new Set(['creating', 'starting'])

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

/** The pane's canonical claude resume id (sessionRef → legacy resumeSessionId
 * → live durable sessionId; non-UUID values are never canonical). Exported for
 * FreshAgentView's recovery path, which predates this extraction. */
export { getCanonicalPaneResumeSessionId }
