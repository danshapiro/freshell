export type TerminalAttachIntent = 'viewport_hydrate' | 'keepalive_delta' | 'transport_reconnect'
export type TerminalAttachPriority = 'foreground' | 'background'

export type DeferredAttachReason =
  | 'hidden_reveal'
  | 'initial_hydrate'
  | 'terminal_created'
  | 'transport_reconnect'
  | 'explicit_refresh'
  | 'background_catchup'

export type RevealAttachPolicyInput = {
  pendingIntent: TerminalAttachIntent
  pendingReason: DeferredAttachReason
  hasTrustedSurface: boolean
  renderedSeq: number
}

export type RevealAttachPlan = {
  intent: TerminalAttachIntent
  clearViewportFirst: boolean
  priority: TerminalAttachPriority
  sinceSeq?: number
}

function normalizeSeq(seq: number): number {
  if (!Number.isFinite(seq)) return 0
  return Math.max(0, Math.floor(seq))
}

export function resolveRevealAttachPlan(input: RevealAttachPolicyInput): RevealAttachPlan {
  const renderedSeq = normalizeSeq(input.renderedSeq)

  if (input.pendingIntent !== 'viewport_hydrate') {
    return {
      intent: input.pendingIntent,
      clearViewportFirst: false,
      priority: 'foreground',
      ...(input.hasTrustedSurface && renderedSeq > 0 ? { sinceSeq: renderedSeq } : {}),
    }
  }

  if (
    input.pendingReason !== 'explicit_refresh'
    && input.hasTrustedSurface
    && renderedSeq > 0
  ) {
    return {
      intent: 'transport_reconnect',
      clearViewportFirst: false,
      priority: 'foreground',
      sinceSeq: renderedSeq,
    }
  }

  return {
    intent: 'viewport_hydrate',
    clearViewportFirst: true,
    priority: 'foreground',
  }
}
