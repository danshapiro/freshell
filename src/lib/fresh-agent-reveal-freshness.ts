export interface FreshAgentRevealFreshnessInput {
  provider: string
  baseRevision: number | null
  requiresRevisionAdvance: boolean
  snapshotRevision: number | undefined
  verifiedCurrent: boolean
  projectionNeedsResnapshot: boolean
  projectionRevisionIsFresh: boolean
}

export function isFreshAgentRevealRevisionFresh({
  provider,
  baseRevision,
  requiresRevisionAdvance,
  snapshotRevision,
  verifiedCurrent,
  projectionNeedsResnapshot,
  projectionRevisionIsFresh,
}: FreshAgentRevealFreshnessInput): boolean {
  if (projectionNeedsResnapshot) return projectionRevisionIsFresh
  if (baseRevision === null || projectionRevisionIsFresh) return true
  if (typeof snapshotRevision === 'number' && snapshotRevision > baseRevision) return true
  if (snapshotRevision !== undefined && snapshotRevision < baseRevision) return false
  // Equality, or the absence of a transcript revision, is useful only when
  // this request was itself verified against the current read identity/fence.
  // A transcript-changing event still requires evidence newer than its base.
  return verifiedCurrent && !requiresRevisionAdvance
}
