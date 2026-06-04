/**
 * Title-source precedence ladder — the single source of truth shared by the
 * client (Redux reducers, hydration merges, display selectors) and the server
 * (session override store, promotion guard) so naming behaviour can never
 * diverge across the ESM boundary.
 *
 * Precedence (highest wins): user > ai > first-message > legacy > dir > none.
 *
 * - `user`          an explicit user rename. Always wins; never auto-overwritten.
 * - `ai`            a Gemini-generated name (when a key is configured).
 * - `first-message` derived from the first submitted user message (no key).
 * - `legacy`        migration sentinel for pre-existing persisted names; ranks
 *                   above the dir placeholder but below a real user rename so a
 *                   cross-device user rename still wins.
 * - `dir`           the initial working-directory placeholder. NOT finalized —
 *                   any of the above may replace it exactly once.
 */
export type TitleSource = 'user' | 'ai' | 'first-message' | 'legacy' | 'dir'

export const TITLE_SOURCE_RANK: Record<TitleSource, number> = {
  user: 5,
  ai: 4,
  'first-message': 3,
  legacy: 2,
  dir: 1,
}

export function titleSourceRank(source: TitleSource | undefined): number {
  return source ? TITLE_SOURCE_RANK[source] : 0
}

/**
 * A name is "finalized" once it has any source other than the dir placeholder.
 * Finalized names are frozen against all automatic writers; only a user rename
 * may replace them.
 */
export function isFinalizedTitleSource(source: TitleSource | undefined): boolean {
  return !!source && source !== 'dir'
}

/**
 * Whether an incoming name with `incoming` source may overwrite an existing
 * name with `existing` source.
 *
 * - An explicit user rename always wins (including re-renaming a user name).
 * - Otherwise a finalized name can never be auto-overwritten.
 * - Among non-finalized names, a strictly higher-ranked source may upgrade
 *   (e.g. dir -> first-message; absence -> dir).
 */
export function canUpgradeTitle(
  existing: TitleSource | undefined,
  incoming: TitleSource,
): boolean {
  if (incoming === 'user') return true
  if (isFinalizedTitleSource(existing)) return false
  return titleSourceRank(incoming) > titleSourceRank(existing)
}
