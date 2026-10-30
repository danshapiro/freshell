export interface FreshAgentRevealFreshnessInput {
  provider: string
  baseRevision: number | null
  requiresRevisionAdvance: boolean
  snapshotRevision: number | undefined
  projectionNeedsResnapshot: boolean
  projectionRevisionIsFresh: boolean
}

export function isFreshAgentRevealRevisionFresh({
  provider,
  baseRevision,
  requiresRevisionAdvance,
  snapshotRevision,
  projectionNeedsResnapshot,
  projectionRevisionIsFresh,
}: FreshAgentRevealFreshnessInput): boolean {
  if (projectionNeedsResnapshot) return projectionRevisionIsFresh
  if (baseRevision === null || projectionRevisionIsFresh || typeof snapshotRevision !== 'number') return true
  if (snapshotRevision > baseRevision) return true
  return provider === 'opencode'
    && !requiresRevisionAdvance
    && snapshotRevision === baseRevision
}
