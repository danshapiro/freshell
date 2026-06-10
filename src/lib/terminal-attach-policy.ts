import type { CheckpointDeltaReplayDecision } from './terminal-surface-checkpoint'

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
  checkpointDecision: CheckpointDeltaReplayDecision
  replayHydrateCoversCompatibleGeometryHistory?: boolean
}

type LegacyRevealAttachPolicyInput = {
  pendingIntent: TerminalAttachIntent
  pendingReason: DeferredAttachReason
  hasTrustedSurface: boolean
  renderedSeq: number
  replayHydrateCoversCompatibleGeometryHistory?: boolean
}

export type RevealAttachPlan = {
  intent: TerminalAttachIntent
  clearViewportFirst: boolean
  priority: TerminalAttachPriority
  sinceSeq?: number
  trustResultingSurfaceForDeltaReplay?: boolean
}

function resolveCheckpointDecision(
  input: RevealAttachPolicyInput | LegacyRevealAttachPolicyInput,
): CheckpointDeltaReplayDecision {
  if ('checkpointDecision' in input) return input.checkpointDecision

  return { ok: false, reason: 'missing_checkpoint' }
}

function replayHydrateTrust(
  input: RevealAttachPolicyInput | LegacyRevealAttachPolicyInput,
  checkpointDecision: CheckpointDeltaReplayDecision,
): Pick<RevealAttachPlan, 'trustResultingSurfaceForDeltaReplay'> {
  const replayHydrateNeedsProvenGeometry = !checkpointDecision.ok
    || input.pendingReason === 'explicit_refresh'
  if (!replayHydrateNeedsProvenGeometry) return {}
  if (input.replayHydrateCoversCompatibleGeometryHistory === true) return {}
  return { trustResultingSurfaceForDeltaReplay: false }
}

function fullViewportHydratePlan(
  input: RevealAttachPolicyInput | LegacyRevealAttachPolicyInput,
  checkpointDecision: CheckpointDeltaReplayDecision,
): RevealAttachPlan {
  return {
    intent: 'viewport_hydrate',
    clearViewportFirst: true,
    priority: 'foreground',
    ...replayHydrateTrust(input, checkpointDecision),
  }
}

export function resolveRevealAttachPlan(
  input: RevealAttachPolicyInput | LegacyRevealAttachPolicyInput,
): RevealAttachPlan {
  const checkpointDecision = resolveCheckpointDecision(input)
  const sinceSeq = checkpointDecision.ok ? checkpointDecision.sinceSeq : undefined

  if (input.pendingIntent !== 'viewport_hydrate') {
    if (!checkpointDecision.ok) {
      return fullViewportHydratePlan(input, checkpointDecision)
    }

    return {
      intent: input.pendingIntent,
      clearViewportFirst: false,
      priority: 'foreground',
      sinceSeq,
    }
  }

  if (
    input.pendingReason !== 'explicit_refresh'
    && sinceSeq
  ) {
    return {
      intent: 'transport_reconnect',
      clearViewportFirst: false,
      priority: 'foreground',
      sinceSeq,
    }
  }

  return fullViewportHydratePlan(input, checkpointDecision)
}
