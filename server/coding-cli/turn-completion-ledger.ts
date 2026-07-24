import type { TerminalTurnCompletionSnapshot } from '../../shared/ws-protocol.js'

/**
 * Provider-scoped turn-completion ledger, keyed by terminalId (plan
 * docs/plans/2026-07-08-amplifier-session-durability-plan.md §9 Phase 4).
 *
 * Extracted byte-for-byte from the machinery that was quadruplicated across the
 * claude/codex/opencode/amplifier activity trackers (`completionSeqByTerminalId`
 * + `latestCompletions` + `recordTurnCompletion` + `listLatestCompletions`).
 * Each tracker owns one ledger instance, so `completionSeq` stays scoped per
 * provider per terminal — exactly the contract of
 * `TerminalTurnCompletionSnapshot` (`shared/ws-protocol.ts`).
 *
 * Deliberately NO per-terminal cleanup on terminal removal (none of the four
 * trackers ever cleared these maps on noteExit/untrackTerminal): the sequence
 * stays monotonic if the same terminalId completes again after a re-track, and
 * the latest snapshot outlives the activity record so late-attaching clients
 * still receive it.
 */
export class TurnCompletionLedger {
  private readonly completionSeqByTerminalId = new Map<string, number>()
  private readonly latestCompletions = new Map<string, TerminalTurnCompletionSnapshot>()

  /**
   * Assign the next monotonic completionSeq for the terminal, remember the
   * latest snapshot, and return the caller's event payload with the seq
   * appended — `{ ...input, completionSeq }`, key order preserved.
   */
  recordTurnCompletion<T extends { terminalId: string; at: number }>(input: T): T & { completionSeq: number } {
    const completionSeq = (this.completionSeqByTerminalId.get(input.terminalId) ?? 0) + 1
    this.completionSeqByTerminalId.set(input.terminalId, completionSeq)
    this.latestCompletions.set(input.terminalId, {
      terminalId: input.terminalId,
      at: input.at,
      completionSeq,
    })
    return {
      ...input,
      completionSeq,
    }
  }

  /** Latest completion snapshot per terminal, in first-completion order. */
  listLatestCompletions(): TerminalTurnCompletionSnapshot[] {
    return Array.from(this.latestCompletions.values())
  }
}
