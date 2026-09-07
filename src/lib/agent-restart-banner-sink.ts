import type { ServerMessage } from '@shared/ws-protocol'

/**
 * Singleton sink for the context-menu provider's agent-restart banner.
 *
 * Why this exists: StablePaneLayout mounts pane shells only after its
 * geometry measurement pass, so pane surfaces (and their ws.onMessage
 * subscriptions) commit AFTER app-level providers in the initial commit
 * cascade. A mount-once subscription inside ContextMenuProvider therefore
 * registers BEFORE the pane layer's own subscriptions — harnesses that
 * deliver a frame to exactly one registered handler would hand it to the
 * pane, and the provider's restart banner would never observe
 * `agent.restart.failed` / `agent.restart.replaced`.
 *
 * The pane layer (PaneContainer) re-registers a forwarder after the pane's
 * own subscriptions, so the provider's handler still observes the frames.
 * The real ws client multiplexes frames to every handler, so in production
 * the forwarder is redundant with the provider's own subscription — and
 * double delivery is exact-idempotent here: the gate is a pure read
 * (`requestedRestartsRef.has`) and the bookkeeping is `Set.delete`.
 */
export type AgentRestartFrameHandler = (message: ServerMessage) => void

let sink: AgentRestartFrameHandler | null = null

/** Installed by ContextMenuProvider for the lifetime of its mount. */
export function registerAgentRestartBannerSink(
  handler: AgentRestartFrameHandler,
): () => void {
  sink = handler
  return () => {
    if (sink === handler) sink = null
  }
}

/** Read at forwarding time (inside the pane layer's effect), never cached. */
export function getAgentRestartBannerSink(): AgentRestartFrameHandler | null {
  return sink
}
