import type { Locator, Page } from '@playwright/test'

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
