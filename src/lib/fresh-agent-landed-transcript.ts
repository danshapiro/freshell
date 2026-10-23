import type { FreshAgentSnapshot, FreshAgentTurn } from '@shared/fresh-agent-contract'
import type { LiveBlock, LiveBlockKind } from '@/store/freshAgentLiveTypes'

/**
 * What a committed snapshot proves the CLI has written to its transcript,
 * in the two forms a live-tail block can be matched by (transcript-live §4.4).
 */
export type LandedTranscript = {
  /**
   * Line uuids on screen: the snapshot's turn ids (a claude turn is keyed by
   * its line uuid) plus the newest line uuids the server lists separately,
   * which include lines that produce no turn of their own.
   */
  lineIds: ReadonlySet<string>
  /**
   * Per API message id, the block kind of each of its lines, in order. The CLI
   * writes one line per content block of a message, in block order (real-CLI
   * fact F2), so the line at position i is block i. `null` marks a line no
   * live block corresponds to.
   */
  messageBlockKinds: Readonly<Record<string, ReadonlyArray<LiveBlockKind | null>>>
}

export function landedTranscript(
  lineIds: Iterable<string>,
  messageBlockKinds: LandedTranscript['messageBlockKinds'] = {},
): LandedTranscript {
  return { lineIds: new Set(lineIds), messageBlockKinds }
}

/** The live block kind a durable turn's line holds, or null when it holds none. */
function blockKindOf(turn: FreshAgentTurn): LiveBlockKind | null {
  switch (turn.items[0]?.kind) {
    case 'text': return 'text'
    case 'thinking': return 'thinking'
    // A subagent's tool line is projected as its delegation.
    case 'tool_use':
    case 'task_delegation': return 'tool_use'
    default: return null
  }
}

export function landedTranscriptOf(snapshot: FreshAgentSnapshot | null): LandedTranscript {
  if (!snapshot) return landedTranscript([])
  const lineIds = new Set<string>()
  const messageBlockKinds: Record<string, Array<LiveBlockKind | null>> = {}
  for (const turn of snapshot.turns) {
    lineIds.add(turn.turnId)
    lineIds.add(turn.id)
    if (turn.role === 'assistant' && turn.messageId) {
      (messageBlockKinds[turn.messageId] ??= []).push(blockKindOf(turn))
    }
  }
  const claude = snapshot.extensions?.claude
  const lineUuids = claude && typeof claude === 'object'
    ? (claude as { transcriptLineUuids?: unknown }).transcriptLineUuids
    : undefined
  if (Array.isArray(lineUuids)) {
    for (const uuid of lineUuids) if (typeof uuid === 'string') lineIds.add(uuid)
  }
  return { lineIds, messageBlockKinds }
}

/**
 * Whether a live block is already on screen in the snapshot. A block whose
 * line uuid this client learned (its assistant frame) is matched by that uuid
 * alone. A block it never learned the uuid of — the snapshot outran the
 * assistant frame, or a reconnect lost it — is matched by its API message id
 * and position, and only when the line there holds the same kind of block.
 */
export function isLiveBlockLanded(block: LiveBlock, landed: LandedTranscript): boolean {
  if (block.uuid !== undefined) return landed.lineIds.has(block.uuid)
  if (block.messageId === null) return false
  return landed.messageBlockKinds[block.messageId]?.[block.index] === block.kind
}
