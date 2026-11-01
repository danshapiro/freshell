import type { Locator, Page } from '@playwright/test'
import { expect } from '@playwright/test'

/**
 * The text of a prompt the user sent, located inside the user's own
 * transcript turn (the `article` named "You transcript turn").
 *
 * Matching a prompt by text across a whole fresh-agent pane (or page) is
 * ambiguous: once that prompt scrolls above the transcript's top edge, the
 * "Jump to your message" button repeats its first line. Scoping to the
 * transcript turn keeps the match on the message itself, and the text match
 * is exact.
 */
export function userTurnText(scope: Page | Locator, text: string): Locator {
  return scope
    .getByRole('article', { name: 'You transcript turn', exact: true })
    .getByText(text, { exact: true })
}

/**
 * Pins that a fresh-agent pane renders NONE of the per-turn rewind status
 * text. The transcript's inline rewind note is deliberately removed: rewind
 * state lives only on the hover button (enabled / disabled with its reason
 * title) and in the sheet/menu labels. These pins enumerate the removed
 * block's exact accessible names and rendered strings — verbatim from the
 * deleted FreshAgentTranscript note block (all three of its rendered
 * states: unavailable `role="note"`, pending and available `role="status"`)
 * — so a regression that reintroduces any of them fails loudly instead of
 * passing silently behind hover-only assertions.
 */
export async function expectNoRewindStatusText(paneRoot: Locator): Promise<void> {
  await expect(paneRoot.getByRole('note')).toHaveCount(0)
  await expect(paneRoot.getByRole('status', { name: 'Code rewind available for this message' })).toHaveCount(0)
  await expect(paneRoot.getByRole('status', { name: 'Saving code rewind checkpoint for this message' })).toHaveCount(0)
  await expect(paneRoot.getByText('Code rewind is available for this message.')).toHaveCount(0)
  await expect(paneRoot.getByText('Saving the code state from before this message.')).toHaveCount(0)
  await expect(paneRoot.getByText('Code rewind unavailable for this message:')).toHaveCount(0)
}
