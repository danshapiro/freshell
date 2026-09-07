/**
 * Pane createRequestIds whose durable pane-close evidence was ALREADY
 * journaled and acknowledged by a close gate (delta-r7-round-3,
 * focused-episode-7 round 2 Finding F2): the gated thunks send+await their
 * `pane.closed` BEFORE the reducer runs, so the detach middleware's
 * after-the-fact belt send for the same identity would be a redundant
 * duplicate journal write. The middleware consumes the mark instead —
 * exactly the `terminal-release-marks` pattern.
 *
 * createRequestIds are client-minted and never reused, so a stale mark can
 * only ever suppress a belt send for a close whose evidence was confirmed.
 * Marks for gated closes whose reducer subsequently no-op'd (the pane was
 * already gone by another path) are left unconsumed — benign by the same
 * never-reused argument.
 */
const evidenceConfirmedCrids = new Set<string>()

export function markPaneCloseEvidenceConfirmed(createRequestId: string): void {
  evidenceConfirmedCrids.add(createRequestId)
}

export function consumePaneCloseEvidenceMark(createRequestId: string): boolean {
  return evidenceConfirmedCrids.delete(createRequestId)
}

export function resetPaneCloseEvidenceMarks(): void {
  evidenceConfirmedCrids.clear()
}
