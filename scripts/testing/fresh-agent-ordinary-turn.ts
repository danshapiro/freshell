import type { Page } from '@playwright/test'

export type FreshAgentOrdinaryTurnFrame = {
  type?: unknown
  provider?: unknown
  event?: Record<string, unknown>
}

export type FreshAgentOrdinaryTurnProvider = 'claude' | 'codex' | 'opencode'

export type FreshAgentTurnCompletionStatus = 'absent' | 'completed' | 'failed'

export type FreshAgentAssistantTextFacts = {
  textCharacters: number
}

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

export async function freshAgentAssistantResponseDomFacts(
  page: Page,
  paneId: string,
): Promise<{ rows: number; textCharacters: number }> {
  // Pane identity is also present on its shell and header. Select the chat
  // view itself so Playwright evaluates exactly one transcript root.
  return page.locator(`[data-pane-id="${paneId}"][data-context="fresh-agent"]`)
    .evaluate(freshAgentAssistantResponseFacts)
}

/** Existing assistant text counts only when the observed pane grows after send. */
export function freshAgentAssistantTextAppeared(
  baseline: FreshAgentAssistantTextFacts,
  current: FreshAgentAssistantTextFacts,
): boolean {
  return current.textCharacters > baseline.textCharacters
}

/** Validate completion evidence against the selected provider; every provider requires explicit success. */
export function freshAgentTurnCompletionStatus(
  frames: readonly FreshAgentOrdinaryTurnFrame[],
  expectedProvider: FreshAgentOrdinaryTurnProvider,
): FreshAgentTurnCompletionStatus {
  const completions = frames.filter((frame) => frame?.type === 'freshAgent.event'
    && frame.event?.type === 'freshAgent.turn.complete')
  if (completions.length === 0) return 'absent'
  if (completions.some(({ event, provider }) => {
    if (provider !== undefined && provider !== expectedProvider) return true
    return event?.outcome !== 'completed'
  })) return 'failed'
  return 'completed'
}
