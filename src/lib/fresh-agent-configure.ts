/**
 * The `freshAgent.configure` send lane — applying a committed model / effort /
 * permission-mode / sandbox change to the LIVE session so every device's model
 * surfaces converge immediately (the server answers with the
 * `freshAgent.session.metadata` broadcast, plus a session-scoped
 * `freshAgent.error` banner frame when the provider refuses, e.g. changing the
 * model mid-turn on claude).
 *
 * Shared by the model+thinking dialog commit, the settings-gear popover's
 * model radio / thinking select / permission-mode select, and FreshAgentView's
 * own frame senders: one suppression-aware send path. The e2e harness's
 * per-pane/all-panes network-effect suppression is honored IDENTICALLY to
 * every other freshAgent.* frame the view sends (a suppressed send is recorded
 * to the harness's sent-message spy and never hits the wire).
 */

import { getWsClient } from '@/lib/ws-client'
import type { FreshAgentPaneContent } from '@/store/paneTypes'

/** The `freshAgent.configure` settings payload — the same per-field shape
 * `freshAgent.send.settings` carries (all optional; an absent key means "no
 * statement", so the caller states ONLY what changed). */
export type FreshAgentConfigureSettings = {
  model?: string
  effort?: string
  permissionMode?: string
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access'
}

/** The suppression-aware fresh-agent frame send (mirrors the view's own
 * `sendFreshAgentMessage` seam — suppressed frames go to the harness spy,
 * never the wire). */
export function sendSuppressedAwareFreshAgentFrame(
  paneId: string,
  message: Record<string, unknown>,
): void {
  const suppressed = typeof window !== 'undefined'
    && (
      window.__FRESHELL_TEST_HARNESS__?.isAllFreshAgentNetworkEffectsSuppressed?.() === true
      || window.__FRESHELL_TEST_HARNESS__?.isFreshAgentNetworkEffectsSuppressed?.(paneId) === true
    )
  if (suppressed) {
    window.__FRESHELL_TEST_HARNESS__?.recordSentWsMessage?.(message)
    return
  }
  getWsClient().send(message)
}

/**
 * Fire-and-forget `freshAgent.configure`: only a pane with a LIVE session
 * (sessionId set) can apply settings — pre-create panes stage on the pane
 * content and the next `freshAgent.send` carries them, exactly as before.
 * The settings object states ONLY the fields the caller changed; an absent
 * effort key is the picker's explicit Default row (opencode clears it; the
 * per-send providers keep the session's current value).
 */
export function sendFreshAgentConfigure(
  paneId: string,
  paneContent: FreshAgentPaneContent,
  settings: FreshAgentConfigureSettings,
): void {
  if (!paneContent.sessionId) return
  const frame = {
    type: 'freshAgent.configure',
    requestId: `cfg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    sessionId: paneContent.sessionId,
    sessionType: paneContent.sessionType,
    provider: paneContent.provider,
    settings,
  }
  sendSuppressedAwareFreshAgentFrame(paneId, frame)
}

