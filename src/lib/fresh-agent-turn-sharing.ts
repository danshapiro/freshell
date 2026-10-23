import type { FreshAgentSnapshot, FreshAgentTranscriptItem, FreshAgentTurn } from '@shared/fresh-agent-contract'

/**
 * Structural sharing across snapshot commits (transcript-live plan, risk 1).
 * A claude pane refetches its snapshot after every message the CLI writes,
 * and each read is a fresh parse of the whole transcript: without sharing,
 * every commit hands the transcript new turn and item objects, and every
 * item re-renders (and re-parses its markdown). Keeping the previous object
 * wherever the content is the same lets the memoized item cards skip all of
 * the unchanged history.
 */

/** Deep equality for parsed JSON (plain objects, arrays and primitives). */
function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false
    for (let i = 0; i < a.length; i += 1) if (!jsonEqual(a[i], b[i])) return false
    return true
  }
  if (Array.isArray(b)) return false
  const aRecord = a as Record<string, unknown>
  const bRecord = b as Record<string, unknown>
  const keys = Object.keys(aRecord)
  if (keys.length !== Object.keys(bRecord).length) return false
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(bRecord, key) || !jsonEqual(aRecord[key], bRecord[key])) return false
  }
  return true
}

function shareItems(previous: readonly FreshAgentTranscriptItem[], next: FreshAgentTranscriptItem[]): FreshAgentTranscriptItem[] {
  const previousById = new Map(previous.map((item) => [item.id, item]))
  let reused = false
  const shared = next.map((item) => {
    const before = previousById.get(item.id)
    if (before && jsonEqual(before, item)) {
      reused = true
      return before
    }
    return item
  })
  return reused ? shared : next
}

function shareTurn(previous: FreshAgentTurn | undefined, next: FreshAgentTurn): FreshAgentTurn {
  if (!previous) return next
  if (jsonEqual(previous, next)) return previous
  const items = shareItems(previous.items, next.items)
  return items === next.items ? next : { ...next, items }
}

/**
 * `next` with every turn (matched by id) whose content equals the previous
 * one replaced by that previous object, and, inside a changed turn, every
 * unchanged item likewise. When nothing changed, the previous list itself.
 */
export function shareUnchangedTurns(previous: readonly FreshAgentTurn[], next: FreshAgentTurn[]): FreshAgentTurn[] {
  const previousById = new Map(previous.map((turn) => [turn.id, turn]))
  let allPrevious = next.length === previous.length
  let anyShared = false
  const shared = next.map((turn, index) => {
    const kept = shareTurn(previousById.get(turn.id), turn)
    if (kept !== turn) anyShared = true
    if (kept !== previous[index]) allPrevious = false
    return kept
  })
  if (allPrevious) return previous as FreshAgentTurn[]
  return anyShared ? shared : next
}

/**
 * The snapshot to commit: `next` (whose other fields may have changed)
 * carrying the turns it shares with the snapshot on screen.
 */
export function withSharedTurns(previous: FreshAgentSnapshot | null, next: FreshAgentSnapshot): FreshAgentSnapshot {
  if (!previous || previous === next) return next
  const turns = shareUnchangedTurns(previous.turns, next.turns)
  return turns === next.turns ? next : { ...next, turns }
}
