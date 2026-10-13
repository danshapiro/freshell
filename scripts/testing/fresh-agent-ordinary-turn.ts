export type FreshAgentOrdinaryTurnFrame = {
  type?: unknown
  provider?: unknown
  event?: Record<string, unknown>
}

export type FreshAgentOrdinaryTurnProvider = 'claude' | 'codex' | 'opencode'

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

/** Validate completion evidence against the selected provider; Codex requires an explicit outcome. */
export function freshAgentTurnCompletionStatus(
  frames: readonly FreshAgentOrdinaryTurnFrame[],
  expectedProvider: FreshAgentOrdinaryTurnProvider,
): FreshAgentTurnCompletionStatus {
  const completions = frames.filter((frame) => frame?.type === 'freshAgent.event'
    && frame.event?.type === 'freshAgent.turn.complete')
  if (completions.length === 0) return 'absent'
  if (completions.some(({ event, provider }) => {
    if (provider !== undefined && provider !== expectedProvider) return true
    if (event && Object.prototype.hasOwnProperty.call(event, 'outcome')) {
      return event.outcome !== 'completed'
    }
    return expectedProvider === 'codex'
  })) return 'failed'
  return 'completed'
}
