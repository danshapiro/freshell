export type FreshAgentOrdinaryTurnFrame = {
  type?: unknown
  event?: Record<string, unknown>
}

export type FreshAgentTurnCompletionStatus = 'absent' | 'completed' | 'failed'

/** Safe browser evidence: count only rendered assistant transcript rows. */
export function freshAgentAssistantResponseFacts(root: ParentNode): { rows: number; textCharacters: number } {
  const turns = root.querySelectorAll('[data-turn-role="assistant"]')
  const bodies = Array.from(root.querySelectorAll<HTMLElement>(
    '[data-turn-role="assistant"] .fresh-agent-transcript-copy > [data-markdown-body]',
  ))
  return {
    rows: turns.length,
    textCharacters: bodies.reduce((total, body) => total + (body.textContent?.trim().length ?? 0), 0),
  }
}

/** Older providers omit outcome; when present it must explicitly say completed. */
export function freshAgentTurnCompletionStatus(
  frames: readonly FreshAgentOrdinaryTurnFrame[],
): FreshAgentTurnCompletionStatus {
  const completions = frames.filter((frame) => frame?.type === 'freshAgent.event'
    && frame.event?.type === 'freshAgent.turn.complete')
  if (completions.length === 0) return 'absent'
  if (completions.some(({ event }) => event && Object.prototype.hasOwnProperty.call(event, 'outcome')
    && event.outcome !== 'completed')) return 'failed'
  return 'completed'
}
