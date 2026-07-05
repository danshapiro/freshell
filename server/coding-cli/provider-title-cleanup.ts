import { parseSessionKey, type SessionCompositeKey } from './types.js'
import type { SessionOverride } from '../config-store.js'

/**
 * Compute the session-override keys whose auto-written title override should be
 * cleared by the one-time provider-title-shadow cleanup migration.
 *
 * A key qualifies when ALL of the following hold:
 * - its provider (parsed from the composite key) is in `authoritativeProviders`
 *   (providers that always generate their own authoritative title), AND
 * - the override carries a `titleOverride`, AND
 * - that override was NOT set by an explicit user rename (`titleSource !== 'user'`).
 *
 * Explicit user renames are always preserved. Only auto-written sources
 * (ai / first-message / dir / legacy) that shadow the provider title are cleared.
 */
export function overrideKeysToClear(
  sessionOverrides: Record<string, SessionOverride>,
  authoritativeProviders: Set<string>,
): string[] {
  const keys: string[] = []
  for (const [key, ov] of Object.entries(sessionOverrides)) {
    const { provider } = parseSessionKey(key as SessionCompositeKey)
    if (!authoritativeProviders.has(provider)) continue
    if (!ov.titleOverride) continue
    if (ov.titleSource === 'user') continue
    keys.push(key)
  }
  return keys
}
