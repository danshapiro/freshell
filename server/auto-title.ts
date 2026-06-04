import { isFinalizedTitleSource } from '../shared/title-source.js'
import { basenameSegment } from '../shared/path-basename.js'
import { extractTitleFromMessage } from '../shared/title-utils.js'
import type { SessionOverride } from './config-store.js'

/**
 * Decide the next automatic title override for an active coding-agent session.
 *
 * Returns the override patch to persist, or null when nothing should change.
 *
 * Rules (mirroring the shared title-source ladder):
 * - A finalized name (user/ai/first-message/legacy) is never touched here.
 * - When AI auto-naming is OFF and a first user message exists, finalize the
 *   name from that message (source 'first-message'). This also upgrades a dir
 *   placeholder.
 * - Otherwise seed the working-directory placeholder (source 'dir') if no
 *   override exists yet. When AI auto-naming is ON we deliberately leave the
 *   dir placeholder in place so the Gemini path can finalize it as 'ai'.
 *
 * The maxLen matches the provider transcript parser (200) so the persisted
 * first-message name equals the parsed title and there is no visible flip.
 */
export function computeAutoTitlePatch(input: {
  cwd?: string
  firstUserMessage?: string
  existing: SessionOverride | undefined
  aiWillAutoName: boolean
}): SessionOverride | null {
  const { cwd, firstUserMessage, existing, aiWillAutoName } = input

  if (isFinalizedTitleSource(existing?.titleSource)) return null

  const first = firstUserMessage?.trim()
  if (first && !aiWillAutoName) {
    const title = extractTitleFromMessage(firstUserMessage as string, 200)
    if (title) return { titleOverride: title, titleSource: 'first-message' }
  }

  if (!existing?.titleOverride && cwd) {
    const segment = basenameSegment(cwd)
    if (segment) return { titleOverride: segment, titleSource: 'dir' }
  }

  return null
}
